/**
 * **The freeze on `field_blackout_windows`, held to the source tree.**
 *
 * 8.4 PR 2 leaves two blackout tables with disjoint producers:
 * `field_blackouts` for admin-authored closures, `field_blackout_windows` owned
 * solely by `finalize_field_availability_import_job`. The freeze is the half
 * that keeps them disjoint, and a freeze nothing checks is a sentence in a
 * `COMMENT ON TABLE`.
 *
 * **Derived, not written down.** A literal list of files allowed to write the
 * frozen table, compared against itself, is the exact defect PR 1's review
 * found four separate times -- most plainly in `productionConsumersOf()`, which
 * was a hand-written array asserted against itself while a real production
 * consumer sat missing from it. So the writer set is *scanned out of the source
 * tree* and the literal survives only as the expected value the scan is
 * compared against.
 *
 * The same scan covers `field_blackouts`: the freeze is only meaningful if the
 * new table's writers are also exactly who they should be, otherwise "nothing
 * new writes the old table" is satisfied by writing neither.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, it, expect } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Roots holding first-party source that could write a table.
 *
 * `docs` is in the list because `docs/sql/` holds 104 SQL files -- the reverts
 * and smokes every migration in this repo is required to ship with -- and they
 * are as capable of an `INSERT INTO` as a migration is. Leaving it out made the
 * "derived, not written down" claim slightly false: the walk was the source
 * tree minus a directory full of SQL, which is a curated subset wearing a
 * scan's clothes. It is scanned, and the one file in it that writes either
 * table is named in the expected sets below like any other writer.
 */
const SCAN_ROOTS = Object.freeze(['packages', 'frontend', 'supabase', 'scripts', 'tests', 'docs']);

const SCANNED_EXTENSIONS = Object.freeze(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.sql']);

const SKIPPED_DIRECTORIES = Object.freeze([
  'node_modules',
  'dist',
  '.features-gen',
  '.features-gen-local',
  'coverage',
]);

/**
 * The floor a healthy scan must clear.
 *
 * A walk that found nothing would make every "no unexpected writer" assertion
 * below pass by looking at zero files. Set well under the real count so it
 * fails on a broken walk rather than on ordinary growth.
 */
const MIN_FILES_SCANNED = 200;

/** @returns {string[]} every scannable file, as `/`-separated repo-relative paths */
function scannableFiles() {
  /** @type {string[]} */
  const found = [];
  const walk = (absolute) => {
    for (const entry of readdirSync(absolute).sort()) {
      if (SKIPPED_DIRECTORIES.includes(entry)) continue;
      const full = path.join(absolute, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (SCANNED_EXTENSIONS.includes(path.extname(entry))) {
        found.push(path.relative(REPO_ROOT, full).split(path.sep).join('/'));
      }
    }
  };
  for (const root of SCAN_ROOTS) {
    const absolute = path.join(REPO_ROOT, root);
    try {
      if (statSync(absolute).isDirectory()) walk(absolute);
    } catch {
      // A root that does not exist is not an error; one that exists and cannot
      // be read throws out of `walk` rather than being skipped.
    }
  }
  return found;
}

const FILES = scannableFiles();
const CONTENTS = new Map(
  FILES.map((file) => [file, readFileSync(path.join(REPO_ROOT, file), 'utf8')])
);

/**
 * Remove SQL and JS comments.
 *
 * Both tables are discussed at length in the migrations' own headers and in
 * this file, and counting prose as a write would make the audit report its own
 * subject matter. Crude in the safe direction: it can only *under* report, and
 * the exactness assertions below then fail on a missing file rather than pass
 * quietly.
 *
 * @param {string} source
 * @returns {string}
 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/^\s*--[^\n]*/gm, ' ');
}

/**
 * Files that write `table`, by the shapes a write takes in this repo.
 *
 * SQL: `INSERT INTO`, `UPDATE`, `DELETE FROM`.
 * PostgREST/mock: `.from('table')` followed by `.insert`/`.update`/`.delete`
 * anywhere in the same file, and direct `db.<table>` mutation in the mock
 * client. The mock is deliberately in scope -- it is the client the whole E2E
 * suite runs against, so a write there is a write.
 *
 * @param {string} table
 * @returns {string[]}
 */
function writersOf(table) {
  const sqlWrite = new RegExp(
    `(?:INSERT\\s+INTO|UPDATE|DELETE\\s+FROM)\\s+(?:public\\.)?${table}\\b`,
    'i'
  );
  const jsFrom = new RegExp(`\\.from\\(\\s*['"\`]${table}['"\`]\\s*\\)`);
  const jsMutate = /\.(insert|update|upsert|delete)\s*\(/;
  const mockMutate = new RegExp(`db\\.${table}\\s*(?:\\.(?:push|splice)|=)`);

  return FILES.filter((file) => {
    const code = stripComments(/** @type {string} */ (CONTENTS.get(file)));
    if (sqlWrite.test(code)) return true;
    if (mockMutate.test(code)) return true;
    return jsFrom.test(code) && jsMutate.test(code);
  }).sort();
}

describe('blackout freeze :: the scan examined the repository', () => {
  it('walks the source roots recursively rather than a list in this file', () => {
    expect(FILES.length).toBeGreaterThanOrEqual(MIN_FILES_SCANNED);
    expect(FILES.some((file) => file.split('/').length === 2)).toBe(true);
    expect(FILES.some((file) => file.split('/').length > 3)).toBe(true);
    // Both migrations are in the walked set, or every assertion below is about
    // a repository that does not contain the thing being frozen.
    expect(FILES).toContain('supabase/migrations/20260906000100_field_blackouts.sql');
    expect(FILES).toContain('supabase/migrations/20260522120000_field_availability_phase1.sql');
    // ... and so is the `docs/sql` root, whose absence is what made the walk a
    // subset. A root that silently vanishes takes its writers with it.
    expect(FILES).toContain('docs/sql/20260906000100_smoke.sql');
  });

  it('can see a writer when there is one', () => {
    // A positive control for the matcher itself. `game_slots` is written from
    // several places; a matcher that silently matched nothing would make every
    // freeze assertion below trivially exact.
    expect(writersOf('game_slots').length).toBeGreaterThan(1);
    // ... and a table nothing writes comes back empty, so the matcher is
    // discriminating rather than matching everything.
    expect(writersOf('a_table_that_does_not_exist_anywhere')).toEqual([]);
  });

  it('does not count a mention in a comment as a write', () => {
    // This file names both tables constantly and writes neither.
    expect(writersOf('field_blackout_windows')).not.toContain('tests/fieldBlackoutFreeze.test.js');
    expect(writersOf('field_blackouts')).not.toContain('tests/fieldBlackoutFreeze.test.js');
  });
});

describe('blackout freeze :: who may write each table is a checked list', () => {
  /**
   * The import path, and nothing else.
   *
   * FOUR migrations now define `finalize_field_availability_import_job` in
   * sequence -- the live definition is the last -- and the mock client mirrors
   * it for the E2E suite. All five are the import path.
   *
   * The sixth is M2's own smoke, which seeds a window so it can assert what
   * `field_closures` reports for the import arm. It is a writer by the
   * matcher's definition and is listed rather than excepted: an operator script
   * that runs against a database is exactly the kind of writer a freeze wants
   * visible. It is not a producer -- nothing it writes outlives the `DELETE
   * FROM public.organizations` that ends the block.
   *
   * The seventh is 20260908000000's REVERT, which carries the pre-fix body
   * verbatim in order to restore it. It is listed for the same reason as the
   * smoke and for one more: a revert is the one artefact that puts an old
   * writer back, so a freeze that could not see reverts would be blind to
   * exactly the change that undoes it.
   *
   * **This list did its job on the change that added to it.** 20260908000000
   * re-issues the import path's body, so both the migration and its revert
   * became writers, and this test failed until they were named here -- which is
   * what "who may write this table is a checked list" is for. Adding a file
   * here is a decision to be argued, not a formality: the freeze says
   * field_blackout_windows is owned SOLELY by the import path, and every entry
   * below either is that path or is a script that seeds it to check it.
   */
  const EXPECTED_FROZEN_WRITERS = Object.freeze([
    'docs/sql/20260906000100_smoke.sql',
    'docs/sql/20260908000000_revert.sql',
    'frontend/src/lib/mockSupabaseClient.js',
    'supabase/migrations/20260522120000_field_availability_phase1.sql',
    'supabase/migrations/20260522153000_field_availability_finalize_hardening.sql',
    'supabase/migrations/20260602000000_field_availability_finalize_applied_payload_fix.sql',
    'supabase/migrations/20260908000000_field_availability_profile_field_resolution.sql',
  ]);

  it('holds field_blackout_windows to the import path, in both directions', () => {
    // Exact, not a subset: a new writer fails, and so does a listed file that
    // stopped writing. A list that only catches additions goes quietly wrong
    // the moment something is deleted.
    expect(writersOf('field_blackout_windows')).toEqual([...EXPECTED_FROZEN_WRITERS]);
  });

  it('holds field_blackouts to its own migration and the mock client', () => {
    // The other half. "Nothing new writes the frozen table" is satisfied by
    // writing neither, so the new table's writers are pinned too.
    // The fourth entry is the pgTAP RLS test, which seeds one blackout per org
    // as the superuser so its "who can READ this" assertions are about the
    // policy rather than about who managed to write the row. Listed rather than
    // excepted, like the smoke: a test that writes the table is a writer by the
    // matcher's definition, and the freeze wants every one of them visible. It
    // is not a producer -- the whole file runs inside a ROLLBACK.
    expect(writersOf('field_blackouts')).toEqual([
      'docs/sql/20260906000100_smoke.sql',
      'frontend/src/lib/mockSupabaseClient.js',
      'supabase/migrations/20260906000100_field_blackouts.sql',
      'supabase/tests/rls_field_blackouts.sql',
    ]);
  });

  it('keeps the two writer sets disjoint apart from the mock client', () => {
    // The claim the COMMENT ON TABLE makes, checked rather than read. Two files
    // are in both sets and neither is a producer: the mock client stands in for
    // the database itself, and M2's smoke seeds both arms so it can assert what
    // the single reader unions. Exact, so a genuine third writer of both -- the
    // thing the freeze exists to prevent -- fails here.
    const frozen = new Set(writersOf('field_blackout_windows'));
    const shared = writersOf('field_blackouts').filter((file) => frozen.has(file));
    expect(shared).toEqual([
      'docs/sql/20260906000100_smoke.sql',
      'frontend/src/lib/mockSupabaseClient.js',
    ]);
  });

  it('states the freeze on the table itself, so a reader of the schema sees it', () => {
    const migration = readFileSync(
      path.join(REPO_ROOT, 'supabase/migrations/20260906000100_field_blackouts.sql'),
      'utf8'
    );
    expect(migration).toMatch(/COMMENT ON TABLE public\.field_blackout_windows IS/);
    expect(migration).toContain('FROZEN as of 20260906000100');
    // The comment names this file, so a reader who doubts the freeze can find
    // the thing that enforces it.
    expect(migration).toContain('tests/fieldBlackoutFreeze.test.js');
  });
});
