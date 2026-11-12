/**
 * The Standings page's own score entry says in words when the database will not take a score from it (review of #725,
 * R5), with the same alert the Scores page shows and never a `window.alert`.
 *
 * Since 20261122010000 a score is kept against the saved schedule and both scores are entered together, while this
 * page's "Recent Games" list still reads the earlier games table and saves a score as each box is typed (F11-3 repoints
 * it). The page also says, where the list is, that the list is of the earlier table.
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SCORE_NOT_SAVED_HERE } from '../frontend/src/utils/scoreSaveRefusal.js';

const mocks = vi.hoisted(() => ({ rpc: /** @type {any} */ (null) }));

vi.mock('../frontend/src/lib/supabaseClient.js', () => {
  const GAME = {
    id: 'legacy-1',
    start_time: '2026-10-01T15:00:00Z',
    score_home: null,
    score_away: null,
    home_team: { id: 'a', name: 'Synthetic Aces', division: { name: 'U10' } },
    away_team: { id: 'b', name: 'Synthetic Rivals', division: { name: 'U10' } },
  };
  const builder = (table) => {
    const b = {
      select: () => b,
      eq: () => b,
      lte: () => b,
      order: () => b,
      limit: () => b,
      then: (resolve, reject) =>
        Promise.resolve({ data: table === 'games' ? [GAME] : [], error: null }).then(
          resolve,
          reject
        ),
    };
    return b;
  };
  return { supabase: { from: (table) => builder(table), rpc: (...args) => mocks.rpc(...args) } };
});
vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: () => ({
    currentOrganization: { id: 'org-1', name: 'Synthetic FC' },
    currentSeasonSetting: { id: 'season-1' },
    orgMember: { role: 'admin' },
  }),
}));
vi.mock('../frontend/src/contexts/AuthContext.jsx', () => ({
  useAuth: () => ({ user: { id: 'u' } }),
}));
vi.mock('../frontend/src/hooks/useFeatures.js', () => ({
  useFeatures: () => ({ genderModel: 'split', isEnabled: () => true }),
}));
vi.mock('../frontend/src/lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const { default: LeagueStandings } = await import('../frontend/src/pages/LeagueStandings.jsx');

beforeEach(() => {
  mocks.rpc = vi.fn();
  vi.spyOn(window, 'alert').mockImplementation(() => {});
});

async function typeHomeScore() {
  render(<LeagueStandings />);
  fireEvent.change(await screen.findByLabelText('Home Score'), { target: { value: '3' } });
  await waitFor(() => expect(mocks.rpc).toHaveBeenCalledTimes(1));
}

describe('LeagueStandings :: a score the database will not take from this page', () => {
  it('a game the database does not find: the alert the Scores page shows, and no window.alert', async () => {
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { code: '42501', message: 'Game not found in organization org-1' },
    });
    await typeHomeScore();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(SCORE_NOT_SAVED_HERE);
    expect(SCORE_NOT_SAVED_HERE).toBe(
      'The score was not saved. Scores are now kept against the saved schedule, and this page still lists games from the earlier games table, so it cannot save a score yet. Nothing was changed.'
    );
    expect(alert.textContent).not.toMatch(/42501|Game not found/);
    expect(window.alert).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Home Score')).toHaveValue(null);
  });

  it('one score without the other: the same alert', async () => {
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { code: '22023', details: 'score_one_sided', message: 'enter both' },
    });
    await typeHomeScore();
    expect(await screen.findByRole('alert')).toHaveTextContent(SCORE_NOT_SAVED_HERE);
    expect(window.alert).not.toHaveBeenCalled();
  });

  it('another failure is said in words on the page too, as itself', async () => {
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { code: '55000', message: 'Score entry is off' },
    });
    await typeHomeScore();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The score was not saved. Try again.');
    expect(alert).not.toHaveTextContent('earlier games table');
    expect(window.alert).not.toHaveBeenCalled();
  });

  it('says where the list is that it reads the earlier games table', async () => {
    render(<LeagueStandings />);
    expect(await screen.findByTestId('recent-games-source-note')).toHaveTextContent(
      'These games are read from the earlier games table, not from the saved schedule, until this page is updated.'
    );
  });
});
