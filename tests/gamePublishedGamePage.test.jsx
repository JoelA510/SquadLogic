/**
 * PR 3 of the schedule expansion (docs/changes/2026-11-03-schedule-expansion.md, 3.4 and 3.6): one game's Published
 * state on the Games page, in the list, through the real page and the real mock client.
 *
 * - The list says each game's state in words and carries a switch; turning one on is one call with one id and no dialog.
 * - Turning one off opens "Allow changes", sends nothing until Confirm, and gives focus back.
 * - A game's history shows each Published and each "Changes allowed" with the reason and the note, as the database
 *   returns it for that game's row, and says plainly that a game moved to another slot or week starts with none.
 *
 * Not asserted, because it is not true: that a game's Published state or history follows it to another slot or week
 * (the save keys a game on (home, away, slot, week) and writes no id; lesson 95).
 */
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockSupabase } from '../frontend/src/lib/mockSupabaseClient.js';
import { ORG, SEASON, TZ, seedWorld } from './helpers/publishedGamesWorld.js';

const ROLE = vi.hoisted(() => ({ value: /** @type {any} */ (null) }));

vi.mock('../frontend/src/lib/supabaseClient.js', async () => {
  const { mockSupabase: client } = await import('../frontend/src/lib/mockSupabaseClient.js');
  return { supabase: client, supabaseReady: Promise.resolve() };
});
vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: () => ROLE.value,
}));
vi.mock('../frontend/src/hooks/useTeamSummary.js', async () => {
  const { ROSTER } = await import('./helpers/publishedGamesWorld.js');
  const value = {
    summary: { teams: ROSTER },
    loading: false,
    error: null,
    status: 'completed',
    progress: 100,
    generatedAt: '2026-09-01',
  };
  return { useTeamSummary: () => value };
});
vi.mock('../frontend/src/hooks/usePracticeSummary.js', () => ({
  usePracticeSummary: () => ({
    practiceSummary: null,
    practiceReadinessSnapshot: null,
    generatedAt: null,
    loading: false,
    error: null,
    runId: null,
    refetch: () => {},
  }),
}));
vi.mock('../frontend/src/hooks/useCurrentPracticeSchedule.js', () => ({
  useCurrentPracticeSchedule: () => ({
    assignments: [],
    loading: false,
    error: null,
    refetch: () => {},
  }),
}));
vi.mock('../frontend/src/hooks/useFieldClosures.js', () => ({
  useFieldClosures: () => ({ closures: [], loading: false, error: null, refresh: () => {} }),
}));
vi.mock('../frontend/src/hooks/useAutoRunOnNavigate.js', () => ({
  useAutoRunOnNavigate: () => {},
}));
vi.mock('../frontend/src/lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), log: vi.fn(), info: vi.fn() },
}));
vi.mock('../frontend/src/utils/gamePersistenceClient.js', () => ({
  persistGameScheduleReview: async () => ({ runId: 'run-new' }),
}));

const { default: GameSchedulingPage } =
  await import('../frontend/src/pages/GameSchedulingPage.jsx');
const { ROLE_PERMISSIONS, ROLES } = await import('../frontend/src/constants/permissions.js');

beforeEach(() => {
  ROLE.value = {
    currentOrganization: { id: ORG, name: 'Synthetic FC' },
    currentSeasonSetting: { id: SEASON, timezone: TZ, status: 'active' },
    featureFlags: {},
    permissions: ROLE_PERMISSIONS[ROLES.ADMIN],
    loading: false,
    seasonSettingsLoading: false,
  };
});
afterEach(() => {
  vi.restoreAllMocks();
});

const summary = () => screen.getByTestId('published-summary');
/** The switch of one game, by the names of its teams. */
const switchOf = (home, away) =>
  screen.getByRole('switch', { name: `Published: Synthetic ${home} versus Synthetic ${away}` });
const rowOf = (home, away) =>
  within(screen.getByTestId('game-schedule-list'))
    .getAllByRole('row')
    .find((row) => row.textContent?.includes(`Synthetic ${home} vs Synthetic ${away}`));
const rpcCalls = (spy) =>
  spy.mock.calls
    .filter(([name]) => name === 'admin_set_games_published')
    .map(([, params]) => params);

async function mount() {
  seedWorld();
  render(
    <MemoryRouter>
      <GameSchedulingPage />
    </MemoryRouter>
  );
  await waitFor(() => expect(summary()).toHaveTextContent('2 of 6 saved games Published'));
  // The list follows the saved games by one render (it is state set from them).
  await waitFor(() => expect(screen.getAllByRole('switch')).toHaveLength(6));
}

describe('the list says each game’s state, and carries its switch', () => {
  it('has a Published column, a switch per saved game, and the words for each state', async () => {
    await mount();
    expect(screen.getByRole('columnheader', { name: 'Published' })).toBeInTheDocument();
    expect(screen.getAllByRole('switch')).toHaveLength(6);
    expect(switchOf('Comets', 'Rockets')).toHaveAttribute('aria-checked', 'true');
    expect(switchOf('Comets', 'Meteors')).toHaveAttribute('aria-checked', 'false');
    const words = (home, away) => within(rowOf(home, away)).getByTestId('published-state');
    expect(words('Comets', 'Rockets')).toHaveTextContent('Published');
    expect(words('Comets', 'Meteors')).toHaveTextContent('Not published');
    // ga-3 was published once and released: changes allowed, in words, and a separate number in the line.
    expect(words('Rockets', 'Meteors')).toHaveTextContent('Changes allowed');
    expect(summary()).toHaveTextContent('2 of 6 saved games Published, 1 with changes allowed');
  });
});

describe('turning one game on', () => {
  it('is one call with one id and no dialog, and the row and the line follow the database', async () => {
    await mount();
    const rpc = vi.spyOn(mockSupabase, 'rpc');
    fireEvent.click(switchOf('Comets', 'Meteors'));
    await waitFor(() =>
      expect(summary()).toHaveTextContent('3 of 6 saved games Published, 1 with changes allowed')
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(rpcCalls(rpc)).toEqual([
      {
        p_organization_id: ORG,
        p_assignment_ids: ['ga-2'],
        p_published: true,
        p_reason_code: null,
        p_note: null,
        p_scope: { kind: 'selection' },
      },
    ]);
    await waitFor(() =>
      expect(switchOf('Comets', 'Meteors')).toHaveAttribute('aria-checked', 'true')
    );
    expect(screen.getByTestId('published-bar-notice')).toHaveTextContent('Published 1 game.');
  });

  it('turning on a game that had changes allowed publishes it again', async () => {
    await mount();
    fireEvent.click(switchOf('Rockets', 'Meteors'));
    await waitFor(() =>
      expect(summary()).toHaveTextContent('3 of 6 saved games Published, 0 with changes allowed')
    );
  });

  it('a refusal names the game and gives the database’s words', async () => {
    await mount();
    vi.spyOn(mockSupabase, 'rpc').mockImplementation(async (name) =>
      name === 'admin_set_games_published'
        ? {
            data: null,
            error: {
              code: '23503',
              message: 'game ga-2 does not exist in this organization',
              details: 'game_not_found',
            },
          }
        : { data: [], error: null }
    );
    fireEvent.click(switchOf('Comets', 'Meteors'));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Synthetic Comets vs Synthetic Meteors: game ga-2 does not exist in this organization'
    );
    expect(switchOf('Comets', 'Meteors')).toHaveAttribute('aria-checked', 'false');
  });

  it('a second press while the first is being saved sends one call', async () => {
    await mount();
    const rpc = vi.spyOn(mockSupabase, 'rpc');
    const toggle = switchOf('Comets', 'Meteors');
    fireEvent.click(toggle);
    fireEvent.click(toggle);
    await waitFor(() => expect(summary()).toHaveTextContent('3 of 6 saved games Published'));
    expect(rpcCalls(rpc)).toHaveLength(1);
  });
});

describe('turning one game off is "Allow changes"', () => {
  it('opens the dialog for that game, sends nothing until Confirm, then sends the reason, the note and the game', async () => {
    await mount();
    const rpc = vi.spyOn(mockSupabase, 'rpc');
    fireEvent.click(switchOf('Comets', 'Rockets'));
    const dialog = await screen.findByRole('dialog', { name: 'Allow changes to Published games' });
    expect(within(dialog).getByTestId('allow-changes-heading')).toHaveTextContent(
      'Allow changes to 1 Published game'
    );
    expect(within(dialog).getByTestId('allow-changes-games')).toHaveTextContent(
      'Synthetic Comets vs Synthetic Rockets'
    );
    expect(rpcCalls(rpc)).toEqual([]);
    // Still on while the dialog is open.
    expect(switchOf('Comets', 'Rockets')).toHaveAttribute('aria-checked', 'true');

    fireEvent.change(within(dialog).getByLabelText('Reason for allowing changes'), {
      target: { value: 'field-change' },
    });
    fireEvent.change(within(dialog).getByLabelText('Note (optional)'), {
      target: { value: 'North Field is closed that week' },
    });
    fireEvent.click(within(dialog).getByRole('checkbox'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm and allow changes' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(rpcCalls(rpc)).toEqual([
      {
        p_organization_id: ORG,
        p_assignment_ids: ['ga-1'],
        p_published: false,
        p_reason_code: 'field-change',
        p_note: 'North Field is closed that week',
        p_scope: { kind: 'selection' },
      },
    ]);
    await waitFor(() =>
      expect(summary()).toHaveTextContent('1 of 6 saved games Published, 2 with changes allowed')
    );
    expect(switchOf('Comets', 'Rockets')).toHaveAttribute('aria-checked', 'false');
    expect(within(rowOf('Comets', 'Rockets')).getByTestId('published-state')).toHaveTextContent(
      'Changes allowed'
    );
  });

  it('gives focus back to the switch that opened it once the saved schedule has been read', async () => {
    await mount();
    const opener = switchOf('Comets', 'Rockets');
    opener.focus();
    fireEvent.click(opener);
    const dialog = await screen.findByRole('dialog');
    expect(screen.getByTestId('allow-changes-heading')).toHaveFocus();
    fireEvent.change(within(dialog).getByLabelText('Reason for allowing changes'), {
      target: { value: 'other' },
    });
    fireEvent.click(within(dialog).getByRole('checkbox'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm and allow changes' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(switchOf('Comets', 'Rockets')).toHaveFocus());
  });

  it('Cancel gives focus straight back and sends nothing', async () => {
    await mount();
    const rpc = vi.spyOn(mockSupabase, 'rpc');
    const opener = switchOf('Comets', 'Rockets');
    opener.focus();
    fireEvent.click(opener);
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' })
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(opener).toHaveFocus();
    expect(rpcCalls(rpc)).toEqual([]);
  });

  it('after a bulk release leaves its button nothing to do, focus lands on the count', async () => {
    await mount();
    fireEvent.change(screen.getByLabelText('Which games'), { target: { value: 'division' } });
    fireEvent.change(screen.getByLabelText('Division'), { target: { value: 'U12 Girls' } });
    const opener = screen.getByRole('button', { name: 'Allow changes to 1 game' });
    opener.focus();
    fireEvent.click(opener);
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Reason for allowing changes'), {
      target: { value: 'conflict-fix' },
    });
    fireEvent.click(within(dialog).getByRole('checkbox'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm and allow changes' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(summary()).toHaveTextContent('1 of 6 saved games Published'));
    await waitFor(() => expect(summary()).toHaveFocus());
  });
});

describe('a game’s history', () => {
  async function allowChangesFor(home, away, reason, note) {
    fireEvent.click(switchOf(home, away));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Reason for allowing changes'), {
      target: { value: reason },
    });
    if (note) {
      fireEvent.change(within(dialog).getByLabelText('Note (optional)'), {
        target: { value: note },
      });
    }
    fireEvent.click(within(dialog).getByRole('checkbox'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm and allow changes' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(switchOf(home, away)).toHaveAttribute('aria-checked', 'false'));
  }

  it('shows each act with who did it, the reason and the note', async () => {
    await mount();
    // ga-2: published, then released with a reason: two acts on one record.
    fireEvent.click(switchOf('Comets', 'Meteors'));
    await waitFor(() =>
      expect(switchOf('Comets', 'Meteors')).toHaveAttribute('aria-checked', 'true')
    );
    await waitFor(() => expect(summary()).toHaveTextContent('3 of 6 saved games Published'));
    await allowChangesFor(
      'Comets',
      'Meteors',
      'coach-request',
      'The coach asked for a later start'
    );
    await waitFor(() =>
      expect(summary()).toHaveTextContent('2 of 6 saved games Published, 2 with changes allowed')
    );

    fireEvent.click(
      screen.getByRole('button', { name: 'History: Synthetic Comets versus Synthetic Meteors' })
    );
    const dialog = await screen.findByRole('dialog', {
      name: 'History: Synthetic Comets versus Synthetic Meteors',
    });
    const entries = await within(dialog).findAllByTestId('game-history-entry');
    expect(entries).toHaveLength(2);
    // Newest first: the release, then the publication.
    expect(entries[0]).toHaveTextContent('Changes allowed');
    expect(entries[0]).toHaveTextContent('Synthetic Admin');
    expect(entries[0]).toHaveTextContent('Reason: Coach request');
    expect(entries[0]).toHaveTextContent('Note: The coach asked for a later start');
    expect(entries[1]).toHaveTextContent('Published');
    expect(entries[1]).not.toHaveTextContent(/Reason:/);
  });

  it('says that a moved game is a new record: it starts with no history, and the old record keeps this one', async () => {
    await mount();
    fireEvent.click(
      screen.getByRole('button', { name: 'History: Synthetic Comets versus Synthetic Rockets' })
    );
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByTestId('game-history-empty')).toHaveTextContent(
      'No history is recorded for this game yet.'
    );
    expect(dialog).toHaveTextContent(/saved as a new game: it starts with no history/);
    expect(dialog).toHaveTextContent(/the old record keeps this one/);
  });

  it('a read the database refuses is an alert in its words, not an empty list', async () => {
    await mount();
    const real = mockSupabase.rpc.bind(mockSupabase);
    vi.spyOn(mockSupabase, 'rpc').mockImplementation(async (name, params) =>
      name === 'get_schedule_audit_log'
        ? {
            data: null,
            error: {
              code: '42501',
              message: 'Access denied: only an administrator reads it',
              details: 'admin_required',
            },
          }
        : real(name, params)
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'History: Synthetic Comets versus Synthetic Rockets' })
    );
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Access denied: only an administrator reads it'
    );
    expect(within(dialog).queryByTestId('game-history-empty')).not.toBeInTheDocument();
  });

  it('Close returns focus to the History button', async () => {
    await mount();
    const opener = screen.getByRole('button', {
      name: 'History: Synthetic Comets versus Synthetic Rockets',
    });
    opener.focus();
    fireEvent.click(opener);
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByTestId('game-history-empty');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(opener).toHaveFocus();
  });
});
