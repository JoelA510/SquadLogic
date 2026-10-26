// @vitest-environment node
/**
 * The demo league's seed (`demo_seed` rows in `supabase/migrations/20261030010000_demo_sessions.sql`),
 * held to the fixture it is generated from (`fixtures/demo-2026/`, by `scripts/build-demo-seed.mjs`).
 *
 *   - **drift**: regenerating from the fixture gives exactly the rows in the migration, so nobody
 *     hand-edits them and the fixture cannot move without the migration (a new migration, never an edit
 *     of an applied one: a fixture change fails here until the seed is regenerated);
 *   - **the check can fail**: a copy of the fixture with one player's name changed, one with a coach
 *     email changed and one with a U4 session moved each give different SQL, and the drift comparison
 *     says so;
 *   - **what the seed holds, read from the fixture, not from the generator**: every registration id, the
 *     team and division counts, U4 practice-only with four 30-minute sessions 15 minutes apart, the
 *     facility grid in the fields import's own columns, unique coach emails, and none of what an import
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
  DEMO_MIGRATION,
  END_MARK,
  buildDemoSeedSql,
  generatedRegion,
} from '../scripts/build-demo-seed.mjs';
import { CSV_TEMPLATES } from '../frontend/src/utils/csvTemplates.js';

const parse = (dir, file) =>
  Papa.parse(readFileSync(path.join(dir, file), 'utf8'), { header: true, skipEmptyLines: true })
    .data;

const migration = readFileSync(DEMO_MIGRATION, 'utf8');
const region = generatedRegion(migration);
const fresh = buildDemoSeedSql();

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

/** The rows of one seed table, from the generated region. */
function tableRows(table) {
  const m = new RegExp(
    `INSERT INTO demo_seed\\.${table} \\(([^)]*)\\) VALUES\\n([\\s\\S]*?);\\n`
  ).exec(region);
  if (!m) throw new Error(`no INSERT for demo_seed.${table}`);
  return { columns: m[1].split(', '), count: m[2].split('\n').length };
}

describe('the seed against its fixture', () => {
  it('has the markers, and holds exactly what the generator builds from the fixture (drift)', () => {
    expect(migration.indexOf(BEGIN_MARK)).toBeGreaterThan(0);
    expect(migration.indexOf(END_MARK)).toBeGreaterThan(migration.indexOf(BEGIN_MARK));
    expect(region.length).toBeGreaterThan(100_000);
    expect(region).toBe(fresh);
  });

  it('would notice a fixture that moved: a renamed player, a changed coach email, a moved U4 session', () => {
    const first = plantedCopy('first', 'players.csv', (t) =>
      t.replace(',First1,Last1,', ',Moved,Last1,')
    );
    const email = plantedCopy('email', 'coaches.csv', (t) =>
      t.replace('email9@example.com', 'other9@example.com')
    );
    const session = plantedCopy('session', 'fields.csv', (t) =>
      t.replace('09:45,10:15', '09:40,10:10')
    );
    for (const dir of [first, email, session]) {
      expect(buildDemoSeedSql(dir)).not.toBe(region);
    }
  });

  it('refuses a character the SQL writer cannot carry', () => {
    const dir = plantedCopy('quote', 'players.csv', (t) =>
      t.replace(',First2,Last2,', ",O'Neil,Last2,")
    );
    // a quote is escaped, not refused...
    expect(buildDemoSeedSql(dir)).toContain("'O''Neil'");
    // ...a backslash is a defect in a fixture of placeholders
    const bad = plantedCopy('backslash', 'players.csv', (t) =>
      t.replace(',First3,Last3,', ',Fir\\st3,Last3,')
    );
    expect(() => buildDemoSeedSql(bad)).toThrow(/unsafe character/);
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

  it('puts U4 on four reserved 30-minute sessions, 15 minutes apart, from the facility file', () => {
    const u4 = fields.filter((f) => f.Division === 'U4');
    expect(u4).toHaveLength(4);
    const minutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
    const sorted = [...u4].sort((a, b) => minutes(a.Start) - minutes(b.Start));
    for (const s of sorted) expect(minutes(s.End) - minutes(s.Start)).toBe(30);
    for (let i = 1; i < sorted.length; i++) {
      expect(minutes(sorted[i].Start) - minutes(sorted[i - 1].End)).toBe(15);
    }
    expect(new Set(u4.map((s) => `${s.Location}/${s.Field}/${s.Day}`)).size).toBe(1);
    expect(fields.filter((f) => f.Division && f.Division !== 'U4')).toHaveLength(0);
    expect(tableRows('practice_slots').count).toBe(fields.length);
  });

  it("writes the facility grid in the fields import's own columns, one slot at a time", () => {
    expect(Object.keys(fields[0])).toEqual(CSV_TEMPLATES.fields.headers);
    const keys = fields.map((f) => [f.Location, f.Field, f.Subunit, f.Day, f.Start].join('|'));
    expect(new Set(keys).size).toBe(keys.length);
    for (const f of fields) expect(f.Type).toBe('practice');
  });
});
