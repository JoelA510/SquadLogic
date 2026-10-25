// The game page over a practice-only division (plan
// docs/changes/2026-10-22-demo-mode.md, D2; migration 20261029010000), driven
// through the real page, its data hooks and the mock client: a team-run summary
// and the divisions' current settings from the mock, U4 with
// `plays_games = false`. Generating the schedule gives U4 no fixture and lists
// it as practice only, not as unscheduled. This fails while the flag does not
// reach the page (the control case below turns it on and sees U4 play).
//
// The expected teams are enumerated from the seed below, never from what the
// page rendered.
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { seedMockDb } from './helpers/seedMockDb.js';
import { MOCK_ORG_ID, MOCK_SEASON_ID } from '../frontend/src/lib/mockSeedIds.js';

const mocks = vi.hoisted(() => ({
  /** A PostgREST error the `divisions` read answers with, or null to read the mock. */
  divisionError: /** @type {null | { code: string, message: string }} */ (null),
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
    currentSeasonSetting: { id: MOCK_SEASON_ID, timezone: 'America/Los_Angeles' },
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
function seed({ u4PlaysGames }) {
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

async function generate() {
  render(
    <MemoryRouter>
      <GameSchedulingPage />
    </MemoryRouter>
  );
  const trigger = await screen.findByRole('button', {
    name: 'Auto-Generate: run auto-scheduler optimization',
  });
  // The page enables it once the team run, the slots and the divisions land.
  await vi.waitFor(() => expect(trigger).toBeEnabled());
  fireEvent.click(trigger);
  await screen.findByText(/game assignments? staged for review/);
  await settle();
}

/** The staged games, as the page's schedule table lists them: each row's "<home> vs <away>". */
function stagedMatchups() {
  return screen
    .getAllByRole('row')
    .map((row) => within(row).queryAllByRole('cell')[0]?.textContent ?? '')
    .filter((text) => text.includes(' vs '));
}

beforeEach(() => {
  sessionStorage.clear();
  delete window.__MOCK_DB__;
  sessionStorage.setItem('__MOCK_SESSION__', JSON.stringify({ user: { id: 'mock-admin-id' } }));
  mocks.divisionError = null;
});

afterEach(() => {
  sessionStorage.clear();
});

describe('GameSchedulingPage :: a practice-only division (D2)', () => {
  it('gives U4 no fixture and lists it as practice only, while U10 plays its round robin', async () => {
    seed({ u4PlaysGames: false });
    await generate();
    const matchups = await vi.waitFor(() => {
      const found = stagedMatchups();
      expect(found.length).toBeGreaterThan(0);
      return found;
    });
    // U10's four teams: a full round robin, six games, every team in three.
    expect(matchups).toHaveLength(6);
    for (const name of U10_TEAMS) {
      expect(matchups.filter((m) => m.includes(name))).toHaveLength(3);
    }
    for (const name of U4_COHORTS) {
      expect(matchups.some((m) => m.includes(name))).toBe(false);
    }
    const panel = screen.getByRole('region', { name: 'Practice only' });
    expect(within(panel).getByText('U4')).toBeInTheDocument();
    expect(panel).toHaveTextContent('4 teams, no games');
    // Not unscheduled: the review counts no game it could not place.
    expect(screen.getByText('6 game assignments staged for review')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Practice only' })).not.toHaveTextContent('U10');
  });

  it('CONTROL: with U4 playing, the same page schedules U4 its fixtures and lists nothing as practice only', async () => {
    seed({ u4PlaysGames: true });
    await generate();
    const matchups = await vi.waitFor(() => {
      const found = stagedMatchups();
      expect(found.length).toBeGreaterThan(6);
      return found;
    });
    expect(matchups.some((m) => U4_COHORTS.some((name) => m.includes(name)))).toBe(true);
    expect(screen.queryByRole('region', { name: 'Practice only' })).toBeNull();
  });

  it('before the migration (no plays_games column, 42703) every division plays, as it did', async () => {
    seed({ u4PlaysGames: false });
    mocks.divisionError = { code: '42703', message: 'column divisions.plays_games does not exist' };
    await generate();
    expect(screen.queryByRole('region', { name: 'Practice only' })).toBeNull();
    expect(screen.getByText(/game assignments? staged for review/)).toBeInTheDocument();
  });

  it('a failed division read is an error that stops generation, never "every division plays"', async () => {
    seed({ u4PlaysGames: false });
    mocks.divisionError = { code: '500', message: 'divisions are unreadable' };
    render(
      <MemoryRouter>
        <GameSchedulingPage />
      </MemoryRouter>
    );
    expect(await screen.findByText(/divisions are unreadable/)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Auto-Generate: run auto-scheduler optimization' })
    ).toBeDisabled();
  });
});
