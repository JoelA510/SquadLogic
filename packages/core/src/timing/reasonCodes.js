/**
 * Machine-readable reason codes for every timing decision, and the severity
 * table that turns a list of findings into a status.
 *
 * Same two rules as `facility/reasonCodes.js`, for the same reasons:
 *
 * 1. **`code` is the contract, `message` is decoration.** Never parse a message.
 * 2. **Severity lives here and nowhere else.** No call site decides "this one is
 *    blocking"; {@link TIMING_REASON_SEVERITY} is the seam a later constraint
 *    registry overrides.
 *
 * Severities and statuses are *imported* from the facility module rather than
 * redeclared. Two independent definitions of the word `blocking` is exactly the
 * drift `docs/ARCHITECTURE.md` §1.1 documents, and a timing finding and a
 * facility finding end up in the same list — `deriveTimingStatus()` reads only
 * `finding.severity`, so the two must mean the same thing.
 *
 * @module timing/reasonCodes
 */

import {
  FACILITY_REASON,
  FACILITY_SEVERITY,
  FACILITY_STATUS,
  deriveFacilityStatus,
} from '../facility/reasonCodes.js';

/**
 * How badly a finding counts against a fixture. Re-exported from the facility
 * module so the two vocabularies cannot drift apart.
 *
 * @readonly
 * @enum {string}
 */
export const TIMING_SEVERITY = FACILITY_SEVERITY;

/**
 * The three-state outcome of any timing check.
 *
 * @readonly
 * @enum {string}
 */
export const TIMING_STATUS = FACILITY_STATUS;

/**
 * Every reason a timing check can give.
 *
 * @readonly
 * @enum {string}
 */
export const TIMING_REASON = Object.freeze({
  /* -- the format table --------------------------------------------------- */
  /**
   * The format has no timing definition (GAP-14). `Scrimmage` is the corpus's
   * case: it appears in `combined_schedule.csv` and has no row in
   * `game_formats.csv`.
   *
   * `compromise`, matching `OCCUPANCY_FOOTPRINT_UNKNOWN`: an unknown footprint
   * must be visible and must not be reported as a clean pass, but it is not
   * itself illegal.
   */
  FORMAT_TIMING_UNDEFINED: 'FORMAT_TIMING_UNDEFINED',
  /** Two input rows claim the same format name. */
  FORMAT_TIMING_DUPLICATE: 'FORMAT_TIMING_DUPLICATE',

  /* -- reconciliation ----------------------------------------------------- */
  /**
   * `halves x halfMinutes + halftime` equals the declared occupancy. Recorded
   * as provenance so a test can prove the reconciliation actually ran.
   */
  OCCUPANCY_DERIVATION_AGREES: 'OCCUPANCY_DERIVATION_AGREES',
  /**
   * It does not. This is incident 7's tripwire: had `90` meant `2x45 +
   * halftime` rather than `2x40 + halftime`, this is the finding that would
   * have fired instead of several published margins quietly going tight.
   */
  OCCUPANCY_DERIVATION_DISAGREES: 'OCCUPANCY_DERIVATION_DISAGREES',
  /** No halves are declared, so ball-in-play cannot be derived (Minis). */
  PLAY_TIME_UNDERIVABLE: 'PLAY_TIME_UNDERIVABLE',
  /** Halftime is a range, so occupancy is a range. Margins use the worst case. */
  HALFTIME_IS_RANGE: 'HALFTIME_IS_RANGE',
  /** The format declares no halftime at all. */
  HALFTIME_UNDECLARED: 'HALFTIME_UNDECLARED',
  /** The declared block is shorter than the worst-case occupancy it must hold. */
  BLOCK_SHORTER_THAN_OCCUPANCY: 'BLOCK_SHORTER_THAN_OCCUPANCY',
  /**
   * The declared block accounts for occupancy and turnover but **not** warm-up.
   * True of every season-2026 format, and the structural reason warm-up
   * collisions were invisible: the number used as "the schedulable footprint"
   * never contained the warm-up.
   */
  BLOCK_EXCLUDES_WARMUP: 'BLOCK_EXCLUDES_WARMUP',
  /** The source says the preferred turnover is already counted in the block. */
  TURNOVER_INSIDE_BLOCK: 'TURNOVER_INSIDE_BLOCK',
  /** The format declares no turnover floor. */
  TURNOVER_FLOOR_UNDECLARED: 'TURNOVER_FLOOR_UNDECLARED',

  /* -- warm-up as a requirement ------------------------------------------- */
  /**
   * A warm-up window was asked for without a stated length. `game_formats.csv`
   * has no warm-up column, so there is nothing to fall back on and this module
   * refuses to invent one.
   */
  WARMUP_DURATION_UNSPECIFIED: 'WARMUP_DURATION_UNSPECIFIED',
  /** The warm-up would start before the start of the day. */
  WARMUP_STARTS_BEFORE_DAY_START: 'WARMUP_STARTS_BEFORE_DAY_START',
  /**
   * The on-pitch warm-up window is shorter than the one requested. Not a
   * collision — a squeeze — so `compromise` rather than `blocking`.
   */
  WARMUP_WINDOW_SHORT: 'WARMUP_WINDOW_SHORT',
  /** Nothing already booked bounds the warm-up window on this ground. */
  WARMUP_WINDOW_UNBOUNDED: 'WARMUP_WINDOW_UNBOUNDED',

  /* -- warm-up occupancy collisions --------------------------------------- */
  /**
   * The four codes below are the warm-up counterparts of the facility
   * occupancy codes. They exist so an explanation reads "the warm-up clashes"
   * rather than "the game clashes", which would be false and would send an
   * operator to move the wrong thing.
   */
  WARMUP_OCCUPIED_SAME_SURFACE: 'WARMUP_OCCUPIED_SAME_SURFACE',
  WARMUP_OCCUPIED_PARENT_CHILD: 'WARMUP_OCCUPIED_PARENT_CHILD',
  WARMUP_OCCUPIED_SPATIAL_OVERLAP: 'WARMUP_OCCUPIED_SPATIAL_OVERLAP',
  WARMUP_FOOTPRINT_UNKNOWN: 'WARMUP_FOOTPRINT_UNKNOWN',

  /* -- wall time -> instant (the season clock) ----------------------------- */
  /**
   * A wall time was handed over with no IANA zone to place it on, because the
   * season carries none (`season_settings.timezone` is nullable).
   *
   * `blocking`, and deliberately not `compromise`: the alternative to refusing
   * is reading the wall time in whatever zone the host happens to sit in, which
   * is how the same 4:44 PM slot persisted as three instants eight hours apart.
   * There is no partially-right answer to fall back to -- a `timestamptz` column
   * has no representation for "no clock" -- so nothing is composed and the
   * operator is told which slots have no clock to stand on.
   */
  SEASON_TIMEZONE_MISSING: 'SEASON_TIMEZONE_MISSING',
  /**
   * The wall time does not exist in the zone: it falls in the hour a
   * spring-forward skips (`America/New_York` 2026-03-08 02:30).
   *
   * `blocking`, and this is the asymmetry with the ambiguous case below. A
   * repeated hour has two real instants and a documented rule picks one; a
   * skipped hour has *none*, and the two readings a shift could produce
   * (01:30 EST, 03:30 EDT) are an hour apart with nothing in the data saying
   * which the operator meant. Shifting silently would be the same invented
   * instant in a smaller disguise, so this refuses.
   */
  WALL_TIME_NONEXISTENT: 'WALL_TIME_NONEXISTENT',
  /**
   * The wall time occurs twice in the zone: it falls in the hour a fall-back
   * repeats (`America/New_York` 2026-11-01 01:30).
   *
   * `info`, not `compromise`: an instant **is** composed, by the rule stated in
   * {@link import('./seasonClock.js').resolveZonedInstant} -- the first
   * occurrence, the offset in force before the transition. The finding is on
   * the record so an operator can see that a stated rule and not a coin toss
   * chose between 05:30Z and 06:30Z.
   */
  WALL_TIME_AMBIGUOUS: 'WALL_TIME_AMBIGUOUS',

  /* -- inverse ("what kickoff would work?") queries ------------------------ */
  /** No kickoff in the searched horizon yields the requested warm-up. */
  KICKOFF_SEARCH_EXHAUSTED: 'KICKOFF_SEARCH_EXHAUSTED',
  /**
   * The answer was set by a booking on *different* ground. Incident 8 in one
   * code: the earliest legal kickoff was bounded by a 9v9 on the overlapping
   * field, not by anything on the pitch being asked about.
   */
  KICKOFF_BOUND_BY_OTHER_SURFACE: 'KICKOFF_BOUND_BY_OTHER_SURFACE',
  /** The answer was set by a booking on the same surface. */
  KICKOFF_BOUND_BY_SAME_SURFACE: 'KICKOFF_BOUND_BY_SAME_SURFACE',
  /** Nothing bounded it; the earliest allowed start was already free. */
  KICKOFF_UNBOUNDED: 'KICKOFF_UNBOUNDED',
});

/**
 * Severity of every reason code.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const TIMING_REASON_SEVERITY = Object.freeze({
  [TIMING_REASON.FORMAT_TIMING_UNDEFINED]: TIMING_SEVERITY.COMPROMISE,
  [TIMING_REASON.FORMAT_TIMING_DUPLICATE]: TIMING_SEVERITY.BLOCKING,

  [TIMING_REASON.OCCUPANCY_DERIVATION_AGREES]: TIMING_SEVERITY.INFO,
  [TIMING_REASON.OCCUPANCY_DERIVATION_DISAGREES]: TIMING_SEVERITY.BLOCKING,
  [TIMING_REASON.PLAY_TIME_UNDERIVABLE]: TIMING_SEVERITY.INFO,
  [TIMING_REASON.HALFTIME_IS_RANGE]: TIMING_SEVERITY.INFO,
  [TIMING_REASON.HALFTIME_UNDECLARED]: TIMING_SEVERITY.INFO,
  [TIMING_REASON.BLOCK_SHORTER_THAN_OCCUPANCY]: TIMING_SEVERITY.BLOCKING,
  [TIMING_REASON.BLOCK_EXCLUDES_WARMUP]: TIMING_SEVERITY.INFO,
  [TIMING_REASON.TURNOVER_INSIDE_BLOCK]: TIMING_SEVERITY.INFO,
  [TIMING_REASON.TURNOVER_FLOOR_UNDECLARED]: TIMING_SEVERITY.INFO,

  [TIMING_REASON.WARMUP_DURATION_UNSPECIFIED]: TIMING_SEVERITY.COMPROMISE,
  [TIMING_REASON.WARMUP_STARTS_BEFORE_DAY_START]: TIMING_SEVERITY.BLOCKING,
  [TIMING_REASON.WARMUP_WINDOW_SHORT]: TIMING_SEVERITY.COMPROMISE,
  [TIMING_REASON.WARMUP_WINDOW_UNBOUNDED]: TIMING_SEVERITY.INFO,

  [TIMING_REASON.WARMUP_OCCUPIED_SAME_SURFACE]: TIMING_SEVERITY.BLOCKING,
  [TIMING_REASON.WARMUP_OCCUPIED_PARENT_CHILD]: TIMING_SEVERITY.BLOCKING,
  [TIMING_REASON.WARMUP_OCCUPIED_SPATIAL_OVERLAP]: TIMING_SEVERITY.BLOCKING,
  [TIMING_REASON.WARMUP_FOOTPRINT_UNKNOWN]: TIMING_SEVERITY.COMPROMISE,

  [TIMING_REASON.SEASON_TIMEZONE_MISSING]: TIMING_SEVERITY.BLOCKING,
  [TIMING_REASON.WALL_TIME_NONEXISTENT]: TIMING_SEVERITY.BLOCKING,
  [TIMING_REASON.WALL_TIME_AMBIGUOUS]: TIMING_SEVERITY.INFO,

  [TIMING_REASON.KICKOFF_SEARCH_EXHAUSTED]: TIMING_SEVERITY.BLOCKING,
  [TIMING_REASON.KICKOFF_BOUND_BY_OTHER_SURFACE]: TIMING_SEVERITY.INFO,
  [TIMING_REASON.KICKOFF_BOUND_BY_SAME_SURFACE]: TIMING_SEVERITY.INFO,
  [TIMING_REASON.KICKOFF_UNBOUNDED]: TIMING_SEVERITY.INFO,
});

/**
 * The warm-up counterpart of a facility occupancy code.
 *
 * A warm-up booking is a real {@link import('../facility/types.js').FacilityBooking}
 * and goes through the facility module's own overlap machinery, so it comes
 * back wearing facility codes. This table is what turns "the booking clashes"
 * into "the *warm-up* clashes" without reimplementing a single line of the
 * overlap test.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const WARMUP_CODE_BY_FACILITY_CODE = Object.freeze({
  [FACILITY_REASON.OCCUPIED_SAME_SURFACE]: TIMING_REASON.WARMUP_OCCUPIED_SAME_SURFACE,
  [FACILITY_REASON.OCCUPIED_PARENT_CHILD]: TIMING_REASON.WARMUP_OCCUPIED_PARENT_CHILD,
  [FACILITY_REASON.OCCUPIED_SPATIAL_OVERLAP]: TIMING_REASON.WARMUP_OCCUPIED_SPATIAL_OVERLAP,
  [FACILITY_REASON.OCCUPANCY_FOOTPRINT_UNKNOWN]: TIMING_REASON.WARMUP_FOOTPRINT_UNKNOWN,
});

/**
 * Severity of a timing reason code.
 *
 * Throws on an unknown code rather than defaulting to `info`, for the same
 * reason `facility/reasonCodes.js` does: a code with no severity is a code
 * somebody forgot to register, and defaulting would make it silently
 * non-blocking.
 *
 * @param {string} code
 * @returns {string} a {@link TIMING_SEVERITY} value
 */
export function timingSeverityOf(code) {
  const severity = TIMING_REASON_SEVERITY[code];
  if (!severity) {
    throw new Error(`timing: reason code "${code}" has no registered severity`);
  }
  return severity;
}

/**
 * Build a timing finding. `severity` is looked up, never passed in.
 *
 * @param {string} code - a {@link TIMING_REASON} value
 * @param {string} message - for humans only
 * @param {Record<string, unknown>} [details] - flat primitives and ids only
 * @returns {import('./types.js').TimingFinding}
 */
export function makeTimingFinding(code, message, details = {}) {
  return { code, severity: timingSeverityOf(code), message, details };
}

/**
 * Derive the status of a check mechanically from its findings.
 *
 * Delegates to the facility implementation, which reads nothing but
 * `finding.severity`. That is what lets a single list hold both timing and
 * facility findings — a warm-up collision arrives as a timing code while the
 * surface it stands on may have arrived as a facility one, and both must count.
 *
 * @param {ReadonlyArray<import('./types.js').TimingFinding>} findings
 * @returns {string} a {@link TIMING_STATUS} value
 */
export function deriveTimingStatus(findings) {
  return deriveFacilityStatus(
    /** @type {ReadonlyArray<import('../facility/types.js').FacilityFinding>} */ (findings)
  );
}
