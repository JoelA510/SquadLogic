/**
 * The teaming settings panel recommends a team count for the program and warns, before
 * generation, when the chosen count would leave teams over the maximum or under the minimum
 * roster (`assessTeamCount`, packages/core/src/rosterSizing.js). The generator computed these
 * diagnostics but nothing showed them. Phase B4 brings the advice to the program overview, with
 * the import's head coaches counted, and the run's outcome to the review.
 */
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TeamingConfiguration from '../frontend/src/components/teaming/TeamingConfiguration.jsx';
import { FeatureFlagSchema } from '../frontend/src/constants/featureFlags.js';
import { createChainMock } from './helpers/index.js';

const program = { id: 'u10-boys', name: 'U10 Boys', playerCount: 30, estimatedTeams: 3 };
const limits = { targetTeamSize: 12, minRosterSize: 10, maxRosterSize: 14 };

function renderPanel(config, onUpdate = vi.fn()) {
  render(
    <TeamingConfiguration program={program} config={config} onUpdate={onUpdate} onSave={vi.fn()} />
  );
  return onUpdate;
}

describe('TeamingConfiguration team-count advice', () => {
  it('shows the recommendation and no warning when the count fits', () => {
    renderPanel({ ...limits, teamCountOverride: 3 });
    expect(screen.getByTestId('team-count-recommendation')).toHaveTextContent(
      'Recommended: 3 teams for 30 players.'
    );
    expect(screen.queryByTestId('team-count-warnings')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Use 3' })).toBeNull();
  });

  it('says in a live region that generation will not use the override, and offers the fix', () => {
    const onUpdate = renderPanel({ ...limits, teamCountOverride: 4 });
    expect(screen.getByRole('status')).toHaveTextContent(
      'Generation will make 3 teams, not the 4 set here'
    );
    const use = screen.getByRole('button', { name: 'Use 3' });
    use.focus();
    fireEvent.click(use);
    expect(onUpdate).toHaveBeenCalledWith('u10-boys', { teamCountOverride: 3 });
    // The button disappears once applied; focus goes to the field it changed.
    expect(document.activeElement).toBe(screen.getByLabelText('Override Team Count'));
  });

  it('warns when the max-teams cap forces oversized teams, and never offers a count past the cap', () => {
    renderPanel({ ...limits, teamCountOverride: 2, maxTeams: 2 });
    expect(screen.getByRole('status')).toHaveTextContent(
      'With 2 teams, some teams will have 15 players, over the maximum of 14. The maximum of 2 teams prevents more.'
    );
    expect(screen.queryByRole('button', { name: /^Use / })).toBeNull();
  });

  it('stays quiet when the page already rejects the configuration', () => {
    renderPanel({ ...limits, minRosterSize: 14, maxRosterSize: 10 });
    expect(screen.queryByTestId('team-count-recommendation')).toBeNull();
    expect(screen.queryByTestId('team-count-warnings')).toBeNull();
  });
});

/*
 * Phase B4 on the Teams page itself: the page is real, and so are the overview, the settings
 * panel, the pipeline and the generator; its data hooks and Supabase are stand-ins, as in
 * `teamAnalysisEligibility.test.jsx`. Every expected count is worked out from the import and
 * the limits the test sets, never read back from the page.
 */
const IDS = vi.hoisted(() => ({
  organization: '6e2d3c4b-5f60-4b7c-9d8e-0f1a2b3c4d21',
  season: '6e2d3c4b-5f60-4b7c-9d8e-0f1a2b3c4d22',
  division: '6e2d3c4b-5f60-4b7c-9d8e-0f1a2b3c4d23',
}));

const page = vi.hoisted(() => ({
  /** @type {any[]} */
  rows: [],
  /** @type {any[]} the saved `divisions` rows */
  divisions: [],
  /** @type {any[]} the season's `programs` rows */
  programs: [],
  /** @type {any[]} every `admin_upsert_division_settings` call's params */
  saves: [],
  /** @type {any[]} the stored `players` rows the page's lookups return */
  players: [],
  /** @type {any} the error the `players` reads return */
  playersError: null,
  /** how many times the page read `players` */
  playerReads: 0,
  /** @type {null | Promise<void>} while set, the `divisions` read waits for it */
  divisionsGate: null,
  /** @type {any} the error the `divisions` read returns */
  divisionsError: null,
  /** @type {any} the organization's stored feature flags, parsed by the schema */
  flags: {},
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
    featureFlags: FeatureFlagSchema.parse(page.flags),
  }),
}));
vi.mock('../frontend/src/contexts/ImportContext.jsx', () => ({
  useImport: () => ({ importedData: { data: page.rows } }),
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
vi.mock('../frontend/src/config.js', async (importOriginal) => ({
  .../** @type {any} */ (await importOriginal()),
  // Mock mode: generation may use import rows that no durable player matches.
  IS_MOCK_MODE: true,
}));
vi.mock('../frontend/src/lib/supabaseClient.js', () => ({
  supabase: {
    from: (table) => {
      if (table === 'players') {
        page.playerReads += 1;
        return createChainMock(
          page.playersError
            ? { data: null, error: page.playersError }
            : { data: page.players, error: null }
        );
      }
      const chain = createChainMock(
        table === 'divisions' && page.divisionsError
          ? { data: null, error: page.divisionsError }
          : {
              data:
                table === 'divisions' ? page.divisions : table === 'programs' ? page.programs : [],
              error: null,
            }
      );
      if (table === 'divisions' && page.divisionsGate) {
        // Held back until the test lets the season's divisions arrive.
        const gate = page.divisionsGate;
        chain.then = (...args) =>
          gate.then(() => ({ data: page.divisions, error: null })).then(...args);
      }
      return chain;
    },
    rpc: async (name, params) => {
      if (name !== 'admin_upsert_division_settings') return { data: null, error: null };
      page.saves.push(params);
      // The RPC returns the whole division row, its age band and gender included.
      const existing =
        page.divisions.find(
          (row) => row.id === params.p_division_id || row.name === params.p_name
        ) ?? {};
      return {
        data: {
          min_age: existing.min_age ?? null,
          max_age: existing.max_age ?? null,
          gender_policy: existing.gender_policy ?? null,
          birthdate_start: existing.birthdate_start ?? null,
          birthdate_end: existing.birthdate_end ?? null,
          id: params.p_division_id || `${IDS.division}-${params.p_name}`,
          organization_id: IDS.organization,
          season_settings_id: IDS.season,
          name: params.p_name,
          max_roster_size: params.p_max_roster_size,
          min_roster_size: params.p_min_roster_size,
          target_team_size: params.p_target_team_size,
          team_count_override: params.p_team_count_override,
          min_teams: params.p_min_teams,
          max_teams: params.p_max_teams,
          ...(typeof params.p_plays_games === 'boolean'
            ? { plays_games: params.p_plays_games }
            : {}),
        },
        error: null,
      };
    },
  },
}));
const stub = (name) => ({ default: () => <div data-testid={`stub-${name}`} /> });
vi.mock('../frontend/src/components/TeamPersistencePanel.jsx', () => stub('persistence'));
vi.mock('../frontend/src/components/TeamOverviewPanel.jsx', () => stub('team-overview'));
vi.mock('../frontend/src/components/teaming/RosterManager.jsx', () => stub('roster-manager'));

const { default: TeamAnalysisPage } = await import('../frontend/src/pages/TeamAnalysisPage.jsx');

/** An import row in a program (the canonical `division_name` key), placeholder names only. */
const importRow = (program, n, extra = {}) => ({
  external_registration_id: `${program}-REG-${n}`,
  first_name: `Kid${n}`,
  last_name: `Placeholder${n}`,
  division_name: program,
  ...extra,
});
/** @type {(program: string, count: number, extra?: (index: number) => object) => any[]} */
const importRows = (program, count, extra = () => ({})) =>
  Array.from({ length: count }, (_, i) => importRow(program, i + 1, extra(i)));

/** A saved division row for a program, as `divisions` returns it. */
const savedDivision = (name, rules) => ({
  id: `${IDS.division}-${name}`,
  organization_id: IDS.organization,
  season_settings_id: IDS.season,
  name,
  target_team_size: 12,
  min_roster_size: 10,
  max_roster_size: 14,
  team_count_override: null,
  min_teams: null,
  max_teams: null,
  ...rules,
});

async function renderPage() {
  render(
    <MemoryRouter>
      <TeamAnalysisPage />
    </MemoryRouter>
  );
  await screen.findByRole('heading', { name: 'Division Overview' });
  // The rules load from `divisions` (saved, or the defaults) before the panel shows them.
  await waitFor(() => expect(screen.getByLabelText('Max Roster')).not.toHaveValue(null));
}

/** The overview's row for a program, found by its button. */
const overviewRow = (program) =>
  /** @type {HTMLElement} */ (screen.getByRole('button', { name: program }).closest('tr'));
/** A cell of that row, by its column header. */
function overviewCell(program, header) {
  // Only the overview's own headers: a banner above it can carry a table of its own.
  const table = screen.getByRole('table', { name: 'Division Overview' });
  const headers = within(table)
    .getAllByRole('columnheader')
    .map((th) => th.textContent);
  return within(overviewRow(program)).getAllByRole('cell')[headers.indexOf(header)];
}

describe('Team counts per program on the Teams page (Phase B4)', () => {
  beforeEach(() => {
    page.rows = [];
    page.divisions = [];
    page.saves = [];
    sessionStorage.clear();
  });
  afterEach(() => cleanup());

  it('does not raise the recommendation for a coach an import row names: only links anchor', async () => {
    // Twenty-four players, recommended ceil(24 / 12) = 2 teams. Four rows name a coach by email
    // (three distinct) and a fifth is a coaching lead: none adds a team. Before owner decision 8a
    // (2026-10-27) the three coaches made it three teams; now a coach anchors a team only through
    // a `coach_team_requests` link, which is read at generation, not with the import's rows.
    const coachOf = ['a@coaches.test', 'b@coaches.test', 'c@coaches.test', 'c@coaches.test'];
    page.rows = importRows('U10', 24, (i) =>
      i < coachOf.length ? { coach_email: coachOf[i] } : i === 4 ? { willing_to_coach: 'yes' } : {}
    );
    page.divisions = [savedDivision('U10')];
    await renderPage();

    const expected = Math.ceil(24 / 12);
    expect(expected).toBe(2);
    expect(screen.getByTestId('team-count-recommendation')).toHaveTextContent(
      `Recommended: ${expected} teams for 24 players`
    );
    expect(screen.getByTestId('team-count-recommendation')).not.toHaveTextContent(
      /and \d+ head coach/
    );
    expect(overviewCell('U10', 'Recommended')).toHaveTextContent(String(expected));
    expect(overviewCell('U10', 'Est. Teams')).toHaveTextContent(String(expected));
  });

  it('shows a warning status for a program that cannot fit its limits, and none says "Ready"', async () => {
    // U10: 30 players, at most 2 teams of at most 14: 15 on a team. U12: 24 players fit 2 x 12.
    page.rows = [...importRows('U10', 30), ...importRows('U12', 24)];
    page.divisions = [savedDivision('U10', { max_teams: 2 }), savedDivision('U12')];
    expect(Math.ceil(30 / 2)).toBeGreaterThan(14);
    await renderPage();

    // The saved rules load after the first render.
    await waitFor(() =>
      expect(overviewCell('U10', 'Status')).toHaveTextContent('Teams over the maximum')
    );
    expect(overviewCell('U12', 'Status')).toHaveTextContent('Fits the limits');
    expect(screen.queryByText('Ready')).toBeNull();
  });

  it('gives no estimate for rules generation would refuse, and says they need fixing', async () => {
    page.rows = importRows('U10', 30);
    await renderPage();
    expect(overviewCell('U10', 'Est. Teams')).toHaveTextContent(String(Math.ceil(30 / 12)));
    // The admin clears the maximum roster, which generation requires.
    fireEvent.change(screen.getByLabelText('Max Roster'), { target: { value: '' } });
    await waitFor(() =>
      expect(overviewCell('U10', 'Status')).toHaveTextContent('Settings need fixing')
    );
    expect(overviewCell('U10', 'Est. Teams')).toHaveTextContent('—');
    expect(overviewCell('U10', 'Recommended')).toHaveTextContent('—');
  });

  it('makes each program a button in its row, so it can be chosen from the keyboard', async () => {
    page.rows = [...importRows('U10', 12), ...importRows('U12', 12)];
    await renderPage();
    expect(screen.getByRole('heading', { name: 'U10 Settings' })).toBeInTheDocument();

    const u12 = screen.getByRole('button', { name: 'U12' });
    expect(u12.tagName).toBe('BUTTON');
    expect(u12).toHaveAttribute('type', 'button');
    expect(u12).not.toHaveAttribute('tabindex', '-1');
    expect(u12).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('button', { name: 'U10' })).toHaveAttribute('aria-current', 'true');
    // A native button: Enter and Space activate it as a click (the browser's, in the e2e).
    u12.focus();
    expect(document.activeElement).toBe(u12);
    fireEvent.click(u12);
    expect(await screen.findByRole('heading', { name: 'U12 Settings' })).toBeInTheDocument();
    expect(u12).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('button', { name: 'U10' })).not.toHaveAttribute('aria-current');
    // Still a table: the button sits in the row's first cell.
    expect(u12.closest('td')).toBe(within(overviewRow('U12')).getAllByRole('cell')[0]);
  });

  it('starts a new program on Auto, and generation saves no override', async () => {
    page.rows = importRows('U10', 30);
    await renderPage();
    const override = screen.getByLabelText('Override Team Count');
    expect(override).toHaveValue(null);
    expect(override).toHaveAttribute('placeholder', 'Auto');

    const generate = screen.getByRole('button', { name: /Generate Teams/ });
    await waitFor(() => expect(generate).toBeEnabled());
    await act(async () => {
      fireEvent.click(generate);
    });
    await screen.findByText('Team Review Pending');
    expect(page.saves).toHaveLength(1);
    expect(page.saves[0].p_team_count_override).toBeNull();
    expect(
      screen.getByText(`Team review staged: ${Math.ceil(30 / 12)} teams.`, { exact: false })
    ).toBeInTheDocument();
  });

  it('keeps a saved override, with the recommendation and "Use N" beside it', async () => {
    page.rows = importRows('U10', 30);
    page.divisions = [savedDivision('U10', { team_count_override: 2 })];
    // Thirty players at a target of 12: 3 recommended; the saved 2 fits (15 each is over 14,
    // so generation makes 3: the override is kept, and the panel says it will not be used).
    const recommended = Math.ceil(30 / 12);
    await renderPage();
    await waitFor(() => expect(screen.getByLabelText('Override Team Count')).toHaveValue(2));
    expect(screen.getByTestId('team-count-recommendation')).toHaveTextContent(
      `Recommended: ${recommended} teams for 30 players`
    );
    expect(screen.getByRole('button', { name: `Use ${recommended}` })).toBeInTheDocument();
    expect(overviewCell('U10', 'Recommended')).toHaveTextContent(String(recommended));
    expect(overviewCell('U10', 'Status')).toHaveTextContent('Override not used');

    const generate = screen.getByRole('button', { name: /Generate Teams/ });
    await waitFor(() => expect(generate).toBeEnabled());
    await act(async () => {
      fireEvent.click(generate);
    });
    await screen.findByText('Team Review Pending');
    expect(page.saves[0].p_team_count_override).toBe(2);
  });

  it('shows, beside the counts, a team the run left under the minimum roster', async () => {
    // Six players and a minimum roster of ten: the one team is short by four.
    page.rows = importRows('U10', 6);
    page.divisions = [savedDivision('U10')];
    await renderPage();
    const generate = screen.getByRole('button', { name: /Generate Teams/ });
    await waitFor(() => expect(generate).toBeEnabled());
    await act(async () => {
      fireEvent.click(generate);
    });
    const sizes = await screen.findByRole('region', { name: 'Team sizes' });
    expect(sizes).toHaveTextContent('U10: 1 team, 6 players placed. Rosters of 10 to 14 players.');
    expect(within(sizes).getByRole('list', { name: 'U10 team-size warnings' })).toHaveTextContent(
      /1 team under the minimum of 10: .+ \(6 players\)\./
    );
    expect(
      screen
        .getAllByRole('status')
        .map((node) => node.textContent)
        .join(' ')
    ).toContain('Team sizes: 1 team under the minimum roster.');
  });
});

/*
 * Follow-ups F1, item 3 (docs/changes/2026-11-01-followups-f1.md): the advice counted every
 * registered player, waitlisted ones too, while generation seats only the others. Every count is
 * worked out here from the rows and the limits (target 12, minimum 10, maximum 14), never read
 * back from the page; the last test of the group runs the real generator on the same rows.
 */
describe('The waitlisted are left out of the advice (follow-ups F1)', () => {
  const resetWaitlistState = () => {
    page.rows = [];
    page.divisions = [];
    page.saves = [];
    page.players = [];
    page.playersError = null;
    page.playerReads = 0;
    page.flags = {};
    sessionStorage.clear();
  };
  beforeEach(resetWaitlistState);
  afterEach(() => {
    cleanup();
    resetWaitlistState();
    vi.restoreAllMocks();
  });

  /** The stored player of an import row, as `finalize_import_job` keeps it. */
  const stored = (program, n, status) => ({
    id: `${IDS.division}-player-${n}`,
    external_registration_id: `${program}-REG-${n}`,
    division_id: `${IDS.division}-${program}`,
    first_name: `Kid${n}`,
    last_name: `Placeholder${n}`,
    status,
  });

  it('recommends for the players generation seats, and says how many are on the waitlist', async () => {
    // Thirty registered, six marked on the waitlist by the file: 24 are seated, so
    // ceil(24 / 12) = 2 teams. Counting all thirty gives ceil(30 / 12) = 3.
    page.rows = importRows('U10', 30, (i) => (i < 6 ? { waitlist: 'yes' } : {}));
    page.divisions = [savedDivision('U10')];
    expect(Math.ceil(24 / 12)).toBe(2);
    expect(Math.ceil(30 / 12)).toBe(3);
    await renderPage();

    await waitFor(() =>
      expect(screen.getByTestId('team-count-recommendation')).toHaveTextContent(
        'Recommended: 2 teams for 24 players'
      )
    );
    expect(screen.getByTestId('team-count-recommendation')).toHaveTextContent(
      '6 on the waitlist are not counted'
    );
    expect(overviewCell('U10', 'Players')).toHaveTextContent('24');
    expect(overviewCell('U10', 'Players')).toHaveTextContent('6 on the waitlist');
    expect(overviewCell('U10', 'Recommended')).toHaveTextContent('2');
    expect(overviewCell('U10', 'Est. Teams')).toHaveTextContent('2');
    expect(overviewCell('U10', 'Avg Roster')).toHaveTextContent('12');
  });

  it('takes the stored status over the file, as generation does (a buddy taken off the waitlist)', async () => {
    // The file marks two players; the record has since made both active (taken off the waitlist and
    // saved). Thirty are seated: ceil(30 / 12) = 3 teams, and 3 is also what the maximum roster of
    // 14 needs (ceil(30 / 14) = 3). Reading the file alone would say 28 seated: the minimum roster of
    // 10 allows floor(28 / 10) = 2 teams and the maximum needs ceil(28 / 14) = 2, so 2.
    page.rows = importRows('U10', 30, (i) => (i < 2 ? { waitlist: 'yes' } : {}));
    page.divisions = [savedDivision('U10')];
    page.players = [stored('U10', 1, 'active'), stored('U10', 2, 'active')];
    await renderPage();

    await waitFor(() => expect(page.playerReads).toBeGreaterThan(0));
    await waitFor(() =>
      expect(screen.getByTestId('team-count-recommendation')).toHaveTextContent(
        'Recommended: 3 teams for 30 players'
      )
    );
    expect(screen.getByTestId('team-count-recommendation')).not.toHaveTextContent('waitlist');
    expect(overviewCell('U10', 'Players')).toHaveTextContent(/^30$/);
  });

  it('counts a player the record put on the waitlist, whatever the file says', async () => {
    // Nobody is marked in the file; the record holds two of the thirty on the waitlist. Registered,
    // 30 is 3 teams; seated, 28 is 2 (see above): two players are the difference.
    page.rows = importRows('U10', 30);
    page.divisions = [savedDivision('U10')];
    page.players = [stored('U10', 7, 'waitlist'), stored('U10', 8, 'waitlist')];
    await renderPage();

    await waitFor(() =>
      expect(screen.getByTestId('team-count-recommendation')).toHaveTextContent(
        'Recommended: 2 teams for 28 players (2 on the waitlist are not counted)'
      )
    );
    expect(overviewCell('U10', 'Players')).toHaveTextContent('2 on the waitlist');
  });

  it('a program whose registrants are all waitlisted advises no team, as generation builds none', async () => {
    page.rows = [...importRows('U10', 12, () => ({ waitlist: 'yes' })), ...importRows('U12', 24)];
    page.divisions = [savedDivision('U10'), savedDivision('U12')];
    await renderPage();

    await waitFor(() =>
      expect(overviewCell('U10', 'Status')).toHaveTextContent('All on the waitlist')
    );
    expect(overviewCell('U10', 'Players')).toHaveTextContent(/^0\s*12 on the waitlist$/);
    expect(overviewCell('U10', 'Est. Teams')).toHaveTextContent(/^0$/);
    expect(overviewCell('U10', 'Recommended')).toHaveTextContent('—');
    expect(overviewCell('U10', 'Avg Roster')).toHaveTextContent(/^0$/);
    expect(overviewRow('U10')).not.toHaveTextContent('Fits the limits');
    // The program beside it is advised as ever (24 at a target of 12 is 2 teams of 12).
    expect(overviewCell('U12', 'Recommended')).toHaveTextContent('2');
    expect(overviewCell('U12', 'Status')).toHaveTextContent('Fits the limits');
  });

  it('with the Waitlist option off counts every player, whatever status the record holds', async () => {
    page.flags = { waitlist: false };
    page.rows = importRows('U10', 30, (i) => (i < 6 ? { waitlist: 'yes' } : {}));
    page.divisions = [savedDivision('U10')];
    page.players = [stored('U10', 7, 'waitlist')];
    await renderPage();

    expect(screen.getByTestId('team-count-recommendation')).toHaveTextContent(
      'Recommended: 3 teams for 30 players'
    );
    expect(screen.getByTestId('team-count-recommendation')).not.toHaveTextContent('waitlist');
    expect(overviewCell('U10', 'Players')).toHaveTextContent(/^30$/);
    // The stored players are read once either way now (the record decides who a division can hold,
    // data follow-ups item 2), but their status is not looked at with the option off.
    await waitFor(() => expect(page.playerReads).toBeGreaterThan(0));
    expect(screen.getByTestId('team-count-recommendation')).not.toHaveTextContent('waitlist');
  });

  it('a program with nobody waitlisted reads exactly as before', async () => {
    page.rows = importRows('U10', 30);
    page.divisions = [savedDivision('U10')];
    await renderPage();
    expect(screen.getByTestId('team-count-recommendation')).toHaveTextContent(
      /^Recommended: 3 teams for 30 players\. Each volunteer head coach gets a team, which can add more\.$/
    );
    expect(overviewCell('U10', 'Players')).toHaveTextContent(/^30$/);
  });

  it('falls back to the file when the stored status cannot be read, and logs it', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    page.playersError = { message: 'permission denied for table players', code: '42501' };
    page.rows = importRows('U10', 30, (i) => (i < 6 ? { waitlist: 'yes' } : {}));
    page.divisions = [savedDivision('U10')];
    await renderPage();

    await waitFor(() => expect(page.playerReads).toBeGreaterThan(0));
    await waitFor(() =>
      expect(error.mock.calls.map((call) => call.map(String).join(' ')).join('\n')).toMatch(
        /stored players.*permission denied for table players/i
      )
    );
    expect(screen.getByTestId('team-count-recommendation')).toHaveTextContent(
      'Recommended: 2 teams for 24 players'
    );
  });

  it('agrees with what generation makes on the same rows', async () => {
    page.rows = importRows('U10', 30, (i) => (i < 6 ? { waitlist: 'yes' } : {}));
    page.divisions = [savedDivision('U10')];
    await renderPage();
    await waitFor(() =>
      expect(screen.getByTestId('team-count-recommendation')).toHaveTextContent(
        'Recommended: 2 teams for 24 players'
      )
    );
    const generate = screen.getByRole('button', { name: /Generate Teams/ });
    await waitFor(() => expect(generate).toBeEnabled());
    await act(async () => {
      fireEvent.click(generate);
    });
    await screen.findByText('Team Review Pending');
    expect(screen.getByText('Team review staged: 2 teams.', { exact: false })).toBeInTheDocument();
  });
});

/*
 * Data follow-ups, item 2 (docs/changes/2026-11-02-data-followups.md): the advice also counted the
 * players no division can hold, whom generation seats nowhere (`isEligibilityBlocked`, B2). They are
 * left out the way the waitlisted are. A division's band is explicit here (U10 holds ages 9 to 10,
 * U12 holds 11 to 12), a player's age is the row's `natural_age`, and every expected count is worked
 * out from the rows and the limits (target 12, minimum 10, maximum 14: 24 players are 2 teams, 28
 * are 2, 30 are 3), never read back from the page.
 */
describe('The players no division can hold are left out of the advice (data follow-ups)', () => {
  const resetState = () => {
    page.rows = [];
    page.divisions = [];
    page.saves = [];
    page.players = [];
    page.playersError = null;
    page.playerReads = 0;
    page.divisionsGate = null;
    page.divisionsError = null;
    page.flags = {};
    sessionStorage.clear();
  };
  beforeEach(resetState);
  afterEach(() => {
    cleanup();
    resetState();
    vi.restoreAllMocks();
  });

  const U10 = () => savedDivision('U10', { min_age: 9, max_age: 10 });
  const U12 = () => savedDivision('U12', { min_age: 11, max_age: 12 });
  /** Older than every division here: nobody holds a 14-year-old. */
  const TOO_OLD = 14;
  /** The stored player of an import row, as `finalize_import_job` keeps it. */
  const stored = (program, n, fields) => ({
    id: `${IDS.division}-player-${n}`,
    external_registration_id: `${program}-REG-${n}`,
    division_id: `${IDS.division}-${program}`,
    first_name: `Kid${n}`,
    last_name: `Placeholder${n}`,
    ...fields,
  });

  it('recommends for the players a division can hold, and says how many are not eligible', async () => {
    // Thirty registered in U10 (ages 9 to 10), six of them 14: no division holds a 14-year-old, so
    // 24 are seated, ceil(24 / 12) = 2 teams. Counting all thirty gives ceil(30 / 12) = 3.
    page.rows = importRows('U10', 30, (i) => ({ natural_age: i < 6 ? TOO_OLD : 9 }));
    page.divisions = [U10()];
    expect(Math.ceil(24 / 12)).toBe(2);
    expect(Math.ceil(30 / 12)).toBe(3);
    await renderPage();

    await waitFor(() =>
      expect(screen.getByTestId('team-count-recommendation')).toHaveTextContent(
        'Recommended: 2 teams for 24 players (6 not eligible for the division are not counted)'
      )
    );
    expect(overviewCell('U10', 'Players')).toHaveTextContent(/^24\s*6 not eligible$/);
    expect(overviewCell('U10', 'Recommended')).toHaveTextContent('2');
    expect(overviewCell('U10', 'Est. Teams')).toHaveTextContent('2');
    expect(overviewCell('U10', 'Avg Roster')).toHaveTextContent('12');
  });

  it('agrees with what generation makes on the same rows, and with who it does not place', async () => {
    page.rows = importRows('U10', 30, (i) => ({ natural_age: i < 6 ? TOO_OLD : 9 }));
    page.divisions = [U10()];
    await renderPage();
    await waitFor(() =>
      expect(screen.getByTestId('team-count-recommendation')).toHaveTextContent(
        'Recommended: 2 teams for 24 players'
      )
    );
    const generate = screen.getByRole('button', { name: /Generate Teams/ });
    await waitFor(() => expect(generate).toBeEnabled());
    await act(async () => {
      fireEvent.click(generate);
    });
    await screen.findByText('Team Review Pending');
    expect(screen.getByText('Team review staged: 2 teams.', { exact: false })).toBeInTheDocument();
    // The six the advice left out are the six the run did not place for want of a division.
    expect(
      screen.getByText(/U10: 6 not placed \(6 not eligible for the division/, { exact: false })
    ).toBeInTheDocument();
  });

  it('takes the record over the file: a play-up the record requests is seated, as generation seats it', async () => {
    // The file shows two 4-year-olds in U10: below its band and below every division, so not eligible
    // by the file alone (28 seated, 2 teams). The record has the play-up requested for both, so they
    // stay in the division they registered for and are seated: 30, 3 teams.
    page.rows = importRows('U10', 30, (i) => ({ natural_age: i < 2 ? 4 : 9 }));
    page.divisions = [U10()];
    page.players = [
      stored('U10', 1, { natural_age: 4, play_up_requested: true }),
      stored('U10', 2, { natural_age: 4, play_up_requested: true }),
    ];
    await renderPage();

    await waitFor(() =>
      expect(screen.getByTestId('team-count-recommendation')).toHaveTextContent(
        'Recommended: 3 teams for 30 players'
      )
    );
    expect(screen.getByTestId('team-count-recommendation')).not.toHaveTextContent('not eligible');
    expect(overviewCell('U10', 'Players')).toHaveTextContent(/^30$/);
  });

  it("takes the record's age over the file's: a player the record makes too old is left out", async () => {
    // The file says all thirty are 9. The record has two of them at 14 (an admin corrected the age):
    // no division holds them, so 28 are seated and the advice is 2 teams, not the 3 that 30 gives.
    page.rows = importRows('U10', 30, () => ({ natural_age: 9 }));
    page.divisions = [U10()];
    page.players = [
      stored('U10', 7, { natural_age: TOO_OLD }),
      stored('U10', 8, { natural_age: TOO_OLD }),
    ];
    await renderPage();

    await waitFor(() =>
      expect(screen.getByTestId('team-count-recommendation')).toHaveTextContent(
        'Recommended: 2 teams for 28 players (2 not eligible for the division are not counted)'
      )
    );
    expect(overviewCell('U10', 'Players')).toHaveTextContent(/^28\s*2 not eligible$/);
  });

  it('counts a player both waitlisted and not eligible once, as not eligible', async () => {
    // Thirty-six in U10: 2 waitlisted and too old, 4 waitlisted only, 6 too old only, 24 seated
    // (2 teams of 12). Counted once as not eligible: 8 not eligible (2 + 6) and 4 on the waitlist.
    // Counted as waitlisted instead it would read 6 and 6; counted in both, 6 and 8.
    page.rows = importRows('U10', 36, (i) => ({
      natural_age: i < 2 || (i >= 6 && i < 12) ? TOO_OLD : 9,
      ...(i < 6 ? { waitlist: 'yes' } : {}),
    }));
    page.divisions = [U10()];
    await renderPage();

    await waitFor(() =>
      expect(screen.getByTestId('team-count-recommendation')).toHaveTextContent(
        'Recommended: 2 teams for 24 players (4 on the waitlist and 8 not eligible for the division are not counted)'
      )
    );
    expect(overviewCell('U10', 'Players')).toHaveTextContent(
      /^24\s*4 on the waitlist\s*8 not eligible$/
    );
  });

  it('a program with nobody left to seat advises no team, and says why', async () => {
    // U10: all twelve too old. U12: six 11-year-olds in band, all waitlisted, beside six too old, so
    // nobody is left to seat of either kind.
    page.rows = [
      ...importRows('U10', 12, () => ({ natural_age: TOO_OLD })),
      ...importRows('U12', 12, (i) =>
        i < 6 ? { natural_age: 11, waitlist: 'yes' } : { natural_age: TOO_OLD }
      ),
    ];
    page.divisions = [U10(), U12()];
    await renderPage();

    await waitFor(() => expect(overviewCell('U10', 'Status')).toHaveTextContent('None eligible'));
    expect(overviewCell('U10', 'Players')).toHaveTextContent(/^0\s*12 not eligible$/);
    expect(overviewCell('U10', 'Est. Teams')).toHaveTextContent(/^0$/);
    expect(overviewCell('U10', 'Recommended')).toHaveTextContent('—');
    expect(overviewCell('U10', 'Avg Roster')).toHaveTextContent(/^0$/);
    expect(overviewRow('U10')).not.toHaveTextContent('Fits the limits');

    expect(overviewCell('U12', 'Status')).toHaveTextContent('Nobody to seat');
    expect(overviewCell('U12', 'Players')).toHaveTextContent(
      /^0\s*6 on the waitlist\s*6 not eligible$/
    );
    expect(overviewCell('U12', 'Est. Teams')).toHaveTextContent(/^0$/);
  });

  it('does not call a player not eligible who another division can hold', async () => {
    // Six of the thirty are 11: too old for U10, but U12 holds them, so they play there and are not
    // "not eligible". The advice counts them where they play (play-down plan, PR 1): U10 seats 24
    // (2 teams: 24 fit two of 12), and U12, which the file has no registrants in, seats the six.
    page.rows = importRows('U10', 30, (i) => ({ natural_age: i < 6 ? 11 : 9 }));
    page.divisions = [U10(), U12()];
    await renderPage();

    await waitFor(() =>
      expect(screen.getByTestId('team-count-recommendation')).toHaveTextContent(
        'Recommended: 2 teams for 24 players'
      )
    );
    expect(overviewCell('U10', 'Players')).toHaveTextContent(
      /^24\s*6 registered here, placed in their own age division$/
    );
    expect(overviewCell('U12', 'Players')).toHaveTextContent(
      /^6\s*6 moved here from other divisions$/
    );
    expect(screen.queryByText(/not eligible/)).toBeNull();
  });

  it('counts everyone until the season’s divisions arrive, then leaves the not-eligible out', async () => {
    let release = () => {};
    page.divisionsGate = new Promise((resolve) => {
      release = resolve;
    });
    page.rows = importRows('U10', 30, (i) => ({ natural_age: i < 6 ? TOO_OLD : 9 }));
    page.divisions = [U10()];
    render(
      <MemoryRouter>
        <TeamAnalysisPage />
      </MemoryRouter>
    );
    await screen.findByRole('heading', { name: 'Division Overview' });
    // The divisions are still being read: nothing can be judged yet, so the advice is as it was.
    await waitFor(() => expect(page.playerReads).toBeGreaterThan(0));
    expect(overviewCell('U10', 'Players')).toHaveTextContent(/^30$/);
    expect(screen.queryByText(/not eligible/)).toBeNull();

    await act(async () => {
      release();
    });
    await waitFor(() =>
      expect(overviewCell('U10', 'Players')).toHaveTextContent(/^24\s*6 not eligible$/)
    );
  });

  it('leaves nobody out when the season\u2019s divisions cannot be read, whatever a name would imply', async () => {
    // The read is refused. The saved band (U10 holds 9 to 10) is unknown, and a band guessed from the
    // name "U10" is 10 alone, which would call every 9-year-old too young and the whole division "None
    // eligible". A failed read is not an empty season: the advice is what it was before this change.
    page.divisionsError = { message: 'permission denied for table divisions', code: '42501' };
    page.rows = importRows('U10', 30, () => ({ natural_age: 9 }));
    page.divisions = [U10()];
    await renderPage();

    expect(await screen.findByText(/permission denied for table divisions/)).toBeInTheDocument();
    expect(screen.getByTestId('team-count-recommendation')).toHaveTextContent(
      /^Recommended: 3 teams for 30 players\. Each volunteer head coach gets a team, which can add more\.$/
    );
    expect(overviewCell('U10', 'Players')).toHaveTextContent(/^30$/);
    expect(overviewCell('U10', 'Status')).not.toHaveTextContent('None eligible');
    expect(screen.queryByText(/not eligible/)).toBeNull();
  });

  it('still judges by the name when the read succeeds and the season has no divisions', async () => {
    // An empty season is a read that worked: a division with no saved row is held to the band its name
    // gives (U10 is 10), as generation holds it. Thirty registered: six aged 14, whom nothing holds, and
    // twenty-four aged 10.
    page.rows = importRows('U10', 30, (i) => ({ natural_age: i < 6 ? TOO_OLD : 10 }));
    page.divisions = [];
    await renderPage();

    await waitFor(() =>
      expect(screen.getByTestId('team-count-recommendation')).toHaveTextContent(
        'Recommended: 2 teams for 24 players (6 not eligible for the division are not counted)'
      )
    );
    expect(overviewCell('U10', 'Players')).toHaveTextContent(/^24\s*6 not eligible$/);
  });

  it('falls back to the file when the stored players cannot be read, and logs it', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    page.playersError = { message: 'permission denied for table players', code: '42501' };
    page.rows = importRows('U10', 30, (i) => ({ natural_age: i < 6 ? TOO_OLD : 9 }));
    page.divisions = [U10()];
    await renderPage();

    await waitFor(() => expect(page.playerReads).toBeGreaterThan(0));
    await waitFor(() =>
      expect(error.mock.calls.map((call) => call.map(String).join(' ')).join('\n')).toMatch(
        /stored players.*permission denied for table players/i
      )
    );
    // The file's own ages still leave the six out.
    expect(screen.getByTestId('team-count-recommendation')).toHaveTextContent(
      'Recommended: 2 teams for 24 players'
    );
  });

  it('a program where nobody is waitlisted or too old reads exactly as before', async () => {
    page.rows = importRows('U10', 30, () => ({ natural_age: 9 }));
    page.divisions = [U10()];
    await renderPage();
    expect(screen.getByTestId('team-count-recommendation')).toHaveTextContent(
      /^Recommended: 3 teams for 30 players\. Each volunteer head coach gets a team, which can add more\.$/
    );
    expect(overviewCell('U10', 'Players')).toHaveTextContent(/^30$/);
  });
});

/*
 * Play-down plan, PR 1 (docs/changes/2026-11-03-play-down-default-and-flags.md): the advice counts a
 * player in the division they PLAY in, as generation seats them, not the one they registered in. Two
 * divisions, both with registrants, so a player who moves leaves one count and joins the other (the
 * old advice left them in the division they registered in and, for a division the file had
 * registrants in, never added them to the one they joined). Limits as above (target 12, minimum 10,
 * maximum 14: 24 players are 2 teams, 28 are 2, 30 are 3); every expected count is worked out from
 * the rows, never read back from the page.
 */
describe('The advice counts the division a player plays in (play-down plan, PR 1)', () => {
  const resetState = () => {
    page.rows = [];
    page.divisions = [];
    page.saves = [];
    page.players = [];
    page.playersError = null;
    page.playerReads = 0;
    page.divisionsGate = null;
    page.divisionsError = null;
    page.flags = {};
    sessionStorage.clear();
  };
  beforeEach(resetState);
  afterEach(() => {
    cleanup();
    resetState();
    vi.restoreAllMocks();
  });

  const U10 = () => savedDivision('U10', { min_age: 9, max_age: 10 });
  const U12 = () => savedDivision('U12', { min_age: 11, max_age: 12 });

  /** Click Generate for the division the settings panel shows, and wait for the staged review. */
  async function generate() {
    const button = screen.getByRole('button', { name: /Generate Teams/ });
    await waitFor(() => expect(button).toBeEnabled());
    await act(async () => {
      fireEvent.click(button);
    });
    await screen.findByText('Team Review Pending');
  }

  it('advises the teams Generate makes, for both divisions, when players move between them', async () => {
    // U10: thirty registered, twenty-four aged 10 and six aged 12 (registered younger than their age,
    // so they play in U12). U12: twenty-four aged 11, two of whom asked to play up from their own
    // division (nothing to honour: they are in band, and not a play-up).
    // Seated: U10 24 (2 teams), U12 24 + 6 = 30 (3 teams). Counted where they registered, U10 would be
    // 30 (3 teams) and U12 24 (2 teams): both wrong, in opposite directions.
    page.rows = [
      ...importRows('U10', 30, (i) => ({ natural_age: i < 6 ? 12 : 10 })),
      ...importRows('U12', 24, (i) => ({
        natural_age: 11,
        ...(i < 2 ? { play_up: 'yes' } : {}),
      })),
    ];
    page.divisions = [U10(), U12()];
    await renderPage();

    await waitFor(() =>
      expect(overviewCell('U10', 'Players')).toHaveTextContent(
        /^24\s*6 registered here, placed in their own age division$/
      )
    );
    // The two who asked to play up from their own division are their own line (PR 2).
    expect(overviewCell('U12', 'Players')).toHaveTextContent(
      /^30\s*6 moved here from other divisions\s*2 asked to play up, registered in their own division$/
    );
    expect(Math.ceil(24 / 12)).toBe(2);
    expect(Math.ceil(30 / 12)).toBe(3);
    expect(overviewCell('U10', 'Est. Teams')).toHaveTextContent(/^2$/);
    expect(overviewCell('U10', 'Recommended')).toHaveTextContent(/^2$/);
    expect(overviewCell('U10', 'Avg Roster')).toHaveTextContent(/^12$/);
    expect(overviewCell('U12', 'Est. Teams')).toHaveTextContent(/^3$/);
    expect(overviewCell('U12', 'Recommended')).toHaveTextContent(/^3$/);
    expect(overviewCell('U12', 'Avg Roster')).toHaveTextContent(/^10$/);
    // The settings panel says the same for the division it shows.
    expect(screen.getByTestId('team-count-recommendation')).toHaveTextContent(
      'Recommended: 2 teams for 24 players'
    );

    // And Generate makes exactly those teams: U10 first, then (a fresh page) U12.
    await generate();
    expect(screen.getByText('Team review staged: 2 teams.', { exact: false })).toBeInTheDocument();
    cleanup();
    sessionStorage.clear();
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'U12' }));
    await screen.findByRole('heading', { name: 'U12 Settings' });
    await waitFor(() =>
      expect(screen.getByTestId('team-count-recommendation')).toHaveTextContent(
        'Recommended: 3 teams for 30 players'
      )
    );
    await generate();
    expect(screen.getByText('Team review staged: 3 teams.', { exact: false })).toBeInTheDocument();
  });

  it('an unrequested play-up plays in their own age division, a requested one where they registered', async () => {
    // U10: twenty-four aged 10. U12: thirty registered, twenty-four aged 11 in band, four aged 10 not
    // asking (they play U10) and two aged 10 asking (they stay in U12, playing up).
    // Seated: U10 24 + 4 = 28 (2 teams), U12 24 + 2 = 26 (2 teams). Counted by registration U12 is
    // 30, which is 3 teams: the advice must not say 3.
    page.rows = [
      ...importRows('U10', 24, () => ({ natural_age: 10 })),
      ...importRows('U12', 30, (i) => ({
        natural_age: i < 24 ? 11 : 10,
        ...(i >= 28 ? { play_up: 'yes' } : {}),
      })),
    ];
    page.divisions = [U10(), U12()];
    await renderPage();

    await waitFor(() =>
      expect(overviewCell('U10', 'Players')).toHaveTextContent(
        /^28\s*4 moved here from other divisions$/
      )
    );
    expect(overviewCell('U12', 'Players')).toHaveTextContent(
      /^26\s*4 registered here, placed in their own age division$/
    );
    expect(overviewCell('U10', 'Est. Teams')).toHaveTextContent(/^2$/);
    expect(overviewCell('U12', 'Est. Teams')).toHaveTextContent(/^2$/);
    expect(overviewCell('U12', 'Recommended')).toHaveTextContent(/^2$/);
  });

  it('counts a waitlisted player who moves on the waitlist of the division they would play in', async () => {
    // U10: thirty registered, twenty-four aged 10 and six aged 12, two of the six on the waitlist.
    // U12: twenty-four aged 11. Seated U10 24; U12 holds 24 + 6 = 30 players of whom 2 are waitlisted,
    // so it seats 28 (2 teams; counted all 30 it would say 3).
    page.rows = [
      ...importRows('U10', 30, (i) => ({
        natural_age: i < 6 ? 12 : 10,
        ...(i < 2 ? { waitlist: 'yes' } : {}),
      })),
      ...importRows('U12', 24, () => ({ natural_age: 11 })),
    ];
    page.divisions = [U10(), U12()];
    await renderPage();

    await waitFor(() =>
      expect(overviewCell('U12', 'Players')).toHaveTextContent(
        /^28\s*2 on the waitlist\s*6 moved here from other divisions$/
      )
    );
    expect(overviewCell('U10', 'Players')).toHaveTextContent(
      /^24\s*6 registered here, placed in their own age division$/
    );
    expect(overviewCell('U12', 'Recommended')).toHaveTextContent(/^2$/);
  });

  it('a division whose registrants have all moved away has nobody to seat and advises no team', async () => {
    // U10: twelve registered, all aged 11, so all play in U12 with the twelve already registered
    // there. Seated: U10 0, U12 24 (2 teams).
    page.rows = [
      ...importRows('U10', 12, () => ({ natural_age: 11 })),
      ...importRows('U12', 12, () => ({ natural_age: 11 })),
    ];
    page.divisions = [U10(), U12()];
    await renderPage();

    await waitFor(() =>
      expect(overviewCell('U10', 'Players')).toHaveTextContent(
        /^0\s*12 registered here, placed in their own age division$/
      )
    );
    expect(overviewCell('U10', 'Est. Teams')).toHaveTextContent(/^0$/);
    expect(overviewCell('U10', 'Recommended')).toHaveTextContent('—');
    expect(overviewCell('U10', 'Avg Roster')).toHaveTextContent(/^0$/);
    expect(overviewCell('U10', 'Status')).toHaveTextContent('All placed in other divisions');
    expect(overviewRow('U10')).not.toHaveTextContent('Fits the limits');
    expect(overviewCell('U12', 'Players')).toHaveTextContent(
      /^24\s*12 moved here from other divisions$/
    );
    expect(overviewCell('U12', 'Recommended')).toHaveTextContent(/^2$/);
  });

  it('shows a waitlisted player who moves into a division the file has no registrants in', async () => {
    // U10: twenty-four aged 10 and one aged 12 on the waitlist. Nobody registered in U12, which holds
    // the 12-year-old, so U12 is a row of its own with nobody to seat: the player is on its waitlist.
    // Without that row the file's twenty-five would not reconcile with the twenty-four advised.
    page.rows = importRows('U10', 25, (i) => ({
      natural_age: i === 0 ? 12 : 10,
      ...(i === 0 ? { waitlist: 'yes' } : {}),
    }));
    page.divisions = [U10(), U12()];
    await renderPage();

    await waitFor(() =>
      expect(overviewCell('U12', 'Players')).toHaveTextContent(
        /^0\s*1 on the waitlist\s*1 moved here from another division$/
      )
    );
    expect(overviewCell('U12', 'Status')).toHaveTextContent('All on the waitlist');
    expect(overviewCell('U12', 'Est. Teams')).toHaveTextContent(/^0$/);
    expect(overviewCell('U10', 'Players')).toHaveTextContent(
      /^24\s*1 registered here, placed in their own age division$/
    );
  });

  it('says in the settings panel who moved, in the words of the overview', async () => {
    page.rows = [
      ...importRows('U10', 30, (i) => ({ natural_age: i < 6 ? 12 : 10 })),
      ...importRows('U12', 24, () => ({ natural_age: 11 })),
    ];
    page.divisions = [U10(), U12()];
    await renderPage();
    await waitFor(() =>
      expect(screen.getByTestId('team-count-recommendation')).toHaveTextContent(
        'Recommended: 2 teams for 24 players (6 registered here are placed in their own age division and not counted)'
      )
    );
    fireEvent.click(screen.getByRole('button', { name: 'U12' }));
    await screen.findByRole('heading', { name: 'U12 Settings' });
    expect(screen.getByTestId('team-count-recommendation')).toHaveTextContent(
      'Recommended: 3 teams for 30 players (6 moved here from other divisions)'
    );
  });

  it('a league with nobody moved reads exactly as before: no note anywhere', async () => {
    page.rows = [
      ...importRows('U10', 30, () => ({ natural_age: 10 })),
      ...importRows('U12', 24, () => ({ natural_age: 11, play_up: 'yes' })),
    ];
    page.divisions = [U10(), U12()];
    await renderPage();
    await waitFor(() => expect(page.playerReads).toBeGreaterThan(0));
    expect(overviewCell('U10', 'Players')).toHaveTextContent(/^30$/);
    // Nobody moved, so no moved note; the 24 requests are in band, so they are their own line and not
    // a play-up (PR 2).
    expect(overviewCell('U12', 'Players')).toHaveTextContent(
      /^24\s*24 asked to play up, registered in their own division$/
    );
    expect(overviewCell('U12', 'Play-up and play-down')).toHaveTextContent(/^None$/);
    expect(
      within(screen.getByRole('table', { name: 'Division Overview' })).queryByText(
        /moved here|placed in their own age division/
      )
    ).toBeNull();
    expect(screen.getByTestId('team-count-recommendation')).toHaveTextContent(
      /^Recommended: 3 teams for 30 players\. Each volunteer head coach gets a team, which can add more\.$/
    );
  });

  it('counts the stored player over the file when it moves them, as generation reads the record', async () => {
    // The file says thirty aged 10 in U10. The record has six of them at 12 (an admin corrected the
    // age): they play in U12, so U10 seats 24 and U12 seats 24 + 6.
    page.rows = [
      ...importRows('U10', 30, () => ({ natural_age: 10 })),
      ...importRows('U12', 24, () => ({ natural_age: 11 })),
    ];
    page.divisions = [U10(), U12()];
    page.players = Array.from({ length: 6 }, (_, i) => ({
      id: `${IDS.division}-player-${i + 1}`,
      external_registration_id: `U10-REG-${i + 1}`,
      division_id: `${IDS.division}-U10`,
      first_name: `Kid${i + 1}`,
      last_name: `Placeholder${i + 1}`,
      natural_age: 12,
    }));
    await renderPage();

    await waitFor(() =>
      expect(overviewCell('U12', 'Players')).toHaveTextContent(
        /^30\s*6 moved here from other divisions$/
      )
    );
    expect(overviewCell('U10', 'Players')).toHaveTextContent(
      /^24\s*6 registered here, placed in their own age division$/
    );
  });
});

describe('A division plays games, or is practice only (D2)', () => {
  beforeEach(() => {
    page.rows = [];
    page.divisions = [];
    page.saves = [];
    sessionStorage.clear();
  });
  afterEach(() => cleanup());

  it("shows a stored division's setting and saves the admin's change with the rules", async () => {
    page.rows = importRows('U4', 12);
    page.divisions = [savedDivision('U4', { plays_games: true })];
    await renderPage();
    const box = await screen.findByRole('checkbox', { name: 'Plays games' });
    expect(box).toBeChecked();
    fireEvent.click(box);
    expect(box).not.toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Save Rules' }));
    await waitFor(() => expect(page.saves).toHaveLength(1));
    expect(page.saves[0]).toMatchObject({ p_name: 'U4', p_plays_games: false });
    await waitFor(() =>
      expect(screen.getByRole('checkbox', { name: 'Plays games' })).not.toBeChecked()
    );
  });

  it('before the migration (a row without plays_games) offers no setting and sends none', async () => {
    page.rows = importRows('U10', 12);
    page.divisions = [savedDivision('U10')];
    await renderPage();
    expect(screen.queryByRole('checkbox', { name: 'Plays games' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save Rules' }));
    await waitFor(() => expect(page.saves).toHaveLength(1));
    expect('p_plays_games' in page.saves[0]).toBe(false);
  });
});

/*
 * Phase D PR B: the division's practice settings, offered once the division's settings were read
 * (the config carries `practicesPerWeek`). Every expectation is the table's check (0 to 7 whole
 * practices; a length of 15 to 240 minutes, or none for any slot length), restated here.
 */
describe('TeamingConfiguration practice settings', () => {
  it('offers neither field for a division whose settings were not read (older database)', () => {
    renderPanel({ ...limits, teamCountOverride: 3 });
    expect(screen.queryByLabelText('Practices per week')).toBeNull();
    expect(screen.queryByLabelText('Practice length (minutes)')).toBeNull();
  });

  it('shows the stored values and sends an edit through onUpdate, by label', () => {
    const onUpdate = renderPanel({
      ...limits,
      teamCountOverride: 3,
      practicesPerWeek: 2,
      practiceMinutes: 60,
    });
    const count = screen.getByLabelText('Practices per week');
    const length = screen.getByLabelText('Practice length (minutes)');
    expect(count).toHaveValue(2);
    expect(length).toHaveValue(60);
    fireEvent.change(count, { target: { value: '3' } });
    expect(onUpdate).toHaveBeenCalledWith('u10-boys', { practicesPerWeek: 3 });
  });

  it('an empty length is "any slot length", and the button clears a set one', () => {
    const onUpdate = renderPanel({
      ...limits,
      teamCountOverride: 3,
      practicesPerWeek: 1,
      practiceMinutes: 90,
    });
    const clear = screen.getByRole('button', { name: 'Any length' });
    expect(clear).toBeEnabled();
    fireEvent.click(clear);
    expect(onUpdate).toHaveBeenCalledWith('u10-boys', { practiceMinutes: null });
  });

  it('says in text, not colour alone, when a value is outside what the table allows', () => {
    renderPanel({ ...limits, teamCountOverride: 3, practicesPerWeek: 9, practiceMinutes: 10 });
    expect(screen.getByLabelText('Practices per week')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Practice length (minutes)')).toHaveAttribute(
      'aria-invalid',
      'true'
    );
    expect(screen.getByText('Enter a whole number from 0 to 7.')).toBeInTheDocument();
    expect(screen.getByText('Enter 15 to 240 minutes, or choose Any length.')).toBeInTheDocument();
  });

  it('keeps the fields while the count is cleared to retype it', () => {
    renderPanel({ ...limits, teamCountOverride: 3, practicesPerWeek: '', practiceMinutes: null });
    expect(screen.getByLabelText('Practices per week')).toHaveValue(null);
    expect(screen.getByLabelText('Practices per week')).toHaveAttribute('aria-invalid', 'true');
  });
});

/*
 * Play-down plan, PR 2: every play-up and play-down is flagged and counted, by division, by program and
 * for the league (docs/changes/2026-11-03-play-down-default-and-flags.md, section 4). The page is real,
 * and so are the overview, the pipeline and the seat count; its data hooks and Supabase are stand-ins.
 * Every figure is worked out below from the rows, never read back from the page.
 *
 *   Junior: U8 (ages 7 to 8) and U10 (9 to 10).   Senior: U12 (11 to 12).   No program: U14 (13 to 14).
 *
 *   U8   8 aged 7                                    in band: seated 8, nobody flagged
 *   U10  20 aged 10                                  in band
 *        3 aged 12 (registered younger than their    placed in U12, their own age division: moved out
 *          age)                                       of U10; playing down is not available
 *        1 aged 8, asked to play up                  U10's band is 9 to 10, so age 8 is a play-up
 *   U12  20 aged 12                                  in band
 *        2 aged 10, asked to play up                 under U12's 11 to 12: playing up
 *        1 aged 10, did not ask                      placed in U10, their own age division: moved
 *        1 aged 11, asked to play up                 in band: asked, with nothing to honour
 *        1 with no age on file                       nothing to compare: not checked
 *   U14  12 aged 13                                  in band
 *        1 aged 11, asked to play up                 under U14's 13 to 14: playing up
 *
 * Seated: U8 8; U10 20 + 1 + 1 moved in from U12 = 22; U12 20 + 2 + 1 + 1 + 3 moved in from U10 = 27;
 * U14 13. Playing up: U10 1, U12 2, U14 1. Not checked: U12 1. Asked: U12 1. Playing down: none.
 * Junior = U8 + U10: 1 playing up, and 1 moved in from Senior (U12 -> U10 is across programs).
 * Senior = U12: 2 playing up, 1 not checked, 1 asked, and 3 moved in from Junior.
 * No program = U14: 1 playing up. League: 4 playing up, 0 playing down, 1 not checked, 1 asked.
 */
describe('The overview flags every play-up and play-down, with counts (play-down plan, PR 2)', () => {
  const resetState = () => {
    page.rows = [];
    page.divisions = [];
    page.programs = [];
    page.saves = [];
    page.players = [];
    page.playersError = null;
    page.playerReads = 0;
    page.divisionsGate = null;
    page.divisionsError = null;
    page.flags = {};
    sessionStorage.clear();
  };
  beforeEach(resetState);
  afterEach(() => {
    cleanup();
    resetState();
    vi.restoreAllMocks();
  });

  const JUNIOR = { id: 'program-junior', name: 'Junior', is_default: false };
  const SENIOR = { id: 'program-senior', name: 'Senior', is_default: false };
  const DEFAULT = { id: 'program-default', name: 'No program', is_default: true };
  const band = (name, min_age, max_age, program) =>
    savedDivision(name, { min_age, max_age, program_id: program?.id ?? null });

  const league = () => [
    ...importRows('U8', 8, () => ({ natural_age: 7 })),
    ...importRows('U10', 24, (i) =>
      i < 20
        ? { natural_age: 10 }
        : i < 23
          ? { natural_age: 12 }
          : { natural_age: 8, play_up: 'yes' }
    ),
    ...importRows('U12', 25, (i) =>
      i < 20
        ? { natural_age: 12 }
        : i < 22
          ? { natural_age: 10, play_up: 'yes' }
          : i === 22
            ? { natural_age: 10 }
            : i === 23
              ? { natural_age: 11, play_up: 'yes' }
              : {}
    ),
    ...importRows('U14', 13, (i) =>
      i < 12 ? { natural_age: 13 } : { natural_age: 11, play_up: 'yes' }
    ),
  ];
  const withPrograms = () => {
    page.programs = [DEFAULT, JUNIOR, SENIOR];
    page.divisions = [
      band('U8', 7, 8, JUNIOR),
      band('U10', 9, 10, JUNIOR),
      band('U12', 11, 12, SENIOR),
      // In the season's default program, which is "in none".
      band('U14', 13, 14, DEFAULT),
    ];
  };
  const flagsOf = (name) => overviewCell(name, 'Play-up and play-down');
  const headings = () =>
    screen
      .queryAllByRole('rowheader')
      .map((th) => th.textContent)
      .filter(Boolean);

  it('counts each division by the seat, with None where nobody plays up or down', async () => {
    withPrograms();
    page.rows = league();
    await renderPage();
    await waitFor(() =>
      expect(overviewCell('U10', 'Players')).toHaveTextContent(/^22\s*1 moved here/)
    );

    expect(overviewCell('U8', 'Players').textContent).toBe('8');
    expect(flagsOf('U8').textContent).toBe('None');

    expect(overviewCell('U10', 'Players')).toHaveTextContent(
      /^22\s*1 moved here from another division\s*3 registered here, placed in their own age division$/
    );
    expect(flagsOf('U10').textContent).toBe('1 playing up');

    expect(overviewCell('U12', 'Players')).toHaveTextContent(
      /^27\s*3 moved here from other divisions\s*1 registered here, placed in their own age division\s*1 asked to play up, registered in their own division$/
    );
    expect(flagsOf('U12')).toHaveTextContent(
      /^2 playing up\s*1 not checked \(no age, or no age band\)$/
    );

    expect(overviewCell('U14', 'Players').textContent).toBe('13');
    expect(flagsOf('U14').textContent).toBe('1 playing up');

    // Playing down is in no division: nobody is placed below their age.
    expect(screen.queryByText(/[1-9]\d* playing down/)).toBeNull();
  });

  it('counts each program under its heading, and the league above the table', async () => {
    withPrograms();
    page.rows = league();
    await renderPage();
    await waitFor(() => expect(headings()).toHaveLength(3));
    expect(headings()).toEqual([
      'Junior: 1 playing up, 0 playing down (1 moved in from another program)',
      'Senior: 2 playing up, 0 playing down, 1 not checked, 1 asked to play up from their own division (3 moved in from other programs)',
      'No program: 1 playing up, 0 playing down',
    ]);
    expect(screen.getByTestId('play-flags-league').textContent).toBe(
      'League: 4 playing up, 0 playing down, 1 not checked, 1 asked to play up from their own division.'
    );
  });

  it('shows a league with no program of its own the league line and no heading', async () => {
    page.divisions = [
      band('U8', 7, 8),
      band('U10', 9, 10),
      band('U12', 11, 12),
      band('U14', 13, 14),
    ];
    page.rows = league();
    await renderPage();
    await waitFor(() =>
      expect(screen.getByTestId('play-flags-league')).toHaveTextContent('4 playing up')
    );
    expect(headings()).toEqual([]);
    expect(screen.getByTestId('play-flags-league').textContent).toBe(
      'League: 4 playing up, 0 playing down, 1 not checked, 1 asked to play up from their own division.'
    );
    expect(flagsOf('U12')).toHaveTextContent(/^2 playing up/);
  });

  it('says not checked, never None, until the season’s divisions have been read', async () => {
    let release = () => {};
    page.divisionsGate = new Promise((resolve) => {
      release = resolve;
    });
    withPrograms();
    page.rows = league();
    render(
      <MemoryRouter>
        <TeamAnalysisPage />
      </MemoryRouter>
    );
    await screen.findByRole('heading', { name: 'Division Overview' });
    await waitFor(() => expect(page.playerReads).toBeGreaterThan(0));
    // No age band is known yet, so nothing was compared: not zero, not "None", and no request is
    // called one with nothing to honour.
    expect(flagsOf('U12').textContent).toBe('Not checked yet');
    expect(flagsOf('U8').textContent).toBe('Not checked yet');
    expect(screen.getByTestId('play-flags-league').textContent).toBe('League: not checked yet.');
    expect(screen.queryByText(/asked to play up, registered in their own division/)).toBeNull();

    await act(async () => {
      release();
    });
    await waitFor(() => expect(flagsOf('U12')).toHaveTextContent(/^2 playing up/));
    expect(flagsOf('U8').textContent).toBe('None');
  });

  it('says not checked, never None, when the divisions cannot be read', async () => {
    page.divisionsError = { message: 'permission denied for table divisions', code: '42501' };
    page.rows = league();
    await renderPage().catch(() => {});
    await screen.findByRole('heading', { name: 'Division Overview' });
    await waitFor(() => expect(page.playerReads).toBeGreaterThan(0));
    expect(screen.getByTestId('play-flags-league').textContent).toBe('League: not checked yet.');
    expect(flagsOf('U10').textContent).toBe('Not checked yet');
  });

  it('flags a play-up by a stored request, as generation would read it', async () => {
    // The file does not say who asked; the record says one U12-registered age-10 player did.
    page.divisions = [band('U10', 9, 10), band('U12', 11, 12)];
    page.rows = [
      ...importRows('U10', 12, () => ({ natural_age: 10 })),
      ...importRows('U12', 12, (i) => ({ natural_age: i === 0 ? 10 : 12 })),
    ];
    page.players = [
      {
        id: `${IDS.division}-player-1`,
        external_registration_id: 'U12-REG-1',
        division_id: `${IDS.division}-U12`,
        first_name: 'Kid1',
        last_name: 'Placeholder1',
        natural_age: 10,
        play_up_requested: true,
      },
    ];
    await renderPage();
    await waitFor(() => expect(flagsOf('U12')).toHaveTextContent(/^1 playing up$/));
    expect(flagsOf('U10').textContent).toBe('None');
    expect(overviewCell('U10', 'Players').textContent).toBe('12');
  });
});
