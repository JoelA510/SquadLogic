import { useState, useEffect } from 'react';
import { supabase } from '../utils/supabaseClient';
import { mapSchedulerRunToPracticeSummary } from 'src/utils/practiceSummaryMapper';

// Fallback empty state to prevent null access errors
const EMPTY_SUMMARY = {
    generatedAt: null,
    practiceSummary: {
        assignmentRate: 0,
        manualFollowUpRate: 0,
        unassignedTeams: 0,
    },
    practiceReadinessSnapshot: {}
};

export function usePracticeSummary() {
    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);

    useEffect(() => {
        let isMounted = true;

        async function fetchLatestRun() {
            try {
                // Fetch the most recent completed run of type 'practice'
                const { data: run, error: queryError } = await supabase
                    .from('scheduler_runs')
                    .select('*')
                    .eq('run_type', 'practice')
                    .eq('status', 'completed')
                    .order('completed_at', { ascending: false })
                    .limit(1)
                    .single();

                if (!isMounted) return;

                if (queryError) {
                    if (queryError.code === 'PGRST116') {
                        // No rows found
                        setData(EMPTY_SUMMARY);
                        return;
                    }
                    throw queryError;
                }

                const mapped = mapSchedulerRunToPracticeSummary(run);
                setData(mapped || EMPTY_SUMMARY);
            } catch (err) {
                console.error('Failed to fetch practice summary:', err);
                if (isMounted) {
                    setError(err);
                    setData(EMPTY_SUMMARY);
                }
            } finally {
                if (isMounted) {
                    setLoading(false);
                }
            }
        }

        fetchLatestRun();

        return () => {
            isMounted = false;
        };
    }, []);

    return {
        practiceSummary: data ? data.practiceSummary : EMPTY_SUMMARY.practiceSummary,
        practiceReadinessSnapshot: data ? data.practiceReadinessSnapshot : EMPTY_SUMMARY.practiceReadinessSnapshot,
        generatedAt: data ? data.generatedAt : EMPTY_SUMMARY.generatedAt,
        loading,
        error
    };
}
