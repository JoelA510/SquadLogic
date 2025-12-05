import { useState, useEffect } from 'react';
import { supabase } from '../utils/supabaseClient';

export function useTeamPersistence() {
    const [persistenceSnapshot, setPersistenceSnapshot] = useState({
        manualOverrides: [],
        runHistory: [],
        lastRunId: null,
        lastSyncedAt: null,
        preparedTeamRows: 0,
        preparedPlayerRows: 0
    });
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        async function fetchPersistenceHistory() {
            try {
                // Fetch recent team runs to populate history
                const { data: runs, error } = await supabase
                    .from('scheduler_runs')
                    .select('*')
                    .eq('run_type', 'team')
                    .order('created_at', { ascending: false })
                    .limit(5);

                if (error) {
                    console.error('Error fetching persistence history:', error);
                    return;
                }

                // Map runs to the format expected by TeamPersistencePanel
                const history = runs.map(run => ({
                    runId: run.id,
                    status: run.status,
                    startedAt: run.started_at,
                    updatedTeams: run.results?.teams?.length || 0,
                    updatedPlayers: 0, // Not explicitly tracked in run results usually
                    notes: run.status === 'completed' ? 'Scheduled successfully' : 'Run failed'
                }));

                const lastRun = runs[0];

                setPersistenceSnapshot({
                    manualOverrides: [], // No table for overrides yet
                    runHistory: history,
                    lastRunId: lastRun?.id || null,
                    lastSyncedAt: lastRun?.completed_at || null,
                    preparedTeamRows: lastRun?.results?.teams?.length || 0,
                    preparedPlayerRows: 0 // Placeholder
                });

            } catch (err) {
                console.error('Failed to init persistence snapshot:', err);
            } finally {
                setLoading(false);
            }
        }

        fetchPersistenceHistory();
    }, []);

    return { persistenceSnapshot, loading };
}
