#!/usr/bin/env node
/**
 * Build the `demo_seed` rows from `fixtures/demo-2026/` (plan
 * `docs/changes/2026-10-22-demo-mode.md`, D3: "Its insert migration is generated from
 * `fixtures/demo-2026/*.csv` by `scripts/build-demo-seed.mjs`").
 *
 * The rows sit between two markers in `supabase/migrations/20261030010000_demo_sessions.sql`;
 * everything outside them is hand-written. `tests/demoSeed.test.js` regenerates them and compares,
 * so the seed and the fixture cannot drift and nobody hand-edits the generated SQL.
 *
 *   node scripts/build-demo-seed.mjs           rewrite the region in the migration
 *   node scripts/build-demo-seed.mjs --check   exit 1 when the region differs from a fresh build
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
export const BEGIN_MARK =
  '-- BEGIN GENERATED demo_seed rows (scripts/build-demo-seed.mjs; do not edit)';
export const END_MARK = '-- END GENERATED demo_seed rows';

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
function load(file, dir) {
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
function lit(value) {
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
function divisionOfTeam(name) {
  if (name.startsWith('U4')) return 'U4';
  const age = Number(name.slice(1, 3));
  return `U${age}${name[3]}`;
}

/**
 * The SQL that fills `demo_seed` from the fixture.
 * @param {string} [fixtureDir] the directory holding the three CSVs (the tests plant defects in a copy)
 * @returns {string}
 */
export function buildDemoSeedSql(fixtureDir = DEMO_FIXTURE_DIR) {
  const players = load('players.csv', fixtureDir);
  const coaches = load('coaches.csv', fixtureDir);
  const fields = load('fields.csv', fixtureDir);
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

  // ---- facilities, from fields.csv (the fields import's own columns) ----
  const locations = [...new Set(fields.map((f) => f.Location))].sort();
  const fieldKeys = new Map();
  for (const f of fields) {
    fieldKeys.set(`${f.Location}\u0001${f.Field}`, f);
  }
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
  const DAY = {
    Mon: 'mon',
    Tue: 'tue',
    Wed: 'wed',
    Thu: 'thu',
    Fri: 'fri',
    Sat: 'sat',
    Sun: 'sun',
  };
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
    insert(
      'locations',
      ['name', 'latitude', 'longitude'],
      // The venues sit on the repo's made-up sites (tests/helpers/heatSyntheticSites.js, in the Pacific
      // time zone, the first one turf): no real location enters the repo (tests/heatSyntheticCoordinates).
      locations.map((name, i) => [
        lit(name),
        SYNTHETIC_HEAT_SITES[i].latitude.toFixed(4),
        SYNTHETIC_HEAT_SITES[i].longitude.toFixed(4),
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
  ];
  return parts.join('\n');
}

/**
 * The generated region of a migration's text, between the markers.
 * @param {string} text
 * @returns {string}
 */
export function generatedRegion(text) {
  const start = text.indexOf(BEGIN_MARK);
  const end = text.indexOf(END_MARK);
  if (start < 0 || end < start)
    throw new Error('the migration has lost its generated-region markers');
  return text.slice(start + BEGIN_MARK.length + 1, end);
}

/** @param {string} text the migration's text @param {string} sql the fresh rows */
export function withGeneratedRegion(text, sql) {
  const start = text.indexOf(BEGIN_MARK);
  const end = text.indexOf(END_MARK);
  if (start < 0 || end < start)
    throw new Error('the migration has lost its generated-region markers');
  return `${text.slice(0, start + BEGIN_MARK.length + 1)}${sql}${text.slice(end)}`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const fresh = buildDemoSeedSql();
  const text = readFileSync(DEMO_MIGRATION, 'utf8');
  if (process.argv.includes('--check')) {
    if (generatedRegion(text) !== fresh) {
      console.error('demo_seed rows differ from the fixture: run node scripts/build-demo-seed.mjs');
      process.exit(1);
    }
    console.log('demo_seed rows match the fixture');
  } else {
    writeFileSync(DEMO_MIGRATION, withGeneratedRegion(text, fresh));
    console.log(
      `wrote ${fresh.split('\n').length} lines into ${path.relative(REPO_ROOT, DEMO_MIGRATION)}`
    );
  }
}
