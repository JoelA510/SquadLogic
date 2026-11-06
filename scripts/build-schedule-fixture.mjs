#!/usr/bin/env node
/**
 * Build `fixtures/schedule-2026/`: a placeholder league and the schedule CSV an organization that
 * arrives with an already generated schedule would import (plan
 * `docs/changes/2026-11-03-schedule-expansion.md` section 4.9, PR 4 task D1).
 *
 *   node scripts/build-schedule-fixture.mjs                       rewrite the four files
 *   node scripts/build-schedule-fixture.mjs --check [--dir DIR]   exit 1 when DIR (default: the
 *                                                                 fixture) differs from a fresh build
 *
 * **Every value is invented.** The only inputs taken from the owner's example workbook are the
 * COUNTS in the README's shape table (games, Saturdays, venues, fields, divisions, teams, coach
 * seats, outside fixtures); no name, venue, club, coach or value came from it, and this repository
 * has never held it. Names follow the conventions `tests/demoFixture.test.js` and
 * `tests/realNameDenylist.test.js` hold: `Venue A`.., `Field 1`.., `Visiting Club A`..,
 * `CoachFirstN CoachLastN`, no email address anywhere.
 *
 * **The schedule is the product's own.** The pairings are `buildDivisionRoundRobins`'s (a second
 * cycle with the sides swapped fills the nine weeks), the placement is `scheduleGames`, and the
 * script THROWS when the generator leaves a game unplaced, or when the pre-plant schedule is not
 * clean under `evaluateGameSchedule` (the Games page's own report): a fixture with a hidden clash
 * would make every "the audit found the plant" test vacuous. The outside fixtures are then added
 * by this script (the generator never schedules a club that is not a team), on a venue of their
 * own.
 *
 * **Plants** are small named functions applied to a COPY of the clean schedule. Each has a count,
 * is tried over candidates until the Games page report moves by exactly that plant and nothing else,
 * and records the games it touched. `tests/scheduleFixture.test.js` recounts them from the CSV with
 * a separate sweep; the pre-plant copy (`plants: false`) is the control that finds none.
 *
 * Deterministic: a seeded PRNG written below, no clock, no host time zone (wall times become
 * instants through `timing/seasonClock.js`, and only inside this script's own check).
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Papa from 'papaparse';
import { evaluateGameSchedule } from '../packages/core/src/gameMetrics.js';
import { buildDivisionRoundRobins, scheduleGames } from '../packages/core/src/gameScheduling.js';
import { resolveZonedInstant } from '../packages/core/src/timing/seasonClock.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SCHEDULE_FIXTURE_DIR = path.join(REPO_ROOT, 'fixtures', 'schedule-2026');

/**
 * The season the files are judged against. The window is long on purpose: the fall-back Sunday
 * (2026-11-01) and the spring-forward Sunday (2027-03-14) are both inside it, so
 * `schedule-invalid.csv` can reach `time-ambiguous` and `time-in-dst-gap` with real dates.
 */
export const FIXTURE_SEASON = Object.freeze({
  timeZone: 'America/Los_Angeles',
  startDate: '2026-09-07',
  endDate: '2027-03-31',
});

/** What each plant does to a copy of the clean schedule, and how many times. */
export const PLANT_COUNTS = Object.freeze({
  sameFieldOverlaps: 3,
  coachClashes: 3,
  hostingImbalances: 3,
  blankTimes: 1,
});

export const FIXTURE_FILES = Object.freeze([
  'schedule.csv',
  'teams.csv',
  'venues.csv',
  'schedule-invalid.csv',
]);

const SCHEDULE_COLUMNS = [
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
  'Format',
];
const INVALID_COLUMNS = [...SCHEDULE_COLUMNS.filter((c) => c !== 'Format'), 'Notes'];

/* -------------------------------------------------------------------------- */
/* The league: counts from the plan, every name invented                       */
/* -------------------------------------------------------------------------- */

const SEED = 20261106;
const AGES = [5, 6, 7, 8, 9, 10, 12, 14, 16, 19];
/** Teams per division, in division order (U05B, U05G, U06B, ...): 6 x 8, 7 x 7, 7 x 5 = 132. */
const DIVISION_SIZES = [8, 8, 8, 8, 8, 8, 7, 7, 7, 7, 7, 7, 7, 5, 5, 5, 5, 5, 5, 5];
const FORMAT_OF_AGE = { 5: '4v4', 6: '4v4', 7: '5v5', 8: '5v5', 9: '7v7', 10: '7v7', 12: '9v9' };
const WEEKS = 9;
const SATURDAYS = [
  '2026-09-12',
  '2026-09-19',
  '2026-09-26',
  '2026-10-03',
  '2026-10-10',
  '2026-10-17',
  '2026-10-24',
  '2026-10-31',
  '2026-11-07',
];
/** Venue, fields, first start, game block in minutes. Venue G hosts only the outside clubs. */
const VENUES = [
  ['A', 4, '08:00', 60],
  ['B', 4, '08:00', 60],
  ['C', 4, '08:30', 75],
  ['D', 4, '08:30', 75],
  ['E', 4, '09:00', 90],
  ['F', 3, '09:00', 90],
  ['G', 3, '09:00', 60],
];
const OUTSIDE_VENUE = 'G';
const BLOCKS_PER_FIELD = 4;
const BLOCK_GAP = 15;
/** The six five-team divisions that meet outside clubs, and how many fixtures each has (43). */
const OUTSIDE_DIVISIONS = [
  ['U12G', 8],
  ['U14B', 7],
  ['U14G', 7],
  ['U16B', 7],
  ['U16G', 7],
  ['U19B', 7],
];
const OUTSIDE_LABELS = 31;
const SECOND_COACHES = 82;
const SHARED_COACHES = 19;

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

const pad2 = (n) => String(n).padStart(2, '0');
/** @param {string} hhmm */
const toMinutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
/** @param {number} total */
const toHhmm = (total) => `${pad2(Math.floor(total / 60))}:${pad2(total % 60)}`;

/** `A`..`Z`, then `AA`..: the nth outside club. @param {number} n */
function clubLetters(n) {
  return n < 26 ? String.fromCharCode(65 + n) : `A${String.fromCharCode(65 + n - 26)}`;
}

/**
 * @typedef {Object} FixtureTeam
 * @property {string} id
 * @property {string} label
 * @property {string} division  the division CODE, `U05B`
 * @property {string} divisionName  `U05 Boys`
 * @property {number[]} coachPersons  indices of the people who coach it, in seat order
 */

/** @param {() => number} rnd */
function buildLeague(rnd) {
  const divisions = [];
  for (const age of AGES)
    for (const g of 'BG') {
      const code = `U${pad2(age)}${g}`;
      divisions.push({
        code,
        age,
        name: `U${pad2(age)} ${g === 'B' ? 'Boys' : 'Girls'}`,
        size: DIVISION_SIZES[divisions.length],
      });
    }
  /** @type {FixtureTeam[]} */
  const teams = [];
  for (const d of divisions)
    for (let n = 1; n <= d.size; n += 1)
      teams.push({
        id: `${d.code}-${pad2(n)}`,
        label: `${d.code} Team ${pad2(n)}`,
        division: d.code,
        divisionName: d.name,
        coachPersons: [],
      });

  // Seats: every team has a first coach, 82 have a second, one of those a third (215 in all).
  const seats = teams.map((t, i) => ({ team: i, slot: 1 }));
  const order = teams.map((_, i) => i).sort(() => rnd() - 0.5);
  for (const i of order.slice(0, SECOND_COACHES)) seats.push({ team: i, slot: 2 });
  seats.push({ team: order[0], slot: 3 });
  // One person per seat, then 19 people made to hold two seats on teams of different divisions
  // (siblings in two age groups), so the generator has real coach constraints to respect.
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
    .forEach((s) => teams[s.team].coachPersons.push(s.person));
  return { divisions, teams };
}

/** Coach people are numbered by first appearance in teams.csv, as the demo fixture's are. */
function coachNamer(teams) {
  /** @type {Map<number, string>} */
  const names = new Map();
  for (const t of teams)
    for (const p of t.coachPersons)
      if (!names.has(p)) names.set(p, `CoachFirst${names.size + 1} CoachLast${names.size + 1}`);
  return (person) => names.get(person);
}

/* -------------------------------------------------------------------------- */
/* The clean schedule                                                          */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {Object} Game
 * @property {string} id  `G-0001`, assigned from the clean schedule's order and kept by every plant
 * @property {number} week
 * @property {string} date
 * @property {string} start  `HH:mm`, or `''` once a plant blanks it
 * @property {string} end
 * @property {string} venue  `Venue A`
 * @property {string} field  `Field 1`
 * @property {string} division  `U05 Boys`
 * @property {string} divisionCode
 * @property {string} home  label
 * @property {string} away  label
 * @property {string | null} homeTeam  own team id, or null for an outside club
 * @property {string | null} awayTeam
 */

function buildCleanGames(league, rnd) {
  const { divisions, teams } = league;
  const teamById = new Map(teams.map((t) => [t.id, t]));
  const personId = (p) => `coach-${p}`;
  const scheduleTeams = teams.map((t) => ({
    id: t.id,
    name: t.label,
    division: t.division,
    coachId: personId(t.coachPersons[0]),
    assistantCoachIds: t.coachPersons.slice(1).map(personId),
  }));

  // Pairings: the product's round robin, once, then again with every pair's sides swapped; the
  // first nine weeks of the two cycles back to back.
  const first = buildDivisionRoundRobins(scheduleTeams).roundRobinByDivision;
  const swapped = [];
  for (const weeks of Object.values(first))
    for (const w of weeks)
      for (const m of w.matchups)
        swapped.push({ homeTeamId: m.awayTeamId, awayTeamId: m.homeTeamId });
  const second = buildDivisionRoundRobins(scheduleTeams, {
    keepSides: swapped,
  }).roundRobinByDivision;
  /** @type {Record<string, any[]>} */
  const roundRobinByDivision = {};
  for (const d of divisions) {
    const one = first[d.code];
    const two = second[d.code];
    roundRobinByDivision[d.code] = Array.from({ length: WEEKS }, (_, i) => {
      const src = i < one.length ? one[i] : two[(i - one.length) % two.length];
      return { weekIndex: i + 1, matchups: src.matchups, byes: src.byes };
    });
  }

  // Slots: every field but the outside venue's, four blocks a Saturday.
  const slotMeta = new Map();
  const slots = [];
  for (const [venue, fieldCount, base, length] of VENUES) {
    if (venue === OUTSIDE_VENUE) continue;
    for (let f = 1; f <= fieldCount; f += 1)
      for (let w = 0; w < WEEKS; w += 1)
        for (let b = 0; b < BLOCKS_PER_FIELD; b += 1) {
          const start = toHhmm(toMinutes(base) + b * (length + BLOCK_GAP));
          const end = toHhmm(toMinutes(start) + length);
          const id = `slot-${venue}${f}-w${w + 1}-b${b + 1}`;
          const meta = {
            date: SATURDAYS[w],
            start,
            end,
            venue: `Venue ${venue}`,
            field: `Field ${f}`,
          };
          slotMeta.set(id, meta);
          slots.push({
            id,
            weekIndex: w + 1,
            capacity: 1,
            fieldId: `${venue}${f}`,
            start: instant(meta.date, start),
            end: instant(meta.date, end),
          });
        }
  }
  const placed = scheduleGames({ teams: scheduleTeams, slots, roundRobinByDivision });
  if (placed.unscheduled.length > 0) {
    throw new Error(`the generator left ${placed.unscheduled.length} game(s) unplaced`);
  }

  /** @type {Game[]} */
  const games = placed.assignments.map((a) => {
    const meta = slotMeta.get(a.slotId);
    const home = teamById.get(a.homeTeamId);
    const away = teamById.get(a.awayTeamId);
    return {
      id: '',
      week: a.weekIndex,
      date: meta.date,
      start: meta.start,
      end: meta.end,
      venue: meta.venue,
      field: meta.field,
      division: home.divisionName,
      divisionCode: home.division,
      home: home.label,
      away: away.label,
      homeTeam: home.id,
      awayTeam: away.id,
    };
  });

  addOutsideFixtures({ games, league, roundRobinByDivision, rnd });

  games.sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      a.start.localeCompare(b.start) ||
      a.venue.localeCompare(b.venue) ||
      a.field.localeCompare(b.field) ||
      a.home.localeCompare(b.home)
  );
  games.forEach((g, i) => {
    g.id = `G-${String(i + 1).padStart(4, '0')}`;
  });
  return games;
}

const instantCache = new Map();
/** The season-clock instant of a wall time: the only place a time zone is read. */
function instant(date, time) {
  const key = `${date}T${time}`;
  if (!instantCache.has(key)) {
    instantCache.set(
      key,
      resolveZonedInstant({ date, time, timeZone: FIXTURE_SEASON.timeZone }).iso
    );
  }
  return instantCache.get(key);
}

/**
 * The 43 outside fixtures. An outside club fills a week the own team has a bye, at Venue G, with a
 * time at which none of that team's coaches is on another field. Who hosts is chosen to keep the
 * own team's home/away within one: it hosts when it has hosted fewer, visits when more, and the
 * PRNG decides a tie. (If the outside club always visited, a five-team division with seven such
 * games could not stay within one; the report would flag it before any plant did.)
 */
function addOutsideFixtures({ games, league, roundRobinByDivision, rnd }) {
  const { teams } = league;
  const teamById = new Map(teams.map((t) => [t.id, t]));
  const busy = new Map(); // `${week}|${person}` -> [{ start, end }]
  const markBusy = (week, persons, start, end) => {
    for (const p of persons) {
      const key = `${week}|${p}`;
      busy.set(key, [...(busy.get(key) ?? []), { start: toMinutes(start), end: toMinutes(end) }]);
    }
  };
  const clashes = (week, persons, start, end) =>
    persons.some((p) =>
      (busy.get(`${week}|${p}`) ?? []).some(
        (b) => b.start < toMinutes(end) && toMinutes(start) < b.end
      )
    );
  for (const g of games)
    for (const id of [g.homeTeam, g.awayTeam])
      markBusy(g.week, teamById.get(id).coachPersons, g.start, g.end);
  const load = new Map(); // own team id -> home minus away
  for (const g of games) {
    load.set(g.homeTeam, (load.get(g.homeTeam) ?? 0) + 1);
    load.set(g.awayTeam, (load.get(g.awayTeam) ?? 0) - 1);
  }
  const length = VENUES.find((v) => v[0] === OUTSIDE_VENUE)[3];
  const [, fieldCount, base] = VENUES.find((v) => v[0] === OUTSIDE_VENUE);
  const taken = new Set();
  const pairs = new Set();
  let k = 0;
  for (const [code, count] of OUTSIDE_DIVISIONS) {
    const byes = roundRobinByDivision[code].flatMap((w) =>
      w.byes.map((teamId) => ({ week: w.weekIndex, teamId }))
    );
    let made = 0;
    for (const bye of byes) {
      if (made === count) break;
      const own = teamById.get(bye.teamId);
      const date = SATURDAYS[bye.week - 1];
      let slot = null;
      for (let b = 0; b < BLOCKS_PER_FIELD && !slot; b += 1)
        for (let f = 1; f <= fieldCount && !slot; f += 1) {
          const start = toHhmm(toMinutes(base) + b * (length + BLOCK_GAP));
          const end = toHhmm(toMinutes(start) + length);
          const key = `${date}|${f}|${start}`;
          if (taken.has(key) || clashes(bye.week, own.coachPersons, start, end)) continue;
          slot = { key, start, end, field: `Field ${f}` };
        }
      if (!slot) continue;
      const label = `Visiting Club ${clubLetters(k % OUTSIDE_LABELS)}`;
      const pair = `${code}|${label}`;
      if (pairs.has(pair)) throw new Error(`outside club used twice in one division: ${pair}`);
      pairs.add(pair);
      taken.add(slot.key);
      markBusy(bye.week, own.coachPersons, slot.start, slot.end);
      const d = load.get(own.id) ?? 0;
      const ownHosts = d < 0 || (d === 0 && rnd() < 0.5);
      load.set(own.id, d + (ownHosts ? 1 : -1));
      games.push({
        id: '',
        week: bye.week,
        date,
        start: slot.start,
        end: slot.end,
        venue: `Venue ${OUTSIDE_VENUE}`,
        field: slot.field,
        division: own.divisionName,
        divisionCode: code,
        home: ownHosts ? own.label : label,
        away: ownHosts ? label : own.label,
        homeTeam: ownHosts ? own.id : null,
        awayTeam: ownHosts ? null : own.id,
      });
      k += 1;
      made += 1;
    }
    if (made !== count) throw new Error(`${code}: placed ${made} of ${count} outside fixtures`);
  }
}

/* -------------------------------------------------------------------------- */
/* The Games page's report over a list of games                                 */
/* -------------------------------------------------------------------------- */

/**
 * `evaluateGameSchedule` over `games` the way the importer will ask it: own teams with their
 * coaches, each outside (division, label) a team with none, games without a time left out.
 * @param {Game[]} games
 * @param {FixtureTeam[]} teams
 * @returns {Record<string, number>} warnings by type
 */
function reportCounts(games, teams) {
  const own = new Set(teams.map((t) => t.label));
  const scheduleTeams = teams.map((t) => ({
    id: t.label,
    division: t.division,
    coachId: `coach-${t.coachPersons[0]}`,
    assistantCoachIds: t.coachPersons.slice(1).map((p) => `coach-${p}`),
  }));
  const idOf = (g, label) => (own.has(label) ? label : `outside|${g.divisionCode}|${label}`);
  const seen = new Set(scheduleTeams.map((t) => t.id));
  const assignments = [];
  for (const g of games) {
    if (g.start === '' || g.end === '') continue;
    for (const label of [g.home, g.away]) {
      const id = idOf(g, label);
      if (!seen.has(id)) {
        seen.add(id);
        scheduleTeams.push({ id, division: g.divisionCode });
      }
    }
    assignments.push({
      weekIndex: g.week,
      division: g.divisionCode,
      slotId: g.id,
      id: g.id,
      start: instant(g.date, g.start),
      end: instant(g.date, g.end),
      homeTeamId: idOf(g, g.home),
      awayTeamId: idOf(g, g.away),
      fieldId: `${g.venue}|${g.field}`,
    });
  }
  const { warnings } = evaluateGameSchedule({ assignments, teams: scheduleTeams });
  /** @type {Record<string, number>} */
  const byType = {};
  for (const w of warnings) byType[w.type] = (byType[w.type] ?? 0) + 1;
  return byType;
}

/* -------------------------------------------------------------------------- */
/* Plants                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Try `candidates` in order against a copy of `games` until `tryApply` moves the Games page report
 * by exactly one more warning of `type` (or, for `type: null`, by none) and nothing else; keep that
 * copy and go on, until `count` are kept. `tryApply` returns null (not this candidate) or the games
 * it touched and a `commit` that records what it used; `commit` runs only for a kept candidate.
 * Throws when the candidates run out, so a plant that cannot be placed is never silently fewer.
 */
function plant({ name, count, type, games, teams, candidates, tryApply }) {
  /** @type {string[][]} */
  const kept = [];
  let expected = reportCounts(games, teams);
  for (const candidate of candidates([...games])) {
    if (kept.length === count) break;
    const trial = games.map((g) => ({ ...g }));
    const attempt = tryApply(trial, candidate);
    if (attempt === null) continue;
    const after = reportCounts(trial, teams);
    const want = type === null ? expected : { ...expected, [type]: (expected[type] ?? 0) + 1 };
    if (JSON.stringify(sortKeys(after)) !== JSON.stringify(sortKeys(want))) continue;
    games.splice(0, games.length, ...trial);
    attempt.commit();
    expected = after;
    kept.push(attempt.touched);
  }
  if (kept.length !== count) {
    throw new Error(`plant ${name}: placed ${kept.length} of ${count}`);
  }
  return { count, gameIds: kept.flat() };
}
const sortKeys = (o) =>
  Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));

function applyPlants(games, league) {
  const { teams } = league;
  const byLabel = new Map(teams.map((t) => [t.label, t]));
  const used = new Set(); // games a plant has touched: no two plants share a game
  const wholeFieldList = VENUES.flatMap(([venue, n]) =>
    Array.from({ length: n }, (_, i) => ({ venue: `Venue ${venue}`, field: `Field ${i + 1}` }))
  );
  /** @type {Record<string, { count: number, gameIds: string[] }>} */
  const record = {};

  // 1. Two games on one field in overlapping time: the second moved to start 15 minutes into the
  // first, on the same field. Three different fields.
  const fieldsUsed = new Set();
  record.sameFieldOverlaps = plant({
    name: 'sameFieldOverlaps',
    count: PLANT_COUNTS.sameFieldOverlaps,
    type: 'field-overlap',
    games,
    teams,
    candidates: function* (current) {
      const byField = new Map();
      for (const g of current) {
        const key = `${g.date}|${g.venue}|${g.field}`;
        byField.set(key, [...(byField.get(key) ?? []), g]);
      }
      for (const items of byField.values()) {
        items.sort((a, b) => a.start.localeCompare(b.start));
        for (let i = 1; i < items.length; i += 1)
          yield { first: items[i - 1].id, second: items[i].id };
      }
    },
    tryApply: (trial, { first, second }) => {
      const a = trial.find((g) => g.id === first);
      const b = trial.find((g) => g.id === second);
      const fieldKey = `${a.venue}|${a.field}`;
      if (fieldsUsed.has(fieldKey) || used.has(first) || used.has(second)) return null;
      const length = toMinutes(b.end) - toMinutes(b.start);
      b.start = toHhmm(toMinutes(a.start) + 15);
      b.end = toHhmm(toMinutes(b.start) + length);
      return {
        touched: [first, second],
        commit: () => {
          fieldsUsed.add(fieldKey);
          used.add(first).add(second);
        },
      };
    },
  });

  // 2. One coach in two places at once: a game of one of the coach's teams is moved onto another
  // field at the start of a game of the coach's other team. The moved team is the AWAY side of its
  // game, so a check that reads the home side alone cannot find the clash.
  const coachesUsed = new Set();
  record.coachClashes = plant({
    name: 'coachClashes',
    count: PLANT_COUNTS.coachClashes,
    type: 'coach-conflict',
    games,
    teams,
    candidates: function* (current) {
      const sides = [];
      for (const g of current)
        for (const [role, label] of [
          ['home', g.home],
          ['away', g.away],
        ])
          if (byLabel.has(label)) sides.push({ game: g, role, team: byLabel.get(label) });
      for (const x of sides)
        for (const y of sides) {
          if (x.game.id === y.game.id || x.game.week !== y.game.week || y.role !== 'away') continue;
          if (x.team.division === y.team.division) continue;
          const shared = x.team.coachPersons.filter((p) => y.team.coachPersons.includes(p));
          if (shared.length === 1) yield { x: x.game.id, y: y.game.id, coach: shared[0] };
        }
    },
    tryApply: (trial, { x, y, coach }) => {
      if (used.has(x) || used.has(y) || coachesUsed.has(coach)) return null;
      const gx = trial.find((g) => g.id === x);
      const gy = trial.find((g) => g.id === y);
      const start = gx.start;
      const end = toHhmm(toMinutes(start) + toMinutes(gy.end) - toMinutes(gy.start));
      // a field, other than the first game's, where nothing is on at that time
      const free = wholeFieldList.find(
        (f) =>
          !(f.venue === gx.venue && f.field === gx.field) &&
          !trial.some(
            (g) =>
              g.id !== y &&
              g.date === gx.date &&
              g.venue === f.venue &&
              g.field === f.field &&
              g.start !== '' &&
              toMinutes(g.start) < toMinutes(end) &&
              toMinutes(start) < toMinutes(g.end)
          )
      );
      if (!free) return null;
      gy.start = start;
      gy.end = end;
      gy.venue = free.venue;
      gy.field = free.field;
      return {
        touched: [x, y],
        commit: () => {
          coachesUsed.add(coach);
          used.add(x).add(y);
        },
      };
    },
  });

  // 3. A team that hosts two more than it visits: one of its home games turned round. Chosen so
  // the opponent, who gains a home game, stays within one, and so one flip is one flagged team.
  const flipped = new Set();
  record.hostingImbalances = plant({
    name: 'hostingImbalances',
    count: PLANT_COUNTS.hostingImbalances,
    type: 'home-away-imbalance',
    games,
    teams,
    candidates: function* (current) {
      const load = new Map();
      for (const g of current) {
        if (byLabel.has(g.home)) load.set(g.home, (load.get(g.home) ?? 0) + 1);
        if (byLabel.has(g.away)) load.set(g.away, (load.get(g.away) ?? 0) - 1);
      }
      for (const g of current) {
        if (!byLabel.has(g.home) || !byLabel.has(g.away)) continue;
        if ((load.get(g.home) ?? 0) <= 0 && (load.get(g.away) ?? 0) <= -1) yield { id: g.id };
      }
    },
    tryApply: (trial, { id }) => {
      const g = trial.find((x) => x.id === id);
      if (used.has(id) || flipped.has(g.home) || flipped.has(g.away)) return null;
      const teamsInGame = [g.home, g.away];
      [g.home, g.away] = [g.away, g.home];
      [g.homeTeam, g.awayTeam] = [g.awayTeam, g.homeTeam];
      return {
        touched: [id],
        commit: () => {
          for (const label of teamsInGame) flipped.add(label);
          used.add(id);
        },
      };
    },
  });

  // 4. One game with no time: the importer makes it a TIME TBD game. The report's other counts
  // stay where they were.
  record.blankTimes = plant({
    name: 'blankTimes',
    count: PLANT_COUNTS.blankTimes,
    type: null,
    games,
    teams,
    candidates: function* (current) {
      for (const g of [...current].reverse())
        if (byLabel.has(g.home) && byLabel.has(g.away) && !used.has(g.id)) yield { id: g.id };
    },
    tryApply: (trial, { id }) => {
      const g = trial.find((x) => x.id === id);
      g.start = '';
      g.end = '';
      return { touched: [id], commit: () => used.add(id) };
    },
  });
  return record;
}

/* -------------------------------------------------------------------------- */
/* schedule-invalid.csv                                                         */
/* -------------------------------------------------------------------------- */

/**
 * About twenty rows, one for every refusal reason of plan 4.4 and 4.8, the accepted-and-flagged
 * kinds, and a few plain rows that must stay valid. `Notes` says what the importer is expected to
 * do with each; it is a column the importer drops, so this file is also a check of the allowlist.
 * The labels name this fixture's own league (`teams.csv`), except where the row's reason is that
 * they do not. Where a row's reason depends on the admin's mapping (an unknown label, an outside
 * label that is an own team's name) `tests/scheduleImportParse.test.js` sets that mapping.
 */
function invalidRows() {
  const U = 'U05 Boys';
  const t = (n) => `U05B Team ${pad2(n)}`;
  const base = {
    Date: '2026-09-12',
    'Start Time': '09:00',
    'End Time': '10:00',
    Venue: 'Venue A',
    Field: 'Field 1',
    Division: U,
    'Home Team': t(1),
    'Away Team': t(2),
    Week: '',
  };
  /** @type {Array<[string, Record<string, string>, string]>} */
  const spec = [
    ['X-001', { Week: '1' }, 'ok'],
    [
      'X-002',
      {
        Date: '9/19/2026',
        'Start Time': '9:00 AM',
        'End Time': '10:00 AM',
        'Home Team': t(3),
        'Away Team': t(4),
      },
      'ok',
    ],
    [
      'X-003',
      {
        Date: '10/3/2026',
        'Start Time': '12:30 PM',
        'End Time': '1:30 PM',
        Field: 'Field 2',
        'Home Team': t(5),
        'Away Team': t(6),
      },
      'ok',
    ],
    ['X-004', { Date: '13/04/2026' }, 'bad-date'],
    ['X-005', { Date: '2026-02-30', Field: 'Field 2' }, 'bad-date'],
    ['X-006', { 'Start Time': '25:00', 'End Time': '26:00' }, 'bad-time'],
    ['X-007', { 'End Time': 'noon', Field: 'Field 2' }, 'bad-time'],
    ['X-008', { 'Start Time': '10:00', 'End Time': '09:30' }, 'end-not-after-start'],
    ['X-009', { 'Away Team': 'u05b  team 01' }, 'same-team'],
    [
      'X-010',
      { Date: '2027-03-14', 'Start Time': '02:30', 'End Time': '03:30', Field: 'Field 3' },
      'time-in-dst-gap',
    ],
    ['X-011', { Date: '2026-08-29', Field: 'Field 3' }, 'outside-season-window'],
    ['X-012', { Division: 'U99 Boys' }, 'unknown-division'],
    ['X-013', { 'Home Team': 'Unlisted Team 01', Field: 'Field 4' }, 'unknown-team'],
    ['X-014', { Venue: 'Venue Z' }, 'unknown-venue'],
    ['X-015', { Field: 'Field 9', 'Start Time': '10:15', 'End Time': '11:15' }, 'unknown-field'],
    [
      'X-016',
      { 'Away Team': t(8), Field: 'Field 4', 'Start Time': '10:15', 'End Time': '11:15' },
      'label-is-own-team',
    ],
    ['X-017', { Date: '2026-09-26', 'Home Team': t(5), 'Away Team': t(6), Week: '3' }, 'ok'],
    [
      'X-017',
      { Date: '2026-09-26', 'Home Team': t(5), 'Away Team': t(6), Week: '3' },
      'duplicate-row',
    ],
    ['X-018', { Date: '2026-10-17', 'Home Team': t(1), 'Away Team': t(3), Week: '6' }, 'ok'],
    [
      'X-018',
      {
        Date: '2026-10-17',
        'Start Time': '10:15',
        'End Time': '11:15',
        'Home Team': t(2),
        'Away Team': t(4),
        Week: '6',
      },
      'game-id-reused',
    ],
    ['X-019', { Week: 'three', Date: '2026-10-24', Field: 'Field 2' }, 'bad-week'],
    [
      'X-020',
      {
        'Start Time': '',
        'End Time': '',
        Date: '2026-10-24',
        'Home Team': t(7),
        'Away Team': t(6),
      },
      'tbd',
    ],
    [
      'X-021',
      {
        Date: '2026-11-01',
        'Start Time': '01:30',
        'End Time': '02:30',
        Field: 'Field 3',
        'Home Team': t(7),
        'Away Team': t(4),
      },
      'time-ambiguous',
    ],
    [
      'X-022',
      { Date: '2026-09-12', Field: 'Field 3', 'Home Team': t(3), 'Away Team': t(4), Week: '3' },
      'week-differs',
    ],
  ];
  return spec.map(([id, over, note]) => ({
    'Game ID': id,
    ...base,
    ...over,
    Notes: `expect: ${note}`,
  }));
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

/** The Monday-based week of a date, as plan 4.8 states the rule. @param {string} date */
function derivedWeek(date) {
  const mondayOf = (iso) => {
    const d = new Date(`${iso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return d.getTime();
  };
  return 1 + Math.floor((mondayOf(date) - mondayOf(FIXTURE_SEASON.startDate)) / (7 * 86400000));
}

/**
 * @param {{ plants?: boolean }} [options] `plants: false` is the control: the clean schedule.
 */
export function buildScheduleFixture({ plants = true } = {}) {
  const rnd = prng(SEED);
  const league = buildLeague(rnd);
  const games = buildCleanGames(league, rnd);

  for (const g of games)
    if (g.week !== derivedWeek(g.date)) throw new Error(`${g.id}: week ${g.week} is not derived`);
  const clean = reportCounts(games, league.teams);
  if (Object.keys(clean).length > 0) {
    throw new Error(`the pre-plant schedule is not clean: ${JSON.stringify(clean)}`);
  }

  const record = plants
    ? applyPlants(games, league)
    : Object.fromEntries(
        Object.keys(PLANT_COUNTS).map((name) => [name, { count: 0, gameIds: [] }])
      );

  const name = coachNamer(league.teams);
  const scheduleRows = [...games]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((g) => ({
      'Game ID': g.id,
      Date: g.date,
      'Start Time': g.start,
      'End Time': g.end,
      Venue: g.venue,
      Field: g.field,
      Division: g.division,
      'Home Team': g.home,
      'Away Team': g.away,
      Week: String(g.week),
      Format: FORMAT_OF_AGE[Number(g.divisionCode.slice(1, 3))] ?? '11v11',
    }));
  const teamRows = league.teams.map((t) => ({
    Team: t.label,
    Division: t.divisionName,
    'Coach 1': name(t.coachPersons[0]),
    'Coach 2': t.coachPersons[1] === undefined ? '' : name(t.coachPersons[1]),
    'Coach 3': t.coachPersons[2] === undefined ? '' : name(t.coachPersons[2]),
  }));
  const venueRows = VENUES.flatMap(([venue, n]) =>
    Array.from({ length: n }, (_, i) => ({ Venue: `Venue ${venue}`, Field: `Field ${i + 1}` }))
  );

  return {
    files: {
      'schedule.csv': toCsv(SCHEDULE_COLUMNS, scheduleRows),
      'teams.csv': toCsv(['Team', 'Division', 'Coach 1', 'Coach 2', 'Coach 3'], teamRows),
      'venues.csv': toCsv(['Venue', 'Field'], venueRows),
      'schedule-invalid.csv': toCsv(INVALID_COLUMNS, invalidRows()),
    },
    plants: record,
  };
}

/**
 * The files of `dir` that differ from a fresh build, missing ones included.
 * @param {string} [dir]
 * @returns {string[]}
 */
export function fixtureDifferences(dir = SCHEDULE_FIXTURE_DIR) {
  const { files } = buildScheduleFixture();
  return FIXTURE_FILES.filter((file) => {
    const target = path.join(dir, file);
    return !existsSync(target) || readFileSync(target, 'utf8') !== files[file];
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf('--dir');
  const dir = at > -1 ? path.resolve(process.argv[at + 1]) : SCHEDULE_FIXTURE_DIR;
  if (process.argv.includes('--check')) {
    const differing = fixtureDifferences(dir);
    if (differing.length > 0) {
      for (const file of differing) {
        console.error(
          `${file} differs from the generator (or is missing): run node scripts/build-schedule-fixture.mjs`
        );
      }
      process.exit(1);
    }
    console.log('the schedule fixture matches the generator');
  } else {
    const { files, plants } = buildScheduleFixture();
    for (const file of FIXTURE_FILES) writeFileSync(path.join(dir, file), files[file]);
    console.log(
      `wrote ${FIXTURE_FILES.length} files into ${path.relative(REPO_ROOT, dir)}; plants: ${JSON.stringify(
        Object.fromEntries(Object.entries(plants).map(([k, v]) => [k, v.count]))
      )}`
    );
  }
}
