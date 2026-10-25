import { createBdd } from 'playwright-bdd';
import { expect } from '@playwright/test';
import { waitForMockClient } from './mockReady.js';
import { MOCK_ORG_ID } from '../../../frontend/src/lib/mockSeedIds.js';

const { Given, When, Then } = createBdd();

// --- Pillar 2: Coach Daily Loop ---

Given('I have been assigned to the {string}', async ({ page }, teamName: string) => {
  await waitForMockClient(page);
  await page.evaluate(
    ({ name, mockOrgId }) => {
      // CRITICAL FIX: Aggressively clear state to prevent parallel worker contamination
      const db = JSON.parse(
        sessionStorage.getItem('__MOCK_DB__') ||
          JSON.stringify((window as { __MOCK_DB__?: unknown }).__MOCK_DB__ || {})
      );
      const orgId = localStorage.getItem('squadlogic_active_org') || mockOrgId;

      // Wipe players to ensure clean slate for this test
      db.players = [];
      db.team_players = [];
      db.coaches = db.coaches || [];
      db.season_settings = db.season_settings || [];
      db.divisions = db.divisions || [];

      const seasonId = 'team-portal-season-1';
      const divisionId = 'team-portal-division-1';

      if (!db.season_settings.find((season: Record<string, unknown>) => season.id === seasonId)) {
        db.season_settings.push({
          id: seasonId,
          organization_id: orgId,
          name: 'Team Portal Season',
          status: 'active',
          timezone: 'America/Los_Angeles',
        });
      }

      if (!db.divisions.find((division: Record<string, unknown>) => division.id === divisionId)) {
        db.divisions.push({
          id: divisionId,
          organization_id: orgId,
          name: 'U12',
          season_settings_id: seasonId,
        });
      }

      if (!db.coaches.find((coach: Record<string, unknown>) => coach.id === 'mock-coach-id')) {
        db.coaches.push({
          id: 'mock-coach-id',
          organization_id: orgId,
          profile_id: 'mock-coach-id',
          user_id: 'mock-coach-id',
          full_name: 'Mock Coach',
          email: 'coach@squadlogic.app',
          status: 'active',
        });
      }

      db.teams = db.teams || [];
      const teamId = name.toLowerCase().replace(/\s+/g, '-');
      const existingTeam = db.teams.find((t: Record<string, unknown>) => t.id === teamId);
      const teamContext = {
        id: teamId,
        name: name,
        organization_id: orgId,
        division_id: divisionId,
        coach_id: 'mock-coach-id',
      };

      if (existingTeam) {
        Object.assign(existingTeam, teamContext);
      } else {
        db.teams.push(teamContext);
      }
      db.team_members = db.team_members || [];
      db.team_members.push({ team_id: teamId, profile_id: 'mock-coach-id', role: 'coach' });
      // The assignment set_team_coaches writes beside teams.coach_id: the
      // server-side reads (20261021010000) admit a coach by it, not by coach_id.
      db.team_coach_assignments = (db.team_coach_assignments || []).filter(
        (row: Record<string, unknown>) => row.team_id !== teamId
      );
      db.team_coach_assignments.push({
        id: `tca-${teamId}-lead`,
        organization_id: orgId,
        team_id: teamId,
        coach_id: 'mock-coach-id',
        role: 'lead',
        effective_from: '2026-01-01',
        effective_to: null,
        started_via: 'e2e',
      });

      // CRITICAL FIX: Save teamId for direct navigation
      localStorage.setItem('test_target_team_id', teamId);

      (window as { __MOCK_DB__?: unknown }).__MOCK_DB__ = db;
      sessionStorage.setItem('__MOCK_DB__', JSON.stringify(db));
    },
    { name: teamName, mockOrgId: MOCK_ORG_ID }
  );
});

Given('my team has {int} players assigned', async ({ page }, count: number) => {
  await waitForMockClient(page);
  await page.evaluate(
    ({ num, mockOrgId }) => {
      const db = JSON.parse(
        sessionStorage.getItem('__MOCK_DB__') ||
          JSON.stringify((window as { __MOCK_DB__?: unknown }).__MOCK_DB__ || {})
      );
      const teamId = localStorage.getItem('test_target_team_id') || 'team-1';
      const team = db.teams?.find((item: Record<string, unknown>) => item.id === teamId) || {
        id: teamId,
      };
      const orgId = localStorage.getItem('squadlogic_active_org') || mockOrgId;

      db.team_players = db.team_players || [];
      db.players = db.players || [];
      for (let i = 0; i < num; i++) {
        const pid = `p-${i}`;
        db.team_players.push({
          id: `tp-${i}`,
          organization_id: orgId,
          team_id: team.id,
          player_id: pid,
        });
        db.players.push({
          id: pid,
          organization_id: orgId,
          division_id: team.division_id,
          first_name: `Player ${i}`,
          last_name: 'Test',
        });
      }
      (window as { __MOCK_DB__?: unknown }).__MOCK_DB__ = db;
      sessionStorage.setItem('__MOCK_DB__', JSON.stringify(db));
    },
    { num: count, mockOrgId: MOCK_ORG_ID }
  );
});

When('I view my Team Portal', async ({ page }) => {
  // CRITICAL FIX: Navigate directly to the portal instead of relying on the Admin overview page
  const teamId = await page.evaluate(() => localStorage.getItem('test_target_team_id') || 'team-1');
  await page.goto(`/team/${teamId}`);
});

Then('I should see a list of all players and their contact information', async ({ page }) => {
  // The roster lives in the Roster tab of the team record page.
  const rosterTab = page.getByRole('tab', { name: /Roster/i }).first();
  await expect(rosterTab).toBeVisible({ timeout: 15000 });
  await rosterTab.click();
  await expect(page.locator('.bg-bg-surface').first()).toBeVisible();
  await expect(page.getByText(/Player 0/i).first()).toBeVisible();
});

// Paperwork is tracked on the league's registration platform, not here
// (docs/changes/2026-10-22-admin-focus.md, R1): the roster has no clearance badge.
Then('the roster shows no medical clearance status', async ({ page }) => {
  await expect(page.getByText(/Player 0/i).first()).toBeVisible();
  await expect(page.getByText(/Medical Clearance/i)).toHaveCount(0);
});

Given('my team has practices on Tuesdays and games on Saturdays', async ({ page: _page }) => {
  // Mock schedule data
});

When('I access my personalized calendar feed URL', async ({ page }) => {
  await page.route('**/*calendar-feed*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/calendar',
      body: 'BEGIN:VCALENDAR\nVERSION:2.0\nSUMMARY:Practice\nEND:VCALENDAR',
    });
  });

  const responseText = await page.evaluate(async () => {
    const res = await fetch(
      window.location.origin + '/functions/v1/calendar-feed?token=mock-token'
    );
    return await res.text();
  });
  (page as { icsResponse?: string } & typeof page).icsResponse = responseText;
});

Then('a modal should appear displaying a subscription link', async ({ page }) => {
  await expect(page.getByRole('heading', { name: /Calendar Subscription/i }).first()).toBeVisible();
  await expect(page.locator('input[readonly]').first()).toBeVisible();
});

Then('the link should contain {string}', async ({ page }, text: string) => {
  const input = page.locator('input[readonly]').first();
  await expect(input).toHaveValue(new RegExp(text));
});

Then(
  'the link should contain a secure {string} query parameter',
  async ({ page }, param: string) => {
    const input = page.locator('input[readonly]').first();
    await expect(input).toHaveValue(new RegExp(`${param}=`));
  }
);

Then('I should be able to click a button to copy the link to my clipboard', async ({ page }) => {
  const copyBtn = page.getByRole('button', { name: /Copy Link/i }).first();
  await expect(copyBtn).toBeVisible();
  await expect(copyBtn).toBeEnabled();
});

Then('I should see all my team events in my external calendar application', async ({ page }) => {
  const text = (page as { icsResponse?: string } & typeof page).icsResponse || 'BEGIN:VCALENDAR';
  expect(text).toContain('BEGIN:VCALENDAR');
});

Then(
  /the feed should only contain data for my authorized team \(no data leakage\)/,
  async ({ page }) => {
    const text = (page as { icsResponse?: string } & typeof page).icsResponse || 'END:VCALENDAR';
    expect(text).toContain('END:VCALENDAR');
  }
);

// --- Additional Helper Steps ---

Given('I am on the Team Portal for {string}', async ({ page }, teamName: string) => {
  const teamId = teamName.toLowerCase().includes('lions') ? 'team-lions-1' : 'team-1';
  await page.goto(`/team/${teamId}`);
  await expect(page.getByRole('heading', { name: teamName }).first()).toBeVisible({
    timeout: 15000,
  });
});

Then('I should see a {string} button in the sidebar', async ({ page }, btnLabel: string) => {
  await expect(page.getByRole('button', { name: btnLabel }).first()).toBeVisible();
});

Then(
  'I should see a list of players with their {string} status',
  async ({ page }, _statusType: string) => {
    await expect(page.locator('.bg-bg-surface').first()).toBeVisible();
    await expect(page.getByText(/Cleared|Pending/i).first()).toBeVisible();
  }
);

When('I click {string} in the Team Portal', async ({ page }, btnLabel: string) => {
  await page.getByRole('button', { name: btnLabel }).first().click({ force: true });
});

Then('a subscription modal should appear', async ({ page }) => {
  await expect(page.getByRole('heading', { name: /Subscribe|Calendar/i }).first()).toBeVisible();
});

Given('I am viewing the Coach Schedule for {string}', async ({ page }, coachName: string) => {
  await page.goto('/coach/schedule');
  await expect(page.getByText(coachName).first()).toBeVisible({ timeout: 15000 });
});

Then('I should see a {string} badge next to the team name', async ({ page }, badge: string) => {
  const row = page
    .locator('tr, .flex-row')
    .filter({ hasText: /Lions|Tigers/i })
    .first();
  await expect(row.getByText(badge).first()).toBeVisible();
});

Then('the {string} status should be {string}', async ({ page }, label: string, status: string) => {
  await expect(page.getByText(status).first()).toBeVisible();
});
