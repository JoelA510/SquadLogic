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
import { getMockData, mockSupabase } from '../frontend/src/lib/mockSupabaseClient.js';
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
    // The summary renders from the saved rows; the list from a copy of them set one effect later, so the summary is
    // not a sync point for the switch and the badge (the file passed alone and failed in the suite): wait for them.
    await waitFor(() =>
      expect(switchOf('Comets', 'Rockets')).toHaveAttribute('aria-checked', 'false')
    );
    await waitFor(() =>
      expect(within(rowOf('Comets', 'Rockets')).getByTestId('published-state')).toHaveTextContent(
        'Changes allowed'
      )
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

/**
 * An RPC that COMMITS the change and then loses its answer: the shape supabase-js gives a failed fetch (`code` is the
 * empty string). The database has the new flag; the page was told nothing.
 */
function commitThenLoseTheAnswer() {
  const real = mockSupabase.rpc.bind(mockSupabase);
  return vi.spyOn(mockSupabase, 'rpc').mockImplementation(async (name, params) => {
    const answer = await real(name, params);
    if (name !== 'admin_set_games_published') return answer;
    return {
      data: null,
      error: { message: 'TypeError: Failed to fetch', details: 'stack', hint: '', code: '' },
    };
  });
}

describe('a lost answer is not a refusal: the page reads the saved flags again (finding of the Codex review)', () => {
  it('turning one game on: the change was committed, the answer was lost, and the switch and the line still follow the database', async () => {
    await mount();
    commitThenLoseTheAnswer();
    fireEvent.click(switchOf('Comets', 'Meteors'));
    // It says it does not know, in words, and does not say nothing was saved.
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Synthetic Comets vs Synthetic Meteors:');
    expect(alert).toHaveTextContent('not known whether the change was saved');
    expect(alert).toHaveTextContent('The saved schedule is read again to show what was saved.');
    expect(alert).not.toHaveTextContent(/were not changed/);
    // The database has it Published, and so does the screen once the saved schedule has been read again.
    expect(getMockData('game_assignments').find((g) => g.id === 'ga-2').published).toBe(true);
    await waitFor(() =>
      expect(summary()).toHaveTextContent('3 of 6 saved games Published, 1 with changes allowed')
    );
    await waitFor(() =>
      expect(switchOf('Comets', 'Meteors')).toHaveAttribute('aria-checked', 'true')
    );
  });

  it('control: a refusal that carries the database’s code changes nothing, and no read follows it (only the check before the call)', async () => {
    await mount();
    const reads = vi.spyOn(mockSupabase, 'from');
    const before = reads.mock.calls.filter(([table]) => table === 'game_assignments').length;
    const real = mockSupabase.rpc.bind(mockSupabase);
    vi.spyOn(mockSupabase, 'rpc').mockImplementation(async (name, params) =>
      name === 'admin_set_games_published'
        ? {
            data: null,
            error: { code: '42501', message: 'Access denied', details: 'admin_required' },
          }
        : real(name, params)
    );
    fireEvent.click(switchOf('Comets', 'Meteors'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Access denied');
    await waitFor(() => expect(screen.queryByTestId('published-reason')).not.toBeInTheDocument());
    // One read of the games, before the call (the check that they are in the saved schedule): none after the refusal.
    expect(reads.mock.calls.filter(([table]) => table === 'game_assignments').length).toBe(
      before + 1
    );
    expect(switchOf('Comets', 'Meteors')).toHaveAttribute('aria-checked', 'false');
  });

  it('allowing changes: the dialog stays open with the alert, and the saved flags are read again', async () => {
    await mount();
    commitThenLoseTheAnswer();
    fireEvent.click(switchOf('Comets', 'Rockets'));
    const dialog = await screen.findByRole('dialog', { name: 'Allow changes to Published games' });
    fireEvent.change(within(dialog).getByLabelText('Reason for allowing changes'), {
      target: { value: 'other' },
    });
    fireEvent.click(within(dialog).getByRole('checkbox'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm and allow changes' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'not known whether the change was saved'
    );
    expect(getMockData('game_assignments').find((g) => g.id === 'ga-1').published).toBe(false);
    await waitFor(() =>
      expect(summary()).toHaveTextContent('1 of 6 saved games Published, 2 with changes allowed')
    );
  });

  it('the bulk Publish too: the line follows the database after a lost answer', async () => {
    await mount();
    commitThenLoseTheAnswer();
    fireEvent.click(screen.getByRole('button', { name: 'Publish 4 games' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('not known whether');
    await waitFor(() =>
      expect(summary()).toHaveTextContent('6 of 6 saved games Published, 0 with changes allowed')
    );
  });
});

describe('focus is never left on nothing when a publish removes the row it was on (finding of the Codex review)', () => {
  const filter = (value) =>
    fireEvent.change(screen.getByLabelText('Show in the list'), { target: { value } });

  it('under "Not published", turning a game on removes its row and focus lands on the count', async () => {
    await mount();
    filter('not-published');
    await waitFor(() => expect(screen.getAllByRole('switch')).toHaveLength(3));
    const toggle = switchOf('Comets', 'Meteors');
    toggle.focus();
    expect(toggle).toHaveFocus();
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.getAllByRole('switch')).toHaveLength(2));
    await waitFor(() => expect(summary()).toHaveFocus());
    expect(document.body).not.toHaveFocus();
  });

  it('under "Changes allowed", publishing a released game removes its row and focus lands on the count', async () => {
    await mount();
    filter('changes-allowed');
    await waitFor(() => expect(screen.getAllByRole('switch')).toHaveLength(1));
    const toggle = switchOf('Rockets', 'Meteors');
    toggle.focus();
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.queryAllByRole('switch')).toHaveLength(0));
    await waitFor(() => expect(summary()).toHaveFocus());
  });

  it('control: with every game listed the switch is still there, and it has focus again once the line has been read', async () => {
    await mount();
    const toggle = switchOf('Comets', 'Meteors');
    toggle.focus();
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(summary()).toHaveTextContent('3 of 6 saved games Published, 1 with changes allowed')
    );
    await waitFor(() => expect(switchOf('Comets', 'Meteors')).toHaveFocus());
  });

  it('a bulk Publish leaves its button with nothing to do, and focus lands on the count', async () => {
    await mount();
    const opener = screen.getByRole('button', { name: 'Publish 4 games' });
    opener.focus();
    fireEvent.click(opener);
    await waitFor(() =>
      expect(summary()).toHaveTextContent('6 of 6 saved games Published, 0 with changes allowed')
    );
    await waitFor(() => expect(summary()).toHaveFocus());
  });

  it('a person who has moved on while it was saving keeps the focus they moved to', async () => {
    await mount();
    const toggle = switchOf('Comets', 'Meteors');
    toggle.focus();
    fireEvent.click(toggle);
    const elsewhere = screen.getByLabelText('Show in the list');
    elsewhere.focus();
    await waitFor(() =>
      expect(summary()).toHaveTextContent('3 of 6 saved games Published, 1 with changes allowed')
    );
    await waitFor(() => expect(screen.queryByTestId('published-reason')).not.toBeInTheDocument());
    expect(elsewhere).toHaveFocus();
  });
});

describe('the loaded schedule can be older than the database: publishing never names a row of an older run (sibling of the Codex finding on Exports)', () => {
  /** Another tab moved a game (ga-2 unless told) and applied: a newer run holds the games that stayed (same rows) and a NEW row for it. */
  function applyElsewhere(movedId = 'ga-2') {
    const rows = getMockData('game_assignments');
    window.__saveMockDB__({
      ...window.__MOCK_DB__,
      scheduler_runs: [
        ...getMockData('scheduler_runs'),
        {
          id: 'run-newer',
          organization_id: ORG,
          run_type: 'game',
          status: 'completed',
          season_settings_id: SEASON,
          completed_at: '2026-10-20T12:00:00Z',
          results: {},
        },
      ],
      game_assignments: [
        ...rows.map((g) => (g.id === movedId ? g : { ...g, run_id: 'run-newer' })),
        {
          ...rows.find((g) => g.id === movedId),
          id: `${movedId}-moved`,
          run_id: 'run-newer',
          slot_id: 'gs-8',
          game_slot_id: 'gs-8',
        },
      ],
    });
  }

  it('turning on a game that another tab has moved is refused before any call, says why, and reads the saved schedule again', async () => {
    await mount();
    applyElsewhere();
    const rpc = vi.spyOn(mockSupabase, 'rpc');
    fireEvent.click(switchOf('Comets', 'Meteors'));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Synthetic Comets vs Synthetic Meteors:');
    expect(alert).toHaveTextContent('no longer in the saved schedule');
    expect(alert).toHaveTextContent('Nothing was published');
    expect(rpcCalls(rpc)).toEqual([]);
    // The old row stays unpublished: it is the one the Games page could not release.
    expect(getMockData('game_assignments').find((g) => g.id === 'ga-2').published).toBe(false);
    // And the page now shows the schedule the database holds: the moved game is a new row, not Published.
    await waitFor(() => expect(screen.getAllByRole('switch')).toHaveLength(6));
    await waitFor(() =>
      expect(switchOf('Comets', 'Meteors')).toHaveAttribute('aria-checked', 'false')
    );
    expect(
      getMockData('game_assignments')
        .filter((g) => g.published)
        .map((g) => g.id)
        .sort()
    ).toEqual(['ga-1', 'ga-5']);
  });

  it('the bulk Publish is refused whole when any of its games is no longer in the saved schedule', async () => {
    await mount();
    applyElsewhere();
    const rpc = vi.spyOn(mockSupabase, 'rpc');
    fireEvent.click(screen.getByRole('button', { name: 'Publish 4 games' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('1 of the 4 games');
    expect(rpcCalls(rpc)).toEqual([]);
    expect(
      getMockData('game_assignments')
        .filter((g) => g.published)
        .map((g) => g.id)
        .sort()
    ).toEqual(['ga-1', 'ga-5']);
  });

  it('a read that is refused is not an answer: nothing is published, and it says so', async () => {
    await mount();
    const real = mockSupabase.from.bind(mockSupabase);
    const refusing = new Proxy(
      {},
      {
        get: (_t, method) => () =>
          method === 'maybeSingle'
            ? Promise.resolve({ data: null, error: { code: '42501', message: 'read refused' } })
            : refusing,
      }
    );
    const rpc = vi.spyOn(mockSupabase, 'rpc');
    vi.spyOn(mockSupabase, 'from').mockImplementation((table) =>
      table === 'scheduler_runs' ? refusing : real(table)
    );
    fireEvent.click(switchOf('Comets', 'Meteors'));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('could not be read to check');
    expect(alert).toHaveTextContent('read refused');
    expect(rpcCalls(rpc)).toEqual([]);
  });

  it('control: turning OFF (Allow changes) is not held back by it: releasing an old row hides nothing from the page', async () => {
    await mount();
    applyElsewhere('ga-1');
    const rpc = vi.spyOn(mockSupabase, 'rpc');
    fireEvent.click(switchOf('Comets', 'Rockets'));
    const dialog = await screen.findByRole('dialog', { name: 'Allow changes to Published games' });
    fireEvent.change(within(dialog).getByLabelText('Reason for allowing changes'), {
      target: { value: 'other' },
    });
    fireEvent.click(within(dialog).getByRole('checkbox'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm and allow changes' }));
    await waitFor(() => expect(rpcCalls(rpc)).toHaveLength(1));
    expect(rpcCalls(rpc)[0]).toMatchObject({ p_assignment_ids: ['ga-1'], p_published: false });
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
