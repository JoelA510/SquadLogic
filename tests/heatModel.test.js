/**
 * The Python reference's own unit tests, ported (`scripts/heat/reference/
 * test_cvsc_wbgt.py`), plus the edge cases the brief names: sun on the horizon
 * in dead calm, dewpoint above air, unknown units, sub-hour durations, missing
 * forecast hours, band boundaries, and the rounding rule banding now follows.
 */
import { describe, it, expect } from 'vitest';

import {
  HEAT_BANDS,
  HEAT_REASON,
  HeatError,
  airTrigger,
  expandLayer,
  fieldWbgt,
  heatBand,
  parseDurationHours,
  parseGridpoint,
  parseIsoInstant,
  roundHalfEven,
  triggerTargets,
} from '@squadlogic/core/heat/index.js';

import { loadGridpointJson } from './helpers/heatFixtures.js';

const rad = (d) => (d * Math.PI) / 180;

describe('Parsing (ported)', () => {
  it('reads day/hour durations', () => {
    expect(parseDurationHours('PT1H')).toBe(1);
    expect(parseDurationHours('PT3H')).toBe(3);
    expect(parseDurationHours('P1D')).toBe(24);
    expect(parseDurationHours('P1DT6H')).toBe(30);
    expect(parseDurationHours('P7DT13H')).toBe(181);
  });

  it.each(['PT30M', 'P', '1H', '', 'PT1H30M', 'PT', 'P1W'])('refuses %j', (bad) => {
    expect(() => parseDurationHours(bad)).toThrow(HeatError);
    try {
      parseDurationHours(bad);
    } catch (err) {
      expect(err.code).toBe(HEAT_REASON.GRIDPOINT_DURATION_UNSUPPORTED);
    }
  });

  it('names a sub-hour duration as such', () => {
    expect(() => parseDurationHours('PT30M')).toThrow(/sub-hour/);
  });

  it('rejects an unknown unit rather than guessing', () => {
    expect(() => expandLayer({ uom: 'wmoUnit:K', values: [] }, 'temperature')).toThrow(
      /unexpected unit/
    );
    expect(() => expandLayer({ uom: null, values: [] }, 'temperature')).toThrow(/unexpected unit/);
  });

  it('skips null values but rejects a layer left empty', () => {
    const layer = {
      uom: 'wmoUnit:degF',
      values: [{ validTime: '2026-10-03T07:00:00+00:00/PT1H', value: null }],
    };
    expect(() => expandLayer(layer, 'temperature')).toThrow(/no values/);
  });

  it('expands mixed 1 h / 3 h blocks to hourly UTC and converts degC/km_h-1', () => {
    const t = expandLayer(
      {
        uom: 'wmoUnit:degC',
        values: [
          { validTime: '2026-10-03T07:00:00+00:00/PT3H', value: 20 },
          { validTime: '2026-10-03T10:00:00+00:00/PT1H', value: 25 },
        ],
      },
      'temperature'
    );
    expect([...t.keys()].map((k) => new Date(k).toISOString())).toEqual([
      '2026-10-03T07:00:00.000Z',
      '2026-10-03T08:00:00.000Z',
      '2026-10-03T09:00:00.000Z',
      '2026-10-03T10:00:00.000Z',
    ]);
    expect(t.get(Date.parse('2026-10-03T08:00:00Z'))).toBe(68);
    expect(t.get(Date.parse('2026-10-03T10:00:00Z'))).toBe(77);
    const w = expandLayer(
      {
        uom: 'wmoUnit:km_h-1',
        values: [{ validTime: '2026-10-03T07:00:00-07:00/PT1H', value: 10 }],
      },
      'windSpeed'
    );
    expect(w.get(Date.parse('2026-10-03T14:00:00Z'))).toBeCloseTo(6.21371, 10);
  });

  it('refuses a naive or impossible validTime instead of reading it in the host zone', () => {
    expect(() => parseIsoInstant('2026-10-03T07:00:00')).toThrow(HeatError);
    expect(() => parseIsoInstant('2026-02-30T07:00:00Z')).toThrow(/calendar/);
    expect(parseIsoInstant('2026-10-03T00:00:00-07:00')).toBe(Date.parse('2026-10-03T07:00:00Z'));
  });
});

describe('Gridpoint response validation', () => {
  it('parses the fixture with its metadata', () => {
    const g = parseGridpoint(loadGridpointJson());
    expect(g.meta).toMatchObject({ gridId: 'MTR', gridX: 97, gridY: 99, elevationM: 121 });
    expect(g.meta.updateTime).toBe('2026-10-02T08:31:00+00:00');
    expect(g.layers.temperature.size).toBe(24);
    expect(g.layers.nwsWbgt).toBeNull();
  });

  it('refuses an elevation not in metres (stricter than the reference)', () => {
    const json = loadGridpointJson();
    json.properties.elevation.unitCode = 'wmoUnit:ft';
    expect(() => parseGridpoint(json)).toThrow(/elevation: unexpected unit/);
  });

  it('refuses a response missing updateTime or the grid id', () => {
    for (const key of ['updateTime', 'gridId', 'elevation', 'skyCover']) {
      const json = loadGridpointJson();
      delete json.properties[key];
      expect(() => parseGridpoint(json), key).toThrow(new RegExp(key));
    }
  });

  it('reads an NWS WBGT layer only when it carries a value', () => {
    const empty = loadGridpointJson();
    empty.properties.wetBulbGlobeTemperature = { uom: null, values: [] }; // the live October shape
    expect(parseGridpoint(empty).layers.nwsWbgt).toBeNull();
    const nulls = loadGridpointJson();
    nulls.properties.wetBulbGlobeTemperature = {
      uom: 'wmoUnit:degC',
      values: [{ validTime: '2026-10-03T20:00:00+00:00/PT1H', value: null }],
    };
    expect(parseGridpoint(nulls).layers.nwsWbgt).toBeNull();
    const real = loadGridpointJson();
    real.properties.wetBulbGlobeTemperature = {
      uom: 'wmoUnit:degF',
      values: [{ validTime: '2026-10-03T20:00:00+00:00/PT1H', value: 79.5 }],
    };
    expect(parseGridpoint(real).layers.nwsWbgt.get(Date.parse('2026-10-03T20:00:00Z'))).toBe(79.5);
  });
});

describe('Physics (ported)', () => {
  it('sun on the horizon in dead calm stays finite', () => {
    const w = fieldWbgt('turf', 60.0, 50.0, 0.0, 5.0, rad(89.9), 7, 1000.0);
    expect(Number.isFinite(w)).toBe(true);
    expect(w).toBeLessThan(70.0);
  });

  it('refuses a dewpoint above air', () => {
    expect(() => fieldWbgt('grass', 70.0, 75.0, 3.0, 500.0, rad(50), 11, 1000.0)).toThrow(
      HeatError
    );
    try {
      fieldWbgt('grass', 70.0, 75.0, 3.0, 500.0, rad(50), 11, 1000.0);
    } catch (err) {
      expect(err.code).toBe(HEAT_REASON.DEWPOINT_ABOVE_AIR);
    }
  });

  it('tolerates a dewpoint up to 0.5 F above air (the reference allowance)', () => {
    expect(Number.isFinite(fieldWbgt('grass', 70.0, 70.4, 3.0, 500.0, rad(50), 11, 1000.0))).toBe(
      true
    );
  });

  it('turf is not cooler than grass at midday', () => {
    /** @type {[number, number, number, number, number, number, number]} */
    const args = [90.0, 56.0, 6.0, 709.0, rad(44.4), 14, 1000.0];
    expect(fieldWbgt('turf', ...args)).toBeGreaterThan(fieldWbgt('grass', ...args));
  });

  it('refuses an unknown surface', () => {
    // @ts-expect-error -- an invalid surface is the point
    expect(() => fieldWbgt('clay', 80, 50, 3, 500, rad(40), 12, 1000)).toThrow(/unknown surface/);
  });

  it('a trigger nothing up to 125 F reaches is null, not a number', () => {
    expect(airTrigger('grass', 92, 0, 10, 0, Math.PI / 2, 2, 1000)).toBeNull();
  });

  it('a trigger already met at the search floor returns the floor', () => {
    expect(airTrigger('turf', 60, 55, 0, 800, 0.7, 13, 1000)).toBe(56);
  });
});

describe('Bands and rounding', () => {
  it('band edges, Category 1 (ported)', () => {
    expect(heatBand(76.1, 1)).toBe('Green');
    expect(heatBand(76.2, 1)).toBe('Yellow');
    expect(heatBand(86.2, 1)).toBe('Red');
    expect(heatBand(86.3, 1)).toBe('Black');
  });

  it.each(/** @type {Array<1|2|3>} */ ([1, 2, 3]))(
    'every upper bound is inclusive and +0.1 is the next band, Category %s',
    (cat) => {
      const names = ['Green', 'Yellow', 'Orange', 'Red', 'Black'];
      HEAT_BANDS[cat].forEach(([name, upper], i) => {
        expect(heatBand(upper, cat)).toBe(name);
        expect(heatBand(roundHalfEven(upper + 0.1, 1), cat)).toBe(names[i + 1]);
      });
    }
  );

  it('Category 2 Black starts above 89.8 (poster table), not 89.9 (poster text)', () => {
    expect(heatBand(89.8, 2)).toBe('Red');
    expect(heatBand(89.9, 2)).toBe('Black');
  });

  it('bands the displayed (rounded) value: 76.149 shows 76.1 and is Green', () => {
    // The reference banded the unrounded value and would print "76.1 Yellow".
    expect(roundHalfEven(76.149, 1)).toBe(76.1);
    expect(heatBand(76.149, 1)).toBe('Green');
    expect(heatBand(76.151, 1)).toBe('Yellow');
  });

  it('rounds like Python round(): exact halves to even, everything else by true value', () => {
    expect(roundHalfEven(80.25, 1)).toBe(80.2);
    expect(roundHalfEven(80.75, 1)).toBe(80.8);
    expect(roundHalfEven(0.35, 1)).toBe(0.3); // 0.35 is 0.34999... in binary
    expect(roundHalfEven(64.5)).toBe(64);
    expect(roundHalfEven(65.5)).toBe(66);
    expect(roundHalfEven(-0.25, 1)).toBe(-0.2);
  });

  it('trigger targets are the first value of Red and the Red/Black boundary', () => {
    expect(triggerTargets(1).red).toBeCloseTo(84.2, 10);
    expect(triggerTargets(1).black).toBe(86.2);
    expect(triggerTargets(2).red).toBeCloseTo(87.8, 10);
    expect(triggerTargets(3)).toEqual({ red: triggerTargets(3).red, black: 92.0 });
    expect(triggerTargets(3).red).toBeCloseTo(90.1, 10);
  });

  it('refuses a category outside 1-3', () => {
    // @ts-expect-error -- an invalid category is the point
    expect(() => heatBand(80, 4)).toThrow(RangeError);
    // @ts-expect-error -- an invalid category is the point
    expect(() => triggerTargets(0)).toThrow(RangeError);
  });
});
