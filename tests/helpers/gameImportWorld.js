/**
 * One small league and one schedule file that reaches every outcome of the games import, for the tests that drive the
 * REAL mock client (`frontend/src/lib/mockSupabaseClient.js`) through the panel's own calls (PR 6: the panel, the
 * preview twin, the preview-stale twin, the round trip). Nothing here writes a state the production path cannot reach:
 * the league is seeded as tables, and everything the import does is done by `import-validation` and the games RPCs.
 *
 * Every value is an invented placeholder, in the shape of `fixtures/schedule-2026/`.
 */
import { seedMockDb } from './seedMockDb.js';

export const ORG = '0a000000-0000-4000-8000-000000000001';
export const SEASON = '0a000000-0000-4000-8000-000000000002';
export const ADMIN = '0a000000-0000-4000-8000-000000000003';
export const DIVISION = '0a000000-0000-4000-8000-000000000010';
export const VENUE = '0a000000-0000-4000-8000-000000000020';
export const FIELD_1 = '0a000000-0000-4000-8000-000000000021';
export const FIELD_2 = '0a000000-0000-4000-8000-000000000022';
export const RUN = '0a000000-0000-4000-8000-000000000030';
const team = (n) => `0a000000-0000-4000-8000-0000000001${String(n).padStart(2, '0')}`;
export const TEAMS = Object.freeze({ t1: team(1), t2: team(2), t3: team(3), t4: team(4), t5: team(5), t6: team(6) });
export const SAVED = Object.freeze({
  open: '0a000000-0000-4000-8000-000000000041',
  published: '0a000000-0000-4000-8000-000000000042',
  untouched: '0a000000-0000-4000-8000-000000000043',
});
const SLOT = (n) => `0a000000-0000-4000-8000-0000000000${50 + n}`;

export const SEASON_ROW = Object.freeze({
  id: SEASON,
  organization_id: ORG,
  name: 'Fall 2026',
  status: 'active',
  season_start: '2026-09-07',
  season_end: '2027-03-31',
  timezone: 'America/Los_Angeles',
});

const slot = (n, field, date, start, end, week) => ({
  id: SLOT(n),
  organization_id: ORG,
  field_id: field,
  division_id: null,
  slot_date: date,
  start_time: start,
  end_time: end,
  week_index: week,
  capacity: 1,
  start: `${date}T${start}:00-07:00`,
  end: `${date}T${end}:00-07:00`,
  created_at: '2026-08-01T00:00:00Z',
});
const saved = (id, ref, s, home, away, published) => ({
  id,
  organization_id: ORG,
  season_settings_id: SEASON,
  run_id: RUN,
  game_slot_id: s.id,
  slot_id: s.id,
  field_id: s.field_id,
  home_team_id: home,
  away_team_id: away,
  division: 'U05 Boys',
  week_index: s.week_index,
  start: s.start,
  end: s.end,
  assignment_source: 'auto',
  external_ref: ref,
  import_job_id: null,
  published,
  published_at: published ? '2026-09-01T12:00:00Z' : null,
  published_by: published ? ADMIN : null,
  created_at: '2026-08-02T00:00:00Z',
});

/** Seed the league from nothing. Returns the season row, as the Organization context would hand it to the panel. */
export function seedGameImportWorld() {
  sessionStorage.clear();
  delete window.__MOCK_DB__;
  const slots = [
    slot(1, FIELD_1, '2026-09-12', '08:00', '09:00', 1),
    slot(2, FIELD_2, '2026-09-12', '08:00', '09:00', 1),
    slot(3, FIELD_1, '2026-09-19', '08:00', '09:00', 2),
  ];
  seedMockDb({
    organizations: [{ id: ORG, name: 'Placeholder League', is_onboarded: true }],
    organization_members: [{ organization_id: ORG, profile_id: ADMIN, role: 'admin' }],
    profiles: [{ id: ADMIN, full_name: 'Placeholder Admin' }],
    season_settings: [{ ...SEASON_ROW }],
    divisions: [{ id: DIVISION, organization_id: ORG, season_settings_id: SEASON, name: 'U05 Boys' }],
    teams: Object.values(TEAMS).map((id, i) => ({
      id,
      organization_id: ORG,
      division_id: DIVISION,
      name: `U05B Team 0${i + 1}`,
      is_external: false,
    })),
    locations: [{ id: VENUE, organization_id: ORG, name: 'Venue A', effective_to: null }],
    fields: [
      { id: FIELD_1, organization_id: ORG, location_id: VENUE, name: 'Field 1', active: true },
      { id: FIELD_2, organization_id: ORG, location_id: VENUE, name: 'Field 2', active: true },
    ],
    game_slots: slots,
    scheduler_runs: [
      {
        id: RUN,
        organization_id: ORG,
        run_type: 'game',
        status: 'completed',
        season_settings_id: SEASON,
        completed_at: '2026-09-01T12:00:00Z',
        created_at: '2026-09-01T12:00:00Z',
        results: { warnings: [] },
      },
    ],
    game_assignments: [
      // found by Game ID and moved by the file
      saved(SAVED.open, 'S-1', slots[0], TEAMS.t1, TEAMS.t2, false),
      // Published, and the file would move it: skipped
      saved(SAVED.published, 'S-2', slots[1], TEAMS.t3, TEAMS.t4, true),
      // not named by the file at all
      saved(SAVED.untouched, 'S-3', slots[2], TEAMS.t5, TEAMS.t6, false),
    ],
    schedule_tbd: [],
    staging_import_rows: [],
    import_jobs: [],
    import_application_records: [],
    audit_log: [],
  });
  sessionStorage.setItem('__MOCK_SESSION__', JSON.stringify({ user: { id: ADMIN } }));
  return { ...SEASON_ROW };
}

export const FILE_HEADERS = [
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
  'Notes',
];
const r = (id, date, start, end, field, home, away, week = '', over = {}) => ({
  'Game ID': id,
  Date: date,
  'Start Time': start,
  'End Time': end,
  Venue: 'Venue A',
  Field: field,
  Division: 'U05 Boys',
  'Home Team': home,
  'Away Team': away,
  Week: week,
  Notes: 'a placeholder note that is never stored',
  ...over,
});

/**
 * The file, one row per outcome (the row numbers are named by the tests):
 *
 *  1  S-1  a saved game found by its Game ID, moved to 10:00: UPDATED
 *  2  S-2  a Published game the file would move: SKIPPED (skipped-published)
 *  3  N-1  a new game: INSERTED
 *  4  N-2  a new game on the same field at an overlapping time: INSERTED and flagged field-overlap
 *  5  N-3  against `Visiting Club A`, no such team: an OUTSIDE CLUB when the admin says so
 *  6  N-4  on `Field 9`, no such field: CREATED when the admin says so
 *  7  N-5  in `U07 Girls`, no such division, two new teams: CREATED when the admin says so
 *  8  N-6  a time the import cannot read (`25:00`): a dated TIME TBD game, with a bad-time warning
 *  9  N-7  no time at all: a TIME TBD game
 * 10  N-8  a date the import cannot read: REFUSED bad-date
 * 11  N-9  against `Mystery Team`, which nobody decides: REFUSED unknown-team
 * 12  N-10 a Week that is not the date's: INSERTED and flagged week-differs
 * 13  N-11 a Week that cannot be stored (`three`): INSERTED in the week derived from the date, with a bad-week warning
 */
export const FILE_ROWS = [
  r('S-1', '2026-09-12', '10:00', '11:00', 'Field 1', 'U05B Team 01', 'U05B Team 02', '1'),
  r('S-2', '2026-09-12', '12:00', '13:00', 'Field 2', 'U05B Team 03', 'U05B Team 04', '1'),
  r('N-1', '2026-09-26', '09:00', '10:00', 'Field 1', 'U05B Team 01', 'U05B Team 03', '3'),
  r('N-2', '2026-09-26', '09:30', '10:30', 'Field 1', 'U05B Team 02', 'U05B Team 04', '3'),
  r('N-3', '2026-10-03', '09:00', '10:00', 'Field 2', 'U05B Team 05', 'Visiting Club A', '4'),
  r('N-4', '2026-10-03', '11:00', '12:00', 'Field 9', 'U05B Team 06', 'U05B Team 01', '4'),
  r('N-5', '2026-10-10', '09:00', '10:00', 'Field 1', 'U07G Team 01', 'U07G Team 02', '5', {
    Division: 'U07 Girls',
  }),
  r('N-6', '2026-10-10', '25:00', '26:00', 'Field 2', 'U05B Team 03', 'U05B Team 05', '5'),
  r('N-7', '2026-10-17', '', '', 'Field 1', 'U05B Team 04', 'U05B Team 06', '6'),
  r('N-8', '13/04/2026', '09:00', '10:00', 'Field 1', 'U05B Team 01', 'U05B Team 04', ''),
  r('N-9', '2026-10-24', '09:00', '10:00', 'Field 2', 'U05B Team 02', 'Mystery Team', '7'),
  r('N-10', '2026-10-31', '09:00', '10:00', 'Field 1', 'U05B Team 05', 'U05B Team 02', '3'),
  r('N-11', '2026-11-07', '09:00', '10:00', 'Field 2', 'U05B Team 06', 'U05B Team 03', 'three'),
];

/** The file as CSV text. @param {Array<Record<string, string>>} [rows] */
export function fileCsv(rows = FILE_ROWS) {
  const cell = (v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return [FILE_HEADERS, ...rows.map((row) => FILE_HEADERS.map((h) => row[h] ?? ''))]
    .map((line) => line.map(cell).join(','))
    .join('\n');
}

/** The choices that reach every outcome: an outside club, a created field, division and teams; one label left alone. */
export const EVERY_OUTCOME_CHOICES = Object.freeze({
  teams: {
    'Visiting Club A': 'outside',
    'U07G Team 01': 'create',
    'U07G Team 02': 'create',
  },
  fields: { 'Field 9': 'create' },
  divisions: { 'U07 Girls': 'create' },
});
