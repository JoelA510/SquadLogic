import { beforeEach, describe, expect, it } from 'vitest';
import { getMockData, mockSupabase as supabase } from '../frontend/src/lib/mockSupabaseClient.js';
import { MOCK_ORG_ID } from '../frontend/src/lib/mockSeedIds.js';

const signIn = (email) =>
  supabase.auth.signInWithPassword({
    email,
    password: 'test-password-123',
  });

describe('mock import job lifecycle RPCs', () => {
  beforeEach(() => {
    sessionStorage.clear();
    window.__MOCK_DB__ = undefined;
  });

  it('creates, updates, and fails import jobs through admin-only RPCs', async () => {
    await signIn('admin@example.com');

    const { data: job, error: createError } = await supabase.rpc('create_import_job', {
      p_organization_id: MOCK_ORG_ID,
      p_import_type: 'players',
      p_file_name: '../players:2026.csv',
    });

    expect(createError).toBeNull();
    expect(job.status).toBe('importing');
    expect(job.job_type).toBe('registration');
    expect(job.storage_path).toBe('imports/mock-admin-id/.._players_2026.csv');

    const { data: updatedJob, error: updateError } = await supabase.rpc(
      'update_import_job_progress',
      {
        p_import_job_id: job.id,
        p_progress_percent: 50,
        p_processed_rows: 5,
        p_total_rows: 10,
        p_efficiency_metadata: { efficiency: 99.2 },
      }
    );

    expect(updateError).toBeNull();
    expect(updatedJob.processed_rows).toBe(5);
    expect(updatedJob.progress_percent).toBe(50);
    expect(updatedJob.efficiency_metadata.efficiency).toBe(99.2);

    const { data: failedJob, error: failError } = await supabase.rpc('fail_import_job', {
      p_import_job_id: job.id,
      p_message: 'Validation failed',
      p_error_summary: { stage: 'validation' },
    });

    expect(failError).toBeNull();
    expect(failedJob.status).toBe('failed');
    expect(failedJob.error_summary.message).toBe('Validation failed');

    const auditRows = getMockData('audit_log').filter((event) => event.resource_id === job.id);
    expect(auditRows.some((event) => event.action === 'import.started')).toBe(true);
    expect(
      auditRows.some(
        (event) =>
          event.action === 'import.failed' &&
          event.metadata?.stage === 'validation' &&
          event.metadata?.previous_status === 'importing'
      )
    ).toBe(true);
  });

  it('rejects non-admin import lifecycle mutations', async () => {
    await signIn('admin@example.com');
    const { data: job } = await supabase.rpc('create_import_job', {
      p_organization_id: MOCK_ORG_ID,
      p_import_type: 'fields',
      p_file_name: 'fields.csv',
    });

    await signIn('coach@example.com');

    const { error: createError } = await supabase.rpc('create_import_job', {
      p_organization_id: MOCK_ORG_ID,
      p_import_type: 'players',
      p_file_name: 'denied.csv',
    });
    const { error: updateError } = await supabase.rpc('update_import_job_progress', {
      p_import_job_id: job.id,
      p_progress_percent: 10,
    });
    const { error: failError } = await supabase.rpc('fail_import_job', {
      p_import_job_id: job.id,
      p_message: 'Denied',
    });

    expect(createError?.message).toMatch(/admins/);
    expect(updateError?.message).toMatch(/admins/);
    expect(failError?.message).toMatch(/admins/);
    expect(getMockData('import_jobs').find((item) => item.id === job.id)?.status).toBe('importing');
  });
});
