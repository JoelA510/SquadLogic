/**
 * The import allowlist, browser side: which columns of a people import leave
 * the browser.
 *
 * Twin of `supabase/functions/_shared/import-allowlist.ts`, which applies the
 * same rule in `import-validation` before it stages a row; the finalizers apply
 * it a third time in SQL (migration 20261022010000). The browser filter alone
 * protects nothing from a caller who posts to the function directly.
 * `tests/importAllowlistParity.test.js` holds the two copies equal, and the key
 * lists equal to what the latest SQL finalizers read. Change both copies, and
 * the SQL, or none. Why an allowlist, and what each list holds: the Edge copy's
 * header, and docs/architecture/gotsport-import-contract.md.
 */
import { HEADER_ALIASES } from './telemetryUtils.js';

/** Keys `finalize_import_job` and `materialize_import_buddy_pairs` read, and team placement. */
export const PLAYER_IMPORT_KEYS = Object.freeze([
  // Identity and re-import matching
  'first_name',
  'last_name',
  'preferred_name',
  'nickname',
  'external_registration_id',
  'gotsport_id',
  'registration_id',
  'player_id',
  // Age and division (birthdate until a later PR stores natural age instead)
  'date_of_birth',
  'dob',
  'birth_year',
  'age group',
  'age_group',
  'age',
  'gender',
  'grade',
  'division_id',
  'division_name',
  'division',
  'group',
  'program',
  // Teaming signals
  'skill_tier',
  'skill_level',
  'years_played',
  'years played',
  'how many years has your player played in an organized soccer program?',
  'waitlist',
  'waitlisted',
  'play_up',
  'play up',
  'are you coaching so this player can play up a division?',
  'willing_to_coach',
  'coach_volunteer',
  "can you coach for this player's team?",
  // Buddy requests (finalize_import_job and materialize_import_buddy_pairs)
  'buddy_request',
  'buddy_id',
  'buddy_external_registration_id',
  'buddy_registration_id',
  'friend_request',
  'mutual_buddy_code',
  'buddy_code',
  'friend_code',
  // Team placement, kept for Phase B
  'team name',
  'team age',
  'team gender',
]);

/**
 * The columns a coach's full name is composed from when the export has none
 * (`import-rows`, D1): read before the finalizer, so kept although it never reads them.
 */
export const COACH_NAME_PARTS = Object.freeze(['first_name', 'last_name']);

/** Keys `finalize_coach_import_job` reads, less the phone, and the name parts. */
export const COACH_IMPORT_KEYS = Object.freeze([
  'full_name',
  'email',
  'status',
  'coach_status',
  'can_coach_multiple_teams',
  'multiple_teams',
  'multi_team',
  'certifications',
  'certification',
  ...COACH_NAME_PARTS,
]);

/** The import types the allowlist applies to, and the schema entity each declares fields for. */
export const ALLOWLIST_ENTITY_TYPES = Object.freeze({
  players: 'player',
  coaches: 'coach',
});

/** @type {Readonly<Record<string, readonly string[]>>} */
const KEYS_BY_TYPE = Object.freeze({
  players: PLAYER_IMPORT_KEYS,
  coaches: COACH_IMPORT_KEYS,
});

/**
 * A declared field's identity: what the schema builder stores for a field name
 * (lower case, trimmed, runs of whitespace as one underscore).
 * @param {unknown} key
 * @returns {string}
 */
export function declaredFieldKey(key) {
  if (key === null || key === undefined) return '';
  return String(key).trim().toLowerCase().replace(/\s+/g, '_');
}

/**
 * True when the import type is filtered by the allowlist (people, not fields).
 * @param {string} importType
 */
export function isAllowlistedImportType(importType) {
  return Object.prototype.hasOwnProperty.call(KEYS_BY_TYPE, importType);
}

/**
 * True when a canonical key is kept for the import type. A type the allowlist
 * does not cover keeps every key.
 * @param {string} importType
 * @param {string} canonicalKey
 * @param {Iterable<string>} [declaredFields]
 */
export function isAllowedImportKey(importType, canonicalKey, declaredFields = []) {
  const keys = KEYS_BY_TYPE[importType];
  if (!keys) return true;
  if (keys.includes(canonicalKey)) return true;
  const identity = declaredFieldKey(canonicalKey);
  if (!identity) return false;
  for (const field of declaredFields) {
    if (declaredFieldKey(field) === identity) return true;
  }
  return false;
}

/**
 * True when an import column is kept: its canonical key is allowed, or its
 * own identity is a declared field (a header that is also a global alias,
 * `Skill` -> `skill_tier`, still reaches a declared `skill`).
 * @param {string} importType
 * @param {string} header
 * @param {(header: string) => string} normalizeHeader
 * @param {Iterable<string>} [declaredFields]
 */
export function isAllowedImportHeader(importType, header, normalizeHeader, declaredFields = []) {
  const declared = [...declaredFields];
  if (isAllowedImportKey(importType, normalizeHeader(header), declared)) return true;
  const identity = declaredFieldKey(header);
  return identity !== '' && declared.some((field) => declaredFieldKey(field) === identity);
}

/**
 * The row with only its allowed columns, keyed and valued as given.
 * @param {string} importType
 * @param {Record<string, unknown>} row
 * @param {(header: string) => string} normalizeHeader
 * @param {Iterable<string>} [declaredFields]
 * @returns {Record<string, unknown>}
 */
export function keepAllowedColumns(importType, row, normalizeHeader, declaredFields = []) {
  if (!isAllowlistedImportType(importType)) return row;
  const declared = [...declaredFields];
  /** @type {Record<string, unknown>} */
  const kept = {};
  for (const [key, value] of Object.entries(row ?? {})) {
    if (isAllowedImportHeader(importType, key, normalizeHeader, declared)) kept[key] = value;
  }
  return kept;
}

/**
 * The normalized row with each declared field the import carries under its
 * declared identity, and with no key that is neither allowed nor declared.
 * When a header is both a declared field and an alias of a system field, the
 * system field keeps its own reading and the declared field gets a copy; the
 * copy never replaces a non-blank value. The Edge copy's comment says more.
 * @param {string} importType
 * @param {Record<string, string>} normalizedRow
 * @param {Record<string, unknown>} rawRow
 * @param {(header: string) => string} normalizeHeader
 * @param {Iterable<string>} [declaredFields]
 * @param {(value: unknown) => string} [clean]
 * @returns {Record<string, string>}
 */
export function withDeclaredColumns(
  importType,
  normalizedRow,
  rawRow,
  normalizeHeader,
  declaredFields = [],
  clean = (v) => (v == null ? '' : String(v))
) {
  if (!isAllowlistedImportType(importType)) return normalizedRow;
  const declared = new Set([...declaredFields].map(declaredFieldKey));
  /** @type {Record<string, string>} */
  const out = {};
  for (const [key, value] of Object.entries(normalizedRow)) {
    if (isAllowedImportKey(importType, key, declared)) out[key] = value;
  }
  for (const [header, value] of Object.entries(rawRow ?? {})) {
    const identity = declaredFieldKey(header);
    if (!declared.has(identity) || identity === normalizeHeader(header)) continue;
    const cleaned = clean(value);
    if (cleaned.trim() === '') continue;
    if (out[identity] === undefined || String(out[identity]).trim() === '') out[identity] = cleaned;
  }
  return out;
}

/**
 * The canonical key `import-validation` stages a header under: the alias map's
 * name for it, else the header lower-cased and trimmed. The browser's alias map
 * (`telemetryUtils.js`) agrees with the Edge Function's on every allowlisted
 * key (`tests/importAllowlistParity.test.js`).
 * @param {string} header
 * @returns {string}
 */
export function canonicalImportKey(header) {
  const lower = String(header ?? '')
    .toLowerCase()
    .trim();
  return HEADER_ALIASES[lower] ?? lower;
}

/**
 * Rows with only their allowed columns, judged by {@link canonicalImportKey}.
 * Other import types pass through untouched.
 * @param {string} importType
 * @param {Array<Record<string, unknown>>} rows
 * @param {Iterable<string>} [declaredFields] - the organization's declared fields for the entity
 * @returns {Array<Record<string, unknown>>}
 */
export function filterImportRows(importType, rows, declaredFields = []) {
  if (!Array.isArray(rows)) return [];
  if (!isAllowlistedImportType(importType)) return rows;
  const declared = [...declaredFields];
  return rows.map((row) => keepAllowedColumns(importType, row, canonicalImportKey, declared));
}

const TRUE_TEXT = new Set(['true', 't', 'yes', 'y', '1']);
const FALSE_TEXT = new Set(['false', 'f', 'no', 'n', '0']);

/**
 * The payload's entries that match a declared field, keyed by the declared
 * name and typed as declared; everything else dropped. The mock client's
 * stand-in for SQL `import_declared_attributes` (migration 20261022010000),
 * which the finalizers build `custom_attributes` from. A value that does not
 * parse as its declared type is dropped. Dates are read as `YYYY-MM-DD` or
 * `M/D/YYYY` only (the SQL also casts other spellings).
 * @param {Record<string, string> | null | undefined} schemaDefinition - `{ field: type }`
 * @param {Record<string, unknown> | null | undefined} payload
 * @returns {Record<string, unknown>}
 */
export function declaredAttributes(schemaDefinition, payload) {
  /** @type {Map<string, [string, string]>} */
  const declared = new Map();
  for (const [name, type] of Object.entries(schemaDefinition || {})) {
    declared.set(declaredFieldKey(name), [name, String(type)]);
  }
  /** @type {Record<string, unknown>} */
  const out = {};
  const keys = Object.keys(payload || {}).sort();
  for (const key of keys) {
    const field = declared.get(declaredFieldKey(key));
    const raw = /** @type {Record<string, unknown>} */ (payload)[key];
    if (!field || raw === null || raw === undefined || typeof raw === 'object') continue;
    const text = String(raw).trim();
    if (!text) continue;
    const [name, type] = field;
    if (type === 'number') {
      if (/^-?[0-9]+(\.[0-9]+)?$/.test(text)) out[name] = Number(text);
    } else if (type === 'boolean') {
      if (TRUE_TEXT.has(text.toLowerCase())) out[name] = true;
      else if (FALSE_TEXT.has(text.toLowerCase())) out[name] = false;
    } else if (type === 'date') {
      const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
      const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
      const ymd = iso
        ? [iso[1], iso[2], iso[3]]
        : us
          ? [us[3], us[1].padStart(2, '0'), us[2].padStart(2, '0')]
          : null;
      if (ymd) {
        const date = new Date(`${ymd[0]}-${ymd[1]}-${ymd[2]}T00:00:00Z`);
        if (!Number.isNaN(date.getTime()) && date.toISOString().startsWith(ymd.join('-'))) {
          out[name] = ymd.join('-');
        }
      }
    } else {
      out[name] = text;
    }
  }
  return out;
}

/**
 * The fields the organization declared for the import's entity, read for this
 * import (not from a context that loads asynchronously and stays empty on an
 * error): an empty list would silently drop the organization's own columns.
 * Throws a message an admin can act on when the read fails, as
 * import-validation refuses rather than guess.
 * @param {{ supabase: any, organizationId: string, importType: string }} args
 * @returns {Promise<string[]>}
 */
export async function fetchDeclaredImportFields({ supabase, organizationId, importType }) {
  const entityType = ALLOWLIST_ENTITY_TYPES[importType];
  if (!entityType) return [];
  const { data, error } = await supabase
    .from('organization_schemas')
    .select('schema_definition')
    .eq('organization_id', organizationId)
    .eq('entity_type', entityType)
    .maybeSingle();
  if (error) {
    throw new Error(
      `Could not read the organization's custom ${entityType} fields, so the import cannot tell which columns to keep (${error.message || 'unknown error'}). Try again.`
    );
  }
  const definition = data?.schema_definition;
  return definition && typeof definition === 'object' && !Array.isArray(definition)
    ? Object.keys(definition)
    : [];
}

/** The keys the player import writes into custom_attributes itself. */
export const PLAYER_IMPORT_OWN_ATTRIBUTES = Object.freeze([
  'play_up',
  'coaching_answer',
  'team_name',
  'team_age',
  'team_gender',
]);

/**
 * A player's custom attributes as the allowlist keeps them: the declared
 * fields and the import's own keys. The mock client's stand-in for SQL
 * `import_kept_player_attributes` (migration 20261022010000).
 * @param {Record<string, string> | null | undefined} schemaDefinition
 * @param {Record<string, unknown> | null | undefined} attributes
 * @returns {Record<string, unknown>}
 */
export function keptPlayerAttributes(schemaDefinition, attributes) {
  /** @type {Record<string, unknown>} */
  const own = {};
  for (const key of PLAYER_IMPORT_OWN_ATTRIBUTES) {
    const value = attributes?.[key];
    if (value !== undefined && value !== null) own[key] = value;
  }
  return { ...declaredAttributes(schemaDefinition, attributes), ...own };
}

/**
 * The first of `keys` the payload holds with a non-blank value, trimmed; else
 * null. The JavaScript form of SQL `import_payload_text`.
 * @param {Record<string, unknown> | null | undefined} payload
 * @param {string[]} keys
 * @returns {string | null}
 */
export function importPayloadText(payload, keys) {
  for (const key of keys) {
    const value = payload?.[key];
    if (value === undefined || value === null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return null;
}
