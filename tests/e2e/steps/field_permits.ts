import { createBdd } from 'playwright-bdd';
import { expect, type Page } from '@playwright/test';

/**
 * Field and venue permits (plan docs/changes/2026-10-22-phase-c-permits.md, C2; migration
 * 20261102010000). Every check is a DOM assertion; files are chosen through the file inputs, as a
 * person chooses them. The mock database is not touched here beyond what the shared steps seed.
 */

const { When, Then } = createBdd();

const PDF = (text: string) => Buffer.from(`%PDF-1.4\n% ${text}\n%%EOF\n`, 'utf8');

/**
 * `YYYY-MM-DD` of the organization's day plus `days`: the day the database judges permits on is the
 * active season's own (the mock seed's season has a timezone), so it is read from the page's mock
 * database rather than assumed to be the UTC date. Whole days are added to the instant, which
 * crosses no DST change in a span of weeks that this suite uses.
 */
async function orgDayPlus(page: Page, days: number): Promise<string> {
  return page.evaluate((offset) => {
    const stored = JSON.parse(sessionStorage.getItem('__MOCK_DB__') || '{}');
    const season = (stored.season_settings || []).find(
      (row: { status?: string }) => row.status === 'active'
    );
    const zone = (season && season.timezone) || 'UTC';
    const instant = new Date(Date.now() + offset * 86_400_000);
    return new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(instant);
  }, days);
}

const permitItem = (page: Page, issuer: string) =>
  page.getByTestId('permit-list').getByRole('listitem').filter({ hasText: issuer });

/** The card of a field at a venue (the mock seed holds other fields named "Field 1"). */
const fieldCard = (page: Page, field: string, venue: string) =>
  page
    .locator('div.bg-bg-surface')
    .filter({ has: page.getByRole('heading', { name: field, level: 2, exact: true }) })
    .filter({ hasText: venue })
    .first();

Then(
  'the field {string} at {string} says it has no current permit',
  async ({ page }, field: string, venue: string) => {
    await expect(fieldCard(page, field, venue).getByText('No current permit')).toBeVisible({
      timeout: 15_000,
    });
  }
);

When(
  'I add a permit from {string} numbered {string} covering {string} that expires in {int} days with the file {string}',
  async (
    { page },
    issuer: string,
    number: string,
    field: string,
    days: number,
    fileName: string
  ) => {
    if (!page.url().endsWith('/fields')) await page.goto('/fields');
    await page.getByRole('button', { name: 'Add permit' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add permit' });
    await dialog.getByLabel('Issued by').fill(issuer);
    await dialog.getByLabel('Permit number').fill(number);
    await dialog.getByLabel('Valid from').fill(await orgDayPlus(page, -30));
    await dialog.getByLabel('Valid through').fill(await orgDayPlus(page, days));
    await dialog.getByLabel(field, { exact: true }).check();
    await dialog.getByLabel('The permit document (optional)').setInputFiles({
      name: fileName,
      mimeType: 'application/pdf',
      buffer: PDF(fileName),
    });
    await dialog.getByRole('button', { name: 'Save permit' }).click();
    await expect(dialog).toBeHidden();
    await expect(permitItem(page, issuer)).toBeVisible();
  }
);

Then('the permit from {string} says {string}', async ({ page }, issuer: string, text: string) => {
  await expect(permitItem(page, issuer).getByText(text, { exact: true })).toBeVisible();
});

Then(
  'the permit from {string} lists the file {string}',
  async ({ page }, issuer: string, name: string) => {
    await expect(permitItem(page, issuer)).toContainText(name);
  }
);

Then(
  'the permit from {string} keeps its number {string} with its leading zero',
  async ({ page }, issuer: string, number: string) => {
    await expect(permitItem(page, issuer)).toContainText(`#${number}`);
  }
);

Then(
  'the field {string} at {string} shows {string}',
  async ({ page }, field: string, venue: string, text: string) => {
    await expect(fieldCard(page, field, venue).getByText(text)).toBeVisible();
  }
);

Then(
  'the Permits section warns that {int} permit expires within 30 days',
  async ({ page }, count: number) => {
    await expect(page.getByTestId('permit-warning-expiring')).toContainText(
      `${count} permit expires within 30 days`
    );
  }
);

When(
  'I replace the file of the permit from {string} with {string}',
  async ({ page }, issuer: string, fileName: string) => {
    const item = permitItem(page, issuer);
    await item.locator('input[type="file"]').setInputFiles({
      name: fileName,
      mimeType: 'application/pdf',
      buffer: PDF(fileName),
    });
    await expect(page.getByText(`Replaced the file for the permit from ${issuer}.`)).toBeVisible();
  }
);

When('I open the admin home', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Needs attention' })).toBeVisible({
    timeout: 20_000,
  });
});

Then('the admin home needs attention for {string}', async ({ page }, text: string) => {
  await expect(page.getByText(text, { exact: true })).toBeVisible({ timeout: 15_000 });
});

Then('the admin home needs attention for fields with no current permit', async ({ page }) => {
  await expect(page.getByText(/^\d+ fields? ha(s|ve) no current permit$/)).toBeVisible({
    timeout: 15_000,
  });
});

When('I try to add a permit with a file that is not a PDF', async ({ page }) => {
  await page.getByRole('button', { name: 'Add permit' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add permit' });
  await dialog.getByLabel('The permit document (optional)').setInputFiles({
    name: 'permit.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('<html>not a pdf</html>', 'utf8'),
  });
});

Then('the permit dialog says the file is not a real PDF', async ({ page }) => {
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('not a real PDF');
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
});

Then('no permit is recorded', async ({ page }) => {
  await expect(page.getByText('No permits recorded yet.')).toBeVisible();
});

When(
  'I delete the permit from {string} after reading the confirmation',
  async ({ page }, issuer: string) => {
    await page.getByRole('button', { name: `Delete the permit from ${issuer}` }).click();
    const dialog = page.getByRole('dialog', { name: 'Delete permit' });
    await expect(dialog).toContainText(issuer);
    await expect(dialog).toContainText('Coaches will no longer be able to open it');
    await dialog.getByRole('button', { name: 'Delete permit' }).click();
    await expect(page.getByText(`Deleted the permit from ${issuer}.`)).toBeVisible();
  }
);
