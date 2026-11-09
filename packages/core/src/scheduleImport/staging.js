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
 * - A row it accepted is staged with `status` `ok` (placed) or `tbd` (no time or no field: a TIME TBD game), the wall
 *   readings and instants, the week, the flags, the labels as typed and, beside each label, the decision key the mapping
 *   step stores its decision under (`mapping.js`'s `*DecisionKey`): the one normaliser stays in JavaScript, so the SQL
 *   matches keys by equality and never normalises a label.
 *
 * Nothing else of the file is staged (a format, a note, a coach, an email, a phone): the parse never read it.
 */

import {
  divisionDecisionKey,
  fieldDecisionKey,
  teamDecisionKey,
  venueDecisionKey,
} from './mapping.js';

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
      start_time: row.startTime,
      end_time: row.endTime,
      start: row.start,
      end: row.end,
      week_index: row.weekIndex,
      flags: row.flags.map((flag) => flag.code),
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
