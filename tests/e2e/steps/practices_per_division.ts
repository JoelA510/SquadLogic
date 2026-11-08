import { createBdd, type DataTable } from 'playwright-bdd';
import { expect, type Page } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';
import { waitForMockClient } from './mockReady.js';
import { MOCK_ORG_ID } from '../../../frontend/src/lib/mockSeedIds.js';

/**
 * Practices per division (Phase D PR B). The division's count and length are set through the
 * Teams page's own rules form; the practice route is answered by the Edge function's solver
 * (`edgeAutoSchedulerRoute.ts`), which reads those settings from the page's store. Every check is
 * a DOM assertion; the mock database is touched only to seed the slots.
 */

const { Given, When, Then } = createBdd();

type MockRow = Record<string, unknown>;
type MockDb = Record<string, MockRow[] | undefined>;

/** `YYYY-MM-DD`, `days` from now (UTC). */
const isoFromToday = (days: number) =>
  new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);

async function seedSlots(page: Page, days: Array<'tue' | 'thu'>, capacity: number) {
  await waitForMockClient(page);
  await page.evaluate(
    ({ days, capacity, from, until, mockOrgId }) => {
      const db = window.__MOCK_DB__ as unknown as MockDb | undefined;
      if (!db) throw new Error('mock store not initialised');
      const orgId = localStorage.getItem('squadlogic_active_org') || mockOrgId;
      // The scenario's slots are the only ones the page schedules into, and no saved practice
      // holds any of them: the seed's slot and its saved row are removed, not edited.
      db.practice_slots = days.map((day) => ({
        id: `ppd-${day}`,
        day_of_week: day,
        start_time: '17:00',
        end_time: '18:30',
        capacity,
        valid_from: from,
        valid_until: until,
        field_id: 'v1',
        organization_id: orgId,
      }));
      db.practice_assignments = [];
      window.__saveMockDB__(db);
    },
    { days, capacity, from: isoFromToday(-30), until: isoFromToday(90), mockOrgId: MOCK_ORG_ID }
  );
}

Given(
  'a Tuesday and a Thursday practice slot of 90 minutes with room for {int} teams each',
  async ({ page }, capacity: number) => {
    await seedSlots(page, ['tue', 'thu'], capacity);
  }
);

Given(
  'a Thursday practice slot of 90 minutes with room for {int} teams',
  async ({ page }, capacity: number) => {
    await seedSlots(page, ['thu'], capacity);
  }
);

async function openDivisionRules(page: Page, division: string) {
  await page.goto('/teams');
  await expect(page.getByRole('heading', { name: /Teaming & Analysis/i })).toBeVisible({
    timeout: 15000,
  });
  const choose = page
    .getByRole('table', { name: 'Division Overview' })
    .getByRole('button', { name: division, exact: true });
  await expect(choose).toBeVisible({ timeout: 15000 });
  if ((await choose.getAttribute('aria-current')) !== 'true') await choose.click();
  await expect(page.getByRole('heading', { name: `${division} Settings` })).toBeVisible();
}

async function saveRules(page: Page) {
  await page.getByRole('button', { name: 'Save Rules' }).click();
  await expect(page.getByText('Rules saved.')).toBeVisible({ timeout: 15000 });
}

When(
  'I set the {string} division to {int} practices a week on the Teams page',
  async ({ page }, division: string, count: number) => {
    await openDivisionRules(page, division);
    await page.getByLabel('Practices per week').fill(String(count));
    await saveRules(page);
  }
);

When(
  'I set the {string} division to {int} practices a week and {int} minutes long on the Teams page',
  async ({ page }, division: string, count: number, minutes: number) => {
    await openDivisionRules(page, division);
    await page.getByLabel('Practices per week').fill(String(count));
    await page.getByLabel('Practice length (minutes)').fill(String(minutes));
    await saveRules(page);
  }
);

/** The count the Auto-Scheduler panel shows under `label` ("Assigned", "Unassigned"). */
const schedulerCount = (page: Page, label: string) =>
  page
    .locator('section[aria-label="Auto-Scheduler"]')
    .getByText(label, { exact: true })
    .locator('xpath=following-sibling::div[1]');

Then(
  'the auto-scheduler places {int} practices and leaves {int} unplaced',
  async ({ page }, placed: number, unplaced: number) => {
    await expect(schedulerCount(page, 'Assigned')).toHaveText(String(placed));
    await expect(schedulerCount(page, 'Unassigned')).toHaveText(String(unplaced));
  }
);

/** The staged review's rows, as the page lists them under "Review Practice Changes". */
const reviewRows = (page: Page) =>
  page
    .getByRole('table')
    .filter({ has: page.getByRole('columnheader', { name: 'Field Slot' }) })
    .getByRole('row')
    .filter({ has: page.getByRole('cell') });

Then(
  '{string} has a Tuesday and a Thursday practice in the review',
  async ({ page }, team: string) => {
    const teamRows = reviewRows(page).filter({
      has: page.getByRole('cell', { name: new RegExp(`^${team} `) }),
    });
    // Exactly one on each day: two practices, on different weekdays.
    await expect(teamRows).toHaveCount(2);
    await expect(teamRows.filter({ hasText: /Tuesday @ 17:00/ })).toHaveCount(1);
    await expect(teamRows.filter({ hasText: /Thursday @ 17:00/ })).toHaveCount(1);
  }
);

Then(
  'the panel says {string} has {int} of {int} practices',
  async ({ page }, team: string, have: number, target: number) => {
    await expect(
      page
        .getByRole('list', { name: 'Practices per team' })
        .getByText(`${team}: ${have} of ${target} practices`)
    ).toBeVisible();
  }
);

Then(
  "the panel says {string} has {int} of {int} practices because the division's slots fall on fewer weekdays",
  async ({ page }, team: string, have: number, target: number) => {
    await expect(
      page
        .getByRole('list', { name: 'Practices per team' })
        .getByText(
          `${team}: ${have} of ${target} practices (the division's slots fall on fewer weekdays than its practices a week)`
        )
    ).toBeVisible();
  }
);

Then(
  "the panel says {string} has {int} of {int} practices because no practice slot is exactly as long as the division's practice",
  async ({ page }, team: string, have: number, target: number) => {
    await expect(
      page
        .getByRole('list', { name: 'Practices per team' })
        .getByText(
          `${team}: ${have} of ${target} practices (no practice slot is exactly as long as the division's practice)`
        )
    ).toBeVisible();
  }
);

// --- The capacity panel (schedule expansion, PR 13) ---
//
// "Before you run: slots against what each division needs" reads the saved teams (the roster), the
// division's settings, the practice slots and the saved practices, and compares them before any run.
// The saved teams are seeded into the mock's `teams` table here: the run's roster, which the steps
// above seed into the latest team run, is the solver's input and not what the panel reads.

const capacityRow = (page: Page, division: string) =>
  page
    .getByTestId('capacity-row')
    .filter({ has: page.getByRole('heading', { name: division, exact: true }) });

/**
 * The value of one labelled figure of a division's card ("Held", "Verdict (upper bound)"). The label
 * is matched as exact text, not as a pattern built from it: "Held" must not match a longer label,
 * and nothing in it needs escaping.
 */
const capacityFigure = (row: ReturnType<typeof capacityRow>, label: string) =>
  row
    .locator('dl > div')
    .filter({ has: row.page().locator('dt').getByText(label, { exact: true }) })
    .locator('dd');

Given('these saved teams in {string}:', async ({ page }, division: string, table: DataTable) => {
  const names = table.hashes().map((row) => row.team);
  await waitForMockClient(page);
  await page.evaluate(
    ({ division, names, mockOrgId }) => {
      const db = window.__MOCK_DB__ as unknown as MockDb | undefined;
      if (!db) throw new Error('mock store not initialised');
      const orgId = localStorage.getItem('squadlogic_active_org') || mockOrgId;
      const found = (db.divisions ?? []).find(
        (row) => row.organization_id === orgId && row.name === division
      );
      if (!found) throw new Error(`no division named ${division}`);
      const slug = (name: string) => name.trim().toLowerCase().replace(/\s+/g, '-');
      db.teams = [
        ...(db.teams ?? []).filter((row) => !names.some((name) => row.id === `cap-${slug(name)}`)),
        ...names.map((name) => ({
          id: `cap-${slug(name)}`,
          name,
          division_id: found.id,
          organization_id: orgId,
        })),
      ];
      window.__saveMockDB__(db);
    },
    { division, names, mockOrgId: MOCK_ORG_ID }
  );
});

When('I look at the Practice Scheduling page', async ({ page }) => {
  await page.goto('/schedule/practice');
  await expect(
    page.getByRole('heading', { name: 'Before you run: slots against what each division needs' })
  ).toBeVisible({ timeout: 15000 });
});

Then(
  'the capacity panel row for {string} says:',
  async ({ page }, division: string, table: DataTable) => {
    const row = capacityRow(page, division);
    // The panel is its own chunk and reads four tables: wait for it to have drawn the division.
    await expect(row).toBeVisible({ timeout: 20000 });
    const [expected] = table.hashes();
    for (const [label, text] of Object.entries(expected)) {
      await expect(capacityFigure(row, label), `${division}: ${label}`).toHaveText(text);
    }
  }
);

Then(
  'the capacity panel verdict for {string} says {string}',
  async ({ page }, division: string, text: string) => {
    await expect(
      capacityFigure(capacityRow(page, division), 'Verdict (upper bound)')
    ).toContainText(text, { timeout: 20000 });
  }
);

Then('the capacity panel says what its figures are based on', async ({ page }) => {
  await expect(page.getByTestId('capacity-basis')).toContainText(
    'These figures are based on every open practice slot a division may use, live from today'
  );
});

Then(
  'the capacity panel says that times held outside the app are unknown to it',
  async ({ page }) => {
    await expect(page.getByTestId('capacity-held-outside')).toHaveText(
      'Times held outside the app are unknown to this panel.'
    );
  }
);

Then('the capacity panel says that every verdict is an upper bound', async ({ page }) => {
  await expect(page.getByTestId('capacity-upper-bound')).toContainText(
    'Each verdict is an upper bound'
  );
  await expect(page.getByText('Verdict (upper bound)').first()).toBeVisible();
});

/** The WCAG 2.0, 2.1 and 2.2 A and AA rules, as tests/e2e/steps/accessibility.ts scans them. */
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'];

Then(
  'axe finds no serious or critical violations in the capacity panel in the {string} theme',
  async ({ page }, theme: string) => {
    if (theme === 'dark') await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    else await expect(page.locator('html')).not.toHaveAttribute('data-theme', 'dark');
    // The scan must see the drawn cards: a panel still saying "not checked yet" would pass it.
    await expect(page.getByTestId('capacity-list')).toBeVisible({ timeout: 20000 });
    // Finite entrance animations settle first: axe measures colours as drawn.
    await page.evaluate(() =>
      Promise.all(
        document
          .getAnimations()
          .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
          .map((a) => a.finished.catch(() => undefined))
      )
    );
    const results = await new AxeBuilder({ page })
      .include('[data-testid="capacity-panel"]')
      .withTags(WCAG_TAGS)
      .analyze();
    // A scan that checked nothing proves nothing.
    expect(
      results.passes.length,
      'axe passed no rule on the capacity panel: did it render?'
    ).toBeGreaterThan(5);
    const blocking = results.violations
      .filter((v) => v.impact === 'serious' || v.impact === 'critical')
      .flatMap((v) =>
        v.nodes.map((n) => `[${v.impact}] ${v.id} at ${n.target.join(' ')}\n    ${n.html}`)
      );
    expect(
      blocking,
      `serious or critical axe violations in the capacity panel (${theme}):\n${blocking.join('\n')}`
    ).toEqual([]);
  }
);
