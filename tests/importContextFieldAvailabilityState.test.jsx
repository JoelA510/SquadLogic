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

// The rpc spy is held here rather than reached for through the mocked module:
// `checkJs` types that import as the real client, where `rpc` returns a
// PostgrestFilterBuilder, so a test that sets its implementation through the
// import does not type-check. This is the pattern the other context tests in
// this directory use.
const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));

vi.mock('../frontend/src/lib/supabaseClient.js', () => ({
  supabase: {
    rpc: mocks.rpc,
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
    mocks.rpc.mockImplementation(async (name) => {
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

    // **What this asserts is that the lines REACH the log.** The wording is
    // `describeFinalizeOutcome`'s to own and is asserted against literals in
    // tests/importFinalizeOutcome.test.js -- restating it here would make two
    // places to change and neither the authority.
    const { describeFinalizeOutcome } =
      await import('../frontend/src/utils/importDeferredActions.js');
    const expected = describeFinalizeOutcome(
      { invalid_rows: 3, unresolved_field_rows: 2 },
      'field_availability'
    );
    expect(expected.length).toBe(2);
    const messages = result.current.importLogs.map((entry) => entry.message);
    expect(messages.length).toBeGreaterThan(0);
    expected.forEach((line) => expect(messages).toContain(line));
  });
});
