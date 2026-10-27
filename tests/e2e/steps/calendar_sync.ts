import { createBdd } from 'playwright-bdd';
import { expect } from '@playwright/test';

/**
 * The team calendar subscription modal, as an admin sees it on a team page
 * (docs/changes/2026-10-27-admin-only.md: the link is the admins' to hand out).
 * DOM assertions only.
 */
const { Then } = createBdd();

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
