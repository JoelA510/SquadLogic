/**
 * Reserve capacity: how much ground a date actually holds, against a stated
 * requirement, and which constraint caps the number.
 *
 * > *"Per-date reserved capacity against a stated requirement, e.g. 'every
 * > Saturday from 09/12 must hold all 14 teams if the league sends them all
 * > home.' Report slots reserved / assigned / spare / meets-requirement, and
 * > which constraint caps the number."*
 *
 * ## Where every number comes from
 *
 * | number | decided by |
 * | --- | --- |
 * | is this kickoff legal here on this date | `availability/kickoff.js` — `checkKickoffAvailability()` |
 * | which of the four edges bounds it, and by how much | the same call's `bindingKinds` / `slackMinutes`, ordered by `orderByTightness()` |
 * | how long the format occupies the ground | `timing/formatTiming.js`, through that call |
 * | how far apart two kickoffs on one field must be | the format's `blockMinutes`, from `game_formats.csv` |
 * | does this ground overlap other ground | `facility/occupancy.js` — `surfacesConflict()`, via `conditions.js` |
 * | which registry constraint claims a blocking code | `resolve/errors.js` — `registryConstraintIdsFor()` |
 *
 * Nothing in this file re-implements any of them. What it adds is the counting:
 * a grid of candidate kickoffs per surface per date, each candidate put through
 * the Phase 1.3 check, and the survivors tallied — with conditional ground kept
 * in its own column, because a slot that exists only while a neighbouring pitch
 * is empty is not the same asset as one that always exists.
 *
 * ## Two deliberate choices, both of which change the numbers
 *
 * 1. **Candidates are judged with no existing bookings.** Capacity is a question
 *    about the ground and the clock — *how many slots could this date hold* —
 *    not about how many are still free after the club filled some in. What is
 *    already reserved is reported separately as `reserved` and `spare`, and what
 *    stands on *overlapping* ground is reported through the condition. Feeding
 *    the reservations back in as occupancy would make the capacity of a fully
 *    booked date zero.
 *
 *    That is a statement about the **same** ground, and it is not a licence to
 *    ignore reservations when a *condition* is evaluated. A condition names
 *    other, overlapping surfaces, and held ground standing there is precisely
 *    what it asks about (GAP-17). A candidate cannot block *itself*, and that is
 *    structural rather than filtered: a condition never names the surface its
 *    own slot stands on, so nothing standing on that surface is watched at all.
 *    Ignoring every reservation instead meant a reservation could never block a
 *    conditional slot, which is most of what a conditional slot is for.
 * 2. **The grid is anchored at a stated first kickoff, not at the permit open.**
 *    A permit that opens at 07:00 does not mean the club plays at 07:00.
 *    `earliestKickoffMinutes` is a required input with no default for exactly
 *    that reason, and {@link buildReserveCapacityReport} proves the anchor
 *    against reality: every reserved slot must land on a generated one, or the
 *    date reports `RESERVED_SLOT_OFF_GRID` at `blocking`. A capacity model that
 *    cannot account for the club's own published reservations is wrong, and a
 *    number from a wrong model is worse than no number.
 *
 *    That guarantee has two halves and needs both. `RESERVED_SLOT_OFF_GRID` is
 *    the **time** half — a reservation at a minute no candidate stands on.
 *    `RESERVED_SLOT_UNCOVERED` is the **space** half — a reservation on a
 *    surface, or a date, this report does not cover. Every reserved slot handed
 *    in is accounted for in exactly one of four buckets, and the counters say
 *    which: `slotsOtherFormat` (a different format is this report's stated
 *    subject, not a silent drop), `reservedSlotsUncovered`,
 *    `reservedSlotsMatched` and `reservedSlotsOffGrid` sum to `slotsExamined`.
 *
 * A candidate that coincides with a reserved slot is evaluated as **held
 * ground**: its condition failing is not a fact about the day but a commitment
 * that cannot be kept, so it reports `RESERVED_SLOT_CONDITION_BLOCKED` at
 * `blocking` where an unreserved candidate reports `SLOT_CONDITION_BLOCKED` at
 * `info`. The season-2026 corpus produces no such case — its blocked candidates
 * are all on Alder Pitch 2, where the club reserved nothing — so that code is
 * reachable in principle and exercised by a constructed case in
 * `tests/reserveCapacity.test.js`, which says so out loud rather than leaving a
 * declared code with no path.
 *
 * The candidate loop stops at the first rejection rather than scanning the day.
 * That is sound and not an optimisation: with no bookings in play the three
 * remaining edges — permit close, lights-off and the daylight limit — are all
 * monotone in the kickoff, so once one is broken every later kickoff breaks it
 * too. The rejected candidate is kept, because it is what names the capping
 * constraint.
 *
 * @module reserve/capacity
 */

import { resolvePermitWindow } from '../availability/calendar.js';
import { checkKickoffAvailability } from '../availability/kickoff.js';
import { AVAILABILITY_REASON, AVAILABILITY_SEVERITY } from '../availability/reasonCodes.js';
import { getSurface } from '../facility/facilityGraph.js';
import { registryConstraintIdsFor } from '../resolve/errors.js';

import { conditionsForSurfaces, evaluateSlotCondition } from './conditions.js';
import {
  CONDITION_VERDICT,
  RESERVE_REASON,
  createReserveMeta,
  deriveReserveStatus,
  makeReserveFinding,
  mergeReserveMeta,
} from './reasonCodes.js';
import { ReserveCapacityInputSchema } from './schemas.js';
import { makeReservedSlot, slotNamesATeam } from './slots.js';

/** How a candidate slot's id is spelled. Stable, and derived from its position. */
export function capacitySlotId(date, surfaceId, kickoffMinutes) {
  return `${date}|${surfaceId}|${kickoffMinutes}`;
}

/**
 * Build the per-date reserve capacity report.
 *
 * @param {{ graph: import('../facility/types.js').FacilityGraph, table: import('../timing/types.js').FormatTimingTable, calendar: import('../availability/types.js').AvailabilityCalendar, registry?: import('../constraints/types.js').ConstraintRegistry }} engines
 * @param {Object} rawInput - see `ReserveCapacityInputSchema`
 * @returns {import('./types.js').ReserveCapacityReport}
 */
export function buildReserveCapacityReport(engines, rawInput) {
  const { graph, table, calendar, registry } = engines ?? {};
  if (!graph || !table || !calendar) {
    throw new Error(
      'reserve: buildReserveCapacityReport needs { graph, table, calendar } as its first argument'
    );
  }
  const input = ReserveCapacityInputSchema.parse(rawInput);
  const meta = createReserveMeta();
  /** @type {import('./types.js').ReserveFinding[]} */
  const findings = [];

  const dates = [...new Set(input.dates)].sort();
  const surfaceIds = [...new Set(input.surfaceIds)].sort();
  const conditions = conditionsForSurfaces(graph, surfaceIds);

  const reservedSlots = input.reservedSlots.map((slot) => makeReservedSlot(slot));
  const bookings = /** @type {ReadonlyArray<import('../facility/types.js').FacilityBooking>} */ (
    input.bookings
  );

  const coveredDates = new Set(dates);
  const coveredSurfaces = new Set(surfaceIds);

  /**
   * The universe this report must account for: reserved slots of its format.
   *
   * The format filter is the report's **stated subject** rather than a silent
   * drop — a `Scrimmage` reservation is held ground, not a game of the format
   * being counted — and the slots it removes are counted in
   * `meta.slotsOtherFormat` so the removal is a number rather than a silence.
   */
  const forFormat = reservedSlots.filter((slot) => slot.format === input.format);
  meta.slotsOtherFormat = reservedSlots.length - forFormat.length;

  /** In scope: on a date and surface the report covers, so the grid can judge it. */
  const inScope = forFormat.filter(
    (slot) => coveredDates.has(slot.date) && coveredSurfaces.has(slot.surfaceId)
  );
  /**
   * The remainder, reconciled rather than dropped.
   *
   * `RESERVED_SLOT_OFF_GRID` catches a reservation misplaced in *time*; this is
   * the same guarantee in *space*. A slot filtered out here used to fall out of
   * every count and every check, so an eleventh reservation standing on ground
   * the report does not cover left its date reading `reserved: 10, atCap: true`
   * instead of over its cap — a commitment that disappears without a word, which
   * is the whole of incident 10.
   */
  const uncovered = forFormat.filter(
    (slot) => !coveredDates.has(slot.date) || !coveredSurfaces.has(slot.surfaceId)
  );
  meta.slotsExamined = reservedSlots.length;

  for (const slot of uncovered) {
    meta.reservedSlotsUncovered += 1;
    const dateCovered = coveredDates.has(slot.date);
    findings.push(
      makeReserveFinding(
        RESERVE_REASON.RESERVED_SLOT_UNCOVERED,
        `reserved slot "${slot.id}" stands on ${slot.surfaceId} on ${slot.date}, which this report does not cover (${dateCovered ? 'the date is covered, the surface is not' : 'the date is not covered'}), so no grid, condition or requirement check in it applies to that ground`,
        {
          slotId: slot.id,
          date: slot.date,
          surfaceId: slot.surfaceId,
          startMinutes: slot.startMinutes,
          format: slot.format,
          dateCovered,
          surfaceCovered: coveredSurfaces.has(slot.surfaceId),
          // A slot on a covered date is still counted against that date's cap;
          // one on a date with no row cannot be counted anywhere, and saying so
          // is the difference between a reported gap and a silent one.
          countedOnDate: dateCovered,
          reportedSurfaceIds: [...surfaceIds],
        }
      )
    );
  }

  /**
   * What each date's `reserved` / `assigned` / `spare` are counted from.
   *
   * The cap is a rule about how many games a day carries, not about where they
   * stand, so a reservation on a covered date counts against it whether or not
   * the report covers its ground.
   */
  const counted = [...inScope, ...uncovered.filter((slot) => coveredDates.has(slot.date))];

  /** @type {import('./types.js').DateCapacity[]} */
  const dateRows = [];

  for (const date of dates) {
    meta.datesExamined += 1;
    /** @type {import('./types.js').SurfaceCapacity[]} */
    const bySurface = [];

    for (const surfaceId of surfaceIds) {
      meta.surfaceDatesExamined += 1;
      const surface = getSurface(graph, surfaceId);
      const condition = conditions[surfaceId] ?? null;
      const reservedHere = inScope.filter(
        (slot) => slot.date === date && slot.surfaceId === surfaceId
      );

      /** @type {number[]} */
      const kickoffMinutes = [];
      // The accepted slots that end past the daylight limit. They count, as legal slots (owner,
      // 2026-11-02: legal with a warning, because some organisations have portable lighting or
      // other workarounds), and the warning is kept so a caller can tell daylight capacity from
      // capacity that needs one.
      /** @type {number[]} */
      const sunsetWarnedKickoffMinutes = [];
      let conditionSatisfied = 0;
      let conditionBlocked = 0;
      let conditionUndecidable = 0;
      /** @type {import('./types.js').SurfaceCapacity} */
      const row = {
        surfaceId,
        surfaceName: surface?.name ?? surfaceId,
        venueId: surface?.venueId ?? '',
        conditional: condition !== null,
        condition,
        kickoffMinutes,
        sunsetWarnedKickoffMinutes,
        sunsetWarnedSlots: 0,
        slots: 0,
        conditionSatisfied: 0,
        conditionBlocked: 0,
        conditionUndecidable: 0,
        reserved: reservedHere.length,
        firstRejectedKickoffMinutes: null,
        cappedByKinds: [],
        blockingCodes: [],
        constraintIds: [],
        slackMinutes: null,
      };

      for (
        let kickoff = Math.max(
          input.earliestKickoffMinutes,
          permitOpenFloor(calendar, surface, date)
        );
        kickoff <= input.latestKickoffMinutes;
        kickoff += input.cadenceMinutes
      ) {
        meta.candidatesTested += 1;
        const answer = checkKickoffAvailability(
          graph,
          table,
          calendar,
          { surfaceId, date, kickoffMinutes: kickoff, format: input.format },
          { existingBookings: [] }
        );
        const blocking = answer.findings.filter(
          (finding) => finding.severity === AVAILABILITY_SEVERITY.BLOCKING
        );
        if (blocking.length > 0) {
          row.firstRejectedKickoffMinutes = kickoff;
          row.cappedByKinds = [...answer.bindingKinds];
          row.blockingCodes = [...new Set(blocking.map((finding) => finding.code))].sort();
          row.constraintIds = registry ? registryConstraintIdsFor(registry, row.blockingCodes) : [];
          row.slackMinutes = answer.binding?.slackMinutes ?? null;
          break;
        }

        kickoffMinutes.push(kickoff);
        meta.slotsGenerated += 1;
        if (
          answer.findings.some(
            (finding) => finding.code === AVAILABILITY_REASON.SUNSET_MARGIN_VIOLATED
          )
        ) {
          sunsetWarnedKickoffMinutes.push(kickoff);
        }

        if (condition) {
          // Does the club actually hold this candidate? A candidate whose
          // condition fails is a fact about the day; *held ground* whose
          // condition fails is ground committed to families that cannot be
          // used, and `RESERVED_SLOT_CONDITION_BLOCKED` exists for exactly that
          // difference. Passing this is what makes that code reachable from the
          // production path rather than only from a test that forges the flag.
          const reserved = reservedHere.some((slot) => slot.startMinutes === kickoff);
          const evaluation = evaluateSlotCondition(
            graph,
            {
              id: capacitySlotId(date, surfaceId, kickoff),
              date,
              startMinutes: kickoff,
              endMinutes: answer.endMinutes,
              condition,
            },
            // No ignore list, and none is needed. A candidate cannot be
            // blocked by the booking that *is* that candidate, because
            // `conditionForSurface()` never names the surface its own slot
            // stands on — so nothing on this surface is ever watched, whatever
            // its id. Passing an ignore list here would be a guard that cannot
            // fire, and a guard nothing can make fire proves nothing. What is
            // watched is the *overlapping* ground, and every reservation
            // standing there is exactly what the condition asks about.
            bookings,
            { reserved }
          );
          mergeReserveMeta(meta, evaluation.meta);
          // Every verdict's findings, not only its counters. A number that moves
          // — `available` falling because five slots became undecidable — with
          // no finding to explain it is the hollow-guarantee shape: the count
          // and the findings must be two views of one evaluation rather than a
          // number and a silence.
          findings.push(...evaluation.findings);
          if (evaluation.verdict === CONDITION_VERDICT.SATISFIED) conditionSatisfied += 1;
          else if (evaluation.verdict === CONDITION_VERDICT.BLOCKED) conditionBlocked += 1;
          else conditionUndecidable += 1;
        }
      }

      row.slots = kickoffMinutes.length;
      row.sunsetWarnedSlots = sunsetWarnedKickoffMinutes.length;
      row.conditionSatisfied = conditionSatisfied;
      row.conditionBlocked = conditionBlocked;
      row.conditionUndecidable = conditionUndecidable;

      const grid = new Set(kickoffMinutes);
      for (const slot of reservedHere) {
        if (grid.has(slot.startMinutes)) {
          meta.reservedSlotsMatched += 1;
          continue;
        }
        meta.reservedSlotsOffGrid += 1;
        findings.push(
          makeReserveFinding(
            RESERVE_REASON.RESERVED_SLOT_OFF_GRID,
            `reserved slot "${slot.id}" kicks off at minute ${slot.startMinutes} on ${row.surfaceName}, which is not one of the ${kickoffMinutes.length} slot(s) this model generates for ${date}`,
            {
              slotId: slot.id,
              date,
              surfaceId,
              startMinutes: slot.startMinutes,
              generatedKickoffMinutes: [...kickoffMinutes],
              earliestKickoffMinutes: input.earliestKickoffMinutes,
              cadenceMinutes: input.cadenceMinutes,
            }
          )
        );
      }

      bySurface.push(row);
    }

    dateRows.push(summariseDate(date, bySurface, counted, input));
  }

  const bestSlotsBySurface = bestPerSurface(dateRows);
  for (const dateRow of dateRows) attributeCapping(dateRow, bestSlotsBySurface);

  for (const dateRow of dateRows) findings.push(...dateRow.findings);

  if (meta.datesExamined === 0 || meta.slotsGenerated === 0) {
    findings.push(
      makeReserveFinding(
        RESERVE_REASON.RESERVE_CAPACITY_VACUOUS,
        `this capacity report examined ${meta.datesExamined} date(s) and generated ${meta.slotsGenerated} slot(s), so every requirement it reports as met was met by an empty count`,
        {
          datesExamined: meta.datesExamined,
          surfaceDatesExamined: meta.surfaceDatesExamined,
          candidatesTested: meta.candidatesTested,
          slotsGenerated: meta.slotsGenerated,
        }
      )
    );
  }

  /** @type {Record<string, number>} */
  const slotsByDate = {};
  for (const dateRow of dateRows) slotsByDate[dateRow.date] = dateRow.slots;
  const counts = dateRows.map((dateRow) => dateRow.slots);

  return {
    name: input.name,
    format: input.format,
    requirement: input.requirement,
    cap: input.cap,
    cadenceMinutes: input.cadenceMinutes,
    earliestKickoffMinutes: input.earliestKickoffMinutes,
    dates: dateRows,
    slotsByDate,
    bestSlotsBySurface,
    minSlots: counts.length > 0 ? Math.min(...counts) : null,
    maxSlots: counts.length > 0 ? Math.max(...counts) : null,
    sunsetWarnedSlots: dateRows.reduce((total, dateRow) => total + dateRow.sunsetWarnedSlots, 0),
    bareMinimumDates: dateRows.filter((row) => row.bareMinimum).map((row) => row.date),
    status: deriveReserveStatus(findings),
    findings,
    meta,
  };
}

/**
 * The earliest minute a permit lets anything start at this venue on this date.
 *
 * Which permit record governs a date — the weekday default or a date-scoped
 * exception, and which of two equally-applicable ones wins — is
 * `availability/calendar.js`'s `resolvePermitWindow()` answer and stays its
 * answer. A second reading of the Summit HS rows here would be free to disagree
 * with the first about the 09/12 early open.
 *
 * Returns `0` when there is no usable window, so the caller's stated first
 * kickoff governs and the candidate itself is refused by
 * `checkKickoffAvailability()` with the permit's own reason code — a blackout
 * must be *reported* as the thing that capped the date, not silently skipped.
 *
 * @param {import('../availability/types.js').AvailabilityCalendar} calendar
 * @param {import('../facility/types.js').FacilitySurface|null|undefined} surface
 * @param {string} date
 * @returns {number}
 */
function permitOpenFloor(calendar, surface, date) {
  if (!surface) return 0;
  const resolved = resolvePermitWindow(calendar, { venueId: surface.venueId, date });
  const window = resolved.window;
  if (!window || !window.hasPermit || window.openMinutes === null) return 0;
  return window.openMinutes;
}

/**
 * Fold one date's surfaces into its row, with the requirement and cap verdicts.
 *
 * @param {string} date
 * @param {import('./types.js').SurfaceCapacity[]} bySurface
 * @param {ReadonlyArray<import('./types.js').ReservedSlot>} counted - every reserved slot of this report's format standing on a date it covers, whether or not it covers the ground
 * @param {{ requirement: import('./types.js').CapacityRequirement, cap: import('./types.js').CapacityCap|null }} input
 * @returns {import('./types.js').DateCapacity}
 */
function summariseDate(date, bySurface, counted, input) {
  /** @type {import('./types.js').ReserveFinding[]} */
  const findings = [];

  const conditionalRows = bySurface.filter((row) => row.conditional);
  const unconditionalRows = bySurface.filter((row) => !row.conditional);
  const sum = (rows, field) => rows.reduce((total, row) => total + row[field], 0);

  const unconditionalSlots = sum(unconditionalRows, 'slots');
  const conditionalSlots = sum(conditionalRows, 'slots');
  const conditionSatisfied = sum(conditionalRows, 'conditionSatisfied');
  const conditionBlocked = sum(conditionalRows, 'conditionBlocked');
  const conditionUndecidable = sum(conditionalRows, 'conditionUndecidable');
  const slots = unconditionalSlots + conditionalSlots;
  const available = unconditionalSlots + conditionSatisfied;

  const reservedOnDate = counted.filter((slot) => slot.date === date);
  const reserved = reservedOnDate.length;
  // `slotNamesATeam()`, not `slotIsSettled()`. A Minis session is *settled* —
  // there is nobody left to name — and it assigns no team to anything, so
  // counting it as assigned would report a whole Minis morning as allocated
  // with no team named anywhere. The sibling predicate is adopted rather than a
  // third one invented.
  const assigned = reservedOnDate.filter((slot) => slotNamesATeam(slot)).length;

  const meetsRequirement = slots >= input.requirement.slots;
  const availableMeetsRequirement = available >= input.requirement.slots;
  const bareMinimum = slots === input.requirement.slots;

  const base = {
    date,
    slots,
    unconditionalSlots,
    conditionalSlots,
    available,
    requirement: input.requirement.slots,
    requirementLabel: input.requirement.label,
  };

  if (!meetsRequirement) {
    findings.push(
      makeReserveFinding(
        RESERVE_REASON.RESERVE_CAPACITY_BELOW_REQUIREMENT,
        `${date} holds ${slots} slot(s) against a stated requirement of ${input.requirement.slots} (${input.requirement.label})`,
        base
      )
    );
  } else if (bareMinimum) {
    findings.push(
      makeReserveFinding(
        RESERVE_REASON.RESERVE_CAPACITY_AT_REQUIREMENT,
        `${date} holds exactly the ${input.requirement.slots} slot(s) required (${input.requirement.label}) and not one more`,
        base
      )
    );
  }

  if (meetsRequirement && !availableMeetsRequirement) {
    findings.push(
      makeReserveFinding(
        RESERVE_REASON.RESERVE_CAPACITY_CONDITIONAL_SHORTFALL,
        `${date} counts ${slots} slot(s), but only ${available} of them are actually free once the ${conditionalSlots} conditional slot(s) are checked against what already stands on the overlapping ground`,
        { ...base, conditionBlocked, conditionUndecidable }
      )
    );
  }

  let atCap = false;
  let overCap = false;
  if (input.cap) {
    atCap = reserved === input.cap.limit;
    overCap = reserved > input.cap.limit;
    if (overCap) {
      findings.push(
        makeReserveFinding(
          RESERVE_REASON.RESERVE_CAP_EXCEEDED,
          `${date} reserves ${reserved} slot(s) against a cap of ${input.cap.limit} (${input.cap.label})`,
          { date, reserved, limit: input.cap.limit, source: input.cap.source }
        )
      );
    } else if (atCap) {
      findings.push(
        makeReserveFinding(
          RESERVE_REASON.RESERVE_CAP_REACHED,
          `${date} reserves ${reserved} slot(s), exactly the cap of ${input.cap.limit} (${input.cap.label}); the ${slots - reserved} spare slot(s) are unreservable for that reason, not for a facility one`,
          {
            date,
            reserved,
            limit: input.cap.limit,
            spare: slots - reserved,
            source: input.cap.source,
          }
        )
      );
    }
  }

  return {
    date,
    slots,
    unconditionalSlots,
    conditionalSlots,
    conditionSatisfied,
    conditionBlocked,
    conditionUndecidable,
    available,
    reserved,
    assigned,
    unassigned: reserved - assigned,
    spare: slots - reserved,
    sunsetWarnedSlots: sum(bySurface, 'sunsetWarnedSlots'),
    meetsRequirement,
    availableMeetsRequirement,
    bareMinimum,
    atCap,
    overCap,
    bySurface,
    cappedBy: [],
    findings,
  };
}

/**
 * The most slots each surface offered on any date in this report.
 *
 * This is the reference a date's shortfall is measured against, and it is
 * derived from the report's own dates rather than stated: a season whose ground
 * changes mid-way moves it, which is the correct behaviour.
 *
 * @param {ReadonlyArray<import('./types.js').DateCapacity>} dateRows
 * @returns {Record<string, number>}
 */
function bestPerSurface(dateRows) {
  /** @type {Record<string, number>} */
  const best = {};
  for (const dateRow of dateRows) {
    for (const row of dateRow.bySurface) {
      best[row.surfaceId] = Math.max(best[row.surfaceId] ?? 0, row.slots);
    }
  }
  return best;
}

/**
 * Attribute a date's shortfall to the constraints that caused it.
 *
 * A surface that offered fewer slots than its best day lost them to whatever
 * refused its next candidate kickoff — `availability/kickoff.js`'s binding
 * kinds, consumed rather than recomputed. Where two edges tie for tightest the
 * loss is attributed to both, because the tie is real: relaxing either alone
 * would not add the slot.
 *
 * @param {import('./types.js').DateCapacity} dateRow
 * @param {Record<string, number>} bestSlotsBySurface
 * @returns {void}
 */
function attributeCapping(dateRow, bestSlotsBySurface) {
  /** @type {Map<string, { kind: string, surfaceIds: string[], slotsLostVsBest: number }>} */
  const byKind = new Map();
  for (const row of dateRow.bySurface) {
    const lost = Math.max(0, (bestSlotsBySurface[row.surfaceId] ?? 0) - row.slots);
    for (const kind of row.cappedByKinds) {
      if (!byKind.has(kind)) byKind.set(kind, { kind, surfaceIds: [], slotsLostVsBest: 0 });
      const entry = /** @type {{ kind: string, surfaceIds: string[], slotsLostVsBest: number }} */ (
        byKind.get(kind)
      );
      entry.surfaceIds.push(row.surfaceId);
      entry.slotsLostVsBest += lost;
    }
  }

  dateRow.cappedBy = [...byKind.values()]
    .map((entry) => ({ ...entry, surfaceIds: [...entry.surfaceIds].sort() }))
    .sort((a, b) => b.slotsLostVsBest - a.slotsLostVsBest || a.kind.localeCompare(b.kind));

  if (dateRow.cappedBy.length > 0) {
    dateRow.findings.push(
      makeReserveFinding(
        RESERVE_REASON.RESERVE_CAPACITY_BOUND,
        `${dateRow.date} holds ${dateRow.slots} slot(s), bounded by ${dateRow.cappedBy
          .map((entry) => `${entry.kind} on ${entry.surfaceIds.join(', ')}`)
          .join('; ')}`,
        {
          date: dateRow.date,
          slots: dateRow.slots,
          cappedBy: dateRow.cappedBy.map((entry) => entry.kind),
          slotsLostVsBest: dateRow.cappedBy.map((entry) => entry.slotsLostVsBest),
        }
      )
    );
  }
}
