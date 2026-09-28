/**
 * Cross-arm drift check: core `timing/solar.js` against the Edge twin
 * `_shared/timing/solar.ts`, value against value, in one process.
 *
 * The precedent is `tests/scoringEngineDrift.test.js`: Vitest can import the
 * Edge arm directly, which is strictly stronger than two arms agreeing with a
 * table -- a table can be wrong about both, and it only covers the rows it
 * holds. This grid covers every day of 2026 in four zones, so both DST edges of
 * each zone are inside it by construction rather than by someone remembering
 * them.
 *
 * **Exact equality.** The twin is line for line and both arms run on the same
 * engine, so any difference at all -- one changed coefficient, one reordered
 * term, a host-zone read -- is a divergence and is red.
 */

import { describe, it, expect } from 'vitest';

import {
  SUNSET_ZENITH_DEGREES as CORE_ZENITH,
  sunsetOnDate as coreSunset,
  sunsetEnforcementMinutes as coreEnforcement,
} from '../packages/core/src/timing/solar.js';
import { TIMING_REASON } from '../packages/core/src/timing/reasonCodes.js';
import {
  SOLAR_REASON,
  SUNSET_ZENITH_DEGREES as EDGE_ZENITH,
  sunsetOnDate as edgeSunset,
  sunsetEnforcementMinutes as edgeEnforcement,
} from '../supabase/functions/_shared/timing/solar.ts';

const LATITUDES = [-60, -50, -40, -30, -20, -10, 0, 10, 20, 30, 40, 50, 60];
const LONGITUDES = [-122, -74, 0, 151];
const ZONES = ['America/New_York', 'America/Los_Angeles', 'Europe/London', 'Australia/Sydney'];
const POLAR_LATITUDES = [70, 80, 89, -70, -80, -89];

/** Every calendar day of 2026, built from `Date.UTC` fields, never the host zone. */
const DAYS_OF_2026 = Array.from({ length: 365 }, (_, i) => {
  const t = new Date(Date.UTC(2026, 0, 1 + i));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(
    t.getUTCDate()
  ).padStart(2, '0')}`;
});

/**
 * Literals, not products of the arrays above: a grid quietly shrunk (a dropped
 * zone, a broken day builder) would agree with a derived count forever.
 */
const EXPECTED_GRID_SIZE = 75_920; // 13 latitudes x 4 longitudes x 365 days x 4 zones
const EXPECTED_POLAR_SIZE = 2_190; // 6 latitudes x 365 days, one longitude, one zone

/** A finding with the core-only `severity` set aside: the Edge arm carries none, as `seasonClock.ts`. */
const comparable = (result) => ({
  minutes: result.minutes,
  code: result.code,
  findings: result.findings.map(({ code, message, details }) => ({ code, message, details })),
});

/**
 * Run both arms over the inputs and return what differed.
 *
 * @param {Array<{date: unknown, latitude: unknown, longitude: unknown, timeZone: unknown}>} inputs
 */
function compare(inputs) {
  const diffs = [];
  const codes = new Map();
  let exercised = 0;
  let mismatched = 0;
  for (const input of inputs) {
    // Refusal inputs are deliberately malformed, hence the widened type.
    const loose = /** @type {any} */ (input);
    const core = comparable(coreSunset(loose));
    const edge = comparable(edgeSunset(loose));
    exercised += 1;
    codes.set(core.code, (codes.get(core.code) ?? 0) + 1);
    const same =
      Object.is(core.minutes, edge.minutes) &&
      JSON.stringify(core) === JSON.stringify(edge) &&
      Object.is(coreEnforcement(core), edgeEnforcement(edge));
    if (!same) {
      mismatched += 1;
      // The first few are enough to diagnose; the count says how many there were.
      if (diffs.length < 10) {
        diffs.push({ input, core: core.minutes ?? core.code, edge: edge.minutes ?? edge.code });
      }
    }
  }
  return {
    diffs: mismatched === 0 ? [] : [`${mismatched} mismatched`, ...diffs],
    codes,
    exercised,
  };
}

describe('solar drift :: the Edge twin is the same algorithm as core', () => {
  it('declares the same zenith and spells both sunset codes as the core registry does', () => {
    expect(EDGE_ZENITH).toBe(CORE_ZENITH);
    expect(SOLAR_REASON).toEqual({
      SUNSET_UNDEFINED_AT_LATITUDE: TIMING_REASON.SUNSET_UNDEFINED_AT_LATITUDE,
      SUNSET_COORDINATES_UNREADABLE: TIMING_REASON.SUNSET_COORDINATES_UNREADABLE,
    });
  });

  it('agrees exactly over latitudes -60..60, four longitudes, every day of 2026, four zones', () => {
    const inputs = [];
    for (const timeZone of ZONES) {
      for (const date of DAYS_OF_2026) {
        for (const latitude of LATITUDES) {
          for (const longitude of LONGITUDES) inputs.push({ date, latitude, longitude, timeZone });
        }
      }
    }
    const { diffs, codes, exercised } = compare(inputs);
    expect(diffs).toEqual([]);
    expect(exercised).toBe(EXPECTED_GRID_SIZE);
    // Every grid point is a sunset: the grid exercised the arithmetic, not a refusal path.
    expect(codes.get(null)).toBe(EXPECTED_GRID_SIZE);
  });

  it('agrees exactly on the polar days, and the null cases are really there', () => {
    const inputs = [];
    for (const date of DAYS_OF_2026) {
      for (const latitude of POLAR_LATITUDES) {
        inputs.push({ date, latitude, longitude: 0, timeZone: 'Europe/London' });
      }
    }
    const { diffs, codes, exercised } = compare(inputs);
    expect(diffs).toEqual([]);
    expect(exercised).toBe(EXPECTED_POLAR_SIZE);
    // Meta-assertion: a polar set with no nulls would compare two sunsets and
    // prove nothing about the refusal branch.
    expect(codes.get(TIMING_REASON.SUNSET_UNDEFINED_AT_LATITUDE)).toBeGreaterThan(0);
    // ... and one with no sunsets would prove nothing about the boundary days.
    expect(codes.get(null)).toBeGreaterThan(0);

    const causes = new Set(
      inputs
        .map((input) => edgeSunset(input))
        .filter((r) => r.code === SOLAR_REASON.SUNSET_UNDEFINED_AT_LATITUDE)
        .map((r) => r.findings[0].details.cause)
    );
    expect([...causes].sort()).toEqual(['midnight-sun', 'polar-night']);
  });

  it('refuses the same inputs with the same codes and findings', () => {
    const base = { date: '2026-06-21', latitude: 45, longitude: 0, timeZone: 'Europe/London' };
    const inputs = [
      { ...base, latitude: 91 },
      { ...base, longitude: -180.5 },
      { ...base, latitude: Number.NaN },
      { ...base, latitude: '45' },
      { ...base, timeZone: null },
      { ...base, timeZone: undefined },
      { ...base, timeZone: 'Mars/Olympus' },
      { ...base, date: '2026-02-30' },
      { ...base, date: 20260621 },
    ];
    const { diffs, codes, exercised } = compare(inputs);
    expect(diffs).toEqual([]);
    expect(exercised).toBe(inputs.length);
    expect(codes.get(null)).toBeUndefined();
  });

  it('the comparison can fail: a sunset one ulp away is a difference', () => {
    const input = { date: '2026-07-01', latitude: 45, longitude: 0, timeZone: 'Europe/London' };
    const core = comparable(coreSunset(input));
    const nudged = {
      ...core,
      minutes: /** @type {number} */ (core.minutes) * (1 + Number.EPSILON),
    };
    expect(Object.is(core.minutes, nudged.minutes)).toBe(false);
    expect(JSON.stringify(core) === JSON.stringify(nudged)).toBe(false);
  });
});
