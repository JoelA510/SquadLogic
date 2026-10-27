import { beforeEach, describe, expect, it } from 'vitest';
import { getMockData, mockSupabase as supabase } from '../frontend/src/lib/mockSupabaseClient.js';
import { MOCK_ORG_ID } from '../frontend/src/lib/mockSeedIds.js';

describe('mock coach import apply and rollback', () => {
  beforeEach(() => {
    sessionStorage.clear();
    window.__MOCK_DB__ = undefined;
  });

  it('stages coach validation rows, applies them, and rolls them back', async () => {
    const { data: job } = await supabase
      .from('import_jobs')
      .insert({
        id: 'mock-coach-import-job',
        created_by: 'mock-admin-id',
        organization_id: MOCK_ORG_ID,
        job_type: 'registration',
        storage_path: 'imports/mock-admin-id/coaches.csv',
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
          import_type: 'coaches',
          organization_id: MOCK_ORG_ID,
          rows: [
            {
              full_name: 'CSV Coach',
              email: 'csvcoach@example.com',
              phone: '555-1212',
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
      'finalize_coach_import_job',
      {
        p_import_job_id: jobId,
        p_validation_errors: [],
      }
    );

    expect(finalizeError).toBeNull();
    expect(finalizeResult.inserted_coaches).toBe(1);
    expect(getMockData('coaches').some((coach) => coach.email === 'csvcoach@example.com')).toBe(
      true
    );

    const { data: rollbackResult, error: rollbackError } = await supabase.rpc(
      'rollback_coach_import_job',
      { p_import_job_id: jobId }
    );

    expect(rollbackError).toBeNull();
    expect(rollbackResult.deleted_coaches).toBe(1);
    expect(getMockData('coaches').some((coach) => coach.email === 'csvcoach@example.com')).toBe(
      false
    );
  });

  it('can defer a staged coach import before applying it', async () => {
    const { data: job } = await supabase
      .from('import_jobs')
      .insert({
        id: 'mock-deferred-coach-import-job',
        created_by: 'mock-admin-id',
        organization_id: MOCK_ORG_ID,
        job_type: 'registration',
        storage_path: 'imports/mock-admin-id/coaches.csv',
        status: 'importing',
        total_rows: 1,
        processed_rows: 0,
        progress_percent: 0,
      })
      .select();
    const jobId = job.id;

    await supabase.functions.invoke('import-validation', {
      body: {
        import_type: 'coaches',
        organization_id: MOCK_ORG_ID,
        rows: [
          {
            full_name: 'Deferred CSV Coach',
            email: 'deferredcsvcoach@example.com',
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
        p_import_type: 'coaches',
        p_validation_errors: [],
      }
    );

    expect(readyError).toBeNull();
    expect(readyResult).toMatchObject({
      status: 'ready_to_apply',
      import_type: 'coaches',
      staged_rows: 1,
    });
    expect(
      getMockData('coaches').some((coach) => coach.email === 'deferredcsvcoach@example.com')
    ).toBe(false);

    const { data: finalizeResult, error: finalizeError } = await supabase.rpc(
      'finalize_coach_import_job',
      {
        p_import_job_id: jobId,
        p_validation_errors: [],
      }
    );

    expect(finalizeError).toBeNull();
    expect(finalizeResult.status).toBe('completed');
    expect(
      getMockData('coaches').some((coach) => coach.email === 'deferredcsvcoach@example.com')
    ).toBe(true);
  });

  // S7 (docs/changes/2026-10-27-admin-only.md): the coach import names a coach's children by
  // player registration id. The mock follows finalize_coach_import_job (20261104010000).
  describe("a coach's children (S7)", () => {
    const OTHER_ORG = 'ffffffff-0000-4000-8000-0000000000f1';

    const importCoach = async (jobId, row) => {
      await supabase
        .from('import_jobs')
        .insert({
          id: jobId,
          created_by: 'mock-admin-id',
          organization_id: MOCK_ORG_ID,
          job_type: 'registration',
          storage_path: 'imports/mock-admin-id/coaches.csv',
          status: 'importing',
          total_rows: 1,
          processed_rows: 0,
          progress_percent: 0,
        })
        .select();
      const { error: validationError } = await supabase.functions.invoke('import-validation', {
        body: {
          import_type: 'coaches',
          organization_id: MOCK_ORG_ID,
          rows: [row],
          import_job_id: jobId,
          row_offset: 0,
        },
      });
      expect(validationError).toBeNull();
      return supabase.rpc('finalize_coach_import_job', {
        p_import_job_id: jobId,
        p_validation_errors: [],
      });
    };

    const links = () =>
      getMockData('coach_team_requests')
        .filter((link) => link.organization_id === MOCK_ORG_ID)
        .sort((a, b) => a.slot - b.slot);

    const seedPlayers = async () => {
      await supabase.from('players').insert([
        {
          id: 'c0ffee00-0000-4000-8000-000000000001',
          organization_id: MOCK_ORG_ID,
          first_name: 'Kid',
          last_name: 'One',
          external_registration_id: 'S7-1',
        },
        {
          id: 'c0ffee00-0000-4000-8000-000000000002',
          organization_id: MOCK_ORG_ID,
          first_name: 'Kid',
          last_name: 'Two',
          external_registration_id: 'S7-2',
        },
        {
          id: 'c0ffee00-0000-4000-8000-000000000003',
          organization_id: OTHER_ORG,
          first_name: 'Kid',
          last_name: 'Elsewhere',
          external_registration_id: 'S7-OTHER',
        },
      ]);
    };

    it('writes one link per matching id, reports the rest, and never links another organization', async () => {
      await seedPlayers();
      const { data: result, error } = await importCoach('mock-s7-job-1', {
        full_name: 'Linked Coach',
        email: 'Linked@Example.com',
        'Child Registration ID': 'S7-1; S7-2, S7-NOPE, S7-OTHER, S7-1',
      });

      expect(error).toBeNull();
      expect(result.linked_children).toBe(2);
      expect(result.unmatched_child_id_count).toBe(2);
      expect(result.unmatched_child_ids.map((item) => item.registration_id)).toEqual([
        'S7-NOPE',
        'S7-OTHER',
      ]);
      // An id that matched nothing is a warning, never fatal: the coach is still imported.
      expect(result.status).toBe('completed_with_warnings');
      expect(result.inserted_coaches).toBe(1);
      const coach = getMockData('coaches').find((item) => item.email === 'linked@example.com');
      expect(coach).toBeTruthy();
      expect(links().map((link) => [link.coach_id, link.player_id, link.slot])).toEqual([
        [coach.id, 'c0ffee00-0000-4000-8000-000000000001', 1],
        [coach.id, 'c0ffee00-0000-4000-8000-000000000002', 2],
      ]);
    });

    it("replaces the coach's links on a re-import, and a rollback puts the old ones back", async () => {
      await seedPlayers();
      await importCoach('mock-s7-job-2', {
        full_name: 'Relinked Coach',
        email: 'relinked@example.com',
        child_registration_id: 'S7-1;S7-2',
      });
      expect(links()).toHaveLength(2);

      const { data: second } = await importCoach('mock-s7-job-3', {
        full_name: 'Relinked Coach',
        email: 'relinked@example.com',
        child_registration_id: 'S7-2',
      });
      expect(second.updated_coaches).toBe(1);
      expect(links().map((link) => link.player_id)).toEqual([
        'c0ffee00-0000-4000-8000-000000000002',
      ]);

      await supabase.rpc('rollback_coach_import_job', { p_import_job_id: 'mock-s7-job-3' });
      expect(links().map((link) => [link.player_id, link.slot])).toEqual([
        ['c0ffee00-0000-4000-8000-000000000001', 1],
        ['c0ffee00-0000-4000-8000-000000000002', 2],
      ]);
    });

    it('leaves the links alone when the file has no such column', async () => {
      await seedPlayers();
      await importCoach('mock-s7-job-4', {
        full_name: 'Kept Coach',
        email: 'kept@example.com',
        child_registration_id: 'S7-1',
      });
      await importCoach('mock-s7-job-5', { full_name: 'Kept Coach', email: 'kept@example.com' });
      expect(links()).toHaveLength(1);
    });

    it('treats the same email in another organization as another coach, not a conflict', async () => {
      await supabase.from('coaches').insert({
        id: 'c0ffee00-0000-4000-8000-0000000000c1',
        organization_id: OTHER_ORG,
        full_name: 'Shared Coach',
        email: 'shared@example.com',
        status: 'active',
      });
      const { data: result } = await importCoach('mock-s7-job-6', {
        full_name: 'Shared Coach',
        email: 'shared@example.com',
      });
      expect(result.inserted_coaches).toBe(1);
      expect(result.invalid_rows).toBe(0);
      expect(
        getMockData('coaches').filter((coach) => coach.email === 'shared@example.com')
      ).toHaveLength(2);
    });
  });
});
