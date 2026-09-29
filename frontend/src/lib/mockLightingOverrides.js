/**
 * Mock arms for the four portable-lighting override RPCs of migration
 * `20261003000000_practice_lighting_overrides.sql` (8.9 D14 PR D).
 *
 * **Refusals included, not just the happy path** (LESSONS_LEARNED #13), with
 * the SQL's error codes and messages:
 *   - 23502 required arguments;
 *   - 42501 a request by anyone but a current coach of a team on the slot (org
 *     member) or an org admin; a decide or set by a non-admin or on an unknown
 *     row; a decision BY THE REQUESTER; a withdraw by anyone but the requester
 *     who still coaches the slot, or an org admin;
 *   - 22023 a decision other than approve/reject, `p_until` before `p_from`,
 *     deciding a row that is not `requested`, withdrawing one that is not
 *     `requested` or `approved`;
 *   - 23P01 the EXCLUDE constraint: an approval or a set whose window overlaps
 *     an approved window on the same slot.
 * "Coaches the slot" is `coachedPracticeSlotIds`, the same enumerator the
 * request form offers slots from, mirroring `caller_coaches_practice_slot`.
 *
 * **Not mirrored** (stated so nobody reads this as the database):
 *   - the read policy: the mock's generic `.from()` returns every row of the
 *     organization to any caller, where RLS shows a coach only the rows on
 *     slots they coach (the coach view filters to those slots itself);
 *   - `record_audit_event`: nothing in the UI reads the audit log;
 *   - the table's CHECK constraints beyond what the RPCs make reachable
 *     (`kind`, `status` and the decision/withdrawal bookkeeping), row locking
 *     (`FOR UPDATE`), and the `REVOKE` of direct table writes;
 *   - `current_date` is the UTC date here (`todayIso`), the server's date there.
 *
 * Pure over `db` so a test can drive it directly; `mockSupabaseClient.js`
 * wires it into `rpc()` and persists `db` afterwards.
 */

import {
  coachedPracticeSlotIds,
  windowOfDates,
  windowsOverlap,
} from '../utils/lightingOverrides.js';

export const LIGHTING_OVERRIDE_RPCS = Object.freeze([
  'request_practice_lighting_override',
  'admin_decide_practice_lighting_override',
  'withdraw_practice_lighting_override',
  'admin_set_practice_lighting_override',
]);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const fail = (code, message) => ({ data: null, error: { code, message } });

const overlapFailure = () =>
  fail(
    '23P01',
    'conflicting key value violates exclusion constraint "practice_lighting_overrides_no_overlap"'
  );

/**
 * @param {any} db - the mock database; mutated in place
 * @param {string} name
 * @param {Record<string, any>} params
 * @param {{ currentUserId: string, now?: Date, newId?: () => string }} ctx
 * @returns {{ data: any, error: any } | null} null when `name` is not one of these RPCs
 */
export function handleLightingOverrideRpc(db, name, params, ctx) {
  if (!LIGHTING_OVERRIDE_RPCS.includes(name)) return null;
  const { currentUserId } = ctx;
  const now = ctx.now ?? new Date();
  const today = now.toISOString().slice(0, 10);
  const newId = ctx.newId ?? (() => globalThis.crypto.randomUUID());
  const p = params || {};
  db.practice_lighting_overrides = db.practice_lighting_overrides || [];
  const table = db.practice_lighting_overrides;

  const roleIn = (orgId) =>
    (db.organization_members || []).find(
      (member) =>
        String(member.organization_id) === String(orgId) &&
        String(member.profile_id) === String(currentUserId)
    )?.role ?? null;
  const isOrgAdmin = (orgId) => ['admin', 'tenant_admin'].includes(String(roleIn(orgId) || ''));
  const isOrgMember = (orgId) => roleIn(orgId) !== null;
  const slotById = (slotId) =>
    (db.practice_slots || []).find((slot) => String(slot.id) === String(slotId)) ?? null;
  const coachesSlot = (slotId) => {
    const slot = slotById(slotId);
    if (!slot || !currentUserId) return false;
    return coachedPracticeSlotIds({
      userId: currentUserId,
      orgId: String(slot.organization_id),
      today,
      coaches: db.coaches,
      teamCoachAssignments: db.team_coach_assignments,
      practiceAssignments: db.practice_assignments,
      practiceSlots: db.practice_slots,
    }).has(String(slotId));
  };
  const overlapsApproved = (slotId, window, exceptId = null) =>
    table.some(
      (row) =>
        row.status === 'approved' &&
        String(row.practice_slot_id) === String(slotId) &&
        String(row.id) !== String(exceptId) &&
        windowsOverlap(row.window, window)
    );
  const badDates = () =>
    !ISO_DATE.test(String(p.p_from)) || !ISO_DATE.test(String(p.p_until))
      ? fail('22007', 'invalid input syntax for type date')
      : null;
  const inverted = () =>
    p.p_until < p.p_from
      ? fail(
          '22023',
          `a lighting override's p_until (${p.p_until}) precedes its p_from (${p.p_from})`
        )
      : null;
  const findRow = (id) => table.find((row) => String(row.id) === String(id)) ?? null;

  if (
    name === 'request_practice_lighting_override' ||
    name === 'admin_set_practice_lighting_override'
  ) {
    if (!p.p_practice_slot_id || !p.p_from || !p.p_until) {
      return fail('23502', 'p_practice_slot_id, p_from and p_until are required');
    }
    const orgId = slotById(p.p_practice_slot_id)?.organization_id ?? null;
    const isSet = name === 'admin_set_practice_lighting_override';
    if (isSet) {
      if (!currentUserId || !orgId || !isOrgAdmin(orgId)) {
        return fail('42501', 'Access denied: only an organization admin sets a lighting override');
      }
    } else {
      const byCoach = coachesSlot(p.p_practice_slot_id);
      if (!currentUserId || !orgId || !((byCoach && isOrgMember(orgId)) || isOrgAdmin(orgId))) {
        return fail(
          '42501',
          'Access denied: only a coach of a team on the slot or an admin of its organization requests a lighting override'
        );
      }
    }
    const refused = badDates() || inverted();
    if (refused) return refused;
    const window = windowOfDates(p.p_from, p.p_until);
    if (isSet && overlapsApproved(p.p_practice_slot_id, window)) return overlapFailure();
    const stamp = now.toISOString();
    const row = {
      id: newId(),
      organization_id: orgId,
      practice_slot_id: String(p.p_practice_slot_id),
      window,
      kind: 'portable-lighting',
      status: isSet ? 'approved' : 'requested',
      requested_by: currentUserId,
      requested_at: stamp,
      decided_by: isSet ? currentUserId : null,
      decided_at: isSet ? stamp : null,
      withdrawn_by: null,
      withdrawn_at: null,
    };
    table.push(row);
    return {
      data: {
        id: row.id,
        organization_id: orgId,
        practice_slot_id: row.practice_slot_id,
        from: p.p_from,
        until: p.p_until,
        kind: row.kind,
        status: row.status,
      },
      error: null,
    };
  }

  if (name === 'admin_decide_practice_lighting_override') {
    if (!p.p_override_id || !p.p_decision) {
      return fail('23502', 'p_override_id and p_decision are required');
    }
    if (!['approve', 'reject'].includes(p.p_decision)) {
      return fail('22023', `p_decision must be approve or reject, not ${p.p_decision}`);
    }
    const row = findRow(p.p_override_id);
    if (!row || !isOrgAdmin(row.organization_id)) {
      return fail('42501', 'Access denied: only an organization admin decides a lighting override');
    }
    if (!currentUserId || String(currentUserId) === String(row.requested_by)) {
      return fail(
        '42501',
        `Access denied: the requester of lighting override ${row.id} may not decide it; withdraw it, or have another admin decide`
      );
    }
    if (row.status !== 'requested') {
      return fail(
        '22023',
        `lighting override ${row.id} is already ${row.status}; only a requested row is decided`
      );
    }
    const status = p.p_decision === 'approve' ? 'approved' : 'rejected';
    if (status === 'approved' && overlapsApproved(row.practice_slot_id, row.window, row.id)) {
      return overlapFailure();
    }
    row.status = status;
    row.decided_by = currentUserId;
    row.decided_at = now.toISOString();
    return {
      data: { id: row.id, status, practice_slot_id: row.practice_slot_id },
      error: null,
    };
  }

  // withdraw_practice_lighting_override
  if (!p.p_override_id) return fail('23502', 'p_override_id is required');
  const row = findRow(p.p_override_id);
  const allowed =
    row &&
    currentUserId &&
    ((String(currentUserId) === String(row.requested_by) &&
      coachesSlot(row.practice_slot_id) &&
      isOrgMember(row.organization_id)) ||
      isOrgAdmin(row.organization_id));
  if (!allowed) {
    return fail(
      '42501',
      'Access denied: only the requester or an organization admin withdraws a lighting override'
    );
  }
  if (!['requested', 'approved'].includes(row.status)) {
    return fail(
      '22023',
      `lighting override ${row.id} is already ${row.status}; only a requested or approved row is withdrawn`
    );
  }
  const before = row.status;
  row.status = 'withdrawn';
  row.withdrawn_by = currentUserId;
  row.withdrawn_at = now.toISOString();
  return {
    data: {
      id: row.id,
      status: 'withdrawn',
      before_status: before,
      practice_slot_id: row.practice_slot_id,
    },
    error: null,
  };
}
