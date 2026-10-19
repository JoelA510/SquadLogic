import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TTLCache } from '../frontend/src/lib/cache.js';

describe('TTLCache', () => {
  let cache;

  beforeEach(() => {
    cache = new TTLCache({ defaultTtlMs: 1_000, maxEntries: 5 });
  });

  afterEach(() => {
    cache.clear();
  });

  it('stores and retrieves a value', () => {
    cache.set('key1', { foo: 'bar' });
    const result = cache.get('key1');
    expect(result).not.toBeNull();
    expect(result.data).toEqual({ foo: 'bar' });
    expect(result.isStale).toBe(false);
  });

  it('returns null for non-existent keys', () => {
    expect(cache.get('missing')).toBeNull();
  });

  it('expires entries after TTL', () => {
    vi.useFakeTimers();
    cache.set('key1', 'data', { ttlMs: 100 });

    // Still fresh at 50ms
    vi.advanceTimersByTime(50);
    expect(cache.get('key1')).not.toBeNull();

    // Expired at 150ms
    vi.advanceTimersByTime(100);
    expect(cache.get('key1')).toBeNull();

    vi.useRealTimers();
  });

  it('supports stale-while-revalidate window', () => {
    vi.useFakeTimers();
    cache.set('key1', 'data', { ttlMs: 100, staleTtlMs: 200 });

    // Fresh at 50ms
    vi.advanceTimersByTime(50);
    let result = cache.get('key1', { allowStale: true });
    expect(result.isStale).toBe(false);

    // Stale (but returned) at 150ms
    vi.advanceTimersByTime(100);
    result = cache.get('key1', { allowStale: true });
    expect(result).not.toBeNull();
    expect(result.isStale).toBe(true);

    // Fully expired at 350ms
    vi.advanceTimersByTime(200);
    expect(cache.get('key1', { allowStale: true })).toBeNull();

    vi.useRealTimers();
  });

  it('evicts oldest entry when maxEntries exceeded', () => {
    for (let i = 0; i < 5; i++) {
      cache.set(`key${i}`, i);
    }
    expect(cache.size).toBe(5);

    // Adding 6th should evict key0 (oldest)
    cache.set('key5', 5);
    expect(cache.size).toBe(5);
    expect(cache.get('key0')).toBeNull();
    expect(cache.get('key5')).not.toBeNull();
  });

  it('invalidates by key', () => {
    cache.set('key1', 'data');
    cache.invalidate('key1');
    expect(cache.get('key1')).toBeNull();
  });

  it('invalidates by prefix', () => {
    cache.set('teams:org-1', 'a');
    cache.set('teams:org-2', 'b');
    cache.set('slots:org-1', 'c');

    cache.invalidateByPrefix('teams:');
    expect(cache.get('teams:org-1')).toBeNull();
    expect(cache.get('teams:org-2')).toBeNull();
    expect(cache.get('slots:org-1')).not.toBeNull();
  });

  it('getOrFetch returns cached data without calling fetcher', async () => {
    const fetcher = vi.fn().mockResolvedValue('fresh');
    cache.set('key1', 'cached', { ttlMs: 10_000 });

    const result = await cache.getOrFetch('key1', fetcher, { ttlMs: 10_000 });
    expect(result).toBe('cached');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('getOrFetch calls fetcher on cache miss', async () => {
    const fetcher = vi.fn().mockResolvedValue('fresh');
    const result = await cache.getOrFetch('key1', fetcher, { ttlMs: 10_000 });
    expect(result).toBe('fresh');
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('clear removes all entries', () => {
    cache.set('a', 1);
    cache.set('b', 2);
    cache.clear();
    expect(cache.size).toBe(0);
  });
});

describe('TTLCache defaults', () => {
  it('has a default 30s TTL', () => {
    vi.useFakeTimers();
    const cache = new TTLCache();
    cache.set('test', 'data');

    // Still fresh at 29s
    vi.advanceTimersByTime(29_000);
    expect(cache.get('test')).not.toBeNull();

    // Expired at 31s
    vi.advanceTimersByTime(2_000);
    expect(cache.get('test')).toBeNull();

    vi.useRealTimers();
  });
});
