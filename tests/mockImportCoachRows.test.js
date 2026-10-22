// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { mockSupabase } from '../frontend/src/lib/mockSupabaseClient.js';
import { MOCK_ORG_ID } from '../frontend/src/lib/mockSeedIds.js';

/**
 * The mock import-validation normalizes coach rows as the Edge Function does
 * (docs/changes/2026-10-22-demo-mode.md, D1): a GotSport coach export's First Name and Last Name
 * become the full name, and a blank Contact Email leaves the Email/UserID in place.
 */
const invoke = (rows) =>
  mockSupabase.functions.invoke('import-validation', {
    body: { import_type: 'coaches', organization_id: MOCK_ORG_ID, rows, row_offset: 0 },
  });

describe('the mock import-validation, coach rows', () => {
  beforeEach(async () => {
    sessionStorage.clear();
    window.__MOCK_DB__ = undefined;
    await mockSupabase.auth.signInWithPassword({
      email: 'admin@example.com',
      password: 'test-password-123',
    });
  });

  it('composes the full name and keeps the login email when Contact Email is blank', async () => {
    const { data, error } = await invoke([
      {
        'First Name': 'CoachFirst1',
        'Last Name': 'CoachLast1',
        'Email/UserID': 'email1@example.com',
        'Contact Email': '',
      },
    ]);
    expect(error).toBeNull();
    expect(data.validation_errors).toEqual([]);
    expect(data.validated_data).toHaveLength(1);
    expect(data.validated_data[0]).toMatchObject({
      full_name: 'CoachFirst1 CoachLast1',
      email: 'email1@example.com',
    });
  });

  it('still refuses a coach row with no name at all', async () => {
    const { data } = await invoke([
      { 'First Name': '', 'Last Name': '', 'Email/UserID': 'email2@example.com' },
    ]);
    expect(data.validated_data).toEqual([]);
    expect(data.validation_errors.map((e) => e.field)).toEqual(['full_name']);
  });
});
