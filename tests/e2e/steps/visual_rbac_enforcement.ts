import { createBdd } from 'playwright-bdd';
import { expect } from '@playwright/test';

const { Given: _Given, When, Then } = createBdd();

// --- Sidebar RBAC ---
When('I view the main navigation Sidebar', async ({ page }) => {
  await page.evaluate(() => {
    console.log('[DEBUG] Auth State:', window.localStorage.getItem('supabase.auth.token'));
    console.log('[DEBUG] Mock Session:', sessionStorage.getItem('__MOCK_SESSION__'));
  });
  await expect(page.locator('aside')).toBeVisible();
});

Then(
  'I should see links for {string}, {string}, and {string}',
  async ({ page }, l1: string, l2: string, l3: string) => {
    // Highly resilient filtering for Sidebar links
    await expect(page.locator('aside').getByRole('link').filter({ hasText: l1 })).toBeVisible({
      timeout: 15000,
    });
    await expect(page.locator('aside').getByRole('link').filter({ hasText: l2 })).toBeVisible({
      timeout: 15000,
    });
    await expect(page.locator('aside').getByRole('link').filter({ hasText: l3 })).toBeVisible({
      timeout: 15000,
    });
  }
);

Then(
  'I should NOT see links for {string}, {string}, or {string}',
  async ({ page }, l1: string, l2: string, l3: string) => {
    await expect(page.locator('aside').getByRole('link').filter({ hasText: l1 })).toBeHidden();
    await expect(page.locator('aside').getByRole('link').filter({ hasText: l2 })).toBeHidden();
    await expect(page.locator('aside').getByRole('link').filter({ hasText: l3 })).toBeHidden();
  }
);

// --- Coach Admin Actions (Lightning-class grid) ---
When('I promote {string} from the Coaches page', async ({ page }, coachName: string) => {
  const row = page.locator('tbody tr').filter({ hasText: coachName }).first();
  await expect(row).toBeVisible({ timeout: 15000 });

  // Promote through the mass-select bulk bar, the grid's status path.
  await row.getByRole('checkbox', { name: 'Select row' }).click();
  await page.getByRole('button', { name: 'Set Registered' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'set to Registered' })).toBeVisible({
    timeout: 15000,
  });
});

When(
  'I assign {string} to {string} from the Coaches page',
  async ({ page }, coachName: string, teamName: string) => {
    const row = page.locator('tbody tr').filter({ hasText: coachName }).first();
    await expect(row).toBeVisible({ timeout: 15000 });

    // Team assignment lives in the per-row "Manage teams" modal.
    await row.getByRole('button', { name: 'Row actions' }).click();
    await page.getByRole('menuitem', { name: 'Manage teams' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 15000 });

    const teamSelect = dialog.getByLabel(`Assign team to ${coachName}`);
    const teamValue = await teamSelect
      .locator('option')
      .filter({ hasText: teamName })
      .first()
      .getAttribute('value');
    expect(teamValue).toBeTruthy();

    await teamSelect.selectOption(teamValue || '');
    await dialog.getByRole('button', { name: 'Assign' }).click();
    // 8.8: the change is previewed (sole-coach register before/after) and
    // committed only on confirmation.
    await expect(dialog.getByTestId('coach-change-preview')).toBeVisible({ timeout: 15000 });
    await dialog.getByRole('button', { name: 'Confirm change' }).click();
    await expect(
      page.getByRole('status').filter({ hasText: 'assigned to the selected team' })
    ).toBeVisible({ timeout: 15000 });
    await dialog.getByRole('button', { name: 'Done' }).click();
  }
);

Then(
  'the coach row for {string} should show team {string}',
  async ({ page }, coachName: string, teamName: string) => {
    const row = page.locator('tbody tr').filter({ hasText: coachName }).first();
    await expect(row).toContainText(teamName, { timeout: 15000 });
  }
);

// --- Score Entry RBAC ---
// The coach's per-game score entry checks went with coach score entry (admin
// focus R6, 20261028010000): a coach is sent home from the standings and
// scores pages (visual_rbac_enforcement.feature, common_steps' redirect).
