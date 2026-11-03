import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabaseClient.js';
import { fetchAllPages } from '../lib/pagedFetch.js';
import { loadSeasonPracticeAssignments } from '@squadlogic/core/practiceSupabase.js';

/**
 * The rows the read-only Practice daylight outlook reads (duration-phase wiring,
 * `docs/changes/2026-11-02-duration-phases-wiring.md`, PR B), as the user
 * through RLS, with the existing client.
 *
 * **All or nothing.** The reports need every one of these tables (the adapter
 * refuses a missing one), and a report over a partial read would say a slot
 * survives because the row that shows it does not was never read. Every table
 * is read to completion (paged, so the server row cap cannot truncate it) and
 * the season's practice assignments through `loadSeasonPracticeAssignments`, the
 * scheduling page's own complete-read contract. Any failed read makes the whole
 * read `{ ok: false }` naming the table, and the page then says it could not
 * read the season: never "survives", never an empty-looking success.
 *
 * Read-only by construction: `select` only, no RPC. The season row comes from
 * the organization context (it is already read there); a season with no time
 * zone is answered with a message and no read, since no sunset can be placed on
 * a clock the season does not have.
 */

/** @type {ReadonlyArray<ReadonlyArray<string>>} key, table, columns */
const TABLES = Object.freeze([
  Object.freeze(['locations', 'locations', 'id, name, lighting_available, latitude, longitude']),
  Object.freeze(['fields', 'fields', 'id, location_id, name']),
  Object.freeze(['fieldSubunits', 'field_subunits', 'id, field_id, label']),
  Object.freeze([
    'practiceSlots',
    'practice_slots',
    'id, field_id, field_subunit_id, day_of_week, start_time, end_time, valid_from, valid_until',
  ]),
  Object.freeze([
    'lightingOverrides',
    'practice_lighting_overrides',
    'id, practice_slot_id, window, kind, status',
  ]),
  // Names only: the teams assigned to a slot are shown by name.
  Object.freeze(['teams', 'teams', 'id, name']),
]);

/**
 * Read every table the outlook needs, or say which one failed.
 *
 * @param {any} client - the supabase client (`lib/supabaseClient.js`)
 * @param {{ organizationId: string, seasonSettingsId: string }} params
 * @returns {Promise<{ ok: true, rows: Record<string, any[]> } | { ok: false, message: string, table: string }>}
 */
export async function loadPracticeDaylightRows(client, { organizationId, seasonSettingsId }) {
  if (!organizationId || !seasonSettingsId) {
    return { ok: false, table: 'season', message: 'an organization and a season are required' };
  }
  const [reads, season] = await Promise.all([
    Promise.all(
      TABLES.map(([key, table, columns]) =>
        fetchAllPages(() =>
          client.from(table).select(columns).eq('organization_id', organizationId)
        ).then(
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
  for (const read of reads) {
    if (read.error || !Array.isArray(read.data)) {
      return {
        ok: false,
        table: read.table,
        message: `${read.table}: ${read.error?.message ?? 'unreadable'}`,
      };
    }
    rows[read.key] = read.data;
  }
  if (season.ok !== true) {
    return {
      ok: false,
      table: 'practice_assignments',
      message: 'message' in season ? season.message : 'practice_assignments: unreadable',
    };
  }
  // Back to the table's own column names: the adapter reads database rows.
  rows.practiceAssignments = season.rows.map((row) => ({
    id: row.id,
    team_id: row.teamId,
    practice_slot_id: row.slotId,
    effective_date_range: row.effectiveDateRange,
  }));
  return { ok: true, rows };
}

/** What the page says when there is nothing to read. */
export const NO_SEASON_MESSAGE =
  'This organization has no season yet, so there are no practices to look at.';
export const NO_ZONE_MESSAGE =
  'The season has no time zone, so no sunset can be placed on its clock. Set the season’s time zone in Settings.';

/**
 * The outlook's rows for one organization and season, read once per mount.
 *
 * `status` is one of: `loading`; `ready` (with `rows`); `unreadable` (a read
 * failed: `message` names the table, `rows` is null); `no-season`; `no-zone`
 * (neither reads anything).
 *
 * @param {{ organizationId?: string|null, season?: Record<string, any>|null,
 *   seasonLoading?: boolean }} params
 * @returns {{ status: 'loading'|'ready'|'unreadable'|'no-season'|'no-zone', message: string|null,
 *   rows: Record<string, any[]>|null }}
 */
export function usePracticeDaylightOutlook({ organizationId, season, seasonLoading = false }) {
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
  const key = blocked === null ? `${organizationId}|${seasonId}` : null;
  const [result, setResult] = useState(
    /** @type {{ key: string|null, rows: Record<string, any[]>|null, error: string|null }} */ ({
      key: null,
      rows: null,
      error: null,
    })
  );

  useEffect(() => {
    if (!key) return undefined;
    let cancelled = false;
    loadPracticeDaylightRows(supabase, {
      organizationId: /** @type {string} */ (organizationId),
      seasonSettingsId: /** @type {string} */ (seasonId),
    })
      .then((read) => {
        if (cancelled) return;
        setResult(
          read.ok === true
            ? { key, rows: read.rows, error: null }
            : { key, rows: null, error: read.message }
        );
      })
      .catch((err) => {
        if (!cancelled) setResult({ key, rows: null, error: err?.message ?? 'unreadable' });
      });
    return () => {
      cancelled = true;
    };
  }, [key, organizationId, seasonId]);

  if (blocked === 'no-season')
    return { status: 'no-season', message: NO_SEASON_MESSAGE, rows: null };
  if (blocked === 'no-zone') return { status: 'no-zone', message: NO_ZONE_MESSAGE, rows: null };
  if (blocked === 'loading') return { status: 'loading', message: null, rows: null };
  if (result.key !== key) return { status: 'loading', message: null, rows: null };
  if (result.error) return { status: 'unreadable', message: result.error, rows: null };
  return { status: 'ready', message: null, rows: result.rows };
}
