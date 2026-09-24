/**
 * **The objective. The only scoring function in this package.**
 *
 * > *"Add change minimisation as a first-class solver objective, distinct from
 * > schedule quality. Today the objective optimises quality alone, so a re-solve
 * > returns the best schedule it can find rather than the nearest acceptable
 * > one. Once a schedule is published, 'nearest' almost always beats 'best.'"*
 *
 * ## Why there is exactly one function here that multiplies anything
 *
 * [`docs/ARCHITECTURE.md`](../../../../docs/ARCHITECTURE.md) §6.10 records that
 * this repository already carries **two** fitness functions —
 * `autoScheduler.computeFitness()` and a diverged hand-port inside
 * `supabase/functions/auto-scheduler/index.ts` — with different coefficients,
 * different terms, and nothing that detects the drift between them. A third one
 * would not be a feature; it would be the same defect a third time.
 *
 * So the shape of this file is the guarantee. {@link scoreObjective} is the
 * **only** place in `resolve/` where a count is multiplied by a weight. It takes
 * a bag of counted terms and a weight table and returns costs. Everything else
 * here — {@link candidateObjectiveCounts}, {@link objectiveCountsForSchedule} —
 * only *counts*, and every caller in the package (the placer's slot choice, the
 * dry-run report, the change budget) goes through the same one function with the
 * same one table. `tests/minimalDiff.test.js` asserts that structurally: exactly
 * one weight table is declared in `resolve/` and `freeze/`, exactly one function
 * reads it, and no file in either package mentions `computeFitness`.
 *
 * ## Two families of term, and the trade between them is the point
 *
 * | family | terms | counted from |
 * |---|---|---|
 * | **change** | `changedGame`, `driftMinute`, `changedSurface`, `changedWeekday` (practice series only) | the reference schedule, game by game or series by series |
 * | **quality** | `unplacedGame`, `blockingViolation`, `compromiseViolation` | the standing rule engine / the facility check |
 *
 * The weights are **policy, not data** — nothing in the corpus can supply them —
 * so what is asserted about them is their *ordering*, and every one of them is
 * overridable per run. The defaults say, in order: never leave a game without a
 * time; never break a blocking constraint; do not move a published game unless
 * ten compromises hang on it; and among slots that score the same, take the one
 * nearest to where the game already was.
 *
 * Setting the three change weights to zero is a supported and deliberately
 * conspicuous act: it is the objective incident 1's solver had, it is what the
 * positive control in `tests/freezeScopes.test.js` runs, and a run scored that
 * way stamps `RESOLVE_OBJECTIVE_CHANGE_TERM_DISABLED` at `compromise` so it can
 * never be mistaken for an ordinary one. **Zeroing any one of them stamps it**,
 * naming which: `changedGame` alone is 1000 of the 1002 units of change pressure
 * the objective has, so a run without it behaves like a re-optimisation, and a
 * warning that only fired on all three let it do so in silence.
 *
 * @module resolve/objective
 */

import { CONSTRAINT_SEVERITY } from '../constraints/reasonCodes.js';

/**
 * Every term the objective knows how to count.
 *
 * @readonly
 * @enum {string}
 */
export const RESOLVE_OBJECTIVE_TERM = Object.freeze({
  /** One game whose slot differs from the reference schedule's. */
  CHANGED_GAME: 'changedGame',
  /** One minute of kickoff drift away from the reference slot. */
  DRIFT_MINUTE: 'driftMinute',
  /** One game standing on different ground than the reference gave it. */
  CHANGED_SURFACE: 'changedSurface',
  /**
   * One recurring practice series moved to another day of the week.
   *
   * **Counted for practice series only** (see {@link changeCountsFor}). A game
   * has a date, not a weekday, and a game that changed date is already a
   * changed game; counting this for it as well would charge one move twice.
   */
  CHANGED_WEEKDAY: 'changedWeekday',
  /** One game left with no time at all (incident 10's TIME TBD). */
  UNPLACED_GAME: 'unplacedGame',
  /** One blocking violation or blocking placement finding. */
  BLOCKING_VIOLATION: 'blockingViolation',
  /** One compromise violation or compromise placement finding. */
  COMPROMISE_VIOLATION: 'compromiseViolation',
});

/**
 * Which terms measure distance from the reference *game* schedule.
 *
 * `changedWeekday` is deliberately absent. It can only ever be counted for a
 * practice series, so no game run can be steered by it, and listing it here
 * would change what `disabledChangeTerms()` / `changeTermsDisabled()` report
 * for game runs: a caller who zeroed the three game terms would stop being
 * told the change terms are off, because a term that never fires for a game
 * was still on. It is still a *change* cost — {@link CHANGE_COST_TERMS} — so
 * {@link scoreObjective} books it on the change side of the ledger.
 */
export const RESOLVE_CHANGE_TERMS = Object.freeze([
  RESOLVE_OBJECTIVE_TERM.CHANGED_GAME,
  RESOLVE_OBJECTIVE_TERM.DRIFT_MINUTE,
  RESOLVE_OBJECTIVE_TERM.CHANGED_SURFACE,
]);

/** Change terms only a practice series can count (see {@link changeCountsFor}). */
export const RESOLVE_PRACTICE_CHANGE_TERMS = Object.freeze([
  RESOLVE_OBJECTIVE_TERM.CHANGED_WEEKDAY,
]);

/** Every term booked as change cost: the game terms, plus the practice-only ones. */
const CHANGE_COST_TERMS = Object.freeze([
  ...RESOLVE_CHANGE_TERMS,
  ...RESOLVE_PRACTICE_CHANGE_TERMS,
]);

/** Which terms measure how good the schedule is, irrespective of the diff. */
export const RESOLVE_QUALITY_TERMS = Object.freeze([
  RESOLVE_OBJECTIVE_TERM.UNPLACED_GAME,
  RESOLVE_OBJECTIVE_TERM.BLOCKING_VIOLATION,
  RESOLVE_OBJECTIVE_TERM.COMPROMISE_VIOLATION,
]);

/**
 * The default weights.
 *
 * Policy, and stated as a strict ordering rather than as tuned numbers, because
 * a tuned number invites the next reader to re-tune it:
 *
 * ```text
 * unplacedGame > blockingViolation > changedGame > changedWeekday > compromiseViolation > driftMinute = changedSurface
 * ```
 *
 * Read as sentences: a game with no time is worse than an illegal one; an
 * illegal game is worse than ten moved ones; **a moved game is worse than ten
 * compromises**, which is the whole of "nearest beats best"; and how far a game
 * moved, and whether it changed pitch, only separate slots that are otherwise
 * equal.
 *
 * `changedWeekday` (Phase 8.6 PR 3a, practice series only) sits between a
 * changed series and a compromise: moving a family's practice to another day
 * costs as much as four hours of same-day drift. That is what makes Tue 17:00
 * -> Tue 18:00 (1000 + 60) beat Tue 17:00 -> Thu 17:00 (1000 + 240). Before
 * this term existed the weekday move was the *cheaper* one, because a changed
 * day counted no drift at all.
 *
 * @type {Readonly<Record<string, number>>}
 */
export const RESOLVE_OBJECTIVE_WEIGHTS = Object.freeze({
  [RESOLVE_OBJECTIVE_TERM.UNPLACED_GAME]: 100000,
  [RESOLVE_OBJECTIVE_TERM.BLOCKING_VIOLATION]: 10000,
  [RESOLVE_OBJECTIVE_TERM.CHANGED_GAME]: 1000,
  [RESOLVE_OBJECTIVE_TERM.CHANGED_WEEKDAY]: 240,
  [RESOLVE_OBJECTIVE_TERM.COMPROMISE_VIOLATION]: 100,
  [RESOLVE_OBJECTIVE_TERM.DRIFT_MINUTE]: 1,
  [RESOLVE_OBJECTIVE_TERM.CHANGED_SURFACE]: 1,
});

/**
 * Resolve a caller's weight overrides against the defaults.
 *
 * Refuses an unknown term rather than ignoring it: a caller who writes
 * `{ changedGames: 0 }` (plural) and gets the default behaviour back has been
 * told nothing, and would report a minimal-diff run they never made.
 *
 * @param {Record<string, number>|null|undefined} overrides
 * @returns {Readonly<Record<string, number>>}
 */
export function resolveObjectiveWeights(overrides) {
  if (overrides === null || overrides === undefined) return RESOLVE_OBJECTIVE_WEIGHTS;
  if (typeof overrides !== 'object') {
    throw new TypeError('resolve: objective weights must be an object of term -> number');
  }
  /** @type {Record<string, number>} */
  const weights = { ...RESOLVE_OBJECTIVE_WEIGHTS };
  for (const [term, weight] of Object.entries(overrides)) {
    if (!Object.hasOwn(RESOLVE_OBJECTIVE_WEIGHTS, term)) {
      throw new Error(
        `resolve: "${term}" is not an objective term; the terms are ${Object.keys(RESOLVE_OBJECTIVE_WEIGHTS).sort().join(', ')}`
      );
    }
    if (typeof weight !== 'number' || !Number.isFinite(weight) || weight < 0) {
      throw new Error(
        `resolve: the weight for "${term}" must be a finite number >= 0, not ${String(weight)}`
      );
    }
    weights[term] = weight;
  }
  return Object.freeze(weights);
}

/**
 * Which change terms this run switched off, named.
 *
 * **Any, not all.** `{ changedGame: 0 }` on its own strips essentially every
 * unit of change pressure the objective has: what is left is `driftMinute` at 1
 * and `changedSurface` at 1, so a thirty-minute move costs 30 against a single
 * `compromiseViolation` at 100 and the placer will move a published game to
 * shave one compromise. A run configured that way behaves like a global
 * re-optimisation, and a predicate that only fired when all three were zero let
 * it do so while reporting nothing at all.
 *
 * @param {Readonly<Record<string, number>>} weights
 * @returns {string[]} the zeroed change terms, in the order they are declared
 */
export function disabledChangeTerms(weights) {
  return RESOLVE_CHANGE_TERMS.filter((term) => (weights[term] ?? 0) === 0);
}

/**
 * Are all three change terms switched off?
 *
 * The stronger statement, and the one the report's `changeTermsDisabled` flag
 * carries: this run is scored with change minimisation switched off entirely,
 * which is the objective incident 1's solver had. Two of three is not that, and
 * must not read as it — {@link disabledChangeTerms} is what a warning is stamped
 * from.
 *
 * @param {Readonly<Record<string, number>>} weights
 * @returns {boolean}
 */
export function changeTermsDisabled(weights) {
  return disabledChangeTerms(weights).length === RESOLVE_CHANGE_TERMS.length;
}

/**
 * Is this weight table the defaults, **by value**?
 *
 * Object identity is not the question a caller is asking. `objectiveWeights: {}`
 * and a table spelled out to exactly the shipped numbers both produce a fresh
 * object, and telling an operator that two identically-scored runs are
 * incomparable is as wrong as failing to tell them when they are.
 *
 * @param {Readonly<Record<string, number>>} weights
 * @returns {boolean}
 */
export function objectiveWeightsAreDefault(weights) {
  if (weights === RESOLVE_OBJECTIVE_WEIGHTS) return true;
  return Object.entries(RESOLVE_OBJECTIVE_WEIGHTS).every(
    ([term, value]) => (weights[term] ?? 0) === value
  );
}

/**
 * **The one function in `resolve/` that multiplies a count by a weight.**
 *
 * @param {Readonly<Record<string, number>>} counts - term -> how many
 * @param {Readonly<Record<string, number>>} weights - term -> what each costs
 * @returns {{ total: number, changeCost: number, qualityCost: number, terms: Record<string, { count: number, weight: number, cost: number }> }}
 */
export function scoreObjective(counts, weights) {
  /** @type {Record<string, { count: number, weight: number, cost: number }>} */
  const terms = {};
  let changeCost = 0;
  let qualityCost = 0;
  for (const term of Object.keys(RESOLVE_OBJECTIVE_WEIGHTS)) {
    const count = counts[term] ?? 0;
    const weight = weights[term] ?? 0;
    const cost = count * weight;
    terms[term] = { count, weight, cost };
    if (/** @type {ReadonlyArray<string>} */ (CHANGE_COST_TERMS).includes(term)) {
      changeCost += cost;
    } else qualityCost += cost;
  }
  for (const term of Object.keys(counts)) {
    if (!Object.hasOwn(RESOLVE_OBJECTIVE_WEIGHTS, term)) {
      throw new Error(
        `resolve: the objective was handed a count for "${term}", which is not a term it weighs; a counted term nothing scores is a number nobody reads`
      );
    }
  }
  return { total: changeCost + qualityCost, changeCost, qualityCost, terms };
}

/**
 * How far one slot is from the reference slot, as counted terms.
 *
 * `driftMinute` is counted **only when the two slots fall on the same date**.
 * Minutes past midnight on two different days are not a distance, and this
 * package constructs no `Date` and holds no season calendar to turn them into
 * one (GAP-32). A game that changed date is therefore counted as a changed game
 * and, where it applies, a changed surface — never as a drift of some number of
 * minutes it did not actually drift.
 *
 * ## A practice series is counted differently, and only a practice series
 *
 * A recurring practice (`practice/repair.js`) has a `weekday` and **no**
 * `date`. For it:
 *
 * - `changedGame` means *the published time changed*: another weekday or
 *   another start. A move to other ground at the same venue at the same time is
 *   **not** a published-time change (operator ruling, 2026-09-23); it counts
 *   `changedSurface` alone.
 * - `driftMinute` is the clock distance between the two starts, whatever the
 *   day. A weekly series has no date for GAP-32's objection to apply to, and
 *   17:00 on Thursday really is nearer 17:00 on Tuesday than 19:00 is.
 * - `changedWeekday` is counted when the day changes.
 *
 * Without that last term the day move was free: under the game rule a changed
 * "date" counts no drift, so Tue 17:00 -> Thu 17:00 cost 1000 while
 * Tue 17:00 -> Tue 18:00 cost 1060, and the objective preferred moving a
 * family's practice day to shifting it by an hour.
 *
 * The branch is taken only when **both** slots carry a `weekday` and neither
 * carries a `date`, so no game slot can reach it.
 *
 * @param {import('./types.js').Slot|PracticeSeriesSlot|null} reference
 * @param {import('./types.js').Slot|PracticeSeriesSlot|null} slot
 * @returns {Record<string, number>}
 */
export function changeCountsFor(reference, slot) {
  if (reference === null || slot === null) return {};
  if (isPracticeSeriesSlot(reference) && isPracticeSeriesSlot(slot)) {
    return practiceSeriesChangeCounts(reference, slot);
  }
  const differs =
    reference.date !== slot.date ||
    reference.surfaceId !== slot.surfaceId ||
    reference.startMinutes !== slot.startMinutes;
  if (!differs) return {};
  return {
    [RESOLVE_OBJECTIVE_TERM.CHANGED_GAME]: 1,
    [RESOLVE_OBJECTIVE_TERM.DRIFT_MINUTE]:
      reference.date === slot.date ? Math.abs(slot.startMinutes - reference.startMinutes) : 0,
    [RESOLVE_OBJECTIVE_TERM.CHANGED_SURFACE]: reference.surfaceId === slot.surfaceId ? 0 : 1,
  };
}

/**
 * A recurring practice series' slot, as the objective sees it.
 *
 * @typedef {Object} PracticeSeriesSlot
 * @property {string} weekday - `'SUN'`…`'SAT'`
 * @property {number} startMinutes
 * @property {string} surfaceId
 * @property {null} [date] - never set: a series has a weekday, not a date
 */

/**
 * Whether a slot is a practice series (a weekday and no date) rather than a game slot.
 *
 * @param {Object} slot
 * @returns {slot is PracticeSeriesSlot}
 */
export function isPracticeSeriesSlot(slot) {
  return (
    typeof slot?.weekday === 'string' &&
    (slot.date === undefined || slot.date === null) &&
    Number.isInteger(slot.startMinutes)
  );
}

/**
 * {@link changeCountsFor}'s practice arm. Counts only; weighs nothing.
 *
 * @param {PracticeSeriesSlot} reference
 * @param {PracticeSeriesSlot} slot
 * @returns {Record<string, number>}
 */
function practiceSeriesChangeCounts(reference, slot) {
  const weekdayChanged = reference.weekday !== slot.weekday;
  const timeChanged = weekdayChanged || reference.startMinutes !== slot.startMinutes;
  const surfaceChanged = reference.surfaceId !== slot.surfaceId;
  if (!timeChanged && !surfaceChanged) return {};
  return {
    [RESOLVE_OBJECTIVE_TERM.CHANGED_GAME]: timeChanged ? 1 : 0,
    [RESOLVE_OBJECTIVE_TERM.DRIFT_MINUTE]: Math.abs(slot.startMinutes - reference.startMinutes),
    [RESOLVE_OBJECTIVE_TERM.CHANGED_SURFACE]: surfaceChanged ? 1 : 0,
    [RESOLVE_OBJECTIVE_TERM.CHANGED_WEEKDAY]: weekdayChanged ? 1 : 0,
  };
}

/**
 * How many blocking and compromise findings one placement carries, per
 * **instance** — the code and the counterpart games it is with (see
 * `resolve/instances.js`), which for a finding naming no other game is the code
 * alone.
 *
 * This is what "the schedule already carried this" is recorded as, so that
 * {@link candidateObjectiveCounts} can charge for what a candidate slot adds
 * rather than for everything it has. Counted here rather than in `stages.js`
 * because `stages.js` counts nothing.
 *
 * @param {ReturnType<import('./legality.js').checkPlacement>|null} placement
 * @returns {Record<string, number>}
 */
export function placementFindingCounts(placement) {
  /** @type {Record<string, number>} */
  const counts = {};
  if (placement === null || placement === undefined) return counts;
  for (const [key, entry] of Object.entries(placement.findingInstances)) counts[key] = entry.count;
  return counts;
}

/**
 * How many blocking and compromise findings one placement carries in total,
 * ignoring what the baseline already accepted.
 *
 * Not a score and not weighed: it is the tie-break `chooseSlot()` uses among
 * slots the objective values identically. Charging quality relative to the
 * baseline is what stops a game being moved off its published slot to repair an
 * accepted exception; this is what stops the same game **spreading** that
 * exception to a slot that did not have it, when the two cost the same.
 *
 * @param {ReturnType<import('./legality.js').checkPlacement>|null} placement
 * @returns {number}
 */
export function placementFindingTotal(placement) {
  let total = 0;
  if (placement === null || placement === undefined) return total;
  // Counted straight off the findings rather than through
  // {@link placementFindingCounts}: this runs once per candidate slot, and a
  // throwaway map per candidate is the allocation churn the decorate-sort in
  // `inventory.js` was cleaned up to avoid.
  for (const finding of placement.findings) {
    if (
      finding.severity === CONSTRAINT_SEVERITY.BLOCKING ||
      finding.severity === CONSTRAINT_SEVERITY.COMPROMISE
    ) {
      total += 1;
    }
  }
  return total;
}

/**
 * The terms one candidate slot for one game carries.
 *
 * The quality half is **consumed** from `checkPlacement()` — which is Phase 1.3's
 * `checkKickoffAvailability()` re-severitied by the Phase 2.1 registry — rather
 * than re-derived here. This file weighs; it does not decide what is illegal.
 *
 * ## Quality is charged **against what the schedule already carried**
 *
 * `accepted` is what the published schedule's record accepts **at this candidate
 * slot**, per instance (`resolve/instances.js` `acceptedAtSlot()`), and only the *excess* over that is counted. Without it the
 * objective scores quality absolutely while the gate that admits a candidate
 * (`newBlockingCodes()` in `stages.js`) compares against the baseline, and the
 * two disagree in the one direction that matters: a game standing on a
 * baseline-accepted blocking finding scores a full `blockingViolation` at its own
 * published slot and a fraction of that anywhere clean, so the placer moves it
 * off its published time to repair a violation the gate had already accepted.
 * A change request is not asked to repair the schedule it was handed, and it may
 * not charge a family a new kickoff time for doing so.
 *
 * The clamp at zero matters as much as the subtraction: a candidate that carries
 * *fewer* findings than the baseline is not paid a bonus for it, because a
 * negative quality term would let a solver buy a move with somebody else's
 * accepted exception — and because the short-circuits in `chooseSlot()` rest on
 * every quality term being non-negative.
 *
 * @param {Object} input
 * @param {import('./types.js').Slot|null} input.reference - where the game is held from
 * @param {import('./types.js').Slot} input.slot - the candidate
 * @param {ReturnType<import('./legality.js').checkPlacement>|null} [input.placement]
 * @param {Readonly<Record<string, number>>} [input.accepted] - {@link placementFindingCounts} for the baseline slot
 * @returns {Record<string, number>}
 */
export function candidateObjectiveCounts(input) {
  /** @type {Record<string, number>} */
  const counts = { ...changeCountsFor(input.reference, input.slot) };
  const placement = input.placement ?? null;
  if (placement === null) return counts;
  const accepted = input.accepted ?? {};

  let blocking = 0;
  let compromise = 0;
  // Per **instance**, the key the gate admits by (`resolve/instances.js`): a
  // clash with a different opponent is a different breach, and discounting it
  // because the baseline carried *a* clash of that code would let the objective
  // prefer the very slot the gate is about to refuse.
  for (const [key, entry] of Object.entries(placement.findingInstances)) {
    const excess = entry.count - (accepted[key] ?? 0);
    if (excess <= 0) continue;
    if (entry.severity === CONSTRAINT_SEVERITY.BLOCKING) blocking += excess;
    else compromise += excess;
  }
  if (blocking > 0) counts[RESOLVE_OBJECTIVE_TERM.BLOCKING_VIOLATION] = blocking;
  if (compromise > 0) counts[RESOLVE_OBJECTIVE_TERM.COMPROMISE_VIOLATION] = compromise;
  return counts;
}

/**
 * The terms a whole schedule carries against a reference schedule.
 *
 * The changed games are enumerated from the **reference**, never from the
 * candidate and never from a move ledger: a game a stage dropped, or one a stage
 * wrote around the gate, has to be counted rather than vanish with the data that
 * would have named it. That is the same rule `diffAgainstBaseline()` follows and
 * the reason incident 1's recovery had to be game by game.
 *
 * @param {Object} input
 * @param {ReadonlyArray<import('./types.js').PlacedGame>} input.referenceGames
 * @param {ReadonlyArray<import('./types.js').PlacedGame>} input.games
 * @param {Object|null} [input.verification] - a `runRuleEngine()` result, or null
 * @returns {Record<string, number>}
 */
export function objectiveCountsForSchedule(input) {
  const placed = new Map(input.games.map((game) => [game.id, game]));
  /** @type {Record<string, number>} */
  const counts = {};
  const add = (term, howMany) => {
    if (howMany > 0) counts[term] = (counts[term] ?? 0) + howMany;
  };

  for (const before of input.referenceGames) {
    const after = placed.get(before.id) ?? null;
    if (after === null) {
      add(RESOLVE_OBJECTIVE_TERM.UNPLACED_GAME, 1);
      continue;
    }
    const terms = changeCountsFor(
      { date: before.date, surfaceId: before.surfaceId, startMinutes: before.startMinutes },
      { date: after.date, surfaceId: after.surfaceId, startMinutes: after.startMinutes }
    );
    for (const [term, count] of Object.entries(terms)) add(term, count);
  }

  const verification = input.verification ?? null;
  if (verification !== null) {
    for (const violation of verification.violations) {
      if (violation.severity === CONSTRAINT_SEVERITY.BLOCKING) {
        add(RESOLVE_OBJECTIVE_TERM.BLOCKING_VIOLATION, 1);
      } else if (violation.severity === CONSTRAINT_SEVERITY.COMPROMISE) {
        add(RESOLVE_OBJECTIVE_TERM.COMPROMISE_VIOLATION, 1);
      }
    }
  }
  return counts;
}

/**
 * Score a whole schedule against a reference. Convenience over the two functions
 * above, and the shape the dry-run report and the change budget both read.
 *
 * @param {Object} input
 * @param {ReadonlyArray<import('./types.js').PlacedGame>} input.referenceGames
 * @param {ReadonlyArray<import('./types.js').PlacedGame>} input.games
 * @param {Object|null} [input.verification] - a `runRuleEngine()` result, or null
 * @param {Readonly<Record<string, number>>} input.weights
 * @returns {ReturnType<typeof scoreObjective> & { qualityMeasured: boolean }}
 */
export function scoreSchedule(input) {
  const counts = objectiveCountsForSchedule(input);
  return {
    ...scoreObjective(counts, input.weights),
    qualityMeasured: (input.verification ?? null) !== null,
  };
}
