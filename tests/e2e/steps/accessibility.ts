import { createBdd } from 'playwright-bdd';
import { expect, type Page } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';
import { waitForMockClient } from './mockReady.js';

const { Given, When, Then } = createBdd();

/** The WCAG 2.0, 2.1 and 2.2 A and AA rules; axe's best-practice rules are left out. */
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'];
const BLOCKING_IMPACTS = new Set(['serious', 'critical']);

type Theme = 'light' | 'dark';

/**
 * Violations a scan tolerates because another change owns the fix. Each entry names the route,
 * the theme, the rule and the element, and why it is not fixed here. An entry that matches no
 * violation fails the scan, so a fixed violation's entry has to be deleted with the fix.
 */
const KNOWN_VIOLATIONS: ReadonlyArray<{
  route: string;
  theme: Theme;
  rule: string;
  /** A fragment of the element's HTML, as axe reports it. */
  html: string;
  reason: string;
}> = [];

async function expectHeading(page: Page, heading: string) {
  await expect(page.getByRole('heading', { name: heading, exact: true }).first()).toBeVisible({
    timeout: 20_000,
  });
  // Lazy chunks and the mock's reads settle before the scan, so it sees the rendered page.
  await page.waitForLoadState('networkidle');
}

Given('I am signed out on the sign-in page', async ({ page }) => {
  await page.goto('/');
  await waitForMockClient(page);
  await page.evaluate(() => sessionStorage.removeItem('__MOCK_SESSION__'));
  await page.goto('/login');
  await expect(page.getByRole('button', { name: 'Sign In' })).toBeVisible({ timeout: 20_000 });
  await page.waitForLoadState('networkidle');
});

When('I switch the sign-in page to the dark theme', async ({ page }) => {
  // The sign-in page has no theme toggle, so set the choice the toggle would store. The page has
  // mounted (its Sign In button is visible), so ThemeProvider reads it on the reload rather than
  // overwriting it.
  await page.evaluate(() => localStorage.setItem('sl-theme', 'dark'));
  await page.reload();
  await expect(page.getByRole('button', { name: 'Sign In' })).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.waitForLoadState('networkidle');
});

When(
  'I open {string} and see its {string} heading',
  async ({ page }, route: string, heading: string) => {
    await page.goto(route);
    await expectHeading(page, heading);
    // A redirect would scan some other page under this route's name.
    expect(new URL(page.url()).pathname).toBe(route);
    await expect(page.locator('html')).not.toHaveAttribute('data-theme', 'dark');
  }
);

When(
  'I switch to the dark theme and reopen {string} with its {string} heading',
  async ({ page }, route: string, heading: string) => {
    // The toggle lives in the top bar, which the setup and reset routes don't render, so switch
    // on the dashboard; the choice persists (sl-theme) to the route.
    await page.goto('/');
    const toggle = page.getByRole('button', { name: 'Switch to dark mode' });
    await expect(toggle).toBeVisible({ timeout: 20_000 });
    await toggle.click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.goto(route);
    await expectHeading(page, heading);
    expect(new URL(page.url()).pathname).toBe(route);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  }
);

Then(
  'axe finds no serious or critical violations on {string} in the {string} theme',
  async ({ page }, route: string, theme: string) => {
    const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();

    // A scan that checked nothing proves nothing: an unrendered page passes every rule.
    expect(results.passes.length, `axe passed no rule on ${route}: did it render?`).toBeGreaterThan(
      10
    );

    const expected = KNOWN_VIOLATIONS.filter((k) => k.route === route && k.theme === theme);
    const matched = new Set<(typeof KNOWN_VIOLATIONS)[number]>();
    const blocking: string[] = [];
    for (const violation of results.violations) {
      if (!BLOCKING_IMPACTS.has(violation.impact ?? '')) continue;
      for (const node of violation.nodes) {
        const known = expected.find((k) => k.rule === violation.id && node.html.includes(k.html));
        if (known) {
          matched.add(known);
          continue;
        }
        blocking.push(
          `[${violation.impact}] ${violation.id} at ${node.target.join(' ')}: ` +
            `${node.failureSummary?.split('\n').slice(1).join(' ').trim()}\n    ${node.html}`
        );
      }
    }

    expect(
      blocking,
      `${blocking.length} serious or critical axe violation(s) on ${route} (${theme}):\n` +
        blocking.join('\n')
    ).toEqual([]);
    const stale = expected.filter((k) => !matched.has(k));
    expect(
      stale.map((k) => `${k.rule} "${k.html}"`),
      `KNOWN_VIOLATIONS entries for ${route} (${theme}) that no longer occur: delete them`
    ).toEqual([]);
  }
);

// ---- DataGrid keyboard (plan, Discovered under M4.2: the grid trapped Tab, WCAG 2.1.2) ----

/** Where focus is, relative to a grid: inside it or not, and the focused cell's row and column. */
async function focusInGrid(page: Page, gridName: string) {
  return page.getByRole('grid', { name: gridName }).evaluate((grid) => {
    const el = document.activeElement;
    const cell = el?.closest('[data-grid-cell]');
    return {
      inside: !!el && grid.contains(el),
      r: cell?.getAttribute('data-r') ?? null,
      c: cell?.getAttribute('data-c') ?? null,
      tag: el?.tagName ?? null,
    };
  });
}

When('I tab from the table search into the {string}', async ({ page }, gridName: string) => {
  const grid = page.getByRole('grid', { name: gridName });
  await expect(grid).toBeVisible();
  await page.getByRole('textbox', { name: 'Search table' }).focus();
  // A real Tab, pressed until focus enters the grid; the toolbar's controls sit in between.
  for (let i = 0; i < 12 && !(await focusInGrid(page, gridName)).inside; i += 1) {
    await page.keyboard.press('Tab');
  }
  const at = await focusInGrid(page, gridName);
  expect(at.inside, 'Tab never reached the grid').toBe(true);
  // It enters at the grid's one tab stop: the first body row's first editable cell.
  expect(at.r).toBe('0');
});

Then(
  'the arrow keys move focus between the cells of the {string}',
  async ({ page }, gridName: string) => {
    const start = await focusInGrid(page, gridName);
    await page.keyboard.press('ArrowDown');
    const down = await focusInGrid(page, gridName);
    expect(down).toMatchObject({ inside: true, r: '1', c: start.c });
    await page.keyboard.press('ArrowRight');
    const right = await focusInGrid(page, gridName);
    expect(right).toMatchObject({ inside: true, r: '1' });
    expect(Number(right.c)).toBe(Number(start.c) + 1);
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');
    const header = await focusInGrid(page, gridName);
    expect(header).toMatchObject({ inside: true, r: '-1', c: right.c });
    await page.keyboard.press('ArrowDown');
    expect(await focusInGrid(page, gridName)).toMatchObject({ inside: true, r: '0' });
    // The focused cell is visibly marked (WCAG 2.4.7): an inset ring, not the default outline.
    const ring = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement;
      const cell = el.closest('[data-grid-cell]') as HTMLElement;
      return getComputedStyle(cell).boxShadow;
    });
    expect(ring).not.toBe('none');
  }
);

Then(
  'Tab moves focus out of the {string} and Shift+Tab brings it back to the same cell',
  async ({ page }, gridName: string) => {
    const before = await focusInGrid(page, gridName);
    await page.keyboard.press('Tab');
    expect((await focusInGrid(page, gridName)).inside, 'Tab stayed inside the grid').toBe(false);
    await page.keyboard.press('Shift+Tab');
    expect(await focusInGrid(page, gridName)).toEqual(before);
  }
);
