// @vitest-environment node
/**
 * The practice import's parse (`packages/core/src/practiceImport/parseRows.js`, plan
 * `docs/changes/2026-11-03-schedule-expansion.md` sections 4.11.2 to 4.11.6; PR 9 task J2).
 *
 * What this holds:
 *
 *   - **Days, times, lengths and dates are read by rule, never guessed**: `Mon` to `Sun` or the full
 *     name in any case; `HH:mm` and `h:mm AM/PM` (including the two that trip a naive reader, `12:00 AM`
 *     and `12:30 PM`); `End` or `Length` (a Length is wall-clock minutes from the start: a practice row
 *     has no instant and nothing converts one); `YYYY-MM-DD` and `M/D/YYYY` read as US (`13/04/2026` is
 *     `bad-date`, never the 13th of April).
 *   - **A blank Team is an open slot** (supply, no team); `Use = hold` is a cell held for a non-team
 *     activity and makes no slot; anything else in `Use` is `bad-use`, never free text.
 *   - **Every refusal reason of plan 4.11.4 is reached** by an input in this file or in
 *     `fixtures/practice-schedule-2026/practice-invalid.csv`, whose rows each carry the verdict the
 *     generator expects (`Notes`). A final test requires the set reached to cover the list, so adding a
 *     reason with no test fails.
 *   - **The host zone is not an input**: the whole fixture is parsed under other `TZ` values and
 *     compared. (There is nothing to convert; the test is what keeps it that way.)
 *   - **The allowlist**: a column that is not in plan 4.11.2 is dropped before anything is read from it;
 *     its values appear nowhere in the result.
 *   - **Trailing whitespace folds to one team; a label that differs by a word stays two.**
 *
 * Statically out of reach, and so not claimed: that the Edge function's mirror (PR 11) reads the same
 * way (it does not exist yet), that the database judges the same rows the same way (PR 10), and that a
 * spreadsheet's own CSV export always yields these forms (a date cell exported as `4/13/26` is
 * `bad-date` here, by design).
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as practiceImport from '../packages/core/src/practiceImport/index.js';
import {
  PRACTICE_IMPORT_ALIAS_REFUSALS,
  PRACTICE_IMPORT_DATABASE_FLAGS,
  PRACTICE_IMPORT_FILE_FLAGS,
  PRACTICE_IMPORT_FILE_REFUSALS,
  PRACTICE_IMPORT_FLAGS,
  PRACTICE_IMPORT_LIMITS,
  PRACTICE_IMPORT_REASON,
  PRACTICE_IMPORT_ROW_REFUSALS,
  describePracticeImportReason,
} from '../packages/core/src/practiceImport/reasonCodes.js';
import {
  parsePracticeDay,
  parsePracticeRows,
} from '../packages/core/src/practiceImport/parseRows.js';
import { resolvePracticeRows } from '../packages/core/src/practiceImport/mapping.js';
import { SCHEDULE_IMPORT_LIMITS } from '../packages/core/src/scheduleImport/reasonCodes.js';
import { loadPracticeFixture } from './helpers/practiceFixtureLoad.js';

const SEASON = { startDate: '2026-09-07', endDate: '2026-11-20' };
const HEADERS = [
  'Team',
  'Division',
  'Day',
  'Start',
  'End',
  'Location',
  'Field',
  'Subunit',
  'Valid From',
  'Valid Until',
  'Capacity',
  'Use',
];
const row = (over = {}) => ({
  Team: 'U10B-01',
  Division: 'U10 Boys',
  Day: 'Mon',
  Start: '16:00',
  End: '17:00',
  Location: 'Venue A',
  Field: 'Field 1',
  Subunit: 'A',
  'Valid From': '',
  'Valid Until': '',
  Capacity: '',
  Use: '',
  ...over,
});
const parse = (rows, extra = {}) =>
  parsePracticeRows({ headers: HEADERS, rows, season: SEASON, ...extra });
const one = (over = {}, extra = {}) => parse([row(over)], extra).rows[0];

/** Every code an input of this file (or the fixture) has produced. The last test reads it back. */
const reached = new Set();
const note = (result) => {
  if (result.refusal) reached.add(result.refusal.code);
  for (const r of result.rows ?? []) {
    if (r.reason) reached.add(r.reason);
    for (const f of r.flags ?? []) reached.add(f.code);
  }
  return result;
};

describe('practice import: the reason codes', () => {
  const all = /** @type {string[]} */ (Object.values(PRACTICE_IMPORT_REASON));

  it('are a frozen identity table, and every code has a sentence', () => {
    expect(Object.isFrozen(PRACTICE_IMPORT_REASON)).toBe(true);
    for (const [name, code] of Object.entries(PRACTICE_IMPORT_REASON)) {
      expect(code).toBe(name.toLowerCase().replaceAll('_', '-'));
      expect(describePracticeImportReason(code).length).toBeGreaterThan(10);
    }
    expect(() => describePracticeImportReason('nope')).toThrow(/not a practice import reason/);
    expect(() => describePracticeImportReason(undefined)).toThrow(/not a practice import reason/);
  });

  it('are partitioned: file, row, alias-row, and flags (read here, and read by the database)', () => {
    expect([...PRACTICE_IMPORT_FILE_REFUSALS].sort()).toEqual([
      'duplicate-column',
      'missing-column',
      'too-many-rows',
    ]);
    // plan 4.11.4's closed row list, and the five this build added (named in the header)
    expect([...PRACTICE_IMPORT_ROW_REFUSALS].sort()).toEqual(
      [
        'bad-use',
        'bad-day',
        'bad-time',
        'bad-length',
        'end-not-after-start',
        'bad-capacity',
        'capacity-not-positive',
        'bad-date',
        'valid-until-before-from',
        'outside-season-window',
        'missing-dates',
        'unknown-division',
        'unknown-team',
        'unknown-location',
        'unknown-field',
        'unknown-subunit',
        'team-in-two-divisions',
        'slot-overlaps-another',
        'duplicate-row',
      ].sort()
    );
    expect([...PRACTICE_IMPORT_ALIAS_REFUSALS].sort()).toEqual(
      [
        'blank-alias',
        'alias-conflict',
        'unknown-location',
        'unknown-field',
        'unknown-subunit',
        'duplicate-row',
      ].sort()
    );
    expect([...PRACTICE_IMPORT_FILE_FLAGS].sort()).toEqual([
      'division-not-reserved',
      'hold-over-open-slot',
      'team-on-both-halves',
    ]);
    // Declared, not enforced (AGENTS.md section 3): these six are judged by the database (PR 10),
    // which reads the rows the file names. This module does not compute them, and says so.
    expect([...PRACTICE_IMPORT_DATABASE_FLAGS].sort()).toEqual([
      'capacity',
      'coach-conflict',
      'count',
      'length',
      'reservation',
      'weekday',
    ]);
    expect([...PRACTICE_IMPORT_FLAGS].sort()).toEqual(
      [...PRACTICE_IMPORT_FILE_FLAGS, ...PRACTICE_IMPORT_DATABASE_FLAGS].sort()
    );
    // no code is unaccounted for, and none is on a list it does not belong on
    const listed = new Set([
      ...PRACTICE_IMPORT_FILE_REFUSALS,
      ...PRACTICE_IMPORT_ROW_REFUSALS,
      ...PRACTICE_IMPORT_ALIAS_REFUSALS,
      ...PRACTICE_IMPORT_FLAGS,
    ]);
    expect(all.filter((code) => !listed.has(code))).toEqual([]);
    expect([...listed].filter((code) => !all.includes(code))).toEqual([]);
    expect(PRACTICE_IMPORT_FLAGS.filter((c) => PRACTICE_IMPORT_ROW_REFUSALS.includes(c))).toEqual(
      []
    );
  });

  it('shares its row cap with the schedule import: one number, not two', () => {
    expect(PRACTICE_IMPORT_LIMITS.MAX_ROWS).toBe(2400);
    expect(PRACTICE_IMPORT_LIMITS.MAX_ROWS).toBe(SCHEDULE_IMPORT_LIMITS.MAX_ROWS);
    expect(PRACTICE_IMPORT_LIMITS.MAX_CAPACITY).toBe(32767); // practice_slots.capacity is a smallint
  });

  it('is every export of the barrel, once', () => {
    for (const name of [
      'parsePracticeRows',
      'parsePracticeDay',
      'practiceSlotKey',
      'practiceLabelKey',
      'proposePracticeMapping',
      'resolvePracticeRows',
      'proposeDivisionSettings',
      'readPracticeAliases',
      'pairProbableMoves',
      'selectedArrivals',
      'describePracticeImportReason',
      'PRACTICE_IMPORT_REASON',
    ]) {
      expect([name, typeof practiceImport[name]]).not.toEqual([name, 'undefined']);
    }
  });
});

describe('practice import: days', () => {
  it.each([
    ['Mon', 'mon'],
    ['monday', 'mon'],
    ['TUES', 'tue'],
    ['Tuesday', 'tue'],
    ['Wed', 'wed'],
    ['weds', 'wed'],
    ['Thu', 'thu'],
    ['thurs', 'thu'],
    ['Thursday', 'thu'],
    ['fri', 'fri'],
    ['Sat', 'sat'],
    ['sunday', 'sun'],
    [' Fri ', 'fri'],
  ])('reads %s as %s', (text, code) => {
    expect(parsePracticeDay(text)).toBe(code);
    expect(one({ Day: text }).day).toBe(code);
  });

  it.each(['Funday', '', 'M', 'Mo', '1', 'Monday Tuesday', 'mon-wed'])('refuses %j', (text) => {
    expect(parsePracticeDay(text)).toBeNull();
    const r = note(parse([row({ Day: text })])).rows[0];
    expect([r.status, r.reason]).toEqual(['refused', 'bad-day']);
  });

  it('accepts the SQL day parser’s vocabulary, so one vocabulary serves both files', () => {
    const sql = readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        '..',
        'supabase/migrations/20260503070000_field_import_apply_rollback.sql'
      ),
      'utf8'
    );
    const start = sql.indexOf('FUNCTION public.import_text_to_day_of_week');
    const body = sql.slice(start, sql.indexOf('$$;', start));
    const words = [...body.matchAll(/IN \(([^)]*)\)/g)].flatMap((m) =>
      [...m[1].matchAll(/'([a-z]+)'/g)].map((w) => w[1])
    );
    expect(words).toHaveLength(18); // the scan found the SQL's words: control for the loop below
    for (const w of words)
      expect([w, parsePracticeDay(w)]).toEqual([w, expect.stringMatching(/^[a-z]{3}$/)]);
  });
});

describe('practice import: times', () => {
  const times = (start, end, extra = {}) => one({ Start: start, End: end, ...extra });

  it.each([
    ['16:00', '17:00', '16:00', '17:00'],
    ['4:00 PM', '5:30 pm', '16:00', '17:30'],
    ['12:00 AM', '1:00 AM', '00:00', '01:00'],
    ['12:30 PM', '1:30 PM', '12:30', '13:30'],
    ['12:00 PM', '1:00 PM', '12:00', '13:00'],
    ['9:05 am', '10:05 AM', '09:05', '10:05'],
    ['7:00', '08:15', '07:00', '08:15'],
  ])('reads %s to %s as %s to %s', (start, end, startTime, endTime) => {
    const r = note({ rows: [times(start, end)] }).rows[0];
    expect([r.status, r.startTime, r.endTime]).toEqual(['placement', startTime, endTime]);
  });

  it.each([['25:00'], ['24:00'], ['13:00 PM'], ['0:30 AM'], ['7:60'], ['noon'], ['4 PM'], ['']])(
    'refuses the start %j as bad-time',
    (start) => {
      const r = note({ rows: [times(start, '23:00')] }).rows[0];
      expect([r.status, r.reason]).toEqual(['refused', 'bad-time']);
    }
  );

  it('refuses a malformed end as bad-time, and an end at or before the start as end-not-after-start', () => {
    expect(note({ rows: [times('16:00', 'later')] }).rows[0].reason).toBe('bad-time');
    expect(note({ rows: [times('17:00', '16:00')] }).rows[0].reason).toBe('end-not-after-start');
    expect(times('17:00', '17:00').reason).toBe('end-not-after-start');
    // an end of 1:00 after a start of 11:00 AM is not repaired to 1 PM
    expect(times('11:00 AM', '1:00').reason).toBe('end-not-after-start');
    // an end at midnight is not an end this import stores, and says so
    const midnight = times('23:00', '12:00 AM');
    expect(midnight.reason).toBe('end-not-after-start');
    expect(midnight.message).toMatch(/23:59/);
  });

  it('needs an End or a Length on the row', () => {
    const r = note({ rows: [one({ End: '' })] }).rows[0];
    expect([r.reason, r.message]).toEqual([
      'bad-time',
      expect.stringMatching(/no End and no Length/),
    ]);
  });
});

describe('practice import: Length instead of End', () => {
  const headers = HEADERS.filter((h) => h !== 'End').concat('Length');
  const withLength = (over) =>
    parsePracticeRows({
      headers,
      rows: [{ ...row(), End: undefined, Length: '', ...over }],
      season: SEASON,
    }).rows[0];

  it('adds the minutes to the start, on the wall clock', () => {
    expect(withLength({ Length: '45' }).endTime).toBe('16:45');
    expect(withLength({ Start: '4:00 PM', Length: '60' }).endTime).toBe('17:00');
    expect(withLength({ Start: '22:30', Length: '75' }).endTime).toBe('23:45');
  });

  it('has no clock to change under it: 01:30 + 60 is 02:30 on the day clocks go back', () => {
    // A practice row holds a weekday and wall times; the import converts no instant (plan 4.11.6),
    // so unlike a game's Length there is no elapsed-time reading to get wrong.
    const r = withLength({ Start: '01:30', Length: '60', 'Valid From': '2026-11-01' });
    note({ rows: [r] });
    expect([r.status, r.startTime, r.endTime]).toEqual(['placement', '01:30', '02:30']);
  });

  it('refuses a length that is not whole minutes from 1 to 1439, and one that reaches midnight', () => {
    for (const bad of ['0', '1440', '-5', '45.5', 'abc', '1 hour', '99999']) {
      const r = note({ rows: [withLength({ Length: bad })] }).rows[0];
      expect([bad, r.reason]).toEqual([bad, 'bad-length']);
    }
    const midnight = withLength({ Start: '22:30', Length: '90' });
    expect(midnight.reason).toBe('end-not-after-start');
    expect(midnight.message).toMatch(/23:59/);
  });

  it('with both an End and a Length they must agree', () => {
    const both = HEADERS.concat('Length');
    const read = (over) =>
      parsePracticeRows({ headers: both, rows: [row(over)], season: SEASON }).rows[0];
    expect(read({ End: '17:00', Length: '60' }).status).toBe('placement');
    const clash = note({ rows: [read({ End: '17:00', Length: '45' })] }).rows[0];
    expect([clash.reason, clash.message]).toEqual([
      'bad-length',
      expect.stringMatching(/60.*45|45.*60/),
    ]);
  });

  it('wants one of the two columns', () => {
    const result = note(
      parsePracticeRows({
        headers: HEADERS.filter((h) => h !== 'End'),
        rows: [row()],
        season: SEASON,
      })
    );
    expect(result.ok).toBe(false);
    expect(result.refusal).toMatchObject({ code: 'missing-column' });
    expect(result.refusal.message).toMatch(/End.*Length|Length.*End/);
  });
});

describe('practice import: capacity', () => {
  it.each([
    ['', 1],
    ['1', 1],
    ['3', 3],
    [' 2 ', 2],
    ['32767', 32767],
  ])('reads %j as %i', (text, n) => {
    expect(one({ Capacity: text }).capacity).toBe(n);
  });

  it.each(['0', '-2', '-0'])('refuses %j as capacity-not-positive', (text) => {
    expect(note(parse([row({ Capacity: text })])).rows[0].reason).toBe('capacity-not-positive');
  });

  it.each(['1.5', 'two', '32768', '1e3', '2 teams', '٣'])('refuses %j as bad-capacity', (text) => {
    expect(note(parse([row({ Capacity: text })])).rows[0].reason).toBe('bad-capacity');
  });
});

describe('practice import: a blank Team is an open slot, Use = hold is a held cell', () => {
  it('reads the status from the Team and Use cells', () => {
    expect(one().status).toBe('placement');
    expect(one({ Team: '' }).status).toBe('open');
    expect(one({ Team: '   ' }).status).toBe('open');
    for (const use of ['hold', 'HOLD', ' Hold ']) {
      const r = one({ Team: '', Division: '', Use: use });
      expect([use, r.status]).toEqual([use, 'hold']);
    }
  });

  it('refuses any other Use, and a hold that names a team, as bad-use', () => {
    for (const over of [{ Use: 'clinic' }, { Use: 'x', Team: '' }, { Use: 'hold' }]) {
      const r = note(parse([row(over)])).rows[0];
      expect([JSON.stringify(over), r.status, r.reason]).toEqual([
        JSON.stringify(over),
        'refused',
        'bad-use',
      ]);
    }
  });

  it('keeps a hold’s cell like any other row’s, so a hold can be compared with a slot', () => {
    const r = one({
      Team: '',
      Division: '',
      Use: 'hold',
      Day: 'Fri',
      Start: '5:00 PM',
      End: '6:00 PM',
    });
    expect([r.day, r.startTime, r.endTime, r.fieldLabel, r.subunitLabel]).toEqual([
      'fri',
      '17:00',
      '18:00',
      'Field 1',
      'A',
    ]);
    // …and a hold with a bad time is refused like any row
    expect(one({ Team: '', Division: '', Use: 'hold', Start: 'noon' }).reason).toBe('bad-time');
  });

  it('flags a Division on a row that has no team: this import never writes a reservation', () => {
    const open = note(parse([row({ Team: '' })])).rows[0];
    expect(open.status).toBe('open');
    expect(open.flags.map((f) => f.code)).toEqual(['division-not-reserved']);
    expect(open.flags[0].message).toMatch(/reserv/i);
    const hold = note(parse([row({ Team: '', Use: 'hold' })])).rows[0];
    expect(hold.flags.map((f) => f.code)).toEqual(['division-not-reserved']);
    // a team’s own division is not flagged, and a blank one is nothing to flag
    expect(one().flags).toEqual([]);
    expect(one({ Team: '', Division: '' }).flags).toEqual([]);
  });

  it('wants a Division column whenever the file has a Team column', () => {
    const headers = HEADERS.filter((h) => h !== 'Division');
    const refused = note(parsePracticeRows({ headers, rows: [row()], season: SEASON }));
    expect(refused.refusal).toMatchObject({ code: 'missing-column', column: 'Division' });
    // with no Team column the file is all supply: every row is an open slot
    const supply = parsePracticeRows({
      headers: headers.filter((h) => h !== 'Team'),
      rows: [row()],
      season: SEASON,
    });
    expect(supply.ok).toBe(true);
    expect(supply.rows[0].status).toBe('open');
  });
});

describe('practice import: dates (plan 4.11.6)', () => {
  it('takes a row’s own dates, else the confirm step’s, else the season’s, one end at a time', () => {
    const own = one({ 'Valid From': '2026-09-14', 'Valid Until': '2026-10-30' });
    expect([own.validFrom, own.validUntil]).toEqual(['2026-09-14', '2026-10-30']);
    expect(own.dateSources).toEqual({ from: 'row', until: 'row' });

    const season = one();
    expect([season.validFrom, season.validUntil]).toEqual(['2026-09-07', '2026-11-20']);
    expect(season.dateSources).toEqual({ from: 'season', until: 'season' });

    const confirm = one({}, { dates: { validFrom: '2026-09-21', validUntil: '2026-11-13' } });
    expect([confirm.validFrom, confirm.validUntil]).toEqual(['2026-09-21', '2026-11-13']);
    expect(confirm.dateSources).toEqual({ from: 'confirm', until: 'confirm' });

    const mixed = one({ 'Valid Until': '11/6/2026' }, { dates: { validFrom: '2026-09-21' } });
    expect([mixed.validFrom, mixed.validUntil]).toEqual(['2026-09-21', '2026-11-06']);
    expect(mixed.dateSources).toEqual({ from: 'confirm', until: 'row' });
  });

  it('reads both date forms, and swaps nothing', () => {
    expect(one({ 'Valid From': '9/14/2026' }).validFrom).toBe('2026-09-14');
    expect(one({ 'Valid From': '09/14/2026' }).validFrom).toBe('2026-09-14');
    for (const bad of [
      '13/04/2026',
      '2026-02-30',
      '2026-13-01',
      '14.09.2026',
      'next week',
      '9/14/26',
    ]) {
      const r = note(parse([row({ 'Valid From': bad })])).rows[0];
      expect([bad, r.status, r.reason]).toEqual([bad, 'refused', 'bad-date']);
    }
    expect(note(parse([row({ 'Valid Until': '2026-02-30' })])).rows[0].reason).toBe('bad-date');
  });

  it('refuses an end before the start, and dates outside the season', () => {
    const backwards = note(
      parse([row({ 'Valid From': '2026-10-20', 'Valid Until': '2026-10-19' })])
    ).rows[0];
    expect(backwards.reason).toBe('valid-until-before-from');
    expect(one({ 'Valid From': '2026-10-20', 'Valid Until': '2026-10-20' }).status).toBe(
      'placement'
    );
    expect(note(parse([row({ 'Valid From': '2026-09-06' })])).rows[0].reason).toBe(
      'outside-season-window'
    );
    expect(note(parse([row({ 'Valid Until': '2026-11-21' })])).rows[0].reason).toBe(
      'outside-season-window'
    );
    expect(one({ 'Valid From': '2026-09-07', 'Valid Until': '2026-11-20' }).status).toBe(
      'placement'
    );
    // the confirm step’s dates are judged against the season too
    const off = note(parse([row()], { dates: { validFrom: '2026-08-01' } })).rows[0];
    expect(off.reason).toBe('outside-season-window');
  });

  it('with no date for an end anywhere the row is missing-dates', () => {
    const noEnd = parsePracticeRows({
      headers: HEADERS,
      rows: [
        row({ 'Valid From': '2026-09-14' }),
        row({ 'Valid From': '2026-09-14', 'Valid Until': '2026-10-01' }),
      ],
      season: { startDate: '2026-09-07', endDate: null },
    });
    note(noEnd);
    expect(noEnd.rows.map((r) => r.reason)).toEqual(['missing-dates', null]);
    expect(noEnd.rows[0].message).toMatch(/Valid Until/);
    const none = note(
      parsePracticeRows({
        headers: HEADERS,
        rows: [row()],
        season: { startDate: null, endDate: null },
      })
    );
    expect(none.rows[0].reason).toBe('missing-dates');
    expect(none.rows[0].message).toMatch(/Valid From.*Valid Until|dates/);
    // the confirm step supplies what the season lacks
    const supplied = parsePracticeRows({
      headers: HEADERS,
      rows: [row()],
      season: { startDate: null, endDate: null },
      dates: { validFrom: '2026-09-14', validUntil: '2026-11-20' },
    });
    expect(supplied.rows[0].status).toBe('placement');
  });

  it('throws on a season date that is present and not a date, rather than reading "none"', () => {
    expect(() =>
      parsePracticeRows({
        headers: HEADERS,
        rows: [],
        season: { startDate: 'soon', endDate: null },
      })
    ).toThrow(/season.startDate/);
    expect(() =>
      parsePracticeRows({
        headers: HEADERS,
        rows: [],
        season: SEASON,
        dates: { validFrom: '13/04/2026' },
      })
    ).toThrow(/dates.validFrom/);
  });
});

describe('practice import: the file', () => {
  it('names the first required column the file lacks', () => {
    for (const column of ['Day', 'Start', 'Location', 'Field']) {
      const result = note(
        parsePracticeRows({
          headers: HEADERS.filter((h) => h !== column),
          rows: [row()],
          season: SEASON,
        })
      );
      expect([column, result.ok, result.refusal?.code, result.refusal?.column]).toEqual([
        column,
        false,
        'missing-column',
        column,
      ]);
      expect(result.rows).toEqual([]);
    }
  });

  it('matches columns by the shared normaliser and takes the plan’s header aliases', () => {
    const odd = [
      ' team ',
      'DIVISION',
      'day',
      'Start',
      '﻿End',
      'Venue',
      'FIELD',
      'Half',
      'valid from',
    ];
    const result = parsePracticeRows({
      headers: odd,
      rows: [
        {
          ' team ': 'U10B-01',
          DIVISION: 'U10 Boys',
          day: 'Mon',
          Start: '16:00',
          '﻿End': '17:00',
          Venue: 'Venue A',
          FIELD: 'Field 1',
          Half: 'B',
          'valid from': '2026-09-14',
        },
      ],
      season: SEASON,
    });
    expect(result.ok).toBe(true);
    const r = result.rows[0];
    expect([r.teamLabel, r.locationLabel, r.fieldLabel, r.subunitLabel, r.validFrom]).toEqual([
      'U10B-01',
      'Venue A',
      'Field 1',
      'B',
      '2026-09-14',
    ]);
    const side = parsePracticeRows({
      headers: [...HEADERS.filter((h) => h !== 'Subunit'), 'Side'],
      rows: [{ ...row(), Side: 'A' }],
      season: SEASON,
    });
    expect(side.rows[0].subunitLabel).toBe('A');
  });

  it('refuses two columns of one name, aliases included', () => {
    for (const extra of ['Venue', 'Half']) {
      const result = note(
        parsePracticeRows({ headers: [...HEADERS, extra], rows: [row()], season: SEASON })
      );
      expect([extra, result.refusal?.code]).toEqual([extra, 'duplicate-column']);
    }
    expect(
      note(parsePracticeRows({ headers: [...HEADERS, 'location'], rows: [], season: SEASON }))
        .refusal?.code
    ).toBe('duplicate-column');
  });

  it('takes 2,400 rows and refuses 2,401, naming the limit', () => {
    const make = (n) =>
      Array.from({ length: n }, (_, i) =>
        row({ Team: '', Start: '16:00', Day: 'Mon', Field: `F${i}` })
      );
    const ok = parse(make(2400));
    expect(ok.ok).toBe(true);
    expect(ok.rows).toHaveLength(2400);
    const refused = note(parse(make(2401)));
    expect([refused.ok, refused.refusal?.code]).toEqual([false, 'too-many-rows']);
    expect(refused.refusal.message).toMatch(/2,400/);
  });

  it('rejects input that is not a header row and rows', () => {
    // @ts-expect-error a string is not a header row
    expect(() => parsePracticeRows({ headers: 'Team', rows: [], season: SEASON })).toThrow(
      TypeError
    );
    // @ts-expect-error an object is not rows
    expect(() => parsePracticeRows({ headers: HEADERS, rows: {}, season: SEASON })).toThrow(
      TypeError
    );
  });

  it('counts what it read', () => {
    const result = parse([
      row(),
      row({ Team: '', Division: '', Start: '17:00', End: '18:00' }),
      row({ Team: '', Division: '', Use: 'hold', Start: '18:00', End: '19:00' }),
      row({ Day: 'Funday' }),
      row({ Team: '', Start: '19:00', End: '20:00' }),
    ]);
    expect(result.counts).toEqual({
      rows: 5,
      placements: 1,
      open: 2,
      holds: 1,
      refused: 1,
      flagged: 1,
    });
    expect(result.byReason).toEqual({ 'bad-day': 1 });
  });
});

describe('practice import: only the allowlisted columns are read', () => {
  it('drops every other column before reading it, and its values appear nowhere', () => {
    const headers = [...HEADERS, 'Block', 'Coach Email', 'Phone', 'Notes'];
    const result = parsePracticeRows({
      headers,
      rows: [
        {
          ...row(),
          Block: '60',
          'Coach Email': 'secret-coach@example.com',
          Phone: '555-0100',
          Notes: 'SECRET-NOTE-123',
        },
      ],
      season: SEASON,
    });
    expect(result.droppedColumns).toEqual(['Block', 'Coach Email', 'Phone', 'Notes']);
    const text = JSON.stringify(result);
    for (const secret of ['secret-coach', '555-0100', 'SECRET-NOTE-123']) {
      expect([secret, text.includes(secret)]).toEqual([secret, false]);
    }
    expect(result.ok).toBe(true);
  });
});

describe('practice import: repeats, stray whitespace, and a label that differs by a word', () => {
  it('reads a label trimmed, and keys it with stray whitespace and case folded away', () => {
    const result = parse([
      row({ Team: 'U10B-03 ' }),
      row({ Team: ' u10b-03', Day: 'Wed' }),
      row({ Team: 'U10B  -03', Day: 'Fri' }),
    ]);
    expect(result.rows.map((r) => r.status)).toEqual(['placement', 'placement', 'placement']);
    // the cell is trimmed where it is read; the key folds case and collapses runs of spaces
    expect(result.rows.map((r) => r.teamLabel)).toEqual(['U10B-03', 'u10b-03', 'U10B  -03']);
    expect(practiceImport.practiceLabelKey('U10B-03 ')).toBe(
      practiceImport.practiceLabelKey(' u10b-03')
    );
    // a run of spaces collapses to ONE space, it is not dropped: 'U10B  -03' is 'u10b -03', not 'u10b-03'
    expect(practiceImport.practiceLabelKey('U10B  -03')).not.toBe(
      practiceImport.practiceLabelKey('U10B-03')
    );
  });

  it('calls the same row twice a duplicate, however its team is spelled, and keeps the first', () => {
    const result = note(
      parse([row({ Team: 'U10B-03' }), row({ Team: 'U10B-03 ' }), row({ Team: 'u10b-03' })])
    );
    expect(result.rows.map((r) => [r.status, r.reason])).toEqual([
      ['placement', null],
      ['refused', 'duplicate-row'],
      ['refused', 'duplicate-row'],
    ]);
    expect(result.rows[1].message).toMatch(/row 1/);
  });

  it('does not call two cells, two teams or two ends one row', () => {
    const result = parse([
      row(),
      row({ Team: 'U10B-02' }), // another team in the same cell: capacity, not a duplicate
      row({ Subunit: 'B' }),
      row({ Day: 'Tue' }),
      row({ Start: '17:00', End: '18:00' }),
      row({ End: '17:30' }), // same team, same cell, another end: the slot step’s case
      row({ Team: '', Division: '' }),
      row({ Team: '', Division: '', Use: 'hold' }),
    ]);
    expect(result.rows.map((r) => r.reason)).toEqual(Array(8).fill(null));
  });

  it('keeps a label that differs by a word as another team', () => {
    // 'Red' and 'Red Back' are two teams; 'Red' is not 'Red Back' with a word dropped
    expect(practiceImport.practiceLabelKey('U10B Red')).not.toBe(
      practiceImport.practiceLabelKey('U10B Red Back')
    );
    const result = parse([row({ Team: 'U10B Red' }), row({ Team: 'U10B Red Back' })]);
    expect(result.rows.map((r) => r.reason)).toEqual([null, null]);
  });

  it('a composite key is a tuple, never a delimited string', () => {
    // 'a|b' + 'c' and 'a' + 'b|c' are different cells, and neither is a duplicate of the other
    const result = parse([
      row({ Location: 'a|b', Field: 'c' }),
      row({ Location: 'a', Field: 'b|c' }),
      row({ Location: 'a,b', Field: 'c' }),
      row({ Location: 'a', Field: 'b,c' }),
    ]);
    expect(result.rows.map((r) => r.reason)).toEqual([null, null, null, null]);
  });

  it('refuses every row of a team label the file puts in two divisions, whichever comes first', () => {
    const rows = [
      row({ Team: 'U06B-01', Division: 'U06 Boys', Day: 'Mon' }),
      row({ Team: 'U06B-01', Division: 'U06 Girls', Day: 'Wed' }),
      row({ Team: 'U06B-02', Division: 'U06 Boys', Day: 'Mon', Start: '17:00', End: '18:00' }),
    ];
    const verdicts = (list) => note(parse(list)).rows.map((r) => [r.teamLabel, r.reason]);
    expect(verdicts(rows)).toEqual([
      ['U06B-01', 'team-in-two-divisions'],
      ['U06B-01', 'team-in-two-divisions'],
      ['U06B-02', null],
    ]);
    // order does not decide it: the same file reversed refuses the same rows
    expect(verdicts([...rows].reverse())).toEqual([
      ['U06B-02', null],
      ['U06B-01', 'team-in-two-divisions'],
      ['U06B-01', 'team-in-two-divisions'],
    ]);
    // the same division spelled two ways is one division, not two
    const spelled = verdicts([
      row({ Team: 'U06B-01', Division: 'U06 Boys', Day: 'Mon' }),
      row({ Team: 'U06B-01', Division: ' u06  boys ', Day: 'Wed' }),
    ]);
    expect(spelled).toEqual([
      ['U06B-01', null],
      ['U06B-01', null],
    ]);
  });
});

describe('practice import: the host time zone is not an input', () => {
  const fixture = loadPracticeFixture();
  const readAll = () =>
    JSON.stringify([
      parsePracticeRows({
        headers: fixture.schedule.headers,
        rows: fixture.schedule.rows,
        season: fixture.season,
      }),
      parsePracticeRows({
        headers: fixture.invalid.headers,
        rows: fixture.invalid.rows,
        season: fixture.invalidSeason,
      }),
      parse([
        row({
          Start: '01:30',
          End: '02:30',
          'Valid From': '2026-11-01',
          'Valid Until': '2026-11-01',
        }),
        row({
          Start: '2:30 AM',
          End: '3:30 AM',
          'Valid From': '3/14/2027',
          'Valid Until': '3/14/2027',
        }),
      ]),
    ]);

  it('reads the fixture and the clock-change dates the same under other TZ values', () => {
    const original = process.env.TZ;
    try {
      const results = ['Pacific/Auckland', 'America/New_York', 'Asia/Kolkata', 'UTC'].map(
        (zone) => {
          process.env.TZ = zone;
          return readAll();
        }
      );
      for (const r of results.slice(1)) expect(r).toBe(results[0]);
      // the control: the zones really differ in this process
      process.env.TZ = 'Pacific/Auckland';
      const a = new Date(2026, 10, 1, 1, 30).getTime();
      process.env.TZ = 'America/New_York';
      const b = new Date(2026, 10, 1, 1, 30).getTime();
      expect(a).not.toBe(b);
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });
});

describe('practice import: the fixture, whole', () => {
  const fixture = loadPracticeFixture();

  it('reads practice-schedule.csv with no refusal and no flag', () => {
    const result = note(
      parsePracticeRows({
        headers: fixture.schedule.headers,
        rows: fixture.schedule.rows,
        season: fixture.season,
      })
    );
    expect(result.ok).toBe(true);
    expect(result.droppedColumns).toEqual(['Block']);
    expect(result.counts).toEqual({
      rows: 710,
      placements: 236,
      open: 473,
      holds: 1,
      refused: 0,
      flagged: 0,
    });
    // every row took the season’s dates
    expect(result.rows.every((r) => r.dateSources.from === 'season')).toBe(true);
  });

  it('folds the two stray-whitespace labels into their teams’ keys', () => {
    const result = parsePracticeRows({
      headers: fixture.schedule.headers,
      rows: fixture.schedule.rows,
      season: fixture.season,
    });
    const raw = fixture.schedule.rows.filter((r) => r.Team !== r.Team.trim());
    expect(raw).toHaveLength(2);
    const keys = new Set(
      result.rows
        .filter((r) => r.status === 'placement')
        .map((r) => practiceImport.practiceLabelKey(r.teamLabel))
    );
    expect(keys.size).toBe(132);
  });
});

describe('practice import: practice-invalid.csv, parse and mapping together', () => {
  const fixture = loadPracticeFixture();
  const parsed = parsePracticeRows({
    headers: fixture.invalid.headers,
    rows: fixture.invalid.rows,
    season: fixture.invalidSeason,
  });
  const resolved = resolvePracticeRows({ rows: parsed.rows, league: fixture.league });

  const verdict = (r) => {
    if (r.status === 'refused') return r.reason;
    const flag = r.flags.find((f) => PRACTICE_IMPORT_FILE_FLAGS.includes(f.code));
    if (flag) return flag.code;
    return r.status === 'placement' ? 'ok' : r.status;
  };

  it('is read without a file refusal, and every row has a verdict', () => {
    note(parsed);
    expect(parsed.ok).toBe(true);
    expect(parsed.rows).toHaveLength(fixture.invalid.rows.length);
    expect(resolved.rows).toHaveLength(fixture.invalid.rows.length);
    expect(parsed.droppedColumns).toEqual(['Notes']);
  });

  it('gives every row the verdict its Notes expect (the generator’s word, not the parser’s)', () => {
    fixture.invalid.rows.forEach((source, i) => {
      const expected = source.Notes.replace(/^expect: /, '');
      expect([i + 1, verdict(resolved.rows[i])]).toEqual([i + 1, expected]);
    });
  });

  it('reaches every row-level reason of plan 4.11.4 from the file alone', () => {
    const fromFile = new Set(resolved.rows.map((r) => r.reason).filter(Boolean));
    for (const code of fromFile) reached.add(code);
    for (const r of resolved.rows) for (const f of r.flags) reached.add(f.code);
    expect([...fromFile].sort()).toEqual([...PRACTICE_IMPORT_ROW_REFUSALS].sort());
  });

  it('keeps the unexpected out: no row the Notes call ok has a reason, a flag or a gap in its ids', () => {
    fixture.invalid.rows.forEach((source, i) => {
      if (source.Notes !== 'expect: ok') return;
      const r = resolved.rows[i];
      expect(r.reason).toBeNull();
      expect(r.flags).toEqual([]);
      expect(r.ids.team).toBeTruthy();
      expect(r.ids.field).toBeTruthy();
      expect(r.ids.subunit).toBeTruthy();
    });
  });
});

describe('practice import: the Edge function’s header alias map (reported, not changed)', () => {
  // Plan 4.11.2: "PR 9 checks that the Edge function's header alias map takes the aliases above."
  // It takes the fields CSV's own names and nothing the practice file adds. This pins what is true
  // today so PR 10/11 change the map on purpose: if one of these assertions moves, update both.
  const source = readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      'supabase/functions/import-validation/index.ts'
    ),
    'utf8'
  );
  const block = source.slice(
    source.indexOf('const HEADER_ALIASES'),
    source.indexOf('};', source.indexOf('const HEADER_ALIASES'))
  );
  const map = new Map(
    [...block.matchAll(/^\s*['"]?([a-z_ /]+?)['"]?:\s*'([a-z_]+)',?$/gm)].map((m) => [m[1], m[2]])
  );

  it('reads the map (the scan found it)', () => {
    expect(map.size).toBeGreaterThan(60);
    expect(map.get('valid from')).toBe('valid_from');
  });

  it('takes the names the practice file shares with the fields CSV', () => {
    const TAKEN = {
      location: 'location',
      venue: 'location',
      field: 'name',
      subunit: 'subunit',
      day: 'day',
      start: 'start',
      end: 'end',
      capacity: 'capacity',
      'valid from': 'valid_from',
      'valid until': 'valid_until',
    };
    for (const [header, key] of Object.entries(TAKEN)) {
      expect([header, map.get(header)]).toEqual([header, key]);
    }
  });

  it('already takes Division, as `division_name`: the fields CSV’s reservation key (a finding for PR 10/11)', () => {
    // In the fields CSV `Division` RESERVES a slot for a division (`20261029010000`, section 5). In the
    // practice file it names the team’s division and this import never writes a reservation (plan 4.11.2).
    // The same header reaches the Edge function under the same key, so PR 11’s practice import type must
    // read `division_name` as the team’s division and its allowlist must not carry it to a reservation.
    expect(map.get('division')).toBe('division_name');
  });

  it('does not take what only the practice file adds: Half, Side, Length, Team, Use', () => {
    // PR 11 adds what it needs; if one of these moves, update this test on purpose.
    for (const header of ['half', 'side', 'length', 'team', 'use']) {
      expect([header, map.has(header)]).toEqual([header, false]);
    }
  });
});

describe('practice import: every reason of the closed list was reached', () => {
  it('has seen each row-level refusal and file refusal come out of an input, here or in the fixture', () => {
    // This test runs last in the file. It can fail: remove the test for any one reason and the set
    // below lacks it (the control is the same set, built from the list, minus one).
    const missing = PRACTICE_IMPORT_ROW_REFUSALS.filter((code) => !reached.has(code));
    expect(missing).toEqual([]);
    const withOneRemoved = new Set(reached);
    withOneRemoved.delete('bad-day');
    expect(PRACTICE_IMPORT_ROW_REFUSALS.filter((code) => !withOneRemoved.has(code))).toEqual([
      'bad-day',
    ]);
    const missingFile = PRACTICE_IMPORT_FILE_REFUSALS.filter((code) => !reached.has(code));
    expect(missingFile).toEqual([]);
    // the flags this module computes (the six others are the database's)
    for (const code of PRACTICE_IMPORT_FILE_FLAGS)
      expect([code, reached.has(code)]).toEqual([code, true]);
  });
});
