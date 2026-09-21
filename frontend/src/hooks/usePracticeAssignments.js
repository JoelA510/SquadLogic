import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabaseClient.js';
import { mapKeysToCamelCase } from '../utils/caseConverters.js';
import { logger } from '../lib/logger.js';

export function usePracticeAssignments(runId) {
  const [assignments, setAssignments] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!runId) {
      setAssignments([]);
      // The error belongs to the run that is going away. Left standing it
      // outlived its run: switch organisation after a refused read and this
      // hook early-returns here with the previous tenant's `Error` still in
      // state, so a consumer reading it blocks a tenant where nothing failed.
      // Harmless while nothing read it; `useDashboardData` reads it now.
      setError(null);
      return;
    }

    async function fetchAssignments() {
      setLoading(true);
      setError(null);
      try {
        const { data, error: fetchError } = await supabase
          .from('practice_assignments')
          .select(
            `
            *,
            practice_slots (
              id,
              day_of_week,
              start_time,
              end_time,
              field_id,
              fields (
                id,
                name
              )
            ),
            teams (
              id,
              name,
              divisions (
                id,
                name
              )
            )
          `
          )
          .eq('run_id', runId);

        if (fetchError) throw fetchError;

        const mapped = (data || []).map(mapKeysToCamelCase);
        setAssignments(mapped);
      } catch (err) {
        logger.error('Error fetching practice assignments:', err);
        setError(err);
      } finally {
        setLoading(false);
      }
    }

    fetchAssignments();
  }, [runId]);

  return { assignments, loading, error };
}
