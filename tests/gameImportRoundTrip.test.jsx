// @vitest-environment jsdom
//
// G3 (plan docs/changes/2026-11-03-schedule-expansion.md 5.4; PR 6): the SquadLogic schedule CSV. A file exported
// here imports here, so the round trip is the import's idempotency test: the shipped fixture (574 games, outside
// clubs, a game with no time) is imported through the real mock client, the SAVED schedule is exported, and the
// export is imported again as a dry run: ZERO changes. A cancelled game and a TIME TBD game each have a case, and a
// control shows the test can fail (one edited cell is one change).
import Papa from 'papaparse';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FILE_HEADERS,
  FILE_ROWS,
  ORG,
  SAVED,
  SEASON,
  SEASON_ROW,
  seedGameImportWorld,
} from './helpers/gameImportWorld.js';
import { seedMockDb } from './helpers/seedMockDb.js';
import { loadScheduleFixture, outsideDecisionsFor } from './helpers/scheduleFixtureLoad.js';

vi.mock('../frontend/src/lib/supabaseClient.js', async () => {
  const { mockSupabase } = await import('../frontend/src/lib/mockSupabaseClient.js');
  return { supabase: mockSupabase, supabaseReady: Promise.resolve() };
});

const { mockSupabase } = await import('../frontend/src/lib/mockSupabaseClient.js');
const { confirmPreview, stageMapPreview } = await import('./helpers/gameImportFlow.js');
const { readSavedScheduleCsv } = await import('../frontend/src/utils/gameImportClient.js');
const core = await import('../packages/core/src/scheduleImport/index.js');

const params = { organizationId: ORG, seasonSettingsId: SEASON };
const parseCsv = (csv) => {
  const { data, meta, errors } = Papa.parse(csv, { header: true, skipEmptyLines: true });
  expect(errors).toEqual([]);
  return { headers: meta.fields, rows: data };
};
/** What a dry run must say when the file changes nothing. */
function expectZeroChanges(preview, { games, tbd }) {
  expect(preview.dry_run).toBe(true);
  expect(preview.nothing_to_apply).toBe(true);
  expect(preview.games).toMatchObject({ inserted: 0, updated: 0, unchanged: games, skipped: {} });
  expect(preview.time_tbd).toEqual({
    inserted: 0,
    updated: 0,
    unchanged: tbd,
    removed: 0,
    converted: 0,
  });
  expect(preview.created).toEqual({
    divisions: 0,
    venues: 0,
    fields: 0,
    teams: 0,
    outside_teams: 0,
    slots: 0,
  });
  expect(preview.rows).toMatchObject({ refused: 0, skipped: 0, games, time_tbd: tbd });
  expect(preview.refused_by_reason).toEqual({});
  expect(preview.not_in_file.count).toBe(0);
}
const CHOICES = {
  divisions: { [core.divisionDecisionKey('U07 Girls')]: 'create' },
  fields: { [core.fieldDecisionKey('Venue A', 'Field 9')]: 'create' },
  teams: {
    [core.teamDecisionKey('U05 Boys', 'Visiting Club A')]: 'outside',
    [core.teamDecisionKey('U05 Boys', 'Mystery Team')]: 'outside',
    [core.teamDecisionKey('U07 Girls', 'U07G Team 01')]: 'create',
    [core.teamDecisionKey('U07 Girls', 'U07G Team 02')]: 'create',
  },
};

describe('the shipped fixture: imported, exported, imported again as a dry run', () => {
  const U = (n) => `0f000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const fixture = loadScheduleFixture();

  beforeEach(() => {
    sessionStorage.clear();
    delete window.__MOCK_DB__;
    // The league the fixture's schedule is over, as tables (ids stand in for the uuids a database gives).
    const ids = new Map();
    let next = 0;
    const idOf = (key) => {
      if (!ids.has(key)) ids.set(key, U(++next));
      return ids.get(key);
    };
    seedMockDb({
      organizations: [{ id: ORG, name: 'Placeholder League', is_onboarded: true }],
      organization_members: [{ organization_id: ORG, profile_id: U(900001), role: 'admin' }],
      season_settings: [
        {
          ...SEASON_ROW,
          ...{
            season_start: fixture.season.startDate,
            season_end: fixture.season.endDate,
            timezone: fixture.season.timeZone,
          },
        },
      ],
      divisions: fixture.league.divisions.map((d) => ({
        id: idOf(d.id),
        organization_id: ORG,
        season_settings_id: SEASON,
        name: d.name,
      })),
      teams: fixture.league.teams.map((t) => ({
        id: idOf(t.id),
        organization_id: ORG,
        division_id: idOf(t.divisionId),
        name: t.name,
        is_external: false,
      })),
      locations: fixture.league.venues.map((v) => ({
        id: idOf(v.id),
        organization_id: ORG,
        name: v.name,
      })),
      fields: fixture.league.fields.map((f) => ({
        id: idOf(f.id),
        organization_id: ORG,
        location_id: idOf(f.venueId),
        name: f.name,
      })),
      game_slots: [],
      scheduler_runs: [],
      game_assignments: [],
      schedule_tbd: [],
      staging_import_rows: [],
      import_jobs: [],
      import_application_records: [],
      audit_log: [],
    });
    sessionStorage.setItem('__MOCK_SESSION__', JSON.stringify({ user: { id: U(900001) } }));
  });

  it('exports the imported schedule and re-imports it: zero changes', async () => {
    // every label no own team carries is an outside club (the file cannot say so; the admin does)
    const outside = outsideDecisionsFor
      ? Object.fromEntries(
          Object.keys(
            outsideDecisionsFor(
              core.proposeScheduleMapping({
                rows: core.parseScheduleRows({
                  headers: fixture.schedule.headers,
                  rows: fixture.schedule.rows,
                  season: fixture.season,
                }).rows,
                league: fixture.league,
              })
            ).teams
          ).map((key) => [key, 'outside'])
        )
      : {};
    const first = await stageMapPreview(mockSupabase, {
      ...params,
      headers: fixture.schedule.headers,
      rows: fixture.schedule.rows,
      choices: { teams: outside },
    });
    expect(first.preview.rows.refused).toBe(0);
    expect(first.preview.created.outside_teams).toBeGreaterThan(20);
    const applied = await confirmPreview(mockSupabase, { organizationId: ORG, ...first });
    expect(applied.status).toBe('applied');
    const games = applied.result.games.inserted;
    const tbd = applied.result.time_tbd.inserted;
    expect(games + tbd).toBe(fixture.schedule.rows.length);
    expect(games).toBeGreaterThan(500);
    expect(tbd).toBeGreaterThanOrEqual(1);

    const exported = await readSavedScheduleCsv(mockSupabase, params);
    expect(exported.omitted).toEqual({ noPlace: 0, unknownRecord: 0, undatedTbd: 0 });
    expect(exported.rows).toHaveLength(fixture.schedule.rows.length);
    expect(exported.headers).toEqual([...core.SCHEDULE_IMPORT_TEMPLATE_HEADER]);
    const file = parseCsv(exported.csv);
    expect(file.rows).toHaveLength(fixture.schedule.rows.length);

    // no choice is made: every name in the export is the name of exactly one saved record
    const again = await stageMapPreview(mockSupabase, {
      ...params,
      ...file,
      fileName: 'export.csv',
    });
    expect(again.summary).toMatchObject({ refused: 0, warnings: [] });
    for (const group of ['divisions', 'venues', 'fields', 'teams']) {
      expect(again.proposal[group].filter((e) => e.status !== 'match')).toEqual([]);
    }
    expectZeroChanges(again.preview, { games, tbd });
  }, 60000);
});

describe('the every-outcome league: a cancelled game, a TIME TBD game, and a control that can fail', () => {
  let games;
  let tbd;
  beforeEach(async () => {
    seedGameImportWorld();
    const first = await stageMapPreview(mockSupabase, {
      ...params,
      headers: FILE_HEADERS,
      rows: FILE_ROWS,
      choices: CHOICES,
    });
    const applied = await confirmPreview(mockSupabase, { organizationId: ORG, ...first });
    expect(applied.status).toBe('applied');
    // the whole saved schedule: what the file added and changed, and what it carried
    games =
      applied.result.games.inserted + applied.result.games.updated + applied.result.games.repointed;
    tbd = applied.result.time_tbd.inserted;
  });

  it('a TIME TBD game is exported with its date and no time, and reads back as the same game', async () => {
    const exported = await readSavedScheduleCsv(mockSupabase, params);
    const untimed = exported.rows.filter((row) => row['Start Time'] === '');
    expect(untimed).toHaveLength(tbd);
    expect(tbd).toBe(2);
    for (const row of untimed) {
      expect(row.Date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect([row['End Time'], row.Venue, row.Field]).toEqual(['', '', '']);
    }
    expect(exported.rows).toHaveLength(games + tbd);
    const again = await stageMapPreview(mockSupabase, {
      ...params,
      ...parseCsv(exported.csv),
      fileName: 'export.csv',
    });
    expectZeroChanges(again.preview, { games, tbd });
  });

  it('a cancelled game is not in the export, and the re-import does not bring it back', async () => {
    const cancelled = await mockSupabase.rpc('admin_cancel_game_assignment', {
      p_assignment_id: SAVED.untouched,
    });
    expect(cancelled.error).toBeNull();
    const exported = await readSavedScheduleCsv(mockSupabase, params);
    expect(exported.rows).toHaveLength(games + tbd - 1);
    expect(exported.rows.some((row) => row['Game ID'] === 'S-3')).toBe(false);
    const again = await stageMapPreview(mockSupabase, {
      ...params,
      ...parseCsv(exported.csv),
      fileName: 'export.csv',
    });
    expectZeroChanges(again.preview, { games: games - 1, tbd });
    expect(again.preview.games.inserted).toBe(0);
  });

  it('CONTROL: one edited cell of the export is one change (the round trip can fail)', async () => {
    const exported = await readSavedScheduleCsv(mockSupabase, params);
    const file = parseCsv(exported.csv);
    // the saved game no import wrote (not Published): half an hour later
    const row = file.rows.find((r) => r['Game ID'] === 'S-3');
    expect(row['Start Time']).toBe('08:00');
    row['Start Time'] = '08:30';
    row['End Time'] = '09:30';
    const again = await stageMapPreview(mockSupabase, {
      ...params,
      ...file,
      fileName: 'edited.csv',
    });
    expect(again.preview.nothing_to_apply).toBe(false);
    expect(again.preview.games).toMatchObject({ inserted: 0, updated: 1, unchanged: games - 1 });
  });

  it('says what it cannot write, and writes no half row: an undated TIME TBD game, a game with no place', () => {
    const base = {
      slots: [
        {
          id: 's1',
          date: '2026-09-12',
          startTime: '09:00:00',
          endTime: '10:00:00',
          fieldId: 'f1',
          weekIndex: 1,
        },
      ],
      teams: [
        { id: 'a', name: 'Team A', division: 'U10' },
        { id: 'b', name: 'Team B', division: 'U10' },
      ],
      fields: [{ id: 'f1', name: 'Field 1', venueId: 'v1' }],
      venues: [{ id: 'v1', name: 'Venue A' }],
    };
    const built = core.buildScheduleCsv({
      ...base,
      games: [
        {
          id: 'g1',
          externalRef: 'G-1',
          gameSlotId: 's1',
          fieldId: 'f1',
          homeTeamId: 'a',
          awayTeamId: 'b',
          division: 'U10',
          weekIndex: 1,
        },
        {
          id: 'g2',
          externalRef: 'G-2',
          gameSlotId: 'gone',
          fieldId: 'f1',
          homeTeamId: 'a',
          awayTeamId: 'b',
          division: 'U10',
          weekIndex: 2,
        },
        {
          id: 'g3',
          externalRef: 'G-3',
          gameSlotId: 's1',
          fieldId: 'f1',
          homeTeamId: 'a',
          awayTeamId: 'nobody',
          division: 'U10',
          weekIndex: 1,
        },
      ],
      tbdGames: [
        {
          externalRef: 'T-1',
          gameDate: '2026-09-19',
          weekIndex: 2,
          homeTeamId: 'b',
          awayTeamId: 'a',
          division: 'U10',
        },
        {
          externalRef: null,
          gameDate: null,
          weekIndex: 3,
          homeTeamId: 'a',
          awayTeamId: 'b',
          division: 'U10',
        },
      ],
    });
    expect(built.omitted).toEqual({ noPlace: 1, unknownRecord: 1, undatedTbd: 1 });
    expect(built.rows.map((r) => r['Game ID'])).toEqual(['G-1', 'T-1']);
    expect(built.rows[0]).toMatchObject({
      'Start Time': '09:00',
      'End Time': '10:00',
      Venue: 'Venue A',
      Week: '1',
    });
    expect(built.csv.split('\n')).toHaveLength(3);
    expect(() => core.buildScheduleCsv({ ...base, games: null })).toThrow(/games must be an array/);
  });
});
