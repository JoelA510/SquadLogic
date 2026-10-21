import React, { useEffect, useMemo, useState } from 'react';
import { Building2, KeyRound, Link2, Shield, UserRound } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext.jsx';
import { useOrganization } from '../contexts/OrganizationContext.jsx';
import { supabase } from '../lib/supabaseClient.js';
import { logger } from '../lib/logger.js';
import { PERMISSIONS } from '../constants/permissions.js';
import Button from '../components/ui/Button.jsx';
import InvitesSettings from '../components/settings/InvitesSettings.jsx';
import ContactCardSettings from '../components/settings/ContactCardSettings.jsx';

const getProfileForm = (user) => ({
  avatar_url: user?.profile?.avatar_url || '',
  first_name: user?.profile?.first_name || '',
  last_name: user?.profile?.last_name || '',
  full_name: user?.profile?.full_name || '',
});

const getErrorMessage = (error, fallback) => error?.message || fallback;

export default function AccountSettingsPage() {
  const { user, updatePassword } = useAuth();
  const {
    organizations = [],
    currentOrganization,
    switchOrganization,
    refetchOrgs,
    permissions = [],
  } = useOrganization();

  const [profileForm, setProfileForm] = useState(() => getProfileForm(user));
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileMessage, setProfileMessage] = useState(null);

  const [passwordForm, setPasswordForm] = useState({ password: '', confirm: '' });
  const [passwordSaving, setPasswordSaving] = useState(false);
  const [passwordMessage, setPasswordMessage] = useState(null);

  const [inviteCode, setInviteCode] = useState('');
  const [inviteSaving, setInviteSaving] = useState(false);
  const [inviteMessage, setInviteMessage] = useState(null);

  const canManageInvites = permissions.includes(PERMISSIONS.MANAGE_ORGANIZATION);
  const email = user?.email || user?.profile?.email || '';

  const currentOrgName = useMemo(() => {
    if (currentOrganization?.name) return currentOrganization.name;
    const match = organizations.find(
      (member) => member.organization_id === currentOrganization?.id
    );
    return match?.organizations?.name || 'No organization selected';
  }, [currentOrganization, organizations]);

  useEffect(() => {
    setProfileForm(getProfileForm(user));
  }, [user]);

  const updateProfileField = (field, value) => {
    setProfileForm((current) => ({ ...current, [field]: value }));
    setProfileMessage(null);
  };

  const handleProfileSubmit = async (event) => {
    event.preventDefault();
    if (!user?.id || profileSaving) return;

    setProfileSaving(true);
    setProfileMessage(null);

    try {
      const updates = {
        avatar_url: profileForm.avatar_url.trim() || null,
        first_name: profileForm.first_name.trim() || null,
        last_name: profileForm.last_name.trim() || null,
        full_name: profileForm.full_name.trim() || null,
      };

      const { data, error } = await supabase
        .from('profiles')
        .update(updates)
        .eq('id', user.id)
        .select('id, first_name, last_name, full_name, avatar_url')
        .maybeSingle();

      if (error) throw error;
      if (!data) {
        throw new Error('No profile row was updated.');
      }

      setProfileForm((current) => ({
        ...current,
        ...getProfileForm({ profile: data }),
      }));
      setProfileMessage({ type: 'success', text: 'Profile saved.' });
    } catch (error) {
      logger.error('Account profile update failed', error);
      setProfileMessage({
        type: 'error',
        text: getErrorMessage(error, 'Could not save profile.'),
      });
    } finally {
      setProfileSaving(false);
    }
  };

  const handlePasswordSubmit = async (event) => {
    event.preventDefault();
    if (passwordSaving) return;

    if (passwordForm.password !== passwordForm.confirm) {
      setPasswordMessage({ type: 'error', text: 'Passwords do not match.' });
      return;
    }

    if (passwordForm.password.length < 12) {
      setPasswordMessage({ type: 'error', text: 'Password must be at least 12 characters.' });
      return;
    }

    setPasswordSaving(true);
    setPasswordMessage(null);

    try {
      const { error } = await updatePassword(passwordForm.password);
      if (error) throw error;

      setPasswordForm({ password: '', confirm: '' });
      setPasswordMessage({ type: 'success', text: 'Password updated.' });
    } catch (error) {
      logger.error('Account password update failed', error);
      setPasswordMessage({
        type: 'error',
        text: getErrorMessage(error, 'Could not update password.'),
      });
    } finally {
      setPasswordSaving(false);
    }
  };

  const handleInviteSubmit = async (event) => {
    event.preventDefault();
    if (inviteSaving) return;

    const code = inviteCode.trim();
    if (!code) {
      setInviteMessage({ type: 'error', text: 'Enter an invite code.' });
      return;
    }

    setInviteSaving(true);
    setInviteMessage(null);

    try {
      const { error } = await supabase.rpc('redeem_org_invite', { p_code: code });
      if (error) throw error;

      setInviteCode('');
      refetchOrgs?.();
      setInviteMessage({ type: 'success', text: 'Invite redeemed. Organization list refreshed.' });
    } catch (error) {
      logger.error('Account invite redemption failed', error);
      setInviteMessage({
        type: 'error',
        text: getErrorMessage(error, 'Invite code is invalid, expired, or already used.'),
      });
    } finally {
      setInviteSaving(false);
    }
  };

  return (
    <div className="max-w-5xl mx-auto py-8 px-4 space-y-8">
      <header>
        <h1 className="text-3xl font-bold text-text-primary flex items-center gap-3">
          <UserRound className="text-text-accent" size={32} aria-hidden="true" />
          Account Settings
        </h1>
        <p className="text-text-muted mt-2">
          Manage your profile, security, and organization access.
        </p>
      </header>

      <section className="glass-panel p-6 space-y-6" aria-labelledby="account-profile-heading">
        <div>
          <h2
            id="account-profile-heading"
            className="text-xl font-bold text-text-primary flex items-center gap-2"
          >
            <UserRound size={18} aria-hidden="true" />
            Profile
          </h2>
          <p className="text-sm text-text-muted mt-1">Your personal profile information.</p>
        </div>

        <form onSubmit={handleProfileSubmit} className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <FormField
            id="account-avatar-url"
            label="Avatar URL"
            value={profileForm.avatar_url}
            onChange={(value) => updateProfileField('avatar_url', value)}
            type="url"
            autoComplete="url"
          />
          <FormField
            id="account-email"
            label="Email"
            value={email}
            readOnly
            helper="Email changes are handled through authentication settings."
          />
          <FormField
            id="account-first-name"
            label="First Name"
            value={profileForm.first_name}
            onChange={(value) => updateProfileField('first_name', value)}
            autoComplete="given-name"
          />
          <FormField
            id="account-last-name"
            label="Last Name"
            value={profileForm.last_name}
            onChange={(value) => updateProfileField('last_name', value)}
            autoComplete="family-name"
          />
          <div className="md:col-span-2">
            <FormField
              id="account-full-name"
              label="Full Name"
              value={profileForm.full_name}
              onChange={(value) => updateProfileField('full_name', value)}
              autoComplete="name"
            />
          </div>

          <div className="md:col-span-2 flex flex-col sm:flex-row sm:items-center gap-3">
            <Button type="submit" variant="primary" disabled={profileSaving}>
              {profileSaving ? 'Saving Profile...' : 'Save Profile'}
            </Button>
            <StatusMessage message={profileMessage} />
          </div>
        </form>
      </section>

      <ContactCardSettings userId={user?.id ?? null} />

      <section className="glass-panel p-6 space-y-6" aria-labelledby="account-security-heading">
        <div>
          <h2
            id="account-security-heading"
            className="text-xl font-bold text-text-primary flex items-center gap-2"
          >
            <KeyRound size={18} aria-hidden="true" />
            Security
          </h2>
          <p className="text-sm text-text-muted mt-1">Change your account password.</p>
        </div>

        <form onSubmit={handlePasswordSubmit} className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <PasswordField
            id="account-new-password"
            label="New Password"
            value={passwordForm.password}
            onChange={(value) => {
              setPasswordForm((current) => ({ ...current, password: value }));
              setPasswordMessage(null);
            }}
            describedBy={passwordMessage?.type === 'error' ? 'account-password-message' : undefined}
          />
          <PasswordField
            id="account-confirm-password"
            label="Confirm Password"
            value={passwordForm.confirm}
            onChange={(value) => {
              setPasswordForm((current) => ({ ...current, confirm: value }));
              setPasswordMessage(null);
            }}
            describedBy={passwordMessage?.type === 'error' ? 'account-password-message' : undefined}
          />
          <div className="md:col-span-2 flex flex-col sm:flex-row sm:items-center gap-3">
            <Button
              type="submit"
              variant="primary"
              disabled={passwordSaving || !passwordForm.password || !passwordForm.confirm}
            >
              {passwordSaving ? 'Updating Password...' : 'Update Password'}
            </Button>
            <StatusMessage id="account-password-message" message={passwordMessage} />
          </div>
        </form>
      </section>

      <section className="glass-panel p-6 space-y-6" aria-labelledby="account-org-heading">
        <div>
          <h2
            id="account-org-heading"
            className="text-xl font-bold text-text-primary flex items-center gap-2"
          >
            <Building2 size={18} aria-hidden="true" />
            Organizations
          </h2>
          <p className="text-sm text-text-muted mt-1">
            Current organization: <span className="text-text-primary">{currentOrgName}</span>
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="space-y-2">
            <label
              htmlFor="account-organization"
              className="block text-sm font-medium text-text-secondary"
            >
              Switch Organization
            </label>
            <select
              id="account-organization"
              className="w-full glass-input"
              value={currentOrganization?.id || ''}
              onChange={(event) => switchOrganization?.(event.target.value)}
            >
              {organizations.length === 0 ? (
                <option value="">No organizations available</option>
              ) : (
                organizations.map((member) => (
                  <option key={member.organization_id} value={member.organization_id}>
                    {member.organizations?.name || member.organization_id}
                  </option>
                ))
              )}
            </select>
          </div>

          <form onSubmit={handleInviteSubmit} className="space-y-3">
            <div className="space-y-2">
              <label
                htmlFor="account-invite-code"
                className="block text-sm font-medium text-text-secondary"
              >
                Join Organization by Invite Code
              </label>
              <div className="flex flex-col sm:flex-row gap-3">
                <input
                  id="account-invite-code"
                  type="text"
                  value={inviteCode}
                  onChange={(event) => {
                    setInviteCode(event.target.value);
                    setInviteMessage(null);
                  }}
                  className="w-full glass-input font-mono tracking-wider"
                  autoComplete="off"
                  aria-describedby={inviteMessage ? 'account-invite-message' : undefined}
                />
                <Button type="submit" variant="secondary" disabled={inviteSaving}>
                  <Link2 size={16} aria-hidden="true" />
                  {inviteSaving ? 'Joining...' : 'Join'}
                </Button>
              </div>
            </div>
            <StatusMessage id="account-invite-message" message={inviteMessage} />
          </form>
        </div>
      </section>

      {canManageInvites && (
        <section className="glass-panel p-6" aria-labelledby="account-admin-invites-heading">
          <h2
            id="account-admin-invites-heading"
            className="text-xl font-bold text-text-primary flex items-center gap-2 mb-6"
          >
            <Shield size={18} aria-hidden="true" />
            Admin Invites
          </h2>
          <InvitesSettings />
        </section>
      )}
    </div>
  );
}

function FormField({
  id,
  label,
  value,
  onChange = (_value) => {},
  type = 'text',
  autoComplete = undefined,
  readOnly = false,
  helper = null,
}) {
  const helperId = helper ? `${id}-help` : undefined;

  return (
    <div className="space-y-2">
      <label htmlFor={id} className="block text-sm font-medium text-text-secondary">
        {label}
      </label>
      <input
        id={id}
        type={type}
        value={value}
        onChange={(event) => onChange?.(event.target.value)}
        readOnly={readOnly}
        autoComplete={autoComplete}
        aria-describedby={helperId}
        className={`w-full glass-input ${readOnly ? 'cursor-not-allowed opacity-80' : ''}`}
      />
      {helper && (
        <p id={helperId} className="text-xs text-text-muted">
          {helper}
        </p>
      )}
    </div>
  );
}

function PasswordField({ id, label, value, onChange, describedBy }) {
  return (
    <div className="space-y-2">
      <label htmlFor={id} className="block text-sm font-medium text-text-secondary">
        {label}
      </label>
      <input
        id={id}
        type="password"
        required
        value={value}
        onChange={(event) => onChange(event.target.value)}
        autoComplete="new-password"
        aria-describedby={describedBy}
        className="w-full glass-input"
      />
    </div>
  );
}

function StatusMessage({ id = undefined, message }) {
  if (!message?.text) return null;

  const isError = message.type === 'error';

  return (
    <p
      id={id}
      role={isError ? 'alert' : 'status'}
      className={`text-sm ${isError ? 'text-status-error-text' : 'text-status-success-text'}`}
    >
      {message.text}
    </p>
  );
}
