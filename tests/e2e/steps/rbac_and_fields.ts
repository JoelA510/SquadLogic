import { createBdd } from 'playwright-bdd';
import { expect } from '@playwright/test';

const { Given, When, Then } = createBdd();

// ────────────────────────────────────────────────────────────
// Shared state for RBAC multi-tenancy scenarios
// ────────────────────────────────────────────────────────────
const rbacState: {
  orgs: Record<string, string>; // "Org A" → orgId
  users: Record<string, { org: string; role: string; orgId: string }>;
} = { orgs: {}, users: {} };

/**
 * Background step: seed two organizations into the mock DB.
 * Each org gets a stable predictable ID so later steps can reference them.
 */
Given(
  'the following organizations exist: {string}, {string}',
  async ({ page }, org1: string, org2: string) => {
    const orgId1 = 'rbac-org-a-' + Date.now();
    const orgId2 = 'rbac-org-b-' + Date.now();

    rbacState.orgs[org1] = orgId1;
    rbacState.orgs[org2] = orgId2;

    await page.goto('/');
    await page.evaluate(
      ({ o1, id1, o2, id2 }) => {
        const db = JSON.parse(sessionStorage.getItem('__MOCK_DB__') || '{}');

        db.organizations = db.organizations || [];
        db.organizations.push({ id: id1, name: o1, status: 'active', is_onboarded: true });
        db.organizations.push({ id: id2, name: o2, status: 'active', is_onboarded: true });

        // Seed teams scoped to each org so the Teams page has data to filter
        db.teams = db.teams || [];
        db.teams.push({
          id: 'team-orgA-1',
          name: 'Org A Thunder',
          division: 'U10',
          organization_id: id1,
        });
        db.teams.push({
          id: 'team-orgA-2',
          name: 'Org A Lightning',
          division: 'U10',
          organization_id: id1,
        });
        db.teams.push({
          id: 'team-orgB-1',
          name: 'Org B Sharks',
          division: 'U10',
          organization_id: id2,
        });
        db.teams.push({
          id: 'team-orgB-2',
          name: 'Org B Dolphins',
          division: 'U10',
          organization_id: id2,
        });

        // Seed season_settings for each org
        db.season_settings = db.season_settings || [];
        db.season_settings.push({
          id: 'season-a',
          organization_id: id1,
          name: 'Fall 2026',
          status: 'active',
          timezone: 'America/Los_Angeles',
        });
        db.season_settings.push({
          id: 'season-b',
          organization_id: id2,
          name: 'Fall 2026',
          status: 'active',
          timezone: 'America/Los_Angeles',
        });

        // Seed scheduler runs correctly formatted for the frontend data mapper
        const now = new Date().toISOString();
        db.scheduler_runs = db.scheduler_runs || [];
        db.scheduler_runs.push(
          {
            id: 'run-orgA',
            organization_id: id1,
            season_id: 'season-a',
            season_settings_id: 'season-a',
            run_type: 'team',
            status: 'completed',
            completed_at: now,
            results: {
              teams: [
                { id: 'team-orgA-1', name: 'Org A Thunder', division_id: 'U10' },
                { id: 'team-orgA-2', name: 'Org A Lightning', division_id: 'U10' },
              ],
              teamsByDivision: {
                U10: [
                  { id: 'team-orgA-1', name: 'Org A Thunder', division_id: 'U10' },
                  { id: 'team-orgA-2', name: 'Org A Lightning', division_id: 'U10' },
                ],
              },
              rosterBalanceByDivision: {
                U10: {
                  summary: { totalPlayers: 24, totalCapacity: 30, averageFillRate: 0.8 },
                  teamStats: [
                    { teamId: 'team-orgA-1', slotsRemaining: 3 },
                    { teamId: 'team-orgA-2', slotsRemaining: 3 },
                  ],
                },
              },
              coachCoverageByDivision: {
                U10: { totalTeams: 2, teamsWithCoach: 2, coverageRate: 1.0 },
              },
            },
            created_at: now,
          },
          {
            id: 'run-orgB',
            organization_id: id2,
            season_id: 'season-b',
            season_settings_id: 'season-b',
            run_type: 'team',
            status: 'completed',
            completed_at: now,
            results: {
              teams: [
                { id: 'team-orgB-1', name: 'Org B Sharks', division_id: 'U10' },
                { id: 'team-orgB-2', name: 'Org B Dolphins', division_id: 'U10' },
              ],
              teamsByDivision: {
                U10: [
                  { id: 'team-orgB-1', name: 'Org B Sharks', division_id: 'U10' },
                  { id: 'team-orgB-2', name: 'Org B Dolphins', division_id: 'U10' },
                ],
              },
              rosterBalanceByDivision: {
                U10: {
                  summary: { totalPlayers: 24, totalCapacity: 30, averageFillRate: 0.8 },
                  teamStats: [
                    { teamId: 'team-orgB-1', slotsRemaining: 3 },
                    { teamId: 'team-orgB-2', slotsRemaining: 3 },
                  ],
                },
              },
              coachCoverageByDivision: {
                U10: { totalTeams: 2, teamsWithCoach: 2, coverageRate: 1.0 },
              },
            },
            created_at: now,
          }
        );

        sessionStorage.setItem('__MOCK_DB__', JSON.stringify(db));
      },
      { o1: org1, id1: orgId1, o2: org2, id2: orgId2 }
    );
  }
);

/**
 * Background step: assign a named user to an organization with a specific role.
 * Seeds the organization_members entry in the mock DB.
 */
Given(
  '{string} belongs to {string} with role {string}',
  async ({ page }, user: string, org: string, role: string) => {
    const orgId = rbacState.orgs[org];
    if (!orgId) throw new Error(`Organization "${org}" was not seeded in Background step`);

    const cleanRole = role.toLowerCase();
    const userId = `mock-${cleanRole}-${user.replace(/\s+/g, '-').toLowerCase()}`;

    rbacState.users[user] = { org, role: cleanRole, orgId };

    await page.evaluate(
      ({ uId, oId, roleName, orgName, userName }) => {
        const db = JSON.parse(sessionStorage.getItem('__MOCK_DB__') || '{}');

        db.organization_members = db.organization_members || [];
        db.organization_members.push({
          organization_id: oId,
          profile_id: uId,
          role: roleName,
          organizations: { id: oId, name: orgName, is_onboarded: true },
        });

        db.profiles = db.profiles || [];
        db.profiles.push({ id: uId, full_name: userName, email: `${uId}@squadlogic.app` });

        sessionStorage.setItem('__MOCK_DB__', JSON.stringify(db));
      },
      { uId: userId, oId: orgId, roleName: cleanRole, orgName: org, userName: user }
    );
  }
);

// ────────────────────────────────────────────────────────────
// Scenario 1: Multi-Tenancy Data Isolation (RLS)
// ────────────────────────────────────────────────────────────

When('I request the list of teams, players, or schedules', async ({ page }) => {
  await page.goto('/teams');

  // Explicitly click the "Edit" or "Expand" button if one exists to ensure
  // the internal team list is rendered into the DOM.
  // We use a more robust wait than isVisible() to ensure the button is ready.
  const editButton = page.getByRole('button', { name: /Edit/i });
  try {
    await editButton.waitFor({ state: 'visible', timeout: 5000 });
    await editButton.click();
    // Wait for the RosterManager to actually appear
    await page.waitForSelector('h3', { state: 'visible', timeout: 5000 });
  } catch {
    // Fallback: If no edit button or it fails, we continue and hope the data is there
  }
});

Then('I should only receive records associated with {string}', async ({ page }, org: string) => {
  const orgId = rbacState.orgs[org];
  if (!orgId) throw new Error(`Organization "${org}" was not seeded`);

  // Verify localStorage points to the expected org
  const activeOrg = await page.evaluate(() => localStorage.getItem('squadlogic_active_org'));
  expect(activeOrg).toBe(orgId);

  // Use robust Playwright locators to ensure the exact seeded data actually rendered
  if (org === 'Org A') {
    await expect(page.getByText('Org A Thunder')).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('Org A Lightning')).toBeVisible();
  } else if (org === 'Org B') {
    await expect(page.getByText('Org B Sharks')).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('Org B Dolphins')).toBeVisible();
  }
});

Then(
  'any direct query for {string} records should return empty or unauthorized',
  async ({ page }, org: string) => {
    const orgId = rbacState.orgs[org];
    if (!orgId) throw new Error(`Organization "${org}" was not seeded`);

    // Explicitly assert that the OTHER org's teams are completely hidden from the DOM
    if (org === 'Org B') {
      await expect(page.getByText('Org B Sharks')).toBeHidden();
      await expect(page.getByText('Org B Dolphins')).toBeHidden();
    } else if (org === 'Org A') {
      await expect(page.getByText('Org A Thunder')).toBeHidden();
      await expect(page.getByText('Org A Lightning')).toBeHidden();
    }
  }
);

// ────────────────────────────────────────────────────────────
// Scenario 2: Route Protection via usePermission
// ────────────────────────────────────────────────────────────

When(
  'I attempt to navigate to full Admin routes such as Data Import or Settings',
  async ({ page }) => {
    await page.goto('/settings');
    // Allow time for the redirect/warning to appear
    await page.waitForTimeout(1000);
  }
);

// ────────────────────────────────────────────────────────────
// Scenario 3: Admin Access Verification
// ────────────────────────────────────────────────────────────

When('I navigate to the Admin routes', async ({ page }) => {
  await page.goto('/settings');
});

Then('I should successfully load the page', async ({ page }) => {
  await expect(page.getByRole('heading', { name: /Settings/i })).toBeVisible({ timeout: 10000 });
});

Then(
  'I should be able to view and manage data specifically for {string}',
  async ({ page }, org: string) => {
    const orgId = rbacState.orgs[org];

    // Verify localStorage points to the correct org
    const activeOrg = await page.evaluate(() => localStorage.getItem('squadlogic_active_org'));
    expect(activeOrg).toBe(orgId);

    // Verify the page header or sidebar reflects the active org
    const pageContent = await page.textContent('body');
    const containsOrgReference = pageContent?.includes(org) || pageContent?.includes(orgId);
    expect(containsOrgReference, `Expected the page to reference "${org}" data`).toBeTruthy();
  }
);

const readOnlyRouteState: {
  teamRedirected: boolean;
  practiceControlsHidden: boolean;
  gameControlsHidden: boolean;
} = {
  teamRedirected: false,
  practiceControlsHidden: false,
  gameControlsHidden: false,
};

When('I open the guarded team and schedule routes as a read-only user', async ({ page }) => {
  readOnlyRouteState.teamRedirected = false;
  readOnlyRouteState.practiceControlsHidden = false;
  readOnlyRouteState.gameControlsHidden = false;

  await page.goto('/teams');
  await page.waitForURL((url) => url.pathname === '/', { timeout: 15000 });
  readOnlyRouteState.teamRedirected = true;

  await page.goto('/schedule/practice');
  await expect(page.getByRole('heading', { name: /Practice Scheduling/i })).toBeVisible({
    timeout: 15000,
  });
  await expect(
    page.getByRole('button', { name: /Enter Manual Override|Save Assignments/i })
  ).toBeHidden();
  await expect(
    page.getByRole('button', { name: /Run auto-scheduler optimization/i })
  ).toBeDisabled();
  readOnlyRouteState.practiceControlsHidden = true;

  await page.goto('/schedule/game');
  await expect(page.getByRole('heading', { name: /Game Scheduling/i })).toBeVisible({
    timeout: 15000,
  });
  await expect(page.getByRole('button', { name: /Quick Adjust|Commit Changes/i })).toBeHidden();
  await expect(
    page.getByRole('button', { name: /Run auto-scheduler optimization/i })
  ).toBeDisabled();
  readOnlyRouteState.gameControlsHidden = true;
});

Then('Team Management should redirect the read-only user to the Dashboard', async () => {
  expect(readOnlyRouteState.teamRedirected).toBe(true);
});

Then('Practice and Game Scheduling should not expose edit or apply controls', async () => {
  expect(readOnlyRouteState.practiceControlsHidden).toBe(true);
  expect(readOnlyRouteState.gameControlsHidden).toBe(true);
});

// ────────────────────────────────────────────────────────────
// Field Management steps (shared with field_management_efficiency.feature)
// ────────────────────────────────────────────────────────────

Given('I am logged in as an administrator', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    const session = {
      user: {
        id: 'mock-admin-id',
        email: 'admin@squadlogic.app',
        user_metadata: { full_name: 'Mock Admin' },
        app_metadata: { role: 'admin' },
      },
      access_token: 'mock-token',
    };
    sessionStorage.setItem('__MOCK_SESSION__', JSON.stringify(session));
    localStorage.setItem('squadlogic_active_org', 'org-1');
  });
  await page.reload();
  await expect(page.getByRole('button', { name: /Mock Admin|admin@squadlogic\.app/i })).toBeVisible(
    {
      timeout: 15000,
    }
  );
});

Given('an organization has multiple fields configured', async ({ page }) => {
  await page.evaluate(() => {
    const db = JSON.parse(sessionStorage.getItem('__MOCK_DB__') || '{}');
    const orgId = localStorage.getItem('squadlogic_active_org') || 'org-1';

    // **`location_id` is not decoration.** 20260911000000 made the scheduler
    // resolve a pitch's venue before offering it, and a field with no venue
    // is a failed read rather than an unbounded one -- so a row seeded
    // without one silently vanishes from the list with no error. `location`
    // here is free text and is not the foreign key. Caught by /code-review.
    db.fields = db.fields || [];
    db.fields.push(
      {
        id: 'field-1',
        name: 'Main Field',
        location: 'Central Park',
        location_id: 'loc-1',
        organization_id: orgId,
        is_active: true,
        surface: 'grass',
        size: 'full',
      },
      {
        id: 'field-2',
        name: 'Practice Field A',
        location: 'Central Park',
        location_id: 'loc-1',
        organization_id: orgId,
        is_active: true,
        surface: 'turf',
        size: 'half',
      }
    );

    sessionStorage.setItem('__MOCK_DB__', JSON.stringify(db));
  });
});

When('I view the {string} page', async ({ page }, _pageName: string) => {
  await page.goto('/fields');
});

Then('each field card should display a visual 7-day grid', async ({ page }) => {
  await expect(page.locator('.grid.grid-cols-7').first()).toBeVisible();
});

Then(
  "days with allocated time slots should be highlighted with the club's theme color",
  async ({ page }) => {
    const activeDay = page.locator('.bg-blue-500\\/10').first();
    await expect(activeDay).toBeVisible();
  }
);
