import React from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PlayerRecordPage from '../frontend/src/pages/PlayerRecordPage.jsx';
import { MOCK_ORG_ID } from '../frontend/src/lib/mockSeedIds.js';

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  tables: {},
}));

vi.mock('../frontend/src/lib/supabaseClient.js', () => ({
  supabase: {
    rpc: mocks.rpc,
    from: (table) => {
      const result = { data: mocks.tables[table] || [], error: null };
      const builder = {
        select: () => builder,
        eq: () => builder,
        or: () => builder,
        order: () => builder,
        limit: () => Promise.resolve(result),
        then: (resolve) => resolve(result),
      };
      return builder;
    },
  },
}));

vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: () => ({
    currentOrganization: { id: MOCK_ORG_ID },
    featureFlags: {},
    loading: false,
  }),
}));

vi.mock('../frontend/src/components/ui/ToastHost.jsx', () => ({
  __esModule: true,
  default: ({ children }) => children,
  useToast: () => vi.fn(),
}));

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/players/p1']}>
      <Routes>
        <Route path="/players/:playerId" element={<PlayerRecordPage />} />
      </Routes>
    </MemoryRouter>
  );
}

describe('PlayerRecordPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rpc.mockResolvedValue({ data: null, error: null });
    mocks.tables = {
      players: [
        {
          id: 'p1',
          organization_id: MOCK_ORG_ID,
          first_name: 'Alex',
          last_name: 'Smith',
          gender: 'm',
          status: 'active',
          division_id: 'd1',
          team_id: null,
          jersey_number: 7,
          years_played: 2,
          rating: null,
          paid: true,
          waiver_received: false,
          medical_form_received: false,
          willing_to_coach: false,
          buddy_request: 'Jamie Jones',
          guardian_contacts: [{ name: 'Dana Smith', email: 'dana@example.com' }],
        },
      ],
      divisions: [{ id: 'd1', name: 'U8B', organization_id: MOCK_ORG_ID }],
      teams: [],
    };
  });

  it('renders the hero with name, status, and division', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Alex Smith' })).toBeInTheDocument();
    expect(screen.getAllByText('U8B').length).toBeGreaterThan(0);
    expect(screen.getByRole('tab', { name: 'Overview' })).toBeInTheDocument();
  });

  it('saves an inline edit through admin_update_player', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Alex Smith' });
    fireEvent.click(screen.getByRole('button', { name: 'Edit First name' }));
    const input = screen.getByRole('textbox', { name: 'First name' });
    fireEvent.change(input, { target: { value: 'Alexander' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() =>
      expect(mocks.rpc).toHaveBeenCalledWith('admin_update_player', {
        p_player_id: 'p1',
        p_patch: { first_name: 'Alexander' },
      })
    );
  });

  it('shows guardians and compliance toggles in their tabs', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Alex Smith' });

    fireEvent.click(screen.getByRole('tab', { name: 'Guardians' }));
    expect(screen.getByText('Primary guardian')).toBeInTheDocument();
    expect(screen.getByText('Dana Smith')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Compliance' }));
    expect(screen.getByRole('switch', { name: 'Registration fee' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    fireEvent.click(screen.getByRole('switch', { name: 'Liability waiver' }));
    await waitFor(() =>
      expect(mocks.rpc).toHaveBeenCalledWith('admin_update_player', {
        p_player_id: 'p1',
        p_patch: { waiver_received: true },
      })
    );
  });
});
