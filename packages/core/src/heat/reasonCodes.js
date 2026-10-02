/**
 * Reason codes for heat-forecast refusals. `code` is the contract; messages are
 * decoration. Every refused row carries one of these, so nothing the screen
 * cannot compute is ever dropped or silently filled.
 *
 * @module heat/reasonCodes
 */

export const HEAT_REASON = Object.freeze({
  /** The venue has no latitude/longitude entered. */
  COORDINATES_MISSING: 'HEAT_COORDINATES_MISSING',
  /** The venue lies outside the shipped Linke turbidity table. */
  TURBIDITY_OUT_OF_COVERAGE: 'HEAT_TURBIDITY_OUT_OF_COVERAGE',
  /** A game names a field (or a field a venue) that is not in the active estate. */
  FIELD_UNKNOWN: 'HEAT_FIELD_UNKNOWN',
  /** The field's surface is empty, or the venue has no active fields. */
  SURFACE_MISSING: 'HEAT_SURFACE_MISSING',
  /** The field is indoor: an outdoor WBGT model does not apply. */
  SURFACE_INDOOR: 'HEAT_SURFACE_INDOOR',
  /** The field's surface is neither grass nor turf. */
  SURFACE_UNKNOWN: 'HEAT_SURFACE_UNKNOWN',
  /** The season has no timezone, or the runtime rejects it. */
  TIMEZONE_UNAVAILABLE: 'HEAT_TIMEZONE_UNAVAILABLE',
  /** The NWS request for this venue failed. */
  FORECAST_UNAVAILABLE: 'HEAT_FORECAST_UNAVAILABLE',
  /** The gridpoint forecast does not cover an hour the row needs. */
  FORECAST_GAP: 'HEAT_FORECAST_GAP',
  /** The NWS dewpoint is above the air temperature (beyond 0.5 F). */
  DEWPOINT_ABOVE_AIR: 'HEAT_DEWPOINT_ABOVE_AIR',
  /** A Liljegren component iteration did not converge. */
  MODEL_DID_NOT_CONVERGE: 'HEAT_MODEL_DID_NOT_CONVERGE',
  /** The globe iteration went non-physical. */
  MODEL_NON_PHYSICAL: 'HEAT_MODEL_NON_PHYSICAL',
  /** A game's times could not be read, or it ends before it starts. */
  GAME_TIME_UNREADABLE: 'HEAT_GAME_TIME_UNREADABLE',
  /** A game runs past midnight; only the hours on the chosen day are judged. */
  GAME_EXTENDS_PAST_DAY: 'HEAT_GAME_EXTENDS_PAST_DAY',
  /** A game has no end time; only its kickoff hour is judged. */
  GAME_END_UNKNOWN: 'HEAT_GAME_END_UNKNOWN',
  /** The gridpoint response does not have the shape a live response has. */
  GRIDPOINT_INVALID: 'HEAT_GRIDPOINT_INVALID',
  /** A gridpoint layer or the elevation is in a unit this port does not know. */
  GRIDPOINT_UNIT_UNEXPECTED: 'HEAT_GRIDPOINT_UNIT_UNEXPECTED',
  /** A validTime duration is malformed or finer than one hour. */
  GRIDPOINT_DURATION_UNSUPPORTED: 'HEAT_GRIDPOINT_DURATION_UNSUPPORTED',
  /** A required gridpoint layer has no values at all. */
  GRIDPOINT_LAYER_EMPTY: 'HEAT_GRIDPOINT_LAYER_EMPTY',
});

/** A refusal carrying a {@link HEAT_REASON} code; `code` is the contract. */
export class HeatError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {Record<string, unknown>} [detail]
   */
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'HeatError';
    this.code = code;
    this.detail = detail;
  }
}
