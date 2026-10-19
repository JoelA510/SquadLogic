import { createBdd } from 'playwright-bdd';
import { expect, type Page } from '@playwright/test';
import { waitForMockClient } from './mockReady.js';
import { MOCK_ORG_ID } from '../../../frontend/src/lib/mockSeedIds.js';

const { Given, Then } = createBdd();

// TG-3, the DST-boundary journey (Pillar1_Engine.feature). Given steps seed
// slot INPUTS only; the Then steps read the page's own banner and review
// table. The seeded season's zone is America/Los_Angeles
// (tests/e2e/steps/edgeAutoSchedulerRoute.ts, SEASON_TIMEZONE), whose clocks
// went forward on 2026-03-08: 02:00 became 03:00, so 02:30 never happened.

type MockRow = Record<string, unknown>;
type MockDb = Record<string, MockRow[] | undefined>;

/** `YYYY-MM-DD`, `days` from today (UTC). */
const isoFromToday = (days: number) =>
  new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);

/** Replace the seeded practice slots with the scenario's own (the seed's are dated 2025). */
async function seedPracticeSlot(page: Page, slot: MockRow) {
  await waitForMockClient(page);
  await page.evaluate(
    ({ slot, mockOrgId }) => {
      const db = window.__MOCK_DB__ as MockDb | undefined;
      if (!db) throw new Error('mock store not initialised');
      const orgId = localStorage.getItem('squadlogic_active_org') || mockOrgId;
      db.practice_slots = [
        ...(db.practice_slots ?? []).filter((s) => s.id !== slot.id),
        { ...slot, organization_id: orgId },
      ];
      window.__saveMockDB__(db);
    },
    { slot, mockOrgId: MOCK_ORG_ID }
  );
}

Given('a Thursday practice slot at 17:00 with room for one team', async ({ page }) => {
  await seedPracticeSlot(page, {
    id: 'dst-thu',
    day_of_week: 'thu',
    start_time: '17:00',
    end_time: '18:30',
    capacity: 1,
    valid_from: isoFromToday(-30),
    valid_until: isoFromToday(90),
    field_id: 'v1',
  });
});

Given('a Sunday practice slot at 02:30 on the night the clocks go forward', async ({ page }) => {
  await seedPracticeSlot(page, {
    id: 'dst-sun-gap',
    day_of_week: 'sun',
    start_time: '02:30',
    end_time: '03:30',
    capacity: 1,
    // The slot's first Sunday is the spring-forward Sunday: the date is fixed
    // (a calendar fact), not relative to the run date.
    valid_from: '2026-03-08',
    valid_until: '2026-06-01',
    field_id: 'v2',
  });
});

Then(
  'the page shows {int} practice slot(s) as TIME TBD because daylight saving skips its hour',
  async ({ page }, count: number) => {
    await expect(
      page.getByText(
        new RegExp(
          `${count} slot${count === 1 ? '' : 's'} shown as TIME TBD \\(WALL_TIME_NONEXISTENT\\): daylight saving skips`
        )
      )
    ).toBeVisible();
  }
);

Then(
  'the TIME TBD slot is named as {word} at {word}',
  async ({ page }, date: string, time: string) => {
    await expect(page.getByText(`(${date} ${time}`)).toBeVisible();
  }
);

Then('nothing is placed on the Sunday that has no 02:30', async ({ page }) => {
  const rows = page
    .getByRole('table')
    .filter({ has: page.getByRole('columnheader', { name: 'Field Slot' }) })
    .getByRole('row')
    .filter({ has: page.getByRole('cell') });
  // Meta-assertion: the review lists the Thursday placement, so a Sunday count
  // of zero is read from a table that has rows.
  await expect(rows.filter({ hasText: /Thursday @ 17:00/ })).toHaveCount(1);
  await expect(rows.filter({ hasText: /Sunday/ })).toHaveCount(0);
});
