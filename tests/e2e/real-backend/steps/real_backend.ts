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
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, type APIResponse, type Page } from '@playwright/test';
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
  // A completed import is remembered across reloads; start a new one. Wait
  // for the panel to settle on one state or the other before choosing.
  const fileInput = page.locator('input[type="file"]');
  const another = page.getByRole('button', { name: 'Upload Another File' });
  await expect(fileInput.or(another).first()).toBeAttached({ timeout: 30_000 });
  if (await another.isVisible()) {
    await another.click();
    await expect(fileInput).toBeAttached();
  }

  await fileInput.setInputFiles({
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
const scenarioState = new WeakMap<Page, { teams?: number; teamNames?: string[] }>();
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

  // The page's own success line does not survive the sync: the staged review
  // is cleared and, until a reload, the page falls back to its generate view
  // (recorded in the plan, M4.1's discoveries). So the sync is read from the
  // team-persistence response, and the next step proves it on a reload.
  const [response] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes('/functions/v1/team-persistence') && r.request().method() === 'POST',
      { timeout: BACKEND_TIMEOUT }
    ),
    page.getByRole('button', { name: 'Sync to Supabase' }).click(),
  ]);
  const body = (await response.json()) as {
    status?: string;
    message?: string;
    updatedTeams?: number;
    updatedPlayers?: number;
  };
  expect(response.status(), body.message).toBe(200);
  expect(body.status, body.message).toBe('success');
  expect(body.updatedPlayers, 'every imported player is placed on a team').toBe(
    registrations().length
  );
  expect(body.updatedTeams).toBeGreaterThan(1);
  stateOf(page).teams = body.updatedTeams;
});

Then('the teams page lists the synced teams after a reload', async ({ page }) => {
  const teams = stateOf(page).teams;
  expect(teams, 'a previous step synced the teams').toBeGreaterThan(0);
  await page.goto('/teams');
  const list = page.getByRole('region', { name: 'Generated Teams' });
  await expect(list).toBeVisible({ timeout: 30_000 });
  // A rename control is offered only for a team with a persisted (uuid) id.
  const renames = list.getByRole('button', { name: /^Rename team / });
  await expect(renames).toHaveCount(teams ?? -1);
  const labels = await renames.evaluateAll((buttons) =>
    buttons.map((b) => b.getAttribute('aria-label') ?? '')
  );
  stateOf(page).teamNames = labels.map((label) => label.replace(/^Rename team /, ''));
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

/** Rows of a CSV, honouring quoted cells, quotes and newlines inside them (formatCsv's escaping). */
function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

Then('the master schedule export lists a practice for every synced team', async ({ page }) => {
  const teamNames = stateOf(page).teamNames ?? [];
  expect(teamNames.length, 'a previous step read the synced teams').toBeGreaterThan(1);
  await page.goto('/exports');
  await page.getByTestId('generate-csvs-btn').click();
  const download = page.getByRole('button', { name: 'Download Master CSV' });
  await expect(download).toBeVisible({ timeout: 30_000 });
  const [file] = await Promise.all([page.waitForEvent('download'), download.click()]);
  const chunks = await (await file.createReadStream()).toArray();
  const [header, ...rows] = csvRows(Buffer.concat(chunks).toString('utf8'));

  const teamName = header.indexOf('Team Name');
  const eventType = header.indexOf('Event Type');
  expect(teamName, `Team Name column in ${header.join(',')}`).toBeGreaterThanOrEqual(0);
  expect(eventType, `Event Type column in ${header.join(',')}`).toBeGreaterThanOrEqual(0);
  const practiced = rows
    .filter((cells) => cells[eventType] === 'Practice')
    .map((cells) => cells[teamName]);
  expect(practiced.length, 'practice rows in the master CSV').toBeGreaterThan(0);
  // The same teams, by name, as the teams page listed after the sync: none
  // missing, none unnamed, none the page did not show.
  expect([...new Set(practiced)].sort()).toEqual([...teamNames].sort());
});

/** The local stack's API, as the job exported it (playwright.config.ts). */
function stackUrl(): string {
  const url = process.env.E2E_REAL_BACKEND_SUPABASE_URL?.replace(/\/+$/, '');
  if (!url) throw new Error('E2E_REAL_BACKEND_SUPABASE_URL is not set');
  return url;
}

/**
 * Every function supabase/config.toml declares, with its verify_jwt flag: the
 * registry the deploy job reads, so a function added there is covered here
 * without anyone remembering to list it.
 */
function configuredFunctions(): { name: string; verifyJwt: boolean }[] {
  const toml = readFileSync(path.resolve('supabase/config.toml'), 'utf8');
  const found: { name: string; verifyJwt: boolean }[] = [];
  let current: { name: string; verifyJwt: boolean } | null = null;
  for (const line of toml.split('\n')) {
    const header = /^\[(.+)\]\s*$/.exec(line.trim());
    if (header) {
      const fn = /^functions\.([\w-]+)$/.exec(header[1]);
      current = fn ? { name: fn[1], verifyJwt: false } : null;
      if (current) found.push(current);
      continue;
    }
    const flag = /^verify_jwt\s*=\s*(true|false)\s*$/.exec(line.trim());
    if (current && flag) current.verifyJwt = flag[1] === 'true';
  }
  return found;
}

const edgeFindings = new WeakMap<object, string[]>();

When(
  'I call, as a caller with no session, every function the Supabase config marks verify_jwt',
  async ({ request }) => {
    const gated = configuredFunctions().filter((fn) => fn.verifyJwt);
    // Enumerated from the config, so an empty list is a parse failure, not a pass.
    expect(gated.length, 'verify_jwt functions found in supabase/config.toml').toBeGreaterThan(4);
    const anonKey = process.env.E2E_REAL_BACKEND_ANON_KEY ?? '';
    const findings: string[] = [];
    for (const fn of gated) {
      // What supabase-js sends with no session: the anon key as the bearer.
      // It passes the gateway's JWT check, so the function itself must boot
      // and refuse; a gateway 401 alone would pass a function that cannot boot.
      const response = await request.post(`${stackUrl()}/functions/v1/${fn.name}`, {
        headers: {
          'Content-Type': 'application/json',
          apikey: anonKey,
          Authorization: `Bearer ${anonKey}`,
        },
        data: {},
        timeout: BACKEND_TIMEOUT,
      });
      const text = await response.text();
      let refusal: unknown;
      try {
        const body = JSON.parse(text) as { message?: unknown; error?: unknown };
        refusal = body.message ?? body.error;
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        refusal = undefined;
      }
      if (response.status() !== 401 || refusal !== 'Unauthorized') {
        findings.push(`${fn.name}: ${response.status()} ${text.slice(0, 200)}`);
      }
    }
    edgeFindings.set(request, findings);
  }
);

Then('each one refuses it itself, as unauthorized', async ({ request }) => {
  const findings = edgeFindings.get(request);
  expect(findings, 'a previous step called the functions').toBeDefined();
  expect(findings).toEqual([]);
});

Then(
  'calendar-feed, which config.toml leaves open, answers an unknown token with a 404',
  async ({ request }) => {
    const feed = configuredFunctions().find((fn) => fn.name === 'calendar-feed');
    expect(feed, 'calendar-feed in supabase/config.toml').toBeDefined();
    expect(feed?.verifyJwt).toBe(false);
    const response = await request.get(
      `${stackUrl()}/functions/v1/calendar-feed?token=e2e-unknown-calendar-token`,
      { timeout: BACKEND_TIMEOUT }
    );
    expect(response.status(), await response.text()).toBe(404);
  }
);

const preflights = new WeakMap<object, APIResponse>();

When('I send a CORS preflight to the {string} Edge Function', async ({ request }, name: string) => {
  const response = await request.fetch(`${stackUrl()}/functions/v1/${name}`, {
    method: 'OPTIONS',
    headers: {
      Origin: 'http://localhost:5174',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'authorization, apikey, content-type',
    },
    timeout: BACKEND_TIMEOUT,
  });
  preflights.set(request, response);
});

Then('the preflight allows the headers the app sends', async ({ request }) => {
  const response = preflights.get(request);
  expect(response, 'a previous step sent the preflight').toBeDefined();
  expect(response?.status()).toBeLessThan(300);
  const headers = response?.headers() ?? {};
  expect(headers['access-control-allow-origin']).toBeTruthy();
  const allowed = (headers['access-control-allow-headers'] ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase());
  for (const header of ['authorization', 'apikey', 'content-type']) {
    expect(allowed, `Access-Control-Allow-Headers: ${allowed.join(', ')}`).toContain(header);
  }
});
