/**
 * F11-4a task A4 (docs/changes/2026-11-13-settings-scope.md; lesson 77): the mock's settings cascade is a twin of the
 * database's, held to the cases of supabase/tests/scoped_settings.sql. Every outcome named here is required to appear in
 * that file's text (`inPgtap`), so the two cannot drift apart silently: the setter's refusals and controls, the audit
 * row, the rollover's copy, the standings seam over the cascade, the practice setter, and a deleted program's values.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  copyScopedSettingsForRollover,
  handleScopedSettingRpc,
  scopedValueForDivision,
} from '../frontend/src/lib/mockScopedSettings.js';
import { handleSeasonRpc } from '../frontend/src/lib/mockSeasons.js';
import { handleProgramRpc, normalizePrograms } from '../frontend/src/lib/mockPrograms.js';

const PGTAP = readFileSync(path.join(process.cwd(), 'supabase/tests/scoped_settings.sql'), 'utf8');
const inPgtap = (text) => {
  expect(PGTAP.includes(text), `supabase/tests/scoped_settings.sql asserts ${text}`).toBe(true);
  return text;
};

const ORG = 'a1111111-1111-1111-1111-111111111111';
const ORG_B = 'b2222222-2222-2222-2222-222222222222';
const ALICE = '11111111-1111-1111-1111-111111111111';
const BOB = '22222222-2222-2222-2222-222222222222';
const SEASON = 'a1111111-1111-1111-1111-111111111aaa';
const OLD = 'a1111111-1111-1111-1111-00000005c0c0';
const P1 = 'a1111111-1111-1111-1111-00000005c001';
const PC = 'a1111111-1111-1111-1111-00000005c0c1';
const D1 = 'a1111111-1111-1111-1111-00000005c101';
const D2 = 'a1111111-1111-1111-1111-00000005c102';
const D3 = 'a1111111-1111-1111-1111-00000005c103';
const DC = 'a1111111-1111-1111-1111-00000005c0c2';
const U10 = 'a1111111-1111-1111-1111-11111111abcd';
const B10 = 'b2222222-2222-2222-2222-22222222bcde';
const KEY = 'standings_count_outside_results';

/** The pgTAP file's seed, as the mock holds it. */
function world() {
  const division = (id, org, season, name, program = null, extra = {}) => ({
    id,
    organization_id: org,
    season_settings_id: season,
    name,
    program_id: program,
    practices_per_week: 1,
    practice_minutes: null,
    ...extra,
  });
  const db = /** @type {any} */ ({
    organizations: [
      { id: ORG, name: 'Org A', feature_flags: {} },
      { id: ORG_B, name: 'Org B', feature_flags: {} },
    ],
    organization_members: [
      { organization_id: ORG, profile_id: ALICE, role: 'admin' },
      { organization_id: ORG_B, profile_id: BOB, role: 'admin' },
    ],
    season_settings: [
      {
        id: SEASON,
        organization_id: ORG,
        name: 'Org A Spring 2026',
        status: 'active',
        season_year: 2026,
      },
      {
        id: OLD,
        organization_id: ORG,
        name: 'Org A Scope Old',
        status: 'completed',
        season_year: 2024,
      },
      {
        id: 'b-season',
        organization_id: ORG_B,
        name: 'Org B Spring 2026',
        status: 'active',
        season_year: 2026,
      },
    ],
    programs: [
      {
        id: P1,
        organization_id: ORG,
        season_settings_id: SEASON,
        name: 'Juniors',
        is_default: false,
      },
      {
        id: PC,
        organization_id: ORG,
        season_settings_id: OLD,
        name: 'Old Juniors',
        is_default: false,
      },
    ],
    divisions: [
      division(U10, ORG, SEASON, 'Org A U10'),
      division(D1, ORG, SEASON, 'Scope U9', P1, { max_roster_size: 14, min_roster_size: 9 }),
      division(D3, ORG, SEASON, 'Scope U11', P1),
      division(D2, ORG, SEASON, 'Scope U8'),
      division(DC, ORG, OLD, 'Old U9', PC),
      division(B10, ORG_B, 'b-season', 'Org B U10'),
    ],
    audit_log: [],
    scoped_settings: [],
  });
  normalizePrograms(db);
  return db;
}

let counter = 0;
const ctxFor = (db, user) => ({
  currentUserId: user,
  isOrgAdmin: (org) =>
    (db.organization_members || []).some(
      (m) =>
        String(m.organization_id) === String(org) && m.profile_id === user && m.role === 'admin'
    ),
  newId: () => `id-${++counter}`,
});

/** The setter's answer as the pgTAP file's `pg_temp.set` writes it. */
function set(db, user, scope, id, value, key = KEY) {
  const r = handleScopedSettingRpc(
    db,
    'admin_set_scoped_setting',
    { p_key: key, p_scope: scope, p_scope_id: id, p_value: value },
    ctxFor(db, user)
  );
  if (r.error) return `${r.error.code}:${r.error.details ?? ''}`;
  const j = (v) => (v === null || v === undefined ? 'null' : JSON.stringify(v));
  return `changed=${r.data.changed} old=${j(r.data.previous)} new=${j(r.data.current)}`;
}
const audits = (db) =>
  db.audit_log.filter(
    (a) => a.action === 'settings.updated' && a.resource_type === 'scoped_setting'
  ).length;

describe('mock :: admin_set_scoped_setting, against the pgTAP cases', () => {
  it('refuses as the database does, and every refusal writes nothing', () => {
    const db = world();
    expect(set(db, null, 'division', D1, true)).toBe(inPgtap('42501:'));
    expect(set(db, '33333333-3333-3333-3333-333333333333', 'division', D1, true)).toBe('42501:');
    expect(set(db, BOB, 'division', D1, true)).toBe('42501:');
    expect(set(db, BOB, 'organization', ORG, true)).toBe('42501:');
    expect(set(db, ALICE, 'division', '00000000-0000-0000-0000-00000000dead', true)).toBe('42501:');
    expect(set(db, ALICE, 'season', SEASON, true)).toBe(inPgtap('22023:scope_invalid'));
    const defaultProgram = db.programs.find((p) => p.season_settings_id === SEASON && p.is_default);
    expect(set(db, ALICE, 'program', defaultProgram.id, true)).toBe(
      inPgtap('22023:default_program')
    );
    expect(set(db, ALICE, 'program', PC, true)).toBe(inPgtap('22023:season_completed'));
    expect(set(db, ALICE, 'division', DC, true)).toBe('22023:season_completed');
    expect(set(db, ALICE, 'division', D1, true, 'no_such_setting')).toBe(
      inPgtap('22023:unknown_setting')
    );
    expect(set(db, ALICE, 'division', D1, 'true')).toBe(inPgtap('22023:setting_value_invalid'));
    expect(`${db.scoped_settings.length} ${audits(db)}`).toBe(inPgtap("'0 0'").slice(1, -1));
  });

  it('set, change, the same again, unset: one audit row per change, with the value before and after', () => {
    const db = world();
    expect(set(db, ALICE, 'division', D1, true)).toBe(inPgtap('changed=true old=null new=true'));
    expect(audits(db)).toBe(1);
    const row = db.audit_log.at(-1);
    expect(
      [
        row.metadata.setting,
        row.metadata.field,
        row.metadata.scope,
        JSON.stringify(row.metadata.old),
        JSON.stringify(row.metadata.new),
        row.metadata.scope_name,
        row.resource_id,
      ].join(' ')
    ).toBe(
      inPgtap(
        'scoped_setting standings_count_outside_results division null true Scope U9 a1111111-1111-1111-1111-00000005c101'
      )
    );
    expect(set(db, ALICE, 'division', D1, false)).toBe(inPgtap('changed=true old=true new=false'));
    expect(set(db, ALICE, 'division', D1, false)).toBe(
      inPgtap('changed=false old=false new=false')
    );
    expect(audits(db)).toBe(2);
    expect(set(db, ALICE, 'division', D1, null)).toBe(inPgtap('changed=true old=false new=null'));
    expect(`${db.scoped_settings.filter((r) => r.division_id === D1).length} ${audits(db)}`).toBe(
      inPgtap("'0 3'").slice(1, -1)
    );
    expect(set(db, BOB, 'division', B10, true)).toBe('changed=true old=null new=true');
  });
});

describe('mock :: the rollover copies program and division values (admin_create_season_from)', () => {
  it('copies three, finds the copies, leaves the organization value and the default program alone', () => {
    const db = world();
    set(db, ALICE, 'program', P1, true);
    set(db, ALICE, 'organization', ORG, false);
    set(db, ALICE, 'division', D1, false);
    set(db, ALICE, 'division', D2, true);
    const r = handleSeasonRpc(
      db,
      'admin_create_season_from',
      { p_source_season_id: SEASON, p_name: 'Org A Scope Next', p_season_year: 2027 },
      ctxFor(db, ALICE)
    );
    expect(r.error).toBe(null);
    expect(String(r.data.scoped_settings_copied)).toBe(inPgtap("'3'").slice(1, -1));
    const next = r.data.id;
    const copyOfP1 = db.programs.find(
      (p) => p.season_settings_id === next && p.copied_from_program_id === P1
    );
    expect(db.scoped_settings.find((s) => s.program_id === copyOfP1.id)?.value).toBe(true);
    const divisionValues = db.scoped_settings
      .filter((s) => s.division_id)
      .map((s) => ({ s, d: db.divisions.find((d) => d.id === s.division_id) }))
      .filter(({ d }) => d.season_settings_id === next)
      .map(({ s, d }) => `${d.name}=${s.value}`)
      .sort()
      .join(',');
    expect(divisionValues).toBe(inPgtap('Scope U8=true,Scope U9=false'));
    expect(db.scoped_settings.filter((s) => !s.program_id && !s.division_id)).toHaveLength(1);
    const audit = db.audit_log.find((a) => a.action === 'season.created_from');
    expect(audit.metadata.scoped_settings_copied).toBe(3);
  });
});

describe('mock :: the standings seam follows the cascade', () => {
  it('a division’s own value, else its program’s, else the organization’s', () => {
    const db = world();
    set(db, ALICE, 'program', P1, true);
    set(db, ALICE, 'organization', ORG, false);
    set(db, ALICE, 'division', D1, false);
    set(db, ALICE, 'division', D2, true);
    const read = () =>
      db.divisions
        .filter((d) => d.season_settings_id === SEASON)
        .map((d) => `${d.name}=${scopedValueForDivision(db, d.id, KEY)}`)
        .sort()
        .join(',');
    expect(read()).toBe(inPgtap('Org A U10=false,Scope U11=true,Scope U8=true,Scope U9=false'));
    set(db, ALICE, 'organization', ORG, true);
    expect(read()).toBe(inPgtap('Org A U10=true,Scope U11=true,Scope U8=true,Scope U9=false'));
  });
});

describe('mock :: admin_set_division_practice_settings', () => {
  const practice = (db, user, division, ppw, minutes) =>
    handleScopedSettingRpc(
      db,
      'admin_set_division_practice_settings',
      { p_division_id: division, p_practices_per_week: ppw, p_practice_minutes: minutes },
      ctxFor(db, user)
    );

  it('changes only the two practice columns, null keeps, 0 clears, and refuses as the database does', () => {
    const db = world();
    Object.assign(
      db.divisions.find((d) => d.id === D1),
      { min_teams: 2, max_teams: 4 }
    );
    expect(practice(db, ALICE, D1, 2, 60).data.changed).toBe(true);
    const d1 = db.divisions.find((d) => d.id === D1);
    expect(
      [
        d1.practices_per_week,
        d1.practice_minutes,
        d1.max_roster_size,
        d1.min_roster_size,
        d1.min_teams,
        d1.max_teams,
      ].join(' ')
    ).toBe(inPgtap('2 60 14 9 2 4'));
    expect(practice(db, ALICE, D1, null, 0).data.changed).toBe(true);
    expect(`${d1.practices_per_week} ${d1.practice_minutes ?? 'any'}`).toBe('2 any');
    expect(practice(db, ALICE, D1, null, null).data.changed).toBe(false);
    const rows = db.audit_log.filter((a) => a.resource_type === 'division');
    expect(rows).toHaveLength(2);
    expect(rows.every((a) => !Object.hasOwn(a.metadata.current, 'max_roster_size'))).toBe(true);
    expect(rows[0].metadata.previous.practices_per_week).toBe(1);
    expect(practice(db, ALICE, D1, 8, null).error.code).toBe('23514');
    expect(practice(db, ALICE, D1, null, 10).error.code).toBe('23514');
    expect(practice(db, ALICE, DC, 2, null).error.details).toBe('season_completed');
    expect(practice(db, ALICE, B10, 2, null).error.code).toBe('42501');
    expect(practice(db, null, D1, 3, null).error.code).toBe('42501');
    expect(`${d1.practices_per_week} ${d1.practice_minutes ?? 'any'}`).toBe(inPgtap('2 any'));
  });
});

describe('mock :: a deleted program takes its values with it (S8)', () => {
  it('the program’s row goes; its divisions follow the organization; a division’s own value still wins', () => {
    const db = world();
    set(db, ALICE, 'program', P1, false);
    set(db, ALICE, 'organization', ORG, true);
    set(db, ALICE, 'division', D1, false);
    const r = handleProgramRpc(
      db,
      'admin_delete_program',
      { p_program_id: P1 },
      {
        ...ctxFor(db, ALICE),
        markDeleted: () => {},
      }
    );
    expect(r.error).toBe(null);
    expect(db.scoped_settings.filter((s) => s.program_id === P1)).toHaveLength(0);
    expect(`${scopedValueForDivision(db, D3, KEY)} ${scopedValueForDivision(db, D1, KEY)}`).toBe(
      inPgtap('true false')
    );
  });
});

describe('mock :: an organization change holds a completed season’s history (the freeze)', () => {
  it('holds the inheriting completed divisions at their value, counts them, and leaves one with its own value', () => {
    const db = world();
    // The completed season: Old U9 (in Old Juniors, which has no value), Old U8 and Old U10 (no program), Old U10 with
    // its own true; the organization is false.
    db.divisions.push(
      {
        id: 'dc3',
        organization_id: ORG,
        season_settings_id: OLD,
        name: 'Old U8',
        program_id: null,
      },
      {
        id: 'dc4',
        organization_id: ORG,
        season_settings_id: OLD,
        name: 'Old U10',
        program_id: null,
      }
    );
    normalizePrograms(db);
    db.scoped_settings.push({
      id: 'own',
      organization_id: ORG,
      program_id: null,
      division_id: 'dc4',
      key: KEY,
      value: true,
    });
    expect(set(db, ALICE, 'organization', ORG, false)).toBe('changed=true old=null new=false');
    expect(db.scoped_settings.filter((r) => r.frozen_from_organization)).toHaveLength(0);
    const r = handleScopedSettingRpc(
      db,
      'admin_set_scoped_setting',
      { p_key: KEY, p_scope: 'organization', p_scope_id: ORG, p_value: true },
      ctxFor(db, ALICE)
    );
    expect(String(r.data.frozen_completed_divisions)).toBe(inPgtap("'2'").slice(1, -1));
    expect(db.audit_log.at(-1).metadata.frozen_completed_divisions).toBe(2);
    const completed = db.divisions
      .filter((d) => d.season_settings_id === OLD)
      .map((d) => `${d.name}=${scopedValueForDivision(db, d.id, KEY)}`)
      .sort()
      .join(',');
    expect(completed).toBe(inPgtap('Old U10=true,Old U8=false,Old U9=false'));
    expect(scopedValueForDivision(db, U10, KEY)).toBe(true);
    expect(
      db.scoped_settings.find((x) => x.division_id === 'dc4').frozen_from_organization
    ).toBeUndefined();
  });

  it('a season made from the completed one copies the own value and not the frozen ones', () => {
    const db = world();
    db.divisions.push({
      id: 'dc4',
      organization_id: ORG,
      season_settings_id: OLD,
      name: 'Old U10',
      program_id: null,
    });
    normalizePrograms(db);
    db.scoped_settings.push({
      id: 'own',
      organization_id: ORG,
      program_id: null,
      division_id: 'dc4',
      key: KEY,
      value: true,
    });
    set(db, ALICE, 'organization', ORG, true);
    const r = handleSeasonRpc(
      db,
      'admin_create_season_from',
      { p_source_season_id: OLD, p_name: 'Org A Scope Old Next', p_season_year: 2025 },
      ctxFor(db, ALICE)
    );
    expect(String(r.data.scoped_settings_copied)).toBe(inPgtap("'1'").slice(1, -1));
  });
});

describe('mock :: the rollover refuses a value it cannot copy, as the SQL’s count check does', () => {
  it('returns XX000 with the SQL’s words and writes nothing', () => {
    const db = world();
    set(db, ALICE, 'division', D1, true);
    const before = JSON.stringify(db.scoped_settings);
    // A target season with no copies: the row of the source's division finds none.
    const out = copyScopedSettingsForRollover(db, SEASON, 'no-such-season', { newId: () => 'x' });
    expect(out.error).toEqual({
      code: 'XX000',
      message: `season ${SEASON} was not copied whole: 0 of its scoped settings found their copy`,
    });
    expect(JSON.stringify(db.scoped_settings)).toBe(before);
    const migration = readFileSync(
      path.join(process.cwd(), 'supabase/migrations/20261124010000_settings_scope.sql'),
      'utf8'
    );
    expect(migration).toContain(
      "RAISE EXCEPTION 'season % was not copied whole: % of its scoped settings found their copy'"
    );
  });

  it('through admin_create_season_from, the refusal puts the season, programs and divisions back', () => {
    const db = world();
    set(db, ALICE, 'division', D1, true);
    // A source division renamed under the copy would lose its value: simulated by a row naming a division of the source
    // season that the copy cannot find (its name is changed after the divisions are copied, by a wrapped push).
    const push = db.divisions.push.bind(db.divisions);
    db.divisions.push = (...rows) =>
      push(...rows.map((r) => (r.name === 'Scope U9' ? { ...r, name: 'Renamed' } : r)));
    const counts = () =>
      `${db.season_settings.length} ${db.programs.length} ${db.divisions.length}`;
    const before = counts();
    const r = handleSeasonRpc(
      db,
      'admin_create_season_from',
      { p_source_season_id: SEASON, p_name: 'Org A Scope Next', p_season_year: 2027 },
      ctxFor(db, ALICE)
    );
    expect(r.error?.code).toBe('XX000');
    expect(counts()).toBe(before);
  });
});

describe('mock :: what a client sends for "inherit"', () => {
  it('p_value null or left out is inherit: PostgREST reads a JSON null argument as SQL NULL (json_to_record)', () => {
    const db = world();
    set(db, ALICE, 'division', D1, true);
    expect(set(db, ALICE, 'division', D1, null)).toBe('changed=true old=true new=null');
    set(db, ALICE, 'division', D1, true);
    expect(set(db, ALICE, 'division', D1, undefined)).toBe('changed=true old=true new=null');
    // The SQL's refusal of a JSON 'null' value (not reachable from a client) is pgTAP's: a JSON null is refused.
    expect(PGTAP).toContain(
      "'22023:setting_value_invalid', 'a JSON null (not \"inherit\"): refused'"
    );
  });
});
