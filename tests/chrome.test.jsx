import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  impersonateUser: vi.fn().mockResolvedValue(undefined),
  toast: vi.fn(),
  previewProfiles: [],
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

vi.mock('../frontend/src/lib/supabaseClient.js', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        in: () => Promise.resolve({ data: [], error: null }),
        // Either filter answers with the seeded profiles, so a filter that
        // let a parent through would show in the menu.
        eq: () => ({
          eq: () => Promise.resolve({ data: mocks.previewProfiles, error: null }),
          in: () => Promise.resolve({ data: mocks.previewProfiles, error: null }),
        }),
      }),
    }),
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
  mocks.previewProfiles = [];
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

  it('toasts when starting a role preview fails, and not when it starts', async () => {
    mocks.previewProfiles = [{ id: 'coach-1', role: 'coach', organization_id: MOCK_ORG_ID }];
    mocks.impersonateUser.mockRejectedValueOnce(new Error('rpc down'));
    render(
      <MemoryRouter>
        <TopBar />
      </MemoryRouter>
    );
    fireEvent.click(screen.getByRole('button', { name: /Account menu for Avery Admin/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Preview as Coach' }));
    await waitFor(() =>
      expect(mocks.toast).toHaveBeenCalledWith(expect.stringMatching(/Could not start/), 'warning')
    );

    mocks.toast.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /Account menu for Avery Admin/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Preview as Coach' }));
    await waitFor(() => expect(mocks.impersonateUser).toHaveBeenCalledTimes(2));
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it('offers role preview to a staff member (staff are admins), passing the org role', async () => {
    mocks.previewProfiles = [{ id: 'coach-1', role: 'coach', organization_id: MOCK_ORG_ID }];
    mocks.auth.isAdmin = false;
    mocks.auth.user = {
      email: 'staff@example.com',
      profile: { full_name: 'Sam Staff', role: 'user' },
    };
    mocks.org = { ...mocks.org, orgMember: { role: 'staff' } };
    render(
      <MemoryRouter>
        <TopBar />
      </MemoryRouter>
    );
    fireEvent.click(screen.getByRole('button', { name: /Account menu for Sam Staff/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Preview as Coach' }));
    await waitFor(() =>
      expect(mocks.impersonateUser).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'coach-1' }),
        {
          orgRole: 'staff',
        }
      )
    );
  });

  // No parent view to preview since 20261024010000 (R3): a profile still
  // carrying the old role is not offered, even if a read returns one.
  it('offers no parent preview', async () => {
    mocks.previewProfiles = [{ id: 'parent-1', role: 'parent', organization_id: MOCK_ORG_ID }];
    render(
      <MemoryRouter>
        <TopBar />
      </MemoryRouter>
    );
    fireEvent.click(screen.getByRole('button', { name: /Account menu for Avery Admin/ }));
    await screen.findByRole('menuitem', { name: 'Sign out' });
    expect(screen.queryByRole('menuitem', { name: /Preview as/ })).not.toBeInTheDocument();
  });

  it('offers no role preview to a coach', () => {
    mocks.previewProfiles = [{ id: 'coach-1', role: 'coach', organization_id: MOCK_ORG_ID }];
    mocks.auth.isAdmin = false;
    mocks.auth.user = {
      email: 'coach@example.com',
      profile: { full_name: 'Cal Coach', role: 'user' },
    };
    mocks.org = { ...mocks.org, orgMember: { role: 'coach' } };
    render(
      <MemoryRouter>
        <TopBar />
      </MemoryRouter>
    );
    fireEvent.click(screen.getByRole('button', { name: /Account menu for Cal Coach/ }));
    expect(screen.queryByRole('menuitem', { name: 'Preview as Coach' })).not.toBeInTheDocument();
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
    expect(screen.queryByRole('link', { name: 'My Team' })).not.toBeInTheDocument();
  });

  it('scopes navigation to the previewed role while impersonating', () => {
    mocks.auth.isImpersonating = true;
    mocks.auth.user = {
      email: 'coach@example.com',
      profile: { full_name: 'Cal Coach', role: 'coach' },
    };
    render(
      <MemoryRouter initialEntries={['/']}>
        <SideNav collapsed={false} onToggleCollapsed={vi.fn()} />
      </MemoryRouter>
    );
    expect(screen.getByRole('link', { name: 'My Dashboard' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'My Team' })).toBeInTheDocument();
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
