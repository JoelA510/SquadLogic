/**
 * What a parsed schedule row becomes in `staging_import_rows` (plan `docs/changes/2026-11-03-schedule-expansion.md` 4.2,
 * step 3; PR 5, which fixes the contract, and PR 6, whose Edge function writes it).
 *
 * The SQL (`apply_game_import_job`, migration `20261121010000`) is the one reader of a staged row, and it reads exactly
 * the keys of `GAME_IMPORT_KEYS` (`frontend/src/utils/importAllowlist.js` and its Edge twin;
 * `tests/importAllowlistParity.test.js` holds the list equal to what the SQL reads). This module is where a
 * {@link import('./parseRows.js').ParsedScheduleRow} becomes those keys, so the browser's preview, the Edge function and
 * the mock all stage the same row, and the instants it carries are the parse's: the SQL never recomputes a time.
 *
 * - A row the parse refused is staged with NO payload and its reason in `validation_errors` (`code`, `message`): the
 *   apply lists it and writes nothing for it.
 * - A row it accepted is staged with `status` `ok` (placed) or `tbd` (no time, no field, or a time that could not be
 *   read: a TIME TBD game), the date, the week, the flags the SQL knows (`SCHEDULE_IMPORT_STAGED_FLAGS`), the labels as typed and, beside each label, the decision key the mapping step stores its
 *   decision under (`mapping.js`'s `*DecisionKey`): the one normaliser stays in JavaScript, so the SQL matches keys by
 *   equality and never normalises a label. An `ok` row carries its wall readings and instants; **a `tbd` row carries
 *   none**: a TIME TBD game has no place in time, and the parse assigns the instants of a row that has a time and no
 *   field before it knows the field is blank, so they are dropped here (the SQL's shape check refuses a `tbd` row that
 *   holds an instant, and one such row would otherwise refuse the whole apply).
 *
 * Nothing else of the file is staged (a format, a note, a coach, an email, a phone): the parse never read it.
 */

import {
  divisionDecisionKey,
  fieldDecisionKey,
  scheduleLabelKey,
  teamDecisionKey,
  venueDecisionKey,
} from './mapping.js';
import { SCHEDULE_IMPORT_COLUMNS, parseScheduleRows } from './parseRows.js';
import { SCHEDULE_IMPORT_STAGED_FLAGS } from './reasonCodes.js';

/** The staged flags as plain text, for a membership test of any code. */
const STAGED_FLAGS = /** @type {readonly string[]} */ (SCHEDULE_IMPORT_STAGED_FLAGS);

/** The keys of a staged games row, in the order the allowlist lists them. */
export const GAME_STAGED_KEYS = Object.freeze([
  'row_key',
  'game_id',
  'status',
  'tbd_reason',
  'date',
  'start_time',
  'end_time',
  'start',
  'end',
  'week_index',
  'flags',
  'division',
  'division_key',
  'venue',
  'venue_key',
  'field',
  'field_key',
  'home_team',
  'home_key',
  'away_team',
  'away_key',
]);

/**
 * One parsed row as a `staging_import_rows` insert: the row number, the normalized payload (null for a refused row) and
 * the validation errors.
 *
 * @param {import('./parseRows.js').ParsedScheduleRow} row
 * @returns {{ source_row_number: number, normalized_payload: Record<string, unknown> | null,
 *   validation_errors: Array<{ code: string, message: string }> }}
 */
export function toStagedGameRow(row) {
  if (row.status === 'refused') {
    return {
      source_row_number: row.rowNumber,
      normalized_payload: null,
      validation_errors: [{ code: String(row.reason), message: String(row.message ?? '') }],
    };
  }
  const placed = row.status === 'ok';
  return {
    source_row_number: row.rowNumber,
    normalized_payload: {
      row_key: row.rowKey,
      game_id: row.gameId,
      status: row.status,
      tbd_reason: placed ? null : row.tbdReason,
      date: row.date,
      start_time: placed ? row.startTime : null,
      end_time: placed ? row.endTime : null,
      start: placed ? row.start : null,
      end: placed ? row.end : null,
      week_index: row.weekIndex,
      // Only the flags the SQL knows (a staged row that carried another would refuse the whole apply).
      // Since 20261122010000 that includes the parse's own warnings, `bad-time` and `bad-week`.
      flags: row.flags.map((flag) => flag.code).filter((code) => STAGED_FLAGS.includes(code)),
      division: row.divisionLabel,
      division_key: divisionDecisionKey(row.divisionLabel),
      venue: row.venueLabel,
      venue_key: venueDecisionKey(row.venueLabel),
      field: row.fieldLabel,
      field_key: fieldDecisionKey(row.venueLabel, row.fieldLabel),
      home_team: row.homeLabel,
      home_key: teamDecisionKey(row.divisionLabel, row.homeLabel),
      away_team: row.awayLabel,
      away_key: teamDecisionKey(row.divisionLabel, row.awayLabel),
    },
    validation_errors: [],
  };
}

/** Limits of one request to the Edge function (`import-validation`, `import_type: 'games'`; PR 6). */
export const SCHEDULE_IMPORT_CHUNK_LIMITS = Object.freeze({
  /** The browser sends a file in chunks of at most this many rows (a request gets 2 s of CPU, lesson 42). */
  MAX_CHUNK_ROWS: 500,
  /** A cell longer than this is cut before it is read (no label of a schedule is this long). */
  MAX_CELL_LENGTH: 500,
  MAX_HEADERS: 200,
});

/**
 * One request's rows, read and made ready to stage: what the Edge function does with a chunk of a games file
 * (`supabase/functions/_shared/schedule-import.ts` is the copy it runs; `tests/gameImportEdgeParity.test.js` holds the
 * two equal). The mock's `import-validation` runs this one.
 *
 * The allowlist comes first: only the columns of plan 4.3 are kept (by the header's normalised name), each cell is
 * cleaned by the caller's cleaner (the import pipeline's one cleaner of a cell: `sanitizeImportText`, which the Edge
 * function and the browser each hold a copy of, held equal by `tests/importRowsParity.test.js`; core holds none), and
 * everything else of the row is dropped before the parse sees it. `raw_payload` is those same columns as
 * typed, under the template's names; nothing else of the file is staged or returned.
 *
 * @param {Object} input
 * @param {unknown[]} input.headers
 * @param {Array<Record<string, unknown>>} input.rows
 * @param {{ timeZone?: string | null, startDate?: string | null, endDate?: string | null } | null} input.season
 * @param {number} input.rowOffset  how many rows of the file came before these
 * @param {(value: unknown, maxLength: number) => string} input.clean  a cell as text with no markup or control
 *   characters, cut to `maxLength`
 * @returns {{
 *   refusal: { code: string, message: string, column?: string } | null,
 *   staged: Array<ReturnType<typeof toStagedGameRow> & { raw_payload: Record<string, string> }>,
 *   summary: { rows: number, ok: number, tbd: number, refused: number, flagged: number,
 *     by_reason: Record<string, number>, dropped_columns: string[],
 *     warnings: Array<{ row: number, code: string, message: string }>,
 *     refused_rows: Array<{ row: number, code: string, message: string }> },
 * }}
 */
export function stageScheduleChunk({ headers, rows, season, rowOffset, clean }) {
  if (typeof clean !== 'function') {
    throw new TypeError('stageScheduleChunk: clean must be the cell cleaner (sanitizeImportText)');
  }
  /** @param {unknown} value */
  const cleanCell = (value) => clean(value, SCHEDULE_IMPORT_CHUNK_LIMITS.MAX_CELL_LENGTH);
  const byKey = new Map(
    Object.values(SCHEDULE_IMPORT_COLUMNS).map((name) => [scheduleLabelKey(name), name])
  );
  // The header row as the file wrote it, cut to what a header can be; names the allowlist does not hold stay in the
  // list (so the parse can report them as dropped) and their VALUES are never read.
  // A VALUE is read by the header as the file wrote it (the row is keyed by that); the cleaned name only says which
  // column it is. Reading by the cleaned name lost every value of a column whose header had a stray space.
  const named = headers
    .slice(0, SCHEDULE_IMPORT_CHUNK_LIMITS.MAX_HEADERS)
    .map((h) => ({ original: String(h ?? ''), cleaned: cleanCell(h) }))
    .filter((h) => h.cleaned.trim() !== '');
  const fileHeaders = named.map((h) => h.cleaned);
  const keptNames = named.filter((h) => byKey.has(scheduleLabelKey(h.cleaned)));
  const kept = keptNames.map((h) => h.cleaned);
  const allowlisted = rows.map((row) => {
    /** @type {Record<string, string>} */
    const out = {};
    // Two headers that clean to one name are refused by the parse (`duplicate-column`), so which value stands here
    // is never read.
    for (const h of keptNames) out[h.cleaned] = cleanCell(row?.[h.original]);
    return out;
  });
  const parsed = parseScheduleRows({ headers: fileHeaders, rows: allowlisted, season, rowOffset });
  const empty = {
    rows: 0,
    ok: 0,
    tbd: 0,
    refused: 0,
    flagged: 0,
    by_reason: {},
    dropped_columns: [],
    warnings: [],
    refused_rows: [],
  };
  if (!parsed.ok) return { refusal: parsed.refusal, staged: [], summary: empty };
  const staged = parsed.rows.map((row, i) => {
    /** @type {Record<string, string>} */
    const raw = {};
    for (const h of kept)
      raw[/** @type {string} */ (byKey.get(scheduleLabelKey(h)))] = allowlisted[i][h];
    return { ...toStagedGameRow(row), raw_payload: raw };
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
 * A staged row back as the mapping step takes a parsed one: the inverse of {@link toStagedGameRow} for what the mapping
 * reads. The mapping screen and the mock's apply both read the STAGED rows through this one function, so what the admin
 * maps is what was staged (the writer's output), never a second reading of the file.
 *
 * A staged flag comes back as its code only (the sentence was the upload's). A refused row comes back with its reason.
 *
 * @param {{ source_row_number: number, normalized_payload: Record<string, any> | null,
 *   validation_errors?: Array<{ code?: string, message?: string }> | null }} staged
 * @returns {Record<string, any>}
 */
export function stagedRowToParsed(staged) {
  const p = staged.normalized_payload;
  if (!p || (staged.validation_errors || []).length > 0) {
    const e = (staged.validation_errors || [])[0] ?? {};
    return {
      rowNumber: staged.source_row_number,
      rowKey: `row-${staged.source_row_number}`,
      status: 'refused',
      reason: e.code ?? null,
      message: e.message ?? null,
      flags: [],
    };
  }
  return {
    rowNumber: staged.source_row_number,
    rowKey: p.row_key,
    gameId: p.game_id ?? null,
    status: p.status,
    reason: null,
    message: null,
    tbdReason: p.tbd_reason ?? null,
    date: p.date,
    startTime: p.start_time,
    endTime: p.end_time,
    start: p.start,
    end: p.end,
    venueLabel: p.venue ?? '',
    fieldLabel: p.field ?? '',
    divisionLabel: p.division,
    homeLabel: p.home_team,
    awayLabel: p.away_team,
    weekIndex: p.week_index,
    flags: (p.flags || []).map((/** @type {string} */ code) => ({ code })),
  };
}
