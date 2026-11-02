// @vitest-environment node
/**
 * The demo's two seasons (plans docs/changes/2026-11-01-demo-season-selection.md and
 * docs/changes/2026-11-02-demo-fall-window.md): the rule that dates a demo's season from the visitor's
 * choice, in `frontend/src/lib/demoSeasons.js`, and the server's twin of it, `demo_seed.season_window()`
 * (migrations 20261114010000 and, for the fall, 20261115010000).
 *
 *   - **the rule**: a table of vectors (a date inside each window, the day before a start, a window's
 *     last day and the day after it, an anchor that falls on a Sunday, a leap day, the turn of the year);
 *   - **the properties**, over every day of 2026 to 2062: the spring starts on a Monday and ends 12 weeks
 *     later on a Sunday; the fall starts on the Monday on or after 17 August and ends on 31 October of that
 *     year; each ends on or after the day asked and is the earliest instance that does; the default is the
 *     one that ends first;
 *   - **the mirror**: the vectors above are embedded, verbatim, in `supabase/tests/demo_sessions.sql`,
 *     which runs the SQL function over them, so the two implementations are held to one table;
 *   - **the spring is clear of the sun**: with the repository's sunset helper, at the seed's own unlit
 *     venues and its own slot ends (both read from the seed, not from the rule), no unlit practice ends
 *     within ten minutes of sunset on any practice day of the spring in any year to 2060;
 *   - **the fall is flagged, by design** (owner, 2026-11-02: "Flag them ... A warning keeps room for that,
 *     refusal would break configs that users may otherwise stick with"): the practice days of the fall on
 *     which a seeded unlit slot ends past sunset are derived from the seed and the real sunset helper (core
 *     and Edge arms agreeing to the minute), and the product's own Edge daylight pass reports exactly the
 *     first such day for each of the seeded practices. Each comparison can fail: a minute of sunset, a slot
 *     end, or a fall that runs past 31 October each change the answer.
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
import {
  sunsetOnDate as edgeSunsetOnDate,
  sunsetEnforcementMinutes as edgeSunsetEnforcementMinutes,
} from '../supabase/functions/_shared/timing/solar.ts';
import {
  addDays,
  applyDaylightPostPass,
} from '../supabase/functions/_shared/engines/practice-daylight.js';
import { DEMO_FIXTURE_DIR, DEMO_MIGRATION } from '../scripts/build-demo-seed.mjs';

/** [choice (null = none), today, season, start, end]: the table both implementations are held to. */
const VECTORS = [
  ['spring', '2026-11-01', 'spring', '2027-03-22', '2027-06-13'],
  ['fall', '2026-11-01', 'fall', '2027-08-23', '2027-10-31'],
  [null, '2026-11-01', 'spring', '2027-03-22', '2027-06-13'],
  ['fall', '2027-05-10', 'fall', '2027-08-23', '2027-10-31'],
  ['spring', '2027-05-10', 'spring', '2027-03-22', '2027-06-13'],
  [null, '2027-05-10', 'spring', '2027-03-22', '2027-06-13'],
  [null, '2027-06-14', 'fall', '2027-08-23', '2027-10-31'],
  ['spring', '2027-06-13', 'spring', '2027-03-22', '2027-06-13'],
  ['spring', '2027-06-14', 'spring', '2028-03-27', '2028-06-18'],
  [null, '2027-10-31', 'fall', '2027-08-23', '2027-10-31'],
  [null, '2027-11-01', 'spring', '2028-03-27', '2028-06-18'],
  ['fall', '2027-11-01', 'fall', '2028-08-21', '2028-10-31'],
  [null, '2027-12-31', 'spring', '2028-03-27', '2028-06-18'],
  [null, '2028-01-01', 'spring', '2028-03-27', '2028-06-18'],
  ['spring', '2028-02-29', 'spring', '2028-03-27', '2028-06-18'],
  [null, '2027-08-01', 'fall', '2027-08-23', '2027-10-31'],
  ['fall', '2026-08-02', 'fall', '2026-08-17', '2026-10-31'],
  ['spring', '2026-03-22', 'spring', '2026-03-23', '2026-06-14'],
  [null, '2026-03-22', 'spring', '2026-03-23', '2026-06-14'],
  ['fall', '2028-12-31', 'fall', '2029-08-20', '2029-10-31'],
  ['spring', '2029-03-22', 'spring', '2029-03-26', '2029-06-17'],
  ['fall', '2027-08-02', 'fall', '2027-08-23', '2027-10-31'],
  [null, '2027-03-21', 'spring', '2027-03-22', '2027-06-13'],
  [null, '2027-03-22', 'spring', '2027-03-22', '2027-06-13'],
  // the fall of 2026: anchored on a Monday (17 Aug), ending on a Saturday, its last day still its own
  ['fall', '2026-08-17', 'fall', '2026-08-17', '2026-10-31'],
  ['fall', '2026-10-31', 'fall', '2026-08-17', '2026-10-31'],
  [null, '2026-10-31', 'fall', '2026-08-17', '2026-10-31'],
  // 17 Aug 2027 is a Tuesday: the anchor is the Monday after it, 23 Aug
  ['fall', '2027-08-17', 'fall', '2027-08-23', '2027-10-31'],
  // a season that ends on a Tuesday
  ['fall', '2028-10-31', 'fall', '2028-08-21', '2028-10-31'],
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

  it('holds its own table to the calendar: every start is a Monday, a spring ends on a Sunday, a fall on 31 October', () => {
    expect(VECTORS.length).toBeGreaterThanOrEqual(20);
    const ends = new Set();
    for (const [, , season, start, end] of VECTORS) {
      expect(new Date(`${start}T00:00:00Z`).getUTCDay(), `${start} is a Monday`).toBe(1);
      if (season === 'spring') {
        expect(new Date(`${end}T00:00:00Z`).getUTCDay(), `${end} is a Sunday`).toBe(0);
      } else {
        expect(end.slice(5), `${end} is 31 October`).toBe('10-31');
        expect(end.slice(0, 4), 'the fall ends in the year it starts').toBe(start.slice(0, 4));
        // the anchor: the first Monday on or after 17 August, i.e. one of 17 to 23 August
        expect(
          start.slice(5) >= '08-17' && start.slice(5) <= '08-23',
          `${start} is 17-23 Aug`
        ).toBe(true);
        ends.add(new Date(`${end}T00:00:00Z`).getUTCDay());
      }
    }
    // the table reaches a fall ending on a Saturday (2026), a Sunday (2027), a Tuesday (2028) and a
    // Wednesday (2029): the end is a date, so it is no weekday in particular
    expect([...ends].sort()).toEqual([0, 2, 3, 6]);
  });

  it('chooses fall in spring from this year and after 31 October from the next, never a past one', () => {
    expect(demoSeasonWindow('fall', '2027-04-15').start).toBe('2027-08-23');
    // the fall runs to the end of October, so mid-October is still this year's
    expect(demoSeasonWindow('fall', '2027-10-15').start).toBe('2027-08-23');
    expect(demoSeasonWindow('fall', '2027-11-15').start).toBe('2028-08-21');
    expect(demoSeasonWindow('spring', '2027-10-15').start).toBe('2028-03-27');
  });

  it('keeps a window until its last day and not a day longer', () => {
    expect(demoSeasonWindow('fall', '2027-10-31').start).toBe('2027-08-23');
    expect(demoSeasonWindow('fall', '2027-11-01').start).toBe('2028-08-21');
    expect(demoSeasonWindow('spring', '2027-06-13').start).toBe('2027-03-22');
    expect(demoSeasonWindow('spring', '2027-06-14').start).toBe('2028-03-27');
  });

  it("lengths: the spring is the league season_weeks; the fall ends on a date, so its length is the calendar's", () => {
    const spring = demoSeasonWindow('spring', '2027-01-01');
    expect((Date.parse(spring.end) - Date.parse(spring.start)) / DAY_MS + 1).toBe(
      DEMO_SPRING_WEEKS * 7
    );
    expect(spring.weeks).toBe(DEMO_SPRING_WEEKS);
    // Monday 17 Aug to Saturday 31 Oct 2026 is 76 days (11 weeks counting the part week); 2027 is 70 (10);
    // 2028 ends on a Tuesday after 72 days (11): the weeks are those the season touches
    const days = (w) => (Date.parse(w.end) - Date.parse(w.start)) / DAY_MS + 1;
    const falls = [2026, 2027, 2028].map((y) => demoSeasonWindow('fall', `${y}-01-01`));
    expect(falls.map(days)).toEqual([76, 70, 72]);
    expect(falls.map((w) => w.weeks)).toEqual([11, 10, 11]);
    for (const w of falls) expect(w.weeks).toBe(Math.ceil(days(w) / 7));
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

  it('dates every day in a season that starts on a Monday, has not ended, and is the earliest that has not', () => {
    expect(days.length).toBeGreaterThan(13_000);
    for (const season of DEMO_SEASONS) {
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
        if (startDay !== 1) throw new Error(`${season} ${today}: ${window.start} is not a Monday`);
        if (window.end < today) throw new Error(`${season} ${today}: ended before the day asked`);
        if (season === 'spring') {
          // twelve weeks (the league's season_weeks) from the Monday on or after 22 March, to a Sunday
          const endDay = new Date(`${window.end}T00:00:00Z`).getUTCDay();
          if (endDay !== 0) throw new Error(`${season} ${today}: ${window.end} is not a Sunday`);
          if ((Date.parse(window.end) - Date.parse(window.start)) / DAY_MS + 1 !== 12 * 7) {
            throw new Error(`${season} ${today}: wrong length`);
          }
          if (window.start < `${window.year}-03-22` || window.start > `${window.year}-03-28`) {
            throw new Error(
              `${season} ${today}: ${window.start} is not the Monday on or after 22 March`
            );
          }
        } else {
          // the Monday on or after 17 August, to 31 October of that year (owner, 2026-11-02)
          if (window.end !== `${window.year}-10-31`) {
            throw new Error(`${season} ${today}: ${window.end} is not 31 October`);
          }
          if (window.start < `${window.year}-08-17` || window.start > `${window.year}-08-23`) {
            throw new Error(
              `${season} ${today}: ${window.start} is not the Monday on or after 17 August`
            );
          }
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
    expect(defaultDemoSeason('2027-10-15')).toBe('fall');
    // between them, to the one that begins next
    expect(defaultDemoSeason('2027-07-01')).toBe('fall');
    expect(defaultDemoSeason('2027-11-01')).toBe('spring');
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
    expect(describeDemoWindow(fall)).toBe('Aug 23 to Oct 31, 2027');
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
        dates: 'Aug 23 to Oct 31, 2027',
        weeks: 10,
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
    const changed = VECTORS.map((v, i) => (i === 1 ? [v[0], v[1], v[2], v[3], '2027-11-07'] : v));
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

/** The seed's grid and venues, read from the fixture and the migration, not from the rule under test. */
const minutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const WEEKDAY = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const WEEKDAY_CODE = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
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
const venueNamed = (name) => venues.find((v) => v.name === name);
const unlitVenues = venues.filter((v) => !v.lit);
/** [weekday, end minute, venue] for every slot on unlit ground: what could be flagged. */
const unlitSlots = fields
  .filter((f) => !venueNamed(f.Location).lit)
  .map((f) => ({ day: WEEKDAY[f.Day], end: minutes(f.End), venue: f.Location }));
/** The same, once per distinct (venue, weekday, end): a flag is a property of that, not of each field. */
const distinctUnlitSlots = [
  ...new Map(unlitSlots.map((s) => [`${s.venue}|${s.day}|${s.end}`, s])).values(),
];

const sunsetCache = new Map();
/**
 * The enforced sunset (floor of the minutes) at a venue on a date: core's helper by default, the Edge twin's
 * when `arm` is 'edge'. `shift` moves the answer by that many minutes (a planted defect, for the checks that
 * must be able to fail).
 */
function enforcedSunset(venue, date, { arm = 'core', shift = 0 } = {}) {
  const key = `${arm}|${venue.name}|${date}`;
  if (!sunsetCache.has(key)) {
    const input = {
      date,
      latitude: venue.latitude,
      longitude: venue.longitude,
      timeZone: DEMO_TIMEZONE,
    };
    sunsetCache.set(
      key,
      arm === 'edge'
        ? edgeSunsetEnforcementMinutes(edgeSunsetOnDate(input))
        : sunsetEnforcementMinutes(sunsetOnDate(input))
    );
  }
  return sunsetCache.get(key) + shift;
}

/** Both choices' instances for each year (asked on 1 Jan, so the instance of that year). */
const FIRST_YEAR = 2026;
const LAST_YEAR = 2060;
const instancesOf = (season, from = FIRST_YEAR, to = LAST_YEAR) =>
  Array.from({ length: to - from + 1 }, (_, i) => demoSeasonWindow(season, `${from + i}-01-01`));
const weekdayOf = (date) => new Date(`${date}T00:00:00Z`).getUTCDay();

describe('the seed the sunset checks read', () => {
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
    // the lit ground (Eastgate) is exempt and is not among the slots examined
    expect(venues.filter((v) => v.lit).map((v) => v.name)).toEqual(['Eastgate Sports Complex']);
    expect(unlitSlots.some((s) => s.venue === 'Eastgate Sports Complex')).toBe(false);
  });
});

describe('the spring: no unlit practice of the seeded grid is near sunset on any day of the window', () => {
  /** Minutes before sunset an unlit practice must be over (the owner wants practices to fit before it). */
  const MARGIN_MINUTES = 10;

  /**
   * Every (date, unlit slot) of the given instances that ends less than `margin` minutes before sunset.
   * @param {Array<{ start: string, end: string }>} instances
   */
  function tooLate(instances, margin = MARGIN_MINUTES) {
    const late = [];
    let examined = 0;
    for (const instance of instances) {
      for (const date of everyDay(instance.start, instance.end)) {
        const weekday = weekdayOf(date);
        for (const slot of unlitSlots) {
          if (slot.day !== weekday) continue;
          examined += 1;
          if (slot.end > enforcedSunset(venueNamed(slot.venue), date) - margin)
            late.push(`${date} ${slot.venue} ${slot.end}`);
        }
      }
    }
    return { late, examined };
  }

  it(`ends every unlit practice at least ${MARGIN_MINUTES} minutes before sunset, on every practice day of the spring, 2026-2060`, () => {
    const instances = instancesOf('spring');
    expect(instances).toHaveLength(LAST_YEAR - FIRST_YEAR + 1);
    const { late, examined } = tooLate(instances);
    // the examined count is derived from the grid and the calendar, not from the check:
    // 35 instances x weeks x (the slots a week on unlit ground)
    expect(examined, 'spring slot-days examined').toBe(
      instances.length * demoSeasonWindow('spring', '2027-01-01').weeks * unlitSlots.length
    );
    expect(late.slice(0, 5), `spring: ${late.length} slot-days too near sunset`).toEqual([]);
  });

  it('can fail: a spring before the clocks go forward, a winter season, a margin of an hour', () => {
    const earlySpring = instancesOf('spring').map((w) => ({
      ...w,
      start: iso(Date.parse(w.start) - 21 * DAY_MS),
    }));
    expect(tooLate(earlySpring).late.length).toBeGreaterThan(0);
    // the old rule: the twelve weeks that begin the Monday after a demo is started in November
    expect(tooLate([{ start: '2026-11-02', end: '2027-01-24' }]).late.length).toBeGreaterThan(0);
    // and the margin itself bites: with none, the real windows pass; with an hour, they do not
    expect(tooLate(instancesOf('spring'), 0).late).toEqual([]);
    expect(tooLate(instancesOf('spring'), 60).late.length).toBeGreaterThan(0);
  });

  it("is not a vacuous proof: the spring's tightest day is within an hour of the margin", () => {
    let tightest = Infinity;
    for (const instance of instancesOf('spring')) {
      for (const date of everyDay(instance.start, instance.end)) {
        for (const slot of unlitSlots) {
          if (slot.day !== weekdayOf(date)) continue;
          tightest = Math.min(tightest, enforcedSunset(venueNamed(slot.venue), date) - slot.end);
        }
      }
    }
    expect(tightest).toBeGreaterThanOrEqual(MARGIN_MINUTES);
    expect(tightest).toBeLessThan(MARGIN_MINUTES + 60);
  });
});

describe('the fall: sunset flags on its evening practices are expected, and exactly these', () => {
  /**
   * The practice days of the instances on which an unlit slot of the seed ends past sunset, by the sunset
   * helper (core by default). A flag is `end > floor(sunset)` (`PRACTICE_SUNSET_MARGIN_MINUTES` is 0).
   * @param {Array<{ start: string, end: string }>} instances
   * @param {Parameters<typeof enforcedSunset>[2]} [options]
   */
  function flaggedDays(instances, options) {
    /** @type {Array<{ date: string, venue: string, end: number }>} */
    const flagged = [];
    let examined = 0;
    for (const instance of instances) {
      for (const date of everyDay(instance.start, instance.end)) {
        const weekday = weekdayOf(date);
        for (const slot of distinctUnlitSlots) {
          if (slot.day !== weekday) continue;
          examined += 1;
          if (slot.end > enforcedSunset(venueNamed(slot.venue), date, options)) {
            flagged.push({ date, venue: slot.venue, end: slot.end });
          }
        }
      }
    }
    return { flagged, examined };
  }
  const key = (f) => `${f.date}|${f.venue}|${f.end}`;
  const fallInstances = instancesOf('fall');

  it('walks the whole window of every fall, from the seed: the examined count is the grid times the calendar', () => {
    expect(fallInstances).toHaveLength(LAST_YEAR - FIRST_YEAR + 1);
    const { examined } = flaggedDays(fallInstances);
    let expected = 0;
    for (const instance of fallInstances) {
      for (const date of everyDay(instance.start, instance.end)) {
        expected += distinctUnlitSlots.filter((s) => s.day === weekdayOf(date)).length;
      }
    }
    expect(examined).toBe(expected);
    expect(examined).toBeGreaterThan(fallInstances.length * 50);
  });

  it('flags the same practice days with the core helper and the Edge twin, to the minute', () => {
    const core = flaggedDays(fallInstances);
    const edge = flaggedDays(fallInstances, { arm: 'edge' });
    expect(edge.flagged.map(key)).toEqual(core.flagged.map(key));
    expect(edge.examined).toBe(core.examined);
    // the arms agree on the sunset itself, not only on the flags derived from it
    for (const instance of fallInstances.slice(0, 5)) {
      for (const date of everyDay(instance.start, instance.end)) {
        for (const venue of unlitVenues) {
          expect(enforcedSunset(venue, date, { arm: 'edge' }), `${date} ${venue.name}`).toBe(
            enforcedSunset(venue, date)
          );
        }
      }
    }
  });

  it('flags the latest slot in every fall, never the earliest or anything in August, and once flagged keeps flagging', () => {
    const { flagged } = flaggedDays(fallInstances);
    const weekdayEnds = unlitSlots.filter((s) => s.day >= 1 && s.day <= 5).map((s) => s.end);
    const latestWeekdayEnd = Math.max(...weekdayEnds);
    const earliestWeekdayEnd = Math.min(...weekdayEnds);
    for (const instance of fallInstances) {
      const mine = flagged.filter((f) => f.date >= instance.start && f.date <= instance.end);
      // the fall is flagged in every year: the latest slot ends past sunset before the window is over
      expect(mine.length, instance.start).toBeGreaterThan(0);
      // the earliest weekday slot never is (it is in daylight on 31 October)
      expect(
        mine.every((f) => f.end > earliestWeekdayEnd),
        instance.start
      ).toBe(true);
      // the first flag is after August, and the latest slot is among the flagged
      const first = mine.map((f) => f.date).sort()[0];
      expect(first >= `${instance.year}-09-01`, `${instance.start}: first flag ${first}`).toBe(
        true
      );
      expect(mine.some((f) => f.end === latestWeekdayEnd)).toBe(true);
      // once a slot end is past sunset at a venue it stays so on every later practice day of the window
      // (sunset only comes earlier through the autumn, and the clocks change after the window)
      for (const slot of distinctUnlitSlots) {
        const days = mine
          .filter((f) => f.venue === slot.venue && f.end === slot.end)
          .map((f) => f.date);
        if (days.length === 0) continue;
        const firstFlag = days.sort()[0];
        const later = everyDay(firstFlag, instance.end).filter((d) => weekdayOf(d) === slot.day);
        expect(
          later.every((d) => days.includes(d)),
          `${instance.start} ${slot.venue} ${slot.end}`
        ).toBe(true);
      }
    }
  });

  /**
   * The seeded practices (`demo_seed.practice_schedule`, read from the migration): team, ground, weekday,
   * start; each joined to its slot in the fixture's grid for the end.
   */
  const seeded = (() => {
    const block = facility.slice(
      facility.indexOf('INSERT INTO demo_seed.practice_schedule'),
      facility.indexOf('-- END GENERATED demo_seed practice rows')
    );
    const slotEnd = new Map(
      fields.map((f) => [
        `${f.Location}|${f.Field}|${f.Subunit}|${WEEKDAY[f.Day]}|${f.Start}`,
        f.End,
      ])
    );
    return [
      ...block.matchAll(
        /\('([^']+)', '([^']+)', '([^']+)', (NULL|'[^']*'), '([a-z]{3})', '(\d\d:\d\d)'\)/g
      ),
    ].map(([, team, venue, field, sub, day, start]) => {
      const subunit = sub === 'NULL' ? '' : sub.slice(1, -1);
      const end = slotEnd.get(`${venue}|${field}|${subunit}|${WEEKDAY_CODE[day]}|${start}`);
      return { team, venue, field, subunit, day: WEEKDAY_CODE[day], start, end };
    });
  })();

  it('reads the seeded practices from the migration and finds every one its slot', () => {
    expect(seeded.length).toBeGreaterThanOrEqual(130);
    expect(seeded.every((r) => r.end !== undefined)).toBe(true);
    expect(new Set(seeded.map((r) => r.team)).size).toBeGreaterThan(64);
    // the U4 cohorts' Saturday sessions are among them, and none is on the lit ground
    expect(seeded.filter((r) => r.day === 6)).toHaveLength(4);
    expect(seeded.some((r) => venueNamed(r.venue).lit)).toBe(false);
  });

  /**
   * The product's own daylight pass (the Edge Function's `applyDaylightPostPass`) over the demo as a fall
   * visitor has it: every seeded practice is a saved (locked) row running from its weekday's first date to
   * the season's last day, and one new placement per distinct slot stands for the teams the visitor's own
   * run places. Returns what the pass reports, by assignment and by slot.
   * @param {{ start: string, end: string }} instance
   * @param {{ endShift?: number }} [options] `endShift` moves every slot's end (a planted defect)
   */
  function runPass(instance, { endShift = 0 } = {}) {
    const venueRows = new Map(
      venues.map((v) => [
        v.name,
        {
          fieldId: v.name,
          locationId: v.name,
          lit: v.lit,
          latitude: v.latitude,
          longitude: v.longitude,
        },
      ])
    );
    const firstOn = (day) => {
      let date = instance.start;
      while (weekdayOf(date) !== day) date = addDays(date, 1);
      return date;
    };
    const slotId = (r) => `${r.venue}|${r.field}|${r.subunit}|${r.day}|${r.start}`;
    const slots = new Map();
    for (const r of seeded) {
      if (slots.has(slotId(r))) continue;
      const endMinutes = minutes(r.end) + endShift;
      slots.set(slotId(r), {
        id: slotId(r),
        fieldId: r.venue,
        firstDate: firstOn(r.day),
        effectiveUntil: instance.end,
        startSeconds: minutes(r.start) * 60,
        endSeconds: endMinutes * 60,
        endMinutes,
      });
    }
    const locked = seeded.map((r, i) => ({
      assignmentId: `a${i}`,
      teamId: r.team,
      slotId: slotId(r),
      // a daterange(..., '[]') as Postgres stores it: [first, last + 1)
      effectiveDateRange: `[${firstOn(r.day)},${addDays(instance.end, 1)})`,
    }));
    const placements = [...slots.keys()].map((id) => ({
      teamId: `new ${id}`,
      slotId: id,
      source: /** @type {const} */ ('auto'),
    }));
    const { report } = applyDaylightPostPass({
      placements,
      unassigned: [],
      locked,
      slots,
      venues: venueRows,
      timeZone: DEMO_TIMEZONE,
      today: null,
    });
    return {
      report,
      lockedFirst: new Map(report.lockedPastSunset.map((l) => [l.assignmentId, l])),
      placedFirst: new Map(report.pastSunset.map((p) => [p.slotId, p])),
      slots,
      locked,
    };
  }

  /**
   * What the sunset helper says for the same practices, independently of the pass: the first date from the
   * row's first date to the season's end on which the slot ends after floor(sunset), or null.
   */
  function expectedFirst(instance, row, options) {
    let date = instance.start;
    while (weekdayOf(date) !== row.day) date = addDays(date, 1);
    for (; date <= instance.end; date = addDays(date, 7)) {
      const limit = enforcedSunset(venueNamed(row.venue), date, options);
      if (minutes(row.end) > limit) return { date, limit };
    }
    return null;
  }

  /** Mismatches between a pass's report and the helper's answer, over the seeded practices. */
  function mismatches(instance, pass, options) {
    const bad = [];
    seeded.forEach((row, i) => {
      const want = expectedFirst(instance, row, options);
      const got = pass.lockedFirst.get(`a${i}`);
      if (!want && got)
        bad.push(`${row.team} ${row.day} ${row.start}: reported ${got.date}, none due`);
      else if (want && !got)
        bad.push(`${row.team} ${row.day} ${row.start}: ${want.date} not reported`);
      else if (want && (got.date !== want.date || got.limitMinutes !== want.limit)) {
        bad.push(
          `${row.team} ${row.day} ${row.start}: ${got.date}/${got.limitMinutes} want ${want.date}/${want.limit}`
        );
      }
    });
    return bad;
  }

  it("the product's daylight pass reports, for each seeded practice, the first day the helper puts it past sunset", () => {
    for (const instance of fallInstances) {
      const pass = runPass(instance);
      expect(mismatches(instance, pass), `fall ${instance.start}`).toEqual([]);
      // every seeded practice was judged (the lit ground has none), so a missing report is a real absence
      expect(pass.report.meta.lockedRowsExamined, instance.start).toBe(seeded.length);
      // the count of rows reported is the count the helper gives, derived from the seed
      const due = seeded.filter((row) => expectedFirst(instance, row)).length;
      expect(pass.report.lockedPastSunset, instance.start).toHaveLength(due);
      expect(due, `${instance.start}: some of the seeded practices are flagged`).toBeGreaterThan(0);
      expect(due, `${instance.start}: and not all`).toBeLessThan(seeded.length);
      // the rows are kept, never moved: past sunset is flagged, not blocked
      for (const l of pass.report.lockedPastSunset) expect(l.proposedFix.applied).toBe(false);
    }
  });

  it("and for a new placement in each slot the seeded practices use, as the visitor's own run would place one", () => {
    for (const instance of fallInstances) {
      const pass = runPass(instance);
      let flaggedSlots = 0;
      for (const [id, slot] of pass.slots) {
        const row = seeded.find(
          (r) => `${r.venue}|${r.field}|${r.subunit}|${r.day}|${r.start}` === id
        );
        const want = expectedFirst(instance, row);
        const got = pass.placedFirst.get(id);
        expect(got?.date ?? null, `${instance.start} ${id}`).toBe(want?.date ?? null);
        expect(slot.endMinutes).toBe(minutes(row.end));
        if (want) flaggedSlots += 1;
      }
      // some slots are flagged and some are not, so neither answer is the pass's default
      expect(flaggedSlots, instance.start).toBeGreaterThan(0);
      expect(flaggedSlots, instance.start).toBeLessThan(pass.slots.size);
      expect(pass.report.pastSunset, instance.start).toHaveLength(flaggedSlots);
    }
  });

  it('can fail: a sunset a minute off, a slot a minute longer, and a fall that runs on into November', () => {
    // the fall of 2026, where the pass agrees with the helper as it is
    const [instance] = fallInstances;
    expect(mismatches(instance, runPass(instance))).toEqual([]);
    // a helper that answers one minute earlier or later is not the pass's: some seeded practice's first
    // flagged day (or its limit) moves, so the comparison goes red
    expect(mismatches(instance, runPass(instance), { shift: -1 }).length).toBeGreaterThan(0);
    expect(mismatches(instance, runPass(instance), { shift: 1 }).length).toBeGreaterThan(0);
    // a pass fed slots that end a minute later is not the helper's answer for the seed
    expect(mismatches(instance, runPass(instance, { endShift: 1 })).length).toBeGreaterThan(0);
    // the flagged days are those of the window: run on two more weeks and the 18:00 slots are flagged too,
    // so a longer fall is a different set
    const longer = fallInstances.map((w) => ({ ...w, end: iso(Date.parse(w.end) + 14 * DAY_MS) }));
    const base = flaggedDays(fallInstances).flagged;
    const extended = flaggedDays(longer).flagged;
    expect(extended.length).toBeGreaterThan(base.length);
    expect(base.some((f) => f.end === 18 * 60)).toBe(false);
    expect(extended.some((f) => f.end === 18 * 60)).toBe(true);
    // and the comparison between the two arms is an equality that a shifted sunset breaks
    const shifted = flaggedDays(fallInstances, { shift: 1 }).flagged.map(key);
    expect(shifted).not.toEqual(base.map(key));
  });
});
