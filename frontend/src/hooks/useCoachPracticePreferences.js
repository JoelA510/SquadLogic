import { useCallback, useEffect, useRef, useState } from 'react';
import { CoachPreferenceSchema } from '@squadlogic/core/practice/coachPreferences.js';
import { supabase } from '../lib/supabaseClient.js';
import { fetchAllPages } from '../lib/pagedFetch.js';
import { logger } from '../lib/logger.js';

/**
 * Coach practice preferences: reads under RLS, writes through the three
 * definer RPCs of migration `20260927000000` only (Phase 8.6 PR 3b, PR 2).
 *
 * The table is read with `.from('coach_practice_preferences')`; RLS lets an
 * admin read the organization's rows and a coach read their own
 * (`coaches.user_id = auth.uid()`). Every write validates its payload with the
 * core `CoachPreferenceSchema` first, so a malformed value is refused here with
 * the schema's message instead of reaching the RPC, and every RPC error is
 * thrown with the database's own message and code for the caller to surface.
 */

export const PREFERENCE_COLUMNS =
  'id, organization_id, coach_id, dimension, level, value, status, requested_at, decided_at, effective_from, effective_to';

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

/** Validate one preference with the core schema; throws with the schema's message. */
function validatePreference(preference) {
  const parsed = CoachPreferenceSchema.safeParse(preference);
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

/** A coach (for themself) or an admin requests a preference. Never in force until decided. */
export async function requestCoachPreference({ coachId, dimension, level, value }) {
  const preference = validatePreference({ coachId, dimension, level, value });
  return callRpc('request_coach_practice_preference', {
    p_coach_id: preference.coachId,
    p_dimension: preference.dimension,
    p_level: preference.level,
    p_value: preference.value,
  });
}

/**
 * Admin decision on a requested row. `change`, when given, approves with a
 * changed level and value; both are always sent so what the admin saw is what
 * is written.
 *
 * @param {{ row: any, decision: 'approve' | 'reject', change?: { level: string, value: unknown } | null }} input
 */
export async function decideCoachPreference({ row, decision, change = null }) {
  if (decision === 'reject') {
    return callRpc('admin_decide_coach_practice_preference', {
      p_preference_id: row.id,
      p_decision: 'reject',
    });
  }
  if (!change) {
    validatePreference({
      coachId: String(row.coach_id),
      dimension: row.dimension,
      level: row.level,
      value: row.value ?? null,
    });
    return callRpc('admin_decide_coach_practice_preference', {
      p_preference_id: row.id,
      p_decision: 'approve',
    });
  }
  const preference = validatePreference({
    coachId: String(row.coach_id),
    dimension: row.dimension,
    level: change.level,
    value: change.value ?? null,
  });
  if (
    preference.value === null &&
    row.value !== null &&
    row.value !== undefined &&
    preference.level !== 'dont_care'
  ) {
    // The RPC clears the value only for a JSON `null`, but supabase-js sends
    // `null` as SQL NULL, which the RPC reads as "keep the requested value".
    // A kept or preferred "current series" therefore cannot be approved over
    // a requested value; refused here rather than approving the old value
    // behind the admin's back. `dont_care` is exempt: it holds nothing, so the
    // stored value it keeps is inert (the resolver skips `dont_care`).
    throw new PreferenceRpcError({
      code: 'VALIDATION',
      message:
        'A decision cannot clear the requested value. Reject the request and set the preference directly instead.',
    });
  }
  return callRpc('admin_decide_coach_practice_preference', {
    p_preference_id: row.id,
    p_decision: 'approve',
    p_level: preference.level,
    p_value: preference.value,
  });
}

/** Admin writes a coach's preference directly as approved, superseding the prior one. */
export async function setCoachPreference({ coachId, dimension, level, value }) {
  const preference = validatePreference({ coachId, dimension, level, value });
  return callRpc('admin_set_coach_practice_preference', {
    p_coach_id: preference.coachId,
    p_dimension: preference.dimension,
    p_level: preference.level,
    p_value: preference.value,
  });
}

/**
 * Load preference rows for an organization, optionally one coach's.
 *
 * `error` is the raw PostgREST error (with its `code`), so the page can tell a
 * missing migration from anything else. Rows are newest request first.
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
      setRows(
        [...data].sort((a, b) => String(b.requested_at).localeCompare(String(a.requested_at)))
      );
    } catch (err) {
      if (requestRef.current !== requestId) return;
      logger.error('Failed to load coach practice preferences', err);
      setRows([]);
      setError(err || { message: 'Failed to load coach practice preferences' });
    } finally {
      if (requestRef.current === requestId) setLoading(false);
    }
  }, [orgId, coachId, enabled]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { rows, loading, error, refresh };
}
