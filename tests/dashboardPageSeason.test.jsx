// The admin home counts the season the header shows (Phase E3a; migration 20261108010000): its
// players and divisions are that season's, and its teams are the ones in those divisions (a team
// carries no season of its own). The fake answers an equality filter as PostgREST does.
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
  },
}));
vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: () => ({
    currentOrganization: { id: 'org-1', name: 'Smoke FC' },
    currentSeasonSetting: { id: FALL, name: 'Fall' },
    seasonSettingsLoading: false,
  }),
}));
vi.mock('../frontend/src/contexts/AuthContext.jsx', () => ({
  useAuth: () => ({ user: { profile: { first_name: 'Ada' } } }),
}));
vi.mock('../frontend/src/hooks/usePermission.js', () => ({
  usePermission: () => ({ role: 'admin', can: () => true }),
}));
vi.mock('../frontend/src/hooks/useFeatures.js', () => ({
  useFeatures: () => ({ genderModel: 'split', isEnabled: () => false }),
}));
vi.mock('../frontend/src/hooks/useSetupProgress.js', () => ({
  useSetupProgress: () => ({
    steps: [],
    doneCount: 0,
    total: 0,
    percent: 0,
    nextStep: null,
    loaded: true,
    error: null,
  }),
}));
vi.mock('../frontend/src/hooks/useFacilityPermits.js', () => ({
  usePermitWarnings: () => null,
}));

const { default: DashboardPage } = await import('../frontend/src/pages/DashboardPage.jsx');

describe('DashboardPage (the admin home)', () => {
  it("counts the selected season's players, divisions and teams", async () => {
    const player = (id, season) => ({
      id,
      organization_id: 'org-1',
      season_settings_id: season,
      status: 'active',
    });
    mocks.tables = {
      players: [player('p1', FALL), player('p2', FALL), player('p3', SPRING)],
      divisions: [
        { id: 'd-fall', organization_id: 'org-1', season_settings_id: FALL, name: 'U8' },
        { id: 'd-spring', organization_id: 'org-1', season_settings_id: SPRING, name: 'U10' },
        { id: 'd-spring-2', organization_id: 'org-1', season_settings_id: SPRING, name: 'U12' },
      ],
      teams: [
        { id: 't1', organization_id: 'org-1', division_id: 'd-fall', name: 'Fall Team' },
        { id: 't2', organization_id: 'org-1', division_id: 'd-spring', name: 'Spring Team' },
        { id: 't3', organization_id: 'org-1', division_id: 'd-spring-2', name: 'Other' },
      ],
      games: [],
      practice_slots: [],
      audit_log: [],
    };
    mocks.reads = [];
    render(
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>
    );
    // 1 division of the season shown, not the 3 of the organization.
    await waitFor(() => expect(screen.getByText('1 divisions')).toBeInTheDocument());
    for (const table of ['players', 'divisions']) {
      const read = mocks.reads.find((r) => r.table === table);
      expect(read.eqs).toContainEqual(['season_settings_id', FALL]);
    }
    // The Teams KPI: one team (the season's), not the organization's three.
    const kpi = screen.getByText('Teams').closest('.kpi');
    expect(kpi.querySelector('.kpi-val')).toHaveTextContent(/^1$/);
    const players = screen.getByText('Players').closest('.kpi');
    expect(players.querySelector('.kpi-val')).toHaveTextContent(/^2$/);
  });
});
