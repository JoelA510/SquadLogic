import { useState, useEffect } from 'react';
import { supabase } from '../utils/supabaseClient.js';

import { mapKeysToCamelCase } from '../utils/caseConverters.js';

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

                // Map snake_case to camelCase using utility
                const mapped = (data || []).map(mapKeysToCamelCase);

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
