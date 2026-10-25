import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import {
  PracticeLightingOverrideRowSchema,
  PracticeLightingOverrideSchema,
} from '@squadlogic/core/practice/schemas.js';
import { supabase } from '../lib/supabaseClient.js';
import { fetchAllPages } from '../lib/pagedFetch.js';
import { logger } from '../lib/logger.js';
import { datesOfWindow, practiceSlotLabels } from '../utils/lightingOverrides.js';

/**
 * Portable-lighting overrides (8.9 D14 PR D): reads under RLS, writes through
 * the admin definer RPCs of migration `20261003000000` only. Lighting is
 * admin-only since `20261028010000` (admin focus R6, owner decision 4): no
 * coach requests, so there is no request call here.
 *
 * Copies `useCoachPracticePreferences`: every write validates its input with a
 * Zod schema first (the core `PracticeLightingOverrideSchema` for a window), so
 * an inverted window is refused here with the schema's message, and every RPC
 * error is thrown with the database's own message and code for the caller to
 * surface.
 */

/** Only the columns a view reads: nothing here shows who decided or withdrew. */
export const OVERRIDE_COLUMNS =
  'id, practice_slot_id, window, kind, status, requested_by, requested_at';

/** An `Error` carrying the PostgREST/Postgres code (23P01 is the overlap refusal). */
export class LightingOverrideRpcError extends Error {
  /** @param {{ message?: string, code?: string }} error */
  constructor(error) {
    super(error?.message || 'The request failed');
    this.name = 'LightingOverrideRpcError';
    this.code = error?.code ?? null;
  }
}

const DecisionSchema = z
  .object({
    id: z.string().min(1, 'an override id is required'),
    decision: z.enum(['approve', 'reject']),
  })
  .strict();
const WithdrawalSchema = z.object({ id: z.string().min(1, 'an override id is required') }).strict();

function validate(schema, input) {
  const parsed = schema.safeParse(input);
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

/** An admin writes an approved window directly. */
export async function setLightingOverride({ slotId, from, until }) {
  const window = validate(PracticeLightingOverrideSchema, { slotId, from, until });
  return callRpc('admin_set_practice_lighting_override', {
    p_practice_slot_id: window.slotId,
    p_from: window.from,
    p_until: window.until,
  });
}

/** An admin other than the requester approves or rejects a requested row (one stored before R6). */
export async function decideLightingOverride({ id, decision }) {
  const input = validate(DecisionSchema, { id, decision });
  return callRpc('admin_decide_practice_lighting_override', {
    p_override_id: input.id,
    p_decision: input.decision,
  });
}

/** An admin withdraws a requested or approved row. */
export async function withdrawLightingOverride({ id }) {
  const input = validate(WithdrawalSchema, { id });
  return callRpc('withdraw_practice_lighting_override', { p_override_id: input.id });
}

/**
 * Parse every row: a row the core schema refuses is a read that did not come
 * from the table, and is reported as a load error rather than dropped.
 */
function parseRows(data) {
  return data.map((row, index) => {
    const parsed = PracticeLightingOverrideRowSchema.safeParse(row);
    const dates = parsed.success ? datesOfWindow(row.window) : null;
    // An empty range (`[d,d)`) holds no date: Postgres never stores one.
    if (!parsed.success || !dates || dates.until < dates.from) {
      throw new LightingOverrideRpcError({
        code: 'MALFORMED_ROW',
        message: `practice_lighting_overrides row ${index} (${row?.id ?? 'no id'}) is not a stored override`,
      });
    }
    return { ...row, from: dates.from, until: dates.until };
  });
}

/**
 * Load the organization's override rows (an admin's view; RLS would narrow a
 * coach's to the slots they coach).
 *
 * `loaded` is true only once rows for THIS `orgId` have arrived, and stays true
 * through a later refresh, so a view renders its lists on `!error && loaded`:
 * never an empty list before the first read lands (which would read as "no
 * overrides"), and never unmounting a half-filled form on every refresh. Any
 * failure sets `error` and empties `rows`.
 *
 * @param {string | null | undefined} orgId
 */
export function usePracticeLightingOverrides(orgId, { enabled = true } = {}) {
  const [state, setState] = useState(
    /** @type {{ rows: any[], loadedFor: string | null, error: any }} */ ({
      rows: [],
      loadedFor: null,
      error: null,
    })
  );
  const [loading, setLoading] = useState(false);
  const requestRef = useRef(0);

  const refresh = useCallback(async () => {
    // Bumped even when disabled, so a read still in flight from before an org
    // switch can never land; `loaded` below hides whatever state is left.
    const requestId = ++requestRef.current;
    if (!orgId || !enabled) return;
    setLoading(true);
    try {
      const data = await fetchAllPages(() =>
        supabase
          .from('practice_lighting_overrides')
          .select(OVERRIDE_COLUMNS)
          .eq('organization_id', orgId)
      );
      if (requestRef.current !== requestId) return;
      const rows = parseRows(data).sort((a, b) =>
        String(b.requested_at).localeCompare(String(a.requested_at))
      );
      setState({ rows, loadedFor: orgId, error: null });
    } catch (err) {
      if (requestRef.current !== requestId) return;
      logger.error('Failed to load practice lighting overrides', err);
      setState({
        rows: [],
        loadedFor: null,
        error: err || { message: 'Failed to load practice lighting overrides' },
      });
    } finally {
      if (requestRef.current === requestId) setLoading(false);
    }
  }, [orgId, enabled]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const loaded = Boolean(orgId) && enabled && state.loadedFor === orgId;
  const active = Boolean(orgId) && enabled;
  return {
    rows: loaded ? state.rows : [],
    /** A read is in flight; the views mark their lists `aria-busy` with it. */
    loading: active && loading,
    loaded,
    error: active ? state.error : null,
    refresh,
  };
}

/**
 * @type {Readonly<{ forOrg: string | null, slots: any[], slotLabels: Map<string, string>,
 *   coaches: any[], error: any, loading: boolean }>}
 */
const LOADING_CONTEXT = Object.freeze({
  forOrg: null,
  slots: [],
  slotLabels: new Map(),
  coaches: [],
  error: null,
  loading: true,
});

/**
 * The slots the admin view offers, their field names, and the organization's
 * coaches (to name a requester).
 *
 * Until the load for the CURRENT org lands, the loading context is returned,
 * so a switch never shows the previous one's.
 *
 * @param {string | null | undefined} orgId
 */
export function useLightingSlotContext(orgId) {
  const [state, setState] = useState(LOADING_CONTEXT);

  const key = String(orgId);

  useEffect(() => {
    if (!orgId) return undefined;
    let cancelled = false;
    (async () => {
      setState(LOADING_CONTEXT);
      try {
        const [slots, fields, subunits, coaches] = await Promise.all([
          fetchAllPages(() =>
            supabase
              .from('practice_slots')
              .select(
                'id, organization_id, day_of_week, start_time, end_time, field_id, field_subunit_id, label'
              )
              .eq('organization_id', orgId)
          ),
          fetchAllPages(() =>
            supabase.from('fields').select('id, name').eq('organization_id', orgId)
          ),
          fetchAllPages(() =>
            supabase.from('field_subunits').select('id, label').eq('organization_id', orgId)
          ),
          fetchAllPages(() =>
            supabase
              .from('coaches')
              .select('id, organization_id, full_name, user_id')
              .eq('organization_id', orgId)
          ),
        ]);
        if (cancelled) return;
        setState({
          forOrg: key,
          slots,
          slotLabels: practiceSlotLabels(
            slots,
            new Map(fields.map((field) => [String(field.id), field.name])),
            new Map(subunits.map((subunit) => [String(subunit.id), subunit.label]))
          ),
          coaches,
          error: null,
          loading: false,
        });
      } catch (err) {
        if (cancelled) return;
        logger.error('Failed to load practice slots for lighting overrides', err);
        setState({
          ...LOADING_CONTEXT,
          forOrg: key,
          error: err || { message: 'unknown error' },
          loading: false,
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [orgId, key]);

  return state.forOrg === key ? state : LOADING_CONTEXT;
}
