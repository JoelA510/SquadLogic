/**
 * Steps for the real-backend project (plan item M4.1): the app's real Supabase
 * client against a local stack (`supabase start`, seeded by
 * tests/e2e/real-backend/seed.sql), with the Edge Functions that stack serves.
 *
 * Every assertion reads the page. Nothing here touches sessionStorage, the
 * mock's `__MOCK_DB__`, or the database directly: what the scenarios prove is
 * that the app, through its own client, RPCs and Edge Functions, does what it
 * shows.
 */
import { createBdd } from 'playwright-bdd';
import { expect, type Page } from '@playwright/test';
import { SEEDED_ADMIN, registrationCsv, registrations } from './registrations.js';

const { Given, When, Then, Before, After } = createBdd();

/** Long enough for the edge runtime's first, cold, request to a function. */
const BACKEND_TIMEOUT = 120_000;

// What the browser saw go wrong, printed when a scenario fails: CI keeps the
// trace as an artifact, but the job log should already say why.
const diagnostics = new WeakMap<Page, string[]>();

Before(async ({ page }) => {
  const lines: string[] = [];
  diagnostics.set(page, lines);
  page.on('console', (message) => {
    if (message.type() === 'error') lines.push(`console.error: ${message.text()}`);
  });
  page.on('pageerror', (error) => lines.push(`pageerror: ${error.message}`));
  page.on('response', (response) => {
    if (response.status() >= 400) {
      lines.push(`HTTP ${response.status()} ${response.request().method()} ${response.url()}`);
    }
  });
});

After(async ({ page, $testInfo }) => {
  if ($testInfo.status === $testInfo.expectedStatus) return;
  const body = await page
    .locator('body')
    .innerText({ timeout: 5_000 })
    .catch((error: Error) => `(could not read the page: ${error.message})`);
  console.log(
    [
      `--- real-backend diagnostics: ${$testInfo.title}`,
      `url: ${page.url()}`,
      ...(diagnostics.get(page) ?? []).slice(-40),
      '--- page text (first 4000 characters)',
      body.slice(0, 4000),
      '---',
    ].join('\n')
  );
});

Given('I am signed in as the seeded administrator', async ({ page }) => {
  await page.goto('/');
  await page.locator('#email').fill(SEEDED_ADMIN.email);
  await page.locator('#password').fill(SEEDED_ADMIN.password);
  await page.locator('button[type="submit"]').click();
  // The login form goes, and the dashboard shell (its navigation) comes.
  await expect(page.locator('#password')).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByRole('navigation').first()).toBeVisible({ timeout: 30_000 });
});

When('I import the {string} registration export', async ({ page }, shape: string) => {
  if (shape !== 'full' && shape !== 'narrow') throw new Error(`unknown export shape: ${shape}`);
  await page.goto('/import');
  await expect(page.getByRole('heading', { name: 'Data Import' })).toBeVisible({ timeout: 30_000 });
  // A completed import is remembered across reloads; start a new one.
  const another = page.getByRole('button', { name: 'Upload Another File' });
  if (await another.isVisible()) await another.click();

  await page.locator('input[type="file"]').setInputFiles({
    name: `registrations-${shape}.csv`,
    mimeType: 'text/csv',
    buffer: Buffer.from(registrationCsv(shape)),
  });
  await page.getByRole('button', { name: 'Start Import' }).click();

  const applied = page.getByRole('heading', { name: /^Import Applied/ });
  const failed = page.getByTestId('import-error-banner');
  await expect(applied.or(failed)).toBeVisible({ timeout: BACKEND_TIMEOUT });
  await expect(failed).toHaveCount(0);
});

Then(
  'the import log reports {int} players inserted and {int} updated',
  async ({ page }, inserted: number, updated: number) => {
    await expect(page.getByTestId('import-log')).toContainText(
      `Roster database updated: ${inserted} inserted, ${updated} updated.`
    );
  }
);

Then(
  'players from across the export still list the guardian the full export gave them',
  async ({ page }) => {
    // Three players, from both ends and the middle of the export, each opened
    // from the Players grid as an administrator would.
    const all = registrations();
    for (const player of [all[0], all[11], all[all.length - 1]]) {
      await page.goto('/players');
      await page.getByRole('textbox', { name: 'Search table' }).fill(player.lastName);
      const row = page.getByRole('row').filter({ hasText: player.lastName });
      await expect(row).toHaveCount(1, { timeout: 30_000 });
      await row.getByRole('button', { name: 'Row actions' }).click();
      await page.getByRole('menuitem', { name: 'Open record' }).click();

      await page.getByRole('tab', { name: 'Guardians' }).click();
      await expect(page.getByText('No guardians on file.')).toHaveCount(0);
      await expect(page.getByText(player.guardianEmail)).toBeVisible();
      await expect(page.getByText(player.guardianName)).toBeVisible();
    }
  }
);
