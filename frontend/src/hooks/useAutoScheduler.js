import { useState, useCallback, useRef } from 'react';
import { supabase } from '../lib/supabaseClient.js';
import { buildEdgeFunctionCacheKey, edgeFunctionCache } from '../lib/cache.js';
import { API_BASE_URL, SUPABASE_URL } from '../config.js';

// Wave 6b Task 1: 5-minute TTL for auto-scheduler runs. Rationale: an
// optimization with identical inputs (same teams, slots, config, weights)
// produces a result whose re-run is expensive compute AND a full Edge Function
// invocation. Within a 5-minute window a user firing the same run (double-
// click, immediate retry) cache-hits the prior result. Input changes bust the
// key automatically. Errors are NOT cached (so retries run fresh).
const AUTO_SCHEDULER_TTL_MS = 300_000;
const DEFAULT_LOCAL_FUNCTIONS_URL = 'http://localhost:54321/functions/v1';

/**
 * @typedef {'idle' | 'running' | 'polling' | 'completed' | 'failed'} AutoSchedulerStatus
 */

/**
 * @typedef {Object} AutoSchedulerResult
 * @property {Array<{ teamId: string, slotId: string, source: string }>} assignments
 * @property {Array<Object>} unassigned
 * @property {Object} evaluation
 * @property {Object} optimization
 * @property {string|null} runId
 */

/**
 * Hook to trigger and track auto-scheduler runs.
 *
 * Calls the auto-scheduler Edge Function and subscribes to Supabase Realtime
 * on the audit_log table for live progress events (scheduler.auto_progress).
 * The subscription is cleaned up on completion, failure, or manual cancel/reset.
 *
 * @param {Object} options
 * @param {string} options.organizationId
 * @returns {{ trigger: Function, cancel: Function, status: AutoSchedulerStatus, result: AutoSchedulerResult|null, error: string|null, progress: { iteration: number, bestScore: number, elapsedMs: number }|null, reset: Function }}
 */
export function useAutoScheduler({ organizationId }) {
  /** @type {[AutoSchedulerStatus, Function]} */
  const [status, setStatus] = useState('idle');
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [progress, setProgress] = useState(null);
  const abortRef = useRef(null);
  const channelRef = useRef(null);

  /** Remove the Realtime channel subscription if active. */
  const teardownChannel = useCallback(() => {
    if (channelRef.current) {
      supabase.removeChannel(channelRef.current);
      channelRef.current = null;
    }
  }, []);

  const reset = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    teardownChannel();
    setStatus('idle');
    setResult(null);
    setError(null);
    setProgress(null);
  }, [teardownChannel]);

  /**
   * Cancel a running optimization.
   * Aborting the fetch causes the Deno Edge Function to terminate
   * (Deno handles client disconnects by ending the handler).
   */
  const cancel = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    teardownChannel();
    setStatus('idle');
    setProgress(null);
  }, [teardownChannel]);

  const trigger = useCallback(
    async ({
      teams,
      slots,
      coachPreferences,
      divisionPreferences,
      lockedAssignments,
      scoringWeights,
      schoolDayEnd,
      seasonSettingsId,
      config,
    }) => {
      if (!organizationId) {
        setError('No organization selected');
        setStatus('failed');
        return;
      }

      // Wave 6b Task 1: check TTL cache BEFORE the expensive fetch + Realtime
      // subscription setup. Identical inputs within 5 minutes return the prior
      // result and skip the Edge Function invocation entirely (free-tier
      // invocation reduction on the hot path). Cache key is scoped by
      // organization_id via buildEdgeFunctionCacheKey — distinct orgs never
      // share entries.
      const cacheKey = buildEdgeFunctionCacheKey('auto-scheduler', {
        organization_id: organizationId,
        season_settings_id: seasonSettingsId ?? null,
        teams,
        slots,
        coachPreferences: coachPreferences ?? {},
        divisionPreferences: divisionPreferences ?? {},
        lockedAssignments: lockedAssignments ?? [],
        scoringWeights: scoringWeights ?? {},
        schoolDayEnd,
        config: config ?? {},
      });
      const cached = edgeFunctionCache.get(cacheKey);
      if (cached) {
        setError(null);
        setResult(cached.data);
        setProgress({
          iteration: cached.data?.optimization?.iterations ?? 0,
          bestScore: cached.data?.optimization?.bestScore ?? 0,
          elapsedMs: cached.data?.optimization?.elapsedMs ?? 0,
        });
        setStatus('completed');
        return;
      }

      const controller = new AbortController();
      abortRef.current = controller;

      setStatus('running');
      setError(null);
      setResult(null);
      setProgress({ iteration: 0, bestScore: 0, elapsedMs: 0 });

      // --- Realtime subscription for live progress ---
      teardownChannel();

      const channel = supabase
        .channel('auto-scheduler-progress')
        .on(
          'postgres_changes',
          {
            event: 'INSERT',
            schema: 'public',
            table: 'audit_log',
            filter: `organization_id=eq.${organizationId}`,
          },
          (payload) => {
            const row = payload.new;
            if (row?.action === 'scheduler.auto_progress' && row?.metadata) {
              const meta =
                typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata;
              setProgress({
                iteration: meta.iteration ?? 0,
                bestScore: meta.bestScore ?? 0,
                elapsedMs: meta.elapsedMs ?? 0,
              });
            }
          }
        )
        .subscribe();

      channelRef.current = channel;

      // --- Edge Function call ---
      try {
        const { data: sessionData } = await supabase.auth.getSession();
        const token = sessionData?.session?.access_token;

        if (!token) {
          throw new Error('Not authenticated');
        }

        const functionsBaseUrl =
          API_BASE_URL !== DEFAULT_LOCAL_FUNCTIONS_URL || !SUPABASE_URL
            ? API_BASE_URL
            : `${SUPABASE_URL}/functions/v1`;
        const response = await fetch(`${functionsBaseUrl}/auto-scheduler`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            organizationId,
            seasonSettingsId,
            teams,
            slots,
            coachPreferences: coachPreferences ?? {},
            divisionPreferences: divisionPreferences ?? {},
            lockedAssignments: lockedAssignments ?? [],
            scoringWeights: scoringWeights ?? {},
            schoolDayEnd,
            config: config ?? {},
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          const errBody = await response.json().catch(() => ({}));
          throw new Error(errBody.error || `Server error: ${response.status}`);
        }

        const data = await response.json();

        const resultPayload = {
          assignments: data.assignments,
          unassigned: data.unassigned,
          evaluation: data.evaluation,
          optimization: data.optimization,
          runId: data.runId,
        };
        // Wave 6b Task 1: cache the successful run. Errors are intentionally
        // NOT cached so retries after a failed run go back to the Edge Function.
        edgeFunctionCache.set(cacheKey, resultPayload, { ttlMs: AUTO_SCHEDULER_TTL_MS });

        setResult(resultPayload);
        setProgress({
          iteration: data.optimization?.iterations ?? 0,
          bestScore: data.optimization?.bestScore ?? 0,
          elapsedMs: data.optimization?.elapsedMs ?? 0,
        });
        setStatus('completed');
      } catch (err) {
        if (err.name === 'AbortError') {
          setStatus('idle');
          return;
        }
        setError(err.message || 'Auto-scheduler failed');
        setStatus('failed');
      } finally {
        teardownChannel();
      }
    },
    [organizationId, teardownChannel]
  );

  return { trigger, cancel, status, result, error, progress, reset };
}
