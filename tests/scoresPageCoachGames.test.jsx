// The Scores page as a coach (Phase A3b, migration 20261021020000): a coach may
// score only their own teams' games, so the page asks the server for those
// games rather than cutting them out of the league's latest 200, where a busy
// league would leave none; and it says so when the coach's teams cannot be read.
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ScoresPage from '../frontend/src/pages/ScoresPage.jsx';

const mocks = vi.hoisted(() => ({
  scorable: {
    ready: true,
    error: false,
    teamIds: /** @type {string[] | null} */ (['team-a', 'team-b']),
    canScoreGame: () => true,
    coachesTeam: () => true,
  },
  calls: /** @type {Array<[string, any[]]>} */ ([]),
  games: /** @type {any[]} */ ([]),
}));

vi.mock('../frontend/src/hooks/useScorableGames.js', () => ({
  useScorableGames: () => mocks.scorable,
}));

vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: () => ({ currentOrganization: { id: 'org-a' } }),
}));

vi.mock('../frontend/src/contexts/AuthContext.jsx', () => ({
  useAuth: () => ({ user: { id: 'cora' }, isImpersonating: false }),
}));

vi.mock('../frontend/src/hooks/useFeatures.js', () => ({
  useFeatures: () => ({ genderModel: 'binary' }),
}));

vi.mock('../frontend/src/components/ui/ToastHost.jsx', () => ({
  useToast: () => vi.fn(),
}));

vi.mock('../frontend/src/lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), log: vi.fn() },
}));

vi.mock('../frontend/src/lib/supabaseClient.js', () => {
  const builder = () => {
    const q = {};
    for (const method of ['select', 'eq', 'lte', 'or', 'order']) {
      q[method] = (...args) => {
        mocks.calls.push([method, args]);
        return q;
      };
    }
    q.limit = (...args) => {
      mocks.calls.push(['limit', args]);
      return Promise.resolve({ data: mocks.games, error: null });
    };
    return q;
  };
  return { supabase: { from: () => builder(), rpc: vi.fn() } };
});

const renderPage = () =>
  render(
    <MemoryRouter>
      <ScoresPage />
    </MemoryRouter>
  );

const callsTo = (method) => mocks.calls.filter(([name]) => name === method).map(([, a]) => a);

beforeEach(() => {
  mocks.calls = [];
  mocks.games = [];
  mocks.scorable = { ...mocks.scorable, ready: true, error: false, teamIds: ['team-a', 'team-b'] };
});

describe('ScoresPage, for a coach', () => {
  it('asks the server for the coach s own teams games, home or away', async () => {
    renderPage();
    await waitFor(() => expect(callsTo('limit')).toHaveLength(1));
    expect(callsTo('or')).toEqual([
      ['home_team_id.in.(team-a,team-b),away_team_id.in.(team-a,team-b)'],
    ]);
  });

  it('asks for every game for an admin', async () => {
    mocks.scorable = { ...mocks.scorable, teamIds: null };
    renderPage();
    await waitFor(() => expect(callsTo('limit')).toHaveLength(1));
    expect(callsTo('or')).toEqual([]);
  });

  it('asks nothing for a coach of no team', async () => {
    mocks.scorable = { ...mocks.scorable, teamIds: [] };
    renderPage();
    expect(await screen.findByRole('grid', { name: 'Scores grid' })).toBeInTheDocument();
    expect(mocks.calls).toEqual([]);
  });

  it('says so when the coach s teams could not be read', async () => {
    mocks.scorable = { ...mocks.scorable, teamIds: [], error: true };
    renderPage();
    expect(await screen.findByText(/Your teams could not be loaded/)).toBeInTheDocument();
  });
});
