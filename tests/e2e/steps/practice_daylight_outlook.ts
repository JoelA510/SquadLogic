import { createBdd } from 'playwright-bdd';
import { expect } from '@playwright/test';
import { waitForMockClient } from './mockReady.js';
import { MOCK_ORG_ID } from '../../../frontend/src/lib/mockSeedIds.js';

const { Given, When, Then } = createBdd();

/**
 * The read-only Practice daylight page (duration-phase wiring, PR B of
 * `docs/changes/2026-11-02-duration-phases-wiring.md`).
 *
 * **Seeded through `window.__saveMockDB__`** behind `waitForMockClient`, with `organization_id` on
 * every row, into a FRESH organization (as `practice_repair_panel.ts` does: the mock's default
 * location is not a uuid, and the adapter rightly refuses a snapshot holding one).
 *
 * Synthetic only: no real venue, club, person or coordinate. 40 / -75 are round numbers, the pair
 * `practice_repair_panel.ts` gives its venue. The season runs 2026-09-01 to 2026-11-30 in
 * America/New_York, so the page does not depend on today's date: a Tuesday 18:00 to 19:00 practice
 * is shortened from 22 Sep, started earlier from 6 Oct, and cannot be saved on 24 Nov.
 */
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const IDS = {
  season: uuid(2),
  division: uuid(3),
  venue: uuid(101),
  field: uuid(201),
  team: uuid(301),
  slot: uuid(501),
  assignment: uuid(601),
};

Given('a fresh organization is active for the practice daylight outlook', async ({ page }) => {
  if (page.url() === 'about:blank') await page.goto('/');
  await waitForMockClient(page);
  await page.evaluate((orgId) => {
    localStorage.setItem('squadlogic_active_org', orgId);
    localStorage.removeItem('squadlogic-current-season-id');
  }, uuid(1));
});

Given(
  '{string} holds a Tuesday 18:00 practice for {string} at a venue with no coordinates',
  async ({ page }, fieldName: string, teamName: string) => {
    if (page.url() === 'about:blank') await page.goto('/');
    await waitForMockClient(page);
    await page.evaluate(
      ({ field, team, ids, mockOrgId }) => {
        const db = JSON.parse(
          sessionStorage.getItem('__MOCK_DB__') || JSON.stringify(window.__MOCK_DB__ || {})
        );
        const orgId = localStorage.getItem('squadlogic_active_org') || mockOrgId;
        const others = (table: string) =>
          (db[table] || []).filter(
            (row: Record<string, unknown>) => String(row.organization_id) !== String(orgId)
          );
        db.season_settings = [
          ...(db.season_settings || []).filter((s: Record<string, unknown>) => s.id !== ids.season),
          {
            id: ids.season,
            organization_id: orgId,
            name: 'Daylight Season',
            status: 'active',
            season_start: '2026-09-01',
            season_end: '2026-11-30',
            timezone: 'America/New_York',
            school_day_end: '16:00',
            created_at: new Date().toISOString(),
          },
        ];
        db.divisions = [
          ...(db.divisions || []).filter((d: Record<string, unknown>) => d.id !== ids.division),
          { id: ids.division, organization_id: orgId, season_settings_id: ids.season },
        ];
        // No coordinates, and unlit: the page must say the sunset is unknown, not that it is fine.
        db.locations = [
          ...others('locations'),
          {
            id: ids.venue,
            name: 'Dusk Venue',
            organization_id: orgId,
            lighting_available: false,
            latitude: null,
            longitude: null,
          },
        ];
        db.fields = [
          ...others('fields'),
          {
            id: ids.field,
            name: field,
            location_id: ids.venue,
            organization_id: orgId,
            active: true,
            supports_halves: false,
            surface_type: 'Grass',
            size: '11v11',
            priority_rating: 1,
            effective_to: null,
          },
        ];
        db.field_subunits = others('field_subunits');
        db.practice_slots = [
          ...others('practice_slots'),
          {
            id: ids.slot,
            organization_id: orgId,
            field_id: ids.field,
            field_subunit_id: null,
            day_of_week: 'tue',
            start_time: '18:00:00',
            end_time: '19:00:00',
            capacity: 1,
            valid_from: '2026-09-01',
            valid_until: '2026-11-30',
          },
        ];
        db.teams = [
          ...(db.teams || []).filter((t: Record<string, unknown>) => t.id !== ids.team),
          { id: ids.team, name: team, division_id: ids.division, organization_id: orgId },
        ];
        db.practice_assignments = [
          ...others('practice_assignments'),
          {
            id: ids.assignment,
            organization_id: orgId,
            team_id: ids.team,
            practice_slot_id: ids.slot,
            slot_id: ids.slot,
            run_id: 'run-practice-daylight',
            source: 'auto',
            assigned_via: 'auto',
            effective_date_range: '[2026-09-01,2026-12-01)',
          },
        ];
        db.practice_lighting_overrides = others('practice_lighting_overrides');
        window.__saveMockDB__(db);
      },
      { field: fieldName, team: teamName, ids: IDS, mockOrgId: MOCK_ORG_ID }
    );
  }
);

// Set through the mock exactly as `practice_repair_panel.ts` does: synthetic round numbers, not a place.
When('the venue of that field is given coordinates through the mock', async ({ page }) => {
  await page.evaluate((ids) => {
    const db = JSON.parse(
      sessionStorage.getItem('__MOCK_DB__') || JSON.stringify(window.__MOCK_DB__ || {})
    );
    db.locations = db.locations.map((l: Record<string, unknown>) =>
      l.id === ids.venue ? { ...l, latitude: 40, longitude: -75 } : l
    );
    window.__saveMockDB__(db);
  }, IDS);
});

Then(
  'the practice daylight page says the sunset is unknown and points at the venue coordinates',
  async ({ page }) => {
    const message = page.getByTestId('daylight-no-coordinates');
    await expect(message).toBeVisible();
    await expect(message).toContainText('Sunset unknown');
    await expect(message).toContainText('No venue with unlit practices has coordinates');
    // Not a list of "unknown": nothing is drawn as fine, and no row at all.
    await expect(page.getByTestId('daylight-row')).toHaveCount(0);
    await expect(message.getByRole('link', { name: 'Fields & Venues' })).toHaveAttribute(
      'href',
      '/fields'
    );
  }
);

Then(
  'the practice daylight page lists {string} on {string} as past sunset from {string}',
  async ({ page }, title: string, field: string, firstDate: string) => {
    const row = page
      .getByTestId('daylight-row')
      .filter({ hasText: title })
      .filter({ hasText: field });
    await expect(row).toHaveCount(1);
    await expect(row.getByTestId('daylight-verdict')).toContainText('Flagged on 1 date');
    // The first date it goes dark as planned, and the proposed changes by date.
    await expect(row).toContainText(`As planned it would end past sunset from ${firstDate}`);
    await expect(row.getByTestId('daylight-phase').first()).toContainText(
      `From ${firstDate}: 50 min, 18:00 to 18:50`
    );
    // The date nothing saves is kept as scheduled and flagged, never refused or blocked.
    await expect(row.getByTestId('daylight-flagged-date')).toContainText('Tue 24 Nov');
    await expect(row.getByTestId('daylight-flagged-date')).toContainText(
      'kept as scheduled and flagged'
    );
    await expect(row).not.toContainText(/blocked|refused/i);
    await expect(page.getByTestId('daylight-banner')).toContainText('Proposed, not applied.');
  }
);

When('I open Practice Daylight from the side navigation', async ({ page }) => {
  await page.goto('/');
  const nav = page.getByRole('navigation', { name: 'Primary' });
  const link = nav.getByRole('link', { name: /Practice Daylight/ });
  await expect(link).toBeVisible({ timeout: 20_000 });
  // By keyboard, as a keyboard user would (WCAG 2.1.1).
  await link.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Practice daylight', level: 1 })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/schedule/practice-daylight');
});
