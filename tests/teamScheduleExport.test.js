// The schedule exports (plan docs/changes/2026-10-22-admin-focus.md, R7): a
// team's CSV, XLSX and calendar, built from the schedule the team page and the
// coach home show (`fetchTeamEvents`, run here against the mock client's twin
// of the tables).
//
// The plan's three tests:
// - the export's rows equal the schedule's events, every one of them, the
//   TIME TBD and slotless ones included (planted: an event dropped);
// - the export has no contact column, and no contact anywhere in it;
// - the calendar parses and round-trips its events.
//
// Every expectation below is written out from the seed, never read off the
// code under test.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { seedMockDb } from './helpers/seedMockDb.js';
import { readXlsx } from './helpers/readXlsx.js';
import { parseIcs } from './helpers/parseIcs.js';
import { MOCK_ORG_ID } from '../frontend/src/lib/mockSeedIds.js';
import {
  GAME_SLOT_MISSING,
  TEAM_SCHEDULE_CAUSES,
  TEAM_SCHEDULE_COLUMNS,
  TEAM_SCHEDULE_HEADERS as H,
  teamScheduleCsv,
  teamScheduleRows,
} from '../packages/core/src/teamScheduleExport.js';
import { UNPLACEABLE_CAUSES } from '../supabase/functions/_shared/calendar/icsFeed.ts';

vi.mock('../frontend/src/lib/supabaseClient.js', async () => {
  const { mockSupabase } = await import('../frontend/src/lib/mockSupabaseClient.js');
  return { supabase: mockSupabase, supabaseReady: Promise.resolve() };
});

vi.mock('../frontend/src/lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), log: vi.fn() },
}));

const { fetchTeamEvents } = await import('../frontend/src/hooks/useTeamPortal.js');
const { feedRowsOf, teamCalendarIcs, xlsxBlob, xlsxSheetData } =
  await import('../frontend/src/utils/scheduleDownloads.js');

const WALL_TIME_UNREADABLE = 'WALL_TIME_UNREADABLE';
const ZONE = 'America/Los_Angeles'; // the base seed's season
const TEAM = {
  id: 't1',
  name: 'Team A',
  division: { name: 'U8 Coed', season: { timezone: ZONE } },
};

/**
 * Team A's season, added to the base seed (which already gives Team A two
 * games with no slot, `g1` and `game-2`, both at home to Team B):
 *
 * - a game on Saturday 2026-11-07, 10:00-11:00, at home to Team B;
 * - a game away at Team B on 2026-11-14 whose slot has a day and no time;
 * - a Thursday 17:30-18:30 practice from 2026-11-02 to 2026-11-29: the 5th
 *   and the 12th as the series, the 19th TIME TBD (`contended`), and the
 *   week of the 23rd moved to Saturday the 28th, 09:00-10:00;
 * - a second practice row from 2026-12-01 with no end date, which the
 *   expansion refuses (no day to place it on).
 */
function seedSeason() {
  seedMockDb({
    game_slots: [
      {
        id: 'gs-r7-a',
        organization_id: MOCK_ORG_ID,
        field_id: 'v1',
        slot_date: '2026-11-07',
        start_time: '10:00:00',
        end_time: '11:00:00',
      },
      {
        id: 'gs-r7-b',
        organization_id: MOCK_ORG_ID,
        field_id: 'v1',
        slot_date: '2026-11-14',
        start_time: null,
        end_time: null,
      },
    ],
    games: [
      {
        id: 'game-r7-a',
        organization_id: MOCK_ORG_ID,
        home_team_id: 't1',
        away_team_id: 't2',
        game_slot_id: 'gs-r7-a',
      },
      {
        id: 'game-r7-b',
        organization_id: MOCK_ORG_ID,
        home_team_id: 't2',
        away_team_id: 't1',
        game_slot_id: 'gs-r7-b',
      },
    ],
    practice_slots: [
      {
        id: 'ps-r7-thu',
        organization_id: MOCK_ORG_ID,
        field_id: 'v1',
        day_of_week: 'thu',
        start_time: '17:30',
        end_time: '18:30',
      },
      {
        id: 'ps-r7-sat',
        organization_id: MOCK_ORG_ID,
        field_id: 'v1',
        day_of_week: 'sat',
        start_time: '09:00',
        end_time: '10:00',
      },
    ],
    practice_assignments: [
      {
        id: 'pa-r7',
        organization_id: MOCK_ORG_ID,
        team_id: 't1',
        practice_slot_id: 'ps-r7-thu',
        slot_id: 'ps-r7-thu',
        source: 'auto',
        effective_date_range: '[2026-11-02,2026-11-30)',
      },
      {
        id: 'pa-r7-open',
        organization_id: MOCK_ORG_ID,
        team_id: 't1',
        practice_slot_id: 'ps-r7-thu',
        slot_id: 'ps-r7-thu',
        source: 'auto',
        effective_date_range: '[2026-12-01,)',
      },
    ],
    practice_exceptions: [
      {
        id: 'ex-r7-tbd',
        organization_id: MOCK_ORG_ID,
        team_id: 't1',
        assignment_id: 'pa-r7',
        window: '[2026-11-19,2026-11-20)',
        kind: 'time_tbd',
        tbd_reason: 'contended',
        cause_kind: 'blackout',
        withdrawn_at: null,
        practice_slot_id: null,
      },
      {
        id: 'ex-r7-move',
        organization_id: MOCK_ORG_ID,
        team_id: 't1',
        assignment_id: 'pa-r7',
        window: '[2026-11-23,2026-11-30)',
        kind: 'relocated',
        tbd_reason: null,
        cause_kind: 'blackout',
        withdrawn_at: null,
        practice_slot_id: 'ps-r7-sat',
      },
    ],
  });
}

/** [type, opponent, home/away, date, start, end, time zone, status, reason code], from the seed. */
const EXPECTED = [
  ['Practice', '', '', '2026-11-05', '17:30', '18:30', ZONE, 'Scheduled', ''],
  ['Game', 'Team B', 'Home', '2026-11-07', '10:00', '11:00', ZONE, 'Scheduled', ''],
  ['Practice', '', '', '2026-11-12', '17:30', '18:30', ZONE, 'Scheduled', ''],
  ['Game', 'Team B', 'Away', '2026-11-14', '', '', '', 'TIME TBD', WALL_TIME_UNREADABLE],
  ['Practice', '', '', '2026-11-19', '', '', '', 'TIME TBD', 'contended'],
  ['Practice', '', '', '2026-11-28', '09:00', '10:00', ZONE, 'Moved', ''],
  ['Game', 'Team B', 'Home', '', '', '', '', 'Date and time TBD', GAME_SLOT_MISSING],
  ['Game', 'Team B', 'Home', '', '', '', '', 'Date and time TBD', GAME_SLOT_MISSING],
  ['Practice', '', '', '', '', '', '', 'Date and time TBD', 'PRACTICE_RANGE_UNREADABLE'],
];

const summary = (row) => [
  row[H.EVENT_TYPE],
  row[H.OPPONENT],
  row[H.HOME_AWAY],
  row[H.DATE],
  row[H.START],
  row[H.END],
  row[H.TIME_ZONE],
  row[H.STATUS],
  row[H.REASON_CODE],
];

/** The season's wall reading of a UTC `YYYYMMDDTHHMMSSZ`, as `[date, HH:MM]`. */
function wallOf(icsUtc) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(icsUtc);
  if (!m) throw new Error(`not a UTC date-time: ${icsUtc}`);
  const at = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value])
  );
  return [`${parts.year}-${parts.month}-${parts.day}`, `${parts.hour}:${parts.minute}`];
}

async function readTeamA() {
  const read = await fetchTeamEvents(TEAM.id, ZONE);
  const rows = teamScheduleRows([{ team: TEAM, timeZone: ZONE, events: read.events }]);
  return { read, rows };
}

beforeEach(() => {
  sessionStorage.clear();
  delete window.__MOCK_DB__;
  sessionStorage.setItem('__MOCK_SESSION__', JSON.stringify({ user: { id: 'mock-coach-id' } }));
  seedSeason();
});

afterEach(() => {
  sessionStorage.clear();
});

describe('the schedule export: one row per event, none dropped', () => {
  it('holds every event of the team, TIME TBD and slotless ones included, in schedule order', async () => {
    const { read, rows } = await readTeamA();
    expect(rows.map(summary)).toEqual(EXPECTED);
    // One row per event the page shows, the same count read independently.
    expect(rows).toHaveLength(read.events.length);
    for (const row of rows) {
      expect(row[H.TEAM]).toBe('Team A');
      expect(row[H.DIVISION]).toBe('U8 Coed');
      // Every row without a time says why, in words.
      if (!row[H.START]) expect(row[H.REASON]).not.toBe('');
    }
  });

  it('says why each event has no time, in the feed’s words', async () => {
    const { rows } = await readTeamA();
    const byCode = (code) => rows.find((row) => row[H.REASON_CODE] === code)[H.REASON];
    expect(byCode(GAME_SLOT_MISSING)).toBe(UNPLACEABLE_CAUSES[GAME_SLOT_MISSING]);
    expect(byCode(WALL_TIME_UNREADABLE)).toBe(UNPLACEABLE_CAUSES[WALL_TIME_UNREADABLE]);
    expect(byCode('contended')).toBe(UNPLACEABLE_CAUSES.contended);
    // The twin pins: this module's sentences are the feed's.
    for (const [code, sentence] of Object.entries(TEAM_SCHEDULE_CAUSES)) {
      expect(sentence).toBe(UNPLACEABLE_CAUSES[code]);
    }
    const moved = rows.find((row) => row[H.STATUS] === 'Moved');
    expect(moved[H.REASON]).toBe('Moved from Thursday 17:30, Central Park - Field 1');
    // Every ground in the seed is Field 1 at Central Park, named, never the placeholder.
    for (const row of rows)
      if (row[H.LOCATION]) expect(row[H.LOCATION]).toBe('Central Park - Field 1');
    expect(moved[H.LOCATION]).toBe('Central Park - Field 1');
  });

  it('keeps blank cells blank and identifiers as text', () => {
    const rows = teamScheduleRows([
      {
        team: { id: '007', name: '007', division: null },
        timeZone: null,
        events: [{ type: 'practice', date: '2026-11-05', startTime: '7:05:00', endTime: null }],
      },
    ]);
    expect(rows).toEqual([
      {
        [H.TEAM]: '007',
        [H.DIVISION]: '',
        [H.EVENT_TYPE]: 'Practice',
        [H.OPPONENT]: '',
        [H.HOME_AWAY]: '',
        [H.DATE]: '2026-11-05',
        [H.START]: '07:05',
        // No end: the start, as the feed reads it (a zero-length event).
        [H.END]: '07:05',
        // The season has no zone: said as blank, never a guessed one.
        [H.TIME_ZONE]: '',
        [H.LOCATION]: '',
        [H.STATUS]: 'Scheduled',
        [H.REASON]: '',
        [H.REASON_CODE]: '',
      },
    ]);
  });

  it('refuses a schedule with no team or no events rather than writing nothing', () => {
    expect(() => teamScheduleRows(null)).toThrow(TypeError);
    expect(() => teamScheduleRows([/** @type {any} */ ({ events: [] })])).toThrow(TypeError);
    expect(() => teamScheduleRows([{ team: TEAM, events: null }])).toThrow(TypeError);
  });

  it('writes the CSV through the export’s cell writer (formula neutralised)', () => {
    const csv = teamScheduleCsv(
      teamScheduleRows([
        {
          team: { id: 'x', name: '=HYPERLINK("http://x")', division: { name: 'U8, Coed' } },
          timeZone: ZONE,
          events: [{ type: 'practice', date: '2026-11-05', startTime: '17:30', endTime: '18:30' }],
        },
      ])
    );
    const [header, line] = csv.split('\n');
    expect(header).toBe(TEAM_SCHEDULE_COLUMNS.join(','));
    expect(line.startsWith(`"'=HYPERLINK(""http://x"")","U8, Coed",Practice`)).toBe(true);
  });
});

describe('no contact column in the coach export', () => {
  /** Every email and phone the mock holds, from the people tables, not from the export. */
  const contacts = async () => {
    const { mockSupabase } = await import('../frontend/src/lib/mockSupabaseClient.js');
    const coaches = (await mockSupabase.from('coaches').select('*')).data ?? [];
    const profiles = (await mockSupabase.from('profiles').select('*')).data ?? [];
    return [...coaches, ...profiles]
      .flatMap((row) => [row.email, row.phone])
      .filter((value) => typeof value === 'string' && value.trim());
  };

  it('has no column named like an email, phone, contact, guardian or coach', () => {
    for (const column of TEAM_SCHEDULE_COLUMNS) {
      expect(column).not.toMatch(/mail|phone|contact|guardian|coach/i);
    }
  });

  it('carries no email or phone in the CSV, the XLSX or the calendar', async () => {
    const known = await contacts();
    // The check examines something: the mock's people carry contacts.
    expect(known.length).toBeGreaterThan(2);
    const { read, rows } = await readTeamA();
    const csv = teamScheduleCsv(rows);
    const xlsx = readXlsx(
      new Uint8Array(await (await xlsxBlob(TEAM_SCHEDULE_COLUMNS, rows)).arrayBuffer())
    );
    const ics = await teamCalendarIcs({
      teamName: TEAM.name,
      orgName: 'Mock League',
      timeZone: ZONE,
      rows: read.rows,
    });
    const files = [csv, xlsx.rows.flat().join('\n'), ics];
    for (const file of files) {
      // The calendar's UIDs are `<id>@squadlogic.app` by RFC 5545; nothing else may carry an @.
      expect(file.replace(/@squadlogic\.app/g, '')).not.toMatch(/@[a-z0-9-]+\.[a-z]/i);
      for (const value of known) expect(file).not.toContain(value);
    }
    expect(xlsx.rows[0]).toEqual([...TEAM_SCHEDULE_COLUMNS]);
  });
});

describe('the XLSX file', () => {
  it('holds exactly the CSV’s rows, every cell as text', async () => {
    const { rows } = await readTeamA();
    const blob = await xlsxBlob(TEAM_SCHEDULE_COLUMNS, rows);
    const sheet = readXlsx(new Uint8Array(await blob.arrayBuffer()));
    expect(sheet.rows[0]).toEqual([...TEAM_SCHEDULE_COLUMNS]);
    expect(sheet.rows.slice(1)).toEqual(
      rows.map((row) => TEAM_SCHEDULE_COLUMNS.map((column) => row[column]))
    );
    // The header row stays in view.
    expect(sheet.sheetXml).toContain('state="frozen"');
  });

  it('writes a leading-zero identifier and a formula-looking name as text, a blank as empty', async () => {
    const data = xlsxSheetData(['A', 'B', 'C'], [{ A: '007', B: '=1+1', C: '' }]);
    expect(data[1]).toEqual([
      { value: '007', type: String },
      { value: '=1+1', type: String },
      null,
    ]);
    const sheet = readXlsx(
      new Uint8Array(
        await (await xlsxBlob(['A', 'B', 'C'], [{ A: '007', B: '=1+1', C: '' }])).arrayBuffer()
      )
    );
    expect(sheet.rows[1]).toEqual(['007', '=1+1', '']);
    expect(sheet.sheetXml).not.toContain('<f>');
  });

  it('drops the control characters XML cannot hold', () => {
    const [, [cell]] = xlsxSheetData(['A'], [{ A: 'Team\u0001 A' }]);
    expect(cell).toEqual({ value: 'Team A', type: String });
  });
});

describe('the calendar download', () => {
  it('parses, and round-trips every event the export holds', async () => {
    const { read, rows } = await readTeamA();
    const now = new Date('2026-10-25T12:00:00Z');
    const ics = await teamCalendarIcs({
      teamName: TEAM.name,
      orgName: 'Mock League',
      timeZone: ZONE,
      rows: read.rows,
      now,
    });
    const { calendar, events } = parseIcs(ics);
    expect(calendar['X-WR-TIMEZONE']).toBe(ZONE);
    expect(calendar['X-WR-CALNAME']).toBe('Team A Schedule');

    const byUid = new Map(events.map((e) => [e.UID.value, e]));
    expect(byUid.size).toBe(events.length); // UIDs are unique
    const dated = [];
    read.events.forEach((event, index) => {
      const row = rows[index];
      if (!row[H.DATE]) return;
      dated.push(row);
      const uid = `${event.type === 'game' ? event.id : `${event.id}_${event.date}`}@squadlogic.app`;
      const vevent = byUid.get(uid);
      expect(vevent, uid).toBeDefined();
      expect(vevent.DTSTAMP.value).toBe('20261025T120000Z');
      if (row[H.START]) {
        // A timed event: its UTC instants read back as the row's wall times.
        expect(wallOf(vevent.DTSTART.value)).toEqual([row[H.DATE], row[H.START]]);
        expect(wallOf(vevent.DTEND.value)).toEqual([row[H.DATE], row[H.END]]);
        expect(vevent.SUMMARY.value).toBe(
          row[H.EVENT_TYPE] === 'Game'
            ? 'Game: Team A'
            : row[H.STATUS] === 'Moved'
              ? 'Practice (moved) - Team A'
              : 'Practice - Team A'
        );
        expect(vevent.LOCATION.value).toBe('Central Park, Field 1');
      } else {
        // A day with no time: an all-day TIME TBD entry carrying its reason code.
        expect(vevent.DTSTART.params.VALUE).toBe('DATE');
        expect(vevent.DTSTART.value).toBe(row[H.DATE].replace(/-/g, ''));
        expect(vevent.SUMMARY.value.startsWith('TIME TBD - ')).toBe(true);
        expect(vevent.STATUS.value).toBe('TENTATIVE');
        expect(vevent.DESCRIPTION.value).toContain(`(${row[H.REASON_CODE]})`);
      }
    });
    // Nothing extra: one entry per dated row, and the undated ones counted.
    expect(events).toHaveLength(dated.length);
    expect(dated).toHaveLength(6);
    const untimed = rows.filter((row) => !row[H.START]).length;
    expect(calendar['X-WR-CALDESC']).toContain(
      `${untimed} of ${rows.length} events have no confirmed time`
    );
    expect(calendar['X-WR-CALDESC']).toContain(
      'except 3 with no known day, which appear only here'
    );
  });

  it('says the practice changes are unread, as the feed does', async () => {
    const { read } = await readTeamA();
    const ics = await teamCalendarIcs({
      teamName: TEAM.name,
      orgName: 'Mock League',
      timeZone: ZONE,
      rows: read.rows,
      practiceChangesUnread: true,
    });
    expect(parseIcs(ics).calendar['X-WR-CALDESC']).toContain(
      'INCOMPLETE: practice changes could not be read'
    );
  });

  it('places nothing on a clock when the season has no timezone, and names no zone', async () => {
    const { read } = await readTeamA();
    const { calendar, events } = parseIcs(
      await teamCalendarIcs({
        teamName: TEAM.name,
        orgName: 'Mock League',
        timeZone: null,
        rows: read.rows,
      })
    );
    expect(calendar['X-WR-TIMEZONE']).toBeUndefined();
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) expect(event.DTSTART.params.VALUE).toBe('DATE');
  });

  it('renames the page’s embeds to the feed’s and changes nothing else', () => {
    const slot = {
      slot_date: '2026-11-07',
      start_time: '10:00:00',
      start: null,
      field: { name: 'F', location: { name: 'L' } },
    };
    const feed = feedRowsOf({
      games: [
        { id: 'g', game_slot: slot },
        { id: 'h', game_slot: null },
      ],
      practices: [{ id: 'p', effective_date_range: '[2026-11-02,2026-11-30)', slot: null }],
      exceptions: [{ id: 'x', kind: 'time_tbd', slot: null }],
    });
    expect(feed.games[0].game_slots).toMatchObject({
      slot_date: '2026-11-07',
      start_time: '10:00:00',
      fields: { name: 'F', locations: { name: 'L' } },
    });
    expect(feed.games[1].game_slots).toBeNull();
    expect(feed.practices[0]).toEqual({
      id: 'p',
      effective_date_range: '[2026-11-02,2026-11-30)',
      practice_slots: null,
    });
    expect(feed.exceptions[0]).toEqual({ id: 'x', kind: 'time_tbd', slot: null });
    expect(feedRowsOf(undefined)).toEqual({ games: [], practices: [], exceptions: [] });
  });
});
