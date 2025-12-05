import { useMemo } from 'react';
import { useTeamSummary } from './useTeamSummary';
import { usePracticeSummary } from './usePracticeSummary';
import { useGameSummary } from './useGameSummary';
import { ROADMAP_SECTIONS } from '../constants/roadmap';

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
        loading: gameLoading
    } = useGameSummary();

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
        generatedAt: gameGeneratedAt
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
