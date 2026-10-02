/**
 * The JS heat model held to the Python reference (`scripts/heat/reference/
 * cvsc_wbgt.py`), on the reference's own offline fixture: NWS MTR forecast for
 * 2026-10-03, issued 2026-10-02 01:31 PDT.
 *
 * Three layers, so a failure says where the drift is:
 *
 * 1. The stated goldens, end to end through `computeHeatRows`, at the brief's
 *    +/-0.6 F (triggers included -- the reference's own test allowed 1.0 for
 *    the Black trigger; this one does not).
 * 2. Every hour of every reference site, physics only, against the
 *    full-precision Python values computed with the same 0.5-degree turbidity
 *    table the port ships -- the port itself, held to 1e-6 F.
 * 3. The same rows against pvlib's native turbidity -- the port plus its one
 *    documented substitution, at +/-0.6 F, with the measured maximum printed.
 *
 * The universe is {@link REFERENCE_SITES} x 24 hours, declared in the helper,
 * not read from the golden file; `assertFullCoverage` is shown to fail when a
 * golden row goes missing.
 */
import { describe, it, expect } from 'vitest';

import {
  airTrigger,
  altitudeToPressurePa,
  buildHeatPlan,
  clearSkyGhi,
  cloudReducedGhi,
  computeHeatRows,
  fieldWbgt,
  heatBand,
  heatRowDisplay,
  lookupLinkeTurbidity,
  roundHalfEven,
  solarPosition,
  stationPressureHpa,
  triggerTargets,
} from '@squadlogic/core/heat/index.js';

import {
  REFERENCE_DATE,
  REFERENCE_SITES,
  REFERENCE_TZ,
  loadHeatReference,
  loadTurbidity,
  referenceEstate,
  referenceForecasts,
} from './helpers/heatFixtures.js';

const ref = loadHeatReference();
const HOURS = Array.from({ length: 24 }, (_, h) => h);

/** Physics only, for one golden row: what computeHeatRows does per hour. */
function computeRow(site, row) {
  const elev = ref.elevationM;
  const ms = Date.parse(row.utc);
  const sp = solarPosition({
    epochMs: ms,
    latitude: site.latitude,
    longitude: site.longitude,
    elevationM: elev,
    pressurePa: altitudeToPressurePa(elev),
  });
  const tl = lookupLinkeTurbidity(loadTurbidity(), site.latitude, site.longitude, ms);
  const ghi = cloudReducedGhi(
    clearSkyGhi({
      epochMs: ms,
      apparentZenithDeg: sp.apparentZenith,
      altitudeM: elev,
      linkeTurbidity: tl,
    }),
    row.skyPct
  );
  const zen = (sp.apparentZenith * Math.PI) / 180;
  const p = stationPressureHpa(elev);
  const wbgt = fieldWbgt(site.surface, row.airF, row.dewF, row.windMph, ghi, zen, row.hour, p);
  const triggers = {};
  for (const cat of /** @type {Array<1|2|3>} */ ([1, 2, 3])) {
    const t = triggerTargets(cat);
    triggers[cat] = {
      red: airTrigger(site.surface, t.red, row.dewF, row.windMph, ghi, zen, row.hour, p),
      black: airTrigger(site.surface, t.black, row.dewF, row.windMph, ghi, zen, row.hour, p),
    };
  }
  return { apparentZenith: sp.apparentZenith, tl, ghi, wbgt, triggers };
}

/**
 * Compare every (site, hour) of the declared universe; throw if any is absent
 * from the reference. Returns the number compared and the worst differences.
 */
function assertFullCoverage(reference, compare) {
  let compared = 0;
  for (const site of REFERENCE_SITES) {
    const golden = reference.unrounded[site.key];
    if (!golden) throw new Error(`reference has no rows for site ${site.key}`);
    for (const h of HOURS) {
      const row = golden.rows.find((r) => r.hour === h);
      if (!row) throw new Error(`reference has no row for ${site.key} ${h}:00`);
      compare(site, row);
      compared += 1;
    }
  }
  if (compared !== REFERENCE_SITES.length * HOURS.length) {
    throw new Error(`compared ${compared} rows, expected ${REFERENCE_SITES.length * HOURS.length}`);
  }
  return compared;
}

describe('heat parity: the meta-assertion can fail', () => {
  it('throws when a golden row is missing', () => {
    const doctored = structuredClone(ref);
    doctored.unrounded.vannoy.rows = doctored.unrounded.vannoy.rows.filter((r) => r.hour !== 13);
    expect(() => assertFullCoverage(doctored, () => {})).toThrow(/vannoy 13:00/);
  });

  it('throws when a whole site is missing', () => {
    const doctored = structuredClone(ref);
    delete doctored.unrounded.fivecanyons;
    expect(() => assertFullCoverage(doctored, () => {})).toThrow(/fivecanyons/);
  });

  it('the reference was produced by the generator this repo carries', () => {
    expect(ref.generator).toBe('scripts/heat/generate_heat_reference.py');
    expect(ref.day).toBe(REFERENCE_DATE);
    expect(ref.timeZone).toBe(REFERENCE_TZ);
  });
});

describe('heat parity: stated goldens, end to end', () => {
  const { venues, fields } = referenceEstate();
  const plan = buildHeatPlan({
    date: REFERENCE_DATE,
    timeZone: REFERENCE_TZ,
    venues,
    fields,
    games: [],
  });
  const rows = computeHeatRows({
    plan,
    venues,
    category: 1,
    categorySource: 'default',
    forecasts: referenceForecasts(),
    turbidity: loadTurbidity(),
  });
  const at = (key, hour) =>
    rows.find(
      (r) => r.venueId === `loc-${key}` && r.window.kind === 'hour' && r.window.localHour === hour
    );

  it('computes every row of the no-games plan (4 venues x 10 hours)', () => {
    expect(plan.mode).toBe('hours');
    expect(rows).toHaveLength(40);
    expect(rows.filter((r) => r.status === 'computed')).toHaveLength(40);
  });

  it.each([
    ['canyon', 11, 'wbgtF', 77.3],
    ['canyon', 14, 'wbgtF', 80.9],
    ['canyon', 13, 'blackTriggerF', 94.5],
    ['vannoy', 8, 'wbgtF', 62.0],
    ['vannoy', 14, 'wbgtF', 80.0],
  ])('%s %s:00 %s = %s +/- 0.6', (key, hour, field, value) => {
    const row = at(key, hour);
    expect(row.status).toBe('computed');
    expect(Math.abs(row[field] - value)).toBeLessThanOrEqual(0.6);
  });

  it('Canyon 08:00 is Green (the reference test, carried over)', () => {
    expect(at('canyon', 8).band).toBe('Green');
  });

  it('every displayed value equals the Python reference as printed', () => {
    let checked = 0;
    for (const site of REFERENCE_SITES) {
      const printed = ref.roundedCategory1.table[site.key];
      for (const hour of [8, 9, 10, 11, 12, 13, 14, 15, 16, 17]) {
        const py = printed.find((r) => r.hour === `${String(hour).padStart(2, '0')}:00`);
        const row = at(site.key, hour);
        const shown = heatRowDisplay(row);
        expect(shown.airF).toBe(py.air_F);
        expect(shown.dewpointF).toBe(py.dewpt_F);
        expect(shown.windMph).toBe(py.wind_mph);
        expect(shown.skyCoverPct).toBe(py.sky_pct);
        expect(shown.wbgtF).toBe(py.wbgt_F);
        expect(row.band).toBe(py.band);
        expect(shown.redTriggerF).toBe(py.red_at_air_F);
        expect(shown.blackTriggerF).toBe(py.black_at_air_F);
        checked += 1;
      }
    }
    expect(checked).toBe(40);
  });
});

describe('heat parity: every hour, every site', () => {
  it('matches the full-precision reference on the shipped turbidity table to 1e-6 F', () => {
    const worst = { zen: 0, ghi: 0, wbgt: 0, trigger: 0 };
    const compared = assertFullCoverage(ref, (site, row) => {
      const got = computeRow(site, row);
      expect(got.tl).toBe(row.tlTable);
      worst.zen = Math.max(worst.zen, Math.abs(got.apparentZenith - row.apparentZenith));
      worst.ghi = Math.max(worst.ghi, Math.abs(got.ghi - row.ghiTable));
      worst.wbgt = Math.max(worst.wbgt, Math.abs(got.wbgt - row.wbgtTable));
      for (const cat of [1, 2, 3]) {
        for (const kind of ['red', 'black']) {
          const want = row[`${kind}TableCat${cat}`];
          const have = got.triggers[cat][kind];
          if (want === null) {
            expect(have).toBeNull();
          } else {
            worst.trigger = Math.max(worst.trigger, Math.abs(have - want));
          }
        }
      }
    });
    expect(compared).toBe(96);
    expect(worst.zen).toBeLessThan(1e-8);
    expect(worst.ghi).toBeLessThan(1e-6);
    expect(worst.wbgt).toBeLessThan(1e-6);
    expect(worst.trigger).toBeLessThan(1e-6);
  });

  it('stays within 0.6 F of the reference on pvlib native turbidity (the substitution)', () => {
    let worstWbgt = 0;
    let worstTrigger = 0;
    assertFullCoverage(ref, (site, row) => {
      const got = computeRow(site, row);
      worstWbgt = Math.max(worstWbgt, Math.abs(got.wbgt - row.wbgtNative));
      for (const cat of [1, 2, 3]) {
        for (const kind of ['red', 'black']) {
          const want = row[`${kind}NativeCat${cat}`];
          if (want !== null)
            worstTrigger = Math.max(worstTrigger, Math.abs(got.triggers[cat][kind] - want));
        }
      }
    });
    expect(worstWbgt).toBeLessThanOrEqual(0.6);
    expect(worstTrigger).toBeLessThanOrEqual(0.6);
  });

  it('bands every hour as the reference did (rounding first changes none of them here)', () => {
    assertFullCoverage(ref, (site, row) => {
      const py = ref.roundedCategory1.native[site.key].find(
        (r) => r.hour === `${String(row.hour).padStart(2, '0')}:00`
      );
      expect(heatBand(row.wbgtNative, 1)).toBe(py.band);
      expect(roundHalfEven(row.wbgtNative, 1)).toBe(py.wbgt_F);
    });
  });
});
