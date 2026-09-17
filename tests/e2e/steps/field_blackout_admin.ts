import { createBdd } from 'playwright-bdd';
import { expect } from '@playwright/test';

const { Given, When, Then } = createBdd();

/**
 * 8.4 PR 3's two acceptance criteria, driven through the shipped UI.
 *
 * **Every assertion is a DOM assertion.** Nothing here reads `__MOCK_DB__` back
 * to decide whether a step passed: that is the E2E rule this suite carries, and
 * it is what keeps these scenarios honest about what an operator can see. The
 * only place the mock database is touched is the seeding steps, and those go
 * through `window.__saveMockDB__` -- the sanctioned producer, which applies the
 * tombstone lift `tests/mockDeleteTombstones.test.js` pins.
 *
 * **2026-09-16 is a Wednesday**, which is why the seeded practice slot is a
 * Wednesday one: the closure has to land on a date the recurring slot actually
 * recurs on, or the second scenario would pass for the wrong reason.
 */

const SEED_DATE = '2026-09-16';

type Seed = { fieldName: string; locationName: string; withGame: boolean };

async function seedGround(page, { fieldName, locationName, withGame }: Seed) {
  if (page.url() === 'about:blank') await page.goto('/');
  await page.evaluate(
    ({ fName, lName, game, date }) => {
      const db = JSON.parse(
        sessionStorage.getItem('__MOCK_DB__') || JSON.stringify(window.__MOCK_DB__ || {})
      );
      const orgId = localStorage.getItem('squadlogic_active_org') || 'org-1';
      const locationId = 'loc-blackout-test';
      const fieldId = 'field-blackout-test';

      db.locations = (db.locations || []).filter((l) => l.id !== locationId);
      db.locations.push({ id: locationId, name: lName, organization_id: orgId });

      db.fields = (db.fields || []).filter((f) => f.id !== fieldId);
      db.fields.push({
        id: fieldId,
        name: fName,
        location_id: locationId,
        organization_id: orgId,
        active: true,
        supports_halves: false,
        surface_type: 'Grass',
        size: '11v11',
        priority_rating: 1,
        effective_to: null,
      });

      // A Wednesday practice that runs past the retirement date under test.
      db.practice_slots = (db.practice_slots || []).filter((s) => s.field_id !== fieldId);
      db.practice_slots.push({
        id: 'ps-blackout-test',
        organization_id: orgId,
        field_id: fieldId,
        day_of_week: 'wed',
        start_time: '16:00:00',
        end_time: '17:00:00',
        capacity: 1,
        valid_from: '2026-08-01',
        valid_until: '2026-11-30',
      });

      db.game_slots = (db.game_slots || []).filter((s) => s.field_id !== fieldId);
      if (game) {
        db.game_slots.push({
          id: 'gs-blackout-test',
          organization_id: orgId,
          field_id: fieldId,
          slot_date: date,
          start_time: '16:00:00',
          end_time: '17:00:00',
          week_index: 1,
        });
      }

      // **`field_blackouts` is deliberately NOT touched here.** The mock seed
      // starts it empty and `tests/fieldBlackoutFreeze.test.js` pins the exact
      // set of files that write it -- a seeding step clearing the table would
      // make this file a writer of it by that check's definition, which is the
      // right answer: nothing outside the RPCs should write it, test or not.
      // The scenario asserts the grid is empty as its first step instead, which
      // is a stronger statement anyway because it is what the operator sees.

      window.__saveMockDB__(db);
    },
    { fName: fieldName, lName: locationName, game: withGame, date: SEED_DATE }
  );
}

Given(
  'a field {string} at {string} holds a booked practice',
  async ({ page }, fieldName: string, locationName: string) => {
    await seedGround(page, { fieldName, locationName, withGame: false });
  }
);

Given(
  'a field {string} at {string} holds a booked game and practice',
  async ({ page }, fieldName: string, locationName: string) => {
    await seedGround(page, { fieldName, locationName, withGame: true });
  }
);

/* -- retirement ---------------------------------------------------------- */

When('I click the "Retire" button for {string}', async ({ page }, fieldName: string) => {
  const control = page.getByRole('button', { name: `Retire ${fieldName}` });
  await expect(control).toBeVisible();
  await control.click();
});

When('I set the retirement end date to {string}', async ({ page }, date: string) => {
  // Found through its LABEL, so a broken `htmlFor` fails the scenario rather
  // than being papered over by a css selector.
  const input = page.getByLabel(/Last day this ground is usable/);
  await expect(input).toBeVisible();
  await input.fill(date);
});

Then(
  'I should see a consequence preview naming {int} affected booking',
  async ({ page }, count: number) => {
    const preview = page.getByTestId('consequence-preview');
    await expect(preview).toBeVisible();
    await expect(preview).toContainText(`${count} booking`);
    // The affected row itself, not just the count: a count with no list is the
    // shape a digest-only refusal would have.
    await expect(page.getByTestId('consequence-row-practice_slot')).toBeVisible();
  }
);

Then('the consequence preview should name the missing repair engine', async ({ page }) => {
  const panel = page.getByTestId('repair-proposal-unavailable');
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute('data-reason-code', 'REPAIR_PROPOSAL_UNAVAILABLE');
});

Then('{string} should not yet show a retirement date', async ({ page }, fieldName: string) => {
  // The refusal must not have written anything. Scoped to the card behind the
  // dialog rather than to the whole page, so the dialog's own copy cannot
  // satisfy it.
  await expect(page.getByText(`Retires after`)).toHaveCount(0);
  // `exact`, because the open dialog's own title is `Retire <field>`.
  await expect(page.getByRole('heading', { name: fieldName, exact: true })).toBeVisible();
});

Then(
  '{string} should show a retirement date of {string}',
  async ({ page }, fieldName: string, date: string) => {
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByText(`Retires after ${date}`)).toBeVisible();
    // And the control flips to the one that clears it, which is the whole
    // point of an end date rather than a delete.
    await expect(
      page.getByRole('button', { name: `Clear the end date on ${fieldName}` })
    ).toBeVisible();
  }
);

/* -- blackouts ----------------------------------------------------------- */

Then('the blackout grid should be empty', async ({ page }) => {
  await expect(page.getByText(/No closures on file/)).toBeVisible();
});

When(
  'I add an all-day blackout on {string} from {string} to {string}',
  async ({ page }, fieldName: string, from: string, until: string) => {
    await page.getByRole('button', { name: 'Add blackout' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();

    await page.getByLabel('What does this close?').selectOption({ label: 'One field' });
    await page.getByLabel(/^Field/).selectOption({ label: fieldName });
    await page.getByLabel(/^First day/).fill(from);
    await page.getByLabel(/^Last day/).fill(until);
    // The default is all-day; assert it rather than clicking it, so a changed
    // default fails here instead of silently writing a timed window.
    await expect(page.getByLabel(/Closed all day/)).toBeChecked();
    await page.getByLabel('Reason').selectOption('maintenance');

    // The consequence, BEFORE the commit. This is the clause the plan names.
    await expect(page.getByTestId('blackout-consequence')).toContainText('would close 2 existing');

    await page.getByRole('button', { name: 'Save blackout' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  }
);

Then('the blackout grid should report {int} bookings closed', async ({ page }, count: number) => {
  const row = page.getByRole('row').filter({ hasText: 'Back Pitch' });
  await expect(row).toBeVisible();
  await expect(row).toContainText(String(count));
  await expect(row).toContainText('entered here');
});

When('I edit the blackout to cover {string} instead', async ({ page }, day: string) => {
  // The previous steps navigated away to the two schedule pages, so come back.
  await page.goto('/scheduling/blackouts');
  await page.waitForLoadState('networkidle');
  const edit = page.getByRole('button', { name: /^Edit the blackout on/ });
  await expect(edit).toBeVisible();
  await edit.click();

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Edit this blackout window');
  // It opened on the window that was there, not on a blank form.
  await expect(page.getByLabel(/^First day/)).toHaveValue('2026-09-16');
  // The ground cannot be changed by editing, and the dialog says so rather
  // than quietly ignoring a change.
  await expect(page.getByLabel('What does this close?')).toBeDisabled();

  // Both ends move: the window is a single day and it is moving off the 16th,
  // which is the date the game and the practice sit on.
  await page.getByLabel(/^First day/).fill(day);
  await page.getByLabel(/^Last day/).fill(day);
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

Then(
  'the blackout grid should hold exactly {int} window, moved to {string}',
  async ({ page }, count: number, day: string) => {
    // **The observable half of "an edit is an edit".** One row still, with the
    // new dates in it -- the count never went to two, and the window it points
    // at is the one that was already there. The id half is not visible on this
    // screen and is asserted at the unit, smoke, scenario and pgTAP levels.
    await expect(page.getByRole('button', { name: /^Edit the blackout on/ })).toHaveCount(count);
    const row = page.getByRole('row').filter({ hasText: 'Back Pitch' });
    await expect(row).toContainText(day);
    await expect(row).not.toContainText('2026-09-16');
  }
);

When('I remove the blackout from the blackout grid', async ({ page }) => {
  // The previous steps navigated away to the two schedule pages, so come back.
  await page.goto('/scheduling/blackouts');
  await page.waitForLoadState('networkidle');
  const remove = page.getByRole('button', { name: /^Remove the blackout on/ });
  await expect(remove).toBeVisible();
  await remove.click();
  await expect(page.getByText(/No closures on file/)).toBeVisible();
});

const SCHEDULE_ROUTE = { game: '/schedule/game', practice: '/schedule/practice' };

async function expectBlackoutBanner(page, which: 'game' | 'practice', present: boolean) {
  await page.goto(SCHEDULE_ROUTE[which]);
  await page.waitForLoadState('networkidle');
  const item = page.getByTestId('conflict-item-field-blackout');
  if (present) {
    await expect(item.first()).toBeVisible();
    await expect(item.first()).toContainText('blackout');
  } else {
    // **An absence assertion needs an anchor.** Waiting for the page itself to
    // be there first means "no conflict" cannot pass because nothing rendered.
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(item).toHaveCount(0);
  }
}

Then('the game schedule should show a blackout conflict', async ({ page }) => {
  await expectBlackoutBanner(page, 'game', true);
});

Then('the practice schedule should show a blackout conflict', async ({ page }) => {
  await expectBlackoutBanner(page, 'practice', true);
});

Then('the game schedule should show no blackout conflict', async ({ page }) => {
  await expectBlackoutBanner(page, 'game', false);
});

Then('the practice schedule should show no blackout conflict', async ({ page }) => {
  await expectBlackoutBanner(page, 'practice', false);
});
