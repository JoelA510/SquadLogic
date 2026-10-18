import { beforeEach, describe, expect, it } from 'vitest';
import { getMockData, mockSupabase as supabase } from '../frontend/src/lib/mockSupabaseClient.js';
import { MOCK_ORG_ID } from '../frontend/src/lib/mockSeedIds.js';

describe('mock field import apply and rollback', () => {
  beforeEach(() => {
    sessionStorage.clear();
    window.__MOCK_DB__ = undefined;
  });

  it('stages field slot rows, applies them, and rolls them back', async () => {
    const { data: job } = await supabase
      .from('import_jobs')
      .insert({
        id: 'mock-field-import-job',
        created_by: 'mock-admin-id',
        organization_id: MOCK_ORG_ID,
        job_type: 'fields',
        storage_path: 'imports/mock-admin-id/fields.csv',
        status: 'importing',
        total_rows: 1,
        processed_rows: 0,
        progress_percent: 0,
      })
      .select();
    const jobId = job.id;

    const { data: validationResult, error: validationError } = await supabase.functions.invoke(
      'import-validation',
      {
        body: {
          import_type: 'fields',
          organization_id: MOCK_ORG_ID,
          rows: [
            {
              Location: 'Main Park',
              Field: 'Imported Field',
              Subunit: 'A',
              Type: 'practice',
              Day: 'Mon',
              Start: '17:30',
              End: '18:30',
              Capacity: '1',
              'Valid From': '2026-03-01',
              'Valid Until': '2026-05-31',
            },
          ],
          import_job_id: jobId,
          row_offset: 0,
        },
      }
    );

    expect(validationError).toBeNull();
    expect(validationResult.staged_rows).toBe(1);
    expect(getMockData('staging_import_rows', 'import_job_id', jobId)).toHaveLength(1);

    const { data: finalizeResult, error: finalizeError } = await supabase.rpc(
      'finalize_field_import_job',
      {
        p_import_job_id: jobId,
        p_validation_errors: [],
      }
    );

    expect(finalizeError).toBeNull();
    expect(finalizeResult.inserted_fields).toBe(1);
    expect(finalizeResult.inserted_practice_slots).toBe(1);
    expect(getMockData('fields').some((field) => field.name === 'Imported Field')).toBe(true);
    expect(getMockData('practice_slots').some((slot) => slot.start_time === '17:30')).toBe(true);

    const { data: rollbackResult, error: rollbackError } = await supabase.rpc(
      'rollback_field_import_job',
      { p_import_job_id: jobId }
    );

    expect(rollbackError).toBeNull();
    expect(rollbackResult.deleted_fields).toBe(1);
    expect(rollbackResult.deleted_practice_slots).toBe(1);
    expect(getMockData('fields').some((field) => field.name === 'Imported Field')).toBe(false);
  });

  it('can cancel a deferred field import without applying domain rows', async () => {
    const { data: job } = await supabase
      .from('import_jobs')
      .insert({
        id: 'mock-deferred-field-import-job',
        created_by: 'mock-admin-id',
        organization_id: MOCK_ORG_ID,
        job_type: 'fields',
        storage_path: 'imports/mock-admin-id/fields.csv',
        status: 'importing',
        total_rows: 1,
        processed_rows: 0,
        progress_percent: 0,
      })
      .select();
    const jobId = job.id;

    await supabase.functions.invoke('import-validation', {
      body: {
        import_type: 'fields',
        organization_id: MOCK_ORG_ID,
        rows: [
          {
            Location: 'Cancel Park',
            Field: 'Canceled Field',
            Type: 'practice',
            Day: 'Tue',
            Start: '18:00',
            End: '19:00',
          },
        ],
        import_job_id: jobId,
        row_offset: 0,
      },
    });

    const { data: readyResult, error: readyError } = await supabase.rpc(
      'mark_import_job_ready_to_apply',
      {
        p_import_job_id: jobId,
        p_import_type: 'fields',
        p_validation_errors: [],
      }
    );

    expect(readyError).toBeNull();
    expect(readyResult.status).toBe('ready_to_apply');

    const { data: cancelResult, error: cancelError } = await supabase.rpc(
      'cancel_ready_import_job',
      {
        p_import_job_id: jobId,
        p_import_type: 'fields',
      }
    );

    expect(cancelError).toBeNull();
    expect(cancelResult.status).toBe('canceled');
    expect(getMockData('fields').some((field) => field.name === 'Canceled Field')).toBe(false);
    expect(getMockData('import_application_records', 'import_job_id', jobId)).toHaveLength(0);
  });
});
