import React, { useEffect, useRef } from 'react';
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
} from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useOrganization } from '../../contexts/OrganizationContext.jsx';
import { useTheme } from '../../contexts/ThemeContext.jsx';
import { usePermission } from '../../hooks/usePermission.js';
import Dropdown from '../ui/Dropdown.jsx';
import Badge from '../ui/Badge.jsx';
import { initialsOf } from '../ui/Avatar.jsx';
import logo from '../../assets/SL-Logo.png';
import { isDemoOrganization } from '../../lib/demo.js';
import DemoTimer from '../auth/DemoTimer.jsx';

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
 * Season Setup shortcut, theme toggle, notifications, account menu.
 */
export default function TopBar({ onToggleNav = undefined }) {
  const navigate = useNavigate();
  const { user, signOut } = useAuth();
  const {
    organizations = [],
    currentOrganization,
    availableSeasons = [],
    currentSeasonSetting,
    switchOrganization,
    switchSeason,
  } = useOrganization();
  const { themeMode, toggleThemeMode } = useTheme();
  const { can, PERMISSIONS } = usePermission();
  const searchRef = useRef(null);

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

  const displayName =
    user?.profile?.full_name ||
    [user?.profile?.first_name, user?.profile?.last_name].filter(Boolean).join(' ') ||
    user?.email ||
    'Account';
  const displayEmail = user?.email || user?.profile?.email || '';
  const initials = initialsOf(displayName) || '?';

  // A demo visitor is anonymous and the server refuses them a tenant of their own (D3), so the
  // demo's switcher offers no way to create one.
  const inDemo = isDemoOrganization(currentOrganization);
  const orgItems = [
    ...organizations.map((member) => ({
      id: member.organization_id,
      label: member.organizations?.name || member.organization_id,
      icon: Building2,
      checked: currentOrganization?.id === member.organizations?.id,
      onSelect: () => switchOrganization(member.organization_id),
    })),
    ...(inDemo
      ? []
      : [
          {
            id: 'new-org',
            label: 'New organization…',
            icon: Plus,
            separatorAbove: true,
            onSelect: () => navigate('/organizations/new'),
          },
        ]),
  ];

  // The organization's one active season is first and carries no tag; any other shows its status
  // (a draft is listed for admins and staff only: the context withholds it from everyone else).
  const seasonItems = availableSeasons.map((season) => ({
    id: String(season.id),
    label:
      (season.name || String(season.id)) +
      (season.status && season.status !== 'active' ? ` (${season.status})` : ''),
    icon: Calendar,
    checked: currentSeasonSetting?.id === season.id,
    onSelect: () => switchSeason(season),
  }));

  const accountItems = [
    {
      id: 'account',
      label: 'Account settings',
      icon: User,
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

      <DemoTimer />

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
