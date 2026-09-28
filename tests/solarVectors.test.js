/**
 * The computed sunset's vector table, read by Vitest.
 *
 * `supabase/functions/_shared/timing/solar.vectors.json` is generated from core
 * (`scripts/generate-solar-vectors.mjs`) and is the one table the Deno arm is
 * held to under Deno (`_shared/tests/solar_test.ts`, run by
 * `scripts/deno-mirror-tests.sh` under two host zones). Two things make that a
 * cross-check rather than two readings of a file:
 *
 * 1. **Core must reproduce the table, exactly.** A table core no longer
 *    reproduces is stale, and a stale table would hold the Deno arm to an
 *    answer nobody computes any more -- green on both sides while the two
 *    implementations disagree. This file is what turns that red.
 * 2. **The TS arm must reproduce it here too**, so a drift is red in a local
 *    `npm run test` without waiting for the Deno job (the season clock's
 *    precedent, `tests/seasonClockVectors.test.js`).
 *
 * The code, the polar cause and the enforced minute are compared exactly;
 * `minutes` within {@link MINUTES_TOLERANCE}, for the cross-runtime reason given
 * there. The exact, in-process comparison of the two arms is
 * `tests/solarDrift.test.js`.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  sunsetOnDate as coreSunset,
  sunsetEnforcementMinutes as coreEnforcement,
} from '../packages/core/src/timing/solar.js';
import {
  sunsetOnDate as edgeSunset,
  sunsetEnforcementMinutes as edgeEnforcement,
} from '../supabase/functions/_shared/timing/solar.ts';

const VECTORS_PATH = 'supabase/functions/_shared/timing/solar.vectors.json';
const DENO_RUNNER_PATH = 'supabase/functions/_shared/tests/solar_test.ts';
const REPO_ROOT = process.cwd();

/**
 * @typedef {{ id: string, tags: string[], date: unknown, latitude: unknown, longitude: unknown,
 *   timeZone: string|null, expect: { minutes: number|null, code: string|null,
 *   cause: string|null, enforcementMinutes: number|null } }} SolarVector
 */

/** @type {{ cases: SolarVector[] }} */
const table = JSON.parse(readFileSync(path.join(REPO_ROOT, VECTORS_PATH), 'utf8'));
const cases = table.cases;

/**
 * A literal, and the Deno runner declares the same one. Derived from
 * `cases.length` it would agree with a table quietly shrunk to its easy rows.
 */
const EXPECTED_CASE_COUNT = 316;

/** The hard cases the table exists for. Declared again, literally, in the Deno runner. */
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

const REQUIRED_ZONES = [
  'America/Los_Angeles',
  'America/New_York',
  'Australia/Sydney',
  'Europe/London',
];

/**
 * How far a vector's `minutes` may sit from a runtime's answer: 1e-9 of a
 * minute, 60 nanoseconds.
 *
 * **Why not exact.** Within one process the arms are compared exactly
 * (`tests/solarDrift.test.js`). Across runtimes they are not bit-identical:
 * run under Deno 2.9.6 (CI's pinned version), the twin differed from these
 * Node-generated values on 4 of 316 vectors, by one to two ulps (~3e-13 of a
 * minute) -- the engines' transcendental functions round differently in the
 * last place. The table is also read by CI's Node 20 and a developer's Node 22.
 * So `minutes` carries this tolerance, four orders of magnitude above the
 * observed noise and six below the smallest coefficient change (a one-digit
 * change in the last NOAA coefficient moves a sunset by ~1e-3 minute).
 *
 * Everything else -- the code, the polar cause and the enforced `floor` minute
 * -- is compared exactly, and that is safe only because no vector sits near a
 * whole minute: asserted below, since a floor taken 1e-13 either side of an
 * integer would differ by a whole minute between runtimes.
 */
const MINUTES_TOLERANCE = 1e-9;

/** The smallest distance any vector's sunset may sit from a whole minute. */
const MIN_DISTANCE_FROM_WHOLE_MINUTE = 1e-6;

/**
 * @param {string} key
 * @param {unknown} actual
 * @param {unknown} expected
 */
function agrees(key, actual, expected) {
  if (key === 'minutes' && typeof actual === 'number' && typeof expected === 'number') {
    return Math.abs(actual - expected) <= MINUTES_TOLERANCE;
  }
  return Object.is(actual, expected);
}

/**
 * Either arm's two functions, typed loosely enough to take both: the arms'
 * findings differ in the core-only `severity`, which no vector reads.
 *
 * @typedef {(input: any) => { minutes: number|null, code: string|null,
 *   findings: Array<{ details: Record<string, unknown> }> }} SunsetArm
 * @typedef {(sunset: { minutes: number|null }) => number|null} EnforcementArm
 */

/**
 * Every field a vector pins, read from one arm.
 *
 * @param {SunsetArm} sunset
 * @param {EnforcementArm} enforcement
 * @param {SolarVector} vector
 */
function answerOf(sunset, enforcement, vector) {
  const { date, latitude, longitude, timeZone } = vector;
  // Refusal vectors hand over deliberately malformed input; `SunsetArm` takes `any`.
  const result = sunset({ date, latitude, longitude, timeZone });
  return {
    minutes: result.minutes,
    code: result.code,
    cause: result.code === 'SUNSET_UNDEFINED_AT_LATITUDE' ? result.findings[0].details.cause : null,
    enforcementMinutes: enforcement(result),
  };
}

/**
 * @param {SunsetArm} sunset
 * @param {EnforcementArm} enforcement
 */
function mismatches(sunset, enforcement) {
  const failures = [];
  let exercised = 0;
  for (const vector of cases) {
    const actual = answerOf(sunset, enforcement, vector);
    for (const key of /** @type {const} */ (['minutes', 'code', 'cause', 'enforcementMinutes'])) {
      if (!agrees(key, actual[key], vector.expect[key])) {
        failures.push(`${vector.id} ${key}: ${actual[key]} != ${vector.expect[key]}`);
      }
    }
    exercised += 1;
  }
  return { failures, exercised };
}

describe('solar vectors :: the table is the table both arms are held to', () => {
  it('holds exactly the declared number of cases, each id once', () => {
    expect(cases.length).toBe(EXPECTED_CASE_COUNT);
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
  });

  it('still carries every hard case, every zone, and both polar causes', () => {
    for (const tag of REQUIRED_TAGS) {
      expect({ tag, hits: cases.filter((c) => c.tags.includes(tag)).length > 0 }).toEqual({
        tag,
        hits: true,
      });
    }
    const zones = new Set(cases.map((c) => c.timeZone));
    for (const zone of REQUIRED_ZONES) expect(zones.has(zone)).toBe(true);
    const causes = new Set(cases.map((c) => c.expect.cause).filter(Boolean));
    expect([...causes].sort()).toEqual(['midnight-sun', 'polar-night']);
    // A table of nothing but refusals would reproduce trivially.
    expect(cases.filter((c) => typeof c.expect.minutes === 'number').length).toBeGreaterThan(250);
  });

  it('keeps every sunset clear of a whole minute, so the floor is runtime-stable', () => {
    const numeric = cases.filter((c) => typeof c.expect.minutes === 'number');
    const nearest = Math.min(
      ...numeric.map((c) => {
        const fraction = c.expect.minutes - Math.floor(c.expect.minutes);
        return Math.min(fraction, 1 - fraction);
      })
    );
    expect(numeric.length).toBeGreaterThan(0);
    expect(nearest).toBeGreaterThan(MIN_DISTANCE_FROM_WHOLE_MINUTE);
  });

  it('is read by the Deno runner too, or it is not a cross-check', () => {
    const runner = readFileSync(path.join(REPO_ROOT, DENO_RUNNER_PATH), 'utf8');
    expect(runner).toContain('../timing/solar.vectors.json');
    expect(runner).toContain('../timing/solar.ts');
    expect(runner).toContain(`EXPECTED_CASE_COUNT = ${EXPECTED_CASE_COUNT}`);
    expect(runner).toContain(`MINUTES_TOLERANCE = ${MINUTES_TOLERANCE}`);
  });
});

describe('solar vectors :: both arms reproduce every vector', () => {
  it('core reproduces the table (a stale table is red here)', () => {
    const { failures, exercised } = mismatches(coreSunset, coreEnforcement);
    expect(failures).toEqual([]);
    expect(exercised).toBe(EXPECTED_CASE_COUNT);
  });

  it('the Edge arm reproduces the table', () => {
    const { failures, exercised } = mismatches(edgeSunset, edgeEnforcement);
    expect(failures).toEqual([]);
    expect(exercised).toBe(EXPECTED_CASE_COUNT);
  });

  it('the comparison can fail: a sunset moved by a thousandth of a minute is caught', () => {
    // The meta-assertion for the two above: the tolerance is far below what a
    // changed coefficient does, so it cannot swallow one.
    const vector = cases.find((c) => typeof c.expect.minutes === 'number');
    const actual = answerOf(coreSunset, coreEnforcement, /** @type {SolarVector} */ (vector));
    const minutes = /** @type {number} */ (actual.minutes);
    expect(agrees('minutes', minutes + 1e-3, minutes)).toBe(false);
    expect(agrees('minutes', minutes + 1e-10, minutes)).toBe(true);
  });
});
