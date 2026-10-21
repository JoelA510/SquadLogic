/**
 * Mock arms for the server-side reads of migration
 * `20261021010000_server_side_reads.sql` (Phase A3a): the guardian link, the
 * contact card writer, and the four reads that apply the Phase A access table.
 *
 * **Refusals included** (LESSONS_LEARNED #13), with the SQL's error codes:
 *   - 42501 a caller with no session; a roster or staff read by anyone but an
 *     org admin or staff member, a current coach of the team, or a guardian on
 *     the team (an unknown team id is refused the same way); a directory read
 *     by anyone but an admin or a current coach while `coach_directory` is on;
 *   - 23502 `p_share` missing; 22023 a phone or email that is not one.
 *
 * "Current coach" is a `team_coach_assignments` row of the caller's linked
 * coach (`coaches.user_id`) whose INCLUSIVE window holds today in the team's
 * season timezone, UTC when unset or unreadable, as `team_local_today`.
 *
 * **Not mirrored** (stated so nobody reads this as the database):
 *   - the mock has no unverified accounts: the session's email is the verified
 *     email the guardian link and the contact card's matching use;
 *   - `record_audit_event`'s own checks (the row is appended directly);
 *   - the table policies: the mock's generic `.from()` still returns every row
 *     of the organization, as the database does until A3b restricts them.
 *
 * Pure over `db` so a test can drive it directly; `mockSupabaseClient.js`
 * wires it into `rpc()` and persists `db` afterwards.
 */

import { ADMIN_ROLES } from '../constants/permissions.js';
import { FEATURE_FLAGS } from '../constants/featureFlags.js';
import { CONTACT_PHONE_PATTERN } from '../utils/contactCard.js';
import { seasonCalendarDate } from '@squadlogic/core/timing/index.js';

export const SERVER_SIDE_READ_RPCS = Object.freeze([
  'link_my_guardian_records',
  'set_my_contact_card',
  'get_team_roster',
  'get_team_staff',
  'get_coach_directory',
  'get_my_coached_team_ids',
]);

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const norm = (value) =>
  String(value ?? '')
    .trim()
    .toLowerCase();
const denied = (message) => ({ data: null, error: { message, code: '42501' } });

/** Today's date (YYYY-MM-DD) in `zone`, UTC when the zone is unset or unreadable. */
export function localDateIn(zone, now = new Date()) {
  const tz = typeof zone === 'string' && zone.trim() ? zone.trim() : null;
  // An unreadable stored zone counts as unset, as team_local_today.
  return seasonCalendarDate(now.getTime(), tz) ?? now.toISOString().slice(0, 10);
}

/**
 * @param {Record<string, any[]>} db
 * @param {string} name
 * @param {Record<string, any> | null | undefined} params
 * @param {{ currentUserId: string | null, sessionEmail?: string | null, now?: Date, newId?: () => string }} ctx
 */
export function handleServerSideReadRpc(db, name, params, ctx) {
  if (!SERVER_SIDE_READ_RPCS.includes(name)) return null;
  const { currentUserId } = ctx;
  const now = ctx.now ?? new Date();
  const newId = ctx.newId ?? (() => globalThis.crypto.randomUUID());
  const p = params || {};
  if (!currentUserId) return denied(`${name} requires a signed-in caller`);
  const email = norm(ctx.sessionEmail);

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
  const teamToday = (teamId) => {
    const team = teamById(teamId);
    const division = (db.divisions || []).find((d) => String(d.id) === String(team?.division_id));
    const season = (db.season_settings || []).find(
      (s) => String(s.id) === String(division?.season_settings_id)
    );
    return localDateIn(season?.timezone, now);
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
  const myCoachIds = new Set(
    (db.coaches || [])
      .filter((coach) => String(coach.user_id ?? '') === String(currentUserId))
      .map((coach) => String(coach.id))
  );
  const isCurrentTeamCoach = (teamId) =>
    (db.team_coach_assignments || []).some(
      (row) =>
        String(row.team_id) === String(teamId) &&
        myCoachIds.has(String(row.coach_id)) &&
        isOrgMember(row.organization_id) &&
        isLive(row)
    );
  const myChildIds = new Set(
    (db.profile_players || [])
      .filter((link) => String(link.profile_id) === String(currentUserId))
      .map((link) => String(link.player_id))
  );
  const rosterOf = (teamId) =>
    (db.team_players || []).filter((row) => String(row.team_id) === String(teamId));
  const isTeamGuardian = (teamId) => {
    const team = teamById(teamId);
    return (
      !!team &&
      isOrgMember(team.organization_id) &&
      rosterOf(teamId).some((row) => myChildIds.has(String(row.player_id)))
    );
  };
  const orgFlag = (orgId, key, fallback) => {
    const org = (db.organizations || []).find((o) => String(o.id) === String(orgId));
    const value = org?.feature_flags?.[key];
    return typeof value === 'boolean' ? value : fallback;
  };
  const profileById = (id) =>
    (db.profiles || []).find((profile) => String(profile.id) === String(id)) ?? null;
  const coachContact = (coach) => {
    const card = coach.user_id ? profileById(coach.user_id) : null;
    const share = card?.share_contact ?? null;
    if (share === null) return { phone: coach.phone ?? null, email: coach.email ?? null };
    if (share) return { phone: card.contact_phone ?? null, email: card.contact_email ?? null };
    return { phone: null, email: null };
  };
  const stripNulls = (obj) =>
    Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== null && v !== undefined));
  const guardianContactsView = (player, primaryOnly) => {
    const contacts = Array.isArray(player.guardian_contacts) ? player.guardian_contacts : [];
    const linked = (db.profile_players || [])
      .filter((link) => String(link.player_id) === String(player.id))
      .map((link) => profileById(link.profile_id))
      .filter(Boolean);
    // As the SQL: the primary contact is the FIRST element (`ord = 1`), taken
    // before anything that is not a contact object is dropped.
    return contacts
      .slice(0, primaryOnly ? 1 : undefined)
      .filter((c) => c && typeof c === 'object' && !Array.isArray(c))
      .map((c) => {
        const matches = linked.filter(
          (profile) =>
            norm(profile.email) !== '' &&
            [norm(c.email), norm(c.alternate_email)].includes(norm(profile.email))
        );
        const card = matches.find((m) => m.share_contact !== null && m.share_contact !== undefined);
        if (!card) {
          return stripNulls({
            name: c.name,
            email: c.email,
            phone: c.phone,
            alternate_email: primaryOnly ? null : c.alternate_email,
          });
        }
        if (card.share_contact) {
          return stripNulls({ name: c.name, email: card.contact_email, phone: card.contact_phone });
        }
        return stripNulls({ name: c.name });
      });
  };
  const myCoachedTeamIds = (orgId) =>
    isOrgMember(orgId)
      ? [
          ...new Set(
            (db.team_coach_assignments || [])
              .filter(
                (row) =>
                  String(row.organization_id) === String(orgId) &&
                  myCoachIds.has(String(row.coach_id)) &&
                  isLive(row)
              )
              .map((row) => String(row.team_id))
          ),
        ]
      : [];

  if (name === 'link_my_guardian_records') {
    if (!email) return { data: { status: 'email_not_verified', linked: 0 }, error: null };
    db.profile_players = db.profile_players || [];
    let linked = 0;
    for (const player of db.players || []) {
      if (!isOrgMember(player.organization_id) || myChildIds.has(String(player.id))) continue;
      const contacts = Array.isArray(player.guardian_contacts) ? player.guardian_contacts : [];
      const matches = contacts.some(
        (c) => c && (norm(c.email) === email || norm(c.alternate_email) === email)
      );
      if (!matches) continue;
      db.profile_players.push({
        profile_id: currentUserId,
        player_id: player.id,
        organization_id: player.organization_id,
        created_at: now.toISOString(),
      });
      myChildIds.add(String(player.id));
      linked += 1;
      db.audit_log = db.audit_log || [];
      db.audit_log.push({
        id: newId(),
        organization_id: player.organization_id,
        user_id: currentUserId,
        action: 'guardian.linked',
        resource_type: 'players',
        resource_id: player.id,
        metadata: { profile_id: currentUserId, matched_email: email },
        created_at: now.toISOString(),
      });
    }
    const status = linked > 0 ? 'linked' : myChildIds.size > 0 ? 'already_linked' : 'no_match';
    return { data: { status, linked }, error: null };
  }

  if (name === 'set_my_contact_card') {
    if (typeof p.p_share !== 'boolean') {
      return { data: null, error: { message: 'p_share is required', code: '23502' } };
    }
    const phone = String(p.p_phone ?? '').trim() || null;
    const cardEmail = String(p.p_email ?? '').trim() || null;
    if (phone !== null && !CONTACT_PHONE_PATTERN.test(phone)) {
      return {
        data: null,
        error: { message: 'contact phone is not a phone number', code: '22023' },
      };
    }
    if (cardEmail !== null && (cardEmail.length > 254 || !EMAIL_RE.test(cardEmail))) {
      return {
        data: null,
        error: { message: 'contact email is not an email address', code: '22023' },
      };
    }
    const profile = profileById(currentUserId);
    if (!profile)
      return { data: null, error: { message: 'no profile for the caller', code: 'P0002' } };
    Object.assign(profile, {
      contact_phone: phone,
      contact_email: cardEmail,
      share_contact: p.p_share,
    });
    return {
      data: { contact_phone: phone, contact_email: cardEmail, share_contact: p.p_share },
      error: null,
    };
  }

  if (name === 'get_my_coached_team_ids') {
    return { data: myCoachedTeamIds(p.p_organization_id), error: null };
  }

  if (name === 'get_coach_directory') {
    const orgId = p.p_organization_id;
    const admitted =
      isOrgAdmin(orgId) ||
      (orgFlag(orgId, FEATURE_FLAGS.COACH_DIRECTORY, true) && myCoachedTeamIds(orgId).length > 0);
    if (!admitted) return denied('not permitted to read the coach directory');
    const byCoach = new Map();
    for (const row of db.team_coach_assignments || []) {
      if (String(row.organization_id) !== String(orgId) || !isLive(row)) continue;
      const coach = coachById(row.coach_id);
      const team = teamById(row.team_id);
      if (!coach || !team) continue;
      const entry = byCoach.get(String(coach.id)) ?? {
        coach_id: coach.id,
        full_name: coach.full_name ?? null,
        ...coachContact(coach),
        team_names: [],
      };
      if (!entry.team_names.includes(team.name)) entry.team_names.push(team.name);
      byCoach.set(String(coach.id), entry);
    }
    const rows = [...byCoach.values()]
      .map((entry) => ({ ...entry, team_names: [...entry.team_names].sort() }))
      .sort(
        (a, b) =>
          String(a.full_name ?? '').localeCompare(String(b.full_name ?? '')) ||
          String(a.coach_id).localeCompare(String(b.coach_id))
      );
    return { data: rows, error: null };
  }

  // get_team_roster, get_team_staff
  const team = teamById(p.p_team_id);
  const admin = !!team && isOrgAdmin(team.organization_id);
  const coach = !!team && !admin && isCurrentTeamCoach(team.id);
  const guardian = !!team && !admin && !coach && isTeamGuardian(team.id);
  if (!(admin || coach || guardian)) {
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
          ...coachContact(c),
          status: admin ? (c.status ?? null) : null,
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

  const share = orgFlag(team.organization_id, FEATURE_FLAGS.GUARDIAN_CONTACT_SHARING, true);
  const rows = rosterOf(team.id)
    .map((row) => (db.players || []).find((pl) => String(pl.id) === String(row.player_id)))
    .filter(Boolean)
    .map((player) => {
      const mine = myChildIds.has(String(player.id));
      let contacts = [];
      if (admin || coach || mine) contacts = guardianContactsView(player, false);
      else if (share) contacts = guardianContactsView(player, true);
      return {
        player_id: player.id,
        first_name: player.first_name ?? null,
        last_name: player.last_name ?? null,
        preferred_name: player.preferred_name ?? null,
        jersey_number: player.jersey_number ?? null,
        is_my_child: mine,
        guardian_contacts: contacts,
        gender: admin ? (player.gender ?? null) : null,
        years_played: admin ? (player.years_played ?? null) : null,
        rating: admin ? (player.rating ?? null) : null,
        willing_to_coach: admin ? (player.willing_to_coach ?? null) : null,
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
