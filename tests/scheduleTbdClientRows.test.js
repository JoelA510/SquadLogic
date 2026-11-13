/**
 * `readScheduleTbd` uses the rows `get_schedule_tbd` answers as they come (F11-3, E1). Migration 20261122010000 (deployed,
 * verified 2026-11-12) gives every game row its `game_date` and `external_ref`; the client's fallback for the earlier
 * body (a second read of `schedule_tbd`, joined by row id) is gone, so no second read is made, whatever the rows say.
 */
import { describe, expect, it, vi } from 'vitest';
import { readScheduleTbd } from '../frontend/src/utils/scheduleTbdClient.js';

const SEASON = 'season-1';
const gameRow = (extra) => ({
  id: 'tbd-g1',
  kind: 'game',
  organization_id: 'org-1',
  season_settings_id: SEASON,
  division_id: 'div-1',
  division_name: 'U10',
  home_team_id: 't1',
  home_team_name: 'Home',
  away_team_id: 't2',
  away_team_name: 'Away',
  week_index: 3,
  reason: 'no-slot-available',
  detail: {},
  ...extra,
});

function client(rows) {
  return {
    rpc: vi.fn(async () => ({ data: rows, error: null })),
    from: vi.fn(() => {
      throw new Error('a second read was made');
    }),
  };
}

describe('readScheduleTbd reads the RPC alone', () => {
  it('takes the dates the RPC gives and reads no table', async () => {
    const c = client([gameRow({ game_date: '2026-10-17', external_ref: 'G-1' })]);
    const { rows } = await readScheduleTbd(c, SEASON);
    expect(rows[0]).toMatchObject({ game_date: '2026-10-17', external_ref: 'G-1' });
    expect(c.from).not.toHaveBeenCalled();
  });

  it('a row without the key (the body before 20261122010000) is not patched by a second read', async () => {
    const c = client([gameRow({})]);
    const { rows } = await readScheduleTbd(c, SEASON);
    expect(c.from).not.toHaveBeenCalled();
    expect(Object.hasOwn(rows[0], 'game_date')).toBe(false);
  });

  it('a refused RPC is an error with its code', async () => {
    const c = {
      rpc: async () => ({ data: null, error: { code: '42501', message: 'not an admin' } }),
    };
    await expect(readScheduleTbd(c, SEASON)).rejects.toMatchObject({ code: '42501' });
  });
});
