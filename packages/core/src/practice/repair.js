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
 *   candidates are placed. A series with none goes TIME TBD, and the joint
 *   cross-venue search (tier 2, below) may recommend it a move to another
 *   venue, which an operator enacts as an approved option or does not.
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
 * ## Bounded losses: a temporary override (8.6 PR 3b plan §1)
 *
 * A loss with `until` (a blackout) is not split. It ends, so splitting it
 * would move every occurrence after it too. The result says
 * `representation: 'override'`, and every re-homed and TIME TBD entry carries
 * the series-window it covers: `window: { from, until }`, the series' own range
 * intersected with `[loss.from, loss.until]`. The original series stays whole
 * and locked. Only `plan`, the repaired plan held in memory, splits it around
 * the window, so that it materialises correctly and the metrics stay
 * series-based. A loss with no `until` (a retirement) splits as before and
 * says `representation: 'split'`; its result is otherwise unchanged.
 *
 * A series is displaced when its range, intersected with the loss window, holds
 * an occurrence on its weekday, and its time meets the loss minutes if there
 * are any. Frozen series occupy their ground inside that window only: ground a
 * frozen series holds before `from` or after `until` is free for a re-home.
 * The lost ground itself is never offered as a re-home, even outside the loss
 * minutes.
 *
 * ## Coach preferences (8.6 PR 3b plan §4)
 *
 * Approved preferences and the `team_coach_assignments` rows are input data
 * (`coachPreferences`, `teamCoachAssignments`); loading them is PR 9's. The
 * meaning is `practice/coachPreferences.js`'s, reused rather than restated: for
 * each displaced series, its team's CURRENT coaches are the rows that cover the
 * date the repair takes effect for that series (`coachesOfTeamOn()` on the
 * series-window's first day), strictest wins among them, and the reference is
 * the preference's `value` when it has one, else the series being moved
 * ("keep what I have").
 * Venue is the location: the facility graph's `venueId`, which must then be the
 * location id.
 *
 * - `must_keep` is a hard candidate filter, same-venue and cross-venue alike.
 *   A series that had legal same-venue candidates and has none after the
 *   filter is TIME TBD with `PRACTICE_TBD_REASON.COACH_PREFERENCE`, never
 *   dropped; `mustKeepDimensions` names what emptied its venue.
 * - **An approved `value` is honoured** (operator ruling, 2026-09-28):
 *   `must_keep weekday=TUE` on a team now on Wednesday lands only on a
 *   Tuesday, or is TIME TBD `coach-preference`. Two `must_keep` references
 *   that differ make every candidate violate the dimension, and
 *   `PRACTICE_COACH_PREFERENCE_CONFLICT` says why.
 * - `prefer_keep` is priced: each breached dimension is one
 *   `coachPreferenceBreached` in the candidate's counts, weighed by the one
 *   objective like every other term.
 * - **No preferences, no effect.** With none supplied (or none that resolve to
 *   a reference) nothing here runs and the result is byte-identical to a
 *   repair that was never handed them.
 *
 * ## Recommendations: two tiers, one per series-window (8.6 PR 3b plan §2)
 *
 * Every displaced series-window gets exactly one entry in `recommendations`,
 * a placement or TIME TBD with a reason (plan §5, decision 5):
 *
 * 1. **Tier 1** is the exact same-venue search below, unchanged. What it
 *    places is `rehomed` and is in `plan`, exactly as before.
 * 2. **Tier 2** is a joint exact search over the cross-venue candidates of the
 *    series tier 1 left TIME TBD, with every tier-1 placement a frozen
 *    occupant. It is the same search and the same `marginal()` as tier 1, so
 *    two recommendations clash by the repair's own definition or not at all:
 *    no two of them name conflicting ground at an overlapping time, and none
 *    lands on a tier-1 placement. `must_keep` filters its candidates and
 *    `prefer_keep` is priced, as in tier 1. It replaces #441's standalone
 *    cross-venue options and their `sharedWith`, which named competing
 *    offers instead of resolving them. A tier-2 recommendation is never
 *    placed: its series stays in `timeTbd` and out of `plan` until it is
 *    enacted, with `origin: 'approved-option'` (PR 11).
 * 3. The rest is TIME TBD with tier 1's reason, never dropped.
 *
 * Tier 2 visits at most `searchNodeLimit` nodes of its own. Past that it
 * returns the best it found (seeded by its greedy pass, so still clash-free)
 * and stamps `PRACTICE_REPAIR_MINIMALITY_UNPROVEN` with `tier: 'cross-venue'`;
 * `recommendationSearch` says which. Declines and the re-offer chain are
 * `practice/recommendations.js`.
 *
 * ## Daylight: a candidate gate (8.9 PR 7)
 *
 * Given a daylight provider (`calendar`, an `availability/calendar.js`
 * calendar), every re-home candidate -- tier 1 and tier 2 alike -- is judged
 * before it is priced. Its occurrences over the series-window (its weekday,
 * every week, `[from, until]`) go to `practice/daylight.js`
 * `evaluatePracticeDaylight()`, the one evaluator, so the contract is its own:
 * lit ground is exempt, undeclared lighting is unlit (D5), a practice ending
 * exactly at `floor(sunset)` is legal (margin 0; D2, D6), and an unknown
 * sunset is never allowed (D4). A candidate with any occurrence past sunset
 * is refused `past-sunset`; else one with any unknown date is refused
 * `sunset-unknown`. The refusal is counted and listed in `daylight`, and named
 * per series by `PRACTICE_REPAIR_CANDIDATES_PAST_SUNSET` /
 * `PRACTICE_REPAIR_CANDIDATES_SUNSET_UNKNOWN`.
 *
 * - **Refused, not truncated.** D8's truncation (legal early, TIME TBD from
 *   the first illegal date) is the Edge post-pass's (8.9 PR 6). Here one
 *   series-window gets exactly one recommendation (3b plan §5, decision 5),
 *   and a candidate legal for part of the window is not a placement for it.
 * - **The gate runs before `must_keep`.** A candidate past sunset is not
 *   legal, so a series whose venue had frozen-free candidates and every one
 *   was refused by daylight is TIME TBD `past-sunset` (or `sunset-unknown`
 *   when any refusal was unknown: coordinates could make one legal), never
 *   `coach-preference` and never dropped.
 * - **No calendar, no gate.** Without one nothing is judged against sunset,
 *   and `PRACTICE_REPAIR_DAYLIGHT_UNCHECKED` says so on the result. With a
 *   calendar on which every candidate is lit, the result is identical to one
 *   without, less that finding and the `daylight` block
 *   (`tests/practiceRepairDaylight.test.js`).
 *
 * Enforced in this module; **not live** until 8.6 3b PRs 9-11 wire the
 * repair, like everything else here.
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
import { coachesOfTeamOn } from '../people/assignmentHistory.js';
import {
  RESOLVE_CHANGE_TERMS,
  RESOLVE_OBJECTIVE_TERM,
  RESOLVE_OBJECTIVE_WEIGHTS,
  RESOLVE_PRACTICE_CHANGE_TERMS,
  changeCountsFor,
  coachPreferenceCountsFor,
  objectiveWeightsAreDefault,
  resolveObjectiveWeights,
  scoreObjective,
} from '../resolve/objective.js';
import {
  COACH_PREFERENCE_LEVEL,
  CoachPreferenceInputSchema,
  CoachPreferencePlacementSchema,
  judgeCoachPreferenceCandidate,
  resolveCoachPreferences,
} from './coachPreferences.js';
import { PRACTICE_REASON, derivePracticeStatus, makePracticeFinding } from './reasonCodes.js';
import { CHANGE_ORIGIN } from '../resolve/schemas.js';
import { PracticeRepairInputSchema } from './schemas.js';
import { buildPracticeSlotSet, firstWeekdayOnOrAfter } from './slots.js';
import { PRACTICE_SUNSET_MARGIN_MINUTES, evaluatePracticeDaylight } from './daylight.js';
import { AVAILABILITY_REASON } from '../availability/reasonCodes.js';

/** Why a displaced series is TIME TBD. */
export const PRACTICE_TBD_REASON = Object.freeze({
  /** No inventory slot at its venue was free and legal even with every other re-home left out. */
  NO_LEGAL_SLOT_AT_VENUE: 'no-legal-slot-at-venue',
  /** It had legal slots, and the optimum gave every one of them to another displaced series. */
  CONTENDED: 'contended',
  /** A legal slot was left free, and taking it would have exceeded the change budget. */
  CHANGE_BUDGET: 'change-budget',
  /**
   * A legal slot was left free with no budget in force: the caller's weights
   * priced placing it at or above leaving it TIME TBD.
   */
  OBJECTIVE_PREFERRED_TBD: 'objective-preferred-tbd',
  /**
   * It had legal slots at its venue, and every one of them breaks a `must_keep`
   * coach preference (8.6 PR 3b plan §4).
   */
  COACH_PREFERENCE: 'coach-preference',
  /**
   * Its recommendation was declined, and nothing it had not declined was free
   * and admissible for it afterwards (plan §2, `practice/recommendations.js`).
   */
  DECLINED: 'declined',
  /**
   * It had frozen-free candidates at its venue, and the daylight gate refused
   * every one: each runs past `floor(sunset)` on unlit or undeclared ground on
   * some date of its window (8.9 PR 7).
   */
  PAST_SUNSET: 'past-sunset',
  /**
   * As `PAST_SUNSET`, but at least one refusal was an unknown sunset (no table
   * record, no coordinates): never read as allowed (D4), and coordinates
   * could make a candidate legal.
   */
  SUNSET_UNKNOWN: 'sunset-unknown',
});

const DEFAULT_SEARCH_NODE_LIMIT = 200000;
/** What `coachPreferences.js` accepts as a location id: its contract, not a copy. */
const LocationIdSchema = CoachPreferencePlacementSchema.shape.locationId;

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

/**
 * The one spelling of a slot shape, shared with `recommendations.js`.
 *
 * @returns {string}
 */
export function shapeKey(shape) {
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
 * Everything the repair decides with, before it searches: the displaced
 * series, their priced candidates, the search order, `marginal()` and the
 * joint search. `repairPracticeLoss()` runs both tiers on it, and
 * `practice/recommendations.js` re-offers declined slots through the same
 * `marginal()`, so a clash means one thing in both. Internal: not in the barrel.
 *
 * @param {Object} input - see `PracticeRepairInputSchema`
 */
export function buildPracticeRepairContext(input) {
  const parsed = PracticeRepairInputSchema.parse(input);
  const { graph } = input;
  const slotSet = buildPracticeSlotSet(parsed.plan);
  const weights = resolveObjectiveWeights(parsed.weights ?? null);
  const lossDate = parsed.loss.from;
  const dayBefore = shiftDate(lossDate, -1);
  // A blackout ends; a retirement does not (plan §1).
  const lossUntil = parsed.loss.until ?? null;
  const bounded = lossUntil !== null;
  const lossMinutes =
    parsed.loss.startMinutes === undefined
      ? null
      : { start: parsed.loss.startMinutes, end: /** @type {number} */ (parsed.loss.endMinutes) };
  /** Whether a slot's clock time meets the loss minutes; always, when it states none. */
  const hitsLossMinutes = (slot) =>
    lossMinutes === null ||
    (slot.startMinutes < lossMinutes.end &&
      lossMinutes.start < slot.startMinutes + slot.durationMinutes);
  const coachesByTeam = parsed.coachesByTeam ?? {};
  const lossReason = parsed.loss.reason;
  const findings = [
    makePracticeFinding(
      PRACTICE_REASON.REPAIR_UNWIRED,
      'Practice repair has no production caller: the live scheduler is the auto-scheduler Edge Function. 8.6 PR 3b wires this.',
      { wiredBy: '8.6 PR 3b' }
    ),
  ];

  // The sibling contract (`resolve.js`): a run scored under other weights says
  // so, naming the terms; a zeroed change term — which undoes the freeze —
  // says so at compromise, so it can never pass for an ordinary repair.
  if (!objectiveWeightsAreDefault(weights)) {
    const overridden = Object.keys(RESOLVE_OBJECTIVE_WEIGHTS)
      .filter((term) => weights[term] !== RESOLVE_OBJECTIVE_WEIGHTS[term])
      .sort();
    findings.push(
      makePracticeFinding(
        PRACTICE_REASON.REPAIR_WEIGHTS_OVERRIDDEN,
        `This repair was scored under caller-supplied weights (${overridden.join(', ')}), not the defaults; it is not comparable with a default run.`,
        { overridden, weights: { ...weights } }
      )
    );
    const disabled = [...RESOLVE_CHANGE_TERMS, ...RESOLVE_PRACTICE_CHANGE_TERMS].filter(
      (term) => weights[term] === 0
    );
    if (disabled.length > 0) {
      findings.push(
        makePracticeFinding(
          PRACTICE_REASON.REPAIR_CHANGE_TERM_DISABLED,
          `Change terms weighted zero (${disabled.join(', ')}): this repair does not prefer keeping published practices where they were.`,
          { disabled }
        )
      );
    }
  }

  /* -- the daylight gate (8.9 PR 7) ---------------------------------------- */
  // Shape-checked like `graph`; the raw calendar is what the evaluator reads.
  const calendar = parsed.calendar === undefined ? null : input.calendar;
  if (calendar === null) {
    findings.push(
      makePracticeFinding(
        PRACTICE_REASON.REPAIR_DAYLIGHT_UNCHECKED,
        'No daylight calendar was supplied, so no re-home candidate was judged against sunset. This is not a daylight pass.',
        { wiredBy: '8.6 PR 3b' }
      )
    );
  }
  /** What the gate judged, refused and why: the caller's meta-assertion. */
  const daylight = {
    checked: calendar !== null,
    marginMinutes: PRACTICE_SUNSET_MARGIN_MINUTES,
    candidatesJudged: 0,
    occurrencesExamined: 0,
    candidatesLitExempt: 0,
    candidatesWithNoOccurrence: 0,
    candidatesWithinDaylight: 0,
    candidatesRefusedPastSunset: 0,
    candidatesRefusedSunsetUnknown: 0,
    // The evaluator's gaps, kept visible rather than read as a pass: judgements
    // resting on undeclared lighting (D5), and occurrence-dates on which the
    // table and a venue's coordinates disagree (the table was applied, D10).
    candidatesOnUndeclaredLighting: 0,
    sunsetSourcesDisagree: 0,
    refused: [],
  };
  /** Verdicts by shape and window: they do not depend on the team. */
  const daylightVerdicts = new Map();
  /**
   * Judge `shape` over `series`' window with the one evaluator. Returns the
   * refusal, or `null` when every occurrence is lit or ends by the limit.
   */
  const judgeDaylight = (series, shape) => {
    const key = `${shapeKey(shape)}|${series.from}|${series.until}`;
    let verdict = daylightVerdicts.get(key);
    if (verdict === undefined) {
      /** @type {import('./types.js').PracticeOccurrence[]} */
      const occurrences = [];
      const lastDay = isoDayNumber(series.until);
      for (
        let day = isoDayNumber(firstWeekdayOnOrAfter(series.from, shape.weekday));
        day <= lastDay;
        day += 7
      ) {
        const date = isoDateOfDayNumber(day);
        occurrences.push({
          id: `${key}@${date}`,
          slotId: shapeKey(shape),
          surfaceId: shape.surfaceId,
          date,
          startMinutes: shape.startMinutes,
          endMinutes: shape.startMinutes + shape.durationMinutes,
          format: null,
          label: null,
          revisionId: null,
          teamIds: [],
          exceptionIds: [],
        });
      }
      const judged = evaluatePracticeDaylight({ occurrences, graph, calendar });
      // Occurrences are in date order, so the first of each list is the earliest.
      const past = judged.flagged[0] ?? null;
      const unknown = judged.unknown[0] ?? null;
      const first = past ?? unknown;
      verdict = {
        occurrences: occurrences.length,
        lit: judged.meta.litPracticeOccurrencesExempt > 0,
        undeclared: judged.meta.undeclaredLightingOccurrences > 0,
        disagreements: judged.findings.filter(
          (finding) => finding.code === AVAILABILITY_REASON.SUNSET_SOURCES_DISAGREE
        ).length,
        refusal:
          first === null
            ? null
            : {
                reason:
                  past !== null
                    ? PRACTICE_TBD_REASON.PAST_SUNSET
                    : PRACTICE_TBD_REASON.SUNSET_UNKNOWN,
                date: first.date,
                endMinutes: first.endMinutes,
                sunsetMinutes: first.sunsetMinutes,
                limitMinutes: first.limitMinutes,
                sunsetSource: first.sunsetSource,
                datesPastSunset: judged.flagged.length,
                datesSunsetUnknown: judged.unknown.length,
              },
      };
      daylightVerdicts.set(key, verdict);
    }
    daylight.candidatesJudged += 1;
    daylight.occurrencesExamined += verdict.occurrences;
    if (verdict.undeclared) daylight.candidatesOnUndeclaredLighting += 1;
    daylight.sunsetSourcesDisagree += verdict.disagreements;
    if (verdict.occurrences === 0) daylight.candidatesWithNoOccurrence += 1;
    else if (verdict.lit) daylight.candidatesLitExempt += 1;
    else if (verdict.refusal === null) daylight.candidatesWithinDaylight += 1;
    else if (verdict.refusal.reason === PRACTICE_TBD_REASON.PAST_SUNSET) {
      daylight.candidatesRefusedPastSunset += 1;
    } else daylight.candidatesRefusedSunsetUnknown += 1;
    return verdict.refusal;
  };

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
  /**
   * Undated series off the lost ground. Whether they are in force is unknown,
   * so — `slots.js` `slotsCollide()`'s contract — they occupy their ground on
   * every date: a repair may not land on top of one.
   */
  const undatedOccupants = [];
  for (const assignment of slotSet.assignments) {
    const slot = /** @type {import('./types.js').PracticeSlot} */ (slotById.get(assignment.slotId));
    const from = assignment.effectiveFrom ?? slot.validFrom;
    const until = assignment.effectiveUntil ?? slot.validUntil;
    if (from === null || until === null) {
      if (lostSurfaceIds.has(slot.surfaceId) && hitsLossMinutes(slot)) {
        undatedOnLostGround.push(assignment.id);
      } else {
        undatedOccupants.push({
          assignmentId: assignment.id,
          teamId: assignment.teamId,
          slotId: slot.id,
          surfaceId: slot.surfaceId,
          weekday: slot.weekday,
          startMinutes: slot.startMinutes,
          durationMinutes: slot.durationMinutes,
          from: '0000-01-01',
          until: '9999-12-31',
        });
      }
      continue;
    }
    if (until < lossDate) continue;
    if (bounded && from > lossUntil) continue;
    // Every series is held to the loss window: it is displaced, and it occupies
    // ground as a frozen series, over its range within the window only.
    const windowFrom = from < lossDate ? lossDate : from;
    const windowUntil = bounded && until > lossUntil ? lossUntil : until;
    // A series with no occurrence left in the window is not displaced by the
    // loss: re-homing it would spend budget on a practice that never happens.
    if (firstWeekdayOnOrAfter(windowFrom, slot.weekday) > windowUntil) continue;
    active.push({
      assignmentId: assignment.id,
      teamId: assignment.teamId,
      slotId: slot.id,
      surfaceId: slot.surfaceId,
      weekday: slot.weekday,
      startMinutes: slot.startMinutes,
      durationMinutes: slot.durationMinutes,
      from: windowFrom,
      until: windowUntil,
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
    .filter((series) => lostSurfaceIds.has(series.surfaceId) && hitsLossMinutes(series))
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

  /* -- coach preferences (plan §4) ---------------------------------------- */
  // The one contract for a preference, applied to the whole list: an element
  // that is not an approved preference, or a second row for one (coach,
  // dimension), refuses the repair here, whether or not anything is displaced.
  const coachPreferences = CoachPreferenceInputSchema.parse({
    coachIds: [],
    preferences: parsed.coachPreferences ?? [],
  }).preferences;
  const coachRows = parsed.teamCoachAssignments ?? [];
  // Venue = location (plan §5, decision 2). Once any preference asks for
  // something, every venue must be a location id, checked here for the whole
  // graph so that the refusal does not depend on which teams happen to be
  // displaced.
  if (coachPreferences.some((p) => p.level !== COACH_PREFERENCE_LEVEL.DONT_CARE)) {
    const notLocations = [
      ...new Set(Object.values(graph.surfaces).map((surface) => surface?.venueId ?? null)),
    ]
      .filter((venueId) => !LocationIdSchema.safeParse(venueId).success)
      .sort();
    if (notLocations.length > 0) {
      throw new Error(
        `repair: coach preferences compare venues as location ids, and the facility graph's venues ${JSON.stringify(notLocations)} are not; build the graph from locations before passing preferences`
      );
    }
  }
  /** A series or a candidate, as `coachPreferences.js` reads one. Venue = location. */
  const placementOf = (shape) => ({
    weekday: shape.weekday,
    startMinutes: shape.startMinutes,
    locationId: venueOf(shape.surfaceId),
  });
  /**
   * One displaced series' resolved preferences, or `null` when none applies:
   * none were supplied, or none of its team's current coaches holds one with a
   * reference. `null` is what keeps a repair without preferences unchanged.
   */
  const preferencesOf = (series) => {
    if (coachPreferences.length === 0) return null;
    const { lead, assistants } = coachesOfTeamOn(coachRows, series.teamId, series.from);
    const current = new Set([...lead, ...assistants]);
    // `dont_care` asks nothing of a candidate: resolving it yields no
    // reference, no finding and no verdict, so a team whose current coaches
    // hold nothing else is left exactly as a team with no preferences.
    const holds = coachPreferences.some(
      (preference) =>
        current.has(preference.coachId) && preference.level !== COACH_PREFERENCE_LEVEL.DONT_CARE
    );
    if (!holds) return null;
    const resolution = resolveCoachPreferences({
      coachIds: [...current].sort(),
      preferences: coachPreferences,
      series: placementOf(series),
    });
    for (const finding of resolution.findings) {
      findings.push(
        makePracticeFinding(finding.code, `${series.teamId}: ${finding.message}`, {
          ...finding.details,
          assignmentId: series.assignmentId,
          teamId: series.teamId,
        })
      );
    }
    return resolution.dimensions.some((entry) => entry.references.length > 0) ? resolution : null;
  };

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
    for (const other of [...frozen, ...undatedOccupants]) {
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
    const preferences = preferencesOf(series);
    // Legal same-venue candidates before the `must_keep` filter, and the
    // dimensions it filtered on: what tells COACH_PREFERENCE from no slot at all.
    let sameBeforeMustKeep = 0;
    const mustKeepViolated = new Set();
    // Frozen-free same-venue candidates before the daylight gate, and what it
    // refused: what tells PAST_SUNSET / SUNSET_UNKNOWN from no slot at all.
    let sameBeforeDaylight = 0;
    const sameDaylightRefused = { pastSunset: 0, sunsetUnknown: 0 };
    const refusedHere = { pastSunset: 0, sunsetUnknown: 0 };
    for (const shape of inventoryShapes) {
      if (shape.durationMinutes !== series.durationMinutes) continue;
      const overlaps = againstFrozen(series, shape);
      if (overlaps === null) continue;
      const sameVenue = venueOf(shape.surfaceId) === venueOf(series.surfaceId);
      if (calendar !== null) {
        if (sameVenue) sameBeforeDaylight += 1;
        const refusal = judgeDaylight(series, shape);
        if (refusal !== null) {
          const kind =
            refusal.reason === PRACTICE_TBD_REASON.PAST_SUNSET ? 'pastSunset' : 'sunsetUnknown';
          refusedHere[kind] += 1;
          if (sameVenue) sameDaylightRefused[kind] += 1;
          daylight.refused.push({
            assignmentId: series.assignmentId,
            teamId: series.teamId,
            tier: sameVenue ? 'same-venue' : 'cross-venue',
            to: { ...shape },
            ...refusal,
          });
          continue;
        }
      }
      let breaches = 0;
      if (preferences !== null) {
        if (sameVenue) sameBeforeMustKeep += 1;
        const verdict = judgeCoachPreferenceCandidate(preferences, placementOf(shape));
        if (verdict.mustKeepViolated) {
          // Only what emptied the venue explains a COACH_PREFERENCE TIME TBD.
          if (sameVenue) {
            for (const dimension of verdict.violatedDimensions) mustKeepViolated.add(dimension);
          }
          continue;
        }
        breaches = verdict.preferKeepBreaches;
      }
      const counts = {
        ...changeCountsFor(series, shape),
        ...coachPreferenceCountsFor(shape, breaches),
      };
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
      (sameVenue ? same : cross).push(entry);
    }
    const order = (a, b) => a.cost - b.cost || shapeKey(a.shape).localeCompare(shapeKey(b.shape));
    if (refusedHere.pastSunset > 0) {
      findings.push(
        makePracticeFinding(
          PRACTICE_REASON.REPAIR_CANDIDATES_PAST_SUNSET,
          `${series.teamId}: ${refusedHere.pastSunset} re-home candidate(s) refused: each ends past sunset on unlit or undeclared ground on some date from ${series.from} until ${series.until}.`,
          {
            assignmentId: series.assignmentId,
            teamId: series.teamId,
            refused: refusedHere.pastSunset,
            sameVenue: sameDaylightRefused.pastSunset,
          }
        )
      );
    }
    if (refusedHere.sunsetUnknown > 0) {
      findings.push(
        makePracticeFinding(
          PRACTICE_REASON.REPAIR_CANDIDATES_SUNSET_UNKNOWN,
          `${series.teamId}: ${refusedHere.sunsetUnknown} re-home candidate(s) refused: the sunset on unlit or undeclared ground is unknown on some date from ${series.from} until ${series.until} (no table record, no venue coordinates), so they cannot be shown to end by it.`,
          {
            assignmentId: series.assignmentId,
            teamId: series.teamId,
            refused: refusedHere.sunsetUnknown,
            sameVenue: sameDaylightRefused.sunsetUnknown,
          }
        )
      );
    }
    const daylightRefusedAtVenue =
      sameDaylightRefused.pastSunset + sameDaylightRefused.sunsetUnknown;
    return {
      series,
      same: same.sort(order),
      cross: cross.sort(order),
      // Legal at its venue before the filter, and nothing left after it.
      mustKeepEmptied: sameBeforeMustKeep > 0 && same.length === 0,
      mustKeepViolated: [...mustKeepViolated].sort(),
      // Frozen-free at its venue, and every one refused by daylight.
      daylightEmptied: sameBeforeDaylight > 0 && daylightRefusedAtVenue === sameBeforeDaylight,
      daylightRefused: sameDaylightRefused,
    };
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

  /**
   * The joint search both tiers run (plan §2). Each series of `searchOrder`
   * takes one of `candidatesOf(entry)` or goes TIME TBD at `tbdCost`, on top of
   * `occupants` (placements already made, held fixed), under the change budget
   * with `timeChanges0` already spent. Greedy seeds the incumbent; `exact`
   * then branch-and-bounds to the optimum unless it passes `nodeLimit`, and
   * `exhausted` says whether it finished. Only the new placements come back.
   */
  const jointSearch = (
    searchOrder,
    candidatesOf,
    occupants,
    coachDays0,
    timeChanges0,
    { matchingBound = false } = {}
  ) => {
    // Greedy: in search order, each series takes its cheapest admissible slot.
    const greedy = () => {
      const placed = [...occupants];
      let coachDays = coachDays0;
      let cost = 0;
      let timeChanges = timeChanges0;
      for (const { entry } of searchOrder) {
        let best = null;
        for (const candidate of candidatesOf(entry)) {
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
      return { placed: placed.slice(occupants.length), cost };
    };

    let incumbent = greedy();
    let nodes = 0;
    let exhausted = true;
    if (strategy === 'exact') {
      // Admissible bound: each remaining series at its cheapest standalone cost.
      const standalone = searchOrder.map(({ entry }) =>
        Math.min(tbdCost, ...candidatesOf(entry).map((candidate) => candidate.cost))
      );
      const suffix = new Array(searchOrder.length + 1).fill(0);
      for (let k = searchOrder.length - 1; k >= 0; k -= 1) {
        suffix[k] = suffix[k + 1] + standalone[k];
      }
      const placed = [...occupants];
      // Tier 2's bound: the remaining series' cheapest ASSIGNMENT to ground,
      // not the sum of their cheapest candidates. They contend for the same
      // few shapes, and the sum ignores that, so a search whose answer leaves
      // one series TIME TBD could not cut anything until the leaves. It is a
      // relaxation, so it stays admissible:
      // - each series is priced at its standalone cost, which a marginal
      //   never undercuts (weights are non-negative);
      // - a shape clashing with ground a placed series holds is dropped, and
      //   the rest are grouped into cliques of mutually clashing shapes (by
      //   the repair's own `conflictsWith` and `timesOverlap`), each hosting at
      //   most one series. Any clique partition is sound; a greedy one is used.
      // Both need every range to meet every other, or two series could share
      // ground on different dates; otherwise the plain sum stands. A bound
      // changes which subtrees are cut, never which leaf is found first.
      const everySeries = [
        ...occupants.map((placement) => placement.series),
        ...searchOrder.map(({ entry }) => entry.series),
      ];
      const useMatching =
        matchingBound && everySeries.every((a) => everySeries.every((b) => rangesOverlap(a, b)));
      const clash = (a, b) => timesOverlap(a, b) && conflictsWith(a.surfaceId).has(b.surfaceId);
      const remainingBound = (depth) => {
        if (!useMatching) return suffix[depth];
        const held = placed
          .filter((placement) => placement.candidate !== null)
          .map((placement) => placement.candidate.shape);
        const cliques = [];
        const cliqueOf = new Map();
        const rows = searchOrder.slice(depth).map(({ entry }) => {
          const row = [];
          for (const candidate of candidatesOf(entry)) {
            const shape = candidate.shape;
            const key = shapeKey(shape);
            if (!cliqueOf.has(key)) {
              if (held.some((other) => clash(shape, other))) cliqueOf.set(key, -1);
              else {
                let index = cliques.findIndex((members) => members.every((m) => clash(shape, m)));
                if (index === -1) index = cliques.push([]) - 1;
                cliques[index].push(shape);
                cliqueOf.set(key, index);
              }
            }
            const column = /** @type {number} */ (cliqueOf.get(key));
            if (column !== -1) row.push({ column, cost: candidate.cost });
          }
          return row;
        });
        return minimumAssignment(rows, cliques.length, tbdCost);
      };
      const walk = (depth, cost, coachDays, timeChanges) => {
        if (!exhausted) return;
        nodes += 1;
        if (nodes > nodeLimit) {
          exhausted = false;
          return;
        }
        if (cost + remainingBound(depth) >= incumbent.cost) return;
        if (depth === searchOrder.length) {
          incumbent = { placed: placed.slice(occupants.length), cost };
          return;
        }
        const { entry } = searchOrder[depth];
        const options = [];
        for (const candidate of candidatesOf(entry)) {
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
      walk(0, 0, coachDays0, timeChanges0);
    }
    return { incumbent, nodes, exhausted };
  };

  return {
    parsed,
    slotSet,
    slotById,
    weights,
    lossDate,
    dayBefore,
    lossUntil,
    bounded,
    lossReason,
    findings,
    lostSurfaceIds,
    venueOf,
    active,
    undatedOnLostGround,
    displaced,
    publishedCoachDays,
    candidatesBySeries,
    tbdCost,
    budget,
    nodeLimit,
    strategy,
    order,
    marginal,
    coachDaysAfter,
    baseCoachDays,
    timeChangeOf,
    jointSearch,
    daylight,
  };
}

/**
 * The least total cost of giving each row one column (each column to at most
 * one row) or TIME TBD at `tbdCost`: the Hungarian method with potentials,
 * O(n²m), on n rows and m = `columns` + n TIME TBD columns. Tier 2's lower
 * bound; see `jointSearch()`.
 *
 * @param {Array<Array<{ column: number, cost: number }>>} rows
 * @param {number} columns
 * @param {number} tbdCost
 * @returns {number}
 */
function minimumAssignment(rows, columns, tbdCost) {
  const n = rows.length;
  if (n === 0) return 0;
  const m = columns + n;
  // Row i may take its own TIME TBD column and no other row's.
  const cost = rows.map((row, i) => {
    const line = new Array(m).fill(Infinity);
    for (const { column, cost: c } of row) line[column] = Math.min(line[column], c);
    line[columns + i] = tbdCost;
    return line;
  });
  const u = new Array(n + 1).fill(0);
  const v = new Array(m + 1).fill(0);
  const match = new Array(m + 1).fill(0);
  const way = new Array(m + 1).fill(0);
  for (let i = 1; i <= n; i += 1) {
    match[0] = i;
    let j0 = 0;
    const minv = new Array(m + 1).fill(Infinity);
    const used = new Array(m + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = match[j0];
      let delta = Infinity;
      let j1 = 0;
      for (let j = 1; j <= m; j += 1) {
        if (used[j]) continue;
        const reduced = cost[i0 - 1][j - 1] - u[i0] - v[j];
        if (reduced < minv[j]) {
          minv[j] = reduced;
          way[j] = j0;
        }
        if (minv[j] < delta) {
          delta = minv[j];
          j1 = j;
        }
      }
      for (let j = 0; j <= m; j += 1) {
        if (used[j]) {
          u[match[j]] += delta;
          v[j] -= delta;
        } else minv[j] -= delta;
      }
      j0 = j1;
    } while (match[j0] !== 0);
    do {
      const j1 = way[j0];
      match[j0] = match[j1];
      j0 = j1;
    } while (j0 !== 0);
  }
  let total = 0;
  for (let j = 1; j <= m; j += 1) if (match[j] !== 0) total += cost[match[j] - 1][j - 1];
  return total;
}

/**
 * Re-home the practice series a loss of ground displaces.
 *
 * @param {Object} input - see `PracticeRepairInputSchema`
 * @returns {Object} the repair result; see the module doc and `tests/practiceRepair.test.js`
 */
export function repairPracticeLoss(input) {
  const context = buildPracticeRepairContext(input);
  const {
    parsed,
    slotSet,
    slotById,
    lossDate,
    dayBefore,
    lossUntil,
    bounded,
    lossReason,
    findings,
    lostSurfaceIds,
    active,
    undatedOnLostGround,
    displaced,
    publishedCoachDays,
    candidatesBySeries,
    budget,
    nodeLimit,
    strategy,
    order,
    marginal,
    coachDaysAfter,
    baseCoachDays,
    timeChangeOf,
    jointSearch,
    daylight,
  } = context;

  // Tier 1: the exact same-venue search (plan §2), unchanged.
  const tier1 = jointSearch(order, (entry) => entry.same, [], baseCoachDays, 0);
  const { incumbent, nodes, exhausted } = tier1;
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

  /* -- tier 2: the joint cross-venue search (plan §2) --------------------- */
  // Over the series tier 1 left TIME TBD, in the same search order, with every
  // tier-1 placement a frozen occupant and tier 1's published-time changes
  // already spent against the budget. `coachDays` is the plan after tier 1.
  const tier2Order = order.filter(
    ({ entry }) => (chosenById.get(entry.series.assignmentId) ?? null) === null
  );
  const tier2 = jointSearch(
    tier2Order,
    (entry) => entry.cross,
    finalPlaced.filter((placement) => placement.candidate !== null),
    coachDays,
    finalPlaced.reduce((sum, placement) => sum + timeChangeOf(placement.candidate), 0),
    { matchingBound: true }
  );
  if (strategy === 'exact' && !tier2.exhausted) {
    findings.push(
      makePracticeFinding(
        PRACTICE_REASON.REPAIR_MINIMALITY_UNPROVEN,
        `The joint cross-venue search stopped at its ${nodeLimit}-node limit. Its recommendations are the best found, not a proven optimum; no two of them clash either way.`,
        { strategy, nodes: tier2.nodes, nodeLimit, tier: 'cross-venue' }
      )
    );
  }
  /** Every displaced series' recommendation: tier 1's placement, else tier 2's, else none. */
  const recommended = new Map(
    [...finalPlaced, ...tier2.incumbent.placed]
      .filter((placement) => placement.candidate !== null)
      .map((placement) => [placement.series.assignmentId, placement.candidate])
  );

  const rehomed = [];
  const timeTbd = [];
  /** Tier 1's reason for each TIME TBD, for the recommendations of the ones tier 2 cannot place. */
  const tbdReasons = new Map();
  const newSlots = [];
  const splitAssignments = new Map();
  const newAssignments = [];
  for (const { series, candidate } of finalPlaced.sort((a, b) =>
    a.series.assignmentId.localeCompare(b.series.assignmentId)
  )) {
    splitAssignments.set(series.assignmentId, series);
    // A blackout's entries name the series-window their temporary override covers.
    const window = bounded ? { window: { from: series.from, until: series.until } } : {};
    const span = bounded ? `from ${series.from} until ${series.until}` : `from ${series.from}`;
    if (candidate !== null) {
      const slotId = bounded
        ? `${series.slotId}~override@${series.from}..${series.until}#${series.assignmentId}`
        : `${series.slotId}~repair@${lossDate}#${series.assignmentId}`;
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
        label: bounded
          ? `override of ${series.slotId} ${span}: ${lossReason}`
          : `repair of ${series.slotId} from ${lossDate}: ${lossReason}`,
        surfaceResolution: 'resolved',
      });
      newAssignments.push({
        id: bounded
          ? `${series.assignmentId}~override@${series.from}`
          : `${series.assignmentId}~repair@${lossDate}`,
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
        ...window,
        publishedTimeChanged: candidate.timeChanged,
        weekdayChanged: candidate.weekdayChanged,
        locationChanged: candidate.shape.surfaceId !== series.surfaceId,
        counts: { ...candidate.counts },
      };
      rehomed.push(entry);
      findings.push(
        makePracticeFinding(
          PRACTICE_REASON.REPAIR_REHOMED,
          `${series.teamId}: ${series.weekday} ${series.startMinutes} on ${series.surfaceId} -> ${candidate.shape.weekday} ${candidate.shape.startMinutes} on ${candidate.shape.surfaceId} ${span}${candidate.timeChanged ? ' (published time changed)' : ' (same published time)'}`,
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
      if (entry.same.length === 0) {
        if (entry.mustKeepEmptied) reason = PRACTICE_TBD_REASON.COACH_PREFERENCE;
        else if (entry.daylightEmptied) {
          reason =
            entry.daylightRefused.sunsetUnknown > 0
              ? PRACTICE_TBD_REASON.SUNSET_UNKNOWN
              : PRACTICE_TBD_REASON.PAST_SUNSET;
        } else reason = PRACTICE_TBD_REASON.NO_LEGAL_SLOT_AT_VENUE;
      } else if (freeNow.length > 0) {
        reason =
          budget !== null
            ? PRACTICE_TBD_REASON.CHANGE_BUDGET
            : PRACTICE_TBD_REASON.OBJECTIVE_PREFERRED_TBD;
      } else reason = PRACTICE_TBD_REASON.CONTENDED;
      tbdReasons.set(series.assignmentId, reason);
      const crossVenue = recommended.get(series.assignmentId) ?? null;
      const crossVenueKey = crossVenue === null ? null : shapeKey(crossVenue.shape);
      timeTbd.push({
        assignmentId: series.assignmentId,
        teamId: series.teamId,
        from: {
          surfaceId: series.surfaceId,
          weekday: series.weekday,
          startMinutes: series.startMinutes,
        },
        ...window,
        reason,
        lossReason,
        ...(reason === PRACTICE_TBD_REASON.COACH_PREFERENCE
          ? { mustKeepDimensions: entry.mustKeepViolated }
          : {}),
        ...(reason === PRACTICE_TBD_REASON.PAST_SUNSET ||
        reason === PRACTICE_TBD_REASON.SUNSET_UNKNOWN
          ? { daylightRefused: { ...entry.daylightRefused } }
          : {}),
        sameVenueCandidates: entry.same.length,
      });
      findings.push(
        makePracticeFinding(
          PRACTICE_REASON.REPAIR_TIME_TBD,
          `${series.teamId}: the ${series.weekday} ${series.startMinutes} practice on ${series.surfaceId} is TIME TBD ${span} (${reason}); ${crossVenue === null ? 'no cross-venue recommendation' : `cross-venue recommendation ${crossVenueKey}, to enact or decline`}.`,
          {
            assignmentId: series.assignmentId,
            teamId: series.teamId,
            reason,
            lossReason,
            crossVenueRecommendation: crossVenueKey,
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
        `The loss of ${[...parsed.loss.surfaceIds].join(', ')} from ${lossDate}${bounded ? ` until ${lossUntil}` : ''} displaced no dated series. Nothing was repaired; that is not the same as a repair that succeeded.`,
        { surfaceIds: [...parsed.loss.surfaceIds], activeSeries: active.length }
      )
    );
  }

  /* -- the repaired plan: split, never edited ----------------------------- */
  const repairedSlots = [];
  const repairedAssignments = [];
  if (bounded) {
    // A blackout ends, so the lost ground is kept whole. Each displaced series
    // is split in memory around its window only: the part before keeps its id,
    // the part after gets one, and the window holds the override (if any).
    // Occurrences carry slot and team, not assignment, so every occurrence
    // outside the window materialises exactly as it did.
    const dayAfter = shiftDate(/** @type {string} */ (lossUntil), 1);
    for (const slot of slotSet.slots) repairedSlots.push({ ...slot });
    for (const assignment of slotSet.assignments) {
      if (!splitAssignments.has(assignment.id)) {
        repairedAssignments.push({ ...assignment });
        continue;
      }
      const slot = /** @type {import('./types.js').PracticeSlot} */ (
        slotById.get(assignment.slotId)
      );
      const from = /** @type {string} */ (assignment.effectiveFrom ?? slot.validFrom);
      const until = /** @type {string} */ (assignment.effectiveUntil ?? slot.validUntil);
      if (from < lossDate) {
        repairedAssignments.push({ ...assignment, effectiveFrom: from, effectiveUntil: dayBefore });
      }
      if (until > /** @type {string} */ (lossUntil)) {
        repairedAssignments.push({
          ...assignment,
          id: `${assignment.id}~after@${lossUntil}`,
          effectiveFrom: dayAfter,
          effectiveUntil: until,
        });
      }
    }
  }
  for (const slot of bounded ? [] : slotSet.slots) {
    const onLost =
      lostSurfaceIds.has(slot.surfaceId) && slot.validFrom !== null && slot.validUntil !== null;
    if (onLost && slot.validUntil >= lossDate) {
      if (slot.validFrom >= lossDate) continue; // the whole slot is lost ground
      repairedSlots.push({ ...slot, validUntil: dayBefore });
    } else repairedSlots.push({ ...slot });
  }
  const keptSlotIds = new Set(repairedSlots.map((slot) => slot.id));
  for (const assignment of bounded ? [] : slotSet.assignments) {
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
  // One shape holds one series only while their ranges meet. When two placed
  // series' ranges are disjoint they could share a shape, the matching would
  // under-count keepers, and the "bound" could exceed the truth; there the
  // bound falls back to the series with no same-time candidate at all.
  const placedSeries = candidatesBySeries
    .filter((entry) => placedIds.has(entry.series.assignmentId))
    .map((entry) => entry.series);
  const rangesAllMeet = placedSeries.every((a) => placedSeries.every((b) => rangesOverlap(a, b)));
  let keepers = 0;
  if (rangesAllMeet) {
    for (let i = 0; i < sameTime.length; i += 1) if (augment(i, new Set())) keepers += 1;
  } else {
    keepers = sameTime.filter((keys) => keys.length > 0).length;
  }
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
    representation: bounded ? 'override' : 'split',
    rehomed,
    timeTbd,
    coachDays: coachDayRows,
    plan: repairedPlan,
    findings,
    stats,
    recommendations: describePracticeRecommendations(context, recommended, (id) =>
      tbdReasons.get(id)
    ),
    recommendationSearch: {
      strategy,
      series: tier2Order.length,
      recommended: tier2.incumbent.placed.filter((placement) => placement.candidate !== null)
        .length,
      nodes: tier2.nodes,
      nodeLimit,
      provenOptimal: strategy === 'exact' && tier2.exhausted,
    },
    daylight: { ...daylight, refused: [...daylight.refused] },
  };
}

/**
 * One recommendation per displaced series-window (plan §2, §5 decision 5),
 * in assignment-id order: where `chosen` puts it, priced by `marginal()`
 * against every other recommendation, or TIME TBD with `reasonOf(id)`.
 * Each price is the plan's `marginal(T, X, R∖{T}, coachDays(R∖{T}))`, the one
 * the decline chain ranks by — a marginal, not a share: a coach day two
 * recommendations add together, or an overlap between them, shows on each
 * entry as its own marginal sees it, so the entries need not sum to the
 * search's total.
 * Shared by `repairPracticeLoss()` and `practice/recommendations.js`, so a
 * decline reports its result exactly as the repair reports its own.
 * Internal: not in the barrel.
 *
 * @param {ReturnType<typeof buildPracticeRepairContext>} context
 * @param {Map<string, any>} chosen - assignment id -> candidate; absent is TIME TBD
 * @param {(assignmentId: string) => string | undefined} reasonOf
 */
export function describePracticeRecommendations(context, chosen, reasonOf) {
  const { displaced, bounded, venueOf, marginal, tbdCost } = context;
  return displaced.map((series) => {
    const candidate = chosen.get(series.assignmentId) ?? null;
    const head = {
      assignmentId: series.assignmentId,
      teamId: series.teamId,
      from: {
        surfaceId: series.surfaceId,
        weekday: series.weekday,
        startMinutes: series.startMinutes,
      },
      effectiveFrom: series.from,
      effectiveUntil: series.until,
      ...(bounded ? { window: { from: series.from, until: series.until } } : {}),
    };
    if (candidate === null) {
      const reason = reasonOf(series.assignmentId);
      if (reason === undefined) {
        throw new Error(`repair: ${series.assignmentId} is TIME TBD with no reason`);
      }
      return {
        ...head,
        tier: null,
        to: null,
        reason,
        objective: { total: tbdCost, counts: { [RESOLVE_OBJECTIVE_TERM.UNPLACED_GAME]: 1 } },
        coachOverlaps: [],
        coachDaysWorsened: 0,
        origin: null,
      };
    }
    const { placed: others, coachDays } = placementsExcept(context, chosen, series.assignmentId);
    const m = marginal(series, candidate, others, coachDays);
    if (m === null) {
      throw new Error(`repair: the recommendation for ${series.assignmentId} clashes with another`);
    }
    const crossVenue = venueOf(candidate.shape.surfaceId) !== venueOf(series.surfaceId);
    const compromise = candidate.frozenOverlaps.length + m.newOverlaps.length + m.worsened;
    return {
      ...head,
      tier: crossVenue ? 'cross-venue' : 'same-venue',
      to: { ...candidate.shape },
      reason: null,
      objective: {
        total: m.cost,
        counts: {
          ...candidate.counts,
          ...(compromise > 0 ? { [RESOLVE_OBJECTIVE_TERM.COMPROMISE_VIOLATION]: compromise } : {}),
        },
      },
      coachOverlaps: [...candidate.frozenOverlaps, ...m.newOverlaps],
      coachDaysWorsened: m.worsened,
      // Enacting a cross-venue recommendation is an operator approving an
      // option (#441's precedent); a same-venue one is the repair's own.
      origin: crossVenue ? CHANGE_ORIGIN.APPROVED_OPTION : null,
    };
  });
}

/**
 * Every displaced series' placement in `chosen` except `assignmentId`'s, the
 * coach days they give, and their published-time changes: the plan's R∖{T}.
 * Shared by `describePracticeRecommendations()` and `recommendations.js`.
 * Internal: not in the barrel.
 *
 * @param {ReturnType<typeof buildPracticeRepairContext>} context
 * @param {Map<string, any>} chosen
 * @param {string | null} assignmentId
 */
export function placementsExcept(context, chosen, assignmentId) {
  const placed = [];
  let coachDays = context.baseCoachDays;
  let timeChanges = 0;
  for (const series of context.displaced) {
    const candidate = chosen.get(series.assignmentId) ?? null;
    if (series.assignmentId === assignmentId || candidate === null) continue;
    placed.push({ series, candidate });
    coachDays = context.coachDaysAfter(coachDays, series, candidate);
    timeChanges += context.timeChangeOf(candidate);
  }
  return { placed, coachDays, timeChanges };
}
