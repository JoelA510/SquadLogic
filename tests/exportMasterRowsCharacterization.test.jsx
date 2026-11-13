/**
 * The Exports page's master export, characterized end to end (PR 6b of the schedule expansion, task G5a;
 * docs/changes/2026-11-03-schedule-expansion.md, section 7).
 *
 * G5a lifts the generation of the master export rows (the rows a publication baseline is recorded from) out of
 * `OutputGenerationPanel` into one shared function, so that a second caller (the import panel, task G5) makes the same
 * rows. It is a refactor: nothing the page makes may change. This test was written and committed BEFORE the lift and
 * pins the whole output of the page as it was: the status line, the master file's rows and CSV, every per-team file,
 * the TIME TBD list on the page, the games "Mark these games Published" names, the baseline the upload records, and the
 * rows the baseline comparison is handed. It must pass unchanged before and after.
 *
 * The world reaches every case the generation branches on: a game between two own teams, an own team against an outside
 * club, a TIME TBD game with a date and one without, a practice a team is short of, a game naming a team in no
 * directory (a team of the other season), a game with no time, two games in the repeated hour of the autumn clock
 * change, a cancelled game (gone from the saved schedule; and, in the second case, still on a page that was loaded
 * before it was cancelled, which the upload refuses as out of date), and two seasons (the other season's division,
 * team and TIME TBD row are in none of the files).
 *
 * Driven through the real panel and the real mock client (the directory read and the TIME TBD read), with the storage
 * upload, the baseline hook and the Published client replaced by recorders, as tests/exportsMarkPublished.test.jsx does.
 */
import React from 'react';
import { createHash } from 'node:crypto';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MOCK_ORG_ID, MOCK_SEASON_ID } from '../frontend/src/lib/mockSeedIds.js';
import { seedMockDb } from './helpers/seedMockDb.js';

const REC = vi.hoisted(() => ({
  uploads: /** @type {Array<{ path: string, file: string }>} */ ([]),
  baselines: /** @type {Array<Record<string, any>>} */ ([]),
  compared: /** @type {Array<{ id: string, rows: any[] }>} */ ([]),
  marked: /** @type {Array<Record<string, any>>} */ ([]),
  savedIds: /** @type {string[]} */ ([]),
}));

vi.mock('../frontend/src/config.js', async (importOriginal) => ({
  .../** @type {object} */ (await importOriginal()),
  IS_MOCK_MODE: false,
}));
vi.mock('../frontend/src/lib/supabaseClient.js', async () => {
  const { mockSupabase } = await import('../frontend/src/lib/mockSupabaseClient.js');
  return { supabase: mockSupabase, supabaseReady: Promise.resolve() };
});
vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: () => ({
    currentOrganization: { id: '5eed0000-0000-4000-8000-000000000001', name: 'Mock League' },
    currentSeasonSetting: { id: '5eed5ea5-0000-4000-8000-000000000001', status: 'active' },
  }),
}));
vi.mock('../frontend/src/contexts/AuthContext.jsx', () => ({
  useAuth: () => ({ user: { id: 'mock-admin-id' } }),
}));
vi.mock('../frontend/src/lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), log: vi.fn() },
}));
vi.mock('../packages/core/src/storageSupabase.js', async (importOriginal) => ({
  .../** @type {object} */ (await importOriginal()),
  uploadScheduleExport: vi.fn(async ({ path, file }) => {
    REC.uploads.push({ path, file });
    return { path };
  }),
}));
vi.mock('../frontend/src/hooks/usePublicationBaselines.js', async (importOriginal) => ({
  .../** @type {object} */ (await importOriginal()),
  usePublicationBaselines: () => ({
    baselines: [
      {
        id: 'baseline-1',
        baselineVersion: 1,
        label: 'Master schedule, earlier',
        publishedAt: '2026-10-01T09:00:00',
        rowCount: 4,
      },
    ],
    loading: false,
    error: null,
    publishBaseline: async (payload) => {
      REC.baselines.push(payload);
      return { baseline_version: 2 };
    },
    compareWithBaseline: async (id, rows) => {
      REC.compared.push({ id, rows });
      throw new Error('recorded, not compared');
    },
  }),
}));
vi.mock('../frontend/src/utils/gamePublishedClient.js', () => ({
  readCurrentSavedGameIds: async () => ({ ids: new Set(REC.savedIds) }),
  setGamesPublished: async (params) => {
    REC.marked.push(params);
    return { changed: params.ids.length, unchanged: 0 };
  },
}));

const { default: OutputGenerationPanel } =
  await import('../frontend/src/components/OutputGenerationPanel.jsx');
const { mockSupabase } = await import('../frontend/src/lib/mockSupabaseClient.js');

const OTHER_SEASON = '5eed5ea5-0000-4000-8000-000000000002';
const DIV = 'dddd0000-0000-4000-8000-000000000001';
const OLD_DIV = 'dddd0000-0000-4000-8000-000000000002';
const team = (id, name, division_id, extra = {}) => ({
  id,
  organization_id: MOCK_ORG_ID,
  division_id,
  name,
  is_external: false,
  ...extra,
});

/** The run's own teams, as the page hands them over: the coaches are here. */
const RUN_TEAMS = [
  {
    id: 't-a',
    name: 'Synthetic Comets',
    division: 'U10',
    coachName: 'Coach Alpha',
    coachEmail: 'alpha@example.test',
  },
  { id: 't-b', name: 'Synthetic Rockets', division: 'U10' },
  { id: 't-c', name: 'Synthetic Meteors', division: 'U10' },
];

const game = (id, home, away, start, end, extra = {}) => ({
  id,
  homeTeamId: home,
  awayTeamId: away,
  start,
  end,
  fieldId: 'field-1',
  slotId: `slot-${id}`,
  notes: '',
  ...extra,
});

/** The saved schedule as the page holds it, with the cancelled game already gone. */
const GAMES = [
  game('g-own', 't-a', 't-b', '2026-10-10T13:00:00Z', '2026-10-10T14:00:00Z'),
  game('g-club', 't-c', 't-x', '2026-10-10T15:00:00Z', '2026-10-10T16:00:00Z', {
    notes: 'Away at the club',
  }),
  // The repeated hour: 01:30 on 2026-11-01 happens twice in America/New_York, once in each offset.
  game('g-dst-1', 't-b', 't-c', '2026-11-01T05:30:00Z', '2026-11-01T06:15:00Z'),
  game('g-dst-2', 't-c', 't-a', '2026-11-01T06:30:00Z', '2026-11-01T07:15:00Z'),
  // A team of the other season: in no directory of this one, so omitted and counted.
  game('g-old', 't-a', 't-old', '2026-10-17T13:00:00Z', '2026-10-17T14:00:00Z'),
  // No time: counted as untimed, in no file.
  { id: 'g-untimed', homeTeamId: 't-b', awayTeamId: 't-a', fieldId: 'field-1', slotId: 's-u' },
];
const CANCELLED = game('g-cancelled', 't-a', 't-c', '2026-10-24T13:00:00Z', '2026-10-24T14:00:00Z');

const PRACTICES = [
  {
    teamId: 't-a',
    start: '2026-10-06T21:00:00Z',
    end: '2026-10-06T22:00:00Z',
    fieldId: 'field-2',
    slotId: 'p-slot-1',
  },
  // No time: counted as untimed.
  { teamId: 't-b', fieldId: 'field-2', slotId: 'p-slot-2' },
];

const tbd = (id, extra) => ({
  id,
  organization_id: MOCK_ORG_ID,
  season_settings_id: MOCK_SEASON_ID,
  division_id: DIV,
  ...extra,
});

function seedWorld() {
  seedMockDb({
    season_settings: [
      { id: OTHER_SEASON, organization_id: MOCK_ORG_ID, name: 'Last season', status: 'completed' },
    ],
    divisions: [
      { id: DIV, organization_id: MOCK_ORG_ID, season_settings_id: MOCK_SEASON_ID, name: 'U10' },
      { id: OLD_DIV, organization_id: MOCK_ORG_ID, season_settings_id: OTHER_SEASON, name: 'U10' },
    ],
    teams: [
      team('t-a', 'Synthetic Comets', DIV),
      team('t-b', 'Synthetic Rockets', DIV),
      team('t-c', 'Synthetic Meteors', DIV),
      team('t-x', 'Gulls FC', DIV, { is_external: true }),
      team('t-old', 'Synthetic Old Team', OLD_DIV),
    ],
    schedule_tbd: [
      tbd('tbd-dated', {
        kind: 'game',
        home_team_id: 't-a',
        away_team_id: 't-c',
        week_index: 4,
        reason: 'no-slot-available',
        game_date: '2026-10-31',
      }),
      tbd('tbd-undated', {
        kind: 'game',
        home_team_id: 't-b',
        away_team_id: 't-c',
        week_index: 5,
        reason: 'coach-scheduling-conflict',
      }),
      tbd('tbd-practice', {
        kind: 'practice',
        team_id: 't-c',
        missing_count: 1,
        reason: 'no-slot-available',
      }),
      tbd('tbd-old-season', {
        season_settings_id: OTHER_SEASON,
        division_id: OLD_DIV,
        kind: 'game',
        home_team_id: 't-old',
        away_team_id: 't-old',
        week_index: 1,
        reason: 'no-slot-available',
      }),
    ],
  });
}

let saved;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-13T12:00:00Z'));
  sessionStorage.clear();
  delete window.__MOCK_DB__;
  sessionStorage.setItem('__MOCK_SESSION__', JSON.stringify({ user: { id: 'mock-admin-id' } }));
  REC.uploads = [];
  REC.baselines = [];
  REC.compared = [];
  REC.marked = [];
  saved = [];
  let current = null;
  URL.createObjectURL = vi.fn((blob) => {
    current = blob;
    return 'blob:export';
  });
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function click() {
    saved.push({ name: this.download, blob: current });
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Generate, then compare, download, and upload; return everything the page made, as plain JSON. */
async function runPage(gameAssignments) {
  seedWorld();
  render(
    <OutputGenerationPanel
      teams={RUN_TEAMS}
      practiceAssignments={PRACTICES}
      gameAssignments={gameAssignments}
      supabaseClient={mockSupabase}
    />
  );
  fireEvent.click(screen.getByRole('button', { name: 'Generate CSVs' }));
  const status = await screen.findByTestId('output-generation-status');
  await waitFor(() => expect(status).toHaveTextContent('CSVs generated successfully.'));
  const generatedStatus = status.textContent;
  const counts = [
    screen.getByText(/^Master Schedule: /).textContent,
    screen.getByText(/^Team Schedules: /).textContent,
    screen.getByText(/^\d+ games? in these files\. /).textContent,
  ];
  const tbdList = within(screen.getByTestId('schedule-tbd-list'))
    .getAllByTestId('schedule-tbd-row')
    .map((item) => item.textContent);

  fireEvent.change(screen.getByTestId('baseline-select'), { target: { value: 'baseline-1' } });
  fireEvent.click(screen.getByTestId('check-parity-btn'));
  await screen.findByTestId('parity-error');

  fireEvent.click(screen.getByRole('button', { name: 'Download Master CSV' }));
  await waitFor(() => expect(saved).toHaveLength(1));
  const downloadedCsv = (await saved[0].blob.text()).replace(/^\uFEFF/, '');

  fireEvent.click(screen.getByRole('button', { name: 'Upload to Storage' }));
  await waitFor(() => expect(status.textContent).not.toMatch(/^(Checking|Uploading)/));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Upload to Storage' })).toBeEnabled()
  );

  return JSON.parse(
    JSON.stringify({
      generatedStatus,
      counts,
      tbdList,
      downloadedCsv,
      comparedRows: REC.compared,
      uploadStatus: status.textContent,
      uploads: REC.uploads,
      baselines: REC.baselines,
      marked: REC.marked,
    })
  );
}

const sha256 = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

describe('the Exports page makes exactly the master export it made before the lift (G5a)', () => {
  it('a published world: every case, the files, the ids, the baseline and the compared rows', async () => {
    REC.savedIds = [...GAMES.map((g) => g.id)];
    const actual = await runPage(GAMES);
    expect(actual).toEqual(EXPECTED_PUBLISHED);
    expect(sha256(actual)).toBe(sha256(EXPECTED_PUBLISHED));
  });

  it('a cancelled game still on a page loaded before it was cancelled: the upload is refused, nothing goes', async () => {
    REC.savedIds = [...GAMES.map((g) => g.id)];
    const actual = await runPage([...GAMES, CANCELLED]);
    expect(actual).toEqual(EXPECTED_STALE);
  });
});

/**
 * The output as the page made it at 5151f6c, before the lift: dumped from a run of this test over the code as it was
 * and read line by line. JSON, so a difference anywhere (a cell, a file, an id, a sentence) fails it.
 */
const EXPECTED_PUBLISHED = {
  generatedStatus:
    "CSVs generated successfully. 1 practice and 2 games not scheduled yet are in the files as TIME TBD, with the reason. 1 game assignment(s) and 1 practice assignment(s) with no start or end time are not in these files. The downloads on each team's page list that team's saved schedule, with every event that has no time marked TIME TBD and its reason. 1 game(s) name a team that is not on the season's team list, so they are not in these files. 1 team(s) have a coach with no id on file; they are exported, but no clash check can cover them until a row carries their id.",
  counts: [
    'Master Schedule: 13 rows',
    'Team Schedules: 3 files',
    '4 games in these files. Marked Published, they are held where they are; the published baseline stays the record of what went out.',
  ],
  tbdList: [
    'Synthetic Comets v Synthetic Meteors, week 4 (U10): no game slot was free for it',
    "Synthetic Rockets v Synthetic Meteors, week 5 (U10): a coach's other games leave no free time",
    'Synthetic Meteors (U10): 1 practice not scheduled: no slot was free for it',
  ],
  downloadedCsv:
    'Team ID,Team Name,Division,Coaches,Coach Emails,Event Type,Opponent,Role,Start,End,Field,Slot,Notes\nt-a,Synthetic Comets,U10,Coach Alpha,alpha@example.test,Practice,,,2026-10-06T21:00:00.000Z,2026-10-06T22:00:00.000Z,field-2,p-slot-1,\nt-a,Synthetic Comets,U10,Coach Alpha,alpha@example.test,Game,Synthetic Rockets,Home,2026-10-10T13:00:00.000Z,2026-10-10T14:00:00.000Z,field-1,slot-g-own,\nt-b,Synthetic Rockets,U10,,,Game,Synthetic Comets,Away,2026-10-10T13:00:00.000Z,2026-10-10T14:00:00.000Z,field-1,slot-g-own,\nt-c,Synthetic Meteors,U10,,,Game,Gulls FC,Home,2026-10-10T15:00:00.000Z,2026-10-10T16:00:00.000Z,field-1,slot-g-club,Away at the club\nt-b,Synthetic Rockets,U10,,,Game,Synthetic Meteors,Home,2026-11-01T05:30:00.000Z,2026-11-01T06:15:00.000Z,field-1,slot-g-dst-1,\nt-c,Synthetic Meteors,U10,,,Game,Synthetic Rockets,Away,2026-11-01T05:30:00.000Z,2026-11-01T06:15:00.000Z,field-1,slot-g-dst-1,\nt-a,Synthetic Comets,U10,Coach Alpha,alpha@example.test,Game,Synthetic Meteors,Away,2026-11-01T06:30:00.000Z,2026-11-01T07:15:00.000Z,field-1,slot-g-dst-2,\nt-c,Synthetic Meteors,U10,,,Game,Synthetic Comets,Home,2026-11-01T06:30:00.000Z,2026-11-01T07:15:00.000Z,field-1,slot-g-dst-2,\nt-a,Synthetic Comets,U10,Coach Alpha,alpha@example.test,Game,Synthetic Meteors,Home,TIME TBD,,LOCATION TBD,,"Game not scheduled (week 4, on 2026-10-31): no game slot was free for it."\nt-b,Synthetic Rockets,U10,,,Game,Synthetic Meteors,Home,TIME TBD,,LOCATION TBD,,Game not scheduled (week 5): a coach\'s other games leave no free time.\nt-c,Synthetic Meteors,U10,,,Game,Synthetic Comets,Away,TIME TBD,,LOCATION TBD,,"Game not scheduled (week 4, on 2026-10-31): no game slot was free for it."\nt-c,Synthetic Meteors,U10,,,Game,Synthetic Rockets,Away,TIME TBD,,LOCATION TBD,,Game not scheduled (week 5): a coach\'s other games leave no free time.\nt-c,Synthetic Meteors,U10,,,Practice,,,TIME TBD,,LOCATION TBD,,Practice not scheduled: no slot was free for it.',
  comparedRows: [
    {
      id: 'baseline-1',
      rows: [
        {
          'Team ID': 't-a',
          'Team Name': 'Synthetic Comets',
          Division: 'U10',
          Coaches: 'Coach Alpha',
          'Coach Emails': 'alpha@example.test',
          'Event Type': 'Practice',
          Opponent: '',
          Role: '',
          Start: '2026-10-06T21:00:00.000Z',
          End: '2026-10-06T22:00:00.000Z',
          Field: 'field-2',
          Slot: 'p-slot-1',
          Notes: '',
        },
        {
          'Team ID': 't-a',
          'Team Name': 'Synthetic Comets',
          Division: 'U10',
          Coaches: 'Coach Alpha',
          'Coach Emails': 'alpha@example.test',
          'Event Type': 'Game',
          Opponent: 'Synthetic Rockets',
          Role: 'Home',
          Start: '2026-10-10T13:00:00.000Z',
          End: '2026-10-10T14:00:00.000Z',
          Field: 'field-1',
          Slot: 'slot-g-own',
          Notes: '',
        },
        {
          'Team ID': 't-b',
          'Team Name': 'Synthetic Rockets',
          Division: 'U10',
          Coaches: '',
          'Coach Emails': '',
          'Event Type': 'Game',
          Opponent: 'Synthetic Comets',
          Role: 'Away',
          Start: '2026-10-10T13:00:00.000Z',
          End: '2026-10-10T14:00:00.000Z',
          Field: 'field-1',
          Slot: 'slot-g-own',
          Notes: '',
        },
        {
          'Team ID': 't-c',
          'Team Name': 'Synthetic Meteors',
          Division: 'U10',
          Coaches: '',
          'Coach Emails': '',
          'Event Type': 'Game',
          Opponent: 'Gulls FC',
          Role: 'Home',
          Start: '2026-10-10T15:00:00.000Z',
          End: '2026-10-10T16:00:00.000Z',
          Field: 'field-1',
          Slot: 'slot-g-club',
          Notes: 'Away at the club',
        },
        {
          'Team ID': 't-b',
          'Team Name': 'Synthetic Rockets',
          Division: 'U10',
          Coaches: '',
          'Coach Emails': '',
          'Event Type': 'Game',
          Opponent: 'Synthetic Meteors',
          Role: 'Home',
          Start: '2026-11-01T05:30:00.000Z',
          End: '2026-11-01T06:15:00.000Z',
          Field: 'field-1',
          Slot: 'slot-g-dst-1',
          Notes: '',
        },
        {
          'Team ID': 't-c',
          'Team Name': 'Synthetic Meteors',
          Division: 'U10',
          Coaches: '',
          'Coach Emails': '',
          'Event Type': 'Game',
          Opponent: 'Synthetic Rockets',
          Role: 'Away',
          Start: '2026-11-01T05:30:00.000Z',
          End: '2026-11-01T06:15:00.000Z',
          Field: 'field-1',
          Slot: 'slot-g-dst-1',
          Notes: '',
        },
        {
          'Team ID': 't-a',
          'Team Name': 'Synthetic Comets',
          Division: 'U10',
          Coaches: 'Coach Alpha',
          'Coach Emails': 'alpha@example.test',
          'Event Type': 'Game',
          Opponent: 'Synthetic Meteors',
          Role: 'Away',
          Start: '2026-11-01T06:30:00.000Z',
          End: '2026-11-01T07:15:00.000Z',
          Field: 'field-1',
          Slot: 'slot-g-dst-2',
          Notes: '',
        },
        {
          'Team ID': 't-c',
          'Team Name': 'Synthetic Meteors',
          Division: 'U10',
          Coaches: '',
          'Coach Emails': '',
          'Event Type': 'Game',
          Opponent: 'Synthetic Comets',
          Role: 'Home',
          Start: '2026-11-01T06:30:00.000Z',
          End: '2026-11-01T07:15:00.000Z',
          Field: 'field-1',
          Slot: 'slot-g-dst-2',
          Notes: '',
        },
        {
          'Team ID': 't-a',
          'Team Name': 'Synthetic Comets',
          Division: 'U10',
          Coaches: 'Coach Alpha',
          'Coach Emails': 'alpha@example.test',
          'Event Type': 'Game',
          Opponent: 'Synthetic Meteors',
          Role: 'Home',
          Start: 'TIME TBD',
          End: '',
          Field: 'LOCATION TBD',
          Slot: '',
          Notes: 'Game not scheduled (week 4, on 2026-10-31): no game slot was free for it.',
        },
        {
          'Team ID': 't-b',
          'Team Name': 'Synthetic Rockets',
          Division: 'U10',
          Coaches: '',
          'Coach Emails': '',
          'Event Type': 'Game',
          Opponent: 'Synthetic Meteors',
          Role: 'Home',
          Start: 'TIME TBD',
          End: '',
          Field: 'LOCATION TBD',
          Slot: '',
          Notes: "Game not scheduled (week 5): a coach's other games leave no free time.",
        },
        {
          'Team ID': 't-c',
          'Team Name': 'Synthetic Meteors',
          Division: 'U10',
          Coaches: '',
          'Coach Emails': '',
          'Event Type': 'Game',
          Opponent: 'Synthetic Comets',
          Role: 'Away',
          Start: 'TIME TBD',
          End: '',
          Field: 'LOCATION TBD',
          Slot: '',
          Notes: 'Game not scheduled (week 4, on 2026-10-31): no game slot was free for it.',
        },
        {
          'Team ID': 't-c',
          'Team Name': 'Synthetic Meteors',
          Division: 'U10',
          Coaches: '',
          'Coach Emails': '',
          'Event Type': 'Game',
          Opponent: 'Synthetic Rockets',
          Role: 'Away',
          Start: 'TIME TBD',
          End: '',
          Field: 'LOCATION TBD',
          Slot: '',
          Notes: "Game not scheduled (week 5): a coach's other games leave no free time.",
        },
        {
          'Team ID': 't-c',
          'Team Name': 'Synthetic Meteors',
          Division: 'U10',
          Coaches: '',
          'Coach Emails': '',
          'Event Type': 'Practice',
          Opponent: '',
          Role: '',
          Start: 'TIME TBD',
          End: '',
          Field: 'LOCATION TBD',
          Slot: '',
          Notes: 'Practice not scheduled: no slot was free for it.',
        },
      ],
    },
  ],
  uploadStatus:
    "Uploaded 4 files to 'exports' bucket. Recorded as published baseline v2. Published 4 games.",
  uploads: [
    {
      path: '5eed0000-0000-4000-8000-000000000001/master-schedule-2026-11-13T12-00-00-000Z.csv',
      file: 'Team ID,Team Name,Division,Coaches,Coach Emails,Event Type,Opponent,Role,Start,End,Field,Slot,Notes\nt-a,Synthetic Comets,U10,Coach Alpha,alpha@example.test,Practice,,,2026-10-06T21:00:00.000Z,2026-10-06T22:00:00.000Z,field-2,p-slot-1,\nt-a,Synthetic Comets,U10,Coach Alpha,alpha@example.test,Game,Synthetic Rockets,Home,2026-10-10T13:00:00.000Z,2026-10-10T14:00:00.000Z,field-1,slot-g-own,\nt-b,Synthetic Rockets,U10,,,Game,Synthetic Comets,Away,2026-10-10T13:00:00.000Z,2026-10-10T14:00:00.000Z,field-1,slot-g-own,\nt-c,Synthetic Meteors,U10,,,Game,Gulls FC,Home,2026-10-10T15:00:00.000Z,2026-10-10T16:00:00.000Z,field-1,slot-g-club,Away at the club\nt-b,Synthetic Rockets,U10,,,Game,Synthetic Meteors,Home,2026-11-01T05:30:00.000Z,2026-11-01T06:15:00.000Z,field-1,slot-g-dst-1,\nt-c,Synthetic Meteors,U10,,,Game,Synthetic Rockets,Away,2026-11-01T05:30:00.000Z,2026-11-01T06:15:00.000Z,field-1,slot-g-dst-1,\nt-a,Synthetic Comets,U10,Coach Alpha,alpha@example.test,Game,Synthetic Meteors,Away,2026-11-01T06:30:00.000Z,2026-11-01T07:15:00.000Z,field-1,slot-g-dst-2,\nt-c,Synthetic Meteors,U10,,,Game,Synthetic Comets,Home,2026-11-01T06:30:00.000Z,2026-11-01T07:15:00.000Z,field-1,slot-g-dst-2,\nt-a,Synthetic Comets,U10,Coach Alpha,alpha@example.test,Game,Synthetic Meteors,Home,TIME TBD,,LOCATION TBD,,"Game not scheduled (week 4, on 2026-10-31): no game slot was free for it."\nt-b,Synthetic Rockets,U10,,,Game,Synthetic Meteors,Home,TIME TBD,,LOCATION TBD,,Game not scheduled (week 5): a coach\'s other games leave no free time.\nt-c,Synthetic Meteors,U10,,,Game,Synthetic Comets,Away,TIME TBD,,LOCATION TBD,,"Game not scheduled (week 4, on 2026-10-31): no game slot was free for it."\nt-c,Synthetic Meteors,U10,,,Game,Synthetic Rockets,Away,TIME TBD,,LOCATION TBD,,Game not scheduled (week 5): a coach\'s other games leave no free time.\nt-c,Synthetic Meteors,U10,,,Practice,,,TIME TBD,,LOCATION TBD,,Practice not scheduled: no slot was free for it.',
    },
    {
      path: '5eed0000-0000-4000-8000-000000000001/teams/t-a-2026-11-13T12-00-00-000Z.csv',
      file: 'Team ID,Team Name,Division,Coaches,Coach Emails,Event Type,Opponent,Role,Start,End,Field,Slot,Notes\nt-a,Synthetic Comets,U10,Coach Alpha,alpha@example.test,Practice,,,2026-10-06T21:00:00.000Z,2026-10-06T22:00:00.000Z,field-2,p-slot-1,\nt-a,Synthetic Comets,U10,Coach Alpha,alpha@example.test,Game,Synthetic Rockets,Home,2026-10-10T13:00:00.000Z,2026-10-10T14:00:00.000Z,field-1,slot-g-own,\nt-a,Synthetic Comets,U10,Coach Alpha,alpha@example.test,Game,Synthetic Meteors,Away,2026-11-01T06:30:00.000Z,2026-11-01T07:15:00.000Z,field-1,slot-g-dst-2,\nt-a,Synthetic Comets,U10,Coach Alpha,alpha@example.test,Game,Synthetic Meteors,Home,TIME TBD,,LOCATION TBD,,"Game not scheduled (week 4, on 2026-10-31): no game slot was free for it."',
    },
    {
      path: '5eed0000-0000-4000-8000-000000000001/teams/t-b-2026-11-13T12-00-00-000Z.csv',
      file: "Team ID,Team Name,Division,Coaches,Coach Emails,Event Type,Opponent,Role,Start,End,Field,Slot,Notes\nt-b,Synthetic Rockets,U10,,,Game,Synthetic Comets,Away,2026-10-10T13:00:00.000Z,2026-10-10T14:00:00.000Z,field-1,slot-g-own,\nt-b,Synthetic Rockets,U10,,,Game,Synthetic Meteors,Home,2026-11-01T05:30:00.000Z,2026-11-01T06:15:00.000Z,field-1,slot-g-dst-1,\nt-b,Synthetic Rockets,U10,,,Game,Synthetic Meteors,Home,TIME TBD,,LOCATION TBD,,Game not scheduled (week 5): a coach's other games leave no free time.",
    },
    {
      path: '5eed0000-0000-4000-8000-000000000001/teams/t-c-2026-11-13T12-00-00-000Z.csv',
      file: 'Team ID,Team Name,Division,Coaches,Coach Emails,Event Type,Opponent,Role,Start,End,Field,Slot,Notes\nt-c,Synthetic Meteors,U10,,,Game,Gulls FC,Home,2026-10-10T15:00:00.000Z,2026-10-10T16:00:00.000Z,field-1,slot-g-club,Away at the club\nt-c,Synthetic Meteors,U10,,,Game,Synthetic Rockets,Away,2026-11-01T05:30:00.000Z,2026-11-01T06:15:00.000Z,field-1,slot-g-dst-1,\nt-c,Synthetic Meteors,U10,,,Game,Synthetic Comets,Home,2026-11-01T06:30:00.000Z,2026-11-01T07:15:00.000Z,field-1,slot-g-dst-2,\nt-c,Synthetic Meteors,U10,,,Game,Synthetic Comets,Away,TIME TBD,,LOCATION TBD,,"Game not scheduled (week 4, on 2026-10-31): no game slot was free for it."\nt-c,Synthetic Meteors,U10,,,Game,Synthetic Rockets,Away,TIME TBD,,LOCATION TBD,,Game not scheduled (week 5): a coach\'s other games leave no free time.\nt-c,Synthetic Meteors,U10,,,Practice,,,TIME TBD,,LOCATION TBD,,Practice not scheduled: no slot was free for it.',
    },
  ],
  baselines: [
    {
      snapshotId: 'master-schedule-2026-11-13T12-00-00-000Z',
      label: 'Master schedule, 13 rows',
      channel: 'exports bucket',
      publishedAt: '2026-11-13T12:00:00',
      publishedBy: 'mock-admin-id',
      rows: [
        {
          'Team ID': 't-a',
          'Team Name': 'Synthetic Comets',
          Division: 'U10',
          Coaches: 'Coach Alpha',
          'Coach Emails': 'alpha@example.test',
          'Event Type': 'Practice',
          Opponent: '',
          Role: '',
          Start: '2026-10-06T21:00:00.000Z',
          End: '2026-10-06T22:00:00.000Z',
          Field: 'field-2',
          Slot: 'p-slot-1',
          Notes: '',
        },
        {
          'Team ID': 't-a',
          'Team Name': 'Synthetic Comets',
          Division: 'U10',
          Coaches: 'Coach Alpha',
          'Coach Emails': 'alpha@example.test',
          'Event Type': 'Game',
          Opponent: 'Synthetic Rockets',
          Role: 'Home',
          Start: '2026-10-10T13:00:00.000Z',
          End: '2026-10-10T14:00:00.000Z',
          Field: 'field-1',
          Slot: 'slot-g-own',
          Notes: '',
        },
        {
          'Team ID': 't-b',
          'Team Name': 'Synthetic Rockets',
          Division: 'U10',
          Coaches: '',
          'Coach Emails': '',
          'Event Type': 'Game',
          Opponent: 'Synthetic Comets',
          Role: 'Away',
          Start: '2026-10-10T13:00:00.000Z',
          End: '2026-10-10T14:00:00.000Z',
          Field: 'field-1',
          Slot: 'slot-g-own',
          Notes: '',
        },
        {
          'Team ID': 't-c',
          'Team Name': 'Synthetic Meteors',
          Division: 'U10',
          Coaches: '',
          'Coach Emails': '',
          'Event Type': 'Game',
          Opponent: 'Gulls FC',
          Role: 'Home',
          Start: '2026-10-10T15:00:00.000Z',
          End: '2026-10-10T16:00:00.000Z',
          Field: 'field-1',
          Slot: 'slot-g-club',
          Notes: 'Away at the club',
        },
        {
          'Team ID': 't-b',
          'Team Name': 'Synthetic Rockets',
          Division: 'U10',
          Coaches: '',
          'Coach Emails': '',
          'Event Type': 'Game',
          Opponent: 'Synthetic Meteors',
          Role: 'Home',
          Start: '2026-11-01T05:30:00.000Z',
          End: '2026-11-01T06:15:00.000Z',
          Field: 'field-1',
          Slot: 'slot-g-dst-1',
          Notes: '',
        },
        {
          'Team ID': 't-c',
          'Team Name': 'Synthetic Meteors',
          Division: 'U10',
          Coaches: '',
          'Coach Emails': '',
          'Event Type': 'Game',
          Opponent: 'Synthetic Rockets',
          Role: 'Away',
          Start: '2026-11-01T05:30:00.000Z',
          End: '2026-11-01T06:15:00.000Z',
          Field: 'field-1',
          Slot: 'slot-g-dst-1',
          Notes: '',
        },
        {
          'Team ID': 't-a',
          'Team Name': 'Synthetic Comets',
          Division: 'U10',
          Coaches: 'Coach Alpha',
          'Coach Emails': 'alpha@example.test',
          'Event Type': 'Game',
          Opponent: 'Synthetic Meteors',
          Role: 'Away',
          Start: '2026-11-01T06:30:00.000Z',
          End: '2026-11-01T07:15:00.000Z',
          Field: 'field-1',
          Slot: 'slot-g-dst-2',
          Notes: '',
        },
        {
          'Team ID': 't-c',
          'Team Name': 'Synthetic Meteors',
          Division: 'U10',
          Coaches: '',
          'Coach Emails': '',
          'Event Type': 'Game',
          Opponent: 'Synthetic Comets',
          Role: 'Home',
          Start: '2026-11-01T06:30:00.000Z',
          End: '2026-11-01T07:15:00.000Z',
          Field: 'field-1',
          Slot: 'slot-g-dst-2',
          Notes: '',
        },
        {
          'Team ID': 't-a',
          'Team Name': 'Synthetic Comets',
          Division: 'U10',
          Coaches: 'Coach Alpha',
          'Coach Emails': 'alpha@example.test',
          'Event Type': 'Game',
          Opponent: 'Synthetic Meteors',
          Role: 'Home',
          Start: 'TIME TBD',
          End: '',
          Field: 'LOCATION TBD',
          Slot: '',
          Notes: 'Game not scheduled (week 4, on 2026-10-31): no game slot was free for it.',
        },
        {
          'Team ID': 't-b',
          'Team Name': 'Synthetic Rockets',
          Division: 'U10',
          Coaches: '',
          'Coach Emails': '',
          'Event Type': 'Game',
          Opponent: 'Synthetic Meteors',
          Role: 'Home',
          Start: 'TIME TBD',
          End: '',
          Field: 'LOCATION TBD',
          Slot: '',
          Notes: "Game not scheduled (week 5): a coach's other games leave no free time.",
        },
        {
          'Team ID': 't-c',
          'Team Name': 'Synthetic Meteors',
          Division: 'U10',
          Coaches: '',
          'Coach Emails': '',
          'Event Type': 'Game',
          Opponent: 'Synthetic Comets',
          Role: 'Away',
          Start: 'TIME TBD',
          End: '',
          Field: 'LOCATION TBD',
          Slot: '',
          Notes: 'Game not scheduled (week 4, on 2026-10-31): no game slot was free for it.',
        },
        {
          'Team ID': 't-c',
          'Team Name': 'Synthetic Meteors',
          Division: 'U10',
          Coaches: '',
          'Coach Emails': '',
          'Event Type': 'Game',
          Opponent: 'Synthetic Rockets',
          Role: 'Away',
          Start: 'TIME TBD',
          End: '',
          Field: 'LOCATION TBD',
          Slot: '',
          Notes: "Game not scheduled (week 5): a coach's other games leave no free time.",
        },
        {
          'Team ID': 't-c',
          'Team Name': 'Synthetic Meteors',
          Division: 'U10',
          Coaches: '',
          'Coach Emails': '',
          'Event Type': 'Practice',
          Opponent: '',
          Role: '',
          Start: 'TIME TBD',
          End: '',
          Field: 'LOCATION TBD',
          Slot: '',
          Notes: 'Practice not scheduled: no slot was free for it.',
        },
      ],
    },
  ],
  marked: [
    {
      organizationId: '5eed0000-0000-4000-8000-000000000001',
      ids: ['g-own', 'g-club', 'g-dst-1', 'g-dst-2'],
      published: true,
      scope: {
        kind: 'selection',
        value: 'Exports panel',
      },
    },
  ],
};

const EXPECTED_STALE = {
  generatedStatus:
    "CSVs generated successfully. 1 practice and 2 games not scheduled yet are in the files as TIME TBD, with the reason. 1 game assignment(s) and 1 practice assignment(s) with no start or end time are not in these files. The downloads on each team's page list that team's saved schedule, with every event that has no time marked TIME TBD and its reason. 1 game(s) name a team that is not on the season's team list, so they are not in these files. 1 team(s) have a coach with no id on file; they are exported, but no clash check can cover them until a row carries their id.",
  counts: [
    'Master Schedule: 15 rows',
    'Team Schedules: 3 files',
    '5 games in these files. Marked Published, they are held where they are; the published baseline stays the record of what went out.',
  ],
  tbdList: [
    'Synthetic Comets v Synthetic Meteors, week 4 (U10): no game slot was free for it',
    "Synthetic Rockets v Synthetic Meteors, week 5 (U10): a coach's other games leave no free time",
    'Synthetic Meteors (U10): 1 practice not scheduled: no slot was free for it',
  ],
  downloadedCsv:
    'Team ID,Team Name,Division,Coaches,Coach Emails,Event Type,Opponent,Role,Start,End,Field,Slot,Notes\nt-a,Synthetic Comets,U10,Coach Alpha,alpha@example.test,Practice,,,2026-10-06T21:00:00.000Z,2026-10-06T22:00:00.000Z,field-2,p-slot-1,\nt-a,Synthetic Comets,U10,Coach Alpha,alpha@example.test,Game,Synthetic Rockets,Home,2026-10-10T13:00:00.000Z,2026-10-10T14:00:00.000Z,field-1,slot-g-own,\nt-b,Synthetic Rockets,U10,,,Game,Synthetic Comets,Away,2026-10-10T13:00:00.000Z,2026-10-10T14:00:00.000Z,field-1,slot-g-own,\nt-c,Synthetic Meteors,U10,,,Game,Gulls FC,Home,2026-10-10T15:00:00.000Z,2026-10-10T16:00:00.000Z,field-1,slot-g-club,Away at the club\nt-a,Synthetic Comets,U10,Coach Alpha,alpha@example.test,Game,Synthetic Meteors,Home,2026-10-24T13:00:00.000Z,2026-10-24T14:00:00.000Z,field-1,slot-g-cancelled,\nt-c,Synthetic Meteors,U10,,,Game,Synthetic Comets,Away,2026-10-24T13:00:00.000Z,2026-10-24T14:00:00.000Z,field-1,slot-g-cancelled,\nt-b,Synthetic Rockets,U10,,,Game,Synthetic Meteors,Home,2026-11-01T05:30:00.000Z,2026-11-01T06:15:00.000Z,field-1,slot-g-dst-1,\nt-c,Synthetic Meteors,U10,,,Game,Synthetic Rockets,Away,2026-11-01T05:30:00.000Z,2026-11-01T06:15:00.000Z,field-1,slot-g-dst-1,\nt-a,Synthetic Comets,U10,Coach Alpha,alpha@example.test,Game,Synthetic Meteors,Away,2026-11-01T06:30:00.000Z,2026-11-01T07:15:00.000Z,field-1,slot-g-dst-2,\nt-c,Synthetic Meteors,U10,,,Game,Synthetic Comets,Home,2026-11-01T06:30:00.000Z,2026-11-01T07:15:00.000Z,field-1,slot-g-dst-2,\nt-a,Synthetic Comets,U10,Coach Alpha,alpha@example.test,Game,Synthetic Meteors,Home,TIME TBD,,LOCATION TBD,,"Game not scheduled (week 4, on 2026-10-31): no game slot was free for it."\nt-b,Synthetic Rockets,U10,,,Game,Synthetic Meteors,Home,TIME TBD,,LOCATION TBD,,Game not scheduled (week 5): a coach\'s other games leave no free time.\nt-c,Synthetic Meteors,U10,,,Game,Synthetic Comets,Away,TIME TBD,,LOCATION TBD,,"Game not scheduled (week 4, on 2026-10-31): no game slot was free for it."\nt-c,Synthetic Meteors,U10,,,Game,Synthetic Rockets,Away,TIME TBD,,LOCATION TBD,,Game not scheduled (week 5): a coach\'s other games leave no free time.\nt-c,Synthetic Meteors,U10,,,Practice,,,TIME TBD,,LOCATION TBD,,Practice not scheduled: no slot was free for it.',
  comparedRows: [
    {
      id: 'baseline-1',
      rows: [
        {
          'Team ID': 't-a',
          'Team Name': 'Synthetic Comets',
          Division: 'U10',
          Coaches: 'Coach Alpha',
          'Coach Emails': 'alpha@example.test',
          'Event Type': 'Practice',
          Opponent: '',
          Role: '',
          Start: '2026-10-06T21:00:00.000Z',
          End: '2026-10-06T22:00:00.000Z',
          Field: 'field-2',
          Slot: 'p-slot-1',
          Notes: '',
        },
        {
          'Team ID': 't-a',
          'Team Name': 'Synthetic Comets',
          Division: 'U10',
          Coaches: 'Coach Alpha',
          'Coach Emails': 'alpha@example.test',
          'Event Type': 'Game',
          Opponent: 'Synthetic Rockets',
          Role: 'Home',
          Start: '2026-10-10T13:00:00.000Z',
          End: '2026-10-10T14:00:00.000Z',
          Field: 'field-1',
          Slot: 'slot-g-own',
          Notes: '',
        },
        {
          'Team ID': 't-b',
          'Team Name': 'Synthetic Rockets',
          Division: 'U10',
          Coaches: '',
          'Coach Emails': '',
          'Event Type': 'Game',
          Opponent: 'Synthetic Comets',
          Role: 'Away',
          Start: '2026-10-10T13:00:00.000Z',
          End: '2026-10-10T14:00:00.000Z',
          Field: 'field-1',
          Slot: 'slot-g-own',
          Notes: '',
        },
        {
          'Team ID': 't-c',
          'Team Name': 'Synthetic Meteors',
          Division: 'U10',
          Coaches: '',
          'Coach Emails': '',
          'Event Type': 'Game',
          Opponent: 'Gulls FC',
          Role: 'Home',
          Start: '2026-10-10T15:00:00.000Z',
          End: '2026-10-10T16:00:00.000Z',
          Field: 'field-1',
          Slot: 'slot-g-club',
          Notes: 'Away at the club',
        },
        {
          'Team ID': 't-a',
          'Team Name': 'Synthetic Comets',
          Division: 'U10',
          Coaches: 'Coach Alpha',
          'Coach Emails': 'alpha@example.test',
          'Event Type': 'Game',
          Opponent: 'Synthetic Meteors',
          Role: 'Home',
          Start: '2026-10-24T13:00:00.000Z',
          End: '2026-10-24T14:00:00.000Z',
          Field: 'field-1',
          Slot: 'slot-g-cancelled',
          Notes: '',
        },
        {
          'Team ID': 't-c',
          'Team Name': 'Synthetic Meteors',
          Division: 'U10',
          Coaches: '',
          'Coach Emails': '',
          'Event Type': 'Game',
          Opponent: 'Synthetic Comets',
          Role: 'Away',
          Start: '2026-10-24T13:00:00.000Z',
          End: '2026-10-24T14:00:00.000Z',
          Field: 'field-1',
          Slot: 'slot-g-cancelled',
          Notes: '',
        },
        {
          'Team ID': 't-b',
          'Team Name': 'Synthetic Rockets',
          Division: 'U10',
          Coaches: '',
          'Coach Emails': '',
          'Event Type': 'Game',
          Opponent: 'Synthetic Meteors',
          Role: 'Home',
          Start: '2026-11-01T05:30:00.000Z',
          End: '2026-11-01T06:15:00.000Z',
          Field: 'field-1',
          Slot: 'slot-g-dst-1',
          Notes: '',
        },
        {
          'Team ID': 't-c',
          'Team Name': 'Synthetic Meteors',
          Division: 'U10',
          Coaches: '',
          'Coach Emails': '',
          'Event Type': 'Game',
          Opponent: 'Synthetic Rockets',
          Role: 'Away',
          Start: '2026-11-01T05:30:00.000Z',
          End: '2026-11-01T06:15:00.000Z',
          Field: 'field-1',
          Slot: 'slot-g-dst-1',
          Notes: '',
        },
        {
          'Team ID': 't-a',
          'Team Name': 'Synthetic Comets',
          Division: 'U10',
          Coaches: 'Coach Alpha',
          'Coach Emails': 'alpha@example.test',
          'Event Type': 'Game',
          Opponent: 'Synthetic Meteors',
          Role: 'Away',
          Start: '2026-11-01T06:30:00.000Z',
          End: '2026-11-01T07:15:00.000Z',
          Field: 'field-1',
          Slot: 'slot-g-dst-2',
          Notes: '',
        },
        {
          'Team ID': 't-c',
          'Team Name': 'Synthetic Meteors',
          Division: 'U10',
          Coaches: '',
          'Coach Emails': '',
          'Event Type': 'Game',
          Opponent: 'Synthetic Comets',
          Role: 'Home',
          Start: '2026-11-01T06:30:00.000Z',
          End: '2026-11-01T07:15:00.000Z',
          Field: 'field-1',
          Slot: 'slot-g-dst-2',
          Notes: '',
        },
        {
          'Team ID': 't-a',
          'Team Name': 'Synthetic Comets',
          Division: 'U10',
          Coaches: 'Coach Alpha',
          'Coach Emails': 'alpha@example.test',
          'Event Type': 'Game',
          Opponent: 'Synthetic Meteors',
          Role: 'Home',
          Start: 'TIME TBD',
          End: '',
          Field: 'LOCATION TBD',
          Slot: '',
          Notes: 'Game not scheduled (week 4, on 2026-10-31): no game slot was free for it.',
        },
        {
          'Team ID': 't-b',
          'Team Name': 'Synthetic Rockets',
          Division: 'U10',
          Coaches: '',
          'Coach Emails': '',
          'Event Type': 'Game',
          Opponent: 'Synthetic Meteors',
          Role: 'Home',
          Start: 'TIME TBD',
          End: '',
          Field: 'LOCATION TBD',
          Slot: '',
          Notes: "Game not scheduled (week 5): a coach's other games leave no free time.",
        },
        {
          'Team ID': 't-c',
          'Team Name': 'Synthetic Meteors',
          Division: 'U10',
          Coaches: '',
          'Coach Emails': '',
          'Event Type': 'Game',
          Opponent: 'Synthetic Comets',
          Role: 'Away',
          Start: 'TIME TBD',
          End: '',
          Field: 'LOCATION TBD',
          Slot: '',
          Notes: 'Game not scheduled (week 4, on 2026-10-31): no game slot was free for it.',
        },
        {
          'Team ID': 't-c',
          'Team Name': 'Synthetic Meteors',
          Division: 'U10',
          Coaches: '',
          'Coach Emails': '',
          'Event Type': 'Game',
          Opponent: 'Synthetic Rockets',
          Role: 'Away',
          Start: 'TIME TBD',
          End: '',
          Field: 'LOCATION TBD',
          Slot: '',
          Notes: "Game not scheduled (week 5): a coach's other games leave no free time.",
        },
        {
          'Team ID': 't-c',
          'Team Name': 'Synthetic Meteors',
          Division: 'U10',
          Coaches: '',
          'Coach Emails': '',
          'Event Type': 'Practice',
          Opponent: '',
          Role: '',
          Start: 'TIME TBD',
          End: '',
          Field: 'LOCATION TBD',
          Slot: '',
          Notes: 'Practice not scheduled: no slot was free for it.',
        },
      ],
    },
  ],
  uploadStatus:
    'Nothing was uploaded: 1 of the 5 games in these files is no longer in the saved game schedule, which was changed after these files were generated, so the files are out of date. Generate the CSVs again, then upload.',
  uploads: [],
  baselines: [],
  marked: [],
};
