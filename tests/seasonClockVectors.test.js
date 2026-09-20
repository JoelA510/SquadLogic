/**
 * The JS arm of the season clock's cross-arm drift check.
 *
 * There are two season clocks. `packages/core/src/timing/seasonClock.js` is the
 * canonical one; `supabase/functions/_shared/timing/seasonClock.ts` is a
 * Deno/TS mirror, because an Edge Function cannot import `packages/core` (see
 * that file's header for why). Twin-arm half-application is this repository's
 * most recurrent defect family, so the mirror ships with the check the earlier
 * mirrors lacked: one vector table, read by both arms.
 *
 * This file is one of the two readers. The other is
 * `supabase/functions/_shared/tests/season-clock_test.ts`, run by the
 * `deno-mirror-tests` CI job. **A vector table only one side reads is not a
 * cross-check**, so this file asserts the other reader exists and names the
 * same table, and that file asserts the same about this one. Delete either and
 * both go red.
 *
 * Both arms run here as well as in their own runtime: Vitest transpiles the
 * `.ts` mirror perfectly well, and `npm run test` is what everyone runs, so
 * drift should not have to wait for a CI job most contributors never run
 * locally. The Deno job is still the one that proves the mirror behaves under
 * the runtime it actually ships to -- Deno carries its own ICU build, and the
 * whole table is timezone data.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { resolveZonedInstant as resolveJs } from '../packages/core/src/timing/seasonClock.js';
import { resolveZonedInstant as resolveTs } from '../supabase/functions/_shared/timing/seasonClock.ts';

const VECTORS_PATH = 'supabase/functions/_shared/timing/seasonClock.vectors.json';
const SIBLING_RUNNER_PATH = 'supabase/functions/_shared/tests/season-clock_test.ts';
const CI_WORKFLOW_PATH = '.github/workflows/ci.yml';
/**
 * The Deno job's runner. It used to be the workflow itself, naming each test
 * file: this check asserted the workflow contained `SIBLING_RUNNER_PATH`,
 * because a file the list omitted never ran. That list was the defect -- it
 * silently skipped `scoring-engine_test.ts` for months -- so the job now
 * discovers its files and this check follows it there. The guarantee is the
 * stronger one: not "this one path is named" but "the directory it lives in is
 * discovered, and nothing can be dropped by omission".
 */
const DENO_RUNNER_PATH = 'scripts/deno-mirror-tests.sh';

/**
 * Vitest is configured at the repository root, so `process.cwd()` is it. The
 * `package.json` check below is not decoration: a wrong root would make every
 * `readFileSync` throw somewhere less legible than here.
 */
const REPO_ROOT = process.cwd();
const fromRoot = (/** @type {string} */ rel) => path.join(REPO_ROOT, rel);

/** @type {{ cases: Array<{id: string, tags: string[], date: string, time: string|number, timeZone: string|null, expect: {iso: string|null, codes: string[]}}> }} */
const table = JSON.parse(readFileSync(fromRoot(VECTORS_PATH), 'utf8'));

/**
 * Declared here as a literal rather than derived from the table, and declared
 * again as a literal in the Deno runner. Deriving the expectation from the
 * data a break would corrupt is how a "we examined every case" check ends up
 * comparing a set against itself; a table quietly shrunk to its easy rows would
 * satisfy a derived count forever.
 */
const EXPECTED_CASE_COUNT = 27;

/**
 * The hard cases this table exists for. A tag disappearing means the case that
 * carried it was deleted, which is the failure mode a passing suite would
 * otherwise hide.
 */
const REQUIRED_TAGS = [
  'baseline',
  'dst-ambiguous',
  'dst-boundary',
  'dst-gap',
  'half-hour-dst',
  'hour-24',
  'invalid-calendar-date',
  'minutes-number',
  'no-timezone',
  'offset-45',
  'unknown-timezone',
];

describe('season clock vectors — the table itself', () => {
  it('holds every case both arms are checked against', () => {
    expect(table.cases).toHaveLength(EXPECTED_CASE_COUNT);
    const ids = table.cases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('still covers every hard case the mirror was built for', () => {
    const present = new Set(table.cases.flatMap((c) => c.tags));
    for (const tag of REQUIRED_TAGS) {
      expect(
        table.cases.filter((c) => c.tags.includes(tag)).length,
        `no vector is tagged "${tag}" any more`
      ).toBeGreaterThan(0);
      expect(present.has(tag)).toBe(true);
    }
  });

  it('is read by the Deno arm too, or it is not a cross-check', () => {
    // Guards the literals above against a rename that leaves them stale.
    expect(existsSync(fromRoot('package.json'))).toBe(true);

    const sibling = readFileSync(fromRoot(SIBLING_RUNNER_PATH), 'utf8');
    expect(sibling).toContain('seasonClock.vectors.json');
    expect(sibling).toContain('resolveZonedInstant');

    // The Deno arm has to actually be run by CI, or a mirror test can exist,
    // pass locally, and never guard anything. The job discovers its files
    // rather than listing them, so what is asserted is that the discovery
    // covers the directory this runner lives in -- and that the workflow
    // still invokes the discovery script at all.
    // **Comments are stripped before matching, and that is not fastidiousness.**
    // Written as a plain `toContain` against the raw file, every assertion
    // below passes on a *mention*: both files describe in prose exactly what
    // they do, so a check for 'scripts/deno-mirror-tests.sh' went on passing
    // after the workflow step was changed to `run: echo skipped`, matching the
    // sentence that names the script instead of the line that runs it. That
    // was found by trying to make this check fail, which is the only way it
    // would ever have been found.
    const executable = (/** @type {string} */ text) =>
      text
        .split('\n')
        .filter((line) => !/^\s*#/.test(line))
        .join('\n');

    const runner = executable(readFileSync(fromRoot(DENO_RUNNER_PATH), 'utf8'));
    expect(runner).toContain(path.posix.dirname(SIBLING_RUNNER_PATH));

    // **Both suffixes, because the script deliberately matches both.** Pinning
    // only `*_test.ts` left the `-o -name '*.test.ts'` clause deletable with
    // this check still green -- and that clause is not decoration: the script
    // widened discovery to the set `deno test` itself recognises, precisely so
    // a file that passes when a developer runs `deno test` locally cannot be
    // skipped by CI without a word. Half the glob is half that guarantee.
    for (const pattern of ["-name '*_test.ts'", "-name '*.test.ts'"]) {
      expect(runner, `discovery no longer matches ${pattern}`).toContain(pattern);
    }

    // **Discovered is not the same as run.** The script can suppress a
    // discovered file through its `EXCLUDED` list, so checking only that
    // discovery reaches this directory would move the old omission channel
    // out of the workflow's file list and into the script's exclusion list,
    // where it would be just as invisible. This file's own Deno arm must not
    // be in it.
    const excluded = runner.match(/^EXCLUDED=\(([^)]*)\)/m);
    expect(excluded, 'EXCLUDED array not found in the runner').not.toBeNull();
    expect(excluded[1]).not.toContain(path.posix.basename(SIBLING_RUNNER_PATH));

    // ...and it has to run under BOTH zones. Pinning only UTC would let the
    // second zone be dropped with every assertion still green, and one zone
    // is not a control -- the whole point is that a host-zone read fails
    // exactly one of the two runs.
    const zones = runner.match(/^ZONES=\(([^)]*)\)/m);
    expect(zones, 'ZONES array not found in the runner').not.toBeNull();
    expect(zones[1]).toContain('UTC');
    expect(zones[1].trim().split(/\s+/).length).toBeGreaterThanOrEqual(2);

    const ci = executable(readFileSync(fromRoot(CI_WORKFLOW_PATH), 'utf8'));
    expect(ci).toContain(DENO_RUNNER_PATH);
  });
});

/**
 * The two arms, run against the identical expectations.
 *
 * `expect.iso` is compared as a string, not as an instant: the offset spelling
 * is part of the contract both arms state, and `2026-11-07T16:44:00-05:00` and
 * `2026-11-07T21:44:00Z` are the same instant while only one is the answer.
 */
describe.each([
  ['packages/core (JS)', resolveJs],
  ['_shared/timing (TS mirror)', resolveTs],
])('season clock vectors — %s', (_label, resolve) => {
  let exercised = 0;

  it.each(table.cases.map((c) => [c.id, c]))('%s', (_id, testCase) => {
    const { iso, findings } = resolve({
      date: testCase.date,
      time: testCase.time,
      timeZone: testCase.timeZone,
      label: 'vector',
    });
    expect(iso).toBe(testCase.expect.iso);
    expect(findings.map((f) => f.code)).toEqual(testCase.expect.codes);
    exercised += 1;
  });

  it('ran every case in the table', () => {
    expect(exercised).toBe(EXPECTED_CASE_COUNT);
  });
});

describe('season clock vectors — the host zone is not an input', () => {
  /**
   * The defect the clock exists for is a host-zone reading. `process.env.TZ`
   * is honoured by `Intl` lazily in Node, so flipping it mid-process does
   * change what a naive `new Date()` would produce -- which is precisely what
   * makes this a real control rather than a decorative one.
   */
  it('gives the same answers under TZ=UTC and TZ=America/Los_Angeles', () => {
    const original = process.env.TZ;
    /** @param {string} tz */
    const runAll = (tz) => {
      process.env.TZ = tz;
      return table.cases.map((c) => {
        const js = resolveJs({ date: c.date, time: c.time, timeZone: c.timeZone });
        const ts = resolveTs({ date: c.date, time: c.time, timeZone: c.timeZone });
        return `${c.id}|${js.iso}|${ts.iso}`;
      });
    };
    try {
      const utc = runAll('UTC');
      const la = runAll('America/Los_Angeles');
      expect(la).toEqual(utc);
      // Meta-assertion: a run that produced nothing would satisfy the equality.
      expect(utc).toHaveLength(EXPECTED_CASE_COUNT);
      expect(utc.some((row) => row.includes('2026-11-07T16:44:00-05:00'))).toBe(true);
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });
});
