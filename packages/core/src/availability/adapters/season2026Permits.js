/**
 * Adapter from what `parseFacilityPermits()` and `parseSunsets()` produce to an
 * availability calendar.
 *
 * **Direction of the arrow: fixtures -> availability.** This module takes the
 * already-parsed arrays and never imports anything from
 * `packages/core/src/fixtures/`. `facility_permits.csv` and `sunsets.csv` have
 * exactly one parser each in this repo and neither is here; re-parsing them
 * would create a second reading of the em dash in the Summit HS 09/19 row — the
 * one that means *no permit at all* — free to disagree with the first.
 *
 * @module availability/adapters/season2026Permits
 */

import { season2026VenueId } from '../../facility/adapters/season2026Geometry.js';
import { buildAvailabilityCalendar } from '../calendar.js';

/**
 * The club's pre-sunset safety margin, quoted from
 * `fixtures/season-2026/README.md`:
 *
 * > Unlit games must end 15 min before sunset.
 *
 * It lives here as a named constant with its provenance attached rather than as
 * a literal at a call site, and it is only ever a **default**: every query path
 * reads `calendar.sunsetMarginMinutes`, so an operator who sets 20 gets 20
 * everywhere.
 */
export const SEASON_2026_SUNSET_MARGIN_MINUTES = 15;

/**
 * How little room against the permit close counts as "tight" for this corpus.
 *
 * Deliberately a **separate** number from the sunset margin even though both are
 * 15 in this season: they answer different questions ("is there enough daylight
 * left?" versus "is there enough of the booking left?") and conflating them
 * would make one impossible to change without moving the other.
 */
export const SEASON_2026_PERMIT_MARGIN_MINUTES = 15;

/**
 * Convert `parseFacilityPermits()` and `parseSunsets()` output into
 * `buildAvailabilityCalendar()` input.
 *
 * The parsers' `raw` source rows are dropped: the schemas are `.strict()`, and a
 * whole CSV row riding along inside a domain object is how a "just in case"
 * field becomes a dependency.
 *
 * Exposed separately from {@link buildAvailabilityCalendarFromSeason2026} so a
 * test can run the plain object through `AvailabilityCalendarInputSchema` and
 * prove the adapter has not quietly grown its own copy of the model.
 *
 * @param {ReadonlyArray<Object>} permits - `Season2026Permit[]`
 * @param {ReadonlyArray<Object>} sunsets - `Season2026Sunset[]`
 * @param {{ lighting?: Array<Object>, sunsetMarginMinutes?: number, permitMarginMinutes?: number, source?: string|null, venueDaylight?: Array<Object>, timeZone?: string|null }} [options]
 * @returns {import('../types.js').AvailabilityCalendarInput}
 */
export function toAvailabilityCalendarInput(permits, sunsets, options = {}) {
  const permitWindows = permits.map((permit, index) => {
    if (permit.scopeKind === 'date-exception' && !permit.date) {
      // Loud, not silent: `parseFacilityPermits()` only resolves `MM/DD` scopes
      // into a date when it is given a `seasonYear`. Without one this row would
      // otherwise become an extra weekday default and quietly override nothing.
      throw new Error(
        `season2026 availability adapter: permit row ${index} ("${permit.scope}") is date-scoped but carries no date; pass { seasonYear } to parseFacilityPermits()`
      );
    }
    return {
      id: `season2026-permit-${index}`,
      venueId: season2026VenueId(permit.venue),
      scopeKind: permit.scopeKind,
      weekday: permit.weekday ?? null,
      date: permit.date ?? null,
      hasPermit: Boolean(permit.hasPermit),
      openMinutes: permit.hasPermit ? permit.openMinutes : null,
      closeMinutes: permit.hasPermit ? permit.closeMinutes : null,
      // The paperwork's own claim about lighting. Kept beside the graph's, not
      // merged into it, so the two can be cross-checked rather than silently
      // reconciled.
      lit: typeof permit.lit === 'boolean' ? permit.lit : null,
      // `facility_permits.csv` has no lights-off column. Null is the honest
      // answer; a lit venue with no stated lights-off is bounded by its permit.
      lightsOffMinutes: null,
      note: permit.notes || null,
      source: `facility_permits.csv#${index}`,
    };
  });

  const sunsetRecords = sunsets.map((sunset) => ({
    date: sunset.date,
    sunsetMinutes: sunset.sunsetMinutes,
    note: sunset.note || null,
    source: 'sunsets.csv',
  }));

  return /** @type {import('../types.js').AvailabilityCalendarInput} */ ({
    source: options.source ?? 'fixtures/season-2026/facility_permits.csv + sunsets.csv',
    permitWindows,
    sunsets: sunsetRecords,
    // The corpus states lighting per venue only (GAP-05), so there are no
    // per-field records to pass. The model supports them; this season's data
    // does not supply any, and inventing some would be fabrication.
    lighting: (options.lighting ?? []).map((record) => ({ ...record })),
    sunsetMarginMinutes: options.sunsetMarginMinutes ?? SEASON_2026_SUNSET_MARGIN_MINUTES,
    permitMarginMinutes: options.permitMarginMinutes ?? SEASON_2026_PERMIT_MARGIN_MINUTES,
    // The corpus names no zone and no venue coordinates. Both are the caller's
    // to supply (a test's assumption, or the database), never defaulted here.
    venueDaylight: (options.venueDaylight ?? []).map((record) => ({ ...record })),
    timeZone: options.timeZone ?? null,
  });
}

/**
 * Build an availability calendar straight from parsed season-2026 permits and
 * sunsets.
 *
 * @param {ReadonlyArray<Object>} permits - `Season2026Permit[]`
 * @param {ReadonlyArray<Object>} sunsets - `Season2026Sunset[]`
 * @param {{ lighting?: Array<Object>, sunsetMarginMinutes?: number, permitMarginMinutes?: number, source?: string|null, venueDaylight?: Array<Object>, timeZone?: string|null }} [options]
 * @returns {import('../types.js').AvailabilityCalendar}
 */
export function buildAvailabilityCalendarFromSeason2026(permits, sunsets, options = {}) {
  return buildAvailabilityCalendar(toAvailabilityCalendarInput(permits, sunsets, options));
}
