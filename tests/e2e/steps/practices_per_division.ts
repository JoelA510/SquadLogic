import { createBdd } from 'playwright-bdd';
import { expect, type Page } from '@playwright/test';
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
