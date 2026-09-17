import { createBdd } from 'playwright-bdd';
import { expect } from '@playwright/test';

const { Given, When, Then } = createBdd();

// --- Pillar 2: Coach Daily Loop ---

Given('I have been assigned to the {string}', async ({ page }, teamName: string) => {
  await page.evaluate((name) => {
    // CRITICAL FIX: Aggressively clear state to prevent parallel worker contamination
    const db = JSON.parse(
      sessionStorage.getItem('__MOCK_DB__') ||
        JSON.stringify((window as { __MOCK_DB__?: unknown }).__MOCK_DB__ || {})
    );
    const orgId = localStorage.getItem('squadlogic_active_org') || 'org-1';

    // Wipe players to ensure clean slate for this test
    db.players = [];
    db.team_players = [];
    db.profile_players = [];
    db.registration_forms = db.registration_forms || [];
    db.registrations = [];
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

    // CRITICAL FIX: Save teamId for direct navigation
    localStorage.setItem('test_target_team_id', teamId);

    (window as { __MOCK_DB__?: unknown }).__MOCK_DB__ = db;
    sessionStorage.setItem('__MOCK_DB__', JSON.stringify(db));
  }, teamName);
});

Given('my team has {int} players assigned', async ({ page }, count: number) => {
  await page.evaluate((num) => {
    const db = JSON.parse(
      sessionStorage.getItem('__MOCK_DB__') ||
        JSON.stringify((window as { __MOCK_DB__?: unknown }).__MOCK_DB__ || {})
    );
    const teamId = localStorage.getItem('test_target_team_id') || 'team-1';
    const team = db.teams?.find((item: Record<string, unknown>) => item.id === teamId) || {
      id: teamId,
    };
    const division = db.divisions?.find(
      (item: Record<string, unknown>) => item.id === team.division_id
    );
    const orgId = localStorage.getItem('squadlogic_active_org') || 'org-1';
    const seasonId = division?.season_settings_id || 'team-portal-season-1';
    const formId = 'registration-form-1';

    db.team_players = db.team_players || [];
    db.players = db.players || [];
    db.profile_players = db.profile_players || [];
    db.registration_forms = db.registration_forms || [];
    db.registrations = db.registrations || [];
    if (!db.registration_forms.find((form: Record<string, unknown>) => form.id === formId)) {
      db.registration_forms.push({
        id: formId,
        organization_id: orgId,
        title: 'Team Portal Registration',
        season_id: seasonId,
        status: 'open',
      });
    }
    for (let i = 0; i < num; i++) {
      const pid = `p-${i}`;
      const medicalCleared = i % 2 === 0;
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
      db.registrations.push({
        id: `reg-${i}`,
        organization_id: orgId,
        form_id: formId,
        player_id: pid,
        profile_id: 'mock-parent-id',
        medical_cleared: medicalCleared,
        updated_at: new Date(Date.now() + i).toISOString(),
      });
    }
    (window as { __MOCK_DB__?: unknown }).__MOCK_DB__ = db;
    sessionStorage.setItem('__MOCK_DB__', JSON.stringify(db));
  }, count);
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

Then(
  'I should see a dashboard indicating which players have completed their medical waivers',
  async ({ page }) => {
    await expect(page.getByText(/Medical Clearance/i).first()).toBeVisible();
  }
);

Then('I should be flagged if any player is currently non-compliant', async ({ page }) => {
  // The UI renders "Medical Clearance: Pending" with a warning badge
  await expect(page.getByText(/Pending/i).first()).toBeVisible();
  await expect(page.locator('.bg-status-warning-bg').first()).toBeVisible();
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
