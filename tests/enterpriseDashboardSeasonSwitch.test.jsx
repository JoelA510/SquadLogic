// The Reports page after a season switch (Phase E3a; migration 20261108010000): a response for the
// season shown before the switch, arriving after the one for the season now shown, must not
// replace it. The page is real; the database is a fake that answers an equality filter as
// PostgREST does and holds a season's reads until released.
import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const FALL = 'season-fall';
const SPRING = 'season-spring';

const mocks = vi.hoisted(() => ({
  seasonId: 'season-fall',
  gates: /** @type {Record<string, Promise<void>>} */ ({}),
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
                const season = eqs.find(([column]) => column === 'season_settings_id')?.[1];
                return Promise.resolve(mocks.gates[season])
                  .then(() => {
                    if (table !== 'players') return { data: null, error: null };
                    const count = season === FALL ? 311 : 477;
                    return {
                      data: Array.from({ length: count }, (_, i) => ({
                        id: `${season}-${i}`,
                        custom_attributes: { jersey_size: 'Small' },
                      })),
                      error: null,
                    };
                  })
                  .then(resolve, reject);
              };
            }
            if (method === 'eq') return (column, value) => (eqs.push([column, value]), builder);
            return () => builder;
          },
        }
      );
      return builder;
    },
  },
}));
vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: () => ({
    currentOrganization: { id: 'org-1', settings: {} },
    currentSeasonSetting: { id: mocks.seasonId },
    seasonSettingsLoading: false,
  }),
}));

const { default: EnterpriseDashboard } =
  await import('../frontend/src/pages/EnterpriseDashboard.jsx');

describe('EnterpriseDashboard across a season switch', () => {
  it('keeps the season shown when a late response for the season left arrives', async () => {
    /** @type {() => void} */
    let release = () => {};
    mocks.gates[FALL] = new Promise((resolve) => {
      release = resolve;
    });
    mocks.seasonId = FALL;
    const { rerender } = render(<EnterpriseDashboard />);
    mocks.seasonId = SPRING;
    rerender(<EnterpriseDashboard />);
    expect((await screen.findAllByText('477')).length).toBeGreaterThan(0);

    release();
    await act(async () => {
      await mocks.gates[FALL];
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    await waitFor(() => expect(screen.getAllByText('477').length).toBeGreaterThan(0));
    expect(screen.queryAllByText('311')).toHaveLength(0);
  });
});
