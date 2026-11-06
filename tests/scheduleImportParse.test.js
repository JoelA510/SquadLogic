// @vitest-environment node
/**
 * The schedule import's parse (`packages/core/src/scheduleImport/parseRows.js`, plan
 * `docs/changes/2026-11-03-schedule-expansion.md` sections 4.3, 4.4, 4.8; PR 4 task D2).
 *
 * What this holds:
 *
 *   - **Dates and times are read by rule, never guessed**: both date forms (`YYYY-MM-DD`,
 *     `M/D/YYYY` read as US), both time forms (24-hour, 12-hour with `AM`/`PM`, including the two
 *     that trip a naive reader, `12:00 AM` and `12:30 PM`). `13/04/2026` is `bad-date`; it is NOT
 *     read as the 13th of April. A day the calendar lacks is `bad-date`.
 *   - **The host zone is not an input**: the whole fixture, and named-date cases in four zones, are
 *     parsed under other `TZ` values and compared; the instants come from the season clock.
 *   - **Every reason of the closed list is reached** by an input in this file or in
 *     `fixtures/schedule-2026/schedule-invalid.csv`, whose rows each carry the verdict the
 *     generator expects (`Notes`). A final test requires the set reached to cover the list, so
 *     adding a reason with no test fails.
 *   - **The allowlist**: a column that is not in plan 4.3 is dropped before anything is read from
 *     it; its values appear nowhere in the result.
 *   - **The week rule** (decision 17): the `Week` column, else one plus the whole weeks since the
 *     Monday of the week the season starts; before the window is `outside-season-window`.
 *
 * Statically out of reach, and so not claimed: that the Edge function's mirror (PR 6) reads the
 * same way (it does not exist yet), and that a spreadsheet's own CSV export always yields these
 * forms (a date cell exported as `4/13/26` is `bad-date` here, by design).
 */

import { describe, expect, it } from 'vitest';
import * as scheduleImport from '../packages/core/src/scheduleImport/index.js';
import * as audit from '../packages/core/src/scheduleImport/audit.js';
import * as mapping from '../packages/core/src/scheduleImport/mapping.js';
import * as parseModule from '../packages/core/src/scheduleImport/parseRows.js';
import * as reasonModule from '../packages/core/src/scheduleImport/reasonCodes.js';
import {
  SCHEDULE_IMPORT_FILE_REFUSALS,
  SCHEDULE_IMPORT_FLAGS,
  SCHEDULE_IMPORT_LIMITS,
  SCHEDULE_IMPORT_REASON,
  SCHEDULE_IMPORT_ROW_REFUSALS,
  describeScheduleImportReason,
} from '../packages/core/src/scheduleImport/reasonCodes.js';
import {
  parseScheduleDate,
  parseScheduleLength,
  parseScheduleRows,
  parseScheduleTime,
  scheduleWeekOf,
} from '../packages/core/src/scheduleImport/parseRows.js';
import {
  resolveScheduleRows,
  teamDecisionKey,
} from '../packages/core/src/scheduleImport/mapping.js';
import { loadScheduleFixture } from './helpers/scheduleFixtureLoad.js';

const SEASON = { timeZone: 'America/Los_Angeles', startDate: '2026-09-07', endDate: '2027-03-31' };
const HEADERS = [
  'Game ID',
  'Date',
  'Start Time',
  'End Time',
  'Venue',
  'Field',
  'Division',
  'Home Team',
  'Away Team',
  'Week',
];
const row = (over = {}) => ({
  'Game ID': 'G-1',
  Date: '2026-09-12',
  'Start Time': '09:00',
  'End Time': '10:00',
  Venue: 'Venue A',
  Field: 'Field 1',
  Division: 'U05 Boys',
  'Home Team': 'U05B Team 01',
  'Away Team': 'U05B Team 02',
  Week: '1',
  ...over,
});
const parse = (rows, extra = {}) =>
  parseScheduleRows({ headers: HEADERS, rows, season: SEASON, ...extra });
const one = (over = {}, extra = {}) => parse([row(over)], extra).rows[0];

/** Reasons a test has seen come out of the parse or the mapping (checked at the end). */
const reached = new Set();
/** @param {Record<string, string>} over @param {string} code @param {object} [extra] */
function refused(over, code, extra) {
  const r = one(over, extra);
  expect(r.status).toBe('refused');
  expect(r.reason).toBe(code);
  expect(typeof r.message).toBe('string');
  reached.add(code);
  return r;
}

describe('schedule import: the reason codes', () => {
  it('names every code once, and describes each in a sentence', () => {
    const codes = Object.values(SCHEDULE_IMPORT_REASON);
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of codes) {
      const sentence = describeScheduleImportReason(code);
      expect(sentence).toMatch(/[a-z]{4}/);
      expect(sentence).not.toBe(code);
    }
    expect(() => describeScheduleImportReason('no-such-code')).toThrow(/no-such-code/);
  });

  it('states the closed lists of plan 4.4 and 4.8, and the additions this build made', () => {
    // plan 4.4 (the first thirteen), then the additions: bad-week, bad-game-id
    expect([...SCHEDULE_IMPORT_ROW_REFUSALS].sort()).toEqual(
      [
        'bad-date',
        'bad-time',
        'end-not-after-start',
        'same-team',
        'time-in-dst-gap',
        'outside-season-window',
        'unknown-division',
        'unknown-team',
        'unknown-venue',
        'unknown-field',
        'label-is-own-team',
        'duplicate-row',
        'game-id-reused',
        'bad-week',
        'bad-game-id',
        'missing-week',
      ].sort()
    );
    expect([...SCHEDULE_IMPORT_FILE_REFUSALS].sort()).toEqual(
      [
        'missing-column',
        'duplicate-column',
        'too-many-rows',
        'no-season-clock',
        'missing-week',
      ].sort()
    );
    expect([...SCHEDULE_IMPORT_FLAGS].sort()).toEqual(
      [
        'field-overlap',
        'coach-conflict',
        'team-double-booked',
        'home-away-imbalance',
        'time-ambiguous',
        'week-differs',
      ].sort()
    );
    expect(SCHEDULE_IMPORT_REASON.IMPORTED_WITHOUT_TIME).toBe('imported-without-time');
    expect(SCHEDULE_IMPORT_LIMITS).toEqual({ MAX_ROWS: 2400, MAX_GAME_ID_LENGTH: 40 });
  });

  it('keeps the barrel complete: every public name of every module is exported by the index', () => {
    const names = new Set(Object.keys(scheduleImport));
    for (const module of [reasonModule, parseModule, mapping, audit])
      for (const name of Object.keys(module)) expect(names.has(name)).toBe(true);
    expect(names.size).toBeGreaterThanOrEqual(20); // the walk examined something
  });
});

describe('schedule import: dates', () => {
  it('reads YYYY-MM-DD and M/D/YYYY (US), and nothing else', () => {
    expect(parseScheduleDate('2026-04-13')).toBe('2026-04-13');
    expect(parseScheduleDate('4/13/2026')).toBe('2026-04-13');
    expect(parseScheduleDate('04/13/2026')).toBe('2026-04-13');
    expect(parseScheduleDate(' 4/13/2026 ')).toBe('2026-04-13');
    // the US reading, pinned: 4/5 is the fifth of April, not the fourth of May
    expect(parseScheduleDate('4/5/2026')).toBe('2026-04-05');
    expect(parseScheduleDate('12/31/2026')).toBe('2026-12-31');
    expect(parseScheduleDate('2/29/2028')).toBe('2028-02-29');
    for (const bad of [
      '',
      '   ',
      '2026-4-13',
      '2026/04/13',
      '4/13/26',
      '13-04-2026',
      '2026-04-13T09:00',
      '2026-04-13 09:00',
      'April 13, 2026',
      '46125',
      '0/13/2026',
      '4/0/2026',
    ])
      expect(parseScheduleDate(bad)).toBeNull();
    expect(parseScheduleDate(undefined)).toBeNull();
    expect(parseScheduleDate(null)).toBeNull();
    expect(parseScheduleDate(20260413)).toBeNull();
  });

  it('refuses 13/04/2026 instead of swapping day and month', () => {
    // 13 is not a month. A reader that "helpfully" swaps would call it 2026-04-13.
    expect(parseScheduleDate('13/04/2026')).toBeNull();
    expect(parseScheduleDate('31/12/2026')).toBeNull();
    // while the same digits read as US are a real date, so the two forms are not confused
    expect(parseScheduleDate('4/13/2026')).toBe('2026-04-13');
    const r = refused({ Date: '13/04/2026' }, 'bad-date');
    expect(r.date).toBeNull();
    refused({ Date: '31/12/2026' }, 'bad-date');
  });

  it('refuses a day the calendar does not have, rather than rolling it forward', () => {
    expect(parseScheduleDate('2026-02-30')).toBeNull();
    expect(parseScheduleDate('2/29/2026')).toBeNull(); // 2026 is not a leap year
    expect(parseScheduleDate('2026-13-01')).toBeNull();
    expect(parseScheduleDate('2026-04-31')).toBeNull();
    refused({ Date: '2026-02-30' }, 'bad-date');
    refused({ Date: '' }, 'bad-date');
  });
});

describe('schedule import: times', () => {
  it('reads 24-hour times', () => {
    expect(parseScheduleTime('09:30')).toBe(570);
    expect(parseScheduleTime('9:30')).toBe(570);
    expect(parseScheduleTime('00:00')).toBe(0);
    expect(parseScheduleTime('23:59')).toBe(1439);
    expect(parseScheduleTime(' 14:05 ')).toBe(845);
  });

  it('reads 12-hour times, including 12:00 AM (midnight) and 12:30 PM (half past noon)', () => {
    expect(parseScheduleTime('12:00 AM')).toBe(0);
    expect(parseScheduleTime('12:30 AM')).toBe(30);
    expect(parseScheduleTime('12:00 PM')).toBe(720);
    expect(parseScheduleTime('12:30 PM')).toBe(750);
    expect(parseScheduleTime('1:05 PM')).toBe(785);
    expect(parseScheduleTime('11:59 PM')).toBe(1439);
    expect(parseScheduleTime('9:30 AM')).toBe(570);
    expect(parseScheduleTime('9:30 am')).toBe(570);
    expect(parseScheduleTime('9:30AM')).toBe(570);
    expect(parseScheduleTime('09:30 PM')).toBe(21 * 60 + 30);
  });

  it('refuses what is not a time, and a 12-hour time that is not on a 12-hour clock', () => {
    for (const bad of [
      '',
      '  ',
      'noon',
      '25:00',
      '24:00',
      '9:60',
      '9:5',
      '930',
      '9',
      '9:30:00',
      '13:00 PM',
      '0:30 AM',
      '0:30 PM',
      '9:30 XM',
      '9.30',
      '-1:30',
    ])
      expect(parseScheduleTime(bad)).toBeNull();
    expect(parseScheduleTime(undefined)).toBeNull();
    expect(parseScheduleTime(930)).toBeNull();
  });

  it('reads a length in whole minutes', () => {
    expect(parseScheduleLength('60')).toBe(60);
    expect(parseScheduleLength(' 35 ')).toBe(35);
    for (const bad of ['', '0', '-5', '1.5', '60 min', 'sixty', '1440', '9999'])
      expect(parseScheduleLength(bad)).toBeNull();
  });

  it('puts a row with a start and an end on the season clock', () => {
    const r = one({ Date: '2026-09-12', 'Start Time': '9:00 AM', 'End Time': '10:15 AM' });
    expect(r.status).toBe('ok');
    expect(r.startTime).toBe('09:00');
    expect(r.endTime).toBe('10:15');
    expect(r.start).toBe('2026-09-12T09:00:00-07:00');
    expect(r.end).toBe('2026-09-12T10:15:00-07:00');
    const pm = one({ 'Start Time': '12:30 PM', 'End Time': '1:45 PM' });
    expect([pm.startTime, pm.endTime]).toEqual(['12:30', '13:45']);
    const night = one({ 'Start Time': '12:00 AM', 'End Time': '1:00 AM' });
    expect([night.startTime, night.endTime]).toEqual(['00:00', '01:00']);
  });

  it('refuses a malformed start or end as bad-time, never as a blank', () => {
    refused({ 'Start Time': '25:00', 'End Time': '26:00' }, 'bad-time');
    refused({ 'End Time': 'noon' }, 'bad-time');
    refused({ 'Start Time': '9.30' }, 'bad-time');
    refused({ 'Start Time': '13:00 PM', 'End Time': '14:00' }, 'bad-time');
  });

  it('refuses an end that is not after the start, and never repairs a 12-hour end', () => {
    refused({ 'Start Time': '10:00', 'End Time': '09:30' }, 'end-not-after-start');
    refused({ 'Start Time': '10:00', 'End Time': '10:00' }, 'end-not-after-start');
    // "11:00 AM to 1:00" is not 11:00 to 13:00: 1:00 is read as 01:00 and the row is refused
    refused({ 'Start Time': '11:00 AM', 'End Time': '1:00' }, 'end-not-after-start');
    expect(one({ 'Start Time': '11:00 AM', 'End Time': '1:00 PM' }).status).toBe('ok');
  });
});

describe('schedule import: Length instead of End Time', () => {
  const lengthHeaders = HEADERS.filter((h) => h !== 'End Time').concat('Length');
  const withLength = (over) => {
    const r = row(over);
    delete r['End Time'];
    return r;
  };
  const parseLen = (over) =>
    parseScheduleRows({ headers: lengthHeaders, rows: [withLength(over)], season: SEASON }).rows[0];

  it('ends the game that many minutes after it starts', () => {
    const r = parseLen({ 'Start Time': '9:00 AM', Length: '55' });
    expect(r.status).toBe('ok');
    expect(r.endTime).toBe('09:55');
    expect(r.end).toBe('2026-09-12T09:55:00-07:00');
  });

  it('refuses a length that is not whole minutes, or that runs past midnight', () => {
    expect(parseLen({ Length: '60 min' })).toMatchObject({ status: 'refused', reason: 'bad-time' });
    expect(parseLen({ Length: '0' })).toMatchObject({ status: 'refused', reason: 'bad-time' });
    expect(parseLen({ 'Start Time': '23:30', Length: '60' })).toMatchObject({
      status: 'refused',
      reason: 'bad-time',
    });
  });

  it('accepts both an End Time and a Length that agree, and refuses ones that disagree', () => {
    const both = parseScheduleRows({
      headers: [...HEADERS, 'Length'],
      rows: [row({ Length: '60' })],
      season: SEASON,
    }).rows[0];
    expect(both.status).toBe('ok');
    expect(both.endTime).toBe('10:00');
    const clash = parseScheduleRows({
      headers: [...HEADERS, 'Length'],
      rows: [row({ Length: '45' })],
      season: SEASON,
    }).rows[0];
    expect(clash).toMatchObject({ status: 'refused', reason: 'bad-time' });
  });
});

describe('schedule import: a row with no time becomes TIME TBD, never a dropped row', () => {
  it('blank start and end: imported-without-time', () => {
    const r = one({ 'Start Time': '', 'End Time': '' });
    expect(r.status).toBe('tbd');
    expect(r.tbdReason).toBe('imported-without-time');
    expect(r.reason).toBeNull();
    expect(r.start).toBeNull();
    expect(r.date).toBe('2026-09-12'); // the rest of the row is kept
    expect(r.homeLabel).toBe('U05B Team 01');
  });

  it('a start with no end, or a blank field, is TIME TBD too', () => {
    expect(one({ 'End Time': '' }).status).toBe('tbd');
    const noField = one({ Field: '' });
    expect(noField.status).toBe('tbd');
    expect(noField.tbdReason).toBe('imported-without-time');
    expect(one({ Venue: '', Field: '' }).status).toBe('tbd');
  });

  it('a blank date is not a TIME TBD row (the week and the window need it)', () => {
    refused({ Date: '', 'Start Time': '', 'End Time': '' }, 'bad-date');
  });

  it('a malformed time is bad-time, even beside a blank start', () => {
    refused({ 'Start Time': '', 'End Time': 'soon' }, 'bad-time');
  });
});

describe('schedule import: the season clock decides instants (named dates, four zones)', () => {
  it('US spring-forward Sunday: 02:30 does not exist, 03:00 is after the jump', () => {
    const gap = refused(
      { Week: '', Date: '2027-03-14', 'Start Time': '02:30', 'End Time': '03:30' },
      'time-in-dst-gap'
    );
    expect(gap.start).toBeNull();
    expect(gap.message).toMatch(/does not exist/);
    const after = one({ Week: '', Date: '2027-03-14', 'Start Time': '03:00', 'End Time': '04:00' });
    expect(after.start).toBe('2027-03-14T03:00:00-07:00');
    const before = one({
      Week: '',
      Date: '2027-03-14',
      'Start Time': '01:59',
      'End Time': '03:30',
    });
    expect(before.start).toBe('2027-03-14T01:59:00-08:00');
    // an end inside the gap is the same refusal
    refused(
      { Week: '', Date: '2027-03-14', 'Start Time': '01:00', 'End Time': '02:30' },
      'time-in-dst-gap'
    );
  });

  it('US fall-back Sunday: 01:30 happens twice; the first occurrence is taken and flagged', () => {
    const r = one({ Week: '', Date: '2026-11-01', 'Start Time': '01:30', 'End Time': '02:30' });
    expect(r.status).toBe('ok');
    expect(r.start).toBe('2026-11-01T01:30:00-07:00');
    expect(r.end).toBe('2026-11-01T02:30:00-08:00');
    expect(r.flags.map((f) => f.code)).toEqual(['time-ambiguous']);
    // one flag per row even when both ends are ambiguous
    const both = one({ Week: '', Date: '2026-11-01', 'Start Time': '01:15', 'End Time': '01:45' });
    expect(both.flags.map((f) => f.code)).toEqual(['time-ambiguous']);
    // the hour after is not ambiguous
    expect(
      one({ Week: '', Date: '2026-11-01', 'Start Time': '03:00', 'End Time': '04:00' }).flags
    ).toEqual([]);
  });

  it('a southern-hemisphere zone: Sydney falls back in April and springs forward in October', () => {
    const south = { timeZone: 'Australia/Sydney', startDate: '2026-03-02', endDate: '2026-12-31' };
    const fall = one(
      { Date: '2026-04-05', 'Start Time': '02:30', 'End Time': '03:30', Week: '' },
      { season: south }
    );
    expect(fall.start).toBe('2026-04-05T02:30:00+11:00');
    expect(fall.flags.map((f) => f.code)).toEqual(['time-ambiguous']);
    refused(
      { Date: '2026-10-04', 'Start Time': '02:30', 'End Time': '03:30', Week: '' },
      'time-in-dst-gap',
      { season: south }
    );
    // a plain Saturday between the changes
    const plain = one({ Date: '2026-07-04', Week: '' }, { season: south });
    expect(plain.start).toBe('2026-07-04T09:00:00+10:00');
  });

  it('a half-hour offset: Kolkata is +05:30 all year', () => {
    const india = { timeZone: 'Asia/Kolkata', startDate: '2026-09-07', endDate: '2027-03-31' };
    const r = one({ Week: '' }, { season: india });
    expect(r.start).toBe('2026-09-12T09:00:00+05:30');
    expect(r.end).toBe('2026-09-12T10:00:00+05:30');
  });

  it('refuses a zone this runtime does not know, for the whole file, rather than read the host zone', () => {
    const result = parse([row()], { season: { ...SEASON, timeZone: 'Mars/Olympus' } });
    expect(result.ok).toBe(false);
    expect(result.refusal.code).toBe('no-season-clock');
    expect(result.refusal.message).toContain('Mars/Olympus');
  });
});

describe('schedule import: the host time zone is not an input', () => {
  const fixture = loadScheduleFixture();
  const everything = () => ({
    games: parseScheduleRows({
      headers: fixture.schedule.headers,
      rows: fixture.schedule.rows,
      season: fixture.season,
    }),
    invalid: parseScheduleRows({
      headers: fixture.invalid.headers,
      rows: fixture.invalid.rows,
      season: fixture.season,
    }),
    named: [
      one({ Date: '2027-03-14', 'Start Time': '03:00', 'End Time': '04:00' }),
      one({ Date: '2026-11-01', 'Start Time': '01:30', 'End Time': '02:30' }),
      one({ Date: '2026-12-31', 'Start Time': '11:30 PM', 'End Time': '11:59 PM' }),
    ],
  });

  it('gives identical results under four other TZ values', () => {
    const original = process.env.TZ;
    /** @param {string} tz */
    const under = (tz) => {
      process.env.TZ = tz;
      return JSON.stringify(everything());
    };
    try {
      const baseline = under('UTC');
      const others = [
        'America/Los_Angeles',
        'Pacific/Auckland',
        'Asia/Kolkata',
        'Pacific/Kiritimati',
      ];
      for (const tz of others) expect(under(tz)).toBe(baseline);
      // the comparison examined something: instants with the season's offset are in it
      expect(baseline).toContain('2026-09-12T08:00:00-07:00');
      expect(baseline).toContain('2026-11-07T');
      expect(baseline).toContain('-08:00');
      expect(JSON.parse(baseline).games.rows).toHaveLength(574);
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });

  it('is host-zone free for the date arithmetic of the week rule too', () => {
    const original = process.env.TZ;
    try {
      for (const tz of ['UTC', 'Pacific/Auckland', 'America/Los_Angeles', 'Pacific/Kiritimati']) {
        process.env.TZ = tz;
        expect(scheduleWeekOf('2026-11-01', '2026-09-07')).toBe(8); // the fall-back Sunday
        expect(scheduleWeekOf('2027-03-14', '2026-09-07')).toBe(27); // the spring-forward Sunday
        expect(parseScheduleDate('3/14/2027')).toBe('2027-03-14');
      }
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });
});

describe('schedule import: the week rule (decision 17)', () => {
  it('counts whole weeks from the Monday of the week the season starts', () => {
    expect(scheduleWeekOf('2026-09-07', '2026-09-07')).toBe(1); // start itself, a Monday
    expect(scheduleWeekOf('2026-09-13', '2026-09-07')).toBe(1); // that Sunday
    expect(scheduleWeekOf('2026-09-14', '2026-09-07')).toBe(2); // the next Monday
    expect(scheduleWeekOf('2026-09-12', '2026-09-07')).toBe(1);
    expect(scheduleWeekOf('2026-11-07', '2026-09-07')).toBe(9);
    // a season that starts midweek: the week is the Monday-to-Sunday one it starts in
    expect(scheduleWeekOf('2026-09-09', '2026-09-09')).toBe(1);
    expect(scheduleWeekOf('2026-09-13', '2026-09-09')).toBe(1);
    expect(scheduleWeekOf('2026-09-14', '2026-09-09')).toBe(2);
    // across a year end and a leap day
    expect(scheduleWeekOf('2027-01-02', '2026-12-28')).toBe(1);
    expect(scheduleWeekOf('2027-01-04', '2026-12-28')).toBe(2);
    expect(scheduleWeekOf('2028-03-01', '2028-02-28')).toBe(1);
  });

  it('uses the Week column when it is a positive integer', () => {
    const r = one({ Week: '4', Date: '2026-09-12' });
    expect(r.weekIndex).toBe(4);
    expect(r.weekSource).toBe('file');
    expect(one({ Week: ' 03 ' }).weekIndex).toBe(3);
  });

  it('derives the week from the date when the cell is blank, with no flag', () => {
    const r = one({ Week: '', Date: '2026-10-03' });
    expect(r.weekIndex).toBe(4);
    expect(r.weekSource).toBe('derived');
    expect(r.flags).toEqual([]);
  });

  it('flags a Week that differs from the date, and stores the file’s week, never renumbering', () => {
    const r = one({ Week: '3', Date: '2026-09-12' });
    expect(r.status).toBe('ok');
    expect(r.weekIndex).toBe(3);
    const flag = r.flags.find((f) => f.code === 'week-differs');
    expect(flag).toBeDefined();
    expect(flag.details).toEqual({ weekGiven: 3, weekDerived: 1 });
    reached.add('week-differs');
    expect(one({ Week: '1', Date: '2026-09-12' }).flags).toEqual([]);
  });

  it('refuses a Week that is not a positive whole number', () => {
    for (const bad of ['0', '-1', '2.5', 'three', '1e1', '3rd', '0x3'])
      refused({ Week: bad }, 'bad-week');
  });

  it('refuses a date before the season window, and one after its end', () => {
    refused({ Date: '2026-08-29', Week: '' }, 'outside-season-window');
    refused({ Date: '2027-04-03', Week: '' }, 'outside-season-window');
    refused({ Date: '2026-09-06', Week: '3' }, 'outside-season-window'); // even with a Week given
    // the boundaries are inside
    expect(one({ Date: '2026-09-07', Week: '' }).status).toBe('ok');
    expect(one({ Date: '2027-03-31', Week: '' }).status).toBe('ok');
    // a season with no end date has no upper bound
    const open = one(
      { Date: '2030-01-05', Week: '' },
      { season: { timeZone: SEASON.timeZone, startDate: SEASON.startDate } }
    );
    expect(open.status).toBe('ok');
  });

  it('with no season start, the Week column is required: a blank cell is missing-week', () => {
    const noStart = { timeZone: SEASON.timeZone };
    const r = refused({ Week: '' }, 'missing-week', { season: noStart });
    expect(r.message).toMatch(/season/i);
    // given, it is used, and nothing can be compared to a start that is not there
    const given = one({ Week: '5' }, { season: noStart });
    expect(given.status).toBe('ok');
    expect(given.weekIndex).toBe(5);
    expect(given.flags).toEqual([]);
  });
});

describe('schedule import: the file', () => {
  it('matches columns by name regardless of case, spacing and a leading byte-order mark', () => {
    const headers = [
      '﻿game id',
      ' DATE',
      'start  time',
      'End Time',
      'venue',
      'FIELD',
      'division',
      'home team',
      'away team',
      'week',
    ];
    const r = row();
    const mapped = {};
    HEADERS.forEach((h, i) => {
      mapped[headers[i]] = r[h];
    });
    const result = parseScheduleRows({ headers, rows: [mapped], season: SEASON });
    expect(result.ok).toBe(true);
    expect(result.rows[0].status).toBe('ok');
    expect(result.rows[0].gameId).toBe('G-1');
    expect(result.droppedColumns).toEqual([]);
  });

  it('refuses a file missing a required column, naming it, and stages nothing', () => {
    for (const column of [
      'Date',
      'Start Time',
      'Venue',
      'Field',
      'Division',
      'Home Team',
      'Away Team',
    ]) {
      const headers = HEADERS.filter((h) => h !== column);
      const result = parseScheduleRows({ headers, rows: [row()], season: SEASON });
      expect(result.ok).toBe(false);
      expect(result.refusal).toMatchObject({ code: 'missing-column', column });
      expect(result.refusal.message).toContain(column);
      expect(result.rows).toEqual([]);
    }
    reached.add('missing-column');
    const noEnd = parseScheduleRows({
      headers: HEADERS.filter((h) => h !== 'End Time'),
      rows: [row()],
      season: SEASON,
    });
    expect(noEnd.refusal).toMatchObject({ code: 'missing-column', column: 'End Time or Length' });
  });

  it('does not require Game ID, and does not require Week when the season has a start', () => {
    const headers = HEADERS.filter((h) => h !== 'Game ID' && h !== 'Week');
    const r = row();
    delete r['Game ID'];
    delete r.Week;
    const result = parseScheduleRows({ headers, rows: [r], season: SEASON });
    expect(result.ok).toBe(true);
    expect(result.rows[0]).toMatchObject({ status: 'ok', gameId: null, weekIndex: 1 });
    expect(result.rows[0].weekSource).toBe('derived');
  });

  it('refuses a file with no Week column and a season with no start (missing-week)', () => {
    const headers = HEADERS.filter((h) => h !== 'Week');
    const result = parseScheduleRows({
      headers,
      rows: [row()],
      season: { timeZone: SEASON.timeZone },
    });
    expect(result.ok).toBe(false);
    expect(result.refusal.code).toBe('missing-week');
    reached.add('missing-week');
  });

  it('refuses a column given twice rather than choosing one', () => {
    const result = parseScheduleRows({
      headers: [...HEADERS, 'date'],
      rows: [row()],
      season: SEASON,
    });
    expect(result.ok).toBe(false);
    expect(result.refusal).toMatchObject({ code: 'duplicate-column', column: 'Date' });
    reached.add('duplicate-column');
  });

  it('refuses more than 2,400 rows (the workbook’s own limit) and accepts exactly 2,400', () => {
    const many = (n) => Array.from({ length: n }, (_, i) => row({ 'Game ID': `G-${i}` }));
    const over = parse(many(2401));
    expect(over.ok).toBe(false);
    expect(over.refusal.code).toBe('too-many-rows');
    expect(over.refusal.message).toMatch(/2,?400/);
    expect(over.rows).toEqual([]);
    reached.add('too-many-rows');
    const exact = parse(many(2400));
    expect(exact.ok).toBe(true);
    expect(exact.rows).toHaveLength(2400);
  });

  it('refuses when the season has no clock, with the explanation the Games page gives', () => {
    for (const season of [
      null,
      undefined,
      {},
      { timeZone: '' },
      { timeZone: '  ', startDate: '2026-09-07' },
    ]) {
      const result = parseScheduleRows({ headers: HEADERS, rows: [row()], season });
      expect(result.ok).toBe(false);
      expect(result.refusal.code).toBe('no-season-clock');
      expect(result.refusal.message).toMatch(/time ?zone/i);
    }
    reached.add('no-season-clock');
  });

  it('numbers rows from 1 and keeps each row’s labels as typed, trimmed', () => {
    const result = parse([row(), row({ 'Home Team': '  U05B  Team 03 ' })]);
    expect(result.rows.map((r) => r.rowNumber)).toEqual([1, 2]);
    expect(result.rows.map((r) => r.rowKey)).toEqual(['row-1', 'row-2']);
    expect(result.rows[1].homeLabel).toBe('U05B  Team 03'); // trimmed; inner spacing is the typist's
  });

  it('counts what it did', () => {
    const result = parse([
      row(),
      row({ 'Game ID': 'G-2', 'Start Time': '', 'End Time': '' }),
      row({ 'Game ID': 'G-3', Date: 'soon' }),
      row({ 'Game ID': 'G-4', Week: '3', 'Start Time': '11:00', 'End Time': '12:00' }),
    ]);
    expect(result.counts).toEqual({ rows: 4, ok: 2, tbd: 1, refused: 1, flagged: 1 });
    expect(result.byReason).toEqual({ 'bad-date': 1 });
  });
});

describe('schedule import: only the allowlisted columns are read', () => {
  it('drops every other column before it is read, and says which were dropped', () => {
    const headers = [...HEADERS, 'Format', 'Notes', 'Coach Email', 'Phone', 'Guardian'];
    const r = row({
      Format: '5v5',
      Notes: 'SECRET-NOTE-123',
      'Coach Email': 'someone@example.com',
      Phone: '555-0100',
      Guardian: 'SECRET-PARENT',
    });
    const result = parseScheduleRows({ headers, rows: [r], season: SEASON });
    expect(result.droppedColumns).toEqual(['Format', 'Notes', 'Coach Email', 'Phone', 'Guardian']);
    const text = JSON.stringify(result);
    for (const marker of [
      'SECRET-NOTE-123',
      'someone@example.com',
      '555-0100',
      'SECRET-PARENT',
      '5v5',
    ])
      expect(text).not.toContain(marker);
    expect(Object.keys(result.rows[0]).sort()).toEqual(
      [
        'awayLabel',
        'date',
        'divisionLabel',
        'end',
        'endTime',
        'fieldLabel',
        'flags',
        'gameId',
        'homeLabel',
        'message',
        'reason',
        'rowKey',
        'rowNumber',
        'start',
        'startTime',
        'status',
        'tbdReason',
        'venueLabel',
        'weekIndex',
        'weekSource',
      ].sort()
    );
  });
});

describe('schedule import: same team, Game ID, repeats', () => {
  it('refuses a game whose two labels are the same team, however typed', () => {
    refused({ 'Away Team': 'U05B Team 01' }, 'same-team');
    refused({ 'Away Team': '  u05b   TEAM 01 ' }, 'same-team');
    // a different word is a different team
    expect(one({ 'Away Team': 'U05B Team 01 Back' }).status).toBe('ok');
  });

  it('refuses a Game ID longer than 40 characters, and accepts exactly 40 or none', () => {
    refused({ 'Game ID': 'G'.repeat(41) }, 'bad-game-id');
    expect(one({ 'Game ID': 'G'.repeat(40) }).status).toBe('ok');
    const blank = one({ 'Game ID': '' });
    expect(blank.status).toBe('ok');
    expect(blank.gameId).toBeNull();
  });

  it('lists the repeat of a game as duplicate-row; the first wins', () => {
    const result = parse([row(), row()]);
    expect(result.rows.map((r) => [r.status, r.reason])).toEqual([
      ['ok', null],
      ['refused', 'duplicate-row'],
    ]);
    reached.add('duplicate-row');
    // with no Game ID at all, the same game twice is still a repeat
    const noIds = parse([row({ 'Game ID': '' }), row({ 'Game ID': '' })]);
    expect(noIds.rows[1].reason).toBe('duplicate-row');
    // or under two different ids: it is one game
    const twoIds = parse([row({ 'Game ID': 'A' }), row({ 'Game ID': 'B' })]);
    expect(twoIds.rows[1].reason).toBe('duplicate-row');
    // labels typed differently are the same game
    const typed = parse([row(), row({ 'Home Team': ' u05b team 01', 'Game ID': 'C' })]);
    expect(typed.rows[1].reason).toBe('duplicate-row');
  });

  it('lists one Game ID on two different games as game-id-reused', () => {
    const result = parse([row(), row({ 'Start Time': '10:15', 'End Time': '11:15' })]);
    expect(result.rows.map((r) => r.reason)).toEqual([null, 'game-id-reused']);
    reached.add('game-id-reused');
    // a different date is a different game under the same id
    expect(parse([row(), row({ Date: '2026-09-19', Week: '2' })]).rows[1].reason).toBe(
      'game-id-reused'
    );
  });

  it('judges a repeat only against rows that were accepted: a refused first row blocks nothing', () => {
    const result = parse([
      row({ Date: 'soon' }), // refused, id G-1
      row(), // same id, a good game: not a reuse of anything
    ]);
    expect(result.rows.map((r) => r.status)).toEqual(['refused', 'ok']);
    // and a refused repeat does not itself become the first
    const three = parse([row(), row({ 'Start Time': '25:00' }), row()]);
    expect(three.rows.map((r) => r.reason)).toEqual([null, 'bad-time', 'duplicate-row']);
  });

  it('does not treat two games at different times on one field as repeats', () => {
    const result = parse([
      row({ 'Game ID': 'A' }),
      row({ 'Game ID': 'B', 'Start Time': '10:15', 'End Time': '11:15' }),
    ]);
    expect(result.rows.map((r) => r.status)).toEqual(['ok', 'ok']);
  });
});

describe('schedule import: the fixture, whole', () => {
  const fixture = loadScheduleFixture();
  const result = parseScheduleRows({
    headers: fixture.schedule.headers,
    rows: fixture.schedule.rows,
    season: fixture.season,
  });

  it('reads all 574 games: 573 placed, 1 TIME TBD, none refused, none flagged', () => {
    expect(result.ok).toBe(true);
    expect(result.counts).toEqual({ rows: 574, ok: 573, tbd: 1, refused: 0, flagged: 0 });
    expect(result.droppedColumns).toEqual(['Format']);
    for (const r of result.rows) {
      expect(r.weekSource).toBe('file');
      expect(r.weekIndex).toBe(Number(fixture.schedule.rows[r.rowNumber - 1].Week));
    }
  });

  it('puts the first game and a November game on the season clock', () => {
    const first = result.rows[0];
    expect(first.start).toBe('2026-09-12T08:00:00-07:00');
    const last = result.rows.filter((r) => r.date === '2026-11-07' && r.start).at(-1);
    expect(last.start).toMatch(/-08:00$/);
    const tbd = result.rows.filter((r) => r.status === 'tbd');
    expect(tbd).toHaveLength(1);
    expect(tbd[0].tbdReason).toBe('imported-without-time');
  });
});

describe('schedule import: schedule-invalid.csv, parse and mapping together', () => {
  const fixture = loadScheduleFixture();
  const parsed = parseScheduleRows({
    headers: fixture.invalid.headers,
    rows: fixture.invalid.rows,
    season: fixture.season,
  });
  // Mapping reasons depend on the admin's decisions. The file cannot carry them, so the only one
  // this test sets is the one the row's own expectation names: this label is an outside club.
  const decisions = { teams: {} };
  fixture.invalid.rows.forEach((r) => {
    if (r.Notes === 'expect: label-is-own-team') {
      decisions.teams[teamDecisionKey(r.Division, r['Away Team'])] = { action: 'outside' };
    }
  });
  const resolved = resolveScheduleRows({ rows: parsed.rows, league: fixture.league, decisions });

  const verdict = (r) => {
    if (r.status === 'refused') return r.reason;
    if (r.status === 'tbd') return 'tbd';
    const flag = r.flags.find((f) => ['time-ambiguous', 'week-differs'].includes(f.code));
    return flag ? flag.code : 'ok';
  };

  it('is read without a file refusal, and every row has a verdict', () => {
    expect(parsed.ok).toBe(true);
    expect(parsed.rows).toHaveLength(fixture.invalid.rows.length);
    expect(resolved.rows).toHaveLength(fixture.invalid.rows.length);
    expect(parsed.droppedColumns).toEqual(['Notes']);
  });

  it('gives every row the verdict its Notes expect (the generator’s word, not the parser’s)', () => {
    fixture.invalid.rows.forEach((source, i) => {
      const expected = source.Notes.replace(/^expect: /, '');
      expect([source['Game ID'], verdict(resolved.rows[i])]).toEqual([source['Game ID'], expected]);
    });
  });

  it('reaches every row-level reason it can, and the ones it cannot are reached above', () => {
    const fromFile = new Set(resolved.rows.map((r) => r.reason).filter(Boolean));
    for (const code of fromFile) reached.add(code);
    // the file reaches the thirteen of plan 4.4 and bad-week
    expect([...fromFile].sort()).toEqual(
      [
        'bad-date',
        'bad-time',
        'end-not-after-start',
        'same-team',
        'time-in-dst-gap',
        'outside-season-window',
        'unknown-division',
        'unknown-team',
        'unknown-venue',
        'unknown-field',
        'label-is-own-team',
        'duplicate-row',
        'game-id-reused',
        'bad-week',
      ].sort()
    );
  });

  it('keeps the unexpected out: no row the Notes call ok has a reason, a flag or a gap in its ids', () => {
    fixture.invalid.rows.forEach((source, i) => {
      if (source.Notes !== 'expect: ok') return;
      const r = resolved.rows[i];
      expect(r.reason).toBeNull();
      expect(r.flags).toEqual([]);
      expect(r.ids.home).toBeTruthy();
      expect(r.ids.field).toBeTruthy();
    });
  });
});

describe('schedule import: every reason of the closed list was reached', () => {
  it('has seen each row-level refusal come out of an input, here or in the fixture', () => {
    // This test runs last in the file. It can fail: remove the test for any one reason and the
    // set below lacks it (the control is the same set, built from the list, minus one).
    const missing = SCHEDULE_IMPORT_ROW_REFUSALS.filter((code) => !reached.has(code));
    expect(missing).toEqual([]);
    const withOneRemoved = new Set(reached);
    withOneRemoved.delete('bad-date');
    expect(SCHEDULE_IMPORT_ROW_REFUSALS.filter((code) => !withOneRemoved.has(code))).toEqual([
      'bad-date',
    ]);
    const missingFile = SCHEDULE_IMPORT_FILE_REFUSALS.filter((code) => !reached.has(code));
    expect(missingFile).toEqual([]);
  });
});
