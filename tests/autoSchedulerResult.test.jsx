/**
 * `useAutoScheduler` carries the M4.8 fields of the function's answer through
 * to the page: the date the run judged from (`liveFrom`), each placement's
 * judged range, and the lock report (`lock`: ended rows, unreadable ranges).
 * A field the hook drops is a report the page can never show.
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

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

afterEach(() => {
  vi.unstubAllGlobals();
  edgeFunctionCache.clear();
});

describe('useAutoScheduler :: the M4.8 fields of a run', () => {
  it('keeps liveFrom, the judged ranges and the lock report', async () => {
    const lock = { lockedLoaded: 2, endedRows: ['a-old'], unreadableRange: ['a-bad'] };
    const assignments = [
      { teamId: 't1', slotId: 's1', source: 'auto', effectiveDateRange: '[2026-10-17,2026-11-20]' },
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          runId: 'run-1',
          assignments,
          unassigned: [],
          evaluation: {},
          optimization: { iterations: 1, bestScore: 1, elapsedMs: 1 },
          liveFrom: '2026-10-17',
          lock,
        }),
      }))
    );
    const { result } = renderHook(() => useAutoScheduler({ organizationId: ORG }));
    await act(async () => {
      await result.current.trigger({
        teams: [{ id: 't1', division: 'U10' }],
        slots: [{ id: 's1', start: 'a', end: 'b', capacity: 1 }],
        seasonSettingsId: '22222222-2222-4222-8222-222222222222',
      });
    });
    expect(result.current.status).toBe('completed');
    expect(result.current.result.liveFrom).toBe('2026-10-17');
    expect(result.current.result.lock).toEqual(lock);
    expect(result.current.result.assignments).toEqual(assignments);
  });
});
