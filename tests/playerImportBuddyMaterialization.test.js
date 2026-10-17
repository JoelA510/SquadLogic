import { beforeEach, describe, expect, it } from 'vitest';
import { getMockData, mockSupabase as supabase } from '../frontend/src/lib/mockSupabaseClient.js';
import { MOCK_ORG_ID } from '../frontend/src/lib/mockSeedIds.js';

describe('mock player import buddy materialization', () => {
  beforeEach(() => {
    sessionStorage.clear();
    window.__MOCK_DB__ = undefined;
  });

  it('stages player rows, applies them, and materializes reciprocal buddy requests', async () => {
    const { data: job } = await supabase
      .from('import_jobs')
      .insert({
        id: 'mock-buddy-import-job',
        created_by: 'mock-admin-id',
        organization_id: MOCK_ORG_ID,
        job_type: 'registration',
        storage_path: 'imports/mock-admin-id/players.csv',
        status: 'importing',
        total_rows: 2,
        processed_rows: 0,
        progress_percent: 0,
      })
      .select();
    const jobId = job.id;

    const { data: validationResult, error: validationError } = await supabase.functions.invoke(
      'import-validation',
      {
        body: {
          import_type: 'players',
          organization_id: MOCK_ORG_ID,
          rows: [
            {
              'First Name': 'Avery',
              'Last Name': 'Adams',
              'Date of Birth': '2016-04-02',
              'Registration ID': 'GS-BUDDY-A',
              Division: 'U8 Coed',
              'Buddy ID': 'GS-BUDDY-B',
            },
            {
              'First Name': 'Blair',
              'Last Name': 'Bennett',
              'Date of Birth': '2016-05-03',
              'Registration ID': 'GS-BUDDY-B',
              Division: 'U8 Coed',
              'Buddy ID': 'GS-BUDDY-A',
            },
          ],
          file_name: 'players.csv',
          import_job_id: jobId,
          row_offset: 0,
        },
      }
    );

    expect(validationError).toBeNull();
    expect(validationResult.staged_rows).toBe(2);
    expect(getMockData('staging_players', 'import_job_id', jobId)).toHaveLength(2);

    const { data: finalizeResult, error: finalizeError } = await supabase.rpc(
      'finalize_import_job',
      {
        p_import_job_id: jobId,
        p_validation_errors: [],
      }
    );

    expect(finalizeError).toBeNull();
    expect(finalizeResult.inserted_players).toBe(2);

    const { data: buddyResult, error: buddyError } = await supabase.rpc(
      'materialize_import_buddy_pairs',
      { p_import_job_id: jobId }
    );

    expect(buddyError).toBeNull();
    expect(buddyResult.materialized_pairs).toBe(1);
    expect(buddyResult.inserted_relationships).toBe(2);
    expect(getMockData('player_buddies', 'source_import_job', jobId)).toHaveLength(2);

    const { data: rerunResult, error: rerunError } = await supabase.rpc(
      'materialize_import_buddy_pairs',
      { p_import_job_id: jobId }
    );

    expect(rerunError).toBeNull();
    expect(rerunResult.inserted_relationships).toBe(0);
    expect(getMockData('player_buddies', 'source_import_job', jobId)).toHaveLength(2);
  });

  it('materializes players who share a mutual buddy code', async () => {
    const { data: job } = await supabase
      .from('import_jobs')
      .insert({
        id: 'mock-buddy-code-import-job',
        created_by: 'mock-admin-id',
        organization_id: MOCK_ORG_ID,
        job_type: 'registration',
        storage_path: 'imports/mock-admin-id/players-buddy-code.csv',
        status: 'importing',
        total_rows: 2,
        processed_rows: 0,
        progress_percent: 0,
      })
      .select();
    const jobId = job.id;

    const { data: validationResult, error: validationError } = await supabase.functions.invoke(
      'import-validation',
      {
        body: {
          import_type: 'players',
          organization_id: MOCK_ORG_ID,
          rows: [
            {
              'First Name': 'Emery',
              'Last Name': 'Evans',
              'Date of Birth': '2016-08-06',
              'Registration ID': 'GS-BUDDY-E',
              Division: 'U8 Coed',
              'Mutual Buddy Code': 'PAIR-CODE',
            },
            {
              'First Name': 'Finley',
              'Last Name': 'Foster',
              'Date of Birth': '2016-09-07',
              'Registration ID': 'GS-BUDDY-F',
              Division: 'U8 Coed',
              'Mutual Buddy Code': 'PAIR-CODE',
            },
          ],
          file_name: 'players-buddy-code.csv',
          import_job_id: jobId,
          row_offset: 0,
        },
      }
    );

    expect(validationError).toBeNull();
    expect(validationResult.staged_rows).toBe(2);

    const { error: finalizeError } = await supabase.rpc('finalize_import_job', {
      p_import_job_id: jobId,
      p_validation_errors: [],
    });
    expect(finalizeError).toBeNull();

    const { data: buddyResult, error: buddyError } = await supabase.rpc(
      'materialize_import_buddy_pairs',
      { p_import_job_id: jobId }
    );

    expect(buddyError).toBeNull();
    expect(buddyResult.materialized_pairs).toBe(1);
    expect(buddyResult.invalid_code_groups).toBe(0);
    expect(getMockData('player_buddies', 'source_import_job', jobId)).toHaveLength(2);
  });
});
