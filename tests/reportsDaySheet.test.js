// @vitest-environment node
/**
 * The Day Sheet (task G1 of PR 7, schedule expansion): one date, an optional venue, one row per saved game, the
 * TIME TBD games listed apart, and a CSV. A read-only view over `game_assignments`, the master export's own source.
 *
 * What this file holds:
 * - the rows equal the master export's rows for the same date and venue (the master export writes a game as two rows,
 *   one for each team; the Day Sheet writes it once), TIME TBD games included, over a league that reaches every case;
 * - the venue is chosen by its id: two venues with one display name are told apart (plant: a filter by the name);
 * - the date is the season's calendar date, so a 22:00 game is on the day it is played and not the next UTC day;
 * - nothing is dropped silently: a game with no readable time, a game at a field the registry lacks and a team the
 *   registry lacks are all counted or named;
 * - the file names no coach, email or phone, and a team named like a formula is neutralised.
 */
import { describe, expect, it } from 'vitest';

import {
  DAY_SHEET_COLUMNS,
  buildDaySheet,
  daySheetCsv,
} from '../packages/core/src/reports/daySheet.js';
import { generateScheduleExports } from '../packages/core/src/outputGeneration.js';
import { wallOfInstant } from '../packages/core/src/reports/wall.js';
import {
  FIELDS,
  TEAMS,
  TZ,
  VENUES,
  exportGames,
  exportTeams,
  savedGames,
  tbdGames,
  tbdRows,
} from './helpers/reportsWorld.js';

const sheet = (extra = {}) =>
  buildDaySheet({
    games: savedGames(),
    teams: TEAMS,
    fields: FIELDS,
    venues: VENUES,
    tbdGames: tbdGames(),
    timeZone: TZ,
    date: '2026-10-03',
    ...extra,
  });

describe('wallOfInstant: an instant on the season clock', () => {
  it('reads the season date and time, not the UTC ones', () => {
    expect(wallOfInstant('2026-10-03T13:00:00+00:00', TZ)).toEqual({
      date: '2026-10-03',
      time: '09:00',
    });
    // 02:00Z on the 4th is 22:00 on the 3rd in New York.
    expect(wallOfInstant('2026-10-04T02:00:00Z', TZ)).toEqual({
      date: '2026-10-03',
      time: '22:00',
    });
    // Midnight is 00:00, never 24:00.
    expect(wallOfInstant('2026-10-03T04:00:00Z', TZ)).toEqual({
      date: '2026-10-03',
      time: '00:00',
    });
  });

  it('gives no reading, never a guess, for what has no honest reading', () => {
    for (const value of [null, undefined, '', 'soon', '2026-10-03T13:00:00', '2026-10-03', 12]) {
      expect(wallOfInstant(value, TZ)).toBeNull();
    }
    expect(wallOfInstant('2026-10-03T13:00:00Z', null)).toBeNull();
    expect(wallOfInstant('2026-10-03T13:00:00Z', 'Not/AZone')).toBeNull();
  });
});

describe('the Day Sheet rows', () => {
  it('lists one row per saved game on the date, in time order, with the names a person reads', () => {
    const { rows, columns } = sheet();
    expect(columns).toEqual(DAY_SHEET_COLUMNS);
    expect(DAY_SHEET_COLUMNS).toEqual([
      'Date',
      'Kickoff',
      'Ends',
      'Venue',
      'Field',
      'Division',
      'Home',
      'Away',
      'Status',
    ]);
    expect(rows).toEqual([
      {
        Date: '2026-10-03',
        Kickoff: '09:00',
        Ends: '10:00',
        Venue: 'North Park',
        Field: 'Field A1',
        Division: 'U10',
        Home: 'Synthetic Comets',
        Away: 'Synthetic Rockets',
        Status: 'Scheduled',
      },
      {
        Date: '2026-10-03',
        Kickoff: '09:30',
        Ends: '10:30',
        Venue: 'Main Park',
        Field: 'Field B1',
        Division: 'U12',
        Home: 'Synthetic Planets',
        Away: 'Synthetic Moons',
        Status: 'Scheduled',
      },
    ]);
  });

  it('puts a late game on the day it is played in the season, not the next UTC day', () => {
    // g5 starts at 02:00Z on the 11th: 22:00 on Saturday the 10th in New York.
    const onTheTenth = sheet({ date: '2026-10-10' });
    expect(onTheTenth.rows.map((r) => r.Kickoff)).toEqual(['09:00', '11:00', '22:00']);
    expect(sheet({ date: '2026-10-11' }).rows).toEqual([]);
  });

  it('filters by the venue id: two venues with one display name are different venues', () => {
    // g6 is at Field C1 (the second Main Park) on the 17th; g2 and g5 are at Field B1 (the first).
    const second = sheet({ date: '2026-10-17', venueId: 'v-main-2' });
    expect(second.rows.map((r) => r.Field)).toEqual(['Field C1']);
    // The first Main Park has no game that day. A filter by display name would find the second one's.
    const first = sheet({ date: '2026-10-17', venueId: 'v-main-1' });
    expect(first.rows).toEqual([]);
    expect(first.counts.onDate).toBe(1);
    expect(first.counts.shown).toBe(0);
    // And a venue is a venue: the others are told apart on a day both have games.
    expect(sheet({ date: '2026-10-10', venueId: 'v-north' }).rows.map((r) => r.Field)).toEqual([
      'Field A1',
      'Field A2',
    ]);
    expect(sheet({ date: '2026-10-10', venueId: 'v-main-1' }).rows.map((r) => r.Field)).toEqual([
      'Field B1',
    ]);
  });

  it('names a venue that is not in the registry as empty, not as every venue', () => {
    expect(sheet({ date: '2026-10-10', venueId: 'v-nowhere' }).rows).toEqual([]);
  });

  it('refuses to build with no time zone or a date that is not one', () => {
    expect(() => sheet({ timeZone: null })).toThrow(/time zone/i);
    expect(() => sheet({ date: '10/03/2026' })).toThrow(/date/i);
    expect(() => sheet({ date: '2026-02-30' })).toThrow(/date/i);
  });
});

describe('the Day Sheet equals the master export, row for row', () => {
  /** The master export's game rows for a date and an optional venue, as the Exports panel would pass them. */
  function masterGameRows({ date, venueId = null }) {
    const games = savedGames();
    const { master } = generateScheduleExports({
      teams: exportTeams(),
      gameAssignments: exportGames(games),
      tbdItems: [],
    });
    const venueOfField = new Map(FIELDS.map((f) => [f.id, f.venueId]));
    return master.rows.filter((row) => {
      if (row['Event Type'] !== 'Game') return false;
      if (wallOfInstant(row.Start, TZ)?.date !== date) return false;
      return venueId === null || venueOfField.get(row.Field) === venueId;
    });
  }

  // `games` is written out from the seed table in tests/helpers/reportsWorld.js, never read off the code under test.
  const CASES = [
    { date: '2026-10-03', games: 2 },
    { date: '2026-10-10', games: 3 },
    { date: '2026-10-17', games: 1 },
    { date: '2026-10-10', venueId: 'v-north', games: 2 },
    { date: '2026-10-10', venueId: 'v-main-1', games: 1 },
    { date: '2026-10-17', venueId: 'v-main-1', games: 0 },
    { date: '2026-10-17', venueId: 'v-main-2', games: 1 },
    { date: '2026-10-24', games: 0 },
  ];

  it.each(CASES)('for %j the Day Sheet has half the master export rows, one for each game', (c) => {
    const master = masterGameRows(c);
    const { rows, gameIds } = sheet({ date: c.date, venueId: c.venueId });
    expect(rows.length).toBe(c.games);
    // The master export writes a game for each of its two teams; the Day Sheet writes it once.
    expect(master.length).toBe(rows.length * 2);
    expect(gameIds.length).toBe(rows.length);
    // The master's home rows are the Day Sheet's games: the same two teams, start, end and field.
    const names = new Map(TEAMS.map((t) => [t.id, t.name]));
    const byId = new Map(savedGames().map((g) => [g.id, g]));
    const masterKeys = master
      .filter((row) => row.Role === 'Home')
      .map((row) => `${row['Team Name']}|${row.Opponent}|${row.Start}|${row.End}|${row.Field}`)
      .sort();
    const sheetKeys = gameIds
      .map((id) => byId.get(id))
      .map(
        (g) =>
          `${names.get(g.homeTeamId)}|${names.get(g.awayTeamId)}|${new Date(g.start).toISOString()}|${new Date(g.end).toISOString()}|${g.fieldId}`
      )
      .sort();
    expect(sheetKeys).toEqual(masterKeys);
  });

  it('over the whole season the counts reconcile, and the days together are every saved game', () => {
    const dates = ['2026-10-03', '2026-10-10', '2026-10-17'];
    const shown = dates.flatMap((date) => sheet({ date }).rows);
    expect(shown.length).toBe(savedGames().length);
    expect(masterGameRows({ date: '2026-10-03' }).length).toBe(4);
  });

  it('lists the TIME TBD games the master export lists, once for each game it prints twice', () => {
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
    const masterTbd = master.rows.filter(
      (row) => row['Event Type'] === 'Game' && row.Start === 'TIME TBD'
    );
    const { tbd } = sheet();
    expect(masterTbd.length).toBe(2);
    expect(tbd.length).toBe(1);
    expect(tbd[0]).toEqual({
      Date: '',
      Kickoff: 'TIME TBD',
      Ends: '',
      Venue: 'LOCATION TBD',
      Field: '',
      Division: 'U10',
      Home: 'Synthetic Comets',
      Away: 'Synthetic Meteors',
      Status: 'TIME TBD (week 2): no game slot was free for it',
    });
    // The master export's note for the same game gives the same reason in the same words.
    expect(masterTbd[0].Notes).toBe('Game not scheduled (week 2): no game slot was free for it.');
  });

  it('shows the TIME TBD games whatever the date and venue, and says so in the counts', () => {
    const none = sheet({ date: '2026-10-24', venueId: 'v-north' });
    expect(none.rows).toEqual([]);
    expect(none.tbd.length).toBe(1);
    expect(none.counts.tbd).toBe(1);
  });
});

describe('with no date chosen', () => {
  it('has no dated game, and still lists the TIME TBD games and the games with no readable time', () => {
    const games = [
      ...savedGames(),
      { ...savedGames()[0], id: 'g-untimed', start: null, end: null },
    ];
    const result = sheet({ games, date: null });
    expect(result.rows).toEqual([]);
    expect(result.counts).toMatchObject({ onDate: 0, shown: 0, tbd: 1, unreadable: 1 });
    expect(result.tbd).toHaveLength(1);
    expect(result.unreadable.map((u) => u.id)).toEqual(['g-untimed']);
  });
});

describe('nothing is dropped without a word', () => {
  it('lists a game with no readable time apart, with its teams, instead of leaving it out', () => {
    const games = [
      ...savedGames(),
      { ...savedGames()[0], id: 'g-untimed', start: null, end: null },
      {
        ...savedGames()[0],
        id: 'g-zoneless',
        start: '2026-10-03T09:00:00',
        end: '2026-10-03T10:00:00',
      },
    ];
    const result = sheet({ games });
    expect(result.counts.saved).toBe(8);
    expect(result.unreadable.map((u) => u.id).sort()).toEqual(['g-untimed', 'g-zoneless']);
    expect(result.unreadable[0].home).toBe('Synthetic Comets');
    // They are not on any date, and they are in the count.
    expect(result.counts.unreadable).toBe(2);
  });

  it('reads a field or team the registry lacks as unknown, and keeps the game off every venue filter', () => {
    const games = savedGames({
      g1: { fieldId: 'f-gone', homeTeamId: 't-gone' },
    });
    const all = sheet({ games });
    const first = all.rows[0];
    expect(first.Venue).toBe('Unknown venue');
    expect(first.Field).toBe('Unknown field (f-gone)');
    expect(first.Home).toBe('Unknown team (t-gone)');
    // Under a venue filter it is not claimed by any venue, and the count says one game was left out for that.
    const filtered = sheet({ games, venueId: 'v-north' });
    expect(filtered.rows).toEqual([]);
    expect(filtered.counts.unknownGround).toBe(1);
  });
});

describe('the file', () => {
  it('is the columns and the rows, TIME TBD games after the dated ones', () => {
    const csv = daySheetCsv(sheet());
    const lines = csv.split('\n');
    expect(lines[0]).toBe(DAY_SHEET_COLUMNS.join(','));
    expect(lines).toHaveLength(1 + 2 + 1);
    expect(lines[1]).toContain('Synthetic Comets');
    expect(lines[3]).toContain('TIME TBD');
  });

  it('carries no coach, email or phone anywhere, and neutralises a team named like a formula', () => {
    const teams = TEAMS.map((t) =>
      t.id === 't-1' ? { ...t, name: '=HYPERLINK("http://example.invalid")' } : t
    );
    const csv = daySheetCsv(sheet({ teams }));
    expect(DAY_SHEET_COLUMNS.join(' ')).not.toMatch(/coach|e-?mail|phone|contact/i);
    expect(csv).toContain(`"'=HYPERLINK(""http://example.invalid"")"`);
    expect(csv).not.toMatch(/@|coach/i);
  });

  it('reads no coach field even when a team row carries one', () => {
    const teams = TEAMS.map((t) => ({
      ...t,
      coachId: 'c-1',
      coachEmail: 'someone@example.invalid',
      coachPhone: '000',
    }));
    const csv = daySheetCsv(sheet({ teams }));
    expect(csv).not.toMatch(/example\.invalid|000/);
  });
});

describe('the data is the invented league, not a real one', () => {
  it('uses only placeholder names', () => {
    const names = [...TEAMS.map((t) => t.name), ...VENUES.map((v) => v.name)];
    expect(names.every((n) => /Synthetic|Park/.test(n))).toBe(true);
    expect(tbdRows().length).toBe(2);
  });
});
