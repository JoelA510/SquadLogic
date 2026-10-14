/**
 * After a game save whose outcome is unknown (`PERSISTENCE_TIMEOUT`), the game
 * page reads the saved schedule again (follow-up to M2.5, found in PR 2-C's
 * review: the page kept the schedule from before the save, so a save that
 * landed after the client gave up left stale UI).
 *
 * Driven through the real page, the real `useDashboardData` and the real
 * mock client: the season's latest game run is read from `scheduler_runs`, and
 * its rows follow its run id. The save is the client stood in for with the
 * error the real client throws at the deadline (its own tests,
 * `gamePersistenceClient.test.js`, prove that shape); a save that LANDED is
 * stood in for by writing its run and rows to the mock database while the page
 * is waiting. The re-read is then shown by the grid itself: the landed row's
 * opponent appears only if the page read the schedule again.
 */
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { seedMockDb } from './helpers/seedMockDb.js';

const ORG = '00000000-0000-4000-8000-0000000000e1';
const SEASON = 'season-gtimeout';
const LANDED_RUN = '00000000-0000-4000-8000-0000000000d2';

const ROSTER = vi.hoisted(() => [
  { id: 'team-1', name: 'Synthetic Comets', division: 'U10' },
  { id: 'team-2', name: 'Synthetic Rockets', division: 'U10' },
]);
/** What the stubbed save does, per test. */
const SAVE = vi.hoisted(() => ({ impl: /** @type {any} */ (null) }));

vi.mock('../frontend/src/lib/supabaseClient.js', async () => {
  const { mockSupabase } = await import('../frontend/src/lib/mockSupabaseClient.js');
  return { supabase: mockSupabase, supabaseReady: Promise.resolve() };
});
vi.mock('../frontend/src/contexts/OrganizationContext.jsx', async () => {
  const { ROLE_PERMISSIONS: perms, ROLES: roles } =
    await import('../frontend/src/constants/permissions.js');
  const value = {
    currentOrganization: { id: '00000000-0000-4000-8000-0000000000e1', name: 'Synthetic FC' },
    currentSeasonSetting: { id: 'season-gtimeout', timezone: 'America/New_York' },
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

const { mockSupabase } = await import('../frontend/src/lib/mockSupabaseClient.js');
const { default: GameSchedulingPage } =
  await import('../frontend/src/pages/GameSchedulingPage.jsx');
const { PERSISTENCE_TIMEOUT, PERSISTENCE_UNREADABLE_RESPONSE } =
  await import('../frontend/src/lib/persistenceRequest.js');

const SLOT = {
  id: 'gs-gt1',
  organization_id: ORG,
  field_id: 'field-gt1',
  slot_date: '2026-10-03',
  start_time: '09:00:00',
  end_time: '10:00:00',
  week_index: 1,
  capacity: 1,
};

function seed() {
  seedMockDb({
    fields: [{ id: 'field-gt1', name: 'Field 1', organization_id: ORG, location_id: 'loc-gt1' }],
    locations: [{ id: 'loc-gt1', organization_id: ORG }],
    game_slots: [SLOT],
    scheduler_runs: [],
    game_assignments: [],
  });
}

/** What a save that landed leaves behind: a new completed run and its row. */
function landTheSave() {
  seedMockDb({
    scheduler_runs: [
      {
        id: LANDED_RUN,
        organization_id: ORG,
        run_type: 'game',
        status: 'completed',
        season_settings_id: SEASON,
        completed_at: '2026-10-14T12:00:00Z',
        results: {},
      },
    ],
    game_assignments: [
      {
        id: 'ga-landed',
        run_id: LANDED_RUN,
        organization_id: ORG,
        division: 'U10',
        week_index: 1,
        slot_id: SLOT.id,
        game_slot_id: SLOT.id,
        field_id: 'field-gt1',
        start: '2026-10-03T13:00:00.000Z',
        end: '2026-10-03T14:00:00.000Z',
        home_team_id: 'team-1',
        away_team_id: 'team-2',
        assignment_source: 'auto',
      },
    ],
  });
}

/** Reads of `scheduler_runs` for the game run, counted at the client. */
let gameRunReads = 0;
/** Reads of `game_assignments`: the landed run's rows, read once its id arrives. */
let gameRowReads = 0;

beforeEach(() => {
  sessionStorage.clear();
  gameRunReads = 0;
  gameRowReads = 0;
  const from = mockSupabase.from.bind(mockSupabase);
  vi.spyOn(mockSupabase, 'from').mockImplementation((table) => {
    if (table === 'scheduler_runs') gameRunReads += 1;
    if (table === 'game_assignments') gameRowReads += 1;
    return from(table);
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function generateAndApply(save) {
  SAVE.impl = save;
  seed();
  render(
    <MemoryRouter>
      <GameSchedulingPage />
    </MemoryRouter>
  );
  const run = await screen.findByRole('button', { name: 'Run auto-scheduler optimization' });
  await waitFor(() => expect(run).toBeEnabled());
  fireEvent.click(run);
  const apply = await screen.findByRole('button', { name: /apply schedule/i });
  await waitFor(() => expect(apply).toBeEnabled());
  const readsBefore = gameRunReads;
  fireEvent.click(apply);
  return readsBefore;
}

const UNKNOWN_OUTCOMES = {
  // The two errors whose message says the outcome is not known (`persistenceRequest.js`).
  timeout: () =>
    Object.assign(
      new Error(
        'The game schedule save did not answer within 160 seconds, so it is not known whether the changes were saved. Check the saved schedule before applying again.'
      ),
      { code: PERSISTENCE_TIMEOUT, status: null }
    ),
  'unreadable 2xx': () =>
    Object.assign(
      new Error(
        'The game schedule save returned a response that could not be read (HTTP 200), so it is not known whether the changes were saved. Check the saved schedule before applying again.'
      ),
      { code: PERSISTENCE_UNREADABLE_RESPONSE, status: 200 }
    ),
};

describe('the game page after a save whose outcome is unknown', () => {
  for (const [outcome, unknown] of Object.entries(UNKNOWN_OUTCOMES)) {
    it(`reads the saved schedule again, and shows the save that landed (${outcome})`, async () => {
      const readsBefore = await generateAndApply(async () => {
        landTheSave();
        throw unknown();
      });

      expect(
        await screen.findByText(/it is not known whether the changes were saved/)
      ).toBeVisible();
      await waitFor(() => expect(gameRunReads).toBeGreaterThan(readsBefore));
      // The re-read has landed: the landed run's id arrived and its rows were
      // read (no run existed before, so none were). The outcome stays said, so
      // the page never reads as "nothing happened" and invites a second Apply.
      await waitFor(() => expect(gameRowReads).toBeGreaterThan(0));
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(screen.getByText(/it is not known whether the changes were saved/)).toBeVisible();
      // The landed run's row reaches the page: it is the schedule now saved, so
      // Discard Review shows it (the staged review is left as it was).
      fireEvent.click(screen.getByRole('button', { name: /discard review/i }));
      await waitFor(() =>
        expect(screen.getAllByText(/Synthetic Rockets/).length).toBeGreaterThan(0)
      );
      expect(screen.queryByText(/no games scheduled/i)).toBeNull();
    });
  }

  it('does not re-read after a refusal, whose outcome is known', async () => {
    const readsBefore = await generateAndApply(async () => {
      throw Object.assign(new Error('Access denied'), { code: null, status: 403 });
    });
    expect(await screen.findByText('Access denied')).toBeVisible();
    // Give a re-read the chance to happen before saying it did not.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(gameRunReads).toBe(readsBefore);
  });
});
