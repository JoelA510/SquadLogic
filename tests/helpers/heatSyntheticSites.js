/**
 * SYNTHETIC heat-forecast sites: the one definition every heat test, the E2E
 * steps and the Python reference (`scripts/heat/reference/wbgt_reference.py`,
 * which mirrors these values) use.
 *
 * Why synthetic: the repo must carry no real venue's location or name. These
 * are made-up points, rounded to two decimals, chosen to keep what the heat
 * tests rely on:
 *
 * - inside the contiguous US Pacific time zone, so the fixture day's local
 *   hours (`America/Los_Angeles`) hold;
 * - inside the Linke turbidity table box (15..72 N, 180..60 W) that
 *   `packages/core/src/heat/turbidity.js` and the generator share;
 * - one turf site and three grass sites, the surface mix the parity and plan
 *   tests read.
 *
 * `tests/heatSyntheticCoordinates.test.js` fails on any coordinate literal in
 * the heat test data, fixtures or scripts that is not in this module.
 *
 * Dependency-free on purpose, so the Playwright steps can import it too.
 */

export const SYNTHETIC_HEAT_SITES = Object.freeze([
  Object.freeze({
    key: 'site-a',
    name: 'Site A',
    latitude: 37.3,
    longitude: -121.65,
    surface: 'turf',
  }),
  Object.freeze({
    key: 'site-b',
    name: 'Site B',
    latitude: 37.31,
    longitude: -121.66,
    surface: 'grass',
  }),
  Object.freeze({
    key: 'site-c',
    name: 'Site C',
    latitude: 37.29,
    longitude: -121.64,
    surface: 'grass',
  }),
  Object.freeze({
    key: 'site-d',
    name: 'Site D',
    latitude: 37.27,
    longitude: -121.62,
    surface: 'grass',
  }),
]);

/**
 * Non-venue sample points the heat data also carries: the generator's
 * region-level turbidity samples and the out-of-coverage point the plan tests
 * use. Every one is at most one decimal place (about 11 km), which cannot name
 * a venue; the guard test holds this list to that, so it cannot be used to
 * allow a venue-precision coordinate through.
 */
export const REGION_SAMPLE_POINTS = Object.freeze([
  [40.0, -105.0],
  [25.5, -80.5],
  [61.2, -149.9],
  [21.3, -157.8],
  [18.4, -66.1],
  [47.6, -122.3],
  [33.4, -112.0],
  [44.0, -71.0],
  [30.0, -90.0],
  [13.4, 144.8],
]);
