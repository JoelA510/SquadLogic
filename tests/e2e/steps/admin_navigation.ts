import { createBdd } from 'playwright-bdd';
import { expect, type Page } from '@playwright/test';
import { waitForMockClient } from './mockReady.js';
import { MOCK_ORG_ID } from '../../../frontend/src/lib/mockSeedIds.js';

/**
 * Steps several admin features share: the settings a league turns on, Team A's
 * seeded game and weekly practice, going to a route, and the admin navigation.
 * (They lived in the coach view's steps until docs/changes/2026-10-27-admin-only.md removed it.)
 * Every check is a DOM assertion; the mock database is touched only to seed,
 * through `window.__saveMockDB__`.
 *
 * The mock seed's Team A and Team B are in U8 Coed; Tigers, also U8 Coed, has no coach.
 */

const { Given, When, Then } = createBdd();

type MockRow = Record<string, unknown>;

/** A wall date `days` from today, as `YYYY-MM-DD` (UTC, as the mock's own today). */
const dayFromToday = (days: number) =>
  new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

async function openMock(page: Page) {
  if (page.url() === 'about:blank') await page.goto('/');
  await waitForMockClient(page);
}

Given('the league has turned on score entry and standings', async ({ page }) => {
  await openMock(page);
  await page.evaluate((mockOrgId) => {
    const db = JSON.parse(
      sessionStorage.getItem('__MOCK_DB__') || JSON.stringify(window.__MOCK_DB__ || {})
    );
    const orgId = localStorage.getItem('squadlogic_active_org') || mockOrgId;
    const org = (db.organizations || []).find((o: MockRow) => o.id === orgId);
    if (!org) throw new Error(`seed: organization ${orgId} is not in the mock db`);
    org.feature_flags = { ...(org.feature_flags || {}), score_entry: true, standings: true };
    window.__saveMockDB__(db);
  }, MOCK_ORG_ID);
});

Given('Team A has an upcoming game and a weekly practice', async ({ page }) => {
  await openMock(page);
  await page.evaluate(
    ({ mockOrgId, gameDate, from, until }) => {
      const db = JSON.parse(
        sessionStorage.getItem('__MOCK_DB__') || JSON.stringify(window.__MOCK_DB__ || {})
      );
      const orgId = localStorage.getItem('squadlogic_active_org') || mockOrgId;
      db.game_slots = (db.game_slots || []).filter((s: MockRow) => s.id !== 'gs-e2e-coach');
      db.game_slots.push({
        id: 'gs-e2e-coach',
        organization_id: orgId,
        field_id: 'v1',
        slot_date: gameDate,
        start_time: '10:00:00',
        end_time: '11:00:00',
      });
      db.games = (db.games || []).filter((g: MockRow) => g.id !== 'game-e2e-coach');
      db.games.push({
        id: 'game-e2e-coach',
        organization_id: orgId,
        home_team_id: 't1',
        away_team_id: 't2',
        game_slot_id: 'gs-e2e-coach',
        start_time: `${gameDate}T17:00:00Z`,
        score_home: null,
        score_away: null,
      });
      db.practice_slots = (db.practice_slots || []).filter((s: MockRow) => s.id !== 'ps-e2e-coach');
      db.practice_slots.push({
        id: 'ps-e2e-coach',
        organization_id: orgId,
        field_id: 'v1',
        day_of_week: 'thu',
        start_time: '17:30',
        end_time: '18:30',
        valid_from: from,
        valid_until: until,
      });
      db.practice_assignments = (db.practice_assignments || []).filter(
        (a: MockRow) => a.id !== 'pa-e2e-coach'
      );
      db.practice_assignments.push({
        id: 'pa-e2e-coach',
        organization_id: orgId,
        team_id: 't1',
        slot_id: 'ps-e2e-coach',
        practice_slot_id: 'ps-e2e-coach',
        source: 'auto',
        effective_date_range: `[${from},${until}]`,
      });
      window.__saveMockDB__(db);
    },
    {
      mockOrgId: MOCK_ORG_ID,
      gameDate: dayFromToday(5),
      from: dayFromToday(0),
      until: dayFromToday(27),
    }
  );
});

When('I go to {string}', async ({ page }, route: string) => {
  await page.goto(route);
});

Then('the admin navigation offers no {string}', async ({ page }, label: string) => {
  await expect(page.locator('aside')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('aside').getByRole('link', { name: label, exact: true })).toHaveCount(
    0
  );
});

Then('the admin navigation offers {string}', async ({ page }, label: string) => {
  await expect(page.locator('aside').getByRole('link', { name: label, exact: true })).toBeVisible({
    timeout: 15_000,
  });
});

// The real path a league turns a setting on by: the Settings page's feature
// toggle, through `update_org_feature_flags`. No reload follows (a
// background's init script may reseed the mock db on a load), so the pages
// after it are opened from the navigation.
When(
  'the admin turns on {string} and {string} in the Settings features',
  async ({ page }, first: string, second: string) => {
    await page.goto('/settings');
    await page.getByRole('tab', { name: 'Features' }).click();
    for (const label of [first, second]) {
      const toggle = page.getByRole('switch', { name: label });
      await expect(toggle).toHaveAttribute('aria-checked', 'false', { timeout: 15_000 });
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-checked', 'true', { timeout: 15_000 });
    }
  }
);

When('I open {string} from the admin navigation', async ({ page }, label: string) => {
  await page.locator('aside').getByRole('link', { name: label, exact: true }).click();
});
