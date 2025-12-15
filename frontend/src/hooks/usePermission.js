import { useCallback } from 'react';
import { useOrganization } from '../contexts/OrganizationContext.jsx';
import { hasPermission, PERMISSIONS } from '../constants/permissions.js';

export const usePermission = () => {
    const { orgMember } = useOrganization();

    const can = useCallback((permission) => {
        if (!orgMember || !orgMember.role) return false;
        return hasPermission(orgMember.role, permission);
    }, [orgMember]);

    return {
        can,
        role: orgMember?.role,
        PERMISSIONS
    };
};
