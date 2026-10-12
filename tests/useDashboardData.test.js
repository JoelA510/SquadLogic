import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useDashboardData } from '../frontend/src/hooks/useDashboardData.js';
import { useTeamSummary } from '../frontend/src/hooks/useTeamSummary.js';
import { usePracticeSummary } from '../frontend/src/hooks/usePracticeSummary.js';
import { useCurrentPracticeSchedule } from '../frontend/src/hooks/useCurrentPracticeSchedule.js';
import { useGameSummary } from '../frontend/src/hooks/useGameSummary.js';
import { useGameAssignments } from '../frontend/src/hooks/useGameAssignments.js';
import { makePracticeAssignment, makeTeam } from './factories/index.js';

const idOnly = (entity) => ({ id: entity.id });

// Mock all internal hooks
vi.mock('../frontend/src/hooks/useTeamSummary.js');
vi.mock('../frontend/src/hooks/usePracticeSummary.js');
vi.mock('../frontend/src/hooks/useCurrentPracticeSchedule.js');
vi.mock('../frontend/src/hooks/useGameSummary.js');
vi.mock('../frontend/src/hooks/useGameAssignments.js');

describe('useDashboardData', () => {
  it('aggregates data from multiple hooks correctly', () => {
    // Setup mocks
    /** @type {any} */ (useTeamSummary).mockReturnValue({
      summary: { totals: { teams: 10 } },
      loading: false,
      generatedAt: '2026-03-01',
      status: 'completed',
      progress: 100,
    });
    /** @type {any} */ (usePracticeSummary).mockReturnValue({
      practiceSummary: { count: 5 },
      practiceReadinessSnapshot: 'ready',
      generatedAt: '2026-03-02',
      loading: false,
      runId: 'practice-run-123',
    });
    /** @type {any} */ (useCurrentPracticeSchedule).mockReturnValue({
      assignments: [idOnly(makePracticeAssignment({ id: 'pa1' }))],
    });
    /** @type {any} */ (useGameSummary).mockReturnValue({
      gameSummary: { count: 8 },
      gameReadinessSnapshot: 'partial',
      generatedAt: '2026-03-03',
      loading: true,
      runId: 'game-run-456',
    });
    /** @type {any} */ (useGameAssignments).mockReturnValue({
      assignments: [idOnly(makeTeam({ id: 'ga1' }))],
    });

    const { result } = renderHook(() => useDashboardData());

    // Verify aggregation
    expect(result.current.loading.team).toBe(false);
    expect(result.current.loading.game).toBe(true);
    expect(result.current.team.totals.teams).toBe(10);
    expect(result.current.practice.runId).toBe('practice-run-123');
    expect(result.current.practice.scheduleAssignments).toEqual([{ id: 'pa1' }]);
    // The latest-run read is gone: the grid and the exports share the season read.
    expect(result.current.practice).not.toHaveProperty('assignments');
    expect(result.current.game.runId).toBe('game-run-456');
    expect(result.current.game.snapshot).toBe('partial');
    expect(result.current.roadmap.stats.completed).toBeDefined();
  });
});
