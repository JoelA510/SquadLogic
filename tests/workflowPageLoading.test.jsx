/**
 * Defect A -- `WorkflowPage` read the `loading` OBJECT as a boolean.
 *
 * `useDashboardData` returns `loading` as `{ team, practice, game }`. The page
 * read it twice as a scalar:
 *
 *   * `if (loading && !team) return <LoadingScreen .../>` -- `loading` is an
 *     object literal the hook rebuilds every render and `team` is
 *     `resolvedTeam`, another unconditional object literal, so the condition
 *     was permanently false and that screen had never once been seen;
 *   * `{loading && <IngestionOverlay />}` -- reduced to `{true && ...}`, and
 *     harmless only because the overlay self-gates on its own `isVisible`.
 *
 * `DashboardWorkflow`, further down the same file, consumed the same value
 * correctly as an object. The hook's shape was right; these two reads were
 * the defect.
 *
 * **No page-level loading screen replaced it, and these cases pin that
 * decision as much as the fix.** Neither available gate is correct: on
 * `loading.team` it would hide `DashboardWorkflow`'s live "Generating
 * Teams..." progress bar, because `useTeamSummary` holds that flag true for
 * the WHOLE of a running teaming job (`useTeamSummary.js:92`, re-polling
 * every 2s); on anything true at first paint it would blank the dashboard on
 * every navigation, since the route is lazy and the hooks remount each visit.
 *
 * What the dead branch was groping at is real, and it is per-source: while a
 * source is in flight the page cannot say what that source found. Unguarded
 * it asserted `0%`, three Pending/Unscheduled/In Progress rows and "Your
 * season hasn't started yet" over a fully scheduled season, every visit, for
 * as long as the fetches took. So each claim now waits on its own flag.
 *
 * Kept in its own file because `vi.mock` is file-wide: these cases stub
 * `DashboardWorkflow` out to isolate the page's own sidebar, and the
 * defect-B cases in `dashboardWiring.test.jsx` need the real one.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

/**
 * Code only. The page now carries a long docblock naming the very expressions
 * the scan below looks for, so a check that could not tell that prose from a
 * live read would force the explanation to be deleted to stay green.
 */
const codeOf = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

const dash = vi.hoisted(() => ({
  /** @type {any} */ value: null,
}));

vi.mock('../frontend/src/hooks/useDashboardData.js', () => ({
  useDashboardData: () => dash.value,
}));
vi.mock('../frontend/src/hooks/useTeamPersistence.js', () => ({
  useTeamPersistence: () => ({ persistenceSnapshot: null, loading: false }),
}));
vi.mock('../frontend/src/contexts/ImportContext.jsx', () => ({
  useImport: () => ({
    importedData: null,
    setImportedData: () => {},
    isImporting: false,
    progress: 0,
    activeJob: null,
    importStatus: 'idle',
  }),
}));
vi.mock('../frontend/src/contexts/ThemeContext.jsx', () => ({
  useTheme: () => ({ theme: 'light' }),
}));
vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: () => ({ currentOrganization: { id: 'org-1', name: 'Smoke FC' } }),
}));
vi.mock('../frontend/src/components/DashboardWorkflow.jsx', () => ({ default: () => null }));
vi.mock('../frontend/src/components/ui/FeatureGuard.jsx', () => ({
  FeatureGuard: ({ children }) => children,
}));

const { default: WorkflowPage } = await import('../frontend/src/pages/WorkflowPage.jsx');

/** The exact shape `useDashboardData` returns, so the page is fed no fiction. */
function dashboardData({ loading, team = {}, practice = {}, game = {} }) {
  return {
    loading,
    error: null,
    roadmap: { sections: [], stats: { completed: 0, pending: 0 } },
    team: { summary: null, generatedAt: null, status: 'idle', progress: 0, ...team },
    practice: { summary: null, snapshot: {}, generatedAt: null, ...practice },
    game: { summary: null, snapshot: {}, warnings: [], generatedAt: null, ...game },
  };
}

function renderWorkflowPage(value) {
  dash.value = value;
  return render(
    <MemoryRouter>
      <WorkflowPage />
    </MemoryRouter>
  );
}

const ALL_LOADING = { team: true, practice: true, game: true };
const NONE_LOADING = { team: false, practice: false, game: false };

describe('WorkflowPage makes no claim about a source still in flight', () => {
  beforeEach(() => {
    dash.value = null;
  });

  it('while all three are loading it asserts neither a score nor an empty season', () => {
    renderWorkflowPage(dashboardData({ loading: ALL_LOADING }));
    // Meta-assertion: the page really rendered, so every `queryBy... === null`
    // below is a fact about the sidebar and not about an empty DOM.
    expect(screen.getByRole('heading', { name: 'Season Setup Workflow' })).toBeTruthy();

    expect(screen.queryByText(/hasn.t started yet/)).toBeNull();
    expect(screen.queryByText('0%')).toBeNull();
    expect(screen.getByText('—')).toBeTruthy();
    expect(screen.queryByText('Pending')).toBeNull();
    expect(screen.queryByText('Unscheduled')).toBeNull();
    expect(screen.queryByText('In Progress')).toBeNull();
    expect(screen.getAllByText('Checking…')).toHaveLength(3);
  });

  it('negative control: once all three have answered it says the season is empty', () => {
    renderWorkflowPage(dashboardData({ loading: NONE_LOADING }));
    expect(screen.getByText(/hasn.t started yet/)).toBeTruthy();
    expect(screen.getByText('0%')).toBeTruthy();
    expect(screen.getByText('Pending')).toBeTruthy();
    expect(screen.getByText('Unscheduled')).toBeTruthy();
    expect(screen.getByText('In Progress')).toBeTruthy();
    expect(screen.queryByText('Checking…')).toBeNull();
  });

  it('each row waits on its OWN flag, not on all three together', () => {
    // The single-boolean reading could only ever have moved all three rows
    // at once; this is the case that tells the object read from the scalar.
    renderWorkflowPage(dashboardData({ loading: { team: false, practice: true, game: false } }));
    expect(screen.getByText('Pending')).toBeTruthy(); // team answered: no run
    expect(screen.getAllByText('Checking…')).toHaveLength(1); // practice alone
    expect(screen.getByText('In Progress')).toBeTruthy(); // game answered
  });

  it('a running teaming job says Generating, not Checking', () => {
    // `useTeamSummary` holds `loading.team` true for the whole of a run, so
    // "Checking..." would sit there for minutes while `DashboardWorkflow`
    // shows a live progress bar for the same run.
    renderWorkflowPage(
      dashboardData({ loading: { ...NONE_LOADING, team: true }, team: { status: 'running' } })
    );
    expect(screen.getByText('Generating')).toBeTruthy();
    expect(screen.queryByText('Checking…')).toBeNull();
  });

  it('a populated season reports its real score and never flashes the welcome panel', () => {
    renderWorkflowPage(
      dashboardData({
        loading: NONE_LOADING,
        team: { generatedAt: '2026-01-01T00:00:00Z' },
        practice: { generatedAt: '2026-01-02T00:00:00Z' },
        game: { generatedAt: '2026-01-03T00:00:00Z' },
      })
    );
    expect(screen.getByText('100%')).toBeTruthy();
    expect(screen.queryByText(/hasn.t started yet/)).toBeNull();
    expect(screen.getByText('Complete')).toBeTruthy();
    expect(screen.getByText('Optimized')).toBeTruthy();
    expect(screen.getByText('Finalized')).toBeTruthy();
  });

  it('a re-run over a populated season keeps the score it already knows', () => {
    // In flight is not the same as unknown. `readinessScore` is built from
    // the three `generatedAt` values, so a source that has already reported
    // contributes a known figure whatever its fetch is doing now. Gating the
    // aggregate on the raw flag would blank a real 100% to "—" for the whole
    // of a teaming re-run, beside three rows still reading Complete.
    renderWorkflowPage(
      dashboardData({
        loading: { ...NONE_LOADING, team: true },
        team: { generatedAt: '2026-01-01T00:00:00Z', status: 'running' },
        practice: { generatedAt: '2026-01-02T00:00:00Z' },
        game: { generatedAt: '2026-01-03T00:00:00Z' },
      })
    );
    expect(screen.getByText('100%')).toBeTruthy();
    expect(screen.queryByText('—')).toBeNull();
    // ...and the row still reports the run that is happening.
    expect(screen.getByText('Complete')).toBeTruthy();
  });

  it('the dead LoadingScreen branch is gone, and nothing blanks the page in its place', () => {
    // The old branch returned a bare `LoadingScreen` INSTEAD of the page.
    // Both states below must still render the real dashboard.
    for (const loading of [ALL_LOADING, NONE_LOADING]) {
      const { unmount } = renderWorkflowPage(dashboardData({ loading }));
      expect(screen.getByRole('heading', { name: 'Season Setup Workflow' })).toBeTruthy();
      expect(screen.getByText('League Status')).toBeTruthy();
      unmount();
    }
  });
});

describe('WorkflowPage no longer reads the loading object as a scalar', () => {
  const PAGE = 'frontend/src/pages/WorkflowPage.jsx';

  it('positive control: the scan finds the per-field reads it should find', () => {
    const source = read(PAGE);
    const code = codeOf(source);
    // Meta-assertions: the file was really read, and the stripper really
    // stripped, so a later "no match" is about the code and not about an
    // empty string or a path typo.
    expect(source.length).toBeGreaterThan(2000);
    expect(code.length).toBeLessThan(source.length);
    expect(code).toMatch(/loading\?\.team/);
    expect(code).toMatch(/loading\?\.practice/);
    expect(code).toMatch(/loading\?\.game/);
  });

  it('no bare `loading &&` or `loading ?` survives in code', () => {
    const code = codeOf(read(PAGE));
    // `loading` followed by a boolean or ternary operator is the scalar read;
    // `loading?.team` and the destructuring binding are not. Shown working on
    // the two expressions that really used to be in this file, and shown NOT
    // firing on the two legitimate forms that remain.
    const scalar = /\bloading\s*(&&|\|\||\?[^.])/;
    expect(scalar.test('if (loading && !team) {')).toBe(true);
    expect(scalar.test('{loading && <IngestionOverlay />}')).toBe(true);
    expect(scalar.test('const x = loading?.team;')).toBe(false);
    expect(scalar.test('const { team, loading, error } = useDashboardData();')).toBe(false);
    expect(scalar.test(code)).toBe(false);
  });

  it('the IngestionOverlay is mounted unconditionally, not behind a dead guard', () => {
    // Its visibility is an ImportContext concern decided inside the
    // component; the dashboard-fetch flag was never related to it and never
    // subtracted anything. Pinned at the source because the two forms are
    // behaviourally identical -- `loading` can never be falsy -- so no render
    // could tell them apart, and a test claiming otherwise would be hollow.
    const code = codeOf(read(PAGE));
    expect(code).toContain('<IngestionOverlay />');
    expect(code).not.toMatch(/\{\s*loading\s*&&\s*<IngestionOverlay/);
  });
});
