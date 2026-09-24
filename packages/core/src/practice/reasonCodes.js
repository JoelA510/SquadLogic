/**
 * Machine-readable reason codes for the recurring-practice model, and the one
 * severity table that turns a list of findings into a status.
 *
 * Same two rules as `facility/reasonCodes.js`, and deliberately the same
 * shape so a practice finding can sit in the same list as a facility one:
 *
 * 1. **`code` is the contract, `message` is decoration.** Never parse a
 *    message.
 * 2. **Severity lives here and nowhere else.** No call site decides that a
 *    finding is blocking.
 *
 * The severity *enum* and the status enum are re-exported from
 * `facility/reasonCodes.js` rather than redeclared. `availability/reasonCodes.js`
 * already established that (`AVAILABILITY_SEVERITY = FACILITY_SEVERITY`), and a
 * third set of the strings `'blocking' | 'compromise' | 'info'` is a third
 * thing to keep in step.
 *
 * @module practice/reasonCodes
 */

import { FACILITY_SEVERITY, FACILITY_STATUS } from '../facility/reasonCodes.js';

/**
 * How badly a finding counts against a practice plan.
 *
 * @readonly
 * @enum {string}
 */
export const PRACTICE_SEVERITY = FACILITY_SEVERITY;

/**
 * The three-state outcome of a practice check.
 *
 * @readonly
 * @enum {string}
 */
export const PRACTICE_STATUS = FACILITY_STATUS;

/**
 * Every reason the practice model can give.
 *
 * @readonly
 * @enum {string}
 */
export const PRACTICE_REASON = Object.freeze({
  /* -- the slot set ------------------------------------------------------ */
  /**
   * Two slots in one set describe the same recurring window on the same
   * ground: same surface, same weekday, same start, and overlapping validity.
   *
   * Both are kept. Dropping one would be the silent reconciliation the corpus
   * README refuses for the decoder rings, and a duplicate is usually two
   * revisions of one plan rather than a mistake.
   */
  SLOT_DUPLICATE: 'PRACTICE_SLOT_DUPLICATE',
  /**
   * A slot's validity range contains no occurrence of its own weekday — a
   * Friday slot valid only Mon–Thu of one week. The slot is legal and
   * materialises to nothing, which is worth saying out loud rather than
   * returning an empty list.
   */
  SLOT_NEVER_OCCURS: 'PRACTICE_SLOT_NEVER_OCCURS',
  /**
   * **The slot's ground did not resolve to exactly one facility surface.**
   *
   * An adapter states how a `(venue, field, subunit)` triple resolved, using
   * `facility/practiceSurfaces.js`'s vocabulary; this code is raised for any
   * answer that is not `resolved`. The slot is kept — dropping it would make
   * the count dishonest — but its `surfaceId` points at nothing the graph
   * holds, so an occupancy or closure check over it would decide nothing.
   *
   * The same division of labour `buildClosureSet()` uses: the adapter *says*
   * the sheet named ground nothing knows, and the builder turns that into a
   * finding. It is here rather than in the adapter because the adapter
   * produces plan data, not findings.
   */
  SLOT_SURFACE_UNRESOLVED: 'PRACTICE_SLOT_SURFACE_UNRESOLVED',

  /* -- revisions (the corpus's seven plans) ------------------------------ */
  /**
   * **A revision carries no effective date range.**
   *
   * `fixtures/season-2026/practice/README.md` §4: "Seven revisions of the plan
   * coexist with no statement of which is current… `source_sheet` is retained
   * per row rather than resolved, because the source does not say."
   *
   * The model will not invent the range. A slot whose revision is undated is
   * carried with a null validity and reported here, so a history built from
   * the corpus is visibly incomplete instead of confidently wrong.
   */
  REVISION_UNDATED: 'PRACTICE_REVISION_UNDATED',
  /**
   * More than one revision is undated, so they cannot even be *ordered*,
   * let alone dated. Separate from {@link PRACTICE_REASON.REVISION_UNDATED}
   * because one undated revision can still be read as "the current one" while
   * two cannot be read at all.
   */
  REVISION_ORDER_UNKNOWN: 'PRACTICE_REVISION_ORDER_UNKNOWN',

  /* -- a team's history -------------------------------------------------- */
  /**
   * Two of a team's practice ranges overlap. The model's central claim is that
   * a history is *a sequence of non-overlapping ranges*; this is that claim
   * failing, so it is blocking rather than advisory.
   */
  HISTORY_OVERLAP: 'PRACTICE_HISTORY_OVERLAP',
  /**
   * A team's ranges leave a gap. Legal — a team can genuinely not practise for
   * a fortnight — so `info`, but reported because a gap is equally often a
   * range somebody forgot to extend.
   */
  HISTORY_GAP: 'PRACTICE_HISTORY_GAP',
  /**
   * The team holds no slot in this plan.
   *
   * The counterpart of `PRACTICE_WINDOW_EMPTY`, and here for the same reason:
   * an empty phase list cannot otherwise be told apart from a mistyped team
   * id. Without it a history of nothing reads `allowed` with no findings,
   * which is the same falsely-clean result in a smaller disguise.
   */
  HISTORY_EMPTY: 'PRACTICE_HISTORY_EMPTY',

  /* -- materialisation --------------------------------------------------- */
  /**
   * An exception removed an occurrence.
   *
   * `CLAUDE.md` §3: never silently drop an unplaceable fixture; surface it with
   * a reason. A cancelled practice is exactly that, so every suppression is a
   * finding carrying the date and the exception's stated reason. A caller that
   * wants the plain list still gets it; a caller that reports on the season
   * can say *which* Tuesday went and why.
   */
  OCCURRENCE_SUPPRESSED: 'PRACTICE_OCCURRENCE_SUPPRESSED',
  /** An exception shortened one occurrence. The date survives, the window changes. */
  OCCURRENCE_SHORTENED: 'PRACTICE_OCCURRENCE_SHORTENED',
  /** An exception moved one occurrence's start. The date survives. */
  OCCURRENCE_MOVED: 'PRACTICE_OCCURRENCE_MOVED',
  /**
   * An exception names a date on which its slot does not occur — a Tuesday
   * cancellation on a Thursday slot, or a date outside the slot's validity.
   *
   * `compromise`, not `info`: an exception that matches nothing is usually a
   * cancellation aimed at the wrong slot, which means a practice somebody
   * believes is cancelled is still in the plan.
   */
  EXCEPTION_UNMATCHED: 'PRACTICE_EXCEPTION_UNMATCHED',
  /**
   * An exception named a real occurrence that a cancellation on the same date
   * had already removed.
   *
   * Distinct from {@link PRACTICE_REASON.EXCEPTION_UNMATCHED}, which says the
   * slot does not occur on that date. Here it does — it was cancelled. An
   * earlier draft reported both through `EXCEPTION_UNMATCHED`, whose wording
   * would have sent an operator looking for a wrong-weekday bug that is not
   * there. `info`, because nothing is wrong: a superseded move is what a
   * cancellation is supposed to do to it.
   */
  EXCEPTION_SUPERSEDED: 'PRACTICE_EXCEPTION_SUPERSEDED',
  /** An exception names a slot id the set does not hold. */
  EXCEPTION_UNKNOWN_SLOT: 'PRACTICE_EXCEPTION_UNKNOWN_SLOT',
  /**
   * The requested window produced no occurrences from any slot.
   *
   * The vacuous-pass guard, as a reason code: a caller that materialises a
   * month and gets an empty array should be able to tell "nothing is
   * scheduled" from "you asked about the wrong month".
   */
  WINDOW_EMPTY: 'PRACTICE_WINDOW_EMPTY',

  /* -- the declaration --------------------------------------------------- */
  /**
   * **Nothing in production consults this model.**
   *
   * No standing rule and no registry constraint claims a `PRACTICE_*` code, and
   * no production file outside `practice/` calls `buildPracticeSlotSet()`,
   * `materialisePracticeOccurrences()` or `buildPracticeHistory()`.
   *
   * The live practice path is `PracticeSchedulingPage.partitionPracticeSlots()`
   * (`frontend/src/pages/PracticeSchedulingPage.jsx:211`), which normalises
   * `practice_slots` rows onto the season clock through
   * `frontend/src/utils/seasonClockSlots.js` with the season's own timezone.
   * That is the single call site that would reach this model, and replacing it
   * is a change to the live persistence path rather than a rider on a
   * domain-model PR — so it is not done here, and this code says so on every
   * result instead of the PR saying it once.
   *
   * Same idiom as `CLOSURE_SET_UNWIRED` and `ALIAS_LAYER_UNWIRED`, and held to
   * the same biconditional by `tests/helpers/unwiredLayer.js`: a layer declares
   * itself unwired **exactly** while nothing claims one of its codes.
   */
  MODEL_UNWIRED: 'PRACTICE_MODEL_UNWIRED',

  /* -- bounded local repair (Phase 8.6 PR 3a, `repair.js`) ---------------- */
  /** A displaced series was re-homed at its own venue. One per series. */
  REPAIR_REHOMED: 'PRACTICE_REPAIR_REHOMED',
  /** A displaced series could not be re-homed at its venue: TIME TBD, with a reason. */
  REPAIR_TIME_TBD: 'PRACTICE_REPAIR_TIME_TBD',
  /** A re-home gave a coach more practice days than the published plan did. A warned compromise. */
  REPAIR_COACH_DAYS_WORSENED: 'PRACTICE_REPAIR_COACH_DAYS_WORSENED',
  /** A re-home put two of one coach's practices at the same time. A warned compromise. */
  REPAIR_COACH_OVERLAP_CARRIED: 'PRACTICE_REPAIR_COACH_OVERLAP_CARRIED',
  /** The search stopped before proving its answer optimal, or never tried to. */
  REPAIR_MINIMALITY_UNPROVEN: 'PRACTICE_REPAIR_MINIMALITY_UNPROVEN',
  /** A series on the lost ground has no validity range, so whether it is displaced is unknown. */
  REPAIR_SERIES_UNDATED: 'PRACTICE_REPAIR_SERIES_UNDATED',
  /** The loss names ground the facility graph does not hold. */
  REPAIR_LOSS_UNKNOWN_SURFACE: 'PRACTICE_REPAIR_LOSS_UNKNOWN_SURFACE',
  /** The loss displaced nothing. Said, so that zero is never read as "repaired". */
  REPAIR_NOTHING_DISPLACED: 'PRACTICE_REPAIR_NOTHING_DISPLACED',
  /** The repair has no production caller (8.6 PR 3b wires it). On every result. */
  REPAIR_UNWIRED: 'PRACTICE_REPAIR_UNWIRED',
});

/**
 * Severity of every reason code.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const PRACTICE_REASON_SEVERITY = Object.freeze({
  // Both halves of a duplicate are carried, so the plan is readable; it is the
  // *reading* that is compromised, not the data.
  [PRACTICE_REASON.SLOT_DUPLICATE]: PRACTICE_SEVERITY.COMPROMISE,
  [PRACTICE_REASON.SLOT_NEVER_OCCURS]: PRACTICE_SEVERITY.COMPROMISE,
  // The plan is readable; what cannot be decided is anything about the ground.
  [PRACTICE_REASON.SLOT_SURFACE_UNRESOLVED]: PRACTICE_SEVERITY.COMPROMISE,

  [PRACTICE_REASON.REVISION_UNDATED]: PRACTICE_SEVERITY.COMPROMISE,
  [PRACTICE_REASON.REVISION_ORDER_UNKNOWN]: PRACTICE_SEVERITY.COMPROMISE,

  // The model's own invariant, broken.
  [PRACTICE_REASON.HISTORY_OVERLAP]: PRACTICE_SEVERITY.BLOCKING,
  [PRACTICE_REASON.HISTORY_GAP]: PRACTICE_SEVERITY.INFO,
  [PRACTICE_REASON.HISTORY_EMPTY]: PRACTICE_SEVERITY.INFO,

  // A suppression is the model working, not the model complaining.
  [PRACTICE_REASON.OCCURRENCE_SUPPRESSED]: PRACTICE_SEVERITY.INFO,
  [PRACTICE_REASON.OCCURRENCE_SHORTENED]: PRACTICE_SEVERITY.INFO,
  [PRACTICE_REASON.OCCURRENCE_MOVED]: PRACTICE_SEVERITY.INFO,
  [PRACTICE_REASON.EXCEPTION_UNMATCHED]: PRACTICE_SEVERITY.COMPROMISE,
  [PRACTICE_REASON.EXCEPTION_SUPERSEDED]: PRACTICE_SEVERITY.INFO,
  [PRACTICE_REASON.EXCEPTION_UNKNOWN_SLOT]: PRACTICE_SEVERITY.BLOCKING,
  [PRACTICE_REASON.WINDOW_EMPTY]: PRACTICE_SEVERITY.INFO,

  [PRACTICE_REASON.MODEL_UNWIRED]: PRACTICE_SEVERITY.INFO,
  [PRACTICE_REASON.REPAIR_REHOMED]: PRACTICE_SEVERITY.INFO,
  // An unplaced practice is the result the operator has to act on.
  [PRACTICE_REASON.REPAIR_TIME_TBD]: PRACTICE_SEVERITY.COMPROMISE,
  // Operator ruling 2026-09-23 (the #61 analogue): avoid, allow, and warn.
  [PRACTICE_REASON.REPAIR_COACH_DAYS_WORSENED]: PRACTICE_SEVERITY.COMPROMISE,
  [PRACTICE_REASON.REPAIR_COACH_OVERLAP_CARRIED]: PRACTICE_SEVERITY.COMPROMISE,
  [PRACTICE_REASON.REPAIR_MINIMALITY_UNPROVEN]: PRACTICE_SEVERITY.COMPROMISE,
  [PRACTICE_REASON.REPAIR_SERIES_UNDATED]: PRACTICE_SEVERITY.COMPROMISE,
  [PRACTICE_REASON.REPAIR_LOSS_UNKNOWN_SURFACE]: PRACTICE_SEVERITY.BLOCKING,
  [PRACTICE_REASON.REPAIR_NOTHING_DISPLACED]: PRACTICE_SEVERITY.INFO,
  [PRACTICE_REASON.REPAIR_UNWIRED]: PRACTICE_SEVERITY.INFO,
});

/**
 * Severity of a reason code.
 *
 * Throws on an unknown code rather than defaulting to `info`, for the reason
 * `facility/reasonCodes.js` gives: a code with no severity is one somebody
 * forgot to register, and a default would make it silently non-blocking.
 *
 * @param {string} code
 * @returns {string} a {@link PRACTICE_SEVERITY} value
 */
export function practiceSeverityOf(code) {
  const severity = PRACTICE_REASON_SEVERITY[code];
  if (!severity) {
    throw new Error(`practice: reason code "${code}" has no registered severity`);
  }
  return severity;
}

/**
 * Build a finding. `severity` is looked up, never passed in.
 *
 * @param {string} code - a {@link PRACTICE_REASON} value
 * @param {string} message - for humans only
 * @param {Record<string, unknown>} [details] - flat primitives and ids only
 * @returns {import('./types.js').PracticeFinding}
 */
export function makePracticeFinding(code, message, details = {}) {
  return { code, severity: practiceSeverityOf(code), message, details };
}

/**
 * Derive a status mechanically from findings. Never write one by hand.
 *
 * @param {ReadonlyArray<import('./types.js').PracticeFinding>} findings
 * @returns {string} a {@link PRACTICE_STATUS} value
 */
export function derivePracticeStatus(findings) {
  let compromised = false;
  for (const finding of findings) {
    if (finding.severity === PRACTICE_SEVERITY.BLOCKING) return PRACTICE_STATUS.REJECTED;
    if (finding.severity === PRACTICE_SEVERITY.COMPROMISE) compromised = true;
  }
  return compromised ? PRACTICE_STATUS.COMPROMISED : PRACTICE_STATUS.ALLOWED;
}
