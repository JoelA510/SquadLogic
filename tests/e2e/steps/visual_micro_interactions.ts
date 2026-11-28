import { createBdd } from 'playwright-bdd';
import { expect } from '@playwright/test';

const { Given, When, Then } = createBdd();

Given('I am using a {int}-pixel-wide viewport', async ({ page }, width: number) => {
  await page.setViewportSize({ width, height: 760 });
});

Then('the desktop navigation is available from the account menu by keyboard', async ({ page }) => {
  const home = page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: 'Home', exact: true });
  await expect(home).toBeInViewport();
  await expect(page.getByRole('button', { name: 'Hamburger Menu' })).toHaveCount(0);
  await page.getByRole('button', { name: /^Account menu for/ }).focus();
  await page.keyboard.press('Tab');
  await expect(home).toBeFocused();
});

Then('the sidebar should be hidden by default', async ({ page }) => {
  const account = page.getByRole('button', { name: /^Account menu for/ });
  await account.focus();
  await page.keyboard.press('Tab');
  await expect(page.locator('aside.nav :focus')).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: 'Primary' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Hamburger Menu' })).toHaveAttribute(
    'aria-expanded',
    'false'
  );
});

When('I reset error flags and click {string}', async ({ page }, buttonName: string) => {
  await page.evaluate(() => {
    localStorage.removeItem('__FORCE_ERROR__');
    window.__FORCE_ERROR__ = false;
  });
  await page.getByRole('button', { name: buttonName }).first().click({ force: true });
});

Then('the sidebar overlay should slide into view', async ({ page }) => {
  const navigation = page.getByRole('navigation', { name: 'Primary' });
  await expect(navigation).toBeInViewport();
  await expect(page.getByRole('button', { name: 'Hamburger Menu' })).toHaveAttribute(
    'aria-expanded',
    'true'
  );
  await page.getByRole('button', { name: /^Account menu for/ }).focus();
  await page.keyboard.press('Tab');
  const home = navigation.getByRole('link', { name: 'Home', exact: true });
  await expect(home).toBeFocused();
  await expect(home).toBeInViewport();
  await expect(home).toHaveCSS('outline-style', 'solid');
});

When('I click the "Hamburger Menu" icon', async ({ page }) => {
  await page.getByRole('button', { name: 'Hamburger Menu' }).press('Enter');
});

When('I click a navigation link like {string}', async ({ page }, linkName: string) => {
  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: linkName })
    .press('Enter');
});

Then('the sidebar overlay should automatically close', async ({ page }) => {
  await expect(page.getByRole('navigation', { name: 'Primary' })).toHaveCount(0);
});

When('a React component throws an unexpected rendering error', async ({ page }) => {
  await page.evaluate(() => {
    localStorage.setItem('__FORCE_ERROR__', 'true');
  });
  await page.reload();
});

Then('the application should not show a blank white screen', async ({ page }) => {
  await expect(page.locator('body').first()).not.toBeEmpty();
});

Then('I should see the {string} glassmorphism error panel', async ({ page }, text: string) => {
  await expect(page.getByText(text, { exact: false }).first()).toBeVisible();
});

Then('I should be safely redirected to the Dashboard', async ({ page }) => {
  await expect(
    page.getByRole('heading', { name: /Welcome back|My Dashboard/ }).first()
  ).toBeVisible();
});
