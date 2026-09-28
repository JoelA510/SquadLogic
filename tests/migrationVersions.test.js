/**
 * PR-time static check on migration versions (scripts/ci/migrationVersions.mjs).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  checkAddedAfterBase,
  checkNames,
  listHead,
  versionOf,
} from '../scripts/ci/migrationVersions.mjs';

describe('migration versions: the real directory', () => {
  const files = listHead();

  it('examined the real migration set (meta-assertion)', () => {
    // 118 files on 2026-09-28; the set only grows.
    expect(files.length).toBeGreaterThanOrEqual(118);
    expect(files).toContain('20260924000000_practice_writer_prunes_superseded.sql');
  });

  it('is well named and has no duplicate versions', () => {
    expect(checkNames(files)).toEqual([]);
  });
});

describe('migration versions: names and uniqueness', () => {
  it('parses a version', () => {
    expect(versionOf('20260927000000_coach_practice_preferences.sql')).toBe('20260927000000');
    expect(versionOf('2026092700000_short.sql')).toBeNull();
    expect(versionOf('20260927000000-dash.sql')).toBeNull();
    expect(versionOf('20260927000000_x.sql.bak')).toBeNull();
  });

  it('reports a duplicate version, naming both files', () => {
    expect(checkNames(['20260101000000_a.sql', '20260101000000_b.sql'])).toEqual([
      'version 20260101000000 is used by 20260101000000_a.sql, 20260101000000_b.sql',
    ]);
  });

  it('reports a file the CLI would silently ignore', () => {
    expect(checkNames(['20260101000000_a.sql', 'notes.md'])).toHaveLength(1);
  });

  it('fails an empty directory rather than passing it', () => {
    expect(checkNames([])).toHaveLength(1);
  });
});

describe('migration versions: added files must follow the base', () => {
  const base = ['20260923000000_a.sql', '20260924000000_b.sql'];

  it('passes a file added above the latest on the base', () => {
    expect(checkAddedAfterBase(base, [...base, '20260927000000_c.sql'])).toEqual([]);
  });

  it('fails a file added below the latest on the base', () => {
    const errors = checkAddedAfterBase(base, [...base, '20260923120000_c.sql']);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/20260923120000_c\.sql.*not greater.*20260924000000/);
  });

  it('fails a file added AT the latest version (a renamed twin)', () => {
    expect(checkAddedAfterBase(base, [...base, '20260924000000_c.sql'])).toHaveLength(1);
  });

  it('does not re-judge files already on the base', () => {
    expect(checkAddedAfterBase(base, base)).toEqual([]);
  });

  it('fails when the base has no migrations to compare against', () => {
    expect(checkAddedAfterBase([], ['20260927000000_c.sql'])).toHaveLength(1);
  });
});

describe('migration versions: wired into CI', () => {
  it('runs in the Build & Test job, with the PR base on pull requests', () => {
    const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
    expect(ci).toMatch(/node scripts\/ci\/migrationVersions\.mjs --base "\$\{BASE_SHA\}"/);
  });
});
