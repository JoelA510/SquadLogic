import { createBdd } from 'playwright-bdd';
import { expect } from '@playwright/test';

/**
 * An admin of two organizations (docs/changes/2026-10-27-admin-only.md, F5). The switch itself is
 * `dashboard_and_sidebar.ts`'s ("I switch the active organization to"); the seeding and the
 * "records associated with" checks are `rbac_and_fields.ts`'s. DOM assertions only.
 */
const { When } = createBdd();

// By the in-app link, not `page.goto`: a reload would re-read the stored organization and prove
// nothing about the switch. The link's name carries a count badge ("Teams & Rosters 2"), so it is
// matched by its label's start.
When('I open Teams & Rosters from the navigation', async ({ page }) => {
  await page
    .locator('aside')
    .getByRole('link', { name: /^Teams & Rosters/ })
    .click();
  await page.waitForURL((url) => url.pathname === '/teams', { timeout: 15_000 });
  // The grid's own list is behind an Edit control in some states; the teams are in the DOM
  // either way once the page has rendered its run.
  await expect(page.getByRole('heading', { name: /Teaming & Analysis/ }).first()).toBeVisible({
    timeout: 20_000,
  });
});
