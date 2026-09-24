/**
 * Bounded local repair for recurring practices (Phase 8.6 PR 3a).
 *
 * > *"a field lost mid-season displaces N practice slots; the repair re-homes
 * > them with the minimum number of published-time changes, reports any it
 * > cannot place as TIME TBD with a reason, and leaves every tracked metric
 * > unchanged or better. Never silently drop an unplaceable slot."*
 *
 * ## Declared, not wired
 *
 * **Nothing in the app calls this.** The live practice scheduler is the Deno
 * twin `supabase/functions/auto-scheduler/`, and a mid-season change today is a
 * re-run of it with only manual assignments locked
 * (`PracticeSchedulingPage.jsx`, `lockedAssignments`). This module is the
 * operator that should replace that re-run; 8.6 PR 3b wires it. Every result
 * carries `PRACTICE_REPAIR_UNWIRED` so that nobody reads a passing test here as
 * a change to what families see.
 *
 * ## What it reuses from `resolve/`, and what it does not
 *
 * - **The objective.** Every candidate is scored by `resolve/objective.js`
 *   `scoreObjective()` with `resolveObjectiveWeights()`; change is counted by
 *   `changeCountsFor()`'s practice arm. This file multiplies nothing.
 * - **The inventory rule.** A series may only go where the published plan (any
 *   revision of it) already put a practice of the same length: `inventory` is
 *   supplied by the caller and nothing here invents a slot.
 * - **Per-instance acceptance (#434).** A coach overlap the published plan
 *   already had with the same counterpart is accepted, not charged again.
 * - **Avoid, allow, warn (#61).** A coach overlap or a worse coach day count is
 *   a compromise counted in the objective and emitted as a warning whether or
 *   not anything else looks at it. A surface clash or a team double-booked is
 *   refused outright.
 * - **Propose, never apply, across venues (#53/#441).** Only same-venue
 *   candidates are placed. A series with none goes TIME TBD and carries up to
 *   three cross-venue options with an `applyAs` the operator may approve.
 * - **The change budget** bounds the search (a cap on published-time changes),
 *   not a report checked afterwards.
 *
 * ## The freeze
 *
 * Only displaced series move. Nothing is bumped and nothing is chained. A
 * displaced series is split, not edited: its assignment is closed the day
 * before the loss and a new assignment starts on the loss date, so every
 * occurrence before the loss materialises exactly as it did.
 *
 * ## Minimality, and when it is claimed
 *
 * The default strategy is an exact branch-and-bound over the displaced series,
 * joint constraints included (two re-homes on clashing ground, one team twice,
 * one coach's days). It returns the objective's optimum when it completes
 * within `searchNodeLimit`; otherwise, and always under `strategy: 'greedy'`, it
 * stamps `PRACTICE_REPAIR_MINIMALITY_UNPROVEN`.
 *
 * The *count* of published-time changes is reported against a lower bound
 * computed separately (series placed, less the most that could keep their
 * time). `stats.timeChangesProvenMinimal` is true only when the two meet; the
 * objective optimum is not assumed to minimise the count, because the
 * objective also weighs drift, day moves and compromises.
 *
 * @module practice/repair
 */

import {
  conflictingSurfacesOf,
  getSurface,
  isoDateOfDayNumber,
  isoDayNumber,
} from '../facility/index.js';
import {
  RESOLVE_OBJECTIVE_TERM,
  changeCountsFor,
  resolveObjectiveWeights,
  scoreObjective,
} from '../resolve/objective.js';
import { PRACTICE_REASON, derivePracticeStatus, makePracticeFinding } from './reasonCodes.js';
import { PracticeRepairInputSchema } from './schemas.js';
import { buildPracticeSlotSet } from './slots.js';

/** Why a displaced series is TIME TBD. */
export const PRACTICE_TBD_REASON = Object.freeze({
  /** No inventory slot at its venue was free and legal even with every other re-home left out. */
  NO_LEGAL_SLOT_AT_VENUE: 'no-legal-slot-at-venue',
  /** It had legal slots, and the optimum gave every one of them to another displaced series. */
  CONTENDED: 'contended',
  /** A legal slot was left free, and taking it would have exceeded the change budget. */
  CHANGE_BUDGET: 'change-budget',
});

const DEFAULT_SEARCH_NODE_LIMIT = 200000;
const MAX_CROSS_VENUE_OPTIONS = 3;

/**
 * @typedef {Object} Series
 * @property {string} assignmentId
 * @property {string} teamId
 * @property {string} slotId
 * @property {string} surfaceId
 * @property {string} weekday
 * @property {number} startMinutes
 * @property {number} durationMinutes
 * @property {string} from
 * @property {string} until
 */

/** @param {string} date @param {number} days @returns {string} */
function shiftDate(date, days) {
  return isoDateOfDayNumber(isoDayNumber(date) + days);
}

/** @returns {string} */
function shapeKey(shape) {
  return `${shape.surfaceId}|${shape.weekday}|${shape.startMinutes}|${shape.durationMinutes}`;
}

/** Same weekday and intersecting clock time. */
function timesOverlap(a, b) {
  return (
    a.weekday === b.weekday &&
    a.startMinutes < b.startMinutes + b.durationMinutes &&
    b.startMinutes < a.startMinutes + a.durationMinutes
  );
}

/** Intersecting date ranges. */
function rangesOverlap(a, b) {
  return a.from <= b.until && b.from <= a.until;
}

/**
 * Re-home the practice series a loss of ground displaces.
 *
 * @param {Object} input - see `PracticeRepairInputSchema`
 * @returns {Object} the repair result; see the module doc and `tests/practiceRepair.test.js`
 */
export function repairPracticeLoss(input) {
  const parsed = PracticeRepairInputSchema.parse(input);
  const { graph } = input;
  const slotSet = buildPracticeSlotSet(parsed.plan);
  const weights = resolveObjectiveWeights(parsed.weights ?? null);
  const lossDate = parsed.loss.from;
  const dayBefore = shiftDate(lossDate, -1);
  const coachesByTeam = parsed.coachesByTeam ?? {};
  const findings = [
    makePracticeFinding(
      PRACTICE_REASON.REPAIR_UNWIRED,
      'Practice repair has no production caller: the live scheduler is the auto-scheduler Edge Function. 8.6 PR 3b wires this.',
      { wiredBy: '8.6 PR 3b' }
    ),
  ];

  /* -- the lost ground ---------------------------------------------------- */
  const lostSurfaceIds = new Set();
  for (const surfaceId of parsed.loss.surfaceIds) {
    if (!getSurface(graph, surfaceId)) {
      findings.push(
        makePracticeFinding(
          PRACTICE_REASON.REPAIR_LOSS_UNKNOWN_SURFACE,
          `The loss names "${surfaceId}", which the facility graph does not hold; nothing on it can be found or repaired.`,
          { surfaceId }
        )
      );
      continue;
    }
    lostSurfaceIds.add(surfaceId);
    for (const blocked of conflictingSurfacesOf(graph, surfaceId)) lostSurfaceIds.add(blocked);
  }

  /** @type {Map<string, Set<string>>} */
  const conflictCache = new Map();
  const conflictsWith = (surfaceId) => {
    let set = conflictCache.get(surfaceId);
    if (!set) {
      set = new Set(getSurface(graph, surfaceId) ? conflictingSurfacesOf(graph, surfaceId) : []);
      set.add(surfaceId);
      conflictCache.set(surfaceId, set);
    }
    return set;
  };
  const venueOf = (surfaceId) => getSurface(graph, surfaceId)?.venueId ?? null;

  /* -- the series in force from the loss date ----------------------------- */
  const slotById = new Map(slotSet.slots.map((slot) => [slot.id, slot]));
  /** @type {Series[]} */
  const active = [];
  const undatedOnLostGround = [];
  for (const assignment of slotSet.assignments) {
    const slot = /** @type {import('./types.js').PracticeSlot} */ (slotById.get(assignment.slotId));
    const from = assignment.effectiveFrom ?? slot.validFrom;
    const until = assignment.effectiveUntil ?? slot.validUntil;
    if (from === null || until === null) {
      if (lostSurfaceIds.has(slot.surfaceId)) undatedOnLostGround.push(assignment.id);
      continue;
    }
    if (until < lossDate) continue;
    active.push({
      assignmentId: assignment.id,
      teamId: assignment.teamId,
      slotId: slot.id,
      surfaceId: slot.surfaceId,
      weekday: slot.weekday,
      startMinutes: slot.startMinutes,
      durationMinutes: slot.durationMinutes,
      from: from < lossDate ? lossDate : from,
      until,
    });
  }
  if (undatedOnLostGround.length > 0) {
    findings.push(
      makePracticeFinding(
        PRACTICE_REASON.REPAIR_SERIES_UNDATED,
        `${undatedOnLostGround.length} series on the lost ground state no dates, so whether the loss displaces them cannot be decided. They are neither moved nor reported TIME TBD.`,
        { assignmentIds: undatedOnLostGround.sort() }
      )
    );
  }
  const displaced = active
    .filter((series) => lostSurfaceIds.has(series.surfaceId))
    .sort((a, b) => a.assignmentId.localeCompare(b.assignmentId));
  const displacedIds = new Set(displaced.map((series) => series.assignmentId));
  const frozen = active.filter((series) => !displacedIds.has(series.assignmentId));

  /* -- coaches ------------------------------------------------------------ */
  const coachesOf = (teamId) => coachesByTeam[teamId] ?? [];
  /** Days each coach practised on, from the loss date, in the published plan. */
  const publishedCoachDays = new Map();
  for (const series of active) {
    for (const coach of coachesOf(series.teamId)) {
      if (!publishedCoachDays.has(coach)) publishedCoachDays.set(coach, new Set());
      publishedCoachDays.get(coach).add(series.weekday);
    }
  }
  const frozenCoachDays = new Map();
  for (const series of frozen) {
    for (const coach of coachesOf(series.teamId)) {
      if (!frozenCoachDays.has(coach)) frozenCoachDays.set(coach, new Set());
      frozenCoachDays.get(coach).add(series.weekday);
    }
  }
  const sharesCoach = (teamA, teamB) => {
    if (teamA === teamB) return [];
    const b = new Set(coachesOf(teamB));
    return coachesOf(teamA).filter((coach) => b.has(coach));
  };
  /** Coach overlaps the published plan already had, per instance (#434). */
  const acceptedOverlap = new Set();
  for (let i = 0; i < active.length; i += 1) {
    for (let j = i + 1; j < active.length; j += 1) {
      const a = active[i];
      const b = active[j];
      if (!timesOverlap(a, b) || !rangesOverlap(a, b)) continue;
      for (const coach of sharesCoach(a.teamId, b.teamId)) {
        acceptedOverlap.add(`${coach}|${a.assignmentId}|${b.assignmentId}`);
        acceptedOverlap.add(`${coach}|${b.assignmentId}|${a.assignmentId}`);
      }
    }
  }

  /* -- candidates --------------------------------------------------------- */
  const inventory = new Map();
  for (const shape of parsed.inventory) {
    if (!getSurface(graph, shape.surfaceId)) continue;
    if (lostSurfaceIds.has(shape.surfaceId)) continue;
    inventory.set(shapeKey(shape), shape);
  }
  const inventoryShapes = [...inventory.values()].sort((a, b) =>
    shapeKey(a).localeCompare(shapeKey(b))
  );

  /**
   * Whether `shape` is free of every frozen series over `series`' range, and
   * what it costs against them. `null` when refused.
   */
  const againstFrozen = (series, shape) => {
    const placed = { ...shape, from: series.from, until: series.until };
    const overlaps = [];
    for (const other of frozen) {
      if (!rangesOverlap(placed, other) || !timesOverlap(placed, other)) continue;
      if (conflictsWith(shape.surfaceId).has(other.surfaceId)) return null;
      if (other.teamId === series.teamId) return null;
      for (const coach of sharesCoach(series.teamId, other.teamId)) {
        if (acceptedOverlap.has(`${coach}|${series.assignmentId}|${other.assignmentId}`)) continue;
        overlaps.push({ coach, withAssignmentId: other.assignmentId, withTeamId: other.teamId });
      }
    }
    return overlaps;
  };

  const tbdCost = scoreObjective({ [RESOLVE_OBJECTIVE_TERM.UNPLACED_GAME]: 1 }, weights).total;
  const candidatesBySeries = displaced.map((series) => {
    const same = [];
    const cross = [];
    for (const shape of inventoryShapes) {
      if (shape.durationMinutes !== series.durationMinutes) continue;
      const overlaps = againstFrozen(series, shape);
      if (overlaps === null) continue;
      const counts = changeCountsFor(series, shape);
      // Standalone: would this slot give one of the team's coaches a day the
      // frozen plan does not already have, past the published count? Recorded
      // for the ratio measurement only; the search counts it jointly.
      const standaloneWorsened = coachesOf(series.teamId).filter((coach) => {
        const days = frozenCoachDays.get(coach) ?? new Set();
        return (
          !days.has(shape.weekday) && days.size + 1 > (publishedCoachDays.get(coach)?.size ?? 0)
        );
      }).length;
      const entry = {
        shape,
        counts,
        frozenOverlaps: overlaps,
        carriesCompromise: overlaps.length + standaloneWorsened > 0,
        timeChanged: (counts[RESOLVE_OBJECTIVE_TERM.CHANGED_GAME] ?? 0) === 1,
        weekdayChanged: (counts[RESOLVE_OBJECTIVE_TERM.CHANGED_WEEKDAY] ?? 0) === 1,
        cost: scoreObjective(
          { ...counts, [RESOLVE_OBJECTIVE_TERM.COMPROMISE_VIOLATION]: overlaps.length },
          weights
        ).total,
      };
      (venueOf(shape.surfaceId) === venueOf(series.surfaceId) ? same : cross).push(entry);
    }
    const order = (a, b) => a.cost - b.cost || shapeKey(a.shape).localeCompare(shapeKey(b.shape));
    return { series, same: same.sort(order), cross: cross.sort(order) };
  });

  /* -- the search --------------------------------------------------------- */
  const budget = parsed.changeBudget ?? null;
  const nodeLimit = parsed.searchNodeLimit ?? DEFAULT_SEARCH_NODE_LIMIT;
  const strategy = parsed.strategy ?? 'exact';
  // Most constrained first; stable by assignment id.
  const order = candidatesBySeries
    .map((entry, index) => ({ entry, index }))
    .sort(
      (a, b) =>
        a.entry.same.length - b.entry.same.length ||
        a.entry.series.assignmentId.localeCompare(b.entry.series.assignmentId)
    );

  /**
   * The marginal cost of putting `candidate` for `series` on top of `placed`
   * (an array of `{ series, candidate }`), or `null` when refused.
   */
  const marginal = (series, candidate, placed, coachDays) => {
    const shape = { ...candidate.shape, from: series.from, until: series.until };
    let overlaps = candidate.frozenOverlaps.length;
    const newOverlaps = [];
    for (const other of placed) {
      if (other.candidate === null) continue;
      const otherShape = {
        ...other.candidate.shape,
        from: other.series.from,
        until: other.series.until,
      };
      if (!rangesOverlap(shape, otherShape) || !timesOverlap(shape, otherShape)) continue;
      if (conflictsWith(shape.surfaceId).has(otherShape.surfaceId)) return null;
      if (other.series.teamId === series.teamId) return null;
      for (const coach of sharesCoach(series.teamId, other.series.teamId)) {
        if (acceptedOverlap.has(`${coach}|${series.assignmentId}|${other.series.assignmentId}`))
          continue;
        overlaps += 1;
        newOverlaps.push({
          coach,
          withAssignmentId: other.series.assignmentId,
          withTeamId: other.series.teamId,
        });
      }
    }
    let worsened = 0;
    for (const coach of coachesOf(series.teamId)) {
      const days = coachDays.get(coach) ?? new Set();
      if (days.has(shape.weekday)) continue;
      const published = publishedCoachDays.get(coach)?.size ?? 0;
      // Worsening is counted only past the published count, and adding a day
      // raises the count by one, so the marginal is 1 exactly when this day
      // takes the coach past it.
      if (days.size + 1 > published) worsened += 1;
    }
    const counts = {
      ...candidate.counts,
      [RESOLVE_OBJECTIVE_TERM.COMPROMISE_VIOLATION]: overlaps + worsened,
    };
    return { cost: scoreObjective(counts, weights).total, newOverlaps, worsened };
  };

  const coachDaysAfter = (coachDays, series, candidate) => {
    const next = new Map(coachDays);
    for (const coach of coachesOf(series.teamId)) {
      const days = new Set(next.get(coach) ?? []);
      days.add(candidate.shape.weekday);
      next.set(coach, days);
    }
    return next;
  };

  const baseCoachDays = new Map(
    [...frozenCoachDays].map(([coach, days]) => [coach, new Set(days)])
  );
  const timeChangeOf = (candidate) => (candidate !== null && candidate.timeChanged ? 1 : 0);

  // Greedy: in search order, each series takes its cheapest admissible slot.
  const greedy = () => {
    const placed = [];
    let coachDays = baseCoachDays;
    let cost = 0;
    let timeChanges = 0;
    for (const { entry } of order) {
      let best = null;
      for (const candidate of entry.same) {
        if (budget !== null && timeChanges + timeChangeOf(candidate) > budget) continue;
        const m = marginal(entry.series, candidate, placed, coachDays);
        if (m === null) continue;
        if (best === null || m.cost < best.m.cost) best = { candidate, m };
      }
      if (best === null || best.m.cost >= tbdCost) {
        placed.push({ series: entry.series, candidate: null });
        cost += tbdCost;
      } else {
        placed.push({ series: entry.series, candidate: best.candidate });
        coachDays = coachDaysAfter(coachDays, entry.series, best.candidate);
        cost += best.m.cost;
        timeChanges += timeChangeOf(best.candidate);
      }
    }
    return { placed, cost };
  };

  let incumbent = greedy();
  let nodes = 0;
  let exhausted = true;
  if (strategy === 'exact') {
    // Admissible bound: each remaining series at its cheapest standalone cost.
    const standalone = order.map(({ entry }) =>
      Math.min(tbdCost, ...entry.same.map((candidate) => candidate.cost))
    );
    const suffix = new Array(order.length + 1).fill(0);
    for (let k = order.length - 1; k >= 0; k -= 1) suffix[k] = suffix[k + 1] + standalone[k];
    const placed = [];
    const walk = (depth, cost, coachDays, timeChanges) => {
      if (!exhausted) return;
      nodes += 1;
      if (nodes > nodeLimit) {
        exhausted = false;
        return;
      }
      if (cost + suffix[depth] >= incumbent.cost) return;
      if (depth === order.length) {
        incumbent = { placed: [...placed], cost };
        return;
      }
      const { entry } = order[depth];
      const options = [];
      for (const candidate of entry.same) {
        if (budget !== null && timeChanges + timeChangeOf(candidate) > budget) continue;
        const m = marginal(entry.series, candidate, placed, coachDays);
        if (m !== null) options.push({ candidate, cost: m.cost });
      }
      options.sort((a, b) => a.cost - b.cost);
      for (const option of options) {
        placed.push({ series: entry.series, candidate: option.candidate });
        walk(
          depth + 1,
          cost + option.cost,
          coachDaysAfter(coachDays, entry.series, option.candidate),
          timeChanges + timeChangeOf(option.candidate)
        );
        placed.pop();
        if (!exhausted) return;
      }
      placed.push({ series: entry.series, candidate: null });
      walk(depth + 1, cost + tbdCost, coachDays, timeChanges);
      placed.pop();
    };
    walk(0, 0, baseCoachDays, 0);
  }
  const provenOptimal = strategy === 'exact' && exhausted;
  if (!provenOptimal) {
    findings.push(
      makePracticeFinding(
        PRACTICE_REASON.REPAIR_MINIMALITY_UNPROVEN,
        strategy === 'greedy'
          ? 'Greedy repair: each series took its cheapest slot in turn. Nothing proves no better repair exists.'
          : `The exact search stopped at its ${nodeLimit}-node limit. The repair returned is the best found, not a proven optimum.`,
        { strategy, nodes, nodeLimit }
      )
    );
  }

  /* -- read the chosen repair back, in series order ----------------------- */
  const chosenById = new Map(incumbent.placed.map((p) => [p.series.assignmentId, p.candidate]));
  const finalPlaced = [];
  let coachDays = baseCoachDays;
  const warnings = { overlaps: [], worsenedCoaches: new Set() };
  for (const { entry } of order) {
    const candidate = chosenById.get(entry.series.assignmentId) ?? null;
    if (candidate !== null) {
      const m = /** @type {NonNullable<ReturnType<typeof marginal>>} */ (
        marginal(entry.series, candidate, finalPlaced, coachDays)
      );
      for (const overlap of [...candidate.frozenOverlaps, ...m.newOverlaps]) {
        warnings.overlaps.push({
          ...overlap,
          assignmentId: entry.series.assignmentId,
          teamId: entry.series.teamId,
        });
      }
      coachDays = coachDaysAfter(coachDays, entry.series, candidate);
    }
    finalPlaced.push({ series: entry.series, candidate });
  }

  const rehomed = [];
  const timeTbd = [];
  const newSlots = [];
  const splitAssignments = new Map();
  const newAssignments = [];
  for (const { series, candidate } of finalPlaced.sort((a, b) =>
    a.series.assignmentId.localeCompare(b.series.assignmentId)
  )) {
    splitAssignments.set(series.assignmentId, series);
    if (candidate !== null) {
      const slotId = `${series.slotId}~repair@${lossDate}#${series.assignmentId}`;
      newSlots.push({
        id: slotId,
        surfaceId: candidate.shape.surfaceId,
        weekday: candidate.shape.weekday,
        startMinutes: candidate.shape.startMinutes,
        durationMinutes: candidate.shape.durationMinutes,
        validFrom: series.from,
        validUntil: series.until,
        capacity: 1,
        revisionId: slotById.get(series.slotId)?.revisionId ?? null,
        label: `repair of ${series.slotId} from ${lossDate}`,
        surfaceResolution: 'resolved',
      });
      newAssignments.push({
        id: `${series.assignmentId}~repair@${lossDate}`,
        slotId,
        teamId: series.teamId,
        effectiveFrom: series.from,
        effectiveUntil: series.until,
      });
      const entry = {
        assignmentId: series.assignmentId,
        teamId: series.teamId,
        from: {
          surfaceId: series.surfaceId,
          weekday: series.weekday,
          startMinutes: series.startMinutes,
        },
        to: { ...candidate.shape },
        effectiveFrom: series.from,
        publishedTimeChanged: candidate.timeChanged,
        weekdayChanged: candidate.weekdayChanged,
        locationChanged: candidate.shape.surfaceId !== series.surfaceId,
        counts: { ...candidate.counts },
      };
      rehomed.push(entry);
      findings.push(
        makePracticeFinding(
          PRACTICE_REASON.REPAIR_REHOMED,
          `${series.teamId}: ${series.weekday} ${series.startMinutes} on ${series.surfaceId} -> ${candidate.shape.weekday} ${candidate.shape.startMinutes} on ${candidate.shape.surfaceId} from ${series.from}${candidate.timeChanged ? ' (published time changed)' : ' (same published time)'}`,
          {
            assignmentId: series.assignmentId,
            teamId: series.teamId,
            publishedTimeChanged: candidate.timeChanged,
          }
        )
      );
    } else {
      const entry = candidatesBySeries.find((c) => c.series.assignmentId === series.assignmentId);
      const occupied = finalPlaced.filter(
        (p) => p.candidate !== null && p.series.assignmentId !== series.assignmentId
      );
      const freeNow = entry.same.filter(
        (candidate) => marginal(series, candidate, occupied, coachDays) !== null
      );
      let reason;
      if (entry.same.length === 0) reason = PRACTICE_TBD_REASON.NO_LEGAL_SLOT_AT_VENUE;
      else if (freeNow.length > 0) reason = PRACTICE_TBD_REASON.CHANGE_BUDGET;
      else reason = PRACTICE_TBD_REASON.CONTENDED;
      const crossVenueOptions = entry.cross
        .filter((candidate) => marginal(series, candidate, occupied, coachDays) !== null)
        .slice(0, MAX_CROSS_VENUE_OPTIONS)
        .map((candidate) => {
          const optionId = `${series.assignmentId}->${shapeKey(candidate.shape)}`;
          return {
            optionId,
            to: { ...candidate.shape },
            toVenueId: venueOf(candidate.shape.surfaceId),
            objective: { total: candidate.cost, counts: { ...candidate.counts } },
            applyAs: {
              assignmentId: series.assignmentId,
              teamId: series.teamId,
              ...candidate.shape,
              effectiveFrom: series.from,
              effectiveUntil: series.until,
              reason: `approved cross-venue option ${optionId}`,
            },
          };
        });
      timeTbd.push({
        assignmentId: series.assignmentId,
        teamId: series.teamId,
        from: {
          surfaceId: series.surfaceId,
          weekday: series.weekday,
          startMinutes: series.startMinutes,
        },
        reason,
        sameVenueCandidates: entry.same.length,
        crossVenueOptions,
      });
      findings.push(
        makePracticeFinding(
          PRACTICE_REASON.REPAIR_TIME_TBD,
          `${series.teamId}: the ${series.weekday} ${series.startMinutes} practice on ${series.surfaceId} is TIME TBD from ${series.from} (${reason}); ${crossVenueOptions.length} cross-venue option(s) offered for approval.`,
          {
            assignmentId: series.assignmentId,
            teamId: series.teamId,
            reason,
            crossVenueOptions: crossVenueOptions.length,
          }
        )
      );
    }
  }

  /* -- warnings: every compromise named ----------------------------------- */
  const coachDayRows = [];
  for (const [coach, days] of [...coachDays].sort((a, b) => a[0].localeCompare(b[0]))) {
    const before = publishedCoachDays.get(coach)?.size ?? 0;
    if (days.size > before) {
      coachDayRows.push({ coach, before, after: days.size });
      findings.push(
        makePracticeFinding(
          PRACTICE_REASON.REPAIR_COACH_DAYS_WORSENED,
          `Coach ${coach} now practises on ${days.size} days, up from ${before} in the published plan.`,
          { coach, before, after: days.size }
        )
      );
    }
  }
  for (const overlap of warnings.overlaps) {
    findings.push(
      makePracticeFinding(
        PRACTICE_REASON.REPAIR_COACH_OVERLAP_CARRIED,
        `Coach ${overlap.coach} has ${overlap.teamId} and ${overlap.withTeamId} practising at the same time after the repair.`,
        overlap
      )
    );
  }
  if (displaced.length === 0) {
    findings.push(
      makePracticeFinding(
        PRACTICE_REASON.REPAIR_NOTHING_DISPLACED,
        `The loss of ${[...parsed.loss.surfaceIds].join(', ')} from ${lossDate} displaced no dated series. Nothing was repaired; that is not the same as a repair that succeeded.`,
        { surfaceIds: [...parsed.loss.surfaceIds], activeSeries: active.length }
      )
    );
  }

  /* -- the repaired plan: split, never edited ----------------------------- */
  const repairedSlots = [];
  for (const slot of slotSet.slots) {
    const onLost =
      lostSurfaceIds.has(slot.surfaceId) && slot.validFrom !== null && slot.validUntil !== null;
    if (onLost && slot.validUntil >= lossDate) {
      if (slot.validFrom >= lossDate) continue; // the whole slot is lost ground
      repairedSlots.push({ ...slot, validUntil: dayBefore });
    } else repairedSlots.push({ ...slot });
  }
  const keptSlotIds = new Set(repairedSlots.map((slot) => slot.id));
  const repairedAssignments = [];
  for (const assignment of slotSet.assignments) {
    const split = splitAssignments.get(assignment.id);
    if (!split) {
      repairedAssignments.push({ ...assignment });
      continue;
    }
    const slot = /** @type {import('./types.js').PracticeSlot} */ (slotById.get(assignment.slotId));
    const from = assignment.effectiveFrom ?? slot.validFrom;
    if (from < lossDate && keptSlotIds.has(assignment.slotId)) {
      repairedAssignments.push({ ...assignment, effectiveFrom: from, effectiveUntil: dayBefore });
    }
  }
  const repairedPlan = buildPracticeSlotSet({
    slots: [...repairedSlots, ...newSlots],
    assignments: [...repairedAssignments, ...newAssignments],
    source: slotSet.source,
  });

  /* -- the published-time lower bound ------------------------------------- */
  // Series placed, less the most of them that could keep their time: a maximum
  // bipartite matching over same-time candidates, ignoring clashes between
  // different candidates (so it over-counts the keepers and the bound stays a
  // lower bound).
  const placedIds = new Set(rehomed.map((entry) => entry.assignmentId));
  const sameTime = candidatesBySeries
    .filter((entry) => placedIds.has(entry.series.assignmentId))
    .map((entry) =>
      entry.same.filter((candidate) => !candidate.timeChanged).map((c) => shapeKey(c.shape))
    );
  const matchOf = new Map();
  const augment = (i, seen) => {
    for (const key of sameTime[i]) {
      if (seen.has(key)) continue;
      seen.add(key);
      if (!matchOf.has(key) || augment(matchOf.get(key), seen)) {
        matchOf.set(key, i);
        return true;
      }
    }
    return false;
  };
  let keepers = 0;
  for (let i = 0; i < sameTime.length; i += 1) if (augment(i, new Set())) keepers += 1;
  const publishedTimeChanges = rehomed.filter((entry) => entry.publishedTimeChanged).length;
  const timeChangeLowerBound = rehomed.length - keepers;

  const stats = {
    activeSeries: active.length,
    displaced: displaced.length,
    rehomed: rehomed.length,
    timeTbd: timeTbd.length,
    publishedTimeChanges,
    weekdayChanges: rehomed.filter((entry) => entry.weekdayChanged).length,
    locationChanges: rehomed.filter((entry) => entry.locationChanged).length,
    publishedTimeHeld: active.length - publishedTimeChanges - timeTbd.length,
    timeChangeLowerBound,
    timeChangesProvenMinimal: publishedTimeChanges === timeChangeLowerBound,
    coachDaysWorsened: coachDayRows.length,
    coachOverlapsCarried: warnings.overlaps.length,
    objectiveTotal: incumbent.cost,
    strategy,
    provenOptimal,
    searchNodes: nodes,
    undatedOnLostGround: undatedOnLostGround.length,
    // The 100:1 compromise:drift ratio can only decide something if a scored
    // candidate carries a compromise. Counted over same-venue candidates, the
    // only ones the search places.
    candidatesScored: candidatesBySeries.reduce((sum, entry) => sum + entry.same.length, 0),
    candidatesWithCompromise: candidatesBySeries.reduce(
      (sum, entry) => sum + entry.same.filter((candidate) => candidate.carriesCompromise).length,
      0
    ),
  };

  return {
    status: derivePracticeStatus(findings),
    lossDate,
    rehomed,
    timeTbd,
    coachDays: coachDayRows,
    plan: repairedPlan,
    findings,
    stats,
  };
}
