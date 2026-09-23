/**
 * **Bounded local repair (8.6): the repair scope, the budget as a bound, and
 * published-time hold as a number.**
 *
 * Three things are asserted here and each one is a different kind of claim.
 *
 * 1. **The blind spot, as a regression guard.** `resolve/` accepts the
 *    schedule it was handed and repairs only what the run itself breaks. That
 *    is right for a change request and wrong for the one event this operator
 *    exists for. Withdrawing a venue's permit for one date takes the rule
 *    engine from 62 baseline violations to 74 and the re-solve over the same
 *    engines says **nothing whatsoever** about the closure, because
 *    `baseline-ingest` files the breach as already-carried and `local-search`
 *    skips it. The first describe below pins that behaviour as it was, so the
 *    repair scope is measured against a stated starting point rather than
 *    against a memory of one.
 *
 * 2. **The bound, on the neighbourhood.** Before 8.6 the change budget was a
 *    number the solver was never told: `report.js` compared `moved.length`
 *    against it once the run was over, and `commit.js` threw. It now gates
 *    every relocation, so a run comes back **within** its cap and partially
 *    repaired rather than over it and refused whole — and cannot come back
 *    looking clean when it stopped early.
 *
 * 3. **The two preconditions the `chooseSlot()` short-circuits rest on.** Not
 *    the short-circuits themselves: see the last describe for why an
 *    end-to-end test of those over this corpus is worthless, measured rather
 *    than assumed.
 *
 * Every number is derived from the corpus at test time.
 *
 * @see fixtures/season-2026/README.md incidents 4 and 10
 */

import { describe, it, expect } from 'vitest';

import { buildAvailabilityCalendarFromSeason2026 } from '@squadlogic/core/availability/index.js';
import { CONSTRAINT_SEVERITY } from '@squadlogic/core/constraints/index.js';
import { buildSeason2026ConstraintRegistry } from '@squadlogic/core/constraints/index.js';
import {
  buildFacilityGraphFromSeason2026,
  buildSeason2026VenueComplexMap,
} from '@squadlogic/core/facility/index.js';
import {
  loadFacilityGeometry,
  loadFacilityPermits,
  loadGameFormats,
  loadSeason2026,
  loadSunsets,
} from '@squadlogic/core/fixtures/index.js';
import { buildFormatTimingTableFromSeason2026 } from '@squadlogic/core/timing/index.js';
import { runRuleEngine, toSeason2026Schedule } from '@squadlogic/core/ruleEngine/index.js';
import {
  RESOLVE_OBJECTIVE_TERM,
  RESOLVE_OBJECTIVE_WEIGHTS,
  RESOLVE_REASON,
  applyChangeRequest,
  baselinePartitionFindings,
  buildSlotInventory,
  candidateObjectiveCounts,
  candidateSlotsFor,
  checkPlacement,
  createResolveLedger,
  createResolveState,
  reoptimiseWholeSeason,
  resolveObjectiveWeights,
  scoreObjective,
} from '@squadlogic/core/resolve/index.js';
import { FREEZE_DISPOSITION, freezeAllExcept } from '@squadlogic/core/freeze/index.js';

/* -------------------------------------------------------------------------- */
/* Corpus and engines                                                          */
/* -------------------------------------------------------------------------- */

const season = loadSeason2026();
const graph = buildFacilityGraphFromSeason2026(loadFacilityGeometry());
const timingTable = buildFormatTimingTableFromSeason2026(loadGameFormats());
const sunsets = loadSunsets();
/** Derived from the corpus rather than typed in, so a re-dated fixture moves it. */
const SEASON_YEAR = Number(sunsets[0].date.slice(0, 4));
const permits = loadFacilityPermits({ seasonYear: SEASON_YEAR });
const registry = buildSeason2026ConstraintRegistry();
const schedule = toSeason2026Schedule(season);

/** Engines over a stated permit set, so a withdrawal is an input and not a mock. */
function enginesFor(permitRows) {
  const calendar = buildAvailabilityCalendarFromSeason2026(permitRows, sunsets);
  const resources = {
    graph,
    timingTable,
    calendar,
    venueComplexes: buildSeason2026VenueComplexMap(),
  };
  return { graph, table: timingTable, calendar, registry, resources };
}

const openEngines = enginesFor(permits);

/* -------------------------------------------------------------------------- */
/* The withdrawal, and the games it strands — enumerated from the permit and   */
/* the roster, never from a run                                                */
/* -------------------------------------------------------------------------- */

/**
 * The busiest (venue, date) pair the corpus has, found rather than typed in.
 *
 * Chosen from `schedule.games` — the published roster — because that is what a
 * withdrawal is *about*. Deriving it from anything a run produces would make
 * every count below a comparison of the run against itself, which is the
 * Phase 2 defect and incident 4's shape.
 */
const WITHDRAWN = (() => {
  /** @type {Map<string, Array<Object>>} */
  const byKey = new Map();
  for (const game of schedule.games) {
    const key = `${game.date}|${game.venueId}`;
    byKey.set(key, [...(byKey.get(key) ?? []), game]);
  }
  const [key, games] = [...byKey.entries()].sort((a, b) => b[1].length - a[1].length)[0];
  const [date, venueId] = key.split('|');
  return { date, venueId, games, venueLabel: games[0].venueLabel ?? null };
})();

/** The permit set with that venue's ground withdrawn for that one date. */
const withdrawnPermits = (() => {
  // Permits key on the venue **label** and a scope string, the shape
  // `Summit HS, SAT 09/19` already uses for "NO PERMIT this date". Matching on
  // `venueId` silently changes nothing, which is why the count is asserted.
  const sample = permits.find(
    (permit) => `${permit.venue}`.toLowerCase().replace(/[^a-z0-9]+/g, '-') === WITHDRAWN.venueId
  );
  if (!sample) throw new Error(`no permit row for venue "${WITHDRAWN.venueId}"`);
  const [, month, day] = WITHDRAWN.date.split('-');
  return [
    ...permits,
    {
      ...sample,
      scope: `SAT ${month}/${day} only`,
      scopeKind: 'date-exception',
      weekday: 'SAT',
      monthDay: `${month}/${day}`,
      date: WITHDRAWN.date,
      hasPermit: false,
      openMinutes: null,
      closeMinutes: null,
      notes: 'NO PERMIT this date',
    },
  ];
})();

const closedEngines = enginesFor(withdrawnPermits);

/** The games the withdrawal strands, from the roster. */
const STRANDED = WITHDRAWN.games.map((game) => game.id).sort();

/**
 * A change request that asks for nothing: the same game, at the slot it
 * already has. The run has to happen for the repair scope to have anything to
 * act on, and it must not itself be the thing that moves games.
 */
const NO_OP_CHANGE = (() => {
  const game = schedule.games.find((candidate) => candidate.date === WITHDRAWN.date);
  if (!game) throw new Error('no game on the withdrawn date');
  return [
    {
      gameId: game.id,
      date: game.date,
      surfaceId: game.surfaceId,
      startMinutes: game.startMinutes,
      reason: 'a run has to happen for the repair scope to act on anything',
    },
  ];
})();

/* -------------------------------------------------------------------------- */

describe('the withdrawal is real, and the corpus supports the scenario', () => {
  it('strands more than one game, so nothing below is a single-case coincidence', () => {
    expect(STRANDED.length).toBeGreaterThan(1);
    // Every stranded id is a baseline game, checked against the roster rather
    // than against anything derived from it.
    const roster = new Set(schedule.games.map((game) => game.id));
    for (const gameId of STRANDED) expect(roster.has(gameId)).toBe(true);
  });

  it('actually withdraws ground: the rule engine sees more violations with it gone', () => {
    // **The meta-assertion this whole file rests on.** A withdrawal that the
    // calendar quietly ignored would leave every assertion below passing over
    // an unchanged schedule — a perfect score meaning "I looked at nothing"
    // (incident 4). The delta is counted, not assumed.
    const open = runRuleEngine(schedule, { registry, resources: openEngines.resources });
    const closed = runRuleEngine(schedule, { registry, resources: closedEngines.resources });
    expect(closed.violations.length).toBeGreaterThan(open.violations.length);
    expect(withdrawnPermits.length).toBe(permits.length + 1);
  });
});

describe('without a repair scope, the withdrawal is invisible — the blind spot 8.6 exists for', () => {
  const run = applyChangeRequest({
    schedule,
    changes: NO_OP_CHANGE,
    engines: closedEngines,
    verify: false,
    onUnsatisfiable: 'report',
  });

  it('moves nothing on account of the closure and names it in no finding', () => {
    // `baseline-ingest` records the closure as a code the baseline already
    // carried; `local-search`'s `newBlockingCodes(...).length === 0` guard
    // then skips every stranded game. This is deliberate policy — a change
    // request is not asked to repair the schedule it was handed — and it is
    // exactly wrong for ground that has gone.
    const repairFindings = run.findings.filter(
      (finding) =>
        finding.code === RESOLVE_REASON.RESOLVE_REPAIR_UNAVAILABLE ||
        finding.code === RESOLVE_REASON.RESOLVE_REPAIR_SCOPE_DECLARED
    );
    expect(repairFindings).toEqual([]);
    // And every stranded game is still standing on the ground that is gone.
    const placed = new Map(run.schedule.games.map((game) => [game.id, game]));
    for (const gameId of STRANDED) {
      expect(placed.get(gameId)?.venueId).toBe(WITHDRAWN.venueId);
    }
  });
});

describe('with a repair scope, the run answers for the stranded games', () => {
  // **The scope says what to repair; the freeze says what may move, and the
  // freeze is still the authority.** `applyChangeRequest()` defaults to
  // maximum freeze — every game held but the ones the request names — so a
  // scope on its own is inert by construction. The caller thaws them through
  // the freeze plan, by name, which is the same door every other move in this
  // package goes through.
  const thawed = freezeAllExcept(
    [...STRANDED, NO_OP_CHANGE[0].gameId].map((gameId) => ({ gameId }))
  );
  const run = applyChangeRequest({
    schedule,
    changes: NO_OP_CHANGE,
    engines: closedEngines,
    repairScope: STRANDED,
    freeze: thawed,
    verify: false,
    onUnsatisfiable: 'report',
  });

  it('declares the scope and says how much of it it actually had to answer for', () => {
    const declared = run.findings.find(
      (finding) => finding.code === RESOLVE_REASON.RESOLVE_REPAIR_SCOPE_DECLARED
    );
    expect(declared?.severity).toBe('info');
    expect(declared?.details.scopeGames).toBe(STRANDED.length);
    // The meta-assertion: un-accepting these games discarded real findings. A
    // scope that discarded none would be `RESOLVE_REPAIR_SCOPE_VACUOUS`.
    expect(Number(declared?.details.exercised)).toBeGreaterThan(0);
    expect(Number(declared?.details.findingsDiscarded)).toBeGreaterThan(0);
    expect(run.meta.repairScopeGames).toBe(STRANDED.length);
  });

  it('leaves every stranded game standing, because taking the time away buys nothing', () => {
    // **The minimal-diff answer, and it was not free to get right.** The first
    // implementation emptied the baseline record `dislodge` reads as well as
    // the one the placer reads, so all 21 games came off the board and were
    // shelved as TIME TBD — 21 published kickoffs destroyed to repair nothing,
    // at a venue that is shut and has nowhere to put them. A game on withdrawn
    // ground still has a time families were given; it keeps it until there is
    // something better to offer.
    expect(run.unplaced).toEqual([]);
    expect(run.report.meta.movedGames).toBe(0);
    expect(run.meta.publishedKickoffHeld).toBe(schedule.games.length);
  });

  it('reports every stranded game it could not re-home, by id, and drops none', () => {
    const unavailable = run.findings.filter(
      (finding) => finding.code === RESOLVE_REASON.RESOLVE_REPAIR_UNAVAILABLE
    );
    // `resolve/` can only offer slots the baseline used at the same venue on
    // the same date, and the whole venue is gone, so every one of them is
    // unrepairable from inside this package. That is the honest answer and it
    // is stated per game.
    expect(unavailable.length).toBeGreaterThan(0);
    for (const finding of unavailable) {
      expect(finding.severity).toBe('compromise');
      expect(STRANDED).toContain(finding.details.gameId);
    }
    expect(run.meta.repairsUnavailable).toBe(unavailable.length);

    // **Enumerated from the roster.** Every stranded game is either re-homed
    // or named as unrepairable; none is silently absent. A game the pipeline
    // dropped fails here rather than vanishing with the list that would have
    // named it.
    const named = new Set(unavailable.map((finding) => String(finding.details.gameId)));
    const placed = new Map(run.schedule.games.map((game) => [game.id, game]));
    const unplacedIds = new Set(run.unplaced.map((entry) => entry.gameId));
    for (const gameId of STRANDED) {
      const rehomed = placed.get(gameId)?.venueId !== WITHDRAWN.venueId;
      expect(named.has(gameId) || rehomed || unplacedIds.has(gameId)).toBe(true);
    }
  });

  it('does not come back clean', () => {
    // A run that was asked to repair twelve games and repaired none of them
    // must not read as a success.
    expect(run.status).not.toBe('clean');
  });

  it('refuses a scope naming a game the schedule does not hold', () => {
    expect(() =>
      applyChangeRequest({
        schedule,
        changes: NO_OP_CHANGE,
        engines: closedEngines,
        repairScope: [...STRANDED, 'no-such-game'],
        freeze: thawed,
        verify: false,
      })
    ).toThrow(/repair scope names game/);
  });

  it('calls a scope that discards nothing vacuous, at blocking', () => {
    // The falsification of the meta-assertion above. These games are legal
    // where they stand under the **open** permits, so un-accepting them
    // discards nothing and the run repairs nothing it would not have anyway.
    const clean = cleanGames();
    const vacuous = applyChangeRequest({
      schedule,
      changes: NO_OP_CHANGE,
      engines: openEngines,
      repairScope: clean,
      freeze: freezeAllExcept([...clean, NO_OP_CHANGE[0].gameId].map((gameId) => ({ gameId }))),
      verify: false,
      onUnsatisfiable: 'report',
    });
    const finding = vacuous.findings.find(
      (candidate) => candidate.code === RESOLVE_REASON.RESOLVE_REPAIR_SCOPE_VACUOUS
    );
    expect(finding?.severity).toBe('blocking');
    expect(finding?.details.findingsDiscarded).toBe(0);
  });
});

/**
 * Games that carry no baseline finding at all under the open permits.
 *
 * Found by running with each as its own scope would be absurd; instead the
 * scope-declared finding reports `findingsDiscarded`, so a scope of games with
 * none is what makes it zero. Picked from a date the withdrawal does not touch.
 */
function cleanGames() {
  const otherDate = [...new Set(schedule.games.map((game) => game.date))]
    .sort()
    .find((date) => date !== WITHDRAWN.date);
  const candidates = schedule.games
    .filter((game) => game.date === otherDate)
    .map((game) => game.id)
    .sort();
  const state = createResolveState({
    games: schedule.games.map((game) => ({ ...game })),
    dispositions: Object.fromEntries(
      schedule.games.map((game) => [game.id, FREEZE_DISPOSITION.THAWED])
    ),
    inventory: buildSlotInventory(schedule.games),
    ledger: createResolveLedger(),
  });
  const verification = runRuleEngine(schedule, {
    registry,
    resources: openEngines.resources,
  });
  const dirty = new Set(
    verification.violations.flatMap((violation) =>
      (violation.entities ?? [])
        .filter((entity) => entity.kind === 'game')
        .map((entity) => String(entity.id))
    )
  );
  const clean = candidates.filter((gameId) => !dirty.has(gameId) && state.baseline[gameId]);
  if (clean.length === 0) {
    throw new Error(
      'no game on the corpus carries zero baseline findings, so the vacuous-scope falsification cannot be constructed'
    );
  }
  return clean.slice(0, 5);
}

describe('the scope measures its own exercise with the ruler the stages use', () => {
  /**
   * A game carrying **compromise** findings at its baseline slot and no
   * blocking one. Found rather than named; the corpus's 62 accepted exceptions
   * are mostly of this kind.
   */
  const COMPROMISE_ONLY = (() => {
    const state = createResolveState({
      games: schedule.games.map((game) => ({ ...game })),
      dispositions: Object.fromEntries(
        schedule.games.map((game) => [game.id, FREEZE_DISPOSITION.THAWED])
      ),
      inventory: buildSlotInventory(schedule.games),
      ledger: createResolveLedger(),
    });
    for (const game of schedule.games) {
      const placement = checkPlacement(openEngines, state, game.id, {
        date: game.date,
        surfaceId: game.surfaceId,
        startMinutes: game.startMinutes,
      });
      const blocking = Object.keys(placement.blockingCodeCounts).length;
      const compromises = placement.findings.filter(
        (finding) => finding.severity === CONSTRAINT_SEVERITY.COMPROMISE
      ).length;
      if (blocking === 0 && compromises > 0) return game;
    }
    return null;
  })();

  it('found a game that carries compromises and nothing blocking', () => {
    // The meta-assertion: without such a game the test below is vacuous, and
    // a corpus that stops carrying one should say so rather than pass.
    expect(COMPROMISE_ONLY).not.toBeNull();
  });

  it('calls a scope over compromise-only games vacuous, because every stage will hold them', () => {
    // **A review finding, kept as a test.** The exercise counter first summed
    // `placementFindingCounts()`, which counts blocking **and** compromise,
    // while every stage that can act on the scope gates on
    // `newBlockingCodes()`, which reads blocking alone. A scope over games
    // like this one therefore reported `exercised > 0`, suppressed the
    // blocking vacuity finding, and claimed the run "has to answer for" a set
    // of findings that `local-search`'s `.length === 0` guard holds every one
    // of — the exact vacuity the code exists to catch, reported as its
    // opposite.
    const game = /** @type {any} */ (COMPROMISE_ONLY);
    const run = applyChangeRequest({
      schedule,
      changes: NO_OP_CHANGE,
      engines: openEngines,
      repairScope: [game.id],
      freeze: freezeAllExcept([game.id, NO_OP_CHANGE[0].gameId].map((gameId) => ({ gameId }))),
      verify: false,
      onUnsatisfiable: 'report',
    });
    const vacuous = run.findings.find(
      (finding) => finding.code === RESOLVE_REASON.RESOLVE_REPAIR_SCOPE_VACUOUS
    );
    expect(vacuous?.severity).toBe('blocking');
    expect(vacuous?.details.findingsDiscarded).toBe(0);
    // …and it really did nothing, which is what makes "vacuous" the honest word.
    expect(run.report.meta.movedGames).toBe(0);
  });
});

describe('a repair scope the freeze holds says so, rather than reading as answered', () => {
  // **A review finding, and the path an operator hits first.** Every other
  // scoped test in this file passes an explicit thawing plan.
  // `applyChangeRequest()` defaults to maximum freeze — every game held but the
  // ones the request names — and a repair scope is *for* games the request does
  // not name, so the default freezes the entire scope. `local-search` turns
  // back at its `mayMove()` guard, which sits before the branch that reports an
  // unrepairable game, and the run used to come back with
  // `repairsUnavailable: 0` and a scope report indistinguishable from one that
  // answered everything.
  const run = applyChangeRequest({
    schedule,
    changes: NO_OP_CHANGE,
    engines: closedEngines,
    repairScope: STRANDED,
    verify: false,
    onUnsatisfiable: 'report',
  });

  it('names every scoped game the plan holds, and counts it as an unmade repair', () => {
    const held = run.findings.filter(
      (finding) =>
        finding.code === RESOLVE_REASON.RESOLVE_REPAIR_UNAVAILABLE &&
        finding.details.reason === 'frozen'
    );
    expect(held).toHaveLength(STRANDED.length);
    expect(new Set(held.map((finding) => String(finding.details.gameId)))).toEqual(
      new Set(STRANDED)
    );
    expect(run.meta.repairsUnavailable).toBe(STRANDED.length);
    expect(run.status).not.toBe('allowed');
  });

  it('says on the scope report itself how many of them were never attempted', () => {
    const declared = run.findings.find(
      (finding) => finding.code === RESOLVE_REASON.RESOLVE_REPAIR_SCOPE_DECLARED
    );
    expect(declared?.details.frozen).toBe(STRANDED.length);
    expect(String(declared?.message)).toContain('no repair was attempted');
  });

  it('is a different report from the same scope thawed, which is the whole point', () => {
    // Without this the assertions above could pass against a run that reports
    // "frozen" for everything regardless. The thawed run of the same scope
    // over the same closed venue reports the same games as unrepairable for a
    // different reason, and does not report them as frozen.
    const thawedRun = applyChangeRequest({
      schedule,
      changes: NO_OP_CHANGE,
      engines: closedEngines,
      repairScope: STRANDED,
      freeze: freezeAllExcept([...STRANDED, NO_OP_CHANGE[0].gameId].map((gameId) => ({ gameId }))),
      verify: false,
      onUnsatisfiable: 'report',
    });
    const reasons = new Set(
      thawedRun.findings
        .filter((finding) => finding.code === RESOLVE_REASON.RESOLVE_REPAIR_UNAVAILABLE)
        .map((finding) => finding.details.reason ?? 'no-legal-slot')
    );
    expect(reasons.has('frozen')).toBe(false);
    expect(thawedRun.meta.repairsUnavailable).toBeGreaterThan(0);
  });
});

describe("a repair scope does not license spending an unscoped game's kickoff", () => {
  /**
   * A baseline double-booking between a scoped game and an unscoped one.
   *
   * Constructed, because the published corpus has no overlap for
   * `pair-repair` to find. One game is moved onto another's slot **in the
   * baseline**, so the clash is something the schedule arrived carrying rather
   * than something the run created — which is the whole point: the scope asks
   * about a pre-existing breach, and `pair-repair` moves somebody *else*.
   */
  const PAIR = (() => {
    const wave = schedule.games
      .filter((game) => game.date === WITHDRAWN.date && game.venueId === WITHDRAWN.venueId)
      .sort((a, b) => a.startMinutes - b.startMinutes || a.id.localeCompare(b.id));
    const kickoff = wave[0].startMinutes;
    const atKickoff = wave.filter((game) => game.startMinutes === kickoff);
    const host = atKickoff[0];
    const guest = atKickoff.find(
      (game) => game.format === host.format && game.surfaceId !== host.surfaceId
    );
    if (!guest) throw new Error('the corpus no longer offers two same-format games on one wave');
    return {
      host,
      guest,
      schedule: {
        ...schedule,
        games: schedule.games.map((game) =>
          game.id === guest.id
            ? {
                ...game,
                surfaceId: host.surfaceId,
                startMinutes: host.startMinutes,
                endMinutes: host.startMinutes + (game.endMinutes - game.startMinutes),
              }
            : game
        ),
      },
    };
  })();

  const noOp = [
    {
      gameId: PAIR.host.id,
      date: PAIR.host.date,
      surfaceId: PAIR.host.surfaceId,
      startMinutes: PAIR.host.startMinutes,
      reason: 'a run has to happen',
    },
  ];
  /**
   * The guest is scoped and **frozen**; the host is thawed, so it is the one
   * thing `pair-repair` could move.
   *
   * The first version of this test thawed both, and it passed with the fix
   * reverted — `local-search` simply re-homed the guest, the clash went away,
   * and `pair-repair` was never reached. A test of a stage that the scenario
   * never runs is the shape incident 4 is about, so the scenario is now built
   * so that the guest's own repair cannot succeed and the clash survives into
   * the stage under test. The stage counters below prove it did.
   */
  const run = applyChangeRequest({
    schedule: PAIR.schedule,
    changes: noOp,
    engines: openEngines,
    repairScope: [PAIR.guest.id],
    freeze: freezeAllExcept([{ gameId: PAIR.host.id }]),
    verify: false,
    onUnsatisfiable: 'report',
  });

  it('really does put the two games on one slot, scope one, and reach pair-repair', () => {
    // Three meta-assertions, because the test below asserts that something did
    // *not* happen and would pass just as well over a scenario with no clash,
    // no scope, or no pair-repair pass.
    const guest = /** @type {any} */ (
      PAIR.schedule.games.find((game) => game.id === PAIR.guest.id)
    );
    expect(guest.surfaceId).toBe(PAIR.host.surfaceId);
    expect(guest.startMinutes).toBe(PAIR.host.startMinutes);
    const declared = run.findings.find(
      (finding) => finding.code === RESOLVE_REASON.RESOLVE_REPAIR_SCOPE_DECLARED
    );
    expect(declared?.details.scopeGames).toBe(1);
    expect(Number(declared?.details.exercised)).toBe(1);
    // The scoped game could not be repaired, so the clash is still standing
    // when `pair-repair` runs — which is the only state in which this stage
    // can spend the counterpart's kickoff.
    expect(run.meta.repairsUnavailable).toBe(1);
    const stages = new Map(run.stages.map((stage) => [stage.stageId, stage]));
    expect(stages.get('pair-repair')).toBeDefined();
    // And the host really is the movable half: nothing else could be moved
    // for the guest's benefit, so a move here would have to be the host's.
    expect(run.freeze.defaultDisposition).toBe('frozen');
  });

  it('leaves the unscoped half of the clash exactly where it was published', () => {
    // **A review finding, kept as a test.** `pair-repair` read the
    // scope-aware record for the game it was triggered by and then relocated
    // that game's *counterpart*, which is not in the scope. So a breach the
    // run neither created nor could fix cost an uninvolved game its published
    // kickoff — the same "published kickoffs destroyed to repair nothing"
    // hazard this PR guards against in `dislodge`, left open in the stage next
    // door. It now reads the as-found record, as `dislodge` does.
    const placed = new Map(run.schedule.games.map((game) => [game.id, game]));
    const host = /** @type {any} */ (placed.get(PAIR.host.id));
    expect(host.surfaceId).toBe(PAIR.host.surfaceId);
    expect(host.startMinutes).toBe(PAIR.host.startMinutes);
    // Stated the other way as well, off the partition rather than off the
    // schedule, so a game the run dropped fails here instead of being absent.
    expect(run.partition.moved.map((entry) => entry.gameId)).not.toContain(PAIR.host.id);
  });
});

describe('the change budget bounds the neighbourhood rather than judging the result', () => {
  /**
   * A clash the corpus does not contain, constructed the way
   * `tests/minimalDiff.test.js` constructs its own and for the same reason:
   * on the published season `local-search` never applies a move at all, so a
   * budget test over the corpus alone would bound a neighbourhood that was
   * never going to spread.
   *
   * **Rebuilt in 8.6 PR 2, because the first construction bit on a defect.**
   * It stacked two games onto a third's slot and pinned a fourth onto the pile.
   * The gated moves the budget refused there existed only because the placer
   * re-homed two dislodged games **back onto the pinned game's slot** — a
   * three-way clash their published-slot acceptance was allowed to follow them
   * into — and `pair-repair` then had to clean up after it. Under a cap the run
   * stopped halfway and published that pile-up as a "partial repair". With
   * acceptance keyed per instance and per slot the placer puts them on clean
   * ground at once, no gated move remains, and the bound had nothing to bite.
   *
   * So the gated half now comes from where 8.6 says it should: a **repair
   * scope**. One same-format game is stacked onto another's slot in the
   * baseline — an accepted clash — and both are scoped, so `local-search`
   * answers for them under the budget. The ungated core the cap cannot touch is
   * a request that puts a third game onto a fourth's slot and pins it: the
   * requested move and the dislodge it forces.
   */
  const STACK = (() => {
    const byVenueDate = new Map();
    for (const game of schedule.games) {
      const key = `${game.date}|${game.venueId}`;
      byVenueDate.set(key, [...(byVenueDate.get(key) ?? []), game]);
    }
    const [key, venueGames] = [...byVenueDate.entries()].sort(
      (a, b) => b[1].length - a[1].length
    )[0];
    const [date] = key.split('|');
    const kickoff = [...new Set(venueGames.map((game) => game.startMinutes))].sort(
      (a, b) => a - b
    )[0];
    const wave = venueGames.filter((game) => game.startMinutes === kickoff);
    const anchor = wave[0];
    const sameFormat = wave.filter(
      (game) => game.format === anchor.format && game.surfaceId !== anchor.surfaceId
    );
    const [stacker, requested] = sameFormat;
    const occupant = wave.find(
      (game) =>
        game.format === anchor.format &&
        game.id !== anchor.id &&
        game.id !== stacker?.id &&
        game.id !== requested?.id
    );
    if (!stacker || !requested || !occupant) {
      throw new Error(
        'the corpus no longer offers a wave to stack; this scenario needs rebuilding'
      );
    }
    const stacked = {
      ...schedule,
      games: schedule.games.map((game) =>
        game.id === stacker.id
          ? {
              ...game,
              surfaceId: anchor.surfaceId,
              startMinutes: anchor.startMinutes,
              endMinutes: anchor.startMinutes + (game.endMinutes - game.startMinutes),
            }
          : game
      ),
    };
    return {
      date,
      kickoff,
      schedule: stacked,
      scope: [anchor.id, stacker.id],
      changes: [
        {
          gameId: requested.id,
          date,
          surfaceId: occupant.surfaceId,
          startMinutes: occupant.startMinutes,
          reason: 'one game onto a slot another already holds',
        },
      ],
    };
  })();

  /** The same run, at a stated budget or none. */
  function repair(changeBudget) {
    return applyChangeRequest({
      schedule: STACK.schedule,
      changes: STACK.changes,
      engines: openEngines,
      freeze: freezeAllExcept([{ date: STACK.date }]),
      holdChanges: true,
      repairScope: STACK.scope,
      changeBudget,
      verify: false,
      onUnsatisfiable: 'report',
    });
  }

  const unbounded = repair(null);

  it('spreads far enough for a bound to have something to bite on', () => {
    // **The meta-assertion the whole describe rests on.** A bound over a run
    // that moves one game proves nothing at all, and every budget below would
    // pass vacuously. The budgets are derived from this number rather than
    // chosen, so a corpus change moves them rather than silently emptying the
    // test.
    expect(unbounded.report.meta.movedConsequential).toBeGreaterThan(1);
    expect(unbounded.report.budget.limit).toBeNull();
  });

  const spread = Number(unbounded.report.meta.movedGames);
  const bounded = repair(spread - 1);

  it('comes back within the cap and partially repaired, instead of over it and refused', () => {
    // This is the whole of the prompt's point 3. Before 8.6 the budget was a
    // number the solver was never told: this same run moved every game it
    // wanted to, built the report, and was refused at commit.
    expect(bounded.report.budget.limit).toBe(spread - 1);
    expect(bounded.report.budget.moved).toBeLessThanOrEqual(spread - 1);
    expect(bounded.report.budget.withinBudget).toBe(true);
    expect(bounded.report.meta.movedGames).toBeLessThan(spread);
    expect(bounded.meta.movesRefusedByBudget).toBeGreaterThan(0);
  });

  it('says the budget bound it, at compromise, and does not also report the budget met', () => {
    const bound = bounded.findings.find(
      (finding) => finding.code === RESOLVE_REASON.RESOLVE_CHANGE_BUDGET_BOUND
    );
    expect(bound?.severity).toBe('compromise');
    expect(bound?.details.budget).toBe(spread - 1);
    // `RESOLVE_CHANGE_BUDGET_MET` is `info` and would read as an all-clear over
    // a repair that stopped early. The two are mutually exclusive on purpose.
    expect(
      bounded.findings.some((finding) => finding.code === RESOLVE_REASON.RESOLVE_CHANGE_BUDGET_MET)
    ).toBe(false);
    // A caller gating on status cannot mistake "we stopped early" for "we
    // finished". The unbounded run of the same request does come back clean,
    // which is what makes this assertion about the bound and not about the
    // scenario.
    expect(unbounded.status).toBe('allowed');
    expect(bounded.status).not.toBe('allowed');
  });

  it('still reports the budget met when the bound never bit', () => {
    // The other arm, so the assertion above is not passing merely because the
    // code stopped emitting `BUDGET_MET` at all.
    const generous = repair(spread + 10);
    expect(
      generous.findings.some((finding) => finding.code === RESOLVE_REASON.RESOLVE_CHANGE_BUDGET_MET)
    ).toBe(true);
    expect(generous.meta.movesRefusedByBudget).toBe(0);
    expect(generous.report.meta.movedGames).toBe(spread);
  });

  it('spends the budget on holding published slots, not on moving more games', () => {
    // The bound is only worth having if the games it declines to move stay
    // where they were. Counted from the baseline roster, so a game the run
    // dropped would show up as a fall rather than as an absence.
    expect(bounded.meta.publishedSlotHeld).toBeGreaterThan(unbounded.meta.publishedSlotHeld);
    expect(bounded.report.hold.baselineGames).toBe(STACK.schedule.games.length);
  });

  it('is exactly why the hold is two numbers and not one', () => {
    // **Found by this test failing.** Every move in this scenario is onto
    // another pitch at the same time, so the *kickoff* hold is untouched at
    // 679 of 679 in both runs while the *slot* hold falls. A single "held"
    // number would have reported a bound that changed nothing, and a reader
    // deciding whether families need telling would have been told the wrong
    // thing in whichever direction that number was defined.
    expect(bounded.meta.publishedKickoffHeld).toBe(unbounded.meta.publishedKickoffHeld);
    expect(bounded.meta.publishedSlotHeld).not.toBe(unbounded.meta.publishedSlotHeld);
    expect(bounded.report.hold.slotHeld).toBeLessThanOrEqual(bounded.report.hold.kickoffHeld);
  });

  it('refuses the irreducible core rather than pretending to bound it', () => {
    // A requested move is the operator's instruction and a dislodge it forces
    // is not the solver's choice, so neither is gated. A cap below that core
    // therefore still falls through to the backstop `commit.js` throws on —
    // which is the documented behaviour, not a hole in the bound.
    const impossible = repair(0);
    expect(impossible.report.budget.withinBudget).toBe(false);
    expect(
      impossible.findings.some(
        (finding) => finding.code === RESOLVE_REASON.RESOLVE_CHANGE_BUDGET_EXCEEDED
      )
    ).toBe(true);
    // And it still bound what it could: the refusals happened.
    expect(impossible.meta.movesRefusedByBudget).toBeGreaterThan(0);
  });

  it('never leaves a shelved game without a reason', () => {
    for (const run of [bounded, repair(0)]) {
      for (const entry of run.unplaced) {
        expect(entry.reason).toMatch(/no slot the schedule already used/);
      }
    }
  });

  it('does not offer a change-budget reason for a shelved game, because it cannot be one', () => {
    // **A review finding, kept as a test.** A three-valued refusal
    // discriminator was written here and removed: `initial-assignment` only
    // ever places games that are already pending, a pending game is already
    // counted among `moved` because it has no slot at all, and
    // `withinChangeBudget()` therefore returns true for every one of them
    // before it does any arithmetic. Refusing such a placement would turn a
    // game with a new time into a game with **no** time at identical cost to
    // the cap, which is worse for the family and no help to the budget.
    //
    // The falsification, so this is not a claim about the code as written:
    // every thawed game in the season is lifted at once and the cap is set to
    // one. If a budget gate existed in that stage it would fire hundreds of
    // times.
    const lifted = reoptimiseWholeSeason({
      schedule,
      changes: NO_OP_CHANGE,
      engines: openEngines,
      reason: 'proving the budget cannot bound initial-assignment',
      acknowledged: true,
      changeBudget: 1,
      verify: false,
      onUnsatisfiable: 'report',
    });
    // The meta-assertion: this run really did lift the whole season, so a zero
    // below means "could not fire" rather than "was never asked".
    expect(lifted.meta.gamesDislodged).toBeGreaterThan(100);
    expect(lifted.meta.movesRefusedByBudget).toBe(0);
  });
});

describe('published-time hold, counted from the baseline roster', () => {
  const run = applyChangeRequest({
    schedule,
    changes: NO_OP_CHANGE,
    engines: openEngines,
    verify: false,
    onUnsatisfiable: 'report',
  });

  it('partitions every baseline game into held or moved, and says so', () => {
    const hold = run.report.hold;
    expect(hold).not.toBeNull();
    // The denominator is the roster, stated rather than implied.
    expect(hold.baselineGames).toBe(schedule.games.length);
    expect(hold.kickoffHeld + hold.kickoffChanged).toBe(hold.baselineGames);
    expect(run.partition.held.length + run.partition.moved.length).toBe(hold.baselineGames);
    // A hold measured over nothing is not a perfect hold; that is the blocking
    // partition finding's job, not a field beside the number.
    expect(hold.baselineGames).toBeGreaterThan(0);
  });

  it('reports the number, at info, with the same figures the meta carries', () => {
    const measured = run.findings.find(
      (finding) => finding.code === RESOLVE_REASON.RESOLVE_PUBLISHED_HOLD_MEASURED
    );
    expect(measured?.severity).toBe('info');
    expect(measured?.details.kickoffHeld).toBe(run.meta.publishedKickoffHeld);
    expect(measured?.details.slotHeld).toBe(run.meta.publishedSlotHeld);
    // One walk, one number: the hold and the diff cannot disagree because they
    // are read out of the same partition.
    expect(run.meta.publishedKickoffHeld).toBeGreaterThan(0);
    expect(run.partition.moved.length).toBe(run.report.meta.movedGames);
  });

  it('counts a game that keeps its kickoff on other ground as a kickoff hold and not a slot hold', () => {
    // The distinction is the point of having two numbers: a family told a time
    // still has that time, and still has a notice to receive about the pitch.
    const hold = run.report.hold;
    expect(hold.slotHeld).toBeLessThanOrEqual(hold.kickoffHeld);
  });

  describe('the partition check can fail', () => {
    // Every assertion above passes over a partition that adds up. These are
    // the constructed breaks that prove the check is not decorative.
    const slot = { date: '2026-08-22', surfaceId: 'alder-park/pitch-1a', startMinutes: 510 };
    /** Counts the findings do not read; the partition's own lists are the subject. */
    const counts = {
      baselineGames: 0,
      held: 0,
      moved: 0,
      unplaced: 0,
      publishedKickoffHeld: 0,
      publishedSlotHeld: 0,
    };
    const holdEntry = { gameId: 'a', label: 'a v b', disposition: 'thawed', slot };
    const movedEntry = {
      gameId: 'b',
      label: 'c v d',
      disposition: 'thawed',
      changedFields: ['startMinutes'],
      before: slot,
      after: { ...slot, startMinutes: 600 },
    };

    it('reports a partition that does not account for the whole roster', () => {
      const findings = baselinePartitionFindings(
        { moved: [movedEntry], held: [holdEntry], unplaced: [], counts },
        { baselineGames: 5 }
      );
      expect(findings).toHaveLength(1);
      expect(findings[0].code).toBe(RESOLVE_REASON.RESOLVE_PUBLISHED_HOLD_PARTITION_INCOMPLETE);
      expect(findings[0].severity).toBe('blocking');
    });

    it('reports a game counted as both held and moved, which adds up perfectly', () => {
      // The total is right — one held, one moved, two games — and the answer
      // is still wrong twice. A check that only added the lengths would pass.
      const both = { ...movedEntry, gameId: 'a' };
      const findings = baselinePartitionFindings(
        { moved: [both], held: [holdEntry], unplaced: [], counts },
        { baselineGames: 2 }
      );
      expect(findings.map((finding) => finding.code)).toContain(
        RESOLVE_REASON.RESOLVE_PUBLISHED_HOLD_PARTITION_INCOMPLETE
      );
      expect(findings.some((finding) => Number(finding.details.inBoth) > 0)).toBe(true);
    });

    it('refuses to call an empty schedule a perfect hold', () => {
      const findings = baselinePartitionFindings(
        { moved: [], held: [], unplaced: [], counts },
        { baselineGames: 0 }
      );
      expect(findings.map((finding) => finding.code)).toContain(
        RESOLVE_REASON.RESOLVE_PUBLISHED_HOLD_PARTITION_INCOMPLETE
      );
    });

    it('passes a partition that is actually whole', () => {
      expect(
        baselinePartitionFindings(
          { moved: [movedEntry], held: [holdEntry], unplaced: [], counts },
          { baselineGames: 2 }
        )
      ).toEqual([]);
    });
  });
});

/* -------------------------------------------------------------------------- */
/* The two preconditions the chooseSlot() short-circuits rest on               */
/* -------------------------------------------------------------------------- */

/**
 * **Why this is two precondition tests and not one end-to-end test.**
 *
 * `chooseSlot()` breaks out of its scan in two places, and the first —
 * `if (best !== null && changeCost > best.score) break;` — compares a *change
 * cost* against a *total score*. It is exact only if no candidate's total can
 * fall below its own change cost, which needs every quality term to be
 * non-negative, and only if the candidates arrive ordered by non-decreasing
 * change cost.
 *
 * The obvious test is to run the pipeline with the breaks disabled and compare.
 * That was measured while 8.6 was being designed, by instrumenting the loop:
 * over **1361 invocations under the default weights** the answer was identical
 * every time, and in **0** of them was a second candidate ever scored — mean
 * scan depth 1.09 of 18.19 available candidates. It was then measured again
 * with the zero-clamp in `candidateObjectiveCounts()` deliberately removed, so
 * that quality terms *could* go negative and the break *could* prune a better
 * candidate, and it was **still identical**: on this corpus the anchor is
 * admitted first in essentially every call and no later candidate is ever
 * reachable.
 *
 * So the end-to-end comparison is a check that cannot be made to fail. It is
 * incident 4's shape — a perfect score meaning "I looked at nothing" — and
 * writing it down would be worse than writing nothing, because it would look
 * like coverage. What is testable, and is what the break actually rests on, is
 * the two preconditions, each with a meta-assertion that it examined the case
 * that could break it.
 */
describe('the short-circuits rest on two preconditions, and both are checked where they can fail', () => {
  it('no quality term can be negative, including when a candidate is cleaner than the baseline', () => {
    const weights = resolveObjectiveWeights(undefined);
    const slot = { date: '2026-08-22', surfaceId: 'alder-park/pitch-1a', startMinutes: 510 };
    /** Every shape of placement that could drive a term negative. */
    const cases = [
      { here: [], accepted: {} },
      { here: [['X', CONSTRAINT_SEVERITY.BLOCKING]], accepted: {} },
      { here: [['X', CONSTRAINT_SEVERITY.BLOCKING]], accepted: { X: 1 } },
      // The one that matters: the candidate carries *fewer* than the baseline
      // accepted, so the excess is negative before the clamp.
      { here: [['Y', CONSTRAINT_SEVERITY.COMPROMISE]], accepted: { Y: 4 } },
      { here: [], accepted: { Y: 3, X: 2 } },
      { here: [['Y', CONSTRAINT_SEVERITY.COMPROMISE]], accepted: { Y: 4, Z: 9 } },
    ];

    let negativeExcessCasesSeen = 0;
    for (const testCase of cases) {
      // `candidateObjectiveCounts()` reads `findingInstances`, the per-instance
      // record `checkPlacement()` builds; a finding naming no other game is
      // keyed by its code alone, which is every case here.
      /** @type {Record<string, { severity: string, count: number }>} */
      const findingInstances = {};
      for (const [code, severity] of testCase.here) {
        const entry = findingInstances[code];
        if (entry === undefined) findingInstances[code] = { severity, count: 1 };
        else entry.count += 1;
      }
      const placement = { findingInstances };
      const carriedHere = testCase.here.length;
      const acceptedTotal = Object.values(testCase.accepted).reduce((a, b) => a + b, 0);
      if (acceptedTotal > carriedHere) negativeExcessCasesSeen += 1;

      const counts = candidateObjectiveCounts({
        reference: slot,
        slot,
        placement: /** @type {any} */ (placement),
        accepted: testCase.accepted,
      });
      const scored = scoreObjective(counts, weights);
      expect(scored.qualityCost).toBeGreaterThanOrEqual(0);
      expect(scored.total).toBeGreaterThanOrEqual(scored.changeCost);
      for (const term of [
        RESOLVE_OBJECTIVE_TERM.BLOCKING_VIOLATION,
        RESOLVE_OBJECTIVE_TERM.COMPROMISE_VIOLATION,
        RESOLVE_OBJECTIVE_TERM.UNPLACED_GAME,
      ]) {
        expect(scored.terms[term].count).toBeGreaterThanOrEqual(0);
      }
    }

    // **The meta-assertion.** Without it this passes just as happily over six
    // cases that could never have gone negative in the first place, which is
    // the coverage assertion that cannot be made to fail.
    expect(negativeExcessCasesSeen).toBeGreaterThan(0);
  });

  it('refuses a negative weight, which is the other way the same term could go below zero', () => {
    // The counts are clamped; the multiplier is validated. Both halves have to
    // hold, and only the first was near the break's own docblock.
    expect(() => resolveObjectiveWeights({ compromiseViolation: -1 })).toThrow(/finite number/);
    for (const weight of Object.values(RESOLVE_OBJECTIVE_WEIGHTS)) {
      expect(weight).toBeGreaterThanOrEqual(0);
    }
  });

  it('offers candidates in non-decreasing change cost, over real corpus orderings', () => {
    const state = createResolveState({
      games: schedule.games.map((game) => ({ ...game })),
      dispositions: Object.fromEntries(
        schedule.games.map((game) => [game.id, FREEZE_DISPOSITION.THAWED])
      ),
      inventory: buildSlotInventory(schedule.games),
      ledger: createResolveLedger(),
    });
    const weights = resolveObjectiveWeights(undefined);

    let listsWithSeveralDistinctCosts = 0;
    let candidatesCompared = 0;
    for (const game of schedule.games) {
      const anchor = {
        date: game.date,
        surfaceId: game.surfaceId,
        startMinutes: game.startMinutes,
      };
      const candidates = candidateSlotsFor(state, game.id, anchor, weights);
      const costs = candidates.map(
        (candidate) =>
          scoreObjective(candidateObjectiveCounts({ reference: anchor, slot: candidate }), weights)
            .changeCost
      );
      if (new Set(costs).size > 1) listsWithSeveralDistinctCosts += 1;
      for (let i = 1; i < costs.length; i += 1) {
        candidatesCompared += 1;
        expect(costs[i]).toBeGreaterThanOrEqual(costs[i - 1]);
      }
    }

    // The meta-assertions: a single-candidate list is trivially ordered, and a
    // list whose every candidate costs the same is trivially non-decreasing.
    // Both would pass an ordering check that had stopped working.
    expect(candidatesCompared).toBeGreaterThan(0);
    expect(listsWithSeveralDistinctCosts).toBeGreaterThan(0);
  });
});
