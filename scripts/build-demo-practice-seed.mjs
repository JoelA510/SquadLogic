#!/usr/bin/env node
/**
 * Build the demo league's applied practice schedule (`demo_seed.practice_schedule`) from
 * `fixtures/demo-2026/`: where each team practises each week, on the facility grid in `fields.csv`.
 *
 * The rows sit between two markers in `supabase/migrations/20261103010000_demo_practice_schedule.sql`;
 * everything outside them is hand-written. `tests/demoPracticeSeed.test.js` regenerates them and
 * compares, then holds the schedule to its rules read from the fixture, not from this generator.
 *
 *   node scripts/build-demo-practice-seed.mjs           rewrite the region in the migration
 *   node scripts/build-demo-practice-seed.mjs --check   exit 1 when the region differs from a fresh build
 *
 * **The rules (owner, 2026-10-27).** U4 cohorts are practice-only: each meets once a week for the
 * 30-minute session reserved to U4 on the grid, one cohort at a time, the sessions at least 15
 * minutes apart (the grid already is). Every other team gets one weekly practice (U5 to U10) or two
 * (U12 and older, on Monday and Wednesday or Tuesday and Thursday), on the seeded fields in the
 * 16:00 to 19:00 evening window of a school week; younger teams practise earlier. No field, subunit
 * and time holds more teams than its capacity, a team never has two practices at one time, and a
 * coach is never in two places at once.
 *
 * Placeholder data only: the team names are the fixture's, and nothing here names a person.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEMO_FIXTURE_DIR, divisionOfTeam, lit, load } from './build-demo-seed.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEMO_PRACTICE_MIGRATION = path.join(
  REPO_ROOT,
  'supabase',
  'migrations',
  '20261103010000_demo_practice_schedule.sql'
);
export const BEGIN_MARK =
  '-- BEGIN GENERATED demo_seed practice rows (scripts/build-demo-practice-seed.mjs; do not edit)';
export const END_MARK = '-- END GENERATED demo_seed practice rows';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
/** The pairs a two-practice team uses, alternating by team: never two days in a row. */
const PAIRS = [
  ['Mon', 'Wed'],
  ['Tue', 'Thu'],
];
/** From this age up, a team practises twice a week. */
const TWICE_FROM_AGE = 12;

/** `hh:mm` as minutes. */
const minutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** The age of a division key (`U4`, `U7B`, `U19G`). */
const ageOf = (divisionKey) => Number(divisionKey.slice(1).replace(/[BG]$/, ''));

/**
 * The time of day each age tries first; the rest follow by distance from it. Younger teams
 * practise earlier in the evening.
 */
function preferredStart(age) {
  if (age <= 6) return '16:00';
  if (age <= 8) return '16:45';
  if (age <= 10) return '17:30';
  return '18:15';
}

/**
 * Where each team practises, as rows `{ team, location, field, subunit, day, start }` sorted by
 * team and weekday.
 * @param {string} [fixtureDir] the directory holding the fixture CSVs (the tests plant defects in a copy)
 */
export function buildPracticeSchedule(fixtureDir = DEMO_FIXTURE_DIR) {
  const players = load('players.csv', fixtureDir);
  const coachRows = load('coaches.csv', fixtureDir);
  const grid = load('fields.csv', fixtureDir).map((row) => ({
    key: [row.Location, row.Field, row.Subunit, row.Day, row.Start].join('|'),
    location: row.Location,
    field: row.Field,
    subunit: row.Subunit,
    day: row.Day,
    start: row.Start,
    end: row.End,
    capacity: Number(row.Capacity),
    division: row.Division,
  }));
  const coachesOf = new Map();
  for (const row of coachRows) {
    const team = row['Team Name'];
    if (!team) continue;
    const name = `${row['First Name']} ${row['Last Name']}`;
    if (!coachesOf.has(team)) coachesOf.set(team, new Set());
    coachesOf.get(team).add(name);
  }

  const teams = [...new Set(players.map((p) => p['Team Name']))].sort();
  const used = new Map(); // slot key -> teams placed
  const teamBusy = new Map(); // team -> [{ day, from, to }]
  const coachBusy = new Map(); // coach -> [{ day, from, to }]
  const rows = [];

  const overlaps = (list, day, slot) =>
    (list ?? []).some(
      (b) => b.day === day && b.from < minutes(slot.end) && minutes(slot.start) < b.to
    );
  const free = (slot, team) =>
    (used.get(slot.key) ?? 0) < slot.capacity &&
    !overlaps(teamBusy.get(team), slot.day, slot) &&
    ![...(coachesOf.get(team) ?? [])].some((coach) =>
      overlaps(coachBusy.get(coach), slot.day, slot)
    );
  const place = (slot, team) => {
    used.set(slot.key, (used.get(slot.key) ?? 0) + 1);
    const busy = { day: slot.day, from: minutes(slot.start), to: minutes(slot.end) };
    teamBusy.set(team, [...(teamBusy.get(team) ?? []), busy]);
    for (const coach of coachesOf.get(team) ?? []) {
      coachBusy.set(coach, [...(coachBusy.get(coach) ?? []), busy]);
    }
    rows.push({
      team,
      location: slot.location,
      field: slot.field,
      subunit: slot.subunit,
      day: slot.day,
      start: slot.start,
    });
  };

  // ---- U4: one reserved session each, in time order ----
  const u4Teams = teams.filter((t) => divisionOfTeam(t) === 'U4');
  const u4Slots = grid
    .filter((s) => s.division === 'U4')
    .sort((a, b) => a.day.localeCompare(b.day) || minutes(a.start) - minutes(b.start));
  if (u4Teams.length > u4Slots.length) {
    throw new Error(`${u4Teams.length} U4 cohorts but ${u4Slots.length} reserved sessions`);
  }
  u4Teams.forEach((team, i) => place(u4Slots[i], team));

  // ---- everyone else, on the open grid ----
  const open = grid.filter((s) => !s.division && s.day !== 'Sat' && s.day !== 'Sun');
  const gridStarts = [...new Set(open.map((s) => s.start))].sort();
  const others = teams.filter((t) => divisionOfTeam(t) !== 'U4');
  const indexInGroup = new Map();
  let count = 0;
  for (const team of others) {
    const group = Math.min(ageOf(divisionOfTeam(team)), TWICE_FROM_AGE);
    const n = indexInGroup.get(group) ?? 0;
    indexInGroup.set(group, n + 1);
    const age = ageOf(divisionOfTeam(team));
    const days = age >= TWICE_FROM_AGE ? PAIRS[n % PAIRS.length] : [DAYS[n % 4]];
    // The times to try, nearest the preferred one first.
    const want = minutes(preferredStart(age));
    const starts = [...gridStarts].sort(
      (a, b) => Math.abs(minutes(a) - want) - Math.abs(minutes(b) - want) || a.localeCompare(b)
    );
    // A team's practices share a ground and a time of day when the grid lets them: the first start
    // (nearest the preferred one) and ground (rotating, so teams spread over the grounds) at which
    // every day of the team is free. Otherwise each day takes whatever is nearest.
    const grounds = (day, start) => open.filter((s) => s.day === day && s.start === start);
    const same = (a, b) =>
      a.location === b.location && a.field === b.field && a.subunit === b.subunit;
    let chosen = null;
    for (const start of starts) {
      const base = grounds(days[0], start);
      for (let k = 0; k < base.length && !chosen; k += 1) {
        const head = base[(count + k) % base.length];
        const rest = days.slice(1).map((day) => grounds(day, start).find((s) => same(s, head)));
        const all = [head, ...rest];
        if (all.every((slot) => slot && free(slot, team))) chosen = all;
      }
      if (chosen) break;
    }
    if (!chosen) {
      chosen = days.map((day) => {
        for (const start of starts) {
          const options = grounds(day, start);
          for (let k = 0; k < options.length; k += 1) {
            const option = options[(count + k) % options.length];
            if (free(option, team)) return option;
          }
        }
        throw new Error(`no free slot on ${day} for ${team}`);
      });
    }
    for (const slot of chosen) place(slot, team);
    count += 1;
  }

  const dayRank = (d) => DAYS.indexOf(d);
  return rows.sort((a, b) => a.team.localeCompare(b.team) || dayRank(a.day) - dayRank(b.day));
}

/** The SQL that fills `demo_seed.practice_schedule`. */
export function buildDemoPracticeSeedSql(fixtureDir = DEMO_FIXTURE_DIR) {
  const body = buildPracticeSchedule(fixtureDir)
    .map(
      (r) =>
        `  (${[lit(r.team), lit(r.location), lit(r.field), lit(r.subunit), lit(r.day.toLowerCase()), lit(r.start)].join(', ')})`
    )
    .join(',\n');
  return (
    'INSERT INTO demo_seed.practice_schedule ' +
    '(team_name, location_name, field_name, subunit_label, day_of_week, start_time) VALUES\n' +
    `${body};\n`
  );
}

/** The generated region of a migration's text, between the markers. */
export function generatedRegion(text) {
  const start = text.indexOf(BEGIN_MARK);
  const end = text.indexOf(END_MARK);
  if (start < 0 || end < start) {
    throw new Error('the migration has lost its generated-region markers');
  }
  return text.slice(start + BEGIN_MARK.length + 1, end);
}

/** @param {string} text the migration's text @param {string} sql the fresh rows */
export function withGeneratedRegion(text, sql) {
  const start = text.indexOf(BEGIN_MARK);
  const end = text.indexOf(END_MARK);
  if (start < 0 || end < start) {
    throw new Error('the migration has lost its generated-region markers');
  }
  return `${text.slice(0, start + BEGIN_MARK.length + 1)}${sql}${text.slice(end)}`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const fresh = buildDemoPracticeSeedSql();
  const text = readFileSync(DEMO_PRACTICE_MIGRATION, 'utf8');
  if (process.argv.includes('--check')) {
    if (generatedRegion(text) !== fresh) {
      console.error(
        'demo_seed practice rows differ from the fixture: run node scripts/build-demo-practice-seed.mjs'
      );
      process.exit(1);
    }
    console.log('demo_seed practice rows match the fixture');
  } else {
    writeFileSync(DEMO_PRACTICE_MIGRATION, withGeneratedRegion(text, fresh));
    console.log(
      `wrote ${fresh.split('\n').length} lines into ${path.relative(REPO_ROOT, DEMO_PRACTICE_MIGRATION)}`
    );
  }
}
