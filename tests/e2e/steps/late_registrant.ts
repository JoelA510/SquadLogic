import { createBdd } from 'playwright-bdd';
import { expect, type Page } from '@playwright/test';
import { waitForMockClient } from './mockReady.js';
import { MOCK_ORG_ID } from '../../../frontend/src/lib/mockSeedIds.js';

const { Given, When, Then } = createBdd();

// TG-3, the late-registrant journey (late_registrant_reviewed_roster.feature).
// Synthetic names only. Given steps seed the saved team run and the import
// (inputs the page reads back); Then steps read the page. The saved run is
// the shape a sync persists (`results.teams` / `results.team_players`,
// frontend/src/hooks/useTeamPersistence.js), and every row carries
// organization_id.

type MockRow = Record<string, unknown>;
type MockDb = Record<string, MockRow[] | undefined>;

const DIVISION = 'U12 Boys';
// UUID-shaped ids: the page keeps a saved team's id only when it is a UUID, as
// every persisted id is (teamReviewPersistence.js), so ids like "falcons"
// would be replaced on the re-run and the "same ids" check would fail for the
// wrong reason.
const uuid = (n: number) => `5eed0000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const TEAMS = [
  { id: uuid(101), name: 'Falcons', players: [uuid(1), uuid(2), uuid(3)] },
  { id: uuid(102), name: 'Herons', players: [uuid(4), uuid(5), uuid(6)] },
];
const LATE_PLAYER = uuid(7);
const ORIGINAL_PLAYERS = TEAMS.flatMap((team) => team.players);

Given(
  'the U12 Boys roster was saved as the teams Falcons and Herons with three players each',
  async ({ page }) => {
    await waitForMockClient(page);
    await page.evaluate(
      ({ division, teams, players, createdAt, mockOrgId }) => {
        const db = window.__MOCK_DB__ as MockDb | undefined;
        if (!db) throw new Error('mock store not initialised');
        const orgId = localStorage.getItem('squadlogic_active_org') || mockOrgId;
        const season = (db.season_settings ?? []).find(
          (row) => row.organization_id === orgId && row.status === 'active'
        );
        if (!season) throw new Error(`no active season for ${orgId}`);
        // The seed's own team run is retired (in place: the mock re-merges its
        // seed rows by id), so the saved run below is the only one.
        for (const run of db.scheduler_runs ?? []) {
          if (run.run_type === 'team' && run.organization_id === orgId) run.status = 'deleted';
        }
        db.imports = [
          ...(db.imports ?? []),
          {
            id: 'late-import-original',
            user_id: 'mock-admin-id',
            organization_id: orgId,
            import_type: 'players',
            created_at: createdAt,
            data: {
              totalRows: players.length,
              validRows: players.length,
              data: players.map((id, index) => ({
                id,
                'First Name': 'Player',
                'Last Name': String(index + 1),
                Birthdate: '2015-03-01',
                Gender: 'm',
                division,
                'Skill Rating': (index % 5) + 1,
              })),
            },
          },
        ];
        db.scheduler_runs = [
          ...(db.scheduler_runs ?? []).filter((run) => run.id !== 'late-saved-run'),
          {
            id: 'late-saved-run',
            organization_id: orgId,
            season_settings_id: season.id,
            run_type: 'team',
            status: 'completed',
            created_at: createdAt,
            completed_at: createdAt,
            parameters: { selectedProgramId: division },
            results: {
              teams: teams.map((team) => ({
                id: team.id,
                name: team.name,
                division,
                organization_id: orgId,
              })),
              team_players: teams.flatMap((team) =>
                team.players.map((playerId) => ({
                  team_id: team.id,
                  player_id: playerId,
                  role: 'player',
                  source: 'auto',
                }))
              ),
            },
          },
        ];
        window.__saveMockDB__(db);
      },
      {
        division: DIVISION,
        teams: TEAMS,
        players: ORIGINAL_PLAYERS,
        createdAt: new Date(Date.now() + 30_000).toISOString(),
        mockOrgId: MOCK_ORG_ID,
      }
    );
  }
);

Given('a late registrant appears in the latest import', async ({ page }) => {
  await waitForMockClient(page);
  await page.evaluate(
    ({ division, latePlayer, originals, createdAt, mockOrgId }) => {
      const db = window.__MOCK_DB__ as MockDb | undefined;
      if (!db) throw new Error('mock store not initialised');
      const orgId = localStorage.getItem('squadlogic_active_org') || mockOrgId;
      const row = (id: string, index: number) => ({
        id,
        'First Name': 'Player',
        'Last Name': String(index + 1),
        Birthdate: '2015-03-01',
        Gender: 'm',
        division,
        'Skill Rating': (index % 5) + 1,
      });
      const everyone = [...originals, latePlayer];
      // Newer than the original import, so it is the one the page reads: the
      // club's full export now lists the late registrant too.
      db.imports = [
        ...(db.imports ?? []),
        {
          id: 'late-import-latest',
          user_id: 'mock-admin-id',
          organization_id: orgId,
          import_type: 'players',
          created_at: createdAt,
          data: {
            totalRows: everyone.length,
            validRows: everyone.length,
            data: everyone.map(row),
          },
        },
      ];
      window.__saveMockDB__(db);
    },
    {
      division: DIVISION,
      latePlayer: LATE_PLAYER,
      originals: ORIGINAL_PLAYERS,
      createdAt: new Date(Date.now() + 60_000).toISOString(),
      mockOrgId: MOCK_ORG_ID,
    }
  );
});

Given(
  'the season is {int} and the late registrant was born in {int}',
  async ({ page }, seasonYear: number, birthYear: number) => {
    await waitForMockClient(page);
    await page.evaluate(
      ({ seasonYear, birthdate, latePlayer, mockOrgId }) => {
        const db = window.__MOCK_DB__ as MockDb | undefined;
        if (!db) throw new Error('mock store not initialised');
        const orgId = localStorage.getItem('squadlogic_active_org') || mockOrgId;
        const season = (db.season_settings ?? []).find(
          (row) => row.organization_id === orgId && row.status === 'active'
        );
        if (!season) throw new Error(`no active season for ${orgId}`);
        // The season the ages are counted in: U12 in 2027 is born in 2015, as the saved
        // players are, so only the late registrant is out of the band.
        season.season_year = seasonYear;
        season.age_cutoff_mode = 'birth_year';
        const latest = (db.imports ?? []).find((row) => row.id === 'late-import-latest');
        const rows = (latest?.data as { data?: MockRow[] } | undefined)?.data;
        const late = rows?.find((row) => row.id === latePlayer);
        if (!late) throw new Error('the late registrant is not in the latest import');
        late.Birthdate = birthdate;
        window.__saveMockDB__(db);
      },
      {
        seasonYear,
        birthdate: `${birthYear}-03-01`,
        latePlayer: LATE_PLAYER,
        mockOrgId: MOCK_ORG_ID,
      }
    );
  }
);

When('I re-run teaming from the dashboard workflow', async ({ page }) => {
  // The button asks before it replaces the current draft; the scenario says yes.
  let asked = false;
  page.once('dialog', (dialog) => {
    asked = true;
    void dialog.accept();
  });
  await page.goto('/workflow?step=2');
  const rerun = page.getByTestId('step-rerun-teaming');
  await expect(rerun).toBeVisible({ timeout: 15000 });
  await rerun.click();
  // The Teams page runs the re-run on arrival and stages the review.
  await expect(page.getByText(/Team review staged:/)).toBeVisible({ timeout: 20000 });
  expect(asked).toBe(true);
});

Then(
  'the page reports {int} saved teams kept and {int} late player(s) seated',
  async ({ page }, teams: number, late: number) => {
    const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;
    await expect(
      page.getByText(
        `Incremental rerun: ${plural(teams, 'team')} preserved, ${plural(late, 'late player')} seated, 0 dropped.`
      )
    ).toBeVisible();
  }
);

/** Open the roster editor (once) and return a team's column. */
async function teamColumn(page: Page, teamId: string) {
  const edit = page.getByRole('button', { name: 'Edit Mode' });
  if (await edit.isVisible()) await edit.click();
  const column = page.getByTestId(`team-column-${teamId}`);
  await expect(column).toBeVisible({ timeout: 15000 });
  return column;
}

Then('the saved teams keep their ids and original players', async ({ page }) => {
  for (const team of TEAMS) {
    const column = await teamColumn(page, team.id);
    // Every original player is on the team the review saved. The column is
    // virtualised (RosterManager), so each card is awaited by id, not counted.
    for (const playerId of team.players) {
      await expect(column.getByTestId(`player-card-${playerId}`)).toBeVisible();
    }
  }
});

/** How many cards for `playerId` the saved teams' own columns hold, summed. */
async function cardsOnSavedTeams(page: Page, playerId: string) {
  let total = 0;
  for (const team of TEAMS) {
    const column = await teamColumn(page, team.id);
    total += await column.getByTestId(`player-card-${playerId}`).count();
  }
  return total;
}

Then('the late registrant is on exactly one of them', async ({ page }) => {
  // Meta-assertion: the columns are open and hold players (the previous step
  // awaited each original card), so a count of zero would be a real zero.
  await teamColumn(page, TEAMS[0].id);
  await expect.poll(() => cardsOnSavedTeams(page, LATE_PLAYER)).toBe(1);
});

Then(
  'the late registrant is listed under "Not placed" as too old for the division',
  async ({ page }) => {
    // Player 7 is the late registrant's name in the import (First Name, Last Name).
    const list = page.getByRole('region', { name: 'Not placed' });
    await expect(list).toBeVisible({ timeout: 15000 });
    await expect(list.getByRole('listitem')).toHaveText([
      'Player 7. Not eligible for this division. No suitable division in this import (the same gender or co-ed) holds a player of their age. Natural age 16.',
    ]);
    // Nobody was held on a reviewed roster: the saved players are in the band.
    await expect(page.getByRole('region', { name: 'Needs review' })).toHaveCount(0);
  }
);

Then('the late registrant is on none of them', async ({ page }) => {
  // Meta-assertion: the columns are open and hold the original players (the previous step
  // awaited each card), so a count of zero is a real zero.
  await expect(
    (await teamColumn(page, TEAMS[0].id)).getByTestId(`player-card-${TEAMS[0].players[0]}`)
  ).toBeVisible();
  expect(await cardsOnSavedTeams(page, LATE_PLAYER)).toBe(0);
});

Then(
  'all {int} players are flagged "Eligibility not checked" and none is held off a team',
  async ({ page }, players: number) => {
    // The season has no year, so no age can be checked: each placed player is flagged beside
    // their name, and nobody is listed as not placed.
    const list = page.getByRole('region', { name: 'Eligibility not checked' });
    await expect(list).toBeVisible({ timeout: 15000 });
    const items = list.getByRole('listitem');
    await expect(items).toHaveCount(players);
    for (const item of await items.all()) {
      await expect(item).toContainText('Eligibility not checked');
    }
    await expect(page.getByRole('region', { name: 'Not placed' })).toHaveCount(0);
  }
);
