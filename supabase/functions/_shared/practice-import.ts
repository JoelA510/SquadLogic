/**
 * The practice schedule import in the Edge function (plan `docs/changes/2026-11-03-schedule-expansion.md` 4.11.2 to
 * 4.11.6; PR 11, task L1): reading a practice file into the rows `apply_practice_import_job` (migration
 * `20261123010000`) reads from `staging_import_rows`.
 *
 * **A mirror, held to core.** An Edge Function cannot import `packages/core`, so this file is a second copy of
 * `packages/core/src/practiceImport/parseRows.js`, the decision keys of `mapping.js` and `staging.js`
 * (`toStagedPracticeRow`, `stagePracticeFile`). Core is the canonical one (the browser's own reading and the mock run
 * it). `tests/practiceImportEdgeParity.test.js` (Vitest) runs both over the shipped fixtures and over the vectors of
 * `./tests/fixtures/practice-import.vectors.json` (built from core there) and requires the same staged rows, key for
 * key, under three host zones; `./tests/practice-import_test.ts` (Deno, CI) asks this build the same vectors. Change
 * both copies, or neither.
 *
 * **There is no clock.** A practice row is a weekday, two wall times and a date range: nothing here converts an
 * instant or reads the host's zone (plan 4.11.6). The date, time and length readers are the games import's own
 * (`./schedule-import.ts`), used, not copied, as core's parse uses core's.
 *
 * **Only the columns of plan 4.11.2 are read.** Anything else of the file (a coach, an email, a phone, a note) is
 * dropped before a value is read from it, and is neither staged nor returned.
 *
 * **The whole file is one request** (core's `PRACTICE_IMPORT_STAGE_LIMITS` says why): the parse judges the file as a
 * whole, and a row key is unique in it.
 */

import {
  parseScheduleDate,
  parseScheduleLength,
  parseScheduleTime,
  scheduleLabelKey,
} from './schedule-import.ts';

// ------------------------------------------------------------------------------------------------ the closed lists

/** The codes the stage can give (core: `PRACTICE_IMPORT_REASON`, the parse's part of it). */
export const PRACTICE_IMPORT_REASON = Object.freeze({
  MISSING_COLUMN: 'missing-column',
  DUPLICATE_COLUMN: 'duplicate-column',
  TOO_MANY_ROWS: 'too-many-rows',
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
  UNKNOWN_LOCATION: 'unknown-location',
  UNKNOWN_FIELD: 'unknown-field',
  TEAM_IN_TWO_DIVISIONS: 'team-in-two-divisions',
  DUPLICATE_ROW: 'duplicate-row',
  DIVISION_NOT_RESERVED: 'division-not-reserved',
} as const);
const R = PRACTICE_IMPORT_REASON;

/** The parse's flags the SQL carries through (core: `PRACTICE_STAGED_FLAGS`). */
export const PRACTICE_STAGED_FLAGS: readonly string[] = Object.freeze([R.DIVISION_NOT_RESERVED]);

/** Limits (core: `PRACTICE_IMPORT_LIMITS` and `PRACTICE_IMPORT_STAGE_LIMITS`). */
export const PRACTICE_IMPORT_LIMITS = Object.freeze({
  MAX_ROWS: 2400,
  MAX_CAPACITY: 32767,
  MAX_CELL_LENGTH: 500,
  MAX_HEADERS: 200,
});

/** The columns of plan 4.11.2 (core: `PRACTICE_IMPORT_COLUMNS`). */
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
} as const);
const C = PRACTICE_IMPORT_COLUMNS;

/** Header names read as another column (core: `PRACTICE_IMPORT_HEADER_ALIASES`). */
export const PRACTICE_IMPORT_HEADER_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  [scheduleLabelKey('Venue')]: C.LOCATION,
  [scheduleLabelKey('Half')]: C.SUBUNIT,
  [scheduleLabelKey('Side')]: C.SUBUNIT,
});

const DAY_WORDS: Readonly<Record<string, string>> = Object.freeze({
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

/** Core's `parsePracticeDay`. */
export function parsePracticeDay(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  const word = text.trim().toLowerCase();
  return Object.hasOwn(DAY_WORDS, word) ? DAY_WORDS[word] : null;
}

// ------------------------------------------------------------------------------------------------ keys

const tuple = (...parts: string[]): string => JSON.stringify(parts);
const divisionDecisionKey = (division: string): string => scheduleLabelKey(division);
const locationDecisionKey = (location: string): string => scheduleLabelKey(location);
const fieldDecisionKey = (location: string, field: string): string =>
  tuple(scheduleLabelKey(location), scheduleLabelKey(field));
const subunitDecisionKey = (location: string, field: string, subunit: string): string =>
  tuple(scheduleLabelKey(location), scheduleLabelKey(field), scheduleLabelKey(subunit));
const teamDecisionKey = (division: string, team: string): string =>
  tuple(scheduleLabelKey(division), scheduleLabelKey(team));

// ------------------------------------------------------------------------------------------------ the parse

const pad2 = (n: number): string => String(n).padStart(2, '0');
const hhmm = (total: number): string => `${pad2(Math.floor(total / 60))}:${pad2(total % 60)}`;
const LATEST_END = 23 * 60 + 59;
const WHOLE_NUMBER = /^-?\d+$/;
const quoted = (text: string): string => `"${text.length > 60 ? `${text.slice(0, 57)}...` : text}"`;

export interface PracticeImportFlag {
  code: string;
  message: string;
  details: Record<string, unknown>;
}

export interface ParsedPracticeRow {
  rowNumber: number;
  rowKey: string;
  status: 'placement' | 'open' | 'hold' | 'refused';
  reason: string | null;
  message: string | null;
  teamLabel: string;
  divisionLabel: string;
  day: string | null;
  startTime: string | null;
  endTime: string | null;
  locationLabel: string;
  fieldLabel: string;
  subunitLabel: string;
  capacity: number | null;
  validFrom: string | null;
  validUntil: string | null;
  dateSources: { from: string; until: string } | null;
  flags: PracticeImportFlag[];
}

export interface PracticeImportParseResult {
  ok: boolean;
  refusal: { code: string; message: string; column?: string } | null;
  droppedColumns: string[];
  rows: ParsedPracticeRow[];
  counts: {
    rows: number;
    placements: number;
    open: number;
    holds: number;
    refused: number;
    flagged: number;
  };
  byReason: Record<string, number>;
}

export interface PracticeImportDates {
  startDate?: string | null;
  endDate?: string | null;
}

export interface PracticeImportConfirmDates {
  validFrom?: string | null;
  validUntil?: string | null;
}

function fileRefusal(code: string, message: string, column?: string): PracticeImportParseResult {
  return {
    ok: false,
    refusal: column === undefined ? { code, message } : { code, message, column },
    droppedColumns: [],
    rows: [],
    counts: { rows: 0, placements: 0, open: 0, holds: 0, refused: 0, flagged: 0 },
    byReason: {},
  };
}

/** A date from the caller: present and not a date is the caller's defect (core: `callerDate`). */
function callerDate(value: unknown, what: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  const date = parseScheduleDate(value);
  if (date === null) {
    throw new TypeError(
      `parsePracticeRows: ${what} must be YYYY-MM-DD, got ${JSON.stringify(value)}`
    );
  }
  return date;
}

/** Core's `parsePracticeRows`. */
export function parsePracticeRows({
  headers,
  rows,
  season,
  dates,
}: {
  headers: unknown[];
  rows: Array<Record<string, unknown>>;
  season?: PracticeImportDates | null;
  dates?: PracticeImportConfirmDates | null;
}): PracticeImportParseResult {
  if (!Array.isArray(headers)) throw new TypeError('parsePracticeRows: headers must be an array');
  if (!Array.isArray(rows)) throw new TypeError('parsePracticeRows: rows must be an array');

  const header = new Map<string, string>();
  const droppedColumns: string[] = [];
  const byKey = new Map<string, string>(
    Object.values(C).map((name) => [scheduleLabelKey(name), name])
  );
  for (const raw of headers) {
    const written = String(raw ?? '');
    const key = scheduleLabelKey(written);
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

  const cell = (row: Record<string, unknown>, column: string): string => {
    const written = header.get(column);
    if (written === undefined) return '';
    const value = row?.[written];
    return value === undefined || value === null ? '' : String(value).trim();
  };

  const bounds = { seasonStart, seasonEnd, confirmFrom, confirmUntil };
  const parsed = rows.map((row, index) => parseRow(row, index, cell, bounds));
  refuseRepeats(parsed);

  const counts = { rows: parsed.length, placements: 0, open: 0, holds: 0, refused: 0, flagged: 0 };
  const byReason: Record<string, number> = {};
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

interface Bounds {
  seasonStart: string | null;
  seasonEnd: string | null;
  confirmFrom: string | null;
  confirmUntil: string | null;
}

function parseRow(
  row: Record<string, unknown>,
  index: number,
  cell: (row: Record<string, unknown>, column: string) => string,
  bounds: Bounds
): ParsedPracticeRow {
  const rowNumber = index + 1;
  const out: ParsedPracticeRow = {
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
  const refuse = (code: string, message: string): ParsedPracticeRow => {
    out.status = 'refused';
    out.reason = code;
    out.message = message;
    out.flags = [];
    return out;
  };

  // 1. Use
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
  const kind: 'hold' | 'open' | 'placement' =
    use === 'hold' ? 'hold' : out.teamLabel === '' ? 'open' : 'placement';
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

  // 3. Times
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
  let endMin: number;
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
    endMin = startMin + (lengthGiven as number);
    if (endMin > LATEST_END) {
      return refuse(
        R.END_NOT_AFTER_START,
        'The practice would reach or pass midnight. The latest end this import stores is 23:59.'
      );
    }
  }
  out.startTime = hhmm(startMin);
  out.endTime = hhmm(endMin);

  // 4. Capacity
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

  // 5. Dates
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

  if (kind === 'placement' && scheduleLabelKey(out.divisionLabel) === '') {
    return refuse(R.UNKNOWN_DIVISION, 'The Division is blank.');
  }
  if (scheduleLabelKey(out.locationLabel) === '') {
    return refuse(R.UNKNOWN_LOCATION, 'The Location is blank.');
  }
  if (scheduleLabelKey(out.fieldLabel) === '') {
    return refuse(R.UNKNOWN_FIELD, 'The Field is blank.');
  }

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

/** Core's `refuseRepeats`: a team label in two divisions, and the same practice twice. Changes the rows in place. */
function refuseRepeats(parsed: ParsedPracticeRow[]): void {
  const divisionsOf = new Map<string, Set<string>>();
  for (const r of parsed) {
    if (r.status !== 'placement') continue;
    const division = scheduleLabelKey(r.divisionLabel);
    if (division === '') continue;
    const team = scheduleLabelKey(r.teamLabel);
    divisionsOf.set(team, (divisionsOf.get(team) ?? new Set<string>()).add(division));
  }
  for (const r of parsed) {
    if (r.status !== 'placement') continue;
    const division = scheduleLabelKey(r.divisionLabel);
    const named = divisionsOf.get(scheduleLabelKey(r.teamLabel));
    if (division === '' || named === undefined || named.size < 2) continue;
    r.status = 'refused';
    r.reason = R.TEAM_IN_TWO_DIVISIONS;
    r.flags = [];
    r.message = `The team ${quoted(r.teamLabel)} is under more than one division in this file, and a label alone cannot say whether that is two teams or a typo. Fix the Division, or make the labels differ (then map each to its team).`;
  }

  const seen = new Map<string, number>();
  for (const r of parsed) {
    if (r.status === 'refused') continue;
    const content = JSON.stringify([
      r.status,
      r.status === 'placement' ? scheduleLabelKey(r.divisionLabel) : null,
      scheduleLabelKey(r.teamLabel),
      scheduleLabelKey(r.locationLabel),
      scheduleLabelKey(r.fieldLabel),
      scheduleLabelKey(r.subunitLabel) || null,
      r.day,
      r.startTime,
      r.endTime,
      r.validFrom,
      r.validUntil,
      r.capacity,
    ]);
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

// ------------------------------------------------------------------------------------------------ the staged row

export interface StagedPracticeRow {
  source_row_number: number;
  normalized_payload: Record<string, unknown> | null;
  validation_errors: Array<{ code: string; message: string }>;
}

/** Core's `toStagedPracticeRow`. */
export function toStagedPracticeRow(row: ParsedPracticeRow): StagedPracticeRow {
  if (row.status === 'refused') {
    return {
      source_row_number: row.rowNumber,
      normalized_payload: null,
      validation_errors: [{ code: String(row.reason), message: String(row.message ?? '') }],
    };
  }
  const placement = row.status === 'placement';
  const subunit = scheduleLabelKey(row.subunitLabel ?? '') === '' ? '' : row.subunitLabel.trim();
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
      division_key: placement ? divisionDecisionKey(row.divisionLabel) : '',
      location: row.locationLabel.trim(),
      location_key: locationDecisionKey(row.locationLabel),
      field: row.fieldLabel.trim(),
      field_key: fieldDecisionKey(row.locationLabel, row.fieldLabel),
      subunit,
      subunit_key:
        subunit === ''
          ? ''
          : subunitDecisionKey(row.locationLabel, row.fieldLabel, row.subunitLabel),
      team: placement ? row.teamLabel.trim() : '',
      team_key: placement ? teamDecisionKey(row.divisionLabel, row.teamLabel) : '',
    },
    validation_errors: [],
  };
}

// ------------------------------------------------------------------------------------------------ the stage

const READ_HEADER_KEYS = new Set<string>([
  ...Object.values(C).map((name) => scheduleLabelKey(name)),
  ...Object.keys(PRACTICE_IMPORT_HEADER_ALIASES),
]);

/** Core's `practiceImportReadsHeader`. */
export const practiceImportReadsHeader = (header: unknown): boolean =>
  READ_HEADER_KEYS.has(scheduleLabelKey(String(header ?? '')));

export interface PracticeStageSummary {
  rows: number;
  placements: number;
  open: number;
  holds: number;
  refused: number;
  flagged: number;
  by_reason: Record<string, number>;
  dropped_columns: string[];
  warnings: Array<{ row: number; code: string; message: string }>;
  refused_rows: Array<{ row: number; code: string; message: string }>;
}

export interface PracticeStageResult {
  refusal: { code: string; message: string; column?: string } | null;
  staged: Array<StagedPracticeRow & { raw_payload: Record<string, string> }>;
  summary: PracticeStageSummary;
}

/** Core's `stagePracticeFile`. */
export function stagePracticeFile({
  headers,
  rows,
  season,
  dates,
  clean,
}: {
  headers: unknown[];
  rows: Array<Record<string, unknown>>;
  season?: PracticeImportDates | null;
  dates?: PracticeImportConfirmDates | null;
  clean: (value: unknown, max: number) => string;
}): PracticeStageResult {
  if (typeof clean !== 'function') {
    throw new TypeError('stagePracticeFile: clean must be the cell cleaner (sanitizeImportText)');
  }
  if (!Array.isArray(headers)) throw new TypeError('stagePracticeFile: headers must be an array');
  if (!Array.isArray(rows)) throw new TypeError('stagePracticeFile: rows must be an array');
  const cleanCell = (value: unknown): string =>
    clean(value, PRACTICE_IMPORT_LIMITS.MAX_CELL_LENGTH);
  const named = headers
    .slice(0, PRACTICE_IMPORT_LIMITS.MAX_HEADERS)
    .map((h) => ({ original: String(h ?? ''), cleaned: cleanCell(h) }))
    .filter((h) => h.cleaned.trim() !== '');
  const fileHeaders = named.map((h) => h.cleaned);
  const keptNames = named.filter((h) => practiceImportReadsHeader(h.cleaned));
  const allowlisted = rows.map((row) => {
    const out: Record<string, string> = {};
    for (const h of keptNames) out[h.cleaned] = cleanCell(row?.[h.original]);
    return out;
  });
  const empty: PracticeStageSummary = {
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
  const canonical = (cleaned: string): string => {
    const key = scheduleLabelKey(cleaned);
    return (
      Object.values(C).find((name) => scheduleLabelKey(name) === key) ??
      PRACTICE_IMPORT_HEADER_ALIASES[key]
    );
  };
  const staged = parsed.rows.map((row, i) => {
    const raw: Record<string, string> = {};
    for (const h of keptNames) raw[canonical(h.cleaned)] = allowlisted[i][h.cleaned];
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
