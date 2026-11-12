// The Scores page (admin focus R6, migration 20261028010000): an admin scores every game and
// nobody else scores any. Only admins sign in (docs/changes/2026-10-27-admin-only.md), so the page
// asks for the league's latest games, unfiltered, and lists each for entry; the route is behind
// MANAGE_SCHEDULE and the `score_entry` setting.
import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ScoresPage from '../frontend/src/pages/ScoresPage.jsx';

const mocks = vi.hoisted(() => ({
  calls: /** @type {Array<[string, any[]]>} */ ([]),
  games: /** @type {any[]} */ ([]),
  seasons: /** @type {any[]} */ ([]),
  rpc: vi.fn(),
}));

vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: () => ({
    currentOrganization: { id: 'org-a' },
    availableSeasons: mocks.seasons,
  }),
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
  return { supabase: { from: () => builder(), rpc: (...args) => mocks.rpc(...args) } };
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
  mocks.seasons = [];
  mocks.rpc = vi.fn().mockResolvedValue({ data: {}, error: null });
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

  describe('a completed season’s games', () => {
    const OLD = { id: 'season-old', status: 'completed' };
    const LIVE = { id: 'season-live', status: 'active' };
    const scoreCell = (name) => {
      const row = screen.getByText(name).closest('tr');
      return within(/** @type {HTMLElement} */ (row)).getAllByRole('gridcell')[3];
    };

    it('lists them, cannot edit their scores, and says why; the active season’s games are editable', async () => {
      mocks.seasons = [OLD, LIVE];
      mocks.games = [
        {
          ...GAME,
          id: 'g-old',
          season_id: 'season-old',
          away_team: { id: 'x', name: 'Past Rivals' },
        },
        {
          ...GAME,
          id: 'g-live',
          season_id: 'season-live',
          away_team: { id: 'y', name: 'Live Rivals' },
        },
      ];
      renderPage();
      expect(await screen.findByText('Past Rivals')).toBeInTheDocument();
      expect(screen.getByTestId('season-readonly-note')).toHaveTextContent('completed season');

      fireEvent.doubleClick(scoreCell('Past Rivals'));
      expect(screen.queryByRole('spinbutton')).toBeNull();
      expect(scoreCell('Past Rivals').className).not.toContain('editable');

      // CONTROL: the same gesture on the active season's game opens the editor.
      fireEvent.doubleClick(scoreCell('Live Rivals'));
      expect(await screen.findByRole('spinbutton')).toBeInTheDocument();
      expect(mocks.rpc).not.toHaveBeenCalled();
    });

    it('takes a game with no season of its own from its division, and shows no note when none is history', async () => {
      mocks.seasons = [OLD, LIVE];
      mocks.games = [
        {
          ...GAME,
          id: 'g-div',
          season_id: null,
          home_team: {
            id: 'team-a',
            name: 'Aces',
            division: { name: 'U10', season_settings_id: 'season-old' },
          },
          away_team: { id: 'x', name: 'Division Rivals' },
        },
      ];
      renderPage();
      expect(await screen.findByText('Division Rivals')).toBeInTheDocument();
      expect(screen.getByTestId('season-readonly-note')).toBeInTheDocument();
      fireEvent.doubleClick(scoreCell('Division Rivals'));
      expect(screen.queryByRole('spinbutton')).toBeNull();
    });

    it('CONTROL: with only the active season there is no note', async () => {
      mocks.seasons = [LIVE];
      mocks.games = [{ ...GAME, season_id: 'season-live' }];
      renderPage();
      expect(await screen.findByText('Rivals')).toBeInTheDocument();
      expect(screen.queryByTestId('season-readonly-note')).toBeNull();
    });
  });

  describe('a score the database will not take from this page (between F11-2 and F11-3)', () => {
    // Since 20261122010000 `update_game_score` names a SAVED game and takes both scores or none, while this page still
    // lists the legacy games table and saves one cell at a time (F11-3 repoints it). Until then a save from here is
    // refused, and the page says so in words that stay on the page, not in a toast that says only that it failed.
    const cell = (name, index) => {
      const row = screen.getByText(name).closest('tr');
      return within(/** @type {HTMLElement} */ (row)).getAllByRole('gridcell')[index];
    };
    async function enter(value) {
      mocks.games = [GAME];
      renderPage();
      await screen.findByText('Rivals');
      fireEvent.doubleClick(cell('Rivals', 3));
      const input = await screen.findByRole('spinbutton');
      fireEvent.change(input, { target: { value } });
      fireEvent.keyDown(input, { key: 'Enter' });
      await waitFor(() => expect(mocks.rpc).toHaveBeenCalledTimes(1));
    }

    it('a game the database does not find: an alert in words, the cell back as it was', async () => {
      mocks.rpc = vi.fn().mockResolvedValue({
        data: null,
        error: { code: '42501', message: 'Game not found in organization org-1' },
      });
      await enter('3');
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(
        'The score was not saved. Scores are now kept against the saved schedule, and this page still lists games from the earlier games table, so it cannot save a score yet. Nothing was changed.'
      );
      expect(alert.textContent).not.toMatch(/42501|Game not found/);
    });

    it('one score without the other: the same alert', async () => {
      mocks.rpc = vi.fn().mockResolvedValue({
        data: null,
        error: {
          code: '22023',
          details: 'score_one_sided',
          message: 'enter both scores, or clear both',
        },
      });
      await enter('3');
      expect(await screen.findByRole('alert')).toHaveTextContent(
        /it cannot save a score yet\. Nothing was changed\./
      );
    });

    it('CONTROL: another failure is not called that, and a save that works shows no alert', async () => {
      mocks.rpc = vi
        .fn()
        .mockResolvedValue({ data: null, error: { code: '55000', message: 'Score entry is off' } });
      await enter('3');
      await waitFor(() => expect(mocks.rpc).toHaveBeenCalled());
      expect(screen.queryByRole('alert')).toBeNull();
    });
  });
});
