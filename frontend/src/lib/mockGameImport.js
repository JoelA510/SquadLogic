/**
 * The mock's games import (migration `20261121010000_game_import.sql`; plan
 * `docs/changes/2026-11-03-schedule-expansion.md` 4.5 to 4.7, PR 5, task E3): `map_game_import_job`,
 * `apply_game_import_job(job, dry_run)`, `rollback_game_import_job` and `ensure_game_slot`, refusals included
 * (LESSONS_LEARNED #13), with the SQL's error codes, and the result of the apply in the SQL's shape.
 *
 * **What the SQL does and this mirrors.**
 *   - the gates, in the SQL's order: no signed-in user and an admin of another organization are 42501, an unknown
 *     job P0002, a job of another type, a failed or rolled-back one, and a completed or non-active season 22023
 *     (`season_completed`, `season_not_active`); a finished job answers with the result it stored (`replayed: true`);
 *   - the staged rows are resolved through the job's mapping by core's `resolveScheduleRows`, the one function the
 *     browser's preview runs too (a twin made of the same function, lesson 77), and then judged as the SQL judges them:
 *     the first of two rows of one game is the one imported, a Game ID used by two games is `game-id-reused`, a TIME TBD
 *     game is one row per (home, away, week), and a place another game already holds is refused as a duplicate;
 *   - a game found by (season, Game ID) is changed IN PLACE by its id whether it is in the visible run or hidden, a row
 *     with a Game ID is never matched by its tuple, a row without one matches on (home, away, slot, week); a held game
 *     (`mockGameHeldIds`, the one predicate) whose row changed is `skipped-published`; new games arrive Published when
 *     the job says so; slots are found by (field, date, start) or made, only for a game that is written;
 *   - when anything is written ONE new game run is made holding the whole schedule (the previous run's games and the
 *     hidden games the file found are carried into it); when nothing would change, no run and no write;
 *   - team shells go into ONE team run for the apply, in the shape every reader of a team run reads
 *     (`carryTeamRunResults`: the latest run's results carried forward, the shells added to their divisions), outside
 *     clubs are team rows flagged `is_external` in no run; every created record has an application record;
 *   - `p_dry_run` computes the same result and writes nothing;
 *   - the rollback refuses (22023 `game_import_changed`, up to 50 games) when a game it wrote is gone, differs from the
 *     image the apply stored or is in a later run; otherwise it undoes the apply.
 *
 * **Not mirrored:** the advisory locks, the Published guard trigger and its exemption (the mock writes rows directly, and
 * the rollback's refusal is the pre-check), the audit failure rollback (SLA01), and the SQL's own conflict flags beyond
 * the two it judges (a field and a team in two games at once), which come from `evaluateGameSchedule`, the function
 * the SQL's two checks were written to equal. Pure over `db`; `mockSupabaseClient.js` saves it.
 */

import { evaluateGameSchedule } from '@squadlogic/core/gameMetrics.js';
import {
  SCHEDULE_IMPORT_CHUNK_LIMITS,
  SCHEDULE_IMPORT_LIMITS,
  SCHEDULE_IMPORT_RETIRED_ROW_REFUSALS,
  SCHEDULE_IMPORT_ROW_REFUSALS,
  diffScheduleImportConfirmCounts,
  isScheduleImportConfirmCounts,
  resolveScheduleRows,
  scheduleImportConfirmCounts,
  stageScheduleChunk,
  stagedRowToParsed,
} from '@squadlogic/core/scheduleImport/index.js';
import { carryTeamRunResults } from '@squadlogic/core/utils/teamRunResults.js';
import { sanitizeImportText } from '../utils/importRows.js';
import { mockGameHeldIds } from './mockGameIdentity.js';
import { mockGameHoldCode } from './mockGamePublished.js';

export const GAME_IMPORT_RPCS = Object.freeze([
  'map_game_import_job',
  'apply_game_import_job',
  'rollback_game_import_job',
  'ensure_game_slot',
]);

const LISTED = 200;
const LISTED_IDS = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const fail = (code, message, details) => ({
  data: null,
  error: { code, message, details: details ?? null, hint: null },
});
const byRow = (a, b) => (a.source_row_number ?? Infinity) - (b.source_row_number ?? Infinity);
const instantOf = (value) =>
  value === null || value === undefined ? null : new Date(value).toISOString();

/** The columns that say a game has not been changed since an import wrote it (the SQL's `game_import_image`). */
function imageOf(row) {
  const iso = (v) => (v === null || v === undefined ? null : new Date(v).toISOString());
  return JSON.stringify([
    row.game_slot_id ?? null,
    row.slot_id ?? null,
    row.field_id ?? null,
    row.home_team_id ?? null,
    row.away_team_id ?? null,
    row.week_index ?? null,
    iso(row.start),
    iso(row.end),
    Boolean(row.published),
    row.division ?? null,
    row.external_ref ?? null,
  ]);
}

/** A value as jsonb compares it: keys in any order, undefined as null. */
function canon(value) {
  if (value === undefined || value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map(canon).join(',')}]`;
  if (typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canon(value[k])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

/**
 * The SQL's `game_import_row_unchanged`: every column the apply recorded still holds the recorded value (created_at and
 * updated_at aside), and an empty image matches nothing. The SQL reads the keys of the STORED image, which carries every
 * column of the table (a column added later does not make an old job's rows look changed); a mock row carries only the
 * columns something set, so a column that was never set is a null, and both rows' keys are read here.
 */
function rowUnchanged(now, applied) {
  if (!now || !applied || typeof applied !== 'object' || Object.keys(applied).length === 0)
    return false;
  const keys = new Set([...Object.keys(applied), ...Object.keys(now)]);
  for (const key of ['created_at', 'updated_at']) keys.delete(key);
  return [...keys].every((key) => canon(now[key]) === canon(applied[key]));
}

const jobSeason = (db, job) =>
  (db.season_settings || []).find(
    (s) => same(s.id, job.season_settings_id) && same(s.organization_id, job.organization_id)
  );

/** The shared gates of the four job RPCs. */
function jobGates(db, jobId, ctx, { needsAdmin = true } = {}) {
  if (!ctx.currentUserId) return fail('42501', 'a signed-in caller is required');
  if (!jobId) return fail('22023', 'p_import_job_id is required');
  const job = (db.import_jobs || []).find((item) => same(item.id, jobId));
  if (!job) return fail('P0002', `Import job ${jobId} not found`);
  if (needsAdmin && !ctx.isOrgAdmin(job.organization_id)) {
    return fail(
      '42501',
      `Access denied: user is not an admin of organization ${job.organization_id}`
    );
  }
  if (job.job_type !== 'games')
    return fail('22023', `Import job ${jobId} is ${job.job_type}, not games`);
  return { job };
}

/**
 * @param {any} db
 * @param {string} name
 * @param {Record<string, any>} params
 * @param {{ isOrgAdmin: (organizationId: string) => boolean, currentUserId: string | null,
 *   newId?: () => string, now?: () => string }} ctx
 * @returns {any} `{ data, error }`, or null when `name` is not one of these RPCs
 */
export function handleGameImportRpc(db, name, params, ctx) {
  if (!GAME_IMPORT_RPCS.includes(name)) return null;
  const newId = ctx.newId ?? (() => globalThis.crypto.randomUUID());
  const now = ctx.now ?? (() => new Date().toISOString());
  const env = { newId, now };
  if (name === 'ensure_game_slot') return ensureGameSlot(db, params, ctx, env);
  const gated = jobGates(db, params?.p_import_job_id, ctx);
  if (gated.error) return gated;
  if (name === 'map_game_import_job') return mapJob(db, gated.job, params?.p_mapping, ctx, env);
  if (name === 'rollback_game_import_job') return rollbackJob(db, gated.job, ctx, env);
  return applyJob(db, gated.job, params?.p_dry_run === true, ctx, env);
}

// --------------------------------------------------------------------------------------------- ensure_game_slot

function ensureGameSlot(db, params, ctx, env) {
  if (!ctx.currentUserId)
    return fail('42501', 'ensure_game_slot needs a signed-in caller to audit the slot');
  const org = params?.p_organization_id;
  if (!org || !ctx.isOrgAdmin(org)) {
    return fail(
      '42501',
      'Access denied: only an administrator of the organization makes a game slot'
    );
  }
  const { p_field_id: fieldId, p_slot_date: date, p_start_time: start, p_end_time: end } = params;
  const week = params?.p_week_index;
  if (!fieldId || !date || !start || !end || week === null || week === undefined) {
    return fail('23502', 'a field, a date, a start and an end time and a week are required');
  }
  if (String(end) <= String(start)) return fail('22023', 'a slot ends after it starts');
  if (week < 1 || week > 255) return fail('22023', 'the week is from 1 to 255');
  if (!(db.fields || []).some((f) => same(f.id, fieldId) && same(f.organization_id, org))) {
    return fail('23503', `field ${fieldId} does not exist in this organization`);
  }
  const hhmm = (t) => String(t).slice(0, 5);
  const found = (db.game_slots || [])
    .filter(
      (s) =>
        same(s.organization_id, org) &&
        same(s.field_id, fieldId) &&
        String(s.slot_date) === String(date) &&
        hhmm(s.start_time) === hhmm(start)
    )
    .sort(
      (a, b) =>
        String(a.created_at).localeCompare(String(b.created_at)) ||
        String(a.id).localeCompare(String(b.id))
    )[0];
  if (found) return { data: { id: found.id, created: false }, error: null };
  const id = env.newId();
  db.game_slots = [
    ...(db.game_slots || []),
    {
      id,
      organization_id: org,
      field_id: fieldId,
      division_id: null,
      start: params.p_start ?? null,
      end: params.p_end ?? null,
      slot_date: date,
      start_time: start,
      end_time: end,
      week_index: week,
      capacity: 1,
      created_at: env.now(),
      updated_at: env.now(),
    },
  ];
  (db.audit_log = db.audit_log || []).push({
    id: env.newId(),
    organization_id: org,
    user_id: ctx.currentUserId,
    action: 'game.slot_created',
    resource_type: 'game_slot',
    resource_id: id,
    metadata: {
      field_id: fieldId,
      slot_date: date,
      start_time: start,
      end_time: end,
      week_index: week,
    },
    created_at: env.now(),
  });
  return { data: { id, created: true }, error: null };
}

// --------------------------------------------------------------------------------------------- map_game_import_job

/** What a row refused because another game stands on its place is told (the SQL's words; a test holds the two equal). */
/** The SQL's sentence for a flag a staged row carried (section 7 of the apply). @param {string} code */
const FLAG_MESSAGE = (code) =>
  code === 'time-ambiguous'
    ? 'The clocks repeat this time on its date; the first occurrence was taken.'
    : code === 'bad-time'
      ? 'The time could not be read: the game is a TIME TBD game on its date.'
      : code === 'bad-week'
        ? 'The Week could not be read or stored: the week was taken from the date.'
        : 'The week is not the week the date falls in.';

export const COLLISION_MESSAGE =
  "A game this file does not move already stands on this place, and this row's Game ID (or the lack of one) does not name it. Nothing is written for the row.";

/** What a row refused because another TIME TBD game holds its (home, away, week) is told (the SQL's words). */
export const TBD_CONFLICT_MESSAGE =
  "Another TIME TBD game already holds this home team, away team and week, and this row's Game ID (or the lack of one) does not name it. Nothing is written for the row.";

/** What a row refused because another row of the file names the same saved record is told (the SQL's words). */
export const DUPLICATE_TARGET_MESSAGE =
  'Another row of this file names the same saved game as this row (one by its Game ID, one by its teams, place and week), and one saved game cannot be written twice. The other row is the one imported; nothing is written for this row.';

const UUID_TEXT = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

const ACTIONS = {
  divisions: ['map', 'create', 'skip'],
  venues: ['map', 'create', 'skip'],
  fields: ['map', 'create', 'skip'],
  teams: ['map', 'create', 'outside', 'skip'],
};

function mapJob(db, job, mapping, ctx, env) {
  if (!['importing', 'ready_to_apply'].includes(job.status)) {
    return fail(
      '22023',
      `Import job ${job.id} is ${job.status}: its mapping can no longer be changed`
    );
  }
  const season = jobSeason(db, job);
  if (!season)
    return fail('22023', `Import job ${job.id} has no season to import into`, 'season_missing');
  if (season.status === 'completed')
    return fail(
      '22023',
      `Season ${season.id} is completed and takes no import`,
      'season_completed'
    );
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping))
    return fail('22023', 'the mapping must be an object');
  const allowed = new Set([...Object.keys(ACTIONS), 'options']);
  if (Object.keys(mapping).some((k) => !allowed.has(k))) {
    return fail(
      '22023',
      'the mapping holds options, divisions, venues, fields and teams and nothing else'
    );
  }
  let arrive = true;
  if ('options' in mapping) {
    const o = mapping.options;
    if (
      !o ||
      typeof o !== 'object' ||
      Array.isArray(o) ||
      Object.keys(o).some((k) => k !== 'arrive_published') ||
      ('arrive_published' in o && typeof o.arrive_published !== 'boolean')
    ) {
      return fail('22023', 'the options are { arrive_published: true or false }');
    }
    arrive = o.arrive_published ?? true;
  }
  const clean = {};
  const counts = {};
  const decisions = {};
  for (const group of Object.keys(ACTIONS)) {
    const entries = mapping[group];
    clean[group] = {};
    if (entries !== undefined) {
      if (!entries || typeof entries !== 'object' || Array.isArray(entries))
        return fail('22023', `the ${group} of the mapping must be an object`);
      for (const [key, d] of Object.entries(entries).sort(([a], [b]) => (a < b ? -1 : 1))) {
        if (!key || key.length > 500)
          return fail('22023', `a decision key of ${group} is empty or over 500 characters`);
        if (!d || typeof d !== 'object' || Array.isArray(d))
          return fail('22023', `a decision of ${group} must be an object`);
        if (!ACTIONS[group].includes(d.action)) {
          return fail(
            '22023',
            `a decision of ${group} is not one of its actions (${ACTIONS[group].join(', ')})`
          );
        }
        const name = typeof d.name === 'string' ? d.name.trim() : null;
        if (
          d.name !== undefined &&
          d.name !== null &&
          (typeof d.name !== 'string' || (name ?? '').length > 200)
        ) {
          return fail('22023', 'a name of a created record is text of at most 200 characters');
        }
        if (d.action === 'map') {
          if (typeof d.id !== 'string' || !UUID.test(d.id))
            return fail('22023', `a map decision of ${group} names a record by its id`);
          const org = job.organization_id;
          const known = {
            divisions: () =>
              (db.divisions || []).some(
                (r) =>
                  same(r.id, d.id) &&
                  same(r.organization_id, org) &&
                  same(r.season_settings_id, job.season_settings_id)
              ),
            venues: () =>
              (db.locations || []).some((r) => same(r.id, d.id) && same(r.organization_id, org)),
            fields: () =>
              (db.fields || []).some((r) => same(r.id, d.id) && same(r.organization_id, org)),
            teams: () =>
              (db.teams || []).some(
                (t) =>
                  same(t.id, d.id) &&
                  same(t.organization_id, org) &&
                  (db.divisions || []).some(
                    (dv) =>
                      same(dv.id, t.division_id) &&
                      same(dv.season_settings_id, job.season_settings_id)
                  )
              ),
          }[group]();
          if (!known)
            return fail(
              '22023',
              `the ${group.slice(0, -1)} ${d.id} is not a record of this organization and season`
            );
          clean[group][key] = { action: 'map', id: d.id };
        } else {
          clean[group][key] = {
            action: d.action,
            ...(name && ['create', 'outside'].includes(d.action) ? { name } : {}),
          };
        }
      }
    }
    counts[group] = Object.keys(clean[group]).length;
    decisions[group] = {};
    for (const d of Object.values(clean[group]))
      decisions[group][d.action] = (decisions[group][d.action] ?? 0) + 1;
  }
  clean.options = { arrive_published: arrive };
  job.warning_summary = { ...(job.warning_summary || {}), game_mapping: clean };
  // The mapping is the sole input of the apply, so storing it is audited: the number of decisions per group and action and
  // the Published default, never a label of the file (the SQL's `import.mapped`).
  (db.audit_log = db.audit_log || []).push({
    id: env.newId(),
    organization_id: job.organization_id,
    user_id: ctx.currentUserId,
    action: 'import.mapped',
    resource_type: 'import_job',
    resource_id: job.id,
    metadata: { import_type: 'games', arrive_published: arrive, decisions },
    created_at: env.now(),
  });
  return { data: { job_id: job.id, arrive_published: arrive, ...counts }, error: null };
}

// ------------------------------------------------------------------------------------------------- the apply

/** A staged row as core's `resolveScheduleRows` takes a parsed one (core's own reading of a staged row). */
const parsedOf = stagedRowToParsed;

function leagueOf(db, job) {
  const divisions = (db.divisions || []).filter(
    (d) =>
      same(d.organization_id, job.organization_id) &&
      same(d.season_settings_id, job.season_settings_id)
  );
  const ids = new Set(divisions.map((d) => String(d.id).toLowerCase()));
  return {
    divisions: divisions.map((d) => ({ id: d.id, name: d.name })),
    teams: (db.teams || [])
      .filter((t) => ids.has(String(t.division_id).toLowerCase()))
      .map((t) => ({
        id: t.id,
        name: t.name,
        divisionId: t.division_id,
        isExternal: t.is_external === true,
      })),
    venues: (db.locations || [])
      .filter((l) => same(l.organization_id, job.organization_id))
      .map((l) => ({ id: l.id, name: l.name })),
    fields: (db.fields || [])
      .filter((f) => same(f.organization_id, job.organization_id))
      .map((f) => ({ id: f.id, venueId: f.location_id, name: f.name })),
  };
}

const latestGameRun = (db, org, season) =>
  (db.scheduler_runs || [])
    .filter(
      (r) =>
        same(r.organization_id, org) &&
        r.run_type === 'game' &&
        r.status === 'completed' &&
        (same(r.season_settings_id, season) || same(r.season_id, season))
    )
    .sort(
      (a, b) =>
        String(b.completed_at ?? '').localeCompare(String(a.completed_at ?? '')) ||
        String(b.created_at ?? '').localeCompare(String(a.created_at ?? ''))
    )[0];

function applyJob(db, job, dry, ctx, env) {
  if (job.status === 'completed' || job.status === 'completed_with_warnings') {
    const stored = job.warning_summary?.game_import;
    if (stored) return { data: { ...stored, replayed: true }, error: null };
    return fail('22023', `Import job ${job.id} is already ${job.status}`);
  }
  if (job.status === 'failed' || job.status === 'needs_fix') {
    return fail(
      '22023',
      `${job.status === 'failed' ? 'Failed' : 'Needs_fix'} import job ${job.id} cannot be applied: a new file is a new job`
    );
  }
  const season = jobSeason(db, job);
  if (!season)
    return fail('22023', `Import job ${job.id} has no season to import into`, 'season_missing');
  if (season.status === 'completed')
    return fail(
      '22023',
      `Season ${season.id} is completed and takes no import`,
      'season_completed'
    );
  if (season.status !== 'active')
    return fail(
      '22023',
      `Season ${season.id} is ${season.status} and takes no games import: only the active season does`,
      'season_not_active'
    );
  const mapping = job.warning_summary?.game_mapping;
  if (!mapping)
    return fail(
      '22023',
      `Import job ${job.id} has no mapping: confirm what each label of the file is first`,
      'mapping_required'
    );
  const arrive = mapping.options?.arrive_published !== false;
  const org = job.organization_id;
  const seasonId = job.season_settings_id;

  const staged = (db.staging_import_rows || [])
    .filter(
      (r) =>
        same(r.import_job_id, job.id) && same(r.organization_id, org) && r.import_type === 'games'
    )
    .sort(byRow);
  if (staged.length === 0)
    return fail('22023', `Import job ${job.id} has no staged games rows`, 'no_rows');
  for (const s of staged) {
    const code = (s.validation_errors || [])[0]?.code;
    // As the SQL's `c_row_refusals`: the closed list, and the two codes that refused a row until PR 6 (task F5).
    if (
      (s.validation_errors || []).length > 0 &&
      !SCHEDULE_IMPORT_ROW_REFUSALS.includes(code) &&
      !SCHEDULE_IMPORT_RETIRED_ROW_REFUSALS.includes(code)
    ) {
      return fail(
        '22023',
        `staged row ${s.source_row_number} is refused for a reason this import does not know`,
        'game_import_staged_invalid'
      );
    }
  }

  const league = leagueOf(db, job);
  // As the SQL: only the decisions STORED on the job are in effect. A label with a single match and no stored decision
  // is unknown to the database (it guesses nothing), so core's own proposal must not stand in for one here.
  const resolved = resolveScheduleRows({
    rows: staged.map(parsedOf),
    league,
    decisions: mapping,
    explicitOnly: true,
  });
  const rows = resolved.rows.map((r, i) => ({
    ...r,
    staged: staged[i],
    outcome: r.status === 'ok' || r.status === 'tbd' ? 'ok' : r.status,
  }));

  // An outside club whose name a team created here already takes is refused as the own team it would collide with
  // (UNIQUE (division_id, name) holds for both): the SQL's `own-name`, which core's pure resolution does not know.
  const shellNames = new Set(
    resolved.creations.teamShells.map((c) => JSON.stringify([c.divisionId, c.key]))
  );
  const collidingClubs = new Set(
    resolved.creations.outsideTeams
      .filter((c) => shellNames.has(JSON.stringify([c.divisionId, c.key])))
      .map((c) => c.id)
  );
  for (const r of rows) {
    if (
      r.outcome === 'ok' &&
      (collidingClubs.has(r.ids?.home) || collidingClubs.has(r.ids?.away))
    ) {
      r.outcome = 'refused';
      r.status = 'refused';
      r.reason = 'label-is-own-team';
      r.message =
        'A label was marked as an outside club, but the division has a team of that name: map it to that team instead.';
    }
  }

  // The same game twice by the admin's own mapping, a TIME TBD game that the table holds once per (home, away, week),
  // and one Game ID on two games: the first row of each wins.
  const seenTbd = new Set();
  const seenGid = new Set();
  for (const r of rows) {
    if (r.outcome !== 'ok') continue;
    if (r.status === 'tbd') {
      const key = JSON.stringify([r.ids.home, r.ids.away, r.weekIndex]);
      if (seenTbd.has(key)) {
        r.outcome = 'refused';
        r.status = 'refused';
        r.reason = 'duplicate-row';
        continue;
      }
      seenTbd.add(key);
    }
    if (r.gameId) {
      if (seenGid.has(r.gameId)) {
        r.outcome = 'refused';
        r.status = 'refused';
        r.reason = 'game-id-reused';
        continue;
      }
      seenGid.add(r.gameId);
    }
  }

  const divisionName = (id) =>
    String(id).startsWith('new:') ? null : league.divisions.find((d) => same(d.id, id))?.name;
  const createdDivision = new Map(resolved.creations.divisions.map((c) => [c.id, c]));
  const nameOfDivision = (id) => divisionName(id) ?? createdDivision.get(id)?.name ?? '';
  const slots = (db.game_slots || []).filter((s) => same(s.organization_id, org));
  const slotAt = (fieldId, date, start) =>
    slots
      .filter(
        (s) =>
          same(s.field_id, fieldId) &&
          String(s.slot_date) === String(date) &&
          String(s.start_time).slice(0, 5) === start
      )
      .sort(
        (a, b) =>
          String(a.created_at).localeCompare(String(b.created_at)) ||
          String(a.id).localeCompare(String(b.id))
      )[0];
  const games = (db.game_assignments || []).filter((g) => same(g.organization_id, org));

  // Placed games: the slot, the match, the verdict.
  const heldIds = new Set();
  /** @type {Array<any>} */
  const placed = rows
    .filter((r) => r.outcome === 'ok' && r.status === 'ok')
    .map((r) => {
      const slot = slotAt(r.ids.field, r.date, r.startTime);
      const match = r.gameId
        ? games.find((g) => same(g.season_settings_id, seasonId) && g.external_ref === r.gameId)
        : slot &&
          games.find(
            (g) =>
              same(g.home_team_id, r.ids.home) &&
              same(g.away_team_id, r.ids.away) &&
              same(g.game_slot_id, slot.id) &&
              Number(g.week_index) === r.weekIndex
          );
      const mslot = match && slots.find((s) => same(s.id, match.game_slot_id));
      const sameContent =
        Boolean(match) &&
        same(match.field_id ?? '', r.ids.field) &&
        same(match.home_team_id, r.ids.home) &&
        same(match.away_team_id, r.ids.away) &&
        Number(match.week_index) === r.weekIndex &&
        instantOf(match.start) === instantOf(r.start) &&
        instantOf(match.end) === instantOf(r.end) &&
        (match.division ?? null) === nameOfDivision(r.ids.division) &&
        Boolean(mslot) &&
        String(mslot.slot_date) === String(r.date) &&
        String(mslot.start_time).slice(0, 5) === r.startTime;
      // The game this row names stands on a place that is not the one the row puts it on: if the row is written, it
      // LEAVES its place.
      const leaves =
        Boolean(match) &&
        !(
          same(match.home_team_id, r.ids.home) &&
          same(match.away_team_id, r.ids.away) &&
          Boolean(slot) &&
          same(match.game_slot_id ?? '', slot.id) &&
          Number(match.week_index) === r.weekIndex
        );
      return { r, slot, match, sameContent, leaves, swappedWith: null };
    });
  // TIME TBD games: a date and no time. A row is found by (season, Game ID) FIRST (the table's `external_ref`); a row with
  // no Game ID, and a row whose Game ID no TIME TBD game carries yet but whose (home, away, week) one does that has no Game
  // ID of its own, is found by the tuple, as the placed games are. `conflict` is another TIME TBD game that already holds
  // the tuple the row would stand on (the table is unique on it); `ga` is the placed game the row's Game ID names (the file
  // now says it has no time).
  const tbdTable = (db.schedule_tbd || []).filter(
    (s) => s.kind === 'game' && same(s.organization_id, org) && same(s.season_settings_id, seasonId)
  );
  const tupleHeld = (s, home, away, week) =>
    same(s.home_team_id, home) && same(s.away_team_id, away) && Number(s.week_index) === week;
  const findTbd = (gameId, home, away, week) => {
    const byRef = gameId ? tbdTable.find((s) => s.external_ref === gameId) : undefined;
    if (byRef) return byRef;
    return tbdTable
      .filter((s) => tupleHeld(s, home, away, week) && (!gameId || s.external_ref == null))
      .sort((a, b) => String(a.id).localeCompare(String(b.id)))[0];
  };
  /** @type {Array<any>} */
  const tbd = rows
    .filter((r) => r.outcome === 'ok' && r.status === 'tbd')
    .map((r) => {
      const m = findTbd(r.gameId, r.ids.home, r.ids.away, r.weekIndex);
      return {
        r,
        m,
        conflict: tbdTable.some(
          (s) => !(m && same(s.id, m.id)) && tupleHeld(s, r.ids.home, r.ids.away, r.weekIndex)
        ),
        ga: r.gameId
          ? games.find((g) => same(g.season_settings_id, seasonId) && g.external_ref === r.gameId)
          : undefined,
        newId: env.newId(),
      };
    });

  // The one predicate: a game is held where it is. The games a row names, a placed one or one a TIME TBD row would take out.
  for (const id of mockGameHeldIds(db, [
    ...placed.filter((p) => p.match).map((p) => p.match.id),
    ...tbd.filter((t) => t.ga).map((t) => t.ga.id),
  ]))
    heldIds.add(String(id).toLowerCase());
  const isHeld = (g) => heldIds.has(String(g.id).toLowerCase());
  for (const p of placed) {
    p.verdict = !p.match
      ? 'insert'
      : p.sameContent
        ? 'unchanged'
        : isHeld(p.match)
          ? 'skip-held'
          : 'update';
  }
  // The TIME TBD rows' verdicts: a held placed game of the Game ID is not taken out (the row is skipped, as a held game's
  // row that changed is), another TIME TBD game on the tuple refuses the row.
  for (const t of tbd) {
    const m = t.m;
    t.verdict =
      t.ga && isHeld(t.ga)
        ? 'skip-held'
        : t.conflict
          ? 'conflict'
          : !m
            ? 'insert'
            : (m.game_date ?? null) === t.r.date &&
                Number(m.week_index) === t.r.weekIndex &&
                same(m.division_id, t.r.ids.division) &&
                same(m.home_team_id, t.r.ids.home) &&
                same(m.away_team_id, t.r.ids.away) &&
                (t.r.gameId == null || (m.external_ref ?? null) === t.r.gameId) &&
                m.reason === 'imported-without-time'
              ? 'unchanged'
              : 'update';
    t.conv = Boolean(t.ga) && !['skip-held', 'conflict'].includes(t.verdict);
    if (t.verdict === 'conflict') {
      t.r.outcome = 'refused';
      t.r.status = 'refused';
      t.r.reason = 'duplicate-row';
      t.r.message = TBD_CONFLICT_MESSAGE;
    }
  }
  // Two rows of the file that resolve to ONE saved record (a saved game: a placed row's match or the game a TIME TBD
  // row's Game ID names; a saved TIME TBD game: a TIME TBD row's match). One record cannot be written twice, so the row
  // that carries the Game ID is kept (then the earlier row) and every other row that names it is refused `duplicate-row`.
  {
    const claims = [
      ...placed
        .filter((p) => p.match)
        .map((p) => ({ key: `game:${p.match.id}`, byId: Boolean(p.r.gameId), item: p, src: 'g' })),
      ...tbd
        .filter((t) => t.ga && t.verdict !== 'conflict')
        .map((t) => ({ key: `game:${t.ga.id}`, byId: true, item: t, src: 't' })),
      ...tbd
        .filter((t) => t.m && t.verdict !== 'conflict')
        .map((t) => ({
          key: `tbd:${t.m.id}`,
          byId: Boolean(t.r.gameId) && (t.m.external_ref ?? null) === t.r.gameId,
          item: t,
          src: 't',
        })),
    ];
    const byKey = new Map();
    for (const c of claims) byKey.set(c.key, [...(byKey.get(c.key) || []), c]);
    for (const list of byKey.values()) {
      list.sort(
        (a, b) => Number(b.byId) - Number(a.byId) || a.item.r.rowNumber - b.item.r.rowNumber
      );
      for (const loser of list.slice(1)) {
        loser.item.verdict = loser.src === 'g' ? 'collision' : 'conflict';
        loser.item.dupTarget = true;
        if (loser.src === 't') {
          loser.item.conv = false;
          Object.assign(loser.item.r, {
            outcome: 'refused',
            status: 'refused',
            reason: 'duplicate-row',
            message: DUPLICATE_TARGET_MESSAGE,
          });
        }
      }
    }
  }
  // A place another game already stands on refuses the row (the same word as a duplicate), UNLESS the game standing there
  // is one the file itself moves away: then the row is written after that game has left, and it is a warning
  // (`games-swapped`). A game that moves is judged against the games the file does NOT move, so a row that cannot be
  // written is not counted among the movers and the rows that depended on it are judged again, until none changes.
  const placeHolder = (p, movers) =>
    p.slot
      ? games.find(
          (g) =>
            same(g.home_team_id, p.r.ids.home) &&
            same(g.away_team_id, p.r.ids.away) &&
            same(g.game_slot_id ?? '', p.slot.id) &&
            Number(g.week_index) === p.r.weekIndex &&
            !(p.match && same(g.id, p.match.id)) &&
            !movers.has(String(g.id))
        )
      : undefined;
  // The games that leave their places: a game a row moves, and a placed game the file now gives no time (taken out).
  const moversOf = () =>
    new Set([
      ...placed.filter((p) => p.verdict === 'update' && p.leaves).map((p) => String(p.match.id)),
      ...tbd.filter((t) => t.conv).map((t) => String(t.ga.id)),
    ]);
  for (;;) {
    const movers = moversOf();
    let changed = false;
    for (const p of placed) {
      if ((p.verdict === 'insert' || p.verdict === 'update') && placeHolder(p, movers)) {
        p.verdict = 'collision';
        changed = true;
      }
    }
    if (!changed) break;
  }
  {
    const movers = moversOf();
    for (const p of placed.filter((x) => x.verdict === 'insert' || x.verdict === 'update')) {
      if (!p.slot) continue;
      p.swappedWith =
        games.find(
          (g) =>
            same(g.home_team_id, p.r.ids.home) &&
            same(g.away_team_id, p.r.ids.away) &&
            same(g.game_slot_id ?? '', p.slot.id) &&
            Number(g.week_index) === p.r.weekIndex &&
            !(p.match && same(g.id, p.match.id)) &&
            movers.has(String(g.id))
        )?.id ?? null;
    }
  }
  for (const p of placed.filter((x) => x.verdict === 'collision')) {
    p.r.outcome = 'refused';
    p.r.status = 'refused';
    p.r.reason = 'duplicate-row';
    p.r.message = p.dupTarget ? DUPLICATE_TARGET_MESSAGE : COLLISION_MESSAGE;
  }
  // A TIME TBD row the file now places: the game it names is written and the row goes.
  for (const p of placed.filter((x) => x.verdict === 'insert' || x.verdict === 'update')) {
    p.tbdRow = findTbd(p.r.gameId, p.r.ids.home, p.r.ids.away, p.r.weekIndex) ?? null;
  }
  // One TIME TBD game is placed by ONE row (the row that carries its Game ID, then the earlier row); another row that
  // would take it is simply a new game.
  {
    const writing = placed.filter((x) => x.verdict === 'insert' || x.verdict === 'update');
    const takers = new Map();
    for (const p of writing.filter((x) => x.tbdRow))
      takers.set(String(p.tbdRow.id), [...(takers.get(String(p.tbdRow.id)) || []), p]);
    for (const list of takers.values()) {
      list.sort(
        (a, b) =>
          Number(Boolean(b.r.gameId)) - Number(Boolean(a.r.gameId)) || a.r.rowNumber - b.r.rowNumber
      );
      for (const loser of list.slice(1)) loser.tbdRow = null;
    }
    // An identifier a matched record already carries is never erased by a row that omits it: a TIME TBD game with a Game
    // ID that a row with NO Game ID places becomes a placed game with that Game ID. Not when the TIME TBD row stays (a
    // TIME TBD row of the file writes it), nor when a game already has the Game ID.
    const tbdKept = new Set(
      tbd
        .filter((t) => t.m && ['insert', 'update', 'unchanged'].includes(t.verdict))
        .map((t) => String(t.m.id))
    );
    for (const p of writing) {
      const ref = p.tbdRow?.external_ref ?? null;
      p.carryRef =
        p.verdict === 'insert' &&
        !p.r.gameId &&
        ref &&
        !tbdKept.has(String(p.tbdRow.id)) &&
        !games.some((g) => same(g.season_settings_id, seasonId) && g.external_ref === ref) &&
        !writing.some((o) => o.verdict === 'insert' && o.r.gameId === ref)
          ? ref
          : null;
    }
    // The invariant of the plan: no saved record is named twice among the rows that are kept.
    const named = [
      ...placed
        .filter((x) => x.match && x.verdict !== 'collision')
        .map((x) => `game:${x.match.id}`),
      ...tbd.filter((t) => t.ga && t.verdict !== 'conflict').map((t) => `game:${t.ga.id}`),
      ...tbd.filter((t) => t.m && t.verdict !== 'conflict').map((t) => `tbd:${t.m.id}`),
      ...writing.filter((x) => x.tbdRow).map((x) => `placed-tbd:${x.tbdRow.id}`),
    ];
    if (new Set(named).size !== named.length)
      return fail('XX000', 'game import plan names one saved record in two rows');
  }

  const prevRun = latestGameRun(db, org, seasonId);
  const written = placed.filter((p) => p.verdict === 'insert' || p.verdict === 'update');
  const heldSkipTbd = tbd.filter((t) => t.verdict === 'skip-held');
  const hidden = [
    ...placed.filter(
      (p) =>
        ['unchanged', 'skip-held'].includes(p.verdict) &&
        (p.match.run_id ?? null) !== (prevRun?.id ?? null)
    ),
    // A held game a TIME TBD row names but that is not in the latest run becomes visible again too.
    ...heldSkipTbd.filter((t) => (t.ga.run_id ?? null) !== (prevRun?.id ?? null)),
  ];
  const inserts = written.filter((p) => p.verdict === 'insert');
  const updates = written.filter((p) => p.verdict === 'update');
  const tbdIns = tbd.filter((t) => t.verdict === 'insert');
  const tbdUpd = tbd.filter((t) => t.verdict === 'update');
  const tbdSame = tbd.filter((t) => t.verdict === 'unchanged');
  const tbdConflict = tbd.filter((t) => t.verdict === 'conflict');
  const converted = tbd.filter((t) => t.conv);
  // TIME TBD rows the file now places: one per row, however many placed rows name it, and not one the file also writes.
  const tbdRowsWritten = new Set(
    tbd
      .filter((t) => t.m && ['insert', 'update', 'unchanged'].includes(t.verdict))
      .map((t) => String(t.m.id))
  );
  const tbdRemoved = [
    ...new Map(
      written
        .filter((p) => p.tbdRow && !tbdRowsWritten.has(String(p.tbdRow.id)))
        .map((p) => [String(p.tbdRow.id), p.tbdRow])
    ).values(),
  ];
  const work =
    inserts.length +
    updates.length +
    tbdIns.length +
    tbdUpd.length +
    tbdRemoved.length +
    converted.length +
    hidden.length;
  const nothing = work === 0;
  const updatedIds = new Set(updates.map((p) => String(p.match.id)));
  const convertedIds = new Set(converted.map((t) => String(t.ga.id)));
  const matchedIds = new Set(
    placed.filter((p) => p.match && p.verdict !== 'collision').map((p) => String(p.match.id))
  );
  const carry = nothing
    ? []
    : games
        .filter(
          (g) =>
            (prevRun && same(g.run_id ?? '', prevRun.id)) ||
            placed.some(
              (p) =>
                p.match && same(p.match.id, g.id) && ['unchanged', 'skip-held'].includes(p.verdict)
            ) ||
            heldSkipTbd.some((t) => same(t.ga.id, g.id))
        )
        .filter((g) => !updatedIds.has(String(g.id)) && !convertedIds.has(String(g.id)));

  // New slots, one per place no slot stands on, among the games that are written.
  const newSlots = new Map();
  for (const p of written) {
    if (p.slot) {
      p.slotId = p.slot.id;
      continue;
    }
    const key = JSON.stringify([p.r.ids.field, p.r.date, p.r.startTime]);
    if (!newSlots.has(key))
      newSlots.set(key, {
        id: env.newId(),
        field_id: p.r.ids.field,
        slot_date: p.r.date,
        start_time: p.r.startTime,
        end_time: p.r.endTime,
        start: p.r.start,
        end: p.r.end,
        week_index: p.r.weekIndex,
      });
    p.slotId = newSlots.get(key).id;
  }
  const flagged = new Map(
    written.map((p) => [
      p,
      [
        ...p.r.flags.map((f) => f.code),
        ...(p.slot &&
        Number(p.slot.week_index) !== p.r.weekIndex &&
        !p.r.flags.some((f) => f.code === 'week-differs')
          ? ['week-differs']
          : []),
      ],
    ])
  );

  // What a written row uses decides what is created.
  const usedTeams = new Set([
    ...written.flatMap((p) => [p.r.ids.home, p.r.ids.away]),
    ...[...tbdIns, ...tbdUpd].flatMap((t) => [t.r.ids.home, t.r.ids.away]),
  ]);
  const usedFields = new Set(written.map((p) => p.r.ids.field));
  const usedDivisions = new Set([
    ...written.map((p) => p.r.ids.division),
    ...[...tbdIns, ...tbdUpd].map((t) => t.r.ids.division),
  ]);
  const cr = resolved.creations;
  const newDivisions = cr.divisions.filter((c) => usedDivisions.has(c.id));
  const newFields = cr.fields.filter((c) => usedFields.has(c.id));
  const newVenues = cr.venues.filter((c) => newFields.some((f) => f.venueId === c.id));
  const newShells = cr.teamShells.filter((c) => usedTeams.has(c.id));
  const newOutside = cr.outsideTeams.filter((c) => usedTeams.has(c.id));

  // Warnings: a field and a team in two games at once (the SQL's two checks), and the flags of written rows.
  const finalGames = nothing
    ? []
    : [
        ...carry.map((g) => ({
          id: g.id,
          slotId: g.game_slot_id,
          fieldId: g.field_id,
          start: g.start,
          end: g.end,
          home: g.home_team_id,
          away: g.away_team_id,
          week: g.week_index,
          division: g.division,
        })),
        ...written.map((p) => ({
          id: p.match?.id ?? `row:${p.r.rowKey}`,
          slotId: p.slotId,
          fieldId: p.r.ids.field,
          start: p.r.start,
          end: p.r.end,
          home: p.r.ids.home,
          away: p.r.ids.away,
          week: p.r.weekIndex,
          division: nameOfDivision(p.r.ids.division),
        })),
      ];
  const externalIds = new Set([
    ...league.teams.filter((t) => t.isExternal).map((t) => t.id),
    ...cr.outsideTeams.map((c) => c.id),
  ]);
  const report =
    finalGames.length === 0
      ? { warnings: [] }
      : evaluateGameSchedule({
          assignments: finalGames
            .filter((g) => g.start && g.end)
            .map((g) => ({
              id: g.id,
              slotId: String(g.id),
              weekIndex: Number(g.week),
              division: g.division ?? '',
              start: instantOf(g.start),
              end: instantOf(g.end),
              homeTeamId: String(g.home),
              awayTeamId: String(g.away),
              fieldId: g.fieldId ?? null,
            })),
          teams: [
            ...new Map(
              finalGames.flatMap((g) => [
                [String(g.home), g.division],
                [String(g.away), g.division],
              ])
            ).entries(),
          ].map(([id, division]) => ({ id, name: id, division: division || 'unassigned' })),
        });
  const warnings = [
    ...report.warnings.filter(
      (w) =>
        w.type === 'field-overlap' ||
        (w.type === 'team-double-booked' && !externalIds.has(w.details.teamId))
    ),
    ...[...flagged.entries()].flatMap(([p, codes]) =>
      codes.map((code) => ({
        type: code,
        message: FLAG_MESSAGE(code),
        details: { rowKey: p.r.rowKey, gameId: p.r.gameId ?? null, date: p.r.date },
        rowNumber: p.r.rowNumber,
      }))
    ),
    // A TIME TBD game's week is judged against its date as a placed game's is: the file's week is kept, and said.
    ...[...tbdIns, ...tbdUpd].flatMap((t) =>
      t.r.flags.map((f) => ({
        type: f.code,
        message: FLAG_MESSAGE(f.code),
        details: { rowKey: t.r.rowKey, gameId: t.r.gameId ?? null, date: t.r.date },
        rowNumber: t.r.rowNumber,
      }))
    ),
    // A game moved onto the place of a game this same file moves away (a swap, or a chain of moves): written, in an order
    // the unique place allows, and said.
    ...written
      .filter((p) => p.swappedWith)
      .map((p) => ({
        type: 'games-swapped',
        message: 'This game takes the place of a game the file moves away: both are written.',
        details: { rowKey: p.r.rowKey, gameId: p.r.gameId, takesPlaceOf: p.swappedWith },
        rowNumber: p.r.rowNumber,
      })),
    // A placed game the file now says has no time: taken out, and a dated TIME TBD game stands for it.
    ...converted.map((t) => ({
      type: 'game-made-time-tbd',
      message:
        'The file gives this game a date and no time: it is no longer placed, and stands on the TIME TBD list.',
      details: { rowKey: t.r.rowKey, gameId: t.r.gameId, game: t.ga.id, date: t.r.date },
      rowNumber: t.r.rowNumber,
    })),
  ];
  const orderOf = {
    'field-overlap': 1,
    'team-double-booked': 2,
    'time-ambiguous': 3,
    'week-differs': 4,
    'games-swapped': 5,
    'game-made-time-tbd': 6,
  };
  warnings.sort(
    (a, b) => orderOf[a.type] - orderOf[b.type] || (a.rowNumber ?? 0) - (b.rowNumber ?? 0)
  );

  const reasons = {};
  const refusedRows = rows.filter((r) => r.outcome === 'refused');
  for (const r of refusedRows) reasons[r.reason] = (reasons[r.reason] ?? 0) + 1;
  const skippedRows = rows.filter((r) => r.outcome === 'skipped');
  // The held games a row would have changed or taken out: a placed row that moves one, a TIME TBD row for one.
  // 20261122010000: a held game that is not Published is held by its score (the database's game_hold_code).
  const skipReasonOf = (game) =>
    mockGameHoldCode(game, db) === 'game_scored' ? 'skipped-scored' : 'skipped-published';
  const heldSkips = [
    ...placed
      .filter((p) => p.verdict === 'skip-held')
      .map((p) => ({
        rowNumber: p.r.rowNumber,
        rowKey: p.r.rowKey,
        gameId: p.r.gameId,
        game: p.match.id,
        reason: skipReasonOf(p.match),
      })),
    ...heldSkipTbd.map((t) => ({
      rowNumber: t.r.rowNumber,
      rowKey: t.r.rowKey,
      gameId: t.r.gameId,
      game: t.ga.id,
      reason: skipReasonOf(t.ga),
    })),
  ].sort((a, b) => a.rowNumber - b.rowNumber);
  const result = {
    dry_run: dry,
    job_id: job.id,
    season_settings_id: seasonId,
    arrive_published: arrive,
    rows: {
      staged: staged.length,
      refused: refusedRows.length,
      skipped: skippedRows.length,
      games: placed.filter((p) => p.verdict !== 'collision').length,
      time_tbd: tbd.length - tbdConflict.length,
    },
    refused_by_reason: reasons,
    games: {
      inserted: inserts.length,
      updated: updates.length,
      unchanged: placed.filter((p) => p.verdict === 'unchanged').length,
      repointed: carry.length,
      skipped: Object.fromEntries(
        ['skipped-published', 'skipped-scored']
          .map((reason) => ({ reason, count: heldSkips.filter((h) => h.reason === reason).length }))
          .filter(({ count }) => count > 0)
          .map(({ reason, count }) => [reason, count])
      ),
    },
    time_tbd: {
      inserted: tbdIns.length,
      updated: tbdUpd.length,
      unchanged: tbdSame.length,
      removed: tbdRemoved.length,
      converted: converted.length,
    },
    created: {
      divisions: newDivisions.length,
      venues: newVenues.length,
      fields: newFields.length,
      teams: newShells.length,
      outside_teams: newOutside.length,
      slots: newSlots.size,
    },
    reused: {
      slots: new Set(
        placed
          .filter((p) => ['insert', 'update', 'unchanged'].includes(p.verdict) && p.slot)
          .map((p) => String(p.slot.id))
      ).size,
    },
    not_in_file: (() => {
      const ids = prevRun
        ? games
            .filter(
              (g) =>
                same(g.run_id ?? '', prevRun.id) &&
                !matchedIds.has(String(g.id)) &&
                !tbd.some((t) => t.ga && same(t.ga.id, g.id))
            )
            .map((g) => g.id)
            .sort()
        : [];
      return { count: ids.length, ids: ids.slice(0, LISTED_IDS) };
    })(),
    nothing_to_apply: nothing,
    warnings: nothing
      ? []
      : warnings.map((w) => ({ type: w.type, message: w.message ?? w.type, details: w.details })),
    not_judged: ['coach-conflict', 'home-away-imbalance'],
    listed: {
      refused: refusedRows.slice(0, LISTED).map((r) => ({
        row_number: r.rowNumber,
        row_key: r.rowKey ?? null,
        reason: r.reason,
        message: r.message ?? '',
      })),
      skipped: skippedRows.slice(0, LISTED).map((r) => ({
        row_number: r.rowNumber,
        row_key: r.rowKey ?? null,
        kind: r.skippedBecause?.kind ?? null,
        label: r.skippedBecause?.label ?? null,
      })),
      skipped_games: heldSkips.slice(0, LISTED).map((h) => ({
        row_number: h.rowNumber,
        row_key: h.rowKey,
        game_id: h.gameId,
        game: h.game,
        reason: h.reason,
      })),
    },
    ids: { run_id: null, team_run_ids: [] },
  };
  if (dry) return { data: result, error: null };

  // ---------------------------------------------------------------------------------------- the writes
  const stamp = env.now();
  const records = (db.import_application_records = db.import_application_records || []);
  const record = (table, id, operation, previous, applied) =>
    records.push({
      id: env.newId(),
      organization_id: org,
      import_job_id: job.id,
      import_type: 'games',
      target_table: table,
      target_id: id,
      operation,
      previous_payload: previous,
      applied_payload: applied,
      applied_at: stamp,
      applied_by: ctx.currentUserId,
      rolled_back_at: null,
    });
  const idOf = new Map();
  const real = (id) => (String(id).startsWith('new:') ? idOf.get(id) : id);
  let runId = null;
  const teamRunIds = [];
  const publishedIds = [];
  if (!nothing) {
    for (const c of newDivisions) {
      const row = {
        id: env.newId(),
        organization_id: org,
        season_settings_id: seasonId,
        name: c.name,
        created_at: stamp,
        updated_at: stamp,
      };
      idOf.set(c.id, row.id);
      (db.divisions = db.divisions || []).push(row);
      record('divisions', row.id, 'inserted', null, { ...row });
    }
    for (const c of newVenues) {
      const row = {
        id: env.newId(),
        organization_id: org,
        name: c.name,
        created_at: stamp,
        updated_at: stamp,
      };
      idOf.set(c.id, row.id);
      (db.locations = db.locations || []).push(row);
      record('locations', row.id, 'inserted', null, { ...row });
    }
    for (const c of newFields) {
      const row = {
        id: env.newId(),
        organization_id: org,
        location_id: real(c.venueId),
        name: c.name,
        created_at: stamp,
        updated_at: stamp,
      };
      idOf.set(c.id, row.id);
      (db.fields = db.fields || []).push(row);
      record('fields', row.id, 'inserted', null, { ...row });
    }
    // Shells: ONE team run for the whole apply, in the shape every reader of a team run reads (`carryTeamRunResults`): the
    // latest run's results carried forward whole, each division's shells added to the division. The pages read the latest
    // team run, so a run of only the new shells (or of one division) would make every other team look absent.
    const byDivision = new Map();
    for (const c of newShells)
      byDivision.set(c.divisionId, [...(byDivision.get(c.divisionId) ?? []), c]);
    const shellDivisions = [];
    for (const [placeholder, shells] of [...byDivision.entries()].sort(([a], [b]) =>
      String(a) < String(b) ? -1 : 1
    )) {
      const divisionId = real(placeholder);
      const rowsOf = shells.map((c) => ({
        id: env.newId(),
        organization_id: org,
        division_id: divisionId,
        name: c.name,
        is_external: false,
        created_at: stamp,
        updated_at: stamp,
      }));
      shells.forEach((c, i) => idOf.set(c.id, rowsOf[i].id));
      shellDivisions.push({
        id: divisionId,
        name: nameOfDivision(placeholder),
        teams: rowsOf.map((r) => ({ id: r.id, name: r.name })),
      });
      for (const r of rowsOf) {
        (db.teams = db.teams || []).push(r);
        record('teams', r.id, 'inserted', null, { ...r });
      }
    }
    if (shellDivisions.length > 0) {
      const prev = (db.scheduler_runs || [])
        .filter(
          (sr) =>
            same(sr.organization_id, org) &&
            sr.run_type === 'team' &&
            sr.status === 'completed' &&
            (same(sr.season_settings_id ?? '', seasonId) || same(sr.season_id ?? '', seasonId))
        )
        .sort(
          (a, b) =>
            String(b.created_at).localeCompare(String(a.created_at)) ||
            String(b.id).localeCompare(String(a.id))
        )[0];
      const shellIds = shellDivisions.flatMap((d) => d.teams.map((t) => t.id));
      const teamRun = {
        id: env.newId(),
        organization_id: org,
        season_id: seasonId,
        season_settings_id: seasonId,
        run_type: 'team',
        status: 'completed',
        parameters: {
          source: 'import',
          import_job_id: job.id,
          shell_ids: shellIds,
        },
        results: carryTeamRunResults({
          base: prev?.results ?? null,
          divisions: shellDivisions,
          ownTeams: (db.teams || []).filter(
            (t) => t.is_external !== true && !shellIds.some((id) => same(id, t.id))
          ),
        }),
        created_by: ctx.currentUserId,
        completed_at: stamp,
        created_at: stamp,
      };
      (db.scheduler_runs = db.scheduler_runs || []).push(teamRun);
      teamRunIds.push(teamRun.id);
    }
    for (const c of newOutside) {
      const row = {
        id: env.newId(),
        organization_id: org,
        division_id: real(c.divisionId),
        name: c.name,
        is_external: true,
        created_at: stamp,
        updated_at: stamp,
      };
      idOf.set(c.id, row.id);
      (db.teams = db.teams || []).push(row);
      record('teams', row.id, 'inserted', null, { ...row });
    }
    for (const s of newSlots.values()) {
      const row = {
        id: s.id,
        organization_id: org,
        field_id: real(s.field_id),
        division_id: null,
        start: s.start,
        end: s.end,
        slot_date: s.slot_date,
        start_time: s.start_time,
        end_time: s.end_time,
        week_index: s.week_index,
        capacity: 1,
        created_at: stamp,
        updated_at: stamp,
      };
      (db.game_slots = db.game_slots || []).push(row);
      record('game_slots', row.id, 'inserted', null, { ...row });
    }
    runId = env.newId();
    const before = new Map(
      games
        .filter((g) => carry.some((c) => same(c.id, g.id)) || updatedIds.has(String(g.id)))
        .map((g) => [g.id, { ...g }])
    );
    (db.scheduler_runs = db.scheduler_runs || []).push({
      id: runId,
      organization_id: org,
      season_id: seasonId,
      season_settings_id: seasonId,
      run_type: 'game',
      status: 'completed',
      parameters: {
        source: 'import',
        import_job_id: job.id,
        arrive_published: arrive,
        previous_run_id: prevRun?.id ?? null,
      },
      metrics: {},
      results: {
        summary: {
          totalAssignments: inserts.length + updates.length + carry.length,
          source: 'import',
        },
        warnings: result.warnings,
        unscheduled: [],
        not_judged: result.not_judged,
        import_job_id: job.id,
      },
      created_by: ctx.currentUserId,
      started_at: stamp,
      completed_at: stamp,
      created_at: stamp,
    });
    db.game_assignments = db.game_assignments || [];
    // The before-images of the TIME TBD rows the file changes or removes (a rollback puts them back).
    const tbdBefore = new Map(
      [...tbdUpd.map((t) => t.m), ...tbdRemoved].map((row) => [String(row.id), { ...row }])
    );
    // Placed games the file now says have no time are taken out (a dated TIME TBD game stands for each, below): only a game
    // that is not held is here (a held one was skipped), and its image is kept so a rollback can put it back.
    for (const t of converted) {
      record('game_assignments', t.ga.id, 'deleted', { ...t.ga }, {});
      db.game_assignments = db.game_assignments.filter((g) => !same(g.id, t.ga.id));
    }
    for (const p of inserts) {
      const row = {
        id: env.newId(),
        organization_id: org,
        season_settings_id: seasonId,
        run_id: runId,
        game_slot_id: p.slotId,
        slot_id: p.slotId,
        field_id: real(p.r.ids.field),
        home_team_id: real(p.r.ids.home),
        away_team_id: real(p.r.ids.away),
        division: nameOfDivision(p.r.ids.division),
        week_index: p.r.weekIndex,
        start: p.r.start,
        end: p.r.end,
        assignment_source: 'auto',
        external_ref: p.r.gameId ?? p.carryRef ?? null,
        import_job_id: job.id,
        published: arrive,
        published_at: arrive ? stamp : null,
        published_by: arrive ? ctx.currentUserId : null,
        created_at: stamp,
        updated_at: stamp,
      };
      db.game_assignments.push(row);
      record('game_assignments', row.id, 'inserted', null, { ...row });
      if (arrive) publishedIds.push(row.id);
    }
    for (const p of updates) {
      const row = db.game_assignments.find((g) => same(g.id, p.match.id));
      Object.assign(row, {
        game_slot_id: p.slotId,
        slot_id: p.slotId,
        field_id: real(p.r.ids.field),
        home_team_id: real(p.r.ids.home),
        away_team_id: real(p.r.ids.away),
        division: nameOfDivision(p.r.ids.division),
        week_index: p.r.weekIndex,
        start: p.r.start,
        end: p.r.end,
        run_id: runId,
        import_job_id: job.id,
        updated_at: stamp,
      });
    }
    for (const g of carry)
      Object.assign(
        db.game_assignments.find((x) => same(x.id, g.id)),
        { run_id: runId, updated_at: stamp }
      );
    for (const [id, img] of before)
      record('game_assignments', id, 'updated', img, {
        ...db.game_assignments.find((x) => same(x.id, id)),
      });
    // TIME TBD games: a DATE and no time (`game_date`), the Game ID in `external_ref`. A row the file names is changed in
    // place; one the file now places is removed (the placed game stands for it); a new one is inserted. Every one has an
    // application record, with the image it had.
    db.schedule_tbd = db.schedule_tbd || [];
    for (const t of tbdUpd) {
      const row = db.schedule_tbd.find((x) => same(x.id, t.m.id));
      const ref = t.r.gameId ?? row.external_ref ?? null;
      Object.assign(row, {
        division_id: real(t.r.ids.division),
        home_team_id: real(t.r.ids.home),
        away_team_id: real(t.r.ids.away),
        week_index: t.r.weekIndex,
        external_ref: ref,
        game_date: t.r.date,
        reason: 'imported-without-time',
        detail: { ...(ref ? { game_id: ref } : {}), import_job_id: job.id },
        run_id: runId,
      });
      record('schedule_tbd', row.id, 'updated', tbdBefore.get(String(row.id)), { ...row });
    }
    for (const row of tbdRemoved) {
      db.schedule_tbd = db.schedule_tbd.filter((x) => !same(x.id, row.id));
      record('schedule_tbd', row.id, 'deleted', tbdBefore.get(String(row.id)), {});
    }
    for (const t of tbdIns) {
      const row = {
        id: t.newId,
        organization_id: org,
        season_settings_id: seasonId,
        kind: 'game',
        division_id: real(t.r.ids.division),
        home_team_id: real(t.r.ids.home),
        away_team_id: real(t.r.ids.away),
        week_index: t.r.weekIndex,
        reason: 'imported-without-time',
        detail: { ...(t.r.gameId ? { game_id: t.r.gameId } : {}), import_job_id: job.id },
        run_id: runId,
        external_ref: t.r.gameId ?? null,
        game_date: t.r.date,
        created_at: stamp,
      };
      db.schedule_tbd.push(row);
      record('schedule_tbd', row.id, 'inserted', null, { ...row });
    }
    result.ids = { run_id: runId, team_run_ids: teamRunIds };
  }
  const status = result.rows.refused > 0 ? 'completed_with_warnings' : 'completed';
  const audit = (db.audit_log = db.audit_log || []);
  audit.push({
    id: env.newId(),
    organization_id: org,
    user_id: ctx.currentUserId,
    action: 'import.completed',
    resource_type: 'import_job',
    resource_id: job.id,
    metadata: {
      import_type: 'games',
      job_type: 'games',
      season_settings_id: seasonId,
      status,
      rows: result.rows,
      games: result.games,
      time_tbd: result.time_tbd,
      created: result.created,
      reused: result.reused,
      nothing_to_apply: nothing,
      arrive_published: arrive,
    },
    created_at: stamp,
  });
  if (publishedIds.length > 0) {
    audit.push({
      id: env.newId(),
      organization_id: org,
      user_id: ctx.currentUserId,
      action: 'game.published_set',
      resource_type: 'game_assignment',
      resource_id: null,
      metadata: {
        published: true,
        scope: { kind: 'import', value: job.id },
        count: publishedIds.length,
        unchanged: 0,
        ids: publishedIds.sort(),
      },
      created_at: stamp,
    });
  }
  for (const s of staged) {
    s.applied_at = stamp;
    s.applied_by = ctx.currentUserId;
  }
  Object.assign(job, {
    status,
    processed_rows: staged.length,
    progress_percent: 100,
    completed_at: stamp,
    warning_summary: { ...(job.warning_summary || {}), game_import: result },
  });
  return { data: result, error: null };
}

// ----------------------------------------------------------------------------------------------- the rollback

function rollbackJob(db, job, ctx, env) {
  const org = job.organization_id;
  const season = jobSeason(db, job);
  if (season?.status === 'completed')
    return fail(
      '22023',
      `Season ${season.id} is completed: its games are read-only`,
      'season_completed'
    );
  const records = (db.import_application_records || []).filter(
    (r) => same(r.import_job_id, job.id) && r.import_type === 'games' && !r.rolled_back_at
  );
  if (records.length === 0)
    return fail(
      '22023',
      `Import job ${job.id} has no games application records to roll back`,
      'nothing_to_roll_back'
    );
  const run = (db.scheduler_runs || []).find(
    (r) =>
      same(r.organization_id, org) &&
      r.run_type === 'game' &&
      r.parameters?.import_job_id === job.id
  );
  const gameRecords = records.filter((r) => r.target_table === 'game_assignments');
  const changed = gameRecords
    .filter((r) => {
      const now = (db.game_assignments || []).find((g) => same(g.id, r.target_id));
      // A game the apply took out is still out: one that stands again would be put back twice.
      if (r.operation === 'deleted') return Boolean(now);
      return (
        !now ||
        imageOf(now) !== imageOf(r.applied_payload) ||
        !run ||
        !same(now.run_id ?? '', run.id) ||
        // 20261122010000: a score entered on a game the import wrote is a change since (the SQL's EXISTS over
        // game_scores). The rollback never deletes a score, and never moves a game under one.
        (db.game_scores || []).some((score) => same(score.game_id, now.id))
      );
    })
    .map((r) => r.target_id)
    .sort();
  // The same for the TIME TBD games of the job: one the apply inserted or changed must still be there and equal what the
  // apply left; one it removed must still be absent by its id (a tuple or Game ID another row holds is not a refusal: the
  // rollback counts the row it cannot put back). A refusal and not a warning: the one place a rollback would destroy
  // another import's or an admin's work.
  const changedTbd = records
    .filter((r) => r.target_table === 'schedule_tbd')
    .filter((r) => {
      const now = (db.schedule_tbd || []).find((x) => same(x.id, r.target_id));
      if (r.operation === 'deleted') return Boolean(now);
      return !now || !rowUnchanged(now, r.applied_payload);
    })
    .map((r) => r.target_id)
    .sort();
  if (changed.length + changedTbd.length > 0) {
    return fail(
      '22023',
      `The import cannot be rolled back: ${changed.length + changedTbd.length} game(s) (placed or TIME TBD) it wrote were changed, cancelled, given a score, had changes allowed or were saved into a later run since`,
      `game_import_changed count=${changed.length + changedTbd.length} ids=${changed.slice(0, LISTED_IDS).join(',')}` +
        (changedTbd.length > 0 ? ` tbd_ids=${changedTbd.slice(0, LISTED_IDS).join(',')}` : '')
    );
  }
  const of = (table, op) =>
    records.filter((r) => r.target_table === table && (!op || r.operation === op));
  const gone = (table, ids) => {
    const before = (db[table] || []).length;
    db[table] = (db[table] || []).filter((row) => !ids.some((id) => same(id, row.id)));
    return before - db[table].length;
  };
  // What an admin attached afterwards keeps its record (the SQL's guards; the pgTAP file derives the list from the catalogue).
  const attached = (table, column, id) =>
    (db[table] || []).some((row) => same(row[column] ?? '', id));
  const deletedGames = of('game_assignments', 'inserted').map((r) => r.target_id);
  gone('game_assignments', deletedGames);
  const restored = of('game_assignments', 'updated');
  for (const r of restored) {
    const row = db.game_assignments.find((g) => same(g.id, r.target_id));
    const p = r.previous_payload;
    Object.assign(row, {
      game_slot_id: p.game_slot_id,
      slot_id: p.slot_id,
      field_id: p.field_id,
      home_team_id: p.home_team_id,
      away_team_id: p.away_team_id,
      division: p.division,
      week_index: p.week_index,
      start: p.start,
      end: p.end,
      run_id: p.run_id ?? null,
      import_job_id: p.import_job_id ?? null,
    });
  }
  // Games the apply took out (the file gave them no time) stand again, as they were.
  const reinsertedGames = of('game_assignments', 'deleted');
  for (const r of reinsertedGames)
    (db.game_assignments = db.game_assignments || []).push({ ...r.previous_payload });
  // TIME TBD games: what the import inserted goes, what it changed in place is put back, and what it removed (the file
  // placed the game) is put back; a removed row whose place in the table was taken is counted, never skipped in silence.
  const tbdDeleted = gone(
    'schedule_tbd',
    of('schedule_tbd', 'inserted').map((r) => r.target_id)
  );
  const tbdRestored = of('schedule_tbd', 'updated');
  for (const r of tbdRestored)
    Object.assign(
      db.schedule_tbd.find((x) => same(x.id, r.target_id)),
      { ...r.previous_payload }
    );
  let tbdReinserted = 0;
  for (const r of of('schedule_tbd', 'deleted')) {
    const p = r.previous_payload;
    const taken = (db.schedule_tbd || []).some(
      (x) =>
        same(x.id, r.target_id) ||
        (x.kind === 'game' &&
          same(x.home_team_id ?? '', p.home_team_id) &&
          same(x.away_team_id ?? '', p.away_team_id) &&
          Number(x.week_index) === Number(p.week_index)) ||
        (same(x.season_settings_id ?? '', p.season_settings_id) &&
          p.external_ref != null &&
          x.external_ref === p.external_ref)
    );
    if (taken) continue;
    db.schedule_tbd.push({ ...p });
    tbdReinserted += 1;
  }
  const tbdNotReinserted = of('schedule_tbd', 'deleted').filter(
    (r) => !(db.schedule_tbd || []).some((x) => same(x.id, r.target_id))
  ).length;
  const games = db.game_assignments || [];
  // A row the import created is deleted only while it is still the row the apply stored (a rename, an address, a coach:
  // later work); otherwise it stays and is named in `kept`.
  const asStored = (table) => (r) =>
    rowUnchanged(
      (db[table] || []).find((row) => same(row.id, r.target_id)),
      r.applied_payload
    );
  const slotsDeleted = gone(
    'game_slots',
    of('game_slots', 'inserted')
      .filter(asStored('game_slots'))
      .map((r) => r.target_id)
      .filter(
        (id) => !games.some((g) => same(g.game_slot_id ?? '', id) || same(g.slot_id ?? '', id))
      )
  );
  const teamRefs = (id) =>
    games.some((g) => same(g.home_team_id, id) || same(g.away_team_id, id)) ||
    (db.schedule_tbd || []).some(
      (s) => s.kind === 'game' && (same(s.home_team_id ?? '', id) || same(s.away_team_id ?? '', id))
    ) ||
    (db.team_players || []).some((tp) => same(tp.team_id, id)) ||
    [
      'team_coach_assignments',
      'practice_assignments',
      'practice_exceptions',
      'coach_practice_preferences',
    ].some((table) => attached(table, 'team_id', id)) ||
    (db.players || []).some((p) => same(p.team_id ?? '', id));
  // The ids every OTHER team run of the organization names anywhere in its results (a team a later run names stays).
  const namedElsewhere = new Set();
  for (const r of db.scheduler_runs || []) {
    if (
      !same(r.organization_id, org) ||
      r.run_type !== 'team' ||
      r.parameters?.import_job_id === job.id
    )
      continue;
    for (const m of JSON.stringify(r.results ?? {}).matchAll(UUID_TEXT))
      namedElsewhere.add(m[0].toLowerCase());
  }
  const teamsDeleted = gone(
    'teams',
    of('teams', 'inserted')
      .filter(asStored('teams'))
      .map((r) => r.target_id)
      .filter((id) => !teamRefs(id) && !namedElsewhere.has(String(id).toLowerCase()))
  );
  const liveTeams = new Set((db.teams || []).map((t) => String(t.id).toLowerCase()));
  // A run something else still names stays (every foreign key onto scheduler_runs sets null): a game or TIME TBD game saved
  // into it, a practice row, an evaluation of it.
  const runNamed = (id) =>
    games.some((g) => same(g.run_id ?? '', id)) ||
    (db.schedule_tbd || []).some((s) => same(s.run_id ?? '', id)) ||
    attached('practice_assignments', 'run_id', id) ||
    attached('practice_exceptions', 'run_id', id) ||
    attached('evaluation_runs', 'scheduler_run_id', id);
  const runsBefore = (db.scheduler_runs || []).length;
  db.scheduler_runs = (db.scheduler_runs || []).filter(
    (r) =>
      !(
        same(r.organization_id, org) &&
        r.run_type === 'team' &&
        r.parameters?.import_job_id === job.id &&
        !(r.parameters.shell_ids || []).some((id) => liveTeams.has(String(id).toLowerCase())) &&
        !runNamed(r.id)
      )
  );
  const teamRunsDeleted = runsBefore - db.scheduler_runs.length;
  const fieldsDeleted = gone(
    'fields',
    of('fields', 'inserted')
      .filter(asStored('fields'))
      .map((r) => r.target_id)
      .filter(
        (id) =>
          !(db.game_slots || []).some((s) => same(s.field_id, id)) &&
          !games.some((g) => same(g.field_id ?? '', id)) &&
          !attached('facility_permit_scopes', 'field_id', id) &&
          !attached('field_blackouts', 'field_id', id) &&
          !attached('field_subunits', 'field_id', id)
      )
  );
  const venuesDeleted = gone(
    'locations',
    of('locations', 'inserted')
      .filter(asStored('locations'))
      .map((r) => r.target_id)
      .filter(
        (id) =>
          !(db.fields || []).some((f) => same(f.location_id, id)) &&
          !attached('facility_permit_scopes', 'location_id', id) &&
          !attached('field_blackouts', 'location_id', id)
      )
  );
  const divisionsDeleted = gone(
    'divisions',
    of('divisions', 'inserted')
      .filter(asStored('divisions'))
      .map((r) => r.target_id)
      .filter(
        (id) =>
          !(db.teams || []).some((t) => same(t.division_id, id)) &&
          !attached('schedule_tbd', 'division_id', id)
      )
  );
  // The import's own game run goes last, and stays when something else names it.
  if (run && !runNamed(run.id))
    db.scheduler_runs = db.scheduler_runs.filter((r) => !same(r.id, run.id));
  // A run that stays is kept for HISTORY and is never the current one: it is retired with the status every reader of a
  // latest run skips (`failed`) and marked rolled back, so the run the games went back to is the latest again. A TEAM run
  // that stays because it carries a kept shell is NOT retired (it is the only run that lists that shell). Either way the
  // shells that are gone are taken out of what a kept team run lists.
  for (const r of db.scheduler_runs || []) {
    if (!same(r.organization_id, org) || r.parameters?.import_job_id !== job.id) continue;
    const shellIds = r.parameters.shell_ids || [];
    const live = shellIds.filter((id) => liveTeams.has(String(id).toLowerCase()));
    if (r.run_type === 'game' || live.length === 0) {
      r.status = 'failed';
      r.parameters = { ...r.parameters, rolled_back: true };
    }
    if (r.run_type !== 'team' || live.length === shellIds.length) continue;
    const gone = new Set(
      shellIds.filter((id) => !liveTeams.has(String(id).toLowerCase())).map((id) => String(id))
    );
    r.parameters = { ...r.parameters, shell_ids: live };
    const results = { ...(r.results || {}) };
    if (results.teamsByDivision && typeof results.teamsByDivision === 'object')
      results.teamsByDivision = Object.fromEntries(
        Object.entries(results.teamsByDivision)
          .map(([key, list]) => [
            key,
            (Array.isArray(list) ? list : []).filter((t) => !gone.has(String(t?.id))),
          ])
          .filter(([, list]) => list.length > 0)
      );
    if (Array.isArray(results.teams))
      results.teams = results.teams.filter((t) => !gone.has(String(t?.id)));
    if (Array.isArray(results.team_players))
      results.team_players = results.team_players.filter((tp) => !gone.has(String(tp?.team_id)));
    r.results = results;
  }
  // What was created and is still there (referenced by something that came after, or changed since), named, never
  // deleted silently; and a run of the import that is still there for a reason of its own (not for a shell it carries).
  const stillThere = {
    game_slots: 'game_slots',
    teams: 'teams',
    fields: 'fields',
    locations: 'locations',
    divisions: 'divisions',
  };
  const kept = [
    ...records
      .filter(
        (r) =>
          r.operation === 'inserted' &&
          stillThere[r.target_table] &&
          (db[stillThere[r.target_table]] || []).some((row) => same(row.id, r.target_id))
      )
      .map((r) => ({ table: r.target_table, id: r.target_id })),
    ...(db.scheduler_runs || [])
      .filter(
        (r) =>
          same(r.organization_id, org) &&
          r.parameters?.import_job_id === job.id &&
          (r.run_type === 'game' ||
            !(r.parameters.shell_ids || []).some((id) => liveTeams.has(String(id).toLowerCase())))
      )
      .map((r) => ({ table: 'scheduler_runs', id: r.id })),
  ].sort((a, b) => (a.table < b.table ? -1 : a.table > b.table ? 1 : a.id < b.id ? -1 : 1));
  const stamp = env.now();
  for (const r of records)
    Object.assign(r, {
      rolled_back_at: stamp,
      rolled_back_by: ctx.currentUserId,
      rollback_payload: { rolled_back: true },
    });
  const result = {
    job_id: job.id,
    games: {
      deleted: deletedGames.length,
      restored: restored.length,
      reinserted: reinsertedGames.length,
    },
    time_tbd_deleted: tbdDeleted,
    time_tbd_restored: tbdRestored.length,
    time_tbd_reinserted: tbdReinserted,
    time_tbd_not_reinserted: tbdNotReinserted,
    slots_deleted: slotsDeleted,
    teams_deleted: teamsDeleted,
    team_runs_deleted: teamRunsDeleted,
    fields_deleted: fieldsDeleted,
    venues_deleted: venuesDeleted,
    divisions_deleted: divisionsDeleted,
    kept,
  };
  (db.audit_log = db.audit_log || []).push({
    id: env.newId(),
    organization_id: org,
    user_id: ctx.currentUserId,
    action: 'import.rolled_back',
    resource_type: 'import_job',
    resource_id: job.id,
    metadata: { import_type: 'games', ...result },
    created_at: stamp,
  });
  job.status = 'needs_fix';
  job.warning_summary = { ...(job.warning_summary || {}), game_import_rollback: result };
  return { data: result, error: null };
}

// ------------------------------------------------------------------------- the Edge function's games arm (PR 6)

/** An Edge function's non-2xx answer as supabase-js hands it over: the body is read from `context`. */
function httpRefusal(status, body) {
  const error = new Error('Edge Function returned a non-2xx status code');
  return {
    data: null,
    error: Object.assign(error, { context: { status, json: async () => body } }),
  };
}

/**
 * The mock's `import-validation` for `import_type: 'games'` (the Edge function's games arm,
 * `supabase/functions/import-validation/index.ts`; plan 4.2 step 3 and PR 6, tasks F1 and F7).
 *
 * **Mirrored.** `action: 'stage'`: the job must be a games job of the organization that still takes rows; the season
 * (and so the clock and the window) is the JOB's; the chunk is read by core's `stageScheduleChunk` (the function the
 * Edge mirror is held to); a refused file stages nothing and answers `status: 'refused'`; the first chunk
 * (`row_offset` 0) replaces everything the job had staged, a later one its own row numbers. `action: 'apply'`: the
 * confirm must carry the counts of the preview; the dry run is run again and, when its counts differ, the answer is
 * 409 `game_import_preview_stale` with both sets of counts and the fresh preview, and nothing is written; a database
 * refusal keeps its code in `code`.
 *
 * **Mirrored from the request shape:** more than 200 headers is a 400 `Invalid payload`, as `GamesImportPayload` answers.
 *
 * **Not mirrored:** the JWT, the rate limit, the payload size limit, Zod's shape errors beyond the ones named here,
 * the demo fence (the database's own fence refuses a demo's job) and the audit rows of the staging step.
 *
 * @param {any} db
 * @param {Record<string, any>} body
 * @param {{ isOrgAdmin: (organizationId: string) => boolean, currentUserId: string | null,
 *   newId?: () => string, now?: () => string }} ctx
 * @returns {{ data: any, error: any, wrote: boolean }}
 */
export function handleGameImportFunction(db, body, ctx) {
  const done = (answer, wrote = false) => ({ ...answer, wrote });
  const newId = ctx.newId ?? (() => globalThis.crypto.randomUUID());
  const now = ctx.now ?? (() => new Date().toISOString());
  if (!ctx.currentUserId)
    return done(httpRefusal(401, { status: 'error', message: 'Unauthorized' }));
  const headers = body?.headers ?? [];
  // The request shape's own cap (`GamesImportPayload.headers`, at most 200): a 400 before anything is read.
  if (
    !body?.organization_id ||
    !body?.import_job_id ||
    !Array.isArray(headers) ||
    headers.length > SCHEDULE_IMPORT_LIMITS.MAX_COLUMNS
  ) {
    return done(httpRefusal(400, { status: 'error', message: 'Invalid payload' }));
  }
  if (!ctx.isOrgAdmin(body.organization_id)) {
    return done(
      httpRefusal(403, {
        status: 'error',
        message: 'Access denied: not an admin of this organization',
      })
    );
  }
  const job = (db.import_jobs || []).find(
    (item) => same(item.id, body.import_job_id) && same(item.organization_id, body.organization_id)
  );
  if (!job) {
    return done(
      httpRefusal(404, { status: 'error', message: 'Import job not found for organization' })
    );
  }
  if (job.job_type !== 'games') {
    return done(
      httpRefusal(409, {
        status: 'error',
        message: `Import job type ${job.job_type} does not match games`,
      })
    );
  }

  if ((body.action ?? 'stage') === 'apply') {
    if (!isScheduleImportConfirmCounts(body.confirmed)) {
      return done(
        httpRefusal(400, {
          status: 'error',
          code: 'confirmed_counts_required',
          message:
            'The confirm must carry the counts of the preview it confirms. Preview the import again.',
        })
      );
    }
    const call = (dry) =>
      handleGameImportRpc(
        db,
        'apply_game_import_job',
        { p_import_job_id: job.id, p_dry_run: dry },
        { ...ctx, newId, now }
      );
    const refused = (error) => {
      const status =
        error.code === '42501'
          ? 403
          : error.code === 'P0002'
            ? 404
            : error.code === '22023'
              ? 409
              : 500;
      return done(
        httpRefusal(status, {
          status: 'error',
          code: error.details || error.code || 'game_import_failed',
          message: error.message ?? 'The import was refused.',
        })
      );
    };
    const preview = call(true);
    if (preview.error) return refused(preview.error);
    if (preview.data?.replayed === true) {
      return done({
        data: { status: 'success', import_type: 'games', result: preview.data },
        error: null,
      });
    }
    const current = scheduleImportConfirmCounts(preview.data);
    const differing = diffScheduleImportConfirmCounts(body.confirmed, current);
    if (differing.length > 0) {
      return done(
        httpRefusal(409, {
          status: 'error',
          code: 'game_import_preview_stale',
          message:
            'The schedule changed after this preview was made, so the import would no longer do what was confirmed. Nothing was written. Review the new preview and confirm again.',
          differing,
          confirmed: body.confirmed,
          current,
          preview: preview.data,
        })
      );
    }
    const applied = call(false);
    if (applied.error) return refused(applied.error);
    return done(
      { data: { status: 'success', import_type: 'games', result: applied.data }, error: null },
      true
    );
  }

  if (['completed', 'completed_with_warnings', 'failed', 'needs_fix'].includes(job.status)) {
    return done(
      httpRefusal(409, {
        status: 'error',
        message: `Import job cannot accept staged rows while ${job.status}`,
      })
    );
  }
  const rows = Array.isArray(body.rows) ? body.rows : [];
  const rowOffset = Number.isInteger(body.row_offset) ? body.row_offset : 0;
  if (rows.length > SCHEDULE_IMPORT_CHUNK_LIMITS.MAX_CHUNK_ROWS) {
    return done(httpRefusal(400, { status: 'error', message: 'Invalid payload' }));
  }
  const season = jobSeason(db, job);
  if (!season) {
    return done(
      httpRefusal(409, {
        status: 'error',
        code: 'season_missing',
        message: 'This import has no season to import into. Start the import again.',
      })
    );
  }
  const chunk = stageScheduleChunk({
    clean: sanitizeImportText,
    headers,
    rows,
    season: {
      timeZone: season.timezone ?? null,
      startDate: season.season_start ?? null,
      endDate: season.season_end ?? null,
    },
    rowOffset,
  });
  if (chunk.refusal) {
    return done({
      data: {
        status: 'refused',
        import_type: 'games',
        code: chunk.refusal.code,
        message: chunk.refusal.message,
        column: chunk.refusal.column ?? null,
      },
      error: null,
    });
  }
  const numbers = new Set(chunk.staged.map((row) => row.source_row_number));
  db.staging_import_rows = (db.staging_import_rows || []).filter(
    (row) =>
      !same(row.import_job_id, job.id) ||
      row.import_type !== 'games' ||
      (rowOffset !== 0 && !numbers.has(row.source_row_number))
  );
  for (const row of chunk.staged) {
    db.staging_import_rows.push({
      id: newId(),
      organization_id: job.organization_id,
      import_job_id: job.id,
      import_type: 'games',
      source_row_number: row.source_row_number,
      raw_payload: row.raw_payload,
      normalized_payload: row.normalized_payload,
      validation_errors: row.validation_errors,
      created_at: now(),
    });
  }
  return done(
    {
      data: {
        status: 'success',
        import_type: 'games',
        row_offset: rowOffset,
        total_rows: chunk.summary.rows,
        staged_rows: chunk.staged.length,
        valid_rows: chunk.summary.ok + chunk.summary.tbd,
        error_rows: chunk.summary.refused,
        summary: chunk.summary,
      },
      error: null,
    },
    true
  );
}
