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
  /** @param {{ message?: string, code?: string }} error */
  constructor(error) {
    super(error?.message || 'The request failed');
    this.name = 'PreferenceRpcError';
    this.code = error?.code ?? null;
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

/** An admin removes a rule in force (the row stays as history). */
export async function removePracticePreference(row) {
  return callRpc('admin_remove_practice_preference', { p_preference_id: row.id });
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
      if (requestRef.current === requestId) setLoading(false);
    }
  }, [orgId, coachId, enabled]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { rows, loading, error, refresh };
}
