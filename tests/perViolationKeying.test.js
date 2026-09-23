/**
 * **Per-instance keying (8.6 PR 2): which breach, not how many.**
 *
 * `resolve/` decides "is this new?" in five places: the placer's gate, the
 * objective's discount, `dislodge`, `local-search`, `pair-repair`, and `verify`
 * after the fact. Until this PR all of them compared **counts per code**, and
 * two measured gaps followed, both on the corpus's busiest venue-date with
 * clashes stacked into the baseline:
 *
 * - **Gap A — a swapped instance nets to zero.** Swap the movable halves of
 *   two accepted clashes and every game still carries one clash, each with a
 *   different opponent. The run came back `allowed` with no finding, `verify`
 *   included.
 * - **Gap B — acceptance travelled with the game.** A game dislodged off an
 *   accepted clash was re-placed *into* a clash on a different field, because
 *   its published slot's count was honoured at every slot.
 *
 * Every describe below pairs the case with a control on a clean baseline, so a
 * pass means the key changed the outcome and not that the scenario never
 * exercised it. Every roster is enumerated from the constructed schedule, never
 * from a run.
 *
 * @see packages/core/src/resolve/instances.js
 * @see fixtures/season-2026/README.md incidents 4 and 10
 */

import { describe, it, expect } from 'vitest';

import { buildAvailabilityCalendarFromSeason2026 } from '@squadlogic/core/availability/index.js';
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
import { toSeason2026Schedule } from '@squadlogic/core/ruleEngine/index.js';
import {
  FINDING_LOCUS,
  FINDING_LOCUS_BY_CODE,
  PLACEMENT_REASON_REGISTRIES,
  RESOLVE_REASON,
  acceptedAtSlot,
  applyChangeRequest,
  buildSlotInventory,
  candidateSlotsFor,
  checkPlacement,
  createResolveLedger,
  createResolveState,
  findingLocusOf,
  grownCodes,
  RESOLVE_OBJECTIVE_WEIGHTS,
  slotKey,
} from '@squadlogic/core/resolve/index.js';
import { FREEZE_DISPOSITION, freezeAllExcept } from '@squadlogic/core/freeze/index.js';

/* -------------------------------------------------------------------------- */
/* Corpus and engines                                                          */
/* -------------------------------------------------------------------------- */

const season = loadSeason2026();
const sunsets = loadSunsets();
const SEASON_YEAR = Number(sunsets[0].date.slice(0, 4));
const graph = buildFacilityGraphFromSeason2026(loadFacilityGeometry());
const timingTable = buildFormatTimingTableFromSeason2026(loadGameFormats());
const calendar = buildAvailabilityCalendarFromSeason2026(
  loadFacilityPermits({ seasonYear: SEASON_YEAR }),
  sunsets
);
const engines = {
  graph,
  table: timingTable,
  calendar,
  registry: buildSeason2026ConstraintRegistry(),
  resources: { graph, timingTable, calendar, venueComplexes: buildSeason2026VenueComplexMap() },
};
const schedule = toSeason2026Schedule(season);

/** A resolve state over a schedule, so placements are read from the real gate. */
function stateOver(sched) {
  return createResolveState({
    games: sched.games.map((game) => ({ ...game })),
    dispositions: Object.fromEntries(
      sched.games.map((game) => [game.id, FREEZE_DISPOSITION.THAWED])
    ),
    admittedSlotsByGameId: {},
    inventory: buildSlotInventory(sched.games),
    ledger: createResolveLedger(),
  });
}

/** @param {{ date: string, surfaceId: string, startMinutes: number }} game */
const slotOfGame = (game) => ({
  date: game.date,
  surfaceId: game.surfaceId,
  startMinutes: game.startMinutes,
});

/** Move `game` onto `target`'s slot, keeping its own length. */
const onto = (game, target) => ({
  ...game,
  surfaceId: target.surfaceId,
  startMinutes: target.startMinutes,
  endMinutes: target.startMinutes + (game.endMinutes - game.startMinutes),
});

/** Blocking instances of `gameId` where a run left it, or null if TIME TBD. */
function blockingAfter(run, gameId) {
  const placed = run.schedule.games.find((game) => game.id === gameId);
  if (!placed) return null;
  return checkPlacement(engines, run.state, gameId, slotOfGame(placed)).blockingInstanceCounts;
}

/* -------------------------------------------------------------------------- */
/* The busiest venue-date, and two same-format waves on it                     */
/* -------------------------------------------------------------------------- */

const WAVES = (() => {
  const byVenueDate = new Map();
  for (const game of schedule.games) {
    const key = `${game.date}|${game.venueId}`;
    byVenueDate.set(key, [...(byVenueDate.get(key) ?? []), game]);
  }
  const venueGames = [...byVenueDate.values()].sort((a, b) => b.length - a.length)[0];
  const format = venueGames[0].format;
  const same = venueGames.filter((game) => game.format === format);
  const kickoffs = [...new Set(same.map((game) => game.startMinutes))].sort((a, b) => a - b);
  const first = same.filter((game) => game.startMinutes === kickoffs[0]);
  const second = same.filter((game) => game.startMinutes === kickoffs[1]);
  if (first.length < 3 || second.length < 2) {
    throw new Error('the corpus no longer offers two same-format waves; rebuild these scenarios');
  }
  return { date: venueGames[0].date, first, second };
})();

/* -------------------------------------------------------------------------- */
/* The locus table: its universe first                                         */
/* -------------------------------------------------------------------------- */

describe('every placement finding code has a locus, and the universe is the one the gate sees', () => {
  const universe = Object.values(PLACEMENT_REASON_REGISTRIES).flatMap((registry) =>
    Object.values(registry)
  );

  /**
   * Every blocking or compromise code the gate actually produced over the
   * corpus: each game at its published slot and at every candidate the
   * inventory offers it — the space `chooseSlot()` walks.
   */
  const emitted = (() => {
    const state = stateOver(schedule);
    /** @type {Set<string>} */
    const codes = new Set();
    let placements = 0;
    for (const game of schedule.games) {
      const anchor = slotOfGame(game);
      for (const slot of [
        anchor,
        ...candidateSlotsFor(state, game.id, anchor, RESOLVE_OBJECTIVE_WEIGHTS),
      ]) {
        placements += 1;
        const placement = checkPlacement(engines, state, game.id, slot);
        for (const key of Object.keys(placement.findingInstances)) {
          codes.add(key.split('|')[0]);
        }
      }
    }
    return { codes, placements };
  })();

  it('classifies every code in the registries the gate draws from', () => {
    expect(universe.length).toBeGreaterThan(50);
    for (const code of universe) {
      expect(FINDING_LOCUS_BY_CODE[code], code).toMatch(/^(carried|placed)$/);
    }
    expect(Object.keys(FINDING_LOCUS_BY_CODE).length).toBe(new Set(universe).size);
  });

  it('covers every code the gate actually emitted over the corpus', () => {
    // The meta-assertion: this looked at thousands of placements and saw
    // blocking and compromise codes both, or the check below compares nothing.
    expect(emitted.placements).toBeGreaterThan(5000);
    expect(emitted.codes.size).toBeGreaterThan(2);
    const outside = [...emitted.codes].filter((code) => !(code in FINDING_LOCUS_BY_CODE));
    expect(outside).toEqual([]);
    // Positive control: the same predicate does flag a code outside the universe.
    expect(['NOT_A_REAL_CODE'].filter((code) => !(code in FINDING_LOCUS_BY_CODE))).toEqual([
      'NOT_A_REAL_CODE',
    ]);
  });

  it('files the scrimmages’ unsized format as carried, and an unknown code as placed', () => {
    expect(findingLocusOf('SIZE_UNKNOWN_FORMAT')).toBe(FINDING_LOCUS.CARRIED);
    expect(findingLocusOf('OCCUPIED_SAME_SURFACE')).toBe(FINDING_LOCUS.PLACED);
    expect(findingLocusOf('CLOSURE_BLOCKS_BOOKING')).toBe(FINDING_LOCUS.PLACED);
    expect(findingLocusOf('NOT_A_REAL_CODE')).toBe(FINDING_LOCUS.PLACED);
  });
});

/* -------------------------------------------------------------------------- */
/* The rule, at unit level, with the counts-per-code comparison as control      */
/* -------------------------------------------------------------------------- */

describe('acceptance belongs to a game on its published slot, per instance', () => {
  const record = {
    slotKey: 'd|s|540',
    instances: { 'OCCUPIED_SAME_SURFACE|g2': 1, SIZE_UNKNOWN_FORMAT: 1 },
  };

  it('accepts the same instance at the published slot and refuses a swapped one', () => {
    const accepted = acceptedAtSlot(record, 'd|s|540');
    expect(grownCodes({ 'OCCUPIED_SAME_SURFACE|g2': 1 }, accepted)).toEqual([]);
    expect(grownCodes({ 'OCCUPIED_SAME_SURFACE|g9': 1 }, accepted)).toEqual([
      'OCCUPIED_SAME_SURFACE',
    ]);
    // Control: keyed by code, the swapped instance is invisible.
    expect(grownCodes({ OCCUPIED_SAME_SURFACE: 1 }, { OCCUPIED_SAME_SURFACE: 1 })).toEqual([]);
  });

  it('carries only what travels with the game to any other slot', () => {
    const elsewhere = acceptedAtSlot(record, 'd|s2|600');
    expect(elsewhere).toEqual({ SIZE_UNKNOWN_FORMAT: 1 });
    expect(grownCodes({ 'OCCUPIED_SAME_SURFACE|g2': 1 }, elsewhere)).toEqual([
      'OCCUPIED_SAME_SURFACE',
    ]);
    expect(grownCodes({ SIZE_UNKNOWN_FORMAT: 1 }, elsewhere)).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Gap A: the swap                                                              */
/* -------------------------------------------------------------------------- */

describe('Gap A: trading one accepted clash for another is a new clash', () => {
  const [A, M1] = WAVES.first;
  const [C, D] = WAVES.second;
  const swap = [
    { gameId: M1.id, ...slotOfGame(C), reason: 'swap onto the other pile' },
    { gameId: D.id, ...slotOfGame(A), reason: 'swap onto the other pile' },
  ];
  const stacked = {
    ...schedule,
    games: schedule.games.map((game) =>
      game.id === M1.id ? onto(game, A) : game.id === D.id ? onto(game, C) : game
    ),
  };

  const run = applyChangeRequest({
    schedule: stacked,
    changes: swap,
    engines,
    verify: false,
    onUnsatisfiable: 'report',
  });
  const control = applyChangeRequest({
    schedule,
    changes: swap,
    engines,
    verify: false,
    onUnsatisfiable: 'report',
  });

  it('is built as a swap: each of the four games carried exactly one accepted clash', () => {
    const state = stateOver(stacked);
    for (const game of [A, M1, C, D]) {
      const placed = /** @type {any} */ (stacked.games.find((row) => row.id === game.id));
      expect(
        checkPlacement(engines, state, game.id, slotOfGame(placed)).blockingCodeCounts,
        game.id
      ).toEqual({ OCCUPIED_SAME_SURFACE: 1 });
    }
  });

  it('refuses both swapped requests, exactly as it does on a clean baseline', () => {
    const displaced = (r) =>
      r.findings.filter((finding) => finding.code === RESOLVE_REASON.RESOLVE_CHANGE_DISPLACED)
        .length;
    expect(displaced(control)).toBe(2);
    expect(displaced(run)).toBe(2);
    expect(run.status).not.toBe('allowed');
  });

  it('leaves no game standing in a clash it did not arrive with', () => {
    for (const game of [A, M1, C, D]) {
      const after = blockingAfter(run, game.id);
      expect(after, game.id).not.toBeNull();
      for (const key of Object.keys(/** @type {any} */ (after))) {
        expect([
          `OCCUPIED_SAME_SURFACE|${M1.id}`,
          `OCCUPIED_SAME_SURFACE|${A.id}`,
          `OCCUPIED_SAME_SURFACE|${D.id}`,
          `OCCUPIED_SAME_SURFACE|${C.id}`,
        ]).toContain(key);
      }
    }
    // Neither A nor C now shares a slot with the opponent the request sent it.
    expect(Object.keys(blockingAfter(run, A.id) ?? {})).not.toContain(
      `OCCUPIED_SAME_SURFACE|${D.id}`
    );
    expect(Object.keys(blockingAfter(run, C.id) ?? {})).not.toContain(
      `OCCUPIED_SAME_SURFACE|${M1.id}`
    );
  });

  describe('and verify sees the swap when the gate cannot act on it', () => {
    // Everyone pinned or frozen, so the swapped clashes stand and only `verify`
    // is left to say so. Per-code totals are identical before and after — the
    // meta-assertion that this is the case the old comparison could not see.
    const pinned = applyChangeRequest({
      schedule: stacked,
      changes: swap,
      engines,
      holdChanges: true,
      verify: true,
      onUnsatisfiable: 'report',
    });

    it('is a real swap to the rule engine: same totals per code, different instances', () => {
      const totals = (violations) => {
        /** @type {Record<string, number>} */
        const counts = {};
        for (const violation of violations)
          counts[violation.code] = (counts[violation.code] ?? 0) + 1;
        return counts;
      };
      const baselineRun = applyChangeRequest({
        schedule: stacked,
        changes: [{ gameId: A.id, ...slotOfGame(A), reason: 'no-op' }],
        engines,
        verify: true,
        onUnsatisfiable: 'report',
      });
      expect(pinned.verification).not.toBeNull();
      expect(baselineRun.verification).not.toBeNull();
      const overlapCodes = Object.keys(totals(pinned.verification.violations)).filter((code) =>
        pinned.verification.violations.some(
          (violation) =>
            violation.code === code &&
            violation.entities.some((entity) => entity.id === D.id || entity.id === M1.id)
        )
      );
      expect(overlapCodes.length).toBeGreaterThan(0);
      for (const code of overlapCodes) {
        expect(totals(pinned.verification.violations)[code], code).toBe(
          totals(baselineRun.verification.violations)[code]
        );
      }
    });

    it('reports the swapped instances as introduced', () => {
      const introduced = pinned.findings.filter(
        (finding) => finding.code === RESOLVE_REASON.RESOLVE_VERIFY_NEW_VIOLATION
      );
      expect(introduced.length).toBeGreaterThan(0);
      for (const finding of introduced) {
        expect(finding.details.introduced).toBeGreaterThan(0);
      }
    });
  });
});

/* -------------------------------------------------------------------------- */
/* Gap B: acceptance travelling with the game                                   */
/* -------------------------------------------------------------------------- */

describe('Gap B: a displaced game does not take its accepted clash with it', () => {
  const [A, M1] = WAVES.first;
  const W = WAVES.second[0];
  const request = [{ gameId: W.id, ...slotOfGame(A), reason: 'onto the accepted clash' }];
  const stacked = {
    ...schedule,
    games: schedule.games.map((game) => (game.id === M1.id ? onto(game, A) : game)),
  };
  const options = {
    changes: request,
    engines,
    freeze: freezeAllExcept([{ date: WAVES.date }]),
    holdChanges: true,
    verify: false,
    onUnsatisfiable: /** @type {'report'} */ ('report'),
  };
  const run = applyChangeRequest({ schedule: stacked, ...options });
  const control = applyChangeRequest({ schedule, ...options });

  it('really does dislodge the clash, in both runs', () => {
    for (const r of [run, control]) {
      expect(r.moves.some((move) => move.stageId === 'dislodge' && move.gameId === A.id)).toBe(
        true
      );
    }
  });

  it('re-places every game on the date clear of any blocking instance it did not arrive with', () => {
    const onDate = stacked.games.filter((game) => game.date === WAVES.date);
    const accepted = stateOver(stacked);
    let examined = 0;
    for (const game of onDate) {
      const after = blockingAfter(run, game.id);
      expect(after, `${game.id} was dropped`).not.toBeNull();
      examined += 1;
      const placed = /** @type {any} */ (run.schedule.games.find((row) => row.id === game.id));
      const baseline = checkPlacement(engines, accepted, game.id, slotOfGame(game));
      const record = {
        slotKey: slotKey(slotOfGame(game)),
        instances: baseline.blockingInstanceCounts,
      };
      expect(
        grownCodes(/** @type {any} */ (after), acceptedAtSlot(record, slotKey(slotOfGame(placed)))),
        game.id
      ).toEqual([]);
    }
    expect(examined).toBe(onDate.length);
    expect(Object.keys(blockingAfter(run, A.id) ?? {})).toEqual([]);
  });
});

describe('the published slot accepts the clash it published, and not a clash with somebody new', () => {
  // Where the **counterpart** half of the key is load-bearing on its own. The
  // slot half catches every game that moved; this is the one game that did
  // not. A published beside M1 in an accepted clash; the request sends M1 home
  // and pins D onto A's slot. A is dislodged, and the nearest candidate the
  // placer can offer it is its own published slot — now shared with D. Keyed
  // by code, that slot still "carries one accepted clash", scores zero, and A
  // goes straight back into a clash nobody published; keyed per instance the
  // placer refuses it and A lands clean, with nothing left for a later stage to
  // clean up.
  const [A, M1] = WAVES.first;
  const D = WAVES.second[0];
  const stacked = {
    ...schedule,
    games: schedule.games.map((game) => (game.id === M1.id ? onto(game, A) : game)),
  };
  const run = applyChangeRequest({
    schedule: stacked,
    changes: [
      { gameId: M1.id, ...slotOfGame(M1), reason: 'home to where the corpus has it' },
      { gameId: D.id, ...slotOfGame(A), reason: 'onto the accepted clash' },
    ],
    engines,
    freeze: freezeAllExcept([{ date: WAVES.date }]),
    holdChanges: true,
    verify: false,
    onUnsatisfiable: 'report',
  });
  const stage = (id) => /** @type {any} */ (run.stages.find((entry) => entry.stageId === id));

  it('dislodges A, which is the case under test', () => {
    expect(run.moves.some((move) => move.stageId === 'dislodge' && move.gameId === A.id)).toBe(
      true
    );
  });

  it('never places A back beside D, so no later stage has to move it again', () => {
    const placements = run.moves.filter(
      (move) => move.gameId === A.id && move.stageId !== 'dislodge'
    );
    expect(placements).toHaveLength(1);
    expect(placements[0].stageId).toBe('initial-assignment');
    expect(slotKey(/** @type {any} */ (placements[0].to))).not.toBe(slotKey(slotOfGame(A)));
    expect(stage('pair-repair').movesApplied).toBe(0);
    expect(blockingAfter(run, A.id)).toEqual({});
    expect(blockingAfter(run, D.id)).toEqual({});
  });
});

/* -------------------------------------------------------------------------- */
/* Fragility 1: the four scrimmages                                             */
/* -------------------------------------------------------------------------- */

describe('a scrimmage asked onto another slot keeps it, because its unsized format travels with it', () => {
  // **Fragility 1, checked first.** The four `Scrimmage` rows carry
  // `SIZE_UNKNOWN_FORMAT` wherever they stand (GAP-14: no size row). Filed as
  // placed, that finding would be "new" at every slot but a scrimmage's own, and
  // any request moving one would be dislodged and displaced. Two scrimmages on
  // one slot do not clash here — no timing row, so the footprint is unknown and
  // the overlap is a compromise — which is why the case is a requested move and
  // not a displacement.
  const state = stateOver(schedule);
  const unsized = schedule.games.filter(
    (game) =>
      checkPlacement(engines, state, game.id, slotOfGame(game)).blockingCodeCounts
        .SIZE_UNKNOWN_FORMAT > 0
  );
  const [first, second] = unsized.filter((game) => game.date === unsized[0].date);

  it('finds the scrimmages from the roster', () => {
    expect(unsized.length).toBe(4);
    expect(second).toBeTruthy();
  });

  it('lands the requested move, carrying the finding it always carries and nothing more', () => {
    const run = applyChangeRequest({
      schedule,
      changes: [{ gameId: first.id, ...slotOfGame(second), reason: 'onto the later kickoff' }],
      engines,
      verify: false,
      onUnsatisfiable: 'report',
    });
    expect(run.moves.map((move) => `${move.stageId}:${move.gameId}`)).toEqual([
      `change-request-apply:${first.id}`,
    ]);
    expect(run.unplaced).toEqual([]);
    expect(
      run.findings.some((finding) => finding.code === RESOLVE_REASON.RESOLVE_CHANGE_DISPLACED)
    ).toBe(false);
    const placed = /** @type {any} */ (run.schedule.games.find((game) => game.id === first.id));
    expect(slotKey(slotOfGame(placed))).toBe(slotKey(slotOfGame(second)));
    expect(blockingAfter(run, first.id)).toEqual({ SIZE_UNKNOWN_FORMAT: 1 });
  });
});

/* -------------------------------------------------------------------------- */
/* The plan's own item 1, enforced rather than argued                           */
/* -------------------------------------------------------------------------- */

describe('two clashes that share a game are cleared by one move', () => {
  // `PHASE_8_PLAN.md` 8.6 item 1: "keyed per GAME, not per violation. Two
  // violations sharing an entity should be fixable by one move." Three games
  // stacked on one slot make three clashes; the first game moved clears the
  // two it shared, and because `local-search` re-reads the board before each
  // game, the third game is found clean and keeps its published slot.
  const [A, M1, M2] = WAVES.first;
  const stacked = {
    ...schedule,
    games: schedule.games.map((game) =>
      game.id === M1.id || game.id === M2.id ? onto(game, A) : game
    ),
  };
  const noOp = /** @type {any} */ (
    schedule.games.find(
      (game) => game.date === WAVES.date && ![A.id, M1.id, M2.id].includes(game.id)
    )
  );
  const run = applyChangeRequest({
    schedule: stacked,
    changes: [{ gameId: noOp.id, ...slotOfGame(noOp), reason: 'the run has to happen' }],
    engines,
    freeze: freezeAllExcept([{ date: WAVES.date }]),
    repairScope: [A.id, M1.id, M2.id],
    verify: false,
    onUnsatisfiable: 'report',
  });
  const stage = (id) => /** @type {any} */ (run.stages.find((entry) => entry.stageId === id));

  it('starts from three clashes, two of them on each game', () => {
    const state = stateOver(stacked);
    for (const game of [A, M1, M2]) {
      expect(
        checkPlacement(engines, state, game.id, slotOfGame(A)).blockingCodeCounts
          .OCCUPIED_SAME_SURFACE,
        game.id
      ).toBe(2);
    }
  });

  it('clears all three with two moves, both made by local-search, and none by pair-repair', () => {
    expect(stage('local-search').movesApplied).toBe(2);
    expect(stage('pair-repair').movesApplied).toBe(0);
    expect(stage('dislodge').movesApplied).toBe(0);
    for (const game of [A, M1, M2]) {
      expect(blockingAfter(run, game.id), game.id).toEqual({});
    }
    const held = [A, M1, M2].filter((game) => {
      const placed = run.schedule.games.find((row) => row.id === game.id);
      return placed && placed.surfaceId === A.surfaceId && placed.startMinutes === A.startMinutes;
    });
    expect(held).toHaveLength(1);
  });
});
