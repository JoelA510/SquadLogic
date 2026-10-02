/**
 * Barrel for the field heat-stress (WBGT) forecast.
 *
 * Pure domain logic: no React, no `fetch`, no `node:*`. The NWS HTTP client
 * lives in `frontend/src/lib/nwsClient.js`; this package parses what it
 * returns. Ported from the Python reference in `scripts/heat/reference/` and
 * held to it by `tests/heatParity.test.js`. Design and the measured effect of
 * every substitution: `docs/architecture/heat-forecast.md`.
 *
 * Decision support only: on-site WBGT measurement always overrides it.
 *
 * @module heat
 */

export { HEAT_REASON, HeatError } from './reasonCodes.js';
export {
  BAND_NAMES,
  DEFAULT_HEAT_CATEGORY,
  HEAT_BANDS,
  HEAT_CATEGORIES,
  heatBand,
  roundHalfEven,
  triggerTargets,
} from './bands.js';
export { PVLIB_DEFAULT_DELTA_T, altitudeToPressurePa, solarPosition } from './solarPosition.js';
export {
  clearSkyGhi,
  cloudReducedGhi,
  extraRadiation,
  relativeAirmass,
  utcDayOfYear,
} from './clearSky.js';
export {
  TURBIDITY_TABLE,
  decodeTurbidityTable,
  lookupLinkeTurbidity,
  turbidityCovers,
} from './turbidity.js';
export {
  GRASS_ALBEDO,
  SURFACES,
  TURF_ALBEDO,
  TURF_AIR_OFFSET_F,
  TURF_DEW_OFFSET_F,
  airTrigger,
  fieldWbgt,
  stationPressureHpa,
} from './wbgt.js';
export {
  GridpointResponseSchema,
  LAYER_UNITS,
  expandLayer,
  parseDurationHours,
  parseGridpoint,
  parseIsoInstant,
} from './gridpoint.js';
export {
  GUIDANCE_URL_PATTERN,
  GuidanceLinkSchema,
  MAX_GUIDANCE_LABEL,
  MAX_GUIDANCE_LINKS,
  MAX_GUIDANCE_URL,
  OrgHeatSettingsSchema,
  normalizeSurface,
} from './schemas.js';
export {
  HEAT_MODEL,
  HEAT_SOURCES,
  buildHeatProvenance,
  sourcesForProvenance,
} from './provenance.js';
export {
  NO_GAME_HOURS,
  STALE_AFTER_HOURS,
  buildHeatPlan,
  computeHeatRows,
  forecastAge,
  heatRowDisplay,
  localDayHours,
} from './forecast.js';
