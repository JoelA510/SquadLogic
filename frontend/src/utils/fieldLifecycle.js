import { isLiveOn } from '@squadlogic/core/facility/index.js';

/**
 * Is this `fields` row ground the scheduler may still offer on `asOf`?
 *
 * **Three halves, and none is redundant.**
 *
 *   * `active === true` is the pre-dating meaning, "not deactivated". The
 *     column is `boolean DEFAULT true` and **nullable**, so `active !== false`
 *     would admit a row the server-side `.eq('active', true)` this replaced
 *     excluded — a filter CHANGE smuggled in under a filter MOVE.
 *   * `isLiveOn` on the field's own window is the half that makes a retirement
 *     mean anything. `fields.active` is a WRITE-TIME CACHE of `effective_to`:
 *     20260906000000's trigger fires on write and reads `current_date`, so a
 *     field retired with a FUTURE date keeps `active = true` until something
 *     writes the row again, and on the day the retirement takes effect the
 *     column is stale.
 *   * **`isLiveOn` on the VENUE's window, added with 20260911000000.** A venue
 *     retirement writes one date on one row and copies nothing down: the
 *     argument is in section 2 of that migration's header, and the short form
 *     is that a copied date cannot be undone by an unretire without discarding
 *     a decision the unretire never made. So a pitch at a closed site is
 *     retired by CONTAINMENT, resolved here — and if this half is not read,
 *     the retirement is a row in a table that changes nothing, which is
 *     "declared is not enforced" with a date on it.
 *
 * This is the contract `packages/core/src/facility/lifecycle.js`
 * `surfaceIsLiveOn()` already ships for the facility graph — self plus the
 * venue — adopted rather than reinvented.
 *
 * **`venue` is REQUIRED, and `undefined` throws.** A third argument that
 * defaults to "unbounded" would let every existing call site keep the
 * pre-containment answer while reading as though it had been updated: the
 * quietest possible way to ship a retirement that retires nothing. `null` is a
 * different statement — "the read returned no venue for this field" — and
 * because `fields.location_id` is `uuid NOT NULL` (20260331000000:328) that
 * cannot happen against a healthy read. It means the locations query failed or
 * was filtered, so the honest answer is "do not offer it", the same direction
 * the 8.4 PR 3 review took when `useFields().error` was being dropped.
 *
 * `isLiveOn` is `packages/core`'s single reading of an effective window and is
 * the same answer `public.field_is_live_on(effective_to, d)` gives in SQL
 * (`effective_to >= d`, inclusive), so the client and the guard agree on which
 * day is the last usable one.
 *
 * @param {{ active?: boolean|null, effective_to?: string|null }} row
 * @param {string} asOf - `YYYY-MM-DD`
 * @param {{ effective_to?: string|null }|null} venue - the field's `locations`
 *   row, or `null` when the read produced none
 * @returns {boolean}
 */
export function isFieldOfferableOn(row, asOf, venue) {
  if (venue === undefined) {
    throw new TypeError(
      'isFieldOfferableOn needs the field’s venue: pass the locations row, or null only when the read genuinely returned none'
    );
  }
  if (row?.active !== true) return false;
  if (!isLiveOn({ effectiveFrom: null, effectiveTo: row.effective_to ?? null }, asOf)) return false;
  if (venue === null) return false;
  return isLiveOn({ effectiveFrom: null, effectiveTo: venue.effective_to ?? null }, asOf);
}

/**
 * The venue a `fields` row sits at, from a registry keyed by location id.
 *
 * **Enumerated from the `locations` read, not from the fields.** A venue
 * missing here is a failed or filtered read, and {@link isFieldOfferableOn}
 * turns that into "not offerable" rather than into "unbounded". Deriving the
 * venue registry from the fields themselves — the data a break corrupts —
 * would make every field its own authority and the containment rule
 * unfalsifiable.
 *
 * @param {{ location_id?: string|null }} row
 * @param {Record<string, { effective_to?: string|null }>} venuesById
 * @returns {{ effective_to?: string|null }|null}
 */
export function venueOf(row, venuesById) {
  const id = row?.location_id;
  if (id === null || id === undefined) return null;
  return venuesById[String(id)] ?? null;
}

/**
 * `locations` rows keyed by id, for {@link venueOf}.
 *
 * @param {Array<{ id: string, effective_to?: string|null }>} locations
 * @returns {Record<string, any>}
 */
export function venueRegistry(locations) {
  /** @type {Record<string, any>} */
  const byId = {};
  for (const row of locations ?? []) {
    if (row?.id !== null && row?.id !== undefined) byId[String(row.id)] = row;
  }
  return byId;
}
