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
 * The Edge read (PR C) runs its Deno twin,
 * `_shared/engines/practice-lighting-overrides.ts`, which
 * `tests/lightingOverrideDrift.test.js` holds to this function (W27). The UI
 * (PR D, `frontend/src/utils/lightingOverrides.js`) reads and writes windows
 * through {@link lightingOverrideWindowDates} and {@link lightingOverrideWindowOf}.
 *
 * @module practice/lightingOverrides
 */

import { isoDateOfDayNumber, isoDayNumber } from '../facility/eligibility.js';
import {
  PRACTICE_LIGHTING_OVERRIDE_STATUS,
  PracticeLightingOverrideRowSchema,
  PracticeLightingOverrideSchema,
} from './schemas.js';

const CANONICAL_WINDOW = /^\[(\d{4}-\d{2}-\d{2}),(\d{4}-\d{2}-\d{2})\)$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A stored window, `[from,end)` with the end EXCLUSIVE, as its INCLUSIVE
 * dates. The one conversion: {@link approvedLightingOverridesFromRows} and the
 * UI both call it.
 *
 * @param {unknown} window
 * @returns {{ from: string, until: string } | null} null for anything but a
 *   canonical bounded range, so a caller refuses it rather than guessing
 */
export function lightingOverrideWindowDates(window) {
  const match = typeof window === 'string' ? CANONICAL_WINDOW.exec(window) : null;
  if (!match) return null;
  return { from: match[1], until: isoDateOfDayNumber(isoDayNumber(match[2]) - 1) };
}

/**
 * Inclusive dates -> the window the RPCs store, `daterange(from, until, '[]')`,
 * which Postgres prints canonically as `[from,until + 1)`.
 *
 * @param {string} from
 * @param {string} until
 * @returns {string | null} null unless both are `YYYY-MM-DD`
 */
export function lightingOverrideWindowOf(from, until) {
  if (!ISO_DATE.test(String(from)) || !ISO_DATE.test(String(until))) return null;
  return `[${from},${isoDateOfDayNumber(isoDayNumber(until) + 1)})`;
}

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
      const { from, until } = lightingOverrideWindowDates(row.window);
      return PracticeLightingOverrideSchema.parse({ slotId: row.practice_slot_id, from, until });
    });
}
