/**
 * Steps for the real-backend project (plan item M4.1): the app's real Supabase
 * client against a local stack (`supabase start`, seeded by
 * tests/e2e/real-backend/seed.sql), with the Edge Functions that stack serves.
 *
 * Every assertion reads the page, or, where the app has no screen for it (the
 * exports bucket's listing, the audit log), the seeded administrator's own
 * session through the stack's APIs, under the same RLS and Storage policies
 * (`adminSession`). Nothing here touches sessionStorage, the mock's
 * `__MOCK_DB__`, or the database directly: what the scenarios prove is that
 * the app, through its own client, RPCs and Edge Functions, does what it
 * shows.
 */
import { createBdd } from 'playwright-bdd';
import { readFileSync } from 'node:fs';
import path from 'node:path';
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
  // A completed import is remembered across reloads; start a new one. Wait
  // for the panel to settle on one state or the other before choosing. No
  // retry: a reset panel that is put back to "Import Applied" is the defect
  // PR #578 fixed in ImportContext, and this step must fail on it.
  const fileInput = page.locator('input[type="file"]');
  const another = page.getByRole('button', { name: 'Upload Another File' });
  await expect(fileInput.or(another).first()).toBeAttached({ timeout: 30_000 });
  if (await another.isVisible()) {
    await another.click();
    await expect(fileInput).toBeAttached();
  }
  // The import audit rows already on file, so the Then step can tell this
  // import's rows from the ones earlier imports wrote.
  stateOf(page).auditBefore = new Set((await importAuditRows(page)).map((row) => row.id));
  await fileInput.setInputFiles({
    name: `registrations-${shape}.csv`,
    mimeType: 'text/csv',
    buffer: Buffer.from(registrationCsv(shape)),
  });
  await page.getByRole('button', { name: 'Start Import' }).click({ timeout: 30_000 });

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

/**
 * The audit actions a player import writes, each as the caller:
 * import-validation's (`recordAuditNow`, made with the caller's client since
 * #577; with the service-role client every one was refused on
 * `audit_log.user_id NOT NULL`, and only logged), and finalize_import_job's.
 * `create_import_job` also writes an `import.started` row, with the file's
 * name and no row counts; the counts are how the Edge's row is told apart.
 */
const IMPORT_AUDIT = { validated: 'import.started', applied: 'import.completed' } as const;

type AuditRow = {
  id: string;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  user_id: string | null;
  organization_id: string;
  metadata: Record<string, unknown> | null;
};

/** The organization's import audit rows, read as the administrator (RLS: admins read the audit log). */
async function importAuditRows(page: Page): Promise<AuditRow[]> {
  const { token, anonKey } = await adminSession(page);
  const query = new URLSearchParams({
    select: 'id,action,resource_type,resource_id,user_id,organization_id,metadata',
    organization_id: `eq.${SEEDED_ADMIN.organizationId}`,
    action: `in.(${Object.values(IMPORT_AUDIT).join(',')})`,
  });
  const response = await page.request.get(`${stackUrl()}/rest/v1/audit_log?${query}`, {
    headers: { apikey: anonKey, Authorization: `Bearer ${token}` },
    timeout: BACKEND_TIMEOUT,
  });
  const body = (await response.json()) as AuditRow[];
  expect(response.status(), JSON.stringify(body)).toBe(200);
  return body;
}

Then('the audit log records the import as the administrator', async ({ page }) => {
  const before = stateOf(page).auditBefore;
  expect(before, 'the import step read the audit log before it started').toBeDefined();
  const fresh = (await importAuditRows(page)).filter((row) => !before?.has(row.id));
  const seen = JSON.stringify(fresh);
  const total = registrations().length;

  // import-validation's row: one, attributed to the administrator, counting
  // every row of the export as valid.
  const validated = fresh.filter(
    (row) => row.action === IMPORT_AUDIT.validated && row.metadata?.total_rows !== undefined
  );
  expect(
    validated.map((row) => ({
      resource_type: row.resource_type,
      user_id: row.user_id,
      import_type: row.metadata?.import_type,
      total_rows: row.metadata?.total_rows,
      valid_rows: row.metadata?.valid_rows,
      error_rows: row.metadata?.error_rows,
    })),
    `import-validation's ${IMPORT_AUDIT.validated} row, among this import's audit rows: ${seen}`
  ).toEqual([
    {
      resource_type: 'import_job',
      user_id: SEEDED_ADMIN.userId,
      import_type: 'players',
      total_rows: total,
      valid_rows: total,
      error_rows: 0,
    },
  ]);

  // finalize_import_job's rows, for the job it applied: its own, counting the
  // players it wrote, and one per later stage (`metadata.stage`, e.g. the
  // buddy pairs). Every one attributed to the administrator, for one job.
  const applied = fresh.filter((row) => row.action === IMPORT_AUDIT.applied);
  const finalized = applied.filter((row) => row.metadata?.stage === undefined);
  expect(
    finalized.map((row) => ({
      resource_type: row.resource_type,
      user_id: row.user_id,
      status: row.metadata?.status,
      promoted_rows: row.metadata?.promoted_rows,
    })),
    `finalize_import_job's ${IMPORT_AUDIT.applied} row, among: ${seen}`
  ).toEqual([
    {
      resource_type: 'import_job',
      user_id: SEEDED_ADMIN.userId,
      status: 'completed',
      promoted_rows: total,
    },
  ]);
  const job = finalized[0].resource_id;
  expect(job, 'the applied job').toBeTruthy();
  for (const row of applied) {
    expect([row.user_id, row.resource_id], `every ${IMPORT_AUDIT.applied} row: ${seen}`).toEqual([
      SEEDED_ADMIN.userId,
      job,
    ]);
  }
  stateOf(page).auditBefore = undefined;
});

/** What a scenario learned from one page and checks on a later one. */
const scenarioState = new WeakMap<
  Page,
  { teams?: number; teamNames?: string[]; auditBefore?: Set<string> }
>();
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

  // The sync is read from the team-persistence response, and the next step
  // proves it on a reload. The page's own success line survives the sync too
  // (Wave 3: it used to fall back to its generate view until a reload).
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
  await expect(
    page.getByText(
      `Team review applied. ${body.updatedTeams} teams and ${body.updatedPlayers} players synced to Supabase.`
    )
  ).toBeVisible({ timeout: 30_000 });
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

/** The Exports panel's upload line, whichever it is now: uploading, uploaded or failed. */
async function uploadStatus(page: Page): Promise<string> {
  const lines = await page
    .getByText(/^(Uploading to Storage\.\.\.|Uploaded \d+ files|Upload failed:)/)
    .allInnerTexts();
  return lines.join(' | ');
}

When("an upload to Storage is refused for one team's file", async ({ page }) => {
  const teamNames = stateOf(page).teamNames ?? [];
  expect(teamNames.length, 'a previous step read the synced teams').toBeGreaterThan(1);
  // The first team file's upload is answered as Storage answers a refusal;
  // every other request, the cleanup's DELETE included, reaches the stack.
  let refused = 0;
  const teamUpload = (url: URL) =>
    url.pathname.includes('/storage/v1/object/exports/') && url.pathname.includes('/teams/');
  await page.route(teamUpload, async (route) => {
    if (route.request().method() !== 'POST' || refused > 0) return route.continue();
    refused += 1;
    return route.fulfill({
      status: 403,
      contentType: 'application/json',
      body: JSON.stringify({
        statusCode: '403',
        error: 'Unauthorized',
        message: 'refused by the scenario (one team file)',
      }),
    });
  });
  try {
    await page.getByRole('button', { name: 'Upload to Storage' }).click();
    await expect
      .poll(() => uploadStatus(page), { timeout: BACKEND_TIMEOUT })
      .toMatch(/^Upload failed:/);
  } finally {
    await page.unroute(teamUpload);
  }
  expect(refused, 'exactly one team file was refused').toBe(1);
  const status = await uploadStatus(page);
  expect(status).toContain(`Upload failed: 1 of ${teamNames.length + 1} files were not uploaded (`);
  expect(status).toContain('refused by the scenario (one team file)');
  expect(status).toContain(
    `The ${teamNames.length} that uploaded were removed, so nothing was published. ` +
      'No published baseline was recorded.'
  );
});

When('I upload the exports to Storage', async ({ page }) => {
  const teamNames = stateOf(page).teamNames ?? [];
  expect(teamNames.length, 'a previous step read the synced teams').toBeGreaterThan(1);
  // On /exports with the CSVs generated, as the previous step left it.
  await page.getByRole('button', { name: 'Upload to Storage' }).click();
  // Polled, so a failure is reported in the page's own words, and a line
  // left by an earlier attempt is not taken for this one's.
  await expect
    .poll(() => uploadStatus(page), { timeout: BACKEND_TIMEOUT })
    .toMatch(/^Uploaded \d+ files to 'exports' bucket\./);
  const uploaded = page.getByText(/Uploaded \d+ files to 'exports' bucket\./);
  // The master CSV and one per synced team, and the publication recorded.
  await expect(uploaded).toContainText(
    `Uploaded ${teamNames.length + 1} files to 'exports' bucket. Recorded as published baseline v`
  );
});

/**
 * The seeded administrator's own session on the stack, signed in through the
 * auth API with the seed's password: what a read the page offers no screen
 * for is made as (the exports bucket's listing, the audit log). Every such
 * read goes through the same RLS and Storage policies as the app's.
 */
const adminSessions = new WeakMap<Page, { token: string; anonKey: string }>();
async function adminSession(page: Page): Promise<{ token: string; anonKey: string }> {
  // One sign-in per scenario: the stack allows 30 a 5 minutes per address.
  const cached = adminSessions.get(page);
  if (cached) return cached;
  const anonKey = process.env.E2E_REAL_BACKEND_ANON_KEY ?? '';
  const response = await page.request.post(`${stackUrl()}/auth/v1/token?grant_type=password`, {
    headers: { apikey: anonKey, 'Content-Type': 'application/json' },
    data: { email: SEEDED_ADMIN.email, password: SEEDED_ADMIN.password },
    timeout: BACKEND_TIMEOUT,
  });
  const body = (await response.json()) as { access_token?: string; user?: { id?: string } };
  expect(response.status(), JSON.stringify(body)).toBe(200);
  expect(body.user?.id, 'the session is the seeded administrator').toBe(SEEDED_ADMIN.userId);
  const session = { token: body.access_token ?? '', anonKey };
  adminSessions.set(page, session);
  return session;
}

/**
 * The objects (not folders) directly in the `folder` of the exports bucket, as
 * the admin lists them (supabase-js `list(folder)`'s request).
 */
async function listExports(page: Page, folder: string): Promise<string[]> {
  const { token, anonKey } = await adminSession(page);
  const response = await page.request.post(`${stackUrl()}/storage/v1/object/list/exports`, {
    headers: { apikey: anonKey, Authorization: `Bearer ${token}` },
    data: { prefix: folder, limit: 1000, offset: 0, sortBy: { column: 'name', order: 'asc' } },
    timeout: BACKEND_TIMEOUT,
  });
  const body = (await response.json()) as { name: string; id: string | null }[];
  expect(response.status(), JSON.stringify(body)).toBe(200);
  // A folder is listed with a null id.
  return body.filter((entry) => entry.id !== null).map((entry) => entry.name);
}

Then('none of those files is left in the exports bucket', async ({ page }) => {
  // Read with the admin's session through the Storage API, which is also the
  // path the cleanup's DELETE took (the bucket's admin DELETE policy).
  const org = SEEDED_ADMIN.organizationId;
  expect(await listExports(page, org), `master CSVs under ${org}/`).toEqual([]);
  expect(await listExports(page, `${org}/teams`), `team files under ${org}/teams/`).toEqual([]);
});

Then(
  "the exports bucket holds the master schedule and a file per synced team, under the organization's folder",
  async ({ page }) => {
    const teamNames = stateOf(page).teamNames ?? [];
    expect(teamNames.length, 'a previous step read the synced teams').toBeGreaterThan(1);
    const org = SEEDED_ADMIN.organizationId;
    const masters = await listExports(page, org);
    expect(masters, `the master CSV under ${org}/`).toEqual([
      expect.stringMatching(/^master-schedule-[\dT-]+Z\.csv$/),
    ]);
    const stamp = masters[0].replace(/^master-schedule-/, '');
    const teamFiles = await listExports(page, `${org}/teams`);
    // One per synced team, each carrying the master's stamp: the same upload.
    expect(teamFiles).toHaveLength(teamNames.length);
    for (const name of teamFiles) {
      expect(name.endsWith(`-${stamp}`), `${name} carries the stamp ${stamp}`).toBe(true);
    }
  }
);

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
