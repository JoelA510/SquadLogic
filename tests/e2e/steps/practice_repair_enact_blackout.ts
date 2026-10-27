import { createBdd } from 'playwright-bdd';
import { expect, type Page } from '@playwright/test';
import { waitForMockClient } from './mockReady.js';

const { When, Then } = createBdd();

/**
 * 8.6 3b PR 11d-3: enacting a SAVED blackout's recommendations (plan B12).
 * The estate and season seed and the panel steps are
 * `practice_repair_panel.ts`'s; the enact step is `practice_repair_enact.ts`'s.
 * DOM assertions only. Synthetic names only.
 */

When(
  'I save an all-day blackout on {string} from {string} to {string}',
  async ({ page }, fieldName: string, from: string, until: string) => {
    await page.getByRole('button', { name: 'Add blackout' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await page.getByLabel('What does this close?').selectOption({ label: 'One field' });
    await page.getByLabel(/^Field/).selectOption({ label: fieldName });
    await page.getByLabel(/^First day/).fill(from);
    await page.getByLabel(/^Last day/).fill(until);
    await expect(page.getByLabel(/Closed all day/)).toBeChecked();
    await expect(page.getByTestId('blackout-consequence')).toBeVisible();
    await dialog.getByRole('button', { name: 'Save blackout' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  }
);

When(
  'I open the practice repair for the saved blackout on {string}',
  async ({ page }, fieldName: string) => {
    const button = page.getByRole('button', {
      name: new RegExp(`^Repair practices for the blackout on ${fieldName}, `),
    });
    await expect(button).toBeEnabled();
    // Keyboard, not a pointer. Space, not Enter: the grid's own keyboard
    // handler takes Enter inside a cell (`useGridKeyboard`, pre-existing).
    await button.focus();
    await page.keyboard.press('Space');
    await expect(button).toHaveAttribute('aria-expanded', 'true');
    const region = page.getByTestId('blackout-practice-repair');
    await expect(region.getByTestId('practice-repair-rows')).toBeVisible();
    await expect(region.getByTestId('practice-repair-error')).toHaveCount(0);
  }
);

const enactedRowOf = (page: Page, team: string) =>
  page.getByTestId('practice-repair-enacted-row').filter({ hasText: team });

Then(
  'the practice of {string} should be shown temporarily moved and locked',
  async ({ page }, team: string) => {
    const temporary = enactedRowOf(page, team).getByTestId('practice-repair-enacted-temporary');
    await expect(temporary).toContainText('temporarily moved to');
    await expect(temporary).toContainText('Repair Pitch 2');
    await expect(temporary).toContainText('Locked');
    await expect(enactedRowOf(page, team)).toContainText('keeps its range');
    await expect(page.getByTestId('practice-repair-window').filter({ hasText: team })).toHaveCount(
      0
    );
  }
);

Then(
  'the practice of {string} should be shown temporarily TIME TBD and locked',
  async ({ page }, team: string) => {
    const temporary = enactedRowOf(page, team).getByTestId('practice-repair-enacted-temporary');
    await expect(temporary).toContainText('temporarily TIME TBD');
    await expect(temporary).toContainText('Locked');
    await expect(page.getByTestId('practice-repair-window').filter({ hasText: team })).toHaveCount(
      0
    );
  }
);

/**
 * The admin, on the team portal of `team` in the active org (no coach signs in, docs/changes/
 * 2026-10-27-admin-only.md, so the page is read as the admin who enacted the repair).
 */
When('I open the team portal of {string}', async ({ page }, teamName: string) => {
  await waitForMockClient(page);
  const teamId = await page.evaluate((name) => {
    const db = JSON.parse(sessionStorage.getItem('__MOCK_DB__') || '{}');
    const orgId = localStorage.getItem('squadlogic_active_org');
    const team = (db.teams || []).find(
      (t: Record<string, unknown>) => t.name === name && t.organization_id === orgId
    );
    if (!team) throw new Error(`no team ${name} in the active organization`);
    return team.id as string;
  }, teamName);
  await page.goto(`/team/${teamId}`);
  await expect(page.getByRole('heading', { name: teamName }).first()).toBeVisible({
    timeout: 15000,
  });
});

/** The page's own long-date reading of a wall date, so the step is locale-proof. */
const longDate = (page: Page, date: string) =>
  page.evaluate(
    (d) =>
      new Date(`${d}T00:00:00`).toLocaleDateString(undefined, {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
      }),
    date
  );

Then(
  'the team portal should show the practice on {string} as {string}',
  async ({ page }, date: string, heading: string) => {
    const card = page.locator('.glass-panel').filter({ hasText: await longDate(page, date) });
    await expect(card).toHaveCount(1, { timeout: 15000 });
    await expect(card.getByRole('heading', { name: heading })).toBeVisible();
    await expect(card).toContainText('Repair Pitch 2');
  }
);

Then(
  'the team portal should show the practice on {string} as TIME TBD',
  async ({ page }, date: string) => {
    const text = new RegExp(`^Time TBD on ${await longDate(page, date)}: .+`);
    await expect(page.getByText(text)).toBeVisible({ timeout: 15000 });
  }
);
