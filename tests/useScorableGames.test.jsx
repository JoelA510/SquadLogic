// Which games the score pages offer for entry (Phase A3b, migration
// 20261021020000): update_game_score lets an admin or staff member score any
// game and anyone else only a game of a team they currently coach, so the hook
// asks the server for the caller's coached teams (or the previewed coach's)
// rather than deciding from the caller's role.
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useScorableGames } from '../frontend/src/hooks/useScorableGames.js';

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  role: 'coach',
  orgId: 'org-a',
  impersonating: false,
}));

vi.mock('../frontend/src/contexts/AuthContext.jsx', () => ({
  useAuth: () =>
    mocks.impersonating
      ? { user: { id: 'admin', profile: { id: 'cora' } }, isImpersonating: true }
      : { user: { id: 'cora' }, isImpersonating: false },
}));

vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: () => ({
    currentOrganization: mocks.orgId ? { id: mocks.orgId } : null,
    orgMember: { role: mocks.role },
  }),
}));

vi.mock('../frontend/src/lib/supabaseClient.js', () => ({
  supabase: { rpc: (name, params) => mocks.rpc(name, params) },
}));

vi.mock('../frontend/src/lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), log: vi.fn() },
}));

const OWN = { id: 'g1', home_team_id: 'team-a', away_team_id: 'team-x' };
const AWAY = { id: 'g2', home_team: { id: 'team-y' }, away_team: { id: 'team-a' } };
const OTHER = { id: 'g3', home_team_id: 'team-x', away_team_id: 'team-y' };

beforeEach(() => {
  mocks.rpc.mockReset();
  mocks.role = 'coach';
  mocks.orgId = 'org-a';
  mocks.impersonating = false;
});

describe('useScorableGames', () => {
  it('lets a coach score only games of a team they currently coach, home or away', async () => {
    mocks.rpc.mockResolvedValue({ data: ['team-a'], error: null });
    const { result } = renderHook(() => useScorableGames());

    expect(result.current.ready).toBe(false);
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(mocks.rpc).toHaveBeenCalledWith('get_my_coached_team_ids', {
      p_organization_id: 'org-a',
    });
    expect([OWN, AWAY, OTHER].map(result.current.canScoreGame)).toEqual([true, true, false]);
    expect(result.current.coachesTeam('team-a')).toBe(true);
    expect(result.current.coachesTeam('team-x')).toBe(false);
    expect(result.current.teamIds).toEqual(['team-a']);
    expect(result.current.error).toBe(false);
  });

  it('lets an admin score every game without asking the server', () => {
    mocks.role = 'admin';
    const { result } = renderHook(() => useScorableGames());

    expect(result.current.ready).toBe(true);
    expect([OWN, AWAY, OTHER].every(result.current.canScoreGame)).toBe(true);
    expect(result.current.coachesTeam('team-x')).toBe(true);
    expect(result.current.teamIds).toBeNull();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('answers for the previewed coach, not the admin, during a preview', async () => {
    mocks.role = 'admin';
    mocks.impersonating = true;
    mocks.rpc.mockResolvedValue({ data: ['team-x'], error: null });
    const { result } = renderHook(() => useScorableGames());

    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(mocks.rpc).toHaveBeenCalledWith('admin_get_coached_team_ids', {
      p_organization_id: 'org-a',
      p_user_id: 'cora',
    });
    expect([OWN, AWAY, OTHER].map(result.current.canScoreGame)).toEqual([true, false, true]);
  });

  it('offers nothing when the coached teams cannot be read, and says the read failed', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: '500', message: 'boom' } });
    const { result } = renderHook(() => useScorableGames());

    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.error).toBe(true);
    expect([OWN, AWAY, OTHER].some(result.current.canScoreGame)).toBe(false);
    expect(result.current.coachesTeam('team-a')).toBe(false);
    expect(result.current.teamIds).toEqual([]);
  });

  it('asks the server nothing and allows nothing when not enabled', async () => {
    const { result } = renderHook(() => useScorableGames({ enabled: false }));

    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(result.current.canScoreGame(OWN)).toBe(false);
    expect(result.current.error).toBe(false);
  });

  it('settles with nothing to score when there is no organization', async () => {
    mocks.orgId = null;
    const { result } = renderHook(() => useScorableGames());

    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.canScoreGame(OWN)).toBe(false);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
