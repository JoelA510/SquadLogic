import { createBdd } from 'playwright-bdd';
import { expect } from '@playwright/test';

/**
 * No contact surfaces (R4, 20261025010000): the player record offers no guardians, the account page
 * no contact card, and the admin home no coach directory or mail or phone link. DOM assertions only.
 */
const { When, Then } = createBdd();

When('I open the player record {string}', async ({ page }, playerId: string) => {
  await page.goto(`/players/${playerId}`);
  await expect(page.getByRole('tab', { name: 'Overview' })).toBeVisible({ timeout: 15000 });
});

Then('the player record offers no guardians', async ({ page }) => {
  const tabs = page.getByRole('tab');
  await expect(tabs.first()).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Guardians' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add guardian' })).toHaveCount(0);
});

When('I open my account settings', async ({ page }) => {
  await page.goto('/account');
  await expect(page.getByRole('heading', { name: 'Account Settings' })).toBeVisible({
    timeout: 15000,
  });
});

Then('I should be offered no contact card', async ({ page }) => {
  await expect(page.getByRole('heading', { name: 'Account Settings' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Contact card' })).toHaveCount(0);
  await expect(page.getByLabel('Share this phone and email')).toHaveCount(0);
});

When('I open my home page', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /^Welcome back/ })).toBeVisible({
    timeout: 15000,
  });
});

Then('I should see no coach directory', async ({ page }) => {
  await expect(page.getByRole('heading', { name: 'Coach directory' })).toHaveCount(0);
  await expect(page.locator('a[href^="tel:"], a[href^="mailto:"]')).toHaveCount(0);
});
