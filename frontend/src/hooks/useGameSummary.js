import { useSchedulerRun } from './useSchedulerRun';
import { mapSchedulerRunToGameSummary } from 'src/utils/gameSummaryMapper';

// Fallback empty state to prevent null access errors
const EMPTY_SUMMARY = {
    generatedAt: null,
    gameSummary: {
        totalGames: 0,
        scheduledRate: 0,
        unscheduledMatchups: 0,
    },
    gameReadinessSnapshot: {}
};

export function useGameSummary() {
    const { data, loading, error } = useSchedulerRun('game', mapSchedulerRunToGameSummary, EMPTY_SUMMARY);

    return {
        gameSummary: data ? data.gameSummary : EMPTY_SUMMARY.gameSummary,
        gameReadinessSnapshot: data ? data.gameReadinessSnapshot : EMPTY_SUMMARY.gameReadinessSnapshot,
        generatedAt: data ? data.generatedAt : EMPTY_SUMMARY.generatedAt,
        loading,
        error
    };
}
