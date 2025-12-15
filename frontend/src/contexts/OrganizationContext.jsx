import React, { createContext, useContext, useEffect, useState } from 'react';
import { supabase } from '../utils/supabaseClient.js';
import { useAuth } from './AuthContext.jsx';

const OrganizationContext = createContext({});

export const useOrganization = () => useContext(OrganizationContext);

export const OrganizationProvider = ({ children }) => {
    const { user } = useAuth();
    const [organizations, setOrganizations] = useState([]);
    const [currentOrganization, setCurrentOrganization] = useState(null);
    const [orgMember, setOrgMember] = useState(null); // The member record for the current org
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        if (!user) {
            setOrganizations([]);
            setCurrentOrganization(null);
            setOrgMember(null);
            return;
        }

        const fetchOrgs = async () => {
            setLoading(true);
            try {
                // Fetch orgs where user is a member
                const { data, error } = await supabase
                    .from('organization_members')
                    .select('*, organizations(*)')
                    .eq('profile_id', user.id);

                if (error) throw error;

                if (data) {
                    setOrganizations(data);
                    // Default to first org if none selected
                    // In real app, might check localStorage or URL param
                    if (data.length > 0 && !currentOrganization) {
                        const first = data[0];
                        setCurrentOrganization(first.organizations);
                        setOrgMember({ role: first.role, ...first });
                    }
                }
            } catch (err) {
                console.error('Error fetching organizations:', err);
            } finally {
                setLoading(false);
            }
        };

        fetchOrgs();
    }, [user]);

    const switchOrganization = (orgId) => {
        const match = organizations.find((m) => m.organization_id === orgId);
        if (match) {
            setCurrentOrganization(match.organizations);
            setOrgMember({ role: match.role, ...match });
        }
    };

    const value = {
        organizations,
        currentOrganization,
        orgMember,
        loading,
        switchOrganization,
    };

    return <OrganizationContext.Provider value={value}>{children}</OrganizationContext.Provider>;
};
