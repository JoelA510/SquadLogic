import { createBdd } from 'playwright-bdd';
import { expect } from '@playwright/test';

const { When, Then } = createBdd();

/**
 * The pointer from Data Import to the practice preferences import
 * (docs/changes/2026-11-02-preference-followups.md, item 2). Everything the steps assert is read
 * from the page.
 */

const POINTER = 'Practice preferences are imported on their own page';
const LINK = 'Open Practice preferences, Import a file tab';

Then('Data Import points to the Import a file tab of Practice preferences', async ({ page }) => {
  const card = page.getByRole('region', { name: POINTER });
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(card).toContainText('Import a file tab');
  await expect(card).toContainText('stays pending until you accept it');
  await expect(card.getByRole('link')).toHaveCount(1);
  await expect(card.getByRole('link', { name: LINK })).toHaveAttribute(
    'href',
    '/coaches/practice-preferences?tab=import'
  );
});

When('I follow the pointer to the Practice preferences import', async ({ page }) => {
  await page.getByRole('link', { name: LINK }).click();
});

When('I reach the pointer with the keyboard and press Enter', async ({ page }) => {
  const link = page.getByRole('link', { name: LINK });
  await expect(link).toBeVisible({ timeout: 20_000 });
  // A real link takes keyboard focus (it is in the tab order) and Enter follows it.
  await link.focus();
  await expect(link).toBeFocused();
  await page.keyboard.press('Enter');
});

Then('the practice preferences page is open on its {string} tab', async ({ page }, tab: string) => {
  await expect(
    page.getByRole('heading', { name: 'Practice preferences', exact: true })
  ).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('admin-preferences-view')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('tab', { name: new RegExp(`^${tab}`) })).toHaveAttribute(
    'aria-selected',
    'true'
  );
  expect(new URL(page.url()).pathname).toBe('/coaches/practice-preferences');
});
