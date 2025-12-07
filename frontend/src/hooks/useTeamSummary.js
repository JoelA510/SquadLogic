import { useState, useEffect } from 'react';
import { supabase } from '../utils/supabaseClient';
// Use absolute import via configured alias
import { mapSchedulerRunToSummary } from 'src/utils/teamSummaryMapper';

// Fallback skeleton
const EMPTY_SUMMARY = {
    totals: {
        divisions: 0,
        teams: 0,
        playersAssigned: 0,
        overflowPlayers: 0,
        divisionsNeedingCoaches: 0,
        divisionsWithOpenRosterSlots: 0,
    },
    divisions: [],
    generatedAt: null,
};

export function useTeamSummary() {
    const [summary, setSummary] = useState(null); // null triggers loading state
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [status, setStatus] = useState('idle'); // idle, running, completed, error
    const [progress, setProgress] = useState(0);

    useEffect(() => {
        let pollInterval;

        async function fetchLatestRun() {
            try {
                // Fetch the latest run, regardless of status (running or completed)
                const { data, error: queryError } = await supabase
                    .from('scheduler_runs')
                    .select('*')
                    .eq('run_type', 'team')
                    .in('status', ['completed', 'running'])
                    .order('created_at', { ascending: false })
                    .limit(1)
                    .single();

                if (queryError) {
                    if (queryError.code === 'PGRST116') {
                        setSummary(EMPTY_SUMMARY);
                        setLoading(false);
                        setStatus('idle');
                        return;
                    }
                    throw queryError;
                }

                // Update status and progress
                setStatus(data.status);
                // Assume progress is stored in metrics or calculate it (mocking for now if not present)
                const currentProgress = data.metrics?.progress || (data.status === 'completed' ? 100 : 0);
                setProgress(currentProgress);

                if (data.status === 'completed') {
                    const mapped = mapSchedulerRunToSummary(data);
                    setSummary(mapped || EMPTY_SUMMARY);
                    setLoading(false);
                } else if (data.status === 'running') {
                    // If running, keep loading true (or handle partial data if available)
                    // but we have status to show progress bar
                    setLoading(true);
                }

            } catch (err) {
                console.error('Failed to fetch team summary:', JSON.stringify(err, null, 2));
                // Don't set error state if we are just polling and failed once, unless it's critical
                // But for now, let's just log it and maybe keep old state
            }
        }

        fetchLatestRun();

        // Poll if running
        pollInterval = setInterval(() => {
            fetchLatestRun();
        }, 2000);

        return () => {
            if (pollInterval) clearInterval(pollInterval);
        };
    }, []);

    return { summary, loading, error, status, progress, generatedAt: summary?.generatedAt };
}
