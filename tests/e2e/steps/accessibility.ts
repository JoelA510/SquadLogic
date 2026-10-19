import { createBdd } from 'playwright-bdd';
import { expect, type Page } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';
import { waitForMockClient } from './mockReady.js';
import { MOCK_ORG_ID } from '../../../frontend/src/lib/mockSeedIds.js';

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

Given('I am signed out and open the invite link {string}', async ({ page }, code: string) => {
  await page.goto('/');
  await waitForMockClient(page);
  await page.evaluate(() => sessionStorage.removeItem('__MOCK_SESSION__'));
  await page.goto(`/invite/${code}`);
  // The sign-in form under the invite banner, with the URL still the invite's.
  await expect(page.getByRole('button', { name: 'Sign In' })).toBeVisible({ timeout: 20_000 });
  expect(new URL(page.url()).pathname).toBe(`/invite/${code}`);
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

Then('the scan sees {string} on the page', async ({ page }, content: string) => {
  // The scan below examines what is rendered; this is what it must find rendered, so a route
  // that shows only its shell or a spinner fails here rather than passing an emptier scan.
  await expect(page.getByText(content).first()).toBeVisible({ timeout: 20_000 });
});

When('I switch to the dark theme on this page', async ({ page }) => {
  // The top bar's toggle, without leaving the page: content it holds only in memory (an invite
  // just generated, a schedule staged for review) is still there for the dark scan.
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', 'dark');
  await page.getByRole('button', { name: 'Switch to dark mode' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});

When('I generate an invite on the Members page', async ({ page }) => {
  await page.getByRole('button', { name: 'Generate invite' }).click();
  await expect(page.getByText('Invite ready')).toBeVisible({ timeout: 15_000 });
});

Then(
  'axe finds no serious or critical violations on {string} in the {string} theme',
  async ({ page }, route: string, theme: string) => {
    // Let entrance animations finish first: axe measures colours as drawn, and a panel still
    // fading in (`animate-slideUp`) reads as lower contrast than it settles at. Looping
    // animations (a pulse, a spinner) never finish, so only finite ones are awaited.
    await page.evaluate(() =>
      Promise.all(
        document
          .getAnimations()
          .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
          .map((a) => a.finished.catch(() => undefined))
      )
    );
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

// ---- Row-actions menu inside the grid (#591 review: its items joined the tab order) ----

When(
  "I open the first row's actions menu in the {string} from the keyboard",
  async ({ page }, gridName: string) => {
    // End on the first row lands on the row-actions cell, whose one widget takes focus.
    await page.keyboard.press('End');
    const trigger = page.getByRole('grid', { name: gridName }).getByRole('button', {
      name: 'Row actions',
    });
    await expect(trigger.first()).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('menu')).toBeVisible();
    await expect(trigger.first()).toBeFocused();
  }
);

Then(
  'the arrow keys move through the menu and Escape returns to the {string} cell',
  async ({ page }, gridName: string) => {
    const items = page.getByRole('menuitem');
    await page.keyboard.press('ArrowDown');
    await expect(items.nth(0)).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(items.nth(1)).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);
    const trigger = page
      .getByRole('grid', { name: gridName })
      .getByRole('button', { name: 'Row actions' })
      .first();
    await expect(trigger).toBeFocused();
    // Open it again for the next step, and step into it.
    await page.keyboard.press('Enter');
    await page.keyboard.press('ArrowDown');
    await expect(items.nth(0)).toBeFocused();
  }
);

Then(
  'Tab from the open menu leaves the {string} and closes the menu',
  async ({ page }, gridName: string) => {
    await page.keyboard.press('Tab');
    expect((await focusInGrid(page, gridName)).inside, 'Tab stayed inside the grid').toBe(false);
    await expect(page.getByRole('menu')).toHaveCount(0);
    // And from the trigger itself, the menu open but not entered: the reviewed case, where the
    // newly mounted items were the next tab stops.
    await page.keyboard.press('Shift+Tab');
    const trigger = page
      .getByRole('grid', { name: gridName })
      .getByRole('button', { name: 'Row actions' })
      .first();
    await expect(trigger).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('menu')).toBeVisible();
    await page.keyboard.press('Tab');
    expect((await focusInGrid(page, gridName)).inside, 'Tab went into the open menu').toBe(false);
    await expect(page.getByRole('menu')).toHaveCount(0);
  }
);

// ---- Chart colours (plan, Discovered under M4.2: Recharts kept hard-coded slate colours) ----

Given('the organization has {int} evaluation runs on record', async ({ page }, count: number) => {
  // The mock seed has none, so the analytics page draws empty charts; these are its input.
  await waitForMockClient(page);
  await page.evaluate(
    ({ count, mockOrgId }) => {
      const db = window.__MOCK_DB__ as Record<string, Array<Record<string, unknown>> | undefined>;
      const orgId = localStorage.getItem('squadlogic_active_org') || mockOrgId;
      const day = 86_400_000;
      const start = Date.now() - count * 7 * day;
      db.evaluation_runs = [
        ...(db.evaluation_runs ?? []).filter((run) => !String(run.id).startsWith('a11y-eval-')),
        ...Array.from({ length: count }, (_, index) => ({
          id: `a11y-eval-${index + 1}`,
          organization_id: orgId,
          created_at: new Date(start + index * 7 * day).toISOString(),
          scheduler_run_type: index % 2 === 0 ? 'team' : 'practice',
          status: 'completed',
          metrics_summary: { fairnessIndex: 0.6 + index * 0.05, conflictCount: (index * 3) % 5 },
        })),
      ];
      window.__saveMockDB__(db);
    },
    { count, mockOrgId: MOCK_ORG_ID }
  );
});

Then(
  "the charts draw their axis labels and gridlines in the {string} theme's tokens",
  async ({ page }, theme: string) => {
    const ticks = page.locator('.recharts-cartesian-axis-tick-value');
    await expect(ticks.first()).toBeVisible({ timeout: 20_000 });
    const drawn = await page.evaluate(() => {
      /** A token's computed colour, read through a probe so it compares as rgb(). */
      const resolve = (token: string) => {
        const probe = document.createElement('span');
        probe.style.color = `var(${token})`;
        document.body.append(probe);
        const value = getComputedStyle(probe).color;
        probe.remove();
        return value;
      };
      const tickFills = [...document.querySelectorAll('.recharts-cartesian-axis-tick-value')].map(
        (el) => getComputedStyle(el).fill
      );
      const gridStrokes = [
        ...document.querySelectorAll('.recharts-cartesian-grid-horizontal line'),
      ].map((el) => getComputedStyle(el).stroke);
      return {
        theme: document.documentElement.getAttribute('data-theme') ?? 'light',
        axis: resolve('--text-secondary'),
        grid: resolve('--border'),
        tickFills: [...new Set(tickFills)],
        gridStrokes: [...new Set(gridStrokes)],
        ticks: tickFills.length,
        lines: gridStrokes.length,
      };
    });
    expect(drawn.theme).toBe(theme);
    // A chart with no ticks or gridlines checked nothing.
    expect(drawn.ticks).toBeGreaterThan(3);
    expect(drawn.lines).toBeGreaterThan(3);
    expect(drawn.tickFills).toEqual([drawn.axis]);
    expect(drawn.gridStrokes).toEqual([drawn.grid]);
  }
);

// ---- Pages the seed leaves empty or masked (#591 follow-up) ----

/**
 * Add rows to mock tables from the page, each stamped with the active organization. The seeds
 * below are the only place this file touches the mock database; the Then steps read the page.
 */
async function seedMockTables(page: Page, rows: Record<string, Array<Record<string, unknown>>>) {
  await waitForMockClient(page);
  await page.evaluate(
    ({ rows, mockOrgId }) => {
      const db = window.__MOCK_DB__ as Record<string, Array<Record<string, unknown>>>;
      const orgId = localStorage.getItem('squadlogic_active_org') || mockOrgId;
      for (const [table, added] of Object.entries(rows)) {
        const ids = new Set(added.map((row) => row.id));
        db[table] = [
          ...(db[table] ?? []).filter((row) => !ids.has(row.id)),
          ...added.map((row) => ({ organization_id: orgId, ...row })),
        ];
      }
      window.__saveMockDB__(db);
    },
    { rows, mockOrgId: MOCK_ORG_ID }
  );
}

When(
  'I publish a baseline from the Exports page and compare it with the schedule',
  async ({ page }) => {
    await page.getByTestId('generate-csvs-btn').click();
    await expect(page.getByText('CSVs generated successfully.')).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: 'Upload to Storage' }).click();
    await expect(page.getByText(/^Uploaded \d+ files/)).toBeVisible({ timeout: 15_000 });
    // The new baseline is listed once the upload has recorded it.
    const select = page.getByTestId('baseline-select');
    await expect(select.locator('option')).toHaveCount(2, { timeout: 15_000 });
    await select.selectOption({ index: 1 });
    await page.getByTestId('check-parity-btn').click();
    await expect(page.getByTestId('parity-report')).toBeVisible({ timeout: 15_000 });
  }
);

Given(
  'a coach has a pending practice preference request and another has one in force',
  async ({ page }) => {
    const now = new Date();
    const yesterday = new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
    await seedMockTables(page, {
      coach_practice_preferences: [
        {
          id: 'a11y-pref-requested',
          coach_id: 'coach-lead-1',
          dimension: 'weekday',
          level: 'must_keep',
          value: 'TUE',
          status: 'requested',
          requested_at: now.toISOString(),
          decided_at: null,
          effective_from: null,
          effective_to: null,
        },
        {
          id: 'a11y-pref-approved',
          coach_id: 'c2',
          dimension: 'start_time',
          level: 'prefer_keep',
          value: 18 * 60,
          status: 'approved',
          requested_at: now.toISOString(),
          decided_at: now.toISOString(),
          effective_from: yesterday,
          effective_to: null,
        },
      ],
    });
  }
);

Given('seasonal availability is imported for a field', async ({ page }) => {
  // The page reads a profile with its formats, blackout windows and equipment embedded. The mock
  // does not resolve those embeds from their own tables, so they sit on the row, as PostgREST
  // would return it.
  await seedMockTables(page, {
    field_availability_profiles: [
      {
        id: 'a11y-profile-1',
        season_label: 'Fall 2026',
        location: 'Riverside Park',
        field_name: 'Back Pitch',
        record_status: 'conditional',
        approval_status: 'pending',
        available_from: '2026-09-01',
        available_until: '2026-11-15',
        month_indicators: 'Sep Oct Nov',
        blackout_months: 'August',
        teams_per_hour: '4',
        aggregate_teams_per_hour: '8',
        lighted: true,
        restroom: true,
        potty: false,
        day_constraints: 'Weekdays after 5pm',
        move_to_location: 'Hillside Complex',
        field_availability_profile_formats: [
          { id: 'a11y-format-1', format_code: '7v7', format_quantity: 2, format_order: 1 },
        ],
        field_blackout_windows: [
          {
            id: 'a11y-window-1',
            blackout_from: '2026-10-10',
            blackout_until: '2026-10-12',
            reason: 'Harvest festival',
          },
        ],
        field_equipment_requirements: [
          { id: 'a11y-equip-1', goal_equipment: 'Portable goals', requirement_status: 'required' },
        ],
      },
    ],
  });
});

Given(
  'the organization has {int} players with a custom attribute',
  async ({ page }, count: number) => {
    const sizes = ['Small', 'Medium', 'Large'];
    await seedMockTables(page, {
      players: Array.from({ length: count }, (_, index) => ({
        id: `a11y-player-${index + 1}`,
        first_name: `Sample${index + 1}`,
        last_name: 'Player',
        division: 'U10',
        status: 'active',
        custom_attributes: { jersey_size: sizes[index % sizes.length] },
      })),
    });
  }
);

Then('the chart of the custom attribute is drawn instead of the privacy mask', async ({ page }) => {
  await expect(page.getByText('Data Masked for Privacy')).toHaveCount(0);
  await expect(
    page.getByRole('img', { name: /Bar chart showing distribution of players/ })
  ).toBeVisible({
    timeout: 20_000,
  });
});

// ---- Each route's main dialog, open (#591: "a scan with each route's main dialog open") ----

When(
  'I open the {string} dialog with {string}',
  async ({ page }, dialog: string, opener: string) => {
    // `A > B` is a menu or tab strip: the button A, then its item B.
    for (const name of opener.split(' > ')) {
      await page
        .getByRole('button', { name })
        .or(page.getByRole('menuitem', { name }))
        .or(page.getByRole('tab', { name }))
        .first()
        .click();
    }
    // Some of these dialogs are the shared Modal and some are the page's own overlay, so the dialog
    // is told by its heading, which both have.
    await expect(page.getByRole('heading', { name: dialog }).first()).toBeVisible({
      timeout: 20_000,
    });
  }
);

When('I switch to the dark theme behind the open dialog', async ({ page }) => {
  // The dialog's overlay covers the top bar, so a pointer click on the toggle would land on the
  // overlay. The click is dispatched on the button itself: the same handler, with the dialog (and
  // whatever it holds in memory) left open for the dark scan.
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', 'dark');
  await page.evaluate(() => {
    const toggle = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Switch to dark mode"]'
    );
    if (!toggle) throw new Error('The theme toggle is not on the page');
    toggle.click();
  });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});
