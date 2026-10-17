/**
 * The Deno twin of core `utils/practiceLiveDates.js` (M4.7,
 * `docs/PLAN_SCORING_DATE_MODEL.md` §3.1): the dates a weekly practice
 * assignment is live on, for `scoring-engine.ts`.
 *
 * The rules are core's and are documented there. The `daterange` reading is
 * `_shared/calendar/practiceExceptions.ts`'s `practiceRangeBounds` /
 * `practiceRangeLowerBound` -- the readers the calendar feed ships (and
 * `icsFeed.ts`'s `dateRangeBounds` is an alias of), already pinned to core's
 * by `tests/practiceOccurrences.test.js` -- so no third parser exists.
 * `tests/scoringEngineDrift.test.js` holds this file and core to the same
 * answers. **No `Date` is constructed** (GAP-30): day numbers only.
 *
 * Saved practice exceptions (the M4.7 follow-up, plan Q1) go through the
 * calendar's `applyPracticeExceptions` twin, exactly as core's
 * `applyExceptionsToLiveRows` sends them through core's helper.
 *
 * @module _shared/engines/practice-live-dates
 */

import {
  PRACTICE_EXCEPTION_CODE,
  applyPracticeExceptions,
  isoDateOfDayNumber,
  isoDayNumber,
  practiceRangeBounds,
  practiceRangeLowerBound,
} from '../calendar/practiceExceptions.ts';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const WALL_TIME = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;

/** Core `LIVE_SPAN_STATUS`. */
export const LIVE_SPAN_STATUS = Object.freeze({
  LIVE: 'live',
  NONE: 'none',
  UNREADABLE: 'unreadable',
} as const);

export type LiveSpan =
  | { status: 'live'; first: number; last: number }
  | { status: 'none' }
  | { status: 'unreadable' };

/** Core `calendarDayNumber`. */
export function calendarDayNumber(value: unknown): number | null {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return null;
  const day = isoDayNumber(value);
  return Number.isFinite(day) && isoDateOfDayNumber(day) === value ? day : null;
}

/** Core `wallSeconds`. */
export function wallSeconds(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = WALL_TIME.exec(value);
  if (match === null) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3] ?? 0);
}

/** Core `assignmentLiveSpan`. */
export function assignmentLiveSpan(input: {
  firstDay: number;
  lastDay: number;
  range?: unknown;
  notBefore?: string | null;
}): LiveSpan {
  const { firstDay, lastDay, range, notBefore = null } = input;
  let from = firstDay;
  let to = lastDay;
  if (range !== undefined && range !== null) {
    const bounds = practiceRangeBounds(range);
    if (bounds !== null) {
      from = Math.max(from, isoDayNumber(bounds.first));
      to = Math.min(to, isoDayNumber(bounds.last));
    } else {
      const lower = practiceRangeLowerBound(range);
      if (lower === null || !lower.upperUnbounded) return { status: 'unreadable' };
      from = Math.max(from, isoDayNumber(lower.first));
    }
  }
  if (notBefore !== null && notBefore !== undefined) {
    const floor = calendarDayNumber(notBefore);
    if (floor === null) throw new TypeError(`notBefore ${String(notBefore)} is not a date`);
    from = Math.max(from, floor);
  }
  const first = firstDay + Math.ceil((from - firstDay) / 7) * 7;
  const last = firstDay + Math.floor((to - firstDay) / 7) * 7;
  if (first > last) return { status: 'none' };
  return { status: 'live', first, last };
}

/** Core `sharedLiveDates`. */
export function sharedLiveDates(
  a: { first: number; last: number },
  b: { first: number; last: number }
): { count: number; firstDate: string | null } {
  if ((((a.first - b.first) % 7) + 7) % 7 !== 0) return { count: 0, firstDate: null };
  const lo = Math.max(a.first, b.first);
  const hi = Math.min(a.last, b.last);
  if (lo > hi) return { count: 0, firstDate: null };
  return { count: (hi - lo) / 7 + 1, firstDate: isoDateOfDayNumber(lo) };
}

/** Core `peakLiveCount`. */
export function peakLiveCount(spans: Array<{ first: number; last: number }>): number {
  const events: Array<[number, number]> = [];
  for (const span of spans) {
    events.push([span.first, 1], [span.last + 1, -1]);
  }
  events.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  let live = 0;
  let peak = 0;
  for (const [, delta] of events) {
    live += delta;
    if (live > peak) peak = live;
  }
  return peak;
}

/** The `day_of_week` enum, indexed from Sunday (core `DAY_OF_WEEK_ENUM`). */
const DAY_OF_WEEK_ENUM: readonly string[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** Core `weekdayOfDay`: day 0 (1970-01-01) is a Thursday. */
const weekdayOfDay = (day: number): string => DAY_OF_WEEK_ENUM[(((day + 4) % 7) + 7) % 7];

type Span = { first: number; last: number };
/** Core's piece: a weekly span, or explicit day numbers. */
export type Piece = { span?: Span; days?: number[] };

const spanDays = (span: Span): number[] => {
  const days: number[] = [];
  for (let d = span.first; d <= span.last; d += 7) days.push(d);
  return days;
};

/** Core `sharedPieceDates`. */
export function sharedPieceDates(a: Piece, b: Piece): { count: number; firstDate: string | null } {
  if (a.days === undefined && b.days === undefined) {
    return sharedLiveDates(a.span as Span, b.span as Span);
  }
  const left = new Set(a.days ?? spanDays(a.span as Span));
  const shared = (b.days ?? spanDays(b.span as Span)).filter((d) => left.has(d));
  if (shared.length === 0) return { count: 0, firstDate: null };
  return { count: shared.length, firstDate: isoDateOfDayNumber(Math.min(...shared)) };
}

/** Core `peakPieceCount`. */
export function peakPieceCount(pieces: Piece[]): number {
  if (pieces.every((p) => p.days === undefined)) {
    return peakLiveCount(pieces.map((p) => p.span as Span));
  }
  const load = new Map<number, number>();
  let peak = 0;
  for (const piece of pieces) {
    for (const day of piece.days ?? spanDays(piece.span as Span)) {
      const count = (load.get(day) ?? 0) + 1;
      load.set(day, count);
      if (count > peak) peak = count;
    }
  }
  return peak;
}

/** Core `REPORTED_EXCEPTION_FINDINGS`. */
export const REPORTED_EXCEPTION_FINDINGS: readonly string[] = Object.freeze([
  PRACTICE_EXCEPTION_CODE.ROW_UNREAD,
  PRACTICE_EXCEPTION_CODE.ROW_REFUSED,
  PRACTICE_EXCEPTION_CODE.RELOCATION_UNMATCHED,
  PRACTICE_EXCEPTION_CODE.TBD_SHADOWED,
  PRACTICE_EXCEPTION_CODE.UNREADABLE,
]);

const order = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const text = (value: unknown): string => String(value ?? '');

export interface LiveRow {
  id?: unknown;
  teamId: string;
  slotId: string;
  firstDay: number;
  lastDay: number;
  range?: unknown;
  span: Span | null;
}

export interface ExceptionFinding {
  code: string;
  assignmentId: unknown;
  exceptionId: unknown;
  date?: string;
}

/** Core `applyExceptionsToLiveRows`; its rules and their reasons are documented there. */
export function applyExceptionsToLiveRows(input: {
  rows: LiveRow[];
  exceptions: unknown[];
  slotFirstDays: Map<string, number>;
}): {
  pieces: Array<Array<{ slotId: string; days: number[] }> | null>;
  timeTbd: Array<{ row: number; exceptionId: unknown; code: string; dates: string[] }>;
  findings: ExceptionFinding[];
} {
  const { rows, exceptions, slotFirstDays } = input;
  // deno-lint-ignore no-explicit-any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type Rec = Record<string, any>;
  const isRecord = (value: unknown): value is Rec =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
  const rowById = new Map<unknown, number>();
  rows.forEach((row, index) => {
    if (row.id === undefined || row.id === null || rowById.has(row.id)) return;
    rowById.set(row.id, index);
  });

  const byTeam = new Map<string, Rec[]>();
  const unnamed: unknown[] = [];
  for (const exception of exceptions) {
    const index = isRecord(exception) ? rowById.get(exception.assignment_id) : undefined;
    if (!isRecord(exception) || index === undefined) {
      unnamed.push(exception);
      continue;
    }
    const targetDay = slotFirstDays.get(exception.practice_slot_id);
    const resolved = {
      ...exception,
      slot:
        targetDay === undefined
          ? null
          : { id: exception.practice_slot_id, day_of_week: weekdayOfDay(targetDay) },
    };
    const team = rows[index].teamId;
    const list = byTeam.get(team) ?? [];
    list.push(resolved);
    byTeam.set(team, list);
  }

  const pieces: Array<Array<{ slotId: string; days: number[] }> | null> = rows.map(() => null);
  const tbdByKey = new Map<
    string,
    { row: number; exceptionId: unknown; code: string; dates: string[] }
  >();
  const findings: ExceptionFinding[] = [];
  const keep = (result: { findings: ExceptionFinding[] }) => {
    for (const finding of result.findings) {
      if (REPORTED_EXCEPTION_FINDINGS.includes(finding.code)) findings.push(finding);
    }
  };
  const tbd = (index: number, exceptionId: unknown, code: string, date: string | null) => {
    const key = `${index}|${text(exceptionId)}|${code}|${date === null ? 'undated' : 'dated'}`;
    const entry = tbdByKey.get(key) ?? { row: index, exceptionId, code, dates: [] };
    if (date !== null) entry.dates.push(date);
    tbdByKey.set(key, entry);
  };

  const rowsOfTeam = new Map<string, Array<{ id: unknown; index: number }>>();
  for (const [id, index] of rowById) {
    const team = rows[index].teamId;
    const list = rowsOfTeam.get(team) ?? [];
    list.push({ id, index });
    rowsOfTeam.set(team, list);
  }
  for (const [team, teamExceptions] of byTeam) {
    const teamRows = rowsOfTeam.get(team) ?? [];
    const helperRows = teamRows.map(({ id, index }) => {
      const row = rows[index];
      return {
        id,
        effective_date_range: helperRange(row),
        slot: { day_of_week: weekdayOfDay(row.firstDay) },
      };
    });
    const result = applyPracticeExceptions({ rows: helperRows, exceptions: teamExceptions });
    keep(result);
    for (const { index } of teamRows) pieces[index] = [];
    const daysBySlot = new Map<string, { index: number; slotId: string; days: number[] }>();
    for (const o of result.occurrences) {
      const index = rowById.get(o.assignmentId) as number;
      const row = rows[index];
      const day = isoDayNumber(o.date);
      if (o.kind === 'time_tbd') {
        tbd(index, o.exceptionId, o.code, o.date);
        continue;
      }
      if (
        o.kind === 'series' &&
        (row.span === null || day < row.span.first || day > row.span.last)
      ) {
        continue;
      }
      const slotId = o.kind === 'relocated' ? String(o.slot.id) : row.slotId;
      const key = `${index}|${slotId}`;
      const entry = daysBySlot.get(key) ?? { index, slotId, days: [] };
      entry.days.push(day);
      daysBySlot.set(key, entry);
    }
    for (const { index, slotId, days } of daysBySlot.values()) {
      (pieces[index] as Array<{ slotId: string; days: number[] }>).push({
        slotId,
        days: days.sort((x, y) => x - y),
      });
    }
    for (const entry of result.undated) {
      tbd(rowById.get(entry.assignmentId) as number, entry.exceptionId, entry.code, null);
    }
  }
  if (unnamed.length > 0) keep(applyPracticeExceptions({ rows: [], exceptions: unnamed }));

  const timeTbd = [...tbdByKey.values()].sort(
    (a, b) =>
      a.row - b.row ||
      order(text(a.exceptionId), text(b.exceptionId)) ||
      order(a.code, b.code) ||
      a.dates.length - b.dates.length
  );
  return { pieces, timeTbd, findings };
}

/** Core `helperRange`. */
function helperRange(row: LiveRow): unknown {
  const validityEnd = isoDateOfDayNumber(row.lastDay);
  if (row.range === undefined || row.range === null) {
    return `[${isoDateOfDayNumber(row.firstDay)},${validityEnd}]`;
  }
  if (practiceRangeBounds(row.range) !== null) return row.range;
  const lower = practiceRangeLowerBound(row.range) as { first: string };
  return `[${lower.first},${validityEnd}]`;
}
