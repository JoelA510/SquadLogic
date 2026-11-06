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

/**
 * What the overview, the Play-up section and the roster list each said about who plays up, read from
 * the page by the steps below and compared at the end: the three are counts of the same seats, so the
 * numbers must match without any of them being written into the scenario twice.
 */
const counted: { overview: number | null; section: number | null } = {
  overview: null,
  section: null,
};

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
    counted.overview = null;
    counted.section = null;
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
  // The rosters as the roster editor renders them: who is seated is the generator's answer,
  // read from the page, never one written for it.
  const edit = page.getByRole('button', { name: 'Edit Mode' });
  if (await edit.isVisible()) await edit.click();
  const columns = page.getByTestId(/^team-column-/);
  await expect(columns.first()).toBeVisible({ timeout: 15000 });
  // Meta-assertion: the U12 program's own players are on the rendered rosters, so a missing
  // Quinn is a real absence and not an editor that has not rendered.
  const twelve = page.getByTestId(`player-card-${uuid(100)}`);
  await expect(twelve).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId(`player-card-${ASKED.id}`)).toHaveCount(1);
  // Pia is on the same team as the U12 players: she plays in the division she registered for.
  await expect(
    columns.filter({ has: page.getByTestId(`player-card-${ASKED.id}`) }).filter({ has: twelve })
  ).toHaveCount(1);
  await expect(page.getByTestId(`player-card-${NOT_ASKED.id}`)).toHaveCount(0);
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

// ---- The overview, the Play-up section and the roster list count the same play-ups (PR 2) ----

/**
 * A program of the season's own and a division in it, saved with its age band: what Settings >
 * Season > Programs and the division rules leave in the database. The mock reads them as the
 * Teams page's `programs` and `divisions` reads do.
 */
Given(
  'the season has the program {string} holding {string}, a division for ages {int} to {int}',
  async ({ page }, programName: string, divisionName: string, minAge: number, maxAge: number) => {
    await waitForMockClient(page);
    await page.evaluate(
      ({ programName, divisionName, minAge, maxAge, mockOrgId }) => {
        const db = window.__MOCK_DB__ as MockDb | undefined;
        if (!db) throw new Error('mock store not initialised');
        const orgId = localStorage.getItem('squadlogic_active_org') || mockOrgId;
        const season = (db.season_settings ?? []).find(
          (row) => row.organization_id === orgId && row.status === 'active'
        );
        if (!season) throw new Error(`no active season for ${orgId}`);
        db.programs = db.programs ?? [];
        let program = db.programs.find(
          (row) => row.season_settings_id === season.id && row.name === programName
        );
        if (!program) {
          program = {
            id: `e2e-program-${programName.toLowerCase()}`,
            organization_id: orgId,
            season_settings_id: season.id,
            name: programName,
            is_default: false,
          };
          db.programs.push(program);
        }
        db.divisions = db.divisions ?? [];
        db.divisions = db.divisions.filter(
          (row) => !(row.season_settings_id === season.id && row.name === divisionName)
        );
        db.divisions.push({
          id: `e2e-division-${divisionName.toLowerCase().replace(/\s+/g, '-')}`,
          organization_id: orgId,
          season_settings_id: season.id,
          program_id: program.id,
          name: divisionName,
          min_age: minAge,
          max_age: maxAge,
          max_roster_size: 14,
          min_roster_size: 10,
          target_team_size: 12,
          plays_games: true,
          practices_per_week: 1,
          practice_minutes: null,
        });
        window.__saveMockDB__(db);
      },
      { programName, divisionName, minAge, maxAge, mockOrgId: MOCK_ORG_ID }
    );
  }
);

/**
 * The players the import's rows become once it is finalized: a stored natural age (the season's year
 * less the birth year, as the import counts it) and the play-up request, which is what the roster
 * editor reads a rostered player's age and request from.
 */
Given(
  'the import is stored as players, with the age and play-up request each row carries',
  async ({ page }) => {
    await waitForMockClient(page);
    await page.evaluate(
      ({ rows, mockOrgId }) => {
        const db = window.__MOCK_DB__ as MockDb | undefined;
        if (!db) throw new Error('mock store not initialised');
        const orgId = localStorage.getItem('squadlogic_active_org') || mockOrgId;
        const season = (db.season_settings ?? []).find(
          (row) => row.organization_id === orgId && row.status === 'active'
        );
        if (!season) throw new Error(`no active season for ${orgId}`);
        const stored = rows.map((row) => ({
          id: row.id,
          organization_id: orgId,
          season_settings_id: season.id,
          first_name: row['First Name'],
          last_name: row['Last Name'],
          natural_age: 2026 - Number(String(row.Birthdate).slice(0, 4)),
          play_up_requested: row['Play Up'] === 'Yes',
          gender: 'm',
          status: 'active',
        }));
        const ids = new Set(stored.map((row) => row.id));
        db.players = [...(db.players ?? []).filter((row) => !ids.has(row.id)), ...stored];
        window.__saveMockDB__(db);
      },
      { rows: [...seeded], mockOrgId: MOCK_ORG_ID }
    );
  }
);

const overviewTable = (page: Page) => page.getByRole('table', { name: 'Division Overview' });

Then(
  'the Division Overview reads {string} for {string}',
  async ({ page }, text: string, division: string) => {
    const table = overviewTable(page);
    await expect(table).toBeVisible({ timeout: 15000 });
    const headers = await table.getByRole('columnheader').allTextContents();
    const column = headers.indexOf('Play-up and play-down');
    // The column exists, so a missing flag is a real absence and not a table that changed shape.
    expect(column).toBeGreaterThan(-1);
    const row = table
      .getByRole('row')
      .filter({ has: page.getByRole('button', { name: division, exact: true }) });
    await expect(row).toHaveCount(1);
    const cell = row.getByRole('cell').nth(column);
    await expect(cell).toHaveText(text);
    const up = /^(\d+) playing up$/.exec(text);
    if (up && division === 'U12 Boys') counted.overview = Number(up[1]);
  }
);

Then('the Division Overview heading reads {string}', async ({ page }, text: string) => {
  await expect(overviewTable(page).getByRole('rowheader', { name: text, exact: true })).toHaveCount(
    1
  );
});

Then('the Division Overview league line reads {string}', async ({ page }, text: string) => {
  await expect(page.getByTestId('play-flags-league')).toHaveText(text);
});

When('I switch to the light theme on this page', async ({ page }) => {
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('button', { name: 'Switch to light mode' }).click();
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', 'dark');
});

Then('the Play-up section reads {string}', async ({ page }, sentence: string) => {
  await expect(page.getByText(/Team review staged:/)).toBeVisible({ timeout: 20000 });
  await expect(section(page)).toBeVisible({ timeout: 15000 });
  await expect(section(page)).toContainText(sentence);
  const up = /(\d+) playing up/.exec((await section(page).textContent()) ?? '');
  expect(up, 'the Play-up section states how many play up').not.toBeNull();
  counted.section = Number(up?.[1]);
});

When('I turn the Teams page to Edit Mode', async ({ page }) => {
  // The staged review is held in the page, so this stays on the page (no navigation).
  await page.getByRole('button', { name: 'Edit Mode' }).click();
  await expect(page.getByTestId('roster-age-flags')).toBeVisible({ timeout: 15000 });
});

Then(
  'the Play-up section and the roster list count as many play-ups as the overview did',
  async ({ page }) => {
    const list = page.getByTestId('roster-age-flags');
    const up = /(\d+) playing up, (\d+) playing down/.exec((await list.textContent()) ?? '');
    expect(up, 'the roster list states how many play up and down').not.toBeNull();
    // Enumerated from the entries the list prints, not from its summary.
    await expect(list.getByRole('listitem')).toHaveCount(Number(up?.[1]) + Number(up?.[2]));
    expect(counted.overview, 'the overview was read first').not.toBeNull();
    expect(counted.section, 'the Play-up section was read first').not.toBeNull();
    expect(Number(up?.[1])).toBe(counted.overview);
    expect(counted.section).toBe(counted.overview);
    // Nobody plays down: play-down is not available, and a manual move was not made.
    expect(Number(up?.[2])).toBe(0);
  }
);
