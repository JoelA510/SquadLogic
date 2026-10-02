import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  HeatError,
  buildHeatPlan,
  computeHeatRows,
  forecastAge,
  parseGridpoint,
  sourcesForProvenance,
  turbidityCovers,
} from '@squadlogic/core/heat/index.js';
import { isLiveOn } from '@squadlogic/core/facility/index.js';
import { supabase } from '../lib/supabaseClient.js';
import { createNwsClient } from '../lib/nwsClient.js';
import { loadTurbidityTable } from '../lib/turbidityTable.js';
import { logger } from '../lib/logger.js';
import { useOrganization } from '../contexts/OrganizationContext.jsx';
import { useGameSummary } from './useGameSummary.js';
import { useGameAssignments } from './useGameAssignments.js';
import { useOrgHeatSettings } from './useOrgHeatSettings.js';

/** One client per page load, so the points cache outlives a date change. */
let sharedClient = null;
const nwsClient = () => (sharedClient ??= createNwsClient());

/**
 * The field heat-stress forecast for one game day.
 *
 * Inputs, each from its existing reader:
 * - the estate: `locations` (with coordinates) and `fields` (with
 *   `surface_type`), live on `date` by `isLiveOn` -- the one reading of an
 *   effective window;
 * - the current game run's `game_assignments`, the same source the exports
 *   read (`useGameSummary` -> `useGameAssignments`);
 * - the season's clock, `season_settings.timezone`;
 * - the org's threshold category (`useOrgHeatSettings`).
 *
 * Then the NWS forecast for every venue a row needs (browser ->
 * api.weather.gov, one gridpoint request per grid cell), the turbidity table,
 * and `computeHeatRows`. Every refusal is a row or a `planError`; nothing is
 * dropped and nothing is filled in.
 *
 * @param {string} date - `YYYY-MM-DD` on the season's clock
 */
export function useHeatForecast(date) {
  const { currentOrganization, currentSeasonSetting } = useOrganization() || {};
  const orgId = currentOrganization?.id ?? null;
  const timeZone = currentSeasonSetting?.timezone ?? null;
  const settings = useOrgHeatSettings();
  const { runId, loading: runLoading, error: runError } = useGameSummary();
  const { assignments, loading: gamesLoading, error: gamesError } = useGameAssignments(runId);

  const [estate, setEstate] = useState({ venues: [], fields: [], loading: true, error: null });
  const [result, setResult] = useState({
    status: /** @type {'idle'|'loading'|'ready'|'error'} */ ('idle'),
    mode: /** @type {'games'|'hours'|null} */ (null),
    rows: [],
    forecasts: /** @type {Record<string, any>} */ ({}),
    planError: /** @type {string|null} */ (null),
    error: /** @type {string|null} */ (null),
  });
  const estateRequest = useRef(0);
  const computeRequest = useRef(0);

  const loadEstate = useCallback(async () => {
    const request = ++estateRequest.current;
    try {
      if (!orgId) {
        setEstate({ venues: [], fields: [], loading: false, error: null });
        return;
      }
      setEstate((e) => ({ ...e, loading: true, error: null }));
      const [locs, flds] = await Promise.all([
        supabase
          .from('locations')
          .select('id, name, latitude, longitude, effective_to')
          .eq('organization_id', orgId)
          .order('name'),
        supabase
          .from('fields')
          .select('id, name, location_id, surface_type, active, effective_to')
          .eq('organization_id', orgId)
          .order('name'),
      ]);
      if (request !== estateRequest.current) return;
      const err = locs.error || flds.error;
      if (err) throw err;
      setEstate({ venues: locs.data || [], fields: flds.data || [], loading: false, error: null });
    } catch (err) {
      if (request !== estateRequest.current) return;
      logger.error('Error fetching the estate for the heat forecast:', err);
      setEstate({
        venues: [],
        fields: [],
        loading: false,
        error: err?.message || 'Venues could not be read.',
      });
    }
  }, [orgId]);

  useEffect(() => {
    loadEstate();
  }, [loadEstate]);

  /** The next compute refetches every gridpoint (Refresh), not the in-page copy. */
  const forceNextFetch = useRef(false);
  const takeForce = () => {
    const force = forceNextFetch.current;
    forceNextFetch.current = false;
    return force;
  };

  /** Re-read the estate and refetch NWS; the forecast recomputes from both. */
  const refresh = useCallback(() => {
    forceNextFetch.current = true;
    loadEstate();
  }, [loadEstate]);

  const inputsLoading = estate.loading || settings.loading || runLoading || gamesLoading;
  const inputError =
    estate.error ||
    settings.error ||
    (runError ? `The game schedule could not be read: ${runError.message ?? runError}` : null) ||
    (gamesError
      ? `The game schedule could not be read: ${gamesError.message ?? gamesError}`
      : null);

  const compute = useCallback(async () => {
    const request = ++computeRequest.current;
    const stale = () => request !== computeRequest.current;
    try {
      if (!orgId) {
        // No organisation: drop the previous org's rows rather than keep them.
        setResult({
          status: 'idle',
          mode: null,
          rows: [],
          forecasts: {},
          planError: null,
          error: null,
        });
        return;
      }
      if (inputsLoading) return;
      if (inputError) {
        setResult({
          status: 'error',
          mode: null,
          rows: [],
          forecasts: {},
          planError: null,
          error: inputError,
        });
        return;
      }
      setResult((r) => ({ ...r, status: 'loading', error: null }));
      const live = (effectiveTo) =>
        isLiveOn({ effectiveFrom: null, effectiveTo: effectiveTo ?? null }, date);
      const toNumber = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
      const venues = estate.venues
        .filter((l) => live(l.effective_to))
        .map((l) => ({
          id: String(l.id),
          name: l.name,
          latitude: toNumber(l.latitude),
          longitude: toNumber(l.longitude),
        }));
      const fields = estate.fields
        .filter((f) => f.active !== false && live(f.effective_to))
        .map((f) => ({
          id: String(f.id),
          name: f.name,
          locationId: String(f.location_id),
          surfaceType: f.surface_type ?? null,
        }));
      const games = (assignments || [])
        // A game with no field is kept: the plan refuses it as a row rather
        // than the screen losing it.
        .map((a) => ({
          id: String(a.id),
          fieldId: a.fieldId ? String(a.fieldId) : null,
          start: a.start ?? null,
          end: a.end ?? null,
        }));

      let plan;
      try {
        plan = buildHeatPlan({ date, timeZone, venues, fields, games });
      } catch (err) {
        if (stale()) return;
        if (err instanceof HeatError) {
          setResult({
            status: 'ready',
            mode: null,
            rows: [],
            forecasts: {},
            planError: err.message,
            error: null,
          });
          return;
        }
        throw err;
      }

      const venueById = new Map(venues.map((v) => [v.id, v]));
      const needed = new Map();
      for (const item of plan.items) {
        if (item.refusal) continue;
        const v = venueById.get(item.venueId);
        if (
          v &&
          v.latitude !== null &&
          v.longitude !== null &&
          turbidityCovers(v.latitude, v.longitude)
        ) {
          needed.set(v.id, v);
        }
      }

      const [turbidity, raw] = await Promise.all([
        loadTurbidityTable(),
        needed.size
          ? nwsClient().getForecasts([...needed.values()], { force: takeForce() })
          : Promise.resolve({}),
      ]);
      /** @type {Record<string, any>} */
      const forecasts = {};
      for (const [venueId, entry] of Object.entries(raw)) {
        if (entry.error) {
          forecasts[venueId] = { error: entry.error };
          continue;
        }
        try {
          forecasts[venueId] = { gridpoint: parseGridpoint(entry.json), source: entry.source };
        } catch (err) {
          forecasts[venueId] = { error: { message: `NWS response refused: ${err.message}` } };
        }
      }
      const rows = computeHeatRows({
        plan,
        venues,
        category: settings.thresholdCategory,
        categorySource: settings.source,
        forecasts,
        turbidity,
      });
      if (!stale()) {
        setResult({
          status: 'ready',
          mode: plan.mode,
          rows,
          forecasts,
          planError: null,
          error: null,
        });
      }
    } catch (err) {
      if (stale()) return;
      logger.error('Heat forecast failed:', err);
      setResult({
        status: 'error',
        mode: null,
        rows: [],
        forecasts: {},
        planError: null,
        error: err?.message || 'The heat forecast could not be computed.',
      });
    }
  }, [
    orgId,
    date,
    timeZone,
    inputsLoading,
    inputError,
    estate,
    assignments,
    settings.thresholdCategory,
    settings.source,
  ]);

  useEffect(() => {
    compute();
  }, [compute]);

  /** One entry per distinct NWS grid the rows used: update/retrieval time and staleness. */
  const grids = useMemo(() => {
    const byUrl = new Map();
    for (const fc of Object.values(result.forecasts)) {
      if (!fc.gridpoint || !fc.source) continue;
      const url = fc.source.gridpointUrl;
      if (byUrl.has(url)) continue;
      const age = forecastAge(fc.gridpoint.meta.updateTimeMs, Date.parse(fc.source.retrievedAt));
      byUrl.set(url, {
        gridpointUrl: url,
        gridId: fc.gridpoint.meta.gridId,
        gridX: fc.gridpoint.meta.gridX,
        gridY: fc.gridpoint.meta.gridY,
        updateTime: fc.gridpoint.meta.updateTime,
        retrievedAt: fc.source.retrievedAt,
        ageHours: age.ageHours,
        stale: age.stale,
      });
    }
    return [...byUrl.values()];
  }, [result.forecasts]);

  const sources = useMemo(
    () => sourcesForProvenance(result.rows.filter((r) => r.provenance).map((r) => r.provenance)),
    [result.rows]
  );

  return {
    status: inputsLoading && result.status !== 'error' ? 'loading' : result.status,
    mode: result.mode,
    rows: result.rows,
    planError: result.planError,
    error: result.error,
    grids,
    sources,
    timeZone,
    category: settings.thresholdCategory,
    categorySource: settings.source,
    guidanceLinks: settings.guidanceLinks,
    refresh,
  };
}
