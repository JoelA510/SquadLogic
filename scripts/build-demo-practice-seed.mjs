#!/usr/bin/env node
/**
 * Build the demo league's applied practice schedule (`demo_seed.practice_schedule`) from
 * `fixtures/demo-2026/`: where each seeded team practises each week, on the facility grid in
 * `fields.csv`. Phase D, PR F (plan `docs/changes/2026-10-27-phase-d-scheduling.md`).
 *
 * **The schedule is the REAL solver's.** It is `runPracticeOptimizer`
 * (`supabase/functions/_shared/engines/auto-scheduler-solver.ts`, the Edge Function's own search),
 * run offline on the fixture with a fixed seed and iteration count, the CPU cap off (the answer
 * depends on the seed, never on the machine), the divisions' practices a week and practice length
 * from `practiceSettingsFor`, and the coaches from `coaches.csv`. The generator throws when the
 * solver leaves a practice unplaced: a schedule with a missing practice is never written.
 *
 * The rows sit between two markers in `supabase/migrations/20261110010000_demo_practices.sql`;
 * everything outside them is hand-written. `tests/demoPracticeSeed.test.js` regenerates them and
 * compares, then holds the schedule to its rules read from the fixture, not from this generator.
 *
 *   node scripts/build-demo-practice-seed.mjs           rewrite the region in the migration
 *   node scripts/build-demo-practice-seed.mjs --check   exit 1 when the region differs from a fresh build
 *
 * **Who is scheduled (owner, 2026-10-27).** U4's four cohorts (their Saturday 30-minute sessions,
 * one cohort at a time, 15 minutes apart: still practices) and U5 to U8, boys and girls, two
 * practices a week of 60 minutes on different weekdays. U9 and older are left for the visitor's own
 * auto-scheduler run, the demo's most interesting action: `placeTheRest` runs it here, over the
 * seeded rows as locked, and the tests require it to place all of them.
 *
 * Placeholder data only: the team names are the fixture's, a coach is a placeholder name, and
 * nothing here names a person.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEMO_FIXTURE_DIR,
  FACILITY_MIGRATION,
  divisionOfTeam,
  lit,
  load,
  practiceSettingsFor,
} from './build-demo-seed.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEMO_PRACTICE_MIGRATION = FACILITY_MIGRATION;
export const BEGIN_MARK =
  '-- BEGIN GENERATED demo_seed practice rows (scripts/build-demo-practice-seed.mjs; do not edit)';
export const END_MARK = '-- END GENERATED demo_seed practice rows';

/** The oldest age with a seeded practice. U9 and older are the visitor's to schedule. */
export const SCHEDULED_UP_TO_AGE = 8;

/**
 * The search. The seed and the iteration count fix the answer; the budget only has to be far above
 * a run's cost, so it never ends one.
 */
export const SEED_SEARCH = Object.freeze({ timeBudgetMs: 120_000, maxIterations: 300, seed: 42 });

/**
 * The reference season the offline run is dated on: twelve weeks from a Monday. The weekly pattern
 * does not depend on the dates (the rows are re-dated by `start_demo_session()` to each demo's own
 * season), only that every slot has a first occurrence and a last date.
 */
export const REFERENCE_SEASON = Object.freeze({ start: '2026-11-09', end: '2027-01-31' });

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** `hh:mm` as seconds past midnight. */
const seconds = (hhmm) => Number(hhmm.slice(0, 2)) * 3600 + Number(hhmm.slice(3, 5)) * 60;

/** The age of a division key (`U4`, `U7B`, `U19G`). */
const ageOf = (divisionKey) => Number(divisionKey.slice(1).replace(/[BG]$/, ''));

/** The date of weekday `day` in the reference season's first week. */
function firstDateOf(day) {
  const d = new Date(`${REFERENCE_SEASON.start}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + WEEKDAYS.indexOf(day));
  return d.toISOString().slice(0, 10);
}

/**
 * What the solver is run on, all read from the fixture: the teams (with their division's practice
 * settings and their coaches), and the slots (with the reservation and the dating).
 * @param {string} dir the directory holding the fixture CSVs
 */
export function readLeague(dir = DEMO_FIXTURE_DIR) {
  const players = load('players.csv', dir);
  const coachRows = load('coaches.csv', dir);
  const grid = load('fields.csv', dir);

  const coachesOf = new Map();
  for (const row of coachRows) {
    const team = row['Team Name'];
    if (!team) continue;
    const name = `${row['First Name']} ${row['Last Name']}`;
    if (!coachesOf.has(team)) coachesOf.set(team, []);
    if (!coachesOf.get(team).includes(name)) coachesOf.get(team).push(name);
  }

  const reserved = new Set(grid.map((f) => f.Division).filter(Boolean));
  const teams = [...new Set(players.map((p) => p['Team Name']))].sort().map((name) => {
    const division = divisionOfTeam(name);
    const [lead, ...assistants] = coachesOf.get(name) ?? [];
    return {
      id: name,
      division,
      divisionId: division,
      coachId: lead ?? null,
      assistantCoachIds: assistants,
      reservedDivisionIds: reserved,
      ...practiceSettingsFor(ageOf(division)),
    };
  });

  const slots = grid.map((f) => {
    const id = [f.Location, f.Field, f.Subunit, f.Day, f.Start].join('|');
    return {
      slot: {
        id,
        day: f.Day,
        start: new Date(`${firstDateOf(f.Day)}T${f.Start}:00Z`),
        end: new Date(`${firstDateOf(f.Day)}T${f.End}:00Z`),
        capacity: Number(f.Capacity),
        ...(f.Division ? { divisionId: f.Division } : {}),
      },
      dating: {
        firstDate: firstDateOf(f.Day),
        effectiveUntil: REFERENCE_SEASON.end,
        startSeconds: seconds(f.Start),
        endSeconds: seconds(f.End),
      },
      row: {
        location: f.Location,
        field: f.Field,
        subunit: f.Subunit,
        day: f.Day,
        start: f.Start,
        end: f.End,
      },
    };
  });
  return { teams, slots };
}

/**
 * Run the real solver for the `placeable` teams, with `lockedRows` (`{ teamId, slotId }`) held.
 * @returns the solver's result
 */
async function runSolver(league, { placeable, lockedRows = [] }) {
  const solver = await import('../supabase/functions/_shared/engines/auto-scheduler-solver.ts');
  const coaches = await import('../supabase/functions/_shared/engines/practice-coaches.ts');
  const teams = league.teams.map((t) => ({ ...t, ...coaches.prepareTeam(t) }));
  const unitsNeeded = Object.fromEntries(
    league.teams.filter((t) => placeable.includes(t.id)).map((t) => [t.id, t.practicesPerWeek])
  );
  const dayOf = new Map(league.slots.map((s) => [s.slot.id, s.row.day]));
  return solver.runPracticeOptimizer({
    teams,
    slots: league.slots.map((s) => s.slot),
    locked: lockedRows.map((r, i) => ({
      assignmentId: `L${i}`,
      teamId: r.teamId,
      slotId: r.slotId,
      effectiveDateRange: `[${firstDateOf(dayOf.get(r.slotId))},${REFERENCE_SEASON.end}]`,
    })),
    placeableTeamIds: placeable,
    unitsNeeded,
    dating: {
      liveFrom: REFERENCE_SEASON.start,
      slots: new Map(league.slots.map((s) => [s.slot.id, s.dating])),
    },
    config: { ...SEED_SEARCH },
    // The server's compute cap would end a slow machine's run early and make the answer depend on
    // the machine; an offline build has no request to protect.
    cpuCapMs: Infinity,
  });
}

/** Is this team seeded scheduled? U4 and U5 to U8. */
export const isSeeded = (team) =>
  team.division === 'U4' || ageOf(team.division) <= SCHEDULED_UP_TO_AGE;

/** The id a solver slot has for a schedule row. */
const slotIdOf = (r) => [r.location, r.field, r.subunit, r.day, r.start].join('|');

/**
 * Where each seeded team practises, as rows `{ team, location, field, subunit, day, start }` sorted
 * by team and weekday.
 * @param {string} [fixtureDir] the directory holding the fixture CSVs (the tests plant defects in a copy)
 */
export async function buildPracticeSchedule(fixtureDir = DEMO_FIXTURE_DIR) {
  const league = readLeague(fixtureDir);
  const result = await runSolver(league, {
    placeable: league.teams.filter(isSeeded).map((t) => t.id),
  });
  if (result.unassigned.length > 0) {
    throw new Error(
      `the solver left ${result.unassigned.length} seeded practice(s) unplaced, e.g. ` +
        `${result.unassigned[0].teamId}: ${result.unassigned[0].reason}`
    );
  }
  const bySlot = new Map(league.slots.map((s) => [s.slot.id, s.row]));
  const rows = result.placements.map((p) => {
    const r = bySlot.get(p.slotId);
    return {
      team: p.teamId,
      location: r.location,
      field: r.field,
      subunit: r.subunit,
      day: r.day,
      start: r.start,
    };
  });
  return rows.sort(
    (a, b) =>
      a.team.localeCompare(b.team) ||
      WEEKDAYS.indexOf(a.day) - WEEKDAYS.indexOf(b.day) ||
      a.start.localeCompare(b.start)
  );
}

/**
 * What a visitor's own auto-scheduler run does: the real solver over the teams the seed left
 * unscheduled, with the seeded rows held. Returns the league and the solver's result.
 * @param {Awaited<ReturnType<typeof buildPracticeSchedule>>} seeded
 * @param {string} [fixtureDir]
 */
export async function placeTheRest(seeded, fixtureDir = DEMO_FIXTURE_DIR) {
  const league = readLeague(fixtureDir);
  const result = await runSolver(league, {
    placeable: league.teams.filter((t) => !isSeeded(t)).map((t) => t.id),
    lockedRows: seeded.map((r) => ({ teamId: r.team, slotId: slotIdOf(r) })),
  });
  return { league, result };
}

/** The SQL that fills `demo_seed.practice_schedule`. */
export async function buildDemoPracticeSeedSql(fixtureDir = DEMO_FIXTURE_DIR) {
  const body = (await buildPracticeSchedule(fixtureDir))
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
  const fresh = await buildDemoPracticeSeedSql();
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
