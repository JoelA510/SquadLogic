// @vitest-environment node
/**
 * The coach schedule (tasks G2 and G2b of PR 7, schedule expansion): one coach's games and practices across all their
 * teams, head and assistant, as rows and a CSV; names, never contacts. Read-only, admin only.
 *
 * What this file holds:
 * - the coach's teams come from `team_coach_assignments` (head AND assistant), so an assistant's team is in the
 *   schedule (plant: the schedule keeps only the head coach's teams);
 * - the multi-team marker follows the number of DISTINCT teams in the team list, not the stored
 *   `can_coach_multiple_teams` flag, in both directions (a flagged coach with one team is not marked; an unflagged
 *   coach with two is), and an ended assignment is not a team;
 * - the subject set is the coach registry: a coach with no team is listed, an assignment that names a coach or team
 *   the registry lacks is reported and never invented into a coach;
 * - the games clash column is `evaluateGameSchedule`'s per-coach `coach-conflict` warning, read week by week so a
 *   coach's second clash is not hidden behind the first; the practice clash is the one rule of
 *   `reports/practiceClash.js`; a practice is never compared with a game;
 * - a game on the TIME TBD list and a game with no readable time keep their rows, with the reason;
 * - the rows equal the master export's game rows for the same teams.
 */
import { describe, expect, it } from 'vitest';

import {
  COACH_SCHEDULE_COLUMNS,
  buildCoachDirectory,
  buildCoachSchedule,
  coachScheduleCsv,
} from '../packages/core/src/reports/coachSchedule.js';
import { generateScheduleExports } from '../packages/core/src/outputGeneration.js';
import { TEAM_SCHEDULE_COLUMNS } from '../packages/core/src/teamScheduleExport.js';
import {
  AS_OF,
  COACHES,
  COACH_ASSIGNMENTS,
  FIELDS,
  TEAMS,
  TZ,
  VENUES,
  exportGames,
  exportTeams,
  practices,
  savedGames,
  tbdGames,
} from './helpers/reportsWorld.js';

const input = (extra = {}) => ({
  coaches: COACHES,
  teams: TEAMS,
  assignments: COACH_ASSIGNMENTS,
  asOf: AS_OF,
  games: savedGames(),
  tbdGames: tbdGames(),
  practices: practices(),
  fields: FIELDS,
  venues: VENUES,
  timeZone: TZ,
  ...extra,
});
const schedule = (coachId, extra = {}) => buildCoachSchedule({ coachId, ...input(extra) });
const rowsOf = (result, eventType) => result.rows.filter((row) => row['Event Type'] === eventType);

describe('the coach directory: who is on more than one team', () => {
  const find = (directory, id) => directory.coaches.find((coach) => coach.id === id);

  it('marks a coach by the distinct teams on the team list, in both directions', () => {
    const directory = buildCoachDirectory(input());
    // Alex: not flagged on the Coaches page, two teams (head of one, assistant of another): marked.
    expect(find(directory, 'c-1')).toMatchObject({ teamCount: 2, multiTeam: true });
    // Blake: flagged `can_coach_multiple_teams`, one team: not marked.
    expect(COACHES.find((c) => c.id === 'c-2').canCoachMultipleTeams).toBe(true);
    expect(find(directory, 'c-2')).toMatchObject({ teamCount: 1, multiTeam: false });
    // Casey: not flagged, two teams: marked.
    expect(COACHES.find((c) => c.id === 'c-3').canCoachMultipleTeams).toBe(false);
    expect(find(directory, 'c-3')).toMatchObject({ teamCount: 2, multiTeam: true });
  });

  it('counts a team once however many roles the coach holds on it, and not after the assignment ended', () => {
    const drew = find(buildCoachDirectory(input()), 'c-4');
    // Head and assistant of the Planets is one team; the Meteors assignment ended on 2026-09-15.
    expect(drew.teams.map((t) => t.name)).toEqual(['Synthetic Planets']);
    expect(drew.teams[0].roles).toEqual(['assistant', 'lead']);
    expect(drew).toMatchObject({ teamCount: 1, multiTeam: false });
    // As of a day before it ended, the Meteors are his too.
    const earlier = find(buildCoachDirectory(input({ asOf: '2026-09-01' })), 'c-4');
    expect(earlier).toMatchObject({ teamCount: 2, multiTeam: true });
  });

  it('does not count an assignment that has not started', () => {
    const future = [
      ...COACH_ASSIGNMENTS,
      {
        id: 'ca-f',
        team_id: 't-2',
        coach_id: 'c-5',
        role: 'assistant',
        effective_from: '2026-12-01',
        effective_to: null,
      },
    ];
    const eli = find(buildCoachDirectory(input({ assignments: future })), 'c-5');
    expect(eli).toMatchObject({ teamCount: 1, multiTeam: false });
  });

  it('lists every coach on the registry, including one with no team, sorted by name', () => {
    const coaches = [...COACHES, { id: 'c-6', name: 'Aaron Sample', canCoachMultipleTeams: false }];
    const directory = buildCoachDirectory(input({ coaches }));
    expect(directory.coaches.map((c) => c.name)).toEqual([
      'Aaron Sample',
      'Alex Sample',
      'Blake Sample',
      'Casey Sample',
      'Drew Sample',
      'Eli Sample',
    ]);
    expect(find(directory, 'c-6')).toMatchObject({ teamCount: 0, multiTeam: false, teams: [] });
  });

  it('reports an assignment that names a coach or a team the registry lacks, and invents neither', () => {
    const odd = [
      ...COACH_ASSIGNMENTS,
      {
        id: 'ca-x',
        team_id: 't-1',
        coach_id: 'c-gone',
        role: 'assistant',
        effective_from: '2026-08-01',
        effective_to: null,
      },
      {
        id: 'ca-y',
        team_id: 't-gone',
        coach_id: 'c-5',
        role: 'assistant',
        effective_from: '2026-08-01',
        effective_to: null,
      },
    ];
    const directory = buildCoachDirectory(input({ assignments: odd }));
    expect(directory.unknownCoachIds).toEqual(['c-gone']);
    expect(directory.unknownTeamIds).toEqual(['t-gone']);
    expect(directory.coaches.some((c) => c.id === 'c-gone')).toBe(false);
    // Eli's team count is the teams the registry has: the unknown one is not a team of his.
    expect(find(directory, 'c-5')).toMatchObject({ teamCount: 1, multiTeam: false });
  });

  it('carries a name and a count and nothing that reaches a person', () => {
    const coaches = COACHES.map((c) => ({ ...c, email: 'someone@example.invalid', phone: '000' }));
    const json = JSON.stringify(buildCoachDirectory(input({ coaches })));
    expect(json).not.toMatch(/example\.invalid|"phone"|"email"/);
  });
});

describe('one coach’s schedule', () => {
  it('lists the games of every team the coach has, the assistant’s team included', () => {
    const alex = schedule('c-1');
    expect(alex.teams.map((t) => [t.name, t.roles])).toEqual([
      ['Synthetic Comets', ['lead']],
      ['Synthetic Planets', ['assistant']],
    ]);
    const games = rowsOf(alex, 'Game');
    // Comets: g1 and the unplaced game. Planets (assistant): g2 and g5.
    expect(games.map((g) => `${g.Team}|${g.Opponent}|${g.Date}|${g.Status}`)).toEqual([
      'Synthetic Comets|Synthetic Rockets|2026-10-03|Scheduled',
      'Synthetic Comets|Synthetic Meteors||TIME TBD',
      'Synthetic Planets|Synthetic Moons|2026-10-03|Scheduled',
      'Synthetic Planets|Synthetic Stars|2026-10-10|Scheduled',
    ]);
    expect(alex.multiTeam).toBe(true);
    expect(alex.counts).toMatchObject({ games: 3, tbdGames: 1, practices: 3 });
  });

  it('lists a head coach’s own team only for a coach with one team', () => {
    const blake = schedule('c-2');
    expect(blake.teams.map((t) => t.name)).toEqual(['Synthetic Rockets']);
    expect(blake.multiTeam).toBe(false);
    expect(rowsOf(blake, 'Game').map((g) => g.Date)).toEqual([
      '2026-10-03',
      '2026-10-10',
      '2026-10-17',
    ]);
    expect(rowsOf(blake, 'Practice')).toHaveLength(1);
  });

  it('gives a game the team export’s columns, the season’s clock and the venue and field', () => {
    expect(COACH_SCHEDULE_COLUMNS).toEqual([
      'Coach',
      ...TEAM_SCHEDULE_COLUMNS,
      'Day',
      'Dates',
      'Coach Clash',
    ]);
    const g1 = rowsOf(schedule('c-1'), 'Game')[0];
    expect(g1).toEqual({
      Coach: 'Alex Sample',
      Team: 'Synthetic Comets',
      Division: 'U10',
      'Event Type': 'Game',
      Opponent: 'Synthetic Rockets',
      'Home/Away': 'Home',
      Date: '2026-10-03',
      Start: '09:00',
      End: '10:00',
      'Time Zone': TZ,
      Location: 'North Park - Field A1',
      Status: 'Scheduled',
      Reason: '',
      'Reason Code': '',
      Day: 'Saturday',
      Dates: '',
      'Coach Clash': 'Overlaps Synthetic Planets v Synthetic Moons, 09:30 to 10:30',
    });
  });

  it('gives a practice its day, time, field and date range', () => {
    const p1 = rowsOf(schedule('c-1'), 'Practice').find((row) => row.Team === 'Synthetic Comets');
    expect(p1).toMatchObject({
      'Event Type': 'Practice',
      Opponent: '',
      'Home/Away': '',
      Date: '',
      Day: 'Tuesday',
      Start: '17:00',
      End: '18:30',
      'Time Zone': TZ,
      Location: 'North Park - Field A1',
      Dates: '2026-09-08 to 2026-11-19',
      Status: 'Scheduled',
    });
  });

  it('keeps a game on the TIME TBD list, with the reason in the same words as the master export', () => {
    const tbd = rowsOf(schedule('c-1'), 'Game').find((row) => row.Status === 'TIME TBD');
    expect(tbd).toMatchObject({
      Team: 'Synthetic Comets',
      Opponent: 'Synthetic Meteors',
      'Home/Away': 'Home',
      Date: '',
      Start: '',
      End: '',
      Reason: 'Game not scheduled (week 2): no game slot was free for it.',
      'Reason Code': 'no-slot-available',
    });
    // The other side of the same game is on Casey's schedule, as Away.
    const casey = rowsOf(schedule('c-3'), 'Game').find((row) => row.Status === 'TIME TBD');
    expect(casey).toMatchObject({
      Team: 'Synthetic Meteors',
      'Home/Away': 'Away',
      Opponent: 'Synthetic Comets',
    });
  });

  it('keeps a saved game with no readable time, and says why', () => {
    const games = [
      ...savedGames(),
      {
        ...savedGames()[0],
        id: 'g-untimed',
        slotId: null,
        gameSlotId: null,
        start: null,
        end: null,
        weekIndex: 4,
      },
      { ...savedGames()[0], id: 'g-nostart', slotId: 's-9', start: null, end: null, weekIndex: 5 },
    ];
    const result = schedule('c-1', { games });
    const missing = rowsOf(result, 'Game').filter((row) => row.Status === 'Date and time TBD');
    expect(missing).toHaveLength(2);
    expect(missing.map((row) => row['Reason Code']).sort()).toEqual([
      'GAME_SLOT_MISSING',
      'WALL_TIME_UNREADABLE',
    ]);
    expect(missing[0].Reason).toMatch(/slot|time/);
    expect(result.counts.untimedGames).toBe(2);
  });

  it('has the master export’s game rows for the same teams, none more and none fewer', () => {
    const { master } = generateScheduleExports({
      teams: exportTeams(),
      gameAssignments: exportGames(savedGames()),
      tbdItems: [
        {
          kind: 'game',
          homeTeamId: 't-1',
          awayTeamId: 't-3',
          weekIndex: 2,
          reason: 'no-slot-available',
        },
      ],
    });
    for (const coach of COACHES) {
      const result = schedule(coach.id);
      const teamIds = new Set(result.teams.map((t) => t.id));
      const masterGames = master.rows.filter(
        (row) => row['Event Type'] === 'Game' && teamIds.has(row['Team ID'])
      );
      expect(rowsOf(result, 'Game').length, coach.name).toBe(masterGames.length);
    }
    // The comparison reaches rows: Alex's four.
    expect(rowsOf(schedule('c-1'), 'Game')).toHaveLength(4);
  });

  it('is empty, and says so, for a coach with no current team; and refuses a coach the registry lacks', () => {
    const coaches = [...COACHES, { id: 'c-6', name: 'Fran Sample', canCoachMultipleTeams: false }];
    const fran = schedule('c-6', { coaches });
    expect(fran.rows).toEqual([]);
    expect(fran.teams).toEqual([]);
    expect(fran.notes.join(' ')).toMatch(/no current team/i);
    expect(() => schedule('c-nope')).toThrow(/coach/i);
  });
});

describe('the clash column', () => {
  it('marks both games of a coach who is in two places at once, by the evaluator’s coach-conflict', () => {
    const rows = rowsOf(schedule('c-1'), 'Game');
    const flagged = rows.filter((row) => row['Coach Clash'] !== '');
    expect(flagged.map((row) => row.Team)).toEqual(['Synthetic Comets', 'Synthetic Planets']);
    expect(flagged[1]['Coach Clash']).toBe(
      'Overlaps Synthetic Comets v Synthetic Rockets, 09:00 to 10:00'
    );
    // The Planets' other game, on the 10th, is clear.
    expect(rows.find((row) => row.Opponent === 'Synthetic Stars')['Coach Clash']).toBe('');
  });

  it('marks a coach’s second clash as well as the first: the evaluator names one per coach, so it is read by week', () => {
    const second = [
      {
        ...savedGames()[0],
        id: 'g7',
        weekIndex: 2,
        slotId: 's-6',
        start: '2026-10-10T17:00:00+00:00',
        end: '2026-10-10T18:00:00+00:00',
        homeTeamId: 't-1',
        awayTeamId: 't-3',
      },
      {
        ...savedGames()[1],
        id: 'g8',
        weekIndex: 2,
        slotId: 's-7',
        start: '2026-10-10T17:30:00+00:00',
        end: '2026-10-10T18:30:00+00:00',
        homeTeamId: 't-4',
        awayTeamId: 't-6',
      },
    ];
    const result = schedule('c-1', { games: [...savedGames(), ...second] });
    const flagged = rowsOf(result, 'Game').filter((row) => row['Coach Clash'] !== '');
    expect(flagged).toHaveLength(4);
    expect(result.gameClashes).toHaveLength(2);
    expect(result.gameClashes.map((c) => c.weekIndex).sort()).toEqual([1, 2]);
  });

  it('does not flag a coach whose games do not overlap, or a game that merely follows another', () => {
    const rows = rowsOf(schedule('c-3'), 'Game');
    expect(rows.every((row) => row['Coach Clash'] === '')).toBe(true);
    // Back to back is not an overlap.
    const touching = savedGames({
      g2: { start: '2026-10-03T14:00:00+00:00', end: '2026-10-03T15:00:00+00:00' },
    });
    expect(
      rowsOf(schedule('c-1', { games: touching }), 'Game').every((row) => row['Coach Clash'] === '')
    ).toBe(true);
  });

  it('marks two practices on one weekday at overlapping times, and not a different weekday', () => {
    const rows = rowsOf(schedule('c-1'), 'Practice');
    const byTeamDay = (team, day) => rows.find((row) => row.Team === team && row.Day === day);
    expect(byTeamDay('Synthetic Comets', 'Tuesday')['Coach Clash']).toBe(
      'Overlaps the Tuesday 18:00 to 19:00 practice of Synthetic Planets (11 shared dates, from 2026-09-08)'
    );
    expect(byTeamDay('Synthetic Planets', 'Tuesday')['Coach Clash']).toBe(
      'Overlaps the Tuesday 17:00 to 18:30 practice of Synthetic Comets (11 shared dates, from 2026-09-08)'
    );
    expect(byTeamDay('Synthetic Planets', 'Wednesday')['Coach Clash']).toBe('');
  });

  it('never compares a practice with a game', () => {
    // A Saturday practice for the Comets from 09:00 to 10:00, on the day and at the hour of game g1.
    const saturday = practices([
      {
        id: 'p-sat',
        teamId: 't-1',
        range: '[2026-09-05,2026-12-01)',
        dayOfWeek: 'sat',
        startTime: '09:00:00',
        endTime: '10:00:00',
        validFrom: '2026-09-01',
        validUntil: '2026-12-31',
        fieldId: 'f-a1',
        fieldName: 'Field A1',
      },
    ]);
    const result = schedule('c-1', { practices: saturday });
    const practice = rowsOf(result, 'Practice').find((row) => row.Day === 'Saturday');
    expect(practice['Coach Clash']).toBe('');
    // And the game's clash text still names only the other game.
    const g1 = rowsOf(result, 'Game')[0];
    expect(g1['Coach Clash']).toBe('Overlaps Synthetic Planets v Synthetic Moons, 09:30 to 10:30');
    expect(result.notes.join(' ')).toMatch(/practice is not compared with a game/i);
  });

  it('keeps a practice it cannot read, and says its clashes were not checked', () => {
    const bad = practices([
      {
        id: 'p-bad',
        teamId: 't-1',
        range: 'garbage',
        dayOfWeek: 'tue',
        startTime: '17:00:00',
        endTime: '18:30:00',
        validFrom: '2026-09-01',
        validUntil: '2026-11-30',
        fieldId: 'f-a1',
        fieldName: 'Field A1',
      },
    ]);
    const result = schedule('c-1', { practices: bad });
    expect(result.unjudgedPractices).toEqual(['p-bad']);
    const row = rowsOf(result, 'Practice').find(
      (r) => r['Reason Code'] === 'PRACTICE_RANGE_UNREADABLE'
    );
    expect(row.Dates).toBe('garbage');
    expect(result.notes.join(' ')).toMatch(/could not be read/i);
  });

  it('keeps a practice whose slot is gone', () => {
    const noSlot = practices([
      {
        id: 'p-none',
        teamId: 't-1',
        range: null,
        dayOfWeek: null,
        startTime: null,
        endTime: null,
        validFrom: null,
        validUntil: null,
        fieldId: null,
        fieldName: null,
      },
    ]);
    const row = rowsOf(schedule('c-1', { practices: noSlot }), 'Practice').find(
      (r) => r['Reason Code'] === 'PRACTICE_SLOT_MISSING'
    );
    expect(row).toMatchObject({ Status: 'Date and time TBD' });
    expect(row.Reason).toMatch(/no slot/i);
  });
});

describe('the file', () => {
  it('is the columns and the rows, and names the coach and no contact', () => {
    const coaches = COACHES.map((c) => ({ ...c, email: 'someone@example.invalid', phone: '000' }));
    const result = schedule('c-1', { coaches });
    const csv = coachScheduleCsv(result);
    const lines = csv.split('\n');
    expect(lines[0]).toBe(COACH_SCHEDULE_COLUMNS.join(','));
    expect(lines).toHaveLength(1 + result.rows.length);
    expect(csv).toContain('Alex Sample');
    expect(COACH_SCHEDULE_COLUMNS.join(' ')).not.toMatch(/e-?mail|phone|contact/i);
    expect(csv).not.toMatch(/example\.invalid|@|,000/);
  });

  it('neutralises a coach or team named like a formula', () => {
    const coaches = COACHES.map((c) => (c.id === 'c-1' ? { ...c, name: '+cmd|calc' } : c));
    const csv = coachScheduleCsv(schedule('c-1', { coaches }));
    expect(csv).toContain("'+cmd|calc");
    expect(csv).not.toMatch(/(^|,)\+cmd/m);
  });
});
