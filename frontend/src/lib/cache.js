/**
 * In-memory TTL cache — Phase 9 Production Hardening
 *
 * A lightweight cache with TTL-based expiration and optional
 * stale-while-revalidate support. No external dependencies — a plain Map.
 *
 * It backs Edge Function invocations only (`edgeFunctionCache` and `cachedInvoke`
 * below). The dashboard's Supabase reads are deliberately uncached: they poll a
 * running run, and the pages refetch right after a save, so a 30 s window would
 * show a schedule or roster from before the save. (A `dashboardCache` instance sat
 * here unused until DS-14 removed it; see the 2026-10 remediation plan.)
 *
 * Usage:
 *   import { TTLCache } from '../lib/cache.js';
 *   const cache = new TTLCache({ defaultTtlMs: 30_000 });
 *
 *   cache.set('teams:org-123', teamsData, { ttlMs: 30_000 });
 *   const cached = cache.get('teams:org-123'); // null if expired
 *   const data = await cache.getOrFetch('teams:org-123', fetchTeams, { ttlMs: 30_000 });
 */

/** @typedef {{ data: any, expiresAt: number, staleAt: number }} CacheEntry */

class TTLCache {
  constructor({ defaultTtlMs = 30_000, maxEntries = 200 } = {}) {
    /** @type {Map<string, CacheEntry>} */
    this._store = new Map();
    this._defaultTtlMs = defaultTtlMs;
    this._maxEntries = maxEntries;
  }

  /**
   * Store a value with an optional TTL.
   * @param {string} key
   * @param {any} data
   * @param {Object} [options]
   * @param {number} [options.ttlMs]  Time-to-live in ms (default: 30s).
   * @param {number} [options.staleTtlMs]  Extra time data is serveable as "stale" (default: 0).
   */
  set(key, data, { ttlMs, staleTtlMs = 0 } = {}) {
    const ttl = ttlMs ?? this._defaultTtlMs;
    const now = Date.now();

    // Evict oldest if at capacity
    if (this._store.size >= this._maxEntries && !this._store.has(key)) {
      const oldest = this._store.keys().next().value;
      if (oldest !== undefined) this._store.delete(oldest);
    }

    this._store.set(key, {
      data,
      expiresAt: now + ttl,
      staleAt: now + ttl + staleTtlMs,
    });
  }

  /**
   * Retrieve a cached value. Returns null if expired.
   * @param {string} key
   * @param {Object} [options]
   * @param {boolean} [options.allowStale=false]  Return stale data if within stale window.
   * @returns {{ data: any, isStale: boolean } | null}
   */
  get(key, { allowStale = false } = {}) {
    const entry = this._store.get(key);
    if (!entry) return null;

    const now = Date.now();
    if (now < entry.expiresAt) {
      return { data: entry.data, isStale: false };
    }
    if (allowStale && now < entry.staleAt) {
      return { data: entry.data, isStale: true };
    }

    // Expired — clean up
    this._store.delete(key);
    return null;
  }

  /**
   * Get cached data or fetch fresh data, storing the result.
   * Supports stale-while-revalidate: returns stale data immediately
   * while refetching in the background.
   *
   * @param {string} key
   * @param {() => Promise<any>} fetcher
   * @param {Object} [options]
   * @param {number} [options.ttlMs]
   * @param {number} [options.staleTtlMs]
   * @returns {Promise<any>}
   */
  async getOrFetch(key, fetcher, { ttlMs, staleTtlMs = 5_000 } = {}) {
    const cached = this.get(key, { allowStale: true });

    if (cached && !cached.isStale) {
      return cached.data;
    }

    // If stale, return stale data but revalidate in background
    if (cached?.isStale) {
      fetcher()
        .then((fresh) => this.set(key, fresh, { ttlMs, staleTtlMs }))
        .catch(() => {}); // Swallow — stale data is already returned
      return cached.data;
    }

    // Cache miss — fetch synchronously
    const data = await fetcher();
    this.set(key, data, { ttlMs, staleTtlMs });
    return data;
  }

  /** Invalidate a specific key. */
  invalidate(key) {
    this._store.delete(key);
  }

  /** Invalidate all keys matching a prefix (e.g., 'teams:' clears all team caches). */
  invalidateByPrefix(prefix) {
    for (const key of this._store.keys()) {
      if (key.startsWith(prefix)) this._store.delete(key);
    }
  }

  /** Clear all cached data. */
  clear() {
    this._store.clear();
  }

  /** Current cache size. */
  get size() {
    return this._store.size;
  }
}

/**
 * Shared Edge Function invocation cache — Wave 6b Task 1.
 * Default TTL: 60s (callers pass a per-call TTL).
 *
 * Key format: `<functionName>:<stable-json-of-org-scoped-params>`
 * The `organization_id` MUST appear in the param object to prevent
 * cross-tenant cache hits — treat any key without it as a security bug.
 */
export const edgeFunctionCache = new TTLCache({ defaultTtlMs: 60_000, maxEntries: 100 });

/**
 * Build a cache key for an Edge Function invocation.
 * Includes `organization_id` in the key even when undefined so missing-org
 * calls land in a distinct bucket instead of colliding with another tenant.
 *
 * @param {string} functionName
 * @param {Record<string, unknown>} params  Must include `organization_id`.
 * @returns {string}
 */
export function buildEdgeFunctionCacheKey(functionName, params) {
  const organization_id = params?.organization_id ?? null;
  // Stable stringify: sort keys so param order doesn't fragment the cache.
  const sortedKeys = Object.keys(params ?? {}).sort();
  const normalized = sortedKeys.reduce((acc, k) => {
    acc[k] = params[k];
    return acc;
  }, {});
  return `${functionName}:${organization_id ?? 'no-org'}:${JSON.stringify(normalized)}`;
}

/**
 * Invoke an Edge Function via a caller-supplied invoker (e.g., `supabase.functions.invoke`),
 * caching the response for `ttlMs`. On cache hit, the invoker is NOT called — that's the
 * free-tier invocation reduction.
 *
 * Cache behavior:
 *   - Miss or expired → invoke, then cache the `{ data, error }` tuple.
 *   - Hit within TTL → return cached tuple without calling the invoker.
 *   - Errors are NOT cached (so a transient failure doesn't poison the window).
 *
 * @param {object} args
 * @param {string} args.functionName        Edge Function name (e.g., 'fairness-scoring').
 * @param {Record<string, unknown>} args.params  Request body — MUST contain `organization_id`.
 * @param {(name: string, opts: { body: unknown }) => Promise<{ data: any, error: any }>} args.invoker
 *                                           Typically `supabase.functions.invoke.bind(supabase.functions)`.
 * @param {number} args.ttlMs               Per-call TTL.
 * @param {TTLCache} [args.cache]           Defaults to the shared `edgeFunctionCache`.
 * @returns {Promise<{ data: any, error: any }>}
 */
export async function cachedInvoke({
  functionName,
  params,
  invoker,
  ttlMs,
  cache = edgeFunctionCache,
}) {
  const key = buildEdgeFunctionCacheKey(functionName, params);
  const hit = cache.get(key);
  if (hit) return hit.data;

  const result = await invoker(functionName, { body: params });
  // Only cache successful responses — never cache an error, so retries work.
  if (!result?.error) {
    cache.set(key, result, { ttlMs });
  }
  return result;
}

export { TTLCache };
