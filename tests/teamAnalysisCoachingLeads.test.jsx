/**
 * Coaching leads from the Teams page (Phase B6, docs/changes/2026-10-22-phase-b-teaming.md).
 *
 * A player whose parent volunteers to coach is a coaching lead, not a coach: the page emits
 * `isCoachingLead` and no synthetic `coachId`, so a lead anchors no team, and it passes the
 * league's effective flags to `generateTeams`. The page, `useFeatures` (the stored flags through
 * the real schema), the pipeline and the generator are real; the harness is
 * `teamAnalysisBuddies.test.jsx`'s. Import rows carry the canonical keys `import-validation`
 * stages (`willing_to_coach`, `years_played`); the durable players carry what
 * `finalize_import_job` stored.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { createChainMock } from './helpers/index.js';
import { FeatureFlagSchema } from '../frontend/src/constants/featureFlags.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Papa from 'papaparse';
import { canonicalImportKey } from '../frontend/src/utils/importAllowlist.js';
import { isCoachingLeadAnswer } from '../packages/core/src/coachingLeads.js';

const IDS = vi.hoisted(() => ({
  organization: '5d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c01',
  season: '5d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c02',
  division: '5d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c03',
}));

const state = vi.hoisted(() => ({
  /** @type {Record<string, unknown>} */
  storedFlags: {},
  /** @type {any[]} */
  rows: [],
  /** @type {any[]} */
  durablePlayers: [],
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
    // What OrganizationContext hands every reader: the stored JSONB through the schema.
    featureFlags: FeatureFlagSchema.parse(state.storedFlags),
  }),
}));
// The real generator, watched: the page's call is read back, and the real result returned.
const calls = vi.hoisted(() => ({ /** @type {any[]} */ generateTeams: [] }));
vi.mock('@squadlogic/core/teamGeneration.js', async (importOriginal) => {
  const actual = /** @type {any} */ (await importOriginal());
  return {
    ...actual,
    generateTeams: (params) => {
      calls.generateTeams.push(params);
      return actual.generateTeams(params);
    },
  };
});
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

/** A U10 import row (age group 9) as `import-validation` returns it. */
const row = (n, extra = {}) => ({
  external_registration_id: `REG-${n}`,
  first_name: `Kid${n}`,
  last_name: `Test${n}`,
  age_group: '9',
  years_played: String(n % 6),
  ...extra,
});

/** Rows `1..count`, the ones listed in `leads` answering "Yes" to the coaching question. */
function seedImport(count, leads, stored = (r) => r.willing_to_coach === 'Yes') {
  state.rows = Array.from({ length: count }, (_, i) =>
    row(i + 1, { willing_to_coach: leads.includes(i + 1) ? 'Yes' : 'No' })
  );
  state.durablePlayers = state.rows.map((r, i) => ({
    id: `5d1c2b3a-4e5f-4a6b-8c7d-${String(900000000000 + i)}`,
    external_registration_id: r.external_registration_id,
    division_id: IDS.division,
    first_name: r.first_name,
    last_name: r.last_name,
    preferred_name: null,
    buddy_request: null,
    mutual_buddy_code: null,
    willing_to_coach: stored(r),
    years_played: Number(r.years_played),
    rating: null,
  }));
}

async function generate() {
  calls.generateTeams.length = 0;
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

function stagedTeams() {
  const results = JSON.parse(sessionStorage.getItem(REVIEW_KEY) || 'null')?.snapshot?.runMetadata
    ?.results;
  return results?.teamsByDivision?.U10 ?? [];
}
const leadsPerTeam = (teams) =>
  teams.map((team) => team.players.filter((p) => p.isCoachingLead === true).length).sort();
const durableId = (n) => state.durablePlayers[n - 1].id;

describe('TeamAnalysisPage :: coaching leads', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });
  afterEach(() => {
    cleanup();
    sessionStorage.clear();
    state.storedFlags = {};
  });

  it('a lead with no linked coach does not anchor a team', async () => {
    // Twelve players, three leads, no coach_team_requests link. Before B6 each lead became a
    // synthetic coach, so the three anchored three teams of four, under the minimum roster.
    seedImport(12, [2, 5, 9]);
    await generate();

    const teams = stagedTeams();
    expect(teams).toHaveLength(1);
    expect(teams[0].coachId).toBeNull();
    const players = teams[0].players;
    expect(players).toHaveLength(12);
    expect(
      players
        .filter((p) => p.isCoachingLead)
        .map((p) => p.id)
        .sort()
    ).toEqual([durableId(2), durableId(5), durableId(9)].sort());
    for (const player of players) expect(player).not.toHaveProperty('coachId');
  });

  it('by default, passes the effective flags and spreads four leads over three teams 2/1/1', async () => {
    seedImport(36, [1, 2, 3, 4]);
    await generate();

    expect(calls.generateTeams).toHaveLength(1);
    expect(calls.generateTeams[0].featureFlags).toMatchObject({
      teaming_spread_coaching_leads: true,
      years_played: true,
      player_rating: false,
    });
    const teams = stagedTeams();
    expect(teams).toHaveLength(3);
    expect(leadsPerTeam(teams)).toEqual([1, 1, 2]);
    // The generator read the stored years played.
    const byId = new Map(teams.flatMap((t) => t.players).map((p) => [p.id, p]));
    expect(byId.get(durableId(5)).years_played).toBe(5);
  });

  it('with the setting stored off, passes it off', async () => {
    state.storedFlags = { teaming_spread_coaching_leads: false };
    seedImport(36, [1, 2, 3, 4]);
    await generate();

    expect(calls.generateTeams[0].featureFlags.teaming_spread_coaching_leads).toBe(false);
    // The leads are still marked (the roster editor shows them); only the deal ignores them.
    expect(leadsPerTeam(stagedTeams()).reduce((a, b) => a + b, 0)).toBe(4);
  });

  it("reads the lead from the player's record, which wins over the file", async () => {
    // The file said "No" for player 3 and "Yes" for player 7; the stored flags say the opposite
    // ("Maybe" is stored as willing, as finalize_import_job reads it).
    seedImport(12, [7], (r) => r.external_registration_id === 'REG-3');
    await generate();

    const leads = stagedTeams()
      .flatMap((t) => t.players)
      .filter((p) => p.isCoachingLead)
      .map((p) => p.id);
    expect(leads).toEqual([durableId(3)]);
  });

  it("teams the demo league's U10 boys: every player placed, leads within one", async () => {
    // fixtures/demo-2026 (placeholders only): the export's rows as import-validation stages
    // them, by `canonicalImportKey`, and the players finalize_import_job would store.
    const file = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      'fixtures',
      'demo-2026',
      'players.csv'
    );
    const { data } = Papa.parse(readFileSync(file, 'utf8'), { header: true, skipEmptyLines: true });
    const u10b = data.filter((r) => r['Team Name']?.startsWith('U10B'));
    state.rows = u10b.map((raw) => {
      const staged = Object.fromEntries(
        Object.entries(raw).map(([header, value]) => [canonicalImportKey(header), value])
      );
      return {
        external_registration_id: staged.external_registration_id,
        first_name: staged.first_name,
        last_name: staged.last_name,
        age_group: '9',
        years_played: staged.years_played,
        willing_to_coach: staged.willing_to_coach,
      };
    });
    state.durablePlayers = state.rows.map((r, i) => ({
      id: `5d1c2b3a-4e5f-4a6b-8c7d-${String(900000000000 + i)}`,
      external_registration_id: r.external_registration_id,
      division_id: IDS.division,
      first_name: r.first_name,
      last_name: r.last_name,
      willing_to_coach: isCoachingLeadAnswer(r.willing_to_coach),
      years_played: Number(r.years_played),
    }));
    const expectedLeads = state.durablePlayers.filter((p) => p.willing_to_coach).length;
    expect(state.rows).toHaveLength(88);
    expect(expectedLeads).toBeGreaterThan(8);
    await generate();

    const teams = stagedTeams();
    expect(teams).toHaveLength(8);
    expect(teams.flatMap((t) => t.players)).toHaveLength(88);
    for (const team of teams) expect(team.coachId).toBeNull();
    const leads = leadsPerTeam(teams);
    expect(leads.reduce((a, b) => a + b, 0)).toBe(expectedLeads);
    expect(Math.max(...leads) - Math.min(...leads)).toBeLessThanOrEqual(1);
  });

  it("reads the record's rating, and a blank rating as none", async () => {
    state.storedFlags = { player_rating: true };
    seedImport(12, [1]);
    state.rows[0] = { ...state.rows[0], rating: '', skill_tier: 'advanced' };
    state.durablePlayers[1] = { ...state.durablePlayers[1], rating: 4 };
    await generate();

    expect(calls.generateTeams[0].featureFlags.player_rating).toBe(true);
    const byId = new Map(
      stagedTeams()
        .flatMap((t) => t.players)
        .map((p) => [p.id, p])
    );
    expect(byId.get(durableId(1))).not.toHaveProperty('rating');
    expect(byId.get(durableId(1)).skillRating).toBe(5);
    expect(byId.get(durableId(2)).rating).toBe(4);
  });

  it('with Coaching Interest off, marks no lead', async () => {
    state.storedFlags = { coaching_interest: false };
    seedImport(12, [2, 5, 9]);
    await generate();

    const players = stagedTeams().flatMap((t) => t.players);
    // Meta-assertion: the run was staged with every player.
    expect(players).toHaveLength(12);
    expect(players.some((p) => 'isCoachingLead' in p)).toBe(false);
  });
});
