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

/** Keys `finalize_coach_import_job` reads, less the phone. */
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
  const identity = declaredFieldKey(canonicalKey);
  if (!identity) return false;
  for (const field of declaredFields) {
    if (declaredFieldKey(field) === identity) return true;
  }
  return false;
}

/**
 * The row with only its allowed columns, keyed and valued as given. Each
 * header is judged by its canonical key, `normalizeHeader(header)`, so the
 * caller passes the same header normalization it stages with.
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
    if (isAllowedImportKey(importType, normalizeHeader(key), declared)) kept[key] = value;
  }
  return kept;
}
