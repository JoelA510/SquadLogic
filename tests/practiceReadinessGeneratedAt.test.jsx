/**
 * LIVE-8: the "Generated ..." line that could never render, and the status
 * item that could never turn green.
 *
 * `PracticeReadinessPanel` guarded on `practiceReadinessSnapshot.lastCalculated`
 * and `WorkflowPage` derived "Practice Slots: Optimized" from
 * `practice.lastCalculated`. Nothing in the repository ever wrote that field --
 * the snapshot is `scheduler_runs.results` verbatim, i.e. `practiceMetrics`'
 * report, and `useDashboardData`'s practice object has no such key either. So
 * both readers were permanently false: the header never appeared and the status
 * item said "Unscheduled" over a scheduled season, while the readiness score
 * three declarations above it counted the same season as 30% done off
 * `practice?.generatedAt`.
 *
 * **The universe of "what the snapshot contains" is taken from the engine, not
 * from a literal written here.** A fixture that simply omits `lastCalculated`
 * proves only that this file omitted it. `evaluatePracticeSchedule` is called
 * and its own keys are the subject set, so re-introducing the field in the
 * engine changes this test's answer -- and so does deleting `generatedAt` from
 * the mapper.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { evaluatePracticeSchedule } from '@squadlogic/core/practiceMetrics.js';
import { mapSchedulerRunToPracticeSummary } from '@squadlogic/core/utils/practiceSummaryMapper.js';
import { makeSchedulerRun } from './factories/index.js';
import PracticeReadinessPanel from '../frontend/src/components/PracticeReadinessPanel.jsx';
import { formatDateTime } from '../frontend/src/utils/formatters.js';

const COMPLETED_AT = '2026-03-04T17:45:00Z';

/** The real engine report a practice run persists into `scheduler_runs.results`. */
function engineReport() {
  return evaluatePracticeSchedule({ assignments: [], unassigned: [], teams: [], slots: [] });
}

describe('the practice snapshot does not carry its own timestamp', () => {
  it('the engine report has no lastCalculated, which is why the readers were dead', () => {
    const report = engineReport();
    // Meta-assertion: the report really is a populated object, so "the key is
    // absent" is a statement about the engine rather than about an empty one.
    expect(Object.keys(report).length).toBeGreaterThan(5);
    expect(Object.keys(report)).toContain('summary');
    expect(report).not.toHaveProperty('lastCalculated');
  });

  it('the mapper lifts the run timestamp as generatedAt and copies results through untouched', () => {
    const results = engineReport();
    const run = makeSchedulerRun({
      run_type: 'practice',
      results,
      completed_at: COMPLETED_AT,
      created_at: '2026-03-01T00:00:00Z',
    });

    const mapped = mapSchedulerRunToPracticeSummary(run);

    expect(mapped.generatedAt).toBe(COMPLETED_AT);
    // The snapshot the panel is handed is the engine report itself, so it
    // cannot have acquired a timestamp on the way.
    expect(mapped.practiceReadinessSnapshot).toBe(results);
    expect(mapped.practiceReadinessSnapshot).not.toHaveProperty('lastCalculated');
  });

  it('falls back to created_at when the run has no completion time', () => {
    const run = makeSchedulerRun({
      run_type: 'practice',
      results: engineReport(),
      completed_at: null,
      created_at: '2026-03-01T00:00:00Z',
    });
    expect(mapSchedulerRunToPracticeSummary(run).generatedAt).toBe('2026-03-01T00:00:00Z');
  });
});

describe('PracticeReadinessPanel renders the run timestamp it is given', () => {
  function renderPanel(props) {
    return render(<PracticeReadinessPanel {...props} />);
  }

  it('shows "Generated ..." from the mapper output the page really passes', () => {
    const mapped = mapSchedulerRunToPracticeSummary(
      makeSchedulerRun({ run_type: 'practice', results: engineReport(), completed_at: COMPLETED_AT })
    );

    renderPanel({
      practiceReadinessSnapshot: mapped.practiceReadinessSnapshot,
      generatedAt: mapped.generatedAt,
    });

    expect(screen.getByText(`Generated ${formatDateTime(COMPLETED_AT)}`)).toBeInTheDocument();
  });

  it('positive control: the same snapshot with no generatedAt renders no header line', () => {
    const mapped = mapSchedulerRunToPracticeSummary(
      makeSchedulerRun({ run_type: 'practice', results: engineReport(), completed_at: COMPLETED_AT })
    );

    renderPanel({ practiceReadinessSnapshot: mapped.practiceReadinessSnapshot });

    // This is the state the component was permanently in before the fix: the
    // snapshot alone can never produce the line.
    expect(screen.queryByText(/^Generated /)).toBeNull();
    // ...and the panel still renders, so the absence above is not an empty DOM.
    expect(screen.getByRole('heading', { name: 'Practice Readiness' })).toBeInTheDocument();
  });
});

/**
 * The boring arm, and the one the defect actually shipped in.
 *
 * Driven from the leaf `useSchedulerRun` seam rather than from a hand-built
 * `useDashboardData` return, so the real mapper, the real `usePracticeSummary`
 * and the real `useDashboardData` all run: a shape that only this file could
 * produce would prove nothing about the page.
 */
const runState = vi.hoisted(() => ({
  /** @type {Record<string, any>} */ byType: { team: null, practice: null, game: null },
}));

vi.mock('../frontend/src/hooks/useSchedulerRun.js', () => ({
  useSchedulerRun: (runType, mapper, emptyState) => {
    const run = runState.byType[runType];
    const mapped = run ? mapper(run) : null;
    return { data: mapped ?? emptyState, evaluation: null, loading: false, error: null };
  },
}));
vi.mock('../frontend/src/hooks/useTeamSummary.js', () => ({
  useTeamSummary: () => ({ summary: null, loading: false, generatedAt: null }),
}));
vi.mock('../frontend/src/hooks/usePracticeAssignments.js', () => ({
  usePracticeAssignments: () => ({ assignments: [], loading: false, error: null }),
}));
vi.mock('../frontend/src/hooks/useGameAssignments.js', () => ({
  useGameAssignments: () => ({ assignments: [], loading: false, error: null }),
}));
vi.mock('../frontend/src/hooks/useTeamPersistence.js', () => ({
  useTeamPersistence: () => ({ persistenceSnapshot: null, loading: false }),
}));
vi.mock('../frontend/src/contexts/ImportContext.jsx', () => ({
  useImport: () => ({ importedData: null, setImportedData: () => {} }),
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

describe('WorkflowPage practice status', () => {
  beforeEach(() => {
    runState.byType = { team: null, practice: null, game: null };
  });

  function renderPage() {
    return render(
      <MemoryRouter>
        <WorkflowPage />
      </MemoryRouter>
    );
  }

  it('says Unscheduled when no practice run exists', () => {
    renderPage();
    expect(screen.getByText('Practice Slots')).toBeInTheDocument();
    expect(screen.getByText('Unscheduled')).toBeInTheDocument();
  });

  it('says Optimized once a completed practice run is on the wire', () => {
    runState.byType.practice = makeSchedulerRun({
      run_type: 'practice',
      results: engineReport(),
      completed_at: COMPLETED_AT,
    });

    renderPage();

    expect(screen.getByText('Practice Slots')).toBeInTheDocument();
    expect(screen.getByText('Optimized')).toBeInTheDocument();
    expect(screen.queryByText('Unscheduled')).toBeNull();
  });
});
