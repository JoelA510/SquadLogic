/**
 * Mock arms for the three RPCs the mock client used to let fall through to its
 * catch-all `{ data: null, error: null }` -- a silent success for a write that
 * never happened. With these arms in place the catch-all refuses instead
 * ({@link unmockedRpcError}), so a new unmocked RPC fails loudly rather than
 * passing E2E on a no-op.
 *
 * Each mirrors its SQL definition, refusals included (LESSONS_LEARNED #13):
 *
 * - `admin_upsert_division_settings`
 *   (`20260504020000_admin_upsert_division_settings_rpc.sql`): 23502 missing
 *   org/season/name; 42501 season not the org's, no uid, not an org admin, or a
 *   division of another org/season; upsert by (season, name) or update by id;
 *   returns the row plus `changed`. `p_plays_games` (20261029010000): NULL
 *   keeps the stored value, a new division plays games.
 * - `admin_set_practice_slot_division` (20261029010000): 23502 no slot;
 *   42501 no uid, no such slot, or not an admin of its organization; 22023 a
 *   division of another organization; a repeat returns `changed: false`.
 * - `create_org_invite` (`20260421034626_invite_code_system.sql`): 42501 not
 *   an org admin; 22023 a role outside the whitelist; returns
 *   `[{code, expires_at}]` (the SQL returns TABLE); `p_expires_in` NULL means
 *   no expiry, absent means 7 days.
 * - `redeem_org_invite` (same migration): 28000 no session; 22023 unknown,
 *   used or expired code; an existing member consumes the code without a second
 *   membership; returns the organization id.
 *
 * **Not mirrored**: `record_audit_event` (nothing in the UI reads the audit
 * log from these), row locking, `service_role` bypass, and the invite code
 * alphabet (`generate_invite_code`) -- the mock code is 8 random upper-case
 * alphanumerics.
 */

import { ASSIGNABLE_ROLES } from '../constants/permissions.js';

export const ADMIN_WRITE_RPCS = Object.freeze([
  'admin_upsert_division_settings',
  'admin_set_practice_slot_division',
  'create_org_invite',
  'redeem_org_invite',
]);

// create_org_invite's whitelist (20261024010000: no parent or player).
const INVITE_ROLES = ASSIGNABLE_ROLES;
const DIVISION_RULES = [
  'max_roster_size',
  'min_roster_size',
  'target_team_size',
  'team_count_override',
  'min_teams',
  'max_teams',
];

const fail = (code, message) => ({ data: null, error: { code, message } });

/**
 * What the mock answers for an RPC it has no arm for: PostgREST's refusal of a
 * function it does not know (`PGRST202`), with a pointer to where arms live.
 *
 * @param {string} name
 */
export function unmockedRpcError(name) {
  return {
    data: null,
    error: {
      code: 'PGRST202',
      message: `Could not find the function public.${name} in the schema cache (mock client: no arm for this RPC; add one under frontend/src/lib/mock*.js)`,
      details: null,
      hint: null,
    },
  };
}
const same = (a, b) => String(a) === String(b);

/** `'7 days'`, `'24 hours'`, `'30 minutes'` -> milliseconds; null if unreadable. */
function intervalMs(text) {
  const m = /^\s*(\d+)\s*(day|hour|minute)s?\s*$/i.exec(String(text ?? ''));
  if (!m) return null;
  const unit = { day: 86400000, hour: 3600000, minute: 60000 }[m[2].toLowerCase()];
  return Number(m[1]) * unit;
}

/**
 * @param {any} db - the mock database; mutated in place
 * @param {string} name
 * @param {Record<string, any>} params
 * @param {{ currentUserId: string|null, sessionUserId: string|null,
 *   isOrgAdmin: (orgId: string) => boolean, now?: Date, newId?: () => string }} ctx
 *   `sessionUserId` is null with no mock session; the mock's `currentUserId`
 *   falls back to `mock-admin-id` there, so only redeem (28000) reads the former.
 * @returns {{ data: any, error: any } | null} null when `name` is not one of these RPCs
 */
export function handleAdminWriteRpc(db, name, params, ctx) {
  if (!ADMIN_WRITE_RPCS.includes(name)) return null;
  const p = params || {};
  const now = ctx.now ?? new Date();
  const newId = ctx.newId ?? (() => globalThis.crypto.randomUUID());
  const uid = ctx.currentUserId;

  if (name === 'admin_upsert_division_settings') {
    const orgId = p.p_organization_id;
    const seasonId = p.p_season_settings_id;
    if (!orgId) return fail('23502', 'p_organization_id is required');
    if (!seasonId) return fail('23502', 'p_season_settings_id is required');
    const season = (db.season_settings || []).find((s) => same(s.id, seasonId));
    if (!season) return fail('42501', `Season settings not found in organization ${orgId}`);
    if (!same(season.organization_id, orgId)) {
      return fail('42501', `Season settings do not belong to organization ${orgId}`);
    }
    if (!uid) return fail('42501', 'authenticated user is required');
    if (!ctx.isOrgAdmin(orgId)) {
      return fail('42501', `Access denied: caller is not an admin of organization ${orgId}`);
    }
    db.divisions = db.divisions || [];
    let nameText = String(p.p_name ?? '').trim();
    let existing = null;
    if (p.p_division_id) {
      existing = db.divisions.find((d) => same(d.id, p.p_division_id));
      if (!existing) return fail('42501', `Division not found in organization ${orgId}`);
      if (!same(existing.organization_id, orgId) || !same(existing.season_settings_id, seasonId)) {
        return fail('42501', 'Division does not belong to the requested organization and season');
      }
      if (!nameText) nameText = existing.name;
    } else {
      if (!nameText) return fail('23502', 'p_name is required');
      existing =
        db.divisions.find(
          (d) =>
            same(d.season_settings_id, seasonId) &&
            d.name === nameText &&
            same(d.organization_id, orgId)
        ) ?? null;
    }
    const next = Object.fromEntries(DIVISION_RULES.map((k) => [k, p[`p_${k}`] ?? null]));
    // NULL (or absent) keeps the stored value; a new division plays games.
    const playsGames =
      typeof p.p_plays_games === 'boolean' ? p.p_plays_games : (existing?.plays_games ?? true);
    const changed =
      !existing ||
      existing.name !== nameText ||
      DIVISION_RULES.some((k) => (existing[k] ?? null) !== next[k]) ||
      (existing.plays_games ?? true) !== playsGames;
    let row = existing;
    if (!existing) {
      row = {
        id: newId(),
        organization_id: orgId,
        season_settings_id: seasonId,
        name: nameText,
        ...next,
        plays_games: playsGames,
        created_at: now.toISOString(),
        updated_at: now.toISOString(),
      };
      db.divisions.push(row);
    } else if (changed) {
      Object.assign(existing, {
        name: nameText,
        ...next,
        plays_games: playsGames,
        updated_at: now.toISOString(),
      });
    }
    return { data: { ...row, plays_games: row.plays_games ?? true, changed }, error: null };
  }

  if (name === 'admin_set_practice_slot_division') {
    if (!p.p_slot_id) return fail('23502', 'p_slot_id is required');
    const slot = (db.practice_slots || []).find((s) => same(s.id, p.p_slot_id));
    if (!uid || !slot || !ctx.isOrgAdmin(slot.organization_id)) {
      return fail('42501', 'Access denied: only an organization admin reserves a practice slot');
    }
    const divisionId = p.p_division_id ?? null;
    if (divisionId !== null) {
      const division = (db.divisions || []).find((d) => same(d.id, divisionId));
      if (!division || !same(division.organization_id, slot.organization_id)) {
        return fail(
          '22023',
          `Division ${divisionId} is not a division of this slot's organization`
        );
      }
    }
    const changed = (slot.division_id ?? null) !== divisionId;
    if (changed) {
      slot.division_id = divisionId;
      slot.updated_at = now.toISOString();
    }
    return {
      data: {
        id: slot.id,
        organization_id: slot.organization_id,
        division_id: divisionId,
        changed,
      },
      error: null,
    };
  }

  if (name === 'create_org_invite') {
    if (!ctx.isOrgAdmin(p.p_org_id)) {
      return fail('42501', 'Not authorized to create invites for this organization');
    }
    if (!INVITE_ROLES.includes(p.p_role)) return fail('22023', `Invalid role: ${p.p_role}`);
    let expiresAt = null;
    // `undefined` is absent on the wire (JSON drops it), so it takes the default too.
    if (p.p_expires_in === undefined) {
      expiresAt = new Date(now.getTime() + 7 * 86400000).toISOString();
    } else if (p.p_expires_in !== null) {
      const ms = intervalMs(p.p_expires_in);
      if (ms === null)
        return fail('22007', `invalid input syntax for type interval: "${p.p_expires_in}"`);
      expiresAt = new Date(now.getTime() + ms).toISOString();
    }
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const code = Array.from(
      { length: 8 },
      () => alphabet[Math.floor(Math.random() * alphabet.length)]
    ).join('');
    db.organization_invites = db.organization_invites || [];
    db.organization_invites.push({
      id: newId(),
      code,
      organization_id: p.p_org_id,
      role: p.p_role,
      created_by: uid,
      created_at: now.toISOString(),
      expires_at: expiresAt,
      used_at: null,
      used_by: null,
    });
    return { data: [{ code, expires_at: expiresAt }], error: null };
  }

  // redeem_org_invite
  const sessionUid = ctx.sessionUserId;
  if (!sessionUid) return fail('28000', 'Not authenticated');
  const code = String(p.p_code ?? '')
    .trim()
    .toUpperCase();
  const invite = (db.organization_invites || []).find((i) => i.code === code);
  if (!invite) return fail('22023', 'Invite code not found');
  if (invite.used_at) return fail('22023', 'Invite code has already been used');
  if (invite.expires_at && new Date(invite.expires_at).getTime() < now.getTime()) {
    return fail('22023', 'Invite code has expired');
  }
  db.organization_members = db.organization_members || [];
  const member = db.organization_members.some(
    (m) => same(m.organization_id, invite.organization_id) && same(m.profile_id, sessionUid)
  );
  if (!member) {
    db.organization_members.push({
      organization_id: invite.organization_id,
      profile_id: sessionUid,
      role: invite.role,
    });
  }
  invite.used_at = now.toISOString();
  invite.used_by = sessionUid;
  return { data: invite.organization_id, error: null };
}
