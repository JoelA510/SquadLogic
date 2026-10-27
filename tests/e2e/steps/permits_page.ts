import { createBdd } from 'playwright-bdd';
import { expect, type Page } from '@playwright/test';
import { waitForMockClient } from './mockReady.js';
import { MOCK_ORG_ID } from '../../../frontend/src/lib/mockSeedIds.js';

/**
 * The admins' Field Permits page (docs/changes/2026-10-27-admin-only.md, F3; Phase C3's coach page
 * made the admins'). Every check is a DOM assertion. The mock database is touched only to seed what
 * an admin would have entered in Fields & Venues (a permit with its file record) and to give the
 * signed-in member a role the league no longer has, through `window.__saveMockDB__`.
 *
 * The mock's Open link is a `data:` URL (it has no Storage server), which a browser will not
 * navigate a new tab to, so the step proves what the browser shows: a new tab opens and the page
 * announces no failure. That the tab is pointed at a signed link Storage answers is the
 * real-backend scenario's (`real_backend_permits.feature`).
 */

const { Given, When, Then } = createBdd();

type MockRow = Record<string, unknown>;

async function openMock(page: Page) {
  if (page.url() === 'about:blank') await page.goto('/');
  await waitForMockClient(page);
}

/**
 * The organization's own day plus `days` (the season's timezone decides it), as `YYYY-MM-DD`. The
 * days are added to the calendar date, not the instant, so a DST change in between moves nothing.
 */
async function orgDayPlus(page: Page, days: number): Promise<string> {
  return page.evaluate((offset) => {
    const stored = JSON.parse(sessionStorage.getItem('__MOCK_DB__') || '{}');
    const season = (stored.season_settings || []).find(
      (row: { status?: string }) => row.status === 'active'
    );
    const zone = (season && season.timezone) || 'UTC';
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(new Date());
    const day = new Date(`${today}T00:00:00Z`);
    day.setUTCDate(day.getUTCDate() + offset);
    return day.toISOString().slice(0, 10);
  }, days);
}

Given(
  'a permit from {string} numbered {string} expires in {int} days, has a file and covers {string}',
  async ({ page }, issuer: string, number: string, days: number, field: string) => {
    await openMock(page);
    const validFrom = await orgDayPlus(page, -30);
    const validTo = await orgDayPlus(page, days);
    await page.evaluate(
      ({ mockOrgId, issuer, number, validFrom, validTo, field }) => {
        const db = JSON.parse(
          sessionStorage.getItem('__MOCK_DB__') || JSON.stringify(window.__MOCK_DB__ || {})
        );
        const orgId = localStorage.getItem('squadlogic_active_org') || mockOrgId;
        const target = (db.fields || []).find(
          (f: MockRow) => f.organization_id === orgId && f.name === field
        );
        if (!target) throw new Error(`seed: no field named ${field} in the mock db`);
        const permitId = 'f6000000-0000-4000-8000-0000000000c3';
        const path = `${orgId}/${permitId}/c0000000-0000-4000-8000-0000000000c3.pdf`;
        db.facility_permits = [
          ...(db.facility_permits || []).filter((p: MockRow) => p.id !== permitId),
          {
            id: permitId,
            organization_id: orgId,
            issuer,
            permit_number: number,
            valid_from: validFrom,
            valid_to: validTo,
            notes: null,
            file_path: path,
            file_name: 'permit.pdf',
            file_mime: 'application/pdf',
            file_size: 52_000,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
        ];
        db.facility_permit_scopes = [
          ...(db.facility_permit_scopes || []).filter((s: MockRow) => s.permit_id !== permitId),
          { id: `${permitId}-s`, organization_id: orgId, permit_id: permitId, field_id: target.id },
        ];
        db.storage_objects = [
          ...(db.storage_objects || []).filter((o: MockRow) => o.name !== path),
          {
            id: 'c0000000-0000-4000-8000-0000000000aa',
            bucket_id: 'facility-permits',
            name: path,
            owner: 'mock-admin-id',
            metadata: { size: 52_000, mimetype: 'application/pdf' },
            created_at: new Date().toISOString(),
          },
        ];
        window.__saveMockDB__(db);
      },
      { mockOrgId: MOCK_ORG_ID, issuer, number, validFrom, validTo, field }
    );
  }
);

Given('my membership carries the removed role {string}', async ({ page }, role: string) => {
  await openMock(page);
  await page.evaluate(
    ({ mockOrgId, role }) => {
      const db = JSON.parse(
        sessionStorage.getItem('__MOCK_DB__') || JSON.stringify(window.__MOCK_DB__ || {})
      );
      const orgId = localStorage.getItem('squadlogic_active_org') || mockOrgId;
      const members = (db.organization_members || []).filter(
        (m: MockRow) => m.organization_id === orgId && m.profile_id === 'mock-admin-id'
      );
      if (members.length === 0) throw new Error('seed: the mock admin has no membership');
      for (const member of members) member.role = role;
      window.__saveMockDB__(db);
    },
    { mockOrgId: MOCK_ORG_ID, role }
  );
});

Given('I am using a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
});

When('I open Field Permits from the navigation', async ({ page }) => {
  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: 'Field Permits' })
    .click();
  await page.waitForURL((url) => url.pathname === '/permits', { timeout: 15_000 });
  await expect(page.getByRole('heading', { level: 1, name: 'Field permits' })).toBeVisible({
    timeout: 20_000,
  });
});

const permitItem = (page: Page, issuer: string) =>
  page.getByTestId('permits-page-list').getByRole('listitem').filter({ hasText: issuer });

Then(
  'the permit from {string} lists number {string}, the dates and the field {string}',
  async ({ page }, issuer: string, number: string, field: string) => {
    const item = permitItem(page, issuer);
    await expect(item).toBeVisible({ timeout: 20_000 });
    await expect(item.getByRole('heading', { level: 2, name: issuer })).toBeVisible();
    await expect(item.locator('dd', { hasText: new RegExp(`^${number}$`) })).toBeVisible();
    await expect(item).toContainText(
      /Valid\s*[A-Z][a-z]{2} \d{1,2}, \d{4} to [A-Z][a-z]{2} \d{1,2}, \d{4}/
    );
    await expect(item).toContainText(field);
  }
);

Then(
  'the Open and Download buttons of the permit from {string} are at least {int} pixels square',
  async ({ page }, issuer: string, size: number) => {
    const item = permitItem(page, issuer);
    for (const name of [/^Open the file/, /^Download the file/]) {
      const button = item.getByRole('button', { name });
      await expect(button).toBeVisible();
      const box = await button.boundingBox();
      expect(box, `${name} has a box on the page`).not.toBeNull();
      expect(box!.width, `${name} width`).toBeGreaterThanOrEqual(size);
      expect(box!.height, `${name} height`).toBeGreaterThanOrEqual(size);
    }
  }
);

/** The new tab each Open click asked the browser for, by page. */
const openedTabs = new WeakMap<Page, Promise<Page>>();

When('I open the file of the permit from {string}', async ({ page }, issuer: string) => {
  openedTabs.set(page, page.context().waitForEvent('page', { timeout: 15_000 }));
  await permitItem(page, issuer)
    .getByRole('button', { name: /^Open the file/ })
    .click();
});

Then('the file opens in a new tab through a signed link', async ({ page }) => {
  const tab = openedTabs.get(page);
  expect(tab, 'a previous step clicked Open').toBeDefined();
  // A browser event, not a stand-in: the click opened a real tab.
  await expect(tab!).resolves.toBeTruthy();
  // A refused link would be announced, and its empty tab closed.
  await expect(page.getByRole('alert')).toHaveCount(0);
});

Then(
  'the permits page says no permit is on record and points to Fields & Venues',
  async ({ page }) => {
    await expect(
      page.getByTestId('permits-empty').getByRole('link', { name: 'Fields & Venues' })
    ).toHaveAttribute('href', '/fields');
    await expect(page.getByTestId('permits-empty')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByTestId('permits-page-list')).toHaveCount(0);
  }
);

Then('I am sent home with the message {string}', async ({ page }, message: string) => {
  await page.waitForURL((url) => url.pathname === '/', { timeout: 20_000 });
  await expect(page.getByText(message, { exact: true })).toBeVisible({ timeout: 20_000 });
});

Then('no permit is shown', async ({ page }) => {
  await expect(page.getByText('City Recreation')).toHaveCount(0);
  await expect(page.getByTestId('permits-page-list')).toHaveCount(0);
});
