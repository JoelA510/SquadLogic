/**
 * **The placer's second question: does this slot break a blocking rule the
 * facility model cannot see?** (#59)
 *
 * `checkPlacement()` answers facility legality and nothing else, by design.
 * Two blocking-severity rules of the standing rule engine can nonetheless be
 * judged per candidate slot, and until #59 nothing asked them before a game
 * was placed:
 *
 * - `TRAVEL_COMMITMENTS_OVERLAP` — a coach committed to two things at once.
 *   Compromise since #61 (the operator allows it with a warning, and prefers
 *   to avoid it), fixed against records. Gated by code: refused in
 *   `chooseSlot()`'s pass 1, admitted as a last resort in pass 2.
 * - `TURNOVER_BELOW_MINIMUM` — two consecutive games on one surface closer than
 *   the turnover floor. Blocking under the season's `TURNOVER_FLOOR_GLOBAL`
 *   (HARD).
 *
 * Measured over 679 displacement runs on the corpus before this module
 * existed, `verify` reported 148 overlaps and 60 turnover shortfalls the runs
 * introduced; 56 of the overlaps were the solver's own placement of a displaced
 * game, reported `allowed` apart from the verify finding.
 *
 * ## What this is, and deliberately is not
 *
 * **It gates the placer only** — where `chooseSlot()` may put a game it is
 * already moving. It is not read by `dislodge`, `local-search` or
 * `pair-repair`, so it never decides that a standing game must move, and never
 * lifts the coach's *other* game: that game may be at another venue, which the
 * placer cannot re-home it to, and lifting it is how PR 1 measured 21 published
 * kickoffs destroyed for nothing. It also leaves a requested move exactly as it
 * was: whether a request that double-books a coach should be displaced,
 * refused, or allowed with a finding is the operator's question, not this
 * module's.
 *
 * **It asks the rule engine's own evaluators**, `evaluateCoachTravel()` and
 * `turnoverMinimumRule.evaluate()`, over the smallest input that can change —
 * the moving game's coaches on that date, and the games on that surface that
 * date — so the gate and `verify` cannot disagree about what a breach is.
 * Waivers are not consulted: an overlap cannot be waived, and a waived turnover
 * would be refused here while `verify` accepts it. Stated rather than hidden.
 *
 * **Instances are keyed by the unordered pair of games**, not by the rule
 * engine's consecutive-pair subject. Reordering a coach's day re-pairs an
 * unchanged overlap, and a subject-keyed instance would read that as new.
 *
 * @module resolve/ruleGate
 */

import { CONSTRAINT_SEVERITY } from '../constraints/reasonCodes.js';
import { RULE_VIOLATION_REASON } from '../ruleEngine/reasonCodes.js';
import { turnoverMinimumRule } from '../ruleEngine/rules.js';
import { TRAVEL_REASON, evaluateCoachTravel } from '../waivers/coachTravel.js';

/**
 * The rule-engine codes the placer refuses to introduce. Read by
 * {@link ruleGateInstances} as its filter, so the list and the gate cannot drift.
 *
 * @type {ReadonlyArray<string>}
 */
export const GATED_RULE_CODES = Object.freeze([
  TRAVEL_REASON.TRAVEL_COMMITMENTS_OVERLAP,
  RULE_VIOLATION_REASON.TURNOVER_BELOW_MINIMUM,
]);

/**
 * Where a commitment stands in `state`. **The one projection**: `verify`
 * (`resolvedScheduleOf()`) and the gate both come through here, so the two
 * cannot place a coach in different places.
 *
 * A commitment to a game this run holds follows the game, keeping its own
 * length; one whose game has no time is `null`; one naming no game this run
 * holds — a scrimmage, a reservation, an external window — passes through.
 *
 * @param {Object} commitment
 * @param {import('./types.js').ResolveState} state
 * @param {{ gameId: string, slot: import('./types.js').Slot }|null} [override] -
 *   stand this one game on a candidate slot instead of where `state` has it
 * @returns {Object|null}
 */
export function projectCommitment(commitment, state, override = null) {
  const gameId = commitment.gameId;
  if (typeof gameId !== 'string' || state.baseline[gameId] === undefined) return commitment;
  const game =
    override !== null && override.gameId === gameId
      ? gameOnSlot(state, gameId, override.slot)
      : state.games[gameId];
  if (game === undefined) return null;
  const occupancy =
    commitment.endMinutes === null ? null : commitment.endMinutes - commitment.startMinutes;
  return {
    ...commitment,
    date: game.date,
    startMinutes: game.startMinutes,
    endMinutes: occupancy === null ? null : game.startMinutes + occupancy,
    venueId: game.venueId,
    surfaceId: game.surfaceId,
  };
}

/**
 * The game as it would stand on `slot` — built exactly as `applyMove()` in
 * `state.js` builds it: the venue from the inventory, the footprint carried
 * over, and an unknown footprint left unknown rather than invented.
 *
 * @param {import('./types.js').ResolveState} state
 * @param {string} gameId
 * @param {import('./types.js').Slot} slot
 * @returns {Object}
 */
export function gameOnSlot(state, gameId, slot) {
  const baseline = state.baseline[gameId];
  const occupancy =
    baseline.endMinutes === null ? null : baseline.endMinutes - baseline.startMinutes;
  return {
    ...baseline,
    date: slot.date,
    surfaceId: slot.surfaceId,
    venueId: state.inventory.venueBySurfaceId[slot.surfaceId] ?? baseline.venueId,
    startMinutes: slot.startMinutes,
    endMinutes: occupancy === null ? null : slot.startMinutes + occupancy,
  };
}

/**
 * The commitments indexed the two ways the gate reads them.
 *
 * @param {ReadonlyArray<Object>} commitments
 * @returns {{ byPerson: Map<string, Object[]>, personsByGame: Map<string, string[]>, count: number }}
 */
export function indexCommitments(commitments) {
  /** @type {Map<string, Object[]>} */
  const byPerson = new Map();
  /** @type {Map<string, Set<string>>} */
  const persons = new Map();
  for (const commitment of commitments) {
    if (!byPerson.has(commitment.personId)) byPerson.set(commitment.personId, []);
    /** @type {Object[]} */ (byPerson.get(commitment.personId)).push(commitment);
    if (typeof commitment.gameId === 'string') {
      if (!persons.has(commitment.gameId)) persons.set(commitment.gameId, new Set());
      /** @type {Set<string>} */ (persons.get(commitment.gameId)).add(commitment.personId);
    }
  }
  /** @type {Map<string, string[]>} */
  const personsByGame = new Map();
  for (const [gameId, ids] of persons) personsByGame.set(gameId, [...ids].sort());
  return { byPerson, personsByGame, count: commitments.length };
}

/**
 * The gated rule-engine instances `gameId` would carry on `slot`, keyed
 * `CODE|otherGameId` — the unordered pair, read from this game's side.
 *
 * @param {{ engines: Object, commitmentIndex: ReturnType<typeof indexCommitments> }} context
 * @param {import('./types.js').ResolveState} state
 * @param {string} gameId
 * @param {import('./types.js').Slot} slot
 * @param {{ turnover?: boolean }} [options] - `turnover: false` asks about coaches only
 * @returns {{ instances: Record<string, number>, overlaps: Array<{ key: string, personId: string, otherId: string, teamId: string|null, otherTeamId: string|null }>, meta: { coachCommitmentsExamined: number, surfacePairsExamined: number } }}
 */
export function ruleGateInstances(context, state, gameId, slot, options = {}) {
  /** @type {Record<string, number>} */
  const instances = {};
  const meta = { coachCommitmentsExamined: 0, surfacePairsExamined: 0 };
  /** @type {Array<{ key: string, personId: string, otherId: string, teamId: string|null, otherTeamId: string|null }>} */
  const overlaps = [];
  const add = (code, other) => {
    const key = `${code}|${other}`;
    instances[key] = (instances[key] ?? 0) + 1;
  };

  // -- a coach in two places ------------------------------------------------
  //
  // **Pairwise, not consecutive.** `evaluateCoachTravel()` compares each
  // commitment only with the next one in the coach's day, so a long commitment
  // with a short one inside it hides an overlap with anything after the short
  // one. The gate asks the same evaluator about the moving game against each
  // other commitment in turn, so its *definition* of an overlap is the rule
  // engine's and its *coverage* is every pair. `verify` keeps the consecutive
  // blind spot; that is the rule engine's to fix, and filed.
  const index = context.commitmentIndex;
  const persons = index.personsByGame.get(gameId) ?? [];
  if (persons.length > 0) {
    const override = { gameId, slot };
    const options = {
      registry: context.engines.registry,
      ...(context.engines.resources?.venueComplexes
        ? { venueComplexes: context.engines.resources.venueComplexes }
        : {}),
    };
    for (const personId of persons) {
      /** @type {Object[]} */
      const day = [];
      for (const commitment of index.byPerson.get(personId) ?? []) {
        const projected = projectCommitment(commitment, state, override);
        if (projected !== null && projected.date === slot.date) day.push(projected);
      }
      meta.coachCommitmentsExamined += day.length;
      const mine = day.filter((commitment) => commitment.gameId === gameId);
      for (const own of mine) {
        for (const other of day) {
          if (other.gameId === gameId) continue;
          const travel = evaluateCoachTravel([own, other], options);
          for (const subject of travel.subjects) {
            for (const finding of subject.findings) {
              if (!GATED_RULE_CODES.includes(finding.code)) continue;
              // Any severity: the overlap is gated by *code*. Since #61 it is
              // compromise, and the placer still avoids it (pass 1) before it
              // accepts one (pass 2); turnover below stays blocking-gated.
              const otherId = other.gameId ?? `commitment:${other.id}`;
              add(finding.code, otherId);
              overlaps.push({
                key: `${finding.code}|${otherId}`,
                personId,
                otherId,
                teamId: own.teamId ?? null,
                otherTeamId: other.teamId ?? null,
              });
            }
          }
        }
      }
    }
  }

  // -- a surface turned over too fast ---------------------------------------
  // Skipped when the caller asks only about coaches (the overlap warning).
  if (options.turnover === false) return { instances, overlaps, meta };
  const candidate = gameOnSlot(state, gameId, slot);
  const games = [
    candidate,
    ...state.gameIds
      .filter((id) => id !== gameId)
      .map((id) => state.games[id])
      .filter(
        (game) => game !== undefined && game.date === slot.date && game.surfaceId === slot.surfaceId
      ),
  ];
  const turnover = turnoverMinimumRule.evaluate(
    /** @type {any} */ ({ games, commitments: [] }),
    /** @type {any} */ ({ registry: context.engines.registry, resources: {} })
  );
  meta.surfacePairsExamined = Math.max(0, games.length - 1);
  for (const subject of turnover.subjects) {
    for (const finding of subject.findings) {
      if (!GATED_RULE_CODES.includes(finding.code)) continue;
      if (finding.severity !== CONSTRAINT_SEVERITY.BLOCKING) continue;
      const { earlierGameId, laterGameId } = finding.details;
      if (earlierGameId !== gameId && laterGameId !== gameId) continue;
      add(finding.code, earlierGameId === gameId ? laterGameId : earlierGameId);
    }
  }
  return { instances, overlaps, meta };
}
