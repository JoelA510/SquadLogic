// @vitest-environment jsdom
// The Scores & Results page over the SAVED schedule (F11-3 task C3 of
// docs/changes/2026-11-06-games-table-source-of-truth.md; BLOCKING for turning score entry on). The league is saved
// through the real save of the mock database, the page is the real page over the real mock client, and what it
// writes is read back from `game_scores`. A score is both numbers or none: the page holds a half-entered score and
// sends the two together.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import {
  ORG,
  SEASON,
  TEAM_NAMES,
  TZ,
  assignment,
  client,
  gameId,
  save,
  score,
  seedLeague,
} from './helpers/savedScheduleWorld.js';

const mocks = vi.hoisted(() => ({
  seasons: /** @type {any[]} */ ([]),
  season: /** @type {any} */ (null),
  toast: /** @type {any} */ (null),
}));

vi.mock('../frontend/src/lib/supabaseClient.js', async () => {
  const { mockSupabase } = await import('../frontend/src/lib/mockSupabaseClient.js');
  return { supabase: mockSupabase };
});
vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: () => ({
    currentOrganization: { id: '00000000-0000-4000-8000-0000000000a3' },
    currentSeasonSetting: mocks.season,
    availableSeasons: mocks.seasons,
  }),
}));
vi.mock('../frontend/src/hooks/useFeatures.js', () => ({
  useFeatures: () => ({ genderModel: 'split', isEnabled: () => true }),
}));
vi.mock('../frontend/src/components/ui/ToastHost.jsx', () => ({
  useToast: () => mocks.toast,
}));
vi.mock('../frontend/src/lib/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const { default: ScoresPage } = await import('../frontend/src/pages/ScoresPage.jsx');

const LIVE = { id: SEASON, status: 'active', timezone: TZ };
/** After both game days (2026-10-03 and 2026-10-10). */
const AFTER_BOTH = '2026-10-20T12:00:00Z';
/** Between them. */
const BETWEEN = '2026-10-05T12:00:00Z';

const scores = async () => {
  const supabase = await client();
  const { data } = await supabase.from('game_scores').select('*').eq('organization_id', ORG);
  return data.map((row) => [row.game_id, row.score_home, row.score_away]);
};
const rowOf = (name) => /** @type {HTMLElement} */ (screen.getByText(name).closest('tr'));
/** The cells of a row: date, division, home, HS, AS, away, status. */
const cell = (name, index) => within(rowOf(name)).getAllByRole('gridcell')[index];
async function type(name, index, value) {
  fireEvent.doubleClick(cell(name, index));
  const input = await screen.findByRole('spinbutton');
  fireEvent.change(input, { target: { value } });
  await act(async () => {
    fireEvent.keyDown(input, { key: 'Enter' });
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(AFTER_BOTH));
  seedLeague();
  mocks.season = LIVE;
  mocks.seasons = [LIVE];
  mocks.toast = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('ScoresPage lists the saved schedule', () => {
  it('says there is nothing to score when no schedule is saved', async () => {
    render(<ScoresPage />);
    expect(await screen.findByRole('grid', { name: 'Scores grid' })).toBeInTheDocument();
    expect(screen.getByText(/No past games yet/)).toBeInTheDocument();
  });

  it('lists the games of the saved schedule whose start has passed, newest first, with their score', async () => {
    const run = await save([
      assignment('comets', 'rockets', 'slot-1'),
      assignment('meteors', 'planets', 'slot-4', { week: 2 }),
    ]);
    await score(await gameId(run, 'comets', 'rockets'), 2, 1);
    render(<ScoresPage />);
    expect(await screen.findByText(TEAM_NAMES.rockets)).toBeInTheDocument();
    const names = screen.getAllByRole('row').map((row) => row.textContent);
    expect(names.findIndex((text) => text.includes(TEAM_NAMES.planets))).toBeLessThan(
      names.findIndex((text) => text.includes(TEAM_NAMES.rockets))
    );
    expect(cell(TEAM_NAMES.rockets, 3)).toHaveTextContent('2');
    expect(cell(TEAM_NAMES.rockets, 4)).toHaveTextContent('1');
    expect(cell(TEAM_NAMES.rockets, 6)).toHaveTextContent('Final');
    expect(cell(TEAM_NAMES.planets, 6)).toHaveTextContent('Awaiting');
    expect(cell(TEAM_NAMES.rockets, 1)).toHaveTextContent('U10');
  });

  it('does not list a game that has not started', async () => {
    vi.setSystemTime(new Date(BETWEEN));
    await save([
      assignment('comets', 'rockets', 'slot-1'),
      assignment('meteors', 'planets', 'slot-4', { week: 2 }),
    ]);
    render(<ScoresPage />);
    expect(await screen.findByText(TEAM_NAMES.rockets)).toBeInTheDocument();
    expect(screen.queryByText(TEAM_NAMES.planets)).toBeNull();
  });

  it('lists a game moved by a later save once, and not the row it left in the earlier run', async () => {
    await save([assignment('comets', 'rockets', 'slot-1')]);
    await save([assignment('comets', 'rockets', 'slot-4', { week: 2 })]);
    render(<ScoresPage />);
    expect(await screen.findByText(TEAM_NAMES.rockets)).toBeInTheDocument();
    expect(screen.getAllByText(TEAM_NAMES.rockets)).toHaveLength(1);
  });
});

describe('ScoresPage sends both scores of a game together', () => {
  async function open() {
    const run = await save([assignment('comets', 'rockets', 'slot-1')]);
    const id = await gameId(run, 'comets', 'rockets');
    render(<ScoresPage />);
    await screen.findByText(TEAM_NAMES.rockets);
    return id;
  }

  it('holds the first score, says a second is needed, and saves when both are entered', async () => {
    const id = await open();
    await type(TEAM_NAMES.rockets, 3, '3');
    // One score is not a result: nothing is sent, the number stays in its cell, and the row says what is missing.
    expect(await scores()).toEqual([]);
    expect(cell(TEAM_NAMES.rockets, 3)).toHaveTextContent('3');
    expect(cell(TEAM_NAMES.rockets, 6)).toHaveTextContent('Enter both scores');
    expect(screen.queryByRole('alert')).toBeNull();

    await type(TEAM_NAMES.rockets, 4, '1');
    await waitFor(async () => expect(await scores()).toEqual([[id, 3, 1]]));
    await waitFor(() => expect(cell(TEAM_NAMES.rockets, 6)).toHaveTextContent('Final'));
    expect(mocks.toast).toHaveBeenCalledWith('Score saved', 'success');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('changes one side of a saved score in one save, and clears a score only when both are emptied', async () => {
    const id = await open();
    await score(id, 2, 2);
    cleanup();
    render(<ScoresPage />);
    await screen.findByText(TEAM_NAMES.rockets);
    await type(TEAM_NAMES.rockets, 3, '4');
    await waitFor(async () => expect(await scores()).toEqual([[id, 4, 2]]));

    await type(TEAM_NAMES.rockets, 3, '');
    // Half cleared: the saved score stands until the other side is emptied too.
    expect(await scores()).toEqual([[id, 4, 2]]);
    expect(cell(TEAM_NAMES.rockets, 6)).toHaveTextContent('Enter both scores');
    await type(TEAM_NAMES.rockets, 4, '');
    await waitFor(async () => expect(await scores()).toEqual([]));
    await waitFor(() => expect(cell(TEAM_NAMES.rockets, 6)).toHaveTextContent('Awaiting'));
  });

  it('a save the database refuses is said in words that stay, and the row goes back', async () => {
    const id = await open();
    // The schedule is saved again without the game while the page is open: it is no longer in the current run.
    await save([assignment('meteors', 'planets', 'slot-2')]);
    await type(TEAM_NAMES.rockets, 3, '3');
    await type(TEAM_NAMES.rockets, 4, '1');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      'The score was not saved. This game is no longer in the saved schedule: reload the page to see the schedule as it is now. Nothing was changed.'
    );
    expect(alert.textContent).not.toMatch(/22023|game_not_current/);
    expect(await scores()).toEqual([]);
    expect(id).toBeTruthy();
    await waitFor(() => expect(cell(TEAM_NAMES.rockets, 6)).toHaveTextContent('Awaiting'));
  });
});

describe('ScoresPage: a completed season’s scores are history', () => {
  it('lists them, cannot edit them, and says why', async () => {
    const run = await save([assignment('comets', 'rockets', 'slot-1')]);
    await score(await gameId(run, 'comets', 'rockets'), 1, 0);
    mocks.season = { ...LIVE, status: 'completed' };
    mocks.seasons = [mocks.season];
    render(<ScoresPage />);
    expect(await screen.findByText(TEAM_NAMES.rockets)).toBeInTheDocument();
    expect(screen.getByTestId('season-readonly-note')).toHaveTextContent('completed season');
    fireEvent.doubleClick(cell(TEAM_NAMES.rockets, 3));
    expect(screen.queryByRole('spinbutton')).toBeNull();
  });

  it('CONTROL: the active season’s game opens its editor and shows no note', async () => {
    await save([assignment('comets', 'rockets', 'slot-1')]);
    render(<ScoresPage />);
    await screen.findByText(TEAM_NAMES.rockets);
    expect(screen.queryByTestId('season-readonly-note')).toBeNull();
    fireEvent.doubleClick(cell(TEAM_NAMES.rockets, 3));
    expect(await screen.findByRole('spinbutton')).toBeInTheDocument();
  });
});

describe('ScoresPage: results that are not in the saved schedule are counted, not hidden', () => {
  it('says how many, and says nothing when there is none', async () => {
    const run = await save([assignment('comets', 'rockets', 'slot-1')]);
    await score(await gameId(run, 'comets', 'rockets'), 1, 0);
    render(<ScoresPage />);
    await screen.findByText(TEAM_NAMES.rockets);
    expect(screen.queryByTestId('scores-outside-schedule')).toBeNull();
    cleanup();

    // Old data only (a scored game is held, so a save cannot leave it behind): a later run that does not hold it.
    const supabase = await client();
    const db = JSON.parse(sessionStorage.getItem('__MOCK_DB__'));
    db.scheduler_runs.push({
      id: 'run-later',
      organization_id: ORG,
      season_settings_id: SEASON,
      run_type: 'game',
      status: 'completed',
      completed_at: '2026-10-15T00:00:00Z',
    });
    window.__saveMockDB__
      ? window.__saveMockDB__(db)
      : sessionStorage.setItem('__MOCK_DB__', JSON.stringify(db));
    expect(supabase).toBeTruthy();
    render(<ScoresPage />);
    expect(await screen.findByTestId('scores-outside-schedule')).toHaveTextContent(
      '1 earlier result is not listed here: its game is no longer in the saved schedule. It still counts in the standings.'
    );
  });
});
