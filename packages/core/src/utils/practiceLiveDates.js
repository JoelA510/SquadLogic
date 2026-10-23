/**
 * The dates a weekly practice assignment is live on (M4.7,
 * `docs/PLAN_SCORING_DATE_MODEL.md` §3.1).
 *
 * An assignment is live on date D when D falls on its slot's weekday, inside
 * the assignment's own range, and inside the slot's validity. The scoring
 * engines used to reduce a slot to its first occurrence's instant and ignore
 * both ranges, so two series of one coach that never meet were reported as a
 * clash and two that do meet, but started on different dates, were not.
 *
 * ## The contract
 *
 * - A slot is dated by `firstDate` (its first occurrence, already on its
 *   weekday: the page's `getSlotDateForDay`) and `lastDate` (the end of its
 *   validity, inclusive). Its live dates are `firstDate + 7k` up to `lastDate`.
 *   No weekday label is parsed here.
 * - An assignment's range is read by `practiceRangeBounds`, the reader the
 *   portal and the feed already use, never by a third parser.
 *   An open upper bound (`[2026-11-02,)`) reads to the slot's validity end
 *   (plan Q3), through `practiceRangeLowerBound`. Anything else that does not
 *   bound is `unreadable`. An absent range (`undefined`/`null`) is live on
 *   every date of the slot's validity, which is what a range-less row meant
 *   before.
 * - `YYYY-MM-DD` day numbers only: no `Date` is constructed (GAP-30).
 *
 * - Saved practice exceptions (the M4.7 follow-up, plan Q1) go through
 *   `applyPracticeExceptions`, the helper the portal and the feed already
 *   use: {@link applyExceptionsToLiveRows} turns a dated run's
 *   rows plus their exceptions into each row's dated **pieces** (the dates it
 *   is held on, per slot) and its TIME TBD dates, and the engines compare
 *   pieces instead of spans for the rows it touched.
 *
 * The Edge twin is `supabase/functions/_shared/engines/practice-live-dates.ts`;
 * `tests/scoringEngineDrift.test.js` holds the two to the same answers.
 *
 * @module utils/practiceLiveDates
 */

import { isoDateOfDayNumber, isoDayNumber } from '../facility/eligibility.js';
import {
  DAY_OF_WEEK_ENUM,
  practiceRangeBounds,
  practiceRangeLowerBound,
} from './practiceOccurrences.js';
import { PRACTICE_EXCEPTION_CODE, applyPracticeExceptions } from './practiceExceptions.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const WALL_TIME = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;

/** How an assignment's live span came out. */
export const LIVE_SPAN_STATUS = Object.freeze({
  /** At least one live date: `first`..`last`, both on the slot's weekday. */
  LIVE: 'live',
  /** A readable range with no date inside the slot's validity. */
  NONE: 'none',
  /** A range that does not read. */
  UNREADABLE: 'unreadable',
});

/**
 * Day number of a real `YYYY-MM-DD` calendar date, or `null` (`2026-02-30`
 * and `2026-9-1` are not dates).
 *
 * @param {unknown} value
 * @returns {number | null}
 */
export function calendarDayNumber(value) {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return null;
  const day = isoDayNumber(value);
  return Number.isFinite(day) && isoDateOfDayNumber(day) === value ? day : null;
}

/**
 * Seconds past midnight of a wall reading `HH:MM` or `HH:MM:SS`, or `null`.
 *
 * @param {unknown} value
 * @returns {number | null}
 */
export function wallSeconds(value) {
  if (typeof value !== 'string') return null;
  const match = WALL_TIME.exec(value);
  if (match === null) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3] ?? 0);
}

/**
 * The assignment's live span on its slot, as day numbers.
 *
 * `notBefore` (`YYYY-MM-DD`, optional) clips the span's start: the override
 * panel asks "from the season's today on" (plan Q5).
 *
 * @param {{ firstDay: number, lastDay: number, range?: unknown, notBefore?: string | null }} input
 *   `firstDay`/`lastDay`: the slot's dating, as {@link calendarDayNumber}s.
 * @returns {{ status: 'live', first: number, last: number }
 *   | { status: 'none' } | { status: 'unreadable' }}
 */
export function assignmentLiveSpan({ firstDay, lastDay, range, notBefore = null }) {
  let from = firstDay;
  let to = lastDay;
  if (range !== undefined && range !== null) {
    const bounds = practiceRangeBounds(range);
    if (bounds !== null) {
      from = Math.max(from, isoDayNumber(bounds.first));
      to = Math.min(to, isoDayNumber(bounds.last));
    } else {
      const lower = practiceRangeLowerBound(range);
      if (lower === null || !lower.upperUnbounded) {
        return { status: LIVE_SPAN_STATUS.UNREADABLE };
      }
      // Q3: an open-ended series runs to the end of its slot's validity.
      from = Math.max(from, isoDayNumber(lower.first));
    }
  }
  if (notBefore !== null && notBefore !== undefined) {
    const floor = calendarDayNumber(notBefore);
    if (floor === null) throw new TypeError(`notBefore ${String(notBefore)} is not a date`);
    from = Math.max(from, floor);
  }
  // Snap onto the slot's weekday: `from` forward, `to` back.
  const first = firstDay + Math.ceil((from - firstDay) / 7) * 7;
  const last = firstDay + Math.floor((to - firstDay) / 7) * 7;
  if (first > last) return { status: LIVE_SPAN_STATUS.NONE };
  return { status: LIVE_SPAN_STATUS.LIVE, first, last };
}

/**
 * The dates two live spans share: none unless they fall on one weekday, then
 * the overlap of their weekly runs. Inclusive both ends, so spans touching on
 * one date share it (plan W2b).
 *
 * @param {{ first: number, last: number }} a
 * @param {{ first: number, last: number }} b
 * @returns {{ count: number, firstDate: string | null }}
 */
export function sharedLiveDates(a, b) {
  if ((((a.first - b.first) % 7) + 7) % 7 !== 0) return { count: 0, firstDate: null };
  const lo = Math.max(a.first, b.first);
  const hi = Math.min(a.last, b.last);
  if (lo > hi) return { count: 0, firstDate: null };
  return { count: (hi - lo) / 7 + 1, firstDate: isoDateOfDayNumber(lo) };
}

/**
 * The most spans live on any one date: a slot's load on its busiest date
 * (plan Q4). Spans on one slot share its weekday, so they are compared as
 * whole-day intervals.
 *
 * @param {Array<{ first: number, last: number }>} spans
 * @returns {number}
 */
export function peakLiveCount(spans) {
  const events = [];
  for (const span of spans) {
    events.push([span.first, 1], [span.last + 1, -1]);
  }
  // Ends before starts on the same day: `last + 1` is the day after a span.
  events.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  let live = 0;
  let peak = 0;
  for (const [, delta] of events) {
    live += delta;
    if (live > peak) peak = live;
  }
  return peak;
}

/** The `day_of_week` of a day number: day 0 (1970-01-01) is a Thursday. */
const weekdayOfDay = (day) => DAY_OF_WEEK_ENUM[(((day + 4) % 7) + 7) % 7];

/** Every date of a live span, as day numbers. */
const spanDays = (span) => {
  const days = [];
  for (let d = span.first; d <= span.last; d += 7) days.push(d);
  return days;
};

/**
 * The dates two pieces share. A piece is a live span (`{ span }`, weekly) or
 * the explicit dates a row holds on one slot after its exceptions
 * (`{ days }`, day numbers). Two spans go through {@link sharedLiveDates}
 * unchanged, so a run with no exception compares exactly as before.
 *
 * @param {{ span?: { first: number, last: number }, days?: number[] }} a
 * @param {{ span?: { first: number, last: number }, days?: number[] }} b
 * @returns {{ count: number, firstDate: string | null }}
 */
export function sharedPieceDates(a, b) {
  if (a.days === undefined && b.days === undefined) return sharedLiveDates(a.span, b.span);
  const left = new Set(a.days ?? spanDays(a.span));
  const shared = (b.days ?? spanDays(b.span)).filter((d) => left.has(d));
  if (shared.length === 0) return { count: 0, firstDate: null };
  return { count: shared.length, firstDate: isoDateOfDayNumber(Math.min(...shared)) };
}

/**
 * The most pieces held on any one date: a slot's load on its busiest date.
 * All spans go through {@link peakLiveCount} unchanged.
 *
 * @param {Array<{ span?: { first: number, last: number }, days?: number[] }>} pieces
 * @returns {number}
 */
export function peakPieceCount(pieces) {
  if (pieces.every((p) => p.days === undefined)) return peakLiveCount(pieces.map((p) => p.span));
  const load = new Map();
  let peak = 0;
  for (const piece of pieces) {
    for (const day of piece.days ?? spanDays(piece.span)) {
      const count = (load.get(day) ?? 0) + 1;
      load.set(day, count);
      if (count > peak) peak = count;
    }
  }
  return peak;
}

/**
 * The helper's findings the engines report as their own lines. The others
 * (`CONFLICT`, `WINDOW_OPEN`, `WINDOW_UNREADABLE`) always arrive with a TIME
 * TBD entry for the same row and exception, which is reported instead.
 */
export const REPORTED_EXCEPTION_FINDINGS = Object.freeze([
  PRACTICE_EXCEPTION_CODE.ROW_UNREAD,
  PRACTICE_EXCEPTION_CODE.ROW_REFUSED,
  PRACTICE_EXCEPTION_CODE.RELOCATION_UNMATCHED,
  PRACTICE_EXCEPTION_CODE.TBD_SHADOWED,
  PRACTICE_EXCEPTION_CODE.UNREADABLE,
]);

const order = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const text = (value) => String(value ?? '');

/**
 * Apply saved practice exceptions to a dated run's counted rows (the M4.7
 * follow-up, `docs/PLAN_SCORING_DATE_MODEL.md` §3.1 and Q1).
 *
 * The rules are `applyPracticeExceptions`' and nothing here restates them: a
 * live `relocated` exception moves the row's dates in its window to its slot
 * (`practice_slot_id`, resolved against the run's own slots), a live
 * `time_tbd` turns them into TIME TBD dates, and the helper's refusals and
 * findings come back as they are. Called once per team, as the helper's rule
 * 9 (a TIME TBD shadowed by another practice) is a per-team rule; exceptions
 * naming no row of the run go to one more call with no rows, so they come
 * back as the helper's `ROW_UNREAD`, never dropped here.
 *
 * What the engines add, stated:
 *
 * - **The row handed to the helper** carries its range inside its slot's
 *   validity (`firstDate`..`lastDate`), read as the engines read it (plan
 *   §3.1, Q3: no range is the whole validity, an open upper bound runs to
 *   its end), and not snapped to the weekday: the series dates are then
 *   exactly the row's live span, and a relocation in the window's first or
 *   last week keeps the dates the helper's rule 5 gives it (window ∩ range).
 *   Its slot's `day_of_week` is the weekday of the slot's `firstDate` (day
 *   arithmetic, no label parsed). A row with no live date is not handed
 *   over: it holds nothing an exception could change, and an exception
 *   naming it comes back as `ROW_UNREAD` beside the row's own report.
 * - Relocated dates are as the helper gives them, at the target slot, even
 *   outside the target's validity (as the portal and the feed show them;
 *   declared in the plan's Discovered entries).
 * - **A relocation to a slot the run does not carry** has no `slot`, so the
 *   helper turns its dates into TIME TBD `PRACTICE_SLOT_MISSING`.
 * - Only rows with an `id` can be named by an exception. A second counted row
 *   with an id already seen is not handed to the helper (a stored row id is
 *   unique, so this needs a malformed request) and keeps its span.
 *
 * @param {{
 *   rows: Array<{ id?: unknown, teamId: string, slotId: string, firstDay: number,
 *     lastDay: number, range?: unknown, span: { first: number, last: number } | null }>,
 *   exceptions: Array<unknown>,
 *   slotFirstDays: Map<string, number>,
 * }} input - `rows` are the run's counted rows in order; `slotFirstDays` each
 *   slot's `firstDate` as a day number.
 * @returns {{
 *   pieces: Array<Array<{ slotId: string, days: number[] }> | null>,
 *   timeTbd: Array<{ row: number, exceptionId: unknown, code: string, dates: string[] }>,
 *   findings: Array<{ code: string, assignmentId: unknown, exceptionId: unknown, date?: string }>,
 * }} `pieces[i]` is null for a row the helper was not given; `dates` is empty
 *   for an undated TIME TBD entry.
 */
export function applyExceptionsToLiveRows({ rows, exceptions, slotFirstDays }) {
  /** @type {(value: unknown) => value is Record<string, any>} */
  const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  const rowById = new Map();
  rows.forEach((row, index) => {
    // A row with no live date holds nothing an exception could change.
    if (row.span === null || row.id === undefined || row.id === null || rowById.has(row.id)) {
      return;
    }
    rowById.set(row.id, index);
  });

  // Each exception goes with the team of the row it names; the rest together.
  const byTeam = new Map();
  const unnamed = [];
  for (const exception of exceptions) {
    const index = isRecord(exception) ? rowById.get(exception.assignment_id) : undefined;
    if (!isRecord(exception) || index === undefined) {
      unnamed.push(exception);
      continue;
    }
    // The relocated slot is the run's own slot of that id, never a slot the
    // request embedded: its weekday is the one the engines compare on.
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

  const pieces = rows.map(() => null);
  const tbdByKey = new Map();
  const findings = [];
  const keep = (result) => {
    for (const finding of result.findings) {
      if (REPORTED_EXCEPTION_FINDINGS.includes(finding.code)) findings.push(finding);
    }
  };
  const tbd = (index, exceptionId, code, date) => {
    const key = `${index}|${text(exceptionId)}|${code}|${date === null ? 'undated' : 'dated'}`;
    const entry = tbdByKey.get(key) ?? { row: index, exceptionId, code, dates: [] };
    if (date !== null) entry.dates.push(date);
    tbdByKey.set(key, entry);
  };

  const rowsOfTeam = new Map();
  for (const [id, index] of rowById) {
    const team = rows[index].teamId;
    const list = rowsOfTeam.get(team) ?? [];
    list.push({ id, index });
    rowsOfTeam.set(team, list);
  }
  for (const [team, teamExceptions] of byTeam) {
    const helperRows = rowsOfTeam.get(team).map(({ id, index }) => {
      const row = rows[index];
      return {
        id,
        effective_date_range: helperRange(row),
        slot: { day_of_week: weekdayOfDay(row.firstDay) },
      };
    });
    const result = applyPracticeExceptions({ rows: helperRows, exceptions: teamExceptions });
    keep(result);
    for (const { index } of rowsOfTeam.get(team)) pieces[index] = [];
    const daysBySlot = new Map();
    for (const o of result.occurrences) {
      const index = rowById.get(o.assignmentId);
      const row = rows[index];
      const day = isoDayNumber(o.date);
      if (o.kind === 'time_tbd') {
        tbd(index, o.exceptionId, o.code, o.date);
        continue;
      }
      // A series date counts only inside the row's live span; a relocated
      // one is held at its target slot.
      if (
        o.kind === 'series' &&
        (row.span === null || day < row.span.first || day > row.span.last)
      ) {
        continue;
      }
      const slotId = o.kind === 'relocated' ? o.slot.id : row.slotId;
      const key = `${index}|${slotId}`;
      const entry = daysBySlot.get(key) ?? { index, slotId, days: [] };
      entry.days.push(day);
      daysBySlot.set(key, entry);
    }
    for (const { index, slotId, days } of daysBySlot.values()) {
      pieces[index].push({ slotId, days: days.sort((x, y) => x - y) });
    }
    for (const entry of result.undated) {
      tbd(rowById.get(entry.assignmentId), entry.exceptionId, entry.code, null);
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

/**
 * The range the helper is given for a live row: its range inside its slot's
 * validity, as {@link assignmentLiveSpan} reads it before snapping to the
 * weekday. Never empty: a live row has a date in it.
 */
function helperRange(row) {
  let from = row.firstDay;
  let to = row.lastDay;
  if (row.range !== undefined && row.range !== null) {
    const bounds = practiceRangeBounds(row.range);
    if (bounds !== null) {
      from = Math.max(from, isoDayNumber(bounds.first));
      to = Math.min(to, isoDayNumber(bounds.last));
    } else {
      // Unreadable rows were dropped before this, so the lower bound reads (Q3).
      from = Math.max(from, isoDayNumber(practiceRangeLowerBound(row.range).first));
    }
  }
  return `[${isoDateOfDayNumber(from)},${isoDateOfDayNumber(to)}]`;
}

/**
 * A row with no exception, as its one piece: its span on its own slot.
 *
 * @param {{ slotId: string, span: { first: number, last: number } | null }} entry
 * @returns {Array<{ slotId: string, span?: { first: number, last: number }, days?: number[] }>}
 */
export const spanPiece = (entry) =>
  entry.span ? [{ slotId: entry.slotId, span: entry.span }] : [];

/**
 * The dates two rows are both held on with overlapping wall windows, over
 * every pair of their pieces, each piece on its own slot's window. A row
 * holds each date once, so the sum counts each shared date once.
 *
 * @param {Array<{ slotId: string, span?: { first: number, last: number }, days?: number[] }>} a
 * @param {Array<{ slotId: string, span?: { first: number, last: number }, days?: number[] }>} b
 * @param {(slotId: string) => { startSec: number, endSec: number }} windowOf
 * @returns {{ count: number, firstDate: string | null }}
 */
export function sharedHeldDates(a, b, windowOf) {
  let count = 0;
  let firstDate = null;
  for (const p of a) {
    const pw = windowOf(p.slotId);
    for (const q of b) {
      const qw = windowOf(q.slotId);
      if (!(pw.startSec < qw.endSec && qw.startSec < pw.endSec)) continue;
      const shared = sharedPieceDates(p, q);
      if (shared.count === 0) continue;
      count += shared.count;
      if (firstDate === null || shared.firstDate < firstDate) firstDate = shared.firstDate;
    }
  }
  return { count, firstDate };
}
