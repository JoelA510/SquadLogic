import { createBdd, type DataTable } from 'playwright-bdd';
import { expect, type Page } from '@playwright/test';
import { waitForMockClient } from './mockReady.js';
import { MOCK_ORG_ID, MOCK_SEASON_ID } from '../../../frontend/src/lib/mockSeedIds.js';

const { Given, When, Then } = createBdd();

/**
 * Practice preferences import (Phase D C2). The seeds are the only place these steps touch the mock
 * database, through `window.__saveMockDB__`, and every row carries `organization_id` (hooks filter
 * by the active organization; a row without one renders as an empty state). Everything the steps
 * assert is read from the page.
 *
 * Synthetic names and `example.test` addresses only. Two coaches coach the two teams: Casey coaches
 * both, Robin coaches Owls; Hawks practise Monday at 18:00 and Owls Wednesday at 18:00, at the venue
 * "Prefs Park".
 */

const ROUTE = '/coaches/practice-preferences';
const IDS = {
  park: 'aaaaaaaa-0000-4000-8000-0000000000a1',
  north: 'aaaaaaaa-0000-4000-8000-0000000000a2',
  division: 'prefs-division',
  hawks: 'prefs-team-hawks',
  owls: 'prefs-team-owls',
  casey: 'prefs-coach-casey',
  robin: 'prefs-coach-robin',
  job: 'prefs-import-job-1',
} as const;

/** Rows added to mock tables, each stamped with the active organization unless it names one. */
async function seed(page: Page, rows: Record<string, Array<Record<string, unknown>>>) {
  await waitForMockClient(page);
  await page.evaluate(
    ({ rows, mockOrgId }) => {
      const db = window.__MOCK_DB__ as Record<string, Array<Record<string, unknown>>>;
      const orgId = localStorage.getItem('squadlogic_active_org') || mockOrgId;
      for (const [table, added] of Object.entries(rows)) {
        const ids = new Set(added.map((row) => row.id));
        db[table] = [
          ...(db[table] ?? []).filter((row) => !ids.has(row.id)),
          ...added.map((row) => ({ organization_id: orgId, ...row })),
        ];
      }
      window.__saveMockDB__(db);
    },
    { rows, mockOrgId: MOCK_ORG_ID }
  );
}

/** A rule as the store holds it (the importer's rule, in force, for one team). */
function rule(id: string, over: Record<string, unknown>) {
  return {
    id,
    level: 'prefer',
    requested_level: 'prefer',
    must_decision: null,
    status: 'in_force',
    source: 'import',
    import_job_id: IDS.job,
    weekdays: null,
    start_minutes: null,
    venue_ids: null,
    keep_weekday: false,
    keep_start: false,
    keep_venue: false,
    coach_priority: null,
    effective_from: null,
    effective_to: null,
    created_at: '2026-09-20T10:00:00Z',
    decided_at: null,
    ...over,
  };
}

const pendingMust = (id: string, over: Record<string, unknown>) =>
  rule(id, { requested_level: 'must', must_decision: 'pending', ...over });

Given('a season with two teams, two coaches and no practice preferences', async ({ page }) => {
  const slot = (day: string) => ({
    day_of_week: day,
    start_time: '18:00:00',
    field: { location_id: IDS.park },
  });
  await seed(page, {
    locations: [
      { id: IDS.park, name: 'Prefs Park' },
      { id: IDS.north, name: 'Prefs North' },
    ],
    divisions: [{ id: IDS.division, season_settings_id: MOCK_SEASON_ID, name: 'Prefs U10' }],
    teams: [
      { id: IDS.hawks, division_id: IDS.division, name: 'Prefs Hawks' },
      { id: IDS.owls, division_id: IDS.division, name: 'Prefs Owls' },
    ],
    coaches: [
      {
        id: IDS.casey,
        season_settings_id: MOCK_SEASON_ID,
        full_name: 'Casey Prefs',
        email: 'casey.prefs@example.test',
      },
      {
        id: IDS.robin,
        season_settings_id: MOCK_SEASON_ID,
        full_name: 'Robin Prefs',
        email: 'robin.prefs@example.test',
      },
    ],
    team_coach_assignments: [
      ...[IDS.hawks, IDS.owls].map((team) => ({
        id: `prefs-tca-casey-${team}`,
        team_id: team,
        coach_id: IDS.casey,
        role: 'lead',
        effective_from: '2026-01-01',
        effective_to: null,
      })),
      {
        id: 'prefs-tca-robin-owls',
        team_id: IDS.owls,
        coach_id: IDS.robin,
        role: 'assistant',
        effective_from: '2026-01-01',
        effective_to: null,
      },
    ],
    practice_assignments: [
      { id: 'prefs-pa-hawks', team_id: IDS.hawks, effective_date_range: null, slot: slot('mon') },
      { id: 'prefs-pa-owls', team_id: IDS.owls, effective_date_range: null, slot: slot('wed') },
    ],
    coach_practice_preferences: [],
  });
});

Given(
  'a file of practice preferences was imported with two musts that disagree',
  async ({ page }) => {
    await seed(page, {
      import_jobs: [
        {
          id: IDS.job,
          job_type: 'registration',
          storage_path: 'imports/mock-admin-id/spring-preferences.csv',
          status: 'completed',
          season_settings_id: MOCK_SEASON_ID,
          created_at: '2026-09-20T10:00:00Z',
        },
      ],
      coach_practice_preferences: [
        // Two pending musts for Hawks that no practice can meet together: Tuesday against Thursday.
        pendingMust('prefs-rule-tue', {
          coach_id: IDS.casey,
          team_id: IDS.hawks,
          weekdays: ['TUE'],
          coach_priority: 'high',
        }),
        pendingMust('prefs-rule-thu', {
          coach_id: IDS.casey,
          team_id: IDS.hawks,
          weekdays: ['THU'],
          created_at: '2026-09-20T10:00:01Z',
        }),
        // A plain imported prefer on the other team.
        rule('prefs-rule-owls', {
          coach_id: IDS.robin,
          team_id: IDS.owls,
          weekdays: ['MON'],
          start_minutes: [1020, 1080],
          created_at: '2026-09-20T10:00:02Z',
        }),
      ],
    });
  }
);

Given('the admin added a rule for {string} in the app', async ({ page }, team: string) => {
  expect(team).toBe('Prefs Hawks');
  await seed(page, {
    coach_practice_preferences: [
      rule('prefs-rule-admin', {
        coach_id: IDS.casey,
        team_id: IDS.hawks,
        source: 'admin',
        import_job_id: null,
        venue_ids: [IDS.park],
        created_at: '2026-09-21T10:00:00Z',
      }),
    ],
  });
});

Given("the admin accepted the file's musts", async ({ page }) => {
  await seed(page, {
    coach_practice_preferences: ['prefs-rule-tue', 'prefs-rule-thu'].map((id) =>
      rule(id, {
        coach_id: IDS.casey,
        team_id: IDS.hawks,
        weekdays: [id.endsWith('tue') ? 'TUE' : 'THU'],
        level: 'must',
        requested_level: 'must',
        must_decision: 'accepted',
      })
    ),
  });
});

Given('the season is completed', async ({ page }) => {
  await seed(page, {
    season_settings: [{ id: MOCK_SEASON_ID, status: 'completed', name: 'Fall 2026' }],
  });
});

When('I open the practice preferences page', async ({ page }) => {
  await page.goto(ROUTE);
  await expect(
    page.getByRole('heading', { name: 'Practice preferences', exact: true })
  ).toBeVisible({
    timeout: 20_000,
  });
  // The rules, coaches and roster are read before the tabs draw.
  await expect(page.getByTestId('admin-preferences-view')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('tab', { name: 'Rules' })).toBeVisible();
});

When('I open the {string} tab of the practice preferences page', async ({ page }, tab: string) => {
  await page.getByRole('tab', { name: new RegExp(`^${tab}`) }).click();
  await expect(page.getByRole('tab', { name: new RegExp(`^${tab}`) })).toHaveAttribute(
    'aria-selected',
    'true'
  );
});

/** The CSV a table of rows makes: the first row of the table is the header. */
function csvOf(table: DataTable): string {
  const cell = (value: string) => (/[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
  return table
    .raw()
    .map((row) => row.map((value) => cell(value.trim())).join(','))
    .join('\n');
}

When(
  'I choose a preference file named {string} with these rows:',
  async ({ page }, name: string, table: DataTable) => {
    await page.getByLabel('Choose a CSV file').setInputFiles({
      name,
      mimeType: 'text/csv',
      buffer: Buffer.from(csvOf(table)),
    });
    // The preview draws once the file is read and the season's data is in; the empty-file and
    // other refusals draw a problem instead, which the Then steps read.
    await expect(
      page
        .getByTestId('preference-import-preview')
        .or(page.getByTestId('preference-import-problem'))
    ).toBeVisible({ timeout: 20_000 });
  }
);

When('I choose an empty preference file', async ({ page }) => {
  await page.getByLabel('Choose a CSV file').setInputFiles({
    name: 'empty.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(''),
  });
  await expect(page.getByTestId('preference-import-problem')).toBeVisible({ timeout: 20_000 });
});

/** The big number under a metric's label in the preview. */
async function metric(page: Page, label: string) {
  const term = page.getByTestId('preference-import-preview').getByText(label, { exact: true });
  await expect(term).toBeVisible();
  return term.locator('xpath=following-sibling::dd[1]');
}

Then(
  'the preview says it will add {int} rule(s) for {int} team(s)',
  async ({ page }, rules: number, teams: number) => {
    await expect(await metric(page, 'Rules to add')).toHaveText(String(rules));
    await expect(page.getByTestId('preference-import-preview')).toContainText(
      `for ${teams} ${teams === 1 ? 'team' : 'teams'}`
    );
  }
);

Then('the preview says {int} musts will wait for a decision', async ({ page }, count: number) => {
  await expect(await metric(page, 'Musts waiting for you')).toHaveText(String(count));
});

Then(
  'the preview lists the coach {string} as one it will not create',
  async ({ page }, email: string) => {
    await expect(page.getByTestId('preview-refused-unknown_coach')).toContainText(email);
  }
);

Then(
  'the preview lists the team {string} as one it will not create',
  async ({ page }, team: string) => {
    await expect(page.getByTestId('preview-refused-unknown_team')).toContainText(team);
  }
);

Then(
  'the preview says row {int} makes a rule for each of {string}',
  async ({ page }, row: number, teams: string) => {
    await expect(page.getByTestId('preview-fanout')).toContainText(`Row ${row}`);
    await expect(page.getByTestId('preview-fanout')).toContainText(teams);
  }
);

Then('the preview says it replaces {int} imported rules', async ({ page }, count: number) => {
  await expect(await metric(page, 'Imported rules replaced')).toHaveText(String(count));
});

Then('the preview says nothing in the file can be applied', async ({ page }) => {
  await expect(page.getByTestId('preview-nothing')).toContainText(
    'Nothing in this file can be applied'
  );
});

Then('the import button says {string} and is off', async ({ page }, label: string) => {
  await expect(page.getByRole('button', { name: label, exact: true })).toBeDisabled();
});

Then('the page says the file appears to be empty', async ({ page }) => {
  await expect(page.getByTestId('preference-import-problem')).toContainText('appears to be empty');
});

Then('no preview is shown', async ({ page }) => {
  await expect(page.getByTestId('preference-import-preview')).toHaveCount(0);
});

When('I import the file', async ({ page }) => {
  await page.getByRole('button', { name: /^Import \d+ rules?$/ }).click();
});

Then(
  'the import result says {int} rule(s) was/were added for {int} team(s)',
  async ({ page }, rules: number, teams: number) => {
    await expect(page.getByTestId('preference-import-summary')).toContainText(
      `${rules} ${rules === 1 ? 'rule' : 'rules'} added for ${teams} ${teams === 1 ? 'team' : 'teams'}`,
      { timeout: 20_000 }
    );
  }
);

When('I review the pending musts', async ({ page }) => {
  await page.getByRole('button', { name: /^Review \d+ pending musts?$/ }).click();
  await expect(page.getByRole('heading', { name: /^Pending musts \(/ })).toBeVisible();
});

Then('{int} musts are pending', async ({ page }, count: number) => {
  await expect(page.getByRole('heading', { name: `Pending musts (${count})` })).toBeVisible({
    timeout: 20_000,
  });
});

When('I open Accept all', async ({ page }) => {
  await page.getByRole('button', { name: /^Accept all \d+/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Accept all pending musts' });
  await expect(dialog).toBeVisible();
  // Focus is inside the dialog, not behind it.
  await expect.poll(() => dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);
});

Then('the confirmation names {int} rules', async ({ page }, count: number) => {
  const dialog = page.getByRole('dialog', { name: 'Accept all pending musts' });
  await expect(dialog.getByTestId('accept-all-count')).toContainText(
    `This makes ${count} rules musts`
  );
  await expect(dialog.getByRole('button', { name: `Make ${count} rules musts` })).toBeEnabled();
});

Then(
  'the confirmation lists {int} conflict before anything else',
  async ({ page }, count: number) => {
    const dialog = page.getByRole('dialog', { name: 'Accept all pending musts' });
    await expect(dialog.getByRole('heading', { name: `Conflicts (${count})` })).toBeVisible();
    await expect(dialog.getByTestId('accept-all-conflict')).toHaveCount(count);
    // Conflicts come before the practice series in the document.
    const order = await dialog.locator('h3').allTextContents();
    expect(order[0]).toBe(`Conflicts (${count})`);
  }
);

When('I confirm Accept all', async ({ page }) => {
  const dialog = page.getByRole('dialog', { name: 'Accept all pending musts' });
  await dialog.getByRole('button', { name: /^Make \d+ rule/ }).click();
  await expect(dialog).toHaveCount(0, { timeout: 20_000 });
});

Then('no musts are pending', async ({ page }) => {
  await expect(page.getByRole('heading', { name: 'Pending musts (0)' })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByText('No pending musts.')).toBeVisible();
});

Then(
  'the rules list shows {int} musts and {int} prefers',
  async ({ page }, musts: number, prefers: number) => {
    await page.getByRole('tab', { name: 'Rules' }).click();
    const rows = page.getByRole('table').getByRole('row');
    // The header row, then one per rule.
    await expect(rows).toHaveCount(musts + prefers + 1);
    const levels = await rows.evaluateAll((trs) =>
      trs.slice(1).map((tr) => tr.querySelectorAll('td')[2]?.textContent ?? '')
    );
    expect(levels.filter((text) => text.startsWith('Must'))).toHaveLength(musts);
    expect(levels.filter((text) => text.startsWith('Prefer'))).toHaveLength(prefers);
  }
);

Then(
  "the rules list shows a rule for {string} on Friday, the admin's rule and the other team's rule",
  async ({ page }, team: string) => {
    const rows = page.getByRole('table').getByRole('row');
    await expect(rows).toHaveCount(4);
    const hawks = rows.filter({ hasText: team });
    await expect(hawks).toHaveCount(2);
    await expect(hawks.filter({ hasText: 'Friday' })).toHaveCount(1);
    await expect(hawks.filter({ hasText: 'Prefs Park' })).toHaveCount(1);
    await expect(rows.filter({ hasText: 'Prefs Owls' })).toHaveCount(1);
  }
);

Then(
  'the rules list shows no rule for {string} on Tuesday or Thursday',
  async ({ page }, team: string) => {
    const hawks = page.getByRole('table').getByRole('row').filter({ hasText: team });
    await expect(hawks.filter({ hasText: /Tuesday|Thursday/ })).toHaveCount(0);
  }
);

Then('the file chooser is off', async ({ page }) => {
  await expect(page.getByLabel('Choose a CSV file')).toBeDisabled();
  await expect(page.getByTestId('preference-import-readonly')).toContainText('takes no import');
});

Then('the Add a rule button is off', async ({ page }) => {
  await expect(page.getByRole('button', { name: 'Add a rule…' })).toBeDisabled();
});

Then(
  'the conflicts view lists {int} conflict on {string}',
  async ({ page }, count: number, team: string) => {
    await expect(page.getByTestId('conflict')).toHaveCount(count);
    await expect(
      page.getByTestId('conflict-team').getByRole('heading', { name: team })
    ).toBeVisible();
  }
);
