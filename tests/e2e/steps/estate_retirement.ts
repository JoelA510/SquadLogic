import { createBdd } from 'playwright-bdd';
import { expect } from '@playwright/test';

const { Given, When, Then } = createBdd();

/**
 * 8.4 gap B part 2's two UI paths, driven through the shipped app.
 *
 * **Every assertion is a DOM assertion.** Nothing here reads `__MOCK_DB__` back
 * to decide whether a step passed. The only place the mock database is touched
 * is the seeding steps, and those go through `window.__saveMockDB__` -- the
 * sanctioned producer, which applies the tombstone lift
 * `tests/mockDeleteTombstones.test.js` pins.
 *
 * **The containment assertion is the reason this file exists.** A venue
 * retirement writes `locations.effective_to` and copies nothing down, so the
 * pitches at a closed site are retired by CONTAINMENT, resolved on read. The
 * only honest end-to-end statement of that is: the venue shows a date and its
 * pitches show none. An implementation that copied the date down satisfies
 * every count in the preview and fails exactly one step -- the one that reads
 * the pitch cards after the commit.
 *
 * **The pitches are enumerated from the SEED, not from the page.** A pitch the
 * page dropped is a missing card, not an absent expectation; deriving the list
 * from what rendered would make a dropped pitch pass silently, which is the
 * shape the Phase 2 review found comparing a set against itself.
 */

const VENUE_ID = 'loc-estate-e2e';
const PITCH_A = 'field-estate-e2e-a';
const PITCH_B = 'field-estate-e2e-b';
const SUB_A = 'subunit-estate-e2e-a';
const SUB_B = 'subunit-estate-e2e-b';

/** The pitch names the seed plants, which every containment step walks. */
const SEEDED_PITCHES = ['Maplewood North', 'Maplewood South'];

type Seed = { venueName: string; halves: boolean; booked: boolean };

async function seedEstate(page, { venueName, halves, booked }: Seed) {
  if (page.url() === 'about:blank') await page.goto('/');
  await page.evaluate(
    ({ vName, withHalves, withBooking, ids, pitchNames }) => {
      const db = JSON.parse(
        sessionStorage.getItem('__MOCK_DB__') || JSON.stringify(window.__MOCK_DB__ || {})
      );
      const orgId = localStorage.getItem('squadlogic_active_org') || 'org-1';

      db.locations = (db.locations || []).filter((l) => l.id !== ids.venue);
      db.locations.push({
        id: ids.venue,
        name: vName,
        organization_id: orgId,
        effective_to: null,
      });

      db.fields = (db.fields || []).filter((f) => f.id !== ids.pitchA && f.id !== ids.pitchB);
      db.fields.push({
        id: ids.pitchA,
        name: pitchNames[0],
        location_id: ids.venue,
        organization_id: orgId,
        active: true,
        supports_halves: withHalves,
        surface_type: 'Grass',
        size: '11v11',
        priority_rating: 1,
        effective_to: null,
      });
      db.fields.push({
        id: ids.pitchB,
        name: pitchNames[1],
        location_id: ids.venue,
        organization_id: orgId,
        active: true,
        supports_halves: false,
        surface_type: 'Grass',
        size: '11v11',
        priority_rating: 1,
        effective_to: null,
      });

      db.field_subunits = (db.field_subunits || []).filter(
        (s) => s.id !== ids.subA && s.id !== ids.subB
      );
      if (withHalves) {
        db.field_subunits.push({
          id: ids.subA,
          organization_id: orgId,
          field_id: ids.pitchA,
          label: 'North A',
          effective_to: null,
        });
        db.field_subunits.push({
          id: ids.subB,
          organization_id: orgId,
          field_id: ids.pitchA,
          label: 'North B',
          effective_to: null,
        });
      }

      // A practice running past the retirement date under test, so the
      // BOOKINGS half of the consequence is non-empty and the two halves can
      // be told apart on screen.
      db.practice_slots = (db.practice_slots || []).filter(
        (s) => s.field_id !== ids.pitchA && s.field_id !== ids.pitchB
      );
      if (withBooking) {
        db.practice_slots.push({
          id: 'ps-estate-e2e',
          organization_id: orgId,
          field_id: ids.pitchB,
          day_of_week: 'wed',
          start_time: '16:00:00',
          end_time: '17:00:00',
          capacity: 1,
          valid_from: '2026-08-01',
          valid_until: '2026-11-30',
        });
      }

      window.__saveMockDB__(db);
    },
    {
      vName: venueName,
      withHalves: halves,
      withBooking: booked,
      ids: { venue: VENUE_ID, pitchA: PITCH_A, pitchB: PITCH_B, subA: SUB_A, subB: SUB_B },
      pitchNames: SEEDED_PITCHES,
    }
  );
}

Given(
  'a venue {string} holds two pitches and a booked practice',
  async ({ page }, venueName: string) => {
    await seedEstate(page, { venueName, halves: false, booked: true });
  }
);

Given(
  'a venue {string} holds a pitch split into two halves',
  async ({ page }, venueName: string) => {
    await seedEstate(page, { venueName, halves: true, booked: false });
  }
);

/* -- opening the dialog at each depth ------------------------------------ */

When('I click the retire control for the venue {string}', async ({ page }, venueName: string) => {
  const control = page.getByRole('button', { name: `Retire ${venueName}` });
  await expect(control).toBeVisible();
  await control.click();
});

When('I click the retire control for the sub-surface {string}', async ({ page }, label: string) => {
  // The accessible name carries the PARENT too, because "North A" alone is
  // ambiguous across pitches and an operator reading it by screen reader
  // would have no way to tell two halves apart.
  const control = page.getByRole('button', {
    name: `Retire ${label} of ${SEEDED_PITCHES[0]}`,
  });
  await expect(control).toBeVisible();
  await control.click();
});

Then('the retirement dialog should be addressed to a venue', async ({ page }) => {
  await expect(page.getByRole('dialog')).toBeVisible();
  // Found through the LABEL, so a broken `htmlFor` fails the scenario rather
  // than being papered over by a css selector.
  await expect(page.getByLabel(/Last day this venue is usable/)).toBeVisible();
  await expect(page.getByText(/closes with it, by containment/i)).toBeVisible();
});

Then('the retirement dialog should be addressed to a sub-surface', async ({ page }) => {
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByLabel(/Last day this sub-surface is usable/)).toBeVisible();
});

Then('the retirement dialog should offer no containment', async ({ page }) => {
  // A sub-surface is the leaf of the estate. "Nothing below" and "nobody
  // looked" must not render the same, and at this depth the honest rendering
  // is nothing at all.
  await expect(page.getByText(/closes with it, by containment/i)).toHaveCount(0);
  await expect(page.getByTestId('consequence-contained')).toHaveCount(0);
});

When('I set the venue retirement end date to {string}', async ({ page }, date: string) => {
  const input = page.getByLabel(/Last day this venue is usable/);
  await expect(input).toBeVisible();
  await input.fill(date);
});

When('I set the sub-surface retirement end date to {string}', async ({ page }, date: string) => {
  const input = page.getByLabel(/Last day this sub-surface is usable/);
  await expect(input).toBeVisible();
  await input.fill(date);
});

/* -- the two halves of the consequence ----------------------------------- */

Then('the consequence preview should list the ground the venue contains', async ({ page }) => {
  const table = page.getByTestId('contained-rows');
  await expect(table).toBeVisible();
  // **Walked from the SEED.** A pitch the preview dropped is a missing row
  // here, not an expectation that quietly went away.
  for (const pitch of SEEDED_PITCHES) {
    await expect(table.getByText(pitch, { exact: true })).toBeVisible();
  }
  // Ground, not bookings: the effect column says what closes rather than what
  // happens to a booking.
  await expect(table.getByText(/closes with the venue/i).first()).toBeVisible();
});

Then('the contained ground should not be listed as bookings', async ({ page }) => {
  // **The failure this step exists for**: rendering containment as though it
  // were a booking list. The bookings table must hold exactly the bookings the
  // RPC reported -- one practice slot -- and no pitch row.
  const bookings = page.getByTestId('consequence-rows');
  await expect(bookings).toBeVisible();
  await expect(bookings.getByRole('row')).toHaveCount(2); // header + one booking
  await expect(bookings.getByTestId('consequence-row-practice_slot')).toBeVisible();
  for (const pitch of SEEDED_PITCHES) {
    await expect(bookings.getByText(pitch, { exact: true })).toHaveCount(0);
  }
});

/* -- after the commit ---------------------------------------------------- */

Then('{string} should not yet show a retirement date', async ({ page }, name: string) => {
  await expect(page.getByTestId(`venue-retired-${VENUE_ID}`)).toHaveCount(0);
  await expect(page.getByRole('dialog')).toBeVisible();
  expect(name.length).toBeGreaterThan(0);
});

Then(
  'the venue {string} should show a retirement date of {string}',
  async ({ page }, venueName: string, date: string) => {
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const row = page.getByTestId(`venue-${VENUE_ID}`);
    await expect(row).toContainText(venueName);
    await expect(row).toContainText(`Retires after ${date}`);
    // The control flips to the one that clears it, which is the whole point of
    // an end date rather than a delete.
    await expect(
      page.getByRole('button', { name: `Clear the end date on ${venueName}` })
    ).toBeVisible();
  }
);

Then(
  'no pitch at {string} should carry a retirement date of its own',
  async ({ page }, venueName: string) => {
    // **THE containment assertion.** Enumerated from the seed, so a pitch the
    // page dropped fails the `toBeVisible` rather than passing by absence --
    // which is what a check reading only `retired-*` testids would have done.
    for (const pitch of SEEDED_PITCHES) {
      const card = page.getByRole('heading', { name: pitch, exact: true });
      await expect(card).toBeVisible();
    }
    await expect(page.getByTestId(`retired-${PITCH_A}`)).toHaveCount(0);
    await expect(page.getByTestId(`retired-${PITCH_B}`)).toHaveCount(0);
    expect(venueName.length).toBeGreaterThan(0);
  }
);

When('I clear the end date on the venue {string}', async ({ page }, venueName: string) => {
  const control = page.getByRole('button', { name: `Clear the end date on ${venueName}` });
  await expect(control).toBeVisible();
  await control.click();
});

Then('the venue {string} should show no retirement date', async ({ page }, venueName: string) => {
  await expect(page.getByTestId(`venue-retired-${VENUE_ID}`)).toHaveCount(0);
  await expect(page.getByRole('button', { name: `Retire ${venueName}` })).toBeVisible();
});

Then(
  'the sub-surface {string} should show a retirement date of {string}',
  async ({ page }, label: string, date: string) => {
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const id = label === 'North A' ? SUB_A : SUB_B;
    const row = page.getByTestId(`subunit-${id}`);
    await expect(row).toContainText(label);
    await expect(page.getByTestId(`subunit-retired-${id}`)).toContainText(date);
  }
);

Then('the sub-surface {string} should show no retirement date', async ({ page }, label: string) => {
  const id = label === 'North A' ? SUB_A : SUB_B;
  // The sibling half is untouched: retiring one half is not retiring the pair.
  await expect(page.getByTestId(`subunit-${id}`)).toContainText(label);
  await expect(page.getByTestId(`subunit-retired-${id}`)).toHaveCount(0);
});
