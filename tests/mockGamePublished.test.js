/**
 * PR 1 task A4 of the schedule expansion (docs/changes/2026-11-03-schedule-expansion.md): the mock client's twin of
 * the Published switch (migration 20261119010000), held to the pure helper by ONE input that reaches every outcome
 * (lesson 77). `frontend/src/lib/mockGamePublished.js` repeats the helper's lists on purpose and imports none of it,
 * so this test compares two implementations, not a function with itself.
 *
 * Three twins, each over one table of cases:
 *   - the switch's payload checks (reasons, note, scope, ids, which way): the mock's DETAIL against the helper's code;
 *   - the guard's column list, on the mock's direct writes, against `changesPublishedPlacement`;
 *   - the state the helper cannot judge (a user, an admin, an id, an organization, a completed season), against the
 *     SQL's outcome, written out.
 * A meta-assertion requires every outcome to have been reached (a table that reaches nothing compares zeros).
 *
 * Not mirrored, and said: persist_game_schedule (no mock arm; the omission rule is pgTAP's and the helper's), the
 * trigger's exemptions, row locks, the SLA01 rollback.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import {
  GAME_PUBLISH_REASON_CODES,
  PUBLISHED_GUARDED_FIELDS,
  changesPublishedPlacement,
  setGamesPublishedRefusal,
} from '@squadlogic/core/gamePublished.js';
import { getMockData, mockSupabase as supabase } from '../frontend/src/lib/mockSupabaseClient.js';
import { MOCK_ORG_ID, MOCK_SEASON_ID } from '../frontend/src/lib/mockSeedIds.js';

const OTHER_ORG = 'gp-other-org';
const OTHER_SEASON = 'gp-other-season';
const DONE = 'gp-season-done';
const DIV = 'gp-div';
const DIV_DONE = 'gp-div-done';
const DIV_OTHER = 'gp-div-other';
const T = ['gp-t1', 'gp-t2', 'gp-t3', 'gp-t4', 'gp-t5', 'gp-t6'];
const P = 'gp-game-published';
const U = 'gp-game-twin';
const C = 'gp-game-completed';
const R = 'gp-game-other-org';

const game = (id, org, home, away, week, extra = {}) => ({
  id,
  organization_id: org,
  home_team_id: home,
  away_team_id: away,
  game_slot_id: `slot-${id}`,
  slot_id: `slot-${id}`,
  field_id: 'gp-field-1',
  week_index: week,
  start: '2026-04-04T08:00:00Z',
  end: '2026-04-04T09:00:00Z',
  run_id: 'gp-run',
  assignment_source: 'auto',
  division: 'GP U10',
  published: false,
  ...extra,
});

const seed = () => {
  sessionStorage.clear();
  window.__saveMockDB__({
    ...window.__MOCK_DB__,
    organizations: [
      ...getMockData('organizations').filter((o) => o.id !== OTHER_ORG),
      { id: OTHER_ORG, name: 'Other', is_onboarded: true },
    ],
    organization_members: [
      ...getMockData('organization_members').filter((m) => m.organization_id !== OTHER_ORG),
      { organization_id: OTHER_ORG, profile_id: 'gp-other-admin', role: 'admin' },
    ],
    profiles: [...getMockData('profiles'), { id: 'mock-admin-id', full_name: 'Mock Admin A' }],
    season_settings: [
      ...getMockData('season_settings').filter((s) => ![DONE, OTHER_SEASON].includes(s.id)),
      { id: DONE, organization_id: MOCK_ORG_ID, name: 'GP Old', status: 'completed' },
      { id: OTHER_SEASON, organization_id: OTHER_ORG, name: 'GP Other', status: 'active' },
    ],
    divisions: [
      ...getMockData('divisions'),
      { id: DIV, organization_id: MOCK_ORG_ID, season_settings_id: MOCK_SEASON_ID, name: 'GP U10' },
      { id: DIV_DONE, organization_id: MOCK_ORG_ID, season_settings_id: DONE, name: 'GP Old U10' },
      {
        id: DIV_OTHER,
        organization_id: OTHER_ORG,
        season_settings_id: OTHER_SEASON,
        name: 'GP Other U10',
      },
    ],
    teams: [
      { id: T[0], organization_id: MOCK_ORG_ID, division_id: DIV, name: 'GP One' },
      { id: T[1], organization_id: MOCK_ORG_ID, division_id: DIV, name: 'GP Two' },
      { id: T[2], organization_id: MOCK_ORG_ID, division_id: DIV, name: 'GP Three' },
      { id: T[3], organization_id: MOCK_ORG_ID, division_id: DIV, name: 'GP Four' },
      { id: T[4], organization_id: MOCK_ORG_ID, division_id: DIV_DONE, name: 'GP Five' },
      { id: T[5], organization_id: MOCK_ORG_ID, division_id: DIV_DONE, name: 'GP Six' },
      { id: 'gp-o1', organization_id: OTHER_ORG, division_id: DIV_OTHER, name: 'GP O1' },
      { id: 'gp-o2', organization_id: OTHER_ORG, division_id: DIV_OTHER, name: 'GP O2' },
    ],
    game_assignments: [
      game(P, MOCK_ORG_ID, T[0], T[1], 1, {
        published: true,
        published_at: '2026-03-01T00:00:00Z',
        published_by: 'someone',
      }),
      game(U, MOCK_ORG_ID, T[2], T[3], 1),
      game(C, MOCK_ORG_ID, T[4], T[5], 1),
      game(R, OTHER_ORG, 'gp-o1', 'gp-o2', 1, { published: true }),
    ],
    audit_log: [],
    games: [],
  });
  sessionStorage.setItem('__MOCK_SESSION__', JSON.stringify({ user: { id: 'mock-admin-id' } }));
};

const rpc = (name, params) => supabase.rpc(name, params);
const row = (id) => getMockData('game_assignments').find((r) => r.id === id);
const auditRows = (action) => getMockData('audit_log').filter((r) => r.action === action);
const asUser = (id) =>
  id === null
    ? sessionStorage.removeItem('__MOCK_SESSION__')
    : sessionStorage.setItem('__MOCK_SESSION__', JSON.stringify({ user: { id } }));

beforeEach(seed);

// ── The switch's payload checks: the mock's DETAIL against the helper's code ────────────────────────────────────
// One description per case, turned into the RPC's parameters and into the helper's input from the same fields.
const manyIds = (n) => Array.from({ length: n }, (_, i) => `gp-nope-${i}`);
const SHAPE_CASES = [
  { name: 'no ids', ids: [], published: true },
  { name: 'ids missing', ids: null, published: true },
  { name: 'a null id', ids: [U, null], published: true },
  { name: '2,401 ids', ids: manyIds(2401), published: true },
  { name: 'which way missing', ids: [U], published: null },
  { name: 'on, with a reason', ids: [U], published: true, reason: 'other' },
  { name: 'on, with a note', ids: [U], published: true, note: 'x' },
  { name: 'off, no reason', ids: [P], published: false },
  { name: 'off, blank reason', ids: [P], published: false, reason: '   ' },
  { name: 'off, unknown reason', ids: [P], published: false, reason: 'because' },
  {
    name: 'off, 201-character note',
    ids: [P],
    published: false,
    reason: 'other',
    note: 'n'.repeat(201),
  },
  {
    name: 'scope kind outside the list',
    ids: [P],
    published: false,
    reason: 'other',
    scope: { kind: 'nowhere' },
  },
  {
    name: 'scope with another key',
    ids: [P],
    published: false,
    reason: 'other',
    scope: { kind: 'all', extra: 1 },
  },
  {
    name: 'scope value not text',
    ids: [P],
    published: false,
    reason: 'other',
    scope: { kind: 'venue', value: 7 },
  },
  {
    name: 'scope value 101 characters',
    ids: [P],
    published: false,
    reason: 'other',
    scope: { kind: 'venue', value: 'v'.repeat(101) },
  },
  { name: 'on, plain', ids: [U], published: true },
  { name: 'on, blank reason and note', ids: [U], published: true, reason: '', note: '  ' },
  {
    name: 'on, with a scope',
    ids: [U],
    published: true,
    scope: { kind: 'division', value: 'GP U10' },
  },
  { name: 'on, a repeated id', ids: [U, U.toUpperCase()], published: true },
  ...GAME_PUBLISH_REASON_CODES.map((code) => ({
    name: `off, ${code}`,
    ids: [P],
    published: false,
    reason: code,
  })),
  {
    name: 'off, 200-character note',
    ids: [P],
    published: false,
    reason: 'other',
    note: 'n'.repeat(200),
  },
  { name: 'off, 200 emoji', ids: [P], published: false, reason: 'other', note: '😀'.repeat(200) },
];
const rpcParams = (c) => ({
  p_organization_id: MOCK_ORG_ID,
  p_assignment_ids: c.ids,
  p_published: c.published,
  p_reason_code: c.reason ?? null,
  p_note: c.note ?? null,
  p_scope: c.scope ?? null,
});
const helperInput = (c) => ({
  organizationId: MOCK_ORG_ID,
  assignmentIds: c.ids,
  published: c.published,
  reasonCode: c.reason ?? null,
  note: c.note ?? null,
  scope: c.scope ?? null,
});
const SHAPE_CODES = new Set([
  'ids_required',
  'ids_invalid',
  'too_many_ids',
  'published_required',
  'reason_only_when_off',
  'reason_required',
  'reason_unknown',
  'note_too_long',
  'scope_invalid',
]);

describe('the switch: the mock and the pure helper agree on every payload', () => {
  it('one table of cases reaches every outcome, and the two answers are the same', async () => {
    const outcomes = new Map();
    for (const c of SHAPE_CASES) {
      seed();
      const { data, error } = await rpc('admin_set_games_published', rpcParams(c));
      const mockCode = error ? error.details : null;
      const helperCode = setGamesPublishedRefusal(helperInput(c));
      // The helper judges shape only: where the mock answers a shape code the helper must say the same one, and
      // where the mock accepts, the helper must accept.
      expect(mockCode, c.name).toBe(helperCode);
      const outcome = mockCode ?? (data.changed > 0 ? 'changed' : 'unchanged');
      outcomes.set(outcome, (outcomes.get(outcome) ?? 0) + 1);
      if (!error) expect(error, c.name).toBeNull();
    }
    // Every outcome the table is for was reached, each by at least one case (not a table that compares zeros).
    for (const code of SHAPE_CODES) expect(outcomes.get(code) ?? 0, code).toBeGreaterThan(0);
    expect(outcomes.get('changed')).toBeGreaterThan(5);
    expect(outcomes.has('unchanged') || SHAPE_CASES.some((c) => c.ids?.length === 2)).toBe(true);
  });

  it('can fail: a helper that disagrees is caught (the comparison is not against itself)', () => {
    // The 201-character note is a refusal in both; a helper allowing 201 would read null where the mock says note_too_long.
    expect(
      setGamesPublishedRefusal(
        helperInput({ ids: [P], published: false, reason: 'other', note: 'n'.repeat(201) })
      )
    ).toBe('note_too_long');
    expect(
      setGamesPublishedRefusal(
        helperInput({ ids: [P], published: false, reason: 'other', note: 'n'.repeat(200) })
      )
    ).toBeNull();
  });
});

describe('the switch: what the helper cannot judge, against the SQL', () => {
  const call = (ids, published = true, reason = null, org = MOCK_ORG_ID) =>
    rpc('admin_set_games_published', {
      p_organization_id: org,
      p_assignment_ids: ids,
      p_published: published,
      p_reason_code: reason,
    });

  it('gates 1 to 3: a user, an admin (before the ids), existing ids of the organization', async () => {
    asUser(null);
    expect((await call([U])).error).toMatchObject({ code: '42501', details: 'signed_in_required' });
    asUser('gp-other-admin');
    expect((await call([U])).error).toMatchObject({ code: '42501', details: 'admin_required' });
    expect((await call(['gp-nope'])).error).toMatchObject({
      code: '42501',
      details: 'admin_required',
    });
    asUser('mock-admin-id');
    expect((await call(['gp-nope'])).error).toMatchObject({
      code: '23503',
      details: 'game_not_found',
    });
    expect((await call([R])).error).toMatchObject({
      code: '42501',
      details: 'game_other_organization',
    });
    expect((await call([U, R])).error).toMatchObject({
      code: '42501',
      details: 'game_other_organization',
    });
    expect(row(U).published).toBe(false);
  });

  it('gate 4: a completed season refuses what would change, and not what would not', async () => {
    expect((await call([C])).error).toMatchObject({ code: '22023', details: 'season_completed' });
    expect(row(C).published).toBe(false);
    expect((await call([C], false, 'other')).data).toEqual({ changed: 0, unchanged: 1, ids: [] });
    expect((await call([U, C])).error).toMatchObject({ details: 'season_completed' });
    expect(row(U).published).toBe(false);
  });

  it('gate 6 and the audit: unchanged is audited nowhere; a change writes the call row; off writes one row per game', async () => {
    expect((await call([P])).data).toEqual({ changed: 0, unchanged: 1, ids: [] });
    expect(auditRows('game.published_set')).toHaveLength(0);
    expect(auditRows('game.publish_overridden')).toHaveLength(0);

    const on = await rpc('admin_set_games_published', {
      ...rpcParams({ ids: [U, P], published: true }),
      p_scope: { kind: 'division', value: 'GP U10' },
    });
    expect(on.data).toEqual({ changed: 1, unchanged: 1, ids: [U] });
    expect(row(U)).toMatchObject({ published: true, published_by: 'mock-admin-id' });
    expect(row(U).published_at).toEqual(expect.any(String));
    expect(auditRows('game.published_set')).toHaveLength(1);
    expect(auditRows('game.published_set')[0].metadata).toEqual({
      published: true,
      scope: { kind: 'division', value: 'GP U10' },
      count: 1,
      unchanged: 1,
      ids: [U],
    });
    expect(auditRows('game.publish_overridden')).toHaveLength(0);

    const off = await rpc('admin_set_games_published', {
      ...rpcParams({
        ids: [P, U],
        published: false,
        reason: 'field-change',
        note: ' Field closed ',
      }),
    });
    expect(off.data).toEqual({ changed: 2, unchanged: 0, ids: [P, U].sort() });
    expect(row(P)).toMatchObject({
      published: false,
      published_at: '2026-03-01T00:00:00Z',
      published_by: 'someone',
    });
    const overrides = auditRows('game.publish_overridden');
    expect(overrides.map((r) => r.resource_id).sort()).toEqual([P, U].sort());
    const forP = overrides.find((r) => r.resource_id === P);
    expect(forP.metadata).toEqual({
      reason_code: 'field-change',
      scope: { kind: 'selection' },
      note: 'Field closed',
      before: {
        game_slot_id: `slot-${P}`,
        field_id: 'gp-field-1',
        home_team_id: T[0],
        away_team_id: T[1],
        week_index: 1,
        start: '2026-04-04T08:00:00Z',
        end: '2026-04-04T09:00:00Z',
      },
    });
    expect(auditRows('game.published_set').at(-1).metadata).toMatchObject({
      published: false,
      count: 2,
      reason_code: 'field-change',
    });
    expect(auditRows('game.published_set').at(-1).metadata).not.toHaveProperty('note');
  });

  it('the log: admin only, the two actions, the actor, call rows without their ids, capped', async () => {
    await call([U]);
    await rpc(
      'admin_set_games_published',
      rpcParams({ ids: [P], published: false, reason: 'other' })
    );
    const log = await rpc('get_schedule_audit_log', { p_organization_id: MOCK_ORG_ID });
    expect(log.error).toBeNull();
    expect(log.data.map((r) => r.action).sort()).toEqual([
      'game.publish_overridden',
      'game.published_set',
      'game.published_set',
    ]);
    expect(log.data.every((r) => r.actor_name === 'Mock Admin A')).toBe(true);
    expect(
      log.data.filter((r) => r.action === 'game.published_set').every((r) => !('ids' in r.metadata))
    ).toBe(true);
    expect(Object.keys(log.data[0])).not.toContainEqual(
      expect.stringMatching(/mail|phone|contact/i)
    );
    const forP = await rpc('get_schedule_audit_log', {
      p_organization_id: MOCK_ORG_ID,
      p_assignment_id: P,
    });
    expect(forP.data.map((r) => r.action).sort()).toEqual([
      'game.publish_overridden',
      'game.published_set',
    ]);
    expect(
      (await rpc('get_schedule_audit_log', { p_organization_id: MOCK_ORG_ID, p_limit: 1 })).data
    ).toHaveLength(1);
    asUser('gp-other-admin');
    expect(
      (await rpc('get_schedule_audit_log', { p_organization_id: MOCK_ORG_ID })).error
    ).toMatchObject({ code: '42501', details: 'admin_required' });
    asUser(null);
    expect(
      (await rpc('get_schedule_audit_log', { p_organization_id: MOCK_ORG_ID })).error
    ).toMatchObject({ code: '42501' });
  });
});

// ── The guard: the mock's direct writes against the helper's column test ─────────────────────────────────────────
describe('the guard: the mock and the pure helper agree on every column', () => {
  const NEW_VALUE = {
    game_slot_id: 'slot-other',
    slot_id: 'slot-other',
    field_id: 'gp-field-2',
    home_team_id: T[3],
    away_team_id: T[3],
    week_index: 2,
    start: '2026-04-04T08:30:00Z',
    end: '2026-04-04T09:30:00Z',
  };
  const UNGUARDED = {
    run_id: 'gp-run-2',
    assignment_source: 'manual',
    division: 'GP U10 (renamed)',
    updated_at: 'now',
  };
  const update = (id, patch) => supabase.from('game_assignments').update(patch).eq('id', id);

  it('refuses each guarded column of a Published game and takes the unpublished twin, as the helper says', async () => {
    let refused = 0;
    for (const field of PUBLISHED_GUARDED_FIELDS) {
      const patch = { [field]: NEW_VALUE[field] };
      const expectRefused = changesPublishedPlacement(row(P), { ...row(P), ...patch });
      expect(expectRefused, field).toBe(true);
      const result = await update(P, patch);
      expect(result.error, field).toMatchObject({ code: '22023', details: 'game_published' });
      refused += 1;
      expect((await update(U, patch)).error, `${field} on the twin`).toBeNull();
    }
    expect(refused).toBe(PUBLISHED_GUARDED_FIELDS.length);
    for (const [field, value] of Object.entries(UNGUARDED)) {
      expect(changesPublishedPlacement(row(P), { ...row(P), [field]: value }), field).toBe(false);
      expect((await update(P, { [field]: value })).error, field).toBeNull();
    }
    expect(row(P)).toMatchObject({
      field_id: 'gp-field-1',
      start: '2026-04-04T08:00:00Z',
      assignment_source: 'manual',
    });
  });

  it('judges the OLD row, takes an unchanged value and the same instant in another spelling', async () => {
    expect((await update(P, { published: false, field_id: 'gp-field-2' })).error).toMatchObject({
      details: 'game_published',
    });
    expect(row(P).published).toBe(true);
    expect((await update(P, { published: false })).error).toBeNull();
    expect(row(P).published).toBe(false);
    seed();
    expect(
      (await update(P, { field_id: 'gp-field-1', start: '2026-04-04T08:00:00Z' })).error
    ).toBeNull();
    expect((await update(P, { start: '2026-04-04T09:00:00+01:00' })).error).toBeNull();
    expect(
      changesPublishedPlacement(row(P), { ...row(P), start: '2026-04-04T09:00:00+01:00' })
    ).toBe(false);
  });

  it('refuses a delete and an upsert that moves a Published game; the twin goes', async () => {
    expect((await supabase.from('game_assignments').delete().eq('id', P)).error).toMatchObject({
      code: '22023',
      details: 'game_published',
    });
    expect(row(P)).toBeDefined();
    expect(
      (await supabase.from('game_assignments').upsert({ id: P, field_id: 'gp-field-2' })).error
    ).toMatchObject({ details: 'game_published' });
    expect(
      (await supabase.from('game_assignments').upsert({ id: P, run_id: 'gp-run-3' })).error
    ).toBeNull();
    expect((await supabase.from('game_assignments').delete().eq('id', U)).error).toBeNull();
    expect(row(U)).toBeUndefined();
  });

  it('refuses cancel and a team delete for a Published game and allows both once changes are allowed', async () => {
    expect((await rpc('admin_cancel_game_assignment', { p_assignment_id: P })).error).toMatchObject(
      { code: '22023', details: 'game_published' }
    );
    expect((await rpc('admin_delete_team', { p_team_id: T[0] })).error).toMatchObject({
      code: '22023',
      details: 'game_published',
    });
    expect((await rpc('admin_delete_team', { p_team_id: T[1] })).error.message).toMatch(
      /1 Published/
    );
    expect(row(P)).toBeDefined();
    expect((await rpc('admin_cancel_game_assignment', { p_assignment_id: U })).error).toBeNull();
    await rpc(
      'admin_set_games_published',
      rpcParams({ ids: [P], published: false, reason: 'other' })
    );
    expect((await rpc('admin_delete_team', { p_team_id: T[0] })).error).toBeNull();
    expect(getMockData('teams').map((t) => t.id)).not.toContain(T[0]);
  });
});
