import { createBdd } from 'playwright-bdd';
import { expect, type Page } from '@playwright/test';
import { waitForMockClient } from './mockReady.js';

/**
 * Demo mode, on the mock (plan docs/changes/2026-10-22-demo-mode.md, D4). Every check is a DOM
 * assertion; the mock's sessionStorage is touched only for the two knobs the mock's
 * `start_demo_session` reads: `__MOCK_DEMO_MS__` (a shorter demo) and `__MOCK_DEMO_FAIL__`
 * (`capacity`: the server's refusal at the cap).
 */

const { Given, When, Then } = createBdd();

const DEMO_START_TIMEOUT = 30_000;

async function startDemo(page: Page, lifespanMs?: number) {
  await page.goto('/');
  await waitForMockClient(page);
  await page.evaluate((ms) => {
    sessionStorage.removeItem('__MOCK_SESSION__');
    sessionStorage.removeItem('__MOCK_DEMO_FAIL__');
    if (ms) sessionStorage.setItem('__MOCK_DEMO_MS__', String(ms));
    else sessionStorage.removeItem('__MOCK_DEMO_MS__');
  }, lifespanMs ?? 0);
  await page.goto('/demo/start');
}

async function expectInDemo(page: Page) {
  await expect(page.getByRole('timer')).toBeVisible({ timeout: DEMO_START_TIMEOUT });
  await expect(
    page.getByRole('button', { name: /^Active Organization: Demo league/ })
  ).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/');
}

Given('I am in the demo league', async ({ page }) => {
  await startDemo(page);
  await expectInDemo(page);
});

Given('I am in a demo league that lasts {int} seconds', async ({ page }, seconds: number) => {
  await startDemo(page, seconds * 1000);
  await expectInDemo(page);
});

Given('the demo is full', async ({ page }) => {
  await page.goto('/');
  await waitForMockClient(page);
  await page.evaluate(() => {
    sessionStorage.removeItem('__MOCK_SESSION__');
    sessionStorage.setItem('__MOCK_DEMO_FAIL__', 'capacity');
  });
});

When('I choose {string} on the sign-in page', async ({ page }, label: string) => {
  await page.getByRole('button', { name: label }).click();
});

When('I open the demo entry page', async ({ page }) => {
  await page.goto('/demo/start');
});

When('I choose {string} on the demo-ended page', async ({ page }, label: string) => {
  await page.getByRole('button', { name: label }).click();
});

When('I choose {string}', async ({ page }, label: string) => {
  await page.getByRole('button', { name: label }).click();
});

Then('the demo league is open', async ({ page }) => {
  await expectInDemo(page);
});

Then('the header shows the demo timer counting down', async ({ page }) => {
  const timer = page.getByRole('timer');
  await expect(timer).toHaveAttribute('aria-live', 'off');
  await expect(timer).toContainText('Demo league');
  const first = (await timer.textContent()) ?? '';
  // It moves: a different reading a couple of seconds on.
  await expect
    .poll(async () => (await timer.textContent()) ?? '', { timeout: 10_000 })
    .not.toBe(first);
  await expect(timer.getByRole('button', { name: 'Leave demo' })).toBeVisible();
  // In the header, on every page: here, the players page too.
  await expect(page.locator('header.topbar').getByRole('timer')).toBeVisible();
});

Then('the demo league lists {int} players', async ({ page }, count: number) => {
  await page.goto('/players');
  await expect(page.getByRole('heading', { name: 'Players', exact: true })).toBeVisible();
  await expect(page.getByText(`${count} registered`)).toBeVisible();
  await expect(page.getByRole('timer')).toBeVisible();
});

When("I open the demo's players page", async ({ page }) => {
  await page.goto('/players');
  await expect(page.getByRole('heading', { name: 'Players', exact: true })).toBeVisible();
  await expect(page.getByRole('grid', { name: 'Players grid' })).toBeVisible();
});

Then("a player's name cannot be edited and a player's status can", async ({ page }) => {
  const grid = page.getByRole('grid', { name: 'Players grid' });
  // The first row's name: a double click opens an editor on an editable cell, and nothing here.
  const nameCell = grid.getByRole('gridcell').nth(1);
  await nameCell.dblclick();
  await expect(grid.getByRole('textbox', { name: 'Player' })).toHaveCount(0);
  // Where they play and how they are rated: still editable.
  const statusCell = grid.getByText('active', { exact: true }).first();
  await statusCell.dblclick();
  await expect(grid.getByRole('combobox', { name: 'Status' })).toBeVisible();
  await page.keyboard.press('Escape');
});

Then('the players page offers no way to add or delete a player', async ({ page }) => {
  await expect(page.getByRole('button', { name: /Add player/ })).toHaveCount(0);
  await page.getByRole('checkbox', { name: 'Select row' }).first().check();
  await expect(page.getByRole('button', { name: 'Delete', exact: true })).toHaveCount(0);
  await page.getByRole('checkbox', { name: 'Select row' }).first().uncheck();
});

When("I open the demo's coaches page", async ({ page }) => {
  await page.goto('/coaches');
  await expect(page.getByRole('heading', { name: 'Coaches', exact: true })).toBeVisible();
  await expect(page.getByRole('grid', { name: 'Coaches grid' })).toBeVisible();
});

Then('no coach can be given a status or deleted', async ({ page }) => {
  const grid = page.getByRole('grid', { name: 'Coaches grid' });
  // No selection column, so no bulk status or delete.
  await expect(grid.getByRole('checkbox', { name: 'Select row' })).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: /^Set (Registered|Interested|Inactive)$/ })
  ).toHaveCount(0);
  // A status cell does not turn into an editor.
  await grid.getByText('Registered', { exact: true }).first().dblclick();
  await expect(grid.getByRole('combobox', { name: 'Status' })).toHaveCount(0);
});

When("I open the demo's import page and try to browse for a file", async ({ page }) => {
  await page.goto('/import');
  await expect(page.getByText('Drag and drop your CSV file here')).toBeVisible();
  // Any file chooser the page opens is recorded; the test asserts there was none.
  await page.evaluate(() => {
    (window as unknown as { __pickerOpened: boolean }).__pickerOpened = false;
  });
  page.on('filechooser', async () => {
    await page.evaluate(() => {
      (window as unknown as { __pickerOpened: boolean }).__pickerOpened = true;
    });
  });
  await page.getByText('browse files').click();
});

Then('no file picker opens', async ({ page }) => {
  await expect(
    page.getByRole('dialog', { name: 'Importing is turned off in the demo' })
  ).toBeVisible();
  // Give a chooser event time to arrive if one was going to.
  await page.waitForTimeout(500);
  expect(
    await page.evaluate(() => (window as unknown as { __pickerOpened: boolean }).__pickerOpened)
  ).toBe(false);
});

Then('the import notice offers an account here and a SquadLogic of my own', async ({ page }) => {
  const dialog = page.getByRole('dialog', { name: 'Importing is turned off in the demo' });
  await expect(dialog.getByRole('button', { name: 'Create an account here' })).toBeVisible();
  await expect(dialog.getByRole('link', { name: 'Run your own SquadLogic' })).toHaveAttribute(
    'href',
    /self-hosting\.md$/
  );
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});

Then('I land on the demo-ended page', async ({ page }) => {
  await expect(page.getByRole('heading', { name: 'Your demo has ended' })).toBeVisible({
    timeout: 30_000,
  });
  expect(new URL(page.url()).pathname).toBe('/demo/ended');
  await expect(page.getByRole('button', { name: 'Start again' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create an account' })).toBeVisible();
});

Then('I am signed out', async ({ page }) => {
  // Read off the page, not the store: a signed-out visitor who opens the app gets the sign-in form.
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Sign In' })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('timer')).toHaveCount(0);
});

Then('I am back on the sign-in page, signed out', async ({ page }) => {
  await expect(page.getByRole('button', { name: 'Sign In' })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('timer')).toHaveCount(0);
  // And it holds on a reload: nothing keeps the visitor in.
  await page.reload();
  await expect(page.getByRole('button', { name: 'Sign In' })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('timer')).toHaveCount(0);
});

Then('I stay on the entry page and it says the demo is busy', async ({ page }) => {
  const alert = page.getByRole('alert').filter({ hasText: 'The demo is busy right now' });
  await expect(alert).toBeVisible({ timeout: DEMO_START_TIMEOUT });
  expect(new URL(page.url()).pathname).toBe('/demo/start');
  await expect(page.getByRole('heading', { name: 'The demo did not start' })).toBeVisible();
});

When('I open the demo-ended page', async ({ page }) => {
  await page.goto('/demo/ended');
  await expect(page.getByRole('heading', { name: 'Your demo has ended' })).toBeVisible();
});

When('I switch the demo-ended page to the dark theme', async ({ page }) => {
  await page.evaluate(() => localStorage.setItem('sl-theme', 'dark'));
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Your demo has ended' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});

When('I switch the demo entry page to the dark theme', async ({ page }) => {
  // The page rests in its failed state (the demo is full), so a reload lands on it again.
  await page.evaluate(() => localStorage.setItem('sl-theme', 'dark'));
  await page.reload();
  await expect(
    page.getByRole('alert').filter({ hasText: 'The demo is busy right now' })
  ).toBeVisible({
    timeout: DEMO_START_TIMEOUT,
  });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});
