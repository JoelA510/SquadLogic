/**
 * Barrel for external fixture import with impact analysis — Prompt 7.3.
 *
 * Every public export of `externalImport/` goes through this file, exactly as
 * `facility/index.js`, `timing/index.js`, `availability/index.js`,
 * `constraints/index.js`, `waivers/index.js`, `ruleEngine/index.js`,
 * `people/index.js`, `freeze/index.js`, `resolve/index.js`,
 * `attribution/index.js`, `reserve/index.js`, `publication/index.js`,
 * `scenario/index.js`, `feasibility/index.js` and `fairness/index.js` do for
 * theirs.
 *
 * ## What this module is
 *
 * The three things that let another organisation's published fixture list be
 * read, judged and answered without either side guessing:
 *
 * | thing | what it is | corpus |
 * | --- | --- | --- |
 * | **mapping** | a record set translating the other party's names into our ids, with an explicit persistence seam | `Alder Park (Back Pitch 2)` |
 * | **resolution + impact** | what each imported row *is* against what we hold, and what accepting a stated **set** of them would break | the four 08/22 rows at +30 minutes |
 * | **avoid windows** | what they must not schedule into, in their own naming, read back through the same records | incident 3 |
 *
 * ## The three things it refuses to do
 *
 * - **It does not guess a name.** There is exactly one normalisation,
 *   `normaliseExternalLabel()`, and it removes no word from any label: it trims,
 *   collapses whitespace and case-folds. A label no record claims is
 *   `EXTERNAL_MAPPING_LABEL_UNRESOLVED` at blocking. The matcher that would
 *   resolve `Alder Park (Back Pitch 2)` by treating `Back` as decoration is the
 *   same matcher that merges `Maplewood Back` with `Maplewood Front`, which
 *   `facility_geometry.json` declares as two venues each holding a `Field 1`.
 * - **It does not answer about "the import".** An impact verdict belongs to an
 *   acceptance **set**, says so on every result, and `sweepAcceptanceSets()`
 *   reports a safe set with an unsafe subset at blocking. On this corpus the
 *   full acceptance and eleven of its subsets are unsafe, one is safe, and no
 *   single verdict describes them.
 * - **It does not persist anything, and does not pretend to.** The registry is
 *   in memory, says `durability: 'in-memory'` on the record, publishes
 *   `EXTERNAL_MAPPING_NOT_PERSISTED` at `info` on every build, and exposes
 *   `serialiseExternalMappingRegistry()` / `readExternalMappingRegistry()` as
 *   the seam a store would use. There is no SQL migration and no storage
 *   adapter. The reason used to be GAP-30: `SlotSchema` and `AssignmentSchema`
 *   normalised through `z.coerce.date()`, so a registry round-tripped through
 *   them came back with its dates reinterpreted, and a module whose whole job is
 *   to *detect* a difference between two artifacts must not be built on a store
 *   that **creates** one. That is closed — those schemas now refuse a naive wall
 *   reading — and what is left is GAP-34's open stored half. (GAP-29 keeps the
 *   published baseline; the mapping registry was never among the artifacts it
 *   names, and this line cited it until the 2026-09-19 scope ruling.)
 *   `publication/index.js` states the same position for the same reason.
 *
 * ## What it deliberately is not
 *
 * - **Not a second parity checker.** `publication/parity.js` `checkParity()`
 *   compares two row sets in *our* vocabulary and partitions them four ways;
 *   this module classifies *foreign* rows four ways — the fourth being
 *   `undecidable`, which parity has no need for because both its sides are
 *   readable by construction. `publication/adapters/season2026Publication.js`
 *   subject B remains the parity view of the same eight rows and is untouched.
 * - **Not a solver, and not a writer.** `projectAcceptance()` returns a
 *   projection; nothing here mutates a schedule, and
 *   `gameScheduling.js` / `autoScheduler.js` / `gameMetrics.js` are untouched
 *   and import nothing from this package.
 * - **Not a facility model.** Every question about ground and clock goes to
 *   `facility/occupancy.js`. `bookingsOverlapInTime()`'s `null` is carried as
 *   `undetermined` and never as "no clash".
 *
 * @module externalImport
 */

export {
  EXTERNAL_AVOID_ORIGIN,
  EXTERNAL_IMPACT_VERDICT,
  EXTERNAL_IMPORT_REASON,
  EXTERNAL_IMPORT_REASON_SEVERITY,
  EXTERNAL_IMPORT_SEVERITY,
  EXTERNAL_IMPORT_STATUS,
  EXTERNAL_NAME_RESOLUTION,
  EXTERNAL_NAME_RESOLUTION_REASON,
  EXTERNAL_ROW_CLASS,
  EXTERNAL_ROW_CLASS_ORDER,
  assertExternalImportFindings,
  createExternalImportMeta,
  deriveExternalImpactVerdict,
  deriveExternalImportStatus,
  externalImportSeverityOf,
  makeExternalImportFinding,
  mergeExternalImportMeta,
  nameResolutionFinding,
} from './reasonCodes.js';

export {
  AvoidWindowDocumentSchema,
  AvoidWindowQuerySchema,
  ExternalFixtureRowSchema,
  ExternalImportQuerySchema,
  ExternalMappingRecordSchema,
  ExternalMappingRegistryInputSchema,
  ImpactQuerySchema,
  MappingDocumentSchema,
  StandingFixtureSchema,
} from './schemas.js';

export {
  EXTERNAL_LOOKUP_SIDE,
  EXTERNAL_MAPPING_DURABILITY,
  EXTERNAL_MAPPING_KIND,
  MAPPING_DOCUMENT_VERSION,
  buildExternalMappingRegistry,
  createMappingUsage,
  mappingUsageFindings,
  normaliseExternalLabel,
  readExternalMappingRegistry,
  recordMappingUse,
  resolveExternalName,
  reverseResolveSurface,
  serialiseExternalMappingRegistry,
} from './mapping.js';

export {
  EXTERNAL_COMPARED_FIELD,
  EXTERNAL_FIELD_PRESENCE,
  EXTERNAL_KEY_FIELD,
  EXTERNAL_ROW_CLASS_ACCEPTABILITY,
  acceptanceDomainOf,
  classifyExternalImport,
} from './resolution.js';

export {
  ACCEPTANCE_SWEEP_CAP,
  EXTERNAL_IMPACT_LAYERS_NOT_CONSULTED,
  acceptanceSetKey,
  analyseImportImpact,
  impactOfSet,
  projectAcceptance,
  sweepAcceptanceSets,
} from './impact.js';

export {
  AVOID_WINDOW_ADMISSION_FIELDS,
  AVOID_WINDOW_DOCUMENT_VERSION,
  EXTERNAL_AVOID_EXCLUSION,
  avoidWindowKey,
  avoidWindowsAdmit,
  buildAvoidWindows,
  checkAvoidWindowRoundTrip,
  readAvoidWindowDocument,
} from './avoidWindows.js';

export {
  SEASON_2026_EXTERNAL_MAPPING_RECORDS,
  SEASON_2026_EXTERNAL_PARTY,
  season2026ExternalImportQuery,
  season2026ExternalMappingInput,
  toSeason2026ExternalRows,
  toSeason2026StandingFixtures,
} from './adapters/season2026ExternalImport.js';
