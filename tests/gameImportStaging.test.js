/**
 * The staged row of a games import (PR 5): `toStagedGameRow` is where a parsed row becomes the keys the SQL apply reads.
 * The keys equal the allowlist (`GAME_IMPORT_KEYS`, which `tests/importAllowlistParity.test.js` holds equal to what the
 * SQL reads), for a placed row and a TIME TBD row alike; a refused row has no payload and its reason; and every row of
 * the shipped fixture stages in the shape the SQL's own shape check accepts.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { GAME_IMPORT_KEYS } from '../frontend/src/utils/importAllowlist.js';
import {
  GAME_STAGED_KEYS,
  SCHEDULE_IMPORT_ROW_REFUSALS,
  SCHEDULE_IMPORT_TBD_REASONS,
  fieldDecisionKey,
  parseScheduleRows,
  teamDecisionKey,
  toStagedGameRow,
} from '../packages/core/src/scheduleImport/index.js';
import { loadScheduleFixture } from './helpers/scheduleFixtureLoad.js';

const fixture = loadScheduleFixture();
const parsed = parseScheduleRows({
  headers: fixture.schedule.headers,
  rows: fixture.schedule.rows,
  season: fixture.season,
});
const invalid = parseScheduleRows({
  headers: fixture.invalid.headers,
  rows: fixture.invalid.rows,
  season: fixture.season,
});

// The shape check of `apply_game_import_job` (the migration), as regular expressions.
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const CLOCK = /^\d{2}:\d{2}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

describe('a staged games row carries the allowlisted keys and nothing else', () => {
  it('the constant is the allowlist, in order', () => {
    expect([...GAME_STAGED_KEYS]).toEqual([...GAME_IMPORT_KEYS]);
  });

  it('a placed row', () => {
    const placed = parsed.rows.find((row) => row.status === 'ok');
    expect(placed).toBeTruthy();
    const staged = toStagedGameRow(/** @type {any} */ (placed));
    expect(Object.keys(staged.normalized_payload ?? {})).toEqual([...GAME_IMPORT_KEYS]);
    expect(staged.validation_errors).toEqual([]);
    expect(staged.source_row_number).toBe(/** @type {any} */ (placed).rowNumber);
  });

  it("a TIME TBD row has no instants and the import's reason", () => {
    const tbd = invalid.rows.find((row) => row.status === 'tbd');
    expect(tbd).toBeTruthy();
    const staged = toStagedGameRow(/** @type {any} */ (tbd));
    expect(Object.keys(staged.normalized_payload ?? {})).toEqual([...GAME_IMPORT_KEYS]);
    expect(staged.normalized_payload).toMatchObject({
      status: 'tbd',
      start: null,
      end: null,
      tbd_reason: 'imported-without-time',
    });
  });

  it('a refused row has no payload and says why', () => {
    const refused = invalid.rows.find((row) => row.status === 'refused');
    expect(refused).toBeTruthy();
    const staged = toStagedGameRow(/** @type {any} */ (refused));
    expect(staged.normalized_payload).toBeNull();
    expect(staged.validation_errors).toEqual([
      { code: /** @type {any} */ (refused).reason, message: expect.any(String) },
    ]);
  });

  it("keys each label by the mapping step's own decision keys", () => {
    const placed = /** @type {any} */ (parsed.rows.find((row) => row.status === 'ok'));
    const staged = /** @type {any} */ (toStagedGameRow(placed).normalized_payload);
    expect(staged.field_key).toBe(fieldDecisionKey(placed.venueLabel, placed.fieldLabel));
    expect(staged.home_key).toBe(teamDecisionKey(placed.divisionLabel, placed.homeLabel));
    // Case and spacing do not make a second key (the one normaliser), and a tuple key has no ambiguous delimiter.
    expect(teamDecisionKey('U10', 'Lions')).toBe(teamDecisionKey(' u10 ', 'LIONS'));
    expect(teamDecisionKey('U10|Boys', 'Lions')).not.toBe(teamDecisionKey('U10', 'Boys|Lions'));
  });

  it('every row of the fixture stages in the shape the SQL accepts', () => {
    const rows = [...parsed.rows, ...invalid.rows].filter((row) => row.status !== 'refused');
    expect(rows.length).toBeGreaterThan(500);
    for (const row of rows) {
      const p = /** @type {any} */ (toStagedGameRow(/** @type {any} */ (row)).normalized_payload);
      expect(DATE.test(p.date), row.rowKey).toBe(true);
      expect(
        Number.isInteger(p.week_index) && p.week_index >= 1 && p.week_index <= 255,
        row.rowKey
      ).toBe(true);
      expect(['ok', 'tbd']).toContain(p.status);
      if (p.status === 'ok') {
        expect(CLOCK.test(p.start_time) && CLOCK.test(p.end_time), row.rowKey).toBe(true);
        expect(INSTANT.test(p.start) && INSTANT.test(p.end), row.rowKey).toBe(true);
        expect(Date.parse(p.end) > Date.parse(p.start), row.rowKey).toBe(true);
      } else {
        expect(p.start === null && p.end === null, row.rowKey).toBe(true);
      }
      expect(
        p.flags.every((f) => ['time-ambiguous', 'week-differs'].includes(f)),
        row.rowKey
      ).toBe(true);
      expect((p.game_id ?? '').length <= 40, row.rowKey).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Fix round 1 (code review of 87b696a, finding 1): a row with a time and no field.
// ---------------------------------------------------------------------------------------------------------------------
//
// The parse makes a row with no time OR no field a TIME TBD game, and it assigns the instants before it knows the field is
// blank, so a row with a time and a blank Field comes out `tbd` WITH `start` and `end`. The SQL's shape check wants
// `tbd` to carry no instants (a TIME TBD game has no place in time), so ONE such row made the whole apply refuse
// (`game_import_staged_invalid`) although the plan says it becomes a TIME TBD game. The staged row, not the parse, is
// where that is settled: a `tbd` row is staged with no instants and no wall times.

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
const fileRow = (over = {}) => ({
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
const parseFile = (rows) => parseScheduleRows({ headers: HEADERS, rows, season: SEASON }).rows;

describe('a row with a time and no field is staged as a TIME TBD game with no instants', () => {
  it('the parse says tbd and still holds the instants (why the staged row must drop them)', () => {
    const [timed] = /** @type {any[]} */ (parseFile([fileRow({ Field: '' })]));
    expect(timed.status).toBe('tbd');
    expect(timed.start).not.toBeNull();
    expect(timed.startTime).toBe('09:00');
  });

  it('is staged with start, end and both wall times null (and its date, week, labels and reason)', () => {
    const [timed] = parseFile([fileRow({ Field: '' })]);
    const staged = /** @type {any} */ (
      toStagedGameRow(/** @type {any} */ (timed)).normalized_payload
    );
    expect(staged).toMatchObject({
      status: 'tbd',
      tbd_reason: 'imported-without-time',
      date: '2026-09-12',
      week_index: 1,
      start: null,
      end: null,
      start_time: null,
      end_time: null,
    });
    expect(staged.home_team).toBe('U05B Team 01');
  });

  it('a placed row keeps its instants (the control: only a tbd row loses them)', () => {
    const [placed] = parseFile([fileRow()]);
    const staged = /** @type {any} */ (
      toStagedGameRow(/** @type {any} */ (placed)).normalized_payload
    );
    expect(staged).toMatchObject({ status: 'ok', start_time: '09:00', end_time: '10:00' });
    expect(staged.start).toBeTruthy();
    expect(staged.end).toBeTruthy();
  });
});

// A hand-written TWIN of the shape check `apply_game_import_job` makes of every staged row (the migration, section 1: the
// `NOT (r.status IN ('ok','tbd') AND ...)` predicate). Its limits, said plainly: it is a copy, not the SQL; it judges the
// instants by their ISO text and not by `timestamptz`'s own parse; it does not twin the refusal codes the SQL accepts for a
// refused row beyond membership in core's list, nor anything after the shape check (mapping, matching, the plan). What
// holds the copy to the SQL is the static test below, which reads the migration for the clauses this twin states.
const TWIN_FLAGS = ['time-ambiguous', 'week-differs'];
/** @param {{ source_row_number: number, normalized_payload: any, validation_errors: Array<{ code: string }> }} staged */
function shapeProblem(staged) {
  const p = staged.normalized_payload;
  if (p === null) {
    const codes = staged.validation_errors.map((e) => e.code);
    return codes.length === 1 &&
      SCHEDULE_IMPORT_ROW_REFUSALS.includes(/** @type {any} */ (codes[0]))
      ? null
      : `a refused row says one reason of the closed list, not ${JSON.stringify(codes)}`;
  }
  const text = (v) => typeof v === 'string' && v.trim() !== '';
  if (!['ok', 'tbd'].includes(p.status)) return `status ${p.status}`;
  if (!DATE.test(String(p.date))) return 'date';
  if (!(Number.isInteger(p.week_index) && p.week_index >= 1 && p.week_index <= 255)) return 'week';
  if (!text(p.row_key)) return 'row_key';
  if ((p.game_id ?? '').length > 40) return 'game_id length';
  for (const key of [
    'division_key',
    'home_key',
    'away_key',
    'division',
    'home_team',
    'away_team',
  ]) {
    if (!text(p[key])) return key;
  }
  if (p.status === 'ok') {
    for (const key of ['start_time', 'end_time']) if (!CLOCK.test(String(p[key]))) return key;
    for (const key of ['start', 'end']) if (!INSTANT.test(String(p[key]))) return key;
    if (!(Date.parse(p.end) > Date.parse(p.start))) return 'end not after start';
    for (const key of ['venue_key', 'field_key', 'venue', 'field']) if (!text(p[key])) return key;
  } else if (p.start !== null || p.end !== null) {
    return 'a tbd row carries instants';
  } else if (!SCHEDULE_IMPORT_TBD_REASONS.includes(p.tbd_reason)) {
    return 'a tbd row has no known reason';
  }
  if (!p.flags.every((f) => TWIN_FLAGS.includes(f))) return 'flags';
  return null;
}

describe('every parse outcome stages in a shape the SQL accepts (a JS twin of its shape check)', () => {
  // The outcomes the parse can produce, built one by one (the rows are the shipped fixtures' kind, with invented values).
  const crafted = /** @type {Array<[string, Record<string, string>[]]>} */ ([
    ['ok', [fileRow()]],
    ['tbd: no time', [fileRow({ 'Start Time': '', 'End Time': '' })]],
    ['tbd: a time and no field', [fileRow({ Field: '' })]],
    ['tbd: no time and no field', [fileRow({ Field: '', 'Start Time': '', 'End Time': '' })]],
    ['bad-game-id', [fileRow({ 'Game ID': 'G'.repeat(41) })]],
    ['bad-date', [fileRow({ Date: '2026-13-45' })]],
    ['bad-time', [fileRow({ 'Start Time': '25:99' })]],
    ['end-not-after-start', [fileRow({ 'Start Time': '10:00', 'End Time': '09:00' })]],
    ['same-team', [fileRow({ 'Away Team': 'U05B Team 01' })]],
    ['bad-week', [fileRow({ Week: 'abc' })]],
    ['outside-season-window', [fileRow({ Date: '2026-08-29', Week: '' })]],
    [
      'time-in-dst-gap',
      [fileRow({ Date: '2027-03-14', 'Start Time': '02:30', 'End Time': '03:30', Week: '' })],
    ],
    ['duplicate-row', [fileRow(), fileRow()]],
    [
      'game-id-reused',
      [fileRow(), fileRow({ Date: '2026-09-19', Week: '2', 'Home Team': 'U05B Team 03' })],
    ],
  ]);
  const outcomes = crafted.flatMap(([name, rows]) =>
    parseFile(rows).map((r) => ({ name, row: /** @type {any} */ (r) }))
  );
  const fixtureRows = [...parsed.rows, ...invalid.rows].map((r) => ({
    name: 'fixture',
    row: /** @type {any} */ (r),
  }));

  it('reaches ok, every TIME TBD form and every refusal the parse can give (a check over fewer would pass)', () => {
    const reached = new Set(
      outcomes.map(({ row }) => (row.status === 'refused' ? row.reason : `${row.status}`))
    );
    for (const code of [
      'ok',
      'tbd',
      'bad-game-id',
      'bad-date',
      'bad-time',
      'end-not-after-start',
      'same-team',
      'bad-week',
      'outside-season-window',
      'time-in-dst-gap',
      'duplicate-row',
      'game-id-reused',
    ]) {
      expect(reached.has(code), code).toBe(true);
    }
    // The three ways to be TIME TBD, each reached as its own row.
    const tbd = outcomes.filter(({ row }) => row.status === 'tbd');
    expect(tbd.some(({ row }) => row.start === null && row.fieldLabel !== '')).toBe(true);
    expect(tbd.some(({ row }) => row.start !== null && row.fieldLabel === '')).toBe(true);
    expect(tbd.some(({ row }) => row.start === null && row.fieldLabel === '')).toBe(true);
  });

  it('every outcome, and every row of the shipped fixtures, stages in the twin shape', () => {
    for (const { name, row } of [...outcomes, ...fixtureRows]) {
      const staged = toStagedGameRow(row);
      expect(shapeProblem(/** @type {any} */ (staged)), `${name} row ${row.rowNumber}`).toBeNull();
    }
  });

  it('CONTROL: the twin refuses what the SQL refuses (so it can fail)', () => {
    const [timed] = parseFile([fileRow({ Field: '' })]);
    const staged = /** @type {any} */ (toStagedGameRow(/** @type {any} */ (timed)));
    expect(shapeProblem(staged)).toBeNull();
    // A tbd row that still carries an instant, as 87b696a staged it.
    const old = {
      ...staged,
      normalized_payload: { ...staged.normalized_payload, start: '2026-09-12T09:00:00-07:00' },
    };
    expect(shapeProblem(old)).toBe('a tbd row carries instants');
    // A placed row with its end before its start; a refusal with a code off the list; a week past 255.
    const [placed] = parseFile([fileRow()]);
    const ok = /** @type {any} */ (toStagedGameRow(/** @type {any} */ (placed)));
    expect(
      shapeProblem({
        ...ok,
        normalized_payload: { ...ok.normalized_payload, end: ok.normalized_payload.start },
      })
    ).toBe('end not after start');
    expect(
      shapeProblem({ ...ok, normalized_payload: { ...ok.normalized_payload, week_index: 256 } })
    ).toBe('week');
    expect(
      shapeProblem({
        source_row_number: 1,
        normalized_payload: null,
        validation_errors: [{ code: 'because' }],
      })
    ).toMatch(/closed list/);
  });

  it('the SQL still states the clauses the twin copies (so the twin cannot drift from it)', () => {
    const migration = readFileSync(
      path.join(process.cwd(), 'supabase/migrations/20261121010000_game_import.sql'),
      'utf8'
    );
    const at = migration.indexOf("NOT (r.status IN ('ok', 'tbd') AND r.gdate IS NOT NULL");
    expect(at).toBeGreaterThan(0);
    const check = migration.slice(at, migration.indexOf('LIMIT 1', at));
    for (const clause of [
      'r.week_index BETWEEN 1 AND 255',
      'COALESCE(char_length(r.game_id), 0) <= 40',
      'r.start_time IS NOT NULL AND r.end_time IS NOT NULL AND r.start_ts IS NOT NULL AND r.end_ts IS NOT NULL',
      'r.end_ts > r.start_ts',
      'ELSE r.start_ts IS NULL AND r.end_ts IS NULL END',
      "r.flags <@ ARRAY['time-ambiguous', 'week-differs']",
    ]) {
      expect(check, clause).toContain(clause);
    }
  });
});
