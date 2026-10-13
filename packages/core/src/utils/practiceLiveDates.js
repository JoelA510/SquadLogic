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
 *   portal, the feed and the RSVP check already use, never by a third parser.
 *   An open upper bound (`[2026-11-02,)`) reads to the slot's validity end
 *   (plan Q3), through `practiceRangeLowerBound`. Anything else that does not
 *   bound is `unreadable`. An absent range (`undefined`/`null`) is live on
 *   every date of the slot's validity, which is what a range-less row meant
 *   before.
 * - `YYYY-MM-DD` day numbers only: no `Date` is constructed (GAP-30).
 *
 * The Edge twin is `supabase/functions/_shared/engines/practice-live-dates.ts`;
 * `tests/scoringEngineDrift.test.js` holds the two to the same answers.
 *
 * @module utils/practiceLiveDates
 */

import { isoDateOfDayNumber, isoDayNumber } from '../facility/eligibility.js';
import { practiceRangeBounds, practiceRangeLowerBound } from './practiceOccurrences.js';

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
