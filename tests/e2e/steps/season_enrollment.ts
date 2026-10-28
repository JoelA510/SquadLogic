import { createBdd } from 'playwright-bdd';
import { expect } from '@playwright/test';
import { waitForMockClient } from './mockReady.js';
import { MOCK_ORG_ID } from '../../../frontend/src/lib/mockSeedIds.js';

/**
 * Per-season enrollment (plan docs/changes/2026-10-27-season-enrollment.md, E3a; migration
 * 20261108010000). Every check is a DOM assertion; the mock database is touched only to seed,
 * through `window.__saveMockDB__`. The mock seed has one active season with two players, "Alex
 * Smith" and "Jamie Jones".
 */

const { Given, When, Then } = createBdd();

Given(
  'the league has a draft season {string} with the player {string}',
  async ({ page }, season: string, fullName: string) => {
    if (page.url() === 'about:blank') await page.goto('/');
    await waitForMockClient(page);
    const [first, ...rest] = fullName.split(' ');
    await page.evaluate(
      ({ season, first, last, orgId }) => {
        type Row = Record<string, unknown>;
        const db = window.__MOCK_DB__ as Record<string, Row[] | undefined> | undefined;
        if (!db) throw new Error('mock store not initialised');
        const stored = localStorage.getItem('squadlogic_active_org') || orgId;
        const seasonId = 'e3a-draft-season';
        const divisionId = 'e3a-draft-division';
        db.season_settings = [
          ...(db.season_settings ?? []).filter((row) => row.id !== seasonId),
          {
            id: seasonId,
            organization_id: stored,
            name: season,
            status: 'draft',
            created_at: new Date().toISOString(),
          },
        ];
        db.divisions = [
          ...(db.divisions ?? []).filter((row) => row.id !== divisionId),
          {
            id: divisionId,
            organization_id: stored,
            season_settings_id: seasonId,
            name: 'U8 Coed',
            practices_per_week: 1,
          },
        ];
        db.players = [
          ...(db.players ?? []).filter((row) => row.id !== 'e3a-draft-player'),
          {
            id: 'e3a-draft-player',
            organization_id: stored,
            season_settings_id: seasonId,
            division_id: divisionId,
            first_name: first,
            last_name: last,
            status: 'active',
          },
        ];
        window.__saveMockDB__(db);
      },
      { season, first, last: rest.join(' '), orgId: MOCK_ORG_ID }
    );
    // The season list is read once, when the page loads.
    await page.reload();
    await waitForMockClient(page);
  }
);

When('I open the players page', async ({ page }) => {
  await page.goto('/players');
  await expect(page.getByRole('heading', { name: 'Players', exact: true })).toBeVisible();
  await expect(page.getByRole('grid', { name: 'Players grid' })).toBeVisible();
});

When('I switch the season to {string}', async ({ page }, name: string) => {
  await page.getByRole('button', { name: 'Active Season' }).first().click({ force: true });
  await page.getByRole('menuitem', { name }).first().click({ force: true });
  await expect(page.getByRole('button', { name: 'Active Season' }).first()).toContainText(
    name.replace(/ \((draft|completed)\)$/, '')
  );
});

Then(
  'the players grid lists {string} and not {string}',
  async ({ page }, listed: string, absent: string) => {
    const grid = page.getByRole('grid', { name: 'Players grid' });
    await expect(grid.getByText(listed, { exact: false }).first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(grid.getByText(absent, { exact: false })).toHaveCount(0);
  }
);

Then('the players page counts {int} registered', async ({ page }, count: number) => {
  await expect(page.getByText(`${count} registered`)).toBeVisible();
});
