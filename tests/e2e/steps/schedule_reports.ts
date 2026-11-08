import fs from 'node:fs';
import { createBdd } from 'playwright-bdd';
import { expect, type Page } from '@playwright/test';
import { waitForMockClient } from './mockReady.js';
import { generateScheduleExports } from '../../../packages/core/src/outputGeneration.js';
import {
  makePublicationSnapshot,
  serialisePublicationSnapshot,
} from '../../../packages/core/src/publication/index.js';

const { Given, When, Then } = createBdd();

/**
 * The league of `schedule_reports.feature` (schedule expansion, PR 7), seeded into the mock database as inputs: a club
 * of its own, two venues and fields, six game slots, two divisions and six teams, two coaches (with an email and a
 * phone each, which no report may read), the SAVED games of one completed run, a TIME TBD game, practices, one published
 * baseline made by the real master export, and the audit row a "Coach request" leaves. Nothing here writes a result of
 * a report: the page reads it.
 *
 * 16:00Z is 09:00 in Los Angeles in October.
 *
 * | game      | division  | home v away     | week | slot | field | then (baseline) | now (saved)       |
 * | ga-1      | U10 Boys  | Lions v Wolves  | 1    | s-1  | North | yes             | unchanged         |
 * | ga-2      | U12 Girls | Hawks v Owls    | 1    | s-2  | South | yes             | unchanged         |
 * | ga-3      | U10 Boys  | Comets v Bulls  | 2    | s-3  | North | yes             | cancelled         |
 * | ga-4      | U10 Boys  | Lions v Comets  | 2    | s-4  | South | yes             | moved to s-5 |
 * | ga-5      | U10 Boys  | Wolves v Bulls  | 3    | s-6  | South | no              | new               |
 * TIME TBD: Wolves v Bulls, week 2 (then and now).
 */
const CLUB = {
  orgId: '00000000-0000-4000-8000-0000000000ea',
  seasonId: 'e2e-reports-season',
  runId: '00000000-0000-4000-8000-0000000000ca',
};
const ADMIN_ID = 'mock-admin-id';
const TZ = 'America/Los_Angeles';
const teamId = (name: string) => `e2e-${name.toLowerCase()}`;
const TEAMS = [
  ...['Lions', 'Wolves', 'Comets', 'Bulls'].map((name) => ({ name, division: 'U10 Boys' })),
  ...['Hawks', 'Owls'].map((name) => ({ name, division: 'U12 Girls' })),
];
const SLOTS: Array<[string, number, string, string, 'north' | 'south']> = [
  ['e2e-s-1', 1, '2026-10-03', '16:00', 'north'],
  ['e2e-s-2', 1, '2026-10-03', '16:30', 'south'],
  ['e2e-s-3', 2, '2026-10-10', '16:00', 'north'],
  ['e2e-s-4', 2, '2026-10-10', '16:00', 'south'],
  ['e2e-s-5', 3, '2026-10-17', '16:00', 'north'],
  ['e2e-s-6', 3, '2026-10-17', '16:00', 'south'],
];
type SeedGame = {
  id: string;
  division: string;
  home: string;
  away: string;
  week: number;
  slot: string;
};
const BASELINE_GAMES: SeedGame[] = [
  { id: 'e2e-ga-1', division: 'U10 Boys', home: 'Lions', away: 'Wolves', week: 1, slot: 'e2e-s-1' },
  { id: 'e2e-ga-2', division: 'U12 Girls', home: 'Hawks', away: 'Owls', week: 1, slot: 'e2e-s-2' },
  { id: 'e2e-ga-3', division: 'U10 Boys', home: 'Comets', away: 'Bulls', week: 2, slot: 'e2e-s-3' },
  { id: 'e2e-ga-4', division: 'U10 Boys', home: 'Lions', away: 'Comets', week: 2, slot: 'e2e-s-4' },
];
const SAVED_GAMES: SeedGame[] = [
  BASELINE_GAMES[0],
  BASELINE_GAMES[1],
  // Moved: another slot and week (under another id here; the reports compare by teams, slot and week and never read it).
  {
    id: 'e2e-ga-4-moved',
    division: 'U10 Boys',
    home: 'Lions',
    away: 'Comets',
    week: 3,
    slot: 'e2e-s-5',
  },
  { id: 'e2e-ga-5', division: 'U10 Boys', home: 'Wolves', away: 'Bulls', week: 3, slot: 'e2e-s-6' },
];
const FIELD_OF = { north: 'e2e-north', south: 'e2e-south' };
const hourAfter = (hhmm: string) =>
  `${String(Number(hhmm.slice(0, 2)) + 1).padStart(2, '0')}:${hhmm.slice(3)}`;

function slotOf(id: string) {
  const found = SLOTS.find(([slotId]) => slotId === id);
  if (!found) throw new Error(`no seeded slot ${id}`);
  const [, week, date, start, field] = found;
  return {
    week,
    fieldId: FIELD_OF[field],
    start: `${date}T${start}:00Z`,
    end: `${date}T${hourAfter(start)}:00Z`,
  };
}

const gameRow = (game: SeedGame) => {
  const slot = slotOf(game.slot);
  return {
    id: game.id,
    run_id: CLUB.runId,
    organization_id: CLUB.orgId,
    division: game.division,
    week_index: game.week,
    slot_id: game.slot,
    game_slot_id: game.slot,
    field_id: slot.fieldId,
    start: slot.start,
    end: slot.end,
    home_team_id: teamId(game.home),
    away_team_id: teamId(game.away),
    assignment_source: 'auto',
    published: false,
  };
};

/** The baseline, made by the real master export from the four games as they were published. */
function baselineDocumentRow() {
  const master = generateScheduleExports({
    teams: TEAMS.map(({ name, division }) => ({ id: teamId(name), name, division })),
    gameAssignments: BASELINE_GAMES.map((game) => {
      const slot = slotOf(game.slot);
      return {
        homeTeamId: teamId(game.home),
        awayTeamId: teamId(game.away),
        start: slot.start,
        end: slot.end,
        fieldId: slot.fieldId,
        slotId: game.slot,
        notes: '',
      };
    }),
    tbdItems: [
      {
        kind: 'game',
        homeTeamId: teamId('Wolves'),
        awayTeamId: teamId('Bulls'),
        weekIndex: 2,
        reason: 'no-slot-available',
      },
    ],
  }).master;
  const { snapshot } = makePublicationSnapshot({
    snapshotId: 'e2e-week-1',
    label: 'Week 1 files',
    channel: 'storage',
    publishedAt: '2026-10-01T08:00:00',
    publishedBy: 'e2e-actor',
    rows: master.rows,
  });
  const doc = serialisePublicationSnapshot(snapshot);
  return {
    id: 'e2e-baseline-1',
    organization_id: CLUB.orgId,
    baseline_version: 1,
    document_version: doc.version,
    snapshot_id: doc.snapshotId,
    label: doc.label,
    channel: doc.channel,
    published_at: doc.publishedAt,
    published_by: doc.publishedBy,
    notes: null,
    export_columns: doc.columns,
    export_rows: doc.rows,
    digest: doc.digest,
    row_count: doc.rows.length,
    recorded_at: '2026-10-01T15:00:00+00:00',
  };
}

Given(
  'a club with a saved game schedule, two coaches and a published baseline',
  async ({ page }) => {
    await waitForMockClient(page);
    const slots = SLOTS.map(([id, week]) => {
      const slot = slotOf(id);
      return {
        id,
        organization_id: CLUB.orgId,
        field_id: slot.fieldId,
        week_index: week,
        start: slot.start,
        end: slot.end,
        capacity: 1,
      };
    });
    const oldLions = BASELINE_GAMES[3];
    const seed = {
      club: CLUB,
      adminId: ADMIN_ID,
      tz: TZ,
      slots,
      games: SAVED_GAMES.map(gameRow),
      teams: TEAMS.map(({ name, division }) => ({
        id: teamId(name),
        organization_id: CLUB.orgId,
        name,
        division_id: division === 'U10 Boys' ? 'e2e-d10' : 'e2e-d12',
      })),
      baseline: baselineDocumentRow(),
      teamsByDivision: Object.fromEntries(
        ['U10 Boys', 'U12 Girls'].map((division) => [
          division,
          TEAMS.filter((t) => t.division === division).map(({ name }) => ({
            id: teamId(name),
            name,
            division_id: division,
          })),
        ])
      ),
      override: {
        id: 'e2e-audit-1',
        organization_id: CLUB.orgId,
        user_id: ADMIN_ID,
        created_at: '2026-10-05T12:00:00+00:00',
        action: 'game.publish_overridden',
        resource_type: 'game_assignment',
        resource_id: oldLions.id,
        metadata: {
          reason_code: 'coach-request',
          note: 'Coach asked for another day',
          scope: { kind: 'selection' },
          before: {
            game_slot_id: oldLions.slot,
            field_id: slotOf(oldLions.slot).fieldId,
            home_team_id: teamId(oldLions.home),
            away_team_id: teamId(oldLions.away),
            week_index: oldLions.week,
            start: slotOf(oldLions.slot).start,
            end: slotOf(oldLions.slot).end,
          },
        },
      },
    };
    await page.evaluate((seed) => {
      const { club, adminId } = seed;
      const db = window.__MOCK_DB__ as Record<string, Array<Record<string, unknown>> | undefined>;
      if (!db) throw new Error('mock store not initialised');
      const without = (
        rows: Array<Record<string, unknown>> | undefined,
        key: string,
        value: string
      ) => (rows ?? []).filter((row) => row[key] !== value);
      const org = { organization_id: club.orgId };
      const organization = { id: club.orgId, name: 'Reports FC', is_onboarded: true };
      db.organizations = [...without(db.organizations, 'id', club.orgId), organization];
      db.organization_members = [
        ...without(db.organization_members, 'organization_id', club.orgId),
        { ...org, profile_id: adminId, role: 'admin', organizations: organization },
      ];
      db.season_settings = [
        ...without(db.season_settings, 'id', club.seasonId),
        {
          id: club.seasonId,
          ...org,
          name: 'Fall 2026',
          status: 'active',
          timezone: seed.tz,
          season_start: '2026-09-01',
          season_end: '2026-12-31',
          created_at: new Date().toISOString(),
        },
      ];
      db.profiles = [
        ...without(db.profiles, 'id', adminId),
        { id: adminId, full_name: 'E2E Admin' },
      ];
      db.locations = [
        ...without(db.locations, 'organization_id', club.orgId),
        { id: 'e2e-loc-north', ...org, name: 'North Park' },
        { id: 'e2e-loc-south', ...org, name: 'South Park' },
      ];
      db.fields = [
        ...without(db.fields, 'organization_id', club.orgId),
        {
          id: 'e2e-north',
          name: 'North Field',
          location_id: 'e2e-loc-north',
          ...org,
          active: true,
        },
        {
          id: 'e2e-south',
          name: 'South Field',
          location_id: 'e2e-loc-south',
          ...org,
          active: true,
        },
      ];
      db.divisions = [
        ...without(db.divisions, 'organization_id', club.orgId),
        { id: 'e2e-d10', ...org, season_settings_id: club.seasonId, name: 'U10 Boys' },
        { id: 'e2e-d12', ...org, season_settings_id: club.seasonId, name: 'U12 Girls' },
      ];
      db.teams = [...without(db.teams, 'organization_id', club.orgId), ...seed.teams];
      const coachRow = (id: string, name: string, multi: boolean) => ({
        id,
        ...org,
        season_settings_id: club.seasonId,
        full_name: name,
        // Both are in the database's answer on purpose: no report may read or show them.
        email: `${id}@example.invalid`,
        phone: '555-0100',
        can_coach_multiple_teams: multi,
        status: 'active',
      });
      db.coaches = [
        ...without(db.coaches, 'organization_id', club.orgId),
        coachRow('e2e-coach-alex', 'Alex Sample', false),
        coachRow('e2e-coach-blake', 'Blake Sample', true),
      ];
      const assignment = (id: string, team: string, coach: string, role: string) => ({
        id,
        ...org,
        team_id: team,
        coach_id: coach,
        role,
        effective_from: '2026-08-01',
        effective_to: null,
      });
      db.team_coach_assignments = [
        ...without(db.team_coach_assignments, 'organization_id', club.orgId),
        assignment('e2e-ca-1', 'e2e-lions', 'e2e-coach-alex', 'lead'),
        assignment('e2e-ca-2', 'e2e-hawks', 'e2e-coach-alex', 'assistant'),
        assignment('e2e-ca-3', 'e2e-wolves', 'e2e-coach-blake', 'lead'),
      ];
      db.game_slots = [...without(db.game_slots, 'organization_id', club.orgId), ...seed.slots];
      db.practice_slots = [
        ...without(db.practice_slots, 'organization_id', club.orgId),
        {
          id: 'e2e-ps-1',
          ...org,
          field_id: 'e2e-north',
          day_of_week: 'tue',
          start_time: '17:00:00',
          end_time: '18:30:00',
          valid_from: '2026-09-01',
          valid_until: '2026-11-30',
        },
        {
          id: 'e2e-ps-2',
          ...org,
          field_id: 'e2e-south',
          day_of_week: 'tue',
          start_time: '18:00:00',
          end_time: '19:00:00',
          valid_from: '2026-09-01',
          valid_until: '2026-11-30',
        },
      ];
      db.practice_assignments = [
        ...without(db.practice_assignments, 'organization_id', club.orgId),
        ...[
          ['e2e-pa-1', 'e2e-lions', 'e2e-ps-1'],
          ['e2e-pa-2', 'e2e-hawks', 'e2e-ps-2'],
        ].map(([id, team, slot]) => ({
          id,
          ...org,
          team_id: team,
          practice_slot_id: slot,
          slot_id: slot,
          effective_date_range: '[2026-09-08,2026-11-20)',
        })),
      ];
      db.schedule_tbd = [
        ...without(db.schedule_tbd, 'organization_id', club.orgId),
        {
          id: 'e2e-tbd-1',
          ...org,
          season_settings_id: club.seasonId,
          kind: 'game',
          division_id: 'e2e-d10',
          home_team_id: 'e2e-wolves',
          away_team_id: 'e2e-bulls',
          week_index: 2,
          reason: 'no-slot-available',
        },
      ];
      db.publication_baselines = [
        ...without(db.publication_baselines, 'organization_id', club.orgId),
        seed.baseline,
      ];
      const now = new Date(Date.now() + 60_000).toISOString();
      db.scheduler_runs = [
        ...without(db.scheduler_runs, 'organization_id', club.orgId),
        {
          id: 'e2e-team-run',
          ...org,
          season_settings_id: club.seasonId,
          run_type: 'team',
          status: 'completed',
          created_at: now,
          completed_at: now,
          results: {
            teamsByDivision: seed.teamsByDivision,
            rosterBalanceByDivision: {},
            coachCoverageByDivision: {},
          },
        },
        {
          id: club.runId,
          ...org,
          season_settings_id: club.seasonId,
          run_type: 'game',
          status: 'completed',
          created_at: now,
          completed_at: now,
          results: { summary: { scheduledRate: 1.0, unscheduledMatchups: 1 }, warnings: [] },
        },
      ];
      db.game_assignments = [
        ...without(db.game_assignments, 'organization_id', club.orgId),
        ...seed.games,
      ];
      db.audit_log = [...without(db.audit_log, 'organization_id', club.orgId), seed.override];
      window.__saveMockDB__(db);
      localStorage.setItem('squadlogic_active_org', club.orgId);
      localStorage.setItem('squadlogic-current-season-id', club.seasonId);
    }, seed);
  }
);

// ---- the page --------------------------------------------------------------------------------------------------

const reports = (page: Page) => page.getByTestId('schedule-reports');

When('I open the Exports page and its {string} report', async ({ page }, report: string) => {
  await page.goto('/exports');
  const panel = reports(page);
  await expect(panel).toBeVisible({ timeout: 30_000 });
  // The tabs appear once the league's tables have been read; until then it says it has not checked.
  const tab = panel.getByRole('tab', { name: report, exact: true });
  await expect(tab).toBeVisible({ timeout: 30_000 });
  await tab.click();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
});

When('I choose the date {string} on the Day Sheet', async ({ page }, date: string) => {
  await reports(page).getByLabel('Date', { exact: true }).fill(date);
  await expect(page.getByTestId('day-sheet-summary')).toContainText(date);
});

When('I choose the venue {string} on the Day Sheet', async ({ page }, venue: string) => {
  await reports(page).getByLabel('Venue', { exact: true }).selectOption({ label: venue });
  await expect(page.getByTestId('day-sheet-summary')).toContainText(`at ${venue}`);
});

Then(
  'the Day Sheet lists {int} games, the first at {string} between {string} and {string}',
  async ({ page }, count: number, time: string, home: string, away: string) => {
    const rows = page.getByTestId('day-sheet-table').locator('tbody tr');
    await expect(rows).toHaveCount(count);
    await expect(rows.first()).toContainText(time);
    await expect(rows.first()).toContainText(home);
    await expect(rows.first()).toContainText(away);
  }
);

Then('the Day Sheet lists {int} game', async ({ page }, count: number) => {
  await expect(page.getByTestId('day-sheet-table').locator('tbody tr')).toHaveCount(count);
});

Then(
  'the TIME TBD game {string} v {string} is listed apart with its reason',
  async ({ page }, home: string, away: string) => {
    const apart = page.getByTestId('day-sheet-tbd');
    await expect(apart).toContainText(`${home} v ${away}`);
    await expect(apart).toContainText('no game slot was free for it');
    await expect(apart).toContainText('no date or venue');
  }
);

Then(
  'the Day Sheet says {int} game on this date is at another venue',
  async ({ page }, count: number) => {
    await expect(page.getByTestId('day-sheet-summary')).toContainText(
      `${count} game on this date is at another venue`
    );
  }
);

let lastDownload: { name: string; text: string } | null = null;

When('I download the Day Sheet', async ({ page }) => {
  const [file] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download Day Sheet (CSV)' }).click(),
  ]);
  lastDownload = {
    name: file.suggestedFilename(),
    text: fs.readFileSync((await file.path()) as string, 'utf8'),
  };
});

Then(
  'the downloaded file {string} has {int} game and the TIME TBD game',
  async ({ page: _page }, name: string, count: number) => {
    expect(lastDownload?.name).toBe(name);
    const lines = (lastDownload?.text ?? '').split('\n');
    expect(lines[0]).toBe('Date,Kickoff,Ends,Venue,Field,Division,Home,Away,Status');
    expect(lines).toHaveLength(1 + count + 1);
    expect(lines[1]).toContain('Lions');
    expect(lines[lines.length - 1]).toContain('TIME TBD');
    expect(lastDownload?.text).not.toMatch(/example\.invalid|555-0100/);
  }
);

When('I choose the coach {string}', async ({ page }, coach: string) => {
  await reports(page).getByLabel('Coach', { exact: true }).selectOption({ label: coach });
});

Then('the coach is marked as on more than one team', async ({ page }) => {
  await expect(page.getByTestId('coach-marker')).toContainText('On more than one team');
});

Then('the coach is not marked as on more than one team', async ({ page }) => {
  await expect(page.getByTestId('coach-schedule-table')).toBeVisible();
  await expect(page.getByTestId('coach-marker')).toHaveCount(0);
});

Then('the coach schedule shows the Lions and the Hawks, games and practices', async ({ page }) => {
  const table = page.getByTestId('coach-schedule-table');
  await expect(table).toContainText('Lions');
  await expect(table).toContainText('Hawks');
  await expect(table.locator('tbody tr').filter({ hasText: 'Practice' })).toHaveCount(2);
  await expect(table.locator('tbody tr').filter({ hasText: 'Game' })).toHaveCount(3);
});

Then(
  'the coach schedule marks the overlap of the two games on the 3rd and of the two Tuesday practices',
  async ({ page }) => {
    const table = page.getByTestId('coach-schedule-table');
    await expect(table).toContainText('Overlaps Hawks v Owls, 09:30 to 10:30');
    await expect(table).toContainText('Overlaps Lions v Wolves, 09:00 to 10:00');
    await expect(table).toContainText('Overlaps the Tuesday 18:00 to 19:00 practice of Hawks');
    await expect(page.getByTestId('coach-notes')).toContainText(
      'A practice is not compared with a game'
    );
  }
);

Then('the page shows no email address or phone number', async ({ page }) => {
  const text = await page.locator('body').innerText();
  expect(text).not.toMatch(/example\.invalid|555-0100/);
});

When('I choose the published baseline {string}', async ({ page }, version: string) => {
  const select = reports(page).getByLabel('Compare with baseline', { exact: true });
  await expect(select).toBeVisible({ timeout: 20_000 });
  // The option's label is "v<version>: <label> (<date>, <rows> rows)": the baseline is chosen by its version.
  const option = select.locator('option', { hasText: new RegExp(`^${version}:`) });
  await expect(option).toHaveCount(1);
  await select.selectOption((await option.getAttribute('value')) ?? '');
});

Then('the summary reads {string}', async ({ page }, text: string) => {
  await expect(page.getByTestId('changes-summary')).toContainText(text, { timeout: 20_000 });
});

const changeRow = (page: Page, home: string, away: string, label: string) =>
  page
    .getByTestId('changes-table')
    .locator('tbody tr')
    .filter({ hasText: `${home} v ${away}` })
    .filter({ hasText: label });

Then(
  'the changes list {string} v {string} as no longer in the saved schedule',
  async ({ page }, home: string, away: string) => {
    await expect(changeRow(page, home, away, 'No longer in the saved schedule')).toHaveCount(1);
  }
);

Then(
  'the changes list {string} v {string} as no longer in the saved schedule with the reason {string}',
  async ({ page }, home: string, away: string, reason: string) => {
    const row = changeRow(page, home, away, 'No longer in the saved schedule');
    await expect(row).toHaveCount(1);
    await expect(row).toContainText(reason);
    await expect(row).toContainText('Coach asked for another day');
  }
);

Then(
  'the changes list {string} v {string} as new',
  async ({ page }, home: string, away: string) => {
    await expect(changeRow(page, home, away, 'New since publication')).toHaveCount(1);
  }
);

Then('the changes say a moved game appears twice and is not linked', async ({ page }) => {
  const notes = page.getByTestId('changes-notes');
  await expect(notes).toContainText(
    "A baseline records each game's teams, slot and week, not which game is which, so a game moved to another time slot or week appears here twice"
  );
  await expect(notes).toContainText('does not link');
});
