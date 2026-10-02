/**
 * useHeatForecast end to end over mocked I/O: the estate and game run from a
 * mocked Supabase, the NWS client returning the reference fixture, the real
 * turbidity table, and the real core model. The golden Canyon 11:00 value is
 * the proof the wiring passes the right inputs through.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

import { useHeatForecast } from '../frontend/src/hooks/useHeatForecast.js';
import { supabase } from '../frontend/src/lib/supabaseClient.js';
import { useOrganization } from '../frontend/src/contexts/OrganizationContext.jsx';
import { useGameSummary } from '../frontend/src/hooks/useGameSummary.js';
import { useGameAssignments } from '../frontend/src/hooks/useGameAssignments.js';

import { REFERENCE_SITES, loadGridpointJson, loadTurbidity } from './helpers/heatFixtures.js';

const nws = vi.hoisted(() => ({ getForecasts: vi.fn() }));

vi.mock('../frontend/src/lib/supabaseClient.js', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
}));
vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: vi.fn(),
}));
vi.mock('../frontend/src/hooks/useGameSummary.js', () => ({ useGameSummary: vi.fn() }));
vi.mock('../frontend/src/hooks/useGameAssignments.js', () => ({ useGameAssignments: vi.fn() }));
vi.mock('../frontend/src/lib/nwsClient.js', () => ({
  createNwsClient: () => ({ getForecasts: nws.getForecasts }),
}));
vi.mock('../frontend/src/lib/turbidityTable.js', () => ({
  loadTurbidityTable: () => Promise.resolve(loadTurbidity()),
}));
vi.mock('../frontend/src/lib/logger.js', () => ({ logger: { error: vi.fn() } }));

const canyon = REFERENCE_SITES[0];
const vannoy = REFERENCE_SITES[1];

const LOCATIONS = [
  {
    id: 'loc-c',
    name: canyon.name,
    latitude: canyon.latitude,
    longitude: canyon.longitude,
    effective_to: null,
  },
  // Numeric columns may arrive as strings; the hook converts.
  {
    id: 'loc-v',
    name: vannoy.name,
    latitude: String(vannoy.latitude),
    longitude: String(vannoy.longitude),
    effective_to: null,
  },
  // Retired before the date: not on screen.
  {
    id: 'loc-old',
    name: 'Old Park',
    latitude: 37.7,
    longitude: -122.1,
    effective_to: '2026-09-01',
  },
];
const FIELDS = [
  {
    id: 'f-c',
    name: 'Canyon Turf',
    location_id: 'loc-c',
    surface_type: 'Turf',
    active: true,
    effective_to: null,
  },
  {
    id: 'f-v',
    name: 'Vannoy Grass',
    location_id: 'loc-v',
    surface_type: 'Grass',
    active: true,
    effective_to: null,
  },
  {
    id: 'f-off',
    name: 'Closed',
    location_id: 'loc-v',
    surface_type: 'Grass',
    active: false,
    effective_to: null,
  },
];

function tables({ locations = LOCATIONS, fields = FIELDS, settings = null, fail = null } = {}) {
  vi.mocked(supabase.from).mockImplementation((table) => {
    const result =
      fail === table
        ? { data: null, error: { message: `${table} refused` } }
        : {
            data: table === 'locations' ? locations : table === 'fields' ? fields : null,
            error: null,
          };
    const builder = {
      select: () => builder,
      eq: () => builder,
      order: () => Promise.resolve(result),
      maybeSingle: () =>
        Promise.resolve(
          table === 'organization_heat_settings' ? { data: settings, error: null } : result
        ),
    };
    return /** @type {any} */ (builder);
  });
}

const fixtureForecast = (venues) =>
  Object.fromEntries(
    venues.map((v) => [
      v.id,
      {
        json: loadGridpointJson(),
        source: {
          pointsUrl: `https://api.weather.gov/points/${v.latitude.toFixed(4)},${v.longitude.toFixed(4)}`,
          gridpointUrl: 'https://api.weather.gov/gridpoints/MTR/97,99',
          retrievedAt: '2026-10-02T16:00:00.000Z',
        },
      },
    ])
  );

beforeEach(() => {
  vi.mocked(useOrganization).mockReturnValue(
    /** @type {any} */ ({
      currentOrganization: { id: 'org-1' },
      currentSeasonSetting: { timezone: 'America/Los_Angeles' },
    })
  );
  vi.mocked(useGameSummary).mockReturnValue(
    /** @type {any} */ ({ runId: 'run-1', loading: false, error: null })
  );
  vi.mocked(useGameAssignments).mockReturnValue(
    /** @type {any} */ ({ assignments: [], loading: false, error: null })
  );
  nws.getForecasts.mockReset();
  nws.getForecasts.mockImplementation(async (venues) => fixtureForecast(venues));
  tables();
});

describe('useHeatForecast', () => {
  it('no games: computes every live venue x surface x hour from the NWS fixture', async () => {
    const { result } = renderHook(() => useHeatForecast('2026-10-03'));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.mode).toBe('hours');
    expect(result.current.rows).toHaveLength(20);
    expect(result.current.rows.every((r) => r.status === 'computed')).toBe(true);
    const c11 = result.current.rows.find((r) => r.venueId === 'loc-c' && r.window.localHour === 11);
    expect(Math.abs(c11.wbgtF - 77.3)).toBeLessThanOrEqual(0.6);
    // The retired venue was never sent to NWS.
    expect(nws.getForecasts.mock.calls[0][0].map((v) => v.id).sort()).toEqual(['loc-c', 'loc-v']);
    expect(result.current.category).toBe(1);
    expect(result.current.categorySource).toBe('default');
    expect(result.current.grids).toEqual([
      expect.objectContaining({ gridId: 'MTR', gridX: 97, gridY: 99, stale: false }),
    ]);
    expect(result.current.sources.map((s) => s.id)).toContain('liljegren2008');
  });

  it('games: rows follow the current run, and the org category is applied', async () => {
    tables({ settings: { threshold_category: 3, guidance_links: [] } });
    vi.mocked(useGameAssignments).mockReturnValue(
      /** @type {any} */ ({
        assignments: [
          {
            id: 'g1',
            fieldId: 'f-c',
            start: '2026-10-03T20:00:00+00:00',
            end: '2026-10-03T21:30:00+00:00',
          },
        ],
        loading: false,
        error: null,
      })
    );
    const { result } = renderHook(() => useHeatForecast('2026-10-03'));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.mode).toBe('games');
    expect(result.current.rows).toHaveLength(1);
    const [row] = result.current.rows;
    expect(row.hourly.map((h) => h.localHour)).toEqual([13, 14]);
    expect(row.usedHour).toBe(13);
    expect(row.provenance.thresholds).toMatchObject({ category: 3, categorySource: 'configured' });
  });

  it('flags a forecast older than 12 h at retrieval as stale', async () => {
    nws.getForecasts.mockImplementation(async (venues) => {
      const out = fixtureForecast(venues);
      for (const v of Object.values(out)) v.source.retrievedAt = '2026-10-02T21:00:00.000Z';
      return out;
    });
    const { result } = renderHook(() => useHeatForecast('2026-10-03'));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.grids[0].stale).toBe(true);
    expect(result.current.grids[0].ageHours).toBeCloseTo(12.483, 2);
  });

  it('an NWS failure for a venue is a refused row with the NWS message', async () => {
    nws.getForecasts.mockImplementation(async (venues) => ({
      ...fixtureForecast(venues.filter((v) => v.id !== 'loc-v')),
      'loc-v': { error: { message: 'NWS 404: Unable to provide data for requested point' } },
    }));
    const { result } = renderHook(() => useHeatForecast('2026-10-03'));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    const v = result.current.rows.filter((r) => r.venueId === 'loc-v');
    expect(v).toHaveLength(10);
    expect(v.every((r) => r.reason?.code === 'HEAT_FORECAST_UNAVAILABLE')).toBe(true);
    expect(v[0].reason.message).toMatch(/404/);
  });

  it('a malformed NWS body is refused per venue, not trusted', async () => {
    nws.getForecasts.mockImplementation(async (venues) => {
      const out = fixtureForecast(venues);
      out['loc-c'].json = { properties: { gridId: 'MTR' } };
      return out;
    });
    const { result } = renderHook(() => useHeatForecast('2026-10-03'));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    const c = result.current.rows.find((r) => r.venueId === 'loc-c');
    expect(c.reason.message).toMatch(/NWS response refused/);
  });

  it('no season timezone is a plan error, not a guess', async () => {
    vi.mocked(useOrganization).mockReturnValue(
      /** @type {any} */ ({
        currentOrganization: { id: 'org-1' },
        currentSeasonSetting: { timezone: null },
      })
    );
    const { result } = renderHook(() => useHeatForecast('2026-10-03'));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.planError).toMatch(/timezone/);
    expect(result.current.rows).toEqual([]);
    expect(nws.getForecasts).not.toHaveBeenCalled();
  });

  it('a failed estate read is an error', async () => {
    tables({ fail: 'fields' });
    const { result } = renderHook(() => useHeatForecast('2026-10-03'));
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error).toBe('fields refused');
  });

  it('a failed game-run read is an error, not "no games"', async () => {
    vi.mocked(useGameAssignments).mockReturnValue(
      /** @type {any} */ ({
        assignments: [],
        loading: false,
        error: new Error('game_assignments refused'),
      })
    );
    const { result } = renderHook(() => useHeatForecast('2026-10-03'));
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error).toMatch(
      /game schedule could not be read: game_assignments refused/
    );
  });
});
