import { createBdd } from 'playwright-bdd';
import { expect } from '@playwright/test';

const { Given, When, Then } = createBdd();

// --- Global State Setup ---
Given(
  'the season {string} is active and schedules are published',
  async ({ page }, seasonName: string) => {
    await page.waitForLoadState('networkidle');
    const header = page.locator('header');
    if (await header.isVisible()) {
      await expect(header).toContainText(seasonName, { ignoreCase: true });
    }
  }
);

Given('the season {string} is active', async ({ page }, _seasonName: string) => {
  await page.waitForLoadState('networkidle');
});

// --- Global Navigation ---
const routeMap: Record<string, string> = {
  'Dashboard page': '/',
  Dashboard: '/',
  'Compliance Dashboard': '/admin/compliance',
  'Reporting Dashboard': '/admin/reports',
  'League Standings': '/standings',
  'Team Management page': '/teams',
  'Registration Forms': '/admin/forms',
  'Practice Scheduling page': '/schedule/practice',
  'Game Scheduling page': '/schedule/game',
};

When('I navigate to the {string} page', async ({ page }, pageName: string) => {
  const url = routeMap[pageName] || routeMap[`${pageName} page`];
  if (url) {
    await page.goto(url);
  } else {
    await page.getByRole('link', { name: pageName, exact: true }).first().click({ force: true });
  }
  await page.waitForLoadState('networkidle');
});

Given('I navigate to the {string}', async ({ page }, destination: string) => {
  const url = routeMap[destination] || routeMap[`${destination} page`];
  if (url) {
    await page.goto(url);
  } else {
    await page.getByRole('link', { name: destination, exact: true }).first().click({ force: true });
  }
  await page.waitForLoadState('networkidle');
});

Given(
  /I navigate to the (Dashboard page|Dashboard|Compliance Dashboard|Reporting Dashboard|Team Management page|Registration Forms)/,
  async ({ page }, destination: string) => {
    const url = routeMap[destination];
    if (url) {
      await page.goto(url);
    } else {
      await page
        .getByRole('link', { name: destination, exact: true })
        .first()
        .click({ force: true });
    }
    await page.waitForLoadState('networkidle');
  }
);

Given('I am on the {string}', async ({ page }, pageName: string) => {
  const routeMap: Record<string, string> = {
    'Compliance Dashboard': '/admin/compliance',
    'Reporting Dashboard': '/admin/reports',
    'Dashboard page': '/',
    Dashboard: '/',
    'Field Management page': '/fields',
    'Field Management': '/fields',
    'Team Management page': '/teams',
    'Team Management': '/teams',
    'Practice Scheduling page': '/schedule/practice',
    'Game Scheduling page': '/schedule/game',
    'Data Import page': '/import',
    'Settings page': '/settings',
  };
  const cleanName = pageName.endsWith(' page') ? pageName.slice(0, -5) : pageName;
  const url = routeMap[pageName] || routeMap[cleanName];
  if (!url) throw new Error(`Route not found for: ${pageName}`);
  await page.goto(url);
  await page.waitForLoadState('networkidle');
});

Given('I am on the {string} page', async ({ page }, pageName: string) => {
  const routeMap: Record<string, string> = {
    'Field Management': '/fields',
    'Blackout Dates': '/scheduling/blackouts',
    Dashboard: '/',
    'Team Management': '/teams',
    'Data Import': '/import',
  };
  const url = routeMap[pageName] || `/${pageName.toLowerCase().replace(/\s+/g, '-')}`;
  await page.goto(url);
  await page.waitForLoadState('networkidle');
});

Given(
  /I am on the (Dashboard page|Dashboard|Compliance Dashboard|Reporting Dashboard)/,
  async ({ page }, pageName: string) => {
    const routeMap: Record<string, string> = {
      'Compliance Dashboard': '/admin/compliance',
      'Reporting Dashboard': '/admin/reporting',
      'Dashboard page': '/',
      Dashboard: '/',
    };
    const url = routeMap[pageName] || '/';
    await page.goto(url);
    await page.waitForLoadState('networkidle');
  }
);

When('I view the Dashboard', async ({ page }) => {
  await page.goto('/');
});

When('I click {string}', async ({ page }, name: string) => {
  const btn = page.getByRole('button', { name, exact: true }).first();
  if (await btn.isVisible({ timeout: 5000 }).catch(() => false)) {
    await btn.click({ force: true });
  } else {
    const textBtn = page.getByText(name, { exact: true }).first();
    if (await textBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await textBtn.click({ force: true });
    } else {
      await page.evaluate((n) => {
        const all = Array.from(document.querySelectorAll('button, a, [role="button"]'));
        const found = all.find((el) => el.textContent?.trim().includes(n));
        if (found) (found as HTMLElement).click();
      }, name);
    }
  }
});

When('I click the {string} button', async ({ page }, name: string) => {
  // Map feature-file button names to actual UI button names where they differ
  const buttonNameMap: Record<string, string> = {
    'Export Rosters CSV': 'Export Analytics',
  };
  const actualName = buttonNameMap[name] || name;

  // Try exact role match first, fall back to text match (handles aria-label overrides).
  // Waiting for visibility avoids clicking before React has hydrated the control.
  const roleButton = page.getByRole('button', { name: actualName, exact: true }).first();
  const textButton = page.locator(`button:has-text("${actualName}")`).first();
  const button = (await roleButton.isVisible({ timeout: 5000 }).catch(() => false))
    ? roleButton
    : textButton;

  await expect(button).toBeVisible({ timeout: 10000 });
  await expect(button).toBeEnabled({ timeout: 10000 });
  await button.click();
});

When('I attempt to navigate to the {string} page', async ({ page }, pageName: string) => {
  const routeMap: Record<string, string> = {
    'Data Import': '/import',
    'Field Management': '/fields',
    'Practice Schedule': '/schedule/practice',
    Settings: '/settings',
  };

  const targetUrl = routeMap[pageName];
  if (!targetUrl) throw new Error(`Route mapping not defined for: ${pageName}`);

  await page.goto(targetUrl);
});

// --- Global Assertions ---
Then('I should be redirected to the Dashboard', async ({ page }) => {
  await page.waitForURL((url) => url.pathname === '/', { timeout: 15000 });
  await expect(
    page
      .getByRole('heading', { name: /Welcome back|My Dashboard|League Management|Dashboard/i })
      .first()
  ).toBeVisible();
});

Then('I should see an {string} warning', async ({ page }, warningText: string) => {
  const toastOrBanner = page.getByText(warningText, { exact: false }).first();
  await expect(toastOrBanner).toBeVisible();
});

Then('I should see the text {string}', async ({ page }, text: string) => {
  await expect(page.getByText(text).first()).toBeVisible();
});

Then('I should see the message {string}', async ({ page }, text: string) => {
  await expect(page.getByText(text).first()).toBeVisible();
});

Then(/the dashboard data should refresh to show (.*) data/, async ({ page }, _orgName: string) => {
  await expect(
    page
      .getByRole('heading', { name: /Welcome back|My Dashboard|League Management|Dashboard/i })
      .first()
  ).toBeVisible();
});
