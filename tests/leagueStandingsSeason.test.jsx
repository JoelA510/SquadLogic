/**
 * The Standings page ranks the selected season's teams only.
 *
 * Divisions belong to a season, so `view_league_standings` holds an
 * organization's teams from every season (20261023010000 exposes the
 * division's `season_settings_id`). The page used to filter by organization
 * alone, so an earlier season's teams were ranked beside this season's and the
 * season selector changed nothing.
 *
 * Driven through the real page and the real mock client; the expected rows are
 * named from the seed, never read back from what the page rendered.
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { seedMockDb } from './helpers/seedMockDb.js';

const ORG = 'org-standings';
const SEASON_NOW = 'season-standings-now';
const SEASON_OLD = 'season-standings-old';

const context = vi.hoisted(() => ({ seasonId: 'season-standings-now' }));

vi.mock('../frontend/src/lib/supabaseClient.js', async () => {
  const { mockSupabase } = await import('../frontend/src/lib/mockSupabaseClient.js');
  return { supabase: mockSupabase, supabaseReady: Promise.resolve() };
});
vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: () => ({
    currentOrganization: { id: 'org-standings', name: 'Synthetic FC' },
    currentSeasonSetting: context.seasonId ? { id: context.seasonId } : null,
    orgMember: { role: 'viewer' },
  }),
}));
vi.mock('../frontend/src/contexts/AuthContext.jsx', () => ({
  useAuth: () => ({ user: { id: 'viewer-standings' } }),
}));
vi.mock('../frontend/src/hooks/useFeatures.js', () => ({
  useFeatures: () => ({ genderModel: 'split' }),
}));
vi.mock('../frontend/src/lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const row = (team_id, team_name, organization_id, season_settings_id) => ({
  organization_id,
  team_id,
  team_name,
  division: 'U10 Boys',
  season_settings_id,
  wins: 0,
  losses: 0,
  draws: 0,
  games_played: 0,
  goals_for: 0,
  goals_against: 0,
  goal_differential: 0,
  points: 0,
});

const THIS_SEASON = row('team-now', 'Now Tigers', ORG, SEASON_NOW);
const EARLIER_SEASON = row('team-old', 'Old Lions', ORG, SEASON_OLD);
const OTHER_ORG = row('team-other', 'Other Bears', 'org-elsewhere', SEASON_NOW);

async function renderPage() {
  const { default: LeagueStandings } = await import('../frontend/src/pages/LeagueStandings.jsx');
  render(<LeagueStandings />);
}

describe('LeagueStandings :: one season at a time', () => {
  beforeEach(() => {
    sessionStorage.clear();
    seedMockDb({ view_league_standings: [THIS_SEASON, EARLIER_SEASON, OTHER_ORG] });
  });

  it("ranks the selected season's teams and leaves an earlier season's out", async () => {
    context.seasonId = SEASON_NOW;
    await renderPage();

    expect(await screen.findByText(THIS_SEASON.team_name)).toBeInTheDocument();
    expect(screen.queryByText(EARLIER_SEASON.team_name)).not.toBeInTheDocument();
    expect(screen.queryByText(OTHER_ORG.team_name)).not.toBeInTheDocument();
  });

  it('follows the selector to the earlier season', async () => {
    context.seasonId = SEASON_OLD;
    await renderPage();

    expect(await screen.findByText(EARLIER_SEASON.team_name)).toBeInTheDocument();
    expect(screen.queryByText(THIS_SEASON.team_name)).not.toBeInTheDocument();
  });

  it('ranks nothing when no season is selected', async () => {
    context.seasonId = null;
    await renderPage();

    await waitFor(() => expect(screen.queryByText(/loading/i)).not.toBeInTheDocument());
    for (const seeded of [THIS_SEASON, EARLIER_SEASON, OTHER_ORG]) {
      expect(screen.queryByText(seeded.team_name)).not.toBeInTheDocument();
    }
  });
});
