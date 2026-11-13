/**
 * The staged row of a practice import (PR 10 of the schedule expansion): `toStagedPracticeRow` is where a parsed practice
 * row becomes the keys `apply_practice_import_job` reads. The keys are the allowlist (`PRACTICE_SCHEDULE_IMPORT_KEYS`,
 * which `tests/importAllowlistParity.test.js` holds equal to what the SQL reads), for a placement, an open slot and a hold
 * alike; a refused row has no payload and its reason; the decision keys are core's, so the SQL matches keys by equality
 * and never normalises a label; and every row of the shipped fixture stages in the shape the SQL's own check accepts.
 */
import { describe, expect, it } from 'vitest';
import { PRACTICE_SCHEDULE_IMPORT_KEYS } from '../frontend/src/utils/importAllowlist.js';
import {
  PRACTICE_IMPORT_ROW_REFUSALS,
  PRACTICE_STAGED_FLAGS,
  PRACTICE_STAGED_KEYS,
  parsePracticeRows,
  practiceDivisionDecisionKey,
  practiceFieldDecisionKey,
  practiceLocationDecisionKey,
  practiceSubunitDecisionKey,
  practiceTeamDecisionKey,
  toStagedPracticeRow,
} from '../packages/core/src/practiceImport/index.js';
import { loadPracticeFixture } from './helpers/practiceFixtureLoad.js';

const fixture = loadPracticeFixture();
const parsed = parsePracticeRows({
  headers: fixture.schedule.headers,
  rows: fixture.schedule.rows,
  season: fixture.season,
});
const invalid = parsePracticeRows({
  headers: fixture.invalid.headers,
  rows: fixture.invalid.rows,
  season: fixture.invalidSeason,
});

// The shape check of `apply_practice_import_job` (migration 20261123010000), as regular expressions.
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const CLOCK = /^\d{2}:\d{2}$/;
const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

/** @param {Record<string, any>} p the SQL's shape check, in JavaScript (what a staged row must be or the apply refuses) */
function sqlAccepts(p) {
  if (!['placement', 'open', 'hold'].includes(p.status)) return false;
  if (typeof p.row_key !== 'string' || p.row_key === '') return false;
  if (!DAYS.includes(p.day) || !CLOCK.test(p.start_time) || !CLOCK.test(p.end_time)) return false;
  if (!(p.end_time > p.start_time)) return false;
  if (!DATE.test(p.valid_from) || !DATE.test(p.valid_until) || p.valid_until < p.valid_from)
    return false;
  if (p.status !== 'hold' && !(Number.isInteger(p.capacity) && p.capacity >= 1)) return false;
  if (!p.location || !p.location_key || !p.field || !p.field_key) return false;
  if ((p.subunit === '') !== (p.subunit_key === '')) return false;
  if (p.status === 'placement' && (!p.division_key || !p.team_key || !p.team || !p.division))
    return false;
  if (p.status !== 'placement' && (p.team !== '' || p.team_key !== '')) return false;
  if (!Array.isArray(p.flags) || p.flags.some((f) => !PRACTICE_STAGED_FLAGS.includes(f)))
    return false;
  return true;
}

describe('a staged practice row carries the allowlisted keys and nothing else', () => {
  it('the constant is the allowlist, in order', () => {
    expect([...PRACTICE_STAGED_KEYS]).toEqual([...PRACTICE_SCHEDULE_IMPORT_KEYS]);
  });

  it.each(['placement', 'open', 'hold'])('a %s row', (status) => {
    const row = parsed.rows.find((r) => r.status === status);
    expect(row, status).toBeTruthy();
    const staged = toStagedPracticeRow(/** @type {any} */ (row));
    expect(Object.keys(staged.normalized_payload ?? {})).toEqual([...PRACTICE_STAGED_KEYS]);
    expect(staged.validation_errors).toEqual([]);
    expect(staged.source_row_number).toBe(/** @type {any} */ (row).rowNumber);
    expect(staged.normalized_payload?.status).toBe(status);
  });

  it('carries core decision keys beside the labels, so the SQL never normalises a label', () => {
    const row = /** @type {any} */ (parsed.rows.find((r) => r.status === 'placement' && r.subunitLabel));
    const p = /** @type {any} */ (toStagedPracticeRow(row).normalized_payload);
    expect(p.division_key).toBe(practiceDivisionDecisionKey(row.divisionLabel));
    expect(p.location_key).toBe(practiceLocationDecisionKey(row.locationLabel));
    expect(p.field_key).toBe(practiceFieldDecisionKey(row.locationLabel, row.fieldLabel));
    expect(p.subunit_key).toBe(
      practiceSubunitDecisionKey(row.locationLabel, row.fieldLabel, row.subunitLabel)
    );
    expect(p.team_key).toBe(practiceTeamDecisionKey(row.divisionLabel, row.teamLabel));
  });

  it('a whole-field row has an empty subunit and an empty subunit key (never a key of a blank label)', () => {
    const row = /** @type {any} */ (parsed.rows.find((r) => r.status === 'placement' && !r.subunitLabel));
    expect(row).toBeTruthy();
    const p = /** @type {any} */ (toStagedPracticeRow(row).normalized_payload);
    expect(p.subunit).toBe('');
    expect(p.subunit_key).toBe('');
  });

  it('an open slot and a hold carry no team and no team key', () => {
    for (const status of ['open', 'hold']) {
      const row = /** @type {any} */ (parsed.rows.find((r) => r.status === status));
      const p = /** @type {any} */ (toStagedPracticeRow(row).normalized_payload);
      expect(p.team, status).toBe('');
      expect(p.team_key, status).toBe('');
    }
  });

  it('a refused row is staged with no payload and its reason', () => {
    const refused = invalid.rows.filter((r) => r.status === 'refused');
    expect(refused.length).toBeGreaterThan(5);
    for (const row of refused) {
      const staged = toStagedPracticeRow(/** @type {any} */ (row));
      expect(staged.normalized_payload).toBeNull();
      expect(staged.validation_errors).toHaveLength(1);
      expect(PRACTICE_IMPORT_ROW_REFUSALS).toContain(staged.validation_errors[0].code);
    }
  });

  it('stages only the flags the SQL knows (the parse flag division-not-reserved)', () => {
    expect([...PRACTICE_STAGED_FLAGS]).toEqual(['division-not-reserved']);
    const flagged = /** @type {any} */ (
      invalid.rows.find((r) => r.flags?.some((f) => f.code === 'division-not-reserved'))
    );
    expect(flagged).toBeTruthy();
    expect(toStagedPracticeRow(flagged).normalized_payload?.flags).toEqual(['division-not-reserved']);
  });
});

describe('every row of the fixtures stages in the shape the SQL accepts', () => {
  it('the schedule: every accepted row passes the shape check', () => {
    const staged = parsed.rows.map((r) => toStagedPracticeRow(/** @type {any} */ (r)));
    const accepted = staged.filter((s) => s.normalized_payload !== null);
    expect(accepted.length).toBe(710);
    const failing = accepted.filter((s) => !sqlAccepts(/** @type {any} */ (s.normalized_payload)));
    expect(failing.map((s) => s.source_row_number)).toEqual([]);
  });

  it('the invalid file: every row is either refused with a closed reason or passes the shape check', () => {
    for (const r of invalid.rows) {
      const s = toStagedPracticeRow(/** @type {any} */ (r));
      if (s.normalized_payload === null) continue;
      expect(sqlAccepts(/** @type {any} */ (s.normalized_payload)), `row ${r.rowNumber}`).toBe(true);
    }
  });

  it('PLANT: the shape check refuses a row with a team on an open slot, and one with an unknown flag', () => {
    const row = /** @type {any} */ (parsed.rows.find((r) => r.status === 'open'));
    const p = /** @type {any} */ (toStagedPracticeRow(row).normalized_payload);
    expect(sqlAccepts(p)).toBe(true);
    expect(sqlAccepts({ ...p, team: 'X', team_key: 'x' })).toBe(false);
    expect(sqlAccepts({ ...p, flags: ['capacity'] })).toBe(false);
  });
});
