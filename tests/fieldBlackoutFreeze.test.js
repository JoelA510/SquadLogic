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

// **`.sh` is here because a writer landed in one.** `scripts/dbharness/run.sh`
// seeds a field_blackout_windows row so 20260908000000's revert has an orphan
// to count, and the scan could not see it -- so "who may write this table is a
// checked list, scanned out of the source tree" was false in the same PR that
// added the writer. An extension list is a filter on the universe, and a
// universe that cannot contain the new writer is the set-derived-from-the-thing
// -being-checked defect wearing different clothes.
//
// **`.py` is here for the same reason, and the same way.** The scenario
// generator `scripts/dbharness/scenarios.py` emits an `INSERT INTO
// public.field_blackout_windows` so 8.4 gap A's frozen-refusal case has a real
// window to be refused on -- and the walk could not see it, so "who may write
// this table is a checked list, scanned out of the source tree" was false in
// the same PR that added the writer. The second time exactly that happened, and
// the `.sh` entry above is the first. The `#` rule that `.sh` needed already
// covers Python's line comments.
const SCANNED_EXTENSIONS = Object.freeze([
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.mjs',
  '.cjs',
  '.sql',
  '.sh',
  '.py',
]);

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
 * Remove SQL, JS and SHELL comments.
 *
 * Both tables are discussed at length in the migrations' own headers and in
 * this file, and counting prose as a write would make the audit report its own
 * subject matter. Crude in the safe direction: it can only *under* report, and
 * the exactness assertions below then fail on a missing file rather than pass
 * quietly.
 *
 * **The shell rule arrived with `.sh` in SCANNED_EXTENSIONS and had to.**
 * Adding that extension without it broke the direction stated above: `#` was
 * not stripped, so a comment in `run.sh` or `prove.sh` explaining a seed --
 * and those files explain everything they do -- registered as a write and the
 * helper began OVER-reporting. Over-reporting is the unsafe direction here,
 * because the exact-match assertion then pushes the next person to add the
 * file to the expected list, which would mask a real write in it later.
 * Only `#` at the start of a line is stripped, matching the `--` rule, so a
 * `#` inside a string or a JS private field is left alone.
 *
 * @param {string} source
 * @returns {string}
 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/^\s*--[^\n]*/gm, ' ')
    .replace(/^\s*#[^\n]*/gm, ' ');
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

  it('strips shell comments, now that shell scripts are scanned', () => {
    // The direction the helper promises is under-reporting. Adding `.sh`
    // without a `#` rule reversed it: the harness scripts explain every seed
    // they perform, so a sentence about one counted as one.
    //
    // **The write phrase is composed rather than written out**, because a
    // literal one in this file makes THIS file match `writersOf` and the
    // exactness assertions below then report the audit as a writer of its own
    // subject -- which is what happened on the first attempt at this test.
    const write = ['DELETE', 'FROM', 'public.field_blackouts'].join(' ');
    expect(stripComments(`# ${write} is what the revert does\necho hi`)).not.toMatch(/DELETE/);
    // ... and a real statement in the same file still counts.
    expect(stripComments(`# explains the seed below\npsql -c '${write}'`)).toMatch(
      new RegExp(write.replace('.', '\\.'))
    );
    // A `#` that is not a line comment is left alone, so the rule cannot eat
    // code: JS private fields and anything inside a string survive.
    expect(stripComments('const x = "a#b";')).toMatch(/a#b/);
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
   * The seventh is the local harness, which seeds one window so
   * 20260908000000's revert has an orphaned closure to count -- the revert
   * reports what the database already holds, and on a freshly migrated database
   * that is nothing, so the count would prove only that the code parses. Same
   * reasoning as the smoke: a script that seeds a table to check it is a writer
   * the freeze wants visible, and nothing it writes outlives the run.
   *
   * The eighth is 20260908000000's REVERT, which carries the pre-fix body
   * verbatim in order to restore it. It is listed for the same reason as the
   * smoke and for one more: a revert is the one artefact that puts an old
   * writer back, so a freeze that could not see reverts would be blind to
   * exactly the change that undoes it.
   *
   * The last three arrive with LIVE-3, and all three seed a window in order to
   * CHECK something about it rather than to produce one. 20260909000000 makes
   * `field_availability_profiles.field_id` ON DELETE CASCADE, so a window now
   * dies with its profile when the ground is deleted -- and an assertion that
   * a window is gone is worth nothing unless a window was there. Each of the
   * three seeds exactly one: 20260909000000's smoke, its pgTAP twin (inside a
   * ROLLBACK), and the mock-client test of the same delete. Listed rather than
   * excepted, like the smoke above: the freeze wants every writer visible, and
   * "it is only a test" is the argument that would let the next real writer in.
   *
   * **The freeze is still exactly what it was.** None of the three writes a
   * window that outlives its own transaction or test run, and none of them is
   * a PRODUCER: no code path a user can reach gained the ability to create a
   * blackout window in this PR.
   *
   * **This list did its job on the change that added to it.** 20260908000000
   * re-issues the import path's body, so both the migration and its revert
   * became writers, and this test failed until they were named here -- which is
   * what "who may write this table is a checked list" is for. Adding a file
   * here is a decision to be argued, not a formality: the freeze says
   * field_blackout_windows is owned SOLELY by the import path, and every entry
   * below either is that path or is a script that seeds it to check it.
   */
  //
  // **Four arrive with 8.4 gap A, and all four SEED a window to be refused on.**
  // `admin_update_field_blackout` must refuse an id belonging to the frozen
  // table by name rather than as "not found", and an assertion that a refusal
  // happened is worth nothing unless there was a real window to refuse. Its
  // smoke, its pgTAP twin (inside a ROLLBACK), the scenario generator and the
  // mock-contract suite each seed exactly one or two. The fifth is the shared
  // scenario runner, for the same case on the mock arm.
  //
  // **None of them is a producer, and the new RPC is not one either**: it takes
  // a `field_blackouts` id and its only interaction with the frozen table is a
  // `SELECT 1 ... WHERE id = ...` that decides which refusal to raise. No code
  // path a user can reach gained the ability to create or change a window in
  // this PR, which is the claim the freeze makes.
  const EXPECTED_FROZEN_WRITERS = Object.freeze([
    'docs/sql/20260906000100_smoke.sql',
    'docs/sql/20260908000000_revert.sql',
    'docs/sql/20260909000000_smoke.sql',
    'docs/sql/20260910000000_smoke.sql',
    'frontend/src/lib/mockSupabaseClient.js',
    'scripts/dbharness/run.sh',
    'scripts/dbharness/scenarios.py',
    'supabase/migrations/20260522120000_field_availability_phase1.sql',
    'supabase/migrations/20260522153000_field_availability_finalize_hardening.sql',
    'supabase/migrations/20260602000000_field_availability_finalize_applied_payload_fix.sql',
    'supabase/migrations/20260908000000_field_availability_profile_field_resolution.sql',
    'supabase/tests/admin_update_field_blackout.sql',
    'supabase/tests/field_import_rollback_booking_guard.sql',
    'tests/fieldBlackoutMockContract.test.js',
    'tests/fieldDeleteGuard.test.js',
    'tests/fieldLifecycleScenarios.test.js',
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
    //
    // 8.4 gap A adds three: the migration that adds
    // `admin_update_field_blackout` (an `UPDATE`, which is what an edit in
    // place IS), its pgTAP suite, and the local harness, which seeds two
    // admin-authored windows so 20260910000000's revert has something to count
    // rather than reporting a reassuring zero. Its smoke is NOT here: it goes
    // through the create RPC rather than writing the table, which is the shape
    // this PR's own rule asks of a test.
    expect(writersOf('field_blackouts')).toEqual([
      'docs/sql/20260906000100_smoke.sql',
      'frontend/src/lib/mockSupabaseClient.js',
      'scripts/dbharness/run.sh',
      'supabase/migrations/20260906000100_field_blackouts.sql',
      'supabase/migrations/20260910000000_admin_update_field_blackout.sql',
      'supabase/tests/admin_update_field_blackout.sql',
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
    //
    // 8.4 gap A adds two more, and neither is a producer either: the local
    // harness seeds both tables so 20260910000000's revert has all three of its
    // costs to count, and that revert's pgTAP suite seeds both so it can prove
    // the two refusals stay two answers. A genuine third PRODUCER of both --
    // the thing the freeze exists to prevent -- still fails here.
    const shared = writersOf('field_blackouts').filter((file) => frozen.has(file));
    expect(shared).toEqual([
      'docs/sql/20260906000100_smoke.sql',
      'frontend/src/lib/mockSupabaseClient.js',
      'scripts/dbharness/run.sh',
      'supabase/tests/admin_update_field_blackout.sql',
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
