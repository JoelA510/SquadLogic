/**
 * Repo-wide coordinate guard: no real venue location enters the repo.
 *
 * The heat feature first merged with real venue locations in its test
 * fixtures and reference script. They were replaced by the made-up sites in
 * `tests/helpers/heatSyntheticSites.js`; this file keeps them, and any other
 * real location, out of every scanned file, whatever feature it comes through.
 * It cannot name the values it keeps out (that would commit them again), so
 * the rule is the other way round: every latitude/longitude literal must be
 * one of the synthetic sites; one of the region-level samples listed beside
 * them (held to one decimal place, about 11 km, which cannot locate a venue);
 * a whole degree; an out-of-range validation value; or an exact test value
 * another feature uses, allowed only in the files named in
 * `OTHER_FEATURE_VALUES` with a reason.
 *
 * The files are found by walking every tracked content directory (the
 * `sourceFilesUnder` contract in `tests/sourceHygiene.test.js`, widened to the
 * data, script and doc extensions) plus the root documents; the universe is
 * the tree, never the allowed set. JSON is read structurally, every other file
 * by pattern.
 *
 * Statically out of reach, and so not claimed: distance from the real sites
 * (the guard cannot hold them), and venue names in free text.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

import { REGION_SAMPLE_POINTS, SYNTHETIC_HEAT_SITES } from './helpers/heatSyntheticSites.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SELF = fileURLToPath(import.meta.url);

/**
 * Every tracked content directory is walked, and every file in it with a
 * scanned extension is read: the rule is repo-wide, so a coordinate entering
 * through any feature (location coordinates, imports, mocks) is seen, not only
 * one in a heat-named file. Root-level documents and configs are listed.
 */
const SCAN_ROOTS = [
  'tests',
  'scripts',
  'frontend',
  'packages',
  'fixtures',
  'docs',
  'supabase',
  'config',
  'project-hardening',
];
const SCAN_ALWAYS = ['CHANGELOG.md', 'README.md', 'CLAUDE.md', 'vercel.json'];
const SCAN_EXT = new Set([
  '.js',
  '.mjs',
  '.cjs',
  '.jsx',
  '.ts',
  '.tsx',
  '.json',
  '.py',
  '.feature',
  '.md',
  '.sql',
  '.csv',
  '.txt',
  '.yml',
  '.yaml',
]);

/**
 * Files deliberately not scanned, each with its reason.
 *
 * @type {Record<string, string>}
 */
const NOT_SCANNED = Object.freeze({
  'packages/core/src/heat/spaTables.js':
    'generated NREL SPA coefficient table: rows of [A, B, C] periodic terms, no coordinates',
});

/** Every file under `dir`, recursively, skipping dependency and build trees. */
function filesUnder(dir) {
  /** @type {string[]} */
  const files = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.features-gen' || entry.startsWith('.')) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) files.push(...filesUnder(full));
    else files.push(full);
  }
  return files;
}

function scannedFiles() {
  return SCAN_ROOTS.flatMap((r) => filesUnder(path.join(ROOT, r)))
    .filter((f) => f !== SELF)
    .filter((f) => SCAN_EXT.has(path.extname(f)))
    .map((f) => path.relative(ROOT, f).split(path.sep).join('/'))
    .filter((rel) => !(rel in NOT_SCANNED))
    .concat(SCAN_ALWAYS)
    .sort();
}

/** A latitude, a comma, a western-hemisphere longitude: tuples, call args, `/points/` URLs. */
const PAIR_RE = /(?<![\w.])(-?\d{1,2}\.\d+)\s*,\s*(-\d{2,3}\.\d+)(?![\w.])/g;
/** GeoJSON / WKT order: a western-hemisphere longitude, then a northern latitude. */
const LONLAT_RE = /(?<![\w.])(-\d{2,3}\.\d+)\s*[, ]\s*(\d{1,2}\.\d+)(?![\w.])/g;
/** Hemisphere letters: `37.12 N, 121.34 W`, degree sign optional. */
const NSEW_RE = /(\d{1,2}\.\d+)\s*°?\s*N\b[,\s]*(\d{2,3}\.\d+)\s*°?\s*W\b/g;
/** A lat/lon-named key or argument with a decimal literal. */
const KEY_RE = /\b(lat|latitude|lon|lng|longitude)\b["']?\s*[:=]\s*(-?\d+\.\d+)/gi;

/**
 * Coordinate literals in one file's text.
 *
 * @param {string} text
 * @returns {{ kind: string, lat?: number, lon?: number, value?: number, raw: string }[]}
 */
function extractFromText(text) {
  const found = [];
  for (const m of text.matchAll(PAIR_RE)) {
    found.push({ kind: 'pair', lat: Number(m[1]), lon: Number(m[2]), raw: m[0] });
  }
  for (const m of text.matchAll(LONLAT_RE)) {
    found.push({ kind: 'pair', lat: Number(m[2]), lon: Number(m[1]), raw: m[0] });
  }
  for (const m of text.matchAll(NSEW_RE)) {
    found.push({ kind: 'pair', lat: Number(m[1]), lon: -Number(m[2]), raw: m[0] });
  }
  for (const m of text.matchAll(KEY_RE)) {
    const kind = m[1].toLowerCase().startsWith('lat') ? 'lat' : 'lon';
    found.push({ kind, value: Number(m[2]), raw: m[0] });
  }
  return found;
}

const LAT_KEYS = new Set(['lat', 'latitude']);
const LON_KEYS = new Set(['lon', 'lng', 'longitude']);

/**
 * Coordinate values in parsed JSON: every lat/lon-named key wherever it sits,
 * every string (URLs, labels) by the text patterns, and every GeoJSON
 * `coordinates` position. The generator's solar-position samples are tagged,
 * because they are a plain latitude grid with seeded-random longitudes rather
 * than places.
 */
function extractFromJson(value, trail = []) {
  const found = [];
  if (typeof value === 'string') {
    for (const hit of extractFromText(value))
      found.push({ ...hit, raw: `${trail.join('.')}: ${hit.raw}` });
  } else if (
    Array.isArray(value) &&
    trail.includes('coordinates') &&
    value.length >= 2 &&
    value.every((v) => typeof v === 'number')
  ) {
    found.push({ kind: 'pair', lat: value[1], lon: value[0], raw: `${trail.join('.')}=${value}` });
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => found.push(...extractFromJson(v, [...trail, i])));
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (typeof v === 'number' && (LAT_KEYS.has(k) || LON_KEYS.has(k))) {
        found.push({
          kind: LAT_KEYS.has(k) ? 'lat' : 'lon',
          value: v,
          raw: `${[...trail, k].join('.')}=${v}`,
          solar: trail[0] === 'solar',
        });
      } else {
        found.push(...extractFromJson(v, [...trail, k]));
      }
    }
  }
  return found;
}

const ALLOWED_PAIRS = [
  ...SYNTHETIC_HEAT_SITES.map((s) => [s.latitude, s.longitude]),
  ...REGION_SAMPLE_POINTS,
];
/** `solar_samples()` in scripts/heat/generate_heat_reference.py: a plain latitude grid, no places. */
const SOLAR_LATITUDE_GRID = [-45.0, -15.0, 0.0, 15.0, 30.0, 37.5, 45.0, 60.0, 70.0];
const same = (a, b) => Math.abs(a - b) < 1e-9;
const decimals = (n) => (String(n).split('.')[1] ?? '').length;

/**
 * Other features' test values, allowed only in the files named, each entry
 * with its reason. Exact values (or one stated grid), not a precision rule, so
 * this cannot widen into a blanket exclusion; an entry a named file no longer
 * needs fails the stale-entry check below.
 */
const OTHER_FEATURE_VALUES = Object.freeze([
  {
    files: [
      'tests/locationCoordinates.test.js',
      'tests/locationCoordinatesForm.test.jsx',
      'supabase/tests/location_coordinates_rpc.sql',
      'docs/sql/20260930000000_smoke.sql',
      'tests/autoSchedulerDaylight.test.js',
      'tests/practiceDaylight.test.js',
      'tests/practiceRepairDaylight.test.js',
    ],
    values: [41.5, -73.5, -76.5, 40.125, -75.125, 40.13, -75.13, 1.01, -1.01],
    reason:
      'location-coordinates and daylight fixtures: a half-degree point, a 1/8-degree point and its two-decimal rounding, and a near-origin value, chosen to exercise storage and rounding, not to name a place',
  },
  {
    files: ['supabase/functions/_shared/timing/solar.vectors.json'],
    grid: 7.5,
    reason: 'solar timing test vectors: longitudes on a 7.5-degree sweep, no places',
  },
]);

/** Whether `v` is one of the other-feature values allowed in file `rel`. */
function otherFeatureAllows(rel, v) {
  return OTHER_FEATURE_VALUES.some(
    (e) =>
      e.files.includes(rel) &&
      (e.values
        ? e.values.some((x) => same(x, v))
        : Math.abs(v / e.grid - Math.round(v / e.grid)) < 1e-9)
  );
}

/** Beyond +/-90 latitude or +/-180 longitude: a validation case, not a location. */
const outOfRange = (lat, lon) =>
  (lat !== undefined && Math.abs(lat) > 90) || (lon !== undefined && Math.abs(lon) > 180);

/**
 * Whether one extracted literal, found in file `rel`, is allowed. Whole
 * degrees (`15.0`, `-180.0`: the turbidity box edges, the solar latitude grid)
 * are about 111 km and are region-level wherever they appear; out-of-range
 * values are not locations.
 */
function allowed(hit, rel = '') {
  const component = (v) => Number.isInteger(v) || otherFeatureAllows(rel, v);
  if (hit.kind === 'pair') {
    if (outOfRange(hit.lat, hit.lon)) return true;
    if (component(hit.lat) && component(hit.lon)) return true;
    return ALLOWED_PAIRS.some(([la, lo]) => same(la, hit.lat) && same(lo, hit.lon));
  }
  if (Number.isInteger(hit.value)) return true;
  if (hit.kind === 'lat' ? outOfRange(hit.value) : outOfRange(undefined, hit.value)) return true;
  if (otherFeatureAllows(rel, hit.value)) return true;
  // Solar samples: latitude on the generator's fixed grid, longitude seeded at two decimals.
  if (hit.solar) {
    return hit.kind === 'lat'
      ? SOLAR_LATITUDE_GRID.some((g) => same(g, hit.value))
      : decimals(hit.value) <= 2;
  }
  const idx = hit.kind === 'lat' ? 0 : 1;
  return ALLOWED_PAIRS.some((p) => same(p[idx], hit.value));
}

function scan() {
  const files = scannedFiles();
  /** @type {Record<string, any[]>} */
  const byFile = {};
  for (const rel of files) {
    const text = readFileSync(path.join(ROOT, rel), 'utf8');
    byFile[rel] = rel.endsWith('.json') ? extractFromJson(JSON.parse(text)) : extractFromText(text);
  }
  return { files, byFile };
}

/*
 * Stated floors. Measured when the guard went repo-wide: 1399 files scanned
 * and 1269 coordinate literals matched (468 of them in heatReference.json).
 * The floors leave headroom so ordinary file churn does not trip them; a walk
 * or a pattern that broke would still show here first, rather than as a clean
 * scan of nothing, and the per-file checks below catch one source going quiet.
 */
const MIN_FILES = 1300;
const MIN_LITERALS = 1200;

describe('repo coordinates :: the scan exercised the data', () => {
  const { files, byFile } = scan();
  const total = Object.values(byFile).reduce((n, hits) => n + hits.length, 0);

  it(`scans at least ${MIN_FILES} files and matches at least ${MIN_LITERALS} literals`, () => {
    expect(files.length).toBeGreaterThanOrEqual(MIN_FILES);
    expect(total).toBeGreaterThanOrEqual(MIN_LITERALS);
  });

  it.each([
    'tests/fixtures/heat/heatReference.json',
    'scripts/heat/reference/wbgt_reference.py',
    'scripts/heat/generate_heat_reference.py',
    'tests/nwsClient.test.js',
    'tests/helpers/heatSyntheticSites.js',
    'tests/locationCoordinates.test.js',
    'supabase/tests/location_coordinates_rpc.sql',
  ])('reads coordinates out of %s', (rel) => {
    expect(files).toContain(rel);
    expect(byFile[rel].length).toBeGreaterThan(0);
  });

  it.each([
    'tests/helpers/heatFixtures.js',
    'tests/e2e/steps/heat_forecast.ts',
    'tests/e2e/features/heat_forecast.feature',
    'tests/fixtures/heat/gridpoint-mtr-2026-10-03.json',
    'docs/architecture/heat-forecast.md',
  ])('scans %s', (rel) => {
    expect(files).toContain(rel);
  });

  it('flags a coordinate outside the set, in text and in JSON (positive control)', () => {
    const planted = ['latitude', ': ', '38.1234, longitude: ', '-120.5678'].join('');
    expect(extractFromText(planted).filter((h) => !allowed(h))).toHaveLength(2);
    const pair = ['getPoint(', '38.1234', ', ', '-120.5678', ')'].join('');
    expect(extractFromText(pair).filter((h) => !allowed(h))).toHaveLength(1);
    const site = SYNTHETIC_HEAT_SITES[0];
    expect(
      extractFromText(`getPoint(${site.latitude}, ${site.longitude})`).every((h) => allowed(h))
    ).toBe(true);
    const json = extractFromJson({ unrounded: { x: { lat: 38.1234, lon: -120.5678 } } });
    expect(json.filter((h) => !allowed(h))).toHaveLength(2);
    // Longitude first (GeoJSON / WKT), hemisphere letters, JSON strings and positions.
    const lonFirst = ['[', '-120.5678', ', ', '38.1234', ']'].join('');
    expect(extractFromText(lonFirst).filter((h) => !allowed(h))).toHaveLength(1);
    const nsew = ['38.1234', ' N, ', '120.5678', ' W'].join('');
    expect(extractFromText(nsew).filter((h) => !allowed(h))).toHaveLength(1);
    const url = ['https://api.weather.gov/points/', '38.1234', ',', '-120.5678'].join('');
    expect(extractFromJson({ source: { pointsUrl: url } }).filter((h) => !allowed(h))).toHaveLength(
      1
    );
    const geo = { geometry: { coordinates: [[[-120.5678, 38.1234]]] } };
    expect(extractFromJson(geo).filter((h) => !allowed(h))).toHaveLength(1);
    // A solar sample off the generator's latitude grid is not waved through.
    const solar = extractFromJson({ solar: [{ lat: 38.1, lon: -120.57 }] });
    expect(solar.filter((h) => !allowed(h))).toHaveLength(1);
  });
});

describe('repo coordinates :: every literal is synthetic, region-level or a named test value', () => {
  const { byFile } = scan();

  it('holds every scanned file to the set', () => {
    const offenders = Object.entries(byFile).flatMap(([rel, hits]) =>
      hits.filter((h) => !allowed(h, rel)).map((h) => `${rel}: ${h.raw}`)
    );
    expect(
      offenders,
      `coordinates outside tests/helpers/heatSyntheticSites.js: ${offenders.join('; ')}`
    ).toEqual([]);
  });

  it('every other-feature allow-list entry is still needed by each file it names', () => {
    for (const entry of OTHER_FEATURE_VALUES) {
      for (const rel of entry.files) {
        const values = (byFile[rel] ?? []).flatMap((h) =>
          h.kind === 'pair' ? [h.lat, h.lon] : [h.value]
        );
        expect(
          values.some((v) => !Number.isInteger(v) && otherFeatureAllows(rel, v)),
          `${rel} no longer needs its entry (${entry.reason}); remove it`
        ).toBe(true);
      }
    }
  });

  it('an other-feature value is allowed only in the files its entry names', () => {
    const hit = { kind: 'pair', lat: 40.125, lon: -75.125, raw: '' };
    expect(allowed(hit, 'tests/locationCoordinates.test.js')).toBe(true);
    expect(allowed(hit, 'tests/heatForecast.test.js')).toBe(false);
  });
});

describe('repo coordinates :: the synthetic heat set itself', () => {
  it('has four synthetic sites, one turf, at two decimals in the Pacific-time US and the TL box', () => {
    expect(SYNTHETIC_HEAT_SITES).toHaveLength(4);
    expect(SYNTHETIC_HEAT_SITES.filter((s) => s.surface === 'turf')).toHaveLength(1);
    for (const s of SYNTHETIC_HEAT_SITES) {
      expect(decimals(s.latitude)).toBeLessThanOrEqual(2);
      expect(decimals(s.longitude)).toBeLessThanOrEqual(2);
      // Turbidity table box: 15..72 N, 180..60 W.
      expect(s.latitude).toBeGreaterThan(15);
      expect(s.latitude).toBeLessThan(72);
      expect(s.longitude).toBeGreaterThan(-180);
      expect(s.longitude).toBeLessThan(-60);
      // Contiguous-US Pacific time: California, Oregon, Washington, Nevada.
      expect(s.latitude).toBeGreaterThan(32.5);
      expect(s.latitude).toBeLessThan(49);
      expect(s.longitude).toBeGreaterThan(-124.5);
      expect(s.longitude).toBeLessThan(-114);
    }
  });

  it('keeps the region-level samples at one decimal place', () => {
    for (const [lat, lon] of REGION_SAMPLE_POINTS) {
      expect(decimals(lat)).toBeLessThanOrEqual(1);
      expect(decimals(lon)).toBeLessThanOrEqual(1);
    }
  });

  it('the Python reference mirrors the synthetic sites exactly', () => {
    const py = readFileSync(path.join(ROOT, 'scripts/heat/reference/wbgt_reference.py'), 'utf8');
    const sites = [
      ...py.matchAll(/Site\("([^"]+)", "([^"]+)", (-?[\d.]+), (-?[\d.]+), "(\w+)"\)/g),
    ].map((m) => ({
      key: m[1],
      name: m[2],
      latitude: Number(m[3]),
      longitude: Number(m[4]),
      surface: m[5],
    }));
    expect(sites).toEqual(SYNTHETIC_HEAT_SITES.map((s) => ({ ...s })));
  });

  it('the golden reference was generated at exactly the synthetic sites', () => {
    const ref = JSON.parse(
      readFileSync(path.join(ROOT, 'tests/fixtures/heat/heatReference.json'), 'utf8')
    );
    const sites = Object.entries(ref.unrounded).map(([key, s]) => ({
      key,
      name: s.name,
      latitude: s.lat,
      longitude: s.lon,
      surface: s.surface,
    }));
    expect(sites).toEqual(SYNTHETIC_HEAT_SITES.map((s) => ({ ...s })));
    const names = new Set(SYNTHETIC_HEAT_SITES.map((s) => s.name));
    for (const table of Object.values(ref.roundedCategory1)) {
      expect(Object.keys(table).sort()).toEqual(SYNTHETIC_HEAT_SITES.map((s) => s.key).sort());
      for (const rows of Object.values(table)) {
        for (const row of rows) expect(names.has(row.site)).toBe(true);
      }
    }
  });
});
