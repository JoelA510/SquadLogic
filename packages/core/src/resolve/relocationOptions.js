/**
 * **Cross-venue options for a game `resolve/` could not place cleanly — offered,
 * never applied** (#53).
 *
 * `chooseSlot()` only ever offers slots at the game's own venue on its own date
 * (`inventory.js` `candidateSlotsFor()`, the anti-slot-inventor guarantee), so a
 * withdrawn venue leaves games TIME TBD, and a full one leaves the placer's
 * last resort: a coach overlap, carried with a warning (#61). The operator's
 * placement preference, strictly ordered, is:
 *
 * 1. a clean slot at the same venue — the placer, pass 1;
 * 2. a clean slot at another venue — **this module**, for the operator to approve;
 * 3. the same venue with a coach overlap, warned — the placer, pass 2;
 * 4. TIME TBD.
 *
 * Step 2 cannot be an automatic placement, because a venue change moves every
 * family's travel. So it is realised as options attached to the outcomes of
 * steps 3 and 4: a game placed on an overlap keeps its warned slot and is
 * offered alternatives; a TIME TBD game stays TIME TBD until one is approved.
 * **The order between 2 and 3 is by construction, not by score.** Measured on
 * the 679-run displacement sweep, the objective's default weights score the best
 * cross-venue option *worse* than the overlap in 8 of 22 cases, because an
 * overlap costs one compromise (100) and a cross-venue option typically drifts
 * 225 minutes. Filtering options by "scores better than where it stands" would
 * silently undo the operator's order, and the test suite breaks that on purpose.
 *
 * ## Relocation proposes, `resolve/` decides
 *
 * The candidate search is `scenario/relocation.js` `relocationOptionsFor()`:
 * the ground, the grid, the free-surface and team checks. Every survivor is
 * judged here by {@link evaluateCandidate} — the facility model, the rule gate
 * and `scoreObjective()`, the same three questions the placer asks — and the
 * order is `rankReplacementOptions()`: clean first, then the objective.
 *
 * ## What an option says, and what it cannot
 *
 * Venue, surface, date and time, drift, the objective's breakdown, the
 * compromise codes the slot carries, the games offered the same slot, and a
 * ready-made `approved-option` change. **Travel impact is `null`** with
 * `travelImpactKnown: false`: no coordinates exist in the repo (the corpus is
 * anonymised), and 8.9 is about to add venue coordinates to the organisation's
 * database for the sunset calculation, which will make it computable. Nothing
 * here is wired to coordinates yet.
 *
 * ## Offered independently, so approved one at a time
 *
 * Each game's options are searched against the run's result, not against each
 * other's: on the brookside-park withdrawal, 216 offers covered 39 distinct
 * slots. `sharedWith` names the other games offered each slot, and an approval
 * is judged again in `change-request-apply` — the second approval of a shared
 * slot is `RESOLVE_OPTION_STALE`, never a double-booking and never a dislodge.
 *
 * ## Judged twice, against two different moments — stated, not hidden
 *
 * An option is judged against this run's **finished** schedule; its approval
 * is judged in `change-request-apply` of the next run, **before** `dislodge`,
 * the placer and `local-search` have moved anything. Where this run freed a
 * slot by moving a game, the approval can find that game still standing on it
 * and be refused as stale, and a coach's other game not yet moved can change
 * a travel code. The refusal is the safe direction — nothing is applied that
 * was not judged — and the operator is offered the next run's options.
 *
 * @module resolve/relocationOptions
 */

import { relocationOptionsFor } from '../scenario/relocation.js';

import { RESOLVE_REASON, makeResolveFinding } from './reasonCodes.js';
import { gameOnSlot, indexCommitments } from './ruleGate.js';
import { CHANGE_ORIGIN, relocationOptionId } from './schemas.js';
import { evaluateCandidate, recordBaselineAcceptance } from './stages.js';
import { resolveContextDefaults, slotKey } from './state.js';
import { resolveObjectiveWeights } from './objective.js';

/** What an option says about travel until 8.9's venue coordinates exist. */
const TRAVEL_IMPACT_UNKNOWN = Object.freeze({ travelImpact: null, travelImpactKnown: false });

/**
 * The published slot of a baseline row.
 *
 * @param {Object} game
 * @returns {import('./types.js').Slot}
 */
function publishedSlotOf(game) {
  return { date: game.date, surfaceId: game.surfaceId, startMinutes: game.startMinutes };
}

/**
 * Which games are offered options, **enumerated from the run's own records** —
 * `state.unplaced` and the placer's pass-2 record — never from the options, so
 * a trigger whose search came back empty is reported rather than absent.
 *
 * @param {import('./types.js').ResolveState} state
 * @param {Object} context
 * @returns {Array<{ gameId: string, trigger: 'time-tbd' | 'coach-overlap' }>}
 */
function triggersOf(state, context) {
  /** @type {Map<string, 'time-tbd' | 'coach-overlap'>} */
  const triggers = new Map();
  for (const entry of state.unplaced) {
    if (state.games[entry.gameId] === undefined) triggers.set(entry.gameId, 'time-tbd');
  }
  for (const [gameId, placedAt] of context.overlapFallbackPlaced) {
    const game = state.games[gameId];
    // Moved off its overlap since, or lifted again: no longer this trigger.
    if (game === undefined || slotKey(game) !== placedAt) continue;
    triggers.set(gameId, 'coach-overlap');
  }
  return [...triggers.entries()]
    .map(([gameId, trigger]) => ({ gameId, trigger }))
    .sort((a, b) => {
      const left = state.baseline[a.gameId];
      const right = state.baseline[b.gameId];
      return (
        left.date.localeCompare(right.date) ||
        left.startMinutes - right.startMinutes ||
        a.gameId.localeCompare(b.gameId)
      );
    });
}

/**
 * The read-only options pass: after every stage, before the result is handed
 * back. Moves nothing and writes no state; its findings go on the ledger.
 *
 * @param {Object} input
 * @param {{ policies: Record<string, unknown>, limit: number }} input.search - a parsed `RelocationSearchSchema`
 * @param {import('./types.js').ResolveState} input.state - the finished state
 * @param {Object} input.context - the run's context
 * @returns {Array<Object>} one entry per trigger game, in baseline order
 */
export function offerRelocationOptions(input) {
  const { search, state, context } = input;
  const standing = state.gameIds
    .map((gameId) => state.games[gameId])
    .filter((game) => game !== undefined);
  const judge = {
    /**
     * @param {string} gameId
     * @param {import('./types.js').Slot} slot
     */
    evaluate: (gameId, slot) =>
      evaluateCandidate(context, state, gameId, slot, publishedSlotOf(state.baseline[gameId])),
    hold: () => {
      throw new Error('resolve: the options pass holds nothing; it offers, and applies nothing');
    },
  };

  const entries = [];
  for (const { gameId, trigger } of triggersOf(state, context)) {
    const game = state.baseline[gameId];
    const current = state.games[gameId] ?? null;
    const policy = typeof game.format === 'string' ? search.policies[game.format] : undefined;
    const searched =
      policy === undefined
        ? null
        : relocationOptionsFor(context.engines, {
            game,
            standing,
            policy,
            probe: judge,
            limit: search.limit,
          });
    const options = (searched?.options ?? []).map((option) => {
      const to = {
        date: game.date,
        surfaceId: option.surfaceId,
        startMinutes: option.startMinutes,
      };
      const optionId = relocationOptionId(gameId, to);
      return {
        optionId,
        gameId,
        from: publishedSlotOf(game),
        currentSlot: current === null ? null : slotKey(current),
        to,
        fromVenueId: game.venueId,
        toVenueId: context.engines.graph.surfaces[option.surfaceId]?.venueId ?? '',
        surfaceId: option.surfaceId,
        driftMinutes: option.driftMinutes,
        grade: option.grade,
        compromiseCodes: [...option.compromiseCodes],
        objective: { total: option.score, counts: { ...option.counts } },
        // Only options the gate cleared are offered; stated so a reader need
        // not know that.
        clearsRuleGate: true,
        sharedWith: /** @type {string[]} */ ([]),
        ...TRAVEL_IMPACT_UNKNOWN,
        applyAs: {
          gameId,
          date: to.date,
          surfaceId: to.surfaceId,
          startMinutes: to.startMinutes,
          reason: `approved cross-venue option ${optionId}`,
          origin: CHANGE_ORIGIN.APPROVED_OPTION,
          optionId,
          compromiseCodes: [...option.compromiseCodes],
        },
      };
    });
    // **The search's own ground report, carried rather than kept on the side.**
    // A blocking capacity finding impeaches the search (it examined nothing,
    // or does not cover ground somebody reserved); left on the entry alone it
    // could never reach this run's status — the defect `proposeRelocations()`
    // had and fixed.
    for (const finding of searched?.capacityFindings ?? []) state.ledger.findings.push(finding);
    const entry = {
      gameId,
      trigger,
      searched: searched !== null,
      candidatesConsidered: searched?.candidatesConsidered ?? 0,
      refusedForTeamClash: searched?.refusedForTeamClash ?? 0,
      refusedByGate: searched?.refusedByGate ?? 0,
      capacityFindings: searched?.capacityFindings ?? [],
      options,
    };
    entries.push(entry);

    const details = {
      gameId,
      trigger,
      candidatesConsidered: entry.candidatesConsidered,
      refusedForTeamClash: entry.refusedForTeamClash,
      refusedByGate: entry.refusedByGate,
    };
    if (entry.candidatesConsidered === 0) {
      state.ledger.findings.push(
        makeResolveFinding(
          RESOLVE_REASON.RESOLVE_RELOCATION_SEARCH_VACUOUS,
          policy === undefined
            ? `game "${gameId}" (${trigger}) needed cross-venue options and the search states no policy for its format "${game.format ?? ''}"; "no options" from a search that looked at nothing would be a claim about the season it cannot make`
            : `game "${gameId}" (${trigger}) needed cross-venue options and the stated search generated no candidate slot on ${game.date} away from its own venue; "no options" from a search that looked at nothing would be a claim about the season it cannot make`,
          { ...details, format: game.format ?? null, policyStated: policy !== undefined }
        )
      );
    } else if (options.length === 0) {
      state.ledger.findings.push(
        makeResolveFinding(
          RESOLVE_REASON.RESOLVE_RELOCATION_OPTIONS_NONE,
          `game "${gameId}" (${trigger}): ${entry.candidatesConsidered} cross-venue candidate slot(s) on ${game.date} were examined and none is free, team-clean and clear of the rule gate`,
          details
        )
      );
    } else {
      state.ledger.findings.push(
        makeResolveFinding(
          RESOLVE_REASON.RESOLVE_RELOCATION_OPTIONS_OFFERED,
          `game "${gameId}" (${trigger}): ${options.length} cross-venue option(s) offered for the operator to approve, best first — ${options.map((option) => `${slotKey(option.to)}${option.compromiseCodes.length === 0 ? '' : ` (${option.compromiseCodes.join(', ')})`}`).join('; ')}. None is applied: a venue change moves every family's travel`,
          { ...details, optionIds: options.map((option) => option.optionId) }
        )
      );
    }
  }

  /** @type {Map<string, string[]>} */
  const offeredTo = new Map();
  for (const entry of entries) {
    for (const option of entry.options) {
      const key = slotKey(option.to);
      offeredTo.set(key, [...(offeredTo.get(key) ?? []), entry.gameId]);
    }
  }
  for (const entry of entries) {
    for (const option of entry.options) {
      option.sharedWith = (offeredTo.get(slotKey(option.to)) ?? [])
        .filter((other) => other !== entry.gameId)
        .sort();
    }
  }
  return entries;
}

/**
 * `resolve/`'s judgement of a slot, for a caller that has no resolve run —
 * the scenario proposer (#53). Built from the same pieces a run is: the
 * baseline records by `recordBaselineAcceptance()`, the commitment index, the
 * weights, and {@link evaluateCandidate}. `hold()` stands a game on a slot for
 * every later question, as `change-request-apply` will once it applies the
 * proposals in the same order.
 *
 * **Every game starts where the schedule has it**, displaced ones included.
 * That is what `change-request-apply` sees when it judges the proposals in
 * order — a displaced game not yet moved still stands on its withdrawn slot —
 * so the proposer and the backstop give the same answer. It is conservative: a
 * coach's other displaced game still counts at its old time until it is held
 * somewhere else.
 *
 * @param {Object} input
 * @param {{ games: ReadonlyArray<Object>, commitments?: ReadonlyArray<Object> }} input.schedule
 * @param {Object} input.engines - the branch's engines
 * @param {Record<string, number>} [input.objectiveWeights]
 * @returns {{ evaluate: (gameId: string, slot: import('./types.js').Slot) => ReturnType<typeof evaluateCandidate>, hold: (gameId: string, slot: import('./types.js').Slot) => void }}
 */
export function createPlacementProbe(input) {
  const games = input.schedule.games.map((game) => ({ ...game, id: String(game.id) }));
  /** @type {Record<string, string>} */
  const venueBySurfaceId = {};
  for (const surface of Object.values(input.engines.graph.surfaces)) {
    venueBySurfaceId[/** @type {any} */ (surface).id] = /** @type {any} */ (surface).venueId;
  }
  for (const game of games) venueBySurfaceId[game.surfaceId] ??= game.venueId;
  const baseline = Object.fromEntries(games.map((game) => [game.id, Object.freeze(game)]));
  const state = /** @type {any} */ ({
    baseline,
    games: { ...baseline },
    gameIds: games.map((game) => game.id),
    inventory: { venueBySurfaceId },
    unplaced: [],
  });
  const context = {
    ...resolveContextDefaults(),
    engines: input.engines,
    weights: resolveObjectiveWeights(input.objectiveWeights),
    commitmentIndex: indexCommitments(input.schedule.commitments ?? []),
  };
  for (const gameId of state.gameIds) recordBaselineAcceptance(context, state, gameId);
  return {
    evaluate: (gameId, slot) =>
      evaluateCandidate(context, state, gameId, slot, publishedSlotOf(baseline[gameId])),
    hold: (gameId, slot) => {
      if (baseline[gameId] === undefined) {
        throw new Error(`resolve: the probe holds no game "${gameId}"`);
      }
      state.games[gameId] = gameOnSlot(state, gameId, slot);
    },
  };
}
