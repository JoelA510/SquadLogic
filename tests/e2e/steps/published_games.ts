import { createBdd } from 'playwright-bdd';
import { expect, type Page } from '@playwright/test';
import { waitForMockClient } from './mockReady.js';

const { Given, When, Then } = createBdd();

/**
 * The league of `published_games.feature` (schedule expansion, PR 3), seeded into the mock database as inputs: a club
 * of its own (a UUID organization, as in production), two venues, two fields, eight game slots, the teams of a team
 * run, and five SAVED games in one completed game run. Nothing here writes a result of the Published switch: it is
 * pressed through the page, and the page's own mock client answers it.
 *
 * | game      | division  | home v away      | week | slot | field |
 * | e2e-ga-1  | U10 Boys  | Lions v Wolves   | 1    | gs-1 | North |
 * | e2e-ga-2  | U10 Boys  | Comets v Bulls   | 1    | gs-2 | South |
 * | e2e-ga-3  | U10 Boys  | Lions v Comets   | 2    | gs-3 | North |
 * | e2e-ga-4  | U10 Boys  | Wolves v Bulls   | 2    | gs-4 | South |
 * | e2e-ga-5  | U12 Girls | Hawks v Owls     | 1    | gs-5 | North |
 *
 * Two slots are empty (week 3: gs-7 on North, gs-8 on South).
 */
const CLUB = {
  orgId: '00000000-0000-4000-8000-0000000000e9',
  seasonId: 'e2e-published-season',
  runId: '00000000-0000-4000-8000-0000000000c9',
};
const ADMIN_ID = 'mock-admin-id';

type SeedGame = {
  id: string;
  division: string;
  home: string;
  away: string;
  week: number;
  slot: string;
  field: 'north' | 'south';
};
const GAMES: SeedGame[] = [
  {
    id: 'e2e-ga-1',
    division: 'U10 Boys',
    home: 'Lions',
    away: 'Wolves',
    week: 1,
    slot: 'e2e-gs-1',
    field: 'north',
  },
  {
    id: 'e2e-ga-2',
    division: 'U10 Boys',
    home: 'Comets',
    away: 'Bulls',
    week: 1,
    slot: 'e2e-gs-2',
    field: 'south',
  },
  {
    id: 'e2e-ga-3',
    division: 'U10 Boys',
    home: 'Lions',
    away: 'Comets',
    week: 2,
    slot: 'e2e-gs-3',
    field: 'north',
  },
  {
    id: 'e2e-ga-4',
    division: 'U10 Boys',
    home: 'Wolves',
    away: 'Bulls',
    week: 2,
    slot: 'e2e-gs-4',
    field: 'south',
  },
  {
    id: 'e2e-ga-5',
    division: 'U12 Girls',
    home: 'Hawks',
    away: 'Owls',
    week: 1,
    slot: 'e2e-gs-5',
    field: 'north',
  },
];
/** [id, week, date, start (UTC), field]: 16:00Z is 09:00 in Los Angeles in October. */
const SLOTS: Array<[string, number, string, string, 'north' | 'south']> = [
  ['e2e-gs-1', 1, '2026-10-03', '16:00', 'north'],
  ['e2e-gs-2', 1, '2026-10-03', '16:00', 'south'],
  ['e2e-gs-3', 2, '2026-10-10', '16:00', 'north'],
  ['e2e-gs-4', 2, '2026-10-10', '16:00', 'south'],
  ['e2e-gs-5', 1, '2026-10-03', '18:00', 'north'],
  ['e2e-gs-7', 3, '2026-10-17', '16:00', 'north'],
  ['e2e-gs-8', 3, '2026-10-17', '16:00', 'south'],
];
const TEAM_NAMES: Record<string, string[]> = {
  'U10 Boys': ['Lions', 'Wolves', 'Comets', 'Bulls'],
  'U12 Girls': ['Hawks', 'Owls'],
};
const teamId = (name: string) => name.toLowerCase();
const gameOf = (home: string, away: string) => {
  const found = GAMES.find((g) => g.home === home && g.away === away);
  if (!found) throw new Error(`no seeded game ${home} vs ${away}`);
  return found;
};
const laWall = (utcHhmm: string) =>
  `${String(Number(utcHhmm.slice(0, 2)) - 7).padStart(2, '0')}:${utcHhmm.slice(3, 5)}`;
const hourAfter = (hhmm: string) => `${String(Number(hhmm.slice(0, 2)) + 1).padStart(2, '0')}:00`;

Given('a club with a saved game schedule in two divisions', async ({ page }) => {
  await waitForMockClient(page);
  const slots = SLOTS.map(([id, week, date, start, field]) => ({
    id,
    organization_id: CLUB.orgId,
    field_id: `e2e-${field}`,
    week_index: week,
    start: `${date}T${start}:00Z`,
    end: `${date}T${hourAfter(start)}:00Z`,
    // The wall reading the database holds beside the instants (`slot_date` is NOT NULL there), in Los Angeles (UTC-7
    // in October): `ensure_game_slot` finds a slot by these, so adding a game at a new time matches them (PR 8).
    slot_date: date,
    start_time: `${laWall(start)}:00`,
    end_time: `${laWall(hourAfter(start))}:00`,
    capacity: 1,
  }));
  const games = GAMES.map((g) => {
    const slot = slots.find((s) => s.id === g.slot)!;
    return {
      id: g.id,
      run_id: CLUB.runId,
      organization_id: CLUB.orgId,
      division: g.division,
      week_index: g.week,
      slot_id: g.slot,
      game_slot_id: g.slot,
      field_id: slot.field_id,
      start: slot.start,
      end: slot.end,
      home_team_id: teamId(g.home),
      away_team_id: teamId(g.away),
      assignment_source: 'auto',
      published: false,
    };
  });
  const teamsByDivision = Object.fromEntries(
    Object.entries(TEAM_NAMES).map(([division, names]) => [
      division,
      names.map((name) => ({
        id: teamId(name),
        name,
        division_id: division,
        coachId: `coach-${teamId(name)}`,
        headCoach: `Coach ${name}`,
      })),
    ])
  );
  await page.evaluate(
    ({ club, adminId, slots, games, teamsByDivision }) => {
      const db = window.__MOCK_DB__ as Record<string, Array<Record<string, unknown>> | undefined>;
      if (!db) throw new Error('mock store not initialised');
      const without = (
        rows: Array<Record<string, unknown>> | undefined,
        key: string,
        value: string
      ) => (rows ?? []).filter((row) => row[key] !== value);
      const organization = { id: club.orgId, name: 'Published FC', is_onboarded: true };
      db.organizations = [...without(db.organizations, 'id', club.orgId), organization];
      db.organization_members = [
        ...without(db.organization_members, 'organization_id', club.orgId),
        {
          organization_id: club.orgId,
          profile_id: adminId,
          role: 'admin',
          organizations: organization,
        },
      ];
      db.season_settings = [
        ...without(db.season_settings, 'id', club.seasonId),
        {
          id: club.seasonId,
          organization_id: club.orgId,
          name: 'Fall 2026',
          status: 'active',
          timezone: 'America/Los_Angeles',
          season_start: '2026-09-01',
          season_end: '2026-12-31',
          created_at: new Date().toISOString(),
        },
      ];
      // The history names the person who did it.
      db.profiles = [
        ...without(db.profiles, 'id', adminId),
        { id: adminId, full_name: 'E2E Admin' },
      ];
      db.locations = [
        ...without(db.locations, 'organization_id', club.orgId),
        { id: 'e2e-loc-north', organization_id: club.orgId, name: 'North Park' },
        { id: 'e2e-loc-south', organization_id: club.orgId, name: 'South Park' },
      ];
      db.fields = [
        ...without(db.fields, 'organization_id', club.orgId),
        {
          id: 'e2e-north',
          name: 'North Field',
          location_id: 'e2e-loc-north',
          organization_id: club.orgId,
          active: true,
        },
        {
          id: 'e2e-south',
          name: 'South Field',
          location_id: 'e2e-loc-south',
          organization_id: club.orgId,
          active: true,
        },
      ];
      db.game_slots = [...without(db.game_slots, 'organization_id', club.orgId), ...slots];
      const now = new Date(Date.now() + 60_000).toISOString();
      db.scheduler_runs = [
        ...without(db.scheduler_runs, 'organization_id', club.orgId),
        {
          id: 'e2e-team-run',
          organization_id: club.orgId,
          season_settings_id: club.seasonId,
          run_type: 'team',
          status: 'completed',
          created_at: now,
          completed_at: now,
          results: { teamsByDivision, rosterBalanceByDivision: {}, coachCoverageByDivision: {} },
        },
        {
          id: club.runId,
          organization_id: club.orgId,
          season_settings_id: club.seasonId,
          run_type: 'game',
          status: 'completed',
          created_at: now,
          completed_at: now,
          results: { summary: { scheduledRate: 1.0, unscheduledMatchups: 0 }, warnings: [] },
        },
      ];
      db.game_assignments = [
        ...without(db.game_assignments, 'organization_id', club.orgId),
        ...games,
      ];
      db.audit_log = without(db.audit_log, 'organization_id', club.orgId);
      window.__saveMockDB__(db);
      localStorage.setItem('squadlogic_active_org', club.orgId);
      localStorage.setItem('squadlogic-current-season-id', club.seasonId);
    },
    { club: CLUB, adminId: ADMIN_ID, slots, games, teamsByDivision }
  );
});

// ---- the page --------------------------------------------------------------------------------------------------

const summaryLine = (page: Page) => page.getByTestId('published-summary');
const listRow = (page: Page, home: string, away: string) =>
  page
    .getByTestId('game-schedule-list')
    .locator('tbody tr')
    .filter({ hasText: `${home} vs ${away}` });
const cardOf = (page: Page, home: string, away: string) =>
  page.getByTestId(`game-card-${gameOf(home, away).id}`);

/** The Game Scheduling page with its saved games read: the list shows a row for each. */
async function openGamesPage(page: Page) {
  if (!page.url().endsWith('/schedule/game')) await page.goto('/schedule/game');
  await expect(summaryLine(page)).toHaveText(/of 5 saved games Published/, { timeout: 20_000 });
  await expect(page.getByTestId('game-schedule-list').locator('tbody tr')).toHaveCount(5, {
    timeout: 20_000,
  });
}

/** Wait until the controls are back on: the saved schedule has been read again after a change. */
async function settled(page: Page) {
  await expect(page.getByTestId('published-reason')).toHaveCount(0, { timeout: 20_000 });
}

async function publishDivision(page: Page, division: string) {
  await openGamesPage(page);
  await page.getByLabel('Which games', { exact: true }).selectOption('division');
  await page.getByLabel('Division', { exact: true }).selectOption(division);
  await page.getByRole('button', { name: /^Publish \d+ games?$/ }).click();
  await expect(page.getByTestId('published-bar-notice')).toContainText(/^Published \d+ games?\./, {
    timeout: 20_000,
  });
  await settled(page);
}

async function allowChanges(page: Page, home: string, away: string, reason: string, note: string) {
  await openGamesPage(page);
  await settled(page);
  await page.getByRole('button', { name: `Allow changes: ${home} versus ${away}` }).click();
  const dialog = page.getByRole('dialog', { name: 'Allow changes to Published games' });
  await expect(dialog).toBeVisible();
  // Confirm waits for a reason and the tick, and says why.
  const confirm = dialog.getByRole('button', { name: 'Confirm and allow changes' });
  await expect(confirm).toBeDisabled();
  await expect(dialog.getByTestId('allow-changes-why')).toHaveText('Choose a reason.');
  await dialog.getByLabel('Reason for allowing changes').selectOption({ label: reason });
  await expect(confirm).toBeDisabled();
  await expect(dialog.getByTestId('allow-changes-why')).toHaveText('Tick the box to confirm.');
  if (note) await dialog.getByLabel('Note (optional)').fill(note);
  await dialog.getByRole('checkbox').check();
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(dialog).toBeHidden({ timeout: 20_000 });
  await settled(page);
}

When('I open the Game Scheduling page and wait for its saved games', async ({ page }) => {
  await page.goto('/schedule/game');
  await openGamesPage(page);
});

When('I publish the {string} division from the bulk bar', async ({ page }, division: string) => {
  await publishDivision(page, division);
});

Given('the {string} division is Published', async ({ page }, division: string) => {
  await publishDivision(page, division);
});

When(
  'I allow changes to the game {string} vs {string} for {string} with the note {string}',
  async ({ page }, home: string, away: string, reason: string, note: string) => {
    await allowChanges(page, home, away, reason, note);
  }
);

Given(
  'changes are allowed to the game {string} vs {string}',
  async ({ page }, home: string, away: string) => {
    await allowChanges(page, home, away, 'Other', '');
  }
);

When(
  'I open the history of the game {string} vs {string}',
  async ({ page }, home: string, away: string) => {
    await page.getByRole('button', { name: `History: ${home} versus ${away}` }).click();
    await expect(
      page.getByRole('dialog', { name: `History: ${home} versus ${away}` })
    ).toBeVisible();
  }
);

When(
  'I turn on the Published switch of the game {string} vs {string} in the list',
  async ({ page }, home: string, away: string) => {
    await listRow(page, home, away)
      .getByRole('switch', { name: `Published: ${home} versus ${away}` })
      .click();
    await expect(page.getByTestId('published-bar-notice')).toContainText(
      /^Published \d+ games?\./,
      { timeout: 20_000 }
    );
    await settled(page);
  }
);

When('I enter manual override on the Game Scheduling page', async ({ page }) => {
  await page.getByRole('button', { name: 'Enter Manual Override' }).click();
  await expect(page.getByTestId('game-schedule-grid')).toBeVisible({ timeout: 20_000 });
});

When(
  'I try to drag the card of {string} vs {string} onto an empty slot',
  async ({ page }, home: string, away: string) => {
    const card = cardOf(page, home, away);
    const target = page.getByTestId('drop-zone-e2e-north:e2e-gs-7');
    await expect(target).toBeVisible();
    // dnd-kit's pointer sensor starts after 5px: the same raw mouse events the other drag scenarios use.
    await card.hover();
    await page.mouse.down();
    await page.mouse.move(10, 10);
    await target.hover();
    await page.mouse.up();
  }
);

When(
  'I move the game {string} vs {string} to the empty slot on {string} with its Move to list',
  async ({ page }, home: string, away: string, field: string) => {
    const card = cardOf(page, home, away);
    const select = card.getByRole('combobox');
    // The options are offered once the list is reached.
    await select.focus();
    // The option's label is "<field>, <the slot's time>": the empty slot on that field is the only one that starts so.
    const option = select.locator('option', { hasText: new RegExp(`^${field},`) });
    await expect(option).toHaveCount(1);
    await select.selectOption((await option.getAttribute('value')) ?? '');
    await card.getByRole('button', { name: 'Move', exact: true }).click();
  }
);

type SaveOutcome = { runId: string } | { refused: string[] };

/**
 * The stand-in for `persist_game_schedule` (the mock client has no arm for the save over the Edge function, which is
 * SQL): it answers the way the database does, so the page's refresh after Apply reads a REAL result and the scenarios
 * assert what is rendered, never what was sent.
 *
 * What the database does (20261120010000), and this does: the save makes a NEW completed run. A game the save names by
 * its `id` is UPDATED IN PLACE: it keeps its id, its Published flag and its history, takes the place the save gives it,
 * and joins the new run. A game sent without an id is upserted on its matchup tuple (home, away, slot, week): the saved
 * row at that tuple is kept, otherwise it is a NEW row that starts not Published, with no history. A row the save does
 * not name stays behind in its older run, where the page no longer shows it. A save that leaves out a Published game
 * (neither its id nor its tuple is in it) is refused whole (`game_published_omitted`, 409 `GAME_PUBLISHED`).
 * What it does not do: the guard trigger on a moved Published row (the page does not offer one), the audit rows, the
 * TIME TBD sync. Those are held by supabase/tests/game_published.sql and game_identity.sql.
 */
async function persistLikeTheDatabase(
  page: Page,
  body: {
    snapshot?: { payload?: { assignmentRows?: Array<Record<string, unknown>> } };
    runMetadata?: { organizationId?: string; seasonSettingsId?: string };
  }
): Promise<SaveOutcome> {
  const rows = body.snapshot?.payload?.assignmentRows ?? [];
  const org = body.runMetadata?.organizationId ?? CLUB.orgId;
  const season = body.runMetadata?.seasonSettingsId ?? CLUB.seasonId;
  return page.evaluate(
    ({ rows, org, season }) => {
      type Row = Record<string, unknown>;
      const db = window.__MOCK_DB__ as Record<string, Row[] | undefined>;
      const tuple = (row: Row) =>
        [row.home_team_id, row.away_team_id, row.game_slot_id ?? row.slot_id, row.week_index]
          .map(String)
          .join('|');
      const saved = (db.game_assignments ?? []).filter((game) => game.organization_id === org);
      const named = new Set(rows.map(tuple));
      const namedIds = new Set(rows.filter((row) => row.id).map((row) => String(row.id)));
      const omitted = saved
        .filter(
          (game) =>
            game.published === true && !named.has(tuple(game)) && !namedIds.has(String(game.id))
        )
        .map((game) => String(game.id))
        .sort();
      if (omitted.length > 0) return { refused: omitted };

      const gameRuns = (db.scheduler_runs ?? []).filter(
        (run) => run.organization_id === org && run.run_type === 'game'
      );
      const latest = Math.max(
        Date.now(),
        ...gameRuns.map((run) => Date.parse(String(run.completed_at))).filter(Number.isFinite)
      );
      const runId = `e2e-saved-run-${gameRuns.length + 1}`;
      const completedAt = new Date(latest + 60_000).toISOString();

      const taken = new Set<string>();
      const written = rows.map((row, index): Row => {
        const byId = row.id ? saved.find((game) => String(game.id) === String(row.id)) : undefined;
        const match =
          byId ?? saved.find((game) => !taken.has(String(game.id)) && tuple(game) === tuple(row));
        if (match) {
          taken.add(String(match.id));
          // The same row: its id, its Published flag and its history stay; it takes the place it is sent at and joins
          // the new run.
          return {
            ...match,
            home_team_id: row.home_team_id,
            away_team_id: row.away_team_id,
            game_slot_id: row.game_slot_id,
            slot_id: row.slot_id ?? row.game_slot_id,
            week_index: row.week_index,
            division: row.division,
            field_id: row.field_id,
            start: row.start,
            end: row.end,
            assignment_source: row.assignment_source,
            season_settings_id: season,
            run_id: runId,
          };
        }
        return {
          ...row,
          id: `e2e-new-game-${runId}-${index}`,
          organization_id: org,
          run_id: runId,
          published: false,
          published_at: null,
          published_by: null,
          season_settings_id: season,
        };
      });
      db.scheduler_runs = [
        ...(db.scheduler_runs ?? []),
        {
          id: runId,
          organization_id: org,
          season_settings_id: season,
          run_type: 'game',
          status: 'completed',
          created_at: completedAt,
          completed_at: completedAt,
          results: { summary: { scheduledRate: 1.0, unscheduledMatchups: 0 }, warnings: [] },
        },
      ];
      // The rows the save names are rewritten; the rest of the saved games stay as they are, in their older runs.
      const rewritten = new Set(written.map((row) => String(row.id)));
      db.game_assignments = [
        ...(db.game_assignments ?? []).filter((game) => !rewritten.has(String(game.id))),
        ...written,
      ];
      window.__saveMockDB__(db);
      return { runId };
    },
    { rows, org, season }
  );
}

When('I apply the staged game schedule', async ({ page }) => {
  await page.route('**/functions/v1/game-persistence', async (route) => {
    const outcome = await persistLikeTheDatabase(
      page,
      JSON.parse(route.request().postData() || '{}')
    );
    if ('refused' in outcome) {
      await route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'error',
          code: 'GAME_PUBLISHED',
          reason: 'game_published_omitted',
          message: `this save leaves out ${outcome.refused.length} Published game(s): a save carries every Published game of its season, unchanged`,
          ids: outcome.refused,
          count: outcome.refused.length,
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'success',
        runId: outcome.runId,
        message: 'Persistence successful.',
      }),
    });
  });
  const apply = page.getByRole('button', { name: /^Apply Schedule$/ });
  await expect(apply).toBeEnabled({ timeout: 15_000 });
  await apply.click();
  await expect(page.getByText(/Game schedule applied/).first()).toBeVisible({ timeout: 15_000 });
});

const placed = new WeakMap<Page, Map<string, { field: string; kickoff: string }>>();
const PUBLISHED_MATCHUPS: Array<[string, string]> = [
  ['Lions', 'Wolves'],
  ['Comets', 'Bulls'],
  ['Lions', 'Comets'],
  ['Wolves', 'Bulls'],
];

When('I note where the Published games are in the list', async ({ page }) => {
  await openGamesPage(page);
  const where = new Map<string, { field: string; kickoff: string }>();
  for (const [home, away] of PUBLISHED_MATCHUPS) {
    const cells = listRow(page, home, away).getByRole('cell');
    where.set(`${home} vs ${away}`, {
      field: ((await cells.nth(1).textContent()) ?? '').trim(),
      kickoff: ((await cells.nth(2).textContent()) ?? '').trim(),
    });
  }
  // A control that read nothing is no control: every Published game has a field and a kickoff to compare.
  for (const [matchup, spot] of where) {
    expect(spot.field, `${matchup} has a field`).not.toBe('');
    expect(spot.kickoff, `${matchup} has a kickoff`).not.toBe('');
  }
  placed.set(page, where);
});

When('I generate a new game schedule', async ({ page }) => {
  const run = page.getByRole('button', { name: 'Auto-Generate: run auto-scheduler optimization' });
  await expect(run).toBeEnabled({ timeout: 20_000 });
  await run.click();
  await expect(page.getByRole('button', { name: /^Apply Schedule$/ })).toBeVisible({
    timeout: 20_000,
  });
});

// ---- Then ------------------------------------------------------------------------------------------------------

Then('the Published line reads {string}', async ({ page }, text: string) => {
  await expect(summaryLine(page)).toContainText(text, { timeout: 20_000 });
});

Then('the notice says {string}', async ({ page }, text: string) => {
  await expect(page.getByTestId('published-bar-notice')).toContainText(text);
});

Then(
  'the game {string} vs {string} is shown as {string} in the list',
  async ({ page }, home: string, away: string, state: string) => {
    await expect(listRow(page, home, away).getByTestId('published-state')).toHaveText(state, {
      timeout: 20_000,
    });
  }
);

Then(
  'the card of {string} vs {string} is Published and cannot be dragged or moved',
  async ({ page }, home: string, away: string) => {
    const card = cardOf(page, home, away);
    await expect(card).toBeVisible();
    await expect(
      card.getByRole('switch', { name: `Published: ${home} versus ${away}` })
    ).toHaveAttribute('aria-checked', 'true');
    await expect(card.getByTestId('published-state')).toHaveText('Published');
    await expect(card.getByTestId('published-hold-note')).toHaveText(
      'Published: allow changes to move it.'
    );
    // No grip and no "Move to": the two ways to move a game.
    await expect(card.getByRole('button', { name: /^Drag / })).toHaveCount(0);
    await expect(card.getByRole('combobox')).toHaveCount(0);
    await expect(
      card.getByRole('button', { name: `Allow changes: ${home} versus ${away}` })
    ).toBeVisible();
  }
);

Then(
  'the card of {string} vs {string} can still be moved',
  async ({ page }, home: string, away: string) => {
    const card = cardOf(page, home, away);
    await expect(card).toBeVisible();
    await expect(card.getByRole('button', { name: /^Drag / })).toHaveCount(1);
    await expect(card.getByRole('combobox')).toHaveCount(1);
    await expect(card.getByTestId('published-hold-note')).toHaveCount(0);
  }
);

Then(
  'the card of {string} vs {string} is still in its cell and nothing is staged',
  async ({ page }, home: string, away: string) => {
    const game = gameOf(home, away);
    const cell = page.getByTestId(`drop-zone-e2e-${game.field}:${game.slot}`);
    await expect(cell.getByTestId(`game-card-${game.id}`)).toBeVisible();
    // A staged move would show the review and its Apply button.
    await expect(page.getByRole('button', { name: /^Apply Schedule$/ })).toHaveCount(0);
    await expect(page.getByText(/staged for review/)).toHaveCount(0);
  }
);

Then(
  'the history shows {string} with the reason {string} and the note {string}',
  async ({ page }, title: string, reason: string, note: string) => {
    const dialog = page.getByRole('dialog', { name: /^History:/ });
    const entry = dialog.getByTestId('game-history-entry').filter({ hasText: title });
    await expect(entry).toHaveCount(1, { timeout: 15_000 });
    await expect(entry).toContainText('E2E Admin');
    await expect(entry).toContainText(`Reason: ${reason}`);
    await expect(entry).toContainText(`Note: ${note}`);
    // The act before it is there too: the division was Published first.
    await expect(
      dialog.getByTestId('game-history-entry').filter({ hasText: /^Published/ })
    ).toHaveCount(1);
  }
);

Then('the history says a moved game keeps its history', async ({ page }) => {
  await expect(page.getByRole('dialog', { name: /^History:/ })).toContainText(
    'A game keeps its history when it is moved to another time slot or week. A new game, one that continues no saved game, starts with none.'
  );
});

Then('the Games page says {string}', async ({ page }, text: string) => {
  await expect(page.getByText(text).first()).toBeVisible({ timeout: 20_000 });
});

// The empty slots of week 3 (see the table at the top): where the move goes.
const EMPTY_SLOT: Record<string, string> = { north: 'e2e-gs-7', south: 'e2e-gs-8' };
const cellOf = (page: Page, field: string, slot: string) =>
  page.getByTestId(`drop-zone-e2e-${field}:${slot}`);

Then(
  'the game {string} vs {string} is now in the empty slot on {string} as the same game that is {string}',
  async ({ page }, home: string, away: string, fieldName: string, state: string) => {
    const field = fieldName.split(' ')[0].toLowerCase();
    const seeded = gameOf(home, away);
    // The grid shows what the page read back from the database after the save: the saved schedule, not the staged one.
    const card = cellOf(page, field, EMPTY_SLOT[field]).getByTestId(/^game-card-/);
    await expect(card).toHaveCount(1, { timeout: 20_000 });
    // The save updated the game in place, so the card is the one the game had before the move: the same id.
    await expect(card).toHaveAttribute('data-testid', `game-card-${seeded.id}`);
    await expect(card.getByTestId('published-state')).toHaveText(state);
    await expect(
      card.getByRole('switch', { name: `Published: ${home} versus ${away}` })
    ).toHaveAttribute('aria-checked', 'false');
    // It keeps its history (the History button is there) and nothing holds it: no hold note, no Allow changes.
    await expect(card.getByRole('button', { name: /^History:/ })).toHaveCount(1);
    await expect(card.getByRole('button', { name: /^Allow changes:/ })).toHaveCount(0);
    await expect(card.getByTestId('published-hold-note')).toHaveCount(0);
  }
);

Then(
  'the place where {string} vs {string} was saved is empty',
  async ({ page }, home: string, away: string) => {
    const seeded = gameOf(home, away);
    const cell = cellOf(page, seeded.field, seeded.slot);
    await expect(cell.getByTestId(`empty-slot-e2e-${seeded.field}:${seeded.slot}`)).toBeVisible({
      timeout: 20_000,
    });
    await expect(cell.getByTestId(/^game-card-/)).toHaveCount(0);
  }
);

Then('the other Published games are still Published in their own places', async ({ page }) => {
  for (const [home, away] of PUBLISHED_MATCHUPS.slice(1)) {
    const seeded = gameOf(home, away);
    // The same card (the same row: id and flag kept), in the same cell, still Published and still held.
    const card = cellOf(page, seeded.field, seeded.slot).getByTestId(`game-card-${seeded.id}`);
    await expect(card, `${home} vs ${away} is where it was`).toBeVisible({ timeout: 20_000 });
    await expect(card.getByTestId('published-state')).toHaveText('Published');
    await expect(
      card.getByRole('switch', { name: `Published: ${home} versus ${away}` })
    ).toHaveAttribute('aria-checked', 'true');
    await expect(card.getByTestId('published-hold-note')).toBeVisible();
  }
});

Then('the Published games are where they were', async ({ page }) => {
  const before = placed.get(page);
  expect(before?.size, 'the places were noted').toBe(PUBLISHED_MATCHUPS.length);
  for (const [home, away] of PUBLISHED_MATCHUPS) {
    const row = listRow(page, home, away);
    await expect(row).toHaveCount(1);
    const cells = row.getByRole('cell');
    const spot = before!.get(`${home} vs ${away}`)!;
    await expect(cells.nth(1)).toHaveText(spot.field);
    await expect(cells.nth(2)).toHaveText(spot.kickoff);
    await expect(row.getByTestId('published-state')).toHaveText('Published');
  }
});

// ---- PR 8: add one game by hand --------------------------------------------------------------------------------

const addDialog = (page: Page) => page.getByRole('dialog', { name: 'Add a game' });

async function openAddGame(page: Page, division: string, home: string, away: string) {
  const open = page.getByRole('button', { name: 'Add a game' });
  await expect(open).toBeEnabled({ timeout: 20_000 });
  await open.click();
  const dialog = addDialog(page);
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Division', { exact: true }).selectOption(division);
  await dialog.getByLabel('Home team', { exact: true }).selectOption({ label: home });
  await dialog.getByLabel('Away team', { exact: true }).selectOption({ label: away });
  return dialog;
}

When(
  'I add the game {string} vs {string} in {string} in the open slot on {string}',
  async ({ page }, home: string, away: string, division: string, field: string) => {
    const dialog = await openAddGame(page, division, home, away);
    await dialog.getByLabel('An open slot').check();
    const select = dialog.getByLabel('Open slot', { exact: true });
    // The option's label is "<field>, <the slot's time>": the one empty slot on that field.
    const option = select.locator('option', { hasText: new RegExp(`^${field},`) });
    await expect(option).toHaveCount(1);
    await select.selectOption((await option.getAttribute('value')) ?? '');
    await dialog.getByRole('button', { name: 'Add to the review' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText(/staged for review/)).toBeVisible();
  }
);

When(
  'I fill in the game {string} vs {string} in {string} at {string} on {string} from {string} to {string}',
  async (
    { page },
    home: string,
    away: string,
    division: string,
    field: string,
    date: string,
    start: string,
    end: string
  ) => {
    if (!page.url().endsWith('/schedule/game')) await openGamesPage(page);
    const dialog = await openAddGame(page, division, home, away);
    await dialog.getByLabel('A new time').check();
    await dialog.getByLabel('Field', { exact: true }).selectOption({ label: field });
    await dialog.getByLabel('Date', { exact: true }).fill(date);
    await dialog.getByLabel('Starts', { exact: true }).fill(start);
    await dialog.getByLabel('Ends', { exact: true }).fill(end);
  }
);

Then('the Add a game dialog flags {string}', async ({ page }, text: string) => {
  await expect(addDialog(page).getByTestId('add-game-warnings')).toContainText(text);
  // Flagged, not blocked.
  await expect(addDialog(page).getByRole('button', { name: 'Add to the review' })).toBeEnabled();
});

When('I add the game to the review', async ({ page }) => {
  await addDialog(page).getByRole('button', { name: 'Add to the review' }).click();
  await expect(addDialog(page)).toBeHidden();
  await expect(page.getByText(/staged for review/)).toBeVisible();
});

Then('the conflict banner lists a double booking', async ({ page }) => {
  const banner = page.getByTestId('game-conflict-banner');
  await expect(banner.getByTestId('conflict-item-team-double-booked').first()).toBeVisible();
  await expect(banner.getByTestId('conflict-item-field-overlap')).toBeVisible();
});

Then('the Add a game dialog refuses with {string}', async ({ page }, text: string) => {
  await expect(addDialog(page).getByRole('alert')).toContainText(text);
});

Then('the game cannot be added to the review', async ({ page }) => {
  await expect(addDialog(page).getByRole('button', { name: 'Add to the review' })).toBeDisabled();
  await expect(page.getByText(/staged for review/)).toHaveCount(0);
});

Then(
  'the added game has a card on the grid in its new time on {string}',
  async ({ page }, fieldName: string) => {
    const field = fieldName.split(' ')[0].toLowerCase();
    // The first dialog of the page names its game `added-1` and its pending time `new-slot-1`.
    const cell = page.getByTestId(`drop-zone-e2e-${field}:new-slot-1`);
    await expect(cell).toBeVisible();
    const card = cell.getByTestId('game-card-added-1');
    await expect(card).toBeVisible();
    // Keyboard-reachable: its "Move to" list takes focus.
    const select = card.getByRole('combobox');
    await select.focus();
    await expect(select).toBeFocused();
  }
);
