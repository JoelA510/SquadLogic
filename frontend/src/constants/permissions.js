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
  RSVP_EVENT: 'rsvp_event',

  // Coach practice preferences (Phase 8.6 PR 3b): coaches request, only admins
  // decide or set. The RPCs enforce the same split server-side.
  REQUEST_PRACTICE_PREFERENCE: 'request_practice_preference',
  DECIDE_PRACTICE_PREFERENCE: 'decide_practice_preference',
};

export const ROLE_PERMISSIONS = {
  [ROLES.TENANT_ADMIN]: [
    PERMISSIONS.MANAGE_ORGANIZATION,
    PERMISSIONS.VIEW_ORGANIZATION,
    PERMISSIONS.MANAGE_GLOBAL_SETTINGS,
    PERMISSIONS.MANAGE_ALL_TEAMS,
    PERMISSIONS.VIEW_ALL_TEAMS,
    PERMISSIONS.MANAGE_SCHEDULE,
    PERMISSIONS.VIEW_SCHEDULE,
    PERMISSIONS.RSVP_EVENT,
    PERMISSIONS.REQUEST_PRACTICE_PREFERENCE,
    PERMISSIONS.DECIDE_PRACTICE_PREFERENCE,
  ],
  [ROLES.ADMIN]: [
    PERMISSIONS.MANAGE_ORGANIZATION,
    PERMISSIONS.VIEW_ORGANIZATION,
    // Backend parity: is_org_admin() treats 'admin' and 'tenant_admin' as
    // equivalent, and initialize_new_tenant assigns new-org creators 'admin' —
    // without this grant a self-serve org creator is locked out of Season
    // Setup by the frontend while the database would allow every mutation.
    PERMISSIONS.MANAGE_GLOBAL_SETTINGS,
    PERMISSIONS.MANAGE_ALL_TEAMS,
    PERMISSIONS.VIEW_ALL_TEAMS,
    PERMISSIONS.MANAGE_SCHEDULE,
    PERMISSIONS.VIEW_SCHEDULE,
    PERMISSIONS.RSVP_EVENT,
    PERMISSIONS.REQUEST_PRACTICE_PREFERENCE,
    PERMISSIONS.DECIDE_PRACTICE_PREFERENCE,
  ],
  [ROLES.COACH]: [
    PERMISSIONS.VIEW_ORGANIZATION,
    PERMISSIONS.MANAGE_OWN_TEAM,
    PERMISSIONS.VIEW_ALL_TEAMS, // Coaches usually can see other teams in the league
    PERMISSIONS.MANAGE_SCHEDULE, // their own games
    PERMISSIONS.VIEW_SCHEDULE,
    PERMISSIONS.RSVP_EVENT,
    PERMISSIONS.REQUEST_PRACTICE_PREFERENCE,
  ],
  [ROLES.STAFF]: [
    PERMISSIONS.VIEW_ORGANIZATION,
    PERMISSIONS.VIEW_ALL_TEAMS,
    PERMISSIONS.MANAGE_SCHEDULE,
    PERMISSIONS.VIEW_SCHEDULE,
  ],
  [ROLES.PLAYER]: [
    PERMISSIONS.VIEW_ORGANIZATION,
    PERMISSIONS.VIEW_OWN_TEAM,
    PERMISSIONS.VIEW_SCHEDULE,
    PERMISSIONS.RSVP_EVENT,
  ],
  [ROLES.PARENT]: [
    PERMISSIONS.VIEW_ORGANIZATION,
    PERMISSIONS.VIEW_OWN_TEAM,
    PERMISSIONS.VIEW_SCHEDULE,
    PERMISSIONS.RSVP_EVENT,
  ],
};

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
