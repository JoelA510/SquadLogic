import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabaseClient.js';
import { fetchAllPages } from '../lib/pagedFetch.js';

/** @type {any[]} */
const EMPTY = /** @type {any[]} */ (Object.freeze([]));

/**
 * The `practice_exceptions` columns the scoring engines read (the M4.7
 * follow-up, `docs/PLAN_SCORING_DATE_MODEL.md` Q1): the row as stored, which
 * is what `applyPracticeExceptions` reads. The relocated slot is named by
 * `practice_slot_id` and resolved by the engines against the slots they are
 * sent, so no slot is embedded. `cause_kind` is not read: no engine output
 * carries it.
 */
export const SEASON_PRACTICE_EXCEPTIONS_SELECT =
  'id, assignment_id, window, kind, tbd_reason, withdrawn_at, practice_slot_id';

/**
 * Every live saved practice exception of the season, read as the user through
 * RLS, for the practice page's evaluation (the fairness panel and the metrics
 * persisted on Apply).
 *
 * Live rows only (`withdrawn_at` null), as the portal and the feed read them;
 * the helper filters withdrawn rows again itself, so the filter is an economy,
 * not the guarantee. Paged (`fetchAllPages`), so no read is silently
 * truncated.
 *
 * `loaded` is true only after a COMPLETE read of the current season. While
 * loading, after a failed read, or with no season, it is false and `rows` is
 * empty: a caller must not score a schedule as if it had no exceptions when
 * they were never read.
 *
 * @param {{ organizationId?: string|null, seasonSettingsId?: string|null }} params
 */
export function useSeasonPracticeExceptions({ organizationId, seasonSettingsId }) {
  const [version, setVersion] = useState(0);
  // Each read is keyed by what it read and when; a result for any other key
  // (a previous season, or the read before a refetch) is never served.
  const key =
    organizationId && seasonSettingsId ? `${organizationId}|${seasonSettingsId}|${version}` : null;
  const [result, setResult] = useState({ key: null, rows: [], error: null });

  // Re-read after this page writes (Apply): a save can write or cut exceptions.
  const refetch = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    if (!key) return undefined;
    let cancelled = false;
    fetchAllPages(() =>
      supabase
        .from('practice_exceptions')
        .select(SEASON_PRACTICE_EXCEPTIONS_SELECT)
        .eq('organization_id', organizationId)
        .eq('season_settings_id', seasonSettingsId)
        .is('withdrawn_at', null)
    )
      .then((rows) => {
        if (!cancelled) setResult({ key, rows, error: null });
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
