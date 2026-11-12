/**
 * F11-2 task B4 (docs/changes/2026-11-06-games-table-source-of-truth.md, "Standings"): an own team's result against an
 * outside club is not counted in the standings unless the organization turns `standings_count_outside_results` on, and
 * the Standings page says how many results its numbers leave out (lesson 92: say what a number is a count of).
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
  home_team_id: home,
  away_team_id: away,
  week_index: 1,
});

/** The league, with the organization's setting as given; the scores are entered through the mock's RPC. */
async function seedLeague(flags) {
  sessionStorage.clear();
  delete window.__MOCK_DB__;
  seedMockDb({
    organizations: [
      { id: ORG, name: 'Synthetic FC', feature_flags: { score_entry: true, ...flags } },
    ],
    organization_members: [{ organization_id: ORG, profile_id: ADMIN, role: 'admin' }],
    season_settings: [{ id: SEASON, organization_id: ORG, status: 'active' }],
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
    expect(screen.queryByText('Outside Club (placeholder)')).not.toBeInTheDocument();
  });

  it('with the organization setting on counts it, says nothing was left out, and still ranks no outside club', async () => {
    await seedLeague({ standings_count_outside_results: true });
    await renderPage();
    expect((await rowOf('Synthetic Rovers')).split(' ').slice(0, 6).join(' ')).toBe('2 2 0 0 5 1');
    expect((await rowOf('Synthetic Rovers')).split(' ').at(-1)).toBe('6');
    expect(screen.queryByTestId('standings-outside-not-counted')).not.toBeInTheDocument();
    expect(screen.queryByText('Outside Club (placeholder)')).not.toBeInTheDocument();
  });

  it('control: a result between two own teams is the same either way', async () => {
    await seedLeague({});
    await renderPage();
    const off = (await rowOf('Synthetic Wanderers')).split(' ').slice(0, 6).join(' ');
    cleanup();
    vi.resetModules();
    await seedLeague({ standings_count_outside_results: true });
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

describe('the organization toggle :: standings_count_outside_results', () => {
  const MIGRATION = readFileSync(
    path.join(process.cwd(), 'supabase/migrations/20261122010000_game_scores.sql'),
    'utf8'
  );

  it('is in the registry, off unless turned on, and the key is the one the database reads', () => {
    expect(FEATURE_FLAGS.STANDINGS_COUNT_OUTSIDE_RESULTS).toBe('standings_count_outside_results');
    expect(Object.hasOwn(FEATURE_DEFAULTS, FEATURE_FLAGS.STANDINGS_COUNT_OUTSIDE_RESULTS)).toBe(
      false
    );
    expect(MIGRATION).toContain(
      `public.org_flag(d.organization_id, '${FEATURE_FLAGS.STANDINGS_COUNT_OUTSIDE_RESULTS}', false)`
    );
  });

  it('the schema keeps it only as a boolean (the database reads nothing else as on)', () => {
    expect(
      FeatureFlagSchema.parse({ standings_count_outside_results: true })
        .standings_count_outside_results
    ).toBe(true);
    expect(
      FeatureFlagSchema.parse({ standings_count_outside_results: false })
        .standings_count_outside_results
    ).toBe(false);
    expect(
      FeatureFlagSchema.safeParse({ standings_count_outside_results: 'true' }).data
        ?.standings_count_outside_results
    ).not.toBe('true');
  });

  it('the settings page offers it, tied to Standings', () => {
    const entry = FEATURE_CATALOG.find(
      (item) => item.key === FEATURE_FLAGS.STANDINGS_COUNT_OUTSIDE_RESULTS
    );
    expect(entry).toBeTruthy();
    expect(entry.requires).toBe(FEATURE_FLAGS.STANDINGS);
    expect(entry.description).toMatch(/outside clubs/);
  });
});
