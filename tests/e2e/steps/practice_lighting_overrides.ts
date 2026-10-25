import { createBdd } from 'playwright-bdd';
import { expect } from '@playwright/test';
import { waitForMockClient } from './mockReady.js';
import { MOCK_ORG_ID } from '../../../frontend/src/lib/mockSeedIds.js';

const { Given, When, Then } = createBdd();

/**
 * 8.9 D14 PR D: the lighting-override approval queue. No coach requests
 * lighting since admin focus R6 (20261028010000): the coach request form and
 * its steps are gone, and the seeded requests stand for rows requested before
 * then.
 *
 * **Every assertion is a DOM assertion.** The seed step is the only place the
 * mock database is touched, through `window.__saveMockDB__`, and always with
 * `organization_id`.
 *
 * Synthetic names only. `mock-coach-id` coaches team `t1` and `c2` coaches `t2`
 * in the base mock seed (`team_coach_assignments`); the seed adds an ENDED
 * assignment of `mock-coach-id` to `t-light-ended`.
 */

const SEED_SLOTS = [
  {
    id: 'ps-light-coach',
    team: 't1',
    day: 'tue',
    start: '18:00:00',
    end: '19:30:00',
  },
  {
    id: 'ps-light-other',
    team: 't2',
    day: 'wed',
    start: '17:00:00',
    end: '18:00:00',
  },
  {
    // mock-coach-id coached this team only until 2026-02-01 (seeded below), so
    // the slot is NOT theirs today: the current-assignment half of the rule.
    id: 'ps-light-ended',
    team: 't-light-ended',
    day: 'thu',
    start: '16:00:00',
    end: '17:00:00',
  },
];

Given('practice slots with lighting overrides are seeded', async ({ page }) => {
  if (page.url() === 'about:blank') await page.goto('/');
  await waitForMockClient(page);
  await page.evaluate(
    ({ slots, mockOrgId }) => {
      const db = JSON.parse(
        sessionStorage.getItem('__MOCK_DB__') || JSON.stringify(window.__MOCK_DB__ || {})
      );
      const orgId = localStorage.getItem('squadlogic_active_org') || mockOrgId;
      const ids = new Set(slots.map((slot) => slot.id));
      db.fields = (db.fields || []).filter((f) => f.id !== 'field-lantern');
      db.fields.push({
        id: 'field-lantern',
        name: 'Lantern Field',
        organization_id: orgId,
        location_id: 'loc-1',
        active: true,
      });
      db.team_coach_assignments = (db.team_coach_assignments || []).filter(
        (a) => a.id !== 'tca-light-ended'
      );
      db.team_coach_assignments.push({
        id: 'tca-light-ended',
        organization_id: orgId,
        team_id: 't-light-ended',
        coach_id: 'mock-coach-id',
        role: 'lead',
        effective_from: '2026-01-01',
        effective_to: '2026-02-01',
        started_via: 'backfill',
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
        row(
          'lo-e2e-own',
          'ps-light-other',
          '[2026-10-01,2026-10-04)',
          'requested',
          'mock-admin-id'
        ),
        row(
          'lo-e2e-coach',
          'ps-light-coach',
          '[2026-10-05,2026-10-09)',
          'requested',
          'mock-coach-id'
        ),
        row(
          'lo-e2e-clash',
          'ps-light-coach',
          '[2026-10-07,2026-10-11)',
          'approved',
          'mock-admin-2'
        ),
        row(
          'lo-e2e-admin',
          'ps-light-coach',
          '[2026-11-20,2026-11-22)',
          'requested',
          'mock-admin-id'
        ),
      ];
      window.__saveMockDB__(db);
    },
    { slots: SEED_SLOTS, mockOrgId: MOCK_ORG_ID }
  );
});

When('I open the Practice Lighting page', async ({ page }) => {
  await page.goto('/schedule/practice-lighting');
  await expect(page.getByRole('heading', { name: 'Practice lighting' })).toBeVisible();
});

const overrideRow = (page, from: string) =>
  page.getByRole('row').filter({ has: page.getByRole('cell', { name: from, exact: true }) });

When(/^I withdraw the approved override from "([^"]+)"$/, async ({ page }, from: string) => {
  const button = overrideRow(page, from).getByRole('button', { name: /^Withdraw/ });
  await expect(button).toBeEnabled();
  await button.click();
});

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
  const alert = page.getByTestId('lighting-list-error');
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
