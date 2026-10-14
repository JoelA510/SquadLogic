/**
 * `useAutoScheduler`'s `auto-scheduler` request is under the persistence
 * deadline (found by PR 2-C, plan "Discovered during execution": it had none,
 * so a run whose answer never came spun until the user pressed Cancel).
 *
 * The deadline and its error codes are `lib/persistenceRequest.js`'s (M2.5),
 * not a second mechanism. Cancel still aborts the run, through the caller's own
 * signal, and a cancelled run never turns into a timeout error later.
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PERSISTENCE_TIMEOUT_MS } from '../frontend/src/lib/persistenceRequest.js';

vi.mock('../frontend/src/lib/supabaseClient.js', () => {
  const channel = { on: () => channel, subscribe: () => channel };
  return {
    supabase: {
      auth: { getSession: async () => ({ data: { session: { access_token: 'tok' } } }) },
      channel: () => channel,
      removeChannel: () => {},
    },
  };
});

const { useAutoScheduler } = await import('../frontend/src/hooks/useAutoScheduler.js');
const { edgeFunctionCache } = await import('../frontend/src/lib/cache.js');

const ORG = '11111111-1111-4111-8111-111111111111';

/** A distinct input per test, so the hook's TTL cache never answers instead. */
let runCount = 0;
function trigger(result) {
  runCount += 1;
  return result.current.trigger({
    teams: [{ id: `t-${runCount}`, division: 'U10' }],
    slots: [{ id: 's-1', start: 'a', end: 'b', capacity: 1 }],
    seasonSettingsId: '22222222-2222-4222-8222-222222222222',
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  edgeFunctionCache.clear();
});

describe('useAutoScheduler :: the persistence deadline', () => {
  it('a run that never answers fails at the deadline with a timeout message', async () => {
    vi.useFakeTimers();
    /** @type {AbortSignal[]} */
    const signals = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((_url, init) => {
        signals.push(init.signal);
        return new Promise(() => {});
      })
    );
    const { result } = renderHook(() => useAutoScheduler({ organizationId: ORG }));

    let run;
    await act(async () => {
      run = trigger(result);
      await vi.advanceTimersByTimeAsync(PERSISTENCE_TIMEOUT_MS - 1000);
    });
    expect(result.current.status).toBe('running');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
      await run;
    });

    expect(result.current.status).toBe('failed');
    expect(result.current.error).toBe(
      `The auto-scheduler did not answer within ${PERSISTENCE_TIMEOUT_MS / 1000} seconds, so the run may have finished and been recorded. Check the latest run under Analytics before running it again.`
    );
    expect(signals).toHaveLength(1);
    expect(signals[0].aborted).toBe(true);
  });

  it('Cancel aborts the run at once, and no timeout error follows it', async () => {
    vi.useFakeTimers();
    /** @type {AbortSignal[]} */
    const signals = [];
    // Ignores its signal, so only the hook's own handling can end the run.
    vi.stubGlobal(
      'fetch',
      vi.fn((_url, init) => {
        signals.push(init.signal);
        return new Promise(() => {});
      })
    );
    const { result } = renderHook(() => useAutoScheduler({ organizationId: ORG }));

    let run;
    await act(async () => {
      run = trigger(result);
      await vi.advanceTimersByTimeAsync(1000);
    });
    await act(async () => {
      result.current.cancel();
      await run;
    });
    expect(result.current.status).toBe('idle');
    expect(signals[0].aborted).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(PERSISTENCE_TIMEOUT_MS + 5000);
    });
    expect(result.current.status).toBe('idle');
    expect(result.current.error).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a 2xx whose body cannot be read fails, and says the run may have completed (the function records it before answering)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError('Unexpected end of JSON input');
        },
      }))
    );
    const { result } = renderHook(() => useAutoScheduler({ organizationId: ORG }));
    await act(async () => {
      await trigger(result);
    });
    expect(result.current.status).toBe('failed');
    expect(result.current.error).toBe(
      'The auto-scheduler returned a response that could not be read (HTTP 200), so the run may ' +
        'have finished and been recorded. Check the latest run under Analytics before running it again.'
    );
  });

  it("a refusal keeps the function's own error", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 422,
        json: async () => ({ error: 'locked rows changed since the read' }),
      }))
    );
    const { result } = renderHook(() => useAutoScheduler({ organizationId: ORG }));
    await act(async () => {
      await trigger(result);
    });
    expect(result.current.status).toBe('failed');
    expect(result.current.error).toBe('locked rows changed since the read');
  });
});
