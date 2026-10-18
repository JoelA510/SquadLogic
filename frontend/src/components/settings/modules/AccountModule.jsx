import React, { useState } from 'react';
import { User } from 'lucide-react';
import Button from '../../ui/Button.jsx';
import { useAuth } from '../../../contexts/AuthContext.jsx';
import { supabase } from '../../../lib/supabaseClient.js';

export default function AccountModule() {
  const { user, updatePassword, isImpersonating } = useAuth();
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState({ type: '', text: '' });

  const handlePasswordUpdate = async (e) => {
    e.preventDefault();
    if (newPassword !== confirmPassword) {
      setMessage({ type: 'error', text: 'New passwords do not match' });
      return;
    }
    if (newPassword.length < 12) {
      setMessage({ type: 'error', text: 'Password must be at least 12 characters' });
      return;
    }

    setLoading(true);
    setMessage({ type: '', text: '' });

    try {
      const { error } = await updatePassword(newPassword);
      if (error) throw error;

      // Audit the change
      const orgId = user?.profile?.organization_id;
      if (orgId) {
        await supabase.rpc('record_audit_event', {
          p_organization_id: orgId,
          p_action: 'auth.password_updated',
          p_metadata: {
            user_id: user?.id,
            ...(isImpersonating && {
              target_user_id: user?.profile?.id,
              impersonated_by: user?.id,
              admin_email: user?.email,
            }),
          },
        });
      }

      setMessage({ type: 'success', text: 'Password updated successfully' });
      setNewPassword('');
      setConfirmPassword('');
    } catch (error) {
      setMessage({ type: 'error', text: error.message || 'Failed to update password' });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6 animate-fadeIn">
      <div className="p-4 bg-bg-surface rounded-lg border border-border-subtle flex items-center gap-4">
        <div className="w-12 h-12 rounded-full bg-blue-500/20 flex items-center justify-center text-text-accent">
          <User size={24} />
        </div>
        <div>
          <h3 className="text-text-primary font-medium">Logged in as</h3>
          <p className="text-text-muted text-sm">{user?.email || 'user@example.com'}</p>
        </div>
      </div>

      <div className="border-t border-border-subtle pt-6">
        <h3 className="text-lg font-medium text-text-primary mb-4">Change Password</h3>
        <form onSubmit={handlePasswordUpdate} className="space-y-4">
          {message.text && (
            <div
              className={`p-3 rounded-lg text-sm ${
                message.type === 'success'
                  ? 'bg-emerald-500/10 text-status-success-text border border-emerald-500/20'
                  : 'bg-red-500/10 text-status-error-text border border-red-500/20'
              }`}
            >
              {message.text}
            </div>
          )}

          <div>
            <label
              htmlFor="new-password"
              className="block text-sm font-medium text-text-secondary mb-2"
            >
              New Password
            </label>
            <input
              id="new-password"
              type="password"
              required
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className="w-full bg-bg-surface border border-border-subtle rounded-lg px-4 py-3 text-text-primary focus:outline-none focus:border-brand-400 transition-colors"
              placeholder="Min. 12 characters"
            />
          </div>
          <div>
            <label
              htmlFor="confirm-password"
              className="block text-sm font-medium text-text-secondary mb-2"
            >
              Confirm New Password
            </label>
            <input
              id="confirm-password"
              type="password"
              required
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className="w-full bg-bg-surface border border-border-subtle rounded-lg px-4 py-3 text-text-primary focus:outline-none focus:border-brand-400 transition-colors"
            />
          </div>
          <Button
            type="submit"
            variant="secondary"
            size="sm"
            loading={loading}
            disabled={loading || !newPassword || !confirmPassword}
          >
            Update Password
          </Button>
        </form>
      </div>
    </div>
  );
}
