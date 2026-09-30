/**
 * Reading a stored `practice_assignments` row back into calendar dates.
 *
 * The writer side of this lives in `materialise.js`; this is the reader side,
 * for callers holding a PostgREST row (`effective_date_range` as a `daterange`
 * literal, `practice_slots.day_of_week` as the `day_of_week` enum) rather than
 * a validated practice plan.
 *
 * ## The date contract (GAP-30)
 *
 * `YYYY-MM-DD` in, `YYYY-MM-DD` out, and **no `Date` is constructed**. A
 * practice date is a wall date on the season's clock; its weekday is a
 * property of the calendar date and is the same in every zone. Reading it
 * through a host-zone `Date` is the defect this module replaced in
 * `useTeamPortal`: `new Date('2026-11-02')` is UTC midnight, `getDay()` on it
 * in America/Los_Angeles is Sunday, so every Monday practice rendered on the
 * Tuesday and the last week of every range was dropped (fix #64).
 *
 * The day arithmetic is `isoDayNumber()`/`isoDateOfDayNumber()` and the
 * weekday label is `weekdayCodeOf()` -- the functions `practice/slots.js`
 * builds `firstWeekdayOnOrAfter()` from -- so there is one weekday vocabulary
 * in this package. That function is not imported: `practice/` is the Phase 8.5
 * model, declared `PRACTICE_MODEL_UNWIRED` and pinned unconsulted by
 * production (`tests/unwiredLayerImporters.test.js`), and a live reader
 * calling into it would falsify that declaration.
 *
 * The daterange reading is the contract `dateRangeBounds()` in
 * `supabase/functions/_shared/calendar/icsFeed.ts` already applies to the same
 * rows for the calendar feed (bound markers honoured; Postgres canonicalises a
 * `daterange` to `[inclusive,exclusive)`), restated here on day numbers
 * because the Edge runtime and this package do not import one another. The
 * two are pinned to the same answers by `tests/practiceOccurrences.test.js`.
 *
 * @module utils/practiceOccurrences
 */

import { weekdayCodeOf } from '../availability/calendar.js';
import { isoDateOfDayNumber, isoDayNumber } from '../facility/eligibility.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** A `daterange` literal: lower marker, lower bound, upper bound, upper marker. */
const RANGE_LITERAL = /^([[(])([^,]*),([^,]*)([\])])$/;

/**
 * The `day_of_week` enum (`20260331000000_definitive_schema.sql`), indexed by
 * `getUTCDay()`. Pinned to the migrations and the Edge twin (`icsFeed.ts`
 * `DAY_MAP`) by `tests/dayOfWeekEnum.test.js`.
 */
export const DAY_OF_WEEK_ENUM = Object.freeze(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']);

/**
 * Why a row produced no dates. The same codes the calendar feed reports for
 * the same rows (`icsFeed.ts`), so the portal and the feed say one thing.
 */
export const PRACTICE_OCCURRENCE_REFUSAL = Object.freeze({
  SLOT_MISSING: 'PRACTICE_SLOT_MISSING',
  RANGE_UNREADABLE: 'PRACTICE_RANGE_UNREADABLE',
  DAY_UNREADABLE: 'PRACTICE_DAY_UNREADABLE',
});

/**
 * The TIME TBD reason for each refusal, worded exactly as the feed's
 * `UNPLACEABLE_CAUSES` words it. A mirror, not an import: the Edge module and
 * this package do not import one another (the same arrangement as
 * `UNPLACEABLE_SLOT_CAUSES` in `GameSchedulingPage.jsx`), and
 * `tests/practiceOccurrences.test.js` pins the two tables equal.
 */
export const PRACTICE_TBD_CAUSES = Object.freeze({
  PRACTICE_SLOT_MISSING: 'the practice assignment has no slot attached to expand',
  PRACTICE_RANGE_UNREADABLE: 'the practice assignment has no readable start and end date',
  PRACTICE_DAY_UNREADABLE: 'the practice slot names a day of the week this feed cannot read',
  // 8.6 3b PR 12a: a saved practice exception (`utils/practiceExceptions.js`).
  // One sentence per `tbd_reason` in the table's CHECK (20261002000000), enum
  // wording only -- an exception's free-text note never reaches a family.
  'no-legal-slot-at-venue':
    'a field change left no practice slot at this venue that the team could use',
  contended: 'a field change left fewer practice slots than the teams that needed one',
  'change-budget': 'moving this practice would have changed more of the schedule than allowed',
  'objective-preferred-tbd':
    'the scheduler found no replacement slot better than leaving the time unconfirmed',
  'coach-preference': "every replacement slot breaks a coach's must-keep preference",
  declined: 'the proposed new time was declined and no other slot was free',
  'past-sunset': 'the practice would run past sunset on ground with no lights',
  'sunset-unknown': 'sunset at this ground is unknown, so the practice time cannot be confirmed',
  PRACTICE_EXCEPTION_WINDOW_OPEN: 'a change to this practice has no end date yet',
  PRACTICE_EXCEPTION_WINDOW_UNREADABLE: 'a change to this practice has dates that cannot be read',
  PRACTICE_EXCEPTION_CONFLICT: 'two changes to this practice cover the same dates',
  PRACTICE_EXCEPTION_UNREADABLE: 'a change to this practice could not be read',
});

/**
 * The first and last dates a `daterange` literal covers, or `null`.
 *
 * `null` for anything unbounded, empty or unparseable -- a `daterange` has no
 * NOT NULL upper bound, so `[2026-11-02,)` is storable and must not become an
 * endless walk.
 *
 * @param {unknown} range
 * @returns {{ first: string, last: string } | null}
 */
export function practiceRangeBounds(range) {
  const match = RANGE_LITERAL.exec(String(range ?? '').trim());
  if (match === null) return null;
  const lower = match[2].trim();
  const upper = match[3].trim();
  if (!ISO_DATE.test(lower) || !ISO_DATE.test(upper)) return null;
  // `[` covers the bound itself; `(` starts the day after it.
  const first = isoDayNumber(lower) + (match[1] === '[' ? 0 : 1);
  // `]` covers the bound itself; `)` stops the day before it.
  const last = isoDayNumber(upper) - (match[4] === ']' ? 0 : 1);
  if (!Number.isFinite(first) || !Number.isFinite(last) || first > last) return null;
  return { first: isoDateOfDayNumber(first), last: isoDateOfDayNumber(last) };
}

/**
 * The first date a `daterange` literal covers, read from its lower bound
 * alone, or `null` when that bound does not read. `upperUnbounded` says
 * whether the upper bound is absent (`[2026-11-02,)`, or `infinity`) rather
 * than present and unreadable.
 *
 * The lower half of {@link practiceRangeBounds} -- the same literal, the same
 * marker rule -- for a caller that must act on a range whose upper bound is
 * unbounded or unreadable (8.6 3b PR 12a: an open exception window still
 * suppresses every date from its start). It is not a second range parser:
 * both read {@link RANGE_LITERAL}.
 *
 * @param {unknown} range
 * @returns {{ first: string, upperUnbounded: boolean } | null}
 */
export function practiceRangeLowerBound(range) {
  const match = RANGE_LITERAL.exec(String(range ?? '').trim());
  if (match === null) return null;
  const lower = match[2].trim();
  if (!ISO_DATE.test(lower)) return null;
  const first = isoDayNumber(lower) + (match[1] === '[' ? 0 : 1);
  if (!Number.isFinite(first)) return null;
  const upper = match[3].trim().toLowerCase();
  return { first: isoDateOfDayNumber(first), upperUnbounded: upper === '' || upper === 'infinity' };
}

/**
 * Every date inside one row's own `effective_date_range` that falls on its
 * slot's `day_of_week`.
 *
 * One row, one range: a team may hold several rows with disjoint ranges once
 * a repair splits a series, and each is expanded only within its own bounds.
 *
 * @param {{ range: unknown, dayOfWeek: unknown }} input
 * @returns {{ dates: string[], refusal: null } | { dates: [], refusal: string }}
 */
export function practiceOccurrenceDates({ range, dayOfWeek }) {
  const bounds = practiceRangeBounds(range);
  if (bounds === null) {
    return { dates: [], refusal: PRACTICE_OCCURRENCE_REFUSAL.RANGE_UNREADABLE };
  }
  // Lowercased and not trimmed, exactly as the feed's `DAY_MAP` lookup reads it.
  const day = String(dayOfWeek ?? '').toLowerCase();
  if (!DAY_OF_WEEK_ENUM.includes(day)) {
    return { dates: [], refusal: PRACTICE_OCCURRENCE_REFUSAL.DAY_UNREADABLE };
  }
  const code = day.toUpperCase();
  let n = isoDayNumber(bounds.first);
  // At most six steps: `day` is one of the seven enum values.
  while (weekdayCodeOf(isoDateOfDayNumber(n)) !== code) n += 1;
  const dates = [];
  const lastDay = isoDayNumber(bounds.last);
  for (; n <= lastDay; n += 7) dates.push(isoDateOfDayNumber(n));
  return { dates, refusal: null };
}
