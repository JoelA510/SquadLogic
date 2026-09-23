/**
 * Barrel for **schedule scenarios**: branching a published baseline, diffing
 * two branches, and promoting one to primary.
 *
 * Every public export of `scenario/` goes through this file, exactly as
 * `facility/index.js`, `timing/index.js`, `availability/index.js`,
 * `constraints/index.js`, `waivers/index.js`, `ruleEngine/index.js`,
 * `people/index.js`, `freeze/index.js`, `resolve/index.js`,
 * `attribution/index.js`, `reserve/index.js` and `publication/index.js` do for
 * theirs.
 *
 * ## What this module is
 *
 * > *"The source project needed parallel schedules for 'with/without venue A',
 * > 'with/without venue B', and 'with/without equipment at one site on one
 * > date'. Each was a hand-built duplicate of the entire pipeline, separately
 * > verified, and impossible to keep in sync."*
 *
 * | piece | entry point | what it is |
 * | --- | --- | --- |
 * | **baseline inputs** | {@link makeSeasonInputs} | one immutable bundle of *inputs* — never built engines — that every branch re-derives from |
 * | **a branch** | {@link makeScenario} | an id, a baseline, a parent, a list of overrides and a reason. **No schedule and no records** |
 * | **materialising** | {@link materialiseScenario} | `base ∪ overrides` back into engines, sharing every record set no override touched |
 * | **replacement ground** | {@link proposeRelocations} | a search for spare ground, under a stated policy — **proposed, never solved** |
 * | **the answer** | {@link runScenario} / {@link ScenarioMemo} | lazily derived, fingerprinted, never stored on the scenario |
 * | **the comparison** | {@link diffScenarios} | which games differ, which constraints break, what capacity is lost — and nothing else |
 * | **promotion** | {@link promoteScenario} | a new primary plus the recorded diff, in memory, returning a record |
 *
 * ## What it deliberately is not
 *
 * - **Not a second solver.** Nothing here places a game. `proposeRelocations()`
 *   searches for spare ground and hands the slots to `applyChangeRequest()` by
 *   name; the report says so, and must keep saying so.
 * - **Not a second fitness function.** Quality goes through `scoreSchedule()`.
 *   Nothing in this package multiplies a count by a weight.
 * - **Not a second diff.** The games-moved comparison uses `resolve/state.js`'s
 *   own `ScheduleChange` shape and its own `slotChangedFields()`.
 * - **Not `field_availability_scenarios`.** That SQL table
 *   (`20260522120000_field_availability_phase1.sql:93-112`) models
 *   field-availability *profiles* and is fully orphaned — no scheduler or
 *   evaluator reads it (`ARCHITECTURE.md` §6.13). This module models schedule
 *   *branches*, in memory only. Neither reads the other and they must not be
 *   unified. Same for "snapshot": `teamSnapshot.js` owns that word for teaming,
 *   and `publication/snapshot.js` qualifies its own.
 * - **Not persisted.** Phase 6 is in-memory only. There is no SQL home for a
 *   scenario, a materialisation or a promotion, and this work deliberately
 *   creates none — consistently with Phases 1-5.
 *
 * @module scenario
 */

export {
  RELOCATION_RANKING,
  REPLACEMENT_GRADE,
  SCENARIO_OVERRIDE_KIND,
  SCENARIO_REASON,
  SCENARIO_REASON_SEVERITY,
  SCENARIO_RECORD_SET,
  SCENARIO_SEVERITY,
  SCENARIO_STATUS,
  createScenarioMeta,
  deriveScenarioStatus,
  makeScenarioFinding,
  mergeScenarioMeta,
  scenarioSeverityOf,
} from './reasonCodes.js';

export {
  RelocationPolicySchema,
  ScenarioOverrideSchema,
  ScheduleScenarioSchema,
} from './schemas.js';

export {
  SCENARIO_DIGEST_EXCLUSIONS,
  SCENARIO_RECORD_SET_ORDER,
  canonicalJson,
  digestSubjectOf,
  makeSeasonInputs,
  recordDigest,
  recordsOf,
  seasonInputsDigest,
  withRecords,
} from './inputs.js';

export {
  ancestryProblem,
  composedOverrides,
  expandVenueUnavailable,
  makeScenario,
  materialiseScenario,
  scenarioFingerprint,
} from './scenario.js';

export {
  proposeRelocations,
  rankReplacementOptions,
  relocationOptionsFor,
  replacementSurfacesFor,
} from './relocation.js';

export {
  diffCapacity,
  diffScenarios,
  diffSchedules,
  scheduleDiffPartitionFindings,
} from './diff.js';

export {
  PROMOTION_DIFF_COLUMNS,
  SCENARIO_SHELVE_STAGE_ID,
  ScenarioMemo,
  diffAgainstBaselineScenario,
  promoteScenario,
  runOptionsFingerprint,
  runScenario,
  scenarioDisplacements,
  shelveUnrelocatable,
} from './run.js';

export {
  SEASON_2026_RELOCATION_CADENCE_MINUTES,
  SEASON_2026_RELOCATION_POLICY_SOURCE,
  season2026CapacitySubjects,
  season2026EarliestKickoffFor,
  season2026RelocationPolicy,
  season2026SeasonInputs,
  season2026VenueUnavailableScenario,
} from './adapters/season2026Scenarios.js';
