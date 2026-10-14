import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useSchedulerRun } from '../frontend/src/hooks/useSchedulerRun.js';
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
    single: vi.fn(() => builder),
    maybeSingle: vi.fn(() => builder),
    abortSignal: vi.fn(() => Promise.resolve(resolvedValue)),
  };
  return builder;
}

describe('useSchedulerRun', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // @ts-expect-error [MOCK] - partial organization context is enough for this hook.
    vi.mocked(useOrganization).mockReturnValue({
      currentOrganization: { id: 'org-1' },
      currentSeasonSetting: { id: 'season-1' },
    });
  });

  it('scopes scheduler run and evaluation reads to the active organization and season', async () => {
    const runBuilder = createQueryBuilder({
      data: { id: 'practice-run-1', results: {}, completed_at: '2026-05-01T00:00:00Z' },
      error: null,
    });
    const evaluationBuilder = createQueryBuilder({ data: null, error: null });

    // @ts-expect-error [MOCK] - query builder only implements methods exercised by this hook.
    vi.mocked(supabase.from).mockImplementation((table) => {
      if (table === 'scheduler_runs') return runBuilder;
      if (table === 'schedule_evaluations') return evaluationBuilder;
      throw new Error(`Unexpected table ${table}`);
    });

    const emptyState = { runId: null };
    const mapper = vi.fn((run) => ({ runId: run.id }));

    const { result } = renderHook(() => useSchedulerRun('practice', mapper, emptyState));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.data).toEqual({ runId: 'practice-run-1' });
    expect(runBuilder.limit).toHaveBeenCalledWith(1);
    expect(runBuilder.maybeSingle).toHaveBeenCalled();
    expect(runBuilder.single).not.toHaveBeenCalled();
    expect(runBuilder.eq).toHaveBeenCalledWith('organization_id', 'org-1');
    expect(runBuilder.eq).toHaveBeenCalledWith('run_type', 'practice');
    expect(runBuilder.eq).toHaveBeenCalledWith('status', 'completed');
    expect(runBuilder.or).toHaveBeenCalledWith(
      'season_settings_id.eq.season-1,season_id.eq.season-1'
    );
    expect(evaluationBuilder.eq).toHaveBeenCalledWith('organization_id', 'org-1');
    expect(evaluationBuilder.eq).toHaveBeenCalledWith('run_id', 'practice-run-1');
  });

  it('returns the empty state without querying when org or season context is missing', async () => {
    // @ts-expect-error [MOCK] - partial organization context is enough for this hook.
    vi.mocked(useOrganization).mockReturnValue({
      currentOrganization: { id: 'org-1' },
      currentSeasonSetting: null,
    });

    const emptyState = { runId: null };
    const { result } = renderHook(() => useSchedulerRun('game', vi.fn(), emptyState));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.data).toBe(emptyState);
    expect(result.current.evaluation).toBeNull();
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it('clears a previous evaluation when the scoped run is missing after context changes', async () => {
    let organizationContext = {
      currentOrganization: { id: 'org-1' },
      currentSeasonSetting: { id: 'season-1' },
    };
    // @ts-expect-error [MOCK] - partial organization context is enough for this hook.
    vi.mocked(useOrganization).mockImplementation(() => organizationContext);

    const runBuilder = createQueryBuilder({
      data: { id: 'practice-run-1', results: {}, completed_at: '2026-05-01T00:00:00Z' },
      error: null,
    });
    const evaluationRecord = { id: 'eval-1', organization_id: 'org-1', run_id: 'practice-run-1' };
    const evaluationBuilder = createQueryBuilder({ data: evaluationRecord, error: null });
    const missingRunBuilder = createQueryBuilder({
      data: null,
      error: null,
    });
    const builders = [runBuilder, evaluationBuilder, missingRunBuilder];

    // @ts-expect-error [MOCK] - query builder only implements methods exercised by this hook.
    vi.mocked(supabase.from).mockImplementation(() => builders.shift());

    const emptyState = { runId: null };
    const mapper = vi.fn((run) => ({ runId: run.id }));

    const { result, rerender } = renderHook(() => useSchedulerRun('practice', mapper, emptyState));

    await waitFor(() => expect(result.current.evaluation).toEqual(evaluationRecord));

    organizationContext = {
      currentOrganization: { id: 'org-1' },
      currentSeasonSetting: { id: 'season-2' },
    };
    rerender();

    await waitFor(() => expect(result.current.data).toBe(emptyState));
    expect(result.current.evaluation).toBeNull();
    expect(missingRunBuilder.maybeSingle).toHaveBeenCalled();
    expect(missingRunBuilder.single).not.toHaveBeenCalled();
    expect(mapper).toHaveBeenCalledTimes(1);
  });

  it('refetch() reads the latest run again (after a save whose outcome is unknown)', async () => {
    const runs = [
      { id: 'game-run-1', results: {}, completed_at: '2026-05-01T00:00:00Z' },
      // What a save that landed after the page stopped waiting leaves behind.
      { id: 'game-run-2', results: {}, completed_at: '2026-05-02T00:00:00Z' },
    ];
    vi.mocked(supabase.from).mockImplementation(
      (table) =>
        /** @type {any} */ (
          table === 'scheduler_runs'
            ? createQueryBuilder({ data: runs[0], error: null })
            : createQueryBuilder({ data: null, error: null })
        )
    );
    const mapper = vi.fn((run) => ({ runId: run.id }));
    const { result } = renderHook(() => useSchedulerRun('game', mapper, { runId: null }));
    await waitFor(() => expect(result.current.data).toEqual({ runId: 'game-run-1' }));

    runs.shift();
    result.current.refetch();

    await waitFor(() => expect(result.current.data).toEqual({ runId: 'game-run-2' }));
    expect(mapper).toHaveBeenCalledTimes(2);
  });
});
