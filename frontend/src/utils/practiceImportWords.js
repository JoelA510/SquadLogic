/**
 * The practice import's codes and the database's sentences, in words for the Practices tab (PR 11).
 */
import {
  describePracticeImportReason,
  PRACTICE_IMPORT_REASON,
} from '@squadlogic/core/practiceImport/reasonCodes.js';

/** @type {Set<string>} */
const KNOWN = new Set(Object.values(PRACTICE_IMPORT_REASON));

/**
 * A reason or flag code in words. A code this build has no words for (a newer database's) is shown as it is, never
 * hidden; it is the one case not described, and nothing is caught: any other failure is thrown.
 *
 * @param {unknown} code
 * @returns {string}
 */
export function practiceImportWords(code) {
  if (typeof code !== 'string' || !KNOWN.has(code)) return String(code);
  return describePracticeImportReason(code);
}

/**
 * The database's own sentence with a record id taken out: an id is not words to an admin.
 *
 * @param {unknown} text
 * @returns {string}
 */
export const readablePracticeDetail = (text) =>
  String(text ?? '')
    .replace(/\s*\([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\)/gi, '')
    .trim();
