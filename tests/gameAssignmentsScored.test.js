/**
 * `useGameAssignments` learns which games are scored in the SAME read as the games (review of #725, R7 and R2).
 *
 * - One read, bounded to the run: the games with their score embedded through the foreign key
 *   (`game_assignments` selecting `game_scores(game_id)`), not a second read of every score the organization ever
 *   recorded. One snapshot, so a game and its hold cannot disagree.
 * - Since F11-3 (migration 20261122010000 is deployed, verified 2026-11-12) there is no fallback: a database that
 *   answers "no `game_scores`" (PGRST200, PGRST205, 42P01) is an error the page says, never "no game is scored",
 *   which would leave every scored game unheld on screen.
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

const { useGameAssignments } = await import('../frontend/src/hooks/useGameAssignments.js');

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

describe('a database with no game_scores is an error, not an unscored schedule (F11-3, E1)', () => {
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
    { code: '42501', message: 'permission denied for table game_scores' },
  ];

  it.each(MISSING)(
    '$code: the read fails, with no second read and no schedule',
    async (missing) => {
      mocks.answer = (select) =>
        select === EMBED
          ? { data: null, error: missing }
          : { data: [game('a'), game('b')], error: null };
      const { assignments, error } = await load();
      expect(error).toMatchObject({ code: missing.code });
      expect(assignments).toEqual([]);
      expect(mocks.reads.map((r) => r.select)).toEqual([EMBED]);
      expect(mocks.warn).not.toHaveBeenCalled();
    }
  );
});
