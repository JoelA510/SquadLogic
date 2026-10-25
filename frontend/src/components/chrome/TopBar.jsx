import React, { useEffect, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import { useNavigate } from 'react-router-dom';
import {
  Bell,
  Building2,
  Calendar,
  ChevronDown,
  LogOut,
  Menu,
  Moon,
  Plus,
  Search,
  Settings,
  Sparkles,
  Sun,
  User,
  UserRoundCheck,
} from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useOrganization } from '../../contexts/OrganizationContext.jsx';
import { useTheme } from '../../contexts/ThemeContext.jsx';
import { usePermission } from '../../hooks/usePermission.js';
import { supabase } from '../../lib/supabaseClient.js';
import { logger } from '../../lib/logger.js';
import Dropdown from '../ui/Dropdown.jsx';
import { useToast } from '../ui/ToastHost.jsx';
import Badge from '../ui/Badge.jsx';
import { initialsOf } from '../ui/Avatar.jsx';
import logo from '../../assets/SL-Logo.png';
import { isAdminRole } from '../../constants/permissions.js';

function CtxSwitcher({ label, icon: Icon, value, items }) {
  return (
    <Dropdown
      alignRight={false}
      header={label}
      items={items}
      renderTrigger={({ toggle, open, triggerProps }) => (
        <button
          type="button"
          className="ctx-switch"
          onClick={toggle}
          aria-label={`Active ${label}: ${value}`}
          {...triggerProps}
        >
          <Icon size={16} className="muted" aria-hidden="true" />
          <span
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'flex-start',
              lineHeight: 1.15,
              minWidth: 0,
            }}
          >
            {/* The space keeps "<label> <value>" a phrase of the aria-label (WCAG 2.5.3). */}
            <span className="ctx-label">{label}</span> <span className="ctx-val">{value}</span>
          </span>
          <ChevronDown
            size={15}
            className="muted"
            aria-hidden="true"
            style={{ transform: open ? 'rotate(180deg)' : undefined, transition: 'transform .12s' }}
          />
        </button>
      )}
    />
  );
}

CtxSwitcher.propTypes = {
  label: PropTypes.string.isRequired,
  icon: PropTypes.elementType.isRequired,
  value: PropTypes.string.isRequired,
  items: PropTypes.array.isRequired,
};

/**
 * Application top bar: brand, org/season switchers, global search,
 * Season Setup shortcut, theme toggle, notifications, account menu
 * with role preview (impersonation).
 */
export default function TopBar({ onToggleNav = undefined }) {
  const navigate = useNavigate();
  const { user, signOut, isAdmin: isProfileAdmin, impersonateUser } = useAuth();
  const {
    organizations = [],
    currentOrganization,
    orgMember,
    availableSeasons = [],
    currentSeasonSetting,
    switchOrganization,
    switchSeason,
  } = useOrganization();
  // Role preview: a profile admin, or an admin-equivalent of this organization
  // (staff included).
  const isAdmin = isProfileAdmin || isAdminRole(orgMember?.role);
  const { themeMode, toggleThemeMode } = useTheme();
  const { can, PERMISSIONS } = usePermission();
  const toast = useToast();
  const searchRef = useRef(null);
  const [previewTargets, setPreviewTargets] = useState([]);

  // "/" focuses the global search unless the user is already typing somewhere.
  useEffect(() => {
    const handler = (event) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (document.activeElement instanceof HTMLElement && document.activeElement.isContentEditable)
        return;
      event.preventDefault();
      searchRef.current?.focus();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  // Role-preview target (one coach), fetched for admins. There is no parent
  // view to preview since 20261024010000 (R3). A coach is a member whose
  // organization role is `coach` (`organization_members.role`, read through
  // the admin-only member list): `profiles.role` is set by nothing and every
  // profile reads `user`, so the preview, which looked there, was never
  // offered (admin focus R6). The target is shaped as a profile, its role the
  // membership's, for `impersonateUser` and the role-scoped nav and home.
  const orgId = currentOrganization?.id;
  useEffect(() => {
    if (!isAdmin || !orgId) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const { data, error } = await supabase.rpc('get_organization_members', {
          p_organization_id: orgId,
        });
        if (cancelled) return;
        if (error) {
          // Preview is optional, but a failure is said, not swallowed.
          logger.warn('[TopBar] role preview targets not loaded', {
            code: error.code,
            message: error.message,
          });
          setPreviewTargets([]);
          return;
        }
        const coach = (data || [])
          .filter((member) => member.role === 'coach' && member.profile_id)
          .sort(
            (a, b) =>
              String(a.full_name ?? a.email ?? '').localeCompare(
                String(b.full_name ?? b.email ?? '')
              ) || String(a.profile_id).localeCompare(String(b.profile_id))
          )[0];
        setPreviewTargets(
          coach
            ? [
                {
                  id: coach.profile_id,
                  email: coach.email ?? null,
                  first_name: coach.first_name ?? null,
                  last_name: coach.last_name ?? null,
                  full_name: coach.full_name ?? null,
                  role: 'coach',
                  organization_id: orgId,
                },
              ]
            : []
        );
      } catch (err) {
        // Best effort: the account menu still works without a preview entry.
        logger.warn('[TopBar] role preview targets not loaded', { message: err?.message });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isAdmin, orgId]);

  const displayName =
    user?.profile?.full_name ||
    [user?.profile?.first_name, user?.profile?.last_name].filter(Boolean).join(' ') ||
    user?.email ||
    'Account';
  const displayEmail = user?.email || user?.profile?.email || '';
  const initials = initialsOf(displayName) || '?';

  const orgItems = [
    ...organizations.map((member) => ({
      id: member.organization_id,
      label: member.organizations?.name || member.organization_id,
      icon: Building2,
      checked: currentOrganization?.id === member.organizations?.id,
      onSelect: () => switchOrganization(member.organization_id),
    })),
    {
      id: 'new-org',
      label: 'New organization…',
      icon: Plus,
      separatorAbove: true,
      onSelect: () => navigate('/organizations/new'),
    },
  ];

  const seasonItems = availableSeasons.map((season) => ({
    id: String(season.id),
    label: season.name || String(season.id),
    icon: Calendar,
    checked: currentSeasonSetting?.id === season.id,
    onSelect: () => switchSeason(season),
  }));

  const accountItems = [
    ...(isAdmin && previewTargets.length > 0
      ? previewTargets.map((profile) => ({
          id: `preview-${profile.id}`,
          label: 'Preview as Coach',
          icon: UserRoundCheck,
          onSelect: () =>
            impersonateUser(profile, { orgRole: orgMember?.role }).catch(() => {
              toast('Could not start the preview as a coach. Try again.', 'warning');
            }),
        }))
      : []),
    {
      id: 'account',
      label: 'Account settings',
      icon: User,
      separatorAbove: isAdmin && previewTargets.length > 0,
      onSelect: () => navigate('/account'),
    },
    ...(can(PERMISSIONS.MANAGE_ORGANIZATION)
      ? [
          {
            id: 'org-settings',
            label: 'Organization settings',
            icon: Settings,
            onSelect: () => navigate('/settings'),
          },
        ]
      : []),
    {
      id: 'sign-out',
      label: 'Sign out',
      icon: LogOut,
      danger: true,
      separatorAbove: true,
      onSelect: () => signOut(),
    },
  ];

  return (
    <header className="topbar">
      <button
        type="button"
        className="icon-btn nav-toggle"
        onClick={onToggleNav}
        aria-label="Hamburger Menu"
      >
        <Menu size={20} />
      </button>
      <button
        type="button"
        className="brand"
        onClick={() => navigate('/')}
        style={{ cursor: 'pointer', background: 'none', border: 'none', padding: 0 }}
        aria-label="SquadLogic home"
      >
        <span className="brand-mark">
          <img src={logo} alt="" />
        </span>
        <span className="brand-name">
          Squad<b>Logic</b>
        </span>
      </button>

      <CtxSwitcher
        label="Organization"
        icon={Building2}
        value={currentOrganization?.name || 'Select organization'}
        items={orgItems}
      />
      {seasonItems.length > 0 && (
        <CtxSwitcher
          label="Season"
          icon={Calendar}
          value={currentSeasonSetting?.name || 'No seasons'}
          items={seasonItems}
        />
      )}

      <div className="global-search">
        <Search size={16} className="gs-icon" aria-hidden="true" />
        <input
          ref={searchRef}
          placeholder="Search players, teams, coaches, games…"
          aria-label="Global search"
        />
        <kbd>/</kbd>
      </div>

      <div className="topbar-spacer" />

      {can(PERMISSIONS.MANAGE_GLOBAL_SETTINGS) && (
        <button type="button" className="btn btn-default sm" onClick={() => navigate('/setup')}>
          <Sparkles size={14} aria-hidden="true" />
          Season Setup
        </button>
      )}

      <button
        type="button"
        className="icon-btn"
        onClick={toggleThemeMode}
        aria-label={themeMode === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        title={themeMode === 'dark' ? 'Light mode' : 'Dark mode'}
      >
        {themeMode === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
      </button>
      <button type="button" className="icon-btn" aria-label="Notifications" title="Notifications">
        <Bell size={18} />
      </button>

      <Dropdown
        header={
          <span style={{ textTransform: 'none', letterSpacing: 0 }}>
            <span style={{ display: 'block', fontWeight: 700, fontSize: 13 }}>{displayName}</span>
            {displayEmail && (
              <span className="muted" style={{ display: 'block', fontSize: 12, fontWeight: 500 }}>
                {displayEmail}
              </span>
            )}
            <span style={{ display: 'inline-block', marginTop: 6 }}>
              <Badge tone="info" dot>
                {user?.profile?.role || 'member'}
              </Badge>
            </span>
          </span>
        }
        items={accountItems}
        renderTrigger={({ toggle, triggerProps }) => (
          <button
            type="button"
            className="avatar"
            onClick={toggle}
            aria-label={`Account menu for ${displayName}, ${initials}`}
            style={{ marginLeft: 2, border: 'none', cursor: 'pointer' }}
            {...triggerProps}
          >
            {initials}
          </button>
        )}
      />
    </header>
  );
}

TopBar.propTypes = {
  onToggleNav: PropTypes.func,
};
