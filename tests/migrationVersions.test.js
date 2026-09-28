/**
 * PR-time static check on migration versions (scripts/ci/migrationVersions.mjs).
 *
 * That script is the single owner of the version-uniqueness rule. The ledger
 * keys on the version alone, so two files sharing one cannot both be applied:
 * two open PRs picked `20260927000000` independently (#453 and #454), and
 * nothing would have said so until the ledger did, in production. This file
 * absorbed #454's `migrationVersionUnique.test.js`, which duplicated the rule.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  baseEntries,
  checkAgainstBase,
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

  it('reports a duplicate planted on a real version, naming both files', () => {
    // The check must be able to fail on the real set, not only on a toy list.
    const real = files[0];
    const version = versionOf(real);
    const planted = `${version}_planted_duplicate.sql`;
    expect(checkNames([...files, planted])).toEqual([
      `version ${version} is used by ${real}, ${planted}`,
    ]);
  });

  it('reads the committed tree with blob ids (meta-assertion)', () => {
    const head = baseEntries('HEAD');
    expect(head.length).toBeGreaterThanOrEqual(118);
    expect(head.every((e) => /^[0-9a-f]{40}$/.test(e.blob))).toBe(true);
    expect(checkAgainstBase(head, head)).toEqual([]);
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

describe('migration versions: the head against the base', () => {
  const e = (file, blob = 'x') => ({ file, blob });
  const base = [e('20260923000000_a.sql'), e('20260924000000_b.sql')];

  it('passes a version added above the latest on the base', () => {
    expect(checkAgainstBase(base, [...base, e('20260927000000_c.sql')])).toEqual([]);
  });

  it('fails a version added below the latest on the base', () => {
    const errors = checkAgainstBase(base, [...base, e('20260923120000_c.sql')]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/20260923120000_c\.sql.*not greater.*20260924000000/);
  });

  it('reports a renamed migration as a rename, not as an out-of-order addition', () => {
    const errors = checkAgainstBase(base, [base[0], e('20260924000000_b_renamed.sql')]);
    expect(errors).toEqual([
      '20260924000000_b.sql was renamed to 20260924000000_b_renamed.sql; applied migrations keep their name',
    ]);
  });

  it('fails an edit to an existing migration', () => {
    const errors = checkAgainstBase(base, [base[0], e('20260924000000_b.sql', 'y')]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/was edited/);
  });

  it('fails a removed migration', () => {
    expect(checkAgainstBase(base, [base[0]])).toEqual([
      '20260924000000_b.sql (version 20260924000000) was removed',
    ]);
  });

  it('passes an unchanged head', () => {
    expect(checkAgainstBase(base, base)).toEqual([]);
  });

  it('fails when the base has no migrations to compare against', () => {
    expect(checkAgainstBase([], [e('20260927000000_c.sql')])).toHaveLength(1);
  });
});

describe('migration versions: wired into CI', () => {
  it('runs in the Build & Test job, with the PR base on pull requests', () => {
    const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
    expect(ci).toMatch(/node scripts\/ci\/migrationVersions\.mjs --base "\$\{BASE_SHA\}"/);
  });
});
