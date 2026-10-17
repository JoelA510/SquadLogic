import { describe, it, expect, vi } from 'vitest';
import { createChainMock } from '../createChainMock.js';
import { MOCK_ORG_ID } from '../../../frontend/src/lib/mockSeedIds.js';

describe('createChainMock', () => {
  it('resolves chained query-builder calls to the provided value', async () => {
    const resolved = { data: [{ id: '1' }], error: null };
    const chain = /** @type {Record<string, any> & PromiseLike<any>} */ (createChainMock(resolved));
    const result = await chain.select('*').eq('org_id', MOCK_ORG_ID).single();
    expect(result).toEqual(resolved);
  });

  it('resolves when awaited directly (without any method calls)', async () => {
    const resolved = { data: null, error: { message: 'not found' } };
    const chain = /** @type {PromiseLike<{ data: null, error: { message: string } }>} */ (
      createChainMock(resolved)
    );
    const result = await chain;
    expect(result).toEqual(resolved);
  });

  it('exposes `.data` and `.error` directly on the proxy', () => {
    const resolved = { data: [{ id: '1' }, { id: '2' }], error: null };
    const chain = createChainMock(resolved);
    expect(chain.data).toEqual([{ id: '1' }, { id: '2' }]);
    expect(chain.error).toBeNull();
  });

  it('does not infinite-recurse under JSON.stringify', () => {
    const chain = createChainMock({ data: [{ id: '1' }], error: null });
    expect(() => JSON.stringify(chain)).not.toThrow();
  });

  it('does not throw under console.log', () => {
    const chain = createChainMock({ data: null, error: null });
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(() => console.log(chain)).not.toThrow();
    spy.mockRestore();
  });

  it('forwards both onFulfilled and onRejected to Promise.then', async () => {
    const chain = createChainMock({ data: null, error: null });
    const onFulfilled = vi.fn((v) => v);
    const onRejected = vi.fn();
    await chain.then(onFulfilled, onRejected);
    expect(onFulfilled).toHaveBeenCalledTimes(1);
    expect(onFulfilled).toHaveBeenCalledWith({ data: null, error: null });
    expect(onRejected).not.toHaveBeenCalled();
  });

  it('returns the proxy itself for arbitrary method calls (supports unlimited chain depth)', () => {
    const chain = /** @type {Record<string, any> & PromiseLike<any>} */ (
      createChainMock({ data: [], error: null })
    );
    const returned = chain.select().eq().gt().lt().order().limit().range();
    // Each method call returns the same proxy, so `returned` is awaitable.
    expect(typeof returned.then).toBe('function');
    expect(returned.data).toEqual([]);
  });
});
