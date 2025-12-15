import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { usePermission } from '../frontend/src/hooks/usePermission.js';
import { PERMISSIONS, ROLES } from '../frontend/src/constants/permissions.js';
import * as OrgContext from '../frontend/src/contexts/OrganizationContext.jsx';

// Mock useOrganization
vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
    useOrganization: vi.fn()
}));

describe('usePermission', () => {
    it('should return false if no org member', () => {
        OrgContext.useOrganization.mockReturnValue({ orgMember: null });
        const { result } = renderHook(() => usePermission());
        expect(result.current.can(PERMISSIONS.MANAGE_ORGANIZATION)).toBe(false);
    });

    it('should allow Admin to manage organization', () => {
        OrgContext.useOrganization.mockReturnValue({ orgMember: { role: ROLES.ADMIN } });
        const { result } = renderHook(() => usePermission());
        expect(result.current.can(PERMISSIONS.MANAGE_ORGANIZATION)).toBe(true);
    });

    it('should deny Player from managing organization', () => {
        OrgContext.useOrganization.mockReturnValue({ orgMember: { role: ROLES.PLAYER } });
        const { result } = renderHook(() => usePermission());
        expect(result.current.can(PERMISSIONS.MANAGE_ORGANIZATION)).toBe(false);
    });

    it('should allow Player to view own team', () => {
        OrgContext.useOrganization.mockReturnValue({ orgMember: { role: ROLES.PLAYER } });
        const { result } = renderHook(() => usePermission());
        expect(result.current.can(PERMISSIONS.VIEW_OWN_TEAM)).toBe(true);
    });
});
