/**
 * Repo-wide reachability audit for every frozen reason-code table in
 * `packages/core/src` — the generalisation of the per-module audit
 * `tests/attribution.test.js` already carries. 22 vocabularies, 522 codes, of
 * which 510 are shown to be producible and 12 are named as holes.
 *
 * **The defect this exists to catch.** Four times now, in four unrelated
 * modules, a reason code has been declared, given a severity, documented, and
 * tested — while no production path could actually emit it. The 15-minute
 * within-complex travel rule had no venue-complex concept to fire against;
 * `TEAM_UNCOACHED` named a state the roster index could not hold;
 * `RESERVED_SLOT_CONDITION_BLOCKED` answered a flag only tests set. Each was
 * caught by adversarial review rather than by the suite, and in three of the
 * four the *test* was the tell: it forged a state the production path could not
 * reach, which is the shape `CLAUDE.md` §3 names outright.
 *
 * **How this audit judges reachability.** Every code must be either
 *
 *   (a) *emitted* — the driver below calls a production entry point and a
 *       finding carrying that code comes back; or
 *   (b) *registered in {@link UNREACHABLE}* with a stated reason, which
 *       distinguishes a code no production path can emit at all from one this
 *       driver simply does not construct an input for.
 *
 * The driver is deliberately confined to **public entry points fed input
 * data** — corpus loaders, schema-validated builders, plain query objects. It
 * never reaches inside a returned structure and mutates it. That restriction is
 * the whole value of the check: the `TEAM_UNCOACHED` test passed by setting a
 * key on the roster's internal `teams` map after the fact, and a driver allowed
 * to do that would have proved exactly as little as that test did. Constructed
 * inputs are fine — the point is that some arrangement of *input* reaches the
 * code, not that the season corpus happens to contain one.
 *
 * Emission is observed by harvesting, from each returned value, every object of
 * the shape every module's `make*Finding()` produces (`{ code, severity, … }`)
 * whose code belongs to a declared table. No production code is instrumented
 * and no cross-file state is involved, so this file is order-independent and
 * behaves identically when it is the only file vitest runs.
 *
 * **What this does not do, stated plainly.**
 *
 * - It observes only the calls written below. A code the rest of the suite
 *   fires and this driver does not still reads as unaccounted for, which is a
 *   maintenance cost paid deliberately: the alternatives were instrumenting
 *   production `make*Finding()` with a module-level registry, or aggregating
 *   emissions across vitest workers through a file on disk. Both work; both
 *   also pass under `vitest run one.test.js`, which the first cannot do
 *   honestly and the second cannot do at all.
 * - It proves a code *can* be produced, never that anything sensible produces
 *   it. `RESERVED_SLOT_CONDITION_BLOCKED` is reachable and fires here from a
 *   constructed slot; whether the club would ever hold that ground is a
 *   different question this file does not ask.
 * - A driver call that quietly stopped reaching its code would take the
 *   coverage down with it, and the audit would then read as a defect in the
 *   module rather than in this file. The labels passed to {@link harvest} exist
 *   so the failure names the call that used to work.
 * - Nine declared codes cannot be produced through any entry point at all, and
 *   three more only by calling an exported helper the pipeline itself never
 *   calls that way. Each is named in {@link UNREACHABLE} with what stands in
 *   the way, and that list — not this file's machinery — is the finding worth
 *   reading. That split is read back and checked below too: it said "Five"
 *   while six entries claimed it, which is the drift the checked sentence
 *   above exists to stop and this one was not covered by.
 *
 * One apparent exception to the input-only rule is deliberate. Two of the
 * resolve scenarios register a *stage* that writes without asking, because that
 * is what `RESOLVE_AUDIT_FROZEN_GAME_MOVED` and its neighbours exist to catch —
 * incident 2 in miniature. A stage is an input the pipeline validates
 * (`ResolveStageSchema`, `extraStages`), not a state reached inside and
 * altered, and the misbehaviour happens inside the stage's own `run()` exactly
 * as a real non-compliant pass would.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

import {
  ATTRIBUTION_REASON,
  buildAttributionContext,
  explainEarliestKickoff,
  explainGame,
  explainKickoffTime,
  explainSchedule,
  explainLatestKickoff,
  explainTeamConflict,
  minimalBlockingSet,
} from '@squadlogic/core/attribution/index.js';
import {
  AVAILABILITY_REASON,
  buildAvailabilityCalendar,
  buildAvailabilityCalendarFromSeason2026,
  buildClosureSet,
  checkClosures,
  toAvailabilityCalendarInput,
  checkKickoffAvailability,
  latestLegalKickoff,
  resolveLighting,
  resolvePermitWindow,
  weekdayCodeOf,
} from '@squadlogic/core/availability/index.js';
import {
  CONSTRAINT_ENFORCEMENT,
  CONSTRAINT_REASON,
  CONSTRAINT_SCOPE_KIND,
  CONSTRAINT_TYPE,
  SEASON_2026_CONSTRAINTS,
  buildConstraintRegistry,
  buildSeason2026ConstraintRegistry,
  effectiveSeverityTable,
  resolveConstraints,
  resolvePolicy,
  retypeConstraint,
  whatIfConstraintType,
} from '@squadlogic/core/constraints/index.js';
import {
  BLACKOUT_REASON,
  BLACKOUT_SCOPE,
  BlackoutWindowSchema,
  FIELD_ADMIN_REASON,
  INTERPRETATION,
  RECORD_SOURCE,
  buildChangeSet,
  buildFieldRegistry,
  changeSetPartitionFindings,
  findBlackoutConflicts,
  repairProposal,
} from '@squadlogic/core/fieldAdmin/index.js';
import {
  FACILITY_REASON,
  buildFacilityGraph,
  buildFacilityGraphFromSeason2026,
  checkFacilityLifecycle,
  buildFieldAliasMap,
  buildSeason2026VenueComplexMap,
  buildVenueComplexMap,
  toSeason2026FacilityGraphInput,
  checkBooking,
  checkEquipment,
  checkLining,
  checkSizeEligibility,
  lookupFieldAlias,
  makeFinding as makeFacilityFinding,
  season2026SurfaceId,
  season2026VenueId,
} from '@squadlogic/core/facility/index.js';
import {
  FEASIBILITY_REASON,
  analyseMoveRequest,
  canGameMove,
  canTeamPlay,
  feasibleKickoffBounds,
} from '@squadlogic/core/feasibility/index.js';
import {
  FAIRNESS_COMPETITION,
  FAIRNESS_METRIC,
  FAIRNESS_OBJECTIVE,
  FAIRNESS_REASON,
  classifyFairnessFixtures,
  compareObjectiveScores,
  fairnessReport,
  participationOf,
  scoreFairnessObjective,
  toSeason2026FairnessFixtures,
} from '@squadlogic/core/fairness/index.js';
import {
  EXTERNAL_IMPORT_REASON,
  EXTERNAL_MAPPING_KIND,
  SEASON_2026_EXTERNAL_MAPPING_RECORDS,
  analyseImportImpact,
  buildAvoidWindows,
  buildExternalMappingRegistry,
  checkAvoidWindowRoundTrip,
  classifyExternalImport,
  projectAcceptance,
  readExternalMappingRegistry,
  season2026ExternalImportQuery,
  season2026ExternalMappingInput,
  serialiseExternalMappingRegistry,
  sweepAcceptanceSets,
  toSeason2026StandingFixtures,
} from '@squadlogic/core/externalImport/index.js';
import {
  SEASON_2026_PRACTICE_FINDING,
  SEASON_2026_ROW_KIND,
  crossCorpusFindings,
  loadCoachRoster,
  loadExternalFixtures,
  loadFacilityGeometry,
  loadFacilityPermits,
  loadGameFormats,
  loadSeason2026,
  loadSeason2026Practice,
  loadSunsets,
  parseFieldCodeNames,
  parseGameChangeLog,
  parsePermitReservations,
  parsePracticeGrid,
  parseWeeklyAvailability,
} from '@squadlogic/core/fixtures/index.js';
import {
  FREEZE_REASON,
  buildFreezePlan,
  freezeAllExcept,
  judgeFreeze,
  judgeFreezeAll,
  FREEZE_DISPOSITION,
} from '@squadlogic/core/freeze/index.js';
import {
  ASSIGNMENT_STATUS,
  COMMITMENT_SOURCE,
  PEOPLE_REASON,
  applyIdentityDecisions,
  buildCoachRoster,
  coachesOfTeamRow,
  buildIdentityReviewQueue,
  buildPersonDays,
  buildPersonalConstraintPolicy,
  buildSeason2026CoachRoster,
  createTimelineSet,
  reconcileTeamCoaches,
  deriveMustAttend,
  evaluatePersonDays,
  findAttendanceClashes,
  ingestCommitments,
  requireSealedTimelines,
  resolveAttendance,
  sealTimelines,
  season2026UncoachedFixtures,
  soleCoachRiskRegister,
} from '@squadlogic/core/people/index.js';
import {
  PRACTICE_REASON,
  buildPracticeHistory,
  buildPracticeSlotSet,
  materialisePracticeOccurrences,
} from '@squadlogic/core/practice/index.js';
import {
  CHANGELOG_REASON,
  UNDECLARED_SOURCE,
  buildChangeHistory,
  buildChangeLog,
  changeLogPartitionFindings,
  stateAsOf,
} from '@squadlogic/core/changelog/index.js';
import {
  PARITY_FIELD,
  PUBLICATION_REASON,
  SYNC_DESTINATION_KIND,
  buildChangeNotices,
  buildSyncRegistryReport,
  checkParity,
  compareParityRows,
  makeParityRow,
  makePublicationSnapshot,
  parityPartitionFindings,
  season2026ExternalParityInput,
  season2026PublishedParityInput,
  verifySnapshotDigest,
} from '@squadlogic/core/publication/index.js';
import {
  CONDITION_VERDICT,
  FIXTURE_SIDE,
  RESERVE_KIND,
  RESERVE_REASON,
  SEASON_2026_LEAGUE_CAP_PER_DATE,
  accountForFixtures,
  applySlotBindings,
  buildReserveCapacityReport,
  checkSlotsUnmoved,
  conditionForSurface,
  describeSlotCondition,
  evaluateSlotCondition,
  makeReservedSlot,
  makeUnplacedFixture,
  publicationCoverageFindings,
  publicationRowsFor,
  season2026FixtureSides,
  season2026ReserveBookings,
  season2026ReserveCapacityInput,
  season2026ReservedSlots,
  season2026SelectTeamIds,
} from '@squadlogic/core/reserve/index.js';
import {
  MOVE_KIND,
  RESOLVE_OBJECTIVE_TERM,
  RESOLVE_OBJECTIVE_WEIGHTS,
  RESOLVE_REASON,
  STAGE_PROBE,
  applyChangeRequest,
  applyMove,
  commitResolve,
  season2026ExternalFixtureChanges,
  createResolveState,
  createResolveLedger,
  buildSlotInventory,
  checkPlacement,
} from '@squadlogic/core/resolve/index.js';
import {
  RULE_REASON,
  RULE_VIOLATION_REASON,
  buildRuleEngine,
  buildValidationReport,
  runRuleEngine,
  toSeason2026Schedule,
} from '@squadlogic/core/ruleEngine/index.js';
import {
  SEASON_2026_INCIDENT_8_WARMUP_MINUTES,
  TIMING_REASON,
  buildFormatTimingTable,
  buildFormatTimingTableFromSeason2026,
  toFormatTimingInput,
  checkFixtureTiming,
  computeGameWindows,
  earliestKickoffWithWarmup,
  resolveZonedInstant,
  warmupWindowAvailability,
} from '@squadlogic/core/timing/index.js';
import {
  SCENARIO_OVERRIDE_KIND,
  SCENARIO_REASON,
  SCENARIO_RECORD_SET,
  ScenarioMemo,
  diffAgainstBaselineScenario,
  makeScenarioFinding,
  materialiseScenario,
  diffScenarios,
  diffSchedules,
  makeScenario,
  promoteScenario,
  runScenario,
  scheduleDiffPartitionFindings,
  season2026CapacitySubjects,
  season2026RelocationPolicy,
  season2026SeasonInputs,
  season2026VenueUnavailableScenario,
} from '@squadlogic/core/scenario/index.js';
import {
  TRAVEL_REASON,
  WAIVER_REASON,
  applyWaivers,
  buildWaiverLedger,
  detectDormantWaivers,
  evaluateCoachTravel,
  reconcileWaiverLedger,
} from '@squadlogic/core/waivers/index.js';

/* -------------------------------------------------------------------------- */
/* The universe of declared codes                                              */
/* -------------------------------------------------------------------------- */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CORE = path.join(ROOT, 'packages', 'core', 'src');

/**
 * Every table this audit knows about, by the name it is exported under.
 *
 * Registered by hand *and* cross-checked against a scan of the source below, so
 * a new module's table cannot arrive without either being audited or being
 * named as something other than a reason-code table.
 *
 * @type {Readonly<Record<string, Readonly<Record<string, string>>>>}
 */
const TABLES = Object.freeze({
  ATTRIBUTION_REASON,
  AVAILABILITY_REASON,
  CHANGELOG_REASON,
  CONSTRAINT_REASON,
  EXTERNAL_IMPORT_REASON,
  FACILITY_REASON,
  FIELD_ADMIN_REASON,
  FAIRNESS_REASON,
  FEASIBILITY_REASON,
  FREEZE_REASON,
  PEOPLE_REASON,
  PRACTICE_REASON,
  PUBLICATION_REASON,
  RESERVE_REASON,
  RESOLVE_REASON,
  RULE_REASON,
  RULE_VIOLATION_REASON,
  SCENARIO_REASON,
  SEASON_2026_PRACTICE_FINDING,
  TIMING_REASON,
  TRAVEL_REASON,
  WAIVER_REASON,
});

/**
 * Frozen identity-mapped tables that are *not* finding vocabularies, and why.
 *
 * Same discipline as {@link UNREACHABLE}: a table is excluded by a stated
 * reason, never by being forgotten.
 *
 * @type {Readonly<Record<string, string>>}
 */
const NOT_A_FINDING_TABLE = Object.freeze({
  DORMANCY_REASON:
    'the three verdicts detectDormantWaivers() gives a waiver (never-matched, not-status-bearing, load-bearing). It is a classification carried on a dormancy row, not a finding code: the findings that report it are WAIVER_DORMANT and WAIVER_NOT_STATUS_BEARING, and both are audited above.',
  IDENTITY_SIGNAL:
    'a similarity-signal enum carried on identity proposals, weighted by IDENTITY_SIGNAL_WEIGHT; it never appears as a finding code and has no severity table',
  BLACKOUT_REASON:
    "the enumerated reason a blackout closes ground (closure, school-event, maintenance, reseeding, weather, permit-not-granted, adjacency, third-party-booking, other). It is a *domain field* on BlackoutWindowSchema, deliberately an enum rather than free text so an operator's prose is not the place a family's name lands; it is never a finding code and has no severity table.",
});

/**
 * Finding vocabularies this audit does **not** drive yet, and why.
 *
 * One entry, and the cap below keeps it that way: parking a module here is a
 * declared gap, not a way of absorbing new modules quietly. An entry naming a
 * table the scan cannot find is inert rather than an error, because a table may
 * live on a branch this one does not carry.
 *
 * @type {Readonly<Record<string, string>>}
 */
const TABLES_AWAITING_DRIVER = Object.freeze({});

/** Which table each code belongs to. */
const TABLE_OF = new Map(
  Object.entries(TABLES).flatMap(([name, table]) =>
    Object.values(table).map((code) => [code, name])
  )
);

/** Every declared code, once. */
const DECLARED = new Set(TABLE_OF.keys());

/* -------------------------------------------------------------------------- */
/* The allowlist — an entry without a reason cannot be constructed             */
/* -------------------------------------------------------------------------- */

/**
 * Why a declared code is not emitted by the driver.
 *
 * The two are different claims and the audit refuses to let them blur:
 * `NO_PRODUCTION_PATH` is a defect being carried deliberately, `NOT_CONSTRUCTED`
 * is a limit of this driver.
 *
 * @readonly
 * @enum {string}
 */
const WHY = Object.freeze({
  /**
   * Nothing a caller can pass to the module's own entry points reaches it — the
   * guard sits behind a refusal, or behind an invariant the calling code
   * establishes one line earlier. A known hole, carried deliberately.
   */
  NO_PRODUCTION_PATH: 'no-production-path',
  /**
   * A production path exists but this driver does not build the input for it —
   * usually a helper the package exports and the pipeline calls with data that
   * cannot trip the guard. The reason has to say which call would.
   */
  NOT_CONSTRUCTED: 'not-constructed-here',
});

/**
 * One allowlist entry.
 *
 * Constructed rather than written as an object literal so that the reason is
 * *structurally* required — the same move `RuleExerciseSchema` and
 * `StageDefinition.freezeContract` make. A bare list of code names would be a
 * way to silence this audit, which is the failure mode it exists to prevent.
 *
 * @param {string} code
 * @param {string} why - a {@link WHY} value
 * @param {string} reason - prose; what is missing, or where it does fire
 * @returns {{ code: string, why: string, reason: string }}
 */
function allow(code, why, reason) {
  if (!DECLARED.has(code)) {
    throw new Error(
      `reason-code audit: "${code}" is allowlisted but no table declares it; delete the entry`
    );
  }
  if (!(/** @type {string[]} */ (Object.values(WHY)).includes(why))) {
    throw new Error(`reason-code audit: "${code}" has no valid WHY (got ${JSON.stringify(why)})`);
  }
  if (typeof reason !== 'string' || reason.trim().length < 40) {
    throw new Error(
      `reason-code audit: "${code}" needs a stated reason of at least 40 characters, not ${JSON.stringify(reason)}`
    );
  }
  return Object.freeze({ code, why, reason: reason.trim() });
}

/** @type {ReadonlyArray<{ code: string, why: string, reason: string }>} */
const UNREACHABLE = Object.freeze([
  allow(
    'FAIRNESS_FLAG_EVIDENCE_MISSING',
    WHY.NO_PRODUCTION_PATH,
    'assertFlagEvidence() runs from fairnessReport() over every flag, and buildPopulations() cannot produce a flag that fails it: a judgement is only ever "outlier" when deriveFairnessJudgement() saw a `usable` dispersion and a finite score, and a usable dispersion carries a centre, a non-zero scale and at least MIN_POPULATION_FOR_DISPERSION members by construction — so the basis, the centre, the scale, the deviation, the score, the threshold and the direction are all present one line before the flag exists. Making it fire would mean introducing the unpublished flag it exists to catch. Its falsifiability is proved where it belongs, in tests/fairnessMetrics.test.js, which hands it a hand-built flag with a null centre and shows it refuses; driving it from here would be the forged-state shape CLAUDE.md §3 names.'
  ),
  allow(
    'FEASIBILITY_CANDIDATE_DROPPED',
    WHY.NO_PRODUCTION_PATH,
    'Both emitters stand behind an invariant the calling code establishes one line earlier. candidateAccountingFindings() runs from seal(), and every path in queries.js that increments candidatesConsidered increments candidatesAnswered before it seals — the unknown-game early return included, which is the defect the guard was added for; canTeamPlay()’s own grid guard compares a list its loop pushes to exactly once per cell against a grid size derived from the query. Making it fire would mean introducing the drop it exists to catch. It was briefly credited here on the strength of a direct call to candidateAccountingFindings() with a fabricated meta, which is the forged-state shape CLAUDE.md §3 names: the guard is real and falsifiable, and tests/feasibilityApi.test.js proves it by handing it an unbalanced ledger, but no public query emits it and the sweep there asserts that no answer of any shape carries it.'
  ),
  allow(
    'FEASIBILITY_CLAIM_CATEGORY_ONLY',
    WHY.NO_PRODUCTION_PATH,
    'This module\u2019s restatement of ATTRIBUTION_CLAIM_CATEGORY_ONLY, and it inherits that code\u2019s hole exactly: feasibleKickoffBounds() runs 4.3\u2019s own guard over the claims each boundary builds, and no claim built from an availability constraint can fail isSpecificClaim() \u2014 every one names its permit or booking instance and carries the finding codes that spoke. It is translated rather than forwarded so that, if the guard ever does fire, the answer carries a code this module can look a severity up for instead of one that makes feasibilitySeverityOf() throw in the reader\u2019s hand.'
  ),
  allow(
    'ATTRIBUTION_GAME_UNATTRIBUTED',
    WHY.NO_PRODUCTION_PATH,
    'explainGame() raises it when a game produces no claim at all, but every placement answer turns the four availability constraint kinds and every facility/timing finding into claims, so the list is never empty for a game the schedule holds. The driver above asks it of the emptiest world the constructors allow — rig ground, a calendar declaring no permit, no sunset and no lighting, and a registry governing no reason code — and claims still come back.'
  ),
  allow(
    'ATTRIBUTION_SWEEP_VACUOUS',
    WHY.NO_PRODUCTION_PATH,
    'explainSchedule() raises it when the sweep saw no games, but buildAttributionContext() cannot build a context for a zero-game schedule at all \u2014 buildSlotInventory() throws first ("a slot inventory built from zero games would offer nothing to anybody"). The only way to reach the guard is to assemble a context by spreading a real one over an emptier schedule, which is the hand-built state this audit refuses to count; tests/attribution.test.js does exactly that, which is how the code reads as covered there.'
  ),
  allow(
    'ATTRIBUTION_CLAIM_CATEGORY_ONLY',
    WHY.NO_PRODUCTION_PATH,
    'isSpecificClaim() fails only when a claim names neither an instance nor a constraint, and every claim built from a module finding carries the finding\u2019s own code plus an identifier out of its details. The guard is real and is exercised as a predicate with its own positive control in tests/attribution.test.js; nothing the six source modules emit can trip it.'
  ),
  allow(
    'RESOLVE_RUN_VACUOUS',
    WHY.NO_PRODUCTION_PATH,
    'The stage raises it when the run holds no games, but runResolve() throws on an empty schedule before any stage runs ("every verdict this run could produce would be true of nothing"), and applyChangeRequest() throws again on an empty change list. It is a third guard standing behind two hard refusals.'
  ),
  allow(
    'RESOLVE_PUBLISHED_HOLD_PARTITION_INCOMPLETE',
    WHY.NO_PRODUCTION_PATH,
    'Same shape as RESOLVE_REPORT_PARTITION_INCOMPLETE. diffAgainstBaseline() builds held and moved from one walk of state.gameIds, pushing each game into exactly one of them, so no production run can produce a partition that fails to add up or names a game in both. It is the meta-assertion on that walk, and it is driven from a hand-built partition in tests/boundedLocalRepair.test.js, which is where a check that cannot fire in production can still be shown to fire.'
  ),
  allow(
    'RESOLVE_AUDIT_VACUOUS',
    WHY.NO_PRODUCTION_PATH,
    'Same shape as RESOLVE_RUN_VACUOUS and the same two upstream refusals: the freeze audit reports it when state.gameIds is empty, and no run with an empty game list ever reaches a stage.'
  ),
  allow(
    'RESOLVE_REPORT_PARTITION_INCOMPLETE',
    WHY.NOT_CONSTRUCTED,
    'buildChangeReport() counts each moved game across the requested and consequential lists, but the consequential list is built as "every moved game the request did not name", so the two partition `moved` by construction and the only detectable failure is a duplicate inside `moved` itself \u2014 which comes from diffAgainstBaseline(), one entry per baseline game. Reachable only by calling the exported buildChangeReport() with a hand-built `moved` list naming one game twice.'
  ),
  allow(
    'RULE_EXERCISE_DOMAIN_UNKNOWN',
    WHY.NOT_CONSTRUCTED,
    'checkCoverage() raises it when universeOf() cannot bound a coverage domain, but RuleExerciseSchema validates every coverage value against the RULE_IDENTIFIER_KIND enum and every member of that enum has a universe \u2014 game and date are computed, the other five read schedule fields ScheduleSchema defaults to arrays. Reachable only by calling the exported checkCoverage() with a schedule ScheduleSchema would reject.'
  ),
  allow(
    'RULE_IDENTIFIER_KIND_UNKNOWN',
    WHY.NOT_CONSTRUCTED,
    'The same seam in checkIdentifiers(): identifierKinds is enum-validated by RuleExerciseSchema, and every member of the enum has a universe, so universeOf() never returns null for a rule the engine will run. Reachable only by bypassing the schema.'
  ),
]);

/** Any real code, for the allowlist's own positive control. */
const SOME_DECLARED_CODE = FACILITY_REASON.LINING_MISMATCH;

/* -------------------------------------------------------------------------- */
/* Harvest                                                                     */
/* -------------------------------------------------------------------------- */

/** Every code the driver has seen come back from production. */
const emitted = new Map();

/**
 * Record every finding-shaped object anywhere in `value`.
 *
 * Shape rather than position: every module's `make*Finding()` returns
 * `{ code, severity, message, details }`, so one walker covers all of them and
 * a code emitted three levels down inside a report is still counted.
 *
 * `planted` is the answer to the one way this could lie. A few entry points —
 * `applyWaivers()`, `detectDormantWaivers()` — take findings *as input* and
 * hand them back annotated, so a code the driver constructed would otherwise be
 * credited to the module that merely carried it. Those calls name what they
 * planted and it is refused here, which means a module that stopped emitting
 * one of those codes could not be covered for it by an echo.
 *
 * @template T
 * @param {string} label - which driver call produced this, for the failure text
 * @param {T} value
 * @param {ReadonlyArray<string>} [planted] - codes this call handed in itself
 * @returns {T}
 */
function harvest(label, value, planted = []) {
  const seen = new Set();
  const refused = new Set(planted);
  /** @param {unknown} node */
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    // Cycle guard only. There is deliberately no depth cap: one that returned
    // before marking a node seen would leave that node's descendants unwalked
    // and remembered as visited, so a finding could be missed depending on the
    // order the keys happened to be reached in.
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    const record = /** @type {Record<string, unknown>} */ (node);
    if (
      typeof record.code === 'string' &&
      typeof record.severity === 'string' &&
      DECLARED.has(record.code) &&
      !refused.has(record.code) &&
      !emitted.has(record.code)
    ) {
      emitted.set(record.code, label);
    }
    for (const item of Object.values(record)) walk(item);
  };
  walk(value);
  return value;
}

/* -------------------------------------------------------------------------- */
/* The corpus, loaded once                                                     */
/* -------------------------------------------------------------------------- */

const season = loadSeason2026();
const geometry = loadFacilityGeometry();
const graph = buildFacilityGraphFromSeason2026(geometry);
const timingTable = buildFormatTimingTableFromSeason2026(loadGameFormats());
const sunsets = loadSunsets();
/** Derived from the corpus rather than typed in, so a re-dated fixture moves it. */
const SEASON_YEAR = Number(sunsets[0].date.slice(0, 4));
const calendar = buildAvailabilityCalendarFromSeason2026(
  loadFacilityPermits({ seasonYear: SEASON_YEAR }),
  sunsets
);
const venueComplexes = buildSeason2026VenueComplexMap();
const registry = buildSeason2026ConstraintRegistry();
const schedule = toSeason2026Schedule(season);
const roster = buildSeason2026CoachRoster(loadCoachRoster());
const resources = { graph, timingTable, calendar, venueComplexes };

/* -------------------------------------------------------------------------- */
/* Driver                                                                      */
/* -------------------------------------------------------------------------- */

const verification = harvest(
  'runRuleEngine(season)',
  runRuleEngine(schedule, { registry, resources })
);
harvest(
  'buildValidationReport',
  buildValidationReport(verification, { scheduleName: schedule.name })
);

const context = harvest(
  'buildAttributionContext',
  buildAttributionContext({
    graph,
    table: timingTable,
    calendar,
    registry,
    schedule,
    verification,
    venueComplexes,
    roster,
  })
);
harvest('explainSchedule', explainSchedule(context));

/* -- facility ------------------------------------------------------------- */

/**
 * A purpose-built graph for the facility cases the published season has no
 * example of. Built through `buildFacilityGraph`, which is the same validated
 * constructor the season adapter calls — the rig is *input*, not a hand-made
 * graph object.
 */
const rig = buildFacilityGraph({
  venues: [{ id: 'rig', name: 'Rig Park' }],
  surfaces: [
    {
      id: 'rig/full',
      venueId: 'rig',
      name: 'Full',
      sizes: ['11v11'],
      lined: ['11v11'],
      childIds: ['rig/half'],
    },
    {
      id: 'rig/half',
      venueId: 'rig',
      name: 'Half',
      sizes: ['9v9'],
      lined: [],
      parentId: 'rig/full',
    },
    { id: 'rig/bare', venueId: 'rig', name: 'Bare', sizes: [], lined: [] },
    {
      id: 'rig/shut',
      venueId: 'rig',
      name: 'Shut',
      sizes: ['9v9'],
      lined: ['9v9'],
      bookable: false,
    },
    { id: 'rig/next', venueId: 'rig', name: 'Next', sizes: ['9v9'], lined: ['9v9'] },
  ],
  overlapPairs: [['rig/next', 'rig/half']],
  formatEquipment: { '9v9': ['goals'] },
});

const rigBooking = (overrides) => ({
  id: 'rig-booking',
  surfaceId: 'rig/half',
  date: '2026-08-15',
  startMinutes: 540,
  endMinutes: 600,
  format: '9v9',
  ...overrides,
});

harvest('checkBooking(unknown surface)', checkBooking(rig, rigBooking({ surfaceId: 'rig/nope' })));
harvest('checkBooking(not bookable)', checkBooking(rig, rigBooking({ surfaceId: 'rig/shut' })));
harvest(
  'checkBooking(same surface)',
  checkBooking(rig, rigBooking(), { existingBookings: [rigBooking({ id: 'other' })] })
);
harvest(
  'checkBooking(parent/child)',
  checkBooking(rig, rigBooking({ surfaceId: 'rig/full', format: '11v11' }), {
    existingBookings: [rigBooking({ id: 'child' })],
  })
);
harvest(
  'checkBooking(spatial overlap)',
  checkBooking(rig, rigBooking({ surfaceId: 'rig/next' }), {
    existingBookings: [rigBooking({ id: 'neighbour' })],
  })
);
harvest(
  'checkSizeEligibility(too small)',
  checkSizeEligibility(rig, { surfaceId: 'rig/half', format: '11v11' })
);
harvest(
  'checkSizeEligibility(declared policy)',
  checkSizeEligibility(rig, { surfaceId: 'rig/full', format: '9v9' }, { sizePolicy: 'declared' })
);
harvest(
  'checkSizeEligibility(undeclared)',
  checkSizeEligibility(rig, { surfaceId: 'rig/bare', format: '9v9' })
);
harvest('checkLining(undeclared)', checkLining(rig, { surfaceId: 'rig/half', format: '9v9' }));

/* -- facility lifecycle ---------------------------------------------------- */
// **A constructed graph, because the corpus cannot reach these.** Nothing in
// season-2026 carries an effective window (`tests/facilityLifecycle.test.js`
// asserts `datedNodeCount === 0` against the real graph), so both codes are
// driven from a graph built here. That is the honest exercise, not a shortcut:
// the finding exists for estates that change shape, and this repo does not
// have one yet.
const datedRig = buildFacilityGraph({
  venues: [{ id: 'dated/v', name: 'Dated Venue' }],
  surfaces: [
    {
      id: 'dated/s',
      venueId: 'dated/v',
      name: 'Retiring Pitch',
      sizes: ['9v9'],
      lined: ['9v9'],
      effectiveTo: '2026-06-30',
    },
  ],
});
harvest(
  'checkFacilityLifecycle(no asOf, dated graph)',
  checkFacilityLifecycle(datedRig, { surfaceId: 'dated/s' })
);
harvest(
  'checkFacilityLifecycle(asOf after the window)',
  checkFacilityLifecycle(datedRig, { surfaceId: 'dated/s', asOf: '2026-09-01' })
);
harvest(
  'checkEquipment(assumed available)',
  checkEquipment(rig, { surfaceId: 'rig/half', format: '9v9', date: '2026-08-15' })
);
harvest(
  'checkEquipment(undeclared requirement)',
  checkEquipment(rig, { surfaceId: 'rig/full', format: '11v11', date: '2026-08-15' })
);

/** The same rig, with equipment records to resolve. One window per status. */
const equipmentWindow = (overrides) => ({
  id: 'window',
  equipment: 'goals',
  status: 'available',
  scope: { kind: 'venue', id: 'rig' },
  fromDate: '2026-08-01',
  toDate: '2026-08-31',
  ...overrides,
});
for (const [label, windows] of /** @type {Array<[string, Array<Object>]>} */ ([
  ['available', [equipmentWindow({ id: 'yes' })]],
  ['unavailable', [equipmentWindow({ id: 'no', status: 'unavailable' })]],
  ['unknown', [equipmentWindow({ id: 'dunno', status: 'unknown' })]],
  [
    'ambiguous',
    [
      equipmentWindow({ id: 'left', status: 'available' }),
      equipmentWindow({ id: 'right', status: 'unavailable' }),
    ],
  ],
])) {
  const built = buildFacilityGraph({
    venues: [{ id: 'rig', name: 'Rig Park' }],
    surfaces: [{ id: 'rig/half', venueId: 'rig', name: 'Half', sizes: ['9v9'], lined: ['9v9'] }],
    formatEquipment: { '9v9': ['goals'] },
    equipmentWindows: windows,
  });
  harvest(
    `checkEquipment(${label})`,
    checkEquipment(built, { surfaceId: 'rig/half', format: '9v9', date: '2026-08-15' })
  );
}

/* -- timing --------------------------------------------------------------- */

/* -- the season clock ----------------------------------------------------- */

/**
 * `resolveZonedInstant()` is the boundary where a `game_slots` wall reading
 * becomes an instant, and all three of its refusals are driven from plain input
 * — a date, a clock reading and a zone — with nothing reached into.
 *
 * The dates are the real ones: `America/New_York` repeats 01:30 on 2026-11-01
 * and skips 02:30 on 2026-03-08.
 */
harvest(
  'resolveZonedInstant(no season timezone)',
  resolveZonedInstant({ date: '2026-11-07', time: '16:44', timeZone: null })
);
harvest(
  'resolveZonedInstant(unknown timezone)',
  resolveZonedInstant({ date: '2026-11-07', time: '16:44', timeZone: 'Americas/New_York' })
);
harvest(
  'resolveZonedInstant(unreadable wall time)',
  // `24:00:00` composes -- it is midnight ending the day, which Postgres `time`
  // legally stores. `24:30` is the hour-24 value that names no instant.
  resolveZonedInstant({ date: '2026-11-07', time: '24:30:00', timeZone: 'America/New_York' })
);
harvest(
  'resolveZonedInstant(daylight saving skips the hour)',
  resolveZonedInstant({ date: '2026-03-08', time: '02:30', timeZone: 'America/New_York' })
);
harvest(
  'resolveZonedInstant(daylight saving repeats the hour)',
  resolveZonedInstant({ date: '2026-11-01', time: '01:30', timeZone: 'America/New_York' })
);

/* -- the alias layer ------------------------------------------------------ */

/**
 * Two venues declared as one complex, each with a `Field 1`, so a practice
 * spelling that names the complex fits two surfaces. Same constructor the
 * season adapter uses; the rig is input.
 */
const aliasRig = buildFacilityGraph({
  venues: [
    { id: 'twin-a', name: 'Twin A' },
    { id: 'twin-b', name: 'Twin B' },
  ],
  surfaces: [
    { id: 'twin-a/field-1', venueId: 'twin-a', name: 'Field 1' },
    { id: 'twin-a/field-2', venueId: 'twin-a', name: 'Field 2' },
    { id: 'twin-b/field-1', venueId: 'twin-b', name: 'Field 1' },
  ],
});
const aliasComplexes = buildVenueComplexMap({
  complexes: [{ id: 'twin', name: 'Twin', venueIds: ['twin-a', 'twin-b'] }],
});
const aliasMap = harvest(
  'buildFieldAliasMap(every unresolved shape)',
  buildFieldAliasMap(aliasRig, aliasComplexes, {
    rings: [
      {
        ring: 'one',
        entries: [
          { displayName: 'Blank' },
          { displayName: 'Lost', label: 'Nowhere Field 1', venue: 'Nowhere', field: 'Field 1' },
          { displayName: 'Vague', label: 'Twin Field 1', venue: 'Twin', field: 'Field 1' },
          { displayName: 'Whole', label: 'Twin A', venue: 'Twin A' },
          {
            displayName: 'Doubt',
            label: 'Twin A Field 9?',
            venue: 'Twin A',
            field: 'Field 9?',
            uncertain: true,
          },
          { displayName: 'Split', label: 'Twin A Field 1', venue: 'Twin A', field: 'Field 1' },
          { displayName: 'Split', label: 'Twin A Field 2', venue: 'Twin A', field: 'Field 2' },
        ],
      },
      {
        ring: 'two',
        entries: [
          { displayName: 'Split', label: 'Twin A Field 2', venue: 'Twin A', field: 'Field 2' },
        ],
      },
    ],
  })
);
harvest('lookupFieldAlias(unknown name)', lookupFieldAlias(aliasMap, 'Nobody Field 1'));

/** A well-formed format row; each case below breaks exactly one field of it. */
const rigFormat = (overrides = {}) => ({
  format: '9v9',
  halves: 2,
  halfMinutes: 30,
  halftimeMinutes: { min: 5, max: 5 },
  occupancyMinutes: { min: 65, max: 65, scheduled: 65 },
  blockMinutes: 70,
  turnoverMinMinutes: 5,
  ...overrides,
});

const rigTable = harvest(
  'buildFormatTimingTable(clean)',
  buildFormatTimingTable({ formats: [rigFormat()], warmupPolicy: { '9v9': 30 } })
);
harvest(
  'buildFormatTimingTable(duplicate row)',
  buildFormatTimingTable({ formats: [rigFormat(), rigFormat({ blockMinutes: 80 })] })
);
harvest(
  'buildFormatTimingTable(derivation disagrees)',
  buildFormatTimingTable({ formats: [rigFormat({ halfMinutes: 25 })] })
);
harvest(
  'buildFormatTimingTable(block shorter than occupancy)',
  buildFormatTimingTable({ formats: [rigFormat({ blockMinutes: 60 })] })
);
harvest(
  'buildFormatTimingTable(no turnover floor)',
  buildFormatTimingTable({ formats: [rigFormat({ turnoverMinMinutes: null })] })
);

/** No warm-up policy at all — the season-warm-up hole, asked directly. */
const unwarmedTable = harvest(
  'buildFormatTimingTable(no warm-up policy)',
  buildFormatTimingTable({ formats: [rigFormat()] })
);

const rigFixture = (overrides = {}) => ({
  id: 'rig-fixture',
  surfaceId: 'rig/half',
  date: '2026-08-15',
  kickoffMinutes: 600,
  format: '9v9',
  ...overrides,
});

harvest(
  'checkFixtureTiming(no warm-up length)',
  checkFixtureTiming(rig, unwarmedTable, rigFixture())
);
harvest(
  'computeGameWindows(warm-up before day start)',
  computeGameWindows(rigTable, {
    format: '9v9',
    kickoffMinutes: 20,
    warmupMinutes: 30,
    dayStartMinutes: 0,
  })
);

/** The warm-up window, contended three ways and left unbounded once. */
const rigOccupied = (overrides = {}) => ({
  id: 'sitting-tenant',
  surfaceId: 'rig/half',
  date: '2026-08-15',
  startMinutes: 540,
  endMinutes: 600,
  format: '9v9',
  ...overrides,
});
for (const [label, existing] of /** @type {Array<[string, Array<Object>]>} */ ([
  ['same surface', [rigOccupied()]],
  ['parent/child', [rigOccupied({ surfaceId: 'rig/full', format: '11v11' })]],
  ['spatial overlap', [rigOccupied({ surfaceId: 'rig/next' })]],
  ['unknown footprint', [rigOccupied({ endMinutes: null, format: null })]],
])) {
  harvest(
    `checkFixtureTiming(warm-up meets ${label})`,
    checkFixtureTiming(rig, rigTable, rigFixture(), { existingBookings: existing })
  );
}

harvest(
  'warmupWindowAvailability(short window)',
  warmupWindowAvailability(
    rig,
    rigTable,
    { surfaceId: 'rig/half', date: '2026-08-15', kickoffMinutes: 600, format: '9v9' },
    { existingBookings: [rigOccupied({ startMinutes: 500, endMinutes: 585 })] }
  )
);
harvest(
  'warmupWindowAvailability(unbounded)',
  warmupWindowAvailability(rig, rigTable, {
    surfaceId: 'rig/half',
    date: '2026-08-15',
    kickoffMinutes: 600,
    format: '9v9',
  })
);
harvest(
  'earliestKickoffWithWarmup(unbounded)',
  earliestKickoffWithWarmup(rig, rigTable, {
    surfaceId: 'rig/half',
    date: '2026-08-15',
    format: '9v9',
  })
);
harvest(
  'earliestKickoffWithWarmup(bound by same surface)',
  earliestKickoffWithWarmup(
    rig,
    rigTable,
    { surfaceId: 'rig/half', date: '2026-08-15', format: '9v9', notBeforeMinutes: 540 },
    { existingBookings: [rigOccupied()] }
  )
);
harvest(
  'earliestKickoffWithWarmup(bound by another surface)',
  earliestKickoffWithWarmup(
    rig,
    rigTable,
    { surfaceId: 'rig/half', date: '2026-08-15', format: '9v9', notBeforeMinutes: 540 },
    { existingBookings: [rigOccupied({ surfaceId: 'rig/next' })] }
  )
);
harvest(
  'earliestKickoffWithWarmup(search exhausted)',
  earliestKickoffWithWarmup(
    rig,
    rigTable,
    {
      surfaceId: 'rig/half',
      date: '2026-08-15',
      format: '9v9',
      notBeforeMinutes: 540,
      notAfterMinutes: 560,
    },
    { existingBookings: [rigOccupied({ startMinutes: 0, endMinutes: 1400 })] }
  )
);

/* -- availability --------------------------------------------------------- */

const RIG_DATE = '2026-08-15';
/** Derived, not typed in, so a re-dated rig cannot silently miss its weekday. */
const RIG_WEEKDAY = weekdayCodeOf(RIG_DATE);

/** A rig graph whose venue carries the floodlight flag, for the venue fallback. */
const litRig = buildFacilityGraph({
  venues: [{ id: 'rig', name: 'Rig Park', lit: true }],
  surfaces: [
    {
      id: 'rig/full',
      venueId: 'rig',
      name: 'Full',
      sizes: ['11v11', '9v9'],
      lined: ['11v11', '9v9'],
      childIds: ['rig/half'],
    },
    {
      id: 'rig/half',
      venueId: 'rig',
      name: 'Half',
      sizes: ['9v9'],
      lined: ['9v9'],
      parentId: 'rig/full',
    },
  ],
});

const permit = (overrides = {}) => ({
  id: 'permit',
  venueId: 'rig',
  scopeKind: 'weekday-default',
  weekday: RIG_WEEKDAY,
  openMinutes: 480,
  closeMinutes: 1200,
  ...overrides,
});
const sunset = (overrides = {}) => ({ date: RIG_DATE, sunsetMinutes: 1200, ...overrides });

const emptyCalendar = harvest('buildAvailabilityCalendar(empty)', buildAvailabilityCalendar({}));
const openCalendar = harvest(
  'buildAvailabilityCalendar(weekday default)',
  buildAvailabilityCalendar({ permitWindows: [permit()], sunsets: [sunset()] })
);
harvest(
  'buildAvailabilityCalendar(two sunsets for one date)',
  buildAvailabilityCalendar({ sunsets: [sunset(), sunset({ sunsetMinutes: 1150 })] })
);
harvest(
  'buildAvailabilityCalendar(two lighting records for one surface)',
  buildAvailabilityCalendar({
    lighting: [
      { surfaceId: 'rig/half', lit: true, lightsOffMinutes: 1300 },
      { surfaceId: 'rig/half', lit: false },
    ],
  })
);

const kickoffQuery = (overrides = {}) => ({
  surfaceId: 'rig/half',
  date: RIG_DATE,
  kickoffMinutes: 600,
  format: '9v9',
  ...overrides,
});

/**
 * Every closure scope kind, over the facility rig, on a date every window
 * covers. The bookings below stand inside each in turn.
 */
const closureRig = harvest(
  'buildClosureSet(every scope kind, one venue unknown)',
  buildClosureSet(rig, {
    closures: [
      {
        id: 'shut',
        fromDate: RIG_DATE,
        toDate: RIG_DATE,
        startMinutes: 540,
        endMinutes: 600,
        allDay: false,
        scope: { kind: 'surface', surfaceIds: ['rig/full'] },
        reason: 'shut',
      },
      {
        id: 'unreadable',
        fromDate: RIG_DATE,
        toDate: RIG_DATE,
        startMinutes: 0,
        endMinutes: 1380,
        allDay: true,
        scope: { kind: 'unreadable', venueIds: ['rig'] },
        reason: 'unreadable',
        fieldsRaw: '2026-01-07',
      },
      {
        id: 'parking',
        fromDate: RIG_DATE,
        toDate: RIG_DATE,
        startMinutes: 0,
        endMinutes: 1380,
        allDay: true,
        scope: { kind: 'not-ground', venueIds: ['rig'] },
        reason: 'parking',
        fieldsRaw: 'Parking',
      },
      {
        // A *timed* not-ground row, so a booking with no end that kicks off
        // before it opens is undecidable against a decided answer that is
        // itself information: CLOSURE_NOTE_UNDECIDABLE.
        id: 'parking-timed',
        fromDate: RIG_DATE,
        toDate: RIG_DATE,
        startMinutes: 540,
        endMinutes: 600,
        allDay: false,
        scope: { kind: 'not-ground', venueIds: ['rig'] },
        reason: 'parking (timed)',
        fieldsRaw: 'Parking',
      },
      {
        id: 'spacing',
        fromDate: RIG_DATE,
        toDate: RIG_DATE,
        startMinutes: 0,
        endMinutes: 1380,
        allDay: true,
        scope: { kind: 'adjacency', venueIds: ['rig'] },
        reason: 'spacing',
      },
      {
        id: 'gone',
        fromDate: RIG_DATE,
        toDate: RIG_DATE,
        startMinutes: 0,
        endMinutes: 1380,
        allDay: true,
        scope: { kind: 'surface-unknown', venueIds: ['rig'], surfaceName: 'Pitch 9' },
        reason: 'gone',
      },
      {
        id: 'lost',
        fromDate: RIG_DATE,
        toDate: RIG_DATE,
        startMinutes: 0,
        endMinutes: 1380,
        allDay: true,
        scope: { kind: 'venue-unknown', venueName: 'Nowhere Park' },
        reason: 'lost',
      },
    ],
  })
);
harvest('checkClosures(inside every window)', checkClosures(rig, closureRig, rigBooking()));
harvest(
  'checkClosures(no end, kicking off before a timed closure opens)',
  checkClosures(rig, closureRig, rigBooking({ startMinutes: 500, endMinutes: null }))
);

harvest(
  'checkKickoffAvailability(nothing declared)',
  checkKickoffAvailability(rig, rigTable, emptyCalendar, kickoffQuery())
);
harvest(
  'checkKickoffAvailability(lighting undeclared at the venue)',
  checkKickoffAvailability(
    buildFacilityGraph({
      venues: [{ id: 'rig', name: 'Rig Park', lit: null }],
      surfaces: [{ id: 'rig/half', venueId: 'rig', name: 'Half', sizes: ['9v9'], lined: ['9v9'] }],
    }),
    rigTable,
    openCalendar,
    kickoffQuery()
  )
);
harvest(
  'checkKickoffAvailability(inside the permit)',
  checkKickoffAvailability(rig, rigTable, openCalendar, kickoffQuery())
);
harvest(
  'checkKickoffAvailability(blackout on the date)',
  checkKickoffAvailability(
    rig,
    rigTable,
    buildAvailabilityCalendar({
      permitWindows: [
        permit({
          id: 'shut',
          scopeKind: 'date-exception',
          weekday: null,
          date: RIG_DATE,
          hasPermit: false,
          openMinutes: null,
          closeMinutes: null,
        }),
      ],
    }),
    kickoffQuery()
  )
);
harvest(
  'checkKickoffAvailability(before open, past close)',
  checkKickoffAvailability(
    rig,
    rigTable,
    buildAvailabilityCalendar({ permitWindows: [permit({ openMinutes: 660, closeMinutes: 664 })] }),
    kickoffQuery()
  )
);
harvest(
  'checkKickoffAvailability(margin tight)',
  checkKickoffAvailability(
    rig,
    rigTable,
    buildAvailabilityCalendar({ permitWindows: [permit({ closeMinutes: 670 })] }),
    kickoffQuery()
  )
);
harvest(
  'checkKickoffAvailability(two date exceptions disagree)',
  checkKickoffAvailability(
    rig,
    rigTable,
    buildAvailabilityCalendar({
      permitWindows: [
        permit({ id: 'a', scopeKind: 'date-exception', weekday: null, date: RIG_DATE }),
        permit({
          id: 'b',
          scopeKind: 'date-exception',
          weekday: null,
          date: RIG_DATE,
          closeMinutes: 900,
        }),
      ],
    }),
    kickoffQuery()
  )
);
harvest(
  'checkKickoffAvailability(sunset margin violated)',
  checkKickoffAvailability(
    rig,
    rigTable,
    buildAvailabilityCalendar({
      permitWindows: [permit()],
      sunsets: [sunset({ sunsetMinutes: 620 })],
    }),
    kickoffQuery()
  )
);
harvest(
  'checkKickoffAvailability(lit surface, lights-off undeclared)',
  checkKickoffAvailability(
    rig,
    rigTable,
    buildAvailabilityCalendar({
      permitWindows: [permit({ lit: false })],
      lighting: [{ surfaceId: 'rig/half', lit: true }],
    }),
    kickoffQuery()
  )
);
harvest(
  'checkKickoffAvailability(lit ancestor, lights off early)',
  checkKickoffAvailability(
    rig,
    rigTable,
    buildAvailabilityCalendar({
      permitWindows: [permit()],
      lighting: [{ surfaceId: 'rig/full', lit: true, lightsOffMinutes: 620 }],
    }),
    kickoffQuery()
  )
);
harvest(
  'checkKickoffAvailability(lit venue)',
  checkKickoffAvailability(litRig, rigTable, openCalendar, kickoffQuery())
);
harvest(
  'checkKickoffAvailability(a booking bounds the occupancy)',
  checkKickoffAvailability(rig, rigTable, openCalendar, kickoffQuery(), {
    existingBookings: [rigOccupied({ startMinutes: 700, endMinutes: 800 })],
  })
);
harvest(
  'latestLegalKickoff(bounded)',
  latestLegalKickoff(rig, rigTable, openCalendar, {
    surfaceId: 'rig/half',
    date: RIG_DATE,
    format: '9v9',
  })
);
harvest(
  'latestLegalKickoff(nothing legal)',
  latestLegalKickoff(
    rig,
    rigTable,
    buildAvailabilityCalendar({ permitWindows: [permit({ openMinutes: 480, closeMinutes: 500 })] }),
    { surfaceId: 'rig/half', date: RIG_DATE, format: '9v9' }
  )
);

/* -- constraints ---------------------------------------------------------- */

/** A minimal valid constraint record; each case below changes one field. */
const constraintRecord = (overrides = {}) => ({
  id: 'rig-constraint',
  policy: 'rig-policy',
  name: 'A constraint the audit reasons about',
  type: CONSTRAINT_TYPE.HARD,
  scope: { kind: CONSTRAINT_SCOPE_KIND.GLOBAL },
  rationale: 'the audit needs a governed reason code to ask questions about',
  source: {
    setBy: 'the reason-code reachability audit',
    setAt: '2026-08-20',
    reference: 'tests/reasonCodeReachability.test.js',
  },
  enforcement: CONSTRAINT_ENFORCEMENT.REASON_CODES,
  reasonCodes: [FACILITY_REASON.LINING_MISMATCH],
  ...overrides,
});
const registryOf = (...constraints) => buildConstraintRegistry({ name: 'rig', constraints });

harvest(
  'buildConstraintRegistry(empty)',
  buildConstraintRegistry({ name: 'rig', constraints: [] })
);
harvest(
  'buildConstraintRegistry(duplicate id)',
  registryOf(constraintRecord(), constraintRecord({ policy: 'other' }))
);
harvest(
  'buildConstraintRegistry(unknown reason code)',
  registryOf(constraintRecord({ reasonCodes: ['NOT_A_REGISTERED_CODE'] }))
);
harvest(
  'buildConstraintRegistry(declared only)',
  registryOf(
    constraintRecord({ enforcement: CONSTRAINT_ENFORCEMENT.DECLARED_ONLY, reasonCodes: [] })
  )
);
harvest(
  'retypeConstraint(hard to soft)',
  retypeConstraint(registryOf(constraintRecord()), 'rig-constraint', {
    type: CONSTRAINT_TYPE.SOFT,
    by: 'the reason-code reachability audit',
    at: null,
    note: 'what if this were a preference?',
    weight: 1,
  })
);

/** Windows and scopes, judged with and without the context to judge them by. */
const windowedRegistry = registryOf(
  constraintRecord({ id: 'not-yet', effectiveFrom: '2026-12-01' }),
  constraintRecord({ id: 'expired', effectiveTo: '2026-01-01', policy: 'rig-policy' }),
  constraintRecord({
    id: 'at-a-venue',
    scope: { kind: CONSTRAINT_SCOPE_KIND.VENUE, venueId: 'rig' },
  }),
  constraintRecord({
    id: 'in-a-division',
    scope: { kind: CONSTRAINT_SCOPE_KIND.DIVISION, divisionLabel: 'U12B' },
  })
);
harvest('resolvePolicy(no date, no scope context)', resolvePolicy(windowedRegistry, 'rig-policy'));
harvest(
  'resolvePolicy(dated and scoped)',
  resolvePolicy(windowedRegistry, 'rig-policy', {
    date: RIG_DATE,
    venueId: 'rig',
    divisionLabel: 'U12B',
  })
);
harvest('resolvePolicy(ungoverned policy)', resolvePolicy(windowedRegistry, 'no-such-policy'));
harvest('resolveConstraints(dated)', resolveConstraints(windowedRegistry, { date: RIG_DATE }));

/** Severity: one code claimed by two records of different hardness. */
const contested = registryOf(
  constraintRecord({ id: 'as-hard', type: CONSTRAINT_TYPE.HARD }),
  constraintRecord({
    id: 'as-preference',
    type: CONSTRAINT_TYPE.PREFERENCE,
    policy: 'rig-policy',
    weight: 1,
  })
);
harvest('effectiveSeverityTable(contested code)', effectiveSeverityTable(contested, {}));
harvest(
  'resolvePolicy(two global records of one hardness that disagree)',
  resolvePolicy(
    registryOf(
      constraintRecord({ id: 'ninety', parameters: { minutes: 90 } }),
      constraintRecord({ id: 'sixty', parameters: { minutes: 60 } })
    ),
    'rig-policy'
  )
);
harvest(
  'effectiveSeverityTable(demoted code)',
  effectiveSeverityTable(
    registryOf(constraintRecord({ type: CONSTRAINT_TYPE.PREFERENCE, weight: 1 })),
    {}
  )
);
harvest(
  'whatIfConstraintType(no-op)',
  whatIfConstraintType(registryOf(constraintRecord()), 'rig-constraint', CONSTRAINT_TYPE.HARD)
);
harvest(
  'whatIfConstraintType(nothing to reseverify)',
  whatIfConstraintType(registryOf(constraintRecord()), 'rig-constraint', CONSTRAINT_TYPE.SOFT, {
    evaluations: [{ id: 'a-subject-the-constraint-says-nothing-about', findings: [] }],
  })
);

/* -- waivers and coach travel --------------------------------------------- */

/** A waivable constraint to hang waivers off, and one that is not waivable. */
const waivableRegistry = registryOf(
  constraintRecord({ id: 'waivable', waivable: true }),
  constraintRecord({ id: 'not-waivable', policy: 'rig-policy-2', waivable: false })
);

const waiverRecord = (overrides = {}) => ({
  id: 'rig-waiver',
  constraintId: 'waivable',
  name: 'A waiver the audit reasons about',
  scope: { divisionLabel: 'U12B' },
  reasonCodes: [FACILITY_REASON.LINING_MISMATCH],
  reason: 'the audit needs a granted exception to ask questions about',
  approval: {
    approvedBy: 'the reason-code reachability audit',
    approvedAt: '2026-08-20',
    reference: 'tests/reasonCodeReachability.test.js',
  },
  ...overrides,
});
const ledgerOf = (...waivers) => buildWaiverLedger({ name: 'rig', waivers });

harvest('buildWaiverLedger(empty)', buildWaiverLedger({ name: 'rig', waivers: [] }));
harvest(
  'buildWaiverLedger(duplicate id)',
  ledgerOf(waiverRecord(), waiverRecord({ scope: { teamId: 'team-a' } }))
);
harvest(
  'reconcileWaiverLedger(unknown and un-waivable constraints)',
  reconcileWaiverLedger(
    ledgerOf(
      waiverRecord({ id: 'orphan', constraintId: 'no-such-constraint' }),
      waiverRecord({ id: 'barred', constraintId: 'not-waivable' }),
      waiverRecord({ id: 'unclaimed', reasonCodes: [FACILITY_REASON.SIZE_TOO_SMALL] })
    ),
    waivableRegistry
  )
);

/** One subject per shape of applicability question. */
/**
 * The codes the waiver subjects below hand in. `applyWaivers()` returns them
 * annotated rather than emitting them, so {@link harvest} is told to refuse
 * them: a facility code the facility module stopped producing must not read as
 * covered because a waiver echoed the driver's own input back.
 */
const PLANTED_WAIVER_CODES = [FACILITY_REASON.LINING_MISMATCH, FACILITY_REASON.SIZE_TOO_SMALL];

const waivedFinding = makeFacilityFinding(
  FACILITY_REASON.LINING_MISMATCH,
  'the pitch is not lined for this format',
  { surfaceId: 'rig/half' }
);
const subject = (overrides = {}) => ({
  id: 'rig-subject',
  findings: [waivedFinding],
  context: { divisionLabel: 'U12B', date: RIG_DATE },
  ...overrides,
});
const waiverOptions = {
  ledger: ledgerOf(
    waiverRecord(),
    waiverRecord({ id: 'not-yet', effectiveFrom: '2026-12-01', scope: { teamId: 'team-a' } }),
    waiverRecord({ id: 'expired', effectiveTo: '2026-01-01', scope: { teamId: 'team-b' } }),
    waiverRecord({ id: 'by-person', scope: { personId: 'person-1' } })
  ),
  registry: waivableRegistry,
  constraintIdByCode: { [FACILITY_REASON.LINING_MISMATCH]: 'waivable' },
};
harvest(
  'applyWaivers(a waiver covers the finding)',
  applyWaivers([subject()], waiverOptions),
  PLANTED_WAIVER_CODES
);
harvest(
  'applyWaivers(no date, no person in the context)',
  applyWaivers([subject({ context: { divisionLabel: 'U12B' } })], waiverOptions),
  PLANTED_WAIVER_CODES
);
harvest(
  'applyWaivers(nothing the ledger covers)',
  applyWaivers(
    [
      subject({
        findings: [
          makeFacilityFinding(FACILITY_REASON.SIZE_TOO_SMALL, 'the ground is too small', {}),
        ],
      }),
    ],
    waiverOptions
  ),
  PLANTED_WAIVER_CODES
);
harvest(
  'applyWaivers(a waiver broader than its constraint)',
  applyWaivers([subject({ context: { venueId: 'rig', surfaceId: 'rig/half', date: RIG_DATE } })], {
    ledger: ledgerOf(waiverRecord({ scope: { venueIds: ['rig'] } })),
    registry: registryOf(
      constraintRecord({
        id: 'waivable',
        waivable: true,
        scope: { kind: CONSTRAINT_SCOPE_KIND.SURFACE, surfaceId: 'rig/half' },
      })
    ),
    constraintIdByCode: { [FACILITY_REASON.LINING_MISMATCH]: 'waivable' },
  }),
  PLANTED_WAIVER_CODES
);
harvest(
  'applyWaivers(a waived code, but no waiver in scope)',
  applyWaivers([subject({ context: { divisionLabel: 'U14G', date: RIG_DATE } })], waiverOptions),
  PLANTED_WAIVER_CODES
);
harvest(
  'detectDormantWaivers(over the subjects)',
  detectDormantWaivers([subject()], waiverOptions),
  PLANTED_WAIVER_CODES
);
harvest(
  'detectDormantWaivers(over nothing)',
  detectDormantWaivers([], waiverOptions),
  PLANTED_WAIVER_CODES
);

/* Coach travel: the policy the registry governs, and the same scan ungoverned. */
const commitment = (overrides = {}) => ({
  id: 'commitment',
  personId: 'person-1',
  date: RIG_DATE,
  startMinutes: 540,
  endMinutes: 600,
  venueId: 'rig',
  ...overrides,
});
harvest(
  'evaluateCoachTravel(same venue, no time to walk)',
  evaluateCoachTravel(
    [commitment(), commitment({ id: 'next', startMinutes: 605, endMinutes: 665 })],
    {
      registry,
    }
  )
);
harvest(
  'evaluateCoachTravel(a commitment with no known end)',
  evaluateCoachTravel(
    [
      commitment({ endMinutes: null }),
      commitment({ id: 'next', startMinutes: 605, endMinutes: 665 }),
    ],
    { registry }
  )
);
harvest(
  'evaluateCoachTravel(no travel policy in the registry)',
  evaluateCoachTravel(
    [commitment(), commitment({ id: 'next', startMinutes: 605, endMinutes: 665 })],
    { registry: registryOf(constraintRecord()) }
  )
);
harvest('evaluateCoachTravel(nothing to judge)', evaluateCoachTravel([], { registry }));

/* -- freeze --------------------------------------------------------------- */

const freezeRule = (overrides = {}) => ({
  id: 'freeze-rule',
  kind: 'freeze',
  match: { divisionLabel: 'U12B' },
  reason: 'the audit needs a frozen scope to ask questions about',
  ...overrides,
});
const freezeContext = (overrides = {}) => ({
  gameId: 'g1',
  date: RIG_DATE,
  divisionLabel: 'U12B',
  venueId: 'rig',
  surfaceId: 'rig/half',
  teamId: 'team-a',
  ...overrides,
});

harvest(
  'buildFreezePlan(global re-optimisation, acknowledged)',
  buildFreezePlan({
    name: 'rig',
    defaultDisposition: 'thawed',
    rules: [],
    globalReoptimisation: {
      reason: 'the audit asks what a declared whole-season re-solve reports',
      acknowledged: true,
      requestedBy: 'the reason-code reachability audit',
    },
  })
);

const mixedPlan = buildFreezePlan({
  name: 'rig',
  rules: [
    freezeRule({ id: 'freeze-one-game', match: { gameId: 'g1' } }),
    freezeRule({ id: 'thaw-the-division', kind: 'thaw', match: { divisionLabel: 'U12B' } }),
    freezeRule({ id: 'freeze-by-format', match: { format: '9v9' } }),
    freezeRule({ id: 'freeze-nothing-here', match: { venueId: 'elsewhere' } }),
  ],
});
harvest(
  'judgeFreezeAll(a plan whose rules disagree)',
  judgeFreezeAll(mixedPlan, [
    freezeContext(),
    freezeContext({ gameId: 'g2', divisionLabel: 'U14G' }),
  ])
);
harvest(
  'judgeFreeze(a game carrying no format for a format rule)',
  judgeFreeze(mixedPlan, freezeContext({ gameId: 'g3' }))
);
harvest(
  'judgeFreeze(a thaw that ties the freeze it opposes)',
  judgeFreeze(
    buildFreezePlan({
      name: 'rig',
      rules: [
        freezeRule({ id: 'freeze-the-division', match: { divisionLabel: 'U12B' } }),
        freezeRule({ id: 'thaw-the-venue', kind: 'thaw', match: { venueId: 'rig' } }),
      ],
    }),
    freezeContext()
  )
);
harvest(
  'judgeFreeze(nothing matches, the default applies)',
  judgeFreeze(
    mixedPlan,
    freezeContext({ gameId: 'g4', divisionLabel: 'U16B', venueId: 'far-away', format: '11v11' })
  )
);

/* -- rule engine ---------------------------------------------------------- */

/** A minimal valid rule definition; each case below breaks one part of it. */
const ruleDefinition = (overrides = {}) => ({
  id: 'rig-rule',
  title: 'A rule the audit runs',
  constraintIds: [],
  reasonCodes: [],
  exercise: {
    minimums: { thingsExamined: 1 },
    coverage: {},
    identifierKinds: [],
    rationale: 'a rule that examined nothing has not examined this schedule',
  },
  rationale: 'exists so the engine has something to run',
  evaluate: () => ({ subjects: [], findings: [], counters: { thingsExamined: 1 }, matched: {} }),
  ...overrides,
});

/** A schedule small enough to reason about and broken in named ways. */
const rigGame = (overrides = {}) => ({
  id: 'g1',
  date: RIG_DATE,
  startMinutes: 540,
  endMinutes: 600,
  venueId: 'rig',
  surfaceId: 'rig/half',
  format: '9v9',
  divisionLabel: 'U12B',
  homeTeamId: 'team-a',
  awayTeamId: 'team-b',
  homeLabel: 'team-a',
  awayLabel: 'team-b',
  ...overrides,
});
const rigSchedule = (overrides = {}) => ({
  name: 'rig schedule',
  games: [rigGame(), rigGame({ id: 'g2', startMinutes: 600, endMinutes: 660 })],
  commitments: [],
  teams: [
    { id: 'team-a', divisionLabel: 'U12B', groupLabel: 'U12B' },
    { id: 'team-b', divisionLabel: 'U12B', groupLabel: 'U12B' },
    { id: 'team-c', divisionLabel: 'U12B', groupLabel: 'U12B' },
  ],
  teamUniverse: ['team-a', 'team-b', 'team-c'],
  personUniverse: ['person-1'],
  divisionUniverse: ['U12B'],
  surfaceUniverse: ['rig/half'],
  venueUniverse: ['rig'],
  placeholderLabels: ['-'],
  ...overrides,
});

harvest('buildRuleEngine(no rules)', buildRuleEngine({ name: 'rig', rules: [] }));
harvest(
  'buildRuleEngine(duplicate id, unknown constraint)',
  buildRuleEngine({
    name: 'rig',
    rules: [
      ruleDefinition(),
      ruleDefinition({ constraintIds: ['no-such-constraint'], title: 'The same id again' }),
    ],
  })
);

const brokenEngine = buildRuleEngine({
  name: 'rig',
  rules: [
    ruleDefinition({
      id: 'examined-too-little',
      evaluate: () => ({
        subjects: [],
        findings: [],
        counters: { thingsExamined: 0 },
        matched: {},
      }),
    }),
    ruleDefinition({
      id: 'counted-nothing',
      evaluate: () => ({ subjects: [], findings: [], counters: {}, matched: {} }),
    }),
    ruleDefinition({
      id: 'covered-too-little',
      exercise: {
        minimums: {},
        coverage: { divisionsExamined: 'division' },
        identifierKinds: [],
        rationale: 'a rule that skipped a division has not judged the season',
      },
      evaluate: () => ({
        subjects: [],
        findings: [],
        counters: { divisionsExamined: 0 },
        matched: { divisionsExamined: [] },
      }),
    }),
    ruleDefinition({
      id: 'matched-a-placeholder',
      exercise: {
        minimums: { teamsExamined: 1 },
        coverage: {},
        identifierKinds: ['team'],
        rationale: 'a rule reading labels as ids reports violations that do not exist',
      },
      evaluate: () => ({
        subjects: [],
        findings: [],
        counters: { teamsExamined: 2 },
        matched: { team: ['-', 'not-a-team'] },
      }),
    }),
    ruleDefinition({
      id: 'threw',
      evaluate: () => {
        throw new Error('the audit made this rule throw on purpose');
      },
    }),
  ],
});
const brokenRun = harvest(
  'runRuleEngine(rules that cannot prove they looked)',
  runRuleEngine(rigSchedule(), { registry, resources, engine: brokenEngine })
);
harvest('buildValidationReport(a run nothing exercised)', buildValidationReport(brokenRun, {}));
harvest(
  'runRuleEngine(an empty schedule)',
  runRuleEngine(rigSchedule({ games: [], teams: [], teamUniverse: [] }), { registry, resources })
);

/** The standing rules over a schedule that breaks each of them. */
harvest(
  'runRuleEngine(a lopsided, incomplete, back-to-back schedule)',
  runRuleEngine(
    rigSchedule({
      commitments: [
        {
          id: 'c1',
          personId: 'person-1',
          date: RIG_DATE,
          startMinutes: 540,
          endMinutes: 600,
          venueId: 'rig',
          surfaceId: 'rig/half',
          teamId: 'team-a',
          gameId: 'g1',
        },
        {
          id: 'c2',
          personId: 'person-1',
          date: RIG_DATE,
          startMinutes: 545,
          endMinutes: 605,
          venueId: 'elsewhere',
          surfaceId: null,
          teamId: 'team-b',
          gameId: 'g2',
        },
      ],
    }),
    { registry, resources }
  )
);
harvest(
  'runRuleEngine(conflicts piled on one team)',
  runRuleEngine(
    rigSchedule({
      personUniverse: ['person-1', 'person-2'],
      teams: [
        {
          id: 'team-a',
          divisionLabel: 'U12B',
          groupLabel: 'U12B',
          personIds: ['person-1', 'person-2'],
        },
        {
          id: 'team-b',
          divisionLabel: 'U12B',
          groupLabel: 'U12B',
          personIds: ['person-1', 'person-2'],
        },
        {
          id: 'team-c',
          divisionLabel: 'U12B',
          groupLabel: 'U12B',
          personIds: ['person-1', 'person-2'],
        },
      ],
      commitments: [
        ['person-1', 'team-a', 540, 600, 'c1'],
        ['person-1', 'team-b', 545, 605, 'c2'],
        ['person-2', 'team-a', 700, 760, 'c3'],
        ['person-2', 'team-b', 705, 765, 'c4'],
      ].map(([personId, teamId, startMinutes, endMinutes, id]) => ({
        id: /** @type {string} */ (id),
        personId: /** @type {string} */ (personId),
        date: RIG_DATE,
        startMinutes: /** @type {number} */ (startMinutes),
        endMinutes: /** @type {number} */ (endMinutes),
        venueId: 'rig',
        surfaceId: 'rig/half',
        teamId: /** @type {string} */ (teamId),
        gameId: /** @type {string} */ (id),
      })),
    }),
    { registry, resources }
  )
);
harvest(
  'runRuleEngine(the same schedule, no turnover policy)',
  runRuleEngine(rigSchedule(), { registry: registryOf(constraintRecord()), resources })
);

/* -- people --------------------------------------------------------------- */

const person = (id, givenName, familyName) => ({
  id,
  givenName,
  familyName,
  displayName: `${givenName} ${familyName}`,
  aliases: [],
});
const assignment = (personId, teamId, slot, overrides = {}) => ({
  id: `${teamId}|${personId}|${slot}`,
  personId,
  teamId,
  slot,
  status: ASSIGNMENT_STATUS.ASSIGNED,
  source: 'the reason-code reachability audit',
  ...overrides,
});

harvest(
  'buildCoachRoster(every assignment declined)',
  buildCoachRoster({
    people: [person('p1', 'Ada', 'Stone')],
    assignments: [assignment('p1', 'team-a', 1, { status: ASSIGNMENT_STATUS.DECLINED })],
  })
);
harvest(
  'buildCoachRoster(duplicate slot, duplicate person, unknown person, unjudged window)',
  buildCoachRoster({
    people: [person('p1', 'Ada', 'Stone'), person('p2', 'Bo', 'Stone')],
    assignments: [
      assignment('p1', 'team-a', 1),
      assignment('p2', 'team-a', 1),
      assignment('p1', 'team-a', 2),
      assignment('ghost', 'team-a', 3),
      assignment('p1', 'team-b', 1, { id: 'windowed', effectiveTo: '2026-09-30' }),
    ],
  })
);

// The one coach model. Two sources for one team that disagree about the order,
// disagree about the membership, and leave one coach unranked; plus a team
// nobody names at all, so the vacuous-scan code has a path too.
harvest(
  'reconcileTeamCoaches(two sources that disagree about order and membership)',
  reconcileTeamCoaches({
    teamId: 'team-a',
    sources: [
      {
        sourceId: 'roster-sheet',
        coaches: [
          { personId: 'p1', slot: 1 },
          { personId: 'p2', slot: 2 },
        ],
      },
      {
        sourceId: 'select-sheet',
        coaches: [
          { personId: 'p2', slot: 1 },
          { personId: 'p3', slot: null },
        ],
      },
    ],
  })
);
harvest(
  'reconcileTeamCoaches(one source, so the order is unchecked rather than agreed)',
  reconcileTeamCoaches({
    teamId: 'team-b',
    sources: [{ sourceId: 'roster-sheet', coaches: [{ personId: 'p1', slot: 1 }] }],
  })
);
harvest(
  'reconcileTeamCoaches(no source at all)',
  reconcileTeamCoaches({ teamId: 'team-c', sources: [] })
);
// A row that can only name its coach: exported, and excluded from the clash
// keys with the reason said out loud.
harvest(
  'coachesOfTeamRow(a legacy row carrying a coach name and no id)',
  coachesOfTeamRow({ id: 'team-d', coachId: null, coachName: 'Only A Name' })
);

/** A roster whose one team has a coach who is alone on two teams. */
const soleRoster = buildCoachRoster({
  people: [person('p1', 'Ada', 'Stone'), person('p2', 'Bo', 'Stone')],
  assignments: [
    assignment('p1', 'team-a', 1),
    assignment('p1', 'team-b', 1),
    assignment('p2', 'team-c', 1, { status: ASSIGNMENT_STATUS.DECLINED }),
  ],
});
harvest('soleCoachRiskRegister(a coach alone on two teams)', soleCoachRiskRegister(soleRoster));
harvest(
  'soleCoachRiskRegister(a roster with no teams at all)',
  soleCoachRiskRegister(
    buildCoachRoster({ people: [person('p1', 'Ada', 'Stone')], assignments: [] })
  )
);

/** A roster with a co-coach, for the fallback questions. */
const coveredRoster = buildCoachRoster({
  people: [person('p1', 'Ada', 'Stone'), person('p2', 'Bo', 'Stone'), person('p3', 'Cy', 'Stone')],
  assignments: [
    assignment('p1', 'team-a', 1),
    assignment('p2', 'team-a', 2),
    assignment('p1', 'team-b', 1),
    assignment('p3', 'team-b', 2),
  ],
});

const peopleCommitment = (overrides = {}) => ({
  id: 'c1',
  personId: 'p1',
  date: RIG_DATE,
  startMinutes: 540,
  endMinutes: 600,
  venueId: 'rig',
  surfaceId: 'rig/half',
  teamId: 'team-a',
  gameId: 'g1',
  label: null,
  source: COMMITMENT_SOURCE.CLUB_FIXTURE,
  ...overrides,
});

harvest(
  'ingestCommitments(an empty batch)',
  ingestCommitments(createTimelineSet(), [], { source: COMMITMENT_SOURCE.SCRIMMAGE })
);
const openSet = ingestCommitments(
  createTimelineSet(),
  [
    peopleCommitment(),
    peopleCommitment({
      id: 'c2',
      teamId: 'team-b',
      gameId: 'g2',
      startMinutes: 590,
      endMinutes: 650,
    }),
    peopleCommitment({
      id: 'c3',
      teamId: 'team-b',
      gameId: 'g3',
      startMinutes: 900,
      endMinutes: null,
    }),
  ],
  { source: COMMITMENT_SOURCE.CLUB_FIXTURE }
);
harvest('buildPersonDays(a set nobody sealed)', buildPersonDays(openSet));
harvest('requireSealedTimelines(a set nobody sealed)', requireSealedTimelines(openSet));
harvest(
  'sealTimelines(a source that was never ingested)',
  sealTimelines(openSet, {
    requiredSources: [COMMITMENT_SOURCE.CLUB_FIXTURE, COMMITMENT_SOURCE.EXTERNAL_FIXTURE],
  })
);
const sealedSet = sealTimelines(openSet, { requiredSources: [COMMITMENT_SOURCE.CLUB_FIXTURE] });
harvest(
  'ingestCommitments(appending to a sealed set)',
  ingestCommitments(sealedSet, [peopleCommitment({ id: 'late' })], {
    source: COMMITMENT_SOURCE.SCRIMMAGE,
  })
);
harvest('evaluatePersonDays(a governed registry)', evaluatePersonDays(sealedSet, { registry }));
harvest(
  'evaluatePersonDays(a registry with no gap policy)',
  evaluatePersonDays(sealedSet, { registry: registryOf(constraintRecord()) })
);
harvest(
  'evaluatePersonDays(a set with no commitments at all)',
  evaluatePersonDays(
    sealTimelines(
      ingestCommitments(createTimelineSet(), [], { source: COMMITMENT_SOURCE.CLUB_FIXTURE }),
      {
        requiredSources: [COMMITMENT_SOURCE.CLUB_FIXTURE],
      }
    ),
    { registry }
  )
);

/** Declared personal constraints, and the must-attend verdicts they produce. */
const personalSource = {
  setBy: 'the reason-code reachability audit',
  setAt: '2026-08-20',
  reference: 'tests/reasonCodeReachability.test.js',
};
const personalPolicy = buildPersonalConstraintPolicy({
  constraints: [
    {
      id: 'cannot-split',
      personId: 'p1',
      kind: 'cannot-split',
      teamIds: ['team-a'],
      fromDate: RIG_DATE,
      toDate: RIG_DATE,
      rationale: 'the audit needs a declared personal constraint to read',
      source: personalSource,
    },
    {
      id: 'unavailable',
      personId: 'p2',
      kind: 'unavailable',
      rationale: 'a co-coach the operator recorded as unavailable is not a fallback',
      source: personalSource,
    },
    {
      id: 'unavailable-too',
      personId: 'p3',
      kind: 'unavailable',
      rationale: 'the only other coach of the released team is unavailable as well',
      source: personalSource,
    },
    {
      id: 'about-a-stranger',
      personId: 'nobody-on-the-roster',
      kind: 'unavailable',
      rationale: 'a constraint about somebody the roster does not know',
      source: personalSource,
    },
  ],
});
harvest(
  'deriveMustAttend(no date to judge the window with)',
  deriveMustAttend({ roster: coveredRoster, policy: personalPolicy })
);
harvest(
  'deriveMustAttend(no declared policy at all)',
  deriveMustAttend({ roster: coveredRoster, date: RIG_DATE })
);
const mustAttend = deriveMustAttend({
  roster: coveredRoster,
  policy: personalPolicy,
  date: RIG_DATE,
});
harvest('deriveMustAttend(dated)', mustAttend);

const clashes = findAttendanceClashes(sealedSet);
harvest(
  'resolveAttendance(a clash with a co-coach recorded unavailable)',
  resolveAttendance({
    roster: coveredRoster,
    timelines: sealedSet,
    clashes,
    mustAttend: mustAttend.byPerson,
    policy: personalPolicy,
  })
);
harvest(
  'resolveAttendance(a clash on a roster nobody else covers)',
  resolveAttendance({ roster: soleRoster, timelines: sealedSet, clashes })
);
/** A second rig where the ranks differ, and one commitment names no rostered team. */
const rankedRoster = buildCoachRoster({
  people: [person('p1', 'Ada', 'Stone'), person('p2', 'Bo', 'Stone')],
  assignments: [
    assignment('p1', 'team-a', 1),
    assignment('p1', 'team-b', 2),
    assignment('p2', 'team-b', 1),
  ],
});
const rankedSet = sealTimelines(
  ingestCommitments(
    createTimelineSet(),
    [
      peopleCommitment(),
      peopleCommitment({
        id: 'c2',
        teamId: 'team-b',
        gameId: 'g2',
        startMinutes: 590,
        endMinutes: 650,
      }),
      peopleCommitment({
        id: 'c3',
        teamId: 'team-z',
        gameId: 'g3',
        startMinutes: 595,
        endMinutes: 655,
      }),
    ],
    { source: COMMITMENT_SOURCE.CLUB_FIXTURE }
  ),
  { requiredSources: [COMMITMENT_SOURCE.CLUB_FIXTURE] }
);
harvest(
  'resolveAttendance(ranks that differ, and a team the roster does not know)',
  resolveAttendance({
    roster: rankedRoster,
    timelines: rankedSet,
    clashes: findAttendanceClashes(rankedSet),
  })
);
harvest(
  'resolveAttendance(no clashes to resolve)',
  resolveAttendance({
    roster: coveredRoster,
    timelines: sealTimelines(
      ingestCommitments(createTimelineSet(), [], { source: COMMITMENT_SOURCE.CLUB_FIXTURE }),
      { requiredSources: [COMMITMENT_SOURCE.CLUB_FIXTURE] }
    ),
    clashes: [],
  })
);

/** Identity review: near-duplicate names, then a decision on each proposal. */
const identityQueue = harvest(
  'buildIdentityReviewQueue(two spellings of one name)',
  buildIdentityReviewQueue(
    [
      person('p1', 'Ada', 'Stone'),
      person('p2', 'Adaline', 'Stone'),
      person('p3', 'Bea', 'Rivers'),
      person('p4', 'Beatrice', 'Rivers'),
    ],
    {
      assignmentsByPerson: new Map([
        ['p1', [{ teamId: 'team-a' }]],
        ['p2', [{ teamId: 'team-b' }]],
        ['p3', [{ teamId: 'team-c' }]],
        ['p4', [{ teamId: 'team-c' }]],
      ]),
    }
  )
);
harvest(
  'buildIdentityReviewQueue(one person, so no pair to compare)',
  buildIdentityReviewQueue([person('p1', 'Ada', 'Stone')])
);
harvest(
  'applyIdentityDecisions(one accepted, one about an entry that is not there)',
  applyIdentityDecisions(identityQueue, [
    ...identityQueue.entries.map((entry) => ({
      entryId: entry.id,
      state: 'accepted',
      decidedBy: 'the reason-code reachability audit',
      decidedAt: '2026-08-20',
    })),
    {
      entryId: 'no-such-entry',
      state: 'rejected',
      decidedBy: 'the reason-code reachability audit',
      decidedAt: '2026-08-20',
    },
  ])
);

/**
 * The corpus's own roster with one team's coaches declined — incident 10's
 * shape, built by changing the *input rows*, never the built roster.
 */
const rosterRows = loadCoachRoster();
const uncoachedTeamCode = rosterRows[0].teamCode;
const uncoachedRoster = buildSeason2026CoachRoster(
  rosterRows.map((row) =>
    row.teamCode === uncoachedTeamCode ? { ...row, status: 'Declined' } : row
  )
);
harvest(
  'soleCoachRiskRegister(the corpus roster, one team declined)',
  soleCoachRiskRegister(uncoachedRoster)
);
harvest(
  'season2026UncoachedFixtures(the fixtures that team loses)',
  season2026UncoachedFixtures(season, uncoachedRoster)
);

/* -- resolve -------------------------------------------------------------- */

const engines = { graph, table: timingTable, calendar, registry, resources };
const externalChanges = season2026ExternalFixtureChanges(loadExternalFixtures(), schedule);
/** Derived from the corpus, so a re-dated fixture moves it. */
const RESOLVE_DATE = [...new Set(externalChanges.map((change) => change.date))].sort()[0];
const onDate = schedule.games
  .filter((game) => game.date === RESOLVE_DATE && game.format === '9v9')
  .sort((a, b) => a.startMinutes - b.startMinutes || a.surfaceId.localeCompare(b.surfaceId));
const KICKOFFS = [...new Set(onDate.map((game) => game.startMinutes))].sort((a, b) => a - b);
const movers = onDate.filter((game) => game.startMinutes === KICKOFFS[1]);
const anchor = onDate[0];

/** The knock-on run: the late 9v9 block asks for the early kickoff it already holds. */
harvest(
  'applyChangeRequest(a block that displaces what already stands there)',
  applyChangeRequest({
    schedule,
    changes: movers.map((game) => ({
      gameId: game.id,
      date: RESOLVE_DATE,
      surfaceId: game.surfaceId,
      startMinutes: KICKOFFS[0],
      reason: 'the 9v9 block moves instead of the externally published fixture',
    })),
    engines,
    freeze: freezeAllExcept([{ date: RESOLVE_DATE }]),
    baselineVerification: verification,
    holdChanges: true,
    onUnsatisfiable: 'report',
    changeBudget: 12,
  })
);
harvest(
  'applyChangeRequest(the same request under a budget of one)',
  applyChangeRequest({
    schedule,
    changes: movers.map((game) => ({
      gameId: game.id,
      date: RESOLVE_DATE,
      surfaceId: game.surfaceId,
      startMinutes: KICKOFFS[0],
      reason: 'the same request, under a budget it cannot meet',
    })),
    engines,
    freeze: freezeAllExcept([{ date: RESOLVE_DATE }]),
    baselineVerification: verification,
    holdChanges: true,
    onUnsatisfiable: 'report',
    changeBudget: 1,
  })
);
/* -- 8.6: the repair scope and the bounded neighbourhood ------------------ */

/**
 * Games the published corpus already carries a **blocking** finding for at
 * their own slot — the `Scrimmage` rows with no timing entry, which the
 * registry severities as `SIZE_UNKNOWN_FORMAT`. Found rather than named, so a
 * corpus that stops carrying them fails the meta-assertion below instead of
 * silently driving nothing.
 */
const SCOPE_STATE = createResolveState({
  games: schedule.games.map((game) => ({ ...game })),
  dispositions: Object.fromEntries(
    schedule.games.map((game) => [game.id, FREEZE_DISPOSITION.THAWED])
  ),
  inventory: buildSlotInventory(schedule.games),
  ledger: createResolveLedger(),
});
const alreadyIllegal = schedule.games.filter(
  (game) =>
    Object.keys(
      checkPlacement(engines, SCOPE_STATE, game.id, {
        date: game.date,
        surfaceId: game.surfaceId,
        startMinutes: game.startMinutes,
      }).blockingCodeCounts
    ).length > 0
);
if (alreadyIllegal.length === 0) {
  throw new Error(
    'reachability: no corpus game carries a baseline blocking finding, so the repair-scope codes cannot be driven from real data'
  );
}
const SCOPE_DATE = alreadyIllegal[0].date;
const SCOPED = alreadyIllegal.filter((game) => game.date === SCOPE_DATE).map((game) => game.id);
const SCOPE_NO_OP = /** @type {any} */ (schedule.games.find((game) => game.date === SCOPE_DATE));
/** A change that asks for the slot it already has: the run has to happen. */
const scopeNoOpChange = [
  {
    gameId: SCOPE_NO_OP.id,
    date: SCOPE_NO_OP.date,
    surfaceId: SCOPE_NO_OP.surfaceId,
    startMinutes: SCOPE_NO_OP.startMinutes,
    reason: 'a run has to happen for the repair scope to act on anything',
  },
];

harvest(
  'applyChangeRequest(a repair scope over games the schedule already broke)',
  applyChangeRequest({
    schedule,
    changes: scopeNoOpChange,
    engines,
    repairScope: SCOPED,
    freeze: freezeAllExcept([...SCOPED, SCOPE_NO_OP.id].map((gameId) => ({ gameId }))),
    verify: false,
    onUnsatisfiable: 'report',
  })
);

harvest(
  'applyChangeRequest(a repair scope over a game that carries nothing)',
  applyChangeRequest({
    schedule,
    changes: scopeNoOpChange,
    engines,
    repairScope: [
      /** @type {any} */ (
        schedule.games.find(
          (game) =>
            game.date === SCOPE_DATE && !SCOPED.includes(game.id) && game.id !== SCOPE_NO_OP.id
        )
      ).id,
    ],
    freeze: freezeAllExcept([{ date: SCOPE_DATE }]),
    verify: false,
    onUnsatisfiable: 'report',
  })
);

/**
 * A budget that bites **during** the repair rather than after it.
 *
 * One same-format game is stacked onto another's slot in the baseline and both
 * are put in the repair scope, so `local-search` has to answer for an accepted
 * clash; a third is requested onto a fourth's slot and pinned, which is the
 * ungated core. Under a cap the scoped relocations are refused before the
 * writer sees them, which is `RESOLVE_CHANGE_BUDGET_BOUND`. (Rebuilt in 8.6
 * PR 2: the pile-up construction it replaced only bit because the placer
 * could re-home a displaced game into a clash its published slot had carried —
 * see `tests/boundedLocalRepair.test.js`.) `tests/boundedLocalRepair.test.js` is where
 * the numbers are asserted; this only has to make the code fire.
 */
const BOUND_SCENARIO = (() => {
  const wave = schedule.games
    .filter((game) => game.date === RESOLVE_DATE && game.venueId === anchor.venueId)
    .filter((game) => game.startMinutes === KICKOFFS[0]);
  const head = wave[0];
  const [stacker, requested] = wave.filter(
    (game) => game.format === head.format && game.surfaceId !== head.surfaceId
  );
  const occupant = wave.find(
    (game) =>
      game.format === head.format &&
      game.id !== head.id &&
      game.id !== stacker?.id &&
      game.id !== requested?.id
  );
  if (!stacker || !requested || !occupant) return null;
  return {
    scope: [head.id, stacker.id],
    schedule: {
      ...schedule,
      games: schedule.games.map((game) =>
        game.id === stacker.id
          ? {
              ...game,
              surfaceId: head.surfaceId,
              startMinutes: head.startMinutes,
              endMinutes: head.startMinutes + (game.endMinutes - game.startMinutes),
            }
          : game
      ),
    },
    changes: [
      {
        gameId: requested.id,
        date: RESOLVE_DATE,
        surfaceId: occupant.surfaceId,
        startMinutes: occupant.startMinutes,
        reason: 'one game onto a slot another already holds',
      },
    ],
  };
})();
if (BOUND_SCENARIO === null) {
  throw new Error(
    'reachability: the corpus no longer offers a wave to stack, so RESOLVE_CHANGE_BUDGET_BOUND cannot be driven'
  );
}
harvest(
  'applyChangeRequest(a scoped accepted clash, under a budget that stops its repair)',
  applyChangeRequest({
    schedule: BOUND_SCENARIO.schedule,
    changes: BOUND_SCENARIO.changes,
    engines,
    freeze: freezeAllExcept([{ date: RESOLVE_DATE }]),
    holdChanges: true,
    repairScope: BOUND_SCENARIO.scope,
    changeBudget: 2,
    verify: false,
    onUnsatisfiable: 'report',
  })
);

harvest(
  'applyChangeRequest(unknown game, no-op, frozen game, slot off the inventory)',
  applyChangeRequest({
    schedule,
    changes: [
      {
        gameId: 'no-such-game',
        date: RESOLVE_DATE,
        surfaceId: anchor.surfaceId,
        startMinutes: 600,
      },
      {
        gameId: anchor.id,
        date: anchor.date,
        surfaceId: anchor.surfaceId,
        startMinutes: anchor.startMinutes,
      },
      {
        gameId: /** @type {Object} */ (schedule.games.find((game) => game.date !== RESOLVE_DATE))
          .id,
        date: RESOLVE_DATE,
        surfaceId: anchor.surfaceId,
        startMinutes: KICKOFFS[0],
      },
      {
        gameId: movers[0].id,
        date: RESOLVE_DATE,
        surfaceId: movers[0].surfaceId,
        startMinutes: 3,
      },
    ],
    engines,
    freeze: freezeAllExcept([{ date: RESOLVE_DATE }]),
    baselineVerification: verification,
    onUnsatisfiable: 'report',
    verify: false,
  })
);
harvest(
  'applyChangeRequest(a request that asks for the slot it already holds, weights overridden)',
  applyChangeRequest({
    schedule,
    changes: [
      {
        gameId: anchor.id,
        date: anchor.date,
        surfaceId: anchor.surfaceId,
        startMinutes: anchor.startMinutes,
        reason: 'a request that asks for the slot the game already holds',
      },
    ],
    engines,
    freeze: freezeAllExcept([{ date: RESOLVE_DATE }]),
    baselineVerification: verification,
    verify: false,
    objectiveWeights: { ...RESOLVE_OBJECTIVE_WEIGHTS, [RESOLVE_OBJECTIVE_TERM.CHANGED_GAME]: 0 },
  })
);
harvest(
  'applyChangeRequest(a stage that moves a frozen game without asking)',
  applyChangeRequest({
    schedule: { ...schedule, games: onDate },
    changes: [
      {
        gameId: movers[0].id,
        date: RESOLVE_DATE,
        surfaceId: movers[0].surfaceId,
        startMinutes: KICKOFFS[0],
        reason: 'a real request, so the leaky stage below has a run to leak into',
      },
    ],
    engines,
    baselineVerification: verification,
    verify: false,
    extraStages: [
      {
        id: 'leaky-repair',
        title: 'A pass that swaps without asking, exactly as incident 2 records',
        freezeContract: {
          mutationKinds: [MOVE_KIND.RELOCATE],
          probe: STAGE_PROBE.OFFERS_FROZEN_MOVE,
          claim: 'claims to honour the freeze and does not consult it at all',
        },
        run(state) {
          const target = /** @type {string} */ (state.gameIds.find((id) => state.games[id]));
          const game = state.games[target];
          return {
            ...state,
            games: {
              ...state.games,
              [target]: { ...game, startMinutes: game.startMinutes + 5 },
            },
          };
        },
      },
    ],
  })
);
harvest(
  'commitResolve(a run nothing verified)',
  commitResolve(
    applyChangeRequest({
      schedule: { ...schedule, games: onDate },
      changes: [
        {
          gameId: movers[0].id,
          date: RESOLVE_DATE,
          surfaceId: movers[0].surfaceId,
          startMinutes: KICKOFFS[0],
          reason: 'a request to commit without a verification behind it',
        },
      ],
      engines,
      verify: false,
    }),
    {
      acknowledged: true,
      committedBy: 'the reason-code reachability audit',
      acceptFindingCodes: [RESOLVE_REASON.RESOLVE_REPORT_QUALITY_UNMEASURED],
    }
  )
);

harvest(
  'applyChangeRequest(a stage that writes without declaring it will)',
  applyChangeRequest({
    schedule: { ...schedule, games: onDate },
    changes: [
      {
        gameId: movers[0].id,
        date: RESOLVE_DATE,
        surfaceId: movers[0].surfaceId,
        startMinutes: KICKOFFS[0],
        reason: 'a real request, so the silent stage below has a run to write into',
      },
    ],
    engines,
    baselineVerification: verification,
    verify: false,
    extraStages: [
      {
        id: 'silent-repair',
        title: 'A pass that declares it writes nothing and then writes',
        freezeContract: {
          mutationKinds: [],
          probe: STAGE_PROBE.WRITES_NOTHING,
          claim: 'claims to write nothing at all',
        },
        run(state) {
          const target = /** @type {string} */ (state.gameIds.find((id) => state.games[id]));
          const game = state.games[target];
          return {
            ...state,
            games: { ...state.games, [target]: { ...game, startMinutes: game.startMinutes + 5 } },
          };
        },
      },
    ],
  })
);
harvest(
  'applyChangeRequest(a stage that offers a move onto a slot no game ever used)',
  applyChangeRequest({
    schedule: { ...schedule, games: onDate },
    changes: [
      {
        gameId: movers[0].id,
        date: RESOLVE_DATE,
        surfaceId: movers[0].surfaceId,
        startMinutes: KICKOFFS[0],
        reason: 'a real request, so the stage below has a run to move inside',
      },
    ],
    engines,
    baselineVerification: verification,
    verify: false,
    extraStages: [
      {
        id: 'off-inventory-repair',
        title: 'A pass that offers a slot the inventory does not hold',
        freezeContract: {
          mutationKinds: [MOVE_KIND.RELOCATE],
          probe: STAGE_PROBE.OFFERS_FROZEN_MOVE,
          claim: 'offers frozen games moves and expects the freeze to refuse them',
        },
        run(state) {
          // Both writes below are refused and both throw. The ledger already
          // carries the finding by then — that is the only way to observe
          // either code — so the stage keeps the state it was handed.
          for (const [gameId, slot] of [
            [
              movers[0].id,
              { date: RESOLVE_DATE, surfaceId: 'a-surface-no-game-ever-used', startMinutes: 7 },
            ],
            [
              /** @type {Object} */ (onDate.find((game) => game.id !== movers[0].id)).id,
              { date: RESOLVE_DATE, surfaceId: anchor.surfaceId, startMinutes: KICKOFFS[0] },
            ],
          ]) {
            try {
              applyMove(
                state,
                {
                  gameId: /** @type {string} */ (gameId),
                  kind: MOVE_KIND.RELOCATE,
                  to: slot,
                  reason: 'the audit asks what the writer says when it refuses',
                },
                'off-inventory-repair'
              );
            } catch {
              // Refused, as designed; the ledger holds the reason.
            }
          }
          return state;
        },
      },
    ],
  })
);
harvest(
  'applyChangeRequest(a whole wave onto one slot, with nowhere for the losers to go)',
  applyChangeRequest({
    schedule: { ...schedule, games: onDate },
    changes: onDate.map((game) => ({
      gameId: game.id,
      date: RESOLVE_DATE,
      surfaceId: anchor.surfaceId,
      startMinutes: KICKOFFS[0],
      reason: 'every 9v9 game asks for one slot, so all but one must go somewhere else',
    })),
    engines,
    baselineVerification: verification,
    holdChanges: true,
    onUnsatisfiable: 'report',
    verify: false,
  })
);

/**
 * A rig where a displaced game has nowhere legal to stand: two surfaces, one of
 * which is too small for 11v11, and a frozen 11v11 game holding the only other
 * slot on the big pitch. Built from inputs — a graph, a timing table, a
 * schedule — through the same constructors the season adapter uses.
 */
const resolveRig = buildFacilityGraph({
  venues: [{ id: 'rig', name: 'Rig Park' }],
  surfaces: [
    {
      id: 'rig/big',
      venueId: 'rig',
      name: 'Big',
      sizes: ['11v11', '9v9'],
      lined: ['11v11', '9v9'],
    },
    { id: 'rig/small', venueId: 'rig', name: 'Small', sizes: ['9v9'], lined: ['9v9'] },
  ],
});
const resolveRigTable = buildFormatTimingTable({
  formats: [
    rigFormat(),
    rigFormat({
      format: '11v11',
      halfMinutes: 40,
      halftimeMinutes: { min: 10, max: 10 },
      occupancyMinutes: { min: 90, max: 90, scheduled: 90 },
      blockMinutes: 100,
    }),
  ],
  warmupPolicy: {},
});
const resolveRigEngines = {
  graph: resolveRig,
  table: resolveRigTable,
  calendar: openCalendar,
  registry,
  resources: {
    graph: resolveRig,
    timingTable: resolveRigTable,
    calendar: openCalendar,
    venueComplexes,
  },
};
const tbdGame = (id, surfaceId, startMinutes, format, endMinutes) => ({
  id,
  date: RIG_DATE,
  startMinutes,
  endMinutes,
  venueId: 'rig',
  surfaceId,
  format,
  divisionLabel: 'U12B',
  homeTeamId: `${id}-home`,
  awayTeamId: `${id}-away`,
  homeLabel: `${id}-home`,
  awayLabel: `${id}-away`,
});
const tbdSchedule = rigSchedule({
  games: [
    tbdGame('small-nine', 'rig/small', 600, '9v9', 665),
    tbdGame('big-eleven', 'rig/big', 780, '11v11', 870),
    tbdGame('frozen-eleven', 'rig/big', 600, '11v11', 690),
  ],
  teams: [],
  teamUniverse: [],
  surfaceUniverse: ['rig/big', 'rig/small'],
});
harvest(
  'applyChangeRequest(a displaced game with no legal slot left)',
  applyChangeRequest({
    schedule: /** @type {Object} */ (tbdSchedule),
    changes: [
      {
        gameId: 'small-nine',
        date: RIG_DATE,
        surfaceId: 'rig/big',
        startMinutes: 780,
        reason: 'the 9v9 game asks for the big pitch, and the 11v11 there has nowhere to go',
      },
    ],
    engines: resolveRigEngines,
    freeze: freezeAllExcept([{ gameId: 'small-nine' }, { gameId: 'big-eleven' }]),
    holdChanges: true,
    onUnsatisfiable: 'report',
    verify: false,
  })
);

/* -- reserve -------------------------------------------------------------- */

const teamUniverse = season.teams.map((team) => String(team.id));
const reservedSlots = season2026ReservedSlots(season.combinedGames, { graph, teamUniverse });
const selectTeamIds = season2026SelectTeamIds(season.teams);
const unnamedSlots = reservedSlots.filter((slot) => slot.kind === RESERVE_KIND.UNNAMED_FIXTURE);
const reservationSlots = reservedSlots.filter((slot) => slot.kind === RESERVE_KIND.RESERVATION);
const capacityInput = season2026ReserveCapacityInput(season, { graph, table: timingTable });
const capacityEngines = { graph, table: timingTable, calendar, registry };

const capacityReport = harvest(
  'buildReserveCapacityReport(the published season)',
  buildReserveCapacityReport(capacityEngines, capacityInput)
);
harvest(
  'buildReserveCapacityReport(a surface no format fits)',
  buildReserveCapacityReport(capacityEngines, {
    ...capacityInput,
    surfaceIds: [season2026SurfaceId('Orchard Park', 'Field 1')],
    reservedSlots: [],
  })
);
harvest(
  'buildReserveCapacityReport(the anchor moved off the grid)',
  buildReserveCapacityReport(capacityEngines, { ...capacityInput, earliestKickoffMinutes: 9 * 60 })
);
harvest(
  'buildReserveCapacityReport(a cap one below what the season reserves)',
  buildReserveCapacityReport(capacityEngines, {
    ...capacityInput,
    cap: { ...capacityInput.cap, limit: SEASON_2026_LEAGUE_CAP_PER_DATE - 1 },
  })
);
harvest(
  'buildReserveCapacityReport(a requirement the ground cannot meet)',
  buildReserveCapacityReport(capacityEngines, {
    ...capacityInput,
    requirement: {
      ...capacityInput.requirement,
      slots: /** @type {number} */ (capacityReport.maxSlots) + 1,
    },
  })
);
harvest(
  'buildReserveCapacityReport(a reservation on ground the report does not cover)',
  buildReserveCapacityReport(
    capacityEngines,
    season2026ReserveCapacityInput(
      {
        ...season,
        combinedGames: [
          ...season.combinedGames,
          {
            ...season.combinedGames.find((row) =>
              String(row.homeLabel ?? '').startsWith('Select Game')
            ),
            id: 'constructed#stranded',
            venue: 'Brookside Park',
            field: 'Field 1',
            homeLabel: 'Select Game 101',
          },
        ],
      },
      { graph, table: timingTable }
    )
  )
);

/** Bindings: one that works, and one of each refusal. */
const goodBindings = unnamedSlots.slice(0, 4).map((slot, index) => ({
  slotId: slot.id,
  homeTeamId: selectTeamIds[(index * 2) % selectTeamIds.length],
  awayTeamId: selectTeamIds[(index * 2 + 1) % selectTeamIds.length],
}));
const boundSlots = harvest(
  'applySlotBindings(four slots, both sides named)',
  applySlotBindings(unnamedSlots, goodBindings, { teamUniverse })
);
harvest(
  'applySlotBindings(a slot nobody holds)',
  applySlotBindings(unnamedSlots, [{ slotId: 'no-such-slot', homeTeamId: selectTeamIds[0] }], {
    teamUniverse,
  })
);
harvest(
  'applySlotBindings(a team the roster does not know)',
  applySlotBindings(
    unnamedSlots,
    [{ slotId: unnamedSlots[0].id, homeTeamId: unnamedSlots[0].label }],
    {
      teamUniverse,
    }
  )
);
harvest(
  'applySlotBindings(a side that already names a team)',
  applySlotBindings(
    [
      makeReservedSlot({
        ...unnamedSlots[0],
        homeSide: FIXTURE_SIDE.TEAM,
        homeTeamId: selectTeamIds[0],
        homeLabel: null,
      }),
    ],
    [{ slotId: unnamedSlots[0].id, homeTeamId: selectTeamIds[1] }],
    { teamUniverse }
  )
);
harvest(
  'applySlotBindings(a team against itself, and a half-filled slot)',
  applySlotBindings(
    [unnamedSlots[0]],
    [{ slotId: unnamedSlots[0].id, homeTeamId: selectTeamIds[0], awayTeamId: selectTeamIds[0] }],
    { teamUniverse }
  )
);
harvest(
  'applySlotBindings(one side only)',
  applySlotBindings(
    [unnamedSlots[0]],
    [{ slotId: unnamedSlots[0].id, homeTeamId: selectTeamIds[0] }],
    {
      teamUniverse,
    }
  )
);
{
  const sameDate = unnamedSlots.filter((slot) => slot.date === unnamedSlots[0].date);
  const overlapping = sameDate
    .filter((slot) => slot.startMinutes === sameDate[0].startMinutes)
    .slice(0, 2);
  harvest(
    'applySlotBindings(one team in two overlapping slots)',
    applySlotBindings(
      unnamedSlots,
      overlapping.map((slot) => ({ slotId: slot.id, homeTeamId: selectTeamIds[0] })),
      { teamUniverse }
    )
  );
  /** The corpus's own untimed reservation, moved beside a slot of the same day. */
  const unmeasurable = makeReservedSlot({
    ...reservationSlots[0],
    id: 'constructed#unmeasurable',
    date: overlapping[0].date,
    startMinutes: overlapping[0].startMinutes + 10,
    endMinutes: null,
  });
  harvest(
    'applySlotBindings(the same team beside a slot of unknown footprint)',
    applySlotBindings(
      [overlapping[0], unmeasurable],
      [
        { slotId: overlapping[0].id, homeTeamId: selectTeamIds[0] },
        { slotId: unmeasurable.id, homeTeamId: selectTeamIds[0] },
      ],
      { teamUniverse }
    )
  );
}
{
  /** A Minis session's absent opponent is not a side waiting to be filled. */
  const minisRow = /** @type {Object} */ (
    season.combinedGames.find((row) => row.kind === 'minis_session')
  );
  const minisSides = season2026FixtureSides(minisRow, { teamUniverse });
  const minisSlot = makeReservedSlot({
    id: String(minisRow.id),
    kind: RESERVE_KIND.UNNAMED_FIXTURE,
    label: String(minisRow.homeLabel),
    date: String(minisRow.date),
    venueId: 'orchard-park',
    surfaceId: season2026SurfaceId(minisRow.venue, minisRow.field),
    startMinutes: Number(minisRow.kickoffMinutes),
    endMinutes: Number(minisRow.endMinutes),
    format: String(minisRow.format),
    homeSide: minisSides.homeSide,
    awaySide: minisSides.awaySide,
    homeLabel: String(minisRow.homeLabel),
  });
  harvest(
    'applySlotBindings(a side that cannot be filled at all)',
    applySlotBindings([minisSlot], [{ slotId: minisSlot.id, awayTeamId: selectTeamIds[0] }], {
      teamUniverse,
    })
  );
}

/** The footprint comparison, in each of its three answers. */
const nudged = boundSlots.slots.map((slot, index) => {
  if (index === 0) return makeReservedSlot({ ...slot, startMinutes: slot.startMinutes + 30 });
  if (index === 1) {
    return makeReservedSlot({ ...slot, surfaceId: season2026SurfaceId('Riverbend', 'Turf') });
  }
  return slot;
});
harvest('checkSlotsUnmoved(nothing moved)', checkSlotsUnmoved(unnamedSlots, boundSlots.slots));
harvest('checkSlotsUnmoved(two moved)', checkSlotsUnmoved(unnamedSlots, nudged));
harvest('checkSlotsUnmoved(two dropped)', checkSlotsUnmoved(unnamedSlots, nudged.slice(2)));
harvest('checkSlotsUnmoved(nothing to compare)', checkSlotsUnmoved([], []));

/** Slot conditions: declared but unchecked, satisfied, blocked, undecidable. */
{
  const pitch3 = season2026SurfaceId('Alder Park', 'Pitch 3');
  const pitch2 = season2026SurfaceId('Alder Park', 'Pitch 2');
  const bookings = season2026ReserveBookings(season.combinedGames, {
    excludeIds: reservedSlots.map((slot) => slot.id),
  });
  const onPitch3 = unnamedSlots.filter((slot) => slot.surfaceId === pitch3);
  harvest('describeSlotCondition(stored, never checked)', describeSlotCondition(onPitch3[0]));
  for (const slot of onPitch3.slice(0, 3)) {
    harvest(
      'evaluateSlotCondition(the neighbour is idle)',
      evaluateSlotCondition(graph, slot, bookings, { reserved: true })
    );
  }
  /**
   * The same held ground moved onto Pitch 2 on a day the rec layer stands on
   * Pitch 1A/1B, so its condition fails. Searched for rather than dated by
   * hand: a re-dated corpus moves the day, and a `find` on a literal date would
   * return `undefined` and take the whole audit down at module scope.
   */
  const contended = (() => {
    for (const slot of onPitch3) {
      const moved = makeReservedSlot({
        ...slot,
        id: `${slot.id}#control`,
        surfaceId: pitch2,
        condition: conditionForSurface(graph, pitch2),
      });
      if (
        evaluateSlotCondition(graph, moved, bookings, { reserved: true }).verdict ===
        CONDITION_VERDICT.BLOCKED
      ) {
        return slot;
      }
    }
    return null;
  })();
  if (contended === null) {
    throw new Error(
      'reason-code audit: no reserved Pitch 3 slot in the corpus lands on a day the rec layer occupies the ground Pitch 2 overlaps; the driver for SLOT_CONDITION_BLOCKED needs rebuilding'
    );
  }
  for (const reserved of [true, false]) {
    harvest(
      `evaluateSlotCondition(the neighbour is busy, reserved: ${reserved})`,
      evaluateSlotCondition(
        graph,
        makeReservedSlot({
          ...contended,
          id: `${contended.id}#control-${reserved}`,
          surfaceId: pitch2,
          condition: conditionForSurface(graph, pitch2),
        }),
        bookings,
        { reserved }
      )
    );
  }
  harvest(
    'evaluateSlotCondition(a booking of unknown footprint)',
    evaluateSlotCondition(
      graph,
      reservationSlots[0],
      season2026ReserveBookings(season.combinedGames, { excludeIds: [reservationSlots[0].id] }),
      { reserved: true }
    )
  );
}

/** Fixture accounting, in each of its answers. */
const unplacedFixture = makeUnplacedFixture({
  fixtureId: 'constructed-1',
  label: 'constructed v control',
  reason: 'no candidate slot on the date was legal for it',
});
harvest(
  'accountForFixtures(one fixture carried as TIME TBD)',
  accountForFixtures({
    expectedFixtureIds: ['constructed-1'],
    placedFixtureIds: [],
    unplaced: [unplacedFixture],
    expectedSource: 'the reason-code reachability audit',
  })
);
harvest(
  'accountForFixtures(one fixture nobody accounted for)',
  accountForFixtures({
    expectedFixtureIds: ['constructed-1', 'constructed-missing'],
    placedFixtureIds: [],
    unplaced: [unplacedFixture],
  })
);
harvest(
  'accountForFixtures(a reason that is only whitespace)',
  accountForFixtures({
    expectedFixtureIds: ['constructed-blank'],
    placedFixtureIds: [],
    unplaced: [
      makeUnplacedFixture({ fixtureId: 'constructed-blank', label: 'a v b', reason: '   ' }),
    ],
  })
);
harvest(
  'accountForFixtures(a fixture both placed and unplaced)',
  accountForFixtures({
    expectedFixtureIds: ['constructed-1'],
    placedFixtureIds: ['constructed-1'],
    unplaced: [unplacedFixture],
  })
);
harvest(
  'accountForFixtures(nothing reconciled at all)',
  accountForFixtures({ expectedFixtureIds: [], placedFixtureIds: [], unplaced: [] })
);
// The disagreeing team is **on a row**: `TEAM_COACH_SOURCES_DISAGREE` is
// defined on the exported rows, and the audit's fixture used to name no team,
// so the code fired here only because the producer swept the whole directory.
const contestedFixture = makeUnplacedFixture({
  fixtureId: 'constructed-contested',
  label: 'contested v control',
  homeTeamId: 'audit-contested-team',
  reason: 'no candidate slot on the date was legal for it',
});
harvest(
  'publicationRowsFor(a bound slot, an unbound one, an unplaced fixture and a team whose two sources disagree about its coaches)',
  publicationRowsFor({
    slots: [unnamedSlots[0], boundSlots.slots[0]],
    unplaced: [unplacedFixture, contestedFixture],
    teams: [
      {
        id: contestedFixture.homeTeamId,
        name: 'a team the reason-code reachability audit constructed',
        coachId: 'from-the-legacy-columns',
        coachName: 'From The Legacy Columns',
        coaches: [{ personId: 'from-the-reconciled-list', displayName: 'Reconciled', slot: 1 }],
      },
    ],
  })
);
harvest(
  'publicationCoverageFindings(a projection missing rows)',
  publicationCoverageFindings(
    { slots: unnamedSlots.slice(0, 2), unplaced: [unplacedFixture] },
    publicationRowsFor({ slots: [], unplaced: [] }).rows
  )
);

/* -- attribution ---------------------------------------------------------- */

/** The later of the corpus's two negotiated external kickoffs — incident 3. */
const attributionExternal = [
  ...externalChanges.filter(
    (change) =>
      /** @type {Object} */ (schedule.games.find((game) => game.id === change.gameId))
        .startMinutes !== change.startMinutes
  ),
].sort((a, b) => b.startMinutes - a.startMinutes)[0];

/**
 * The over-constrained placement, built exactly as `tests/attribution.test.js`
 * builds it: two corpus games on one surface, one moved to the minute its
 * venue's permit closes and the other asked to stand on top of it.
 */
const overConstrained = (() => {
  /** @type {Map<string, { date: string, surfaceId: string, venueId: string, games: Object[] }>} */
  const groups = new Map();
  for (const game of schedule.games) {
    if (game.endMinutes === null) continue;
    const key = `${game.date}|${game.surfaceId}`;
    if (!groups.has(key)) {
      groups.set(key, {
        date: game.date,
        surfaceId: game.surfaceId,
        venueId: game.venueId,
        games: [],
      });
    }
    /** @type {Object} */ (groups.get(key)).games.push(game);
  }
  /** @type {Array<Object>} */
  const candidates = [];
  for (const { date, surfaceId, venueId, games } of groups.values()) {
    if (games.length < 2) continue;
    if (resolveLighting(graph, calendar, surfaceId).lit) continue;
    const permit = resolvePermitWindow(calendar, { venueId, date });
    if (permit.window === null || permit.window.closeMinutes === null) continue;
    candidates.push({
      date,
      surfaceId,
      venueId,
      closeMinutes: permit.window.closeMinutes,
      games: [...games].sort((a, b) => a.startMinutes - b.startMinutes),
    });
  }
  candidates.sort(
    (a, b) =>
      b.games.length - a.games.length ||
      b.date.localeCompare(a.date) ||
      a.surfaceId.localeCompare(b.surfaceId)
  );
  const chosen = candidates[0];
  const [movedAnchor, subject] = chosen.games;
  return {
    subject,
    slot: { date: chosen.date, surfaceId: chosen.surfaceId, startMinutes: chosen.closeMinutes },
    stackedContext: buildAttributionContext({
      graph,
      table: timingTable,
      calendar,
      registry,
      venueComplexes,
      verification,
      roster,
      schedule: {
        ...schedule,
        games: schedule.games.map((game) =>
          game.id === movedAnchor.id
            ? {
                ...game,
                startMinutes: chosen.closeMinutes,
                endMinutes:
                  chosen.closeMinutes +
                  /** @type {number} */ (movedAnchor.endMinutes - movedAnchor.startMinutes),
              }
            : game
        ),
      },
    }),
  };
})();

harvest(
  'buildAttributionContext(without the verification, travel or roster)',
  buildAttributionContext({ graph, table: timingTable, calendar, registry, schedule })
);
harvest(
  'explainGame(a game the schedule does not hold)',
  explainGame(context, { gameId: 'not-a-game' })
);
/**
 * A `person`-scoped record, which a game-shaped question cannot judge and
 * therefore does not apply.
 *
 * The corpus registry is global- and venue-scoped only, so the record has to be
 * stated to reach the code at all — a constructed *input*, which is what this
 * driver is allowed, rather than a returned structure reached into.
 */
harvest(
  'explainGame(under a person-scoped record it cannot judge)',
  explainGame(
    {
      ...context,
      engines: {
        ...context.engines,
        registry: buildConstraintRegistry({
          name: registry.name,
          source: registry.source,
          constraints: [
            ...registry.constraints,
            {
              id: 'reachability.person.scoped',
              policy: 'reachability-probe',
              name: 'a person-scoped rule a game-shaped question cannot judge',
              type: CONSTRAINT_TYPE.HARD,
              scope: { kind: CONSTRAINT_SCOPE_KIND.PERSON, personId: 'p-000' },
              rationale:
                'constructed: the season registry names no person scope, so the scope an answer cannot reach has to be stated to be driven',
              source: {
                setBy: 'tests/reasonCodeReachability.test.js',
                setAt: null,
                note: 'constructed for this driver; never a clock read',
                reference: 'round 3, finding 5',
              },
              enforcement: CONSTRAINT_ENFORCEMENT.REASON_CODES,
              reasonCodes: [FACILITY_REASON.LINING_MISMATCH],
            },
          ],
        }),
      },
    },
    { gameId: schedule.games[0].id }
  )
);
harvest(
  'explainTeamConflict(a team the schedule does not hold)',
  explainTeamConflict(context, { teamId: 'not-a-team' })
);
harvest(
  'explainTeamConflict(a team with nothing to report)',
  explainTeamConflict(context, {
    teamId: /** @type {string} */ (
      schedule.teamUniverse.find(
        (teamId) =>
          !(
            /** @type {Object} */ (context.travel).transitions.some(
              (transition) =>
                (transition.from.teamId === teamId || transition.to.teamId === teamId) &&
                transition.findings.some((finding) => finding.severity !== 'info')
            )
          )
      )
    ),
  })
);

/** The alternatives: one that is a no-op, one that is blocked, one that is legal. */
const attributionSubject = schedule.games[0];
harvest(
  'explainKickoffTime(the time it already holds)',
  explainKickoffTime(context, {
    gameId: attributionSubject.id,
    insteadOfMinutes: attributionSubject.startMinutes,
  })
);
harvest(
  'explainKickoffTime(the time the other league published)',
  explainKickoffTime(context, {
    gameId: attributionExternal.gameId,
    insteadOfMinutes: attributionExternal.startMinutes,
    insteadOfSurfaceId: attributionExternal.surfaceId,
    insteadOfDate: attributionExternal.date,
  })
);
for (const game of schedule.games) {
  const kickoffs = [
    ...new Set(
      schedule.games
        .filter((entry) => entry.date === game.date && entry.venueId === game.venueId)
        .map((entry) => entry.startMinutes)
    ),
  ];
  const legal = kickoffs
    .filter((minutes) => minutes !== game.startMinutes)
    .map((minutes) => explainKickoffTime(context, { gameId: game.id, insteadOfMinutes: minutes }))
    .find((answer) => answer.counterfactual.legal);
  if (legal) {
    harvest('explainKickoffTime(an alternative that is legal)', legal);
    break;
  }
}

/** The earliest-kickoff question, answered and unanswerable. */
{
  const PITCH_2 = season2026SurfaceId('Alder Park', 'Pitch 2');
  const PITCH_1A = season2026SurfaceId('Alder Park', 'Pitch 1A');
  const PITCH_1B = season2026SurfaceId('Alder Park', 'Pitch 1B');
  const busyDate = [
    ...new Set(
      schedule.games.filter((game) => game.surfaceId === PITCH_2).map((game) => game.date)
    ),
  ]
    .sort()
    .filter((date) =>
      schedule.games.some(
        (game) =>
          game.date === date &&
          game.format === '9v9' &&
          [PITCH_1A, PITCH_1B].includes(game.surfaceId)
      )
    )[0];
  const searchFloor = Math.max(
    ...schedule.games
      .filter((game) => game.surfaceId === PITCH_2 && game.date === busyDate)
      .map((game) => /** @type {number} */ (game.endMinutes))
  );
  harvest(
    'explainEarliestKickoff(with a stated warm-up)',
    explainEarliestKickoff(context, {
      surfaceId: PITCH_2,
      date: busyDate,
      format: '11v11',
      warmupMinutes: SEASON_2026_INCIDENT_8_WARMUP_MINUTES,
      notBeforeMinutes: searchFloor,
    })
  );
  harvest(
    'explainEarliestKickoff(with no warm-up length anywhere)',
    explainEarliestKickoff(context, {
      surfaceId: PITCH_2,
      date: busyDate,
      format: '11v11',
      notBeforeMinutes: searchFloor,
    })
  );
  /**
   * A floor nothing had taken yet — searched for across the corpus's own
   * surface/date pairs rather than guessed at, and asserted found below.
   */
  const unboundedFloor = (() => {
    for (const date of [...new Set(schedule.games.map((game) => game.date))].sort()) {
      for (const surfaceId of schedule.surfaceUniverse) {
        const answer = explainEarliestKickoff(context, {
          surfaceId,
          date,
          format: '11v11',
          warmupMinutes: SEASON_2026_INCIDENT_8_WARMUP_MINUTES,
          notBeforeMinutes: 8 * 60,
        });
        if (answer.kickoffMinutes !== null && answer.bindingKinds.length === 0) return answer;
      }
    }
    return null;
  })();
  if (unboundedFloor === null) {
    // Refused rather than skipped: a search that stopped finding one would
    // otherwise surface as ATTRIBUTION_BOUND_UNSTATED "unreachable", which
    // reads as a defect in the attribution module rather than in this file.
    throw new Error(
      'reason-code audit: no surface/date in the corpus offers an unbounded warm-up floor any more; the driver for ATTRIBUTION_BOUND_UNSTATED needs rebuilding'
    );
  }
  harvest('explainEarliestKickoff(a floor nothing had taken yet)', unboundedFloor);
  harvest(
    'explainLatestKickoff(the last legal kickoff on a busy day)',
    explainLatestKickoff(context, {
      gameId: /** @type {Object} */ (
        schedule.games.find((game) => game.surfaceId === PITCH_2 && game.date === busyDate)
      ).id,
    })
  );
}

/** The minimal blocking set: over-constrained, illegal, and legal. */
harvest(
  'minimalBlockingSet(an over-constrained placement)',
  minimalBlockingSet(overConstrained.stackedContext, {
    gameId: overConstrained.subject.id,
    slot: overConstrained.slot,
  })
);
{
  const sweep = explainSchedule(context);
  harvest('explainSchedule(the whole season)', sweep);
  const illegal = sweep.attributions.find((attribution) => !attribution.legal);
  if (illegal) {
    harvest(
      'minimalBlockingSet(a placement the season already breaks)',
      minimalBlockingSet(context, { gameId: illegal.gameId })
    );
  }
  const legal = /** @type {Object} */ (sweep.attributions.find((attribution) => attribution.legal));
  harvest(
    'minimalBlockingSet(a placement nothing blocks)',
    minimalBlockingSet(context, { gameId: legal.gameId })
  );
}

/**
 * Two answers the published season cannot produce, asked of contexts built from
 * *inputs* that can: a registry that governs no reason code at all (the corpus
 * has eight declared-only constraints, so a registry of nothing but those is a
 * real arrangement), and a roster nobody filled.
 */
const ungovernedContext = buildAttributionContext({
  graph,
  table: timingTable,
  calendar,
  registry: registryOf(
    constraintRecord({ enforcement: CONSTRAINT_ENFORCEMENT.DECLARED_ONLY, reasonCodes: [] })
  ),
  venueComplexes,
  verification,
  roster,
  schedule: { ...schedule, games: schedule.games.slice(0, 4) },
});
harvest(
  'explainSchedule(a registry that governs no reason code)',
  explainSchedule(ungovernedContext)
);
harvest(
  'explainGame(the same, one game at a time)',
  explainGame(ungovernedContext, { gameId: schedule.games[0].id })
);
harvest(
  'explainTeamConflict(a context whose roster nobody filled)',
  explainTeamConflict(
    buildAttributionContext({
      graph,
      table: timingTable,
      calendar,
      registry,
      venueComplexes,
      verification,
      roster: buildCoachRoster({ people: [], assignments: [] }),
      schedule,
    }),
    { teamId: schedule.teamUniverse[0] }
  )
);

/**
 * The same two questions again, this time on rig ground: a calendar that
 * declares no permit, no sunset and no lighting, and a registry that governs
 * nothing, which is the emptiest world an attribution context can be built for.
 */
const bareContext = buildAttributionContext({
  graph: rig,
  table: rigTable,
  calendar: emptyCalendar,
  registry: registryOf(
    constraintRecord({ enforcement: CONSTRAINT_ENFORCEMENT.DECLARED_ONLY, reasonCodes: [] })
  ),
  venueComplexes,
  schedule: /** @type {Object} */ ({
    ...rigSchedule({ games: [rigGame({ endMinutes: 665 })] }),
    surfaceUniverse: ['rig/half'],
    venueUniverse: ['rig'],
  }),
});
harvest('explainSchedule(the emptiest world a context can hold)', explainSchedule(bareContext));
harvest('explainGame(the same, one game)', explainGame(bareContext, { gameId: 'g1' }));

/* -- publication ---------------------------------------------------------- */

const PUBLICATION_STAMP = '2026-09-01T18:00:00';
const publicationSnapshotInput = {
  snapshotId: 'audit-1',
  label: 'the rec schedule as the audit found it',
  channel: 'nowhere; this snapshot exists to be checked',
  publishedAt: '2026-08-01T09:15:00',
  publishedBy: 'the reason-code reachability audit',
  columns: ['a', 'b'],
  rows: [
    { a: '1', b: 'x' },
    { a: '2', b: 'y' },
  ],
};
const publicationSnapshot = harvest(
  'makePublicationSnapshot(two rows)',
  makePublicationSnapshot(publicationSnapshotInput)
);
harvest(
  'verifySnapshotDigest(a snapshot whose rows no longer match its digest)',
  // Not a forged internal state: a snapshot is the artefact itself, and reading
  // one back from wherever it was stored is the path this check exists for.
  verifySnapshotDigest({
    ...publicationSnapshot.snapshot,
    rows: [
      { a: '1', b: 'x' },
      { a: '2', b: 'MOVED' },
    ],
  })
);

/** Subject A: the published rec schedule against the workbook. */
const publishedParity = harvest(
  'checkParity(the published rec schedule vs the workbook)',
  checkParity(
    season2026PublishedParityInput({
      publishedRecGames: season.recGames,
      combinedGames: season.combinedGames,
    })
  )
);
/** Subject B: the external file, which needs the venue mapping to line up. */
const externalParityInput = season2026ExternalParityInput({
  externalFixtures: season.externalFixtures,
  agreedGames: season.combinedByKind[SEASON_2026_ROW_KIND.EXTERNAL_FIXTURE],
});
harvest('checkParity(the external file, mapped)', checkParity(externalParityInput));
harvest(
  'checkParity(the external file with the mapping switched off)',
  checkParity({ ...externalParityInput, mappingRules: [] })
);
harvest(
  'checkParity(a mapping rule for a label no row spells that way)',
  checkParity({
    ...externalParityInput,
    mappingRules: [
      ...externalParityInput.mappingRules,
      {
        id: 'audit:no-such-ground',
        appliesTo: 'published',
        match: { venue: 'Brookside Park', field: 'Field 1' },
        set: { field: 'Upper 1' },
        provenance: 'the reason-code audit: a rule for ground the corpus does not spell this way',
      },
    ],
  })
);

/** The comparator's own refusals, on constructed rows. */
const parityRow = (overrides = {}) =>
  makeParityRow({
    rowId: 'r',
    sourceLabel: 'the reason-code reachability audit',
    date: '2026-08-22',
    startMinutes: 600,
    venue: 'V',
    field: 'F',
    format: '7v7',
    division: 'U10B',
    home: 'H',
    away: 'A',
    ...overrides,
  });
const paritySubject = {
  subject: 'constructed for the audit',
  published: { label: 'published', rows: [parityRow({ rowId: 'p1' })] },
  current: { label: 'current', rows: [parityRow({ rowId: 'c1' })] },
  keyFields: [PARITY_FIELD.DATE, PARITY_FIELD.HOME, PARITY_FIELD.AWAY],
  comparedFields: [PARITY_FIELD.START_MINUTES, PARITY_FIELD.VENUE, PARITY_FIELD.FIELD],
};
harvest(
  'checkParity(nothing on either side)',
  checkParity({
    ...paritySubject,
    published: { label: 'published', rows: [] },
    current: { label: 'current', rows: [] },
  })
);
harvest(
  'checkParity(two published rows with one identity)',
  checkParity({
    ...paritySubject,
    published: {
      label: 'published',
      rows: [parityRow({ rowId: 'p1' }), parityRow({ rowId: 'p2', startMinutes: 700 })],
    },
  })
);
harvest(
  'checkParity(a cell the current side does not carry)',
  checkParity({
    ...paritySubject,
    current: { label: 'current', rows: [parityRow({ rowId: 'c1', venue: null })] },
  })
);
{
  const partition = compareParityRows({
    published: paritySubject.published.rows,
    current: paritySubject.current.rows,
    keyFields: paritySubject.keyFields,
    comparedFields: paritySubject.comparedFields,
  });
  harvest(
    'parityPartitionFindings(a row that reached no bucket)',
    parityPartitionFindings(partition, { publishedCount: 2, currentCount: 1 })
  );
}

/** Change notices, from the parity result and the team universe. */
const noticeTeams = season.teams.map((team) => ({
  teamId: String(team.id),
  teamName: String(team.name ?? team.id),
  division: team.division ?? null,
  coachName: team.coachId ?? null,
  coachEmail: null,
}));
const noticeNonTeamLabels = [
  ...new Set(
    season.combinedGames.flatMap((game) => {
      /** @type {string[]} */
      const labels = [];
      if (game.homeIsPlaceholder || !season.teams.some((team) => team.id === game.homeLabel)) {
        labels.push(game.homeLabel);
      }
      if (!season.teams.some((team) => team.id === game.awayLabel)) labels.push(game.awayLabel);
      return labels;
    })
  ),
];
harvest(
  'buildChangeNotices(with contact columns, which is a disclosure)',
  buildChangeNotices({
    parity: publishedParity,
    teams: noticeTeams,
    nonTeamLabels: noticeNonTeamLabels,
    includeContacts: true,
  })
);
harvest(
  'buildChangeNotices(a participant nothing recognises)',
  buildChangeNotices({ parity: publishedParity, teams: noticeTeams, nonTeamLabels: [] })
);
harvest(
  'buildChangeNotices(no team universe at all)',
  buildChangeNotices({ parity: publishedParity, teams: [], nonTeamLabels: noticeNonTeamLabels })
);

/** The downstream sync registry, in each of its four states. */
const syncSnapshot = {
  snapshotId: 'audit-1',
  label: 'the schedule the audit published',
  publishedAt: PUBLICATION_STAMP,
};
const syncDestination = (overrides = {}) => ({
  destinationId: 'public-site',
  name: 'club public site',
  kind: SYNC_DESTINATION_KIND.PULL,
  consumes: 'master schedule export',
  destinationSyncedAt: '2026-08-30T04:00:00',
  owner: 'communications',
  ...overrides,
});
harvest(
  'buildSyncRegistryReport(one stale, one current, one never synced)',
  buildSyncRegistryReport({
    snapshot: syncSnapshot,
    destinations: [
      syncDestination(),
      syncDestination({
        destinationId: 'league-portal',
        name: 'league portal upload',
        kind: SYNC_DESTINATION_KIND.PUSH,
        destinationSyncedAt: '2026-09-01T18:05:00',
        owner: null,
      }),
      syncDestination({
        destinationId: 'printed-programme',
        name: 'printed programme',
        kind: SYNC_DESTINATION_KIND.MANUAL,
        destinationSyncedAt: null,
        owner: null,
      }),
    ],
  })
);
harvest(
  'buildSyncRegistryReport(no destinations at all)',
  buildSyncRegistryReport({ snapshot: syncSnapshot, destinations: [] })
);

/* -------------------------------------------------------------------------- */
/* scenario/ — branching a baseline, diffing branches, promoting one           */
/* -------------------------------------------------------------------------- */

/** The corpus as one immutable baseline bundle of *inputs*. */
const scenarioInputs = season2026SeasonInputs({
  schedule,
  facilityInput: toSeason2026FacilityGraphInput(geometry),
  timingInput: toFormatTimingInput(loadGameFormats()),
  calendarInput: toAvailabilityCalendarInput(
    loadFacilityPermits({ seasonYear: SEASON_YEAR }),
    sunsets
  ),
  constraints: SEASON_2026_CONSTRAINTS,
  venueComplexes,
});

/** The venue whose whole use is one format, so the branch has one clear subject. */
const scenarioVenueId = [
  ...new Set(
    schedule.games
      .map((game) => game.venueId)
      .filter(
        (venueId) =>
          new Set(
            schedule.games.filter((game) => game.venueId === venueId).map((game) => game.format)
          ).size === 1
      )
  ),
]
  .map((venueId) => ({
    venueId,
    games: schedule.games.filter((game) => game.venueId === venueId).length,
    format: schedule.games.find((game) => game.venueId === venueId)?.format,
  }))
  .sort((a, b) => b.games - a.games)[0];

const scenarioBranch = season2026VenueUnavailableScenario({
  venueId: scenarioVenueId.venueId,
  baselineId: scenarioInputs.id,
  requestedBy: 'audit@club.example',
  at: '2026-08-01T09:00:00',
});

const scenarioPolicy = season2026RelocationPolicy({
  graph,
  table: timingTable,
  format: /** @type {string} */ (scenarioVenueId.format),
  excludeVenueIds: [scenarioVenueId.venueId],
  games: schedule.games,
});

const scenarioRunOptions = {
  baselineEngines: engines,
  baselineVerification: verification,
  relocationPolicy: scenarioPolicy,
  requirement: {
    slots: 1,
    label: 'at least one game a date',
    source: 'the reason-code audit, not a club policy',
  },
};

const scenarioResult = harvest(
  'runScenario(withdraw a whole venue, with the relocation proposer running)',
  runScenario(scenarioInputs, scenarioBranch, scenarioRunOptions)
);

harvest(
  'runScenario(the negative control: the proposer switched off)',
  runScenario(scenarioInputs, scenarioBranch, { ...scenarioRunOptions, relocations: false })
);

/** A branch that withdraws ground the schedule never stands on. */
const unusedVenueId = Object.values(graph.venues)
  .map((venue) => venue.id)
  .find((venueId) => !schedule.games.some((game) => game.venueId === venueId));
harvest(
  'runScenario(an override for a venue the schedule never uses)',
  runScenario(
    scenarioInputs,
    makeScenario({
      id: 'audit-vacuous',
      name: 'without ground nobody uses',
      baselineId: scenarioInputs.id,
      rationale: 'the audit\u2019s vacuity case',
      requestedBy: 'audit@club.example',
      createdAt: '2026-08-01T09:00:00',
      overrides: [
        {
          kind: SCENARIO_OVERRIDE_KIND.ADD,
          recordSet: SCENARIO_RECORD_SET.PERMITS,
          record: {
            id: 'audit-vacuous-blackout',
            venueId: unusedVenueId ?? 'no-such-venue',
            scopeKind: 'weekday-default',
            weekday: 'SAT',
            date: null,
            hasPermit: false,
            openMinutes: null,
            closeMinutes: null,
            lit: null,
            lightsOffMinutes: null,
            note: 'ground the schedule never stands on',
            source: 'audit',
          },
          by: 'audit@club.example',
          at: '2026-08-01T09:00:00',
          reason: 'withdraw ground the schedule never stands on',
        },
      ],
    }),
    scenarioRunOptions
  )
);

/** Two overrides touching one record id, and one naming a record nobody holds. */
const scenarioOverride = (overrides = {}) => ({
  kind: SCENARIO_OVERRIDE_KIND.REMOVE,
  recordSet: SCENARIO_RECORD_SET.PERMITS,
  recordId: String(scenarioInputs.permits[0].id),
  by: 'audit@club.example',
  at: '2026-08-01T09:00:00',
  reason: 'the audit needs a second edit on one record',
  ...overrides,
});
harvest(
  'materialiseScenario(two overrides on one record, and an add that collides)',
  materialiseScenario(
    scenarioInputs,
    makeScenario({
      id: 'audit-conflicted',
      name: 'two edits, one record',
      baselineId: scenarioInputs.id,
      rationale: 'the audit\u2019s conflict case',
      requestedBy: 'audit@club.example',
      createdAt: '2026-08-01T09:00:00',
      overrides: [
        scenarioOverride(),
        scenarioOverride({ reason: 'and again' }),
        scenarioOverride({ recordId: 'no-such-permit-row', reason: 'a record nobody holds' }),
        scenarioOverride({
          kind: SCENARIO_OVERRIDE_KIND.ADD,
          recordId: null,
          record: { ...scenarioInputs.permits[1] },
          reason: 'an id the baseline already holds',
        }),
      ],
    })
  )
);

/**
 * An ancestor's retype and a descendant's remove of one constraint. Two edits
 * of one record id written by *one* author are the conflict above, so this
 * refusal is only reachable down a chain.
 */
const scenarioRetyped = SEASON_2026_CONSTRAINTS.find(
  (record) => record.type === CONSTRAINT_TYPE.HARD
);
const scenarioRetypeAncestor = makeScenario({
  id: 'audit-softens',
  name: 'soften one rule',
  baselineId: scenarioInputs.id,
  rationale: 'the audit\u2019s retype case',
  requestedBy: 'audit@club.example',
  createdAt: '2026-08-01T09:00:00',
  overrides: [
    {
      kind: SCENARIO_OVERRIDE_KIND.RETYPE,
      recordSet: SCENARIO_RECORD_SET.CONSTRAINTS,
      recordId: scenarioRetyped.id,
      type: CONSTRAINT_TYPE.SOFT,
      weight: 5,
      by: 'audit@club.example',
      at: '2026-08-01T09:00:00',
      reason: 'what does this rule cost as a preference?',
    },
  ],
});
harvest(
  'materialiseScenario(a descendant withdraws the constraint its ancestor retypes)',
  materialiseScenario(
    scenarioInputs,
    makeScenario({
      id: 'audit-strikes-out',
      name: 'strike the rule out entirely',
      baselineId: scenarioInputs.id,
      parentScenarioId: scenarioRetypeAncestor.id,
      rationale: 'the audit\u2019s retype-then-withdraw case',
      requestedBy: 'audit@club.example',
      createdAt: '2026-08-01T09:00:00',
      overrides: [
        {
          kind: SCENARIO_OVERRIDE_KIND.REMOVE,
          recordSet: SCENARIO_RECORD_SET.CONSTRAINTS,
          recordId: scenarioRetyped.id,
          by: 'audit@club.example',
          at: '2026-08-01T09:00:00',
          reason: 'the rule was struck out',
        },
      ],
    }),
    { ancestry: [scenarioRetypeAncestor] }
  )
);

harvest(
  'materialiseScenario(a branch of a branch)',
  materialiseScenario(
    scenarioInputs,
    season2026VenueUnavailableScenario({
      venueId: scenarioVenueId.venueId,
      baselineId: scenarioInputs.id,
      requestedBy: 'audit@club.example',
      at: '2026-08-01T09:00:00',
      id: 'audit-child',
      parentScenarioId: scenarioBranch.id,
      dates: [schedule.games.find((game) => game.venueId === scenarioVenueId.venueId).date],
    }),
    { ancestry: [scenarioBranch] }
  )
);

/** The memo, read after its baseline moved underneath it. */
const scenarioMemo = new ScenarioMemo();
scenarioMemo.resolve(scenarioInputs, scenarioBranch, scenarioRunOptions);

/** A branch of a branch, cached, and then checked without the ancestry it names. */
const scenarioChild = season2026VenueUnavailableScenario({
  venueId: scenarioVenueId.venueId,
  baselineId: scenarioInputs.id,
  requestedBy: 'audit@club.example',
  at: '2026-08-01T09:00:00',
  id: 'audit-unresolved-child',
  parentScenarioId: scenarioBranch.id,
  dates: [schedule.games.find((game) => game.venueId === scenarioVenueId.venueId).date],
});
scenarioMemo.resolve(scenarioInputs, scenarioChild, {
  ...scenarioRunOptions,
  ancestry: [scenarioBranch],
});
harvest(
  'ScenarioMemo.check(a branch of a branch, without the ancestry it names)',
  scenarioMemo.check(scenarioInputs, scenarioChild)
);
harvest(
  'ScenarioMemo.check(a cached result whose fingerprint has moved)',
  scenarioMemo.check(
    season2026SeasonInputs({
      schedule,
      facilityInput: toSeason2026FacilityGraphInput(geometry),
      timingInput: toFormatTimingInput(loadGameFormats()),
      calendarInput: toAvailabilityCalendarInput(
        loadFacilityPermits({ seasonYear: SEASON_YEAR }),
        sunsets
      ),
      constraints: SEASON_2026_CONSTRAINTS.map((record) => ({
        ...record,
        rationale: `${record.rationale} (edited after the branch was derived)`,
      })),
      venueComplexes,
    }),
    scenarioBranch
  )
);

/** The diff, with a stated capacity subject and without one. */
const scenarioDiff = harvest(
  'diffAgainstBaselineScenario(with a stated capacity subject)',
  diffAgainstBaselineScenario(scenarioResult, {
    baselineEngines: engines,
    baselineVerification: verification,
    capacitySubjects: season2026CapacitySubjects({
      graph,
      table: timingTable,
      format: /** @type {string} */ (scenarioVenueId.format),
      dates: [
        ...new Set(
          schedule.games
            .filter((game) => game.venueId === scenarioVenueId.venueId)
            .map((game) => game.date)
        ),
      ].sort(),
      surfaceIds: [
        ...scenarioPolicy.surfaceIds,
        ...new Set(
          schedule.games
            .filter((game) => game.venueId === scenarioVenueId.venueId)
            .map((game) => game.surfaceId)
        ),
      ],
      requirement: {
        slots: 1,
        label: 'at least one game a date',
        source: 'the reason-code audit',
      },
      games: schedule.games,
    }),
  })
);

harvest(
  'diffScenarios(no capacity subject, and neither side measured)',
  diffScenarios({
    subject: 'two branches nobody ran the rule engine over',
    left: { label: 'left', schedule, verification: null },
    right: { label: 'right', schedule: scenarioResult.schedule, verification: null },
    weights: RESOLVE_OBJECTIVE_WEIGHTS,
  })
);

harvest(
  'scheduleDiffPartitionFindings(a partition that accounts for the wrong number of games)',
  scheduleDiffPartitionFindings(
    diffSchedules({ left: schedule.games, right: scenarioResult.schedule.games }),
    { leftCount: schedule.games.length + 1, rightCount: scenarioResult.schedule.games.length + 1 }
  )
);

harvest(
  'promoteScenario(the branch becomes primary, with the diff recorded)',
  promoteScenario({
    result: scenarioResult,
    diff: scenarioDiff,
    promotionId: 'audit-promotion',
    promotedAt: '2026-08-05T12:00:00',
    promotedBy: 'audit@club.example',
    rationale: 'the audit promotes the branch it just derived',
  })
);

try {
  promoteScenario({
    result: {
      ...scenarioResult,
      findings: [
        ...scenarioResult.findings,
        makeScenarioFinding(
          SCENARIO_REASON.SCENARIO_OVERRIDE_CONFLICT,
          'a blocking finding the caller did not accept',
          {}
        ),
      ],
    },
    diff: scenarioDiff,
    promotionId: 'audit-promotion-refused',
    promotedAt: '2026-08-05T12:00:00',
    promotedBy: 'audit@club.example',
    rationale: 'the audit\u2019s refusal case',
  });
} catch (error) {
  // The refusal carries its finding on the error, exactly as
  // `ChangeBudgetExceeded` and `FrozenGameUnsatisfiable` do.
  harvest('promoteScenario(a blocking finding nobody accepted)', error);
}

/* -- feasibility ---------------------------------------------------------- */

/**
 * The read-only feasibility layer, driven through its three public queries.
 *
 * Every call below is a plain query object against the season context built
 * above; nothing is reached into and altered. The one constructed input is a
 * schedule carrying an extra fixture, which is how a team comes to span two
 * formats — the corpus has no such team, and the alternative to constructing one
 * would be a code nothing can produce.
 */
const feasibilityScrimmage = schedule.games.find((game) => game.endMinutes === null);
const feasibilitySelect = schedule.games.find(
  (game) => game.format === '11v11' && game.surfaceId === 'summit-hs/stadium'
);
const feasibilityAlder = schedule.games.find(
  (game) => game.date === '2026-08-22' && game.surfaceId === 'alder-park/pitch-2'
);

harvest(
  'canGameMove(an untimed Scrimmage row)',
  canGameMove(
    context,
    {
      gameId: feasibilityScrimmage.id,
      insteadOfMinutes: feasibilityScrimmage.startMinutes + 60,
    },
    { venueComplexes }
  )
);

harvest(
  'canGameMove(a weekday the venue has no permit record for)',
  canGameMove(
    context,
    { gameId: feasibilityAlder.id, insteadOfDate: '2026-08-20' },
    { venueComplexes }
  )
);

harvest(
  'canGameMove(the slot it already holds)',
  canGameMove(
    context,
    { gameId: feasibilityAlder.id, insteadOfMinutes: feasibilityAlder.startMinutes },
    { venueComplexes }
  )
);

harvest(
  'canGameMove(a standing position the facility layer did not block)',
  (() => {
    // The rule engine blocks this fixture where it stands, and the facility
    // layer does not — so `minimalBlockingSet()` comes back `blocked: false`
    // and the answer has to say which layer did decide. Asked with the minimal
    // set left at its default, which is the answer an operator actually gets.
    const blockedElsewhere = schedule.games.find((game) => game.id === 'combined_schedule.csv#534');
    return canGameMove(
      context,
      {
        gameId: blockedElsewhere.id,
        insteadOfDate: blockedElsewhere.date,
        insteadOfSurfaceId: blockedElsewhere.surfaceId,
        insteadOfMinutes: blockedElsewhere.startMinutes,
      },
      { venueComplexes, standingPositionIsAnAnswer: true }
    );
  })()
);

harvest(
  'canGameMove(a game the schedule does not hold)',
  canGameMove(context, { gameId: 'no-such-game', insteadOfMinutes: 600 }, { venueComplexes })
);

harvest(
  'canGameMove(no venue complexes, so travel cannot be projected)',
  canGameMove(context, {
    gameId: feasibilityAlder.id,
    insteadOfMinutes: feasibilityAlder.startMinutes + 60,
  })
);

harvest(
  'canGameMove(onto the date the venue is blacked out)',
  canGameMove(
    context,
    { gameId: feasibilitySelect.id, insteadOfDate: '2026-09-19' },
    { venueComplexes }
  )
);

harvest(
  'canGameMove(no rule-engine run in the context)',
  canGameMove(
    buildAttributionContext({
      graph,
      table: timingTable,
      calendar,
      registry,
      schedule,
    }),
    { gameId: feasibilityAlder.id, insteadOfMinutes: feasibilityAlder.startMinutes + 60 },
    { venueComplexes }
  )
);

harvest(
  'feasibleKickoffBounds(the permit close and the daylight limit coincide)',
  feasibleKickoffBounds(context, {
    surfaceId: 'alder-park/pitch-2',
    date: '2026-08-22',
    format: '11v11',
    ignoreGameIds: schedule.games
      .filter((game) => game.date === '2026-08-22' && game.venueId === 'alder-park')
      .map((game) => game.id),
  })
);

harvest(
  'feasibleKickoffBounds(lit ground where the permit margin sets the clean line)',
  feasibleKickoffBounds(context, {
    surfaceId: 'summit-hs/stadium',
    date: '2026-11-14',
    format: '11v11',
    ignoreGameIds: schedule.games
      .filter((game) => game.date === '2026-11-14' && game.venueId === 'summit-hs')
      .map((game) => game.id),
  })
);

harvest(
  'feasibleKickoffBounds(a registry that hardens a base-compromise availability code)',
  // `PERMIT_MARGIN_TIGHT` is `compromise` in `availability/reasonCodes.js`;
  // `latestLegalKickoff()` selects the hard bound on that table while this
  // module judges it on the registry's. A club whose permit states the comfort
  // margin as a condition holds the record below, the two views then differ,
  // and the answer says which one chose the bound it reports.
  feasibleKickoffBounds(
    buildAttributionContext({
      graph,
      table: timingTable,
      calendar,
      registry: buildSeason2026ConstraintRegistry({
        extraConstraints: [
          {
            id: 'permit-margin-hard-reachability',
            policy: 'permit-margin',
            name: 'The permit comfort margin is a condition of the permit here',
            type: CONSTRAINT_TYPE.HARD,
            scope: { kind: CONSTRAINT_SCOPE_KIND.GLOBAL },
            parameters: { marginMinutes: 15 },
            restrictiveDirection: 'higher',
            rationale:
              'A permit that states its fifteen minutes as a condition rather than a courtesy makes the same code hard; the registry is where that hardness lives.',
            source: {
              setBy: 'this audit',
              setAt: null,
              reference: 'a constructed record, carried by no corpus',
              note: 'constructed input, dated by nothing',
            },
            effectiveFrom: null,
            effectiveTo: null,
            enforcement: CONSTRAINT_ENFORCEMENT.REASON_CODES,
            reasonCodes: [AVAILABILITY_REASON.PERMIT_MARGIN_TIGHT],
            weight: null,
            waivable: false,
            history: [],
          },
        ],
      }),
      schedule,
    }),
    { surfaceId: 'brookside-park/upper-1', date: '2026-08-22', format: '4v4' }
  )
);

harvest(
  'feasibleKickoffBounds(the blacked-out date)',
  feasibleKickoffBounds(context, {
    surfaceId: 'summit-hs/stadium',
    date: '2026-09-19',
    format: '11v11',
  })
);

harvest(
  'feasibleKickoffBounds(a surface the graph does not hold)',
  feasibleKickoffBounds(context, {
    surfaceId: 'no-such-venue/no-such-pitch',
    date: '2026-08-22',
    format: '11v11',
  })
);

harvest(
  'feasibleKickoffBounds(ground with a hard bound and nothing clean beneath it)',
  feasibleKickoffBounds(context, {
    surfaceId: 'alder-park/pitch-2',
    date: '2026-08-22',
    // The pitch is not lined for 9v9, so a `compromise` speaks at every legal
    // minute of the day: the bound is real and no clean position exists at all.
    format: '9v9',
  })
);

// `candidateAccountingFindings()` is deliberately **not** driven here. It was,
// with a meta built by hand carrying `candidatesConsidered: 2` and
// `candidatesAnswered: 1` — a ledger no query can produce — and this audit then
// reported `FEASIBILITY_CANDIDATE_DROPPED` as reachable because a test had
// called a helper with a state the production path establishes against one line
// earlier. That is the shape this file exists to catch, so the code is on the
// hole list above instead. The guard's own falsifiability is proved where it
// belongs, in `tests/feasibilityApi.test.js`, which hands it that ledger and
// shows it says so.

harvest(
  'canTeamPlay(the slot the team already holds)',
  (() => {
    const held = schedule.games.find((game) => game.homeTeamId !== null);
    return canTeamPlay(
      context,
      {
        teamId: held.homeTeamId,
        dates: [held.date],
        kickoffMinutes: held.startMinutes,
        surfaceIds: [held.surfaceId],
      },
      { venueComplexes }
    );
  })()
);

harvest(
  'canTeamPlay(a format no fixture of the team plays)',
  (() => {
    const anchor = schedule.games.find((game) => game.format === '9v9' && game.homeTeamId !== null);
    return canTeamPlay(
      context,
      {
        teamId: anchor.homeTeamId,
        dates: ['2026-11-14'],
        kickoffMinutes: 10 * 60,
        format: 'Minis',
      },
      { venueComplexes }
    );
  })()
);

harvest(
  'canTeamPlay(a placeholder label)',
  canTeamPlay(context, {
    teamId: schedule.placeholderLabels[0],
    dates: ['2026-11-14'],
    kickoffMinutes: 18 * 60,
  })
);

harvest(
  'canGameMove(a move that leaves the projected travel scan with nothing to judge)',
  // `combined_schedule.csv#3`'s coaches have one other commitment on its own
  // date and none on 2026-10-10, so the projected `evaluateCoachTravel()` run
  // has no consecutive same-day pair left and raises `TRAVEL_SCAN_VACUOUS`
  // where the standing run raised none. That finding belongs to no transition,
  // so `claimFromFinding()` can name no record for it and the claim is refused
  // — and the compromise is published as `FEASIBILITY_EVIDENCE_UNCLAIMED`
  // instead of deciding the answer's tightness from nowhere.
  canGameMove(
    context,
    { gameId: 'combined_schedule.csv#3', insteadOfDate: '2026-10-10' },
    { venueComplexes }
  )
);

harvest(
  'canTeamPlay(a team spanning two formats)',
  (() => {
    const anchor = schedule.games.find((game) => game.format === '9v9' && game.homeTeamId !== null);
    const constructed = {
      ...schedule,
      games: [
        ...schedule.games,
        { ...anchor, id: 'audit-second-format', format: '7v7', date: '2026-10-03' },
      ],
    };
    return canTeamPlay(
      buildAttributionContext({
        graph,
        table: timingTable,
        calendar,
        registry,
        schedule: constructed,
        verification,
        venueComplexes,
        roster,
      }),
      { teamId: anchor.homeTeamId, dates: ['2026-10-03'], kickoffMinutes: 10 * 60 },
      { venueComplexes }
    );
  })()
);

/* -- the move-request analysis -------------------------------------------- */

/**
 * `feasibility/moveRequest.js`, driven through its one public query.
 *
 * Every input below is **data**: a window, and a list of practice holdings in
 * the shape `MoveRequestHoldingSchema` parses. Nothing reaches inside a
 * returned analysis, and no internal state is forged — which matters more here
 * than usual, because the whole module is about who else stands on a piece of
 * ground and a driver that could invent an occupant would prove nothing.
 *
 * `brookside-park/upper-1` on 2026-08-22 is clean from 08:00, holds four
 * fixtures between 10:15 and 14:55, and its permit makes 17:00 the last and
 * only tight kickoff. That one surface therefore reaches vacancies, swaps,
 * costly swaps and the off-grid report; the blacked-out Summit record reaches
 * the two that need a grid with nothing on it.
 */
const moveRequestPractice = (id, startMinutes, over = {}) => ({
  id,
  date: '2026-08-22',
  surfaceId: 'brookside-park/upper-1',
  startMinutes,
  endMinutes: startMinutes + 55,
  format: '7v7',
  teamIds: [`audit-team-${id}`],
  personIds: [],
  label: id,
  ...over,
});

harvest(
  'analyseMoveRequest(a practice whose every feasible slot is held, all for one objective)',
  analyseMoveRequest(
    context,
    {
      entityKind: 'practice',
      entityId: 'audit:subject',
      dates: ['2026-08-22'],
      surfaceIds: ['brookside-park/upper-1'],
      cadenceMinutes: 60,
      earliestKickoffMinutes: 8 * 60,
      latestKickoffMinutes: 9 * 60,
    },
    {
      venueComplexes,
      practices: [
        // The subject sits at the one tight kickoff, so every holder it could
        // exchange with loses the permit's comfort margin — a cost no registry
        // constraint claims, which is `MOVE_REQUEST_COST_UNCLAIMED`. The
        // 09:30 holding stands on ground the 60-minute cadence does not
        // generate, which is `MOVE_REQUEST_OFF_CAPACITY_GRID`.
        moveRequestPractice('audit:subject', 17 * 60),
        moveRequestPractice('audit:holder-0', 8 * 60),
        moveRequestPractice('audit:holder-1', 9 * 60),
        moveRequestPractice('audit:off-grid', 9 * 60 + 30),
      ],
    }
  )
);

harvest(
  'analyseMoveRequest(a window whose only candidate is held by an open-ended practice)',
  analyseMoveRequest(
    context,
    {
      entityKind: 'practice',
      entityId: 'audit:subject',
      dates: ['2026-08-22'],
      surfaceIds: ['brookside-park/upper-1'],
      cadenceMinutes: 60,
      earliestKickoffMinutes: 9 * 60,
      latestKickoffMinutes: 9 * 60,
    },
    {
      venueComplexes,
      practices: [
        moveRequestPractice('audit:subject', 8 * 60),
        // GAP-14: no known end, so whether the ground is free cannot be
        // decided — `MOVE_REQUEST_OCCUPANCY_UNDECIDABLE` — and a window that
        // then offers nothing says its class is a floor:
        // `MOVE_REQUEST_CLASS_UNDER_UNKNOWN`.
        moveRequestPractice('audit:open-ended', 9 * 60, { endMinutes: null }),
      ],
    }
  )
);

harvest(
  'analyseMoveRequest(a practice wearing a game id, and a subject nothing holds)',
  analyseMoveRequest(
    context,
    {
      entityKind: 'practice',
      entityId: 'audit:subject',
      dates: ['2026-08-22'],
      surfaceIds: ['brookside-park/upper-1'],
      cadenceMinutes: 60,
      earliestKickoffMinutes: 8 * 60,
      latestKickoffMinutes: 8 * 60,
    },
    {
      venueComplexes,
      practices: [
        moveRequestPractice('audit:subject', 17 * 60),
        // A holding under an id the index already holds: one of the two would
        // be invisible to occupancy, vacancy and every swap.
        moveRequestPractice(schedule.games[0].id, 8 * 60),
      ],
    }
  )
);

harvest(
  'analyseMoveRequest(a subject this run does not hold)',
  analyseMoveRequest(
    context,
    {
      entityKind: 'game',
      entityId: 'audit:no-such-fixture',
      dates: ['2026-08-22'],
      surfaceIds: ['brookside-park/upper-1'],
      cadenceMinutes: 60,
      earliestKickoffMinutes: 9 * 60,
      latestKickoffMinutes: 10 * 60,
    },
    { venueComplexes }
  )
);

harvest(
  'analyseMoveRequest(a practice standing on ground the graph does not hold)',
  analyseMoveRequest(
    context,
    {
      entityKind: 'practice',
      entityId: 'audit:subject',
      dates: ['2026-08-22'],
      surfaceIds: ['brookside-park/upper-1'],
      cadenceMinutes: 60,
      earliestKickoffMinutes: 9 * 60,
      latestKickoffMinutes: 9 * 60,
    },
    {
      venueComplexes,
      practices: [
        moveRequestPractice('audit:subject', 8 * 60),
        // `surfacesConflict()` reaches `requireSurface()`, which throws; the id
        // came from the caller's data, so the query guards it and reports.
        moveRequestPractice('audit:ghost', 9 * 60, {
          surfaceId: 'brookside-park/upper-1-not-in-the-graph',
        }),
      ],
    }
  )
);

harvest(
  'analyseMoveRequest(a window over the blacked-out permit record)',
  analyseMoveRequest(
    context,
    {
      entityKind: 'game',
      entityId: schedule.games.find((game) => game.date === '2026-09-19').id,
      dates: ['2026-09-19'],
      surfaceIds: ['summit-hs/stadium'],
      cadenceMinutes: 60,
      earliestKickoffMinutes: 9 * 60,
      latestKickoffMinutes: 17 * 60,
    },
    { venueComplexes }
  )
);

/* -- fairness -------------------------------------------------------------- */

/**
 * The fairness and equity layer, driven through its public entry points.
 *
 * The season corpus reaches twelve of its twenty-two codes on its own; the
 * rest need a fixture list this season does not contain, and each is built here
 * as **input data** — a plain array of schema-shaped fixtures — rather than by
 * reaching into a returned report.
 *
 * `FAIRNESS_GROUP_AMBIGUOUS` used to be one of the twelve and is now one of the
 * rest. The corpus' only two-label subject, `16GSelect02`, carries `16GS` on one
 * scrimmage and `U16G` on another and holds no league fixture, and a league
 * metric's cohort is now drawn from league fixtures only — so the corpus has no
 * subject holding two keys *of the class a metric reads*, and the code is
 * driven below from a constructed league list instead.
 */
const fairnessFixtures = toSeason2026FairnessFixtures(season.combinedGames).fixtures;

/** A schema-shaped league fixture, for the constructed cases. */
function fairnessFixture(overrides) {
  return {
    fixtureId: 'x',
    scopeId: 'audit',
    competition: FAIRNESS_COMPETITION.LEAGUE,
    date: '2026-08-22',
    kickoffMinutes: 600,
    venueId: 'venue-a',
    surfaceId: 'venue-a/pitch-1',
    division: 'U10B',
    ageGroup: 'U10',
    format: '7v7',
    homeSubjectId: 'home',
    awaySubjectId: 'away',
    ...overrides,
  };
}

harvest('fairnessReport(the season corpus)', fairnessReport({ fixtures: fairnessFixtures }));

harvest(
  'classifyFairnessFixtures(a competition nobody has declared, and a row naming nobody)',
  classifyFairnessFixtures([
    fairnessFixture({ fixtureId: 'a', competition: 'tournament' }),
    fairnessFixture({ fixtureId: 'b', homeSubjectId: null, awaySubjectId: null }),
  ])
);

harvest(
  'classifyFairnessFixtures(two scopes sharing a division label)',
  classifyFairnessFixtures([
    fairnessFixture({ fixtureId: 'a', scopeId: 'club-a' }),
    fairnessFixture({ fixtureId: 'b', scopeId: 'club-b' }),
  ])
);

harvest(
  'fairnessReport(nothing the classifier accepts)',
  fairnessReport({ fixtures: [fairnessFixture({ competition: 'tournament' })] })
);

harvest(
  'fairnessReport(a season of external fixtures only)',
  fairnessReport({
    fixtures: Array.from({ length: 8 }, (unused, index) =>
      fairnessFixture({
        fixtureId: `e${index}`,
        competition: FAIRNESS_COMPETITION.EXTERNAL,
        homeSubjectId: `H${index}`,
        awaySubjectId: `A${index}`,
      })
    ),
  })
);

harvest(
  'fairnessReport(three teams, so no cohort reaches the four-member floor)',
  fairnessReport({
    fixtures: [
      fairnessFixture({ fixtureId: 'a', homeSubjectId: 'T1', awaySubjectId: 'T2' }),
      fairnessFixture({
        fixtureId: 'b',
        date: '2026-08-29',
        homeSubjectId: 'T2',
        awaySubjectId: 'T3',
      }),
      fairnessFixture({
        fixtureId: 'c',
        date: '2026-09-05',
        homeSubjectId: 'T3',
        awaySubjectId: 'T1',
      }),
    ],
  })
);

harvest(
  'fairnessReport(a league whose fixtures carry no kickoff)',
  fairnessReport({
    fixtures: Array.from({ length: 24 }, (unused, index) =>
      fairnessFixture({
        fixtureId: `u${index}`,
        date: `2026-09-${String((index % 6) + 1).padStart(2, '0')}`,
        kickoffMinutes: null,
        homeSubjectId: `T${index % 6}`,
        awaySubjectId: `T${(index % 6) + 6}`,
      })
    ),
    metricIds: [FAIRNESS_METRIC.MEAN_KICKOFF],
  })
);

harvest(
  'fairnessReport(one side scheduled early enough to flag below the cohort)',
  fairnessReport({
    fixtures: Array.from({ length: 12 }, (unused, team) =>
      Array.from({ length: 9 }, (ignored, round) =>
        fairnessFixture({
          fixtureId: `t${team}-r${round}`,
          date: `2026-09-${String(round + 1).padStart(2, '0')}`,
          kickoffMinutes: team === 0 ? 480 : 600 + ((team + round) % 4) * 7,
          homeSubjectId: `T${team}`,
          awaySubjectId: null,
        })
      )
    ).flat(),
    metricIds: [FAIRNESS_METRIC.MEAN_KICKOFF],
  })
);

harvest(
  'fairnessReport(a team whose league fixtures carry two spellings of its division)',
  fairnessReport({
    fixtures: [
      ...Array.from({ length: 4 }, (unused, round) =>
        fairnessFixture({
          fixtureId: `amb-${round}`,
          date: `2026-09-0${round + 1}`,
          homeSubjectId: `T${round}`,
          awaySubjectId: `T${round + 4}`,
        })
      ),
      // The same division, spelled the other way, on a league row. Two keys of
      // the class the metric reads is what makes a subject ambiguous.
      fairnessFixture({
        fixtureId: 'amb-relabelled',
        date: '2026-09-05',
        division: '10B',
        homeSubjectId: 'T0',
        awaySubjectId: 'T1',
      }),
    ],
  })
);

harvest(
  'scoreFairnessObjective(the season corpus, where 22 subjects cannot be scored)',
  scoreFairnessObjective(
    fairnessFixtures,
    { objectiveId: FAIRNESS_OBJECTIVE.HOSTING_BALANCE },
    participationOf(fairnessFixtures)
  )
);

harvest(
  'fairnessReport(two rows under one fixture id)',
  fairnessReport({
    fixtures: [
      fairnessFixture({ fixtureId: 'dup', homeSubjectId: 'T1', awaySubjectId: 'T2' }),
      fairnessFixture({
        fixtureId: 'dup',
        date: '2026-08-29',
        homeSubjectId: 'T1',
        awaySubjectId: 'T3',
      }),
    ],
  })
);

harvest(
  'scoreFairnessObjective(a list of rows that name nobody, so nothing is scored)',
  scoreFairnessObjective(
    [
      fairnessFixture({ fixtureId: 'p1', homeSubjectId: null, awaySubjectId: null }),
      fairnessFixture({ fixtureId: 'p2', homeSubjectId: null, awaySubjectId: null }),
    ],
    { objectiveId: FAIRNESS_OBJECTIVE.HOSTING_BALANCE }
  )
);

harvest(
  'compareObjectiveScores(two results over different populations)',
  (() => {
    const whole = participationOf(fairnessFixtures);
    const league = fairnessFixtures.filter(
      (fixture) => fixture.competition === FAIRNESS_COMPETITION.LEAGUE
    );
    return compareObjectiveScores(
      scoreFairnessObjective(
        fairnessFixtures,
        { objectiveId: FAIRNESS_OBJECTIVE.HOSTING_BALANCE },
        whole
      ),
      scoreFairnessObjective(
        league,
        { objectiveId: FAIRNESS_OBJECTIVE.HOSTING_BALANCE },
        participationOf(league)
      )
    );
  })()
);

/* -- externalImport -------------------------------------------------------- */

/**
 * External fixture import, driven through its public entry points.
 *
 * The season corpus alone reaches the mapping, the four row classes it actually
 * produces, and the acceptance sweep; everything below it is a *constructed
 * input* to the same entry points — a registry with a record deleted, one with
 * two records claiming a label, a scope of one fixture — never a returned
 * structure reached into and altered.
 */
const externalRegistry = harvest(
  'buildExternalMappingRegistry(the season corpus)',
  buildExternalMappingRegistry(season2026ExternalMappingInput(), { graph })
);
const externalQuery = season2026ExternalImportQuery({
  externalFixtures: season.externalFixtures,
  combinedGames: season.combinedGames,
});
const externalResolution = harvest(
  'classifyExternalImport(the season corpus)',
  classifyExternalImport(externalQuery, externalRegistry)
);
harvest(
  'sweepAcceptanceSets(the season corpus)',
  sweepAcceptanceSets({
    subject: 'season-2026 external seeding fixtures',
    resolution: externalResolution,
    standing: externalQuery.standing,
    graph,
    timingTable,
  })
);

// The counterfactual in which the whole import is safe and seven of its subsets
// are not — the 11v11 layer alone, which is what an analysis that looks only at
// the pitches the import names would see.
harvest(
  'sweepAcceptanceSets(the 11v11 layer alone, where a safe set has unsafe subsets)',
  sweepAcceptanceSets({
    subject: 'the 11v11 layer alone',
    resolution: externalResolution,
    standing: externalQuery.standing.filter((fixture) => fixture.format === '11v11'),
    graph,
    timingTable,
  })
);

// A re-published external file: the same fixture listed twice, the second row
// carrying a corrected kickoff. Both rows come back acceptable against one
// standing fixture — the classification guards two *standing* fixtures on one
// key and says nothing about two *imported* rows on one key — so the acceptance
// set that names both contests it, and the fixture holds its ground.
const republishedQuery = {
  ...externalQuery,
  rows: [
    ...externalQuery.rows,
    {
      ...externalQuery.rows[0],
      rowId: `${externalQuery.rows[0].rowId}-republished`,
      kickoffMinutes: externalQuery.rows[0].kickoffMinutes + 195,
    },
  ],
};
const republishedResolution = classifyExternalImport(republishedQuery, externalRegistry);
harvest(
  'projectAcceptance(two accepted rows contesting one fixture)',
  projectAcceptance({
    resolution: republishedResolution,
    standing: republishedQuery.standing,
    acceptedRowIds: [externalQuery.rows[0].rowId, `${externalQuery.rows[0].rowId}-republished`],
    timingTable,
  })
);

harvest(
  'sweepAcceptanceSets(a sweep that examined two of sixteen sets)',
  sweepAcceptanceSets({
    subject: 'a partial sweep',
    resolution: externalResolution,
    standing: externalQuery.standing,
    graph,
    timingTable,
    sets: [[], externalQuery.rows.map((row) => row.rowId)],
  })
);

const emptyExternalRegistry = harvest(
  'buildExternalMappingRegistry(no records at all)',
  buildExternalMappingRegistry({
    registryId: 'empty',
    label: 'no records',
    party: 'external seeding league',
    records: [],
  })
);
harvest(
  'classifyExternalImport(a registry with no records at all)',
  classifyExternalImport(externalQuery, emptyExternalRegistry)
);

// A registry in which the label this publication actually uses is claimed twice,
// with different targets: every row carrying it comes back undecidable naming
// the ambiguity, rather than being resolved to whichever record sorted first.
harvest(
  "classifyExternalImport(a registry that claims one of the publication's labels twice)",
  classifyExternalImport(
    externalQuery,
    buildExternalMappingRegistry(
      season2026ExternalMappingInput({
        records: [
          ...SEASON_2026_EXTERNAL_MAPPING_RECORDS,
          {
            id: 'second-claimant',
            kind: EXTERNAL_MAPPING_KIND.VENUE,
            externalLabel: 'Alder Park (Back Pitch 2)',
            venueId: season2026VenueId('Alder Park'),
            surfaceId: season2026SurfaceId('Alder Park', 'Pitch 3'),
            subjectId: null,
            provenance: 'constructed for tests/reasonCodeReachability.test.js',
          },
        ],
      }),
      { graph }
    )
  )
);

harvest(
  'classifyExternalImport(a registry whose records this publication never names)',
  classifyExternalImport(
    externalQuery,
    buildExternalMappingRegistry({
      registryId: 'irrelevant',
      label: 'records for another league',
      party: 'external seeding league',
      records: [
        {
          id: 'other',
          kind: EXTERNAL_MAPPING_KIND.VENUE,
          externalLabel: 'Somewhere Else (Pitch 1)',
          venueId: season2026VenueId('Riverbend'),
          surfaceId: season2026SurfaceId('Riverbend', 'Turf'),
          subjectId: null,
          provenance: 'constructed for tests/reasonCodeReachability.test.js',
        },
      ],
    })
  )
);

harvest(
  'buildExternalMappingRegistry(two records claiming one key, and a ghost surface)',
  buildExternalMappingRegistry(
    {
      registryId: 'collision',
      label: 'two authors, one label',
      party: 'external seeding league',
      records: [
        {
          id: 'a',
          kind: EXTERNAL_MAPPING_KIND.VENUE,
          externalLabel: 'The Back Pitch',
          venueId: season2026VenueId('Alder Park'),
          surfaceId: season2026SurfaceId('Alder Park', 'Pitch 2'),
          subjectId: null,
          provenance: 'constructed for tests/reasonCodeReachability.test.js',
        },
        {
          id: 'b',
          kind: EXTERNAL_MAPPING_KIND.VENUE,
          externalLabel: 'the back  pitch',
          venueId: season2026VenueId('Alder Park'),
          surfaceId: season2026SurfaceId('Alder Park', 'Pitch 3'),
          subjectId: null,
          provenance: 'constructed for tests/reasonCodeReachability.test.js',
        },
        {
          id: 'ghost',
          kind: EXTERNAL_MAPPING_KIND.VENUE,
          externalLabel: 'Nowhere (Pitch 9)',
          venueId: season2026VenueId('Alder Park'),
          surfaceId: 'alder-park/pitch-9',
          subjectId: null,
          provenance: 'constructed for tests/reasonCodeReachability.test.js',
        },
      ],
    },
    { graph }
  )
);

// A registry that keeps only one of the two venue records: the four Pitch 3 rows
// come back undecidable naming the unresolved label, and accepting one of them
// is refused.
const externalReduced = buildExternalMappingRegistry(
  season2026ExternalMappingInput({
    records: [
      SEASON_2026_EXTERNAL_MAPPING_RECORDS.find(
        (record) => record.surfaceId === season2026SurfaceId('Alder Park', 'Pitch 2')
      ),
    ],
  }),
  { graph }
);
// It also reaches `EXTERNAL_FIELD_UNTRANSLATED`: those four rows state a ground
// this registry cannot translate, which is a gap in our records rather than a
// value the publication omits, and is told apart from `EXTERNAL_FIELD_ONE_SIDED`
// for that reason.
const externalUnresolved = harvest(
  'classifyExternalImport(a registry missing one venue record)',
  classifyExternalImport(externalQuery, externalReduced)
);
harvest(
  'analyseImportImpact(accepting a row that could not be judged)',
  analyseImportImpact({
    subject: 'accepting an unjudged row',
    resolution: externalUnresolved,
    standing: externalQuery.standing,
    query: {
      acceptedRowIds: externalUnresolved.rows
        .filter((row) => !row.acceptable)
        .map((row) => row.rowId),
    },
    graph,
    timingTable,
  })
);

// A registry that keeps the Pitch 3 record and blanks its surface. The record
// still claims the label, so the lookup **resolves** — and it yields no ground,
// which is `EXTERNAL_ROW_GROUND_UNREAD`: the same fact as the unresolved case
// above, reached by the road where the lookup succeeded. The rows carrying that
// label come back undecidable and cannot be accepted.
const externalHoled = buildExternalMappingRegistry(
  season2026ExternalMappingInput({
    records: SEASON_2026_EXTERNAL_MAPPING_RECORDS.map((record) =>
      record.surfaceId === season2026SurfaceId('Alder Park', 'Pitch 3')
        ? { ...record, surfaceId: null }
        : record
    ),
  }),
  { graph }
);
const externalGroundUnread = harvest(
  'classifyExternalImport(a registry whose venue record names no surface)',
  classifyExternalImport(externalQuery, externalHoled)
);
harvest(
  'analyseImportImpact(accepting a row whose ground we could not read)',
  analyseImportImpact({
    subject: 'accepting a row whose ground we could not read',
    resolution: externalGroundUnread,
    standing: externalQuery.standing,
    query: {
      acceptedRowIds: externalGroundUnread.rows
        .filter((row) => !row.acceptable)
        .map((row) => row.rowId),
    },
    graph,
    timingTable,
  })
);

// `format` is null on every published row and on every fixture below, so no
// artifact states it: that is `EXTERNAL_FIELD_UNCOMPARED`, the *neither* side of
// the presence split. The driver above reaches its sibling
// `EXTERNAL_FIELD_ONE_SIDED`, where our fixtures do carry a format and the
// league's file has no such column.
harvest(
  'classifyExternalImport(a field neither artifact carries)',
  classifyExternalImport(
    {
      ...externalQuery,
      comparedFields: ['kickoffMinutes', 'format'],
      standing: externalQuery.standing.map((fixture) => ({ ...fixture, format: null })),
    },
    externalRegistry
  )
);

harvest(
  'classifyExternalImport(a row nothing of ours matches, a duplicated key, and one-sided fields)',
  classifyExternalImport(
    {
      ...externalQuery,
      comparedFields: ['kickoffMinutes', 'format', 'division'],
      rows: [
        ...externalQuery.rows,
        {
          rowId: 'invented#0',
          sourceLabel: 'invented',
          date: '2026-08-22',
          kickoffMinutes: 600,
          venueLabel: 'Alder Park (Back Pitch 2)',
          homeLabel: 'A Club We Do Not Play',
          awayLabel: 'Another One',
          format: null,
          division: null,
        },
      ],
      standing: [
        ...externalQuery.standing,
        {
          ...externalQuery.standing.find(
            (fixture) => fixture.fixtureId === externalResolution.rows[0].fixtureId
          ),
          fixtureId: 'duplicate-of-the-first',
        },
      ],
    },
    externalRegistry
  )
);

harvest(
  'classifyExternalImport(zero rows)',
  classifyExternalImport({ ...externalQuery, rows: [] }, externalRegistry)
);

// A publication that states no venue at all on one row. `ExternalFixtureRowSchema`
// distinguishes an absent `venueLabel` from a null one precisely so this can be
// told apart from a caller who forgot, and the null one is a row that cannot be
// judged: the key is (date, home, away) and does not carry the ground.
harvest(
  'classifyExternalImport(a row whose publication states no venue)',
  classifyExternalImport(
    {
      ...externalQuery,
      rows: externalQuery.rows.map((row, index) =>
        index === 0 ? { ...row, venueLabel: null } : row
      ),
    },
    externalRegistry
  )
);

harvest(
  'analyseImportImpact(accepting rows that already agree, over a scope of one fixture)',
  analyseImportImpact({
    subject: 'a scope with one fixture in it',
    resolution: externalResolution,
    standing: [
      externalQuery.standing.find(
        (fixture) => fixture.fixtureId === externalResolution.rows[0].fixtureId
      ),
    ],
    query: {
      acceptedRowIds: externalResolution.rows
        .filter((row) => row.differences.length === 0)
        .map((row) => row.rowId),
      dates: [
        externalQuery.standing.find(
          (fixture) => fixture.fixtureId === externalResolution.rows[0].fixtureId
        ).date,
      ],
    },
    graph,
    timingTable,
  })
);

// A fixture with no known footprint (GAP-14) moved on top of another: the
// verdict is `undetermined` and the pair says so.
const externalStanding = toSeason2026StandingFixtures(season.combinedGames);
const untimedFixtures = externalStanding.filter((fixture) => fixture.endMinutes === null);
const untimedRegistry = buildExternalMappingRegistry(
  {
    registryId: 'summit',
    label: 'a registry that names the stadium',
    party: 'external seeding league',
    records: [
      {
        id: 'summit-stadium',
        kind: EXTERNAL_MAPPING_KIND.VENUE,
        externalLabel: 'Summit (Stadium)',
        venueId: untimedFixtures[0].venueId,
        surfaceId: untimedFixtures[0].surfaceId,
        subjectId: null,
        provenance: 'constructed for tests/reasonCodeReachability.test.js',
      },
    ],
  },
  { graph }
);
const untimedResolution = classifyExternalImport(
  {
    subject: 'moving an untimed scrimmage',
    rows: [
      {
        rowId: 'scrimmage-move#0',
        sourceLabel: 'constructed',
        date: untimedFixtures[0].date,
        kickoffMinutes: untimedFixtures[0].kickoffMinutes + 30,
        venueLabel: 'Summit (Stadium)',
        homeLabel: untimedFixtures[0].homeLabel,
        awayLabel: untimedFixtures[0].awayLabel,
        format: null,
        division: null,
      },
    ],
    standing: untimedFixtures.slice(0, 2),
    keyFields: ['date', 'home', 'away'],
    comparedFields: ['kickoffMinutes', 'venueId', 'surfaceId'],
  },
  untimedRegistry
);
harvest(
  'analyseImportImpact(moving a fixture whose footprint is unknown)',
  analyseImportImpact({
    subject: 'moving an untimed scrimmage',
    resolution: untimedResolution,
    standing: untimedFixtures.slice(0, 2),
    query: { acceptedRowIds: ['scrimmage-move#0'] },
    graph,
    timingTable,
  })
);

// The same untimed pair with one of them standing on ground the facility graph
// does not hold. It is that pair specifically because the analysis only consults
// `surfacesConflict()` for a pair whose overlap `bookingsOverlapInTime()` could
// not decide, which needs an unknown footprint — and that call used to throw out
// of the whole analysis rather than reporting, while `findFacilityConflicts()`
// two lines away classified the same booking and carried on.
const unknownGroundStanding = [
  untimedFixtures[0],
  { ...untimedFixtures[1], surfaceId: `${untimedFixtures[1].surfaceId}--not-in-this-graph` },
];
harvest(
  'analyseImportImpact(a plan standing on ground the facility graph does not hold)',
  analyseImportImpact({
    subject: 'a plan standing on ground the graph does not hold',
    resolution: classifyExternalImport(
      {
        subject: 'a plan standing on ground the graph does not hold',
        rows: [],
        standing: unknownGroundStanding,
        keyFields: ['date', 'home', 'away'],
        comparedFields: ['kickoffMinutes', 'venueId', 'surfaceId'],
      },
      untimedRegistry
    ),
    standing: unknownGroundStanding,
    query: { acceptedRowIds: [], dates: [untimedFixtures[0].date] },
    graph,
    timingTable,
  })
);

// A projection that puts two fixtures on one surface where the earlier one's
// format has no `game_formats.csv` row: neither the turnover floor nor the
// declared block can be applied to the pair, and the analysis says which checks
// went unrun rather than letting "nothing introduced" read as "nothing to find".
// The second scrimmage is relocated to Alder so the pair does not already exist
// in the standing plan — an unchecked pair both plans carry is pre-existing and
// is restated under another code, which would credit this one to an echo.
const relocatedScrimmage = {
  ...untimedFixtures[1],
  venueId: season2026VenueId('Alder Park'),
  surfaceId: season2026SurfaceId('Alder Park', 'Pitch 2'),
};
const relocationResolution = classifyExternalImport(
  {
    subject: 'a scrimmage moved onto ground another scrimmage already holds',
    rows: [
      {
        rowId: 'relocate#0',
        sourceLabel: 'constructed',
        date: relocatedScrimmage.date,
        kickoffMinutes: relocatedScrimmage.kickoffMinutes,
        venueLabel: 'Summit (Stadium)',
        homeLabel: relocatedScrimmage.homeLabel,
        awayLabel: relocatedScrimmage.awayLabel,
        format: null,
        division: null,
      },
    ],
    standing: [untimedFixtures[0], relocatedScrimmage],
    keyFields: ['date', 'home', 'away'],
    comparedFields: ['kickoffMinutes', 'venueId', 'surfaceId'],
  },
  untimedRegistry
);
harvest(
  'analyseImportImpact(a pair whose spacing checks cannot run)',
  analyseImportImpact({
    subject: 'a scrimmage moved onto ground another scrimmage already holds',
    resolution: relocationResolution,
    standing: [untimedFixtures[0], relocatedScrimmage],
    query: { acceptedRowIds: ['relocate#0'] },
    graph,
    timingTable,
  })
);

// A projection that removes a clash the standing plan carries. The standing
// plan here is the one the league published — the 08/22 fixtures 30 minutes
// later, where the 12:30 kickoff overlaps the 13:50 9v9 on the adjoining pitch —
// and the import brings the agreed times back. Accepting them resolves it.
const externalDates = ['2026-08-22'];
const movedFixtureIdSet = new Set(
  externalResolution.rows.filter((row) => row.differences.length > 0).map((row) => row.fixtureId)
);
const publishedStanding = externalStanding.map((fixture) =>
  movedFixtureIdSet.has(fixture.fixtureId)
    ? {
        ...fixture,
        kickoffMinutes: fixture.kickoffMinutes + 30,
        endMinutes: fixture.endMinutes === null ? null : fixture.endMinutes + 30,
      }
    : fixture
);
const walkBackRows = externalResolution.rows
  .filter((row) => row.differences.length > 0)
  .map((row, index) => {
    const agreed = externalStanding.find((fixture) => fixture.fixtureId === row.fixtureId);
    const published = externalQuery.rows.find((candidate) => candidate.rowId === row.rowId);
    return {
      rowId: `walk-back#${index}`,
      sourceLabel: 'the agreed times, sent back to us',
      date: agreed.date,
      kickoffMinutes: agreed.kickoffMinutes,
      venueLabel: published.venueLabel,
      homeLabel: agreed.homeLabel,
      awayLabel: agreed.awayLabel,
      format: null,
      division: null,
    };
  });
const walkBackResolution = classifyExternalImport(
  {
    subject: 'the agreed times against a plan that already holds the published ones',
    rows: walkBackRows,
    standing: publishedStanding,
    keyFields: ['date', 'home', 'away'],
    comparedFields: ['kickoffMinutes', 'venueId', 'surfaceId'],
  },
  externalRegistry
);
const walkBackAccepted = walkBackResolution.rows
  .filter((row) => row.differences.length > 0)
  .map((row) => row.rowId);
harvest(
  'analyseImportImpact(a projection that inherits a clash it did not cause)',
  analyseImportImpact({
    subject: 'walking one of the published times back',
    resolution: walkBackResolution,
    standing: publishedStanding,
    query: { acceptedRowIds: walkBackAccepted.slice(0, 1), dates: externalDates },
    graph,
    timingTable,
  })
);
harvest(
  'analyseImportImpact(a projection that resolves the clash the standing plan carries)',
  analyseImportImpact({
    subject: 'walking every published time back',
    resolution: walkBackResolution,
    standing: publishedStanding,
    query: { acceptedRowIds: walkBackAccepted, dates: externalDates },
    graph,
    timingTable,
  })
);

// The avoid-windows export: the corpus scope, a surface with no external name,
// one two labels claim, an open-ended window, an empty scope, a scope that
// yields nothing, and a round trip through a registry that lost a record.
const avoidExport = harvest(
  'buildAvoidWindows(the seeding weekend)',
  buildAvoidWindows({
    query: {
      subject: 'avoid windows for the seeding weekend',
      documentId: 'season-2026/avoid/seeding-weekend',
      generatedFor: 'external seeding league',
      dates: ['2026-08-22', '2026-08-23'],
      surfaceIds: [
        season2026SurfaceId('Alder Park', 'Pitch 2'),
        season2026SurfaceId('Alder Park', 'Pitch 3'),
      ],
      excludeFixtureIds: season.combinedGames
        .filter((game) => game.kind === SEASON_2026_ROW_KIND.EXTERNAL_FIXTURE)
        .map((game) => game.id),
    },
    registry: externalRegistry,
    standing: externalStanding,
    graph,
  })
);
harvest(
  'checkAvoidWindowRoundTrip(a registry that lost a record)',
  checkAvoidWindowRoundTrip(avoidExport, externalReduced)
);
harvest(
  'buildAvoidWindows(a surface the league has no name for)',
  buildAvoidWindows({
    query: {
      subject: 'a pitch the league has no name for',
      documentId: 'orphan-1',
      generatedFor: 'external seeding league',
      dates: ['2026-08-22'],
      surfaceIds: [season2026SurfaceId('Brookside Park', 'Upper 1')],
      excludeFixtureIds: [],
    },
    registry: externalRegistry,
    standing: externalStanding,
    graph,
  })
);
harvest(
  'buildAvoidWindows(a surface two external labels claim)',
  buildAvoidWindows({
    query: {
      subject: 'a pitch with two external names',
      documentId: 'ambiguous-1',
      generatedFor: 'external seeding league',
      dates: ['2026-08-22'],
      surfaceIds: [season2026SurfaceId('Alder Park', 'Pitch 2')],
      excludeFixtureIds: [],
    },
    registry: buildExternalMappingRegistry(
      season2026ExternalMappingInput({
        records: [
          ...SEASON_2026_EXTERNAL_MAPPING_RECORDS,
          {
            id: 'renamed',
            kind: EXTERNAL_MAPPING_KIND.VENUE,
            externalLabel: 'Alder Park (Championship Pitch)',
            venueId: season2026VenueId('Alder Park'),
            surfaceId: season2026SurfaceId('Alder Park', 'Pitch 2'),
            subjectId: null,
            provenance: 'constructed: the league renamed the pitch mid-season',
          },
        ],
      }),
      { graph }
    ),
    standing: externalStanding,
    graph,
  })
);
harvest(
  'buildAvoidWindows(an open-ended window at the stadium)',
  buildAvoidWindows({
    query: {
      subject: 'the stadium on the seeding Saturday',
      documentId: 'summit-1',
      generatedFor: 'external seeding league',
      dates: [untimedFixtures[0].date],
      surfaceIds: [untimedFixtures[0].surfaceId],
      excludeFixtureIds: [],
    },
    registry: untimedRegistry,
    standing: externalStanding,
    graph,
  })
);
// A scope surface a record claims but the facility graph does not hold. The
// registry keeps such a record (reporting EXTERNAL_MAPPING_TARGET_UNKNOWN), so
// the label reverse-resolves and the export reaches `conflictingSurfacesOf()`,
// which used to throw `requireSurface()` out of the whole export.
harvest(
  'buildAvoidWindows(a scope surface the facility graph does not hold)',
  buildAvoidWindows({
    query: {
      subject: 'a pitch the club does not have',
      documentId: 'ghost-1',
      generatedFor: 'external seeding league',
      dates: ['2026-08-22'],
      surfaceIds: ['alder-park/pitch-9'],
      excludeFixtureIds: [],
    },
    registry: buildExternalMappingRegistry(
      {
        registryId: 'ghost-scope',
        label: 'a record naming ground the graph does not have',
        party: 'external seeding league',
        records: [
          {
            id: 'ghost-pitch',
            kind: EXTERNAL_MAPPING_KIND.VENUE,
            externalLabel: 'Alder Park (Pitch 9)',
            venueId: season2026VenueId('Alder Park'),
            surfaceId: 'alder-park/pitch-9',
            subjectId: null,
            provenance: 'constructed for tests/reasonCodeReachability.test.js',
          },
        ],
      },
      { graph }
    ),
    standing: externalStanding,
    graph,
  })
);
harvest(
  'buildAvoidWindows(an empty scope)',
  buildAvoidWindows({
    query: {
      subject: 'nothing at all',
      documentId: 'empty-1',
      generatedFor: 'external seeding league',
      dates: [],
      surfaceIds: [],
      excludeFixtureIds: [],
    },
    registry: externalRegistry,
    standing: externalStanding,
    graph,
  })
);
// Also `EXTERNAL_AVOID_SURFACE_SUPPRESSED`: the pitch is mapped and in the
// graph, and the only fixtures occupying it or its overlap cone that day are
// the external ones this export excludes — so every occupant was dropped by
// the caller's own list, which is not the same fact as a pitch nobody booked
// and no longer shares its code.
harvest(
  'buildAvoidWindows(a scope whose every occupant is excluded)',
  buildAvoidWindows({
    query: {
      subject: 'a date with nothing on it',
      documentId: 'quiet-1',
      generatedFor: 'external seeding league',
      dates: ['2026-08-23'],
      surfaceIds: [season2026SurfaceId('Alder Park', 'Pitch 2')],
      excludeFixtureIds: season.combinedGames
        .filter((game) => game.kind === SEASON_2026_ROW_KIND.EXTERNAL_FIXTURE)
        .map((game) => game.id),
    },
    registry: externalRegistry,
    standing: externalStanding,
    graph,
  })
);
// `EXTERNAL_AVOID_SURFACE_IDLE`: the same mapped, in-graph pitch on a date the
// corpus holds nothing at all on — examined, and found free, which is the one
// arrangement whose sentence is a statement about our schedule.
harvest(
  'buildAvoidWindows(a date the club held nothing on)',
  buildAvoidWindows({
    query: {
      subject: 'a pitch on a date nothing touches',
      documentId: 'idle-driver-1',
      generatedFor: 'external seeding league',
      dates: ['2026-10-10'],
      surfaceIds: [season2026SurfaceId('Alder Park', 'Pitch 2')],
      excludeFixtureIds: [],
    },
    registry: externalRegistry,
    standing: externalStanding,
    graph,
  })
);
// `EXTERNAL_AVOID_SURFACE_NOT_EXAMINED`: a scope naming a surface and no date.
// The export is refused whole (`EXTERNAL_AVOID_SCOPE_EMPTY`), and the surface
// the caller asked about is still accounted for — as never looked at, which is
// not the same as looked at and found free.
harvest(
  'buildAvoidWindows(a scope that names a surface and no date)',
  buildAvoidWindows({
    query: {
      subject: 'a surface, and no date to look at it on',
      documentId: 'unexamined-driver-1',
      generatedFor: 'external seeding league',
      dates: [],
      surfaceIds: [season2026SurfaceId('Alder Park', 'Pitch 2')],
      excludeFixtureIds: [],
    },
    registry: externalRegistry,
    standing: externalStanding,
    graph,
  })
);
harvest(
  'readExternalMappingRegistry(a document whose records name a surface that is not there)',
  readExternalMappingRegistry(
    (() => {
      const document = serialiseExternalMappingRegistry(externalRegistry);
      return {
        ...document,
        records: document.records.map((record) => ({
          ...record,
          surfaceId: 'alder-park/pitch-9',
        })),
      };
    })(),
    { graph }
  )
);

/* -------------------------------------------------------------------------- */
/* fixtures/season2026PracticeParsers — the practice corpus (Phase 8.0)        */
/* -------------------------------------------------------------------------- */

// The corpus itself carries 22 of the 28 codes: 28 unresolved venues, the
// Excel-corrupted rows, the two decoder rings' 12 disagreements, the minted
// people, and so on. The six it does not carry are the six it should not:
// a row the source could not interpret at all, a reservation whose stated day
// is not its date's, a reservation dated outside the season year, a change-log
// note that disagrees with its date, a code listed twice in one decoder ring,
// and a practice slot for a team the roster does not hold. Each is driven
// through the same public parser the loader calls, fed a one- or two-row file.
const practiceCorpus = harvest(
  'loadSeason2026Practice(the season-2026 practice corpus)',
  loadSeason2026Practice({ season })
);
harvest(
  'parseWeeklyAvailability(a row the source could not interpret)',
  parseWeeklyAvailability(
    'venue,day,raw_value,interpreted_window,interpretation\nOrchard Park,Mon,ask the office,,unparsed\n'
  )
);
harvest(
  "parsePermitReservations(a reservation whose stated day is not its date's)",
  parsePermitReservations(
    'permit_id,venue,date,day,start,end,facility,services\nPERMIT-01,Alder Park,2026-08-10,Tuesday,18:00,20:00,Field - Soccer 1A/1B (Field),\n'
  )
);
harvest(
  'parseGameChangeLog(a note that disagrees with the date it was given)',
  parseGameChangeLog(
    'date,matchup,was,now,reason\nNov 08 (Mon),A vs B,(not previously scheduled),5:30 PM Alder Park Soccer 2,r\n',
    { seasonYear: 2026 }
  )
);
harvest(
  'parseFieldCodeNames(a code listed twice)',
  parseFieldCodeNames(
    'code_name,actual_label,venue,remainder,uncertain,confirmed,used_for\n7v7 Field 1,X,X,,,,\n7v7 Field 1,Y,Y,,,,\n'
  )
);
harvest(
  'crossCorpusFindings(a grid naming a team the roster does not hold, and a reservation dated outside the season year)',
  crossCorpusFindings(
    {
      'practice_grid.csv': parsePracticeGrid(
        'source_sheet,venue,field,subunit,day,start,duration_minutes,team_code\nS,Orchard Park,Field 1,A,Tuesday,16:00,45,05GMicro99\n'
      ),
      'practice_field_aliases.csv': { records: practiceCorpus.fieldAliases },
      'field_constraints.csv': { records: practiceCorpus.fieldConstraints },
      'field_code_names.csv': { records: practiceCorpus.fieldCodeNames },
      'coach_registration.csv': { records: practiceCorpus.coachRegistrations },
      'player_registration.csv': { records: practiceCorpus.playerRegistrations },
      'select_coaches.csv': { records: practiceCorpus.selectCoaches },
      'permits.csv': { records: practiceCorpus.permits },
      'permit_reservations.csv': parsePermitReservations(
        'permit_id,venue,date,day,start,end,facility,services\nPERMIT-01,Alder Park,2027-08-10,Tuesday,18:00,20:00,Field - Soccer 1A/1B (Field),\n'
      ),
      'field_inventory.csv': { records: practiceCorpus.fieldInventory },
      'field_weekly_availability.csv': { records: practiceCorpus.weeklyAvailability },
      'field_equipment.csv': { records: practiceCorpus.fieldEquipment },
    },
    season
  )
);

/* -------------------------------------------------------------------------- */
/* fieldAdmin: import as a proposal                                            */
/* -------------------------------------------------------------------------- */

/** A blackout record, valid by construction. */
const fieldAdminBlackout = (id, overrides = {}) =>
  BlackoutWindowSchema.parse({
    id,
    scope: BLACKOUT_SCOPE.VENUE,
    venueIds: ['venue-a'],
    surfaceIds: [],
    fromDate: '2026-09-01',
    toDate: '2026-09-01',
    startMinutes: null,
    endMinutes: null,
    reason: BLACKOUT_REASON.CLOSURE,
    note: null,
    source: RECORD_SOURCE.CONSTRAINT_SHEET,
    ...overrides,
  });

/** A projected row wrapping a record. */
const fieldAdminRow = (subjectKey, record, overrides = {}) => ({
  sourceFile: 'driver.csv',
  rowIndex: 0,
  subjectKey,
  interpretation: INTERPRETATION.INTERPRETED,
  interpretationReason: null,
  raw: { key: subjectKey },
  record,
  ...overrides,
});

const fieldAdminChangeSet = (records, rows) =>
  buildChangeSet({
    subject: 'driver blackouts',
    keyFields: ['id'],
    comparedFields: ['fromDate', 'toDate', 'reason'],
    current: { label: 'held', records },
    proposed: { label: 'proposed', rows },
  });

// One change set reaching matched, differing, added, removed, doubtful,
// unresolvable, the two aggregates and the always-emitted proposal notice.
harvest(
  'buildChangeSet(a set holding every disposition at once)',
  fieldAdminChangeSet(
    [fieldAdminBlackout('same'), fieldAdminBlackout('changed'), fieldAdminBlackout('gone')],
    [
      fieldAdminRow('same', fieldAdminBlackout('same')),
      fieldAdminRow('changed', fieldAdminBlackout('changed', { toDate: '2026-09-09' })),
      fieldAdminRow('added-a', fieldAdminBlackout('added-a'), {
        interpretation: INTERPRETATION.DOUBTFUL,
        interpretationReason: 'Excel ate the cell',
      }),
      fieldAdminRow('unplaceable', null, {
        interpretation: INTERPRETATION.UNRESOLVABLE,
        interpretationReason: 'the venue is not in the graph',
      }),
    ]
  )
);

// A subject both sides hold, whose every compared field is absent.
harvest(
  'buildChangeSet(a subject nothing could be compared on)',
  buildChangeSet({
    subject: 'driver uncompared',
    keyFields: ['id'],
    comparedFields: ['fromDate', 'toDate', 'reason'],
    current: { label: 'held', records: [{ id: 'bare' }] },
    proposed: {
      label: 'proposed',
      rows: [
        {
          sourceFile: 'driver.csv',
          rowIndex: 0,
          subjectKey: 'bare',
          interpretation: INTERPRETATION.INTERPRETED,
          interpretationReason: null,
          raw: { key: 'bare' },
          record: { id: 'bare' },
        },
      ],
    },
  })
);

// Two held records sharing one identity.
harvest(
  'buildChangeSet(two held records sharing one identity)',
  fieldAdminChangeSet(
    [fieldAdminBlackout('dup'), fieldAdminBlackout('dup', { toDate: '2026-09-09' })],
    [fieldAdminRow('dup', fieldAdminBlackout('dup'))]
  )
);

// Two sources describing one subject and disagreeing.
harvest(
  'buildChangeSet(two sources describing one subject)',
  fieldAdminChangeSet(
    [],
    [
      fieldAdminRow('shared', fieldAdminBlackout('shared'), { sourceFile: 'a.csv' }),
      fieldAdminRow('shared', fieldAdminBlackout('shared', { toDate: '2026-09-09' }), {
        sourceFile: 'b.csv',
        rowIndex: 1,
      }),
    ]
  )
);

// A change set over nothing, and a first load that compares nothing.
harvest('buildChangeSet(nothing at all)', fieldAdminChangeSet([], []));
harvest(
  'buildChangeSet(a first load with one source)',
  fieldAdminChangeSet([], [fieldAdminRow('only', fieldAdminBlackout('only'))])
);

// The reconciliation, handed a partition that does not add up. Called directly
// because a sound builder cannot produce one - which is the whole reason it is
// exported.
harvest(
  'changeSetPartitionFindings(a partition with a subject dropped)',
  changeSetPartitionFindings(
    {
      matched: [],
      differing: [],
      added: [],
      removed: [],
      uncompared: [],
      unresolvable: [],
      fieldComparisons: 0,
    },
    { sourceRowsRead: 1, currentSubjectsRead: 1, projectedSubjects: 1 }
  )
);

harvest(
  'buildFieldRegistry(a registry that persists nothing)',
  buildFieldRegistry({
    registryId: 'driver',
    label: 'driver',
    kind: 'blackout',
    records: [fieldAdminBlackout('b1')],
  })
);

// The consequence half of 8.4 PR 3. Both codes come from plain input objects:
// a closure over ground a game and a practice already hold, and the repair
// proposal that cannot be computed because 8.6 does not exist.
harvest(
  'findBlackoutConflicts(a closure over booked ground)',
  findBlackoutConflicts({
    closures: [
      {
        id: 'c1',
        source: 'field_blackouts',
        closesLocationId: 'loc-1',
        blackoutFrom: '2026-09-14',
        blackoutUntil: '2026-09-20',
      },
    ],
    fields: [{ id: 'f1', locationId: 'loc-1' }],
    dated: [{ kind: 'game', id: 'g1', fieldId: 'f1', onDate: '2026-09-16' }],
    recurring: [{ kind: 'practice', id: 'p1', fieldId: 'f1', dayOfWeek: 3 }],
  }).findings
);
harvest('repairProposal(8.6 does not exist)', repairProposal({ affectedCount: 2 }).finding);

/* -------------------------------------------------------------------------- */
/* practice: the recurring-practice model (Phase 8.5)                          */
/* -------------------------------------------------------------------------- */

// Every one of the sixteen codes is driven from a public entry point on
// constructed input — no hole to register. The model is young enough that
// nothing has yet had time to become unreachable, which is the point of
// auditing it on the way in rather than later.
//
// `PRACTICE_MODEL_UNWIRED` is on every result by construction, so the first
// call below carries it.

/** A Tuesday slot over September 2026; 2026-09-01 is a Tuesday. */
const practiceSlot = (overrides = {}) => ({
  id: 'pm-1',
  surfaceId: 'rig/half',
  weekday: 'TUE',
  startMinutes: 1020,
  durationMinutes: 60,
  validFrom: '2026-09-01',
  validUntil: '2026-09-30',
  capacity: 1,
  revisionId: 'r1',
  label: null,
  ...overrides,
});

/** Duplicate window inside one revision, a dead Friday slot, two undated plans. */
const practicePlan = harvest(
  'buildPracticeSlotSet(duplicate window, dead slot, two undated revisions)',
  buildPracticeSlotSet({
    slots: [
      practiceSlot(),
      // Same revision, same window: a plan contradicting itself.
      practiceSlot({ id: 'pm-2' }),
      // A Friday slot over a Tue–Wed range occurs never.
      practiceSlot({
        id: 'pm-3',
        weekday: 'FRI',
        validFrom: '2026-09-01',
        validUntil: '2026-09-02',
      }),
      // Two revisions the source never dated, so neither can be ordered.
      practiceSlot({ id: 'pm-4', validFrom: null, validUntil: null, revisionId: 'r2' }),
      practiceSlot({ id: 'pm-5', validFrom: null, validUntil: null, revisionId: 'r3' }),
      // Ground an adapter could not place against the facility graph.
      practiceSlot({ id: 'pm-6', revisionId: 'r4', surfaceResolution: 'venue-unknown' }),
    ],
    assignments: [
      { id: 'pa-1', slotId: 'pm-1', teamId: 'PT1' },
      // Same September range as pm-1, so PT1's two phases overlap.
      { id: 'pa-2', slotId: 'pm-2', teamId: 'PT1' },
    ],
    source: 'reachability rig',
  })
);

harvest(
  'materialisePracticeOccurrences(cancelled, moved, shortened, misdated, unknown slot)',
  materialisePracticeOccurrences(practicePlan, {
    from: '2026-09-01',
    to: '2026-09-30',
    exceptions: [
      { id: 'px-1', slotId: 'pm-1', date: '2026-09-08', kind: 'cancelled', reason: 'rain-out' },
      {
        id: 'px-2',
        slotId: 'pm-1',
        date: '2026-09-15',
        kind: 'moved',
        reason: 'clash',
        startMinutes: 1080,
      },
      {
        id: 'px-3',
        slotId: 'pm-1',
        date: '2026-09-22',
        kind: 'shortened',
        reason: 'early sunset',
        durationMinutes: 30,
      },
      // A Wednesday, on a Tuesday slot: aimed at nothing.
      { id: 'px-4', slotId: 'pm-1', date: '2026-09-16', kind: 'cancelled', reason: 'typo' },
      // A slot this plan does not hold.
      { id: 'px-5', slotId: 'ghost', date: '2026-09-29', kind: 'cancelled', reason: 'wrong plan' },
      // Aimed at a date 'px-1' already cancelled: superseded, not unmatched.
      {
        id: 'px-6',
        slotId: 'pm-1',
        date: '2026-09-08',
        kind: 'moved',
        reason: 'stale request',
        startMinutes: 1140,
      },
    ],
  })
);

harvest(
  'buildPracticeHistory(a team id no assignment names)',
  buildPracticeHistory(practicePlan, { teamId: 'PT-nobody' })
);

harvest(
  'materialisePracticeOccurrences(a month in which nothing is scheduled)',
  materialisePracticeOccurrences(practicePlan, { from: '2026-11-01', to: '2026-11-30' })
);

harvest(
  'buildPracticeHistory(a team holding two overlapping ranges)',
  buildPracticeHistory(practicePlan, { teamId: 'PT1' })
);

harvest(
  'buildPracticeHistory(a team whose ranges leave a gap)',
  buildPracticeHistory(
    buildPracticeSlotSet({
      slots: [
        practiceSlot({ id: 'pg-1', validFrom: '2026-08-01', validUntil: '2026-08-31' }),
        practiceSlot({ id: 'pg-2', validFrom: '2026-09-15', validUntil: '2026-09-30' }),
      ],
      assignments: [
        { id: 'pga-1', slotId: 'pg-1', teamId: 'PT2' },
        { id: 'pga-2', slotId: 'pg-2', teamId: 'PT2' },
      ],
    }),
    { teamId: 'PT2' }
  )
);

/* -------------------------------------------------------------------------- */
/* changelog/                                                                  */
/* -------------------------------------------------------------------------- */

/** A raw change-log entry, varied one field at a time. */
const changeEntry = (overrides = {}) => ({
  date: '2026-10-03',
  home: 'CL-A',
  away: 'CL-B',
  reason: 'because',
  before: { raw: '10:00', startMinutes: 600, location: 'Pitch 1', scheduled: true },
  after: { raw: '10:30', startMinutes: 630, location: 'Pitch 1', scheduled: true },
  ...overrides,
});
const changeTeams = [
  { teamId: 'CL-A', teamName: null },
  { teamId: 'CL-B', teamName: null },
];
const claimsEverything = [{ id: 'cl-any', title: 'anything', matches: () => true }];

// SOURCE_UNDECLARED, COVERAGE_UNSTATED, TRANSACTION_TIME_ABSENT, LOG_NOT_PERSISTED.
harvest(
  'buildChangeLog(a reason no source declares)',
  buildChangeLog({
    subject: 'changelog rig',
    entries: [changeEntry()],
    sources: [{ id: 'cl-never', title: 'never', matches: () => false }],
    teams: changeTeams,
  })
);

// SOURCE_AMBIGUOUS and SOURCE_MATCHED_NOTHING in one pass: two matchers claim
// the single entry, so the third declaration claims nothing.
harvest(
  'buildChangeLog(two sources claiming one entry, and a third claiming none)',
  buildChangeLog({
    subject: 'changelog rig',
    entries: [changeEntry()],
    sources: [
      { id: 'cl-one', title: 'one', matches: () => true },
      { id: 'cl-two', title: 'two', matches: () => true },
      { id: 'cl-three', title: 'three', matches: () => false },
    ],
    teams: changeTeams,
    coverage: 'stated, so COVERAGE_UNSTATED is not what this call proves',
  })
);

// PARTICIPANT_UNRESOLVED — a side that is neither a team nor a declared label.
harvest(
  'buildChangeLog(a participant nobody answers to)',
  buildChangeLog({
    subject: 'changelog rig',
    entries: [changeEntry({ away: 'CL-nobody' })],
    sources: claimsEverything,
    teams: changeTeams,
  })
);

// PARTICIPANT_AMBIGUOUS — one team's name is another team's id.
harvest(
  'buildChangeLog(a label two teams answer to)',
  buildChangeLog({
    subject: 'changelog rig',
    entries: [changeEntry()],
    sources: claimsEverything,
    teams: [...changeTeams, { teamId: 'CL-C', teamName: 'CL-A' }],
  })
);

// PARTICIPANT_SELF_PAIRED — both sides resolve to one team.
harvest(
  'buildChangeLog(a fixture whose sides are one team)',
  buildChangeLog({
    subject: 'changelog rig',
    entries: [changeEntry({ away: 'The As' })],
    sources: claimsEverything,
    teams: [{ teamId: 'CL-A', teamName: 'The As' }],
  })
);

// ENTRY_CHANGED_NOTHING and HISTORY_CONFLICT — two entries on one date, the
// second of which changes nothing.
const changeLogWithConflict = buildChangeLog({
  subject: 'changelog rig',
  entries: [
    changeEntry(),
    changeEntry({
      after: { raw: '10:00', startMinutes: 600, location: 'Pitch 1', scheduled: true },
    }),
  ],
  sources: claimsEverything,
  teams: changeTeams,
});
harvest('buildChangeLog(two states on one date, one of them a no-op)', changeLogWithConflict);
harvest(
  'buildChangeHistory(a subject holding two states on one date)',
  buildChangeHistory(changeLogWithConflict, { subjectId: 'CL-A v CL-B' })
);

// HISTORY_EMPTY — a subject the log never names.
harvest(
  'buildChangeHistory(a subject the log never names)',
  buildChangeHistory(changeLogWithConflict, { subjectId: 'CL-nothing v CL-nothing' })
);

// AS_OF_UNJUDGED — a state asked for with no date to apply.
harvest('stateAsOf(no as-of date)', stateAsOf(changeLogWithConflict, { subjectId: 'CL-A v CL-B' }));

// AS_OF_PRECEDES_LOG — the subject IS in the log and every entry postdates the
// date asked about. Distinct from HISTORY_EMPTY, which is the subject the log
// never names; the two were once the same answer, on the field the module
// header nominates to keep them apart.
harvest(
  'stateAsOf(a date before the subject’s first entry)',
  stateAsOf(changeLogWithConflict, { subjectId: 'CL-A v CL-B', asOf: '2026-01-01' })
);

// PARTITION_UNSOUND cannot be produced by handing `buildChangeLog()` input:
// it counts its own buckets as it fills them, so making it disagree would mean
// introducing the drop it exists to catch. It is driven through the exported
// reconciliation instead — the same seam `tests/changelog.test.js` falsifies
// in both directions, and the reason that function is public at all.
harvest(
  'changeLogPartitionFindings(a partition short of an entry)',
  changeLogPartitionFindings({ changed: 1 }, { [UNDECLARED_SOURCE]: 3 }, 2)
);

/* -------------------------------------------------------------------------- */
/* The audit                                                                   */
/* -------------------------------------------------------------------------- */

describe('reason codes :: the audit itself', () => {
  it('found every frozen reason-code table the source declares', () => {
    // The registry above is written by hand, so this is the check that keeps it
    // honest: a new module's table must be audited or explicitly named as
    // something other than a finding vocabulary. Neither can happen by silence.
    const registered = new Set([
      ...Object.keys(TABLES),
      ...Object.keys(NOT_A_FINDING_TABLE),
      ...Object.keys(TABLES_AWAITING_DRIVER),
    ]);
    const found = scanForFrozenCodeTables();
    // Meta-assertion: a scan that matched nothing would make the line below
    // pass while looking at an empty set.
    expect(found.length).toBeGreaterThanOrEqual(Object.keys(TABLES).length);
    expect(
      found.filter((entry) => !registered.has(entry.name)).map((e) => `${e.file}:${e.name}`)
    ).toEqual([]);
    // …and every audited or excluded name is a table the scan can still find,
    // so a deleted table cannot leave a registration behind. The awaiting list
    // is exempt for the reason stated on it.
    const foundNames = new Set(found.map((entry) => entry.name));
    expect(
      [...Object.keys(TABLES), ...Object.keys(NOT_A_FINDING_TABLE)].filter(
        (name) => !foundNames.has(name)
      )
    ).toEqual([]);
  });

  it('states its own shape in the header, and the header is read back to check it', () => {
    // **Prose that drifts is prose nobody can trust.** The header's count has
    // been wrong since well before the code that made it wrong was noticed:
    // three commits added codes and none of them touched the sentence. It is
    // parsed back out of this file rather than restated here, so the next code
    // added fails this test instead of quietly ageing the docstring.
    const header = readFileSync(fileURLToPath(import.meta.url), 'utf8')
      .slice(0, 4000)
      .replace(/\n\s*\*\s?/g, ' ');
    const claim = header.match(
      /(\d+) vocabularies, (\d+) codes, of which (\d+) are shown to be producible and (\d+) are named as holes/
    );
    // Meta-assertion: a header this failed to parse would make every
    // comparison below vacuous.
    expect(claim).not.toBeNull();
    const [vocabularies, codes, producible, holes] = /** @type {RegExpMatchArray} */ (claim)
      .slice(1)
      .map(Number);
    expect(vocabularies).toBe(Object.keys(TABLES).length);
    expect(codes).toBe(DECLARED.size);
    expect(producible).toBe(emitted.size);
    expect(holes).toBe(UNREACHABLE.length);

    // **The other sentence, which was not checked and had drifted.** It stated
    // the split between the two kinds of hole in words — "Five … and three
    // more" — while six entries claimed the first kind. An unchecked count
    // beside a checked one is the checked one lending it credit, so it is read
    // back here too.
    // Lower-cased on both sides, because one of the two numbers opens the
    // sentence and the other does not.
    const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
    const split = header.match(
      /(\w+) declared codes cannot be produced through any entry point at all,\s+and\s+(\w+) more only by calling an exported helper/
    );
    // Meta-assertion, as above: a sentence this failed to find proves nothing.
    expect(split).not.toBeNull();
    const [stated, alsoStated] = /** @type {RegExpMatchArray} */ (split)
      .slice(1)
      .map((word) => word.toLowerCase());
    expect(WORDS).toContain(stated);
    expect(WORDS).toContain(alsoStated);
    expect(WORDS.indexOf(stated)).toBe(
      UNREACHABLE.filter((entry) => entry.why === WHY.NO_PRODUCTION_PATH).length
    );
    expect(WORDS.indexOf(alsoStated)).toBe(
      UNREACHABLE.filter((entry) => entry.why === WHY.NOT_CONSTRUCTED).length
    );
  });

  it('drove enough production paths for a shortfall to mean something', () => {
    // Without this, "every code is accounted for" would also be true of a
    // driver that called nothing and allowlisted everything.
    expect(emitted.size).toBeGreaterThanOrEqual(260);
    expect(DECLARED.size).toBeGreaterThanOrEqual(275);
    expect(UNREACHABLE.length).toBeLessThan(DECLARED.size / 10);
  });

  it('parks at most one vocabulary as awaiting a driver, each with a stated reason', () => {
    // The cap is the point: one declared gap is a note to whoever lands that
    // module, two is this audit quietly ceasing to cover the package.
    const parked = Object.entries(TABLES_AWAITING_DRIVER);
    expect(parked.length).toBeLessThanOrEqual(1);
    for (const [name, reason] of parked) {
      expect(name).toMatch(/_REASON$/);
      expect(reason.trim().length).toBeGreaterThanOrEqual(40);
      expect(Object.keys(TABLES)).not.toContain(name);
    }
  });

  it('refuses an allowlist entry with no stated reason, and one for a code nothing declares', () => {
    // The positive control for the allowlist's own construction: if these
    // succeeded, the allowlist would be a list of names, which is a way to
    // silence this file rather than a record of what is known to be broken.
    expect(() => allow(SOME_DECLARED_CODE, WHY.NO_PRODUCTION_PATH, '')).toThrow(/stated reason/);
    expect(() => allow(SOME_DECLARED_CODE, WHY.NO_PRODUCTION_PATH, 'because')).toThrow(
      /stated reason/
    );
    expect(() =>
      allow(
        SOME_DECLARED_CODE,
        /** @type {any} */ ('made-up-kind'),
        'a reason long enough to clear the length floor'
      )
    ).toThrow(/no valid WHY/);
    expect(() =>
      allow(
        'NOT_A_DECLARED_CODE',
        WHY.NO_PRODUCTION_PATH,
        'a reason long enough to clear the floor'
      )
    ).toThrow(/no table declares it/);
  });

  it('holds no allowlist entry for a code the driver did emit', () => {
    // An allowlist that outlives its reason is how a fixed hole stays recorded
    // as a hole. A code that fires must not also be excused.
    const excused = UNREACHABLE.filter((entry) => emitted.has(entry.code));
    expect(excused.map((entry) => `${entry.code} (fired by ${emitted.get(entry.code)})`)).toEqual(
      []
    );
    expect(new Set(UNREACHABLE.map((entry) => entry.code)).size).toBe(UNREACHABLE.length);
  });
});

describe('reason codes :: every declared code is reachable or registered as unreachable', () => {
  const allowed = new Map(UNREACHABLE.map((entry) => [entry.code, entry]));

  for (const [name, table] of Object.entries(TABLES)) {
    it(`${name}: every code fires somewhere, or says why it cannot`, () => {
      const codes = Object.values(table);
      // Meta-assertion: an empty table would pass the loop below vacuously.
      expect(codes.length).toBeGreaterThan(0);
      const unaccounted = codes
        .filter((code) => !emitted.has(code) && !allowed.has(code))
        .sort()
        .map(
          (code) =>
            `${code} was declared by ${name}, no production path this audit drives emits it, and no ` +
            `UNREACHABLE entry says why. Either drive it from a public entry point above, or register ` +
            `it with allow('${code}', WHY.NO_PRODUCTION_PATH | WHY.NOT_CONSTRUCTED, '<why>').`
        );
      expect(unaccounted).toEqual([]);
    });
  }

  it('reports what it excused, so the list is read rather than accumulated', () => {
    // Not a check — a record. The reasons are the deliverable; this asserts
    // only that each is a claim somebody can check, and that the two kinds of
    // claim stay distinguishable.
    for (const entry of UNREACHABLE) {
      expect(Object.values(WHY)).toContain(entry.why);
      expect(entry.reason.length).toBeGreaterThanOrEqual(40);
      expect(TABLE_OF.has(entry.code)).toBe(true);
    }
    const byKind = Object.fromEntries(
      Object.values(WHY).map((why) => [why, UNREACHABLE.filter((e) => e.why === why).length])
    );
    expect(byKind[WHY.NO_PRODUCTION_PATH] + byKind[WHY.NOT_CONSTRUCTED]).toBe(UNREACHABLE.length);
  });
});

/**
 * Source with every comment removed and every string literal left intact.
 *
 * Character by character rather than by regex, because both shortcuts are
 * wrong in this repo: a `//` inside a message would truncate a real line, and
 * an apostrophe inside a docstring would open a string that never closes. A
 * table this failed to see would be a table the audit never asks about.
 *
 * @param {string} text
 * @returns {string}
 */
function stripComments(text) {
  let out = '';
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '/' && text[index + 1] === '*') {
      const close = text.indexOf('*/', index + 2);
      index = close === -1 ? text.length : close + 1;
      continue;
    }
    if (character === '/' && text[index + 1] === '/') {
      const newline = text.indexOf('\n', index);
      index = newline === -1 ? text.length : newline - 1;
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      const quote = character;
      out += character;
      index += 1;
      while (index < text.length && text[index] !== quote) {
        out += text[index];
        if (text[index] === '\\') {
          index += 1;
          out += text[index] ?? '';
        }
        index += 1;
      }
      out += text[index] ?? '';
      continue;
    }
    out += character;
  }
  return out;
}

/**
 * Every exported frozen table in `packages/core/src` whose entries all map a
 * key to itself — the shape every reason-code table has.
 *
 * A static read of the source rather than a sweep of module exports, so it sees
 * a table declared in a file nothing imports. Its blind spot is a table not
 * written as an object literal: `constraints/baseSeverity.js` builds its own by
 * merging four others at load time, and a table built that way would not be
 * found here. That merge is derived from tables this does find, which is why
 * the blind spot is tolerable rather than merely unnoticed.
 *
 * @returns {Array<{ file: string, name: string }>}
 */
function scanForFrozenCodeTables() {
  /** @param {string} dir @param {string[]} out */
  const walk = (dir, out) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (entry.endsWith('.js')) out.push(full);
    }
    return out;
  };

  /**
   * The literal that follows `Object.freeze(` at `from`, brace-matched rather
   * than matched to the first `});` — a regex terminator would make discovery
   * depend on how the table happens to be formatted.
   *
   * @param {string} text
   * @param {number} from - index of the opening `{`
   * @returns {string|null}
   */
  const literalAt = (text, from) => {
    let depth = 0;
    for (let index = from; index < text.length; index += 1) {
      const character = text[index];
      if (character === '{') depth += 1;
      else if (character === '}') {
        depth -= 1;
        if (depth === 0) return text.slice(from + 1, index);
      } else if (character === "'" || character === '"' || character === '`') {
        // Skip the string, so a brace inside a message cannot unbalance this.
        index += 1;
        while (index < text.length && text[index] !== character) {
          index += text[index] === '\\' ? 2 : 1;
        }
      }
    }
    return null;
  };

  /** @type {Array<{ file: string, name: string }>} */
  const found = [];
  for (const file of walk(CORE, [])) {
    // Comments go first and once: prose is full of apostrophes, and a scanner
    // that met one while brace-matching would read the rest of a docstring as
    // a string literal.
    const text = stripComments(readFileSync(file, 'utf8'));
    const pattern = /export const ([A-Z][A-Z0-9_]*) = Object\.freeze\(\{/g;
    let match;
    while ((match = pattern.exec(text))) {
      const body = literalAt(text, pattern.lastIndex - 1);
      if (body === null) continue;
      // What is left must be nothing but `KEY: 'VALUE'` pairs, or this is not
      // a vocabulary table and the audit has no opinion about it.
      const chunks = body
        .split(',')
        .map((chunk) => chunk.trim())
        .filter((chunk) => chunk.length > 0);
      const entries = chunks.map((chunk) => /^([A-Za-z_$][\w$]*)\s*:\s*'([^']*)'$/.exec(chunk));
      if (!entries.length || entries.some((entry) => entry === null)) continue;
      // A vocabulary is either identity-mapped — the shape every finding table
      // in this package has — or named `*_REASON`, so a table that aliased one
      // of its codes to a different string still has to be accounted for
      // rather than quietly failing the shape test.
      const named = /_REASON$/.test(match[1]);
      const identityMapped = entries.every(
        (entry) =>
          /** @type {RegExpExecArray} */ (entry)[1] === /** @type {RegExpExecArray} */ (entry)[2]
      );
      if (identityMapped || named) {
        found.push({ file: path.relative(CORE, file), name: match[1] });
      }
    }
  }
  return found;
}
