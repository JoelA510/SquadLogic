import { useState, useEffect } from 'react';
import { supabase } from '../utils/supabaseClient';
import { mapSchedulerRunToSummary } from '../../../src/utils/teamSummaryMapper';

// Fallback skeleton if no data is found (or while loading initially if we didn't want a full spinner)
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

    useEffect(() => {
        async function fetchLatestRun() {
            try {
                setLoading(true);
                // Fetch the most recent completed run of type 'team'
                const { data, error: queryError } = await supabase
                    .from('scheduler_runs')
                    .select('*')
                    .eq('run_type', 'team')
                    .eq('status', 'completed')
                    .order('completed_at', { ascending: false })
                    .limit(1)
                    .single();

                if (queryError) {
                    // PGRST116 means zero rows found, which is not an error here, just "no runs yet"
                    if (queryError.code === 'PGRST116') {
                        setSummary(EMPTY_SUMMARY);
                        return;
                    }
                    throw queryError;
                }

                const mapped = mapSchedulerRunToSummary(data);
                setSummary(mapped || EMPTY_SUMMARY);
            } catch (err) {
                console.error('Failed to fetch team summary:', err);
                setError(err);
                setSummary(EMPTY_SUMMARY);
            } finally {
                setLoading(false);
            }
        }

        fetchLatestRun();
    }, []);

    return { summary, loading, error };
}
