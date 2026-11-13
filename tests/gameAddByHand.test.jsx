/**
 * PR 8 of the schedule expansion (`docs/changes/2026-11-03-schedule-expansion.md`, 5.5, task H1): one game added by
 * hand from the Games page.
 *
 * A dialog takes a division, a home and an away team (an outside club allowed, 4.6) and either an open slot or a new
 * time (a field, a date, a start and an end). It stages a `manual` game into the review; Apply saves it through
 * `persist_game_schedule` like a move. A new time is a slot the database must hold first: on Apply the page calls
 * `ensure_game_slot`, then saves. The game starts unpublished.
 *
 * Driven through the real page, the real `useDashboardData` and the real mock client (its `ensure_game_slot` and its
 * `persist_game_schedule`, fed the rows the page's client would send), so what is asserted after Apply is what the
 * database would hold, read back by the page.
 *
 * The plan's plants, each turned red by a case here:
 *   - a game addable over a Published slot (the cases under "a Published slot is never added over");
 *   - a double booking blocked instead of flagged (the cases under "a double booking is flagged, not blocked");
 *   - a new game arriving Published (the cases under "the new game starts not Published").
 *
 * The league (placeholder names only): four teams of U10 and one outside club, two fields, four slots.
 *
 * | game | home v away         | week | date       | local       | field | state         |
 * | G1   | Comets v Rockets    | 1    | 2026-10-03 | 09:00-10:00 | north | Published     |
 * | G2   | Meteors v Planets   | 1    | 2026-10-03 | 09:00-10:00 | south | not published |
 *
 * Empty: gs-3 (north) and gs-4 (south), 2026-10-10 09:00-10:00, week 2. The season starts on Monday 2026-09-28.
 */
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prepareGamePersistenceSnapshot } from '../packages/core/src/gamePersistenceSnapshot.js';
import { getMockData, mockSupabase } from '../frontend/src/lib/mockSupabaseClient.js';
import { seedMockDb } from './helpers/seedMockDb.js';

const ORG = '00000000-0000-4000-8000-0000000000a8';
const SEASON = '00000000-0000-4000-8000-0000000000b8';
const DIVISION = '00000000-0000-4000-8000-0000000000c8';
/** A second division, with no teams: gs-4 is reserved for it (a slot of another division is flagged). */
const OTHER_DIVISION = '00000000-0000-4000-8000-0000000000c9';
const SAVED_RUN = '00000000-0000-4000-8000-0000000000d8';
const G1 = '00000000-0000-4000-8000-00000000e001';
const G2 = '00000000-0000-4000-8000-00000000e002';
const TZ = 'America/New_York';
const ADMIN = 'mock-admin-id';

const ROSTER = vi.hoisted(() => [
  { id: 'team-1', name: 'Synthetic Comets', division: 'U10' },
  { id: 'team-2', name: 'Synthetic Rockets', division: 'U10' },
  { id: 'team-3', name: 'Synthetic Meteors', division: 'U10' },
  { id: 'team-4', name: 'Synthetic Planets', division: 'U10' },
]);
/** What the stubbed client does with a save, per test, and what it was handed. */
const SAVE = vi.hoisted(() => ({
  impl: /** @type {any} */ (null),
  calls: /** @type {any[]} */ ([]),
}));

vi.mock('../frontend/src/lib/supabaseClient.js', async () => {
  const { mockSupabase: client } = await import('../frontend/src/lib/mockSupabaseClient.js');
  return { supabase: client, supabaseReady: Promise.resolve() };
});
vi.mock('../frontend/src/contexts/OrganizationContext.jsx', async () => {
  const { ROLE_PERMISSIONS: perms, ROLES: roles } =
    await import('../frontend/src/constants/permissions.js');
  const value = {
    currentOrganization: { id: '00000000-0000-4000-8000-0000000000a8', name: 'Synthetic FC' },
    currentSeasonSetting: {
      id: '00000000-0000-4000-8000-0000000000b8',
      timezone: 'America/New_York',
      status: 'active',
      season_start: '2026-09-28',
      season_end: '2026-12-31',
    },
    featureFlags: {},
    permissions: perms[roles.ADMIN],
    loading: false,
    seasonSettingsLoading: false,
  };
  return { useOrganization: () => value };
});
vi.mock('../frontend/src/hooks/useTeamSummary.js', () => {
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
/** What the page handed `DndContext`, so a test can finish a drop the way the library does. */
const DND = vi.hoisted(() => ({ props: /** @type {any} */ (null) }));
vi.mock('@dnd-kit/core', async (importOriginal) => {
  const actual = /** @type {any} */ (await importOriginal());
  return {
    ...actual,
    DndContext: (props) => {
      DND.props = props;
      return <actual.DndContext {...props} />;
    },
  };
});
vi.mock('../frontend/src/utils/gamePersistenceClient.js', () => ({
  persistGameScheduleReview: async (args) => {
    SAVE.calls.push(args);
    return SAVE.impl(args);
  },
}));

const { default: GameSchedulingPage } =
  await import('../frontend/src/pages/GameSchedulingPage.jsx');
const { planAddedGame, occupantAt, duplicateTupleRefusal } =
  await import('../frontend/src/utils/gameAddByHand.js');

const at = (date, hhmm) => {
  // 2026-10 is EDT (UTC-4).
  const [h, m] = hhmm.split(':').map(Number);
  return `${date}T${String(h + 4).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+00:00`;
};
const SLOTS = [
  ['gs-1', 'f-north', '2026-10-03', 1],
  ['gs-2', 'f-south', '2026-10-03', 1],
  ['gs-3', 'f-north', '2026-10-10', 2],
  ['gs-4', 'f-south', '2026-10-10', 2],
].map(([id, field, date, week]) => ({
  id,
  organization_id: ORG,
  division_id: id === 'gs-4' ? OTHER_DIVISION : null,
  field_id: field,
  slot_date: date,
  start_time: '09:00:00',
  end_time: '10:00:00',
  start: at(date, '09:00'),
  end: at(date, '10:00'),
  week_index: week,
  capacity: 1,
  created_at: '2026-09-01T00:00:00Z',
}));
const saved = (id, home, away, slot, published) => {
  const s = SLOTS.find((row) => row.id === slot);
  return {
    id,
    run_id: SAVED_RUN,
    organization_id: ORG,
    season_settings_id: SEASON,
    division: 'U10',
    week_index: s.week_index,
    slot_id: slot,
    game_slot_id: slot,
    field_id: s.field_id,
    start: s.start,
    end: s.end,
    home_team_id: home,
    away_team_id: away,
    assignment_source: 'auto',
    published,
    published_at: published ? '2026-10-01T12:00:00+00:00' : null,
    published_by: published ? ADMIN : null,
  };
};

function seed() {
  sessionStorage.clear();
  delete window.__MOCK_DB__;
  seedMockDb({
    organizations: [{ id: ORG, name: 'Synthetic FC', is_onboarded: true }],
    organization_members: [{ organization_id: ORG, profile_id: ADMIN, role: 'admin' }],
    profiles: [{ id: ADMIN, full_name: 'Synthetic Admin' }],
    season_settings: [
      {
        id: SEASON,
        organization_id: ORG,
        status: 'active',
        name: 'Synthetic',
        timezone: TZ,
        season_start: '2026-09-28',
        season_end: '2026-12-31',
      },
    ],
    divisions: [
      { id: DIVISION, organization_id: ORG, season_settings_id: SEASON, name: 'U10' },
      { id: OTHER_DIVISION, organization_id: ORG, season_settings_id: SEASON, name: 'U12' },
    ],
    teams: [
      ...ROSTER.map((team) => ({
        id: team.id,
        organization_id: ORG,
        division_id: DIVISION,
        name: team.name,
        is_external: false,
      })),
      {
        id: 'club-x',
        organization_id: ORG,
        division_id: DIVISION,
        name: 'Visiting Owls',
        is_external: true,
      },
    ],
    locations: [
      { id: 'loc-north', organization_id: ORG, name: 'North Park', effective_to: null },
      { id: 'loc-south', organization_id: ORG, name: 'South Park', effective_to: null },
    ],
    fields: [
      {
        id: 'f-north',
        name: 'North Field',
        organization_id: ORG,
        location_id: 'loc-north',
        active: true,
      },
      {
        id: 'f-south',
        name: 'South Field',
        organization_id: ORG,
        location_id: 'loc-south',
        active: true,
      },
    ],
    game_slots: SLOTS,
    scheduler_runs: [
      {
        id: SAVED_RUN,
        organization_id: ORG,
        run_type: 'game',
        status: 'completed',
        season_settings_id: SEASON,
        completed_at: '2026-10-01T12:00:00Z',
        results: {},
      },
    ],
    game_assignments: [
      saved(G1, 'team-1', 'team-2', 'gs-1', true),
      saved(G2, 'team-3', 'team-4', 'gs-2', false),
    ],
    audit_log: [],
  });
  sessionStorage.setItem('__MOCK_SESSION__', JSON.stringify({ user: { id: ADMIN } }));
}

/** The save as the database would take it: the rows the page's client builds, into the mock's writer. */
function saveLikeTheDatabase() {
  SAVE.impl = async ({ assignments, runMetadata }) => {
    const rows = prepareGamePersistenceSnapshot({ assignments, runMetadata }).payload
      .assignmentRows;
    const { data, error } = await mockSupabase.rpc('persist_game_schedule', {
      run_data: {
        organization_id: ORG,
        season_settings_id: SEASON,
        run_type: 'game',
        status: 'completed',
        results: runMetadata?.results ?? {},
      },
      assignments: rows,
    });
    if (error) throw Object.assign(new Error(error.message), { code: error.code });
    return { runId: data };
  };
}

beforeEach(() => {
  seed();
  SAVE.calls.length = 0;
  saveLikeTheDatabase();
});
afterEach(() => {
  vi.restoreAllMocks();
});

const orgGames = () => getMockData('game_assignments').filter((row) => row.organization_id === ORG);
const orgSlots = () => getMockData('game_slots').filter((row) => row.organization_id === ORG);
const listRows = () =>
  within(screen.getByTestId('game-schedule-list'))
    .getAllByRole('row')
    .slice(1)
    .map((row) => (row.textContent ?? '').replace(/\s+/g, ' ').trim());

async function mount() {
  render(
    <MemoryRouter>
      <GameSchedulingPage />
    </MemoryRouter>
  );
  await waitFor(() => expect(listRows()).toHaveLength(2));
  const add = await screen.findByRole('button', { name: 'Add a game' });
  await waitFor(() => expect(add).toBeEnabled());
  return add;
}

/** Open the dialog and fill it. `where` is `{ slot: <label start> }` or `{ field, date, start, end }`. */
async function fillDialog({ home, away, where }) {
  fireEvent.click(screen.getByRole('button', { name: 'Add a game' }));
  const dialog = await screen.findByRole('dialog', { name: 'Add a game' });
  const d = within(dialog);
  fireEvent.change(d.getByLabelText('Division'), { target: { value: 'U10' } });
  fireEvent.change(d.getByLabelText('Home team'), { target: { value: home } });
  fireEvent.change(d.getByLabelText('Away team'), { target: { value: away } });
  if (where.slot) {
    fireEvent.click(d.getByLabelText('An open slot'));
    const select = d.getByLabelText('Open slot');
    const option = within(select)
      .getAllByRole('option')
      .find((o) => (o.textContent ?? '').startsWith(where.slot));
    if (!option) throw new Error(`no open slot starting "${where.slot}"`);
    fireEvent.change(select, { target: { value: option.getAttribute('value') } });
  } else {
    fireEvent.click(d.getByLabelText('A new time'));
    fireEvent.change(d.getByLabelText('Field'), { target: { value: where.field } });
    fireEvent.change(d.getByLabelText('Date'), { target: { value: where.date } });
    fireEvent.change(d.getByLabelText('Starts'), { target: { value: where.start } });
    fireEvent.change(d.getByLabelText('Ends'), { target: { value: where.end } });
  }
  return dialog;
}

const addButton = (dialog) => within(dialog).getByRole('button', { name: 'Add to the review' });

async function apply() {
  const button = await screen.findByRole('button', { name: /apply schedule/i });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
}

describe('the staged game appears', () => {
  it('in an open slot: listed in the review as a new game, the status line says what was done', async () => {
    await mount();
    const dialog = await fillDialog({
      home: 'team-1',
      away: 'team-3',
      where: { slot: 'North Field' },
    });
    expect(addButton(dialog)).toBeEnabled();
    fireEvent.click(addButton(dialog));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await screen.findByText(/3 game assignments staged for review/)).toBeInTheDocument();
    const added = listRows().filter((row) =>
      row.startsWith('Synthetic Comets vs Synthetic Meteors')
    );
    expect(added).toHaveLength(1);
    expect(added[0]).toContain('North Field');
    expect(added[0]).toContain('Apply the schedule first');
    expect(
      screen.getByText(/Synthetic Comets vs Synthetic Meteors added to the review/)
    ).toHaveTextContent('It starts not Published.');
    // Nothing is written before Apply.
    expect(orgGames()).toHaveLength(2);
    expect(SAVE.calls).toHaveLength(0);
  });

  it('the open slots are the empty ones only, and an outside club can be the opponent', async () => {
    await mount();
    const dialog = await fillDialog({
      home: 'team-4',
      away: 'club-x',
      where: { slot: 'South Field' },
    });
    const d = within(dialog);
    const slotLabels = within(d.getByLabelText('Open slot'))
      .getAllByRole('option')
      .map((o) => o.textContent ?? '')
      .filter((text) => text !== '' && !text.startsWith('Choose'));
    // gs-3 and gs-4 are empty; gs-1 (Published) and gs-2 hold games.
    expect(slotLabels).toHaveLength(2);
    expect(slotLabels.every((label) => /10\/10\/2026/.test(label))).toBe(true);
    expect(
      within(d.getByLabelText('Away team')).getByRole('option', { name: /Visiting Owls/ })
    ).toHaveTextContent('(outside club)');
    fireEvent.click(addButton(dialog));
    await waitFor(() =>
      expect(
        listRows().filter((row) => row.startsWith('Synthetic Planets vs Visiting Owls'))
      ).toHaveLength(1)
    );
  });

  it('a new time: listed with its field and kickoff before the slot exists', async () => {
    await mount();
    const dialog = await fillDialog({
      home: 'team-2',
      away: 'team-4',
      where: { field: 'f-north', date: '2026-10-17', start: '11:00', end: '12:00' },
    });
    fireEvent.click(addButton(dialog));
    await waitFor(() =>
      expect(
        listRows().filter((row) => row.startsWith('Synthetic Rockets vs Synthetic Planets'))
      ).toHaveLength(1)
    );
    const [row] = listRows().filter((r) => r.startsWith('Synthetic Rockets vs Synthetic Planets'));
    expect(row).toContain('North Field');
    expect(row).toMatch(/11:00/);
    // The slot is made on Apply, not before.
    expect(orgSlots()).toHaveLength(4);
    expect(screen.getByText(/added to the review/)).toHaveTextContent(
      'The new time on North Field is made when you apply.'
    );
  });
});

describe('Apply saves it through the existing save, like a move', () => {
  it('an open slot: one save, the saved games with their ids and the new game with none, at its slot and week', async () => {
    const rpc = vi.spyOn(mockSupabase, 'rpc');
    await mount();
    fireEvent.click(
      addButton(
        await fillDialog({ home: 'team-1', away: 'team-3', where: { slot: 'North Field' } })
      )
    );
    await apply();
    await screen.findByText(/Game schedule applied through the persistence workflow\./);
    expect(SAVE.calls).toHaveLength(1);
    const sent = SAVE.calls[0].assignments;
    expect(sent).toHaveLength(3);
    const added = sent.find((a) => a.homeTeamId === 'team-1' && a.awayTeamId === 'team-3');
    expect(added).toMatchObject({
      slotId: 'gs-3',
      fieldId: 'f-north',
      weekIndex: 2,
      source: 'manual',
      division: 'U10',
    });
    expect(added.id).toBeUndefined();
    expect(
      sent
        .map((a) => a.id)
        .filter(Boolean)
        .sort()
    ).toEqual([G1, G2].sort());
    // An open slot needs no new slot.
    expect(rpc.mock.calls.some(([name]) => name === 'ensure_game_slot')).toBe(false);
    await waitFor(() => expect(orgGames()).toHaveLength(3));
  });

  it('a new time: the slot is made first (audited), then the save names it', async () => {
    const spy = vi.spyOn(mockSupabase, 'rpc');
    await mount();
    fireEvent.click(
      addButton(
        await fillDialog({
          home: 'team-2',
          away: 'team-4',
          where: { field: 'f-north', date: '2026-10-17', start: '11:00', end: '12:00' },
        })
      )
    );
    await apply();
    await screen.findByText(/Game schedule applied through the persistence workflow\./);
    const ensure = spy.mock.calls.filter(([name]) => name === 'ensure_game_slot');
    expect(ensure).toHaveLength(1);
    expect(ensure[0][1]).toMatchObject({
      p_organization_id: ORG,
      p_field_id: 'f-north',
      p_slot_date: '2026-10-17',
      p_start_time: '11:00',
      p_end_time: '12:00',
      p_week_index: 3,
    });
    const made = orgSlots().find((s) => s.slot_date === '2026-10-17');
    expect(made).toBeDefined();
    expect(
      getMockData('audit_log').filter(
        (row) => row.action === 'game.slot_created' && row.resource_id === made.id
      )
    ).toHaveLength(1);
    const added = SAVE.calls[0].assignments.find((a) => a.homeTeamId === 'team-2');
    expect(added).toMatchObject({ slotId: made.id, weekIndex: 3, source: 'manual' });
    // The ensure came before the save (the save's stub calls the mock's writer through the same rpc).
    const callOrder = (fn) =>
      spy.mock.invocationCallOrder[spy.mock.calls.findIndex(([n]) => n === fn)];
    expect(callOrder('ensure_game_slot')).toBeLessThan(callOrder('persist_game_schedule'));
  });
});

describe('the new game starts not Published', () => {
  it('staged: it can be moved on the grid like any game that is not Published (it is not held)', async () => {
    await mount();
    fireEvent.click(
      addButton(
        await fillDialog({ home: 'team-1', away: 'team-3', where: { slot: 'North Field' } })
      )
    );
    await screen.findByText(/3 game assignments staged for review/);
    fireEvent.click(screen.getByRole('button', { name: 'Enter Manual Override' }));
    await screen.findByTestId('game-schedule-grid');
    const card = screen
      .getByTestId('drop-zone-f-north:gs-3')
      .querySelector('[data-testid^="game-card-"]');
    expect(card).not.toBeNull();
    const c = within(/** @type {HTMLElement} */ (card));
    expect(c.queryByTestId('published-hold-note')).not.toBeInTheDocument();
    expect(c.getByRole('combobox')).toBeInTheDocument();
    // Control: the Published game's card is held.
    const held = screen.getByTestId(`game-card-${G1}`);
    expect(within(held).getByTestId('published-hold-note')).toBeInTheDocument();
  });

  it('applied: the saved row is not Published, the list says so, and nothing published it', async () => {
    await mount();
    fireEvent.click(
      addButton(
        await fillDialog({ home: 'team-1', away: 'team-3', where: { slot: 'North Field' } })
      )
    );
    await apply();
    await screen.findByText(/Game schedule applied through the persistence workflow\./);
    await waitFor(() => expect(orgGames()).toHaveLength(3));
    const row = orgGames().find((g) => g.home_team_id === 'team-1' && g.away_team_id === 'team-3');
    expect(row.published).not.toBe(true);
    expect(row.assignment_source).toBe('manual');
    expect(
      getMockData('audit_log').filter((r) => String(r.action).startsWith('game.publish'))
    ).toHaveLength(0);
    await waitFor(() => {
      const listed = listRows().find((r) => r.startsWith('Synthetic Comets vs Synthetic Meteors'));
      expect(listed).toContain('Not published');
    });
    // Control: the Published game is still Published.
    expect(listRows().find((r) => r.startsWith('Synthetic Comets vs Synthetic Rockets'))).toContain(
      'Published'
    );
  });
});

describe('a double booking is flagged, not blocked', () => {
  it('a team already playing and a field already in use at that time: both flagged, and the game is still added', async () => {
    await mount();
    // Comets play G1 at 09:00-10:00 on North; South holds G2 at 09:00-10:00.
    const dialog = await fillDialog({
      home: 'team-1',
      away: 'team-3',
      where: { field: 'f-south', date: '2026-10-03', start: '09:30', end: '10:30' },
    });
    const flags = within(dialog).getByTestId('add-game-warnings');
    expect(flags).toHaveTextContent('Synthetic Comets already plays');
    expect(flags).toHaveTextContent('Synthetic Meteors already plays');
    expect(flags).toHaveTextContent('South Field already has');
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument();
    expect(addButton(dialog)).toBeEnabled();
    fireEvent.click(addButton(dialog));
    expect(await screen.findByText(/3 game assignments staged for review/)).toBeInTheDocument();
    const banner = screen.getByTestId('game-conflict-banner');
    // Both sides are busy at 09:30: Comets play G1 (North) and Meteors play G2 (South).
    expect(within(banner).getAllByTestId('conflict-item-team-double-booked')).toHaveLength(2);
    expect(within(banner).getByTestId('conflict-item-field-overlap')).toBeInTheDocument();
    expect(screen.getByText(/added to the review/)).toHaveTextContent('Flagged:');

    await apply();
    await screen.findByText(/Game schedule applied through the persistence workflow\./);
    // The flags are recorded with the run, so the banner still says them once the saved schedule is read again.
    const warnings = SAVE.calls[0].runMetadata.results.warnings.map((w) => w.type).sort();
    expect(warnings).toEqual(['field-overlap', 'team-double-booked', 'team-double-booked']);
  });

  it('control: a free time on a free field flags nothing', async () => {
    await mount();
    const dialog = await fillDialog({
      home: 'team-1',
      away: 'team-3',
      where: { field: 'f-south', date: '2026-10-03', start: '11:00', end: '12:00' },
    });
    expect(within(dialog).queryByTestId('add-game-warnings')).not.toBeInTheDocument();
    expect(addButton(dialog)).toBeEnabled();
  });

  it('an outside club is never double-booked (it stands for several real teams)', () => {
    const review = [
      {
        id: 'x',
        homeTeamId: 'team-4',
        awayTeamId: 'club-x',
        homeTeamName: 'P',
        awayTeamName: 'X',
        fieldId: 'f-south',
        slotId: 'gs-2',
        start: at('2026-10-03', '09:00'),
        end: at('2026-10-03', '10:00'),
      },
    ];
    const result = planAddedGame(
      {
        division: 'U10',
        homeTeamId: 'team-1',
        awayTeamId: 'club-x',
        where: 'new',
        fieldId: 'f-north',
        date: '2026-10-03',
        startTime: '09:00',
        endTime: '10:00',
      },
      context({ review })
    );
    expect('game' in result && result.warnings).toEqual([]);
  });
});

describe('a Published slot is never added over', () => {
  it('a new time that is the slot of a Published game is refused, said, and nothing can be added', async () => {
    await mount();
    const dialog = await fillDialog({
      home: 'team-3',
      away: 'team-1',
      where: { field: 'f-north', date: '2026-10-03', start: '09:00', end: '10:00' },
    });
    expect(within(dialog).getByRole('alert')).toHaveTextContent(
      'Synthetic Comets vs Synthetic Rockets is Published in that slot'
    );
    expect(addButton(dialog)).toBeDisabled();
    fireEvent.click(addButton(dialog));
    expect(screen.queryByText(/staged for review/)).not.toBeInTheDocument();
  });

  it('the pure rule: an open-slot choice of a Published game cell is refused, and so is the cell of a game that is not', () => {
    const review = [
      {
        id: G1,
        persisted: true,
        published: true,
        homeTeamId: 'team-1',
        awayTeamId: 'team-2',
        homeTeamName: 'Synthetic Comets',
        awayTeamName: 'Synthetic Rockets',
        fieldId: 'f-north',
        slotId: 'gs-1',
        start: at('2026-10-03', '09:00'),
        end: at('2026-10-03', '10:00'),
      },
      {
        id: G2,
        persisted: true,
        published: false,
        homeTeamId: 'team-3',
        awayTeamId: 'team-4',
        homeTeamName: 'Synthetic Meteors',
        awayTeamName: 'Synthetic Planets',
        fieldId: 'f-south',
        slotId: 'gs-2',
        start: at('2026-10-03', '09:00'),
        end: at('2026-10-03', '10:00'),
      },
    ];
    const choice = (cellId) => ({
      division: 'U10',
      homeTeamId: 'team-3',
      awayTeamId: 'club-x',
      where: 'slot',
      cellId,
    });
    const refused = planAddedGame(choice('f-north:gs-1'), context({ review }));
    expect(refused).toEqual({
      refusal: expect.stringContaining('Synthetic Comets vs Synthetic Rockets is Published'),
    });
    // A slot that holds a game that is not Published is refused too: one game per slot (the grid draws one per cell).
    expect(planAddedGame(choice('f-south:gs-2'), context({ review }))).toEqual({
      refusal: expect.stringContaining(
        'Synthetic Meteors vs Synthetic Planets is already in that slot'
      ),
    });
    // A game with a score is held as a Published one is, and said so.
    expect(
      planAddedGame(
        choice('f-south:gs-2'),
        context({ review: [review[0], { ...review[1], scored: true }] })
      )
    ).toEqual({ refusal: expect.stringContaining('has a score in that slot') });
    // The held game is the occupant named first.
    expect(occupantAt('gs-1', review)?.id).toBe(G1);
    expect(occupantAt('gs-3', review)).toBeNull();
  });

  it('a slot the database finds on Apply that holds a Published game: refused before the save, nothing saved', async () => {
    const real = mockSupabase.rpc.bind(mockSupabase);
    vi.spyOn(mockSupabase, 'rpc').mockImplementation(async (name, params) =>
      name === 'ensure_game_slot'
        ? { data: { id: 'gs-1', created: false }, error: null }
        : real(name, params)
    );
    await mount();
    fireEvent.click(
      addButton(
        await fillDialog({
          home: 'team-3',
          away: 'team-4',
          where: { field: 'f-north', date: '2026-10-24', start: '09:00', end: '10:00' },
        })
      )
    );
    await apply();
    expect(
      await screen.findByText(/Synthetic Comets vs Synthetic Rockets is Published in that slot/)
    ).toBeInTheDocument();
    expect(SAVE.calls).toHaveLength(0);
    expect(orgGames()).toHaveLength(2);
    // The review is kept, to change or discard.
    expect(screen.getByText(/3 game assignments staged for review/)).toBeInTheDocument();
  });
});

describe('a failed save names the slot it left', () => {
  it('a new time made and then a refused save: the error says the slot is kept, unused, and names it', async () => {
    SAVE.impl = async () => {
      throw new Error('The save was refused.');
    };
    await mount();
    fireEvent.click(
      addButton(
        await fillDialog({
          home: 'team-2',
          away: 'team-4',
          where: { field: 'f-south', date: '2026-10-17', start: '13:00', end: '14:00' },
        })
      )
    );
    await apply();
    const error = await screen.findByText(/The save was refused\./);
    expect(error).toHaveTextContent(
      /The new time slot South Field, .*10\/17\/2026.*1:00 PM was made before the save and is kept, unused/
    );
    expect(orgSlots().filter((s) => s.slot_date === '2026-10-17')).toHaveLength(1);
    expect(orgGames()).toHaveLength(2);
  });

  it('a slot the database will not make: said, and nothing is saved', async () => {
    const real = mockSupabase.rpc.bind(mockSupabase);
    vi.spyOn(mockSupabase, 'rpc').mockImplementation(async (name, params) =>
      name === 'ensure_game_slot'
        ? {
            data: null,
            error: {
              code: '42501',
              message: 'Access denied: only an administrator of the organization makes a game slot',
            },
          }
        : real(name, params)
    );
    await mount();
    fireEvent.click(
      addButton(
        await fillDialog({
          home: 'team-2',
          away: 'team-4',
          where: { field: 'f-south', date: '2026-10-17', start: '13:00', end: '14:00' },
        })
      )
    );
    await apply();
    expect(
      await screen.findByText(/The new time could not be made: Access denied/)
    ).toHaveTextContent('Nothing was saved.');
    expect(SAVE.calls).toHaveLength(0);
  });
});

describe('the keyboard path', () => {
  it('a button opens the dialog with focus on its heading; every control is labelled; Escape closes it back to the button', async () => {
    const add = await mount();
    add.focus();
    fireEvent.click(add);
    const dialog = await screen.findByRole('dialog', { name: 'Add a game' });
    expect(document.activeElement).toBe(
      within(dialog).getByRole('heading', { name: 'Add a game to the review' })
    );
    const d = within(dialog);
    for (const label of ['Division', 'Home team', 'Away team', 'An open slot', 'A new time']) {
      expect(d.getByLabelText(label)).toBeInTheDocument();
    }
    // Nothing chosen yet: the button says why it waits, in words.
    expect(addButton(dialog)).toBeDisabled();
    expect(d.getByTestId('add-game-why')).toHaveTextContent('Choose a division.');
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(document.activeElement).toBe(add);
  });

  it('the same team on both sides, or an end before the start, waits with the reason', async () => {
    await mount();
    let dialog = await fillDialog({
      home: 'team-1',
      away: 'team-1',
      where: { slot: 'North Field' },
    });
    expect(within(dialog).getByTestId('add-game-why')).toHaveTextContent(
      'Choose two different teams.'
    );
    expect(addButton(dialog)).toBeDisabled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    dialog = await fillDialog({
      home: 'team-1',
      away: 'team-3',
      where: { field: 'f-south', date: '2026-10-17', start: '12:00', end: '11:00' },
    });
    expect(within(dialog).getByTestId('add-game-why')).toHaveTextContent(
      'The game must end after it starts.'
    );
    expect(addButton(dialog)).toBeDisabled();
  });

  it('a date before the season starts is refused (no week can be given to it)', async () => {
    await mount();
    const dialog = await fillDialog({
      home: 'team-1',
      away: 'team-3',
      where: { field: 'f-south', date: '2026-09-20', start: '09:00', end: '10:00' },
    });
    expect(within(dialog).getByRole('alert')).toHaveTextContent('before the season starts');
    expect(addButton(dialog)).toBeDisabled();
  });
});

/** Fill the dialog, add the game, and wait until the review holds it. */
async function stage(args) {
  const dialog = await fillDialog(args);
  fireEvent.click(addButton(dialog));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
}

describe('review of #731: one game per slot, and a new time is the slot it names', () => {
  it('a new time in the slot of a game that is not Published is refused, naming the game in it (item 4)', async () => {
    await mount();
    let dialog = await fillDialog({
      home: 'team-1',
      away: 'team-3',
      where: { field: 'f-south', date: '2026-10-03', start: '09:00', end: '10:00' },
    });
    expect(within(dialog).getByRole('alert')).toHaveTextContent(
      'Synthetic Meteors vs Synthetic Planets is already in that slot. A slot holds one game: move that game first, or choose another slot or time.'
    );
    expect(addButton(dialog)).toBeDisabled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    // The same pair in its own slot is said as such.
    dialog = await fillDialog({
      home: 'team-3',
      away: 'team-4',
      where: { field: 'f-south', date: '2026-10-03', start: '09:00', end: '10:00' },
    });
    expect(within(dialog).getByRole('alert')).toHaveTextContent(
      'Synthetic Meteors vs Synthetic Planets is already in that slot, so it is not added again.'
    );
  });

  it('a slot that holds a game added by hand is no longer offered as open, and its time is refused (item 4)', async () => {
    await mount();
    await stage({ home: 'team-1', away: 'team-3', where: { slot: 'North Field' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add a game' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a game' });
    const labels = within(within(dialog).getByLabelText('Open slot'))
      .getAllByRole('option')
      .map((o) => o.textContent ?? '');
    expect(labels.filter((label) => label.startsWith('North Field'))).toHaveLength(0);
    expect(labels.filter((label) => label.startsWith('South Field'))).toHaveLength(1);
  });

  it('the same time twice before Apply: the second is refused, the same pair in its words (item 1)', async () => {
    await mount();
    const at17 = { field: 'f-north', date: '2026-10-17', start: '11:00', end: '12:00' };
    await stage({ home: 'team-2', away: 'team-4', where: at17 });
    let dialog = await fillDialog({ home: 'team-2', away: 'team-4', where: at17 });
    expect(within(dialog).getByRole('alert')).toHaveTextContent(
      'Synthetic Rockets vs Synthetic Planets is already in that slot, so it is not added again.'
    );
    expect(addButton(dialog)).toBeDisabled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    dialog = await fillDialog({ home: 'team-1', away: 'team-3', where: at17 });
    expect(within(dialog).getByRole('alert')).toHaveTextContent(
      'Synthetic Rockets vs Synthetic Planets is already in that slot. A slot holds one game'
    );
  });

  it('two games of one pair at one place are refused before the save, in the same words (item 1, the pure check)', () => {
    const one = {
      id: 'a',
      homeTeamId: 'team-1',
      awayTeamId: 'team-3',
      slotId: 'gs-9',
      weekIndex: 3,
    };
    expect(duplicateTupleRefusal([one, { ...one, id: 'b' }])).toContain(
      'is already in that slot, so it is not added again.'
    );
    // Control: another week, or the reverse pair, is no duplicate of the key.
    expect(duplicateTupleRefusal([one, { ...one, id: 'b', weekIndex: 4 }])).toBeNull();
    expect(
      duplicateTupleRefusal([one, { ...one, id: 'b', homeTeamId: 'team-3', awayTeamId: 'team-1' }])
    ).toBeNull();
  });

  it('a new time at an existing slot with another end is refused, naming the slot’s end; the same end is that slot (item 2)', async () => {
    await mount();
    let dialog = await fillDialog({
      home: 'team-1',
      away: 'team-3',
      where: { field: 'f-north', date: '2026-10-10', start: '09:00', end: '10:30' },
    });
    expect(within(dialog).getByRole('alert')).toHaveTextContent(
      'That time is an existing slot on North Field, and it ends at 10:00, not 10:30. Pick it as an open slot, or choose another time.'
    );
    expect(addButton(dialog)).toBeDisabled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    // Control: the same end is that slot, taken as it is (no new time made on Apply).
    dialog = await fillDialog({
      home: 'team-1',
      away: 'team-3',
      where: { field: 'f-north', date: '2026-10-10', start: '09:00', end: '10:00' },
    });
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument();
    fireEvent.click(addButton(dialog));
    await waitFor(() => expect(screen.getByText(/added to the review/)).toBeInTheDocument());
    expect(screen.getByText(/added to the review/)).not.toHaveTextContent('is made when you apply');
  });

  it('a slot the database already had that differs from the new time refuses Apply, says why, and saves nothing (item 3)', async () => {
    const real = mockSupabase.rpc.bind(mockSupabase);
    vi.spyOn(mockSupabase, 'rpc').mockImplementation(async (name, params) =>
      name === 'ensure_game_slot'
        ? { data: { id: 'gs-3', created: false }, error: null }
        : real(name, params)
    );
    await mount();
    await stage({
      home: 'team-2',
      away: 'team-4',
      where: { field: 'f-north', date: '2026-10-31', start: '13:00', end: '14:00' },
    });
    await apply();
    const error = await screen.findByText(/The database already has a slot on North Field/);
    expect(error).toHaveTextContent('it is in week 2, not week 5');
    expect(error).toHaveTextContent('it ends at 10:00, not 14:00');
    expect(error).toHaveTextContent('Nothing was saved');
    expect(SAVE.calls).toHaveLength(0);
    expect(orgGames()).toHaveLength(2);
  });

  it('control: a slot the database already had that matches is used, and a failed save then names no slot left (items 3 and 9)', async () => {
    const real = mockSupabase.rpc.bind(mockSupabase);
    // Another admin made the very slot a moment ago: the database finds it rather than making it.
    vi.spyOn(mockSupabase, 'rpc').mockImplementation(async (name, params) => {
      const result = await real(name, params);
      return name === 'ensure_game_slot' && result.data
        ? { ...result, data: { ...result.data, created: false } }
        : result;
    });
    SAVE.impl = async () => {
      throw new Error('The save was refused.');
    };
    await mount();
    await stage({
      home: 'team-2',
      away: 'team-4',
      where: { field: 'f-south', date: '2026-10-31', start: '13:00', end: '14:00' },
    });
    await apply();
    const error = await screen.findByText(/The save was refused\./);
    expect(error).not.toHaveTextContent(/made before the save/);
    expect(SAVE.calls).toHaveLength(1);
  });

  it('a save whose outcome is unknown does not say the slot holds no game: it says it is being checked (item 9)', async () => {
    SAVE.impl = async () => {
      throw Object.assign(new Error('The save did not answer in time.'), {
        code: 'PERSISTENCE_TIMEOUT',
      });
    };
    await mount();
    await stage({
      home: 'team-2',
      away: 'team-4',
      where: { field: 'f-south', date: '2026-10-17', start: '13:00', end: '14:00' },
    });
    await apply();
    const error = await screen.findByText(/The save did not answer in time\./);
    expect(error).toHaveTextContent('is being checked');
    expect(error).not.toHaveTextContent('holds no game');
  });
});

describe('review of #731: flags, the banner and the scheduler', () => {
  it('a slot reserved for another division is flagged, not refused, and recorded with the run (item 10)', async () => {
    await mount();
    const dialog = await fillDialog({
      home: 'team-1',
      away: 'team-3',
      where: { slot: 'South Field' },
    });
    expect(within(dialog).getByTestId('add-game-warnings')).toHaveTextContent(
      'Synthetic Comets vs Synthetic Meteors is in a slot reserved for U12.'
    );
    expect(addButton(dialog)).toBeEnabled();
    fireEvent.click(addButton(dialog));
    await screen.findByText(/3 game assignments staged for review/);
    expect(
      within(screen.getByTestId('game-conflict-banner')).getByTestId(
        'conflict-item-slot-other-division'
      )
    ).toBeInTheDocument();
    await apply();
    await screen.findByText(/Game schedule applied through the persistence workflow\./);
    expect(SAVE.calls[0].runMetadata.results.warnings.map((w) => w.type)).toEqual([
      'slot-other-division',
    ]);
  });

  it('two added games that clash are reported once, in the banner and in the run (item 8)', async () => {
    await mount();
    await stage({
      home: 'team-2',
      away: 'team-4',
      where: { field: 'f-north', date: '2026-10-17', start: '11:00', end: '12:00' },
    });
    await stage({
      home: 'team-2',
      away: 'team-3',
      where: { field: 'f-south', date: '2026-10-17', start: '11:30', end: '12:30' },
    });
    const banner = screen.getByTestId('game-conflict-banner');
    expect(within(banner).getAllByTestId('conflict-item-team-double-booked')).toHaveLength(1);
    await apply();
    await screen.findByText(/Game schedule applied through the persistence workflow\./);
    expect(SAVE.calls[0].runMetadata.results.warnings.map((w) => w.type)).toEqual([
      'team-double-booked',
    ]);
  });

  it('generating is off while an added game is staged, with the reason; discarding turns it back on (item 7)', async () => {
    await mount();
    const generate = await screen.findByRole('button', {
      name: 'Auto-Generate: run auto-scheduler optimization',
    });
    await waitFor(() => expect(generate).toBeEnabled());
    await stage({ home: 'team-1', away: 'team-3', where: { slot: 'North Field' } });
    expect(generate).toBeDisabled();
    expect(screen.getByTestId('generate-waits-for-added')).toHaveTextContent(
      'Generating is off while a game added by hand is staged'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Discard Review' }));
    await waitFor(() => expect(generate).toBeEnabled());
    expect(screen.queryByTestId('generate-waits-for-added')).not.toBeInTheDocument();
  });

  it('generate, add a double-booked game, Apply: the banner still shows the flag (item 5)', async () => {
    await mount();
    const generate = await screen.findByRole('button', {
      name: 'Auto-Generate: run auto-scheduler optimization',
    });
    await waitFor(() => expect(generate).toBeEnabled());
    fireEvent.click(generate);
    await screen.findByRole('button', { name: /apply schedule/i });
    // Comets play the Published G1 at 09:00-10:00 on 2026-10-03.
    await stage({
      home: 'team-1',
      away: 'team-3',
      where: { field: 'f-south', date: '2026-10-03', start: '09:30', end: '10:30' },
    });
    expect(
      within(screen.getByTestId('game-conflict-banner')).getAllByTestId(
        'conflict-item-team-double-booked'
      ).length
    ).toBeGreaterThan(0);
    await apply();
    await screen.findByText(/Game schedule applied through the persistence workflow\./);
    await waitFor(() =>
      expect(
        within(screen.getByTestId('game-conflict-banner'))
          .getAllByTestId('conflict-item-team-double-booked')
          .some((item) => /Synthetic Comets already plays/.test(item.textContent ?? ''))
      ).toBe(true)
    );
  });

  it('a slow read of the new slot cannot put the list back to the schedule before the save (item 6)', async () => {
    const realFrom = mockSupabase.from.bind(mockSupabase);
    const armed = { on: false };
    const slow = (builder, ms) => {
      const select = builder.select;
      builder.select = (...args) => {
        const query = select(...args);
        const then = query.then;
        query.then = (ok, ko) =>
          new Promise((resolve) => setTimeout(resolve, ms)).then(() => then(ok, ko));
        return query;
      };
      return builder;
    };
    vi.spyOn(mockSupabase, 'from').mockImplementation((table) => {
      const builder = realFrom(table);
      if (!armed.on) return builder;
      if (table === 'game_slots') return slow(builder, 150);
      if (table === 'game_assignments' || table === 'current_game_runs') return slow(builder, 900);
      return builder;
    });
    await mount();
    await stage({
      home: 'team-2',
      away: 'team-4',
      where: { field: 'f-north', date: '2026-10-17', start: '11:00', end: '12:00' },
    });
    armed.on = true;
    await apply();
    await screen.findByText(/Game schedule applied through the persistence workflow\./);
    // Well after a slot read would have landed, and before the saved schedule is read again: the list is the save.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(
      listRows().filter((row) => row.startsWith('Synthetic Rockets vs Synthetic Planets'))
    ).toHaveLength(1);
    armed.on = false;
  });
});

describe('review of #731, round 2: the added game on the grid, judged where it is now', () => {
  const enterOverride = async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Enter Manual Override' }));
    await screen.findByTestId('game-schedule-grid');
  };
  /** Move a card with its own "Move to" list, the keyboard path. */
  const moveWithList = async (cardId, fieldName) => {
    const card = within(screen.getByTestId(`game-card-${cardId}`));
    const select = card.getByRole('combobox');
    // The list fills once it is reached.
    fireEvent.focus(select);
    const option = within(select)
      .getAllByRole('option')
      .find((o) => (o.textContent ?? '').startsWith(`${fieldName},`));
    if (!option) throw new Error(`no empty slot on ${fieldName} in the Move to list`);
    fireEvent.change(select, { target: { value: option.getAttribute('value') } });
    fireEvent.click(card.getByRole('button', { name: 'Move' }));
    await screen.findByText(/Manual game move staged/);
  };
  const reservedFlags = () =>
    within(
      screen.queryByTestId('game-conflict-banner') ?? document.createElement('div')
    ).queryAllByTestId('conflict-item-slot-other-division');

  it('in Manual Override, a game added at a new time has a card in its pending slot, reachable by keyboard (C4)', async () => {
    await mount();
    await enterOverride();
    await stage({
      home: 'team-2',
      away: 'team-4',
      where: { field: 'f-north', date: '2026-10-17', start: '11:00', end: '12:00' },
    });
    const cell = await screen.findByTestId('drop-zone-f-north:new-slot-1');
    const card = within(cell).getByTestId('game-card-added-1');
    // The card is the added game (cards show the teams by id).
    expect(card).toHaveTextContent('team-2vsteam-4');
    // Keyboard-reachable: its "Move to" list takes focus, and offers the season's real empty slots.
    const select = within(card).getByRole('combobox');
    select.focus();
    fireEvent.focus(select);
    expect(document.activeElement).toBe(select);
    expect(
      within(select)
        .getAllByRole('option')
        .some((o) => /North Field,/.test(o.textContent ?? ''))
    ).toBe(true);
    // Shown, never offered: no other card can be moved to the pending time.
    const other = within(screen.getByTestId(`game-card-${G2}`)).getByRole('combobox');
    fireEvent.focus(other);
    // The list was read: it offers the real empty slots (so the absence below is a finding, not an empty list).
    expect(within(other).getAllByRole('option').length).toBeGreaterThan(1);
    expect(
      within(other)
        .getAllByRole('option')
        .some((o) => /new time/.test(o.textContent ?? ''))
    ).toBe(false);
  });

  it('moved into a slot reserved for another division: the flag appears, and Apply records it (C5)', async () => {
    await mount();
    await stage({ home: 'team-1', away: 'team-3', where: { slot: 'North Field' } });
    expect(reservedFlags()).toHaveLength(0);
    await enterOverride();
    await moveWithList('added-1', 'South Field');
    await waitFor(() => expect(reservedFlags()).toHaveLength(1));
    await apply();
    await screen.findByText(/Game schedule applied through the persistence workflow\./);
    expect(SAVE.calls[0].runMetadata.results.warnings.map((w) => w.type)).toEqual([
      'slot-other-division',
    ]);
  });

  it('moved out of a reserved slot: the flag is gone, and Apply records none (C5)', async () => {
    await mount();
    await stage({ home: 'team-1', away: 'team-3', where: { slot: 'South Field' } });
    expect(reservedFlags()).toHaveLength(1);
    await enterOverride();
    await moveWithList('added-1', 'North Field');
    await waitFor(() => expect(reservedFlags()).toHaveLength(0));
    await apply();
    await screen.findByText(/Game schedule applied through the persistence workflow\./);
    expect(SAVE.calls[0].runMetadata.results.warnings).toEqual([]);
  });

  it('a drop that would put two games in one slot is refused, either way round, for an added game', async () => {
    await mount();
    await stage({ home: 'team-1', away: 'team-3', where: { slot: 'North Field' } });
    await enterOverride();
    // A saved game dropped on the added game's slot.
    act(() => {
      DND.props.onDragEnd({ active: { id: G2 }, over: { id: 'f-north:gs-3' } });
    });
    expect(screen.getByText(/was not moved: that slot already has/)).toBeInTheDocument();
    // The added game dropped on a saved game's slot.
    act(() => {
      DND.props.onDragEnd({ active: { id: 'added-1' }, over: { id: 'f-south:gs-2' } });
    });
    expect(screen.getByText(/was not moved: that slot already has/)).toBeInTheDocument();
    // Both games are where they were.
    expect(
      within(screen.getByTestId('drop-zone-f-north:gs-3')).getByTestId('game-card-added-1')
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId('drop-zone-f-south:gs-2')).getByTestId(`game-card-${G2}`)
    ).toBeInTheDocument();
  });
});

describe('Codex re-review of #731, round 3', () => {
  it('a date earlier in the season start’s own week is before the season starts (C6); the start date itself is week 1', () => {
    const choice = (date) => ({
      division: 'U10',
      homeTeamId: 'team-1',
      awayTeamId: 'team-3',
      where: 'new',
      fieldId: 'f-south',
      date,
      startTime: '11:00',
      endTime: '12:00',
    });
    // The season starts on a Wednesday; the Monday of that week rounds to week 1 but is before the season.
    const ctx = { ...context({ review: [] }), seasonStart: '2026-09-30' };
    expect(planAddedGame(choice('2026-09-28'), ctx)).toEqual({
      refusal: '2026-09-28 is before the season starts (2026-09-30), so it has no week.',
    });
    // Control: the start date itself is the season's first day, week 1.
    const onStart = planAddedGame(choice('2026-09-30'), ctx);
    if (!('game' in onStart)) throw new Error(`the start date was refused: ${onStart.refusal}`);
    expect(onStart.game.weekIndex).toBe(1);
  });

  it('after Auto-Generate, a game added by hand is counted in the saved summary (C7)', async () => {
    await mount();
    const generate = await screen.findByRole('button', {
      name: 'Auto-Generate: run auto-scheduler optimization',
    });
    await waitFor(() => expect(generate).toBeEnabled());
    fireEvent.click(generate);
    const staged = await screen.findByText(/(\d+) game assignments? staged for review/);
    const generated = Number(/(\d+) game assignment/.exec(staged.textContent ?? '')?.[1]);
    expect(generated).toBeGreaterThan(0);
    await stage({
      home: 'team-2',
      away: 'team-4',
      where: { field: 'f-north', date: '2026-10-24', start: '09:00', end: '10:00' },
    });
    await apply();
    await screen.findByText(/Game schedule applied through the persistence workflow\./);
    const { assignments, runMetadata } = SAVE.calls[0];
    const summary = runMetadata.results.summary;
    expect(assignments).toHaveLength(generated + 1);
    expect(summary.totalGames).toBe(generated + 1);
    expect(summary.scheduledRate).toBeCloseTo(
      summary.totalGames / (summary.totalGames + summary.unscheduledMatchups)
    );
  });

  it('a slot another admin made after the page loaded: the saved game still has its card in Manual Override (C8)', async () => {
    const real = mockSupabase.rpc.bind(mockSupabase);
    // The database finds the slot (another admin made it a moment ago): created false, and the page never read it.
    vi.spyOn(mockSupabase, 'rpc').mockImplementation(async (name, params) => {
      const result = await real(name, params);
      return name === 'ensure_game_slot' && result.data
        ? { ...result, data: { ...result.data, created: false } }
        : result;
    });
    await mount();
    await stage({
      home: 'team-2',
      away: 'team-4',
      where: { field: 'f-south', date: '2026-10-31', start: '13:00', end: '14:00' },
    });
    await apply();
    await screen.findByText(/Game schedule applied through the persistence workflow\./);
    await waitFor(() => expect(orgGames()).toHaveLength(3));
    const made = orgSlots().find((slot) => slot.slot_date === '2026-10-31');
    const saved = orgGames().find((g) => g.home_team_id === 'team-2');
    expect(saved.game_slot_id).toBe(made.id);
    fireEvent.click(screen.getByRole('button', { name: 'Enter Manual Override' }));
    await screen.findByTestId('game-schedule-grid');
    // Every saved game has its card, the new one in its slot's cell.
    await waitFor(() =>
      expect(
        within(screen.getByTestId(`drop-zone-f-south:${made.id}`)).getByTestId(
          `game-card-${saved.id}`
        )
      ).toBeInTheDocument()
    );
    expect(screen.getByTestId(`game-card-${G1}`)).toBeInTheDocument();
    expect(screen.getByTestId(`game-card-${G2}`)).toBeInTheDocument();
  });
});

/** The page's context for the pure rule, over the league above. */
function context({ review }) {
  const names = new Map([
    ['team-1', 'Synthetic Comets'],
    ['team-3', 'Synthetic Meteors'],
    ['team-4', 'Synthetic Planets'],
    ['club-x', 'Visiting Owls'],
  ]);
  const fields = new Map([
    ['f-north', 'North Field'],
    ['f-south', 'South Field'],
  ]);
  return {
    review,
    slots: SLOTS.map((s) => ({
      ...s,
      fieldId: s.field_id,
      weekIndex: s.week_index,
      label: s.slot_date,
    })),
    teamName: (id) => names.get(id) ?? id,
    divisionName: (id) => (id === OTHER_DIVISION ? 'U12' : id === DIVISION ? 'U10' : null),
    isExternal: (id) => id === 'club-x',
    fieldName: (id) => fields.get(id) ?? id,
    timezone: TZ,
    seasonStart: '2026-09-28',
    key: 1,
  };
}
