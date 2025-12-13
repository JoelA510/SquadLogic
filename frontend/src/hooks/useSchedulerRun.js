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
    const [evaluation, setEvaluation] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);

    useEffect(() => {
        const controller = new AbortController();

        async function fetchLatestRun() {
            try {
                // 1. Fetch latest run
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

                // 2. Fetch associated evaluation (if any)
                let evalRecord = null;
                if (run && run.id) {
                    const { data: evalData } = await supabase
                        .from('schedule_evaluations')
                        .select('*')
                        .eq('run_id', run.id)
                        .maybeSingle(); // Use maybeSingle to avoid 406/error if none found
                    evalRecord = evalData;
                }

                const mapped = mapper(run);
                setData(mapped || emptyState);
                setEvaluation(evalRecord);
            } catch (err) {
                if (err.name !== 'AbortError') {
                    console.error(`Failed to fetch ${runType} summary:`, JSON.stringify(err, null, 2));
                    setError(err);
                    setData(emptyState);
                    setEvaluation(null);
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

    return { data, evaluation, loading, error };
}
