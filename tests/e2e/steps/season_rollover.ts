import { createBdd } from 'playwright-bdd';
import { expect, type Page } from '@playwright/test';
import { waitForMockClient } from './mockReady.js';

/**
 * Starting the next season from this one (plan docs/changes/2026-10-27-season-enrollment.md, E3b;
 * migration 20261109010000). Every check is a DOM assertion; the mock database is touched only to
 * seed, through `window.__saveMockDB__`. The mock seed has one active season, "Fall 2026", with
 * two players, "Alex Smith" and "Jamie Jones", in the division "U8 Coed".
 */

const { Given, When, Then } = createBdd();

const seasonItem = (page: Page, name: string) =>
  page
    .getByRole('list', { name: 'Seasons of this league' })
    .getByRole('listitem')
    .filter({ has: page.getByRole('heading', { name }) });

Given(
  "the active season's player {string} has the registration id {string}",
  async ({ page }, fullName: string, registrationId: string) => {
    if (page.url() === 'about:blank') await page.goto('/');
    await waitForMockClient(page);
    const [first, ...rest] = fullName.split(' ');
    await page.evaluate(
      ({ first, last, registrationId }) => {
        type Row = Record<string, unknown>;
        const db = window.__MOCK_DB__ as Record<string, Row[] | undefined> | undefined;
        if (!db) throw new Error('mock store not initialised');
        const player = (db.players ?? []).find(
          (row) => row.first_name === first && row.last_name === last
        );
        if (!player) throw new Error(`no seeded player ${first} ${last}`);
        player.external_registration_id = registrationId;
        window.__saveMockDB__(db);
      },
      { first, last: rest.join(' '), registrationId }
    );
  }
);

When(
  'I start the next season {string} from {string} for the year {int}, running {string} to {string}',
  async ({ page }, name: string, source: string, year: number, start: string, end: string) => {
    await page.getByRole('button', { name: `Start next season from ${source}` }).click();
    const dialog = page.getByRole('dialog', { name: 'Start next season' });
    await expect(
      dialog.getByText('Players, coaches and teams are not copied', { exact: false })
    ).toBeVisible();
    await dialog.getByLabel('Season name').fill(name);
    await dialog.getByLabel('Season year (the year the season starts)').fill(String(year));
    await dialog.getByLabel('Start date (optional)').fill(start);
    await dialog.getByLabel('End date (optional)').fill(end);
    await dialog.getByRole('button', { name: 'Create draft season' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(
      page.getByText(`Draft season "${name}" created from "${source}"`, { exact: false })
    ).toBeVisible();
  }
);

Then(
  'the season {string} is listed as {string}',
  async ({ page }, name: string, status: string) => {
    await expect(seasonItem(page, name).getByText(status, { exact: true })).toBeVisible();
  }
);

When(
  'I set the draft {string} to cut off ages on {string} {int}',
  async ({ page }, name: string, month: string, day: number) => {
    await page.getByRole('button', { name: `Edit ${name}` }).click();
    const dialog = page.getByRole('dialog', { name: `Edit ${name}` });
    // The cutoff is editable once the draft is known to have no players.
    await expect(dialog.getByLabel('Cutoff')).toBeEnabled();
    await dialog.getByLabel('Cutoff').selectOption({ label: 'Custom date' });
    await dialog.getByLabel('Cutoff month').selectOption({ label: month });
    await dialog.getByLabel('Cutoff day').fill(String(day));
    await dialog.getByRole('button', { name: 'Save season' }).click();
    await expect(dialog).toHaveCount(0);
  }
);

Then(
  'the season {string} is listed with the age cutoff {string}',
  async ({ page }, name: string, cutoff: string) => {
    await expect(seasonItem(page, name)).toContainText(`Age cutoff: ${cutoff}`);
  }
);

When(
  'I import the player file with {string} and the renewed {string}',
  async ({ page }, newcomer: string, renewed: string) => {
    await page.goto('/import');
    await expect(page.getByTestId('import-season-note')).toContainText(
      'Importing into the draft season "Winter 2027"'
    );
    const [nFirst, ...nRest] = newcomer.split(' ');
    const [rFirst, ...rRest] = renewed.split(' ');
    await page.locator('input[type="file"]').setInputFiles({
      name: 'next-season.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(
        [
          'First Name,Last Name,Date of Birth,Registration ID,Division',
          `${nFirst},${nRest.join(' ')},2018-09-15,GS-E3B-ZOE,U8 Coed`,
          `${rFirst},${rRest.join(' ')},2018-03-02,GS-E3B-ALEX,U8 Coed`,
        ].join('\n')
      ),
    });
    await expect(page.getByRole('button', { name: 'Start Import' })).toBeVisible();
    await page.getByRole('button', { name: 'Start Import' }).click();
    await expect(page.getByRole('heading', { name: 'Import Applied' })).toBeVisible({
      timeout: 15_000,
    });
  }
);

When('I activate the season {string}', async ({ page }, name: string) => {
  await page.getByRole('button', { name: `Activate ${name}` }).click();
  const dialog = page.getByRole('dialog', { name: 'Activate season' });
  await expect(dialog).toContainText('is completed');
  await dialog.getByRole('button', { name: 'Activate' }).click();
  await expect(dialog).toHaveCount(0);
});
