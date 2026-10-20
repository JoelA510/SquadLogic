import { beforeEach, describe, expect, it } from 'vitest';
import { getMockData, mockSupabase as supabase } from '../frontend/src/lib/mockSupabaseClient.js';
import { MOCK_ORG_ID } from '../frontend/src/lib/mockSeedIds.js';

/**
 * Staff are admins in the mock as in the database (migration 20261020030000):
 * a staff caller passes the member RPCs' admin gate and the audit-log RPC's,
 * and the last-admin guard counts staff as admin-equivalent.
 */
const setSession = (userId) => {
  sessionStorage.setItem('__MOCK_SESSION__', JSON.stringify({ user: { id: userId } }));
};

const COACH = 'mock-coach-id';
const ADMIN = 'mock-admin-id';

async function makeCoachStaff() {
  setSession(ADMIN);
  const { error } = await supabase.rpc('admin_change_member_role', {
    p_organization_id: MOCK_ORG_ID,
    p_profile_id: COACH,
    p_role: 'staff',
  });
  expect(error).toBeNull();
}

beforeEach(() => {
  sessionStorage.clear();
  delete window.__MOCK_DB__;
});

describe('staff in the mock client', () => {
  it('a coach is refused the audit log; the same member as staff reads it', async () => {
    setSession(COACH);
    const refused = await supabase.rpc('get_settings_audit_log', {
      p_organization_id: MOCK_ORG_ID,
    });
    expect(refused.error?.message).toMatch(/access denied/i);

    await makeCoachStaff();
    setSession(COACH);
    const allowed = await supabase.rpc('get_settings_audit_log', {
      p_organization_id: MOCK_ORG_ID,
    });
    expect(allowed.error).toBeNull();
    expect(Array.isArray(allowed.data)).toBe(true);
  });

  it('a staff member passes the admin gate and counts toward the last-admin guard', async () => {
    await makeCoachStaff();
    const members = getMockData('organization_members').filter(
      (m) => m.organization_id === MOCK_ORG_ID
    );
    const admins = members.filter((m) => m.role === 'admin');
    expect(admins.map((m) => m.profile_id)).toEqual([ADMIN]);

    // Staff demotes the only admin: allowed, staff remains admin-equivalent.
    setSession(COACH);
    const demoted = await supabase.rpc('admin_change_member_role', {
      p_organization_id: MOCK_ORG_ID,
      p_profile_id: ADMIN,
      p_role: 'coach',
    });
    expect(demoted.error).toBeNull();

    // Now staff is the last admin-equivalent member and may not demote itself.
    const self = await supabase.rpc('admin_change_member_role', {
      p_organization_id: MOCK_ORG_ID,
      p_profile_id: COACH,
      p_role: 'coach',
    });
    expect(self.error?.message).toMatch(/last admin/i);
    expect(
      getMockData('organization_members').find(
        (m) => m.organization_id === MOCK_ORG_ID && m.profile_id === COACH
      )?.role
    ).toBe('staff');
  });
});
