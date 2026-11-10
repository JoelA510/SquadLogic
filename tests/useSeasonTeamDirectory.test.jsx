// The Games page names the teams of saved games from the season's team records, outside clubs included (PR 5, fix round 2).
// The page used to name them from the latest team run, which holds the league's own teams only, so a game against an
// outside club showed the club as its id. The hook is best effort (names only): a read that fails leaves the names as they
// were, and another season's teams are never shown for this one.
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MOCK_ORG_ID, MOCK_SEASON_ID } from '../frontend/src/lib/mockSeedIds.js';
import { seedMockDb } from './helpers/seedMockDb.js';

const CONTEXT = vi.hoisted(() => ({
  org: /** @type {string | null} */ ('5eed0000-0000-4000-8000-000000000001'),
  season: /** @type {string | null} */ ('5eed5ea5-0000-4000-8000-000000000001'),
}));
vi.mock('../frontend/src/lib/supabaseClient.js', async () => {
  const { mockSupabase } = await import('../frontend/src/lib/mockSupabaseClient.js');
  return { supabase: mockSupabase, supabaseReady: Promise.resolve() };
});
vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: () => ({
    currentOrganization: CONTEXT.org ? { id: CONTEXT.org } : null,
    currentSeasonSetting: CONTEXT.season ? { id: CONTEXT.season } : null,
  }),
}));
vi.mock('../frontend/src/lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), log: vi.fn() },
}));

const { useSeasonTeamDirectory } = await import('../frontend/src/hooks/useSeasonTeamDirectory.js');
const { mockSupabase } = await import('../frontend/src/lib/mockSupabaseClient.js');
const { logger } = await import('../frontend/src/lib/logger.js');

beforeEach(() => {
  sessionStorage.clear();
  delete window.__MOCK_DB__;
  sessionStorage.setItem('__MOCK_SESSION__', JSON.stringify({ user: { id: 'mock-admin-id' } }));
  CONTEXT.org = MOCK_ORG_ID;
  CONTEXT.season = MOCK_SEASON_ID;
  seedMockDb({
    divisions: [
      {
        id: 'dir-div',
        organization_id: MOCK_ORG_ID,
        season_settings_id: MOCK_SEASON_ID,
        name: 'U8 Coed',
      },
    ],
    teams: [
      {
        id: 'dir-own',
        organization_id: MOCK_ORG_ID,
        division_id: 'dir-div',
        name: 'Own FC',
        is_external: false,
      },
      {
        id: 'dir-club',
        organization_id: MOCK_ORG_ID,
        division_id: 'dir-div',
        name: 'Gulls FC',
        is_external: true,
      },
    ],
  });
});
afterEach(() => vi.restoreAllMocks());

describe('useSeasonTeamDirectory', () => {
  it('lists the season’s teams with their outside clubs, named', async () => {
    const { result } = renderHook(() => useSeasonTeamDirectory());
    await waitFor(() => expect(result.current.length).toBeGreaterThan(0));
    const names = result.current
      .filter((t) => t.id.startsWith('dir-'))
      .map((t) => `${t.name}:${t.isExternal}`)
      .sort();
    expect(names).toEqual(['Gulls FC:true', 'Own FC:false']);
  });

  it('with no season it holds nothing, and never another season’s teams', async () => {
    const { result, rerender } = renderHook(() => useSeasonTeamDirectory());
    await waitFor(() => expect(result.current.length).toBeGreaterThan(0));
    CONTEXT.season = null;
    rerender();
    expect(result.current).toEqual([]);
  });

  it('a read that fails leaves the names as they were (empty), says so in the log, and throws nothing', async () => {
    const from = mockSupabase.from.bind(mockSupabase);
    vi.spyOn(mockSupabase, 'from').mockImplementation((table) => {
      if (table === 'teams') throw new Error('teams are unreadable');
      return from(table);
    });
    const { result } = renderHook(() => useSeasonTeamDirectory());
    await waitFor(() => expect(logger.warn).toHaveBeenCalled());
    expect(result.current).toEqual([]);
  });
});
