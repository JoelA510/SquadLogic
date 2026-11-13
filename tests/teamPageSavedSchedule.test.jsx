/**
 * F11-3 task C1 (docs/changes/2026-11-06-games-table-source-of-truth.md): the team page and the per-team files read
 * the SAVED schedule. The league is saved through the real save of the mock database; `fetchTeamEvents`, the one read
 * the team page, the coach-less exports and the calendar download share, is run over what the save wrote.
 *
 * Also E2 (schedule expansion, PR 6 follow-up 2): a game is shown at its OWN start and end, read on the season's
 * clock, not at its slot's.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { teamScheduleRows } from '../packages/core/src/teamScheduleExport.js';
import { feedRowsOf, teamCalendarIcs } from '../frontend/src/utils/scheduleDownloads.js';
import {
  TEAMS,
  TEAM_NAMES,
  TZ,
  assignment,
  gameId,
  save,
  score,
  seedLeague,
} from './helpers/savedScheduleWorld.js';

vi.mock('../frontend/src/lib/supabaseClient.js', async () => {
  const { mockSupabase } = await import('../frontend/src/lib/mockSupabaseClient.js');
  return { supabase: mockSupabase };
});
vi.mock('../frontend/src/lib/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const { fetchTeamEvents } = await import('../frontend/src/hooks/useTeamPortal.js');
const games = (result) => result.events.filter((event) => event.type === 'game');

beforeEach(() => seedLeague());

describe('the team page reads the saved schedule', () => {
  it('shows nothing for a league with no saved schedule, and its games once one is saved', async () => {
    expect(games(await fetchTeamEvents(TEAMS.comets, TZ))).toEqual([]);
    await save([
      assignment('comets', 'rockets', 'slot-1'),
      assignment('meteors', 'planets', 'slot-2'),
    ]);
    const mine = games(await fetchTeamEvents(TEAMS.comets, TZ));
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      type: 'game',
      date: '2026-10-03',
      startTime: '09:00:00',
      endTime: '10:00:00',
      location: 'Example Park - North Pitch',
      homeTeam: TEAM_NAMES.comets,
      awayTeam: TEAM_NAMES.rockets,
      opponent: TEAM_NAMES.rockets,
      role: 'Home',
      hasSlot: true,
    });
    // A team that plays in neither game sees none of them... there is none here; the other game's sides see theirs.
    expect(games(await fetchTeamEvents(TEAMS.planets, TZ)).map((g) => g.role)).toEqual(['Away']);
  });

  it('a team in two games sees two, in order, home and away', async () => {
    await save([
      assignment('comets', 'rockets', 'slot-4', { week: 2 }),
      assignment('meteors', 'comets', 'slot-1'),
      assignment('rockets', 'planets', 'slot-2'),
    ]);
    const mine = games(await fetchTeamEvents(TEAMS.comets, TZ));
    expect(mine.map((g) => [g.date, g.role, g.opponent])).toEqual([
      ['2026-10-03', 'Away', TEAM_NAMES.meteors],
      ['2026-10-10', 'Home', TEAM_NAMES.rockets],
    ]);
  });

  it('a game moved by a later save appears once, at its new time (only the current run is the schedule)', async () => {
    await save([assignment('comets', 'rockets', 'slot-1')]);
    // A save that does not carry the game's id places the pair again; the earlier row stays in the earlier run.
    await save([assignment('comets', 'rockets', 'slot-6', { week: 2 })]);
    const mine = games(await fetchTeamEvents(TEAMS.comets, TZ));
    expect(mine.map((g) => [g.date, g.startTime, g.location])).toEqual([
      ['2026-10-10', '13:00:00', 'Example Park - South Pitch'],
    ]);
  });

  it('a game moved in place (by its id) appears once, at its new time', async () => {
    const run = await save([assignment('comets', 'rockets', 'slot-1')]);
    const id = await gameId(run, 'comets', 'rockets');
    await save([assignment('comets', 'rockets', 'slot-5', { id, week: 2 })]);
    const mine = games(await fetchTeamEvents(TEAMS.comets, TZ));
    expect(mine.map((g) => [g.id, g.date, g.startTime])).toEqual([[id, '2026-10-10', '09:00:00']]);
  });

  it('E2: a game is shown at its own start and end, not its slot’s (an imported game can end later)', async () => {
    // The slot is 09:00 to 10:00; the game runs 90 minutes.
    await save([assignment('comets', 'rockets', 'slot-1', { minutes: 90 })]);
    const [game] = games(await fetchTeamEvents(TEAMS.comets, TZ));
    expect([game.startTime, game.endTime]).toEqual(['09:00:00', '10:30:00']);
  });

  it('E2: with no season clock the slot’s wall reading stands in, and nothing is invented', async () => {
    await save([assignment('comets', 'rockets', 'slot-1', { minutes: 90 })]);
    const [game] = games(await fetchTeamEvents(TEAMS.comets, null));
    expect([game.date, game.startTime, game.endTime]).toEqual([
      '2026-10-03',
      '09:00:00',
      '10:00:00',
    ]);
  });

  it('a scored game is still one game on the team page (the score is not a second row)', async () => {
    const run = await save([assignment('comets', 'rockets', 'slot-1')]);
    await score(await gameId(run, 'comets', 'rockets'), 2, 1);
    expect(games(await fetchTeamEvents(TEAMS.comets, TZ))).toHaveLength(1);
  });
});

describe('the per-team files follow', () => {
  it('the CSV and XLSX rows carry the saved games, at their own times', async () => {
    await save([
      assignment('comets', 'rockets', 'slot-1', { minutes: 90 }),
      assignment('meteors', 'comets', 'slot-4', { week: 2 }),
    ]);
    const { events } = await fetchTeamEvents(TEAMS.comets, TZ);
    const rows = teamScheduleRows([
      { team: { id: TEAMS.comets, name: TEAM_NAMES.comets }, timeZone: TZ, events },
    ]);
    expect(
      rows.map((row) => [row['Event Type'], row.Opponent, row.Date, row.Start, row.End])
    ).toEqual([
      ['Game', TEAM_NAMES.rockets, '2026-10-03', '09:00', '10:30'],
      ['Game', TEAM_NAMES.meteors, '2026-10-10', '09:00', '10:00'],
    ]);
  });

  it('the calendar download places the game at its own instants', async () => {
    await save([assignment('comets', 'rockets', 'slot-1', { minutes: 90 })]);
    const { rows } = await fetchTeamEvents(TEAMS.comets, TZ);
    const feed = feedRowsOf(rows);
    expect(feed.games).toHaveLength(1);
    const ics = await teamCalendarIcs({
      teamName: TEAM_NAMES.comets,
      orgName: 'Synthetic FC',
      timeZone: TZ,
      rows,
      now: new Date('2026-09-01T00:00:00Z'),
    });
    expect(ics).toContain('DTSTART:20261003T130000Z');
    expect(ics).toContain('DTEND:20261003T143000Z');
  });
});
