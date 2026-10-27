/**
 * The roster editor's names come from `players` and `coaches` read in full. PostgREST cuts an
 * unranged select at `max_rows = 1000` (supabase/config.toml), and the demo league has 1,259
 * players: a read that does not page names the first thousand and calls the rest unknown.
 */
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useRosterDirectory } from '../frontend/src/hooks/useRosterDirectory.js';

const mocks = vi.hoisted(() => ({ tables: {}, refuse: null }));

vi.mock('../frontend/src/lib/supabaseClient.js', () => ({
  supabase: {
    from: (table) => {
      let from = 0;
      let to = Infinity;
      const builder = {
        select: () => builder,
        eq: () => builder,
        order: () => builder,
        range: (a, b) => {
          from = a;
          to = b;
          return builder;
        },
        then: (resolve, reject) => {
          if (mocks.refuse && mocks.refuse.table === table && from >= mocks.refuse.from) {
            return Promise.resolve({ data: null, error: new Error('page refused') }).then(
              resolve,
              reject
            );
          }
          // The server's cap: at most 1000 rows, whatever range was asked for.
          const rows = (mocks.tables[table] || []).slice(from, to + 1).slice(0, 1000);
          return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
        },
      };
      return builder;
    },
  },
}));
vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: () => ({ currentOrganization: { id: 'org-1' } }),
}));

const players = (n) =>
  Array.from({ length: n }, (_, i) => ({
    id: `p${String(i).padStart(5, '0')}`,
    first_name: `First${i + 1}`,
    last_name: `Last${i + 1}`,
    rating: null,
  }));

describe('useRosterDirectory', () => {
  beforeEach(() => {
    mocks.refuse = null;
    mocks.tables = {
      players: players(1259),
      coaches: [
        { id: 'c1', full_name: 'Coach One' },
        { id: 'c2', full_name: '  ' },
      ],
    };
  });

  it('names every player of a league larger than the server row cap', async () => {
    const { result } = renderHook(() => useRosterDirectory({ enabled: true }));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.players.size).toBe(1259);
    // The last player is past row 1000: the one a capped read never saw.
    expect(result.current.players.get('p01258')).toEqual({
      name: 'First1259 Last1259',
      rating: null,
    });
    // A coach with no name is not in the map (the page counts them, never prints an id).
    expect([...result.current.coaches]).toEqual([['c1', 'Coach One']]);
  });

  it('a refused page is an error with no rows, not the first thousand names', async () => {
    mocks.refuse = { table: 'players', from: 1000 };
    const { result } = renderHook(() => useRosterDirectory({ enabled: true }));
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error).toBe('page refused');
    expect(result.current.players.size).toBe(0);
  });

  it('reads nothing until the editor is open', () => {
    const { result } = renderHook(() => useRosterDirectory({ enabled: false }));
    expect(result.current.status).toBe('idle');
  });
});
