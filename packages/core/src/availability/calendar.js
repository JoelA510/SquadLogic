/**
 * The availability calendar: when a site is usable, as data.
 *
 * Three questions live here, and each of them is answered from records rather
 * than from a rule someone typed into a scheduler:
 *
 * ```text
 * resolvePermitWindow()   which permit governs this venue on this date
 * sunsetOn()              what time the sun sets on this date (the table)
 * sunsetForVenue()        ... at this venue: table, else coordinates, else unknown
 * resolveLighting()       is this *field* lit, and until when
 * ```
 *
 * **Precedence is the whole point of the permit half.** GAP-08: a date-scoped
 * exception beats the weekday default, and a stated blackout ("—" in both time
 * columns of the corpus's Summit HS 09/19 row) is a third state distinct from
 * both "open" and "no record". A model that stores one window per venue gets
 * every one of the corpus's three Summit HS behaviours wrong.
 *
 * The calendar holds **no bookings**. Every query takes the caller's own, the
 * same contract `facility/facilityGraph.js` and `timing/formatTiming.js` keep.
 *
 * @module availability/calendar
 */

import { getSurface, requireSurface } from '../facility/facilityGraph.js';
import { isoDayNumber } from '../facility/eligibility.js';
import { crossCheckClockChangeNotes, deriveSeasonClockEvents } from '../timing/seasonEvents.js';
import { sunsetEnforcementMinutes, sunsetOnDate } from '../timing/solar.js';
import { AvailabilityCalendarInputSchema } from './schemas.js';
import {
  AVAILABILITY_REASON,
  SUNSET_SOURCES_TOLERANCE_MINUTES,
  deriveAvailabilityStatus,
  makeAvailabilityFinding,
} from './reasonCodes.js';

/** Weekday codes, indexed the way `weekdayCodeOf()` produces them. */
const WEEKDAY_CODES = Object.freeze(['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']);

/**
 * A zeroed counter block. The first five keys mirror `FacilityMeta` exactly so
 * a facility result can be absorbed without loss.
 *
 * Plumbing, not API: deliberately not re-exported from the barrel, exactly as
 * `timing/formatTiming.js` keeps `createTimingMeta()` off it.
 *
 * @returns {import('./types.js').AvailabilityMeta}
 */
export function createAvailabilityMeta() {
  return {
    surfacesConsidered: 0,
    cellPairsCompared: 0,
    overlapPairsConsulted: 0,
    equipmentWindowsConsulted: 0,
    bookingPairsCompared: 0,
    permitWindowsConsulted: 0,
    sunsetRecordsConsulted: 0,
    lightingRecordsConsulted: 0,
    constraintsEvaluated: 0,
    candidateKickoffsTested: 0,
  };
}

/**
 * Add `source`'s counters into `target` in place.
 *
 * @param {import('./types.js').AvailabilityMeta} target
 * @param {import('./types.js').AvailabilityMeta} source
 * @returns {import('./types.js').AvailabilityMeta} `target`
 */
export function mergeAvailabilityMeta(target, source) {
  for (const key of Object.keys(target)) {
    if (typeof source[key] === 'number') target[key] += source[key];
  }
  return target;
}

/**
 * Absorb a `FacilityMeta` into an `AvailabilityMeta`.
 *
 * Only the five shared counters move; the availability-only counters are this
 * module's own and a facility result has nothing to say about them.
 *
 * @param {import('./types.js').AvailabilityMeta} target
 * @param {import('../facility/types.js').FacilityMeta} source
 * @returns {import('./types.js').AvailabilityMeta} `target`
 */
export function absorbFacilityMetaInto(target, source) {
  target.surfacesConsidered += source.surfacesConsidered;
  target.cellPairsCompared += source.cellPairsCompared;
  target.overlapPairsConsulted += source.overlapPairsConsulted;
  target.equipmentWindowsConsulted += source.equipmentWindowsConsulted;
  target.bookingPairsCompared += source.bookingPairsCompared;
  return target;
}

/**
 * Recursively freeze a value, so no consumer can turn the calendar into hidden
 * shared state.
 *
 * @template T
 * @param {T} value
 * @returns {T}
 */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const inner of Object.values(value)) deepFreeze(inner);
  return value;
}

/**
 * Weekday code (`SUN`..`SAT`) for an ISO calendar date.
 *
 * Built on the facility module's `isoDayNumber()` rather than on a constructed
 * JS date: 1970-01-01 was a Thursday, so the offset is a constant and the answer
 * can never depend on the host timezone (GAP-30). The corpus loader's own
 * `weekdayCode()` goes through `Date.UTC`, which is safe but is still a date
 * object; this package builds none.
 *
 * @param {string} isoDate
 * @returns {string}
 */
export function weekdayCodeOf(isoDate) {
  const days = isoDayNumber(isoDate);
  // +4 because day 0 (1970-01-01) is a Thursday, which is index 4.
  return WEEKDAY_CODES[(((days + 4) % 7) + 7) % 7];
}

/**
 * How restrictive a permit window is, so that two records of equal specificity
 * can be resolved without a coin toss. Higher wins.
 *
 * A blackout is maximally restrictive; between two real windows, the one that
 * closes earlier wins. Same contract as `EQUIPMENT_RESTRICTIVENESS` in
 * `facility/eligibility.js`: the resolver applies the tighter record *and*
 * reports the ambiguity, never picks silently.
 *
 * @param {import('./types.js').PermitWindow} window
 * @returns {number}
 */
function restrictiveness(window) {
  if (!window.hasPermit) return Number.POSITIVE_INFINITY;
  return -(/** @type {number} */ (window.closeMinutes));
}

/**
 * How restrictive a lighting record is, on the same contract as
 * {@link restrictiveness}: unlit ground is maximally restrictive, and between
 * two lit records the one whose lights go off earlier wins. A lit record with no
 * stated lights-off bounds nothing, so it is the loosest of all.
 *
 * @param {import('./types.js').SurfaceLighting} record
 * @returns {number}
 */
function lightingRestrictiveness(record) {
  if (!record.lit) return Number.POSITIVE_INFINITY;
  if (record.lightsOffMinutes === null) return Number.NEGATIVE_INFINITY;
  return -record.lightsOffMinutes;
}

/**
 * Build an immutable availability calendar from plain data.
 *
 * Takes what the season-2026 parsers already produce (via
 * `adapters/season2026Permits.js`) rather than re-reading the CSVs: there is one
 * parser for `facility_permits.csv` and one for `sunsets.csv` in this repo, and
 * neither is here. Re-parsing an em dash would create a second reading of "no
 * permit" free to disagree with the first.
 *
 * @param {Object} input - see `AvailabilityCalendarInputSchema`
 * @returns {import('./types.js').AvailabilityCalendar}
 */
export function buildAvailabilityCalendar(input) {
  const parsed = AvailabilityCalendarInputSchema.parse(input);
  const meta = createAvailabilityMeta();
  /** @type {import('./types.js').AvailabilityFinding[]} */
  const findings = [];

  /** @type {Record<string, import('./types.js').PermitWindow[]>} */
  const permitsByVenue = {};
  for (const window of parsed.permitWindows) {
    meta.permitWindowsConsulted += 1;
    const bucket = permitsByVenue[window.venueId] ?? [];
    bucket.push(/** @type {import('./types.js').PermitWindow} */ (window));
    permitsByVenue[window.venueId] = bucket;
  }

  /** @type {Record<string, import('./types.js').SunsetRecord>} */
  const sunsetsByDate = {};
  for (const record of parsed.sunsets) {
    meta.sunsetRecordsConsulted += 1;
    const existing = sunsetsByDate[record.date];
    if (existing && existing.sunsetMinutes !== record.sunsetMinutes) {
      findings.push(
        makeAvailabilityFinding(
          AVAILABILITY_REASON.SUNSET_PRECEDENCE_AMBIGUOUS,
          `two sunset records claim ${record.date} (${existing.sunsetMinutes} and ${record.sunsetMinutes} minutes past midnight); the earlier one is applied`,
          {
            date: record.date,
            sunsetMinutes: Math.min(existing.sunsetMinutes, record.sunsetMinutes),
            otherSunsetMinutes: Math.max(existing.sunsetMinutes, record.sunsetMinutes),
          }
        )
      );
    }
    if (!existing || record.sunsetMinutes < existing.sunsetMinutes) {
      sunsetsByDate[record.date] = /** @type {import('./types.js').SunsetRecord} */ (record);
    }
  }

  /** @type {Record<string, import('./types.js').SurfaceLighting>} */
  const lightingBySurface = {};
  for (const record of parsed.lighting) {
    meta.lightingRecordsConsulted += 1;
    const existing = lightingBySurface[record.surfaceId];
    const incoming = /** @type {import('./types.js').SurfaceLighting} */ (record);
    const applied =
      !existing || lightingRestrictiveness(incoming) > lightingRestrictiveness(existing)
        ? incoming
        : existing;
    if (
      existing &&
      (existing.lit !== incoming.lit || existing.lightsOffMinutes !== incoming.lightsOffMinutes)
    ) {
      const other = applied === incoming ? existing : incoming;
      findings.push(
        makeAvailabilityFinding(
          AVAILABILITY_REASON.LIGHTING_PRECEDENCE_AMBIGUOUS,
          `two lighting records claim surface ${record.surfaceId}; the more restrictive one is applied`,
          {
            surfaceId: record.surfaceId,
            lit: applied.lit,
            lightsOffMinutes: applied.lightsOffMinutes,
            otherLit: other.lit,
            otherLightsOffMinutes: other.lightsOffMinutes,
          }
        )
      );
    }
    lightingBySurface[record.surfaceId] = applied;
  }

  /** @type {Record<string, import('./types.js').VenueDaylight>} */
  const daylightByVenue = {};
  for (const record of parsed.venueDaylight) {
    daylightByVenue[record.venueId] = /** @type {import('./types.js').VenueDaylight} */ (record);
  }

  // G2 of the 8.9 plan: the season's clock changes are derived from its zone,
  // over the span the table covers, and the table's `Note` column is read as a
  // claim checked against them (D12). No zone or no table rows, no events --
  // "not derived", never "none". Computed sunsets do not depend on this list:
  // `sunsetOnDate()` reads the zone's offset for each date itself.
  /** @type {import('../timing/seasonEvents.js').SeasonClockEvent[]} */
  let clockChanges = [];
  let clockChangeNotesExamined = 0;
  if (parsed.timeZone !== null && parsed.sunsets.length > 0) {
    const dates = parsed.sunsets.map((record) => record.date).sort();
    const derived = deriveSeasonClockEvents({
      from: dates[0],
      to: dates[dates.length - 1],
      timeZone: parsed.timeZone,
    });
    clockChanges = derived.events;
    findings.push(...derived.findings);
    const checked = crossCheckClockChangeNotes({ notes: parsed.sunsets, events: clockChanges });
    clockChangeNotesExamined = checked.notesExamined;
    findings.push(...checked.findings);
  }

  const permitWindows = /** @type {import('./types.js').PermitWindow[]} */ (parsed.permitWindows);
  const calendar = {
    permitWindows,
    permitsByVenue,
    sunsetsByDate,
    lightingBySurface,
    daylightByVenue,
    timeZone: parsed.timeZone,
    clockChanges,
    sunsetMarginMinutes: parsed.sunsetMarginMinutes,
    permitMarginMinutes: parsed.permitMarginMinutes,
    source: parsed.source,
    status: deriveAvailabilityStatus(findings),
    findings,
    meta,
    stats: {
      permitWindowCount: permitWindows.length,
      venueCount: Object.keys(permitsByVenue).length,
      weekdayDefaultCount: permitWindows.filter((w) => w.scopeKind === 'weekday-default').length,
      dateExceptionCount: permitWindows.filter((w) => w.scopeKind === 'date-exception').length,
      blackoutCount: permitWindows.filter((w) => !w.hasPermit).length,
      litPermitCount: permitWindows.filter((w) => w.lit === true).length,
      sunsetCount: Object.keys(sunsetsByDate).length,
      lightingRecordCount: Object.keys(lightingBySurface).length,
      daylightVenueCount: Object.keys(daylightByVenue).length,
      clockChangeNotesExamined,
    },
  };

  return deepFreeze(/** @type {import('./types.js').AvailabilityCalendar} */ (calendar));
}

/**
 * Which permit governs a venue on a date.
 *
 * Precedence, generalised from the corpus loader's own `resolvePermit()`:
 *
 * 1. a record scoped to that exact date — including a blackout;
 * 2. otherwise the weekday default for that date's weekday;
 * 3. otherwise nothing, which is `scopeKind: 'none'` and **not** the same as a
 *    blackout.
 *
 * Two survivors of equal specificity that disagree are reported as ambiguous by
 * the caller (`checkKickoffAvailability`); the more restrictive one is applied.
 *
 * @param {import('./types.js').AvailabilityCalendar} calendar
 * @param {{ venueId: string, date: string }} query
 * @returns {import('./types.js').ResolvedPermit & { consulted: number }}
 */
export function resolvePermitWindow(calendar, { venueId, date }) {
  const forVenue = calendar.permitsByVenue[venueId] ?? [];
  let consulted = forVenue.length;

  const exact = forVenue.filter((window) => window.date === date);
  const weekday = weekdayCodeOf(date);
  const defaults = forVenue.filter(
    (window) => window.scopeKind === 'weekday-default' && window.weekday === weekday
  );

  const candidates = exact.length > 0 ? exact : defaults;
  /** @type {'date-exception'|'weekday-default'|'none'} */
  const scopeKind =
    exact.length > 0 ? 'date-exception' : defaults.length > 0 ? 'weekday-default' : 'none';

  if (candidates.length === 0) {
    return { window: null, scopeKind: 'none', ambiguous: false, candidates: [], consulted };
  }

  // Deterministic: most restrictive first, then by id so equal records never
  // swap places between runs.
  const ordered = [...candidates].sort((a, b) => {
    const delta = restrictiveness(b) - restrictiveness(a);
    // Two blackouts are both `Infinity`, and `Infinity - Infinity` is `NaN`.
    // Without this guard the comparator would answer for a difference it never
    // measured and the id tie-break below would never run, so which of two
    // equal records won would depend on the order they were loaded in. Same
    // guard as `orderByTightness()` in `kickoff.js`.
    if (delta !== 0 && !Number.isNaN(delta)) return delta > 0 ? 1 : -1;
    return a.id.localeCompare(b.id);
  });
  consulted = Math.max(consulted, ordered.length);

  const ambiguous =
    ordered.length > 1 &&
    ordered.some(
      (window) =>
        window.hasPermit !== ordered[0].hasPermit ||
        window.openMinutes !== ordered[0].openMinutes ||
        window.closeMinutes !== ordered[0].closeMinutes
    );

  return { window: ordered[0], scopeKind, ambiguous, candidates: ordered, consulted };
}

/**
 * The sunset record for a date, or `null` when the calendar has none.
 *
 * @param {import('./types.js').AvailabilityCalendar} calendar
 * @param {string} date
 * @returns {import('./types.js').SunsetRecord|null}
 */
export function sunsetOn(calendar, date) {
  return calendar.sunsetsByDate[date] ?? null;
}

/**
 * The daylight provider: sunset at one venue on one date, and where it came from.
 *
 * Precedence (8.9 plan, decision D10):
 *
 * 1. **the date-keyed table** -- authoritative wherever it has a record,
 *    because it is what the season was built against;
 * 2. **computed** from the venue's coordinates by `timing/solar.js`, on the
 *    season's clock (`calendar.timeZone`);
 * 3. **unknown** -- `SUNSET_UNKNOWN` with `details.cause`
 *    `'venue-coordinates-missing'` (or `'sunset-not-computable'` when the solar
 *    module refused), and `sunsetMinutes: null`. Never a default, never "late".
 *
 * When both sources exist and differ by more than
 * `SUNSET_SOURCES_TOLERANCE_MINUTES`, the table is still applied and
 * `SUNSET_SOURCES_DISAGREE` says so.
 *
 * `sunsetMinutes` is the **enforcement** minute: the `floor` of the source
 * (decision D2), the earlier minute. The table's minutes are whole already;
 * a computed sunset is fractional and is floored here, so every consumer
 * compares against the same conservative integer.
 *
 * The game path does not call this: `sunsetConstraint()` in `kickoff.js` reads
 * the table through {@link sunsetOn}, with its own margin, unchanged.
 *
 * @param {import('./types.js').AvailabilityCalendar} calendar
 * @param {{ venueId: string|null, date: string }} query
 * @returns {import('./types.js').VenueSunset}
 */
export function sunsetForVenue(calendar, { venueId, date }) {
  const record = sunsetOn(calendar, date);
  const tableMinutes = record ? record.sunsetMinutes : null;
  const daylight = venueId === null ? null : (calendar.daylightByVenue?.[venueId] ?? null);
  const hasCoordinates = daylight !== null && daylight.latitude !== null;
  const base = { venueId, date };

  /** @type {import('./types.js').AvailabilityFinding[]} */
  const findings = [];
  /** @type {number|null} */
  let computedMinutes = null;
  /** @type {string|null} */
  let computedRefusal = null;
  if (hasCoordinates) {
    const computed = sunsetOnDate({
      date,
      latitude: /** @type {number} */ (daylight.latitude),
      longitude: /** @type {number} */ (daylight.longitude),
      timeZone: calendar.timeZone,
    });
    computedMinutes = computed.minutes;
    computedRefusal = computed.code;
  }

  if (tableMinutes !== null) {
    if (
      computedMinutes !== null &&
      Math.abs(computedMinutes - tableMinutes) > SUNSET_SOURCES_TOLERANCE_MINUTES
    ) {
      findings.push(
        makeAvailabilityFinding(
          AVAILABILITY_REASON.SUNSET_SOURCES_DISAGREE,
          `on ${date} the sunset table says minute ${tableMinutes} and venue ${venueId}'s coordinates give minute ${computedMinutes.toFixed(1)}; the table is applied`,
          {
            ...base,
            tableMinutes,
            computedMinutes,
            toleranceMinutes: SUNSET_SOURCES_TOLERANCE_MINUTES,
          }
        )
      );
    }
    return {
      sunsetMinutes: Math.floor(tableMinutes),
      source: 'table',
      tableMinutes,
      computedMinutes,
      findings,
    };
  }

  if (computedMinutes !== null) {
    return {
      sunsetMinutes: sunsetEnforcementMinutes({ minutes: computedMinutes }),
      source: 'computed',
      tableMinutes: null,
      computedMinutes,
      findings,
    };
  }

  const cause = hasCoordinates ? 'sunset-not-computable' : 'venue-coordinates-missing';
  findings.push(
    makeAvailabilityFinding(
      AVAILABILITY_REASON.SUNSET_UNKNOWN,
      hasCoordinates
        ? `no sunset is recorded for ${date} and venue ${venueId}'s coordinates give none (${computedRefusal}), so the daylight rule cannot be applied to unlit ground`
        : `no sunset is recorded for ${date} and venue ${venueId ?? '(unknown)'} has no coordinates to compute one from, so the daylight rule cannot be applied to unlit ground`,
      { ...base, cause, timingCode: computedRefusal }
    )
  );
  return {
    sunsetMinutes: null,
    source: 'unknown',
    tableMinutes: null,
    computedMinutes: null,
    findings,
  };
}

/**
 * The latest minute at which an unlit game may still be on the pitch.
 *
 * `null` when no sunset is recorded — never a guessed one. The margin comes
 * from the calendar, which is the only place it is defaulted (15 minutes).
 *
 * @param {import('./types.js').AvailabilityCalendar} calendar
 * @param {string} date
 * @returns {number|null}
 */
export function daylightLimitMinutes(calendar, date) {
  const record = sunsetOn(calendar, date);
  if (!record) return null;
  return record.sunsetMinutes - calendar.sunsetMarginMinutes;
}

/**
 * Is this **field** lit, and until when?
 *
 * Lighting is a property of the field, not of the site: the nearest record wins,
 * looking at the surface itself, then its ancestors (a floodlit full pitch lights
 * both of its halves), then the venue flag from the facility graph.
 *
 * The season-2026 corpus supplies lighting at **venue level only** — GAP-05 —
 * so every corpus field resolves through the last of those three and reports
 * `LIGHTING_FROM_VENUE`. That is a limitation of the fixture, not of the model,
 * and it is recorded in the result rather than hidden by it. A venue that
 * states nothing (`lit: null`, the practice-only venues) resolves to `null`,
 * which `kickoff.js` reports as `LIGHTING_UNDECLARED`.
 *
 * @param {import('../facility/types.js').FacilityGraph} graph
 * @param {import('./types.js').AvailabilityCalendar} calendar
 * @param {string} surfaceId
 * @returns {import('./types.js').ResolvedLighting & { consulted: number }}
 */
export function resolveLighting(graph, calendar, surfaceId) {
  const surface = requireSurface(graph, surfaceId);
  let consulted = 0;

  for (const ancestorId of surface.lineage) {
    const record = calendar.lightingBySurface[ancestorId];
    consulted += 1;
    if (!record) continue;
    return {
      lit: record.lit,
      lightsOffMinutes: record.lightsOffMinutes,
      source: ancestorId === surfaceId ? 'surface' : 'ancestor-surface',
      recordId: ancestorId,
      consulted,
    };
  }

  const venue = graph.venues[surface.venueId] ?? null;
  return {
    // A venue whose flag is `null` has declared nothing; that is carried as
    // `null`, never read as `false` (GAP-05).
    lit: venue ? venue.lit : null,
    lightsOffMinutes: null,
    source: /** @type {'venue'} */ ('venue'),
    recordId: venue?.id ?? null,
    consulted,
  };
}

/**
 * The venue a surface belongs to, or `null` when the surface is unknown.
 *
 * @param {import('../facility/types.js').FacilityGraph} graph
 * @param {string} surfaceId
 * @returns {string|null}
 */
export function venueIdOfSurface(graph, surfaceId) {
  return getSurface(graph, surfaceId)?.venueId ?? null;
}
