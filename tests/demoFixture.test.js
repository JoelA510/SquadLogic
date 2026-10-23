/**
 * The demo registration fixture (`fixtures/demo-2026/`): an anonymized GotSport-shaped rec export
 * reshaped into a fixed league. These checks hold what the README promises, so an edit to the CSVs
 * cannot quietly reintroduce a real-looking value or break the league's shape.
 *
 * Statically out of reach, and so not claimed: that the anonymization itself was complete. That was
 * checked once, outside the repo, against the source export (README, "How it was made"); this file
 * can only hold the result to its placeholder shapes.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Papa from 'papaparse';
import { describe, expect, it } from 'vitest';
import {
  isSensitiveHeader,
  makeDedupeHeaderTransformer,
} from '../frontend/src/utils/gotsportCanonicalizer.js';
import {
  findMissingRequiredHeaders,
  normalizeImportHeader,
} from '../frontend/src/utils/importHeaders.js';
import { composeFullName, normalizeImportRow } from '../frontend/src/utils/importRows.js';
import { canonicalImportKey, filterImportRows } from '../frontend/src/utils/importAllowlist.js';
import { matchHeaders } from '../frontend/src/utils/telemetryUtils.js';
import * as edgeRows from '../supabase/functions/_shared/import-rows.ts';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'demo-2026');

function load(file) {
  const { data, meta, errors } = Papa.parse(readFileSync(path.join(DIR, file), 'utf8'), {
    header: true,
    skipEmptyLines: true,
    transformHeader: makeDedupeHeaderTransformer(),
  });
  expect(errors).toEqual([]);
  return { rows: data, fields: meta.fields };
}

const players = load('players.csv');
const coaches = load('coaches.csv');
const P = players.rows;
const C = coaches.rows;
const BUDDY = players.fields.find((h) => h.startsWith('If you have a buddy request'));
const KID = 'First and Last name of your player.';
const KID_DOB = "What is your player's birth date?";
const KID_GENDER = "What is your player's gender?";

// fixtures/season-2026/game_formats.csv; U4 plays no games (practice cohorts, see the README)
const ON_FIELD = { 5: 4, 6: 4, 7: 5, 8: 5, 9: 7, 10: 7, 12: 9, 14: 11, 16: 11, 19: 11 };
const ageOf = (team) => Number(team.slice(1, 3));
const divisionOf = (team) => (team.startsWith('U4') ? 'U4' : team.slice(0, 4));

const PLAYER = /^First(\d+) Last\1$/;
const UNREGISTERED = /^UnregisteredFirst(\d+) UnregisteredLast\1$/;
// one person's first and last placeholder carry the same role and number
const ADULT =
  /^(Parent([12])First(\d+) Parent\2Last\3|CoachFirst(\d+) CoachLast\4|AdultFirst(\d+) AdultLast\5)$/;
const PERSON_REF = (v) => v === 'N/A' || PLAYER.test(v) || UNREGISTERED.test(v);
const EMAIL = /^email\d+@example\.com$/;
const PHONE = /^555-100-\d{4}$/;
const TEAM = /^(U\d\d[BG]\d\d|U4[ABCD])$/;

const filled = (v) => v !== undefined && v !== null && v !== '';
const parts = (v) => (filled(v) ? v.split(' and ') : []);
const usDate = (iso) => `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}/${iso.slice(0, 4)}`;
/** Natural age group with the export's August 1 cutoff. */
const ageGroupOf = (iso) => {
  const [y, m] = iso.split('-').map(Number);
  return 2026 - (m >= 8 ? y : y - 1);
};

const byName = new Map(P.map((r) => [`${r['First Name']} ${r['Last Name']}`, r]));
const teams = new Map();
for (const r of P) teams.set(r['Team Name'], [...(teams.get(r['Team Name']) ?? []), r]);

describe('demo fixture: league shape', () => {
  it('has the 21 divisions with 8 teams to U12 and 2 from U14, plus four U4 cohorts', () => {
    const divisions = new Map();
    for (const t of teams.keys()) {
      const d = divisionOf(t);
      divisions.set(d, [...(divisions.get(d) ?? []), t].sort());
    }
    const expected = ['U4'];
    for (const a of [5, 6, 7, 8, 9, 10, 12, 14, 16, 19])
      for (const g of 'BG') expected.push(`U${String(a).padStart(2, '0')}${g}`);
    expect([...divisions.keys()].sort()).toEqual(expected.sort());
    expect(divisions.get('U4')).toEqual(['U4A', 'U4B', 'U4C', 'U4D']);
    for (const [d, names] of divisions) {
      if (d === 'U4') continue;
      const n = ageOf(d) <= 12 ? 8 : 2;
      expect(names).toEqual(
        Array.from({ length: n }, (_, i) => `${d}${String(i + 1).padStart(2, '0')}`)
      );
    }
  });

  it('fills each team to twice its on-field count less three, and U4 to 55 in cohorts of at most 15', () => {
    let u4 = 0;
    for (const [t, rows] of teams) {
      if (t.startsWith('U4')) {
        expect(rows.length).toBeLessThanOrEqual(15);
        u4 += rows.length;
        continue;
      }
      expect([t, rows.length]).toEqual([t, 2 * ON_FIELD[ageOf(t)] - 3]);
    }
    expect(u4).toBe(55);
    expect(P).toHaveLength(1259);
  });

  it('gives every team one to three coaches', () => {
    const count = new Map();
    for (const r of C)
      if (filled(r['Team Name'])) count.set(r['Team Name'], (count.get(r['Team Name']) ?? 0) + 1);
    for (const t of teams.keys()) {
      expect(count.get(t)).toBeGreaterThanOrEqual(1);
      expect(count.get(t)).toBeLessThanOrEqual(3);
    }
  });
});

describe('demo fixture: anonymized shapes', () => {
  it('names every player, guardian and coach with a placeholder', () => {
    for (const r of P) {
      expect(`${r['First Name']} ${r['Last Name']}`).toMatch(PLAYER);
      for (const g of [1, 2]) {
        if (filled(r[`Guardian ${g} First Name`]) || filled(r[`Guardian ${g} Last Name`]))
          expect(`${r[`Guardian ${g} First Name`]} ${r[`Guardian ${g} Last Name`]}`).toMatch(ADULT);
      }
      // two guardians of one child are two people
      if (filled(r['Guardian 2 First Name']))
        expect(r['Guardian 2 First Name']).not.toBe(r['Guardian 1 First Name']);
    }
    for (const r of C) {
      const name = `${r['First Name']} ${r['Last Name']}`;
      // a registration filed under a child's profile carries the child (README)
      if (!PLAYER.test(name) && !UNREGISTERED.test(name)) expect(name).toMatch(ADULT);
      if (filled(r['Guardian 1 First Name']) || filled(r['Guardian 1 Last Name']))
        expect(`${r['Guardian 1 First Name']} ${r['Guardian 1 Last Name']}`).toMatch(ADULT);
    }
  });

  it("names a coach's players with placeholders only", () => {
    const second = coaches.fields.find((h) =>
      h.includes('first and last name of your second player')
    );
    for (const r of C) {
      for (const h of [KID, second])
        if (filled(r[h])) expect([h, PERSON_REF(r[h])]).toEqual([h, true]);
    }
  });

  it('uses only example.com emails and 555-100 phones', () => {
    for (const [rows, fields] of [
      [P, players.fields],
      [C, coaches.fields],
    ]) {
      for (const h of fields) {
        if (/email/i.test(h)) for (const r of rows) if (filled(r[h])) expect(r[h]).toMatch(EMAIL);
        if (/phone/i.test(h)) for (const r of rows) if (filled(r[h])) expect(r[h]).toMatch(PHONE);
      }
    }
  });

  it('uses the program pseudonyms, never the source club names', () => {
    for (const r of P)
      expect(r['Payment Plan']).toMatch(
        /^2026 (Minis|U\d\d[BG]( (Micro|Junior|Select))?) Registration$/
      );
    for (const r of [...P, ...C]) if (filled(r['Team Name'])) expect(r['Team Name']).toMatch(TEAM);
    for (const r of P) expect(filled(r['Team Name'])).toBe(true);
  });

  it('rebuilds free text from placeholders only', () => {
    for (const r of P) {
      if (!filled(r[BUDDY]) || r[BUDDY] === 'N/A') continue;
      for (const part of parts(r[BUDDY]))
        expect(PLAYER.test(part) || UNREGISTERED.test(part)).toBe(true);
    }
    const adult =
      /^(Parent[12]First|CoachFirst|AdultFirst)(\d+) (Parent[12]Last|CoachLast|AdultLast)\2$/;
    for (const r of C) {
      for (const h of ['Preferred Co-Coach', 'Preferred Co-Coach__2']) {
        if (!filled(r[h]) || r[h] === 'No preference') continue;
        for (const part of parts(r[h]))
          expect(adult.test(part) || UNREGISTERED.test(part)).toBe(true);
      }
    }
  });
});

describe('demo fixture: dates and cross-references', () => {
  it('keeps each birthdate inside its age group and birth year', () => {
    for (const r of P) {
      expect(ageGroupOf(r['Date of Birth'])).toBe(Number(r['Age Group']));
      expect(r['Date of Birth'].slice(0, 4)).toBe(r['Birth Year']);
    }
  });

  it('gives adult coaches synthetic birthdates and every row a synthetic registration time', () => {
    for (const r of C) {
      expect(r['Date of Birth'].slice(0, 4)).toBe(r['Birth Year']);
      const name = `${r['First Name']} ${r['Last Name']}`;
      // a row filed under a child's profile carries that child's birthdate (README)
      if (byName.has(name)) expect(r['Date of Birth']).toBe(byName.get(name)['Date of Birth']);
      else if (!UNREGISTERED.test(name)) {
        expect(Number(r['Birth Year'])).toBeGreaterThanOrEqual(1970);
        expect(Number(r['Birth Year'])).toBeLessThanOrEqual(1996);
      }
    }
    const stamp = (v) => {
      const m = /^(\d\d)\/(\d\d)\/2026 (\d\d):(\d\d)$/.exec(v);
      expect(m).not.toBeNull();
      return Date.UTC(2026, Number(m[1]) - 1, Number(m[2]), Number(m[3]), Number(m[4]));
    };
    for (const r of [...P, ...C]) {
      const created = stamp(r.Created);
      const submitted = stamp(r['Submitted At']);
      expect(created).toBeGreaterThanOrEqual(Date.UTC(2026, 2, 1));
      expect(submitted).toBeGreaterThan(created);
      expect(submitted - created).toBeLessThan(4 * 60 * 60 * 1000);
    }
  });

  it('names only players in the demo in buddy requests, never the requester', () => {
    for (const r of P) {
      for (const part of parts(r[BUDDY])) {
        if (!PLAYER.test(part)) continue;
        expect(byName.has(part)).toBe(true);
        expect(part).not.toBe(`${r['First Name']} ${r['Last Name']}`);
      }
    }
  });

  it('puts mutual buddies in one division on one team', () => {
    let pairs = 0;
    for (const r of P) {
      const me = `${r['First Name']} ${r['Last Name']}`;
      for (const part of parts(r[BUDDY])) {
        const other = byName.get(part);
        if (!other || !parts(other[BUDDY]).includes(me)) continue;
        if (divisionOf(other['Team Name']) !== divisionOf(r['Team Name'])) continue;
        pairs += 1;
        expect([me, r['Team Name']]).toEqual([me, other['Team Name']]);
      }
    }
    expect(pairs).toBe(438); // 219 same-division pairs, each counted from both sides
  });

  it("matches a coach's player to that player's name, birthdate, gender and team", () => {
    let linked = 0;
    for (const r of C) {
      const kid = byName.get(r[KID]);
      if (!kid) continue;
      linked += 1;
      expect(r[KID_DOB]).toBe(usDate(kid['Date of Birth']));
      expect(r[KID_GENDER]).toBe(kid.Gender === 'm' ? 'Male' : 'Female');
      if (filled(r['Team Name'])) expect(r['Team Name']).toBe(kid['Team Name']);
      const parent = /^Parent([12])First(\d+)$/.exec(r['First Name']);
      if (parent) {
        const own = byName.get(`First${parent[2]} Last${parent[2]}`);
        expect(own[`Guardian ${parent[1]} First Name`]).toBe(r['First Name']);
      }
    }
    expect(linked).toBeGreaterThan(200);
  });
});

describe('demo fixture: through the import allowlist (R0) and the row rules (D1)', () => {
  const kept = (rows, type) => filterImportRows(type, rows, []);

  it('keeps every coach row a full name and an email, and nothing else from a guardian', () => {
    const rows = kept(C, 'coaches');
    for (const [i, row] of rows.entries()) {
      const out = composeFullName(normalizeImportRow(row, canonicalImportKey));
      expect(out.full_name).toBe(`${C[i]['First Name']} ${C[i]['Last Name']}`);
      if (filled(C[i]['Email/UserID']) || filled(C[i]['Contact Email']))
        expect(filled(out.email)).toBe(true);
      for (const key of Object.keys(row))
        expect(key.toLowerCase()).not.toMatch(/guardian|phone|address/);
    }
  });

  it('keeps every player the fields teaming reads, and no guardian or contact column', () => {
    const rows = kept(P, 'players');
    for (const row of rows) {
      const out = normalizeImportRow(row, canonicalImportKey);
      expect(filled(out.first_name) && filled(out.last_name)).toBe(true);
      for (const key of Object.keys(out))
        expect(key).not.toMatch(/guardian|phone|email|address|payment/);
    }
    expect(rows.some((row) => 'Team Name' in row)).toBe(true);
  });
});

describe('demo fixture: the real import path', () => {
  const required = ({ fields }, type) => {
    const kept = fields.filter((h) => !isSensitiveHeader(h));
    return findMissingRequiredHeaders(kept, type, matchHeaders(kept, [], {}).mappings);
  };

  it('passes the player import header check', () => {
    expect(required(players, 'players')).toEqual([]);
  });

  // `Email/UserID` and `Contact Email` both resolve to `email`. Rows go through the import's own
  // header matching and row normalization (browser and Edge copies), so a blank Contact Email no
  // longer erases a login email (fixtures/demo-2026/README.md, "Import gaps", fixed by D1).
  const emailAfterImport = ({ fields, rows }, normalize) => {
    const kept = fields.filter((h) => !isSensitiveHeader(h));
    const { mappings } = matchHeaders(kept, [], {});
    const resolve = (h) => normalizeImportHeader(mappings, h);
    expect(kept.filter((h) => resolve(h) === 'email').length).toBe(2);
    return rows.map((r) => {
      const row = Object.fromEntries(kept.map((h) => [h, r[h] ?? '']));
      return normalize(row, resolve).email;
    });
  };

  for (const [name, normalize] of [
    ['browser', normalizeImportRow],
    ['edge', edgeRows.normalizeImportRow],
  ]) {
    it(`keeps every coach row's email when either column has one (${name})`, () => {
      const emails = emailAfterImport(coaches, normalize);
      const withEither = C.filter(
        (r) => filled(r['Email/UserID']) || filled(r['Contact Email'])
      ).length;
      expect(emails.filter(filled).length).toBe(withEither);
      // The 62 rows the last-column rule used to empty: login email only.
      const loginOnly = C.map((r, i) => [r, i]).filter(
        ([r]) => filled(r['Email/UserID']) && !filled(r['Contact Email'])
      );
      expect(loginOnly.length).toBe(62);
      for (const [r, i] of loginOnly) expect(emails[i]).toBe(r['Email/UserID']);
    });

    it(`keeps the Contact Email where the two columns differ (${name})`, () => {
      const emails = emailAfterImport(players, normalize);
      const both = P.map((r, i) => [r, i]).filter(
        ([r]) =>
          filled(r['Email/UserID']) &&
          filled(r['Contact Email']) &&
          r['Email/UserID'] !== r['Contact Email']
      );
      expect(both.length).toBe(46);
      for (const [r, i] of both) expect(emails[i]).toBe(r['Contact Email']);
    });
  }

  // A GotSport coach export has First Name and Last Name and no full-name column; the import
  // composes it (D1), so the header check passes.
  it('passes the coach import header check', () => {
    expect(required(coaches, 'coaches')).toEqual([]);
  });

  /** @type {Array<[string, { normalizeImportRow: typeof normalizeImportRow, composeFullName: typeof composeFullName }]>} */
  const copies = [
    ['browser', { normalizeImportRow, composeFullName }],
    ['edge', edgeRows],
  ];
  for (const [name, rows] of copies) {
    it(`gives every coach row a full name from First Name and Last Name (${name})`, () => {
      const kept = coaches.fields.filter((h) => !isSensitiveHeader(h));
      const { mappings } = matchHeaders(kept, [], {});
      const resolve = (h) => normalizeImportHeader(mappings, h);
      expect(kept.map(resolve)).not.toContain('full_name');
      for (const r of C) {
        const row = rows.composeFullName(rows.normalizeImportRow(r, resolve));
        expect(row.full_name).toBe(`${r['First Name']} ${r['Last Name']}`);
      }
    });
  }
});
