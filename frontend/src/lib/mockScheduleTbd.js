/**
 * Mock arms for `get_schedule_tbd` and `refresh_schedule_tbd_practices` (migration
 * `20261108020000_schedule_tbd.sql`), refusals included (LESSONS_LEARNED #13), with the SQL's
 * error codes:
 *   - 23502 no season id;
 *   - 42501 a season that does not exist, or one whose organization the caller does not administer
 *     (the two read alike, as in the SQL).
 * The rows are the season's `schedule_tbd` rows with the division and team names the SQL joins in,
 * in the SQL's order (kind, division name, team name, week, away team name, id).
 *
 * **Not mirrored** (stated so nobody reads this as the database):
 *   - the refresh's rebuild: `refresh_schedule_tbd_practices` is refused as the SQL refuses it, but
 *     rebuilds nothing and writes no audit row; it answers with the list as seeded
 *     (`changed: false`). The SQL rebuilds the practice rows from the roster, the division counts and
 *     the saved assignments, keeps each row's reason and run, and audits a change
 *     (`schedule_tbd.refreshed`);
 *   - the writers: the mock persists no practice or game schedule through the SQL, so
 *     `persist_practice_schedule` does not rebuild this list and `persist_game_schedule` does not
 *     record the run's unscheduled games; a test or scenario seeds `db.schedule_tbd` itself;
 *   - the table's RLS and its CHECKs (a seeded row is trusted as written).
 *
 * Pure over `db` so a test can drive it directly; `mockSupabaseClient.js` wires it into `rpc()`.
 */

export const SCHEDULE_TBD_RPCS = Object.freeze([
  'get_schedule_tbd',
  'refresh_schedule_tbd_practices',
]);

const fail = (code, message) => ({ data: null, error: { code, message } });

/** Compare two possibly-null strings the way the SQL's ORDER BY does (nulls last for strings). */
const compareText = (a, b) => String(a ?? '￿').localeCompare(String(b ?? '￿'));

/**
 * @param {any} db - the mock database
 * @param {string} name
 * @param {Record<string, any>} params
 * @param {{ isOrgAdmin: (organizationId: string) => boolean }} ctx
 * @returns {{ data: any, error: any } | null} null when `name` is not this RPC
 */
export function handleScheduleTbdRpc(db, name, params, ctx) {
  if (!SCHEDULE_TBD_RPCS.includes(name)) return null;
  const seasonId = params?.p_season_settings_id;
  if (!seasonId) return fail('23502', 'p_season_settings_id is required');
  const refresh = name === 'refresh_schedule_tbd_practices';

  const season = (db.season_settings || []).find((item) => String(item.id) === String(seasonId));
  if (!season || !ctx.isOrgAdmin(season.organization_id)) {
    return fail(
      '42501',
      `Access denied: the TIME TBD list is ${refresh ? 'refreshed' : 'read'} by an administrator of the season's organization`
    );
  }

  if (refresh) {
    const practiceRows = (db.schedule_tbd || []).filter(
      (row) =>
        row.kind === 'practice' &&
        String(row.season_settings_id) === String(seasonId) &&
        String(row.organization_id) === String(season.organization_id)
    );
    return {
      data: {
        changed: false,
        practice_rows: practiceRows.length,
        missing_practices: practiceRows.reduce((sum, row) => sum + (row.missing_count ?? 0), 0),
      },
      error: null,
    };
  }

  const teamName = (id) =>
    id == null ? null : ((db.teams || []).find((t) => String(t.id) === String(id))?.name ?? null);
  const divisionName = (id) =>
    (db.divisions || []).find((d) => String(d.id) === String(id))?.name ?? null;

  const rows = (db.schedule_tbd || [])
    .filter(
      (row) =>
        String(row.season_settings_id) === String(seasonId) &&
        String(row.organization_id) === String(season.organization_id)
    )
    .map((row) => ({
      id: row.id,
      kind: row.kind,
      season_settings_id: row.season_settings_id,
      division_id: row.division_id ?? null,
      division_name: divisionName(row.division_id),
      team_id: row.team_id ?? null,
      team_name: teamName(row.team_id),
      home_team_id: row.home_team_id ?? null,
      home_team_name: teamName(row.home_team_id),
      away_team_id: row.away_team_id ?? null,
      away_team_name: teamName(row.away_team_id),
      week_index: row.week_index ?? null,
      missing_count: row.missing_count ?? null,
      reason: row.reason,
      detail: row.detail ?? {},
      run_id: row.run_id ?? null,
      created_at: row.created_at ?? null,
    }))
    .sort(
      (a, b) =>
        compareText(a.kind, b.kind) ||
        compareText(a.division_name, b.division_name) ||
        compareText(a.team_name ?? a.home_team_name, b.team_name ?? b.home_team_name) ||
        (a.week_index ?? -1) - (b.week_index ?? -1) ||
        compareText(a.away_team_name, b.away_team_name) ||
        compareText(a.id, b.id)
    );

  return { data: rows, error: null };
}
