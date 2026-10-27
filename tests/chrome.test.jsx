import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import TopBar from '../frontend/src/components/chrome/TopBar.jsx';
import SideNav from '../frontend/src/components/chrome/SideNav.jsx';
import PageHeader from '../frontend/src/components/chrome/PageHeader.jsx';
import { expectVisibleTextInName } from './helpers/index.js';

const mocks = vi.hoisted(() => ({
  signOut: vi.fn(),
  switchOrganization: vi.fn(),
  switchSeason: vi.fn(),
  toggleThemeMode: vi.fn(),
  toast: vi.fn(),
  reads: vi.fn(),
  rpc: vi.fn(),
  auth: {},
  org: {},
  permission: {},
}));

vi.mock('../frontend/src/components/ui/ToastHost.jsx', () => ({
  useToast: () => mocks.toast,
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
  useNavBadges: () => ({ players: 42, coaches: 7, teams: 6 }),
}));

// The account menu reads nothing: role preview (impersonation) is gone, and it was the only thing
// the top bar read. `reads` records any table read, so a regression shows.
vi.mock('../frontend/src/lib/supabaseClient.js', () => ({
  supabase: {
    from: (table) => {
      mocks.reads(table);
      return { select: () => Promise.resolve({ data: [], error: null }) };
    },
    rpc: (name, params) => mocks.rpc(name, params),
  },
}));

vi.mock('../frontend/src/config.js', () => ({
  IS_MOCK_MODE: false,
}));

import { PERMISSIONS, ROLE_PERMISSIONS, ROLES } from '../frontend/src/constants/permissions.js';
import { MOCK_ORG_ID, MOCK_SEASON_ID } from '../frontend/src/lib/mockSeedIds.js';

function configureRole(role) {
  const perms = ROLE_PERMISSIONS[role] || [];
  mocks.permission.can = (permission) => perms.includes(permission);
  mocks.permission.role = role;
  mocks.permission.PERMISSIONS = PERMISSIONS;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rpc.mockImplementation(async (name) => ({
    data: null,
    error: { code: 'PGRST202', message: `no rpc ${name}` },
  }));
  localStorage.clear();
  mocks.auth.signOut = mocks.signOut;
  mocks.auth.isAdmin = true;
  mocks.auth.user = {
    email: 'admin@example.com',
    profile: { full_name: 'Avery Admin', role: 'admin' },
  };
  mocks.org.organizations = [
    { organization_id: MOCK_ORG_ID, organizations: { id: MOCK_ORG_ID, name: 'North League' } },
    { organization_id: 'org-2', organizations: { id: 'org-2', name: 'Metro United' } },
  ];
  mocks.org.currentOrganization = { id: MOCK_ORG_ID, name: 'North League' };
  mocks.org.availableSeasons = [
    { id: MOCK_SEASON_ID, name: 'Spring 2026' },
    { id: 'season-2', name: 'Fall 2026' },
  ];
  mocks.org.currentSeasonSetting = { id: MOCK_SEASON_ID, name: 'Spring 2026' };
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

  it("carries each trigger's visible text in its accessible name (WCAG 2.5.3)", () => {
    render(
      <MemoryRouter>
        <TopBar />
      </MemoryRouter>
    );
    expectVisibleTextInName(screen.getByRole('button', { name: /^Active Organization: / }));
    expectVisibleTextInName(screen.getByRole('button', { name: 'Active Season: Spring 2026' }));
    expectVisibleTextInName(
      screen.getByRole('button', { name: /^Account menu for Avery Admin, / })
    );
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

  // Role preview (impersonation) was removed with the coach role: its only target was a coach, and
  // no coach signs in (docs/changes/2026-10-27-admin-only.md, decision 2).
  it.each([
    ['an admin', 'Avery Admin', 'admin'],
    ['a staff member', 'Sam Staff', 'staff'],
  ])('offers %s no role preview, and reads nothing to look for one', async (_who, name, role) => {
    mocks.auth.user = { email: 'x@example.com', profile: { full_name: name, role: 'user' } };
    mocks.org = { ...mocks.org, orgMember: { role } };
    render(
      <MemoryRouter>
        <TopBar />
      </MemoryRouter>
    );
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`Account menu for ${name}`) }));
    await screen.findByRole('menuitem', { name: 'Sign out' });
    expect(screen.queryByRole('menuitem', { name: /Preview as/ })).not.toBeInTheDocument();
    expect(mocks.reads).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
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

  it('shows staff the admin navigation, Audit Log included (staff are admins)', () => {
    configureRole(ROLES.STAFF);
    mocks.auth.isAdmin = false;
    mocks.auth.user = { email: 'staff@example.com', profile: { full_name: 'S', role: 'staff' } };
    render(
      <MemoryRouter initialEntries={['/']}>
        <SideNav collapsed={false} onToggleCollapsed={vi.fn()} />
      </MemoryRouter>
    );
    expect(screen.getByRole('link', { name: 'Audit Log' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Teams & Rosters/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Scheduling/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Field Permits' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'My Team' })).not.toBeInTheDocument();
  });

  // No coach, parent or player role (20261024010000, R3; docs/changes/2026-10-27-admin-only.md): a
  // membership still carrying one gets Home and nothing else, not the admin shell.
  it.each(['coach', 'parent', 'player'])('shows a stale %s role Home only', (role) => {
    configureRole(role);
    mocks.auth.isAdmin = false;
    render(
      <MemoryRouter initialEntries={['/']}>
        <SideNav collapsed={false} onToggleCollapsed={vi.fn()} />
      </MemoryRouter>
    );
    expect(screen.getAllByRole('link').map((link) => link.textContent.trim())).toEqual(['Home']);
    expect(screen.queryByRole('button', { name: /Scheduling/ })).not.toBeInTheDocument();
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
