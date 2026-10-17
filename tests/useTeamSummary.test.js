import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useTeamSummary } from '../frontend/src/hooks/useTeamSummary.js';
import { supabase } from '../frontend/src/lib/supabaseClient.js';
import { useOrganization } from '../frontend/src/contexts/OrganizationContext.jsx';

vi.mock('../frontend/src/lib/supabaseClient.js', () => ({
  supabase: {
    from: vi.fn(),
  },
}));

vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: vi.fn(),
}));

vi.mock('../frontend/src/lib/logger.js', () => ({
  logger: { error: vi.fn() },
}));

function createQueryBuilder(resolvedValue) {
  const builder = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    in: vi.fn(() => builder),
    order: vi.fn(() => builder),
    or: vi.fn(() => builder),
    limit: vi.fn(() => builder),
    maybeSingle: vi.fn(() => Promise.resolve(resolvedValue)),
  };
  return builder;
}

describe('useTeamSummary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // @ts-expect-error [MOCK] - partial organization context is enough for this hook.
    vi.mocked(useOrganization).mockReturnValue({
      currentOrganization: { id: 'org-1' },
      currentSeasonSetting: { id: 'season-1' },
    });
  });

  it('scopes team scheduler reads to the active organization and season', async () => {
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const runBuilder = createQueryBuilder({
      data: {
        id: 'team-run-1',
        status: 'completed',
        completed_at: '2026-05-01T00:00:00Z',
        metrics: { progress: 100 },
        results: {
          teamsByDivision: {
            U10: [{ id: 'team-1', name: 'Team One' }],
          },
          rosterBalanceByDivision: {
            U10: { summary: { totalPlayers: 10, totalCapacity: 12 } },
          },
          coachCoverageByDivision: {
            U10: { totalTeams: 1, teamsWithCoach: 1, coverageRate: 1 },
          },
        },
      },
      error: null,
    });

    // @ts-expect-error [MOCK] - query builder only implements methods exercised by this hook.
    vi.mocked(supabase.from).mockReturnValue(runBuilder);

    const { result, unmount } = renderHook(() => useTeamSummary());

    try {
      await waitFor(() => expect(result.current.loading).toBe(false));

      expect(result.current.summary.runId).toBe('team-run-1');
      expect(runBuilder.eq).toHaveBeenCalledWith('organization_id', 'org-1');
      expect(runBuilder.eq).toHaveBeenCalledWith('run_type', 'team');
      expect(runBuilder.in).toHaveBeenCalledWith('status', ['completed', 'running']);
      expect(runBuilder.or).toHaveBeenCalledWith(
        'season_settings_id.eq.season-1,season_id.eq.season-1'
      );
      expect(timeoutSpy).not.toHaveBeenCalledWith(expect.any(Function), 2000);
    } finally {
      unmount();
      timeoutSpy.mockRestore();
    }
  });

  it('polls only while the latest team run is running', async () => {
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const transientError = new Error('temporary network failure');
    const runBuilder = createQueryBuilder({
      data: {
        id: 'team-run-running',
        status: 'running',
        metrics: { progress: 35 },
        results: {},
      },
      error: null,
    });

    // @ts-expect-error [MOCK] - query builder only implements methods exercised by this hook.
    vi.mocked(supabase.from).mockReturnValue(runBuilder);

    const { result, unmount } = renderHook(() => useTeamSummary());

    try {
      await waitFor(() => expect(result.current.status).toBe('running'));

      expect(result.current.loading).toBe(true);
      expect(result.current.progress).toBe(35);
      expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 2000);

      const firstPollIndex = timeoutSpy.mock.calls.findIndex(([, delay]) => delay === 2000);
      const firstPoll = timeoutSpy.mock.calls[firstPollIndex][0];
      const firstPollId = timeoutSpy.mock.results[firstPollIndex].value;
      clearTimeout(firstPollId);

      runBuilder.maybeSingle.mockRejectedValueOnce(transientError);

      await act(async () => {
        await firstPoll();
      });

      await waitFor(() => expect(result.current.status).toBe('error'));
      expect(result.current.loading).toBe(false);
      expect(result.current.error).toBe(transientError);
      expect(timeoutSpy.mock.calls.filter(([, delay]) => delay === 2000)).toHaveLength(2);
    } finally {
      unmount();
      timeoutSpy.mockRestore();
    }
  });

  it('surfaces initial fetch errors without scheduling more polling', async () => {
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const fetchError = new Error('database unavailable');
    const runBuilder = createQueryBuilder({ data: null, error: null });
    runBuilder.maybeSingle.mockRejectedValue(fetchError);

    // @ts-expect-error [MOCK] - query builder only implements methods exercised by this hook.
    vi.mocked(supabase.from).mockReturnValue(runBuilder);

    const { result, unmount } = renderHook(() => useTeamSummary());

    try {
      await waitFor(() => expect(result.current.status).toBe('error'));

      expect(result.current.loading).toBe(false);
      expect(result.current.error).toBe(fetchError);
      expect(timeoutSpy).not.toHaveBeenCalledWith(expect.any(Function), 2000);
    } finally {
      unmount();
      timeoutSpy.mockRestore();
    }
  });

  it('treats zero scheduler runs (new org/season) as the idle empty state, not an error', async () => {
    // maybeSingle resolves { data: null } when no run exists — a brand-new
    // org must see the empty summary instead of a 406-driven error state.
    const runBuilder = createQueryBuilder({ data: null, error: null });

    // @ts-expect-error [MOCK] - query builder only implements methods exercised by this hook.
    vi.mocked(supabase.from).mockReturnValue(runBuilder);

    const { result, unmount } = renderHook(() => useTeamSummary());

    try {
      // 'idle' is also the hook's INITIAL status, so waiting on it is vacuous
      // (it can pass before the fetch settles). loading flips false only once
      // the zero-rows branch has run, so that's the deterministic signal.
      await waitFor(() => expect(result.current.loading).toBe(false));

      expect(result.current.status).toBe('idle');
      expect(result.current.error).toBe(null);
      expect(result.current.progress).toBe(0);
      expect(result.current.summary.totals.teams).toBe(0);
      expect(result.current.summary.divisions).toEqual([]);
    } finally {
      unmount();
    }
  });
  it('refetch() reads the latest run again, and reports loading from the same update', async () => {
    // Before a team sync: no run. After it: the run the sync wrote.
    const reads = [
      { data: null, error: null },
      {
        data: {
          id: 'team-run-synced',
          status: 'completed',
          completed_at: '2026-10-17T12:00:00Z',
          results: { teamsByDivision: { U10: [{ id: 'team-1', name: 'Team One' }] } },
        },
        error: null,
      },
    ];
    // @ts-expect-error [MOCK] - query builder only implements methods exercised by this hook.
    vi.mocked(supabase.from).mockImplementation(() => createQueryBuilder(reads.shift()));

    const { result, unmount } = renderHook(() => useTeamSummary());

    try {
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.generatedAt).toBeNull();

      act(() => result.current.refetch());
      // A caller that clears a staged copy in this update never sees the stale run.
      expect(result.current.loading).toBe(true);

      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.summary.runId).toBe('team-run-synced');
      expect(result.current.generatedAt).toBe('2026-10-17T12:00:00Z');
      expect(supabase.from).toHaveBeenCalledTimes(2);
    } finally {
      unmount();
    }
  });
});
