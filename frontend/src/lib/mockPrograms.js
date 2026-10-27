/**
 * Mock arms for the four program writers of migration `20261101020000_programs.sql`
 * (Phase E2; plan `docs/changes/2026-10-22-phase-e-seasons.md`), and the two triggers
 * that keep every season in a default program and every division in a program of its season.
 *
 * **Refusals included, not just the happy path** (LESSONS_LEARNED #13), with the SQL's codes:
 *   - 42501 no session, a missing row, another organization's row, or a caller who is not an
 *     admin of the organization the *row* belongs to (one refusal for all, so an id the caller
 *     does not own is not disclosed);
 *   - 23502 a missing argument;
 *   - 22023 a completed season (`season_completed`), a name that is not 1-80 characters after
 *     trimming, renaming/deleting/merging away the default, a program merged into itself, programs
 *     of two seasons merged;
 *   - 23505 a second program of one name in a season (ignoring case and padding);
 *   - 23503 a program that is not a program of the division's (or the named) season.
 * Each success appends one `audit_log` row (`program.upserted`, `division.program_changed`,
 * `program.deleted`, `program.merged`) with the SQL's metadata; a refusal appends none.
 *
 * The triggers are {@link normalizePrograms}: every season has one default program, "No program"
 * (`is_default`), and a division whose `program_id` is missing, or names a program that is not of
 * its own season, is in its season's default. The mock database is assembled from seed rows and
 * test-injected rows, so the rule is applied when the database is read, which is where the SQL
 * applies it when a row is written.
 *
 * Pure over `db` so a test can drive it directly; `mockSupabaseClient.js` wires it into `rpc()`,
 * calls `normalizePrograms` when it reads the database, and persists `db` afterwards.
 */

export const PROGRAM_RPCS = Object.freeze([
  'admin_upsert_program',
  'admin_set_division_program',
  'admin_delete_program',
  'admin_merge_programs',
]);

/** The default program's name; the UI shows it as "No program". */
export const DEFAULT_PROGRAM_NAME = 'No program';

const fail = (code, message, detail) => ({
  data: null,
  error: { code, message, ...(detail ? { details: detail } : {}) },
});
const same = (a, b) => String(a) === String(b);
const nameKey = (text) =>
  String(text ?? '')
    .trim()
    .toLowerCase();

/** The id of a season's default program in the mock (stable, so re-reads do not duplicate it). */
export const defaultProgramIdFor = (seasonId) => `program-default-${seasonId}`;

/**
 * Applies the two triggers to `db` in place: a default program for every season, and a program of
 * its own season for every division. Idempotent.
 * @param {any} db
 * @returns {any} db
 */
export function normalizePrograms(db) {
  const seasons = db.season_settings || [];
  const divisions = db.divisions || [];
  db.programs = db.programs || [];
  const deleted = new Set(((db.__deleted__ || {}).programs || []).map(String));
  for (const season of seasons) {
    const hasDefault = db.programs.some(
      (p) => same(p.season_settings_id, season.id) && p.is_default
    );
    const id = defaultProgramIdFor(season.id);
    if (!hasDefault && !deleted.has(id)) {
      db.programs.push({
        id,
        organization_id: season.organization_id,
        season_settings_id: season.id,
        name: DEFAULT_PROGRAM_NAME,
        is_default: true,
        copied_from_program_id: null,
        created_at: season.created_at ?? new Date(0).toISOString(),
        updated_at: season.created_at ?? new Date(0).toISOString(),
      });
    }
  }
  for (const division of divisions) {
    const program = division.program_id
      ? db.programs.find((p) => same(p.id, division.program_id))
      : null;
    if (program && same(program.season_settings_id, division.season_settings_id)) continue;
    const fallback = db.programs.find(
      (p) => same(p.season_settings_id, division.season_settings_id) && p.is_default
    );
    if (fallback) division.program_id = fallback.id;
  }
  return db;
}

/** The default program of a season, or undefined when the season is unknown. */
export function defaultProgramOf(db, seasonId) {
  return (db.programs || []).find((p) => same(p.season_settings_id, seasonId) && p.is_default);
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

const notAdmin = (what) =>
  fail('42501', `Access denied: caller is not an admin of the ${what}'s organization`);

function seasonOf(db, id) {
  return (db.season_settings || []).find((s) => same(s.id, id));
}

/**
 * @param {any} db - the mock database; mutated in place
 * @param {string} name
 * @param {Record<string, any>} params
 * @param {{ currentUserId: string|null, isOrgAdmin: (orgId: string) => boolean,
 *   now?: Date, newId?: () => string, markDeleted?: (db: any, table: string, keys: string[]) => void }} ctx
 * @returns {{ data: any, error: any } | null} null when `name` is not one of these RPCs
 */
export function handleProgramRpc(db, name, params, ctx) {
  if (!PROGRAM_RPCS.includes(name)) return null;
  const p = params || {};
  const c = {
    ...ctx,
    newId: ctx.newId ?? (() => globalThis.crypto.randomUUID()),
    markDeleted: ctx.markDeleted ?? (() => {}),
  };
  normalizePrograms(db);
  if (!c.currentUserId) return fail('42501', 'authenticated user is required');

  if (name === 'admin_upsert_program') {
    if (!p.p_season_id) return fail('23502', 'p_season_id is required');
    const season = seasonOf(db, p.p_season_id);
    if (!season || !c.isOrgAdmin(season.organization_id)) return notAdmin('season');
    if (season.status === 'completed') {
      return fail(
        '22023',
        `Season ${season.id} is completed and its programs cannot be changed`,
        'season_completed'
      );
    }
    const text = String(p.p_name ?? '').trim();
    if (text.length < 1 || text.length > 80) {
      return fail('22023', 'a program name must be 1 to 80 characters');
    }
    const taken = (exceptId) =>
      db.programs.some(
        (q) =>
          same(q.season_settings_id, season.id) &&
          nameKey(q.name) === nameKey(text) &&
          !same(q.id, exceptId)
      );
    if (!p.p_id) {
      if (taken(null))
        return fail('23505', `a program named "${text}" already exists in this season`);
      const row = {
        id: c.newId(),
        organization_id: season.organization_id,
        season_settings_id: season.id,
        name: text,
        is_default: false,
        copied_from_program_id: null,
        created_at: (c.now ?? new Date()).toISOString(),
        updated_at: (c.now ?? new Date()).toISOString(),
      };
      db.programs.push(row);
      audit(db, c, season.organization_id, 'program.upserted', 'program', row.id, {
        operation: 'created',
        season_settings_id: season.id,
        old_name: null,
        new_name: text,
      });
      return {
        data: {
          id: row.id,
          season_settings_id: season.id,
          name: text,
          is_default: false,
          changed: true,
        },
        error: null,
      };
    }
    const row = db.programs.find((q) => same(q.id, p.p_id));
    if (!row || !same(row.season_settings_id, season.id)) {
      return fail('23503', `program ${p.p_id} is not a program of season ${season.id}`);
    }
    if (text === row.name) {
      return {
        data: {
          id: row.id,
          season_settings_id: row.season_settings_id,
          name: row.name,
          is_default: row.is_default,
          changed: false,
        },
        error: null,
      };
    }
    if (row.is_default) {
      return fail('22023', 'the default program cannot be renamed', 'default_program');
    }
    if (taken(row.id))
      return fail('23505', `a program named "${text}" already exists in this season`);
    const oldName = row.name;
    row.name = text;
    row.updated_at = (c.now ?? new Date()).toISOString();
    audit(db, c, season.organization_id, 'program.upserted', 'program', row.id, {
      operation: 'updated',
      season_settings_id: season.id,
      old_name: oldName,
      new_name: text,
    });
    return {
      data: {
        id: row.id,
        season_settings_id: season.id,
        name: text,
        is_default: false,
        changed: true,
      },
      error: null,
    };
  }

  if (name === 'admin_set_division_program') {
    if (!p.p_division_id) return fail('23502', 'p_division_id is required');
    const division = (db.divisions || []).find((d) => same(d.id, p.p_division_id));
    if (!division || !c.isOrgAdmin(division.organization_id)) return notAdmin('division');
    const season = seasonOf(db, division.season_settings_id);
    if (season?.status === 'completed') {
      return fail(
        '22023',
        `Season ${season.id} is completed and its divisions cannot be moved`,
        'season_completed'
      );
    }
    const target = p.p_program_id
      ? db.programs.find(
          (q) =>
            same(q.id, p.p_program_id) && same(q.season_settings_id, division.season_settings_id)
        )
      : defaultProgramOf(db, division.season_settings_id);
    if (!target) {
      return fail(
        '23503',
        p.p_program_id
          ? `program ${p.p_program_id} is not a program of the division's season`
          : `season ${division.season_settings_id} has no default program`
      );
    }
    const from = db.programs.find((q) => same(q.id, division.program_id));
    if (from && same(from.id, target.id)) {
      return {
        data: { division_id: division.id, program_id: target.id, changed: false },
        error: null,
      };
    }
    division.program_id = target.id;
    division.updated_at = (c.now ?? new Date()).toISOString();
    audit(db, c, division.organization_id, 'division.program_changed', 'division', division.id, {
      season_settings_id: division.season_settings_id,
      division_name: division.name,
      from_program_id: from?.id ?? null,
      from_program_name: from?.name ?? null,
      to_program_id: target.id,
      to_program_name: target.name,
    });
    return {
      data: { division_id: division.id, program_id: target.id, changed: true },
      error: null,
    };
  }

  if (name === 'admin_delete_program') {
    if (!p.p_program_id) return fail('23502', 'p_program_id is required');
    const row = db.programs.find((q) => same(q.id, p.p_program_id));
    if (!row || !c.isOrgAdmin(row.organization_id)) return notAdmin('program');
    const season = seasonOf(db, row.season_settings_id);
    if (season?.status === 'completed') {
      return fail(
        '22023',
        `Season ${season.id} is completed and its programs cannot be changed`,
        'season_completed'
      );
    }
    if (row.is_default) {
      return fail('22023', 'the default program cannot be deleted', 'default_program');
    }
    const fallback = defaultProgramOf(db, row.season_settings_id);
    const moved = (db.divisions || [])
      .filter((d) => same(d.program_id, row.id))
      .sort(
        (a, b) =>
          String(a.name).localeCompare(String(b.name)) || String(a.id).localeCompare(String(b.id))
      );
    moved.forEach((d) => {
      d.program_id = fallback.id;
    });
    db.programs = db.programs.filter((q) => !same(q.id, row.id));
    c.markDeleted(db, 'programs', [String(row.id)]);
    const movedIds = moved.map((d) => d.id);
    audit(db, c, row.organization_id, 'program.deleted', 'program', row.id, {
      season_settings_id: row.season_settings_id,
      name: row.name,
      moved_division_ids: movedIds,
      moved_to_program_id: fallback.id,
    });
    return { data: { deleted_program_id: row.id, moved_division_ids: movedIds }, error: null };
  }

  // admin_merge_programs
  if (!p.p_source_id || !p.p_target_id) {
    return fail('23502', 'p_source_id and p_target_id are required');
  }
  const source = db.programs.find((q) => same(q.id, p.p_source_id));
  if (!source || !c.isOrgAdmin(source.organization_id)) return notAdmin('program');
  if (same(p.p_source_id, p.p_target_id)) {
    return fail('22023', 'a program cannot be merged into itself');
  }
  const target = db.programs.find((q) => same(q.id, p.p_target_id));
  if (!target || !same(target.season_settings_id, source.season_settings_id)) {
    return fail('22023', 'programs can be merged only within one season');
  }
  const season = seasonOf(db, source.season_settings_id);
  if (season?.status === 'completed') {
    return fail(
      '22023',
      `Season ${season.id} is completed and its programs cannot be changed`,
      'season_completed'
    );
  }
  if (source.is_default) {
    return fail('22023', 'the default program cannot be merged away', 'default_program');
  }
  const moved = (db.divisions || [])
    .filter((d) => same(d.program_id, source.id))
    .sort(
      (a, b) =>
        String(a.name).localeCompare(String(b.name)) || String(a.id).localeCompare(String(b.id))
    );
  moved.forEach((d) => {
    d.program_id = target.id;
  });
  db.programs = db.programs.filter((q) => !same(q.id, source.id));
  c.markDeleted(db, 'programs', [String(source.id)]);
  const movedIds = moved.map((d) => d.id);
  audit(db, c, source.organization_id, 'program.merged', 'program', target.id, {
    season_settings_id: source.season_settings_id,
    source_program_id: source.id,
    source_name: source.name,
    target_program_id: target.id,
    target_name: target.name,
    moved_division_ids: movedIds,
  });
  return { data: { target_program_id: target.id, moved_division_ids: movedIds }, error: null };
}
