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
  chains: /** @type {Array<{ table: string, calls: any[] }>} */ ([]),
}));

vi.mock('../frontend/src/lib/supabaseClient.js', () => ({
  supabase: {
    from: (table) => {
      const eqs = [];
      const calls = [];
      mocks.chains.push({ table, calls });
      const builder = new Proxy(
        {},
        {
          get: (_target, method) => {
            if (method === 'then') {
              return (resolve, reject) => {
                mocks.reads.push({ table, eqs: [...eqs] });
                // The filters, order and limit a read asks the server for, applied as the server applies them.
                let data = (mocks.tables[table] || []).filter((row) =>
                  eqs.every(([column, value]) => String(row[column]) === String(value))
                );
                for (const [method, column, value] of calls) {
                  if (method === 'in') data = data.filter((row) => value.includes(row[column]));
                  if (method === 'gte') data = data.filter((row) => row[column] >= value);
                  if (method === 'lte') data = data.filter((row) => row[column] <= value);
                  if (method === 'order') {
                    const up = value?.ascending !== false;
                    data = [...data].sort((a, b) =>
                      a[column] < b[column]
                        ? up
                          ? -1
                          : 1
                        : a[column] > b[column]
                          ? up
                            ? 1
                            : -1
                          : 0
                    );
                  }
                  if (method === 'limit') data = data.slice(0, column);
                }
                // A `select(columns, { count, head })` read answers its count, and no rows with `head`.
                const options = calls.find(([m]) => m === 'select')?.[2];
                const answer = options?.count
                  ? { data: options.head ? null : data, count: data.length, error: null }
                  : { data, error: null };
                return Promise.resolve(answer).then(resolve, reject);
              };
            }
            if (method === 'eq') return (column, value) => (eqs.push([column, value]), builder);
            return (...args) => (calls.push([method, ...args]), builder);
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
      current_game_runs: [],
      game_assignments: [],
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
  it('counts and lists the games of the saved schedule of the season (F11-3 C3), not the legacy games table', async () => {
    const game = (id, start, home, away) => ({
      id,
      organization_id: 'org-1',
      run_id: 'run-fall',
      season_settings_id: FALL,
      start,
      end: start,
      home_team: { id: `${id}-h`, name: home, division: { name: 'U8' } },
      away_team: { id: `${id}-a`, name: away, division: { name: 'U8' } },
      game_scores: [],
    });
    mocks.tables = {
      players: [],
      divisions: [],
      teams: [],
      // A row of the legacy table: read by nothing, so it is neither counted nor listed.
      games: [{ id: 'legacy', organization_id: 'org-1', start_time: '2099-01-01T00:00:00Z' }],
      current_game_runs: [
        { organization_id: 'org-1', season_settings_id: FALL, run_id: 'run-fall' },
        { organization_id: 'org-1', season_settings_id: SPRING, run_id: 'run-spring' },
      ],
      game_assignments: [
        game('g-past', '2020-03-01T15:00:00Z', 'Past Home', 'Past Away'),
        game('g-soon', '2099-03-01T15:00:00Z', 'Soon Home', 'Soon Away'),
        game('g-later', '2099-04-01T15:00:00Z', 'Later Home', 'Later Away'),
      ],
      practice_slots: [],
      audit_log: [],
    };
    mocks.reads = [];
    render(
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>
    );
    const kpi = (await screen.findByText('Games scheduled')).closest('.kpi');
    await waitFor(() => expect(kpi.querySelector('.kpi-val')).toHaveTextContent(/^3$/));
    // Upcoming: the two that have not started, soonest first; the played one is not listed.
    const soon = screen.getByText(/Soon Home/);
    const later = screen.getByText(/Later Home/);
    expect(soon.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByText(/Past Home/)).toBeNull();
    // What was read: the season's current run, then its games; never the legacy table.
    expect(mocks.reads.map((read) => read.table)).not.toContain('games');
    expect(mocks.reads.find((read) => read.table === 'current_game_runs').eqs).toEqual([
      ['organization_id', 'org-1'],
      ['season_settings_id', FALL],
    ]);
    expect(mocks.reads.some((read) => read.table === 'game_assignments')).toBe(true);
  });

  it('reads the season’s game count as a count and its upcoming games as five, from the server (review R9)', async () => {
    mocks.tables = {
      players: [],
      divisions: [],
      teams: [],
      current_game_runs: [
        { organization_id: 'org-1', season_settings_id: FALL, run_id: 'run-fall' },
      ],
      game_assignments: [],
      practice_slots: [],
      audit_log: [],
    };
    mocks.reads = [];
    mocks.chains = [];
    render(
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>
    );
    await screen.findByText('Games scheduled');
    await waitFor(() =>
      expect(mocks.chains.filter((c) => c.table === 'game_assignments').length).toBe(2)
    );
    const [count, upcoming] = mocks.chains
      .filter((c) => c.table === 'game_assignments')
      .sort((a) => (a.calls.some(([m, , o]) => m === 'select' && o?.head) ? -1 : 1));
    expect(count.calls.find(([m]) => m === 'select')[2]).toEqual({ count: 'exact', head: true });
    expect(upcoming.calls.find(([m]) => m === 'gte')?.[1]).toBe('start');
    expect(upcoming.calls.find(([m]) => m === 'order')).toEqual([
      'order',
      'start',
      { ascending: true },
    ]);
    expect(upcoming.calls.find(([m]) => m === 'limit')).toEqual(['limit', 5]);
  });
});
