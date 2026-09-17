/**
 * **Every pgTAP suite's `plan(N)` against the assertions it actually runs.**
 *
 * `supabase/tests/admin_update_field_blackout.sql` arrived from 8.4 gap A
 * declaring `plan(14)` over fifteen assertions, which pgTAP reports as
 * "Looks like you planned 14 tests but ran 15".
 *
 * **pgTAP is gated in CI, and this file does not exist because it is not.**
 * `.github/workflows/pgtap.yml` triggers on `supabase/migrations/**`,
 * `supabase/tests/**` and `supabase/config.toml`, starts a local Supabase and
 * runs `npm run test:db` -- `supabase test db`, every suite in the directory.
 * A PR that touches SQL at all therefore runs all forty-five, and a plan that
 * does not match would turn that job red before merge. Saying otherwise is
 * how a reader concludes pgTAP is ungated and skips it, and it is an error
 * this phase has already made once and recorded.
 *
 * What was missing is nearer and faster. NOTHING an agent runs before pushing
 * executes a pgTAP suite: not `npm run lint`, not `npm run test`, not
 * `npm run test:db:local`, and neither plant sweep. So the mismatch was
 * invisible to every local check, survived a full Definition of Done, and
 * would have been found only by a three-to-five-minute container-starting job
 * that fires on SQL paths after the push. This moves that to a millisecond
 * assertion in the fast suite -- and, because it parses text rather than
 * executing SQL, it holds in an environment with no Supabase CLI at all,
 * which is the environment the defect was actually found in.
 *
 * **Forty-four of the forty-five already agreed exactly, and that is the CI
 * job's doing rather than a coincidence.** The one that did not was the one
 * suite new in this PR -- it had never been through that gate, because it had
 * never been on a PR before. The gate works; it just works later than this.
 *
 * **A declared count is not an enforced one.** That is the rule this phase
 * keeps rediscovering, and a plan is a declared count in the most literal
 * sense: it is a number a human wrote next to a list they were supposed to
 * keep it in step with.
 *
 * This is a *static* check and says so. It cannot tell whether an assertion
 * passes -- only that the suite promises to run as many as it contains. A
 * suite whose assertions sit inside a loop or a `\if` would defeat it; none in
 * this repository does, and the floor assertions below fail loudly if the
 * parser stops seeing them.
 */

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SUITE_DIR = path.join(REPO_ROOT, 'supabase/tests');

/**
 * The pgTAP assertion functions used in this repository.
 *
 * Listed rather than matched by `SELECT \w+(`, because `SELECT plan(`,
 * `SELECT * FROM finish()` and every ordinary query in a suite would otherwise
 * be counted. A suite reaching for a function not in this list is caught by the
 * mismatch it produces, which is the right way round: an unknown assertion
 * makes the count too low and fails, rather than passing unnoticed.
 */
const ASSERTIONS = [
  'is',
  'isnt',
  'ok',
  'throws_ok',
  'lives_ok',
  'pass',
  'fail',
  'matches',
  'imatches',
  'alike',
  'cmp_ok',
  'results_eq',
  'set_eq',
  'bag_eq',
  'row_eq',
  'isa_ok',
  'has_table',
  'has_column',
  'col_is_pk',
];

const ASSERTION_RE = new RegExp(`^\\s*SELECT (?:${ASSERTIONS.join('|')})\\(`, 'gm');

/** @returns {Array<{file: string, planned: number, asserted: number}>} */
function suites() {
  return readdirSync(SUITE_DIR)
    .filter((entry) => entry.endsWith('.sql'))
    .sort()
    .map((entry) => {
      const source = readFileSync(path.join(SUITE_DIR, entry), 'utf8');
      const plan = source.match(/SELECT plan\((\d+)\)/);
      if (!plan) return null;
      return {
        file: `supabase/tests/${entry}`,
        planned: Number(plan[1]),
        asserted: (source.match(ASSERTION_RE) || []).length,
      };
    })
    .filter((suite) => suite !== null);
}

describe('pgTAP plans :: a declared count held to the assertions it covers', () => {
  it('found the suites, and reads a real number out of each', () => {
    // The meta-assertion. A parser that matched no files, or no `plan(`, would
    // make the comparison below pass over an empty list -- the vacuous green
    // this check exists because of.
    const found = suites();
    expect(found.length).toBeGreaterThanOrEqual(40);
    expect(found.map((s) => s.file)).toContain('supabase/tests/admin_update_field_blackout.sql');
    // Every suite plans at least one assertion and contains at least one.
    for (const suite of found) {
      expect(suite.planned, `${suite.file} plans zero tests`).toBeGreaterThan(0);
      expect(suite.asserted, `${suite.file} contains no assertion`).toBeGreaterThan(0);
    }
  });

  it('can tell a mismatch from a match', () => {
    // A positive control for the counter itself: the same regex over text that
    // holds three assertions must say three, and over prose about assertions
    // must say none. Without this, a counter that returned the planned number
    // would satisfy every comparison below.
    const three = ['SELECT is(1, 1);', 'SELECT throws_ok($$x$$);', '  SELECT ok(true);'].join('\n');
    expect((three.match(ASSERTION_RE) || []).length).toBe(3);
    expect(
      ('-- SELECT is( would be an assertion if it were not a comment'.match(ASSERTION_RE) || [])
        .length
    ).toBe(0);
  });

  it('holds every suite to its own plan', () => {
    const wrong = suites()
      .filter((suite) => suite.planned !== suite.asserted)
      .map((suite) => `${suite.file}: plan(${suite.planned}) over ${suite.asserted} assertions`);
    expect(wrong).toEqual([]);
  });
});
