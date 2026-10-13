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
 * @module _shared/engines/practice-live-dates
 */

import {
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
