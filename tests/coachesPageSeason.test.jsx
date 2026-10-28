// The Coaches page lists the season the header shows (Phase E3a; migration 20261108010000): a coach
// row belongs to one season, so last season's coaches, and the teams of last season's divisions,
// are not on it. The fake answers an equality filter as PostgREST does.
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

const FALL = 'season-fall';
const SPRING = 'season-spring';

const mocks = vi.hoisted(() => ({
  tables: /** @type {Record<string, any[]>} */ ({}),
  reads: /** @type {Array<{ table: string, eqs: Array<[string, unknown]> }>} */ ([]),
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
                mocks.reads.push({ table, eqs: [...eqs] });
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
    rpc: async () => ({ data: null, error: null }),
  },
}));
vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: () => ({
    currentOrganization: { id: 'org-1' },
    currentSeasonSetting: { id: FALL, status: 'active' },
    seasonSettingsLoading: false,
  }),
}));
vi.mock('../frontend/src/hooks/usePermission.js', () => ({
  usePermission: () => ({ can: () => true, PERMISSIONS: { MANAGE_ORGANIZATION: 'm' } }),
}));
vi.mock('../frontend/src/hooks/useFeatures.js', () => ({
  useFeatures: () => ({ genderModel: 'split' }),
}));
vi.mock('../frontend/src/hooks/useDemo.js', () => ({ useDemo: () => ({ isDemo: false }) }));
vi.mock('../frontend/src/components/ui/ToastHost.jsx', () => ({
  useToast: () => () => {},
}));

const { default: CoachesPage } = await import('../frontend/src/pages/CoachesPage.jsx');

describe('CoachesPage', () => {
  it("lists the selected season's coaches and nobody else's", async () => {
    mocks.tables = {
      coaches: [
        {
          id: 'c1',
          organization_id: 'org-1',
          season_settings_id: FALL,
          full_name: 'Fall Coach',
          email: 'f@example.test',
          status: 'active',
        },
        {
          id: 'c2',
          organization_id: 'org-1',
          season_settings_id: SPRING,
          full_name: 'Spring Coach',
          email: 's@example.test',
          status: 'active',
        },
      ],
      divisions: [
        { id: 'd-fall', organization_id: 'org-1', season_settings_id: FALL, name: 'U8' },
        { id: 'd-spring', organization_id: 'org-1', season_settings_id: SPRING, name: 'U10' },
      ],
      teams: [
        {
          id: 't1',
          organization_id: 'org-1',
          division_id: 'd-fall',
          name: 'Fall Team',
          coach_id: 'c1',
        },
        {
          id: 't2',
          organization_id: 'org-1',
          division_id: 'd-spring',
          name: 'Spring Team',
          coach_id: 'c2',
        },
      ],
      team_coach_assignments: [],
    };
    mocks.reads = [];
    render(
      <MemoryRouter>
        <CoachesPage />
      </MemoryRouter>
    );
    await waitFor(() => expect(screen.getAllByText('Fall Coach').length).toBeGreaterThan(0));
    expect(screen.queryByText('Spring Coach')).not.toBeInTheDocument();
    expect(screen.queryByText('Spring Team')).not.toBeInTheDocument();
    for (const table of ['coaches', 'divisions']) {
      const read = mocks.reads.find((r) => r.table === table);
      expect(read.eqs).toContainEqual(['season_settings_id', FALL]);
    }
  });
});
