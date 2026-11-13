// @vitest-environment jsdom
/**
 * The Standings page's "Recent Games" over the SAVED schedule (F11-3 task C3 of
 * docs/changes/2026-11-06-games-table-source-of-truth.md): the list is the season's saved games whose start has
 * passed, and a score is sent as both numbers together (the database refuses one without the other). The league is
 * saved through the real save; the page is the real page over the real mock client.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import {
  ORG,
  SEASON,
  TEAM_NAMES,
  assignment,
  client,
  gameId,
  save,
  score,
  seedLeague,
} from './helpers/savedScheduleWorld.js';

const mocks = vi.hoisted(() => ({ role: 'admin' }));

vi.mock('../frontend/src/lib/supabaseClient.js', async () => {
  const { mockSupabase } = await import('../frontend/src/lib/mockSupabaseClient.js');
  return { supabase: mockSupabase };
});
vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: () => ({
    currentOrganization: { id: '00000000-0000-4000-8000-0000000000a3', name: 'Synthetic FC' },
    currentSeasonSetting: { id: '00000000-0000-4000-8000-00000000a301' },
    orgMember: { role: mocks.role },
  }),
}));
vi.mock('../frontend/src/contexts/AuthContext.jsx', () => ({
  useAuth: () => ({ user: { id: 'mock-admin-id' } }),
}));
vi.mock('../frontend/src/hooks/useFeatures.js', () => ({
  useFeatures: () => ({ genderModel: 'split', isEnabled: () => true }),
}));
vi.mock('../frontend/src/lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const { default: LeagueStandings } = await import('../frontend/src/pages/LeagueStandings.jsx');

const scores = async () => {
  const supabase = await client();
  const { data } = await supabase.from('game_scores').select('*').eq('organization_id', ORG);
  return data.map((row) => [row.game_id, row.score_home, row.score_away]);
};
const cards = () => screen.getAllByTestId('game-score-card');
const standing = (name) =>
  screen.getByTestId(`standings-row-${name.replace(/\s+/g, '-').toLowerCase()}`);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-20T12:00:00Z'));
  seedLeague();
  mocks.role = 'admin';
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('LeagueStandings :: Recent Games are the saved schedule', () => {
  it('lists the played games of the saved schedule with their scores, and no note about another table', async () => {
    const run = await save([
      assignment('comets', 'rockets', 'slot-1'),
      assignment('meteors', 'planets', 'slot-4', { week: 2 }),
    ]);
    await score(await gameId(run, 'comets', 'rockets'), 2, 1);
    mocks.role = 'viewer';
    render(<LeagueStandings />);
    await waitFor(() => expect(cards()).toHaveLength(2));
    // Newest first.
    expect(cards()[0]).toHaveTextContent(TEAM_NAMES.meteors);
    expect(cards()[1]).toHaveTextContent(TEAM_NAMES.comets);
    expect(cards()[1]).toHaveTextContent(/2\s*-\s*1/);
    expect(cards()[1]).toHaveTextContent('U10');
    expect(screen.queryByTestId('recent-games-source-note')).toBeNull();
    // And the table above is computed from the same score.
    expect(within(standing(TEAM_NAMES.comets)).getAllByRole('cell')[3]).toHaveTextContent('1');
  });

  it('holds one score until the other is entered, then saves both and the table follows', async () => {
    const run = await save([assignment('comets', 'rockets', 'slot-1')]);
    const id = await gameId(run, 'comets', 'rockets');
    render(<LeagueStandings />);
    await waitFor(() => expect(cards()).toHaveLength(1));
    fireEvent.change(screen.getByLabelText('Home Score'), { target: { value: '3' } });
    expect(screen.getByLabelText('Home Score')).toHaveValue(3);
    expect(await screen.findByTestId('score-needs-both')).toHaveTextContent(
      'Enter both scores to save.'
    );
    expect(await scores()).toEqual([]);
    expect(screen.queryByRole('alert')).toBeNull();

    fireEvent.change(screen.getByLabelText('Away Score'), { target: { value: '1' } });
    await waitFor(async () => expect(await scores()).toEqual([[id, 3, 1]]));
    await waitFor(() =>
      expect(within(standing(TEAM_NAMES.comets)).getAllByRole('cell')[3]).toHaveTextContent('1')
    );
    expect(screen.queryByTestId('score-needs-both')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a save the database refuses is said in words, and the card goes back to the saved score', async () => {
    const run = await save([assignment('comets', 'rockets', 'slot-1')]);
    await gameId(run, 'comets', 'rockets');
    render(<LeagueStandings />);
    await waitFor(() => expect(cards()).toHaveLength(1));
    await save([assignment('meteors', 'planets', 'slot-2')]);
    fireEvent.change(screen.getByLabelText('Home Score'), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('Away Score'), { target: { value: '1' } });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The score was not saved. This game is no longer in the saved schedule: reload the page to see the schedule as it is now. Nothing was changed.'
    );
    expect(await scores()).toEqual([]);
    await waitFor(() => expect(screen.getByLabelText('Home Score')).toHaveValue(null));
  });

  it('says there are no recent games when no schedule is saved', async () => {
    render(<LeagueStandings />);
    expect(await screen.findByText('No past games found to enter scores.')).toBeInTheDocument();
    expect(SEASON).toBeTruthy();
  });
});

describe('LeagueStandings :: only scores are sent (F11-3 review R7)', () => {
  it('the boxes take whole numbers from 0; a negative one is held and said, and nothing is sent', async () => {
    await save([assignment('comets', 'rockets', 'slot-1')]);
    render(<LeagueStandings />);
    await waitFor(() => expect(cards()).toHaveLength(1));
    const home = screen.getByLabelText('Home Score');
    expect(home).toHaveAttribute('min', '0');
    expect(home).toHaveAttribute('step', '1');
    expect(home).toHaveAttribute('inputmode', 'numeric');
    fireEvent.change(home, { target: { value: '-1' } });
    fireEvent.change(screen.getByLabelText('Away Score'), { target: { value: '2' } });
    expect(await screen.findByTestId('score-not-a-score')).toHaveTextContent(
      'A score is a whole number, 0 or more.'
    );
    expect(await scores()).toEqual([]);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('LeagueStandings :: Recent Games is a bounded read (F11-3 review R9)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('asks the server for the current run’s started games, newest first, at most 50, with only what a card shows', async () => {
    await save([assignment('comets', 'rockets', 'slot-1')]);
    const supabase = await client();
    const realFrom = supabase.from.bind(supabase);
    const calls = [];
    vi.spyOn(supabase, 'from').mockImplementation((table) => {
      const builder = realFrom(table);
      if (table !== 'game_assignments') return builder;
      const wrap = (query) =>
        new Proxy(query, {
          get(target, key) {
            const value = target[key];
            if (typeof value !== 'function' || key === 'then') return value;
            return (...args) => {
              calls.push([key, ...args]);
              return wrap(value.apply(target, args));
            };
          },
        });
      return wrap(builder);
    });
    render(<LeagueStandings />);
    await waitFor(() => expect(cards()).toHaveLength(1));
    const methods = calls.map(([method]) => method);
    expect(methods).toContain('lte');
    expect(calls.find(([m]) => m === 'lte')[1]).toBe('start');
    expect(calls.find(([m]) => m === 'order')).toEqual(['order', 'start', { ascending: false }]);
    expect(calls.find(([m]) => m === 'limit')).toEqual(['limit', 50]);
    const select = calls.find(([m]) => m === 'select')[1];
    expect(select).not.toMatch(/game_slots|fields|locations/);
  });
});

describe('LeagueStandings :: a correction never shows older standings (F11-3 fix round 3, Codex P2)', () => {
  afterEach(() => vi.restoreAllMocks());

  /** Holds every standings read until released; `releaseAll` answers the held ones newest first. */
  async function holdStandings() {
    const supabase = await client();
    const realFrom = supabase.from.bind(supabase);
    const held = [];
    const state = { holding: false };
    vi.spyOn(supabase, 'from').mockImplementation((table) => {
      const builder = realFrom(table);
      if (table !== 'view_league_standings' || !state.holding) return builder;
      const realSelect = builder.select.bind(builder);
      builder.select = (...args) => {
        const query = realSelect(...args);
        const wrap = (q) =>
          new Proxy(q, {
            get(target, key) {
              if (key === 'then') {
                return (resolve, reject) =>
                  new Promise((go) => held.push(go)).then(() => target.then(resolve, reject));
              }
              const value = target[key];
              return typeof value === 'function' ? (...a) => wrap(value.apply(target, a)) : value;
            },
          });
        return wrap(query);
      };
      return builder;
    });
    return {
      state,
      held,
      releaseAll: async () => {
        while (held.length > 0) {
          const go = held.pop();
          await act(async () => go());
        }
      },
    };
  }
  const goalsFor = () => within(standing(TEAM_NAMES.comets)).getAllByRole('cell')[6].textContent;

  it('2-0 then 3-0, the refreshes answered in reverse order: the table shows three goals for', async () => {
    const run = await save([assignment('comets', 'rockets', 'slot-1')]);
    const id = await gameId(run, 'comets', 'rockets');
    render(<LeagueStandings />);
    await waitFor(() => expect(cards()).toHaveLength(1));
    const reads = await holdStandings();
    reads.state.holding = true;
    fireEvent.change(screen.getByLabelText('Home Score'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('Away Score'), { target: { value: '0' } });
    await waitFor(async () => expect(await scores()).toEqual([[id, 2, 0]]));
    await waitFor(() => expect(reads.held.length).toBe(1));
    // The correction, typed while the first refresh is still out.
    fireEvent.change(screen.getByLabelText('Home Score'), { target: { value: '3' } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await reads.releaseAll();
    reads.state.holding = false;
    // If the correction was held back until the first refresh came, it is typed again now.
    if ((await scores())[0][1] !== 3) {
      await waitFor(() => expect(screen.getByLabelText('Home Score')).toBeEnabled());
      fireEvent.change(screen.getByLabelText('Home Score'), { target: { value: '3' } });
    }
    await waitFor(async () => expect(await scores()).toEqual([[id, 3, 0]]));
    await waitFor(() => expect(goalsFor()).toBe('3'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(goalsFor()).toBe('3');
  });

  it('a refresh that fails after a save releases the game and says so in words', async () => {
    await save([assignment('comets', 'rockets', 'slot-1')]);
    render(<LeagueStandings />);
    await waitFor(() => expect(cards()).toHaveLength(1));
    const supabase = await client();
    const realFrom = supabase.from.bind(supabase);
    vi.spyOn(supabase, 'from').mockImplementation((table) => {
      const builder = realFrom(table);
      if (table !== 'view_league_standings') return builder;
      const realSelect = builder.select.bind(builder);
      builder.select = (...args) => {
        const query = realSelect(...args);
        const failing = new Proxy(query, {
          get(target, key) {
            if (key === 'then')
              return (resolve) => resolve({ data: null, error: { message: 'boom' } });
            const value = target[key];
            return typeof value === 'function' ? () => failing : value;
          },
        });
        return failing;
      };
      return builder;
    });
    fireEvent.change(screen.getByLabelText('Home Score'), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText('Away Score'), { target: { value: '0' } });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The score was saved, but the standings could not be read again: reload the page to see them.'
    );
    await waitFor(() => expect(screen.getByLabelText('Home Score')).toBeEnabled());
  });
});
