// The mock client applies migration 20261021020000's SELECT policies to its
// generic `.from(table)` reads, and its rotate_calendar_token and
// update_game_score arms refuse whom the database refuses (update_game_score is
// an admin's behind the score entry setting since 20261028010000, R6), so a page that still
// reads a restricted table directly, or offers an action the server refuses,
// fails in mock mode and in the E2E suite as it would against Postgres. Since
// 20261024010000 (R3) there is no guardian, and since docs/changes/2026-10-27-admin-only.md no
// coach signs in: every restricted table is an admin's, and a signed-in account with no
// membership (what a coach's account is now) reads none of it.
import { beforeEach, describe, expect, it } from 'vitest';
import { getMockData, mockSupabase as supabase } from '../frontend/src/lib/mockSupabaseClient.js';
import { MOCK_ORG_ID } from '../frontend/src/lib/mockSeedIds.js';
import { seedMockDb } from './helpers/seedMockDb.js';

const ORG = MOCK_ORG_ID;
const TIGERS = '00000000-0000-0000-0000-000000000001';

const setSession = (userId) => {
  sessionStorage.setItem('__MOCK_SESSION__', JSON.stringify({ user: { id: userId } }));
};

const read = async (table, column = 'id') => {
  const { data, error } = await supabase.from(table).select('*');
  expect(error).toBeNull();
  return (data || []).map((row) => String(row[column])).sort();
};

beforeEach(() => {
  sessionStorage.clear();
  delete window.__MOCK_DB__;
});

describe('mock read policies :: the restricted tables', () => {
  it('shows players and roster rows to an admin only, not to a non-member', async () => {
    setSession('mock-admin-id');
    await supabase.from('teams').update({ name: 'Tigers' }).eq('id', TIGERS);
    const db = /** @type {any} */ (window.__MOCK_DB__);
    // A player on team t1, so the non-member's empty read below is the policy's doing, not an
    // empty roster.
    db.team_players.push({ team_id: 't1', player_id: 'player-1', organization_id: ORG });
    window.__saveMockDB__(db);
    expect(await read('team_players', 'team_id'), 'nothing is rostered on team t1').toContain('t1');
    expect(await read('players')).toEqual(
      getMockData('players')
        .map((row) => String(row.id))
        .sort()
    );

    setSession('mock-coach-id');
    expect(await read('players')).toEqual([]);
    expect(await read('team_players', 'player_id')).toEqual([]);
  });

  it('shows a non-member no coach row, assignment, staging row or permit, though the data exists', async () => {
    setSession('mock-admin-id');
    // Non-vacuous: the admin reads every one of these.
    expect((await read('coaches')).length).toBeGreaterThan(0);
    expect((await read('team_coach_assignments')).length).toBeGreaterThan(0);

    setSession('mock-coach-id');
    expect(await read('coaches')).toEqual([]);
    expect(await read('team_coach_assignments')).toEqual([]);
    expect(await read('staging_players')).toEqual([]);
    expect(await read('staging_import_rows')).toEqual([]);
    expect(await read('facility_permits')).toEqual([]);
  });

  it('shows a removed member nothing they read before', async () => {
    setSession('mock-admin-id');
    seedMockDb({
      organization_members: [{ organization_id: ORG, profile_id: 'm2', role: 'staff' }],
    });
    setSession('m2');
    expect((await read('coaches')).length).toBeGreaterThan(0);
    setSession('mock-admin-id');
    const { error } = await supabase.rpc('admin_remove_member', {
      p_organization_id: ORG,
      p_profile_id: 'm2',
    });
    expect(error).toBeNull();
    setSession('m2');

    expect(await read('coaches')).toEqual([]);
    expect(await read('team_coach_assignments')).toEqual([]);
  });

  it('shows a team s calendar token to an admin, not to a non-member', async () => {
    setSession('mock-admin-id');
    await supabase.from('teams').update({ name: 'Tigers' }).eq('id', TIGERS);
    const db = /** @type {any} */ (window.__MOCK_DB__);
    db.team_calendar_tokens.push({ team_id: 't1', token: 'mock-calendar-token-t1' });
    window.__saveMockDB__(db);
    expect(await read('team_calendar_tokens', 'team_id')).toEqual([TIGERS, 't1'].sort());
    setSession('mock-coach-id');
    expect(await read('team_calendar_tokens', 'team_id')).toEqual([]);
  });

  it('shows an admin every row', async () => {
    setSession('mock-admin-id');
    for (const table of ['players', 'coaches', 'team_coach_assignments', 'staging_players']) {
      expect(await read(table), table).toEqual(
        getMockData(table)
          .map((row) => String(row.id))
          .sort()
      );
    }
  });
});

describe('mock rotate_calendar_token and update_game_score :: who may', () => {
  it('rotates for an admin only, not for the team s own coach', async () => {
    // The seeded coach of t1 signs in with no membership: refused, token untouched.
    setSession('mock-coach-id');
    const before = getMockData('team_calendar_tokens').find((row) => row.team_id === 't1')?.token;
    for (const team of [TIGERS, 't1']) {
      const refused = await supabase.rpc('rotate_calendar_token', { p_team_id: team });
      expect(refused.data).toEqual({ status: 'error', message: 'Access denied' });
    }
    expect(getMockData('team_calendar_tokens').find((row) => row.team_id === 't1')?.token).toBe(
      before
    );

    setSession('mock-admin-id');
    const admin = await supabase.rpc('rotate_calendar_token', { p_team_id: TIGERS });
    expect(admin.data?.status).toBe('success');
    expect(
      getMockData('team_calendar_tokens').filter((row) => row.team_id === TIGERS)
    ).toHaveLength(1);
  });

  // Admin focus R6 (20261028010000): score entry is an admin's, behind the
  // league's `score_entry` setting (off unless set; 55000 while it is off). Since F11-3 a score names a SAVED game
  // (20261122010000): the game is seeded into the season's current game run.
  it('scores a game for an admin only, and only while score entry is on', async () => {
    const GAME = 'ga-policy';
    const run = getMockData('scheduler_runs').find(
      (r) => r.run_type === 'game' && r.status === 'completed'
    );
    expect(run, 'the seed has a completed game run').toBeTruthy();
    seedMockDb({
      game_assignments: [
        {
          id: GAME,
          organization_id: ORG,
          run_id: run.id,
          home_team_id: 't1',
          away_team_id: 't2',
          week_index: 1,
        },
      ],
    });
    const stored = () => getMockData('game_scores').find((row) => row.game_id === GAME);
    const score = (gameId) =>
      supabase.rpc('update_game_score', {
        p_organization_id: ORG,
        p_game_id: gameId,
        p_score_home: 3,
        p_score_away: 0,
      });

    setSession('mock-admin-id');
    const off = await score(GAME);
    expect(off.error?.code).toBe('55000');
    expect(stored()).toBeUndefined();

    // Turned on as the settings page does it, through the audited RPC.
    const flags = await supabase.rpc('update_org_feature_flags', {
      p_org_id: ORG,
      p_flags: { score_entry: true },
    });
    expect(flags.error).toBeNull();

    setSession('mock-outsider-id');
    expect((await score(GAME)).error?.code).toBe('42501');
    // A coach's account (a non-member) is refused too.
    setSession('mock-coach-id');
    expect((await score(GAME)).error?.code).toBe('42501');
    expect(stored()).toBeUndefined();
    // Nor may a non-member turn the setting on.
    expect(
      (await supabase.rpc('update_org_feature_flags', { p_org_id: ORG, p_flags: {} })).error
    ).toBeTruthy();

    setSession('mock-admin-id');
    const own = await score(GAME);
    expect(own.error).toBeNull();
    expect(stored()?.score_home).toBe(3);
  });
});

describe('mock .or() :: an in-list with several values', () => {
  it('reads every value of an in-list', async () => {
    // Split on every comma, `id.in.(zzz,t1)` became the clauses `id.in.(zzz` and `t1)`, and a filter on
    // two ids matched none.
    const { data, error } = await supabase
      .from('teams')
      .select('*')
      .or('id.in.(zzz,t1),name.in.(zzz,yyy)');
    expect(error).toBeNull();
    const seeded = getMockData('teams').filter((team) => team.id === 't1');
    expect(seeded.length, 'no seeded team is t1, so this matches nothing').toBeGreaterThan(0);
    expect((data || []).map((team) => team.id).sort()).toEqual(
      seeded.map((team) => team.id).sort()
    );
  });
});
