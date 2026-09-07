import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { ImportProvider, useImport } from '../frontend/src/contexts/ImportContext.jsx';
import { getMockData, mockSupabase } from '../frontend/src/lib/mockSupabaseClient.js';

/**
 * The DIRECT apply path, which is the twin of the deferred one.
 *
 * `applyDeferredImport` and `startImport` call the same finalize RPCs. The
 * refusal reporting was added to the deferred path first, and the direct path
 * -- the one behind ImportPanel's ordinary "import this CSV" button -- went on
 * printing only its insert counts. So an operator importing a CSV whose venue
 * names match no field saw "Field availability updated: 0 profiles" and
 * "check the import log", with nothing in the log to check.
 *
 * A control confirmed the gap was real and unguarded: removing the reporting
 * from this arm left the whole suite green before this file existed.
 *
 * It runs against the real mock Supabase client rather than `vi.fn()` stubs, so
 * create_import_job, the staging edge function and the finalize RPC all behave
 * as they do in mock/E2E mode -- the refusal under test is produced by the code
 * under test, not fabricated by the test.
 */
const mocks = vi.hoisted(() => ({ parse: vi.fn() }));

vi.mock('papaparse', () => ({
  default: { parse: mocks.parse },
}));

vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: () => ({
    currentOrganization: { id: 'org-1' },
    orgMember: { id: 'member-1' },
  }),
}));

const HEADERS = ['season_label', 'location', 'name', 'available_from', 'available_until'];

const row = (location, name) => ({
  season_label: 'Fall 2026',
  location,
  name,
  available_from: '2026-08-01',
  available_until: '2026-11-30',
});

describe('ImportContext direct apply :: refused rows reach the operator', () => {
  beforeEach(async () => {
    sessionStorage.clear();
    window.__MOCK_DB__ = undefined;
    mocks.parse.mockReset();
    // `startImport` refuses without an authenticated user, so the flow under
    // test is only reachable from a signed-in session.
    await mockSupabase.auth.signInWithPassword({
      email: 'admin@example.com',
      password: 'test-password-123',
    });
  });

  it('logs the refused count and the unresolved-field reason on the direct path', async () => {
    // One venue that exists in the mock seed, one that does not.
    const rows = [row('Central Park', 'Field 1'), row('Nowhere Park', 'Ghost Pitch')];
    mocks.parse.mockImplementation((_file, options) => {
      options.complete({ data: rows, meta: { fields: HEADERS } });
    });

    const wrapper = ({ children }) => <ImportProvider>{children}</ImportProvider>;
    const { result } = renderHook(() => useImport(), { wrapper });

    await act(async () => {
      await result.current.startImport(new File(['x'], 'availability.csv'), 'field_availability');
    });

    // The import really did refuse one row and apply the other -- asserted from
    // the mock tables rather than from what the test supplied.
    await waitFor(() => {
      expect(getMockData('field_availability_profiles').length).toBe(1);
    });
    expect(getMockData('field_availability_profiles')[0].field_id).toBeTruthy();

    const { describeFinalizeOutcome } =
      await import('../frontend/src/utils/importDeferredActions.js');
    const expected = describeFinalizeOutcome({ invalid_rows: 1, unresolved_field_rows: 1 });
    expect(expected).toHaveLength(2);

    await waitFor(() => {
      const messages = result.current.importLogs.map((entry) => entry.message);
      expected.forEach((line) => expect(messages).toContain(line));
    });
  });

  it('says nothing about refusals when every row resolved', async () => {
    mocks.parse.mockImplementation((_file, options) => {
      options.complete({ data: [row('Central Park', 'Field 1')], meta: { fields: HEADERS } });
    });

    const wrapper = ({ children }) => <ImportProvider>{children}</ImportProvider>;
    const { result } = renderHook(() => useImport(), { wrapper });

    await act(async () => {
      await result.current.startImport(new File(['x'], 'clean.csv'), 'field_availability');
    });

    await waitFor(() => {
      expect(getMockData('field_availability_profiles').length).toBe(1);
    });
    const messages = result.current.importLogs.map((entry) => entry.message);
    // The happy path must not print a refusal line at all -- a report that
    // fires on zero is how "0 rows were not applied" ends up alarming people.
    expect(messages.some((m) => m.includes('were not applied'))).toBe(false);
    expect(messages.some((m) => m.includes('does not have'))).toBe(false);
    // ... and the log is not empty, so the assertion above is not vacuous.
    expect(messages.length).toBeGreaterThan(0);
  });
});
