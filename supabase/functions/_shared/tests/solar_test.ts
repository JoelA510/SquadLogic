/**
 * The Deno arm of the computed sunset's cross-arm drift check.
 *
 * Runs `_shared/timing/solar.ts` against `_shared/timing/solar.vectors.json`,
 * the table generated from `packages/core/src/timing/solar.js` that
 * `tests/solarVectors.test.js` holds core (and this arm) to under Vitest.
 * Either arm drifting turns that arm red; a table core no longer reproduces is
 * red on the Vitest side, so this file cannot be held to a stale answer.
 *
 * Why the Deno run matters even though Vitest also exercises the TS twin: the
 * offset comes from the zone through `Intl`, Deno ships its own ICU build, and
 * `scripts/deno-mirror-tests.sh` runs this file under two host zones (UTC and
 * America/Los_Angeles). The expectations are absolute, so a twin that read the
 * host zone would fail exactly one of the two runs.
 *
 * Needs `--allow-read` for the sibling-file assertion below; the vectors
 * themselves arrive as a JSON module import and need no permission.
 */

import {
  assert,
  assertEquals,
  assertStringIncludes,
} from 'https://deno.land/std@0.203.0/assert/mod.ts';
import { sunsetEnforcementMinutes, sunsetOnDate, SOLAR_REASON } from '../timing/solar.ts';
import vectors from '../timing/solar.vectors.json' with { type: 'json' };

interface SolarVector {
  id: string;
  tags: string[];
  date: unknown;
  latitude: unknown;
  longitude: unknown;
  timeZone: string | null;
  expect: {
    minutes: number | null;
    code: string | null;
    cause: string | null;
    enforcementMinutes: number | null;
  };
}

const cases = vectors.cases as SolarVector[];

/** A literal, not `cases.length`. The Vitest arm declares the same literal. */
const EXPECTED_CASE_COUNT = 316;

/** The hard cases the table exists for. Also declared literally in the Vitest arm. */
const REQUIRED_TAGS = [
  'baseline',
  'coordinates-unreadable',
  'date-line-shift',
  'date-unreadable',
  'dst-edge-1',
  'dst-edge-2',
  'off-meridian',
  'polar-null',
  'southern-zone',
  'timezone-missing',
  'timezone-unknown',
];

/**
 * `minutes` is compared within 1e-9 of a minute, everything else exactly. The
 * vectors are generated under Node; Deno 2.9.6's engine rounds its
 * transcendental functions differently in the last place, and on 4 of 316
 * vectors the twin lands one to two ulps (~3e-13 min) away. The Vitest arm
 * declares the same literal and explains the bound; it also asserts that no
 * vector sits near a whole minute, which is what keeps the exact `floor`
 * comparison stable across runtimes.
 */
const MINUTES_TOLERANCE = 1e-9;

const SIBLING_RUNNER = 'tests/solarVectors.test.js';
const VECTORS_PATH = 'supabase/functions/_shared/timing/solar.vectors.json';

Deno.test('solar vectors - the table holds every case both arms are checked against', () => {
  assertEquals(cases.length, EXPECTED_CASE_COUNT);
  assertEquals(new Set(cases.map((c) => c.id)).size, cases.length, 'duplicate vector id');
  for (const tag of REQUIRED_TAGS) {
    assert(
      cases.some((c) => c.tags.includes(tag)),
      `no vector is tagged "${tag}" any more`
    );
  }
  const zones = new Set(cases.map((c) => c.timeZone).filter(Boolean));
  assert(zones.size >= 4, 'the table names fewer than four zones');
});

Deno.test('solar vectors - core reads the same table, or this is not a cross-check', () => {
  const sibling = Deno.readTextFileSync(SIBLING_RUNNER);
  assertStringIncludes(sibling, VECTORS_PATH);
  assertStringIncludes(sibling, 'packages/core/src/timing/solar.js');
});

Deno.test('solar vectors - the Deno twin reproduces every vector', () => {
  let exercised = 0;
  let nulls = 0;
  const failures: string[] = [];

  for (const v of cases) {
    const result = sunsetOnDate({
      date: v.date,
      latitude: v.latitude,
      longitude: v.longitude,
      timeZone: v.timeZone,
    });
    const actual = {
      minutes: result.minutes,
      code: result.code,
      cause:
        result.code === SOLAR_REASON.SUNSET_UNDEFINED_AT_LATITUDE
          ? (result.findings[0].details.cause as string)
          : null,
      enforcementMinutes: sunsetEnforcementMinutes(result),
    };
    for (const key of ['minutes', 'code', 'cause', 'enforcementMinutes'] as const) {
      const expected = v.expect[key];
      const value = actual[key];
      const same =
        key === 'minutes' && typeof value === 'number' && typeof expected === 'number'
          ? Math.abs(value - expected) <= MINUTES_TOLERANCE
          : Object.is(value, expected);
      if (!same) {
        failures.push(`${v.id} ${key}: ${actual[key]} != ${v.expect[key]}`);
      }
    }
    if (result.code === SOLAR_REASON.SUNSET_UNDEFINED_AT_LATITUDE) nulls += 1;
    exercised += 1;
  }

  const hostZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  assertEquals(failures, [], `host zone ${hostZone}:\n${failures.join('\n')}`);
  // Meta-assertions: an empty table, or one with no polar nulls, would pass the loop in silence.
  assertEquals(exercised, EXPECTED_CASE_COUNT);
  assert(nulls > 0, 'no polar null was exercised');
});
