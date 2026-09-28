/**
 * Machine-readable reason codes for every availability decision, the four
 * constraint kinds a kickoff is judged against, and the severity table that
 * turns a list of findings into a status.
 *
 * Same two rules as `facility/reasonCodes.js` and `timing/reasonCodes.js`, for
 * the same reasons:
 *
 * 1. **`code` is the contract, `message` is decoration.** Never parse a message.
 * 2. **Severity lives here and nowhere else.** No call site decides "this one is
 *    blocking"; {@link AVAILABILITY_REASON_SEVERITY} is the seam a later
 *    constraint registry overrides.
 *
 * Severities and statuses are *imported* from the facility module rather than
 * redeclared, exactly as `timing/reasonCodes.js` imports them. An availability
 * finding, a timing finding and a facility finding all end up in one list —
 * `deriveAvailabilityStatus()` reads only `finding.severity`, so the three must
 * mean the same thing.
 *
 * @module availability/reasonCodes
 */

import {
  FACILITY_SEVERITY,
  FACILITY_STATUS,
  deriveFacilityStatus,
} from '../facility/reasonCodes.js';

/**
 * How badly a finding counts against a booking. Re-exported from the facility
 * module so the vocabularies cannot drift apart.
 *
 * @readonly
 * @enum {string}
 */
export const AVAILABILITY_SEVERITY = FACILITY_SEVERITY;

/**
 * The three-state outcome of any availability check.
 *
 * @readonly
 * @enum {string}
 */
export const AVAILABILITY_STATUS = FACILITY_STATUS;

/**
 * The four things that can stop a game kicking off later than it does.
 *
 * These are the "which of the four is binding" vocabulary. They are a closed
 * set on purpose: a fifth reason a kickoff is bounded must be added here, get a
 * limit and a slack like the others, and therefore show up in the ordered
 * explanation — rather than being special-cased at a call site where Phase 4's
 * explain-why work would never find it.
 *
 * @readonly
 * @enum {string}
 */
export const AVAILABILITY_CONSTRAINT = Object.freeze({
  /** Something else is already standing on conflicting ground. */
  OCCUPANCY: 'occupancy',
  /** The field's floodlights (or the absence of a stated lights-off time). */
  LIGHTING: 'lighting',
  /** Sunset less the safety margin, on unlit ground. */
  SUNSET: 'sunset',
  /** The permit's close time for that venue on that date. */
  PERMIT: 'permit',
});

/**
 * Declared order of the four kinds.
 *
 * Constraints are reported **ordered by tightness**, not by this list. This is
 * only the deterministic tie-break for constraints that bind equally hard, so
 * that two runs over the same data produce the same ordering.
 *
 * @type {ReadonlyArray<string>}
 */
export const AVAILABILITY_CONSTRAINT_ORDER = Object.freeze([
  AVAILABILITY_CONSTRAINT.OCCUPANCY,
  AVAILABILITY_CONSTRAINT.LIGHTING,
  AVAILABILITY_CONSTRAINT.SUNSET,
  AVAILABILITY_CONSTRAINT.PERMIT,
]);

/**
 * Every reason an availability check can give.
 *
 * @readonly
 * @enum {string}
 */
export const AVAILABILITY_REASON = Object.freeze({
  /* -- the permit --------------------------------------------------------- */
  /**
   * The calendar has nothing to say about this venue on this date — no
   * date-scoped exception and no weekday default.
   *
   * `compromise`, not `info`: "we hold no permit record" is not the same
   * statement as "the site is open", and reporting a clean pass for ground
   * nobody has proved is bookable is the shape of failure incident 4 describes.
   */
  PERMIT_UNDECLARED: 'PERMIT_UNDECLARED',
  /**
   * A permit record exists for the date and says the site is **not available at
   * all** — the em dash in both time columns of the corpus's Summit HS 09/19
   * row. Distinct from `PERMIT_UNDECLARED`: this is a stated blackout, not an
   * absence of data.
   */
  PERMIT_BLACKOUT: 'PERMIT_BLACKOUT',
  /** The kickoff falls before the permit opens. */
  PERMIT_OPEN_PRECEDED: 'PERMIT_OPEN_PRECEDED',
  /** Worst-case occupancy runs past the permit close. */
  PERMIT_CLOSE_EXCEEDED: 'PERMIT_CLOSE_EXCEEDED',
  /**
   * The game is legal but finishes inside the configured permit margin. The
   * canonical `compromise` of this module, matching `LINING_MISMATCH` in
   * Phase 1.1: playable, and the schedule should say so out loud rather than
   * either hiding it or refusing it.
   */
  PERMIT_MARGIN_TIGHT: 'PERMIT_MARGIN_TIGHT',
  /** The governing record is a date-scoped exception. Provenance. */
  PERMIT_DATE_EXCEPTION: 'PERMIT_DATE_EXCEPTION',
  /** The governing record is the venue's weekday default. Provenance. */
  PERMIT_WEEKDAY_DEFAULT: 'PERMIT_WEEKDAY_DEFAULT',
  /**
   * Two records survive at the same specificity and disagree. The more
   * restrictive one is applied *and* this is emitted; the resolver never picks
   * a winner silently (same contract as `EQUIPMENT_PRECEDENCE_AMBIGUOUS`).
   */
  PERMIT_PRECEDENCE_AMBIGUOUS: 'PERMIT_PRECEDENCE_AMBIGUOUS',

  /* -- lighting ----------------------------------------------------------- */
  /** Lighting was read from a record on the surface itself. */
  LIGHTING_FROM_SURFACE: 'LIGHTING_FROM_SURFACE',
  /** Lighting was inherited from an ancestor surface's record. */
  LIGHTING_FROM_ANCESTOR: 'LIGHTING_FROM_ANCESTOR',
  /**
   * No per-field lighting record exists, so the venue's flag was used. True of
   * every field in the season-2026 corpus: `facility_geometry.json` carries
   * `lit` at venue level only (GAP-05).
   */
  LIGHTING_FROM_VENUE: 'LIGHTING_FROM_VENUE',
  /** A permit row's `Lit` column contradicts the resolved lighting. */
  LIGHTING_SOURCE_DISAGREES: 'LIGHTING_SOURCE_DISAGREES',
  /**
   * No record and no venue flag: nothing states whether the ground is lit.
   * The practice-only venues of the season-2026 corpus arrive this way
   * (`field_inventory.csv` has no lighting column, GAP-05). `compromise` for
   * the same reason `PERMIT_UNDECLARED` is: "nobody has said" is not "unlit",
   * and reading it as unlit would be an absence wearing a fact's clothes. The
   * sunset rule still carries the ground, as it does for unlit ground, so the
   * conservative bound applies while the gap is reported.
   */
  LIGHTING_UNDECLARED: 'LIGHTING_UNDECLARED',
  /**
   * Two lighting records claim the same surface and disagree. The more
   * restrictive one is applied *and* this is emitted — the same contract the
   * permit and sunset paths keep, so lighting is not the one place a duplicate
   * wins silently by arriving last.
   */
  LIGHTING_PRECEDENCE_AMBIGUOUS: 'LIGHTING_PRECEDENCE_AMBIGUOUS',
  /** The ground is lit but nobody has stated when the lights go off. */
  LIGHTS_OFF_UNDECLARED: 'LIGHTS_OFF_UNDECLARED',
  /** Worst-case occupancy runs past the stated lights-off time. */
  LIGHTS_OFF_EXCEEDED: 'LIGHTS_OFF_EXCEEDED',

  /* -- daylight ----------------------------------------------------------- */
  /**
   * The ground is unlit and no sunset is recorded for the date, so the daylight
   * rule cannot be applied. `compromise` for the same reason
   * `OCCUPANCY_FOOTPRINT_UNKNOWN` is: an unjudgeable rule must be visible.
   *
   * The daylight provider (`sunsetForVenue()`, 8.9 PR 4) reuses this code for
   * a venue with no table record for the date and no coordinates to compute
   * one from, with `details.cause = 'venue-coordinates-missing'`; a computation
   * the solar module refused carries `cause = 'sunset-not-computable'` and the
   * timing code. Unknown is never read as "no limit": the practice daylight
   * evaluator counts it and never allows the occurrence.
   */
  SUNSET_UNKNOWN: 'SUNSET_UNKNOWN',
  /**
   * The date-keyed table and the sunset computed from the venue's coordinates
   * differ by more than {@link SUNSET_SOURCES_TOLERANCE_MINUTES} minutes. The
   * table is applied (decision D10 of the 8.9 plan: it is what the season was
   * built against); the disagreement says one of the two is wrong -- the
   * coordinates, or the table, as it was for two rows of `sunsets.csv`.
   */
  SUNSET_SOURCES_DISAGREE: 'SUNSET_SOURCES_DISAGREE',
  /**
   * A practice occurrence on unlit or undeclared ground ends after sunset less
   * `PRACTICE_SUNSET_MARGIN_MINUTES` (0: operator ruling 2026-09-27, "teams
   * don't practice after sunset at unlit fields"). Emitted by
   * `practice/daylight.js`, never by the game path, which keeps its own margin
   * and {@link SUNSET_MARGIN_VIOLATED}.
   */
  PRACTICE_PAST_SUNSET: 'PRACTICE_PAST_SUNSET',
  /** Worst-case occupancy runs past sunset less the safety margin. */
  SUNSET_MARGIN_VIOLATED: 'SUNSET_MARGIN_VIOLATED',
  /** The ground is lit, so sunset does not bound it. Provenance. */
  SUNSET_NOT_BINDING_WHEN_LIT: 'SUNSET_NOT_BINDING_WHEN_LIT',
  /** Two sunset records claim the same date; the earlier one is applied. */
  SUNSET_PRECEDENCE_AMBIGUOUS: 'SUNSET_PRECEDENCE_AMBIGUOUS',

  /* -- occupancy ---------------------------------------------------------- */
  /** The answer was pushed earlier by something already on conflicting ground. */
  OCCUPANCY_BOUND_BY_BOOKING: 'OCCUPANCY_BOUND_BY_BOOKING',
  /** Nothing already booked bounds this kickoff. Provenance. */
  OCCUPANCY_UNBOUNDED: 'OCCUPANCY_UNBOUNDED',

  /* -- closures (the constraint log, Phase 8.3) --------------------------- */
  /** The booking stands inside a venue- or surface-scoped closure window. */
  CLOSURE_BLOCKS_BOOKING: 'CLOSURE_BLOCKS_BOOKING',
  /**
   * The booking falls in a closure whose `fields` cell cannot be read (the
   * corpus's Excel-corrupted `2026-01-07` for `1-7`). It may close this
   * ground; nobody can tell from the sheet. `compromise`, never nothing.
   */
  CLOSURE_SCOPE_UNREADABLE: 'CLOSURE_SCOPE_UNREADABLE',
  /**
   * The booking has no known end, kicks off before a timed closure opens, and
   * so may or may not run into it. (One that kicks off inside the window is
   * decided by its start; one that kicks off after it closes is decided
   * clean.) Not knowing must never outrank what knowing would carry, and the
   * scope kinds whose decided answer is *information* get
   * {@link AVAILABILITY_REASON.CLOSURE_NOTE_UNDECIDABLE} instead of this code
   * -- so the severity is the table's answer for the code, and no call site
   * decides one.
   */
  CLOSURE_OVERLAP_UNDECIDABLE: 'CLOSURE_OVERLAP_UNDECIDABLE',
  /**
   * The same not-knowing, about a row whose *decided* answer is itself
   * information: the parking note, the adjacency deferral. Split from
   * `CLOSURE_OVERLAP_UNDECIDABLE` rather than capped at the call site, because
   * `AVAILABILITY_REASON_SEVERITY` is where a reader must be able to get the
   * severity -- without knowing which scope kind produced it.
   */
  CLOSURE_NOTE_UNDECIDABLE: 'CLOSURE_NOTE_UNDECIDABLE',
  /** The booking falls in a row that closes something other than a playing surface (`Parking`). */
  CLOSURE_NOT_GROUND: 'CLOSURE_NOT_GROUND',
  /** The booking is under an adjacency rule the graph's overlap pairs already enforce. Provenance. */
  CLOSURE_ADJACENCY_DEFERRED: 'CLOSURE_ADJACENCY_DEFERRED',
  /**
   * A closure row names a venue the graph does not hold, so it reaches no
   * ground at all. Emitted twice over: once on the set at build time, and
   * again against every booking whose date *and hours* fall inside the window,
   * because a caller holding only the query answer would read silence as a
   * clear date. Its `timeMeets` detail says whether the clock decided the
   * overlap or was itself undecidable.
   */
  CLOSURE_VENUE_UNKNOWN: 'CLOSURE_VENUE_UNKNOWN',
  /**
   * A closure row names a venue the graph holds and a surface it does not.
   * Reported on the set at build time, and **applied to the venue** at query
   * time as a compromise — the contract its sibling `unreadable` already had:
   * a closure that reached nothing because one cell would not resolve is a
   * closure that vanishes.
   */
  CLOSURE_SURFACE_UNKNOWN: 'CLOSURE_SURFACE_UNKNOWN',
  /**
   * **Nothing enforces this closure set.** `checkClosures()` and
   * `findClosureBreaches()` are standalone: `checkKickoffAvailability()` does
   * not call them, and neither enforcement path claims a `CLOSURE_*` code —
   * no standing rule in `ruleEngine/rules.js` and no registry constraint — so
   * a kickoff inside a closed window comes back with no closure code at all.
   *
   * **Consumed is not enforced.** Phase 8.4's
   * `fieldAdmin/projectors/constraints.js` calls `buildClosureSet()` to turn
   * the constraint log into blackout windows, so the set now has a production
   * consumer outside this module. That does not touch any clause above: it is
   * a caller asking directly, which is exactly what "standalone" means here,
   * and it adds no `CLOSURE_*` claim to either enforcement path.
   * `tests/unwiredLayerImporters.test.js` pins the list of consumers so this
   * paragraph cannot quietly go stale.
   *
   * Every set says so on itself, the way `FAIRNESS_OBJECTIVE_UNWIRED` does for
   * the unwired scoring functions, and `tests/helpers/unwiredLayer.js` checks
   * the claim against both paths rather than trusting it, for this layer and
   * its sibling `ALIAS_LAYER_UNWIRED` alike: the day something claims one of
   * these codes, the declaration has to go with it.
   */
  CLOSURE_SET_UNWIRED: 'CLOSURE_SET_UNWIRED',

  /* -- the derived query -------------------------------------------------- */
  /** Which constraints bind the answer, tightest first. Provenance. */
  LATEST_KICKOFF_BOUND: 'LATEST_KICKOFF_BOUND',
  /** No kickoff in the searched range is legal at all. */
  NO_LEGAL_KICKOFF: 'NO_LEGAL_KICKOFF',
});

/**
 * How far apart the table sunset and the computed one may be before the
 * provider reports `SUNSET_SOURCES_DISAGREE` (decision D10: "above 2 min").
 * Two minutes clears the table's own rounding (0.5) and the NOAA model's fit
 * to the corpus (about 1.05, `tests/solar.test.js`), and still catches the
 * 5-6 minute errors the 2026-09-24 correction removed.
 */
export const SUNSET_SOURCES_TOLERANCE_MINUTES = 2;

/**
 * Severity of every reason code.
 *
 * The permit close is `blocking` in Phase 1. That is a *policy* recorded in a
 * table, not a fact baked into the check — Prompt 2.1's constraint registry
 * overrides this map rather than editing `kickoff.js`.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const AVAILABILITY_REASON_SEVERITY = Object.freeze({
  [AVAILABILITY_REASON.PERMIT_UNDECLARED]: AVAILABILITY_SEVERITY.COMPROMISE,
  [AVAILABILITY_REASON.PERMIT_BLACKOUT]: AVAILABILITY_SEVERITY.BLOCKING,
  [AVAILABILITY_REASON.PERMIT_OPEN_PRECEDED]: AVAILABILITY_SEVERITY.BLOCKING,
  [AVAILABILITY_REASON.PERMIT_CLOSE_EXCEEDED]: AVAILABILITY_SEVERITY.BLOCKING,
  [AVAILABILITY_REASON.PERMIT_MARGIN_TIGHT]: AVAILABILITY_SEVERITY.COMPROMISE,
  [AVAILABILITY_REASON.PERMIT_DATE_EXCEPTION]: AVAILABILITY_SEVERITY.INFO,
  [AVAILABILITY_REASON.PERMIT_WEEKDAY_DEFAULT]: AVAILABILITY_SEVERITY.INFO,
  [AVAILABILITY_REASON.PERMIT_PRECEDENCE_AMBIGUOUS]: AVAILABILITY_SEVERITY.INFO,

  [AVAILABILITY_REASON.LIGHTING_FROM_SURFACE]: AVAILABILITY_SEVERITY.INFO,
  [AVAILABILITY_REASON.LIGHTING_FROM_ANCESTOR]: AVAILABILITY_SEVERITY.INFO,
  [AVAILABILITY_REASON.LIGHTING_FROM_VENUE]: AVAILABILITY_SEVERITY.INFO,
  [AVAILABILITY_REASON.LIGHTING_SOURCE_DISAGREES]: AVAILABILITY_SEVERITY.INFO,
  [AVAILABILITY_REASON.LIGHTING_UNDECLARED]: AVAILABILITY_SEVERITY.COMPROMISE,
  [AVAILABILITY_REASON.LIGHTING_PRECEDENCE_AMBIGUOUS]: AVAILABILITY_SEVERITY.INFO,
  [AVAILABILITY_REASON.LIGHTS_OFF_UNDECLARED]: AVAILABILITY_SEVERITY.INFO,
  [AVAILABILITY_REASON.LIGHTS_OFF_EXCEEDED]: AVAILABILITY_SEVERITY.BLOCKING,

  [AVAILABILITY_REASON.SUNSET_UNKNOWN]: AVAILABILITY_SEVERITY.COMPROMISE,
  [AVAILABILITY_REASON.SUNSET_MARGIN_VIOLATED]: AVAILABILITY_SEVERITY.BLOCKING,
  [AVAILABILITY_REASON.SUNSET_NOT_BINDING_WHEN_LIT]: AVAILABILITY_SEVERITY.INFO,
  [AVAILABILITY_REASON.SUNSET_PRECEDENCE_AMBIGUOUS]: AVAILABILITY_SEVERITY.INFO,
  [AVAILABILITY_REASON.SUNSET_SOURCES_DISAGREE]: AVAILABILITY_SEVERITY.COMPROMISE,
  [AVAILABILITY_REASON.PRACTICE_PAST_SUNSET]: AVAILABILITY_SEVERITY.BLOCKING,

  [AVAILABILITY_REASON.OCCUPANCY_BOUND_BY_BOOKING]: AVAILABILITY_SEVERITY.INFO,
  [AVAILABILITY_REASON.OCCUPANCY_UNBOUNDED]: AVAILABILITY_SEVERITY.INFO,

  [AVAILABILITY_REASON.CLOSURE_BLOCKS_BOOKING]: AVAILABILITY_SEVERITY.BLOCKING,
  [AVAILABILITY_REASON.CLOSURE_SCOPE_UNREADABLE]: AVAILABILITY_SEVERITY.COMPROMISE,
  [AVAILABILITY_REASON.CLOSURE_OVERLAP_UNDECIDABLE]: AVAILABILITY_SEVERITY.COMPROMISE,
  [AVAILABILITY_REASON.CLOSURE_NOTE_UNDECIDABLE]: AVAILABILITY_SEVERITY.INFO,
  [AVAILABILITY_REASON.CLOSURE_NOT_GROUND]: AVAILABILITY_SEVERITY.INFO,
  [AVAILABILITY_REASON.CLOSURE_ADJACENCY_DEFERRED]: AVAILABILITY_SEVERITY.INFO,
  [AVAILABILITY_REASON.CLOSURE_VENUE_UNKNOWN]: AVAILABILITY_SEVERITY.COMPROMISE,
  [AVAILABILITY_REASON.CLOSURE_SURFACE_UNKNOWN]: AVAILABILITY_SEVERITY.COMPROMISE,
  [AVAILABILITY_REASON.CLOSURE_SET_UNWIRED]: AVAILABILITY_SEVERITY.INFO,

  [AVAILABILITY_REASON.LATEST_KICKOFF_BOUND]: AVAILABILITY_SEVERITY.INFO,
  [AVAILABILITY_REASON.NO_LEGAL_KICKOFF]: AVAILABILITY_SEVERITY.BLOCKING,
});

/**
 * Severity of an availability reason code.
 *
 * Throws on an unknown code rather than defaulting to `info`, for the same
 * reason the other two modules do: a code with no severity is a code somebody
 * forgot to register, and defaulting would make it silently non-blocking.
 *
 * @param {string} code
 * @returns {string} an {@link AVAILABILITY_SEVERITY} value
 */
export function availabilitySeverityOf(code) {
  const severity = AVAILABILITY_REASON_SEVERITY[code];
  if (!severity) {
    throw new Error(`availability: reason code "${code}" has no registered severity`);
  }
  return severity;
}

/**
 * Build an availability finding. `severity` is looked up, never passed in.
 *
 * @param {string} code - an {@link AVAILABILITY_REASON} value
 * @param {string} message - for humans only
 * @param {Record<string, unknown>} [details] - flat primitives and ids only
 * @returns {import('./types.js').AvailabilityFinding}
 */
export function makeAvailabilityFinding(code, message, details = {}) {
  return { code, severity: availabilitySeverityOf(code), message, details };
}

/**
 * Derive the status of a check mechanically from its findings.
 *
 * Delegates to the facility implementation, which reads nothing but
 * `finding.severity`. That is what lets one list hold availability, timing and
 * facility findings at once — a permit breach arrives as an availability code
 * while the ground it stands on may have arrived as a facility one, and both
 * must count.
 *
 * @param {ReadonlyArray<import('./types.js').AvailabilityFinding>} findings
 * @returns {string} an {@link AVAILABILITY_STATUS} value
 */
export function deriveAvailabilityStatus(findings) {
  return deriveFacilityStatus(
    /** @type {ReadonlyArray<import('../facility/types.js').FacilityFinding>} */ (findings)
  );
}
