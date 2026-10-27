import React, { createContext, useContext, useEffect, useState } from 'react';
import { supabase } from '../lib/supabaseClient.js';
import { logger } from '../lib/logger.js';

/**
 * @typedef {Object} AuthContextValue
 * @property {any} session
 * @property {any} user
 * @property {boolean} loading
 * @property {() => Promise<any>} signOut
 * @property {(email: string, options?: { captchaToken?: string }) => Promise<{error: any}>} resetPasswordForEmail
 * @property {(password: string, options?: { organizationId?: string }) => Promise<{error: any}>} updatePassword
 * @property {boolean} isConfigured
 * @property {boolean} isAdmin
 */

/** @type {React.Context<AuthContextValue>} */
const AuthContext = createContext({});

/** @returns {AuthContextValue} */
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

    let cancelled = false;
    // Versioning counter: both getSession() and onAuthStateChange may resolve
    // in either order (especially on pages that sign the user in and redirect
    // within the same render cycle). If a stale `applySession` resolves after
    // a fresh one has already landed, its setState calls would overwrite the
    // correct session with outdated data. Each call captures its own version;
    // setState only fires when myVersion === currentVersion.
    let currentVersion = 0;

    // The user ID error reports are currently tagged with (M1.5). Sentry is
    // told on sign-in and sign-out only: a token refresh re-runs applySession
    // for the same user, and re-sending the profile's organization then would
    // overwrite the active one OrganizationContext set after it.
    let reportedUserId = null;
    const reportUser = (sessionUser, profile) => {
      if (sessionUser.id === reportedUserId) return;
      reportedUserId = sessionUser.id;
      logger.setUser({
        id: sessionUser.id,
        organization_id: profile?.organization_id ?? null,
        role: profile?.role ?? null,
      });
    };

    // Safety net: if nothing has resolved auth within 5 s, stop blocking the
    // UI so the user sees either the app or the sign-in screen instead of a
    // permanent loading spinner. Intentionally NOT cleared inside the auth
    // handler — the only way to clear it is the finally block below, which
    // also guarantees setLoading(false) runs.
    const safetyTimer = setTimeout(() => {
      if (cancelled) return;
      console.warn(
        '[Auth] Safety timeout — auth resolution did not complete within 5 s. Clearing loading state.'
      );
      setLoading(false);
    }, 5000);

    // Hydrate the profile for a given session. Resilient to fetch errors:
    // any failure still yields a user object (so the app can render) and
    // always flips loading=false.
    const applySession = async (session) => {
      if (cancelled) return;
      const myVersion = ++currentVersion;
      setSession(session);
      try {
        if (session?.user) {
          try {
            const { data: profile, error } = await supabase
              .from('profiles')
              .select('*')
              .eq('id', session.user.id)
              .single();
            // supabase-js returns failures as `{ data: null, error }` rather
            // than throwing — explicitly throw so the catch handles RLS
            // violations, PGRST116 missing-row, network 5xx, etc. uniformly.
            if (error) throw error;
            if (cancelled || myVersion !== currentVersion) return;
            setUser({ ...session.user, profile: profile || null });
            reportUser(session.user, profile);
          } catch (err) {
            // Profile fetch can fail on network blips, brief RLS gaps during
            // migrations, or missing profiles row. Fall back to the bare
            // session user so the rest of the app can keep rendering — any
            // downstream feature that needs the profile will re-fetch.
            console.warn('[Auth] Profile fetch failed; using session user only', err);
            if (cancelled || myVersion !== currentVersion) return;
            setUser({ ...session.user, profile: null });
            reportUser(session.user, null);
          }
        } else {
          if (myVersion !== currentVersion) return;
          setUser(null);
          if (reportedUserId !== null) {
            reportedUserId = null;
            logger.setUser(null);
          }
          // Sign-out leaves any demo: the tag must not outlive the visitor's session (D4).
          logger.setDemoContext(false);
        }
      } finally {
        if (!cancelled && myVersion === currentVersion) {
          clearTimeout(safetyTimer);
          setLoading(false);
        }
      }
    };

    // Kick off an initial getSession() so we don't depend on
    // onAuthStateChange firing — some supabase-js paths (corrupt localStorage,
    // refresh-token errors, missing INITIAL_SESSION event in offline mode)
    // can leave the subscriber without a synthetic initial event.
    supabase.auth
      .getSession()
      .then(({ data: { session } }) => applySession(session))
      .catch((err) => {
        console.warn('[Auth] getSession() failed; proceeding unauthenticated', err);
        if (!cancelled) {
          clearTimeout(safetyTimer);
          setLoading(false);
        }
      });

    // Subscribe for future changes (sign in, sign out, token refresh, etc.).
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      applySession(session);
    });

    return () => {
      cancelled = true;
      clearTimeout(safetyTimer);
      subscription.unsubscribe();
    };
    // One-shot subscription — intentionally omit `loading` from deps to avoid
    // tearing down and re-subscribing on every state flip, which caused
    // races between old and new handlers on the old version of this effect.
  }, []);

  // `captchaToken` is the Turnstile token the project's CAPTCHA setting requires on this call
  // (D4); omitted, none is sent.
  /**
   * @param {string} email
   * @param {{ captchaToken?: string }} [options]
   */
  const resetPasswordForEmail = async (email, { captchaToken } = {}) => {
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/auth/reset-password`,
        ...(captchaToken ? { captchaToken } : {}),
      });
      if (error) throw error;
      return { error: null };
    } catch (err) {
      console.error('[Auth] Reset password request failed:', err);
      return { error: err };
    }
  };

  // `organizationId` is the organization the caller is working in (the active one): an admin can
  // belong to several, and the audit row names the one the change was made from. Without it (the
  // reset-password page, before an organization is chosen) the stored active organization is used
  // when the caller is a member of it, else the first membership.
  /**
   * @param {string} newPassword
   * @param {{ organizationId?: string }} [options]
   */
  const updatePassword = async (newPassword, { organizationId } = {}) => {
    try {
      const { data, error } = await supabase.auth.updateUser({
        password: newPassword,
        data: { password_length: newPassword.length },
      });
      if (error) throw error;

      // Log the password update
      if (data.user) {
        let orgId = organizationId;
        if (!orgId) {
          const { data: memberships, error: membershipError } = await supabase
            .from('organization_members')
            .select('organization_id')
            .eq('profile_id', data.user.id);
          if (membershipError) {
            // The password is already changed; only its audit row cannot be addressed.
            console.error('[Auth] password audit: memberships not read:', membershipError);
          }
          const ids = (memberships || []).map((row) => row.organization_id);
          let stored = null;
          try {
            stored = localStorage.getItem('squadlogic_active_org');
          } catch {
            // Storage can be blocked (private window): fall through to the first membership.
          }
          orgId = stored && ids.includes(stored) ? stored : ids[0];
        }

        if (orgId) {
          await supabase.rpc('record_audit_event', {
            p_organization_id: orgId,
            p_action: 'auth.password_updated',
            p_metadata: { user_id: data.user.id },
          });
        }
      }

      return { error: null };
    } catch (err) {
      console.error('[Auth] Password update failed:', err);
      return { error: err };
    }
  };

  const value = {
    session,
    user,
    loading,
    signOut: () => supabase?.auth.signOut(),
    resetPasswordForEmail,
    updatePassword,
    isConfigured: !!supabase,
    isAdmin: user?.profile?.role === 'admin',
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};
