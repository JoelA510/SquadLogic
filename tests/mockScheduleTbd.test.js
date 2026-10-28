// The mock arm for get_schedule_tbd mirrors the SQL's read, refusals included (LESSONS_LEARNED #13).
import { describe, expect, it } from 'vitest';
import { handleScheduleTbdRpc } from '../frontend/src/lib/mockScheduleTbd.js';

const db = {
  season_settings: [
    { id: 's1', organization_id: 'o1' },
    { id: 's2', organization_id: 'o2' },
  ],
  divisions: [{ id: 'd1', name: 'U8' }],
  teams: [
    { id: 't1', name: 'Alpha' },
    { id: 't2', name: 'Bravo' },
  ],
  schedule_tbd: [
    {
      id: 'g',
      organization_id: 'o1',
      season_settings_id: 's1',
      kind: 'game',
      division_id: 'd1',
      home_team_id: 't2',
      away_team_id: 't1',
      week_index: 3,
      reason: 'no-slot-available',
    },
    {
      id: 'p',
      organization_id: 'o1',
      season_settings_id: 's1',
      kind: 'practice',
      division_id: 'd1',
      team_id: 't1',
      missing_count: 2,
      reason: 'not-scheduled-yet',
    },
    {
      id: 'x',
      organization_id: 'o2',
      season_settings_id: 's2',
      kind: 'practice',
      division_id: 'd1',
      team_id: 't2',
      missing_count: 1,
      reason: 'not-scheduled-yet',
    },
  ],
};
const admin = (org) => org === 'o1';

describe('the mock get_schedule_tbd', () => {
  it('ignores any other RPC', () => {
    expect(handleScheduleTbdRpc(db, 'something_else', {}, { isOrgAdmin: admin })).toBeNull();
  });

  it("returns the season's rows with names, practices before games, and no other season's", () => {
    const { data, error } = handleScheduleTbdRpc(
      db,
      'get_schedule_tbd',
      { p_season_settings_id: 's1' },
      { isOrgAdmin: admin }
    );
    expect(error).toBeNull();
    expect(data.map((row) => row.id)).toEqual(['g', 'p']);
    expect(data[0]).toMatchObject({
      home_team_name: 'Bravo',
      away_team_name: 'Alpha',
      division_name: 'U8',
      week_index: 3,
    });
    expect(data[1]).toMatchObject({ team_name: 'Alpha', missing_count: 2 });
  });

  it("refuses as the SQL does: no season id 23502; a season that is not the caller's or does not exist 42501", () => {
    const refuse = (params) =>
      handleScheduleTbdRpc(db, 'get_schedule_tbd', params, { isOrgAdmin: admin }).error?.code;
    expect(refuse({})).toBe('23502');
    expect(refuse({ p_season_settings_id: 's2' })).toBe('42501');
    expect(refuse({ p_season_settings_id: 'nope' })).toBe('42501');
  });
});

describe('the mock refresh_schedule_tbd_practices', () => {
  const call = (params, ctx = { isOrgAdmin: admin }) =>
    handleScheduleTbdRpc(db, 'refresh_schedule_tbd_practices', params, ctx);

  it("refuses as the SQL does: no season 23502, a season that is not the caller's or does not exist 42501", () => {
    expect(call({}).error.code).toBe('23502');
    const other = call({ p_season_settings_id: 's2' });
    const missing = call({ p_season_settings_id: 'nope' });
    expect(other.error.code).toBe('42501');
    expect(missing.error).toEqual(other.error);
    expect(other.error.message).toMatch(/refreshed by an administrator/);
    expect(call({ p_season_settings_id: 's1' }, { isOrgAdmin: () => false }).error.code).toBe(
      '42501'
    );
  });

  it("answers with the season's practice rows as seeded and rebuilds nothing (stated in the arm's header)", () => {
    const before = JSON.stringify(db.schedule_tbd);
    const { data, error } = call({ p_season_settings_id: 's1' });
    expect(error).toBeNull();
    expect(data).toEqual({ changed: false, practice_rows: 1, missing_practices: 2 });
    expect(JSON.stringify(db.schedule_tbd)).toBe(before);
  });

  it('refuses the rebuild of a completed season that has rows (20261109010000), and answers for one with none', () => {
    const completed = {
      ...db,
      season_settings: [
        { id: 's1', organization_id: 'o1', status: 'completed' },
        db.season_settings[1],
      ],
    };
    const { data, error } = handleScheduleTbdRpc(
      completed,
      'refresh_schedule_tbd_practices',
      { p_season_settings_id: 's1' },
      { isOrgAdmin: admin }
    );
    expect(data).toBeNull();
    expect(error).toMatchObject({ code: '22023', details: 'season_completed' });
    const empty = { ...completed, schedule_tbd: [] };
    expect(
      handleScheduleTbdRpc(
        empty,
        'refresh_schedule_tbd_practices',
        { p_season_settings_id: 's1' },
        { isOrgAdmin: admin }
      ).error
    ).toBeNull();
    // Reading the list of a completed season is not a write.
    expect(
      handleScheduleTbdRpc(
        completed,
        'get_schedule_tbd',
        { p_season_settings_id: 's1' },
        { isOrgAdmin: admin }
      ).error
    ).toBeNull();
  });
});
