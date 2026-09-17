/**
 * The ICS feed, as two pure functions: rows in, VCALENDAR text out.
 *
 * ## Why this is not inside `calendar-feed/index.ts`
 *
 * It was, and `tests/calendarFeed.test.js` "covered" it by **re-declaring
 * `formatIcsDate` and the generator in the test file** and asserting against
 * the copy. That test passed for the whole life of LIVE-5: every game in every
 * family's calendar carried `DTSTART:NaNNaNNaNTNaNNaNNaNZ`, because the copy
 * was never fed the bare Postgres `time` value the real select returned. A test
 * of a copy is not a test.
 *
 * So the logic moved here, where a Deno test and a Vitest test can both import
 * the thing that actually ships. The Edge Function is now fetch, this, respond.
 *
 * ## The event model
 *
 * Every game and every practice occurrence becomes a {@link FeedEvent}: either
 * a `timed` one carrying two absolute instants, or an `unplaceable` one
 * carrying a reason code. Nothing is dropped on the floor -- CLAUDE.md's "never
 * silently drop an unplaceable fixture" -- and nothing is invented, because a
 * DTSTART an hour wrong sends a family to an empty field.
 *
 * @module _shared/calendar/icsFeed
 */

import {
  TIMING_REASON,
  anchorToSeasonClock,
  resolveZonedInstant,
  type TimingFinding,
} from '../timing/seasonClock.ts';

/**
 * Sanitize ICS field values to prevent header injection (Phase 1 Security).
 * ICS fields must not contain newlines that could inject extra headers.
 */
export const sanitizeIcsValue = (val: string): string =>
  val
    .replace(/[\r\n]+/g, ' ')
    .replace(/[\\;,]/g, '\\$&')
    .trim();

const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);

/** An instant as RFC 5545 UTC date-time: `20240805T170000Z`. */
export const formatIcsDate = (dateOb: Date): string =>
  `${dateOb.getUTCFullYear()}${pad(dateOb.getUTCMonth() + 1)}${pad(dateOb.getUTCDate())}T${pad(
    dateOb.getUTCHours()
  )}${pad(dateOb.getUTCMinutes())}${pad(dateOb.getUTCSeconds())}Z`;

/** `YYYY-MM-DD` -> the RFC 5545 `VALUE=DATE` spelling: `20261107`. */
export const formatIcsDateOnly = (isoDate: string): string => isoDate.replace(/-/g, '');

/** A placeable event: an absolute instant on both ends. */
export interface TimedEvent {
  kind: 'timed';
  uid: string;
  title: string;
  dtstart: string;
  dtend: string;
  description: string;
  location: string;
}

/**
 * An event whose instant could not be composed. `date` is the season-local wall
 * date when one is known and `null` when even that is unavailable -- in which
 * case no VEVENT is emitted at all, because every VEVENT spelling would assert
 * a time we do not have.
 */
export interface UnplaceableEvent {
  kind: 'unplaceable';
  uid: string;
  title: string;
  date: string | null;
  code: string;
  reason: string;
  location: string;
}

export type FeedEvent = TimedEvent | UnplaceableEvent;

/** Reported when a row carries neither an instant nor a wall date-and-time. */
export const SLOT_TIME_MISSING = 'SLOT_TIME_MISSING';

/**
 * The cause behind each reason code, phrased **without any one event in it**.
 *
 * Mirrors `UNPLACEABLE_SLOT_CAUSES` in `GameSchedulingPage.jsx`, and for the
 * reason that table exists there: every per-event message the clock builds
 * embeds that event's own date and time, so bucketing on the message produces
 * one bucket per event. A 400-game season with no season timezone would put 400
 * distinct sentences into one calendar description -- the 66 KB paragraph the
 * GAP-30 post-merge review found, in a different surface. An aggregate needs a
 * sentence that is true of the whole bucket.
 */
export const UNPLACEABLE_CAUSES: Record<string, string> = {
  [TIMING_REASON.SEASON_TIMEZONE_MISSING]:
    'this season has no timezone set, so no event can be placed on a clock - an admin can set it in Settings then Season',
  [TIMING_REASON.SEASON_TIMEZONE_UNKNOWN]:
    "this season's timezone is not a name the calendar server recognises",
  [TIMING_REASON.WALL_TIME_NONEXISTENT]:
    'the scheduled time does not exist on that date, because daylight saving skips that hour',
  [TIMING_REASON.WALL_TIME_UNREADABLE]: 'the scheduled date or time could not be read',
  [SLOT_TIME_MISSING]: 'the slot carries no date or time to place',
};

export const causeFor = (code: string): string =>
  UNPLACEABLE_CAUSES[code] ?? 'the scheduled time could not be placed on the season clock';

/**
 * Compose a slot's wall reading onto the season clock, preferring an instant
 * the row already carries.
 *
 * **The sibling's contract, not a third one.** `game_slots` holds both a
 * `timestamptz` pair (`start`/`end`) and a wall-clock pair
 * (`slot_date` + `start_time`/`end_time`). `normalizeGameSlot` in
 * `GameSchedulingPage.jsx` reads them in exactly this order -- an existing
 * instant wins, a naive value is composed against the season's zone -- and
 * `public.field_bookings` falls back the same way with
 * `COALESCE(gs.slot_date, gs.start::date)`. A fourth hand-written reading of
 * "when is this slot" is how two surfaces end up disagreeing.
 */
export function placeSlotTime(
  instant: unknown,
  date: unknown,
  time: unknown,
  timezone: string | null,
  label: string
): { iso: string | null; findings: TimingFinding[] } {
  if (instant !== null && instant !== undefined && instant !== '') {
    const anchored = anchorToSeasonClock(instant, timezone);
    if (anchored.iso !== null && anchored.iso !== undefined) {
      return { iso: String(anchored.iso), findings: anchored.findings };
    }
    if (anchored.findings.length > 0) return { iso: null, findings: anchored.findings };
  }
  if (!date || !time) return { iso: null, findings: [] };
  return resolveZonedInstant({ date, time, timeZone: timezone, label });
}

/** `getUTCDay()` offsets for the `day_of_week` enum. */
const DAY_MAP: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

interface FieldRef {
  name?: string | null;
  locations?: { name?: string | null } | null;
}

export interface GameRow {
  id: string;
  game_slots?: {
    slot_date?: string | null;
    start_time?: string | null;
    end_time?: string | null;
    start?: string | null;
    end?: string | null;
    fields?: FieldRef | null;
  } | null;
}

export interface PracticeRow {
  id: string;
  effective_date_range: string;
  practice_slots?: {
    day_of_week: string;
    start_time?: string | null;
    end_time?: string | null;
    fields?: FieldRef | null;
  } | null;
}

const locationOf = (fields: FieldRef | null | undefined): string =>
  `${fields?.locations?.name || 'Venue'}, ${fields?.name || 'Field'}`;

const MS_PER_DAY = 86_400_000;

/** `YYYY-MM-DD` shifted by whole days, staying on the UTC calendar. */
function shiftIsoDate(isoDate: string, days: number): string | null {
  const at = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(at.getTime())) return null;
  return new Date(at.getTime() + days * MS_PER_DAY).toISOString().slice(0, 10);
}

/**
 * The first and last dates a `daterange` actually covers.
 *
 * **A defect found while fixing LIVE-5, not reported in it.** The code this
 * replaced did `range.replace(/[[]()]/g, '')`, and that character class is not
 * what it looks like: `[[]` is a class containing `[`, `()` is an empty group,
 * and `]` is a literal -- so the pattern matches the two-character string `[]`
 * and strips **nothing** from `[2026-11-02,2026-11-17)`. `startStr` came out as
 * `'[2026-11-02'`, `new Date('[2026-11-02T12:00:00Z')` is Invalid Date,
 * `getUTCDay()` is `NaN`, and `while (NaN !== targetDay)` with `setUTCDate` on
 * an invalid Date **never terminates**. Executed and confirmed: 100,000
 * iterations with no progress. Every team with a practice assignment hung the
 * feed until the isolate was killed -- so LIVE-5's "NaN DTSTART for every game"
 * was the symptom visible only to teams that had no practices.
 *
 * The bound markers are honoured rather than stripped, which is the other half:
 * Postgres canonicalises a `daterange` to `[inclusive,exclusive)`, so treating
 * the upper bound as inclusive schedules one practice a week after the
 * assignment ends. `rangeLastDay` in `mockSupabaseClient.js` already reads the
 * marker this way; this is that contract, not a third one.
 */
export function dateRangeBounds(range: unknown): { first: string; last: string } | null {
  const match = /^([[(])([^,]*),([^,]*)([\])])$/.exec(String(range ?? '').trim());
  if (match === null) return null;
  const lower = match[2].trim();
  const upper = match[3].trim();
  if (!lower || !upper) return null;
  // `[` covers the bound itself; `(` starts the day after it.
  const first = match[1] === '[' ? lower : shiftIsoDate(lower, 1);
  // `]` covers the bound itself; `)` stops the day before it.
  const last = match[4] === ']' ? upper : shiftIsoDate(upper, -1);
  if (!first || !last || first > last) return null;
  return { first, last };
}

/**
 * Expand practice assignments and games into feed events on the season's clock.
 *
 * `timezone` is a parameter and never a lookup, and `null` is a legitimate
 * value meaning "this season has no clock". Every event then comes back
 * `unplaceable` with `SEASON_TIMEZONE_MISSING`, which is the established
 * ruling: refuse rather than guess. The hardcoded `America/New_York` that used
 * to stand in here was the bug, not the safety net.
 */
export function buildFeedEvents(input: {
  teamName: string;
  timezone: string | null;
  games?: GameRow[] | null;
  practices?: PracticeRow[] | null;
}): FeedEvent[] {
  const { teamName, timezone, games, practices } = input;
  const events: FeedEvent[] = [];

  practices?.forEach((p) => {
    const slot = p.practice_slots;
    if (!slot) return;

    const bounds = dateRangeBounds(p.effective_date_range);
    if (!bounds) return;

    const targetDay = DAY_MAP[String(slot.day_of_week ?? '').toLowerCase()];
    if (targetDay === undefined) return;

    const location = locationOf(slot.fields);
    const title = `Practice - ${teamName}`;

    // The recurrence walk stays on a UTC-noon anchor: it enumerates CALENDAR
    // DATES only, and noon keeps the date stable under any offset. The instant
    // is composed from each date below, on the season's clock.
    //
    // `dateRangeBounds` has already proven both ends parse, so unlike the code
    // this replaced the loop below cannot spin on an Invalid Date.
    const currentDate = new Date(`${bounds.first}T12:00:00Z`);
    const endDate = new Date(`${bounds.last}T12:00:00Z`);

    while (currentDate.getUTCDay() !== targetDay) {
      currentDate.setUTCDate(currentDate.getUTCDate() + 1);
    }

    while (currentDate <= endDate) {
      const isoDateStr = currentDate.toISOString().split('T')[0];
      const uid = `${p.id}_${isoDateStr}`;

      // Was ``new Date(`${isoDateStr}T${slot.start_time}Z`)`` -- a naive wall
      // time with `Z` bolted on, which asserts the club practises in UTC.
      const start = resolveZonedInstant({
        date: isoDateStr,
        time: slot.start_time,
        timeZone: timezone,
        label: 'practice start',
      });
      const end = resolveZonedInstant({
        date: isoDateStr,
        time: slot.end_time,
        timeZone: timezone,
        label: 'practice end',
      });

      if (start.iso && end.iso) {
        events.push({
          kind: 'timed',
          uid,
          title,
          dtstart: formatIcsDate(new Date(start.iso)),
          dtend: formatIcsDate(new Date(end.iso)),
          description: `Practice session for ${teamName}`,
          location,
        });
      } else {
        const blocking = [...start.findings, ...end.findings][0];
        events.push({
          kind: 'unplaceable',
          uid,
          title,
          date: isoDateStr,
          code: blocking?.code ?? SLOT_TIME_MISSING,
          reason: blocking?.message ?? 'practice time could not be placed',
          location,
        });
      }

      currentDate.setUTCDate(currentDate.getUTCDate() + 7);
    }
  });

  games?.forEach((g) => {
    const slot = g.game_slots;
    if (!slot) return;

    const location = locationOf(slot.fields);
    const title = `Game: ${teamName}`;

    const start = placeSlotTime(
      slot.start,
      slot.slot_date,
      slot.start_time,
      timezone,
      'game start'
    );
    // The pre-existing fallback `end_time || start_time` is kept: a slot with
    // no end is a zero-length event, not a dropped one.
    const end = placeSlotTime(
      slot.end,
      slot.slot_date,
      slot.end_time || slot.start_time,
      timezone,
      'game end'
    );

    if (start.iso && end.iso) {
      events.push({
        kind: 'timed',
        uid: g.id,
        title,
        dtstart: formatIcsDate(new Date(start.iso)),
        dtend: formatIcsDate(new Date(end.iso)),
        description: `Game matchup`,
        location,
      });
    } else {
      const blocking = [...start.findings, ...end.findings][0];
      events.push({
        kind: 'unplaceable',
        uid: g.id,
        title,
        // The wall date is usually still known -- what is missing is the
        // season's zone, not the slot's date.
        date: typeof slot.slot_date === 'string' && slot.slot_date ? slot.slot_date : null,
        code: blocking?.code ?? SLOT_TIME_MISSING,
        reason: blocking?.message ?? 'game time could not be placed',
        location,
      });
    }
  });

  return events;
}

/**
 * One line per reason code, counted -- never one line per event.
 * Exported so a test can assert the aggregation collapses.
 */
export function summariseUnplaceable(events: FeedEvent[]): {
  count: number;
  byCode: Record<string, number>;
  sentence: string;
} {
  const unplaceable = events.filter((ev): ev is UnplaceableEvent => ev.kind === 'unplaceable');
  const byCode: Record<string, number> = {};
  for (const ev of unplaceable) byCode[ev.code] = (byCode[ev.code] ?? 0) + 1;
  const sentence = Object.entries(byCode)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([code, count]) => `${count} because ${causeFor(code)}`)
    .join('; ');
  return { count: unplaceable.length, byCode, sentence };
}

/**
 * Render the VCALENDAR. Strict RFC 5545: CRLF everywhere.
 *
 * `now` is a parameter so a test pins DTSTAMP instead of asserting around it.
 */
export function renderIcsCalendar(input: {
  orgName: string;
  teamName: string;
  timezone: string | null;
  events: FeedEvent[];
  now?: Date;
}): string {
  const { orgName, teamName, timezone, events, now = new Date() } = input;
  const CRLF = '\r\n';

  let ics = `BEGIN:VCALENDAR${CRLF}`;
  ics += `VERSION:2.0${CRLF}`;
  ics += `PRODID:-//${orgName}//SquadLogic//EN${CRLF}`;
  ics += `CALSCALE:GREGORIAN${CRLF}`;
  ics += `METHOD:PUBLISH${CRLF}`;
  ics += `X-WR-CALNAME:${sanitizeIcsValue(`${teamName} Schedule`)}${CRLF}`;
  // Only when the season actually has one. Naming a zone we guessed at is the
  // original defect in a single header line.
  if (timezone) {
    ics += `X-WR-TIMEZONE:${sanitizeIcsValue(timezone)}${CRLF}`;
  }

  const summary = summariseUnplaceable(events);
  if (summary.count > 0) {
    ics += `X-WR-CALDESC:${sanitizeIcsValue(
      `${summary.count} of ${events.length} events have no confirmed time: ${summary.sentence}. They appear as all-day "TIME TBD" entries.`
    )}${CRLF}`;
  }

  const nowStamp = formatIcsDate(now);

  for (const ev of events) {
    // Nothing true can be said about when this happens, not even the day, so
    // no VEVENT is written: it is carried by the CALDESC count and the server
    // log instead. Every VEVENT spelling would assert a time we do not have.
    if (ev.kind === 'unplaceable' && ev.date === null) continue;

    ics += `BEGIN:VEVENT${CRLF}`;
    ics += `UID:${sanitizeIcsValue(String(ev.uid))}@squadlogic.app${CRLF}`;
    ics += `DTSTAMP:${nowStamp}${CRLF}`;

    if (ev.kind === 'timed') {
      ics += `DTSTART:${ev.dtstart}${CRLF}`;
      ics += `DTEND:${ev.dtend}${CRLF}`;
      ics += `SUMMARY:${sanitizeIcsValue(ev.title)}${CRLF}`;
      ics += `DESCRIPTION:${sanitizeIcsValue(ev.description)}${CRLF}`;
    } else {
      // An all-day VEVENT. A date-valued DTSTART is floating by definition, so
      // it claims a DAY and no instant -- exactly what is known. DTEND is
      // exclusive for VALUE=DATE, hence the next day.
      const date = ev.date as string;
      const endDate = new Date(new Date(`${date}T00:00:00Z`).getTime() + 86_400_000);
      ics += `DTSTART;VALUE=DATE:${formatIcsDateOnly(date)}${CRLF}`;
      ics += `DTEND;VALUE=DATE:${formatIcsDateOnly(endDate.toISOString().slice(0, 10))}${CRLF}`;
      ics += `SUMMARY:${sanitizeIcsValue(`TIME TBD - ${ev.title}`)}${CRLF}`;
      ics += `DESCRIPTION:${sanitizeIcsValue(
        `No confirmed time: ${causeFor(ev.code)} (${ev.code}).`
      )}${CRLF}`;
      ics += `STATUS:TENTATIVE${CRLF}`;
    }

    if (ev.location) {
      ics += `LOCATION:${sanitizeIcsValue(ev.location)}${CRLF}`;
    }
    ics += `END:VEVENT${CRLF}`;
  }

  ics += `END:VCALENDAR${CRLF}`;
  return ics;
}
