import { useMemo } from 'react';
import { useTeamSummary } from './useTeamSummary.js';
import { usePracticeSummary } from './usePracticeSummary.js';
import { useGameSummary } from './useGameSummary.js';
import { useGameAssignments } from './useGameAssignments.js';
import { ROADMAP_SECTIONS } from '../constants/roadmap.js';

export function useDashboardData() {
    const { summary: teamSummary, loading: teamLoading, generatedAt: teamGeneratedAt } = useTeamSummary();

    const {
        practiceSummary,
        practiceReadinessSnapshot,
        generatedAt: practiceGeneratedAt,
        loading: practiceLoading
    } = usePracticeSummary();

    const {
        gameSummary,
        gameReadinessSnapshot,
        generatedAt: gameGeneratedAt,
        loading: gameLoading,
        runId: gameRunId
    } = useGameSummary();

    const { assignments: gameAssignments } = useGameAssignments(gameRunId);

    const roadmapStats = useMemo(() => {
        const completed = ROADMAP_SECTIONS.filter((section) => section.status === 'complete').length;
        const pending = ROADMAP_SECTIONS.length - completed;
        return { completed, pending };
    }, []);

    const resolvedTeam = {
        summary: teamSummary,
        generatedAt: teamGeneratedAt,
        totals: teamSummary?.totals,
        divisions: teamSummary?.divisions,
        teams: teamSummary?.teams,
    };

    const resolvedPractice = {
        summary: practiceSummary,
        snapshot: practiceReadinessSnapshot,
        generatedAt: practiceGeneratedAt
    };

    const resolvedGame = {
        summary: gameSummary,
        snapshot: gameReadinessSnapshot,
        generatedAt: gameGeneratedAt,
        runId: gameRunId,
        assignments: gameAssignments
    };

    return {
        loading: {
            team: teamLoading,
            practice: practiceLoading,
            game: gameLoading,
        },
        roadmap: {
            sections: ROADMAP_SECTIONS,
            stats: roadmapStats
        },
        team: resolvedTeam,
        practice: resolvedPractice,
        game: resolvedGame,
    };
}
