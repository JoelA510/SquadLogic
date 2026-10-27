export const ROLES = {
  TENANT_ADMIN: 'tenant_admin',
  ADMIN: 'admin',
  COACH: 'coach',
  STAFF: 'staff',
};
// No `parent` or `player` role: the guardian view and both roles were removed
// (migration 20261024010000; plan docs/changes/2026-10-22-admin-focus.md, R3).

export const PERMISSIONS = {
  // Org Level
  MANAGE_ORGANIZATION: 'manage_organization',
  VIEW_ORGANIZATION: 'view_organization',
  MANAGE_GLOBAL_SETTINGS: 'manage_global_settings',

  // Team Level
  MANAGE_ALL_TEAMS: 'manage_all_teams',
  MANAGE_OWN_TEAM: 'manage_own_team',
  VIEW_ALL_TEAMS: 'view_all_teams',

  // Schedule: the admin scheduling pages, and score entry and standings
  // (behind the league's settings). Admins only since 20261028010000 (plan
  // docs/changes/2026-10-22-admin-focus.md, R6): a coach sees their own
  // schedule on their home, and `update_game_score` refuses a non-admin.
  MANAGE_SCHEDULE: 'manage_schedule',
  VIEW_SCHEDULE: 'view_schedule',

  // Coach practice preferences (Phase 8.6 PR 3b): coaches request, only admins
  // decide or set. The RPCs enforce the same split server-side.
  REQUEST_PRACTICE_PREFERENCE: 'request_practice_preference',
  DECIDE_PRACTICE_PREFERENCE: 'decide_practice_preference',

  // Portable-lighting overrides (8.9 D14): admins decide, set and withdraw.
  // No coach requests since 20261028010000 (R6, owner decision 4), so the
  // request permission is gone with the request RPC.
  DECIDE_PRACTICE_LIGHTING_OVERRIDE: 'decide_practice_lighting_override',

  // Field permits (Phase C3, docs/changes/2026-10-22-phase-c-permits.md): the page that lists the
  // permits of the fields a coach's teams use, to open one at the field. Admins, staff and coaches;
  // a guardian has no role here and no access (owner decision 2). Only the page is gated by this:
  // the server decides what each caller may read (`get_facility_permits`, narrowed for a coach).
  VIEW_FIELD_PERMITS: 'view_field_permits',
};

/**
 * The organization roles the server treats as admins: `is_org_admin()` admits
 * exactly these, and so does the Edge Functions' `verifyOrgAdmin` (its own
 * ADMIN_ROLES; tests/adminRolesParity.test.js holds the two equal). `staff`
 * joined them on 2026-10-20 (owner decision: "Staff should be treated like an
 * admin"; migration 20261020030000).
 */
export const ADMIN_ROLES = Object.freeze([ROLES.ADMIN, ROLES.TENANT_ADMIN, ROLES.STAFF]);

/** True when an organization role is admin-equivalent. */
export const isAdminRole = (role) => ADMIN_ROLES.includes(role);

/**
 * The roles an admin can invite a member as or assign one: the whitelist of
 * `create_org_invite` and `admin_change_member_role` (20261024010000), and the
 * `organization_invites` role check. `tenant_admin` is never assigned here.
 */
export const ASSIGNABLE_ROLES = Object.freeze([ROLES.ADMIN, ROLES.COACH, ROLES.STAFF]);

export const ROLE_PERMISSIONS = {
  [ROLES.TENANT_ADMIN]: [
    PERMISSIONS.MANAGE_ORGANIZATION,
    PERMISSIONS.VIEW_ORGANIZATION,
    PERMISSIONS.MANAGE_GLOBAL_SETTINGS,
    PERMISSIONS.MANAGE_ALL_TEAMS,
    PERMISSIONS.VIEW_ALL_TEAMS,
    PERMISSIONS.MANAGE_SCHEDULE,
    PERMISSIONS.VIEW_SCHEDULE,
    PERMISSIONS.REQUEST_PRACTICE_PREFERENCE,
    PERMISSIONS.DECIDE_PRACTICE_PREFERENCE,
    PERMISSIONS.DECIDE_PRACTICE_LIGHTING_OVERRIDE,
    PERMISSIONS.VIEW_FIELD_PERMITS,
  ],
  [ROLES.ADMIN]: [
    PERMISSIONS.MANAGE_ORGANIZATION,
    PERMISSIONS.VIEW_ORGANIZATION,
    // Backend parity: is_org_admin() treats 'admin', 'tenant_admin' and 'staff'
    // as equivalent, and initialize_new_tenant assigns new-org creators 'admin' —
    // without this grant a self-serve org creator is locked out of Season
    // Setup by the frontend while the database would allow every mutation.
    PERMISSIONS.MANAGE_GLOBAL_SETTINGS,
    PERMISSIONS.MANAGE_ALL_TEAMS,
    PERMISSIONS.VIEW_ALL_TEAMS,
    PERMISSIONS.MANAGE_SCHEDULE,
    PERMISSIONS.VIEW_SCHEDULE,
    PERMISSIONS.REQUEST_PRACTICE_PREFERENCE,
    PERMISSIONS.DECIDE_PRACTICE_PREFERENCE,
    PERMISSIONS.DECIDE_PRACTICE_LIGHTING_OVERRIDE,
    PERMISSIONS.VIEW_FIELD_PERMITS,
  ],
  [ROLES.COACH]: [
    PERMISSIONS.VIEW_ORGANIZATION,
    PERMISSIONS.MANAGE_OWN_TEAM,
    // Not VIEW_ALL_TEAMS: a coach sees their own team only (Phase A3, owner
    // decision 2026-10-20); the league's rosters are an admin's.
    // Not MANAGE_SCHEDULE or VIEW_SCHEDULE: scheduling, score entry and
    // standings are an admin's; a coach's own schedule is on their home
    // (20261028010000, R6). Practice preferences stay (decision 4).
    PERMISSIONS.REQUEST_PRACTICE_PREFERENCE,
    // The permits of the fields their teams use (C3); the server narrows the read to those fields.
    PERMISSIONS.VIEW_FIELD_PERMITS,
  ],
};

// Staff hold exactly the admin's permissions (see ADMIN_ROLES): a frozen copy,
// so changing one role's list in place cannot change the other's.
ROLE_PERMISSIONS[ROLES.STAFF] = /** @type {string[]} */ (
  Object.freeze([...ROLE_PERMISSIONS[ROLES.ADMIN]])
);

/**
 * Check if a role has a specific permission
 * @param {string} role
 * @param {string} permission
 * @returns {boolean}
 */
export const hasPermission = (role, permission) => {
  if (!role) return false;
  const perms = ROLE_PERMISSIONS[role] || [];
  return perms.includes(permission);
};
