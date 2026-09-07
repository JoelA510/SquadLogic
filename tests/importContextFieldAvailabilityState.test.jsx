import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { ImportProvider, useImport } from '../frontend/src/contexts/ImportContext.jsx';

vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: () => ({
    currentOrganization: { id: 'org-1' },
    orgMember: { id: 'member-1' },
  }),
}));

vi.mock('../frontend/src/lib/supabaseClient.js', () => ({
  supabase: {
    rpc: vi.fn(),
    auth: {
      getUser: vi.fn(async () => ({ data: { user: { id: 'user-1' } }, error: null })),
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
    },
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          order: vi.fn(async () => ({ data: [], error: null })),
        })),
      })),
    })),
    channel: vi.fn(() => ({
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      send: vi.fn(),
    })),
    removeChannel: vi.fn(),
    functions: { invoke: vi.fn() },
  },
}));

describe('ImportContext field_availability state hygiene', () => {
  it("resetImport('all') clears importedFieldAvailability", async () => {
    const wrapper = ({ children }) => <ImportProvider>{children}</ImportProvider>;
    const { result } = renderHook(() => useImport(), { wrapper });

    act(() => {
      result.current.setImportedFieldAvailability({ importJobId: 'fa-job-1' });
    });

    expect(result.current.importedFieldAvailability).toEqual({ importJobId: 'fa-job-1' });

    await act(async () => {
      await result.current.resetImport('all');
    });

    expect(result.current.importedFieldAvailability).toBeNull();
  });

  /**
   * A row the server refused has to reach the operator.
   *
   * `completeImport` tells them to "check the import log" whenever a job
   * finishes with warnings, and for a server-side refusal that log had nothing
   * in it to check: the reasons are written to `staging_import_rows` and to the
   * job's `warning_summary`, and this flow reads neither. The counts come back
   * in the RPC result, so they are logged from there.
   */
  it('applying an import logs the rows the server refused and why', async () => {
    const { supabase } = await import('../frontend/src/lib/supabaseClient.js');
    supabase.rpc.mockImplementation(async (name) => {
      if (name === 'finalize_field_availability_import_job') {
        return {
          data: {
            status: 'completed_with_warnings',
            inserted_profiles: 12,
            invalid_rows: 3,
            unresolved_field_rows: 2,
          },
          error: null,
        };
      }
      return { data: null, error: null };
    });

    const wrapper = ({ children }) => <ImportProvider>{children}</ImportProvider>;
    const { result } = renderHook(() => useImport(), { wrapper });

    act(() => {
      result.current.setImportedFieldAvailability({ importJobId: 'fa-job-2' });
    });

    await act(async () => {
      await result.current.applyDeferredImport('field_availability');
    });

    const messages = result.current.importLogs.map((entry) => entry.message);
    expect(messages.length).toBeGreaterThan(0);
    expect(messages.some((m) => m.includes('3 row(s) were not applied and remain staged'))).toBe(
      true
    );
    expect(
      messages.some(
        (m) =>
          m.includes('2 of those named a field this organization does not have') &&
          m.includes('nothing was discarded')
      )
    ).toBe(true);
  });
});
