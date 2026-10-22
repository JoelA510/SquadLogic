import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import TeamRecordPage from '../frontend/src/pages/TeamRecordPage.jsx';

const mocks = vi.hoisted(() => ({
  portalState: null,
}));

vi.mock('react-router-dom', () => ({
  useParams: () => ({ teamId: 'team-1' }),
  Link: ({ children, ...props }) => <a {...props}>{children}</a>,
}));

vi.mock('../frontend/src/hooks/useTeamPortal.js', () => ({
  useTeamPortal: () => mocks.portalState,
}));

vi.mock('../frontend/src/hooks/usePermission.js', () => ({
  usePermission: () => ({
    can: () => false,
    role: 'coach',
    PERMISSIONS: { MANAGE_ALL_TEAMS: 'manage_all_teams' },
  }),
}));

vi.mock('../frontend/src/lib/supabaseClient.js', () => ({
  supabase: {
    from: () => ({
      select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }),
    }),
    rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
  },
}));

describe('TeamRecordPage medical clearance', () => {
  beforeEach(() => {
    mocks.portalState = {
      loading: false,
      error: null,
      team: {
        name: 'Tigers',
        division: {
          name: 'U10',
          season: { season_label: 'Fall', season_year: 2026 },
        },
      },
      roster: [
        {
          id: 'cleared-player',
          first_name: 'Avery',
          last_name: 'Adams',
          medical_cleared: true,
          medical_clearance_visible: true,
        },
        {
          id: 'pending-player',
          first_name: 'Blair',
          last_name: 'Bennett',
          medical_cleared: false,
          medical_clearance_visible: true,
        },
        {
          id: 'hidden-player',
          first_name: 'Casey',
          last_name: 'Chen',
          medical_cleared: true,
          medical_clearance_visible: false,
        },
      ],
      events: [],
      rsvps: [],
      messages: [],
      myPlayers: [],
      updateRsvp: vi.fn(),
      sendMessage: vi.fn(),
    };
  });

  it('renders medical clearance from registration state instead of hardcoded player ids', () => {
    render(<TeamRecordPage />);

    // Roster (with medical status) lives in the Roster tab.
    fireEvent.click(screen.getByRole('tab', { name: /Roster/ }));

    expect(screen.getByText('Avery Adams')).toBeInTheDocument();
    expect(screen.getByText('Blair Bennett')).toBeInTheDocument();
    expect(screen.getByText('Casey Chen')).toBeInTheDocument();
    expect(screen.getByText('Medical Clearance: Yes')).toHaveClass('text-status-success');
    expect(screen.getByText('Medical Clearance: Pending')).toHaveClass('text-status-warning-text');
    expect(screen.getAllByText(/Medical Clearance:/)).toHaveLength(2);
  });
});
