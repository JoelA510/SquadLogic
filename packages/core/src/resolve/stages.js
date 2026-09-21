/**
 * The eight stages of a change-request re-solve, and the contract each of them
 * has to sign before it can be registered.
 *
 * > *"Freeze must be honoured by EVERY stage of the pipeline. In the source
 * > project the initial assignment respected the freeze but the local-search
 * > and repair passes did not, and quietly swapped four frozen games."*
 *
 * That is incident 2, and it is a failure of *architecture*, not of care. A
 * guarantee that every stage has to remember is a guarantee that holds until
 * somebody adds a ninth stage. Three things replace remembering:
 *
 * 1. Every stage carries a **required, non-empty `freezeContract`** —
 *    `mutationKinds`, `probe`, `claim` — and `ResolveStageSchema` refuses one
 *    that is under-specified, the way `RuleExerciseSchema` refuses a rule with
 *    no exercise expectation. A stage cannot exist in a state where its own
 *    probe would pass without testing anything.
 * 2. Every write goes through `applyMove()` in `state.js`, which judges the
 *    freeze itself. A stage that forgets to ask gets a thrown
 *    `FrozenGameMoveAttempt` naming it.
 * 3. `freeze-audit` runs **as a stage of the pipeline, not as a test**, and
 *    compares the final schedule against the position each frozen game was
 *    **held at** rather than against the move ledger — because a stage that
 *    wrote around the gate is exactly the stage that is not in the ledger.
 *
 * ## What the pipeline is, and what it is not
 *
 * It re-places existing games onto slots the baseline schedule already used. It
 * has no round-robin generator and no slot generator; see `index.js` for the
 * full statement. `local-search` and `pair-repair` are real passes with real
 * neighbourhoods — a stage that did nothing would sail through its own probe —
 * and the hold rule still decides **whether** a game is touched at all: a legal
 * game is never moved.
 *
 * ## Where the objective enters (Prompt 4.2)
 *
 * The hold rule decides whether; the objective decides **where**. Every stage
 * that places a game goes through {@link chooseSlot}, which walks the ordering
 * `candidateSlotsFor()` derives from the objective's change terms and scores each
 * legal candidate through `resolve/objective.js`. There is still no second
 * scoring function here: this file counts nothing and weighs nothing, it asks.
 *
 * @module resolve/stages
 */

import { FREEZE_DISPOSITION } from '../freeze/reasonCodes.js';

import { frozenGameUnsatisfiable, registryConstraintIdsFor } from './errors.js';
import { candidateSlotsFor } from './inventory.js';
import { checkPlacement } from './legality.js';
import {
  candidateObjectiveCounts,
  changeCountsFor,
  placementFindingCounts,
  placementFindingTotal,
  scoreObjective,
} from './objective.js';
import { RESOLVE_REASON, makeResolveFinding } from './reasonCodes.js';
import { ResolveStageSchema, STAGE_PROBE } from './schemas.js';
import {
  MOVE_KIND,
  applyMove,
  diffAgainstBaseline,
  isFrozen,
  mayMove,
  slotKey,
  slotOf,
} from './state.js';

/**
 * Why a game had to move, in the words of the machinery that decided it.
 *
 * > *"Each consequential move must name the specific constraint instance that
 * > forced it."*
 *
 * Every field here is **consumed**: the reason codes and the counterpart games
 * come from `checkPlacement()`, which is Phase 1.3's `checkKickoffAvailability()`
 * re-severitied by the Phase 2.1 registry; the binding kind and its slack in
 * minutes come from Phase 1.3's own tightness ordering; and the constraint ids
 * come from the registry's `idsByReasonCode` through the same lookup
 * `errors.js` uses for `FrozenGameUnsatisfiable`. Nothing in this function
 * decides anything, which is what stops the report drifting away from the
 * pipeline that produced it.
 *
 * A cause is a **flat record of primitives and ids**, like every `details` bag
 * in the six modules before it.
 *
 * @param {Object} context
 * @param {ReturnType<typeof checkPlacement>} placement
 * @param {ReadonlyArray<string>} codes - the codes that grew against the baseline
 * @param {ReadonlyArray<string>} counterpartGameIds
 * @returns {Record<string, unknown>}
 */
function constraintCause(context, placement, codes, counterpartGameIds) {
  const constraintIds = registryConstraintIdsFor(context.engines.registry, codes);
  const availability = /** @type {Object} */ (placement.availability ?? {});
  const binding = availability.binding ?? null;
  return Object.freeze({
    kind: 'constraint',
    codes: [...codes].sort().join(', '),
    constraintId: constraintIds[0] ?? null,
    constraintIds: Object.freeze([...constraintIds]),
    counterpartGameIds: Object.freeze([...counterpartGameIds].sort()),
    bindingKinds: Object.freeze([...(availability.bindingKinds ?? [])]),
    slackMinutes: binding === null ? null : (binding.slackMinutes ?? null),
  });
}

/**
 * What this run **accepts** at a game's baseline slot, as blocking code counts.
 *
 * Two questions wear the same numbers and they are not the same question:
 *
 * | question | asked by | reads |
 * |---|---|---|
 * | *is this clash new?* | `dislodge` | `context.baselineBlockingCodes` — what the schedule arrived carrying, always |
 * | *is this game's position one we answer for?* | `local-search`, `pair-repair`, the placer | this, which is empty for a game in the repair scope |
 *
 * Keeping `dislodge` on the as-found record is what stops a repair scope
 * costing a family their time for nothing. Emptying the accepted record makes
 * `local-search` see the breach; emptying the *as-found* record as well would
 * make `dislodge` see it too, and `dislodge` lifts a game off the board before
 * anything has established there is somewhere else to put it. Measured on the
 * corpus while 8.6 was built: with a venue's permit withdrawn and its games
 * scoped, that reading takes all 21 of them off the board and shelves every
 * one as TIME TBD — 21 published kickoffs destroyed to repair nothing, because
 * the venue is shut and there was never anywhere for them to go. The breach
 * they stand in was not created by this run, so it is not `dislodge`'s to
 * answer.
 *
 * @param {Object} context
 * @param {string} gameId
 * @returns {Record<string, number>}
 */
function acceptedBlockingCodesFor(context, gameId) {
  if (context.repairScope.has(gameId)) return {};
  return context.baselineBlockingCodes[gameId] ?? {};
}

/**
 * The same, one severity wider, for the objective's relative quality scoring.
 *
 * Moves with {@link acceptedBlockingCodesFor} and never separately: the gate
 * that admits a candidate compares blocking counts and the objective discounts
 * blocking **and** compromise, so a game whose gate stopped accepting its own
 * slot while the objective still scored it as free would be refused everywhere
 * and content where it was.
 *
 * @param {Object} context
 * @param {string} gameId
 * @returns {Record<string, number>}
 */
function acceptedFindingCountsFor(context, gameId) {
  if (context.repairScope.has(gameId)) return {};
  return context.baselineFindingCounts[gameId] ?? {};
}

/**
 * Grew, in the sense that matters: this game breaks a blocking code **more
 * often** than the baseline did.
 *
 * A change request is not asked to repair the schedule it was handed. The
 * corpus's four `Scrimmage` rows are blocking-illegal in the published season
 * (GAP-14: no `game_formats.csv` row, so size and occupancy cannot be checked),
 * and a resolver that treated them as its problem would dislodge four games
 * nobody asked about on every single run.
 *
 * **Counts, not presence.** Comparing the two de-duplicated code *sets* answers
 * "does it break something new" and misses "does it break the same thing
 * twice": a game already overlapping one neighbour can be relocated into a slot
 * where it overlaps two, and the set is identical in both places. `verify`
 * already compares the rule engine's violations per code by count, and this is
 * that contract, adopted rather than reinvented — the shape `CLAUDE.md` §3 asks
 * for when a sibling already handles the case.
 *
 * @param {Readonly<Record<string, number>>} now - `checkPlacement().blockingCodeCounts`
 * @param {Readonly<Record<string, number>>} baseline - the same, for the baseline slot
 * @returns {string[]}
 */
function newBlockingCodes(now, baseline) {
  /** @type {string[]} */
  const grown = [];
  for (const [code, count] of Object.entries(now)) {
    if (count > (baseline[code] ?? 0)) grown.push(code);
  }
  return grown.sort();
}

/**
 * Games on the dates this run touches, in a deterministic order.
 *
 * @param {import('./types.js').ResolveState} state
 * @param {ReadonlyArray<string>} dates
 * @returns {string[]}
 */
function placedGamesOn(state, dates) {
  const wanted = new Set(dates);
  return state.gameIds
    .filter((gameId) => state.games[gameId] && wanted.has(state.games[gameId].date))
    .sort((a, b) => {
      const left = state.games[a];
      const right = state.games[b];
      return (
        left.date.localeCompare(right.date) ||
        left.startMinutes - right.startMinutes ||
        a.localeCompare(b)
      );
    });
}

/**
 * Which game a stage should blame for a clash: the one most recently written,
 * falling back to the one being examined.
 *
 * "The thing that changed is the thing that broke it" is both the honest
 * attribution and the useful one — an operator wants to be told that the
 * fixture they just moved does not fit, not that four published 9v9 games have
 * become illegal.
 *
 * @param {import('./types.js').ResolveState} state
 * @param {ReadonlyArray<string>} candidates
 * @param {string} fallback
 * @returns {string}
 */
function culpritOf(state, candidates, fallback) {
  let best = fallback;
  let bestSeq = -1;
  for (const move of state.ledger.moves) {
    if (!candidates.includes(move.gameId)) continue;
    if (move.seq <= bestSeq) continue;
    bestSeq = move.seq;
    best = move.gameId;
  }
  return best;
}

/**
 * The rule-engine run used to enrich an unsatisfiable error and to verify the
 * result. Computed at most once per distinct state; the driver owns the cache.
 *
 * @param {Object} context
 * @param {import('./types.js').ResolveState} state
 * @returns {Object|null}
 */
function verificationFor(context, state) {
  return context.runVerification ? context.runVerification(state) : null;
}

/**
 * Raise (or report) an unsatisfiable frozen game.
 *
 * @param {import('./types.js').ResolveState} state
 * @param {Object} context
 * @param {string} gameId
 * @param {ReturnType<typeof checkPlacement>} placement
 * @param {string} stageId
 * @param {import('./types.js').Slot} slot - the slot it could not stand on
 * @returns {void}
 */
function unsatisfiable(state, context, gameId, placement, stageId, slot) {
  const judgement = context.judgements.byGameId[gameId];
  const error = frozenGameUnsatisfiable({
    state,
    gameId,
    slot,
    placement,
    registry: context.engines.registry,
    verification: verificationFor(context, state),
    ruleId: judgement?.decidedByRuleId ?? null,
    stageId,
  });
  if (context.onUnsatisfiable === 'throw') throw error;

  state.ledger.findings.push(
    makeResolveFinding(RESOLVE_REASON.RESOLVE_FROZEN_GAME_UNSATISFIABLE, error.message, {
      gameId,
      stageId,
      constraintId: error.constraintId,
      constraintIds: error.constraintIds,
      bindingKinds: error.bindingKinds,
      slackMinutes: error.binding?.slackMinutes ?? null,
      blockingCodes: error.blockingCodes,
      constraintsConsulted: error.meta.constraintsConsulted,
      rulesRun: error.meta.rulesRun,
      rulesExercised: error.meta.rulesExercised,
    })
  );
  context.unsatisfiableErrors.push(error);
}

/**
 * Where a game is held from, for the objective to measure its drift against:
 * the slot a change request named for it, or the one the reference schedule
 * gave it.
 *
 * **Never the slot it happens to be standing on right now.** `context.anchors`
 * is populated only for games a change request names, so a game already
 * displaced by an earlier stage has no entry here and must fall back to
 * `state.baseline` — the position it was *published* at. Anchoring such a game
 * on its displaced slot measures its drift from the damage rather than from the
 * schedule families were given, and makes walking it back to a free published
 * slot score **worse** than moving it further away. That is incident 1's shape
 * appearing inside the code written to prevent it, so all three placing stages
 * come through this one function rather than each carrying its own fallback —
 * the "adopt the sibling's contract" rule in `CLAUDE.md` §3.
 *
 * @param {import('./types.js').ResolveState} state
 * @param {Object} context
 * @param {string} gameId
 * @returns {import('./types.js').Slot}
 */
function anchorOf(state, context, gameId) {
  const baseline = state.baseline[gameId];
  return (
    context.anchors[gameId] ?? {
      date: baseline.date,
      surfaceId: baseline.surfaceId,
      startMinutes: baseline.startMinutes,
    }
  );
}

/**
 * **The change budget as a bound on the neighbourhood, not a verdict on the
 * result.**
 *
 * Until 8.6 the budget was a number the solver was never told. `resolve.js`
 * handed `changeBudget` straight to `buildChangeReport()`; `report.js:421`
 * compared `moved.length` against it once the run was over and `commit.js`
 * threw. A re-solve that would move forty games moved forty, built the whole
 * report, and was refused. Nothing was bounded — the answer was merely
 * rejected after it had been paid for.
 *
 * This is asked **before every relocation**, so the budget decides how far the
 * repair may spread instead of whether the finished spread was acceptable.
 *
 * ## What is counted
 *
 * Distinct **games standing somewhere other than their baseline slot**, read
 * out of {@link diffAgainstBaseline} — the one function that partitions the
 * baseline roster, so the number the gate spends is the same number the report
 * publishes and the same number `commit.js` measures. A count of *moves* would
 * charge twice for a game moved and moved again, and a family whose game
 * changed twice has one new kickoff.
 *
 * Three consequences follow from counting the state rather than the ledger,
 * and all three are wanted:
 *
 * - **Sending a game home is free.** A relocation onto the baseline slot does
 *   not grow the set, so a budget can never stop `local-search` walking a
 *   displaced game back to where it was published.
 * - **Moving an already-moved game again is free.** It is already counted, and
 *   a family whose game changed twice has one new kickoff.
 * - **A dislodged game is charged while it is off the board**, because a game
 *   with no time is away from its baseline slot by any reading and
 *   `diffAgainstBaseline()` counts it as moved. Placing it again therefore
 *   costs nothing it has not already paid, and placing it *home* refunds it.
 *
 * ## What this does not bound, and why the backstop stays
 *
 * This gate sits in front of the three **placing** stages. It is deliberately
 * not in front of `change-request-apply` or `dislodge`, and neither omission
 * is an oversight:
 *
 * - A **requested** move is the operator's instruction, not the solver's
 *   choice. Refusing part of a change request under a cap would be answering a
 *   different question from the one asked.
 * - A **dislodge** is forced: the game's slot has just been made illegal by a
 *   move that already happened, and the alternative to lifting it is leaving
 *   two games on one pitch.
 *
 * So a request whose own moves plus the dislodges they force already exceed
 * the cap cannot be bounded by anything here, and falls through to
 * `report.js`'s `withinBudget` and `commit.js`'s `ChangeBudgetExceeded` exactly
 * as before. Measured on a constructed corpus scenario whose unbounded run
 * moves 4 games: a budget of 3 returns 3 and a budget of 2 returns 2, both
 * within cap and partially repaired; a budget of 1 returns the irreducible 2
 * and is refused. The bound shrinks the neighbourhood; it does not pretend to
 * shrink the instruction.
 *
 * @param {import('./types.js').ResolveState} state
 * @param {Object} context
 * @param {string} gameId
 * @param {import('./types.js').Slot} to
 * @returns {boolean} false when this relocation would spend budget the run does not have
 */
function withinChangeBudget(state, context, gameId, to) {
  const budget = context.changeBudget;
  if (budget === null) return true;

  const baseline = state.baseline[gameId];
  const staysHome =
    baseline.date === to.date &&
    baseline.surfaceId === to.surfaceId &&
    baseline.startMinutes === to.startMinutes;
  if (staysHome) return true;

  const moved = diffAgainstBaseline(state).moved;
  if (moved.some((entry) => entry.gameId === gameId)) return true;
  return moved.length + 1 <= budget;
}

/**
 * Refuse a move the budget cannot pay for, and say so.
 *
 * Separate from {@link withinChangeBudget} because a refusal that is not
 * counted and not named is a silent drop, and the three placing stages each
 * need the same sentence. `RESOLVE_CHANGE_BUDGET_BOUND` is `compromise`
 * deliberately: it is what stops the run's status coming back clean when the
 * repair stopped early, which `RESOLVE_CHANGE_BUDGET_MET` at `info` would not.
 *
 * @param {import('./types.js').ResolveState} state
 * @param {Object} context
 * @param {string} gameId
 * @param {import('./types.js').Slot} to
 * @param {string} stageId
 * @returns {boolean} true when the move may proceed
 */
function mayMoveWithinBudget(state, context, gameId, to, stageId) {
  if (withinChangeBudget(state, context, gameId, to)) return true;
  state.ledger.meta.movesRefusedByBudget += 1;
  state.ledger.findings.push(
    makeResolveFinding(
      RESOLVE_REASON.RESOLVE_CHANGE_BUDGET_BOUND,
      `stage "${stageId}" would have moved game "${gameId}" to ${slotKey(to)}, and the change budget of ${context.changeBudget} is already spent. The repair stopped here rather than moving it and being refused afterwards; the game is reported unrepaired`,
      { gameId, stageId, slot: slotKey(to), budget: context.changeBudget }
    )
  );
  return false;
}

/**
 * **The one place a slot is chosen**, and the only consumer of the objective's
 * quality half.
 *
 * All three placing stages come through here — `initial-assignment` for a game
 * that was lifted out, `local-search` for one standing somewhere illegal,
 * `pair-repair` for the movable half of a clash — so "the objective decides
 * where a game goes" is a statement about the pipeline rather than about one
 * stage that happens to consult it.
 *
 * ## Two exact short-circuits, and why they are not heuristics
 *
 * `candidateSlotsFor()` returns candidates ordered by **change cost ascending**,
 * and every quality term is non-negative. So:
 *
 * 1. once a candidate's change cost alone reaches the best total found so far,
 *    no later candidate can beat it — the ordering guarantees the change cost
 *    never falls again; and
 * 2. a candidate scoring zero cannot be beaten at all.
 *
 * Both stop the scan without changing the answer, and both still hold with the
 * quality half charged relative to the baseline: an excess clamped at zero is
 * still non-negative. The second one now fires where it should — a game offered
 * the slot it was published on, carrying only what that slot already carried,
 * scores zero and the scan stops there.
 *
 * Under the default weights the
 * first is what makes this cost roughly what "first legal slot" cost before,
 * because a candidate that differs from the anchor already pays `changedGame`
 * and no ordinary quality shortfall reaches that. Under a run with the change
 * terms switched off neither fires until a clean slot is found, which is
 * precisely the exhaustive search that run is asking for.
 *
 * The first stops at `changeCost > best.score` rather than `>=`, which is the
 * same exactness one candidate wider: a candidate whose change cost *equals* the
 * best total can only tie it, never beat it, and a tie is decided below by
 * whichever slot carries fewer findings outright. Declining to repair what the
 * schedule was handed is the point of the relative scoring; spreading it to a
 * slot that never had it is not, and the two slots score the same once the
 * accepted half is discounted.
 *
 * @param {import('./types.js').ResolveState} state
 * @param {Object} context
 * @param {string} gameId
 * @param {{ anchor: import('./types.js').Slot, excludeSlotKey?: string }} options
 * @returns {{ slot: import('./types.js').Slot, placement: ReturnType<typeof checkPlacement>, score: number, findingsCarried: number }|null}
 */
function chooseSlot(state, context, gameId, options) {
  const { anchor } = options;
  /** @type {{ slot: import('./types.js').Slot, placement: ReturnType<typeof checkPlacement>, score: number, findingsCarried: number }|null} */
  let best = null;

  for (const candidate of candidateSlotsFor(state, gameId, anchor, context.weights)) {
    if (options.excludeSlotKey !== undefined && slotKey(candidate) === options.excludeSlotKey) {
      continue;
    }
    const changeCost = scoreObjective(
      changeCountsFor(anchor, candidate),
      context.weights
    ).changeCost;
    if (best !== null && changeCost > best.score) break;

    state.ledger.meta.candidatesEvaluated += 1;
    const placement = checkPlacement(context.engines, state, gameId, candidate);
    const grown = newBlockingCodes(
      placement.blockingCodeCounts,
      acceptedBlockingCodesFor(context, gameId)
    );
    if (grown.length > 0) {
      state.ledger.meta.candidatesRejected += 1;
      continue;
    }

    const score = scoreObjective(
      candidateObjectiveCounts({
        reference: anchor,
        slot: candidate,
        placement,
        // **Scored the way the gate above admits.** `newBlockingCodes()` accepts
        // a finding the published schedule already carried; scoring the same
        // candidate absolutely would then charge this game for that finding at
        // its own published slot and move it off its published time to repair
        // something already accepted.
        accepted: acceptedFindingCountsFor(context, gameId),
      }),
      context.weights
    ).total;
    const findingsCarried = placementFindingTotal(placement);
    state.ledger.meta.candidatesScored += 1;
    if (
      best === null ||
      score < best.score ||
      (score === best.score && findingsCarried < best.findingsCarried)
    ) {
      best = { slot: candidate, placement, score, findingsCarried };
    }
    if (best.score === 0 && best.findingsCarried === 0) break;
  }
  return best;
}

/**
 * Place one pending game on the slot the objective likes best.
 *
 * ## There is deliberately no change-budget gate here
 *
 * The other two placing stages ask {@link mayMoveWithinBudget} before they
 * move anything. This one does not, and the reason is that the question has no
 * answer rather than that it was forgotten.
 *
 * Every game this function is handed is **pending**, and `applyMove()`
 * guarantees pending implies absent from `state.games`. A game with no slot is
 * away from its baseline position by any reading, so
 * {@link diffAgainstBaseline} already counts it among `moved`. Placing it
 * therefore costs the budget nothing it has not already paid, and placing it
 * *home* refunds it. Refusing the placement would not save a unit of budget;
 * it would turn a game with a new time into a game with no time, at identical
 * cost, which is strictly worse for the family and no help to the cap.
 *
 * A gate was written here first and then removed: it could not fire, because
 * {@link withinChangeBudget}'s already-counted early exit caught every pending
 * game before the arithmetic. Measured: `reoptimiseWholeSeason()` over the
 * corpus with `dislodgeAll` lifting all 679 games and `changeBudget: 1`
 * refused **zero** moves through it. An unreachable branch reporting a refusal
 * an operator could act on ("raise the budget and this game gets a time") is
 * worse than no branch, so it is gone.
 *
 * @param {import('./types.js').ResolveState} state
 * @param {Object} context
 * @param {string} gameId
 * @param {string} stageId
 * @returns {{ state: import('./types.js').ResolveState, placed: boolean }}
 */
function placePending(state, context, gameId, stageId) {
  const anchor = anchorOf(state, context, gameId);
  const chosen = chooseSlot(state, context, gameId, { anchor });

  if (chosen !== null) {
    const candidate = chosen.slot;
    if (!mayMove(state, gameId, stageId, `place on ${slotKey(candidate)}`)) {
      return { state, placed: false };
    }
    const next = applyMove(
      state,
      {
        gameId,
        kind: MOVE_KIND.RELOCATE,
        to: candidate,
        // No `cause`: a game reaching this stage was lifted out by some earlier
        // move, and **that** move carries the reason it had to move at all.
        // Restating it here would be a second copy free to disagree with the
        // first, and `report.js` reads the first cause in the game's own slice
        // of the ledger precisely so there is only ever one.
        reason: `the slot the objective scored lowest (${chosen.score}) among those the schedule already used`,
      },
      stageId
    );
    next.ledger.findings.push(
      makeResolveFinding(
        RESOLVE_REASON.RESOLVE_GAME_REPLACED,
        `game "${gameId}" was placed on ${slotKey(candidate)} after ${state.ledger.meta.candidatesEvaluated} candidate(s) were evaluated in this run`,
        { gameId, stageId, slot: slotKey(candidate), anchor: slotKey(anchor) }
      )
    );
    if (context.requestedSlots[gameId] && context.requestedSlots[gameId] !== slotKey(candidate)) {
      next.ledger.findings.push(
        makeResolveFinding(
          RESOLVE_REASON.RESOLVE_CHANGE_DISPLACED,
          `game "${gameId}" was requested at ${context.requestedSlots[gameId]} and could not stand there; it was placed at ${slotKey(candidate)}, the nearest slot the schedule already used`,
          {
            gameId,
            stageId,
            requestedSlot: context.requestedSlots[gameId],
            placedSlot: slotKey(candidate),
          }
        )
      );
    }
    return { state: next, placed: true };
  }
  return { state, placed: false };
}

/* -------------------------------------------------------------------------- */
/* The eight stages                                                            */
/* -------------------------------------------------------------------------- */

/** @type {Object} */
const baselineIngest = {
  id: 'baseline-ingest',
  title: 'Read the schedule in front of us and judge every game against the plan',
  freezeContract: {
    mutationKinds: [],
    probe: STAGE_PROBE.WRITES_NOTHING,
    claim:
      'reads the baseline and records what each game already carries; writes nothing, so no frozen game can move here',
  },
  /**
   * @param {import('./types.js').ResolveState} state
   * @param {Object} context
   */
  run(state, context) {
    const ledger = state.ledger;
    ledger.meta.gamesExamined += state.gameIds.length;
    ledger.meta.freezeJudgements += context.judgements.meta.gamesJudged;

    if (state.gameIds.length === 0) {
      ledger.findings.push(
        makeResolveFinding(
          RESOLVE_REASON.RESOLVE_RUN_VACUOUS,
          'the baseline schedule holds no games; every stage below would report success over nothing',
          { stageId: this.id }
        )
      );
      return state;
    }

    // What the schedule was *already* carrying, so the run is never blamed for
    // it and never tries to repair it.
    for (const gameId of state.gameIds) {
      // The **baseline** slot, deliberately, not the current one: this stage
      // records what the schedule arrived carrying, and it must give the same
      // answer whenever it is run.
      const game = state.baseline[gameId];
      const slot = { date: game.date, surfaceId: game.surfaceId, startMinutes: game.startMinutes };
      const placement = checkPlacement(context.engines, state, gameId, slot);
      const findingCounts = placementFindingCounts(placement);
      // **What the schedule arrived carrying, always and for every game** —
      // including the ones in the repair scope. This map answers "is this
      // clash new?", which is `dislodge`'s question, and the answer does not
      // change because a caller asked for a game to be re-homed. What the
      // repair scope changes is a different question, asked by `local-search`
      // and the placer: see {@link acceptedBlockingCodesFor}.
      context.baselineBlockingCodes[gameId] = placement.blockingCodeCounts;
      // The same record one severity wider: the gate compares blocking counts,
      // the objective charges for blocking **and** compromise, and both have to
      // be measured against the same published slot or the run pays twice for
      // an exception the season already accepted.
      context.baselineFindingCounts[gameId] = findingCounts;
      if (context.repairScope.has(gameId)) {
        // **Counted off `blockingCodeCounts`, not `findingCounts`.** The
        // vacuity check exists to catch a scope that cannot change anything,
        // so it has to measure what the stages that act on the scope actually
        // gate on — and `local-search` and `pair-repair` both gate on
        // `newBlockingCodes()`, which reads blocking counts alone. Counting
        // the wider record would let a scope over games carrying only
        // compromise findings report `exercised > 0`, suppress
        // `RESOLVE_REPAIR_SCOPE_VACUOUS`, and claim the run "has to answer
        // for" findings that every guard downstream holds. That is the exact
        // vacuity the code was added to catch, reported as its opposite.
        context.repairScopeExercised[gameId] = Object.values(placement.blockingCodeCounts).reduce(
          (total, count) => total + count,
          0
        );
      }
      ledger.meta.constraintsConsulted += /** @type {Array<Object>} */ (
        placement.availability.constraints
      ).length;
    }
    return state;
  },
};

/** @type {Object} */
const changeRequestApply = {
  id: 'change-request-apply',
  title: 'Apply what was actually asked for, and refuse what the plan holds',
  freezeContract: {
    mutationKinds: [MOVE_KIND.RELOCATE],
    probe: STAGE_PROBE.OFFERS_FROZEN_MOVE,
    claim:
      'a change naming a frozen game is refused with RESOLVE_CHANGE_REFUSED_FROZEN and the game stays where it is; the request is never honoured by moving something the operator froze',
  },
  /**
   * @param {import('./types.js').ResolveState} state
   * @param {Object} context
   */
  run(state, context) {
    let current = state;
    for (const change of context.changes) {
      const ledger = current.ledger;
      const game = current.games[change.gameId];
      if (!game) {
        ledger.findings.push(
          makeResolveFinding(
            RESOLVE_REASON.RESOLVE_CHANGE_UNKNOWN_GAME,
            `the change request names game "${change.gameId}", which this schedule does not hold`,
            { gameId: change.gameId, stageId: this.id }
          )
        );
        continue;
      }

      const target = {
        date: change.date ?? game.date,
        surfaceId: change.surfaceId ?? game.surfaceId,
        startMinutes: change.startMinutes,
      };
      const from = /** @type {import('./types.js').Slot} */ (slotOf(current, change.gameId));
      context.requestedSlots[change.gameId] = slotKey(target);
      context.anchors[change.gameId] = target;

      if (slotKey(target) === slotKey(from)) {
        ledger.findings.push(
          makeResolveFinding(
            RESOLVE_REASON.RESOLVE_CHANGE_NO_OP,
            `the change request asks for game "${change.gameId}" to stand where it already stands (${slotKey(target)}); nothing moves and the freeze is never consulted`,
            { gameId: change.gameId, stageId: this.id, slot: slotKey(target) }
          )
        );
        continue;
      }

      if (!mayMove(current, change.gameId, this.id, `apply the change to ${slotKey(target)}`)) {
        const judgement = context.judgements.byGameId[change.gameId];
        ledger.findings.push(
          makeResolveFinding(
            RESOLVE_REASON.RESOLVE_CHANGE_REFUSED_FROZEN,
            `the change request asks to move game "${change.gameId}" to ${slotKey(target)}, and the plan freezes it${judgement?.decidedByRuleId ? ` (rule "${judgement.decidedByRuleId}")` : ' by default'}; the request and the freeze contradict each other and the game has NOT been moved`,
            {
              gameId: change.gameId,
              stageId: this.id,
              requestedSlot: slotKey(target),
              currentSlot: slotKey(from),
              ruleId: judgement?.decidedByRuleId ?? null,
            }
          )
        );
        continue;
      }

      current = applyMove(
        current,
        {
          gameId: change.gameId,
          kind: MOVE_KIND.RELOCATE,
          to: target,
          reason: change.reason ?? 'named by the change request',
          cause: Object.freeze({
            kind: 'requested',
            requestedSlot: slotKey(target),
            reason: change.reason ?? 'named by the change request',
          }),
        },
        this.id
      );
      current.ledger.findings.push(
        makeResolveFinding(
          RESOLVE_REASON.RESOLVE_CHANGE_APPLIED,
          `game "${change.gameId}" moved from ${slotKey(from)} to ${slotKey(target)} as requested`,
          {
            gameId: change.gameId,
            stageId: this.id,
            fromSlot: slotKey(from),
            toSlot: slotKey(target),
          }
        )
      );
    }
    return current;
  },
};

/** @type {Object} */
const dislodge = {
  id: 'dislodge',
  title: 'Lift out what the change made illegal — and only what may be lifted',
  freezeContract: {
    mutationKinds: [MOVE_KIND.DISLODGE],
    probe: STAGE_PROBE.OFFERS_FROZEN_MOVE,
    claim:
      'every party to a clash is considered, frozen ones are refused and counted, and a clash in which nothing may move raises FrozenGameUnsatisfiable rather than picking a victim',
  },
  /**
   * @param {import('./types.js').ResolveState} state
   * @param {Object} context
   */
  run(state, context) {
    let current = state;

    if (context.dislodgeAll) {
      // The global re-optimisation branch, and the only one that behaves like
      // the solver in incident 1: everything that may move comes off the board
      // and is placed again from scratch. Reachable only through
      // `reoptimiseWholeSeason()`.
      for (const gameId of [...current.gameIds]) {
        if (!current.games[gameId]) continue;
        if (!mayMove(current, gameId, this.id, 'global re-optimisation')) continue;
        current = applyMove(
          current,
          {
            gameId,
            kind: MOVE_KIND.DISLODGE,
            to: null,
            reason: 'global re-optimisation: every thawed game is re-placed from scratch',
            // Named, and deliberately **not** a constraint: nothing about this
            // game forced it off the board. `report.js` reads this kind and
            // says so rather than leaving the move unexplained, because "no
            // constraint made this happen" is the truest and worst thing that
            // can be said about a game families already had a time for.
            cause: Object.freeze({ kind: 'global-reoptimisation' }),
          },
          this.id
        );
      }
      return current;
    }

    for (const gameId of placedGamesOn(current, context.touchedDates)) {
      if (!current.games[gameId]) continue;
      const slot = /** @type {import('./types.js').Slot} */ (slotOf(current, gameId));
      const placement = checkPlacement(context.engines, current, gameId, slot);
      // **`context.baselineBlockingCodes` directly, never
      // {@link acceptedBlockingCodesFor}.** This stage asks whether the clash
      // is one *this run* created, and the repair scope does not change that
      // answer: a game whose ground was withdrawn before the run started was
      // not put there by the run. Reading the scope-aware record here lifts
      // every scoped game off the board on the strength of a breach nothing
      // here can repair, and `initial-assignment` then shelves them all. See
      // that function's docblock for the 21 kickoffs it cost when measured.
      const grown = newBlockingCodes(
        placement.blockingCodeCounts,
        context.baselineBlockingCodes[gameId] ?? {}
      );
      if (grown.length === 0) continue;

      current.ledger.meta.conflictsExamined += 1;
      const parties = [gameId, ...placement.counterpartGameIds].filter(
        (id) => current.baseline[id] !== undefined && current.games[id] !== undefined
      );

      // **Ask everyone; move as few as possible.** The two halves are separate
      // on purpose. Asking every party is what puts "the 9v9 block would have
      // had to move, and it is frozen" in the report — incident 3's decision
      // stated rather than implied — and it is what gives this stage's probe
      // its rejection counter. Dislodging every party that *could* move would
      // then take published neighbours off the board that nobody needed to
      // touch, so the second loop stops the moment the clash is gone.
      const movable = parties.filter((party) =>
        mayMove(current, party, this.id, `clash on ${slotKey(slot)}: ${grown.join(', ')}`)
      );
      // The most recently written first: the thing that changed is the thing
      // that yields, which is both the honest attribution and the minimal diff.
      const ordered = [...movable].sort((a, b) => {
        const seq = (id) => {
          let best = -1;
          for (const move of current.ledger.moves) {
            if (move.gameId === id && move.seq > best) best = move.seq;
          }
          return best;
        };
        return seq(b) - seq(a) || a.localeCompare(b);
      });

      let movedSomething = false;
      for (const party of ordered) {
        if (!current.games[party]) continue;
        const others = parties.filter((id) => id !== party);
        current = applyMove(
          current,
          {
            gameId: party,
            kind: MOVE_KIND.DISLODGE,
            to: null,
            reason: `clash with ${others.join(', ') || 'nothing this run can name'}: ${grown.join(', ')}`,
            cause: constraintCause(context, placement, grown, others),
          },
          this.id
        );
        current.ledger.findings.push(
          makeResolveFinding(
            RESOLVE_REASON.RESOLVE_GAME_DISLODGED,
            `game "${party}" was lifted out of ${slotKey(/** @type {import('./types.js').Slot} */ (slot))} because the change made ${grown.join(', ')} apply there; ${parties.length - movable.length} of the ${parties.length} games in the clash are frozen`,
            {
              gameId: party,
              stageId: this.id,
              codes: grown.join(', '),
              partyCount: parties.length,
              frozenPartyCount: parties.length - movable.length,
            }
          )
        );
        movedSomething = true;
        // Lifting the game being examined ends the clash by definition;
        // otherwise re-ask, so no further neighbour is disturbed once it is.
        if (party === gameId) break;
        const after = checkPlacement(
          context.engines,
          current,
          gameId,
          /** @type {import('./types.js').Slot} */ (slotOf(current, gameId))
        );
        if (
          newBlockingCodes(after.blockingCodeCounts, context.baselineBlockingCodes[gameId] ?? {})
            .length === 0
        ) {
          break;
        }
      }

      if (movedSomething) continue;

      // Nothing in the clash may move. Somebody frozen is standing somewhere
      // illegal, and the run refuses to choose a victim.
      const culprit = culpritOf(current, parties, gameId);
      const culpritSlot = /** @type {import('./types.js').Slot} */ (slotOf(current, culprit));
      const culpritPlacement =
        culprit === gameId
          ? placement
          : checkPlacement(context.engines, current, culprit, culpritSlot);
      unsatisfiable(current, context, culprit, culpritPlacement, this.id, culpritSlot);
    }
    return current;
  },
};

/** @type {Object} */
const initialAssignment = {
  id: 'initial-assignment',
  title: 'Give every dislodged game a slot the schedule already used',
  freezeContract: {
    mutationKinds: [MOVE_KIND.RELOCATE, MOVE_KIND.TIME_TBD],
    probe: STAGE_PROBE.OFFERS_FROZEN_MOVE,
    claim:
      'places only games that were legitimately dislodged; a frozen game offered to it is refused, and a thawed game with no slot left becomes TIME TBD rather than disappearing',
  },
  /**
   * @param {import('./types.js').ResolveState} state
   * @param {Object} context
   */
  run(state, context) {
    let current = state;
    const order = [...current.pending].sort((a, b) => {
      const left = current.baseline[a];
      const right = current.baseline[b];
      return (
        left.date.localeCompare(right.date) ||
        left.startMinutes - right.startMinutes ||
        a.localeCompare(b)
      );
    });

    for (const gameId of order) {
      if (!current.pending.includes(gameId)) continue;
      const attempt = placePending(current, context, gameId, this.id);
      current = attempt.state;
      if (attempt.placed) continue;

      if (isFrozen(current, gameId)) {
        // Frozen games are never dislodged, so reaching here means something
        // upstream is wrong. Say so loudly rather than shelving it.
        const slot = /** @type {import('./types.js').Slot} */ ({
          date: current.baseline[gameId].date,
          surfaceId: current.baseline[gameId].surfaceId,
          startMinutes: current.baseline[gameId].startMinutes,
        });
        unsatisfiable(
          current,
          context,
          gameId,
          checkPlacement(context.engines, current, gameId, slot),
          this.id,
          slot
        );
        continue;
      }

      // **One sentence, because there is only one way to get here.** A
      // discriminator was added in 8.6 and removed in the same PR: the budget
      // arm could not fire (see `placePending`) and the frozen arm is caught
      // by the branch above, so the other two values were decoration on a
      // single reachable outcome. A vocabulary whose every other member is
      // unreachable reads as a promise the code does not keep.
      const reason =
        'no slot the schedule already used is legal for it; kept visible as TIME TBD rather than dropped (incident 10)';
      current = applyMove(
        current,
        {
          gameId,
          kind: MOVE_KIND.TIME_TBD,
          to: null,
          reason,
          // Deliberately not a cause of its own: a game reaching TIME TBD was
          // lifted out by an earlier move that already named what forced it,
          // and this one is the consequence rather than the reason.
        },
        this.id
      );
      current.ledger.findings.push(
        makeResolveFinding(
          RESOLVE_REASON.RESOLVE_GAME_TIME_TBD,
          `game "${gameId}" is carried as TIME TBD: ${reason}`,
          { gameId, stageId: this.id }
        )
      );
    }
    return current;
  },
};

/** @type {Object} */
const localSearch = {
  id: 'local-search',
  title: 'Relocate a game that is still standing somewhere illegal',
  freezeContract: {
    mutationKinds: [MOVE_KIND.RELOCATE],
    probe: STAGE_PROBE.OFFERS_FROZEN_MOVE,
    claim:
      'considers relocating each still-illegal game and asks the freeze before every one; a frozen game is counted as refused and left exactly where it is (incident 2)',
  },
  /**
   * @param {import('./types.js').ResolveState} state
   * @param {Object} context
   */
  run(state, context) {
    let current = state;
    for (const gameId of placedGamesOn(current, context.touchedDates)) {
      if (!current.games[gameId]) continue;
      const slot = /** @type {import('./types.js').Slot} */ (slotOf(current, gameId));
      const placement = checkPlacement(context.engines, current, gameId, slot);
      if (
        newBlockingCodes(placement.blockingCodeCounts, acceptedBlockingCodesFor(context, gameId))
          .length === 0
      ) {
        // The hold rule, in one branch: a legal game is never moved. The
        // objective decides *where* a game goes once something has forced it to
        // go somewhere; it is deliberately never asked whether a game that is
        // standing legally could score better elsewhere, because the answer to
        // that question, applied across a season, is incident 1.
        continue;
      }
      if (!mayMove(current, gameId, this.id, 'relocate a game standing somewhere illegal')) {
        continue;
      }

      // The **baseline**, not the slot it is standing on: this stage exists to
      // walk a displaced game back toward where it was published, and a game
      // that measured its drift from its displaced position would score the
      // walk back as a move away.
      const anchor = anchorOf(current, context, gameId);
      const chosen = chooseSlot(current, context, gameId, {
        anchor,
        excludeSlotKey: slotKey(slot),
      });
      if (chosen === null) {
        // **Never a silent `continue` for a game the run was asked to
        // repair.** For a game merely caught up in the run this is ordinary —
        // it stays where it is and the verify stage reports what it carries.
        // For one in the repair scope it is the answer to a question somebody
        // asked, and the answer is "I could not". `resolve/` may only offer
        // slots the baseline used **at the same venue on the same date**
        // (`inventory.js:candidateSlotsFor`), so a whole-venue withdrawal has
        // no in-reach answer by construction; saying nothing would read as
        // "repaired".
        if (context.repairScope.has(gameId)) {
          current.ledger.meta.repairsUnavailable += 1;
          current.ledger.findings.push(
            makeResolveFinding(
              RESOLVE_REASON.RESOLVE_REPAIR_UNAVAILABLE,
              `game "${gameId}" was in the repair scope and no slot the baseline used at its venue on ${slot.date} is legal for it; it is left standing at ${slotKey(slot)} rather than losing the time families already have. Re-homing it needs ground this package cannot offer — it re-places games within the inventory, it does not find new venues`,
              {
                gameId,
                stageId: this.id,
                slot: slotKey(slot),
                codes: newBlockingCodes(
                  placement.blockingCodeCounts,
                  acceptedBlockingCodesFor(context, gameId)
                ).join(', '),
              }
            )
          );
        }
        continue;
      }
      if (!mayMoveWithinBudget(current, context, gameId, chosen.slot, this.id)) continue;
      current = applyMove(
        current,
        {
          gameId,
          kind: MOVE_KIND.RELOCATE,
          to: chosen.slot,
          reason: 'local search: the game was standing somewhere illegal',
          cause: constraintCause(
            context,
            placement,
            newBlockingCodes(
              placement.blockingCodeCounts,
              acceptedBlockingCodesFor(context, gameId)
            ),
            placement.counterpartGameIds
          ),
        },
        this.id
      );
    }
    return current;
  },
};

/** @type {Object} */
const pairRepair = {
  id: 'pair-repair',
  title: 'Move the other party to a clash, when the other party may be moved',
  freezeContract: {
    mutationKinds: [MOVE_KIND.RELOCATE],
    probe: STAGE_PROBE.OFFERS_FROZEN_MOVE,
    claim:
      'considers moving the counterpart of every remaining clash and asks the freeze before every one; the four frozen games incident 2 swapped were swapped by exactly this pass',
  },
  /**
   * @param {import('./types.js').ResolveState} state
   * @param {Object} context
   */
  run(state, context) {
    let current = state;
    for (const gameId of placedGamesOn(current, context.touchedDates)) {
      if (!current.games[gameId]) continue;
      const slot = /** @type {import('./types.js').Slot} */ (slotOf(current, gameId));
      const placement = checkPlacement(context.engines, current, gameId, slot);
      // **`context.baselineBlockingCodes` directly, as `dislodge` does, and
      // deliberately not {@link acceptedBlockingCodesFor}.** This stage does
      // not move `gameId`; it moves somebody else off their published slot
      // for `gameId`'s benefit. Reading the scope-aware record here lets a
      // breach that existed before the run started — one the scope asked
      // about and `local-search` has very likely just reported it cannot fix —
      // cost an **unscoped** neighbour its kickoff, leaving the scoped game
      // exactly as broken as it was. A repair scope is permission to try to
      // move the games it names, not a licence to spend the times of games it
      // does not.
      const grown = newBlockingCodes(
        placement.blockingCodeCounts,
        context.baselineBlockingCodes[gameId] ?? {}
      );
      if (grown.length === 0) continue;

      for (const counterpart of placement.counterpartGameIds) {
        if (!current.games[counterpart]) continue;
        if (!mayMove(current, counterpart, this.id, `repair the clash with "${gameId}"`)) continue;

        const counterpartSlot = /** @type {import('./types.js').Slot} */ (
          slotOf(current, counterpart)
        );
        // Measured from where the counterpart was **published**, for the same
        // reason `local-search` is: this game is being asked to move for
        // somebody else's benefit, and the least it is owed is that "how far
        // has it been dragged" is counted from its own published slot.
        const anchor = anchorOf(current, context, counterpart);
        const chosen = chooseSlot(current, context, counterpart, {
          anchor,
          excludeSlotKey: slotKey(counterpartSlot),
        });
        if (chosen === null) continue;
        if (!mayMoveWithinBudget(current, context, counterpart, chosen.slot, this.id)) continue;
        current = applyMove(
          current,
          {
            gameId: counterpart,
            kind: MOVE_KIND.RELOCATE,
            to: chosen.slot,
            reason: `pair repair: it was the movable half of a clash with "${gameId}"`,
            // The clash is the one **`gameId`** is standing in, so the cause is
            // measured there: this counterpart is being moved for somebody
            // else's benefit, and a report that named its own slot's findings
            // would name the wrong constraint.
            cause: constraintCause(context, placement, grown, [
              gameId,
              ...placement.counterpartGameIds.filter((id) => id !== counterpart),
            ]),
          },
          this.id
        );
      }
    }
    return current;
  },
};

/** @type {Object} */
const verify = {
  id: 'verify',
  title: 'Run the standing rule engine over the result and diff it against the baseline',
  freezeContract: {
    mutationKinds: [],
    probe: STAGE_PROBE.WRITES_NOTHING,
    claim:
      'reports; it never repairs. Turnover, round-robin and coach travel belong to the rule engine; the objective may prefer a slot that breaks fewer of them, and nothing here re-solves a season to improve one',
  },
  /**
   * @param {import('./types.js').ResolveState} state
   * @param {Object} context
   */
  run(state, context) {
    const verification = verificationFor(context, state);
    if (verification === null) return state;

    const ledger = state.ledger;
    ledger.meta.rulesRun += verification.meta.rulesRun;
    ledger.meta.rulesExercised += verification.meta.rulesExercised;

    /** @type {Record<string, number>} */
    const before = {};
    for (const violation of context.baselineVerification?.violations ?? []) {
      before[violation.code] = (before[violation.code] ?? 0) + 1;
    }
    /** @type {Record<string, number>} */
    const after = {};
    for (const violation of verification.violations) {
      after[violation.code] = (after[violation.code] ?? 0) + 1;
    }

    for (const [code, count] of Object.entries(after).sort(([a], [b]) => a.localeCompare(b))) {
      const baselineCount = before[code] ?? 0;
      if (count <= baselineCount) continue;
      ledger.findings.push(
        makeResolveFinding(
          RESOLVE_REASON.RESOLVE_VERIFY_NEW_VIOLATION,
          `the standing rule engine reports ${count} ${code} on the resolved schedule against ${baselineCount} on the baseline; this change introduced ${count - baselineCount}. The resolver repairs facility legality only — it does not trade a soft constraint against another`,
          {
            stageId: this.id,
            code,
            baselineCount,
            resolvedCount: count,
            introduced: count - baselineCount,
            rulesRun: verification.meta.rulesRun,
            rulesExercised: verification.meta.rulesExercised,
          }
        )
      );
    }
    return state;
  },
};

/** @type {Object} */
const freezeAudit = {
  id: 'freeze-audit',
  title: 'Prove, from the schedule rather than from the ledger, that nothing frozen moved',
  freezeContract: {
    mutationKinds: [],
    probe: STAGE_PROBE.WRITES_NOTHING,
    claim:
      'compares the final schedule against the position each frozen game was held at — the baseline, or the slot it was pinned at mid-run — game by game, and the per-stage placement deltas against the move ledger; a stage that returned a state it built itself is caught here, because it is exactly the stage that is not in the ledger',
  },
  /**
   * @param {import('./types.js').ResolveState} state
   * @param {Object} context
   */
  run(state, context) {
    const ledger = state.ledger;
    ledger.meta.gamesAudited += state.gameIds.length;

    if (state.gameIds.length === 0) {
      ledger.findings.push(
        makeResolveFinding(
          RESOLVE_REASON.RESOLVE_AUDIT_VACUOUS,
          'the freeze audit examined zero games; "no frozen game moved" over an empty set is not a verdict',
          { stageId: this.id }
        )
      );
      return state;
    }

    // (1) The verdict that matters, enumerated from the **baseline** — the one
    // thing a stage writing around the gate cannot have corrupted.
    //
    // "Where it was held from" is the baseline for every game the plan froze,
    // and the slot it was pinned at for a game `holdChanges` froze part-way
    // through the run. Those games have already moved by the time they are
    // pinned — that is what the change request asked for — so measuring them
    // against the baseline reports four blocking failures on the ordinary path
    // and teaches the next reader to ignore the one check that must never be
    // ignored. The guarantee is unchanged in substance: **nothing moves after
    // it is held**, measured from the moment it was held.
    for (const gameId of state.gameIds) {
      if (state.dispositions[gameId] !== FREEZE_DISPOSITION.FROZEN) continue;
      const baseline = state.baseline[gameId];
      const now = state.games[gameId] ?? null;
      const pinned = state.pinnedAt?.[gameId];
      const before = pinned ?? `${baseline.date}|${baseline.surfaceId}|${baseline.startMinutes}`;
      const after = now === null ? '' : `${now.date}|${now.surfaceId}|${now.startMinutes}`;
      if (before === after) continue;
      const heldFrom = pinned === undefined ? 'the baseline' : 'the slot it was pinned at mid-run';
      ledger.findings.push(
        makeResolveFinding(
          RESOLVE_REASON.RESOLVE_AUDIT_FROZEN_GAME_MOVED,
          `frozen game "${gameId}" was held at ${before} (${heldFrom}) and ended at ${after || '(unplaced)'}; this is the failure the whole freeze exists to prevent (incident 1)`,
          {
            gameId,
            stageId: this.id,
            beforeSlot: before,
            afterSlot: after,
            heldFrom: pinned === undefined ? 'baseline' : 'pinned',
            ruleId: context.judgements.byGameId[gameId]?.decidedByRuleId ?? null,
          }
        )
      );
    }

    // (2) Every placement delta a stage produced has to be in the ledger, and
    // a stage that declared no mutation kinds may produce none at all.
    let previous = context.baselineSnapshot;
    let previousLedgerLength = 0;
    for (const snapshot of context.stageSnapshots) {
      const wrote = [];
      for (const gameId of state.gameIds) {
        if (previous[gameId] !== snapshot.placements[gameId]) wrote.push(gameId);
      }
      const window = ledger.moves
        .slice(previousLedgerLength, snapshot.ledgerLength)
        .map((move) => move.gameId);
      const unlogged = wrote.filter((gameId) => !window.includes(gameId));

      if (unlogged.length > 0) {
        ledger.findings.push(
          makeResolveFinding(
            RESOLVE_REASON.RESOLVE_AUDIT_STAGE_BYPASSED_GATE,
            `stage "${snapshot.stageId}" changed the placement of ${unlogged.length} game(s) with no matching entry in the move ledger (${unlogged.slice(0, 5).join(', ')}); it did not go through applyMove(), so nothing judged the freeze on its behalf`,
            {
              stageId: snapshot.stageId,
              gameCount: unlogged.length,
              exampleGameIds: unlogged.slice(0, 5).sort(),
            }
          )
        );
      }
      if (wrote.length > 0 && snapshot.declaredMutationKinds.length === 0) {
        ledger.findings.push(
          makeResolveFinding(
            RESOLVE_REASON.RESOLVE_AUDIT_STAGE_WROTE_WITHOUT_DECLARING,
            `stage "${snapshot.stageId}" declares no mutation kinds and changed ${wrote.length} placement(s); its freeze contract and its behaviour disagree, and the contract is what its probe tests`,
            {
              stageId: snapshot.stageId,
              gameCount: wrote.length,
              exampleGameIds: wrote.slice(0, 5).sort(),
            }
          )
        );
      }

      previous = snapshot.placements;
      previousLedgerLength = snapshot.ledgerLength;
    }

    return state;
  },
};

/**
 * The pipeline, in order. Every entry is parsed by `ResolveStageSchema` at
 * module load, so a stage with an under-specified freeze contract cannot reach
 * a running system at all.
 *
 * @type {ReadonlyArray<import('./types.js').ResolveStage>}
 */
export const RESOLVE_STAGES = Object.freeze(
  [
    baselineIngest,
    changeRequestApply,
    dislodge,
    initialAssignment,
    localSearch,
    pairRepair,
    verify,
    freezeAudit,
  ].map(
    (stage) => /** @type {import('./types.js').ResolveStage} */ (ResolveStageSchema.parse(stage))
  )
);

/** The audit runs last, always. Extra stages are inserted before it. */
export const FREEZE_AUDIT_STAGE_ID = freezeAudit.id;

/**
 * `verify` runs after every stage that may write, including a caller's.
 *
 * The pair with {@link FREEZE_AUDIT_STAGE_ID}: those two are the pipeline's
 * closing stages, one reporting what the result violates and one proving
 * nothing frozen moved, and **both** must come after anything that can change a
 * placement. Named so a caller registering an `extraStages` entry can state
 * where it lands rather than counting positions.
 */
export const VERIFY_STAGE_ID = verify.id;

/**
 * The pipeline for one run, with any caller-supplied stages inserted before
 * `verify` — and therefore before the audit.
 *
 * `extraStages` mirrors `buildStandingRuleEngine({ extraRules })` deliberately:
 * it is how `tests/freezeScopes.test.js` injects the **deliberately
 * non-compliant** stage that the audit's own positive control needs. An audit
 * that cannot catch a stage reaching around the gate is not worth having, and
 * the only way to know is to hand it one.
 *
 * ## Why they go before `verify`, not merely before the audit
 *
 * They used to be spliced between `verify` and `freeze-audit`. The audit does
 * have to run last, and "before the audit" reads like the whole constraint —
 * but it put the one class of stage nobody in this repository wrote *after* the
 * only stage that checks the result. A move a caller's stage applied was
 * therefore never judged by the standing rule engine, and the run reported the
 * violations of a schedule that no longer existed.
 *
 * The cache key made it worse than a stale number. `runVerification()` keys on
 * `ledger.moves.length`, and `runResolve()` reads the run's own
 * `verification` out of that cache **after** the pipeline has finished. An
 * extra stage that applied even one move pushed the final count past the key
 * `verify` had cached under, so the lookup missed and `run.verification` came
 * back `null` — indistinguishable from `verify: false`, with nothing anywhere
 * saying a verification had been asked for and not produced.
 *
 * `verify` and `freeze-audit` both declare no mutation kinds and write no
 * placement, so neither can move the key out from under that lookup.
 *
 * @param {ReadonlyArray<Object>} [extraStages]
 * @returns {import('./types.js').ResolveStage[]}
 */
export function buildResolvePipeline(extraStages = []) {
  const parsed = extraStages.map(
    (stage) => /** @type {import('./types.js').ResolveStage} */ (ResolveStageSchema.parse(stage))
  );
  const closing = new Set([VERIFY_STAGE_ID, FREEZE_AUDIT_STAGE_ID]);
  const writers = RESOLVE_STAGES.filter((stage) => !closing.has(stage.id));
  const stageById = (id) =>
    /** @type {import('./types.js').ResolveStage} */ (
      RESOLVE_STAGES.find((stage) => stage.id === id)
    );
  // Every registered id, not merely the ones that come before the extras: a
  // caller shadowing `verify` would otherwise have been accepted and then
  // silently dropped from the pipeline.
  const seen = new Set(RESOLVE_STAGES.map((stage) => stage.id));
  for (const stage of parsed) {
    if (seen.has(stage.id)) {
      throw new Error(`resolve: two stages claim the id "${stage.id}"`);
    }
    seen.add(stage.id);
  }
  return [...writers, ...parsed, stageById(VERIFY_STAGE_ID), stageById(FREEZE_AUDIT_STAGE_ID)];
}
