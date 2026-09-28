/**
 * Mock parity for the coach practice preference RPCs
 * (`frontend/src/lib/mockCoachPreferences.js` vs migration 20260927000000).
 *
 * Plant (b): stop superseding the prior approved row -> the supersede cases
 * go red (two approved rows for one (coach, dimension)).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleCoachPreferenceRpc } from '../frontend/src/lib/mockCoachPreferences.js';
import { mockSupabase } from '../frontend/src/lib/mockSupabaseClient.js';
import { seedMockDb } from './helpers/seedMockDb.js';

const ORG = 'org-p';
const COACH = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-09-28T12:00:00Z');

function freshDb() {
  return {
    organization_members: [
      { organization_id: ORG, profile_id: 'admin-user', role: 'admin' },
      { organization_id: ORG, profile_id: 'coach-user', role: 'coach' },
      { organization_id: ORG, profile_id: 'other-user', role: 'coach' },
    ],
    coaches: [{ id: COACH, organization_id: ORG, user_id: 'coach-user', full_name: 'C' }],
    locations: [],
    coach_practice_preferences: [],
  };
}

let seq;
const call = (db, name, params, user, now = NOW) =>
  handleCoachPreferenceRpc(db, name, params, {
    currentUserId: user,
    now,
    newId: () => `pref-${++seq}`,
  });

const request = (db, value, user = 'coach-user') =>
  call(
    db,
    'request_coach_practice_preference',
    {
      p_coach_id: COACH,
      p_dimension: 'weekday',
      p_level: 'must_keep',
      p_value: value,
    },
    user
  );

const approvedFor = (db) =>
  db.coach_practice_preferences.filter(
    (row) => row.coach_id === COACH && row.dimension === 'weekday' && row.status === 'approved'
  );

beforeEach(() => {
  seq = 0;
});

describe('mock coach preference RPCs', () => {
  it('refuses a non-admin decide (42501) and leaves the row requested', () => {
    const db = freshDb();
    const { data } = request(db, 'MON');
    const refused = call(
      db,
      'admin_decide_coach_practice_preference',
      {
        p_preference_id: data.id,
        p_decision: 'approve',
      },
      'coach-user'
    );
    expect(refused.error?.code).toBe('42501');
    expect(db.coach_practice_preferences[0].status).toBe('requested');
  });

  it('refuses a non-admin set (42501) and writes nothing', () => {
    const db = freshDb();
    const refused = call(
      db,
      'admin_set_coach_practice_preference',
      {
        p_coach_id: COACH,
        p_dimension: 'weekday',
        p_level: 'must_keep',
        p_value: 'MON',
      },
      'coach-user'
    );
    expect(refused.error?.code).toBe('42501');
    expect(db.coach_practice_preferences).toHaveLength(0);
  });

  it('refuses a request for another coach by a non-admin (42501)', () => {
    const db = freshDb();
    expect(request(db, 'MON', 'other-user').error?.code).toBe('42501');
    expect(request(db, 'MON', 'admin-user').error).toBeNull();
  });

  it('approve supersedes the prior approved row: one approved per (coach, dimension)', () => {
    const db = freshDb();
    const first = request(db, 'MON').data;
    call(
      db,
      'admin_decide_coach_practice_preference',
      { p_preference_id: first.id, p_decision: 'approve' },
      'admin-user',
      new Date('2026-09-20T12:00:00Z')
    );
    const second = request(db, 'WED').data;
    const result = call(
      db,
      'admin_decide_coach_practice_preference',
      {
        p_preference_id: second.id,
        p_decision: 'approve',
        p_level: 'prefer_keep',
        p_value: 'THU',
      },
      'admin-user'
    );
    expect(result.error).toBeNull();
    expect(result.data.superseded_id).toBe(first.id);
    const approved = approvedFor(db);
    expect(approved).toHaveLength(1);
    expect(approved[0]).toMatchObject({
      id: second.id,
      level: 'prefer_keep',
      value: 'THU',
      effective_from: '2026-09-28',
      organization_id: ORG,
    });
    const prior = db.coach_practice_preferences.find((row) => row.id === first.id);
    expect(prior).toMatchObject({ status: 'superseded', effective_to: '2026-09-27' });
  });

  it('set supersedes the prior approved row too', () => {
    const db = freshDb();
    const setArgs = (value) => ({
      p_coach_id: COACH,
      p_dimension: 'weekday',
      p_level: 'must_keep',
      p_value: value,
    });
    const first = call(
      db,
      'admin_set_coach_practice_preference',
      setArgs('MON'),
      'admin-user'
    ).data;
    const second = call(
      db,
      'admin_set_coach_practice_preference',
      setArgs('TUE'),
      'admin-user'
    ).data;
    expect(second.superseded_id).toBe(first.id);
    expect(approvedFor(db).map((row) => row.id)).toEqual([second.id]);
  });

  it('mirrors the remaining refusals and statuses', () => {
    const db = freshDb();
    const { data } = request(db, 'MON');
    const decide = (params) =>
      call(
        db,
        'admin_decide_coach_practice_preference',
        { p_preference_id: data.id, ...params },
        'admin-user'
      );
    expect(decide({ p_decision: 'maybe' }).error?.code).toBe('22023');
    expect(decide({ p_decision: 'reject', p_level: 'dont_care' }).error?.code).toBe('22023');
    expect(decide({ p_decision: 'reject' }).data.status).toBe('rejected');
    expect(decide({ p_decision: 'approve' }).error?.code).toBe('22023');
    expect(request(db, 'Monday').error?.code).toBe('23514');
    expect(
      call(
        db,
        'request_coach_practice_preference',
        {
          p_coach_id: COACH,
          p_dimension: 'venue',
          p_level: 'must_keep',
          p_value: '22222222-2222-4222-8222-222222222222',
        },
        'coach-user'
      ).error?.code
    ).toBe('23503');
    expect(
      call(db, 'request_coach_practice_preference', { p_coach_id: COACH }, 'coach-user').error?.code
    ).toBe('23502');
    expect(db.coach_practice_preferences.every((row) => row.organization_id === ORG)).toBe(true);
  });

  it('is wired into mockSupabase.rpc: a non-admin decide is refused there too', async () => {
    const db = freshDb();
    db.coach_practice_preferences.push({
      id: 'wired-1',
      organization_id: ORG,
      coach_id: COACH,
      dimension: 'weekday',
      level: 'must_keep',
      value: 'MON',
      status: 'requested',
      requested_at: NOW.toISOString(),
    });
    seedMockDb(db);
    sessionStorage.setItem('__MOCK_SESSION__', JSON.stringify({ user: { id: 'coach-user' } }));
    try {
      const refused = await mockSupabase.rpc('admin_decide_coach_practice_preference', {
        p_preference_id: 'wired-1',
        p_decision: 'approve',
      });
      expect(refused.error?.code).toBe('42501');
      sessionStorage.setItem('__MOCK_SESSION__', JSON.stringify({ user: { id: 'admin-user' } }));
      const approved = await mockSupabase.rpc('admin_decide_coach_practice_preference', {
        p_preference_id: 'wired-1',
        p_decision: 'approve',
      });
      expect(approved.error).toBeNull();
      expect(approved.data.status).toBe('approved');
    } finally {
      sessionStorage.removeItem('__MOCK_DB__');
      sessionStorage.removeItem('__MOCK_SESSION__');
    }
  });
});
