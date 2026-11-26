import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { useTeamPersistence } from '../frontend/src/hooks/useTeamPersistence.js';

const state = vi.hoisted(() => ({ org: 'club', season: 'fall', read: vi.fn() }));
vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: () => ({
    currentOrganization: { id: state.org },
    currentSeasonSetting: { id: state.season },
  }),
}));
vi.mock('../frontend/src/lib/supabaseClient.js', () => ({
  supabase: {
    rpc: async () => ({ data: [] }),
    from: () => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        order: () => chain,
        or: () => chain,
        limit: () => state.read(state.org, state.season),
      };
      return chain;
    },
  },
}));

describe('saved team history follows the current club and season', () => {
  beforeEach(() => {
    state.org = 'club';
    state.season = 'fall';
    state.read.mockReset();
  });
  it('surfaces a failed history read and recovers on retry', async () => {
    state.read
      .mockResolvedValueOnce({ error: { message: 'Read failed' } })
      .mockResolvedValueOnce({ data: [{ id: 'recovered', results: {} }] });
    const { result } = renderHook(useTeamPersistence);
    await waitFor(() =>
      expect(result.current.error).toContain('Could not load saved team history')
    );
    expect(result.current.loading).toBe(false);
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.persistenceSnapshot.lastRunId).toBe('recovered'));
    expect(result.current.error).toBeNull();
  });
  it.each(['season', 'org'])(
    'ignores a late response after switching %s and masks the prior history while loading',
    async (field) => {
      let release;
      state.read
        .mockResolvedValueOnce({ data: [{ id: 'original', results: {} }] })
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              release = resolve;
            })
        )
        .mockResolvedValueOnce({ data: [{ id: 'current', results: {} }] });
      const { result, rerender } = renderHook(useTeamPersistence);
      await waitFor(() => expect(result.current.persistenceSnapshot.lastRunId).toBe('original'));
      state[field] = 'intermediate';
      rerender();
      expect(result.current.loading).toBe(true);
      const visibleDuringLoad = result.current.persistenceSnapshot.lastRunId;
      state[field] = 'new';
      rerender();
      await waitFor(() => expect(result.current.persistenceSnapshot.lastRunId).toBe('current'));
      await act(async () => release({ data: [{ id: 'late', results: {} }] }));
      expect(result.current.persistenceSnapshot.lastRunId).toBe('current');
      expect(visibleDuringLoad).toBeNull();
      expect(result.current.loading).toBe(false);
    }
  );
});
