import { beforeEach, describe, expect, it } from 'vitest';
import { getMockData, mockSupabase as supabase } from '../frontend/src/lib/mockSupabaseClient.js';
import { MOCK_ORG_ID } from '../frontend/src/lib/mockSeedIds.js';
import { seedMockDb } from './helpers/seedMockDb.js';

/**
 * Staff are admins in the mock as in the database (migration 20261020030000):
 * a staff caller passes the member RPCs' admin gate and the audit-log RPC's,
 * and the last-admin guard counts staff as admin-equivalent.
 */
const setSession = (userId) => {
  sessionStorage.setItem('__MOCK_SESSION__', JSON.stringify({ user: { id: userId } }));
};

// An account that signs in with no membership (what a coach's account is now), made staff.
const MEMBER = 'mock-staff-id';
const ADMIN = 'mock-admin-id';

function makeStaff() {
  seedMockDb({
    organization_members: [{ organization_id: MOCK_ORG_ID, profile_id: MEMBER, role: 'staff' }],
  });
}

beforeEach(() => {
  sessionStorage.clear();
  delete window.__MOCK_DB__;
});

describe('staff in the mock client', () => {
  it('a non-member is refused the audit log; the same account as staff reads it', async () => {
    setSession(MEMBER);
    const refused = await supabase.rpc('get_settings_audit_log', {
      p_organization_id: MOCK_ORG_ID,
    });
    expect(refused.error?.message).toMatch(/access denied/i);

    makeStaff();
    const allowed = await supabase.rpc('get_settings_audit_log', {
      p_organization_id: MOCK_ORG_ID,
    });
    expect(allowed.error).toBeNull();
    expect(Array.isArray(allowed.data)).toBe(true);
  });

  it('a staff member passes the admin gate and counts toward the last-admin guard', async () => {
    makeStaff();
    const members = getMockData('organization_members').filter(
      (m) => m.organization_id === MOCK_ORG_ID
    );
    expect(members.filter((m) => m.role === 'admin').map((m) => m.profile_id)).toEqual([ADMIN]);

    // Staff removes the only admin: allowed, staff remains admin-equivalent.
    setSession(MEMBER);
    const removed = await supabase.rpc('admin_remove_member', {
      p_organization_id: MOCK_ORG_ID,
      p_profile_id: ADMIN,
    });
    expect(removed.error).toBeNull();
    expect(
      getMockData('organization_members')
        .filter((m) => m.organization_id === MOCK_ORG_ID)
        .map((m) => m.profile_id)
    ).toEqual([MEMBER]);

    // Now staff is the last admin-equivalent member and may not remove itself.
    const self = await supabase.rpc('admin_remove_member', {
      p_organization_id: MOCK_ORG_ID,
      p_profile_id: MEMBER,
    });
    expect(self.error?.message).toMatch(/yourself|last admin/i);
    expect(
      getMockData('organization_members').find(
        (m) => m.organization_id === MOCK_ORG_ID && m.profile_id === MEMBER
      )?.role
    ).toBe('staff');
  });
});
