import { createBdd } from 'playwright-bdd';
import { expect } from '@playwright/test';
import { waitForMockClient } from './mockReady.js';

const { Given, When, Then } = createBdd();

Given('I am authenticated with zero organizations', async ({ page }) => {
  await page.goto('/login');
  await waitForMockClient(page);
  await page.evaluate(() => {
    localStorage.removeItem('squadlogic_active_org');
    const session = {
      user: { id: 'onboarding-user', email: 'new-user@squadlogic.app' },
      access_token: 'mock-token',
    };
    sessionStorage.setItem('__MOCK_SESSION__', JSON.stringify(session));
    const db = JSON.parse(sessionStorage.getItem('__MOCK_DB__') || '{}');
    db.organizations = [];
    db.organization_members = [];
    db.season_settings = [];
    db.profiles = [
      { id: 'onboarding-user', full_name: 'Onboarding User', email: 'new-user@squadlogic.app' },
    ];
    sessionStorage.setItem('__MOCK_DB__', JSON.stringify(db));
  });
});

Given('I am logged out', async ({ page }) => {
  await page.goto('/login');
  await page.evaluate(() => {
    sessionStorage.removeItem('__MOCK_SESSION__');
    localStorage.removeItem('squadlogic_active_org');
  });
});

When('I visit the root path', async ({ page }) => page.goto('/'));
When('I visit the reset password route', async ({ page }) => page.goto('/auth/reset-password'));
When('I visit invite code route {string}', async ({ page }, code: string) =>
  page.goto(`/invite/${code}`)
);

When('I complete and submit the onboarding organization form', async ({ page }) => {
  await page.goto('/organizations/new');
  await page.getByLabel(/Organization Name/i).fill('Cold Start Club');
  await page.getByLabel(/URL Identifier/i).fill('cold-start-club');
  await page.getByLabel(/Launch Season Year/i).fill('2026');
  await page.getByRole('button', { name: /Establish Organization/i }).click();
});

When('I submit onboarding with a duplicate organization slug', async ({ page }) => {
  await page.goto('/organizations/new');
  await waitForMockClient(page);
  await page.evaluate(() => {
    const db = JSON.parse(sessionStorage.getItem('__MOCK_DB__') || '{}');
    db.organizations = db.organizations || [];
    db.organizations.push({ id: 'existing-org', name: 'Existing', slug: 'duplicate-slug' });
    sessionStorage.setItem('__MOCK_DB__', JSON.stringify(db));
  });
  await page.getByLabel(/Organization Name/i).fill('Another Club');
  await page.getByLabel(/URL Identifier/i).fill('duplicate-slug');
  await page.getByLabel(/Launch Season Year/i).fill('2026');
  await page.getByRole('button', { name: /Establish Organization/i }).click();
});

Then('I should be on the onboarding organization creation route', async ({ page }) => {
  await expect(page).toHaveURL(/\/organizations\/new/);
});
Then('I should remain on the onboarding organization creation route', async ({ page }) => {
  await expect(page).toHaveURL(/\/organizations\/new/);
});
// A first org is not yet onboarded, so its admin creator is taken straight
// to Season Setup (the resumable checklist) instead of an empty dashboard.
Then('I should land on Season Setup', async ({ page }) => {
  await expect(page).toHaveURL(/\/setup(\?.*)?$/);
  await expect(page.getByRole('heading', { name: /Season Setup/i }).first()).toBeVisible();
});
Then('I should see an inline slug error on onboarding', async ({ page }) => {
  await expect(
    page.getByText(/slug is already taken|slug already exists|taken/i).first()
  ).toBeVisible();
});
Then('I should be on the reset password route', async ({ page }) => {
  await expect(page).toHaveURL(/\/auth\/reset-password/);
});
Then('I should be on the invite route {string}', async ({ page }, code: string) => {
  await expect(page).toHaveURL(new RegExp(`/invite/${code}$`));
});
