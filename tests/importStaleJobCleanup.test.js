import { beforeEach, describe, expect, it } from 'vitest';
import { getMockData, mockSupabase as supabase } from '../frontend/src/lib/mockSupabaseClient.js';
import { MOCK_ORG_ID } from '../frontend/src/lib/mockSeedIds.js';

describe('mock stale import job cleanup', () => {
  beforeEach(() => {
    sessionStorage.clear();
    window.__MOCK_DB__ = undefined;
  });

  it('fails stale active jobs without touching recent, ready, or cross-org jobs', async () => {
    await supabase.from('import_jobs').insert([
      {
        id: 'mock-stale-importing-job',
        created_by: 'mock-admin-id',
        organization_id: MOCK_ORG_ID,
        job_type: 'registration',
        storage_path: 'imports/mock-admin-id/stale.csv',
        status: 'importing',
        total_rows: 10,
        processed_rows: 5,
        progress_percent: 50,
        last_heartbeat_at: '2026-05-03T11:00:00.000Z',
      },
      {
        id: 'mock-recent-importing-job',
        created_by: 'mock-admin-id',
        organization_id: MOCK_ORG_ID,
        job_type: 'registration',
        storage_path: 'imports/mock-admin-id/recent.csv',
        status: 'importing',
        total_rows: 10,
        processed_rows: 9,
        progress_percent: 90,
        last_heartbeat_at: '2026-05-03T12:05:00.000Z',
      },
      {
        id: 'mock-ready-field-job',
        created_by: 'mock-admin-id',
        organization_id: MOCK_ORG_ID,
        job_type: 'fields',
        storage_path: 'imports/mock-admin-id/ready.csv',
        status: 'ready_to_apply',
        total_rows: 1,
        processed_rows: 1,
        progress_percent: 100,
        last_heartbeat_at: '2026-05-03T11:00:00.000Z',
      },
      {
        id: 'mock-other-org-stale-job',
        created_by: 'mock-admin-id',
        organization_id: 'org-2',
        job_type: 'registration',
        storage_path: 'imports/mock-admin-id/other.csv',
        status: 'importing',
        total_rows: 1,
        processed_rows: 0,
        progress_percent: 0,
        last_heartbeat_at: '2026-05-03T11:00:00.000Z',
      },
    ]);

    const { data, error } = await supabase.rpc('fail_stale_import_jobs', {
      p_organization_id: MOCK_ORG_ID,
      p_stale_before: '2026-05-03T12:00:00.000Z',
    });

    expect(error).toBeNull();
    expect(data.failed_jobs).toBe(1);
    expect(data.job_ids).toEqual(['mock-stale-importing-job']);

    const jobs = getMockData('import_jobs');
    expect(jobs.find((job) => job.id === 'mock-stale-importing-job')?.status).toBe('failed');
    expect(
      jobs.find((job) => job.id === 'mock-stale-importing-job')?.error_summary?.stale_cleanup
        ?.previous_status
    ).toBe('importing');
    expect(jobs.find((job) => job.id === 'mock-recent-importing-job')?.status).toBe('importing');
    expect(jobs.find((job) => job.id === 'mock-ready-field-job')?.status).toBe('ready_to_apply');
    expect(jobs.find((job) => job.id === 'mock-other-org-stale-job')?.status).toBe('importing');
    expect(
      getMockData('audit_log').some(
        (event) => event.action === 'import.failed' && event.metadata?.stage === 'stale_cleanup'
      )
    ).toBe(true);
  });

  it('does not persist a no-op cleanup over session-scoped test data', async () => {
    const sessionOnlyRun = {
      id: 'run-1',
      organization_id: MOCK_ORG_ID,
      run_type: 'team',
      status: 'completed',
      results: {
        teams: [{ id: 't1', name: 'Team A' }],
        team_players: [{ team_id: 't1', player_id: '0' }],
      },
    };
    const staleWindowRun = {
      id: 'run-1',
      organization_id: MOCK_ORG_ID,
      run_type: 'team',
      status: 'completed',
      results: {
        teams: [{ id: 't1', name: 'Team A' }],
        team_players: [],
      },
    };

    sessionStorage.setItem('__MOCK_DB__', JSON.stringify({ scheduler_runs: [sessionOnlyRun] }));
    window.__MOCK_DB__ = { scheduler_runs: [staleWindowRun] };

    const { data, error } = await supabase.rpc('fail_stale_import_jobs', {
      p_organization_id: MOCK_ORG_ID,
      p_stale_before: '2026-05-03T12:00:00.000Z',
    });

    expect(error).toBeNull();
    expect(data.failed_jobs).toBe(0);
    expect(
      JSON.parse(sessionStorage.getItem('__MOCK_DB__')).scheduler_runs[0].results.team_players
    ).toHaveLength(1);
  });
});
