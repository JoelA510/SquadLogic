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
import { composeTeamFeed, PRACTICE_EXCEPTIONS_READ_CAP } from '../calendar/teamFeed.ts';
import {
  exerciseOf,
  expectedFeed,
  fakeClient,
  feedProblems,
  parseIcs,
  SEED,
  seedRange,
  seedWeekdays,
  shiftWindows,
} from './feed-exceptions-seed.ts';

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

// ---------------------------------------------------------------------------
// 8.6 3b PR 12b: the feed applies saved practice exceptions (plan §6 W4, W11,
// W13). The seed, the independent oracle and the fake client are in
// `feed-exceptions-seed.ts`; every subject set below comes from the seeded
// rows, never from the feed's output. `composeTeamFeed` is the seam
// `calendar-feed/index.ts` hands the service-role client to.
// ---------------------------------------------------------------------------

async function seededFeed(seed = SEED, opts: { fail?: string[] } = {}) {
  const client = fakeClient(seed, opts);
  const logged: string[] = [];
  const result = await composeTeamFeed({
    client,
    team: seed.team,
    orgName: 'Test Org',
    now: NOW,
    log: (message) => logged.push(message),
  });
  return { ...result, client, logged };
}

Deno.test('practice exceptions - the seed exercises every case, and the meter can go red', () => {
  const counts = exerciseOf(SEED);
  for (const [name, n] of Object.entries(counts)) {
    assert(n >= 1, `the seed does not exercise ${name}`);
  }
  // The constructed failure: every window moved off every row takes every
  // count to zero, so the meter above is not satisfied by the seed's mere size.
  const off = exerciseOf(shiftWindows(SEED, 1100));
  assertEquals(Object.values(off), [0, 0, 0, 0, 0], JSON.stringify(off));
});

Deno.test('practice exceptions (W11) - the feed shows exactly what the seed says', async () => {
  const { ics, readFailures } = await seededFeed();
  assertEquals(readFailures, []);
  assertEquals(feedProblems(ics, SEED), []);
  // Meta: the oracle expected moved, TIME TBD and plain practices, and undated.
  const want = expectedFeed(SEED);
  const summaries = [...want.vevents.values()].map((v) => v.summary);
  assert(summaries.includes('Practice (moved) - Test Tigers'), 'oracle expects no moved practice');
  assert(summaries.includes('TIME TBD - Practice - Test Tigers'), 'oracle expects no TIME TBD');
  assert(summaries.includes('Practice - Test Tigers'), 'oracle expects no plain practice');
  assert(want.undated >= 1, 'oracle expects no undated entry');
});

Deno.test(
  'practice exceptions (W11) - the oracle rejects a feed handed no exceptions',
  async () => {
    // What "pass `exceptions: []`" renders: the bare series. The oracle must
    // reject it, or the test above could not catch that plant.
    const bare = await seededFeed({ ...SEED, exceptions: [] });
    assert(feedProblems(bare.ics, SEED).length > 0, 'the bare series satisfies the oracle');
  }
);

Deno.test('practice exceptions (W11, Q1) - UIDs, the moved SUMMARY and DESCRIPTION', async () => {
  const { ics } = await seededFeed();
  const byUid = new Map(parseIcs(ics).vevents.map((v) => [v.uid, v]));
  const move = SEED.exceptions.find((e) => e.id === 'exc-move') as Record<string, string>;
  const sameDay = SEED.exceptions.find((e) => e.id === 'exc-sameday') as Record<string, string>;
  // Another weekday: the original Thursdays in the window are gone, not
  // CANCELLED, and the Wednesdays are keyed by their own date.
  const w = seedRange(move.window);
  const thursdays = seedWeekdays('thu', w.first, w.last as string);
  const wednesdays = seedWeekdays('wed', w.first, w.last as string);
  assert(thursdays.length > 0 && wednesdays.length > 0, 'the move window covers no dates');
  for (const d of thursdays) assert(!byUid.has(`asg-a2_${d}`), `original ${d} still sent`);
  for (const d of wednesdays) {
    const ev = byUid.get(`asg-a2_${d}`);
    assertEquals(ev?.summary, 'Practice (moved) - Test Tigers');
    assertEquals(ev?.allDay, false);
    assertStringIncludes(ev?.location ?? '', 'Field 3C');
    assertEquals(
      ev?.description,
      'Practice session for Test Tigers\\, moved from Thursday 18:00 at Synthetic North\\, Field 1A because of a field closure.'
    );
  }
  // Composed on the season clock from the RELOCATED slot's times: Wed Oct 7
  // 17:30 in Los Angeles (PDT, -07:00).
  assertEquals(byUid.get('asg-a2_2026-10-07')?.dtstart, '20261008T003000Z');
  // Same day: the UID is the original's, so the family's event updates.
  const sd = seedRange(sameDay.window).first;
  assertEquals(byUid.get(`asg-a3_${sd}`)?.summary, 'Practice (moved) - Test Tigers');
  assertEquals(byUid.get(`asg-a3_${sd}`)?.dtstart, '20260912T180000Z');
});

Deno.test(
  'practice exceptions (W4) - a tail TIME TBD shows every weekday of its window',
  async () => {
    const { ics } = await seededFeed();
    const tail = SEED.exceptions.find((e) => e.id === 'exc-tail') as Record<string, string>;
    const row = SEED.practices.find((r) => r.id === tail.assignment_id) as {
      id: string;
      effective_date_range: string;
      practice_slots: { day_of_week: string };
    };
    const rowLast = seedRange(row.effective_date_range).last as string;
    const w = seedRange(tail.window);
    const dates = seedWeekdays(row.practice_slots.day_of_week, w.first, w.last as string);
    // Meta: the window lies wholly after the row, and has weekdays in it.
    assert(dates.length >= 4, `tail window has ${dates.length} weekdays`);
    assert(
      dates.every((d) => d > rowLast),
      'the tail window overlaps its row'
    );
    const { caldesc, vevents } = parseIcs(ics);
    const byUid = new Map(vevents.map((v) => [v.uid, v]));
    for (const d of dates) {
      const ev = byUid.get(`${row.id}_${d}`);
      assertEquals(ev?.allDay, true, `no all-day TBD on ${d}`);
      assertEquals(ev?.dtstart, d.replace(/-/g, ''));
      assertEquals(ev?.status, 'TENTATIVE');
      assertEquals(ev?.summary, 'TIME TBD - Practice - Test Tigers');
      assertStringIncludes(ev?.description ?? '', '(past-sunset)');
    }
    // Counted in the CALDESC, under the code's family-facing sentence.
    assertStringIncludes(caldesc, `${dates.length} because the practice would run past sunset`);
  }
);

Deno.test(
  'practice exceptions (W13) - a failed read is said, and the practices still show',
  async () => {
    const { ics, readFailures, logged } = await seededFeed(SEED, { fail: ['practice_exceptions'] });
    assertEquals(readFailures, ['practice changes']);
    assertStringIncludes(
      parseIcs(ics).caldesc,
      'INCOMPLETE: practice changes could not be read\\, so some practices shown may have moved or have no confirmed time.'
    );
    // Not hidden: the feed is the bare series, exactly.
    assertEquals(feedProblems(ics, { ...SEED, exceptions: [] }), []);
    assert(
      logged.some((m) => m.includes('practice_exceptions read failed')),
      'the failure was not logged'
    );
  }
);

Deno.test('practice exceptions (R4) - the read is scoped by team and organization', async () => {
  const { client } = await seededFeed();
  const reads = client.calls.filter((c) => c.table === 'practice_exceptions');
  assertEquals(reads.length, 1);
  assertEquals(reads[0].eq, [
    ['team_id', 'team-t1'],
    ['organization_id', 'org-o1'],
  ]);
  assertEquals(reads[0].is, [['withdrawn_at', null]]);
  assertEquals(reads[0].limit, PRACTICE_EXCEPTIONS_READ_CAP);
  assertStringIncludes(reads[0].select, 'slot:practice_slots!practice_slot_id');
  // A team with no organization cannot be scoped: not read, and said.
  const noOrg = await composeTeamFeed({
    client: fakeClient(SEED),
    team: { ...SEED.team, organization_id: null },
    orgName: 'Test Org',
    now: NOW,
    log: () => {},
  });
  assertEquals(noOrg.readFailures, ['practice changes']);
  assert(!noOrg.ics.includes('Practice (moved)'), 'unscoped exceptions were applied');
});

Deno.test(
  'practice exceptions (R4) - a read that fills the row cap is said as incomplete',
  async () => {
    // PostgREST truncates at max_rows with no error. A full read may be partial.
    const live = SEED.exceptions.find((e) => e.id === 'exc-mid') as Record<string, unknown>;
    const many = Array.from({ length: PRACTICE_EXCEPTIONS_READ_CAP }, (_, i) => ({
      ...live,
      id: `exc-bulk-${String(i).padStart(4, '0')}`,
    }));
    const full = await seededFeed({ ...SEED, exceptions: many });
    assertEquals(full.readFailures, ['practice changes']);
    // Control: one row fewer is trusted as the whole set.
    const under = await seededFeed({ ...SEED, exceptions: many.slice(1) });
    assertEquals(under.readFailures, []);
  }
);

Deno.test(
  'practice exceptions - no season zone: moved refuses, TIME TBD keeps its code',
  async () => {
    const { events } = await seededFeed({ ...SEED, timezone: null });
    const byUid = new Map(events.map((e) => [e.uid, e]));
    const moved = byUid.get('asg-a2_2026-10-07') as { kind: string; code?: string; title: string };
    assertEquals(moved.kind, 'unplaceable');
    assertEquals(moved.code, 'SEASON_TIMEZONE_MISSING');
    assertEquals(moved.title, 'Practice (moved) - Test Tigers');
    const tbd = byUid.get('asg-a1_2026-10-06') as { kind: string; code?: string };
    assertEquals(tbd.kind, 'unplaceable');
    assertEquals(tbd.code, 'past-sunset');
  }
);
