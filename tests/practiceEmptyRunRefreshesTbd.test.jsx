// A run that places nothing has nothing to Apply: the Apply button and the writer both refuse an empty
// review, so the practice save that rebuilds the TIME TBD list never runs for it. The page brings the
// list up to date itself (`refresh_schedule_tbd_practices`) once such a run completes, and says so when
// that fails (the export refuses to make files until the list can be refreshed).
//
// Rendered as the real page with its data hooks stubbed (the pattern practiceApplyAdminGate.test.jsx
// established), driven by a completed auto-scheduler result with no assignments.
import React from 'react';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { createChainMock } from './helpers/index.js';
import { ROLE_PERMISSIONS, ROLES } from '../frontend/src/constants/permissions.js';
import { MOCK_ORG_ID, MOCK_SEASON_ID } from '../frontend/src/lib/mockSeedIds.js';

const state = vi.hoisted(() => ({
  /** @type {string[]} */ permissions: [],
  /** @type {any} */ dashboard: null,
  // A run that placed nothing: no slot was free for any team.
  schedulerResult: {
    runId: 'run-empty-1',
    assignments: [],
    unassigned: [{ teamId: 'team-hawks', reason: 'no-slot-available' }],
  },
  /** @type {Array<[string, any]>} */ rpcCalls: [],
  /** @type {{ error: any }} */ refresh: { error: null },
  slotRow: {
    id: 'slot-1',
    day_of_week: 'mon',
    start_time: '18:00',
    end_time: '19:30',
    capacity: 1,
    valid_from: '2026-09-01',
    valid_until: '2026-11-30',
    field_id: 'field-1',
    fields: { id: 'field-1', name: 'Pitch 1', location_id: 'loc-1' },
  },
}));

vi.mock('../frontend/src/hooks/useDashboardData.js', () => ({
  useDashboardData: () => state.dashboard,
}));

// --- Context + hook stubs shared by every page under test -------------------

vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: () => ({
    currentOrganization: { id: MOCK_ORG_ID, name: 'Smoke FC' },
    currentSeasonSetting: { id: MOCK_SEASON_ID, timezone: 'America/New_York' },
    featureFlags: {},
    permissions: state.permissions,
    loading: false,
    seasonSettingsLoading: false,
  }),
}));
vi.mock('../frontend/src/contexts/ImportContext.jsx', () => ({
  useImport: () => ({ importedData: null, setImportedData: () => {} }),
}));
vi.mock('../frontend/src/contexts/AuthContext.jsx', () => ({
  useAuth: () => ({ session: null, user: null }),
}));
vi.mock('../frontend/src/contexts/ThemeContext.jsx', () => ({
  useTheme: () => ({ theme: 'light', themeMode: 'light' }),
}));
vi.mock('../frontend/src/hooks/useTeamPersistence.js', () => ({
  useTeamPersistence: () => ({
    persistenceSnapshot: null,
    loading: false,
    refresh: () => {},
  }),
}));
vi.mock('../frontend/src/hooks/useAutoRunOnNavigate.js', () => ({
  useAutoRunOnNavigate: () => {},
}));
vi.mock('../frontend/src/hooks/useFieldClosures.js', () => ({
  useFieldClosures: () => ({ closures: [], loading: false, error: null, refresh: () => {} }),
}));
vi.mock('../frontend/src/hooks/useAutoScheduler.js', () => ({
  useAutoScheduler: () => ({
    status: 'completed',
    progress: null,
    result: state.schedulerResult,
    error: null,
    trigger: () => {},
    cancel: () => {},
    reset: () => {},
  }),
}));
vi.mock('../frontend/src/hooks/usePermission.js', () => ({
  usePermission: () => ({ role: 'admin', can: () => true }),
}));
vi.mock('../frontend/src/hooks/useFeatures.js', () => ({
  useFeatures: () => ({ genderModel: 'mixed', isEnabled: () => false }),
}));
vi.mock('../frontend/src/lib/pagedFetch.js', () => ({
  fetchAllPages: async () => [],
}));
vi.mock('../frontend/src/lib/supabaseClient.js', () => ({
  supabase: {
    // One real practice slot, so an applied review references a slot that
    // exists; every other table reads empty.
    from: (table) =>
      createChainMock({ data: table === 'practice_slots' ? [state.slotRow] : [], error: null }),
    rpc: async (name, args) => {
      state.rpcCalls.push([name, args]);
      if (name === 'refresh_schedule_tbd_practices') {
        return state.refresh.error
          ? { data: null, error: state.refresh.error }
          : { data: { changed: true, practice_rows: 1, missing_practices: 2 }, error: null };
      }
      return { data: null, error: null };
    },
    // A session, so `persistPracticeScheduleReview` reaches its `fetch`.
    auth: {
      getSession: async () => ({ data: { session: { access_token: 'test-token' } }, error: null }),
    },
  },
}));

// Heavy children are stubbed out. They are not what is under test, and the
// real ones pull in virtualizers, drag contexts and chart canvases that say
// nothing about whether the page reports a failed load.
const stub = (name) => ({ default: () => <div data-testid={`stub-${name}`} /> });
vi.mock('../frontend/src/components/TeamScheduleView.jsx', () => stub('team-schedule'));
vi.mock('../frontend/src/components/scheduling/GameScheduleGrid.jsx', () => stub('game-grid'));
vi.mock('../frontend/src/components/GameReadinessPanel.jsx', () => stub('game-readiness'));
vi.mock('../frontend/src/components/PracticeAssignmentList.jsx', () => stub('practice-list'));
vi.mock('../frontend/src/components/PracticeOverridePanel.jsx', () => stub('practice-override'));
vi.mock('../frontend/src/components/PracticeReadinessPanel.jsx', () => stub('practice-readiness'));
vi.mock('../frontend/src/components/EvaluationPanel.jsx', () => stub('evaluation'));
vi.mock('../frontend/src/components/TeamOverviewPanel.jsx', () => stub('team-overview'));
vi.mock('../frontend/src/components/teaming/ProgramOverview.jsx', () => stub('program-overview'));
vi.mock('../frontend/src/components/teaming/TeamingConfiguration.jsx', () =>
  stub('teaming-config')
);
vi.mock('../frontend/src/components/teaming/RosterManager.jsx', () => stub('roster-manager'));
vi.mock('../frontend/src/components/TeamPersistencePanel.jsx', () => stub('team-persistence'));
vi.mock('../frontend/src/components/teaming/DataValidationPanel.jsx', () =>
  stub('data-validation')
);
vi.mock('../frontend/src/components/OutputGenerationPanel.jsx', () => stub('output-generation'));
vi.mock('../frontend/src/components/DashboardWorkflow.jsx', () => stub('dashboard-workflow'));
vi.mock('../frontend/src/components/ui/FeatureGuard.jsx', () => ({
  FeatureGuard: ({ children }) => children,
}));

const { default: PracticeSchedulingPage } =
  await import('../frontend/src/pages/PracticeSchedulingPage.jsx');

function dashboardData() {
  return {
    loading: { team: false, practice: false, game: false },
    error: null,
    errors: { team: null, practice: null, game: null },
    roadmap: { sections: [], stats: { completed: 0, pending: 0 } },
    team: {
      summary: null,
      generatedAt: null,
      totals: undefined,
      divisions: undefined,
      teams: undefined,
      team_players: undefined,
      status: 'idle',
      progress: 0,
    },
    practice: {
      summary: null,
      snapshot: null,
      generatedAt: null,
      runId: null,
      scheduleAssignments: [],
    },
    game: {
      summary: null,
      snapshot: null,
      warnings: [],
      generatedAt: null,
      runId: null,
      assignments: undefined,
    },
  };
}

function renderAs(role) {
  state.permissions = ROLE_PERMISSIONS[role];
  state.dashboard = dashboardData();
  state.rpcCalls = [];
  return render(
    <MemoryRouter>
      <PracticeSchedulingPage />
    </MemoryRouter>
  );
}

const refreshCalls = () =>
  state.rpcCalls.filter(([name]) => name === 'refresh_schedule_tbd_practices');

describe('a run that places nothing brings the TIME TBD list up to date', () => {
  beforeEach(() => {
    state.refresh = { error: null };
    state.schedulerResult = {
      runId: 'run-empty-1',
      assignments: [],
      unassigned: [{ teamId: 'team-hawks', reason: 'no-slot-available' }],
    };
  });

  it('refreshes once for the season, however often the page renders', async () => {
    const view = renderAs(ROLES.ADMIN);
    await waitFor(() => expect(refreshCalls()).toHaveLength(1));
    expect(refreshCalls()[0][1]).toEqual({ p_season_settings_id: MOCK_SEASON_ID });
    view.rerender(
      <MemoryRouter>
        <PracticeSchedulingPage />
      </MemoryRouter>
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(refreshCalls()).toHaveLength(1);
    expect(screen.queryByText(/could not be brought up to date after this run/)).toBeNull();
  });

  it('says so when the refresh fails (the export will not make files until it can)', async () => {
    state.refresh = { error: { code: '42501', message: 'Access denied' } };
    renderAs(ROLES.ADMIN);
    const alert = await screen.findByText(/could not be brought up to date after this run/);
    expect(alert).toHaveTextContent('(Access denied)');
    expect(alert).toHaveTextContent('will not make files until it can');
    expect(alert).toHaveAttribute('role', 'alert');
  });

  it('a run that placed something is left to the practice save: no refresh here', async () => {
    state.schedulerResult = {
      runId: 'run-placed-1',
      assignments: [{ teamId: 'team-1', slotId: 'slot-1', source: 'auto' }],
      unassigned: [],
    };
    renderAs(ROLES.ADMIN);
    await screen.findByRole('button', { name: /apply schedule/i });
    expect(refreshCalls()).toHaveLength(0);
  });
});
