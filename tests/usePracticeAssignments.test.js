import { describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { usePracticeAssignments } from '../frontend/src/hooks/usePracticeAssignments.js';
import { supabase } from '../frontend/src/lib/supabaseClient.js';

vi.mock('../frontend/src/lib/supabaseClient.js', () => ({
  supabase: {
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(),
      })),
    })),
  },
}));

describe('usePracticeAssignments', () => {
  it('returns empty assignments if no runId is provided', () => {
    const { result } = renderHook(() => usePracticeAssignments(null));
    expect(result.current.assignments).toEqual([]);
    expect(result.current.loading).toBe(false);
    expect(result.current).not.toHaveProperty('updateAssignmentSource');
  });

  it('fetches assignments from supabase when runId is provided', async () => {
    const mockData = [
      { id: '1', team_id: 't1', run_id: 'run-123' },
      { id: '2', team_id: 't2', run_id: 'run-123' },
    ];

    const mockEq = vi.fn().mockResolvedValue({ data: mockData, error: null });
    const mockSelect = vi.fn(() => ({ eq: mockEq }));
    const mockFrom = vi.fn(() => ({ select: mockSelect }));
    // @ts-expect-error [MOCK] - overriding readonly client property for test isolation; Supabase from() is typed as a method on the client instance
    supabase.from = mockFrom;

    const { result } = renderHook(() => usePracticeAssignments('run-123'));

    expect(result.current.loading).toBe(true);

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.assignments.length).toBe(2);
    // Verify camelCase mapping
    expect(result.current.assignments[0]).toHaveProperty('teamId');
    expect(result.current.assignments[0].teamId).toBe('t1');
    expect(mockEq).toHaveBeenCalledWith('run_id', 'run-123');
  });

  it('handles fetch errors correctly', async () => {
    const mockError = { message: 'Database error' };
    const mockEq = vi.fn().mockResolvedValue({ data: null, error: mockError });
    const mockSelect = vi.fn(() => ({ eq: mockEq }));
    // @ts-expect-error [MOCK] - overriding readonly client property for test isolation; Supabase from() is typed as a method on the client instance
    supabase.from = vi.fn(() => ({ select: mockSelect }));

    const { result } = renderHook(() => usePracticeAssignments('run-err'));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toEqual(mockError);
    expect(result.current.assignments).toEqual([]);
  });

  it('drops the error when the run goes away, so it cannot outlive its run', async () => {
    // The `!runId` branch emptied `assignments` and left `error` standing.
    // Switching organisation takes `practiceRunId` to null, so the previous
    // tenant's refusal stayed in state for the rest of the session. That was
    // harmless while nothing read it; `useDashboardData` reads it now, and a
    // stale error there blocks the CSV export on a tenant where no read
    // failed.
    const mockError = { message: 'permission denied for table practice_assignments' };
    const mockEq = vi.fn().mockResolvedValue({ data: null, error: mockError });
    // @ts-expect-error [MOCK] - overriding readonly client property for test isolation; Supabase from() is typed as a method on the client instance
    supabase.from = vi.fn(() => ({ select: vi.fn(() => ({ eq: mockEq })) }));

    const { result, rerender } = renderHook(({ runId }) => usePracticeAssignments(runId), {
      initialProps: { runId: /** @type {string|null} */ ('run-err') },
    });

    // Meta-assertion: the error really is set before the re-render, so the
    // null below is a clear rather than a hook that never failed.
    await waitFor(() => expect(result.current.error).toEqual(mockError));

    rerender({ runId: null });

    expect(result.current.error).toBeNull();
    expect(result.current.assignments).toEqual([]);
  });
});
