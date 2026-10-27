import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { usePermission } from '../frontend/src/hooks/usePermission.js';
import { PERMISSIONS, ROLES } from '../frontend/src/constants/permissions.js';
import * as OrgContext from '../frontend/src/contexts/OrganizationContext.jsx';
import { makeOrganizationMember } from './factories/index.js';

// Mock useOrganization
vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: vi.fn(),
}));

describe('usePermission', () => {
  it('should return false if no org member', () => {
    /** @type {any} */ (OrgContext.useOrganization).mockReturnValue({ orgMember: null });
    const { result } = renderHook(() => usePermission());
    expect(result.current.can(PERMISSIONS.MANAGE_ORGANIZATION)).toBe(false);
  });

  it('should allow Admin to manage organization', () => {
    /** @type {any} */ (OrgContext.useOrganization).mockReturnValue({
      orgMember: makeOrganizationMember({ role: ROLES.ADMIN }),
    });
    const { result } = renderHook(() => usePermission());
    expect(result.current.can(PERMISSIONS.MANAGE_ORGANIZATION)).toBe(true);
  });

  it('should allow Admin to manage global settings (Season Setup) like the backend does', () => {
    // initialize_new_tenant assigns new-org creators role 'admin', and
    // is_org_admin() treats admin/tenant_admin as equivalent — the Season
    // Setup routes gated by MANAGE_GLOBAL_SETTINGS must agree or self-serve
    // onboarding dead-ends with "Unauthorized access".
    /** @type {any} */ (OrgContext.useOrganization).mockReturnValue({
      orgMember: makeOrganizationMember({ role: ROLES.ADMIN }),
    });
    const { result } = renderHook(() => usePermission());
    expect(result.current.can(PERMISSIONS.MANAGE_GLOBAL_SETTINGS)).toBe(true);
  });

  // No coach, parent or player role (20261024010000, R3; docs/changes/2026-10-27-admin-only.md):
  // only league admins sign in, and a membership still carrying one of those roles (a stale cache,
  // a row written before the migration) is granted nothing.
  it.each(['coach', 'parent', 'player'])('grants a stale %s role no permission', (role) => {
    /** @type {any} */ (OrgContext.useOrganization).mockReturnValue({
      orgMember: makeOrganizationMember({ role }),
    });
    const { result } = renderHook(() => usePermission());
    for (const permission of Object.values(PERMISSIONS)) {
      expect(result.current.can(permission), permission).toBe(false);
    }
  });

  it('has no coach role and no permission only a coach held', () => {
    expect(ROLES).not.toHaveProperty('COACH');
    for (const stale of ['manage_own_team', 'request_practice_preference']) {
      expect(Object.values(PERMISSIONS)).not.toContain(stale);
    }
  });
});
