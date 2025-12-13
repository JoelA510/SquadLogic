import { useState, useEffect } from 'react';
import { supabase } from '../utils/supabaseClient.js';

export function useGameAssignments(runId) {
    const [assignments, setAssignments] = useState([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);

    useEffect(() => {
        if (!runId) {
            setAssignments([]);
            return;
        }

        async function fetchAssignments() {
            setLoading(true);
            setError(null);
            try {
                const { data, error: fetchError } = await supabase
                    .from('game_assignments')
                    .select('*')
                    .eq('run_id', runId);

                if (fetchError) throw fetchError;

                // Map snake_case to camelCase for the frontend component
                const mapped = (data || []).map(a => ({
                    slotId: a.slot_id,
                    start: a.start,
                    end: a.end,
                    homeTeamId: a.home_team_id,
                    awayTeamId: a.away_team_id,
                    fieldId: a.field_id,
                    division: a.division,
                    weekIndex: a.week_index
                }));

                setAssignments(mapped);
            } catch (err) {
                console.error('Error fetching game assignments:', err);
                setError(err);
            } finally {
                setLoading(false);
            }
        }

        fetchAssignments();
    }, [runId]);

    return { assignments, loading, error };
}
