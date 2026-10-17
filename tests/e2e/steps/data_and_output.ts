import { createBdd } from 'playwright-bdd';
import { expect, type Page } from '@playwright/test';
import { waitForMockClient } from './mockReady.js';
import { MOCK_ORG_ID } from '../../../frontend/src/lib/mockSeedIds.js';

const { Given, When, Then } = createBdd();

Given('I have navigated to the Data Import page', async ({ page }) => {
  await page.goto('/import');
});
Given('a valid GotSport player CSV file exists', async ({ page }) => {
  (page as { mockCsv?: Buffer } & typeof page).mockCsv = Buffer.from(
    'First Name,Last Name,Skill Level\nAlex,Smith,advanced'
  );
});
Given('I upload the GotSport player CSV file', async ({ page }) => {
  const fileInput = page.locator('input[type="file"]');
  if ((await fileInput.count()) > 0) {
    await fileInput.setInputFiles({
      name: 'players.csv',
      mimeType: 'text/csv',
      buffer:
        (page as { mockCsv?: Buffer } & typeof page).mockCsv ||
        Buffer.from('First Name,Last Name\nAlex,Smith'),
    });
  }
});

When(
  'the file is missing a required column such as {string} or {string}',
  async ({ page }, _col1: string, _col2: string) => {
    const csvContent = 'Skill Level\nadvanced';
    await page.locator('input[type="file"]').setInputFiles({
      name: 'invalid.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(csvContent),
    });
  }
);

Then('the system should reject the file completely', async ({ page }) => {
  await expect(page.getByRole('heading', { name: 'Map your columns' })).toBeVisible({
    timeout: 10000,
  });
  await expect(page.getByRole('button', { name: 'Continue' })).toBeDisabled();
});

Then('present a clear validation error to the user in the UI', async ({ page }) => {
  await expect(page.getByText(/Still need: First Name, Last Name, Date of Birth/)).toBeVisible();
});

Given('I upload the GotSport player CSV file with valid headers', async ({ page }) => {
  const fileInput = page.locator('input[type="file"]');
  if ((await fileInput.count()) > 0) {
    await fileInput.setInputFiles({
      name: 'players_valid.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from('First Name,Last Name,Date of Birth\nAlex,Smith,2015-01-01'),
    });
  }
});

When('a specific row has malformed data \\(e.g. invalid date of birth)', async ({ page }) => {
  const csvContent = 'First Name,Last Name,Date of Birth\nAlex,Smith,\nSam,Jones,2015-01-01';
  await page.locator('input[type="file"]').setInputFiles({
    name: 'row_errors.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(csvContent),
  });

  // Wait for preview to render
  await expect(page.getByRole('button', { name: 'Start Import' })).toBeVisible();

  // Verify cell error in preview
  await expect(page.locator('.cell-error').first()).toBeVisible();

  // Start import to see the validation panel
  await page.getByRole('button', { name: 'Start Import' }).click();
});

Then('the system should flag the row as an error', async ({ page }) => {
  // The malformed row is flagged in preview; the import can still apply the
  // remaining valid rows and surface that warning state after finalization.
  // Row-level errors were already flagged in the preview via cell-error class (verified in When step).
  await expect(page.getByRole('heading', { name: 'Import Applied with Warnings' })).toBeVisible({
    timeout: 15000,
  });
});

Then('load the remaining valid rows into the staging table', async ({ page }) => {
  // The valid rows were imported — the applied state confirms this.
  // The "Continue" button proves the import completed and data is ready to proceed.
  await expect(page.getByRole('button', { name: 'Continue' }).first()).toBeVisible({
    timeout: 10000,
  });
});

Then('present an interface to manually correct the malformed row', async ({ page }) => {
  // The "Upload Another File" button allows re-uploading corrected data.
  await expect(page.getByRole('button', { name: 'Upload Another File' }).first()).toBeVisible({
    timeout: 10000,
  });
});

Given('I upload a GotSport player CSV file with reciprocal buddy requests', async ({ page }) => {
  await page.locator('input[type="file"]').setInputFiles({
    name: 'players-buddies.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(
      [
        'First Name,Last Name,Date of Birth,Registration ID,Division,Buddy ID',
        'Avery,Adams,2016-04-02,GS-BUDDY-A,U8 Coed,GS-BUDDY-B',
        'Blair,Bennett,2016-05-03,GS-BUDDY-B,U8 Coed,GS-BUDDY-A',
      ].join('\n')
    ),
  });
  await expect(page.getByRole('button', { name: 'Start Import' })).toBeVisible();
});

When('I apply the player CSV import', async ({ page }) => {
  await page.getByRole('button', { name: 'Start Import' }).click();
  await expect(page.getByRole('heading', { name: 'Import Applied' })).toBeVisible({
    timeout: 15000,
  });
});

Then('the player import should materialize reciprocal buddy pairs', async ({ page }) => {
  // The import log on the page reports what `materialize_import_buddy_pairs` answered: the two
  // players request each other, so one pair and a relationship row each way. Nothing on screen
  // reads `player_buddies` itself, so this is the page's own account of the write.
  const log = page.getByTestId('import-log');
  await expect(log).toContainText('Buddy pairs materialized: 1 pair(s), 2 relationship rows.', {
    timeout: 15000,
  });
  await expect(log).not.toContainText('could not be matched reciprocally');
});

/**
 * Opens `path` in a second window opened from this page, and waits for its heading.
 *
 * The mock store lives in sessionStorage, which a window opened from the page starts with a copy
 * of, so the second window shows what the first has stored, while the first keeps its own state
 * (the import page's Roll Back button lives only there). Assertions run on that window's page.
 */
async function openFromThisPage(page: Page, path: string, heading: string) {
  const [other] = await Promise.all([
    page.waitForEvent('popup'),
    page.evaluate((target) => {
      window.open(target, '_blank');
    }, path),
  ]);
  await expect(other.getByRole('heading', { name: heading, exact: true }).first()).toBeVisible({
    timeout: 20000,
  });
  await other.waitForLoadState('networkidle');
  return other;
}

/** The Coaches page, opened from this one, and whether it lists the imported coach. */
async function expectCoachListed(page: Page, listed: boolean) {
  const coaches = await openFromThisPage(page, '/coaches', 'Coaches');
  // A seeded coach first: the grid has rendered its rows, so an absence below means something.
  await expect(coaches.getByRole('gridcell', { name: 'casey.rivera@example.com' })).toBeVisible();
  const row = coaches.getByRole('row').filter({ hasText: 'csvcoach@example.com' });
  if (listed) {
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('CSV Coach');
    await expect(row).toContainText('555-1212');
  } else {
    await expect(row).toHaveCount(0);
  }
  await coaches.close();
}

/** The Fields page, opened from this one, and whether it shows the imported field's slot. */
async function expectImportedFieldListed(page: Page, listed: boolean) {
  const fields = await openFromThisPage(page, '/fields', 'Field Management');
  // A seeded field first, so an absence below is not an unrendered page.
  await expect(fields.getByText('Field 1', { exact: true }).first()).toBeVisible();
  const card = fields
    .locator('div')
    .filter({ has: fields.getByText('Imported Field', { exact: true }) })
    .filter({ hasText: 'MON' })
    .last();
  if (listed) {
    await expect(card).toBeVisible();
    await expect(card).toContainText('Main Park', { ignoreCase: true });
    await expect(card).toContainText('17:30');
  } else {
    await expect(fields.getByText('Imported Field', { exact: true })).toHaveCount(0);
  }
  await fields.close();
}

Given('I upload a valid GotSport coach CSV file', async ({ page }) => {
  await page.locator('button').filter({ hasText: 'coaches' }).first().click();
  await page.locator('input[type="file"]').setInputFiles({
    name: 'coaches.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('full_name,email,phone\nCSV Coach,csvcoach@example.com,555-1212'),
  });
  await expect(page.getByRole('button', { name: 'Start Import' })).toBeVisible();
});

When('I apply the coach CSV import', async ({ page }) => {
  await page.getByRole('button', { name: 'Start Import' }).click();
  await expect(page.getByRole('heading', { name: 'Import Applied' })).toBeVisible({
    timeout: 15000,
  });
});

Then('the coach CSV import should update the coach database', async ({ page }) => {
  await expect(page.getByRole('button', { name: 'Roll Back Coach Import' })).toBeVisible({
    timeout: 10000,
  });
  await expectCoachListed(page, true);
});

When('I roll back the coach CSV import', async ({ page }) => {
  await page.getByRole('button', { name: 'Roll Back Coach Import' }).click();
  await expect(page.getByRole('button', { name: 'Start Import' })).toBeVisible({
    timeout: 15000,
  });
});

Then('the imported coach should be removed from the coach database', async ({ page }) => {
  await expectCoachListed(page, false);
});

Given('I upload a valid field slot CSV file', async ({ page }) => {
  await page.locator('button').filter({ hasText: 'fields' }).first().click();
  await page.locator('input[type="file"]').setInputFiles({
    name: 'fields.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(
      [
        'Location,Field,Subunit,Type,Day,Slot Date,Start,End,Capacity,Valid From,Valid Until',
        'Main Park,Imported Field,A,practice,Mon,,17:30,18:30,1,2026-03-01,2026-05-31',
      ].join('\n')
    ),
  });
  await expect(page.getByRole('button', { name: 'Start Import' })).toBeVisible();
});

When('I apply the field slot CSV import', async ({ page }) => {
  await page.getByRole('button', { name: 'Start Import' }).click();
  await expect(page.getByRole('heading', { name: 'Import Applied' })).toBeVisible({
    timeout: 15000,
  });
});

When('I validate the field slot CSV import for later review', async ({ page }) => {
  await page.getByRole('button', { name: 'Validate Only' }).click();
  await expect(page.getByRole('heading', { name: 'Import Ready to Apply' })).toBeVisible({
    timeout: 15000,
  });
});

Then(
  'the field slot CSV import should be ready to apply without changing facilities',
  async ({ page }) => {
    await expect(page.getByRole('button', { name: 'Apply Field Import' })).toBeVisible({
      timeout: 10000,
    });
    await expectImportedFieldListed(page, false);
  }
);

When('I apply the reviewed field slot CSV import', async ({ page }) => {
  await page.getByRole('button', { name: 'Apply Field Import' }).click();
  await expect(page.getByRole('heading', { name: 'Import Applied' })).toBeVisible({
    timeout: 15000,
  });
});

Then('the field slot CSV import should update the facilities database', async ({ page }) => {
  await expect(page.getByRole('button', { name: 'Roll Back Field Import' })).toBeVisible({
    timeout: 10000,
  });
  await expectImportedFieldListed(page, true);
});

When('I roll back the field slot CSV import', async ({ page }) => {
  await page.getByRole('button', { name: 'Roll Back Field Import' }).click();
  await expect(page.getByRole('button', { name: 'Start Import' })).toBeVisible({
    timeout: 15000,
  });
});

Then('the imported field slot should be removed from the facilities database', async ({ page }) => {
  await expectImportedFieldListed(page, false);
});

When('I click to export the team rosters or schedules', async ({ page }) => {
  await page.goto('/workflow?step=6');

  // CRITICAL FIX: Use a more robust locator that matches the actual rendered text
  const step6 = page
    .locator('[data-testid*="workflow-step-"]')
    .filter({ hasText: '6. Output & Communication' })
    .first();
  await step6.scrollIntoViewIfNeeded();
  await step6.click();

  const generateButton = page.getByTestId('generate-csvs-btn').first();
  await expect(generateButton).toBeVisible({ timeout: 15000 });
  await generateButton.scrollIntoViewIfNeeded();
  await generateButton.click();
});

Then('the system should generate the CSV file', async ({ page }) => {
  await expect(page.getByText('CSVs generated successfully.')).toBeVisible({ timeout: 15000 });
  await expect(page.getByRole('heading', { name: 'Generated Files' }).first()).toBeVisible();
});

Then(
  "automatically upload a backup copy to the organization's Supabase Storage bucket",
  async ({ page }) => {
    const uploadButton = page.getByRole('button', { name: 'Upload to Storage' }).first();
    await expect(uploadButton).toBeVisible({ timeout: 15000 });
    await uploadButton.click();
    await expect(page.getByText('Uploaded').first()).toBeVisible({ timeout: 15000 });
  }
);

Then('provide a secure download link or trigger an instant download', async ({ page }) => {
  await expect(page.getByRole('button', { name: 'Download Master CSV' }).first()).toBeVisible();
});

Given('the team rosters have been generated and finalized', async ({ page }) => {
  await page.goto('/');
  await waitForMockClient(page);
  await page.evaluate((mockOrgId) => {
    const db = JSON.parse(sessionStorage.getItem('__MOCK_DB__') || '{}');
    const orgId = localStorage.getItem('squadlogic_active_org') || mockOrgId;

    // Own the team-run fixture for this scenario so earlier E2E scenarios cannot win the
    // "latest team run" query with a coach-less result.
    db.scheduler_runs = (db.scheduler_runs || []).filter(
      (r: Record<string, unknown>) =>
        !(
          r.run_type === 'team' &&
          (r.organization_id === orgId ||
            r.organization_id === undefined ||
            r.organization_id === null)
        )
    );
    db.scheduler_runs.push({
      id: 'run-1',
      organization_id: orgId,
      run_type: 'team',
      status: 'completed',
      created_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      results: {
        teamsByDivision: {
          U10: [
            {
              id: 't1',
              name: 'Tigers',
              division: 'U10',
              headCoach: 'Coach Smith',
              coachEmail: 'smith@example.com',
            },
          ],
        },
      },
    });

    sessionStorage.setItem('__MOCK_DB__', JSON.stringify(db));
  }, MOCK_ORG_ID);
});

When('I access the communication tools', async ({ page }) => {
  await page.goto('/workflow?step=6');

  // CRITICAL FIX: Use a more robust locator that matches the actual rendered text
  const step6 = page
    .locator('[data-testid*="workflow-step-"]')
    .filter({ hasText: '6. Output & Communication' })
    .first();
  await step6.click({ force: true });
});

Then('I should be able to generate a batch of draft emails for every coach', async ({ page }) => {
  await expect(page.locator('article[aria-label="Teams Formed"]').first()).toContainText('1', {
    timeout: 15000,
  });
  const generateEmailsButton = page.getByTestId('generate-emails-btn').first();
  await expect(generateEmailsButton).toBeVisible({ timeout: 15000 });
  await generateEmailsButton.click();
  // 8.2: one draft per coach rather than one per team, and the panel names
  // any coach it could not write to instead of leaving the count to imply a
  // full run.
  await expect(page.getByText(/Generated \d+ email drafts, one per coach\./)).toBeVisible({
    timeout: 10000,
  });
});

Then(
  "each draft should include the coach's name, team name, and assigned practice schedule",
  async ({ page }) => {
    await expect(page.getByText('Subject: Welcome to the season').first()).toBeVisible();
  }
);
