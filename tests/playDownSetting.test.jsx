/**
 * The Play-down setting on the Teams page (play-down plan, 2026-11-03, PR 3, tasks C2 and C3).
 *
 * Off unless an admin turns it on: a player registered in a younger division than their age plays in
 * their own age division; on, they play in the division they registered for, and are listed. The
 * setting is read the way the app reads it: a STORED value through `FeatureFlagSchema`, then the real
 * Teams page (the overview's advice, the settings panel, the pipeline and the generator are real; the
 * data hooks, Supabase and heavy children are stand-ins, as in `teamAnalysisPlayUp.test.jsx`).
 * Both uses of the setting are exercised in both states, because lesson 75 says an option is a gate
 * on every place that shows it and every place that uses it: the advice (how many players each
 * division is advised for) and generation (who is seated). Ages are counted in season 2026 by birth
 * year: born in 2016 is 10, in 2014 is 12.
 *
 * Every expected number is worked from the import below, never read back from the page: Jake is 12
 * and registered in U10. Off, he plays in U12 (U10 plays 8, U12 plays 9); on, he plays in U10 (U10
 * plays 9, U12 plays 8).
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { createChainMock } from './helpers/index.js';
import {
  FEATURE_DEFAULTS,
  FEATURE_FLAGS,
  FeatureFlagSchema,
} from '../frontend/src/constants/featureFlags.js';
import { PLAY_DOWN_FLAG } from '../packages/core/src/playUp.js';

const IDS = vi.hoisted(() => ({
  organization: '7f3e4d5c-6a71-4c8d-9e9f-1a2b3c4d5e31',
  season: '7f3e4d5c-6a71-4c8d-9e9f-1a2b3c4d5e32',
  division: '7f3e4d5c-6a71-4c8d-9e9f-1a2b3c4d5e33',
}));

const EMPTY_SNAPSHOT = { payload: { teamRows: [], teamPlayerRows: [] }, payloadByDivision: {} };
const state = vi.hoisted(() => ({
  /** @type {any[]} */
  rows: [],
  /** @type {any[]} */
  durablePlayers: [],
  /** @type {any} the organization's stored feature flags, as the database holds them */
  storedFlags: {},
  /** @type {any} the saved rosters the page reads back */
  snapshot: null,
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
    // What the app does: the stored JSONB through the schema.
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
    persistenceSnapshot: state.snapshot,
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
      createChainMock({
        data: table === 'players' ? state.durablePlayers : [],
        error: null,
      }),
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
vi.mock('../frontend/src/components/teaming/RosterManager.jsx', () => stub('roster-manager'));

const { default: TeamAnalysisPage } = await import('../frontend/src/pages/TeamAnalysisPage.jsx');

const REVIEW_KEY = `squadlogic:team-review:${IDS.organization}:${IDS.season}`;
const BORN_10 = '2016-05-01';
const BORN_12 = '2014-05-01';
const JAKE = 1;

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
const promote = (rows) =>
  rows.map((r, i) => ({
    id: `7f3e4d5c-6a71-4c8d-9e9f-${String(930000000000 + i)}`,
    external_registration_id: r.external_registration_id,
    division_id: IDS.division,
    first_name: r.first_name,
    last_name: r.last_name,
    preferred_name: null,
    buddy_request: null,
    mutual_buddy_code: null,
  }));
const idOf = (n) => state.durablePlayers.find((p) => p.external_registration_id === `REG-${n}`).id;

/** Jake first, so U10 is the program the page selects; eight in band in each division. */
const league = () => [
  row(JAKE, 'U10', BORN_12),
  ...fill('U10', BORN_10, 30, 8),
  ...fill('U12', BORN_12, 10, 8),
];

function reset() {
  cleanup();
  sessionStorage.clear();
  state.rows = league();
  state.durablePlayers = promote(state.rows);
  state.storedFlags = {};
  state.snapshot = EMPTY_SNAPSHOT;
}

async function openPage() {
  render(
    <MemoryRouter>
      <TeamAnalysisPage />
    </MemoryRouter>
  );
  await screen.findByRole('heading', { name: 'Division Overview' });
  await waitFor(() => expect(screen.getByRole('button', { name: /Generate Teams/ })).toBeEnabled());
}

async function generate() {
  await openPage();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /Generate Teams/ }));
  });
  await screen.findByText('Team Review Pending');
}

const stagedResults = () =>
  JSON.parse(sessionStorage.getItem(REVIEW_KEY) || 'null')?.snapshot?.runMetadata?.results;
const seatedIn = (results, division) =>
  (results.teamsByDivision[division] ?? []).flatMap((team) => team.players.map((p) => p.id));
const section = () => screen.getByRole('region', { name: 'Play-up' });
const sectionRow = (name) =>
  within(section())
    .getAllByRole('row')
    .find((tr) => within(tr).queryByText(name));

/** The overview's cell for a program, by its column header. */
function overviewCell(program, header) {
  const table = screen.getByRole('table', { name: 'Division Overview' });
  const headers = within(table)
    .getAllByRole('columnheader')
    .map((th) => th.textContent);
  const tr = screen.getByRole('button', { name: program }).closest('tr');
  return within(/** @type {HTMLElement} */ (tr)).getAllByRole('cell')[headers.indexOf(header)];
}

/** What the page persists for a run of one division: the saved roster a later run reads back. */
function savedRoster(division, results) {
  const teams = results.teamsByDivision[division];
  const teamRows = teams.map((team) => ({
    id: team.id,
    division,
    name: team.name,
    players: team.players.map((player) => ({ id: player.id })),
  }));
  const teamPlayerRows = teams.flatMap((team) =>
    team.players.map((player) => ({
      team_id: team.id,
      player_id: player.id,
      role: 'player',
      source: 'auto',
    }))
  );
  return {
    lastRunId: 'run-saved',
    runHistory: [{ status: 'review' }],
    payload: { teamRows, teamPlayerRows },
    payloadByDivision: { [division]: { teamRows, teamPlayerRows } },
  };
}

describe('the setting and its key', () => {
  it('is the registry key, and an absent key is off', () => {
    expect(FEATURE_FLAGS.PLAY_DOWN).toBe(PLAY_DOWN_FLAG);
    expect(PLAY_DOWN_FLAG).toBe('play_down');
    // No default: a flag that is absent is off (the guardians skill).
    expect(FEATURE_DEFAULTS).not.toHaveProperty(PLAY_DOWN_FLAG);
    expect(FeatureFlagSchema.parse({})).toEqual({});
    expect(FeatureFlagSchema.parse({ play_down: true })).toEqual({ play_down: true });
    expect(FeatureFlagSchema.parse({ play_down: 'true' })).toEqual({});
  });
});

describe('the Teams page reads the stored setting, in the advice and in generation', () => {
  beforeEach(reset);
  afterEach(reset);

  // What is stored, and whether the setting is on. A value that is not the boolean true is off.
  const STORED = [
    ['no key', {}, false],
    ['false', { play_down: false }, false],
    ['a string, which the schema refuses', { play_down: 'yes' }, false],
    ['true', { play_down: true }, true],
  ];

  describe.each(STORED)('stored as %s', (_label, stored, on) => {
    it(`advises ${on ? 'U10 for 9 and U12 for 8' : 'U10 for 8 and U12 for 9'}`, async () => {
      state.storedFlags = stored;
      await openPage();
      // Players: the file's nine in U10 and eight in U12, counted where each plays.
      expect(overviewCell('U10', 'Players')).toHaveTextContent(on ? /^9/ : /^8/);
      expect(overviewCell('U12', 'Players')).toHaveTextContent(on ? /^8/ : /^9/);
      if (on) {
        expect(overviewCell('U10', 'Players')).not.toHaveTextContent(/placed in their own age/);
        expect(overviewCell('U12', 'Players')).not.toHaveTextContent(/moved here/);
      } else {
        expect(overviewCell('U10', 'Players')).toHaveTextContent(
          '1 registered here, placed in their own age division'
        );
        expect(overviewCell('U12', 'Players')).toHaveTextContent('1 moved here from another');
      }
    });

    it(`generation seats Jake in ${on ? 'U10, the division he registered for' : 'U12, his own age division'}`, async () => {
      state.storedFlags = stored;
      await generate();
      const results = stagedResults();
      // The control: the in-band players of U10 are seated by their stored ids, so "Jake is not
      // here" below cannot be true of a run that seated nobody by that id.
      expect(seatedIn(results, 'U10')).toContain(idOf(30));
      expect(seatedIn(results, 'U10').includes(idOf(JAKE))).toBe(on);
      // Listed either way, and the row says where he plays.
      const listing = results.playUpByDivision.U10;
      expect(listing.map((e) => [e.name, e.kind, e.playedDivision])).toEqual([
        ['Kid1 Placeholder1', 'play-down', on ? 'U10' : 'U12'],
      ]);
      expect(sectionRow('Kid1 Placeholder1')).toHaveTextContent(
        on
          ? 'Plays in U10, the younger division they registered for.'
          : 'Registered in U10 but plays in U12.'
      );
    });
  });

  it('seats Jake in U12’s run when the setting is off, and not when it is on', async () => {
    for (const [stored, expected] of [
      [{}, true],
      [{ play_down: true }, false],
    ]) {
      reset();
      state.storedFlags = stored;
      await openPage();
      fireEvent.click(screen.getByRole('button', { name: 'U12' }));
      await act(async () => {
        fireEvent.click(await screen.findByRole('button', { name: /Generate Teams/ }));
      });
      await screen.findByText('Team Review Pending');
      expect(seatedIn(stagedResults(), 'U12')).toContain(idOf(10));
      expect(seatedIn(stagedResults(), 'U12').includes(idOf(JAKE))).toBe(expected);
    }
  });
});

describe('turning the setting off or on does not move a player off a roster that exists (C3)', () => {
  beforeEach(reset);
  afterEach(reset);

  it('off after on: Jake stays on the U10 team he is on, nothing is dropped, and he is flagged', async () => {
    // On: a first run seats him in U10, and that roster is saved.
    state.storedFlags = { play_down: true };
    await generate();
    const first = stagedResults();
    const teamId = first.teamsByDivision.U10.find((team) =>
      team.players.some((p) => p.id === idOf(JAKE))
    ).id;
    state.snapshot = savedRoster('U10', first);

    // Off: the rule would play him in U12, but the roster is reviewed and stays as it is.
    cleanup();
    sessionStorage.clear();
    state.storedFlags = { play_down: false };
    await generate();
    const again = stagedResults();
    expect(
      again.teamsByDivision.U10.find((team) => team.id === teamId).players.map((p) => p.id)
    ).toContain(idOf(JAKE));
    expect(again.changeDiagnosticsByDivision.U10.droppedPlayersRemoved).toBe(0);
    expect(sectionRow('Kid1 Placeholder1')).toHaveTextContent(
      'Stays on the roster they are on in U10: a team that exists is not reshuffled. A new roster would place them in U12.'
    );
    expect(again.playUpByDivision.U10[0]).toMatchObject({
      heldSeat: true,
      playedDivision: 'U10',
      ruleDivision: 'U12',
    });
  });

  it('the advice counts him where the roster holds him, not where the rule would play him', async () => {
    state.storedFlags = { play_down: true };
    await generate();
    state.snapshot = savedRoster('U10', stagedResults());
    cleanup();
    sessionStorage.clear();
    state.storedFlags = {};
    await openPage();
    // Off would play him in U12 (8 and 9); his roster is U10's, so the advice is the one the roster has.
    expect(overviewCell('U10', 'Players')).toHaveTextContent(/^9/);
    expect(overviewCell('U12', 'Players')).toHaveTextContent(/^8/);
  });

  it('without a saved roster, the same flip moves him (the setting is what decides)', async () => {
    state.storedFlags = {};
    await openPage();
    expect(overviewCell('U10', 'Players')).toHaveTextContent(/^8/);
    expect(overviewCell('U12', 'Players')).toHaveTextContent(/^9/);
  });
});
