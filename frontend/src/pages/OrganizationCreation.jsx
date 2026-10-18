import React, { useMemo, useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useOrganization } from '../contexts/OrganizationContext.jsx';
import {
  Rocket,
  Building,
  Globe,
  Calendar,
  Clock,
  ChevronRight,
  AlertCircle,
  CheckCircle,
  Ticket,
  Plus,
} from 'lucide-react';
import { supabase } from '../lib/supabaseClient.js';
import { logger } from '../lib/logger.js';
import { withTimeout } from '../lib/withTimeout.js';
import Button from '../components/ui/Button.jsx';
import { PENDING_INVITE_STORAGE_KEY } from '../lib/inviteStorage.js';
import { useOrganizationCreation } from '../hooks/useOrganizationCreation.js';

/**
 * OrganizationCreation Page
 *
 * Two entry paths:
 *   - "Create new":  calls initialize_new_tenant RPC (existing behavior)
 *   - "Join with invite code": calls redeem_org_invite RPC with a single-use code
 *
 * The tab defaults to "Join" if the URL has ?invite=<code> or a pending invite
 * was stashed in sessionStorage by the /invite/:code deep-link flow.
 */
// Read the pending invite code from the URL (`?invite=`) or the
// sessionStorage stash set by the /invite/:code deep-link. Kept outside the
// component so the state initializer and the memoized value below use the
// same logic; also guards for the non-browser path (SSR / unit test env).
function readInitialInvite() {
  if (typeof window === 'undefined') return '';
  const urlInvite = new URLSearchParams(window.location.search).get('invite');
  let pendingInvite = '';
  try {
    pendingInvite = sessionStorage.getItem(PENDING_INVITE_STORAGE_KEY) || '';
  } catch {
    /* storage unavailable — noop */
  }
  return urlInvite || pendingInvite || '';
}

export default function OrganizationCreation() {
  // Run the lookup once, at mount, via the state initializer — prevents any
  // re-reading of sessionStorage on re-render and keeps the first paint
  // deterministic even if a consumer ever introduces SSR.
  const initialInvite = useMemo(() => readInitialInvite(), []);
  const [tab, setTab] = useState(() => (initialInvite ? 'join' : 'create'));

  return (
    <div className="min-h-screen bg-bg-app flex items-center justify-center p-6 animate-fadeIn">
      <div className="max-w-2xl w-full glass-panel-premium overflow-hidden flex flex-col shadow-md">
        {/* Header */}
        <div className="p-8 border-b border-border-subtle bg-bg-glass flex items-center gap-4">
          <div className="w-12 h-12 bg-brand-500/20 text-text-accent rounded-2xl flex items-center justify-center">
            <Rocket size={24} />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-text-primary tracking-tight uppercase">
              Welcome to SquadLogic
            </h1>
            <p className="text-text-muted text-sm">
              Create an organization or join one you&apos;ve been invited to.
            </p>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-border-subtle">
          <TabButton active={tab === 'create'} onClick={() => setTab('create')} icon={Plus}>
            Create new
          </TabButton>
          <TabButton active={tab === 'join'} onClick={() => setTab('join')} icon={Ticket}>
            Join with invite code
          </TabButton>
        </div>

        {tab === 'create' ? (
          <CreateOrganizationForm />
        ) : (
          <JoinWithInviteForm initialCode={initialInvite} />
        )}
      </div>
    </div>
  );
}

function TabButton({ active, onClick, icon: Icon, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex-1 flex items-center justify-center gap-2 py-4 text-xs font-bold uppercase tracking-widest transition-colors ${
        active
          ? 'text-text-accent bg-brand-500/5 border-b-2 border-brand-400'
          : 'text-text-muted hover:text-text-primary'
      }`}
    >
      <Icon size={14} />
      {children}
    </button>
  );
}

// ─────────────────────────────────────────────────────────────
// Branch 1: Create new organization (legacy behavior preserved)
// ─────────────────────────────────────────────────────────────
function CreateOrganizationForm() {
  const { refetchOrgs } = useOrganization();
  const navigate = useNavigate();
  const [formData, setFormData] = useState({
    name: '',
    slug: '',
    slugEdited: false,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    seasonYear: String(new Date().getFullYear()),
  });
  const [success, setSuccess] = useState(false);
  const { createOrganization, loading, error, fieldErrors } = useOrganizationCreation();

  useEffect(() => {
    if (formData.name && !formData.slugEdited) {
      const generatedSlug = formData.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
      setFormData((prev) => ({ ...prev, slug: generatedSlug }));
    }
  }, [formData.name, formData.slugEdited]);

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData((prev) => ({
      ...prev,
      [name]: value,
      ...(name === 'slug' ? { slugEdited: true } : {}),
    }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    const { data, error: createError } = await createOrganization({
      name: formData.name,
      slug: formData.slug,
      timezone: formData.timezone,
      seasonYear: formData.seasonYear,
    });

    if (createError) {
      logger.error('Failed to initialize organization', createError);
      return;
    }

    setSuccess(true);
    logger.info('Organization initialized successfully', { orgId: data });

    setTimeout(() => {
      if (typeof refetchOrgs === 'function') refetchOrgs();
      navigate('/?new_org=true', { replace: true });
    }, 1500);
  };

  const majorTimezones = [
    'America/New_York',
    'America/Chicago',
    'America/Denver',
    'America/Los_Angeles',
    'Europe/London',
    'Europe/Paris',
    'Asia/Tokyo',
    'Australia/Sydney',
    'UTC',
  ];

  if (success) {
    return (
      <div role="status" aria-live="polite" className="p-10 text-center space-y-6">
        <div className="w-20 h-20 bg-green-500/20 text-status-success-text rounded-full flex items-center justify-center mx-auto animate-bounce">
          <CheckCircle size={48} />
        </div>
        <h2 className="text-3xl font-bold text-text-primary uppercase tracking-tight">
          Organization Created
        </h2>
        <p className="text-text-muted">Launching admin dashboard...</p>
      </div>
    );
  }

  return (
    <>
      <form onSubmit={handleSubmit} className="p-8 space-y-8">
        {error && (
          <div
            role="alert"
            className="p-4 bg-red-500/10 border border-red-500/20 rounded-xl flex items-center gap-3 text-status-error-text animate-slideUp"
          >
            <AlertCircle size={20} className="shrink-0" />
            <p className="text-xs font-medium">{error}</p>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="space-y-2">
            <label
              htmlFor="org-name"
              className="flex items-center gap-2 text-xs font-bold text-text-muted uppercase tracking-widest pl-1"
            >
              <Building size={14} /> Organization Name
            </label>
            <input
              id="org-name"
              required
              name="name"
              value={formData.name}
              onChange={handleChange}
              placeholder="e.g. Galaxy Strikers"
              aria-describedby={fieldErrors?.name ? 'org-name-error' : undefined}
              className="w-full glass-input"
            />
            {fieldErrors?.name ? (
              <p id="org-name-error" role="alert" className="text-xs text-status-error-text">
                {fieldErrors?.name}
              </p>
            ) : null}
          </div>

          <div className="space-y-2">
            <label
              htmlFor="org-slug"
              className="flex items-center gap-2 text-xs font-bold text-text-muted uppercase tracking-widest pl-1"
            >
              <Globe size={14} /> URL Identifier (Slug)
            </label>
            <input
              id="org-slug"
              required
              name="slug"
              value={formData.slug}
              onChange={handleChange}
              placeholder="galaxy-strikers"
              aria-describedby={fieldErrors?.slug ? 'org-slug-error' : undefined}
              className="w-full glass-input font-mono text-sm"
            />
            {fieldErrors?.slug ? (
              <p id="org-slug-error" role="alert" className="text-xs text-status-error-text">
                {fieldErrors?.slug}
              </p>
            ) : null}
          </div>

          <div className="space-y-2">
            <label
              htmlFor="org-timezone"
              className="flex items-center gap-2 text-xs font-bold text-text-muted uppercase tracking-widest pl-1"
            >
              <Clock size={14} /> Operations Timezone
            </label>
            <select
              id="org-timezone"
              name="timezone"
              value={formData.timezone}
              onChange={handleChange}
              className="w-full glass-input"
            >
              {!majorTimezones.includes(formData.timezone) && (
                <option value={formData.timezone}>{formData.timezone}</option>
              )}
              {majorTimezones.map((tz) => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-2">
            <label
              htmlFor="org-season"
              className="flex items-center gap-2 text-xs font-bold text-text-muted uppercase tracking-widest pl-1"
            >
              <Calendar size={14} /> Launch Season Year
            </label>
            <input
              id="org-season"
              required
              type="number"
              name="seasonYear"
              min="2020"
              max="2100"
              value={formData.seasonYear}
              onChange={handleChange}
              aria-describedby={fieldErrors?.seasonYear ? 'org-season-error' : undefined}
              className="w-full glass-input"
            />
            {fieldErrors?.seasonYear ? (
              <p id="org-season-error" role="alert" className="text-xs text-status-error-text">
                {fieldErrors?.seasonYear}
              </p>
            ) : null}
          </div>
        </div>

        <div className="pt-6 border-t border-border-subtle flex justify-end">
          <Button
            type="submit"
            variant="primary"
            disabled={loading}
            className="px-8 flex items-center gap-3 transition-all transform hover:scale-105"
          >
            {loading ? (
              'Creating organization...'
            ) : (
              <>
                Establish Organization <ChevronRight size={18} />
              </>
            )}
          </Button>
        </div>
      </form>

      <div className="px-8 py-4 bg-brand-500/5 border-t border-border-subtle text-[10px] text-text-muted uppercase tracking-widest text-center italic">
        Admin session established. All fields recorded in the central audit log.
      </div>
    </>
  );
}

// ─────────────────────────────────────────────────────────────
// Branch 2: Join with invite code
// ─────────────────────────────────────────────────────────────
function JoinWithInviteForm({ initialCode }) {
  const { refetchOrgs } = useOrganization();
  const navigate = useNavigate();
  const [code, setCode] = useState(initialCode || '');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      // Same 30-second timeout defense as the Create flow — a silently
      // stalled redeem RPC would otherwise pin this button indefinitely.
      const { data, error: rpcError } = await withTimeout(
        supabase.rpc('redeem_org_invite', { p_code: code.trim() }),
        30000,
        'Redeem-invite request'
      );
      if (rpcError) throw rpcError;

      // Clear any stashed pending invite now that it's consumed.
      try {
        sessionStorage.removeItem(PENDING_INVITE_STORAGE_KEY);
      } catch {
        /* noop */
      }

      logger.info('Invite code redeemed', { orgId: data });
      // Re-fetch OrganizationContext so the new membership is picked up, then
      // SPA-navigate to the dashboard instead of a full-page reload. Prevents
      // the app-state destruction Gemini PR #179 flagged on the /invite
      // deep-link; same pattern applied here for consistency.
      if (typeof refetchOrgs === 'function') refetchOrgs();
      navigate('/?joined=true', { replace: true });
    } catch (err) {
      logger.error('Failed to redeem invite code', err);
      setError(err.message || 'Could not redeem invite code. Double-check the code and try again.');
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="p-8 space-y-6">
      {error && (
        <div
          role="alert"
          className="p-4 bg-red-500/10 border border-red-500/20 rounded-xl flex items-center gap-3 text-status-error-text animate-slideUp"
        >
          <AlertCircle size={20} className="shrink-0" />
          <p className="text-xs font-medium">{error}</p>
        </div>
      )}

      <div className="space-y-2">
        <label
          htmlFor="invite-code"
          className="flex items-center gap-2 text-xs font-bold text-text-muted uppercase tracking-widest pl-1"
        >
          <Ticket size={14} /> Invite Code
        </label>
        <input
          id="invite-code"
          required
          name="code"
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          placeholder="A3KQ-7PLM"
          autoComplete="off"
          className="w-full glass-input font-mono text-lg tracking-widest text-center"
          maxLength={16}
        />
        <p className="text-[11px] text-text-muted pl-1">
          Ask your organization&apos;s admin for a code, or click the invite link they sent you.
        </p>
      </div>

      <div className="pt-4 border-t border-border-subtle flex justify-end">
        <Button
          type="submit"
          variant="primary"
          disabled={loading || !code.trim()}
          className="px-8 flex items-center gap-3"
        >
          {loading ? (
            'Joining...'
          ) : (
            <>
              Join Organization <ChevronRight size={18} />
            </>
          )}
        </Button>
      </div>
    </form>
  );
}
