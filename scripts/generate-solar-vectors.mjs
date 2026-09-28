#!/usr/bin/env node
/**
 * Regenerate `supabase/functions/_shared/timing/solar.vectors.json` from the
 * canonical sunset, `packages/core/src/timing/solar.js`.
 *
 * Run it only when core's answer is meant to change. `tests/solarVectors.test.js`
 * fails on a table core no longer reproduces, so a stale table cannot sit green;
 * and `_shared/tests/solar_test.ts` then holds the Deno arm to the new values.
 *
 * **No real coordinates.** Every point is a plain grid point: latitudes on a
 * 15-degree grid and each zone's standard meridian (a multiple of 15 degrees),
 * or 7.5 degrees off it. Nothing here names, or was fitted to, a place.
 *
 *   node scripts/generate-solar-vectors.mjs
 */

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { sunsetOnDate, sunsetEnforcementMinutes } from '../packages/core/src/timing/solar.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = 'supabase/functions/_shared/timing/solar.vectors.json';

/**
 * Each zone, its standard meridian, and its two 2026 daylight-saving edges
 * (the first transition of the year, then the second). Sydney's year runs the
 * other way: it leaves daylight time in April and enters it in October.
 */
const ZONES = [
  { timeZone: 'America/New_York', meridian: -75, edges: ['2026-03-08', '2026-11-01'] },
  { timeZone: 'America/Los_Angeles', meridian: -120, edges: ['2026-03-08', '2026-11-01'] },
  { timeZone: 'Europe/London', meridian: 0, edges: ['2026-03-29', '2026-10-25'] },
  { timeZone: 'Australia/Sydney', meridian: 150, edges: ['2026-04-05', '2026-10-04'] },
];

const GRID_LATITUDES = [-45, -15, 15, 45];
const MONTHLY = Array.from({ length: 12 }, (_, i) => `2026-${String(i + 1).padStart(2, '0')}-21`);

/** @param {string} iso @param {number} days */
function shift(iso, days) {
  const [y, m, d] = iso.split('-').map(Number);
  const ms = Date.UTC(y, m - 1, d) + days * 86_400_000;
  const t = new Date(ms);
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(
    t.getUTCDate()
  ).padStart(2, '0')}`;
}

const cases = [];
/**
 * @param {string[]} tags
 * @param {{ date: unknown, latitude: unknown, longitude: unknown, timeZone: unknown }} input
 */
function add(tags, input) {
  // Refusal vectors hand over deliberately malformed input.
  const result = sunsetOnDate(input);
  cases.push({
    id: `v${String(cases.length + 1).padStart(3, '0')}`,
    tags,
    ...input,
    expect: {
      minutes: result.minutes,
      code: result.code,
      // Which way there is no sunset: the two mean opposite things to a daylight rule.
      cause:
        result.code === 'SUNSET_UNDEFINED_AT_LATITUDE' ? result.findings[0].details.cause : null,
      enforcementMinutes: sunsetEnforcementMinutes(result),
    },
  });
}

for (const { timeZone, meridian, edges } of ZONES) {
  const hemisphere = meridian === 150 ? ['southern-zone'] : [];
  for (const latitude of GRID_LATITUDES) {
    for (const date of MONTHLY) {
      add(['baseline', ...hemisphere], { date, latitude, longitude: meridian, timeZone });
    }
    edges.forEach((edge, index) => {
      const tag = index === 0 ? 'dst-edge-1' : 'dst-edge-2';
      for (const days of [-1, 0, 1]) {
        add([tag, ...hemisphere], {
          date: shift(edge, days),
          latitude,
          longitude: meridian,
          timeZone,
        });
      }
    });
  }
  // Off the meridian by half a zone, both ways: the longitude term, not only the offset.
  for (const offMeridian of [-7.5, 7.5]) {
    add(['off-meridian', ...hemisphere], {
      date: '2026-06-21',
      latitude: 30,
      longitude: meridian + offMeridian,
      timeZone,
    });
  }
}

// The solar day across the date line: a point on 150E read on the Pacific clock
// is the evening of the same calendar date, not the morning after.
for (const date of ['2026-01-21', '2026-07-21']) {
  add(['date-line-shift'], { date, latitude: 0, longitude: 150, timeZone: 'America/Los_Angeles' });
  add(['date-line-shift'], { date, latitude: 0, longitude: -120, timeZone: 'Australia/Sydney' });
}

// Polar nulls, and the polar sunsets beside them, on both solstices.
for (const date of ['2026-06-21', '2026-12-21']) {
  for (const latitude of [75, 85, -75, -85]) {
    add(['polar'], { date, latitude, longitude: 0, timeZone: 'Europe/London' });
  }
}
for (const date of ['2026-03-20', '2026-09-22']) {
  add(['polar-equinox'], { date, latitude: 75, longitude: 0, timeZone: 'Europe/London' });
}

// Refusals.
add(['coordinates-unreadable'], {
  date: '2026-06-21',
  latitude: 91,
  longitude: 0,
  timeZone: 'Europe/London',
});
add(['coordinates-unreadable'], {
  date: '2026-06-21',
  latitude: 0,
  longitude: -181,
  timeZone: 'Europe/London',
});
add(['coordinates-unreadable'], {
  date: '2026-06-21',
  latitude: '45',
  longitude: 0,
  timeZone: 'Europe/London',
});
add(['timezone-missing'], { date: '2026-06-21', latitude: 45, longitude: 0, timeZone: null });
add(['timezone-unknown'], {
  date: '2026-06-21',
  latitude: 45,
  longitude: 0,
  timeZone: 'Mars/Olympus',
});
add(['date-unreadable'], {
  date: '2026-02-30',
  latitude: 45,
  longitude: 0,
  timeZone: 'Europe/London',
});

// Tag the null outcomes by what they are, so the runners can require each.
for (const c of cases) {
  if (c.expect.code === 'SUNSET_UNDEFINED_AT_LATITUDE') c.tags.push('polar-null');
}

const table = {
  $comment: [
    'The computed sunset cross-arm vector table. (date, latitude, longitude, IANA zone) ->',
    'fractional minutes past local midnight on the season clock, the refusal code, and the',
    'floor enforcement minute (plus, for a polar null, whether it is polar night or midnight sun).',
    '',
    'GENERATED from packages/core/src/timing/solar.js by scripts/generate-solar-vectors.mjs.',
    'Do not hand-edit. It is read by both arms:',
    '  tests/solarVectors.test.js                 core AND the TS arm under Vitest',
    '  supabase/functions/_shared/tests/solar_test.ts  the TS arm under Deno, two host zones',
    'Minutes are compared exactly: JSON round-trips a double, and the arms share every operation.',
    '',
    "No real coordinates: grid latitudes and each zone's standard meridian (or 7.5 deg off it).",
  ],
  cases,
};

writeFileSync(path.join(REPO_ROOT, OUT), `${JSON.stringify(table, null, 2)}\n`);
console.log(`wrote ${cases.length} vectors to ${OUT}`);
