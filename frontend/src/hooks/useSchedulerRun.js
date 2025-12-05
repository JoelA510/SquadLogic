import { useState, useEffect } from 'react';
import { supabase } from '../utils/supabaseClient';

/**
 * Generic hook to fetch the latest completed scheduler run of a specific type.
 * 
 * @param {string} runType - 'team', 'practice', or 'game'
 * @param {Function} mapper - Function to transform the raw run row into a summary object
 * @param {Object} emptyState - Fallback state if no data found or error occurs
 * @returns {Object} { data, loading, error }
 */
export function useSchedulerRun(runType, mapper, emptyState) {
    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);

    useEffect(() => {
        const controller = new AbortController();

        async function fetchLatestRun() {
            try {
                const { data: run, error: queryError } = await supabase
                    .from('scheduler_runs')
                    .select('*')
                    .eq('run_type', runType)
                    .eq('status', 'completed')
                    .order('completed_at', { ascending: false })
                    .limit(1)
                    .single()
                    .abortSignal(controller.signal);

                if (queryError) {
                    if (queryError.code === 'PGRST116') {
                        // No rows found -> return empty state
                        setData(emptyState);
                        return;
                    }
                    throw queryError;
                }

                const mapped = mapper(run);
                setData(mapped || emptyState);
            } catch (err) {
                if (err.name !== 'AbortError') {
                    console.error(`Failed to fetch ${runType} summary:`, err);
                    setError(err);
                    setData(emptyState);
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
    }, [runType, mapper, emptyState]);

    return { data, loading, error };
}
