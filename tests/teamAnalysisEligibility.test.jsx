/**
 * Eligibility reaches the generator from the Teams page (Phase B2,
 * docs/changes/2026-10-22-phase-b-teaming.md), and the page shows what the run did with it
 * (Phase B3): a failure stops the run, and the review lists who was not placed, who needs review
 * and who was placed without a check.
 *
 * The page is real, and so are the core pipeline (`prepareTeamingInput`, which annotates
 * play-up / play-down eligibility with `remapBlocked: false`) and the generator; its data
 * hooks, Supabase and heavy children are stand-ins, as in `teamAnalysisBuddies.test.jsx`. The
 * import rows carry the canonical keys `import-validation` stages (`date_of_birth`,
 * `external_registration_id`, `age_group`). The natural age comes from the birthdate the import
 * row holds or, for a row with none, from the stored natural age on the durable player (R5,
 * docs/changes/2026-10-22-admin-focus.md).
 *
 * The last two groups are the owner's decisions of 2026-10-27
 * (docs/changes/2026-10-22-phase-b-teaming.md, "Owner decisions"): the waitlist, the coach
 * links, and what the review says about a coach.
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
  team: '5d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c14',
}));

const state = vi.hoisted(() => ({
  /** @type {any[]} */
  rows: [],
  /** @type {any[]} */
  durablePlayers: [],
  /** @type {any} */
  persistenceSnapshot: null,
  /** @type {any} the error the `coach_team_requests` read returns */
  coachLinksError: null,
  /** @type {any[]} the `coach_team_requests` rows */
  coachLinks: [],
  /** @type {any[]} the `coaches` rows */
  coaches: [],
  /** @type {any} the organization's stored feature flags, parsed by the schema */
  storedFlags: {},
  pipelineThrows: false,
}));

// The real pipeline, which a test can make throw: nothing in today's input reaches a throw, so
// the failure is planted at the function's boundary to prove the page's handling of one.
vi.mock('@squadlogic/core/teamingPipeline.js', async (importOriginal) => {
  const actual = /** @type {any} */ (await importOriginal());
  return {
    ...actual,
    prepareTeamingInput: (/** @type {any} */ input) => {
      if (state.pipelineThrows) throw new Error('planted pipeline failure');
      return actual.prepareTeamingInput(input);
    },
  };
});

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
    from: (table) => {
      if (table === 'coach_team_requests') {
        return createChainMock(
          state.coachLinksError
            ? { data: null, error: state.coachLinksError }
            : { data: state.coachLinks, error: null }
        );
      }
      const rows =
        table === 'players' ? state.durablePlayers : table === 'coaches' ? state.coaches : [];
      return createChainMock({ data: rows, error: null });
    },
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
    buddy_request: r.buddy_request ?? null,
    mutual_buddy_code: null,
  }));
}

/** Every imported player's durable id, from the import (never from the run's output). */
const durableIdOf = (n) =>
  state.durablePlayers[state.rows.findIndex((r) => r.external_registration_id === `REG-${n}`)].id;
const allDurableIds = () => state.durablePlayers.map((player) => player.id);

async function clickGenerate() {
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
  return button;
}

async function generate() {
  await clickGenerate();
  await screen.findByText('Team Review Pending');
}

/** A rerun's saved team: ten players, the blocked one (1) among them; 18 and 19 are late. */
function seedSavedTeam() {
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
}

/** A list of the review by its heading (each is a `<section>` labelled by its heading). */
const reviewList = (name) => screen.getByRole('region', { name });

function stagedResults() {
  return JSON.parse(sessionStorage.getItem(REVIEW_KEY) || 'null')?.snapshot?.runMetadata?.results;
}

const overflowIds = (results) =>
  (results.overflowByDivision.U10 ?? []).flatMap((entry) => entry.players.map((p) => p.id));

describe('TeamAnalysisPage :: eligibility reaches the generator', () => {
  beforeEach(() => {
    sessionStorage.clear();
    state.persistenceSnapshot = null;
    state.coachLinksError = null;
    state.pipelineThrows = false;
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
    // The run stops at the page's own guard (no teams), and says why (B3): the players are
    // imported, and not one is eligible for the division.
    await waitFor(() => expect(button).toBeEnabled());
    expect(screen.queryByText('Team Review Pending')).not.toBeInTheDocument();
    expect(sessionStorage.getItem(REVIEW_KEY)).toBeNull();
    expect(screen.getByText(/none of its players is eligible for the division/)).toHaveTextContent(
      /Not eligible \(12\): Kid1 Placeholder1, Kid2 Placeholder2, Kid10 Placeholder10 and 9 more\./
    );
    expect(screen.queryByText(/Check that players are imported/)).not.toBeInTheDocument();
  });

  it('on a rerun keeps a rostered blocked player on their saved team and lists the hold', async () => {
    seedSavedTeam();
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

describe('TeamAnalysisPage :: eligibility from stored players only (R5)', () => {
  // The import rows carry no birth date (no birth date is stored, and a row reloaded after the
  // import session has none); the natural age is the durable player's, as `finalize_import_job`
  // stored it (docs/changes/2026-10-22-admin-focus.md, R5, taking B2's hand-off).
  const NATURAL_AGE = { 'REG-1': 13, 'REG-2': null };
  function seedStoredOnly({ keepBirthDates = false } = {}) {
    seedImport();
    if (!keepBirthDates) {
      state.rows = state.rows.map(({ date_of_birth: _dropped, ...rest }) => rest);
    }
    state.durablePlayers = state.durablePlayers.map((player) => ({
      ...player,
      natural_age:
        NATURAL_AGE[player.external_registration_id] === undefined
          ? 10
          : NATURAL_AGE[player.external_registration_id],
    }));
  }
  beforeEach(() => {
    sessionStorage.clear();
    state.persistenceSnapshot = null;
    state.coachLinksError = null;
    state.pipelineThrows = false;
  });
  afterEach(() => {
    sessionStorage.clear();
  });

  it('blocks a stored play-down with no birth date in the rows; a player with none is seated, unknown', async () => {
    seedStoredOnly();
    expect(state.rows.some((r) => 'date_of_birth' in r)).toBe(false);
    await generate();

    const results = stagedResults();
    const seated = results.team_players.map((tp) => tp.player_id);
    expect(seated).not.toContain(durableIdOf(1));
    const entry = results.overflowByDivision.U10.find((e) => e.players[0].id === durableIdOf(1));
    expect(entry).toMatchObject({
      reason: 'eligibility-blocked',
      metadata: { placement: 'play_down_blocked', naturalAge: 13 },
    });
    const placed = results.teamsByDivision.U10.flatMap((team) => team.players);
    expect(placed.find((player) => player.id === durableIdOf(2)).placement).toBe('unknown');
    expect(placed.filter((player) => player.placement === 'in_band')).toHaveLength(10);
    expect([...seated, ...overflowIds(results)].sort()).toEqual(allDurableIds().sort());
  });

  it("reads a session row's birth date before the stored natural age (the page's season)", async () => {
    // Every row is in band by its birth date; REG-1's stored age (13) is not read while the
    // session's row carries the date, and REG-2 (no stored age) is in band by its date too.
    seedStoredOnly({ keepBirthDates: true });
    state.rows = state.rows.map((r) => ({ ...r, date_of_birth: IN_BAND }));
    await generate();
    const results = stagedResults();
    expect(overflowIds(results)).not.toContain(durableIdOf(1));
    const placed = results.teamsByDivision.U10.flatMap((team) => team.players);
    expect(placed.filter((player) => player.placement === 'in_band')).toHaveLength(12);
  });
});

describe('TeamAnalysisPage :: failures stop generation (B3)', () => {
  beforeEach(() => {
    sessionStorage.clear();
    state.persistenceSnapshot = null;
    state.coachLinksError = null;
    state.pipelineThrows = false;
    seedImport();
  });
  afterEach(() => {
    sessionStorage.clear();
  });

  it('a refused coach_team_requests read shows the error and stages no review', async () => {
    state.coachLinksError = { message: 'permission denied for table coach_team_requests' };
    const button = await clickGenerate();

    expect(
      await screen.findByText(
        "Could not read the coaches' team links, so teams were not generated: permission denied for table coach_team_requests."
      )
    ).toBeInTheDocument();
    await waitFor(() => expect(button).toBeEnabled());
    expect(screen.queryByText('Team Review Pending')).not.toBeInTheDocument();
    expect(sessionStorage.getItem(REVIEW_KEY)).toBeNull();
  });

  it('a teaming pipeline that throws shows the error and stages no review', async () => {
    state.pipelineThrows = true;
    const button = await clickGenerate();

    expect(await screen.findByText('planted pipeline failure')).toBeInTheDocument();
    await waitFor(() => expect(button).toBeEnabled());
    expect(screen.queryByText('Team Review Pending')).not.toBeInTheDocument();
    expect(sessionStorage.getItem(REVIEW_KEY)).toBeNull();
  });
});

describe('TeamAnalysisPage :: not placed and flagged, on the review (B3)', () => {
  beforeEach(() => {
    sessionStorage.clear();
    state.persistenceSnapshot = null;
    state.coachLinksError = null;
    state.pipelineThrows = false;
    seedImport();
  });
  afterEach(() => {
    sessionStorage.clear();
  });

  it('lists a blocked player under "Not placed" with the reason in words and the natural age', async () => {
    await generate();

    const list = reviewList('Not placed');
    const items = within(list).getAllByRole('listitem');
    // Enumerated from the import: the one blocked player, and nobody else.
    expect(items).toHaveLength(1);
    expect(items[0]).toHaveTextContent(
      'Kid1 Placeholder1. Not eligible for this division. Older than the division allows, and playing down is not permitted. Natural age 13.'
    );
    expect(screen.getByText(/^U10: 1 not placed \(1 not eligible/)).toBeInTheDocument();
  });

  it('places a player with no natural age and flags them "Eligibility not checked"', async () => {
    await generate();

    const list = reviewList('Eligibility not checked');
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(1);
    expect(items[0]).toHaveTextContent(
      /^Kid2 Placeholder2 Eligibility not checked on U10 Team \d+\.$/
    );
    // Placed, not held: they are on a staged roster and not under "Not placed".
    expect(stagedResults().team_players.map((tp) => tp.player_id)).toContain(durableIdOf(2));
    expect(within(reviewList('Not placed')).queryByText(/Kid2 Placeholder2/)).toBeNull();
  });

  it('lists a rerun hold under "Needs review": who, which team, why', async () => {
    seedSavedTeam();
    await generate();

    const items = within(reviewList('Needs review')).getAllByRole('listitem');
    expect(items).toHaveLength(1);
    expect(items[0]).toHaveTextContent(
      'Kid1 Placeholder1, on Saved Team. Not eligible for this division. Older than the division allows, and playing down is not permitted. Kept on the reviewed roster; move them by hand if you agree.'
    );
    // Held, so not under "Not placed".
    expect(screen.queryByRole('region', { name: 'Not placed' })).toBeNull();
  });

  it('announces the lists once, through one polite live region', async () => {
    await generate();

    const regions = screen
      .getAllByRole('status')
      .filter((node) => node.getAttribute('aria-live') === 'polite');
    const announcement = regions.find((node) => /Players to review/.test(node.textContent || ''));
    expect(announcement).toHaveTextContent(
      'Players to review: 1 player not placed (1 not eligible for the division); 1 placed player: eligibility not checked.'
    );
    expect(regions.filter((node) => /Players to review/.test(node.textContent || ''))).toHaveLength(
      1
    );

    // A reload shows the staged lists again, without announcing them a second time.
    cleanup();
    render(
      <MemoryRouter>
        <TeamAnalysisPage />
      </MemoryRouter>
    );
    await screen.findByText('Team Review Pending');
    expect(reviewList('Not placed')).toBeInTheDocument();
    expect(screen.queryByText(/Players to review:/)).toBeNull();
  });

  it('clears the announcement with the review it was about', async () => {
    await generate();
    expect(screen.getByText(/^Players to review:/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Discard Review' }));
    await screen.findByText('Team review discarded.');
    expect(screen.queryByText(/^Players to review:/)).toBeNull();
  });

  it('says why a buddy pair is apart when one of them is blocked', async () => {
    // A mutual pair by name (letters only: a name with a digit is read as an id), the
    // blocked player 1 and player 10, who is placed alone (`buddy-not-placed`).
    const pair = {
      'REG-1': { first_name: 'Ada', last_name: 'Blocked', buddy_request: 'Bea Placed' },
      'REG-10': { first_name: 'Bea', last_name: 'Placed', buddy_request: 'Ada Blocked' },
    };
    state.rows = state.rows.map((r) => ({ ...r, ...pair[r.external_registration_id] }));
    state.durablePlayers = state.durablePlayers.map((player) => ({
      ...player,
      ...pair[player.external_registration_id],
    }));
    await generate();

    const paired = within(reviewList('Paired')).getAllByRole('listitem');
    expect(paired).toHaveLength(1);
    expect(paired[0]).toHaveTextContent(
      'Ada Blocked and Bea Placed. Not placed together: Ada Blocked is not eligible for this division and is not placed.'
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Owner decisions of 2026-10-27: the waitlist, the coach links, and what the review says about a
// coach. Real page, pipeline and generator; every expectation is worked out from the seeds.
// ---------------------------------------------------------------------------------------------

const COACH_A = '5d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c91';
const COACH_B = '5d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c92';
const link = (coachId, n) => ({
  coach_id: coachId,
  player_id: durableIdOf(n),
  preferred_co_coach_id: null,
});

function resetOwnerDecisionState() {
  sessionStorage.clear();
  state.persistenceSnapshot = null;
  state.coachLinksError = null;
  state.pipelineThrows = false;
  state.coachLinks = [];
  state.coaches = [];
  state.storedFlags = {};
  seedImport();
}

const teamsOf = (results) => results.teamsByDivision.U10;
const teamOfPlayer = (results, n) =>
  teamsOf(results).find((team) => team.players.some((p) => p.id === durableIdOf(n)));

describe('TeamAnalysisPage :: the waitlist (owner, 2026-10-27)', () => {
  beforeEach(resetOwnerDecisionState);
  afterEach(resetOwnerDecisionState);

  it('seats no waitlisted player: the import column and the stored status both hold them out', async () => {
    // REG-10 is marked on the import row; REG-11 only on the stored player (the row says
    // nothing); REG-12's row says waitlist but an admin has since moved the stored player to
    // active, which wins.
    state.rows = state.rows.map((r) =>
      r.external_registration_id === 'REG-10'
        ? { ...r, waitlist: 'Yes' }
        : r.external_registration_id === 'REG-12'
          ? { ...r, waitlist: 'Yes' }
          : r
    );
    // The stored status where the player has one; REG-10's row is the only word on them.
    state.durablePlayers = state.durablePlayers.map((p) => {
      if (p.external_registration_id === 'REG-11') return { ...p, status: 'waitlist' };
      if (p.external_registration_id === 'REG-12') return { ...p, status: 'active' };
      return p;
    });
    await generate();

    const results = stagedResults();
    const seated = results.team_players.map((tp) => tp.player_id);
    expect(seated).not.toContain(durableIdOf(10));
    expect(seated).not.toContain(durableIdOf(11));
    expect(seated).toContain(durableIdOf(12));
    const waitlisted = results.overflowByDivision.U10.filter((e) => e.reason === 'waitlisted');
    expect(waitlisted.map((e) => e.players[0].id).sort()).toEqual(
      [durableIdOf(10), durableIdOf(11)].sort()
    );
    // Conservation, enumerated from the import: seated or not placed, once.
    expect([...seated, ...overflowIds(results)].sort()).toEqual(allDurableIds().sort());

    const items = within(reviewList('Not placed')).getAllByRole('listitem');
    expect(items.map((li) => li.textContent).join('\n')).toMatch(
      /Kid10 Placeholder10\. On the waitlist: not placed on any team\./
    );
    expect(screen.getByText(/^U10: 3 not placed \(1 not eligible/)).toHaveTextContent(
      '3 not placed (1 not eligible for the division, 2 on the waitlist, 0 for another reason)'
    );
  });

  it('stages nothing when every player is waitlisted, and says so', async () => {
    state.rows = state.rows.map((r) => ({ ...r, waitlist: 'yes', date_of_birth: IN_BAND }));
    const button = await clickGenerate();
    await waitFor(() => expect(button).toBeEnabled());
    expect(screen.queryByText('Team Review Pending')).not.toBeInTheDocument();
    expect(sessionStorage.getItem(REVIEW_KEY)).toBeNull();
    expect(
      await screen.findByText(/12 of its 12 players are on the waitlist, which no team seats/)
    ).toHaveTextContent('Kid1 Placeholder1, Kid2 Placeholder2, Kid10 Placeholder10 and 9 more.');
  });

  it('with the Waitlist feature off, a waitlist column holds nobody out', async () => {
    state.storedFlags = { waitlist: false };
    state.rows = state.rows.map((r) =>
      r.external_registration_id === 'REG-10' ? { ...r, waitlist: 'Yes' } : r
    );
    state.durablePlayers = state.durablePlayers.map((p) => ({
      ...p,
      status: p.external_registration_id === 'REG-11' ? 'waitlist' : 'active',
    }));
    await generate();

    const results = stagedResults();
    const seated = results.team_players.map((tp) => tp.player_id);
    expect(seated).toContain(durableIdOf(10));
    expect(seated).toContain(durableIdOf(11));
    expect(results.overflowByDivision.U10.map((e) => e.reason)).not.toContain('waitlisted');
  });
});

describe('TeamAnalysisPage :: a coach the import row names (kept as it was)', () => {
  // Owner, 2026-10-27, item 8a: whether only `coach_team_requests` links should anchor a team
  // was NOT built, because nothing in production writes that table. The row's coach still
  // anchors, and the review labels such a coach by the text the row holds.
  beforeEach(resetOwnerDecisionState);
  afterEach(resetOwnerDecisionState);

  it('still anchors a team, as before', async () => {
    state.rows = state.rows.map((r) =>
      r.external_registration_id === 'REG-10' ? { ...r, coach_email: 'row.coach@coaches.test' } : r
    );
    await generate();
    const results = stagedResults();
    expect(teamOfPlayer(results, 10).coachId).toBe('row.coach@coaches.test');
  });

  it('is flagged by that text when their only child is held out, with no coaches read', async () => {
    state.rows = state.rows.map((r) =>
      r.external_registration_id === 'REG-1' ? { ...r, coach_email: 'row.coach@coaches.test' } : r
    );
    state.coaches = [{ id: COACH_A, full_name: 'Not This One' }];
    await generate();
    const results = stagedResults();
    expect(teamsOf(results).map((team) => team.coachId)).not.toContain('row.coach@coaches.test');
    expect(results.coachNamesById).toBeUndefined();
    expect(screen.getByText(/has no team to anchor in this division/)).toHaveTextContent(
      'Coach row.coach@coaches.test has no team to anchor in this division: Kid1 Placeholder1, their only child in it, is not eligible for the division.'
    );
  });
});

describe('TeamAnalysisPage :: a coach and their children, on the review (owner, 2026-10-27)', () => {
  beforeEach(resetOwnerDecisionState);
  afterEach(resetOwnerDecisionState);

  it('shows a coach whose only child is blocked, flagged, with the reason', async () => {
    // Kid1 is the seed's play-down (blocked); their coach has no other child, so no team.
    state.coachLinks = [link(COACH_A, 1)];
    state.coaches = [{ id: COACH_A, full_name: 'Casey Coach' }];
    await generate();

    const results = stagedResults();
    expect(teamsOf(results).map((team) => team.coachId)).not.toContain(COACH_A);
    expect(results.coachNamesById).toEqual({ [COACH_A]: 'Casey Coach' });
    const items = within(reviewList('Not placed')).getAllByRole('listitem');
    expect(items).toHaveLength(1);
    expect(items[0]).toHaveTextContent(
      'Kid1 Placeholder1. Not eligible for this division. Older than the division allows, and playing down is not permitted. Natural age 13. Coach Casey Coach has no team to anchor in this division: Kid1 Placeholder1, their only child in it, is not eligible for the division.'
    );
    expect(screen.getByText(/^U10: 1 not placed/)).toHaveTextContent(
      '1 coach with no team to anchor'
    );
    // A lone child is no sibling group.
    expect(
      screen.queryByRole('region', { name: 'Coaches with more than one child' })
    ).not.toBeInTheDocument();
    // Still there after a reload of the page, from the stored run.
    cleanup();
    render(
      <MemoryRouter>
        <TeamAnalysisPage />
      </MemoryRouter>
    );
    expect(
      await within(await screen.findByRole('region', { name: 'Not placed' })).findByText(
        /Coach Casey Coach has no team to anchor/
      )
    ).toBeInTheDocument();
  });

  it('a waitlisted only child leaves the coach with no team too, and says why', async () => {
    state.rows = state.rows.map((r) =>
      r.external_registration_id === 'REG-10' ? { ...r, waitlist: 'yes' } : r
    );
    state.coachLinks = [link(COACH_A, 10)];
    state.coaches = [{ id: COACH_A, full_name: 'Casey Coach' }];
    await generate();

    expect(teamsOf(stagedResults()).map((team) => team.coachId)).not.toContain(COACH_A);
    expect(screen.getByText(/Coach Casey Coach has no team to anchor/)).toHaveTextContent(
      'Kid10 Placeholder10, their only child in it, is on the waitlist.'
    );
  });

  it('says "name not loaded" rather than leave the coach out when the name is not found', async () => {
    state.coachLinks = [link(COACH_A, 1)];
    state.coaches = [];
    await generate();
    expect(
      screen.getByText(/A coach \(name not loaded\) has no team to anchor/)
    ).toBeInTheDocument();
  });

  it('a coach with a blocked child and a placed one anchors a team: not "no team", but a sibling flag, apart', async () => {
    state.coachLinks = [link(COACH_A, 1), link(COACH_A, 10)];
    state.coaches = [{ id: COACH_A, full_name: 'Casey Coach' }];
    await generate();

    const results = stagedResults();
    expect(teamOfPlayer(results, 10).coachId).toBe(COACH_A);
    expect(screen.queryByText(/has no team to anchor/)).not.toBeInTheDocument();
    const group = within(reviewList('Coaches with more than one child')).getAllByRole('listitem');
    expect(group).toHaveLength(1);
    expect(group[0]).toHaveTextContent(
      `Coach Casey Coach: Kid10 Placeholder10, on ${teamOfPlayer(results, 10).name}; Kid1 Placeholder1, not placed (not eligible for the division). They are not on the same team.`
    );
  });

  it('two children of one coach in a division land on the coach team, and the flag says so', async () => {
    // The generator's behaviour for a coach linked to two children of one division: both are
    // coach-anchored units, so both are seated on the coach's one team.
    state.coachLinks = [link(COACH_A, 10), link(COACH_A, 11)];
    state.coaches = [{ id: COACH_A, full_name: 'Casey Coach' }];
    await generate();

    const results = stagedResults();
    const coachTeams = teamsOf(results).filter((team) => team.coachId === COACH_A);
    expect(coachTeams).toHaveLength(1);
    expect(teamOfPlayer(results, 10).id).toBe(coachTeams[0].id);
    expect(teamOfPlayer(results, 11).id).toBe(coachTeams[0].id);
    const group = within(reviewList('Coaches with more than one child')).getAllByRole('listitem');
    expect(group).toHaveLength(1);
    expect(group[0]).toHaveTextContent(
      `Coach Casey Coach: Kid10 Placeholder10, on ${coachTeams[0].name}; Kid11 Placeholder11, on ${coachTeams[0].name}. They are on the same team.`
    );
    expect(screen.getByText(/^U10: 1 not placed/)).toHaveTextContent(
      '1 coach with more than one child in the division'
    );
  });

  it('no flag for two children who name each other as buddies (one unit)', async () => {
    // Real names: the resolver matches letters, and "Kid10" and "Kid11" read alike.
    const NAMES = { 'REG-10': ['Ana', 'Reyes'], 'REG-11': ['Ben', 'Reyes'] };
    const request = { 'REG-10': 'Ben Reyes', 'REG-11': 'Ana Reyes' };
    for (const list of [state.rows, state.durablePlayers]) {
      for (const entry of list) {
        const key = entry.external_registration_id;
        if (!NAMES[key]) continue;
        [entry.first_name, entry.last_name] = NAMES[key];
        entry.buddy_request = request[key];
      }
    }
    state.coachLinks = [link(COACH_A, 10), link(COACH_A, 11)];
    state.coaches = [{ id: COACH_A, full_name: 'Casey Coach' }];
    await generate();

    expect(
      screen.queryByRole('region', { name: 'Coaches with more than one child' })
    ).not.toBeInTheDocument();
    const results = stagedResults();
    expect(teamOfPlayer(results, 10).id).toBe(teamOfPlayer(results, 11).id);
    expect(teamOfPlayer(results, 10).coachId).toBe(COACH_A);
  });

  it('flags each coach on their own: two coaches with two children each', async () => {
    state.coachLinks = [link(COACH_A, 10), link(COACH_A, 11), link(COACH_B, 12), link(COACH_B, 13)];
    state.coaches = [
      { id: COACH_A, full_name: 'Casey Coach' },
      { id: COACH_B, full_name: 'Robin Coach' },
    ];
    await generate();
    const group = within(reviewList('Coaches with more than one child')).getAllByRole('listitem');
    expect(group).toHaveLength(2);
    expect(group.map((li) => li.textContent).join('\n')).toMatch(/Casey Coach.*\n.*Robin Coach/);
  });
});
