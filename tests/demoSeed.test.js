// @vitest-environment node
/**
 * The demo league's seed (`demo_seed` rows), held to the fixture it is generated from
 * (`fixtures/demo-2026/`, by `scripts/build-demo-seed.mjs`). Two generated regions:
 *
 *   - the league (people, teams, divisions) in `20261030010000_demo_sessions.sql`, FROZEN: applied in
 *     production, so the test requires the region to START with what the generator builds from the
 *     fixture and a fixture change to the league fails here until a new migration says so;
 *   - the practice facility and each division's practice settings in
 *     `20261110010000_demo_practices.sql` (Phase D, F), and `fixtures/demo-2026/fields.csv` itself,
 *     which the generator writes from one grid definition.
 *
 *   - **drift**: regenerating from the fixture gives exactly the rows in the migrations and the CSV,
 *     so nobody hand-edits them;
 *   - **the check can fail**: a copy of the fixture with one player's name changed, one with a coach
 *     email changed and one with a practice session moved each give different SQL, and the drift
 *     comparison says so;
 *   - **what the seed holds, read from the fixture, not from the generator**: every registration id, the
 *     team and division counts, each division's practices a week and length, the grid (Monday to
 *     Friday, one lit venue, unlit slots over by 19:00, U4's four 30-minute Saturday sessions 15
 *     minutes apart) against the demand it carries, unique coach emails, and none of what an import
 *     drops (birth dates, guardians, phones, payment plan).
 */

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Papa from 'papaparse';
import { afterAll, describe, expect, it } from 'vitest';
import {
  BEGIN_MARK,
  DEMO_FIXTURE_DIR,
  DEMO_GRID,
  DEMO_MIGRATION,
  END_MARK,
  FACILITY_BEGIN_MARK,
  FACILITY_END_MARK,
  FACILITY_MIGRATION,
  buildDemoFacilitySql,
  buildDemoPeopleSql,
  buildFieldsCsv,
  generatedRegion,
  practiceSettingsFor,
} from '../scripts/build-demo-seed.mjs';
import { CSV_TEMPLATES } from '../frontend/src/utils/csvTemplates.js';
import { SYNTHETIC_HEAT_SITES } from './helpers/heatSyntheticSites.js';
import { sunsetOnDate } from '../supabase/functions/_shared/timing/solar.ts';

const minutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const parse = (dir, file) =>
  Papa.parse(readFileSync(path.join(dir, file), 'utf8'), { header: true, skipEmptyLines: true })
    .data;

const migration = readFileSync(DEMO_MIGRATION, 'utf8');
const region = generatedRegion(migration);
const fresh = buildDemoPeopleSql();
const facilityMigration = readFileSync(FACILITY_MIGRATION, 'utf8');
const facility = generatedRegion(facilityMigration, FACILITY_BEGIN_MARK, FACILITY_END_MARK);

const players = parse(DEMO_FIXTURE_DIR, 'players.csv');
const coaches = parse(DEMO_FIXTURE_DIR, 'coaches.csv');
const fields = parse(DEMO_FIXTURE_DIR, 'fields.csv');

const scratch = mkdtempSync(path.join(tmpdir(), 'demo-seed-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A copy of the fixture with one file's text rewritten. */
function plantedCopy(name, file, rewrite) {
  const dir = path.join(scratch, name);
  cpSync(DEMO_FIXTURE_DIR, dir, { recursive: true });
  const target = path.join(dir, file);
  const before = readFileSync(target, 'utf8');
  const after = rewrite(before);
  if (after === before) throw new Error(`the plant changed nothing in ${file}`);
  writeFileSync(target, after);
  return dir;
}

/** The rows of one seed table, from the generated region (or the facility region). */
function tableRows(table, text = region) {
  const m = new RegExp(
    `INSERT INTO demo_seed\\.${table} \\(([^)]*)\\) VALUES\\n([\\s\\S]*?);\\n`
  ).exec(text);
  if (!m) throw new Error(`no INSERT for demo_seed.${table}`);
  return { columns: m[1].split(', '), count: m[2].split('\n').length };
}

describe('the seed against its fixture', () => {
  it('has the markers, and the frozen league rows start with what the generator builds (drift)', () => {
    expect(migration.indexOf(BEGIN_MARK)).toBeGreaterThan(0);
    expect(migration.indexOf(END_MARK)).toBeGreaterThan(migration.indexOf(BEGIN_MARK));
    expect(region.length).toBeGreaterThan(100_000);
    expect(region.startsWith(`${fresh}\n`)).toBe(true);
  });

  it('holds the facility rows and fields.csv exactly as the generator builds them (drift)', () => {
    expect(facilityMigration.indexOf(FACILITY_BEGIN_MARK)).toBeGreaterThan(0);
    expect(facilityMigration.indexOf(FACILITY_END_MARK)).toBeGreaterThan(
      facilityMigration.indexOf(FACILITY_BEGIN_MARK)
    );
    expect(facility).toBe(buildDemoFacilitySql());
    expect(readFileSync(path.join(DEMO_FIXTURE_DIR, 'fields.csv'), 'utf8')).toBe(buildFieldsCsv());
  });

  it('would notice a fixture that moved: a renamed player, a changed coach email, a moved practice session', () => {
    const first = plantedCopy('first', 'players.csv', (t) =>
      t.replace(',First1,Last1,', ',Moved,Last1,')
    );
    const email = plantedCopy('email', 'coaches.csv', (t) =>
      t.replace('email9@example.com', 'other9@example.com')
    );
    const session = plantedCopy('session', 'fields.csv', (t) =>
      t.replace('09:45,10:15', '09:40,10:10')
    );
    expect(buildDemoPeopleSql(first).startsWith(`${fresh}\n`)).toBe(false);
    expect(buildDemoPeopleSql(email).startsWith(`${fresh}\n`)).toBe(false);
    expect(region.startsWith(`${buildDemoPeopleSql(first)}\n`)).toBe(false);
    expect(buildDemoFacilitySql(session)).not.toBe(facility);
    // the CSV is generated too: a hand-edited one no longer equals the grid
    expect(readFileSync(path.join(session, 'fields.csv'), 'utf8')).not.toBe(buildFieldsCsv());
  });

  it('refuses a character the SQL writer cannot carry', () => {
    const dir = plantedCopy('quote', 'players.csv', (t) =>
      t.replace(',First2,Last2,', ",O'Neil,Last2,")
    );
    // a quote is escaped, not refused...
    expect(buildDemoPeopleSql(dir)).toContain("'O''Neil'");
    // ...a backslash is a defect in a fixture of placeholders
    const bad = plantedCopy('backslash', 'players.csv', (t) =>
      t.replace(',First3,Last3,', ',Fir\\st3,Last3,')
    );
    expect(() => buildDemoPeopleSql(bad)).toThrow(/unsafe character/);
  });
});

describe('what the seed holds, counted from the fixture', () => {
  it('has a row for every registration in the fixture, and no other', () => {
    const ids = players.map((p) => p['Registration ID']);
    expect(ids).toHaveLength(1259);
    expect(tableRows('players').count).toBe(ids.length);
    for (const id of ids) expect(region).toContain(`('${id}',`);
    expect(tableRows('coaches').count).toBe(coaches.length);
  });

  it('has the 128 teams and 21 divisions the fixture names, U4 the one practice-only division', () => {
    const teams = new Set(players.map((p) => p['Team Name']));
    expect(teams.size).toBe(128);
    expect(tableRows('teams').count).toBe(128);
    expect(tableRows('divisions').count).toBe(21);
    const divisions = region.match(/INSERT INTO demo_seed\.divisions[\s\S]*?;\n/)[0];
    expect(divisions.match(/, false\)/g)).toHaveLength(1);
    expect(divisions).toMatch(/\('U4', 'U4', 'coed', 'Minis', 3, 4, 15, false\)/);
    // a team's coaches: one lead, the rest assistants, and every team has one
    const leads = region
      .match(/INSERT INTO demo_seed\.team_coaches[\s\S]*?;\n/)[0]
      .match(/'lead'\)/g);
    expect(leads).toHaveLength(128);
  });

  it("keeps a coach's sign-in email unique and from the later of the two columns", () => {
    const block = region.match(/INSERT INTO demo_seed\.coaches[\s\S]*?;\n/)[0];
    const emails = [...block.matchAll(/', '([^']+@[^']+)', 'active'\)/g)].map((m) => m[1]);
    expect(emails).toHaveLength(251);
    expect(new Set(emails).size).toBe(251);
    // coach 25 (Contact Email filled, Email/UserID blank) and coach 9 (only Email/UserID)
    expect(emails).toContain('email25@example.com');
    expect(emails).toContain('email9@example.com');
  });

  it('holds none of what an import drops', () => {
    expect(region).not.toMatch(/\b(19|20)\d\d-\d\d-\d\d\b/); // a birth date
    expect(region).not.toMatch(/555-100/); // a phone
    // A guardian: a coach who is a family's parent carries that placeholder name as their own, so the
    // coach blocks are the one place it may appear (a player's row and buddy request never name one).
    const peopleOnly = region
      .replace(/INSERT INTO demo_seed\.coaches[\s\S]*?;\n/, '')
      .replace(/INSERT INTO demo_seed\.team_coaches[\s\S]*?;\n/, '');
    expect(peopleOnly).not.toMatch(/Parent[12]First|Parent[12]Last/);
    expect(region).toMatch(/Parent1First9/);
    expect(region).not.toMatch(/Registration\b|Photo Consent|Youth (Small|Extra)/); // payment plan, consent, uniform
    const emailsOutsideCoaches = region
      .replace(/INSERT INTO demo_seed\.coaches[\s\S]*?;\n/, '')
      .match(/@/g);
    expect(emailsOutsideCoaches).toBeNull();
    expect(tableRows('players').columns).not.toEqual(expect.arrayContaining(['date_of_birth']));
  });

  it('puts U4 on four reserved 30-minute Saturday sessions, 15 minutes apart, from the facility file', () => {
    const u4 = fields.filter((f) => f.Division === 'U4');
    expect(u4).toHaveLength(4);
    const sorted = [...u4].sort((a, b) => minutes(a.Start) - minutes(b.Start));
    for (const s of sorted) expect(minutes(s.End) - minutes(s.Start)).toBe(30);
    for (let i = 1; i < sorted.length; i++) {
      expect(minutes(sorted[i].Start) - minutes(sorted[i - 1].End)).toBe(15);
    }
    expect(new Set(u4.map((s) => `${s.Location}/${s.Field}/${s.Day}`)).size).toBe(1);
    expect(u4.every((s) => s.Day === 'Sat')).toBe(true);
    expect(fields.filter((f) => f.Division && f.Division !== 'U4')).toHaveLength(0);
    expect(tableRows('practice_slots', facility).count).toBe(fields.length);
  });

  it("writes the facility grid in the fields import's own columns, one slot at a time", () => {
    expect(Object.keys(fields[0])).toEqual(CSV_TEMPLATES.fields.headers);
    const keys = fields.map((f) => [f.Location, f.Field, f.Subunit, f.Day, f.Start].join('|'));
    expect(new Set(keys).size).toBe(keys.length);
    for (const f of fields) expect(f.Type).toBe('practice');
  });
});

describe("each division's practices, and the grid that carries them (Phase D, F)", () => {
  const teams = [...new Set(players.map((p) => p['Team Name']))];
  const ageOf = (team) => (team.startsWith('U4') ? 4 : Number(team.slice(1, 3)));
  const open = fields.filter((f) => !f.Division);

  /** `key -> [practices, minutes]` from the generated UPDATE. */
  function storedSettings() {
    const m =
      /FROM \(VALUES\n([\s\S]*?)\n\) AS v\(key, practices_per_week, practice_minutes\)/.exec(
        facility
      );
    if (!m) throw new Error('no UPDATE of the divisions');
    return Object.fromEntries(
      [...m[1].matchAll(/\('([^']+)', (\d+), (\d+)\)/g)].map(([, key, n, mins]) => [
        key,
        [Number(n), Number(mins)],
      ])
    );
  }

  it('sets U4 to one 30-minute session, U5 to U12 to two of 60 and U14 and older to two of 90', () => {
    const settings = storedSettings();
    const keys = [
      ...region
        .match(/INSERT INTO demo_seed\.divisions[\s\S]*?;\n/)[0]
        .matchAll(/^ {2}\('([^']+)'/gm),
    ].map((m) => m[1]);
    expect(Object.keys(settings).sort()).toEqual([...keys].sort());
    expect(keys).toHaveLength(21);
    for (const key of keys) {
      const age = Number(key.slice(1).replace(/[BG]$/, ''));
      const want = age === 4 ? [1, 30] : age >= 14 ? [2, 90] : [2, 60];
      expect(settings[key], key).toEqual(want);
    }
    // the same rule the generator exports
    expect(practiceSettingsFor(4)).toEqual({ practicesPerWeek: 1, practiceMinutes: 30 });
    expect(practiceSettingsFor(12)).toEqual({ practicesPerWeek: 2, practiceMinutes: 60 });
    expect(practiceSettingsFor(14)).toEqual({ practicesPerWeek: 2, practiceMinutes: 90 });
  });

  it('runs every open slot Monday to Friday, in the length of a division, and nothing else', () => {
    expect(new Set(open.map((f) => f.Day))).toEqual(new Set(DEMO_GRID.weekdays));
    const lengths = new Set(open.map((f) => minutes(f.End) - minutes(f.Start)));
    expect(lengths).toEqual(new Set([60, 90]));
    expect(fields).toHaveLength(304);
    // 18 unlit halves x 5 weekdays x 3 hours; the lit ground's 2 halves x 5 weekdays x 3 slots
    expect(open.filter((f) => minutes(f.End) - minutes(f.Start) === 60)).toHaveLength(270);
    expect(open.filter((f) => minutes(f.End) - minutes(f.Start) === 90)).toHaveLength(30);
  });

  it('carries the demand: two 60-minute and two 90-minute practices a team, with room to spare', () => {
    const demand = { 60: 0, 90: 0 };
    for (const team of teams) {
      const age = ageOf(team);
      if (age === 4) continue; // its Saturday sessions are the reserved slots, counted above
      const { practicesPerWeek, practiceMinutes } = practiceSettingsFor(age);
      demand[practiceMinutes] += practicesPerWeek;
    }
    expect(demand).toEqual({ 60: 224, 90: 24 });
    for (const [mins, want] of [
      [60, 224],
      [90, 24],
    ]) {
      const supply = open.filter((f) => minutes(f.End) - minutes(f.Start) === mins).length;
      expect(supply, `${mins}-minute slots`).toBeGreaterThan(want);
    }
  });

  it('has exactly one lit venue, whose ground carries the 90-minute slots and the late ones', () => {
    const lights = new Map(
      [
        ...facility
          .match(/INSERT INTO demo_seed\.locations[\s\S]*?;\n/)[0]
          .matchAll(/\('([^']+)', [-\d.]+, [-\d.]+, (true|false)\)/g),
      ].map(([, name, lit]) => [name, lit === 'true'])
    );
    expect([...lights.values()].filter(Boolean)).toHaveLength(1);
    const litVenue = [...lights].find(([, lit]) => lit)[0];
    expect(litVenue).toBe('Eastgate Sports Complex');
    expect(new Set(fields.map((f) => f.Location))).toEqual(new Set(lights.keys()));
    for (const f of open) {
      const lit = lights.get(f.Location);
      // unlit ground: 60-minute slots over by 19:00. Lit ground: the 90-minute ones, to 20:30.
      if (lit) expect(minutes(f.End) - minutes(f.Start), 'lit slot').toBe(90);
      else {
        expect(minutes(f.End) - minutes(f.Start), 'unlit slot').toBe(60);
        expect(minutes(f.End), `${f.Location} ${f.Field} ${f.Start}`).toBeLessThanOrEqual(19 * 60);
      }
    }
    expect(Math.max(...open.map((f) => minutes(f.End)))).toBe(20 * 60 + 30);
  });

  describe('before sunset, where the sun allows it', () => {
    const unlitSites = SYNTHETIC_HEAT_SITES.slice(1, 4);
    /** Unlit slots that end at or after the sunset of a date, at any unlit venue. */
    function pastSunset(date, ends) {
      return unlitSites.flatMap(({ latitude, longitude }) => {
        const sunset = Math.floor(
          sunsetOnDate({ date, latitude, longitude, timeZone: 'America/Los_Angeles' }).minutes
        );
        return ends.filter((end) => end > sunset);
      });
    }
    const unlitEnds = [
      ...new Set(
        open.filter((f) => f.Location !== 'Eastgate Sports Complex').map((f) => minutes(f.End))
      ),
    ];
    const dates = (from, to) => {
      const out = [];
      for (
        let t = Date.parse(`${from}T00:00:00Z`);
        t <= Date.parse(`${to}T00:00:00Z`);
        t += 86_400_000
      ) {
        out.push(new Date(t).toISOString().slice(0, 10));
      }
      return out;
    };

    it("ends every unlit slot before sunset from 1 April to 31 August (at the demo's sites)", () => {
      expect(unlitEnds).toEqual(expect.arrayContaining([17 * 60, 18 * 60, 19 * 60]));
      const late = dates('2027-04-01', '2027-08-31').filter(
        (d) => pastSunset(d, unlitEnds).length > 0
      );
      expect(late).toEqual([]);
    });

    it('can fail: a 20:00 slot, or a winter date, is past sunset', () => {
      // the same check, over a grid whose last unlit slot ended at 20:30, names April
      expect(
        dates('2027-04-01', '2027-08-31').some(
          (d) => pastSunset(d, [...unlitEnds, 20 * 60 + 30]).length > 0
        )
      ).toBe(true);
      // and over the real grid in December, every unlit slot but none is before sunset
      expect(pastSunset('2027-12-21', unlitEnds)).not.toHaveLength(0);
    });
  });
});

describe("the demo league's programs (migration 20261101020000)", () => {
  const programsMigration = readFileSync(
    path.join(path.dirname(DEMO_MIGRATION), '20261101020000_programs.sql'),
    'utf8'
  );

  /** `division_key -> program` rows of the INSERT into demo_seed.division_programs. */
  function storedPrograms() {
    const m =
      /INSERT INTO demo_seed\.division_programs \(division_key, program_name\) VALUES\n([\s\S]*?);\n/.exec(
        programsMigration
      );
    if (!m) throw new Error('no INSERT for demo_seed.division_programs');
    return Object.fromEntries(
      [...m[1].matchAll(/\('([^']+)', '([^']+)'\)/g)].map(([, key, name]) => [key, name])
    );
  }

  /**
   * The program each division belongs to, read from the fixture's `Payment Plan` column
   * (`2026 U07B Junior Registration`: division U7B, program Junior; `2026 Minis Registration`:
   * the U4 division, program Minis; `2026 U09B Registration`: no program name).
   */
  function programsFrom(rows) {
    const out = {};
    const divisions = new Set(
      tableRowsOf('divisions').map((row) => row[0]) // the key column
    );
    for (const plan of new Set(rows.map((p) => p['Payment Plan']))) {
      const minis = /^2026 (Minis) Registration$/.exec(plan);
      if (minis) {
        out.U4 = 'Minis';
        continue;
      }
      const m = /^2026 U0?(\d+)([BG]) (?:(\w+) )?Registration$/.exec(plan);
      if (!m) throw new Error(`unreadable Payment Plan "${plan}"`);
      const [, age, gender, program] = m;
      if (program) out[`U${age}${gender}`] = program;
      else if (!divisions.has(`U${age}${gender}`)) throw new Error(`no division for "${plan}"`);
    }
    return out;
  }

  /** The key of each demo_seed.divisions row, from the generated region. */
  function tableRowsOf(table) {
    const m = new RegExp(
      `INSERT INTO demo_seed\\.${table} \\([^)]*\\) VALUES\n([\\s\\S]*?);\n`
    ).exec(region);
    return m[1].split('\n').map((line) => [...line.matchAll(/'([^']*)'/g)].map((x) => x[1]));
  }

  it("stores the programs the fixture's Payment Plan names, for every division it names one for", () => {
    expect(storedPrograms()).toEqual(programsFrom(players));
  });

  it('puts only seeded divisions in a program, and leaves U9, U10 and U12 in the default', () => {
    const keys = new Set(tableRowsOf('divisions').map((row) => row[0]));
    for (const key of Object.keys(storedPrograms())) expect(keys.has(key), key).toBe(true);
    for (const key of ['U9B', 'U9G', 'U10B', 'U10G', 'U12B', 'U12G']) {
      expect(storedPrograms()[key], key).toBeUndefined();
    }
    expect(new Set(Object.values(storedPrograms()))).toEqual(
      new Set(['Minis', 'Micro', 'Junior', 'Select'])
    );
  });

  it('can fail: a fixture whose U7B plans name another program no longer equals the stored rows', () => {
    const planted = plantedCopy('programs', 'players.csv', (text) =>
      text.replaceAll('2026 U07B Junior Registration', '2026 U07B Select Registration')
    );
    const changed = Papa.parse(readFileSync(path.join(planted, 'players.csv'), 'utf8'), {
      header: true,
      skipEmptyLines: true,
    }).data;
    expect(programsFrom(changed).U7B).toBe('Select');
    expect(storedPrograms()).not.toEqual(programsFrom(changed));
  });
});
