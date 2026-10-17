/**
 * `useCurrentPracticeSchedule().refetch()`: the practice page calls it after a
 * save whose outcome is unknown. While the re-read is in flight the last
 * complete read of the same organisation and season stays served (the grid
 * does not go blank), with `loading` true; a read of another season is never
 * served, refetch or not.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
// Hoisted with the `vi.hoisted` blocks below, which read the ids before any
// static import has run.
const { MOCK_ORG_ID, MOCK_SEASON_ID } = await vi.hoisted(
  () => import('../frontend/src/lib/mockSeedIds.js')
);

const ORG_CONTEXT = vi.hoisted(() => ({
  value: /** @type {any} */ ({
    currentOrganization: { id: MOCK_ORG_ID },
    currentSeasonSetting: { id: MOCK_SEASON_ID },
  }),
}));
/** Each read, in order: a promise the test resolves. */
const READS = vi.hoisted(() => ({ pending: /** @type {Array<(v: any) => void>} */ ([]) }));

vi.mock('../frontend/src/lib/supabaseClient.js', () => ({ supabase: {} }));
vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: () => ORG_CONTEXT.value,
}));
vi.mock('../frontend/src/lib/logger.js', () => ({ logger: { error: vi.fn() } }));
vi.mock('../packages/core/src/practiceSupabase.js', () => ({
  loadSeasonPracticeRows: () => new Promise((resolve) => READS.pending.push(resolve)),
}));

const { useCurrentPracticeSchedule } =
  await import('../frontend/src/hooks/useCurrentPracticeSchedule.js');

const rowsOf = (...ids) => ({ ok: true, rows: ids.map((id) => ({ id, team_id: `t-${id}` })) });

beforeEach(() => {
  READS.pending = [];
  ORG_CONTEXT.value = {
    currentOrganization: { id: MOCK_ORG_ID },
    currentSeasonSetting: { id: MOCK_SEASON_ID },
  };
});

describe('useCurrentPracticeSchedule :: refetch', () => {
  it('re-reads the season, serving the previous complete read until the new one lands', async () => {
    const { result } = renderHook(() => useCurrentPracticeSchedule());
    await waitFor(() => expect(READS.pending).toHaveLength(1));
    await act(async () => READS.pending[0](rowsOf('a')));
    expect(result.current.assignments.map((r) => r.id)).toEqual(['a']);
    expect(result.current.loading).toBe(false);

    act(() => result.current.refetch());
    await waitFor(() => expect(READS.pending).toHaveLength(2));
    // In flight: the last complete read of this season, flagged as loading.
    expect(result.current.assignments.map((r) => r.id)).toEqual(['a']);
    expect(result.current.loading).toBe(true);

    await act(async () => READS.pending[1](rowsOf('a', 'landed')));
    expect(result.current.assignments.map((r) => r.id)).toEqual(['a', 'landed']);
    expect(result.current.loading).toBe(false);
  });

  it("never serves another season's rows while the new season is read", async () => {
    const { result, rerender } = renderHook(() => useCurrentPracticeSchedule());
    await waitFor(() => expect(READS.pending).toHaveLength(1));
    await act(async () => READS.pending[0](rowsOf('a')));

    ORG_CONTEXT.value = {
      currentOrganization: { id: MOCK_ORG_ID },
      currentSeasonSetting: { id: 'season-2' },
    };
    rerender();
    await waitFor(() => expect(READS.pending).toHaveLength(2));
    expect(result.current.assignments).toEqual([]);
    expect(result.current.loading).toBe(true);
  });

  it('after a failed read, a re-read serves nothing until it lands', async () => {
    const { result } = renderHook(() => useCurrentPracticeSchedule());
    await waitFor(() => expect(READS.pending).toHaveLength(1));
    await act(async () => READS.pending[0]({ ok: false, message: 'refused' }));
    expect(result.current.error?.message).toBe('refused');

    act(() => result.current.refetch());
    await waitFor(() => expect(READS.pending).toHaveLength(2));
    expect(result.current.assignments).toEqual([]);
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(true);
  });
});
