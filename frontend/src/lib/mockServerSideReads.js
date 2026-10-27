/**
 * Mock arms for the server-side reads of migration
 * `20261021010000_server_side_reads.sql` (Phase A3a), as
 * `20261025010000_remove_contact_surfaces.sql` (R4) left them and as the
 * admin-only plan (`docs/changes/2026-10-27-admin-only.md`) leaves them: the
 * roster and staff reads, which only an org admin or staff member may make.
 * No coach signs in, so the coached-team and division reads, and the coach
 * arm of these two, are gone. There is no guardian (R3) and no contact
 * surface (R4): neither read returns a contact column, and the contact card
 * writer and the coach directory are gone, so a call to either falls through
 * to the client's PGRST202 refusal, as the API answers a function that does
 * not exist.
 *
 * **Refusals included** (LESSONS_LEARNED #13), with the SQL's error codes:
 *   - 42501 a caller with no session; a roster or staff read by anyone but an
 *     org admin or staff member (an unknown team id is refused the same way).
 *
 * A "current" coach assignment is a `team_coach_assignments` row whose
 * INCLUSIVE window holds today in the team's season timezone, UTC when unset
 * or unreadable, as `team_local_today`.
 *
 * **Not mirrored** (stated so nobody reads this as the database):
 *   - `record_audit_event`'s own checks (the row is appended directly);
 *   - the table policies: the mock's generic `.from()` still returns every row
 *     of the organization, as the database does until A3b restricts them;
 *
 * Pure over `db` so a test can drive it directly; `mockSupabaseClient.js`
 * wires it into `rpc()` and persists `db` afterwards.
 */

import { ADMIN_ROLES } from '../constants/permissions.js';
import { seasonCalendarDate } from '@squadlogic/core/timing/index.js';

export const SERVER_SIDE_READ_RPCS = Object.freeze(['get_team_roster', 'get_team_staff']);

const denied = (message) => ({ data: null, error: { message, code: '42501' } });

/** Today's date (YYYY-MM-DD) in `zone`, UTC when the zone is unset or unreadable. */
export function localDateIn(zone, now = new Date()) {
  const tz = typeof zone === 'string' && zone.trim() ? zone.trim() : null;
  // An unreadable stored zone counts as unset, as team_local_today.
  return seasonCalendarDate(now.getTime(), tz) ?? now.toISOString().slice(0, 10);
}

/**
 * The caller-relative access questions every mock arm of the Phase A3 reads
 * and restrictions asks (20261021010000, 20261021020000), answered over `db`
 * as the SQL helpers answer them: is_org_admin, is_org_member and
 * team_local_today.
 *
 * @param {Record<string, any[]>} db
 * @param {string | null} currentUserId
 * @param {Date} [now]
 */
export function createAccessHelpers(db, currentUserId, now = new Date()) {
  const roleIn = (orgId) =>
    (db.organization_members || []).find(
      (member) =>
        String(member.organization_id) === String(orgId) &&
        String(member.profile_id) === String(currentUserId)
    )?.role ?? null;
  const isOrgAdmin = (orgId) => ADMIN_ROLES.includes(String(roleIn(orgId) || ''));
  const isOrgMember = (orgId) => roleIn(orgId) !== null;
  const teamById = (teamId) =>
    (db.teams || []).find((team) => String(team.id) === String(teamId)) ?? null;
  // Once per team for this set of helpers: a read checks every row.
  const todayByTeam = new Map();
  const teamToday = (teamId) => {
    const key = String(teamId);
    if (todayByTeam.has(key)) return todayByTeam.get(key);
    const team = teamById(teamId);
    const division = (db.divisions || []).find((d) => String(d.id) === String(team?.division_id));
    const season = (db.season_settings || []).find(
      (s) => String(s.id) === String(division?.season_settings_id)
    );
    const today = localDateIn(season?.timezone, now);
    todayByTeam.set(key, today);
    return today;
  };
  const isLive = (row) => {
    const today = teamToday(row.team_id);
    return (
      String(row.effective_from) <= today &&
      (row.effective_to === null ||
        row.effective_to === undefined ||
        String(row.effective_to) >= today)
    );
  };
  const coachById = (coachId) =>
    (db.coaches || []).find((coach) => String(coach.id) === String(coachId)) ?? null;
  const rosterOf = (teamId) =>
    (db.team_players || []).filter((row) => String(row.team_id) === String(teamId));
  return {
    roleIn,
    isOrgAdmin,
    isOrgMember,
    teamById,
    teamToday,
    isLive,
    coachById,
    rosterOf,
  };
}

/**
 * @param {Record<string, any[]>} db
 * @param {string} name
 * @param {Record<string, any> | null | undefined} params
 * @param {{ currentUserId: string | null, now?: Date }} ctx
 */
export function handleServerSideReadRpc(db, name, params, ctx) {
  if (!SERVER_SIDE_READ_RPCS.includes(name)) return null;
  const { currentUserId } = ctx;
  const now = ctx.now ?? new Date();
  const p = params || {};
  if (!currentUserId) return denied(`${name} requires a signed-in caller`);

  const { isOrgAdmin, teamById, isLive, coachById, rosterOf } = createAccessHelpers(
    db,
    currentUserId,
    now
  );

  // get_team_roster, get_team_staff
  const team = teamById(p.p_team_id);
  if (!team || !isOrgAdmin(team.organization_id)) {
    return denied(
      name === 'get_team_roster'
        ? "not permitted to read this team's roster"
        : "not permitted to read this team's staff"
    );
  }

  if (name === 'get_team_staff') {
    const rows = (db.team_coach_assignments || [])
      .filter((row) => String(row.team_id) === String(team.id) && isLive(row))
      .map((row) => {
        const c = coachById(row.coach_id);
        if (!c) return null;
        return {
          coach_id: c.id,
          full_name: c.full_name ?? null,
          role: row.role,
          status: c.status ?? null,
        };
      })
      .filter(Boolean)
      .sort(
        (a, b) =>
          Number(b.role === 'lead') - Number(a.role === 'lead') ||
          String(a.full_name ?? '').localeCompare(String(b.full_name ?? '')) ||
          String(a.coach_id).localeCompare(String(b.coach_id))
      );
    return { data: rows, error: null };
  }

  const rows = rosterOf(team.id)
    .map((row) => (db.players || []).find((pl) => String(pl.id) === String(row.player_id)))
    .filter(Boolean)
    .map((player) => {
      return {
        player_id: player.id,
        first_name: player.first_name ?? null,
        last_name: player.last_name ?? null,
        preferred_name: player.preferred_name ?? null,
        jersey_number: player.jersey_number ?? null,
        gender: player.gender ?? null,
        years_played: player.years_played ?? null,
        rating: player.rating ?? null,
        willing_to_coach: player.willing_to_coach ?? null,
      };
    })
    .sort(
      (a, b) =>
        String(a.last_name ?? '').localeCompare(String(b.last_name ?? '')) ||
        String(a.first_name ?? '').localeCompare(String(b.first_name ?? '')) ||
        String(a.player_id).localeCompare(String(b.player_id))
    );
  return { data: rows, error: null };
}
