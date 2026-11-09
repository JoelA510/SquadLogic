/**
 * The staged row of a games import (PR 5): `toStagedGameRow` is where a parsed row becomes the keys the SQL apply reads.
 * The keys equal the allowlist (`GAME_IMPORT_KEYS`, which `tests/importAllowlistParity.test.js` holds equal to what the
 * SQL reads), for a placed row and a TIME TBD row alike; a refused row has no payload and its reason; and every row of
 * the shipped fixture stages in the shape the SQL's own shape check accepts.
 */
import { describe, expect, it } from 'vitest';
import { GAME_IMPORT_KEYS } from '../frontend/src/utils/importAllowlist.js';
import {
  GAME_STAGED_KEYS,
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
