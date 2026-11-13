/**
 * Review R2 and R5 of F11-3's E3 fix (`ImportContext`'s reset on a switch of organization):
 *
 * - R2: the organization arrives from null on every page load (OrganizationContext starts empty) and can blink to null
 *   mid-import. Neither is a switch: only one organization replaced by ANOTHER resets the import state.
 * - R5: a load answering for the old organization writes nothing, at whatever await it was when the switch happened:
 *   held here inside the hydration of a ready evaluations job (its preview, `finalize_evaluation_import_job`).
 */
import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { seedMockDb } from './helpers/seedMockDb.js';

const ORG_A = 'org-guard-a';
const ORG_B = 'org-guard-b';
const scope = vi.hoisted(() => ({ org: /** @type {string | null} */ ('org-guard-a') }));
vi.mock('../frontend/src/lib/supabaseClient.js', async () => {
  const { mockSupabase } = await import('../frontend/src/lib/mockSupabaseClient.js');
  return { supabase: mockSupabase };
});
vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: () => ({
    currentOrganization: scope.org ? { id: scope.org } : null,
    currentSeasonSetting: { id: 'season-1', status: 'active' },
    orgMember: scope.org ? { id: 'member-1', role: 'admin' } : null,
  }),
}));
vi.mock('../frontend/src/lib/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), log: vi.fn(), debug: vi.fn() },
}));

const { ImportProvider, useImport } = await import('../frontend/src/contexts/ImportContext.jsx');
const { mockSupabase } = await import('../frontend/src/lib/mockSupabaseClient.js');

const now = () => new Date().toISOString();
function seed(job, extraJobs = []) {
  sessionStorage.clear();
  localStorage.clear();
  delete window.__MOCK_DB__;
  seedMockDb({
    organizations: [
      { id: ORG_A, name: 'Org A' },
      { id: ORG_B, name: 'Org B' },
    ],
    organization_members: [
      { organization_id: ORG_A, profile_id: 'mock-admin-id', role: 'admin' },
      { organization_id: ORG_B, profile_id: 'mock-admin-id', role: 'admin' },
    ],
    import_jobs: [
      {
        id: 'job-a',
        organization_id: ORG_A,
        job_type: 'coaches',
        created_at: now(),
        started_at: now(),
        last_heartbeat_at: now(),
        progress_percent: 40,
        ...job,
      },
      ...extraJobs,
    ],
    imports: [],
  });
  sessionStorage.setItem(
    '__MOCK_SESSION__',
    JSON.stringify({ user: { id: 'mock-admin-id', email: 'admin@example.com' } })
  );
}
const mount = () =>
  renderHook(() => useImport(), {
    wrapper: ({ children }) => <ImportProvider>{children}</ImportProvider>,
  });
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 60)));

beforeEach(() => {
  scope.org = ORG_A;
  vi.restoreAllMocks();
});

describe('R2: null is not an organization', () => {
  it('a reload whose organization arrives from null keeps the stored import status', async () => {
    seed({ status: 'completed' });
    localStorage.setItem('importStatus', 'completed');
    scope.org = null;
    const hook = mount();
    expect(hook.result.current.importStatus).toBe('completed');
    scope.org = ORG_A;
    hook.rerender();
    await settle();
    expect(hook.result.current.importStatus).toBe('completed');
    expect(localStorage.getItem('importStatus')).toBe('completed');
  });

  it('a blink to null mid-import keeps the import', async () => {
    seed({ status: 'importing' });
    const hook = mount();
    await waitFor(() => expect(hook.result.current.activeJob?.id).toBe('job-a'));
    scope.org = null;
    hook.rerender();
    await settle();
    scope.org = ORG_A;
    hook.rerender();
    await settle();
    expect(hook.result.current.activeJob?.id).toBe('job-a');
    expect(hook.result.current.isImporting).toBe(true);
  });

  it('CONTROL: a real switch to another organization resets, logs included', async () => {
    // A stale job of org A: the load fails it and says so in the import log.
    const old = '2020-01-01T00:00:00Z';
    seed({ status: 'importing' }, [
      {
        id: 'job-a-stale',
        organization_id: ORG_A,
        job_type: 'coaches',
        status: 'importing',
        created_at: old,
        started_at: old,
        last_heartbeat_at: old,
      },
    ]);
    const hook = mount();
    await waitFor(() => expect(hook.result.current.importLogs.length).toBeGreaterThan(0));
    scope.org = ORG_B;
    hook.rerender();
    await settle();
    expect(hook.result.current.activeJob).toBeNull();
    expect(hook.result.current.importLogs).toEqual([]);
  });
});

describe('R5: a load for the old organization writes nothing, wherever it was waiting', () => {
  it('a switch while a ready job is being hydrated leaves nothing of the old organization', async () => {
    seed({ status: 'ready_to_apply', job_type: 'evaluations' });
    const realRpc = mockSupabase.rpc.bind(mockSupabase);
    /** @type {(value?: unknown) => void} */
    let release = () => {};
    const held = new Promise((resolve) => (release = resolve));
    let reached = false;
    vi.spyOn(mockSupabase, 'rpc').mockImplementation(async (name, params) => {
      if (name === 'finalize_evaluation_import_job') {
        reached = true;
        await held;
      }
      return realRpc(name, params);
    });
    const hook = mount();
    await waitFor(() => expect(reached).toBe(true));
    scope.org = ORG_B;
    hook.rerender();
    await settle();
    await act(async () => release());
    await settle();
    expect(hook.result.current.activeJob).toBeNull();
    expect(hook.result.current.activeJobId).toBeNull();
    expect(hook.result.current.importStatus).not.toBe('ready_to_apply');
    expect(hook.result.current.importedEvaluations).toBeNull();
  });
});
