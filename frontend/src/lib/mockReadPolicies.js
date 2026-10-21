/**
 * The SELECT policies of migration `20261021020000_restrict_people_reads.sql`,
 * applied to the mock client's generic `.from(table)` reads, so a page that
 * still reads a restricted table directly fails in mock mode (and in the E2E
 * suite) the way it would against the database.
 *
 * Mirrored, per table, for the signed-in caller:
 *   - players, team_players: an admin or staff member of the row's
 *     organization, or a member who is the player's guardian
 *     (`profile_players`);
 *   - coaches: an admin or staff member, or the coach row linked to the caller
 *     while they are a member;
 *   - team_coach_assignments: an admin or staff member, or the caller's own
 *     while they are a member;
 *   - profile_players: the caller's own links while a member, or an admin or
 *     staff member;
 *   - staging_players, staging_import_rows: an admin or staff member;
 *   - team_calendar_tokens: an admin or staff member, the team's current
 *     coach, or a guardian on the team.
 *
 * **Not mirrored:** embedded rows (`select('x, players(...)')`) are not
 * filtered, and a read with no mock session is left unfiltered (the mock's
 * long-standing default of acting as the seeded admin). A row with no
 * `organization_id` is taken to be in the seeded organization, as the mock's
 * writers default it.
 */

import { createAccessHelpers } from './mockServerSideReads.js';
import { MOCK_ORG_ID } from './mockSeedIds.js';

export const RESTRICTED_TABLES = Object.freeze([
  'players',
  'team_players',
  'coaches',
  'team_coach_assignments',
  'profile_players',
  'staging_players',
  'staging_import_rows',
  'team_calendar_tokens',
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
  const own = (value) => String(value ?? '') === String(currentUserId);
  const guardianOf = (row, playerId) =>
    access.isOrgMember(orgOf(row)) && access.myChildIds.has(String(playerId));

  const visible = {
    players: (row) => access.isOrgAdmin(orgOf(row)) || guardianOf(row, row.id),
    team_players: (row) => access.isOrgAdmin(orgOf(row)) || guardianOf(row, row.player_id),
    coaches: (row) =>
      access.isOrgAdmin(orgOf(row)) || (access.isOrgMember(orgOf(row)) && own(row.user_id)),
    team_coach_assignments: (row) =>
      access.isOrgAdmin(orgOf(row)) ||
      (access.isOrgMember(orgOf(row)) && access.myCoachIds.has(String(row.coach_id))),
    profile_players: (row) =>
      (access.isOrgMember(orgOf(row)) && own(row.profile_id)) || access.isOrgAdmin(orgOf(row)),
    staging_players: (row) => access.isOrgAdmin(orgOf(row)),
    staging_import_rows: (row) => access.isOrgAdmin(orgOf(row)),
    team_calendar_tokens: (row) =>
      access.isOrgAdmin(orgOf(row)) ||
      access.isCurrentTeamCoach(row.team_id) ||
      access.isTeamGuardian(row.team_id),
  }[table];
  return rows.filter((row) => visible(row));
}
