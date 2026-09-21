/**
 * Machine-readable reason codes for the change log, and the one severity table
 * that turns a list of findings into a status.
 *
 * Same two rules as `facility/reasonCodes.js`, and deliberately the same shape
 * so a changelog finding can sit in the same list as a facility or practice
 * one:
 *
 * 1. **`code` is the contract, `message` is decoration.** Never parse a
 *    message.
 * 2. **Severity lives here and nowhere else.** No call site decides that a
 *    finding is blocking.
 *
 * The severity and status enums are re-exported from `facility/reasonCodes.js`
 * rather than redeclared, following `availability/` and `practice/`.
 *
 * ## Two properties of a change log that the codes exist to keep visible
 *
 * A change log is read as though it answered two different questions, and a
 * source log usually answers only one of them. Both limits are findings here
 * rather than prose in a README, because a reader who is not told will assume
 * the stronger reading:
 *
 * - {@link CHANGELOG_REASON.TRANSACTION_TIME_ABSENT} — the log dates the
 *   **fixture**, not the **decision**. "What was this game's time on 3 October"
 *   is answerable; "what did we believe the schedule was on 3 October" is not,
 *   and the two look identical from a column called `date`.
 * - {@link CHANGELOG_REASON.COVERAGE_UNSTATED} — a change log is a record of
 *   changes that were written down, never a proof that the rest did not change.
 *   An entity with no entry is an entity nobody logged, which is not the same
 *   as an entity that held still.
 *
 * @module changelog/reasonCodes
 */

import { FACILITY_SEVERITY, FACILITY_STATUS } from '../facility/reasonCodes.js';

/**
 * How badly a finding counts against a change log.
 *
 * @readonly
 * @enum {string}
 */
export const CHANGELOG_SEVERITY = FACILITY_SEVERITY;

/**
 * The three-state outcome of a change-log check.
 *
 * @readonly
 * @enum {string}
 */
export const CHANGELOG_STATUS = FACILITY_STATUS;

/**
 * How a participant label was resolved against the team universe.
 *
 * **Three values, because two would hide the one that matters.** A label is
 * either a team we can address, a label declared not to be a team, or neither
 * — and the third is the only one that costs a family a notice. Collapsing
 * "declared non-team" and "unrecognised" into one "not a team" bucket is how
 * incident 4's second checker read a placeholder as a team code.
 *
 * @readonly
 * @enum {string}
 */
export const PARTICIPANT_RESOLUTION = Object.freeze({
  /** The label is a team in the universe the caller supplied. */
  TEAM: 'team',
  /** The caller declared this label is not a team (a visiting club, `-`, a session). */
  DECLARED_NON_TEAM: 'declared-non-team',
  /** Neither. Nobody can be told about this change. */
  UNRESOLVED: 'unresolved',
});

/**
 * Every reason the change-log model can give.
 *
 * @readonly
 * @enum {string}
 */
export const CHANGELOG_REASON = Object.freeze({
  /* -- the partition ------------------------------------------------------- */
  /**
   * An entry's stated reason matches no declared source.
   *
   * `blocking`. A classifier over a closed set of source strings is one new
   * source away from silently filing a change as "other" and reporting a
   * complete partition. The whole point of declaring sources is that an
   * undeclared one is loud.
   */
  SOURCE_UNDECLARED: 'SOURCE_UNDECLARED',
  /**
   * More than one declared source claims the same entry.
   *
   * `blocking`. Two matchers overlapping means the source axis is not a
   * partition, and which bucket an entry lands in becomes declaration order —
   * an answer that changes when somebody reorders a list.
   */
  SOURCE_AMBIGUOUS: 'SOURCE_AMBIGUOUS',
  /**
   * The buckets do not reconcile against the input count.
   *
   * `blocking`. This is the falsifiable half of the partition: an entry
   * dropped or counted twice is caught here rather than by a reader noticing
   * the totals look odd. `changeLogPartitionFindings()` is exported so a test
   * can hand it a broken partition and prove it fires.
   */
  PARTITION_UNSOUND: 'PARTITION_UNSOUND',
  /**
   * A declared source claimed no entry at all.
   *
   * `compromise`. Not an error — a source can legitimately be dormant — but a
   * matcher that matches nothing is indistinguishable from a matcher that is
   * broken, and incident 4 is the case where nobody looked. Stated at the
   * count rather than left to be inferred from an absence.
   */
  SOURCE_MATCHED_NOTHING: 'SOURCE_MATCHED_NOTHING',

  /* -- who a change is addressed to ---------------------------------------- */
  /**
   * A participant label is neither a known team nor a declared non-team label.
   *
   * `blocking`, and the same refusal `publication/notices.js` makes with
   * `NOTICE_PARTICIPANT_UNKNOWN`: a change nobody can be told about is worse
   * than a change reported late. Adopted rather than re-argued, because a
   * sibling already decided it.
   */
  PARTICIPANT_UNRESOLVED: 'PARTICIPANT_UNRESOLVED',
  /**
   * A label more than one team answers to.
   *
   * `blocking`. Misrouting a family's schedule change to a different family is
   * worse than failing to send it. Same contract as `notices.js`, for the same
   * reason, over the same kind of collision.
   */
  PARTICIPANT_AMBIGUOUS: 'PARTICIPANT_AMBIGUOUS',
  /**
   * An entry names the same participant on both sides.
   *
   * `blocking`. A fixture against itself is a parse failure upstream, and
   * telling one family twice about one change is how a notice run loses trust.
   */
  PARTICIPANT_SELF_PAIRED: 'PARTICIPANT_SELF_PAIRED',

  /* -- what the log can and cannot answer ---------------------------------- */
  /**
   * The log carries no decision time, only the date of the thing that changed.
   *
   * `compromise`. See the module header. Every log lacking a transaction time
   * carries this, so an as-of query cannot be read as a point-in-time replay
   * of what was known.
   */
  TRANSACTION_TIME_ABSENT: 'TRANSACTION_TIME_ABSENT',
  /**
   * Nothing states how complete the log is.
   *
   * `compromise`. "No entry" means "nobody logged one", never "nothing
   * happened", and a history rendered without this reads as the latter.
   */
  COVERAGE_UNSTATED: 'COVERAGE_UNSTATED',
  /**
   * An entry claims a change and its before and after are identical.
   *
   * `compromise`. A logged no-op is either a transcription artefact or a
   * change on a field the log does not carry; either way the entry cannot
   * support a notice, and silently dropping it would understate the log.
   */
  ENTRY_CHANGED_NOTHING: 'ENTRY_CHANGED_NOTHING',

  /* -- history ------------------------------------------------------------- */
  /**
   * Two entries claim the same subject on the same date.
   *
   * `blocking`. A history is a sequence of states, so two states for one date
   * means "what was it then" has two answers. Same claim, and the same
   * severity, as `practice/history.js` makes about overlapping ranges — the
   * sibling's contract, adopted rather than a third one invented.
   */
  HISTORY_CONFLICT: 'HISTORY_CONFLICT',
  /**
   * The subject has no entry in this log.
   *
   * `compromise`. An empty history means "this subject was never logged", not
   * "that id is a typo", and rendering it as a blank list says neither.
   */
  HISTORY_EMPTY: 'HISTORY_EMPTY',
  /**
   * A history was asked for with no as-of date.
   *
   * `compromise`, and deliberately the same shape and the same severity as
   * `people/reasonCodes.js` `ASSIGNMENT_WINDOW_UNJUDGED`: the question was
   * underspecified, so the answer is the whole sequence rather than a state,
   * and it says so instead of returning the last entry as though it were
   * current.
   */
  AS_OF_UNJUDGED: 'AS_OF_UNJUDGED',

  /* -- standing ------------------------------------------------------------ */
  /**
   * Every entry for this subject postdates the as-of date.
   *
   * `compromise`. The subject **is** in the log; the log simply has nothing
   * to say about it yet on that date. Without this the answer is
   * indistinguishable from a subject the log never mentions — both give no
   * state — and the two mean opposite things to whoever reads them: one is
   * "we have a record and it starts later", the other is "we have no record".
   * `logged` carries the distinction as a field and this carries it as a
   * finding, because a consumer that reads only `status` sees findings and
   * not fields.
   */
  AS_OF_PRECEDES_LOG: 'AS_OF_PRECEDES_LOG',
  /**
   * A history or as-of answer was derived from a log that is itself rejected.
   *
   * `compromise`. The answer may be perfectly correct about what the log
   * says; what it must not do is read `allowed` when the log it came from
   * does not. `publication/notices.js` set this contract with `parityStatus`
   * — carry the upstream standing on the result, do **not** merge the
   * upstream findings, because a derived answer answers a different question
   * — and this is that contract plus the one thing `parityStatus` alone does
   * not give: a status that cannot come out cleaner than its source.
   */
  DERIVED_FROM_REJECTED_LOG: 'DERIVED_FROM_REJECTED_LOG',
  /**
   * This change log exists for the lifetime of the process.
   *
   * `compromise`. The idiom `publication/snapshot.js` established with
   * `SNAPSHOT_IN_MEMORY_ONLY` and `fieldAdmin/serialise.js` with
   * `REGISTRY_NOT_PERSISTED`: a package that has no store says so in its own
   * findings rather than in a document. The store is GAP-35's, and the
   * decision that it is not built here is recorded in `docs/MODEL_GAPS.md`.
   */
  LOG_NOT_PERSISTED: 'LOG_NOT_PERSISTED',
});

/**
 * Severity per code. The only place severity is decided.
 *
 * @readonly
 * @type {Readonly<Record<string, string>>}
 */
export const CHANGELOG_REASON_SEVERITY = Object.freeze({
  [CHANGELOG_REASON.SOURCE_UNDECLARED]: CHANGELOG_SEVERITY.BLOCKING,
  [CHANGELOG_REASON.SOURCE_AMBIGUOUS]: CHANGELOG_SEVERITY.BLOCKING,
  [CHANGELOG_REASON.PARTITION_UNSOUND]: CHANGELOG_SEVERITY.BLOCKING,
  [CHANGELOG_REASON.SOURCE_MATCHED_NOTHING]: CHANGELOG_SEVERITY.COMPROMISE,
  [CHANGELOG_REASON.PARTICIPANT_UNRESOLVED]: CHANGELOG_SEVERITY.BLOCKING,
  [CHANGELOG_REASON.PARTICIPANT_AMBIGUOUS]: CHANGELOG_SEVERITY.BLOCKING,
  [CHANGELOG_REASON.PARTICIPANT_SELF_PAIRED]: CHANGELOG_SEVERITY.BLOCKING,
  [CHANGELOG_REASON.TRANSACTION_TIME_ABSENT]: CHANGELOG_SEVERITY.COMPROMISE,
  [CHANGELOG_REASON.COVERAGE_UNSTATED]: CHANGELOG_SEVERITY.COMPROMISE,
  [CHANGELOG_REASON.ENTRY_CHANGED_NOTHING]: CHANGELOG_SEVERITY.COMPROMISE,
  [CHANGELOG_REASON.HISTORY_CONFLICT]: CHANGELOG_SEVERITY.BLOCKING,
  [CHANGELOG_REASON.HISTORY_EMPTY]: CHANGELOG_SEVERITY.COMPROMISE,
  [CHANGELOG_REASON.AS_OF_UNJUDGED]: CHANGELOG_SEVERITY.COMPROMISE,
  [CHANGELOG_REASON.AS_OF_PRECEDES_LOG]: CHANGELOG_SEVERITY.COMPROMISE,
  [CHANGELOG_REASON.DERIVED_FROM_REJECTED_LOG]: CHANGELOG_SEVERITY.COMPROMISE,
  [CHANGELOG_REASON.LOG_NOT_PERSISTED]: CHANGELOG_SEVERITY.COMPROMISE,
});

/**
 * Look a severity up. Throws on an unknown code rather than defaulting to
 * `info`, for the reason `facility/reasonCodes.js` gives: a code with no
 * severity is one somebody forgot to register, and a default would make it
 * silently non-blocking.
 *
 * @param {string} code
 * @returns {string} a {@link CHANGELOG_SEVERITY} value
 */
export function changelogSeverityOf(code) {
  const severity = CHANGELOG_REASON_SEVERITY[code];
  if (!severity) {
    throw new Error(`changelog: reason code "${code}" has no registered severity`);
  }
  return severity;
}

/**
 * Build a finding. `severity` is looked up, never passed in.
 *
 * @param {string} code - a {@link CHANGELOG_REASON} value
 * @param {string} message - for humans only
 * @param {Record<string, unknown>} [details] - flat primitives and ids only
 * @returns {import('./types.js').ChangeLogFinding}
 */
export function makeChangelogFinding(code, message, details = {}) {
  return { code, severity: changelogSeverityOf(code), message, details };
}

/**
 * Derive a status mechanically from findings. Never write one by hand.
 *
 * @param {ReadonlyArray<import('./types.js').ChangeLogFinding>} findings
 * @returns {string} a {@link CHANGELOG_STATUS} value
 */
export function deriveChangelogStatus(findings) {
  let compromised = false;
  for (const finding of findings) {
    if (finding.severity === CHANGELOG_SEVERITY.BLOCKING) return CHANGELOG_STATUS.REJECTED;
    if (finding.severity === CHANGELOG_SEVERITY.COMPROMISE) compromised = true;
  }
  return compromised ? CHANGELOG_STATUS.COMPROMISED : CHANGELOG_STATUS.ALLOWED;
}

/**
 * The counters every change-log report carries.
 *
 * Published even at zero, for the reason `facility/lifecycle.js` gives about
 * `datedNodeCount`: a report reading `entriesExamined: 0` says *the universe
 * was empty*, where a silent absence reads as "checked, and clean".
 *
 * @returns {import('./types.js').ChangeLogMeta}
 */
export function createChangelogMeta() {
  return {
    entriesExamined: 0,
    // There is deliberately no `entriesClassified`. One was written and
    // removed in this PR's review round: the classification loop has no early
    // exit, so it was assigned once per entry unconditionally and could never
    // differ from `entriesExamined`. It was published as the pair that would
    // reveal a dropped entry while being incapable of revealing one, which is
    // the meta-assertion CLAUDE.md names first. `changeLogPartitionFindings()`
    // is the reconciliation that can actually fail, and it is exported so a
    // test can make it.
    sourcesDeclared: 0,
    sourcesMatched: 0,
    teamsEnumerated: 0,
    participantsExamined: 0,
    participantsResolved: 0,
    // Published so the three add up to `participantsExamined` without a
    // reader subtracting. A counter you have to derive is one a reader gets
    // wrong, and "declared not a team" is the bucket whose size says how much
    // of the log the caller has actually accounted for.
    participantsDeclaredNonTeam: 0,
    participantsUnresolved: 0,
    subjectsEnumerated: 0,
  };
}
