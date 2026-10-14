import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabaseClient.js';
import { useOrganization } from '../contexts/OrganizationContext.jsx';
import { loadSeasonPracticeRows } from '@squadlogic/core/practiceSupabase.js';
import { mapKeysToCamelCase } from '../utils/caseConverters.js';
import { logger } from '../lib/logger.js';

/** @type {any[]} */
const EMPTY = /** @type {any[]} */ (Object.freeze([]));

/**
 * The export's columns: the series fields the CSV and the coach drafts print
 * (slot weekday and time, field, team, division), and the season embed the
 * scope filter runs on (`loadSeasonPracticeRows`).
 */
export const CURRENT_PRACTICE_SCHEDULE_SELECT = `
  *,
  practice_slots!practice_slot_id (
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
  teams!inner (
    id,
    name,
    divisions!inner (
      id,
      name,
      season_settings_id
    )
  )
`;

/**
 * Every CURRENT `practice_assignments` row of the active season, camelCased,
 * for the CSV exports and the coach email drafts.
 *
 * **Not `usePracticeAssignments(latestRunId)`.** Writer v3 keeps a row under
 * the run that last wrote it. A re-home enact keeps the displaced series by
 * id through `closes` without re-sending it, and a save that omits a team
 * keeps that team's `manual` rows; both stay live under an OLDER run id than
 * the season's latest, and a latest-run reader silently leaves them out.
 *
 * The contract is `loadSeasonPracticeAssignments`' (the lock, the repair
 * snapshot, the scheduling page's locked set): same scope, order and paging,
 * through the same core loop. Superseded rows need no filter here: the
 * writer's prune deletes them (20261002000000, `DELETE FROM
 * practice_assignments ... v_prune_ids`), and a closed row is not superseded,
 * it is the part of the series before its loss, under its shortened range.
 *
 * Never partial: `loading` is true until a COMPLETE read of the current
 * organisation and season has landed, and a failed read is `error` with no
 * rows, so the export gate never treats "not read" as "none".
 *
 * `refetch()` reads the season again: the practice page calls it when a
 * save's outcome is unknown (`isUnknownPersistenceOutcome`). While that re-read
 * is in flight, the last COMPLETE read of the SAME organisation and season
 * stays served, with `loading` true, rather than nothing: the grid keeps its
 * rows instead of going blank, and a gate on `loading` still waits. A read of
 * any other organisation or season is never served (the key's first two parts).
 */
export function useCurrentPracticeSchedule() {
  const { currentOrganization, currentSeasonSetting } = useOrganization() || {};
  const organizationId = currentOrganization?.id ?? null;
  const seasonSettingsId = currentSeasonSetting?.id ?? null;
  const [version, setVersion] = useState(0);
  const refetch = useCallback(() => setVersion((v) => v + 1), []);
  const scope = organizationId && seasonSettingsId ? `${organizationId}|${seasonSettingsId}` : null;
  const key = scope ? `${scope}|${version}` : null;
  const [result, setResult] = useState({ key: null, scope: null, rows: EMPTY, error: null });

  useEffect(() => {
    if (!key) return undefined;
    let cancelled = false;
    loadSeasonPracticeRows(supabase, {
      organizationId,
      seasonSettingsId,
      select: CURRENT_PRACTICE_SCHEDULE_SELECT,
    })
      .then((read) => {
        if (cancelled) return;
        if (read.ok === true) {
          setResult({ key, scope, rows: read.rows.map(mapKeysToCamelCase), error: null });
        } else {
          const message = 'message' in read ? read.message : 'unreadable';
          logger.error('Error fetching the current practice schedule:', message);
          setResult({ key, scope, rows: EMPTY, error: new Error(message) });
        }
      })
      .catch((err) => {
        if (cancelled) return;
        logger.error('Error fetching the current practice schedule:', err);
        setResult({ key, scope, rows: EMPTY, error: err });
      });
    return () => {
      cancelled = true;
    };
  }, [key, scope, organizationId, seasonSettingsId]);

  const current = key !== null && result.key === key;
  // A refetch of this same scope: the previous complete read, until it lands.
  const rereading = !current && scope !== null && result.scope === scope && !result.error;
  return {
    assignments: current || rereading ? result.rows : EMPTY,
    loading: key !== null && !current,
    error: current ? result.error : null,
    refetch,
  };
}
