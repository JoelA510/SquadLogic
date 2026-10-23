export const ROLES = {
  TENANT_ADMIN: 'tenant_admin',
  ADMIN: 'admin',
  COACH: 'coach',
  PLAYER: 'player',
  PARENT: 'parent',
  STAFF: 'staff',
};

export const PERMISSIONS = {
  // Org Level
  MANAGE_ORGANIZATION: 'manage_organization',
  VIEW_ORGANIZATION: 'view_organization',
  MANAGE_GLOBAL_SETTINGS: 'manage_global_settings',

  // Team Level
  MANAGE_ALL_TEAMS: 'manage_all_teams',
  MANAGE_OWN_TEAM: 'manage_own_team',
  VIEW_ALL_TEAMS: 'view_all_teams',
  VIEW_OWN_TEAM: 'view_own_team',

  // Schedule
  MANAGE_SCHEDULE: 'manage_schedule',
  VIEW_SCHEDULE: 'view_schedule',

  // Coach practice preferences (Phase 8.6 PR 3b): coaches request, only admins
  // decide or set. The RPCs enforce the same split server-side.
  REQUEST_PRACTICE_PREFERENCE: 'request_practice_preference',
  DECIDE_PRACTICE_PREFERENCE: 'decide_practice_preference',

  // Portable-lighting overrides (8.9 D14): coaches of the slot request, only
  // admins decide or set. The RPCs enforce the same split server-side.
  REQUEST_PRACTICE_LIGHTING_OVERRIDE: 'request_practice_lighting_override',
  DECIDE_PRACTICE_LIGHTING_OVERRIDE: 'decide_practice_lighting_override',
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
    PERMISSIONS.REQUEST_PRACTICE_LIGHTING_OVERRIDE,
    PERMISSIONS.DECIDE_PRACTICE_LIGHTING_OVERRIDE,
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
    PERMISSIONS.REQUEST_PRACTICE_LIGHTING_OVERRIDE,
    PERMISSIONS.DECIDE_PRACTICE_LIGHTING_OVERRIDE,
  ],
  [ROLES.COACH]: [
    PERMISSIONS.VIEW_ORGANIZATION,
    PERMISSIONS.MANAGE_OWN_TEAM,
    // Not VIEW_ALL_TEAMS: a coach sees their own team only (Phase A3, owner
    // decision 2026-10-20); the league's rosters are an admin's.
    PERMISSIONS.MANAGE_SCHEDULE, // their own games
    PERMISSIONS.VIEW_SCHEDULE,
    PERMISSIONS.REQUEST_PRACTICE_PREFERENCE,
    PERMISSIONS.REQUEST_PRACTICE_LIGHTING_OVERRIDE,
  ],
  [ROLES.PLAYER]: [
    PERMISSIONS.VIEW_ORGANIZATION,
    PERMISSIONS.VIEW_OWN_TEAM,
    PERMISSIONS.VIEW_SCHEDULE,
  ],
  [ROLES.PARENT]: [
    PERMISSIONS.VIEW_ORGANIZATION,
    PERMISSIONS.VIEW_OWN_TEAM,
    PERMISSIONS.VIEW_SCHEDULE,
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
