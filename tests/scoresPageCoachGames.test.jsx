// The Scores page (admin focus R6, migration 20261028010000): an admin scores
// every game and nobody else scores any. A coach never reaches the page (no
// MANAGE_SCHEDULE); an admin previewing a coach does, and sees what the coach
// could score: nothing. The preview's read still asks the server for the
// coach's teams' games rather than cutting them out of the league's latest
// 200, and says so when those teams cannot be read.
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
    canScoreGame: /** @type {(game: any) => boolean} */ (() => false),
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
  // A preview of a coach: the hook answers for the coach (useScorableGames.test.jsx).
  mocks.scorable = {
    ...mocks.scorable,
    ready: true,
    error: false,
    teamIds: ['team-a', 'team-b'],
    canScoreGame: () => false,
  };
});

const GAME = {
  id: 'g1',
  start_time: '2026-10-01T15:00:00Z',
  score_home: null,
  score_away: null,
  home_team: { id: 'team-a', name: 'Aces', division: { name: 'U10' } },
  away_team: { id: 'team-x', name: 'Rivals' },
};

describe('ScoresPage', () => {
  it('asks for every game for an admin, and lists each for entry', async () => {
    mocks.scorable = { ...mocks.scorable, teamIds: null, canScoreGame: () => true };
    mocks.games = [GAME];
    renderPage();
    await waitFor(() => expect(callsTo('limit')).toHaveLength(1));
    expect(callsTo('or')).toEqual([]);
    expect(await screen.findByText('Rivals')).toBeInTheDocument();
  });

  it('under a preview of a coach, reads the coach s teams games and offers none for entry', async () => {
    mocks.games = [GAME];
    renderPage();
    await waitFor(() => expect(callsTo('limit')).toHaveLength(1));
    expect(callsTo('or')).toEqual([
      ['home_team_id.in.(team-a,team-b),away_team_id.in.(team-a,team-b)'],
    ]);
    expect(await screen.findByRole('grid', { name: 'Scores grid' })).toBeInTheDocument();
    expect(screen.queryByText('Rivals')).not.toBeInTheDocument();
  });

  it('asks nothing under a preview of a coach of no team', async () => {
    mocks.scorable = { ...mocks.scorable, teamIds: [] };
    renderPage();
    expect(await screen.findByRole('grid', { name: 'Scores grid' })).toBeInTheDocument();
    expect(mocks.calls).toEqual([]);
  });

  it('says so when the previewed coach s teams could not be read', async () => {
    mocks.scorable = { ...mocks.scorable, teamIds: [], error: true };
    renderPage();
    expect(await screen.findByText(/Your teams could not be loaded/)).toBeInTheDocument();
  });
});
