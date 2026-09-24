/**
 * The team portal expands practice rows on season wall dates (fix #64).
 *
 * `expandPractices` parsed the range start as UTC midnight and read it back
 * with local `getDay()`. In any US zone `2026-11-02` (a Monday) is still
 * Sunday locally, so every Monday practice rendered on the Tuesday and the
 * last week of every range fell outside the loop.
 *
 * This file runs in America/Los_Angeles on purpose: a CI box at UTC cannot
 * reproduce the defect, so a test that inherited the host zone would pass
 * against the broken code.
 */

process.env.TZ = 'America/Los_Angeles';

import { describe, it, expect } from 'vitest';

import { expandPractices } from '../frontend/src/hooks/useTeamPortal.js';
import {
  practiceOccurrenceDates,
  practiceRangeBounds,
  PRACTICE_OCCURRENCE_REFUSAL,
} from '@squadlogic/core/utils/practiceOccurrences.js';
import { dateRangeBounds } from '../supabase/functions/_shared/calendar/icsFeed.ts';

const slot = (day) => ({
  day_of_week: day,
  start_time: '17:00:00',
  end_time: '18:30:00',
  field: { name: 'Field A', location: { name: 'Test Park' } },
});

/**
 * Two rows for ONE team with disjoint ranges -- the shape a repair that splits
 * a series leaves behind. The first crosses the 2026-11-01 DST change.
 */
const ROWS = [
  { id: 'pa-autumn', effective_date_range: '[2026-10-26,2026-11-10)', slot: slot('mon') },
  { id: 'pa-winter', effective_date_range: '[2026-11-30,2026-12-15)', slot: slot('mon') },
];

/**
 * The expected dates, derived from the ROWS -- each row's own bounds walked day
 * by day on the UTC calendar -- never from the function's output.
 */
function expectedMondays(row) {
  const [, lower, upper] = /^\[([^,]+),([^)]+)\)$/.exec(row.effective_date_range);
  const out = [];
  for (let t = utcMs(lower); t < utcMs(upper); t += 86_400_000) {
    const d = new Date(t);
    if (d.getUTCDay() === 1) out.push(d.toISOString().slice(0, 10));
  }
  return out;
}
function utcMs(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

describe('useTeamPortal expandPractices: season wall dates', () => {
  it('runs in a zone that exposes the defect (meta)', () => {
    // If this fails the zone did not take, and the assertions below prove nothing.
    expect(new Date('2026-11-02').getDay()).toBe(0);
  });

  it('a Monday practice in America/Los_Angeles lands on Mondays, last week included', () => {
    const events = expandPractices(ROWS);

    for (const row of ROWS) {
      const expected = expectedMondays(row);
      // Meta: the row really has occurrences, so an empty result cannot pass.
      expect(expected.length).toBe(3);
      const got = events.filter((e) => e.id === row.id).map((e) => e.date);
      expect(got, `dates for ${row.id}`).toEqual(expected);
    }
    // The last week of each range specifically.
    const dates = events.map((e) => e.date);
    expect(dates).toContain('2026-11-09');
    expect(dates).toContain('2026-12-14');
  });

  it('expands each row only within its own range: nothing in the gap or outside', () => {
    const events = expandPractices(ROWS);
    expect(events).toHaveLength(ROWS.reduce((n, r) => n + expectedMondays(r).length, 0));
    for (const e of events) {
      const row = ROWS.find((r) => r.id === e.id);
      const bounds = practiceRangeBounds(row.effective_date_range);
      expect(e.date >= bounds.first && e.date <= bounds.last, `${e.id} ${e.date}`).toBe(true);
      expect(new Date(`${e.date}T12:00:00Z`).getUTCDay()).toBe(1);
    }
    expect(events.some((e) => e.date > '2026-11-09' && e.date < '2026-11-30')).toBe(false);
  });

  it('keeps the wall reading of the slot', () => {
    const [first] = expandPractices(ROWS);
    expect(first).toMatchObject({ startTime: '17:00:00', endTime: '18:30:00', type: 'practice' });
    expect(first.location).toBe('Test Park - Field A');
    const [bare] = expandPractices([{ ...ROWS[0], slot: { ...slot('mon'), field: null } }]);
    expect(bare.location).toBe('Venue - Field');
  });
});

describe('practiceOccurrenceDates / practiceRangeBounds', () => {
  it('reads the range the way the calendar feed does', () => {
    const literals = [
      '[2026-11-02,2026-11-17)',
      '[2026-11-02,2026-11-16]',
      '(2026-11-01,2026-11-17)',
      '[2026-12-28,2027-01-05)',
      '[2026-11-02,)',
      '[2026-11-17,2026-11-02)',
      'empty',
      '',
    ];
    for (const literal of literals) {
      expect(practiceRangeBounds(literal), literal).toEqual(dateRangeBounds(literal));
    }
    // Meta: the comparison covered both readable and unreadable ranges.
    expect(literals.filter((l) => practiceRangeBounds(l) !== null).length).toBe(4);
  });

  it('refuses rather than walking an unbounded range or an unknown day', () => {
    expect(practiceOccurrenceDates({ range: '[2026-11-02,)', dayOfWeek: 'mon' }).refusal).toBe(
      PRACTICE_OCCURRENCE_REFUSAL.RANGE_UNREADABLE
    );
    expect(
      practiceOccurrenceDates({ range: '[2026-11-02,2026-11-17)', dayOfWeek: 'monday' }).refusal
    ).toBe(PRACTICE_OCCURRENCE_REFUSAL.DAY_UNREADABLE);
    // Read as the feed reads it: padded input is refused by both.
    expect(
      practiceOccurrenceDates({ range: '[2026-11-02,2026-11-17)', dayOfWeek: ' mon' }).refusal
    ).toBe(PRACTICE_OCCURRENCE_REFUSAL.DAY_UNREADABLE);
  });
});
