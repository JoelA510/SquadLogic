// The Players page after a season switch (Phase E3a; migration 20261108010000): the rows selected
// in one season are not carried into the next, so a bulk Waitlist or Delete sends only the ids of
// the players shown. The page and `usePlayersData` are real; the database is a fake that answers an
// equality filter as PostgREST does and records the bulk RPC.
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const FALL = 'season-fall';
const SPRING = 'season-spring';

const mocks = vi.hoisted(() => ({
  tables: /** @type {Record<string, any[]>} */ ({}),
  seasonId: 'season-fall',
  rpc: vi.fn(),
}));

vi.mock('../frontend/src/lib/supabaseClient.js', () => ({
  supabase: {
    from: (table) => {
      const eqs = [];
      const builder = new Proxy(
        {},
        {
          get: (_target, method) => {
            if (method === 'then') {
              return (resolve, reject) => {
                const data = (mocks.tables[table] || []).filter((row) =>
                  eqs.every(([column, value]) => String(row[column]) === String(value))
                );
                return Promise.resolve({ data, error: null }).then(resolve, reject);
              };
            }
            if (method === 'eq') return (column, value) => (eqs.push([column, value]), builder);
            return () => builder;
          },
        }
      );
      return builder;
    },
    rpc: (...args) => mocks.rpc(...args),
  },
}));
vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: () => ({
    currentOrganization: { id: 'org-1' },
    currentSeasonSetting: { id: mocks.seasonId, status: 'active' },
    seasonSettingsLoading: false,
  }),
}));
vi.mock('../frontend/src/hooks/useDemo.js', () => ({
  useDemo: () => ({ isDemo: false, expiresAtMs: null }),
}));
vi.mock('../frontend/src/hooks/useFeatures.js', () => ({
  useFeatures: () => ({
    features: {},
    isEnabled: () => true,
    genderModel: 'split',
    loading: false,
  }),
}));
vi.mock('../frontend/src/components/ui/ToastHost.jsx', () => ({
  __esModule: true,
  default: ({ children }) => children,
  useToast: () => vi.fn(),
}));

const { default: PlayersPage } = await import('../frontend/src/pages/PlayersPage.jsx');

const player = (id, first, season) => ({
  id,
  organization_id: 'org-1',
  season_settings_id: season,
  first_name: first,
  last_name: 'Player',
  status: 'active',
});

const page = () => (
  <MemoryRouter initialEntries={['/players']}>
    <PlayersPage />
  </MemoryRouter>
);

describe('PlayersPage across a season switch', () => {
  beforeEach(() => {
    mocks.seasonId = FALL;
    mocks.rpc.mockReset();
    mocks.rpc.mockResolvedValue({ data: 1, error: null });
    mocks.tables = {
      players: [
        player('fall-1', 'Fran', FALL),
        player('fall-2', 'Fay', FALL),
        player('spring-1', 'Sam', SPRING),
        player('spring-2', 'Sid', SPRING),
      ],
      divisions: [],
    };
  });

  it("sends only the shown season's ids from a bulk action after the header is switched", async () => {
    const { rerender } = render(page());
    await screen.findByText('Fran Player');
    // Select both of the first season's players.
    for (const box of screen.getAllByRole('checkbox', { name: 'Select row' })) fireEvent.click(box);

    mocks.seasonId = SPRING;
    rerender(page());
    await screen.findByText('Sam Player');
    expect(screen.queryByText('Fran Player')).not.toBeInTheDocument();

    // Select one player of the season now shown and run the bulk action.
    // The first row is Sam's.
    fireEvent.click(screen.getAllByRole('checkbox', { name: 'Select row' })[0]);
    fireEvent.click(screen.getByRole('button', { name: /^Waitlist$/ }));
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalled());
    expect(mocks.rpc).toHaveBeenCalledWith('admin_bulk_update_players', {
      p_player_ids: ['spring-1'],
      p_patch: { status: 'waitlist' },
    });
  });

  it('carries no selection into the next season: a bulk action with nothing selected there names no id', async () => {
    const { rerender } = render(page());
    await screen.findByText('Fran Player');
    for (const box of screen.getAllByRole('checkbox', { name: 'Select row' })) fireEvent.click(box);
    mocks.seasonId = SPRING;
    rerender(page());
    await screen.findByText('Sam Player');
    expect(screen.queryByText(/selected/i)).not.toBeInTheDocument();
    for (const box of screen.getAllByRole('checkbox', { name: 'Select row' })) {
      expect(box).not.toBeChecked();
    }
  });
});
