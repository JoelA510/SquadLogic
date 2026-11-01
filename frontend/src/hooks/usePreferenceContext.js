import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabaseClient.js';
import { fetchAllPages } from '../lib/pagedFetch.js';
import { logger } from '../lib/logger.js';

/**
 * What the practice preferences screens read beside the rule rows: the season's coaches (with the
 * email the import keys on), the organization's locations, the roster (`team_coach_assignments`,
 * paged -- the history only grows), the teams and the divisions that place them in a season, and the
 * current practice series with their slots (what a must is re-judged against).
 *
 * `error` is a failed read of the coaches or locations (the lists the screens name people and
 * places from); `previewError` a failed read of the data a re-judge or an import preview needs.
 * Neither is swallowed: the screens show them and refuse to preview over a half-loaded context.
 *
 * @type {Readonly<{ coaches: any[], locations: any[], rosterRows: any[], teams: any[],
 *   divisions: any[], practiceRows: any[], error: any, previewError: any, loading: boolean }>}
 */
export const LOADING_CONTEXT = Object.freeze({
  coaches: [],
  locations: [],
  rosterRows: [],
  teams: [],
  divisions: [],
  practiceRows: [],
  error: null,
  previewError: null,
  loading: true,
});

/**
 * @param {string | null | undefined} orgId
 * @param {string | null | undefined} seasonId - the season the header shows; coaches belong to one
 */
export function usePreferenceContext(orgId, seasonId) {
  const [state, setState] = useState(LOADING_CONTEXT);

  useEffect(() => {
    if (!orgId || !seasonId) return undefined;
    let cancelled = false;
    (async () => {
      // An org switch must not leave the previous org's coaches actionable (an "Add" on one would
      // write to that org) or feed its roster to the preview.
      setState(LOADING_CONTEXT);
      const [coachResult, locationResult] = await Promise.all([
        // The coaches of the season the header shows (20261108010000).
        supabase
          .from('coaches')
          .select('id, full_name, email, season_settings_id')
          .eq('organization_id', orgId)
          .eq('season_settings_id', seasonId),
        supabase.from('locations').select('id, name').eq('organization_id', orgId),
      ]);
      let previewError = null;
      let rosterRows = [];
      let teams = [];
      let divisions = [];
      let practiceRows = [];
      try {
        [rosterRows, teams, divisions, practiceRows] = await Promise.all([
          fetchAllPages(() =>
            supabase
              .from('team_coach_assignments')
              .select('id, team_id, coach_id, role, effective_from, effective_to')
              .eq('organization_id', orgId)
          ),
          fetchAllPages(() =>
            supabase.from('teams').select('id, name, division_id').eq('organization_id', orgId)
          ),
          fetchAllPages(() =>
            supabase.from('divisions').select('id, season_settings_id').eq('organization_id', orgId)
          ),
          fetchAllPages(() =>
            supabase
              .from('practice_assignments')
              .select(
                'id, team_id, effective_date_range, slot:practice_slots!practice_slot_id (day_of_week, start_time, field:fields (location_id))'
              )
              .eq('organization_id', orgId)
          ),
        ]);
      } catch (err) {
        logger.error('Failed to load the re-judge context', err);
        previewError = err || { message: 'unknown error' };
      }
      if (cancelled) return;
      const error = coachResult.error || locationResult.error || null;
      if (error) logger.error('Failed to load coaches or locations', error);
      setState({
        coaches: coachResult.data || [],
        locations: locationResult.data || [],
        rosterRows,
        teams,
        divisions,
        practiceRows,
        error,
        previewError,
        loading: false,
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [orgId, seasonId]);

  return state;
}

/** No jobs to name: one frozen value, so a memo that reads it does not run again each render. */
const NO_LABELS = Object.freeze({
  key: /** @type {string} */ (''),
  labels: /** @type {Map<string, { fileName: string, createdAt: string | null }>} */ (new Map()),
  error: /** @type {any} */ (null),
});

/**
 * The import jobs the pending musts came from, by id: the file name and the day, for "Accept all"
 * to say which file it means. The name is the job's `storage_path` tail (`imports/<user>/<file>`).
 * A failed read is returned, not hidden: the group is then named by its date alone.
 *
 * @param {string | null | undefined} orgId
 * @param {string[]} jobIds
 */
export function useImportJobLabels(orgId, jobIds) {
  const [state, setState] = useState(NO_LABELS);
  const key = [...new Set(jobIds)].sort().join(',');

  useEffect(() => {
    if (!orgId || key === '') return undefined;
    const ids = key.split(',');
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from('import_jobs')
        .select('id, storage_path, created_at')
        .eq('organization_id', orgId)
        .in('id', ids);
      if (cancelled) return;
      if (error) {
        logger.error('Failed to load the import jobs of the pending musts', error);
        setState({ key, labels: new Map(), error });
        return;
      }
      setState({
        key,
        labels: new Map(
          (data || []).map((job) => [
            String(job.id),
            {
              fileName:
                String(job.storage_path ?? '')
                  .split('/')
                  .pop() || 'a preference file',
              createdAt: job.created_at ?? null,
            },
          ])
        ),
        error: null,
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [orgId, key]);

  // What was read for another set of jobs (or another organization) is not an answer for this one.
  return !orgId || key === '' || state.key !== key ? NO_LABELS : state;
}
