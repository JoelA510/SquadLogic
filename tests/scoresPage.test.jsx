// The Scores page (admin focus R6, migration 20261028010000): an admin scores every game and
// nobody else scores any. Only admins sign in (docs/changes/2026-10-27-admin-only.md), so the page
// asks for the league's latest games, unfiltered, and lists each for entry; the route is behind
// MANAGE_SCHEDULE and the `score_entry` setting.
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ScoresPage from '../frontend/src/pages/ScoresPage.jsx';

const mocks = vi.hoisted(() => ({
  calls: /** @type {Array<[string, any[]]>} */ ([]),
  games: /** @type {any[]} */ ([]),
}));

vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: () => ({ currentOrganization: { id: 'org-a' } }),
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
  it('asks for the league’s latest games, unfiltered, and lists each for entry', async () => {
    mocks.games = [GAME, { ...GAME, id: 'g2', away_team: { id: 'team-y', name: 'Comets' } }];
    renderPage();
    await waitFor(() => expect(callsTo('limit')).toHaveLength(1));
    expect(callsTo('or')).toEqual([]);
    expect(callsTo('limit')[0]).toEqual([200]);
    expect(await screen.findByText('Rivals')).toBeInTheDocument();
    expect(screen.getByText('Comets')).toBeInTheDocument();
  });

  it('shows the grid with its empty message when no game has been played', async () => {
    renderPage();
    expect(await screen.findByRole('grid', { name: 'Scores grid' })).toBeInTheDocument();
    expect(screen.getByText(/No past games yet/)).toBeInTheDocument();
  });
});
