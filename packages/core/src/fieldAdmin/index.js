/**
 * Barrel for field and blackout administration.
 *
 * Every public export of `fieldAdmin/` goes through this file, exactly as
 * `facility/index.js` does for the facility graph.
 *
 * The package is pure domain logic: no React, no `node:*`, no `Date`
 * construction, and **no import from `fixtures/`**. The arrow points
 * fixtures -> fieldAdmin, never back. Projectors take already-parsed records as
 * arguments, so this module never learns where the corpus lives or how it is
 * read - and the same projectors therefore work on an operator's uploaded sheet
 * without a second code path.
 *
 * **This PR is import, export and the change set. It persists nothing and it
 * applies nothing.** The CRUD half - effective-dated surfaces, the blackout
 * tables, the RPCs and the app - is the work that lands on top of this seam.
 *
 * @module fieldAdmin
 */

export {
  DISPOSITION,
  FIELD_ADMIN_REASON,
  FIELD_ADMIN_REASON_SEVERITY,
  FIELD_ADMIN_SEVERITY,
  FIELD_ADMIN_STATUS,
  INTERPRETATION,
  assertFieldAdminFindings,
  createFieldAdminMeta,
  deriveFieldAdminStatus,
  makeFieldAdminFinding,
  severityOf,
} from './reasonCodes.js';

export {
  AliasRecordSchema,
  BLACKOUT_REASON,
  BLACKOUT_SCOPE,
  BlackoutWindowSchema,
  IsoDateSchema,
  MinutesSchema,
  NOTE_MAX_LENGTH,
  NoteSchema,
  PermitWindowSchema,
  RECORD_SOURCE,
  RecurringWindowSchema,
  SUBJECT_KINDS,
  SUBJECT_SCHEMAS,
  VenueAttributesSchema,
  schemaForSubjectKind,
} from './schemas.js';

export {
  BUCKET_OF,
  assertEveryDispositionCovered,
  buildChangeSet,
  changeSetPartitionFindings,
  defaultDisagreementKind,
  everySubject,
  renderValue,
  splitByInterpretation,
  subjectIdentity,
} from './changeSet.js';

export {
  COLUMNS,
  FIELD_REGISTRY_DOCUMENT_VERSION,
  FieldRegistryDocumentSchema,
  buildFieldRegistry,
  columnsFor,
  fromCsv,
  quoteCell,
  readCell,
  readFieldRegistry,
  renderCell,
  serialiseFieldRegistry,
  splitCsvLine,
  splitCsvRecords,
  toCsv,
} from './serialise.js';

export { projectedRow, resolveGround } from './projectors/ground.js';

export {
  RING_SOURCE_FILE,
  labelAgreementOf,
  projectFieldsRing,
  projectPracticeRing,
  projectRing,
} from './projectors/rings.js';

export {
  CONSTRAINT_REASON_READINGS,
  projectFieldConstraints,
  readClosureScope,
  readConstraintReason,
} from './projectors/constraints.js';

export {
  WEEKLY_INTERPRETATIONS,
  WEEKLY_INTERPRETATIONS_ABSENT_FROM_CORPUS,
  WEEKLY_INTERPRETATION_VALUES,
  projectWeeklyAvailability,
} from './projectors/weeklyAvailability.js';

export {
  PERMIT_FACILITY_LABELS,
  PERMIT_FACILITY_READINGS,
  isDeclaredPermitFacility,
  permitFacilityKey,
  projectPermitReservations,
  readPermitFacility,
  readPermitServices,
} from './projectors/permits.js';

export {
  INVENTORY_SENTINELS,
  isInventorySentinel,
  projectVenueAttributes,
} from './projectors/inventory.js';

export {
  SEASON_2026_SUBJECTS,
  SEASON_2026_SUBJECT_NAMES,
  importSeason2026Fields,
} from './adapters/season2026FieldImport.js';

export {
  BLACKOUT_DB_REASON,
  CLOSURE_SOURCE,
  ClosureRowSchema,
  DatedBookingSchema,
  FieldRowSchema,
  ISO_DAY_NAMES,
  RecurringBookingSchema,
  clockToMinutes,
  findBlackoutConflicts,
  fromDayNumber,
  isoDayOfWeek,
  isoDayOfWeekName,
  minuteWindowsOverlap,
  minutesToClock,
  repairProposal,
  toDayNumber,
} from './consequences.js';
