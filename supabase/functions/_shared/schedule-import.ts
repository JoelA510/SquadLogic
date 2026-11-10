/**
 * The games import in the Edge function (plan `docs/changes/2026-11-03-schedule-expansion.md` 4.2 step 3, 4.3, 4.4 and
 * 4.8; PR 6, tasks F1 and F7): reading a chunk of a schedule file into the rows `apply_game_import_job` stages, and the
 * preview-stale check of the confirm.
 *
 * **A mirror, held to core.** An Edge Function cannot import `packages/core`, so this file is a second copy of
 * `packages/core/src/scheduleImport/parseRows.js`, `staging.js`, the label key of `mapping.js` and `previewCounts.js`.
 * Core is the canonical one (the browser's own parse and the mock run it). What holds the two equal:
 * `tests/gameImportEdgeParity.test.js` (Vitest) runs both over the shipped fixtures and over the named-date vectors of
 * `tests/fixtures/schedule-import.vectors.json` and requires the same staged rows, key for key, under three host zones;
 * `tests/schedule-import_test.ts` (Deno, CI) asks this build the same vectors. Change both copies, or neither.
 *
 * **The clock is the season's.** Every instant comes from `./timing/seasonClock.ts` with an explicit zone; calendar
 * arithmetic is `Date.UTC`. The host's zone is never read (the Deno suite runs under `UTC` and `America/Los_Angeles`,
 * the Vitest twin under three more).
 *
 * **Only the columns of plan 4.3 are read.** Anything else of the file (a format, a note, a coach, an email, a phone)
 * is dropped before a value is read from it, and is neither staged nor returned.
 */

import { sanitizeImportText } from './import-rows.ts';
import { resolveZonedInstant, TIMING_REASON } from './timing/seasonClock.ts';

// ------------------------------------------------------------------------------------------------ the closed lists

/** The codes this stage can give (core: `SCHEDULE_IMPORT_REASON`). */
export const GAME_IMPORT_REASON = Object.freeze({
  MISSING_COLUMN: 'missing-column',
  DUPLICATE_COLUMN: 'duplicate-column',
  TOO_MANY_ROWS: 'too-many-rows',
  NO_SEASON_CLOCK: 'no-season-clock',
  MISSING_WEEK: 'missing-week',
  BAD_GAME_ID: 'bad-game-id',
  BAD_DATE: 'bad-date',
  END_NOT_AFTER_START: 'end-not-after-start',
  SAME_TEAM: 'same-team',
  OUTSIDE_SEASON_WINDOW: 'outside-season-window',
  TIME_IN_DST_GAP: 'time-in-dst-gap',
  DUPLICATE_ROW: 'duplicate-row',
  GAME_ID_REUSED: 'game-id-reused',
  TIME_AMBIGUOUS: 'time-ambiguous',
  WEEK_DIFFERS: 'week-differs',
  BAD_TIME: 'bad-time',
  BAD_WEEK: 'bad-week',
  IMPORTED_WITHOUT_TIME: 'imported-without-time',
} as const);
const R = GAME_IMPORT_REASON;

/** The flags a staged row may carry: the ones the SQL's shape check knows (core: `SCHEDULE_IMPORT_STAGED_FLAGS`). */
export const GAME_IMPORT_STAGED_FLAGS: readonly string[] = Object.freeze([
  R.TIME_AMBIGUOUS,
  R.WEEK_DIFFERS,
]);

/** Limits of the file (core: `SCHEDULE_IMPORT_LIMITS`), and of one request. */
export const GAME_IMPORT_LIMITS = Object.freeze({
  /** The whole file. */
  MAX_ROWS: 2400,
  /** One request: the browser sends the file in chunks (a request gets 2 s of CPU). */
  MAX_CHUNK_ROWS: 500,
  MAX_GAME_ID_LENGTH: 40,
  /** A cell longer than this is cut before it is read (no label of a schedule is this long). */
  MAX_CELL_LENGTH: 500,
  MAX_HEADERS: 200,
});

/** The columns of plan 4.3, by the name the template uses (core: `SCHEDULE_IMPORT_COLUMNS`). */
export const GAME_IMPORT_COLUMNS = Object.freeze({
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
} as const);
const C = GAME_IMPORT_COLUMNS;

// ------------------------------------------------------------------------------------------------ labels and keys

/** Core's `scheduleLabelKey`: trim, collapse every run of whitespace to one space, lower-case. Removes no word. */
export function scheduleLabelKey(label: unknown): string {
  return label === undefined || label === null
    ? ''
    : String(label).trim().replace(/\s+/g, ' ').toLowerCase();
}
const tuple = (...parts: string[]): string => JSON.stringify(parts);
const divisionDecisionKey = (division: string): string => scheduleLabelKey(division);
const venueDecisionKey = (venue: string): string => scheduleLabelKey(venue);
const fieldDecisionKey = (venue: string, field: string): string =>
  tuple(scheduleLabelKey(venue), scheduleLabelKey(field));
const teamDecisionKey = (division: string, team: string): string =>
  tuple(scheduleLabelKey(division), scheduleLabelKey(team));

// ------------------------------------------------------------------------------------------------ dates and times

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const US_DATE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
const CLOCK_TIME = /^(\d{1,2}):(\d{2})\s*([AaPp][Mm])?$/;
const WHOLE_NUMBER = /^\d+$/;
const MAX_WEEK = 255;
const MS_PER_DAY = 86400000;
const MS_PER_MINUTE = 60000;

const pad2 = (n: number): string => String(n).padStart(2, '0');
const hhmm = (total: number): string => `${pad2(Math.floor(total / 60))}:${pad2(total % 60)}`;

function dayNumber(year: number, month: number, day: number): number | null {
  const probe = new Date(0);
  probe.setUTCFullYear(year, month - 1, day);
  const real =
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day;
  return real ? Math.floor(probe.getTime() / MS_PER_DAY) : null;
}

/** A date as `YYYY-MM-DD`, from `YYYY-MM-DD` or `M/D/YYYY` (US), or null. */
export function parseScheduleDate(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  const t = text.trim();
  let year: number;
  let month: number;
  let day: number;
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

/** Minutes past midnight from `HH:mm` or `h:mm AM/PM`, or null. */
export function parseScheduleTime(text: unknown): number | null {
  if (typeof text !== 'string') return null;
  const match = CLOCK_TIME.exec(text.trim());
  if (!match) return null;
  let hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (minutes > 59) return null;
  const meridiem = match[3]?.toLowerCase();
  if (meridiem) {
    if (hours < 1 || hours > 12) return null;
    hours = (hours % 12) + (meridiem === 'pm' ? 12 : 0);
  } else if (hours > 23) {
    return null;
  }
  return hours * 60 + minutes;
}

/** A game length in whole minutes (1 to 1439), or null. */
export function parseScheduleLength(text: unknown): number | null {
  if (typeof text !== 'string') return null;
  const t = text.trim();
  if (!/^\d{1,4}$/.test(t)) return null;
  const minutes = Number(t);
  return minutes >= 1 && minutes <= 1439 ? minutes : null;
}

const mondayOf = (day: number): number => day - ((((day + 3) % 7) + 7) % 7); // 1970-01-01 was a Thursday

/** The week of a date: one plus the whole weeks since the Monday of the week the season starts. */
export function scheduleWeekOf(date: string, seasonStart: string): number {
  const toDay = (iso: string): number => {
    const m = ISO_DATE.exec(iso);
    const n = m ? dayNumber(Number(m[1]), Number(m[2]), Number(m[3])) : null;
    if (n === null) throw new TypeError(`scheduleWeekOf: "${iso}" is not a YYYY-MM-DD date`);
    return n;
  };
  return 1 + Math.floor((mondayOf(toDay(date)) - mondayOf(toDay(seasonStart))) / 7);
}

const wallFormatters = new Map<string, Intl.DateTimeFormat>();

/** A formatter for the zone, or null when the runtime does not know it. Never the host's zone. */
function wallFormatter(timeZone: string): Intl.DateTimeFormat | null {
  const cached = wallFormatters.get(timeZone);
  if (cached) return cached;
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
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
    return formatter;
  } catch (error) {
    // An unknown zone is a RangeError and is the answer "no clock"; anything else is not ours to hide.
    if (error instanceof RangeError) return null;
    throw error;
  }
}

/** The wall reading of an instant on the season's clock, and the instant spelled with that zone's offset. */
function wallOfInstant(
  epochMs: number,
  formatter: Intl.DateTimeFormat
): { date: string; time: string; iso: string } {
  const f: Record<string, string> = {};
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

const quoted = (text: string): string => `"${text.length > 60 ? `${text.slice(0, 57)}...` : text}"`;

// ------------------------------------------------------------------------------------------------ the parse

export interface GameImportFlag {
  code: string;
  message: string;
  details: Record<string, unknown>;
}

export interface ParsedGameRow {
  rowNumber: number;
  rowKey: string;
  gameId: string | null;
  status: 'ok' | 'tbd' | 'refused';
  reason: string | null;
  message: string | null;
  tbdReason: string | null;
  date: string | null;
  startTime: string | null;
  endTime: string | null;
  start: string | null;
  end: string | null;
  venueLabel: string;
  fieldLabel: string;
  divisionLabel: string;
  homeLabel: string;
  awayLabel: string;
  weekIndex: number | null;
  weekSource: 'file' | 'derived' | null;
  flags: GameImportFlag[];
}

export interface GameImportSeason {
  timeZone?: string | null;
  startDate?: string | null;
  endDate?: string | null;
}

export interface GameImportParseResult {
  ok: boolean;
  refusal: { code: string; message: string; column?: string } | null;
  droppedColumns: string[];
  rows: ParsedGameRow[];
  counts: { rows: number; ok: number; tbd: number; refused: number; flagged: number };
  byReason: Record<string, number>;
}

function fileRefusal(code: string, message: string, column?: string): GameImportParseResult {
  return {
    ok: false,
    refusal: column === undefined ? { code, message } : { code, message, column },
    droppedColumns: [],
    rows: [],
    counts: { rows: 0, ok: 0, tbd: 0, refused: 0, flagged: 0 },
    byReason: {},
  };
}

/**
 * Read rows of a schedule file that a CSV parser has already split into a header row and rows of text. Core's
 * `parseScheduleRows`, rule for rule and message for message.
 */
export function parseGameImportRows({
  headers,
  rows,
  season,
  rowOffset = 0,
}: {
  headers: unknown[];
  rows: Array<Record<string, unknown>>;
  season?: GameImportSeason | null;
  rowOffset?: number;
}): GameImportParseResult {
  if (!Array.isArray(headers)) throw new TypeError('parseScheduleRows: headers must be an array');
  if (!Array.isArray(rows)) throw new TypeError('parseScheduleRows: rows must be an array');
  if (!Number.isInteger(rowOffset) || rowOffset < 0) {
    throw new TypeError('parseScheduleRows: rowOffset must be a whole number, 0 or more');
  }

  const header = new Map<string, string>();
  const droppedColumns: string[] = [];
  const byKey = new Map<string, string>(
    Object.values(C).map((name) => [scheduleLabelKey(name), name])
  );
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

  const timeZone = typeof season?.timeZone === 'string' ? season.timeZone.trim() : '';
  if (timeZone === '') {
    return fileRefusal(
      R.NO_SEASON_CLOCK,
      'This season has no time zone set, so the times in the file cannot be placed on a clock. Set the season’s time zone, then import again.'
    );
  }
  const formatter = wallFormatter(timeZone);
  if (formatter === null) {
    return fileRefusal(
      R.NO_SEASON_CLOCK,
      `This season’s time zone, ${quoted(timeZone)}, is not one this system knows. Set a valid time zone, then import again.`
    );
  }
  const seasonDate = (value: unknown, what: string): string | null => {
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
  if (rowOffset + rows.length > GAME_IMPORT_LIMITS.MAX_ROWS) {
    return fileRefusal(
      R.TOO_MANY_ROWS,
      `The file has ${(rowOffset + rows.length).toLocaleString('en-US')} rows; one import takes at most ${GAME_IMPORT_LIMITS.MAX_ROWS.toLocaleString('en-US')}. Split it and import the parts one after the other.`
    );
  }

  const cell = (row: Record<string, unknown>, column: string): string => {
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
      formatter,
      seasonStart,
      seasonEnd,
    })
  );
  refuseRepeats(parsed);

  const counts = { rows: parsed.length, ok: 0, tbd: 0, refused: 0, flagged: 0 };
  const byReason: Record<string, number> = {};
  for (const r of parsed) {
    counts[r.status] += 1;
    if (r.status !== 'refused' && r.flags.length > 0) counts.flagged += 1;
    if (r.reason !== null) byReason[r.reason] = (byReason[r.reason] ?? 0) + 1;
  }
  return { ok: true, refusal: null, droppedColumns, rows: parsed, counts, byReason };
}

function parseRow({
  row,
  index,
  cell,
  hasWeek,
  timeZone,
  formatter,
  seasonStart,
  seasonEnd,
}: {
  row: Record<string, unknown>;
  index: number;
  cell: (row: Record<string, unknown>, column: string) => string;
  hasWeek: boolean;
  timeZone: string;
  formatter: Intl.DateTimeFormat;
  seasonStart: string | null;
  seasonEnd: string | null;
}): ParsedGameRow {
  const rowNumber = index + 1;
  const out: ParsedGameRow = {
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
  const refuse = (code: string, message: string): ParsedGameRow => {
    out.status = 'refused';
    out.reason = code;
    out.message = message;
    out.flags = [];
    return out;
  };

  // 1. Game ID
  const gameId = cell(row, C.GAME_ID);
  if (gameId.length > GAME_IMPORT_LIMITS.MAX_GAME_ID_LENGTH) {
    return refuse(
      R.BAD_GAME_ID,
      `The Game ID is ${gameId.length} characters; at most ${GAME_IMPORT_LIMITS.MAX_GAME_ID_LENGTH} are kept.`
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

  // 3. Times. A time that cannot be read does not refuse the row (F5): the game is kept on its date as a TIME TBD
  // game and the first thing that could not be read is said.
  const startText = cell(row, C.START);
  const endText = cell(row, C.END);
  const lengthText = cell(row, C.LENGTH);
  let timeProblem: string | null = null;
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

  // 4. The two teams are two teams
  const homeKey = scheduleLabelKey(out.homeLabel);
  if (homeKey !== '' && homeKey === scheduleLabelKey(out.awayLabel)) {
    return refuse(R.SAME_TEAM, `The home and away teams are both ${quoted(out.homeLabel)}.`);
  }

  // 5. The week
  const weekText = hasWeek ? cell(row, C.WEEK) : '';
  let weekGiven: number | null = null;
  let badWeekText: string | null = null;
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

  const unreadableTime = (problem: string): ParsedGameRow => {
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

  // 7. The clock: the season's, never the host's.
  const timed = startMin !== null && (endGiven !== null || lengthMin !== null);
  if (timed) {
    const placeAt = (which: 'start' | 'end', label: string, time: string | null) => ({
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
    const startMs = Date.parse(startAt.iso as string);
    let derivedEndRound: 'first' | 'second' | null = null;
    if (endAt !== null) {
      const elapsed = (Date.parse(endAt.iso as string) - startMs) / MS_PER_MINUTE;
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
      const ends = wallOfInstant(startMs + (lengthMin as number) * MS_PER_MINUTE, formatter);
      if (ends.date !== date) {
        return unreadableTime(
          'The game would reach or pass midnight. The latest end this import stores is 23:59.'
        );
      }
      if (ends.time <= (out.startTime as string)) {
        return refuse(
          R.END_NOT_AFTER_START,
          `A game of ${lengthMin} minutes from ${out.startTime} ends at ${ends.time} by the clock, because the clocks go back during it; the import cannot store an end that is not after its start.`
        );
      }
      out.endTime = ends.time;
      out.end = ends.iso;
      const probe = resolveZonedInstant({ date, time: ends.time, timeZone, label: 'End Time' });
      if (probe.findings.some((f) => f.code === TIMING_REASON.WALL_TIME_AMBIGUOUS)) {
        derivedEndRound = probe.iso === ends.iso ? 'first' : 'second';
      }
    }
    out.start = startAt.iso;
    const ambiguous = [startAt, endAt].filter(
      (p): p is NonNullable<typeof p> =>
        p !== null && p.findings.some((f) => f.code === TIMING_REASON.WALL_TIME_AMBIGUOUS)
    );
    if (ambiguous.length > 0 || derivedEndRound !== null) {
      const taken = ambiguous.map((p) => (p.which === 'start' ? out.startTime : out.endTime));
      const parts: string[] = [];
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

  // 8. No time, or no field: a TIME TBD game, never a dropped one
  if (!timed || out.fieldLabel === '') {
    out.status = 'tbd';
    out.tbdReason = R.IMPORTED_WITHOUT_TIME;
  }
  return out;
}

function refuseRepeats(parsed: ParsedGameRow[]): void {
  const contentKeys = new Set<string>();
  const gameIds = new Set<string>();
  for (const r of parsed) {
    if (r.status === 'refused') continue;
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

// ------------------------------------------------------------------------------------------------ staging

export interface StagedGameRow {
  source_row_number: number;
  normalized_payload: Record<string, unknown> | null;
  validation_errors: Array<{ code: string; message: string }>;
}

/** Core's `toStagedGameRow`: the keys `apply_game_import_job` reads, and nothing else. */
export function toStagedGameRow(row: ParsedGameRow): StagedGameRow {
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
      flags: row.flags
        .map((flag) => flag.code)
        .filter((code) => GAME_IMPORT_STAGED_FLAGS.includes(code)),
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

/** A cell as text, by the import pipeline's one cleaner, cut to the cell limit. */
const cleanCell = (value: unknown): string =>
  sanitizeImportText(value, GAME_IMPORT_LIMITS.MAX_CELL_LENGTH);

export interface GameChunkResult {
  /** Set when the whole file is refused: nothing is staged. */
  refusal: { code: string; message: string; column?: string } | null;
  staged: Array<StagedGameRow & { raw_payload: Record<string, string> }>;
  summary: {
    rows: number;
    ok: number;
    tbd: number;
    refused: number;
    flagged: number;
    by_reason: Record<string, number>;
    dropped_columns: string[];
    /** Every flag of every kept row, the parse's own warnings (`bad-time`, `bad-week`) included. */
    warnings: Array<{ row: number; code: string; message: string }>;
    refused_rows: Array<{ row: number; code: string; message: string }>;
  };
}

/**
 * One request's rows, read and made ready to stage. The allowlist comes first: only the columns of plan 4.3 are kept
 * (by the header's normalised name), each cell is cleaned, and everything else of the row is dropped before the parse
 * sees it. `raw_payload` is those same columns as typed, under the template's names.
 */
export function stageGameChunk({
  headers,
  rows,
  season,
  rowOffset,
}: {
  headers: unknown[];
  rows: Array<Record<string, unknown>>;
  season: GameImportSeason | null;
  rowOffset: number;
}): GameChunkResult {
  const byKey = new Map<string, string>(
    Object.values(C).map((name) => [scheduleLabelKey(name), name])
  );
  // The header row as the file wrote it, cut to what a header can be; names the allowlist does not hold stay in the
  // list (so the parse can report them as dropped) and their VALUES are never read.
  const fileHeaders = headers
    .slice(0, GAME_IMPORT_LIMITS.MAX_HEADERS)
    .map((h) => cleanCell(h))
    .filter((h) => h.trim() !== '');
  const kept = fileHeaders.filter((h) => byKey.has(scheduleLabelKey(h)));
  const allowlisted = rows.map((row) => {
    const out: Record<string, string> = {};
    for (const h of kept) out[h] = cleanCell(row?.[h]);
    return out;
  });
  const parsed = parseGameImportRows({
    headers: fileHeaders,
    rows: allowlisted,
    season,
    rowOffset,
  });
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
    const raw: Record<string, string> = {};
    for (const h of kept) raw[byKey.get(scheduleLabelKey(h)) as string] = allowlisted[i][h];
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

// ------------------------------------------------------------------------------------------------ the job's season

/** The season row a games import is read against. */
export interface GameImportSeasonRow {
  id: string;
  timezone: string | null;
  season_start: string | null;
  season_end: string | null;
}

/** The part of a supabase client this read uses. */
export interface SeasonQuery {
  select(columns: string): SeasonQuery;
  eq(column: string, value: string): SeasonQuery;
  maybeSingle(): PromiseLike<{ data: unknown; error: { message?: string } | null }>;
}
export interface SeasonReader {
  from(table: string): SeasonQuery;
}

/**
 * The season a games import job imports into: its clock and its window. The season is the JOB's, of the job's
 * organization, never the request's word. No row is `data: null` with no error (the caller answers `season_missing`).
 */
export async function loadGameImportSeason(
  client: SeasonReader,
  { seasonSettingsId, organizationId }: { seasonSettingsId: string | null; organizationId: string }
): Promise<{ data: GameImportSeasonRow | null; error: { message?: string } | null }> {
  if (!seasonSettingsId) return { data: null, error: null };
  const { data, error } = await client
    .from('season_settings')
    .select('id, timezone, season_start, season_end')
    .eq('id', seasonSettingsId)
    .eq('organization_id', organizationId)
    .maybeSingle();
  return { data: (data as GameImportSeasonRow | null) ?? null, error: error ?? null };
}

// ------------------------------------------------------------------------------------------------ the confirm (F7)

const FIXED_COUNTS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  rows: ['staged', 'refused', 'skipped', 'games', 'time_tbd'],
  games: ['inserted', 'updated', 'unchanged'],
  time_tbd: ['inserted', 'updated', 'unchanged', 'removed', 'converted'],
  created: ['divisions', 'venues', 'fields', 'teams', 'outside_teams', 'slots'],
});

/** The most keys a set of confirmed counts may hold. */
export const GAME_IMPORT_CONFIRM_MAX_KEYS = 120;

export type ConfirmCounts = Record<string, number | boolean>;

const count = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** Core's `scheduleImportConfirmCounts`: the counts the confirm screen shows, flat. */
export function gameImportConfirmCounts(result: unknown): ConfirmCounts {
  const r = record(result);
  const out: ConfirmCounts = {
    arrive_published: r.arrive_published === true,
    nothing_to_apply: r.nothing_to_apply === true,
  };
  for (const [group, keys] of Object.entries(FIXED_COUNTS)) {
    const source = record(r[group]);
    for (const key of keys) out[`${group}.${key}`] = count(source[key]);
  }
  for (const [reason, n] of Object.entries(record(r.refused_by_reason))) {
    if (count(n) !== 0) out[`refused_by_reason.${reason}`] = count(n);
  }
  for (const [reason, n] of Object.entries(record(record(r.games).skipped))) {
    if (count(n) !== 0) out[`games.skipped.${reason}`] = count(n);
  }
  out.not_in_file = count(record(r.not_in_file).count);
  for (const warning of Array.isArray(r.warnings) ? r.warnings : []) {
    const type = String(record(warning).type ?? 'unknown');
    out[`warnings.${type}`] = count(out[`warnings.${type}`]) + 1;
  }
  return out;
}

/** Core's `isScheduleImportConfirmCounts`. */
export function isGameImportConfirmCounts(value: unknown): value is ConfirmCounts {
  const r = record(value);
  const keys = Object.keys(r);
  if (keys.length === 0 || keys.length > GAME_IMPORT_CONFIRM_MAX_KEYS) return false;
  if (typeof r.arrive_published !== 'boolean' || typeof r.nothing_to_apply !== 'boolean')
    return false;
  if (typeof r['rows.staged'] !== 'number') return false;
  return keys.every(
    (key) =>
      key.length <= 80 &&
      (typeof r[key] === 'boolean' ||
        (typeof r[key] === 'number' && Number.isFinite(r[key] as number)))
  );
}

/** Core's `diffScheduleImportConfirmCounts`: the keys that differ, sorted. */
export function diffGameImportConfirmCounts(confirmed: unknown, current: unknown): string[] {
  const a = record(confirmed);
  const b = record(current);
  const norm = (v: unknown): number | boolean => (typeof v === 'boolean' ? v : count(v));
  return [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .filter((key) => norm(a[key] ?? 0) !== norm(b[key] ?? 0))
    .sort();
}

export const GAME_IMPORT_PREVIEW_STALE = 'game_import_preview_stale';

/** A database call as supabase-js answers one. */
export type GameImportRpc = (
  name: string,
  params: Record<string, unknown>
) => PromiseLike<{
  data: unknown;
  error: { code?: string; message?: string; details?: string | null } | null;
}>;

export type GameImportApplyOutcome =
  | { kind: 'applied'; result: unknown }
  | {
      kind: 'stale';
      code: typeof GAME_IMPORT_PREVIEW_STALE;
      message: string;
      differing: string[];
      confirmed: ConfirmCounts;
      current: ConfirmCounts;
      preview: unknown;
    }
  | {
      kind: 'error';
      stage: 'preview' | 'apply';
      error: { code?: string; message?: string; details?: string | null };
    };

/**
 * The confirm of a games import: run the dry run again AS THE CALLER, compare its counts with the ones the admin
 * confirmed, and apply only when every one of them still holds. When any differs nothing is written, and the answer
 * carries both sets of counts and the fresh preview, so the screen can show what changed.
 *
 * A job that already finished answers with the result it stored (`replayed: true`): a retry after a lost response is
 * not a stale preview.
 *
 * Declared: the dry run and the apply are two statements, so a change that lands between them (milliseconds) is not
 * seen here; the apply then plans against what it finds and its result says what it did.
 */
export async function applyGameImportConfirmed({
  rpc,
  jobId,
  confirmed,
}: {
  rpc: GameImportRpc;
  jobId: string;
  confirmed: ConfirmCounts;
}): Promise<GameImportApplyOutcome> {
  const preview = await rpc('apply_game_import_job', { p_import_job_id: jobId, p_dry_run: true });
  if (preview.error) return { kind: 'error', stage: 'preview', error: preview.error };
  if (record(preview.data).replayed === true) return { kind: 'applied', result: preview.data };
  const current = gameImportConfirmCounts(preview.data);
  const differing = diffGameImportConfirmCounts(confirmed, current);
  if (differing.length > 0) {
    return {
      kind: 'stale',
      code: GAME_IMPORT_PREVIEW_STALE,
      message:
        'The schedule changed after this preview was made, so the import would no longer do what was confirmed. Nothing was written. Review the new preview and confirm again.',
      differing,
      confirmed,
      current,
      preview: preview.data,
    };
  }
  const applied = await rpc('apply_game_import_job', { p_import_job_id: jobId, p_dry_run: false });
  if (applied.error) return { kind: 'error', stage: 'apply', error: applied.error };
  return { kind: 'applied', result: applied.data };
}
