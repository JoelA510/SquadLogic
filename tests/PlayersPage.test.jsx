import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PlayersPage from '../frontend/src/pages/PlayersPage.jsx';

const mocks = vi.hoisted(() => ({
  updatePlayer: vi.fn().mockResolvedValue({ success: true }),
  bulkUpdatePlayers: vi.fn().mockResolvedValue({ success: true }),
  createPlayer: vi.fn().mockResolvedValue({ success: true, player: { id: 'new' } }),
  deletePlayers: vi.fn().mockResolvedValue({ success: true }),
  features: {},
  isDemo: false,
}));

vi.mock('../frontend/src/hooks/useDemo.js', () => ({
  useDemo: () => ({ isDemo: mocks.isDemo, expiresAtMs: null }),
}));

vi.mock('../frontend/src/hooks/usePlayersData.js', () => ({
  usePlayersData: () => ({
    players: [
      {
        id: 'p1',
        first_name: 'Alex',
        last_name: 'Smith',
        gender: 'm',
        division_id: 'd-u8b',
        status: 'active',
        years_played: 2,
        rating: 3,
        jersey_number: 7,
        willing_to_coach: false,
        buddy_request: 'Jamie Jones',
      },
      {
        id: 'p2',
        first_name: 'Mia',
        last_name: 'Lopez',
        gender: 'f',
        division_id: 'd-u8g',
        status: 'waitlist',
        years_played: 0,
        rating: null,
        jersey_number: null,
        willing_to_coach: true,
        buddy_request: null,
      },
    ],
    divisions: [
      { id: 'd-u8b', name: 'U8B' },
      { id: 'd-u8g', name: 'U8G' },
    ],
    loading: false,
    error: null,
    refetch: vi.fn(),
    updatePlayer: mocks.updatePlayer,
    bulkUpdatePlayers: mocks.bulkUpdatePlayers,
    createPlayer: mocks.createPlayer,
    deletePlayers: mocks.deletePlayers,
  }),
}));

vi.mock('../frontend/src/hooks/useFeatures.js', () => ({
  useFeatures: () => ({
    features: mocks.features,
    isEnabled: (key) => mocks.features[key] !== false,
    genderModel: mocks.features.gender_model || 'split',
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
    <MemoryRouter initialEntries={['/players']}>
      <PlayersPage />
    </MemoryRouter>
  );
}

describe('PlayersPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.features = {};
    mocks.isDemo = false;
    mocks.updatePlayer.mockResolvedValue({ success: true });
    mocks.bulkUpdatePlayers.mockResolvedValue({ success: true });
  });

  it('renders players with feature-gated columns (rating off by default)', () => {
    mocks.features = { player_rating: false };
    renderPage();
    expect(screen.getByText('Alex Smith')).toBeInTheDocument();
    expect(screen.getByText('Yrs')).toBeInTheDocument();
    expect(screen.queryByText('Rating')).not.toBeInTheDocument();
    expect(screen.getByText('Buddy request')).toBeInTheDocument();
  });

  it('shows the rating column when the player_rating feature is on', () => {
    mocks.features = { player_rating: true };
    renderPage();
    expect(screen.getByText('Rating')).toBeInTheDocument();
  });

  it('collapses division labels under the coed gender model', () => {
    mocks.features = { gender_model: 'coed' };
    renderPage();
    const divisionFilter = screen.getByRole('combobox', { name: 'Filter by division' });
    // U8B + U8G fold into a single U8 option
    expect(
      within(divisionFilter)
        .getAllByRole('option')
        .map((o) => o.textContent)
    ).toEqual(['All divisions', 'U8']);
  });

  it('commits a cell edit through the admin update RPC', async () => {
    renderPage();
    fireEvent.doubleClick(screen.getByText('Jamie Jones'));
    const input = screen.getByRole('textbox', { name: 'Buddy request' });
    fireEvent.change(input, { target: { value: 'Mia Lopez' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await vi.waitFor(() =>
      expect(mocks.updatePlayer).toHaveBeenCalledWith('p1', { buddy_request: 'Mia Lopez' })
    );
  });

  it('runs the bulk waitlist action on the selection', async () => {
    renderPage();
    const checkboxes = screen.getAllByRole('checkbox', { name: 'Select row' });
    fireEvent.click(checkboxes[0]);
    fireEvent.click(checkboxes[1]);
    fireEvent.click(screen.getByRole('button', { name: /^Waitlist$/ }));
    await vi.waitFor(() =>
      expect(mocks.bulkUpdatePlayers).toHaveBeenCalledWith(expect.arrayContaining(['p1', 'p2']), {
        status: 'waitlist',
      })
    );
  });

  // Paperwork and payment are tracked on the league's registration platform
  // (docs/changes/2026-10-22-admin-focus.md, R1): no column, no bulk action.
  it('offers no paid, waiver or medical column or bulk action', () => {
    renderPage();
    const checkboxes = screen.getAllByRole('checkbox', { name: 'Select row' });
    fireEvent.click(checkboxes[0]);
    for (const header of ['Paid', 'Waiver', 'Medical']) {
      expect(screen.queryByRole('columnheader', { name: header })).not.toBeInTheDocument();
    }
    expect(screen.queryByRole('button', { name: /Mark paid/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Waiver received/ })).not.toBeInTheDocument();
  });

  it('adds a player from the header action', async () => {
    renderPage();
    // both the header action and the grid add-row carry this label
    fireEvent.click(screen.getAllByRole('button', { name: /Add player/ })[0]);
    await vi.waitFor(() => expect(mocks.createPlayer).toHaveBeenCalled());
  });

  // Demo mode (docs/changes/2026-10-22-demo-mode.md, D3/D4): a demo's people are read-only except
  // where they play and how they are rated. The server refuses the rest; the page does not offer it.
  describe('in a demo', () => {
    beforeEach(() => {
      mocks.isDemo = true;
    });

    it('does not let a name, gender or buddy request be edited', () => {
      renderPage();
      fireEvent.doubleClick(screen.getByText('Alex Smith'));
      expect(screen.queryByRole('textbox', { name: 'Player' })).not.toBeInTheDocument();
      fireEvent.doubleClick(screen.getByText('Jamie Jones'));
      expect(screen.queryByRole('textbox', { name: 'Buddy request' })).not.toBeInTheDocument();
      expect(mocks.updatePlayer).not.toHaveBeenCalled();
    });

    it('still lets a status be changed (control: the grid is not simply frozen)', async () => {
      renderPage();
      fireEvent.doubleClick(screen.getAllByText('active')[0]);
      const select = await screen.findByRole('combobox', { name: 'Status' });
      fireEvent.change(select, { target: { value: 'inactive' } });
      fireEvent.keyDown(select, { key: 'Enter' });
      await vi.waitFor(() =>
        expect(mocks.updatePlayer).toHaveBeenCalledWith('p1', { status: 'inactive' })
      );
    });

    it('offers no way to add or delete a player', () => {
      renderPage();
      expect(screen.queryByRole('button', { name: /Add player/ })).not.toBeInTheDocument();
      fireEvent.click(screen.getAllByRole('checkbox', { name: 'Select row' })[0]);
      expect(screen.getByRole('button', { name: /^Waitlist$/ })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^Delete$/ })).not.toBeInTheDocument();
      fireEvent.click(screen.getAllByRole('button', { name: /Row actions|actions/i })[0]);
      expect(screen.queryByRole('menuitem', { name: /Delete player/ })).not.toBeInTheDocument();
      expect(screen.getByRole('menuitem', { name: /Open record/ })).toBeInTheDocument();
    });
  });
});
