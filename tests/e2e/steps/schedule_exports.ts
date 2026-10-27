import fs from 'node:fs';
import { createBdd } from 'playwright-bdd';
import { expect, type Locator, type Page } from '@playwright/test';
import { readXlsx } from '../../helpers/readXlsx.js';
import { parseIcs } from '../../helpers/parseIcs.js';
import {
  TEAM_SCHEDULE_COLUMNS,
  TEAM_SCHEDULE_HEADERS as H,
} from '../../../packages/core/src/teamScheduleExport.js';
import { SCHEDULE_EXPORT_COLUMNS } from '../../../packages/core/src/outputGeneration.js';

/**
 * The schedule downloads (plan docs/changes/2026-10-22-admin-focus.md, R7).
 * Each download is caught with Playwright's `download` event and read from
 * disk: the files are checked, not the page. Seeding is `admin_navigation.ts`'s
 * "Team A has an upcoming game and a weekly practice" (a game at home to
 * Team B at 10:00, four Thursday practices at 17:30), plus the base seed's
 * two Team A games with no slot.
 */

const { When, Then } = createBdd();

/** The last file of each kind, by suggested name. CI runs one worker. */
const files = new Map<string, Buffer>();
let lastCsvRows: string[][] = [];

async function download(page: Page, scope: Locator, button: string) {
  const control = scope.getByRole('button', { name: button, exact: true });
  await expect(control).toBeVisible({ timeout: 20_000 });
  const [file] = await Promise.all([page.waitForEvent('download'), control.click()]);
  const path = await file.path();
  files.set(file.suggestedFilename(), fs.readFileSync(path));
}

const fileNamed = (name: string) => {
  const bytes = files.get(name);
  if (!bytes) throw new Error(`no download named ${name}; got ${[...files.keys()].join(', ')}`);
  return bytes;
};

/** RFC 4180, enough for the export: quoted cells, doubled quotes, commas inside. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  row.push(cell);
  rows.push(row);
  return rows;
}

When('I download {string} from the team page', async ({ page }, button: string) => {
  await download(page, page.getByRole('group', { name: "Download this team's schedule" }), button);
});

When('I download {string} from the generated files', async ({ page }, button: string) => {
  await download(page, page.locator('body'), button);
});

Then(
  'the CSV {string} lists the game against {string}, {int} practices and the games with no slot',
  async ({ page: _page }, name: string, opponent: string, practices: number) => {
    const rows = parseCsv(fileNamed(name).toString('utf8'));
    expect(rows[0]).toEqual([...TEAM_SCHEDULE_COLUMNS]);
    const body = rows
      .slice(1)
      .map((cells) =>
        Object.fromEntries(TEAM_SCHEDULE_COLUMNS.map((column, i) => [column, cells[i]]))
      );
    const timedGame = body.filter(
      (r) =>
        r[H.EVENT_TYPE] === 'Game' &&
        r[H.OPPONENT] === opponent &&
        r[H.START] === '10:00' &&
        r[H.STATUS] === 'Scheduled'
    );
    expect(timedGame).toHaveLength(1);
    expect(
      body.filter(
        (r) => r[H.EVENT_TYPE] === 'Practice' && r[H.START] === '17:30' && r[H.END] === '18:30'
      )
    ).toHaveLength(practices);
    // The base seed's two Team A games with no slot: in the file, with the reason.
    const slotless = body.filter((r) => r[H.REASON_CODE] === 'GAME_SLOT_MISSING');
    expect(slotless).toHaveLength(2);
    for (const r of slotless) {
      expect(r[H.STATUS]).toBe('Date and time TBD');
      expect(r[H.REASON]).toBe('the game has no scheduled slot yet');
    }
    lastCsvRows = rows;
  }
);

Then('the CSV has no contact column', async () => {
  for (const column of lastCsvRows[0]) expect(column).not.toMatch(/mail|phone|contact|guardian/i);
  expect(lastCsvRows.flat().join('\n')).not.toMatch(/@[a-z0-9-]+\.[a-z]/i);
});

Then("the workbook {string} holds the CSV's rows", async ({ page: _page }, name: string) => {
  const sheet = readXlsx(new Uint8Array(fileNamed(name)));
  expect(sheet.rows).toEqual(lastCsvRows);
});

Then(
  'the calendar {string} holds the game and {int} practices of {string}',
  async ({ page: _page }, name: string, practices: number, team: string) => {
    const { calendar, events } = parseIcs(fileNamed(name).toString('utf8'));
    expect(calendar['X-WR-CALNAME']).toBe(`${team} Schedule`);
    expect(calendar['X-WR-TIMEZONE']).toBe('America/Los_Angeles');
    const summaries = events.map((e) => e.SUMMARY.value);
    expect(summaries.filter((s) => s === `Game: ${team}`)).toHaveLength(1);
    expect(summaries.filter((s) => s === `Practice - ${team}`)).toHaveLength(practices);
    // The two games with no slot have no day: no entry, and counted in the description.
    expect(calendar['X-WR-CALDESC']).toMatch(/^2 of \d+ events have no confirmed time/);
    expect(calendar['X-WR-CALDESC']).toContain('None has a known day');
  }
);

Then(
  "the workbook {string} has the master schedule's columns",
  async ({ page: _page }, name: string) => {
    const sheet = readXlsx(new Uint8Array(fileNamed(name)));
    expect(sheet.rows[0]).toEqual([...SCHEDULE_EXPORT_COLUMNS]);
  }
);
