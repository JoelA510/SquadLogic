import { describe, it, expect, beforeEach } from 'vitest';
import { mockSupabase as supabase, getMockData } from '../frontend/src/lib/mockSupabaseClient.js';
import { MOCK_ORG_ID } from '../frontend/src/lib/mockSeedIds.js';

const setSession = (userId) => {
  sessionStorage.setItem('__MOCK_SESSION__', JSON.stringify({ user: { id: userId } }));
};

beforeEach(() => {
  sessionStorage.clear();
  delete window.__MOCK_DB__;
  setSession('mock-admin-id');
});

// ---------------------------------------------------------------------------
// admin_update_registration_form
// ---------------------------------------------------------------------------
describe('mock admin_update_registration_form rpc', () => {
  it('patches allowed fields and creates audit entry', async () => {
    const form = getMockData('registration_forms')[0];
    expect(form).toBeTruthy();

    const { data, error } = await supabase.rpc('admin_update_registration_form', {
      p_form_id: form.id,
      p_patch: { title: 'Updated Title', status: 'closed' },
    });
    expect(error).toBeNull();
    expect(data?.id).toBe(form.id);

    const updated = getMockData('registration_forms').find((f) => f.id === form.id);
    expect(updated.title).toBe('Updated Title');
    expect(updated.status).toBe('closed');

    const audit = getMockData('audit_log').find(
      (row) => row.action === 'registration.form_updated'
    );
    expect(audit).toBeTruthy();
  });

  it('rejects disallowed patch keys', async () => {
    const form = getMockData('registration_forms')[0];
    const { data, error } = await supabase.rpc('admin_update_registration_form', {
      p_form_id: form.id,
      p_patch: { organization_id: 'evil' },
    });
    expect(data).toBeNull();
    expect(error?.message).toMatch(/disallowed/i);
  });

  it('returns error for unknown form id', async () => {
    const { data, error } = await supabase.rpc('admin_update_registration_form', {
      p_form_id: '00000000-0000-0000-0000-000000000000',
      p_patch: { title: 'x' },
    });
    expect(data).toBeNull();
    expect(error?.message).toMatch(/not found/i);
  });

  it('denies non-admin callers', async () => {
    setSession('mock-coach-id');
    const form = getMockData('registration_forms')[0];
    const { data, error } = await supabase.rpc('admin_update_registration_form', {
      p_form_id: form.id,
      p_patch: { title: 'hacked' },
    });
    expect(data).toBeNull();
    expect(error?.message).toMatch(/access denied/i);
  });
});

// ---------------------------------------------------------------------------
// admin_delete_registration_form
// ---------------------------------------------------------------------------
describe('mock admin_delete_registration_form rpc', () => {
  it('deletes the form and creates audit entry', async () => {
    const form = getMockData('registration_forms')[0];
    expect(form).toBeTruthy();

    const { error } = await supabase.rpc('admin_delete_registration_form', {
      p_form_id: form.id,
    });
    expect(error).toBeNull();

    const remaining = getMockData('registration_forms').find((f) => f.id === form.id);
    expect(remaining).toBeUndefined();

    const audit = getMockData('audit_log').find(
      (row) => row.action === 'registration.form_deleted'
    );
    expect(audit).toBeTruthy();
  });

  it('denies non-admin callers', async () => {
    setSession('mock-coach-id');
    const form = getMockData('registration_forms')[0];
    const { data, error } = await supabase.rpc('admin_delete_registration_form', {
      p_form_id: form.id,
    });
    expect(data).toBeNull();
    expect(error?.message).toMatch(/access denied/i);
    // Form should still exist
    const stillThere = getMockData('registration_forms').find((f) => f.id === form.id);
    expect(stillThere).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// admin_remove_member
// ---------------------------------------------------------------------------
describe('mock admin_remove_member rpc', () => {
  it('removes a non-admin member', async () => {
    const coachMember = getMockData('organization_members').find((m) => m.role === 'coach');
    expect(coachMember).toBeTruthy();

    const { error } = await supabase.rpc('admin_remove_member', {
      p_organization_id: coachMember.organization_id,
      p_profile_id: coachMember.profile_id,
    });
    expect(error).toBeNull();

    const stillThere = getMockData('organization_members').find(
      (m) =>
        m.profile_id === coachMember.profile_id && m.organization_id === coachMember.organization_id
    );
    expect(stillThere).toBeUndefined();

    const audit = getMockData('audit_log').find((row) => row.action === 'member.removed');
    expect(audit).toBeTruthy();
  });

  it('prevents removing yourself', async () => {
    const { data, error } = await supabase.rpc('admin_remove_member', {
      p_organization_id: MOCK_ORG_ID,
      p_profile_id: 'mock-admin-id',
    });
    expect(data).toBeNull();
    expect(error?.message).toMatch(/yourself/i);
  });

  it('denies non-admin callers', async () => {
    setSession('mock-coach-id');
    const { data, error } = await supabase.rpc('admin_remove_member', {
      p_organization_id: MOCK_ORG_ID,
      p_profile_id: 'mock-admin-id',
    });
    expect(data).toBeNull();
    expect(error?.message).toMatch(/access denied/i);
  });
});

// ---------------------------------------------------------------------------
// admin_change_member_role
// ---------------------------------------------------------------------------
describe('mock admin_change_member_role rpc', () => {
  it('changes role of a member', async () => {
    const coachMember = getMockData('organization_members').find((m) => m.role === 'coach');
    expect(coachMember).toBeTruthy();

    const { error } = await supabase.rpc('admin_change_member_role', {
      p_organization_id: coachMember.organization_id,
      p_profile_id: coachMember.profile_id,
      p_role: 'staff',
    });
    expect(error).toBeNull();

    const updated = getMockData('organization_members').find(
      (m) =>
        m.profile_id === coachMember.profile_id && m.organization_id === coachMember.organization_id
    );
    expect(updated?.role).toBe('staff');

    const audit = getMockData('audit_log').find((row) => row.action === 'member.role_changed');
    expect(audit).toBeTruthy();
  });

  it('prevents demoting the last admin', async () => {
    const { data, error } = await supabase.rpc('admin_change_member_role', {
      p_organization_id: MOCK_ORG_ID,
      p_profile_id: 'mock-admin-id',
      p_role: 'coach',
    });
    expect(data).toBeNull();
    expect(error?.message).toMatch(/last admin/i);
  });

  it('denies non-admin callers', async () => {
    setSession('mock-coach-id');
    const { data, error } = await supabase.rpc('admin_change_member_role', {
      p_organization_id: MOCK_ORG_ID,
      p_profile_id: 'mock-admin-id',
      p_role: 'staff',
    });
    expect(data).toBeNull();
    expect(error?.message).toMatch(/access denied/i);
  });
});

// ---------------------------------------------------------------------------
// admin_cancel_practice_assignment
// ---------------------------------------------------------------------------
describe('mock admin_cancel_practice_assignment rpc', () => {
  it('removes the practice assignment and audits', async () => {
    const assignment = getMockData('practice_assignments').find((a) => a.id === 'pa-1');
    expect(assignment).toBeTruthy();

    const { error } = await supabase.rpc('admin_cancel_practice_assignment', {
      p_assignment_id: 'pa-1',
    });
    expect(error).toBeNull();

    const stillThere = getMockData('practice_assignments').find((a) => a.id === 'pa-1');
    expect(stillThere).toBeUndefined();

    const audit = getMockData('audit_log').find((row) => row.action === 'practice.cancelled');
    expect(audit).toBeTruthy();
  });

  it('returns error for unknown assignment', async () => {
    const { data, error } = await supabase.rpc('admin_cancel_practice_assignment', {
      p_assignment_id: '00000000-0000-0000-0000-000000000000',
    });
    expect(data).toBeNull();
    expect(error?.message).toMatch(/not found/i);
  });
});

// ---------------------------------------------------------------------------
// admin_update_team
// ---------------------------------------------------------------------------
describe('mock admin_update_team rpc', () => {
  it('renames a team and creates audit entry', async () => {
    const team = getMockData('teams')[0];
    expect(team).toBeTruthy();

    const { data, error } = await supabase.rpc('admin_update_team', {
      p_team_id: team.id,
      p_patch: { name: 'Renamed Rockets' },
    });
    expect(error).toBeNull();
    expect(data?.id).toBe(team.id);

    const updated = getMockData('teams').find((t) => t.id === team.id);
    expect(updated.name).toBe('Renamed Rockets');

    const audit = getMockData('audit_log').find((row) => row.action === 'team.updated');
    expect(audit).toBeTruthy();
  });

  it('rejects an empty name', async () => {
    const team = getMockData('teams')[0];
    const { data, error } = await supabase.rpc('admin_update_team', {
      p_team_id: team.id,
      p_patch: { name: '   ' },
    });
    expect(data).toBeNull();
    expect(error?.message).toMatch(/empty/i);
  });

  it('rejects a duplicate name within the division', async () => {
    const teams = getMockData('teams');
    const [first, second] = teams.filter(
      (t, _, all) => all.filter((o) => o.division_id === t.division_id).length > 1
    );
    if (!first || !second) return; // seed has no division with 2+ teams

    const { data, error } = await supabase.rpc('admin_update_team', {
      p_team_id: first.id,
      p_patch: { name: second.name },
    });
    expect(data).toBeNull();
    expect(error?.message).toMatch(/already exists/i);
  });

  it('rejects disallowed patch keys', async () => {
    const team = getMockData('teams')[0];
    const { data, error } = await supabase.rpc('admin_update_team', {
      p_team_id: team.id,
      p_patch: { organization_id: 'evil' },
    });
    expect(data).toBeNull();
    expect(error?.message).toMatch(/disallowed/i);
  });

  it('denies non-admin callers', async () => {
    setSession('mock-coach-id');
    const team = getMockData('teams')[0];
    const originalName = team.name;
    const { data, error } = await supabase.rpc('admin_update_team', {
      p_team_id: team.id,
      p_patch: { name: 'Hacked' },
    });
    expect(data).toBeNull();
    expect(error?.message).toMatch(/access denied/i);
    expect(getMockData('teams').find((t) => t.id === team.id)?.name).toBe(originalName);
  });
});

// ---------------------------------------------------------------------------
// admin_delete_team
// ---------------------------------------------------------------------------
describe('mock admin_delete_team rpc', () => {
  it('deletes the team and cascades to team_players', async () => {
    const team = getMockData('teams')[0];
    expect(team).toBeTruthy();

    const { error } = await supabase.rpc('admin_delete_team', {
      p_team_id: team.id,
    });
    expect(error).toBeNull();

    const stillThere = getMockData('teams').find((t) => t.id === team.id);
    expect(stillThere).toBeUndefined();

    const orphanedTp = getMockData('team_players').filter(
      (tp) => String(tp.team_id) === String(team.id)
    );
    expect(orphanedTp).toHaveLength(0);

    const audit = getMockData('audit_log').find((row) => row.action === 'team.deleted');
    expect(audit).toBeTruthy();
  });

  it('returns error for unknown team id', async () => {
    const { data, error } = await supabase.rpc('admin_delete_team', {
      p_team_id: '00000000-0000-0000-0000-000000000000',
    });
    expect(data).toBeNull();
    expect(error?.message).toMatch(/not found/i);
  });

  it('denies non-admin callers', async () => {
    setSession('mock-coach-id');
    const team = getMockData('teams')[0];
    const { data, error } = await supabase.rpc('admin_delete_team', {
      p_team_id: team.id,
    });
    expect(data).toBeNull();
    expect(error?.message).toMatch(/access denied/i);
    expect(getMockData('teams').find((t) => t.id === team.id)).toBeTruthy();
  });
});
