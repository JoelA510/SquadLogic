/**
 * Barrel for the facility graph.
 *
 * Every public export of `facility/` goes through this file, exactly as
 * `packages/core/src/fixtures/index.js` does for the fixture loaders.
 *
 * The package is pure domain logic: no React, no `node:*`, no `Date`
 * construction, and - importantly - **no import from `fixtures/`**. The arrow
 * points fixtures -> facility, never back. The season-2026 adapter takes the
 * already-parsed geometry object as an argument, so this module never learns
 * where the corpus lives or how it is read.
 *
 * Phase 1 is **in-memory only**. There is no SQL home for the graph yet and
 * this work deliberately does not create one: the schema belongs to the phase
 * that has real persistence requirements, not to the phase that is still
 * settling the model.
 *
 * @module facility
 */

export {
  FACILITY_REASON,
  FACILITY_REASON_SEVERITY,
  FACILITY_SEVERITY,
  FACILITY_STATUS,
  deriveFacilityStatus,
  makeFinding,
  severityOf,
} from './reasonCodes.js';

export {
  EquipmentScopeSchema,
  EquipmentWindowSchema,
  FacilityBookingSchema,
  FacilityGraphInputSchema,
  FacilitySurfaceInputSchema,
  FacilityVenueSchema,
  OverlapPairSchema,
} from './schemas.js';

export {
  buildFacilityGraph,
  cellsOf,
  descendantsOf,
  findSurfaceByName,
  getSurface,
  lineageOf,
  requireSurface,
} from './facilityGraph.js';

export {
  bookingsOverlapInTime,
  checkOccupancy,
  conflictingSurfacesOf,
  findFacilityConflicts,
  occupancyFootprint,
  surfacesConflict,
} from './occupancy.js';

export {
  DEFAULT_SIZE_RANK,
  checkBooking,
  checkEquipment,
  checkFieldEligibility,
  checkLining,
  checkSizeEligibility,
  isoDateOfDayNumber,
  isoDayNumber,
} from './eligibility.js';

export {
  EMPTY_VENUE_COMPLEX_MAP,
  VenueComplexMapInputSchema,
  VenueComplexSchema,
  buildVenueComplexMap,
  complexIdOf,
  getVenueComplex,
  sameVenueComplex,
} from './venueComplex.js';

export {
  ALIAS_GROUND_AGREEMENT,
  ALIAS_LABEL_AGREEMENT,
  AliasRingEntrySchema,
  AliasRingSchema,
  FieldAliasMapInputSchema,
  buildFieldAliasMap,
  lookupFieldAlias,
  surfacesOfAlias,
} from './aliases.js';

export {
  PRACTICE_SURFACE_RESOLUTION,
  practiceSurfaceName,
  resolvePracticeSurface,
  resolvePracticeVenue,
} from './practiceSurfaces.js';

export {
  SEASON_2026_FORMAT_EQUIPMENT,
  SEASON_2026_VENUE_COMPLEXES,
  buildFacilityGraphFromSeason2026,
  buildSeason2026VenueComplexMap,
  classifyEquipmentStatus,
  season2026SurfaceId,
  season2026VenueId,
  toSeason2026FacilityGraphInput,
} from './adapters/season2026Geometry.js';

export {
  SEASON_2026_ALIAS_RINGS,
  SEASON_2026_PRACTICE_LAYER,
  buildSeason2026PracticeFacilityGraph,
  extendFacilityGraphInputWithSeason2026PracticeLayer,
  season2026PracticeSurfaceId,
  toSeason2026AliasRings,
} from './adapters/season2026PracticeGeometry.js';

export { checkFacilityLifecycle, isDatedNode, isLiveOn, retiredOn } from './lifecycle.js';
