/**
 * The schedule export around a clock change (PR 6 fix round 3, G2): a file exported here imports here with no change,
 * also on the night the clocks go back.
 *
 * A wall time the clocks show twice names two instants, and the import reads it as the FIRST (`resolveZonedInstant`).
 * So an End Time in the repeated hour, written as a wall time, comes back as the first time round: for a game that
 * ends the second time round, an hour short. The file's own answer is `Length`: elapsed minutes from the start.
 *
 * What it holds, in two zones that change their clocks (one northern, one southern) and one that does not:
 *   - parser -> export -> parser gives the same instants for every game the file can hold;
 *   - an end in the repeated hour is written as a Length with a blank End Time, first or second time round;
 *   - a start in the FIRST occurrence round-trips; a start in the SECOND cannot be written, and is counted
 *     (`omitted.repeatedHour`), never written as the first;
 *   - no stored instant reads as a wall time in the hour the clocks skip, so the export has no such case;
 *   - the same bytes come out under other host `TZ` values (the host's clock is never read).
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as core from '../packages/core/src/scheduleImport/index.js';
import { wallOfInstant } from '../packages/core/src/reports/wall.js';
import { resolveZonedInstant } from '../packages/core/src/timing/seasonClock.js';

const C = core.SCHEDULE_IMPORT_COLUMNS;
const HEADERS = [...core.SCHEDULE_IMPORT_TEMPLATE_HEADER, C.LENGTH];
const TEAMS = [
  { id: 't1', name: 'U10 Team 01', division: 'U10' },
  { id: 't2', name: 'U10 Team 02', division: 'U10' },
];
// one field per game of the file: two games on one field at one time are one game to the import
const FIELDS = [1, 2, 3, 4, 5, 6].map((n) => ({ id: `f${n}`, name: `Field ${n}`, venueId: 'v1' }));
const VENUES = [{ id: 'v1', name: 'Venue A' }];
const pad = (n) => String(n).padStart(2, '0');

/**
 * A zone, the date its clocks go back with the hour they repeat (`H`:00 to `H`:59 is shown twice), the date they go
 * forward with the hour they skip, and the offsets before and after going back.
 */
const ZONES = [
  {
    name: 'America/Los_Angeles (northern)',
    timeZone: 'America/Los_Angeles',
    seasonStart: '2026-09-07',
    back: '2026-11-01',
    H: 1,
    before: '-07:00',
    after: '-08:00',
    forward: '2027-03-14',
    skipped: 2,
  },
  {
    name: 'Australia/Sydney (southern)',
    timeZone: 'Australia/Sydney',
    seasonStart: '2026-09-07',
    back: '2027-04-04',
    H: 2,
    before: '+11:00',
    after: '+10:00',
    forward: '2026-10-04',
    skipped: 2,
  },
];
/** The control: no clock change, the same dates and hours as Los Angeles. */
const CONTROL = {
  ...ZONES[0],
  name: 'America/Phoenix (no clock change)',
  timeZone: 'America/Phoenix',
};

/** The file's rows around the repeated hour `H` of `date`: every case the file can hold. */
function fileRows({ back: date, H }) {
  let n = 0;
  const row = (id, start, end, length) => ({
    [C.GAME_ID]: id,
    [C.DATE]: date,
    [C.START]: start,
    [C.END]: end,
    [C.LENGTH]: length,
    [C.VENUE]: 'Venue A',
    [C.FIELD]: `Field ${(n += 1)}`,
    [C.DIVISION]: 'U10',
    [C.HOME]: 'U10 Team 01',
    [C.AWAY]: 'U10 Team 02',
    [C.WEEK]: '',
  });
  return [
    // the reported case: ends the SECOND time the clocks show H:30
    row('END-SECOND', `${pad(H - 1)}:30`, '', '120'),
    // ends the FIRST time the clocks show H:30
    row('END-FIRST', `${pad(H - 1)}:30`, '', '60'),
    // starts in the repeated hour, first time round; its end is a time the clocks show once
    row('START-FIRST', `${pad(H)}:15`, `${pad(H + 1)}:30`, ''),
    // starts and ends in the repeated hour, first time round
    row('BOTH-FIRST', `${pad(H)}:15`, '', '30'),
    // runs through the whole repeated hour: both ends are times the clocks show once
    row('ACROSS', `${pad(H - 1)}:30`, `${pad(H + 1)}:30`, ''),
    // an ordinary game of the same day
    row('ORDINARY', '10:00', '11:00', ''),
  ];
}

const parse = (zone, headers, rows) => {
  const parsed = core.parseScheduleRows({
    headers,
    rows,
    season: { timeZone: zone.timeZone, startDate: zone.seasonStart },
  });
  if (!parsed.ok) throw new Error(`the file was refused: ${parsed.refusal.message}`);
  return parsed;
};
/** The saved games a parsed file becomes: each row's own instants, as the apply stores them. */
const gamesOf = (parsed) =>
  parsed.rows.map((r) => {
    if (r.status !== 'ok') throw new Error(`row ${r.gameId} is ${r.status}: ${r.message ?? ''}`);
    return {
      id: `g-${r.gameId}`,
      externalRef: r.gameId,
      gameSlotId: null,
      fieldId: FIELDS.find((f) => f.name === r.fieldLabel).id,
      homeTeamId: 't1',
      awayTeamId: 't2',
      division: 'U10',
      weekIndex: r.weekIndex,
      start: r.start,
      end: r.end,
    };
  });
const build = (zone, games) =>
  core.buildScheduleCsv({
    games,
    slots: [],
    teams: TEAMS,
    fields: FIELDS,
    venues: VENUES,
    timeZone: zone.timeZone,
  });
/** What the import compares: each game's instants, as epoch milliseconds, by Game ID. */
const instants = (parsed) =>
  Object.fromEntries(
    parsed.rows.map((r) => [
      r.gameId,
      [Date.parse(r.start), Date.parse(r.end), r.weekIndex, r.status],
    ])
  );
const roundTrip = (zone) => {
  const first = parse(zone, HEADERS, fileRows(zone));
  const exported = build(zone, gamesOf(first));
  const second = parse(zone, exported.headers, exported.rows);
  return { first, exported, second };
};

const hostZone = process.env.TZ;
afterEach(() => {
  if (hostZone === undefined) delete process.env.TZ;
  else process.env.TZ = hostZone;
});

describe.each(ZONES)('$name: the night the clocks go back', (zone) => {
  const { back: date, H } = zone;
  const at = (time, offset) => `${date}T${time}:00${offset}`;

  it('the file of the test reaches both rounds of the repeated hour (a check over less would pass)', () => {
    const { first } = roundTrip(zone);
    const byId = Object.fromEntries(first.rows.map((r) => [r.gameId, r]));
    expect(first.counts).toMatchObject({ rows: 6, ok: 6, refused: 0 });
    // the same wall time, an hour apart
    expect(byId['END-SECOND'].endTime).toBe(`${pad(H)}:30`);
    expect(byId['END-FIRST'].endTime).toBe(`${pad(H)}:30`);
    expect(Date.parse(byId['END-SECOND'].end) - Date.parse(byId['END-FIRST'].end)).toBe(3600000);
    expect(Date.parse(byId['END-SECOND'].end)).toBe(Date.parse(at(`${pad(H)}:30`, zone.after)));
    expect(Date.parse(byId['START-FIRST'].start)).toBe(Date.parse(at(`${pad(H)}:15`, zone.before)));
  });

  it('parser -> export -> parser changes nothing: every game has the instants it had', () => {
    const { first, exported, second } = roundTrip(zone);
    expect(exported.omitted).toEqual({
      noPlace: 0,
      unknownRecord: 0,
      undatedTbd: 0,
      repeatedHour: 0,
    });
    expect(exported.rows).toHaveLength(6);
    expect(second.counts).toMatchObject({ rows: 6, ok: 6, refused: 0 });
    expect(instants(second)).toEqual(instants(first));
    // and once more: the export of the re-import is the same file
    expect(build(zone, gamesOf(second)).csv).toBe(exported.csv);
  });

  it('an end in the repeated hour is written as a Length with no End Time; every other end as its End Time', () => {
    const { exported } = roundTrip(zone);
    expect(exported.headers).toEqual([
      'Game ID',
      'Date',
      'Start Time',
      'End Time',
      'Length',
      'Venue',
      'Field',
      'Division',
      'Home Team',
      'Away Team',
      'Week',
    ]);
    const cells = Object.fromEntries(
      exported.rows.map((r) => [r[C.GAME_ID], [r[C.START], r[C.END], r[C.LENGTH] ?? '']])
    );
    expect(cells).toEqual({
      'END-SECOND': [`${pad(H - 1)}:30`, '', '120'],
      'END-FIRST': [`${pad(H - 1)}:30`, '', '60'],
      'START-FIRST': [`${pad(H)}:15`, `${pad(H + 1)}:30`, ''],
      'BOTH-FIRST': [`${pad(H)}:15`, '', '30'],
      ACROSS: [`${pad(H - 1)}:30`, `${pad(H + 1)}:30`, ''],
      ORDINARY: ['10:00', '11:00', ''],
    });
    expect(exported.csv.split('\n')[0]).toBe(exported.headers.join(','));
  });

  it('a start the SECOND time round cannot be written: the game is counted, never written as the first', () => {
    const game = (id, start, end) => ({
      id,
      externalRef: id,
      gameSlotId: null,
      fieldId: 'f1',
      homeTeamId: 't1',
      awayTeamId: 't2',
      division: 'U10',
      weekIndex: 1,
      start,
      end,
    });
    const built = build(zone, [
      // second H:15 to the (single) H+1:00
      game('SECOND', at(`${pad(H)}:15`, zone.after), at(`${pad(H + 1)}:00`, zone.after)),
      // CONTROL: the same wall times, first time round, is a row
      game('FIRST', at(`${pad(H)}:15`, zone.before), at(`${pad(H + 1)}:00`, zone.after)),
      // first H:45 to second H:15: on the clock it ends before it starts, which the file cannot hold either
      game('BACKWARDS', at(`${pad(H)}:45`, zone.before), at(`${pad(H)}:15`, zone.after)),
    ]);
    expect(built.rows.map((r) => r[C.GAME_ID])).toEqual(['FIRST']);
    expect(built.omitted).toEqual({ noPlace: 1, unknownRecord: 0, undatedTbd: 0, repeatedHour: 1 });
    // the row that IS written reads back as the instants it was
    const back = parse(zone, built.headers, built.rows).rows[0];
    expect(Date.parse(back.start)).toBe(Date.parse(at(`${pad(H)}:15`, zone.before)));
    expect(Date.parse(back.end)).toBe(Date.parse(at(`${pad(H + 1)}:00`, zone.after)));
  });

  it('the day the clocks go forward: no instant reads as a time in the skipped hour, and the import refuses one', () => {
    // every minute of that day and the hours around it, as instants: each reads as a wall time that names an instant
    const from = Date.parse(`${zone.forward}T00:00:00Z`) - 14 * 3600000;
    let inGap = 0;
    let seen = 0;
    for (let ms = from; ms < from + 52 * 3600000; ms += 60000) {
      const wall = wallOfInstant(new Date(ms).toISOString(), zone.timeZone);
      if (wall.date !== zone.forward) continue;
      seen += 1;
      if (Number(wall.time.slice(0, 2)) === zone.skipped) inGap += 1;
      const again = resolveZonedInstant({ ...wall, timeZone: zone.timeZone });
      expect(again.iso).not.toBeNull();
      expect(Date.parse(again.iso)).toBe(ms);
    }
    // the day has 23 hours, and none of them is the skipped one
    expect(seen).toBe(23 * 60);
    expect(inGap).toBe(0);
    // CONTROL: a file that names the skipped hour is refused by the import, so no such game is ever stored
    const parsed = parse(zone, HEADERS, [
      {
        ...fileRows(zone)[5],
        [C.DATE]: zone.forward,
        [C.START]: `${pad(zone.skipped)}:30`,
        [C.END]: '05:00',
      },
    ]);
    expect(parsed.rows[0]).toMatchObject({ status: 'refused', reason: 'time-in-dst-gap' });
  });

  it('gives the same file under other host TZ values', () => {
    const files = ['UTC', 'Pacific/Auckland', 'America/St_Johns'].map((tz) => {
      process.env.TZ = tz;
      const { first, exported, second } = roundTrip(zone);
      expect(instants(second)).toEqual(instants(first));
      return exported.csv;
    });
    expect(new Set(files).size).toBe(1);
    expect(files[0]).toContain('END-SECOND');
  });
});

describe('CONTROL: a zone whose clocks do not change', () => {
  it('writes every end as its End Time, with no Length column, and round-trips', () => {
    const { first, exported, second } = roundTrip(CONTROL);
    expect(exported.headers).toEqual([...core.SCHEDULE_IMPORT_TEMPLATE_HEADER]);
    expect(exported.omitted).toEqual({
      noPlace: 0,
      unknownRecord: 0,
      undatedTbd: 0,
      repeatedHour: 0,
    });
    expect(exported.rows.every((r) => r[C.END] !== '' && !(C.LENGTH in r))).toBe(true);
    expect(instants(second)).toEqual(instants(first));
    // the two games whose ends share a wall time where the hour repeats end at different wall times here
    const byId = Object.fromEntries(first.rows.map((r) => [r.gameId, r]));
    expect(byId['END-SECOND'].endTime).toBe('02:30');
    expect(byId['END-FIRST'].endTime).toBe('01:30');
  });
});
