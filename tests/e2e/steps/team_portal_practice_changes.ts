import { createBdd } from 'playwright-bdd';
import { expect, type Page } from '@playwright/test';
import { waitForMockClient } from './mockReady.js';

const { Given, When, Then } = createBdd();

/**
 * 8.6 3b PR 12c: the team portal applies saved practice exceptions.
 *
 * One Monday series (2026-11-02 .. 2026-11-30) with two live exceptions:
 * the week of 11-09 moved to Thursday 11-12 at another ground, and Monday
 * 11-23 TIME TBD. All names are synthetic. Every row carries
 * `organization_id` (CLAUDE.md §8 rule 1), and the seed is written through
 * `window.__saveMockDB__`. Assertions read the DOM only.
 */
const SEED = {
  mondaySeries: '[2026-11-02,2026-12-01)',
  unchangedDate: '2026-11-16',
  movedDate: '2026-11-12',
  movedWindow: '[2026-11-09,2026-11-16)',
  tbdDate: '2026-11-23',
  tbdWindow: '[2026-11-23,2026-11-24)',
  tbdReason: 'contended',
  // PRACTICE_TBD_CAUSES.contended (packages/core/src/utils/practiceOccurrences.js).
  tbdWording: 'a field change left fewer practice slots than the teams that needed one',
  movedPlace: 'Sample Commons - Field B',
  movedTime: '18:15 - 19:15',
};

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

/** The one schedule card showing `text`. */
const cardWith = (page: Page, text: string | RegExp) =>
  page.locator('.glass-panel').filter({ hasText: text });

Given(
  'the {string} have a Monday practice with one week moved and one week TIME TBD',
  async ({ page }, teamName: string) => {
    await waitForMockClient(page);
    await page.evaluate(
      ({ team, seed }) => {
        const db = JSON.parse(sessionStorage.getItem('__MOCK_DB__') || '{}');
        const orgId = localStorage.getItem('squadlogic_active_org') || 'org-1';
        const teamId =
          localStorage.getItem('test_target_team_id') || team.toLowerCase().replace(/\s+/g, '-');
        const mine = (id: string) => (row: Record<string, unknown>) => row.id !== id;

        db.locations = (db.locations || []).filter(mine('loc-e2e-changes'));
        db.locations.push({
          id: 'loc-e2e-changes',
          organization_id: orgId,
          name: 'Sample Commons',
        });
        db.fields = (db.fields || []).filter(mine('field-e2e-b'));
        db.fields.push({
          id: 'field-e2e-b',
          organization_id: orgId,
          location_id: 'loc-e2e-changes',
          name: 'Field B',
        });
        db.practice_slots = (db.practice_slots || []).filter(
          (s: Record<string, unknown>) => s.id !== 'slot-e2e-mon' && s.id !== 'slot-e2e-thu'
        );
        db.practice_slots.push(
          {
            id: 'slot-e2e-mon',
            organization_id: orgId,
            day_of_week: 'mon',
            start_time: '17:00',
            end_time: '18:30',
          },
          {
            id: 'slot-e2e-thu',
            organization_id: orgId,
            field_id: 'field-e2e-b',
            day_of_week: 'thu',
            start_time: '18:15',
            end_time: '19:15',
          }
        );
        db.practice_assignments = (db.practice_assignments || []).filter(
          (a: Record<string, unknown>) => a.team_id !== teamId
        );
        db.practice_assignments.push({
          id: 'pa-e2e-mon',
          organization_id: orgId,
          team_id: teamId,
          practice_slot_id: 'slot-e2e-mon',
          effective_date_range: seed.mondaySeries,
        });
        const exception = (id: string, window: string, kind: string, extra: object) => ({
          id,
          organization_id: orgId,
          team_id: teamId,
          assignment_id: 'pa-e2e-mon',
          window,
          kind,
          practice_slot_id: null,
          tbd_reason: null,
          cause_kind: 'retirement',
          withdrawn_at: null,
          ...extra,
        });
        db.practice_exceptions = (db.practice_exceptions || []).filter(
          (e: Record<string, unknown>) => e.team_id !== teamId
        );
        db.practice_exceptions.push(
          exception('pe-e2e-move', seed.movedWindow, 'relocated', {
            practice_slot_id: 'slot-e2e-thu',
          }),
          exception('pe-e2e-tbd', seed.tbdWindow, 'time_tbd', { tbd_reason: seed.tbdReason })
        );
        window.__saveMockDB__(db);
      },
      { team: teamName, seed: SEED }
    );
  }
);

Then(
  'I should see the moved practice at its new time and place with one {string} line',
  async ({ page }, prefix: string) => {
    const card = cardWith(page, await longDate(page, SEED.movedDate));
    await expect(card).toHaveCount(1, { timeout: 15000 });
    await expect(card.getByRole('heading', { name: 'Practice (moved)' })).toBeVisible();
    await expect(card.getByText(SEED.movedTime)).toBeVisible();
    await expect(card.getByText(SEED.movedPlace)).toBeVisible();
    await expect(card.getByText(new RegExp(`^${prefix} Monday 17:00, `))).toHaveCount(1);
  }
);

Then('I should see the TIME TBD date with its reason', async ({ page }) => {
  const text = `Time TBD on ${await longDate(page, SEED.tbdDate)}: ${SEED.tbdWording}`;
  await expect(page.getByText(text, { exact: true })).toBeVisible({ timeout: 15000 });
});

Then('RSVP should be hidden on the TIME TBD date', async ({ page }) => {
  const card = cardWith(page, `Time TBD on ${await longDate(page, SEED.tbdDate)}`);
  await expect(card).toHaveCount(1, { timeout: 15000 });
  await expect(card.getByText('RSVP opens once a time is set')).toBeVisible();
  await expect(card.getByTitle('Going', { exact: true })).toHaveCount(0);
});

/*
 * 8.6 3b PR 12d: the moved practice takes an RSVP keyed on (assignment id,
 * new date). The mock RPC mirrors 20261005000000, so the button only turns
 * pressed if that rule ACCEPTED the new date; before 12d it refused it and the
 * button stayed unpressed. DOM assertions only.
 */
When('I mark my child as going to the moved practice', async ({ page }) => {
  const card = cardWith(page, await longDate(page, SEED.movedDate));
  await expect(card).toHaveCount(1, { timeout: 15000 });
  await expect(card.getByRole('heading', { name: 'Practice (moved)' })).toBeVisible();
  const going = card.getByTitle('Going', { exact: true });
  await expect(going).toHaveCount(1);
  await expect(going).toHaveAttribute('aria-pressed', 'false');
  await going.click();
});

Then('the moved practice should show my child as going', async ({ page }) => {
  const card = cardWith(page, await longDate(page, SEED.movedDate));
  await expect(card.getByTitle('Going', { exact: true })).toHaveAttribute('aria-pressed', 'true', {
    timeout: 15000,
  });
});

Then('RSVP should be open on an unchanged practice of the same series', async ({ page }) => {
  // The absence above is not vacuous: the same parent RSVPs the series.
  const card = cardWith(page, await longDate(page, SEED.unchangedDate));
  await expect(card).toHaveCount(1, { timeout: 15000 });
  await expect(card.getByTitle('Going', { exact: true })).toHaveCount(1);
});
