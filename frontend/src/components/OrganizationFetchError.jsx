import React from 'react';
import { AlertTriangle, RefreshCw, LogOut } from 'lucide-react';
import Button from './ui/Button.jsx';
import { supabase } from '../lib/supabaseClient.js';

/**
 * Rendered by AppContent when the initial `organization_members` fetch
 * errors and leaves the app with no org context. Prevents the indistinguishable
 * "Loading SquadLogic..." hang that was surfaced after users signed up but
 * a stale RLS policy on organization_members was still returning 500.
 *
 * Two recovery actions:
 *   - Retry:   call refetchOrgs() to re-run the query without a full reload.
 *   - Sign out: flush the auth session and return to the login screen, which
 *               is the cleanest exit when the error is server-side.
 */
export default function OrganizationFetchError({ error, onRetry }) {
  const handleSignOut = async () => {
    await supabase.auth.signOut();
    window.location.href = '/';
  };

  const message =
    error?.message || (typeof error === 'string' ? error : 'Could not load your organization.');

  const hint = /infinite recursion|500|policy/i.test(message)
    ? 'This usually means a database policy migration is still pending. Ask your operator to run `supabase db push` or apply the latest migrations via the Supabase dashboard, then hit Retry.'
    : 'If the problem persists, try signing out and back in.';

  return (
    <div className="min-h-screen bg-bg-app flex items-center justify-center p-6 animate-fadeIn">
      <div className="max-w-md w-full glass-panel-premium p-10 space-y-6">
        <div className="flex items-start gap-4">
          <div className="p-3 bg-red-500/10 text-status-error-text rounded-2xl shrink-0">
            <AlertTriangle size={24} />
          </div>
          <div className="space-y-2">
            <h2 className="text-2xl font-bold text-text-primary tracking-tight">
              Could not load your organization
            </h2>
            <p className="text-sm text-text-muted leading-relaxed break-words">{message}</p>
          </div>
        </div>
        <p className="text-xs text-text-muted leading-relaxed border-l-2 border-brand-500/40 pl-3">
          {hint}
        </p>
        <div className="flex gap-3 pt-2">
          <Button variant="primary" onClick={onRetry} className="flex items-center gap-2">
            <RefreshCw size={16} /> Retry
          </Button>
          <Button variant="ghost" onClick={handleSignOut} className="flex items-center gap-2">
            <LogOut size={16} /> Sign out
          </Button>
        </div>
      </div>
    </div>
  );
}
