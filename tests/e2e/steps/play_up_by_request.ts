import { createBdd } from 'playwright-bdd';
import { expect, type Page } from '@playwright/test';
import { waitForMockClient } from './mockReady.js';
import { MOCK_ORG_ID } from '../../../frontend/src/lib/mockSeedIds.js';

const { Given, When, Then } = createBdd();

// Play-up by request (play_up_by_request.feature). Synthetic names only. Given steps seed the
// import the Teams page reads; Then steps read the page. Rows are the shape a GotSport import
// leaves in the session (`Birthdate`, `division`, and the play-up column).

type MockRow = Record<string, unknown>;
type MockDb = Record<string, MockRow[] | undefined>;

const uuid = (n: number) => `5eed0000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ASKED = { id: uuid(1), first: 'Pia', last: 'Askedup' };
const NOT_ASKED = { id: uuid(2), first: 'Quinn', last: 'Notasked' };
const BORN_10 = '2016-05-01';
const BORN_12 = '2014-05-01';

/** The rows seeded so far, by step, merged into one import. */
const seeded: MockRow[] = [];

async function writeImport(page: Page, rows: MockRow[]) {
  await waitForMockClient(page);
  await page.evaluate(
    ({ rows, createdAt, mockOrgId }) => {
      const db = window.__MOCK_DB__ as MockDb | undefined;
      if (!db) throw new Error('mock store not initialised');
      const orgId = localStorage.getItem('squadlogic_active_org') || mockOrgId;
      // The page offers Generate Teams only while no team run is in hand: retire the seed's.
      for (const run of db.scheduler_runs ?? []) {
        if (run.run_type === 'team' && run.organization_id === orgId) run.status = 'deleted';
      }
      // Ages are counted in 2026 by birth year.
      const season = (db.season_settings ?? []).find(
        (row) => row.organization_id === orgId && row.status === 'active'
      );
      if (!season) throw new Error(`no active season for ${orgId}`);
      season.season_year = 2026;
      season.age_cutoff_mode = 'birth_year';
      db.imports = [
        ...(db.imports ?? []).filter((row) => row.id !== 'import-play-up'),
        {
          id: 'import-play-up',
          user_id: 'mock-admin-id',
          organization_id: orgId,
          import_type: 'players',
          // Newer than the seed's import, so it is the one the page reads.
          created_at: createdAt,
          data: { totalRows: rows.length, validRows: rows.length, data: rows },
        },
      ];
      window.__saveMockDB__(db);
    },
    { rows, createdAt: new Date(Date.now() + 60_000).toISOString(), mockOrgId: MOCK_ORG_ID }
  );
}

const row = (
  id: string,
  first: string,
  last: string,
  division: string,
  birthdate: string,
  extra: MockRow = {}
): MockRow => ({
  id,
  'First Name': first,
  'Last Name': last,
  Birthdate: birthdate,
  Gender: 'm',
  division,
  ...extra,
});

Given(
  'the U12 Boys import lists Pia, who asked to play up, and Quinn, who did not, both aged 10, with {int} players aged 12',
  async ({ page }, count: number) => {
    seeded.length = 0;
    seeded.push(
      row(ASKED.id, ASKED.first, ASKED.last, 'U12 Boys', BORN_10, { 'Play Up': 'Yes' }),
      row(NOT_ASKED.id, NOT_ASKED.first, NOT_ASKED.last, 'U12 Boys', BORN_10),
      ...Array.from({ length: count }, (_, i) =>
        row(uuid(100 + i), 'Twelve', `Player${i + 1}`, 'U12 Boys', BORN_12)
      )
    );
    await writeImport(page, [...seeded]);
  }
);

Given('the U10 Boys import lists {int} players aged 10', async ({ page }, count: number) => {
  seeded.push(
    ...Array.from({ length: count }, (_, i) =>
      row(uuid(200 + i), 'Ten', `Player${i + 1}`, 'U10 Boys', BORN_10)
    )
  );
  await writeImport(page, [...seeded]);
});

When('I open the Teams page', async ({ page }) => {
  await page.goto('/teams');
  await expect(page.getByRole('heading', { name: /Teaming & Analysis/i }).first()).toBeVisible({
    timeout: 15000,
  });
});

const section = (page: Page) => page.getByRole('region', { name: 'Play-up', exact: true });
const rowFor = (page: Page, name: string) =>
  section(page)
    .getByRole('row')
    .filter({ has: page.getByRole('rowheader', { name }) });

Then('Pia is on a U12 Boys team and Quinn is on no U12 Boys team', async ({ page }) => {
  await expect(page.getByText(/Team review staged:/)).toBeVisible({ timeout: 20000 });
  // The staged run's rosters, read from the page's own review store: who is seated is the
  // generator's answer, never one written for it.
  const seated = await page.evaluate(() => {
    const key = Object.keys(sessionStorage).find((k) => k.startsWith('squadlogic:team-review:'));
    const staged = key ? JSON.parse(sessionStorage.getItem(key) || 'null') : null;
    const results = staged?.snapshot?.runMetadata?.results;
    return {
      ids: (results?.team_players ?? []).map((tp: { player_id: string }) => tp.player_id),
      programs: Object.keys(results?.teamsByDivision ?? {}),
    };
  });
  // Meta-assertion: the run seated the U12 program's players (8 aged 12 and Pia), so a missing
  // Quinn is a real absence.
  expect(seated.ids.length).toBe(9);
  expect(seated.ids).toContain(ASKED.id);
  expect(seated.ids).not.toContain(NOT_ASKED.id);
  await expect(
    page.locator('section[aria-label="Generated Teams"]').getByText('U12 Boys').first()
  ).toBeVisible({ timeout: 15000 });
});

Then(
  'the Play-up section lists Pia as a requested play-up that plays in U12 Boys',
  async ({ page }) => {
    await expect(section(page)).toBeVisible({ timeout: 15000 });
    const pia = rowFor(page, `${ASKED.first} ${ASKED.last}`);
    await expect(pia).toHaveCount(1);
    await expect(pia).toContainText('Requested');
    await expect(pia).toContainText('Plays in U12 Boys, the older division they registered for.');
  }
);

Then(
  'the Play-up section lists Quinn as registered in U12 Boys but playing in U10 Boys with no request',
  async ({ page }) => {
    const quinn = rowFor(page, `${NOT_ASKED.first} ${NOT_ASKED.last}`);
    await expect(quinn).toHaveCount(1);
    await expect(quinn).toContainText('Not requested');
    await expect(quinn).toContainText(
      'Registered in U12 Boys but plays in U10 Boys (no play-up request).'
    );
    // Enumerated from the table, not from the summary: exactly the two players are listed.
    await expect(section(page).getByRole('rowheader')).toHaveCount(2);
  }
);
