/**
 * Mock arms for the three coach practice preference RPCs of migration
 * `20260927000000_coach_practice_preferences.sql` (Phase 8.6 PR 3b, PR 2).
 *
 * **Refusals included, not just the happy path** (LESSONS_LEARNED #13): a mock
 * looser than the database lets a defect the database would refuse pass every
 * test. Mirrored here, with the SQL's error codes:
 *   - 23502 required arguments;
 *   - 42501 a request by anyone but the coach themself (org member) or an org
 *     admin; a decide or set by a non-admin (or on an unknown row / coach);
 *   - 22023 a decision other than approve/reject, deciding a row that is not
 *     `requested`, a rejection carrying a level or value, a stale approval;
 *   - 23503 a venue that is not a location of the coach's organization, and
 *     approving for a coach no longer in the organization;
 *   - 23514 the table's CHECKs (dimension, level, value shape).
 * Approve and set supersede the prior approved row for the same
 * (coach, dimension): `status = 'superseded'`, `effective_to = yesterday`, so
 * at most one approved row exists per pair (the partial unique index).
 *
 * Audit is not mirrored: nothing in the UI reads it. The rows carry
 * `organization_id` like every mock row.
 *
 * Pure over `db` so a test can drive it directly; `mockSupabaseClient.js`
 * wires it into `rpc()` and persists `db` afterwards.
 */

export const COACH_PREFERENCE_RPCS = Object.freeze([
  'request_coach_practice_preference',
  'admin_decide_coach_practice_preference',
  'admin_set_coach_practice_preference',
]);

const DIMENSIONS = ['weekday', 'start_time', 'venue'];
const LEVELS = ['must_keep', 'prefer_keep', 'dont_care'];
const WEEKDAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const fail = (code, message) => ({ data: null, error: { code, message } });

/** The table's `value_valid` CHECK. */
function valueValid(dimension, value) {
  if (value === null || value === undefined) return true;
  if (dimension === 'weekday') return typeof value === 'string' && WEEKDAYS.includes(value);
  if (dimension === 'start_time') {
    return Number.isInteger(value) && value >= 0 && value <= 1439;
  }
  if (dimension === 'venue') return typeof value === 'string' && UUID.test(value);
  return false;
}

function checkRow(dimension, level, value) {
  if (!DIMENSIONS.includes(dimension)) {
    return fail(
      '23514',
      'new row violates check constraint "coach_practice_preferences_dimension_known"'
    );
  }
  if (!LEVELS.includes(level)) {
    return fail(
      '23514',
      'new row violates check constraint "coach_practice_preferences_level_known"'
    );
  }
  if (!valueValid(dimension, value)) {
    return fail(
      '23514',
      'new row violates check constraint "coach_practice_preferences_value_valid"'
    );
  }
  return null;
}

function venueRefusal(db, orgId, dimension, value) {
  if (dimension !== 'venue' || typeof value !== 'string') return null;
  const known = (db.locations || []).some(
    (location) =>
      String(location.organization_id) === String(orgId) && String(location.id) === value
  );
  return known
    ? null
    : fail('23503', `venue ${value} is not a location of the coach's organization`);
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

/**
 * @param {any} db - the mock database; mutated in place
 * @param {string} name
 * @param {Record<string, any>} params
 * @param {{ currentUserId: string, now?: Date, newId?: () => string }} ctx
 * @returns {{ data: any, error: any } | null} null when `name` is not one of these RPCs
 */
export function handleCoachPreferenceRpc(db, name, params, ctx) {
  if (!COACH_PREFERENCE_RPCS.includes(name)) return null;
  const { currentUserId } = ctx;
  const now = ctx.now ?? new Date();
  const today = isoDate(now);
  const yesterday = isoDate(new Date(now.getTime() - 86400000));
  const newId = ctx.newId ?? (() => globalThis.crypto.randomUUID());
  const p = params || {};
  db.coach_practice_preferences = db.coach_practice_preferences || [];
  const table = db.coach_practice_preferences;

  const roleIn = (orgId) =>
    (db.organization_members || []).find(
      (member) =>
        String(member.organization_id) === String(orgId) &&
        String(member.profile_id) === String(currentUserId)
    )?.role ?? null;
  const isOrgAdmin = (orgId) => ['admin', 'tenant_admin'].includes(String(roleIn(orgId) || ''));
  const isOrgMember = (orgId) => roleIn(orgId) !== null;
  const coachById = (coachId) =>
    (db.coaches || []).find((coach) => String(coach.id) === String(coachId)) ?? null;
  const normValue = (value) => (value === undefined ? null : value);

  const supersede = (coachId, dimension) => {
    const prior = table.find(
      (row) =>
        String(row.coach_id) === String(coachId) &&
        row.dimension === dimension &&
        row.status === 'approved'
    );
    if (prior) {
      prior.status = 'superseded';
      prior.effective_to = yesterday;
    }
    return prior ?? null;
  };

  if (name === 'request_coach_practice_preference') {
    if (!p.p_coach_id || !p.p_dimension || !p.p_level) {
      return fail('23502', 'p_coach_id, p_dimension and p_level are required');
    }
    const coach = coachById(p.p_coach_id);
    const orgId = coach?.organization_id ?? null;
    const isSelf = Boolean(currentUserId) && String(coach?.user_id ?? '') === String(currentUserId);
    if (!orgId || !((isSelf && isOrgMember(orgId)) || isOrgAdmin(orgId))) {
      return fail(
        '42501',
        'Access denied: only the coach themself or an admin of their organization requests a coach practice preference'
      );
    }
    const value = normValue(p.p_value);
    const refused =
      venueRefusal(db, orgId, p.p_dimension, value) || checkRow(p.p_dimension, p.p_level, value);
    if (refused) return refused;
    const row = {
      id: newId(),
      organization_id: orgId,
      coach_id: String(p.p_coach_id),
      dimension: p.p_dimension,
      level: p.p_level,
      value,
      status: 'requested',
      requested_by: currentUserId,
      requested_at: now.toISOString(),
      decided_by: null,
      decided_at: null,
      effective_from: null,
      effective_to: null,
    };
    table.push(row);
    const { id, organization_id, coach_id, dimension, level, status } = row;
    return {
      data: { id, organization_id, coach_id, dimension, level, value, status },
      error: null,
    };
  }

  if (name === 'admin_decide_coach_practice_preference') {
    if (!p.p_preference_id || !p.p_decision) {
      return fail('23502', 'p_preference_id and p_decision are required');
    }
    if (!['approve', 'reject'].includes(p.p_decision)) {
      return fail('22023', `p_decision must be approve or reject, not ${p.p_decision}`);
    }
    const row = table.find((item) => String(item.id) === String(p.p_preference_id));
    if (!row || !isOrgAdmin(row.organization_id)) {
      return fail(
        '42501',
        'Access denied: only an organization admin decides a coach practice preference'
      );
    }
    if (row.status !== 'requested') {
      return fail(
        '22023',
        `coach practice preference ${row.id} is already ${row.status}; only a requested row is decided`
      );
    }
    const requested = { level: row.level, value: row.value };
    if (p.p_decision === 'reject') {
      const hasLevel = p.p_level !== undefined && p.p_level !== null;
      const hasValue = p.p_value !== undefined && p.p_value !== null;
      if (hasLevel || hasValue) {
        return fail(
          '22023',
          'a rejection changes nothing; p_level and p_value belong to an approval'
        );
      }
      row.status = 'rejected';
      row.decided_by = currentUserId;
      row.decided_at = now.toISOString();
      return {
        data: {
          id: row.id,
          status: 'rejected',
          coach_id: row.coach_id,
          dimension: row.dimension,
          level: null,
          value: null,
          superseded_id: null,
        },
        error: null,
      };
    }
    const level = p.p_level ?? requested.level;
    const value = p.p_value === undefined || p.p_value === null ? requested.value : p.p_value;
    const refused =
      venueRefusal(db, row.organization_id, row.dimension, value) ||
      checkRow(row.dimension, level, value);
    if (refused) return refused;
    const coach = coachById(row.coach_id);
    if (!coach || String(coach.organization_id) !== String(row.organization_id)) {
      return fail(
        '23503',
        `coach ${row.coach_id} no longer exists in the organization; the request cannot be approved`
      );
    }
    const stale = table.some(
      (item) =>
        String(item.coach_id) === String(row.coach_id) &&
        item.dimension === row.dimension &&
        item.status === 'approved' &&
        String(item.decided_at) > String(row.requested_at)
    );
    if (stale) {
      return fail(
        '22023',
        `coach practice preference ${row.id} is stale: a later decision on ${row.dimension} is in force`
      );
    }
    const prior = supersede(row.coach_id, row.dimension);
    row.status = 'approved';
    row.level = level;
    row.value = value;
    row.decided_by = currentUserId;
    row.decided_at = now.toISOString();
    row.effective_from = today;
    return {
      data: {
        id: row.id,
        status: 'approved',
        coach_id: row.coach_id,
        dimension: row.dimension,
        level,
        value,
        superseded_id: prior?.id ?? null,
      },
      error: null,
    };
  }

  // admin_set_coach_practice_preference
  if (!p.p_coach_id || !p.p_dimension || !p.p_level) {
    return fail('23502', 'p_coach_id, p_dimension and p_level are required');
  }
  const coach = coachById(p.p_coach_id);
  const orgId = coach?.organization_id ?? null;
  if (!orgId || !isOrgAdmin(orgId)) {
    return fail(
      '42501',
      'Access denied: only an organization admin sets a coach practice preference'
    );
  }
  const value = normValue(p.p_value);
  const refused =
    venueRefusal(db, orgId, p.p_dimension, value) || checkRow(p.p_dimension, p.p_level, value);
  if (refused) return refused;
  const prior = supersede(p.p_coach_id, p.p_dimension);
  const row = {
    id: newId(),
    organization_id: orgId,
    coach_id: String(p.p_coach_id),
    dimension: p.p_dimension,
    level: p.p_level,
    value,
    status: 'approved',
    requested_by: currentUserId,
    requested_at: now.toISOString(),
    decided_by: currentUserId,
    decided_at: now.toISOString(),
    effective_from: today,
    effective_to: null,
  };
  table.push(row);
  return {
    data: {
      id: row.id,
      status: 'approved',
      coach_id: row.coach_id,
      dimension: row.dimension,
      level: row.level,
      value,
      superseded_id: prior?.id ?? null,
    },
    error: null,
  };
}
