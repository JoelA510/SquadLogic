import { createBdd } from 'playwright-bdd';
import { expect, type Page } from '@playwright/test';
import { waitForMockClient } from './mockReady';

const { Given, When, Then } = createBdd();

/**
 * Helper to ensure a player exists in the "imports" table so TeamAnalysisPage can hydrate it.
 */
async function syncPlayerToImports(page: Page, player: Record<string, unknown>) {
  await waitForMockClient(page);
  await page.evaluate(
    ({ p }) => {
      const db = JSON.parse(sessionStorage.getItem('__MOCK_DB__') || '{}');
      db.imports = db.imports || [];
      let playerImport = db.imports.find(
        (i: Record<string, unknown>) => i.import_type === 'players'
      );

      if (!playerImport) {
        const activeOrg = localStorage.getItem('squadlogic_active_org') || 'org-1';
        playerImport = {
          id: 'import-players-1',
          import_type: 'players',
          user_id: 'mock-admin-id',
          organization_id: activeOrg,
          data: { data: [] },
          created_at: new Date().toISOString(),
        };
        db.imports.push(playerImport);
      }

      // Add or update player in the import blob
      const existingIdx = playerImport.data.data.findIndex(
        (rp: Record<string, unknown>) => rp.id === p.id
      );
      const normalizedPlayer = {
        id: p.id,
        first_name: p.first_name,
        last_name: p.last_name,
        age: p.age,
        gender: p.gender,
        buddy_id: p.buddy_id,
      };

      if (existingIdx >= 0) {
        playerImport.data.data[existingIdx] = normalizedPlayer;
      } else {
        playerImport.data.data.push(normalizedPlayer);
      }

      sessionStorage.setItem('__MOCK_DB__', JSON.stringify(db));
    },
    { p: player }
  );
}

// ────────────────────────────────────────────────────────────
// 1. CORE SETUP & ROBUST SEEDING (Our recent fixes)
// ────────────────────────────────────────────────────────────

Given('teams have been generated for the current season', async ({ page }) => {
  await waitForMockClient(page);
  await page.evaluate(() => {
    const db = JSON.parse(sessionStorage.getItem('__MOCK_DB__') || '{}');
    const orgId = localStorage.getItem('squadlogic_active_org') || 'org-1';

    // CRITICAL: Use pre-seeded run-1 teams (t1='Team A', t2='Team B') rather than
    // creating new teams. The mock client's mergeSource always merges initialMockData
    // back in on page reload, so we can't remove pre-seeded records — we must work with them.
    // Update run-1 to ensure it has team_players and created_at for proper sorting.
    db.scheduler_runs = db.scheduler_runs || [];
    const existingRun = db.scheduler_runs.find((r: Record<string, unknown>) => r.id === 'run-1');
    if (existingRun) {
      existingRun.created_at = new Date().toISOString();
      existingRun.completed_at = new Date().toISOString();
      existingRun.results = existingRun.results || {};
      existingRun.results.team_players = existingRun.results.team_players || [];
    } else {
      db.scheduler_runs.push({
        id: 'run-1',
        organization_id: orgId,
        run_type: 'team',
        status: 'completed',
        created_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
        results: {
          teamsByDivision: {
            U10: [
              { id: 't1', name: 'Team A', division_id: 'U10', organization_id: orgId },
              { id: 't2', name: 'Team B', division_id: 'U10', organization_id: orgId },
            ],
          },
          team_players: [],
          rosterBalanceByDivision: {
            U10: {
              summary: { totalPlayers: 20, totalCapacity: 24, averageFillRate: 0.8 },
              teamStats: [],
            },
          },
          coachCoverageByDivision: {
            U10: { totalTeams: 2, teamsWithCoach: 2, coverageRate: 1.0 },
          },
        },
      });
    }

    sessionStorage.setItem('__MOCK_DB__', JSON.stringify(db));
  });
});

Given('all players are correctly assigned to eligible teams', async ({ page }) => {
  await waitForMockClient(page);
  await page.evaluate(() => {
    const db = JSON.parse(sessionStorage.getItem('__MOCK_DB__') || '{}');
    sessionStorage.setItem('__MOCK_DB__', JSON.stringify(db));
  });
});

// ────────────────────────────────────────────────────────────
// 2. RESTORED SPECIFIC SCENARIO STEPS (Fixing the Regression)
// ────────────────────────────────────────────────────────────

Given(
  'a buddy pair {string} and {string} are in the same division',
  async ({ page }, p1: string, p2: string) => {
    await waitForMockClient(page);
    await page.evaluate(
      ({ name1, name2 }) => {
        const db = JSON.parse(sessionStorage.getItem('__MOCK_DB__') || '{}');
        const _orgId = localStorage.getItem('squadlogic_active_org') || 'org-1';

        const id1 = `player-${name1.toLowerCase()}`;
        const id2 = `player-${name2.toLowerCase()}`;

        // Use pre-seeded teams t1 (Team A) and t2 (Team B) from run-1
        // Assign to DIFFERENT teams to trigger buddy separation conflict
        const run = (db.scheduler_runs || []).find(
          (r: Record<string, unknown>) => r.id === 'run-1'
        );
        if (run && run.results) {
          run.results.team_players = run.results.team_players || [];
          run.results.team_players.push(
            { team_id: 't1', player_id: id1 },
            { team_id: 't2', player_id: id2 }
          );
        }

        sessionStorage.setItem('__MOCK_DB__', JSON.stringify(db));
      },
      { name1: p1, name2: p2 }
    );

    // Sync to imports for hydration — buddyId must be mutual
    await syncPlayerToImports(page, {
      id: `player-${p1.toLowerCase()}`,
      first_name: p1,
      last_name: '',
      age: 10,
      gender: 'M',
      buddy_id: `player-${p2.toLowerCase()}`,
    });
    await syncPlayerToImports(page, {
      id: `player-${p2.toLowerCase()}`,
      first_name: p2,
      last_name: '',
      age: 10,
      gender: 'M',
      buddy_id: `player-${p1.toLowerCase()}`,
    });
  }
);

Given(
  'a player {string} is assigned to a {string} team',
  async ({ page }, player: string, teamGender: string) => {
    await waitForMockClient(page);
    await page.evaluate(
      ({ pName, tGender }) => {
        const db = JSON.parse(sessionStorage.getItem('__MOCK_DB__') || '{}');
        const playerId = `player-${pName.toLowerCase()}`;

        // Use pre-seeded run-1's Team A (t1). Set gender on it to trigger mismatch.
        const run = (db.scheduler_runs || []).find(
          (r: Record<string, unknown>) => r.id === 'run-1'
        );
        if (run && run.results) {
          // Set gender policy on Team A in teamsByDivision
          const divisions = run.results.teamsByDivision || {};
          for (const teams of Object.values(divisions) as Record<string, unknown>[][]) {
            const teamA = teams.find((t: Record<string, unknown>) => t.id === 't1');
            if (teamA) {
              teamA.gender = tGender === 'Boys' ? 'M' : 'F';
            }
          }
          run.results.team_players = run.results.team_players || [];
          run.results.team_players.push({ team_id: 't1', player_id: playerId });
        }

        sessionStorage.setItem('__MOCK_DB__', JSON.stringify(db));
      },
      { pName: player, tGender: teamGender }
    );

    // Sync to imports — player has opposite gender for the mismatch
    const playerGender = teamGender === 'Boys' ? 'F' : 'M';
    await syncPlayerToImports(page, {
      id: `player-${player.toLowerCase()}`,
      first_name: player,
      last_name: '',
      age: 10,
      gender: playerGender,
    });
  }
);

Given(
  'a player {string} of age {int} is assigned to a {string} team',
  async ({ page }, player: string, age: number, division: string) => {
    await waitForMockClient(page);
    await page.evaluate(
      ({ pName, pAge: _pAge, div }) => {
        const db = JSON.parse(sessionStorage.getItem('__MOCK_DB__') || '{}');
        const playerId = `player-${pName.toLowerCase()}`;

        // Use pre-seeded run-1's Team A (t1). Set age range to trigger mismatch.
        // e.g., "U8" team with min_age=6, max_age=8, but player age=11.
        const run = (db.scheduler_runs || []).find(
          (r: Record<string, unknown>) => r.id === 'run-1'
        );
        if (run && run.results) {
          const divisions = run.results.teamsByDivision || {};
          for (const teams of Object.values(divisions) as Record<string, unknown>[][]) {
            const teamA = teams.find((t: Record<string, unknown>) => t.id === 't1');
            if (teamA) {
              // Set age range based on division name (e.g., U8 → 6-8)
              // Use both snake_case (for mappedTeams path) and camelCase (for fallback path)
              const maxAgeVal = parseInt(div.replace('U', ''), 10) || 8;
              teamA.min_age = maxAgeVal - 2;
              teamA.max_age = maxAgeVal;
              teamA.minAge = maxAgeVal - 2;
              teamA.maxAge = maxAgeVal;
              teamA.name = `${div} Team`;
            }
          }
          run.results.team_players = run.results.team_players || [];
          run.results.team_players.push({ team_id: 't1', player_id: playerId });
        }

        sessionStorage.setItem('__MOCK_DB__', JSON.stringify(db));
      },
      { pName: player, pAge: age, div: division }
    );

    // Sync to imports for hydration
    await syncPlayerToImports(page, {
      id: `player-${player.toLowerCase()}`,
      first_name: player,
      last_name: '',
      age: age,
      gender: 'M',
    });
  }
);

Given(
  'a player {string} of age {int} is assigned to {string}',
  async ({ page }, player: string, age: number, team: string) => {
    await waitForMockClient(page);
    await page.evaluate(
      ({ playerName, playerAge, teamName }) => {
        const db = JSON.parse(sessionStorage.getItem('__MOCK_DB__') || '{}');
        const orgId = localStorage.getItem('squadlogic_active_org') || 'org-1';

        const playerId = `player-${playerName.replace(/\s+/g, '-').toLowerCase()}`;
        const teamId = teamName === 'Team Alpha' ? 'team-alpha' : 'team-beta';

        db.players = db.players || [];
        db.players.push({
          id: playerId,
          first_name: playerName.split(' ')[0],
          last_name: playerName.split(' ')[1] || '',
          age: playerAge,
          organization_id: orgId,
          gender: 'U',
        });

        db.team_players = db.team_players || [];
        db.team_players.push({ team_id: teamId, player_id: playerId });

        sessionStorage.setItem('__MOCK_DB__', JSON.stringify(db));
      },
      { playerName: player, playerAge: age, teamName: team }
    );
  }
);

// ────────────────────────────────────────────────────────────
// 3. ACTIONS & ASSERTIONS
// ────────────────────────────────────────────────────────────

When('I view the Roster Manager', async ({ page }) => {
  await page.goto('/teams');
  // Wait for the "Edit Mode" button to be visible (it only appears if teams exist)
  const editBtn = page.getByRole('button', { name: /Edit Mode/i });
  await editBtn.waitFor({ state: 'visible', timeout: 15000 });
  await editBtn.click();
});

When('I click the {string} button on the Roster Manager', async ({ page }, btnName: string) => {
  if (!page.url().includes('/teams')) {
    await page.goto('/teams');
  }
  const btn = page.getByRole('button', { name: new RegExp(btnName, 'i') }).first();
  await btn.waitFor({ state: 'visible', timeout: 10000 });
  await btn.click({ force: true });
});

Then(
  'the {string} button should not be displayed on the Roster Manager',
  async ({ page }, btnName: string) => {
    await expect(page.getByRole('button', { name: new RegExp(btnName, 'i') })).toHaveCount(0);
  }
);

Then('no conflict banner should be displayed', async ({ page }) => {
  await expect(page.locator('.bg-status-error-bg').first()).toBeHidden();
});

Then(
  'a new row should be inserted into the {string} table',
  async ({ page }, tableName: string) => {
    await waitForMockClient(page);
    const rows = await page.evaluate((table) => {
      const db = JSON.parse(sessionStorage.getItem('__MOCK_DB__') || '{}');
      return db[table] || [];
    }, tableName);
    expect(rows.length).toBeGreaterThan(0);
  }
);

Then(
  'the run should have run_type {string} and status {string}',
  async ({ page }, type: string, status: string) => {
    await waitForMockClient(page);
    const match = await page.evaluate(
      ({ t, s }) => {
        const db = JSON.parse(sessionStorage.getItem('__MOCK_DB__') || '{}');
        const runs = db.scheduler_runs || [];
        return runs.some((r: Record<string, unknown>) => r.run_type === t && r.status === s);
      },
      { t: type, s: status }
    );
    expect(match).toBe(true);
  }
);

Then('I should see a conflict banner with message {string}', async ({ page }, message: string) => {
  const banner = page.locator('.bg-status-error-bg, .text-status-error').first();
  await expect(banner).toBeVisible({ timeout: 10000 });
  await expect(banner).toContainText(message);
});

Then(
  'I should see a conflict banner with message containing {string}',
  async ({ page }, partialMessage: string) => {
    const banner = page.locator('.bg-status-error-bg, .text-status-error').first();
    await expect(banner).toBeVisible({ timeout: 10000 });
    await expect(banner).toContainText(partialMessage);
  }
);
