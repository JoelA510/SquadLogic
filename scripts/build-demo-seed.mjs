#!/usr/bin/env node
/**
 * Build the `demo_seed` rows from `fixtures/demo-2026/` (plan
 * `docs/changes/2026-10-22-demo-mode.md`, D3: "Its insert migration is generated from
 * `fixtures/demo-2026/*.csv` by `scripts/build-demo-seed.mjs`").
 *
 * Two generated regions, each between two markers, everything outside them hand-written;
 * `tests/demoSeed.test.js` regenerates both and compares, so the seed and the fixture cannot drift
 * and nobody hand-edits the generated SQL:
 *
 *   - **the league** (league, divisions, teams, players, coaches, team coaches) in
 *     `supabase/migrations/20261030010000_demo_sessions.sql`, applied in production and FROZEN: a
 *     fixture change that touches it fails the test until a new migration says so;
 *   - **the practice facility and each division's practice settings** in
 *     `supabase/migrations/20261110010000_demo_practices.sql` (Phase D, F), which replaces the
 *     grounds, halves and slots that migration 20261030010000 seeded, from the grid below.
 *
 * `fixtures/demo-2026/fields.csv` is itself generated, by {@link buildFieldsCsv}, so the grid is one
 * definition (`DEMO_GRID`) and the CSV cannot be hand-edited into a shape the seed does not have.
 *
 *   node scripts/build-demo-seed.mjs           rewrite fields.csv and the facility region
 *   node scripts/build-demo-seed.mjs --check   exit 1 when either, or the frozen league, differs
 *
 * What is kept is what an import of the fixture would store (docs/architecture/
 * gotsport-import-contract.md): a player's registration id, name, gender, natural age, status,
 * years played, coaching answer, buddy request and play-up flag; a coach's name and sign-in email.
 * Not carried, as an import drops them: birth dates, guardians, phones, payment plan, photo
 * consent, uniform size. The teams, rosters and coach assignments are the fixture's (an import
 * keeps the placement columns for teams formed outside SquadLogic; the demo is that league
 * already formed), and the facility grid is `fixtures/demo-2026/fields.csv`.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Papa from 'papaparse';
import { SYNTHETIC_HEAT_SITES } from '../tests/helpers/heatSyntheticSites.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEMO_FIXTURE_DIR = path.join(REPO_ROOT, 'fixtures', 'demo-2026');
export const DEMO_MIGRATION = path.join(
  REPO_ROOT,
  'supabase',
  'migrations',
  '20261030010000_demo_sessions.sql'
);
export const FACILITY_MIGRATION = path.join(
  REPO_ROOT,
  'supabase',
  'migrations',
  '20261110010000_demo_practices.sql'
);
export const BEGIN_MARK =
  '-- BEGIN GENERATED demo_seed rows (scripts/build-demo-seed.mjs; do not edit)';
export const END_MARK = '-- END GENERATED demo_seed rows';
export const FACILITY_BEGIN_MARK =
  '-- BEGIN GENERATED demo_seed facility rows (scripts/build-demo-seed.mjs; do not edit)';
export const FACILITY_END_MARK = '-- END GENERATED demo_seed facility rows';

/** The league's own settings: constants of the demo, not columns of the export. */
const LEAGUE = {
  organizationName: 'Demo league',
  timezone: 'America/Los_Angeles',
  seasonWeeks: 12,
};

/** On-field players per format, `fixtures/season-2026/game_formats.csv`. A team holds 2N - 3. */
const ON_FIELD = { 5: 4, 6: 4, 7: 5, 8: 5, 9: 7, 10: 7, 12: 9, 14: 11, 16: 11, 19: 11 };

/**
 * Division age bands (the README: U12 takes 11 and 12, U14 13-14, U16 15-16, U19 17-19; U4 takes
 * the 3- and 4-year-olds). A player under a band's minimum plays up.
 */
const BANDS = {
  4: [3, 4],
  5: [5, 5],
  6: [6, 6],
  7: [7, 7],
  8: [8, 8],
  9: [9, 9],
  10: [10, 10],
  12: [11, 12],
  14: [13, 14],
  16: [15, 16],
  19: [17, 19],
};

/** @param {string} file @param {string} dir */
export function load(file, dir) {
  const text = readFileSync(path.join(dir, file), 'utf8');
  const { data, errors } = Papa.parse(text, { header: true, skipEmptyLines: true });
  // Duplicate headers (the coach export repeats two) are reported, not fatal; only columns that
  // are unique in the file are read below.
  const fatal = errors.filter((e) => e.code !== 'DuplicateHeaders' && e.type !== 'FieldMismatch');
  if (fatal.length > 0) throw new Error(`${file}: ${JSON.stringify(fatal[0])}`);
  return /** @type {Record<string, string>[]} */ (data);
}

/**
 * A SQL string literal. The fixture holds placeholders only, so a backslash or a control
 * character is a defect (and `tests/sourceHygiene.test.js` forbids raw control characters).
 * @param {string | null | undefined} value
 */
export function lit(value) {
  if (value === null || value === undefined || value === '') return 'NULL';
  // eslint-disable-next-line no-control-regex
  if (/[\\\u0000-\u001f]/.test(value)) throw new Error(`unsafe character in "${value}"`);
  return `'${value.replace(/'/g, "''")}'`;
}

/** @param {boolean} value */
const bool = (value) => (value ? 'true' : 'false');

/**
 * One INSERT, rows sorted by the caller.
 * @param {string} table
 * @param {string[]} columns
 * @param {string[][]} rows rendered SQL values
 */
function insert(table, columns, rows) {
  const body = rows.map((r) => `  (${r.join(', ')})`).join(',\n');
  return `INSERT INTO demo_seed.${table} (${columns.join(', ')}) VALUES\n${body};\n`;
}

/** @param {string} name e.g. U05B01, U4A */
export function divisionOfTeam(name) {
  if (name.startsWith('U4')) return 'U4';
  const age = Number(name.slice(1, 3));
  return `U${age}${name[3]}`;
}

/**
 * The SQL that fills `demo_seed` with the league: its settings, divisions, teams, players, coaches
 * and each team's coaches. The practice facility is {@link buildDemoFacilitySql}.
 * @param {string} [fixtureDir] the directory holding the CSVs (the tests plant defects in a copy)
 * @returns {string}
 */
export function buildDemoPeopleSql(fixtureDir = DEMO_FIXTURE_DIR) {
  const players = load('players.csv', fixtureDir);
  const coaches = load('coaches.csv', fixtureDir);
  const buddyColumn = Object.keys(players[0]).find((h) => h.startsWith('If you have a buddy'));
  const yearsColumn = Object.keys(players[0]).find((h) => h.startsWith('How many years'));
  if (!buddyColumn || !yearsColumn) throw new Error('players.csv lost a column the seed reads');

  // ---- divisions and teams, from the teams the players name ----
  const teamNames = [...new Set(players.map((p) => p['Team Name']))].sort();
  const divisionKeys = [...new Set(teamNames.map(divisionOfTeam))].sort((a, b) => {
    const n = (k) => Number(k.slice(1).replace(/[BG]$/, ''));
    return n(a) - n(b) || a.localeCompare(b);
  });
  const ageOf = (key) => Number(key.slice(1).replace(/[BG]$/, ''));
  const divisionRows = divisionKeys.map((key) => {
    const age = ageOf(key);
    const [min, max] = BANDS[age];
    const u4 = age === 4;
    const gender = u4 ? 'coed' : key.endsWith('B') ? 'boys' : 'girls';
    return [
      lit(key),
      lit(key),
      lit(gender),
      lit(u4 ? 'Minis' : `${ON_FIELD[age]}v${ON_FIELD[age]}`),
      String(min),
      String(max),
      String(u4 ? 15 : 2 * ON_FIELD[age] - 3),
      bool(!u4),
    ];
  });
  const teamRows = teamNames.map((name) => [lit(name), lit(divisionOfTeam(name))]);

  // ---- players ----
  const minAge = (team) => BANDS[ageOf(divisionOfTeam(team))][0];
  const playerRows = players.map((p) => {
    const age = Number(p['Age Group']);
    const team = p['Team Name'];
    const coachAnswer = p["Can you coach for this player's team?"] ?? '';
    return [
      lit(p['Registration ID']),
      lit(p['First Name']),
      lit(p['Last Name']),
      lit(p['Gender']),
      String(age),
      lit(String(p['Waitlist']).toLowerCase() === 'true' ? 'waitlist' : 'active'),
      String(Number(p[yearsColumn])),
      bool(coachAnswer.trim().toLowerCase() === 'yes'),
      bool(age < minAge(team)),
      lit(p[buddyColumn]?.trim()),
      lit(team),
    ];
  });

  // ---- coaches and their teams ----
  const coachRows = [];
  const teamCoachRows = [];
  const seenOnTeam = new Map();
  const emailSeen = new Map();
  for (const c of coaches) {
    // Two email columns, one `email`: a blank never replaces a value, and where both are filled
    // the later column (Contact Email) wins (D1; _shared/import-rows.ts).
    let email = (c['Contact Email'] || '').trim() || (c['Email/UserID'] || '').trim();
    // `coaches.email` is unique, and the fixture lets a coach and a family share one address (a
    // coach who is a guardian): the later coach's local part gets a counter, as a second sign-in
    // would need its own address.
    const times = (emailSeen.get(email) ?? 0) + 1;
    emailSeen.set(email, times);
    if (times > 1) email = email.replace('@', `.${times}@`);
    const name = `${c['First Name']} ${c['Last Name']}`;
    coachRows.push([lit(name), lit(email), lit('active')]);
    const team = c['Team Name'];
    if (team) {
      const n = seenOnTeam.get(team) ?? 0;
      seenOnTeam.set(team, n + 1);
      teamCoachRows.push([lit(team), lit(name), lit(n === 0 ? 'lead' : 'assistant')]);
    }
  }

  const parts = [
    insert(
      'league',
      ['organization_name', 'timezone', 'season_weeks'],
      [[lit(LEAGUE.organizationName), lit(LEAGUE.timezone), String(LEAGUE.seasonWeeks)]]
    ),
    insert(
      'divisions',
      [
        'key',
        'name',
        'gender_policy',
        'play_format',
        'min_age',
        'max_age',
        'max_roster_size',
        'plays_games',
      ],
      divisionRows
    ),
    insert('teams', ['name', 'division_key'], teamRows),
    insert(
      'players',
      [
        'external_registration_id',
        'first_name',
        'last_name',
        'gender',
        'natural_age',
        'status',
        'years_played',
        'willing_to_coach',
        'play_up_requested',
        'buddy_request',
        'team_name',
      ],
      playerRows
    ),
    insert('coaches', ['full_name', 'email', 'status'], coachRows),
    insert('team_coaches', ['team_name', 'coach_name', 'role'], teamCoachRows),
  ];
  return parts.join('\n');
}

/**
 * The league's practice settings by division age (owner, 2026-10-27; plan
 * `docs/changes/2026-10-27-phase-d-scheduling.md`, F): U14 and older 2 practices a week of 90
 * minutes, U5 to U12 two of 60, and U4, which has no weekly division practice, one 30-minute
 * Saturday session per cohort (the sessions reserved to it on the grid; "it is truly a once weekly
 * practice in the example program... an odd case"). All of them are practices.
 * @param {number} age
 * @returns {{ practicesPerWeek: number, practiceMinutes: number }}
 */
export function practiceSettingsFor(age) {
  if (age === 4) return { practicesPerWeek: 1, practiceMinutes: 30 };
  if (age >= 14) return { practicesPerWeek: 2, practiceMinutes: 90 };
  return { practicesPerWeek: 2, practiceMinutes: 60 };
}

/**
 * The practice grid: ONE definition, written to `fixtures/demo-2026/fields.csv` by
 * {@link buildFieldsCsv} and read back from the CSV by everything else.
 *
 * **Sunset (owner, 2026-10-27).** Practices fit before sunset; only ONE lit ground may run past it;
 * past sunset is flagged, never blocked. Lighting is a venue's (`locations.lighting_available`), and
 * the demo has one lit venue, Eastgate Sports Complex, whose single ground carries the late and the
 * long practices. Every unlit ground's slots end by `UNLIT_LAST_END`, 19:00, which is before sunset
 * at the demo's latitude from late March to mid-September; in the other months the daylight pass
 * flags the late slots (it can not refuse them), which is the product behaving as the owner asked.
 * Sunset moves with the date and the grid does not, so no single grid fits a whole year: the README
 * measures it.
 *
 * Capacity, with the demand it carries (60-minute practices, two a week, 112 teams; 90-minute, 12
 * teams): nine unlit grounds of two halves give 18 halves x 5 weekdays x 3 hours = 270 sixty-minute
 * slots for 224 practices (83%); the lit ground gives 2 halves x 5 weekdays x 3 = 30 ninety-minute
 * slots for 24 practices (80%). `tests/demoPracticeSeed.test.js` proves the solver places the
 * visitor's 120 with none TIME TBD.
 */
export const DEMO_GRID = Object.freeze({
  weekdays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
  /** Every unlit slot ends by this time. */
  UNLIT_LAST_END: '19:00',
  /** The venues, in the order the synthetic coordinates are assigned (sorted by name). */
  lit: ['Eastgate Sports Complex'],
  /** Unlit grounds of two halves: venue, ground, surface. */
  unlitGrounds: [
    ['Orchard Park', 'Field 1', 'Grass'],
    ['Orchard Park', 'Field 2', 'Grass'],
    ['Orchard Park', 'Field 3', 'Grass'],
    ['Orchard Park', 'Field 4', 'Grass'],
    ['Riverside Fields', 'Field A', 'Grass'],
    ['Riverside Fields', 'Field B', 'Grass'],
    ['Riverside Fields', 'Field C', 'Grass'],
    ['Valley View Park', 'Field 1', 'Grass'],
    ['Valley View Park', 'Field 2', 'Grass'],
  ],
  unlitSlots: [
    ['16:00', '17:00'],
    ['17:00', '18:00'],
    ['18:00', '19:00'],
  ],
  /** The lit ground: venue, ground, surface, and its 90-minute slots. */
  litGround: [
    'Eastgate Sports Complex',
    'Field 1',
    'Turf',
    [
      ['16:00', '17:30'],
      ['17:30', '19:00'],
      ['19:00', '20:30'],
    ],
  ],
  /** U4's four 30-minute Saturday sessions, one cohort at a time, 15 minutes apart. */
  u4: {
    venue: 'Orchard Park',
    ground: 'Tot Lot',
    surface: 'Grass',
    sessions: [
      ['09:00', '09:30'],
      ['09:45', '10:15'],
      ['10:30', '11:00'],
      ['11:15', '11:45'],
    ],
  },
});

const FIELDS_HEADERS = [
  'Location',
  'Field',
  'Subunit',
  'Type',
  'Day',
  'Slot Date',
  'Start',
  'End',
  'Capacity',
  'Valid From',
  'Valid Until',
  'Surface Type',
  'Supports Halves',
  'Division',
];

/**
 * `fixtures/demo-2026/fields.csv` as {@link DEMO_GRID} defines it: the fields import's own columns,
 * rows ordered by venue, ground, half, weekday, start.
 * @returns {string}
 */
export function buildFieldsCsv() {
  const rows = [];
  const add = (location, field, subunit, day, [start, end], surface, halves, division) =>
    rows.push([
      location,
      field,
      subunit,
      'practice',
      day,
      '',
      start,
      end,
      '1',
      '',
      '',
      surface,
      halves ? 'yes' : 'no',
      division,
    ]);
  for (const [location, field, surface] of DEMO_GRID.unlitGrounds) {
    for (const half of ['A', 'B']) {
      for (const day of DEMO_GRID.weekdays) {
        for (const slot of DEMO_GRID.unlitSlots) add(location, field, half, day, slot, surface, true, '');
      }
    }
  }
  const [litLocation, litField, litSurface, litSlots] = DEMO_GRID.litGround;
  for (const half of ['A', 'B']) {
    for (const day of DEMO_GRID.weekdays) {
      for (const slot of litSlots) add(litLocation, litField, half, day, slot, litSurface, true, '');
    }
  }
  const { venue, ground, surface, sessions } = DEMO_GRID.u4;
  for (const slot of sessions) add(venue, ground, '', 'Sat', slot, surface, false, 'U4');
  const dayRank = (d) => ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(d);
  rows.sort(
    (a, b) =>
      a[0].localeCompare(b[0]) ||
      a[1].localeCompare(b[1]) ||
      a[2].localeCompare(b[2]) ||
      dayRank(a[4]) - dayRank(b[4]) ||
      a[6].localeCompare(b[6])
  );
  return `${[FIELDS_HEADERS, ...rows].map((r) => r.join(',')).join('\n')}\n`;
}

/**
 * The SQL that replaces the demo's practice facility and sets each division's practices:
 * `demo_seed.locations` (with their lighting), fields, halves, practice slots, and one UPDATE of
 * the divisions' `practices_per_week` and `practice_minutes`. The DELETEs of the rows 20261030010000
 * seeded are hand-written in the migration, before the region.
 * @param {string} [fixtureDir] the directory holding the CSVs (the tests plant defects in a copy)
 * @returns {string}
 */
export function buildDemoFacilitySql(fixtureDir = DEMO_FIXTURE_DIR) {
  const players = load('players.csv', fixtureDir);
  const fields = load('fields.csv', fixtureDir);
  const locations = [...new Set(fields.map((f) => f.Location))].sort();
  if (locations.length > SYNTHETIC_HEAT_SITES.length) {
    throw new Error(`${locations.length} venues but ${SYNTHETIC_HEAT_SITES.length} synthetic sites`);
  }
  const fieldKeys = new Map();
  for (const f of fields) fieldKeys.set(`${f.Location}\u0001${f.Field}`, f);
  const fieldRows = [...fieldKeys.values()]
    .sort((a, b) => a.Location.localeCompare(b.Location) || a.Field.localeCompare(b.Field))
    .map((f) => [
      lit(f.Location),
      lit(f.Field),
      lit(f['Surface Type']),
      bool(f['Supports Halves'].toLowerCase() === 'yes'),
    ]);
  const subunitKeys = new Set();
  for (const f of fields)
    if (f.Subunit) subunitKeys.add(`${f.Location}\u0001${f.Field}\u0001${f.Subunit}`);
  const subunitRows = [...subunitKeys].sort().map((k) => k.split('\u0001').map(lit));
  const DAY = { Mon: 'mon', Tue: 'tue', Wed: 'wed', Thu: 'thu', Fri: 'fri', Sat: 'sat', Sun: 'sun' };
  const slotRows = fields.map((f) => {
    if (f.Type !== 'practice') throw new Error(`fields.csv row of type ${f.Type}`);
    if (!DAY[f.Day]) throw new Error(`fields.csv day ${f.Day}`);
    return [
      lit(f.Location),
      lit(f.Field),
      lit(f.Subunit),
      lit(DAY[f.Day]),
      lit(f.Start),
      lit(f.End),
      String(Number(f.Capacity)),
      lit(f.Division),
    ];
  });

  const divisionKeys = [...new Set(players.map((p) => divisionOfTeam(p['Team Name'])))].sort(
    (a, b) => {
      const n = (k) => Number(k.slice(1).replace(/[BG]$/, ''));
      return n(a) - n(b) || a.localeCompare(b);
    }
  );
  const settingRows = divisionKeys.map((key) => {
    const { practicesPerWeek, practiceMinutes } = practiceSettingsFor(
      Number(key.slice(1).replace(/[BG]$/, ''))
    );
    return `  (${lit(key)}, ${practicesPerWeek}, ${practiceMinutes})`;
  });

  return [
    insert(
      'locations',
      ['name', 'latitude', 'longitude', 'lighting_available'],
      // The venues sit on the repo's made-up sites (tests/helpers/heatSyntheticSites.js, in the Pacific
      // time zone, the first one turf): no real location enters the repo (tests/heatSyntheticCoordinates).
      locations.map((name, i) => [
        lit(name),
        SYNTHETIC_HEAT_SITES[i].latitude.toFixed(4),
        SYNTHETIC_HEAT_SITES[i].longitude.toFixed(4),
        bool(DEMO_GRID.lit.includes(name)),
      ])
    ),
    insert('fields', ['location_name', 'name', 'surface_type', 'supports_halves'], fieldRows),
    insert('field_subunits', ['location_name', 'field_name', 'label'], subunitRows),
    insert(
      'practice_slots',
      [
        'location_name',
        'field_name',
        'subunit_label',
        'day_of_week',
        'start_time',
        'end_time',
        'capacity',
        'division_key',
      ],
      slotRows
    ),
    'UPDATE demo_seed.divisions d\n' +
      '   SET practices_per_week = v.practices_per_week, practice_minutes = v.practice_minutes\n' +
      '  FROM (VALUES\n' +
      `${settingRows.join(',\n')}\n` +
      ') AS v(key, practices_per_week, practice_minutes)\n' +
      ' WHERE d.key = v.key;\n',
  ].join('\n');
}

/**
 * The generated region of a migration's text, between the markers.
 * @param {string} text
 * @param {string} [begin]
 * @param {string} [end]
 * @returns {string}
 */
export function generatedRegion(text, begin = BEGIN_MARK, end = END_MARK) {
  const start = text.indexOf(begin);
  const stop = text.indexOf(end);
  if (start < 0 || stop < start) {
    throw new Error('the migration has lost its generated-region markers');
  }
  return text.slice(start + begin.length + 1, stop);
}

/**
 * @param {string} text the migration's text
 * @param {string} sql the fresh rows
 * @param {string} [begin]
 * @param {string} [end]
 */
export function withGeneratedRegion(text, sql, begin = BEGIN_MARK, end = END_MARK) {
  const start = text.indexOf(begin);
  const stop = text.indexOf(end);
  if (start < 0 || stop < start) {
    throw new Error('the migration has lost its generated-region markers');
  }
  return `${text.slice(0, start + begin.length + 1)}${sql}${text.slice(stop)}`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const csvPath = path.join(DEMO_FIXTURE_DIR, 'fields.csv');
  const csv = buildFieldsCsv();
  const frozen = readFileSync(DEMO_MIGRATION, 'utf8');
  if (!generatedRegion(frozen).startsWith(`${buildDemoPeopleSql()}\n`)) {
    console.error(
      'the frozen league rows (20261030010000) differ from the fixture: a fixture change to the ' +
        'league needs a new migration, never an edit of an applied one'
    );
    process.exit(1);
  }
  if (process.argv.includes('--check')) {
    if (readFileSync(csvPath, 'utf8') !== csv) {
      console.error('fields.csv differs from the grid: run node scripts/build-demo-seed.mjs');
      process.exit(1);
    }
    const migration = readFileSync(FACILITY_MIGRATION, 'utf8');
    if (
      generatedRegion(migration, FACILITY_BEGIN_MARK, FACILITY_END_MARK) !== buildDemoFacilitySql()
    ) {
      console.error('demo_seed facility rows differ from fields.csv: run node scripts/build-demo-seed.mjs');
      process.exit(1);
    }
    console.log('fields.csv, the facility rows and the frozen league rows match the fixture');
  } else {
    writeFileSync(csvPath, csv);
    const migration = readFileSync(FACILITY_MIGRATION, 'utf8');
    const fresh = buildDemoFacilitySql();
    writeFileSync(
      FACILITY_MIGRATION,
      withGeneratedRegion(migration, fresh, FACILITY_BEGIN_MARK, FACILITY_END_MARK)
    );
    console.log(
      `wrote fields.csv and ${fresh.split('\n').length} lines into ${path.relative(REPO_ROOT, FACILITY_MIGRATION)}`
    );
  }
}
