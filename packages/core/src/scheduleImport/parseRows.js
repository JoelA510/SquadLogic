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
 *   **A row with no Division, Home Team or Away Team, or with a time and a field and no Venue,** is
 *   refused as a row (`unknown-division`, `unknown-team`, `unknown-venue`), with the words the mapping
 *   step uses for the same blank.
 * - **A time the import cannot read** (`25:00`, `noon`, a Length of `60 min`, an End Time and a Length
 *   that disagree, a game that would pass midnight) is a TIME TBD game too, on its date, with a
 *   `bad-time` warning that says what could not be read (owner, 2026-11-10: prefer a warning to a
 *   refusal; a TIME TBD game holds a date and no time). Blank and malformed stay different things:
 *   the blank one carries no warning. `end-not-after-start` and `time-in-dst-gap` are still refusals:
 *   those times were read, and they are wrong.
 * - **A Week the import cannot store** (`three`, `0`, anything past 255) is derived from the date,
 *   with a `bad-week` warning. With no season start date there is nothing to derive it from, and the
 *   row is refused `missing-week`; a date outside the season is refused `outside-season-window` first.
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
/** `game_slots.week_index` and `schedule_tbd.week_index` hold 1 to 255; the SQL's shape check refuses a staged row past it. */
const MAX_WEEK = 255;
const MS_PER_DAY = 86400000;
const MS_PER_MINUTE = 60000;

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

/** One formatter per zone: building one is the expensive part of reading a long file. */
const wallFormatters = new Map();

/**
 * The wall reading of an instant on the season's clock, and the instant spelled with that zone's
 * offset (`2026-11-01T01:30:00-08:00`), as `resolveZonedInstant` spells one. Used for a game's end
 * when a Length gives it as elapsed time: the end is an instant first, and its wall reading follows.
 * The zone is always explicit, never the host's.
 *
 * @param {number} epochMs
 * @param {string} timeZone
 * @returns {{ date: string, time: string, iso: string }}
 */
function wallOfInstant(epochMs, timeZone) {
  let formatter = wallFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    wallFormatters.set(timeZone, formatter);
  }
  /** @type {Record<string, string>} */
  const f = {};
  for (const part of formatter.formatToParts(new Date(epochMs))) f[part.type] = part.value;
  const hour = f.hour === '24' ? '00' : f.hour; // some ICU builds render midnight as 24
  const wallAsUtc = Date.UTC(
    Number(f.year),
    Number(f.month) - 1,
    Number(f.day),
    Number(hour),
    Number(f.minute),
    Number(f.second)
  );
  const offsetMinutes = Math.round((wallAsUtc - epochMs) / MS_PER_MINUTE);
  const sign = offsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(offsetMinutes);
  const date = `${f.year}-${f.month}-${f.day}`;
  const time = `${hour}:${f.minute}`;
  return {
    date,
    time,
    iso: `${date}T${time}:${f.second}${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`,
  };
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
 * @property {ScheduleImportFlag[]} flags  what was accepted and said: `time-ambiguous` and
 *   `week-differs` (staged, the SQL knows them) and the parse's own `bad-time` and `bad-week`
 *   (`SCHEDULE_IMPORT_PARSE_WARNINGS`: shown at upload and in the preview, never staged)
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
 * @param {number} [input.rowOffset]  how many rows of the file came before these (0 for a whole file).
 *   The Edge function reads a file in chunks of at most 500 rows (PR 6); a row's number and key are
 *   its place in the FILE, and the row limit is the file's. A repeat is judged within the rows given:
 *   one that straddles two chunks is refused by the apply, which judges every staged row together.
 * @returns {ScheduleImportParseResult}
 */
export function parseScheduleRows({ headers, rows, season, rowOffset = 0 }) {
  if (!Array.isArray(headers)) throw new TypeError('parseScheduleRows: headers must be an array');
  if (!Array.isArray(rows)) throw new TypeError('parseScheduleRows: rows must be an array');
  if (!Number.isInteger(rowOffset) || rowOffset < 0) {
    throw new TypeError('parseScheduleRows: rowOffset must be a whole number, 0 or more');
  }

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
  if (rowOffset + rows.length > SCHEDULE_IMPORT_LIMITS.MAX_ROWS) {
    return fileRefusal(
      R.TOO_MANY_ROWS,
      `The file has ${(rowOffset + rows.length).toLocaleString('en-US')} rows; one import takes at most ${SCHEDULE_IMPORT_LIMITS.MAX_ROWS.toLocaleString('en-US')}. Split it and import the parts one after the other.`
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
    parseRow({
      row,
      index: rowOffset + index,
      cell,
      hasWeek: header.has(C.WEEK),
      timeZone,
      seasonStart,
      seasonEnd,
    })
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
  // A time that cannot be read does not refuse the row (F5): the game is kept on its date as a TIME TBD
  // game and the first thing that could not be read is said. The rest of the row is still judged.
  /** @type {string | null} */
  let timeProblem = null;
  let startMin = startText === '' ? null : parseScheduleTime(startText);
  if (startText !== '' && startMin === null) {
    timeProblem = `The start time ${quoted(startText)} is not HH:mm or h:mm AM/PM.`;
  }
  let endGiven = endText === '' ? null : parseScheduleTime(endText);
  if (endText !== '' && endGiven === null) {
    timeProblem ??= `The end time ${quoted(endText)} is not HH:mm or h:mm AM/PM.`;
  }
  let lengthMin = lengthText === '' ? null : parseScheduleLength(lengthText);
  if (lengthText !== '' && lengthMin === null) {
    timeProblem ??= `The length ${quoted(lengthText)} is not a whole number of minutes.`;
  }
  if (timeProblem !== null) [startMin, endGiven, lengthMin] = [null, null, null];
  // The wall reading of an End Time must be after the start's: `game_slots` holds both wall times and
  // refuses an end that is not after its start. (A Length is added later, to the resolved start.)
  if (startMin !== null && endGiven !== null && endGiven <= startMin) {
    return refuse(
      R.END_NOT_AFTER_START,
      endGiven === 0
        ? `An end at midnight (${quoted(endText)}) is not an end this import stores: it reads as the start of the day. The latest end is 23:59.`
        : `The game ends (${hhmm(endGiven)}) at or before it starts (${hhmm(startMin)}).`
    );
  }
  if (startMin !== null) out.startTime = hhmm(startMin);
  if (endGiven !== null) out.endTime = hhmm(endGiven);

  // 4. A game has a division and two teams, and the two teams are two teams. A blank one is refused HERE, as a row:
  // staged as an accepted row it would fail the apply's shape check, and that refuses the whole import, not the row.
  if (scheduleLabelKey(out.divisionLabel) === '') {
    return refuse(R.UNKNOWN_DIVISION, 'The Division is blank.');
  }
  for (const [which, label] of [
    ['Home', out.homeLabel],
    ['Away', out.awayLabel],
  ]) {
    if (scheduleLabelKey(label) === '')
      return refuse(R.UNKNOWN_TEAM, `The ${which} Team is blank.`);
  }
  const homeKey = scheduleLabelKey(out.homeLabel);
  if (homeKey !== '' && homeKey === scheduleLabelKey(out.awayLabel)) {
    return refuse(R.SAME_TEAM, `The home and away teams are both ${quoted(out.homeLabel)}.`);
  }

  // 5. The week
  const weekText = hasWeek ? cell(row, C.WEEK) : '';
  let weekGiven = null;
  /** @type {string | null} a Week that cannot be stored: the week is derived from the date, and said (F5) */
  let badWeekText = null;
  if (weekText !== '') {
    const n = WHOLE_NUMBER.test(weekText) ? Number(weekText) : NaN;
    if (n >= 1 && n <= MAX_WEEK) {
      weekGiven = n;
    } else if (seasonStart === null) {
      return refuse(
        R.MISSING_WEEK,
        `The week ${quoted(weekText)} is not a whole number from 1 to ${MAX_WEEK}, and the season has no start date to work the week out from. Correct the Week, or set the season’s start date.`
      );
    } else {
      badWeekText = weekText;
    }
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
  // A week worked out from the date that no slot can hold (a season with no end date, and a date years on).
  if (weekGiven === null && weekDerived !== null && weekDerived > MAX_WEEK) {
    return refuse(
      R.OUTSIDE_SEASON_WINDOW,
      `${date} is week ${weekDerived} of the season; a schedule holds weeks 1 to ${MAX_WEEK}. Check the date, or give the Week.`
    );
  }
  out.weekIndex = weekGiven ?? weekDerived;
  out.weekSource = weekGiven === null ? 'derived' : 'file';
  if (badWeekText !== null) {
    out.flags.push({
      code: R.BAD_WEEK,
      message: `The week ${quoted(badWeekText)} is not a whole number from 1 to ${MAX_WEEK}, so the week was worked out from the date: week ${weekDerived}.`,
      details: { weekDerived },
    });
  }
  if (weekGiven !== null && weekDerived !== null && weekGiven !== weekDerived) {
    out.flags.push({
      code: R.WEEK_DIFFERS,
      message: `The file says week ${weekGiven}; the date falls in week ${weekDerived}. The file’s week is kept.`,
      details: { weekGiven, weekDerived },
    });
  }

  /**
   * The row's time cannot be used (F5): the game is kept on its date as a TIME TBD game, with what was
   * wrong said. It carries no time at all, as every TIME TBD game does.
   * @param {string} problem
   */
  const unreadableTime = (problem) => {
    out.status = 'tbd';
    out.tbdReason = R.IMPORTED_WITHOUT_TIME;
    out.startTime = null;
    out.endTime = null;
    out.start = null;
    out.end = null;
    out.flags.push({
      code: R.BAD_TIME,
      message: `${problem} The game is kept on ${date} with no time (TIME TBD).`,
      details: {},
    });
    return out;
  };
  if (timeProblem !== null) return unreadableTime(timeProblem);

  // 7. The clock. The start is put on the season's clock first; an End Time is put on it too, and a
  // Length is ELAPSED minutes from the resolved start (a game does not get longer or shorter because
  // the clocks change under it). When both are given they must agree as instants, not as wall readings.
  const timed = startMin !== null && (endGiven !== null || lengthMin !== null);
  if (timed) {
    const placeAt = (which, label, time) => ({
      which,
      ...resolveZonedInstant({ date, time, timeZone, label }),
    });
    const startAt = placeAt('start', 'Start Time', out.startTime);
    const endAt = endGiven === null ? null : placeAt('end', 'End Time', out.endTime);
    const failed = [startAt, endAt].find((p) => p !== null && p.iso === null);
    if (failed) {
      const finding = failed.findings[0];
      if (finding?.code === TIMING_REASON.WALL_TIME_NONEXISTENT) {
        return refuse(R.TIME_IN_DST_GAP, finding.message);
      }
      return unreadableTime(
        finding?.message ?? 'The time could not be placed on the season’s clock.'
      );
    }
    const startMs = Date.parse(startAt.iso);
    /** @type {'first' | 'second' | null} */
    let derivedEndRound = null;
    if (endAt !== null) {
      const elapsed = (Date.parse(endAt.iso) - startMs) / MS_PER_MINUTE;
      if (elapsed <= 0) {
        return refuse(R.END_NOT_AFTER_START, 'The game ends at or before it starts on the clock.');
      }
      if (lengthMin !== null && elapsed !== lengthMin) {
        return unreadableTime(
          `The End Time and the Length disagree: from ${out.startTime} to ${out.endTime} is ${elapsed} minutes on the clock, not ${lengthMin}.`
        );
      }
      out.end = endAt.iso;
    } else {
      const ends = wallOfInstant(startMs + lengthMin * MS_PER_MINUTE, timeZone);
      if (ends.date !== date) {
        return unreadableTime(
          'The game would reach or pass midnight. The latest end this import stores is 23:59.'
        );
      }
      if (ends.time <= out.startTime) {
        return refuse(
          R.END_NOT_AFTER_START,
          `A game of ${lengthMin} minutes from ${out.startTime} ends at ${ends.time} by the clock, because the clocks go back during it; the import cannot store an end that is not after its start.`
        );
      }
      out.endTime = ends.time;
      out.end = ends.iso;
      // The end is an instant first. If its wall reading is one the clocks show twice, a reader that
      // takes the wall time back to an instant (as `resolveZonedInstant` does) gets the first one, so
      // say which time round this end is.
      const probe = resolveZonedInstant({ date, time: ends.time, timeZone, label: 'End Time' });
      if (probe.findings.some((f) => f.code === TIMING_REASON.WALL_TIME_AMBIGUOUS)) {
        derivedEndRound = probe.iso === ends.iso ? 'first' : 'second';
      }
    }
    out.start = startAt.iso;
    const ambiguous = [startAt, endAt].filter(
      (p) => p !== null && p.findings.some((f) => f.code === TIMING_REASON.WALL_TIME_AMBIGUOUS)
    );
    if (ambiguous.length > 0 || derivedEndRound !== null) {
      const taken = ambiguous.map((p) => (p.which === 'start' ? out.startTime : out.endTime));
      const parts = [];
      if (taken.length > 0) {
        parts.push(
          `The clocks repeat ${taken.join(' and ')} on ${date}; the first occurrence was taken.`
        );
      }
      if (derivedEndRound !== null) {
        parts.push(
          `The clocks repeat ${out.endTime} on ${date}, and this game's end, ${lengthMin} minutes after its start, is the ${derivedEndRound} time round. The instants are exact; the clock time alone is not.`
        );
      }
      out.flags.push({
        code: R.TIME_AMBIGUOUS,
        message: parts.join(' '),
        details: {
          start: ambiguous.some((p) => p.which === 'start'),
          end: ambiguous.some((p) => p.which === 'end') || derivedEndRound !== null,
          ...(derivedEndRound === null ? {} : { endOccurrence: derivedEndRound }),
        },
      });
    }
  }

  // 8. A time and a field with no venue: the field cannot be found (a field is one of a venue's). Refused as a row,
  // as the mapping step always refused it; staged as placed it would fail the apply's shape check for the whole job.
  if (timed && out.fieldLabel !== '' && scheduleLabelKey(out.venueLabel) === '') {
    return refuse(R.UNKNOWN_VENUE, 'The Venue is blank.');
  }

  // No time, or no field: a TIME TBD game, never a dropped one
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
    // A tuple, not a delimited string: labels may contain the delimiter, and two different games
    // must never be one key. A missing start time stays null, never a word that is also a label.
    // A TIME TBD game is not placed, so the venue and field the file named are not part of what it
    // is; with no time to tell two of one pair on one day apart, its Game ID is (a rematch or a
    // doubleheader awaiting times is two games, not one listed twice).
    const content =
      r.status === 'tbd'
        ? JSON.stringify([
            'tbd',
            scheduleLabelKey(r.divisionLabel),
            scheduleLabelKey(r.homeLabel),
            scheduleLabelKey(r.awayLabel),
            r.date,
            r.startTime,
            r.gameId,
          ])
        : JSON.stringify([
            scheduleLabelKey(r.divisionLabel),
            scheduleLabelKey(r.homeLabel),
            scheduleLabelKey(r.awayLabel),
            scheduleLabelKey(r.venueLabel),
            scheduleLabelKey(r.fieldLabel),
            r.date,
            r.startTime,
          ]);
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
