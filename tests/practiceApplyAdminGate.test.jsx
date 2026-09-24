// #64: applying a practice schedule REPLACES the season's schedule, and the
// server lets only an org admin do it. The page must not offer anyone else an
// Apply that always ends in a 403: it is disabled, and says why, readably.
//
// Rendered as the real page with its data hooks stubbed (the pattern
// dashboardErrorConsumers.test.jsx established), driven into the review state
// by a completed auto-scheduler result -- the state in which Apply exists.
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { createChainMock } from './helpers/index.js';
import { PERMISSIONS, ROLE_PERMISSIONS, ROLES } from '../frontend/src/constants/permissions.js';

const state = vi.hoisted(() => ({
  /** @type {string[]} */ permissions: [],
  /** @type {any} */ dashboard: null,
  schedulerResult: {
    runId: 'run-review-1',
    assignments: [{ teamId: 'team-1', slotId: 'slot-1', source: 'auto' }],
    unassigned: [],
  },
}));

vi.mock('../frontend/src/hooks/useDashboardData.js', () => ({
  useDashboardData: () => state.dashboard,
}));

// --- Context + hook stubs shared by every page under test -------------------

vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: () => ({
    currentOrganization: { id: 'org-1', name: 'Smoke FC' },
    currentSeasonSetting: { id: 'season-1', timezone: 'America/New_York' },
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
    from: () => createChainMock({ data: [], error: null }),
    rpc: async () => ({ data: null, error: null }),
    auth: { getSession: async () => ({ data: { session: null }, error: null }) },
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
    practice: { summary: null, snapshot: null, generatedAt: null, runId: null, assignments: [] },
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
  return render(
    <MemoryRouter>
      <PracticeSchedulingPage />
    </MemoryRouter>
  );
}

const REASON = 'Only an organization admin can apply a practice schedule.';

describe('practice Apply is for org admins only (#64)', () => {
  it('a coach sees Apply, disabled, described by the reason', async () => {
    // The premise: a coach CAN manage the schedule, so reaches the review.
    expect(ROLE_PERMISSIONS[ROLES.COACH]).toContain(PERMISSIONS.MANAGE_SCHEDULE);
    expect(ROLE_PERMISSIONS[ROLES.COACH]).not.toContain(PERMISSIONS.MANAGE_ORGANIZATION);
    renderAs(ROLES.COACH);

    const apply = await screen.findByRole('button', { name: /apply schedule/i });
    expect(apply).toBeDisabled();
    expect(apply).toHaveAccessibleDescription(REASON);
    expect(screen.getByText(REASON)).toBeVisible();
  });

  it('an admin sees Apply enabled, with no reason', async () => {
    renderAs(ROLES.ADMIN);
    const apply = await screen.findByRole('button', { name: /apply schedule/i });
    expect(apply).not.toBeDisabled();
    expect(apply).not.toHaveAttribute('aria-describedby');
    expect(screen.queryByText(REASON)).toBeNull();
  });
});
