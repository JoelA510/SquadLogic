import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useNavBadges } from '../frontend/src/hooks/useNavBadges.js';
import { REFRESH_TOPICS, emitRefresh, subscribeRefresh } from '../frontend/src/lib/refreshBus.js';
import { MOCK_ORG_ID } from '../frontend/src/lib/mockSeedIds.js';

const mocks = vi.hoisted(() => ({
  rowsByTable: { players: [], coaches: [], teams: [] },
}));

vi.mock('../frontend/src/lib/supabaseClient.js', () => ({
  supabase: {
    from: (table) => ({
      select: () => ({
        eq: () => Promise.resolve({ data: mocks.rowsByTable[table] || [], error: null }),
      }),
    }),
  },
}));

vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: () => ({ currentOrganization: { id: MOCK_ORG_ID } }),
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

  it('re-fetches when the NAV_BADGES refresh topic is emitted', async () => {
    const { result } = renderHook(() => useNavBadges());
    await waitFor(() => expect(result.current.players).toBe(2));

    // A player delete elsewhere shrinks the table, then signals the badges.
    mocks.rowsByTable.players = [{ id: 'p1' }];
    act(() => emitRefresh(REFRESH_TOPICS.NAV_BADGES));

    await waitFor(() => expect(result.current.players).toBe(1));
  });
});
