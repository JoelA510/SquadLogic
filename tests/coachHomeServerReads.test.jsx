// The coach home as a coach (Phase A3a, migration 20261021010000): it finds the
// coach's teams through get_my_coached_team_ids (not by reading every coach row
// and matching emails in the browser), and says so when the read fails. It
// shows no coach directory: coaches see no contact details (R4, migration
// 20261025010000, which dropped get_coach_directory).
import React from 'react';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DashboardPage from '../frontend/src/pages/DashboardPage.jsx';

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  from: vi.fn(),
  flags: {},
  impersonating: false,
}));

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...props }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
  useLocation: () => ({ state: null }),
  useNavigate: () => vi.fn(),
}));

vi.mock('../frontend/src/hooks/usePermission.js', () => ({
  usePermission: () => ({ can: () => false, role: 'coach', PERMISSIONS: {} }),
}));

vi.mock('../frontend/src/contexts/AuthContext.jsx', () => ({
  useAuth: () =>
    mocks.impersonating
      ? {
          user: {
            id: 'admin',
            email: 'admin@example.test',
            profile: { id: 'cora', role: 'coach' },
          },
          isImpersonating: true,
        }
      : { user: { id: 'cora', email: 'cora@example.test' }, isImpersonating: false },
}));

vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: () => ({ currentOrganization: { id: 'org-a' }, featureFlags: mocks.flags }),
}));

vi.mock('../frontend/src/lib/supabaseClient.js', () => ({
  supabase: { rpc: (name, params) => mocks.rpc(name, params), from: (t) => mocks.from(t) },
}));

vi.mock('../frontend/src/lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), log: vi.fn() },
}));

function teamsTable(rows) {
  const q = {
    select: () => q,
    eq: () => q,
    in: (_col, ids) =>
      Promise.resolve({ data: rows.filter((r) => ids.includes(r.id)), error: null }),
  };
  return q;
}

beforeEach(() => {
  mocks.flags = {};
  mocks.impersonating = false;
  mocks.rpc.mockReset();
  mocks.rpc.mockImplementation(async (name) => {
    if (name === 'get_my_coached_team_ids') return { data: ['team-a'], error: null };
    if (name === 'admin_get_coached_team_ids') return { data: ['team-b'], error: null };
    return { data: null, error: null };
  });
  mocks.from.mockReset();
  mocks.from.mockImplementation((table) => {
    if (table !== 'teams') throw new Error(`the coach home read ${table} directly`);
    return teamsTable([
      { id: 'team-a', name: 'A-Team' },
      { id: 'team-b', name: 'B-Team' },
    ]);
  });
});

describe('Coach home', () => {
  it('shows the teams the coach currently coaches, and reads no coach rows', async () => {
    render(<DashboardPage />);
    expect(await screen.findByText('A-Team', { selector: 'div' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open A-Team' })).toHaveAttribute(
      'href',
      '/team/team-a'
    );
    expect(screen.queryByRole('link', { name: 'Open B-Team' })).not.toBeInTheDocument();
    expect(mocks.from).not.toHaveBeenCalledWith('coaches');
  });

  it('in an admin’s role preview, shows the previewed coach’s teams, not the admin’s', async () => {
    mocks.impersonating = true;
    render(<DashboardPage />);
    expect(await screen.findByRole('link', { name: 'Open B-Team' })).toBeInTheDocument();
    expect(mocks.rpc).toHaveBeenCalledWith('admin_get_coached_team_ids', {
      p_organization_id: 'org-a',
      p_user_id: 'cora',
    });
    expect(mocks.rpc).not.toHaveBeenCalledWith('get_my_coached_team_ids', expect.anything());
  });

  it('shows no coach directory and reads none, whatever a stored coach_directory says', async () => {
    for (const flags of [{}, { coach_directory: true }]) {
      mocks.flags = flags;
      mocks.rpc.mockClear();
      const { unmount } = render(<DashboardPage />);
      await screen.findByRole('link', { name: 'Open A-Team' });
      expect(screen.queryByRole('heading', { name: 'Coach directory' })).not.toBeInTheDocument();
      expect(document.querySelector('a[href^="tel:"], a[href^="mailto:"]')).toBeNull();
      expect(mocks.rpc).not.toHaveBeenCalledWith('get_coach_directory', expect.anything());
      unmount();
    }
  });

  it('says the teams could not be loaded when the read fails, not that none are assigned', async () => {
    mocks.rpc.mockImplementation(async () => ({
      data: null,
      error: { code: '42501', message: 'denied' },
    }));
    render(<DashboardPage />);
    expect(
      await screen.findByText('Your teams could not be loaded. Try again shortly.')
    ).toBeInTheDocument();
    expect(screen.queryByText(/No team is assigned to you yet/)).not.toBeInTheDocument();
  });
});
