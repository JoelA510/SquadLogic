/**
 * Shared loaders for the heat-forecast reference data written by
 * `scripts/heat/generate_heat_reference.py`.
 *
 * The reference sites are the Python reference's own four fields (public
 * school and park grounds, not personal data), kept so the parity goldens are
 * the values the reference prints.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { decodeTurbidityTable, parseGridpoint } from '@squadlogic/core/heat/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const HEAT_REFERENCE_PATH = path.join(ROOT, 'tests/fixtures/heat/heatReference.json');
export const HEAT_GRIDPOINT_PATH = path.join(
  ROOT,
  'tests/fixtures/heat/gridpoint-mtr-2026-10-03.json'
);
export const HEAT_TURBIDITY_PATH = path.join(
  ROOT,
  'packages/core/src/heat/data/linkeTurbidity-nws-0p5deg.bin'
);

/**
 * The reference sites, declared here rather than read from the golden file, so
 * a golden file that lost a site fails the coverage assertion instead of
 * shrinking the universe it is checked against.
 */
export const REFERENCE_SITES = Object.freeze([
  { key: 'canyon', name: 'Canyon MS', latitude: 37.7046, longitude: -122.0524, surface: 'turf' },
  { key: 'vannoy', name: 'Vannoy ES', latitude: 37.7069, longitude: -122.0587, surface: 'grass' },
  {
    key: 'independent',
    name: 'Independent ES',
    latitude: 37.699,
    longitude: -122.0509,
    surface: 'grass',
  },
  {
    key: 'fivecanyons',
    name: 'Five Canyons Park',
    latitude: 37.6765,
    longitude: -122.0305,
    surface: 'grass',
  },
]);

export const REFERENCE_DATE = '2026-10-03';
export const REFERENCE_TZ = 'America/Los_Angeles';

/** @returns {any} */
export function loadHeatReference() {
  return JSON.parse(readFileSync(HEAT_REFERENCE_PATH, 'utf8'));
}

/** The raw gridpoint fixture (a fresh object each call). */
export function loadGridpointJson() {
  return JSON.parse(readFileSync(HEAT_GRIDPOINT_PATH, 'utf8'));
}

export function loadParsedGridpoint() {
  return parseGridpoint(loadGridpointJson());
}

let turbidity = null;
export function loadTurbidity() {
  if (!turbidity)
    turbidity = decodeTurbidityTable(new Uint8Array(readFileSync(HEAT_TURBIDITY_PATH)));
  return turbidity;
}

/** Venue/field records for the reference sites, in the shape `buildHeatPlan` reads. */
export function referenceEstate() {
  const venues = REFERENCE_SITES.map((s) => ({
    id: `loc-${s.key}`,
    name: s.name,
    latitude: s.latitude,
    longitude: s.longitude,
  }));
  const fields = REFERENCE_SITES.map((s) => ({
    id: `field-${s.key}`,
    name: `${s.name} Field 1`,
    locationId: `loc-${s.key}`,
    surfaceType: s.surface === 'turf' ? 'Turf' : 'Grass',
  }));
  return { venues, fields };
}

/**
 * A forecast record for every reference venue, as the hook would assemble it.
 *
 * @returns {Record<string, import('../../packages/core/src/heat/forecast.js').VenueForecast>}
 */
export function referenceForecasts(retrievedAt = '2026-10-02T16:00:00.000Z') {
  const gridpoint = loadParsedGridpoint();
  return Object.fromEntries(
    REFERENCE_SITES.map((s) => [
      `loc-${s.key}`,
      {
        gridpoint,
        source: {
          pointsUrl: `https://api.weather.gov/points/${s.latitude.toFixed(4)},${s.longitude.toFixed(4)}`,
          gridpointUrl: 'https://api.weather.gov/gridpoints/MTR/97,99',
          retrievedAt,
        },
      },
    ])
  );
}
