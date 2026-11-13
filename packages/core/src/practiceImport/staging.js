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
import { PRACTICE_IMPORT_REASON as R } from './reasonCodes.js';
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
      flags: row.flags.map((flag) => flag.code).filter((code) => PRACTICE_STAGED_FLAGS.includes(code)),
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
