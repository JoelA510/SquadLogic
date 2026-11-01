// A completed season is read-only (Phase E3b; Codex's finding on #680): the practice page turns
// its generate, apply and manual override off and says why, instead of letting the database refuse
// the write (`season_schedule_readonly_when_completed`, 22023 `season_completed`). Rendered as the
// real page with its data hooks stubbed, in the review state where Apply exists (the pattern
// practiceApplyAdminGate.test.jsx established); the control is the same page on an active season.
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { createChainMock } from './helpers/index.js';
import { ROLE_PERMISSIONS, ROLES } from '../frontend/src/constants/permissions.js';
import { MOCK_ORG_ID, MOCK_SEASON_ID } from '../frontend/src/lib/mockSeedIds.js';

const state = vi.hoisted(() => ({
  /** @type {string[]} */ permissions: [],
  /** @type {any} */ dashboard: null,
  seasonStatus: 'active',
  schedulerResult: {
    runId: 'run-review-1',
    assignments: [{ teamId: 'team-1', slotId: 'slot-1', source: 'auto' }],
    // The solver's own reason for Hawks; Owls has none (it is simply not in
    // this schedule).
    unassigned: [{ teamId: 'team-hawks', reason: 'no slot fits the coach availability' }],
  },
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
    currentSeasonSetting: {
      id: MOCK_SEASON_ID,
      timezone: 'America/New_York',
      name: 'Spring 2026',
      status: state.seasonStatus,
    },
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
    rpc: async () => ({ data: null, error: null }),
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
  return render(
    <MemoryRouter>
      <PracticeSchedulingPage />
    </MemoryRouter>
  );
}

const NOTE = 'season-readonly-note';

describe('the practice page on a completed season', () => {
  it('turns Apply and the auto-scheduler off, hides the manual override, and says why', async () => {
    state.seasonStatus = 'completed';
    renderAs(ROLES.ADMIN);
    expect(await screen.findByTestId(NOTE)).toHaveTextContent('completed and read-only');
    const apply = await screen.findByRole('button', { name: /apply schedule/i });
    expect(apply).toBeDisabled();
    expect(screen.getByRole('button', { name: /auto-generate/i })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /manual override/i })).toBeNull();
    // Not an admin-only message: the person is an admin.
    expect(
      screen.queryByText('Only an organization admin can apply a practice schedule.')
    ).toBeNull();
  });

  it('CONTROL: the same page on an active season has Apply enabled and no note', async () => {
    state.seasonStatus = 'active';
    renderAs(ROLES.ADMIN);
    const apply = await screen.findByRole('button', { name: /apply schedule/i });
    await waitFor(() => expect(apply).not.toBeDisabled());
    expect(screen.queryByTestId(NOTE)).toBeNull();
    expect(screen.getByRole('button', { name: /manual override/i })).toBeInTheDocument();
  });
});
