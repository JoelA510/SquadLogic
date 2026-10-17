/**
 * A Realtime UPDATE for an import job is applied only to the job the panel is
 * running (found by M4.1's real-backend re-import scenario, PR #578).
 *
 * The handler used to apply a completed/failed UPDATE whenever no job was
 * active. After "Upload Another File" reset the panel, a late UPDATE for the
 * previous job then put its "Import Applied" back over the file the operator
 * had just chosen, so a quick second import was bounced. The mock client has
 * no Realtime, so no mock E2E scenario could see it.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { ImportProvider, useImport } from '../frontend/src/contexts/ImportContext.jsx';
import { MOCK_ORG_ID } from '../frontend/src/lib/mockSeedIds.js';

vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: () => ({
    currentOrganization: { id: MOCK_ORG_ID },
    orgMember: { id: 'member-1', role: 'admin' },
  }),
}));

const mocks = vi.hoisted(() => ({
  /** @type {Array<(payload: { new: Record<string, unknown> }) => void>} */
  handlers: [],
  /** Rows `import_jobs` reads return (the rehydration query). */
  activeJobs: /** @type {Record<string, unknown>[]} */ ([]),
}));

/** A PostgREST-style builder: every method chains, awaiting it gives the rows. */
function query(rows) {
  const builder = {
    select: () => builder,
    eq: () => builder,
    in: () => builder,
    order: () => builder,
    limit: () => builder,
    then: (resolve) => resolve({ data: rows, error: null }),
  };
  return builder;
}

vi.mock('../frontend/src/lib/supabaseClient.js', () => ({
  supabase: {
    rpc: vi.fn(async () => ({ data: null, error: null })),
    auth: {
      getUser: vi.fn(async () => ({ data: { user: { id: 'user-1' } }, error: null })),
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
    },
    from: vi.fn((table) => query(table === 'import_jobs' ? mocks.activeJobs : [])),
    channel: vi.fn(() => {
      const channel = {
        on: vi.fn((_type, _filter, handler) => {
          mocks.handlers.push(handler);
          return channel;
        }),
        subscribe: vi.fn(),
      };
      return channel;
    }),
    removeChannel: vi.fn(),
    functions: { invoke: vi.fn() },
  },
}));

/** Delivers an UPDATE to the handler of the most recent subscription. */
function deliver(job) {
  const handler = mocks.handlers[mocks.handlers.length - 1];
  expect(handler, 'the provider subscribed to import_jobs').toBeTypeOf('function');
  act(() => handler({ new: job }));
}

const wrapper = ({ children }) => <ImportProvider>{children}</ImportProvider>;

describe('ImportContext Realtime: only the active job moves the panel', () => {
  beforeEach(() => {
    mocks.handlers.length = 0;
    mocks.activeJobs = [];
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('a late UPDATE for the previous job leaves a reset panel alone', async () => {
    // A reload after a completed import: the panel remembers "completed".
    localStorage.setItem('importStatus', 'completed');
    const { result } = renderHook(() => useImport(), { wrapper });
    expect(result.current.importStatus).toBe('completed');

    // "Upload Another File".
    await act(async () => {
      await result.current.resetImport('all');
    });
    expect(result.current.importStatus).toBe('idle');

    // The previous job's last UPDATE arrives after the reset.
    deliver({ id: 'previous-job', status: 'completed' });
    expect(result.current.importStatus).toBe('idle');
  });

  it('the completion of the job the panel rehydrated still lands', async () => {
    // A reload while a job is mid-import: it is rehydrated as the active job.
    mocks.activeJobs = [{ id: 'running-job', status: 'processing', progress_percent: 40 }];
    const { result } = renderHook(() => useImport(), { wrapper });
    await waitFor(() => expect(result.current.importStatus).toBe('importing'));

    deliver({ id: 'some-other-job', status: 'failed' });
    expect(result.current.importStatus).toBe('importing');

    deliver({ id: 'running-job', status: 'completed_with_warnings' });
    expect(result.current.importStatus).toBe('completed_with_warnings');
  });
});
