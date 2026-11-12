/**
 * `useGameAssignments` learns which games are scored in the SAME read as the games (review of #725, R7 and R2).
 *
 * - One read, bounded to the run: the games with their score embedded through the foreign key
 *   (`game_assignments` selecting `game_scores(game_id)`), not a second read of every score the organization ever
 *   recorded. One snapshot, so a game and its hold cannot disagree.
 * - Before migration 20261122010000 is applied (the client is deployed at merge, the migration some minutes later, or
 *   not at all if a guard stops it) there is no `game_scores` to embed: PostgREST answers PGRST200 (no relationship),
 *   PGRST205 or 42P01 (no table). That, and only that, reads as "no game is scored": the schedule loads as it did
 *   before, and it is logged once. Any other failure is an error, as before.
 */
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  /** What each read is answered with, by its select string. */
  answer: /** @type {(select: string) => { data: any, error: any }} */ (
    () => ({ data: [], error: null })
  ),
  reads:
    /** @type {Array<{ table: string, select: string, filters: any[], order: string | null }>} */ ([]),
  warn: /** @type {any} */ (null),
}));

vi.mock('../frontend/src/lib/supabaseClient.js', () => ({
  supabase: {
    from: (table) => {
      const read = { table, select: '', filters: [], order: null };
      const builder = {
        select: (columns) => {
          read.select = columns;
          return builder;
        },
        eq: (column, value) => {
          read.filters.push([column, value]);
          return builder;
        },
        order: (column) => {
          read.order = column;
          return builder;
        },
        range: () => builder,
        then: (resolve, reject) => {
          mocks.reads.push(read);
          return Promise.resolve(mocks.answer(read.select)).then(resolve, reject);
        },
      };
      return builder;
    },
  },
}));
vi.mock('../frontend/src/lib/logger.js', () => {
  mocks.warn = vi.fn();
  return { logger: { error: vi.fn(), warn: mocks.warn, log: vi.fn(), info: vi.fn() } };
});

const { useGameAssignments, resetScoreRelationNotice } =
  await import('../frontend/src/hooks/useGameAssignments.js');

const game = (id, extra = {}) => ({
  id,
  run_id: 'run-1',
  organization_id: 'org-1',
  published: false,
  ...extra,
});
const EMBED = '*, game_scores(game_id)';

beforeEach(() => {
  mocks.reads.length = 0;
  mocks.warn.mockClear();
  resetScoreRelationNotice();
});

async function load() {
  const { result } = renderHook(() => useGameAssignments('run-1'));
  await waitFor(() => expect(result.current.loading).toBe(false));
  return result.current;
}

describe('the games and their scores are one read of the run', () => {
  it('reads the run once, with the score embedded, and flags the scored games', async () => {
    mocks.answer = () => ({
      data: [
        game('a', { game_scores: [{ game_id: 'a' }] }),
        game('b', { game_scores: [] }),
        // PostgREST answers a to-one embed as an object or null; both shapes are read.
        game('c', { game_scores: { game_id: 'c' } }),
        game('d', { game_scores: null }),
      ],
      error: null,
    });
    const { assignments, error } = await load();
    expect(error).toBe(null);
    expect(assignments.map((a) => [a.id, a.scored])).toEqual([
      ['a', true],
      ['b', false],
      ['c', true],
      ['d', false],
    ]);
    // One read, of the run's games, ordered by the games' own key; no read of the score table by itself.
    expect(mocks.reads).toEqual([
      { table: 'game_assignments', select: EMBED, filters: [['run_id', 'run-1']], order: 'id' },
    ]);
    // The embed is read into the flag and is not left on the game under another name.
    expect(Object.keys(assignments[0])).not.toEqual(
      expect.arrayContaining(['gameScores', 'game_scores'])
    );
    expect(mocks.warn).not.toHaveBeenCalled();
  });
});

describe('before the migration is applied the schedule still loads', () => {
  const MISSING = [
    {
      code: 'PGRST200',
      message:
        "Could not find a relationship between 'game_assignments' and 'game_scores' in the schema cache",
    },
    {
      code: 'PGRST205',
      message: "Could not find the table 'public.game_scores' in the schema cache",
    },
    { code: '42P01', message: 'relation "public.game_scores" does not exist' },
  ];

  it.each(MISSING)(
    '$code: no game is scored, the games are read without the embed, and it is said once',
    async (missing) => {
      mocks.answer = (select) =>
        select === EMBED
          ? { data: null, error: missing }
          : { data: [game('a'), game('b')], error: null };
      const first = await load();
      expect(first.error).toBe(null);
      expect(first.assignments.map((a) => [a.id, a.scored])).toEqual([
        ['a', false],
        ['b', false],
      ]);
      expect(mocks.reads.map((r) => r.select)).toEqual([EMBED, '*']);
      await load();
      expect(mocks.warn).toHaveBeenCalledTimes(1);
    }
  );

  it('CONTROL: any other failure of the read is an error, with no second read and no schedule', async () => {
    mocks.answer = () => ({
      data: null,
      error: { code: '42501', message: 'permission denied for table game_scores' },
    });
    const { assignments, error } = await load();
    expect(error).toMatchObject({ code: '42501' });
    expect(assignments).toEqual([]);
    expect(mocks.reads.map((r) => r.select)).toEqual([EMBED]);
  });

  it('CONTROL: a failure of the fallback read is an error too', async () => {
    mocks.answer = (select) =>
      select === EMBED
        ? { data: null, error: { code: 'PGRST200', message: 'no relationship' } }
        : { data: null, error: { code: '500', message: 'boom' } };
    const { error } = await load();
    expect(error).toMatchObject({ code: '500' });
  });
});
