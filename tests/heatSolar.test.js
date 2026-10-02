/**
 * Solar position, clear-sky GHI and the Linke turbidity table against pvlib.
 *
 * Samples come from `scripts/heat/generate_heat_reference.py`: SPA on a plain
 * latitude grid with random longitudes, elevations and instants (low sun and
 * night included); Ineichen across zenith (to 91 degrees), elevation, day of
 * year and turbidity; and the turbidity table at ten US points across the year.
 */
import { describe, it, expect } from 'vitest';

import {
  TURBIDITY_TABLE,
  clearSkyGhi,
  decodeTurbidityTable,
  extraRadiation,
  lookupLinkeTurbidity,
  relativeAirmass,
  solarPosition,
  turbidityCovers,
  utcDayOfYear,
} from '@squadlogic/core/heat/index.js';
import { ineichenGhi } from '@squadlogic/core/heat/clearSky.js';

import { loadHeatReference, loadTurbidity } from './helpers/heatFixtures.js';

const ref = loadHeatReference();

describe('NREL SPA against pvlib', () => {
  it('matches every sample to 1e-8 degree, low sun included', () => {
    expect(ref.solar.length).toBeGreaterThanOrEqual(150);
    let worst = 0;
    let lowSun = 0;
    for (const s of ref.solar) {
      const r = solarPosition({
        epochMs: Date.parse(s.utc),
        latitude: s.lat,
        longitude: s.lon,
        elevationM: s.elevation,
        pressurePa: s.pressurePa,
      });
      worst = Math.max(
        worst,
        Math.abs(r.zenith - s.zenith),
        Math.abs(r.apparentZenith - s.apparentZenith)
      );
      if (s.apparentZenith > 80 && s.apparentZenith < 95) lowSun += 1;
    }
    expect(worst).toBeLessThan(1e-8);
    // The samples must actually exercise the refraction branch near the horizon.
    expect(lowSun).toBeGreaterThan(0);
  });

  it('refuses a non-finite input', () => {
    expect(() =>
      solarPosition({ epochMs: NaN, latitude: 0, longitude: 0, elevationM: 0, pressurePa: 101325 })
    ).toThrow(TypeError);
  });
});

describe('Ineichen clear sky against pvlib', () => {
  it('matches every sample to 1e-6 W/m2 (zero at and below the horizon)', () => {
    let worst = 0;
    for (const s of ref.clearSky) {
      const ms = Date.parse(s.utc);
      expect(extraRadiation(utcDayOfYear(ms))).toBeCloseTo(s.dniExtra, 9);
      const got = clearSkyGhi({
        epochMs: ms,
        apparentZenithDeg: s.apparentZenith,
        altitudeM: s.elevation,
        linkeTurbidity: s.tl,
      });
      worst = Math.max(worst, Math.abs(got - s.ghi));
    }
    expect(worst).toBeLessThan(1e-6);
  });

  it('airmass is null below the horizon, so GHI is zero there', () => {
    expect(relativeAirmass(90.5)).toBeNull();
    expect(
      ineichenGhi({
        apparentZenithDeg: 91,
        airmassAbsolute: null,
        linkeTurbidity: 3,
        altitudeM: 0,
        dniExtra: 1366,
      })
    ).toBe(0);
  });
});

describe('Linke turbidity table', () => {
  it("reproduces the generator's table values exactly", () => {
    const table = loadTurbidity();
    for (const s of ref.turbidity) {
      expect(lookupLinkeTurbidity(table, s.lat, s.lon, Date.parse(s.utc))).toBeCloseTo(s.table, 12);
    }
  });

  it('stays within the documented substitution error of pvlib native at the sample points', () => {
    const table = loadTurbidity();
    let worst = 0;
    for (const s of ref.turbidity) {
      worst = Math.max(
        worst,
        Math.abs(lookupLinkeTurbidity(table, s.lat, s.lon, Date.parse(s.utc)) - s.native)
      );
    }
    // Docs: p95 over CONUS 0.18, max 1.7 (mountains). These ten points sit well inside.
    expect(worst).toBeLessThan(0.5);
  });

  it('matches the box the generator wrote', () => {
    expect(ref.tableBox).toMatchObject({
      north: TURBIDITY_TABLE.north,
      south: TURBIDITY_TABLE.south,
      west: TURBIDITY_TABLE.west,
      east: TURBIDITY_TABLE.east,
      resolution: TURBIDITY_TABLE.resolutionDeg,
      rows: TURBIDITY_TABLE.rows,
      cols: TURBIDITY_TABLE.cols,
    });
  });

  it('refuses points outside the box rather than borrowing a neighbour', () => {
    const table = loadTurbidity();
    expect(turbidityCovers(13.4, 144.8)).toBe(false); // Guam: NWS serves it, the table does not
    expect(lookupLinkeTurbidity(table, 13.4, 144.8, Date.parse('2026-07-01T00:00:00Z'))).toBeNull();
    expect(lookupLinkeTurbidity(table, 72.0, -150, Date.parse('2026-07-01T00:00:00Z'))).toBeNull();
    expect(lookupLinkeTurbidity(table, 40, -60, Date.parse('2026-07-01T00:00:00Z'))).toBeNull();
    expect(
      lookupLinkeTurbidity(table, 15, -180, Date.parse('2026-07-01T00:00:00Z'))
    ).not.toBeNull();
  });

  it('refuses a truncated or corrupt table', () => {
    expect(() => decodeTurbidityTable(new Uint8Array(100))).toThrow(/expected 328320/);
    const zeros = new Uint8Array(328320).fill(60);
    zeros[1234] = 0;
    expect(() => decodeTurbidityTable(zeros)).toThrow(/zero cell at byte 1234/);
  });
});
