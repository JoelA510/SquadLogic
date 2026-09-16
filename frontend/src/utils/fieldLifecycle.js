import { isLiveOn } from '@squadlogic/core/facility/index.js';

/**
 * Is this `fields` row ground the scheduler may still offer on `asOf`?
 *
 * **Both halves, and neither is redundant.**
 *
 *   * `active === true` is the pre-dating meaning, "not deactivated". The
 *     column is `boolean DEFAULT true` and **nullable**, so `active !== false`
 *     would admit a row the server-side `.eq('active', true)` this replaced
 *     excluded — a filter CHANGE smuggled in under a filter MOVE.
 *   * `isLiveOn` is the effective window, and it is the half that makes a
 *     retirement mean anything. `fields.active` is a WRITE-TIME CACHE of
 *     `effective_to`: 20260906000000's trigger fires on write and reads
 *     `current_date`, so a field retired with a FUTURE date keeps
 *     `active = true` until something writes the row again, and on the day the
 *     retirement takes effect the column is stale. The migration header names
 *     repointing the scheduler's read as 8.4 PR 3's work; this is it.
 *
 * `isLiveOn` is `packages/core`'s single reading of an effective window and is
 * the same answer `public.field_is_live_on(effective_to, d)` gives in SQL
 * (`effective_to >= d`, inclusive), so the client and the guard agree on which
 * day is the last usable one.
 *
 * @param {{ active?: boolean|null, effective_to?: string|null }} row
 * @param {string} asOf - `YYYY-MM-DD`
 * @returns {boolean}
 */
export function isFieldOfferableOn(row, asOf) {
  if (row?.active !== true) return false;
  return isLiveOn({ effectiveFrom: null, effectiveTo: row.effective_to ?? null }, asOf);
}
