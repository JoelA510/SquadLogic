/**
 * Steps for the real-backend project (plan item M4.1): the app's real Supabase
 * client against a local stack (`supabase start`, seeded by
 * tests/e2e/real-backend/seed.sql), with the Edge Functions that stack serves.
 *
 * Every assertion reads the page. Nothing here touches sessionStorage, the
 * mock's `__MOCK_DB__`, or the database directly: what the scenarios prove is
 * that the app, through its own client, RPCs and Edge Functions, does what it
 * shows.
 */
import { createBdd } from 'playwright-bdd';
import { expect, type Page } from '@playwright/test';
import { SEEDED_ADMIN, registrationCsv, registrations } from './registrations.js';

const { Given, When, Then, Before, After } = createBdd();

/** Long enough for the edge runtime's first, cold, request to a function. */
const BACKEND_TIMEOUT = 120_000;

// What the browser saw go wrong, printed when a scenario fails: CI keeps the
// trace as an artifact, but the job log should already say why.
const diagnostics = new WeakMap<Page, string[]>();

Before(async ({ page }) => {
  const lines: string[] = [];
  diagnostics.set(page, lines);
  page.on('console', (message) => {
    if (message.type() === 'error') lines.push(`console.error: ${message.text()}`);
  });
  page.on('pageerror', (error) => lines.push(`pageerror: ${error.message}`));
  page.on('response', (response) => {
    if (response.status() >= 400) {
      lines.push(`HTTP ${response.status()} ${response.request().method()} ${response.url()}`);
    }
  });
});

After(async ({ page, $testInfo }) => {
  if ($testInfo.status === $testInfo.expectedStatus) return;
  const body = await page
    .locator('body')
    .innerText({ timeout: 5_000 })
    .catch((error: Error) => `(could not read the page: ${error.message})`);
  console.log(
    [
      `--- real-backend diagnostics: ${$testInfo.title}`,
      `url: ${page.url()}`,
      ...(diagnostics.get(page) ?? []).slice(-40),
      '--- page text (first 4000 characters)',
      body.slice(0, 4000),
      '---',
    ].join('\n')
  );
});

Given('I am signed in as the seeded administrator', async ({ page }) => {
  await page.goto('/');
  await page.locator('#email').fill(SEEDED_ADMIN.email);
  await page.locator('#password').fill(SEEDED_ADMIN.password);
  await page.locator('button[type="submit"]').click();
  // The login form goes, and the dashboard shell (its navigation) comes.
  await expect(page.locator('#password')).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByRole('navigation').first()).toBeVisible({ timeout: 30_000 });
});

When('I import the {string} registration export', async ({ page }, shape: string) => {
  if (shape !== 'full' && shape !== 'narrow') throw new Error(`unknown export shape: ${shape}`);
  await page.goto('/import');
  await expect(page.getByRole('heading', { name: 'Data Import' })).toBeVisible({ timeout: 30_000 });
  // A completed import is remembered across reloads; start a new one.
  const another = page.getByRole('button', { name: 'Upload Another File' });
  if (await another.isVisible()) await another.click();

  await page.locator('input[type="file"]').setInputFiles({
    name: `registrations-${shape}.csv`,
    mimeType: 'text/csv',
    buffer: Buffer.from(registrationCsv(shape)),
  });
  await page.getByRole('button', { name: 'Start Import' }).click();

  const applied = page.getByRole('heading', { name: /^Import Applied/ });
  const failed = page.getByTestId('import-error-banner');
  await expect(applied.or(failed)).toBeVisible({ timeout: BACKEND_TIMEOUT });
  await expect(failed).toHaveCount(0);
});

Then(
  'the import log reports {int} players inserted and {int} updated',
  async ({ page }, inserted: number, updated: number) => {
    await expect(page.getByTestId('import-log')).toContainText(
      `Roster database updated: ${inserted} inserted, ${updated} updated.`
    );
  }
);

Then(
  'players from across the export still list the guardian the full export gave them',
  async ({ page }) => {
    // Three players, from both ends and the middle of the export, each opened
    // from the Players grid as an administrator would.
    const all = registrations();
    for (const player of [all[0], all[11], all[all.length - 1]]) {
      await page.goto('/players');
      await page.getByRole('textbox', { name: 'Search table' }).fill(player.lastName);
      const row = page.getByRole('row').filter({ hasText: player.lastName });
      await expect(row).toHaveCount(1, { timeout: 30_000 });
      await row.getByRole('button', { name: 'Row actions' }).click();
      await page.getByRole('menuitem', { name: 'Open record' }).click();

      await page.getByRole('tab', { name: 'Guardians' }).click();
      await expect(page.getByText('No guardians on file.')).toHaveCount(0);
      await expect(page.getByText(player.guardianEmail)).toBeVisible();
      await expect(page.getByText(player.guardianName)).toBeVisible();
    }
  }
);

/** What a scenario learned from one page and checks on a later one. */
const scenarioState = new WeakMap<Page, { teams?: number }>();
const stateOf = (page: Page) => {
  const state = scenarioState.get(page) ?? {};
  scenarioState.set(page, state);
  return state;
};

When('I generate teams from the import and sync them to Supabase', async ({ page }) => {
  // In-app navigation, as an administrator moves on: the teams page builds
  // its programs from the import this session just applied.
  await page
    .getByRole('navigation')
    .getByRole('link', { name: /Teams & Rosters/ })
    .click();
  const generate = page.getByRole('button', { name: /Generate Teams/ });
  await expect(generate).toBeEnabled({ timeout: 30_000 });
  await generate.click();
  await expect(page.getByText(/Team review staged: \d+ teams?\./)).toBeVisible({
    timeout: 30_000,
  });

  await page.getByRole('button', { name: 'Sync to Supabase' }).click();
  const synced = page.getByText(/Supabase upsert completed for \d+ teams and \d+ players/);
  await expect(synced).toBeVisible({ timeout: BACKEND_TIMEOUT });
  const [, teams, players] =
    /for (\d+) teams and (\d+) players/.exec((await synced.textContent()) ?? '') ?? [];
  expect(Number(players), 'every imported player is placed on a team').toBe(registrations().length);
  expect(Number(teams)).toBeGreaterThan(1);
  stateOf(page).teams = Number(teams);
});

Then('the teams page lists the synced teams after a reload', async ({ page }) => {
  const teams = stateOf(page).teams;
  expect(teams, 'a previous step synced the teams').toBeGreaterThan(0);
  await page.goto('/teams');
  const list = page.getByRole('region', { name: 'Generated Teams' });
  await expect(list).toBeVisible({ timeout: 30_000 });
  // A rename control is offered only for a team with a persisted (uuid) id.
  await expect(list.getByRole('button', { name: /^Rename team / })).toHaveCount(teams ?? -1);
});

When('I auto-generate the practice schedule and apply it', async ({ page }) => {
  await page.goto('/schedule/practice');
  const run = page.getByRole('button', { name: 'Run auto-scheduler optimization' });
  await expect(run).toBeEnabled({ timeout: 60_000 });
  await run.click();

  const review = page.getByRole('region', { name: 'Practice schedule review' });
  await expect(review.getByText(/\d+ assignments are staged for persistence\./)).toBeVisible({
    timeout: BACKEND_TIMEOUT,
  });
  await review.getByRole('button', { name: 'Apply Schedule' }).click();
  await expect(review.getByRole('heading', { name: 'Practice Schedule Applied' })).toBeVisible({
    timeout: BACKEND_TIMEOUT,
  });
  await expect(review.getByRole('alert')).toHaveCount(0);
});

/** A CSV line's cells, honouring quoted cells (formatCsv quotes commas and quotes). */
function csvCells(line: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      cells.push(cell);
      cell = '';
    } else cell += ch;
  }
  cells.push(cell);
  return cells;
}

Then('the master schedule export lists a practice for every synced team', async ({ page }) => {
  const teams = stateOf(page).teams;
  expect(teams, 'a previous step synced the teams').toBeGreaterThan(0);
  await page.goto('/exports');
  await page.getByTestId('generate-csvs-btn').click();
  const download = page.getByRole('button', { name: 'Download Master CSV' });
  await expect(download).toBeVisible({ timeout: 30_000 });
  const [file] = await Promise.all([page.waitForEvent('download'), download.click()]);
  const text = await (await file.createReadStream()).toArray();
  const lines = Buffer.concat(text).toString('utf8').trim().split('\n');

  const header = csvCells(lines[0]);
  const teamId = header.indexOf('Team ID');
  const eventType = header.indexOf('Event Type');
  expect(teamId, `Team ID column in ${header.join(',')}`).toBeGreaterThanOrEqual(0);
  expect(eventType, `Event Type column in ${header.join(',')}`).toBeGreaterThanOrEqual(0);
  const practiceTeams = new Set(
    lines
      .slice(1)
      .map(csvCells)
      .filter((cells) => cells[eventType] === 'Practice')
      .map((cells) => cells[teamId])
  );
  expect(practiceTeams.size).toBe(teams);
});
