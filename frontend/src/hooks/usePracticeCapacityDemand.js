import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabaseClient.js';
import { fetchAllPages } from '../lib/pagedFetch.js';
import { loadSeasonPracticeAssignments } from '@squadlogic/core/practiceSupabase.js';
import { seasonCalendarDate } from '@squadlogic/core/timing/index.js';

/**
 * The rows the "Before you run: slots against what each division needs" panel reads (schedule
 * expansion, PR 13, `docs/changes/2026-11-03-schedule-expansion.md`, 5.9), as the user through RLS,
 * with the existing client. Read-only by construction: `select` only, no RPC.
 *
 * **All or nothing** (lessons 90 and 93). A figure over a partial read says a division has room
 * because the slot that fills it was never read, or has no team because the team was. Every table
 * is read to completion (paged, so the server row cap cannot truncate it), the season's saved
 * practices through `loadSeasonPracticeAssignments` (the Practices page's own complete-read
 * contract), and any failed read makes the whole read `{ ok: false }` naming the table: the panel
 * then says it could not read the season and draws no row.
 *
 * What is read, and why only this:
 *
 * - `divisions` of the season (`practices_per_week`, `practice_minutes`): the rows of the panel.
 * - `teams`: the roster, the subject set. Not the solver's output, not the saved practices
 *   (lessons 46 and 92); a team of another season has no division among the season's and is left
 *   out by the model.
 * - `practice_slots`: every slot of the organization, as the Practices page reads them; the model
 *   dates them, reads the reservation (`division_id`) and the length.
 * - `practice_assignments`: the saved rows, counted as the planner counts them.
 *
 * `is_external` (PR 5) does not exist yet: when it does, the census of its readers must classify
 * this read of `teams`, and an external team must not count as demand here.
 */

/** What the panel says when there is nothing to read. */
export const NO_SEASON_MESSAGE =
  'This organization has no season yet, so there is nothing to check against its practice slots.';
export const NO_ZONE_MESSAGE =
  "The season has no time zone, so today's date cannot be placed on its clock. Set the season's time zone in Settings.";

/**
 * Read every table the panel needs, or say which one failed.
 *
 * @param {any} client - the supabase client (`lib/supabaseClient.js`)
 * @param {{ organizationId: string, seasonSettingsId: string }} params
 * @returns {Promise<{ ok: true, rows: { divisions: any[], teams: any[], practiceSlots: any[],
 *   practiceAssignments: any[] } } | { ok: false, message: string, table: string }>}
 */
export async function loadPracticeCapacityRows(client, { organizationId, seasonSettingsId }) {
  if (!organizationId || !seasonSettingsId) {
    return { ok: false, table: 'season', message: 'an organization and a season are required' };
  }
  /** @type {Array<[string, string, () => any]>} */
  const reads = [
    [
      'divisions',
      'divisions',
      () =>
        client
          .from('divisions')
          .select('id, name, practices_per_week, practice_minutes')
          .eq('organization_id', organizationId)
          .eq('season_settings_id', seasonSettingsId),
    ],
    [
      'teams',
      'teams',
      () => client.from('teams').select('id, division_id').eq('organization_id', organizationId),
    ],
    [
      'practiceSlots',
      'practice_slots',
      () =>
        client
          .from('practice_slots')
          .select(
            'id, day_of_week, start_time, end_time, capacity, valid_from, valid_until, division_id'
          )
          .eq('organization_id', organizationId),
    ],
  ];
  const [tables, assignments] = await Promise.all([
    Promise.all(
      reads.map(([key, table, query]) =>
        fetchAllPages(query).then(
          (data) => ({ key, table, data, error: null }),
          (err) => ({ key, table, data: null, error: err })
        )
      )
    ),
    // Core's loader reports a refused read as `{ ok: false }` but lets a rejected request throw.
    loadSeasonPracticeAssignments(client, { organizationId, seasonSettingsId }).catch((err) => ({
      ok: /** @type {const} */ (false),
      message: `practice_assignments: ${err?.message ?? 'unreadable'}`,
    })),
  ]);
  /** @type {Record<string, any[]>} */
  const rows = {};
  for (const read of tables) {
    if (read.error || !Array.isArray(read.data)) {
      return {
        ok: false,
        table: read.table,
        message: `${read.table}: ${read.error?.message ?? 'unreadable'}`,
      };
    }
    rows[read.key] = read.data;
  }
  if (assignments.ok !== true) {
    return {
      ok: false,
      table: 'practice_assignments',
      message: 'message' in assignments ? assignments.message : 'practice_assignments: unreadable',
    };
  }
  return {
    ok: true,
    rows: {
      divisions: rows.divisions,
      teams: rows.teams,
      practiceSlots: rows.practiceSlots,
      practiceAssignments: assignments.rows,
    },
  };
}

/**
 * The panel's rows for one organization and season.
 *
 * `status` is one of: `loading` (not read yet, or being read again: the panel says "not checked
 * yet" and shows no figure); `ready` (with `rows`, and `liveFrom`, today on the season's clock as
 * read when the rows were); `unreadable` (a read failed: `message` names the table, `rows` is
 * null); `no-season`; `no-zone` (neither reads anything).
 *
 * A result is served only for the key it was read under: the organization, the season, its zone and
 * `refreshKey`. The page bumps `refreshKey` whenever it saves or re-reads the season's practices, so
 * a panel never shows rows read before a save as if they were current (lesson 97).
 *
 * @param {{ organizationId?: string|null, season?: Record<string, any>|null,
 *   seasonLoading?: boolean, refreshKey?: number|string }} params
 * @returns {{ status: 'loading'|'ready'|'unreadable'|'no-season'|'no-zone', message: string|null,
 *   rows: { divisions: any[], teams: any[], practiceSlots: any[], practiceAssignments: any[] }|null,
 *   liveFrom: string|null }}
 */
export function usePracticeCapacityDemand({
  organizationId,
  season,
  seasonLoading = false,
  refreshKey = 0,
}) {
  const seasonId = season?.id ? String(season.id) : null;
  const zone = typeof season?.timezone === 'string' ? season.timezone.trim() : '';
  // What can be answered without a read. `seasonLoading` is the context's "not yet": a held
  // season row may belong to the organization just left, so nothing is read or shown from it.
  /** @type {'loading'|'no-season'|'no-zone'|null} */
  let blocked = null;
  if (!organizationId) blocked = 'no-season';
  else if (seasonLoading) blocked = 'loading';
  else if (!seasonId) blocked = 'no-season';
  else if (zone === '') blocked = 'no-zone';
  const key =
    blocked === null ? `${organizationId}|${seasonId}|${zone}|${String(refreshKey)}` : null;
  const [result, setResult] = useState(
    /** @type {{ key: string|null, rows: any, liveFrom: string|null, error: string|null }} */ ({
      key: null,
      rows: null,
      liveFrom: null,
      error: null,
    })
  );

  useEffect(() => {
    if (!key) return undefined;
    let cancelled = false;
    // Today is read with the rows, so the figures and the date they are for cannot disagree. Every
    // state change below happens after an `await`, never in the effect's own turn.
    (async () => {
      const liveFrom = seasonCalendarDate(Date.now(), zone);
      if (liveFrom === null) {
        return {
          key,
          rows: null,
          liveFrom: null,
          error: `the season's time zone (${zone}) is not one this browser knows, so today cannot be placed on its clock`,
        };
      }
      const read = await loadPracticeCapacityRows(supabase, {
        organizationId: /** @type {string} */ (organizationId),
        seasonSettingsId: /** @type {string} */ (seasonId),
      });
      return read.ok === true
        ? { key, rows: read.rows, liveFrom, error: null }
        : { key, rows: null, liveFrom: null, error: read.message };
    })().then(
      (next) => {
        if (!cancelled) setResult(next);
      },
      (err) => {
        if (!cancelled) {
          setResult({ key, rows: null, liveFrom: null, error: err?.message ?? 'unreadable' });
        }
      }
    );
    return () => {
      cancelled = true;
    };
  }, [key, organizationId, seasonId, zone]);

  if (blocked === 'no-season') {
    return { status: 'no-season', message: NO_SEASON_MESSAGE, rows: null, liveFrom: null };
  }
  if (blocked === 'no-zone') {
    return { status: 'no-zone', message: NO_ZONE_MESSAGE, rows: null, liveFrom: null };
  }
  if (blocked === 'loading' || result.key !== key) {
    return { status: 'loading', message: null, rows: null, liveFrom: null };
  }
  if (result.error) {
    return { status: 'unreadable', message: result.error, rows: null, liveFrom: null };
  }
  return { status: 'ready', message: null, rows: result.rows, liveFrom: result.liveFrom };
}
