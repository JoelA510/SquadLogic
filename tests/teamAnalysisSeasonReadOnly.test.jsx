/**
 * A completed season is read-only (Phase E3b; Codex's finding on #680): the Teams page turns
 * Generate Teams off and says why, instead of letting the database refuse the write
 * (`season_schedule_readonly_when_completed`, 22023 `season_completed`). The page is real, as in
 * teamAnalysisPlayUp.test.jsx; its data hooks, Supabase and heavy children are stand-ins. The
 * control is the same page and the same players on an active season.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { createChainMock } from './helpers/index.js';
import { FeatureFlagSchema } from '../frontend/src/constants/featureFlags.js';

const IDS = vi.hoisted(() => ({
  organization: '5d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c11',
  season: '5d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c12',
  division: '5d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c13',
  coach: '5d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c91',
}));

const state = vi.hoisted(() => ({
  /** @type {any[]} */
  rows: [],
  /** @type {any[]} */
  durablePlayers: [],
  /** @type {any[]} */
  coachLinks: [],
  /** @type {any[]} */
  coaches: [],
  /** @type {any} */
  storedFlags: {},
  /** @type {any[]} the `admin_bulk_update_players` calls */
  bulkUpdates: [],
  /** @type {any} the error that write returns */
  bulkError: null,
  /** @type {any[]} the season's division rows, every column */
  divisionRows: [],
  /** @type {string[]} the `select` text of each read of `divisions` */
  divisionSelects: [],
  seasonStatus: 'active',
}));

vi.mock('../frontend/src/hooks/useDashboardData.js', () => ({
  useDashboardData: () => ({
    loading: { team: false, practice: false, game: false },
    error: null,
    errors: { team: null, practice: null, game: null },
    team: { summary: null, generatedAt: null, status: 'idle', progress: 0, refetch: () => {} },
    practice: {},
    game: {},
  }),
}));
vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: () => ({
    currentOrganization: { id: IDS.organization, name: 'Test FC' },
    currentSeasonSetting: {
      id: IDS.season,
      season_year: 2026,
      age_cutoff_mode: 'birth_year',
      name: 'Spring 2026',
      status: state.seasonStatus,
    },
    permissions: ['manage_organization'],
    featureFlags: FeatureFlagSchema.parse(state.storedFlags),
  }),
}));
vi.mock('../frontend/src/contexts/ImportContext.jsx', () => ({
  useImport: () => ({ importedData: { data: state.rows } }),
}));
vi.mock('../frontend/src/contexts/AuthContext.jsx', () => ({
  useAuth: () => ({ session: null, user: { id: 'admin-user' } }),
}));
vi.mock('../frontend/src/hooks/useTeamPersistence.js', () => ({
  useTeamPersistence: () => ({ persistenceSnapshot: null, loading: false, refresh: () => {} }),
}));
vi.mock('../frontend/src/hooks/useAutoRunOnNavigate.js', () => ({
  useAutoRunOnNavigate: () => {},
}));
vi.mock('../frontend/src/lib/supabaseClient.js', () => ({
  supabase: {
    from: (table) => {
      if (table === 'divisions') {
        // Only the columns asked for come back, as from the database.
        const chain = { columns: [] };
        chain.select = (columns) => {
          state.divisionSelects.push(columns);
          chain.columns = columns.split(',').map((column) => column.trim());
          return chain;
        };
        chain.eq = () => chain;
        chain.order = () => chain;
        chain.then = (...args) =>
          Promise.resolve({
            data: state.divisionRows.map((divisionRow) =>
              Object.fromEntries(
                Object.entries(divisionRow).filter(([column]) => chain.columns.includes(column))
              )
            ),
            error: null,
          }).then(...args);
        return chain;
      }
      if (table === 'coach_team_requests') {
        return createChainMock({ data: state.coachLinks, error: null });
      }
      const rows =
        table === 'players' ? state.durablePlayers : table === 'coaches' ? state.coaches : [];
      return createChainMock({ data: rows, error: null });
    },
    rpc: async (name, params) => {
      if (name === 'admin_bulk_update_players') {
        state.bulkUpdates.push(params);
        return state.bulkError
          ? { data: null, error: state.bulkError }
          : { data: params.p_player_ids.length, error: null };
      }
      return name === 'admin_upsert_division_settings'
        ? {
            data: {
              id: IDS.division,
              organization_id: IDS.organization,
              season_settings_id: IDS.season,
              name: params.p_name,
              max_roster_size: params.p_max_roster_size,
              min_roster_size: params.p_min_roster_size,
              target_team_size: params.p_target_team_size,
              team_count_override: params.p_team_count_override,
              min_teams: params.p_min_teams,
              max_teams: params.p_max_teams,
            },
            error: null,
          }
        : { data: null, error: null };
    },
  },
}));

const stub = (name) => ({ default: () => <div data-testid={`stub-${name}`} /> });
// The persistence panel, reduced to the save button: it calls back as the real panel does.
vi.mock('../frontend/src/components/TeamPersistencePanel.jsx', () => ({
  default: ({ onPersistSuccess }) => (
    <button
      type="button"
      onClick={() => onPersistSuccess?.({ updatedTeams: 2, updatedPlayers: 20 })}
    >
      Save the teams
    </button>
  ),
}));
vi.mock('../frontend/src/components/TeamOverviewPanel.jsx', () => stub('team-overview'));
vi.mock('../frontend/src/components/teaming/ProgramOverview.jsx', () => stub('program-overview'));
vi.mock('../frontend/src/components/teaming/TeamingConfiguration.jsx', () =>
  stub('teaming-config')
);
vi.mock('../frontend/src/components/teaming/RosterManager.jsx', () => stub('roster-manager'));

const { default: TeamAnalysisPage } = await import('../frontend/src/pages/TeamAnalysisPage.jsx');

const NOTE = 'season-readonly-note';

const row = (n, dob) => ({
  external_registration_id: `REG-${n}`,
  first_name: `Kid${n}`,
  last_name: `Placeholder${n}`,
  division: 'U10',
  date_of_birth: dob,
});

function reset() {
  cleanup();
  sessionStorage.clear();
  state.rows = Array.from({ length: 8 }, (_, i) => row(i + 1, '2016-05-01'));
  state.durablePlayers = state.rows.map((r, i) => ({
    id: `5d1c2b3a-4e5f-4a6b-8c7d-${String(920000000000 + i)}`,
    external_registration_id: r.external_registration_id,
    division_id: IDS.division,
    first_name: r.first_name,
    last_name: r.last_name,
    preferred_name: null,
    buddy_request: null,
    mutual_buddy_code: null,
  }));
  state.coachLinks = [];
  state.coaches = [];
  state.storedFlags = {};
  state.bulkUpdates = [];
  state.bulkError = null;
  state.divisionRows = [];
  state.divisionSelects = [];
  state.seasonStatus = 'active';
}

const renderPage = () =>
  render(
    <MemoryRouter>
      <TeamAnalysisPage />
    </MemoryRouter>
  );

describe('the Teams page on a completed season', () => {
  beforeEach(reset);
  afterEach(reset);

  it('CONTROL: on an active season Generate Teams is enabled and there is no note', async () => {
    renderPage();
    const button = await screen.findByRole('button', { name: /Generate Teams/ });
    await waitFor(() => expect(button).toBeEnabled());
    expect(screen.queryByTestId(NOTE)).toBeNull();
  });

  it('turns Generate Teams off and says why', async () => {
    state.seasonStatus = 'completed';
    renderPage();
    expect(await screen.findByTestId(NOTE)).toHaveTextContent('completed and read-only');
    const button = await screen.findByRole('button', { name: /Generate Teams/ });
    // The page has its division rows by now (the control above is enabled by then).
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(button).toBeDisabled();
    expect(state.bulkUpdates).toHaveLength(0);
  });
});
