// @vitest-environment node
/**
 * The demo league's applied practice schedule (`demo_seed.practice_schedule` rows in
 * `supabase/migrations/20261103010000_demo_practice_schedule.sql`), held to the fixture it is
 * generated from (`fixtures/demo-2026/`, by `scripts/build-demo-practice-seed.mjs`).
 *
 *   - **drift**: regenerating from the fixture gives exactly the rows in the migration;
 *   - **the rules, read from the fixture, not from the generator**: the subject set is the roster's
 *     teams (`players.csv`), the grid is `fields.csv`, the coaches are `coaches.csv`. The checker
 *     parses the rows out of the migration's text and judges them: every U4 and U5 to U8 team
 *     practises once a week and no team of U9 or older does (those are the visitor's to schedule),
 *     U4 in the 30-minute sessions reserved to it with 15 minutes between, U5 to U8 on the open grid
 *     in a Monday to Thursday 16:00 to 19:00 evening, nothing over a slot's capacity, no team or
 *     coach in two places at once, younger teams earlier;
 *   - **the checker can fail**: each rule is broken in a copy of the rows (a team moved into a U4
 *     session, a slot over capacity, a team double-booked, a coach in two places, a missing team, a
 *     U4 cohort squeezed against another) and the checker names it; and a moved fixture session
 *     changes what the generator builds.
 */

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Papa from 'papaparse';
import { afterAll, describe, expect, it } from 'vitest';
import { DEMO_FIXTURE_DIR } from '../scripts/build-demo-seed.mjs';
import {
  BEGIN_MARK,
  DEMO_PRACTICE_MIGRATION,
  END_MARK,
  buildDemoPracticeSeedSql,
  generatedRegion,
} from '../scripts/build-demo-practice-seed.mjs';

const parse = (dir, file) =>
  Papa.parse(readFileSync(path.join(dir, file), 'utf8'), { header: true, skipEmptyLines: true })
    .data;

const migration = readFileSync(DEMO_PRACTICE_MIGRATION, 'utf8');
const region = generatedRegion(migration);

const scratch = mkdtempSync(path.join(tmpdir(), 'demo-practice-seed-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const minutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const ageOfTeam = (team) => (team.startsWith('U4') ? 4 : Number(team.slice(1, 3)));

/** The rows of the INSERT in `text`, as `{ team, location, field, subunit, day, start }`. */
function rowsOf(text) {
  const m = /VALUES\n([\s\S]*?);\n/.exec(text);
  if (!m) throw new Error('no INSERT');
  return m[1].split('\n').map((line) => {
    const cells = [...line.matchAll(/'((?:[^']|'')*)'|NULL/g)].map((x) => x[1] ?? null);
    const [team, location, field, subunit, day, start] = cells;
    return { team, location, field, subunit, day, start };
  });
}

/**
 * Every rule violated by `rows`, as strings, judged against the fixture in `dir`.
 * @param {ReturnType<typeof rowsOf>} rows
 */
function violations(rows, dir = DEMO_FIXTURE_DIR) {
  const out = [];
  const grid = parse(dir, 'fields.csv');
  const gridKey = (r) => [r.location, r.field, r.subunit ?? '', r.day, r.start].join('|');
  const slotOf = new Map(
    grid.map((f) => [
      [f.Location, f.Field, f.Subunit, f.Day.toLowerCase(), f.Start].join('|'),
      { ...f, day: f.Day.toLowerCase() },
    ])
  );
  const rosterTeams = [...new Set(parse(dir, 'players.csv').map((p) => p['Team Name']))];
  const coachTeams = new Map(); // coach -> teams
  for (const c of parse(dir, 'coaches.csv')) {
    if (!c['Team Name']) continue;
    const name = `${c['First Name']} ${c['Last Name']}`;
    coachTeams.set(name, new Set([...(coachTeams.get(name) ?? []), c['Team Name']]));
  }

  const byTeam = new Map();
  for (const r of rows) byTeam.set(r.team, [...(byTeam.get(r.team) ?? []), r]);

  // the subject set is the roster, not the schedule: a team the schedule dropped is a miss, and a
  // team of U9 or older that it holds is another (they are left for the visitor's auto-scheduler)
  for (const team of rosterTeams) {
    if (ageOfTeam(team) <= 8 && !byTeam.has(team)) out.push(`${team} has no practice`);
    if (ageOfTeam(team) > 8 && byTeam.has(team)) out.push(`${team} has a practice, wants none`);
  }
  for (const team of byTeam.keys()) {
    if (!rosterTeams.includes(team)) out.push(`${team} is not on the roster`);
  }

  const used = new Map();
  for (const r of rows) {
    const slot = slotOf.get(gridKey(r));
    if (!slot) {
      out.push(`${r.team}: no such slot ${gridKey(r)}`);
      continue;
    }
    used.set(gridKey(r), (used.get(gridKey(r)) ?? 0) + 1);
    const reserved = slot.Division === 'U4';
    if (ageOfTeam(r.team) === 4 && !reserved) out.push(`${r.team}: U4 in an open slot`);
    if (ageOfTeam(r.team) !== 4 && slot.Division) out.push(`${r.team}: in a slot reserved to U4`);
    if (!slot.Division && (['sat', 'sun'].includes(slot.day) || minutes(slot.Start) < 16 * 60)) {
      out.push(`${r.team}: open slot ${gridKey(r)} is not a weekday evening`);
    }
    if (!slot.Division && minutes(slot.End) > 19 * 60) out.push(`${r.team}: ends after 19:00`);
  }
  for (const [key, n] of used) {
    if (n > Number(slotOf.get(key).Capacity)) out.push(`${key} holds ${n} teams`);
  }

  const span = (r) => {
    const s = slotOf.get(gridKey(r));
    return s ? { day: s.day, from: minutes(s.Start), to: minutes(s.End) } : null;
  };
  const clash = (a, b) =>
    a && b && a.day === b.day && a.from < b.to && b.from < a.to ? `${a.day} ${a.from}` : null;

  for (const [team, list] of byTeam) {
    if (list.length !== 1) out.push(`${team} has ${list.length} practices, wants 1`);
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        if (clash(span(list[i]), span(list[j]))) out.push(`${team} is in two places at once`);
      }
    }
  }

  for (const [coach, teams] of coachTeams) {
    const mine = rows.filter((r) => teams.has(r.team));
    for (let i = 0; i < mine.length; i += 1) {
      for (let j = i + 1; j < mine.length; j += 1) {
        if (clash(span(mine[i]), span(mine[j]))) out.push(`${coach} is in two places at once`);
      }
    }
  }

  // U4: 30-minute sessions, one cohort at a time, at least 15 minutes apart
  const u4 = rows
    .filter((r) => ageOfTeam(r.team) === 4)
    .map(span)
    .filter(Boolean)
    .sort((a, b) => a.from - b.from);
  for (const s of u4)
    if (s.to - s.from !== 30) out.push(`a U4 session is ${s.to - s.from} minutes`);
  for (let i = 1; i < u4.length; i += 1) {
    if (u4[i].from - u4[i - 1].to < 15) out.push('two U4 sessions are less than 15 minutes apart');
  }

  // plausibility: younger teams practise earlier
  const meanStart = (lo, hi) => {
    const starts = rows
      .filter((r) => ageOfTeam(r.team) >= lo && ageOfTeam(r.team) <= hi)
      .map((r) => minutes(r.start));
    return starts.reduce((a, b) => a + b, 0) / (starts.length || 1);
  };
  const bands = [meanStart(5, 6), meanStart(7, 8)];
  for (let i = 1; i < bands.length; i += 1) {
    if (!(bands[i] > bands[i - 1])) out.push('younger teams do not practise earlier');
  }
  return out;
}

describe('the practice schedule against its fixture', () => {
  it('has the markers, and holds exactly what the generator builds from the fixture (drift)', () => {
    expect(migration.indexOf(BEGIN_MARK)).toBeGreaterThan(0);
    expect(migration.indexOf(END_MARK)).toBeGreaterThan(migration.indexOf(BEGIN_MARK));
    expect(region).toBe(buildDemoPracticeSeedSql());
  });

  it('would notice a fixture that moved: a U4 session shifted changes the generated rows', () => {
    const dir = path.join(scratch, 'moved');
    cpSync(DEMO_FIXTURE_DIR, dir, { recursive: true });
    const target = path.join(dir, 'fields.csv');
    const before = readFileSync(target, 'utf8');
    const after = before.replace('09:45,10:15', '09:40,10:10');
    expect(after).not.toBe(before);
    writeFileSync(target, after);
    expect(buildDemoPracticeSeedSql(dir)).not.toBe(region);
  });
});

describe('what the schedule holds, judged from the fixture', () => {
  const rows = rowsOf(region);

  it('breaks no rule', () => {
    expect(violations(rows)).toEqual([]);
  });

  it('puts 68 teams on the grid, 68 weekly practices, the four U4 cohorts on Saturday', () => {
    expect(new Set(rows.map((r) => r.team)).size).toBe(68);
    expect(rows).toHaveLength(68);
    const u4 = rows.filter((r) => r.team.startsWith('U4'));
    expect(u4.map((r) => [r.team, r.day, r.start])).toEqual([
      ['U4A', 'sat', '09:00'],
      ['U4B', 'sat', '09:45'],
      ['U4C', 'sat', '10:30'],
      ['U4D', 'sat', '11:15'],
    ]);
  });

  it('carries no person: only team names and the grid', () => {
    expect(region).not.toMatch(/@|555-|Parent|Coach(First|Last)/);
  });

  describe('the checker can fail: each rule, broken in a copy of the rows, is named', () => {
    const copy = () => rows.map((r) => ({ ...r }));
    const u4slot = rows.find((r) => r.team === 'U4A');

    it('a team missing from the schedule', () => {
      expect(violations(copy().filter((r) => r.team !== 'U08B03'))).toContain(
        'U08B03 has no practice'
      );
    });

    it('a team moved into a session reserved to U4', () => {
      const broken = copy();
      Object.assign(
        broken.find((r) => r.team === 'U05B01'),
        {
          location: u4slot.location,
          field: u4slot.field,
          subunit: null,
          day: 'sat',
          start: '09:00',
        }
      );
      expect(violations(broken)).toContain('U05B01: in a slot reserved to U4');
    });

    it('a U4 cohort moved into an open slot', () => {
      const broken = copy();
      const open = broken.find((r) => r.team === 'U05B01');
      Object.assign(
        broken.find((r) => r.team === 'U4A'),
        { ...open, team: 'U4A' }
      );
      expect(violations(broken)).toContain('U4A: U4 in an open slot');
    });

    it('a slot over its capacity', () => {
      const broken = copy();
      const first = broken.find((r) => r.team === 'U05B01');
      Object.assign(
        broken.find((r) => r.team === 'U05B02'),
        { ...first, team: 'U05B02' }
      );
      expect(violations(broken).some((v) => /holds 2 teams/.test(v))).toBe(true);
    });

    it('a team of U9 or older given a practice', () => {
      const broken = copy();
      broken.push({ ...broken.find((r) => r.team === 'U08B03'), team: 'U10B03' });
      expect(violations(broken)).toContain('U10B03 has a practice, wants none');
    });

    it('a team in two places at once', () => {
      const broken = copy();
      broken.push({ ...broken.find((r) => r.team === 'U07B01') });
      const found = violations(broken);
      expect(found).toContain('U07B01 is in two places at once');
      expect(found).toContain('U07B01 has 2 practices, wants 1');
    });

    it('a slot that is not on the grid', () => {
      const broken = copy();
      broken.find((r) => r.team === 'U05B01').start = '03:00';
      expect(violations(broken).some((v) => /no such slot/.test(v))).toBe(true);
    });

    it('a coach in two places at once', () => {
      // Two teams of one coach, from a fixture where a coach has two teams.
      const dir = path.join(scratch, 'twoteams');
      cpSync(DEMO_FIXTURE_DIR, dir, { recursive: true });
      const target = path.join(dir, 'coaches.csv');
      const text = readFileSync(target, 'utf8');
      const parsed = Papa.parse(text, { header: false, skipEmptyLines: true }).data;
      const header = parsed[0];
      const team = header.indexOf('Team Name');
      const first = header.indexOf('First Name');
      // A second registration for the coach of U05B01 on the team that shares its Monday 16:00 hour.
      const mine = parsed.find((row) => row[team] === 'U05B01');
      const a = rows.find((r) => r.team === 'U05B01');
      const other = rows.find(
        (r) =>
          r.team !== 'U05B01' && r.day === a.day && r.start === a.start && !r.team.startsWith('U4')
      );
      const clone = [...mine];
      clone[team] = other.team;
      parsed.push(clone);
      writeFileSync(target, Papa.unparse(parsed));
      expect(mine[first]).toBeTruthy();
      expect(violations(rows)).toEqual([]);
      expect(violations(rows, dir).some((v) => /is in two places at once/.test(v))).toBe(true);
    });

    it('two U4 sessions squeezed less than 15 minutes apart', () => {
      // A fixture whose second session starts 5 minutes after the first ends, and rows that use it.
      const dir = path.join(scratch, 'squeezed');
      cpSync(DEMO_FIXTURE_DIR, dir, { recursive: true });
      const target = path.join(dir, 'fields.csv');
      const text = readFileSync(target, 'utf8');
      const moved = text.replace('09:45,10:15', '09:35,10:05');
      expect(moved).not.toBe(text);
      writeFileSync(target, moved);
      const broken = copy();
      broken.find((r) => r.team === 'U4B').start = '09:35';
      expect(violations(broken, dir)).toContain('two U4 sessions are less than 15 minutes apart');
      // The control: the same rows against the real grid name a slot that is not on it, not this rule.
      expect(violations(broken)).not.toContain('two U4 sessions are less than 15 minutes apart');
    });
  });
});
