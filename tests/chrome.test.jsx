import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import TopBar from '../frontend/src/components/chrome/TopBar.jsx';
import SideNav from '../frontend/src/components/chrome/SideNav.jsx';
import PageHeader from '../frontend/src/components/chrome/PageHeader.jsx';

const mocks = vi.hoisted(() => ({
  signOut: vi.fn(),
  switchOrganization: vi.fn(),
  switchSeason: vi.fn(),
  toggleThemeMode: vi.fn(),
  impersonateUser: vi.fn().mockResolvedValue(undefined),
  auth: {},
  org: {},
  permission: {},
}));

vi.mock('../frontend/src/contexts/AuthContext.jsx', () => ({
  useAuth: () => mocks.auth,
}));

vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: () => mocks.org,
}));

vi.mock('../frontend/src/contexts/ThemeContext.jsx', () => ({
  useTheme: () => ({
    themeMode: 'light',
    toggleThemeMode: mocks.toggleThemeMode,
  }),
}));

vi.mock('../frontend/src/hooks/usePermission.js', () => ({
  usePermission: () => mocks.permission,
}));

vi.mock('../frontend/src/hooks/useNavBadges.js', () => ({
  useNavBadges: () => ({ players: 42, coaches: 7, teams: 6, complianceOpen: null }),
}));

vi.mock('../frontend/src/lib/supabaseClient.js', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        in: () => Promise.resolve({ data: [], error: null }),
      }),
    }),
  },
}));

vi.mock('../frontend/src/config.js', () => ({
  IS_MOCK_MODE: false,
}));

import { PERMISSIONS, ROLE_PERMISSIONS, ROLES } from '../frontend/src/constants/permissions.js';

function configureRole(role) {
  const perms = ROLE_PERMISSIONS[role] || [];
  mocks.permission.can = (permission) => perms.includes(permission);
  mocks.permission.role = role;
  mocks.permission.PERMISSIONS = PERMISSIONS;
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mocks.auth.signOut = mocks.signOut;
  mocks.auth.isAdmin = true;
  mocks.auth.isImpersonating = false;
  mocks.auth.impersonateUser = mocks.impersonateUser;
  mocks.auth.user = {
    email: 'admin@example.com',
    profile: { full_name: 'Avery Admin', role: 'admin' },
  };
  mocks.org.organizations = [
    { organization_id: 'org-1', organizations: { id: 'org-1', name: 'North League' } },
    { organization_id: 'org-2', organizations: { id: 'org-2', name: 'Metro United' } },
  ];
  mocks.org.currentOrganization = { id: 'org-1', name: 'North League' };
  mocks.org.availableSeasons = [
    { id: 'season-1', name: 'Spring 2026' },
    { id: 'season-2', name: 'Fall 2026' },
  ];
  mocks.org.currentSeasonSetting = { id: 'season-1', name: 'Spring 2026' };
  mocks.org.switchOrganization = mocks.switchOrganization;
  mocks.org.switchSeason = mocks.switchSeason;
  configureRole(ROLES.TENANT_ADMIN);
});

describe('TopBar', () => {
  it('switches organizations from the Organization context switcher', () => {
    render(
      <MemoryRouter>
        <TopBar />
      </MemoryRouter>
    );
    fireEvent.click(screen.getByRole('button', { name: /Active Organization/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Metro United/ }));
    expect(mocks.switchOrganization).toHaveBeenCalledWith('org-2');
  });

  it('switches seasons from the Season context switcher', () => {
    render(
      <MemoryRouter>
        <TopBar />
      </MemoryRouter>
    );
    fireEvent.click(screen.getByRole('button', { name: /Active Season/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Fall 2026/ }));
    expect(mocks.switchSeason).toHaveBeenCalledWith({ id: 'season-2', name: 'Fall 2026' });
  });

  it('toggles the theme and exposes an account menu with sign out', () => {
    render(
      <MemoryRouter>
        <TopBar />
      </MemoryRouter>
    );
    fireEvent.click(screen.getByRole('button', { name: /Switch to dark mode/ }));
    expect(mocks.toggleThemeMode).toHaveBeenCalled();

    const accountButton = screen.getByRole('button', { name: /Account menu for Avery Admin/ });
    expect(accountButton).toHaveAttribute('aria-haspopup', 'menu');
    fireEvent.click(accountButton);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Sign out' }));
    expect(mocks.signOut).toHaveBeenCalled();
  });

  it('focuses the global search when "/" is pressed', () => {
    render(
      <MemoryRouter>
        <TopBar />
      </MemoryRouter>
    );
    fireEvent.keyDown(document, { key: '/' });
    expect(screen.getByRole('textbox', { name: 'Global search' })).toHaveFocus();
  });

  it('hides the Season Setup shortcut from non tenant-admin roles', () => {
    configureRole(ROLES.COACH);
    render(
      <MemoryRouter>
        <TopBar />
      </MemoryRouter>
    );
    expect(screen.queryByRole('button', { name: /Season Setup/ })).not.toBeInTheDocument();
  });
});

describe('SideNav', () => {
  it('renders grouped admin navigation with badges and permission filtering', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <SideNav collapsed={false} onToggleCollapsed={vi.fn()} />
      </MemoryRouter>
    );
    expect(screen.getByRole('link', { name: /Players\s*42/ })).toHaveAttribute('href', '/players');
    expect(screen.getByRole('link', { name: /Teams & Rosters/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Audit Log' })).toBeInTheDocument();
  });

  it('hides a feature-gated item until the org turns the feature on', () => {
    mocks.org = { ...mocks.org, featureFlags: {} };
    const { unmount } = render(
      <MemoryRouter initialEntries={['/']}>
        <SideNav collapsed={false} onToggleCollapsed={vi.fn()} />
      </MemoryRouter>
    );
    expect(screen.queryByRole('link', { name: /Heat Forecast/ })).not.toBeInTheDocument();
    unmount();
    mocks.org = { ...mocks.org, featureFlags: { heat_forecast: true } };
    render(
      <MemoryRouter initialEntries={['/']}>
        <SideNav collapsed={false} onToggleCollapsed={vi.fn()} />
      </MemoryRouter>
    );
    expect(screen.getByRole('link', { name: /Heat Forecast/ })).toHaveAttribute(
      'href',
      '/schedule/heat'
    );
  });

  it('collapses a group when its label is clicked', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <SideNav collapsed={false} onToggleCollapsed={vi.fn()} />
      </MemoryRouter>
    );
    const groupToggle = screen.getByRole('button', { name: /Scheduling/ });
    expect(screen.getByRole('link', { name: /Practices/ })).toBeInTheDocument();
    fireEvent.click(groupToggle);
    expect(screen.queryByRole('link', { name: /Practices/ })).not.toBeInTheDocument();
  });

  it('shows the flat coach navigation for coach role', () => {
    configureRole(ROLES.COACH);
    mocks.auth.isAdmin = false;
    mocks.auth.user = { email: 'coach@example.com', profile: { full_name: 'C', role: 'coach' } };
    render(
      <MemoryRouter initialEntries={['/']}>
        <SideNav collapsed={false} onToggleCollapsed={vi.fn()} />
      </MemoryRouter>
    );
    expect(screen.getByRole('link', { name: 'My Team' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Audit Log/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Import/ })).not.toBeInTheDocument();
  });

  it('scopes navigation to the previewed role while impersonating', () => {
    mocks.auth.isImpersonating = true;
    mocks.auth.user = {
      email: 'parent@example.com',
      profile: { full_name: 'Pat Parent', role: 'parent' },
    };
    render(
      <MemoryRouter initialEntries={['/']}>
        <SideNav collapsed={false} onToggleCollapsed={vi.fn()} />
      </MemoryRouter>
    );
    expect(screen.getByRole('link', { name: 'My Dashboard' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Audit Log/ })).not.toBeInTheDocument();
  });
});

describe('PageHeader', () => {
  it('derives title and breadcrumb from ROUTE_META', () => {
    render(
      <MemoryRouter initialEntries={['/players']}>
        <PageHeader />
      </MemoryRouter>
    );
    expect(screen.getByRole('heading', { name: 'Players' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Breadcrumb' })).toHaveTextContent('People');
  });
});
