import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabaseClient.js';
import { fetchAllPages } from '../lib/pagedFetch.js';
import { loadSeasonPracticeAssignments } from '@squadlogic/core/practiceSupabase.js';
import { PREFERENCE_COLUMNS } from './useCoachPracticePreferences.js';

/**
 * The rows the practice repair recommendation panel (8.6 3b PR 10) reads, as
 * the user through RLS, with the existing client.
 *
 * **All or nothing.** Every table is read to completion (paged, so the server
 * row cap cannot truncate it) and the season's practice assignments through
 * `loadSeasonPracticeAssignments`, the scheduling page's own complete-read
 * contract. Any failed read makes the whole snapshot `{ ok: false }` naming
 * the table: a repair planned over a partial estate or a partial season
 * would recommend ground somebody already holds, so none is shown.
 *
 * Read-only by construction: `select` and the read-only
 * `practice_schedule_fingerprint` only. Nothing here geocodes or fetches
 * anything but these rows.
 *
 * **Fingerprint first** (8.6 3b PR 11c, `docs/PHASE_8_6_PR11_ENACT_PLAN.md`
 * §1 step 3, §4): the writer's fingerprint is read BEFORE any row, so a write
 * that lands between the two reads makes the base stale (the writer refuses
 * 40001), never a stale plan under a fresh base. It is part of the
 * all-or-nothing read: an unreadable fingerprint fails the snapshot. Each
 * practice row also carries its `assigned_via`, which the enact prompt shows.
 *
 * @param {any} client - the supabase client (`lib/supabaseClient.js`)
 * @param {{ organizationId: string, seasonSettingsId: string }} params
 * @returns {Promise<{ ok: true, rows: Record<string, any[]>, fingerprint: string } | { ok: false, message: string }>}
 */
export async function loadPracticeRepairSnapshot(client, { organizationId, seasonSettingsId }) {
  if (!organizationId || !seasonSettingsId) {
    return { ok: false, message: 'an organization and a season are required' };
  }
  /** @type {Array<[string, string, string]>} key, table, columns */
  const tables = [
    // `effective_to` on every node: the retirements the repair must honour.
    ['locations', 'locations', 'id, name, lighting_available, latitude, longitude, effective_to'],
    ['fields', 'fields', 'id, location_id, name, effective_to'],
    ['fieldSubunits', 'field_subunits', 'id, field_id, label, effective_to'],
    [
      'practiceSlots',
      'practice_slots',
      'id, field_id, field_subunit_id, day_of_week, start_time, end_time, valid_from, valid_until',
    ],
    ['teams', 'teams', 'id, name'],
    [
      'teamCoachAssignments',
      'team_coach_assignments',
      'id, team_id, coach_id, role, effective_from, effective_to',
    ],
    ['coachPreferences', 'coach_practice_preferences', PREFERENCE_COLUMNS],
    // The org's blackouts, through THE closure reader (`useFieldClosures`'
    // view): both arms, scope columns only, never the free-text note.
    [
      'fieldClosures',
      'field_closures',
      'id, source, closes_location_id, closes_field_id, blackout_from, blackout_until, start_minutes, end_minutes, reason',
    ],
  ];
  const print = await client.rpc('practice_schedule_fingerprint', {
    p_season_settings_id: seasonSettingsId,
  });
  if (print?.error || typeof print?.data !== 'string' || print.data === '') {
    return {
      ok: false,
      message: `practice_schedule_fingerprint: ${print?.error?.message ?? 'unreadable'}`,
    };
  }
  // In parallel (the sibling readers' `Promise.all` over `fetchAllPages`);
  // each read's failure is caught as its own, so any one fails the whole.
  const [reads, season] = await Promise.all([
    Promise.all(
      tables.map(([key, table, columns]) =>
        fetchAllPages(() =>
          client.from(table).select(columns).eq('organization_id', organizationId)
        ).then(
          (data) => ({ key, table, data, error: null }),
          (err) => ({ key, table, data: null, error: err })
        )
      )
    ),
    loadSeasonPracticeAssignments(client, { organizationId, seasonSettingsId }),
  ]);
  /** @type {Record<string, any[]>} */
  const rows = {};
  for (const read of reads) {
    if (read.error || !Array.isArray(read.data)) {
      return { ok: false, message: `${read.table}: ${read.error?.message ?? 'unreadable'}` };
    }
    rows[read.key] = read.data;
  }
  if (season.ok !== true) {
    return { ok: false, message: 'message' in season ? season.message : 'practice_assignments' };
  }
  // Back to the table's own column names: the adapter reads database rows.
  rows.practiceAssignments = season.rows.map((row) => ({
    id: row.id,
    team_id: row.teamId,
    practice_slot_id: row.slotId,
    effective_date_range: row.effectiveDateRange,
    source: row.source,
    assigned_via: row.assignedVia,
  }));
  return { ok: true, rows, fingerprint: print.data };
}

/**
 * The snapshot for one organization and season, read once per mount.
 *
 * @param {{ organizationId?: string|null, seasonSettingsId?: string|null }} params
 * @returns {{ loading: boolean, error: string|null, rows: Record<string, any[]>|null }}
 */
export function usePracticeRepairSnapshot({ organizationId, seasonSettingsId }) {
  const key = organizationId && seasonSettingsId ? `${organizationId}|${seasonSettingsId}` : null;
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
    loadPracticeRepairSnapshot(supabase, {
      organizationId: /** @type {string} */ (organizationId),
      seasonSettingsId: /** @type {string} */ (seasonSettingsId),
    })
      .then((read) => {
        if (cancelled) return;
        setResult(
          read.ok === true
            ? { key, rows: read.rows, error: null }
            : { key, rows: null, error: 'message' in read ? read.message : 'unreadable' }
        );
      })
      .catch((err) => {
        if (!cancelled) setResult({ key, rows: null, error: err?.message ?? 'unreadable' });
      });
    return () => {
      cancelled = true;
    };
  }, [key, organizationId, seasonSettingsId]);

  if (!key) {
    return { loading: false, error: 'No organization and season are selected.', rows: null };
  }
  const current = result.key === key;
  return {
    loading: !current,
    error: current ? result.error : null,
    rows: current ? result.rows : null,
  };
}
