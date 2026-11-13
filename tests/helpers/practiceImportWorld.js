/**
 * One small league and one practice file that reaches every outcome of the practice schedule import (plan
 * `docs/changes/2026-11-03-schedule-expansion.md` 4.11; PR 11), for the tests that drive the Practices tab and its
 * client against the REAL mock client: the league is seeded as tables, and everything the import does is done by the
 * mock's `import-validation` and the practice import RPCs (`frontend/src/lib/mockPracticeImport.js`, held to the
 * migration by `tests/mockPracticeImport.test.js`). Every name is a placeholder.
 *
 * The world, and the row of the file that reaches each outcome (`FILE_ROWS`, numbered from 1):
 *
 * | row | what it is | outcome |
 * | --- | --- | --- |
 * | 1, 2 | U10B-01 and U10B-02 on the two halves of Field 1, Tue 16:00 | inserted; U10B-01's coach also coaches U12G-01 (row 3) |
 * | 3, 4 | U12G-01, Tue 16:30 and Thu 16:00 on Field 2 | inserted; `coach-conflict` with row 1 |
 * | 5 | an open slot, Wed 16:00 on Field 1 | a slot, no team |
 * | 6 | a hold, Wed 17:00 on Field 1 | listed as a hold whose ground is known |
 * | 7 | U10B-03 on Thu 17:00, while its saved practice (Mon, the fall) is not in the file | a probable move, held back until ticked |
 * | 8 | U12G-02, its saved practice exactly | unchanged |
 * | 9 | U10B-04 at "Venue A Annex" | the alias file proposes Venue A; until chosen, `unknown-location` |
 * | 10 | U14B-01 of the new division U14 Boys, at the new Venue B, Field 9 | division, team, location and field created |
 * | 11 | U12G-03 on Field 2 half C, Sat 09:00 | a half created; U12G-03 is one short of its division's two |
 * | 12 | "Funday" | `bad-day` (the parse) |
 * | 13 | a blank Location | `unknown-location`, "The Location is blank." (the parse) |
 * | 14 | an open slot that names the saved Mon 16:00 slot with another End | `slot-differs`, naming the End (the database) |
 * | 15 | U10B-05, a team the admin skips | skipped |
 *
 * The Coach column is dropped before staging (the allowlist); its values appear in no table.
 */
import Papa from 'papaparse';
import { seedMockDb } from './seedMockDb.js';

export const ORG = '0b000000-0000-4000-8000-000000000001';
export const SEASON = '0b000000-0000-4000-8000-000000000002';
export const ADMIN = '0b000000-0000-4000-8000-000000000003';
export const DIVISIONS = Object.freeze({
  u10: '0b000000-0000-4000-8000-000000000010',
  u12: '0b000000-0000-4000-8000-000000000011',
});
export const VENUE_A = '0b000000-0000-4000-8000-000000000020';
export const FIELD_1 = '0b000000-0000-4000-8000-000000000021';
export const FIELD_2 = '0b000000-0000-4000-8000-000000000022';
export const HALF_A = '0b000000-0000-4000-8000-000000000023';
export const HALF_B = '0b000000-0000-4000-8000-000000000024';
export const SAVED_SLOT_MON = '0b000000-0000-4000-8000-000000000030';
export const SAVED_SLOT_WED = '0b000000-0000-4000-8000-000000000031';
export const SAVED = Object.freeze({
  u10b03: '0b000000-0000-4000-8000-000000000040',
  u12g02: '0b000000-0000-4000-8000-000000000041',
});
export const COACH = '0b000000-0000-4000-8000-000000000050';
/** A ground only a hold names in `HOLD_ONLY_ROW` (no placement or open slot is there), with a saved, unused slot. */
export const VENUE_C = '0b000000-0000-4000-8000-000000000025';
export const FIELD_C1 = '0b000000-0000-4000-8000-000000000026';
export const SAVED_SLOT_C = '0b000000-0000-4000-8000-000000000032';
/** Venue C's Field 1 has a half "A" too, as Venue A's has (Codex's C4 repro on #732). */
export const HALF_CA = '0b000000-0000-4000-8000-000000000027';
export const RUN = '0b000000-0000-4000-8000-000000000060';

const team = (n) => `0b000000-0000-4000-8000-0000000001${String(n).padStart(2, '0')}`;
export const TEAMS = Object.freeze({
  'U10B-01': team(1),
  'U10B-02': team(2),
  'U10B-03': team(3),
  'U10B-04': team(4),
  'U10B-05': team(5),
  'U12G-01': team(11),
  'U12G-02': team(12),
  'U12G-03': team(13),
});

export const SEASON_ROW = Object.freeze({
  id: SEASON,
  organization_id: ORG,
  name: 'Fall 2026',
  status: 'active',
  season_start: '2026-09-07',
  season_end: '2027-03-31',
  timezone: 'America/Los_Angeles',
});

/** The saved practice of U10B-03 (a solver run's, in the fall) that row 7 would move. */
export const FALL_RANGE = '[2026-09-07,2026-12-21)';

/**
 * Seed the mock's tables. `savedRange` is U10B-03's saved practice's range (the fall, by default).
 *
 * @param {{ savedRange?: string }} [options]
 */
export function seedPracticeImportWorld({ savedRange = FALL_RANGE } = {}) {
  sessionStorage.clear();
  delete window.__MOCK_DB__;
  const stamp = '2026-09-01T12:00:00.000Z';
  const teamRow = (name, id) => ({
    id,
    organization_id: ORG,
    division_id: name.startsWith('U10') ? DIVISIONS.u10 : DIVISIONS.u12,
    name,
    is_external: false,
  });
  const slot = (id, day, start, end) => ({
    id,
    organization_id: ORG,
    field_id: FIELD_2,
    field_subunit_id: null,
    day_of_week: day,
    start_time: `${start}:00`,
    end_time: `${end}:00`,
    capacity: 1,
    valid_from: '2026-09-07',
    valid_until: '2027-03-31',
    label: null,
    division_id: null,
    created_at: stamp,
    updated_at: stamp,
  });
  const practice = (id, teamId, slotId, range) => ({
    id,
    organization_id: ORG,
    team_id: teamId,
    practice_slot_id: slotId,
    slot_id: null,
    field_id: FIELD_2,
    effective_date_range: range,
    source: 'auto',
    assigned_via: 'auto',
    run_id: RUN,
    created_at: stamp,
    updated_at: stamp,
  });
  seedMockDb({
    organizations: [{ id: ORG, name: 'Placeholder League', is_onboarded: true }],
    organization_members: [{ organization_id: ORG, profile_id: ADMIN, role: 'admin' }],
    profiles: [{ id: ADMIN, full_name: 'Placeholder Admin' }],
    season_settings: [{ ...SEASON_ROW }],
    divisions: [
      {
        id: DIVISIONS.u10,
        organization_id: ORG,
        season_settings_id: SEASON,
        name: 'U10 Boys',
        practices_per_week: 1,
        practice_minutes: null,
        max_roster_size: 12,
        min_roster_size: 8,
        target_team_size: 10,
        team_count_override: null,
        min_teams: 2,
        max_teams: 6,
      },
      {
        id: DIVISIONS.u12,
        organization_id: ORG,
        season_settings_id: SEASON,
        name: 'U12 Girls',
        practices_per_week: 2,
        practice_minutes: 60,
      },
    ],
    teams: Object.entries(TEAMS).map(([name, id]) => teamRow(name, id)),
    locations: [
      { id: VENUE_A, organization_id: ORG, name: 'Venue A', effective_to: null },
      { id: VENUE_C, organization_id: ORG, name: 'Venue C', effective_to: null },
    ],
    fields: [
      { id: FIELD_1, organization_id: ORG, location_id: VENUE_A, name: 'Field 1', active: true },
      { id: FIELD_2, organization_id: ORG, location_id: VENUE_A, name: 'Field 2', active: true },
      { id: FIELD_C1, organization_id: ORG, location_id: VENUE_C, name: 'Field 1', active: true },
    ],
    field_subunits: [
      { id: HALF_A, organization_id: ORG, field_id: FIELD_1, label: 'A', effective_to: null },
      { id: HALF_B, organization_id: ORG, field_id: FIELD_1, label: 'B', effective_to: null },
      { id: HALF_CA, organization_id: ORG, field_id: FIELD_C1, label: 'A', effective_to: null },
    ],
    practice_slots: [
      slot(SAVED_SLOT_MON, 'mon', '16:00', '17:00'),
      slot(SAVED_SLOT_WED, 'wed', '16:00', '17:00'),
      { ...slot(SAVED_SLOT_C, 'wed', '16:00', '17:00'), field_id: FIELD_C1 },
    ],
    practice_assignments: [
      practice(SAVED.u10b03, TEAMS['U10B-03'], SAVED_SLOT_MON, savedRange),
      practice(SAVED.u12g02, TEAMS['U12G-02'], SAVED_SLOT_WED, '[2026-09-07,2027-04-01)'),
    ],
    team_coach_assignments: [
      {
        id: '0b000000-0000-4000-8000-000000000070',
        organization_id: ORG,
        team_id: TEAMS['U10B-01'],
        coach_id: COACH,
        effective_from: '2026-09-01',
        effective_to: null,
      },
      {
        id: '0b000000-0000-4000-8000-000000000071',
        organization_id: ORG,
        team_id: TEAMS['U12G-01'],
        coach_id: COACH,
        effective_from: '2026-09-01',
        effective_to: null,
      },
    ],
    scheduler_runs: [
      {
        id: RUN,
        organization_id: ORG,
        run_type: 'practice',
        status: 'completed',
        season_settings_id: SEASON,
        completed_at: stamp,
        created_at: stamp,
        results: {},
      },
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
  'Team',
  'Division',
  'Day',
  'Start',
  'End',
  'Location',
  'Field',
  'Subunit',
  'Valid From',
  'Valid Until',
  'Capacity',
  'Use',
  'Coach',
];

const r = (cells) => ({
  Team: '',
  Division: '',
  Day: '',
  Start: '',
  End: '',
  Location: 'Venue A',
  Field: 'Field 1',
  Subunit: '',
  'Valid From': '',
  'Valid Until': '',
  Capacity: '',
  Use: '',
  Coach: '',
  ...cells,
});

/** The file (rows numbered from 1; the table above says what each reaches). */
export const FILE_ROWS = Object.freeze([
  r({
    Team: 'U10B-01',
    Division: 'U10 Boys',
    Day: 'Tue',
    Start: '16:00',
    End: '17:00',
    Subunit: 'A',
    Coach: 'Placeholder Coach',
  }),
  r({
    Team: 'U10B-02',
    Division: 'U10 Boys',
    Day: 'Tue',
    Start: '16:00',
    End: '17:00',
    Subunit: 'B',
  }),
  r({
    Team: 'U12G-01',
    Division: 'U12 Girls',
    Day: 'Tue',
    Start: '16:30',
    End: '17:30',
    Field: 'Field 2',
  }),
  r({
    Team: 'U12G-01',
    Division: 'U12 Girls',
    Day: 'Thu',
    Start: '16:00',
    End: '17:00',
    Field: 'Field 2',
  }),
  r({ Day: 'Wed', Start: '16:00', End: '17:00' }),
  r({ Day: 'Wed', Start: '17:00', End: '18:00', Use: 'hold' }),
  r({
    Team: 'U10B-03',
    Division: 'U10 Boys',
    Day: 'Thu',
    Start: '17:00',
    End: '18:00',
    Field: 'Field 2',
  }),
  r({
    Team: 'U12G-02',
    Division: 'U12 Girls',
    Day: 'Wed',
    Start: '16:00',
    End: '17:00',
    Field: 'Field 2',
    'Valid From': '2026-09-07',
    'Valid Until': '2027-03-31',
  }),
  r({
    Team: 'U10B-04',
    Division: 'U10 Boys',
    Day: 'Fri',
    Start: '16:00',
    End: '17:00',
    Location: 'Venue A Annex',
  }),
  r({
    Team: 'U14B-01',
    Division: 'U14 Boys',
    Day: 'Mon',
    Start: '18:00',
    End: '19:00',
    Location: 'Venue B',
    Field: 'Field 9',
  }),
  r({
    Team: 'U12G-03',
    Division: 'U12 Girls',
    Day: 'Sat',
    Start: '09:00',
    End: '10:00',
    Field: 'Field 2',
    Subunit: 'C',
  }),
  r({ Team: 'U10B-02', Division: 'U10 Boys', Day: 'Funday', Start: '16:00', End: '17:00' }),
  r({
    Team: 'U10B-02',
    Division: 'U10 Boys',
    Day: 'Fri',
    Start: '18:00',
    End: '19:00',
    Location: '',
  }),
  r({ Day: 'Mon', Start: '16:00', End: '17:30', Field: 'Field 2' }),
  r({
    Team: 'U10B-05',
    Division: 'U10 Boys',
    Day: 'Sat',
    Start: '11:00',
    End: '12:00',
    Field: 'Field 2',
  }),
]);

/** The same file with U10B-03's row in the spring (after its saved fall practice ends). */
export const SPRING_ROWS = Object.freeze(
  FILE_ROWS.map((row) =>
    row.Team === 'U10B-03'
      ? { ...row, 'Valid From': '2027-01-04', 'Valid Until': '2027-03-31' }
      : row
  )
);

/** A hold on Venue C, a ground no other row names, over its saved slot: `hold-over-open-slot` once its ground is known. */
export const HOLD_ONLY_ROW = Object.freeze(
  r({
    Day: 'Wed',
    Start: '16:00',
    End: '17:00',
    Location: 'Venue C',
    Field: 'Field 1',
    Use: 'hold',
  })
);

/** The alias file: one label of the practice file to one of the league's locations. */
export const ALIAS_CSV = 'Alias,Location,Field,Subunit\r\nVenue A Annex,Venue A,,\r\n';

/** @param {ReadonlyArray<Record<string, string>>} [rows] */
export function fileCsv(rows = FILE_ROWS) {
  return Papa.unparse({
    fields: FILE_HEADERS,
    data: rows.map((row) => FILE_HEADERS.map((h) => row[h])),
  });
}
