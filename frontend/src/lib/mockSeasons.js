/**
 * Mock arms for the season writers of migration `20261109010000_season_rollover.sql` (Phase E3b;
 * plans `docs/changes/2026-10-22-phase-e-seasons.md` and `docs/changes/2026-10-27-season-enrollment.md`):
 * `admin_create_season_from`, `admin_update_draft_season`, `admin_set_division_birthdate_window` and
 * `admin_activate_season`, and the completed-season read-only rule for players and coaches.
 *
 * **Refusals included, not just the happy path** (LESSONS_LEARNED #13), with the SQL's codes:
 *   - 42501 no session, a missing row, another organization's row, or a caller who is not an admin of
 *     the organization the *row* belongs to (one refusal for all);
 *   - 23502 a missing argument;
 *   - 22023 a name that is not 1-80 characters, a year outside 2000-2100 (`season_year_invalid`), an end
 *     before a start (`season_dates_invalid`), a custom cutoff with no day (`cutoff_day_missing`) or a
 *     day that is not on the calendar (`cutoff_day_invalid`), an unknown key or mode, a completed
 *     season (`season_completed`), the cutoff and year of an active season (`season_not_draft`), a
 *     cutoff, year or division window once the season has players (`season_has_players`) or while a
 *     player import into it is unfinished (`import_pending`), half a window
 *     (`window_incomplete`), a window that ends before it starts (`window_invalid`), activation without
 *     a timezone, dates or a year (`season_timezone_missing`, `season_dates_missing`,
 *     `season_year_missing`) and of a season that is not a draft (`season_not_draft`);
 *   - 23505 a season name another season of the organization holds (ignoring case and padding).
 * Each success appends one `audit_log` row (`season.created_from`, `season.updated`,
 * `division.window_changed`, `season.activated`) with the SQL's metadata; a refusal appends none, and
 * nothing it changed stays (every write is made after the last refusal, as the SQL's transaction does).
 *
 * Pure over `db` so a test can drive it directly; `mockSupabaseClient.js` wires it into `rpc()`.
 */

import { defaultProgramOf, normalizePrograms } from './mockPrograms.js';

export const SEASON_RPCS = Object.freeze([
  'admin_create_season_from',
  'admin_update_draft_season',
  'admin_set_division_birthdate_window',
  'admin_activate_season',
]);

/** The columns a rollover does not copy (`rollover_*_skipped_columns()`); every other one is copied. */
export const ROLLOVER_DIVISION_SKIPPED = Object.freeze([
  'id',
  'season_settings_id',
  'program_id',
  'season_start',
  'season_end',
  'created_at',
  'updated_at',
]);
export const ROLLOVER_SEASON_COPIED = Object.freeze([
  'timezone',
  'age_cutoff_mode',
  'age_cutoff_month',
  'age_cutoff_day',
  'school_day_end',
  'roster_formula',
  'exports_config',
]);

const PATCH_KEYS = [
  'name',
  'season_start',
  'season_end',
  'season_year',
  'age_cutoff_mode',
  'age_cutoff_month',
  'age_cutoff_day',
];
const CUTOFF_KEYS = ['season_year', 'age_cutoff_mode', 'age_cutoff_month', 'age_cutoff_day'];
const MODES = ['school_year_aug_jul', 'birth_year', 'custom'];

const fail = (code, message, detail) => ({
  data: null,
  error: { code, message, ...(detail ? { details: detail } : {}) },
});
const same = (a, b) => String(a) === String(b);
const nameKey = (text) =>
  String(text ?? '')
    .trim()
    .toLowerCase();
const notAdmin = (what) =>
  fail('42501', `Access denied: caller is not an admin of the ${what}'s organization`);

const seasonOf = (db, id) => (db.season_settings || []).find((s) => same(s.id, id));
const seasonHasPlayers = (db, seasonId) =>
  (db.players || []).some((p) => same(p.season_settings_id, seasonId));

/**
 * Mirrors `season_has_pending_player_import`: an unfinished registration job of the season (a legacy
 * job with no season belongs to the organization's active one) with staged rows not yet promoted.
 * Cancelling a job is failing it, which ends it.
 */
const FINISHED_JOB = ['completed', 'completed_with_warnings', 'failed'];
function seasonHasPendingImport(db, seasonId) {
  const season = seasonOf(db, seasonId);
  if (!season) return false;
  return (db.import_jobs || []).some(
    (job) =>
      same(job.organization_id, season.organization_id) &&
      (same(job.season_settings_id, season.id) ||
        (job.season_settings_id == null && season.status === 'active')) &&
      job.job_type === 'registration' &&
      !FINISHED_JOB.includes(job.status) &&
      (db.staging_players || []).some((row) => same(row.import_job_id, job.id) && !row.promoted_at)
  );
}

function audit(db, ctx, orgId, action, resourceType, resourceId, metadata) {
  db.audit_log = db.audit_log || [];
  db.audit_log.push({
    id: ctx.newId(),
    organization_id: orgId,
    user_id: ctx.currentUserId,
    action,
    resource_type: resourceType,
    resource_id: resourceId,
    metadata,
    created_at: (ctx.now ?? new Date()).toISOString(),
  });
}

const isoDate = (value) => {
  const text = String(value ?? '');
  return /^\d{4}-\d{2}-\d{2}/.test(text) && !Number.isNaN(Date.parse(text.slice(0, 10)))
    ? text.slice(0, 10)
    : null;
};

/** `date + n years` as the SQL's `make_interval(years => n)`: Feb 29 lands on Feb 28. */
export function shiftYears(value, years) {
  const date = isoDate(value);
  if (!date) return null;
  const [y, m, d] = date.split('-').map(Number);
  const target = new Date(Date.UTC(y + years, m - 1, d));
  if (target.getUTCMonth() !== m - 1) target.setUTCDate(0); // Feb 29 -> Feb 28
  return target.toISOString().slice(0, 10);
}

/** Is `month`/`day` a real calendar day (February 29 accepted)? */
export function validCutoffDay(month, day) {
  if (!Number.isInteger(month) || !Number.isInteger(day) || month < 1 || month > 12) return false;
  const longest = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return day >= 1 && day <= longest;
}

/**
 * The refusal for a write to a player or coach row of a completed season, or null. `rows` are the
 * rows about to change. Mirrors the `players_readonly_when_completed` / `coaches_readonly_when_completed`
 * triggers for a signed-in caller.
 * @param {any} db
 * @param {Array<{ season_settings_id?: string | null }>} rows
 */
export function completedSeasonRefusal(db, rows) {
  for (const row of rows || []) {
    const season = row?.season_settings_id ? seasonOf(db, row.season_settings_id) : null;
    if (season?.status === 'completed') {
      return fail(
        '22023',
        `Season ${season.id} is completed and read-only: its rows cannot be changed`,
        'season_completed'
      );
    }
  }
  return null;
}

/** The tables whose `season_schedule_readonly_when_completed` trigger the mock mirrors. */
const SCHEDULE_TABLES = [
  'teams',
  'team_players',
  'team_coach_assignments',
  'practice_assignments',
  'practice_exceptions',
  'game_assignments',
];

/** The season a schedule row belongs to: its own column, else its team's division's season. */
function scheduleSeasonOf(db, table, row) {
  if (table === 'practice_exceptions' && row?.season_settings_id) {
    return seasonOf(db, row.season_settings_id);
  }
  let divisionId = table === 'teams' ? row?.division_id : null;
  if (table !== 'teams') {
    const teamId = row?.team_id ?? row?.home_team_id ?? row?.away_team_id;
    divisionId = (db.teams || []).find((t) => same(t.id, teamId))?.division_id;
  }
  const division = (db.divisions || []).find((d) => same(d.id, divisionId));
  return division ? seasonOf(db, division.season_settings_id) : null;
}

/**
 * The refusal for a write by a signed-in caller to a schedule row of a completed season, or null;
 * the mock of `season_schedule_readonly_when_completed` on teams, rosters, coach history, practices,
 * TIME TBD exceptions and games. `rows` are the rows about to be written, and for a change both the
 * old rows and the new ones, so a row cannot be moved out of or into a completed season.
 * @param {any} db
 * @param {string} table
 * @param {Array<Record<string, any>>} rows
 */
export function scheduleWriteRefusal(db, table, rows) {
  if (!SCHEDULE_TABLES.includes(table)) return null;
  for (const row of rows || []) {
    const season = scheduleSeasonOf(db, table, row);
    if (season?.status === 'completed') {
      return fail(
        '22023',
        `Season ${season.id} is completed and read-only: its schedule (${table}) cannot be changed`,
        'season_completed'
      );
    }
  }
  return null;
}

/**
 * @param {any} db - the mock database; mutated in place
 * @param {string} name
 * @param {Record<string, any>} params
 * @param {{ currentUserId: string|null, isOrgAdmin: (orgId: string) => boolean,
 *   now?: Date, newId?: () => string }} ctx
 * @returns {{ data: any, error: any } | null} null when `name` is not one of these RPCs
 */
export function handleSeasonRpc(db, name, params, ctx) {
  if (!SEASON_RPCS.includes(name)) return null;
  const p = params || {};
  const c = { ...ctx, newId: ctx.newId ?? (() => globalThis.crypto.randomUUID()) };
  normalizePrograms(db);
  if (!c.currentUserId) return fail('42501', 'authenticated user is required');

  if (name === 'admin_create_season_from') return createSeasonFrom(db, p, c);
  if (name === 'admin_update_draft_season') return updateDraftSeason(db, p, c);
  if (name === 'admin_set_division_birthdate_window') return setWindow(db, p, c);
  return activateSeason(db, p, c);
}

function createSeasonFrom(db, p, c) {
  if (!p.p_source_season_id) return fail('23502', 'p_source_season_id is required');
  const source = seasonOf(db, p.p_source_season_id);
  if (!source || !c.isOrgAdmin(source.organization_id)) return notAdmin('season');
  const name = String(p.p_name ?? '').trim();
  if (name.length < 1 || name.length > 80) {
    return fail('22023', 'a season name must be 1 to 80 characters');
  }
  const year = p.p_season_year;
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    return fail(
      '22023',
      'the season year (the year the season starts) must be between 2000 and 2100',
      'season_year_invalid'
    );
  }
  const start = p.p_season_start ?? null;
  const end = p.p_season_end ?? null;
  if (start && end && String(end) < String(start)) {
    return fail('22023', 'the season cannot end before it starts', 'season_dates_invalid');
  }
  if (
    (db.season_settings || []).some(
      (s) => same(s.organization_id, source.organization_id) && nameKey(s.name) === nameKey(name)
    )
  ) {
    return fail('23505', `a season named "${name}" already exists`);
  }

  const shift = Number.isInteger(source.season_year) ? year - source.season_year : 1;
  const now = (c.now ?? new Date()).toISOString();
  const season = {
    id: c.newId(),
    organization_id: source.organization_id,
    name,
    status: 'draft',
    season_year: year,
    season_start: start,
    season_end: end,
    created_at: now,
    updated_at: now,
  };
  for (const column of ROLLOVER_SEASON_COPIED) {
    season[column] = source[column] === undefined ? null : structuredClone(source[column]);
  }
  db.season_settings.push(season);
  normalizePrograms(db); // the trigger-made default program of the new season

  const newDefault = defaultProgramOf(db, season.id);
  const sourceDefault = defaultProgramOf(db, source.id);
  if (newDefault && sourceDefault) newDefault.copied_from_program_id = sourceDefault.id;
  const programMap = new Map(
    sourceDefault && newDefault ? [[sourceDefault.id, newDefault.id]] : []
  );
  let programs = 0;
  for (const program of (db.programs || []).filter(
    (q) => same(q.season_settings_id, source.id) && !q.is_default
  )) {
    const copy = {
      id: c.newId(),
      organization_id: program.organization_id,
      season_settings_id: season.id,
      name: program.name,
      is_default: false,
      copied_from_program_id: program.id,
      created_at: now,
      updated_at: now,
    };
    db.programs.push(copy);
    programMap.set(program.id, copy.id);
    programs += 1;
  }
  let divisions = 0;
  for (const division of (db.divisions || []).filter((d) =>
    same(d.season_settings_id, source.id)
  )) {
    const copy = { id: c.newId(), season_settings_id: season.id };
    for (const [key, value] of Object.entries(division)) {
      if (!ROLLOVER_DIVISION_SKIPPED.includes(key)) copy[key] = structuredClone(value);
    }
    copy.birthdate_start = shiftYears(division.birthdate_start, shift);
    copy.birthdate_end = shiftYears(division.birthdate_end, shift);
    copy.program_id = programMap.get(division.program_id) ?? newDefault?.id;
    copy.created_at = now;
    copy.updated_at = now;
    db.divisions.push(copy);
    divisions += 1;
  }

  audit(db, c, source.organization_id, 'season.created_from', 'season_settings', season.id, {
    source_season_id: source.id,
    name,
    season_year: year,
    divisions_copied: divisions,
    programs_copied: programs,
    window_shift_years: shift,
  });
  return {
    data: {
      id: season.id,
      organization_id: season.organization_id,
      name,
      status: 'draft',
      season_year: year,
      source_season_id: source.id,
      divisions_copied: divisions,
      programs_copied: programs,
    },
    error: null,
  };
}

function updateDraftSeason(db, p, c) {
  if (!p.p_season_id) return fail('23502', 'p_season_id is required');
  const patch = p.p_patch;
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return fail('22023', 'p_patch must be a json object');
  }
  for (const key of Object.keys(patch)) {
    if (!PATCH_KEYS.includes(key)) {
      return fail('22023', `a season's ${key} cannot be changed here`);
    }
  }
  const old = seasonOf(db, p.p_season_id);
  if (!old || !c.isOrgAdmin(old.organization_id)) return notAdmin('season');
  if (old.status === 'completed') {
    return fail('22023', `Season ${old.id} is completed and cannot be changed`, 'season_completed');
  }

  const next = { ...old };
  const has = (key) => Object.prototype.hasOwnProperty.call(patch, key);
  const invalid = () => fail('22023', 'a value in the patch is not valid for its field');
  if (has('name')) {
    next.name = String(patch.name ?? '').trim();
    if (next.name.length < 1 || next.name.length > 80) {
      return fail('22023', 'a season name must be 1 to 80 characters');
    }
  }
  for (const key of ['season_start', 'season_end']) {
    if (!has(key)) continue;
    if (patch[key] === null) next[key] = null;
    else if (isoDate(patch[key])) next[key] = isoDate(patch[key]);
    else return invalid();
  }
  for (const key of ['season_year', 'age_cutoff_month', 'age_cutoff_day']) {
    if (!has(key)) continue;
    if (patch[key] === null) next[key] = null;
    else if (Number.isInteger(Number(patch[key])) && patch[key] !== '')
      next[key] = Number(patch[key]);
    else return invalid();
  }
  if (has('age_cutoff_mode')) next.age_cutoff_mode = patch.age_cutoff_mode ?? null;

  if (next.season_start && next.season_end && next.season_end < next.season_start) {
    return fail('22023', 'the season cannot end before it starts', 'season_dates_invalid');
  }
  if (next.season_year != null && (next.season_year < 2000 || next.season_year > 2100)) {
    return fail(
      '22023',
      'the season year (the year the season starts) must be between 2000 and 2100',
      'season_year_invalid'
    );
  }
  if (!MODES.includes(next.age_cutoff_mode)) {
    return fail('22023', 'age_cutoff_mode must be school_year_aug_jul, birth_year or custom');
  }
  if (next.age_cutoff_mode !== 'custom') {
    next.age_cutoff_month = null;
    next.age_cutoff_day = null;
  } else if (next.age_cutoff_month == null || next.age_cutoff_day == null) {
    return fail('22023', 'a custom age cutoff needs a month and a day', 'cutoff_day_missing');
  } else if (!validCutoffDay(next.age_cutoff_month, next.age_cutoff_day)) {
    return fail('22023', 'the age cutoff is not a calendar day', 'cutoff_day_invalid');
  }

  const changed = {};
  for (const key of PATCH_KEYS) {
    if ((old[key] ?? null) !== (next[key] ?? null)) {
      changed[key] = { old: old[key] ?? null, new: next[key] ?? null };
    }
  }
  if (Object.keys(changed).length === 0)
    return { data: { id: old.id, status: old.status, changed: false }, error: null };
  if (Object.keys(changed).some((key) => CUTOFF_KEYS.includes(key))) {
    if (old.status !== 'draft') {
      return fail(
        '22023',
        `Season ${old.id} is ${old.status} and its age cutoff and season year can only change on a draft`,
        'season_not_draft'
      );
    }
    if (seasonHasPlayers(db, old.id)) {
      return fail(
        '22023',
        `Season ${old.id} has players: its age cutoff and season year cannot change`,
        'season_has_players'
      );
    }
    if (seasonHasPendingImport(db, old.id)) {
      return fail(
        '22023',
        `Season ${old.id} has a player import in progress: finish or cancel it before its age cutoff or season year changes`,
        'import_pending'
      );
    }
  }
  if (
    (db.season_settings || []).some(
      (s) =>
        !same(s.id, old.id) &&
        same(s.organization_id, old.organization_id) &&
        nameKey(s.name) === nameKey(next.name)
    )
  ) {
    return fail('23505', `a season named "${next.name}" already exists`);
  }

  Object.assign(old, next, { updated_at: (c.now ?? new Date()).toISOString() });
  audit(db, c, old.organization_id, 'season.updated', 'season_settings', old.id, {
    status: old.status,
    changed,
  });
  return { data: { id: old.id, status: old.status, changed: true, fields: changed }, error: null };
}

function setWindow(db, p, c) {
  if (!p.p_division_id) return fail('23502', 'p_division_id is required');
  const division = (db.divisions || []).find((d) => same(d.id, p.p_division_id));
  if (!division || !c.isOrgAdmin(division.organization_id)) return notAdmin('division');
  const season = seasonOf(db, division.season_settings_id);
  if (season?.status === 'completed') {
    return fail(
      '22023',
      `Season ${season.id} is completed and its divisions cannot be changed`,
      'season_completed'
    );
  }
  const start = p.p_birthdate_start ?? null;
  const end = p.p_birthdate_end ?? null;
  if ((start === null) !== (end === null)) {
    return fail(
      '22023',
      'a birth-date window needs both a start and an end, or neither',
      'window_incomplete'
    );
  }
  if (start !== null && String(start) > String(end)) {
    return fail('22023', 'the window cannot end before it starts', 'window_invalid');
  }
  if ((division.birthdate_start ?? null) === start && (division.birthdate_end ?? null) === end) {
    return { data: { id: division.id, changed: false }, error: null };
  }
  if (seasonHasPlayers(db, division.season_settings_id)) {
    return fail(
      '22023',
      `Season ${division.season_settings_id} has players: a division's birth-date window cannot change`,
      'season_has_players'
    );
  }
  if (seasonHasPendingImport(db, division.season_settings_id)) {
    return fail(
      '22023',
      `Season ${division.season_settings_id} has a player import in progress: finish or cancel it before a division's birth-date window changes`,
      'import_pending'
    );
  }
  const before = { start: division.birthdate_start ?? null, end: division.birthdate_end ?? null };
  division.birthdate_start = start;
  division.birthdate_end = end;
  division.updated_at = (c.now ?? new Date()).toISOString();
  audit(db, c, division.organization_id, 'division.window_changed', 'division', division.id, {
    season_settings_id: division.season_settings_id,
    name: division.name,
    old_start: before.start,
    old_end: before.end,
    new_start: start,
    new_end: end,
  });
  return {
    data: { id: division.id, changed: true, birthdate_start: start, birthdate_end: end },
    error: null,
  };
}

function activateSeason(db, p, c) {
  if (!p.p_season_id) return fail('23502', 'p_season_id is required');
  const target = seasonOf(db, p.p_season_id);
  if (!target || !c.isOrgAdmin(target.organization_id)) return notAdmin('season');
  if (target.status === 'completed') {
    return fail(
      '22023',
      `Season ${target.id} is completed and cannot be activated again; start a new season from it`,
      'season_completed'
    );
  }
  if (target.status !== 'draft') {
    return fail(
      '22023',
      `Season ${target.id} is ${target.status} and only a draft can be activated`,
      'season_not_draft'
    );
  }
  let zoneKnown = false;
  try {
    zoneKnown =
      Boolean(target.timezone) &&
      Boolean(new Intl.DateTimeFormat('en-US', { timeZone: target.timezone }));
  } catch {
    zoneKnown = false;
  }
  if (!zoneKnown) {
    return fail(
      '22023',
      `Season ${target.id} needs a known timezone before it is activated`,
      'season_timezone_missing'
    );
  }
  if (!target.season_start || !target.season_end) {
    return fail(
      '22023',
      `Season ${target.id} needs a start and an end date before it is activated`,
      'season_dates_missing'
    );
  }
  if (target.season_end < target.season_start) {
    return fail('22023', `Season ${target.id} ends before it starts`, 'season_dates_invalid');
  }
  if (target.season_year == null) {
    return fail(
      '22023',
      `Season ${target.id} needs a season year before it is activated`,
      'season_year_missing'
    );
  }

  const previous = (db.season_settings || []).find(
    (s) => same(s.organization_id, target.organization_id) && s.status === 'active'
  );
  if (previous) previous.status = 'completed';
  target.status = 'active';
  const now = (c.now ?? new Date()).toISOString();
  target.updated_at = now;
  if (previous) previous.updated_at = now;
  audit(db, c, target.organization_id, 'season.activated', 'season_settings', target.id, {
    name: target.name,
    previous_active_season_id: previous?.id ?? null,
  });
  return {
    data: { id: target.id, status: 'active', previous_active_season_id: previous?.id ?? null },
    error: null,
  };
}
