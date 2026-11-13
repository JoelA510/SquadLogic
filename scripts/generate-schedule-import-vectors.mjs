#!/usr/bin/env node
/**
 * Regenerate `supabase/functions/_shared/tests/fixtures/schedule-import.vectors.json` from the canonical games
 * import, `packages/core/src/scheduleImport/` (plan `docs/changes/2026-11-03-schedule-expansion.md`, PR 6, task F1).
 *
 * The Edge function cannot import core, so it runs a mirror (`supabase/functions/_shared/schedule-import.ts`). This
 * table is what holds the mirror to core in the runtime it is deployed to: each vector is a chunk of a file and what
 * core stages for it; `tests/gameImportEdgeParity.test.js` fails on a table core no longer reproduces (so a stale
 * table cannot sit green) and runs the mirror over it under Vitest; `_shared/tests/schedule-import_test.ts` asks the
 * Deno build the same.
 *
 * Every value is an invented placeholder (`Venue A`, `U05B Team 01`), as `fixtures/schedule-2026/` is. The dates and
 * zones are named because the clock is what is being tested: a spring-forward gap, a fall-back hour, a zone on a
 * half-hour offset, a zone in the southern hemisphere, and one whose clocks move by thirty minutes.
 *
 *   node scripts/generate-schedule-import-vectors.mjs          # write the table
 *   node scripts/generate-schedule-import-vectors.mjs --check  # exit 1 when the checked-in table differs
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { stageScheduleChunk } from '../packages/core/src/scheduleImport/staging.js';
// The cell cleaner is the import pipeline's own (the browser's copy; the Edge function holds its twin).
import { sanitizeImportText } from '../frontend/src/utils/importRows.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SCHEDULE_IMPORT_VECTORS_PATH =
  'supabase/functions/_shared/tests/fixtures/schedule-import.vectors.json';

const HEADERS = [
  'Game ID',
  'Date',
  'Start Time',
  'End Time',
  'Venue',
  'Field',
  'Division',
  'Home Team',
  'Away Team',
  'Week',
];
const row = (over = {}) => ({
  'Game ID': 'V-1',
  Date: '2026-09-12',
  'Start Time': '09:00',
  'End Time': '10:00',
  Venue: 'Venue A',
  Field: 'Field 1',
  Division: 'U05 Boys',
  'Home Team': 'U05B Team 01',
  'Away Team': 'U05B Team 02',
  Week: '',
  ...over,
});
const season = (timeZone, over = {}) => ({
  timeZone,
  startDate: '2026-09-07',
  endDate: '2027-04-30',
  ...over,
});
const LA = 'America/Los_Angeles';
const lengthHeaders = HEADERS.filter((h) => h !== 'End Time').concat('Length');
const withLength = (over) => {
  const r = row(over);
  delete r['End Time'];
  return r;
};
/** The header row with the Game ID moved to column `at`, after filler columns the import does not read. */
const gameIdAt = (at) => [
  ...HEADERS.filter((h) => h !== 'Game ID'),
  ...Array.from({ length: at - HEADERS.length }, (_, i) => `Extra ${i}`),
  'Game ID',
];

/** The inputs: a name, a season, a header row, rows, and how many rows came before. */
export const SCHEDULE_IMPORT_VECTOR_INPUTS = [
  {
    name: 'a plain placed game, a 12-hour time and a US date',
    season: season(LA),
    headers: HEADERS,
    rows: [
      row(),
      row({ 'Game ID': 'V-2', Date: '9/19/2026', 'Start Time': '9:00 AM', 'End Time': '10:15 AM' }),
    ],
  },
  {
    name: 'US spring forward: 02:30 on 2027-03-14 does not exist (refused); 01:30 and 03:30 are placed',
    season: season(LA),
    headers: HEADERS,
    rows: [
      row({ 'Game ID': 'V-1', Date: '2027-03-14', 'Start Time': '02:30', 'End Time': '03:30' }),
      row({ 'Game ID': 'V-2', Date: '2027-03-14', 'Start Time': '01:30', 'End Time': '03:30' }),
    ],
  },
  {
    name: 'US fall back: 01:30 on 2026-11-01 happens twice; the first occurrence is taken and flagged',
    season: season(LA),
    headers: HEADERS,
    rows: [row({ Date: '2026-11-01', 'Start Time': '01:30', 'End Time': '02:30' })],
  },
  {
    name: 'a half-hour zone with no clock change (Asia/Kolkata, +05:30)',
    season: season('Asia/Kolkata'),
    headers: HEADERS,
    rows: [row({ 'Start Time': '18:45', 'End Time': '19:45' })],
  },
  {
    name: 'southern hemisphere (Australia/Sydney): the gap is in October, the repeated hour in April',
    season: season('Australia/Sydney'),
    headers: HEADERS,
    rows: [
      row({ 'Game ID': 'V-1', Date: '2026-10-04', 'Start Time': '02:30', 'End Time': '03:30' }),
      row({ 'Game ID': 'V-2', Date: '2027-04-04', 'Start Time': '02:30', 'End Time': '03:30' }),
      row({ 'Game ID': 'V-3', Date: '2026-12-12', 'Start Time': '09:00', 'End Time': '10:00' }),
    ],
  },
  {
    name: 'a southern half-hour zone (Australia/Adelaide, +09:30 and +10:30)',
    season: season('Australia/Adelaide'),
    headers: HEADERS,
    rows: [
      row({ 'Game ID': 'V-1', Date: '2026-09-12' }),
      row({ 'Game ID': 'V-2', Date: '2026-12-12' }),
      row({ 'Game ID': 'V-3', Date: '2026-10-04', 'Start Time': '02:15', 'End Time': '03:15' }),
    ],
  },
  {
    name: 'clocks that move by thirty minutes (Australia/Lord_Howe): 02:15 is skipped in October, 01:45 repeats in April',
    season: season('Australia/Lord_Howe'),
    headers: HEADERS,
    rows: [
      row({ 'Game ID': 'V-1', Date: '2026-10-04', 'Start Time': '02:15', 'End Time': '03:15' }),
      row({ 'Game ID': 'V-2', Date: '2027-04-04', 'Start Time': '01:45', 'End Time': '03:00' }),
    ],
  },
  {
    name: 'a Length is elapsed time from the resolved start, across the fall-back hour',
    season: season(LA),
    headers: lengthHeaders,
    rows: [
      withLength({ 'Game ID': 'V-1', Date: '2026-11-01', 'Start Time': '00:30', Length: '90' }),
      withLength({ 'Game ID': 'V-2', 'Start Time': '9:00 AM', Length: '55' }),
    ],
  },
  {
    name: 'F5: a time that cannot be read is a dated TIME TBD game, a week that cannot be stored is derived',
    season: season(LA),
    headers: HEADERS,
    rows: [
      row({ 'Game ID': 'V-1', 'Start Time': '25:00', 'End Time': '26:00' }),
      row({ 'Game ID': 'V-2', 'End Time': 'noon', 'Home Team': 'U05B Team 03' }),
      row({ 'Game ID': 'V-3', Week: 'three', Date: '2026-10-24', 'Home Team': 'U05B Team 04' }),
      row({ 'Game ID': 'V-4', Week: '3', 'Home Team': 'U05B Team 05' }),
      row({ 'Game ID': 'V-5', Week: 'three', Date: '2026-08-29', 'Home Team': 'U05B Team 06' }),
    ],
  },
  {
    name: 'no time, no field, and the refusals a row can meet',
    season: season(LA),
    headers: HEADERS,
    rows: [
      row({ 'Game ID': 'V-1', 'Start Time': '', 'End Time': '' }),
      row({ 'Game ID': 'V-2', Field: '', 'Home Team': 'U05B Team 03' }),
      row({ 'Game ID': 'V-3', Date: '13/04/2026' }),
      row({ 'Game ID': 'V-4', 'Start Time': '10:00', 'End Time': '09:30' }),
      row({ 'Game ID': 'V-5', 'Away Team': 'u05b  team 01' }),
      row({ 'Game ID': 'V-6', Date: '2026-08-29' }),
      row({ 'Game ID': 'G'.repeat(41) }),
      row({ 'Game ID': 'V-8', Division: ' ' }),
      row({ 'Game ID': 'V-9', 'Home Team': '' }),
      row({ 'Game ID': 'V-10', Venue: '', 'Home Team': 'U05B Team 04' }),
    ],
  },
  {
    name: 'headers as a file may spell them: a trailing space, a no-break space, another case, a byte order mark',
    season: season(LA),
    headers: [
      '\ufeffGame ID',
      'DATE',
      'Start Time ',
      'End\u00a0Time',
      ' Venue',
      'Field',
      'Division',
      'Home Team',
      'Away Team',
      'Week',
    ],
    rows: [
      {
        '\ufeffGame ID': 'V-1',
        DATE: '2026-09-12',
        'Start Time ': '09:00',
        'End\u00a0Time': '10:00',
        ' Venue': 'Venue A',
        Field: 'Field 1',
        Division: 'U05 Boys',
        'Home Team': 'U05B Team 01',
        'Away Team': 'U05B Team 02',
        Week: '',
      },
    ],
  },
  {
    name: 'the same game twice, and one Game ID on two games',
    season: season(LA),
    headers: HEADERS,
    rows: [
      row({ 'Game ID': 'V-1' }),
      row({ 'Game ID': 'V-1' }),
      row({ 'Game ID': 'V-1', Date: '2026-09-19', 'Home Team': 'U05B Team 03' }),
    ],
  },
  {
    name: 'only the allowlisted columns are read: a note, a coach and an email are dropped, markup is stripped',
    season: season(LA),
    headers: [...HEADERS, 'Notes', 'Coach Email', 'Format'],
    rows: [
      {
        ...row({ Venue: '<b>Venue A</b>', 'Home Team': '  U05B   Team 01 ' }),
        Notes: 'call the placeholder coach',
        'Coach Email': 'coach.placeholder@example.com',
        Format: '4v4',
        Unlisted: 'never read',
      },
    ],
  },
  {
    name: 'a later chunk: the row number and key are the place in the file',
    season: season(LA),
    headers: HEADERS,
    rowOffset: 500,
    rows: [row({ 'Game ID': 'V-501' }), row({ 'Game ID': 'V-502', 'Home Team': 'U05B Team 03' })],
  },
  {
    name: 'file refused: past the 2,400-row limit, counted from the offset',
    season: season(LA),
    headers: HEADERS,
    rowOffset: 2399,
    rows: [row({ 'Game ID': 'V-2400' }), row({ 'Game ID': 'V-2401', 'Home Team': 'U05B Team 03' })],
  },
  {
    name: 'a recognised column at 200 (the Game ID) is read: every column of the cap is kept',
    season: season(LA),
    headers: gameIdAt(200),
    rows: [row()],
  },
  {
    name: 'file refused: a recognised column at 201 (the Game ID); the header row is never cut',
    season: season(LA),
    headers: gameIdAt(201),
    rows: [row()],
  },
  {
    name: 'file refused: a missing column',
    season: season(LA),
    headers: HEADERS.filter((h) => h !== 'Venue'),
    rows: [row()],
  },
  {
    name: 'file refused: the season has no time zone',
    season: season(null),
    headers: HEADERS,
    rows: [row()],
  },
  {
    name: 'file refused: a time zone the runtime does not know',
    season: season('Mars/Olympus_Mons'),
    headers: HEADERS,
    rows: [row()],
  },
  {
    name: 'file refused: no Week column and no season start to derive one from',
    season: season(LA, { startDate: null, endDate: null }),
    headers: HEADERS.filter((h) => h !== 'Week'),
    rows: [row()],
  },
];

/** The table: every input with what core stages for it. */
export function buildScheduleImportVectors() {
  return {
    comment:
      'Generated by scripts/generate-schedule-import-vectors.mjs from packages/core/src/scheduleImport. Do not edit by hand. Every value is an invented placeholder.',
    vectors: SCHEDULE_IMPORT_VECTOR_INPUTS.map((input) => ({
      name: input.name,
      season: input.season,
      headers: input.headers,
      rowOffset: input.rowOffset ?? 0,
      rows: input.rows,
      expected: stageScheduleChunk({
        clean: sanitizeImportText,
        headers: input.headers,
        rows: input.rows,
        season: input.season,
        rowOffset: input.rowOffset ?? 0,
      }),
    })),
  };
}

export const serialiseScheduleImportVectors = (table) => `${JSON.stringify(table, null, 2)}\n`;

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = path.join(REPO_ROOT, SCHEDULE_IMPORT_VECTORS_PATH);
  const text = serialiseScheduleImportVectors(buildScheduleImportVectors());
  if (process.argv.includes('--check')) {
    const current = readFileSync(out, 'utf8');
    if (current !== text) {
      console.error(
        `${SCHEDULE_IMPORT_VECTORS_PATH} differs from what core produces: regenerate it`
      );
      process.exit(1);
    }
    console.log('the schedule import vectors match core');
  } else {
    writeFileSync(out, text);
    console.log(`wrote ${SCHEDULE_IMPORT_VECTORS_PATH}`);
  }
}
