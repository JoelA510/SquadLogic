// The team page as a non-admin, a coach since 20261024010000 removed the parent
// role (Phase A3a, migration 20261021010000): the roster shows what the
// server-side read returned (names only for a coach), the Staff tab lists
// every current coach from get_team_staff, and the Balance tab (gender, years
// played, rating: admin-only fields) is not offered. Since 20261025010000 (R4)
// neither read returns a contact and the page shows none, to anyone: the
// fixtures below still carry guardian contacts and a coach's phone and email,
// as a response from before R4 would, so a page rendering one would show.
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import TeamRecordPage from '../frontend/src/pages/TeamRecordPage.jsx';

const mocks = vi.hoisted(() => ({
  portalState: null,
  admin: false,
  rpc: vi.fn(),
}));

vi.mock('react-router-dom', () => ({
  useParams: () => ({ teamId: 'team-1' }),
  Link: ({ children, ...props }) => <a {...props}>{children}</a>,
}));

vi.mock('../frontend/src/hooks/useTeamPortal.js', () => ({
  useTeamPortal: () => mocks.portalState,
  PRACTICE_CHANGES_UNREAD_TEXT: 'Practice changes are unread.',
}));

vi.mock('../frontend/src/hooks/usePermission.js', () => ({
  usePermission: () => ({
    can: () => mocks.admin,
    role: mocks.admin ? 'admin' : 'coach',
    PERMISSIONS: { MANAGE_ALL_TEAMS: 'manage_all_teams' },
  }),
}));

vi.mock('../frontend/src/lib/supabaseClient.js', () => ({
  supabase: { rpc: (name, params) => mocks.rpc(name, params) },
}));

const STAFF = [
  {
    coach_id: 'coach-1',
    full_name: 'Cora Lead',
    role: 'lead',
    phone: '555-0102',
    email: 'cora@example.test',
    status: null,
  },
  {
    coach_id: 'coach-2',
    full_name: 'Abe Assist',
    role: 'assistant',
    phone: null,
    email: null,
    status: null,
  },
];

beforeEach(() => {
  mocks.admin = false;
  mocks.rpc.mockReset();
  mocks.rpc.mockImplementation(async (name) =>
    name === 'get_team_staff' ? { data: STAFF, error: null } : { data: null, error: null }
  );
  mocks.portalState = {
    loading: false,
    error: null,
    team: { id: 'team-1', name: 'Tigers', division: { name: 'U10', season: null } },
    roster: [
      {
        id: 'p-1',
        player_id: 'p-1',
        first_name: 'Pia',
        last_name: 'Able',
        guardian_contacts: [
          { name: 'Gwen Able', email: 'gwen@example.test', phone: '555-0201' },
          { name: 'Gus Able', email: 'gus@example.test' },
        ],
      },
      {
        id: 'p-2',
        player_id: 'p-2',
        first_name: 'Rex',
        last_name: 'Baker',
        guardian_contacts: [{ name: 'Rhea Baker', email: 'rhea@example.test' }],
      },
      {
        id: 'p-3',
        player_id: 'p-3',
        first_name: 'Quinn',
        last_name: 'Cole',
        guardian_contacts: [],
      },
    ],
    events: [],
    practiceChangesUnread: false,
  };
});

describe('TeamRecordPage as a non-admin', () => {
  it('shows a coach the names their roster read returned, and no guardian contact', () => {
    // As get_team_roster answers a coach since 20261024010000: no contacts.
    mocks.portalState = {
      ...mocks.portalState,
      roster: mocks.portalState.roster.map((row) => ({ ...row, guardian_contacts: [] })),
    };
    render(<TeamRecordPage />);
    fireEvent.click(screen.getByRole('tab', { name: /Roster/ }));
    expect(screen.getByText('Pia Able')).toBeInTheDocument();
    expect(screen.getByText('Quinn Cole')).toBeInTheDocument();
    expect(screen.queryAllByRole('list', { name: 'Guardian contacts' })).toHaveLength(0);
  });

  it('shows an admin no guardian contact, even one a stale roster row carries', () => {
    mocks.admin = true;
    render(<TeamRecordPage />);
    fireEvent.click(screen.getByRole('tab', { name: /Roster/ }));
    expect(screen.getByText('Quinn Cole')).toBeInTheDocument();
    expect(screen.queryAllByRole('list', { name: 'Guardian contacts' })).toHaveLength(0);
    expect(
      screen.queryByText(/Gwen Able|gwen@example\.test|555-0201|rhea@example\.test/)
    ).toBeNull();
    expect(document.querySelector('a[href^="tel:"], a[href^="mailto:"]')).toBeNull();
  });

  it('shows the staff with no email or phone, to an admin as to a coach', async () => {
    for (const admin of [false, true]) {
      mocks.admin = admin;
      const { unmount } = render(<TeamRecordPage />);
      fireEvent.click(screen.getByRole('tab', { name: 'Staff' }));
      expect(await screen.findByText('Cora Lead')).toBeInTheDocument();
      expect(screen.queryByText('Email')).not.toBeInTheDocument();
      expect(screen.queryByText('Phone')).not.toBeInTheDocument();
      expect(screen.queryByText(/cora@example\.test|555-0102/)).toBeNull();
      unmount();
    }
  });

  it('tells an admin how many players have a family member willing to coach, without naming one', async () => {
    mocks.admin = true;
    mocks.portalState = {
      ...mocks.portalState,
      roster: mocks.portalState.roster.map((row, index) => ({
        ...row,
        willing_to_coach: index === 0,
      })),
    };
    render(<TeamRecordPage />);
    fireEvent.click(screen.getByRole('tab', { name: 'Staff' }));
    expect(
      await screen.findByText('1 player(s) on this roster have a family member willing to coach.')
    ).toBeInTheDocument();
    expect(screen.queryByText(/guardian/i)).toBeNull();
  });

  it('lists every current coach from get_team_staff, and no status or volunteer count', async () => {
    render(<TeamRecordPage />);
    fireEvent.click(screen.getByRole('tab', { name: 'Staff' }));
    expect(await screen.findByText('Cora Lead')).toBeInTheDocument();
    expect(screen.getByText('Abe Assist')).toBeInTheDocument();
    expect(screen.getByText('Head coach')).toBeInTheDocument();
    expect(screen.getByText('Assistant coach')).toBeInTheDocument();
    expect(mocks.rpc).toHaveBeenCalledWith('get_team_staff', { p_team_id: 'team-1' });
    expect(screen.queryByText('Status')).not.toBeInTheDocument();
    expect(screen.queryByText(/willing to coach/)).not.toBeInTheDocument();
  });

  it('says so when the staff read is refused, instead of "No coach assigned"', async () => {
    mocks.rpc.mockImplementation(async () => ({
      data: null,
      error: { code: '42501', message: "not permitted to read this team's staff" },
    }));
    render(<TeamRecordPage />);
    fireEvent.click(screen.getByRole('tab', { name: 'Staff' }));
    expect(await screen.findByText('The coaching staff could not be loaded.')).toBeInTheDocument();
    expect(screen.queryByText('No coach assigned.')).not.toBeInTheDocument();
  });

  it('keeps the page and says why when the roster read refuses the caller', () => {
    mocks.portalState = { ...mocks.portalState, roster: [], rosterUnavailable: 'refused' };
    render(<TeamRecordPage />);
    fireEvent.click(screen.getByRole('tab', { name: /Roster/ }));
    expect(screen.getByText(/The roster is shown to the team's coaches/)).toBeInTheDocument();
    expect(screen.queryByText('No players assigned yet.')).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Schedule' })).toBeInTheDocument();
  });

  it('offers no Balance tab to a non-admin, and offers it to an admin', () => {
    const { unmount } = render(<TeamRecordPage />);
    expect(screen.queryByRole('tab', { name: 'Balance' })).not.toBeInTheDocument();
    unmount();
    mocks.admin = true;
    render(<TeamRecordPage />);
    expect(screen.getByRole('tab', { name: 'Balance' })).toBeInTheDocument();
  });
});
