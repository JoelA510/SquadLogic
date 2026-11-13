// @vitest-environment jsdom
/**
 * Readers over the writers' output (F11-3; lessons 104 and 106: the bugs a change to a schedule's storage leaves are
 * in the readers of what the writers write). After every write path of the mock database (a save, a save that moves
 * a game, a score entered and cleared, a cancel, an import applied and rolled back) every reader F11-3 repointed is
 * run, and each must show exactly the games of the season's current run and exactly the scores that stand: no more
 * (a row left in an older run), no fewer, at the game's own times.
 *
 * - **The readers are found by scan**: every product file that calls a reader of `utils/savedGamesClient.js` must be
 *   in {@link READERS} with the function it calls, and each function is run below.
 * - **The oracle is not a reader**: the expected games are computed from the raw tables (the season's game runs, the
 *   latest completed one, its rows; the score rows), not through `current_game_runs` or any select under test.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as world from './helpers/savedScheduleWorld.js';
import * as importWorld from './helpers/gameImportWorld.js';
import { relationColumns } from './helpers/sqlColumns.js';

vi.mock('../frontend/src/lib/supabaseClient.js', async () => {
  const { mockSupabase } = await import('../frontend/src/lib/mockSupabaseClient.js');
  return { supabase: mockSupabase };
});
vi.mock('../frontend/src/lib/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const { mockSupabase } = await import('../frontend/src/lib/mockSupabaseClient.js');
const { fetchCurrentGameRunIds, fetchCurrentSavedGames, fetchSavedGames, fetchTeamSavedGames } =
  await import('../frontend/src/utils/savedGamesClient.js');
const { fetchTeamEvents } = await import('../frontend/src/hooks/useTeamPortal.js');
const { confirmPreview, stageMapPreview } = await import('./helpers/gameImportFlow.js');
const { rollbackGameImport } = await import('../frontend/src/utils/gameImportClient.js');
const { composeTeamFeed } = await import('../supabase/functions/_shared/calendar/teamFeed.ts');

/** Every product file that reads the saved schedule, and the reader it calls. */
const READERS = {
  'frontend/src/hooks/useTeamPortal.js': 'fetchTeamSavedGames',
  'frontend/src/pages/DashboardPage.jsx': 'fetchCurrentSavedGames',
  'frontend/src/pages/LeagueStandings.jsx': 'fetchCurrentSavedGames',
  'frontend/src/pages/PlayerRecordPage.jsx': 'fetchTeamSavedGames',
  'frontend/src/pages/ScoresPage.jsx': 'fetchSavedGames',
};

/** The raw tables, by plain reads of whole tables (no embed, no view: nothing a reader under test uses). */
async function db() {
  const out = {};
  for (const table of ['scheduler_runs', 'game_assignments', 'game_scores']) {
    const { data, error } = await mockSupabase.from(table).select('*');
    if (error) throw error;
    out[table] = data;
  }
  return out;
}
const key = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The schedule of a season, from the raw tables: the rows of its latest completed game run, with their scores. */
async function oracle(org, season) {
  const raw = await db();
  const runs = (raw.scheduler_runs || [])
    .filter(
      (run) =>
        run.organization_id === org &&
        run.run_type === 'game' &&
        run.status === 'completed' &&
        (run.season_settings_id === season || run.season_id === season)
    )
    .sort((a, b) => key(b.completed_at, a.completed_at) || key(b.created_at, a.created_at));
  if (runs.length === 0) return [];
  return (raw.game_assignments || [])
    .filter((game) => game.run_id === runs[0].id)
    .map((game) => {
      const scored = (raw.game_scores || []).find((s) => s.game_id === game.id);
      return {
        id: game.id,
        home: game.home_team_id,
        away: game.away_team_id,
        start: game.start,
        end: game.end,
        score: scored ? [scored.score_home, scored.score_away] : [null, null],
      };
    })
    .sort((a, b) => key(a.id, b.id));
}
const shown = (rows) =>
  rows
    .map((game) => ({
      id: game.id,
      home: game.home_team_id,
      away: game.away_team_id,
      start: game.start,
      end: game.end,
      score: [game.score_home, game.score_away],
    }))
    .sort((a, b) => key(a.id, b.id));

/** Run every reader and hold it to the oracle. Returns how many games the schedule holds. */
async function readersAgree(org, season, teams, timeZone) {
  const expected = await oracle(org, season);
  expect(shown(await fetchCurrentSavedGames({ organizationId: org, seasonId: season }))).toEqual(
    expected
  );
  // The Scores page asks for the run first and then its games.
  const runIds = await fetchCurrentGameRunIds({ organizationId: org, seasonId: season });
  expect(shown(await fetchSavedGames({ runIds }))).toEqual(expected);
  for (const team of teams) {
    const mine = expected.filter((game) => game.home === team || game.away === team);
    expect(shown(await fetchTeamSavedGames(team)), `team ${team}`).toEqual(mine);
    const events = (await fetchTeamEvents(team, timeZone)).events.filter((e) => e.type === 'game');
    expect(events.map((event) => event.id).sort(), `team page ${team}`).toEqual(
      mine.map((game) => game.id)
    );
  }
  return expected.length;
}

describe('the readers are found by scan and each is run', () => {
  const SRC = path.join(process.cwd(), 'frontend/src');
  const walk = (dir) =>
    readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      return statSync(full).isDirectory() ? walk(full) : /\.(js|jsx)$/.test(name) ? [full] : [];
    });
  const CALL = /\b(fetchCurrentSavedGames|fetchTeamSavedGames|fetchSavedGames)\(/g;

  it('every caller of a saved-schedule reader is listed with the reader it calls', () => {
    const found = {};
    for (const file of walk(SRC)) {
      const rel = path.relative(process.cwd(), file);
      if (rel.endsWith('utils/savedGamesClient.js')) continue;
      const calls = [...new Set([...readFileSync(file, 'utf8').matchAll(CALL)].map((m) => m[1]))];
      if (calls.length > 0) found[rel] = calls.join(',');
    }
    expect(found).toEqual(READERS);
    // Each reader named above is one this file runs (`readersAgree`).
    expect([...new Set(Object.values(READERS))].sort()).toEqual([
      'fetchCurrentSavedGames',
      'fetchSavedGames',
      'fetchTeamSavedGames',
    ]);
  });
});

describe('after every write of the game save and the score entry', () => {
  const { ORG, SEASON, TEAMS, TZ, assignment, save, score, gameId } = world;
  const teams = Object.values(TEAMS);
  beforeEach(() => world.seedLeague());

  it('nothing saved, a save, a second save that moves and drops, a score, a clear, a cancel', async () => {
    expect(await readersAgree(ORG, SEASON, teams, TZ)).toBe(0);

    const first = await save([
      assignment('comets', 'rockets', 'slot-1'),
      assignment('meteors', 'planets', 'slot-2'),
      assignment('comets', 'meteors', 'slot-4', { week: 2, minutes: 90 }),
    ]);
    expect(await readersAgree(ORG, SEASON, teams, TZ)).toBe(3);

    // A score, entered through the real RPC, is the score every reader shows.
    const scored = await gameId(first, 'comets', 'rockets');
    await score(scored, 3, 1);
    expect(await readersAgree(ORG, SEASON, teams, TZ)).toBe(3);
    expect((await oracle(ORG, SEASON)).find((game) => game.id === scored).score).toEqual([3, 1]);

    // A second save: the scored game is carried by its id, one game is moved in place, one is placed again without
    // its id (its earlier row stays behind in the earlier run, hidden).
    const moved = await gameId(first, 'meteors', 'planets');
    await save([
      assignment('comets', 'rockets', 'slot-1', { id: scored }),
      assignment('meteors', 'planets', 'slot-5', { id: moved, week: 2 }),
      assignment('comets', 'meteors', 'slot-6', { week: 2 }),
    ]);
    expect(await readersAgree(ORG, SEASON, teams, TZ)).toBe(3);
    // The control that the case is real: the table holds a row no reader may show.
    expect((await db()).game_assignments.length).toBe(4);

    await score(scored, null, null);
    expect(await readersAgree(ORG, SEASON, teams, TZ)).toBe(3);
    expect((await db()).game_scores).toEqual([]);

    const cancelled = await mockSupabase.rpc('admin_cancel_game_assignment', {
      p_assignment_id: moved,
      p_organization_id: ORG,
    });
    expect(cancelled.error).toBeNull();
    expect(await readersAgree(ORG, SEASON, teams, TZ)).toBe(2);
  });
});

describe('after an import is applied and rolled back', () => {
  const { ORG, SEASON, TEAMS, SEASON_ROW, FILE_HEADERS, FILE_ROWS } = importWorld;
  const teams = Object.values(TEAMS);

  it('the readers show the import’s games, and after the rollback the schedule it replaced', async () => {
    importWorld.seedGameImportWorld();
    const tz = SEASON_ROW.timezone;
    const before = await oracle(ORG, SEASON);
    expect(await readersAgree(ORG, SEASON, teams, tz)).toBe(before.length);
    expect(before.length).toBe(3);

    // Rows 1 to 4 of the file: a game updated in place, a Published one skipped, two inserted.
    const staged = await stageMapPreview(mockSupabase, {
      organizationId: ORG,
      seasonSettingsId: SEASON,
      headers: FILE_HEADERS,
      rows: FILE_ROWS.slice(0, 4),
    });
    const applied = await confirmPreview(mockSupabase, { organizationId: ORG, ...staged });
    expect(applied.status).toBe('applied');
    expect(await readersAgree(ORG, SEASON, teams, tz)).toBeGreaterThan(before.length);

    await rollbackGameImport(mockSupabase, {
      jobId: staged.jobId,
      organizationId: ORG,
      seasonSettingsId: SEASON,
    });
    expect(await readersAgree(ORG, SEASON, teams, tz)).toBe(before.length);
    expect((await oracle(ORG, SEASON)).map((game) => [game.id, game.start, game.end])).toEqual(
      before.map((game) => [game.id, game.start, game.end])
    );
  });
});

describe("the rows the mock's writers store are the tables' rows (lessons 104 and 108)", () => {
  it('a saved game and its score have only the columns of game_assignments and game_scores', async () => {
    const { ORG, SEASON, assignment, save, score, gameId } = world;
    world.seedLeague();
    const run = await save([assignment('comets', 'rockets', 'slot-1')]);
    await score(await gameId(run, 'comets', 'rockets'), 1, 1);
    const columns = relationColumns();
    const raw = await db();
    const extra = (table, rows) =>
      [...new Set(rows.flatMap((row) => Object.keys(row)))].filter(
        (key) => !columns.get(table).includes(key)
      );
    expect(raw.game_assignments.length).toBe(1);
    expect(extra('game_assignments', raw.game_assignments)).toEqual([]);
    expect(extra('game_scores', raw.game_scores)).toEqual([]);
    expect(raw.game_assignments[0]).toMatchObject({
      organization_id: ORG,
      season_settings_id: SEASON,
    });
  });
});

describe('the team page and the feed show the same games (F11-3 review R6, R8)', () => {
  const { ORG, SEASON, TEAMS, TZ, DIVISION, assignment, save } = world;

  /** The feed's games of a team, as the Edge function reads them (the team's season is its division's). */
  async function feedGames(teamId) {
    const { data: team } = await mockSupabase.from('teams').select('*').eq('id', teamId).single();
    const { data: division } = await mockSupabase
      .from('divisions')
      .select('*')
      .eq('id', team.division_id)
      .single();
    const { events, readFailures } = await composeTeamFeed({
      client: mockSupabase,
      team: {
        id: team.id,
        name: team.name,
        organization_id: team.organization_id,
        season_settings_id: division?.season_settings_id ?? null,
      },
      orgName: 'Synthetic FC',
      now: new Date('2026-09-01T00:00:00Z'),
      log: () => {},
    });
    expect(readFailures).toEqual([]);
    return events
      .filter((event) => event.title?.startsWith('Game'))
      .map((event) => [event.uid, event.dtstart ?? null, event.dtend ?? null])
      .sort();
  }
  /** The team page's games of a team, as instants in the feed's spelling. */
  async function pageGames(teamId) {
    const { rows } = await fetchTeamEvents(teamId, TZ);
    const ics = (iso) =>
      iso
        ? new Date(iso)
            .toISOString()
            .replace(/[-:]/g, '')
            .replace(/\.\d{3}/, '')
        : null;
    return rows.games.map((game) => [game.id, ics(game.start), ics(game.end)]).sort();
  }

  beforeEach(() => world.seedLeague());

  it('the same games at the same instants, a long game included', async () => {
    await save([
      assignment('comets', 'rockets', 'slot-1', { minutes: 90 }),
      assignment('meteors', 'comets', 'slot-4', { week: 2 }),
    ]);
    for (const team of Object.values(TEAMS)) {
      expect(await pageGames(team), team).toEqual(await feedGames(team));
    }
    expect((await pageGames(TEAMS.comets)).length).toBe(2);
  });

  it('a division moved to another season: both show that season’s schedule, which has none', async () => {
    await save([assignment('comets', 'rockets', 'slot-1')]);
    const db = JSON.parse(sessionStorage.getItem('__MOCK_DB__'));
    db.season_settings.push({
      id: 'season-next',
      organization_id: ORG,
      status: 'draft',
      timezone: TZ,
    });
    db.divisions = db.divisions.map((d) =>
      d.id === DIVISION ? { ...d, season_settings_id: 'season-next' } : d
    );
    sessionStorage.setItem('__MOCK_DB__', JSON.stringify(db));
    if (window.__MOCK_DB__) window.__MOCK_DB__ = db;
    expect(await feedGames(TEAMS.comets)).toEqual([]);
    expect(await pageGames(TEAMS.comets)).toEqual([]);
    expect(SEASON).toBeTruthy();
  });
});
