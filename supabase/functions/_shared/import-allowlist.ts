/**
 * The import allowlist, server side: which columns of a people import are kept.
 *
 * A registration export carries whatever columns the league's registration
 * platform was set up with, and SquadLogic does not control them. A denylist
 * (`sensitive-headers.ts`) cannot keep up: a coach export's guardian
 * addresses, phones and the child's birth date matched no pattern and were
 * stored (plan docs/changes/2026-10-22-admin-focus.md, R0). So a people import
 * keeps a column only when its canonical key (the header after the import's
 * header normalization) is:
 *
 *   (a) a key the finalizer for that import type reads, less every guardian,
 *       parent, contact, email, phone and payment key for players and the phone
 *       key for coaches (the coach's email is how they sign in);
 *   (b) for players, a team-placement column (`team name`, `team age`,
 *       `team gender`), kept for Phase B's "keep teams formed outside
 *       SquadLogic"; or
 *   (c) a field the organization declared in `organization_schemas` for that
 *       entity (the fluid-schemas feature), matched by its field identity.
 *
 * Everything else is dropped before anything is validated, staged or returned.
 * The finalizers apply the same rule again in SQL (migration 20261022010000),
 * because the staging tables can be written without this function.
 *
 * Twin of `frontend/src/utils/importAllowlist.js`, which filters the same
 * columns in the browser before upload; `tests/importAllowlistParity.test.js`
 * holds the two equal and holds the key lists equal to what the latest SQL
 * finalizers read. Change both copies, and the SQL, or none.
 */

/** Keys `finalize_import_job` and `materialize_import_buddy_pairs` read, and team placement. */
export const PLAYER_IMPORT_KEYS: readonly string[] = Object.freeze([
  // Identity and re-import matching
  'first_name',
  'last_name',
  'preferred_name',
  'nickname',
  'external_registration_id',
  'gotsport_id',
  'registration_id',
  'player_id',
  // Age and division. `natural_age` is set by import-validation (the age group, else one
  // computed from the birth date), never read from the file; the birth keys are below.
  'natural_age',
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
 * The birth keys a player import reads in transit (admin-focus plan R5): import-validation
 * computes the natural age from them and returns them to the browser, which keeps the file's
 * birth dates for teaming during the import session; nothing stages or stores them
 * (`withoutBirthKeys`). Kept by the filter, so they are not in `PLAYER_IMPORT_KEYS`, the keys
 * the SQL reads.
 */
export const PLAYER_BIRTH_KEYS: readonly string[] = Object.freeze([
  'date_of_birth',
  'dob',
  'birth_year',
]);

/**
 * The columns a coach's full name is composed from when the export has none
 * (`import-rows`, D1): read before the finalizer, so kept although it never reads them.
 */
export const COACH_NAME_PARTS: readonly string[] = Object.freeze(['first_name', 'last_name']);

/** Keys `finalize_coach_import_job` reads, less the phone, and the name parts. */
export const COACH_IMPORT_KEYS: readonly string[] = Object.freeze([
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
export const ALLOWLIST_ENTITY_TYPES: Readonly<Record<string, string>> = Object.freeze({
  players: 'player',
  coaches: 'coach',
});

const KEYS_BY_TYPE: Readonly<Record<string, readonly string[]>> = Object.freeze({
  players: PLAYER_IMPORT_KEYS,
  coaches: COACH_IMPORT_KEYS,
});

/**
 * A declared field's identity: what the schema builder stores for a field name
 * (lower case, trimmed, runs of whitespace as one underscore). An import column
 * `Jersey Size` matches a declared `jersey_size`.
 */
export function declaredFieldKey(key: unknown): string {
  if (key === null || key === undefined) return '';
  return String(key).trim().toLowerCase().replace(/\s+/g, '_');
}

/** True when the import type is filtered by the allowlist (people, not fields). */
export function isAllowlistedImportType(importType: string): boolean {
  return Object.prototype.hasOwnProperty.call(KEYS_BY_TYPE, importType);
}

/**
 * True when a canonical key is kept for the import type. A type the allowlist
 * does not cover keeps every key.
 */
export function isAllowedImportKey(
  importType: string,
  canonicalKey: string,
  declaredFields: Iterable<string> = []
): boolean {
  const keys = KEYS_BY_TYPE[importType];
  if (!keys) return true;
  if (keys.includes(canonicalKey)) return true;
  if (importType === 'players' && PLAYER_BIRTH_KEYS.includes(canonicalKey)) return true;
  const identity = declaredFieldKey(canonicalKey);
  if (!identity) return false;
  for (const field of declaredFields) {
    if (declaredFieldKey(field) === identity) return true;
  }
  return false;
}

/**
 * True when an import column is kept: its canonical key (`normalizeHeader`)
 * is allowed, or its own identity (lower case, whitespace as `_`) is a
 * declared field. The second arm matters when the header is also a global
 * alias: `Skill` canonicalizes to `skill_tier`, and an organization that
 * declared `skill` still gets the column.
 */
export function isAllowedImportHeader(
  importType: string,
  header: string,
  normalizeHeader: (header: string) => string,
  declaredFields: Iterable<string> = []
): boolean {
  const declared = [...declaredFields];
  if (isAllowedImportKey(importType, normalizeHeader(header), declared)) return true;
  const identity = declaredFieldKey(header);
  return identity !== '' && declared.some((field) => declaredFieldKey(field) === identity);
}

/**
 * The row with only its allowed columns, keyed and valued as given. Each
 * header is judged by `isAllowedImportHeader`, so the caller passes the same
 * header normalization it stages with.
 */
export function keepAllowedColumns(
  importType: string,
  row: Record<string, unknown>,
  normalizeHeader: (header: string) => string,
  declaredFields: Iterable<string> = []
): Record<string, unknown> {
  if (!isAllowlistedImportType(importType)) return row;
  const declared = [...declaredFields];
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (isAllowedImportHeader(importType, key, normalizeHeader, declared)) kept[key] = value;
  }
  return kept;
}

/**
 * The normalized row with each declared field the import carries under its
 * declared identity, and with no key that is neither allowed nor declared.
 *
 * **When a header is both a declared field and an alias of a system field**
 * (`Skill` with `skill` declared: the alias gives `skill_tier`), the system
 * field keeps its own reading -- the canonical key, as it always had -- and
 * the declared field gets a copy under its identity (`skill`), which the
 * finalizers store in `custom_attributes`. The copy never replaces a non-blank
 * value already under that key, so it cannot displace another column's
 * reading. The canonical key itself stays only when it is allowed or declared
 * (`skill_tier` stays for players, and goes for coaches).
 */
export function withDeclaredColumns(
  importType: string,
  normalizedRow: Record<string, string>,
  rawRow: Record<string, unknown>,
  normalizeHeader: (header: string) => string,
  declaredFields: Iterable<string> = [],
  clean: (value: unknown) => string = (v) => (v == null ? '' : String(v))
): Record<string, string> {
  if (!isAllowlistedImportType(importType)) return normalizedRow;
  const declared = new Set([...declaredFields].map(declaredFieldKey));
  const out: Record<string, string> = {};
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
 * The row without a birth key, judged by its canonical key (`normalizeHeader`):
 * what import-validation stages, raw and normalized (admin-focus plan R5). A
 * declared field whose identity is a birth key goes too. Other import types,
 * and rows with no birth key, are returned as given.
 */
export function withoutBirthKeys<T>(
  importType: string,
  row: Record<string, T>,
  normalizeHeader: (header: string) => string
): Record<string, T> {
  if (importType !== 'players' || !row) return row;
  const out: Record<string, T> = {};
  for (const [key, value] of Object.entries(row)) {
    if (PLAYER_BIRTH_KEYS.includes(normalizeHeader(key))) continue;
    if (PLAYER_BIRTH_KEYS.includes(declaredFieldKey(key))) continue;
    out[key] = value;
  }
  return out;
}
