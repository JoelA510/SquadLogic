// The coach home as a coach (Phase A3a, migration 20261021010000): it finds the
// coach's teams through get_my_coached_team_ids (not by reading every coach row
// and matching emails in the browser), shows the coach directory while the
// league's setting is on, and says so when the reads fail.
import React from 'react';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DashboardPage from '../frontend/src/pages/DashboardPage.jsx';

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  from: vi.fn(),
  flags: {},
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
  useAuth: () => ({ user: { id: 'cora', email: 'cora@example.test' }, isImpersonating: false }),
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

const DIRECTORY = [
  {
    coach_id: 'c-cora',
    full_name: 'Cora Lead',
    phone: '555-0102',
    email: 'cora@example.test',
    team_names: ['A-Team'],
  },
  { coach_id: 'c-otto', full_name: 'Otto Lead', phone: null, email: null, team_names: ['B-Team'] },
];

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
  mocks.rpc.mockReset();
  mocks.rpc.mockImplementation(async (name) => {
    if (name === 'get_my_coached_team_ids') return { data: ['team-a'], error: null };
    if (name === 'get_coach_directory') return { data: DIRECTORY, error: null };
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

  it('lists the coach directory while the league setting is on', async () => {
    render(<DashboardPage />);
    expect(await screen.findByRole('heading', { name: 'Coach directory' })).toBeInTheDocument();
    expect(screen.getByText('Otto Lead')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '555-0102' })).toHaveAttribute('href', 'tel:555-0102');
  });

  it('neither shows nor reads the directory while the league setting is off', async () => {
    mocks.flags = { coach_directory: false };
    render(<DashboardPage />);
    await screen.findByRole('link', { name: 'Open A-Team' });
    expect(screen.queryByRole('heading', { name: 'Coach directory' })).not.toBeInTheDocument();
    expect(mocks.rpc).not.toHaveBeenCalledWith('get_coach_directory', expect.anything());
  });

  it('keeps the teams when only the directory read is refused', async () => {
    mocks.rpc.mockImplementation(async (name) => {
      if (name === 'get_my_coached_team_ids') return { data: ['team-a'], error: null };
      return { data: null, error: { code: '42501', message: 'not permitted' } };
    });
    render(<DashboardPage />);
    expect(await screen.findByRole('link', { name: 'Open A-Team' })).toBeInTheDocument();
    expect(screen.getByText('The coach directory could not be loaded.')).toBeInTheDocument();
    expect(screen.queryByText(/Your teams could not be loaded/)).not.toBeInTheDocument();
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
