/**
 * What a parsed practice row becomes in `staging_import_rows` (plan `docs/changes/2026-11-03-schedule-expansion.md`
 * 4.11.4; PR 10, which fixes the contract, and PR 11, whose Edge function writes it).
 *
 * The SQL (`apply_practice_import_job`, migration `20261123010000`) is the one reader of a staged row, and it reads
 * exactly the keys of `PRACTICE_SCHEDULE_IMPORT_KEYS` (`frontend/src/utils/importAllowlist.js` and its Edge twin;
 * `tests/importAllowlistParity.test.js` holds the list equal to what the SQL reads). This module is where a
 * {@link import('./parseRows.js').ParsedPracticeRow} becomes those keys, as `scheduleImport/staging.js` is for games:
 *
 * - A row the parse refused is staged with NO payload and its reason in `validation_errors` (`code`, `message`): the
 *   apply lists it and writes nothing for it.
 * - A row it accepted is staged with its `status` (`placement`, `open` or `hold`), the weekday, the wall times, the
 *   two dates the parse settled on (the row's, the confirm step's or the season's: decision 25), the capacity, the
 *   flags the SQL knows (`PRACTICE_STAGED_FLAGS`), the labels as typed and, beside each label, the decision key the
 *   mapping step stores its decision under (`mapping.js`'s `practice*DecisionKey`). The one normaliser stays in
 *   JavaScript, so the SQL matches keys by equality and never normalises a label. A blank `Subunit` (the whole field)
 *   has an empty key, never the key of a blank label; an open slot and a hold have no team.
 *
 * Nothing else of the file is staged (a coach, an email, a phone, a note): the parse never read it.
 */

import {
  practiceDivisionDecisionKey,
  practiceFieldDecisionKey,
  practiceLocationDecisionKey,
  practiceSubunitDecisionKey,
  practiceTeamDecisionKey,
} from './mapping.js';
import {
  PRACTICE_IMPORT_COLUMNS,
  PRACTICE_IMPORT_HEADER_ALIASES,
  parsePracticeRows,
  practiceImportReadsHeader,
} from './parseRows.js';
import { PRACTICE_IMPORT_LIMITS, PRACTICE_IMPORT_REASON as R } from './reasonCodes.js';
import { practiceLabelKey } from './slotKey.js';

/** The keys of a staged practice row, in the order the allowlist lists them. */
export const PRACTICE_STAGED_KEYS = Object.freeze([
  'row_key',
  'status',
  'day',
  'start_time',
  'end_time',
  'valid_from',
  'valid_until',
  'capacity',
  'flags',
  'division',
  'division_key',
  'location',
  'location_key',
  'field',
  'field_key',
  'subunit',
  'subunit_key',
  'team',
  'team_key',
]);

/**
 * The parse's flags the SQL carries through to the result. The other flags are judged by the SQL itself from the
 * rows it writes (`team-on-both-halves`, `hold-over-open-slot` and the database's six), so a re-import reports them.
 * @type {readonly string[]}
 */
export const PRACTICE_STAGED_FLAGS = Object.freeze([R.DIVISION_NOT_RESERVED]);

/**
 * One parsed row as a `staging_import_rows` insert: the row number, the normalized payload (null for a refused row) and
 * the validation errors.
 *
 * @param {import('./parseRows.js').ParsedPracticeRow} row
 * @returns {{ source_row_number: number, normalized_payload: Record<string, unknown> | null,
 *   validation_errors: Array<{ code: string, message: string }> }}
 */
export function toStagedPracticeRow(row) {
  if (row.status === 'refused') {
    return {
      source_row_number: row.rowNumber,
      normalized_payload: null,
      validation_errors: [{ code: String(row.reason), message: String(row.message ?? '') }],
    };
  }
  const placement = row.status === 'placement';
  const subunit = practiceLabelKey(row.subunitLabel ?? '') === '' ? '' : row.subunitLabel.trim();
  return {
    source_row_number: row.rowNumber,
    normalized_payload: {
      row_key: row.rowKey,
      status: row.status,
      day: row.day,
      start_time: row.startTime,
      end_time: row.endTime,
      valid_from: row.validFrom,
      valid_until: row.validUntil,
      capacity: row.capacity,
      flags: row.flags
        .map((flag) => flag.code)
        .filter((code) => PRACTICE_STAGED_FLAGS.includes(code)),
      division: (row.divisionLabel ?? '').trim(),
      division_key: placement ? practiceDivisionDecisionKey(row.divisionLabel) : '',
      location: row.locationLabel.trim(),
      location_key: practiceLocationDecisionKey(row.locationLabel),
      field: row.fieldLabel.trim(),
      field_key: practiceFieldDecisionKey(row.locationLabel, row.fieldLabel),
      subunit,
      subunit_key:
        subunit === ''
          ? ''
          : practiceSubunitDecisionKey(row.locationLabel, row.fieldLabel, row.subunitLabel),
      team: placement ? row.teamLabel.trim() : '',
      team_key: placement ? practiceTeamDecisionKey(row.divisionLabel, row.teamLabel) : '',
    },
    validation_errors: [],
  };
}

/**
 * Limits of one staging request (PR 11, task L1). **The whole file is one request**, not chunks of 500 as the games file
 * is: the practice parse judges the file as a whole (`team-in-two-divisions` and `duplicate-row` compare every row with
 * every other, and a row key must be unique in the file, which the SQL's shape check requires), and it converts no
 * instant, so 2,400 rows are a few milliseconds of CPU (`tests/practiceImportEdgeParity.test.js` times the whole cap
 * with coverage on; lesson 59). The cell and header limits are the games file's own numbers.
 */
export const PRACTICE_IMPORT_STAGE_LIMITS = Object.freeze({
  MAX_ROWS: PRACTICE_IMPORT_LIMITS.MAX_ROWS,
  MAX_CELL_LENGTH: 500,
  MAX_HEADERS: PRACTICE_IMPORT_LIMITS.MAX_COLUMNS,
});

/**
 * A practice file as the Edge function stages it (PR 11, task L1), and as the mock's `import-validation` does: the
 * headers and the cells cleaned by the pipeline's one cleaner, every column the parse does not read dropped before a
 * value is read from it, the file parsed whole, and each row as its `staging_import_rows` insert with the raw cells it
 * was read from (the read columns only, under their canonical names). `supabase/functions/_shared/practice-import.ts`
 * is the Edge copy; `tests/practiceImportEdgeParity.test.js` holds the two equal.
 *
 * @param {Object} input
 * @param {unknown[]} input.headers  the header row as the file wrote it
 * @param {Array<Record<string, unknown>>} input.rows  keyed by those headers
 * @param {{ startDate?: string | null, endDate?: string | null } | null} [input.season]
 * @param {{ validFrom?: string | null, validUntil?: string | null } | null} [input.dates]  the confirm step's two dates
 * @param {(value: unknown, max: number) => string} input.clean  `sanitizeImportText`
 * @returns {{ refusal: { code: string, message: string, column?: string } | null,
 *   staged: Array<ReturnType<typeof toStagedPracticeRow> & { raw_payload: Record<string, string> }>,
 *   summary: { rows: number, placements: number, open: number, holds: number, refused: number, flagged: number,
 *     by_reason: Record<string, number>, dropped_columns: string[],
 *     warnings: Array<{ row: number, code: string, message: string }>,
 *     refused_rows: Array<{ row: number, code: string, message: string }> } }}
 */
export function stagePracticeFile({ headers, rows, season, dates, clean }) {
  if (typeof clean !== 'function') {
    throw new TypeError('stagePracticeFile: clean must be the cell cleaner (sanitizeImportText)');
  }
  if (!Array.isArray(headers)) throw new TypeError('stagePracticeFile: headers must be an array');
  if (!Array.isArray(rows)) throw new TypeError('stagePracticeFile: rows must be an array');
  /** @param {unknown} value */
  const cleanCell = (value) => clean(value, PRACTICE_IMPORT_STAGE_LIMITS.MAX_CELL_LENGTH);
  // A value is read by the header as the file wrote it (the row is keyed by that); the cleaned name says which column.
  // Every header is read: a file with more than the cap is refused by the parse, never cut (a column the import reads
  // past the cap would be dropped while its values stayed).
  const named = headers
    .map((h) => ({ original: String(h ?? ''), cleaned: cleanCell(h) }))
    .filter((h) => h.cleaned.trim() !== '');
  const fileHeaders = named.map((h) => h.cleaned);
  const keptNames = named.filter((h) => practiceImportReadsHeader(h.cleaned));
  // Each kept header's canonical column, worked out once (not once per row).
  const keptColumns = keptNames.map((h) => {
    const key = practiceLabelKey(h.cleaned);
    const column =
      Object.values(PRACTICE_IMPORT_COLUMNS).find((name) => practiceLabelKey(name) === key) ??
      PRACTICE_IMPORT_HEADER_ALIASES[key];
    return { cleaned: h.cleaned, column };
  });
  const allowlisted = rows.map((row) => {
    /** @type {Record<string, string>} */
    const out = {};
    for (const h of keptNames) out[h.cleaned] = cleanCell(row?.[h.original]);
    return out;
  });
  const empty = {
    rows: 0,
    placements: 0,
    open: 0,
    holds: 0,
    refused: 0,
    flagged: 0,
    by_reason: {},
    dropped_columns: [],
    warnings: [],
    refused_rows: [],
  };
  const parsed = parsePracticeRows({ headers: fileHeaders, rows: allowlisted, season, dates });
  if (!parsed.ok) return { refusal: parsed.refusal, staged: [], summary: empty };
  const staged = parsed.rows.map((row, i) => {
    /** @type {Record<string, string>} */
    const raw = {};
    for (const h of keptColumns) raw[h.column] = allowlisted[i][h.cleaned];
    return { ...toStagedPracticeRow(row), raw_payload: raw };
  });
  return {
    refusal: null,
    staged,
    summary: {
      ...parsed.counts,
      by_reason: parsed.byReason,
      dropped_columns: parsed.droppedColumns,
      warnings: parsed.rows.flatMap((row) =>
        row.status === 'refused'
          ? []
          : row.flags.map((flag) => ({
              row: row.rowNumber,
              code: flag.code,
              message: flag.message,
            }))
      ),
      refused_rows: parsed.rows
        .filter((row) => row.status === 'refused')
        .map((row) => ({
          row: row.rowNumber,
          code: String(row.reason),
          message: String(row.message ?? ''),
        })),
    },
  };
}

/**
 * A staged practice row back as the mapping step takes a parsed one: the inverse of {@link toStagedPracticeRow} for
 * what `mapping.js` reads. The mapping screen reads the STAGED rows through this (what the Edge function wrote), never
 * the browser's own reading of the file. A staged flag comes back as its code only; a refused row with its reason.
 *
 * @param {{ source_row_number: number, normalized_payload: Record<string, any> | null,
 *   validation_errors?: Array<{ code?: string, message?: string }> | null }} staged
 * @returns {import('./parseRows.js').ParsedPracticeRow}
 */
export function stagedPracticeRowToParsed(staged) {
  const p = staged.normalized_payload;
  const n = Number(staged.source_row_number);
  if (!p || (staged.validation_errors || []).length > 0) {
    const e = (staged.validation_errors || [])[0] ?? {};
    return {
      rowNumber: n,
      rowKey: `row-${n}`,
      status: 'refused',
      reason: e.code ?? null,
      message: e.message ?? null,
      teamLabel: '',
      divisionLabel: '',
      day: null,
      startTime: null,
      endTime: null,
      locationLabel: '',
      fieldLabel: '',
      subunitLabel: '',
      capacity: null,
      validFrom: null,
      validUntil: null,
      dateSources: null,
      flags: [],
    };
  }
  return {
    rowNumber: n,
    rowKey: String(p.row_key),
    status: p.status,
    reason: null,
    message: null,
    teamLabel: String(p.team ?? ''),
    divisionLabel: String(p.division ?? ''),
    day: p.day,
    startTime: p.start_time,
    endTime: p.end_time,
    locationLabel: String(p.location ?? ''),
    fieldLabel: String(p.field ?? ''),
    subunitLabel: String(p.subunit ?? ''),
    capacity: p.capacity ?? null,
    validFrom: p.valid_from,
    validUntil: p.valid_until,
    dateSources: null,
    flags: (p.flags || []).map((/** @type {string} */ code) => ({
      code,
      message: '',
      details: {},
    })),
  };
}
