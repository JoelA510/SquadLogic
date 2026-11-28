import { createBdd } from 'playwright-bdd';
import { expect } from '@playwright/test';
import { MOCK_ORG_ID, MOCK_SEASON_ID } from '../../../frontend/src/lib/mockSeedIds.js';

const { Given, Then } = createBdd();

Given(
  'the season has two junior teams capped at fourteen with twenty-five assigned players',
  async ({ page }) => {
    await page.evaluate(
      ({ org, season }) => {
        const scope = { organization_id: org, season_settings_id: season };
        const db = window.__MOCK_DB__ as Record<string, Record<string, unknown>[]>;
        const division = { ...scope, id: 'capacity-junior', name: 'Junior', max_roster_size: 14 };
        const teams = ['Suns', 'Moons'].map((name) => ({
          id: 'capacity-' + name,
          name,
          division_id: division.id,
          organization_id: org,
        }));
        const players = Array.from({ length: 25 }, (_, i) => ({
          ...scope,
          id: 'capacity-player-' + i,
          first_name: 'Fixture',
          last_name: String(i),
          division_id: division.id,
          team_id: teams[i % 2].id,
        }));
        const now = new Date().toISOString();
        window.__saveMockDB__({
          ...db,
          divisions: [...db.divisions, division],
          teams: [...db.teams, ...teams],
          players: [...db.players, ...players],
          scheduler_runs: [
            ...db.scheduler_runs.filter((run) => run.id !== 'run-1'),
            {
              ...scope,
              id: 'run-1',
              run_type: 'team',
              status: 'completed',
              created_at: now,
              completed_at: now,
              results: {
                teamsByDivision: { Junior: teams },
                rosterBalanceByDivision: {
                  Junior: { summary: { totalPlayers: 25, totalCapacity: 28 } },
                },
              },
            },
          ],
        });
      },
      { org: MOCK_ORG_ID, season: MOCK_SEASON_ID }
    );
  }
);

Then('the junior division on the home page shows {string}', async ({ page }, expected: string) => {
  const card = page.getByRole('heading', { name: 'Division capacity' }).locator('..').locator('..');
  await expect(card.getByText('Junior', { exact: true }).locator('..')).toContainText(expected);
});

Then(
  'the junior division in the teaming overview shows {string} utilization',
  async ({ page }, expected: string) => {
    const step = page.getByRole('button', { name: '2. Teaming & Analysis', exact: true });
    await expect(step).toBeVisible();
    await step.click();
    await expect(page.getByRole('article', { name: 'Target Players' })).toContainText('28');
    await expect(
      page.getByRole('article', { name: 'Junior' }).getByText(expected, { exact: true })
    ).toBeVisible();
  }
);
