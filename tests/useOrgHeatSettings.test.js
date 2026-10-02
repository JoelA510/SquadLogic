/**
 * useOrgHeatSettings: no row is the labelled default, a failed read is an
 * error (never a silent Category 1), and `save` validates before the RPC.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

import { useOrgHeatSettings } from '../frontend/src/hooks/useOrgHeatSettings.js';
import { supabase } from '../frontend/src/lib/supabaseClient.js';
import { useOrganization } from '../frontend/src/contexts/OrganizationContext.jsx';

vi.mock('../frontend/src/lib/supabaseClient.js', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
}));
vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: vi.fn(),
}));
vi.mock('../frontend/src/lib/logger.js', () => ({ logger: { error: vi.fn() } }));

/** A builder whose `maybeSingle` resolves to each result in turn. */
function reads(...results) {
  const queue = [...results];
  const builder = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    maybeSingle: vi.fn(() => Promise.resolve(queue.length > 1 ? queue.shift() : queue[0])),
  };
  return builder;
}

beforeEach(() => {
  vi.mocked(supabase.from).mockReset();
  vi.mocked(supabase.rpc).mockReset();
  vi.mocked(useOrganization).mockReturnValue(
    /** @type {any} */ ({ currentOrganization: { id: 'org-1' } })
  );
});

describe('useOrgHeatSettings', () => {
  it('reads no row as Category 1, labelled default', async () => {
    const b = reads({ data: null, error: null });
    vi.mocked(supabase.from).mockReturnValue(/** @type {any} */ (b));
    const { result } = renderHook(() => useOrgHeatSettings());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current).toMatchObject({
      thresholdCategory: 1,
      guidanceLinks: [],
      source: 'default',
      error: null,
    });
    expect(supabase.from).toHaveBeenCalledWith('organization_heat_settings');
    expect(b.eq).toHaveBeenCalledWith('organization_id', 'org-1');
  });

  it('reads a stored row as configured', async () => {
    vi.mocked(supabase.from).mockReturnValue(
      /** @type {any} */ (
        reads({
          data: {
            threshold_category: 3,
            guidance_links: [{ label: 'League', url: 'https://example.org/l' }],
          },
          error: null,
        })
      )
    );
    const { result } = renderHook(() => useOrgHeatSettings());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current).toMatchObject({
      thresholdCategory: 3,
      guidanceLinks: [{ label: 'League', url: 'https://example.org/l' }],
      source: 'configured',
    });
  });

  it('a failed read is an error, not a default', async () => {
    vi.mocked(supabase.from).mockReturnValue(
      /** @type {any} */ (reads({ data: null, error: { message: 'permission denied' } }))
    );
    const { result } = renderHook(() => useOrgHeatSettings());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe('permission denied');
  });

  it('a stored row the schema rejects is an error', async () => {
    vi.mocked(supabase.from).mockReturnValue(
      /** @type {any} */ (
        reads({ data: { threshold_category: 7, guidance_links: [] }, error: null })
      )
    );
    const { result } = renderHook(() => useOrgHeatSettings());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toMatch(/Stored heat settings are invalid/);
  });

  it('save refuses an invalid payload without calling the RPC', async () => {
    vi.mocked(supabase.from).mockReturnValue(
      /** @type {any} */ (reads({ data: null, error: null }))
    );
    const { result } = renderHook(() => useOrgHeatSettings());
    await waitFor(() => expect(result.current.loading).toBe(false));
    /** @type {any} */
    let out;
    await act(async () => {
      out = await result.current.save({
        thresholdCategory: 1,
        guidanceLinks: [{ label: 'x', url: 'http://example.org' }],
      });
    });
    expect(out).toMatchObject({ ok: false });
    expect(out.error).toMatch(/https/);
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it('save calls the RPC with trimmed values and reloads', async () => {
    vi.mocked(supabase.from).mockReturnValue(
      /** @type {any} */ (
        reads(
          { data: null, error: null },
          { data: { threshold_category: 2, guidance_links: [] }, error: null }
        )
      )
    );
    vi.mocked(supabase.rpc).mockResolvedValue(/** @type {any} */ ({ data: {}, error: null }));
    const { result } = renderHook(() => useOrgHeatSettings());
    await waitFor(() => expect(result.current.loading).toBe(false));
    /** @type {any} */
    let out;
    await act(async () => {
      out = await result.current.save({
        thresholdCategory: 2,
        guidanceLinks: [{ label: ' L ', url: ' https://example.org ' }],
      });
    });
    expect(out).toEqual({ ok: true });
    expect(supabase.rpc).toHaveBeenCalledWith('admin_set_org_heat_settings', {
      p_organization_id: 'org-1',
      p_threshold_category: 2,
      p_guidance_links: [{ label: 'L', url: 'https://example.org' }],
    });
    await waitFor(() => expect(result.current.source).toBe('configured'));
    expect(result.current.thresholdCategory).toBe(2);
  });

  it('save surfaces the RPC refusal', async () => {
    vi.mocked(supabase.from).mockReturnValue(
      /** @type {any} */ (reads({ data: null, error: null }))
    );
    vi.mocked(supabase.rpc).mockResolvedValue(
      /** @type {any} */ ({ data: null, error: { code: '42501', message: 'Access denied' } })
    );
    const { result } = renderHook(() => useOrgHeatSettings());
    await waitFor(() => expect(result.current.loading).toBe(false));
    /** @type {any} */
    let out;
    await act(async () => {
      out = await result.current.save({ thresholdCategory: 1, guidanceLinks: [] });
    });
    expect(out).toEqual({ ok: false, error: 'Access denied' });
  });

  it('an organisation going away drops its category and links', async () => {
    vi.mocked(supabase.from).mockReturnValue(
      /** @type {any} */ (
        reads({
          data: {
            threshold_category: 3,
            guidance_links: [{ label: 'League', url: 'https://example.org/heat' }],
          },
          error: null,
        })
      )
    );
    const { result, rerender } = renderHook(() => useOrgHeatSettings());
    await waitFor(() => expect(result.current.source).toBe('configured'));
    vi.mocked(useOrganization).mockReturnValue(/** @type {any} */ ({ currentOrganization: null }));
    rerender();
    await waitFor(() => expect(result.current.source).toBe('default'));
    expect(result.current).toMatchObject({ thresholdCategory: 1, guidanceLinks: [] });
  });
});
