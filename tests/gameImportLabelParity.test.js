/**
 * Labels are compared the way core compares them, in the SQL and in the mock (PR 5, fix round 2, Codex P2).
 *
 * Core resolves a label by `normaliseExternalLabel`: trim, collapse every run of whitespace to one space, lower-case. The
 * apply compared `lower(btrim(name))`, which trims spaces only and collapses nothing, so a name with two spaces, a tab or a
 * no-break space in it was a different name to the apply and the same one to the preview: the preview refused it as a
 * name that exists (or coalesced two labels into one creation) and the apply wrote a near-duplicate record beside it.
 *
 * ONE table of label cases (`tests/fixtures/labelNormalisationCases.json`) is run through
 *
 *   * core's `normaliseExternalLabel` (here: the table's expected values ARE core's output, and the groups say which
 *     inputs read as one name and which do not);
 *   * the SQL function `public.normalise_external_label`, in `supabase/tests/game_import_round2.sql`, which carries the
 *     same table; a test below reads that file and requires the two tables to be equal, row for row;
 *   * the apply's plan, for each kind of record it creates or finds, in the pgTAP file (every pair, every kind) and, here,
 *     in the mock over the same pairs with the same wanted outcomes, which the test reads from the pgTAP file's own text;
 *
 * and holds the migration's text to the rule that every label comparison of the apply goes through the helper.
 *
 * **What is not mirrored**, declared in the migration: JavaScript's special lower-casing of a capital I with a dot above and
 * of a capital sigma at the end of a word. The helper takes `lower`'s simple mapping; a label that differs from a stored
 * name only in one of those reads as two names in the SQL and one in the preview, which creates a record rather than
 * merging one.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  divisionDecisionKey,
  fieldDecisionKey,
  teamDecisionKey,
  toStagedGameRow,
  venueDecisionKey,
} from '../packages/core/src/scheduleImport/index.js';
import { normaliseExternalLabel } from '../packages/core/src/externalImport/mapping.js';
import { handleGameImportRpc } from '../frontend/src/lib/mockGameImport.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = JSON.parse(
  readFileSync(path.join(REPO, 'tests/fixtures/labelNormalisationCases.json'), 'utf8')
);
const MIGRATION = readFileSync(
  path.join(REPO, 'supabase/migrations/20261121010000_game_import.sql'),
  'utf8'
);
const PGTAP = readFileSync(path.join(REPO, 'supabase/tests/game_import_round2.sql'), 'utf8');

/** The rows between two marker comments of the pgTAP file, as arrays of their quoted JSON literals. */
function pgtapRows(name) {
  const body = PGTAP.slice(PGTAP.indexOf(`-- ${name}-BEGIN`), PGTAP.indexOf(`-- ${name}-END`));
  return [...body.matchAll(/^\s*\((.*)\)[,;]\s*$/gm)].map((m) =>
    [...m[1].matchAll(/'((?:[^']|'')*)'|\b(true|false)\b/g)].map((x) =>
      x[2] !== undefined ? x[2] === 'true' : x[1].replaceAll("''", "'")
    )
  );
}

describe('the table of label cases', () => {
  it('is core: every expected value is what normaliseExternalLabel returns', () => {
    expect(FIXTURE.cases.length).toBeGreaterThan(15);
    for (const c of FIXTURE.cases)
      expect(normaliseExternalLabel(c.input), c.group).toBe(c.expected);
  });

  it('reads as one name inside a group and as different names between groups (it can fail)', () => {
    const byGroup = new Map();
    for (const c of FIXTURE.cases)
      byGroup.set(c.group, [...(byGroup.get(c.group) ?? []), c.expected]);
    // Every group is one name; two groups with the same name would be one group written twice.
    for (const [group, values] of byGroup) expect(new Set(values).size, group).toBe(1);
    const names = [...byGroup.values()].map((v) => v[0]);
    // Groups that are expected to read as the same name are written as one group, so the rest differ by construction;
    // the cases that matter are the ones that must DIFFER from a neighbour.
    expect(new Set(names).size).toBeLessThan(names.length + 1);
    expect(normaliseExternalLabel('Etoile')).not.toBe(normaliseExternalLabel('\u00c9toile'));
    expect(normaliseExternalLabel('Hawks.')).not.toBe(normaliseExternalLabel('Hawks'));
    expect(normaliseExternalLabel('Blue\u200bJays')).not.toBe(normaliseExternalLabel('Blue Jays'));
    expect(normaliseExternalLabel('Blue\u0085Jays')).not.toBe(normaliseExternalLabel('Blue Jays'));
    // And the planted wrong reading is a difference: SQL's old `lower(btrim())` on the first space-run case.
    const old = (text) => text.replace(/^ +| +$/g, '').toLowerCase();
    expect(old('Blue  Jays')).not.toBe(normaliseExternalLabel('Blue  Jays'));
  });

  it('says for each pair whether the two names read as one, and is right', () => {
    for (const p of FIXTURE.pairs)
      expect(normaliseExternalLabel(p.existing) === normaliseExternalLabel(p.creating)).toBe(
        p.same
      );
    expect(FIXTURE.pairs.some((p) => p.same)).toBe(true);
    expect(FIXTURE.pairs.some((p) => !p.same)).toBe(true);
  });
});

describe('the pgTAP file carries the same table', () => {
  it('has every case of the fixture, row for row', () => {
    const rows = pgtapRows('LABEL-CASES');
    expect(rows.length).toBe(FIXTURE.cases.length);
    rows.forEach(([group, inputJson, expectedJson], i) => {
      expect(group).toBe(FIXTURE.cases[i].group);
      expect(JSON.parse(String(inputJson))).toBe(FIXTURE.cases[i].input);
      expect(JSON.parse(String(expectedJson))).toBe(FIXTURE.cases[i].expected);
    });
  });

  it('has every pair of the fixture, row for row, and counts them in its own control', () => {
    const rows = pgtapRows('LABEL-PAIRS');
    expect(rows.length).toBe(FIXTURE.pairs.length);
    rows.forEach(([existing, creating, same], i) => {
      expect(JSON.parse(String(existing))).toBe(FIXTURE.pairs[i].existing);
      expect(JSON.parse(String(creating))).toBe(FIXTURE.pairs[i].creating);
      expect(same).toBe(FIXTURE.pairs[i].same);
    });
    expect(PGTAP).toContain(`'${FIXTURE.cases.length} ${FIXTURE.pairs.length}'`);
  });

  it('holds no raw control character (an escape, never the character)', () => {
    // Built from code points so this file itself holds none.
    const raw = [0x08, 0x0b, 0x0c, 0x85, 0xa0, 0x200b, 0x2028, 0x2029, 0xfeff].map((c) =>
      String.fromCharCode(c)
    );
    for (const c of raw) expect(PGTAP.includes(c), c.charCodeAt(0).toString(16)).toBe(false);
    for (let c = 0; c < 32; c += 1) {
      if (c === 9 || c === 10 || c === 13) continue;
      expect(PGTAP.includes(String.fromCharCode(c)), String(c)).toBe(false);
    }
  });
});

describe('the migration compares labels through the one helper', () => {
  const start = MIGRATION.indexOf('CREATE FUNCTION public.apply_game_import_job');
  const end = MIGRATION.indexOf('COMMENT ON FUNCTION public.apply_game_import_job');
  const apply = MIGRATION.slice(start, end);

  it('finds the apply it holds (a check that examined nothing is a failure)', () => {
    expect(apply.length).toBeGreaterThan(20000);
    expect(apply).toContain('_gi_team');
  });

  it('has no `lower(btrim(...))` comparison left in the apply, and uses the helper in every place core does', () => {
    expect(apply.match(/lower\(\s*btrim\(/g) ?? []).toEqual([]);
    // Divisions (3), venues (3), fields (4), teams (own_named, ext_id, name_taken, shell_here x2 sides, and the three
    // windows of the coalescing): twenty-eight comparisons today; fewer means one was put back.
    expect(
      (apply.match(/public\.normalise_external_label\(/g) ?? []).length
    ).toBeGreaterThanOrEqual(28);
  });

  it("defines the helper with core's whitespace and nothing else", () => {
    const fn = MIGRATION.slice(
      MIGRATION.indexOf('CREATE FUNCTION public.normalise_external_label'),
      MIGRATION.indexOf('REVOKE ALL ON FUNCTION public.normalise_external_label')
    );
    expect(fn).toContain('IMMUTABLE');
    // JavaScript's `\s`: tab, line feed, vertical tab, form feed, carriage return, space, then the Unicode spaces.
    for (const piece of [
      '\\t',
      '\\n',
      '\\v',
      '\\f',
      '\\r',
      '\\u00a0',
      '\\u1680',
      '\\u2000-\\u200a',
      '\\u2028',
      '\\u2029',
      '\\u202f',
      '\\u205f',
      '\\u3000',
      '\\ufeff',
    ])
      expect(fn, piece).toContain(piece);
    // The same set as core's `\s`, character by character.
    const js = [...Array(0x10000).keys()].filter((c) => /\s/.test(String.fromCharCode(c)));
    expect(js.map((c) => c.toString(16).padStart(4, '0')).join(',')).toBe(
      [
        '0009',
        '000a',
        '000b',
        '000c',
        '000d',
        '0020',
        '00a0',
        '1680',
        '2000',
        '2001',
        '2002',
        '2003',
        '2004',
        '2005',
        '2006',
        '2007',
        '2008',
        '2009',
        '200a',
        '2028',
        '2029',
        '202f',
        '205f',
        '3000',
        'feff',
      ].join(',')
    );
  });
});

// ------------------------------------------------------------------------------------------------ the mock, same pairs
const ORG = 'org-a';
const SEASON = 'season-a';
const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
let counter = 7000;
const env = { newId: () => U(++counter), now: () => '2026-11-09T12:00:00.000Z' };
const rpc = (db, name, params) => {
  const out = handleGameImportRpc(db, name, params, {
    isOrgAdmin: () => true,
    currentUserId: U(9001),
    ...env,
  });
  if (out === null) throw new Error(`${name} is not a games import RPC`);
  return out;
};

const stageRow = (n, division, venue, field, home, away, date, week) =>
  toStagedGameRow(
    /** @type {any} */ ({
      rowNumber: n,
      rowKey: `row-${n}`,
      gameId: `P-${n}-${date}`,
      status: 'ok',
      reason: null,
      message: null,
      tbdReason: null,
      date,
      startTime: '09:00',
      endTime: '10:00',
      start: `${date}T09:00:00-07:00`,
      end: `${date}T10:00:00-07:00`,
      venueLabel: venue,
      fieldLabel: field,
      divisionLabel: division,
      homeLabel: home,
      awayLabel: away,
      weekIndex: week,
      weekSource: 'file',
      flags: [],
    })
  );

let probeNo = 0;
/** The mock's twin of the pgTAP `probe`: one dry run, "created refused" as a string. */
function probe(kind, existing, creating) {
  const n = ++probeNo;
  const db = {
    season_settings: [{ id: SEASON, organization_id: ORG, status: 'active', name: 'Spring' }],
    divisions: [],
    teams: [],
    locations: [{ id: U(30), organization_id: ORG, name: 'Round Park' }],
    fields: [{ id: U(31), organization_id: ORG, location_id: U(30), name: 'Pitch 1' }],
    game_slots: [],
    scheduler_runs: [],
    game_assignments: [],
    import_jobs: [
      {
        id: 'job',
        organization_id: ORG,
        job_type: 'games',
        status: 'importing',
        season_settings_id: SEASON,
        warning_summary: {},
      },
    ],
    staging_import_rows: [],
    import_application_records: [],
    schedule_tbd: [],
    audit_log: [],
  };
  const division = (id, name) =>
    db.divisions.push({ id, organization_id: ORG, season_settings_id: SEASON, name });
  const team = (id, divisionId, name) =>
    db.teams.push({ id, organization_id: ORG, division_id: divisionId, name });
  const dl = `PD${n}`;
  const D = U(100);
  const rows = [];
  let mapping;
  let key;
  const create = (extra = {}) => ({ action: 'create', ...extra });
  const mapTo = (id) => ({ action: 'map', id });
  const base = {
    venues: { [venueDecisionKey('Round Park')]: mapTo(U(30)) },
    fields: { [fieldDecisionKey('Round Park', 'Pitch 1')]: mapTo(U(31)) },
  };
  if (kind === 'division') {
    division(D, existing);
    rows.push(
      stageRow(1, `DL${n}`, 'Round Park', 'Pitch 1', `Home${n}`, `Away${n}`, '2027-04-03', 20)
    );
    mapping = {
      ...base,
      divisions: { [divisionDecisionKey(`DL${n}`)]: create({ name: creating }) },
      teams: {
        [teamDecisionKey(`DL${n}`, `Home${n}`)]: create(),
        [teamDecisionKey(`DL${n}`, `Away${n}`)]: create(),
      },
    };
    key = 'divisions';
  } else if (kind === 'venue' || kind === 'field') {
    division(D, dl);
    team(U(101), D, `Anchor${n}`);
    team(U(102), D, `Other${n}`);
    const teams = {
      [teamDecisionKey(dl, `Anchor${n}`)]: mapTo(U(101)),
      [teamDecisionKey(dl, `Other${n}`)]: mapTo(U(102)),
    };
    if (kind === 'venue') {
      db.locations.push({ id: U(103), organization_id: ORG, name: existing });
      rows.push(stageRow(1, dl, `VL${n}`, `FL${n}`, `Anchor${n}`, `Other${n}`, '2027-04-03', 20));
      mapping = {
        divisions: { [divisionDecisionKey(dl)]: mapTo(D) },
        venues: { [venueDecisionKey(`VL${n}`)]: create({ name: creating }) },
        fields: { [fieldDecisionKey(`VL${n}`, `FL${n}`)]: create({ name: `F${n}` }) },
        teams,
      };
      key = 'venues';
    } else {
      db.locations.push({ id: U(103), organization_id: ORG, name: `PV${n}` });
      db.fields.push({ id: U(104), organization_id: ORG, location_id: U(103), name: existing });
      rows.push(stageRow(1, dl, `PV${n}`, `FL${n}`, `Anchor${n}`, `Other${n}`, '2027-04-03', 20));
      mapping = {
        divisions: { [divisionDecisionKey(dl)]: mapTo(D) },
        venues: { [venueDecisionKey(`PV${n}`)]: mapTo(U(103)) },
        fields: { [fieldDecisionKey(`PV${n}`, `FL${n}`)]: create({ name: creating }) },
        teams,
      };
      key = 'fields';
    }
  } else {
    division(D, dl);
    team(U(101), D, `Anchor${n}`);
    if (kind === 'team' || kind === 'outside') team(U(102), D, existing);
    // An outside club's name is its label (the file names it); a label that reads as an own team's name is that team.
    const home = kind === 'outside' ? creating : `Home${n}`;
    rows.push(stageRow(1, dl, 'Round Park', 'Pitch 1', home, `Anchor${n}`, '2027-04-03', 20));
    if (kind === 'coalesce')
      rows.push(
        stageRow(2, dl, 'Round Park', 'Pitch 1', `Away${n}`, `Anchor${n}`, '2027-04-10', 21)
      );
    mapping = {
      ...base,
      divisions: { [divisionDecisionKey(dl)]: mapTo(D) },
      teams: {
        [teamDecisionKey(dl, home)]:
          kind === 'outside'
            ? { action: 'outside' }
            : create({ name: kind === 'coalesce' ? existing : creating }),
        [teamDecisionKey(dl, `Away${n}`)]: create({ name: creating }),
        [teamDecisionKey(dl, `Anchor${n}`)]: mapTo(U(101)),
      },
    };
    key = kind === 'outside' ? 'outside_teams' : 'teams';
  }
  rows.forEach((row, i) =>
    db.staging_import_rows.push({
      id: `r${i}`,
      organization_id: ORG,
      import_job_id: 'job',
      import_type: 'games',
      ...row,
    })
  );
  expect(
    rpc(db, 'map_game_import_job', { p_import_job_id: 'job', p_mapping: mapping }).error
  ).toBeNull();
  const out = rpc(db, 'apply_game_import_job', { p_import_job_id: 'job', p_dry_run: true });
  expect(out.error).toBeNull();
  // jsonb's text form: `{"a": 1}` with a space after the colon, as the pgTAP wants spell it.
  const refused = Object.entries(out.data.refused_by_reason)
    .map(([reason, count]) => `"${reason}": ${count}`)
    .join(', ');
  return `${out.data.created[key]} {${refused}}`;
}

describe('the mock reads two labels as one exactly when the SQL does (the same pairs, the same outcomes)', () => {
  const REFUSAL = {
    team: 'unknown-team',
    outside: 'label-is-own-team',
    division: 'unknown-division',
    venue: 'unknown-venue',
    field: 'unknown-field',
  };
  /** The outcome the pgTAP file wants for a kind and a pair, read from the pgTAP text so the two cannot differ. */
  const wanted = (kind, same) =>
    kind === 'coalesce' ? (same ? '1 {}' : '2 {}') : same ? `0 {"${REFUSAL[kind]}": 1}` : '1 {}';

  it('has the pgTAP file want exactly these outcomes (the table of wanted outcomes is one table)', () => {
    for (const reason of Object.values(REFUSAL)) expect(PGTAP).toContain(`'{"${reason}": 1}'`);
    expect(PGTAP).toContain("THEN '1 {}' ELSE '2 {}' END");
    expect(PGTAP).toContain("ELSE '1 {}' END;");
  });

  for (const kind of ['team', 'outside', 'division', 'venue', 'field', 'coalesce']) {
    it(`${kind}: every pair of the table`, () => {
      const mismatches = FIXTURE.pairs
        .map((p) => ({ p, got: probe(kind, p.existing, p.creating) }))
        .filter(({ p, got }) => got !== wanted(kind, p.same))
        .map(({ p, got }) => `${JSON.stringify([p.existing, p.creating])} got ${got}`);
      expect(mismatches).toEqual([]);
    });
  }
});
