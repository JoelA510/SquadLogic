/**
 * The placement state and **the one function that may change it**.
 *
 * Three interlocking guarantees live in this file, and none of them is
 * sufficient on its own:
 *
 * 1. **One mutation chokepoint.** {@link applyMove} is the only writer. Every
 *    stage that relocates, dislodges or shelves a game goes through it, and it
 *    judges the freeze before it writes. A frozen game throws
 *    {@link FrozenGameMoveAttempt}, naming the stage that tried.
 * 2. **The state is deep-frozen.** A stage cannot edit a placement in place
 *    even if it wants to; `applyMove` returns a new frozen state. The one
 *    exception is `state.ledger`, which is the run's mutable recorder and is
 *    deliberately not frozen — counters and the move log have to accumulate
 *    somewhere, and keeping them outside the placement data is what lets the
 *    placement data be immutable at all.
 * 3. **The audit compares the result against the position each game was held
 *    at.** Freezing an object stops a stage mutating it; it does not stop a
 *    stage *returning a state it built itself*. `stages.js`'s `freeze-audit` is
 *    the check that catches that, and it derives its verdict from the schedule
 *    rather than from the ledger — a stage that wrote around the gate would not
 *    be in the ledger, which is exactly the case it exists for. The reference
 *    is the baseline for a game the plan froze and {@link pinGames}'s
 *    `pinnedAt` for a game frozen part-way through the run.
 *
 * Incident 2 is why all three are here: after freeze support was added to the
 * source project, *"the initial assignment honored it but the local-search and
 * pair-repair stages quietly swapped four frozen games"*. One honest stage and
 * two dishonest ones is the normal failure, and a guarantee that depends on
 * every stage remembering is not a guarantee.
 *
 * @module resolve/state
 */

import { FREEZE_DISPOSITION, FREEZE_REASON, makeFreezeFinding } from '../freeze/reasonCodes.js';

import { RESOLVE_REASON, createResolveMeta, makeResolveFinding } from './reasonCodes.js';

/** The kinds of write {@link applyMove} accepts. */
export const MOVE_KIND = Object.freeze({
  /** Put the game on a different slot. */
  RELOCATE: 'relocate',
  /** Lift the game out of its slot; it joins `pending`. */
  DISLODGE: 'dislodge',
  /** Shelve the game with a reason: incident 10's TIME TBD. */
  TIME_TBD: 'time-tbd',
});

/**
 * Thrown when a stage reaches the writer with a frozen game in hand.
 *
 * Carries the stage id because "some stage moved it" is the report incident 2
 * already had, and it took a diff to find out which.
 */
export class FrozenGameMoveAttempt extends Error {
  /**
   * @param {{ gameId: string, stageId: string, kind: string, ruleId: string|null, from: import('./types.js').Slot|null, to: import('./types.js').Slot|null }} detail
   */
  constructor(detail) {
    super(
      `resolve: stage "${detail.stageId}" tried to ${detail.kind} frozen game "${detail.gameId}"` +
        (detail.ruleId ? ` (held by "${detail.ruleId}")` : ' (held by the plan default)') +
        '. The game has NOT been moved.'
    );
    this.name = 'FrozenGameMoveAttempt';
    this.gameId = detail.gameId;
    this.stageId = detail.stageId;
    this.kind = detail.kind;
    this.ruleId = detail.ruleId;
    this.from = detail.from;
    this.to = detail.to;
  }
}

/**
 * Recursively freeze a value, leaving `ledger` alone.
 *
 * @param {unknown} value
 * @param {boolean} [isRoot]
 * @returns {unknown}
 */
function deepFreeze(value, isRoot = false) {
  if (value === null || typeof value !== 'object') return value;
  if (Object.isFrozen(value)) return value;
  for (const [key, child] of Object.entries(value)) {
    // The ledger is the run's mutable recorder and is the single deliberate
    // hole in the freeze. Everything a stage could mistake for placement data
    // is frozen; nothing that accumulates counters is.
    if (isRoot && key === 'ledger') continue;
    deepFreeze(child);
  }
  return Object.freeze(value);
}

/**
 * A fresh, empty ledger.
 *
 * @returns {import('./types.js').ResolveLedger}
 */
export function createResolveLedger() {
  return { meta: createResolveMeta(), moves: [], findings: [], byStage: {} };
}

/**
 * The per-stage counters, created on first use.
 *
 * Kept per stage as well as per run because the guarantee incident 2 needs is
 * per stage: "the pipeline rejected some moves" is satisfied by one honest
 * stage and seven blind ones.
 *
 * @param {import('./types.js').ResolveLedger} ledger
 * @param {string} stageId
 * @returns {{ considered: number, rejected: number, applied: number }}
 */
export function stageCounters(ledger, stageId) {
  if (!ledger.byStage[stageId]) {
    ledger.byStage[stageId] = { considered: 0, rejected: 0, applied: 0 };
  }
  return ledger.byStage[stageId];
}

/**
 * The slot a game currently stands on, or null when it is pending or shelved.
 *
 * @param {import('./types.js').ResolveState} state
 * @param {string} gameId
 * @returns {import('./types.js').Slot|null}
 */
export function slotOf(state, gameId) {
  const game = state.games[gameId];
  if (!game) return null;
  return { date: game.date, surfaceId: game.surfaceId, startMinutes: game.startMinutes };
}

/**
 * A slot as a comparable key.
 *
 * @param {import('./types.js').Slot|null} slot
 * @returns {string}
 */
export function slotKey(slot) {
  return slot === null ? '' : `${slot.date}|${slot.surfaceId}|${slot.startMinutes}`;
}

/**
 * Build the initial state.
 *
 * @param {{ games: ReadonlyArray<import('./types.js').PlacedGame>, dispositions: Record<string, string>, admittedSlotsByGameId?: Record<string, string[]>, inventory: import('./types.js').SlotInventory, ledger: import('./types.js').ResolveLedger }} input
 * @returns {import('./types.js').ResolveState}
 */
export function createResolveState(input) {
  /** @type {Record<string, import('./types.js').PlacedGame>} */
  const games = {};
  /** @type {Record<string, import('./types.js').PlacedGame>} */
  const baseline = {};
  for (const game of input.games) {
    if (games[game.id]) {
      throw new Error(`resolve: two games claim the id "${game.id}"`);
    }
    games[game.id] = { ...game };
    baseline[game.id] = { ...game };
  }
  const gameIds = Object.keys(games).sort();
  for (const gameId of gameIds) {
    if (input.dispositions[gameId] === undefined) {
      throw new Error(
        `resolve: game "${gameId}" reached the state with no freeze disposition; every game is judged before anything runs, or the run's "no frozen game moved" verdict means nothing`
      );
    }
  }

  return /** @type {import('./types.js').ResolveState} */ (
    deepFreeze(
      {
        gameIds,
        games,
        baseline,
        dispositions: { ...input.dispositions },
        admittedSlotsByGameId: { ...(input.admittedSlotsByGameId ?? {}) },
        // Empty until `pinGames()` runs: nothing has been frozen mid-run yet,
        // so every frozen game's reference position is still the baseline's.
        pinnedAt: {},
        pending: [],
        unplaced: [],
        inventory: input.inventory,
        ledger: input.ledger,
      },
      true
    )
  );
}

/**
 * Is this game frozen?
 *
 * @param {import('./types.js').ResolveState} state
 * @param {string} gameId
 * @returns {boolean}
 */
export function isFrozen(state, gameId) {
  const disposition = state.dispositions[gameId];
  if (disposition === undefined) {
    throw new Error(`resolve: game "${gameId}" has no freeze disposition`);
  }
  return disposition === FREEZE_DISPOSITION.FROZEN;
}

/**
 * **The polite half of the chokepoint.** Ask whether a game may be moved.
 *
 * Every compliant stage calls this before it calls {@link applyMove}, and skips
 * the game when the answer is no. The counter it maintains —
 * `movesRejectedByFreeze` — is what gives the per-stage probes their teeth: a
 * probe that only asserted "no frozen game moved" would pass against a stage
 * that never considered one.
 *
 * @param {import('./types.js').ResolveState} state
 * @param {string} gameId
 * @param {string} stageId
 * @param {string} reason - what the stage wanted to do
 * @returns {boolean}
 */
export function mayMove(state, gameId, stageId, reason) {
  const ledger = state.ledger;
  const counters = stageCounters(ledger, stageId);
  ledger.meta.movesConsidered += 1;
  counters.considered += 1;
  if (!isFrozen(state, gameId)) return true;

  ledger.meta.movesRejectedByFreeze += 1;
  counters.rejected += 1;
  ledger.findings.push(
    makeFreezeFinding(
      FREEZE_REASON.FREEZE_MOVE_REFUSED,
      `stage "${stageId}" considered moving frozen game "${gameId}" (${reason}) and was refused`,
      { gameId, stageId, reason }
    )
  );
  return false;
}

/**
 * Is this slot one the baseline schedule actually used, or one a change request
 * brought with it?
 *
 * @param {import('./types.js').ResolveState} state
 * @param {string} gameId
 * @param {import('./types.js').Slot} slot
 * @returns {boolean}
 */
export function isSlotAdmissible(state, gameId, slot) {
  if ((state.admittedSlotsByGameId[gameId] ?? []).includes(slotKey(slot))) return true;
  const inventory = state.inventory;
  if (!inventory.dates.includes(slot.date)) return false;
  const venueId = inventory.venueBySurfaceId[slot.surfaceId];
  if (venueId === undefined) return false;
  const kickoffs = inventory.kickoffsByDateVenue[`${slot.date}|${venueId}`] ?? [];
  return kickoffs.includes(slot.startMinutes);
}

/**
 * **The one writer.**
 *
 * Judges the freeze, checks the slot against the inventory, records the move in
 * the ledger and returns a new deep-frozen state. There is no other way to
 * change a placement in this package, and `freeze-audit` proves it afterwards
 * rather than trusting it.
 *
 * @param {import('./types.js').ResolveState} state
 * @param {import('./types.js').Move} move
 * @param {string} stageId
 * @returns {import('./types.js').ResolveState}
 */
export function applyMove(state, move, stageId) {
  const ledger = state.ledger;
  const baseline = state.baseline[move.gameId];
  if (!baseline) {
    throw new Error(
      `resolve: stage "${stageId}" tried to move game "${move.gameId}", which this run does not hold`
    );
  }

  const counters = stageCounters(ledger, stageId);

  if (isFrozen(state, move.gameId)) {
    // A stage that reached here without asking is by definition non-compliant,
    // so this counts the rejection itself rather than assuming `mayMove()` did.
    ledger.meta.movesRejectedByFreeze += 1;
    counters.rejected += 1;
    const detail = {
      gameId: move.gameId,
      stageId,
      kind: move.kind,
      ruleId: null,
      from: slotOf(state, move.gameId),
      to: move.to,
    };
    ledger.findings.push(
      makeFreezeFinding(
        FREEZE_REASON.FREEZE_MOVE_ATTEMPTED,
        `stage "${stageId}" reached the writer holding frozen game "${move.gameId}"; the write was refused and the game has NOT been moved`,
        { gameId: move.gameId, stageId, kind: move.kind, reason: move.reason }
      )
    );
    throw new FrozenGameMoveAttempt(detail);
  }

  const from = slotOf(state, move.gameId);

  if (move.kind === MOVE_KIND.RELOCATE) {
    const to = /** @type {import('./types.js').Slot} */ (move.to);
    if (!isSlotAdmissible(state, move.gameId, to)) {
      ledger.findings.push(
        makeResolveFinding(
          RESOLVE_REASON.RESOLVE_SLOT_OUTSIDE_INVENTORY,
          `stage "${stageId}" offered game "${move.gameId}" the slot ${slotKey(to)}, which the baseline schedule never used and no change request named; this package re-places games, it does not invent slots`,
          { gameId: move.gameId, stageId, slot: slotKey(to) }
        )
      );
      throw new Error(
        `resolve: stage "${stageId}" offered game "${move.gameId}" the slot ${slotKey(to)}, which is not in the baseline inventory`
      );
    }
  }

  /** @type {Record<string, import('./types.js').PlacedGame>} */
  const games = { ...state.games };
  let pending = [...state.pending];
  let unplaced = [...state.unplaced];

  if (move.kind === MOVE_KIND.RELOCATE) {
    const to = /** @type {import('./types.js').Slot} */ (move.to);
    // The footprint travels with the game. Occupancy comes from the format
    // table via `checkKickoffAvailability`; re-deriving a duration here would
    // be a second copy of a number `timing/` already owns, and GAP-14's
    // unknown-footprint rows must stay unknown.
    const occupancy =
      baseline.endMinutes === null ? null : baseline.endMinutes - baseline.startMinutes;
    games[move.gameId] = {
      ...baseline,
      date: to.date,
      surfaceId: to.surfaceId,
      venueId: state.inventory.venueBySurfaceId[to.surfaceId] ?? baseline.venueId,
      startMinutes: to.startMinutes,
      endMinutes: occupancy === null ? null : to.startMinutes + occupancy,
    };
    pending = pending.filter((id) => id !== move.gameId);
    unplaced = unplaced.filter((entry) => entry.gameId !== move.gameId);
    ledger.meta.gamesReplaced += 1;
  } else if (move.kind === MOVE_KIND.DISLODGE) {
    delete games[move.gameId];
    if (!pending.includes(move.gameId)) pending.push(move.gameId);
    unplaced = unplaced.filter((entry) => entry.gameId !== move.gameId);
    ledger.meta.gamesDislodged += 1;
  } else if (move.kind === MOVE_KIND.TIME_TBD) {
    delete games[move.gameId];
    pending = pending.filter((id) => id !== move.gameId);
    if (!unplaced.some((entry) => entry.gameId === move.gameId)) {
      unplaced.push({ gameId: move.gameId, reason: move.reason });
    }
    ledger.meta.gamesTimeTbd += 1;
  } else {
    throw new Error(`resolve: stage "${stageId}" asked for unknown move kind "${move.kind}"`);
  }

  ledger.meta.movesApplied += 1;
  counters.applied += 1;
  ledger.moves.push({
    seq: ledger.moves.length,
    stageId,
    gameId: move.gameId,
    kind: move.kind,
    from,
    to: move.to,
    reason: move.reason,
    // **Why**, in machine-readable form, from the stage that decided it.
    // `reason` is a sentence for a human and is never parsed; `cause` is what
    // `report.js` reads to say which constraint instance forced a game nobody
    // asked about to move. A move with no cause is not an error here — a
    // re-placement inherits the cause of the move that lifted it out — but a
    // *moved game* with no cause anywhere in its slice of the ledger is, and
    // the report says so at blocking.
    cause: move.cause ?? null,
  });

  pending.sort();
  unplaced.sort((a, b) => a.gameId.localeCompare(b.gameId));

  return /** @type {import('./types.js').ResolveState} */ (
    deepFreeze({ ...state, games, pending, unplaced }, true)
  );
}

/**
 * The per-run scratch fields every stage reads, zeroed.
 *
 * **Refactor-first, forced by 8.6.** Two callers build a stage context by hand
 * — `resolve.js` for a real run and `probe.js` for the adversarial freeze
 * probe — and every stage reads both as though they were one shape. Nothing
 * detected the drift: adding `repairScope` to the first left the second
 * handing every stage a context without it, and the freeze probe (the check
 * incident 2 exists for) died on `context.repairScope.has(...)` rather than
 * reporting anything. That is the same defect as the two `computeFitness()`
 * implementations `objective.js` opens by describing, at a smaller scale.
 *
 * Only the fields **neither caller customises** live here. The ones they
 * genuinely differ on — `engines`, `plan`, `weights`, `touchedDates`,
 * `onUnsatisfiable`, `runVerification` — stay at the call sites, spread over
 * this, because a default for those would be a decision hidden in a helper.
 *
 * @returns {Record<string, unknown>}
 */
export function resolveContextDefaults() {
  return {
    /**
     * Per game, its published slot and the blocking **instances** it carried
     * there (`resolve/instances.js`); read only through `acceptedAtSlot()`.
     */
    baselineBlocking: {},
    /** The same one severity wider, for the objective's relative scoring. */
    baselineFindings: {},
    /** Games this run repairs rather than accepts; see the repair scope. */
    repairScope: new Set(),
    /** Per scoped game, how many baseline findings un-accepting it discarded. */
    repairScopeExercised: {},
    /** The cap the placer spends, or null for no cap. */
    changeBudget: null,
    /** Per requested game, the slot its drift is measured from. */
    anchors: {},
    /** Per requested game, the slot the request named, as a key. */
    requestedSlots: {},
    /** Frozen-game contradictions reported rather than thrown. */
    unsatisfiableErrors: [],
    /** One entry per stage, for the freeze audit. */
    stageSnapshots: [],
  };
}

/**
 * Freeze a set of games that were thawed, part-way through a run.
 *
 * The one state transition that is not a placement write, and it can only ever
 * make the run **more** frozen: an attempt to thaw something through this door
 * throws. It exists for `holdChanges`, where a change request states a fact
 * ("the other league published 12:30") rather than a preference, and the games
 * it named must not drift afterwards.
 *
 * It is called by the driver, never by a stage. A stage that could re-judge the
 * freeze mid-pipeline would be a stage that could argue with it.
 *
 * ## Where a pinned game is held *from*
 *
 * A game pinned here has, by definition, already moved: `holdChanges` pins the
 * games the change request just relocated. The position it is held at is
 * therefore the one it is standing on **now**, not the one it started the run
 * on, and `pinnedAt` records it so `freeze-audit` can say "this game did not
 * move after it was pinned" instead of "this game is not where the baseline put
 * it" — which is true of every pinned game, on every ordinary `holdChanges`
 * run, and is not a failure.
 *
 * The first pin wins: a game pinned twice cannot have moved in between, because
 * it was frozen for the whole interval.
 *
 * @param {import('./types.js').ResolveState} state
 * @param {ReadonlyArray<string>} gameIds
 * @param {string} reason
 * @returns {import('./types.js').ResolveState}
 */
export function pinGames(state, gameIds, reason) {
  if (gameIds.length === 0) return state;
  const dispositions = { ...state.dispositions };
  /** @type {Record<string, string>} */
  const pinnedAt = { ...(state.pinnedAt ?? {}) };
  for (const gameId of gameIds) {
    if (dispositions[gameId] === undefined) {
      throw new Error(`resolve: cannot pin game "${gameId}", which this run does not hold`);
    }
    dispositions[gameId] = FREEZE_DISPOSITION.FROZEN;
    if (pinnedAt[gameId] === undefined) pinnedAt[gameId] = slotKey(slotOf(state, gameId));
  }
  state.ledger.findings.push(
    makeResolveFinding(
      RESOLVE_REASON.RESOLVE_CHANGE_PINNED,
      `${gameIds.length} game(s) were pinned mid-run: ${reason}`,
      { gameCount: gameIds.length, exampleGameIds: [...gameIds].slice(0, 5).sort(), reason }
    )
  );
  return /** @type {import('./types.js').ResolveState} */ (
    deepFreeze({ ...state, dispositions, pinnedAt }, true)
  );
}

/**
 * **The one place a slot's changed fields are computed.**
 *
 * Which of a game's three coordinates moved — or that it has no slot at all —
 * is one question with one answer, and the repository keeps exactly one
 * implementation of it. {@link diffAgainstBaseline} asks it of a re-solve;
 * `scenario/diff.js` `diffSchedules()` asks it of two branches. Two copies would
 * be free to disagree about whether a shelved game counts as a date change,
 * which is precisely the kind of drift `docs/ARCHITECTURE.md` §6.10 records for
 * the two fitness functions this repository already carries.
 *
 * `'placed'` rather than a per-field list when the game has no slot: a game that
 * is nowhere has not moved to a different date, it has stopped having one.
 *
 * @param {import('./types.js').Slot} before
 * @param {import('./types.js').Slot|null} after
 * @returns {string[]}
 */
export function slotChangedFields(before, after) {
  if (after === null) return ['placed'];
  /** @type {string[]} */
  const changedFields = [];
  if (before.date !== after.date) changedFields.push('date');
  if (before.surfaceId !== after.surfaceId) changedFields.push('surfaceId');
  if (before.startMinutes !== after.startMinutes) changedFields.push('startMinutes');
  return changedFields;
}

/**
 * **The baseline partition**: what moved, what held, and what has no time at
 * all — by game, never as a bare count.
 *
 * Enumerated from the **baseline**, not from the ledger and not from the final
 * schedule: a game a stage dropped, or one a stage wrote around the gate, must
 * appear here rather than vanish with the data that would have named it.
 * Incident 1 was a count that said 366 long after the damage, and recovery was
 * game by game.
 *
 * ## Why the hold comes out of this function and not a new one
 *
 * `publication/index.js` states that this "remains the only game-by-game
 * baseline diff, over a resolve run rather than over two published artifacts",
 * so it is already the named authority for the question. The hold is the exact
 * complement of the diff, and computing it anywhere else would be a second
 * count free to disagree with this one about a shelved game — which is the
 * drift `docs/ARCHITECTURE.md` §6.10 records for the two fitness functions this
 * repository already carries, arriving a third time. `moved` and `held` are
 * therefore read out of one walk of one roster.
 *
 * Three producers of "did it keep its published time" already existed when 8.6
 * was written — `placement/replaceGames.js`'s `unchanged` list,
 * `publication/parity.js`'s `rowsMatched`, and `scenario/diff.js`'s
 * `gamesUnchanged` — and none of them is reachable from a resolve run. This is
 * the fourth question and deliberately not the fourth producer: it answers it
 * where the run already partitions its own roster.
 *
 * ## The partition, and what it must add up to
 *
 * Every baseline game lands in exactly one of three buckets:
 *
 * | bucket | meaning |
 * |---|---|
 * | `held` | standing on the date, ground and kickoff the baseline gave it |
 * | `moved` | standing somewhere, but not there |
 * | `unplaced` | standing nowhere: incident 10's TIME TBD |
 *
 * and `held.length + moved.length + unplaced.length === gameIds.length`.
 * Counted from both sides rather than asserted from how the lists were built,
 * which is the discipline `publication/parity.js` applies to its four buckets.
 * {@link baselinePartitionFindings} is what turns a partition that does not add
 * up into a blocking finding; it is separate and takes its counts as arguments
 * so a caller cannot get the check without the numbers it checked.
 *
 * **`moved` keeps carrying the unplaced.** A game with no time has changed as
 * far as the change budget, the dry-run report and a family are concerned, and
 * every existing reader of this function counts it that way. `unplaced` is a
 * view of the same games under `changedFields: ['placed']`, not a fourth
 * bucket subtracted from `moved`; the identity that has to hold is stated over
 * `held` and `moved` alone.
 *
 * @param {import('./types.js').ResolveState} state
 * @returns {import('./types.js').BaselinePartition}
 */
export function diffAgainstBaseline(state) {
  /** @type {import('./types.js').ScheduleChange[]} */
  const changed = [];
  /** @type {import('./types.js').BaselineHold[]} */
  const held = [];
  /** @type {import('./types.js').ScheduleChange[]} */
  const unplaced = [];
  // Counted separately from `held.length` on purpose: the kickoff is what a
  // family was told and the ground is a second question, so a game that keeps
  // its time on another pitch is a hold of the kickoff and not of the slot.
  let kickoffHeld = 0;

  for (const gameId of state.gameIds) {
    const before = state.baseline[gameId];
    const after = state.games[gameId] ?? null;
    const beforeSlot = {
      date: before.date,
      surfaceId: before.surfaceId,
      startMinutes: before.startMinutes,
    };
    const afterSlot =
      after === null
        ? null
        : { date: after.date, surfaceId: after.surfaceId, startMinutes: after.startMinutes };

    const changedFields = slotChangedFields(beforeSlot, afterSlot);
    if (
      afterSlot !== null &&
      afterSlot.date === beforeSlot.date &&
      afterSlot.startMinutes === beforeSlot.startMinutes
    ) {
      kickoffHeld += 1;
    }

    if (changedFields.length === 0) {
      held.push({
        gameId,
        label: `${before.homeLabel} v ${before.awayLabel}`,
        disposition: state.dispositions[gameId],
        slot: beforeSlot,
      });
      continue;
    }

    const entry = {
      gameId,
      label: `${before.homeLabel} v ${before.awayLabel}`,
      disposition: state.dispositions[gameId],
      changedFields,
      before: beforeSlot,
      after: afterSlot,
    };
    changed.push(entry);
    if (afterSlot === null) unplaced.push(entry);
  }

  changed.sort((a, b) => a.gameId.localeCompare(b.gameId));
  held.sort((a, b) => a.gameId.localeCompare(b.gameId));
  unplaced.sort((a, b) => a.gameId.localeCompare(b.gameId));

  return {
    moved: changed,
    held,
    unplaced,
    counts: {
      baselineGames: state.gameIds.length,
      held: held.length,
      moved: changed.length,
      unplaced: unplaced.length,
      publishedKickoffHeld: kickoffHeld,
      publishedSlotHeld: held.length,
    },
  };
}

/**
 * The partition's own meta-assertions, as findings.
 *
 * **Given its counts as arguments** rather than closing over the partition, for
 * the same reason `publication/parity.js`'s `parityPartitionFindings()` is: a
 * check that derives the universe it is checking against from the same walk
 * that produced the buckets compares a set against itself. `baselineGames` is
 * the roster length, which a break in the walk leaves intact.
 *
 * @param {import('./types.js').BaselinePartition} partition
 * @param {{ baselineGames: number }} counts
 * @returns {import('../freeze/types.js').FreezeFinding[]}
 */
export function baselinePartitionFindings(partition, counts) {
  /** @type {import('../freeze/types.js').FreezeFinding[]} */
  const findings = [];
  const held = partition.held.length;
  const moved = partition.moved.length;
  const accounted = held + moved;

  if (accounted !== counts.baselineGames) {
    findings.push(
      makeResolveFinding(
        RESOLVE_REASON.RESOLVE_PUBLISHED_HOLD_PARTITION_INCOMPLETE,
        `the baseline partition accounts for ${accounted} of ${counts.baselineGames} baseline game(s): ${held} held and ${moved} moved. A game in two buckets or in none makes the hold a number nobody should read`,
        { baselineGames: counts.baselineGames, accounted, held, moved }
      )
    );
  }

  // A game named in both buckets adds up perfectly while being wrong twice, so
  // the overlap is counted rather than inferred from the total above.
  const heldIds = new Set(partition.held.map((entry) => entry.gameId));
  const inBoth = partition.moved.filter((entry) => heldIds.has(entry.gameId));
  if (inBoth.length > 0) {
    findings.push(
      makeResolveFinding(
        RESOLVE_REASON.RESOLVE_PUBLISHED_HOLD_PARTITION_INCOMPLETE,
        `${inBoth.length} game(s) are counted as both held and moved: ${inBoth
          .slice(0, 5)
          .map((entry) => entry.gameId)
          .join(', ')}`,
        { baselineGames: counts.baselineGames, inBoth: inBoth.length }
      )
    );
  }

  if (counts.baselineGames === 0) {
    findings.push(
      makeResolveFinding(
        RESOLVE_REASON.RESOLVE_PUBLISHED_HOLD_PARTITION_INCOMPLETE,
        'the hold was measured over zero baseline games; "every published kickoff was held" is a true statement about an empty schedule and means nothing (incident 4)',
        { baselineGames: 0, accounted, held, moved }
      )
    );
  }

  return findings;
}
