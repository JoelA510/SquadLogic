// #64: applying a practice schedule REPLACES the season's schedule, and the
// server lets only an org admin do it. The page must not offer anyone else an
// Apply that always ends in a 403: it is disabled, and says why, readably.
//
// Rendered as the real page with its data hooks stubbed (the pattern
// dashboardErrorConsumers.test.jsx established), driven into the review state
// by a completed auto-scheduler result -- the state in which Apply exists.
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemoryRouter } from 'react-router-dom';
import { createChainMock } from './helpers/index.js';
import { PERMISSIONS, ROLE_PERMISSIONS, ROLES } from '../frontend/src/constants/permissions.js';

const state = vi.hoisted(() => ({
  /** @type {string[]} */ permissions: [],
  /** @type {any} */ dashboard: null,
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

// #64, the operator's condition: "warnings for each team that is missing a
// practice". The RPC list and the builder are proven elsewhere; this drives the
// HAND-OFF -- Apply, the real `persistPracticeScheduleReview` (stubbed only at
// its `fetch`, the lowest seam the page calls), the response it returns, and
// the page's alert -- so a break anywhere between the Edge response and the
// screen goes red here.
describe('after Apply, every team without a practice is named with its reason (#64)', () => {
  const TEAMS_WITHOUT_PRACTICE = [
    { team_id: 'team-hawks', team_name: 'Hawks', had_prior_rows: false },
    { team_id: 'team-owls', team_name: 'Owls', had_prior_rows: true },
  ];

  it('lists Hawks with the solver reason and Owls as not scheduled, having lost a practice', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 'success',
          runId: 'run-review-1',
          supersededCount: 1,
          retainedManualCount: 0,
          retainedManual: [],
          teamsWithoutPractice: TEAMS_WITHOUT_PRACTICE,
          audited: true,
          auditGap: null,
          message: 'Persistence successful.',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );
    try {
      renderAs(ROLES.ADMIN);
      const apply = await screen.findByRole('button', { name: /apply schedule/i });
      // The slot read resolves after mount; Apply refuses a review whose slot
      // it has not loaded, which is not what this test is about.
      await waitFor(() => expect(apply).not.toBeDisabled());
      fireEvent.click(apply);

      const list = await screen.findByRole('list', { name: 'Teams without a practice' });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(String(fetchSpy.mock.calls[0][0])).toMatch(/practice-persistence$/);

      const alert = /** @type {HTMLElement} */ (list.closest('[role="alert"]'));
      expect(alert).not.toBeNull();
      expect(within(alert).getByText('2 team(s) have no practice after this save:')).toBeVisible();
      const items = within(list)
        .getAllByRole('listitem')
        .map((li) => li.textContent);
      expect(items).toEqual([
        'Hawks: no slot fits the coach availability',
        'Owls: not in this schedule; an earlier practice was removed',
      ]);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('the Edge Function passes the RPC list through, not a derived one', () => {
    // The one link this render cannot execute: vitest cannot load the Deno
    // function. Pinned at the source, as `practicePersistenceUserClient.test.js`
    // pins its client.
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const edge = readFileSync(
      path.join(root, 'supabase/functions/practice-persistence/index.ts'),
      'utf8'
    );
    expect(edge).toMatch(/teamsWithoutPractice:\s*report\.teams_without_practice\s*\?\?\s*\[\]/);
  });
});
