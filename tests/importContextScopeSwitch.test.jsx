/**
 * E3 of F11-3 (schedule expansion PR 6, review follow-up 1): `ImportContext` is mounted once for the whole app, so
 * what it holds about an import (the job in flight, and each type's last import with its `importJobId`) must not
 * outlive a switch of organization. Reproduced here first, over the real mock client: an organization with
 * an import in flight and a coach import on record, then a switch to an organization with neither.
 */
import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { seedMockDb } from './helpers/seedMockDb.js';

const ORG_A = 'org-import-a';
const ORG_B = 'org-import-b';
const scope = vi.hoisted(() => ({ org: 'org-import-a', season: 'season-a' }));

vi.mock('../frontend/src/lib/supabaseClient.js', async () => {
  const { mockSupabase } = await import('../frontend/src/lib/mockSupabaseClient.js');
  return { supabase: mockSupabase };
});
vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: () => ({
    currentOrganization: { id: scope.org },
    currentSeasonSetting: { id: scope.season, status: 'active' },
    orgMember: { id: 'member-1', role: 'admin' },
  }),
}));
vi.mock('../frontend/src/lib/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), log: vi.fn(), debug: vi.fn() },
}));

const { ImportProvider, useImport } = await import('../frontend/src/contexts/ImportContext.jsx');

beforeEach(() => {
  sessionStorage.clear();
  delete window.__MOCK_DB__;
  scope.org = ORG_A;
  scope.season = 'season-a';
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
        status: 'importing',
        progress_percent: 40,
        created_at: new Date().toISOString(),
        started_at: new Date().toISOString(),
        last_heartbeat_at: new Date().toISOString(),
      },
    ],
    imports: [
      {
        id: 'imp-a',
        organization_id: ORG_A,
        user_id: 'mock-admin-id',
        import_type: 'coaches',
        file_name: 'coaches.csv',
        data: { importJobId: 'job-a-earlier', data: [{ full_name: 'Placeholder Coach' }] },
        created_at: '2026-10-01T00:00:00Z',
      },
    ],
  });
  sessionStorage.setItem(
    '__MOCK_SESSION__',
    JSON.stringify({ user: { id: 'mock-admin-id', email: 'admin@example.com' } })
  );
});

async function mountInA() {
  const hook = renderHook(() => useImport(), {
    wrapper: ({ children }) => <ImportProvider>{children}</ImportProvider>,
  });
  await waitFor(() => expect(hook.result.current.activeJob?.id).toBe('job-a'));
  await waitFor(() =>
    expect(hook.result.current.importedCoaches?.importJobId).toBe('job-a-earlier')
  );
  return hook;
}
/** Let every read the switch starts answer. */
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 50)));

describe('ImportContext forgets one scope’s import when the scope changes', () => {
  it('a switch of organization: the job in flight and the last coach import are not the new one’s', async () => {
    const hook = await mountInA();
    scope.org = ORG_B;
    hook.rerender();
    await settle();
    expect(hook.result.current.activeJob).toBeNull();
    expect(hook.result.current.activeJobId).toBeNull();
    expect(hook.result.current.importedCoaches).toBeNull();
    expect(hook.result.current.isImporting).toBe(false);
  });

  it('a switch of season keeps the organization’s import: the job and the import on record are the organization’s', async () => {
    const hook = await mountInA();
    scope.season = 'season-b';
    hook.rerender();
    await settle();
    // `import_jobs` and `imports` are read by organization, and the job carries its own season to its apply: a switch
    // of season shows no other organization's data, so nothing is reset (the brief's "or season", checked and dropped).
    await waitFor(() => expect(hook.result.current.activeJob?.id).toBe('job-a'));
    expect(hook.result.current.importedCoaches?.importJobId).toBe('job-a-earlier');
  });

  it('CONTROL: switching back reads the first organization’s import again', async () => {
    const hook = await mountInA();
    scope.org = ORG_B;
    hook.rerender();
    await settle();
    scope.org = ORG_A;
    hook.rerender();
    await waitFor(() => expect(hook.result.current.activeJob?.id).toBe('job-a'));
  });
});
