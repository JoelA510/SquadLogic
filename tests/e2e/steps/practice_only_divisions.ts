import { createBdd } from 'playwright-bdd';
import { expect, type Page } from '@playwright/test';
import { waitForMockClient } from './mockReady.js';
import { MOCK_ORG_ID, MOCK_SEASON_ID } from '../../../frontend/src/lib/mockSeedIds.js';

/**
 * Practice-only divisions and reserved practice slots (plan
 * docs/changes/2026-10-22-demo-mode.md, D2; migration 20261029010000). Every
 * check is a DOM assertion; the mock database is touched only to seed, through
 * `window.__saveMockDB__`.
 *
 * The mock seed's team run holds two teams in "U8 Boys" (by name only), and
 * its one practice slot is Field 1's Tuesday 18:00.
 */

const { Given, When, Then } = createBdd();

type MockRow = Record<string, unknown>;

async function openMock(page: Page) {
  if (page.url() === 'about:blank') await page.goto('/');
  await waitForMockClient(page);
}

Given("the team run's division {string} plays no games", async ({ page }, name: string) => {
  await openMock(page);
  await page.evaluate(
    ({ mockOrgId, seasonId, divisionName }) => {
      const db = JSON.parse(
        sessionStorage.getItem('__MOCK_DB__') || JSON.stringify(window.__MOCK_DB__ || {})
      );
      const orgId = localStorage.getItem('squadlogic_active_org') || mockOrgId;
      db.divisions = (db.divisions || []).filter((d: MockRow) => d.id !== 'e2e-practice-only');
      db.divisions.push({
        id: 'e2e-practice-only',
        organization_id: orgId,
        season_settings_id: seasonId,
        name: divisionName,
        plays_games: false,
      });
      window.__saveMockDB__(db);
    },
    { mockOrgId: MOCK_ORG_ID, seasonId: MOCK_SEASON_ID, divisionName: name }
  );
});

When('I open the game scheduling page', async ({ page }) => {
  await page.goto('/schedule/game');
  await expect(page.getByRole('heading', { name: 'Game Scheduling' })).toBeVisible();
});

Then(
  'the game page lists {string} as practice only with {int} teams',
  async ({ page }, division: string, teams: number) => {
    const panel = page.getByRole('region', { name: 'Practice only' });
    await expect(panel).toBeVisible();
    await expect(panel.getByRole('listitem')).toHaveText([
      `${division} · ${teams} teams, no games`,
    ]);
  }
);

Then('the game page says every generated team is practice only', async ({ page }) => {
  await expect(
    page.getByText(
      'Every generated team is in a practice-only division, so there are no games to schedule.'
    )
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Auto-Generate: run auto-scheduler optimization' })
  ).toBeDisabled();
});

function slotSelect(page: Page, slot: string, field: string) {
  return page.getByRole('combobox', { name: `Division for the ${slot} practice slot on ${field}` });
}

async function openReservations(page: Page, field: string) {
  // A closed <details> hides its selects from the accessibility tree, so the
  // field's list is found by its select's label attribute, then opened.
  const card = page.locator('[data-testid^="slot-reservations-"]').filter({
    has: page.locator(`select[aria-label$="practice slot on ${field}"]`),
  });
  await expect(card).toHaveCount(1);
  const summary = card.locator('summary');
  if (!(await card.evaluate((el) => (el as HTMLDetailsElement).open))) await summary.click();
}

When(
  'I reserve the {string} practice slot on {string} to {string}',
  async ({ page }, slot: string, field: string, division: string) => {
    await openReservations(page, field);
    const select = slotSelect(page, slot, field);
    await expect(select).toBeEnabled();
    await select.selectOption({ label: division });
    await expect(select.locator('option:checked')).toHaveText(division);
    await expect(select).toBeEnabled();
  }
);

When('I reload the page', async ({ page }) => {
  await page.reload();
  await page.waitForLoadState('networkidle');
});

Then(
  'the {string} practice slot on {string} is reserved to {string}',
  async ({ page }, slot: string, field: string, division: string) => {
    await openReservations(page, field);
    await expect(slotSelect(page, slot, field).locator('option:checked')).toHaveText(division);
  }
);

When('I open the practice slot divisions on {string}', async ({ page }, field: string) => {
  await openReservations(page, field);
});
