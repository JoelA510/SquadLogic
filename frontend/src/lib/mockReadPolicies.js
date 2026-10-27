/**
 * The SELECT policies of migration `20261021020000_restrict_people_reads.sql`,
 * as `20261024010000_remove_guardian_view_and_roles.sql` (R3) left them,
 * applied to the mock client's generic `.from(table)` reads, so a page that
 * still reads a restricted table directly fails in mock mode (and in the E2E
 * suite) the way it would against the database.
 *
 * Mirrored, per table, for the signed-in caller:
 *   - players, team_players: an admin or staff member of the row's
 *     organization;
 *   - coaches, team_coach_assignments: an admin or staff member;
 *   - staging_players, staging_import_rows: an admin or staff member;
 *   - team_calendar_tokens: an admin or staff member;
 *   - facility_permits, facility_permit_scopes: an admin or staff member.
 *
 * No coach signs in (docs/changes/2026-10-27-admin-only.md), so every one of these is an admin's
 * read: a signed-in caller with no membership reads nothing.
 *
 * **Not mirrored:** embedded rows (`select('x, players(...)')`) are not
 * filtered, and a read with no mock session is left unfiltered (the mock's
 * long-standing default of acting as the seeded admin). A row with no
 * `organization_id` is taken to be in the seeded organization, as the mock's
 * writers default it.
 */

import { createAccessHelpers } from './mockServerSideReads.js';
import { permitRowVisible } from './mockFacilityPermits.js';
import { MOCK_ORG_ID } from './mockSeedIds.js';

export const RESTRICTED_TABLES = Object.freeze([
  'players',
  'team_players',
  'coaches',
  'team_coach_assignments',
  'staging_players',
  'staging_import_rows',
  'team_calendar_tokens',
  'facility_permits',
  'facility_permit_scopes',
]);

/**
 * @param {Record<string, any[]>} db
 * @param {string} table
 * @param {any[]} rows
 * @param {string | null} currentUserId
 * @param {Date} [now]
 * @returns {any[]}
 */
export function applyMockReadPolicy(db, table, rows, currentUserId, now = new Date()) {
  if (!RESTRICTED_TABLES.includes(table) || !currentUserId || !Array.isArray(rows)) return rows;
  const access = createAccessHelpers(db, currentUserId, now);
  const orgOf = (row) =>
    row?.organization_id ?? access.teamById(row?.team_id)?.organization_id ?? MOCK_ORG_ID;

  const visible = {
    players: (row) => access.isOrgAdmin(orgOf(row)),
    team_players: (row) => access.isOrgAdmin(orgOf(row)),
    coaches: (row) => access.isOrgAdmin(orgOf(row)),
    team_coach_assignments: (row) => access.isOrgAdmin(orgOf(row)),
    staging_players: (row) => access.isOrgAdmin(orgOf(row)),
    staging_import_rows: (row) => access.isOrgAdmin(orgOf(row)),
    team_calendar_tokens: (row) => access.isOrgAdmin(orgOf(row)),
    // 20261102010000: an admin or staff member.
    facility_permits: (row) => permitRowVisible(db, 'facility_permits', row, currentUserId, now),
    facility_permit_scopes: (row) =>
      permitRowVisible(db, 'facility_permit_scopes', row, currentUserId, now),
  }[table];
  return rows.filter((row) => visible(row));
}
