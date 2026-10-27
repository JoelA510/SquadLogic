import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import {
  ADMIN_ROLES,
  ASSIGNABLE_ROLES,
  PERMISSIONS,
  ROLE_PERMISSIONS,
  ROLES,
  hasPermission,
  isAdminRole,
} from '../frontend/src/constants/permissions.js';
import { NAV } from '../frontend/src/constants/navigation.js';

/**
 * Staff are admins (owner decision 2026-10-20; migration 20261020030000). Three
 * places say which organization roles are admin-equivalent: the database's
 * `is_org_admin()`, the Edge Functions' `verifyOrgAdmin`, and the frontend's
 * ADMIN_ROLES. This holds them equal, reading the database's from the latest
 * migration that defines it, not from either JS copy.
 */

const MIGRATIONS = path.resolve('supabase/migrations');

/**
 * The Edge copy, read from the source: `_shared/auth.ts` imports from URLs,
 * which Node's loader refuses, so it cannot be imported here.
 */
function edgeAdminRoles() {
  const src = readFileSync(path.resolve('supabase/functions/_shared/auth.ts'), 'utf8');
  const match = /export const ADMIN_ROLES[^=]*=\s*Object\.freeze\(\[([^\]]*)\]\)/.exec(src);
  if (!match) throw new Error('no ADMIN_ROLES found in _shared/auth.ts');
  return match[1].split(',').map((r) => r.trim().replace(/^'|'$/g, ''));
}

/** The role list in the latest migration's `is_org_admin` body. */
function databaseAdminRoles() {
  const latest = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => readFileSync(path.join(MIGRATIONS, f), 'utf8'))
    .filter((sql) => /FUNCTION public\.is_org_admin\(/.test(sql))
    .pop();
  const body = latest.slice(latest.lastIndexOf('FUNCTION public.is_org_admin('));
  const match = /AND role IN \(([^)]*)\)/.exec(body);
  if (!match) throw new Error('no role list found in the latest is_org_admin');
  return match[1].split(',').map((r) => r.trim().replace(/^'|'$/g, ''));
}

describe('which organization roles are admins', () => {
  it('is the same list in the database, the Edge Functions and the frontend', () => {
    const db = databaseAdminRoles().sort();
    expect(db).toEqual(['admin', 'staff', 'tenant_admin']);
    expect(edgeAdminRoles().sort()).toEqual(db);
    expect(readFileSync(path.resolve('supabase/functions/_shared/auth.ts'), 'utf8')).toContain(
      ".in('role', [...ADMIN_ROLES])"
    );
    expect([...ADMIN_ROLES].sort()).toEqual(db);
  });

  it('gives staff every permission an admin has, and nothing less', () => {
    for (const permission of Object.values(PERMISSIONS)) {
      expect(hasPermission(ROLES.STAFF, permission), permission).toBe(
        hasPermission(ROLES.ADMIN, permission)
      );
    }
    expect(ROLE_PERMISSIONS[ROLES.STAFF]).toContain(PERMISSIONS.MANAGE_ORGANIZATION);
  });

  it('counts staff, admin and tenant_admin as admin roles, and no other', () => {
    expect(isAdminRole('staff')).toBe(true);
    expect(isAdminRole('admin')).toBe(true);
    expect(isAdminRole('tenant_admin')).toBe(true);
    for (const role of ['coach', 'parent', 'player', '', undefined]) {
      expect(isAdminRole(role)).toBe(false);
    }
  });

  // Only league admins sign in (docs/changes/2026-10-27-admin-only.md): every role the app knows,
  // and every role an admin can assign, is an admin role, so no role outside ADMIN_ROLES has a
  // permission or a nav.
  it('has no role outside ADMIN_ROLES: not in ROLES, not assignable, no permissions', () => {
    expect(Object.values(ROLES).sort()).toEqual([...ADMIN_ROLES].sort());
    expect(Object.keys(ROLE_PERMISSIONS).sort()).toEqual([...ADMIN_ROLES].sort());
    for (const role of ASSIGNABLE_ROLES) expect(isAdminRole(role), role).toBe(true);
    expect([...ASSIGNABLE_ROLES]).toEqual([ROLES.ADMIN, ROLES.STAFF]);
    for (const role of ['coach', 'parent', 'player']) {
      expect(ROLE_PERMISSIONS[role], role).toBeUndefined();
      for (const permission of Object.values(PERMISSIONS)) {
        expect(hasPermission(role, permission), `${role} ${permission}`).toBe(false);
      }
    }
  });

  it('gives every nav item a permission an admin role holds', () => {
    /** @type {any[]} */
    const items = [];
    for (const node of NAV) items.push(...(node.type === 'item' ? [node] : node.items));
    expect(items.length).toBeGreaterThan(10);
    for (const item of items) {
      if (!item.permission) continue;
      expect(hasPermission(ROLES.ADMIN, item.permission), item.id).toBe(true);
    }
    expect(items.map((item) => item.id)).toContain('permits');
  });
});
