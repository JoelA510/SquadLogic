/**
 * The roster editor's names come from `players` and `coaches` read in full. PostgREST cuts an
 * unranged select at `max_rows = 1000` (supabase/config.toml), and the demo league has 1,259
 * players: a read that does not page names the first thousand and calls the rest unknown.
 */
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useRosterDirectory } from '../frontend/src/hooks/useRosterDirectory.js';

const mocks = vi.hoisted(() => ({ tables: {}, refuse: null, selected: [] }));

vi.mock('../frontend/src/lib/supabaseClient.js', () => ({
  supabase: {
    from: (table) => {
      let from = 0;
      let to = Infinity;
      const builder = {
        select: (columns) => {
          mocks.selected.push([table, columns]);
          return builder;
        },
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
  useOrganization: () => ({
    currentOrganization: { id: 'org-1' },
    currentSeasonSetting: { id: 'season-1' },
  }),
}));

const players = (n) =>
  Array.from({ length: n }, (_, i) => ({
    id: `p${String(i).padStart(5, '0')}`,
    first_name: `First${i + 1}`,
    last_name: `Last${i + 1}`,
    rating: null,
    skill_tier: i === n - 1 ? 'advanced' : null,
  }));

describe('useRosterDirectory', () => {
  beforeEach(() => {
    mocks.refuse = null;
    mocks.selected = [];
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
      skillTier: 'advanced',
      // The rows here carry no age or request (the columns the play-up list reads, PR 2): unknown, and
      // no request, rather than 0 and a guess.
      naturalAge: null,
      playUpRequested: false,
    });
    // Most players have no stored tier: none, not a blank or a guess.
    expect(result.current.players.get('p00000')).toEqual({
      name: 'First1 Last1',
      rating: null,
      skillTier: null,
      naturalAge: null,
      playUpRequested: false,
    });
    // A coach with no name is not in the map (the page counts them, never prints an id).
    expect([...result.current.coaches]).toEqual([['c1', 'Coach One']]);
  });

  it("reads the players' stored skill tier beside their names and ratings", async () => {
    const { result } = renderHook(() => useRosterDirectory({ enabled: true }));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    const playerSelects = mocks.selected.filter(([table]) => table === 'players').map(([, c]) => c);
    expect(playerSelects.length).toBeGreaterThan(0);
    for (const columns of playerSelects) expect(columns).toMatch(/\bskill_tier\b/);
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
