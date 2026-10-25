import { createBdd } from 'playwright-bdd';
import { expect, type Page } from '@playwright/test';
import { waitForMockClient } from './mockReady.js';
import { MOCK_ORG_ID } from '../../../frontend/src/lib/mockSeedIds.js';

/**
 * The coach view (plan docs/changes/2026-10-22-admin-focus.md, R6; migration
 * 20261028010000). Every check is a DOM assertion; the mock database is
 * touched only to seed, through `window.__saveMockDB__`.
 *
 * The mock seed's coach (`mock-coach-id`, "Mock Coach") leads Team A in U8
 * Coed; Team B, in the same division, is Casey Rivera's; Tigers, also U8
 * Coed, has no coach. U10 Girls holds no team the coach coaches.
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

Then('my dashboard lists my team {string}', async ({ page }, team: string) => {
  await expect(page.getByRole('heading', { name: 'My Dashboard' })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByRole('link', { name: `Open ${team}` })).toBeVisible();
});

Then(
  'my schedule lists the game {string} and the practices of {string}',
  async ({ page }, game: string, team: string) => {
    const schedule = page.getByRole('region', { name: 'Your schedule' });
    await expect(schedule).toBeVisible();
    const events = schedule.getByTestId('coach-schedule-event');
    // The seeded game, on its slot (the base seed's slotless games say "not set yet").
    await expect(
      events
        .filter({ hasText: game })
        .filter({ hasText: 'Game' })
        .filter({ hasText: '10:00 - 11:00' })
    ).toHaveCount(1, {
      timeout: 20_000,
    });
    // Four Thursdays in the seeded four weeks; the home shows the next ten events.
    await expect(
      events.filter({ hasText: `${team}: Practice` }).filter({ hasText: '17:30 - 18:30' })
    ).toHaveCount(4);
  }
);

Then(
  'my division lists {string} coached by {string} and {string} with no coach',
  async ({ page }, team: string, coach: string, uncoached: string) => {
    const division = page.getByRole('region', { name: 'Your division' });
    const table = division.getByTestId('division-teams');
    await expect(table).toHaveCount(1, { timeout: 20_000 });
    await expect(table.getByRole('rowheader', { name: team })).toBeVisible();
    await expect(table.getByRole('row').filter({ hasText: team })).toContainText(coach);
    await expect(table.getByRole('row').filter({ hasText: uncoached })).toContainText(
      'No coach assigned'
    );
    await expect(table.getByRole('row').filter({ hasText: '(your team)' })).toContainText(
      'Mock Coach'
    );
  }
);

Then('my dashboard shows no email address or phone number', async ({ page }) => {
  const main = page.getByRole('main');
  await expect(main).toBeVisible();
  const text = (await main.innerText()) || '';
  // The seed's coach emails and phones (coach@example.com, 555-0101, ...).
  expect(text).not.toMatch(/@/);
  expect(text).not.toMatch(/\b555-\d{4}\b/);
  await expect(main.locator('a[href^="mailto:"], a[href^="tel:"]')).toHaveCount(0);
});

Then('my dashboard offers no schedule editing, score entry or standings', async ({ page }) => {
  const main = page.getByRole('main');
  for (const name of [/apply schedule/i, /generate schedule/i, /save/i, /standings/i, /scores/i]) {
    await expect(main.getByRole('button', { name })).toHaveCount(0);
    await expect(main.getByRole('link', { name })).toHaveCount(0);
  }
});

When('I follow {string} in the coach navigation', async ({ page }, label: string) => {
  await page.locator('aside').getByRole('link', { name: label }).click();
});

When(
  'I follow {string} in the coach navigation to the {string} page',
  async ({ page }, label: string, heading: string) => {
    await page.locator('aside').getByRole('link', { name: label }).click();
    await expect(page.getByRole('heading', { name: heading }).first()).toBeVisible({
      timeout: 20_000,
    });
  }
);

Then('I am on the team page of {string}', async ({ page }, team: string) => {
  await page.waitForURL((url) => url.pathname === '/team/t1', { timeout: 15_000 });
  await expect(page.getByRole('heading', { name: team }).first()).toBeVisible();
});

Then('the coach navigation offers {string}', async ({ page }, label: string) => {
  await expect(page.locator('aside').getByRole('link', { name: label })).toBeVisible({
    timeout: 15_000,
  });
});

Then('the coach navigation offers no {string}', async ({ page }, label: string) => {
  await expect(page.locator('aside').getByRole('link', { name: label, exact: true })).toHaveCount(
    0
  );
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
