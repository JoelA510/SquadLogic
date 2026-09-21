/**
 * One subject's history out of a change log, and the state it held on a date.
 *
 * **A history is a sequence of states, not a mutable row.** Two states for one
 * date means "what was it then" has two answers and the history has stopped
 * being one, so that is {@link CHANGELOG_REASON.HISTORY_CONFLICT} at blocking.
 * The claim, the shape and the severity are `practice/history.js`'s, adopted
 * rather than re-derived: `CLAUDE.md` says that when a sibling function
 * already handles an edge case, take its contract instead of inventing a
 * third one, and two modules in this repository already answer "what did this
 * entity look like then".
 *
 * ## What an as-of query over this log is, and what it is not
 *
 * The log dates each entry by **the thing that changed**, not by when the
 * decision was taken. So {@link stateAsOf} answers *"the most recently logged
 * state for this subject at or before this date"* — a valid-time question. It
 * does **not** answer "what did the club believe the schedule was on that
 * date", which needs a transaction time the source does not carry. Every log
 * says so through `TRANSACTION_TIME_ABSENT`.
 *
 * ## A derived answer cannot come out cleaner than the log it came from
 *
 * `logStatus` travels on every history and every as-of answer, and when the
 * log is `rejected` the answer carries
 * {@link CHANGELOG_REASON.DERIVED_FROM_REJECTED_LOG} so its own `status` can
 * never read `allowed`. Both halves are needed and they do different work:
 * the field lets a reader see the upstream standing, the finding stops a
 * consumer that reads only `.status` from getting a clean verdict on a log
 * that was refused.
 *
 * The log's **own** findings are deliberately *not* merged in — the contract
 * `publication/notices.js` set with `parityStatus`, for the reason it gives:
 * a derived answer answers a different question, and merging would make every
 * honest history over a log with one unroutable participant read as though
 * that participant were this subject's problem.
 *
 * ## An unlogged subject is not an unchanged subject
 *
 * `logged: false` is a distinct field from `state: null` for the reason
 * `ConsequencePreview.jsx` gives about an empty table: "nothing happened" and
 * "we have not looked" render identically as absence, and only one of them is
 * a claim this package is entitled to make.
 *
 * @module changelog/history
 */

import { deepFreeze } from '../facility/facilityGraph.js';

import {
  CHANGELOG_REASON,
  CHANGELOG_STATUS,
  deriveChangelogStatus,
  makeChangelogFinding,
} from './reasonCodes.js';
import { IsoDateSchema } from './schemas.js';

/**
 * Every logged change to one subject, in date order.
 *
 * The subject is looked up in the log the caller supplies; the log's own
 * entry list is the universe, and a subject with no entry produces a stated
 * empty history rather than a throw — "this subject was never logged" is an
 * answer, and one a caller acts on.
 *
 * @param {import('./types.js').ChangeLog} log
 * @param {{ subjectId: string }} query
 * @returns {import('./types.js').ChangeHistory}
 */
export function buildChangeHistory(log, { subjectId } = /** @type {any} */ ({})) {
  if (typeof subjectId !== 'string' || subjectId.length === 0) {
    throw new TypeError('buildChangeHistory requires a subjectId');
  }

  /** @type {import('./types.js').ChangeLogFinding[]} */
  const findings = [];
  /** @type {import('./types.js').ChangeHistoryPhase[]} */
  const phases = log.entries
    .filter((entry) => entry.subjectId === subjectId)
    .map((entry) => ({
      date: entry.date,
      ordinal: entry.ordinal,
      entryKey: entry.key,
      kind: entry.kind,
      sourceId: entry.sourceId,
      reason: entry.reason,
      before: entry.before,
      after: entry.after,
    }));

  // Tie-broken on `ordinal`, the source position, **not** on `entryKey`.
  // Two phases sharing a date also share their key by construction (it is
  // `date|label` and the label is the subject), so a key tie-break would be
  // dead code and the order would fall back to insertion.
  phases.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return a.ordinal - b.ordinal;
  });

  let conflictCount = 0;
  for (let i = 1; i < phases.length; i += 1) {
    if (phases[i].date !== phases[i - 1].date) continue;
    conflictCount += 1;
    findings.push(
      makeChangelogFinding(
        CHANGELOG_REASON.HISTORY_CONFLICT,
        `subject "${subjectId}" holds two logged states on ${phases[i].date} (source entries ${phases[i - 1].ordinal} and ${phases[i].ordinal}); a history is a sequence of states, one per date`,
        {
          subjectId,
          date: phases[i].date,
          entryKey: phases[i].entryKey,
          ordinals: [phases[i - 1].ordinal, phases[i].ordinal],
        }
      )
    );
  }

  if (log.status === CHANGELOG_STATUS.REJECTED) {
    findings.push(
      makeChangelogFinding(
        CHANGELOG_REASON.DERIVED_FROM_REJECTED_LOG,
        `this history for "${subjectId}" is derived from a log whose own status is rejected; what it says about this subject may be right, but it is not a clean answer`,
        { subjectId, logStatus: log.status }
      )
    );
  }

  if (phases.length === 0) {
    findings.push(
      makeChangelogFinding(
        CHANGELOG_REASON.HISTORY_EMPTY,
        `subject "${subjectId}" has no entry in this log of ${log.entries.length}; that means nobody logged a change to it, not that it held still and not that the id is a typo`,
        { subjectId, logEntryCount: log.entries.length }
      )
    );
  }

  return deepFreeze({
    subjectId,
    phases,
    logStatus: log.status,
    findings,
    status: deriveChangelogStatus(findings),
    stats: {
      phaseCount: phases.length,
      conflictCount,
      logEntryCount: log.entries.length,
    },
  });
}

/**
 * What state this subject was most recently logged as holding, at or before
 * `asOf`.
 *
 * With no `asOf` the window cannot be applied at all, so the answer is no
 * state and {@link CHANGELOG_REASON.AS_OF_UNJUDGED} says so — deliberately the
 * same contract and the same severity as `people/roster.js`'s
 * `ASSIGNMENT_WINDOW_UNJUDGED`. Returning the last entry as though it were
 * current is the failure that rule exists to prevent, one entity over.
 *
 * @param {import('./types.js').ChangeLog} log
 * @param {{ subjectId: string, asOf?: string|null }} query
 * @returns {import('./types.js').ChangeStateAsOf}
 */
export function stateAsOf(log, { subjectId, asOf = null } = /** @type {any} */ ({})) {
  if (typeof subjectId !== 'string' || subjectId.length === 0) {
    throw new TypeError('stateAsOf requires a subjectId');
  }
  if (asOf !== null) IsoDateSchema.parse(asOf);

  const history = buildChangeHistory(log, { subjectId });
  /** @type {import('./types.js').ChangeLogFinding[]} */
  const findings = [...history.findings];

  if (asOf === null) {
    findings.push(
      makeChangelogFinding(
        CHANGELOG_REASON.AS_OF_UNJUDGED,
        `subject "${subjectId}" has ${history.phases.length} logged state(s) and no as-of date was given, so no state was selected; the last entry is not "current" unless a date says it is`,
        { subjectId, phaseCount: history.phases.length }
      )
    );
    return deepFreeze({
      subjectId,
      asOf: null,
      logStatus: log.status,
      state: null,
      logged: history.phases.length > 0,
      fromEntryKey: null,
      findings,
      status: deriveChangelogStatus(findings),
    });
  }

  // Lexicographic comparison is exact for zero-padded ISO dates, and no `Date`
  // is constructed (GAP-30) -- the same reading `facility/lifecycle.js` gives.
  const applicable = history.phases.filter((phase) => phase.date <= asOf);
  const latest = applicable.length === 0 ? null : applicable[applicable.length - 1];

  return deepFreeze({
    subjectId,
    asOf,
    logStatus: log.status,
    state: latest === null ? null : latest.after,
    logged: latest !== null,
    fromEntryKey: latest === null ? null : latest.entryKey,
    findings,
    status: deriveChangelogStatus(findings),
  });
}
