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
 * - `CONFLICT_SPREAD_EXCEEDED` (#60) — an age group's coach conflicts shared
 *   out more unevenly than `conflict-fairness` permits. Blocking under that
 *   record (HARD, `waivable: false`). Refused in **both** passes, as turnover
 *   is (operator ruling Q1). The instance is the **group**, not a pair of
 *   games — `CONFLICT_SPREAD_EXCEEDED|<groupLabel>`, valued at the group's
 *   excess over the bound — because the violation is an aggregate that names
 *   no game.
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
 * **It asks the rule engine's own evaluators**, `evaluateCoachTravel()`,
 * `turnoverMinimumRule.evaluate()` and `conflictFairnessRule.evaluate()`, over
 * the smallest input that can change — the moving game's coaches on that date,
 * the games on that surface that date, and every team (from the roster) of each
 * age group the move can touch, with every commitment of everyone on them — so
 * the gate and `verify` cannot disagree about what a breach is.
 *
 * **It honours the run's waiver ledger exactly as `runRuleEngine` does** (#62,
 * PR C). The turnover and spread subjects go through `applyWaivers()` with
 * `engines.waiverLedger` and the engine's own `constraintIdsByReasonCode()`
 * map, and only a finding still `blocking` afterwards is refused — so a slot
 * `verify` would report as waived is not refused here. Scope matching, the
 * `waivable: false` bar and the lifecycle are the applier's, not re-derived.
 * A ledger of `null` skips the applier outright, the engine's own
 * `ledger === null` contract.
 *
 * Declared, not enforced, beside that:
 *
 * - **The overlap arm does not consult the ledger.** The standing coach rule
 *   links `TRAVEL_COMMITMENTS_OVERLAP` to no constraint (`rules.js`, its
 *   `constraintIdByCode`), so no waiver reaches it in `verify` either, and the
 *   arm gates it by code at any severity. A supplied `engines.ruleEngine` that
 *   linked the code would let `verify` waive an overlap the gate still refuses
 *   in pass 1 — failing safe, witnessed in `tests/ruleGateWaivers.test.js`.
 * - **The carried-spread warning reads the same instances** (`stages.js`,
 *   `RESOLVE_CONFLICT_SPREAD_CARRIED`), so a requested move whose growth a
 *   waiver covers does not warn, and with `verify` off nothing then reports
 *   the waiver. Unreachable under the season's record (ruling Q3).
 * - **The #53 `travelCodes` are read before the ledger**, so an option can list
 *   a travel-gap code `verify` would report waived (incident 9's shape).
 * - **The applier's contract is adopted, not audited.** It lets a waiver on
 *   any waivable constraint linked to a code cover a finding raised under
 *   another — for turnover, one on the preference record would cover the
 *   floor's shortfall. No season record permits that (all are
 *   `waivable: false`); it is `applyWaivers()`'s to narrow, for both halves.
 * - **The arms read the evaluator's severity**, not the registry's
 *   per-subject re-severity `runRuleEngine` applies first (unchanged by #62).
 *
 * **Instances are keyed by the unordered pair of games**, not by the rule
 * engine's consecutive-pair subject. Reordering a coach's day re-pairs an
 * unchanged overlap, and a subject-keyed instance would read that as new. The
 * spread is the exception, keyed by group, above.
 *
 * @module resolve/ruleGate
 */

import { CONSTRAINT_SEVERITY } from '../constraints/reasonCodes.js';
import { buildStandingRuleEngine, constraintIdsByReasonCode } from '../ruleEngine/engine.js';
import { RULE_VIOLATION_REASON } from '../ruleEngine/reasonCodes.js';
import { conflictFairnessRule, turnoverMinimumRule } from '../ruleEngine/rules.js';
import { applyWaivers } from '../waivers/apply.js';
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
  RULE_VIOLATION_REASON.CONFLICT_SPREAD_EXCEEDED,
]);

/** The standing engine, built on first use by a run that supplies none. */
/** @type {ReturnType<typeof buildStandingRuleEngine>|null} */
let standingEngine = null;

/**
 * `constraintIdsByReasonCode()` per engine and registry: both are frozen for a
 * run, and the gate asks once per candidate.
 *
 * @type {WeakMap<object, WeakMap<object, Record<string, string[]>>>}
 */
const constraintIdMaps = new WeakMap();

/**
 * `subjects` as `runRuleEngine` judges them against the run's waiver ledger:
 * each with its findings after `applyWaivers()`, in the same order, keeping its
 * own `context` (the applier's results carry none).
 *
 * The engine's contract, not a third one: the ledger is `engines.waiverLedger`,
 * the one `verify` passes; the code-to-constraint map is
 * `constraintIdsByReasonCode()` over `engines.ruleEngine` (the standing engine
 * when none is supplied), the one `runRuleEngine` derives; and a ledger of
 * `null` returns `subjects` untouched, as `runRuleEngine` then skips the
 * applier. A covered blocking finding comes back `compromise` and stamped
 * `waived`; a gated finding whose constraint is `waivable: false`, or whose
 * code links to no constraint, comes back unchanged. The applier also appends
 * its own `WAIVER_*` findings to a subject it judged; the arms read gated
 * codes only, so those pass through them unread here (`verify` reports them).
 *
 * Only a subject carrying a blocking gated finding is handed to the applier —
 * the only kind the arms refuse, and application is per subject, so the rest
 * cannot change what the gate reports. The fallback for a subject the applier
 * did not return is the engine's own (`waivers.byId[subject.id] ?? subject`).
 *
 * @template {{ id: string, findings: ReadonlyArray<{ code: string, severity: string }> }} S
 * @param {Object} engines - the run's `engines`
 * @param {ReadonlyArray<S>} subjects
 * @returns {ReadonlyArray<S>}
 */
function waivedSubjects(engines, subjects) {
  const ledger = engines.waiverLedger ?? null;
  if (ledger === null) return subjects;
  const judged = subjects.filter((subject) =>
    subject.findings.some(
      (finding) =>
        GATED_RULE_CODES.includes(finding.code) && finding.severity === CONSTRAINT_SEVERITY.BLOCKING
    )
  );
  if (judged.length === 0) return subjects;
  const registry = engines.registry;
  const engine = engines.ruleEngine ?? (standingEngine ??= buildStandingRuleEngine());
  let byRegistry = constraintIdMaps.get(engine);
  if (byRegistry === undefined) {
    byRegistry = new WeakMap();
    constraintIdMaps.set(engine, byRegistry);
  }
  let constraintIdByCode = byRegistry.get(registry);
  if (constraintIdByCode === undefined) {
    constraintIdByCode = constraintIdsByReasonCode(engine, registry);
    byRegistry.set(registry, constraintIdByCode);
  }
  const applied = applyWaivers(/** @type {any} */ (judged), {
    ledger,
    registry,
    constraintIdByCode,
  });
  return subjects.map((subject) => {
    const waived = applied.byId[subject.id];
    return waived === undefined ? subject : { ...subject, findings: waived.findings };
  });
}

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
 * The commitments indexed the ways the gate reads them: by person, the persons
 * on each game, and the persons committed for each team (the spread arm, #60).
 *
 * @param {ReadonlyArray<Object>} commitments
 * @returns {{ byPerson: Map<string, Object[]>, personsByGame: Map<string, string[]>, personsByTeam: Map<string, string[]>, count: number }}
 */
export function indexCommitments(commitments) {
  /** @type {Map<string, Object[]>} */
  const byPerson = new Map();
  /** @type {Map<string, Set<string>>} */
  const persons = new Map();
  /** @type {Map<string, Set<string>>} */
  const teamPersons = new Map();
  for (const commitment of commitments) {
    if (!byPerson.has(commitment.personId)) byPerson.set(commitment.personId, []);
    /** @type {Object[]} */ (byPerson.get(commitment.personId)).push(commitment);
    if (typeof commitment.gameId === 'string') {
      if (!persons.has(commitment.gameId)) persons.set(commitment.gameId, new Set());
      /** @type {Set<string>} */ (persons.get(commitment.gameId)).add(commitment.personId);
    }
    if (typeof commitment.teamId === 'string') {
      if (!teamPersons.has(commitment.teamId)) teamPersons.set(commitment.teamId, new Set());
      /** @type {Set<string>} */ (teamPersons.get(commitment.teamId)).add(commitment.personId);
    }
  }
  /** @type {Map<string, string[]>} */
  const personsByGame = new Map();
  for (const [gameId, ids] of persons) personsByGame.set(gameId, [...ids].sort());
  /** @type {Map<string, string[]>} */
  const personsByTeam = new Map();
  for (const [teamId, ids] of teamPersons) personsByTeam.set(teamId, [...ids].sort());
  return { byPerson, personsByGame, personsByTeam, count: commitments.length };
}

/**
 * The schedule's teams, indexed for the spread arm (#60): each by id, and each
 * age group's teams **from the team records** — the roster — never from the
 * commitments or the games. A team with no commitment at all still stands in
 * its group with nought conflicts, and that nought is the group's minimum; a
 * universe read from the commitments would drop it exactly when it matters
 * (incident 4's shape).
 *
 * @param {ReadonlyArray<{ id: string, groupLabel?: string|null, personIds?: ReadonlyArray<string> }>} teams
 * @returns {{ byId: Map<string, { id: string, groupLabel: string|null, personIds: string[] }>, byGroup: Map<string, Array<{ id: string, groupLabel: string|null, personIds: string[] }>> }}
 */
export function indexTeams(teams) {
  const byId = new Map();
  const byGroup = new Map();
  for (const source of teams) {
    const team = {
      id: source.id,
      groupLabel: source.groupLabel ?? null,
      personIds: [...(source.personIds ?? [])],
    };
    byId.set(team.id, team);
    if (team.groupLabel === null) continue;
    if (!byGroup.has(team.groupLabel)) byGroup.set(team.groupLabel, []);
    byGroup.get(team.groupLabel).push(team);
  }
  return { byId, byGroup };
}

/**
 * The age groups whose coach-conflict spread moving `gameId` can change.
 *
 * A conflict is counted for **both** teams of an overlapping pair, so the move
 * reaches the group of every team any of the game's coaches is committed for —
 * the moving game's own side and the far side of every overlap it can make or
 * unmake. Nothing else: a move changes a count only through a commitment to
 * the game, so the game's home and away labels add no group that could change.
 *
 * @param {{ commitmentIndex: ReturnType<typeof indexCommitments>, teamIndex?: ReturnType<typeof indexTeams> }} context
 * @param {string} gameId
 * @returns {string[]}
 */
export function spreadGroupsTouchedBy(context, gameId) {
  const teams = context.teamIndex;
  if (teams === undefined) return [];
  /** @type {Set<string>} */
  const groups = new Set();
  const note = (teamId) => {
    const group = typeof teamId === 'string' ? (teams.byId.get(teamId)?.groupLabel ?? null) : null;
    if (group !== null) groups.add(group);
  };
  const index = context.commitmentIndex;
  for (const personId of index.personsByGame.get(gameId) ?? []) {
    for (const commitment of index.byPerson.get(personId) ?? []) note(commitment.teamId);
  }
  return [...groups].sort();
}

/**
 * The spread instances `groups` carry with the schedule as `state` has it, or
 * with one game stood on a candidate slot: `CONFLICT_SPREAD_EXCEEDED|<group>`,
 * valued at the group's **excess** over the permitted spread. Counts, not
 * presence: pushing an already-over group further is growth.
 *
 * Asks `conflictFairnessRule.evaluate()` itself, over every team of those
 * groups (from {@link indexTeams}) and every commitment of every person
 * rostered on or committed for them, each through {@link projectCommitment} —
 * the projection `verify` uses. A team's count comes only from pairs one of
 * whose sides names it, and every such pair belongs to a person included here,
 * so each group's spread is the one the standing rule engine computes.
 * Blocking findings only, as the turnover arm, and read after the run's waiver
 * ledger ({@link waivedSubjects}): under the season's record the spread is
 * HARD and unwaivable.
 *
 * @param {{ engines: Object, commitmentIndex: ReturnType<typeof indexCommitments>, teamIndex?: ReturnType<typeof indexTeams> }} context
 * @param {import('./types.js').ResolveState} state
 * @param {ReadonlyArray<string>} groups
 * @param {{ gameId: string, slot: import('./types.js').Slot }|null} [override]
 * @returns {{ instances: Record<string, number>, subjects: Array<{ key: string, groupLabel: string, teamIds: string[], spread: number, maxSpread: number, minConflicts: number, maxConflicts: number }>, meta: { groupsExamined: number } }}
 */
export function conflictSpreadInstances(context, state, groups, override = null) {
  /** @type {Record<string, number>} */
  const instances = {};
  /** @type {Array<{ key: string, groupLabel: string, teamIds: string[], spread: number, maxSpread: number, minConflicts: number, maxConflicts: number }>} */
  const subjects = [];
  const meta = { groupsExamined: 0 };
  const teamIndex = context.teamIndex;
  if (teamIndex === undefined || groups.length === 0) return { instances, subjects, meta };
  const index = context.commitmentIndex;
  const teams = [];
  /** @type {Set<string>} */
  const persons = new Set();
  for (const group of [...new Set(groups)].sort()) {
    for (const team of teamIndex.byGroup.get(group) ?? []) {
      teams.push(team);
      for (const personId of team.personIds) persons.add(personId);
      for (const personId of index.personsByTeam?.get(team.id) ?? []) persons.add(personId);
    }
  }
  const commitments = [];
  for (const personId of [...persons].sort()) {
    for (const commitment of index.byPerson.get(personId) ?? []) {
      const projected = projectCommitment(commitment, state, override);
      if (projected !== null) commitments.push(projected);
    }
  }
  const result = conflictFairnessRule.evaluate(
    /** @type {any} */ ({ games: [], teams, commitments }),
    /** @type {any} */ ({ registry: context.engines.registry, resources: {} })
  );
  meta.groupsExamined = result.counters.groupsExamined;
  // **Loud, not silent (plan §1.3 step 7).** The rule must have examined every
  // group asked about; fewer means a spread went unjudged — a group label the
  // roster index does not hold, so no team of it reached the rule — and a gate
  // reporting "nothing grew" over a group it never examined is the falsely
  // clean result this repository keeps finding. The stages only ask about
  // labels read from the index itself; an exported caller may ask about any.
  const asked = new Set(groups).size;
  if (meta.groupsExamined !== asked) {
    throw new Error(
      `resolve: the spread gate asked about ${asked} age group(s) and the fairness rule examined ${meta.groupsExamined}; refusing to report an unexamined group as within the bound`
    );
  }
  // Through the ledger before the severity is read: a spread a waiver covers is
  // `compromise` in `verify`, so it is not refused here. Under the season's
  // record none can be (`conflict-fairness` is `waivable: false`, operator
  // ruling Q3).
  for (const subject of waivedSubjects(context.engines, result.subjects)) {
    for (const finding of subject.findings) {
      if (finding.code !== RULE_VIOLATION_REASON.CONFLICT_SPREAD_EXCEEDED) continue;
      if (finding.severity !== CONSTRAINT_SEVERITY.BLOCKING) continue;
      const { groupLabel, spread, maxSpread, minConflicts, maxConflicts } = /** @type {any} */ (
        finding.details
      );
      const key = `${finding.code}|${groupLabel}`;
      instances[key] = spread - maxSpread;
      subjects.push({
        key,
        groupLabel,
        teamIds: [.../** @type {any} */ (subject.context).teamIds],
        spread,
        maxSpread,
        minConflicts,
        maxConflicts,
      });
    }
  }
  return { instances, subjects, meta };
}

/**
 * The gated rule-engine instances `gameId` would carry on `slot`, keyed
 * `CODE|otherGameId` — the unordered pair, read from this game's side.
 *
 * The spread arm (#60) adds `CONFLICT_SPREAD_EXCEEDED|<groupLabel>` keys, one
 * per touched group over the bound, valued at its excess (see
 * {@link conflictSpreadInstances}).
 *
 * @param {{ engines: Object, commitmentIndex: ReturnType<typeof indexCommitments>, teamIndex?: ReturnType<typeof indexTeams> }} context
 * @param {import('./types.js').ResolveState} state
 * @param {string} gameId
 * @param {import('./types.js').Slot} slot
 * @param {{ turnover?: boolean, spread?: boolean, travelCodes?: boolean }} [options] - `turnover: false` skips the surface; `spread: false` skips the age groups; `travelCodes: true` also returns the non-gated travel compromise codes the moving game would carry
 * @returns {{ travelCodes: string[], instances: Record<string, number>, overlaps: Array<{ key: string, personId: string, otherId: string, teamId: string|null, otherTeamId: string|null }>, meta: { coachCommitmentsExamined: number, surfacePairsExamined: number, groupsExamined: number } }}
 */
export function ruleGateInstances(context, state, gameId, slot, options = {}) {
  /** @type {Record<string, number>} */
  const instances = {};
  const meta = { coachCommitmentsExamined: 0, surfacePairsExamined: 0, groupsExamined: 0 };
  /** @type {Array<{ key: string, personId: string, otherId: string, teamId: string|null, otherTeamId: string|null }>} */
  const overlaps = [];
  // **Travel compromises, collected on request (#53).** A cross-venue option
  // makes a too-short journey between venues far more likely than a same-venue
  // re-placement does, and an operator approving a venue change should be
  // shown it. Collected from the same evaluator calls, never gated.
  const collectTravel = options.travelCodes === true;
  /** @type {Set<string>} */
  const travelCodes = new Set();
  const add = (code, other) => {
    const key = `${code}|${other}`;
    instances[key] = (instances[key] ?? 0) + 1;
  };

  // -- a coach in two places ------------------------------------------------
  //
  // **Pairwise, not consecutive.** A long commitment with a short one inside
  // it overlaps anything after the short one, and a neighbour-only scan never
  // sets those two side by side. The gate asks the same evaluator about the
  // moving game against each other commitment in turn, so its *definition* of
  // an overlap is the rule engine's and its *coverage* is every pair. Since
  // #62 `evaluateCoachTravel()` judges overlap over every pair too, so for
  // overlap `verify` and the gate cover the same pairs. The gap floors differ:
  // `verify` judges them on neighbours only, while each bare pair here is its
  // own neighbour, so a non-neighbour's floor code can reach `travelCodes`
  // (#53) that `verify` never reports. This loop still asks one pair at a
  // time, which is what keys an instance by the other game.
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
              if (!GATED_RULE_CODES.includes(finding.code)) {
                if (collectTravel && finding.severity !== CONSTRAINT_SEVERITY.INFO) {
                  travelCodes.add(finding.code);
                }
                continue;
              }
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

  // -- an age group's conflicts shared too unevenly (#60) --------------------
  // Skipped by the overlap warning and by the per-game baseline record: the
  // spread belongs to a group, not to a game's slot, so its baseline is
  // recorded once per group (`recordBaselineSpread()` in `stages.js`).
  if (options.spread !== false) {
    const spread = conflictSpreadInstances(context, state, spreadGroupsTouchedBy(context, gameId), {
      gameId,
      slot,
    });
    meta.groupsExamined = spread.meta.groupsExamined;
    Object.assign(instances, spread.instances);
  }

  // -- a surface turned over too fast ---------------------------------------
  // Skipped when the caller asks only about coaches (the overlap warning).
  if (options.turnover === false) {
    return { instances, overlaps, meta, travelCodes: [...travelCodes].sort() };
  }
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
  // Through the ledger, as the spread arm: only a shortfall still blocking
  // after application is refused.
  for (const subject of waivedSubjects(context.engines, turnover.subjects)) {
    for (const finding of subject.findings) {
      if (!GATED_RULE_CODES.includes(finding.code)) continue;
      if (finding.severity !== CONSTRAINT_SEVERITY.BLOCKING) continue;
      const { earlierGameId, laterGameId } = finding.details;
      if (earlierGameId !== gameId && laterGameId !== gameId) continue;
      add(finding.code, earlierGameId === gameId ? laterGameId : earlierGameId);
    }
  }
  return { instances, overlaps, meta, travelCodes: [...travelCodes].sort() };
}
