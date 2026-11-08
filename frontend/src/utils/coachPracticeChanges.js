import {
  EXPORT_PRACTICE_CHANGES_UNREAD_TEXT,
  practiceChangesNoteOf,
  readUnshownPracticeChanges,
} from './practiceExportChanges.js';

/**
 * The omission warning for the practices on the coach schedule (PR 7 fix round, Codex finding 3).
 *
 * The coach schedule lists a coach's practices as their weekly **series**, as the master export does: a saved practice
 * exception (a move, or a TIME TBD window) is not applied to them. The Exports panel says how many practices that
 * leaves out through `utils/practiceExportChanges.js` (8.6 3b PR 12c, operator answer Q6), and the coach report uses
 * that helper as it is: the count comes from `applyPracticeExceptions`' own `meta.datesSuppressed`, the sentence is
 * the helper's, and a read that fails says it could not be checked, never "no changes". The note is on the screen only,
 * as the practice export's is (the export's files carry no note line).
 *
 * One thing is added: the report's practice clash column is computed on the series, so it says nothing of a practice
 * that has moved.
 *
 * @module utils/coachPracticeChanges
 */

/** What the clash column of the coach schedule is computed on. */
export const COACH_PRACTICE_SERIES_SENTENCE =
  'The practice clash column is computed on the weekly series, not on those changes.';

/**
 * The coach's practices as `practiceExportChanges` reads stored rows: an id, the series' date range, its weekday and
 * the organization the exceptions are read by.
 *
 * @param {Array<import('@squadlogic/core/reports/practiceClash.js').ReportPractice>} practices
 * @param {string} organizationId
 */
export function coachPracticeHelperRows(practices, organizationId) {
  return practices.map((practice) => ({
    id: practice.id,
    organizationId,
    effectiveDateRange: practice.range ?? null,
    practiceSlots: { dayOfWeek: practice.dayOfWeek ?? null },
  }));
}

/**
 * Read the exceptions of the organization and count the coach's practices they change. Never throws.
 *
 * @param {any} client
 * @param {Array<import('@squadlogic/core/reports/practiceClash.js').ReportPractice>} practices
 * @param {string} organizationId
 * @returns {Promise<{ ok: true, count: number } | { ok: false }>}
 */
export function readCoachPracticeChanges(client, practices, organizationId) {
  return readUnshownPracticeChanges(client, coachPracticeHelperRows(practices, organizationId));
}

/**
 * The lines the coach report says about practice changes: none when there are none, the helper's sentence and the
 * series sentence for a count, and the helper's own unread text (with the table) when the exceptions could not be read.
 *
 * @param {{ ok: true, count: number } | { ok: false } | null} result - `null` before a read has answered
 * @returns {string[]}
 */
export function coachPracticeChangesLines(result) {
  if (result === null) return ['Practice changes: not checked yet.'];
  const note = practiceChangesNoteOf(result);
  if (note === null) return [];
  const sentence = result.ok
    ? note
    : `${EXPORT_PRACTICE_CHANGES_UNREAD_TEXT} The read of practice_exceptions failed.`;
  return [sentence, COACH_PRACTICE_SERIES_SENTENCE];
}
