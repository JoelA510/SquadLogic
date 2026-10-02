/**
 * The NWS client: caching of the points -> grid mapping, retry policy (5xx with
 * 2 s / 4 s backoff, one 6 s retry on 429, loud on any other 4xx), the headers
 * a CORS-simple request may carry, and one gridpoint request per grid cell.
 */
import { describe, it, expect } from 'vitest';

import {
  NwsError,
  POINTS_CACHE_TTL_MS,
  RATE_LIMIT_RETRY_MS,
  SERVER_RETRY_DELAYS_MS,
  createNwsClient,
  pointsUrlFor,
} from '../frontend/src/lib/nwsClient.js';

import { loadGridpointJson } from './helpers/heatFixtures.js';

const POINTS = {
  properties: {
    gridId: 'MTR',
    gridX: 97,
    gridY: 99,
    forecastGridData: 'https://api.weather.gov/gridpoints/MTR/97,99',
  },
};

const json = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: `status ${status}`,
  json: async () => body,
});

/** A scripted fetch: each URL pattern gets a queue of responses (or throws). */
function scriptedFetch(script) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const key = Object.keys(script).find((k) => url.includes(k));
    if (!key) throw new Error(`unscripted URL ${url}`);
    const queue = script[key];
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next() : next;
  };
  return { fetchImpl, calls };
}

function memoryStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    _m: m,
  };
}

const makeClient = (script, extra = {}) => {
  const sleeps = [];
  const { fetchImpl, calls } = scriptedFetch(script);
  let clock = Date.parse('2026-10-02T16:00:00Z');
  const client = createNwsClient({
    fetchImpl: /** @type {any} */ (fetchImpl),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    now: () => clock,
    storage: /** @type {any} */ (extra.storage ?? null),
  });
  return { client, calls, sleeps, advance: (ms) => (clock += ms) };
};

describe('request shape', () => {
  it('sends only Accept (no Feature-Flags, no User-Agent): a CORS-simple GET', async () => {
    const { client, calls } = makeClient({ '/points/': [json(200, POINTS)] });
    await client.getPoint(37.7046, -122.0524);
    expect(calls[0].url).toBe('https://api.weather.gov/points/37.7046,-122.0524');
    expect(calls[0].init.headers).toEqual({ Accept: 'application/geo+json' });
    expect(calls[0].init.method).toBe('GET');
  });

  it('formats coordinates to four decimals and refuses impossible ones', () => {
    expect(pointsUrlFor(37.7, -122.05)).toBe('https://api.weather.gov/points/37.7000,-122.0500');
    expect(() => pointsUrlFor(NaN, 0)).toThrow(NwsError);
    expect(() => pointsUrlFor(91, 0)).toThrow(NwsError);
  });

  it('fetches gridpoints with cache: no-store and stamps the retrieval time', async () => {
    const { client, calls } = makeClient({ '/gridpoints/': [json(200, loadGridpointJson())] });
    const g = await client.getGridpoint('https://api.weather.gov/gridpoints/MTR/97,99');
    expect(calls[0].init.cache).toBe('no-store');
    expect(g.retrievedAt).toBe('2026-10-02T16:00:00.000Z');
    expect(g.json.properties.gridId).toBe('MTR');
  });
});

describe('points cache', () => {
  it('serves the mapping from memory, then from storage, until 24 h pass', async () => {
    const storage = memoryStorage();
    const first = makeClient({ '/points/': [json(200, POINTS)] }, { storage });
    await first.client.getPoint(37.7, -122.05);
    expect((await first.client.getPoint(37.7, -122.05)).fromCache).toBe(true);
    expect(first.calls).toHaveLength(1);

    // A new client (a reload) reads the stored entry.
    const second = makeClient({ '/points/': [json(200, POINTS)] }, { storage });
    expect((await second.client.getPoint(37.7, -122.05)).fromCache).toBe(true);
    expect(second.calls).toHaveLength(0);

    second.advance(POINTS_CACHE_TTL_MS + 1);
    expect((await second.client.getPoint(37.7, -122.05)).fromCache).toBe(false);
    expect(second.calls).toHaveLength(1);
  });

  it('ignores a stored entry that points anywhere but api.weather.gov', async () => {
    const storage = memoryStorage();
    storage.setItem(
      'sl-nws-points:37.7000,-122.0500',
      JSON.stringify({
        gridpointUrl: 'https://evil.example/x',
        cachedAt: Date.parse('2026-10-02T15:00:00Z'),
      })
    );
    const { client, calls } = makeClient({ '/points/': [json(200, POINTS)] }, { storage });
    const p = await client.getPoint(37.7, -122.05);
    expect(p.gridpointUrl).toBe('https://api.weather.gov/gridpoints/MTR/97,99');
    expect(calls).toHaveLength(1);
  });

  it('refuses a /points answer without a usable forecastGridData', async () => {
    const bad = {
      properties: { forecastGridData: 'https://elsewhere.example/gridpoints/MTR/1,2' },
    };
    const { client } = makeClient({ '/points/': [json(200, bad)] });
    await expect(client.getPoint(37.7, -122.05)).rejects.toMatchObject({ kind: 'shape' });
  });
});

describe('retry policy', () => {
  it('retries 5xx twice with 2 s then 4 s backoff, then succeeds', async () => {
    const { client, calls, sleeps } = makeClient({
      '/points/': [json(503, { title: 'Service Unavailable' }), json(502, {}), json(200, POINTS)],
    });
    await client.getPoint(37.7, -122.05);
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([...SERVER_RETRY_DELAYS_MS]);
  });

  it('fails loudly after three 5xx attempts', async () => {
    const { client, calls } = makeClient({
      '/points/': [json(500, { detail: 'upstream timeout' })],
    });
    await expect(client.getPoint(37.7, -122.05)).rejects.toThrow(
      /NWS 500 after 3 attempts: upstream timeout/
    );
    expect(calls).toHaveLength(3);
  });

  it('retries a network failure the same way', async () => {
    const { client, calls } = makeClient({
      '/points/': [new TypeError('Failed to fetch'), json(200, POINTS)],
    });
    await client.getPoint(37.7, -122.05);
    expect(calls).toHaveLength(2);
  });

  it('a 4xx fails at once with the problem+json detail', async () => {
    const { client, calls, sleeps } = makeClient({
      '/points/': [
        json(404, {
          type: 'https://api.weather.gov/problems/InvalidPoint',
          title: 'Data Unavailable For Requested Point',
          status: 404,
          detail: 'Unable to provide data for requested point 10,10',
        }),
      ],
    });
    const err = await client.getPoint(10, 10).catch((e) => e);
    expect(err).toBeInstanceOf(NwsError);
    expect(err).toMatchObject({ kind: 'client', status: 404 });
    expect(err.message).toMatch(/NWS 404: Unable to provide data for requested point 10,10/);
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it('a 429 is retried once after 6 s', async () => {
    const { client, calls, sleeps } = makeClient({
      '/points/': [json(429, {}), json(200, POINTS)],
    });
    await client.getPoint(37.7, -122.05);
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([RATE_LIMIT_RETRY_MS]);
    expect(RATE_LIMIT_RETRY_MS).toBe(6000);
  });

  it('a second 429 fails', async () => {
    const { client, calls } = makeClient({
      '/points/': [json(429, { title: 'Too Many Requests' })],
    });
    await expect(client.getPoint(37.7, -122.05)).rejects.toMatchObject({
      kind: 'rate-limit',
      status: 429,
    });
    expect(calls).toHaveLength(2);
  });
});

describe('getForecasts', () => {
  it('makes one gridpoint request per grid cell and reports per-venue failures without throwing', async () => {
    const pointsFor = (x) => ({
      properties: {
        gridId: 'MTR',
        gridX: x,
        gridY: 99,
        forecastGridData: `https://api.weather.gov/gridpoints/MTR/${x},99`,
      },
    });
    const { client, calls } = makeClient({
      '/points/37.7000,-122.0500': [json(200, pointsFor(97))],
      '/points/37.7100,-122.0600': [json(200, pointsFor(97))],
      '/points/10.0000,10.0000': [
        json(404, { detail: 'Unable to provide data for requested point 10,10' }),
      ],
      '/gridpoints/MTR/97,99': [json(200, loadGridpointJson())],
    });
    const out = await client.getForecasts([
      { id: 'a', latitude: 37.7, longitude: -122.05 },
      { id: 'b', latitude: 37.71, longitude: -122.06 },
      { id: 'c', latitude: 10, longitude: 10 },
    ]);
    expect(calls.filter((c) => c.url.includes('/gridpoints/'))).toHaveLength(1);
    expect(out.a.source.gridpointUrl).toBe('https://api.weather.gov/gridpoints/MTR/97,99');
    expect(out.b.source.pointsUrl).toBe('https://api.weather.gov/points/37.7100,-122.0600');
    expect(out.c.error.message).toMatch(/404/);
    expect(out.a.json).toBe(out.b.json);
  });
});

describe('getPoint in-flight sharing', () => {
  it('venues on the same coordinate pair share one /points request', async () => {
    const { client, calls } = makeClient({
      '/points/': [json(200, POINTS)],
      '/gridpoints/': [json(200, { properties: {} })],
    });
    const out = await client.getForecasts([
      { id: 'a', latitude: 37.7046, longitude: -122.0524 },
      { id: 'b', latitude: 37.7046, longitude: -122.0524 },
    ]);
    expect(calls.filter((c) => c.url.includes('/points/'))).toHaveLength(1);
    expect(out.a.source.gridpointUrl).toBe(out.b.source.gridpointUrl);
  });

  it('negative control: distinct coordinate pairs each get their own request', async () => {
    const { client, calls } = makeClient({
      '/points/': [json(200, POINTS)],
      '/gridpoints/': [json(200, { properties: {} })],
    });
    await client.getForecasts([
      { id: 'a', latitude: 37.7046, longitude: -122.0524 },
      { id: 'b', latitude: 37.71, longitude: -122.06 },
    ]);
    expect(calls.filter((c) => c.url.includes('/points/'))).toHaveLength(2);
  });
});
