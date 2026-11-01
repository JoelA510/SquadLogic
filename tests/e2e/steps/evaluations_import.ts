import { createBdd } from 'playwright-bdd';
import { expect } from '@playwright/test';
import { waitForMockClient } from './mockReady.js';
import { MOCK_ORG_ID } from '../../../frontend/src/lib/mockSeedIds.js';

/**
 * The evaluations import (plan docs/changes/2026-10-27-season-enrollment.md, C2; E3c; migration
 * 20261113010000). Every check is a DOM assertion; the mock database is touched only to seed
 * (the 1-5 rating shown on the Players page).
 */

const { Given, When, Then } = createBdd();

Given('the league tracks the 1 to 5 player rating', async ({ page }) => {
  if (page.url() === 'about:blank') await page.goto('/');
  await waitForMockClient(page);
  await page.evaluate((orgId) => {
    type Row = Record<string, unknown>;
    const db = window.__MOCK_DB__ as Record<string, Row[] | undefined> | undefined;
    if (!db) throw new Error('mock store not initialised');
    const stored = localStorage.getItem('squadlogic_active_org') || orgId;
    db.organizations = (db.organizations ?? []).map((org) =>
      org.id === stored
        ? { ...org, feature_flags: { ...(org.feature_flags as Row), player_rating: true } }
        : org
    );
    window.__saveMockDB__(db);
  }, MOCK_ORG_ID);
  await page.reload();
  await waitForMockClient(page);
});

When(
  'I import a registration file of three players, two of them with years played',
  async ({ page }) => {
    await page.locator('input[type="file"]').setInputFiles({
      name: 'registration.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(
        [
          'First Name,Last Name,Date of Birth,Registration ID,Division,Years Played',
          'Eva,Evalson,2018-04-02,0042,U8 Coed,',
          'Finn,Finlay,2018-05-03,0043,U8 Coed,3',
          'Gus,Gustavo,2018-06-04,0044,U8 Coed,5',
        ].join('\n')
      ),
    });
    await page.getByRole('button', { name: 'Start Import' }).click();
    await expect(page.getByRole('heading', { name: 'Import Applied' })).toBeVisible({
      timeout: 15_000,
    });
    await page.getByRole('button', { name: 'Upload Another File' }).first().click();
  }
);

When(
  'I choose the evaluations import and check a file that rates two players and names a stranger',
  async ({ page }) => {
    await page.getByRole('button', { name: /^evaluations\b/i }).click();
    await expect(page.getByText(/Updates the players already in/)).toBeVisible();
    // Eva: all three values. Finn: a rating only (his 3 years stay). Nobody Nine: no such player.
    // Gus: every cell blank (nothing to set).
    await page.locator('input[type="file"]').setInputFiles({
      name: 'evaluations.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(
        [
          'Registration ID,Years Played,Skill Tier,Rating',
          '0042,7,developing,4',
          '0043,,,2',
          'NOBODY-9,2,,',
          '0044,,,',
        ].join('\n')
      ),
    });
    await expect(page.getByRole('button', { name: 'Preview Changes' })).toBeVisible();
    await page.getByRole('button', { name: 'Preview Changes' }).click();
    await expect(page.getByRole('heading', { name: 'Import Ready to Apply' })).toBeVisible({
      timeout: 15_000,
    });
  }
);

Then(
  'the evaluations preview counts {int} players to update, {int} already up to date and {int} row matching no player',
  async ({ page }, update: number, unchanged: number, unmatched: number) => {
    const summary = page.getByTestId('evaluation-summary');
    await expect(
      summary.getByRole('heading', { name: 'What this import will change' })
    ).toBeVisible();
    await expect(summary.getByTestId('evaluation-updated')).toHaveText(String(update));
    await expect(summary.getByTestId('evaluation-unchanged')).toHaveText(String(unchanged));
    await expect(summary.getByTestId('evaluation-unmatched')).toHaveText(String(unmatched));
    await expect(summary.getByTestId('evaluation-invalid')).toHaveText('0');
  }
);

Then('the preview lists the unmatched registration id {string}', async ({ page }, id: string) => {
  await expect(page.getByTestId('evaluation-unmatched-list')).toContainText(id);
});

When('I apply the evaluations import', async ({ page }) => {
  await page.getByRole('button', { name: 'Apply Evaluations Import' }).click();
});

Then(
  'the import is applied with warnings and the summary says {int} players were updated',
  async ({ page }, updated: number) => {
    await expect(page.getByRole('heading', { name: 'Import Applied with Warnings' })).toBeVisible({
      timeout: 15_000,
    });
    const summary = page.getByTestId('evaluation-summary');
    await expect(summary.getByRole('heading', { name: 'What this import changed' })).toBeVisible();
    await expect(summary.getByTestId('evaluation-updated')).toHaveText(String(updated));
    await expect(page.getByTestId('import-log')).toContainText('no player is created from them');
    // Nothing offers to roll an evaluations import back.
    await expect(page.getByRole('button', { name: /Roll Back/ })).toHaveCount(0);
  }
);

When('I open the evaluations players page', async ({ page }) => {
  await page.goto('/players');
  await expect(page.getByRole('heading', { name: 'Players', exact: true })).toBeVisible();
  await expect(page.getByRole('grid', { name: 'Players grid' })).toBeVisible();
});

const playerRow = (page: import('@playwright/test').Page, name: string) =>
  page.getByRole('grid', { name: 'Players grid' }).getByRole('row').filter({ hasText: name });

Then(
  '{string} shows {int} years played and the rating {int}',
  async ({ page }, name: string, years: number, rating: number) => {
    const row = playerRow(page, name);
    await expect(row).toHaveCount(1, { timeout: 15_000 });
    await expect(row.getByRole('gridcell', { name: String(years), exact: true })).toBeVisible();
    await expect(row.getByRole('gridcell', { name: String(rating), exact: true })).toBeVisible();
  }
);

Then('{string} shows {int} years played', async ({ page }, name: string, years: number) => {
  const row = playerRow(page, name);
  await expect(row).toHaveCount(1, { timeout: 15_000 });
  await expect(row.getByRole('gridcell', { name: String(years), exact: true })).toBeVisible();
});

Then('the players grid does not list {string}', async ({ page }, name: string) => {
  await expect(
    page.getByRole('grid', { name: 'Players grid' }).getByText(name, { exact: false })
  ).toHaveCount(0);
});

When(
  'I choose the evaluations import and check a file whose second row has 31 years played',
  async ({ page }) => {
    await page.getByRole('button', { name: /^evaluations\b/i }).click();
    await page.locator('input[type="file"]').setInputFiles({
      name: 'evaluations-bad.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(['Registration ID,Years Played', 'GS-1,2', 'GS-2,31'].join('\n')),
    });
    await expect(page.getByRole('button', { name: 'Preview Changes' })).toBeVisible();
  }
);

Then(
  'the evaluations preview marks the cell and counts {int} row not valid',
  async ({ page }, count: number) => {
    // The preview table marks the out-of-range cell before anything is sent.
    await expect(page.locator('.cell-error')).toHaveCount(count);
    await expect(page.locator('.cell-error').first()).toHaveText('31');
    await page.getByRole('button', { name: 'Preview Changes' }).click();
    await expect(page.getByRole('heading', { name: 'Import Ready to Apply' })).toBeVisible({
      timeout: 15_000,
    });
    const summary = page.getByTestId('evaluation-summary');
    await expect(summary.getByTestId('evaluation-invalid')).toHaveText(String(count));
    await expect(summary.getByTestId('evaluation-invalid-list')).toContainText(
      'Years played must be a whole number from 0 to 30'
    );
    // Cancelling leaves nothing applied.
    await page.getByRole('button', { name: 'Cancel Deferred Import' }).click();
    await expect(page.getByRole('button', { name: 'Preview Changes' })).toHaveCount(0);
  }
);
