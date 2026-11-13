import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabaseClient.js';
import { fetchAllPages } from '../lib/pagedFetch.js';

import { mapKeysToCamelCase } from '../utils/caseConverters.js';
import { logger } from '../lib/logger.js';

/**
 * The games of one saved run. `refetch()` reads them again: a change that does not make a new run (turning
 * Published on or off) leaves the run id as it was, so the rows are not read again unless asked.
 */
/** The games of a run with their score embedded through the foreign key from `game_scores` (20261122010000). */
const GAMES_WITH_SCORE = '*, game_scores(game_id)';

/**
 * The games of a run, each with its score if it has one, in ONE read (one snapshot, and bounded to the run: not a
 * second read of every score the organization ever recorded). A failed page throws, a missing `game_scores` included:
 * a schedule read without its scores would show every scored game as free to move.
 *
 * @param {string} runId
 * @returns {Promise<any[]>}
 */
function fetchRunGames(runId) {
  // Paged: an unranged select is cut at the server's row cap (1000), and a run of a
  // large league holds more games than that. A page that fails throws, so a partial
  // set is an error and never the schedule.
  return fetchAllPages(() =>
    supabase.from('game_assignments').select(GAMES_WITH_SCORE).eq('run_id', runId)
  );
}

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
        const data = await fetchRunGames(runId);
        if (!current) return;

        // Map snake_case to camelCase using utility. The embedded score becomes the `scored` flag (`isHeld` reads it:
        // a scored game is held where it is, like a Published one) and is not carried under another name.
        const mapped = data.map(({ game_scores: scores, ...row }) => ({
          ...mapKeysToCamelCase(row),
          scored: Array.isArray(scores) ? scores.length > 0 : scores != null,
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
