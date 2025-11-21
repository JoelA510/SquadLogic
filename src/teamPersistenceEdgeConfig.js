const DEFAULT_ALLOWED_ROLES = ['admin', 'scheduler'];

export function parseAllowedRolesEnv(value, { fallbackRoles = DEFAULT_ALLOWED_ROLES } = {}) {
  let roles;

  if (value === undefined || value === null) {
    roles = fallbackRoles;
  } else if (typeof value === 'string') {
    roles = value.split(',');
  } else if (Array.isArray(value)) {
    roles = value;
  } else {
    throw new TypeError('allowed roles must be a comma-separated string or array');
  }

  const normalized = roles
    .map((role) => (typeof role === 'string' ? role.trim().toLowerCase() : ''))
    .filter((role) => role.length > 0);

  if (normalized.length === 0) {
    throw new Error('at least one allowed role is required');
  }

  return normalized;
}

export { DEFAULT_ALLOWED_ROLES };
