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
import { stageScheduleChunk } from '../packages/core/src/scheduleImport/index.js';
import { sanitizeImportText } from '../frontend/src/utils/importRows.js';
import * as edge from '../supabase/functions/_shared/schedule-import.ts';
import { loadScheduleFixture } from './helpers/scheduleFixtureLoad.js';
import { GAME_IMPORT_SQL } from './helpers/gameImportSql.js';

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
        p.flags.every((f) =>
          ['time-ambiguous', 'week-differs', 'bad-time', 'bad-week'].includes(f)
        ),
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
const TWIN_FLAGS = ['time-ambiguous', 'week-differs', 'bad-time', 'bad-week'];
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
    // F5: `bad-time` and `bad-week` are kept rows that carry the code as a flag, so a flag reaches its code too.
    const reached = new Set(
      outcomes.flatMap(({ row }) =>
        row.status === 'refused'
          ? [row.reason]
          : [`${row.status}`, ...row.flags.map((/** @type {{ code: string }} */ f) => f.code)]
      )
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

  it('F5: a bad-time row stages as a dated TIME TBD game and a bad-week row with its derived week; each carries its warning as a staged flag (20261122010000)', () => {
    const [badTime] = parseFile([fileRow({ 'Start Time': '25:99' })]);
    const [badWeek] = parseFile([fileRow({ Week: 'abc' })]);
    const t = /** @type {any} */ (toStagedGameRow(/** @type {any} */ (badTime)));
    expect(t.validation_errors).toEqual([]);
    expect(t.normalized_payload).toMatchObject({
      status: 'tbd',
      tbd_reason: 'imported-without-time',
      date: '2026-09-12',
      start: null,
      end: null,
      start_time: null,
      end_time: null,
      flags: ['bad-time'],
    });
    const w = /** @type {any} */ (toStagedGameRow(/** @type {any} */ (badWeek)));
    expect(w.normalized_payload).toMatchObject({
      status: 'ok',
      week_index: 1,
      flags: ['bad-week'],
    });
    // CONTROL: another flag the SQL knows is staged the same way, and one it does not know is refused by its shape check.
    const [differs] = parseFile([fileRow({ Week: '3' })]);
    const d = /** @type {any} */ (toStagedGameRow(/** @type {any} */ (differs)));
    expect(d.normalized_payload.flags).toEqual(['week-differs']);
    expect(
      shapeProblem({
        ...t,
        normalized_payload: { ...t.normalized_payload, flags: ['games-swapped'] },
      })
    ).toBe('flags');
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

  it('the twin holds the keys as the SQL does (a key of blank parts is not a key)', () => {
    // The SQL reads `division_key`, `home_key` and `away_key` as text and requires them non-empty; a team key is a JSON
    // tuple, so the twin also requires each PART of it, which is what "a blank Home Team" breaks.
    const [placed] = parseFile([fileRow()]);
    const ok = /** @type {any} */ (toStagedGameRow(/** @type {any} */ (placed)));
    expect(
      shapeProblem({
        ...ok,
        normalized_payload: {
          ...ok.normalized_payload,
          home_team: '',
          home_key: '["u05 boys",""]',
        },
      })
    ).toBe('home_team');
    expect(
      shapeProblem({ ...ok, normalized_payload: { ...ok.normalized_payload, division: ' ' } })
    ).toBe('division');
    expect(
      shapeProblem({ ...ok, normalized_payload: { ...ok.normalized_payload, venue: '' } })
    ).toBe('venue');
  });

  it('the SQL still states the clauses the twin copies (so the twin cannot drift from it)', () => {
    const migration = GAME_IMPORT_SQL;
    const at = migration.indexOf("NOT (r.status IN ('ok', 'tbd') AND r.gdate IS NOT NULL");
    expect(at).toBeGreaterThan(0);
    const check = migration.slice(at, migration.indexOf('LIMIT 1', at));
    for (const clause of [
      'r.week_index BETWEEN 1 AND 255',
      'COALESCE(char_length(r.game_id), 0) <= 40',
      'r.start_time IS NOT NULL AND r.end_time IS NOT NULL AND r.start_ts IS NOT NULL AND r.end_ts IS NOT NULL',
      'r.end_ts > r.start_ts',
      'ELSE r.start_ts IS NULL AND r.end_ts IS NULL END',
      "r.flags <@ ARRAY['time-ambiguous', 'week-differs', 'bad-time', 'bad-week']",
      // the labels and keys a blank cell would leave empty (PR 6 fix round 1, Codex P2)
      "COALESCE(r.division_key, '') <> '' AND COALESCE(r.home_key, '') <> '' AND COALESCE(r.away_key, '') <> ''",
      "COALESCE(r.division_label, '') <> '' AND COALESCE(r.home_label, '') <> '' AND COALESCE(r.away_label, '') <> ''",
      "COALESCE(r.venue_key, '') <> '' AND COALESCE(r.field_key, '') <> ''",
      "COALESCE(r.venue_label, '') <> '' AND COALESCE(r.field_label, '') <> ''",
    ]) {
      expect(check, clause).toContain(clause);
    }
  });
});

// ------------------------------------------------------------------- PR 6 fix round 1 (Codex P2): the class, not the case
describe('EVERY row staging accepts passes the apply’s shape check, whatever cell is blank', () => {
  // A row staging returns as accepted (`ok` or `tbd`) that the apply's shape check refuses does not fail alone: the
  // apply raises `game_import_staged_invalid` for the WHOLE job. A blank Division or team did exactly that. So the
  // subject set is generated: every column the shape check reads, blanked every way a cell can be blank, alone and in
  // pairs, through BOTH staging implementations (core's, which the mock runs, and the Edge function's).
  const BLANKS = ['', ' ', '\t', '\u00a0', ' \u00a0 '];
  const COLUMNS = [
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
  const HEADERS = COLUMNS;
  const base = () => fileRow();
  const table = [];
  for (const column of COLUMNS)
    for (const blank of BLANKS)
      table.push({
        name: `${column}=${JSON.stringify(blank)}`,
        row: { ...base(), [column]: blank },
      });
  for (let i = 0; i < COLUMNS.length; i += 1)
    for (let j = i + 1; j < COLUMNS.length; j += 1)
      table.push({
        name: `${COLUMNS[i]} and ${COLUMNS[j]} blank`,
        row: { ...base(), [COLUMNS[i]]: '', [COLUMNS[j]]: ' ' },
      });
  // and the cells that are not blank but cannot be stored
  table.push({
    name: 'a date 300 weeks on, no season end',
    row: { ...base(), Date: '2032-06-12', Week: '' },
    season: { ...fixture.season, endDate: null },
  });
  table.push({ name: 'a Week of 256', row: { ...base(), Week: '256' } });

  /** @type {Array<[string, (input: any) => any]>} */
  const stagers = [
    ['core', (input) => stageScheduleChunk({ ...input, clean: sanitizeImportText })],
    ['edge', (input) => edge.stageGameChunk(input)],
  ];

  it('the table blanks every column the shape check reads (a table that skipped one would pass)', () => {
    expect(table.length).toBeGreaterThanOrEqual(COLUMNS.length * BLANKS.length + 45);
    for (const column of COLUMNS)
      expect(table.some((t) => t.name.startsWith(`${column}=`))).toBe(true);
    // CONTROL: the row the table is built from is a placed game with nothing blank
    expect(parseFile([base()])[0]).toMatchObject({ status: 'ok', flags: [] });
  });

  for (const [who, stage] of stagers) {
    it(`${who}: no accepted row fails the shape check, and each blank has its outcome`, () => {
      const failures = [];
      const outcome = new Map();
      for (const { name, row, season } of table) {
        const result = stage({
          headers: HEADERS,
          rows: [row],
          season: season ?? fixture.season,
          rowOffset: 0,
        });
        expect(result.refusal, name).toBeNull();
        expect(result.staged, name).toHaveLength(1);
        const staged = JSON.parse(JSON.stringify(result.staged[0]));
        const problem = shapeProblem(staged);
        if (problem !== null) failures.push(`${name}: ${problem}`);
        outcome.set(
          name,
          staged.normalized_payload
            ? staged.normalized_payload.status
            : staged.validation_errors[0].code
        );
      }
      expect(failures).toEqual([]);
      // what each blank becomes, written out: a row with no division or team cannot be a game; one with no place is TIME TBD
      expect(outcome.get('Division=""')).toBe('unknown-division');
      expect(outcome.get('Home Team=" "')).toBe('unknown-team');
      expect(outcome.get('Away Team="\u00a0"')).toBe('unknown-team');
      // (a time and a field with no venue: the mapping step's own refusal, `unknown-venue`, made at staging)
      expect(outcome.get('Venue=""')).toBe('unknown-venue');
      expect(outcome.get('Venue and Field blank')).toBe('tbd');
      expect(outcome.get('Field=""')).toBe('tbd');
      expect(outcome.get('Start Time=""')).toBe('tbd');
      expect(outcome.get('Date=""')).toBe('bad-date');
      expect(outcome.get('Game ID=""')).toBe('ok');
      expect(outcome.get('Week=""')).toBe('ok');
      expect(outcome.get('a date 300 weeks on, no season end')).toBe('outside-season-window');
      expect(outcome.get('a Week of 256')).toBe('ok');
    });
  }

  it('core and the Edge mirror stage every row of the table alike', () => {
    for (const { name, row, season } of table) {
      const input = {
        headers: HEADERS,
        rows: [row],
        season: season ?? fixture.season,
        rowOffset: 0,
      };
      expect(JSON.parse(JSON.stringify(stagers[1][1](input))), name).toEqual(
        JSON.parse(JSON.stringify(stagers[0][1](input)))
      );
    }
  });
});
