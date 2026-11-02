// @vitest-environment node
/**
 * The demo's two seasons (plan docs/changes/2026-11-01-demo-season-selection.md): the rule that dates a
 * demo's season from the visitor's choice, in `frontend/src/lib/demoSeasons.js`, and the server's twin of
 * it, `demo_seed.season_window()` (migration 20261114010000).
 *
 *   - **the rule**: a table of vectors (a date inside each window, the day before a start, a window's
 *     last day and the day after it, an anchor that falls on a Sunday, a leap day, the turn of the year);
 *   - **the properties**, over every day of 2026 to 2062: the season starts on a Monday and ends 12 or 6
 *     weeks later on a Sunday, ends on or after the day asked, is the earliest instance that does, and the
 *     default is the one that ends first;
 *   - **the mirror**: the vectors above are embedded, verbatim, in `supabase/tests/demo_sessions.sql`,
 *     which runs the SQL function over them, so the two implementations are held to one table;
 *   - **the proof**: with the repository's sunset helper, at the seed's own unlit venues and its own
 *     slot ends (both read from the seed, not from the rule), no unlit practice ends within ten minutes
 *     of sunset on any practice day of either window in any year to 2060. The check can fail: a fall
 *     two weeks too long, a spring that starts before the clocks go forward, a venue lit by mistake.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import Papa from 'papaparse';
import { describe, expect, it } from 'vitest';
import {
  DEMO_SEASONS,
  DEMO_SPRING_WEEKS,
  DEMO_TIMEZONE,
  defaultDemoSeason,
  demoSeasonName,
  demoSeasonOptions,
  demoSeasonWindow,
  demoToday,
  describeDemoWindow,
  isDemoSeason,
} from '../frontend/src/lib/demoSeasons.js';
import { sunsetOnDate, sunsetEnforcementMinutes } from '../packages/core/src/timing/solar.js';
import { sunsetOnDate as edgeSunsetOnDate } from '../supabase/functions/_shared/timing/solar.ts';
import { DEMO_FIXTURE_DIR, DEMO_MIGRATION } from '../scripts/build-demo-seed.mjs';

/** [choice (null = none), today, season, start, end]: the table both implementations are held to. */
const VECTORS = [
  ['spring', '2026-11-01', 'spring', '2027-03-22', '2027-06-13'],
  ['fall', '2026-11-01', 'fall', '2027-08-02', '2027-09-12'],
  [null, '2026-11-01', 'spring', '2027-03-22', '2027-06-13'],
  ['fall', '2027-05-10', 'fall', '2027-08-02', '2027-09-12'],
  ['spring', '2027-05-10', 'spring', '2027-03-22', '2027-06-13'],
  [null, '2027-05-10', 'spring', '2027-03-22', '2027-06-13'],
  [null, '2027-06-14', 'fall', '2027-08-02', '2027-09-12'],
  ['spring', '2027-06-13', 'spring', '2027-03-22', '2027-06-13'],
  ['spring', '2027-06-14', 'spring', '2028-03-27', '2028-06-18'],
  [null, '2027-09-12', 'fall', '2027-08-02', '2027-09-12'],
  [null, '2027-09-13', 'spring', '2028-03-27', '2028-06-18'],
  ['fall', '2027-09-13', 'fall', '2028-08-07', '2028-09-17'],
  [null, '2027-12-31', 'spring', '2028-03-27', '2028-06-18'],
  [null, '2028-01-01', 'spring', '2028-03-27', '2028-06-18'],
  ['spring', '2028-02-29', 'spring', '2028-03-27', '2028-06-18'],
  [null, '2027-08-01', 'fall', '2027-08-02', '2027-09-12'],
  ['fall', '2026-08-02', 'fall', '2026-08-03', '2026-09-13'],
  ['spring', '2026-03-22', 'spring', '2026-03-23', '2026-06-14'],
  [null, '2026-03-22', 'spring', '2026-03-23', '2026-06-14'],
  ['fall', '2028-12-31', 'fall', '2029-08-06', '2029-09-16'],
  ['spring', '2029-03-22', 'spring', '2029-03-26', '2029-06-17'],
  ['fall', '2027-08-02', 'fall', '2027-08-02', '2027-09-12'],
  [null, '2027-03-21', 'spring', '2027-03-22', '2027-06-13'],
  [null, '2027-03-22', 'spring', '2027-03-22', '2027-06-13'],
];

const DAY_MS = 86_400_000;
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const everyDay = (from, to) => {
  const days = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += DAY_MS) {
    days.push(iso(t));
  }
  return days;
};

/** The vectors as the SQL test embeds them: one tuple a line, `NULL` for no choice. */
function vectorsSql(vectors = VECTORS) {
  return vectors
    .map(
      ([choice, today, season, start, end]) =>
        `    (${choice === null ? 'NULL' : `'${choice}'`}, '${today}', '${season}', '${start}', '${end}')`
    )
    .join(',\n');
}

describe('the rule: which season a choice dates a demo in', () => {
  it.each(VECTORS)('%s on %s is %s, %s to %s', (choice, today, season, start, end) => {
    const window = demoSeasonWindow(/** @type {any} */ (choice), today);
    expect({ season: window.season, start: window.start, end: window.end }).toEqual({
      season,
      start,
      end,
    });
  });

  it('holds its own table to the calendar: every start is a Monday and every end a Sunday', () => {
    expect(VECTORS.length).toBeGreaterThanOrEqual(20);
    for (const [, , , start, end] of VECTORS) {
      expect(new Date(`${start}T00:00:00Z`).getUTCDay(), `${start} is a Monday`).toBe(1);
      expect(new Date(`${end}T00:00:00Z`).getUTCDay(), `${end} is a Sunday`).toBe(0);
    }
  });

  it('chooses fall in spring from this year and in autumn from the next, never a past one', () => {
    expect(demoSeasonWindow('fall', '2027-04-15').start).toBe('2027-08-02');
    expect(demoSeasonWindow('fall', '2027-10-15').start).toBe('2028-08-07');
    expect(demoSeasonWindow('spring', '2027-10-15').start).toBe('2028-03-27');
  });

  it('keeps a window until its last day and not a day longer', () => {
    expect(demoSeasonWindow('fall', '2027-09-12').start).toBe('2027-08-02');
    expect(demoSeasonWindow('fall', '2027-09-13').start).toBe('2028-08-07');
  });

  it('lengths: 12 weeks of spring and 6 of fall, the spring being the league season_weeks', () => {
    const spring = demoSeasonWindow('spring', '2027-01-01');
    const fall = demoSeasonWindow('fall', '2027-01-01');
    expect((Date.parse(spring.end) - Date.parse(spring.start)) / DAY_MS + 1).toBe(12 * 7);
    expect((Date.parse(fall.end) - Date.parse(fall.start)) / DAY_MS + 1).toBe(6 * 7);
    expect(spring.weeks).toBe(DEMO_SPRING_WEEKS);
  });

  it('refuses a choice that is neither, exactly as the server does (no trimming, no folding)', () => {
    for (const bad of [
      'Fall',
      ' fall',
      'fall ',
      'SPRING',
      '',
      'summer',
      'winter',
      5,
      {},
      ['fall'],
    ]) {
      expect(isDemoSeason(bad), String(bad)).toBe(false);
      expect(() => demoSeasonWindow(/** @type {any} */ (bad), '2027-05-10'), String(bad)).toThrow(
        TypeError
      );
    }
    expect(DEMO_SEASONS).toEqual(['fall', 'spring']);
  });

  it('refuses a day that is not a calendar date', () => {
    for (const bad of ['2027-02-30', '2027-13-01', '27-05-10', '2027-5-1', '', 'today']) {
      expect(() => demoSeasonWindow('fall', bad), bad).toThrow(TypeError);
      expect(() => defaultDemoSeason(bad), bad).toThrow(TypeError);
    }
  });
});

describe('the properties of the rule, over every day of 2026 to 2062', () => {
  const days = everyDay('2026-01-01', '2062-12-31');

  it('dates every day in a Monday-to-Sunday season that has not ended and is the earliest that has not', () => {
    expect(days.length).toBeGreaterThan(13_000);
    for (const season of DEMO_SEASONS) {
      const weeks = season === 'fall' ? 6 : 12;
      // the instance of each year, asked on 1 January (nothing of that year has ended yet)
      const ofYear = new Map(
        Array.from({ length: 39 }, (_, i) => 2025 + i).map((year) => [
          year,
          demoSeasonWindow(season, `${year}-01-01`),
        ])
      );
      for (const today of days) {
        const window = demoSeasonWindow(season, today);
        const startDay = new Date(`${window.start}T00:00:00Z`).getUTCDay();
        const endDay = new Date(`${window.end}T00:00:00Z`).getUTCDay();
        if (startDay !== 1 || endDay !== 0) throw new Error(`${season} ${today}: ${window.start}`);
        if (window.end < today) throw new Error(`${season} ${today}: ended before the day asked`);
        if ((Date.parse(window.end) - Date.parse(window.start)) / DAY_MS + 1 !== weeks * 7) {
          throw new Error(`${season} ${today}: wrong length`);
        }
        if (ofYear.get(window.year)?.start !== window.start) {
          throw new Error(`${season} ${today}: ${window.start} is not the ${window.year} instance`);
        }
        // the earliest: the year before's instance had ended
        if (!(ofYear.get(window.year - 1).end < today)) {
          throw new Error(`${season} ${today}: the earlier instance was still running`);
        }
      }
    }
  });

  it('defaults to the window the day falls in, else the next to begin (the one that ends first)', () => {
    let spring = 0;
    let fall = 0;
    for (const today of days) {
      const chosen = defaultDemoSeason(today);
      const ends = Object.fromEntries(DEMO_SEASONS.map((s) => [s, demoSeasonWindow(s, today).end]));
      const other = chosen === 'fall' ? 'spring' : 'fall';
      if (!(ends[chosen] < ends[other])) throw new Error(`${today}: ${chosen} does not end first`);
      if (chosen === 'spring') spring += 1;
      else fall += 1;
      expect(demoSeasonWindow(null, today).season).toBe(chosen);
      expect(demoSeasonWindow(undefined, today).season).toBe(chosen);
    }
    // each default is reached, so neither branch of the comparison is vacuous
    expect(spring).toBeGreaterThan(0);
    expect(fall).toBeGreaterThan(0);
    // a day inside a window defaults to that window
    expect(defaultDemoSeason('2027-04-30')).toBe('spring');
    expect(defaultDemoSeason('2027-08-20')).toBe('fall');
    // between them, to the one that begins next
    expect(defaultDemoSeason('2027-07-01')).toBe('fall');
    expect(defaultDemoSeason('2027-10-01')).toBe('spring');
  });
});

describe('what the entry page shows', () => {
  it("is today's date in the league's zone, not the host's", () => {
    // 22:30 on Sunday 1 November 2026 in Pacific time (clocks went back that morning) is Monday in UTC
    expect(demoToday(Date.parse('2026-11-02T06:30:00Z'))).toBe('2026-11-01');
    expect(demoToday(Date.parse('2026-11-02T08:00:00Z'))).toBe('2026-11-02');
    // the evening before the clocks go forward
    expect(demoToday(Date.parse('2027-03-14T09:59:00Z'))).toBe('2027-03-14');
    expect(demoToday(Date.parse('2027-03-14T07:59:00Z'))).toBe('2027-03-13');
    expect(demoToday(Date.parse('2027-03-14T10:00:00Z'))).toBe('2027-03-14');
    expect(demoToday()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('names a season and describes its dates', () => {
    const fall = demoSeasonWindow('fall', '2026-11-01');
    expect(demoSeasonName(fall)).toBe('Fall 2027');
    expect(describeDemoWindow(fall)).toBe('Aug 2 to Sep 12, 2027');
    expect(demoSeasonName(demoSeasonWindow('spring', '2026-11-01'))).toBe('Spring 2027');
    expect(describeDemoWindow({ start: '2027-12-27', end: '2028-02-06' })).toBe(
      'Dec 27, 2027 to Feb 6, 2028'
    );
  });

  it('offers the two buttons, fall first, each with the window it covers today', () => {
    expect(demoSeasonOptions('2026-11-01')).toEqual([
      expect.objectContaining({
        season: 'fall',
        name: 'Fall 2027',
        dates: 'Aug 2 to Sep 12, 2027',
        weeks: 6,
      }),
      expect.objectContaining({
        season: 'spring',
        name: 'Spring 2027',
        dates: 'Mar 22 to Jun 13, 2027',
        weeks: 12,
      }),
    ]);
  });
});

describe("the SQL twin, demo_seed.season_window(), and the seed's own constants", () => {
  const sessionsTest = readFileSync(
    path.join(path.dirname(DEMO_MIGRATION), '..', 'tests', 'demo_sessions.sql'),
    'utf8'
  );
  const BEGIN = '-- BEGIN season vectors (tests/demoSeasons.test.js; do not edit)';
  const END = '-- END season vectors';

  it('is run, in pgTAP, over exactly the vectors this file checks', () => {
    const begin = sessionsTest.indexOf(BEGIN);
    const end = sessionsTest.indexOf(END);
    expect(begin, 'the vector region is in demo_sessions.sql').toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(begin);
    const region = sessionsTest.slice(begin + BEGIN.length, end);
    expect(region).toContain(vectorsSql());
  });

  it("can fail: a changed vector is not the SQL test's", () => {
    const changed = VECTORS.map((v, i) => (i === 1 ? [v[0], v[1], v[2], v[3], '2027-09-19'] : v));
    expect(sessionsTest).not.toContain(vectorsSql(changed));
  });

  it("uses the league's zone and the spring's length from the seed", () => {
    const migration = readFileSync(DEMO_MIGRATION, 'utf8');
    const row = migration.match(
      /INSERT INTO demo_seed\.league \(organization_name, timezone, season_weeks\) VALUES\s*\('([^']+)', '([^']+)', (\d+)\)/
    );
    expect(row, 'the league row is in the seed').not.toBeNull();
    expect(row[2]).toBe(DEMO_TIMEZONE);
    expect(Number(row[3])).toBe(DEMO_SPRING_WEEKS);
  });
});

describe('before sunset: no unlit practice of the seeded grid is near it on any day of either window', () => {
  /** Minutes before sunset an unlit practice must be over (the owner wants practices to fit before it). */
  const MARGIN_MINUTES = 10;
  const FIRST_YEAR = 2026;
  const LAST_YEAR = 2060;

  const minutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
  const WEEKDAY = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const fields = Papa.parse(readFileSync(path.join(DEMO_FIXTURE_DIR, 'fields.csv'), 'utf8'), {
    header: true,
    skipEmptyLines: true,
  }).data;
  const facility = readFileSync(
    path.join(path.dirname(DEMO_MIGRATION), '20261110010000_demo_practices.sql'),
    'utf8'
  );
  /** The seed's venues: name, coordinates and lighting, read from the INSERT, not from the rule. */
  const venues = [
    ...facility
      .match(/INSERT INTO demo_seed\.locations[\s\S]*?;\n/)[0]
      .matchAll(/\('([^']+)', (-?[\d.]+), (-?[\d.]+), (true|false)\)/g),
  ].map(([, name, latitude, longitude, lit]) => ({
    name,
    latitude: Number(latitude),
    longitude: Number(longitude),
    lit: lit === 'true',
  }));
  const unlitVenues = venues.filter((v) => !v.lit);
  /** [weekday, end minute, venue] for every slot on unlit ground: what could be flagged. */
  const unlitSlots = fields
    .filter((f) => !venues.find((v) => v.name === f.Location).lit)
    .map((f) => ({ day: WEEKDAY[f.Day], end: minutes(f.End), venue: f.Location }));

  const sunsetCache = new Map();
  /** The enforced sunset (floor of the minutes) at a venue on a date. */
  function enforcedSunset(venue, date) {
    const key = `${venue.name}|${date}`;
    if (!sunsetCache.has(key)) {
      const input = {
        date,
        latitude: venue.latitude,
        longitude: venue.longitude,
        timeZone: DEMO_TIMEZONE,
      };
      sunsetCache.set(key, sunsetEnforcementMinutes(sunsetOnDate(input)));
    }
    return sunsetCache.get(key);
  }

  /**
   * Every (date, unlit slot) of the given instances that ends less than `margin` minutes before sunset.
   * @param {Array<{ start: string, end: string }>} instances
   */
  function tooLate(instances, margin = MARGIN_MINUTES) {
    const late = [];
    let examined = 0;
    for (const instance of instances) {
      for (const date of everyDay(instance.start, instance.end)) {
        const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
        for (const slot of unlitSlots) {
          if (slot.day !== weekday) continue;
          examined += 1;
          const venue = venues.find((v) => v.name === slot.venue);
          if (slot.end > enforcedSunset(venue, date) - margin)
            late.push(`${date} ${slot.venue} ${slot.end}`);
        }
      }
    }
    return { late, examined };
  }

  /** Both choices' instances for each year (asked on 1 Jan, so the instance of that year). */
  const instancesOf = (season, from = FIRST_YEAR, to = LAST_YEAR) =>
    Array.from({ length: to - from + 1 }, (_, i) => demoSeasonWindow(season, `${from + i}-01-01`));

  it('reads the grid it examines from the seed: unlit venues, and slots ending at 17:00, 18:00 and 19:00', () => {
    expect(unlitVenues.map((v) => v.name).sort()).toEqual([
      'Orchard Park',
      'Riverside Fields',
      'Valley View Park',
    ]);
    expect(new Set(unlitSlots.map((s) => s.end))).toEqual(
      new Set(
        [17, 18, 19].map((h) => h * 60).concat([9 * 60 + 30, 10 * 60 + 15, 11 * 60, 11 * 60 + 45])
      )
    );
    expect(Math.max(...unlitSlots.filter((s) => s.day >= 1 && s.day <= 5).map((s) => s.end))).toBe(
      19 * 60
    );
  });

  it(`ends every unlit practice at least ${MARGIN_MINUTES} minutes before sunset, on every practice day of both windows, 2026-2060`, () => {
    for (const season of DEMO_SEASONS) {
      const instances = instancesOf(season);
      expect(instances).toHaveLength(LAST_YEAR - FIRST_YEAR + 1);
      const { late, examined } = tooLate(instances);
      // the examined count is derived from the grid and the calendar, not from the check:
      // 35 instances x weeks x (the slots a week on unlit ground)
      const slotsPerWeek = unlitSlots.length;
      expect(examined, `${season} slot-days examined`).toBe(
        instances.length * demoSeasonWindow(season, '2027-01-01').weeks * slotsPerWeek
      );
      expect(late.slice(0, 5), `${season}: ${late.length} slot-days too near sunset`).toEqual([]);
    }
  });

  it('agrees between the two arms of the sunset helper on those days (the Edge twin runs the live check)', () => {
    for (const season of DEMO_SEASONS) {
      for (const instance of instancesOf(season, 2026, 2030)) {
        for (const date of everyDay(instance.start, instance.end)) {
          for (const venue of unlitVenues) {
            const input = {
              date,
              latitude: venue.latitude,
              longitude: venue.longitude,
              timeZone: DEMO_TIMEZONE,
            };
            const core = sunsetOnDate(input);
            const edge = edgeSunsetOnDate(input);
            if (core.minutes !== edge.minutes) throw new Error(`${date} ${venue.name}`);
          }
        }
      }
    }
  });

  it('can fail: a fall two weeks too long, a spring before the clocks go forward, a winter season', () => {
    const longFall = instancesOf('fall').map((w) => ({
      ...w,
      end: iso(Date.parse(w.end) + 14 * DAY_MS),
    }));
    expect(tooLate(longFall).late.length).toBeGreaterThan(0);
    const earlySpring = instancesOf('spring').map((w) => ({
      ...w,
      start: iso(Date.parse(w.start) - 21 * DAY_MS),
    }));
    expect(tooLate(earlySpring).late.length).toBeGreaterThan(0);
    // the old rule: the twelve weeks that begin the Monday after a demo is started in November
    expect(tooLate([{ start: '2026-11-02', end: '2027-01-24' }]).late.length).toBeGreaterThan(0);
    // and the margin itself bites: with none, the real windows pass; with an hour, they do not
    expect(tooLate(instancesOf('fall'), 0).late).toEqual([]);
    expect(tooLate(instancesOf('fall'), 60).late.length).toBeGreaterThan(0);
  });

  it("is not a vacuous proof: the windows' tightest day is within an hour of the margin", () => {
    for (const season of DEMO_SEASONS) {
      const instances = instancesOf(season);
      let tightest = Infinity;
      for (const instance of instances) {
        for (const date of everyDay(instance.start, instance.end)) {
          const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
          for (const slot of unlitSlots) {
            if (slot.day !== weekday) continue;
            const venue = venues.find((v) => v.name === slot.venue);
            tightest = Math.min(tightest, enforcedSunset(venue, date) - slot.end);
          }
        }
      }
      expect(tightest, `${season}`).toBeGreaterThanOrEqual(MARGIN_MINUTES);
      expect(tightest, `${season}`).toBeLessThan(MARGIN_MINUTES + 60);
    }
  });
});
