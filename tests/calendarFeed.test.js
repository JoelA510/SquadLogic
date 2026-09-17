/**
 * The calendar feed families subscribe to (LIVE-5).
 *
 * ## What this file used to be, and why that mattered
 *
 * It re-declared `formatIcsDate` and the whole ICS generator **inside the test
 * file** and asserted against the copy. It passed for the entire life of
 * LIVE-5, during which every game in every family's calendar carried
 * `DTSTART:NaNNaNNaNTNaNNaNNaNZ` -- because the copy was never handed the bare
 * Postgres `time` value the real select returned, and the real select never
 * asked for a date to go with it. A test of a copy is not a test.
 *
 * The generator now lives in `supabase/functions/_shared/calendar/icsFeed.ts`
 * and this file imports it, so there is one implementation to be wrong.
 * `supabase/functions/_shared/tests/ics-feed_test.ts` runs the same module
 * under Deno, which is the runtime it ships to.
 *
 * ## The row shapes are the ones PostgREST returns
 *
 * `game_slots.start_time` is a Postgres `time` and arrives as `'16:00:00'`.
 * That is the exact value that produced the NaN, so it is the value these
 * fixtures use. A fixture carrying a convenient `'...Z'` string would test
 * nothing -- which is precisely how the suite stayed green.
 */

import { describe, it, expect } from 'vitest';
import {
  buildFeedEvents,
  dateRangeBounds,
  foldIcsLine,
  renderIcsCalendar,
  summariseNotes,
  summariseUnplaceable,
  sanitizeIcsValue,
} from '../supabase/functions/_shared/calendar/icsFeed.ts';

const NOW = new Date('2025-01-01T12:00:00Z');

/** A `game_slots` row exactly as the function's select returns one. */
function gameRow(overrides = {}) {
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
  };
}

/**
 * A `practice_assignments` row exactly as the function's select returns one.
 *
 * `effective_date_range` is a Postgres `daterange`, and PostgREST renders it in
 * its canonical `[inclusive,exclusive)` form. That literal spelling is the
 * fixture because it is what broke the code (see the infinite-loop case below);
 * a bracket-free convenience string would test nothing.
 */
function practiceRow(overrides = {}, rowOverrides = {}) {
  return {
    id: 'practice-1',
    effective_date_range: '[2026-11-02,2026-11-17)',
    practice_slots: {
      day_of_week: 'tue',
      start_time: '17:00:00',
      end_time: '18:30:00',
      fields: { name: 'Field 2B', locations: { name: 'South Park' } },
      ...overrides,
    },
    ...rowOverrides,
  };
}

const render = (events, timezone) =>
  renderIcsCalendar({ orgName: 'Test Org', teamName: 'Tigers', timezone, events, now: NOW });

/**
 * Narrow a `FeedEvent` to the placed arm, asserting the discriminant on the
 * way. `checkJs` will not let `.dtstart` be read off the union, and that is the
 * point of the union -- so every read of a time here also states that the event
 * was placed at all.
 *
 * @param {import('../supabase/functions/_shared/calendar/icsFeed.ts').FeedEvent} ev
 * @returns {import('../supabase/functions/_shared/calendar/icsFeed.ts').TimedEvent}
 */
function timed(ev) {
  expect(ev?.kind).toBe('timed');
  return /** @type {import('../supabase/functions/_shared/calendar/icsFeed.ts').TimedEvent} */ (ev);
}

/**
 * The other arm: an event carrying a reason code instead of an instant.
 *
 * @param {import('../supabase/functions/_shared/calendar/icsFeed.ts').FeedEvent} ev
 * @returns {import('../supabase/functions/_shared/calendar/icsFeed.ts').UnplaceableEvent}
 */
function tbd(ev) {
  expect(ev?.kind).toBe('unplaceable');
  return /** @type {import('../supabase/functions/_shared/calendar/icsFeed.ts').UnplaceableEvent} */ (
    ev
  );
}

describe('LIVE-5 — the NaN DTSTART every family subscribed to', () => {
  it('composes a bare Postgres `time` into a real instant instead of Invalid Date', () => {
    // The literal defect: `new Date('16:00:00')` is Invalid Date. Asserted here
    // so the fixture is provably the shape that broke, not a convenient one.
    expect(Number.isNaN(new Date('16:00:00').getTime())).toBe(true);

    const events = buildFeedEvents({
      teamName: 'Tigers',
      timezone: 'America/New_York',
      games: [gameRow()],
    });

    expect(events).toHaveLength(1);
    // 2026-11-07 16:00 New York is EST (-05:00) — DST ended on Nov 1.
    expect(timed(events[0]).dtstart).toBe('20261107T210000Z');
    expect(timed(events[0]).dtend).toBe('20261107T223000Z');
  });

  it('emits no NaN anywhere in the rendered calendar', () => {
    const events = buildFeedEvents({
      teamName: 'Tigers',
      timezone: 'America/New_York',
      games: [gameRow(), gameRow({})],
      practices: [practiceRow()],
    });
    const ics = render(events, 'America/New_York');

    // The meta-assertion: a calendar with no events could not contain NaN
    // either, so the absence only means something once events are present.
    expect(events.length).toBeGreaterThan(3);
    expect(ics).not.toMatch(/NaN/);
    expect((ics.match(/DTSTART/g) ?? []).length).toBe(events.length);
  });

  it('prefers the timestamptz pair when the row carries one — the sibling contract', () => {
    // `normalizeGameSlot` in GameSchedulingPage reads `start` first and falls
    // back to `slot_date` + `start_time`. Same order here, deliberately.
    const events = buildFeedEvents({
      teamName: 'Tigers',
      timezone: 'America/New_York',
      games: [
        gameRow({
          start: '2026-11-07T19:00:00-05:00',
          end: '2026-11-07T20:30:00-05:00',
        }),
      ],
    });
    expect(timed(events[0]).dtstart).toBe('20261108T000000Z');
  });

  it('places a game that has only the timestamptz pair, with no wall columns', () => {
    const events = buildFeedEvents({
      teamName: 'Tigers',
      timezone: 'America/New_York',
      games: [
        gameRow({
          slot_date: null,
          start_time: null,
          end_time: null,
          start: '2026-06-13T13:30:00Z',
          end: '2026-06-13T15:00:00Z',
        }),
      ],
    });
    expect(timed(events[0]).dtstart).toBe('20260613T133000Z');
  });
});

describe('LIVE-5 — the calendar timezone was never the season is', () => {
  it('names the season zone in X-WR-TIMEZONE, whatever zone that is', () => {
    const events = buildFeedEvents({
      teamName: 'Tigers',
      timezone: 'Australia/Lord_Howe',
      games: [gameRow()],
    });
    const ics = render(events, 'Australia/Lord_Howe');
    expect(ics).toContain('X-WR-TIMEZONE:Australia/Lord_Howe');
    expect(ics).not.toContain('America/New_York');
    // +11:00 in November, so 16:00 local is 05:00Z the same day.
    expect(ics).toContain('DTSTART:20261107T050000Z');
  });

  it('emits NO X-WR-TIMEZONE when the season has none, rather than guessing Eastern', () => {
    const events = buildFeedEvents({ teamName: 'Tigers', timezone: null, games: [gameRow()] });
    const ics = render(events, null);
    expect(ics).not.toContain('X-WR-TIMEZONE');
    expect(ics).not.toContain('America/New_York');
  });

  it('shifts with the zone — the control that proves the zone is read at all', () => {
    const at = (tz) =>
      timed(buildFeedEvents({ teamName: 'Tigers', timezone: tz, games: [gameRow()] })[0]).dtstart;
    const east = at('America/New_York');
    const west = at('America/Los_Angeles');
    expect(east).not.toBe(west);
    expect(east).toBe('20261107T210000Z');
    expect(west).toBe('20261108T000000Z');
  });
});

describe('LIVE-5 — the practice arm no longer asserts the club practises in UTC', () => {
  it('composes each occurrence on the season clock, not by appending Z', () => {
    const events = buildFeedEvents({
      teamName: 'Tigers',
      timezone: 'America/New_York',
      practices: [practiceRow()],
    });

    // 2026-11-02 is a Monday, so the first Tuesday in range is the 3rd; the
    // range's upper bound is exclusive, so the 17th is out.
    expect(events.map((e) => e.uid)).toEqual(['practice-1_2026-11-03', 'practice-1_2026-11-10']);
    // 17:00 EST is 22:00Z. The old code emitted 17:00Z — a five-hour error.
    expect(timed(events[0]).dtstart).toBe('20261103T220000Z');
    expect(timed(events[0]).dtstart).not.toBe('20261103T170000Z');
  });

  it('follows the offset across a DST boundary within one recurrence', () => {
    // 2026-10-27 and 2026-11-03 are both Tuesdays, either side of the Nov 1
    // fall-back. A fixed offset would place them at the same UTC hour; the
    // `Z`-appending code placed both at 17:00Z.
    const events = buildFeedEvents({
      teamName: 'Tigers',
      timezone: 'America/New_York',
      practices: [practiceRow({}, { effective_date_range: '[2026-10-26,2026-11-05)' })],
    });
    expect(events.map((e) => timed(e).dtstart)).toEqual(['20261027T210000Z', '20261103T220000Z']);
  });
});

describe('the daterange the practice arm never actually parsed', () => {
  it('reads a canonical [inclusive,exclusive) daterange', () => {
    // The old `replace(/[[]()]/g, '')` is not the character class it looks
    // like: `[[]` is a class containing `[`, `()` is an empty group and `]` is
    // a literal, so the pattern matches the two-character string "[]" and
    // strips nothing. Asserted here so the claim is checkable, not folklore.
    expect('[2026-11-02,2026-11-17)'.replace(/[[]()]/g, '')).toBe('[2026-11-02,2026-11-17)');

    expect(dateRangeBounds('[2026-11-02,2026-11-17)')).toEqual({
      first: '2026-11-02',
      last: '2026-11-16',
    });
    expect(dateRangeBounds('[2026-11-02,2026-11-16]')).toEqual({
      first: '2026-11-02',
      last: '2026-11-16',
    });
    expect(dateRangeBounds('(2026-11-01,2026-11-17)')).toEqual({
      first: '2026-11-02',
      last: '2026-11-16',
    });
  });

  it('refuses a range it cannot read rather than looping on an Invalid Date', () => {
    // On main this was an INFINITE LOOP, not a wrong answer: the unstripped
    // `[` made `new Date('[2026-11-02T12:00:00Z')` invalid, `getUTCDay()` NaN,
    // and `while (NaN !== targetDay)` never terminated — so every team with a
    // practice assignment hung the feed until the isolate was killed. This
    // test completing at all is the assertion.
    for (const range of [
      '',
      'garbage',
      '[not-a-date,2026-11-17)',
      '[2026-11-17,2026-11-02)',
      // A `daterange` has no NOT NULL upper bound, so this is storable today.
      '[2026-11-02,)',
    ]) {
      expect(dateRangeBounds(range)).toBeNull();
      const events = buildFeedEvents({
        teamName: 'Tigers',
        timezone: 'America/New_York',
        practices: [practiceRow({}, { effective_date_range: range })],
      });
      // Reported, not dropped: no occurrences, but one entry saying why.
      expect(events).toHaveLength(1);
      expect(tbd(events[0]).code).toBe('PRACTICE_RANGE_UNREADABLE');
      expect(tbd(events[0]).date).toBeNull();
      // ...and with no day to put it on, no VEVENT is written — only the count.
      const ics = render(events, 'America/New_York');
      expect(ics).not.toContain('BEGIN:VEVENT');
      expect(ics).toContain('X-WR-CALDESC:');
    }
  });

  it('control: the same rows with a readable range DO produce occurrences', () => {
    // Without this, the case above is satisfied by a builder that returns
    // nothing for any input.
    const events = buildFeedEvents({
      teamName: 'Tigers',
      timezone: 'America/New_York',
      practices: [practiceRow()],
    });
    expect(events.length).toBeGreaterThan(0);
  });
});

describe('LIVE-5 — an event that cannot be placed says so', () => {
  it('becomes an all-day TIME TBD VEVENT carrying its reason code', () => {
    const events = buildFeedEvents({ teamName: 'Tigers', timezone: null, games: [gameRow()] });
    expect(tbd(events[0]).code).toBe('SEASON_TIMEZONE_MISSING');

    const ics = render(events, null);
    expect(ics).toContain('DTSTART;VALUE=DATE:20261107');
    expect(ics).toContain('DTEND;VALUE=DATE:20261108');
    expect(ics).toContain('SUMMARY:TIME TBD - Game: Tigers');
    expect(ics).toContain('STATUS:TENTATIVE');
    expect(ics).toContain('SEASON_TIMEZONE_MISSING');
    // An all-day event carries no time-of-day, which is the whole point.
    expect(ics).not.toMatch(/DTSTART:\d{8}T/);
  });

  it('refuses a spring-forward game rather than composing one of the two readings', () => {
    const events = buildFeedEvents({
      teamName: 'Tigers',
      timezone: 'America/New_York',
      games: [gameRow({ slot_date: '2026-03-08', start_time: '02:30:00', end_time: '04:00:00' })],
    });
    expect(tbd(events[0]).code).toBe('WALL_TIME_NONEXISTENT');
  });

  it('writes no VEVENT at all when not even the day is known', () => {
    const events = buildFeedEvents({
      teamName: 'Tigers',
      timezone: 'America/New_York',
      games: [gameRow({ slot_date: null, start_time: null, end_time: null })],
    });
    expect(tbd(events[0]).date).toBeNull();

    const ics = render(events, 'America/New_York');
    expect(ics).not.toContain('BEGIN:VEVENT');
    // ...but it is still counted where a subscriber can see it.
    expect(ics).toContain('X-WR-CALDESC:');
    expect(ics).toContain('1 of 1 events have no confirmed time');
  });

  it('collapses the description by reason code, not by event', () => {
    // The GAP-30 post-merge review found `describeUnplaceableSlots` bucketing
    // on a message that embedded each slot's own date, so 400 slots produced
    // 400 lines and a 66 KB paragraph. A season with a null timezone makes
    // every event unplaceable, which is the normal case for this very banner.
    const games = Array.from({ length: 400 }, (_, i) => ({
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
    const events = buildFeedEvents({ teamName: 'Tigers', timezone: null, games });
    const summary = summariseUnplaceable(events);

    expect(summary.count).toBe(400);
    expect(Object.keys(summary.byCode)).toEqual(['SEASON_TIMEZONE_MISSING']);
    // One sentence, not four hundred.
    expect(summary.sentence.split(';')).toHaveLength(1);

    const caldesc = render(events, null)
      .split('\r\n')
      .find((line) => line.startsWith('X-WR-CALDESC:'));
    expect(caldesc.length).toBeLessThan(400);
  });

  it('places the good events and TBDs only the bad one', () => {
    // Per event, never per feed: one unplaceable game must not cost a family
    // the rest of its season.
    const events = buildFeedEvents({
      teamName: 'Tigers',
      timezone: 'America/New_York',
      games: [
        gameRow({ slot_date: '2026-03-08', start_time: '02:30:00', end_time: '04:00:00' }),
        { ...gameRow(), id: 'game-2' },
      ],
    });
    expect(events.filter((e) => e.kind === 'timed')).toHaveLength(1);
    expect(events.filter((e) => e.kind === 'unplaceable')).toHaveLength(1);
  });
});

describe('ICS Generator (RFC 5545)', () => {
  it('generates strict CRLF line endings and standard ICS wrapping', () => {
    const events = buildFeedEvents({
      teamName: 'Tigers',
      timezone: 'America/New_York',
      games: [gameRow()],
      practices: [practiceRow()],
    });
    const output = render(events, 'America/New_York');

    const newlineMatches = output.match(/\r\n/g);
    const badNewlineMatches = output.match(/[^\r]\n/g);
    expect(newlineMatches).toBeTruthy();
    expect(newlineMatches.length).toBeGreaterThan(10);
    expect(badNewlineMatches).toBeNull();

    expect(output.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(output.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(output).toContain('VERSION:2.0');
    expect(output).toContain('CALSCALE:GREGORIAN');
    expect(output).toContain('METHOD:PUBLISH');
    expect(output).toContain('PRODID:-//Test Org//SquadLogic//EN');
    expect(output).toContain('X-WR-CALNAME:Tigers Schedule');
    expect(output).toContain(`DTSTAMP:20250101T120000Z`);
  });

  it('escapes the ICS specials that would otherwise inject a header', () => {
    expect(sanitizeIcsValue('Line1\r\nLine2')).toBe('Line1 Line2');
    expect(sanitizeIcsValue('a,b;c\\d')).toBe('a\\,b\\;c\\\\d');

    const events = buildFeedEvents({
      teamName: 'Tigers',
      timezone: 'America/New_York',
      games: [gameRow({ fields: { name: 'Field, 1;A', locations: { name: 'North\nPark' } } })],
    });
    const output = render(events, 'America/New_York');
    expect(output).toContain('LOCATION:North Park\\, Field\\, 1\\;A');
    expect(output.match(/[^\r]\n/g)).toBeNull();
  });
});

describe('the /code-review findings, kept red-able', () => {
  it('a bare `time` in the timestamptz column does not reintroduce the NaN', () => {
    // `placeSlotTime` used to hand its caller whatever `anchorToSeasonClock`
    // passed through, and the caller did `new Date(iso)`. A `game_slots.start`
    // of '16:00:00' is not a naive DATE-TIME, so the anchor leaves it alone,
    // and `new Date('16:00:00')` is Invalid Date — the original LIVE-5 symptom,
    // straight back, through the column the fix added to the select.
    const events = buildFeedEvents({
      teamName: 'Tigers',
      timezone: 'America/New_York',
      games: [gameRow({ start: '16:00:00', end: '17:30:00' })],
    });
    expect(tbd(events[0]).code).toBe('WALL_TIME_UNREADABLE');
    expect(render(events, 'America/New_York')).not.toMatch(/NaN/);
  });

  it('a bare calendar date in that column is refused, not read as UTC midnight', () => {
    const events = buildFeedEvents({
      teamName: 'Tigers',
      timezone: 'America/New_York',
      games: [gameRow({ start: '2026-11-07', end: '2026-11-08' })],
    });
    expect(events[0].kind).toBe('unplaceable');
    // The control: the old path produced a real-looking instant for this.
    expect(render(events, 'America/New_York')).not.toContain('DTSTART:20261107T000000Z');
  });

  it('names the BLOCKING finding, not merely the first one', () => {
    // A fall-back-night practice whose end time is unreadable produces
    // [WALL_TIME_AMBIGUOUS, WALL_TIME_UNREADABLE]. `findings[0]` reported the
    // ambiguity — a code that never refuses, and one deliberately absent from
    // the cause table, so the VEVENT explained itself with the generic
    // fallback while the real cause was thrown away.
    const events = buildFeedEvents({
      teamName: 'Tigers',
      timezone: 'America/New_York',
      practices: [
        practiceRow(
          { day_of_week: 'sun', start_time: '01:30:00', end_time: '25:61:00' },
          { effective_date_range: '[2026-11-01,2026-11-02)' }
        ),
      ],
    });
    // The start is ambiguous (placed, informational); the END is unreadable
    // (blocking). `findings[0]` is the ambiguity, which never refuses.
    expect(tbd(events[0]).code).toBe('WALL_TIME_UNREADABLE');
    expect(tbd(events[0]).code).not.toBe('WALL_TIME_AMBIGUOUS');
    const ics = render(events, 'America/New_York').replace(/\r\n /g, '');
    expect(ics).toContain('the scheduled date or time could not be read');
  });

  it('reports an ambiguous hour on a placed event instead of swallowing it', () => {
    // 01:30 on 2026-11-01 in New York happens twice. The event IS placed, at
    // the first occurrence, and the note rides along — in the VEVENT and in
    // the calendar description.
    const events = buildFeedEvents({
      teamName: 'Tigers',
      timezone: 'America/New_York',
      practices: [
        practiceRow(
          { day_of_week: 'sun', start_time: '01:30:00', end_time: '01:45:00' },
          { effective_date_range: '[2026-11-01,2026-11-02)' }
        ),
      ],
    });
    expect(timed(events[0]).dtstart).toBe('20261101T053000Z'); // EDT, the first
    expect(timed(events[0]).notes).toEqual(['WALL_TIME_AMBIGUOUS']);

    // Unfolded: RFC 5545 folds at 75 octets, so a long line is split and a
    // raw `toContain` on the wire format would be asserting the wrapping.
    const ics = render(events, 'America/New_York').replace(/\r\n /g, '');
    expect(ics).toContain('WALL_TIME_AMBIGUOUS');
    expect(ics).toContain('1 placed events needed a note');

    // Control: an unambiguous event carries no note and adds no CALDESC line.
    const clean = buildFeedEvents({
      teamName: 'Tigers',
      timezone: 'America/New_York',
      games: [gameRow()],
    });
    expect(timed(clean[0]).notes).toEqual([]);
    expect(render(clean, 'America/New_York')).not.toContain('X-WR-CALDESC');
  });

  it('reports a practice assignment it cannot expand at all, rather than dropping it', () => {
    const cases = [
      { row: { ...practiceRow(), practice_slots: null }, code: 'PRACTICE_SLOT_MISSING' },
      { row: practiceRow({ day_of_week: 'noneday' }), code: 'PRACTICE_DAY_UNREADABLE' },
      {
        row: practiceRow({}, { effective_date_range: '[2026-11-02,)' }),
        code: 'PRACTICE_RANGE_UNREADABLE',
      },
    ];
    for (const { row, code } of cases) {
      const events = buildFeedEvents({
        teamName: 'Tigers',
        timezone: 'America/New_York',
        practices: [row],
      });
      expect(events).toHaveLength(1);
      expect(tbd(events[0]).code).toBe(code);
    }
    // ...and a game with no slot row, same rule.
    const noSlot = buildFeedEvents({
      teamName: 'Tigers',
      timezone: 'America/New_York',
      games: [{ id: 'g1', game_slots: null }],
    });
    expect(tbd(noSlot[0]).code).toBe('GAME_SLOT_MISSING');
  });

  it('folds every content line at 75 octets, RFC 5545 §3.1', () => {
    // The header claimed strict RFC 5545 and folded nothing. X-WR-CALDESC is
    // by construction the longest line in the file AND the line that explains
    // the failure case, so an unfolded one is lost exactly when it matters.
    const games = Array.from({ length: 40 }, (_, i) => ({ ...gameRow(), id: `g${i}` }));
    const ics = render(buildFeedEvents({ teamName: 'Tigers', timezone: null, games }), null);

    const encoder = new TextEncoder();
    const over = ics
      .split('\r\n')
      .filter((l) => encoder.encode(l).length > 75)
      .map((l) => `${encoder.encode(l).length}: ${l.slice(0, 40)}…`);
    expect(over).toEqual([]);

    // Meta-assertion: something actually needed folding, or the check above is
    // satisfied by a calendar of short lines.
    expect(ics).toContain('\r\n ');
    const caldesc = ics.slice(ics.indexOf('X-WR-CALDESC:'));
    expect(caldesc.slice(0, caldesc.indexOf('\r\n'))).toBeTruthy();
    // Unfolding restores the sentence intact.
    const unfolded = ics.replace(/\r\n /g, '');
    expect(unfolded).toContain('40 of 40 events have no confirmed time');
  });

  it('folds on octets, never mid-character', () => {
    const line = `SUMMARY:${'é'.repeat(80)}`;
    const folded = foldIcsLine(line);
    const encoder = new TextEncoder();
    for (const segment of folded.split('\r\n')) {
      expect(encoder.encode(segment).length).toBeLessThanOrEqual(75);
    }
    expect(folded.replace(/\r\n /g, '')).toBe(line);
    // Control: a short line is returned untouched.
    expect(foldIcsLine('VERSION:2.0')).toBe('VERSION:2.0');
  });

  it('the note summary is bounded by codes, not by events', () => {
    const practices = Array.from({ length: 200 }, (_, i) => ({
      ...practiceRow(
        { day_of_week: 'sun', start_time: '01:30:00', end_time: '01:45:00' },
        { effective_date_range: '[2026-11-01,2026-11-02)' }
      ),
      id: `p${i}`,
    }));
    const notes = summariseNotes(
      buildFeedEvents({ teamName: 'Tigers', timezone: 'America/New_York', practices })
    );
    expect(notes.count).toBe(200);
    expect(notes.sentence.split(';')).toHaveLength(1);
    expect(notes.sentence.length).toBeLessThan(200);
  });
});
