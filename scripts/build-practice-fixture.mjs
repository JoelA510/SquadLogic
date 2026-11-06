#!/usr/bin/env node
/**
 * Build `fixtures/practice-schedule-2026/`: a placeholder league and the flat practice CSV an
 * organization that arrives with an already built practice schedule would import (plan
 * `docs/changes/2026-11-03-schedule-expansion.md` section 4.11.7, PR 9 task J1).
 *
 *   node scripts/build-practice-fixture.mjs                       rewrite the generated files
 *   node scripts/build-practice-fixture.mjs --check [--dir DIR]   exit 1 when DIR (default: the
 *                                                                 fixture) differs from a fresh build
 *
 * **Every value is invented.** The only inputs taken from the owner's practice workbook are the
 * COUNTS in plan 4.11.1 and the README's shape table (placements, timed rows, teams, practices a
 * week, weekday patterns, field rows, venues); no name, venue, club, field, coach or value came from
 * it, and this repository has never held it. Names follow the conventions `tests/demoFixture.test.js`
 * and `tests/realNameDenylist.test.js` hold: `Venue A`.., `Field 1`.., subunits `A` and `B`, team
 * labels like `U10B-01`, `CoachFirstN CoachLastN`, no email address anywhere.
 *
 * **The file is grid-shaped, not a solver's output.** The product's solver has no pairing yet (plan
 * 5.7), so it could not make the example's same-slot pattern. This script builds the grid directly:
 * every field has two halves, every weekday of a block has three starts, each (half, weekday, start)
 * is a timed cell, and a team's two practices are placed as a twin pair (the same half and start on
 * two weekdays) for most teams. A whole-field placement replaces the two half cells it covers with ONE
 * row (the converted file's answer to the grid's merged cell, plan 4.11.2).
 *
 * **Plants** are small named functions applied to a COPY of the clean grid. Each is tried over
 * candidates until the measures move by exactly that plant and nothing else, so a plant is never
 * silently fewer or entangled with another. `tests/practiceScheduleFixture.test.js` recounts them from
 * the CSV with a separate sweep (`tests/helpers/practiceSweep.js`); the pre-plant copy
 * (`buildPracticeFixture({ plants: false })`) is the control that finds none.
 *
 * Deterministic: a seeded PRNG written below, no clock, no host time zone.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Papa from 'papaparse';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PRACTICE_FIXTURE_DIR = path.join(REPO_ROOT, 'fixtures', 'practice-schedule-2026');

/** The season `practice-schedule.csv` is judged against: no clock is involved (plan 4.11.6). */
export const PRACTICE_FIXTURE_SEASON = Object.freeze({
  startDate: '2026-09-07',
  endDate: '2026-11-20',
});

/**
 * The season `practice-invalid.csv` is judged against: a start date and NO end date, which is what
 * makes `missing-dates` reachable from the file (a row with neither of its own dates and a season
 * with none has no `Valid Until`). Every row of that file that is not about dates carries its own.
 */
export const PRACTICE_INVALID_SEASON = Object.freeze({
  startDate: '2026-09-07',
  endDate: null,
});

/** What each plant does to a copy of the clean grid, and how many times (plan 4.11.7). */
export const PRACTICE_PLANT_COUNTS = Object.freeze({
  shortTeams: 29,
  doublePlaced: 5,
  coachClashes: 1,
  trailingWhitespace: 2,
  teamOnBothHalves: 1,
  overCapacity: 1,
  overlappingSlots: 1,
  holds: 1,
});

export const PRACTICE_FIXTURE_FILES = Object.freeze([
  'practice-schedule.csv',
  'practice-invalid.csv',
  'aliases.csv',
  'teams.csv',
  'surfaces.csv',
  'divisions.csv',
]);

const SCHEDULE_COLUMNS = [
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
  'Block',
];
/** `Length` is the alternative to `End`; only the invalid file uses it. `Notes` is dropped. */
const INVALID_COLUMNS = [
  'Team',
  'Division',
  'Day',
  'Start',
  'End',
  'Length',
  'Location',
  'Field',
  'Subunit',
  'Valid From',
  'Valid Until',
  'Capacity',
  'Use',
  'Notes',
];

/* -------------------------------------------------------------------------- */
/* The league: counts from the plan, every name invented                       */
/* -------------------------------------------------------------------------- */

const SEED = 20261106;
const AGES = [5, 6, 7, 8, 9, 10, 12, 14, 16, 19];
/**
 * Teams per division, in division order (U05B, U05G, U06B, ...): the first three are the 45-minute
 * divisions (19 teams); the other seventeen are 113 teams at 60 minutes; 132 in all.
 */
const DIVISION_SIZES = [7, 7, 5, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 6, 6, 6, 6, 6, 6];
const SHORT_DIVISIONS = 3;
const SECOND_COACHES = 60;
const SHARED_COACHES = 19;

const WEEK = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
/** The two blocks of plan 4.11.1: weekdays and starts. */
const BLOCKS = {
  45: { days: ['Tue', 'Thu'], starts: ['16:00', '16:45', '17:30'] },
  60: { days: WEEK, starts: ['16:00', '17:00', '18:00'] },
};
/** Venue letter, fields, block. 29 fields (8 in the 45-minute block, 21 in the 60-minute block). */
const VENUES = [
  ['A', 4, 45],
  ['B', 4, 45],
  ['C', 4, 60],
  ['D', 4, 60],
  ['E', 3, 60],
  ['F', 3, 60],
  ['G', 3, 60],
  ['H', 4, 60],
];
/** Nine halves nothing is ever placed on: 49 of the 58 labelled rows are used. */
const UNUSED_HALVES = new Set([
  'A4:B',
  'B4:B',
  'C4:B',
  'D4:B',
  'E3:B',
  'F3:B',
  'G3:B',
  'H3:B',
  'H4:B',
]);
/** The venues whose fields are written in an alias spelling (`Pitch C1`) in the schedule file. */
const ALIASED_FIELD_VENUES = new Set(['C', 'D', 'E', 'F', 'G']);
/** Venue G is written `Venue G Annex`; one field's halves are written `H1 North` and `H1 South`. */
const ANNEX_VENUE = 'G';
const NORTH_SOUTH_FIELD = 'H1';

/** The shape of the weekday pairs among the 98 teams on two weekdays (plan 4.11.1). */
const PATTERN_COUNTS_60 = { 'Tue+Thu': 31, 'Mon+Wed': 38, 'Wed+Fri': 8, 'Mon+Thu': 3 };
const PATTERN_DAYS = {
  'Tue+Thu': ['Tue', 'Thu'],
  'Mon+Wed': ['Mon', 'Wed'],
  'Wed+Fri': ['Wed', 'Fri'],
  'Mon+Thu': ['Mon', 'Thu'],
};
const FILLER_PATTERNS = ['Mon+Wed', 'Tue+Thu', 'Wed+Fri'];

/** The roles of 132 teams (every set is disjoint from the ones it must not meet). */
const ROLE_COUNTS = {
  dropShort: 1, // of the 45-minute teams
  drop: 28, // of the 60-minute teams: 29 teams lose a practice
  double: 5,
  wholeTwinShort: 1,
  wholeTwin: 9, // 20 whole-field placements in all
  nonTwin: 15, // 98 - 83: the teams whose two practices are not the same slot
};

/** mulberry32: 32-bit state, the same generator `autoScheduler.js` uses. @param {number} a */
function prng(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** @template T @param {T[]} list @param {() => number} rnd @returns {T[]} */
function shuffle(list, rnd) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const pad2 = (n) => String(n).padStart(2, '0');
/** @param {string} hhmm */
const toMinutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
/** @param {number} total */
const toHhmm = (total) => `${pad2(Math.floor(total / 60))}:${pad2(total % 60)}`;
const addMinutes = (hhmm, m) => toHhmm(toMinutes(hhmm) + m);

/**
 * @typedef {Object} Team
 * @property {string} label  `U05B-01`
 * @property {string} division  `U05 Boys`
 * @property {number} minutes  45 or 60
 * @property {number[]} persons  the people who coach it
 * @property {string[]} coaches  their names, filled in once the league is built
 */

/** @param {() => number} rnd */
function buildLeague(rnd) {
  const divisions = [];
  for (const age of AGES)
    for (const g of 'BG') {
      const index = divisions.length;
      divisions.push({
        code: `U${pad2(age)}${g}`,
        name: `U${pad2(age)} ${g === 'B' ? 'Boys' : 'Girls'}`,
        size: DIVISION_SIZES[index],
        minutes: index < SHORT_DIVISIONS ? 45 : 60,
      });
    }
  /** @type {Team[]} */
  const teams = [];
  for (const d of divisions)
    for (let n = 1; n <= d.size; n += 1)
      teams.push({
        label: `${d.code}-${pad2(n)}`,
        division: d.name,
        minutes: d.minutes,
        persons: [],
        coaches: [],
      });
  if (teams.length !== 132) throw new Error(`the league has ${teams.length} teams, not 132`);

  // Seats: every team has a first coach, 60 a second. 19 people are made to hold two seats, on teams of
  // different divisions (siblings in two age groups), so the grid has real coach constraints to meet.
  const seats = teams.map((_, i) => ({ team: i, slot: 1 }));
  for (const i of shuffle(
    teams.map((_, k) => k),
    rnd
  ).slice(0, SECOND_COACHES))
    seats.push({ team: i, slot: 2 });
  const person = seats.map((_, k) => k);
  const used = new Set();
  let merged = 0;
  for (let tries = 0; merged < SHARED_COACHES; tries += 1) {
    if (tries > 100000) throw new Error('could not place the shared coaches');
    const a = Math.floor(rnd() * seats.length);
    const b = Math.floor(rnd() * seats.length);
    if (a === b || used.has(a) || used.has(b)) continue;
    if (teams[seats[a].team].division === teams[seats[b].team].division) continue;
    person[b] = person[a];
    used.add(a).add(b);
    merged += 1;
  }
  seats
    .map((s, k) => ({ ...s, person: person[k] }))
    .sort((x, y) => x.team - y.team || x.slot - y.slot)
    .forEach((s) => teams[s.team].persons.push(s.person));
  // Coach people are numbered by first appearance in teams.csv, as the demo fixture's are.
  /** @type {Map<number, string>} */
  const names = new Map();
  for (const t of teams)
    for (const p of t.persons)
      if (!names.has(p)) names.set(p, `CoachFirst${names.size + 1} CoachLast${names.size + 1}`);
  for (const t of teams) t.coaches = t.persons.map((p) => names.get(p));
  return { divisions, teams };
}

/* -------------------------------------------------------------------------- */
/* The grid                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {Object} FieldInfo
 * @property {string} id  `C2`
 * @property {string} letter
 * @property {number} n
 * @property {number} block  45 or 60
 */

/** @type {FieldInfo[]} */
const FIELDS = VENUES.flatMap(([letter, count, block]) =>
  Array.from({ length: count }, (_, i) => ({ id: `${letter}${i + 1}`, letter, n: i + 1, block }))
);
const FIELD_BY_ID = new Map(FIELDS.map((f) => [f.id, f]));
const halfAllowed = (fieldId, sub) => !UNUSED_HALVES.has(`${fieldId}:${sub}`);
const wholeAllowed = (fieldId) => halfAllowed(fieldId, 'A') && halfAllowed(fieldId, 'B');

/**
 * @typedef {Object} Cell
 * @property {string} fieldId
 * @property {string} day
 * @property {string} start
 * @property {string} end
 * @property {string} sub  `A`, `B`, or `''` for the whole field
 * @property {number} capacity
 * @property {boolean} hold
 * @property {Array<{ label: string, raw: string | null }>} entries  the teams in it; `raw` is the
 *   Team text when a plant gave it stray whitespace
 */

const cellKey = (fieldId, day, start, sub) => JSON.stringify([fieldId, day, start, sub]);

/** @returns {Map<string, Cell>} every (half, weekday, start) of both blocks, all open */
function emptyGrid() {
  const cells = new Map();
  for (const f of FIELDS) {
    const block = BLOCKS[f.block];
    for (const day of block.days)
      for (const start of block.starts)
        for (const sub of ['A', 'B']) {
          cells.set(cellKey(f.id, day, start, sub), {
            fieldId: f.id,
            day,
            start,
            end: addMinutes(start, f.block),
            sub,
            capacity: 1,
            hold: false,
            entries: [],
          });
        }
  }
  return cells;
}

/** The grid as plain data, so a plant can be tried on a copy. @param {Map<string, Cell>} cells */
const cloneGrid = (cells) => new Map(structuredClone([...cells]));

/* ------------------------------ measures ---------------------------------- */

const overlapsTime = (a, b) =>
  toMinutes(a.start) < toMinutes(b.end) && toMinutes(b.start) < toMinutes(a.end);

/**
 * The generator's own count of every measure, from the cells (the test recounts from the CSV, with
 * different code: this is the second reading, not the third).
 *
 * @param {Map<string, Cell>} cells
 * @param {Team[]} teams
 */
function measure(cells, teams) {
  const all = [...cells.values()];
  const rowsOf = new Map(teams.map((t) => [t.label, []]));
  for (const c of all) if (!c.hold) for (const e of c.entries) rowsOf.get(e.label).push(c);

  const who = {
    shortTeams: teams.filter((t) => rowsOf.get(t.label).length < 2).map((t) => t.label),
    doublePlaced: [],
    teamOnBothHalves: [],
    overCapacity: all
      .filter((c) => !c.hold && c.entries.length > c.capacity)
      .map((c) => cellKey(c.fieldId, c.day, c.start, c.sub)),
    overlappingSlots: [],
    coachClashes: [],
    trailingWhitespace: all.flatMap((c) =>
      c.entries.filter((e) => e.raw !== null && e.raw !== e.raw.trim()).map(() => 'whitespace')
    ),
    holds: all.filter((c) => c.hold).map((c) => cellKey(c.fieldId, c.day, c.start, c.sub)),
  };
  for (const [label, list] of rowsOf) {
    let double = false;
    let halves = false;
    for (let i = 0; i < list.length; i += 1)
      for (let j = i + 1; j < list.length; j += 1) {
        const a = list[i];
        const b = list[j];
        if (a.day !== b.day || a.start !== b.start) continue;
        if (a.fieldId !== b.fieldId) double = true;
        else if (a.sub !== '' && b.sub !== '' && a.sub !== b.sub) halves = true;
      }
    if (double) who.doublePlaced.push(label);
    if (halves) who.teamOnBothHalves.push(label);
  }
  /** @type {Map<string, Cell[]>} */
  const ground = new Map();
  for (const c of all) {
    if (c.hold) continue;
    const g = JSON.stringify([c.fieldId, c.day]);
    ground.set(g, [...(ground.get(g) ?? []), c]);
  }
  for (const list of ground.values())
    for (let i = 0; i < list.length; i += 1)
      for (let j = i + 1; j < list.length; j += 1) {
        const a = list[i];
        const b = list[j];
        const same = a.sub === '' || b.sub === '' || a.sub === b.sub;
        if (same && overlapsTime(a, b)) who.overlappingSlots.push(`${a.sub}/${b.sub}`);
      }
  /** @type {Map<string, string[]>} */
  const coached = new Map();
  for (const t of teams)
    for (const c of t.coaches) coached.set(c, [...(coached.get(c) ?? []), t.label]);
  for (const [coach, labels] of coached) {
    if (labels.length < 2) continue;
    const mine = labels.flatMap((l) => rowsOf.get(l).map((cell) => ({ l, cell })));
    let clash = false;
    for (let i = 0; i < mine.length; i += 1)
      for (let j = i + 1; j < mine.length; j += 1) {
        const a = mine[i];
        const b = mine[j];
        if (a.l !== b.l && a.cell.day === b.cell.day && overlapsTime(a.cell, b.cell)) clash = true;
      }
    if (clash) who.coachClashes.push(coach);
  }
  return {
    who,
    counts: /** @type {Record<string, number>} */ (
      Object.fromEntries(Object.entries(who).map(([k, v]) => [k, v.length]))
    ),
  };
}

/* ------------------------------ the clean grid ---------------------------- */

/**
 * @param {ReturnType<typeof buildLeague>} league
 * @param {() => number} rnd
 */
function buildCleanGrid(league, rnd) {
  const { teams } = league;
  const cells = emptyGrid();
  const teamByLabel = new Map(teams.map((t) => [t.label, t]));
  /** @type {Map<string, Array<{ day: string, start: string, end: string, label: string }>>} */
  const busy = new Map();
  /** @type {Map<string, number>} placements per half, to spread teams over the ground */
  const load = new Map();

  // ---- Roles ----------------------------------------------------------------
  const short = shuffle(
    teams.filter((t) => t.minutes === 45),
    rnd
  );
  const long = shuffle(
    teams.filter((t) => t.minutes === 60),
    rnd
  );
  const role = new Map();
  const take = (list, n, name) => {
    const chosen = list.filter((t) => !role.has(t.label)).slice(0, n);
    if (chosen.length !== n) throw new Error(`not enough teams for ${name}`);
    for (const t of chosen) role.set(t.label, name);
    return chosen;
  };
  take(short, ROLE_COUNTS.dropShort, 'drop');
  take(long, ROLE_COUNTS.drop, 'drop');
  take(long, ROLE_COUNTS.double, 'double');
  take(short, ROLE_COUNTS.wholeTwinShort, 'wholeTwin');
  take(long, ROLE_COUNTS.wholeTwin, 'wholeTwin');

  // Weekday pairs. The 45-minute block has two weekdays only. Of the 98 teams that keep two practices
  // on two weekdays the counts are the plan's; the 34 that a plant touches get filler pairs.
  const pairOf = new Map();
  for (const t of short) pairOf.set(t.label, 'Tue+Thu');
  const keepsTwo = (t) => role.get(t.label) !== 'drop' && role.get(t.label) !== 'double';
  const pool = shuffle(
    Object.entries(PATTERN_COUNTS_60).flatMap(([p, n]) => Array.from({ length: n }, () => p)),
    rnd
  );
  const longKeepingTwo = long.filter(keepsTwo);
  if (pool.length !== longKeepingTwo.length) {
    throw new Error(`${longKeepingTwo.length} long teams for ${pool.length} patterns`);
  }
  longKeepingTwo.forEach((t, i) => pairOf.set(t.label, pool[i]));
  long
    .filter((t) => !keepsTwo(t))
    .forEach((t, i) => pairOf.set(t.label, FILLER_PATTERNS[i % FILLER_PATTERNS.length]));
  if (short.filter(keepsTwo).length !== 18)
    throw new Error('the 45-minute block should keep 18 teams');

  // The teams a plant will move, chosen now so the clean grid leaves them room: C2 shares a coach with
  // C1 and has C1's weekday pair; U and T_h are the teams that stop being "the same slot twice".
  const eligible = (t) => !role.has(t.label) && t.minutes === 60;
  const coachPairs = [];
  const byCoach = new Map();
  for (const t of teams) for (const c of t.coaches) byCoach.set(c, [...(byCoach.get(c) ?? []), t]);
  for (const [coach, list] of byCoach)
    if (
      list.length === 2 &&
      list.every(eligible) &&
      pairOf.get(list[0].label) === pairOf.get(list[1].label)
    ) {
      coachPairs.push({ coach, c1: list[0], c2: list[1] });
    }
  if (coachPairs.length === 0) throw new Error('no two teams share a coach and a weekday pair');
  const { coach: clashCoach, c1, c2 } = coachPairs[0];
  const special = new Set([c1.label, c2.label]);
  role.set(c2.label, 'nonTwin');
  const others = shuffle(
    teams.filter((t) => eligible(t) && !special.has(t.label)),
    rnd
  );
  const halvesTeam = others.shift();
  role.set(halvesTeam.label, 'halves');
  const capacityTeam = others.shift();
  role.set(capacityTeam.label, 'nonTwin');
  let nonTwin = 3;
  while (nonTwin < ROLE_COUNTS.nonTwin) {
    const t = others.shift();
    role.set(t.label, 'nonTwin');
    nonTwin += 1;
  }
  // the pair that shares a cell with capacity 2: two twins, different divisions, no shared coach
  const sharedPair = (() => {
    const free = teams.filter(
      (t) => !role.has(t.label) && t.minutes === 60 && t.label !== c1.label
    );
    for (const a of free)
      for (const b of free) {
        if (a.label >= b.label || a.division === b.division) continue;
        if (pairOf.get(a.label) !== pairOf.get(b.label)) continue;
        if (a.coaches.some((c) => b.coaches.includes(c))) continue;
        return [a, b];
      }
    throw new Error('no two teams can share a cell');
  })();
  for (const t of sharedPair) role.set(t.label, 'shared');

  // ---- Placement ---------------------------------------------------------------
  const fieldsOf = (minutes) => FIELDS.filter((f) => f.block === minutes);
  const coachFree = (team, day, start, end) =>
    team.coaches.every((coach) =>
      (busy.get(coach) ?? []).every(
        (b) =>
          b.label === team.label ||
          b.day !== day ||
          !(toMinutes(b.start) < toMinutes(end) && toMinutes(start) < toMinutes(b.end))
      )
    );
  const loadOf = (fieldId, sub) => load.get(`${fieldId}:${sub}`) ?? 0;
  const assign = (team, cell) => {
    cell.entries.push({ label: team.label, raw: null });
    for (const coach of team.coaches) {
      busy.set(coach, [
        ...(busy.get(coach) ?? []),
        { day: cell.day, start: cell.start, end: cell.end, label: team.label },
      ]);
    }
    for (const sub of cell.sub === '' ? ['A', 'B'] : [cell.sub]) {
      load.set(`${cell.fieldId}:${sub}`, loadOf(cell.fieldId, sub) + 1);
    }
  };
  const open = (cell) => cell && !cell.hold && cell.entries.length < cell.capacity;
  const best = (cands) => cands.sort((a, b) => a.load - b.load || a.r - b.r)[0];

  const makeWhole = (fieldId, day, start) => {
    const a = cells.get(cellKey(fieldId, day, start, 'A'));
    const b = cells.get(cellKey(fieldId, day, start, 'B'));
    if (a.entries.length > 0 || b.entries.length > 0) throw new Error('a whole cell over a team');
    cells.delete(cellKey(fieldId, day, start, 'A'));
    cells.delete(cellKey(fieldId, day, start, 'B'));
    const whole = { ...a, sub: '' };
    cells.set(cellKey(fieldId, day, start, ''), whole);
    return whole;
  };

  /** Half cells on a day, free for a team, in the order they will be tried. */
  const halfCandidates = (team, day, { not = null } = {}) => {
    const cands = [];
    for (const f of fieldsOf(team.minutes))
      for (const sub of ['A', 'B']) {
        if (!halfAllowed(f.id, sub)) continue;
        for (const start of BLOCKS[team.minutes].starts) {
          const cell = cells.get(cellKey(f.id, day, start, sub));
          if (!open(cell) || !coachFree(team, day, start, cell.end)) continue;
          if (not && not.fieldId === f.id && not.sub === sub && not.start === start) continue;
          cands.push({ cell, load: loadOf(f.id, sub), r: rnd() });
        }
      }
    return cands;
  };

  const placeTwin = (team, d1, d2, extra = () => true) => {
    const cands = [];
    for (const f of fieldsOf(team.minutes))
      for (const sub of ['A', 'B']) {
        if (!halfAllowed(f.id, sub)) continue;
        for (const start of BLOCKS[team.minutes].starts) {
          const c1 = cells.get(cellKey(f.id, d1, start, sub));
          const c2 = cells.get(cellKey(f.id, d2, start, sub));
          if (!open(c1) || !open(c2)) continue;
          if (!coachFree(team, d1, start, c1.end) || !coachFree(team, d2, start, c2.end)) continue;
          if (!extra(c1, c2)) continue;
          cands.push({ c1, c2, load: loadOf(f.id, sub), r: rnd() });
        }
      }
    const pick = best(cands);
    if (!pick) throw new Error(`no twin cell for ${team.label}`);
    assign(team, pick.c1);
    assign(team, pick.c2);
    return pick;
  };

  const wholeCandidates = (team, days) => {
    const cands = [];
    for (const f of fieldsOf(team.minutes)) {
      if (!wholeAllowed(f.id)) continue;
      for (const start of BLOCKS[team.minutes].starts) {
        const parts = days.flatMap((d) =>
          ['A', 'B'].map((s) => cells.get(cellKey(f.id, d, start, s)))
        );
        if (!parts.every((c) => c && c.entries.length === 0 && !c.hold)) continue;
        if (!days.every((d) => coachFree(team, d, start, addMinutes(start, team.minutes))))
          continue;
        cands.push({ f, start, load: loadOf(f.id, 'A') + loadOf(f.id, 'B'), r: rnd() });
      }
    }
    return cands;
  };

  const [d1Of, d2Of] = [
    (t) => PATTERN_DAYS[pairOf.get(t.label)][0],
    (t) => PATTERN_DAYS[pairOf.get(t.label)][1],
  ];

  // 1. whole-field twins: both halves of a field, both weekdays
  for (const t of teams.filter((x) => role.get(x.label) === 'wholeTwin')) {
    const days = [d1Of(t), d2Of(t)];
    const pick = best(wholeCandidates(t, days));
    if (!pick) throw new Error(`no whole field for ${t.label}`);
    for (const d of days) assign(t, makeWhole(pick.f.id, d, pick.start));
  }
  // 2. the team that will be split across two halves: a whole field on its first weekday
  {
    const d1 = d1Of(halvesTeam);
    const pick = best(wholeCandidates(halvesTeam, [d1]));
    if (!pick) throw new Error('no whole field for the halves team');
    const whole = makeWhole(pick.f.id, d1, pick.start);
    assign(halvesTeam, whole);
    const second = best(
      halfCandidates(halvesTeam, d2Of(halvesTeam)).filter((c) => c.cell.fieldId !== pick.f.id)
    );
    if (!second) throw new Error('no second cell for the halves team');
    assign(halvesTeam, second.cell);
  }
  // 3. the pair that shares a cell with capacity 2, on both weekdays
  {
    const [a, b] = sharedPair;
    const pick = placeTwin(
      a,
      d1Of(a),
      d2Of(a),
      (c1, c2) => coachFree(b, c1.day, c1.start, c1.end) && coachFree(b, c2.day, c2.start, c2.end)
    );
    pick.c1.capacity = 2;
    pick.c2.capacity = 2;
    assign(b, pick.c1);
    assign(b, pick.c2);
  }
  // 4. every other team: twins, except the non-twins, whose second practice is another cell
  const placed = (t) => [...cells.values()].some((c) => c.entries.some((e) => e.label === t.label));
  const remaining = shuffle(
    teams.filter((t) => !placed(t)),
    rnd
  );
  // Order: the non-twins first (they need two different cells), then the twins.
  const ordered = [
    ...remaining.filter((t) => role.get(t.label) === 'nonTwin'),
    ...remaining.filter((t) => role.get(t.label) !== 'nonTwin'),
  ];
  for (const t of ordered) {
    const d1 = d1Of(t);
    const d2 = d2Of(t);
    if (role.get(t.label) === 'nonTwin') {
      const first = best(halfCandidates(t, d1));
      if (!first) throw new Error(`no first cell for ${t.label}`);
      assign(t, first.cell);
      const second = best(halfCandidates(t, d2, { not: first.cell }));
      if (!second) throw new Error(`no second cell for ${t.label}`);
      assign(t, second.cell);
    } else {
      placeTwin(t, d1, d2);
    }
  }

  return {
    cells,
    role,
    pairOf,
    c1,
    c2,
    clashCoach,
    halvesTeam,
    capacityTeam,
    teamByLabel,
    d1Of,
    d2Of,
  };
}

/* -------------------------------------------------------------------------- */
/* Plants                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Try `candidates` in order on a copy of the grid until the measures move by exactly `expected`,
 * and keep that copy. Throws when none does, so a plant is never silently fewer.
 *
 * @param {string} name
 * @param {Map<string, Cell>} cells
 * @param {Team[]} teams
 * @param {Iterable<(trial: Map<string, Cell>) => boolean>} candidates  each edits its copy and says
 *   whether it applied
 * @param {Record<string, number>} expected
 */
function plant(name, cells, teams, candidates, expected) {
  const before = measure(cells, teams).counts;
  for (const apply of candidates) {
    const trial = cloneGrid(cells);
    if (!apply(trial)) continue;
    const after = measure(trial, teams).counts;
    const moved = Object.keys(after).filter((k) => after[k] !== before[k]);
    const wanted = Object.keys(expected);
    const exact =
      moved.length === wanted.length &&
      wanted.every((k) => moved.includes(k) && after[k] - before[k] === expected[k]);
    if (exact) return trial;
  }
  throw new Error(`plant ${name}: no candidate moved exactly ${JSON.stringify(expected)}`);
}

/** @param {Map<string, Cell>} cells @param {string} label @returns {Cell[]} its cells, in grid order */
const cellsOf = (cells, label) =>
  [...cells.values()].filter((c) => c.entries.some((e) => e.label === label));

/** @param {Cell} cell @param {string} label */
function removeEntry(cell, label) {
  const at = cell.entries.findIndex((e) => e.label === label);
  return cell.entries.splice(at, 1)[0];
}

/**
 * @param {ReturnType<typeof buildCleanGrid>} clean
 * @param {ReturnType<typeof buildLeague>} league
 * @param {() => number} rnd
 */
function applyPlants(clean, league, rnd) {
  const { teams } = league;
  let cells = clean.cells;
  const { role } = clean;
  const record = { halves: [], clash: [], capacity: [], doubled: [], dropped: [], overlap: 0 };
  const byLabel = new Map(teams.map((t) => [t.label, t]));
  const keyOf = (c) => cellKey(c.fieldId, c.day, c.start, c.sub);

  // 1. A team on both halves of one field at one time: the merged cell converted wrongly.
  cells = plant(
    'teamOnBothHalves',
    cells,
    teams,
    [
      (trial) => {
        const wholes = cellsOf(trial, clean.halvesTeam.label).filter((c) => c.sub === '');
        if (wholes.length !== 1) return false;
        const whole = wholes[0];
        const key = keyOf(whole);
        trial.delete(key);
        for (const sub of ['A', 'B']) {
          trial.set(cellKey(whole.fieldId, whole.day, whole.start, sub), {
            ...whole,
            sub,
            entries: [{ label: clean.halvesTeam.label, raw: null }],
          });
        }
        return true;
      },
    ],
    { teamOnBothHalves: 1 }
  );
  record.halves.push(clean.halvesTeam.label);

  // 2. A coach on two teams at one start: C2's first practice moves to C1's weekday and start.
  {
    const { c1, c2 } = clean;
    const mine = cellsOf(cells, c1.label);
    const candidates = [];
    for (const target of mine)
      for (const f of FIELDS.filter((x) => x.block === 60 && x.id !== target.fieldId))
        for (const sub of ['A', 'B']) {
          candidates.push((trial) => {
            const from = cellsOf(trial, c2.label).find((c) => c.day === target.day);
            const to = trial.get(cellKey(f.id, target.day, target.start, sub));
            if (
              !from ||
              !to ||
              !halfAllowed(f.id, sub) ||
              to.entries.length >= to.capacity ||
              to.hold
            )
              return false;
            if (from.sub === '' || cellsOf(trial, c2.label).length !== 2) return false;
            to.entries.push(removeEntry(from, c2.label));
            return true;
          });
        }
    cells = plant('coachClashes', cells, teams, candidates, { coachClashes: 1 });
    record.clash.push(clean.clashCoach);
  }

  // 3. Two teams in a capacity-1 cell: one non-twin team's practice moves into a used cell.
  {
    const u = clean.capacityTeam;
    const candidates = [];
    const used = shuffle(
      [...cells.values()].filter((c) => c.entries.length === 1 && c.capacity === 1 && c.sub !== ''),
      rnd
    );
    for (const host of used)
      candidates.push((trial) => {
        const from = cellsOf(trial, u.label).find((c) => c.day === host.day && c.sub !== '');
        const to = trial.get(keyOf(host));
        if (!from || !to || cellsOf(trial, u.label).length !== 2) return false;
        if (
          to.entries.some((e) => e.label === u.label) ||
          (to.fieldId === from.fieldId && to.start === from.start)
        )
          return false;
        if (byLabel.get(to.entries[0].label).minutes !== u.minutes) return false;
        to.entries.push(removeEntry(from, u.label));
        return true;
      });
    cells = plant('overCapacity', cells, teams, candidates, { overCapacity: 1 });
    record.capacity.push(u.label);
  }

  // 4. Teams in two places at once: the second practice moves to the first's weekday and start,
  //    on another field.
  for (const t of teams.filter((x) => role.get(x.label) === 'double')) {
    const candidates = [];
    const mine = cellsOf(cells, t.label);
    const [first, second] = mine;
    for (const f of shuffle(
      FIELDS.filter((x) => x.block === t.minutes && x.id !== first.fieldId),
      rnd
    ))
      for (const sub of ['A', 'B']) {
        candidates.push((trial) => {
          const from = cellsOf(trial, t.label).find((c) => c.day === second.day && c.sub !== '');
          const to = trial.get(cellKey(f.id, first.day, first.start, sub));
          if (!from || !to || !halfAllowed(f.id, sub) || to.entries.length > 0 || to.hold)
            return false;
          to.entries.push(removeEntry(from, t.label));
          return true;
        });
      }
    cells = plant('doublePlaced', cells, teams, candidates, { doublePlaced: 1 });
    record.doubled.push(t.label);
  }

  // 5. Teams short of their division's count: the second practice is dropped (its cell stays open).
  for (const t of teams.filter((x) => role.get(x.label) === 'drop')) {
    cells = plant(
      'shortTeams',
      cells,
      teams,
      [
        (trial) => {
          const mine = cellsOf(trial, t.label);
          if (mine.length !== 2) return false;
          removeEntry(mine[1], t.label);
          return true;
        },
      ],
      { shortTeams: 1 }
    );
    record.dropped.push(t.label);
  }

  // 6. A non-team activity: one open cell becomes a hold.
  cells = plant(
    'holds',
    cells,
    teams,
    shuffle(
      [...cells.values()].filter(
        (c) => c.entries.length === 0 && c.sub !== '' && c.fieldId.charCodeAt(0) >= 67
      ),
      rnd
    ).map((c) => (trial) => {
      const cell = trial.get(keyOf(c));
      if (!cell || cell.entries.length > 0) return false;
      cell.hold = true;
      return true;
    }),
    { holds: 1 }
  );

  // 7. A slot that overlaps another: a half starting 30 minutes into the last start of a day.
  {
    const candidates = [];
    for (const f of FIELDS.filter((x) => x.block === 60))
      for (const day of WEEK)
        candidates.push((trial) => {
          const start = '18:30';
          const host =
            trial.get(cellKey(f.id, day, '18:00', 'A')) ??
            trial.get(cellKey(f.id, day, '18:00', ''));
          if (!host || host.hold) return false;
          trial.set(cellKey(f.id, day, start, 'A'), {
            fieldId: f.id,
            day,
            start,
            end: '19:30',
            sub: 'A',
            capacity: 1,
            hold: false,
            entries: [],
          });
          return true;
        });
    cells = plant('overlappingSlots', cells, teams, shuffle(candidates, rnd), {
      overlappingSlots: 1,
    });
  }

  // 8. Stray whitespace after two team labels (a twin team's cells; the sweep trims).
  {
    const twins = teams.filter((x) => !role.has(x.label));
    const two = shuffle(twins, rnd).slice(0, 2);
    for (const t of two) {
      cells = plant(
        'trailingWhitespace',
        cells,
        teams,
        [
          (trial) => {
            const mine = cellsOf(trial, t.label)[0];
            const entry = mine.entries.find((e) => e.label === t.label);
            entry.raw = `${t.label} `;
            return true;
          },
        ],
        { trailingWhitespace: 1 }
      );
    }
  }
  return { cells, record };
}

/* -------------------------------------------------------------------------- */
/* Rows                                                                        */
/* -------------------------------------------------------------------------- */

/** @param {string} letter @param {number} n */
const fieldLabel = (letter, n) =>
  ALIASED_FIELD_VENUES.has(letter) ? `Pitch ${letter}${n}` : `Field ${n}`;
/** @param {string} fieldId @param {string} sub */
function subunitLabel(fieldId, sub) {
  if (sub === '') return '';
  if (fieldId === NORTH_SOUTH_FIELD) return sub === 'A' ? `${fieldId} North` : `${fieldId} South`;
  return sub;
}

/**
 * @param {Map<string, Cell>} cells
 * @param {Map<string, Team>} teamByLabel
 */
function materialise(cells, teamByLabel) {
  const order = (c) => {
    const f = FIELD_BY_ID.get(c.fieldId);
    return [
      f.block === 45 ? 0 : 1,
      f.letter,
      f.n,
      BLOCKS[f.block].days.indexOf(c.day),
      c.start,
      c.sub,
    ];
  };
  const cmp = (a, b) => {
    for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    return 0;
  };
  const sorted = [...cells.values()].sort((a, b) => cmp(order(a), order(b)));
  const rows = [];
  const meta = [];
  for (const c of sorted) {
    const f = FIELD_BY_ID.get(c.fieldId);
    const common = {
      Day: c.day,
      Start: c.start,
      End: c.end,
      Location: f.letter === ANNEX_VENUE ? `Venue ${ANNEX_VENUE} Annex` : `Venue ${f.letter}`,
      Field: fieldLabel(f.letter, f.n),
      Subunit: subunitLabel(c.fieldId, c.sub),
      'Valid From': '',
      'Valid Until': '',
      Capacity: c.capacity === 1 ? '' : String(c.capacity),
      Block: String(f.block),
    };
    if (c.entries.length === 0) {
      rows.push({ Team: '', Division: '', ...common, Use: c.hold ? 'hold' : '' });
      meta.push({ cell: c, entry: null });
    } else {
      for (const e of c.entries) {
        rows.push({
          Team: e.raw ?? e.label,
          Division: teamByLabel.get(e.label).division,
          ...common,
          Use: '',
        });
        meta.push({ cell: c, entry: e });
      }
    }
  }
  return { rows, meta };
}

/* -------------------------------------------------------------------------- */
/* practice-invalid.csv                                                         */
/* -------------------------------------------------------------------------- */

/**
 * About thirty rows: one for every row-level refusal reason of plan 4.11.4, the accepted-and-flagged
 * kinds (a team on both halves, a hold over an open slot, a Division on an open row), and a few
 * plain rows that must stay valid in the forms the importer reads (US dates, 12-hour times, full
 * weekday names, `Length` for `End`). `Notes` says what the importer is expected to do with each; it
 * is a column the importer drops, so this file is also a check of the allowlist. The labels name this
 * fixture's own league (`teams.csv`, `surfaces.csv`), except where the row's reason is that they do
 * not. The season is {@link PRACTICE_INVALID_SEASON}: no end date, so a row without its own
 * `Valid Until` is `missing-dates`; every other row carries both of its dates.
 */
function invalidRows() {
  const from = '2026-09-14';
  const until = '2026-11-20';
  const base = {
    Team: 'U05B-01',
    Division: 'U05 Boys',
    Day: 'Mon',
    Start: '16:00',
    End: '17:00',
    Length: '',
    Location: 'Venue A',
    Field: 'Field 1',
    Subunit: 'A',
    'Valid From': from,
    'Valid Until': until,
    Capacity: '',
    Use: '',
  };
  /** @type {Array<[Record<string, string>, string]>} */
  const spec = [
    [{}, 'ok'],
    [
      {
        Team: 'U05B-02',
        Day: 'Tuesday',
        Start: '4:00 PM',
        End: '5:00 PM',
        'Valid From': '9/14/2026',
        'Valid Until': '11/20/2026',
      },
      'ok',
    ],
    [{ Team: 'U05B-03', Day: 'WED', Start: '12:30 PM', End: '1:30 PM' }, 'ok'],
    [{ Team: 'U05B-04', Day: 'tue', Start: '18:00', End: '', Length: '60' }, 'ok'],
    [{ Team: '', Division: '', Day: 'Fri', 'Valid From': '' }, 'open'],
    [{ Team: '', Division: '', Day: 'Fri', Start: '17:00', End: '18:00', Use: 'hold' }, 'hold'],
    [
      { Team: '', Division: '', Day: 'Fri', Start: '18:00', End: '19:00', Use: 'clinic' },
      'bad-use',
    ],
    [{ Day: 'Funday', Start: '19:00', End: '20:00' }, 'bad-day'],
    [{ Start: '25:00', End: '26:00' }, 'bad-time'],
    [{ Start: 'noon', End: '13:00', Day: 'Tue' }, 'bad-time'],
    [{ End: '', Length: 'abc', Day: 'Wed', Start: '19:00' }, 'bad-length'],
    [{ Start: '17:00', End: '16:00', Day: 'Thu' }, 'end-not-after-start'],
    [{ Capacity: 'two', Day: 'Fri', Start: '19:00', End: '20:00' }, 'bad-capacity'],
    [{ Capacity: '0', Day: 'Fri', Start: '20:00', End: '21:00' }, 'capacity-not-positive'],
    [{ 'Valid From': '13/04/2026', Day: 'Thu', Start: '20:00', End: '21:00' }, 'bad-date'],
    [{ 'Valid Until': '2026-02-30', Day: 'Thu', Start: '19:00', End: '20:00' }, 'bad-date'],
    [
      { 'Valid From': until, 'Valid Until': from, Day: 'Wed', Start: '20:00', End: '21:00' },
      'valid-until-before-from',
    ],
    [
      { 'Valid From': '2026-08-01', Day: 'Tue', Start: '20:00', End: '21:00' },
      'outside-season-window',
    ],
    [{ 'Valid Until': '', Day: 'Tue', Start: '19:00', End: '20:00' }, 'missing-dates'],
    [
      { Division: 'U99 Boys', Team: 'U99B-01', Day: 'Mon', Start: '20:00', End: '21:00' },
      'unknown-division',
    ],
    [{ Team: 'Unlisted-01', Day: 'Mon', Start: '19:00', End: '20:00' }, 'unknown-team'],
    [{ Location: 'Venue Z', Day: 'Mon', Start: '21:00', End: '22:00' }, 'unknown-location'],
    [{ Field: 'Field 9', Day: 'Mon', Start: '22:00', End: '23:00' }, 'unknown-field'],
    [{ Subunit: 'C', Day: 'Tue', Start: '21:00', End: '22:00' }, 'unknown-subunit'],
    [
      { Team: 'U06B-01', Division: 'U06 Boys', Location: 'Venue B', Field: 'Field 3', Day: 'Mon' },
      'team-in-two-divisions',
    ],
    [
      { Team: 'U06B-01', Division: 'U06 Girls', Location: 'Venue B', Field: 'Field 3', Day: 'Wed' },
      'team-in-two-divisions',
    ],
    [
      { Team: 'U07B-01', Division: 'U07 Boys', Location: 'Venue B', Field: 'Field 1', Day: 'Mon' },
      'ok',
    ],
    [
      {
        Team: 'U07B-02',
        Division: 'U07 Boys',
        Location: 'Venue B',
        Field: 'Field 1',
        Subunit: '',
        Day: 'Mon',
        Start: '16:30',
        End: '17:30',
      },
      'slot-overlaps-another',
    ],
    [{}, 'duplicate-row'],
    [
      { Team: 'U08B-01', Division: 'U08 Boys', Location: 'Venue B', Field: 'Field 2', Day: 'Tue' },
      'team-on-both-halves',
    ],
    [
      {
        Team: 'U08B-01',
        Division: 'U08 Boys',
        Location: 'Venue B',
        Field: 'Field 2',
        Subunit: 'B',
        Day: 'Tue',
      },
      'team-on-both-halves',
    ],
    [{ Team: '', Day: 'Wed', Start: '17:00', End: '18:00' }, 'division-not-reserved'],
    [
      { Team: '', Division: '', Location: 'Venue C', Field: 'Field 1', Day: 'Wed', Start: '16:00' },
      'open',
    ],
    [
      {
        Team: '',
        Division: '',
        Location: 'Venue C',
        Field: 'Field 1',
        Day: 'Wed',
        Start: '16:00',
        Use: 'hold',
      },
      'hold-over-open-slot',
    ],
  ];
  return spec.map(([over, note]) => ({ ...base, ...over, Notes: `expect: ${note}` }));
}

/* -------------------------------------------------------------------------- */
/* Building and writing                                                         */
/* -------------------------------------------------------------------------- */

/** @param {string[]} columns @param {Array<Record<string, string>>} rows */
function toCsv(columns, rows) {
  return (
    Papa.unparse(
      { fields: columns, data: rows.map((r) => columns.map((c) => r[c] ?? '')) },
      { newline: '\n' }
    ) + '\n'
  );
}

/** The alias file (plan 4.11.5): 21 rows, 20 distinct targets, one of them unused by the schedule. */
function aliasRows() {
  const rows = [];
  rows.push({
    Alias: `Venue ${ANNEX_VENUE} Annex`,
    Location: `Venue ${ANNEX_VENUE}`,
    Field: '',
    Subunit: '',
  });
  for (const f of FIELDS.filter((x) => ALIASED_FIELD_VENUES.has(x.letter))) {
    rows.push({
      Alias: fieldLabel(f.letter, f.n),
      Location: `Venue ${f.letter}`,
      Field: `Field ${f.n}`,
      Subunit: '',
    });
  }
  rows.push({
    Alias: `${NORTH_SOUTH_FIELD} North`,
    Location: 'Venue H',
    Field: 'Field 1',
    Subunit: 'A',
  });
  rows.push({
    Alias: `${NORTH_SOUTH_FIELD} South`,
    Location: 'Venue H',
    Field: 'Field 1',
    Subunit: 'B',
  });
  // a second spelling of a field the schedule already writes another way: unused, same target
  rows.push({
    Alias: 'Annex Pitch',
    Location: `Venue ${ANNEX_VENUE}`,
    Field: 'Field 1',
    Subunit: '',
  });
  return rows;
}

/**
 * @param {{ plants?: boolean }} [options] `plants: false` is the control: the clean grid.
 */
export function buildPracticeFixture({ plants = true } = {}) {
  const rnd = prng(SEED);
  const league = buildLeague(rnd);
  const clean = buildCleanGrid(league, rnd);
  const teamByLabel = new Map(league.teams.map((t) => [t.label, t]));

  const cleanMeasure = measure(clean.cells, league.teams);
  if (Object.values(cleanMeasure.counts).some((n) => n !== 0)) {
    throw new Error(`the pre-plant grid is not clean: ${JSON.stringify(cleanMeasure.counts)}`);
  }
  for (const t of league.teams) {
    const n = cellsOf(clean.cells, t.label).length;
    if (n !== 2) throw new Error(`${t.label} has ${n} placements in the clean grid`);
  }

  let cells = clean.cells;
  let planted;
  if (plants) {
    const done = applyPlants(clean, league, rnd);
    cells = done.cells;
    const after = measure(cells, league.teams);
    for (const [k, n] of Object.entries(PRACTICE_PLANT_COUNTS)) {
      if (after.counts[k] !== n) throw new Error(`plant ${k}: ${after.counts[k]}, not ${n}`);
    }
    planted = after.who;
  }

  const { rows, meta } = materialise(cells, teamByLabel);
  if (plants) {
    // Rows named by number are known only now that the rows are in file order.
    planted.trailingWhitespace = meta
      .map((m, i) => (m.entry && m.entry.raw !== null ? `row ${i + 1}` : null))
      .filter(Boolean);
    planted.holds = meta.map((m, i) => (m.cell.hold ? `row ${i + 1}` : null)).filter(Boolean);
  } else {
    planted = Object.fromEntries(Object.keys(PRACTICE_PLANT_COUNTS).map((k) => [k, []]));
  }

  const teamRows = league.teams.map((t) => ({
    Team: t.label,
    Division: t.division,
    'Coach 1': t.coaches[0],
    'Coach 2': t.coaches[1] ?? '',
    'Coach 3': t.coaches[2] ?? '',
  }));
  const divisionRows = league.divisions.map((d) => ({
    Division: d.name,
    'Practices Per Week': '2',
    'Practice Minutes': String(d.minutes),
  }));
  const surfaceRows = FIELDS.flatMap((f) =>
    ['A', 'B'].map((sub) => ({
      Location: `Venue ${f.letter}`,
      Field: `Field ${f.n}`,
      Subunit: sub,
    }))
  );

  return {
    files: {
      'practice-schedule.csv': toCsv(SCHEDULE_COLUMNS, rows),
      'practice-invalid.csv': toCsv(INVALID_COLUMNS, invalidRows()),
      'aliases.csv': toCsv(['Alias', 'Location', 'Field', 'Subunit'], aliasRows()),
      'teams.csv': toCsv(['Team', 'Division', 'Coach 1', 'Coach 2', 'Coach 3'], teamRows),
      'surfaces.csv': toCsv(['Location', 'Field', 'Subunit'], surfaceRows),
      'divisions.csv': toCsv(['Division', 'Practices Per Week', 'Practice Minutes'], divisionRows),
    },
    planted,
  };
}

/**
 * The files of `dir` that differ from a fresh build, missing ones included.
 * @param {string} [dir]
 * @returns {string[]}
 */
export function fixtureDifferences(dir = PRACTICE_FIXTURE_DIR) {
  const { files } = buildPracticeFixture();
  return PRACTICE_FIXTURE_FILES.filter((file) => {
    const target = path.join(dir, file);
    return !existsSync(target) || readFileSync(target, 'utf8') !== files[file];
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf('--dir');
  const dir = at > -1 ? path.resolve(process.argv[at + 1]) : PRACTICE_FIXTURE_DIR;
  if (process.argv.includes('--check')) {
    const differing = fixtureDifferences(dir);
    if (differing.length > 0) {
      for (const file of differing) {
        console.error(
          `${file} differs from the generator (or is missing): run node scripts/build-practice-fixture.mjs`
        );
      }
      process.exit(1);
    }
    console.log('the practice fixture matches the generator');
  } else {
    const { files, planted } = buildPracticeFixture();
    for (const file of PRACTICE_FIXTURE_FILES) writeFileSync(path.join(dir, file), files[file]);
    console.log(
      `wrote ${PRACTICE_FIXTURE_FILES.length} files into ${path.relative(REPO_ROOT, dir)}; plants: ${JSON.stringify(
        Object.fromEntries(Object.entries(planted).map(([k, v]) => [k, v.length]))
      )}`
    );
  }
}
