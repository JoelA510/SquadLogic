import { useState, useEffect } from 'react';
import { supabase } from '../utils/supabaseClient';
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
    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);

    useEffect(() => {
        const controller = new AbortController();

        async function fetchLatestRun() {
            try {
                // Fetch the most recent completed run of type 'game'
                const { data: run, error: queryError } = await supabase
                    .from('scheduler_runs')
                    .select('*')
                    .eq('run_type', 'game')
                    .eq('status', 'completed')
                    .order('completed_at', { ascending: false })
                    .limit(1)
                    .single()
                    .abortSignal(controller.signal);

                if (queryError) {
                    if (queryError.code === 'PGRST116') {
                        // No rows found
                        setData(EMPTY_SUMMARY);
                        return;
                    }
                    throw queryError;
                }

                const mapped = mapSchedulerRunToGameSummary(run);
                setData(mapped || EMPTY_SUMMARY);
            } catch (err) {
                if (err.name !== 'AbortError') {
                    console.error('Failed to fetch game summary:', err);
                    setError(err);
                    setData(EMPTY_SUMMARY);
                }
            } finally {
                if (!controller.signal.aborted) {
                    setLoading(false);
                }
            }
        }

        fetchLatestRun();

        return () => {
            controller.abort();
        };
    }, []);

    return {
        gameSummary: data ? data.gameSummary : EMPTY_SUMMARY.gameSummary,
        gameReadinessSnapshot: data ? data.gameReadinessSnapshot : EMPTY_SUMMARY.gameReadinessSnapshot,
        generatedAt: data ? data.generatedAt : EMPTY_SUMMARY.generatedAt,
        loading,
        error
    };
}
