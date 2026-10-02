/**
 * NWS API client for the heat forecast: browser -> api.weather.gov, nothing in
 * between.
 *
 * Checked live on 2026-10-02 (see docs/architecture/heat-forecast.md):
 * - `/points` and `/gridpoints` answer `access-control-allow-origin: *`, and a
 *   GET with only `Accept: application/geo+json` is a CORS-simple request, so
 *   there is no preflight. The preflight allows only `API-Key, User-Agent`:
 *   this client must never send `Feature-Flags`.
 * - NWS requires a User-Agent ("This string can be anything"). Browsers send
 *   their own and scripts cannot replace it, so the app cannot identify itself
 *   beyond that. An empty UA gets 403; a browser UA gets 200.
 * - CSP: `https://api.weather.gov` is in `connect-src` (vercel.json,
 *   docs/security/csp.md).
 *
 * Behaviour:
 * - `/points` -> grid mapping cached per coordinate pair for 24 h (memory +
 *   sessionStorage); NWS asks clients to re-check the mapping periodically.
 * - 5xx and network failures: 3 attempts, 2 s then 4 s apart (the reference's
 *   backoff).
 * - 429: one retry after 6 s (approved deviation; the reference failed on every
 *   4xx). A second 429 fails.
 * - Any other 4xx fails at once with the problem+json `title`/`detail`.
 * - A `/points` answer whose `forecastGridData` is not an api.weather.gov
 *   gridpoint URL fails rather than being followed.
 * - Gridpoint responses are fetched with `cache: 'no-store'`, so the recorded
 *   retrieval time is when the bytes left NWS, not a browser-cache hit.
 *
 * Parsing and validation of the gridpoint body live in core
 * (`@squadlogic/core/heat`); this module only moves bytes and says why it
 * could not.
 *
 * @module lib/nwsClient
 */

export const NWS_ORIGIN = 'https://api.weather.gov';
export const POINTS_CACHE_TTL_MS = 24 * 3600 * 1000;
export const SERVER_RETRY_DELAYS_MS = Object.freeze([2000, 4000]);
export const RATE_LIMIT_RETRY_MS = 6000;
const STORAGE_PREFIX = 'sl-nws-points:';
const GRIDPOINT_URL = /^https:\/\/api\.weather\.gov\/gridpoints\/[A-Z]{3}\/\d+,\d+$/;

/** A failure talking to NWS. `kind` says whether waiting could help. */
export class NwsError extends Error {
  /**
   * @param {string} message
   * @param {{ kind: 'client'|'rate-limit'|'server'|'network'|'shape', url: string,
   *   status?: number|null, detail?: string|null }} info
   */
  constructor(message, { kind, url, status = null, detail = null }) {
    super(message);
    this.name = 'NwsError';
    this.kind = kind;
    this.url = url;
    this.status = status;
    this.detail = detail;
  }
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function defaultStorage() {
  try {
    return typeof window !== 'undefined' ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

/** The `/points` URL NWS expects: four decimals, no trailing zeros stripped. */
export function pointsUrlFor(latitude, longitude) {
  if (
    typeof latitude !== 'number' ||
    typeof longitude !== 'number' ||
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    Math.abs(latitude) > 90 ||
    Math.abs(longitude) > 180
  ) {
    throw new NwsError(`invalid coordinates ${String(latitude)}, ${String(longitude)}`, {
      kind: 'client',
      url: `${NWS_ORIGIN}/points`,
    });
  }
  return `${NWS_ORIGIN}/points/${latitude.toFixed(4)},${longitude.toFixed(4)}`;
}

/**
 * @param {{ fetchImpl?: typeof fetch, sleep?: (ms: number) => Promise<void>,
 *   now?: () => number, storage?: Storage|null }} [deps]
 */
export function createNwsClient(deps = {}) {
  const fetchImpl =
    deps.fetchImpl ?? (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null);
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? (() => Date.now());
  const storage = deps.storage === undefined ? defaultStorage() : deps.storage;
  /** @type {Map<string, { gridpointUrl: string, gridId: string, gridX: number, gridY: number, cachedAt: number }>} */
  const pointsMemo = new Map();
  /** In-flight `/points` lookups, so venues sharing a coordinate pair share one request. */
  const pointsInFlight = new Map();

  /**
   * @param {string} url
   * @param {RequestInit} [init]
   * @returns {Promise<{ json: any, receivedAt: number }>}
   */
  async function getJson(url, init = {}) {
    if (!fetchImpl) throw new NwsError('fetch is not available', { kind: 'network', url });
    let serverFailures = 0;
    let rateLimited = false;
    for (;;) {
      let response;
      try {
        response = await fetchImpl(url, {
          ...init,
          method: 'GET',
          headers: { Accept: 'application/geo+json' },
        });
      } catch (err) {
        if (serverFailures < SERVER_RETRY_DELAYS_MS.length) {
          await sleep(SERVER_RETRY_DELAYS_MS[serverFailures]);
          serverFailures += 1;
          continue;
        }
        throw new NwsError(
          `NWS API unreachable after ${serverFailures + 1} attempts: ${url}: ${err?.message ?? err}`,
          { kind: 'network', url }
        );
      }
      if (response.ok) {
        try {
          return { json: await response.json(), receivedAt: now() };
        } catch {
          throw new NwsError(`NWS API returned a body that is not JSON: ${url}`, {
            kind: 'shape',
            url,
            status: response.status,
          });
        }
      }
      const problem = await response.json().catch(() => null);
      const detail =
        problem && (problem.detail || problem.title)
          ? String(problem.detail || problem.title)
          : null;
      if (response.status === 429 && !rateLimited) {
        rateLimited = true;
        await sleep(RATE_LIMIT_RETRY_MS);
        continue;
      }
      if (response.status >= 500 && serverFailures < SERVER_RETRY_DELAYS_MS.length) {
        await sleep(SERVER_RETRY_DELAYS_MS[serverFailures]);
        serverFailures += 1;
        continue;
      }
      const kind =
        response.status === 429 ? 'rate-limit' : response.status >= 500 ? 'server' : 'client';
      const tries =
        kind === 'server'
          ? ` after ${serverFailures + 1} attempts`
          : kind === 'rate-limit'
            ? ' after one retry'
            : '';
      throw new NwsError(
        `NWS ${response.status}${tries}: ${detail ?? response.statusText ?? 'request failed'}`,
        {
          kind,
          url,
          status: response.status,
          detail,
        }
      );
    }
  }

  function readStored(key) {
    if (!storage) return null;
    try {
      const raw = storage.getItem(STORAGE_PREFIX + key);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function writeStored(key, value) {
    if (!storage) return;
    try {
      storage.setItem(STORAGE_PREFIX + key, JSON.stringify(value));
    } catch {
      // Storage full or blocked: the memo still holds it for this page.
    }
  }

  /**
   * The grid mapping for a coordinate pair, from cache when fresh.
   *
   * @param {number} latitude
   * @param {number} longitude
   */
  async function getPoint(latitude, longitude) {
    const pointsUrl = pointsUrlFor(latitude, longitude);
    const key = pointsUrl.slice(`${NWS_ORIGIN}/points/`.length);
    const fresh = (entry) => entry && now() - entry.cachedAt < POINTS_CACHE_TTL_MS;
    const memo = pointsMemo.get(key);
    if (fresh(memo)) return { pointsUrl, ...memo, fromCache: true };
    const stored = readStored(key);
    if (fresh(stored) && GRIDPOINT_URL.test(stored.gridpointUrl ?? '')) {
      pointsMemo.set(key, stored);
      return { pointsUrl, ...stored, fromCache: true };
    }
    let inFlight = pointsInFlight.get(key);
    if (!inFlight) {
      inFlight = (async () => {
        const { json } = await getJson(pointsUrl);
        const p = json?.properties ?? {};
        const gridpointUrl = p.forecastGridData;
        if (typeof gridpointUrl !== 'string' || !GRIDPOINT_URL.test(gridpointUrl)) {
          throw new NwsError(`NWS /points gave no usable forecastGridData for ${key}`, {
            kind: 'shape',
            url: pointsUrl,
          });
        }
        const entry = {
          gridpointUrl,
          gridId: String(p.gridId ?? ''),
          gridX: Number(p.gridX),
          gridY: Number(p.gridY),
          cachedAt: now(),
        };
        pointsMemo.set(key, entry);
        writeStored(key, entry);
        return entry;
      })().finally(() => pointsInFlight.delete(key));
      pointsInFlight.set(key, inFlight);
    }
    const entry = await inFlight;
    return { pointsUrl, ...entry, fromCache: false };
  }

  /**
   * The raw gridpoint forecast at a grid URL from `/points`.
   *
   * @param {string} gridpointUrl
   */
  async function getGridpoint(gridpointUrl) {
    if (!GRIDPOINT_URL.test(gridpointUrl)) {
      throw new NwsError(`not an api.weather.gov gridpoint URL: ${gridpointUrl}`, {
        kind: 'client',
        url: gridpointUrl,
      });
    }
    const { json, receivedAt } = await getJson(gridpointUrl, { cache: 'no-store' });
    return { json, retrievedAt: new Date(receivedAt).toISOString() };
  }

  /**
   * Forecasts for many venues, one gridpoint request per distinct grid cell.
   * Never throws: each venue gets either `{ json, source }` or `{ error }`.
   *
   * @param {Array<{ id: string, latitude: number, longitude: number }>} venues
   * @returns {Promise<Record<string, { json?: any, source?: { pointsUrl: string,
   *   gridpointUrl: string, retrievedAt: string }, error?: { message: string, kind?: string } }>>}
   */
  async function getForecasts(venues) {
    /** @type {Record<string, any>} */
    const out = {};
    const points = await Promise.all(
      venues.map(async (v) => {
        try {
          return { venue: v, point: await getPoint(v.latitude, v.longitude) };
        } catch (err) {
          out[v.id] = { error: { message: err?.message ?? String(err), kind: err?.kind } };
          return null;
        }
      })
    );
    /** @type {Map<string, Array<{ venue: any, point: any }>>} */
    const byGrid = new Map();
    for (const entry of points) {
      if (!entry) continue;
      const list = byGrid.get(entry.point.gridpointUrl) ?? [];
      list.push(entry);
      byGrid.set(entry.point.gridpointUrl, list);
    }
    await Promise.all(
      [...byGrid.entries()].map(async ([gridpointUrl, list]) => {
        try {
          const { json, retrievedAt } = await getGridpoint(gridpointUrl);
          for (const { venue, point } of list) {
            out[venue.id] = {
              json,
              source: { pointsUrl: point.pointsUrl, gridpointUrl, retrievedAt },
            };
          }
        } catch (err) {
          for (const { venue } of list) {
            out[venue.id] = { error: { message: err?.message ?? String(err), kind: err?.kind } };
          }
        }
      })
    );
    return out;
  }

  return { getPoint, getGridpoint, getForecasts };
}
