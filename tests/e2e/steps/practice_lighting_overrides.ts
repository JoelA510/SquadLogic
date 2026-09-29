import { createBdd } from 'playwright-bdd';
import { expect } from '@playwright/test';
import { waitForMockClient } from './mockReady.js';

const { Given, When, Then } = createBdd();

/**
 * 8.9 D14 PR D: the lighting-override request form and approval queue.
 *
 * **Every assertion is a DOM assertion.** The seed step is the only place the
 * mock database is touched, through `window.__saveMockDB__`, and always with
 * `organization_id`. Which slot the coach coaches is fixed by the seed itself
 * (`SEED_SLOTS[].coachedByMockCoach`), so the picker check enumerates from the
 * seed and not from what the page rendered.
 *
 * Synthetic names only. `mock-coach-id` coaches team `t1` and `c2` coaches `t2`
 * in the base mock seed (`team_coach_assignments`).
 */

const SEED_SLOTS = [
  {
    id: 'ps-light-coach',
    team: 't1',
    day: 'tue',
    start: '18:00:00',
    end: '19:30:00',
    label: 'Tue 18:00–19:30 · Lantern Field',
    coachedByMockCoach: true,
  },
  {
    id: 'ps-light-other',
    team: 't2',
    day: 'wed',
    start: '17:00:00',
    end: '18:00:00',
    label: 'Wed 17:00–18:00 · Lantern Field',
    coachedByMockCoach: false,
  },
];

Given('practice slots with lighting overrides are seeded', async ({ page }) => {
  if (page.url() === 'about:blank') await page.goto('/');
  await waitForMockClient(page);
  await page.evaluate((slots) => {
    const db = JSON.parse(
      sessionStorage.getItem('__MOCK_DB__') || JSON.stringify(window.__MOCK_DB__ || {})
    );
    const orgId = localStorage.getItem('squadlogic_active_org') || 'org-1';
    const ids = new Set(slots.map((slot) => slot.id));
    db.fields = (db.fields || []).filter((f) => f.id !== 'field-lantern');
    db.fields.push({
      id: 'field-lantern',
      name: 'Lantern Field',
      organization_id: orgId,
      location_id: 'loc-1',
      active: true,
    });
    db.practice_slots = (db.practice_slots || []).filter((s) => !ids.has(s.id));
    db.practice_assignments = (db.practice_assignments || []).filter(
      (a) => !ids.has(a.practice_slot_id)
    );
    for (const slot of slots) {
      db.practice_slots.push({
        id: slot.id,
        organization_id: orgId,
        field_id: 'field-lantern',
        day_of_week: slot.day,
        start_time: slot.start,
        end_time: slot.end,
        capacity: 1,
        valid_from: '2026-08-01',
        valid_until: '2026-12-31',
      });
      db.practice_assignments.push({
        id: `pa-${slot.id}`,
        organization_id: orgId,
        team_id: slot.team,
        slot_id: slot.id,
        practice_slot_id: slot.id,
        day_of_week: slot.day,
        start_time: slot.start,
        end_time: slot.end,
      });
    }
    const row = (id, slotId, window, status, by) => ({
      id,
      organization_id: orgId,
      practice_slot_id: slotId,
      window,
      kind: 'portable-lighting',
      status,
      requested_by: by,
      requested_at: '2026-09-20T10:00:00.000Z',
      decided_by: status === 'approved' ? 'mock-admin-2' : null,
      decided_at: status === 'approved' ? '2026-09-21T10:00:00.000Z' : null,
      withdrawn_by: null,
      withdrawn_at: null,
    });
    db.practice_lighting_overrides = [
      row('lo-e2e-own', 'ps-light-other', '[2026-10-01,2026-10-04)', 'requested', 'mock-admin-id'),
      row(
        'lo-e2e-coach',
        'ps-light-coach',
        '[2026-10-05,2026-10-09)',
        'requested',
        'mock-coach-id'
      ),
      row('lo-e2e-clash', 'ps-light-coach', '[2026-10-07,2026-10-11)', 'approved', 'mock-admin-2'),
      row(
        'lo-e2e-admin',
        'ps-light-coach',
        '[2026-11-20,2026-11-22)',
        'requested',
        'mock-admin-id'
      ),
    ];
    window.__saveMockDB__(db);
  }, SEED_SLOTS);
});

When('I open the Practice Lighting page', async ({ page }) => {
  await page.goto('/schedule/practice-lighting');
  await expect(page.getByRole('heading', { name: 'Practice lighting' })).toBeVisible();
});

Then('the slot picker offers exactly the seeded slots I coach', async ({ page }) => {
  const picker = page.getByLabel('Practice slot');
  await expect(picker).toBeVisible();
  const coached = SEED_SLOTS.filter((slot) => slot.coachedByMockCoach);
  const notCoached = SEED_SLOTS.filter((slot) => !slot.coachedByMockCoach);
  // Meta: the seed holds both kinds, so neither half of the check is vacuous.
  expect(coached.length).toBeGreaterThan(0);
  expect(notCoached.length).toBeGreaterThan(0);
  for (const slot of coached) {
    await expect(picker.locator(`option[value="${slot.id}"]`)).toHaveCount(1);
  }
  for (const slot of notCoached) {
    await expect(picker.locator(`option[value="${slot.id}"]`)).toHaveCount(0);
  }
});

When(
  'I request lighting on {string} from {string} to {string}',
  async ({ page }, slotPrefix: string, from: string, until: string) => {
    const slot = SEED_SLOTS.find((s) => s.label.startsWith(slotPrefix));
    if (!slot) throw new Error(`No seeded slot starts with ${slotPrefix}`);
    await page.getByLabel('Practice slot').selectOption(slot.id);
    await page.getByLabel('First date').fill(from);
    await page.getByLabel('Last date (inclusive)').fill(until);
    await page.getByRole('button', { name: 'Request lighting override' }).click();
    await expect(page.getByTestId('lighting-action-status')).toBeFocused();
  }
);

const overrideRow = (page, from: string) =>
  page.getByRole('row').filter({ has: page.getByRole('cell', { name: from, exact: true }) });

Then(
  'my request from {string} shows as {string}',
  async ({ page }, from: string, status: string) => {
    const row = overrideRow(page, from).first();
    await expect(row).toBeVisible();
    await expect(row.getByText(status, { exact: true })).toBeVisible();
  }
);

Then('my request from {string} can be withdrawn', async ({ page }, from: string) => {
  await expect(overrideRow(page, from).getByRole('button', { name: /^Withdraw/ })).toHaveCount(1);
});

Then(
  'the request by another user from {string} cannot be withdrawn',
  async ({ page }, from: string) => {
    const row = overrideRow(page, from);
    await expect(row).toHaveCount(1);
    await expect(row.getByRole('button', { name: /^Withdraw/ })).toHaveCount(0);
  }
);

When(
  /^I withdraw (?:my request|the approved override) from "([^"]+)"$/,
  async ({ page }, from: string) => {
    const button = overrideRow(page, from).getByRole('button', { name: /^Withdraw/ });
    await expect(button).toBeEnabled();
    await button.click();
  }
);

Then(
  'the pending request from {string} cannot be decided by me, with the reason shown',
  async ({ page }, from: string) => {
    const row = page.getByTestId('lighting-pending-row').filter({
      has: page.getByRole('cell', { name: from, exact: true }),
    });
    await expect(row).toHaveCount(1);
    await expect(row.getByRole('button', { name: /^Approve/ })).toBeDisabled();
    await expect(row.getByRole('button', { name: /^Reject/ })).toBeDisabled();
    await expect(row.getByTestId('lighting-self-decide-reason')).toContainText(
      'You requested this'
    );
  }
);

Then('the no-lights-off note is shown beside the approve action', async ({ page }) => {
  await expect(page.getByTestId('lighting-no-lights-off-note')).toContainText('No lights-off time');
});

When('I approve the pending request from {string}', async ({ page }, from: string) => {
  const row = page.getByTestId('lighting-pending-row').filter({
    has: page.getByRole('cell', { name: from, exact: true }),
  });
  const approve = row.getByRole('button', { name: /^Approve/ });
  await expect(approve).toBeEnabled();
  await approve.click();
});

Then('I see the lighting overlap message', async ({ page }) => {
  const alert = page.getByTestId('lighting-action-error');
  await expect(alert).toBeVisible();
  await expect(alert).toHaveAttribute('role', 'alert');
  await expect(alert).toContainText('overlap a lighting override already approved');
});

Then('the approved override from {string} is listed', async ({ page }, from: string) => {
  await expect(
    page.getByTestId('lighting-approved-row').filter({
      has: page.getByRole('cell', { name: from, exact: true }),
    })
  ).toHaveCount(1);
});
