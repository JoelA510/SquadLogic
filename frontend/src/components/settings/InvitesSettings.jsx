import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Ticket,
  Copy,
  CheckCircle,
  AlertCircle,
  Link2,
  Trash2,
  RefreshCw,
  Plus,
} from 'lucide-react';
import { supabase } from '../../lib/supabaseClient.js';
import { logger } from '../../lib/logger.js';
import { useOrganization } from '../../contexts/OrganizationContext.jsx';
import Button from '../ui/Button.jsx';
import { ASSIGNABLE_ROLES } from '../../constants/permissions.js';

const ROLE_LABELS = { admin: 'Admin', coach: 'Coach', staff: 'Staff' };
// The roles create_org_invite accepts (no parent or player since 20261024010000).
const ROLE_OPTIONS = ASSIGNABLE_ROLES.map((value) => ({ value, label: ROLE_LABELS[value] }));

const EXPIRY_OPTIONS = [
  { value: '1 day', label: '1 day' },
  { value: '7 days', label: '7 days' },
  { value: '30 days', label: '30 days' },
  { value: '', label: 'No expiry' },
];

/**
 * Admin-only. Lists the current org's invite codes and lets an admin mint
 * new ones + revoke unused ones.
 */
export default function InvitesSettings() {
  const { currentOrganization } = useOrganization();
  const orgId = currentOrganization?.id;

  const [invites, setInvites] = useState([]);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState(null);

  const [role, setRole] = useState('coach');
  const [expiresIn, setExpiresIn] = useState('7 days');
  const [creating, setCreating] = useState(false);
  const [revokingId, setRevokingId] = useState(null);
  const [createError, setCreateError] = useState(null);
  const [justCreated, setJustCreated] = useState(null);
  const [copiedKey, setCopiedKey] = useState(null);

  const loadInvites = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    setFetchError(null);
    try {
      const { data, error } = await supabase
        .from('organization_invites')
        .select('*')
        .eq('organization_id', orgId)
        .order('created_at', { ascending: false });
      if (error) throw error;
      setInvites(data || []);
    } catch (err) {
      logger.error('Error fetching invites', err);
      setFetchError(err);
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => {
    loadInvites();
  }, [loadInvites]);

  const handleCreate = async (e) => {
    e.preventDefault();
    if (!orgId) return;
    setCreating(true);
    setCreateError(null);
    try {
      const args = {
        p_org_id: orgId,
        p_role: role,
      };
      // Only pass p_expires_in when the user chose an interval — otherwise let
      // the RPC default (7 days) apply. Empty string = "No expiry".
      if (expiresIn === '') {
        args.p_expires_in = null;
      } else {
        args.p_expires_in = expiresIn;
      }
      const { data, error } = await supabase.rpc('create_org_invite', args);
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      setJustCreated(row);
      await loadInvites();
    } catch (err) {
      logger.error('Failed to create invite', err);
      setCreateError(err);
    } finally {
      setCreating(false);
    }
  };

  const handleRevoke = async (id) => {
    if (!orgId || revokingId) return;
    setFetchError(null);
    setRevokingId(id);
    try {
      const { error } = await supabase.rpc('revoke_org_invite', {
        p_organization_id: orgId,
        p_invite_id: id,
      });
      if (error) throw error;
      await loadInvites();
    } catch (err) {
      logger.error('Failed to revoke invite', err);
      setFetchError(err);
    } finally {
      setRevokingId(null);
    }
  };

  const copy = async (key, text) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey((k) => (k === key ? null : k)), 1500);
    } catch {
      /* clipboard blocked */
    }
  };

  const inviteUrlFor = useCallback(
    (code) => `${window.location.origin}/invite/${encodeURIComponent(code)}`,
    []
  );

  const unusedCount = useMemo(() => invites.filter((i) => !i.used_at).length, [invites]);

  if (!orgId) return null;

  return (
    <div className="space-y-8">
      <header className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-text-primary flex items-center gap-2">
            <Ticket size={18} /> Invites
          </h2>
          <p className="text-xs text-text-muted mt-1">
            Single-use codes that add someone to this organization with a preset role.
            {unusedCount > 0 ? ` ${unusedCount} active.` : ''}
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={loadInvites} className="flex items-center gap-2">
          <RefreshCw size={14} /> Refresh
        </Button>
      </header>

      {/* Create form */}
      <form
        onSubmit={handleCreate}
        className="glass-panel p-5 space-y-4"
        aria-label="Create new invite"
      >
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="space-y-1.5">
            <label
              htmlFor="invite-role"
              className="text-[10px] font-bold text-text-muted uppercase tracking-widest"
            >
              Role
            </label>
            <select
              id="invite-role"
              value={role}
              onChange={(e) => setRole(e.target.value)}
              className="w-full glass-input"
            >
              {ROLE_OPTIONS.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1.5">
            <label
              htmlFor="invite-expiry"
              className="text-[10px] font-bold text-text-muted uppercase tracking-widest"
            >
              Expires in
            </label>
            <select
              id="invite-expiry"
              value={expiresIn}
              onChange={(e) => setExpiresIn(e.target.value)}
              className="w-full glass-input"
            >
              {EXPIRY_OPTIONS.map((e) => (
                <option key={e.label} value={e.value}>
                  {e.label}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1.5 flex flex-col justify-end">
            <Button
              type="submit"
              variant="primary"
              disabled={creating}
              className="flex items-center justify-center gap-2"
            >
              <Plus size={16} /> {creating ? 'Generating...' : 'Generate invite'}
            </Button>
          </div>
        </div>

        {createError && (
          <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-xl flex items-center gap-2 text-status-error-text text-xs">
            <AlertCircle size={14} className="shrink-0" />
            {createError.message || 'Failed to create invite'}
          </div>
        )}

        {justCreated?.code && (
          <div className="p-4 bg-green-500/10 border border-green-500/20 rounded-xl space-y-3 animate-slideUp">
            <div className="flex items-center gap-2 text-status-success-text text-xs font-bold uppercase tracking-widest">
              <CheckCircle size={14} /> Invite ready — share either the code or the link
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <CopyRow
                label="Code"
                value={justCreated.code}
                onCopy={() => copy('new-code', justCreated.code)}
                copied={copiedKey === 'new-code'}
                mono
              />
              <CopyRow
                label="Link"
                icon={Link2}
                value={inviteUrlFor(justCreated.code)}
                onCopy={() => copy('new-link', inviteUrlFor(justCreated.code))}
                copied={copiedKey === 'new-link'}
              />
            </div>
            {justCreated.expires_at && (
              <p className="text-[10px] text-text-muted">
                Expires {new Date(justCreated.expires_at).toLocaleString()}
              </p>
            )}
          </div>
        )}
      </form>

      {/* List */}
      {fetchError && (
        <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-xl flex items-center gap-2 text-status-error-text text-xs">
          <AlertCircle size={14} className="shrink-0" />
          {fetchError.message || 'Could not load invites'}
        </div>
      )}

      {loading ? (
        <p className="text-xs text-text-muted italic">Loading invites...</p>
      ) : invites.length === 0 ? (
        <p className="text-xs text-text-muted italic">No invites issued yet.</p>
      ) : (
        <ul className="space-y-2">
          {invites.map((inv) => {
            const isExpired = inv.expires_at && new Date(inv.expires_at) < new Date();
            const status = inv.used_at
              ? { label: 'Redeemed', color: 'text-text-muted', bg: 'bg-bg-glass' }
              : isExpired
                ? { label: 'Expired', color: 'text-status-warning-text', bg: 'bg-amber-500/10' }
                : { label: 'Active', color: 'text-status-success-text', bg: 'bg-green-500/10' };
            return (
              <li
                key={inv.id}
                className="glass-panel p-4 flex flex-col md:flex-row md:items-center gap-3"
              >
                <div className="flex-1 min-w-0 space-y-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <code className="text-lg font-mono tracking-widest text-text-primary">
                      {inv.code}
                    </code>
                    <span
                      className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-widest ${status.bg} ${status.color}`}
                    >
                      {status.label}
                    </span>
                    <span className="text-[10px] text-text-muted uppercase tracking-widest">
                      {inv.role}
                    </span>
                  </div>
                  <p className="text-[10px] text-text-muted">
                    Created {new Date(inv.created_at).toLocaleString()}
                    {inv.expires_at
                      ? ` · Expires ${new Date(inv.expires_at).toLocaleString()}`
                      : ' · No expiry'}
                    {inv.used_at ? ` · Used ${new Date(inv.used_at).toLocaleString()}` : ''}
                  </p>
                </div>

                {!inv.used_at && !isExpired && (
                  <div className="flex items-center gap-2 shrink-0">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => copy(`link-${inv.id}`, inviteUrlFor(inv.code))}
                      className="flex items-center gap-1"
                      aria-label="Copy invite link"
                    >
                      <Copy size={14} />
                      {copiedKey === `link-${inv.id}` ? 'Copied' : 'Copy link'}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleRevoke(inv.id)}
                      disabled={revokingId === inv.id}
                      className="flex items-center gap-1 text-status-error-text"
                      aria-label="Revoke invite"
                    >
                      <Trash2 size={14} />
                      {revokingId === inv.id ? 'Revoking...' : 'Revoke'}
                    </Button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function CopyRow({ label, value, onCopy, copied, mono = false, icon: Icon = null }) {
  return (
    <div className="bg-bg-app border border-border-subtle rounded-lg p-2.5 flex items-center gap-2">
      <span className="text-[10px] font-bold text-text-muted uppercase tracking-widest shrink-0 flex items-center gap-1">
        {Icon ? <Icon size={12} /> : null}
        {label}
      </span>
      <code
        className={`flex-1 text-xs truncate ${mono ? 'font-mono tracking-widest' : ''} text-text-primary`}
      >
        {value}
      </code>
      <button
        type="button"
        onClick={onCopy}
        className="px-2 py-1 rounded bg-brand-500/10 text-text-accent text-[10px] font-bold uppercase tracking-widest hover:bg-brand-500/20 flex items-center gap-1 shrink-0"
      >
        {copied ? <CheckCircle size={12} /> : <Copy size={12} />}
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}
