/**
 * F11-2 task B4 (docs/changes/2026-11-06-games-table-source-of-truth.md, "Standings"): an own team's result against an
 * outside club is not counted in the standings unless the scoped setting `standings_count_outside_results` says so for
 * the team's division (its own value, else its program's, else the organization's: F11-4, migration 20261124010000,
 * docs/changes/2026-11-13-settings-scope.md), and the Standings page says how many results its numbers leave out
 * (lesson 92: say what a number is a count of).
 *
 * Driven through the real page and the real mock client, over scores entered with the mock's `update_game_score` on
 * saved games (the view is computed from `game_scores`, as the database computes it; supabase/tests/game_scores.sql is
 * the database's table). The expected numbers are named from the seed: Rovers beat Wanderers 3-1 and beat an outside
 * club 2-0.
 */
import React from 'react';
import { cleanup, render, screen, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { seedMockDb } from './helpers/seedMockDb.js';
import {
  FEATURE_CATALOG,
  FEATURE_DEFAULTS,
  FEATURE_FLAGS,
  FeatureFlagSchema,
} from '../frontend/src/constants/featureFlags.js';
import { STANDINGS_COUNT_OUTSIDE_KEY } from '../packages/core/src/scopedSettings.js';

const ORG = 'org-outside';
const SEASON = 'season-outside';
const ADMIN = 'mock-admin-id';

vi.mock('../frontend/src/lib/supabaseClient.js', async () => {
  const { mockSupabase } = await import('../frontend/src/lib/mockSupabaseClient.js');
  return { supabase: mockSupabase, supabaseReady: Promise.resolve() };
});
vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: () => ({
    currentOrganization: { id: 'org-outside', name: 'Synthetic FC' },
    currentSeasonSetting: { id: 'season-outside' },
    orgMember: { role: 'viewer' },
  }),
}));
vi.mock('../frontend/src/contexts/AuthContext.jsx', () => ({
  useAuth: () => ({ user: { id: 'viewer-outside' } }),
}));
vi.mock('../frontend/src/hooks/useFeatures.js', () => ({
  useFeatures: () => ({ genderModel: 'split' }),
}));
vi.mock('../frontend/src/lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const team = (id, name, extra = {}) => ({
  id,
  organization_id: ORG,
  division_id: 'div-u10',
  name,
  ...extra,
});
const game = (id, home, away) => ({
  id,
  organization_id: ORG,
  run_id: 'run-outside',
  home_team_id: home,
  away_team_id: away,
  week_index: 1,
});

/**
 * The league, with the scoped setting as given ({ organization, division }: true, false, or absent to inherit), set
 * through the mock's `admin_set_scoped_setting`; the scores are entered through the mock's RPC.
 */
async function seedLeague(setting = {}) {
  sessionStorage.clear();
  delete window.__MOCK_DB__;
  seedMockDb({
    organizations: [{ id: ORG, name: 'Synthetic FC', feature_flags: { score_entry: true } }],
    organization_members: [{ organization_id: ORG, profile_id: ADMIN, role: 'admin' }],
    season_settings: [{ id: SEASON, organization_id: ORG, status: 'active' }],
    // The games are of the season's current run: a score is entered on no other.
    scheduler_runs: [
      {
        id: 'run-outside',
        organization_id: ORG,
        season_settings_id: SEASON,
        run_type: 'game',
        status: 'completed',
        completed_at: '2026-03-01T00:00:00Z',
      },
    ],
    divisions: [{ id: 'div-u10', organization_id: ORG, season_settings_id: SEASON, name: 'U10' }],
    teams: [
      team('t-rovers', 'Synthetic Rovers'),
      team('t-wanderers', 'Synthetic Wanderers'),
      team('t-club', 'Outside Club (placeholder)', { is_external: true }),
    ],
    game_assignments: [
      game('g-own', 't-rovers', 't-wanderers'),
      game('g-outside', 't-rovers', 't-club'),
    ],
    game_scores: [],
    view_league_standings: [],
  });
  sessionStorage.setItem('__MOCK_SESSION__', JSON.stringify({ user: { id: ADMIN } }));
  const { mockSupabase } = await import('../frontend/src/lib/mockSupabaseClient.js');
  for (const [scope, scopeId] of [
    ['organization', ORG],
    ['division', 'div-u10'],
  ]) {
    if (typeof setting[scope] !== 'boolean') continue;
    const { error } = await mockSupabase.rpc('admin_set_scoped_setting', {
      p_key: 'standings_count_outside_results',
      p_scope: scope,
      p_scope_id: scopeId,
      p_value: setting[scope],
    });
    expect(error, `the ${scope} value is set`).toBe(null);
  }
  for (const [id, home, away] of [
    ['g-own', 3, 1],
    ['g-outside', 2, 0],
  ]) {
    const { error } = await mockSupabase.rpc('update_game_score', {
      p_organization_id: ORG,
      p_game_id: id,
      p_score_home: home,
      p_score_away: away,
    });
    expect(error, `the score of ${id} is entered`).toBe(null);
  }
}

async function renderPage() {
  const { default: LeagueStandings } = await import('../frontend/src/pages/LeagueStandings.jsx');
  render(<LeagueStandings />);
}
/** A team's row as the page shows it: GP W L D GF GA GD Pts. */
async function rowOf(name) {
  const cell = await screen.findByText(name);
  const cells = within(cell.closest('tr')).getAllByRole('cell');
  return cells
    .slice(2)
    .map((c) => c.textContent.trim())
    .join(' ');
}

beforeEach(() => {
  vi.resetModules();
});
afterEach(() => {
  cleanup();
});

describe('LeagueStandings :: results against outside clubs', () => {
  it('by default leaves the result out, says that one was not counted, and ranks no outside club', async () => {
    await seedLeague({});
    await renderPage();
    expect((await rowOf('Synthetic Rovers')).split(' ').slice(0, 6).join(' ')).toBe('1 1 0 0 3 1');
    expect((await rowOf('Synthetic Rovers')).split(' ').at(-1)).toBe('3');
    expect(screen.getByTestId('standings-outside-not-counted')).toHaveTextContent(
      '1 result against an outside club is not counted.'
    );
    // It points to the panel that sets it (F11-4b; the Features switch is retired), by the names the screens show.
    expect(screen.getByTestId('standings-outside-not-counted')).toHaveTextContent(
      'Whether they count is a league setting, set for the organization, a program or a division in Settings, General, Season & Calendar, under “Settings by program and division”.'
    );
    expect(screen.getByTestId('standings-outside-not-counted')).not.toHaveTextContent(/coming/);
    expect(screen.getByTestId('standings-outside-not-counted')).not.toHaveTextContent(/Features/);
    expect(screen.queryByText('Outside Club (placeholder)')).not.toBeInTheDocument();
  });

  it('with the organization setting on counts it, says nothing was left out, and still ranks no outside club', async () => {
    await seedLeague({ organization: true });
    await renderPage();
    expect((await rowOf('Synthetic Rovers')).split(' ').slice(0, 6).join(' ')).toBe('2 2 0 0 5 1');
    expect((await rowOf('Synthetic Rovers')).split(' ').at(-1)).toBe('6');
    expect(screen.queryByTestId('standings-outside-not-counted')).not.toBeInTheDocument();
    expect(screen.queryByText('Outside Club (placeholder)')).not.toBeInTheDocument();
  });

  it('a division\'s own "don\'t count" beats the organization\'s "count"', async () => {
    await seedLeague({ organization: true, division: false });
    await renderPage();
    expect((await rowOf('Synthetic Rovers')).split(' ').slice(0, 6).join(' ')).toBe('1 1 0 0 3 1');
    expect(screen.getByTestId('standings-outside-not-counted')).toHaveTextContent(
      '1 result against an outside club is not counted.'
    );
  });

  it('and a division\'s own "count" beats the organization\'s default', async () => {
    await seedLeague({ division: true });
    await renderPage();
    expect((await rowOf('Synthetic Rovers')).split(' ').slice(0, 6).join(' ')).toBe('2 2 0 0 5 1');
    expect(screen.queryByTestId('standings-outside-not-counted')).not.toBeInTheDocument();
  });

  it('control: a result between two own teams is the same either way', async () => {
    await seedLeague({});
    await renderPage();
    const off = (await rowOf('Synthetic Wanderers')).split(' ').slice(0, 6).join(' ');
    cleanup();
    vi.resetModules();
    await seedLeague({ organization: true });
    await renderPage();
    expect((await rowOf('Synthetic Wanderers')).split(' ').slice(0, 6).join(' ')).toBe(off);
    expect(off).toBe('1 0 1 0 1 3');
  });

  it('says the plural for more than one', async () => {
    await seedLeague({});
    // A second team's result against the club: entered on a saved game of its own.
    const db = /** @type {any} */ (window.__MOCK_DB__);
    expect(db, 'the mock database is readable').toBeTruthy();
    db.game_assignments.push(game('g-outside-2', 't-wanderers', 't-club'));
    db.game_scores.push({
      game_id: 'g-outside-2',
      organization_id: ORG,
      home_team_id: 't-wanderers',
      away_team_id: 't-club',
      score_home: 0,
      score_away: 0,
    });
    window.__saveMockDB__(db);
    await renderPage();
    expect(await screen.findByTestId('standings-outside-not-counted')).toHaveTextContent(
      '2 results against outside clubs are not counted.'
    );
  });
});

describe('the retired organization flag :: standings_count_outside_results', () => {
  const MIGRATION = readFileSync(
    path.join(process.cwd(), 'supabase/migrations/20261124010000_settings_scope.sql'),
    'utf8'
  );

  it('the key is the one the scoped registry holds and the seam reads, no longer through org_flag', () => {
    expect(FEATURE_FLAGS.STANDINGS_COUNT_OUTSIDE_RESULTS).toBe(STANDINGS_COUNT_OUTSIDE_KEY);
    expect(Object.hasOwn(FEATURE_DEFAULTS, FEATURE_FLAGS.STANDINGS_COUNT_OUTSIDE_RESULTS)).toBe(
      false
    );
    expect(MIGRATION).toContain(
      `SELECT COALESCE((SELECT public.scoped_setting_value(d.id, '${STANDINGS_COUNT_OUTSIDE_KEY}') = 'true'::jsonb`
    );
    expect(MIGRATION).toContain(`('${STANDINGS_COUNT_OUTSIDE_KEY}', 'boolean', NULL, 'false',`);
  });

  it('a stored value still parses (the key stays in the registry, retired), so no organization loses its flags', () => {
    expect(
      FeatureFlagSchema.parse({ standings_count_outside_results: true, score_entry: true })
    ).toEqual({ standings_count_outside_results: true, score_entry: true });
  });

  it('the Features page no longer offers it: the setting is set by level, not as a flag', () => {
    expect(
      FEATURE_CATALOG.find((item) => item.key === FEATURE_FLAGS.STANDINGS_COUNT_OUTSIDE_RESULTS)
    ).toBeUndefined();
  });
});
