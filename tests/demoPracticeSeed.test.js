// @vitest-environment node
/**
 * The demo league's applied practice schedule (`demo_seed.practice_schedule` rows in
 * `supabase/migrations/20261110010000_demo_practices.sql`), held to the fixture it is generated
 * from (`fixtures/demo-2026/`, by `scripts/build-demo-practice-seed.mjs`). Phase D, PR F.
 *
 *   - **drift**: regenerating from the fixture, with the REAL solver (the Edge Function's
 *     `runPracticeOptimizer`, a fixed seed), gives exactly the rows in the migration;
 *   - **the rules, read from the fixture and the owner's spec, not from the generator**: the subject
 *     set is the roster's teams (`players.csv`), the grid is `fields.csv`, the coaches are
 *     `coaches.csv`. The checker parses the rows out of the migration's text and judges them: U4's
 *     four cohorts once a week in the 30-minute sessions reserved to them with 15 minutes between,
 *     every U5 to U8 team twice a week on two different weekdays in 60-minute open slots, no team of
 *     U9 or older (the visitor's to schedule), nothing over a slot's capacity, nothing on unlit
 *     ground past 19:00, no team or coach in two places at once;
 *   - **what the visitor then does**: the same solver run over the 60 teams left, the seeded rows held,
 *     places all 120 of their practices (90 minutes for U14 and older, 60 for U9 to U12), none TIME
 *     TBD, and the whole league of 252 practices passes the same rules;
 *   - **the checker can fail**: each rule is broken in a copy of the rows and the checker names it; a
 *     moved fixture session changes what the generator builds; and a grid with too few slots makes
 *     the generator THROW instead of writing a schedule with a practice missing.
 */

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Papa from 'papaparse';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEMO_FIXTURE_DIR } from '../scripts/build-demo-seed.mjs';
import {
  BEGIN_MARK,
  DEMO_PRACTICE_MIGRATION,
  END_MARK,
  buildDemoPracticeSeedSql,
  buildPracticeSchedule,
  generatedRegion,
  placeTheRest,
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
/** The owner's spec (2026-10-27), written out here rather than imported from the generator. */
const wantedMinutes = (team) => {
  const age = ageOfTeam(team);
  return age === 4 ? 30 : age >= 14 ? 90 : 60;
};
const wantedPractices = (team) => (ageOfTeam(team) === 4 ? 1 : 2);

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

/** The lit venues, from the facility region of the migration. */
const litVenues = new Set(
  [
    ...migration
      .match(/INSERT INTO demo_seed\.locations[\s\S]*?;\n/)[0]
      .matchAll(/\('([^']+)', [-\d.]+, [-\d.]+, true\)/g),
  ].map((m) => m[1])
);

/**
 * Every rule violated by `rows`, as strings, judged against the fixture in `dir`.
 * `scheduledUpTo` is the oldest age that must have its practices in `rows`: 8 for the seed, 99 for
 * the whole league once the visitor has run the auto-scheduler.
 * @param {ReturnType<typeof rowsOf>} rows
 */
function violations(rows, { dir = DEMO_FIXTURE_DIR, scheduledUpTo = 8 } = {}) {
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
  // team past `scheduledUpTo` that it holds is another (they are the visitor's auto-scheduler's)
  for (const team of rosterTeams) {
    const held = (byTeam.get(team) ?? []).length;
    const want = ageOfTeam(team) <= scheduledUpTo ? wantedPractices(team) : 0;
    if (held !== want) out.push(`${team} has ${held} practice(s), wants ${want}`);
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
    if (!slot.Division && !['mon', 'tue', 'wed', 'thu', 'fri'].includes(slot.day)) {
      out.push(`${r.team}: open slot ${gridKey(r)} is not Monday to Friday`);
    }
    const length = minutes(slot.End) - minutes(slot.Start);
    if (length !== wantedMinutes(r.team)) {
      out.push(`${r.team}: a ${length}-minute slot, wants ${wantedMinutes(r.team)}`);
    }
    if (!litVenues.has(slot.Location) && !slot.Division && minutes(slot.End) > 19 * 60) {
      out.push(`${r.team}: unlit ground ends after 19:00`);
    }
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
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        if (clash(span(list[i]), span(list[j]))) out.push(`${team} is in two places at once`);
        if (list[i].day === list[j].day) out.push(`${team} has two practices on ${list[i].day}`);
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
  return out;
}

describe('the practice schedule against its fixture', () => {
  it('has the markers, and holds exactly what the real solver builds from the fixture (drift)', async () => {
    expect(migration.indexOf(BEGIN_MARK)).toBeGreaterThan(0);
    expect(migration.indexOf(END_MARK)).toBeGreaterThan(migration.indexOf(BEGIN_MARK));
    expect(region).toBe(await buildDemoPracticeSeedSql());
  });

  it('would notice a fixture that moved: a U4 session shifted changes the generated rows', async () => {
    const dir = path.join(scratch, 'moved');
    cpSync(DEMO_FIXTURE_DIR, dir, { recursive: true });
    const target = path.join(dir, 'fields.csv');
    const before = readFileSync(target, 'utf8');
    const after = before.replace('09:45,10:15', '09:40,10:10');
    expect(after).not.toBe(before);
    writeFileSync(target, after);
    expect(await buildDemoPracticeSeedSql(dir)).not.toBe(region);
  });

  it('throws, rather than write a schedule with a practice missing, when the grid is too small', async () => {
    const dir = path.join(scratch, 'small');
    cpSync(DEMO_FIXTURE_DIR, dir, { recursive: true });
    const target = path.join(dir, 'fields.csv');
    const text = readFileSync(target, 'utf8').split('\n');
    // keep the header, the U4 sessions and one Monday hour on one half: 64 teams cannot practise
    const kept = text.filter(
      (line, i) =>
        i === 0 ||
        line.endsWith(',U4') ||
        line.startsWith('Orchard Park,Field 1,A,practice,Mon,,16:00,17:00,')
    );
    expect(kept.length).toBeLessThan(10);
    writeFileSync(target, `${kept.join('\n')}\n`);
    await expect(buildPracticeSchedule(dir)).rejects.toThrow(
      /left \d+ seeded practice\(s\) unplaced/
    );
  });
});

describe('what the schedule holds, judged from the fixture', () => {
  const rows = rowsOf(region);

  it('breaks no rule', () => {
    expect(violations(rows)).toEqual([]);
  });

  it('holds 132 weekly practices: the four U4 cohorts on Saturday, 64 teams twice on two weekdays', () => {
    expect(rows).toHaveLength(132);
    expect(new Set(rows.map((r) => r.team)).size).toBe(68);
    const u4 = rows.filter((r) => r.team.startsWith('U4'));
    expect(u4.map((r) => [r.team, r.day, r.start])).toEqual([
      ['U4A', 'sat', '09:00'],
      ['U4B', 'sat', '09:45'],
      ['U4C', 'sat', '10:30'],
      ['U4D', 'sat', '11:15'],
    ]);
    const others = rows.filter((r) => !r.team.startsWith('U4'));
    expect(others).toHaveLength(128);
    for (const team of new Set(others.map((r) => r.team))) {
      const mine = others.filter((r) => r.team === team);
      expect(mine, team).toHaveLength(2);
      expect(new Set(mine.map((r) => r.day)).size, team).toBe(2);
      expect(ageOfTeam(team)).toBeGreaterThanOrEqual(5);
      expect(ageOfTeam(team)).toBeLessThanOrEqual(8);
    }
  });

  it('carries no person: only team names and the grid', () => {
    expect(region).not.toMatch(/@|555-|Parent|Coach(First|Last)/);
  });

  describe('then the visitor runs the auto-scheduler on the rest', () => {
    let rest;
    beforeAll(async () => {
      rest = await placeTheRest(
        rows.map((r) => ({
          ...r,
          subunit: r.subunit ?? '',
          day: r.day[0].toUpperCase() + r.day.slice(1),
        }))
      );
    });

    it('places all 120 practices of the 60 teams of U9 and older, none TIME TBD', () => {
      const teams = rest.league.teams.filter((t) => ageOfTeam(t.id) > 8);
      expect(teams).toHaveLength(60);
      // the subject set is the roster and the divisions' counts, not the solver's output
      const wanted = teams.reduce((sum, t) => sum + t.practicesPerWeek, 0);
      expect(wanted).toBe(120);
      expect(rest.result.unassigned).toEqual([]);
      expect(rest.result.placements).toHaveLength(wanted);
    });

    it('gives each of them two practices on two weekdays, 90 minutes for U14 and older', () => {
      const slotRow = new Map(rest.league.slots.map((s) => [s.slot.id, s.row]));
      const byTeam = new Map();
      for (const p of rest.result.placements) {
        byTeam.set(p.teamId, [...(byTeam.get(p.teamId) ?? []), slotRow.get(p.slotId)]);
      }
      for (const t of rest.league.teams.filter((x) => ageOfTeam(x.id) > 8)) {
        const mine = byTeam.get(t.id) ?? [];
        expect(mine, t.id).toHaveLength(2);
        expect(new Set(mine.map((r) => r.day)).size, t.id).toBe(2);
        for (const r of mine) {
          expect(minutes(r.end) - minutes(r.start), t.id).toBe(wantedMinutes(t.id));
        }
      }
    });

    it('leaves the whole league of 252 practices breaking no rule', () => {
      const slotRow = new Map(rest.league.slots.map((s) => [s.slot.id, s.row]));
      const placed = rest.result.placements.map((p) => {
        const r = slotRow.get(p.slotId);
        return {
          team: p.teamId,
          location: r.location,
          field: r.field,
          subunit: r.subunit,
          day: r.day.toLowerCase(),
          start: r.start,
        };
      });
      const all = [...rows, ...placed];
      expect(all).toHaveLength(252);
      expect(violations(all, { scheduledUpTo: 99 })).toEqual([]);
    });
  });

  describe('the checker can fail: each rule, broken in a copy of the rows, is named', () => {
    const copy = () => rows.map((r) => ({ ...r }));
    const u4slot = rows.find((r) => r.team === 'U4A');
    // a slot of the lit ground, from the grid (the seeded teams are all 60-minute, so none sits there)
    const lit = (() => {
      const f = parse(DEMO_FIXTURE_DIR, 'fields.csv').find((g) => litVenues.has(g.Location));
      return {
        location: f.Location,
        field: f.Field,
        subunit: f.Subunit,
        day: f.Day.toLowerCase(),
        start: f.Start,
      };
    })();

    it('a team missing a practice', () => {
      const broken = copy();
      broken.splice(
        broken.findIndex((r) => r.team === 'U08B03'),
        1
      );
      expect(violations(broken)).toContain('U08B03 has 1 practice(s), wants 2');
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
      expect(violations(broken)).toContain('U10B03 has 1 practice(s), wants 0');
    });

    it('a team given a third practice', () => {
      const broken = copy();
      broken.push({ ...broken.find((r) => r.team === 'U07B01'), day: 'fri', start: '16:00' });
      expect(violations(broken)).toContain('U07B01 has 3 practice(s), wants 2');
    });

    it('a team in two places at once, and twice on one weekday', () => {
      const broken = copy();
      const first = broken.find((r) => r.team === 'U07B01');
      const second = broken.filter((r) => r.team === 'U07B01')[1];
      Object.assign(second, { day: first.day, start: first.start });
      const found = violations(broken);
      expect(found).toContain('U07B01 is in two places at once');
      expect(found).toContain(`U07B01 has two practices on ${first.day}`);
    });

    it('a 60-minute team in a 90-minute slot of the lit ground', () => {
      const broken = copy();
      Object.assign(
        broken.find((r) => r.team === 'U05B01'),
        {
          location: lit.location,
          field: lit.field,
          subunit: lit.subunit,
          day: lit.day,
          start: lit.start,
        }
      );
      // the slot is free in the copy, so the length is the only break
      expect(violations(broken)).toContain('U05B01: a 90-minute slot, wants 60');
    });

    it('a slot that is not on the grid', () => {
      const broken = copy();
      broken.find((r) => r.team === 'U05B01').start = '03:00';
      expect(violations(broken).some((v) => /no such slot/.test(v))).toBe(true);
    });

    it('unlit ground past 19:00 (a fixture whose last unlit hour runs to 20:00)', () => {
      const dir = path.join(scratch, 'late');
      cpSync(DEMO_FIXTURE_DIR, dir, { recursive: true });
      const target = path.join(dir, 'fields.csv');
      const text = readFileSync(target, 'utf8');
      const row = rows.find((r) => r.start === '18:00' && !litVenues.has(r.location));
      const key = `${row.location},${row.field},${row.subunit},practice,${row.day[0].toUpperCase()}${row.day.slice(1)},,18:00,19:00,`;
      expect(text).toContain(key);
      writeFileSync(target, text.replace(key, key.replace('18:00,19:00', '18:00,20:00')));
      // that slot is now 120 minutes: both the length and the sunset rule name it
      const found = violations(rows, { dir });
      expect(found.some((v) => /unlit ground ends after 19:00/.test(v))).toBe(true);
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
      // A second registration for the coach of U05B01 on a team that shares one of its practice hours.
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
      expect(violations(rows, { dir }).some((v) => /is in two places at once/.test(v))).toBe(true);
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
      expect(violations(broken, { dir })).toContain(
        'two U4 sessions are less than 15 minutes apart'
      );
      // The control: the same rows against the real grid name a slot that is not on it, not this rule.
      expect(violations(broken)).not.toContain('two U4 sessions are less than 15 minutes apart');
    });
  });
});
