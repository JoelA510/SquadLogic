import { useState, useEffect, useRef, useCallback } from 'react';
import { supabase } from '../lib/supabaseClient.js';
import { logger } from '../lib/logger.js';
// Use absolute import via configured alias
import { mapSchedulerRunToSummary } from '@squadlogic/core/utils/teamSummaryMapper.js';
import { useOrganization } from '../contexts/OrganizationContext.jsx';
import { scopeSchedulerRunsToActiveSeason } from '../utils/schedulerRunFilters.js';

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
  teams: [],
  team_players: [],
  generatedAt: null,
};

export function useTeamSummary() {
  const { currentOrganization, currentSeasonSetting } = useOrganization();
  const [summary, setSummary] = useState(null); // null triggers loading state
  const [loading, setLoading] = useState(true);
  const [error, _setError] = useState(null);
  const [status, setStatus] = useState('idle'); // idle, running, completed, error
  const [progress, setProgress] = useState(0);
  const lastKnownStatusRef = useRef('idle');
  const [version, setVersion] = useState(0);
  /**
   * Read the latest team run again, as `useSchedulerRun`'s `refetch` does: a
   * page calls it after a save that wrote a new run (a team sync), so the run on
   * screen is not the one from before it. `loading` turns on in the same update,
   * so a caller that clears its own staged copy in that update never renders the
   * stale run in between.
   */
  const refetch = useCallback(() => {
    setLoading(true);
    setVersion((v) => v + 1);
  }, []);

  useEffect(() => {
    let pollTimeout;
    let cancelled = false;

    if (!currentOrganization?.id || !currentSeasonSetting?.id) {
      setSummary(EMPTY_SUMMARY);
      setLoading(false);
      setStatus('idle');
      lastKnownStatusRef.current = 'idle';
      _setError(null);
      setProgress(0);
      return;
    }

    async function fetchLatestRun() {
      try {
        // Fetch the latest run for the CURRENT ORGANIZATION, regardless of status
        let runQuery = supabase
          .from('scheduler_runs')
          .select('*')
          .eq('run_type', 'team')
          .eq('organization_id', currentOrganization.id)
          .in('status', ['completed', 'running'])
          .order('created_at', { ascending: false });

        runQuery = scopeSchedulerRunsToActiveSeason(runQuery, currentSeasonSetting.id);

        // maybeSingle: a new org/season has no runs yet — that's the idle
        // empty state, not an error (single() would 406 on zero rows).
        const { data, error: queryError } = await runQuery.limit(1).maybeSingle();
        if (cancelled) return 'cancelled';

        if (queryError) throw queryError;

        if (!data) {
          setSummary(EMPTY_SUMMARY);
          setLoading(false);
          setStatus('idle');
          lastKnownStatusRef.current = 'idle';
          _setError(null);
          setProgress(0);
          return 'idle';
        }

        // Update status and progress
        _setError(null);
        setStatus(data.status);
        lastKnownStatusRef.current = data.status;
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
        return data.status;
      } catch (err) {
        logger.error('Failed to fetch team summary:', JSON.stringify(err, null, 2));
        if (!cancelled) {
          _setError(err);
          setLoading(false);
          setStatus('error');
        }
        return lastKnownStatusRef.current === 'running' ? 'running' : 'error';
      }
    }

    const schedulePollIfRunning = async () => {
      const latestStatus = await fetchLatestRun();
      if (!cancelled && latestStatus === 'running') {
        pollTimeout = setTimeout(schedulePollIfRunning, 2000);
      }
    };

    setLoading(true);
    schedulePollIfRunning();

    return () => {
      cancelled = true;
      if (pollTimeout) clearTimeout(pollTimeout);
    };
    // `version` is read by nothing in the body: it is here so `refetch` re-runs the read.
  }, [currentOrganization?.id, currentSeasonSetting?.id, version]);

  return {
    summary,
    loading,
    error,
    status,
    progress,
    generatedAt: summary?.generatedAt,
    refetch,
  };
}
