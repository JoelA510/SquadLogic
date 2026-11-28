import { expect } from '@playwright/test';
import { createBdd } from 'playwright-bdd';
import { SEEDED_ADMIN } from './registrations.js';

const { When, Then } = createBdd();

When('I sign out and sign back in without reloading', async ({ page }) => {
  await page.getByRole('button', { name: /^Account menu/ }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await page.locator('#email').fill(SEEDED_ADMIN.email);
  await page.locator('#password').fill(SEEDED_ADMIN.password);
  await page.locator('button[type="submit"]').click();
});

Then('I am back on my club dashboard', async ({ page }) => {
  await expect(page.getByRole('heading', { name: /welcome back/i })).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
});
