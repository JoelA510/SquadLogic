/**
 * The game page sends the scheduler's unscheduled games with a run's save (Phase D, E), so
 * `persist_game_schedule` can record them as the season's TIME TBD games; and a save that is not a
 * run (a rollback) sends none, which leaves the recorded list alone.
 *
 * Driven through the real page and the real mock client, with the save stood in for. Three teams
 * play a round robin of three weeks and the only slot is in week 1, so weeks 2 and 3 cannot be
 * placed: the scheduler's own list, not a forged one.
 */
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { seedMockDb } from './helpers/seedMockDb.js';

const ORG = '00000000-0000-4000-8000-0000000000e1';
const SEASON = 'season-gtimeout';

const ROSTER = vi.hoisted(() => [
  { id: 'team-1', name: 'Synthetic Comets', division: 'U10' },
  { id: 'team-2', name: 'Synthetic Rockets', division: 'U10' },
  { id: 'team-3', name: 'Synthetic Meteors', division: 'U10' },
]);
/** What the stubbed save does, per test. */
const SAVE = vi.hoisted(() => ({ impl: /** @type {any} */ (null) }));
/** The signed-in member's role, per test: an admin unless a test says otherwise. */
const ROLE = vi.hoisted(() => ({ name: 'admin' }));

vi.mock('../frontend/src/lib/supabaseClient.js', async () => {
  const { mockSupabase } = await import('../frontend/src/lib/mockSupabaseClient.js');
  return { supabase: mockSupabase, supabaseReady: Promise.resolve() };
});
vi.mock('../frontend/src/contexts/OrganizationContext.jsx', async () => {
  const { ROLE_PERMISSIONS: perms, ROLES: roles } =
    await import('../frontend/src/constants/permissions.js');
  const values = Object.fromEntries(
    ['admin'].map((name) => [
      name,
      {
        currentOrganization: { id: '00000000-0000-4000-8000-0000000000e1', name: 'Synthetic FC' },
        currentSeasonSetting: { id: 'season-gtimeout', timezone: 'America/New_York' },
        featureFlags: {},
        permissions: perms[roles.ADMIN],
        loading: false,
        seasonSettingsLoading: false,
      },
    ])
  );
  return { useOrganization: () => values[ROLE.name] };
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

beforeEach(() => {
  sessionStorage.clear();
  ROLE.name = 'admin';
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function generate() {
  seed();
  render(
    <MemoryRouter>
      <GameSchedulingPage />
    </MemoryRouter>
  );
  const run = await screen.findByRole('button', {
    name: 'Auto-Generate: run auto-scheduler optimization',
  });
  await waitFor(() => expect(run).toBeEnabled());
  fireEvent.click(run);
  const apply = await screen.findByRole('button', { name: /apply schedule/i });
  await waitFor(() => expect(apply).toBeEnabled());
  return apply;
}

describe('the game page records what the scheduler could not place', () => {
  it("sends the run's unscheduled games, as the scheduler listed them, with the save", async () => {
    const saves = [];
    SAVE.impl = async (args) => {
      saves.push(args);
      return { runId: 'run-1' };
    };
    fireEvent.click(await generate());
    await waitFor(() => expect(saves).toHaveLength(1));
    const { unscheduled, assignments } = saves[0].runMetadata.results;
    expect(assignments).toHaveLength(1);
    expect(unscheduled).toHaveLength(2);
    expect(unscheduled.map((entry) => entry.weekIndex).sort()).toEqual([2, 3]);
    for (const entry of unscheduled) {
      expect(entry.reason).toBe('no-slot-available');
      expect(entry.division).toBe('U10');
      expect(ROSTER.map((team) => team.id)).toContain(entry.matchup.homeTeamId);
      expect(ROSTER.map((team) => team.id)).toContain(entry.matchup.awayTeamId);
      expect(entry.matchup.homeTeamId).not.toBe(entry.matchup.awayTeamId);
    }
  });

  it('a rollback sends no list at all, so it leaves the recorded one as it is', async () => {
    const saves = [];
    SAVE.impl = async (args) => {
      saves.push(args);
      return { runId: `run-${saves.length}` };
    };
    fireEvent.click(await generate());
    await waitFor(() => expect(saves).toHaveLength(1));
    fireEvent.click(await screen.findByRole('button', { name: /rollback last apply/i }));
    await waitFor(() => expect(saves).toHaveLength(2));
    expect(saves[1].runMetadata.parameters.generationMode).toBe('rollback');
    // The key is absent from what is sent, not an empty list (an empty list would clear the record).
    expect('unscheduled' in JSON.parse(JSON.stringify(saves[1].runMetadata.results))).toBe(false);
  });
});
