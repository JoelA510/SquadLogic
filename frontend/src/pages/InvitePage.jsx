import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Ticket, AlertCircle, CheckCircle } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext.jsx';
import { useOrganization } from '../contexts/OrganizationContext.jsx';
import { supabase } from '../lib/supabaseClient.js';
import { logger } from '../lib/logger.js';
import LoadingScreen from '../components/LoadingScreen.jsx';
import Login from '../components/Login.jsx';
import Button from '../components/ui/Button.jsx';
import { writePendingInvite, clearPendingInvite } from '../lib/inviteStorage.js';

/**
 * /invite/:code deep-link.
 *
 * States:
 *   - Auth context still loading → LoadingScreen
 *   - Unauthenticated → stash the code and render the Login screen INLINE
 *     (sign-in or sign-up) under an invite banner. The URL stays on
 *     /invite/:code, so the moment a session appears — password sign-in,
 *     auto-confirmed sign-up, or an email confirmation completed in another
 *     tab (Supabase syncs sessions across tabs) — the redeem effect below
 *     fires without any further navigation.
 *   - Authenticated → auto-call redeem RPC.
 *   - Error from redeem → show error card.
 */
export default function InvitePage() {
  const { code } = useParams();
  const { session, loading: authLoading } = useAuth();
  const { refetchOrgs } = useOrganization();
  const navigate = useNavigate();

  const [state, setState] = useState({ status: 'idle', error: null, orgId: null });

  useEffect(() => {
    if (authLoading) return;

    if (!session) {
      // Unauthenticated — stash the code (OrganizationCreation pre-fills it
      // for brand-new users who end up there) and render Login below.
      if (code) writePendingInvite(code);
      return;
    }

    // Authenticated. Redeem once on mount.
    let cancelled = false;
    setState({ status: 'redeeming', error: null, orgId: null });

    (async () => {
      try {
        const { data, error } = await supabase.rpc('redeem_org_invite', { p_code: code });
        if (error) throw error;
        if (cancelled) return;
        clearPendingInvite();
        setState({ status: 'success', error: null, orgId: data });
      } catch (err) {
        logger.error('Invite redeem failed', err);
        if (cancelled) return;
        setState({ status: 'error', error: err, orgId: null });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [authLoading, session, code]);

  // Success → refetch OrganizationContext so the new membership is picked up
  // without a full-page reload, then SPA-navigate into the dashboard. This
  // replaces the earlier `window.location.href = '/?joined=true'` which
  // destroyed application state on every successful redeem (Gemini PR #179
  // review).
  useEffect(() => {
    if (state.status !== 'success') return;
    if (typeof refetchOrgs === 'function') refetchOrgs();
    const t = setTimeout(() => {
      navigate('/?joined=true', { replace: true });
    }, 1200);
    return () => clearTimeout(t);
  }, [state.status, refetchOrgs, navigate]);

  if (authLoading) return <LoadingScreen message="Validating invite..." />;

  // Unauthenticated — keep the user on this URL and let them sign in or
  // create an account right here; the redeem effect runs once they do.
  if (!session) {
    return (
      <>
        <div
          role="status"
          className="fixed top-0 left-0 right-0 z-50 flex items-center justify-center gap-2 py-2.5 px-4 bg-[var(--primary-weak)] text-[var(--text-primary)] border-b border-[var(--border)] text-sm font-semibold"
        >
          <Ticket size={16} aria-hidden="true" />
          You&apos;ve been invited to join an organization — sign in or create an account to accept.
        </div>
        <Login />
      </>
    );
  }

  if (state.status === 'redeeming' || state.status === 'idle') {
    return <LoadingScreen message="Joining organization..." />;
  }

  if (state.status === 'success') {
    return (
      <div className="min-h-screen bg-bg-app flex items-center justify-center p-6 animate-fadeIn">
        <div className="max-w-md w-full glass-panel-premium p-10 text-center space-y-6">
          <div className="w-20 h-20 bg-green-500/20 text-status-success-text rounded-full flex items-center justify-center mx-auto animate-bounce">
            <CheckCircle size={48} />
          </div>
          <h2 className="text-2xl font-bold text-text-primary tracking-tight">You&apos;re in!</h2>
          <p className="text-text-muted text-sm">Loading your dashboard...</p>
        </div>
      </div>
    );
  }

  // error
  const msg = state.error?.message || 'Could not redeem this invite code.';
  return (
    <div className="min-h-screen bg-bg-app flex items-center justify-center p-6 animate-fadeIn">
      <div className="max-w-md w-full glass-panel-premium p-10 space-y-6">
        <div className="flex items-start gap-4">
          <div className="p-3 bg-red-500/10 text-status-error-text rounded-2xl shrink-0">
            <AlertCircle size={24} />
          </div>
          <div className="space-y-2">
            <h2 className="text-2xl font-bold text-text-primary tracking-tight">
              Invite could not be redeemed
            </h2>
            <p className="text-sm text-text-muted leading-relaxed break-words">{msg}</p>
          </div>
        </div>
        <div className="flex gap-3 pt-2">
          <Button
            variant="primary"
            onClick={() => navigate('/', { replace: true })}
            className="flex items-center gap-2"
          >
            <Ticket size={16} /> Back to onboarding
          </Button>
        </div>
      </div>
    </div>
  );
}
