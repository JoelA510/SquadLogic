import { useCallback, useEffect, useRef, useState } from 'react';
import {
  PracticeLightingOverrideRowSchema,
  PracticeLightingOverrideSchema,
} from '@squadlogic/core/practice/schemas.js';
import { supabase } from '../lib/supabaseClient.js';
import { fetchAllPages } from '../lib/pagedFetch.js';
import { logger } from '../lib/logger.js';
import { todayIso } from '../utils/today.js';
import { coachedPracticeSlotIds, datesOfWindow } from '../utils/lightingOverrides.js';

/**
 * Portable-lighting overrides (8.9 D14 PR D): reads under RLS, writes through
 * the four definer RPCs of migration `20261003000000` only.
 *
 * Copies `useCoachPracticePreferences`: every write validates its input with
 * the core `PracticeLightingOverrideSchema` first, so an inverted window is
 * refused here with the schema's message, and every RPC error is thrown with
 * the database's own message and code for the caller to surface.
 */

export const OVERRIDE_COLUMNS =
  'id, organization_id, practice_slot_id, window, kind, status, requested_by, requested_at, decided_by, decided_at, withdrawn_by, withdrawn_at';

/** An `Error` carrying the PostgREST/Postgres code (23P01 is the overlap refusal). */
export class LightingOverrideRpcError extends Error {
  /** @param {{ message?: string, code?: string }} error */
  constructor(error) {
    super(error?.message || 'The request failed');
    this.name = 'LightingOverrideRpcError';
    this.code = error?.code ?? null;
  }
}

function validateWindow({ slotId, from, until }) {
  const parsed = PracticeLightingOverrideSchema.safeParse({ slotId, from, until });
  if (!parsed.success) {
    throw new LightingOverrideRpcError({
      code: 'VALIDATION',
      message: parsed.error.issues.map((issue) => issue.message).join('; '),
    });
  }
  return parsed.data;
}

async function callRpc(name, args) {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw new LightingOverrideRpcError(error);
  return data;
}

/** A coach of the slot (or an admin) requests a window. Never in force until decided. */
export async function requestLightingOverride({ slotId, from, until }) {
  const window = validateWindow({ slotId, from, until });
  return callRpc('request_practice_lighting_override', {
    p_practice_slot_id: window.slotId,
    p_from: window.from,
    p_until: window.until,
  });
}

/** An admin writes an approved window directly. */
export async function setLightingOverride({ slotId, from, until }) {
  const window = validateWindow({ slotId, from, until });
  return callRpc('admin_set_practice_lighting_override', {
    p_practice_slot_id: window.slotId,
    p_from: window.from,
    p_until: window.until,
  });
}

/** An admin other than the requester approves or rejects a requested row. */
export async function decideLightingOverride({ id, decision }) {
  if (decision !== 'approve' && decision !== 'reject') {
    throw new LightingOverrideRpcError({
      code: 'VALIDATION',
      message: `A decision is approve or reject, not ${decision}`,
    });
  }
  return callRpc('admin_decide_practice_lighting_override', {
    p_override_id: id,
    p_decision: decision,
  });
}

/** The requester (while they coach the slot) or an admin withdraws a requested or approved row. */
export async function withdrawLightingOverride({ id }) {
  return callRpc('withdraw_practice_lighting_override', { p_override_id: id });
}

/**
 * Parse every row: a row the core schema refuses is a read that did not come
 * from the table, and is reported as a load error rather than dropped.
 */
function parseRows(data) {
  return data.map((row, index) => {
    const parsed = PracticeLightingOverrideRowSchema.safeParse(row);
    const dates = parsed.success ? datesOfWindow(row.window) : null;
    if (!parsed.success || !dates) {
      throw new LightingOverrideRpcError({
        code: 'MALFORMED_ROW',
        message: `practice_lighting_overrides row ${index} (${row?.id ?? 'no id'}) is not a stored override`,
      });
    }
    return { ...row, from: dates.from, until: dates.until };
  });
}

/**
 * Load the organization's override rows (RLS narrows a coach's to the slots
 * they coach). `error` is set, and `rows` emptied, on any failure: the view
 * shows the error, never an empty list that reads as "no overrides".
 *
 * @param {string | null | undefined} orgId
 */
export function usePracticeLightingOverrides(orgId, { enabled = true } = {}) {
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
      const data = await fetchAllPages(() =>
        supabase
          .from('practice_lighting_overrides')
          .select(OVERRIDE_COLUMNS)
          .eq('organization_id', orgId)
      );
      if (requestRef.current !== requestId) return;
      setRows(
        parseRows(data).sort((a, b) => String(b.requested_at).localeCompare(String(a.requested_at)))
      );
    } catch (err) {
      if (requestRef.current !== requestId) return;
      logger.error('Failed to load practice lighting overrides', err);
      setRows([]);
      setError(err || { message: 'Failed to load practice lighting overrides' });
    } finally {
      if (requestRef.current === requestId) setLoading(false);
    }
  }, [orgId, enabled]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { rows, loading, error, refresh };
}

/** @type {Readonly<{ slots: any[], fieldNames: Map<string, string>, coaches: any[], coachedSlotIds: Set<string>, error: any, loading: boolean }>} */
const LOADING_CONTEXT = Object.freeze({
  slots: [],
  fieldNames: new Map(),
  coaches: [],
  coachedSlotIds: new Set(),
  error: null,
  loading: true,
});

/**
 * The slots a view offers, their field names, the org's coaches (for requester
 * names), and -- for a coach -- the slots they coach, enumerated from the
 * roster tables the way `caller_coaches_practice_slot` does.
 *
 * @param {string | null | undefined} orgId
 * @param {{ userId?: string | null, coachScoped?: boolean }} options
 */
export function useLightingSlotContext(orgId, { userId = null, coachScoped = false } = {}) {
  const [state, setState] = useState(LOADING_CONTEXT);

  useEffect(() => {
    if (!orgId) return undefined;
    let cancelled = false;
    (async () => {
      setState(LOADING_CONTEXT);
      try {
        const coachQuery = () => {
          let query = supabase
            .from('coaches')
            .select('id, organization_id, full_name, user_id')
            .eq('organization_id', orgId);
          if (coachScoped) query = query.eq('user_id', userId ?? '');
          return query;
        };
        const [slots, fields, coaches, rosterRows, assignments] = await Promise.all([
          fetchAllPages(() =>
            supabase
              .from('practice_slots')
              .select('id, organization_id, day_of_week, start_time, end_time, field_id')
              .eq('organization_id', orgId)
          ),
          fetchAllPages(() =>
            supabase.from('fields').select('id, name').eq('organization_id', orgId)
          ),
          fetchAllPages(coachQuery),
          coachScoped
            ? fetchAllPages(() =>
                supabase
                  .from('team_coach_assignments')
                  .select('id, organization_id, team_id, coach_id, effective_from, effective_to')
                  .eq('organization_id', orgId)
              )
            : Promise.resolve([]),
          coachScoped
            ? fetchAllPages(() =>
                supabase
                  .from('practice_assignments')
                  .select('id, organization_id, team_id, slot_id, practice_slot_id')
                  .eq('organization_id', orgId)
              )
            : Promise.resolve([]),
        ]);
        if (cancelled) return;
        setState({
          slots,
          fieldNames: new Map(fields.map((field) => [String(field.id), field.name])),
          coaches,
          coachedSlotIds: coachScoped
            ? coachedPracticeSlotIds({
                userId,
                orgId,
                today: todayIso(),
                coaches,
                teamCoachAssignments: rosterRows,
                practiceAssignments: assignments,
                practiceSlots: slots,
              })
            : new Set(),
          error: null,
          loading: false,
        });
      } catch (err) {
        if (cancelled) return;
        logger.error('Failed to load practice slots for lighting overrides', err);
        setState({
          ...LOADING_CONTEXT,
          error: err || { message: 'unknown error' },
          loading: false,
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [orgId, userId, coachScoped]);

  return state;
}
