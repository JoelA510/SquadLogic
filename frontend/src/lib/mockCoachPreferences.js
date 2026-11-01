/**
 * Mock arms for the practice preference rule RPCs and the preference import (migration
 * `20261112010000_practice_preference_rules.sql`; Phase D C1): `admin_add_practice_preference`,
 * `admin_edit_practice_preference`, `admin_remove_practice_preference`,
 * `admin_decide_must_preference`, `admin_accept_all_musts` and
 * `finalize_practice_preference_import_job`.
 *
 * **Refusals included, not just the happy path** (LESSONS_LEARNED #13): a mock looser than the
 * database lets a defect the database would refuse pass every test. Mirrored here, with the SQL's
 * error codes:
 *   - 23502 required arguments;
 *   - 42501 a write by a non-admin, or on an unknown row, team or job (the same refusal, so the RPC
 *     cannot probe which ids exist);
 *   - 22023 a level or decision outside the vocabulary, a coach who does not coach the team today
 *     (`coach_not_on_team`), a rule that is not in force or not pending, a completed season
 *     (`season_completed`), and Accept all's count differing from the confirmation's
 *     (`expected_count_mismatch`);
 *   - 23514 the table's CHECKs, by constraint name, and the tenancy trigger.
 *
 * The finalizer reads a staged row through `utils/practicePreferenceRows.js`, the twin of the SQL's
 * parsing. Audit rows are written (the preference page and the settings audit trail read them).
 *
 * Pure over `db` so a test can drive it directly; `mockSupabaseClient.js` wires it into `rpc()` and
 * persists `db` afterwards.
 */

import { ADMIN_ROLES } from '../constants/permissions.js';
import { parsePreferenceRow } from '../utils/practicePreferenceRows.js';
import { enrollmentRefusal, importSeasonMissing, importSeasonOf } from './mockEnrollment.js';

export const COACH_PREFERENCE_RPCS = Object.freeze([
  'admin_add_practice_preference',
  'admin_edit_practice_preference',
  'admin_remove_practice_preference',
  'admin_decide_must_preference',
  'admin_accept_all_musts',
  'finalize_practice_preference_import_job',
]);

const WEEKDAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const PRIORITIES = ['high', 'medium', 'low'];

const fail = (code, message, details) => ({
  data: null,
  error: { code, message, ...(details ? { details } : {}) },
});
const same = (a, b) => String(a) === String(b);
const check = (name) =>
  fail(
    '23514',
    `new row for relation "coach_practice_preferences" violates check constraint "${name}"`
  );

/** A set condition: absent, or non-empty with no duplicate and no null. */
const setOk = (values) =>
  values === null ||
  values === undefined ||
  (Array.isArray(values) &&
    values.length > 0 &&
    values.every((v) => v !== null && v !== undefined) &&
    new Set(values).size === values.length);

/**
 * The table's CHECKs, in the order they are named in the migration, as a refusal or null.
 * @param {any} row
 */
function ruleCheckRefusal(row) {
  if (!['prefer', 'must'].includes(row.level))
    return check('coach_practice_preferences_level_known');
  if (!['prefer', 'must'].includes(row.requested_level)) {
    return check('coach_practice_preferences_requested_level_known');
  }
  if (
    row.must_decision != null &&
    !['pending', 'accepted', 'kept_prefer'].includes(row.must_decision)
  ) {
    return check('coach_practice_preferences_must_decision_known');
  }
  if ((row.requested_level === 'must') !== (row.must_decision != null)) {
    return check('coach_practice_preferences_must_asked_decided');
  }
  if ((row.level === 'must') !== (row.must_decision === 'accepted')) {
    return check('coach_practice_preferences_must_only_when_accepted');
  }
  if (!['in_force', 'removed', 'replaced'].includes(row.status)) {
    return check('coach_practice_preferences_status_known');
  }
  if (row.status === 'in_force' && !row.team_id) {
    return check('coach_practice_preferences_team_when_in_force');
  }
  if (
    !setOk(row.weekdays) ||
    (row.weekdays != null && !row.weekdays.every((day) => WEEKDAYS.includes(day)))
  ) {
    return check('coach_practice_preferences_weekdays_valid');
  }
  if (
    !setOk(row.start_minutes) ||
    (row.start_minutes != null &&
      !row.start_minutes.every((m) => Number.isInteger(m) && m >= 0 && m <= 1439))
  ) {
    return check('coach_practice_preferences_start_minutes_valid');
  }
  if (!setOk(row.venue_ids)) return check('coach_practice_preferences_venue_ids_valid');
  if (
    (row.keep_weekday && row.weekdays != null) ||
    (row.keep_start && row.start_minutes != null) ||
    (row.keep_venue && row.venue_ids != null)
  ) {
    return check('coach_practice_preferences_keep_or_values');
  }
  if (
    row.weekdays == null &&
    row.start_minutes == null &&
    row.venue_ids == null &&
    !row.keep_weekday &&
    !row.keep_start &&
    !row.keep_venue
  ) {
    return check('coach_practice_preferences_has_condition');
  }
  if (row.coach_priority != null && !PRIORITIES.includes(row.coach_priority)) {
    return check('coach_practice_preferences_priority_known');
  }
  if (row.import_job_id != null && row.source !== 'import') {
    return check('coach_practice_preferences_import_job_is_import');
  }
  if (row.effective_from && row.effective_to && row.effective_to < row.effective_from) {
    return check('coach_practice_preferences_window_ordered');
  }
  return null;
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
  const today = now.toISOString().slice(0, 10);
  const newId = ctx.newId ?? (() => globalThis.crypto.randomUUID());
  const p = params || {};
  db.coach_practice_preferences = db.coach_practice_preferences || [];
  const table = db.coach_practice_preferences;

  const isOrgAdmin = (orgId) => {
    const role = (db.organization_members || []).find(
      (member) => same(member.organization_id, orgId) && same(member.profile_id, currentUserId)
    )?.role;
    return ADMIN_ROLES.includes(String(role || ''));
  };
  const audit = (organizationId, action, resourceType, resourceId, metadata) => {
    db.audit_log = db.audit_log || [];
    db.audit_log.push({
      id: newId(),
      organization_id: organizationId,
      action,
      user_id: currentUserId,
      resource_type: resourceType,
      resource_id: resourceId,
      metadata,
      created_at: now.toISOString(),
    });
  };
  const teamById = (teamId) => (db.teams || []).find((team) => same(team.id, teamId)) ?? null;
  const divisionOf = (team) =>
    (db.divisions || []).find((d) => same(d.id, team?.division_id)) ?? null;
  const seasonOfTeam = (team) =>
    (db.season_settings || []).find((s) => same(s.id, divisionOf(team)?.season_settings_id)) ??
    null;
  const coachesToday = (teamId, coachId) =>
    (db.team_coach_assignments || []).some(
      (a) =>
        same(a.team_id, teamId) &&
        same(a.coach_id, coachId) &&
        a.effective_from <= today &&
        (a.effective_to == null || a.effective_to >= today)
    );
  const adminDenied = (what) => fail('42501', `Access denied: only an organization admin ${what}`);
  const completed = (what) =>
    fail('22023', `The season of ${what} is completed and takes no change`, 'season_completed');

  /** The tenancy trigger: the team and venues belong to the row's organization, the coach to the team's season. */
  const tenancyRefusal = (row) => {
    if (row.team_id) {
      const team = teamById(row.team_id);
      if (!team || !same(team.organization_id, row.organization_id)) {
        return fail(
          '23514',
          `practice preference: team ${row.team_id} does not belong to organization ${row.organization_id}`
        );
      }
      const coach = (db.coaches || []).find(
        (c) => same(c.id, row.coach_id) && same(c.organization_id, row.organization_id)
      );
      if (!coach) {
        return fail(
          '23514',
          `practice preference: coach ${row.coach_id} is not a coach of organization ${row.organization_id}`
        );
      }
      if (!same(coach.season_settings_id, divisionOf(team)?.season_settings_id)) {
        return fail(
          '23514',
          `practice preference: coach ${row.coach_id} and team ${row.team_id} belong to different seasons`
        );
      }
    }
    if (row.venue_ids) {
      const bad = row.venue_ids.filter(
        (venue) =>
          !(db.locations || []).some(
            (l) => same(l.id, venue) && same(l.organization_id, row.organization_id)
          )
      );
      if (bad.length > 0) {
        return fail(
          '23514',
          `practice preference: ${bad.length} venue(s) are not locations of organization ${row.organization_id}`
        );
      }
    }
    return null;
  };

  const conditionsOf = (src) => ({
    weekdays: src.p_weekdays ?? null,
    start_minutes: src.p_start_minutes ?? null,
    venue_ids: src.p_venue_ids ?? null,
    keep_weekday: src.p_keep_weekday === true,
    keep_start: src.p_keep_start === true,
    keep_venue: src.p_keep_venue === true,
    coach_priority: src.p_coach_priority ?? null,
    effective_from: src.p_effective_from ?? null,
    effective_to: src.p_effective_to ?? null,
  });

  if (name === 'admin_add_practice_preference') {
    if (!p.p_coach_id || !p.p_team_id)
      return fail('23502', 'p_coach_id and p_team_id are required');
    const team = teamById(p.p_team_id);
    if (!team || !isOrgAdmin(team.organization_id))
      return adminDenied('adds a practice preference');
    const level = p.p_level ?? 'prefer';
    if (!['prefer', 'must'].includes(level)) {
      return fail('22023', `p_level must be prefer or must, not ${p.p_level}`);
    }
    if (seasonOfTeam(team)?.status === 'completed') {
      return completed(`team ${p.p_team_id}`);
    }
    if (!coachesToday(p.p_team_id, p.p_coach_id)) {
      return fail(
        '22023',
        `coach ${p.p_coach_id} does not coach team ${p.p_team_id} today, so cannot hold a rule for it`,
        'coach_not_on_team'
      );
    }
    const row = {
      id: newId(),
      organization_id: team.organization_id,
      coach_id: String(p.p_coach_id),
      team_id: String(p.p_team_id),
      ...conditionsOf(p),
      level,
      requested_level: level,
      must_decision: level === 'must' ? 'accepted' : null,
      status: 'in_force',
      source: 'admin',
      import_job_id: null,
      created_by: currentUserId,
      created_at: now.toISOString(),
      decided_by: level === 'must' ? currentUserId : null,
      decided_at: level === 'must' ? now.toISOString() : null,
      updated_by: null,
      updated_at: null,
    };
    const refused = ruleCheckRefusal(row) || tenancyRefusal(row);
    if (refused) return refused;
    table.push(row);
    audit(row.organization_id, 'practice_preference.added', 'coach_practice_preference', row.id, {
      after: { ...row },
    });
    return { data: { ...row }, error: null };
  }

  if (name === 'admin_accept_all_musts') {
    if (!p.p_import_job_id || p.p_expected_count === undefined || p.p_expected_count === null) {
      return fail('23502', 'p_import_job_id and p_expected_count are required');
    }
    const job = (db.import_jobs || []).find((item) => same(item.id, p.p_import_job_id));
    if (!job || !isOrgAdmin(job.organization_id)) return adminDenied('accepts requested musts');
    if (p.p_expected_count < 0) return fail('22023', 'p_expected_count must not be negative');
    if (importSeasonOf(db, job)?.status === 'completed') {
      return completed(`import job ${p.p_import_job_id}`);
    }
    const pending = table.filter(
      (row) =>
        same(row.organization_id, job.organization_id) &&
        same(row.import_job_id, p.p_import_job_id) &&
        row.status === 'in_force' &&
        row.must_decision === 'pending'
    );
    if (pending.length !== p.p_expected_count) {
      return fail(
        '22023',
        `import job ${p.p_import_job_id} has ${pending.length} pending must(s), not the ${p.p_expected_count} the confirmation showed; nothing was accepted`,
        'expected_count_mismatch'
      );
    }
    for (const row of pending) {
      Object.assign(row, {
        level: 'must',
        must_decision: 'accepted',
        decided_by: currentUserId,
        decided_at: now.toISOString(),
        updated_by: currentUserId,
        updated_at: now.toISOString(),
      });
    }
    audit(job.organization_id, 'practice_preference.musts_accepted', 'import_job', job.id, {
      accepted_count: pending.length,
      expected_count: p.p_expected_count,
      preference_ids: pending.map((row) => row.id).sort(),
    });
    return { data: { accepted: pending.length, import_job_id: p.p_import_job_id }, error: null };
  }

  if (name === 'finalize_practice_preference_import_job') {
    return finalizeImport(db, p, { currentUserId, now, newId, isOrgAdmin, audit, today });
  }

  // edit, remove and decide all start from a row.
  const idArg = p.p_preference_id;
  if (!idArg || (name === 'admin_decide_must_preference' && !p.p_decision)) {
    return fail('23502', 'p_preference_id (and p_decision) are required');
  }
  const row = table.find((item) => same(item.id, idArg));
  const verb =
    name === 'admin_edit_practice_preference'
      ? 'edits a practice preference'
      : name === 'admin_remove_practice_preference'
        ? 'removes a practice preference'
        : 'decides a requested must';
  if (!row || !isOrgAdmin(row.organization_id)) return adminDenied(verb);
  const before = { ...row };
  const team = teamById(row.team_id);
  const seasonDone = () => team && seasonOfTeam(team)?.status === 'completed';

  if (name === 'admin_decide_must_preference') {
    if (!['accept', 'keep_prefer'].includes(p.p_decision)) {
      return fail('22023', `p_decision must be accept or keep_prefer, not ${p.p_decision}`);
    }
    if (row.status !== 'in_force' || row.must_decision !== 'pending') {
      return fail(
        '22023',
        `practice preference ${row.id} is not a pending must (status ${row.status}, decision ${row.must_decision})`,
        'not_pending'
      );
    }
    if (seasonDone()) return completed(`practice preference ${row.id}`);
    Object.assign(row, {
      level: p.p_decision === 'accept' ? 'must' : 'prefer',
      must_decision: p.p_decision === 'accept' ? 'accepted' : 'kept_prefer',
      decided_by: currentUserId,
      decided_at: now.toISOString(),
      updated_by: currentUserId,
      updated_at: now.toISOString(),
    });
    audit(
      row.organization_id,
      'practice_preference.must_decided',
      'coach_practice_preference',
      row.id,
      {
        decision: p.p_decision,
        before,
        after: { ...row },
      }
    );
    return { data: { ...row }, error: null };
  }

  if (row.status !== 'in_force') {
    return fail(
      '22023',
      `practice preference ${row.id} is ${row.status}, not in force, so it cannot be ${name === 'admin_edit_practice_preference' ? 'edited' : 'removed'}`,
      'not_in_force'
    );
  }
  if (name === 'admin_remove_practice_preference') {
    if (seasonDone()) return completed(`practice preference ${row.id}`);
    Object.assign(row, {
      status: 'removed',
      updated_by: currentUserId,
      updated_at: now.toISOString(),
    });
    audit(row.organization_id, 'practice_preference.removed', 'coach_practice_preference', row.id, {
      before,
      after: { ...row },
    });
    return { data: { ...row }, error: null };
  }

  // admin_edit_practice_preference
  const level = p.p_level ?? 'prefer';
  if (!['prefer', 'must'].includes(level)) {
    return fail('22023', `p_level must be prefer or must, not ${p.p_level}`);
  }
  if (seasonDone()) return completed(`practice preference ${row.id}`);
  const draft = {
    ...row,
    ...conditionsOf(p),
    level,
    requested_level: level === 'must' ? 'must' : row.requested_level,
    must_decision:
      level === 'must' ? 'accepted' : row.requested_level === 'must' ? 'kept_prefer' : null,
    ...(level === 'must' || row.requested_level === 'must'
      ? { decided_by: currentUserId, decided_at: now.toISOString() }
      : {}),
    updated_by: currentUserId,
    updated_at: now.toISOString(),
  };
  const refused = ruleCheckRefusal(draft) || tenancyRefusal(draft);
  if (refused) return refused;
  Object.assign(row, draft);
  audit(row.organization_id, 'practice_preference.edited', 'coach_practice_preference', row.id, {
    before,
    after: { ...row },
  });
  return { data: { ...row }, error: null };
}

/** `finalize_practice_preference_import_job`, as the SQL does it. */
function finalizeImport(db, p, { currentUserId, now, newId, isOrgAdmin, audit, today }) {
  const jobId = p.p_import_job_id;
  if (!jobId) return fail('22023', 'p_import_job_id is required');
  const errors = p.p_validation_errors ?? [];
  if (!Array.isArray(errors)) return fail('22023', 'p_validation_errors must be a jsonb array');
  const job = (db.import_jobs || []).find((item) => same(item.id, jobId));
  if (!job) return fail('P0002', `Import job ${jobId} not found`);
  if (!currentUserId || !isOrgAdmin(job.organization_id)) {
    return fail(
      '42501',
      `Access denied: user is not an admin of organization ${job.organization_id}`
    );
  }
  if (job.job_type !== 'registration') {
    return fail('22023', `Import job ${jobId} is ${job.job_type}, not registration`);
  }
  if (job.status === 'failed')
    return fail('22023', `Failed import job ${jobId} cannot be finalized`);
  const season = importSeasonOf(db, job);
  if (!season) return importSeasonMissing(job.organization_id);
  if (season.status === 'completed') {
    return enrollmentRefusal(
      `Season ${season.id} is completed and takes no import`,
      'season_completed'
    );
  }

  const orgId = job.organization_id;
  const nowIso = now.toISOString();
  const locations = (db.locations || []).filter((l) => same(l.organization_id, orgId));
  const seasonTeams = (db.teams || []).filter(
    (team) =>
      same(team.organization_id, orgId) &&
      same(
        (db.divisions || []).find((d) => same(d.id, team.division_id))?.season_settings_id,
        season.id
      )
  );
  const coachesToday = (teamId, coachId) =>
    (db.team_coach_assignments || []).some(
      (a) =>
        same(a.organization_id ?? orgId, orgId) &&
        same(a.team_id, teamId) &&
        same(a.coach_id, coachId) &&
        a.effective_from <= today &&
        (a.effective_to == null || a.effective_to >= today)
    );

  const staged = (db.staging_import_rows || [])
    .filter(
      (row) =>
        same(row.import_job_id, jobId) &&
        same(row.organization_id ?? orgId, orgId) &&
        row.import_type === 'practice_preferences' &&
        !row.applied_at &&
        row.normalized_payload &&
        (!row.validation_errors || row.validation_errors.length === 0)
    )
    .sort((a, b) => (a.source_row_number ?? 0) - (b.source_row_number ?? 0));

  const counts = {
    invalid: 0,
    unknownCoach: 0,
    unknownTeam: 0,
    noTeam: 0,
    notOnTeam: 0,
    duplicate: 0,
  };
  const unknownCoaches = [];
  const unknownTeams = [];
  const seen = new Set();
  const rules = [];
  const refuse = (row, message, kind) => {
    row.validation_errors = [{ message, source_row_number: row.source_row_number }];
    counts[kind] += 1;
  };

  for (const row of staged) {
    const parsed = parsePreferenceRow(row.normalized_payload, { locations });
    if (!parsed.ok) {
      refuse(row, parsed.message, 'invalid');
      continue;
    }
    const rule = /** @type {NonNullable<typeof parsed.rule>} */ (parsed.rule);
    const coach = (db.coaches || []).find(
      (c) =>
        same(c.organization_id, orgId) &&
        same(c.season_settings_id, season.id) &&
        String(c.email).toLowerCase() === rule.email
    );
    if (!coach) {
      refuse(row, 'No coach with this email in the season', 'unknownCoach');
      if (unknownCoaches.length < 200)
        unknownCoaches.push({ row: row.source_row_number, email: rule.email });
      continue;
    }
    let teamIds;
    if (rule.team !== null) {
      const matches = seasonTeams.filter(
        (team) => String(team.name).trim().toLowerCase() === rule.team.toLowerCase()
      );
      if (matches.length === 0) {
        refuse(row, 'No team with this name in the season', 'unknownTeam');
        if (unknownTeams.length < 200)
          unknownTeams.push({ row: row.source_row_number, team: rule.team });
        continue;
      }
      if (matches.length > 1) {
        refuse(row, 'More than one team in the season has this name', 'invalid');
        continue;
      }
      if (!coachesToday(matches[0].id, coach.id)) {
        refuse(row, 'The coach does not coach this team', 'notOnTeam');
        continue;
      }
      teamIds = [String(matches[0].id)];
    } else {
      teamIds = [
        ...new Set(
          (db.team_coach_assignments || [])
            .filter(
              (a) =>
                same(a.coach_id, coach.id) &&
                seasonTeams.some((team) => same(team.id, a.team_id)) &&
                a.effective_from <= today &&
                (a.effective_to == null || a.effective_to >= today)
            )
            .map((a) => String(a.team_id))
        ),
      ].sort();
      if (teamIds.length === 0) {
        refuse(row, 'The row names no team and the coach coaches none in the season', 'noTeam');
        continue;
      }
    }
    for (const teamId of teamIds) {
      const signature = JSON.stringify([
        teamId,
        String(coach.id),
        rule.requestedLevel,
        rule.weekdays,
        rule.startMinutes,
        rule.venueIds,
        rule.effectiveFrom,
        rule.effectiveTo,
        rule.coachPriority,
      ]);
      if (seen.has(signature)) counts.duplicate += 1;
      else {
        seen.add(signature);
        rules.push({ ...rule, teamId, coachId: String(coach.id) });
      }
    }
    row.applied_at = nowIso;
    row.applied_by = currentUserId;
  }

  // The imported rules of the teams the file names are replaced; admin rules are not.
  const named = new Set(rules.map((rule) => rule.teamId));
  const replaced = [];
  for (const existing of db.coach_practice_preferences) {
    if (
      same(existing.organization_id, orgId) &&
      existing.source === 'import' &&
      existing.status === 'in_force' &&
      named.has(String(existing.team_id))
    ) {
      Object.assign(existing, {
        status: 'replaced',
        updated_by: currentUserId,
        updated_at: nowIso,
      });
      replaced.push(existing.id);
    }
  }
  const insertedIds = [];
  let pending = 0;
  for (const rule of rules) {
    const created = {
      id: newId(),
      organization_id: orgId,
      coach_id: rule.coachId,
      team_id: rule.teamId,
      weekdays: rule.weekdays,
      start_minutes: rule.startMinutes,
      venue_ids: rule.venueIds,
      keep_weekday: false,
      keep_start: false,
      keep_venue: false,
      coach_priority: rule.coachPriority,
      effective_from: rule.effectiveFrom,
      effective_to: rule.effectiveTo,
      level: 'prefer',
      requested_level: rule.requestedLevel,
      must_decision: rule.requestedLevel === 'must' ? 'pending' : null,
      status: 'in_force',
      source: 'import',
      import_job_id: jobId,
      created_by: currentUserId,
      created_at: nowIso,
      decided_by: null,
      decided_at: null,
      updated_by: null,
      updated_at: null,
    };
    db.coach_practice_preferences.push(created);
    insertedIds.push(created.id);
    if (created.must_decision === 'pending') pending += 1;
  }

  const warned =
    errors.length > 0 ||
    counts.invalid + counts.unknownCoach + counts.unknownTeam + counts.noTeam + counts.notOnTeam >
      0;
  const result = {
    status: warned ? 'completed_with_warnings' : 'completed',
    staged_rows: (db.staging_import_rows || []).filter(
      (row) => same(row.import_job_id, jobId) && row.import_type === 'practice_preferences'
    ).length,
    season_settings_id: season.id,
    inserted_rules: insertedIds.length,
    replaced_rules: replaced.length,
    teams_named: named.size,
    pending_musts: pending,
    duplicate_rule_rows: counts.duplicate,
    invalid_rows: counts.invalid,
    unknown_coach_rows: counts.unknownCoach,
    unknown_team_rows: counts.unknownTeam,
    no_team_rows: counts.noTeam,
    coach_not_on_team_rows: counts.notOnTeam,
    validation_error_rows: errors.length,
    unknown_coaches: unknownCoaches,
    unknown_teams: unknownTeams,
  };
  // What is stored on the job and in the audit log carries counts and row numbers, never an email.
  const stored = { ...result, unknown_coach_rows_listed: unknownCoaches.map((entry) => entry.row) };
  delete stored.unknown_coaches;
  Object.assign(job, {
    status: result.status,
    processed_rows: staged.filter((row) => row.applied_at).length,
    progress_percent: 100,
    completed_at: nowIso,
    error_summary: { rowErrors: errors },
    warning_summary: { ...(job.warning_summary || {}), practice_preference_finalize: stored },
  });
  audit(orgId, 'import.completed', 'import_job', jobId, stored);
  audit(orgId, 'practice_preference.imported', 'import_job', jobId, {
    inserted_ids: insertedIds,
    replaced_ids: replaced,
    teams_named: [...named].sort(),
    pending_musts: pending,
  });
  return { data: result, error: null };
}
