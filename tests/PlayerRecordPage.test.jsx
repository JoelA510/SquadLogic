import React from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PlayerRecordPage from '../frontend/src/pages/PlayerRecordPage.jsx';
import { MOCK_ORG_ID } from '../frontend/src/lib/mockSeedIds.js';

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  tables: {},
  demoExpiresAt: null,
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
    currentOrganization: { id: MOCK_ORG_ID, demo_expires_at: mocks.demoExpiresAt },
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
    mocks.demoExpiresAt = null;
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
          willing_to_coach: false,
          buddy_request: 'Jamie Jones',
          // A row read before 20261025010000 dropped the column: the page
          // must not show it.
          guardian_contacts: [{ name: 'Dana Smith', email: 'dana@example.com' }],
          natural_age: 8,
          // A row read before 20261026010000 dropped the columns (R5): the page
          // must not show them.
          date_of_birth: '2018-02-03',
          birth_year: 2018,
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
    fireEvent.click(screen.getByRole('button', { name: /^Edit First name:/ }));
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

  // The stored play-up request (docs/changes/2026-10-27-play-up-by-request.md): an admin sets
  // or clears it on the record, through the audited player patch.
  it('sets and clears the play-up request through admin_update_player', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Alex Smith' });
    expect(screen.getByRole('button', { name: /^Edit Play-up requested:/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^Edit Play-up requested:/ }));
    const select = screen.getByRole('combobox', { name: 'Play-up requested' });
    fireEvent.change(select, { target: { value: 'true' } });
    fireEvent.keyDown(select, { key: 'Enter' });
    await waitFor(() =>
      expect(mocks.rpc).toHaveBeenCalledWith('admin_update_player', {
        p_player_id: 'p1',
        p_patch: { play_up_requested: true },
      })
    );

    fireEvent.click(await screen.findByRole('button', { name: /^Edit Play-up requested:/ }));
    const again = screen.getByRole('combobox', { name: 'Play-up requested' });
    fireEvent.change(again, { target: { value: 'false' } });
    fireEvent.keyDown(again, { key: 'Enter' });
    await waitFor(() =>
      expect(mocks.rpc).toHaveBeenCalledWith('admin_update_player', {
        p_player_id: 'p1',
        p_patch: { play_up_requested: false },
      })
    );
  });

  // Guardian contacts are not stored (docs/changes/2026-10-22-admin-focus.md,
  // R4): no Guardians tab, and a contact on a stale row is shown nowhere.
  it('has no Guardians tab and shows no guardian contact', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Alex Smith' });

    expect(screen.queryByRole('tab', { name: 'Guardians' })).not.toBeInTheDocument();
    for (const tab of screen.getAllByRole('tab')) {
      fireEvent.click(tab);
      expect(screen.queryByText(/Dana Smith|dana@example\.com/)).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Add guardian' })).not.toBeInTheDocument();
    }
  });

  // No birth date is stored (docs/changes/2026-10-22-admin-focus.md, R5): the
  // record shows the stored natural age as an age group, and no birth date or year.
  it('shows the age group and no birth date or birth year', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Alex Smith' });
    expect(screen.getByText('Age group')).toBeInTheDocument();
    expect(screen.getByText('U8')).toBeInTheDocument();
    expect(screen.queryByText(/Birth year/i)).not.toBeInTheDocument();
    for (const tab of screen.getAllByRole('tab')) {
      fireEvent.click(tab);
      expect(screen.queryByText(/2018/)).not.toBeInTheDocument();
    }
  });

  // Paperwork and payment are tracked on the league's registration platform
  // (docs/changes/2026-10-22-admin-focus.md, R1).
  it('has no Compliance tab', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Alex Smith' });
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'Overview',
      'Team & Schedule',
    ]);
  });

  // Demo mode (docs/changes/2026-10-22-demo-mode.md, D3/D4): a demo's players are read-only except
  // where they play and how they are rated.
  describe('in a demo', () => {
    beforeEach(() => {
      mocks.demoExpiresAt = new Date(Date.now() + 20 * 60_000).toISOString();
    });

    it('shows the names, gender and buddy request but offers no edit on them', async () => {
      renderPage();
      await screen.findByRole('heading', { name: 'Alex Smith' });
      for (const label of ['First name', 'Last name', 'Gender', 'Buddy request']) {
        expect(screen.queryByRole('button', { name: new RegExp(`^Edit ${label}:`) })).toBeNull();
      }
      expect(screen.getByText('Alex')).toBeInTheDocument();
    });

    it('offers no edit on the play-up request, which the server fence refuses too', async () => {
      renderPage();
      await screen.findByRole('heading', { name: 'Alex Smith' });
      // Control: the field is shown, with its value, and only the edit is withheld.
      expect(screen.getByText('Play-up requested')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^Edit Play-up requested:/ })).toBeNull();
    });

    it('still offers an edit on where the player plays (control)', async () => {
      renderPage();
      await screen.findByRole('heading', { name: 'Alex Smith' });
      expect(screen.getByRole('button', { name: /^Edit Status:/ })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^Edit Jersey #:/ })).toBeInTheDocument();
    });
  });
});
