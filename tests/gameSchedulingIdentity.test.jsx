/**
 * Regenerate and Apply, twice: a game keeps its id (plan `docs/changes/2026-11-06-games-table-source-of-truth.md`, I1 and
 * I2, task A3).
 *
 * Driven through the real page, the real `useDashboardData` and the real mock client; the save is the mock's
 * `persist_game_schedule` (`mockGameIdentity.js`, held to the pure helper and to the SQL by their own tests), fed the
 * very rows the page's client would send (`prepareGamePersistenceSnapshot`). So what is asserted afterwards is what the
 * database would hold, read back by the page.
 *
 * Four teams play a round robin of three weeks: six games saved in one run, each week's first matchup on the last of
 * three slots and the second on the middle one. A fresh run puts each on the first and the middle slot, so the three
 * games that sat on the last slot MOVE (the same week, another slot); that is the move this file watches.
 *
 * What is held:
 *   - after Apply the six saved games are still six rows with the ids they had (a save that inserted a moved game would
 *     leave nine), the three moved games sit in their new slots, and the page lists the same six matchups the review
 *     showed: the visible set is today's;
 *   - the same again after a second regeneration and Apply;
 *   - a game that had changes allowed (a Published history, not Published now) keeps its history through the move, and a
 *     Published game stays Published and in its cell;
 *   - the save is sent an id only for a saved game (never a placeholder), and sends it for every saved game it continues;
 *   - the control: when the page sends no ids (the matcher removed), the same regeneration adds a row for each moved game
 *     and the history stays behind with the old row. That is the behaviour this change ends, shown so the assertions above
 *     are known to be able to fail.
 */
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prepareGamePersistenceSnapshot } from '../packages/core/src/gamePersistenceSnapshot.js';
import { buildDivisionRoundRobins } from '../packages/core/src/gameScheduling.js';
import { getMockData, mockSupabase } from '../frontend/src/lib/mockSupabaseClient.js';
import { seedMockDb } from './helpers/seedMockDb.js';

const ORG = '00000000-0000-4000-8000-0000000000e5';
const SEASON = '00000000-0000-4000-8000-0000000000f5';
const DIVISION = '00000000-0000-4000-8000-0000000000d5';
const SAVED_RUN = '00000000-0000-4000-8000-0000000000d6';
const FIELD = 'field-id1';
const GAME = (n) => `00000000-0000-4000-8000-00000000a${String(n).padStart(3, '0')}`;

const ROSTER = vi.hoisted(() => [
  { id: 'team-1', name: 'Synthetic Comets', division: 'U10' },
  { id: 'team-2', name: 'Synthetic Rockets', division: 'U10' },
  { id: 'team-3', name: 'Synthetic Meteors', division: 'U10' },
  { id: 'team-4', name: 'Synthetic Planets', division: 'U10' },
]);
/** What the stubbed client does with a save, per test. */
const SAVE = vi.hoisted(() => ({
  impl: /** @type {any} */ (null),
  sent: /** @type {any[]} */ ([]),
}));

vi.mock('../frontend/src/lib/supabaseClient.js', async () => {
  const { mockSupabase: client } = await import('../frontend/src/lib/mockSupabaseClient.js');
  return { supabase: client, supabaseReady: Promise.resolve() };
});
vi.mock('../frontend/src/contexts/OrganizationContext.jsx', async () => {
  const { ROLE_PERMISSIONS: perms, ROLES: roles } =
    await import('../frontend/src/constants/permissions.js');
  const value = {
    currentOrganization: { id: '00000000-0000-4000-8000-0000000000e5', name: 'Synthetic FC' },
    currentSeasonSetting: {
      id: '00000000-0000-4000-8000-0000000000f5',
      timezone: 'America/New_York',
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
vi.mock('../frontend/src/utils/gamePersistenceClient.js', () => ({
  persistGameScheduleReview: (...args) => SAVE.impl(...args),
}));

const { default: GameSchedulingPage } =
  await import('../frontend/src/pages/GameSchedulingPage.jsx');

const SATURDAYS = ['2026-10-03', '2026-10-10', '2026-10-17'];
const LOCAL = [
  { start: '09:00:00', end: '10:00:00', utc: '13' },
  { start: '11:00:00', end: '12:00:00', utc: '15' },
  { start: '13:00:00', end: '14:00:00', utc: '17' },
];
const slotId = (week, index) => `gs-id-${week}-${index}`;
const SLOTS = SATURDAYS.flatMap((date, w) =>
  LOCAL.map((time, index) => ({
    id: slotId(w + 1, index),
    organization_id: ORG,
    field_id: FIELD,
    slot_date: date,
    start_time: time.start,
    end_time: time.end,
    week_index: w + 1,
    capacity: 1,
  }))
);
const WEEKS = buildDivisionRoundRobins(
  ROSTER.map(({ id, name, division }) => ({ id, name, division }))
).roundRobinByDivision.U10;

/** Six saved games: week w's first matchup (game 2w-1) on the last slot, its second (game 2w) on the middle one. */
function savedGames(extra = {}) {
  const rows = [];
  let n = 0;
  WEEKS.slice(0, 3).forEach((week, w) => {
    week.matchups.slice(0, 2).forEach((matchup, m) => {
      n += 1;
      const index = m === 0 ? 2 : 1;
      const time = LOCAL[index];
      rows.push({
        id: GAME(n),
        run_id: SAVED_RUN,
        organization_id: ORG,
        division: 'U10',
        week_index: w + 1,
        slot_id: slotId(w + 1, index),
        game_slot_id: slotId(w + 1, index),
        field_id: FIELD,
        start: `${SATURDAYS[w]}T${time.utc}:00:00+00:00`,
        end: `${SATURDAYS[w]}T${String(Number(time.utc) + 1)}:00:00+00:00`,
        home_team_id: matchup.homeTeamId,
        away_team_id: matchup.awayTeamId,
        assignment_source: 'auto',
        published: false,
        published_at: null,
        published_by: null,
        season_settings_id: SEASON,
        ...(extra[GAME(n)] ?? {}),
      });
    });
  });
  return rows;
}

function seed(extra = {}) {
  seedMockDb({
    organizations: [{ id: ORG, name: 'Synthetic FC' }],
    organization_members: [{ organization_id: ORG, profile_id: 'mock-admin-id', role: 'admin' }],
    season_settings: [{ id: SEASON, organization_id: ORG, status: 'active', name: 'Synthetic' }],
    divisions: [{ id: DIVISION, organization_id: ORG, season_settings_id: SEASON, name: 'U10' }],
    teams: ROSTER.map((team) => ({
      id: team.id,
      organization_id: ORG,
      division_id: DIVISION,
      name: team.name,
    })),
    fields: [
      { id: FIELD, name: 'Field 1', organization_id: ORG, location_id: 'loc-id1', active: true },
    ],
    locations: [{ id: 'loc-id1', organization_id: ORG, effective_to: null }],
    game_slots: SLOTS,
    scheduler_runs: [
      {
        id: SAVED_RUN,
        organization_id: ORG,
        run_type: 'game',
        status: 'completed',
        season_settings_id: SEASON,
        completed_at: '2026-01-01T12:00:00Z',
        results: {},
      },
    ],
    game_assignments: savedGames(extra),
  });
  sessionStorage.setItem('__MOCK_SESSION__', JSON.stringify({ user: { id: 'mock-admin-id' } }));
}

/**
 * The save as the database would take it: the very rows the page's client builds, handed to the mock's
 * `persist_game_schedule`. `stripIds` removes every id first: the page before this change.
 */
function installSave({ stripIds = false } = {}) {
  SAVE.sent = [];
  SAVE.impl = async ({ assignments, runMetadata }) => {
    const rows = prepareGamePersistenceSnapshot({ assignments, runMetadata }).payload
      .assignmentRows;
    const sent = stripIds ? rows.map(({ id: _omitted, ...rest }) => rest) : rows;
    SAVE.sent.push(sent);
    const { data, error } = await mockSupabase.rpc('persist_game_schedule', {
      run_data: {
        organization_id: ORG,
        season_settings_id: SEASON,
        run_type: 'game',
        status: 'completed',
        results: runMetadata?.results ?? {},
      },
      assignments: sent,
    });
    if (error) throw Object.assign(new Error(error.message), { code: error.code });
    return { runId: data };
  };
}

beforeEach(() => {
  sessionStorage.clear();
  // The mock keeps the last database it saved on `window` as well as in sessionStorage; each test starts from its own.
  delete window.__MOCK_DB__;
});
afterEach(() => {
  vi.restoreAllMocks();
});

const orgRuns = () =>
  getMockData('scheduler_runs').filter(
    (run) => run.run_type === 'game' && run.organization_id === ORG
  );
const orgGames = () => getMockData('game_assignments').filter((row) => row.organization_id === ORG);
const latestRunId = () =>
  orgRuns()
    .sort((a, b) => String(a.completed_at).localeCompare(String(b.completed_at)))
    .at(-1).id;
const visible = () => orgGames().filter((row) => row.run_id === latestRunId());
const placeOf = (row) =>
  `${row.home_team_id}>${row.away_team_id}@${row.game_slot_id}/${row.week_index}`;

function listedMatchups() {
  return screen
    .queryAllByRole('cell')
    .map((cell) => (cell.textContent ?? '').replace(/\s+/g, ' ').trim())
    .filter((text) => /^Synthetic \w+ vs Synthetic \w+$/.test(text))
    .sort();
}

async function mount() {
  render(
    <MemoryRouter>
      <GameSchedulingPage />
    </MemoryRouter>
  );
  await waitFor(() => expect(listedMatchups()).toHaveLength(6));
}

/** Press Generate, then Apply, and wait until the page has read the saved schedule again. */
async function regenerateAndApply(expectedRuns) {
  const run = await screen.findByRole('button', {
    name: 'Auto-Generate: run auto-scheduler optimization',
  });
  await waitFor(() => expect(run).toBeEnabled());
  fireEvent.click(run);
  const apply = await screen.findByRole('button', { name: /apply schedule/i });
  await waitFor(() => expect(apply).toBeEnabled());
  fireEvent.click(apply);
  await screen.findByText(/Game schedule applied through the persistence workflow\./);
  await waitFor(() => expect(orgRuns()).toHaveLength(expectedRuns));
  await waitFor(() => expect(listedMatchups()).toHaveLength(6));
}

describe('regenerate and Apply: a game keeps its id', () => {
  it('twice over, the six saved games are still six rows under their own ids, the moved ones in their new slots', async () => {
    seed();
    installSave();
    const before = new Map(orgGames().map((row) => [row.id, placeOf(row)]));
    await mount();
    const matchups = listedMatchups();

    await regenerateAndApply(2);
    const rowsAfterFirst = orgGames();
    // Six rows, not nine: a moved game was updated, not added.
    expect(rowsAfterFirst).toHaveLength(6);
    expect(rowsAfterFirst.map((row) => row.id).sort()).toEqual([1, 2, 3, 4, 5, 6].map(GAME));
    // The three games on the last slot moved (a fresh run does not use it); the others stayed. The meta-assertion: a
    // move did happen, or "the id is unchanged" would hold of a schedule that never changed.
    const moved = rowsAfterFirst.filter((row) => placeOf(row) !== before.get(row.id));
    expect(moved.map((row) => row.id).sort()).toEqual([GAME(1), GAME(3), GAME(5)]);
    expect(visible()).toHaveLength(6);
    expect(visible().every((row) => row.season_settings_id === SEASON)).toBe(true);
    // The visible set is what the review showed: the page lists the same six matchups, and what it was sent is what is
    // saved, tuple for tuple.
    expect(listedMatchups()).toEqual(matchups);
    expect(SAVE.sent[0].map((row) => placeOf({ ...row })).sort()).toEqual(
      visible()
        .map((row) => placeOf(row))
        .sort()
    );

    await regenerateAndApply(3);
    expect(orgGames()).toHaveLength(6);
    expect(
      orgGames()
        .map((row) => row.id)
        .sort()
    ).toEqual([1, 2, 3, 4, 5, 6].map(GAME));
    expect(visible()).toHaveLength(6);
    // A second regeneration of an unchanged league changes nothing the first did not.
    expect(visible().map(placeOf).sort()).toEqual(rowsAfterFirst.map(placeOf).sort());
    expect(listedMatchups()).toEqual(matchups);
  });

  it('sends an id only for a saved game, and one for every saved game it continues', async () => {
    seed();
    installSave();
    await mount();
    await regenerateAndApply(2);
    const sent = SAVE.sent[0];
    expect(sent).toHaveLength(6);
    const saved = new Set([1, 2, 3, 4, 5, 6].map(GAME));
    expect(sent.every((row) => row.id === undefined || saved.has(row.id))).toBe(true);
    // All six continue a saved game (the same pairs, the same weeks), so all six carry one, each once.
    expect(sent.map((row) => row.id).sort()).toEqual([1, 2, 3, 4, 5, 6].map(GAME));
  });

  it('a game with changes allowed keeps its history through the move, and a Published game stays Published', async () => {
    // Game 1 (week 1, last slot) was Published once and is open now: it will move. Game 2 (week 1, middle slot) is Published.
    seed({
      [GAME(1)]: {
        published: false,
        published_at: '2026-10-01T00:00:00Z',
        published_by: 'someone',
      },
      [GAME(2)]: { published: true, published_at: '2026-10-01T00:00:00Z', published_by: 'someone' },
    });
    installSave();
    await mount();
    await regenerateAndApply(2);
    const rows = orgGames();
    expect(rows).toHaveLength(6);
    const one = rows.find((row) => row.id === GAME(1));
    expect(one.published_at).toBe('2026-10-01T00:00:00Z');
    expect(one.published).toBe(false);
    expect(placeOf(one)).not.toBe(placeOf(savedGames().find((row) => row.id === GAME(1))));
    const two = rows.find((row) => row.id === GAME(2));
    expect(two.published).toBe(true);
    expect(placeOf(two)).toBe(placeOf(savedGames().find((row) => row.id === GAME(2))));
    // No sentence says the moved game became a new one, and nothing was left behind.
    expect(
      screen.queryByText(/new game|starts not Published|no longer in the schedule/)
    ).toBeNull();
  });

  it('the control: with no ids sent (the page before this change), each moved game is a new row and its history stays behind', async () => {
    seed({
      [GAME(1)]: {
        published: false,
        published_at: '2026-10-01T00:00:00Z',
        published_by: 'someone',
      },
    });
    installSave({ stripIds: true });
    await mount();
    await regenerateAndApply(2);
    const rows = orgGames();
    // Three moved games are three new rows: nine in all, and the old rows are still where they were.
    expect(rows).toHaveLength(9);
    expect(visible()).toHaveLength(6);
    const oldOne = rows.find((row) => row.id === GAME(1));
    expect(oldOne.run_id).toBe(SAVED_RUN);
    expect(visible().some((row) => row.id === GAME(1))).toBe(false);
    expect(visible().some((row) => row.published_at === '2026-10-01T00:00:00Z')).toBe(false);
  });
});
