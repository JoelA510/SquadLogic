import { useSchedulerRun } from './useSchedulerRun.js';
import { mapSchedulerRunToPracticeSummary } from '@squadlogic/core/utils/practiceSummaryMapper.js';

// Fallback empty state to prevent null access errors
const EMPTY_SUMMARY = {
  generatedAt: null,
  practiceSummary: {
    assignmentRate: 0,
    manualFollowUpRate: 0,
    unassignedTeams: 0,
  },
  practiceReadinessSnapshot: {},
};

export function usePracticeSummary() {
  const { data, evaluation, loading, error, refetch } = useSchedulerRun(
    'practice',
    mapSchedulerRunToPracticeSummary,
    EMPTY_SUMMARY
  );

  return {
    practiceSummary: data ? data.practiceSummary : EMPTY_SUMMARY.practiceSummary,
    practiceReadinessSnapshot: data
      ? data.practiceReadinessSnapshot
      : EMPTY_SUMMARY.practiceReadinessSnapshot,
    generatedAt: data ? data.generatedAt : EMPTY_SUMMARY.generatedAt,
    scheduleEvaluation: evaluation,
    runId: data ? data.runId : null,
    loading,
    error,
    refetch,
  };
}
