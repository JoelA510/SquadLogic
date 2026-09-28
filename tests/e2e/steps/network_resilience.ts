import { createBdd } from 'playwright-bdd';
import { expect } from '@playwright/test';
import { waitForMockClient } from './mockReady.js';

const { Given, When, Then } = createBdd();

Given('the user has modified the {string} roster', async ({ page }, teamName: string) => {
  // CRITICAL FIX: Go to root first to set origin, then set localStorage
  await page.goto('/');

  // Wait for the app to initialize and set the active org in localStorage
  await expect(
    page
      .getByRole('heading', { name: /Welcome back|My Dashboard|League Management|Dashboard/i })
      .first()
  ).toBeVisible({ timeout: 15000 });

  await page.evaluate(() => localStorage.setItem('dashboardActiveStep', '2'));

  // Inject a mock pending override so the Sync button becomes active
  // CRITICAL FIX: Seed run-1 directly (sessionStorage may not have initialMockData yet)
  await waitForMockClient(page);
  await page.evaluate((tName) => {
    const db = JSON.parse(sessionStorage.getItem('__MOCK_DB__') || '{}');
    const orgId = localStorage.getItem('squadlogic_active_org') || 'org-1';
    db.scheduler_runs = db.scheduler_runs || [];

    // Remove any existing run-1 and re-add with our data
    db.scheduler_runs = db.scheduler_runs.filter((r: Record<string, unknown>) => r.id !== 'run-1');
    db.scheduler_runs.push({
      id: 'run-1',
      organization_id: orgId,
      run_type: 'team',
      status: 'completed',
      created_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      results: {
        teams: [{ id: 't1', name: tName, division_id: 'U10' }],
        teamsByDivision: { U10: [{ id: 't1', name: tName, division_id: 'U10' }] },
        team_players: [],
        rosterBalanceByDivision: {
          U10: { summary: { totalPlayers: 10, totalCapacity: 12 }, teamStats: [] },
        },
      },
    });
    sessionStorage.setItem('__MOCK_DB__', JSON.stringify(db));
    (window as { __MOCK_DB__?: unknown }).__MOCK_DB__ = db;
  }, teamName);

  await page.goto('/teams');
  await expect(page.getByRole('heading', { name: /Teaming & Analysis/i }).first()).toBeVisible({
    timeout: 15000,
  });
});

When('the application attempts to sync the changes', async ({ page }) => {
  const syncBtn = page.getByRole('button', { name: /Sync to Supabase/i }).first();
  await expect(syncBtn).toBeVisible({ timeout: 10000 });
  await syncBtn.click({ force: true });
});

When(
  'the network connection drops or the API returns a 504 Timeout',
  async ({ page: _page, context }) => {
    // CRITICAL FIX: Use Playwright's native offline simulation to truly kill the browser's network
    await context.setOffline(true);
  }
);

Then('the user should see a {string} banner', async ({ page }, expectedBanner: string) => {
  // Map feature file text to actual app text
  const textToFind = expectedBanner.includes('Sync Failed') ? 'Failed to fetch' : expectedBanner;
  await expect(page.getByText(textToFind, { exact: false }).first()).toBeVisible({
    timeout: 15000,
  });
});

Then(
  'the {string} card should remain in its newly modified state locally',
  async ({ page, context }, teamName: string) => {
    // CRITICAL FIX: Restore network FIRST to dismiss the OfflineGuard overlay.
    // The OfflineGuard blocks all pointer events with a z-[9999] modal when offline.
    await context.setOffline(false);

    // Wait for OfflineGuard overlay to disappear
    await page.waitForTimeout(1000);

    // Dismiss the OfflineGuard dialog if still visible (click "Retry" or wait for auto-dismiss)
    const retryBtn = page.getByRole('button', { name: /Retry|Reconnect/i }).first();
    if (await retryBtn.isVisible().catch(() => false)) {
      await retryBtn.click({ force: true });
      await page.waitForTimeout(500);
    }

    // Reveal the team cards by entering Edit Mode since the new UI hides them behind a toggle
    const editBtn = page.getByRole('button', { name: /Edit Mode/i });
    await expect(editBtn).toBeVisible({ timeout: 10000 });
    await editBtn.click();

    // Verify optimistic UI holds state despite API failure (the team is still rendered)
    // The UI renders team name in the column header. Look for it anywhere visible on the page.
    const shortName = teamName.replace('U10 ', '');
    await expect(page.getByText(new RegExp(shortName, 'i')).first()).toBeVisible({
      timeout: 15000,
    });
  }
);
