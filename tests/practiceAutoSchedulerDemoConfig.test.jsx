// The practice page's auto-scheduler request: a demo league asks for a short search (its CPU
// would otherwise pass the Edge Function's 2 s ceiling), a real organization keeps the default.
// Rendered as the real page with its data hooks stubbed (practiceApplyAdminGate.test.jsx's pattern).
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { createChainMock } from './helpers/index.js';
import { ROLE_PERMISSIONS, ROLES } from '../frontend/src/constants/permissions.js';
import { MOCK_ORG_ID, MOCK_SEASON_ID } from '../frontend/src/lib/mockSeedIds.js';

const state = vi.hoisted(() => ({
  /** @type {any[]} */ triggers: [],
  /** @type {string | null} */ demoExpiresAt: null,
  /** @type {string[]} */ permissions: [],
  /** @type {any} */ dashboard: null,
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
    currentOrganization: {
      id: MOCK_ORG_ID,
      name: 'Smoke FC',
      demo_expires_at: state.demoExpiresAt,
    },
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
    status: 'idle',
    progress: null,
    result: null,
    error: null,
    trigger: (/** @type {any} */ input) => {
      state.triggers.push(input);
    },
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
      teams: [{ id: 'team-1', name: 'Hawks', division: 'U10', coachId: null }],
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

function renderPage() {
  state.permissions = ROLE_PERMISSIONS[ROLES.ADMIN];
  state.dashboard = dashboardData();
  state.triggers = [];
  return render(
    <MemoryRouter>
      <PracticeSchedulingPage />
    </MemoryRouter>
  );
}

async function runOptimizer() {
  const run = await screen.findByRole('button', { name: /run auto-scheduler optimization/i });
  // The slots and the season's practices load after mount; the button enables when they have.
  await waitFor(() => expect(run).not.toBeDisabled());
  fireEvent.click(run);
  await waitFor(() => expect(state.triggers).toHaveLength(1));
  return state.triggers[0].config;
}

// The Edge Function's CPU ceiling is 2 s per request and the optimizer's CPU is its iterations
// (measured: the seeded demo's 128 teams take 2.06-2.41 s at 1000 iterations, about 0.45 s at 100),
// so a demo asks for a short search and a real league is untouched.
describe('the auto-scheduler request carries a demo-sized search only in a demo', () => {
  it('asks for 150 iterations and a one-second budget in a demo', async () => {
    state.demoExpiresAt = '2099-01-01T00:00:00.000Z';
    renderPage();
    expect(await runOptimizer()).toEqual({ timeBudgetMs: 1000, maxIterations: 150, seed: 42 });
  });

  it('keeps 1000 iterations and the 8 s budget in a real organization', async () => {
    state.demoExpiresAt = null;
    renderPage();
    expect(await runOptimizer()).toEqual({ timeBudgetMs: 8000, maxIterations: 1000, seed: 42 });
  });
});
