// A completed season is read-only (Phase E3b; Codex's finding on #680): the game page turns its
// generate, apply and manual override off and says why, instead of letting the database refuse the
// write (`season_schedule_readonly_when_completed`, 22023 `season_completed`). Driven through the
// real page, its data hooks and the mock client over the same small league as
// gameSchedulingPracticeOnly.test.jsx; the control is the same page on an active season.
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { seedMockDb } from './helpers/seedMockDb.js';
import { MOCK_ORG_ID, MOCK_SEASON_ID } from '../frontend/src/lib/mockSeedIds.js';

const mocks = vi.hoisted(() => ({
  /** A PostgREST error the `divisions` read answers with, or null to read the mock. */
  divisionError: /** @type {null | { code: string, message: string }} */ (null),
  seasonStatus: 'active',
}));

vi.mock('../frontend/src/lib/supabaseClient.js', async () => {
  const { mockSupabase } = await import('../frontend/src/lib/mockSupabaseClient.js');
  /** A `from('divisions')` chain that answers with the planted error. */
  const failing = () => {
    const chain = {
      select: () => chain,
      eq: () => chain,
      then: (resolve, reject) =>
        Promise.resolve({ data: null, error: mocks.divisionError }).then(resolve, reject),
    };
    return chain;
  };
  return {
    supabase: {
      from: (table) =>
        table === 'divisions' && mocks.divisionError ? failing() : mockSupabase.from(table),
      rpc: (name, params) => mockSupabase.rpc(name, params),
      auth: mockSupabase.auth,
      functions: mockSupabase.functions,
    },
    supabaseReady: Promise.resolve(),
  };
});

vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: () => ({
    currentOrganization: { id: MOCK_ORG_ID, name: 'Mock League' },
    currentSeasonSetting: {
      id: MOCK_SEASON_ID,
      timezone: 'America/Los_Angeles',
      name: 'Spring 2026',
      status: mocks.seasonStatus,
    },
    featureFlags: {},
    permissions: ['manage_schedule', 'manage_organization'],
    loading: false,
    seasonSettingsLoading: false,
  }),
}));
vi.mock('../frontend/src/hooks/useAutoRunOnNavigate.js', () => ({
  useAutoRunOnNavigate: () => {},
}));
vi.mock('../frontend/src/hooks/useFieldClosures.js', () => ({
  useFieldClosures: () => ({ closures: [], loading: false, error: null, refresh: () => {} }),
}));
vi.mock('../frontend/src/hooks/useFeatures.js', () => ({
  useFeatures: () => ({ genderModel: 'mixed', isEnabled: () => false }),
}));
// The save's request, captured (the real client posts to the Edge Function).
const persist = vi.hoisted(() => ({ calls: /** @type {any[]} */ ([]) }));
vi.mock('../frontend/src/utils/gamePersistenceClient.js', () => ({
  persistGameScheduleReview: async (args) => {
    persist.calls.push(args);
    return { success: true };
  },
}));
vi.mock('../frontend/src/lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), log: vi.fn(), debug: vi.fn() },
}));

const { default: GameSchedulingPage } =
  await import('../frontend/src/pages/GameSchedulingPage.jsx');

const U4_COHORTS = ['U4A', 'U4B', 'U4C', 'U4D'];
const U10_TEAMS = ['Owls', 'Hawks', 'Foxes', 'Bears'];

/**
 * The demo league's shape, small: U4's four cohorts and four U10 teams in a
 * team run newer than the mock's own, the two divisions' settings, and enough
 * game slots for U10's round robin (and for U4's, so a U4 fixture would fit).
 *
 * @param {{ u4PlaysGames: boolean }} options
 */
function seed({ u4PlaysGames } = { u4PlaysGames: true }) {
  const team = (name, division, divisionId) => ({
    id: `d2-${name.toLowerCase()}`,
    name,
    division_id: divisionId,
    headCoach: `${name} Coach`,
  });
  seedMockDb({
    divisions: [
      {
        id: 'd2-u4',
        name: 'U4',
        organization_id: MOCK_ORG_ID,
        season_settings_id: MOCK_SEASON_ID,
        plays_games: u4PlaysGames,
      },
      {
        id: 'd2-u10',
        name: 'U10',
        organization_id: MOCK_ORG_ID,
        season_settings_id: MOCK_SEASON_ID,
        plays_games: true,
      },
    ],
    scheduler_runs: [
      {
        // The seed's own team run, replaced (the mock merges a seeded row by
        // id), so this is the run the page reads.
        id: 'run-1',
        organization_id: MOCK_ORG_ID,
        season_settings_id: MOCK_SEASON_ID,
        run_type: 'team',
        status: 'completed',
        created_at: new Date(Date.now() + 60_000).toISOString(),
        completed_at: new Date(Date.now() + 60_000).toISOString(),
        results: {
          teamsByDivision: {
            // As a team run stores them: U4 by its name only, U10 by its id.
            U4: U4_COHORTS.map((name) => team(name, 'U4', 'U4')),
            U10: U10_TEAMS.map((name) => team(name, 'U10', 'd2-u10')),
          },
        },
      },
    ],
    game_slots: [1, 2, 3, 4, 5, 6].flatMap((week) =>
      ['v1', 'v2'].flatMap((field) =>
        [8, 10].map((hour) => ({
          id: `d2-gs-${week}-${field}-${hour}`,
          organization_id: MOCK_ORG_ID,
          field_id: field,
          week_index: week,
          start: `2026-09-${String(week + 4).padStart(2, '0')}T${String(hour + 7).padStart(2, '0')}:00:00Z`,
          end: `2026-09-${String(week + 4).padStart(2, '0')}T${String(hour + 8).padStart(2, '0')}:00:00Z`,
          capacity: 1,
        }))
      )
    ),
  });
}

const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

const GENERATE = 'Auto-Generate: run auto-scheduler optimization';
const NOTE = 'season-readonly-note';

function renderPage() {
  return render(
    <MemoryRouter>
      <GameSchedulingPage />
    </MemoryRouter>
  );
}

beforeEach(() => {
  sessionStorage.clear();
  delete window.__MOCK_DB__;
  sessionStorage.setItem('__MOCK_SESSION__', JSON.stringify({ user: { id: 'mock-admin-id' } }));
  mocks.divisionError = null;
  mocks.seasonStatus = 'active';
  persist.calls = [];
  seed();
});

afterEach(() => {
  sessionStorage.clear();
});

describe('the game page on a completed season', () => {
  it('CONTROL: on an active season the generate button is enabled once the data lands, with no note', async () => {
    renderPage();
    const trigger = await screen.findByRole('button', { name: GENERATE });
    await vi.waitFor(() => expect(trigger).toBeEnabled());
    expect(screen.queryByTestId(NOTE)).toBeNull();
    expect(screen.getByRole('button', { name: /manual override/i })).toBeInTheDocument();
  });

  it('turns generate off, hides the manual override, and says why, with the same data', async () => {
    mocks.seasonStatus = 'completed';
    renderPage();
    expect(await screen.findByTestId(NOTE)).toHaveTextContent('completed and read-only');
    const trigger = await screen.findByRole('button', { name: GENERATE });
    await settle();
    await settle();
    expect(trigger).toBeDisabled();
    expect(screen.queryByRole('button', { name: /manual override/i })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Apply Schedule' })).toBeNull();
    expect(persist.calls).toHaveLength(0);
  });
});
