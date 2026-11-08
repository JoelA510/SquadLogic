import { positiveWeek } from '@squadlogic/core/reports/gameKey.js';
import { fetchAllPages } from '../lib/pagedFetch.js';
import { loadSeasonPracticeRows } from '@squadlogic/core/practiceSupabase.js';
import { PUBLICATION_REASON } from '@squadlogic/core/publication/reasonCodes.js';
import { readScheduleTbd } from './scheduleTbdClient.js';

/**
 * The reads behind the schedule reports on the Exports page (PR 7 of the schedule expansion, plan
 * `docs/changes/2026-11-03-schedule-expansion.md`, 5.1 and 5.6): the Day Sheet, the coach schedule and "Changes since
 * publication". Read-only: `select` and two read RPCs, nothing else.
 *
 * ## All or nothing, naming the table (lessons 90 and 93)
 *
 * A report drawn over a partial league says a game is missing because the row that shows it was never read, so each
 * read here is a whole: a table that fails, as an error answer or as a rejected request, makes the result
 * `{ ok: false, table, message }` with no data, and the page draws nothing from it. Every table is read to the end
 * (`fetchAllPages`): an unranged select is cut at the server's row cap.
 *
 * ## Subject sets come from the registry, not from the games (lessons 46 and 92)
 *
 * The teams are the season's through its divisions (a team carries no season of its own), the coaches are the
 * season's own rows, and the assignments are those of the season's teams. A coach with no team is in the league; a
 * team of another season is not.
 *
 * ## A name and an id, never a contact (data minimisation)
 *
 * The coaches are read as `id, full_name`. The stored `can_coach_multiple_teams` flag is not read at all: the
 * multi-team marker is counted from the team list.
 *
 * @module utils/scheduleReportsRead
 */

/** The practices with their slot and field. The hint names the foreign key: `practice_assignments` has two to slots. */
export const PRACTICE_READ_SELECT =
  'id, team_id, effective_date_range, teams!inner(divisions!inner(season_settings_id)), ' +
  'slot:practice_slots!practice_slot_id(day_of_week, start_time, end_time, valid_from, valid_until, ' +
  'field:fields(id, name))';

const AUDIT_LIMIT = 500;

/**
 * The tables each report needs, so a report is not blocked by a read it does not use. The league is what every report
 * is built over (venues, fields, divisions, teams, slots, the TIME TBD list); the coaches group is the coach schedule's
 * alone (the coaches, their assignments and the practices), read with the divisions and teams that scope them to the
 * season.
 */
const TABLE_GROUPS = Object.freeze({
  league: ['locations', 'fields', 'divisions', 'teams', 'game_slots', 'get_schedule_tbd'],
  coaches: ['coaches', 'team_coach_assignments', 'practice_assignments', 'divisions', 'teams'],
});
/** The order a failure is reported in, so the same break gives the same sentence. */
const TABLE_ORDER = [
  'locations',
  'fields',
  'divisions',
  'teams',
  'coaches',
  'team_coach_assignments',
  'game_slots',
  'practice_assignments',
  'get_schedule_tbd',
];

/** @param {string} table @param {unknown} err */
const failure = (table, err) => ({
  ok: /** @type {const} */ (false),
  table,
  message:
    (err && typeof err === 'object' && 'message' in err && err.message
      ? String(err.message)
      : String(err ?? 'the read failed')) || 'the read failed',
});

/**
 * Run one named read; a throw (a rejected request) and a `{ error }` answer are both a failure of that table.
 *
 * @template T
 * @param {string} table
 * @param {() => Promise<T>} read
 * @returns {Promise<{ ok: true, value: T } | { ok: false, table: string, message: string }>}
 */
async function named(table, read) {
  try {
    return { ok: true, value: await read() };
  } catch (err) {
    return failure(table, err);
  }
}

/**
 * `practice_assignments` rows (with their slot embedded) as the reports take a practice.
 *
 * @param {Array<Record<string, any>>} rows
 * @returns {Array<import('@squadlogic/core/reports/practiceClash.js').ReportPractice>}
 */
export function practicesFromRows(rows) {
  return rows.map((row) => {
    const embedded = Array.isArray(row.slot) ? row.slot[0] : row.slot;
    const slot = embedded ?? null;
    const field = Array.isArray(slot?.field) ? slot.field[0] : (slot?.field ?? null);
    return {
      id: String(row.id),
      teamId: String(row.team_id),
      range: row.effective_date_range ?? null,
      dayOfWeek: slot?.day_of_week ?? null,
      startTime: slot?.start_time ?? null,
      endTime: slot?.end_time ?? null,
      validFrom: slot?.valid_from ?? null,
      validUntil: slot?.valid_until ?? null,
      fieldId: field?.id ?? null,
      fieldName: field?.name ?? null,
    };
  });
}

/**
 * Read the league the reports are built over.
 *
 * @param {any} client - the supabase client
 * @param {{ organizationId?: string | null, seasonSettingsId?: string | null }} params
 * @param {{ groups?: Array<'league' | 'coaches'> }} [options] - which tables to read; both by default
 * @returns {Promise<{ ok: true, data: {
 *   venues: Array<{ id: string, name: string }>,
 *   fields: Array<{ id: string, name: string, venueId: string | null }>,
 *   teams: Array<{ id: string, name: string, divisionId: string, division: string }>,
 *   coaches: Array<{ id: string, name: string }>,
 *   assignments: Array<Record<string, any>>,
 *   slots: Array<{ id: string, weekIndex: number | null }>,
 *   practices: Array<import('@squadlogic/core/reports/practiceClash.js').ReportPractice>,
 *   tbdGames: Array<{ homeTeamId: string, awayTeamId: string, weekIndex: number, reason: string }>,
 * } } | { ok: false, table: string, message: string }>}
 */
export async function loadReportsReference(
  client,
  params,
  { groups = ['league', 'coaches'] } = {}
) {
  const { organizationId, seasonSettingsId } = params ?? {};
  if (!organizationId || !seasonSettingsId) {
    return failure('season', 'an organization and a season are required');
  }
  if (typeof client?.from !== 'function' || typeof client?.rpc !== 'function') {
    return failure('connection', 'there is no database connection to read with');
  }
  const unknown = groups.filter((group) => !(group in TABLE_GROUPS));
  if (unknown.length > 0)
    return failure('groups', `unknown report data group: ${unknown.join(', ')}`);

  const read = (table, columns) =>
    fetchAllPages(() => client.from(table).select(columns).eq('organization_id', organizationId));
  /** @type {Record<string, () => Promise<any>>} */
  const readers = {
    locations: () => read('locations', 'id, name'),
    fields: () => read('fields', 'id, name, location_id'),
    divisions: () =>
      fetchAllPages(() =>
        client
          .from('divisions')
          .select('id, name')
          .eq('organization_id', organizationId)
          .eq('season_settings_id', seasonSettingsId)
      ),
    teams: () => read('teams', 'id, name, division_id'),
    coaches: () =>
      fetchAllPages(() =>
        client
          .from('coaches')
          .select('id, full_name')
          .eq('organization_id', organizationId)
          .eq('season_settings_id', seasonSettingsId)
      ),
    team_coach_assignments: () =>
      read('team_coach_assignments', 'id, team_id, coach_id, role, effective_from, effective_to'),
    game_slots: () => read('game_slots', 'id, week_index'),
    practice_assignments: async () => {
      const result = await loadSeasonPracticeRows(client, {
        organizationId,
        seasonSettingsId,
        select: PRACTICE_READ_SELECT,
      });
      if (result.ok !== true) throw new Error(result.message);
      return result.rows;
    },
    get_schedule_tbd: () => readScheduleTbd(client, seasonSettingsId),
  };
  const wanted = new Set(groups.flatMap((group) => TABLE_GROUPS[group]));
  const tables = TABLE_ORDER.filter((table) => wanted.has(table));
  const results = await Promise.all(tables.map((table) => named(table, readers[table])));
  // The first failure in the table order, so the same break gives the same sentence.
  const failed = results.find((result) => result.ok === false);
  if (failed && failed.ok === false) return failed;
  /** @type {Record<string, any>} */
  const got = Object.fromEntries(
    tables.map((table, index) => [table, /** @type {any} */ (results[index]).value])
  );
  const rows = (table) => got[table] ?? [];

  const divisionName = new Map(
    rows('divisions').map((row) => [String(row.id), String(row.name ?? '')])
  );
  // A team carries no season of its own: it is the season's through its division.
  const seasonTeams = rows('teams')
    .filter((row) => divisionName.has(String(row.division_id)))
    .map((row) => ({
      id: String(row.id),
      name: String(row.name ?? row.id),
      divisionId: String(row.division_id),
      division: divisionName.get(String(row.division_id)) ?? '',
    }));
  const seasonTeamIds = new Set(seasonTeams.map((team) => team.id));
  return {
    ok: true,
    data: {
      venues: rows('locations').map((row) => ({
        id: String(row.id),
        name: String(row.name ?? ''),
      })),
      fields: rows('fields').map((row) => ({
        id: String(row.id),
        name: String(row.name ?? ''),
        venueId: row.location_id ? String(row.location_id) : null,
      })),
      teams: seasonTeams,
      coaches: rows('coaches').map((row) => ({
        id: String(row.id),
        name: String(row.full_name ?? ''),
      })),
      assignments: rows('team_coach_assignments').filter((row) =>
        seasonTeamIds.has(String(row.team_id))
      ),
      // A slot with no week has no week: `Number(null)` is 0, which is not one (reports/gameKey.js, `positiveWeek`).
      slots: rows('game_slots').map((row) => ({
        id: String(row.id),
        weekIndex: positiveWeek(row.week_index),
      })),
      practices: practicesFromRows(rows('practice_assignments')),
      tbdGames: (got.get_schedule_tbd?.items ?? [])
        .filter((item) => item.kind === 'game')
        .map((item) => ({
          homeTeamId: item.homeTeamId,
          awayTeamId: item.awayTeamId,
          weekIndex: item.weekIndex,
          reason: item.reason,
        })),
    },
  };
}

/**
 * One stored baseline, as "Changes since publication" takes it, from what the store hook read
 * (`usePublicationBaselines().readBaseline`, the one place that reaches the publication seam and the table).
 *
 * The hook re-checks the stored rows against their digest on every read. A baseline whose rows no longer match their
 * digest is **not compared against**: the comparison would be against corrupted ground truth, and a game could read
 * as unchanged when it is not.
 *
 * @param {{ baseline: { baselineVersion: number, label: string, recordedAt: string | null },
 *   snapshot: { rows: ReadonlyArray<Record<string, string>> }, readFindings: ReadonlyArray<{ code: string }> }} read
 * @returns {{ ok: true, baseline: { rows: Array<Record<string, string>>, recordedAt: string, version: number,
 *   label: string } } | { ok: false, table: string, message: string }}
 */
export function changesBaselineFrom({ baseline, snapshot, readFindings }) {
  const table = 'publication_baselines';
  if (
    readFindings.some((finding) => finding.code === PUBLICATION_REASON.SNAPSHOT_DIGEST_MISMATCH)
  ) {
    return failure(
      table,
      'the stored rows no longer match their digest, so the baseline failed its integrity check and is not compared against'
    );
  }
  if (!baseline.recordedAt) return failure(table, 'the baseline has no time it was recorded');
  return {
    ok: true,
    baseline: {
      rows: snapshot.rows.map((entry) => ({ ...entry })),
      recordedAt: String(baseline.recordedAt),
      version: Number(baseline.baselineVersion),
      label: String(baseline.label),
    },
  };
}

/**
 * The schedule audit rows (`get_schedule_audit_log`: the two Published actions, newest first, at most 500, admin only).
 *
 * @param {any} client
 * @param {{ organizationId: string }} params
 * @returns {Promise<{ ok: true, rows: Array<Record<string, any>>, limit: number } | { ok: false, table: string, message: string }>}
 */
export async function loadScheduleAuditRows(client, { organizationId }) {
  const table = 'get_schedule_audit_log';
  const result = await named(table, async () => {
    const { data, error } = await client.rpc(table, {
      p_organization_id: organizationId,
      p_assignment_id: null,
      p_limit: AUDIT_LIMIT,
    });
    if (error) throw error;
    if (!Array.isArray(data)) throw new Error('the audit log did not answer with a list');
    return data;
  });
  return result.ok === true ? { ok: true, rows: result.value, limit: AUDIT_LIMIT } : result;
}
