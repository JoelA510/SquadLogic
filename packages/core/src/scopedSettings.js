/**
 * Scoped settings: one setting at organization, program and division level, the most specific winning.
 *
 * Plan of record: `docs/changes/2026-11-13-settings-scope.md` (F11-4). The database is the source of truth: the
 * migration `20261124010000_settings_scope.sql` holds the registry (`scoped_setting_keys`), the rows
 * (`scoped_settings`) and THE resolver, `scoped_setting_value(division, key)`, which the server enforces with (the
 * standings view's `standings_counts_outside`). This module is its twin, for what a page shows ("applies now, from the
 * program Juniors") and for the mock client; `tests/scopedSettingsParity.test.js` runs it over the case table of
 * `supabase/tests/scoped_settings.sql` and holds `SCOPED_SETTING_KEYS` to the migrations' registry rows.
 *
 * The rule: a level with no row inherits; the first present of division, program (never the default program, "No
 * program"), organization wins; with none, the key's registered default. An explicit `false` (or `[]` for a set) is a
 * value and beats an inherited one.
 *
 * Pure and framework-free: no React, no I/O.
 *
 * @module scopedSettings
 */

/**
 * The registry's mirror: key -> { type, allowed, defaultValue, label }. One row per `INSERT INTO
 * public.scoped_setting_keys` across the migrations (held by tests/scopedSettingsParity.test.js).
 */
export const SCOPED_SETTING_KEYS = Object.freeze({
  standings_count_outside_results: Object.freeze({
    type: 'boolean',
    allowed: null,
    defaultValue: false,
    label: 'Count results against outside clubs',
  }),
});

/**
 * The levels, most specific first: the order the resolver asks them in.
 * @type {ReadonlyArray<'division' | 'program' | 'organization'>}
 */
export const SCOPED_SETTING_LEVELS = Object.freeze(['division', 'program', 'organization']);

/** The key the standings policy reads (`standings_counts_outside`). */
export const STANDINGS_COUNT_OUTSIDE_KEY = 'standings_count_outside_results';

const present = (value) => value !== undefined && value !== null;

/**
 * The registry entry of a key; an unknown key throws, as the SQL refuses it (22023, unknown_setting).
 * @param {string} key
 */
export function scopedSettingKey(key) {
  const entry = Object.hasOwn(SCOPED_SETTING_KEYS, key) ? SCOPED_SETTING_KEYS[key] : null;
  if (!entry) throw new Error(`unknown setting ${key}`);
  return entry;
}

/**
 * Whether a value may be stored for a key, as `admin_set_scoped_setting` checks it: a boolean for a boolean key; for a
 * text set, an array of distinct strings each in the key's allowed list. `null` (inherit) is not a value.
 * @param {string} key
 * @param {unknown} value
 */
export function isValidScopedValue(key, value) {
  const entry = scopedSettingKey(key);
  if (entry.type === 'boolean') return typeof value === 'boolean';
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === 'string' && entry.allowed.includes(item)) &&
    new Set(value).size === value.length
  );
}

/**
 * Code point order, the order of PostgreSQL's `COLLATE "C"` over UTF-8 text. JavaScript's default sort compares UTF-16
 * code units, which puts an astral character (a surrogate pair, D800-DFFF) before a BMP one above U+DFFF (U+E000 to
 * U+FFFF): the two orders differ there, so this compares by code point.
 * @param {string} a
 * @param {string} b
 */
export function compareCodePoints(a, b) {
  const x = Array.from(a);
  const y = Array.from(b);
  for (let i = 0; i < Math.min(x.length, y.length); i += 1) {
    const d =
      /** @type {number} */ (x[i].codePointAt(0)) - /** @type {number} */ (y[i].codePointAt(0));
    if (d !== 0) return d;
  }
  return x.length - y.length;
}

/**
 * A value as `admin_set_scoped_setting` stores it: a boolean as it is; a text set in code point order (its one
 * spelling, so "unchanged" is an equality on both sides).
 * @param {string} key
 * @param {unknown} value
 */
export function canonicalScopedValue(key, value) {
  const entry = scopedSettingKey(key);
  if (entry.type === 'boolean' || !Array.isArray(value)) return value;
  return [...value].sort(compareCodePoints);
}

/**
 * A division's value of a scoped setting from the three levels' own values (`undefined` or `null` = no row).
 *
 * @param {{ organization?: unknown, program?: unknown, division?: unknown }} levels
 * @param {string} key
 * @returns {{ value: unknown, source: 'division' | 'program' | 'organization' | 'default' }}
 */
export function resolveScopedSetting(levels, key) {
  const entry = scopedSettingKey(key);
  for (const level of SCOPED_SETTING_LEVELS) {
    if (present(levels?.[level])) return { value: levels[level], source: level };
  }
  return { value: entry.defaultValue, source: 'default' };
}

/**
 * The three levels' own values for a division, read off `scoped_settings` rows (as the table holds them: snake_case,
 * `value` the stored JSON). A division in the default program has no program level.
 *
 * @param {Array<Record<string, any>>} rows
 * @param {{ organizationId: string, programId?: string | null, programIsDefault?: boolean, divisionId: string }} scope
 * @param {string} key
 */
export function scopedLevelsFor(rows, scope, key) {
  const same = (a, b) => present(a) && present(b) && String(a) === String(b);
  const ofKey = (rows || []).filter((row) => row?.key === key);
  const division = ofKey.find((row) => same(row.division_id, scope.divisionId));
  const program =
    scope.programIsDefault || !present(scope.programId)
      ? undefined
      : ofKey.find((row) => same(row.program_id, scope.programId));
  const organization = ofKey.find(
    (row) =>
      same(row.organization_id, scope.organizationId) &&
      !present(row.program_id) &&
      !present(row.division_id)
  );
  return {
    division: division?.value,
    program: program?.value,
    organization: organization?.value,
  };
}
