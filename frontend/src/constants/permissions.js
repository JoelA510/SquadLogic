export const ROLES = {
  TENANT_ADMIN: 'tenant_admin',
  ADMIN: 'admin',
  STAFF: 'staff',
};
// No `parent`, `player` or `coach` role: only league admins sign in. The guardian view and
// both roles were removed (migration 20261024010000; plan docs/changes/2026-10-22-admin-focus.md,
// R3), and the coach role with them (plan docs/changes/2026-10-27-admin-only.md). Coaches are
// imported data that admins manage.

export const PERMISSIONS = {
  // Org Level
  MANAGE_ORGANIZATION: 'manage_organization',
  VIEW_ORGANIZATION: 'view_organization',
  MANAGE_GLOBAL_SETTINGS: 'manage_global_settings',

  // Team Level
  MANAGE_ALL_TEAMS: 'manage_all_teams',
  VIEW_ALL_TEAMS: 'view_all_teams',

  // Schedule: the admin scheduling pages, and score entry and standings
  // (behind the league's settings). `update_game_score` refuses a non-admin.
  MANAGE_SCHEDULE: 'manage_schedule',
  VIEW_SCHEDULE: 'view_schedule',

  // Coach practice preferences (Phase 8.6 PR 3b): admins decide or set them on a coach's behalf.
  // The RPCs enforce the same rule server-side.
  DECIDE_PRACTICE_PREFERENCE: 'decide_practice_preference',

  // Portable-lighting overrides (8.9 D14): admins decide, set and withdraw.
  DECIDE_PRACTICE_LIGHTING_OVERRIDE: 'decide_practice_lighting_override',

  // Field permits: the admins' consolidated page of every permit, to open or download one
  // (docs/changes/2026-10-27-admin-only.md, decision 4). Only the page is gated by this: the
  // server decides what each caller may read (`get_facility_permits`).
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
export const ASSIGNABLE_ROLES = Object.freeze([ROLES.ADMIN, ROLES.STAFF]);

export const ROLE_PERMISSIONS = {
  [ROLES.TENANT_ADMIN]: [
    PERMISSIONS.MANAGE_ORGANIZATION,
    PERMISSIONS.VIEW_ORGANIZATION,
    PERMISSIONS.MANAGE_GLOBAL_SETTINGS,
    PERMISSIONS.MANAGE_ALL_TEAMS,
    PERMISSIONS.VIEW_ALL_TEAMS,
    PERMISSIONS.MANAGE_SCHEDULE,
    PERMISSIONS.VIEW_SCHEDULE,
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
    PERMISSIONS.DECIDE_PRACTICE_PREFERENCE,
    PERMISSIONS.DECIDE_PRACTICE_LIGHTING_OVERRIDE,
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
