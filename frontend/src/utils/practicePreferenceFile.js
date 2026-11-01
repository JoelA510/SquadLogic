/**
 * A practice preference file (import type `practice_preferences`, Phase D C2) as the browser reads
 * it before anything is uploaded: which columns the import keeps, the staged payload of each row, and
 * the rows `import-validation` would refuse. It is the front half of the preview
 * (`practicePreferenceImportPreview.js` is the back half) and it applies, in the same order, the rules
 * the pipeline applies: the allowlist (`importAllowlist.js`), the alias map's canonical key, the Edge
 * function's `sanitizeString` and its email check (`supabase/functions/import-validation/index.ts`).
 *
 * **What the preview says is what the pipeline does.** The same `filterImportRows` runs before the
 * upload (so a column the import does not read never leaves the browser), and the rows it returns here
 * are the rows that are sent: `tests/preferenceImport.test.jsx` holds the staged rows equal to the
 * preview's input.
 */

import { escapeCsvCell } from '@squadlogic/core/csv.js';
import { canonicalImportKey, filterImportRows, isAllowedImportKey } from './importAllowlist.js';
import { normalizeImportRow } from './importRows.js';

export const PREFERENCE_IMPORT_TYPE = 'practice_preferences';

const MAX_STRING_LENGTH = 500;
/** The Edge function's email check, for a coach email (`validateRow`). */
const EMAIL_PATTERN = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

/**
 * The Edge function's `sanitizeString`: tags and control characters out, trimmed, capped. The mock
 * client's cleaner is simpler; the real function is the one a preview should promise.
 * @param {unknown} value
 * @returns {string}
 */
export function sanitizeImportText(value) {
  if (value === null || value === undefined) return '';
  return (
    String(value)
      .replace(/<[^>]*>/g, '')
      // eslint-disable-next-line no-control-regex -- stripping control characters is the point
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
      .trim()
      .slice(0, MAX_STRING_LENGTH)
  );
}

/**
 * Column names a person can use in the template: each resolves, through the alias map, to a key the
 * import reads. Friendly forms, as the other templates do.
 */
export const PREFERENCE_TEMPLATE = Object.freeze({
  headers: Object.freeze([
    'Coach Email',
    'Team',
    'Request Level',
    'Days',
    'Start Times',
    'Venues',
    'Effective From',
    'Effective Until',
    'Priority',
  ]),
  examples: Object.freeze([
    Object.freeze([
      'coach@example.com',
      'U10 Hawks',
      'must',
      'Tuesday and Thursday',
      '5:00 PM; 6:00 PM',
      'Main Park',
      '',
      '',
      'high',
    ]),
    Object.freeze(['coach@example.com', '', 'prefer', 'Monday', '', '', '2026-09-01', '', '']),
  ]),
  filename: 'squadlogic-practice-preferences-template.csv',
});

/** The template as CSV text (CRLF, formula-safe cells), the form a download writes. */
export function preferenceTemplateCsv() {
  return [PREFERENCE_TEMPLATE.headers, ...PREFERENCE_TEMPLATE.examples]
    .map((row) => row.map(escapeCsvCell).join(','))
    .join('\r\n');
}

/** Save the template in the browser (a UTF-8 BOM so Excel opens it in the right encoding). */
export function downloadPreferenceTemplate() {
  const blob = new Blob(['﻿', preferenceTemplateCsv()], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = PREFERENCE_TEMPLATE.filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/**
 * Read a parsed CSV the way the import does.
 *
 * @param {{ headers: string[], rows: Array<Record<string, unknown>> }} parsed - the file's header row
 *   (after the duplicate-header rename) and its data rows
 * @returns {{
 *   ignoredColumns: string[],
 *   hasEmailColumn: boolean,
 *   hasRuleColumn: boolean,
 *   keptRows: Array<Record<string, unknown>>,
 *   staged: Array<{ row: number, payload: Record<string, string> }>,
 *   refused: Array<{ row: number, message: string }>
 * }} `ignoredColumns` are the headers the import does not read (they are not uploaded);
 *   `keptRows` the file's rows with only the kept columns (what the browser sends); `staged` the
 *   rows `import-validation` would stage (1-based row numbers, counting from the first row under the
 *   header, as `source_row_number` does); `refused` the rows it would refuse, with its message
 */
export function readPreferenceFile({ headers, rows }) {
  const ignoredColumns = headers.filter(
    (header) => !isAllowedImportKey(PREFERENCE_IMPORT_TYPE, canonicalImportKey(header))
  );
  const keptHeaders = new Set(
    headers
      .filter((header) => isAllowedImportKey(PREFERENCE_IMPORT_TYPE, canonicalImportKey(header)))
      .map(canonicalImportKey)
  );
  const hasEmailColumn = keptHeaders.has('email');
  const hasRuleColumn = [
    'weekdays',
    'days',
    'day',
    'start_times',
    'start_time',
    'start',
    'venues',
    'location',
  ].some((key) => keptHeaders.has(key));

  const keptRows = filterImportRows(PREFERENCE_IMPORT_TYPE, rows);
  const staged = [];
  const refused = [];
  keptRows.forEach((rawRow, index) => {
    const row = index + 1;
    const payload = normalizeImportRow(rawRow, canonicalImportKey, sanitizeImportText);
    const email = payload.email ?? '';
    if (email.trim() === '') {
      refused.push({ row, message: 'Missing required field: email' });
    } else if (!EMAIL_PATTERN.test(email)) {
      refused.push({ row, message: 'Invalid email format' });
    } else {
      staged.push({ row, payload });
    }
  });
  return { ignoredColumns, hasEmailColumn, hasRuleColumn, keptRows, staged, refused };
}
