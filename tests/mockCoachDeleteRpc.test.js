import { describe, it, expect, beforeEach } from 'vitest';
import { mockSupabase as supabase, getMockData } from '../frontend/src/lib/mockSupabaseClient.js';

const setMockSession = (userId) => {
  sessionStorage.setItem('__MOCK_SESSION__', JSON.stringify({ user: { id: userId } }));
};

describe('mock admin_delete_coaches rpc', () => {
  beforeEach(() => {
    sessionStorage.clear();
    delete window.__MOCK_DB__;
    setMockSession('mock-admin-id');
  });

  // The coach leads' interest table went with them (20261025010000): an
  // interested coach is deleted like any other, and no interest link exists.
  it('deletes coaches, an interested one included, and unassigns their teams', async () => {
    const coaches = getMockData('coaches');
    const assignedCoach = coaches.find((coach) =>
      getMockData('teams').some((team) => String(team.coach_id) === String(coach.id))
    );
    const leadCoach = coaches.find((coach) => coach.status === 'interested');
    expect(assignedCoach).toBeTruthy();
    expect(leadCoach).toBeTruthy();

    const { data, error } = await supabase.rpc('admin_delete_coaches', {
      p_coach_ids: [assignedCoach.id, leadCoach.id],
    });
    expect(error).toBeNull();
    expect(data).toBe(2);

    const remainingIds = getMockData('coaches').map((coach) => String(coach.id));
    expect(remainingIds).not.toContain(String(assignedCoach.id));
    expect(remainingIds).not.toContain(String(leadCoach.id));
    expect(
      getMockData('teams').some((team) => String(team.coach_id) === String(assignedCoach.id))
    ).toBe(false);
    expect(getMockData('coach_interested_programs') ?? []).toEqual([]);

    const auditEntry = getMockData('audit_log').find((row) => row.action === 'coach.deleted');
    expect(auditEntry).toBeTruthy();
    expect(auditEntry.metadata.coach_count).toBe(2);
  });

  it('rejects empty input', async () => {
    const { data, error } = await supabase.rpc('admin_delete_coaches', { p_coach_ids: [] });
    expect(data).toBeNull();
    expect(error?.message).toMatch(/non-empty/i);
  });

  it('denies non-admin callers', async () => {
    setMockSession('mock-coach-id');
    const coachId = getMockData('coaches')[0].id;
    const { data, error } = await supabase.rpc('admin_delete_coaches', {
      p_coach_ids: [coachId],
    });
    expect(data).toBeNull();
    expect(error?.message).toMatch(/access denied/i);
    expect(getMockData('coaches').map((coach) => String(coach.id))).toContain(String(coachId));
  });
});
