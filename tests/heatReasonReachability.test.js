/**
 * Every HEAT_REASON code is produced by a public entry point fed input data --
 * never by forging internal state. `tests/reasonCodeReachability.test.js`
 * registers HEAT_REASON as a non-finding table (its codes ride on a row's
 * `reason`/`notes` and on `HeatError`, `{ code, message }`, no severity) and
 * points here for the reachability proof.
 *
 * The two Liljegren guards are reached through `liljegren()` itself at extreme
 * surface temperatures. A probe of `fieldWbgt()` over air -40..200 F, wind
 * 0..100 mph and GHI 0..1e4 W/m2 found no input that reaches them through the
 * forecast pipeline; they stay because the reference carries them, and a row
 * that hit one would be refused with its code rather than dropped.
 */
import { describe, it, expect } from 'vitest';

import {
  HEAT_REASON,
  buildHeatPlan,
  computeHeatRows,
  expandLayer,
  fieldWbgt,
  parseDurationHours,
  parseGridpoint,
} from '@squadlogic/core/heat/index.js';
import { fToK, liljegren } from '@squadlogic/core/heat/wbgt.js';

import {
  REFERENCE_DATE,
  REFERENCE_TZ,
  loadGridpointJson,
  loadTurbidity,
  referenceEstate,
  referenceForecasts,
} from './helpers/heatFixtures.js';

const codeOf = (fn) => {
  try {
    fn();
  } catch (err) {
    return err.code;
  }
  return null;
};

/**
 * @param {{ venues: any[], fields: any[], games?: any[], forecasts?: Record<string, any>,
 *   date?: string }} input `forecasts` defaults to the reference forecast.
 */
function rowCodes({ venues, fields, games = [], forecasts, date = REFERENCE_DATE }) {
  const plan = buildHeatPlan({ date, timeZone: REFERENCE_TZ, venues, fields, games });
  const rows = computeHeatRows({
    plan,
    venues,
    category: 1,
    categorySource: 'default',
    forecasts: forecasts ?? referenceForecasts(),
    turbidity: loadTurbidity(),
  });
  return new Set(
    rows.flatMap((r) => [r.reason?.code, ...r.notes.map((n) => n.code)]).filter(Boolean)
  );
}

/** One producing call per code: the universe is the table, not the calls. */
function produce() {
  const seen = new Set();
  const { venues, fields } = referenceEstate();

  // Estate refusals.
  const v = structuredClone(venues);
  v[0].latitude = null;
  v[0].longitude = null;
  v[1].latitude = 13.4;
  v[1].longitude = 144.8;
  const f = structuredClone(fields);
  f[2].surfaceType = 'Indoor';
  f[3].surfaceType = '';
  for (const c of rowCodes({ venues: v, fields: f })) seen.add(c);
  const forecasts = referenceForecasts();
  // A surface refusal precedes the forecast, so the NWS failure needs its own estate.
  forecasts['loc-fivecanyons'] = { error: { message: 'NWS 500 after 3 attempts' } };
  for (const c of rowCodes({ venues, fields, forecasts })) seen.add(c);
  const f2 = structuredClone(fields);
  f2[0].surfaceType = 'Clay';
  for (const c of rowCodes({ venues, fields: f2 })) seen.add(c);

  // Forecast gap.
  for (const c of rowCodes({ venues, fields, date: '2026-10-05' })) seen.add(c);

  // Game windows.
  const at = (hhmm) => `2026-10-03T${hhmm}:00-07:00`;
  for (const c of rowCodes({
    venues,
    fields,
    games: [
      { id: 'g1', fieldId: 'field-gone', start: at('10:00'), end: at('11:00') },
      { id: 'g2', fieldId: 'field-vannoy', start: at('16:00'), end: at('15:00') },
      { id: 'g3', fieldId: 'field-vannoy', start: at('09:20'), end: null },
      { id: 'g4', fieldId: 'field-canyon', start: at('23:30'), end: '2026-10-04T01:00:00-07:00' },
    ],
  })) {
    seen.add(c);
  }

  // Clock.
  seen.add(
    codeOf(() => buildHeatPlan({ date: REFERENCE_DATE, timeZone: null, venues, fields, games: [] }))
  );

  // Gridpoint parsing.
  const noUpdate = loadGridpointJson();
  delete noUpdate.properties.updateTime;
  seen.add(codeOf(() => parseGridpoint(noUpdate)));
  seen.add(codeOf(() => expandLayer({ uom: 'wmoUnit:K', values: [] }, 'temperature')));
  seen.add(codeOf(() => parseDurationHours('PT30M')));
  seen.add(
    codeOf(() =>
      expandLayer(
        {
          uom: 'wmoUnit:degF',
          values: [{ validTime: '2026-10-03T07:00:00+00:00/PT1H', value: null }],
        },
        't'
      )
    )
  );

  // Physics.
  seen.add(codeOf(() => fieldWbgt('grass', 70, 75, 3, 500, 0.8, 11, 1000)));
  seen.add(codeOf(() => liljegren(fToK(-40), 0.01, 1000, 50, 0, 0, fToK(-40) - 100, 0.2)));
  seen.add(codeOf(() => liljegren(fToK(32), 0.01, 1000, 50, 100, 1.56, fToK(32) + 200, 0.2)));

  seen.delete(null);
  return seen;
}

describe('HEAT_REASON reachability', () => {
  it('every declared code is produced by a public entry point', () => {
    const produced = produce();
    const declared = Object.values(HEAT_REASON);
    // Meta-assertion: the table is non-trivial, so "none missing" means something.
    expect(declared.length).toBeGreaterThanOrEqual(19);
    expect(declared.filter((code) => !produced.has(code))).toEqual([]);
    // Nothing produced that the table does not declare.
    expect([...produced].filter((code) => !declared.includes(code))).toEqual([]);
  });
});
