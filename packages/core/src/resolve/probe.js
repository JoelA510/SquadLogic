/**
 * The adversarial probe every stage has to survive, generated from the stage's
 * own `freezeContract`.
 *
 * > *"In the source project the initial assignment respected the freeze but the
 * > local-search and repair passes did not, and quietly swapped four frozen
 * > games. Add a test per stage."*
 *
 * A test per stage is necessary and, written by hand, not sufficient: eight
 * hand-written tests are eight chances to write the one that passes without
 * testing anything. So the probe is **generated** from the contract the stage
 * already had to declare, and the assertions it makes are fixed:
 *
 * | contract probe | what is asserted |
 * |---|---|
 * | `offers-frozen-move` | no frozen game moved **and** `movesRejectedByFreeze` grew by at least one |
 * | `writes-nothing` | the stage applied no move at all and every placement is identical |
 *
 * **The second half of the first row is the whole point.** "No frozen game
 * moved" is satisfied just as happily by a stage that honours the freeze and by
 * a stage that never looked at the schedule — and the second kind is exactly
 * what a refactor produces. The rejection counter is the difference between
 * *"it did not move anything it should not have"* and *"it was asked, and it
 * said no"*.
 *
 * ## One adversarial state, not eight
 *
 * The setup is deliberately shared: every mutating stage is run against the same
 * state, in which a game has been pushed into a clash, another has been lifted
 * out of its slot, and then **everything has been frozen**. Each stage finds its
 * own reason to want to move something there — the change request names a frozen
 * game, `dislodge` finds a clash whose every party is held, `initial-assignment`
 * finds a frozen game waiting to be placed, `local-search` finds a frozen game
 * standing somewhere illegal, `pair-repair` finds its frozen counterpart — and
 * none of them may. A per-stage fixture could have been tuned until it passed;
 * a shared one cannot.
 *
 * @module resolve/probe
 */

import { freezeAllExcept, judgeFreezeAll } from '../freeze/plan.js';
import { getSurface } from '../facility/facilityGraph.js';

import { buildSlotInventory } from './inventory.js';
import { RESOLVE_OBJECTIVE_WEIGHTS } from './objective.js';
import { STAGE_PROBE } from './schemas.js';
import {
  MOVE_KIND,
  applyMove,
  createResolveLedger,
  createResolveState,
  pinGames,
  resolveContextDefaults,
  slotKey,
} from './state.js';

/** The stage id the probe's own setup writes under. */
const SETUP_STAGE_ID = '__probe_setup__';

/**
 * A placement fingerprint, for "did anything move?".
 *
 * @param {import('./types.js').ResolveState} state
 * @returns {Record<string, string>}
 */
function fingerprint(state) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const gameId of state.gameIds) {
    const game = state.games[gameId];
    out[gameId] = game === undefined ? '' : `${game.date}|${game.surfaceId}|${game.startMinutes}`;
  }
  return out;
}

/**
 * Build the shared adversarial state: a clash, a game waiting to be placed, and
 * every single game frozen.
 *
 * @param {Object} input
 * @returns {{ state: import('./types.js').ResolveState, context: Object }}
 */
export function buildAdversarialState(input) {
  const { engines, games, baseSchedule, clash, pendingGameId, change } = input;
  const ids = games.map((game) => game.id);

  // The probe's own meta-assertions. Each of these mis-set would make some
  // stage's probe pass by examining nothing, which is the failure this whole
  // file exists to prevent — so they throw rather than degrade.
  if (!clash || !clash.gameId || !clash.slot) {
    throw new Error(
      'resolve: the probe needs a `clash` naming a game and the slot to push it onto; without one no stage would find anything it wanted to repair'
    );
  }
  if (!pendingGameId) {
    throw new Error(
      'resolve: the probe needs a `pendingGameId` to lift out of the schedule; without one initial-assignment has nothing to place'
    );
  }
  for (const [name, gameId] of [
    ['clash.gameId', clash.gameId],
    ['pendingGameId', pendingGameId],
    ['change.gameId', change?.gameId],
  ]) {
    if (gameId !== undefined && !ids.includes(/** @type {string} */ (gameId))) {
      throw new Error(`resolve: the probe's ${name} ("${gameId}") is not in the game slice`);
    }
  }
  if (change && change.gameId === pendingGameId) {
    throw new Error(
      'resolve: the probe cannot ask the change-request stage to move the game it also lifted out of the schedule; that stage would report an unknown game and consider nothing'
    );
  }
  if (change && change.gameId === clash.gameId) {
    throw new Error(
      'resolve: the probe cannot point the change request at the game it also pushed into a clash; the two setups would fight over one slot'
    );
  }
  const plan = freezeAllExcept(
    ids.map((gameId) => ({ gameId })),
    { name: 'probe setup: everything thawed, then pinned' }
  );
  const judgements = judgeFreezeAll(
    plan,
    games.map((game) => {
      const surface = getSurface(engines.graph, game.surfaceId);
      return {
        gameId: game.id,
        date: game.date,
        divisionLabel: game.divisionLabel,
        venueId: game.venueId,
        surfaceId: game.surfaceId,
        surfaceLineage: surface ? [...surface.lineage] : [game.surfaceId],
        format: game.format,
        teamIds: [game.homeTeamId, game.awayTeamId].filter(
          (id) => typeof id === 'string' && id.length > 0
        ),
      };
    })
  );
  /** @type {Record<string, string>} */
  const dispositions = {};
  for (const [gameId, judgement] of Object.entries(judgements.byGameId)) {
    dispositions[gameId] = judgement.disposition;
  }

  const inventory = buildSlotInventory(games);
  const ledger = createResolveLedger();
  let state = createResolveState({
    games,
    dispositions,
    inventory,
    ledger,
    admittedSlotsByGameId: {
      [clash.gameId]: [slotKey(clash.slot)],
      ...(change ? { [change.gameId]: [slotKey(change.slot)] } : {}),
    },
  });

  /** @type {Object} */
  const context = {
    ...resolveContextDefaults(),
    engines,
    changes: change
      ? [
          {
            gameId: change.gameId,
            date: change.slot.date,
            surfaceId: change.slot.surfaceId,
            startMinutes: change.slot.startMinutes,
            reason: 'the probe asks a frozen game to move',
          },
        ]
      : [],
    plan,
    judgements,
    weights: RESOLVE_OBJECTIVE_WEIGHTS,
    dislodgeAll: false,
    // The probe is testing the freeze, not the error path: a clash in which
    // nothing may move is the *expected* outcome here, so it is reported rather
    // than thrown.
    onUnsatisfiable: 'report',
    touchedDates: [...new Set(games.map((game) => game.date))].sort(),
    baselineVerification: null,
    baselineSnapshot: fingerprint(state),
    runVerification: () => null,
    baseSchedule,
  };

  // 1. Record what the schedule already carried, so the stages below react to
  //    the clash the probe creates rather than to anything pre-existing.
  const ingest = input.stages.find((stage) => stage.id === 'baseline-ingest');
  if (!ingest) {
    throw new Error(
      'resolve: the probe needs the baseline-ingest stage in `stages` to record what the schedule already carried; without it every stage would react to pre-existing findings instead of to the clash the probe creates'
    );
  }
  state = ingest.run(state, context);

  // 2. Push one game into a clash, and lift another out of its slot. Both are
  //    real writes through the one writer, made while everything is still
  //    thawed — which is the only way a legitimate state can contain them.
  state = applyMove(
    state,
    {
      gameId: clash.gameId,
      kind: MOVE_KIND.RELOCATE,
      to: clash.slot,
      reason: 'probe setup: create a clash the stages will want to repair',
    },
    SETUP_STAGE_ID
  );
  state = applyMove(
    state,
    {
      gameId: pendingGameId,
      kind: MOVE_KIND.DISLODGE,
      to: null,
      reason: 'probe setup: leave a game waiting to be placed',
    },
    SETUP_STAGE_ID
  );

  // 3. Freeze everything. From here nothing in the pipeline may move a thing.
  state = pinGames(state, state.gameIds, 'probe setup: every game is frozen');

  return { state, context };
}

/**
 * Run one stage against the adversarial state and judge it by its own contract.
 *
 * @param {import('./types.js').ResolveStage} stage
 * @param {Object} input - see {@link buildAdversarialState}
 * @returns {{ stageId: string, probe: string, satisfied: boolean, failures: string[], moved: string[], movesConsidered: number, movesRejectedByFreeze: number, movesApplied: number }}
 */
export function probeStage(stage, input) {
  const { state, context } = buildAdversarialState({ ...input, stages: input.stages });
  const before = fingerprint(state);
  const beforeCounters = { ...(state.ledger.byStage[stage.id] ?? {}) };

  const after = stage.run(state, context);
  const afterPrint = fingerprint(after);
  const counters = after.ledger.byStage[stage.id] ?? { considered: 0, rejected: 0, applied: 0 };

  const moved = after.gameIds.filter((gameId) => before[gameId] !== afterPrint[gameId]);
  const movesConsidered = counters.considered - (beforeCounters.considered ?? 0);
  const movesRejectedByFreeze = counters.rejected - (beforeCounters.rejected ?? 0);
  const movesApplied = counters.applied - (beforeCounters.applied ?? 0);

  /** @type {string[]} */
  const failures = [];
  if (moved.length > 0) {
    failures.push(
      `stage "${stage.id}" moved ${moved.length} frozen game(s): ${moved.slice(0, 5).join(', ')}`
    );
  }
  if (movesApplied > 0) {
    failures.push(`stage "${stage.id}" applied ${movesApplied} move(s) with everything frozen`);
  }
  if (stage.freezeContract.probe === STAGE_PROBE.OFFERS_FROZEN_MOVE) {
    if (movesRejectedByFreeze < 1) {
      failures.push(
        `stage "${stage.id}" declares mutation kinds and was offered a frozen game it would want to move, and its rejection counter did not move; "nothing moved" from a stage that never looked is not evidence of anything (incident 2)`
      );
    }
  } else if (movesConsidered > 0) {
    failures.push(
      `stage "${stage.id}" declares that it writes nothing and considered ${movesConsidered} move(s)`
    );
  }

  return {
    stageId: stage.id,
    probe: stage.freezeContract.probe,
    satisfied: failures.length === 0,
    failures,
    moved,
    movesConsidered,
    movesRejectedByFreeze,
    movesApplied,
  };
}

/**
 * Probe every stage of a pipeline.
 *
 * @param {ReadonlyArray<import('./types.js').ResolveStage>} stages
 * @param {Object} input
 * @returns {Array<ReturnType<typeof probeStage>>}
 */
export function probeEveryStage(stages, input) {
  return stages.map((stage) => probeStage(stage, { ...input, stages }));
}
