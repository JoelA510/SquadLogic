import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { ImportProvider, useImport } from '../frontend/src/contexts/ImportContext.jsx';
import { getMockData, mockSupabase } from '../frontend/src/lib/mockSupabaseClient.js';
import { MOCK_ORG_ID } from '../frontend/src/lib/mockSeedIds.js';

/**
 * An import keeps the uploaded file's name out of the audit trail.
 *
 * The audit log keeps no upload file names (owner decision 2026-10-14). The
 * name still forms the import job's `storage_path`, which the import reads
 * back, so `create_import_job` still takes it; but `import-validation` has not
 * read `file_name` since #577, and `create_import_job` stopped writing it into
 * its `import.started` audit row in 20261018000000. (The import panel's
 * telemetry write-back still sends it; that is recorded as an open question in
 * the remediation plan, not covered here.) This runs a real import
 * through the mock client (the mock's `create_import_job` mirrors the RPC) and
 * reads what was actually sent and stored.
 */
const mocks = vi.hoisted(() => ({ parse: vi.fn() }));

vi.mock('papaparse', () => ({
  default: { parse: mocks.parse },
}));

vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: () => ({
    currentOrganization: { id: MOCK_ORG_ID },
    orgMember: { id: 'member-1' },
  }),
}));

const HEADERS = ['season_label', 'location', 'name', 'available_from', 'available_until'];
const FILE_NAME = 'spring-availability.csv';

describe('an import keeps the file name out of the audit trail', () => {
  beforeEach(async () => {
    sessionStorage.clear();
    window.__MOCK_DB__ = undefined;
    mocks.parse.mockReset();
    await mockSupabase.auth.signInWithPassword({
      email: 'admin@example.com',
      password: 'test-password-123',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends no file_name to import-validation and audits import.started without one', async () => {
    mocks.parse.mockImplementation((_file, options) => {
      options.complete({
        data: [
          {
            season_label: 'Fall 2026',
            location: 'Central Park',
            name: 'Field 1',
            available_from: '2026-08-01',
            available_until: '2026-11-30',
          },
        ],
        meta: { fields: HEADERS },
      });
    });
    const invoke = vi.spyOn(mockSupabase.functions, 'invoke');

    const wrapper = ({ children }) => <ImportProvider>{children}</ImportProvider>;
    const { result } = renderHook(() => useImport(), { wrapper });

    await act(async () => {
      await result.current.startImport(new File(['x'], FILE_NAME), 'field_availability');
    });
    await waitFor(() => {
      expect(getMockData('field_availability_profiles').length).toBe(1);
    });

    // The validation request really went out, and carried the import's rows
    // and job, so the absent key below is not an absent request.
    const validationCalls = invoke.mock.calls.filter(([name]) => name === 'import-validation');
    expect(validationCalls.length).toBeGreaterThan(0);
    for (const [, options] of validationCalls) {
      const body = /** @type {{ body: Record<string, unknown> }} */ (options).body;
      expect(body.import_job_id).toBeTruthy();
      expect(body.rows).toHaveLength(1);
      expect(body).not.toHaveProperty('file_name');
    }

    // The job keeps the name in its storage path, which the import reads back.
    const jobs = getMockData('import_jobs');
    expect(jobs).toHaveLength(1);
    expect(jobs[0].storage_path).toMatch(new RegExp(`/${FILE_NAME.replace('.', '\\.')}$`));

    // Its import.started row names the import, and not the file.
    const started = getMockData('audit_log').filter(
      (row) => row.action === 'import.started' && row.resource_id === jobs[0].id
    );
    expect(started).toHaveLength(1);
    expect(started[0].metadata).toEqual({
      import_type: 'field_availability',
      job_type: 'field_availability',
      status: 'importing',
    });
    expect(JSON.stringify(getMockData('audit_log'))).not.toContain(FILE_NAME);
  });
});
