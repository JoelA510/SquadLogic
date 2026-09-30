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
import {
  applyPracticeExceptions,
  practiceRangeBounds,
  PRACTICE_EXCEPTION_CODE,
  PRACTICE_OCCURRENCE_REFUSAL,
  type PracticeExceptionsResult,
} from './practiceExceptions.ts';

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
/** The `readFailures` entry for a failed `practice_exceptions` read (PR 12 plan Q5). */
export const PRACTICE_CHANGES_READ = 'practice changes';

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
  // 8.6 3b PR 12a: a saved practice exception (`practiceExceptions.ts`). One
  // sentence per `tbd_reason` in the table's CHECK, enum wording only. The
  // feed has carried these codes since it adopted the twin (PR 12b).
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

/**
 * `getUTCDay()` offsets for the `day_of_week` enum. Import-free twin of core
 * `DAY_OF_WEEK_ENUM` (`utils/practiceOccurrences.js`), pinned to it by
 * `tests/dayOfWeekEnum.test.js`.
 */
export const DAY_MAP: Record<string, number> = {
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

/** A `practice_slots` row as the feed's selects embed one. */
export interface PracticeSlotRef {
  day_of_week: string;
  start_time?: string | null;
  end_time?: string | null;
  fields?: FieldRef | null;
}

export interface PracticeRow {
  id: string;
  effective_date_range: string;
  practice_slots?: PracticeSlotRef | null;
}

/**
 * A `practice_exceptions` row as `teamFeed.ts` selects one (8.6 3b PR 12b):
 * the relocated slot is embedded as `slot`, the key the twin reads. Every
 * field is read by the twin. The table carries no free text; of the audit
 * columns, none is selected.
 */
export interface PracticeExceptionRow {
  id: string;
  assignment_id: string;
  window: string;
  kind: string;
  practice_slot_id?: string | null;
  tbd_reason?: string | null;
  cause_kind?: string | null;
  withdrawn_at: string | null;
  slot?: PracticeSlotRef | null;
}

const locationOf = (fields: FieldRef | null | undefined): string =>
  `${fields?.locations?.name || 'Venue'}, ${fields?.name || 'Field'}`;

/** A title the calendar app shows for a practice moved by a saved exception (Q1). */
export const movedPracticeTitle = (teamName: string): string => `Practice (moved) - ${teamName}`;

const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

/**
 * `cause_kind` in words. The CHECK's values only (`blackout`, `retirement`,
 * `daylight`); anything else, including `null`, reads as a plain change. Only
 * enum values reach a DESCRIPTION (Q1), plus the slot's own field and venue
 * names, which the LOCATION line already carries.
 */
const CAUSE_KIND_WORDS: Record<string, string> = {
  blackout: 'a field closure',
  retirement: 'a field retirement',
  daylight: 'early sunset',
};

/** The DESCRIPTION of a moved practice: what it replaces, and why, in enum wording (Q1). */
function movedDescription(
  teamName: string,
  replaces: PracticeSlotRef | null | undefined,
  causeKind: unknown
): string {
  const day = WEEKDAY_NAMES[DAY_MAP[String(replaces?.day_of_week ?? '').toLowerCase()]];
  const time = /^\d{2}:\d{2}/.exec(String(replaces?.start_time ?? ''))?.[0];
  const was = [day, time].filter(Boolean).join(' ');
  const cause = CAUSE_KIND_WORDS[String(causeKind ?? '')] ?? 'a schedule change';
  return `Practice session for ${teamName}, moved from ${was || 'its usual time'} at ${locationOf(
    replaces?.fields
  )} because of ${cause}.`;
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
 *
 * **Since 8.6 3b PR 12b this is the twin's `practiceRangeBounds`**, not a
 * reading of its own. The feed now expands rows through the twin, so a second
 * parser here would be one the feed no longer used, while
 * `tests/practiceOccurrences.test.js` went on pinning core to it. The alias
 * keeps that pin honest: it now holds core to the reader the feed ships.
 */
export const dateRangeBounds: (range: unknown) => { first: string; last: string } | null =
  practiceRangeBounds;

/**
 * Expand practice assignments and games into feed events on the season's clock.
 *
 * `timezone` is a parameter and never a lookup, and `null` is a legitimate
 * value meaning "this season has no clock". Every event then comes back
 * `unplaceable` with `SEASON_TIMEZONE_MISSING`, which is the established
 * ruling: refuse rather than guess. The hardcoded `America/New_York` that used
 * to stand in here was the bug, not the safety net.
 *
 * ## Saved practice exceptions (8.6 3b PR 12b)
 *
 * `exceptions` are the team's `practice_exceptions` rows. The practice arm no
 * longer walks a row's range itself: every row, and every exception, goes
 * through the import-free twin `applyPracticeExceptions`
 * (`practiceExceptions.ts`), which is held to core by the drift digest. What
 * it returns is rendered by the rules the plan's operator answers fixed
 * (`docs/PHASE_8_6_PR12_READERS_PLAN.md` §10):
 *
 * - **series**: as before, a timed event, UID `<assignment>_<date>`.
 * - **relocated** (Q1): a timed event on the relocated slot's times and ground,
 *   composed by the same `resolveZonedInstant`; the same UID scheme, so a
 *   same-day move updates the family's existing event; SUMMARY
 *   `Practice (moved) - <team>`; the original dates are simply absent, never
 *   sent as `STATUS:CANCELLED`.
 * - **time_tbd** (Q2): a DATED `unplaceable`, so the renderer's all-day
 *   `STATUS:TENTATIVE` VEVENT and the CALDESC count apply. It carries no
 *   LOCATION: which ground is not known either.
 * - **undated** (Q7, an open or unreadable window, or a row the series
 *   refuses): `date: null`, the CALDESC count only.
 *
 * A season with no zone still refuses every timed event with
 * `SEASON_TIMEZONE_MISSING`, moved ones included; a TIME TBD stays TIME TBD
 * with its own code.
 *
 * `exceptions` is optional for the callers that predate it (tests with no
 * practice changes). The one production caller, `teamFeed.ts`, always passes
 * the rows it read, and `ics-feed_test.ts` runs that caller against a fake
 * client, so passing `[]` there turns red.
 */
export function buildFeedEvents(input: {
  teamName: string;
  timezone: string | null;
  games?: GameRow[] | null;
  practices?: PracticeRow[] | null;
  exceptions?: PracticeExceptionRow[] | null;
  /** Receives the twin's whole result, so a caller can log its findings and meta. */
  onPracticeExceptions?: (result: PracticeExceptionsResult) => void;
}): FeedEvent[] {
  const { teamName, timezone, games, practices, exceptions, onPracticeExceptions } = input;
  const events: FeedEvent[] = [];
  const title = `Practice - ${teamName}`;

  const rowsById = new Map((practices ?? []).map((p) => [String(p.id), p]));
  const applied = applyPracticeExceptions({
    // The twin reads the slot as `slot`; the feed's select embeds it as
    // `practice_slots`. Renamed here and nowhere else.
    rows: (practices ?? []).map((p) => ({
      id: p.id,
      effective_date_range: p.effective_date_range,
      slot: p.practice_slots ?? null,
    })),
    exceptions: exceptions ?? [],
  });
  onPracticeExceptions?.(applied);

  /**
   * An entry with no day at all.
   *
   * **Reported, not `return`ed.** The first cut of this function dropped
   * three of these on the floor -- a missing `practice_slots` join, an
   * unreadable `effective_date_range` (a `daterange` has no NOT NULL upper
   * bound, so `[2026-11-02,)` is storable today) and a `day_of_week` outside
   * the enum -- while the module header claimed nothing was dropped. A
   * family whose practices vanish from the feed with nothing said is the
   * exact failure CLAUDE.md §3 names. `date: null` means no VEVENT is
   * written, because there is no day to write one on; the CALDESC count and
   * the server log are where it exists. Since 12b the same holds for an
   * exception window with no end date or no readable dates (Q7).
   */
  const ROW_REFUSALS = new Set<string>(Object.values(PRACTICE_OCCURRENCE_REFUSAL));
  for (const entry of applied.undated) {
    const id = String(entry.assignmentId);
    const p = rowsById.get(id);
    if (ROW_REFUSALS.has(entry.code)) {
      const reason =
        entry.code === PRACTICE_SLOT_MISSING
          ? `practice assignment ${id} has no practice slot to expand`
          : entry.code === PRACTICE_RANGE_UNREADABLE
            ? `practice assignment ${id} has an effective date range this feed cannot read: ${String(
                p?.effective_date_range
              )}`
            : `practice assignment ${id} names a day of week this feed does not know: ${String(
                p?.practice_slots?.day_of_week
              )}`;
      events.push({
        kind: 'unplaceable',
        uid: id,
        title,
        date: null,
        code: entry.code,
        reason,
        location: locationOf(p?.practice_slots?.fields),
      });
      continue;
    }
    events.push({
      kind: 'unplaceable',
      uid: `${id}_${String(entry.exceptionId)}`,
      title,
      date: null,
      code: entry.code,
      reason:
        entry.code === PRACTICE_EXCEPTION_CODE.WINDOW_OPEN
          ? `a saved change to practice assignment ${id} has no end date`
          : `a saved change to practice assignment ${id} has dates this feed cannot read`,
      location: '',
    });
  }

  for (const o of applied.occurrences) {
    const date = String(o.date);
    const uid = `${String(o.assignmentId)}_${date}`;

    if (o.kind === 'time_tbd') {
      // Dated, so the renderer writes the all-day TENTATIVE VEVENT (Q2).
      events.push({
        kind: 'unplaceable',
        uid,
        title,
        date,
        code: String(o.code),
        reason: `the practice on ${date} has no confirmed time`,
        location: '',
      });
      continue;
    }

    const moved = o.kind === 'relocated';
    const slot = o.slot as PracticeSlotRef;
    const eventTitle = moved ? movedPracticeTitle(teamName) : title;
    const location = locationOf(slot?.fields);

    // Was ``new Date(`${isoDateStr}T${slot.start_time}Z`)`` -- a naive wall
    // time with `Z` bolted on, which asserts the club practises in UTC. A
    // moved practice is composed the same way, from the relocated slot.
    const start = resolveZonedInstant({
      date,
      time: slot?.start_time,
      timeZone: timezone,
      label: 'practice start',
    });
    const end = resolveZonedInstant({
      date,
      time: slot?.end_time,
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
        title: eventTitle,
        dtstart: formatIcsDate(startAt),
        dtend: formatIcsDate(endAt),
        description: moved
          ? movedDescription(teamName, o.replaces as PracticeSlotRef, o.causeKind)
          : `Practice session for ${teamName}`,
        location,
        notes: noteCodesOf(findings),
      });
    } else {
      const blocking = blockingCodeOf(findings);
      events.push({
        kind: 'unplaceable',
        uid,
        title: eventTitle,
        date,
        code: blocking?.code ?? SLOT_TIME_MISSING,
        reason: blocking?.message ?? 'practice time could not be placed',
        location,
      });
    }
  }

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
   * Sources whose read failed (`'games'`, `'practices'`, and since 12b
   * {@link PRACTICE_CHANGES_READ}). Said in the CALDESC,
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
  // A failed `practice_exceptions` read is a different claim from a failed
  // schedule read: nothing is missing, but what is shown may be superseded.
  // Q5 of the PR 12 plan fixed its sentence.
  const schedules = readFailures.filter((source) => source !== PRACTICE_CHANGES_READ);
  if (schedules.length > 0) {
    calDesc.push(
      `INCOMPLETE: the ${schedules.join(' and ')} schedule could not be read, so this calendar may be missing ${schedules.join(' and ')}. It is not a sign that none are scheduled.`
    );
  }
  if (readFailures.includes(PRACTICE_CHANGES_READ)) {
    calDesc.push(
      'INCOMPLETE: practice changes could not be read, so some practices shown may have moved or have no confirmed time.'
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
