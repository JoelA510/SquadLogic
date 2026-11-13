/**
 * The closed lists of the practice import (plan `docs/changes/2026-11-03-schedule-expansion.md`,
 * sections 4.11.2 to 4.11.6): what refuses a file, what lists a row without writing it, what is
 * accepted and flagged. The conventions are `scheduleImport/reasonCodes.js`'s (PR 4): `code` is the
 * contract and the sentence is decoration; the Edge function (PR 11), the SQL (PR 10) and the preview all
 * branch on the code, so a code is added here and in each of them together (lesson 73).
 *
 * ## What the plan lists, and what this build added
 *
 * Plan 4.11.4 names two file reasons, seventeen row reasons and nine flags. Building the parse and the
 * alias file needed these, each for an input the plan's lists have no word for. They are here, so they
 * are reviewed, rather than reported as a reason that does not exist:
 *
 * - `duplicate-column`: two columns of one name (`Location` and `Venue`). Reading either is a guess.
 *   (The games import added the same one.)
 * - `bad-use`: a `Use` cell that is not blank or `hold`, or a `hold` row that names a team. The plan
 *   makes `Use` "a closed value, never free text"; this is what the closed value does with anything else.
 * - `bad-capacity`: a `Capacity` that is not a whole number `practice_slots.capacity` (a smallint) can
 *   hold. `capacity-not-positive` is the plan's, and keeps the whole numbers below 1.
 * - `blank-alias`, `alias-conflict`: the alias file's own row reasons (plan 4.11.5 names the file and its
 *   columns, not its refusals). The other reasons an alias row can have are the mapping's.
 * - `division-not-reserved`: a `Division` on a row that has no team. In the fields CSV that cell
 *   reserves a slot for a division; here it names a team's division, and this import never writes a
 *   reservation (plan 4.11.2). The cell is not read as one, and not dropped in silence: the row stays
 *   and is flagged.
 *
 * ## What this module judges, and what it leaves to the database
 *
 * Three of the flags are judged here, from the rows the file names: `team-on-both-halves`,
 * `hold-over-open-slot` (against the slots of the same file) and `division-not-reserved`. The other six
 * (`capacity`, `reservation`, `length`, `weekday`, `count`, `coach-conflict`) are read by SQL from the
 * rows an apply inserts, so that a re-import reports the same flags (plan 4.11.4); they are in this
 * table so that PR 10 and PR 11 branch on one spelling, and **nothing here computes them**
 * (AGENTS.md section 3: declared, not enforced). `pairing-differs` joins them when PR 12 exists.
 * `tests/practiceImportParse.test.js` pins the split.
 */

import { SCHEDULE_IMPORT_LIMITS } from '../scheduleImport/reasonCodes.js';

/** Every code of the import, by name. */
export const PRACTICE_IMPORT_REASON = Object.freeze({
  // The file is refused; nothing is staged.
  MISSING_COLUMN: 'missing-column',
  DUPLICATE_COLUMN: 'duplicate-column',
  TOO_MANY_ROWS: 'too-many-rows',

  // A row is listed with its reason and not written; the rest of the file imports.
  BAD_USE: 'bad-use',
  BAD_DAY: 'bad-day',
  BAD_TIME: 'bad-time',
  BAD_LENGTH: 'bad-length',
  END_NOT_AFTER_START: 'end-not-after-start',
  BAD_CAPACITY: 'bad-capacity',
  CAPACITY_NOT_POSITIVE: 'capacity-not-positive',
  BAD_DATE: 'bad-date',
  VALID_UNTIL_BEFORE_FROM: 'valid-until-before-from',
  OUTSIDE_SEASON_WINDOW: 'outside-season-window',
  MISSING_DATES: 'missing-dates',
  UNKNOWN_DIVISION: 'unknown-division',
  UNKNOWN_TEAM: 'unknown-team',
  UNKNOWN_LOCATION: 'unknown-location',
  UNKNOWN_FIELD: 'unknown-field',
  UNKNOWN_SUBUNIT: 'unknown-subunit',
  TEAM_IN_TWO_DIVISIONS: 'team-in-two-divisions',
  SLOT_OVERLAPS_ANOTHER: 'slot-overlaps-another',
  DUPLICATE_ROW: 'duplicate-row',

  // A row is listed and not written, judged by the database (PR 10): the slot the row names is saved already with
  // another End, Capacity or Valid Until, and a saved slot is never changed by an import.
  SLOT_DIFFERS: 'slot-differs',

  // A row of the alias file is listed and not read.
  BLANK_ALIAS: 'blank-alias',
  ALIAS_CONFLICT: 'alias-conflict',

  // Accepted and flagged, judged here.
  TEAM_ON_BOTH_HALVES: 'team-on-both-halves',
  HOLD_OVER_OPEN_SLOT: 'hold-over-open-slot',
  DIVISION_NOT_RESERVED: 'division-not-reserved',

  // Accepted and flagged, judged by the database (PR 10); declared here and computed nowhere in core.
  CAPACITY: 'capacity',
  RESERVATION: 'reservation',
  LENGTH: 'length',
  WEEKDAY: 'weekday',
  COUNT: 'count',
  COACH_CONFLICT: 'coach-conflict',
});

const R = PRACTICE_IMPORT_REASON;

/** Reasons that refuse the whole file.
 * @type {readonly string[]}
 */
export const PRACTICE_IMPORT_FILE_REFUSALS = Object.freeze([
  R.MISSING_COLUMN,
  R.DUPLICATE_COLUMN,
  R.TOO_MANY_ROWS,
]);

/** Reasons a single row is listed and not written.
 * @type {readonly string[]}
 */
export const PRACTICE_IMPORT_ROW_REFUSALS = Object.freeze([
  R.BAD_USE,
  R.BAD_DAY,
  R.BAD_TIME,
  R.BAD_LENGTH,
  R.END_NOT_AFTER_START,
  R.BAD_CAPACITY,
  R.CAPACITY_NOT_POSITIVE,
  R.BAD_DATE,
  R.VALID_UNTIL_BEFORE_FROM,
  R.OUTSIDE_SEASON_WINDOW,
  R.MISSING_DATES,
  R.UNKNOWN_DIVISION,
  R.UNKNOWN_TEAM,
  R.UNKNOWN_LOCATION,
  R.UNKNOWN_FIELD,
  R.UNKNOWN_SUBUNIT,
  R.TEAM_IN_TWO_DIVISIONS,
  R.SLOT_OVERLAPS_ANOTHER,
  R.DUPLICATE_ROW,
]);

/**
 * Reasons a row is listed and not written that only the database can judge (PR 10): declared here so the screen has
 * words for them; nothing in core produces them.
 * @type {readonly string[]}
 */
export const PRACTICE_IMPORT_DATABASE_ROW_REFUSALS = Object.freeze([R.SLOT_DIFFERS]);

/** Reasons a row of the alias file is listed and not read (the mapping's own reasons are shared).
 * @type {readonly string[]}
 */
export const PRACTICE_IMPORT_ALIAS_REFUSALS = Object.freeze([
  R.BLANK_ALIAS,
  R.ALIAS_CONFLICT,
  R.UNKNOWN_LOCATION,
  R.UNKNOWN_FIELD,
  R.UNKNOWN_SUBUNIT,
  R.DUPLICATE_ROW,
]);

/** Flags this module judges, from the rows the file names.
 * @type {readonly string[]}
 */
export const PRACTICE_IMPORT_FILE_FLAGS = Object.freeze([
  R.TEAM_ON_BOTH_HALVES,
  R.HOLD_OVER_OPEN_SLOT,
  R.DIVISION_NOT_RESERVED,
]);

/**
 * Flags the database judges (PR 10), by the five rules of `practice_new_auto_row_refusals` and the
 * coach check. Declared here; computed nowhere in core.
 * @type {readonly string[]}
 */
export const PRACTICE_IMPORT_DATABASE_FLAGS = Object.freeze([
  R.CAPACITY,
  R.RESERVATION,
  R.LENGTH,
  R.WEEKDAY,
  R.COUNT,
  R.COACH_CONFLICT,
]);

/** Every accepted-and-flagged reason.
 * @type {readonly string[]}
 */
export const PRACTICE_IMPORT_FLAGS = Object.freeze([
  ...PRACTICE_IMPORT_FILE_FLAGS,
  ...PRACTICE_IMPORT_DATABASE_FLAGS,
]);

/** Limits of the file (plan 4.11.2 and 4.11.4). */
export const PRACTICE_IMPORT_LIMITS = Object.freeze({
  /** The one cap of the schedule import and this one: not a second number to keep in step. */
  MAX_ROWS: SCHEDULE_IMPORT_LIMITS.MAX_ROWS,
  /** `practice_slots.capacity` is a smallint. */
  MAX_CAPACITY: 32767,
  /**
   * What `admin_upsert_division_settings` accepts (`20261105010000`, lines 1573-1580): 0 to 7 practices a
   * week, and a practice length of 15 to 240 minutes (or none, any slot length). A proposal outside
   * these is shown and never offered as a change.
   */
  MIN_PRACTICES_PER_WEEK: 0,
  MAX_PRACTICES_PER_WEEK: 7,
  MIN_PRACTICE_MINUTES: 15,
  MAX_PRACTICE_MINUTES: 240,
});

const DESCRIPTIONS = Object.freeze({
  [R.MISSING_COLUMN]: 'The file is missing a column the import needs.',
  [R.DUPLICATE_COLUMN]: 'The file has the same column twice, so neither can be trusted.',
  [R.TOO_MANY_ROWS]: 'The file has more rows than one import takes.',
  [R.BAD_USE]: 'Use is blank or "hold", and a held cell has no team.',
  [R.BAD_DAY]: 'The day is not Monday to Sunday (Mon to Sun is read too).',
  [R.BAD_TIME]: 'A time is not one the import reads (HH:mm, or h:mm AM or PM), or there is none.',
  [R.BAD_LENGTH]:
    'The Length is not a whole number of minutes from 1 to 1439, or it disagrees with the End.',
  [R.END_NOT_AFTER_START]: 'The practice does not end after it starts.',
  [R.BAD_CAPACITY]: 'The Capacity is not a whole number the import can store.',
  [R.CAPACITY_NOT_POSITIVE]: 'The Capacity is less than 1.',
  [R.BAD_DATE]: 'A date is not one the import reads (YYYY-MM-DD or M/D/YYYY).',
  [R.VALID_UNTIL_BEFORE_FROM]: 'The Valid Until is before the Valid From.',
  [R.OUTSIDE_SEASON_WINDOW]: 'The dates are outside the season.',
  [R.MISSING_DATES]:
    'There is no date for one end of the practice: not in the row, not chosen, not on the season.',
  [R.UNKNOWN_DIVISION]: 'The division is not one of yours, and nothing says what to do with it.',
  [R.UNKNOWN_TEAM]: 'A team is not one of yours, and nothing says what to do with it.',
  [R.UNKNOWN_LOCATION]: 'The location is not one of yours, and nothing says what to do with it.',
  [R.UNKNOWN_FIELD]: 'The field is not one of the location’s, and nothing says what to do with it.',
  [R.UNKNOWN_SUBUNIT]:
    'The half or side is not one of the field’s, and nothing says what to do with it.',
  [R.TEAM_IN_TWO_DIVISIONS]:
    'The file puts one team label in two divisions, so neither can be trusted.',
  [R.SLOT_OVERLAPS_ANOTHER]:
    'Two slots claim the same ground at overlapping times, or one slot is described two ways.',
  [R.DUPLICATE_ROW]: 'The same practice is already earlier in the file.',
  [R.SLOT_DIFFERS]:
    'The slot is saved already with another end, capacity or last date; an import never changes a saved slot.',
  [R.BLANK_ALIAS]: 'The alias row has no alias.',
  [R.ALIAS_CONFLICT]: 'The same alias names two different grounds, so neither is kept.',
  [R.TEAM_ON_BOTH_HALVES]: 'A team is on both halves of one field at the same time.',
  [R.HOLD_OVER_OPEN_SLOT]: 'A cell held for a non-team activity is also a slot in this file.',
  [R.DIVISION_NOT_RESERVED]:
    'A Division on a row with no team is not a reservation: this import never writes one.',
  [R.CAPACITY]: 'More teams are in a cell than its capacity.',
  [R.RESERVATION]: 'The slot is reserved to another division.',
  [R.LENGTH]: 'The division’s practice length is not the slot’s.',
  [R.WEEKDAY]: 'A team has two practices on one weekday.',
  [R.COUNT]: 'A team has more practices in a week than its division’s count.',
  [R.COACH_CONFLICT]: 'A coach has two teams in overlapping slots on one weekday.',
});

/**
 * A sentence for a code, for a screen that has only the code.
 *
 * @param {string} code
 * @returns {string}
 * @throws {Error} on a code that is not in {@link PRACTICE_IMPORT_REASON}
 */
export function describePracticeImportReason(code) {
  if (typeof code !== 'string' || !Object.hasOwn(DESCRIPTIONS, code)) {
    throw new Error(`practiceImport: "${String(code)}" is not a practice import reason code`);
  }
  return DESCRIPTIONS[code];
}
