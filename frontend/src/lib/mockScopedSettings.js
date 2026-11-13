/**
 * Mock arms for the settings cascade of migration `20261124010000_settings_scope.sql` (F11-4a; plan
 * `docs/changes/2026-11-13-settings-scope.md`): `admin_set_scoped_setting`, `admin_set_division_practice_settings`,
 * the resolver the standings read (`scoped_setting_value`, through core's `resolveScopedSetting`), the rollover's copy
 * and a deleted program's rows.
 *
 * **Refusals included, with the SQL's codes** (LESSONS_LEARNED #13):
 *   - 42501 no session, a missing scope row, another organization's row, a caller who is not an admin of the
 *     organization the row belongs to (one refusal for all);
 *   - 23502 a missing scope id or division id;
 *   - 22023 a scope that is not one of the three (`scope_invalid`), an unknown key (`unknown_setting`), a value of the
 *     wrong type or a JSON null (`setting_value_invalid`), the default program (`default_program`), a program or
 *     division of a completed season (`season_completed`);
 *   - 23514 practices a week outside 0-7, a length outside 15-240 minutes.
 * Each change appends one `settings.updated` audit row with the SQL's metadata; an unchanged write and a refusal append
 * none. tests/mockScopedSettings.test.js holds these to the pgTAP file's cases.
 *
 * Pure over `db` so a test can drive it directly; `mockSupabaseClient.js` wires it into `rpc()`.
 */

import {
  isValidScopedValue,
  resolveScopedSetting,
  SCOPED_SETTING_KEYS,
  scopedLevelsFor,
} from '@squadlogic/core/scopedSettings.js';

export const SCOPED_SETTING_RPCS = Object.freeze([
  'admin_set_scoped_setting',
  'admin_set_division_practice_settings',
]);

const SCOPES = ['organization', 'program', 'division'];

const fail = (code, message, detail) => ({
  data: null,
  error: { code, message, ...(detail ? { details: detail } : {}) },
});
const same = (a, b) => a != null && b != null && String(a) === String(b);
const present = (value) => value !== undefined && value !== null;

function audit(db, ctx, orgId, resourceType, resourceId, metadata) {
  db.audit_log = db.audit_log || [];
  db.audit_log.push({
    id: ctx.newId(),
    organization_id: orgId,
    user_id: ctx.currentUserId,
    action: 'settings.updated',
    resource_type: resourceType,
    resource_id: resourceId,
    metadata,
    created_at: (ctx.now ?? new Date()).toISOString(),
  });
}

/** A text set stored as the SQL stores it: sorted, without repeats. */
const canonical = (key, value) =>
  SCOPED_SETTING_KEYS[key].type === 'boolean' ? value : [...value].sort();

/**
 * A division's value of a scoped setting, as `scoped_setting_value` gives it: its own row, else its (non-default)
 * program's, else its organization's, else the registered default. An unknown division gives the default.
 * @param {any} db
 * @param {string} divisionId
 * @param {string} key
 */
export function scopedValueForDivision(db, divisionId, key) {
  const division = (db.divisions || []).find((d) => same(d.id, divisionId));
  if (!division) return resolveScopedSetting({}, key).value;
  const program = (db.programs || []).find((p) => same(p.id, division.program_id));
  const levels = scopedLevelsFor(
    db.scoped_settings || [],
    {
      organizationId: division.organization_id,
      programId: program?.id ?? null,
      programIsDefault: !program || Boolean(program.is_default),
      divisionId: division.id,
    },
    key
  );
  return resolveScopedSetting(levels, key).value;
}

/**
 * The rollover's copy (`admin_create_season_from`, 20261124010000): each program's and each division's rows go to their
 * copies (a program by `copied_from_program_id`, a division by name). Returns how many were copied.
 * @param {any} db
 * @param {string} sourceSeasonId
 * @param {string} newSeasonId
 * @param {{ newId: () => string, currentUserId?: string|null }} ctx
 */
export function copyScopedSettingsForRollover(db, sourceSeasonId, newSeasonId, ctx) {
  const rows = db.scoped_settings || [];
  const copies = [];
  for (const row of rows) {
    if (present(row.program_id)) {
      const source = (db.programs || []).find((p) => same(p.id, row.program_id));
      if (!source || !same(source.season_settings_id, sourceSeasonId)) continue;
      const copy = (db.programs || []).find(
        (p) => same(p.season_settings_id, newSeasonId) && same(p.copied_from_program_id, source.id)
      );
      if (copy)
        copies.push({
          ...row,
          id: ctx.newId(),
          program_id: copy.id,
          updated_by: ctx.currentUserId ?? null,
        });
    } else if (present(row.division_id)) {
      const source = (db.divisions || []).find((d) => same(d.id, row.division_id));
      if (!source || !same(source.season_settings_id, sourceSeasonId)) continue;
      const copy = (db.divisions || []).find(
        (d) => same(d.season_settings_id, newSeasonId) && d.name === source.name
      );
      if (copy)
        copies.push({
          ...row,
          id: ctx.newId(),
          division_id: copy.id,
          updated_by: ctx.currentUserId ?? null,
        });
    }
  }
  db.scoped_settings = [...rows, ...copies];
  return copies.length;
}

/**
 * A deleted program's own rows go with it (the foreign key's ON DELETE CASCADE; decision S8).
 * @param {any} db
 * @param {string} programId
 */
export function dropProgramScopedSettings(db, programId) {
  if (!db.scoped_settings) return;
  db.scoped_settings = db.scoped_settings.filter((row) => !same(row.program_id, programId));
}

/**
 * @param {any} db
 * @param {string} name
 * @param {Record<string, any>} params
 * @param {{ currentUserId: string|null, isOrgAdmin: (orgId: string) => boolean, newId?: () => string, now?: Date }} ctx
 */
export function handleScopedSettingRpc(db, name, params, ctx) {
  if (!SCOPED_SETTING_RPCS.includes(name)) return null;
  const p = params || {};
  const c = { ...ctx, newId: ctx.newId ?? (() => globalThis.crypto.randomUUID()) };
  if (!c.currentUserId) return fail('42501', 'authenticated user is required');
  if (name === 'admin_set_scoped_setting') return setScopedSetting(db, p, c);
  return setPracticeSettings(db, p, c);
}

function setScopedSetting(db, p, c) {
  const scope = p.p_scope;
  if (!SCOPES.includes(scope)) {
    return fail(
      '22023',
      `a setting is set for an organization, a program or a division, not ${scope ?? 'nothing'}`,
      'scope_invalid'
    );
  }
  if (!p.p_scope_id) return fail('23502', 'p_scope_id is required');
  let org = null;
  let season = null;
  let label = null;
  let isDefault = false;
  if (scope === 'organization') {
    const row = (db.organizations || []).find((o) => same(o.id, p.p_scope_id));
    org = row?.id ?? null;
    label = row?.name ?? null;
  } else if (scope === 'program') {
    const row = (db.programs || []).find((q) => same(q.id, p.p_scope_id));
    org = row?.organization_id ?? null;
    season = row?.season_settings_id ?? null;
    label = row?.name ?? null;
    isDefault = Boolean(row?.is_default);
  } else {
    const row = (db.divisions || []).find((d) => same(d.id, p.p_scope_id));
    org = row?.organization_id ?? null;
    season = row?.season_settings_id ?? null;
    label = row?.name ?? null;
  }
  if (!org || !c.isOrgAdmin(org)) {
    return fail('42501', `Access denied: caller is not an admin of the ${scope}'s organization`);
  }
  const key = p.p_key;
  if (!Object.hasOwn(SCOPED_SETTING_KEYS, key ?? '')) {
    return fail('22023', `unknown setting ${key ?? 'NULL'}`, 'unknown_setting');
  }
  const unset = p.p_value === undefined || p.p_value === null;
  if (!unset && !isValidScopedValue(key, p.p_value)) {
    return fail('22023', `the setting ${key} takes another kind of value`, 'setting_value_invalid');
  }
  if (isDefault) {
    return fail(
      '22023',
      'the default program ("No program") holds no settings: its divisions follow the organization',
      'default_program'
    );
  }
  if (season) {
    const status = (db.season_settings || []).find((s) => same(s.id, season))?.status;
    if (status === 'completed') {
      return fail(
        '22023',
        `Season ${season} is completed and its settings cannot be changed`,
        'season_completed'
      );
    }
  }
  const value = unset ? null : canonical(key, p.p_value);
  db.scoped_settings = db.scoped_settings || [];
  const matches = (row) =>
    row.key === key &&
    (scope === 'organization'
      ? same(row.organization_id, org) && !present(row.program_id) && !present(row.division_id)
      : scope === 'program'
        ? same(row.program_id, p.p_scope_id)
        : same(row.division_id, p.p_scope_id));
  const existing = db.scoped_settings.find(matches);
  const old = existing ? existing.value : null;
  const result = (changed) => ({
    data: { changed, scope, scope_id: p.p_scope_id, key, previous: old, current: value },
    error: null,
  });
  if (JSON.stringify(old) === JSON.stringify(value)) return result(false);
  if (value === null) {
    db.scoped_settings = db.scoped_settings.filter((row) => row !== existing);
  } else if (!existing) {
    db.scoped_settings.push({
      id: c.newId(),
      organization_id: org,
      program_id: scope === 'program' ? p.p_scope_id : null,
      division_id: scope === 'division' ? p.p_scope_id : null,
      key,
      value,
      updated_at: (c.now ?? new Date()).toISOString(),
      updated_by: c.currentUserId,
    });
  } else {
    existing.value = value;
    existing.updated_by = c.currentUserId;
    existing.updated_at = (c.now ?? new Date()).toISOString();
  }
  audit(db, c, org, 'scoped_setting', p.p_scope_id, {
    setting: 'scoped_setting',
    field: key,
    key,
    scope,
    scope_id: p.p_scope_id,
    scope_name: label,
    season_settings_id: season,
    old,
    new: value,
  });
  return result(true);
}

function setPracticeSettings(db, p, c) {
  if (!p.p_division_id) return fail('23502', 'p_division_id is required');
  const division = (db.divisions || []).find((d) => same(d.id, p.p_division_id));
  if (!division || !c.isOrgAdmin(division.organization_id)) {
    return fail('42501', "Access denied: caller is not an admin of the division's organization");
  }
  const status = (db.season_settings || []).find((s) =>
    same(s.id, division.season_settings_id)
  )?.status;
  if (status === 'completed') {
    return fail(
      '22023',
      `Season ${division.season_settings_id} is completed and its division rules cannot be changed`,
      'season_completed'
    );
  }
  const before = {
    practices_per_week: division.practices_per_week ?? 1,
    practice_minutes: division.practice_minutes ?? null,
  };
  const ppw = p.p_practices_per_week ?? before.practices_per_week;
  const minutes =
    p.p_practice_minutes === undefined || p.p_practice_minutes === null
      ? before.practice_minutes
      : p.p_practice_minutes === 0
        ? null
        : p.p_practice_minutes;
  if (!Number.isInteger(ppw) || ppw < 0 || ppw > 7) {
    return fail('23514', `practices per week must be from 0 to 7, not ${ppw}`);
  }
  if (minutes !== null && (!Number.isInteger(minutes) || minutes < 15 || minutes > 240)) {
    return fail(
      '23514',
      `a practice length must be from 15 to 240 minutes (or 0 for any slot length), not ${minutes}`
    );
  }
  if (ppw === before.practices_per_week && minutes === before.practice_minutes) {
    return { data: { ...division, changed: false }, error: null };
  }
  division.practices_per_week = ppw;
  division.practice_minutes = minutes;
  division.updated_at = (c.now ?? new Date()).toISOString();
  audit(db, c, division.organization_id, 'division', division.id, {
    setting: 'division_team_generation_rules',
    division_id: division.id,
    season_settings_id: division.season_settings_id,
    name: division.name,
    previous: before,
    current: { practices_per_week: ppw, practice_minutes: minutes },
  });
  return { data: { ...division, changed: true }, error: null };
}
