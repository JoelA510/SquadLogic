import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabaseClient.js';
import { fetchAllPages } from '../lib/pagedFetch.js';

import { mapKeysToCamelCase } from '../utils/caseConverters.js';
import { logger } from '../lib/logger.js';

/**
 * The games of one saved run. `refetch()` reads them again: a change that does not make a new run (turning
 * Published on or off) leaves the run id as it was, so the rows are not read again unless asked.
 */
export function useGameAssignments(runId) {
  const [assignments, setAssignments] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [version, setVersion] = useState(0);
  // Which read (a run, and the `refetch` it was asked for) last finished, whether it answered or was refused.
  const [settledFor, setSettledFor] = useState(/** @type {string | null} */ (null));
  const refetch = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    // A read that a newer one (another run, another `refetch`) has overtaken writes nothing: the page would
    // otherwise show the older answer if it arrived last.
    let current = true;
    if (!runId) {
      setAssignments([]);
      // The error belongs to the run that is going away. Left standing it
      // outlived its run: switch organisation after a refused read and this
      // hook early-returns here with the previous tenant's `Error` still in
      // state, so a consumer reading it blocks a tenant where nothing failed.
      // Harmless while nothing read it; `useDashboardData` reads it now.
      setError(null);
      // A read this run left in flight was cancelled by the cleanup below, so it will not say it is done.
      setLoading(false);
      return undefined;
    }

    async function fetchAssignments() {
      setLoading(true);
      setError(null);
      try {
        // Paged: an unranged select is cut at the server's row cap (1000), and a run of a
        // large league holds more games than that. A page that fails throws, so a partial
        // set is an error and never the schedule.
        const data = await fetchAllPages(() =>
          supabase.from('game_assignments').select('*').eq('run_id', runId)
        );
        if (!current) return;

        // 20261122010000 (F11-2): a game with a score is held where it is, like a Published one, so the page has to
        // know which games are scored before it offers a move, a cancel or a regeneration. One more read, of the ids
        // alone; a read that fails throws, because a schedule whose holds are unknown is not one to edit.
        const scoredIds = new Set();
        if (data.length > 0) {
          // Ordered by `game_id`: the table's key. It has no `id`, which is what a paged read orders by unless told
          // (PostgREST refuses an order by a column the table does not have; tests/pagedReadOrderColumns.test.js).
          const scores = await fetchAllPages(
            () =>
              supabase
                .from('game_scores')
                .select('game_id')
                .eq('organization_id', data[0].organization_id),
            { orderBy: 'game_id' }
          );
          for (const row of scores) scoredIds.add(String(row.game_id));
        }
        if (!current) return;

        // Map snake_case to camelCase using utility
        const mapped = data.map((row) => ({
          ...mapKeysToCamelCase(row),
          scored: scoredIds.has(String(row.id)),
        }));

        setAssignments(mapped);
      } catch (err) {
        if (!current) return;
        logger.error('Error fetching game assignments:', err);
        setError(err);
      } finally {
        if (current) {
          setLoading(false);
          setSettledFor(`${runId}:${version}`);
        }
      }
    }

    fetchAssignments();
    return () => {
      current = false;
    };
    // `version` is read by nothing in the body: it is here so `refetch` re-runs the read.
  }, [runId, version]);

  // Loading from the render that names a new run or asks for a new read, not from the effect after it: a page that
  // counts the games must not see "no games" for the one render between a run arriving and its games being read.
  const waiting = Boolean(runId) && settledFor !== `${runId}:${version}`;
  return { assignments, loading: loading || waiting, error, refetch };
}
