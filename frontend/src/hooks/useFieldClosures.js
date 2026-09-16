import { useState, useEffect, useCallback } from 'react';
import { z } from 'zod';
import {
  BLACKOUT_DB_REASON,
  CLOSURE_SOURCE,
  NoteSchema,
} from '@squadlogic/core/fieldAdmin/index.js';
import { supabase } from '../lib/supabaseClient.js';
import { useOrganization } from '../contexts/OrganizationContext.jsx';
import { logger } from '../lib/logger.js';

/**
 * Blackout windows: the read, and the two writes.
 *
 * **Reads `public.field_closures`, never either blackout table.** The view is
 * the single reader 20260906000100 created over the admin-authored
 * `field_blackouts` and the import-owned `field_blackout_windows`, precisely so
 * "is this ground closed" has one answer rather than two a caller must remember
 * to union. `useFields` embeds `field_blackout_windows` under availability
 * profiles for the profile review list; that is a different question (what did
 * this profile import say) and is left alone.
 *
 * **Writes only through the RPCs.** `field_blackouts` has a SELECT policy for
 * members and no write policy at all, so a direct insert is refused by RLS.
 * `admin_create_field_blackout`, `admin_update_field_blackout` and
 * `admin_delete_field_blackout` are SECURITY DEFINER, gate on `is_org_admin`,
 * re-check that the scope belongs to the caller's organisation, and audit.
 *
 * **An import-derived closure is neither editable nor deletable, and this hook
 * says so by refusing rather than by hiding the button.**
 * `field_blackout_windows` is FROZEN: no RPC writes or removes a row in it, and
 * writing it directly would be the thing the freeze exists to stop. A caller
 * asking for one gets an error naming the source, which is a better answer than
 * a button that silently does nothing. `admin_update_field_blackout` refuses it
 * server-side too, with its own `0A000` -- the guard here saves a round trip
 * and is not the only thing standing between the freeze and a caller.
 */

/** The date/time half of a blackout, validated before the RPC ever sees it. */
export const BlackoutDraftSchema = z
  .object({
    scope: z.enum(['location', 'field']),
    scopeId: z.string().min(1, { message: 'choose the venue or field this closes' }),
    blackoutFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'a start date is required' }),
    blackoutUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'an end date is required' }),
    allDay: z.boolean(),
    /** Minutes past midnight; null when `allDay`. */
    startMinutes: z.number().int().min(0).max(1440).nullable(),
    endMinutes: z.number().int().min(0).max(1440).nullable(),
    reason: z.enum(/** @type {[string, ...string[]]} */ ([...BLACKOUT_DB_REASON])),
    /**
     * **`NoteSchema`, not a bare string.** The domain layer's note guard bounds
     * the length AND refuses text carrying a shape that can only be identity --
     * CLAUDE.md section 2 puts personal data out of scope, and an
     * admin-writable, organisation-scoped, durable free-text column is exactly
     * where "closed for the Hendricks memorial" lands. A local
     * `z.string().max(200)` here would have been a second, weaker producer of
     * the same verdict; `tests/fieldAdminUi.test.jsx` drives a note through the
     * form to prove the form actually reaches it.
     */
    note: NoteSchema.nullable(),
  })
  .strict()
  .superRefine((draft, ctx) => {
    // Mirrors `field_blackouts_date_check`. Stated here as well as in the
    // database so the operator gets a sentence beside the field rather than a
    // constraint name after a round trip.
    if (draft.blackoutUntil < draft.blackoutFrom) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['blackoutUntil'],
        message: 'the last day must not fall before the first',
      });
    }
    if (draft.allDay) {
      if (draft.startMinutes !== null || draft.endMinutes !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['allDay'],
          message: 'an all-day closure carries no times',
        });
      }
      return;
    }
    // `field_blackouts_time_pairing_check`, then `..._time_range_check`.
    if (draft.startMinutes === null || draft.endMinutes === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['startMinutes'],
        message: 'a timed closure needs both a start and an end',
      });
      return;
    }
    if (draft.endMinutes <= draft.startMinutes) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endMinutes'],
        message: 'the end time must fall after the start time',
      });
    }
  });

/**
 * A `field_closures` row, in the camelCase shape `findBlackoutConflicts()`
 * takes. One mapping, so the view's column names appear once in the frontend.
 *
 * @param {Record<string, any>} row
 */
function toClosure(row) {
  return {
    id: String(row.id),
    source: row.source,
    closesFieldId: row.closes_field_id ? String(row.closes_field_id) : null,
    closesLocationId: row.closes_location_id ? String(row.closes_location_id) : null,
    blackoutFrom: row.blackout_from,
    blackoutUntil: row.blackout_until,
    startMinutes: row.start_minutes ?? null,
    endMinutes: row.end_minutes ?? null,
    reason: row.reason ?? null,
    note: row.note ?? null,
    /** The import's own words, on the import's own arm. Never `note`. */
    sourceReasonText: row.source_reason_text ?? null,
  };
}

export function useFieldClosures() {
  const [closures, setClosures] = useState(/** @type {any[]} */ ([]));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(/** @type {string|null} */ (null));
  const { currentOrganization } = useOrganization();

  const refresh = useCallback(async () => {
    if (!currentOrganization?.id) {
      setClosures([]);
      setLoading(false);
      return;
    }
    try {
      setLoading(true);
      setError(null);
      const { data, error: readError } = await supabase
        .from('field_closures')
        .select('*')
        .eq('organization_id', currentOrganization.id)
        .order('blackout_from');
      if (readError) throw readError;
      setClosures((data || []).map(toClosure));
    } catch (err) {
      logger.error('Error fetching field closures:', err);
      setError(err.message || 'Blackout windows could not be loaded.');
      setClosures([]);
    } finally {
      setLoading(false);
    }
  }, [currentOrganization?.id]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  /**
   * Create one admin-authored blackout.
   *
   * @param {unknown} draft - validated against {@link BlackoutDraftSchema}
   */
  const createBlackout = useCallback(
    async (draft) => {
      if (!currentOrganization?.id) throw new Error('No active organization');
      const parsed = BlackoutDraftSchema.parse(draft);
      const { data, error: rpcError } = await supabase.rpc('admin_create_field_blackout', {
        p_organization_id: currentOrganization.id,
        p_location_id: parsed.scope === 'location' ? parsed.scopeId : null,
        p_field_id: parsed.scope === 'field' ? parsed.scopeId : null,
        p_blackout_from: parsed.blackoutFrom,
        p_blackout_until: parsed.blackoutUntil,
        p_start_minutes: parsed.allDay ? null : parsed.startMinutes,
        p_end_minutes: parsed.allDay ? null : parsed.endMinutes,
        p_reason: parsed.reason,
        p_note: parsed.note,
      });
      if (rpcError) throw rpcError;
      // **A payload we cannot read is an error, not a success.** `useFields`
      // learned this on the delete path, where `{deleted:false}` for an
      // unreadable response made a refusal render as "nothing is booked".
      if (!data || typeof data !== 'object' || !data.id) {
        throw new Error('admin_create_field_blackout returned no readable result');
      }
      await refresh();
      return data;
    },
    [currentOrganization?.id, refresh]
  );

  /**
   * Edit one admin-authored blackout IN PLACE.
   *
   * **The whole editable shape goes every time.** `admin_update_field_blackout`
   * reads NULL as NULL rather than as "leave unchanged", because a partial
   * update cannot express "this is now an all-day closure" or "the note is
   * gone". The same {@link BlackoutDraftSchema} validates it, so an edit and a
   * create are judged by one set of rules rather than two that can drift.
   *
   * **Scope is not sent and cannot be changed.** The RPC has no parameter for
   * it: moving a closure to other ground is a different closure, not an edit of
   * this one. The draft still carries `scope`/`scopeId` because the schema is
   * shared and the editor displays them; they are read here only to refuse an
   * edit that tries to move the window, rather than being quietly dropped.
   *
   * @param {{ id: string, source: string, closesFieldId: string|null, closesLocationId: string|null }} closure
   * @param {unknown} draft - validated against {@link BlackoutDraftSchema}
   */
  const updateBlackout = useCallback(
    async (closure, draft) => {
      if (!currentOrganization?.id) throw new Error('No active organization');
      if (closure?.source !== CLOSURE_SOURCE.ADMIN) {
        throw new Error(
          'This window came from a field-availability import and is not editable here. ' +
            'Roll the import back or re-import to change it.'
        );
      }
      const parsed = BlackoutDraftSchema.parse(draft);
      const currentScopeId =
        parsed.scope === 'field' ? closure.closesFieldId : closure.closesLocationId;
      if (String(parsed.scopeId) !== String(currentScopeId ?? '')) {
        throw new Error(
          'A blackout cannot be moved to different ground. Remove this window and add one on the ' +
            'new ground instead — the closure that was recorded here really did apply here.'
        );
      }
      const { data, error: rpcError } = await supabase.rpc('admin_update_field_blackout', {
        p_organization_id: currentOrganization.id,
        p_blackout_id: closure.id,
        p_blackout_from: parsed.blackoutFrom,
        p_blackout_until: parsed.blackoutUntil,
        p_start_minutes: parsed.allDay ? null : parsed.startMinutes,
        p_end_minutes: parsed.allDay ? null : parsed.endMinutes,
        p_reason: parsed.reason,
        p_note: parsed.note,
      });
      if (rpcError) throw rpcError;
      // A payload we cannot read is an error, not a success -- the same reading
      // `createBlackout` takes, and for the same reason.
      if (!data || typeof data !== 'object' || !data.id) {
        throw new Error('admin_update_field_blackout returned no readable result');
      }
      await refresh();
      return data;
    },
    [currentOrganization?.id, refresh]
  );

  /**
   * Remove one admin-authored blackout.
   *
   * @param {{ id: string, source: string }} closure
   */
  const removeBlackout = useCallback(
    async (closure) => {
      if (!currentOrganization?.id) throw new Error('No active organization');
      if (closure?.source !== CLOSURE_SOURCE.ADMIN) {
        throw new Error(
          'This window came from a field-availability import and is not editable here. ' +
            'Roll the import back or re-import to change it.'
        );
      }
      const { data, error: rpcError } = await supabase.rpc('admin_delete_field_blackout', {
        p_organization_id: currentOrganization.id,
        p_blackout_id: closure.id,
      });
      if (rpcError) throw rpcError;
      if (!data || data.deleted !== true) {
        throw new Error('admin_delete_field_blackout returned no readable result');
      }
      await refresh();
      return data;
    },
    [currentOrganization?.id, refresh]
  );

  return { closures, loading, error, refresh, createBlackout, updateBlackout, removeBlackout };
}
