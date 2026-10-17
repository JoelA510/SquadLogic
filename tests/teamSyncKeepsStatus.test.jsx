/**
 * The Teams page keeps its success line after "Sync to Supabase" (Wave 3,
 * remediation plan, "Discovered during execution", 2026-10-14).
 *
 * A sync of a staged team review cleared the review, and the page fell back
 * to the team summary it had read before the sync: on a first run, none. So it
 * showed its generate view, which renders neither the review's status line nor
 * the persistence panel, until a reload. The sync itself had succeeded.
 *
 * The page is real; its data hooks and heavy children are stand-ins. The staged
 * review reaches it the way it does in production when the operator comes back
 * to the page: from `sessionStorage`, under the page's own key. The persistence
 * panel is a stub that reports what `TeamPersistencePanel` reports on success
 * (`onPersistSuccess(result)`, the client's success shape).
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { mapSchedulerRunToSummary } from '../packages/core/src/utils/teamSummaryMapper.js';
import { createChainMock } from './helpers/index.js';

const IDS = vi.hoisted(() => ({
  organization: '3b0c8f7e-1d2a-4c5b-9e6f-7a8b9c0d1e01',
  season: '3b0c8f7e-1d2a-4c5b-9e6f-7a8b9c0d1e02',
}));

const dash = vi.hoisted(() => ({ /** @type {any} */ value: null, refetch: vi.fn() }));

vi.mock('../frontend/src/hooks/useDashboardData.js', () => ({
  useDashboardData: () => dash.value,
}));
vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: () => ({
    currentOrganization: { id: IDS.organization, name: 'Test FC' },
    currentSeasonSetting: { id: IDS.season, timezone: 'America/New_York' },
    permissions: ['manage_organization'],
  }),
}));
// The import the page was handed: the generate view's condition is "no team run
// in hand and an import", which is the view the old code fell back to.
vi.mock('../frontend/src/contexts/ImportContext.jsx', () => ({
  useImport: () => ({
    importedData: {
      data: [
        { first_name: 'Ada', last_name: 'One', division: 'U9 Coed' },
        { first_name: 'Bea', last_name: 'Two', division: 'U9 Coed' },
      ],
    },
  }),
}));
vi.mock('../frontend/src/contexts/AuthContext.jsx', () => ({
  useAuth: () => ({ session: null, user: null }),
}));
const refreshPersistence = vi.hoisted(() => vi.fn());
vi.mock('../frontend/src/hooks/useTeamPersistence.js', () => ({
  useTeamPersistence: () => ({
    persistenceSnapshot: null,
    loading: false,
    refresh: refreshPersistence,
  }),
}));
vi.mock('../frontend/src/hooks/useAutoRunOnNavigate.js', () => ({
  useAutoRunOnNavigate: () => {},
}));
vi.mock('../frontend/src/hooks/useFeatures.js', () => ({
  useFeatures: () => ({ genderModel: 'mixed', isEnabled: () => false }),
}));
vi.mock('../frontend/src/lib/supabaseClient.js', () => ({
  supabase: {
    from: () => createChainMock({ data: [], error: null }),
    rpc: async () => ({ data: null, error: null }),
  },
}));

const SYNC_RESULT = vi.hoisted(() => ({
  status: 'success',
  updatedTeams: 2,
  updatedPlayers: 20,
  syncedAt: '2026-10-17T12:00:00Z',
}));

// What `TeamPersistencePanel` does on a successful sync, and nothing else.
vi.mock('../frontend/src/components/TeamPersistencePanel.jsx', () => ({
  default: ({ onPersistSuccess }) => (
    <button type="button" onClick={() => onPersistSuccess?.(SYNC_RESULT)}>
      Sync to Supabase
    </button>
  ),
}));
const stub = (name) => ({ default: () => <div data-testid={`stub-${name}`} /> });
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

/** A team run as `scheduler_runs` holds it, through the mapper the page uses. */
const RUN = {
  id: 'run-team-1',
  completed_at: '2026-10-17T11:59:00Z',
  results: {
    teamsByDivision: {
      'U9 Coed': [
        { id: 'team-a', name: 'Lions', division_id: 'U9 Coed' },
        { id: 'team-b', name: 'Bulls', division_id: 'U9 Coed' },
      ],
    },
    team_players: [],
  },
};
const SUMMARY = mapSchedulerRunToSummary(RUN);

/** `useDashboardData`'s team source: before any run, mid re-read, after it. */
function dashboard({ teamLoading, summary }) {
  return {
    loading: { team: teamLoading, practice: false, game: false },
    error: null,
    errors: { team: null, practice: null, game: null },
    team: {
      summary,
      generatedAt: summary?.generatedAt ?? null,
      totals: summary?.totals,
      divisions: summary?.divisions,
      teams: summary?.teams,
      team_players: summary?.team_players,
      status: summary ? 'completed' : 'idle',
      progress: summary ? 100 : 0,
      refetch: dash.refetch,
    },
    practice: {},
    game: {},
  };
}

const APPLIED = 'Team review applied. 2 teams and 20 players synced to Supabase.';

function renderPage() {
  return render(
    <MemoryRouter>
      <TeamAnalysisPage />
    </MemoryRouter>
  );
}

describe('TeamAnalysisPage :: a synced review keeps its success line', () => {
  beforeEach(() => {
    sessionStorage.clear();
    dash.refetch.mockReset();
    // The re-read starts: the hook reports loading from the same update.
    dash.refetch.mockImplementation(() => {
      dash.value = dashboard({ teamLoading: true, summary: null });
    });
    refreshPersistence.mockReset();
    dash.value = dashboard({ teamLoading: false, summary: null });
    sessionStorage.setItem(
      `squadlogic:team-review:${IDS.organization}:${IDS.season}`,
      JSON.stringify({
        snapshot: { lastRunId: RUN.id, manualOverrides: [], runHistory: [] },
        summary: SUMMARY,
        createdAt: RUN.completed_at,
        programName: 'U9 Coed',
      })
    );
  });

  afterEach(() => sessionStorage.clear());

  it('keeps the line through the re-read of the synced run, and shows the synced teams', async () => {
    const { rerender } = renderPage();
    // Meta-assertion: the staged review is on screen, so the case below starts
    // from the state a sync is pressed in, not from an empty page.
    expect(await screen.findByText('Team Review Pending')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sync to Supabase' }));
    });

    expect(screen.getByText(APPLIED)).toBeInTheDocument();
    expect(dash.refetch).toHaveBeenCalledTimes(1);
    expect(refreshPersistence).toHaveBeenCalledTimes(1);
    // Not the generate view the page fell back to before.
    expect(screen.queryByRole('button', { name: /Generate Teams/ })).not.toBeInTheDocument();

    // The synced run arrives.
    dash.value = dashboard({ teamLoading: false, summary: SUMMARY });
    rerender(
      <MemoryRouter>
        <TeamAnalysisPage />
      </MemoryRouter>
    );

    expect(screen.getByText(APPLIED)).toBeInTheDocument();
    expect(screen.getByText('Team Review Status')).toBeInTheDocument();
    expect(screen.getByTestId('stub-team-overview')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Generated Teams' })).toHaveTextContent('Lions');
    expect(screen.queryByRole('button', { name: /Generate Teams/ })).not.toBeInTheDocument();
  });
});
