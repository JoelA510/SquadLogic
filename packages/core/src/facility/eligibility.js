/**
 * Eligibility: is this format playable on this surface, on this date?
 *
 * Three independent questions, deliberately not collapsed into one boolean:
 *
 * - **Size** - is there enough ground? Blocking.
 * - **Line markings** - is the ground actually painted for this format? A
 *   *compromise*, never an error. "7v7 played on a 9v9-lined pitch with
 *   portable goals" is a real and acceptable arrangement; the point is that it
 *   must be visible in the schedule rather than invisible.
 * - **Equipment** - is the required kit there on the day? Date-scoped.
 *
 * Status is always derived mechanically from finding severities by
 * `deriveFacilityStatus()`. No function here writes a status by hand.
 *
 * @module facility/eligibility
 */

import { createMeta, mergeMeta, requireSurface, getSurface } from './facilityGraph.js';
import { checkOccupancy } from './occupancy.js';
import {
  FACILITY_REASON,
  FACILITY_STATUS,
  deriveFacilityStatus,
  makeFinding,
} from './reasonCodes.js';
import { FacilityBookingSchema } from './schemas.js';
import { checkFacilityLifecycle } from './lifecycle.js';

/**
 * Ordering of the season's formats by how much ground they need.
 *
 * Only an ordering - the numbers carry no unit and must not be compared across
 * anything but each other.
 *
 * @type {Readonly<Record<string, number>>}
 */
export const DEFAULT_SIZE_RANK = Object.freeze({
  Minis: 0,
  '4v4': 1,
  '5v5': 2,
  '7v7': 3,
  '9v9': 4,
  '11v11': 5,
});

/** How restrictive each equipment status is; higher wins a disagreement. */
const EQUIPMENT_RESTRICTIVENESS = Object.freeze({
  available: 0,
  unknown: 1,
  unavailable: 2,
});

/** Equipment status to reason code. */
const EQUIPMENT_STATUS_REASON = Object.freeze({
  available: FACILITY_REASON.EQUIPMENT_AVAILABLE,
  unknown: FACILITY_REASON.EQUIPMENT_STATUS_UNKNOWN,
  unavailable: FACILITY_REASON.EQUIPMENT_UNAVAILABLE,
});

/**
 * Days since 1970-01-01 for an ISO `YYYY-MM-DD` string.
 *
 * Hand-rolled (Howard Hinnant's `days_from_civil`) rather than `new Date(...)`:
 * this package must stay free of timezone-sensitive construction, and the only
 * thing the caller needs is the *width* of a date range.
 *
 * Exported because the availability model (Phase 1.3) needs the same
 * timezone-free civil-date arithmetic to work out a weekday, and a second copy
 * of it would be a second thing to get wrong.
 *
 * @param {string} iso
 * @returns {number}
 */
export function isoDayNumber(iso) {
  const year = Number(iso.slice(0, 4));
  const month = Number(iso.slice(5, 7));
  const day = Number(iso.slice(8, 10));
  const shiftedYear = month <= 2 ? year - 1 : year;
  const era = Math.floor(shiftedYear / 400);
  const yearOfEra = shiftedYear - era * 400;
  const dayOfYear = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const dayOfEra =
    yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146097 + dayOfEra - 719468;
}

/**
 * The inverse of {@link isoDayNumber}: `YYYY-MM-DD` for a day number.
 *
 * Hand-rolled (Hinnant's `civil_from_days`) for the reason its twin above
 * gives — this package builds no `Date`.
 *
 * Added here, next to `isoDayNumber()`, rather than inside the module that
 * needed it: Phase 8.5's practice model has to walk a date range, and the
 * forward direction was already exported from here precisely so a second copy
 * would not appear. Putting the inverse anywhere else would have split one
 * round trip across two homes.
 *
 * **A third copy of this arithmetic already exists and is not touched here.**
 * `fieldAdmin/consequences.js` carries its own family — `toDayNumber()` (:109),
 * `isoDayOfWeek()` (:131) and `fromDayNumber()` (:388) — duplicating this
 * function and `isoDayNumber()`. Consolidating the two families means changing
 * `fieldAdmin`'s public barrel and its tests, which is a refactor in its own
 * right rather than a rider on a domain-model PR, so it is named rather than
 * done. What 8.5 does guarantee is that it added no *new* duplicate: the
 * practice model imports this pair and defines neither.
 *
 * @param {number} dayNumber - days since 1970-01-01
 * @returns {string}
 */
export function isoDateOfDayNumber(dayNumber) {
  const shifted = dayNumber + 719468;
  const era = Math.floor(shifted / 146097);
  const dayOfEra = shifted - era * 146097;
  const yearOfEra = Math.floor(
    (dayOfEra -
      Math.floor(dayOfEra / 1460) +
      Math.floor(dayOfEra / 36524) -
      Math.floor(dayOfEra / 146096)) /
      365
  );
  const year = yearOfEra + era * 400;
  const dayOfYear =
    dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const monthPrime = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * monthPrime + 2) / 5) + 1;
  const month = monthPrime + (monthPrime < 10 ? 3 : -9);
  const civilYear = year + (month <= 2 ? 1 : 0);
  return `${String(civilYear).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Rank table in force for a graph, with a caller override.
 *
 * @param {import('./types.js').FacilityGraph} graph
 * @param {{ sizeRank?: Record<string, number> }} [options]
 * @returns {Record<string, number>}
 */
function sizeRankOf(graph, options = {}) {
  return options.sizeRank ?? graph.sizeRank ?? DEFAULT_SIZE_RANK;
}

/**
 * Is the surface big enough for the format?
 *
 * Default policy is `downward-closed`: a surface declared for 11v11 also holds
 * a 9v9 game. `sizePolicy: 'declared'` keeps literal membership available for
 * callers who need it.
 *
 * Wasteful-but-legal (a 4v4 game on the 11v11 stadium) is **allowed**, not a
 * compromise. Lining is the compromise case in Phase 1; preferring a
 * right-sized pitch is an objective term, not a constraint.
 *
 * @param {import('./types.js').FacilityGraph} graph
 * @param {{ surfaceId: string, format: string }} query
 * @param {{ sizePolicy?: string, sizeRank?: Record<string, number> }} [options]
 * @returns {import('./types.js').FacilityCheckResult}
 */
export function checkSizeEligibility(graph, { surfaceId, format }, options = {}) {
  const surface = requireSurface(graph, surfaceId);
  const meta = createMeta();
  meta.surfacesConsidered = 1;
  /** @type {import('./types.js').FacilityFinding[]} */
  const findings = [];

  const policy = options.sizePolicy ?? graph.sizePolicy ?? 'downward-closed';
  const rankTable = sizeRankOf(graph, options);
  const base = {
    surfaceId,
    surfaceName: surface.name,
    venueId: surface.venueId,
    format,
    sizes: [...surface.sizes],
    sizePolicy: policy,
  };

  if (surface.sizes.length === 0) {
    findings.push(
      makeFinding(
        FACILITY_REASON.SIZE_UNDECLARED,
        `${surface.name} declares no sizes, so nothing can be proved eligible on it`,
        base
      )
    );
    return { status: deriveFacilityStatus(findings), findings, meta };
  }

  // A literal declaration always wins, whatever the policy and whatever the
  // rank table happens to know about.
  if (surface.sizes.includes(format)) {
    return { status: FACILITY_STATUS.ALLOWED, findings, meta };
  }

  const formatRank = rankTable[format];
  const rankedSizes = surface.sizes.filter((size) => rankTable[size] !== undefined);
  if (formatRank === undefined || rankedSizes.length === 0) {
    findings.push(
      makeFinding(
        FACILITY_REASON.SIZE_UNKNOWN_FORMAT,
        `cannot rank "${format}" against ${surface.name}'s declared sizes, so eligibility cannot be proved`,
        base
      )
    );
    return { status: deriveFacilityStatus(findings), findings, meta };
  }

  const largestSize = rankedSizes.reduce((best, size) =>
    rankTable[size] > rankTable[best] ? size : best
  );
  if (formatRank > rankTable[largestSize]) {
    findings.push(
      makeFinding(
        FACILITY_REASON.SIZE_TOO_SMALL,
        `${surface.name} is not ${format}-sized (largest declared size: ${largestSize})`,
        { ...base, largestDeclaredSize: largestSize }
      )
    );
  } else if (policy === 'declared') {
    findings.push(
      makeFinding(
        FACILITY_REASON.SIZE_NOT_DECLARED,
        `${surface.name} would fit ${format}, but sizePolicy is "declared" and ${format} is not on its list`,
        base
      )
    );
  }

  return { status: deriveFacilityStatus(findings), findings, meta };
}

/**
 * Is the surface actually lined for the format?
 *
 * Always literal membership - line paint is either on the grass or it is not,
 * and there is no downward-closed story to tell about it. A mismatch is a
 * compromise, so it changes the status without rejecting the booking.
 *
 * @param {import('./types.js').FacilityGraph} graph
 * @param {{ surfaceId: string, format: string }} query
 * @returns {import('./types.js').FacilityCheckResult}
 */
export function checkLining(graph, { surfaceId, format }) {
  const surface = requireSurface(graph, surfaceId);
  const meta = createMeta();
  meta.surfacesConsidered = 1;
  /** @type {import('./types.js').FacilityFinding[]} */
  const findings = [];
  const base = {
    surfaceId,
    surfaceName: surface.name,
    venueId: surface.venueId,
    format,
    linedFor: [...surface.lined],
  };

  if (surface.lined.length === 0) {
    findings.push(
      makeFinding(
        FACILITY_REASON.LINING_UNDECLARED,
        `${surface.name} records no line markings`,
        base
      )
    );
  } else if (!surface.lined.includes(format)) {
    findings.push(
      makeFinding(
        FACILITY_REASON.LINING_MISMATCH,
        `${surface.name} is lined for ${surface.lined.join(', ')}, not ${format}; playable with portable goals but flag it as a compromise`,
        base
      )
    );
  }

  return { status: deriveFacilityStatus(findings), findings, meta };
}

/**
 * Which windows govern one piece of equipment on one surface on one date.
 *
 * Precedence mirrors `resolvePermit()` in the season-2026 parsers: the narrower
 * scope wins, and within a tier the narrower date range wins. Two survivors
 * that disagree are **not** silently reconciled - the more restrictive status
 * is applied *and* `EQUIPMENT_PRECEDENCE_AMBIGUOUS` is emitted.
 *
 * A `surface`-scoped window applies to that surface and its descendants: goals
 * standing on Pitch 1 are equally standing on halves 1A and 1B.
 *
 * @param {import('./types.js').FacilityGraph} graph
 * @param {import('./types.js').FacilitySurface} surface
 * @param {string} equipment
 * @param {string} date
 * @returns {{ survivors: import('./types.js').EquipmentWindow[], consulted: number }}
 */
function resolveEquipmentWindows(graph, surface, equipment, date) {
  /** @type {Array<{ window: import('./types.js').EquipmentWindow, tier: number, span: number }>} */
  const applicable = [];
  let consulted = 0;

  for (const window of graph.equipmentWindows) {
    consulted += 1;
    if (window.equipment !== equipment) continue;
    if (date < window.fromDate || date > window.toDate) continue;

    let tier = null;
    if (window.scope.kind === 'surface' && surface.lineage.includes(window.scope.id)) tier = 1;
    else if (window.scope.kind === 'venue' && window.scope.id === surface.venueId) tier = 0;
    if (tier === null) continue;

    applicable.push({
      window,
      tier,
      span: isoDayNumber(window.toDate) - isoDayNumber(window.fromDate),
    });
  }

  if (applicable.length === 0) return { survivors: [], consulted };

  const bestTier = Math.max(...applicable.map((entry) => entry.tier));
  const sameTier = applicable.filter((entry) => entry.tier === bestTier);
  const narrowest = Math.min(...sameTier.map((entry) => entry.span));
  return {
    survivors: sameTier.filter((entry) => entry.span === narrowest).map((entry) => entry.window),
    consulted,
  };
}

/**
 * Is the kit this format needs present on this surface on this date?
 *
 * Requirements come from `graph.formatEquipment` and nowhere else. There is no
 * derivation rule: a format absent from the map requires nothing and yields
 * `EQUIPMENT_UNDECLARED` (info). Guessing `` `${format} goals` `` would either
 * block bookings for kit nobody needs or fail to block ones that matter, and
 * both failures are silent.
 *
 * @param {import('./types.js').FacilityGraph} graph
 * @param {{ surfaceId: string, format: string, date: string }} query
 * @returns {import('./types.js').FacilityCheckResult}
 */
export function checkEquipment(graph, { surfaceId, format, date }) {
  const surface = requireSurface(graph, surfaceId);
  const meta = createMeta();
  meta.surfacesConsidered = 1;
  /** @type {import('./types.js').FacilityFinding[]} */
  const findings = [];

  const required = graph.formatEquipment[format];
  if (!required || required.length === 0) {
    findings.push(
      makeFinding(
        FACILITY_REASON.EQUIPMENT_UNDECLARED,
        `no equipment requirement is declared for ${format}`,
        { surfaceId, surfaceName: surface.name, venueId: surface.venueId, format, date }
      )
    );
    return { status: deriveFacilityStatus(findings), findings, meta };
  }

  for (const equipment of required) {
    const { survivors, consulted } = resolveEquipmentWindows(graph, surface, equipment, date);
    meta.equipmentWindowsConsulted += consulted;

    const base = {
      surfaceId,
      surfaceName: surface.name,
      venueId: surface.venueId,
      format,
      date,
      equipment,
    };

    if (survivors.length === 0) {
      findings.push(
        makeFinding(
          FACILITY_REASON.EQUIPMENT_ASSUMED_AVAILABLE,
          `no record covers ${equipment} at ${surface.name} on ${date}; presumed available`,
          base
        )
      );
      continue;
    }

    const statuses = [...new Set(survivors.map((window) => window.status))];
    const effective = statuses.reduce((worst, status) =>
      EQUIPMENT_RESTRICTIVENESS[status] > EQUIPMENT_RESTRICTIVENESS[worst] ? status : worst
    );
    const winner = survivors.find((window) => window.status === effective) ?? survivors[0];

    if (statuses.length > 1) {
      findings.push(
        makeFinding(
          FACILITY_REASON.EQUIPMENT_PRECEDENCE_AMBIGUOUS,
          `${survivors.length} equally specific records disagree about ${equipment} at ${surface.name} on ${date}; applying the most restrictive ("${effective}")`,
          {
            ...base,
            windowIds: survivors.map((window) => window.id),
            statuses,
            appliedStatus: effective,
          }
        )
      );
    }

    findings.push(
      makeFinding(
        EQUIPMENT_STATUS_REASON[effective],
        `${equipment} at ${surface.name} on ${date} is recorded as ${effective}`,
        {
          ...base,
          status: effective,
          windowId: winner.id,
          windowScopeKind: winner.scope.kind,
          windowScopeId: winner.scope.id,
          windowFromDate: winner.fromDate,
          windowToDate: winner.toDate,
          windowNote: winner.note,
          windowSource: winner.source,
        }
      )
    );
  }

  return { status: deriveFacilityStatus(findings), findings, meta };
}

/**
 * Size, lining and equipment together for one surface/format/date.
 *
 * Returns **all** findings, never the first hit: a pitch can be
 * lining-compromised and equipment-blocked at once, and an operator who only
 * sees the first one fixes the wrong thing.
 *
 * @param {import('./types.js').FacilityGraph} graph
 * @param {{ surfaceId: string, format: string|null, date?: string|null }} query
 * @param {{ sizePolicy?: string, sizeRank?: Record<string, number> }} [options]
 * @returns {import('./types.js').FacilityCheckResult}
 */
export function checkFieldEligibility(graph, { surfaceId, format, date = null }, options = {}) {
  requireSurface(graph, surfaceId);
  const meta = createMeta();
  /** @type {import('./types.js').FacilityFinding[]} */
  const findings = [];

  if (format === null || format === undefined) {
    // Still a lifecycle question: "is this ground part of the estate" does not
    // depend on a format, and returning early without asking would make the
    // count silently absent on exactly the path a caller uses to ask about a
    // surface generally.
    const bare = checkFacilityLifecycle(graph, { asOf: date, surfaceId });
    findings.push(...bare.findings);
    mergeMeta(meta, bare.meta);
    meta.surfacesConsidered = 1;
    return { status: deriveFacilityStatus(findings), findings, meta };
  }

  const size = checkSizeEligibility(graph, { surfaceId, format }, options);
  findings.push(...size.findings);
  mergeMeta(meta, size.meta);

  const lining = checkLining(graph, { surfaceId, format });
  findings.push(...lining.findings);
  mergeMeta(meta, lining.meta);

  if (date) {
    const equipment = checkEquipment(graph, { surfaceId, format, date });
    findings.push(...equipment.findings);
    mergeMeta(meta, equipment.meta);
  }

  // **The lifecycle axis, asked on every path including the dateless one.**
  //
  // `date` is optional here and required on a booking, which is why this is the
  // entry point that can be underspecified at all: a caller asking "does this
  // pitch fit 9v9" with no date is asking about an estate that may have more
  // than one shape. `checkFacilityLifecycle()` publishes `datedNodeCount`
  // either way, so a report cannot confuse "nothing was dated" with "nothing
  // was checked".
  const lifecycle = checkFacilityLifecycle(graph, { asOf: date, surfaceId });
  findings.push(...lifecycle.findings);
  mergeMeta(meta, lifecycle.meta);

  // The three sub-checks each counted the same surface.
  meta.surfacesConsidered = 1;
  return { status: deriveFacilityStatus(findings), findings, meta };
}

/**
 * The whole question for one candidate booking: does the surface exist, is it
 * bookable, does the format fit, is the kit there, and does anything already
 * booked stand on the same ground at the same time?
 *
 * @param {import('./types.js').FacilityGraph} graph
 * @param {import('./types.js').FacilityBooking} booking
 * @param {{ existingBookings?: ReadonlyArray<import('./types.js').FacilityBooking>, sizePolicy?: string, sizeRank?: Record<string, number> }} [options]
 * @returns {import('./types.js').FacilityCheckResult}
 */
export function checkBooking(graph, booking, options = {}) {
  const candidate = /** @type {import('./types.js').FacilityBooking} */ (
    FacilityBookingSchema.parse(booking)
  );
  const meta = createMeta();
  /** @type {import('./types.js').FacilityFinding[]} */
  const findings = [];

  const surface = getSurface(graph, candidate.surfaceId);
  if (!surface) {
    findings.push(
      makeFinding(
        FACILITY_REASON.SURFACE_UNKNOWN,
        `booking ${candidate.id} names surface "${candidate.surfaceId}", which is not in the graph`,
        { bookingId: candidate.id, surfaceId: candidate.surfaceId, date: candidate.date }
      )
    );
    return { status: deriveFacilityStatus(findings), findings, meta };
  }
  meta.surfacesConsidered = 1;

  if (!surface.bookable) {
    findings.push(
      makeFinding(
        FACILITY_REASON.SURFACE_NOT_BOOKABLE,
        `${surface.name} is not directly bookable`,
        {
          bookingId: candidate.id,
          surfaceId: surface.id,
          surfaceName: surface.name,
          venueId: surface.venueId,
        }
      )
    );
  }

  const eligibility = checkFieldEligibility(
    graph,
    { surfaceId: candidate.surfaceId, format: candidate.format ?? null, date: candidate.date },
    options
  );
  findings.push(...eligibility.findings);
  mergeMeta(meta, eligibility.meta);

  const occupancy = checkOccupancy(graph, candidate, options.existingBookings ?? []);
  findings.push(...occupancy.findings);
  mergeMeta(meta, occupancy.meta);

  meta.surfacesConsidered = 1;
  return { status: deriveFacilityStatus(findings), findings, meta };
}
