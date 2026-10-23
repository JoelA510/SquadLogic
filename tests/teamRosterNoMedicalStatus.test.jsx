/**
 * The team roster shows no medical clearance (plan
 * docs/changes/2026-10-22-admin-focus.md, R1): the badge read
 * `get_team_portal_medical_status`, which went with the registrations it read.
 * A roster row that still carries the old keys renders the player and nothing
 * about clearance.
 */
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

describe('TeamRecordPage roster without medical clearance', () => {
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
      ],
      events: [],
      rsvps: [],
      messages: [],
      myPlayers: [],
      updateRsvp: vi.fn(),
      sendMessage: vi.fn(),
    };
  });

  it('lists the roster with no medical clearance badge', () => {
    render(<TeamRecordPage />);

    fireEvent.click(screen.getByRole('tab', { name: /Roster/ }));

    expect(screen.getByText('Avery Adams')).toBeInTheDocument();
    expect(screen.getByText('Blair Bennett')).toBeInTheDocument();
    expect(screen.queryByText(/Medical Clearance/i)).not.toBeInTheDocument();
  });
});
