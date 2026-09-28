/**
 * Every migration's version prefix must be unique.
 *
 * The Supabase migration ledger keys on the version (the digits before the
 * first `_`), so two files sharing one cannot both be applied: the second is
 * either skipped as already applied or refused, depending on the tool. Two
 * open PRs picked `20260927000000` independently (#453 and #454); nothing
 * would have said so until the ledger did, in production.
 */
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'supabase',
  'migrations'
);

/** @param {string[]} names @returns {Record<string, string[]>} versions used by more than one file */
function duplicateVersions(names) {
  /** @type {Record<string, string[]>} */
  const byVersion = {};
  for (const name of names) {
    if (!name.endsWith('.sql')) continue;
    const version = name.split('_')[0];
    (byVersion[version] ||= []).push(name);
  }
  return Object.fromEntries(Object.entries(byVersion).filter(([, files]) => files.length > 1));
}

describe('supabase/migrations version prefixes', () => {
  const names = readdirSync(MIGRATIONS_DIR);

  it('examines the real migration set, not an empty or moved directory', () => {
    // Meta-assertion: a wrong path or glob would find nothing and pass below.
    expect(names.filter((n) => n.endsWith('.sql')).length).toBeGreaterThanOrEqual(100);
  });

  it('gives every migration its own version', () => {
    expect(duplicateVersions(names)).toEqual({});
  });

  it('reports a planted duplicate, naming both files', () => {
    // The check itself must be able to fail: plant a second file on a real version.
    const real = names.find((n) => n.endsWith('.sql'));
    const planted = `${real.split('_')[0]}_planted_duplicate.sql`;
    expect(duplicateVersions([...names, planted])).toEqual({
      [real.split('_')[0]]: [real, planted],
    });
  });
});
