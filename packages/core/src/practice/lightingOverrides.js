/**
 * `practice_lighting_overrides` rows -> the lighting-override input core
 * already takes (8.9 D14 PR B).
 *
 * The table (`supabase/migrations/20261003000000_practice_lighting_overrides.sql`)
 * stores a window as a canonical `daterange`, `[from, until + 1)`; PR A's
 * {@link PracticeLightingOverrideSchema} takes `{ slotId, from, until }`, both
 * INCLUSIVE. This is the one conversion between them, so the exclusive end is
 * turned back into the inclusive `until` in one place.
 *
 * **Only approved rows exempt (plan W24).** A requested, rejected or withdrawn
 * row is dropped here, whatever the caller selected, so a reader that forgot
 * its `status = 'approved'` filter still cannot exempt a date nobody approved.
 *
 * Nothing in production calls this yet: the Edge read is PR C.
 *
 * @module practice/lightingOverrides
 */

import { isoDateOfDayNumber, isoDayNumber } from '../facility/eligibility.js';
import {
  PRACTICE_LIGHTING_OVERRIDE_STATUS,
  PracticeLightingOverrideRowSchema,
  PracticeLightingOverrideSchema,
} from './schemas.js';

/**
 * @param {ReadonlyArray<unknown>} rows - `practice_lighting_overrides` rows
 * @returns {Array<{ slotId: string, from: string, until: string }>} the
 *   approved rows as `lightingOverrides` input, each parsed by
 *   {@link PracticeLightingOverrideSchema}
 */
export function approvedLightingOverridesFromRows(rows) {
  if (!Array.isArray(rows)) {
    throw new TypeError('approvedLightingOverridesFromRows requires an array of rows');
  }
  return rows
    .map((row) => PracticeLightingOverrideRowSchema.parse(row))
    .filter((row) => row.status === PRACTICE_LIGHTING_OVERRIDE_STATUS.APPROVED)
    .map((row) => {
      const [from, end] = row.window.slice(1, -1).split(',');
      return PracticeLightingOverrideSchema.parse({
        slotId: row.practice_slot_id,
        from,
        until: isoDateOfDayNumber(isoDayNumber(end) - 1),
      });
    });
}
