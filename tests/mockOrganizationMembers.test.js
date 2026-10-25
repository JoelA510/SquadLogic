// The mock twin of get_organization_members (migration 20261025010000): the
// member list carries every member's sign-in email, so it admits admins and
// staff only, and refuses anyone else 42501, as the SQL does
// (supabase/tests/contact_surfaces_removed.sql holds the database to it).
import { beforeEach, describe, expect, it } from 'vitest';
import { mockSupabase as supabase } from '../frontend/src/lib/mockSupabaseClient.js';
import { MOCK_ORG_ID } from '../frontend/src/lib/mockSeedIds.js';

const signIn = (userId) => {
  sessionStorage.setItem('__MOCK_SESSION__', JSON.stringify({ user: { id: userId } }));
};

describe('mock get_organization_members', () => {
  beforeEach(() => {
    sessionStorage.clear();
    delete window.__MOCK_DB__;
  });

  it('gives an admin every member with their email', async () => {
    signIn('mock-admin-id');
    const { data, error } = await supabase.rpc('get_organization_members', {
      p_organization_id: MOCK_ORG_ID,
    });
    expect(error).toBeNull();
    expect(data.map((row) => row.profile_id)).toEqual(
      expect.arrayContaining(['mock-admin-id', 'mock-coach-id'])
    );
    expect(data.every((row) => 'email' in row)).toBe(true);
  });

  it('refuses a coach 42501, so a coach reads no member email', async () => {
    signIn('mock-coach-id');
    const { data, error } = await supabase.rpc('get_organization_members', {
      p_organization_id: MOCK_ORG_ID,
    });
    expect(data).toBeNull();
    expect(error?.code).toBe('42501');
  });
});
