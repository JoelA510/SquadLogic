import { useState, useEffect, useRef, useCallback } from 'react';
import { supabase } from '../lib/supabaseClient.js';
import { logger } from '../lib/logger.js';
import { isAbortError } from '../lib/abortError.js';
import { useOrganization } from '../contexts/OrganizationContext.jsx';
import { scopeSchedulerRunsToActiveSeason } from '../utils/schedulerRunFilters.js';

/**
 * Generic hook to fetch the latest completed scheduler run of a specific type.
 *
 * @param {string} runType - 'team', 'practice', or 'game'
 * @param {Function} mapper - Function to transform the raw run row into a summary object
 * @param {Object} emptyState - Fallback state if no data found or error occurs
 * @returns {Object} { data, evaluation, loading, error, refetch }
 *
 * `refetch()` reads the latest run again. A page calls it when a save's outcome
 * is unknown (`PERSISTENCE_TIMEOUT`): the save may have landed after the page
 * stopped waiting, and the run on screen is then not the latest one.
 */
export function useSchedulerRun(runType, mapper, emptyState) {
  const { currentOrganization, currentSeasonSetting } = useOrganization();
  const mapperRef = useRef(mapper);
  const emptyStateRef = useRef(emptyState);
  const [data, setData] = useState(null);
  const [evaluation, setEvaluation] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [version, setVersion] = useState(0);
  const refetch = useCallback(() => setVersion((v) => v + 1), []);

  mapperRef.current = mapper;
  emptyStateRef.current = emptyState;

  useEffect(() => {
    const controller = new AbortController();

    if (!currentOrganization?.id || !currentSeasonSetting?.id) {
      setData(emptyStateRef.current);
      setEvaluation(null);
      setError(null);
      setLoading(false);
      return () => {
        controller.abort();
      };
    }

    async function fetchLatestRun() {
      setLoading(true);
      setError(null);
      try {
        // 1. Fetch latest run
        let runQuery = supabase
          .from('scheduler_runs')
          .select('*')
          .eq('organization_id', currentOrganization.id)
          .eq('run_type', runType)
          .eq('status', 'completed')
          .order('completed_at', { ascending: false });

        runQuery = scopeSchedulerRunsToActiveSeason(runQuery, currentSeasonSetting.id);

        const { data: run, error: queryError } = await runQuery
          .limit(1)
          .maybeSingle()
          // @ts-expect-error [SUP] abortSignal present but untyped in PostgREST builder
          .abortSignal(controller.signal);

        if (queryError) {
          throw queryError;
        }

        if (!run) {
          setData(emptyStateRef.current);
          setEvaluation(null);
          return;
        }

        // 2. Fetch associated evaluation (if any)
        let evalRecord = null;
        if (run.id) {
          const { data: evalData } = await supabase
            .from('schedule_evaluations')
            .select('*')
            .eq('organization_id', currentOrganization.id)
            .eq('run_id', run.id)
            .maybeSingle()
            // @ts-expect-error [SUP] abortSignal present but untyped in PostgREST builder
            .abortSignal(controller.signal); // Use maybeSingle to avoid 406/error if none found
          evalRecord = evalData;
        }
        // A cancelled evaluation read resolves (with an error this read ignores) rather than
        // throwing, so the run read before it must not be written for a read nobody awaits.
        if (controller.signal.aborted) return;

        const mapped = mapperRef.current(run);
        setData(mapped || emptyStateRef.current);
        setEvaluation(evalRecord);
      } catch (err) {
        // Not by `err.name` alone: supabase-js reports a cancelled read as a PostgREST error
        // object with no `name` (`isAbortError` names the shapes), which used to become the
        // hook's error, and the Exports page then refused to build CSVs.
        if (!isAbortError(err, controller.signal)) {
          logger.error(`Failed to fetch ${runType} summary:`, JSON.stringify(err, null, 2));
          setError(err);
          setData(emptyStateRef.current);
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
    // `version` is read by nothing in the body: it is here so `refetch` re-runs the read.
  }, [currentOrganization?.id, currentSeasonSetting?.id, runType, version]);

  return { data, evaluation, loading, error, refetch };
}
