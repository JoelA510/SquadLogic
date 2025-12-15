import React, { createContext, useContext, useEffect, useState } from 'react';
import { supabase } from '../utils/supabaseClient.js';

const AuthContext = createContext({});

export const useAuth = () => useContext(AuthContext);

export const AuthProvider = ({ children }) => {
    const [session, setSession] = useState(null);
    const [user, setUser] = useState(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        if (!supabase) {
            setLoading(false);
            return;
        }

        // Listen for changes
        const {
            data: { subscription },
        } = supabase.auth.onAuthStateChange(async (_event, session) => {
            setSession(session);

            if (session?.user) {
                // Fetch profile
                const { data: profile } = await supabase
                    .from('profiles')
                    .select('*')
                    .eq('id', session.user.id)
                    .single();

                // Merge profile data into user object for convenience, or keep separate
                // Here we keep user object as is, but could add specific profile logic
                setUser({ ...session.user, profile });
            } else {
                setUser(null);
            }

            setLoading(false);
        });

        return () => subscription.unsubscribe();
    }, []);

    const value = {
        session,
        user,
        loading,
        signOut: () => supabase?.auth.signOut(),
        isConfigured: !!supabase,
        isAdmin: session?.user?.app_metadata?.role === 'admin',
        isCoach: session?.user?.app_metadata?.role === 'coach',
    };

    return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};
