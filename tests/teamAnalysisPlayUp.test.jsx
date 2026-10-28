/**
 * Play-up by request, on the Teams page (docs/changes/2026-10-27-play-up-by-request.md).
 *
 * Everyone plays in their own division unless a play-up was requested; the Play-up section lists
 * every play-up (requested or not), every play-down and each waitlisted player a coach's child's
 * buddy took off the waitlist; saving the teams makes those players active. The page is real, and
 * so are the pipeline and the generator; its data hooks, Supabase and heavy children are
 * stand-ins, as in `teamAnalysisEligibility.test.jsx`. Two programs, U10 and U12, so a player can
 * register in one and play in the other. Ages are counted in season 2026 by birth year: a child
 * born in 2016 is 10, in 2014 is 12.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

const REVIEW_KEY = `squadlogic:team-review:${IDS.organization}:${IDS.season}`;
const BORN_10 = '2016-05-01';
const BORN_12 = '2014-05-01';

/** An import row; `division` is the program the player registered in. */
const row = (n, division, dob, extra = {}) => ({
  external_registration_id: `REG-${n}`,
  first_name: `Kid${n}`,
  last_name: `Placeholder${n}`,
  division,
  date_of_birth: dob,
  ...extra,
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
    buddy_request: r.buddy_request ?? null,
    mutual_buddy_code: null,
  }));
}
const idOf = (n) => state.durablePlayers.find((p) => p.external_registration_id === `REG-${n}`).id;

function seed(rows) {
  state.rows = rows;
  state.durablePlayers = promote(rows);
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

const stagedResults = () =>
  JSON.parse(sessionStorage.getItem(REVIEW_KEY) || 'null')?.snapshot?.runMetadata?.results;
const seatedIn = (results, division) =>
  (results.teamsByDivision[division] ?? []).flatMap((team) => team.players.map((p) => p.id));
const section = () => screen.getByRole('region', { name: 'Play-up' });

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
}

describe('the Play-up section of the U12 program', () => {
  // U12 first, so it is the program the page selects. Kid1 asked to play up and registered in
  // U12 (age 10); Kid2 is the same age and registered in U12 without asking; Kid3 is 12 and was
  // registered in U10 (a play-down).
  const rows = () => [
    row(1, 'U12', BORN_10, { play_up: 'Yes' }),
    row(2, 'U12', BORN_10),
    ...fill('U12', BORN_12, 10, 8),
    row(3, 'U10', BORN_12),
    ...fill('U10', BORN_10, 30, 8),
  ];
  beforeEach(() => {
    reset();
    seed(rows());
  });
  afterEach(reset);

  it('seats a requested play-up in the older division and an unrequested one in their own', async () => {
    await generate();
    const results = stagedResults();
    // The requested play-up is on a U12 team.
    expect(seatedIn(results, 'U12')).toContain(idOf(1));
    // The unrequested one is not in U12: they play in U10, which this run does not seat.
    expect(seatedIn(results, 'U12')).not.toContain(idOf(2));
    expect(
      (results.overflowByDivision.U12 ?? []).flatMap((e) => e.players.map((p) => p.id))
    ).not.toContain(idOf(2));
    // The play-down registered in U10 plays in U12 (their own age division) and is seated here.
    expect(seatedIn(results, 'U12')).toContain(idOf(3));
  });

  it('lists the requested play-up, the unrequested one and the play-down, with their facts', async () => {
    await generate();
    const rowsOf = within(section()).getAllByRole('row').slice(1);
    const byName = (name) => rowsOf.find((tr) => within(tr).queryByText(name));
    expect(rowsOf).toHaveLength(3);

    expect(byName('Kid1 Placeholder1')).toHaveTextContent(
      'Kid1 Placeholder110RequestedNoNonePlays in U12, the older division they registered for.'
    );
    expect(byName('Kid2 Placeholder2')).toHaveTextContent(
      'Registered in U12 but plays in U10 (no play-up request).'
    );
    expect(byName('Kid2 Placeholder2')).toHaveTextContent('Not requested');
    expect(byName('Kid3 Placeholder3')).toHaveTextContent('Registered in U10 but plays in U12.');
    expect(byName('Kid3 Placeholder3')).toHaveTextContent('Not applicable');
    expect(section()).toHaveTextContent('2 play-ups (1 requested, 1 not), 1 play-down');
  });

  it('keeps the section out of a run that has nobody to list', async () => {
    seed([...fill('U12', BORN_12, 1, 8), ...fill('U10', BORN_10, 30, 8)]);
    await generate();
    expect(screen.queryByRole('region', { name: 'Play-up' })).not.toBeInTheDocument();
    expect(stagedResults().playUpByDivision.U12).toEqual([]);
  });

  it('lists a player no division can hold, not placed, with the reason', async () => {
    seed([...rows(), row(99, 'U12', '2008-05-01')]);
    await generate();
    const results = stagedResults();
    expect(seatedIn(results, 'U12')).not.toContain(idOf(99));
    expect(results.overflowByDivision.U12.map((e) => e.reason)).toContain('eligibility-blocked');
    const tr = within(section())
      .getAllByRole('row')
      .find((r) => within(r).queryByText('Kid99 Placeholder99'));
    expect(tr).toHaveTextContent(
      'Not placed: no division in this import holds a player of natural age 18.'
    );
  });

  it('reads the request from the player record before the file: a cleared flag wins', async () => {
    state.durablePlayers = state.durablePlayers.map((p) =>
      p.external_registration_id === 'REG-1' ? { ...p, play_up_requested: false } : p
    );
    await generate();
    // The file said yes, the record says no: they play in U10, not U12.
    expect(seatedIn(stagedResults(), 'U12')).not.toContain(idOf(1));
  });

  it('reads a request set on the player record when the file has no column', async () => {
    state.durablePlayers = state.durablePlayers.map((p) =>
      p.external_registration_id === 'REG-2' ? { ...p, play_up_requested: true } : p
    );
    await generate();
    expect(seatedIn(stagedResults(), 'U12')).toContain(idOf(2));
  });
});

describe('the U10 program takes the players who play in it', () => {
  beforeEach(() => {
    reset();
    seed([
      ...fill('U10', BORN_10, 30, 8),
      row(1, 'U12', BORN_10, { play_up: 'no' }),
      row(2, 'U12', BORN_10, { play_up: 'x' }),
      ...fill('U12', BORN_12, 10, 8),
    ]);
  });
  afterEach(reset);

  it('seats the unrequested play-up registered in U12, and not the requested one', async () => {
    await generate();
    const results = stagedResults();
    expect(seatedIn(results, 'U10')).toContain(idOf(1));
    expect(seatedIn(results, 'U10')).not.toContain(idOf(2));
    const names = within(section())
      .getAllByRole('row')
      .slice(1)
      .map((tr) => tr.textContent);
    expect(names.some((text) => text.includes('Kid1 Placeholder1'))).toBe(true);
    expect(names.some((text) => text.includes('Registered in U12 but plays in U10'))).toBe(true);
  });
});

describe('the waitlist exception, on save', () => {
  const COACH_CHILD = 40;
  const WAITING_BUDDY = 41;
  const OTHER_WAITING = 42;
  beforeEach(() => {
    reset();
    seed([
      row(COACH_CHILD, 'U10', BORN_10, {
        first_name: 'Cara',
        last_name: 'Coachkid',
        buddy_request: 'Wendy Waiting',
      }),
      row(WAITING_BUDDY, 'U10', BORN_10, {
        first_name: 'Wendy',
        last_name: 'Waiting',
        waitlist: 'yes',
        buddy_request: 'Cara Coachkid',
      }),
      row(OTHER_WAITING, 'U10', BORN_10, { waitlist: 'yes' }),
      ...fill('U10', BORN_10, 50, 9),
    ]);
    state.coachLinks = [
      { coach_id: IDS.coach, player_id: idOf(COACH_CHILD), preferred_co_coach_id: null },
    ];
    state.coaches = [{ id: IDS.coach, full_name: 'Casey Coach', status: 'active' }];
  });
  afterEach(reset);

  it('takes the coach’s child’s buddy off the waitlist, lists it, and makes them active on save', async () => {
    await generate();
    const results = stagedResults();
    // Placed on the coach's team with the child; the other waitlisted player is not placed.
    const coachTeam = results.teamsByDivision.U10.find((team) => team.coachId === IDS.coach);
    expect(coachTeam.players.map((p) => p.id)).toEqual(
      expect.arrayContaining([idOf(COACH_CHILD), idOf(WAITING_BUDDY)])
    );
    expect(seatedIn(results, 'U10')).not.toContain(idOf(OTHER_WAITING));
    expect(results.overflowByDivision.U10.map((e) => e.reason)).toContain('waitlisted');
    expect(results.waitlistExceptionsByDivision.U10.map((e) => e.playerId)).toEqual([
      idOf(WAITING_BUDDY),
    ]);

    expect(section()).toHaveTextContent(
      "Wendy Waiting. Taken off the waitlist: buddy of Cara Coachkid, Coach Casey Coach's child."
    );
    // Nothing is written until the teams are saved.
    expect(state.bulkUpdates).toEqual([]);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save the teams' }));
    });
    await waitFor(() => expect(state.bulkUpdates).toHaveLength(1));
    // Only the player a coach asked for, through the audited bulk status write.
    expect(state.bulkUpdates[0]).toEqual({
      p_player_ids: [idOf(WAITING_BUDDY)],
      p_patch: { status: 'active' },
    });
    expect(
      await screen.findByText(/1 player taken off the waitlist is now active\./)
    ).toBeInTheDocument();
  });

  it('says so when the status write is refused', async () => {
    state.bulkError = { message: 'permission denied' };
    await generate();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save the teams' }));
    });
    expect(
      await screen.findByText(/could not be made active \(permission denied\)/)
    ).toBeInTheDocument();
  });

  it('writes no status when nobody was taken off the waitlist', async () => {
    state.coachLinks = [];
    await generate();
    expect(stagedResults().waitlistExceptionsByDivision.U10).toEqual([]);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save the teams' }));
    });
    expect(state.bulkUpdates).toEqual([]);
  });
});
