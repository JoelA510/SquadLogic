import { createBdd } from 'playwright-bdd';
import { expect, type Page } from '@playwright/test';
import { waitForMockClient } from './mockReady.js';
import { MOCK_ORG_ID } from '../../../frontend/src/lib/mockSeedIds.js';

/**
 * Steps several admin features share: the settings a league turns on, Team A's
 * seeded game and weekly practice, going to a route, and the admin navigation.
 * (They lived in the coach view's steps until docs/changes/2026-10-27-admin-only.md removed it.)
 * Every check is a DOM assertion; the mock database is touched only to seed,
 * through `window.__saveMockDB__`.
 *
 * The mock seed's Team A and Team B are in U8 Coed; Tigers, also U8 Coed, has no coach.
 */

const { Given, When, Then } = createBdd();

type MockRow = Record<string, unknown>;

/** A wall date `days` from today, as `YYYY-MM-DD` (UTC, as the mock's own today). */
const dayFromToday = (days: number) =>
  new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

/**
 * The UTC instant of a wall time in the mock season's zone (America/Los_Angeles) on a date: whichever of the zone's
 * two offsets reads back as that time, so the seed is right on either side of a clock change.
 */
function losAngelesInstant(date: string, hour: number): string {
  const wallHour = (iso: string) =>
    Number(
      new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Los_Angeles',
        hour: '2-digit',
        hourCycle: 'h23',
      }).format(new Date(iso))
    );
  const two = (n: number) => String(n).padStart(2, '0');
  const at = [7, 8]
    .map((offset) => `${date}T${two(hour + offset)}:00:00+00:00`)
    .find((iso) => wallHour(iso) === hour);
  if (!at) throw new Error(`seed: ${date} has no ${hour}:00 in America/Los_Angeles`);
  return at;
}

/**
 * Two played games of the saved schedule (F11-3: Scores and Standings list the season's saved games, not the legacy
 * `games` table): Team A at home to Team B yesterday, scored 2 to 1, and again an hour ago, not scored yet. They are
 * rows of `game_assignments` in the mock seed's completed game run (`run-game-1`), and the score is a row of
 * `game_scores`.
 *
 * Written by an init script, on every page load, after any the feature registered before it: a feature's Background
 * can rewrite the stored database on each load (reporting.feature's "there is an active season" does), and a row put
 * there once by `page.evaluate` would be gone at the next navigation. A row already there is left as it is, so a
 * score entered on the page survives the next load.
 */
async function seedPlayedGames(page: Page) {
  await page.addInitScript((mockOrgId) => {
    const db = JSON.parse(sessionStorage.getItem('__MOCK_DB__') || '{}');
    const orgId = localStorage.getItem('squadlogic_active_org') || mockOrgId;
    const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
    const game = (id: string, startedAgo: number) => ({
      id,
      organization_id: orgId,
      run_id: 'run-game-1',
      home_team_id: 't1',
      away_team_id: 't2',
      week_index: 1,
      start: ago(startedAgo),
      end: ago(startedAgo - 3_600_000),
      assignment_source: 'auto',
      published: false,
    });
    db.game_assignments = db.game_assignments || [];
    for (const [id, startedAgo] of [
      ['ga-e2e-played-1', 86_400_000],
      ['ga-e2e-played-2', 3_600_000],
    ] as const) {
      if (!db.game_assignments.some((g: MockRow) => g.id === id))
        db.game_assignments.push(game(id, startedAgo));
    }
    db.game_scores = db.game_scores || [];
    if (!db.game_scores.some((s: MockRow) => s.game_id === 'ga-e2e-played-1')) {
      db.game_scores.push({
        game_id: 'ga-e2e-played-1',
        organization_id: orgId,
        home_team_id: 't1',
        away_team_id: 't2',
        score_home: 2,
        score_away: 1,
        created_at: ago(80_000_000),
        updated_at: ago(80_000_000),
        updated_by: null,
      });
    }
    sessionStorage.setItem('__MOCK_DB__', JSON.stringify(db));
  }, MOCK_ORG_ID);
}

async function openMock(page: Page) {
  if (page.url() === 'about:blank') await page.goto('/');
  await waitForMockClient(page);
}

Given('the league has turned on score entry and standings', async ({ page }) => {
  await openMock(page);
  await page.evaluate((mockOrgId) => {
    const db = JSON.parse(
      sessionStorage.getItem('__MOCK_DB__') || JSON.stringify(window.__MOCK_DB__ || {})
    );
    const orgId = localStorage.getItem('squadlogic_active_org') || mockOrgId;
    const org = (db.organizations || []).find((o: MockRow) => o.id === orgId);
    if (!org) throw new Error(`seed: organization ${orgId} is not in the mock db`);
    org.feature_flags = { ...(org.feature_flags || {}), score_entry: true, standings: true };
    window.__saveMockDB__(db);
  }, MOCK_ORG_ID);
  // And there is something to score: the pages list the saved schedule's played games.
  await seedPlayedGames(page);
});

Given('the saved schedule has two played games, one already scored', async ({ page }) => {
  await seedPlayedGames(page);
});

Given('Team A has an upcoming game and a weekly practice', async ({ page }) => {
  await openMock(page);
  await page.evaluate(
    ({ mockOrgId, gameDate, gameStart, gameEnd, from, until }) => {
      const db = JSON.parse(
        sessionStorage.getItem('__MOCK_DB__') || JSON.stringify(window.__MOCK_DB__ || {})
      );
      const orgId = localStorage.getItem('squadlogic_active_org') || mockOrgId;
      db.game_slots = (db.game_slots || []).filter((s: MockRow) => s.id !== 'gs-e2e-coach');
      db.game_slots.push({
        id: 'gs-e2e-coach',
        organization_id: orgId,
        field_id: 'v1',
        slot_date: gameDate,
        start_time: '10:00:00',
        end_time: '11:00:00',
      });
      // A saved game (F11-3: the team page and its files read `game_assignments` of the season's current game
      // run), 10:00 to 11:00 on the season's clock.
      const run = (db.scheduler_runs || []).find(
        (r: MockRow) =>
          r.organization_id === orgId && r.run_type === 'game' && r.status === 'completed'
      );
      if (!run) throw new Error('seed: the mock db has no completed game run');
      db.game_assignments = (db.game_assignments || []).filter(
        (g: MockRow) => g.id !== 'game-e2e-coach'
      );
      db.game_assignments.push({
        id: 'game-e2e-coach',
        organization_id: orgId,
        run_id: run.id,
        home_team_id: 't1',
        away_team_id: 't2',
        game_slot_id: 'gs-e2e-coach',
        slot_id: 'gs-e2e-coach',
        field_id: 'v1',
        week_index: 1,
        start: gameStart,
        end: gameEnd,
        assignment_source: 'auto',
        published: false,
      });
      db.practice_slots = (db.practice_slots || []).filter((s: MockRow) => s.id !== 'ps-e2e-coach');
      db.practice_slots.push({
        id: 'ps-e2e-coach',
        organization_id: orgId,
        field_id: 'v1',
        day_of_week: 'thu',
        start_time: '17:30',
        end_time: '18:30',
        valid_from: from,
        valid_until: until,
      });
      db.practice_assignments = (db.practice_assignments || []).filter(
        (a: MockRow) => a.id !== 'pa-e2e-coach'
      );
      db.practice_assignments.push({
        id: 'pa-e2e-coach',
        organization_id: orgId,
        team_id: 't1',
        slot_id: 'ps-e2e-coach',
        practice_slot_id: 'ps-e2e-coach',
        source: 'auto',
        effective_date_range: `[${from},${until}]`,
      });
      window.__saveMockDB__(db);
    },
    {
      mockOrgId: MOCK_ORG_ID,
      gameDate: dayFromToday(5),
      gameStart: losAngelesInstant(dayFromToday(5), 10),
      gameEnd: losAngelesInstant(dayFromToday(5), 11),
      from: dayFromToday(0),
      until: dayFromToday(27),
    }
  );
});

When('I go to {string}', async ({ page }, route: string) => {
  await page.goto(route);
});

Then('the admin navigation offers no {string}', async ({ page }, label: string) => {
  await expect(page.locator('aside')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('aside').getByRole('link', { name: label, exact: true })).toHaveCount(
    0
  );
});

Then('the admin navigation offers {string}', async ({ page }, label: string) => {
  await expect(page.locator('aside').getByRole('link', { name: label, exact: true })).toBeVisible({
    timeout: 15_000,
  });
});

// The real path a league turns a setting on by: the Settings page's feature
// toggle, through `update_org_feature_flags`. No reload follows (a
// background's init script may reseed the mock db on a load), so the pages
// after it are opened from the navigation.
When(
  'the admin turns on {string} and {string} in the Settings features',
  async ({ page }, first: string, second: string) => {
    await page.goto('/settings');
    await page.getByRole('tab', { name: 'Features' }).click();
    for (const label of [first, second]) {
      const toggle = page.getByRole('switch', { name: label });
      await expect(toggle).toHaveAttribute('aria-checked', 'false', { timeout: 15_000 });
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-checked', 'true', { timeout: 15_000 });
    }
  }
);

When('I open {string} from the admin navigation', async ({ page }, label: string) => {
  await page.locator('aside').getByRole('link', { name: label, exact: true }).click();
});
