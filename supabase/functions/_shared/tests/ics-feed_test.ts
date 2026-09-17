/**
 * The calendar feed (LIVE-5), under the runtime it ships to.
 *
 * `tests/calendarFeed.test.js` runs the same module under Vitest and carries
 * the full case list. This file is the Deno arm: the feed is an Edge Function,
 * Deno carries its own ICU build, and the whole defect is timezone arithmetic.
 * It asserts the three defects LIVE-5 named plus the infinite loop found while
 * fixing them, and the CI job runs it under TZ=UTC and TZ=America/Los_Angeles
 * so a host-zone reading fails one of the two.
 */

import {
  assert,
  assertEquals,
  assertStringIncludes,
} from 'https://deno.land/std@0.203.0/assert/mod.ts';
import {
  buildFeedEvents,
  dateRangeBounds,
  renderIcsCalendar,
  summariseUnplaceable,
  type GameRow,
  type PracticeRow,
} from '../calendar/icsFeed.ts';

const NOW = new Date('2025-01-01T12:00:00Z');

/** A `game_slots` row exactly as the function's select returns one. */
function gameRow(overrides: Record<string, unknown> = {}): GameRow {
  return {
    id: 'game-1',
    game_slots: {
      slot_date: '2026-11-07',
      start_time: '16:00:00',
      end_time: '17:30:00',
      start: null,
      end: null,
      fields: { name: 'Field 1A', locations: { name: 'North Park' } },
      ...overrides,
    },
  } as GameRow;
}

/** A `practice_assignments` row, with the daterange spelled as PostgREST renders it. */
function practiceRow(rowOverrides: Record<string, unknown> = {}): PracticeRow {
  return {
    id: 'practice-1',
    effective_date_range: '[2026-11-02,2026-11-17)',
    practice_slots: {
      day_of_week: 'tue',
      start_time: '17:00:00',
      end_time: '18:30:00',
      fields: { name: 'Field 2B', locations: { name: 'South Park' } },
    },
    ...rowOverrides,
  } as PracticeRow;
}

Deno.test('calendar-feed - a bare Postgres `time` composes instead of becoming NaN', () => {
  // The literal defect, asserted so the fixture is provably the shape that broke.
  assert(Number.isNaN(new Date('16:00:00').getTime()), 'new Date("16:00:00") must be invalid');

  const events = buildFeedEvents({
    teamName: 'Tigers',
    timezone: 'America/New_York',
    games: [gameRow()],
  });
  assertEquals(events.length, 1);
  assertEquals(events[0].kind, 'timed');
  // 2026-11-07 16:00 New York is EST (-05:00); DST ended Nov 1.
  assertEquals((events[0] as { dtstart: string }).dtstart, '20261107T210000Z');

  const ics = renderIcsCalendar({
    orgName: 'Test Org',
    teamName: 'Tigers',
    timezone: 'America/New_York',
    events,
    now: NOW,
  });
  assert(!ics.includes('NaN'), 'rendered calendar still contains NaN');
});

Deno.test('calendar-feed - the zone is the season’s, and it is read', () => {
  const at = (tz: string) =>
    (
      buildFeedEvents({ teamName: 'Tigers', timezone: tz, games: [gameRow()] })[0] as {
        dtstart: string;
      }
    ).dtstart;
  // If the zone were ignored (the hardcoded America/New_York), these would match.
  assertEquals(at('America/New_York'), '20261107T210000Z');
  assertEquals(at('America/Los_Angeles'), '20261108T000000Z');
  assertEquals(at('Australia/Lord_Howe'), '20261107T050000Z');
});

Deno.test('calendar-feed - no season timezone means TIME TBD, never Eastern', () => {
  const events = buildFeedEvents({ teamName: 'Tigers', timezone: null, games: [gameRow()] });
  assertEquals(events[0].kind, 'unplaceable');
  assertEquals((events[0] as { code: string }).code, 'SEASON_TIMEZONE_MISSING');

  const ics = renderIcsCalendar({
    orgName: 'Test Org',
    teamName: 'Tigers',
    timezone: null,
    events,
    now: NOW,
  });
  assert(!ics.includes('X-WR-TIMEZONE'), 'named a timezone the season does not have');
  assert(!ics.includes('America/New_York'), 'fell back to Eastern');
  assertStringIncludes(ics, 'DTSTART;VALUE=DATE:20261107');
  assertStringIncludes(ics, 'SUMMARY:TIME TBD - Game: Tigers');
  assertStringIncludes(ics, 'X-WR-CALDESC:');
});

Deno.test('calendar-feed - practices compose on the season clock, not by appending Z', () => {
  const events = buildFeedEvents({
    teamName: 'Tigers',
    timezone: 'America/New_York',
    practices: [practiceRow({ effective_date_range: '[2026-10-26,2026-11-05)' })],
  });
  // Two Tuesdays either side of the Nov 1 fall-back. Appending `Z` put both at
  // 17:00Z; a fixed offset would keep them at the same UTC hour as each other.
  assertEquals(
    events.map((e) => (e as { dtstart: string }).dtstart),
    ['20261027T210000Z', '20261103T220000Z']
  );
});

Deno.test('calendar-feed - an unreadable daterange refuses instead of looping forever', () => {
  // On main the unstripped `[` made the anchor an Invalid Date and
  // `while (NaN !== targetDay)` never terminated. This test completing is the
  // assertion; the control below stops it passing vacuously.
  //
  // `[2026-11-02,)` is in the list because a `daterange` has no NOT NULL upper
  // bound, so an unbounded value is storable today.
  for (const range of ['', 'garbage', '[not-a-date,2026-11-17)', '[2026-11-02,)']) {
    assertEquals(dateRangeBounds(range), null);
    const refused = buildFeedEvents({
      teamName: 'Tigers',
      timezone: 'America/New_York',
      practices: [practiceRow({ effective_date_range: range })],
    });
    // Reported, not dropped: no occurrences, but one entry saying why.
    assertEquals(refused.length, 1);
    assertEquals(refused[0].kind, 'unplaceable');
    assertEquals((refused[0] as { code: string }).code, 'PRACTICE_RANGE_UNREADABLE');
  }
  const good = buildFeedEvents({
    teamName: 'Tigers',
    timezone: 'America/New_York',
    practices: [practiceRow()],
  });
  assert(good.length > 0, 'control: a readable range must still produce occurrences');
  // The upper bound is exclusive, so Nov 17 is out and only two Tuesdays remain.
  assertEquals(
    good.map((e) => e.uid),
    ['practice-1_2026-11-03', 'practice-1_2026-11-10']
  );
});

Deno.test('calendar-feed - the unplaceable summary collapses by code, not by event', () => {
  const games: GameRow[] = Array.from({ length: 400 }, (_, i) => ({
    id: `game-${i}`,
    game_slots: {
      slot_date: `2026-${String((i % 12) + 1).padStart(2, '0')}-0${(i % 9) + 1}`,
      start_time: `${String(9 + (i % 10)).padStart(2, '0')}:00:00`,
      end_time: `${String(10 + (i % 10)).padStart(2, '0')}:30:00`,
      start: null,
      end: null,
      fields: { name: 'Field', locations: { name: 'Park' } },
    },
  }));
  const summary = summariseUnplaceable(
    buildFeedEvents({ teamName: 'Tigers', timezone: null, games })
  );
  assertEquals(summary.count, 400);
  assertEquals(Object.keys(summary.byCode), ['SEASON_TIMEZONE_MISSING']);
  assertEquals(summary.sentence.split(';').length, 1);
  assert(summary.sentence.length < 400, 'the summary grew with the season');
});

Deno.test('calendar-feed - a bare `time` in the timestamptz column does not re-emit NaN', () => {
  // `placeSlotTime` used to pass through whatever the anchor returned and let
  // the caller call `new Date()` on it. A `game_slots.start` of '16:00:00' is
  // not a naive DATE-TIME, so the anchor leaves it alone -- and that is the
  // original LIVE-5 symptom, back through the column the fix added.
  const events = buildFeedEvents({
    teamName: 'Tigers',
    timezone: 'America/New_York',
    games: [gameRow({ start: '16:00:00', end: '17:30:00' })],
  });
  assertEquals(events[0].kind, 'unplaceable');
  assertEquals((events[0] as { code: string }).code, 'WALL_TIME_UNREADABLE');
  const ics = renderIcsCalendar({
    orgName: 'Test Org',
    teamName: 'Tigers',
    timezone: 'America/New_York',
    events,
    now: NOW,
  });
  assert(!ics.includes('NaN'), 'the NaN came back');
});

Deno.test('calendar-feed - every content line is folded at 75 octets (RFC 5545 3.1)', () => {
  const games: GameRow[] = Array.from({ length: 40 }, (_, i) => ({ ...gameRow(), id: `g${i}` }));
  const ics = renderIcsCalendar({
    orgName: 'Test Org',
    teamName: 'Tigers',
    timezone: null,
    events: buildFeedEvents({ teamName: 'Tigers', timezone: null, games }),
    now: NOW,
  });
  const encoder = new TextEncoder();
  const over = ics.split('\r\n').filter((l) => encoder.encode(l).length > 75);
  assertEquals(over, [], `unfolded lines: ${over.length}`);
  // Meta-assertion: something needed folding, or the check above is satisfied
  // by a calendar that happened to be short.
  assert(ics.includes('\r\n '), 'nothing was folded — the check proves nothing');
  assertStringIncludes(ics.replace(/\r\n /g, ''), '40 of 40 events have no confirmed time');
});
