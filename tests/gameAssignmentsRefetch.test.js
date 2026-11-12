/**
 * PR 3 of the schedule expansion (docs/changes/2026-11-03-schedule-expansion.md, 3.6): turning Published on or off
 * makes no new run, so the games of the run on screen are read again by name (`refetch`), and the Games page counts
 * them. Two things the page needs of the hook, held here:
 *
 * - **Loading from the render that names the read.** A run arriving, or a `refetch`, is loading in that same render and
 *   not from the effect after it: the page counts the saved games and would otherwise read "0 of 0" for the one render
 *   between a run id arriving and its games being read (lesson 93: a view that renders before its inputs arrive says so).
 * - **An overtaken read writes nothing.** A read for an older run, or an older `refetch`, that answers after a newer
 *   one must not replace its answer.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useGameAssignments } from '../frontend/src/hooks/useGameAssignments.js';

const mocks = vi.hoisted(() => ({
  /** One pending read per call, so a test can answer them in any order. */
  reads: /** @type {Array<{ runId: string, resolve: (rows: any[]) => void }>} */ ([]),
}));

vi.mock('../frontend/src/lib/supabaseClient.js', () => ({
  supabase: {
    from: () => {
      let runId = null;
      const builder = {
        select: () => builder,
        eq: (_column, value) => {
          runId = value;
          return builder;
        },
        order: () => builder,
        range: () => builder,
        then: (resolve, reject) =>
          new Promise((answer) => {
            mocks.reads.push({ runId, resolve: (rows) => answer({ data: rows, error: null }) });
          }).then(resolve, reject),
      };
      return builder;
    },
  },
}));
vi.mock('../frontend/src/lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), log: vi.fn(), info: vi.fn() },
}));

const rows = (...ids) => ids.map((id) => ({ id, run_id: 'r', published: false }));

beforeEach(() => {
  mocks.reads.length = 0;
});

describe('loading starts in the render that names the read', () => {
  it('a run id that arrives is loading at once, with no games, until its read answers', async () => {
    const { result, rerender } = renderHook(({ runId }) => useGameAssignments(runId), {
      initialProps: { runId: null },
    });
    expect(result.current.loading).toBe(false);
    rerender({ runId: 'run-1' });
    // The render that carries the run id: loading already, not false for a render and then true.
    expect(result.current.loading).toBe(true);
    expect(result.current.assignments).toEqual([]);
    await waitFor(() => expect(mocks.reads).toHaveLength(1));
    act(() => mocks.reads[0].resolve(rows('a', 'b')));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.assignments.map((a) => a.id)).toEqual(['a', 'b']);
  });

  it('refetch is loading in the render that asks for it, and reads the same run again', async () => {
    const { result } = renderHook(() => useGameAssignments('run-1'));
    await waitFor(() => expect(mocks.reads).toHaveLength(1));
    act(() => mocks.reads[0].resolve(rows('a')));
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.refetch());
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(mocks.reads).toHaveLength(2));
    expect(mocks.reads[1].runId).toBe('run-1');
    act(() => mocks.reads[1].resolve(rows('a', 'c')));
    await waitFor(() => expect(result.current.assignments.map((a) => a.id)).toEqual(['a', 'c']));
    expect(result.current.loading).toBe(false);
  });

  it('no run is not loading', () => {
    const { result } = renderHook(() => useGameAssignments(null));
    expect(result.current).toMatchObject({ loading: false, assignments: [] });
  });
});

describe('a read that was overtaken writes nothing', () => {
  it('two refetches, answered in reverse: the later one wins', async () => {
    const { result } = renderHook(() => useGameAssignments('run-1'));
    await waitFor(() => expect(mocks.reads).toHaveLength(1));
    act(() => mocks.reads[0].resolve(rows('first')));
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.refetch());
    await waitFor(() => expect(mocks.reads).toHaveLength(2));
    act(() => result.current.refetch());
    await waitFor(() => expect(mocks.reads).toHaveLength(3));
    // The newer read answers first, then the older one: its answer is dropped.
    act(() => mocks.reads[2].resolve(rows('newest')));
    await waitFor(() => expect(result.current.assignments.map((a) => a.id)).toEqual(['newest']));
    act(() => mocks.reads[1].resolve(rows('stale')));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(result.current.assignments.map((a) => a.id)).toEqual(['newest']);
    expect(result.current.loading).toBe(false);
  });

  it('a run that changes while its read is out: the old run’s answer does not replace the new run’s', async () => {
    const { result, rerender } = renderHook(({ runId }) => useGameAssignments(runId), {
      initialProps: { runId: 'run-1' },
    });
    await waitFor(() => expect(mocks.reads).toHaveLength(1));
    rerender({ runId: 'run-2' });
    await waitFor(() => expect(mocks.reads).toHaveLength(2));
    act(() => mocks.reads[1].resolve(rows('of-run-2')));
    await waitFor(() => expect(result.current.assignments.map((a) => a.id)).toEqual(['of-run-2']));
    act(() => mocks.reads[0].resolve(rows('of-run-1')));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(result.current.assignments.map((a) => a.id)).toEqual(['of-run-2']);
  });

  it('a run that goes away while its read is out leaves nothing loading', async () => {
    const { result, rerender } = renderHook(({ runId }) => useGameAssignments(runId), {
      initialProps: { runId: 'run-1' },
    });
    await waitFor(() => expect(mocks.reads).toHaveLength(1));
    rerender({ runId: null });
    expect(result.current.loading).toBe(false);
    act(() => mocks.reads[0].resolve(rows('late')));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(result.current).toMatchObject({ loading: false, assignments: [] });
  });
});
