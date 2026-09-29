/**
 * Mock parity for the portable-lighting override RPCs
 * (`frontend/src/lib/mockLightingOverrides.js` vs migration 20261003000000),
 * and the window conversion the UI shares with core.
 *
 * Every expectation is enumerated from the SEED below (which slot each user
 * coaches is stated by construction), never from what the handler returns.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleLightingOverrideRpc } from '../frontend/src/lib/mockLightingOverrides.js';
import { mockSupabase } from '../frontend/src/lib/mockSupabaseClient.js';
import {
  coachedPracticeSlotIds,
  datesOfWindow,
  windowOfDates,
} from '../frontend/src/utils/lightingOverrides.js';
import { approvedLightingOverridesFromRows } from '../packages/core/src/practice/index.js';
import { seedMockDb } from './helpers/seedMockDb.js';

const ORG = 'org-l';
const OTHER_ORG = 'org-x';
const NOW = new Date('2026-09-29T12:00:00Z');
const TODAY = '2026-09-29';

/**
 * By construction: `coach-user` coaches T1 (on S1) currently and T3 (on S3)
 * only until 2026-02-01; `other-coach` coaches T2 (on S2). S4 is in another
 * organization, and `coach-user`'s coach row there must not count.
 */
const SEED_COACHED = Object.freeze({
  'coach-user': ['S1'],
  'other-coach': ['S2'],
  'admin-a': [],
});

function freshDb() {
  return {
    organization_members: [
      { organization_id: ORG, profile_id: 'admin-a', role: 'admin' },
      { organization_id: ORG, profile_id: 'admin-b', role: 'admin' },
      { organization_id: ORG, profile_id: 'coach-user', role: 'coach' },
      { organization_id: ORG, profile_id: 'other-coach', role: 'coach' },
    ],
    coaches: [
      { id: 'C1', organization_id: ORG, user_id: 'coach-user', full_name: 'Coach One' },
      { id: 'C2', organization_id: ORG, user_id: 'other-coach', full_name: 'Coach Two' },
      { id: 'CX', organization_id: OTHER_ORG, user_id: 'coach-user', full_name: 'Coach One X' },
    ],
    team_coach_assignments: [
      { organization_id: ORG, team_id: 'T1', coach_id: 'C1', effective_from: '2026-01-01' },
      { organization_id: ORG, team_id: 'T2', coach_id: 'C2', effective_from: '2026-01-01' },
      {
        organization_id: ORG,
        team_id: 'T3',
        coach_id: 'C1',
        effective_from: '2026-01-01',
        effective_to: '2026-02-01',
      },
      { organization_id: OTHER_ORG, team_id: 'TX', coach_id: 'CX', effective_from: '2026-01-01' },
    ],
    practice_assignments: [
      { organization_id: ORG, team_id: 'T1', slot_id: 'S1', practice_slot_id: 'S1' },
      { organization_id: ORG, team_id: 'T2', slot_id: 'S2', practice_slot_id: null },
      { organization_id: ORG, team_id: 'T3', slot_id: 'S3', practice_slot_id: 'S3' },
      { organization_id: OTHER_ORG, team_id: 'TX', slot_id: 'S4', practice_slot_id: 'S4' },
    ],
    practice_slots: [
      { id: 'S1', organization_id: ORG },
      { id: 'S2', organization_id: ORG },
      { id: 'S3', organization_id: ORG },
      { id: 'S4', organization_id: OTHER_ORG },
    ],
    practice_lighting_overrides: [],
  };
}

let seq;
beforeEach(() => {
  seq = 0;
});
const call = (db, name, params, user) =>
  handleLightingOverrideRpc(db, name, params, {
    currentUserId: user,
    now: NOW,
    newId: () => `lo-${++seq}`,
  });
const request = (db, slot, from, until, user) =>
  call(
    db,
    'request_practice_lighting_override',
    { p_practice_slot_id: slot, p_from: from, p_until: until },
    user
  );
const decide = (db, id, decision, user) =>
  call(
    db,
    'admin_decide_practice_lighting_override',
    { p_override_id: id, p_decision: decision },
    user
  );
const withdraw = (db, id, user) =>
  call(db, 'withdraw_practice_lighting_override', { p_override_id: id }, user);
const set = (db, slot, from, until, user = 'admin-a') =>
  call(
    db,
    'admin_set_practice_lighting_override',
    { p_practice_slot_id: slot, p_from: from, p_until: until },
    user
  );

describe('coach scoping (caller_coaches_practice_slot)', () => {
  it('a coach is offered, and may request on, exactly the slots the seed says they coach', () => {
    const db = freshDb();
    const orgSlots = db.practice_slots.filter((slot) => slot.organization_id === ORG);
    // Meta: the seed holds both kinds of slot for coach-user, so neither half is vacuous.
    expect(SEED_COACHED['coach-user'].length).toBeGreaterThan(0);
    expect(orgSlots.length - SEED_COACHED['coach-user'].length).toBeGreaterThanOrEqual(2);
    for (const [user, expected] of Object.entries(SEED_COACHED)) {
      const offered = coachedPracticeSlotIds({
        userId: user,
        orgId: ORG,
        today: TODAY,
        coaches: db.coaches,
        teamCoachAssignments: db.team_coach_assignments,
        practiceAssignments: db.practice_assignments,
        practiceSlots: db.practice_slots,
      });
      expect([...offered].sort()).toEqual([...expected].sort());
    }
    for (const slot of orgSlots) {
      const coached = SEED_COACHED['coach-user'].includes(slot.id);
      const result = request(db, slot.id, '2026-10-01', '2026-10-02', 'coach-user');
      expect(result.error?.code ?? null).toBe(coached ? null : '42501');
    }
    // Another org's slot: refused (not a member, not coached there by this org's roster).
    expect(request(db, 'S4', '2026-10-01', '2026-10-02', 'coach-user').error?.code).toBe('42501');
    // An admin may request on any slot of the org.
    expect(request(db, 'S2', '2026-10-01', '2026-10-02', 'admin-a').error).toBeNull();
  });

  it('refuses missing arguments and an inverted window', () => {
    const db = freshDb();
    expect(request(db, 'S1', null, '2026-10-02', 'coach-user').error?.code).toBe('23502');
    expect(request(db, 'S1', '2026-10-05', '2026-10-01', 'coach-user').error?.code).toBe('22023');
    // A date Postgres cannot hold is refused, never rolled into March.
    expect(request(db, 'S1', '2026-02-30', '2026-02-30', 'coach-user').error?.code).toBe('22008');
    expect(db.practice_lighting_overrides).toHaveLength(0);
  });
});

describe('decide', () => {
  it('never lets the requester decide their own request; another admin may', () => {
    const db = freshDb();
    const { data } = request(db, 'S2', '2026-10-01', '2026-10-03', 'admin-a');
    const own = decide(db, data.id, 'approve', 'admin-a');
    expect(own.error?.code).toBe('42501');
    expect(own.error?.message).toMatch(/requester .* may not decide it/);
    expect(db.practice_lighting_overrides[0].status).toBe('requested');
    expect(decide(db, data.id, 'reject', 'admin-a').error?.code).toBe('42501');
    const other = decide(db, data.id, 'approve', 'admin-b');
    expect(other.error).toBeNull();
    expect(db.practice_lighting_overrides[0]).toMatchObject({
      status: 'approved',
      decided_by: 'admin-b',
    });
    // Only a requested row is decided.
    expect(decide(db, data.id, 'reject', 'admin-b').error?.code).toBe('22023');
  });

  it('refuses a coach decision and an unknown decision', () => {
    const db = freshDb();
    const { data } = request(db, 'S1', '2026-10-01', '2026-10-03', 'coach-user');
    expect(decide(db, data.id, 'approve', 'coach-user').error?.code).toBe('42501');
    expect(decide(db, data.id, 'approve', 'other-coach').error?.code).toBe('42501');
    expect(decide(db, data.id, 'maybe', 'admin-a').error?.code).toBe('22023');
    expect(db.practice_lighting_overrides[0].status).toBe('requested');
  });

  it('refuses an approval or set overlapping an approved window on the same slot (23P01)', () => {
    const db = freshDb();
    expect(set(db, 'S1', '2026-10-01', '2026-10-05').error).toBeNull();
    const overlapping = request(db, 'S1', '2026-10-05', '2026-10-07', 'coach-user').data;
    const adjacent = request(db, 'S1', '2026-10-06', '2026-10-07', 'coach-user').data;
    const refused = decide(db, overlapping.id, 'approve', 'admin-a');
    expect(refused.error?.code).toBe('23P01');
    expect(refused.error?.message).toContain('practice_lighting_overrides_no_overlap');
    expect(db.practice_lighting_overrides.find((r) => r.id === overlapping.id).status).toBe(
      'requested'
    );
    // Rejecting an overlapping request is fine; the adjacent window approves.
    expect(decide(db, adjacent.id, 'approve', 'admin-a').error).toBeNull();
    expect(set(db, 'S1', '2026-09-28', '2026-10-01').error?.code).toBe('23P01');
    // The constraint is per slot: the same dates on S2 are not an overlap.
    expect(set(db, 'S2', '2026-10-01', '2026-10-05').error).toBeNull();
    // A withdrawn approval no longer blocks -- but the overlapping request
    // (10-05..10-07) still meets the approved adjacent one (10-06..10-07).
    const first = db.practice_lighting_overrides.find((r) => r.id === 'lo-1');
    expect(withdraw(db, first.id, 'admin-a').error).toBeNull();
    expect(decide(db, overlapping.id, 'approve', 'admin-b').error?.code).toBe('23P01');
    expect(withdraw(db, adjacent.id, 'admin-a').error).toBeNull();
    expect(decide(db, overlapping.id, 'approve', 'admin-b').error).toBeNull();
  });
});

describe('withdraw', () => {
  it('is the requester (while coaching the slot) or an admin, on requested or approved rows only', () => {
    const db = freshDb();
    const mineRequested = request(db, 'S1', '2026-10-01', '2026-10-01', 'coach-user').data;
    const mineApproved = request(db, 'S1', '2026-10-03', '2026-10-03', 'coach-user').data;
    const mineRejected = request(db, 'S1', '2026-10-05', '2026-10-05', 'coach-user').data;
    const theirs = request(db, 'S2', '2026-10-01', '2026-10-01', 'other-coach').data;
    const adminSetOnMySlot = set(db, 'S1', '2026-11-01', '2026-11-02').data;
    decide(db, mineApproved.id, 'approve', 'admin-a');
    decide(db, mineRejected.id, 'reject', 'admin-a');

    expect(withdraw(db, theirs.id, 'coach-user').error?.code).toBe('42501');
    expect(withdraw(db, adminSetOnMySlot.id, 'coach-user').error?.code).toBe('42501');
    expect(withdraw(db, mineRejected.id, 'coach-user').error?.code).toBe('22023');
    expect(withdraw(db, mineRequested.id, 'coach-user').error).toBeNull();
    const approved = withdraw(db, mineApproved.id, 'coach-user');
    expect(approved.error).toBeNull();
    expect(approved.data.before_status).toBe('approved');
    expect(withdraw(db, mineRequested.id, 'coach-user').error?.code).toBe('22023');
    // An admin withdraws anyone's.
    expect(withdraw(db, theirs.id, 'admin-a').error).toBeNull();
  });

  it('refuses the requester once they no longer coach the slot', () => {
    const db = freshDb();
    const mine = request(db, 'S1', '2026-10-01', '2026-10-01', 'coach-user').data;
    db.team_coach_assignments[0].effective_to = '2026-09-01';
    expect(withdraw(db, mine.id, 'coach-user').error?.code).toBe('42501');
  });
});

describe('window conversion', () => {
  it('stores inclusive dates as [from,until+1) and reads them back as core does', () => {
    const cases = [
      ['2026-10-01', '2026-10-01'],
      ['2026-12-30', '2026-12-31'],
      ['2028-02-28', '2028-02-29'],
      ['2027-02-28', '2027-03-01'],
    ];
    for (const [from, until] of cases) {
      const window = windowOfDates(from, until);
      expect(datesOfWindow(window)).toEqual({ from, until });
      const [core] = approvedLightingOverridesFromRows([
        { practice_slot_id: 'S1', window, kind: 'portable-lighting', status: 'approved' },
      ]);
      expect(core).toEqual({ slotId: 'S1', from, until });
    }
    expect(windowOfDates('2026-12-30', '2026-12-31')).toBe('[2026-12-30,2027-01-01)');
    expect(datesOfWindow('(2026-10-01,2026-10-02]')).toBeNull();
  });
});

describe('wiring', () => {
  it('is wired into mockSupabase.rpc: a self-decide is refused there too', async () => {
    const db = freshDb();
    db.practice_lighting_overrides.push({
      id: 'wired-1',
      organization_id: ORG,
      practice_slot_id: 'S2',
      window: '[2026-10-01,2026-10-02)',
      kind: 'portable-lighting',
      status: 'requested',
      requested_by: 'admin-a',
      requested_at: NOW.toISOString(),
    });
    seedMockDb(db);
    sessionStorage.setItem('__MOCK_SESSION__', JSON.stringify({ user: { id: 'admin-a' } }));
    try {
      const refused = await mockSupabase.rpc('admin_decide_practice_lighting_override', {
        p_override_id: 'wired-1',
        p_decision: 'approve',
      });
      expect(refused.error?.code).toBe('42501');
      sessionStorage.setItem('__MOCK_SESSION__', JSON.stringify({ user: { id: 'admin-b' } }));
      const approved = await mockSupabase.rpc('admin_decide_practice_lighting_override', {
        p_override_id: 'wired-1',
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
