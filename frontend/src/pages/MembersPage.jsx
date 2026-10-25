import React, { useCallback, useEffect, useState } from 'react';
import { Shield, Trash2, Users } from 'lucide-react';
import Page from '../components/chrome/Page.jsx';
import PageHeader from '../components/chrome/PageHeader.jsx';
import InvitesSettings from '../components/settings/InvitesSettings.jsx';
import Button from '../components/ui/Button.jsx';
import Badge from '../components/ui/Badge.jsx';
import { useToast } from '../components/ui/ToastHost.jsx';
import { supabase } from '../lib/supabaseClient.js';
import { useOrganization } from '../contexts/OrganizationContext.jsx';
import { useAuth } from '../contexts/AuthContext.jsx';
import { usePermission } from '../hooks/usePermission.js';
import { logger } from '../lib/logger.js';
import { ASSIGNABLE_ROLES } from '../constants/permissions.js';

// The roles admin_change_member_role accepts (no parent or player since
// 20261024010000).
const ROLE_OPTIONS = ASSIGNABLE_ROLES;
const ROLE_TONE = {
  admin: 'danger',
  coach: 'info',
  staff: 'warning',
};

export default function MembersPage() {
  const { currentOrganization } = useOrganization();
  const { user } = useAuth();
  const { can, PERMISSIONS } = usePermission();
  const toast = useToast();
  const canManage = can(PERMISSIONS.MANAGE_ORGANIZATION);
  const orgId = currentOrganization?.id;

  const [members, setMembers] = useState([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(null);

  const loadMembers = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    try {
      // Profiles RLS only allows reading your own row, so member display data
      // comes from a SECURITY DEFINER RPC gated on org membership.
      const { data, error } = await supabase.rpc('get_organization_members', {
        p_organization_id: orgId,
      });
      if (error) throw error;
      setMembers(
        (data || []).map((row) => ({
          profileId: row.profile_id,
          role: row.role,
          joinedAt: row.created_at,
          email: row.email || '',
          name:
            row.full_name ||
            [row.first_name, row.last_name].filter(Boolean).join(' ') ||
            row.email ||
            'Unknown',
        }))
      );
    } catch (err) {
      logger.error('Failed to load members', err);
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => {
    loadMembers();
  }, [loadMembers]);

  const handleRoleChange = async (profileId, newRole) => {
    setBusy(profileId);
    try {
      const { error } = await supabase.rpc('admin_change_member_role', {
        p_organization_id: orgId,
        p_profile_id: profileId,
        p_role: newRole,
      });
      if (error) throw error;
      toast('Role updated', 'success');
      await loadMembers();
    } catch (err) {
      toast(err?.message || 'Role change failed', 'warning');
    } finally {
      setBusy(null);
    }
  };

  const handleRemove = async (member) => {
    if (!window.confirm(`Remove ${member.name} from this organization? They will lose all access.`))
      return;
    setBusy(member.profileId);
    try {
      const { error } = await supabase.rpc('admin_remove_member', {
        p_organization_id: orgId,
        p_profile_id: member.profileId,
      });
      if (error) throw error;
      toast(`${member.name} removed`, 'success');
      await loadMembers();
    } catch (err) {
      toast(err?.message || 'Remove failed', 'warning');
    } finally {
      setBusy(null);
    }
  };

  const currentUserId = user?.id;

  return (
    <Page
      header={
        <PageHeader
          title="Members & Roles"
          subtitle={`${members.length} member${members.length === 1 ? '' : 's'} · invite and manage who can access this organization.`}
          icon={
            <span className="page-obj-icon" style={{ background: 'var(--accent-violet)' }}>
              <Users size={20} aria-hidden="true" />
            </span>
          }
        />
      }
    >
      <div style={{ maxWidth: 760, display: 'flex', flexDirection: 'column', gap: 32 }}>
        {/* ── Current members ──────────────────────────────────────────── */}
        <section>
          <h2 className="text-base font-bold text-text-primary mb-3 flex items-center gap-2">
            <Shield size={16} /> Current members
          </h2>
          {loading ? (
            <p className="text-xs text-text-muted italic">Loading members…</p>
          ) : members.length === 0 ? (
            <p className="text-xs text-text-muted italic">No members yet.</p>
          ) : (
            <div className="rounded-xl border border-border-subtle overflow-hidden">
              <table className="w-full text-sm text-left">
                <thead className="bg-bg-app border-b border-border-subtle text-text-muted text-xs uppercase tracking-wide font-semibold">
                  <tr>
                    <th className="px-4 py-3">Member</th>
                    <th className="px-4 py-3">Role</th>
                    <th className="px-4 py-3">Joined</th>
                    {canManage && <th className="px-4 py-3 text-right">Actions</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-subtle text-text-primary">
                  {members.map((m) => {
                    const isSelf = m.profileId === currentUserId;
                    const isBusy = busy === m.profileId;
                    return (
                      <tr key={m.profileId} className="hover:bg-bg-app/50 transition-colors">
                        <td className="px-4 py-3">
                          <div className="font-medium">{m.name}</div>
                          <div className="text-xs text-text-muted">{m.email}</div>
                        </td>
                        <td className="px-4 py-3">
                          {canManage && !isSelf ? (
                            <select
                              className="select"
                              style={{ height: 28, width: 100, fontSize: 12 }}
                              aria-label={`Role for ${m.name}`}
                              value={m.role}
                              disabled={isBusy}
                              onChange={(e) => handleRoleChange(m.profileId, e.target.value)}
                            >
                              {ROLE_OPTIONS.map((r) => (
                                <option key={r} value={r}>
                                  {r.charAt(0).toUpperCase() + r.slice(1)}
                                </option>
                              ))}
                            </select>
                          ) : (
                            <Badge tone={ROLE_TONE[m.role] || 'neutral'}>{m.role}</Badge>
                          )}
                        </td>
                        <td className="px-4 py-3 text-text-muted text-xs">
                          {new Date(m.joinedAt).toLocaleDateString()}
                        </td>
                        {canManage && (
                          <td className="px-4 py-3 text-right">
                            {!isSelf && (
                              <Button
                                variant="ghost-danger"
                                size="sm"
                                icon={Trash2}
                                disabled={isBusy}
                                onClick={() => handleRemove(m)}
                                aria-label={`Remove ${m.name}`}
                              >
                                Remove
                              </Button>
                            )}
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* ── Invite management ────────────────────────────────────────── */}
        <InvitesSettings />
      </div>
    </Page>
  );
}
