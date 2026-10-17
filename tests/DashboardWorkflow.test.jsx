import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const navigateMock = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = /** @type {Record<string, unknown>} */ (await importOriginal());
  return { ...actual, useNavigate: () => navigateMock };
});

// Permission state is mutable per-test so we can exercise the gating logic.
const permState = vi.hoisted(() => ({ can: /** @type {() => boolean} */ (() => true) }));
vi.mock('../frontend/src/hooks/usePermission.js', async () => {
  const { PERMISSIONS } = await import('../frontend/src/constants/permissions.js');
  return { usePermission: () => ({ can: permState.can, role: 'admin', PERMISSIONS }) };
});

// Stub the heavy child panels so the test isolates DashboardWorkflow's own logic.
vi.mock('../frontend/src/components/ImportPanel.jsx', () => ({ default: () => null }));
vi.mock('../frontend/src/components/TeamOverviewPanel.jsx', () => ({ default: () => null }));
vi.mock('../frontend/src/components/teaming/TeamListView.jsx', () => ({ default: () => null }));
vi.mock('../frontend/src/components/TeamPersistencePanel.jsx', () => ({ default: () => null }));
vi.mock('../frontend/src/components/PracticeReadinessPanel.jsx', () => ({ default: () => null }));
vi.mock('../frontend/src/components/GameReadinessPanel.jsx', () => ({ default: () => null }));
vi.mock('../frontend/src/components/OutputGenerationPanel.jsx', () => ({ default: () => null }));
vi.mock('../frontend/src/components/ui/FeatureGuard.jsx', () => ({
  FeatureGuard: ({ children }) => children,
}));

const { default: DashboardWorkflow } =
  await import('../frontend/src/components/DashboardWorkflow.jsx');

const baseProps = {
  loading: {},
  teamData: {},
  practiceData: { snapshot: {} },
  gameData: { snapshot: {} },
  persistenceSnapshot: null,
  importedData: { totalRows: 5 },
  controlledActiveStep: 2,
  onStepChange: vi.fn(),
  timezone: 'UTC',
};

function renderWorkflow(overrides = {}) {
  return render(
    <MemoryRouter>
      <DashboardWorkflow {...baseProps} {...overrides} />
    </MemoryRouter>
  );
}

beforeEach(() => {
  navigateMock.mockClear();
  permState.can = () => true;
});

describe('DashboardWorkflow run buttons', () => {
  it('navigates to the team builder with an auto-run intent when Start Teaming is clicked', () => {
    renderWorkflow();
    fireEvent.click(screen.getByTestId('step-run-teaming'));
    expect(navigateMock).toHaveBeenCalledWith('/teams', { state: { autoRunTeaming: true } });
  });

  it('disables practice and game run buttons until teams are generated', () => {
    renderWorkflow({ teamData: {} });
    expect(screen.getByTestId('step-run-practice')).toBeDisabled();
    expect(screen.getByTestId('step-run-games')).toBeDisabled();
  });

  it('enables scheduling once teams exist and navigates with the matching intent', () => {
    renderWorkflow({
      teamData: { generatedAt: '2026-01-01T00:00:00Z', totals: {}, divisions: [] },
    });

    const practiceBtn = screen.getByTestId('step-run-practice');
    expect(practiceBtn).not.toBeDisabled();
    fireEvent.click(practiceBtn);
    expect(navigateMock).toHaveBeenCalledWith('/schedule/practice', {
      state: { autoRunPractice: true },
    });

    fireEvent.click(screen.getByTestId('step-run-games'));
    expect(navigateMock).toHaveBeenCalledWith('/schedule/game', {
      state: { autoRunGames: true },
    });
  });

  it('disables the teaming run button without team-management permission', () => {
    permState.can = () => false;
    renderWorkflow();
    expect(screen.getByTestId('step-run-teaming')).toBeDisabled();
  });

  it('flips scheduling buttons to Re-run from generatedAt (not a missing lastCalculated)', () => {
    renderWorkflow({
      teamData: { generatedAt: '2026-01-01T00:00:00Z', totals: {}, divisions: [] },
      practiceData: { snapshot: {}, generatedAt: '2026-01-02T00:00:00Z' },
      gameData: { snapshot: {}, generatedAt: '2026-01-03T00:00:00Z' },
    });
    expect(screen.getByTestId('step-run-practice')).toHaveTextContent('Re-run Practice Scheduling');
    expect(screen.getByTestId('step-run-games')).toHaveTextContent('Re-run Game Scheduling');
  });
});
