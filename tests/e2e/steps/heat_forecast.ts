import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createBdd } from 'playwright-bdd';
import { expect, type Page } from '@playwright/test';
import { waitForMockClient } from './mockReady.js';

const { Given, When, Then } = createBdd();

/**
 * Heat forecast E2E. The NWS API is stubbed with `page.route` -- the browser
 * never reaches api.weather.gov -- using the Python reference's offline
 * fixture, and the clock is fixed, so the rows are the reference's golden
 * values. The seed is the only place the mock database is touched, through
 * `window.__saveMockDB__`, always with `organization_id`.
 *
 * Venue coordinates are the reference's own public sites (school and park
 * grounds); the third venue is synthetic and has none.
 */

const VENUES = [
  {
    id: 'loc-heat-canyon',
    name: 'Canyon MS',
    lat: 37.7046,
    lon: -122.0524,
    field: 'Canyon Turf',
    surface: 'Turf',
  },
  {
    id: 'loc-heat-vannoy',
    name: 'Vannoy ES',
    lat: 37.7069,
    lon: -122.0587,
    field: 'Vannoy Grass',
    surface: 'Grass',
  },
  {
    id: 'loc-heat-nocoords',
    name: 'Parking Lot Pitch',
    lat: null,
    lon: null,
    field: 'Lot Field',
    surface: 'Grass',
  },
];

const GRIDPOINT = JSON.parse(
  readFileSync(
    path.join(process.cwd(), 'tests/fixtures/heat/gridpoint-mtr-2026-10-03.json'),
    'utf8'
  )
);

const CORS = { 'access-control-allow-origin': '*', 'content-type': 'application/geo+json' };

/** Points for which the stub answers 404 instead of a grid mapping. */
const refusedPoints = new WeakMap<Page, Set<string>>();

Given('the heat forecast is enabled with the reference venues seeded', async ({ page }) => {
  if (page.url() === 'about:blank') await page.goto('/');
  await waitForMockClient(page);
  await page.evaluate((venues) => {
    const db = JSON.parse(
      sessionStorage.getItem('__MOCK_DB__') || JSON.stringify(window.__MOCK_DB__ || {})
    );
    const orgId = localStorage.getItem('squadlogic_active_org') || 'org-1';
    const org = (db.organizations || []).find((o) => o.id === orgId);
    if (!org) throw new Error(`seed: organization ${orgId} is not in the mock db`);
    org.feature_flags = { ...(org.feature_flags || {}), heat_forecast: true };
    const ids = new Set(venues.map((v) => v.id));
    db.locations = (db.locations || []).filter((l) => !ids.has(l.id));
    db.fields = (db.fields || []).filter((f) => !ids.has(f.location_id));
    for (const v of venues) {
      db.locations.push({
        id: v.id,
        organization_id: orgId,
        name: v.name,
        latitude: v.lat,
        longitude: v.lon,
        effective_to: null,
      });
      db.fields.push({
        id: `field-${v.id}`,
        organization_id: orgId,
        location_id: v.id,
        name: v.field,
        surface_type: v.surface,
        active: true,
        effective_to: null,
      });
    }
    window.__saveMockDB__(db);
  }, VENUES);
});

Given('the NWS API is stubbed with the reference forecast', async ({ page }) => {
  refusedPoints.set(page, new Set());
  await page.route('https://api.weather.gov/points/**', async (route) => {
    const key = route.request().url().split('/points/')[1];
    if (refusedPoints.get(page)?.has(key)) {
      await route.fulfill({
        status: 404,
        headers: { ...CORS, 'content-type': 'application/problem+json' },
        body: JSON.stringify({
          type: 'https://api.weather.gov/problems/InvalidPoint',
          title: 'Data Unavailable For Requested Point',
          status: 404,
          detail: `Unable to provide data for requested point ${key}`,
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      headers: CORS,
      body: JSON.stringify({
        properties: {
          gridId: 'MTR',
          gridX: 97,
          gridY: 99,
          forecastGridData: 'https://api.weather.gov/gridpoints/MTR/97,99',
        },
      }),
    });
  });
  await page.route('https://api.weather.gov/gridpoints/**', (route) =>
    route.fulfill({ status: 200, headers: CORS, body: JSON.stringify(GRIDPOINT) })
  );
});

Given('the NWS API refuses the point for {string} with a 404', async ({ page }, name: string) => {
  const v = VENUES.find((x) => x.name === name);
  if (!v || v.lat === null || v.lon === null) throw new Error(`no stubbable venue ${name}`);
  refusedPoints.get(page)?.add(`${v.lat.toFixed(4)},${v.lon.toFixed(4)}`);
});

Given('the browser clock reads {string}', async ({ page }, iso: string) => {
  await page.clock.setFixedTime(new Date(iso));
});

When('I open the Heat Forecast page', async ({ page }) => {
  await page.goto('/schedule/heat');
  await expect(page.getByRole('heading', { name: 'Heat forecast', level: 1 })).toBeVisible();
});

const row = (page: Page, venue: string, time: string) =>
  page
    .getByTestId('heat-row')
    .filter({ has: page.getByRole('rowheader', { name: new RegExp(venue) }) })
    .filter({ hasText: time });

Then('the on-site WBGT disclaimer is shown', async ({ page }) => {
  await expect(page.getByTestId('heat-disclaimer')).toContainText('On-site WBGT readings govern');
});

Then('the game day picker shows {string}', async ({ page }, date: string) => {
  await expect(page.getByLabel('Game day')).toHaveValue(date);
});

Then(
  '{string} at {string} reads WBGT {string} in band {string}',
  async ({ page }, venue: string, time: string, wbgt: string, band: string) => {
    const r = row(page, venue, time);
    await expect(r).toHaveCount(1);
    await expect(r.getByTestId('heat-wbgt')).toHaveText(wbgt);
    await expect(r.getByTestId('heat-band')).toHaveText(band);
  }
);

Then(
  '{string} at {string} has a Black trigger of {string}',
  async ({ page }, venue: string, time: string, value: string) => {
    await expect(row(page, venue, time).getByTestId('heat-black-trigger')).toHaveText(value);
  }
);

Then('the NWS forecast update and retrieval times are shown', async ({ page }) => {
  await expect(page.getByTestId('heat-forecast-times')).toContainText(
    /MTR 97,99: updated Oct 2, 2026, 1:31 AM PDT; retrieved Oct 2, 2026, 9:00 AM PDT/
  );
});

Then('no stale-forecast warning is shown', async ({ page }) => {
  await expect(page.getByTestId('heat-forecast-table')).toBeVisible();
  await expect(page.getByTestId('heat-stale-warning')).toHaveCount(0);
});

Then('the stale-forecast warning is shown', async ({ page }) => {
  await expect(page.getByTestId('heat-stale-warning')).toContainText('Stale forecast');
});

Then(
  '{string} is listed as not computed because it has no coordinates',
  async ({ page }, venue: string) => {
    const rows = page
      .getByTestId('heat-row')
      .filter({ has: page.getByRole('rowheader', { name: new RegExp(venue) }) });
    await expect(rows).toHaveCount(10);
    await expect(rows.first().getByTestId('heat-refusal')).toContainText('no coordinates');
  }
);

Then(
  'the sources panel cites the NWS API, Liljegren 2008 and the U.S. Soccer heat guidelines',
  async ({ page }) => {
    const panel = page.getByTestId('heat-sources');
    await expect(panel.getByRole('link', { name: /National Weather Service API/ })).toHaveAttribute(
      'href',
      'https://api.weather.gov'
    );
    await expect(
      panel.getByRole('link', { name: /doi:10\.1080\/15459620802310770/ })
    ).toBeVisible();
    await expect(
      panel.getByRole('link', { name: /Recognize to Recover Heat Guidelines/ })
    ).toHaveAttribute('href', 'https://www.recognizetorecover.org/environmental');
    await expect(panel.getByTestId('heat-threshold-category')).toContainText('Category 1');
  }
);

Then('every {string} row is not computed, citing NWS 404', async ({ page }, venue: string) => {
  const rows = page
    .getByTestId('heat-row')
    .filter({ has: page.getByRole('rowheader', { name: new RegExp(venue) }) });
  await expect(rows).toHaveCount(10);
  await expect(rows.getByTestId('heat-refusal')).toHaveCount(10);
  await expect(rows.first().getByTestId('heat-refusal')).toContainText('NWS 404');
});

Then('the heat forecast says it is turned off', async ({ page }) => {
  await expect(page.getByTestId('heat-forecast-disabled')).toContainText('turned off');
});

Then('the side navigation has no Heat Forecast link', async ({ page }) => {
  const nav = page.getByRole('navigation', { name: 'Primary' });
  await expect(nav.getByRole('link', { name: /Practices/ })).toBeVisible();
  await expect(nav.getByRole('link', { name: /Heat Forecast/ })).toHaveCount(0);
});
