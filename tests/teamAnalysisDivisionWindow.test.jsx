/**
 * A division's birth-date window on the Teams page (E3b; Codex's finding on #680): a registrant
 * whose birth date is in a division's window plays in that division, whatever program they
 * registered in. The window is a column of the division row, so the page must read it: this test's
 * `divisions` table returns only the columns the page asks for, as the database does, so a page
 * that leaves the window columns out of its select cannot see the window. A U4 takes the older
 * 3-year-olds (born Jan 1 - Jul 31, 2023); ages are counted in season 2026 by birth year.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
      // The real writer returns the whole stored row: a division that bears a window comes back as
      // itself (its id, band and window), not as a fresh one.
      const storedWindowed =
        name === 'admin_upsert_division_settings'
          ? state.divisionRows.find(
              (stored) =>
                String(stored.id) === String(params.p_division_id) && stored.birthdate_start
            )
          : null;
      if (storedWindowed) return { data: { ...storedWindowed, name: params.p_name }, error: null };
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
vi.mock('../frontend/src/components/teaming/TeamingConfiguration.jsx', () =>
  stub('teaming-config')
);
vi.mock('../frontend/src/components/teaming/RosterManager.jsx', () => stub('roster-manager'));

const { default: TeamAnalysisPage } = await import('../frontend/src/pages/TeamAnalysisPage.jsx');

const REVIEW_KEY = `squadlogic:team-review:${IDS.organization}:${IDS.season}`;
const BORN_4 = '2022-05-01';
const BORN_3_IN_WINDOW = '2023-05-01';
const BORN_3_AFTER_WINDOW = '2023-11-01';

const row = (n, division, dob) => ({
  external_registration_id: `REG-${n}`,
  first_name: `Kid${n}`,
  last_name: `Placeholder${n}`,
  division,
  date_of_birth: dob,
});
const fill = (division, dob, from, count) =>
  Array.from({ length: count }, (_, i) => row(from + i, division, dob));

/** The players the import promoted, as `finalize_import_job` stores them (by external id). */
function promote(rows) {
  return rows.map((r, i) => ({
    id: `5d1c2b3a-4e5f-4a6b-8c7d-${String(920000000000 + i)}`,
    external_registration_id: r.external_registration_id,
    division_id: IDS.division,
    first_name: r.first_name,
    last_name: r.last_name,
    preferred_name: null,
    buddy_request: null,
    mutual_buddy_code: null,
  }));
}
const idOf = (n) => state.durablePlayers.find((p) => p.external_registration_id === `REG-${n}`).id;

/** A division row as the table holds it: every column, the page reads the ones it names. */
const divisionRow = (name, minAge, maxAge, window = {}) => ({
  id: `5d1c2b3a-4e5f-4a6b-8c7d-${name === 'U4' ? '9e0f1a2b3c15' : '9e0f1a2b3c14'}`,
  organization_id: IDS.organization,
  season_settings_id: IDS.season,
  name,
  max_roster_size: 12,
  min_roster_size: 6,
  target_team_size: 8,
  team_count_override: null,
  min_teams: null,
  max_teams: null,
  min_age: minAge,
  max_age: maxAge,
  gender_policy: null,
  birthdate_start: window.start ?? null,
  birthdate_end: window.end ?? null,
});

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

const stagedResults = () =>
  JSON.parse(sessionStorage.getItem(REVIEW_KEY) || 'null')?.snapshot?.runMetadata?.results;
const seatedIn = (results, division) =>
  (results.teamsByDivision[division] ?? []).flatMap((team) => team.players.map((p) => p.id));

function reset() {
  cleanup();
  sessionStorage.clear();
  state.rows = [];
  state.durablePlayers = [];
  state.coachLinks = [];
  state.coaches = [];
  state.storedFlags = {};
  state.bulkUpdates = [];
  state.bulkError = null;
  state.divisionRows = [];
  state.divisionSelects = [];
}

describe("a division's birth-date window on the Teams page", () => {
  // The page selects U3. Kid1 registered in U3 and was born in the window U4 takes; Kid2..9
  // registered in U3 and were born after it; Kid10..17 are 4 and registered in U4.
  const rows = () => [
    row(1, 'U3', BORN_3_IN_WINDOW),
    ...fill('U3', BORN_3_AFTER_WINDOW, 2, 8),
    ...fill('U4', BORN_4, 10, 8),
  ];
  const playUpOf = (results, n) =>
    (results.playUpByDivision.U3 ?? []).find((entry) => entry.playerId === idOf(n));
  beforeEach(() => {
    reset();
    state.rows = rows();
    state.durablePlayers = promote(state.rows);
    state.divisionRows = [
      divisionRow('U4', 4, 4, { start: '2023-01-01', end: '2023-07-31' }),
      divisionRow('U3', 3, 3),
    ];
  });
  afterEach(reset);

  it('plays a U3 registrant born in the U4 window in U4, and the rest of U3 stays in U3', async () => {
    await generate();
    const results = stagedResults();
    // Born in the window: counted as 4 (the cutoff alone gives 3), so not on a U3 team.
    expect(seatedIn(results, 'U3')).not.toContain(idOf(1));
    expect(playUpOf(results, 1)).toMatchObject({ naturalAge: 4, playedDivision: 'U4' });
    // Born after the window: still counted by the cutoff, so seated in U3 and not listed.
    expect(seatedIn(results, 'U3')).toContain(idOf(2));
    expect(playUpOf(results, 2)).toBeUndefined();
    // The page read the window with the division.
    expect(state.divisionSelects[0]).toContain('birthdate_start');
    expect(state.divisionSelects[0]).toContain('birthdate_end');
  });

  it('POSITIVE CONTROL: with no window on the division, the same registrant is counted by the cutoff and plays in U3', async () => {
    state.divisionRows = [divisionRow('U4', 4, 4), divisionRow('U3', 3, 3)];
    await generate();
    const results = stagedResults();
    expect(seatedIn(results, 'U3')).toContain(idOf(1));
    expect(playUpOf(results, 1)).toBeUndefined();
  });
});

describe('a window on a division the file has no registrants in', () => {
  // The file has only U3 registrants. U4 is a division of the season that bears a window and has
  // nobody registered in it: it still takes the U3 registrant born in its window.
  const rows = () => [row(1, 'U3', BORN_3_IN_WINDOW), ...fill('U3', BORN_3_AFTER_WINDOW, 2, 8)];
  beforeEach(() => {
    reset();
    state.rows = rows();
    state.durablePlayers = promote(state.rows);
    state.divisionRows = [
      divisionRow('U4', 4, 4, { start: '2023-01-01', end: '2023-07-31' }),
      divisionRow('U3', 3, 3),
    ];
  });
  afterEach(reset);

  it('plays the registrant born in the window of an empty division in that division, not in U3', async () => {
    await generate();
    const results = stagedResults();
    expect(seatedIn(results, 'U3')).not.toContain(idOf(1));
    const entry = (results.playUpByDivision.U3 ?? []).find((e) => e.playerId === idOf(1));
    expect(entry).toMatchObject({ naturalAge: 4, playedDivisionName: 'U4' });
    // The rest of U3 is untouched.
    expect(seatedIn(results, 'U3')).toContain(idOf(2));
  });

  it('lists that division as a program with the incoming player, and generating it seats them', async () => {
    render(
      <MemoryRouter>
        <TeamAnalysisPage />
      </MemoryRouter>
    );
    // The file has only U3 registrants; U4 is a program because a window takes one of them.
    const u4 = await screen.findByRole('button', { name: /^U4/ });
    expect(u4.closest('tr')).toHaveTextContent(/U4\s*1/);
    const u3 = screen.getByRole('button', { name: /^U3/ });
    expect(u3.closest('tr')).toHaveTextContent(/U3\s*9/);
    fireEvent.click(u4);
    const button = await screen.findByRole('button', { name: /Generate Teams/ });
    await waitFor(() => expect(button).toBeEnabled());
    await act(async () => {
      fireEvent.click(button);
    });
    await screen.findByText('Team Review Pending');
    const results = stagedResults();
    const u4Id = state.divisionRows.find((r) => r.name === 'U4').id;
    expect(seatedIn(results, u4Id)).toEqual([idOf(1)]);
  });

  it('POSITIVE CONTROL: with no window on that division, the same registrant stays in U3', async () => {
    state.divisionRows = [divisionRow('U4', 4, 4), divisionRow('U3', 3, 3)];
    await generate();
    expect(seatedIn(stagedResults(), 'U3')).toContain(idOf(1));
  });
});
