/**
 * PR 3 of the schedule expansion (docs/changes/2026-11-03-schedule-expansion.md, 3.4): the calls the Games page and the
 * Exports panel make. `admin_set_games_published` takes 1 to 2,400 ids, so a longer list is several calls, in order,
 * and the first refusal stops the rest and says how far it got (those games have already changed). Turning the flag
 * on sends no reason and no note; turning it off sends the reason and the optional note, never an empty one. What the
 * screen could have known is refused before it is sent, in the helper's code.
 *
 * Driven against a stand-in client so the arguments can be read, and against the mock client's real arm of the RPC
 * (tests/mockGamePublished.test.js holds that arm to the SQL) for the round trip.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readGameHistory, setGamesPublished } from '../frontend/src/utils/gamePublishedClient.js';
import { GAME_PUBLISH_MAX_IDS } from '../packages/core/src/gamePublished.js';
import { getMockData, mockSupabase } from '../frontend/src/lib/mockSupabaseClient.js';
import { MOCK_ORG_ID } from '../frontend/src/lib/mockSeedIds.js';

vi.mock('../frontend/src/lib/supabaseClient.js', () => ({ supabase: {} }));

const ORG = '00000000-0000-4000-8000-000000000001';
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** A client whose RPC answers from a queue and records every call. */
function client(answers) {
  const calls = [];
  const queue = [...answers];
  return {
    calls,
    rpc: vi.fn(async (name, params) => {
      calls.push({ name, params });
      return queue.shift() ?? { data: { changed: 0, unchanged: 0, ids: [] }, error: null };
    }),
  };
}
const ok = (changed, unchanged = 0) => ({
  data: { changed, unchanged, ids: Array.from({ length: changed }, (_, i) => uuid(i + 1)) },
  error: null,
});

describe('turning Published on', () => {
  it('sends the ids, the value and the scope, and no reason or note', async () => {
    const c = client([ok(2)]);
    const result = await setGamesPublished({
      client: c,
      organizationId: ORG,
      ids: [uuid(1), uuid(2)],
      published: true,
      scope: { kind: 'division', value: 'U10 Boys' },
    });
    expect(c.calls).toEqual([
      {
        name: 'admin_set_games_published',
        params: {
          p_organization_id: ORG,
          p_assignment_ids: [uuid(1), uuid(2)],
          p_published: true,
          p_reason_code: null,
          p_note: null,
          p_scope: { kind: 'division', value: 'U10 Boys' },
        },
      },
    ]);
    expect(result).toMatchObject({ changed: 2, unchanged: 0, calls: 1 });
  });

  it('drops a reason or a note it was handed: they belong to allowing changes', async () => {
    const c = client([ok(1)]);
    await setGamesPublished({
      client: c,
      organizationId: ORG,
      ids: [uuid(1)],
      published: true,
      reasonCode: 'other',
      note: 'ignored',
    });
    expect(c.calls[0].params.p_reason_code).toBeNull();
    expect(c.calls[0].params.p_note).toBeNull();
  });
});

describe('turning it off ("Allow changes")', () => {
  it('sends the reason and the trimmed note', async () => {
    const c = client([ok(1)]);
    await setGamesPublished({
      client: c,
      organizationId: ORG,
      ids: [uuid(1)],
      published: false,
      reasonCode: 'coach-request',
      note: '  Coach asked for a later start  ',
      scope: { kind: 'selection' },
    });
    expect(c.calls[0].params).toMatchObject({
      p_published: false,
      p_reason_code: 'coach-request',
      p_note: 'Coach asked for a later start',
    });
  });

  it('never sends an empty note', async () => {
    const c = client([ok(1)]);
    await setGamesPublished({
      client: c,
      organizationId: ORG,
      ids: [uuid(1)],
      published: false,
      reasonCode: 'other',
      note: '   ',
    });
    expect(c.calls[0].params.p_note).toBeNull();
  });

  it('refuses before sending what the database would refuse for a reason the screen knew', async () => {
    const c = client([]);
    /** @type {Array<[Record<string, any>, string]>} */
    const cases = [
      [{ reasonCode: null }, 'reason_required'],
      [{ reasonCode: 'because' }, 'reason_unknown'],
      [{ reasonCode: 'other', note: 'x'.repeat(201) }, 'note_too_long'],
      [{ reasonCode: 'other', scope: { kind: 'planet' } }, 'scope_invalid'],
    ];
    for (const [input, code] of cases) {
      await expect(
        setGamesPublished({
          client: c,
          organizationId: ORG,
          ids: [uuid(1)],
          published: false,
          ...input,
        })
      ).rejects.toMatchObject({ code: 'client_refusal', details: code });
    }
    expect(c.rpc).not.toHaveBeenCalled();
  });

  it('refuses no ids, and an id that is not a string, without a call', async () => {
    const c = client([]);
    await expect(
      setGamesPublished({ client: c, organizationId: ORG, ids: [], published: true })
    ).rejects.toThrow(/at least one game/);
    await expect(
      setGamesPublished({ client: c, organizationId: ORG, ids: [null], published: true })
    ).rejects.toThrow(TypeError);
    expect(c.rpc).not.toHaveBeenCalled();
  });
});

describe('a long list is several calls', () => {
  const many = Array.from({ length: GAME_PUBLISH_MAX_IDS + 5 }, (_, i) => uuid(i + 1));

  it('2,405 ids go as 2,400 and 5, in order, the answers summed', async () => {
    const c = client([ok(2400, 0), ok(3, 2)]);
    const result = await setGamesPublished({
      client: c,
      organizationId: ORG,
      ids: many,
      published: true,
    });
    expect(c.calls.map((call) => call.params.p_assignment_ids.length)).toEqual([2400, 5]);
    expect(c.calls[0].params.p_assignment_ids[0]).toBe(uuid(1));
    expect(c.calls[1].params.p_assignment_ids[0]).toBe(uuid(2401));
    expect(result).toMatchObject({ changed: 2403, unchanged: 2, calls: 2 });
  });

  it('the first refusal stops the rest, in the database’s words, and says how far it got', async () => {
    const c = client([
      ok(2400),
      {
        data: null,
        error: {
          code: '23503',
          message: 'game gone does not exist in this organization',
          details: 'game_not_found',
        },
      },
    ]);
    const error = await setGamesPublished({
      client: c,
      organizationId: ORG,
      ids: [...many, uuid(9999)],
      published: true,
    }).catch((err) => err);
    expect(error.message).toBe('game gone does not exist in this organization');
    expect(error.code).toBe('23503');
    expect(error.details).toBe('game_not_found');
    expect(error.done).toEqual({ calls: 1, of: 2, changed: 2400 });
    expect(c.rpc).toHaveBeenCalledTimes(2);
  });

  it('a refusal on the first call says nothing was saved before it', async () => {
    const c = client([
      { data: null, error: { code: '42501', message: 'Access denied', details: 'admin_required' } },
    ]);
    const error = await setGamesPublished({
      client: c,
      organizationId: ORG,
      ids: [uuid(1)],
      published: true,
    }).catch((err) => err);
    expect(error.done).toEqual({ calls: 0, of: 1, changed: 0 });
  });
});

describe('against the mock client’s arm of the RPC', () => {
  beforeEach(() => {
    sessionStorage.clear();
    window.__saveMockDB__({
      ...window.__MOCK_DB__,
      game_assignments: [
        {
          id: uuid(11),
          organization_id: MOCK_ORG_ID,
          home_team_id: uuid(101),
          away_team_id: uuid(102),
          game_slot_id: 'slot-1',
          slot_id: 'slot-1',
          week_index: 1,
          start: '2026-10-03T16:00:00Z',
          end: '2026-10-03T17:00:00Z',
          published: false,
        },
      ],
      audit_log: [],
    });
    sessionStorage.setItem('__MOCK_SESSION__', JSON.stringify({ user: { id: 'mock-admin-id' } }));
  });

  it('publishes, then allows changes with a reason, and the history reads back both, newest first', async () => {
    const on = await setGamesPublished({
      client: mockSupabase,
      organizationId: MOCK_ORG_ID,
      ids: [uuid(11)],
      published: true,
      scope: { kind: 'selection' },
    });
    expect(on).toMatchObject({ changed: 1, unchanged: 0 });
    const again = await setGamesPublished({
      client: mockSupabase,
      organizationId: MOCK_ORG_ID,
      ids: [uuid(11)],
      published: true,
    });
    expect(again).toMatchObject({ changed: 0, unchanged: 1 });
    await setGamesPublished({
      client: mockSupabase,
      organizationId: MOCK_ORG_ID,
      ids: [uuid(11)],
      published: false,
      reasonCode: 'coach-request',
      note: 'A coach asked',
    });
    expect(getMockData('game_assignments').find((g) => g.id === uuid(11)).published).toBe(false);
    const rows = await readGameHistory({
      client: mockSupabase,
      organizationId: MOCK_ORG_ID,
      gameId: uuid(11),
    });
    const overridden = rows.find((r) => r.action === 'game.publish_overridden');
    expect(overridden.metadata).toMatchObject({
      reason_code: 'coach-request',
      note: 'A coach asked',
    });
    expect(rows.some((r) => r.action === 'game.published_set')).toBe(true);
  });

  it('a refusal comes back as the database’s words, with its code and detail', async () => {
    const error = await setGamesPublished({
      client: mockSupabase,
      organizationId: MOCK_ORG_ID,
      ids: [uuid(404)],
      published: true,
    }).catch((err) => err);
    expect(error.message).toMatch(/does not exist in this organization/);
    expect(error.details).toBe('game_not_found');
  });

  it('a history read the database refuses throws its words (a person who is not an admin)', async () => {
    sessionStorage.removeItem('__MOCK_SESSION__');
    const error = await readGameHistory({
      client: mockSupabase,
      organizationId: MOCK_ORG_ID,
      gameId: uuid(11),
    }).catch((err) => err);
    expect(error.message).toMatch(/only an administrator/);
    expect(error.details).toBe('admin_required');
  });
});
