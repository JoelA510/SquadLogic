/**
 * Barrel for the facility availability model.
 *
 * Every public export of `availability/` goes through this file, exactly as
 * `packages/core/src/facility/index.js` and `packages/core/src/timing/index.js`
 * do for their modules.
 *
 * The package is pure domain logic: no React, no `node:*`, no `Date`
 * construction, and **no import from `fixtures/`**. The arrow points
 * fixtures -> availability, never back; the season-2026 adapter takes the
 * already-parsed permit and sunset rows as arguments, so this module never
 * learns where the corpus lives or how it is read. It *does* import `facility/`
 * and `timing/`, and that is the point: concurrency is decided by the Phase 1.1
 * overlap machinery and occupancy length comes from the Phase 1.2 format table,
 * rather than by second implementations of either.
 *
 * Phase 1 is **in-memory only**. There is no SQL home for permits, sunsets or
 * lighting yet and this work deliberately does not create one: the schema
 * belongs to the phase that has real persistence requirements, not to the phase
 * that is still settling the model.
 *
 * @module availability
 */

export {
  AVAILABILITY_CONSTRAINT,
  AVAILABILITY_CONSTRAINT_ORDER,
  AVAILABILITY_REASON,
  AVAILABILITY_REASON_SEVERITY,
  AVAILABILITY_SEVERITY,
  AVAILABILITY_STATUS,
  SUNSET_SOURCES_TOLERANCE_MINUTES,
  availabilitySeverityOf,
  deriveAvailabilityStatus,
  makeAvailabilityFinding,
} from './reasonCodes.js';

export {
  ISO_DATE_PATTERN,
  IdSchema,
  IsoDateSchema,
  AvailabilityCalendarInputSchema,
  KickoffAvailabilityQuerySchema,
  LatestKickoffQuerySchema,
  PermitWindowSchema,
  SunsetRecordSchema,
  SurfaceLightingSchema,
  VenueDaylightSchema,
} from './schemas.js';

export {
  buildAvailabilityCalendar,
  daylightLimitMinutes,
  resolveLighting,
  resolvePermitWindow,
  sunsetForVenue,
  sunsetOn,
  venueIdOfSurface,
  weekdayCodeOf,
} from './calendar.js';

export { checkKickoffAvailability, latestLegalKickoff } from './kickoff.js';

export {
  ALL_DAY_CLOSE_MINUTES,
  CLOSURE_DECIDED_CODE_BY_SCOPE,
  CLOSURE_SCOPE,
  CLOSURE_UNDECIDABLE_CODE_BY_SCOPE,
  ClosureScopeSchema,
  ClosureSetInputSchema,
  ClosureWindowSchema,
  buildClosureSet,
  checkClosures,
  findClosureBreaches,
  isAllDayWindow,
  reconcileAdjacencyRule,
} from './closures.js';

export {
  SEASON_2026_PERMIT_MARGIN_MINUTES,
  SEASON_2026_SUNSET_MARGIN_MINUTES,
  buildAvailabilityCalendarFromSeason2026,
  toAvailabilityCalendarInput,
} from './adapters/season2026Permits.js';

export {
  SEASON_2026_CONSTRAINT_FIELDS_READINGS,
  buildSeason2026ClosureSet,
  readSeason2026ConstraintFields,
  readSeason2026ConstraintFieldsOrNull,
  toSeason2026ClosureInput,
} from './adapters/season2026Closures.js';
