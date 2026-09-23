/**
 * The minimal-diff objective, the change budget and the dry run — Prompt 4.2.
 *
 * > *"Today the objective optimises quality alone, so a re-solve returns the
 * > best schedule it can find rather than the nearest acceptable one. Once a
 * > schedule is published, 'nearest' almost always beats 'best.'"*
 *
 * Two acceptance tests, both against the season-2026 corpus:
 *
 * 1. **A re-solve with a change budget of 12 either moves 12 games or fewer, or
 *    fails naming a blocking constraint.** Both halves are exercised, because a
 *    cap that never binds is a cap nobody has tested: the 08/22 seeding
 *    integration moves 8 and comes in under, and a **constructed** request over
 *    one venue's middle wave moves 14 and is refused.
 * 2. **The dry-run report separates requested moves from consequential ones on
 *    the 08/22 seeding-integration scenario**, where moving the 9v9 block was
 *    requested and the knock-on was consequential. The partition is asserted
 *    complete, and every consequential move is asserted to name the constraint
 *    instance that forced it.
 *
 * Every figure below is derived from the corpus at test time. Where a scenario
 * had to be built rather than found, the test says so in the words "constructed"
 * and says what the corpus supplied.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

import { buildAvailabilityCalendarFromSeason2026 } from '@squadlogic/core/availability/index.js';
import {
  SEASON_2026_CONSTRAINT_ID,
  buildSeason2026ConstraintRegistry,
} from '@squadlogic/core/constraints/index.js';
import {
  buildFacilityGraphFromSeason2026,
  buildSeason2026VenueComplexMap,
} from '@squadlogic/core/facility/index.js';
import {
  loadExternalFixtures,
  loadFacilityGeometry,
  loadFacilityPermits,
  loadGameFormats,
  loadSeason2026,
  loadSunsets,
} from '@squadlogic/core/fixtures/index.js';
import { buildFormatTimingTableFromSeason2026 } from '@squadlogic/core/timing/index.js';
import { runRuleEngine, toSeason2026Schedule } from '@squadlogic/core/ruleEngine/index.js';
import { FREEZE_DISPOSITION, freezeAllExcept } from '@squadlogic/core/freeze/index.js';

import {
  ChangeBudgetExceeded,
  MOVE_KIND,
  RESOLVE_CHANGE_TERMS,
  RESOLVE_OBJECTIVE_TERM,
  RESOLVE_OBJECTIVE_WEIGHTS,
  RESOLVE_QUALITY_TERMS,
  RESOLVE_REASON,
  STAGE_PROBE,
  applyChangeRequest,
  buildChangeReport,
  buildSlotInventory,
  candidateObjectiveCounts,
  candidateSlotsFor,
  changeCountsFor,
  changeTermsDisabled,
  checkPlacement,
  commitResolve,
  createResolveLedger,
  createResolveState,
  disabledChangeTerms,
  objectiveCountsForSchedule,
  objectiveWeightsAreDefault,
  placementFindingCounts,
  reoptimiseWholeSeason,
  resolveObjectiveWeights,
  scoreObjective,
  season2026ExternalFixtureChanges,
} from '@squadlogic/core/resolve/index.js';

/* -------------------------------------------------------------------------- */
/* Corpus and engines, loaded once                                             */
/* -------------------------------------------------------------------------- */

const season = loadSeason2026();
const graph = buildFacilityGraphFromSeason2026(loadFacilityGeometry());
const table = buildFormatTimingTableFromSeason2026(loadGameFormats());
const sunsets = loadSunsets();
const SEASON_YEAR = Number(sunsets[0].date.slice(0, 4));
const calendar = buildAvailabilityCalendarFromSeason2026(
  loadFacilityPermits({ seasonYear: SEASON_YEAR }),
  sunsets
);
const registry = buildSeason2026ConstraintRegistry();
const resources = {
  graph,
  timingTable: table,
  calendar,
  venueComplexes: buildSeason2026VenueComplexMap(),
};
const engines = { graph, table, calendar, registry, resources };

const schedule = toSeason2026Schedule(season);
const externalChanges = season2026ExternalFixtureChanges(loadExternalFixtures(), schedule);
const baselineVerification = runRuleEngine(schedule, { registry, resources });

/** The date the seeding integration falls on, found in the data. */
const SEEDING_DATE = [...new Set(externalChanges.map((change) => change.date))].sort()[0];
const baselineById = new Map(schedule.games.map((game) => [game.id, game]));

/** The change budget the build plan names. */
const BUDGET = 12;

/**
 * @param {{ date: string, surfaceId: string, startMinutes: number }|null|undefined} game
 * @returns {string}
 */
const slotOf = (game) =>
  game === null || game === undefined
    ? '(unplaced)'
    : `${game.date}|${game.surfaceId}|${game.startMinutes}`;

/**
 * Which games of a resolved schedule stand somewhere other than the baseline,
 * enumerated from the **baseline's own 679 rows** rather than from the run's own
 * report — so that a report which under-counts is caught rather than believed.
 *
 * @param {import('@squadlogic/core/ruleEngine/types.js').Schedule} resolved
 * @returns {string[]}
 */
function movedGameIds(resolved) {
  const byId = new Map(resolved.games.map((game) => [game.id, game]));
  /** @type {string[]} */
  const moved = [];
  for (const [gameId, before] of baselineById) {
    if (slotOf(before) === slotOf(byId.get(gameId) ?? null)) continue;
    moved.push(gameId);
  }
  return moved.sort();
}

/* -------------------------------------------------------------------------- */
/* The scenarios, assembled once and meta-asserted before anything is judged   */
/* -------------------------------------------------------------------------- */

/**
 * **The 08/22 seeding-integration scenario, as the build plan describes it:**
 * *"moving 9v9 games was requested and the knock-on … was consequential."*
 *
 * The corpus supplies every part of it. Incident 3 is the externally-published
 * 12:30 fixture whose 90-minute footprint overlaps the published 9v9 block by
 * ten minutes; the club resolved it by negotiating the external time earlier.
 * The scenario here is the branch they did **not** take — moving the 9v9 games
 * instead — and it is the one the build plan's acceptance test names. The
 * request is the four late 9v9 games onto the early kickoff on their own ground,
 * `holdChanges` so the times the request states are facts rather than
 * preferences, and the date thawed so that a knock-on is *possible at all*: with
 * maximum freeze nothing else on 08/22 could move and category (b) would be
 * empty for the least interesting reason there is.
 */
const nineVNine = schedule.games
  .filter((game) => game.date === SEEDING_DATE && game.format === '9v9')
  .sort((a, b) => a.startMinutes - b.startMinutes || a.surfaceId.localeCompare(b.surfaceId));
const NINE_KICKOFFS = [...new Set(nineVNine.map((game) => game.startMinutes))].sort(
  (a, b) => a - b
);
const lateNines = nineVNine.filter((game) => game.startMinutes === NINE_KICKOFFS[1]);
const earlyNines = nineVNine.filter((game) => game.startMinutes === NINE_KICKOFFS[0]);

const nineChanges = lateNines.map((game) => ({
  gameId: game.id,
  date: SEEDING_DATE,
  surfaceId: game.surfaceId,
  startMinutes: NINE_KICKOFFS[0],
  reason: 'the 9v9 block moves, instead of the externally-published fixture',
}));

const seedingRun = applyChangeRequest({
  schedule,
  changes: nineChanges,
  engines,
  freeze: freezeAllExcept([{ date: SEEDING_DATE }]),
  baselineVerification,
  holdChanges: true,
  onUnsatisfiable: 'report',
  changeBudget: BUDGET,
});

/**
 * **The constructed budget-binding scenario.**
 *
 * The seeding scenario above moves 8 games, so a budget of 12 does not bind on
 * it and a test that only used it would assert nothing. Rather than lower the
 * cap the build plan names, this asks for something bigger on the same date and
 * out of the same corpus: Maplewood Back plays 20 games across three waves on
 * seven fields on 08/22, and this slides the whole middle wave onto the late
 * kickoff. Seven requested moves, seven games already standing there that must
 * give way — 14, which is over.
 */
const middleWave = schedule.games
  .filter((game) => game.date === SEEDING_DATE && game.venueId === 'maplewood-back')
  .sort((a, b) => a.startMinutes - b.startMinutes);
const WAVES = [...new Set(middleWave.map((game) => game.startMinutes))].sort((a, b) => a - b);
const waveChanges = middleWave
  .filter((game) => game.startMinutes === WAVES[1])
  .map((game) => ({
    gameId: game.id,
    date: SEEDING_DATE,
    surfaceId: game.surfaceId,
    startMinutes: WAVES[2],
    reason: 'the middle wave slides onto the late kickoff',
  }));

/** @param {number|null} budget */
const waveRun = (budget) =>
  applyChangeRequest({
    schedule,
    changes: waveChanges,
    engines,
    freeze: freezeAllExcept([{ date: SEEDING_DATE }]),
    baselineVerification,
    holdChanges: true,
    onUnsatisfiable: 'report',
    changeBudget: budget,
  });

const waveUnbudgeted = waveRun(null);
const waveBudgeted = waveRun(BUDGET);

describe('the scenarios, before anything is judged', () => {
  it('takes the 9v9 block and the knock-on from the corpus, not from a fixture written for it', () => {
    // Meta-assertions. Each one, mis-set, would make the acceptance test below
    // pass while examining nothing.
    expect(NINE_KICKOFFS).toHaveLength(2);
    expect(lateNines.length).toBeGreaterThan(0);
    expect(earlyNines.length).toBe(lateNines.length);
    // The two waves stand on the same ground, which is why asking one to move
    // onto the other's kickoff forces a knock-on rather than finding free air.
    expect(lateNines.map((game) => game.surfaceId).sort()).toEqual(
      earlyNines.map((game) => game.surfaceId).sort()
    );
    // Every game named is a real published row, and none of them is one the
    // external fixtures name — the request is about the 9v9 block.
    const external = new Set(externalChanges.map((change) => change.gameId));
    for (const change of nineChanges) {
      expect(baselineById.has(change.gameId)).toBe(true);
      expect(external.has(change.gameId)).toBe(false);
    }
  });

  it('has a knock-on that lands on real people, or category (b) is an abstraction', () => {
    // The commitments come from the roster-derived coach timelines, so this is
    // enumerated from the people rather than from the games that would vanish
    // with them.
    const affected = schedule.commitments.filter((commitment) =>
      earlyNines.some((game) => game.id === commitment.gameId)
    );
    expect(affected.length).toBeGreaterThan(0);
    expect(new Set(affected.map((commitment) => commitment.personId)).size).toBeGreaterThan(1);
  });

  it('builds the budget-binding scenario out of one venue’s three published waves', () => {
    expect(WAVES).toHaveLength(3);
    expect(waveChanges.length).toBeGreaterThan(0);
    const late = middleWave.filter((game) => game.startMinutes === WAVES[2]);
    // Every field in the middle wave is occupied at the late kickoff too, so
    // every requested move displaces exactly one published game.
    // Named, not counted: the fields whose late kickoff is free would displace
    // nobody, and a scenario resting on "most of them clash" is a scenario that
    // stops binding the day the corpus is re-cut.
    expect(
      waveChanges
        .filter((change) => !late.some((game) => game.surfaceId === change.surfaceId))
        .map((change) => change.surfaceId)
    ).toEqual([]);
    expect(waveChanges.length + late.length).toBeGreaterThan(BUDGET);
  });
});

/* -------------------------------------------------------------------------- */
/* The objective                                                               */
/* -------------------------------------------------------------------------- */

describe('the objective', () => {
  it('weighs change and quality as two families of one score', () => {
    expect([...RESOLVE_CHANGE_TERMS, ...RESOLVE_QUALITY_TERMS].sort()).toEqual(
      Object.values(RESOLVE_OBJECTIVE_TERM).sort()
    );
    // Disjoint: a term that counted as both would be added to the total twice.
    for (const term of RESOLVE_CHANGE_TERMS) {
      expect(RESOLVE_QUALITY_TERMS).not.toContain(term);
    }
  });

  it('states its defaults as an ordering rather than as tuned numbers', () => {
    // The weights are policy — nothing in the corpus can supply them — so what
    // is pinned is the ordering they express, which is the thing a reader has to
    // be able to argue with.
    const w = RESOLVE_OBJECTIVE_WEIGHTS;
    expect(w.unplacedGame).toBeGreaterThan(w.blockingViolation);
    expect(w.blockingViolation).toBeGreaterThan(w.changedGame);
    // "Nearest beats best", in one line: a moved game costs ten compromises.
    expect(w.changedGame).toBe(w.compromiseViolation * 10);
    expect(w.compromiseViolation).toBeGreaterThan(w.driftMinute);
    expect(w.driftMinute).toBeGreaterThan(0);
    expect(w.changedSurface).toBeGreaterThan(0);
  });

  it('is configurable, and refuses a configuration it would have to guess at', () => {
    expect(resolveObjectiveWeights(undefined)).toBe(RESOLVE_OBJECTIVE_WEIGHTS);
    expect(resolveObjectiveWeights({ changedGame: 5 }).changedGame).toBe(5);
    // …and leaves the rest alone.
    expect(resolveObjectiveWeights({ changedGame: 5 }).blockingViolation).toBe(
      RESOLVE_OBJECTIVE_WEIGHTS.blockingViolation
    );
    // A misspelt term is refused rather than ignored: a caller who wrote the
    // plural and got the defaults back has been told nothing.
    expect(() => resolveObjectiveWeights({ changedGames: 0 })).toThrow(/not an objective term/);
    expect(() => resolveObjectiveWeights({ changedGame: -1 })).toThrow(/finite number/);
    expect(() => resolveObjectiveWeights({ changedGame: Number.NaN })).toThrow(/finite number/);
    // The cast is the point: the type already refuses this, which is the first
    // line of the defence and not the only one.
    expect(() =>
      resolveObjectiveWeights(/** @type {Record<string, number>} */ (/** @type {unknown} */ (7)))
    ).toThrow(TypeError);
    // And a counted term nothing weighs is a number nobody reads.
    expect(() => scoreObjective({ somethingElse: 1 }, RESOLVE_OBJECTIVE_WEIGHTS)).toThrow(
      /not a term it weighs/
    );
  });

  it('counts a game that did not move as costing nothing at all', () => {
    const slot = { date: SEEDING_DATE, surfaceId: 'alder-park/pitch-1a', startMinutes: 510 };
    expect(changeCountsFor(slot, { ...slot })).toEqual({});
    expect(
      scoreObjective(changeCountsFor(slot, { ...slot }), RESOLVE_OBJECTIVE_WEIGHTS).total
    ).toBe(0);
    // A move on the same ground costs the game plus its drift.
    const later = { ...slot, startMinutes: slot.startMinutes + 30 };
    const counts = changeCountsFor(slot, later);
    expect(counts[RESOLVE_OBJECTIVE_TERM.CHANGED_GAME]).toBe(1);
    expect(counts[RESOLVE_OBJECTIVE_TERM.DRIFT_MINUTE]).toBe(30);
    expect(counts[RESOLVE_OBJECTIVE_TERM.CHANGED_SURFACE]).toBe(0);
    // Across dates the drift is **not counted**: minutes past midnight on two
    // different days are not a distance, and this package holds no calendar
    // that could turn them into one (GAP-32).
    const nextWeek = { ...slot, date: '2026-08-29', startMinutes: 900 };
    expect(changeCountsFor(slot, nextWeek)[RESOLVE_OBJECTIVE_TERM.DRIFT_MINUTE]).toBe(0);
    expect(changeCountsFor(slot, nextWeek)[RESOLVE_OBJECTIVE_TERM.CHANGED_GAME]).toBe(1);
  });

  it('scores the published season against itself at zero change and its own quality', () => {
    const counts = objectiveCountsForSchedule({
      referenceGames: schedule.games,
      games: schedule.games,
      verification: baselineVerification,
    });
    for (const term of RESOLVE_CHANGE_TERMS) expect(counts[term] ?? 0).toBe(0);
    // …and the quality half is the season's own accepted exceptions, consumed
    // from the rule engine rather than counted again here.
    const compromises = baselineVerification.violations.filter(
      (violation) => violation.severity === 'compromise'
    ).length;
    expect(compromises).toBeGreaterThan(0);
    expect(counts[RESOLVE_OBJECTIVE_TERM.COMPROMISE_VIOLATION]).toBe(compromises);
    const score = scoreObjective(counts, RESOLVE_OBJECTIVE_WEIGHTS);
    expect(score.changeCost).toBe(0);
    expect(score.qualityCost).toBe(score.total);
  });

  it('knows when its change terms have been switched off', () => {
    expect(changeTermsDisabled(RESOLVE_OBJECTIVE_WEIGHTS)).toBe(false);
    expect(
      changeTermsDisabled(
        resolveObjectiveWeights({ changedGame: 0, driftMinute: 0, changedSurface: 0 })
      )
    ).toBe(true);
    // Two of three is not "switched off", and must not read as it.
    expect(changeTermsDisabled(resolveObjectiveWeights({ changedGame: 0, driftMinute: 0 }))).toBe(
      false
    );
  });

  it('orders the slots a game is offered, and a run with no change terms orders them differently', () => {
    const run = applyChangeRequest({
      schedule,
      changes: externalChanges,
      engines,
      verify: false,
    });
    const game = /** @type {Object} */ (baselineById.get(externalChanges[0].gameId));
    const anchor = { date: game.date, surfaceId: game.surfaceId, startMinutes: game.startMinutes };

    const nearest = candidateSlotsFor(run.state, game.id, anchor, RESOLVE_OBJECTIVE_WEIGHTS);
    const anywhere = candidateSlotsFor(
      run.state,
      game.id,
      anchor,
      resolveObjectiveWeights({ changedGame: 0, driftMinute: 0, changedSurface: 0 })
    );

    // Meta-assertion: enough candidates for an ordering to mean anything.
    expect(nearest.length).toBeGreaterThan(3);
    // Under the default objective the slot the game already has sorts first.
    expect(slotOf(nearest[0])).toBe(slotOf(anchor));
    // With the change terms at zero nothing prefers it, and the deterministic
    // tie-break — earliest kickoff, then surface — decides instead. That is what
    // `earliest-legal-first` was before Prompt 4.2 collapsed the two hand-written
    // orderings into the objective.
    expect(anywhere.map(slotOf)).not.toEqual(nearest.map(slotOf));
    expect(anywhere[0].startMinutes).toBe(Math.min(...anywhere.map((slot) => slot.startMinutes)));
    // Same candidates either way: the weights order the offer, they never widen
    // it. Inventing a slot is what this package structurally cannot do.
    expect(anywhere.map(slotOf).sort()).toEqual(nearest.map(slotOf).sort());
  });

  it('is what the placer actually consults, not a report written beside it', () => {
    // The counter only moves inside `chooseSlot()`, which is the one place a
    // slot is chosen. A run that placed games without scoring them would leave
    // it at zero while every other assertion in this file still passed.
    expect(seedingRun.meta.candidatesScored).toBeGreaterThan(0);
    expect(seedingRun.meta.candidatesEvaluated).toBeGreaterThanOrEqual(
      seedingRun.meta.candidatesScored
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Acceptance test 1 — the change budget of 12                                 */
/* -------------------------------------------------------------------------- */

describe('the acceptance test :: a re-solve with a change budget of 12', () => {
  it('comes in under the cap on the 08/22 seeding integration, and says the cap was checked', () => {
    const moved = movedGameIds(seedingRun.schedule);
    expect(moved.length).toBeLessThanOrEqual(BUDGET);
    expect(seedingRun.budget.limit).toBe(BUDGET);
    expect(seedingRun.budget.moved).toBe(moved.length);
    expect(seedingRun.budget.withinBudget).toBe(true);
    // A budget nothing reports on cannot be told apart from a budget nobody
    // checked — declared is not enforced.
    const met = seedingRun.findings.find(
      (finding) => finding.code === RESOLVE_REASON.RESOLVE_CHANGE_BUDGET_MET
    );
    expect(met?.severity).toBe('info');
    expect(met?.details.moved).toBe(moved.length);
    expect(seedingRun.findings.map((finding) => finding.code)).not.toContain(
      RESOLVE_REASON.RESOLVE_CHANGE_BUDGET_EXCEEDED
    );
  });

  it('fails, naming a blocking constraint, when the cap genuinely binds', () => {
    // **The half that exercises the cap.** Established first, without a budget:
    // this request moves more than twelve games, so the cap below is not
    // decoration.
    const unbudgeted = movedGameIds(waveUnbudgeted.schedule);
    expect(unbudgeted.length).toBeGreaterThan(BUDGET);
    expect(waveUnbudgeted.budget.limit).toBeNull();
    expect(waveUnbudgeted.status).not.toBe('rejected');

    const moved = movedGameIds(waveBudgeted.schedule);
    expect(moved).toEqual(unbudgeted);
    expect(waveBudgeted.budget.withinBudget).toBe(false);

    const exceeded = /** @type {Object} */ (
      waveBudgeted.findings.find(
        (finding) => finding.code === RESOLVE_REASON.RESOLVE_CHANGE_BUDGET_EXCEEDED
      )
    );
    expect(exceeded.severity).toBe('blocking');
    expect(exceeded.details.budget).toBe(BUDGET);
    expect(exceeded.details.moved).toBe(moved.length);
    // **Named**, and named from the registry rather than from a string in this
    // file: the constraint that forced the consequential half.
    expect(exceeded.details.constraintId).toBe(
      SEASON_2026_CONSTRAINT_ID.FIELD_SAME_GROUND_EXCLUSIVE
    );
    expect(registry.byId[String(exceeded.details.constraintId)]).toBeTruthy();
    // The failure is loud enough to stop a commit, which is the only place it
    // could do any good.
    expect(waveBudgeted.status).toBe('rejected');
  });

  it('spends the budget on requested and consequential moves alike, and says which is which', () => {
    // The cap is on **games that move**, whoever asked. An operator who is told
    // "12" and gets 7 requested plus 7 nobody asked about has not been given a
    // budget; they have been given a headline.
    const budget = waveBudgeted.budget;
    expect(budget.requested + budget.consequential).toBe(budget.moved);
    expect(budget.requested).toBeGreaterThan(0);
    expect(budget.consequential).toBeGreaterThan(0);
    expect(budget.requested).toBeLessThanOrEqual(BUDGET);
  });

  it('satisfies the acceptance criterion as a disjunction, on every run in this file', () => {
    // "…either produces <= 12 moves or fails with a named blocking constraint",
    // asserted as written, over both scenarios at once.
    for (const run of [seedingRun, waveBudgeted]) {
      const moved = movedGameIds(run.schedule).length;
      if (moved <= BUDGET) {
        expect(run.budget.withinBudget).toBe(true);
        continue;
      }
      const exceeded = /** @type {Object} */ (
        run.findings.find(
          (finding) => finding.code === RESOLVE_REASON.RESOLVE_CHANGE_BUDGET_EXCEEDED
        )
      );
      expect(exceeded.severity).toBe('blocking');
      expect(String(exceeded.details.constraintId).length).toBeGreaterThan(0);
    }
  });

  it('never silently commits a diff bigger than the budget', () => {
    let error = null;
    try {
      commitResolve(waveBudgeted, { acknowledged: true });
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(ChangeBudgetExceeded);
    const raised = /** @type {any} */ (error);
    expect(raised.budget).toBe(BUDGET);
    expect(raised.moved).toBeGreaterThan(BUDGET);
    expect(raised.constraintId).toBe(SEASON_2026_CONSTRAINT_ID.FIELD_SAME_GROUND_EXCLUSIVE);
    expect(raised.constraintIds).toEqual(waveBudgeted.budget.blockingConstraintIds);
    expect(raised.requested + raised.consequential).toBe(raised.moved);
    expect(raised.consequentialMoves.length).toBe(raised.consequential);
    expect(raised.message).toContain('Nothing has been committed');
    // **No override.** The budget is the one refusal with no way past it: a
    // caller willing to move more games says so by naming a bigger number.
    expect(() =>
      commitResolve(waveBudgeted, {
        acknowledged: true,
        acceptFindingCodes: [RESOLVE_REASON.RESOLVE_CHANGE_BUDGET_EXCEEDED],
      })
    ).toThrow(ChangeBudgetExceeded);
    // Naming a number they are willing to live with does work, and the run that
    // results records it.
    const wider = waveRun(raised.moved);
    expect(wider.budget.withinBudget).toBe(true);
    expect(wider.budget.limit).toBe(raised.moved);
  });
});

/* -------------------------------------------------------------------------- */
/* Acceptance test 2 — the dry-run report on the 08/22 scenario                */
/* -------------------------------------------------------------------------- */

describe('the acceptance test :: requested moves and consequential ones, on 08/22', () => {
  const report = seedingRun.report;
  const requestedIds = new Set(nineChanges.map((change) => change.gameId));

  it('is not vacuous: the request moved things and other things moved after it', () => {
    // Without both halves above zero the separation below is a statement about
    // the empty set.
    expect(report.meta.movedRequested).toBeGreaterThan(0);
    expect(report.meta.movedConsequential).toBeGreaterThan(0);
    expect(report.meta.changesRequested).toBe(nineChanges.length);
  });

  it('partitions every moved game into exactly one category', () => {
    // Enumerated from the baseline's own rows, never from the report being
    // judged: a report that under-counts is caught here rather than believed.
    const moved = movedGameIds(seedingRun.schedule);
    const inA = report.requested.filter((entry) => entry.moved).map((entry) => entry.gameId);
    const inB = report.consequential.map((entry) => entry.gameId);
    expect([...inA, ...inB].sort()).toEqual(moved);
    // Complete **and** disjoint, counted rather than assumed.
    expect(inA.filter((gameId) => inB.includes(gameId))).toEqual([]);
    expect(inA.length + inB.length).toBe(moved.length);
    expect(new Set([...inA, ...inB]).size).toBe(moved.length);
    expect(report.meta.partitionComplete).toBe(true);
    expect(seedingRun.findings.map((finding) => finding.code)).not.toContain(
      RESOLVE_REASON.RESOLVE_REPORT_PARTITION_INCOMPLETE
    );
  });

  it('puts the 9v9 games the request named in category (a), with what became of each', () => {
    expect(report.requested.map((entry) => entry.gameId).sort()).toEqual([...requestedIds].sort());
    for (const entry of report.requested) {
      expect(entry.outcome).toBe('applied');
      expect(entry.after).toBe(entry.requestedSlot);
      expect(entry.before).not.toBe(entry.after);
      expect(entry.moved).toBe(true);
      expect(String(entry.label), entry.gameId).toContain(' v ');
      // The people on the games the operator *asked* to move are named too:
      // category (a) is who you knew you were telling, and (b) is who you did
      // not.
      expect(entry.personIds.length, entry.gameId).toBeGreaterThan(0);
      // Held at what the request stated, because `holdChanges` says these times
      // are facts rather than preferences.
      expect(entry.disposition).toBe(FREEZE_DISPOSITION.FROZEN);
    }
  });

  it('reports what would be left with no time at all, and here that is nothing', () => {
    // The report's own TIME TBD list, mirroring the run's. On this scenario the
    // two waves swap cleanly and nothing is stranded — which is only worth
    // asserting because the same request against a held 12:30 external fixture
    // strands four games, and the field would otherwise be produced and never
    // read.
    expect(report.unplaced).toEqual([]);
    expect(report.unplaced.length).toBe(seedingRun.unplaced.length);
    expect(report.quality.resolved).toEqual([]);
  });

  it('puts the knock-on in category (b) — and names the constraint instance that forced each', () => {
    // **The deliverable.** Not "something else moved", but which game, from
    // where to where, broken by which reason code, governed by which registry
    // constraint, clashing with which specific other game, bound by which edge
    // and short by how many minutes.
    expect(report.consequential.length).toBe(earlyNines.length);
    expect(report.consequential.map((entry) => entry.gameId).sort()).toEqual(
      earlyNines.map((game) => game.id).sort()
    );

    for (const entry of report.consequential) {
      expect(entry.causeKind, entry.gameId).toBe('constraint');
      expect(String(entry.codes), entry.gameId).toContain('OCCUPIED_SAME_SURFACE');
      // The registry constraint, looked up rather than typed in.
      expect(entry.constraintId, entry.gameId).toBe(
        SEASON_2026_CONSTRAINT_ID.FIELD_SAME_GROUND_EXCLUSIVE
      );
      expect(registry.byId[String(entry.constraintId)]).toBeTruthy();
      expect(registry.idsByReasonCode.OCCUPIED_SAME_SURFACE).toContain(entry.constraintId);
      // The **instance**: the specific game it clashed with, which is one of the
      // games the request named.
      expect(entry.counterpartGameIds.length, entry.gameId).toBeGreaterThan(0);
      for (const counterpart of entry.counterpartGameIds) {
        expect(requestedIds.has(counterpart), counterpart).toBe(true);
      }
      // Phase 1.3's tightness ordering, consumed rather than re-derived: the
      // edge that bound and by how many minutes it was missed.
      expect(entry.bindingKinds, entry.gameId).toEqual(['occupancy']);
      expect(entry.slackMinutes, entry.gameId).toBeLessThan(0);
      expect(entry.forcedByStageId, entry.gameId).toBe('dislodge');
      expect(entry.before).not.toBe(entry.after);
      // Which field of the slot changed, and the sentence the deciding stage
      // wrote for a human — both carried, neither parsed.
      expect(entry.changedFields, entry.gameId).toEqual(['startMinutes']);
      expect(String(entry.reason), entry.gameId).toContain('clash with');
      expect(entry.disposition, entry.gameId).toBe(FREEZE_DISPOSITION.THAWED);
    }
    // Stated once more as a count, because "each" is the assertion that matters.
    expect(report.meta.movedConsequentialExplained).toBe(report.meta.movedConsequential);
    expect(seedingRun.meta.movedConsequentialExplained).toBe(seedingRun.meta.movedConsequential);
    expect(seedingRun.findings.map((finding) => finding.code)).not.toContain(
      RESOLVE_REASON.RESOLVE_CONSEQUENTIAL_MOVE_UNEXPLAINED
    );
  });

  it('names the people each consequential move lands on', () => {
    // *"It's what nobody notices until families complain."* The person keys come
    // from the schedule's own commitments — the roster-derived timeline — so the
    // report can say whose Saturday changed rather than only that one did.
    expect(report.meta.peopleNamed).toBeGreaterThan(0);
    for (const entry of report.consequential) {
      expect(entry.personIds.length, entry.gameId).toBeGreaterThan(0);
      for (const personId of entry.personIds) {
        expect(schedule.personUniverse, personId).toContain(personId);
      }
    }
  });

  it('reports the knock-on to coach assignments as a quality delta (c)', () => {
    // The 9v9 block swapping waves moves four coaches' Saturdays, and two of
    // them end up short of the between-venues travel floor. That is only
    // visible because a commitment follows its game through
    // `resolvedScheduleOf()`; on the baseline's commitment times the whole
    // column would read clean.
    expect(report.quality.measured).toBe(true);
    const travel = report.quality.introduced.find((entry) =>
      entry.code.startsWith('TRAVEL_BETWEEN_VENUES')
    );
    expect(travel?.delta).toBeGreaterThan(0);
    expect(travel?.resolved).toBeGreaterThan(travel?.baseline ?? 0);
    // The delta agrees with the `verify` stage's own findings, which are
    // produced by a different pass over the same rule-engine run.
    const introduced = seedingRun.findings.filter(
      (finding) => finding.code === RESOLVE_REASON.RESOLVE_VERIFY_NEW_VIOLATION
    );
    expect(introduced.map((finding) => finding.details.code).sort()).toEqual(
      report.quality.introduced.map((entry) => entry.code).sort()
    );
    for (const finding of introduced) {
      const entry = report.quality.byCode[String(finding.details.code)];
      expect(entry.delta).toBe(finding.details.introduced);
      expect(entry.baseline).toBe(finding.details.baselineCount);
    }
  });

  it('scores the trade it made, in one objective, against the published season', () => {
    const objective = report.objective;
    expect(objective.weights).toBe(RESOLVE_OBJECTIVE_WEIGHTS);
    expect(objective.changeTermsDisabled).toBe(false);
    // The baseline scores zero change against itself, by construction.
    expect(objective.baseline.changeCost).toBe(0);
    // …and this run pays for every game it moved.
    expect(objective.resolvedSchedule.terms.changedGame.count).toBe(report.meta.movedGames);
    expect(objective.resolvedSchedule.changeCost).toBeGreaterThan(0);
    expect(objective.delta).toBe(objective.resolvedSchedule.total - objective.baseline.total);
    // A change request that moved eight games and cost two travel shortfalls is
    // worse than the season it started from, and the objective says so rather
    // than reporting a clean run.
    expect(objective.delta).toBeGreaterThan(0);
  });

  it('catches a consequential move nothing can explain — category (b)’s positive control', () => {
    // **The assertion that gives the rest of this block its teeth.** A report in
    // which every consequential move names a constraint proves nothing unless a
    // move that names none is caught. This stage reaches around the writer, so
    // its victim appears in the baseline diff with no entry in the move ledger
    // and therefore no cause at all — which is exactly the shape of a game that
    // moved for a reason nobody recorded.
    const rogue = {
      id: 'rogue-nudge',
      title: 'A stage that moves a game nobody asked about, without going through the writer',
      freezeContract: {
        mutationKinds: [MOVE_KIND.RELOCATE],
        probe: STAGE_PROBE.OFFERS_FROZEN_MOVE,
        claim: 'claims to honour the freeze and reaches around the writer instead',
      },
      /** @param {Object} state */
      run(state) {
        const target = /** @type {string} */ (
          state.gameIds.find(
            (id) => state.games[id] && !nineChanges.some((change) => change.gameId === id)
          )
        );
        const game = state.games[target];
        return {
          ...state,
          games: {
            ...state.games,
            [target]: { ...game, startMinutes: game.startMinutes + 5 },
          },
        };
      },
    };
    const run = applyChangeRequest({
      schedule,
      changes: nineChanges,
      engines,
      freeze: freezeAllExcept([{ date: SEEDING_DATE }]),
      holdChanges: true,
      onUnsatisfiable: 'report',
      extraStages: [rogue],
      verify: false,
    });

    const unexplained = run.findings.filter(
      (finding) => finding.code === RESOLVE_REASON.RESOLVE_CONSEQUENTIAL_MOVE_UNEXPLAINED
    );
    expect(unexplained).toHaveLength(1);
    expect(unexplained[0].severity).toBe('blocking');
    expect(baselineById.has(String(unexplained[0].details.gameId))).toBe(true);
    expect(run.meta.movedConsequentialExplained).toBeLessThan(run.meta.movedConsequential);
    expect(run.status).toBe('rejected');
    // …and the game is still in the report by name, because category (b) is
    // enumerated from the baseline rather than from the ledger the rogue stage
    // never wrote to.
    const entry = run.report.consequential.find(
      (candidate) => candidate.gameId === unexplained[0].details.gameId
    );
    expect(entry?.causeKind).toBeNull();
  });

  it('counts a game twice as a broken partition, not as a bigger diff', () => {
    // The partition check's own positive control, through the exported builder:
    // a `moved` list naming one game twice double-counts it in category (b) and
    // spends the change budget on nothing. The check counts appearances rather
    // than restating how the two lists were built, so it can fail.
    const doubled = buildChangeReport({
      name: 'a diff that names one game twice',
      baselineSchedule: schedule,
      schedule: seedingRun.schedule,
      changes: nineChanges,
      moved: [...seedingRun.moved, seedingRun.moved[seedingRun.moved.length - 1]],
      unplaced: [],
      moves: seedingRun.moves,
      state: seedingRun.state,
      baselineVerification,
      verification: seedingRun.verification,
      weights: RESOLVE_OBJECTIVE_WEIGHTS,
      changeBudget: null,
    });
    const finding = doubled.findings.find(
      (candidate) => candidate.code === RESOLVE_REASON.RESOLVE_REPORT_PARTITION_INCOMPLETE
    );
    expect(finding?.severity).toBe('blocking');
    expect(doubled.meta.partitionComplete).toBe(false);
    // …and silent on the honest report built from the same run.
    expect(report.meta.partitionComplete).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Dry run by default, commit as a named second step                           */
/* -------------------------------------------------------------------------- */

describe('a re-solve is a dry run, and committing is a different verb', () => {
  it('comes back uncommitted from both entry points, whatever the caller passes', () => {
    expect(seedingRun.committed).toBe(false);
    expect(seedingRun.report.dryRun).toBe(true);
    const stamped = seedingRun.findings.find(
      (finding) => finding.code === RESOLVE_REASON.RESOLVE_DRY_RUN
    );
    expect(stamped?.severity).toBe('info');
    expect(stamped?.details.movedGames).toBe(seedingRun.report.meta.movedGames);

    // There is no argument that changes this. The safe thing is not the default
    // among options; it is the only thing either entry point can produce.
    const global = reoptimiseWholeSeason({
      schedule,
      changes: externalChanges,
      engines,
      reason: 'checking that a global re-solve is a dry run too',
      acknowledged: true,
      verify: false,
    });
    expect(global.committed).toBe(false);
    expect(global.report.dryRun).toBe(true);
  });

  it('commits only when asked, by name, with a literal acknowledgement', () => {
    expect(() =>
      commitResolve(seedingRun, { acknowledged: /** @type {true} */ (true) })
    ).not.toThrow();
    const committed = commitResolve(seedingRun, { acknowledged: true, committedBy: 'a-test' });
    expect(committed.committed).toBe(true);
    expect(committed.schedule).toBe(seedingRun.schedule);
    expect(committed.report).toBe(seedingRun.report);
    expect(committed.committedBy).toBe('a-test');
    expect(committed.acceptedFindingCodes).toEqual([]);
    expect(Object.isFrozen(committed)).toBe(true);
    // Everything an operator would publish travels with it, and the schedule it
    // came from travels beside it so the two can still be diffed after the fact.
    expect(committed.baselineSchedule).toBe(seedingRun.baselineSchedule);
    expect(committed.baselineSchedule.games).toHaveLength(schedule.games.length);
    expect(committed.moved).toBe(seedingRun.moved);
    expect(committed.unplaced).toEqual(seedingRun.unplaced);
    expect(committed.run).toBe(seedingRun);
    // The run itself is untouched: committing does not rewrite the proposal it
    // was given, so the two can still be compared.
    expect(seedingRun.committed).toBe(false);
  });

  it('refuses anything that is not somebody saying yes', () => {
    // Truthy is not an acknowledgement, which is the same ruling
    // `reoptimiseWholeSeason()` makes about its own.
    for (const value of [undefined, false, 1, 'yes', {}]) {
      expect(() =>
        commitResolve(seedingRun, {
          acknowledged: /** @type {true} */ (/** @type {unknown} */ (value)),
        })
      ).toThrow(TypeError);
    }
    expect(() =>
      commitResolve(/** @type {any} */ ({ nothing: true }), { acknowledged: true })
    ).toThrow(TypeError);
    // …and a committed result is not a run, so it cannot be committed again.
    const committed = commitResolve(seedingRun, { acknowledged: true });
    expect(() => commitResolve(/** @type {any} */ (committed), { acknowledged: true })).toThrow(
      /already been committed/
    );
  });

  it('refuses a run carrying blocking findings unless each is accepted by code', () => {
    // A global re-optimisation always carries `FREEZE_GLOBAL_REOPTIMISATION` at
    // blocking, by design: it can never come back clean. Committing one is
    // therefore possible only by naming exactly what is being accepted, and the
    // codes accepted are recorded on the commit.
    const global = reoptimiseWholeSeason({
      schedule,
      changes: externalChanges,
      engines,
      reason: 'committing a global re-optimisation, deliberately',
      acknowledged: true,
      baselineVerification,
    });
    expect(global.status).toBe('rejected');
    let error = null;
    try {
      commitResolve(global, { acknowledged: true });
    } catch (thrown) {
      error = thrown;
    }
    expect(String(error)).toContain('FREEZE_GLOBAL_REOPTIMISATION');
    expect(String(error)).toContain('has NOT been committed');

    const committed = commitResolve(global, {
      acknowledged: true,
      acceptFindingCodes: ['FREEZE_GLOBAL_REOPTIMISATION'],
    });
    expect(committed.committed).toBe(true);
    expect(committed.acceptedFindingCodes).toEqual(['FREEZE_GLOBAL_REOPTIMISATION']);
  });

  it('refuses a run whose quality was never measured, unless that is accepted too', () => {
    // `verify: false` means the standing rule engine never ran. "No quality
    // delta" and "no quality delta measured" read identically on a report and
    // only one of them is good news, so the refusal is here rather than in a
    // paragraph.
    const unmeasured = applyChangeRequest({
      schedule,
      changes: nineChanges,
      engines,
      freeze: freezeAllExcept([{ date: SEEDING_DATE }]),
      holdChanges: true,
      onUnsatisfiable: 'report',
      verify: false,
    });
    expect(unmeasured.report.quality.measured).toBe(false);
    expect(unmeasured.findings.map((finding) => finding.code)).toContain(
      RESOLVE_REASON.RESOLVE_REPORT_QUALITY_UNMEASURED
    );
    expect(() => commitResolve(unmeasured, { acknowledged: true })).toThrow(
      /quality deltas are unknown rather than empty/
    );
    const committed = commitResolve(unmeasured, {
      acknowledged: true,
      acceptFindingCodes: [RESOLVE_REASON.RESOLVE_REPORT_QUALITY_UNMEASURED],
    });
    expect(committed.committed).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Structural guarantees: one objective, and no fourth fitness function        */
/* -------------------------------------------------------------------------- */

describe('structural guarantees', () => {
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const CORE = path.join(ROOT, 'packages', 'core', 'src');

  /**
   * @param {string} dir
   * @param {ReadonlyArray<string>} extensions
   * @returns {string[]}
   */
  function filesUnder(dir, extensions) {
    /** @type {string[]} */
    const files = [];
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules') continue;
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) files.push(...filesUnder(full, extensions));
      else if (extensions.some((extension) => entry.endsWith(extension))) files.push(full);
    }
    return files;
  }

  const resolveFiles = filesUnder(path.join(CORE, 'resolve'), ['.js']);
  const freezeFiles = filesUnder(path.join(CORE, 'freeze'), ['.js']);
  const sources = [...resolveFiles, ...freezeFiles].map((file) => ({
    file,
    text: readFileSync(file, 'utf8'),
    /** Prose quotes the rules it explains, so the checks below read code only. */
    code: readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ''),
  }));

  it('scans a plausible number of files', () => {
    // The meta-assertion the rest of this block rests on.
    expect(resolveFiles.length).toBeGreaterThanOrEqual(12);
    expect(freezeFiles.length).toBeGreaterThanOrEqual(5);
    expect(sources.every((source) => source.text.length > 0)).toBe(true);
  });

  it('declares exactly one weight table, in one file', () => {
    // `docs/ARCHITECTURE.md` §6.10: the repository already carries two fitness
    // functions with different coefficients and nothing that detects the drift.
    // A third would be the same defect a third time.
    const declaring = sources.filter((source) =>
      /const RESOLVE_OBJECTIVE_WEIGHTS\s*=/.test(source.code)
    );
    expect(declaring.map((source) => path.basename(source.file))).toEqual(['objective.js']);
  });

  it('multiplies a count by a weight in exactly one file, and reads a single weight in no other', () => {
    // Every other consumer — the placer's slot choice, the dry-run report, the
    // change budget — has to come through `scoreObjective()` with the whole
    // table. Two checks, because either alone is easy to slip past: nothing
    // outside `objective.js` may multiply by a weight, and nothing outside it
    // may read one term's weight out of the table to begin with.
    const terms = Object.values(RESOLVE_OBJECTIVE_TERM);
    const single = new RegExp(`weights?(\\.(${terms.join('|')})|\\s*\\[)`);
    const multiplying = sources.filter(
      (source) => /\*\s*weight\b/.test(source.code) || /\bweight\s*\*/.test(source.code)
    );
    expect(multiplying.map((source) => path.basename(source.file))).toEqual(['objective.js']);
    const reading = sources.filter((source) => single.test(source.code));
    expect(reading.map((source) => path.basename(source.file))).toEqual(['objective.js']);
    // …and nothing in either package reaches for the two that already exist.
    for (const source of sources) {
      // Comments stripped: `objective.js`'s own prose names both existing
      // fitness functions in order to explain why it is not a third.
      expect(/computeFitness/.test(source.code), source.file).toBe(false);
      expect(/fitness/i.test(source.code), source.file).toBe(false);
    }
  });

  it('has not been hand-ported anywhere else in the repository', () => {
    // The Edge Function copy of `computeFitness` is a hand-port per its own
    // header comment, and a hand-port is invisible to an import graph. So the
    // check is on the **term names**: if `changedGame` and `compromiseViolation`
    // appear together outside `resolve/`, a second copy of this objective
    // exists.
    const elsewhere = [
      ...filesUnder(CORE, ['.js']).filter((file) => !file.startsWith(path.join(CORE, 'resolve'))),
      ...filesUnder(path.join(ROOT, 'supabase', 'functions'), ['.ts']),
      ...filesUnder(path.join(ROOT, 'frontend', 'src'), ['.js', '.jsx']),
    ];
    // Meta-assertion: this is scanning a real corpus of files, not an empty one.
    expect(elsewhere.length).toBeGreaterThan(100);
    for (const file of elsewhere) {
      const text = readFileSync(file, 'utf8');
      expect(/changedGame/.test(text), file).toBe(false);
      expect(/compromiseViolation/.test(text), file).toBe(false);
    }
  });

  it('has exactly one export that can produce a committed result, and it is named for it', () => {
    /** @type {Array<{ file: string, name: string }>} */
    const producers = [];
    for (const source of sources) {
      for (const match of source.code.matchAll(/committed:\s*true/g)) {
        const before = source.code.slice(0, match.index);
        const declarations = [...before.matchAll(/export function (\w+)/g)];
        producers.push({
          file: source.file,
          name: declarations.length > 0 ? declarations[declarations.length - 1][1] : '(none)',
        });
      }
    }
    expect(producers).toHaveLength(1);
    expect(producers[0].name).toMatch(/commit/i);
    // And no entry point takes a flag that would let a caller skip the dry run.
    for (const source of sources) {
      expect(/input\.commit\b/.test(source.code), source.file).toBe(false);
      expect(/\bcommit:\s*(true|input)/.test(source.code), source.file).toBe(false);
    }
  });

  it('leaves the two shipping solvers alone', () => {
    // The constraint the prompt states, asserted rather than remembered.
    for (const source of sources) {
      expect(/from '.*autoScheduler\.js'/.test(source.code), source.file).toBe(false);
      expect(/from '.*gameMetrics\.js'/.test(source.code), source.file).toBe(false);
      expect(/from '.*gameScheduling\.js'/.test(source.code), source.file).toBe(false);
    }
  });

  it('registers every new export in the package barrel', () => {
    const barrel = readFileSync(path.join(CORE, 'resolve', 'index.js'), 'utf8');
    for (const name of [
      'RESOLVE_OBJECTIVE_TERM',
      'RESOLVE_OBJECTIVE_WEIGHTS',
      'scoreObjective',
      'resolveObjectiveWeights',
      'buildChangeReport',
      'commitResolve',
      'ChangeBudgetExceeded',
    ]) {
      expect(barrel, name).toContain(name);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* The pre-PR review's six findings, each with the case that reproduces it     */
/* -------------------------------------------------------------------------- */

/**
 * **The two that defeat the phase's purpose**, and the schedule they need.
 *
 * Findings 1 and 2 are both about the objective moving a published game it
 * should have left alone. Neither can be shown against the season-2026 corpus as
 * it stands, and the reason is worth recording rather than working around: the
 * corpus carries **no baseline-accepted blocking finding that depends on the
 * slot**. Its four accepted blocking findings are `SIZE_UNKNOWN_FORMAT` on the
 * `Scrimmage` rows (GAP-14: no `game_formats.csv` entry), which is a fact about
 * the game's *format* and follows it to every candidate slot, so no candidate is
 * ever cleaner than the published one and the anchor wins on change cost either
 * way. It is verified below that those four rows do not move.
 *
 * So the scenario is **constructed**, out of the corpus and named as such: one
 * published row is stacked onto another's exact slot, which is a published
 * schedule carrying an accepted double-booking. That is the shape the review
 * describes and the shape `newBlockingCodes()` was written for — "a change
 * request is not asked to repair the schedule it was handed".
 */
const busiestVenue = [
  ...schedule.games
    .filter((game) => game.date === SEEDING_DATE)
    .reduce(
      (tally, game) => tally.set(game.venueId, (tally.get(game.venueId) ?? 0) + 1),
      new Map()
    ),
].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];

const busiestWave = schedule.games
  .filter((game) => game.date === SEEDING_DATE && game.venueId === busiestVenue)
  .sort((a, b) => a.startMinutes - b.startMinutes || a.id.localeCompare(b.id));
const STACK_KICKOFF = busiestWave[0].startMinutes;
const stackHeld = busiestWave.filter((game) => game.startMinutes === STACK_KICKOFF)[0];
const stackMoved = busiestWave.find(
  (game) =>
    game.startMinutes === STACK_KICKOFF &&
    game.id !== stackHeld.id &&
    game.format === stackHeld.format &&
    game.surfaceId !== stackHeld.surfaceId
);

/** The published season with one row standing on another's slot. */
const stackedSchedule = {
  ...schedule,
  games: schedule.games.map((game) =>
    game.id === stackMoved.id
      ? {
          ...game,
          surfaceId: stackHeld.surfaceId,
          startMinutes: stackHeld.startMinutes,
          endMinutes: stackHeld.startMinutes + (game.endMinutes - game.startMinutes),
        }
      : game
  ),
};
const STACK_SLOT = {
  date: SEEDING_DATE,
  surfaceId: stackHeld.surfaceId,
  startMinutes: stackHeld.startMinutes,
};

/**
 * A resolve state over the constructed baseline, so the accepted finding can be
 * read out of `checkPlacement()` — the same function the pipeline's gate asks —
 * rather than asserted from this file's own idea of what a double-booking is.
 */
const stackedState = createResolveState({
  games: stackedSchedule.games.map((game) => ({ ...game })),
  dispositions: Object.fromEntries(
    stackedSchedule.games.map((game) => [game.id, FREEZE_DISPOSITION.THAWED])
  ),
  admittedSlotsByGameId: {},
  inventory: buildSlotInventory(stackedSchedule.games),
  ledger: createResolveLedger(),
});
const stackedPlacement = checkPlacement(engines, stackedState, stackMoved.id, STACK_SLOT);
const stackedAccepted = placementFindingCounts(stackedPlacement);

/**
 * Which games of a resolved schedule stand somewhere other than the schedule it
 * was handed — enumerated from that schedule's own rows, never from the run.
 *
 * @param {import('@squadlogic/core/ruleEngine/types.js').Schedule} before
 * @param {import('@squadlogic/core/ruleEngine/types.js').Schedule} after
 * @returns {string[]}
 */
function movedBetween(before, after) {
  const byId = new Map(after.games.map((game) => [game.id, game]));
  return before.games
    .filter((game) => slotOf(game) !== slotOf(byId.get(game.id) ?? null))
    .map((game) => game.id)
    .sort();
}

const globalControl = reoptimiseWholeSeason({
  schedule,
  changes: [],
  engines,
  reason: 'the control: a global re-solve of the published season, default objective',
  acknowledged: true,
  verify: false,
});
const globalStacked = reoptimiseWholeSeason({
  schedule: stackedSchedule,
  changes: [],
  engines,
  reason: 'a global re-solve of a season carrying one accepted double-booking',
  acknowledged: true,
  verify: false,
});

describe('review finding 2 :: quality was scored absolutely while the gate is relative', () => {
  it('builds the case out of the corpus, and says why the corpus alone cannot make it', () => {
    // Meta-assertions. Each one, mis-set, would make the assertions below true
    // of nothing.
    expect(stackMoved, 'two same-format rows on one wave').toBeTruthy();
    // The one placed first takes the shared slot, so the *other* is the one the
    // objective has to decide about. Ordering is by baseline date, kickoff, id.
    expect([stackHeld.id, stackMoved.id].sort()[0]).toBe(stackHeld.id);
    // The constructed baseline really does carry a blocking finding at that
    // slot, read from `checkPlacement()` rather than assumed.
    expect(stackedPlacement.blockingCodeCounts.OCCUPIED_SAME_SURFACE).toBe(1);
    // Per instance since 8.6 PR 2: the clash is recorded with the game it is
    // *with*, so trading it for a clash with somebody else is not "the same".
    expect(stackedAccepted[`OCCUPIED_SAME_SURFACE|${stackHeld.id}`]).toBe(1);
    expect(stackedAccepted.OCCUPIED_SAME_SURFACE).toBeUndefined();
    // …and the published corpus carries no such thing, which is why it is
    // constructed: its four accepted blocking findings are all
    // `SIZE_UNKNOWN_FORMAT` on the `Scrimmage` rows, a property of the format
    // rather than of the slot.
    const scrimmage = schedule.games.filter((game) => game.format === 'Scrimmage');
    expect(scrimmage).toHaveLength(4);
    expect(movedBetween(schedule, globalStacked.schedule)).not.toContain(scrimmage[0].id);
  });

  it('reproduces the published season exactly when nothing is wrong with it', () => {
    // The control the row below is read against: with the objective the module
    // ships with, a global re-optimisation of a schedule that is already good
    // gives it back unchanged. Without this, "one game moved" would not be a
    // measurement of anything.
    expect(movedBetween(schedule, globalControl.schedule)).toEqual([]);
    expect(globalControl.unplaced).toEqual([]);
    expect(globalControl.meta.movesConsidered).toBeGreaterThan(0);
  });

  it('leaves a game standing on an accepted violation exactly where it was published', () => {
    // **The finding.** The gate above `chooseSlot()`'s scoring accepts a
    // blocking finding the published schedule already carried; scoring the same
    // candidate absolutely charged the game a full `blockingViolation` at its own
    // published slot — 10000 — against roughly 1001 for a clean slot one field
    // over, so the placer moved a published game to repair a violation it had
    // already decided not to repair.
    expect(movedBetween(stackedSchedule, globalStacked.schedule)).toEqual([]);
    expect(globalStacked.unplaced).toEqual([]);
    // Named rather than counted, because a count is what incident 1 had.
    const after = new Map(globalStacked.schedule.games.map((game) => [game.id, game]));
    expect(slotOf(after.get(stackMoved.id))).toBe(slotOf(STACK_SLOT));
    expect(slotOf(after.get(stackHeld.id))).toBe(slotOf(STACK_SLOT));
  });

  it('charges the excess over what was accepted, and never a negative', () => {
    // The counting rule on its own, including the clamp. A candidate carrying
    // *fewer* findings than the baseline is not paid a bonus for it: a negative
    // quality term would let a solver buy a move with somebody else's accepted
    // exception, and the short-circuits in `chooseSlot()` rest on every quality
    // term being non-negative.
    // The per-instance record `checkPlacement()` builds; `X` and `Y` name no
    // other game, so each is keyed by its code alone.
    const placement = /** @type {any} */ ({
      findingInstances: {
        X: { severity: 'blocking', count: 2 },
        Y: { severity: 'compromise', count: 1 },
      },
    });
    const absolute = candidateObjectiveCounts({
      reference: STACK_SLOT,
      slot: STACK_SLOT,
      placement,
    });
    expect(absolute[RESOLVE_OBJECTIVE_TERM.BLOCKING_VIOLATION]).toBe(2);
    expect(absolute[RESOLVE_OBJECTIVE_TERM.COMPROMISE_VIOLATION]).toBe(1);

    const relative = candidateObjectiveCounts({
      reference: STACK_SLOT,
      slot: STACK_SLOT,
      placement,
      accepted: { X: 1, Y: 2 },
    });
    expect(relative[RESOLVE_OBJECTIVE_TERM.BLOCKING_VIOLATION]).toBe(1);
    expect(relative[RESOLVE_OBJECTIVE_TERM.COMPROMISE_VIOLATION]).toBeUndefined();

    // And on the real placement: everything it carries was already accepted, so
    // it costs nothing beyond the change it does not make.
    expect(
      candidateObjectiveCounts({
        reference: STACK_SLOT,
        slot: STACK_SLOT,
        placement: stackedPlacement,
        accepted: stackedAccepted,
      })
    ).toEqual({});
  });
});

/**
 * A third game pinned onto a slot two others already share. Until 8.6 PR 2
 * this was what got `local-search` and `pair-repair` off the ground; it no
 * longer does, and the finding-1 block below says why that is the fix.
 */
const stackThird = busiestWave.find(
  (game) =>
    game.startMinutes === STACK_KICKOFF &&
    game.format === stackHeld.format &&
    game.id !== stackHeld.id &&
    game.id !== stackMoved.id &&
    game.surfaceId !== stackHeld.surfaceId
);
const stackedRepairRun = applyChangeRequest({
  schedule: stackedSchedule,
  changes: [
    {
      gameId: /** @type {any} */ (stackThird).id,
      date: SEEDING_DATE,
      surfaceId: stackHeld.surfaceId,
      startMinutes: STACK_KICKOFF,
      reason: 'a third game onto the slot two others already share',
    },
  ],
  engines,
  freeze: freezeAllExcept([{ date: SEEDING_DATE }]),
  holdChanges: true,
  onUnsatisfiable: 'report',
  verify: false,
});

describe('review finding 1 :: drift was measured from the wrong anchor', () => {
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const STAGES = path.join(ROOT, 'packages', 'core', 'src', 'resolve', 'stages.js');
  const code = readFileSync(STAGES, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

  it('asks one function where a game is held from, in all three places a slot is chosen', () => {
    // **The finding, as the structural claim it is.** `local-search` and
    // `pair-repair` each carried their own `context.anchors[id] ?? currentSlot`
    // fallback. `context.anchors` holds only the games a change request names, so
    // a game already displaced by `initial-assignment` measured its drift from
    // the displaced position — and walking it back toward its published slot
    // then scored *worse* than moving it further away, in the stage whose entire
    // job is that walk. `placePending`'s `anchorOf()` already fell back to
    // `state.baseline`; this is `CLAUDE.md` §3's "adopt the sibling's contract
    // rather than inventing a third one", on its third appearance in this
    // project.
    //
    // Meta-assertion first: this is reading the real file.
    expect(code.length).toBeGreaterThan(5000);
    expect(code).toContain('function anchorOf(');

    // Exactly one expression in the file resolves a game's anchor.
    expect([...code.matchAll(/context\.anchors\[[^\]]*\]\s*\?\?/g)]).toHaveLength(1);
    // …and it is the one inside `anchorOf`, which is the only reader that also
    // knows about `state.baseline`.
    const anchorBody = code.slice(code.indexOf('function anchorOf('));
    expect(anchorBody.slice(0, anchorBody.indexOf('}\n'))).toMatch(/state\.baseline\[gameId\]/);

    // Three stages choose a slot, and three call sites ask `anchorOf`.
    expect([...code.matchAll(/\bchooseSlot\(/g)].length - 1).toBe(3);
    expect([...code.matchAll(/(?<!function )\banchorOf\(/g)]).toHaveLength(3);
  });

  it('no longer reaches local-search or pair-repair through a pile-up, because the pile-up was a defect', () => {
    // **Inverted in 8.6 PR 2, and why.** This construction used to be how the
    // two stages got off the ground: `initial-assignment` re-homed a dislodged
    // game **back onto the pinned third game's slot**, because the clash its
    // published slot carried was accepted as a count at every slot, and
    // `pair-repair` then moved somebody off it. That was acceptance travelling
    // with a game into a clash it never had — the gap `resolve/instances.js`
    // closes. With acceptance keyed per instance and per slot the placer puts
    // the dislodged games on clean ground at once, so both stages apply
    // nothing here, which is the fix and not a lost witness.
    const byStage = new Map(stackedRepairRun.stages.map((stage) => [stage.stageId, stage]));
    // The meta-assertion: the pile really did have to come apart.
    expect(/** @type {any} */ (byStage.get('dislodge')).movesApplied).toBeGreaterThan(0);
    expect(/** @type {any} */ (byStage.get('local-search')).movesApplied).toBe(0);
    expect(/** @type {any} */ (byStage.get('pair-repair')).movesApplied).toBe(0);

    // Every game on the date, from the constructed roster, stands clear of a
    // same-surface clash — including the two that were published in one.
    const onDate = stackedSchedule.games.filter((game) => game.date === SEEDING_DATE);
    const resolvedById = new Map(stackedRepairRun.schedule.games.map((game) => [game.id, game]));
    let examined = 0;
    for (const game of onDate) {
      const placed = resolvedById.get(game.id);
      if (!placed) continue;
      examined += 1;
      const placement = checkPlacement(engines, stackedRepairRun.state, game.id, placed);
      expect(placement.blockingCodeCounts.OCCUPIED_SAME_SURFACE ?? 0, game.id).toBe(0);
    }
    expect(examined).toBe(onDate.length);
  });

  it('gets local-search off the ground through a repair scope, and repairs without spreading', () => {
    // Where 8.6 says the repair belongs: the accepted clash is *scoped*, so
    // `local-search` answers for it. The request is a no-op on the date; it
    // only has to make the run happen.
    const noOp = /** @type {any} */ (
      stackedSchedule.games.find(
        (game) =>
          game.date === SEEDING_DATE && game.id !== stackHeld.id && game.id !== stackMoved.id
      )
    );
    const run = applyChangeRequest({
      schedule: stackedSchedule,
      changes: [
        {
          gameId: noOp.id,
          date: noOp.date,
          surfaceId: noOp.surfaceId,
          startMinutes: noOp.startMinutes,
          reason: 'the run has to happen for the scope to act',
        },
      ],
      engines,
      freeze: freezeAllExcept([{ date: SEEDING_DATE }]),
      repairScope: [stackHeld.id, stackMoved.id],
      onUnsatisfiable: 'report',
      verify: false,
    });
    const search = /** @type {any} */ (
      run.stages.find((stage) => stage.stageId === 'local-search')
    );
    expect(search.movesApplied).toBeGreaterThan(0);
    const repaired = run.moves.filter((move) => move.stageId === 'local-search');
    expect(repaired.length).toBe(search.movesApplied);
    for (const move of repaired) {
      const placement = checkPlacement(
        engines,
        run.state,
        move.gameId,
        /** @type {any} */ (move.to)
      );
      expect(placement.blockingCodeCounts.OCCUPIED_SAME_SURFACE ?? 0, move.gameId).toBe(0);
    }
  });
});

describe('review finding 3 :: one zeroed change term stripped the pressure and said nothing', () => {
  const run = applyChangeRequest({
    schedule,
    changes: nineChanges,
    engines,
    freeze: freezeAllExcept([{ date: SEEDING_DATE }]),
    holdChanges: true,
    onUnsatisfiable: 'report',
    verify: false,
    objectiveWeights: { changedGame: 0 },
  });

  it('stamps the warning when any change term is zeroed, and names which', () => {
    // `{ changedGame: 0 }` alone leaves `driftMinute` and `changedSurface` at 1
    // each, so a thirty-minute move costs 30 against a single
    // `compromiseViolation` at 100: essentially all change pressure is gone and
    // the run behaves like a re-optimisation. The predicate that only fired when
    // all three were zero let it do that in silence.
    const finding = run.findings.find(
      (candidate) => candidate.code === RESOLVE_REASON.RESOLVE_OBJECTIVE_CHANGE_TERM_DISABLED
    );
    expect(finding?.severity).toBe('compromise');
    expect(finding?.details.disabledTerms).toEqual([RESOLVE_OBJECTIVE_TERM.CHANGED_GAME]);
    expect(finding?.details.allChangeTermsDisabled).toBe(false);
    expect(String(finding?.message)).toContain(RESOLVE_OBJECTIVE_TERM.CHANGED_GAME);
  });

  it('keeps "switched off entirely" a separate and stronger statement', () => {
    // Two of three is not "switched off", and the report's own flag must not
    // read as it — that flag is what tells a reader this run had the objective
    // incident 1's solver had.
    expect(run.objective.changeTermsDisabled).toBe(false);
    expect(run.objective.disabledChangeTerms).toEqual([RESOLVE_OBJECTIVE_TERM.CHANGED_GAME]);
    expect(disabledChangeTerms(resolveObjectiveWeights({ changedGame: 0 }))).toEqual([
      RESOLVE_OBJECTIVE_TERM.CHANGED_GAME,
    ]);
    expect(disabledChangeTerms(RESOLVE_OBJECTIVE_WEIGHTS)).toEqual([]);
    expect(
      disabledChangeTerms(
        resolveObjectiveWeights({ changedGame: 0, driftMinute: 0, changedSurface: 0 })
      )
    ).toEqual([...RESOLVE_CHANGE_TERMS]);
    expect(
      changeTermsDisabled(
        resolveObjectiveWeights({ changedGame: 0, driftMinute: 0, changedSurface: 0 })
      )
    ).toBe(true);
  });
});

describe('review finding 4 :: the objective delta could report an improvement it had not made', () => {
  const mismatched = applyChangeRequest({
    schedule,
    changes: externalChanges,
    engines,
    // The two together are the whole finding: a quality-inclusive baseline
    // supplied by the caller, and a resolved schedule the rule engine never ran
    // over.
    baselineVerification,
    verify: false,
    onUnsatisfiable: 'report',
  });

  it('refuses to subtract a measured baseline from an unmeasured result', () => {
    // Meta-assertion: the baseline really does carry quality worth thousands, so
    // the mismatch was worth thousands too and not a rounding error.
    expect(baselineVerification.violations.length).toBeGreaterThan(50);
    expect(mismatched.report.quality.measured).toBe(false);
    expect(mismatched.report.objective.deltaIncludesQuality).toBe(false);
    // Both sides measured the same way, or neither.
    expect(mismatched.report.objective.baseline.qualityMeasured).toBe(false);
    expect(mismatched.report.objective.resolvedSchedule.qualityMeasured).toBe(false);
    expect(mismatched.report.objective.baseline.qualityCost).toBe(0);
  });

  it('never reads as a gain: a re-solve that moved games costs more than the season it started from', () => {
    // With quality dropped from both sides the delta is a pure change cost, and
    // a change cost against the reference schedule cannot be negative. Before
    // the fix this run reported a large *improvement* that was entirely the
    // artefact of subtracting the baseline's 62 accepted exceptions from a score
    // that had never been given any.
    expect(mismatched.report.objective.delta).toBeGreaterThan(0);
    expect(mismatched.report.objective.delta).toBe(
      mismatched.report.objective.resolvedSchedule.changeCost
    );
    expect(mismatched.moved.length).toBeGreaterThan(0);
  });

  it('still includes quality when both sides were measured', () => {
    // The other half, so the fix is not "the delta never includes quality".
    expect(seedingRun.report.objective.deltaIncludesQuality).toBe(true);
    expect(seedingRun.report.objective.baseline.qualityCost).toBeGreaterThan(0);
  });
});

describe('review finding 5 :: an override was detected by object identity', () => {
  /** @param {Record<string, number>|undefined} objectiveWeights */
  const runWith = (objectiveWeights) =>
    applyChangeRequest({
      schedule,
      changes: externalChanges,
      engines,
      verify: false,
      onUnsatisfiable: 'report',
      ...(objectiveWeights === undefined ? {} : { objectiveWeights }),
    });
  const codesOf = (/** @type {any} */ run) => run.findings.map((finding) => finding.code);
  const OVERRIDDEN = RESOLVE_REASON.RESOLVE_OBJECTIVE_WEIGHTS_OVERRIDDEN;

  it('does not tell an operator that two identically-scored runs are incomparable', () => {
    // `{}` and a table spelled out to the shipped numbers both resolve to a
    // fresh object that scores every run exactly as the defaults do.
    expect(codesOf(runWith({}))).not.toContain(OVERRIDDEN);
    expect(codesOf(runWith({ ...RESOLVE_OBJECTIVE_WEIGHTS }))).not.toContain(OVERRIDDEN);
    expect(codesOf(runWith(undefined))).not.toContain(OVERRIDDEN);
    expect(objectiveWeightsAreDefault(resolveObjectiveWeights({}))).toBe(true);
    expect(objectiveWeightsAreDefault(resolveObjectiveWeights(undefined))).toBe(true);
  });

  it('still says so when the weights genuinely differ', () => {
    // The other half: a check that cannot fire is a check nobody has tested.
    const overridden = runWith({ changedGame: RESOLVE_OBJECTIVE_WEIGHTS.changedGame + 1 });
    expect(codesOf(overridden)).toContain(OVERRIDDEN);
    expect(objectiveWeightsAreDefault(resolveObjectiveWeights({ changedGame: 0 }))).toBe(false);
  });
});

describe('review finding 6 :: the candidate comparator scored twice per comparison', () => {
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const INVENTORY = path.join(ROOT, 'packages', 'core', 'src', 'resolve', 'inventory.js');
  const code = readFileSync(INVENTORY, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

  it('scores each candidate once, not once per comparison', () => {
    // Meta-assertion: the real file, and the helper still exists.
    expect(code).toContain('function changeCostOf(');
    // The declaration and exactly one call. Two calls means the cost is being
    // computed inside the comparator, which is O(n log n) scorings and a fresh
    // six-term breakdown allocated for each: about 6,800 calls and 48,000
    // objects thrown away per placement on a busy date.
    expect([...code.matchAll(/\bchangeCostOf\(/g)]).toHaveLength(2);
  });

  it('produces the identical ordering, asserted rather than assumed', () => {
    const game = /** @type {any} */ (baselineById.get(nineChanges[0].gameId));
    const anchor = { date: game.date, surfaceId: game.surfaceId, startMinutes: game.startMinutes };
    const zeroed = resolveObjectiveWeights({ changedGame: 0, driftMinute: 0, changedSurface: 0 });

    for (const weights of [RESOLVE_OBJECTIVE_WEIGHTS, zeroed]) {
      const ordered = candidateSlotsFor(seedingRun.state, game.id, anchor, weights);
      // Meta-assertion: enough candidates for an ordering to mean anything.
      expect(ordered.length).toBeGreaterThan(3);
      // The comparator the decorate-sort-undecorate replaced, applied to the
      // result. `Array.prototype.sort` is stable, so re-sorting an already
      // correctly ordered list is the identity — and is not, the moment the two
      // orderings disagree anywhere.
      const cost = (/** @type {any} */ slot) =>
        scoreObjective(changeCountsFor(anchor, slot), weights).changeCost;
      const resorted = [...ordered].sort(
        (a, b) =>
          cost(a) - cost(b) ||
          a.startMinutes - b.startMinutes ||
          a.surfaceId.localeCompare(b.surfaceId)
      );
      expect(resorted.map(slotOf)).toEqual(ordered.map(slotOf));
      // Non-decreasing in cost, which is what `chooseSlot()`'s short-circuits
      // rest on.
      for (let index = 1; index < ordered.length; index += 1) {
        expect(cost(ordered[index]) >= cost(ordered[index - 1]), String(index)).toBe(true);
      }
    }
  });
});
