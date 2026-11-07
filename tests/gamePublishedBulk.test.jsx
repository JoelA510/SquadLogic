/**
 * PR 3 task C2 of the schedule expansion (docs/changes/2026-11-03-schedule-expansion.md, 3.6; owner decision 2): the
 * bulk bar on the Games page. "Publish" and "Allow changes" for all unpublished games, one division, one date or one
 * venue; the page resolves the scope to ids FROM THE SAVED SET, never from a filtered view, shows the count before it
 * sends, and shows the database's own words when a call is refused.
 *
 * Driven through the real page, the real `useDashboardData`, and the real mock client (its arm of
 * `admin_set_games_published` is held to the SQL by tests/mockGamePublished.test.js). The plant of this PR "the scope
 * resolved from the filtered view" turns "a filter is active and the count is still the saved count" red.
 *
 * The league is in tests/helpers/publishedGamesWorld.js: six saved games, two Published (ga-1, ga-5), one with changes
 * allowed (ga-3), three never published (ga-2, ga-4, ga-6).
 */
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockSupabase, getMockData } from '../frontend/src/lib/mockSupabaseClient.js';
import { ORG, SEASON, TZ, savedGames, seedWorld } from './helpers/publishedGamesWorld.js';

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
const SAVE = vi.hoisted(() => ({ impl: /** @type {any} */ (null) }));
vi.mock('../frontend/src/utils/gamePersistenceClient.js', () => ({
  persistGameScheduleReview: (...args) => SAVE.impl(...args),
}));

const { default: GameSchedulingPage } =
  await import('../frontend/src/pages/GameSchedulingPage.jsx');
const { ROLE_PERMISSIONS, ROLES } = await import('../frontend/src/constants/permissions.js');

function organizationContext(overrides = {}) {
  return {
    currentOrganization: { id: ORG, name: 'Synthetic FC' },
    currentSeasonSetting: { id: SEASON, timezone: TZ, status: 'active' },
    featureFlags: {},
    permissions: ROLE_PERMISSIONS[ROLES.ADMIN],
    loading: false,
    seasonSettingsLoading: false,
    ...overrides,
  };
}

beforeEach(() => {
  sessionStorage.clear();
  ROLE.value = organizationContext();
  SAVE.impl = async () => ({ runId: 'run-new' });
});
afterEach(() => {
  vi.restoreAllMocks();
});

const summary = () => screen.getByTestId('published-summary');
const publishButton = (n) =>
  screen.getByRole('button', { name: new RegExp(`^Publish ${n} games?$`) });
const allowButton = (n) =>
  screen.getByRole('button', { name: new RegExp(`^Allow changes to ${n} games?$`) });
/** The values of a picker's options, in order. */
const optionValues = (select) =>
  within(select)
    .getAllByRole('option')
    .map((option) => /** @type {HTMLOptionElement} */ (option).value);
const listRows = () => within(screen.getByTestId('game-schedule-list')).getAllByRole('row');
const pick = (label, value) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
const rpcCalls = (spy) =>
  spy.mock.calls
    .filter(([name]) => name === 'admin_set_games_published')
    .map(([, params]) => params);

async function mount(options) {
  seedWorld(options);
  render(
    <MemoryRouter>
      <GameSchedulingPage />
    </MemoryRouter>
  );
  await waitFor(() => expect(summary()).toHaveTextContent(/of \d+ saved games? Published/));
}

describe('the persistent line says what the numbers count', () => {
  it('Published and changes allowed are separate numbers over the saved games', async () => {
    await mount();
    expect(summary()).toHaveTextContent('2 of 6 saved games Published, 1 with changes allowed');
  });

  it('no saved schedule: it says so and the controls are off, with the reason', async () => {
    await mount({ games: [] });
    expect(summary()).toHaveTextContent('0 of 0 saved games Published, 0 with changes allowed');
    expect(screen.getByTestId('published-reason')).toHaveTextContent(
      /no saved schedule|nothing to publish/i
    );
    expect(screen.queryByRole('button', { name: /^Publish \d+ games?$/ })).not.toBeInTheDocument();
  });
});

describe('the count is shown before anything is sent', () => {
  it('each button names how many games it will act on, and nothing is sent until it is pressed', async () => {
    await mount();
    const rpc = vi.spyOn(mockSupabase, 'rpc');
    // All saved games: 4 are not Published (ga-2, ga-3, ga-4, ga-6), 2 are (ga-1, ga-5).
    expect(publishButton(4)).toBeEnabled();
    expect(allowButton(2)).toBeEnabled();
    expect(screen.getByTestId('published-scope-count')).toHaveTextContent(
      'In this scope: 4 not Published, 2 Published.'
    );
    expect(rpcCalls(rpc)).toEqual([]);
  });

  it('a scope with nothing to do is off and says so, rather than sending an empty call', async () => {
    await mount({
      games: savedGames({
        'ga-2': { published: true },
        'ga-3': { published: true },
        'ga-4': { published: true },
        'ga-6': { published: true },
      }),
    });
    const publish = screen.getByRole('button', { name: /^Publish 0 games$/ });
    expect(publish).toBeDisabled();
    expect(publish).toHaveAccessibleDescription(/nothing to publish/i);
    expect(allowButton(6)).toBeEnabled();
  });
});

describe('each scope counts the saved games it names', () => {
  it.each([
    ['division', 'Division', 'U12 Girls', 2, 1],
    ['date', 'Date', '2026-10-10', 2, 1],
    ['venue', 'Venue', 'South Park', 2, 1],
  ])('one %s', async (kind, label, value, publishes, allows) => {
    await mount();
    pick('Which games', kind);
    pick(label, value);
    expect(publishButton(publishes)).toBeEnabled();
    expect(allowButton(allows)).toBeEnabled();
  });

  it('a division, date or venue not yet chosen names no games', async () => {
    await mount();
    pick('Which games', 'division');
    expect(screen.getByRole('button', { name: /^Publish 0 games$/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^Allow changes to 0 games$/ })).toBeDisabled();
  });

  it('the pickers list every division, date and venue the saved games have', async () => {
    await mount();
    pick('Which games', 'division');
    expect(optionValues(screen.getByLabelText('Division'))).toEqual(['', 'U10 Boys', 'U12 Girls']);
    pick('Which games', 'date');
    expect(optionValues(screen.getByLabelText('Date'))).toEqual(['', '2026-10-03', '2026-10-10']);
    pick('Which games', 'venue');
    expect(optionValues(screen.getByLabelText('Venue'))).toEqual(['', 'North Park', 'South Park']);
  });
});

describe('the scope is enumerated from the saved set, not the filtered view', () => {
  it('with the list filtered to Published, the list shows 2 games and the bar still counts the saved 4 and 2', async () => {
    await mount();
    pick('Show in the list', 'published');
    // The list is filtered...
    await waitFor(() => expect(listRows()).toHaveLength(1 + 2));
    // ...and the count is still the saved count.
    expect(summary()).toHaveTextContent('2 of 6 saved games Published, 1 with changes allowed');
    expect(publishButton(4)).toBeEnabled();
    expect(allowButton(2)).toBeEnabled();
  });

  it('pressing Publish under that filter sends exactly the four unpublished saved games', async () => {
    await mount();
    pick('Show in the list', 'published');
    await waitFor(() => expect(listRows()).toHaveLength(3));
    const rpc = vi.spyOn(mockSupabase, 'rpc');
    fireEvent.click(publishButton(4));
    await waitFor(() => expect(rpcCalls(rpc)).toHaveLength(1));
    const [call] = rpcCalls(rpc);
    expect([...call.p_assignment_ids].sort()).toEqual(['ga-2', 'ga-3', 'ga-4', 'ga-6']);
    expect(call).toMatchObject({
      p_organization_id: ORG,
      p_published: true,
      p_reason_code: null,
      p_note: null,
      p_scope: { kind: 'all' },
    });
  });

  it('a division picked under a filter that hides it is still a division of the saved set', async () => {
    await mount();
    pick('Show in the list', 'changes-allowed');
    await waitFor(() => expect(listRows()).toHaveLength(2));
    pick('Which games', 'division');
    expect(optionValues(screen.getByLabelText('Division'))).toEqual(['', 'U10 Boys', 'U12 Girls']);
    pick('Division', 'U12 Girls');
    // ga-4, ga-6 are not Published and are not in the filtered list (which holds only ga-3).
    expect(publishButton(2)).toBeEnabled();
  });
});

describe('Publish sends the scope and the page shows the result', () => {
  it('a division: the call names its scope, the line updates from the saved schedule, the result is said', async () => {
    await mount();
    pick('Which games', 'division');
    pick('Division', 'U12 Girls');
    const rpc = vi.spyOn(mockSupabase, 'rpc');
    fireEvent.click(publishButton(2));
    await waitFor(() =>
      expect(summary()).toHaveTextContent('4 of 6 saved games Published, 1 with changes allowed')
    );
    const [call] = rpcCalls(rpc);
    expect([...call.p_assignment_ids].sort()).toEqual(['ga-4', 'ga-6']);
    expect(call.p_scope).toEqual({ kind: 'division', value: 'U12 Girls' });
    expect(screen.getByTestId('published-bar-notice')).toHaveTextContent('Published 2 games.');
    // The database has them Published (the page read it back).
    expect(
      getMockData('game_assignments')
        .filter((g) => g.published)
        .map((g) => g.id)
        .sort()
    ).toEqual(['ga-1', 'ga-4', 'ga-5', 'ga-6']);
  });

  it('all unpublished games: the line reads 6 of 6, with no game left with changes allowed', async () => {
    await mount();
    fireEvent.click(publishButton(4));
    await waitFor(() =>
      expect(summary()).toHaveTextContent('6 of 6 saved games Published, 0 with changes allowed')
    );
  });
});

describe('a refused call shows the database’s words and changes nothing on screen', () => {
  it('Publish refused: the message is an alert, the line is as it was, the buttons come back', async () => {
    await mount();
    const message = 'game ga-2 does not exist in this organization';
    vi.spyOn(mockSupabase, 'rpc').mockImplementation(async (name) =>
      name === 'admin_set_games_published'
        ? { data: null, error: { code: '23503', message, details: 'game_not_found' } }
        : { data: [], error: null }
    );
    fireEvent.click(publishButton(4));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(message);
    expect(summary()).toHaveTextContent('2 of 6 saved games Published, 1 with changes allowed');
    await waitFor(() => expect(publishButton(4)).toBeEnabled());
  });

  it('says how far a split call got when a later call is refused', async () => {
    // Two calls need more than 2,400 games, which the small league does not have: the wording is held where it is
    // made (tests/gamePublishedClient.test.js, tests/gamePublishedText.test.js). Here: a refusal with no progress.
    await mount();
    vi.spyOn(mockSupabase, 'rpc').mockImplementation(async (name) =>
      name === 'admin_set_games_published'
        ? {
            data: null,
            error: {
              code: '42501',
              message: 'Access denied: only an administrator',
              details: 'admin_required',
            },
          }
        : { data: [], error: null }
    );
    fireEvent.click(publishButton(4));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Access denied: only an administrator'
    );
    expect(screen.getByRole('alert')).not.toHaveTextContent(/calls were saved/);
  });
});

describe('Allow changes in bulk goes through the dialog', () => {
  it('opens with the Published games of the scope, sends nothing until Confirm, then sends the reason, note and scope', async () => {
    await mount();
    pick('Which games', 'division');
    pick('Division', 'U12 Girls');
    const rpc = vi.spyOn(mockSupabase, 'rpc');
    fireEvent.click(allowButton(1));
    const dialog = await screen.findByRole('dialog', { name: 'Allow changes to Published games' });
    expect(within(dialog).getByTestId('allow-changes-heading')).toHaveTextContent(
      'Allow changes to 1 Published game'
    );
    expect(within(dialog).getByTestId('allow-changes-games')).toHaveTextContent(
      'Synthetic Planets vs Synthetic Stars'
    );
    expect(rpcCalls(rpc)).toEqual([]);
    fireEvent.change(within(dialog).getByLabelText('Reason for allowing changes'), {
      target: { value: 'coach-request' },
    });
    fireEvent.change(within(dialog).getByLabelText('Note (optional)'), {
      target: { value: 'Asked for a later start' },
    });
    fireEvent.click(within(dialog).getByRole('checkbox'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm and allow changes' }));
    await waitFor(() => expect(rpcCalls(rpc)).toHaveLength(1));
    expect(rpcCalls(rpc)[0]).toMatchObject({
      p_assignment_ids: ['ga-5'],
      p_published: false,
      p_reason_code: 'coach-request',
      p_note: 'Asked for a later start',
      p_scope: { kind: 'division', value: 'U12 Girls' },
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() =>
      expect(summary()).toHaveTextContent('1 of 6 saved games Published, 2 with changes allowed')
    );
    expect(screen.getByTestId('published-bar-notice')).toHaveTextContent(
      'Changes allowed for 1 game.'
    );
  });

  it('a refusal stays in the dialog as an alert, in the database’s words, and the line does not move', async () => {
    await mount();
    fireEvent.click(allowButton(2));
    const dialog = await screen.findByRole('dialog');
    vi.spyOn(mockSupabase, 'rpc').mockImplementation(async (name) =>
      name === 'admin_set_games_published'
        ? {
            data: null,
            error: {
              code: '22023',
              message: 'game ga-1 is Published and was changed meanwhile',
              details: 'x',
            },
          }
        : { data: [], error: null }
    );
    fireEvent.change(within(dialog).getByLabelText('Reason for allowing changes'), {
      target: { value: 'other' },
    });
    fireEvent.click(within(dialog).getByRole('checkbox'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm and allow changes' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'game ga-1 is Published and was changed meanwhile'
    );
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(summary()).toHaveTextContent('2 of 6 saved games Published');
  });

  it('Cancel closes the dialog and sends nothing', async () => {
    await mount();
    const rpc = vi.spyOn(mockSupabase, 'rpc');
    fireEvent.click(allowButton(2));
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' })
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(rpcCalls(rpc)).toEqual([]);
  });
});

describe('the controls follow what the person may do and what the page is doing', () => {
  it('a person who may not change it sees the line and the filter and no bulk controls', async () => {
    ROLE.value = organizationContext({ permissions: ['view_schedule', 'manage_schedule'] });
    await mount();
    expect(summary()).toHaveTextContent('2 of 6 saved games Published');
    expect(screen.getByLabelText('Show in the list')).toBeInTheDocument();
    expect(screen.queryByLabelText('Which games')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Publish \d+ games?$/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    expect(screen.getByTestId('published-reason')).toHaveTextContent(/organization admin/i);
  });

  it('a completed season is read-only: the line shows, the controls do not', async () => {
    ROLE.value = organizationContext({
      currentSeasonSetting: { id: SEASON, timezone: TZ, status: 'completed' },
    });
    await mount();
    expect(summary()).toHaveTextContent('2 of 6 saved games Published');
    expect(screen.queryByLabelText('Which games')).not.toBeInTheDocument();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    expect(screen.getByTestId('published-reason')).toHaveTextContent(
      /season is complete|completed season/i
    );
  });

  it('while a staged schedule waits, the controls are off and say why; they come back when it is discarded', async () => {
    await mount();
    const run = await screen.findByRole('button', {
      name: 'Auto-Generate: run auto-scheduler optimization',
    });
    await waitFor(() => expect(run).toBeEnabled());
    fireEvent.click(run);
    await screen.findByRole('button', { name: /apply schedule/i });
    expect(screen.getByTestId('published-reason')).toHaveTextContent(/apply or discard/i);
    expect(
      screen
        .getAllByRole('switch')
        .every((toggle) => /** @type {HTMLButtonElement} */ (toggle).disabled)
    ).toBe(true);
    expect(screen.getByRole('button', { name: /^Publish \d+ games?$/ })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /discard review/i }));
    await waitFor(() => expect(screen.queryByTestId('published-reason')).not.toBeInTheDocument());
    expect(
      screen
        .getAllByRole('switch')
        .every((toggle) => !(/** @type {HTMLButtonElement} */ (toggle).disabled))
    ).toBe(true);
  });

  it('after Apply the page reads the saved schedule again before it offers the controls', async () => {
    await mount();
    const runs = vi.spyOn(mockSupabase, 'from');
    const reads = () => runs.mock.calls.filter(([table]) => table === 'game_assignments').length;
    const run = await screen.findByRole('button', {
      name: 'Auto-Generate: run auto-scheduler optimization',
    });
    await waitFor(() => expect(run).toBeEnabled());
    fireEvent.click(run);
    const apply = await screen.findByRole('button', { name: /apply schedule/i });
    await waitFor(() => expect(apply).toBeEnabled());
    const before = reads();
    fireEvent.click(apply);
    await waitFor(() => expect(reads()).toBeGreaterThan(before));
    // The ids on screen are the ones the database holds now (a moved game is a new row).
    await waitFor(() => expect(screen.queryByTestId('published-reason')).not.toBeInTheDocument());
  });
});
