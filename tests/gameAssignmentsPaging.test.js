/**
 * `useGameAssignments` reads every game of a run. PostgREST cuts an unranged select at its row
 * cap (`max_rows = 1000`, supabase/config.toml), so a league with more than 1,000 games had its
 * schedule export and game views built from the first 1,000 with no error. The read now pages.
 */
import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useGameAssignments } from '../frontend/src/hooks/useGameAssignments.js';

const mocks = vi.hoisted(() => ({ total: 0, failAt: null, ranges: [] }));

vi.mock('../frontend/src/lib/supabaseClient.js', () => ({
  supabase: {
    from: () => {
      let rangeFrom = null;
      let rangeTo = null;
      const builder = {
        select: () => builder,
        eq: () => builder,
        order: () => builder,
        range: (from, to) => {
          rangeFrom = from;
          rangeTo = to;
          mocks.ranges.push([from, to]);
          return builder;
        },
        then: (resolve, reject) => {
          if (mocks.failAt !== null && rangeFrom === mocks.failAt) {
            return Promise.resolve({ data: null, error: new Error('page refused') }).then(
              resolve,
              reject
            );
          }
          // The server's cap: never more than 1000 rows, whatever was asked for.
          const to = rangeTo === null ? mocks.total - 1 : Math.min(rangeTo, mocks.total - 1);
          const from = rangeFrom ?? 0;
          const count = Math.min(Math.max(to - from + 1, 0), 1000);
          const data = Array.from({ length: count }, (_, i) => ({
            id: `g${from + i}`,
            run_id: 'r',
          }));
          return Promise.resolve({ data, error: null }).then(resolve, reject);
        },
      };
      return builder;
    },
  },
}));

describe('useGameAssignments', () => {
  it('returns every game of a run larger than the server row cap', async () => {
    mocks.total = 1259;
    mocks.failAt = null;
    mocks.ranges = [];
    const { result } = renderHook(() => useGameAssignments('run-1'));
    await waitFor(() => expect(result.current.assignments).toHaveLength(1259));
    expect(result.current.error).toBeNull();
    expect(mocks.ranges.length).toBeGreaterThan(1);
  });

  it('a refused page is an error and no partial schedule', async () => {
    mocks.total = 1259;
    mocks.failAt = 1000;
    mocks.ranges = [];
    const { result } = renderHook(() => useGameAssignments('run-1'));
    await waitFor(() => expect(result.current.error).toBeTruthy());
    expect(result.current.assignments).toEqual([]);
  });
});
