// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { getMockData, mockSupabase } from '../frontend/src/lib/mockSupabaseClient.js';
import { MOCK_ORG_ID } from '../frontend/src/lib/mockSeedIds.js';

/**
 * The mock's import-validation drops sensitive columns from people imports as
 * the Edge Function does (plan docs/changes/2026-10-20-phase-a-privacy.md, A1),
 * so a test run in mock mode cannot stage what production would refuse.
 */
const ROW = {
  'First Name': 'Avery',
  'Last Name': 'Alderbrook',
  'Date of Birth': '2016-01-01',
  'Special Needs': 'MOCK-SENSITIVE',
  medical_info: 'MOCK-SENSITIVE',
  'Emergency Contact Phone': 'MOCK-SENSITIVE',
};

describe('the mock import-validation', () => {
  beforeEach(async () => {
    sessionStorage.clear();
    window.__MOCK_DB__ = undefined;
    await mockSupabase.auth.signInWithPassword({
      email: 'admin@example.com',
      password: 'test-password-123',
    });
  });

  it('stages and returns a player row without its sensitive columns', async () => {
    const jobId = 'mock-job-sensitive';
    const { data, error } = await mockSupabase.functions.invoke('import-validation', {
      body: {
        import_type: 'players',
        organization_id: MOCK_ORG_ID,
        rows: [ROW],
        import_job_id: jobId,
        row_offset: 0,
      },
    });
    expect(error).toBeNull();
    expect(data.validated_data).toHaveLength(1);
    expect(JSON.stringify(data.validated_data)).not.toContain('MOCK-SENSITIVE');
    const staged = getMockData('staging_players').filter((row) => row.import_job_id === jobId);
    expect(staged).toHaveLength(1);
    expect(staged[0].raw_payload).toEqual({
      'First Name': 'Avery',
      'Last Name': 'Alderbrook',
      'Date of Birth': '2016-01-01',
    });
    expect(JSON.stringify(staged)).not.toContain('MOCK-SENSITIVE');
  });

  it('stages and returns a coach row with only its allowlisted columns (R0)', async () => {
    const jobId = 'mock-job-allowlist';
    const { data, error } = await mockSupabase.functions.invoke('import-validation', {
      body: {
        import_type: 'coaches',
        organization_id: MOCK_ORG_ID,
        rows: [
          {
            'Full Name': 'First1 Last1',
            Email: 'email1@example.com',
            Phone: 'MOCK-UNLISTED',
            'Guardian 1 Address': 'MOCK-UNLISTED',
            "What is your player's birth date?": 'MOCK-UNLISTED',
          },
        ],
        import_job_id: jobId,
        row_offset: 0,
      },
    });
    expect(error).toBeNull();
    expect(data.validated_data).toEqual([
      { full_name: 'First1 Last1', email: 'email1@example.com' },
    ]);
    const staged = getMockData('staging_import_rows').filter((row) => row.import_job_id === jobId);
    expect(staged).toHaveLength(1);
    expect(staged[0].raw_payload).toEqual({
      'Full Name': 'First1 Last1',
      Email: 'email1@example.com',
    });
    expect(JSON.stringify(staged)).not.toContain('MOCK-UNLISTED');
  });

  it('leaves a field import as given', async () => {
    const row = {
      location: 'Central Park',
      name: 'Field 1',
      type: 'game',
      start: '09:00',
      end: '10:00',
      slot_date: '2026-09-01',
      'Field Condition Notes': 'kept',
    };
    const { data } = await mockSupabase.functions.invoke('import-validation', {
      body: { import_type: 'fields', organization_id: MOCK_ORG_ID, rows: [row] },
    });
    expect(JSON.stringify(data.validated_data)).toContain('kept');
  });
});
