/**
 * **Deriving a branch, and promoting one.**
 *
 * A {@link import('./types.js').ScenarioResult} is *lazily evaluated with a
 * fingerprinted memo*, and everything about that phrase is deliberate:
 *
 * - **Not a stored schedule.** That is the source project's failure verbatim —
 *   five hand-built duplicates of the whole pipeline, separately verified,
 *   impossible to keep in sync.
 * - **Not a stored diff.** A diff is only meaningful against the baseline it
 *   was computed from, so a constraint fixed in the baseline leaves every
 *   stored diff describing a schedule that no longer exists. A stored diff also
 *   cannot answer *"which constraints break"*, because breakage is a property
 *   of the result rather than of the edit.
 * - **A fingerprinted memo**, so re-deriving is cheap and a stale read is
 *   refused rather than served. The fingerprint is a structural digest over the
 *   base record arrays plus the override list — never over scenario metadata.
 *
 * ## The four steps, and which machinery each one is
 *
 * | step | machinery |
 * | --- | --- |
 * | which games the branch displaces | `runRuleEngine()` twice, and the difference |
 * | where they could go instead | `proposeRelocations()` — **proposed, not solved** |
 * | applying that | `applyChangeRequest()`, maximum freeze around the displaced set |
 * | what has nowhere to go | `createResolveState()` + `applyMove(TIME_TBD)` + `unplacedFromResolveRun()` |
 *
 * The last row is the interesting one. The shelving is a **second, explicit
 * step after the re-solve**, not something the pipeline did, and it goes
 * through `applyMove()` — the one writer — so the games it shelves are
 * ledgered, judged against a freeze, and projected back into a schedule by
 * `resolvedScheduleOf()`, commitments and all. Doing it in the scenario layer
 * rather than inside the run is what keeps the report honest: the solver did
 * not decide these games were unplaceable, the branch did.
 *
 * @module scenario/run
 */

import { FREEZE_DISPOSITION } from '../freeze/reasonCodes.js';
import { freezeAllExcept } from '../freeze/plan.js';
import { runRuleEngine } from '../ruleEngine/engine.js';
import { registryConstraintIdsFor } from '../resolve/errors.js';
import { resolveObjectiveWeights } from '../resolve/objective.js';
import { applyChangeRequest, resolvedScheduleOf } from '../resolve/resolve.js';
import { createPlacementProbe } from '../resolve/relocationOptions.js';
import { RESOLVE_REASON } from '../resolve/reasonCodes.js';
import { CHANGE_ORIGIN } from '../resolve/schemas.js';
import { buildSlotInventory } from '../resolve/inventory.js';
import {
  MOVE_KIND,
  applyMove,
  createResolveLedger,
  createResolveState,
  mayMove,
} from '../resolve/state.js';
import { CONSTRAINT_SEVERITY } from '../constraints/reasonCodes.js';
import { buildWaiverLedger } from '../waivers/ledger.js';
import { accountForFixtures, unplacedFromResolveRun } from '../reserve/unplaced.js';
import { makePublicationSnapshot } from '../publication/snapshot.js';
import { naiveDateTime } from '../reserve/publication.js';
import { PUBLICATION_TBD } from '../reserve/reasonCodes.js';

import { diffScenarios } from './diff.js';
import { recordDigest, withRecords } from './inputs.js';
import { proposeRelocations } from './relocation.js';
import {
  RELOCATION_RANKING,
  SCENARIO_REASON,
  SCENARIO_RECORD_SET,
  createScenarioMeta,
  deriveScenarioStatus,
  makeScenarioFinding,
  mergeScenarioMeta,
} from './reasonCodes.js';
import {
  ancestryProblem,
  composedOverrides,
  materialiseScenario,
  scenarioFingerprint,
} from './scenario.js';

/** The stage id the shelving step signs its writes with. */
export const SCENARIO_SHELVE_STAGE_ID = 'scenario-shelve-unplaceable';

/** How many example ids an aggregate finding carries. */
const EXAMPLE_LIMIT = 5;

/** The column vocabulary the recorded diff is snapshotted in. */
export const PROMOTION_DIFF_COLUMNS = Object.freeze([
  'bucket',
  'gameId',
  'label',
  'changedFields',
  'before',
  'after',
]);

/**
 * One diff row, in the promotion snapshot's vocabulary.
 *
 * Times go through `naiveDateTime()` — `reserve/publication.js`'s, the only
 * GAP-30-safe formatter in this repository — so a promoted record cannot carry
 * a wall-clock time reinterpreted in the host timezone.
 *
 * @param {import('../resolve/types.js').ScheduleChange} change
 * @returns {Record<string, string>}
 */
function diffRow(change) {
  const at = (slot) =>
    slot === null
      ? `${PUBLICATION_TBD.TIME} / ${PUBLICATION_TBD.LOCATION}`
      : `${naiveDateTime(slot.date, slot.startMinutes, PUBLICATION_TBD.TIME)} ${slot.surfaceId}`;
  return {
    gameId: change.gameId,
    label: change.label,
    changedFields: change.changedFields.join(', '),
    before: at(change.before),
    after: at(change.after),
  };
}

/**
 * The game a rule violation is about, or null.
 *
 * Read from the violation's own `entities`, which every rule fills in from the
 * row it examined. Not parsed out of `subjectId`, which is a rule-scoped key
 * whose spelling is the rule's business.
 *
 * @param {Object} violation
 * @returns {string|null}
 */
function gameIdOf(violation) {
  for (const entity of violation.entities ?? []) {
    if (entity.kind === 'game') return String(entity.id);
  }
  return null;
}

/**
 * Blocking violations by `${code}|${gameId}`, counted.
 *
 * @param {Object|null} verification
 * @returns {Map<string, number>}
 */
function blockingByGame(verification) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const violation of verification?.violations ?? []) {
    if (violation.severity !== CONSTRAINT_SEVERITY.BLOCKING) continue;
    const gameId = gameIdOf(violation);
    if (gameId === null) continue;
    const key = `${violation.code}|${gameId}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/**
 * **Which games the branch displaces**, and which codes it introduced for each.
 *
 * Derived from two `runRuleEngine()` passes — the baseline's engines and the
 * branch's — and from the difference between them. Deliberately *not* from a
 * third opinion about legality: the rule engine is what the rest of the system
 * is judged by, and a scenario that used a private definition of "displaced"
 * could report a game as displaced that every other report calls fine.
 *
 * **Counts, not presence**, exactly as `newBlockingCodes()` in
 * `resolve/stages.js`: a game already breaking a code once and breaking it
 * twice under the branch has the same code *set* in both places.
 *
 * @param {Object} input
 * @param {import('../ruleEngine/types.js').Schedule} input.schedule
 * @param {Object} input.baselineVerification
 * @param {Object} input.scenarioVerification
 * @param {Object} input.registry - the branch's, for the constraint ids
 * @returns {import('./types.js').DisplacedGame[]}
 */
export function scenarioDisplacements(input) {
  const before = blockingByGame(input.baselineVerification);
  const after = blockingByGame(input.scenarioVerification);
  /** @type {Map<string, string[]>} */
  const grown = new Map();
  for (const [key, count] of after) {
    if (count <= (before.get(key) ?? 0)) continue;
    const separator = key.indexOf('|');
    const code = key.slice(0, separator);
    const gameId = key.slice(separator + 1);
    const bucket = grown.get(gameId) ?? [];
    bucket.push(code);
    grown.set(gameId, bucket);
  }

  const byId = new Map(input.schedule.games.map((game) => [String(game.id), game]));
  /** @type {import('./types.js').DisplacedGame[]} */
  const displaced = [];
  for (const [gameId, codes] of grown) {
    const game = byId.get(gameId);
    if (!game) continue;
    const sorted = [...new Set(codes)].sort();
    displaced.push({
      gameId,
      label: `${game.homeLabel} v ${game.awayLabel}`,
      date: game.date,
      venueId: game.venueId,
      surfaceId: game.surfaceId,
      startMinutes: game.startMinutes,
      format: game.format,
      codes: Object.freeze(sorted),
      constraintIds: Object.freeze(registryConstraintIdsFor(input.registry, sorted)),
    });
  }
  displaced.sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      a.startMinutes - b.startMinutes ||
      a.gameId.localeCompare(b.gameId)
  );
  return displaced;
}

/**
 * Shelve the games the branch leaves nowhere to go, through the one writer.
 *
 * Builds a real `ResolveState` over the schedule as it stands, freezes every
 * game the caller did **not** name — so `mayMove()` refuses anything else, and
 * a mistake here is a refusal rather than a silent extra shelving — and moves
 * each named game to TIME TBD with the cause the branch computed.
 *
 * **An entry naming a game the schedule no longer holds is reported, never
 * skipped.** It used to be a bare `continue`: no finding, no counter, nothing.
 * A game the re-solve had already dropped therefore vanished a second time
 * here, and never reached `result.unplaced` to be reconciled. `unshelvable` is
 * how the caller learns of it, and `accountForFixtures()` is where it becomes
 * `FIXTURE_DROPPED` at blocking.
 *
 * @param {import('../ruleEngine/types.js').Schedule} schedule
 * @param {ReadonlyArray<import('./types.js').UnrelocatableGame>} entries
 * @param {{ name: string, registry: Object }} context
 * @returns {{ schedule: import('../ruleEngine/types.js').Schedule, run: Object, shelved: string[], unshelvable: string[] }}
 */
export function shelveUnrelocatable(schedule, entries, context) {
  const named = new Set(entries.map((entry) => entry.gameId));
  /** @type {Record<string, string>} */
  const dispositions = {};
  for (const game of schedule.games) {
    dispositions[String(game.id)] = named.has(String(game.id))
      ? FREEZE_DISPOSITION.THAWED
      : FREEZE_DISPOSITION.FROZEN;
  }

  const ledger = createResolveLedger();
  let state = createResolveState({
    games: schedule.games,
    dispositions,
    inventory: buildSlotInventory(schedule.games),
    ledger,
  });

  /** @type {string[]} */
  const shelved = [];
  /** @type {string[]} */
  const unshelvable = [];
  for (const entry of entries) {
    if (!state.games[entry.gameId]) {
      unshelvable.push(entry.gameId);
      continue;
    }
    if (
      !mayMove(state, entry.gameId, SCENARIO_SHELVE_STAGE_ID, 'the branch leaves it nowhere to go')
    ) {
      continue;
    }
    state = applyMove(
      state,
      {
        gameId: entry.gameId,
        kind: MOVE_KIND.TIME_TBD,
        to: null,
        reason: entry.reason,
        // The cause is the **branch's own**, first hand: the blocking codes the
        // override introduced for this game and the registry constraints that
        // claim them. `unplacedFromResolveRun()` reads it from the ledger, which
        // is exactly where its own header says to look.
        cause: Object.freeze({
          kind: 'constraint',
          codes: [...entry.codes].sort().join(', '),
          constraintId: entry.constraintIds[0] ?? null,
          constraintIds: Object.freeze([...entry.constraintIds]),
          counterpartGameIds: Object.freeze([]),
          bindingKinds: Object.freeze([]),
          slackMinutes: null,
        }),
      },
      SCENARIO_SHELVE_STAGE_ID
    );
    shelved.push(entry.gameId);
  }

  return {
    schedule: resolvedScheduleOf(schedule, state),
    // The `{ name, state, moves, unplaced }` shape `unplacedFromResolveRun()`
    // reads, produced by the same `createResolveState()` / `applyMove()` writer
    // a resolve run uses. Not a forged state: the one path into TIME TBD in this
    // repository, driven from outside the pipeline.
    run: {
      name: context.name,
      state,
      moves: [...ledger.moves],
      unplaced: [...state.unplaced],
      report: null,
    },
    shelved,
    unshelvable,
  };
}

/**
 * A waiver ledger over a record set a branch may edit, or `null` for none.
 *
 * **`null` rather than an empty ledger** when there are no waivers, so the
 * rule engine behaves exactly as it did before this record set was honoured: a
 * ledger makes `runRuleEngine()` run the applier and the dormancy scan, and
 * neither has anything to say about a season with no waivers.
 *
 * @param {ReadonlyArray<Object>} waivers
 * @param {string} name
 * @returns {import('../waivers/types.js').WaiverLedger|null}
 */
function waiverLedgerFor(waivers, name) {
  if (waivers.length === 0) return null;
  return buildWaiverLedger({ name, source: name, waivers: [...waivers] });
}

/**
 * A violation set as an identity rather than a total.
 *
 * **A count is not an identity.** Vacuity used to compare
 * `verification.violations.length` on the two sides, so a branch that retyped a
 * constraint — moving its violations from one severity to another, changing
 * exactly what it was asked to change — reported the same total and was stamped
 * `SCENARIO_OVERRIDE_VACUOUS`: *"every question asked of it is answered by the
 * baseline"*. The same total can hide a complete change of composition, and
 * this is what tells the two apart.
 *
 * @param {Object|null} verification
 * @returns {string[]} sorted, one entry per violation
 */
function violationShape(verification) {
  return (verification?.violations ?? [])
    .map(
      (violation) =>
        `${violation.code}|${violation.severity}|${violation.constraintId ?? ''}|${violation.subjectId ?? ''}|${violation.waived === true ? 'waived' : 'standing'}`
    )
    .sort();
}

/**
 * Whether two violation sets are the same set, not merely the same size.
 *
 * @param {ReadonlyArray<string>} left
 * @param {ReadonlyArray<string>} right
 * @returns {boolean}
 */
function sameViolations(left, right) {
  if (left.length !== right.length) return false;
  return left.every((entry, index) => entry === right[index]);
}

/** A probe for a branch that displaces nothing: never consulted, loud if it were. */
const INERT_PROBE = Object.freeze({
  evaluate() {
    throw new Error(
      'scenario: the inert probe was consulted; a branch with no displaced game has nothing to judge'
    );
  },
  hold() {
    throw new Error(
      'scenario: the inert probe was consulted; a branch with no displaced game has nothing to judge'
    );
  },
});

/**
 * Derive a scenario's answer.
 *
 * @param {import('./types.js').SeasonInputs} inputs
 * @param {import('./types.js').ScheduleScenario} scenario
 * @param {Object} options
 * @param {Object} options.baselineEngines - the baseline's own engines, for the "what did the branch break" comparison
 * @param {Object|null} [options.baselineVerification] - a `runRuleEngine()` over the baseline; derived when absent
 * @param {Object} options.relocationPolicy - see `RelocationPolicySchema`
 * @param {{ slots: number, label: string, source: string }} options.requirement
 * @param {boolean} [options.relocations] - false runs the negative control
 * @param {ReadonlyArray<import('./types.js').ScheduleScenario>} [options.ancestry]
 * @param {Record<string, number>} [options.objectiveWeights]
 * @returns {import('./types.js').ScenarioResult}
 */
export function runScenario(inputs, scenario, options) {
  const materialised = materialiseScenario(inputs, scenario, { ancestry: options.ancestry });
  const meta = mergeScenarioMeta(createScenarioMeta(), materialised.meta);
  /** @type {import('./types.js').ScenarioFinding[]} */
  const findings = [...materialised.findings];

  const baselineSchedule = inputs.schedule;
  /**
   * The waiver ledgers, one per side, and the reason there are two.
   *
   * `waivers` is a record set a scenario override may edit, and until this it
   * was inert: no ledger was ever built, so a branch that granted or withdrew
   * an exception produced exactly the same verification as one that did not.
   * Worse, a caller who supplied a waiver-aware `baselineVerification` had it
   * compared against a waiver-*free* branch verification, and the diff read the
   * waivers' absence as something the branch had done.
   *
   * The baseline's ledger comes from `inputs.waivers` and the branch's from its
   * own effective records, so the two sides are judged under the same kind of
   * rule and a difference between them is a difference the branch made.
   */
  const baselineLedger = waiverLedgerFor(inputs.waivers, `${inputs.label} waivers`);
  const branchLedger = waiverLedgerFor(
    materialised.records[SCENARIO_RECORD_SET.WAIVERS] ?? [],
    `scenario "${scenario.id}" waivers`
  );
  /**
   * **Installed on the branch's engines, not merely held in this function.**
   *
   * `runResolve()` reads its ledger off `engines.waiverLedger`, and the engines
   * it is given here are `materialised.engines`. Holding the ledger in a local
   * meant the two rule-engine runs `runScenario()` makes itself were
   * waiver-aware while the one `applyChangeRequest()` makes *inside* the
   * re-solve was not: one branch with two pictures of the same season, and the
   * waiver-blind picture was the one that priced the objective, wrote
   * `RESOLVE_VERIFY_NEW_VIOLATION`, and reached `findings` — and therefore
   * `status` and `promoteScenario()` — through `run.findings` below. A waived
   * violation was priced at the objective's blocking rate there and at its
   * compromise rate here, for the same violation in the same run. Incident 9 is
   * a waiver that exists and does not apply; this was one that applied in half
   * the pipeline.
   *
   * The materialised bundle is built by this function three lines up and is not
   * yet held by anybody else, so this is completing its construction rather
   * than mutating a value a caller has seen.
   */
  materialised.engines.waiverLedger = branchLedger;
  /**
   * **What building the ledger found, carried rather than discarded.**
   *
   * `buildWaiverLedger()` resolves a duplicate waiver id by keeping the first
   * record and reporting `WAIVER_ID_DUPLICATE` at blocking on the ledger's own
   * `findings`. Every engine downstream is then handed a ledger that is
   * internally consistent and one waiver short, so no verification can ever
   * report it: `runRuleEngine()` forwards `applyWaivers()`'s *reconciliation*
   * findings, which are a different set from a different pass. The caller that
   * built the ledger is the only reader those findings have.
   *
   * The branch's, not the baseline's: this result is a judgement on the branch,
   * and the baseline's own record set is the baseline's to answer for.
   */
  if (branchLedger !== null) findings.push(...branchLedger.findings);
  const baselineVerification =
    options.baselineVerification ??
    runRuleEngine(baselineSchedule, {
      registry: options.baselineEngines.registry,
      resources: options.baselineEngines.resources,
      ledger: baselineLedger,
    });
  const branchVerification = runRuleEngine(baselineSchedule, {
    registry: materialised.engines.registry,
    resources: materialised.engines.resources,
    ledger: branchLedger,
  });
  meta.gamesExamined = baselineSchedule.games.length;

  const displaced = scenarioDisplacements({
    schedule: baselineSchedule,
    baselineVerification,
    scenarioVerification: branchVerification,
    registry: materialised.engines.registry,
  });
  meta.gamesDisplaced = displaced.length;

  if (displaced.length > 0) {
    const codes = [...new Set(displaced.flatMap((game) => game.codes))].sort();
    findings.push(
      makeScenarioFinding(
        SCENARIO_REASON.SCENARIO_GAME_DISPLACED,
        `the branch leaves ${displaced.length} game(s) standing where its own engines refuse them (${codes.join(', ')}) across ${[...new Set(displaced.map((g) => g.venueId))].sort().join(', ')}`,
        {
          scenarioId: scenario.id,
          displaced: displaced.length,
          codes,
          venueIds: [...new Set(displaced.map((game) => game.venueId))].sort(),
          formats: [...new Set(displaced.map((game) => game.format))].sort(),
          dates: [...new Set(displaced.map((game) => game.date))].sort(),
          exampleGameIds: displaced.slice(0, EXAMPLE_LIMIT).map((game) => game.gameId),
        }
      )
    );
  }

  const displacedIds = new Set(displaced.map((game) => game.gameId));
  const gamesById = Object.fromEntries(
    baselineSchedule.games.map((game) => [String(game.id), game])
  );
  const survivors = baselineSchedule.games.filter((game) => !displacedIds.has(String(game.id)));

  /** @type {import('./types.js').RelocationPlan} */
  let relocations;
  if (options.relocations === false) {
    // **The negative control.** Same branch, same displaced set, no search: every
    // displaced game is carried as TIME TBD naming the code the branch
    // introduced, and no replacement venue appears anywhere in the report. That
    // is what proves the replacements in the positive run came from a search.
    relocations = {
      ranking: RELOCATION_RANKING,
      surfaceIds: Object.freeze([]),
      proposals: [],
      unrelocatable: displaced.map((game) => ({
        gameId: game.gameId,
        label: game.label,
        reason: `the scenario withdraws the ground it stood on (${game.codes.join(', ')}) and the relocation proposer was switched off for this run; kept visible as TIME TBD rather than dropped (incident 10)`,
        codes: Object.freeze([...game.codes]),
        constraintIds: Object.freeze([...game.constraintIds]),
        candidatesConsidered: 0,
      })),
      capacities: [],
      findings: [
        makeScenarioFinding(
          SCENARIO_REASON.SCENARIO_RELOCATIONS_DISABLED,
          `the relocation proposer was switched off for this run, so all ${displaced.length} displaced game(s) are carried as TIME TBD and no replacement ground is named. This is the negative control for the search, not a lesser answer`,
          { scenarioId: scenario.id, displaced: displaced.length }
        ),
      ],
      status: '',
      meta: createScenarioMeta(),
    };
    relocations.status = deriveScenarioStatus(relocations.findings);
    relocations.meta.relocationsUnavailable = displaced.length;
  } else {
    relocations = proposeRelocations(materialised.engines, {
      displaced,
      survivors,
      gamesById,
      policy: options.relocationPolicy,
      requirement: options.requirement,
      // Ground the branch itself is holding. A reserved slot is a commitment,
      // and offering one as spare replacement ground would be this package
      // quietly spending it.
      reservedSlots: materialised.records[SCENARIO_RECORD_SET.RESERVED_SLOTS] ?? [],
      // `resolve/`'s own judgement of each candidate (#53): the facility
      // model, the rule gate and the objective, under the branch's engines and
      // this run's weights — the same ones the re-solve below applies them
      // under, so the proposer and `change-request-apply`'s gate agree.
      // Built only when there is something to judge: the probe records every
      // game's published slot, a full-season pass a branch that displaces
      // nothing would pay for and never read.
      probe:
        displaced.length === 0
          ? INERT_PROBE
          : createPlacementProbe({
              schedule: baselineSchedule,
              engines: materialised.engines,
              objectiveWeights: options.objectiveWeights,
            }),
    });
  }
  mergeScenarioMeta(meta, relocations.meta);
  findings.push(...relocations.findings);

  /* -- apply the proposals through the re-solver ---------------------------- */

  // **Applied here, gated, and that is not the live path's rule (#53).** On
  // the live, published schedule a cross-venue move is never applied by the
  // machine: `resolve/` offers options and an operator approves one. A branch
  // is a what-if nobody has published, and the operator's promotion of it
  // (`promoteScenario()`) is the approval of every change in it — so the
  // branch applies its proposals, but as `origin: 'proposer'`, which
  // `change-request-apply` judges by the placer's own gate before applying
  // and refuses (`RESOLVE_CHANGE_REFUSED_BY_RULES`) rather than carries. An
  // operator's move is exempt from that gate (#436, incident 3); a machine's
  // never is.
  const changes = relocations.proposals.map((proposal) => ({
    gameId: proposal.gameId,
    date: proposal.to.date,
    surfaceId: proposal.to.surfaceId,
    startMinutes: proposal.to.startMinutes,
    reason: `proposeRelocations(), ranked "${proposal.ranking}": ${proposal.grade} replacement for the withdrawn ground`,
    origin: CHANGE_ORIGIN.PROPOSER,
  }));

  const run =
    changes.length === 0
      ? null
      : applyChangeRequest({
          schedule: baselineSchedule,
          changes,
          engines: materialised.engines,
          // Maximum freeze around exactly the displaced set: nothing the branch
          // did not displace may move, so the diff cannot quietly grow.
          freeze: freezeAllExcept(
            displaced.map((game) => ({ gameId: game.gameId })),
            {
              name: `scenario "${scenario.id}"`,
              reason: 'displaced by the branch overrides',
            }
          ),
          // The proposer verified each slot against everything standing on the
          // date. `holdChanges` makes those slots facts rather than preferences,
          // so `local-search` cannot quietly drift a game off a slot the report
          // says it was proposed onto.
          holdChanges: true,
          onUnsatisfiable: 'report',
          objectiveWeights: options.objectiveWeights,
          name: `scenario "${scenario.name}"`,
        });

  const relocated = run === null ? baselineSchedule : run.schedule;
  // **The re-solve's own verdict, carried rather than discarded.** Every
  // judgement `applyChangeRequest()` reached about the branch's own changes —
  // including the new violations it verified into existence — used to end at
  // this line, invisible to `result.findings` and to `result.status`.
  if (run !== null) findings.push(...run.findings);
  /**
   * Fixtures the re-solve itself could not place.
   *
   * The first of the two mechanisms that made a game disappear: the run's
   * `unplaced` was dropped here, and `shelveUnrelocatable()` below then walked
   * past the same game because the schedule no longer held it. Read through
   * `unplacedFromResolveRun()`, the one reader of a resolve run's ledger, so
   * these fixtures carry the same cause and the same reason as any other.
   */
  const resolveUnplaced =
    run === null ? [] : unplacedFromResolveRun(run, { source: `scenario "${scenario.id}"` });

  /**
   * **Proposals `change-request-apply` refused (#53), shelved like any other
   * game with nowhere to go.** The proposer judges with the same gate, so this
   * is empty on a consistent run; when it is not, the refused game is still
   * standing on the ground the branch withdrew, and — its blocking finding
   * accepted there as published — nothing downstream would lift it. Carried
   * as TIME TBD with the refusal as its reason, never left on withdrawn ground
   * (incident 10).
   */
  const refusedIds = new Set(
    (run?.findings ?? [])
      .filter((finding) => finding.code === RESOLVE_REASON.RESOLVE_CHANGE_REFUSED_BY_RULES)
      .map((finding) => String(finding.details.gameId))
  );
  const refusedByGate = displaced
    .filter((game) => refusedIds.has(game.gameId))
    .map((game) => ({
      gameId: game.gameId,
      label: game.label,
      reason: `the scenario withdraws the ground it stood on (${game.codes.join(', ')}) and resolve/'s rule gate refused the replacement proposeRelocations() chose; kept visible as TIME TBD rather than dropped (incident 10)`,
      codes: Object.freeze([...game.codes]),
      constraintIds: Object.freeze([...game.constraintIds]),
      candidatesConsidered: 0,
    }));
  // Not relocated after all: the counters say what the branch did.
  meta.relocationsProposed -= refusedByGate.length;
  meta.relocationsUnavailable += refusedByGate.length;
  const shelving = shelveUnrelocatable(
    relocated,
    [...relocations.unrelocatable, ...refusedByGate],
    {
      name: `scenario "${scenario.name}"`,
      registry: materialised.engines.registry,
    }
  );
  const schedule = shelving.schedule;

  const shelved = unplacedFromResolveRun(shelving.run, { source: `scenario "${scenario.id}"` });
  // Both lists, by fixture id, with the shelving's own entry winning where a
  // game somehow reached both: `accountForFixtures()` reports a fixture claimed
  // twice as `FIXTURE_DOUBLE_COUNTED`, and handing it a list that already
  // double-counts would make that check about this merge rather than about the
  // run.
  /** @type {Map<string, import('../reserve/types.js').UnplacedFixture>} */
  const unplacedById = new Map();
  for (const fixture of [...resolveUnplaced, ...shelved]) {
    unplacedById.set(fixture.fixtureId, fixture);
  }
  const unplaced = [...unplacedById.values()];

  const accounting = accountForFixtures({
    // From the **baseline**, never from the result: a fixture the branch dropped
    // is exactly the record missing from the result's own output.
    expectedFixtureIds: baselineSchedule.games.map((game) => String(game.id)),
    placedFixtureIds: schedule.games.map((game) => String(game.id)),
    unplaced,
    expectedSource: inputs.label,
  });
  // **The accounting's verdict is the result's verdict.** It was being computed
  // and then stored on `result.accounting` alone, so `deriveScenarioStatus()`
  // never saw it: a branch that lost a fixture reported `ok` and
  // `promoteScenario()` would have promoted it. The whole list is carried, not
  // the blocking half — `accountForFixtures()` reconciles as one verdict, and
  // picking severities out of it is the same discarding in a smaller size.
  findings.push(...accounting.findings);

  const verification = runRuleEngine(schedule, {
    registry: materialised.engines.registry,
    resources: materialised.engines.resources,
    ledger: branchLedger,
  });

  /* -- vacuity ------------------------------------------------------------- */

  const branchShape = violationShape(verification);
  const baselineShape = violationShape(baselineVerification);
  const nothingMoved =
    displaced.length === 0 &&
    relocations.proposals.length === 0 &&
    unplaced.length === 0 &&
    sameViolations(branchShape, baselineShape);
  if (nothingMoved) {
    findings.push(
      makeScenarioFinding(
        SCENARIO_REASON.SCENARIO_OVERRIDE_VACUOUS,
        `scenario "${scenario.id}" displaced no game, proposed no relocation and left every violation standing exactly as the baseline reports it — same codes, same severities, same subjects — so every question asked of it is answered by the baseline; an override that models ground the schedule never uses reports "nothing changed" for a reason that has nothing to do with the season`,
        {
          scenarioId: scenario.id,
          overridesDeclared: materialised.meta.overridesDeclared,
          overridesApplied: materialised.meta.overridesApplied,
          recordEditsApplied: materialised.meta.recordEditsApplied,
          violations: verification.violations.length,
        }
      )
    );
  }

  return {
    scenarioId: scenario.id,
    name: scenario.name,
    fingerprint: materialised.fingerprint,
    schedule,
    baselineSchedule,
    materialised,
    displaced,
    relocations,
    run,
    unplaced,
    accounting,
    verification,
    findings,
    status: deriveScenarioStatus(findings),
    meta,
  };
}

/**
 * The run options that change the answer, digested.
 *
 * **The memo's other half of the key, and the reason it exists.** A scenario's
 * fingerprint covers the inputs and the overrides — the *branch*. It says
 * nothing about the *question*, and the negative control differs from the
 * acceptance run by exactly one run option. Keyed on the branch alone, the memo
 * served whichever of the two was asked for first: the control's nought
 * proposals returned as the searched answer, or the searched answer returned as
 * the control, and either way the evidence the report rests on is invalid while
 * looking entirely well-formed.
 *
 * Every option the derivation reads is here. `baselineVerification` is included
 * as its own violation shape rather than by reference, because two callers can
 * hand the same branch two different pictures of the baseline and the displaced
 * set is the difference between them. `baselineEngines` is deliberately *not*
 * digested: it is a set of built engines rather than records, and the honest
 * check on it is the fingerprint over `inputs`, which those engines are built
 * from.
 *
 * @param {Object} options - as {@link runScenario}
 * @returns {string} 16 lowercase hex characters
 */
export function runOptionsFingerprint(options) {
  const policy = options.relocationPolicy ?? null;
  return recordDigest(
    {
      question: [
        {
          relocations: options.relocations === false ? 'off' : 'on',
          policy:
            policy === null
              ? null
              : {
                  surfaceIds: [...(policy.surfaceIds ?? [])].sort(),
                  cadenceMinutes: policy.cadenceMinutes ?? null,
                  earliestKickoffMinutes: policy.earliestKickoffMinutes ?? null,
                  latestKickoffMinutes: policy.latestKickoffMinutes ?? null,
                  source: policy.source ?? null,
                },
          requirement: options.requirement ?? null,
          objectiveWeights: options.objectiveWeights ?? null,
          ancestryIds: (options.ancestry ?? []).map((ancestor) => ancestor.id),
        },
      ],
      baseline: violationShape(options.baselineVerification ?? null).map((entry) => ({ entry })),
    },
    ['question', 'baseline']
  );
}

/**
 * **The memo.** A lazily-evaluated, fingerprinted cache of scenario results.
 *
 * Nothing is stored on a scenario, and the one thing that *is* cached is
 * checked twice over: a cached run is reused only when **the branch** still
 * digests to the fingerprint it was derived at *and* **the question** is the
 * one it answers. A caller who reads a result past the first check is told
 * `SCENARIO_RESULT_STALE` at blocking rather than served a schedule that no
 * longer exists; a caller who asks a different question is given a derivation
 * rather than somebody else's answer.
 *
 * That first promise is about the *result a caller holds*, and holds however
 * many times the branch has been resolved since — `resolve()` drops the entries
 * the branch has moved past, so the caller passes what it is holding to
 * {@link ScenarioMemo.check} rather than relying on the cache to have kept its
 * copy.
 */
export class ScenarioMemo {
  constructor() {
    /**
     * Keyed on the scenario **and the question**, never on the scenario alone.
     *
     * @type {Map<string, { scenarioId: string, options: string, result: import('./types.js').ScenarioResult }>}
     */
    this.byKey = new Map();
    this.hits = 0;
    this.misses = 0;
  }

  /**
   * Every entry cached for one scenario, whatever question it answers.
   *
   * @param {string} scenarioId
   * @returns {Array<{ scenarioId: string, options: string, result: import('./types.js').ScenarioResult }>}
   */
  entriesFor(scenarioId) {
    return [...this.byKey.values()].filter((entry) => entry.scenarioId === scenarioId);
  }

  /**
   * Derive a scenario's result, reusing a cached one only if it is still valid.
   *
   * @param {import('./types.js').SeasonInputs} inputs
   * @param {import('./types.js').ScheduleScenario} scenario
   * @param {Object} options - as {@link runScenario}
   * @returns {import('./types.js').ScenarioResult}
   */
  resolve(inputs, scenario, options) {
    const optionsFingerprint = runOptionsFingerprint(options);
    const key = `${scenario.id}\u0000${optionsFingerprint}`;
    // **The gate and the write agree on scope.** `check()` answers over *every*
    // entry the scenario has, because staleness is a property of the branch
    // rather than of one question. Gating on that while overwriting only the
    // key asked about left one stale entry for another question forcing a miss
    // for ever on a live one — and `check()` reporting blocking staleness for a
    // cache whose entries were all fresh. So a resolve that finds the branch has
    // moved forgets every entry it moved past, which is exactly the set
    // `check()` answers about when it is asked about the cache. A caller
    // holding a result the purge dropped asks `check()` about *that*, which is
    // what its `held` argument is for.
    this.forgetStale(inputs, scenario, options.ancestry ?? []);
    const cached = this.byKey.get(key);
    if (cached !== undefined) {
      this.hits += 1;
      return cached.result;
    }
    this.misses += 1;
    const result = runScenario(inputs, scenario, options);
    this.byKey.set(key, {
      scenarioId: scenario.id,
      options: optionsFingerprint,
      result,
    });
    return result;
  }

  /**
   * What the branch digests to **now**, without building its engines.
   *
   * `materialiseScenario(...).fingerprint` is the identical string — it returns
   * `scenarioFingerprint(inputs, composedOverrides(scenario, ancestry))` and a
   * test asserts the two agree — but it builds the facility graph, the timing
   * table, the availability calendar and the constraint registry on the way,
   * and every one of them is discarded here. {@link ScenarioMemo.resolve} asks
   * this on every call, so a miss was materialising the branch twice.
   *
   * @param {import('./types.js').SeasonInputs} inputs
   * @param {import('./types.js').ScheduleScenario} scenario
   * @param {ReadonlyArray<import('./types.js').ScheduleScenario>} ancestry
   * @returns {string}
   */
  fingerprintOf(inputs, scenario, ancestry) {
    return scenarioFingerprint(inputs, composedOverrides(scenario, ancestry));
  }

  /**
   * Drop every entry for a scenario whose fingerprint the branch has moved past.
   *
   * The write half of the staleness rule {@link ScenarioMemo.check} reports.
   * Nothing is dropped when there is nothing cached, and nothing is dropped
   * when the ancestry cannot be resolved — that is a caller's mistake about
   * *which* branch is being asked for, not evidence that what is cached went
   * stale, and `materialiseScenario()` refuses it a moment later anyway.
   *
   * @param {import('./types.js').SeasonInputs} inputs
   * @param {import('./types.js').ScheduleScenario} scenario
   * @param {ReadonlyArray<import('./types.js').ScheduleScenario>} ancestry
   * @returns {number} how many entries were forgotten
   */
  forgetStale(inputs, scenario, ancestry) {
    if (this.entriesFor(scenario.id).length === 0) return 0;
    if (ancestryProblem(scenario, ancestry) !== null) return 0;
    const current = this.fingerprintOf(inputs, scenario, ancestry);
    let forgotten = 0;
    for (const [entryKey, entry] of [...this.byKey]) {
      if (entry.scenarioId !== scenario.id) continue;
      if (entry.result.fingerprint === current) continue;
      this.byKey.delete(entryKey);
      forgotten += 1;
    }
    return forgotten;
  }

  /**
   * Is the result this caller is holding still the answer to what was asked?
   *
   * **Exported behaviour rather than an internal branch**, for the reason
   * `parityPartitionFindings()` is exported: a check nobody can make fail is
   * not a check. A test edits one base record and watches this fire.
   *
   * ## Who this is for
   *
   * A caller holding a `ScenarioResult` wants to know whether **their** result
   * is stale. That is not the same question as whether the cache has junk in
   * it, and conflating the two lost the guarantee this class's docstring makes:
   * `resolve()` forgets every entry the branch has moved past *before* it looks
   * one up, so after any intervening resolve of the same branch there was
   * nothing stale left to report and a caller still holding the pre-edit result
   * was told everything was fine. So a caller passes what it holds in `held`,
   * and gets `SCENARIO_RESULT_STALE` for it whether or not the memo still has
   * it. `held` is empty for a caller reconciling the cache itself, which is
   * still answered over every entry the scenario has — the memo holds an entry
   * per question and a baseline that moved invalidates all of them.
   *
   * @param {import('./types.js').SeasonInputs} inputs
   * @param {import('./types.js').ScheduleScenario} scenario
   * @param {ReadonlyArray<import('./types.js').ScheduleScenario>} [ancestry]
   * @param {ReadonlyArray<import('./types.js').ScenarioResult>} [held] - results the caller still holds
   * @returns {import('./types.js').ScenarioFinding[]}
   */
  check(inputs, scenario, ancestry = [], held = []) {
    for (const result of held) {
      if (result.scenarioId === scenario.id) continue;
      // Not a finding: a caller asking about scenario A while holding B's
      // result is a mistake about *which* branch is in hand, and answering it
      // with a staleness verdict would be this round's finding 2 one layer up —
      // one branch's answer reported under another's name.
      throw new Error(
        `scenario: ScenarioMemo.check() was asked about "${scenario.id}" and handed a held result for "${result.scenarioId}"; a result can only be stale against the branch it was derived from`
      );
    }
    const cached = this.entriesFor(scenario.id);
    if (cached.length === 0 && held.length === 0) return [];
    // **Reported, not thrown.** Every other answer this method gives is a
    // finding, and a caller reconciling a cache had to catch an exception to
    // learn it had not passed enough. `materialiseScenario()` still refuses.
    const misresolved = ancestryProblem(scenario, ancestry);
    if (misresolved !== null) {
      return [
        makeScenarioFinding(
          SCENARIO_REASON.SCENARIO_ANCESTRY_UNRESOLVED,
          `the cached result for scenario "${scenario.id}" cannot be checked: ${misresolved.message}`,
          misresolved.details
        ),
      ];
    }
    const current = this.fingerprintOf(inputs, scenario, ancestry);
    /** @type {import('./types.js').ScenarioFinding[]} */
    const findings = [];
    // One finding per stale fingerprint, not per copy of it: a caller holding
    // the entry the memo also holds has one stale answer between them.
    const stale = new Set(
      [
        ...cached.map((entry) => entry.result.fingerprint),
        ...held.map((result) => result.fingerprint),
      ].filter((fingerprint) => fingerprint !== current)
    );
    for (const fingerprint of stale) {
      findings.push(
        makeScenarioFinding(
          SCENARIO_REASON.SCENARIO_RESULT_STALE,
          `a result for scenario "${scenario.id}" was derived at fingerprint ${fingerprint} and its inputs and overrides now digest to ${current}; it describes a schedule that no longer exists and must be re-derived`,
          {
            scenarioId: scenario.id,
            cachedFingerprint: fingerprint,
            currentFingerprint: current,
          }
        )
      );
    }
    return findings;
  }
}

/**
 * **Promote a scenario to primary, with the diff recorded.**
 *
 * In memory, and it returns a record. It maintains no second registry and
 * writes no SQL. Where it wants an immutable record of what was promoted it
 * reuses `publication/snapshot.js`'s snapshot rather than building a second
 * one — which is *"do not build a parallel version"* applied to itself.
 *
 * The new primary is `withRecords()` over the branch's **effective** arrays, so
 * every set the branch did not touch is still the same object the old baseline
 * held: promotion preserves the sharing rather than forking it.
 *
 * @param {Object} input
 * @param {import('./types.js').ScenarioResult} input.result
 * @param {import('./types.js').ScenarioDiff} input.diff - the recorded diff; it travels on the promotion
 * @param {string} input.promotionId
 * @param {string} input.promotedAt - naive `YYYY-MM-DDTHH:MM:SS`, an input
 * @param {string} input.promotedBy
 * @param {string} input.rationale
 * @param {ReadonlyArray<string>} [input.acceptFindingCodes]
 * @returns {import('./types.js').ScenarioPromotion}
 */
export function promoteScenario(input) {
  const { result, diff } = input;
  const meta = createScenarioMeta();
  /** @type {import('./types.js').ScenarioFinding[]} */
  const findings = [];
  const accepted = new Set(input.acceptFindingCodes ?? []);

  const blocking = [...result.findings, ...diff.findings].filter(
    (finding) => finding.severity === CONSTRAINT_SEVERITY.BLOCKING && !accepted.has(finding.code)
  );
  if (blocking.length > 0) {
    findings.push(
      makeScenarioFinding(
        SCENARIO_REASON.SCENARIO_PROMOTION_REFUSED,
        `scenario "${result.scenarioId}" carries ${blocking.length} blocking finding(s) the caller did not accept (${[...new Set(blocking.map((f) => f.code))].sort().join(', ')}); promoting it would make a branch primary over an objection nobody read`,
        {
          scenarioId: result.scenarioId,
          codes: [...new Set(blocking.map((finding) => finding.code))].sort(),
          blocking: blocking.length,
        }
      )
    );
    throw Object.assign(
      new Error(
        `scenario: refusing to promote "${result.scenarioId}" — ${blocking.length} blocking finding(s) were not accepted by code: ${[...new Set(blocking.map((f) => f.code))].sort().join(', ')}`
      ),
      { name: 'ScenarioPromotionRefused', findings }
    );
  }

  // **The recorded diff, frozen.** `makePublicationSnapshot()` takes a column
  // vocabulary and rows of strings, so the diff records as an artifact with the
  // digest, the actor and the supplied timestamp the repository already has —
  // rather than a second immutable-record type built here. What is snapshotted
  // is the *diff*, not the schedule: the schedule is re-derivable from the
  // inputs and the overrides, and the diff is the thing a promotion is a
  // decision about.
  const rows = [
    ...diff.games.changed.map((change) => ({ bucket: 'changed', ...diffRow(change) })),
    ...diff.games.added.map((change) => ({ bucket: 'added', ...diffRow(change) })),
    ...diff.games.removed.map((change) => ({ bucket: 'removed', ...diffRow(change) })),
  ];
  if (rows.length === 0) {
    throw new Error(
      `scenario: refusing to promote "${result.scenarioId}" — its recorded diff moves, adds and removes no game at all, so the promotion would record a decision about nothing`
    );
  }
  const snapshot = makePublicationSnapshot({
    snapshotId: input.promotionId,
    label: `promoted scenario "${result.name}"`,
    channel: 'scenario promotion',
    publishedAt: input.promotedAt,
    publishedBy: input.promotedBy,
    columns: PROMOTION_DIFF_COLUMNS,
    rows,
    notes: input.rationale,
  });

  const primary = withRecords(result.materialised.inputs, result.materialised.records, {
    id: input.promotionId,
    label: `${result.materialised.inputs.label} + scenario "${result.name}"`,
    schedule: result.schedule,
  });
  meta.scenariosPromoted = 1;

  findings.push(
    makeScenarioFinding(
      SCENARIO_REASON.SCENARIO_PROMOTED,
      `scenario "${result.scenarioId}" is now primary as "${primary.id}", promoted by ${input.promotedBy} at ${input.promotedAt}: ${diff.games.changed.length} game(s) moved, ${diff.games.removed.length} carried as TIME TBD, ${diff.constraints.newlyViolated.length} constraint code(s) newly violated. The diff travels on this record`,
      {
        scenarioId: result.scenarioId,
        promotionId: input.promotionId,
        baselineId: result.materialised.inputs.id,
        fingerprint: result.fingerprint,
        gamesChanged: diff.games.changed.length,
        gamesRemoved: diff.games.removed.length,
        gamesAdded: diff.games.added.length,
        newlyViolated: diff.constraints.newlyViolated.join(', '),
        digest: snapshot.snapshot.digest,
        promotedBy: input.promotedBy,
        promotedAt: input.promotedAt,
      }
    )
  );

  return /** @type {import('./types.js').ScenarioPromotion} */ (
    Object.freeze({
      promotionId: input.promotionId,
      scenarioId: result.scenarioId,
      baselineId: result.materialised.inputs.id,
      fingerprint: result.fingerprint,
      promotedAt: input.promotedAt,
      promotedBy: input.promotedBy,
      rationale: input.rationale,
      primary,
      diff,
      snapshot: snapshot.snapshot,
      acceptedFindingCodes: Object.freeze([...accepted].sort()),
      durability: snapshot.snapshot.durability,
      findings,
      status: deriveScenarioStatus(findings),
      meta,
    })
  );
}

/**
 * The diff of a scenario result against its own baseline, with the branch's
 * engines on the right and the baseline's on the left.
 *
 * A convenience over {@link import('./diff.js').diffScenarios} and nothing more:
 * it supplies the two labels, the two verifications and the objective's weights
 * so a caller cannot accidentally compare a measured side against an unmeasured
 * one.
 *
 * @param {import('./types.js').ScenarioResult} result
 * @param {Object} options
 * @param {Object} options.baselineEngines
 * @param {Object} options.baselineVerification
 * @param {ReadonlyArray<Object>} [options.capacitySubjects]
 * @param {Record<string, number>} [options.objectiveWeights]
 * @returns {import('./types.js').ScenarioDiff}
 */
export function diffAgainstBaselineScenario(result, options) {
  return diffScenarios({
    subject: `scenario "${result.name}" against ${result.materialised.inputs.label}`,
    left: {
      label: result.materialised.inputs.label,
      schedule: result.baselineSchedule,
      verification: options.baselineVerification,
      engines: options.baselineEngines,
    },
    right: {
      label: `scenario "${result.name}"`,
      schedule: result.schedule,
      verification: result.verification,
      engines: result.materialised.engines,
    },
    capacitySubjects: options.capacitySubjects ?? [],
    weights: resolveObjectiveWeights(options.objectiveWeights),
  });
}
