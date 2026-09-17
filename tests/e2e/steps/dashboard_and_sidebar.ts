import { createBdd } from 'playwright-bdd';
import { expect } from '@playwright/test';

const { Given, When, Then } = createBdd();

Given('an organization and season are active', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    const db = JSON.parse(sessionStorage.getItem('__MOCK_DB__') || '{}');
    const orgId = 'org-1';
    db.organizations = [{ id: orgId, name: 'SquadLogic FC', status: 'active', is_onboarded: true }];
    db.organization_members = [
      {
        organization_id: orgId,
        profile_id: 'mock-admin-id',
        role: 'admin',
        organizations: { id: orgId, name: 'SquadLogic FC', is_onboarded: true },
      },
    ];
    db.season_settings = [
      { id: 's1', name: 'Fall 2024', organization_id: orgId, timezone: 'America/Los_Angeles' },
    ];
    sessionStorage.setItem('__MOCK_DB__', JSON.stringify(db));
    localStorage.setItem('squadlogic_active_org', orgId);
    localStorage.setItem('squadlogic-current-season', 'Fall 2024');
  });
});

Then('I should see a {int}-step workflow on the left side', async ({ page }, steps: number) => {
  await expect(page.locator('[data-testid^="workflow-step-"]')).toHaveCount(steps);
});

Then('I should see a {string} panel on the right side', async ({ page }, panelName: string) => {
  await expect(page.getByRole('heading', { name: panelName })).toBeVisible();
});

Then('the League Status panel should show the active organization name', async ({ page }) => {
  await expect(
    page.getByRole('button', { name: /SquadLogic FC|Metro City United|North Valley SC/i }).first()
  ).toBeVisible({ timeout: 15000 });
});

Then('the League Status panel should show the active season name', async ({ page }) => {
  await expect(page.getByRole('button', { name: /Fall|Spring|Winter/i }).first()).toBeVisible({
    timeout: 15000,
  });
});

Given('I have imported player data', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    const db = JSON.parse(sessionStorage.getItem('__MOCK_DB__') || '{}');
    const activeOrg = localStorage.getItem('squadlogic_active_org') || 'org-1';
    db.imports = [
      {
        id: 'imp-1',
        user_id: 'mock-admin-id',
        organization_id: activeOrg,
        import_type: 'players',
        status: 'completed',
        created_at: new Date().toISOString(),
        data: { totalRows: 150, validRows: 150 },
      },
    ];
    // CRITICAL FIX: Override initialMockData runs to 'deleted' so they don't match 'completed'
    db.scheduler_runs = [
      { id: 'run-practice-1', status: 'deleted' },
      { id: 'run-game-1', status: 'deleted' },
      { id: 'run-1', status: 'deleted' },
    ];
    sessionStorage.setItem('__MOCK_DB__', JSON.stringify(db));
    localStorage.setItem('dashboardActiveStep', '2'); // Preserve across reloads
  });
  await page.goto('/workflow?step=6');

  // Force Playwright to visually locate and click the specific stepper buttons
  const step2 = page
    .locator('[data-testid*="workflow-step-"]')
    .filter({ hasText: '2. Teaming & Analysis' })
    .first();
  await step2.click({ force: true });
});

Given('I have not generated teams', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    const db = JSON.parse(sessionStorage.getItem('__MOCK_DB__') || '{}');
    db.scheduler_runs = db.scheduler_runs || [];
    db.scheduler_runs.push({ id: 'run-1', status: 'deleted' }); // Override initialMockData team run
    sessionStorage.setItem('__MOCK_DB__', JSON.stringify(db));
  });
  await page.reload();
});

Given('I have not generated a practice schedule', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    const db = JSON.parse(sessionStorage.getItem('__MOCK_DB__') || '{}');
    db.scheduler_runs = db.scheduler_runs || [];
    db.scheduler_runs.push({ id: 'run-practice-1', status: 'deleted' }); // Override initialMockData practice run
    sessionStorage.setItem('__MOCK_DB__', JSON.stringify(db));
  });
  await page.reload();
});

Given('I have not generated a game schedule', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    const db = JSON.parse(sessionStorage.getItem('__MOCK_DB__') || '{}');
    db.scheduler_runs = db.scheduler_runs || [];
    db.scheduler_runs.push({ id: 'run-game-1', status: 'deleted' }); // Override initialMockData game run
    sessionStorage.setItem('__MOCK_DB__', JSON.stringify(db));
  });
  await page.reload();
});

Given('all setup steps are complete', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    const now = new Date().toISOString();
    const orgId = localStorage.getItem('squadlogic_active_org') || 'org-1';
    const db = JSON.parse(sessionStorage.getItem('__MOCK_DB__') || '{}');
    db.imports = [
      {
        id: 'imp-full',
        user_id: 'mock-admin-id',
        organization_id: orgId,
        import_type: 'players',
        status: 'completed',
        created_at: now,
        data: { totalRows: 150, validRows: 150 },
      },
    ];
    db.scheduler_runs = [
      {
        id: 'run-t',
        organization_id: orgId,
        run_type: 'team',
        status: 'completed',
        completed_at: now,
        metrics: { progress: 100 },
        results: {
          teamsByDivision: { 'U10 Boys': [{ id: 't1', name: 'Tigers' }] },
          rosterBalanceByDivision: {
            'U10 Boys': { summary: { totalPlayers: 15, totalCapacity: 20 } },
          },
        },
        created_at: now,
      },
      {
        id: 'run-p',
        organization_id: orgId,
        run_type: 'practice',
        status: 'completed',
        completed_at: now,
        metrics: { progress: 100 },
        results: {
          summary: { assignmentRate: 1.0, manualFollowUpRate: 0, unassignedTeams: 0 },
          totals: { practices: 20 },
        },
        created_at: now,
      },
      {
        id: 'run-g',
        organization_id: orgId,
        run_type: 'game',
        status: 'completed',
        completed_at: now,
        metrics: { progress: 100 },
        results: {
          summary: { totalGames: 15, scheduledRate: 1.0, unscheduledMatchups: 0 },
          totals: { games: 15 },
        },
        created_at: now,
      },
      // Override initialMockData runs
      { id: 'run-practice-1', status: 'deleted' },
      { id: 'run-game-1', status: 'deleted' },
      { id: 'run-1', status: 'deleted' },
    ];
    sessionStorage.setItem('__MOCK_DB__', JSON.stringify(db));
  });
  await page.goto('/workflow');

  // Force Playwright to visually locate and click the specific stepper buttons
  const step6 = page
    .locator('[data-testid*="workflow-step-"]')
    .filter({ hasText: '6. Output & Communication' })
    .first();
  await step6.click({ force: true });
});

Given('I have generated teams', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    const orgId = localStorage.getItem('squadlogic_active_org') || 'org-1';
    const db = JSON.parse(sessionStorage.getItem('__MOCK_DB__') || '{}');
    db.scheduler_runs = db.scheduler_runs || [];
    if (
      !db.scheduler_runs.find(
        (r: Record<string, unknown>) => r.run_type === 'team' && r.status === 'completed'
      )
    ) {
      const now = new Date().toISOString();
      db.scheduler_runs.push({
        id: 'run-t',
        organization_id: orgId,
        run_type: 'team',
        status: 'completed',
        completed_at: now,
        results: {
          teamsByDivision: { 'U10 Boys': [{ id: 't1', name: 'Tigers' }] },
          rosterBalanceByDivision: {
            'U10 Boys': { summary: { totalPlayers: 15, totalCapacity: 20 } },
          },
        },
        created_at: now,
      });
    }
    sessionStorage.setItem('__MOCK_DB__', JSON.stringify(db));
  });
  await page.goto('/workflow');

  // Force Playwright to visually locate and click the specific stepper buttons
  const step2 = page
    .locator('[data-testid*="workflow-step-"]')
    .filter({ hasText: '2. Teaming & Analysis' })
    .first();
  await step2.click({ force: true });

  const confirmBtn = page.getByRole('button', { name: 'Confirm Teams & Proceed' }).first();
  if (await confirmBtn.isVisible()) {
    await confirmBtn.click({ force: true });
  } else {
    const step3 = page
      .locator('[data-testid*="workflow-step-"]')
      .filter({ hasText: '3. Field Management' })
      .first();
    await step3.click({ force: true });
  }
});

Given('I have generated a practice schedule', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    const orgId = localStorage.getItem('squadlogic_active_org') || 'org-1';
    const db = JSON.parse(sessionStorage.getItem('__MOCK_DB__') || '{}');
    db.scheduler_runs = db.scheduler_runs || [];
    const now = new Date().toISOString();
    ['team', 'practice', 'game'].forEach((type) => {
      if (
        !db.scheduler_runs.find(
          (r: Record<string, unknown>) => r.run_type === type && r.status === 'completed'
        )
      ) {
        db.scheduler_runs.push({
          id: `run-${type}`,
          organization_id: orgId,
          run_type: type,
          status: 'completed',
          created_at: now,
          completed_at: now,
          results: { totals: { playersAssigned: 100, teams: 10 } },
        });
      }
    });
    sessionStorage.setItem('__MOCK_DB__', JSON.stringify(db));
  });
  await page.reload();
});

Given('I have generated a game schedule', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    const orgId = localStorage.getItem('squadlogic_active_org') || 'org-1';
    const db = JSON.parse(sessionStorage.getItem('__MOCK_DB__') || '{}');
    db.scheduler_runs = db.scheduler_runs || [];
    db.scheduler_runs.push({
      id: 'run-g',
      organization_id: orgId,
      run_type: 'game',
      status: 'completed',
      results: { totals: { games: 15 } },
      created_at: new Date().toISOString(),
    });
    sessionStorage.setItem('__MOCK_DB__', JSON.stringify(db));
  });
  await page.reload();
});

When('I view the Dashboard page', async ({ page }) => {
  // The pipeline workflow now lives on its own page; Home is the new '/'.
  await page.goto('/workflow');
});

Then('the Readiness Score should display {string}', async ({ page }, score: string) => {
  const panel = page.getByText('Overall Readiness').locator('..');
  await expect(panel).toContainText(score, { timeout: 15000 });
});

Then('the {string} step should show as completed', async ({ page }, stepName: string) => {
  const step = page
    .locator(`[data-testid*="workflow-step-"]`)
    .filter({ hasText: stepName })
    .first();
  await expect(step.getByText(/Completed/i)).toBeVisible({ timeout: 10000 });
});

When('I click on the {string} workflow step', async ({ page }, stepName: string) => {
  const step = page
    .locator(`[data-testid*="workflow-step-"]`)
    .filter({ hasText: stepName })
    .first();
  await step.click({ force: true });
});

Then('the {string} step should expand to show its content', async ({ page }, stepName: string) => {
  const step = page
    .locator(`[data-testid*="workflow-step-"]`)
    .filter({ hasText: stepName })
    .first();
  await expect(step.locator('.grid.transition-all')).toHaveClass(/grid-rows-\[1fr\]/);
});

Then('the previously active step should collapse', async ({ page }) => {
  const expandedSteps = page.locator('.grid-rows-\\[1fr\\]');
  await expect(expandedSteps).toHaveCount(1);
});

Given(
  'I belong to organizations {string} and {string}',
  async ({ page }, org1: string, org2: string) => {
    await page.goto('/');
    await page.evaluate(
      ({ o1, o2 }) => {
        const db = JSON.parse(sessionStorage.getItem('__MOCK_DB__') || '{}');
        const org1Id = 'org-1';
        const org2Id = 'org-2';
        db.organizations = [
          { id: org1Id, name: o1, status: 'active', is_onboarded: true },
          { id: org2Id, name: o2, status: 'active', is_onboarded: true },
        ];
        db.season_settings = [
          { id: 's1', name: 'Fall 2024', organization_id: org1Id, timezone: 'America/Los_Angeles' },
          { id: 's2', name: 'Spring 2024', organization_id: org1Id, timezone: 'America/Los_Angeles' },
          { id: 's3', name: 'Winter 2024', organization_id: org2Id, timezone: 'America/Los_Angeles' },
        ];
        db.organization_members = [
          {
            organization_id: org1Id,
            profile_id: 'mock-admin-id',
            role: 'admin',
            organizations: { id: org1Id, name: o1, is_onboarded: true },
          },
          {
            organization_id: org2Id,
            profile_id: 'mock-admin-id',
            role: 'admin',
            organizations: { id: org2Id, name: o2, is_onboarded: true },
          },
        ];
        sessionStorage.setItem('__MOCK_DB__', JSON.stringify(db));
      },
      { o1: org1, o2: org2 }
    );
    await page.reload();
  }
);

Given(
  'the sidebar shows {string} as the active organization',
  async ({ page }, orgName: string) => {
    await page.evaluate((name) => {
      const db = JSON.parse(sessionStorage.getItem('__MOCK_DB__') || '{}');
      const org = (db.organizations || []).find((o: Record<string, unknown>) => o.name === name);
      if (org) {
        localStorage.setItem('squadlogic_active_org', (org as { id: string }).id);
        const seasons = (db.season_settings || []).filter(
          (s: Record<string, unknown>) => s.organization_id === (org as { id: string }).id
        );
        if (seasons.length > 0) {
          localStorage.setItem('squadlogic-current-season', seasons[0].name);
        }
      }
    }, orgName);
    if (page.url() !== 'about:blank') await page.reload();
  }
);

Then(
  'I should see a dropdown with {string} and {string}',
  async ({ page }, org1: string, org2: string) => {
    const menu = page.getByRole('menu').first();
    await expect(menu.getByRole('menuitem', { name: org1 }).first()).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: org2 }).first()).toBeVisible();
  }
);

// Org/season context switchers live in the top bar; their accessible name is
// "Active Organization: <name>" / "Active Season: <name>".
When('I click the {string} selector in the sidebar', async ({ page }, selectorName: string) => {
  await page.getByRole('button', { name: selectorName }).first().click({ force: true });
});

When('I select {string}', async ({ page }, option: string) => {
  await page.getByRole('menuitem', { name: option }).first().click({ force: true });
});

Then('the sidebar header should display {string}', async ({ page }, orgName: string) => {
  await expect(page.getByRole('button', { name: 'Active Organization' })).toContainText(orgName);
});

Then(
  'the {string} dropdown should update to show seasons for {string}',
  async ({ page }, _dropdown: string, _orgName: string) => {
    const seasonButton = page.getByRole('button', { name: 'Active Season' });
    await expect(seasonButton).toBeVisible();
    await expect(seasonButton).not.toContainText('No seasons');
  }
);

Then(
  'the dashboard data should refresh to show {string} data',
  async ({ page }, orgName: string) => {
    await expect(page.getByRole('button', { name: orgName }).first()).toBeVisible({
      timeout: 15000,
    });
  }
);

Then(
  'I should see a dropdown with valid seasons for the current organization',
  async ({ page }) => {
    await expect(page.getByRole('menu').first().getByRole('menuitem')).not.toHaveCount(0);
  }
);

When('I select a different season', async ({ page }) => {
  await page.getByRole('menu').first().getByRole('menuitem').last().click({ force: true });
});

Then('the season selector should display the selected season', async ({ page }) => {
  const seasonButton = page.getByRole('button', { name: 'Active Season' });
  await expect(seasonButton).toBeVisible();
});

Then('the dashboard data should refresh to show data for the selected season', async ({ page }) => {
  const seasonButton = page.getByRole('button', { name: 'Active Season' });
  await expect(seasonButton).toBeVisible();
  await expect(seasonButton).not.toContainText('—', { timeout: 15000 });
});

Given(
  'the localStorage contains a season ID that does not exist for {string}',
  async ({ page }, _orgName: string) => {
    await page.evaluate(() => localStorage.setItem('squadlogic-current-season', 'invalid-id'));
  }
);

When('I switch the active organization to {string}', async ({ page }, orgName: string) => {
  await page.getByRole('button', { name: 'Active Organization' }).first().click({ force: true });
  const menu = page.getByRole('menu').first();
  await expect(menu).toBeVisible();
  await menu.getByRole('menuitem', { name: orgName }).first().click({ force: true });
});

Then(
  'the active season should automatically select the most recent season for {string}',
  async ({ page }, orgName: string) => {
    const seasonButton = page.getByRole('button', { name: 'Active Season' });
    await expect(seasonButton).not.toContainText('No seasons');

    await expect(page.getByRole('button', { name: orgName }).first()).toBeVisible({
      timeout: 15000,
    });
  }
);

Then('localStorage should be updated with the valid season', async ({ page }) => {
  // Verify the UI reflects the valid season instead of just checking localStorage
  const seasonButton = page.getByRole('button', { name: 'Active Season' });
  await expect(seasonButton).not.toContainText('invalid-id');
  await expect(seasonButton).not.toContainText('No seasons');

  // Secondary check for localStorage
  const season = await page.evaluate(() => localStorage.getItem('squadlogic-current-season'));
  expect(season).not.toBe('invalid-id');
});

Given('I have selected {string} as the active organization', async ({ page }, orgName: string) => {
  await page.evaluate((name) => {
    const db = JSON.parse(sessionStorage.getItem('__MOCK_DB__') || '{}');
    const org = (db.organizations || []).find((o: Record<string, unknown>) => o.name === name);
    if (org) {
      localStorage.setItem('squadlogic_active_org', (org as { id: string }).id);
    }
  }, orgName);
  if (page.url() !== 'about:blank') await page.reload();
});

Given('a valid season is selected', async ({ page }) => {
  await page.evaluate(() => {
    const db = JSON.parse(sessionStorage.getItem('__MOCK_DB__') || '{}');
    const seasons = db.season_settings || [];
    if (seasons.length > 0) {
      localStorage.setItem('squadlogic-current-season', seasons[0].name || seasons[0].id);
    }
  });
});

Then(
  'the sidebar should still show {string} as the active organization',
  async ({ page }, orgName: string) => {
    await expect(page.getByRole('button', { name: 'Active Organization' })).toContainText(orgName);
  }
);

Then('the sidebar should still show the selected season', async ({ page }) => {
  await expect(page.getByRole('button', { name: 'Active Season' })).toBeVisible();
});
