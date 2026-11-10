// @vitest-environment jsdom
//
// What an import leaves for the Games page to show (plan docs/changes/2026-11-03-schedule-expansion.md, PR 6, tasks F6
// and F9), read from what the import WROTE: the every-outcome file of helpers/gameImportWorld.js is applied through the
// real mock client, and the two readers are run over its output (LESSONS_LEARNED 104: run the readers over the writer's
// output). Nothing is forged: the warnings are the run's `results.warnings`, the TIME TBD games are `schedule_tbd`.
//
//   F9  the Games page's banner lists the import's warnings (`games-swapped`, `game-made-time-tbd`, `week-differs`) in
//       words, and draws no list when there is none.
//   F6  the Games page lists a TIME TBD game with its date and no time, beside an undated one that reads as today.
import React from 'react';
import { readFileSync } from 'node:fs';
import { render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FILE_HEADERS,
  FILE_ROWS,
  ORG,
  SEASON,
  TEAMS,
  seedGameImportWorld,
} from './helpers/gameImportWorld.js';
import { seedMockDb } from './helpers/seedMockDb.js';

vi.mock('../frontend/src/lib/supabaseClient.js', async () => {
  const { mockSupabase } = await import('../frontend/src/lib/mockSupabaseClient.js');
  return { supabase: mockSupabase, supabaseReady: Promise.resolve() };
});

const { mockSupabase } = await import('../frontend/src/lib/mockSupabaseClient.js');
const client = await import('../frontend/src/utils/gameImportClient.js');
const core = await import('../packages/core/src/scheduleImport/index.js');
const mapping = await import('../frontend/src/utils/gameImportMapping.js');
const { default: GameConflictBanner, importWarningSubject } =
  await import('../frontend/src/components/scheduling/GameConflictBanner.jsx');
const { default: GameTimeTbdSection, GameTimeTbdList } =
  await import('../frontend/src/components/scheduling/GameTimeTbdList.jsx');

const params = { organizationId: ORG, seasonSettingsId: SEASON };
/** Import a file the way the panel does: stage, map (every match stands, the given choices on top), preview, confirm. */
async function importFile(rows, choices = {}) {
  const started = await client.startGameImport(mockSupabase, {
    ...params,
    fileName: 'schedule.csv',
    headers: FILE_HEADERS,
    rows,
  });
  const staged = await client.readStagedGameRows(mockSupabase, started.jobId);
  const league = await client.readGameImportLeague(mockSupabase, params);
  const proposal = core.proposeScheduleMapping({
    rows: staged,
    league,
    decisions: mapping.decisionsFromChoices(choices),
  });
  await client.saveGameImportMapping(
    mockSupabase,
    started.jobId,
    mapping.mappingForJob(proposal, choices, true)
  );
  const preview = await client.previewGameImport(mockSupabase, started.jobId);
  const outcome = await client.confirmGameImport(mockSupabase, {
    organizationId: ORG,
    jobId: started.jobId,
    confirmed: core.scheduleImportConfirmCounts(preview),
  });
  expect(outcome.status).toBe('applied');
  return outcome.result;
}
/** The warnings of the season's latest game run, as the Games page reads them (`results.warnings`). */
async function savedWarnings() {
  const { data, error } = await mockSupabase
    .from('scheduler_runs')
    .select('*')
    .eq('organization_id', ORG)
    .eq('run_type', 'game');
  expect(error).toBeNull();
  const latest = data
    .slice()
    .sort((a, b) => String(b.completed_at).localeCompare(String(a.completed_at)))[0];
  return latest.results?.warnings ?? [];
}

beforeEach(() => {
  seedGameImportWorld();
});

describe('F9: the Games page lists what an import said, in words', () => {
  it('lists week-differs, game-made-time-tbd and games-swapped from the saved run, each naming its game', async () => {
    // First import: the file as it is (a week that is not the date's), and a second game of one pair (a rematch).
    const rematch = {
      ...FILE_ROWS[2],
      'Game ID': 'N-12',
      Date: '2026-10-31',
      'Start Time': '11:00',
      'End Time': '12:00',
      Field: 'Field 2',
      Week: '8',
    };
    await importFile([...FILE_ROWS, rematch]);
    // Second import, of the SAME season: the two games of that pair trade places (a swap: each moves onto the place
    // the other leaves), and a placed game loses its time.
    const swapped = [...FILE_ROWS, rematch].map((row) => ({ ...row }));
    const n1 = swapped.find((r) => r['Game ID'] === 'N-1');
    const n12 = swapped.find((r) => r['Game ID'] === 'N-12');
    for (const key of ['Date', 'Start Time', 'End Time', 'Field', 'Week']) {
      [n1[key], n12[key]] = [n12[key], n1[key]];
    }
    // the game whose Week is not its date's is changed too (a later start), so the import says its week again
    swapped.find((r) => r['Game ID'] === 'N-10')['Start Time'] = '09:15';
    const n2 = swapped.find((r) => r['Game ID'] === 'N-2');
    n2['Start Time'] = '';
    n2['End Time'] = '';
    // the imported games arrived Published: allow changes to the three the second file changes (the production path)
    const { data: games } = await mockSupabase
      .from('game_assignments')
      .select('*')
      .eq('organization_id', ORG);
    const ids = games
      .filter((g) => ['N-1', 'N-12', 'N-2', 'N-10'].includes(g.external_ref))
      .map((g) => g.id);
    expect(ids).toHaveLength(4);
    const released = await mockSupabase.rpc('admin_set_games_published', {
      p_organization_id: ORG,
      p_assignment_ids: ids,
      p_published: false,
      p_reason_code: 'field-change',
      p_note: null,
      p_scope: { kind: 'selection', value: 'test' },
    });
    expect(released.error).toBeNull();
    const result = await importFile(swapped);
    const types = new Set(result.warnings.map((w) => w.type));
    // the meta-assertion: this world reaches all three (a check over fewer would pass)
    for (const type of ['games-swapped', 'game-made-time-tbd', 'week-differs']) {
      expect(types.has(type), `the second import did not say ${type}`).toBe(true);
    }

    const warnings = await savedWarnings();
    expect(warnings).toEqual(result.warnings);
    render(<GameConflictBanner warnings={warnings} />);
    const list = screen.getByTestId('conflict-list');
    const lineOf = (type) =>
      within(list)
        .getAllByTestId(`conflict-item-${type}`)
        .map((item) => item.textContent);
    // each is a sentence and a label a person reads, naming its game: never the bare code
    expect(lineOf('games-swapped')[0]).toMatch(
      /^Game N-12?: This game takes the place of a game the file moves away: both are written\.Import: swapped$/
    );
    expect(lineOf('game-made-time-tbd')[0]).toMatch(
      /^Game N-2 on 2026-09-26: The file gives this game a date and no time: it is no longer placed, and stands on the TIME TBD list\.Import: now TIME TBD$/
    );
    expect(lineOf('week-differs')[0]).toMatch(
      /^Game N-\d+ on \d{4}-\d{2}-\d{2}: The week is not the week the date falls in\.Import: week$/
    );
    for (const item of within(list).getAllByRole('button')) {
      expect(item.textContent).not.toMatch(/games-swapped|game-made-time-tbd|week-differs/);
    }
  });

  it('draws no list when the run has no warning (CONTROL)', async () => {
    // a file of one clean game
    const result = await importFile([FILE_ROWS[2]]);
    expect(result.warnings).toEqual([]);
    expect(await savedWarnings()).toEqual([]);
    const { container } = render(<GameConflictBanner warnings={await savedWarnings()} />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId('conflict-list')).toBeNull();
  });

  it('holds the three sentences to the database’s own (read from the migration), and names no game for another warning', () => {
    const sql = readFileSync('supabase/migrations/20261121010000_game_import.sql', 'utf8');
    for (const sentence of [
      'This game takes the place of a game the file moves away: both are written.',
      'The file gives this game a date and no time: it is no longer placed, and stands on the TIME TBD list.',
      'The week is not the week the date falls in.',
    ]) {
      expect(sql).toContain(sentence);
    }
    expect(importWarningSubject({ type: 'field-overlap', details: { gameId: 'x' } })).toBe('');
    expect(importWarningSubject({ type: 'week-differs', details: { rowKey: 'row-12' } })).toBe(
      'Row 12 of the file: '
    );
    expect(importWarningSubject({ type: 'week-differs', details: {} })).toBe('');
  });
});

describe('F6: the Games page lists a TIME TBD game with its date and no time', () => {
  it('a dated game from the import beside an undated one the scheduler could not place', async () => {
    await importFile(FILE_ROWS);
    // An undated TIME TBD game. The production writer of one is the game save (`persist_game_schedule` records the
    // scheduler's unplaced games); the mock's game save does not model that table, so the row cannot be produced by
    // a call here. It is seeded in EXACTLY the shape the save inserts, and that is checked against the save's own
    // text below: the columns it writes, `kind` 'game', and no `game_date` (only an import gives one).
    const save = readFileSync('supabase/migrations/20261120010000_game_identity.sql', 'utf8');
    const insert =
      /INSERT INTO public\.schedule_tbd \(\s*([a-z_,\s]+?)\s*\)\s*SELECT DISTINCT ON \(u\.h, u\.a, u\.wk\)\s*v_org_id, v_season_id, 'game'/.exec(
        save
      );
    expect(insert).not.toBeNull();
    const savedColumns = insert[1].split(',').map((c) => c.trim());
    expect(savedColumns).toEqual([
      'organization_id',
      'season_settings_id',
      'kind',
      'division_id',
      'home_team_id',
      'away_team_id',
      'week_index',
      'reason',
      'detail',
      'run_id',
    ]);
    const undatedRow = {
      organization_id: ORG,
      season_settings_id: SEASON,
      kind: 'game',
      division_id: '0a000000-0000-4000-8000-000000000010',
      home_team_id: TEAMS.t1,
      away_team_id: TEAMS.t6,
      week_index: 9,
      reason: 'no-slot-available',
      detail: { division: 'U05 Boys' },
      run_id: null,
    };
    // the seeded row carries the save's columns and nothing else of its own (the id and timestamp are the table's)
    expect(Object.keys(undatedRow)).toEqual(savedColumns);
    expect(savedColumns).not.toContain('game_date');
    seedMockDb({
      schedule_tbd: [
        {
          id: '0a000000-0000-4000-8000-0000000000f1',
          created_at: '2026-09-02T00:00:00Z',
          ...undatedRow,
        },
      ],
    });
    delete window.__MOCK_DB__;
    render(<GameTimeTbdSection seasonSettingsId={SEASON} enabled />);
    const list = await screen.findByTestId('game-time-tbd-list');
    expect(within(list).getByRole('heading').textContent).toBe('TIME TBD games (3)');
    const items = within(list).getAllByTestId('game-time-tbd-item');
    const dated = items
      .filter((li) => li.getAttribute('data-dated') === 'yes')
      .map((li) => li.textContent);
    const undated = items
      .filter((li) => li.getAttribute('data-dated') === 'no')
      .map((li) => li.textContent);
    // the import's two: the one with no time, and the one whose time could not be read (F5), each on its date
    expect(dated.sort()).toEqual([
      'U05 Boys: U05B Team 03 v U05B Team 05. 2026-10-10, no time yet (week 5). the imported file gave it no time or no field.',
      'U05 Boys: U05B Team 04 v U05B Team 06. 2026-10-17, no time yet (week 6). the imported file gave it no time or no field.',
    ]);
    // no clock time anywhere in a dated entry
    for (const line of dated) expect(line).not.toMatch(/\d{1,2}:\d{2}/);
    // CONTROL: the undated game reads with its week and reason, and no date
    expect(undated).toEqual([
      'U05 Boys: U05B Team 01 v U05B Team 06. No date yet (week 9). no game slot was free for it.',
    ]);
  });

  it('draws nothing with no TIME TBD game, nothing for someone who may not read the list, and says a failed read', async () => {
    const none = render(<GameTimeTbdSection seasonSettingsId={SEASON} enabled />);
    await waitFor(() => expect(none.container.firstChild).toBeNull());
    none.unmount();
    await importFile(FILE_ROWS);
    const closed = render(<GameTimeTbdSection seasonSettingsId={SEASON} enabled={false} />);
    expect(closed.container.firstChild).toBeNull();
    closed.unmount();
    render(<GameTimeTbdList rows={[]} error="permission denied" />);
    expect(screen.getByRole('alert').textContent).toBe(
      'The TIME TBD games could not be read: permission denied'
    );
  });

  it('draws nothing, and no alert, when the list is not this person’s to read (42501); any other failure is said', async () => {
    await importFile(FILE_ROWS);
    // a season the database does not hold reads as "not yours" (the RPC's 42501)
    const denied = render(
      <GameTimeTbdSection seasonSettingsId="0a000000-0000-4000-8000-00000000beef" enabled />
    );
    await waitFor(async () => {
      const { error } = await mockSupabase.rpc('get_schedule_tbd', {
        p_season_settings_id: '0a000000-0000-4000-8000-00000000beef',
      });
      expect(error.code).toBe('42501');
    });
    expect(denied.container.firstChild).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    denied.unmount();
    // CONTROL: a failure that is not a refusal is an alert
    const broken = {
      rpc: async () => ({ data: null, error: { code: 'XX000', message: 'the database is away' } }),
    };
    render(<GameTimeTbdSection seasonSettingsId={SEASON} enabled supabaseClient={broken} />);
    expect((await screen.findByRole('alert')).textContent).toBe(
      'The TIME TBD games could not be read: the database is away'
    );
  });

  it('says so when a listed game also has a game on the grid in its week (open item (a)), and never hides it', async () => {
    await importFile(FILE_ROWS);
    render(
      <GameTimeTbdSection
        seasonSettingsId={SEASON}
        enabled
        placed={[{ homeTeamId: TEAMS.t4, awayTeamId: TEAMS.t6, weekIndex: 6 }]}
      />
    );
    const list = await screen.findByTestId('game-time-tbd-list');
    const items = within(list).getAllByTestId('game-time-tbd-item');
    expect(items).toHaveLength(2);
    const flagged = items.filter((li) => /also have a game on the grid/.test(li.textContent));
    expect(flagged).toHaveLength(1);
    expect(flagged[0].textContent).toMatch(/U05B Team 04 v U05B Team 06/);
  });
});
