/**
 * Reading a practice CSV: days, times, lengths, capacity, dates and the rows (plan
 * `docs/changes/2026-11-03-schedule-expansion.md` sections 4.11.2 to 4.11.6; PR 9, task J2).
 *
 * This is the stage the Edge function (PR 11) mirrors: the allowlist, the structural checks, the
 * values put into their stored forms. Nothing here knows what teams, locations or fields the
 * organization has; that is `mapping.js`.
 *
 * ## Rules, not guesses (and the schedule import's own, shared)
 *
 * - **Dates** are `YYYY-MM-DD` or `M/D/YYYY` (month first), **times** `HH:mm` or `h:mm AM/PM`, a
 *   **Length** whole minutes: `parseScheduleDate`, `parseScheduleTime` and `parseScheduleLength` of
 *   `scheduleImport/parseRows.js`, used, not copied, so the two importers read a date one way.
 *   `13/04/2026` is `bad-date`, never the 13th of April; `12:00 AM` is midnight and `12:30 PM` half past noon.
 * - **There is no clock.** A practice row holds a weekday and wall times and a date range (plan 4.11.6):
 *   the import converts no instant, so a Length is wall-clock minutes from the start, with no
 *   daylight-saving case, and the host's time zone is never read (`tests/practiceImportParse.test.js`
 *   parses the fixture under other `TZ` values).
 * - **A practice that would reach midnight is refused**: no time reads as 24:00 (`parseScheduleTime`,
 *   shared), so the latest end is 23:59, as the schedule import's. An end of `12:00 AM` is not the end
 *   of the day, it is the start of it, and is `end-not-after-start`.
 * - **A blank Team is an open slot**: supply with no team, the capacity the next run fills. **`Use = hold`**
 *   is a cell held for a non-team activity: it makes no slot, and is counted and listed (decision 28).
 *   `Use` is a closed value: anything else is `bad-use`, and a held cell that names a team is too.
 * - **Dates** (decision 25): a row's own `Valid From`/`Valid Until`, else the confirm step's two dates, else
 *   the season's, one end at a time; with no date for an end anywhere the row is `missing-dates`. The
 *   range is not turned into a `daterange` here (PR 10's first test writes the same dates through the
 *   writer and the import and compares the canonical text).
 *
 * ## Only the allowlisted columns are read
 *
 * Anything that is not one of the columns of plan 4.11.2 (a coach, an email, a phone, a note) is dropped
 * before a value is read from it. Its name is reported in `droppedColumns`; its values appear nowhere in
 * the result (AGENTS.md section 2, data minimisation). `Venue` is read as `Location`, `Half` and `Side`
 * as `Subunit`, as the plan says.
 *
 * ## One result, no throw on a bad file
 *
 * A file the import cannot read at all comes back `ok: false` with a `refusal` and no rows. A row it
 * cannot use comes back `status: 'refused'` with its `reason`, and the rest of the file is read.
 */

import {
  parseScheduleDate,
  parseScheduleLength,
  parseScheduleTime,
} from '../scheduleImport/parseRows.js';
import { describeTooManyColumns } from '../scheduleImport/reasonCodes.js';
import { PRACTICE_IMPORT_LIMITS, PRACTICE_IMPORT_REASON as R } from './reasonCodes.js';
import { practiceLabelKey, practiceTuple } from './slotKey.js';

/** The columns of plan 4.11.2, by the name the template uses. */
export const PRACTICE_IMPORT_COLUMNS = Object.freeze({
  TEAM: 'Team',
  DIVISION: 'Division',
  DAY: 'Day',
  START: 'Start',
  END: 'End',
  LENGTH: 'Length',
  LOCATION: 'Location',
  FIELD: 'Field',
  SUBUNIT: 'Subunit',
  VALID_FROM: 'Valid From',
  VALID_UNTIL: 'Valid Until',
  CAPACITY: 'Capacity',
  USE: 'Use',
});
const C = PRACTICE_IMPORT_COLUMNS;

/** The header row of the downloadable template (PR 11): `Length` is the alternative to `End`. */
export const PRACTICE_IMPORT_TEMPLATE_HEADER = Object.freeze([
  C.TEAM,
  C.DIVISION,
  C.DAY,
  C.START,
  C.END,
  C.LOCATION,
  C.FIELD,
  C.SUBUNIT,
  C.VALID_FROM,
  C.VALID_UNTIL,
  C.CAPACITY,
  C.USE,
]);

/**
 * Header names read as another column (plan 4.11.2): `Venue` for `Location`, `Half`/`Side` for `Subunit`, by their
 * label key. Exported for the stage (`staging.js`) and its Edge mirror, which keep only the columns this file reads.
 */
export const PRACTICE_IMPORT_HEADER_ALIASES = Object.freeze({
  [practiceLabelKey('Venue')]: C.LOCATION,
  [practiceLabelKey('Half')]: C.SUBUNIT,
  [practiceLabelKey('Side')]: C.SUBUNIT,
});

/** The label keys of every header the practice parse reads (its columns and their aliases). */
const READ_HEADER_KEYS = new Set([
  ...Object.values(PRACTICE_IMPORT_COLUMNS).map((name) => practiceLabelKey(name)),
  ...Object.keys(PRACTICE_IMPORT_HEADER_ALIASES),
]);

/**
 * Whether the practice parse reads a column of this name (its own name or an alias, any case and spacing). The browser
 * sends only these columns; the stage drops the rest before a value is read.
 *
 * @param {unknown} header
 * @returns {boolean}
 */
export const practiceImportReadsHeader = (header) =>
  READ_HEADER_KEYS.has(practiceLabelKey(String(header ?? '')));

/**
 * The weekday words the SQL day parser reads (`import_text_to_day_of_week`,
 * `20260503070000:52-75`), so one vocabulary serves the fields CSV and this file.
 */
const DAY_WORDS = Object.freeze({
  mon: 'mon',
  monday: 'mon',
  tue: 'tue',
  tues: 'tue',
  tuesday: 'tue',
  wed: 'wed',
  weds: 'wed',
  wednesday: 'wed',
  thu: 'thu',
  thur: 'thu',
  thurs: 'thu',
  thursday: 'thu',
  fri: 'fri',
  friday: 'fri',
  sat: 'sat',
  saturday: 'sat',
  sun: 'sun',
  sunday: 'sun',
});

/**
 * A weekday as the `day_of_week` enum spells it (`mon` to `sun`), or null.
 *
 * @param {unknown} text
 * @returns {string | null}
 */
export function parsePracticeDay(text) {
  if (typeof text !== 'string') return null;
  const word = text.trim().toLowerCase();
  return Object.hasOwn(DAY_WORDS, word) ? DAY_WORDS[word] : null;
}

const pad2 = (n) => String(n).padStart(2, '0');
/** @param {number} total minutes past midnight */
const hhmm = (total) => `${pad2(Math.floor(total / 60))}:${pad2(total % 60)}`;
/** The latest end the import stores, in minutes past midnight (23:59). */
const LATEST_END = 23 * 60 + 59;
const WHOLE_NUMBER = /^-?\d+$/;

/** A value for a message: short, and visibly the file's. @param {string} text */
const quoted = (text) => `"${text.length > 60 ? `${text.slice(0, 57)}...` : text}"`;

/**
 * @typedef {Object} PracticeImportFlag
 * @property {string} code  a `PRACTICE_IMPORT_FLAGS` member
 * @property {string} message
 * @property {Record<string, unknown>} details
 */

/**
 * @typedef {Object} ParsedPracticeRow
 * @property {number} rowNumber  1 for the first row after the header
 * @property {string} rowKey  `row-1`, unique in the file
 * @property {'placement' | 'open' | 'hold' | 'refused'} status
 * @property {string | null} reason  a `PRACTICE_IMPORT_ROW_REFUSALS` member when refused
 * @property {string | null} message
 * @property {string} teamLabel  blank for an open slot or a hold
 * @property {string} divisionLabel
 * @property {string | null} day  `mon` to `sun`
 * @property {string | null} startTime  `HH:mm` wall time
 * @property {string | null} endTime
 * @property {string} locationLabel
 * @property {string} fieldLabel
 * @property {string} subunitLabel  blank for the whole field
 * @property {number | null} capacity  1 when the cell is blank
 * @property {string | null} validFrom  `YYYY-MM-DD`
 * @property {string | null} validUntil
 * @property {{ from: 'row' | 'confirm' | 'season', until: 'row' | 'confirm' | 'season' } | null} dateSources
 * @property {PracticeImportFlag[]} flags
 */

/**
 * @typedef {Object} PracticeImportParseResult
 * @property {boolean} ok  false when the whole file is refused
 * @property {{ code: string, message: string, column?: string } | null} refusal
 * @property {string[]} droppedColumns  names only
 * @property {ParsedPracticeRow[]} rows
 * @property {{ rows: number, placements: number, open: number, holds: number, refused: number, flagged: number }} counts
 * @property {Record<string, number>} byReason  refused rows by reason
 */

const EMPTY_COUNTS = Object.freeze({
  rows: 0,
  placements: 0,
  open: 0,
  holds: 0,
  refused: 0,
  flagged: 0,
});

/**
 * @param {string} code
 * @param {string} message
 * @param {string} [column]
 * @returns {PracticeImportParseResult}
 */
function fileRefusal(code, message, column) {
  return {
    ok: false,
    refusal: column === undefined ? { code, message } : { code, message, column },
    droppedColumns: [],
    rows: [],
    counts: { ...EMPTY_COUNTS },
    byReason: {},
  };
}

/**
 * A date the caller gave (the season's, or the confirm step's) that is not a calendar date. Its own class, so the Edge
 * function and the mock answer exactly this as `bad-date` and let every other error through (PR 11 review).
 */
export class PracticeImportDateError extends TypeError {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'PracticeImportDateError';
  }
}

/**
 * A date that comes from the caller (the season, the confirm step): present and not a date is a defect
 * in the caller, not "no date" (which would turn a rule off in silence).
 */
function callerDate(value, what) {
  if (value === undefined || value === null || value === '') return null;
  const date = parseScheduleDate(value);
  if (date === null) {
    throw new PracticeImportDateError(
      `parsePracticeRows: ${what} must be YYYY-MM-DD, got ${JSON.stringify(value)}`
    );
  }
  return date;
}

/**
 * Read a practice file that a CSV parser has already split into a header row and rows of text.
 *
 * @param {Object} input
 * @param {string[]} input.headers  the header row as read
 * @param {Array<Record<string, unknown>>} input.rows  one object per row, keyed by those headers
 * @param {{ startDate?: string | null, endDate?: string | null } | null} [input.season]
 *   the season's window (`season_settings.season_start`, `season_end`, both nullable)
 * @param {{ validFrom?: string | null, validUntil?: string | null } | null} [input.dates]
 *   the confirm step's two dates (decision 25), which the season's default
 * @returns {PracticeImportParseResult}
 */
export function parsePracticeRows({ headers, rows, season, dates }) {
  if (!Array.isArray(headers)) throw new TypeError('parsePracticeRows: headers must be an array');
  if (!Array.isArray(rows)) throw new TypeError('parsePracticeRows: rows must be an array');
  if (headers.length > PRACTICE_IMPORT_LIMITS.MAX_COLUMNS) {
    return fileRefusal(
      R.TOO_MANY_COLUMNS,
      describeTooManyColumns(headers.length, PRACTICE_IMPORT_LIMITS.MAX_COLUMNS)
    );
  }

  // Columns: match by the shared normaliser (trim, collapse, fold case; a byte-order mark is
  // whitespace to it), drop every name that is not on the list, and refuse a name given twice.
  /** @type {Map<string, string>} canonical name -> the header as it was written */
  const header = new Map();
  /** @type {string[]} */
  const droppedColumns = [];
  const byKey = new Map(Object.values(C).map((name) => [practiceLabelKey(name), name]));
  for (const raw of headers) {
    const written = String(raw ?? '');
    const key = practiceLabelKey(written);
    const canonical =
      byKey.get(key) ??
      (Object.hasOwn(PRACTICE_IMPORT_HEADER_ALIASES, key)
        ? PRACTICE_IMPORT_HEADER_ALIASES[key]
        : undefined);
    if (canonical === undefined) {
      if (written.trim() !== '') droppedColumns.push(written.trim());
      continue;
    }
    if (header.has(canonical)) {
      return fileRefusal(
        R.DUPLICATE_COLUMN,
        `The file has the column "${canonical}" more than once (or two names for it). Remove one and import again.`,
        canonical
      );
    }
    header.set(canonical, written);
  }

  for (const column of [C.DAY, C.START, C.LOCATION, C.FIELD]) {
    if (!header.has(column)) {
      return fileRefusal(
        R.MISSING_COLUMN,
        `The file has no "${column}" column. Add it (the template has it) and import again.`,
        column
      );
    }
  }
  if (!header.has(C.END) && !header.has(C.LENGTH)) {
    return fileRefusal(
      R.MISSING_COLUMN,
      'The file has neither an "End" nor a "Length" column. Add one of them and import again.',
      'End or Length'
    );
  }
  // A Division names the team's division (plan 4.11.2): a file with a Team column needs it.
  if (header.has(C.TEAM) && !header.has(C.DIVISION)) {
    return fileRefusal(
      R.MISSING_COLUMN,
      'The file has a "Team" column but no "Division" column. A team is placed in its division: add it and import again.',
      C.DIVISION
    );
  }

  const seasonStart = callerDate(season?.startDate, 'season.startDate');
  const seasonEnd = callerDate(season?.endDate, 'season.endDate');
  const confirmFrom = callerDate(dates?.validFrom, 'dates.validFrom');
  const confirmUntil = callerDate(dates?.validUntil, 'dates.validUntil');

  if (rows.length > PRACTICE_IMPORT_LIMITS.MAX_ROWS) {
    return fileRefusal(
      R.TOO_MANY_ROWS,
      `The file has ${rows.length.toLocaleString('en-US')} rows; one import takes at most ${PRACTICE_IMPORT_LIMITS.MAX_ROWS.toLocaleString('en-US')}. Split it and import the parts one after the other.`
    );
  }

  /** @param {Record<string, unknown>} row @param {string} column */
  const cell = (row, column) => {
    const written = header.get(column);
    if (written === undefined) return '';
    const value = row?.[written];
    return value === undefined || value === null ? '' : String(value).trim();
  };

  const bounds = { seasonStart, seasonEnd, confirmFrom, confirmUntil };
  const parsed = rows.map((row, index) => parseRow({ row, index, cell, bounds }));
  refuseRepeats(parsed);

  const counts = { rows: parsed.length, placements: 0, open: 0, holds: 0, refused: 0, flagged: 0 };
  /** @type {Record<string, number>} */
  const byReason = {};
  for (const r of parsed) {
    if (r.status === 'placement') counts.placements += 1;
    else if (r.status === 'open') counts.open += 1;
    else if (r.status === 'hold') counts.holds += 1;
    else counts.refused += 1;
    if (r.status !== 'refused' && r.flags.length > 0) counts.flagged += 1;
    if (r.reason !== null) byReason[r.reason] = (byReason[r.reason] ?? 0) + 1;
  }
  return { ok: true, refusal: null, droppedColumns, rows: parsed, counts, byReason };
}

/**
 * One row. The checks run in a fixed order and the first to fail is the row's reason: Use, the day, the
 * times, the capacity, then the dates.
 *
 * @returns {ParsedPracticeRow}
 */
function parseRow({ row, index, cell, bounds }) {
  const rowNumber = index + 1;
  /** @type {ParsedPracticeRow} */
  const out = {
    rowNumber,
    rowKey: `row-${rowNumber}`,
    status: 'placement',
    reason: null,
    message: null,
    teamLabel: cell(row, C.TEAM),
    divisionLabel: cell(row, C.DIVISION),
    day: null,
    startTime: null,
    endTime: null,
    locationLabel: cell(row, C.LOCATION),
    fieldLabel: cell(row, C.FIELD),
    subunitLabel: cell(row, C.SUBUNIT),
    capacity: null,
    validFrom: null,
    validUntil: null,
    dateSources: null,
    flags: [],
  };
  /** @param {string} code @param {string} message */
  const refuse = (code, message) => {
    out.status = 'refused';
    out.reason = code;
    out.message = message;
    out.flags = [];
    return out;
  };

  // 1. Use: blank, or hold (a closed value, never free text)
  const use = cell(row, C.USE).toLowerCase();
  if (use !== '' && use !== 'hold') {
    return refuse(R.BAD_USE, `Use is blank or "hold", not ${quoted(cell(row, C.USE))}.`);
  }
  if (use === 'hold' && out.teamLabel !== '') {
    return refuse(
      R.BAD_USE,
      'A cell held for a non-team activity has no team. Clear the Team, or clear Use.'
    );
  }
  const kind = use === 'hold' ? 'hold' : out.teamLabel === '' ? 'open' : 'placement';
  out.status = kind;

  // 2. Day
  const dayText = cell(row, C.DAY);
  const day = parsePracticeDay(dayText);
  if (day === null) {
    return refuse(
      R.BAD_DAY,
      dayText === ''
        ? 'The day is blank. Use Mon to Sun or the full name.'
        : `${quoted(dayText)} is not a day this import reads. Use Mon to Sun or the full name.`
    );
  }
  out.day = day;

  // 3. Times: wall times, no clock; a Length is minutes from the start
  const startText = cell(row, C.START);
  const endText = cell(row, C.END);
  const lengthText = cell(row, C.LENGTH);
  const startMin = parseScheduleTime(startText);
  if (startMin === null) {
    return refuse(
      R.BAD_TIME,
      startText === ''
        ? 'The start time is blank.'
        : `The start time ${quoted(startText)} is not HH:mm or h:mm AM/PM.`
    );
  }
  const endGiven = endText === '' ? null : parseScheduleTime(endText);
  if (endText !== '' && endGiven === null) {
    return refuse(R.BAD_TIME, `The end time ${quoted(endText)} is not HH:mm or h:mm AM/PM.`);
  }
  const lengthGiven = lengthText === '' ? null : parseScheduleLength(lengthText);
  if (lengthText !== '' && lengthGiven === null) {
    return refuse(
      R.BAD_LENGTH,
      `The length ${quoted(lengthText)} is not a whole number of minutes from 1 to 1439.`
    );
  }
  if (endGiven === null && lengthGiven === null) {
    return refuse(R.BAD_TIME, 'The row has no End and no Length: one of them is needed.');
  }
  let endMin;
  if (endGiven !== null) {
    if (endGiven <= startMin) {
      return refuse(
        R.END_NOT_AFTER_START,
        endGiven === 0
          ? `An end at midnight (${quoted(endText)}) is not an end this import stores: it reads as the start of the day. The latest end is 23:59.`
          : `The practice ends (${hhmm(endGiven)}) at or before it starts (${hhmm(startMin)}).`
      );
    }
    if (lengthGiven !== null && endGiven - startMin !== lengthGiven) {
      return refuse(
        R.BAD_LENGTH,
        `The End and the Length disagree: from ${hhmm(startMin)} to ${hhmm(endGiven)} is ${endGiven - startMin} minutes, not ${lengthGiven}.`
      );
    }
    endMin = endGiven;
  } else {
    endMin = startMin + lengthGiven;
    if (endMin > LATEST_END) {
      return refuse(
        R.END_NOT_AFTER_START,
        'The practice would reach or pass midnight. The latest end this import stores is 23:59.'
      );
    }
  }
  out.startTime = hhmm(startMin);
  out.endTime = hhmm(endMin);

  // 4. Capacity: a whole number from 1 to what a smallint holds; blank is 1
  const capacityText = cell(row, C.CAPACITY);
  if (capacityText === '') {
    out.capacity = 1;
  } else {
    if (!WHOLE_NUMBER.test(capacityText)) {
      return refuse(R.BAD_CAPACITY, `The capacity ${quoted(capacityText)} is not a whole number.`);
    }
    const n = Number(capacityText);
    if (n < 1) {
      return refuse(
        R.CAPACITY_NOT_POSITIVE,
        `The capacity ${quoted(capacityText)} is less than 1.`
      );
    }
    if (n > PRACTICE_IMPORT_LIMITS.MAX_CAPACITY) {
      return refuse(
        R.BAD_CAPACITY,
        `The capacity ${quoted(capacityText)} is more than ${PRACTICE_IMPORT_LIMITS.MAX_CAPACITY} (the most a slot holds).`
      );
    }
    out.capacity = n;
  }

  // 5. Dates: the row's, else the confirm step's, else the season's, one end at a time
  const fromText = cell(row, C.VALID_FROM);
  const untilText = cell(row, C.VALID_UNTIL);
  const fromRow = fromText === '' ? null : parseScheduleDate(fromText);
  if (fromText !== '' && fromRow === null) {
    return refuse(
      R.BAD_DATE,
      `The Valid From ${quoted(fromText)} is not a date this import reads. Use YYYY-MM-DD or M/D/YYYY (month first).`
    );
  }
  const untilRow = untilText === '' ? null : parseScheduleDate(untilText);
  if (untilText !== '' && untilRow === null) {
    return refuse(
      R.BAD_DATE,
      `The Valid Until ${quoted(untilText)} is not a date this import reads. Use YYYY-MM-DD or M/D/YYYY (month first).`
    );
  }
  const from = fromRow ?? bounds.confirmFrom ?? bounds.seasonStart;
  const until = untilRow ?? bounds.confirmUntil ?? bounds.seasonEnd;
  if (from === null || until === null) {
    const lacking = [from === null ? 'Valid From' : null, until === null ? 'Valid Until' : null]
      .filter(Boolean)
      .join(' and ');
    return refuse(
      R.MISSING_DATES,
      `The row has no ${lacking}, the confirm step chose none, and the season has none to use. Fill in the dates, or set the season’s.`
    );
  }
  if (until < from) {
    return refuse(
      R.VALID_UNTIL_BEFORE_FROM,
      `The Valid Until (${until}) is before the Valid From (${from}).`
    );
  }
  if (bounds.seasonStart !== null && from < bounds.seasonStart) {
    return refuse(
      R.OUTSIDE_SEASON_WINDOW,
      `${from} is before the season starts (${bounds.seasonStart}).`
    );
  }
  if (bounds.seasonEnd !== null && until > bounds.seasonEnd) {
    return refuse(
      R.OUTSIDE_SEASON_WINDOW,
      `${until} is after the season ends (${bounds.seasonEnd}).`
    );
  }
  out.validFrom = from;
  out.validUntil = until;
  out.dateSources = {
    from: fromRow !== null ? 'row' : bounds.confirmFrom !== null ? 'confirm' : 'season',
    until: untilRow !== null ? 'row' : bounds.confirmUntil !== null ? 'confirm' : 'season',
  };

  // 2026-11-13 (PR 10 review): a blank ground or a placement's blank Division is the row's own reason here, with the
  // words the mapping step uses, so the staged row is refused alone (the SQL's shape check refuses the WHOLE apply on a
  // staged row with a blank label, and stays as the backstop).
  if (kind === 'placement' && practiceLabelKey(out.divisionLabel) === '') {
    return refuse(R.UNKNOWN_DIVISION, 'The Division is blank.');
  }
  if (practiceLabelKey(out.locationLabel) === '') {
    return refuse(R.UNKNOWN_LOCATION, 'The Location is blank.');
  }
  if (practiceLabelKey(out.fieldLabel) === '') {
    return refuse(R.UNKNOWN_FIELD, 'The Field is blank.');
  }

  // A Division on a row with no team is not a reservation; say so rather than drop it.
  if (kind !== 'placement' && out.divisionLabel !== '') {
    out.flags.push({
      code: R.DIVISION_NOT_RESERVED,
      message:
        'The Division on a row with no team is not read as a reservation: this import never writes one. Set a reservation on Field Management.',
      details: { division: out.divisionLabel },
    });
  }
  return out;
}

/**
 * A team label the file puts in two divisions, and the same practice twice.
 *
 * `team-in-two-divisions` is plan 4.11.4's reason, and a conservative one. The database would allow two
 * teams of one name in two divisions (`UNIQUE (division_id, name)` is per division), so this is NOT a rule
 * of the schema: it is the file that cannot say, from a label alone, whether `Lions` under two divisions
 * is two real teams or one team and a typo in a Division cell, and a wrong guess puts a team's practices
 * in a team that is not theirs. EVERY row of the label is refused (the verdict does not depend on the
 * order of the file), and the message says how to go on: make the labels differ in the file, then map
 * each to its team. A league that holds a team of one name in two divisions meets this, which is an open
 * question for the owner (PR 9, deviation 3), not a settled rule. Of two identical rows the first wins
 * and the repeat is listed.
 *
 * @param {ParsedPracticeRow[]} parsed  changed in place
 */
function refuseRepeats(parsed) {
  /** @type {Map<string, Set<string>>} team key -> its division keys */
  const divisionsOf = new Map();
  for (const r of parsed) {
    if (r.status !== 'placement') continue;
    const division = practiceLabelKey(r.divisionLabel);
    if (division === '') continue;
    const team = practiceLabelKey(r.teamLabel);
    divisionsOf.set(team, (divisionsOf.get(team) ?? new Set()).add(division));
  }
  for (const r of parsed) {
    if (r.status !== 'placement') continue;
    const division = practiceLabelKey(r.divisionLabel);
    const named = divisionsOf.get(practiceLabelKey(r.teamLabel));
    if (division === '' || named === undefined || named.size < 2) continue;
    r.status = 'refused';
    r.reason = R.TEAM_IN_TWO_DIVISIONS;
    r.flags = [];
    r.message = `The team ${quoted(r.teamLabel)} is under more than one division in this file, and a label alone cannot say whether that is two teams or a typo. Fix the Division, or make the labels differ (then map each to its team).`;
  }

  /** @type {Map<string, number>} content key -> the row number that holds it */
  const seen = new Map();
  for (const r of parsed) {
    if (r.status === 'refused') continue;
    // A tuple, not a delimited string: labels may contain the delimiter, and two different practices
    // must never be one key. A hold and an open slot at one cell are different rows (a flag, not a copy).
    const content = practiceTuple(
      r.status,
      r.status === 'placement' ? practiceLabelKey(r.divisionLabel) : null,
      practiceLabelKey(r.teamLabel),
      practiceLabelKey(r.locationLabel),
      practiceLabelKey(r.fieldLabel),
      practiceLabelKey(r.subunitLabel) || null,
      r.day,
      r.startTime,
      r.endTime,
      r.validFrom,
      r.validUntil,
      r.capacity
    );
    const first = seen.get(content);
    if (first === undefined) {
      seen.set(content, r.rowNumber);
      continue;
    }
    r.status = 'refused';
    r.reason = R.DUPLICATE_ROW;
    r.flags = [];
    r.message = `This is the same practice row as row ${first}; the earlier row is the one imported.`;
  }
}
