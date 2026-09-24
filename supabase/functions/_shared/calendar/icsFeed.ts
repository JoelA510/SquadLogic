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
  isBlockingFinding,
  resolveZonedInstant,
  type TimingFinding,
} from '../timing/seasonClock.ts';
import { toInstant } from '../timing/anchorWallTimes.ts';

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
  /**
   * Non-blocking reason codes raised while placing this event -- today only
   * `WALL_TIME_AMBIGUOUS`, a wall time that occurs twice on a fall-back night
   * and was resolved to its first occurrence.
   *
   * These were dropped on the floor in the first cut of this module: the event
   * went down the placed branch and the finding was neither rendered nor
   * logged. Both other Edge Functions in this change return them as
   * `timingFindings`; a feed that swallows them is the same falsely-clean
   * result in a smaller disguise. Always an array, never absent, so a consumer
   * cannot read "none" as "this build does not report them".
   */
  notes: string[];
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
/** A `practice_assignments` row whose `practice_slots` join came back empty. */
export const PRACTICE_SLOT_MISSING = 'PRACTICE_SLOT_MISSING';
/** An `effective_date_range` this feed cannot read, including an unbounded one. */
export const PRACTICE_RANGE_UNREADABLE = 'PRACTICE_RANGE_UNREADABLE';
/** A `day_of_week` outside the enum the recurrence walk knows. */
export const PRACTICE_DAY_UNREADABLE = 'PRACTICE_DAY_UNREADABLE';
/** A `games` row whose `game_slots` join came back empty. */
export const GAME_SLOT_MISSING = 'GAME_SLOT_MISSING';

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
  [PRACTICE_SLOT_MISSING]: 'the practice assignment has no slot attached to expand',
  [PRACTICE_RANGE_UNREADABLE]: 'the practice assignment has no readable start and end date',
  [PRACTICE_DAY_UNREADABLE]: 'the practice slot names a day of the week this feed cannot read',
  [GAME_SLOT_MISSING]: 'the game has no scheduled slot yet',
};

/**
 * The advisories a placed event can still carry.
 *
 * Deliberately a separate table from {@link UNPLACEABLE_CAUSES}: these codes
 * never refuse, so putting them there would make a code that composes an
 * instant read as a reason one could not be composed.
 */
export const NOTE_CAUSES: Record<string, string> = {
  [TIMING_REASON.WALL_TIME_AMBIGUOUS]:
    'the clock goes back that night, so this hour happens twice - the earlier one is shown',
};

export const noteCauseFor = (code: string): string =>
  NOTE_CAUSES[code] ?? 'this time needed a judgement call on the season clock';

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
): { at: Date | null; findings: TimingFinding[] } {
  if (instant !== null && instant !== undefined && instant !== '') {
    const anchored = anchorToSeasonClock(instant, timezone);
    const blocking = anchored.findings.find(isBlockingFinding);
    if (blocking) return { at: null, findings: anchored.findings };
    // **`toInstant`, not `new Date`.** The first cut of this function returned
    // whatever `anchorToSeasonClock` passed through and let the caller do
    // `new Date(iso)`, which put the ORIGINAL LIVE-5 DEFECT straight back: a
    // `game_slots.start` of `'16:00:00'` is not a naive date-time, so the
    // anchor leaves it alone, `new Date('16:00:00')` is Invalid Date, and the
    // feed emitted `NaNNaNNaNTNaNNaNNaNZ` again. A bare `'2026-11-07'` slipped
    // through the same hole and silently became UTC midnight -- the case this
    // module's header says it refuses. `toInstant` is the sibling predicate
    // that already decides both, in `_shared/timing/anchorWallTimes.ts`;
    // inventing a third answer here is what went wrong.
    const { date: at, code } = toInstant(anchored.iso);
    if (at) return { at, findings: anchored.findings };
    return {
      at: null,
      findings: [
        ...anchored.findings,
        {
          code: (code ?? TIMING_REASON.WALL_TIME_UNREADABLE) as TimingFinding['code'],
          message: `${label} carries a value that is not an instant: ${String(instant)}`,
          details: { label, value: String(instant) },
        },
      ],
    };
  }
  if (!date || !time) {
    return {
      at: null,
      findings: [
        {
          code: TIMING_REASON.WALL_TIME_UNREADABLE,
          message: `${label} has no date or time to place`,
          details: { label, date: String(date), time: String(time) },
        },
      ],
    };
  }
  const composed = resolveZonedInstant({ date, time, timeZone: timezone, label });
  if (composed.iso === null) return { at: null, findings: composed.findings };
  return { at: toInstant(composed.iso).date, findings: composed.findings };
}

/**
 * The first finding that means nothing was composed.
 *
 * `findings[0]` is not that: a fall-back-night slot whose END time is
 * unreadable produces `[WALL_TIME_AMBIGUOUS, WALL_TIME_UNREADABLE]`, and
 * taking the head reported the ambiguity as the cause -- a code that never
 * refuses, and one deliberately absent from {@link UNPLACEABLE_CAUSES}, so the
 * VEVENT explained itself with the generic fallback sentence while the real
 * cause was discarded.
 */
function blockingCodeOf(findings: TimingFinding[]): TimingFinding | undefined {
  return findings.find(isBlockingFinding);
}

/** The non-blocking codes worth telling a subscriber about. */
function noteCodesOf(findings: TimingFinding[]): string[] {
  return [...new Set(findings.filter((f) => !isBlockingFinding(f)).map((f) => f.code))];
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
    const location = locationOf(slot?.fields);
    const title = `Practice - ${teamName}`;

    /**
     * An assignment that cannot be expanded at all.
     *
     * **Reported, not `return`ed.** The first cut of this function dropped
     * three of these on the floor -- a missing `practice_slots` join, an
     * unreadable `effective_date_range` (a `daterange` has no NOT NULL upper
     * bound, so `[2026-11-02,)` is storable today) and a `day_of_week` outside
     * the enum -- while the module header claimed nothing was dropped. A
     * family whose practices vanish from the feed with nothing said is the
     * exact failure CLAUDE.md §3 names. `date: null` means no VEVENT is
     * written, because there is no day to write one on; the CALDESC count and
     * the server log are where it exists.
     */
    const refuseAssignment = (code: string, reason: string) => {
      events.push({
        kind: 'unplaceable',
        uid: String(p.id),
        title,
        date: null,
        code,
        reason,
        location,
      });
    };

    if (!slot) {
      refuseAssignment(
        PRACTICE_SLOT_MISSING,
        `practice assignment ${p.id} has no practice slot to expand`
      );
      return;
    }

    const bounds = dateRangeBounds(p.effective_date_range);
    if (!bounds) {
      refuseAssignment(
        PRACTICE_RANGE_UNREADABLE,
        `practice assignment ${p.id} has an effective date range this feed cannot read: ${String(
          p.effective_date_range
        )}`
      );
      return;
    }

    const targetDay = DAY_MAP[String(slot.day_of_week ?? '').toLowerCase()];
    if (targetDay === undefined) {
      refuseAssignment(
        PRACTICE_DAY_UNREADABLE,
        `practice assignment ${p.id} names a day of week this feed does not know: ${String(
          slot.day_of_week
        )}`
      );
      return;
    }

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

      const findings = [...start.findings, ...end.findings];
      const startAt = start.iso ? toInstant(start.iso).date : null;
      const endAt = end.iso ? toInstant(end.iso).date : null;

      if (startAt && endAt) {
        events.push({
          kind: 'timed',
          uid,
          title,
          dtstart: formatIcsDate(startAt),
          dtend: formatIcsDate(endAt),
          description: `Practice session for ${teamName}`,
          location,
          notes: noteCodesOf(findings),
        });
      } else {
        const blocking = blockingCodeOf(findings);
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
    const location = locationOf(slot?.fields);
    const title = `Game: ${teamName}`;

    if (!slot) {
      // Reported, not dropped -- see `refuseAssignment` above. A game with no
      // `game_slots` row is a game nobody can attend, and silence about it is
      // how a family learns of a fixture from someone else's parent.
      events.push({
        kind: 'unplaceable',
        uid: g.id,
        title,
        date: null,
        code: GAME_SLOT_MISSING,
        reason: `game ${g.id} has no scheduled slot`,
        location,
      });
      return;
    }

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

    const findings = [...start.findings, ...end.findings];

    if (start.at && end.at) {
      events.push({
        kind: 'timed',
        uid: g.id,
        title,
        dtstart: formatIcsDate(start.at),
        dtend: formatIcsDate(end.at),
        description: `Game matchup`,
        location,
        notes: noteCodesOf(findings),
      });
    } else {
      const blocking = blockingCodeOf(findings);
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
 * One line per advisory code, counted. Same shape and same reason as
 * {@link summariseUnplaceable}: bounded by the number of CODES, never by the
 * number of events.
 */
export function summariseNotes(events: FeedEvent[]): {
  count: number;
  byCode: Record<string, number>;
  sentence: string;
} {
  const byCode: Record<string, number> = {};
  let count = 0;
  for (const ev of events) {
    if (ev.kind !== 'timed') continue;
    for (const code of ev.notes) {
      byCode[code] = (byCode[code] ?? 0) + 1;
      count += 1;
    }
  }
  const sentence = Object.entries(byCode)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([code, n]) => `${n} where ${noteCauseFor(code)}`)
    .join('; ');
  return { count, byCode, sentence };
}

/**
 * RFC 5545 §3.1 content-line folding: no line may exceed 75 **octets**, and a
 * continuation begins with a single space.
 *
 * The header claimed "strict RFC 5545" and folded nothing. That was harmless
 * while every line was a UID or a DTSTART, and stopped being harmless when
 * `X-WR-CALDESC` arrived: it is by construction the longest line in the file,
 * it is the line that explains the failure case, and a strict parser truncates
 * or rejects it. Measured before this existed: a 40-event feed with
 * `SEASON_TIMEZONE_MISSING` produced a 224-character CALDESC.
 *
 * Octets, not characters: the limit is on the UTF-8 encoding, and a club name
 * with an accent would otherwise fold one byte late. A multi-byte character is
 * never split across the boundary.
 */
export function foldIcsLine(line: string): string {
  const CRLF = '\r\n';
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;

  const out: string[] = [];
  let used = 0; // octets on the current output line
  let current = '';
  let first = true;
  // A continuation line starts with one space, which itself counts toward 75.
  const limitFor = () => (first ? 75 : 74);

  for (const char of line) {
    const width = new TextEncoder().encode(char).length;
    if (used + width > limitFor()) {
      out.push(current);
      first = false;
      current = '';
      used = 0;
    }
    current += char;
    used += width;
  }
  out.push(current);
  return out.join(`${CRLF} `);
}

/**
 * Render the VCALENDAR. Strict RFC 5545: CRLF everywhere, and every content
 * line folded at 75 octets.
 *
 * `now` is a parameter so a test pins DTSTAMP instead of asserting around it.
 */
export function renderIcsCalendar(input: {
  orgName: string;
  teamName: string;
  timezone: string | null;
  events: FeedEvent[];
  /**
   * Sources whose read failed (`'games'`, `'practices'`). Said in the CALDESC,
   * because a failed read renders exactly like "nothing scheduled" otherwise:
   * a family would see a calendar with no practices and believe it (fix #64).
   * Not a 500 -- the ruling on the season read applies: a feed that 500s
   * takes every family's calendar down, including the half that did load.
   */
  readFailures?: string[];
  now?: Date;
}): string {
  const { orgName, teamName, timezone, events, readFailures = [], now = new Date() } = input;
  const CRLF = '\r\n';

  /** Every content line goes through here, so none can be written unfolded. */
  const lines: string[] = [];
  const line = (value: string) => lines.push(foldIcsLine(value));

  line('BEGIN:VCALENDAR');
  line('VERSION:2.0');
  line(`PRODID:-//${sanitizeIcsValue(orgName)}//SquadLogic//EN`);
  line('CALSCALE:GREGORIAN');
  line('METHOD:PUBLISH');
  line(`X-WR-CALNAME:${sanitizeIcsValue(`${teamName} Schedule`)}`);
  // Only when the season actually has one. Naming a zone we guessed at is the
  // original defect in a single header line.
  if (timezone) {
    line(`X-WR-TIMEZONE:${sanitizeIcsValue(timezone)}`);
  }

  const summary = summariseUnplaceable(events);
  const notes = summariseNotes(events);
  const calDesc: string[] = [];
  if (readFailures.length > 0) {
    calDesc.push(
      `INCOMPLETE: the ${readFailures.join(' and ')} schedule could not be read, so this calendar may be missing ${readFailures.join(' and ')}. It is not a sign that none are scheduled.`
    );
  }
  if (summary.count > 0) {
    calDesc.push(
      `${summary.count} of ${events.length} events have no confirmed time: ${summary.sentence}. They appear as all-day "TIME TBD" entries.`
    );
  }
  if (notes.count > 0) {
    calDesc.push(`${notes.count} placed events needed a note: ${notes.sentence}.`);
  }
  if (calDesc.length > 0) {
    line(`X-WR-CALDESC:${sanitizeIcsValue(calDesc.join(' '))}`);
  }

  const nowStamp = formatIcsDate(now);

  for (const ev of events) {
    // Nothing true can be said about when this happens, not even the day, so
    // no VEVENT is written: it is carried by the CALDESC count and the server
    // log instead. Every VEVENT spelling would assert a time we do not have.
    if (ev.kind === 'unplaceable' && ev.date === null) continue;

    line('BEGIN:VEVENT');
    line(`UID:${sanitizeIcsValue(String(ev.uid))}@squadlogic.app`);
    line(`DTSTAMP:${nowStamp}`);

    if (ev.kind === 'timed') {
      line(`DTSTART:${ev.dtstart}`);
      line(`DTEND:${ev.dtend}`);
      line(`SUMMARY:${sanitizeIcsValue(ev.title)}`);
      const note = ev.notes.length
        ? ` Note: ${ev.notes.map((code) => `${noteCauseFor(code)} (${code})`).join('; ')}.`
        : '';
      line(`DESCRIPTION:${sanitizeIcsValue(`${ev.description}${note}`)}`);
    } else {
      // An all-day VEVENT. A date-valued DTSTART is floating by definition, so
      // it claims a DAY and no instant -- exactly what is known. DTEND is
      // exclusive for VALUE=DATE, hence the next day.
      const date = ev.date as string;
      const endDate = new Date(new Date(`${date}T00:00:00Z`).getTime() + 86_400_000);
      line(`DTSTART;VALUE=DATE:${formatIcsDateOnly(date)}`);
      line(`DTEND;VALUE=DATE:${formatIcsDateOnly(endDate.toISOString().slice(0, 10))}`);
      line(`SUMMARY:${sanitizeIcsValue(`TIME TBD - ${ev.title}`)}`);
      line(
        `DESCRIPTION:${sanitizeIcsValue(`No confirmed time: ${causeFor(ev.code)} (${ev.code}).`)}`
      );
      line('STATUS:TENTATIVE');
    }

    if (ev.location) {
      line(`LOCATION:${sanitizeIcsValue(ev.location)}`);
    }
    line('END:VEVENT');
  }

  line('END:VCALENDAR');
  return `${lines.join(CRLF)}${CRLF}`;
}
