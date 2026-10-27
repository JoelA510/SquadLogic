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
  /** @type {any[]} every `admin_upsert_division_settings` call's params */
  saves: [],
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
    from: (table) =>
      createChainMock({ data: table === 'divisions' ? page.divisions : [], error: null }),
    rpc: async (name, params) => {
      if (name !== 'admin_upsert_division_settings') return { data: null, error: null };
      page.saves.push(params);
      return {
        data: {
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
  const headers = screen.getAllByRole('columnheader').map((th) => th.textContent);
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
