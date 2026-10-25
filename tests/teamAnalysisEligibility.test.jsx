/**
 * Eligibility reaches the generator from the Teams page (Phase B2,
 * docs/changes/2026-10-22-phase-b-teaming.md).
 *
 * The page is real, and so are the core pipeline (`prepareTeamingInput`, which annotates
 * play-up / play-down eligibility with `remapBlocked: false`) and the generator; its data
 * hooks, Supabase and heavy children are stand-ins, as in `teamAnalysisBuddies.test.jsx`. The
 * import rows carry the canonical keys `import-validation` stages (`date_of_birth`,
 * `external_registration_id`, `age_group`). The natural age comes from the birthdate the import
 * row holds; a stored natural age on the durable player is R5's
 * (docs/changes/2026-10-22-admin-focus.md).
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { createChainMock } from './helpers/index.js';
import { FeatureFlagSchema } from '../frontend/src/constants/featureFlags.js';

const IDS = vi.hoisted(() => ({
  organization: '5d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c11',
  season: '5d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c12',
  division: '5d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c13',
  team: '5d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c14',
}));

const state = vi.hoisted(() => ({
  /** @type {any[]} */
  rows: [],
  /** @type {any[]} */
  durablePlayers: [],
  /** @type {any} */
  persistenceSnapshot: null,
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
    currentSeasonSetting: { id: IDS.season, season_year: 2026, age_cutoff_mode: 'birth_year' },
    permissions: ['manage_organization'],
    featureFlags: FeatureFlagSchema.parse({}),
  }),
}));
vi.mock('../frontend/src/contexts/ImportContext.jsx', () => ({
  useImport: () => ({ importedData: { data: state.rows } }),
}));
vi.mock('../frontend/src/contexts/AuthContext.jsx', () => ({
  useAuth: () => ({ session: null, user: { id: 'admin-user' } }),
}));
vi.mock('../frontend/src/hooks/useTeamPersistence.js', () => ({
  useTeamPersistence: () => ({
    persistenceSnapshot: state.persistenceSnapshot,
    loading: false,
    refresh: () => {},
  }),
}));
vi.mock('../frontend/src/hooks/useAutoRunOnNavigate.js', () => ({
  useAutoRunOnNavigate: () => {},
}));
vi.mock('../frontend/src/lib/supabaseClient.js', () => ({
  supabase: {
    from: (table) =>
      createChainMock({ data: table === 'players' ? state.durablePlayers : [], error: null }),
    rpc: async (name, params) =>
      name === 'admin_upsert_division_settings'
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
        : { data: null, error: null },
  },
}));

const stub = (name) => ({ default: () => <div data-testid={`stub-${name}`} /> });
vi.mock('../frontend/src/components/TeamPersistencePanel.jsx', () => stub('persistence'));
vi.mock('../frontend/src/components/TeamOverviewPanel.jsx', () => stub('team-overview'));
vi.mock('../frontend/src/components/teaming/ProgramOverview.jsx', () => stub('program-overview'));
vi.mock('../frontend/src/components/teaming/TeamingConfiguration.jsx', () =>
  stub('teaming-config')
);
vi.mock('../frontend/src/components/teaming/RosterManager.jsx', () => stub('roster-manager'));
vi.mock('../frontend/src/components/teaming/DataValidationPanel.jsx', () =>
  stub('data-validation')
);

const { default: TeamAnalysisPage } = await import('../frontend/src/pages/TeamAnalysisPage.jsx');

const REVIEW_KEY = `squadlogic:team-review:${IDS.organization}:${IDS.season}`;

/** A U10 import row (age group 9, the program "U10": natural age 10 in season 2026). */
const row = (n, dob, extra = {}) => ({
  external_registration_id: `REG-${n}`,
  first_name: `Kid${n}`,
  last_name: `Placeholder${n}`,
  age_group: '9',
  ...(dob ? { date_of_birth: dob } : {}),
  ...extra,
});

const IN_BAND = '2016-05-01';
const PLAY_DOWN = '2013-05-01'; // natural age 13 in U10: never permitted

function seedImport() {
  state.rows = [
    row(1, PLAY_DOWN), // blocked
    row(2), // no birthdate: unknown, placed and flagged
    ...Array.from({ length: 10 }, (_, i) => row(10 + i, IN_BAND)),
  ];
  // The players the import promoted, as `finalize_import_job` stores them.
  state.durablePlayers = state.rows.map((r, i) => ({
    id: `5d1c2b3a-4e5f-4a6b-8c7d-${String(910000000000 + i)}`,
    external_registration_id: r.external_registration_id,
    division_id: IDS.division,
    first_name: r.first_name,
    last_name: r.last_name,
    preferred_name: null,
    buddy_request: null,
    mutual_buddy_code: null,
  }));
}

/** Every imported player's durable id, from the import (never from the run's output). */
const durableIdOf = (n) =>
  state.durablePlayers[state.rows.findIndex((r) => r.external_registration_id === `REG-${n}`)].id;
const allDurableIds = () => state.durablePlayers.map((player) => player.id);

async function generate() {
  render(
    <MemoryRouter>
      <TeamAnalysisPage />
    </MemoryRouter>
  );
  const button = await screen.findByRole('button', { name: /Generate Teams/ });
  await waitFor(() => expect(button).toBeEnabled());
  await act(async () => {
    fireEvent.click(button);
  });
  await screen.findByText('Team Review Pending');
}

function stagedResults() {
  return JSON.parse(sessionStorage.getItem(REVIEW_KEY) || 'null')?.snapshot?.runMetadata?.results;
}

const overflowIds = (results) =>
  (results.overflowByDivision.U10 ?? []).flatMap((entry) => entry.players.map((p) => p.id));

describe('TeamAnalysisPage :: eligibility reaches the generator', () => {
  beforeEach(() => {
    sessionStorage.clear();
    state.persistenceSnapshot = null;
    seedImport();
  });
  afterEach(() => {
    sessionStorage.clear();
  });

  it('does not seat a blocked player: they are in overflow with the reason; unknown is seated', async () => {
    await generate();

    const results = stagedResults();
    const seated = results.team_players.map((tp) => tp.player_id);
    expect(seated).not.toContain(durableIdOf(1));
    expect(seated).toContain(durableIdOf(2));
    const entry = results.overflowByDivision.U10.find((e) => e.players[0].id === durableIdOf(1));
    expect(entry).toMatchObject({
      reason: 'eligibility-blocked',
      metadata: {
        placement: 'play_down_blocked',
        reviewReason: 'play-down is not permitted',
        naturalAge: 13,
        coachId: null,
      },
    });
    // The unknown player is on a roster, still flagged as such for B3.
    const unknown = results.teamsByDivision.U10.flatMap((team) => team.players).find(
      (player) => player.id === durableIdOf(2)
    );
    expect(unknown.placement).toBe('unknown');
    // Conservation, enumerated from the import: seated or not placed, once.
    expect([...seated, ...overflowIds(results)].sort()).toEqual(allDurableIds().sort());
  });

  it('stages no review when every player is blocked (no empty teams to sync)', async () => {
    state.rows = state.rows.map((r) => ({ ...r, date_of_birth: PLAY_DOWN }));
    render(
      <MemoryRouter>
        <TeamAnalysisPage />
      </MemoryRouter>
    );
    const button = await screen.findByRole('button', { name: /Generate Teams/ });
    await waitFor(() => expect(button).toBeEnabled());
    await act(async () => {
      fireEvent.click(button);
    });
    // The run stops at the page's own guard (no teams); B3 words the reason.
    await waitFor(() => expect(button).toBeEnabled());
    expect(screen.queryByText('Team Review Pending')).not.toBeInTheDocument();
    expect(sessionStorage.getItem(REVIEW_KEY)).toBeNull();
  });

  it('on a rerun keeps a rostered blocked player on their saved team and lists the hold', async () => {
    // A saved run of ten on one team, the blocked player among them; 18 and 19 are late.
    const rostered = [1, 2, 10, 11, 12, 13, 14, 15, 16, 17];
    state.persistenceSnapshot = {
      payload: {
        teamRows: [{ id: IDS.team, division: 'U10', name: 'Saved Team' }],
        teamPlayerRows: rostered.map((n) => ({
          team_id: IDS.team,
          player_id: durableIdOf(n),
          role: 'player',
          source: 'auto',
        })),
      },
    };
    await generate();

    const results = stagedResults();
    const onSaved = results.team_players
      .filter((tp) => tp.team_id === IDS.team)
      .map((tp) => tp.player_id);
    expect(onSaved).toContain(durableIdOf(1));
    expect(results.changeDiagnosticsByDivision.U10.eligibilityHolds).toEqual([
      {
        playerId: durableIdOf(1),
        teamId: IDS.team,
        placement: 'play_down_blocked',
        reviewReason: 'play-down is not permitted',
      },
    ]);
    expect(results.overflowByDivision.U10.map((e) => e.reason)).not.toContain(
      'eligibility-blocked'
    );
    // Conservation, enumerated from the import: the two late players are seated or not placed.
    const seated = results.team_players.map((tp) => tp.player_id);
    expect([...seated, ...overflowIds(results)].sort()).toEqual(allDurableIds().sort());
  });
});
