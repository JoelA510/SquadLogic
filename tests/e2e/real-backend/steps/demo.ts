/**
 * Steps for real_backend_demo.feature (plan docs/changes/2026-10-22-demo-mode.md, D4): the demo
 * on the local stack. As in real_backend.ts, every check reads the page or the visitor's own
 * session through the stack's APIs, under the same RLS; the one exception is the last step, which
 * stands in for time passing and the cron job (the stack runs without pg_cron's schedule): the
 * stack's own service key moves the expiry back and runs `purge_expired_demos()`, as the job does.
 * The key is the local stack's, generated per run (`supabase status`), and reaches no other
 * environment.
 *
 * Statically reviewed, not run: the Supabase CLI is not available where this was written. The
 * workflow that runs it is .github/workflows/e2e-real-backend.yml.
 */
import { createBdd } from 'playwright-bdd';
import { expect, type Page } from '@playwright/test';

const { Given, When, Then } = createBdd();

const BACKEND_TIMEOUT = 120_000;

const scenario = new WeakMap<
  Page,
  { organizationId?: string; userId?: string; u4DivisionId?: string; playerId?: string }
>();
const stateOf = (page: Page) => {
  const state = scenario.get(page) ?? {};
  scenario.set(page, state);
  return state;
};

function stackUrl(): string {
  const url = process.env.E2E_REAL_BACKEND_SUPABASE_URL?.replace(/\/+$/, '');
  if (!url) throw new Error('E2E_REAL_BACKEND_SUPABASE_URL is not set');
  return url;
}

/** The visitor's access token, as the app's own client stored it. */
async function visitorSession(
  page: Page
): Promise<{ token: string; userId: string; anonKey: string }> {
  const stored = await page.evaluate(() => {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i) ?? '';
      if (key.startsWith('sb-') && key.endsWith('-auth-token')) return localStorage.getItem(key);
    }
    return null;
  });
  expect(stored, 'the app stored a session').not.toBeNull();
  const session = JSON.parse(stored as string) as {
    access_token?: string;
    user?: { id?: string; is_anonymous?: boolean };
  };
  expect(session.user?.is_anonymous, 'the session is an anonymous one').toBe(true);
  return {
    token: session.access_token ?? '',
    userId: session.user?.id ?? '',
    anonKey: process.env.E2E_REAL_BACKEND_ANON_KEY ?? '',
  };
}

/** A PostgREST read as the visitor; returns the rows and the exact count. */
async function visitorRows(page: Page, pathAndQuery: string) {
  const { token, anonKey } = await visitorSession(page);
  const response = await page.request.get(`${stackUrl()}/rest/v1/${pathAndQuery}`, {
    headers: { apikey: anonKey, Authorization: `Bearer ${token}`, Prefer: 'count=exact' },
    timeout: BACKEND_TIMEOUT,
  });
  const rows = (await response.json()) as Record<string, unknown>[];
  expect(response.status(), JSON.stringify(rows).slice(0, 1000)).toBeLessThan(300);
  const range = response.headers()['content-range'] ?? '';
  const count = Number(range.split('/')[1]);
  return { rows, count: Number.isFinite(count) ? count : rows.length };
}

Given('I am signed out on the real-backend sign-in page', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Try the demo' })).toBeVisible({ timeout: 30_000 });
});

When('I try the demo', async ({ page, $testInfo }) => {
  // The scenario schedules the whole 128-team league on the real stack: well over the project's
  // default per-test time. Unmeasured (the stack could not be run where this was written).
  $testInfo.setTimeout(600_000);
  await page.getByRole('button', { name: 'Try the demo' }).click();
});

Then('the demo league is open with its timer', async ({ page }) => {
  await expect(page.getByRole('timer')).toBeVisible({ timeout: BACKEND_TIMEOUT });
  await expect(page.getByRole('timer')).toContainText('Demo league');
  await expect(
    page.getByRole('button', { name: /^Active Organization: Demo league/ })
  ).toBeVisible();
  const { userId } = await visitorSession(page);
  const orgs = await visitorRows(page, 'organizations?select=id,demo_expires_at,demo_owner');
  expect(orgs.rows).toHaveLength(1);
  expect(orgs.rows[0].demo_owner).toBe(userId);
  expect(orgs.rows[0].demo_expires_at).toBeTruthy();
  const state = stateOf(page);
  state.organizationId = String(orgs.rows[0].id);
  state.userId = userId;
});

Then(
  'the visitor can read {int} teams, {int} players and {int} coaches in it',
  async ({ page }, teams: number, players: number, coaches: number) => {
    const org = stateOf(page).organizationId;
    expect(org, 'a previous step found the demo').toBeTruthy();
    for (const [table, expected] of [
      ['teams', teams],
      ['players', players],
      ['coaches', coaches],
    ] as const) {
      const { count } = await visitorRows(
        page,
        `${table}?select=id&organization_id=eq.${org}&limit=1`
      );
      expect(count, `${table} in the demo`).toBe(expected);
    }
  }
);

Then('the U4 teams practise only in the four reserved Saturday sessions', async ({ page }) => {
  const org = stateOf(page).organizationId;
  const divisions = await visitorRows(
    page,
    `divisions?select=id,name,plays_games&organization_id=eq.${org}&name=eq.U4`
  );
  expect(divisions.rows, 'U4 exists in the demo').toHaveLength(1);
  expect(divisions.rows[0].plays_games).toBe(false);
  const u4 = String(divisions.rows[0].id);
  stateOf(page).u4DivisionId = u4;

  const reserved = await visitorRows(
    page,
    `practice_slots?select=id,day_of_week,start_time,end_time&organization_id=eq.${org}&division_id=eq.${u4}`
  );
  expect(reserved.rows, 'U4 has four reserved sessions').toHaveLength(4);
  const reservedIds = new Set(reserved.rows.map((slot) => String(slot.id)));

  const teams = await visitorRows(
    page,
    `teams?select=id&organization_id=eq.${org}&division_id=eq.${u4}`
  );
  expect(teams.rows.length, 'U4 has teams').toBeGreaterThan(0);
  const ids = teams.rows.map((team) => String(team.id)).join(',');
  const assignments = await visitorRows(
    page,
    `practice_assignments?select=team_id,slot_id,practice_slot_id&organization_id=eq.${org}&team_id=in.(${ids})`
  );
  // Every U4 team practises, and only in a session reserved to U4.
  expect(new Set(assignments.rows.map((row) => String(row.team_id))).size).toBe(teams.rows.length);
  for (const row of assignments.rows) {
    // The writer fills one of the two slot columns (definitive_schema.sql keeps both).
    const slot = String(row.practice_slot_id ?? row.slot_id);
    expect(reservedIds.has(slot), `slot ${slot} is reserved to U4`).toBe(true);
  }
});

Then('the game page lists U4 as practice only', async ({ page }) => {
  await page.goto('/schedule/game');
  const panel = page.getByRole('region', { name: 'Practice only' });
  await expect(panel).toBeVisible({ timeout: 60_000 });
  await expect(panel.getByRole('listitem').filter({ hasText: /^U4 /u })).toHaveCount(1);
  await expect(page.getByRole('timer')).toBeVisible();
});

When("I change a demo player's status on the players page", async ({ page }) => {
  await page.goto('/players');
  const grid = page.getByRole('grid', { name: 'Players grid' });
  await expect(grid).toBeVisible({ timeout: 60_000 });
  // The grid is virtualised or paged for 1,259 rows: search for one player and change that row.
  const first = await visitorRows(
    page,
    `players?select=id,first_name,last_name,status&organization_id=eq.${stateOf(page).organizationId}&status=eq.active&order=last_name,first_name&limit=1`
  );
  expect(first.rows, 'an active player to change').toHaveLength(1);
  const player = first.rows[0];
  stateOf(page).playerId = String(player.id);
  await page
    .getByRole('searchbox')
    .or(page.getByPlaceholder(/search/i))
    .first()
    .fill(`${player.first_name} ${player.last_name}`);
  await grid.getByText('active', { exact: true }).first().dblclick();
  const select = grid.getByRole('combobox', { name: 'Status' });
  await select.selectOption('inactive');
  await select.press('Enter');
  await expect(
    page.getByText('Saved').or(grid.getByText('inactive', { exact: true }).first())
  ).toBeVisible({
    timeout: BACKEND_TIMEOUT,
  });
});

Then('the server has the new status', async ({ page }) => {
  const playerId = stateOf(page).playerId;
  expect(playerId, 'a previous step chose a player').toBeTruthy();
  await expect
    .poll(
      async () =>
        (await visitorRows(page, `players?select=status&id=eq.${playerId}`)).rows[0]?.status,
      {
        timeout: 30_000,
      }
    )
    .toBe('inactive');
});

Then('the server refuses to rename a demo player', async ({ page }) => {
  const playerId = stateOf(page).playerId;
  const { token, anonKey } = await visitorSession(page);
  const response = await page.request.patch(`${stackUrl()}/rest/v1/players?id=eq.${playerId}`, {
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    data: { first_name: 'Renamed' },
    timeout: BACKEND_TIMEOUT,
  });
  const body = (await response.json()) as { code?: string; details?: string };
  expect(response.status(), JSON.stringify(body)).toBeGreaterThanOrEqual(400);
  expect(body.code).toBe('42501');
  expect(body.details).toBe('demo_read_only');
  const after = await visitorRows(page, `players?select=first_name&id=eq.${playerId}`);
  expect(after.rows[0].first_name).not.toBe('Renamed');
});

When('I try to browse for an import file in the demo', async ({ page }) => {
  await page.goto('/import');
  await expect(page.getByText('Drag and drop your CSV file here')).toBeVisible({ timeout: 60_000 });
  await page.getByText('browse files').click();
});

Then('the import notice opens instead of the file picker', async ({ page }) => {
  await expect(
    page.getByRole('dialog', { name: 'Importing is turned off in the demo' })
  ).toBeVisible();
});

When("the demo's time is up and the purge runs", async ({ page }) => {
  const service = process.env.E2E_REAL_BACKEND_SERVICE_KEY ?? '';
  expect(service, 'the workflow exports the stack service key').not.toBe('');
  const org = stateOf(page).organizationId;
  const headers = {
    apikey: service,
    Authorization: `Bearer ${service}`,
    'Content-Type': 'application/json',
  };
  // Time passing: the demo ended a minute ago.
  const expire = await page.request.patch(`${stackUrl()}/rest/v1/organizations?id=eq.${org}`, {
    headers,
    data: { demo_expires_at: new Date(Date.now() - 60_000).toISOString() },
    timeout: BACKEND_TIMEOUT,
  });
  expect(expire.status(), await expire.text()).toBeLessThan(300);
  // The cron job's call.
  const purge = await page.request.post(`${stackUrl()}/rest/v1/rpc/purge_expired_demos`, {
    headers,
    data: {},
    timeout: BACKEND_TIMEOUT,
  });
  expect(purge.status(), await purge.text()).toBeLessThan(300);
});

Then('the demo league and its visitor are gone', async ({ page }) => {
  const service = process.env.E2E_REAL_BACKEND_SERVICE_KEY ?? '';
  const state = stateOf(page);
  const headers = { apikey: service, Authorization: `Bearer ${service}` };
  const org = await page.request.get(
    `${stackUrl()}/rest/v1/organizations?id=eq.${state.organizationId}&select=id`,
    { headers, timeout: BACKEND_TIMEOUT }
  );
  expect(await org.json()).toEqual([]);
  for (const table of ['teams', 'players', 'coaches', 'practice_slots']) {
    const rows = await page.request.get(
      `${stackUrl()}/rest/v1/${table}?organization_id=eq.${state.organizationId}&select=id&limit=1`,
      { headers, timeout: BACKEND_TIMEOUT }
    );
    expect(await rows.json(), `${table} of the purged demo`).toEqual([]);
  }
  const user = await page.request.get(`${stackUrl()}/auth/v1/admin/users/${state.userId}`, {
    headers,
    timeout: BACKEND_TIMEOUT,
  });
  expect(user.status(), 'the anonymous visitor is deleted with their demo').toBe(404);
});
