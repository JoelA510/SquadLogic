/**
 * The heat-forecast composer: rows from the estate and the game run, the
 * approved max-over-game-hours rule, refusals that are rows (never drops), the
 * stale-forecast rule, and provenance on every computed row.
 */
import { describe, it, expect } from 'vitest';

import {
  HEAT_MODEL,
  HEAT_REASON,
  HEAT_SOURCES,
  NO_GAME_HOURS,
  STALE_AFTER_HOURS,
  buildHeatPlan,
  computeHeatRows,
  forecastAge,
  localDayHours,
  sourcesForProvenance,
} from '@squadlogic/core/heat/index.js';

import {
  REFERENCE_DATE,
  REFERENCE_TZ,
  loadTurbidity,
  referenceEstate,
  referenceForecasts,
} from './helpers/heatFixtures.js';

/**
 * @param {{ date?: string, games?: any[], venues?: any[], fields?: any[],
 *   forecasts?: Record<string, any>, category?: 1|2|3 }} [opts]
 */
const run = ({
  date = REFERENCE_DATE,
  games = [],
  venues,
  fields,
  forecasts,
  category = 1,
} = {}) => {
  const estate = referenceEstate();
  const v = venues ?? estate.venues;
  const f = fields ?? estate.fields;
  const plan = buildHeatPlan({ date, timeZone: REFERENCE_TZ, venues: v, fields: f, games });
  const rows = computeHeatRows({
    plan,
    venues: v,
    category,
    categorySource: 'configured',
    forecasts: forecasts ?? referenceForecasts(),
    turbidity: loadTurbidity(),
  });
  return { plan, rows };
};

// Oct 3 is PDT (UTC-7).
const at = (hhmm) => `2026-10-03T${hhmm}:00-07:00`;

describe('rows come from the estate and the game run', () => {
  it('no games: venue x surface x 08:00-17:00', () => {
    const { plan, rows } = run();
    expect(plan.mode).toBe('hours');
    expect(rows).toHaveLength(4 * NO_GAME_HOURS.length);
  });

  it('games: one row per venue x surface x window; same-window games collapse and list their fields', () => {
    const { venues, fields } = referenceEstate();
    fields.push({
      id: 'field-canyon-2',
      name: 'Canyon MS Field 2',
      locationId: 'loc-canyon',
      surfaceType: 'turf',
    });
    const games = [
      { id: 'g1', fieldId: 'field-canyon', start: at('08:00'), end: at('09:00') },
      { id: 'g2', fieldId: 'field-canyon-2', start: at('08:00'), end: at('09:00') },
      { id: 'g3', fieldId: 'field-vannoy', start: at('14:00'), end: at('15:00') },
      // Another day: not on this screen.
      {
        id: 'g4',
        fieldId: 'field-vannoy',
        start: '2026-10-04T14:00:00-07:00',
        end: '2026-10-04T15:00:00-07:00',
      },
    ];
    const { plan, rows } = run({ games, venues, fields });
    expect(plan.mode).toBe('games');
    expect(rows).toHaveLength(2);
    const canyon = rows.find((r) => r.venueId === 'loc-canyon');
    expect(canyon.gameIds).toEqual(['g1', 'g2']);
    expect(canyon.fieldNames).toEqual(['Canyon MS Field 1', 'Canyon MS Field 2']);
    expect(canyon.window).toMatchObject({ kind: 'game', startLabel: '08:00', endLabel: '09:00' });
  });

  it('a game late in the local day belongs to that day, not the next UTC day', () => {
    const games = [{ id: 'late', fieldId: 'field-vannoy', start: at('18:00'), end: at('19:00') }];
    // 18:00 PDT is 01:00 UTC on Oct 4.
    const { rows } = run({ games });
    expect(rows).toHaveLength(1);
    expect(rows[0].usedHour).toBe(18);
  });
});

describe('game windows: the hottest overlapped hour (approved rule)', () => {
  it('a game across 13:00 and 14:00 takes the 13:00 values, the hotter hour', () => {
    const games = [{ id: 'g', fieldId: 'field-canyon', start: at('13:30'), end: at('15:00') }];
    const { rows } = run({ games });
    const [row] = rows;
    expect(row.status).toBe('computed');
    expect(row.hourly.map((h) => h.localHour)).toEqual([13, 14]);
    expect(row.usedHour).toBe(13);
    expect(row.wbgtF).toBe(Math.max(...row.hourly.map((h) => h.wbgtF)));
    expect(row.wbgtF).toBeCloseTo(83.0, 0);
    expect(row.band).toBe('Orange');
  });

  it('the used hour is the hottest even when it is not the kickoff hour', () => {
    const games = [{ id: 'g', fieldId: 'field-canyon', start: at('11:00'), end: at('13:30') }];
    const [row] = run({ games }).rows;
    expect(row.hourly.map((h) => h.localHour)).toEqual([11, 12, 13]);
    expect(row.usedHour).toBe(13);
  });

  it('a game ending exactly on the hour does not judge the next hour', () => {
    const games = [{ id: 'g', fieldId: 'field-vannoy', start: at('09:00'), end: at('10:00') }];
    expect(run({ games }).rows[0].hourly.map((h) => h.localHour)).toEqual([9]);
  });

  it('no end time: kickoff hour only, with a note', () => {
    const games = [{ id: 'g', fieldId: 'field-vannoy', start: at('16:20'), end: null }];
    const [row] = run({ games }).rows;
    expect(row.status).toBe('computed');
    expect(row.hourly.map((h) => h.localHour)).toEqual([16]);
    expect(row.notes.map((n) => n.code)).toEqual([HEAT_REASON.GAME_END_UNKNOWN]);
  });

  it('a game ending before it starts is refused, not guessed', () => {
    const games = [{ id: 'g', fieldId: 'field-vannoy', start: at('16:00'), end: at('15:00') }];
    const [row] = run({ games }).rows;
    expect(row.status).toBe('refused');
    expect(row.reason.code).toBe(HEAT_REASON.GAME_TIME_UNREADABLE);
  });

  it('a game running past midnight is judged on its in-day hours, with a note', () => {
    const games = [
      { id: 'g', fieldId: 'field-vannoy', start: at('23:30'), end: '2026-10-04T01:00:00-07:00' },
    ];
    const [row] = run({ games }).rows;
    expect(row.notes.map((n) => n.code)).toEqual([HEAT_REASON.GAME_EXTENDS_PAST_DAY]);
    expect(row.hourly.map((h) => h.localHour)).toEqual([23]);
    expect(row.status).toBe('computed');
  });
});

describe('refusals are rows, never drops', () => {
  it('a date the forecast does not cover is refused with FORECAST_GAP (ported)', () => {
    const { rows } = run({ date: '2026-10-05' });
    expect(rows).toHaveLength(40);
    for (const row of rows) {
      expect(row.status).toBe('refused');
      expect(row.reason.code).toBe(HEAT_REASON.FORECAST_GAP);
      expect(row.reason.message).toMatch(/does not cover/);
    }
  });

  it('a game overlapping one forecast hour and one missing hour is refused as a whole', () => {
    const forecasts = referenceForecasts();
    const gp = forecasts['loc-vannoy'].gridpoint;
    const trimmed = structuredClone(gp);
    trimmed.layers.temperature.delete(Date.parse('2026-10-03T22:00:00Z')); // 15:00 PDT
    forecasts['loc-vannoy'] = { ...forecasts['loc-vannoy'], gridpoint: trimmed };
    const games = [{ id: 'g', fieldId: 'field-vannoy', start: at('14:00'), end: at('16:00') }];
    const [row] = run({ games, forecasts }).rows;
    expect(row.status).toBe('refused');
    expect(row.reason.code).toBe(HEAT_REASON.FORECAST_GAP);
    expect(row.reason.message).toMatch(/15:00.*missing temperature/);
    expect(row.hourly).toHaveLength(1);
  });

  it('venue without coordinates, outside the table, or without a forecast', () => {
    const { venues, fields } = referenceEstate();
    venues[0] = { ...venues[0], latitude: null, longitude: null };
    venues[1] = { ...venues[1], latitude: 13.4, longitude: 144.8 };
    const forecasts = referenceForecasts();
    forecasts['loc-independent'] = {
      error: { message: 'NWS 404: Data Unavailable For Requested Point' },
    };
    const { rows } = run({ venues, fields, forecasts });
    const code = (id) => rows.find((r) => r.venueId === id).reason?.code ?? null;
    expect(code('loc-canyon')).toBe(HEAT_REASON.COORDINATES_MISSING);
    expect(code('loc-vannoy')).toBe(HEAT_REASON.TURBIDITY_OUT_OF_COVERAGE);
    expect(code('loc-independent')).toBe(HEAT_REASON.FORECAST_UNAVAILABLE);
    expect(rows.find((r) => r.venueId === 'loc-independent').reason.message).toMatch(/404/);
    expect(code('loc-fivecanyons')).toBeNull();
    expect(rows).toHaveLength(40);
  });

  it('indoor, unknown, empty surfaces and a venue with no fields are each a refused row', () => {
    const { venues, fields } = referenceEstate();
    fields[0] = { ...fields[0], surfaceType: 'Indoor' };
    fields[1] = { ...fields[1], surfaceType: 'Clay' };
    fields[2] = { ...fields[2], surfaceType: '  ' };
    fields.splice(3, 1);
    const { rows } = run({ venues, fields });
    const codes = new Set(rows.map((r) => r.reason?.code));
    expect(codes).toEqual(
      new Set([
        HEAT_REASON.SURFACE_INDOOR,
        HEAT_REASON.SURFACE_UNKNOWN,
        HEAT_REASON.SURFACE_MISSING,
      ])
    );
    // The venue with no fields still appears, once.
    expect(rows.filter((r) => r.venueId === 'loc-fivecanyons')).toHaveLength(1);
  });

  it('a game on a retired field is a refused row', () => {
    const games = [{ id: 'g', fieldId: 'field-gone', start: at('10:00'), end: at('11:00') }];
    const [row] = run({ games }).rows;
    expect(row.reason.code).toBe(HEAT_REASON.FIELD_UNKNOWN);
  });

  it('no season timezone refuses the plan loudly', () => {
    const { venues, fields } = referenceEstate();
    expect(() =>
      buildHeatPlan({ date: REFERENCE_DATE, timeZone: null, venues, fields, games: [] })
    ).toThrow(/timezone/);
    expect(() =>
      buildHeatPlan({ date: REFERENCE_DATE, timeZone: 'Mars/Olympus', venues, fields, games: [] })
    ).toThrow(expect.objectContaining({ code: HEAT_REASON.TIMEZONE_UNAVAILABLE }));
  });
});

describe('daylight-saving days', () => {
  it('the fall-back day has 24 hour starts, 1:00 the first occurrence', () => {
    const day = localDayHours('2026-11-01', REFERENCE_TZ);
    expect(day.hours.every((h) => typeof h === 'number')).toBe(true);
    expect(new Date(day.hours[1]).toISOString()).toBe('2026-11-01T08:00:00.000Z');
    expect(new Date(day.hours[2]).toISOString()).toBe('2026-11-01T10:00:00.000Z');
    expect(day.dayEndMs - day.dayStartMs).toBe(25 * 3600000);
  });

  it('the spring-forward day is 23 hours long', () => {
    const day = localDayHours('2026-03-08', REFERENCE_TZ);
    expect(day.dayEndMs - day.dayStartMs).toBe(23 * 3600000);
  });
});

describe('stale forecasts', () => {
  it(`flags a forecast older than ${STALE_AFTER_HOURS} h at retrieval`, () => {
    const update = Date.parse('2026-10-02T08:31:00Z');
    expect(forecastAge(update, update + 12 * 3600000).stale).toBe(false);
    expect(forecastAge(update, update + 12 * 3600000 + 1).stale).toBe(true);
    expect(forecastAge(update, update + 3 * 3600000).ageHours).toBe(3);
  });
});

describe('provenance on every computed row', () => {
  it('carries endpoint, grid id, update and retrieval time, model, category and its source', () => {
    const { rows } = run({ category: 2 });
    for (const row of rows) {
      expect(row.provenance.forecast).toMatchObject({
        gridpointUrl: 'https://api.weather.gov/gridpoints/MTR/97,99',
        gridId: 'MTR',
        gridX: 97,
        gridY: 99,
        updateTime: '2026-10-02T08:31:00+00:00',
        retrievedAt: '2026-10-02T16:00:00.000Z',
      });
      expect(row.provenance.forecast.pointsUrl).toMatch(/^https:\/\/api\.weather\.gov\/points\//);
      expect(row.provenance.model.id).toBe(HEAT_MODEL.id);
      expect(row.provenance.model.version).toBe(HEAT_MODEL.version);
      expect(row.provenance.thresholds).toMatchObject({
        category: 2,
        categorySource: 'configured',
        sourceId: 'us-soccer-rtr',
      });
      expect(row.provenance.thresholds.note).toMatch(/89\.8/);
    }
  });

  it('the sources panel lists exactly the sources the provenance names, all in the catalogue', () => {
    const { rows } = run();
    const sources = sourcesForProvenance(rows.map((r) => r.provenance));
    const ids = sources.map((s) => s.id);
    expect(ids).toContain('nws-api');
    expect(ids).toContain('nws-wbgt');
    expect(ids).toContain('liljegren2008');
    expect(ids).toContain('us-soccer-rtr');
    expect(ids).toContain('reda2004');
    expect(ids).toEqual(Object.keys(HEAT_SOURCES)); // every catalogue entry is used
    for (const s of sources) expect(s.url).toMatch(/^https:\/\//);
  });

  it('a provenance naming an unknown source throws', () => {
    const { rows } = run();
    const p = structuredClone(rows[0].provenance);
    p.model.sourceIds = [...p.model.sourceIds, 'invented-2099'];
    expect(() => sourcesForProvenance([p])).toThrow(/invented-2099/);
  });
});
