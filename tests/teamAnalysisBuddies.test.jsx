/**
 * Buddy requests reach the generator from the Teams page (Phase B1,
 * docs/changes/2026-10-22-phase-b-teaming.md).
 *
 * The page is real, and so are `useFeatures` (reading the organization's flags through the
 * real schema) and the core pipeline and generator; its data hooks, Supabase and heavy
 * children are stand-ins, as in `teamSyncKeepsStatus.test.jsx`. The import rows carry the
 * canonical keys `import-validation` stages (`buddy_request`, `external_registration_id`,
 * `age_group`), and one carries the export's own "Buddy Request" header.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { createChainMock } from './helpers/index.js';
import { FeatureFlagSchema } from '../frontend/src/constants/featureFlags.js';

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
const row = (n, first, last, extra = {}) => ({
  external_registration_id: `REG-${n}`,
  first_name: first,
  last_name: last,
  age_group: '9',
  ...extra,
});

function seedImport() {
  state.rows = [
    row(1, 'Ada', 'One', { buddy_request: 'Bea Two' }),
    // The export's own header, which the import maps to buddy_request.
    row(2, 'Bea', 'Two', { 'Buddy Request': 'one, ada' }),
    // Names a player who plays in another division: listed, never linked.
    row(3, 'Cy', 'Three', { buddy_request: 'Zed Nine' }),
    ...Array.from({ length: 13 }, (_, i) => row(10 + i, `Kid${i}`, `Filler${i}`)),
    // U12 (age group 11): another program.
    row(99, 'Zed', 'Nine', { age_group: '11' }),
  ];
  // The players the import promoted, as `finalize_import_job` stores them.
  state.durablePlayers = state.rows.map((r, i) => ({
    id: `5d1c2b3a-4e5f-4a6b-8c7d-${String(900000000000 + i)}`,
    external_registration_id: r.external_registration_id,
    division_id: IDS.division,
    first_name: r.first_name,
    last_name: r.last_name,
    preferred_name: null,
    buddy_request: r.buddy_request ?? r['Buddy Request'] ?? null,
    mutual_buddy_code: null,
  }));
}

/** Edit a durable player as the Player Record page does (`players`, not the import rows). */
function editDurable(registrationId, patch) {
  const index = state.rows.findIndex((r) => r.external_registration_id === registrationId);
  state.durablePlayers[index] = { ...state.durablePlayers[index], ...patch };
}

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

/** The persisted team (by its player rows) of each of the two names. */
function teamIdsOf(results, a, b) {
  const durableId = (n) =>
    state.durablePlayers[state.rows.findIndex((r) => r.external_registration_id === `REG-${n}`)].id;
  const teamOf = (id) => results.team_players.find((tp) => tp.player_id === id)?.team_id;
  return [teamOf(durableId(a)), teamOf(durableId(b))];
}

describe('TeamAnalysisPage :: buddy requests reach the generator', () => {
  beforeEach(() => {
    sessionStorage.clear();
    seedImport();
  });
  afterEach(() => {
    sessionStorage.clear();
    state.storedFlags = {};
  });

  it('pairs a reciprocal name pair on one team and lists the unresolved request with its reason', async () => {
    state.storedFlags = {}; // buddy_requests defaults on, buddy_rule defaults to mutual
    await generate();

    const list = screen.getByRole('region', { name: 'Buddy requests' });
    expect(list).toHaveTextContent('U10: 1 paired, 0 one-way, 1 unresolved.');
    expect(list).toHaveTextContent('Rule: Mutual requests only.');
    const paired = within(list).getByRole('region', { name: 'Paired' });
    expect(paired).toHaveTextContent(/Ada One and Bea Two\. Placed together on .+\./);
    const unresolved = within(list).getByRole('region', { name: 'Unresolved' });
    const items = within(unresolved).getAllByRole('listitem');
    expect(items).toHaveLength(1);
    expect(items[0]).toHaveTextContent(
      'Cy Three asked for “Zed Nine”. The name matches a player in another division. Possible matches: Zed Nine (U12).'
    );

    // The staged run holds both on one team.
    const results = stagedResults();
    const [teamA, teamB] = teamIdsOf(results, 1, 2);
    expect(teamA).toBeTruthy();
    expect(teamA).toBe(teamB);
    expect(results.buddyDiagnosticsByDivision.U10.mutualPairs).toHaveLength(1);
  });

  it('reads names and requests from the player records, not the stale import rows (PR #647, Codex 3)', async () => {
    state.storedFlags = {};
    // The file said "Bea Twoo" and "Zed Nien"; an admin corrected Ada's request, Cy's request
    // and Zed's name on their records. Bea's request was cleared on her record.
    state.rows[0] = row(1, 'Ada', 'One', { buddy_request: 'Bea Twoo' });
    state.rows[2] = row(3, 'Cy', 'Three', { buddy_request: 'Zed Nine' });
    state.rows[state.rows.length - 1] = row(99, 'Zed', 'Nien', { age_group: '11' });
    editDurable('REG-1', { buddy_request: 'Bea Two' });
    editDurable('REG-2', { buddy_request: null });
    editDurable('REG-99', { last_name: 'Nine' });
    await generate();

    const list = screen.getByRole('region', { name: 'Buddy requests' });
    // Ada's corrected request finds Bea; Bea's cleared request makes it one-way.
    expect(list).toHaveTextContent('U10: 0 paired, 1 one-way, 1 unresolved.');
    expect(within(list).getByRole('region', { name: 'One-way' })).toHaveTextContent(
      'Ada One asked for Bea Two.'
    );
    // Zed's corrected name, in the other program, is the candidate.
    expect(within(list).getByRole('region', { name: 'Unresolved' })).toHaveTextContent(
      'Possible matches: Zed Nine (U12).'
    );
  });

  it('with the buddy_requests flag off, emits no buddy field: no pair and no list', async () => {
    state.storedFlags = { buddy_requests: false };
    await generate();

    expect(screen.queryByRole('region', { name: 'Buddy requests' })).not.toBeInTheDocument();
    const results = stagedResults();
    // Meta-assertion: the run was staged, so the absence below is about this run.
    expect(results.team_players.length).toBe(16);
    expect(results.buddyDiagnosticsByDivision.U10).toEqual({
      mutualPairs: [],
      unmatchedRequests: [],
    });
    expect(results.buddyRequestsByDivision).toBeUndefined();
    const generatorPlayers = results.teamsByDivision.U10.flatMap((team) => team.players);
    expect(generatorPlayers).toHaveLength(16);
    for (const player of generatorPlayers) {
      expect(player).not.toHaveProperty('buddy_request');
      expect(player).not.toHaveProperty('mutual_buddy_code');
      expect(player).not.toHaveProperty('external_registration_id');
    }
  });
});

describe('BuddyRequestsList :: placement follows the run’s current rows', () => {
  it('says a pair split by a manual roster edit is not placed together', async () => {
    const { default: BuddyRequestsList } =
      await import('../frontend/src/components/teaming/BuddyRequestsList.jsx');
    const summary = {
      rule: 'mutual',
      paired: [
        {
          playerIds: ['p-a', 'p-b'],
          names: ['Ada One', 'Bea Two'],
          teamName: 'Lions',
          together: true,
          matchedByReciprocity: false,
        },
      ],
      oneWay: [],
      unresolved: [],
    };
    const teams = [
      { id: 't-1', name: 'Lions' },
      { id: 't-2', name: 'Bulls' },
    ];
    const { rerender } = render(
      <BuddyRequestsList
        results={{
          buddyRequestsByDivision: { U10: summary },
          teams,
          team_players: [
            { team_id: 't-1', player_id: 'p-a' },
            { team_id: 't-1', player_id: 'p-b' },
          ],
        }}
      />
    );
    const paired = () => screen.getByRole('region', { name: 'Paired' });
    expect(paired()).toHaveTextContent('Ada One and Bea Two. Placed together on Lions.');

    // The admin moves Bea to the Bulls and saves: the snapshot's rows change, the summary
    // stored at generation does not.
    rerender(
      <BuddyRequestsList
        results={{
          buddyRequestsByDivision: { U10: summary },
          teams,
          team_players: [
            { team_id: 't-1', player_id: 'p-a' },
            { team_id: 't-2', player_id: 'p-b' },
          ],
        }}
      />
    );
    expect(paired()).toHaveTextContent('Ada One and Bea Two. Not placed together.');
  });
});

describe('BuddyRequestsList :: one-way reasons in words', () => {
  it('names each reason a one-way request was not honoured, and an honoured one', async () => {
    const { default: BuddyRequestsList } =
      await import('../frontend/src/components/teaming/BuddyRequestsList.jsx');
    const entry = (playerId, reason, honoured = false) => ({
      playerId,
      playerName: `Kid ${playerId}`,
      request: 'Bea Two',
      targetId: 'b',
      targetName: 'Bea Two',
      honoured,
      reason,
      teamName: null,
      together: false,
    });
    render(
      <BuddyRequestsList
        results={{
          buddyRequestsByDivision: {
            U10: {
              rule: 'one_way_best_effort',
              paired: [],
              oneWay: [
                entry('1', 'buddy-rule-mutual'),
                entry('2', 'named-player-listed-another-buddy'),
                entry('3', 'requester-has-another-buddy'),
                entry('4', null, true),
              ],
              unresolved: [],
            },
          },
        }}
      />
    );
    const items = within(screen.getByRole('region', { name: 'One-way' })).getAllByRole('listitem');
    expect(items.map((item) => item.textContent)).toEqual([
      'Kid 1 asked for Bea Two. Not honoured: the league pairs mutual requests only.',
      'Kid 2 asked for Bea Two. Not honoured: Bea Two listed a buddy of their own.',
      'Kid 3 asked for Bea Two. Not honoured: Kid 3 is already paired by a buddy code.',
      'Kid 4 asked for Bea Two. Honoured best effort. Not placed together.',
    ]);
    expect(screen.getByText(/Rule: One-way requests, best effort\./)).toBeInTheDocument();
  });
});
