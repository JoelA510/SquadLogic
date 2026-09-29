import { createBdd } from 'playwright-bdd';
import { expect } from '@playwright/test';
import { waitForMockClient } from './mockReady.js';

const { Given, When, Then } = createBdd();

/**
 * 8.6 3b PR 10: the read-only practice repair recommendation panel.
 *
 * **Seeded through `window.__saveMockDB__`** behind `waitForMockClient`, with
 * `organization_id` on every row. The org's estate and season practices are
 * REPLACED by this seed, not added to: the repair adapter refuses a snapshot
 * with a location id that is not a uuid (the mock's defaults are not), and a
 * refusal is the panel's loud error, not the scenario under test.
 *
 * Synthetic only: no real venue, club, person or coordinate. No coordinates
 * at all, so the panel must say daylight was not checked.
 *
 * Repair Team A practises Wednesdays 16:00-17:00 on Repair Pitch 1, and
 * Repair Pitch 2 has a free Wednesday 16:00-17:00: it re-homes. Repair Team B
 * practises Thursdays 16:00-17:30, a length no other slot offers: TIME TBD.
 */
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/**
 * A FRESH organization, made active before `I have an organization labeled`
 * gives the admin its membership. The mock's default org holds a non-uuid
 * location that its seed re-merge brings back after any filter, and the
 * adapter rightly refuses a snapshot holding one; a fresh org holds only this
 * file's rows.
 */
Given('a fresh organization is active for the practice repair', async ({ page }) => {
  if (page.url() === 'about:blank') await page.goto('/');
  await waitForMockClient(page);
  await page.evaluate((orgId) => {
    localStorage.setItem('squadlogic_active_org', orgId);
    localStorage.removeItem('squadlogic-current-season');
  }, uuid(1));
});

Given(
  '{string} holds two practice series, one of a length nothing else offers',
  async ({ page }, fieldName: string) => {
    if (page.url() === 'about:blank') await page.goto('/');
    await waitForMockClient(page);
    await page.evaluate(
      ({ name, ids }) => {
        const db = JSON.parse(
          sessionStorage.getItem('__MOCK_DB__') || JSON.stringify(window.__MOCK_DB__ || {})
        );
        const orgId = localStorage.getItem('squadlogic_active_org') || 'org-1';
        // The org is fresh (see the step above), so nothing of it is replaced:
        // these only keep other orgs' rows.
        const others = (table) =>
          (db[table] || []).filter((row) => String(row.organization_id) !== String(orgId));
        db.season_settings = [
          ...(db.season_settings || []).filter((s) => s.id !== ids.season),
          {
            id: ids.season,
            organization_id: orgId,
            name: 'Repair Season',
            status: 'active',
            season_start: '2026-08-01',
            season_end: '2026-11-30',
            timezone: 'America/New_York',
            created_at: new Date().toISOString(),
          },
        ];
        const division = {
          id: ids.division,
          organization_id: orgId,
          season_settings_id: ids.season,
        };
        db.divisions = [...(db.divisions || []).filter((d) => d.id !== ids.division), division];

        db.locations = [
          ...others('locations'),
          { id: ids.loc, name: 'Repair Venue', organization_id: orgId, lighting_available: false },
        ];
        const field = (id, fieldLabel) => ({
          id,
          name: fieldLabel,
          location_id: ids.loc,
          organization_id: orgId,
          active: true,
          supports_halves: false,
          surface_type: 'Grass',
          size: '11v11',
          priority_rating: 1,
          effective_to: null,
        });
        db.fields = [...others('fields'), field(ids.f1, name), field(ids.f2, 'Repair Pitch 2')];
        db.field_subunits = others('field_subunits');
        const slot = (id, fieldId, day, start, end) => ({
          id,
          organization_id: orgId,
          field_id: fieldId,
          field_subunit_id: null,
          day_of_week: day,
          start_time: start,
          end_time: end,
          capacity: 1,
          valid_from: '2026-08-01',
          valid_until: '2026-11-30',
        });
        db.practice_slots = [
          ...others('practice_slots'),
          slot(ids.sl1, ids.f1, 'wed', '16:00:00', '17:00:00'),
          slot(ids.sl2, ids.f1, 'thu', '16:00:00', '17:30:00'),
          slot(ids.sl3, ids.f2, 'wed', '16:00:00', '17:00:00'),
        ];
        db.teams = [
          ...(db.teams || []).filter((t) => t.id !== ids.ta && t.id !== ids.tb),
          { id: ids.ta, name: 'Repair Team A', division_id: division?.id, organization_id: orgId },
          { id: ids.tb, name: 'Repair Team B', division_id: division?.id, organization_id: orgId },
        ];
        const assignment = (id, teamId, slotId) => ({
          id,
          organization_id: orgId,
          team_id: teamId,
          practice_slot_id: slotId,
          slot_id: slotId,
          run_id: 'run-repair-panel',
          source: 'auto',
          // The column's default (20260929000000): the enact prompt shows it.
          assigned_via: 'auto',
          effective_date_range: '[2026-09-01,2026-12-01)',
        });
        db.practice_assignments = [
          ...others('practice_assignments'),
          assignment(ids.a1, ids.ta, ids.sl1),
          assignment(ids.a2, ids.tb, ids.sl2),
        ];
        window.__saveMockDB__(db);
      },
      {
        name: fieldName,
        ids: {
          season: uuid(2),
          division: uuid(3),
          loc: uuid(101),
          f1: uuid(201),
          f2: uuid(202),
          sl1: uuid(501),
          sl2: uuid(502),
          sl3: uuid(503),
          ta: uuid(301),
          tb: uuid(302),
          a1: uuid(601),
          a2: uuid(602),
        },
      }
    );
  }
);

When(
  'I draft an all-day blackout on {string} from {string} to {string}',
  async ({ page }, fieldName: string, from: string, until: string) => {
    await page.getByRole('button', { name: 'Add blackout' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByLabel('What does this close?').selectOption({ label: 'One field' });
    await page.getByLabel(/^Field/).selectOption({ label: fieldName });
    await page.getByLabel(/^First day/).fill(from);
    await page.getByLabel(/^Last day/).fill(until);
    await expect(page.getByLabel(/Closed all day/)).toBeChecked();
    await expect(page.getByTestId('blackout-consequence')).toBeVisible();
  }
);

When('I open the practice repair recommendations', async ({ page }) => {
  const button = page.getByRole('button', { name: 'Show practice repair recommendations' });
  await expect(button).toBeVisible();
  // Keyboard, not a pointer: the panel must open without a drag or a mouse.
  await button.focus();
  await page.keyboard.press('Enter');
  // Its name changes to "Hide ..." once open, so it is re-found by its place.
  await expect(page.getByTestId('practice-repair-launcher').getByRole('button')).toHaveAttribute(
    'aria-expanded',
    'true'
  );
  await expect(page.getByTestId('practice-repair-panel')).toBeVisible();
});

Then(
  'the practice repair panel should list {int} displaced series-windows',
  async ({ page }, count: number) => {
    await expect(page.getByTestId('practice-repair-count')).toContainText(
      `${count} practice series-window`
    );
    await expect(page.getByTestId('practice-repair-window')).toHaveCount(count);
    await expect(page.getByTestId('practice-repair-error')).toHaveCount(0);
  }
);

const windowFor = (page, team: string) =>
  page.getByTestId('practice-repair-window').filter({ hasText: team });

Then(
  'the recommendation for {string} should be TIME TBD with a reason',
  async ({ page }, team: string) => {
    const tbd = windowFor(page, team).getByTestId('practice-repair-time-tbd');
    await expect(tbd).toBeVisible();
    await expect(tbd).toContainText('TIME TBD');
    await expect(tbd).toHaveAttribute('data-tbd-reason', /.+/);
  }
);

Then('the recommendation for {string} should be placed', async ({ page }, team: string) => {
  const row = windowFor(page, team);
  await expect(row.getByTestId('practice-repair-to')).toContainText('Repair Pitch 2');
  await expect(row.getByTestId('practice-repair-time-tbd')).toHaveCount(0);
});

Then('the practice repair panel should say daylight was not checked', async ({ page }) => {
  const finding = page
    .getByTestId('practice-repair-findings')
    .locator('[data-reason-code="PRACTICE_REPAIR_DAYLIGHT_UNCHECKED"]');
  await expect(finding).toBeVisible();
  await expect(finding).toHaveAttribute('data-severity', 'compromise');
});

Then('the practice repair panel should say it is locally repaired', async ({ page }) => {
  await expect(page.getByTestId('practice-repair-local')).toHaveAttribute(
    'data-reason-code',
    'PRACTICE_REPAIR_RECOMMENDATION_LOCAL'
  );
});

When('I decline the recommendation for {string}', async ({ page }, team: string) => {
  await page.getByRole('button', { name: `Decline the recommendation for ${team}` }).click();
});

When('I undo the decline for {string}', async ({ page }, team: string) => {
  await page
    .getByRole('button', { name: new RegExp(`^Undo the decline of .* for ${team}$`) })
    .click();
});

Then('every practice repair window should show why saving it is refused', async ({ page }) => {
  const rows = page.getByTestId('practice-repair-window');
  const count = await rows.count();
  expect(count).toBeGreaterThan(0);
  for (let i = 0; i < count; i += 1) {
    await expect(rows.nth(i).getByTestId('practice-repair-save-refused').first()).toBeVisible();
  }
});
