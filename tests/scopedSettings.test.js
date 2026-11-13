/**
 * F11-4a task A3 (docs/changes/2026-11-13-settings-scope.md): the core twin of the settings cascade. The precedence over
 * every combination is held to the database by tests/scopedSettingsParity.test.js; this file holds what the parity
 * cannot see: which level a value came from, how rows are read into levels, the value checks the setter makes, and an
 * unknown key.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  canonicalScopedValue,
  compareCodePoints,
  isValidScopedValue,
  resolveScopedSetting,
  scopedLevelsFor,
  STANDINGS_COUNT_OUTSIDE_KEY,
} from '../packages/core/src/scopedSettings.js';

const KEY = STANDINGS_COUNT_OUTSIDE_KEY;

describe('resolveScopedSetting :: the source of a value', () => {
  it('names the level each value came from, and the default when none is set', () => {
    expect(
      resolveScopedSetting({ organization: true, program: false, division: true }, KEY)
    ).toEqual({
      value: true,
      source: 'division',
    });
    expect(resolveScopedSetting({ organization: true, program: false }, KEY)).toEqual({
      value: false,
      source: 'program',
    });
    expect(resolveScopedSetting({ organization: true }, KEY)).toEqual({
      value: true,
      source: 'organization',
    });
    expect(resolveScopedSetting({}, KEY)).toEqual({ value: false, source: 'default' });
  });

  it('an explicit false is a value, not "unset"', () => {
    expect(resolveScopedSetting({ organization: true, division: false }, KEY)).toEqual({
      value: false,
      source: 'division',
    });
  });

  it('an unknown key throws, as the database refuses it', () => {
    expect(() => resolveScopedSetting({}, 'no_such_setting')).toThrow(/unknown setting/);
  });
});

describe('scopedLevelsFor :: rows into levels', () => {
  const rows = [
    { organization_id: 'o1', program_id: null, division_id: null, key: KEY, value: true },
    { organization_id: 'o1', program_id: 'p1', division_id: null, key: KEY, value: false },
    { organization_id: 'o1', program_id: null, division_id: 'd1', key: KEY, value: true },
    { organization_id: 'o2', program_id: null, division_id: null, key: KEY, value: false },
    { organization_id: 'o1', program_id: null, division_id: 'd9', key: 'other_key', value: true },
  ];

  it('reads each level of the division, its program and its organization', () => {
    expect(
      scopedLevelsFor(rows, { organizationId: 'o1', programId: 'p1', divisionId: 'd1' }, KEY)
    ).toEqual({ division: true, program: false, organization: true });
  });

  it('a division in the default program has no program level; another organization’s row is not read', () => {
    expect(
      scopedLevelsFor(
        rows,
        { organizationId: 'o1', programId: 'p1', programIsDefault: true, divisionId: 'd2' },
        KEY
      )
    ).toEqual({ division: undefined, program: undefined, organization: true });
    expect(
      scopedLevelsFor(rows, { organizationId: 'o3', programId: null, divisionId: 'd1' }, KEY)
        .organization
    ).toBeUndefined();
  });
});

describe('isValidScopedValue :: what the setter accepts', () => {
  it('a boolean key takes a boolean only', () => {
    expect(isValidScopedValue(KEY, true)).toBe(true);
    expect(isValidScopedValue(KEY, false)).toBe(true);
    expect(isValidScopedValue(KEY, 'true')).toBe(false);
    expect(isValidScopedValue(KEY, null)).toBe(false);
  });
});

describe('canonicalScopedValue :: a text set has one spelling, the database’s (COLLATE "C")', () => {
  // The registry has no text-set key yet; supabase/tests/scoped_settings.sql (6b) makes one for its test only, with the
  // same allowed values, and stores the same input. Its expected text is required here, so the two sides cannot drift.
  const PGTAP = readFileSync(
    path.join(process.cwd(), 'supabase/tests/scoped_settings.sql'),
    'utf8'
  );
  const input = ['𝒜', 'ｚ', 'é', 'a', 'B'];

  it('sorts by code point, as PostgreSQL’s C collation orders UTF-8 text', () => {
    expect(['𝒜', 'ｚ', 'é', 'a', 'B'].sort(compareCodePoints)).toEqual(['B', 'a', 'é', 'ｚ', '𝒜']);
    const stored = JSON.stringify(['B', 'a', 'é', 'ｚ', '𝒜']).replace(/","/g, '", "');
    expect(PGTAP).toContain(`new=${stored}', 'a text set is stored in code point order'`);
  });

  it('control: the default sort orders the astral letter before the fullwidth one, so it would differ', () => {
    expect([...input].sort()).not.toEqual([...input].sort(compareCodePoints));
  });

  it('a boolean is returned as it is', () => {
    expect(canonicalScopedValue(KEY, true)).toBe(true);
  });
});
