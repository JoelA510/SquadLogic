import { useCallback, useEffect, useRef, useState } from 'react';
import { CoachPreferenceRuleSchema } from '@squadlogic/core/practice/coachPreferences.js';
import { supabase } from '../lib/supabaseClient.js';
import { fetchAllPages } from '../lib/pagedFetch.js';
import { logger } from '../lib/logger.js';

/**
 * Practice preference rules: reads under RLS, writes through the admin RPCs of migration
 * `20261112010000` only (Phase D C1; originally Phase 8.6 PR 3b, PR 2).
 *
 * The table is read with `.from('coach_practice_preferences')`; RLS lets an admin read the
 * organization's rows (no coach signs in). A row is one rule for one team. Every write validates its
 * payload with the core `CoachPreferenceRuleSchema` first, so a malformed rule is refused here with
 * the schema's message instead of reaching the RPC, and every RPC error is thrown with the
 * database's own message and code for the caller to surface.
 */

export const PREFERENCE_COLUMNS =
  'id, organization_id, coach_id, team_id, level, requested_level, must_decision, status, source, import_job_id, weekdays, start_minutes, venue_ids, keep_weekday, keep_start, keep_venue, coach_priority, effective_from, effective_to, created_at, decided_at';

/**
 * An `Error` carrying the PostgREST/Postgres code, so a caller can tell a
 * missing migration from a refusal.
 */
export class PreferenceRpcError extends Error {
  /** @param {{ message?: string, code?: string, details?: string }} error */
  constructor(error) {
    super(error?.message || 'The request failed');
    this.name = 'PreferenceRpcError';
    this.code = error?.code ?? null;
    // Postgres's DETAIL (`expected_count_mismatch`, `season_completed`, `not_pending`...): what a
    // caller branches on, since the message is for a person.
    this.details = error?.details ?? null;
  }
}

/** Validate one rule with the core schema; throws with the schema's message. */
function validateRule(rule) {
  const parsed = CoachPreferenceRuleSchema.safeParse(rule);
  if (!parsed.success) {
    throw new PreferenceRpcError({
      code: 'VALIDATION',
      message: parsed.error.issues.map((issue) => issue.message).join('; '),
    });
  }
  return parsed.data;
}

async function callRpc(name, args) {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw new PreferenceRpcError(error);
  return data;
}

/**
 * An admin's decision on a requested must: accept it (the rule is a must from now on) or keep it
 * as prefer.
 *
 * @param {{ row: any, decision: 'accept' | 'keep_prefer' }} input
 */
export async function decideMustPreference({ row, decision }) {
  return callRpc('admin_decide_must_preference', { p_preference_id: row.id, p_decision: decision });
}

/**
 * An admin adds a rule for one of a coach's teams. This screen sends one value (or keep-current)
 * for one condition; the RPC takes several (Phase D C2).
 *
 * @param {{ coachId: string, teamId: string, level: 'prefer' | 'must', weekdays?: string[] | null,
 *   startMinutes?: number[] | null, venueIds?: string[] | null, keepWeekday?: boolean,
 *   keepStart?: boolean, keepVenue?: boolean }} input
 */
export async function addPracticePreference(input) {
  const rule = validateRule({ id: 'new', ...input });
  return callRpc('admin_add_practice_preference', {
    p_coach_id: rule.coachId,
    p_team_id: rule.teamId,
    p_level: rule.level,
    p_weekdays: rule.weekdays,
    p_start_minutes: rule.startMinutes,
    p_venue_ids: rule.venueIds,
    p_keep_weekday: rule.keepWeekday,
    p_keep_start: rule.keepStart,
    p_keep_venue: rule.keepVenue,
    p_coach_priority: rule.coachPriority,
    p_effective_from: rule.effectiveFrom,
    p_effective_to: rule.effectiveTo,
  });
}

/**
 * An admin replaces an in-force rule's conditions, level, priority and window (the coach and the team
 * stay). The RPC takes the whole rule, so every field is sent. Saving a rule that was requested as a
 * must at `prefer` keeps it as prefer, and saving it at `must` accepts it: the RPC decides the
 * request by the level it is given (migration 20261112010000).
 *
 * @param {any} row - the rule row being edited
 * @param {{ level: 'prefer' | 'must', weekdays?: string[] | null, startMinutes?: number[] | null,
 *   venueIds?: string[] | null, keepWeekday?: boolean, keepStart?: boolean, keepVenue?: boolean,
 *   coachPriority?: 'high' | 'medium' | 'low' | null, effectiveFrom?: string | null,
 *   effectiveTo?: string | null }} input
 */
export async function editPracticePreference(row, input) {
  const rule = validateRule({
    id: String(row.id),
    coachId: String(row.coach_id),
    teamId: String(row.team_id),
    ...input,
  });
  return callRpc('admin_edit_practice_preference', {
    p_preference_id: row.id,
    p_level: rule.level,
    p_weekdays: rule.weekdays,
    p_start_minutes: rule.startMinutes,
    p_venue_ids: rule.venueIds,
    p_keep_weekday: rule.keepWeekday,
    p_keep_start: rule.keepStart,
    p_keep_venue: rule.keepVenue,
    p_coach_priority: rule.coachPriority,
    p_effective_from: rule.effectiveFrom,
    p_effective_to: rule.effectiveTo,
  });
}

/** An admin removes a rule in force (the row stays as history). */
export async function removePracticePreference(row) {
  return callRpc('admin_remove_practice_preference', { p_preference_id: row.id });
}

/**
 * Accept every pending must of one import file. `expectedCount` is the number the admin was shown:
 * the RPC refuses (22023, DETAIL `expected_count_mismatch`) when the file's pending musts are not
 * that many, and accepts nothing, so the confirmation can never accept more than it named.
 *
 * @param {{ importJobId: string, expectedCount: number }} input
 * @returns {Promise<{ accepted: number, import_job_id: string }>}
 */
export async function acceptAllMusts({ importJobId, expectedCount }) {
  if (!importJobId || !Number.isInteger(expectedCount) || expectedCount < 0) {
    throw new PreferenceRpcError({
      code: 'VALIDATION',
      message: 'Accept all needs the import file and the number of musts it was shown',
    });
  }
  return callRpc('admin_accept_all_musts', {
    p_import_job_id: importJobId,
    p_expected_count: expectedCount,
  });
}

/**
 * True when Accept all was refused because the file's pending musts changed after the admin saw
 * them (another tab accepted or kept one, or a re-import replaced them).
 * @param {unknown} error
 */
export function isExpectedCountMismatch(error) {
  const e = /** @type {any} */ (error);
  // The DETAIL is the contract; the phrase is the message's own, for a transport that drops DETAIL.
  return (
    e?.details === 'expected_count_mismatch' || /the confirmation showed/.test(e?.message ?? '')
  );
}

/**
 * Load rule rows for an organization, optionally one coach's.
 *
 * `error` is the raw PostgREST error (with its `code`), so the page can tell a
 * missing migration from anything else. Rows are newest first.
 *
 * @param {string | null | undefined} orgId
 * @param {{ coachId?: string | null, enabled?: boolean }} [options]
 */
export function useCoachPracticePreferences(orgId, { coachId = null, enabled = true } = {}) {
  const [rows, setRows] = useState(/** @type {any[]} */ ([]));
  const [loading, setLoading] = useState(false);
  // True once a read has finished (rows or an error), so a screen can tell the first load from a
  // refresh: a refresh must not take the screen down, or what a panel holds (an import's result)
  // goes with it.
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(/** @type {any} */ (null));
  const requestRef = useRef(0);

  const refresh = useCallback(async () => {
    if (!orgId || !enabled) {
      setRows([]);
      setError(null);
      return;
    }
    const requestId = ++requestRef.current;
    setLoading(true);
    setError(null);
    try {
      const data = await fetchAllPages(() => {
        let query = supabase
          .from('coach_practice_preferences')
          .select(PREFERENCE_COLUMNS)
          .eq('organization_id', orgId);
        if (coachId) query = query.eq('coach_id', coachId);
        return query;
      });
      if (requestRef.current !== requestId) return;
      setRows([...data].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))));
    } catch (err) {
      if (requestRef.current !== requestId) return;
      logger.error('Failed to load practice preference rules', err);
      setRows([]);
      setError(err || { message: 'Failed to load practice preference rules' });
    } finally {
      if (requestRef.current === requestId) {
        setLoading(false);
        setLoaded(true);
      }
    }
  }, [orgId, coachId, enabled]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { rows, loading, loaded, error, refresh };
}
