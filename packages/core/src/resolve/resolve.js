/**
 * The two entry points: **apply a change request**, and — explicitly, by name,
 * with an acknowledgement — **re-optimise the whole season**.
 *
 * ## Maximum freeze is what you get by not asking for anything else
 *
 * `applyChangeRequest()` with no `freeze` argument builds
 * `freezeForChanges(changes)`: a plan that thaws exactly the games the request
 * names and freezes every other game in the season. "A change request touches
 * only what it must" is therefore not a policy the solver tries to honour — it
 * is the shape of the only plan it was handed.
 *
 * `freeze: null` is a **TypeError**, not "no freeze". A caller who means "let
 * everything move" has to say `reoptimiseWholeSeason()`, spell out a reason,
 * and pass the literal `true`; and the plan that comes back is stamped
 * `FREEZE_GLOBAL_REOPTIMISATION` at blocking, so the report can never come back
 * clean. Incident 1 was a global re-solve that produced a valid-looking answer
 * in which 366 of 679 games had silently moved; the point of this module is
 * that the same operation is still available and can no longer be reached by
 * accident or read as routine.
 *
 * @module resolve/resolve
 */

import { FREEZE_DISPOSITION } from '../freeze/reasonCodes.js';
import { buildFreezePlan, freezeForChanges, judgeFreezeAll } from '../freeze/plan.js';
import { getSurface } from '../facility/facilityGraph.js';
import { runRuleEngine } from '../ruleEngine/engine.js';
import { ScheduleSchema } from '../ruleEngine/schemas.js';

import { buildSlotInventory } from './inventory.js';
import { indexCommitments, projectCommitment } from './ruleGate.js';
import { objectiveWeightsAreDefault, resolveObjectiveWeights } from './objective.js';
import {
  RESOLVE_REASON,
  createResolveMeta,
  deriveResolveStatus,
  makeResolveFinding,
  mergeResolveMeta,
} from './reasonCodes.js';
import { buildChangeReport } from './report.js';
import { ScheduleChangeRequestSchema } from './schemas.js';
import { buildResolvePipeline } from './stages.js';
import {
  baselinePartitionFindings,
  createResolveLedger,
  createResolveState,
  diffAgainstBaseline,
  pinGames,
  resolveContextDefaults,
  slotKey,
} from './state.js';

/** The stage after which `holdChanges` pins what the request just moved. */
const CHANGE_STAGE_ID = 'change-request-apply';

/**
 * Everything the re-solver needs from Phases 1-3, checked once.
 *
 * @param {Object} engines
 * @returns {Object}
 */
function requireEngines(engines) {
  const { graph, table, calendar, registry } = engines ?? {};
  if (!graph || !table || !calendar || !registry) {
    throw new Error(
      'resolve: needs { graph, table, calendar, registry } — the Phase 1.1 facility graph, the Phase 1.2 format timing table, the Phase 1.3 availability calendar and the Phase 2.1 constraint registry'
    );
  }
  return engines;
}

/**
 * Where one game stands, for the freeze plan to judge it against.
 *
 * @param {import('../facility/types.js').FacilityGraph} graph
 * @param {import('./types.js').PlacedGame} game
 * @returns {import('../freeze/types.js').FreezeContext}
 */
function freezeContextOf(graph, game) {
  const surface = getSurface(graph, game.surfaceId);
  return {
    gameId: game.id,
    date: game.date,
    divisionLabel: game.divisionLabel,
    venueId: game.venueId,
    surfaceId: game.surfaceId,
    // Lineage, so freezing "Pitch 1" freezes the games standing on 1A and 1B.
    surfaceLineage: surface ? [...surface.lineage] : [game.surfaceId],
    format: game.format,
    teamIds: [game.homeTeamId, game.awayTeamId].filter(
      (id) => typeof id === 'string' && id.length > 0
    ),
  };
}

/**
 * The schedule a state currently describes.
 *
 * The universes are carried through from the baseline rather than re-derived
 * from the games: a universe derived from the rows it is meant to police cannot
 * police them, which is the lesson `ruleEngine/schemas.js` already records.
 *
 * @param {import('../ruleEngine/types.js').Schedule} baseSchedule
 * @param {import('./types.js').ResolveState} state
 * @returns {import('../ruleEngine/types.js').Schedule}
 */
export function resolvedScheduleOf(baseSchedule, state) {
  const games = state.gameIds
    .filter((gameId) => state.games[gameId] !== undefined)
    .map((gameId) => ({ ...state.games[gameId] }));

  // **A commitment to a game follows the game.** The schedule carries a
  // person-day timeline alongside the rows, and the standing rule engine's
  // coach-conflict rule reads it rather than the games — so a resolved schedule
  // that kept the baseline's commitments would be judged on where the coaches
  // used to be. Every knock-on to a coach's day, which is the half of a change
  // request nobody notices until somebody complains, would be invisible, and
  // the run would report a clean coach column for a schedule it had just broken.
  //
  // A commitment whose game has no time left is **not a commitment to a time**,
  // so it does not travel: the game itself is carried as TIME TBD with a reason
  // (incident 10) and that is where it is reported. Commitments naming no game,
  // or a game this run does not hold — a scrimmage, a field reservation, an
  // external club's window — pass through untouched, because a change request
  // cannot edit one.
  // The projection itself lives in `ruleGate.js`, shared with the placer's
  // coach check, so `verify` and the gate cannot put a coach in two places.
  const commitments = (baseSchedule.commitments ?? [])
    .map((commitment) => projectCommitment(commitment, state))
    .filter((commitment) => commitment !== null);

  return /** @type {import('../ruleEngine/types.js').Schedule} */ ({
    ...baseSchedule,
    games,
    commitments,
  });
}

/**
 * A snapshot of where everything stands, for the audit to diff.
 *
 * @param {import('./types.js').ResolveState} state
 * @returns {Record<string, string>}
 */
function placementSnapshot(state) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const gameId of state.gameIds) {
    const game = state.games[gameId];
    out[gameId] = game === undefined ? '' : `${game.date}|${game.surfaceId}|${game.startMinutes}`;
  }
  return out;
}

/**
 * The shared driver. Not exported: the two named entry points below are the
 * only ways in, which is what makes "exactly one export can produce a thawed
 * default" a statement about the module rather than about discipline.
 *
 * @param {Object} input
 * @returns {import('./types.js').ResolveRun}
 */
function runResolve(input) {
  const engines = requireEngines(input.engines);
  const baseSchedule = /** @type {import('../ruleEngine/types.js').Schedule} */ (
    ScheduleSchema.parse(input.schedule)
  );
  const changes = (input.changes ?? []).map((change) => ScheduleChangeRequestSchema.parse(change));
  const plan = input.plan;

  const changedIds = changes.map((change) => change.gameId);
  if (new Set(changedIds).size !== changedIds.length) {
    // Two changes for one game are two answers to "where does it go", and the
    // later one would silently win. There is no reading of that a caller meant.
    throw new Error(
      'resolve: the change request names the same game more than once; a game has one destination, and picking the last one silently is not a decision this module gets to make'
    );
  }

  if (baseSchedule.games.length === 0) {
    throw new Error(
      'resolve: the schedule holds no games, so every verdict this run could produce would be true of nothing (incident 4)'
    );
  }

  // **The repair scope**: games this run is asked to repair rather than to
  // accept as it found them. See `RESOLVE_REPAIR_SCOPE_DECLARED`. An id the
  // schedule does not hold throws rather than being skipped, for the same
  // reason `season2026ExternalFixtureChanges()` refuses a fixture matching no
  // game: a scope that silently covered eleven of twelve closed-venue games
  // would produce a clean report about the wrong eleven.
  const scheduleGameIds = new Set(baseSchedule.games.map((game) => game.id));
  const repairScopeIds = [...new Set(input.repairScope ?? [])];
  for (const gameId of repairScopeIds) {
    if (!scheduleGameIds.has(gameId)) {
      throw new Error(
        `resolve: the repair scope names game "${gameId}", which this schedule does not hold; a scope that quietly covered fewer games than it named would report a bounded repair of the wrong set`
      );
    }
  }
  const repairScope = new Set(repairScopeIds);
  const games = baseSchedule.games.map((game) => ({ ...game }));
  const judgements = judgeFreezeAll(
    plan,
    games.map((game) => freezeContextOf(engines.graph, game))
  );
  /** @type {Record<string, string>} */
  const dispositions = {};
  for (const [gameId, judgement] of Object.entries(judgements.byGameId)) {
    dispositions[gameId] = judgement.disposition;
  }

  // Surfaces a change request names that no baseline row ever stood on. They
  // enter the *venue lookup* only, never the placer's candidate surfaces, so a
  // relocated game carries the venue it is actually standing at.
  /** @type {Record<string, string>} */
  const surfaceVenues = {};
  for (const change of changes) {
    if (change.surfaceId === null) continue;
    const surface = getSurface(engines.graph, change.surfaceId);
    if (surface) surfaceVenues[change.surfaceId] = surface.venueId;
  }

  const inventory = buildSlotInventory(games, { surfaceVenues });
  /** @type {Record<string, string[]>} */
  const admittedSlotsByGameId = {};
  const ledger = createResolveLedger();
  for (const change of changes) {
    const game = games.find((candidate) => candidate.id === change.gameId);
    if (!game) continue;
    const slot = {
      date: change.date ?? game.date,
      surfaceId: change.surfaceId ?? game.surfaceId,
      startMinutes: change.startMinutes,
    };
    admittedSlotsByGameId[change.gameId] = [
      ...(admittedSlotsByGameId[change.gameId] ?? []),
      slotKey(slot),
    ];
    const venueId = inventory.venueBySurfaceId[slot.surfaceId];
    const known =
      inventory.dates.includes(slot.date) &&
      venueId !== undefined &&
      (inventory.kickoffsByDateVenue[`${slot.date}|${venueId}`] ?? []).includes(slot.startMinutes);
    if (known) continue;
    ledger.findings.push(
      makeResolveFinding(
        RESOLVE_REASON.RESOLVE_CHANGE_SLOT_OUTSIDE_INVENTORY,
        `the change request puts game "${change.gameId}" on ${slotKey(slot)}, a slot the baseline schedule never used; it is admitted for this game only, because an externally-published fixture brings its own time and the club does not get to invent one for it`,
        { gameId: change.gameId, slot: slotKey(slot) }
      )
    );
  }

  // The objective, resolved once for the whole run. Every stage that chooses a
  // slot, the dry-run report and the change budget all read this one table.
  // **By value, never by identity.** `objectiveWeights: {}` — and a table
  // spelled out to exactly the shipped numbers — resolves to a fresh object that
  // scores every run identically. Stamping those as overridden tells an operator
  // that two comparable runs are incomparable, which is the same disservice as
  // failing to stamp a real override.
  const weights = resolveObjectiveWeights(input.objectiveWeights);
  if (!objectiveWeightsAreDefault(weights)) {
    ledger.findings.push(
      makeResolveFinding(
        RESOLVE_REASON.RESOLVE_OBJECTIVE_WEIGHTS_OVERRIDDEN,
        'this run was scored under weights the caller supplied rather than the defaults; two runs of one change request under different objectives are not comparable, so the objective travels with the report',
        Object.fromEntries(Object.entries(weights).map(([term, weight]) => [term, weight]))
      )
    );
  }

  let state = createResolveState({ games, dispositions, admittedSlotsByGameId, inventory, ledger });

  const touchedDates = input.dislodgeAll
    ? [...inventory.dates]
    : [
        ...new Set([
          ...changes.flatMap((change) => {
            const game = state.baseline[change.gameId];
            return game ? [game.date, change.date ?? game.date] : [];
          }),
          // Without this the scope is inert: `local-search` and `pair-repair`
          // both iterate `placedGamesOn(current, context.touchedDates)`, so a
          // scoped game on a date the change request never mentions is never
          // visited and the run reports a repair it never attempted.
          ...repairScopeIds.map((gameId) => state.baseline[gameId].date),
        ]),
      ].sort();

  /** @type {Object} */
  const context = {
    ...resolveContextDefaults(),
    engines,
    changes,
    plan,
    judgements,
    weights,
    dislodgeAll: input.dislodgeAll === true,
    onUnsatisfiable: input.onUnsatisfiable ?? 'throw',
    touchedDates,
    repairScope,
    /**
     * The cap, on the context, so the placer is told the number **before** it
     * spends it. `report.js` still checks the finished run against it; that
     * check is now a backstop rather than the only enforcement.
     */
    changeBudget: input.changeBudget ?? null,
    /**
     * Every commitment the schedule carries, indexed for the placer's coach
     * check (`ruleGate.js`) — including those naming no game, which a coach's
     * day still contains.
     */
    commitmentIndex: indexCommitments(baseSchedule.commitments ?? []),
    /**
     * What the rule engine already said about the schedule **before** this run
     * touched it.
     *
     * Derived here when the caller does not supply it, rather than defaulting
     * to "the baseline had no violations". The published season-2026 schedule
     * carries 62 accepted exceptions, and treating that as a clean baseline
     * makes the `verify` stage report all of them as newly introduced — a
     * change request blamed for four `Scrimmage` rows with no timing entry and
     * 36 Minis sessions on unlined ground. That is the same mistake
     * `newBlockingCodes()` exists to prevent on the facility side, and it is
     * not the caller's job to remember it.
     */
    baselineVerification: null,
    verificationCache: new Map(),
    stageSnapshots: [],
    baselineSnapshot: placementSnapshot(state),
    /**
     * The rule-engine run, computed at most once per distinct state.
     *
     * @param {import('./types.js').ResolveState} current
     * @returns {Object|null}
     */
    runVerification(current) {
      if (input.verify === false) return null;
      const key = current.ledger.moves.length;
      const cached = context.verificationCache.get(key);
      if (cached !== undefined) return cached;
      const result = runRuleEngine(resolvedScheduleOf(baseSchedule, current), {
        registry: engines.registry,
        ledger: engines.waiverLedger ?? null,
        resources: engines.resources ?? {},
        engine: engines.ruleEngine,
      });
      context.verificationCache.set(key, result);
      return result;
    },
  };

  // At this point no move has been applied, so the cache key (`0`) is the
  // baseline's own and a run that moves nothing correctly reuses it.
  context.baselineVerification = input.baselineVerification ?? context.runVerification(state);

  const pipeline = buildResolvePipeline(input.extraStages ?? []);
  ledger.meta.stagesRegistered = pipeline.length;

  for (const stage of pipeline) {
    const next = stage.run(state, context);
    if (!next || typeof next !== 'object' || !Array.isArray(next.gameIds)) {
      throw new Error(`resolve: stage "${stage.id}" did not return a state`);
    }
    state = next;
    ledger.meta.stagesRun += 1;
    context.stageSnapshots.push({
      stageId: stage.id,
      title: stage.title,
      declaredMutationKinds: [...stage.freezeContract.mutationKinds],
      placements: placementSnapshot(state),
      ledgerLength: ledger.moves.length,
    });

    if (stage.id === CHANGE_STAGE_ID && input.holdChanges === true) {
      // "These times are not mine to move." The right setting for an
      // externally-published fixture: the request states a fact, and a slot the
      // fact cannot occupy is a contradiction to raise, not a request to
      // quietly reinterpret.
      const moved = ledger.moves
        .filter((move) => move.stageId === CHANGE_STAGE_ID)
        .map((move) => move.gameId);
      state = pinGames(state, moved, 'held at the slot the change request named (holdChanges)');
    }
  }

  if (ledger.meta.movesConsidered === 0) {
    ledger.findings.push(
      makeResolveFinding(
        RESOLVE_REASON.RESOLVE_NOTHING_CONSIDERED,
        'this run never asked the freeze a single question, so its "no frozen game moved" verdict is true of nothing it did',
        { stagesRun: ledger.meta.stagesRun }
      )
    );
  }

  // **The dry run's report, built before the run is handed back**, because a
  // re-solve that could be read without it would be a re-solve somebody read
  // without it. It carries the three categories, checks its own partition, and
  // is what the change budget is measured against.
  // **The repair scope's own verdict**, emitted from the roster of ids the
  // caller named rather than from whatever the pipeline ended up touching:
  // a scope whose games the run dropped must be reported as unexercised, not
  // be absent from the set that would have named it.
  if (repairScopeIds.length > 0) {
    ledger.meta.repairScopeGames = repairScopeIds.length;

    // **A scoped game the plan freezes is a repair nobody can make, and it has
    // to say so here.** The scope does not thaw anything — the freeze is the
    // only authority on what may move — and `applyChangeRequest()` defaults to
    // maximum freeze, which holds every game the change request does not name.
    // A repair scope is *for* games the request does not name, so the default
    // path freezes the whole scope. `local-search` then turns back at its
    // `mayMove()` guard, before the branch that reports an unrepairable game,
    // and the run comes back with `repairsUnavailable: 0` and a scope report
    // saying that every one of them carried findings "this run therefore has
    // to answer for" — byte for byte the report of a run that answered them.
    // The generic `FREEZE_MOVE_REFUSED` findings are no help: every frozen
    // consideration in the run produces those.
    const frozenInScope = repairScopeIds.filter(
      (gameId) => dispositions[gameId] === FREEZE_DISPOSITION.FROZEN
    );
    for (const gameId of frozenInScope) {
      ledger.meta.repairsUnavailable += 1;
      const judgement = judgements.byGameId[gameId];
      ledger.findings.push(
        makeResolveFinding(
          RESOLVE_REASON.RESOLVE_REPAIR_UNAVAILABLE,
          `game "${gameId}" is in the repair scope and the plan freezes it${judgement?.decidedByRuleId ? ` (rule "${judgement.decidedByRuleId}")` : ' by default'}; no repair was attempted, because the scope says what to repair and the freeze says what may move. Thaw it by name if it is meant to move`,
          {
            gameId,
            reason: 'frozen',
            ruleId: judgement?.decidedByRuleId ?? null,
          }
        )
      );
    }

    const exercised = repairScopeIds.filter(
      (gameId) => (context.repairScopeExercised[gameId] ?? 0) > 0
    );
    const discarded = repairScopeIds.reduce(
      (total, gameId) => total + (context.repairScopeExercised[gameId] ?? 0),
      0
    );
    if (exercised.length === 0) {
      ledger.findings.push(
        makeResolveFinding(
          RESOLVE_REASON.RESOLVE_REPAIR_SCOPE_VACUOUS,
          `the repair scope names ${repairScopeIds.length} game(s) and not one of them carries a baseline blocking finding, so un-accepting them discarded nothing every stage downstream does not re-accept and this run repaired nothing it would not have repaired anyway. A bounded repair reported over an undisturbed schedule is incident 4 one layer up`,
          {
            scopeGames: repairScopeIds.length,
            exercised: 0,
            findingsDiscarded: 0,
            frozen: frozenInScope.length,
          }
        )
      );
    } else {
      ledger.findings.push(
        makeResolveFinding(
          RESOLVE_REASON.RESOLVE_REPAIR_SCOPE_DECLARED,
          `${repairScopeIds.length} game(s) are in the repair scope: their baseline positions are not accepted as given, and ${exercised.length} of them carried ${discarded} baseline blocking finding(s) that this run therefore has to answer for rather than inherit${frozenInScope.length === 0 ? '' : `. ${frozenInScope.length} of them are frozen and no repair was attempted for those`}`,
          {
            scopeGames: repairScopeIds.length,
            exercised: exercised.length,
            findingsDiscarded: discarded,
            frozen: frozenInScope.length,
          }
        )
      );
    }
  }

  const resolvedSchedule = resolvedScheduleOf(baseSchedule, state);
  const partition = diffAgainstBaseline(state);
  const moved = partition.moved;
  for (const finding of baselinePartitionFindings(partition, {
    baselineGames: state.gameIds.length,
  })) {
    ledger.findings.push(finding);
  }
  const report = buildChangeReport({
    partition,
    name: input.name,
    baselineSchedule: baseSchedule,
    schedule: resolvedSchedule,
    changes,
    moved,
    unplaced: state.unplaced,
    moves: ledger.moves,
    state,
    baselineVerification: context.baselineVerification,
    verification: context.verificationCache.get(ledger.moves.length) ?? null,
    weights,
    changeBudget: input.changeBudget ?? null,
  });
  for (const finding of report.findings) ledger.findings.push(finding);

  ledger.findings.push(
    makeResolveFinding(
      RESOLVE_REASON.RESOLVE_DRY_RUN,
      `this is a dry run: ${moved.length} game(s) would move, ${report.meta.movedRequested} named by the request and ${report.meta.movedConsequential} as a consequence. Nothing has been committed; commitResolve() is the second step`,
      {
        movedGames: moved.length,
        movedRequested: report.meta.movedRequested,
        movedConsequential: report.meta.movedConsequential,
      }
    )
  );

  const findings = [...judgements.findings, ...ledger.findings];
  const meta = mergeResolveMeta(createResolveMeta(), ledger.meta);
  meta.freezeJudgements = Math.max(meta.freezeJudgements, judgements.meta.gamesJudged);
  // How many distinct (date, surface, kickoff) slots the baseline ever used —
  // the whole of what this package is allowed to offer anybody.
  meta.slotsAvailable = inventory.slotCount;
  meta.movedGames = Number(report.meta.movedGames);
  meta.movedRequested = Number(report.meta.movedRequested);
  meta.movedConsequential = Number(report.meta.movedConsequential);
  meta.movedConsequentialExplained = Number(report.meta.movedConsequentialExplained);
  // Read off the same partition the report published, not recomputed: two
  // counts of one hold would be free to disagree about a shelved game.
  meta.publishedKickoffHeld = partition.counts.publishedKickoffHeld;
  meta.publishedSlotHeld = partition.counts.publishedSlotHeld;

  /** @type {import('./types.js').StageResult[]} */
  const stages = pipeline.map((stage) => {
    const counters = ledger.byStage[stage.id] ?? { considered: 0, rejected: 0, applied: 0 };
    return {
      stageId: stage.id,
      title: stage.title,
      declaredMutationKinds: [...stage.freezeContract.mutationKinds],
      claim: stage.freezeContract.claim,
      movesConsidered: counters.considered,
      movesRejectedByFreeze: counters.rejected,
      movesApplied: counters.applied,
      findingsEmitted: findings.filter((finding) => finding.details.stageId === stage.id).length,
    };
  });

  return {
    name: input.name,
    // **Always false, from both entry points, however they are called.** There
    // is no `commit` argument anywhere in this module; `commitResolve()` is the
    // only function in the package that can produce a committed result, and a
    // structural test asserts it.
    committed: false,
    schedule: resolvedSchedule,
    baselineSchedule: baseSchedule,
    freeze: plan,
    judgements,
    state,
    moved,
    /**
     * The whole baseline partition, of which `moved` is one bucket. Carried so
     * a caller asking "what held" does not have to subtract two lists and
     * arrive at a third opinion.
     */
    partition,
    unplaced: [...state.unplaced],
    moves: [...ledger.moves],
    stages,
    unsatisfiable: [...context.unsatisfiableErrors],
    verification: context.verificationCache.get(ledger.moves.length) ?? null,
    objective: report.objective,
    budget: report.budget,
    report,
    findings,
    status: deriveResolveStatus(findings),
    meta,
  };
}

/**
 * Apply a change request to a published schedule, holding everything the plan
 * does not thaw.
 *
 * @param {import('./types.js').ResolveInput} input
 * @returns {import('./types.js').ResolveRun}
 */
export function applyChangeRequest(input) {
  if (input.freeze === null) {
    throw new TypeError(
      'resolve: `freeze: null` is not "no freeze" — it is a missing argument. Omit it for maximum freeze (every game held except the ones the request names), or call reoptimiseWholeSeason() and say why.'
    );
  }
  const changes = input.changes ?? [];
  if (changes.length === 0) {
    throw new Error(
      'resolve: applyChangeRequest() was given no changes; a change request that asks for nothing has nothing to freeze around, and reporting "no frozen game moved" over it would be vacuous (incident 4)'
    );
  }
  const plan = input.freeze ?? freezeForChanges(changes);
  if (plan.defaultDisposition === FREEZE_DISPOSITION.THAWED) {
    throw new Error(
      'resolve: applyChangeRequest() was handed a plan that thaws every game by default. A global re-solve is a different, named operation: call reoptimiseWholeSeason().'
    );
  }
  return runResolve({
    ...input,
    name: input.name ?? 'change request',
    plan,
    changes,
    dislodgeAll: false,
  });
}

/**
 * Re-optimise the whole season. **The named, rare, loud operation.**
 *
 * This is the only function in the package that can produce a plan whose
 * default is `thawed`, and everything about the way it is reached is
 * deliberate: the name says what it does, `reason` must say why, `acknowledged`
 * must be the literal `true`, and the plan it builds carries
 * `FREEZE_GLOBAL_REOPTIMISATION` at **blocking**.
 *
 * ## What Prompt 4.2 changed here
 *
 * Until 4.2 this function handed the placer an **earliest-legal-first**
 * ordering. That was not a policy anybody wanted; it was the absence of one.
 * Under 4.1's hold rule a legal game was never moved, so a global re-solve that
 * kept the hold rule would have moved nothing and proved nothing, and
 * earliest-first was the only way to make the operation genuinely re-solve the
 * season the way incident 1's solver did.
 *
 * There is now an objective, so it uses the objective — the same one
 * `applyChangeRequest()` uses, with the same default weights. Every game still
 * comes off the board and is placed again from scratch (`dislodgeAll`), but the
 * objective's change terms mean each one is offered the slot it already had
 * first. **A global re-optimisation is therefore no longer a synonym for a
 * reshuffle**, which is the whole of what this prompt is about, and the number
 * of games it moves is the measurement of that.
 *
 * The old behaviour is still reachable, by name and only by name:
 *
 * ```js
 * reoptimiseWholeSeason({
 *   …,
 *   objectiveWeights: { changedGame: 0, driftMinute: 0, changedSurface: 0 },
 * });
 * ```
 *
 * — the objective with change minimisation switched off, which stamps
 * `RESOLVE_OBJECTIVE_CHANGE_TERM_DISABLED` at `compromise` on the run. That is
 * what the positive control in `tests/freezeScopes.test.js` asks for, and it is
 * what makes "what did the freeze prevent" a measurement rather than a claim.
 *
 * @param {import('./types.js').ResolveInput} input - `reason` and `acknowledged` are required
 * @returns {import('./types.js').ResolveRun}
 */
export function reoptimiseWholeSeason(input) {
  const plan = buildFreezePlan({
    name: 'global re-optimisation',
    defaultDisposition: FREEZE_DISPOSITION.THAWED,
    rules: input.holdScopes ?? [],
    globalReoptimisation: {
      reason: /** @type {string} */ (input.reason),
      acknowledged: /** @type {true} */ (input.acknowledged),
      requestedBy: input.requestedBy ?? null,
    },
  });
  return runResolve({
    ...input,
    name: input.name ?? 'global re-optimisation',
    plan,
    changes: input.changes ?? [],
    dislodgeAll: true,
  });
}
