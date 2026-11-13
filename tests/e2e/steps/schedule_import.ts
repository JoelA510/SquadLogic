import { readFileSync } from 'node:fs';
import path from 'node:path';
import Papa from 'papaparse';
import { createBdd } from 'playwright-bdd';
import { expect } from '@playwright/test';
import { waitForMockClient } from './mockReady.js';
import { MOCK_ORG_ID, MOCK_SEASON_ID } from '../../../frontend/src/lib/mockSeedIds.js';

/**
 * The games import, end to end in the browser against the mock client (plan
 * docs/changes/2026-11-03-schedule-expansion.md 4.2; PR 6, task F4). Every check is a DOM assertion. The mock database
 * is touched once, to seed the league the fixture's schedule is over; everything after that is done by the page.
 *
 * The numbers are counted from the fixture's own files here (the generator's output), never from the page.
 */

const { Given, When, Then } = createBdd();

const FIXTURE_DIR = path.resolve(process.cwd(), 'fixtures/schedule-2026');
const csv = (name: string): Array<Record<string, string>> =>
  Papa.parse<Record<string, string>>(readFileSync(path.join(FIXTURE_DIR, name), 'utf8'), {
    header: true,
    skipEmptyLines: true,
  }).data;

const TEAM_ROWS = csv('teams.csv');
const VENUE_ROWS = csv('venues.csv');
const SCHEDULE_ROWS = csv('schedule.csv');
const OWN_TEAMS = new Set(TEAM_ROWS.map((row) => `${row.Division}|${row.Team}`));
/** The labels of the file that no own team of the division carries: the outside clubs, one per division and label. */
const OUTSIDE = new Set(
  SCHEDULE_ROWS.flatMap((row) =>
    [row['Home Team'], row['Away Team']]
      .map((team) => `${row.Division}|${team}`)
      .filter((key) => !OWN_TEAMS.has(key))
  )
);
const UNTIMED = SCHEDULE_ROWS.filter((row) => row['Start Time'] === '' || row.Field === '');
const PLACED = SCHEDULE_ROWS.length - UNTIMED.length;
const uuid = (n: number) => `e2e00000-0000-4000-8000-${String(n).padStart(12, '0')}`;

Given(
  "a league with the fixture's divisions, teams, venues and fields and no games",
  async ({ page }) => {
    if (page.url() === 'about:blank') await page.goto('/');
    await waitForMockClient(page);
    const divisions = [...new Set(TEAM_ROWS.map((row) => row.Division))];
    const venues = [...new Set(VENUE_ROWS.map((row) => row.Venue))];
    await page.evaluate(
      ({ orgId, seasonId, divisions, venues, teams, fields }) => {
        type Row = Record<string, unknown>;
        const db = window.__MOCK_DB__ as Record<string, Row[] | undefined> | undefined;
        if (!db) throw new Error('mock store not initialised');
        const org = localStorage.getItem('squadlogic_active_org') || orgId;
        // The season the import adds to: the fixture's dates, on its clock.
        db.season_settings = (db.season_settings ?? []).map((season) =>
          season.id === seasonId
            ? {
                ...season,
                organization_id: org,
                status: 'active',
                season_start: '2026-09-07',
                season_end: '2027-03-31',
                timezone: 'America/Los_Angeles',
              }
            : season
        );
        // A division the mock's own league already has under one of the fixture's names would make that name two
        // divisions (and the import never guesses between two). It is renamed, not removed: the mock puts back a
        // row of its own league that was only filtered out.
        const names = new Set(divisions.map((d) => d.name));
        db.divisions = [
          ...(db.divisions ?? []).map((d) =>
            d.organization_id === org && names.has(String(d.name))
              ? { ...d, name: `${String(d.name)} (earlier league)` }
              : d
          ),
          ...divisions.map((d) => ({
            id: d.id,
            organization_id: org,
            season_settings_id: seasonId,
            name: d.name,
            plays_games: true,
          })),
        ];
        db.teams = [
          ...(db.teams ?? []),
          ...teams.map((t) => ({
            id: t.id,
            organization_id: org,
            division_id: t.divisionId,
            name: t.name,
            is_external: false,
          })),
        ];
        db.locations = [
          ...(db.locations ?? []),
          ...venues.map((v) => ({
            id: v.id,
            organization_id: org,
            name: v.name,
            effective_to: null,
          })),
        ];
        db.fields = [
          ...(db.fields ?? []),
          ...fields.map((f) => ({
            id: f.id,
            organization_id: org,
            location_id: f.venueId,
            name: f.name,
            active: true,
          })),
        ];
        // No saved game, slot or TIME TBD game of this organization: the import is the first schedule.
        for (const table of ['game_assignments', 'game_slots', 'schedule_tbd']) {
          db[table] = (db[table] ?? []).filter((row) => row.organization_id !== org);
        }
        db.scheduler_runs = (db.scheduler_runs ?? []).filter(
          (run) => !(run.organization_id === org && run.run_type === 'game')
        );
        window.__saveMockDB__(db);
      },
      {
        orgId: MOCK_ORG_ID,
        seasonId: MOCK_SEASON_ID,
        divisions: divisions.map((name, i) => ({ id: uuid(1000 + i), name })),
        venues: venues.map((name, i) => ({ id: uuid(2000 + i), name })),
        teams: TEAM_ROWS.map((row, i) => ({
          id: uuid(3000 + i),
          name: row.Team,
          divisionId: uuid(1000 + divisions.indexOf(row.Division)),
        })),
        fields: VENUE_ROWS.map((row, i) => ({
          id: uuid(4000 + i),
          name: row.Field,
          venueId: uuid(2000 + venues.indexOf(row.Venue)),
        })),
      }
    );
    await page.reload();
    await waitForMockClient(page);
  }
);

When("I choose the games import and upload the fixture's schedule", async ({ page }) => {
  await page.getByRole('button', { name: /^games\b/i }).click();
  const panel = page.getByTestId('schedule-import-panel');
  await expect(panel.getByRole('heading', { name: 'Import a game schedule' })).toBeVisible();
  await panel.locator('input[type="file"]').setInputFiles({
    name: 'schedule.csv',
    mimeType: 'text/csv',
    buffer: readFileSync(path.join(FIXTURE_DIR, 'schedule.csv')),
  });
  await expect(page.getByTestId('schedule-import-step')).toContainText('2 of 4', {
    timeout: 30_000,
  });
});

Then('the file is read and its outside clubs are not decided yet', async ({ page }) => {
  await expect(page.getByTestId('schedule-import-staged')).toContainText(
    `${SCHEDULE_ROWS.length} rows read. ${PLACED} placed games, ${UNTIMED.length} with no time (TIME TBD), 0 that cannot be imported.`
  );
  // the column the import does not read is named, and dropped
  await expect(page.getByTestId('schedule-import-staged')).toContainText('not stored: Format');
  const teams = page.getByTestId('schedule-import-map-teams');
  await expect(teams.getByRole('heading')).toContainText(`${OUTSIDE.size} not decided`);
  await expect(teams.getByText('Not decided: its rows will not be imported.')).toHaveCount(
    OUTSIDE.size
  );
});

Then('a team the league has opens on {string}', async ({ page }, _choice: string) => {
  const first = TEAM_ROWS[0];
  const select = page.getByRole('combobox', { name: `What ${first.Team} (${first.Division}) is` });
  await expect(select).toBeVisible();
  await expect(select.locator('option:checked')).toHaveText(`Use existing team: ${first.Team}`);
});

When('I mark every undecided team an outside club', async ({ page }) => {
  await page.getByRole('button', { name: 'Mark every undecided team an outside club' }).click();
  await expect(page.getByText('Not decided: its rows will not be imported.')).toHaveCount(0);
});

When('I preview the schedule import', async ({ page }) => {
  await page.getByRole('button', { name: 'Preview the import' }).click();
  await expect(page.getByTestId('schedule-import-step')).toContainText('3 of 4', {
    timeout: 30_000,
  });
});

Then(
  "the preview adds the fixture's games and lists the outside clubs it will create",
  async ({ page }) => {
    await expect(page.getByTestId('schedule-import-count-games.inserted')).toHaveText(
      String(PLACED)
    );
    await expect(page.getByTestId('schedule-import-count-time_tbd.inserted')).toHaveText(
      String(UNTIMED.length)
    );
    await expect(page.getByTestId('schedule-import-count-rows.refused')).toHaveText('0');
    const clubs = page.getByTestId('schedule-import-created-outsideTeams');
    await expect(clubs).toContainText(`Outside clubs: ${OUTSIDE.size}`);
    await expect(clubs).toContainText([...OUTSIDE][0].split('|')[1]);
    // nothing else is created: every division, venue, field and own team of the file is the league's
    for (const kind of ['divisions', 'venues', 'fields', 'teamShells']) {
      await expect(page.getByTestId(`schedule-import-created-${kind}`)).toHaveCount(0);
    }
  }
);

Then(
  'the preview flags a field with two games at once and says what it did not check',
  async ({ page }) => {
    const flagged = page.getByTestId('schedule-import-warnings');
    await expect(flagged.getByRole('heading')).toContainText('Flagged, and imported anyway');
    await expect(
      flagged.getByText(/^Field .+: Two games are on one field at overlapping times\.$/).first()
    ).toBeVisible();
    await expect(page.getByTestId('schedule-import-coverage')).toContainText(
      'Not checked by the import: coach overlap, hosting balance'
    );
  }
);

Then('nothing is imported until I tick the list of what will be created', async ({ page }) => {
  await expect(page.getByRole('button', { name: 'Confirm and import' })).toBeDisabled();
  await expect(page.getByLabel(/Games arrive Published/)).toBeChecked();
  // G5: the baseline is recorded by default when the games arrive Published
  await expect(
    page.getByLabel(/^Record this schedule as the baseline for Changes since publication/)
  ).toBeChecked();
});

When('I tick the list and confirm the schedule import', async ({ page }) => {
  await page.getByLabel(`Create the ${OUTSIDE.size} records listed above`).check();
  const confirm = page.getByRole('button', { name: 'Confirm and import' });
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(page.getByTestId('schedule-import-step')).toContainText('4 of 4', {
    timeout: 30_000,
  });
});

Then('the schedule import is applied and its games are Published', async ({ page }) => {
  await expect(page.getByTestId('schedule-import-applied')).toHaveText(
    `Imported: ${PLACED} games added, 0 changed, ${UNTIMED.length} TIME TBD games added. The new games are Published.`
  );
});

Then(
  'the import is recorded as the publication baseline, as the box ticked by default asked',
  async ({ page }) => {
    await expect(page.getByTestId('schedule-import-baseline')).toContainText(
      /^Recorded the schedule as it now stands as published baseline v\d+, for "Changes since publication" on the Exports page\.$/,
      { timeout: 30_000 }
    );
  }
);

When('I open the Games page after the import', async ({ page }) => {
  await page.goto('/schedule/game');
  await expect(page.getByRole('heading', { name: 'Published games' })).toBeVisible({
    timeout: 30_000,
  });
});

Then('the Games page counts every imported game as Published', async ({ page }) => {
  await expect(page.getByTestId('published-summary')).toContainText(
    `${PLACED} of ${PLACED} saved games Published`,
    { timeout: 30_000 }
  );
});

Then('the Games page lists the game with no time as TIME TBD on its date', async ({ page }) => {
  const list = page.getByTestId('game-time-tbd-list');
  await expect(list.getByRole('heading')).toHaveText(`TIME TBD games (${UNTIMED.length})`);
  const game = UNTIMED[0];
  const item = list.getByTestId('game-time-tbd-item').first();
  await expect(item).toContainText(`${game['Home Team']} v ${game['Away Team']}`);
  await expect(item).toContainText(`${game.Date}, no time yet`);
  await expect(item).toHaveAttribute('data-dated', 'yes');
});

When('I return to the Data Import page and roll back the last import', async ({ page }) => {
  await page.goto('/import');
  await page.getByRole('button', { name: /^games\b/i }).click();
  const last = page.getByTestId('schedule-import-last');
  await expect(last).toContainText(`schedule.csv: ${PLACED} games added`, { timeout: 30_000 });
  await last.getByRole('button', { name: 'Roll back the last import' }).click();
});

Then('the import is rolled back and no longer offered', async ({ page }) => {
  await expect(page.getByTestId('schedule-import-rolled-back')).toContainText(
    `The import was rolled back: ${PLACED} games removed`,
    { timeout: 30_000 }
  );
  await expect(page.getByTestId('schedule-import-last')).toHaveCount(0);
});

Then(
  "the roll back says the import's baseline still describes the imported schedule",
  async ({ page }) => {
    await expect(page.getByTestId('schedule-import-baseline-rolled-back')).toContainText(
      /^Published baseline v\d+, recorded from this import, still describes the imported schedule/,
      { timeout: 30_000 }
    );
  }
);

Then('the Games page has no Published game', async ({ page }) => {
  await expect(page.getByTestId('published-summary')).toContainText(
    '0 of 0 saved games Published',
    {
      timeout: 30_000,
    }
  );
  await expect(page.getByTestId('game-time-tbd-list')).toHaveCount(0);
});
