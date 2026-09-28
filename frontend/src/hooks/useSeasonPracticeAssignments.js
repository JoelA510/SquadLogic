import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabaseClient.js';
import { loadSeasonPracticeAssignments } from '@squadlogic/core/practiceSupabase.js';

const EMPTY = Object.freeze([]);

/**
 * Every current `practice_assignments` row of the season, read as the user
 * through RLS -- the scheduling page's locked set (8.6 PR 3b PR 7).
 *
 * Not `usePracticeAssignments(runId)`: writer v3 is add-only, so the season
 * holds rows from every earlier save under their own run ids, and a reader
 * keyed on the latest run stops listing them from the second run on. The
 * auto-scheduler loads by season with the same filter
 * (`loadSeasonPracticeAssignments` and its Edge twin) and refuses any mismatch.
 *
 * `loaded` is true only after a COMPLETE read of the current season. While
 * loading, after a failed read, or with no season, it is false and `rows` is
 * empty: a caller must not lock against a partial or missing set.
 *
 * @param {{ organizationId?: string|null, seasonSettingsId?: string|null }} params
 */
export function useSeasonPracticeAssignments({ organizationId, seasonSettingsId }) {
  const [version, setVersion] = useState(0);
  // Each read is keyed by what it read and when; a result for any other key
  // (a previous season, or the read before a refetch) is never served.
  const key =
    organizationId && seasonSettingsId ? `${organizationId}|${seasonSettingsId}|${version}` : null;
  const [result, setResult] = useState({ key: null, rows: [], error: null });

  // Re-read after this page writes (Apply), so the next run's cross-check
  // names the rows the save just created by their real ids.
  const refetch = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    if (!key) return undefined;
    let cancelled = false;
    loadSeasonPracticeAssignments(supabase, { organizationId, seasonSettingsId })
      .then((read) => {
        if (cancelled) return;
        setResult(
          read.ok === true
            ? { key, rows: read.rows, error: null }
            : { key, rows: [], error: new Error('message' in read ? read.message : 'unreadable') }
        );
      })
      .catch((err) => {
        if (!cancelled) setResult({ key, rows: [], error: err });
      });
    return () => {
      cancelled = true;
    };
  }, [key, organizationId, seasonSettingsId]);

  const current = key !== null && result.key === key;
  const loaded = current && !result.error;
  return {
    rows: loaded ? result.rows : EMPTY,
    loading: key !== null && !current,
    error: current ? result.error : null,
    loaded,
    refetch,
  };
}
