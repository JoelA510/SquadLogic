// The mock client applies migration 20261021020000's SELECT policies to its
// generic `.from(table)` reads, and its rotate_calendar_token and
// update_game_score arms refuse whom the database refuses, so a page that still
// reads a restricted table directly, or offers an action the server refuses,
// fails in mock mode and in the E2E suite as it would against Postgres.
import { beforeEach, describe, expect, it } from 'vitest';
import { getMockData, mockSupabase as supabase } from '../frontend/src/lib/mockSupabaseClient.js';
import { MOCK_ORG_ID } from '../frontend/src/lib/mockSeedIds.js';

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
  it('shows a guardian their own children and no other player', async () => {
    setSession('mock-admin-id');
    await supabase.from('teams').update({ name: 'Tigers' }).eq('id', TIGERS);
    const db = /** @type {any} */ (window.__MOCK_DB__);
    db.players.push({ id: 'player-other', organization_id: ORG, first_name: 'Other' });
    db.team_players.push({ team_id: TIGERS, player_id: 'player-other', organization_id: ORG });
    window.__saveMockDB__(db);
    expect(await read('players'), 'the unrelated player was not seeded').toContain('player-other');
    setSession('mock-parent-id');

    expect(await read('players')).toEqual(['player-1', 'player-2']);
    expect(await read('team_players', 'player_id')).toEqual(['player-1', 'player-2']);
    expect(await read('profile_players', 'player_id')).toEqual(['player-1', 'player-2']);
  });

  it('shows a removed guardian nothing of their child', async () => {
    setSession('mock-admin-id');
    const { error } = await supabase.rpc('admin_remove_member', {
      p_organization_id: ORG,
      p_profile_id: 'mock-parent-id',
    });
    expect(error).toBeNull();
    setSession('mock-parent-id');

    expect(await read('players')).toEqual([]);
    expect(await read('team_players', 'player_id')).toEqual([]);
  });

  it('shows a coach their own coach row and assignments, and no roster', async () => {
    setSession('mock-coach-id');

    expect(await read('coaches')).toEqual(['mock-coach-id']);
    expect(await read('team_coach_assignments')).toEqual(
      getMockData('team_coach_assignments')
        .filter((row) => row.coach_id === 'mock-coach-id')
        .map((row) => String(row.id))
        .sort()
    );
    expect(await read('players')).toEqual([]);
    expect(await read('staging_players')).toEqual([]);
    expect(await read('staging_import_rows')).toEqual([]);
  });

  it('shows a team s calendar token to its guardian and admin, not to another team s coach', async () => {
    setSession('mock-parent-id');
    expect(await read('team_calendar_tokens', 'team_id')).toEqual([TIGERS]);
    setSession('mock-coach-id');
    expect(await read('team_calendar_tokens', 'team_id')).toEqual([]);
    setSession('mock-admin-id');
    expect(await read('team_calendar_tokens', 'team_id')).toEqual([TIGERS]);
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
  it('rotates for the team s current coach and an admin only', async () => {
    setSession('mock-parent-id');
    const guardian = await supabase.rpc('rotate_calendar_token', { p_team_id: TIGERS });
    expect(guardian.data).toEqual({ status: 'error', message: 'Access denied' });

    setSession('mock-coach-id');
    const otherCoach = await supabase.rpc('rotate_calendar_token', { p_team_id: TIGERS });
    expect(otherCoach.data?.status).toBe('error');
    const ownCoach = await supabase.rpc('rotate_calendar_token', { p_team_id: 't1' });
    expect(ownCoach.data?.status).toBe('success');
    expect(getMockData('team_calendar_tokens').find((row) => row.team_id === 't1')?.token).toBe(
      ownCoach.data.calendar_token
    );

    setSession('mock-admin-id');
    const admin = await supabase.rpc('rotate_calendar_token', { p_team_id: TIGERS });
    expect(admin.data?.status).toBe('success');
    expect(
      getMockData('team_calendar_tokens').filter((row) => row.team_id === TIGERS)
    ).toHaveLength(1);
  });

  it('scores a game for a current coach of either team, and refuses anyone else', async () => {
    const score = (gameId) =>
      supabase.rpc('update_game_score', {
        p_organization_id: ORG,
        p_game_id: gameId,
        p_score_home: 3,
        p_score_away: 0,
      });

    setSession('mock-parent-id');
    expect((await score('game-2')).error?.code).toBe('42501');

    setSession('mock-coach-id');
    const own = await score('game-2');
    expect(own.error).toBeNull();
    expect(getMockData('games').find((g) => g.id === 'game-2')?.score_home).toBe(3);

    const db = /** @type {any} */ (window.__MOCK_DB__);
    db.games.push({
      id: 'game-other',
      organization_id: ORG,
      home_team_id: 't2',
      away_team_id: TIGERS,
      start_time: new Date().toISOString(),
    });
    window.__saveMockDB__(db);
    expect((await score('game-other')).error?.code).toBe('42501');
  });
});

describe('mock .or() :: an in-list with several values', () => {
  it('reads every value of an in-list, as the Scores page filters a coach s games', async () => {
    // Split on every comma, `home_team_id.in.(zzz,t2)` became the clauses
    // `home_team_id.in.(zzz` and `t2)`, and a coach of two teams matched none.
    const { data, error } = await supabase
      .from('games')
      .select('*')
      .or('home_team_id.in.(zzz,t1),away_team_id.in.(zzz,yyy)');
    expect(error).toBeNull();
    const seeded = getMockData('games').filter((g) => g.home_team_id === 't1');
    expect(seeded.length, 'no seeded game is home to t1, so this matches nothing').toBeGreaterThan(
      0
    );
    expect((data || []).map((g) => g.id).sort()).toEqual(seeded.map((g) => g.id).sort());
  });
});
