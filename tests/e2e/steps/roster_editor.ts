import { createBdd } from 'playwright-bdd';
import { expect, type Page } from '@playwright/test';
import { waitForMockClient } from './mockReady.js';

/**
 * The manual roster editor on the mock (roster_editor.feature). Every check is a DOM assertion;
 * the mock's sessionStorage is touched only for the knobs the mock's `start_demo_session` reads
 * (`__MOCK_DEMO_PLAYERS__`: a larger league, past the server's 1000-row cap).
 */

const { Given, When, Then } = createBdd();

const LOAD_TIMEOUT = 60_000;

const team = (page: Page, name: string) => page.getByRole('region', { name, exact: true });

Given('I am in a demo league of {int} players', async ({ page }, players: number) => {
  await page.goto('/');
  await waitForMockClient(page);
  await page.evaluate((count) => {
    sessionStorage.removeItem('__MOCK_SESSION__');
    sessionStorage.removeItem('__MOCK_DEMO_FAIL__');
    sessionStorage.removeItem('__MOCK_DEMO_MS__');
    sessionStorage.setItem('__MOCK_DEMO_PLAYERS__', String(count));
  }, players);
  await page.goto('/demo/start');
  await expect(page.getByRole('timer')).toBeVisible({ timeout: LOAD_TIMEOUT });
});

// A demo starts with its practice schedule applied (migration 20261110010000), so a league with
// nothing applied is one whose practices were released: the rows go, and with them the practice run.
// The release is fixture setup (the mock store); that the demo DID start with practices is proved
// through the page first, because otherwise "released" could release nothing: the Exports page does
// not call the league empty, and offers to generate its files.
Given("the demo league's applied practices have been released", async ({ page }) => {
  await page.goto('/exports');
  const generate = page.getByTestId('generate-csvs-btn');
  await expect(generate).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(generate).not.toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByTestId('csv-empty-reason')).toHaveCount(0);

  await waitForMockClient(page);
  await page.evaluate(() => {
    const db = window.__MOCK_DB__ as Record<string, Array<Record<string, unknown>> | undefined>;
    const demo = (db.organizations ?? []).find((org) => org.demo_expires_at);
    db.practice_assignments = (db.practice_assignments ?? []).filter(
      (row) => row.organization_id !== demo?.id
    );
    db.scheduler_runs = (db.scheduler_runs ?? []).filter(
      (run) => !(run.organization_id === demo?.id && run.run_type === 'practice')
    );
    window.__saveMockDB__(db);
  });
});

Then(
  'the sidebar badge for {string} reads {int}',
  async ({ page }, label: string, count: number) => {
    const link = page.getByRole('link', { name: new RegExp(`^${label}`) }).first();
    await expect(link).toContainText(String(count), { timeout: LOAD_TIMEOUT });
  }
);

When('I open the roster editor', async ({ page }) => {
  await page.goto('/teams');
  const edit = page.getByRole('button', { name: 'Edit Mode' });
  await expect(edit).toBeVisible({ timeout: LOAD_TIMEOUT });
  await edit.click();
  await expect(page.getByRole('heading', { name: 'Manual Roster Management' })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  // The editor waits for the names: the cards are there once the loading line is gone.
  await expect(page.getByText('Loading player and coach names...')).toHaveCount(0, {
    timeout: LOAD_TIMEOUT,
  });
  await expect(page.getByRole('region', { name: /Team \d+$/ }).first()).toBeVisible();
});

Then('the roster editor names the last player {string}', async ({ page }, name: string) => {
  // Past row 1000 of the players table: the player a read cut at the server cap never names.
  await expect(page.getByText(name, { exact: true })).toBeVisible({ timeout: LOAD_TIMEOUT });
});

Then('no player in the roster editor is called {string}', async ({ page }, name: string) => {
  // Meta-assertion: cards are rendered, so a count of zero is a real zero.
  expect(await page.getByRole('button', { name: /^Drag / }).count()).toBeGreaterThan(1000);
  await expect(page.getByText(name, { exact: true })).toHaveCount(0);
});

Then('every coach line in the roster editor names its coach', async ({ page }) => {
  const lines = page.locator('.roster-card-meta', { hasText: /^Coach/ });
  expect(await lines.count()).toBeGreaterThan(10);
  await expect(page.getByText(/name(s)? not loaded/)).toHaveCount(0);
  await expect(page.getByText('Coach: Vacant')).toHaveCount(0);
});

Then('no card in the roster editor has a scroll box of its own', async ({ page }) => {
  const scrollers = await page.evaluate(
    () =>
      Array.from(document.querySelectorAll('.roster-card, .roster-card *')).filter((el) => {
        const style = getComputedStyle(el);
        return /(auto|scroll)/.test(style.overflowX + style.overflowY);
      }).length
  );
  expect(scrollers).toBe(0);
});

When(
  'I move {string} from {string} to {string} with the keyboard',
  async ({ page }, player: string, from: string, to: string) => {
    await expect(team(page, from).getByText(player, { exact: true })).toBeVisible();
    const move = page.getByRole('button', { name: `Move ${player} to another team` });
    await move.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: `Move ${player}` });
    const select = dialog.getByLabel('Destination team');
    await expect(select).toBeFocused();
    const label = await select
      .locator('option', { hasText: new RegExp(`^${to} \\(`) })
      .first()
      .textContent();
    await select.selectOption({ label: label ?? to });
    // Tab to Cancel, then to Move player, then Enter: no pointer.
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('button', { name: 'Move player' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(dialog).toHaveCount(0);
  }
);

Then(
  '{string} is on the team {string} marked manual',
  async ({ page }, player: string, name: string) => {
    const card = team(page, name)
      .getByTestId(/^player-card-/)
      .filter({ hasText: player });
    await expect(card).toHaveCount(1);
    await expect(card.getByText('manual', { exact: true })).toBeVisible();
  }
);

Then(
  '{string} is no longer on the team {string}',
  async ({ page }, player: string, name: string) => {
    await expect(team(page, name).getByText(player, { exact: true })).toHaveCount(0);
  }
);

Then('the keyboard focus is on the Move button of {string}', async ({ page }, player: string) => {
  await expect(page.getByRole('button', { name: `Move ${player} to another team` })).toBeFocused();
});

When('the window is {int} pixels wide', async ({ page }, width: number) => {
  await page.setViewportSize({ width, height: 800 });
});

Then('the page does not scroll sideways', async ({ page }) => {
  const overflow = await page.evaluate(() => {
    const scrollers = [document.scrollingElement, document.querySelector('main')];
    return scrollers.some((el) => el && el.scrollWidth > el.clientWidth + 1);
  });
  expect(overflow).toBe(false);
});

When('I open the Exports page', async ({ page }) => {
  await page.goto('/exports');
  await expect(page.getByRole('heading', { name: 'Exports', exact: true }).first()).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
});

Then('the Exports page says the demo data is placeholder data', async ({ page }) => {
  await expect(page.getByTestId('demo-exports-note')).toContainText(
    'placeholder data only, and it resets when the demo ends',
    { timeout: LOAD_TIMEOUT }
  );
});

Then('the Exports page says no practices or games have been applied', async ({ page }) => {
  await expect(page.getByTestId('csv-empty-reason')).toContainText(
    'no practices or games have been applied',
    { timeout: LOAD_TIMEOUT }
  );
});

When('I press {string}', async ({ page }, label: string) => {
  // `aria-disabled` is not `disabled`: the button stays focusable and a click reaches the guard.
  await page.getByRole('button', { name: label }).click({ force: true });
});

Then('no export file is offered', async ({ page }) => {
  // Meta-assertion: the page had time to act on the press (the reason is still on it).
  await expect(page.getByTestId('csv-empty-reason')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Download Master CSV' })).toHaveCount(0);
  await expect(page.getByText('Generated Files')).toHaveCount(0);
});

Then('every control in the header is on screen', async ({ page }) => {
  // The theme toggle, the notifications bell, the account menu and the demo timer were past the
  // right edge at 400px (WCAG 1.4.10): each must now sit inside the window.
  const controls = [
    page.getByRole('button', { name: /^Switch to (dark|light) mode$/ }),
    page.getByRole('button', { name: 'Notifications' }),
    page.getByRole('button', { name: /^Account menu/ }),
    page.getByRole('timer'),
  ];
  const width = page.viewportSize()?.width ?? 0;
  for (const control of controls) {
    await expect(control).toBeVisible();
    const box = await control.boundingBox();
    expect(box, 'a header control has no box').not.toBeNull();
    expect((box?.x ?? -1) >= 0 && (box?.x ?? 0) + (box?.width ?? 0) <= width + 1).toBe(true);
  }
});
