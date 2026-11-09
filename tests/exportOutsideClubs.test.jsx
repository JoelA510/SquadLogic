// The export's team directory holds the season's teams as the tables have them, outside clubs included (PR 5, fix round 2,
// Codex P1).
//
// The master and per-team files are made from a directory of teams, and the panel took it from the LATEST TEAM RUN
// (`team.teams`). An outside club (a team row flagged `is_external`) is in no team run, so a directory made from the run
// never held one, and every game an outside club plays was dropped from the files, and from the ids "Mark these games
// Published" names, without a word. The directory is now read from the season's team records at generate time (all or
// nothing, naming the table), the run's own teams (which carry the coaches) take their places in it, an outside club is
// named as an opponent and has no rows or file of its own, and a game whose team is in NO directory is COUNTED and said
// beside the files, never left out in silence.
//
// Driven through the real panel and the real mock client, as tests/outputGenerationTbd.test.jsx is. The plant is the
// panel without the directory read (the old behaviour): the own-vs-outside game is then dropped and counted.
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MOCK_ORG_ID, MOCK_SEASON_ID } from '../frontend/src/lib/mockSeedIds.js';
import { seedMockDb } from './helpers/seedMockDb.js';

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
vi.mock('../frontend/src/lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), log: vi.fn() },
}));

const {
  default: OutputGenerationPanel,
  buildExportPayload,
  omittedGamesNote,
} = await import('../frontend/src/components/OutputGenerationPanel.jsx');
const { mockSupabase } = await import('../frontend/src/lib/mockSupabaseClient.js');
const { readSeasonTeamDirectory, seasonTeamsOf } =
  await import('../frontend/src/utils/scheduleReportsRead.js');
const { generateScheduleExports } = await import('../packages/core/src/outputGeneration.js');

const DIVISION = 'dddd0000-0000-4000-8000-000000000001';
const OWN = { id: 't-own', name: 'Team A', division: 'U8 Coed' };
const CLUB_ROW = {
  id: 't-club',
  organization_id: MOCK_ORG_ID,
  division_id: DIVISION,
  name: 'Gulls FC',
  is_external: true,
};
const OWN_ROW = {
  id: 't-own',
  organization_id: MOCK_ORG_ID,
  division_id: DIVISION,
  name: 'Team A',
  is_external: false,
};
const game = (id, home, away, start = '2026-04-11T16:00:00Z') => ({
  id,
  homeTeamId: home,
  awayTeamId: away,
  start,
  end: start.replace('16:00', '17:00'),
  fieldId: 'Field 1',
  slotId: `slot-${id}`,
});

let saved;
beforeEach(() => {
  sessionStorage.clear();
  delete window.__MOCK_DB__;
  sessionStorage.setItem('__MOCK_SESSION__', JSON.stringify({ user: { id: 'mock-admin-id' } }));
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
afterEach(() => vi.restoreAllMocks());

/** The season's league: one division, the own team Team A and the outside club Gulls FC. */
function seedLeague({ withClub = true } = {}) {
  seedMockDb({
    divisions: [
      {
        id: DIVISION,
        organization_id: MOCK_ORG_ID,
        season_settings_id: MOCK_SEASON_ID,
        name: 'U8 Coed',
      },
    ],
    teams: withClub ? [OWN_ROW, CLUB_ROW] : [OWN_ROW],
  });
}

function renderPanel(props) {
  render(<OutputGenerationPanel teams={[OWN]} supabaseClient={mockSupabase} {...props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Generate CSVs' }));
}

describe('the season team directory is read from the team records, outside clubs included', () => {
  it('reads every team of the season, flags the outside club, and leaves out a division of another season', async () => {
    seedLeague();
    seedMockDb({
      divisions: [
        {
          id: 'other-season-division',
          organization_id: MOCK_ORG_ID,
          season_settings_id: 'another-season',
          name: 'Old U8',
        },
      ],
      teams: [
        {
          id: 't-old',
          organization_id: MOCK_ORG_ID,
          division_id: 'other-season-division',
          name: 'Old Team',
          is_external: false,
        },
      ],
    });
    const read = await readSeasonTeamDirectory(mockSupabase, {
      organizationId: MOCK_ORG_ID,
      seasonSettingsId: MOCK_SEASON_ID,
    });
    expect(read.ok).toBe(true);
    const mine = read.ok
      ? read.teams
          .filter((t) => ['t-own', 't-club', 't-old'].includes(t.id))
          .sort((a, b) => a.id.localeCompare(b.id))
      : [];
    expect(mine).toEqual([
      {
        id: 't-club',
        name: 'Gulls FC',
        divisionId: DIVISION,
        division: 'U8 Coed',
        isExternal: true,
      },
      {
        id: 't-own',
        name: 'Team A',
        divisionId: DIVISION,
        division: 'U8 Coed',
        isExternal: false,
      },
    ]);
  });

  it('a read that fails is a failure naming the table, never an empty directory', async () => {
    seedLeague();
    const from = mockSupabase.from.bind(mockSupabase);
    vi.spyOn(mockSupabase, 'from').mockImplementation((table) => {
      if (table === 'teams') throw new Error('teams are unreadable');
      return from(table);
    });
    const read = await readSeasonTeamDirectory(mockSupabase, {
      organizationId: MOCK_ORG_ID,
      seasonSettingsId: MOCK_SEASON_ID,
    });
    expect(read).toMatchObject({ ok: false, table: 'teams', message: 'teams are unreadable' });
    expect(
      await readSeasonTeamDirectory(mockSupabase, { organizationId: MOCK_ORG_ID })
    ).toMatchObject({
      ok: false,
      table: 'season',
    });
  });

  it('seasonTeamsOf keeps only the season\u2019s divisions\u2019 teams and the flag', () => {
    expect(
      seasonTeamsOf(
        [{ id: 'd', name: 'U8' }],
        [
          { id: 'a', name: 'A', division_id: 'd', is_external: true },
          { id: 'b', name: 'B', division_id: 'x' },
          { id: 'c', division_id: 'd' },
        ]
      )
    ).toEqual([
      { id: 'a', name: 'A', divisionId: 'd', division: 'U8', isExternal: true },
      { id: 'c', name: 'c', divisionId: 'd', division: 'U8', isExternal: false },
    ]);
  });
});

describe('the files hold the games an outside club plays', () => {
  it('own vs outside: one game, one row, the club named as the opponent and no file of its own', async () => {
    seedLeague();
    renderPanel({ gameAssignments: [game('g1', 't-own', 't-club')] });
    const status = await screen.findByTestId('output-generation-status');
    await waitFor(() => expect(status).toHaveTextContent('CSVs generated successfully.'));
    expect(status).not.toHaveTextContent("not on the season's team list");
    expect(screen.getByText('Master Schedule: 1 rows')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Download Master CSV' }));
    await waitFor(() => expect(saved).toHaveLength(1));
    const csv = (await saved[0].blob.text()).replace(/^\ufeff/, '').split('\n');
    const rows = csv.filter((line) => line.includes(',Game,'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatch(/Team A,U8 Coed,.*,Game,Gulls FC,Home,/);
    // The outside club has no rows of its own in the master file.
    expect(csv.some((line) => line.startsWith('Gulls FC,'))).toBe(false);
  });

  it('a game naming a team in NO directory is counted and said, beside the files that were made', async () => {
    seedLeague();
    renderPanel({
      gameAssignments: [game('g1', 't-own', 't-club'), game('g2', 't-own', 't-nobody')],
    });
    const status = await screen.findByTestId('output-generation-status');
    await waitFor(() => expect(status).toHaveTextContent('CSVs generated successfully.'));
    expect(status).toHaveTextContent(
      "1 game(s) name a team that is not on the season's team list, so they are not in these files."
    );
    expect(screen.getByText('Master Schedule: 1 rows')).toBeInTheDocument();
  });

  it('the plant: with no club in the team records the game is dropped AND counted, never silent', async () => {
    seedLeague({ withClub: false });
    renderPanel({ gameAssignments: [game('g1', 't-own', 't-club')] });
    const status = await screen.findByTestId('output-generation-status');
    await waitFor(() => expect(status).toHaveTextContent('Nothing to export'));
    expect(status).toHaveTextContent(
      "1 game(s) name a team that is not on the season's team list, so they are not in these files."
    );
  });

  it('a directory that cannot be read stops the files and says which table (an unread directory is not an empty one)', async () => {
    seedLeague();
    const from = mockSupabase.from.bind(mockSupabase);
    vi.spyOn(mockSupabase, 'from').mockImplementation((table) => {
      if (table === 'teams') throw new Error('teams are unreadable');
      return from(table);
    });
    renderPanel({ gameAssignments: [game('g1', 't-own', 't-club')] });
    const status = await screen.findByTestId('output-generation-status');
    await waitFor(() => expect(status).toHaveTextContent('Generation failed'));
    expect(status).toHaveTextContent(
      /the season's teams could not be read \(teams: teams are unreadable\)/
    );
    expect(status).toHaveTextContent('No files were made');
    expect(screen.queryByRole('button', { name: 'Download Master CSV' })).toBeNull();
  });
});

describe('the games a file holds and the ids "Mark these games Published" names are one filter', () => {
  const directory = seasonTeamsOf([{ id: DIVISION, name: 'U8 Coed' }], [OWN_ROW, CLUB_ROW]);
  const games = [
    game('in-club', 't-own', 't-club'),
    game('in-own', 't-own', 't-own'),
    game('unknown', 't-own', 't-nobody'),
    { id: 'untimed', homeTeamId: 't-own', awayTeamId: 't-club' },
  ];

  it('with the directory: the club\u2019s game is in the file and in the ids; the unknown one is neither, and is counted', () => {
    const payload = buildExportPayload({
      teams: [OWN],
      teamSummary: null,
      practiceAssignments: [],
      gameAssignments: games,
      directory,
    });
    expect(payload.gameIds).toEqual(['in-club', 'in-own']);
    expect(payload.gameAssignments).toHaveLength(2);
    expect(payload.omitted).toEqual({ games: 1 });
    expect(payload.untimed.games).toBe(1);
    // And the files made from it hold exactly those rows.
    const files = generateScheduleExports({
      teams: payload.teams,
      gameAssignments: payload.gameAssignments,
    });
    expect(files.master.rows).toHaveLength(3);
    expect(files.perTeam.map((t) => t.teamId)).toEqual(['t-own']);
  });

  it('the plant, without the directory: the club\u2019s game is out of the file, out of the ids, and counted omitted', () => {
    const payload = buildExportPayload({
      teams: [OWN],
      teamSummary: null,
      practiceAssignments: [],
      gameAssignments: games,
      directory: [],
    });
    expect(payload.gameIds).toEqual(['in-own']);
    expect(payload.omitted).toEqual({ games: 2 });
  });

  it('says the omitted games in words, and nothing when none is omitted', () => {
    expect(omittedGamesNote({ games: 2 })).toBe(
      "2 game(s) name a team that is not on the season's team list, so they are not in these files."
    );
    expect(omittedGamesNote({ games: 0 })).toBeNull();
    expect(omittedGamesNote(undefined)).toBeNull();
  });
});
