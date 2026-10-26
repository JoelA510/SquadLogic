import { createBdd } from 'playwright-bdd';
import { expect, type Page } from '@playwright/test';
import { waitForMockClient } from './mockReady.js';

/**
 * Programs (plan docs/changes/2026-10-22-phase-e-seasons.md, E2; migration 20261101020000).
 * Every check is a DOM assertion; the mock database is touched only to seed, through
 * `window.__saveMockDB__`. The mock seed has one division, "U8 Coed", in its one active season.
 */

const { Given, When, Then } = createBdd();

async function openSeasonSettings(page: Page) {
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await page.getByRole('tab', { name: 'Season & Calendar' }).click();
  await expect(page.getByRole('heading', { name: 'Programs' })).toBeVisible({ timeout: 20_000 });
}

When('I open the Season and Calendar settings', async ({ page }) => {
  await openSeasonSettings(page);
});

Given(
  'the season has a program {string} holding the division {string}',
  async ({ page }, program: string, division: string) => {
    if (page.url() === 'about:blank') await page.goto('/');
    await waitForMockClient(page);
    await openSeasonSettings(page);
    await page.getByLabel('New program name').fill(program);
    await page.getByRole('button', { name: 'Add program' }).click();
    await expect(page.getByRole('heading', { name: program })).toBeVisible();
    await page.getByLabel(`Program for ${division}`).selectOption({ label: program });
    await expect(page.getByLabel(`Program for ${division}`).locator('option:checked')).toHaveText(
      program
    );
  }
);

Then('the Programs section says programs are optional', async ({ page }) => {
  await expect(page.getByText('Programs are optional.', { exact: false })).toBeVisible();
});

Then("no program of the league's own is listed", async ({ page }) => {
  await expect(page.getByRole('list', { name: 'Programs of this season' })).toHaveCount(0);
});

When('I add the program {string}', async ({ page }, name: string) => {
  await page.getByLabel('New program name').fill(name);
  await page.getByRole('button', { name: 'Add program' }).click();
  await expect(page.getByRole('heading', { name })).toBeVisible();
});

When(
  'I put the division {string} in the program {string}',
  async ({ page }, division: string, program: string) => {
    const select = page.getByLabel(`Program for ${division}`);
    await select.selectOption({ label: program });
    await expect(select.locator('option:checked')).toHaveText(program);
    await expect(select).toBeEnabled();
  }
);

Then(
  'the division {string} is in the program {string}',
  async ({ page }, division: string, program: string) => {
    await expect(page.getByLabel(`Program for ${division}`).locator('option:checked')).toHaveText(
      program
    );
  }
);

When(
  'I delete the program {string} after reading that {string} moves',
  async ({ page }, program: string, division: string) => {
    await page.getByRole('button', { name: `Delete the program ${program}` }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText(division);
    await expect(dialog).toContainText('No program');
    await dialog.getByRole('button', { name: 'Delete' }).click();
    await expect(page.getByText(`Program "${program}" deleted.`)).toBeVisible();
  }
);
