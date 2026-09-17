/**
 * The Deno arm of the season clock's cross-arm drift check.
 *
 * Runs `_shared/timing/seasonClock.ts` against
 * `_shared/timing/seasonClock.vectors.json` -- the same table, with the same
 * expected strings, that `tests/seasonClockVectors.test.js` runs
 * `packages/core/src/timing/seasonClock.js` against under Vitest. Either arm
 * drifting turns that arm red.
 *
 * Why the Deno run matters even though Vitest also exercises the TS mirror:
 * Deno ships its own ICU build, and the whole table is timezone data. The
 * mirror is deployed to the Deno edge runtime, so the assertion that matters is
 * the one made in it.
 *
 * Needs `--allow-read` for the two sibling-file assertions below; the vectors
 * themselves arrive as a JSON module import and need no permission.
 */

import {
  assert,
  assertEquals,
  assertStringIncludes,
} from 'https://deno.land/std@0.203.0/assert/mod.ts';
import { resolveZonedInstant } from '../timing/seasonClock.ts';
import vectors from '../timing/seasonClock.vectors.json' with { type: 'json' };

interface VectorCase {
  id: string;
  tags: string[];
  date: string;
  time: string | number;
  timeZone: string | null;
  expect: { iso: string | null; codes: string[] };
}

const cases = vectors.cases as VectorCase[];

/**
 * A literal, not `cases.length`. The Vitest arm declares the same literal.
 * Deriving the expectation from the data a break would corrupt is how a
 * coverage check ends up comparing a set against itself -- a table quietly
 * shrunk to its easy rows satisfies a derived count forever.
 */
const EXPECTED_CASE_COUNT = 27;

/** The hard cases this table exists for. Also declared literally in the Vitest arm. */
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

const SIBLING_RUNNER = 'tests/seasonClockVectors.test.js';
const VECTORS_PATH = 'supabase/functions/_shared/timing/seasonClock.vectors.json';

Deno.test('season clock vectors - the table holds every case both arms are checked against', () => {
  assertEquals(cases.length, EXPECTED_CASE_COUNT);
  assertEquals(new Set(cases.map((c) => c.id)).size, cases.length, 'duplicate vector id');
});

Deno.test('season clock vectors - every hard case the mirror was built for is still here', () => {
  for (const tag of REQUIRED_TAGS) {
    const hits = cases.filter((c) => c.tags.includes(tag)).length;
    assert(hits > 0, `no vector is tagged "${tag}" any more`);
  }
});

Deno.test('season clock vectors - the JS arm reads the same table, or this is not a cross-check', () => {
  const sibling = Deno.readTextFileSync(SIBLING_RUNNER);
  assertStringIncludes(sibling, VECTORS_PATH);
  assertStringIncludes(sibling, 'packages/core/src/timing/seasonClock.js');
});

Deno.test('season clock vectors - the TS mirror matches every expected instant', () => {
  let exercised = 0;
  const failures: string[] = [];

  for (const testCase of cases) {
    const { iso, findings } = resolveZonedInstant({
      date: testCase.date,
      time: testCase.time,
      timeZone: testCase.timeZone,
      label: 'vector',
    });
    // Compared as a string: the offset spelling is part of the contract, and
    // `...-05:00` and `...Z` are the same instant while only one is the answer.
    if (iso !== testCase.expect.iso) {
      failures.push(`${testCase.id}: iso ${JSON.stringify(iso)} != ${JSON.stringify(testCase.expect.iso)}`);
    }
    const codes = findings.map((f) => f.code);
    if (codes.join(',') !== testCase.expect.codes.join(',')) {
      failures.push(`${testCase.id}: codes [${codes}] != [${testCase.expect.codes}]`);
    }
    exercised += 1;
  }

  assertEquals(failures, [], failures.join('\n'));
  // Meta-assertion: an empty table would pass the loop above in silence.
  assertEquals(exercised, EXPECTED_CASE_COUNT);
});

Deno.test('season clock vectors - the host zone is not an input', () => {
  // A process cannot change its own TZ, so the control is the CI job: this file
  // runs twice, under TZ=UTC (the Supabase edge default, and where the weekday
  // defect hid) and under TZ=America/Los_Angeles. The expectations above are
  // absolute instants, so a host-dependent arm fails one of the two runs.
  //
  // What this case adds is the proof that neither run is vacuous: the host zone
  // must differ from the zone the vectors name, or "same answer either way"
  // would be the same answer to the same question.
  const hostZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const zonesUnderTest = new Set(cases.map((c) => c.timeZone).filter(Boolean));
  assert(zonesUnderTest.size > 1, 'the table names one zone — a host-zone read could still pass');

  const naiveWouldShift =
    new Date('2026-11-07T16:44:00').getTime() !== Date.parse('2026-11-07T16:44:00Z');
  const composed = cases
    .filter((c) => c.expect.iso !== null)
    .map((c) => resolveZonedInstant({ date: c.date, time: c.time, timeZone: c.timeZone }).iso);
  assert(composed.length > 0, 'no composable vectors — the control would pass vacuously');
  assertEquals(
    composed.filter((iso) => iso === null).length,
    0,
    `a vector that should compose returned null (host ${hostZone})`
  );
  // The one line that would move if the host zone leaked in.
  assertStringIncludes(composed.join('|'), '2026-11-07T16:44:00-05:00');
  console.log(
    `[season-clock vectors] host zone ${hostZone}; a naive parse here ${
      naiveWouldShift ? 'DOES' : 'does not'
    } differ from UTC`
  );
});
