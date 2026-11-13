import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createBdd } from 'playwright-bdd';
import { expect } from '@playwright/test';
import { waitForMockClient } from './mockReady.js';
import { MOCK_ORG_ID, MOCK_SEASON_ID } from '../../../frontend/src/lib/mockSeedIds.js';
import { practicePgtapWorld } from '../../helpers/practiceImportPgtapFixture.js';
import { countPlants } from '../../helpers/practiceSweep.js';
import { readPracticeAliases } from '../../../packages/core/src/practiceImport/index.js';

/**
 * The practice schedule import, end to end in the browser against the mock client (plan
 * docs/changes/2026-11-03-schedule-expansion.md 4.11; PR 11, task L4). Every check is a DOM assertion. The mock
 * database is touched once, to seed the league the fixture is over; everything after that is done by the page.
 *
 * The numbers are counted from the fixture's own files here (the CSV sweep of tests/helpers/practiceSweep.js, which
 * imports neither the generator nor the product), never from the page.
 */

const { Given, When, Then } = createBdd();

const FIXTURE_DIR = path.resolve(process.cwd(), 'fixtures/practice-schedule-2026');
/**
 * The day the browser is pinned to: inside the fixture's season (2026-09-07 to 2026-11-20), the day PR 10's
 * tests/mockPracticeImport.test.js gives the mock. The TIME TBD rebuild counts only practices that end after today, so on
 * the real date after the season's end every team would read short by all its practices (Codex on #732).
 */
const FIXTURE_TODAY = new Date('2026-11-13T12:00:00Z');
const W = practicePgtapWorld();
const FX = W.fixture;
const PLANTS = countPlants({
  rows: FX.schedule.rows,
  teams: FX.teams.rows,
  divisions: FX.divisions.rows,
}).counts;
const ALIASES_READ = readPracticeAliases({
  headers: FX.aliases.headers,
  rows: FX.aliases.rows,
  league: FX.league,
}).counts.ok;
/** The teams the file places that hold fewer rows than their division's count (the roster is the subject set). */
const SHORT_IN_FILE = (() => {
  const want = new Map(FX.divisions.rows.map((d) => [d.Division, Number(d['Practices Per Week'])]));
  const held = new Map();
  for (const r of FX.schedule.rows) {
    const team = (r.Team ?? '').trim();
    if (team) held.set(team, (held.get(team) ?? 0) + 1);
  }
  return FX.teams.rows.filter(
    (t) => (held.get(t.Team) ?? 0) > 0 && (held.get(t.Team) ?? 0) < (want.get(t.Division) ?? 0)
  );
})();

Given(
  "a league with the practice fixture's divisions, teams, coaches and grounds and no practices",
  async ({ page }) => {
    if (page.url() === 'about:blank') await page.goto('/');
    await waitForMockClient(page);
    await page.evaluate(
      ({ orgId, seasonId, league, season }) => {
        type Row = Record<string, unknown>;
        const db = window.__MOCK_DB__ as Record<string, Row[] | undefined> | undefined;
        if (!db) throw new Error('mock store not initialised');
        const org = localStorage.getItem('squadlogic_active_org') || orgId;
        db.season_settings = (db.season_settings ?? []).map((s) =>
          s.id === seasonId
            ? {
                ...s,
                organization_id: org,
                status: 'active',
                season_start: season.startDate,
                season_end: season.endDate,
              }
            : s
        );
        // A record of the mock's own league under one of the fixture's names would make that name two records (the
        // import never guesses between two): renamed, not removed.
        const rename = (table: string, names: Set<string>) => {
          db[table] = (db[table] ?? []).map((r) =>
            r.organization_id === org && names.has(String(r.name))
              ? { ...r, name: `${String(r.name)} (earlier league)` }
              : r
          );
        };
        rename('divisions', new Set(league.divisions.map((d: Row) => String(d.name))));
        rename('locations', new Set(league.locations.map((l: Row) => String(l.name))));
        db.divisions = [
          ...(db.divisions ?? []),
          ...league.divisions.map((d: Row) => ({
            id: d.id,
            organization_id: org,
            season_settings_id: seasonId,
            name: d.name,
            plays_games: true,
            practices_per_week: d.practicesPerWeek,
            practice_minutes: d.practiceMinutes,
          })),
        ];
        db.teams = [
          ...(db.teams ?? []),
          ...league.teams.map((t: Row) => ({
            id: t.id,
            organization_id: org,
            division_id: t.divisionId,
            name: t.name,
            is_external: false,
          })),
        ];
        db.team_coach_assignments = [
          ...(db.team_coach_assignments ?? []),
          ...league.coachOf.map((a: Row, i: number) => ({
            id: `e2e-practice-tca-${i}`,
            organization_id: org,
            team_id: a.team,
            coach_id: a.coach,
            role: a.role,
            effective_from: season.startDate,
            effective_to: null,
          })),
        ];
        db.locations = [
          ...(db.locations ?? []),
          ...league.locations.map((l: Row) => ({
            id: l.id,
            organization_id: org,
            name: l.name,
            effective_to: null,
          })),
        ];
        db.fields = [
          ...(db.fields ?? []),
          ...league.fields.map((f: Row) => ({
            id: f.id,
            organization_id: org,
            location_id: f.locationId,
            name: f.name,
            active: true,
            supports_halves: true,
          })),
        ];
        db.field_subunits = [
          ...(db.field_subunits ?? []),
          ...league.subunits.map((s: Row) => ({
            id: s.id,
            organization_id: org,
            field_id: s.fieldId,
            label: s.name,
            effective_to: null,
          })),
        ];
        window.__saveMockDB__(db);
      },
      { orgId: MOCK_ORG_ID, seasonId: MOCK_SEASON_ID, league: W.league, season: W.season }
    );
    // pinned before the page loads again, so every date the page and its mock read is this one
    await page.clock.setFixedTime(FIXTURE_TODAY);
    await page.reload();
    await waitForMockClient(page);
  }
);

When(
  "I choose the practices import and upload the fixture's practice schedule",
  async ({ page }) => {
    await page.getByRole('button', { name: /^practices\b/i }).click();
    const panel = page.getByTestId('schedule-import-panel');
    await expect(panel.getByRole('heading', { name: 'Import a practice schedule' })).toBeVisible();
    await panel.getByTestId('schedule-import-file').setInputFiles({
      name: 'practice-schedule.csv',
      mimeType: 'text/csv',
      buffer: readFileSync(path.join(FIXTURE_DIR, 'practice-schedule.csv')),
    });
    await expect(page.getByTestId('schedule-import-step')).toContainText('2 of 4', {
      timeout: 30_000,
    });
  }
);

Then('the practice file is read whole and its dropped column is named', async ({ page }) => {
  const staged = page.getByTestId('practice-import-staged');
  await expect(staged).toContainText(`${FX.schedule.rows.length} rows read.`, { timeout: 30_000 });
  await expect(staged).toContainText('Columns not read and not stored: Block.');
});

When(
  "I read the fixture's alias file and use every proposal nothing disagrees with",
  async ({ page }) => {
    await page.getByTestId('practice-import-alias-file').setInputFiles({
      name: 'aliases.csv',
      mimeType: 'text/csv',
      buffer: readFileSync(path.join(FIXTURE_DIR, 'aliases.csv')),
    });
    await expect(page.getByTestId('practice-import-alias-summary')).toContainText(
      `aliases.csv: ${ALIASES_READ} aliases read`
    );
    // an alias is a proposal: said with its source, and not applied until the admin takes it
    await expect(page.getByTestId('practice-import-proposal').first()).toContainText(
      'Proposed by the alias file'
    );
    await page.getByRole('button', { name: /^Use every proposal nothing disagrees with/ }).click();
  }
);

Then('no name of the practice file is left undecided', async ({ page }) => {
  await expect(page.getByText('Not decided: its rows will not be imported.')).toHaveCount(0);
});

When('I preview the practice import', async ({ page }) => {
  await page.getByRole('button', { name: 'Preview the import' }).click();
  await expect(page.getByTestId('schedule-import-step')).toContainText('3 of 4', {
    timeout: 60_000,
  });
});

Then(
  'the preview refuses the slot that overlaps another and flags the double-placed teams',
  async ({ page }) => {
    await expect(page.getByTestId('practice-import-count-refused')).toHaveText(
      String(PLANTS.overlappingSlots)
    );
    await expect(page.getByTestId('practice-import-refused')).toContainText(
      'Two slots claim the same ground at overlapping times'
    );
    // a double-placed team and the team on both halves each hold two rows on one weekday
    await expect(page.getByTestId('practice-import-flags')).toContainText(
      `A team has two practices on one weekday: ${(PLANTS.doublePlaced + PLANTS.teamOnBothHalves) * 2} rows, ${
        PLANTS.doublePlaced + PLANTS.teamOnBothHalves
      } teams`
    );
    await expect(page.getByTestId('practice-import-holds')).toContainText(
      'held for a non-team activity; it makes no slot'
    );
  }
);

Then(
  "the preview lists the teams short of their division's practices and says what it did not check",
  async ({ page }) => {
    const short = page.getByTestId('practice-import-short');
    await expect(short).toContainText(`${SHORT_IN_FILE[0].Team}: 1 practice short`);
    await expect(page.getByTestId('practice-import-coverage')).toContainText(
      'Not checked: coach preference rules, daylight and sunset'
    );
    // a first import into a season with no saved practice moves nothing
    await expect(page.getByTestId('practice-import-moves')).toHaveCount(0);
  }
);

Then(
  'nothing is imported until I tick the list of what the practice import will create',
  async ({ page }) => {
    await expect(page.getByTestId('practice-import-creations')).toContainText('Practice slots:');
    await expect(page.getByRole('button', { name: 'Confirm and import' })).toBeDisabled();
  }
);

When('I tick the list and confirm the practice import', async ({ page }) => {
  await page.getByLabel(/^Create the \d+ records listed above$/).check();
  const confirm = page.getByRole('button', { name: 'Confirm and import' });
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(page.getByTestId('schedule-import-step')).toContainText('4 of 4', {
    timeout: 60_000,
  });
});

/** How many practices the apply said it added, read once the result is on screen, for the roll back's check. */
let added = -1;

Then(
  'the practice import is applied and says its practices are saved and locked',
  async ({ page }) => {
    const applied = page.getByTestId('practice-import-applied');
    await expect(applied).toContainText(
      /^Imported: \d+ practices added, 0 already saved, 0 held back/
    );
    await expect(applied).toContainText('Saved practices are locked');
    added = Number(
      /Imported: (\d+) practices added/.exec((await applied.textContent()) ?? '')?.[1]
    );
    expect(added).toBeGreaterThan(0);
  }
);

When('I roll back this practice import', async ({ page }) => {
  await page.getByRole('button', { name: 'Roll back this import' }).click();
});

Then('the practice import is rolled back', async ({ page }) => {
  await expect(page.getByTestId('schedule-import-rolled-back')).toContainText(
    `The import was rolled back: ${added} practices removed`,
    { timeout: 30_000 }
  );
});
