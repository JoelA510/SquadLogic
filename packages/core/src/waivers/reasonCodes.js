/**
 * Machine-readable reason codes for every waiver decision, the disposition
 * vocabulary that keeps "waived" distinguishable from "clean", and the frozen
 * severity table that turns a list of findings into a status.
 *
 * Same two rules as `facility/reasonCodes.js`, `timing/reasonCodes.js`,
 * `availability/reasonCodes.js` and `constraints/reasonCodes.js`:
 *
 * 1. **`code` is the contract, `message` is decoration.** Never parse a message.
 * 2. **Severity lives in a table, never at a call site.**
 *
 * Severities and statuses are *imported* from the facility module rather than
 * redeclared, exactly as the other three modules import them, so a waiver
 * finding lands in the same list as a facility one and
 * {@link deriveWaiverStatus} reads nothing but `finding.severity`.
 *
 * ## Why these codes are **not** merged into `BASE_REASON_SEVERITY`
 *
 * `constraints/baseSeverity.js` merges the tables of every module whose codes a
 * *constraint record may claim*. A waiver code describes the waiver machinery
 * itself — "this exception was applied", "this exception no longer does
 * anything" — and no constraint governs it. Registering these codes there would
 * let a record claim `WAIVER_APPLIED` and pretend to set its hardness, which is
 * meaningless. The seam stays one-directional: waivers read the constraint
 * registry, the registry knows nothing about waivers.
 *
 * @module waivers/reasonCodes
 */

import {
  FACILITY_SEVERITY,
  FACILITY_STATUS,
  deriveFacilityStatus,
} from '../facility/reasonCodes.js';

/**
 * How badly a finding counts. Re-exported from the facility module so the five
 * vocabularies cannot drift apart.
 *
 * @readonly
 * @enum {string}
 */
export const WAIVER_SEVERITY = FACILITY_SEVERITY;

/**
 * The three-state outcome of any waiver-aware check.
 *
 * @readonly
 * @enum {string}
 */
export const WAIVER_STATUS = FACILITY_STATUS;

/**
 * **"Waived, not clean" is this enum, not a boolean.**
 *
 * The Phase 1 status (`allowed` / `compromised` / `rejected`) answers *how bad
 * is this schedule*. It cannot answer *why is it only this bad*, and that is
 * precisely the difference incident 9 is about: a game that is `compromised`
 * because a 7v7 is playing on a 9v9-lined pitch and a game that is
 * `compromised` because the board signed a piece of paper are two different
 * facts, and collapsing them is how a waiver stops being visible.
 *
 * So a waiver-aware evaluation reports **two** values, and both are derived
 * mechanically:
 *
 * - `status` — the Phase 1 three-state, from the severities as always;
 * - `disposition` — this enum, from the 2x2 of *did any waiver fire* and *does
 *   any violation remain uncovered*.
 *
 * | | no violation left uncovered | a violation left uncovered |
 * | --- | --- | --- |
 * | **no waiver fired** | `clean` | `unwaived` |
 * | **a waiver fired** | `waived` | `waived-partial` |
 *
 * A violation is any finding at `blocking` or `compromise`; `info` findings are
 * provenance and never move the disposition. The one thing this table
 * guarantees, and the reason it exists: a subject with a waived violation can
 * never report `clean`, and can never report `allowed` either, because
 * {@link WAIVER_REASON.WAIVER_APPLIED} is itself a `compromise`.
 *
 * @readonly
 * @enum {string}
 */
export const WAIVER_DISPOSITION = Object.freeze({
  /** Nothing was waived and nothing needed to be. */
  CLEAN: 'clean',
  /** Every violation here stands because somebody signed off on it. */
  WAIVED: 'waived',
  /** Some violations are waived and some are not. */
  WAIVED_PARTIAL: 'waived-partial',
  /** Violations stand with nobody's signature on them. */
  UNWAIVED: 'unwaived',
});

/**
 * What a waiver is narrowed to. A superset of `CONSTRAINT_SCOPE_KIND` in one
 * respect (`game`) and unlike it in another, which is the interesting part:
 * a waiver scope may narrow on **several** dimensions at once.
 *
 * A constraint scope may not, because constraint precedence rests on a
 * specificity *rank* and a two-axis scope has no defensible rank against a
 * one-axis scope. Waivers never compete for precedence — two waivers that both
 * apply both apply, additively — so the objection does not transfer, and
 * incident 9's waiver genuinely is two-dimensional: *this coach*, *between
 * these two venues*.
 *
 * @readonly
 * @enum {string}
 */
export const WAIVER_SCOPE_DIMENSION = Object.freeze({
  PERSON: 'person',
  TEAM: 'team',
  GAME: 'game',
  VENUES: 'venues',
  SURFACE: 'surface',
  DIVISION: 'division',
  DATE: 'date',
  DATE_RANGE: 'date-range',
});

/**
 * How narrow each dimension is, for the "a waiver must not be broader than the
 * constraint it excepts" check. Deliberately the same integers
 * `CONSTRAINT_SCOPE_SPECIFICITY` uses, so the two can be compared directly.
 *
 * @type {Readonly<Record<string, number>>}
 */
export const WAIVER_SCOPE_SPECIFICITY = Object.freeze({
  [WAIVER_SCOPE_DIMENSION.DATE_RANGE]: 1,
  [WAIVER_SCOPE_DIMENSION.DATE]: 2,
  [WAIVER_SCOPE_DIMENSION.DIVISION]: 2,
  [WAIVER_SCOPE_DIMENSION.VENUES]: 2,
  [WAIVER_SCOPE_DIMENSION.SURFACE]: 3,
  [WAIVER_SCOPE_DIMENSION.TEAM]: 3,
  [WAIVER_SCOPE_DIMENSION.PERSON]: 3,
  [WAIVER_SCOPE_DIMENSION.GAME]: 3,
});

/**
 * Every reason a waiver check can give.
 *
 * @readonly
 * @enum {string}
 */
export const WAIVER_REASON = Object.freeze({
  /* -- building the ledger -------------------------------------------------- */
  /**
   * The ledger holds no waivers.
   *
   * `info`, and deliberately **not** `blocking` like `REGISTRY_EMPTY`. The
   * asymmetry is the point: an empty constraint registry makes every "this is
   * allowed" answer true for the wrong reason, whereas an empty waiver ledger
   * makes every "nothing was waived" answer true for the right one. Most
   * seasons have no waivers at all, and a season that has none should not look
   * broken. The vacuity that *does* matter here is a dormancy scan that
   * examined nothing, and that has its own code.
   */
  WAIVER_LEDGER_EMPTY: 'WAIVER_LEDGER_EMPTY',
  /** Two waivers claim the same id. */
  WAIVER_ID_DUPLICATE: 'WAIVER_ID_DUPLICATE',
  /**
   * The waiver excepts a constraint the registry does not hold.
   *
   * `blocking`, and this is the code incident 9 exists for: a waiver whose
   * subject has been renamed or removed across a rebuild is exactly the
   * comment that got lost, still on disk and quietly governing nothing.
   */
  WAIVER_CONSTRAINT_UNKNOWN: 'WAIVER_CONSTRAINT_UNKNOWN',
  /**
   * The waiver excepts a constraint whose record says `waivable: false`.
   *
   * `blocking`, and the waiver is **not** applied. "No game sits outside its
   * venue permit" is not a rule anybody may sign away, and a ledger that thinks
   * otherwise must fail loudly. (The sunset margin was the other example; since
   * the owner's decision of 2026-11-02 it is a compromise, so there is nothing to
   * waive there, and its record stays `waivable: false`.)
   */
  WAIVER_CONSTRAINT_NOT_WAIVABLE: 'WAIVER_CONSTRAINT_NOT_WAIVABLE',
  /**
   * The waiver names reason codes the constraint it excepts does not govern.
   * `compromise`: the waiver would silently cover nothing.
   */
  WAIVER_REASON_CODE_UNCLAIMED: 'WAIVER_REASON_CODE_UNCLAIMED',

  /* -- effective windows ---------------------------------------------------- */
  /** The context date precedes the waiver's `effectiveFrom`. */
  WAIVER_NOT_YET_EFFECTIVE: 'WAIVER_NOT_YET_EFFECTIVE',
  /** The context date follows the waiver's expiry. */
  WAIVER_EXPIRED: 'WAIVER_EXPIRED',
  /**
   * The waiver has a window and the caller supplied no date, so whether it
   * applies cannot be decided. `compromise`, exactly as
   * `CONSTRAINT_WINDOW_UNJUDGED`: "the exception applies" and "it does not" are
   * both fabricated answers here.
   */
  WAIVER_WINDOW_UNJUDGED: 'WAIVER_WINDOW_UNJUDGED',

  /* -- scope ---------------------------------------------------------------- */
  /**
   * The waiver narrows on a dimension the subject does not carry.
   * `compromise`, for the same reason as `CONSTRAINT_SCOPE_UNJUDGED`.
   */
  WAIVER_SCOPE_UNJUDGED: 'WAIVER_SCOPE_UNJUDGED',
  /**
   * A waiver's `division` dimension was matched on its **label**. GAP-24:
   * division labels are not a key — `16GSelect02` appears under `U16G` and
   * `16GS` in the same corpus — so a label match is a best effort and says so.
   */
  WAIVER_DIVISION_LABEL_MATCH: 'WAIVER_DIVISION_LABEL_MATCH',
  /**
   * The waiver's scope is broader than the scope of the constraint it excepts.
   *
   * `compromise`. A global exception to a person-scoped rule is not an
   * exception, it is a repeal wearing an exception's clothes, and the two must
   * not be confused by anybody reading the ledger later.
   */
  WAIVER_BROADER_THAN_CONSTRAINT: 'WAIVER_BROADER_THAN_CONSTRAINT',

  /* -- application ---------------------------------------------------------- */
  /**
   * A waiver covered a violation. **The** code of this module.
   *
   * `compromise`, never `info`, and that single choice is what makes "never
   * silently" mechanical rather than aspirational: because
   * {@link deriveWaiverStatus} reads severities and nothing else, a subject
   * carrying this finding cannot derive `allowed` no matter what else is true
   * of it. A waived schedule is a schedule with a note on it, permanently.
   */
  WAIVER_APPLIED: 'WAIVER_APPLIED',
  /**
   * A violation of a waivable constraint stood with no waiver covering it.
   * `info` — the violation's own finding already carries the weight; this is
   * provenance saying the ledger was consulted and had nothing to offer.
   */
  WAIVER_ABSENT: 'WAIVER_ABSENT',
  /**
   * Findings were handed to the applier, the ledger is not empty, and **not
   * one** finding's reason code links to any constraint, so no waiver could
   * possibly have applied.
   *
   * `compromise`. Incident 4 in the costume this module wears: an applier that
   * matched nothing must not be indistinguishable from an applier that found
   * nothing to waive.
   */
  WAIVER_APPLY_UNLINKED: 'WAIVER_APPLY_UNLINKED',

  /* -- dormancy ------------------------------------------------------------- */
  /**
   * The waiver covered nothing in this solve: the schedule presents no
   * violation for it to excuse. A retirement candidate.
   *
   * `info`, because a dormant waiver breaks nothing today. It is reported
   * every time all the same, since the failure mode incident 9 records is a
   * waiver nobody remembers granting.
   */
  WAIVER_DORMANT: 'WAIVER_DORMANT',
  /**
   * The waiver fired, but no subject's status depends on it — every violation
   * it covered was a `compromise` with or without it. Weaker than dormant and
   * still a retirement candidate: nothing turns on it today.
   */
  WAIVER_NOT_STATUS_BEARING: 'WAIVER_NOT_STATUS_BEARING',
  /**
   * A dormancy scan examined **zero subjects**, so "every waiver is dormant"
   * would be an artefact of the input rather than a fact about the schedule.
   * `compromise` — incident 4.
   *
   * Subjects that carry no findings are deliberately *not* vacuous: a clean
   * schedule is the ordinary reason a waiver goes dormant, and it is incident
   * 9's middle act. Crying incident 4 over the normal case would bury the real
   * signal.
   */
  WAIVER_SCAN_VACUOUS: 'WAIVER_SCAN_VACUOUS',
});

/**
 * Severity of every reason code.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const WAIVER_REASON_SEVERITY = Object.freeze({
  [WAIVER_REASON.WAIVER_LEDGER_EMPTY]: WAIVER_SEVERITY.INFO,
  [WAIVER_REASON.WAIVER_ID_DUPLICATE]: WAIVER_SEVERITY.BLOCKING,
  [WAIVER_REASON.WAIVER_CONSTRAINT_UNKNOWN]: WAIVER_SEVERITY.BLOCKING,
  [WAIVER_REASON.WAIVER_CONSTRAINT_NOT_WAIVABLE]: WAIVER_SEVERITY.BLOCKING,
  [WAIVER_REASON.WAIVER_REASON_CODE_UNCLAIMED]: WAIVER_SEVERITY.COMPROMISE,

  [WAIVER_REASON.WAIVER_NOT_YET_EFFECTIVE]: WAIVER_SEVERITY.INFO,
  [WAIVER_REASON.WAIVER_EXPIRED]: WAIVER_SEVERITY.INFO,
  [WAIVER_REASON.WAIVER_WINDOW_UNJUDGED]: WAIVER_SEVERITY.COMPROMISE,

  [WAIVER_REASON.WAIVER_SCOPE_UNJUDGED]: WAIVER_SEVERITY.COMPROMISE,
  [WAIVER_REASON.WAIVER_DIVISION_LABEL_MATCH]: WAIVER_SEVERITY.INFO,
  [WAIVER_REASON.WAIVER_BROADER_THAN_CONSTRAINT]: WAIVER_SEVERITY.COMPROMISE,

  [WAIVER_REASON.WAIVER_APPLIED]: WAIVER_SEVERITY.COMPROMISE,
  [WAIVER_REASON.WAIVER_ABSENT]: WAIVER_SEVERITY.INFO,
  [WAIVER_REASON.WAIVER_APPLY_UNLINKED]: WAIVER_SEVERITY.COMPROMISE,

  [WAIVER_REASON.WAIVER_DORMANT]: WAIVER_SEVERITY.INFO,
  [WAIVER_REASON.WAIVER_NOT_STATUS_BEARING]: WAIVER_SEVERITY.INFO,
  [WAIVER_REASON.WAIVER_SCAN_VACUOUS]: WAIVER_SEVERITY.COMPROMISE,
});

/**
 * Severity of a waiver reason code.
 *
 * Throws on an unknown code rather than defaulting to `info`, for the same
 * reason every other module's lookup does.
 *
 * @param {string} code
 * @returns {string} a {@link WAIVER_SEVERITY} value
 */
export function waiverSeverityOf(code) {
  const severity = WAIVER_REASON_SEVERITY[code];
  if (!severity) {
    throw new Error(`waivers: reason code "${code}" has no registered severity`);
  }
  return severity;
}

/**
 * How narrow a waiver scope dimension is. Higher is narrower.
 *
 * @param {string} dimension - a {@link WAIVER_SCOPE_DIMENSION} value
 * @returns {number}
 */
export function waiverSpecificityOf(dimension) {
  const rank = WAIVER_SCOPE_SPECIFICITY[dimension];
  if (rank === undefined) {
    throw new Error(`waivers: scope dimension "${dimension}" has no registered specificity`);
  }
  return rank;
}

/**
 * Build a waiver finding. `severity` is looked up, never passed in.
 *
 * @param {string} code - a {@link WAIVER_REASON} value
 * @param {string} message - for humans only
 * @param {Record<string, unknown>} [details] - flat primitives and ids only
 * @returns {import('./types.js').WaiverFinding}
 */
export function makeWaiverFinding(code, message, details = {}) {
  return { code, severity: waiverSeverityOf(code), message, details };
}

/**
 * Derive the status of a check mechanically from its findings.
 *
 * @param {ReadonlyArray<import('./types.js').WaiverFinding>} findings
 * @returns {string} a {@link WAIVER_STATUS} value
 */
export function deriveWaiverStatus(findings) {
  return deriveFacilityStatus(
    /** @type {ReadonlyArray<import('../facility/types.js').FacilityFinding>} */ (findings)
  );
}

/**
 * Derive the disposition mechanically from the 2x2 in {@link WAIVER_DISPOSITION}.
 *
 * Never written by hand at a call site: a hand-written disposition is how
 * "waived" quietly becomes "clean".
 *
 * @param {{ waivedCount: number, uncoveredViolationCount: number }} counts
 * @returns {string} a {@link WAIVER_DISPOSITION} value
 */
export function deriveWaiverDisposition({ waivedCount, uncoveredViolationCount }) {
  if (waivedCount > 0) {
    return uncoveredViolationCount > 0
      ? WAIVER_DISPOSITION.WAIVED_PARTIAL
      : WAIVER_DISPOSITION.WAIVED;
  }
  return uncoveredViolationCount > 0 ? WAIVER_DISPOSITION.UNWAIVED : WAIVER_DISPOSITION.CLEAN;
}

/**
 * Is this finding a violation for disposition purposes?
 *
 * `info` findings are provenance — an expired waiver, a division-label match —
 * and must never move the disposition.
 *
 * @param {import('./types.js').WaiverFinding} finding
 * @returns {boolean}
 */
export function isViolationFinding(finding) {
  return (
    finding.severity === WAIVER_SEVERITY.BLOCKING || finding.severity === WAIVER_SEVERITY.COMPROMISE
  );
}

/**
 * Fresh zeroed counters.
 *
 * Incident 4 in `fixtures/season-2026/README.md` is a validator that matched
 * zero records and reported a perfect score. Every result in this module
 * carries these so a test can assert the check was not vacuous.
 *
 * @returns {import('./types.js').WaiverMeta}
 */
export function createWaiverMeta() {
  return {
    waiversConsidered: 0,
    waiversApplicable: 0,
    waiversInactive: 0,
    waiversOutOfScope: 0,
    waiversUnjudged: 0,
    waiversApplied: 0,
    scopeDimensionsTested: 0,
    subjectsExamined: 0,
    findingsExamined: 0,
    findingsWaived: 0,
    constraintsLinked: 0,
    dormancyProbes: 0,
  };
}

/**
 * Add one counter set into another, in place.
 *
 * @param {import('./types.js').WaiverMeta} target
 * @param {import('./types.js').WaiverMeta} source
 * @returns {import('./types.js').WaiverMeta}
 */
export function mergeWaiverMeta(target, source) {
  for (const key of Object.keys(target)) {
    target[key] += source[key] ?? 0;
  }
  return target;
}
