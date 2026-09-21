/**
 * Five consumers of `useDashboardData` destructured it and took no `error`.
 *
 * The hook stopped swallowing its three fetch failures and started returning
 * a message; `WorkflowPage` was the only caller that read it. For the other
 * five an RLS refusal or a dropped connection arrived as `undefined`
 * everywhere it mattered — `team.teams`, `practice.generatedAt`,
 * `game.assignments` — and every one of those renders as the empty state.
 * The operator was told the season was empty, not that it could not be read.
 *
 * **Every case here renders the real page and asserts on the DOM.** A
 * source-text scan for `error:` would go red against the unfixed code just as
 * well and prove nothing about whether anything reaches a screen — the
 * hollow-guarantee shape CLAUDE.md section 3 names. So each case mounts the
 * component, asserts the banner carries the message, and carries a
 * meta-assertion that the page itself rendered, so a `getByTestId` failure
 * can never be mistaken for an empty DOM and, more importantly, a passing
 * case can never be a banner floating in isolation.
 *
 * Each case is paired with a negative twin: the same page with `error: null`
 * must render NO banner. Without it "the banner is always on" would pass
 * every positive case in the file.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createChainMock } from './helpers/index.js';

const BANNER = 'data-error-banner';
const MESSAGE = 'permission denied for table scheduler_runs';

const dash = vi.hoisted(() => ({ /** @type {any} */ value: null }));

vi.mock('../frontend/src/hooks/useDashboardData.js', () => ({
  useDashboardData: () => dash.value,
}));

// --- Context + hook stubs shared by every page under test -------------------

vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: () => ({
    currentOrganization: { id: 'org-1', name: 'Smoke FC' },
    currentSeasonSetting: { timezone: 'America/New_York' },
    featureFlags: {},
    permissions: [],
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

const { default: WorkflowPage } = await import('../frontend/src/pages/WorkflowPage.jsx');
const { default: ExportsPage } = await import('../frontend/src/pages/ExportsPage.jsx');
const { default: GameSchedulingPage } =
  await import('../frontend/src/pages/GameSchedulingPage.jsx');
const { default: PracticeSchedulingPage } =
  await import('../frontend/src/pages/PracticeSchedulingPage.jsx');
const { default: TeamAnalysisPage } = await import('../frontend/src/pages/TeamAnalysisPage.jsx');
const { default: SetupChecklist } =
  await import('../frontend/src/components/setup/SetupChecklist.jsx');
const { default: DashboardPage } = await import('../frontend/src/pages/DashboardPage.jsx');

/**
 * The exact shape `useDashboardData` returns, so no page is fed a fiction it
 * could not receive in production. Only `error` varies between the positive
 * and negative twin of each case.
 *
 * @param {string|null} error
 */
function dashboardData(error) {
  return {
    loading: { team: false, practice: false, game: false },
    error,
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
      assignments: undefined,
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

function renderPage(Page, error) {
  dash.value = dashboardData(error);
  return render(
    <MemoryRouter>
      <Page />
    </MemoryRouter>
  );
}

/**
 * Every page under test, with the landmark that proves it mounted.
 *
 * The heading list is written out per page rather than derived from the
 * render, which would be the same set-against-itself shape CLAUDE.md warns
 * about: a page that silently failed to mount would then "prove" it mounted
 * against whatever it did render.
 */
const PAGES = [
  { name: 'WorkflowPage', Page: WorkflowPage, heading: 'Season Setup Workflow' },
  { name: 'GameSchedulingPage', Page: GameSchedulingPage, heading: 'Game Scheduling' },
  { name: 'PracticeSchedulingPage', Page: PracticeSchedulingPage, heading: 'Practice Scheduling' },
  { name: 'TeamAnalysisPage', Page: TeamAnalysisPage, heading: 'Teaming & Analysis' },
  { name: 'ExportsPage', Page: ExportsPage, heading: 'Exports' },
];

/**
 * Every module under `frontend/src` that calls `useDashboardData()`, by
 * basename. Enumerated from the source tree rather than from the list under
 * test, and from the WHOLE tree rather than from `pages/`, so a consumer
 * added under `hooks/` or `components/` fails this rather than slipping past
 * a directory the check never looks at.
 *
 * The match is on the call `useDashboardData(`, not the bare identifier, so
 * the import lines and the several comments that now discuss the hook by
 * name are not counted as consumers.
 */
function consumersOfHook() {
  const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../frontend/src');
  /** @type {string[]} */
  const found = [];

  /** @param {string} dir */
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.jsx?$/.test(entry.name)) continue;
      const source = readFileSync(full, 'utf8');
      // The hook's own definition is not one of its consumers.
      if (source.includes('export function useDashboardData(')) continue;
      if (source.includes('useDashboardData(')) found.push(entry.name.replace(/\.jsx?$/, ''));
    }
  };

  walk(srcDir);
  return found.sort();
}

describe('every page consuming useDashboardData reports a failed load', () => {
  beforeEach(() => {
    dash.value = null;
  });

  for (const { name, Page, heading } of PAGES) {
    it(`${name} renders the error as an alert`, () => {
      renderPage(Page, MESSAGE);

      // Meta-assertion. Without it a page that threw or rendered nothing
      // would make the banner assertion below a statement about an empty DOM.
      expect(screen.getByRole('heading', { name: heading })).toBeTruthy();

      const banner = screen.getByTestId(BANNER);
      expect(banner).toHaveTextContent(MESSAGE);
      // The operator is not required to be looking at the page. An error is
      // assertive, not polite (CLAUDE.md section 9 / WCAG 2.2 AA).
      expect(banner.getAttribute('role')).toBe('alert');
    });

    it(`${name} renders no banner when the load succeeded`, () => {
      renderPage(Page, null);

      expect(screen.getByRole('heading', { name: heading })).toBeTruthy();
      expect(screen.queryByTestId(BANNER)).toBeNull();
    });
  }

  it('covers every consumer of the hook, enumerated from the filesystem', () => {
    // The universe comes from the source tree, NOT from `PAGES` above --
    // deriving it from the list under test would compare a set against
    // itself and a seventh consumer added later would be silently uncovered.
    //
    // The scan is the WHOLE of `frontend/src`, not `pages/`. Scoping it to
    // one directory was the same fault one level up: `useSetupProgress` is a
    // consumer, it lives in `hooks/`, and a pages-only universe could not
    // have seen it -- so a consumer added under `hooks/` or `components/`
    // would have been silently uncovered by the very check written to stop
    // that. `useSetupProgress` is covered by the second describe below.
    const consumers = consumersOfHook();

    // Meta-assertion on the meta-assertion: a broken scan that matched
    // nothing would otherwise make the comparison below trivially true.
    expect(consumers.length).toBeGreaterThan(0);
    expect(consumers).toEqual([...PAGES.map((p) => p.name), 'useSetupProgress'].sort());
  });

  it('the enumeration can fail -- a consumer missing from the list is caught', () => {
    // The check above is only worth its line count if it can go red. Drop one
    // page from the expected list and the same comparison must reject it;
    // otherwise `toEqual` is passing on something other than the set.
    const consumers = consumersOfHook();
    const short = [...PAGES.map((p) => p.name), 'useSetupProgress'].sort().slice(1);

    expect(consumers).not.toEqual(short);
    expect(consumers.length).toBe(short.length + 1);
  });
});

describe('useSetupProgress passes the error through to both its consumers', () => {
  it('returns the error rather than deriving progress from data it could not read', async () => {
    const { renderHook } = await import('@testing-library/react');
    const { useSetupProgress } = await import('../frontend/src/hooks/useSetupProgress.js');

    dash.value = dashboardData(MESSAGE);
    const { result } = renderHook(() => useSetupProgress());

    expect(result.current.error).toBe(MESSAGE);
    // The point of passing it through: the three run-derived steps HAVE
    // fallen back to "not done", and without the error that is a false claim
    // about the operator's season rather than a missing one.
    const derived = result.current.steps.filter((s) =>
      ['teams', 'practices', 'games'].includes(s.id)
    );
    expect(derived).toHaveLength(3);
    expect(derived.every((s) => s.done === false)).toBe(true);
  });

  it('returns no error when the load succeeded', async () => {
    const { renderHook } = await import('@testing-library/react');
    const { useSetupProgress } = await import('../frontend/src/hooks/useSetupProgress.js');

    dash.value = dashboardData(null);
    const { result } = renderHook(() => useSetupProgress());

    expect(result.current.error).toBeNull();
  });

  // A hook renders nothing, so "the hook passes it through" is only half the
  // claim. These two cases are the other half: without them `error` would be
  // a field returned and never read -- the shape CLAUDE.md section 3 calls
  // "parsed and unread" -- and the operator would still see an understated
  // checklist with nothing to explain it. Both consumers run the REAL
  // `useSetupProgress` here; only `useDashboardData` beneath it is stubbed.
  const CONSUMERS = [
    {
      name: 'SetupChecklist',
      render: () => <SetupChecklist />,
      // Text that exists only once the checklist itself has rendered.
      progressProof: /Progress is saved automatically/,
    },
    {
      name: 'DashboardPage Season Setup card',
      render: () => <DashboardPage />,
      progressProof: 'Season Setup',
    },
  ];

  for (const { name, render: renderConsumer, progressProof } of CONSUMERS) {
    it(`${name} shows the error beside the progress it understates`, async () => {
      dash.value = dashboardData(MESSAGE);
      render(<MemoryRouter>{renderConsumer()}</MemoryRouter>);

      // Meta-assertion: the checklist this banner qualifies is really on
      // screen. `findBy` rather than `getBy` because `DashboardPage` gates
      // its whole body behind an async `loaded` and would otherwise be
      // asserted against its loading screen.
      expect(await screen.findByText(progressProof)).toBeTruthy();
      expect(screen.getByTestId(BANNER)).toHaveTextContent(MESSAGE);
    });

    it(`${name} shows no error when the load succeeded`, async () => {
      dash.value = dashboardData(null);
      render(<MemoryRouter>{renderConsumer()}</MemoryRouter>);

      expect(await screen.findByText(progressProof)).toBeTruthy();
      expect(screen.queryByTestId(BANNER)).toBeNull();
    });
  }
});

/**
 * `DashboardPage` held a SECOND hand-rolled red alert — `role="alert"` on a
 * `.badge danger` sized back up with inline padding — for the
 * `location.state.error` that `ProtectedRoute` redirects there with. It was
 * in the same file this PR gives a shared banner to, so leaving it would have
 * been the sixth copy in a change whose point is that there should be one.
 * These cases pin the migration, including the case that made it worth doing:
 * both reds on screen together.
 */
describe('DashboardPage routes its ProtectedRoute error through the same banner', () => {
  const ROUTE_ERROR = 'Unauthorized access';

  /** @param {{ error?: string }} [state] */
  const renderDashboard = (state) =>
    render(
      <MemoryRouter initialEntries={[{ pathname: '/', state }]}>
        <DashboardPage />
      </MemoryRouter>
    );

  it('renders the redirect error in the shared banner', async () => {
    dash.value = dashboardData(null);
    renderDashboard({ error: ROUTE_ERROR });

    // Meta-assertion: the dashboard itself is on screen, so the banner below
    // is not being read off an empty or crashed render.
    expect(await screen.findByText('Season Setup')).toBeTruthy();

    const banner = screen.getByTestId(BANNER);
    expect(banner).toHaveTextContent(ROUTE_ERROR);
    expect(banner.getAttribute('role')).toBe('alert');
  });

  it('renders no banner when the redirect carried no error', async () => {
    dash.value = dashboardData(null);
    renderDashboard(undefined);

    expect(await screen.findByText('Season Setup')).toBeTruthy();
    expect(screen.queryByTestId(BANNER)).toBeNull();
  });

  it('renders both reds as the same component when they coincide', async () => {
    // The reason the migration is in this PR rather than deferred: an
    // unauthorized redirect onto a dashboard whose reads are also failing put
    // two differently-styled red alerts on one screen. Two banners is
    // correct — they are different errors — but they must now be one
    // component, so this asserts the count AND that neither is the old
    // `.badge danger` markup.
    dash.value = dashboardData(MESSAGE);
    const { container } = renderDashboard({ error: ROUTE_ERROR });

    expect(await screen.findByText('Season Setup')).toBeTruthy();

    const banners = screen.getAllByTestId(BANNER);
    expect(banners).toHaveLength(2);
    expect(banners.map((b) => b.textContent)).toEqual(
      expect.arrayContaining([
        expect.stringContaining(ROUTE_ERROR),
        expect.stringContaining(MESSAGE),
      ])
    );
    expect(container.querySelector('.badge.danger[role="alert"]')).toBeNull();
  });
});
