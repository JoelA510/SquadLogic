/**
 * Reading a schedule CSV: dates, times, the week, and the rows (plan
 * `docs/changes/2026-11-03-schedule-expansion.md` sections 4.3, 4.4 and 4.8; PR 4, task D2).
 *
 * This is the stage the Edge function (PR 6) mirrors: the allowlist, the structural checks, the
 * wall times put on the season's clock. Nothing here knows what teams, venues or fields the
 * organization has; that is `mapping.js`.
 *
 * ## Rules, not guesses
 *
 * - **Dates** are `YYYY-MM-DD` or `M/D/YYYY`, the second read as US (month first). `13/04/2026` is
 *   `bad-date`, never the 13th of April: swapping the fields until a date appears is how
 *   `04/05/2026` ends up in the wrong month on a day that happens to work both ways. A day the
 *   calendar lacks (`2026-02-30`) is `bad-date`, not the second of March.
 * - **Times** are `HH:mm` or `h:mm AM/PM`. `12:00 AM` is midnight and `12:30 PM` is half past noon.
 *   An end time of `1:00` after a start of `11:00 AM` is `end-not-after-start`: it is not repaired
 *   to 1 PM.
 * - **The clock is the season's**, through `timing/seasonClock.js`. The host's time zone is never
 *   read: this file uses `Date.UTC` for its calendar arithmetic and an explicit zone for every
 *   instant (`tests/scheduleImportParse.test.js` runs it under four other `TZ` values). A time the
 *   clocks skip is `time-in-dst-gap`; one they repeat is taken at its first occurrence and flagged
 *   `time-ambiguous`, as `resolveZonedInstant` does everywhere else.
 * - **The week** (decision 17) is the `Week` column when it is a positive whole number, else one plus
 *   the whole weeks since the Monday of the week the season starts. A `Week` that differs from the
 *   date is stored as written and flagged `week-differs`, never renumbered.
 * - **A game with no time or no field** is a TIME TBD game (`imported-without-time`), never dropped.
 *   A malformed time is `bad-time`; blank and malformed are different things.
 *
 * ## Only the allowlisted columns are read
 *
 * Anything that is not one of the columns of plan 4.3 (`Format`, `Notes`, a coach's email, a
 * phone) is dropped before a value is read from it. Its name is reported in `droppedColumns`; its
 * values appear nowhere in the result (AGENTS.md section 2, data minimisation).
 *
 * ## One result, no throw on a bad file
 *
 * A file the import cannot read at all comes back `ok: false` with a `refusal` and no rows. A row
 * it cannot use comes back `status: 'refused'` with its `reason`, and the rest of the file is read:
 * the owner's rule is that a schedule's problems are listed, not that they stop the import.
 */

import { seasonCalendarDate, resolveZonedInstant } from '../timing/seasonClock.js';
import { TIMING_REASON } from '../timing/reasonCodes.js';
import { scheduleLabelKey } from './mapping.js';
import { SCHEDULE_IMPORT_LIMITS, SCHEDULE_IMPORT_REASON as R } from './reasonCodes.js';

/** The columns of plan 4.3, by the name the template uses. */
export const SCHEDULE_IMPORT_COLUMNS = Object.freeze({
  GAME_ID: 'Game ID',
  DATE: 'Date',
  START: 'Start Time',
  END: 'End Time',
  LENGTH: 'Length',
  VENUE: 'Venue',
  FIELD: 'Field',
  DIVISION: 'Division',
  HOME: 'Home Team',
  AWAY: 'Away Team',
  WEEK: 'Week',
});
const C = SCHEDULE_IMPORT_COLUMNS;

/** The header row of the downloadable template (PR 6): `Length` is the alternative to `End Time`. */
export const SCHEDULE_IMPORT_TEMPLATE_HEADER = Object.freeze([
  C.GAME_ID,
  C.DATE,
  C.START,
  C.END,
  C.VENUE,
  C.FIELD,
  C.DIVISION,
  C.HOME,
  C.AWAY,
  C.WEEK,
]);

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const US_DATE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
const CLOCK_TIME = /^(\d{1,2}):(\d{2})\s*([AaPp][Mm])?$/;
const WHOLE_NUMBER = /^\d+$/;
const MAX_WEEK = 999;
const MS_PER_DAY = 86400000;

const pad2 = (n) => String(n).padStart(2, '0');
/** @param {number} total minutes past midnight */
const hhmm = (total) => `${pad2(Math.floor(total / 60))}:${pad2(total % 60)}`;

/**
 * The number of the day (days since 1970-01-01) of a real calendar date, or null. UTC arithmetic
 * only: no host zone, no daylight saving to shorten a day.
 *
 * @param {number} year
 * @param {number} month 1 to 12
 * @param {number} day
 * @returns {number | null}
 */
function dayNumber(year, month, day) {
  const probe = new Date(0);
  probe.setUTCFullYear(year, month - 1, day);
  const real =
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day;
  return real ? Math.floor(probe.getTime() / MS_PER_DAY) : null;
}

/**
 * A date as `YYYY-MM-DD`, from `YYYY-MM-DD` or `M/D/YYYY` (US), or null.
 *
 * @param {unknown} text
 * @returns {string | null}
 */
export function parseScheduleDate(text) {
  if (typeof text !== 'string') return null;
  const t = text.trim();
  let year;
  let month;
  let day;
  let match = ISO_DATE.exec(t);
  if (match) {
    [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  } else if ((match = US_DATE.exec(t))) {
    [month, day, year] = [Number(match[1]), Number(match[2]), Number(match[3])];
  } else {
    return null;
  }
  if (dayNumber(year, month, day) === null) return null;
  return `${String(year).padStart(4, '0')}-${pad2(month)}-${pad2(day)}`;
}

/**
 * Minutes past midnight from `HH:mm` or `h:mm AM/PM`, or null.
 *
 * @param {unknown} text
 * @returns {number | null}
 */
export function parseScheduleTime(text) {
  if (typeof text !== 'string') return null;
  const match = CLOCK_TIME.exec(text.trim());
  if (!match) return null;
  let hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (minutes > 59) return null;
  const meridiem = match[3]?.toLowerCase();
  if (meridiem) {
    // A 12-hour clock has hours 1 to 12; 12 AM is midnight, 12 PM is noon.
    if (hours < 1 || hours > 12) return null;
    hours = (hours % 12) + (meridiem === 'pm' ? 12 : 0);
  } else if (hours > 23) {
    return null;
  }
  return hours * 60 + minutes;
}

/**
 * A game length in whole minutes (1 to 1439), or null.
 *
 * @param {unknown} text
 * @returns {number | null}
 */
export function parseScheduleLength(text) {
  if (typeof text !== 'string') return null;
  const t = text.trim();
  if (!/^\d{1,4}$/.test(t)) return null;
  const minutes = Number(t);
  return minutes >= 1 && minutes <= 1439 ? minutes : null;
}

/** The day number of the Monday of the week a day number falls in. @param {number} day */
const mondayOf = (day) => day - ((((day + 3) % 7) + 7) % 7); // 1970-01-01 was a Thursday

/**
 * The week of a date: one plus the whole weeks since the Monday of the week the season starts.
 * A pure function of the two dates, so a re-import agrees with itself (plan 4.8). A date before the
 * start gives a number below 1; the window check refuses it first.
 *
 * @param {string} date `YYYY-MM-DD`
 * @param {string} seasonStart `YYYY-MM-DD`
 * @returns {number}
 */
export function scheduleWeekOf(date, seasonStart) {
  const toDay = (iso) => {
    const m = ISO_DATE.exec(iso);
    const n = m ? dayNumber(Number(m[1]), Number(m[2]), Number(m[3])) : null;
    if (n === null) throw new TypeError(`scheduleWeekOf: "${iso}" is not a YYYY-MM-DD date`);
    return n;
  };
  return 1 + Math.floor((mondayOf(toDay(date)) - mondayOf(toDay(seasonStart))) / 7);
}

/** A value for a message: short, and visibly the file's. @param {string} text */
const quoted = (text) => `"${text.length > 60 ? `${text.slice(0, 57)}...` : text}"`;

/**
 * @typedef {Object} ScheduleImportFlag
 * @property {string} code  a `SCHEDULE_IMPORT_FLAGS` member
 * @property {string} message
 * @property {Record<string, unknown>} details
 */

/**
 * @typedef {Object} ParsedScheduleRow
 * @property {number} rowNumber  1 for the first row after the header
 * @property {string} rowKey  `row-1`, unique in the file (a Game ID may repeat)
 * @property {string | null} gameId
 * @property {'ok' | 'tbd' | 'refused'} status
 * @property {string | null} reason  a `SCHEDULE_IMPORT_ROW_REFUSALS` member when refused
 * @property {string | null} message
 * @property {string | null} tbdReason  `imported-without-time` when `status` is `tbd`
 * @property {string | null} date  `YYYY-MM-DD`
 * @property {string | null} startTime  `HH:mm` wall time
 * @property {string | null} endTime
 * @property {string | null} start  the instant, on the season's clock, with its offset
 * @property {string | null} end
 * @property {string} venueLabel
 * @property {string} fieldLabel
 * @property {string} divisionLabel
 * @property {string} homeLabel
 * @property {string} awayLabel
 * @property {number | null} weekIndex
 * @property {'file' | 'derived' | null} weekSource
 * @property {ScheduleImportFlag[]} flags
 */

/**
 * @typedef {Object} ScheduleImportParseResult
 * @property {boolean} ok  false when the whole file is refused
 * @property {{ code: string, message: string, column?: string } | null} refusal
 * @property {string[]} droppedColumns  names only
 * @property {ParsedScheduleRow[]} rows
 * @property {{ rows: number, ok: number, tbd: number, refused: number, flagged: number }} counts
 * @property {Record<string, number>} byReason  refused rows by reason
 */

const EMPTY_COUNTS = Object.freeze({ rows: 0, ok: 0, tbd: 0, refused: 0, flagged: 0 });

/**
 * @param {string} code
 * @param {string} message
 * @param {string} [column]
 * @returns {ScheduleImportParseResult}
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
 * Read a schedule file that a CSV parser has already split into a header row and rows of text.
 *
 * @param {Object} input
 * @param {string[]} input.headers  the header row as read
 * @param {Array<Record<string, unknown>>} input.rows  one object per row, keyed by those headers
 * @param {{ timeZone?: string | null, startDate?: string | null, endDate?: string | null } | null} [input.season]
 *   the season's clock (`season_settings.timezone`) and window; `startDate` is what a blank `Week` is
 *   derived from
 * @returns {ScheduleImportParseResult}
 */
export function parseScheduleRows({ headers, rows, season }) {
  if (!Array.isArray(headers)) throw new TypeError('parseScheduleRows: headers must be an array');
  if (!Array.isArray(rows)) throw new TypeError('parseScheduleRows: rows must be an array');

  // Columns: match by the shared normaliser (trim, collapse, fold case; a byte-order mark is
  // whitespace to it), drop every name that is not on the list, and refuse a name given twice.
  /** @type {Map<string, string>} canonical name -> the header as it was written */
  const header = new Map();
  /** @type {string[]} */
  const droppedColumns = [];
  const byKey = new Map(Object.values(C).map((name) => [scheduleLabelKey(name), name]));
  for (const raw of headers) {
    const written = String(raw ?? '');
    const canonical = byKey.get(scheduleLabelKey(written));
    if (canonical === undefined) {
      if (written.trim() !== '') droppedColumns.push(written.trim());
      continue;
    }
    if (header.has(canonical)) {
      return fileRefusal(
        R.DUPLICATE_COLUMN,
        `The file has the column "${canonical}" more than once. Remove one and import again.`,
        canonical
      );
    }
    header.set(canonical, written);
  }

  for (const column of [C.DATE, C.START, C.VENUE, C.FIELD, C.DIVISION, C.HOME, C.AWAY]) {
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
      'The file has neither an "End Time" nor a "Length" column. Add one of them and import again.',
      'End Time or Length'
    );
  }

  // The season: a clock this runtime knows, and (optionally) a window.
  const timeZone = typeof season?.timeZone === 'string' ? season.timeZone.trim() : '';
  if (timeZone === '') {
    return fileRefusal(
      R.NO_SEASON_CLOCK,
      'This season has no time zone set, so the times in the file cannot be placed on a clock. Set the season’s time zone, then import again.'
    );
  }
  if (seasonCalendarDate(0, timeZone) === null) {
    return fileRefusal(
      R.NO_SEASON_CLOCK,
      `This season’s time zone, ${quoted(timeZone)}, is not one this system knows. Set a valid time zone, then import again.`
    );
  }
  // The season's dates come from the database, so one that is present and not a date is a defect in
  // the caller, not something to read as "no start" (which would turn the week rule off in silence).
  const seasonDate = (value, what) => {
    if (value === undefined || value === null || value === '') return null;
    const date = parseScheduleDate(value);
    if (date === null) {
      throw new TypeError(
        `parseScheduleRows: season.${what} must be YYYY-MM-DD, got ${JSON.stringify(value)}`
      );
    }
    return date;
  };
  const seasonStart = seasonDate(season?.startDate, 'startDate');
  const seasonEnd = seasonDate(season?.endDate, 'endDate');
  if (!header.has(C.WEEK) && seasonStart === null) {
    return fileRefusal(
      R.MISSING_WEEK,
      'The file has no "Week" column and the season has no start date to work the weeks out from. Add a Week column, or set the season’s start date.',
      C.WEEK
    );
  }
  if (rows.length > SCHEDULE_IMPORT_LIMITS.MAX_ROWS) {
    return fileRefusal(
      R.TOO_MANY_ROWS,
      `The file has ${rows.length.toLocaleString('en-US')} rows; one import takes at most ${SCHEDULE_IMPORT_LIMITS.MAX_ROWS.toLocaleString('en-US')}. Split it and import the parts one after the other.`
    );
  }

  /** @param {Record<string, unknown>} row @param {string} column */
  const cell = (row, column) => {
    const written = header.get(column);
    if (written === undefined) return '';
    const value = row?.[written];
    return value === undefined || value === null ? '' : String(value).trim();
  };

  const parsed = rows.map((row, index) =>
    parseRow({ row, index, cell, hasWeek: header.has(C.WEEK), timeZone, seasonStart, seasonEnd })
  );
  refuseRepeats(parsed);

  const counts = { rows: parsed.length, ok: 0, tbd: 0, refused: 0, flagged: 0 };
  /** @type {Record<string, number>} */
  const byReason = {};
  for (const r of parsed) {
    counts[r.status] += 1;
    if (r.status !== 'refused' && r.flags.length > 0) counts.flagged += 1;
    if (r.reason !== null) byReason[r.reason] = (byReason[r.reason] ?? 0) + 1;
  }
  return { ok: true, refusal: null, droppedColumns, rows: parsed, counts, byReason };
}

/**
 * One row. The checks run in a fixed order and the first to fail is the row's reason: the Game ID,
 * the date, the times, the two teams, the week, the season window, then the clock.
 *
 * @returns {ParsedScheduleRow}
 */
function parseRow({ row, index, cell, hasWeek, timeZone, seasonStart, seasonEnd }) {
  const rowNumber = index + 1;
  /** @type {ParsedScheduleRow} */
  const out = {
    rowNumber,
    rowKey: `row-${rowNumber}`,
    gameId: null,
    status: 'ok',
    reason: null,
    message: null,
    tbdReason: null,
    date: null,
    startTime: null,
    endTime: null,
    start: null,
    end: null,
    venueLabel: cell(row, C.VENUE),
    fieldLabel: cell(row, C.FIELD),
    divisionLabel: cell(row, C.DIVISION),
    homeLabel: cell(row, C.HOME),
    awayLabel: cell(row, C.AWAY),
    weekIndex: null,
    weekSource: null,
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

  // 1. Game ID
  const gameId = cell(row, C.GAME_ID);
  if (gameId.length > SCHEDULE_IMPORT_LIMITS.MAX_GAME_ID_LENGTH) {
    return refuse(
      R.BAD_GAME_ID,
      `The Game ID is ${gameId.length} characters; at most ${SCHEDULE_IMPORT_LIMITS.MAX_GAME_ID_LENGTH} are kept.`
    );
  }
  out.gameId = gameId === '' ? null : gameId;

  // 2. Date
  const dateText = cell(row, C.DATE);
  const date = parseScheduleDate(dateText);
  if (date === null) {
    return refuse(
      R.BAD_DATE,
      dateText === ''
        ? 'The date is blank. Use YYYY-MM-DD or M/D/YYYY.'
        : `${quoted(dateText)} is not a date this import reads. Use YYYY-MM-DD or M/D/YYYY (month first).`
    );
  }
  out.date = date;

  // 3. Times
  const startText = cell(row, C.START);
  const endText = cell(row, C.END);
  const lengthText = cell(row, C.LENGTH);
  const startMin = startText === '' ? null : parseScheduleTime(startText);
  if (startText !== '' && startMin === null) {
    return refuse(R.BAD_TIME, `The start time ${quoted(startText)} is not HH:mm or h:mm AM/PM.`);
  }
  const endGiven = endText === '' ? null : parseScheduleTime(endText);
  if (endText !== '' && endGiven === null) {
    return refuse(R.BAD_TIME, `The end time ${quoted(endText)} is not HH:mm or h:mm AM/PM.`);
  }
  const lengthMin = lengthText === '' ? null : parseScheduleLength(lengthText);
  if (lengthText !== '' && lengthMin === null) {
    return refuse(R.BAD_TIME, `The length ${quoted(lengthText)} is not a whole number of minutes.`);
  }
  if (
    startMin !== null &&
    endGiven !== null &&
    lengthMin !== null &&
    startMin + lengthMin !== endGiven
  ) {
    return refuse(R.BAD_TIME, 'The End Time and the Length disagree about when the game ends.');
  }
  const endMin =
    endGiven ?? (startMin !== null && lengthMin !== null ? startMin + lengthMin : null);
  if (endMin !== null && endMin >= 1440) {
    return refuse(R.BAD_TIME, 'The game would run past midnight.');
  }
  if (startMin !== null && endMin !== null && endMin <= startMin) {
    return refuse(
      R.END_NOT_AFTER_START,
      `The game ends (${hhmm(endMin)}) at or before it starts (${hhmm(startMin)}).`
    );
  }
  if (startMin !== null) out.startTime = hhmm(startMin);
  if (endMin !== null) out.endTime = hhmm(endMin);

  // 4. The two teams are two teams
  const homeKey = scheduleLabelKey(out.homeLabel);
  if (homeKey !== '' && homeKey === scheduleLabelKey(out.awayLabel)) {
    return refuse(R.SAME_TEAM, `The home and away teams are both ${quoted(out.homeLabel)}.`);
  }

  // 5. The week
  const weekText = hasWeek ? cell(row, C.WEEK) : '';
  let weekGiven = null;
  if (weekText !== '') {
    const n = WHOLE_NUMBER.test(weekText) ? Number(weekText) : NaN;
    if (!(n >= 1 && n <= MAX_WEEK)) {
      return refuse(
        R.BAD_WEEK,
        `The week ${quoted(weekText)} is not a whole number from 1 to ${MAX_WEEK}.`
      );
    }
    weekGiven = n;
  } else if (seasonStart === null) {
    return refuse(
      R.MISSING_WEEK,
      'The week is blank and the season has no start date to work it out from. Fill in the Week, or set the season’s start date.'
    );
  }

  // 6. The season window
  if (seasonStart !== null && date < seasonStart) {
    return refuse(R.OUTSIDE_SEASON_WINDOW, `${date} is before the season starts (${seasonStart}).`);
  }
  if (seasonEnd !== null && date > seasonEnd) {
    return refuse(R.OUTSIDE_SEASON_WINDOW, `${date} is after the season ends (${seasonEnd}).`);
  }
  const weekDerived = seasonStart === null ? null : scheduleWeekOf(date, seasonStart);
  out.weekIndex = weekGiven ?? weekDerived;
  out.weekSource = weekGiven === null ? 'derived' : 'file';
  if (weekGiven !== null && weekDerived !== null && weekGiven !== weekDerived) {
    out.flags.push({
      code: R.WEEK_DIFFERS,
      message: `The file says week ${weekGiven}; the date falls in week ${weekDerived}. The file’s week is kept.`,
      details: { weekGiven, weekDerived },
    });
  }

  // 7. The clock
  const timed = startMin !== null && endMin !== null;
  if (timed) {
    const placed = [
      ['start', 'Start Time', out.startTime],
      ['end', 'End Time', out.endTime],
    ].map(([which, label, time]) => ({
      which,
      ...resolveZonedInstant({ date, time, timeZone, label }),
    }));
    const failed = placed.find((p) => p.iso === null);
    if (failed) {
      const finding = failed.findings[0];
      return refuse(
        finding?.code === TIMING_REASON.WALL_TIME_NONEXISTENT ? R.TIME_IN_DST_GAP : R.BAD_TIME,
        finding?.message ?? 'The time could not be placed on the season’s clock.'
      );
    }
    out.start = placed[0].iso;
    out.end = placed[1].iso;
    const ambiguous = placed.filter((p) =>
      p.findings.some((f) => f.code === TIMING_REASON.WALL_TIME_AMBIGUOUS)
    );
    if (ambiguous.length > 0) {
      out.flags.push({
        code: R.TIME_AMBIGUOUS,
        message: `The clocks repeat ${ambiguous.map((p) => (p.which === 'start' ? out.startTime : out.endTime)).join(' and ')} on ${date}; the first occurrence was taken.`,
        details: {
          start: ambiguous.some((p) => p.which === 'start'),
          end: ambiguous.some((p) => p.which === 'end'),
        },
      });
    }
  }

  // 8. No time, or no field: a TIME TBD game, never a dropped one
  if (!timed || out.fieldLabel === '') {
    out.status = 'tbd';
    out.tbdReason = R.IMPORTED_WITHOUT_TIME;
  }
  return out;
}

/**
 * The same game twice, and one Game ID on two games. The first row to be accepted wins; the repeat
 * is listed with its reason. A row that was refused does not count as the first (its repeat is the
 * game, not a copy of it).
 *
 * @param {ParsedScheduleRow[]} parsed  changed in place
 */
function refuseRepeats(parsed) {
  const contentKeys = new Set();
  const gameIds = new Set();
  for (const r of parsed) {
    if (r.status === 'refused') continue;
    const content = [
      scheduleLabelKey(r.divisionLabel),
      scheduleLabelKey(r.homeLabel),
      scheduleLabelKey(r.awayLabel),
      scheduleLabelKey(r.venueLabel),
      scheduleLabelKey(r.fieldLabel),
      r.date,
      r.startTime ?? 'tbd',
    ].join('|');
    const reason = contentKeys.has(content)
      ? R.DUPLICATE_ROW
      : r.gameId !== null && gameIds.has(r.gameId)
        ? R.GAME_ID_REUSED
        : null;
    if (reason === null) {
      contentKeys.add(content);
      if (r.gameId !== null) gameIds.add(r.gameId);
      continue;
    }
    r.status = 'refused';
    r.reason = reason;
    r.tbdReason = null;
    r.flags = [];
    r.message =
      reason === R.DUPLICATE_ROW
        ? 'This is the same game as an earlier row; the earlier row is the one imported.'
        : `The Game ID ${quoted(r.gameId ?? '')} already belongs to a different game earlier in the file.`;
  }
}
