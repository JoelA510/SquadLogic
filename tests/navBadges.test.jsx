import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useNavBadges } from '../frontend/src/hooks/useNavBadges.js';
import { REFRESH_TOPICS, emitRefresh, subscribeRefresh } from '../frontend/src/lib/refreshBus.js';
import { MOCK_ORG_ID, MOCK_SEASON_ID } from '../frontend/src/lib/mockSeedIds.js';

const mocks = vi.hoisted(() => ({
  rowsByTable: { players: [], coaches: [], teams: [] },
  eqs: [],
}));

vi.mock('../frontend/src/lib/supabaseClient.js', () => ({
  supabase: {
    // PostgREST as hosted: a list read stops at `max_rows` (1000); an exact count does not.
    from: (table) => ({
      select: (_columns, options) => {
        const filters = [];
        const answer = () => {
          mocks.eqs.push({ table, filters: [...filters] });
          const rows = mocks.rowsByTable[table] || [];
          if (options?.count === 'exact') {
            return {
              data: options.head ? null : rows.slice(0, 1000),
              count: rows.length,
              error: null,
            };
          }
          return { data: rows.slice(0, 1000), error: null };
        };
        const query = {
          eq: (column, value) => (filters.push([column, value]), query),
          then: (resolve, reject) => Promise.resolve(answer()).then(resolve, reject),
        };
        return query;
      },
    }),
  },
}));

vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: () => ({
    currentOrganization: { id: MOCK_ORG_ID },
    currentSeasonSetting: { id: MOCK_SEASON_ID },
  }),
}));

describe('refreshBus', () => {
  it('notifies subscribers per topic and supports unsubscribe', () => {
    const onNavBadges = vi.fn();
    const unsubscribe = subscribeRefresh(REFRESH_TOPICS.NAV_BADGES, onNavBadges);

    emitRefresh(REFRESH_TOPICS.NAV_BADGES);
    emitRefresh('unrelated-topic');
    expect(onNavBadges).toHaveBeenCalledTimes(1);

    unsubscribe();
    emitRefresh(REFRESH_TOPICS.NAV_BADGES);
    expect(onNavBadges).toHaveBeenCalledTimes(1);
  });
});

describe('useNavBadges', () => {
  beforeEach(() => {
    mocks.eqs = [];
    mocks.rowsByTable = {
      players: [{ id: 'p1' }, { id: 'p2' }],
      coaches: [{ id: 'c1' }],
      teams: [],
    };
  });

  it('counts org rows per table (null for zero)', async () => {
    const { result } = renderHook(() => useNavBadges());

    await waitFor(() => expect(result.current.players).toBe(2));
    expect(result.current.coaches).toBe(1);
    expect(result.current.teams).toBe(null);
  });

  it("counts the season the header shows for the people (they belong to one season), the organization's teams", async () => {
    const { result } = renderHook(() => useNavBadges());
    await waitFor(() => expect(result.current.players).toBe(2));
    const filtersOf = (table) => mocks.eqs.find((request) => request.table === table).filters;
    expect(filtersOf('players')).toContainEqual(['season_settings_id', MOCK_SEASON_ID]);
    expect(filtersOf('coaches')).toContainEqual(['season_settings_id', MOCK_SEASON_ID]);
    expect(filtersOf('teams')).toEqual([['organization_id', MOCK_ORG_ID]]);
  });

  it('counts past the server row cap (a league of 1,259 players is not 1000)', async () => {
    mocks.rowsByTable.players = Array.from({ length: 1259 }, (_, i) => ({ id: `p${i}` }));
    const { result } = renderHook(() => useNavBadges());
    await waitFor(() => expect(result.current.players).toBe(1259));
  });

  it('re-fetches when the NAV_BADGES refresh topic is emitted', async () => {
    const { result } = renderHook(() => useNavBadges());
    await waitFor(() => expect(result.current.players).toBe(2));

    // A player delete elsewhere shrinks the table, then signals the badges.
    mocks.rowsByTable.players = [{ id: 'p1' }];
    act(() => emitRefresh(REFRESH_TOPICS.NAV_BADGES));

    await waitFor(() => expect(result.current.players).toBe(1));
  });
});
