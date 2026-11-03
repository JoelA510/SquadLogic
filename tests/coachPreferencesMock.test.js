/**
 * Mock parity for the practice preference rule RPCs and the preference import
 * (`frontend/src/lib/mockCoachPreferences.js` vs migrations 20261112010000 and 20261116010000; the SQL's own
 * tests are `supabase/tests/practice_preference_rules.sql` and `practice_preference_import.sql`).
 *
 * Plant (b): let an RPC through for a non-admin -> the refusal cases go red.
 * Plant (c): stop replacing a team's imported rules on a re-import -> the replace case goes red.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleCoachPreferenceRpc } from '../frontend/src/lib/mockCoachPreferences.js';
import { mockSupabase } from '../frontend/src/lib/mockSupabaseClient.js';
import { seedMockDb } from './helpers/seedMockDb.js';

const ORG = 'org-p';
const OTHER_ORG = 'org-q';
const SEASON = 'season-p';
const DIVISION = 'division-p';
const COACH = '11111111-1111-4111-8111-111111111111';
const COACH_2 = '22222222-2222-4222-8222-222222222222';
const TEAM_A = 'team-a';
const TEAM_B = 'team-b';
const TEAM_C = 'team-c';
const LOC_1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const LOC_2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
const NOW = new Date('2026-09-28T12:00:00Z');
const ASSIGNED = { effective_from: '2026-08-01', effective_to: null };

function freshDb() {
  return {
    organization_members: [{ organization_id: ORG, profile_id: 'admin-user', role: 'admin' }],
    season_settings: [
      { id: SEASON, organization_id: ORG, status: 'active' },
      { id: 'season-draft', organization_id: ORG, status: 'draft' },
      { id: 'season-done', organization_id: ORG, status: 'completed' },
    ],
    divisions: [{ id: DIVISION, organization_id: ORG, season_settings_id: SEASON }],
    teams: [
      { id: TEAM_A, organization_id: ORG, division_id: DIVISION, name: 'U10 Boys 1' },
      { id: TEAM_B, organization_id: ORG, division_id: DIVISION, name: 'U10 Boys 2' },
      { id: TEAM_C, organization_id: ORG, division_id: DIVISION, name: 'U10 Girls' },
    ],
    // 'stranger' below is a signed-in account with no membership: no coach signs in
    // (docs/changes/2026-10-27-admin-only.md), and a coach row is data an admin manages.
    coaches: [
      {
        id: COACH,
        organization_id: ORG,
        season_settings_id: SEASON,
        full_name: 'C',
        email: 'c@example.test',
      },
      {
        id: COACH_2,
        organization_id: ORG,
        season_settings_id: SEASON,
        full_name: 'D',
        email: 'd@example.test',
      },
    ],
    team_coach_assignments: [
      { organization_id: ORG, team_id: TEAM_A, coach_id: COACH, role: 'lead', ...ASSIGNED },
      { organization_id: ORG, team_id: TEAM_B, coach_id: COACH, role: 'lead', ...ASSIGNED },
      { organization_id: ORG, team_id: TEAM_C, coach_id: COACH_2, role: 'lead', ...ASSIGNED },
    ],
    locations: [
      { id: LOC_1, organization_id: ORG, name: 'Mock Park' },
      { id: LOC_2, organization_id: ORG, name: 'Mock Fields, North' },
    ],
    import_jobs: [],
    staging_import_rows: [],
    coach_practice_preferences: [],
    audit_log: [],
  };
}

let seq;
const call = (db, name, params, user = 'admin-user', now = NOW) =>
  handleCoachPreferenceRpc(db, name, params, {
    currentUserId: user,
    now,
    newId: () => `id-${++seq}`,
  });
const add = (db, over = {}, user) =>
  call(
    db,
    'admin_add_practice_preference',
    { p_coach_id: COACH, p_team_id: TEAM_A, p_weekdays: ['TUE'], ...over },
    user
  );

beforeEach(() => {
  seq = 0;
});

describe('admin_add_practice_preference', () => {
  it('adds a rule for a team the coach coaches, beside any other: nothing supersedes', () => {
    const db = freshDb();
    const first = add(db, { p_weekdays: ['TUE', 'THU'], p_start_minutes: [1020, 1080] });
    const second = add(db, {
      p_weekdays: null,
      p_venue_ids: [LOC_1],
      p_level: 'must',
      p_coach_priority: 'high',
    });
    expect(first.error).toBeNull();
    expect(second.data).toMatchObject({
      level: 'must',
      requested_level: 'must',
      must_decision: 'accepted',
      source: 'admin',
    });
    expect(db.coach_practice_preferences.filter((r) => r.status === 'in_force')).toHaveLength(2);
    expect(db.audit_log.map((e) => e.action)).toEqual([
      'practice_preference.added',
      'practice_preference.added',
    ]);
  });

  it("refuses a non-admin, an unknown team and another organization's admin alike (42501)", () => {
    const db = freshDb();
    db.organization_members.push({
      organization_id: OTHER_ORG,
      profile_id: 'other-admin',
      role: 'admin',
    });
    expect(add(db, {}, 'stranger').error?.code).toBe('42501');
    expect(add(db, {}, 'other-admin').error?.code).toBe('42501');
    expect(add(db, { p_team_id: 'no-such-team' }).error?.code).toBe('42501');
    expect(db.coach_practice_preferences).toEqual([]);
  });

  it('refuses a coach who does not coach the team today (22023 coach_not_on_team)', () => {
    const db = freshDb();
    const refused = add(db, { p_team_id: TEAM_C });
    expect(refused.error).toMatchObject({ code: '22023', details: 'coach_not_on_team' });
    db.team_coach_assignments[0].effective_to = '2026-09-27';
    expect(add(db).error?.details).toBe('coach_not_on_team');
  });

  it('refuses a completed season (22023 season_completed), a bad level, and missing arguments', () => {
    const db = freshDb();
    expect(add(db, { p_level: 'sometimes' }).error?.code).toBe('22023');
    expect(call(db, 'admin_add_practice_preference', { p_team_id: TEAM_A }).error?.code).toBe(
      '23502'
    );
    db.season_settings[0].status = 'completed';
    expect(add(db).error).toMatchObject({ code: '22023', details: 'season_completed' });
  });

  it("refuses what the table's CHECKs refuse, naming the constraint (23514)", () => {
    const db = freshDb();
    const named = (over, constraint) => {
      const result = add(db, over);
      expect(result.error?.code, constraint).toBe('23514');
      expect(result.error?.message, constraint).toContain(constraint);
    };
    named({ p_weekdays: [] }, 'weekdays_valid');
    named({ p_weekdays: ['TUE', 'TUE'] }, 'weekdays_valid');
    named({ p_weekdays: ['TUESDAY'] }, 'weekdays_valid');
    named({ p_weekdays: null, p_start_minutes: [1440] }, 'start_minutes_valid');
    named({ p_weekdays: null, p_venue_ids: [LOC_1, LOC_1] }, 'venue_ids_valid');
    named({ p_weekdays: null }, 'has_condition');
    named({ p_keep_weekday: true }, 'keep_or_values');
    named({ p_coach_priority: 'urgent' }, 'priority_known');
    named({ p_effective_from: '2026-10-02', p_effective_to: '2026-10-01' }, 'window_ordered');
    // The tenancy trigger.
    const venue = add(db, {
      p_weekdays: null,
      p_venue_ids: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa9'],
    });
    expect(venue.error).toMatchObject({ code: '23514' });
    expect(venue.error.message).toContain('are not locations of organization');
    expect(db.coach_practice_preferences).toEqual([]);
  });
});

describe('edit, remove, decide and Accept all', () => {
  it('edits a rule: conditions replaced, a requested must kept as prefer or granted', () => {
    const db = freshDb();
    const rule = add(db).data;
    const edited = call(db, 'admin_edit_practice_preference', {
      p_preference_id: rule.id,
      p_level: 'prefer',
      p_weekdays: ['WED'],
      p_coach_priority: 'low',
    });
    expect(edited.data).toMatchObject({
      weekdays: ['WED'],
      coach_priority: 'low',
      must_decision: null,
    });
    const granted = call(db, 'admin_edit_practice_preference', {
      p_preference_id: rule.id,
      p_level: 'must',
      p_weekdays: ['WED'],
    });
    expect(granted.data).toMatchObject({
      level: 'must',
      requested_level: 'must',
      must_decision: 'accepted',
    });
    const demoted = call(db, 'admin_edit_practice_preference', {
      p_preference_id: rule.id,
      p_level: 'prefer',
      p_weekdays: ['WED'],
    });
    expect(demoted.data).toMatchObject({
      level: 'prefer',
      requested_level: 'must',
      must_decision: 'kept_prefer',
    });
    expect(
      call(db, 'admin_edit_practice_preference', { p_preference_id: rule.id, p_weekdays: [] }).error
        ?.code
    ).toBe('23514');
    expect(
      call(
        db,
        'admin_edit_practice_preference',
        { p_preference_id: rule.id, p_weekdays: ['MON'] },
        'stranger'
      ).error?.code
    ).toBe('42501');
  });

  // The table of `docs/sql/20261116010000_smoke.sql` (and the pgTAP file), state by level sent. The one row that
  // changed with 20261116010000 is the first two: a pending must saved at prefer, or with the level left out,
  // is not decided and nobody is stamped; every other row decides as it always did.
  const OLD_STAMP = '2026-09-01T00:00:00.000Z';
  const EDIT_CASES = [
    {
      name: 'a pending must saved at prefer stays pending and unstamped',
      row: { level: 'prefer', requested_level: 'must', must_decision: 'pending' },
      sent: 'prefer',
      want: {
        level: 'prefer',
        requested_level: 'must',
        must_decision: 'pending',
        decided_by: null,
        decided_at: null,
      },
    },
    {
      name: 'a pending must saved with the level left out (the default is prefer) stays pending and unstamped',
      row: { level: 'prefer', requested_level: 'must', must_decision: 'pending' },
      sent: undefined,
      want: {
        level: 'prefer',
        requested_level: 'must',
        must_decision: 'pending',
        decided_by: null,
        decided_at: null,
      },
    },
    {
      name: 'a pending must saved at must is accepted, explicitly, and stamped',
      row: { level: 'prefer', requested_level: 'must', must_decision: 'pending' },
      sent: 'must',
      want: {
        level: 'must',
        requested_level: 'must',
        must_decision: 'accepted',
        decided_by: 'admin-user',
        decided_at: NOW.toISOString(),
      },
    },
    {
      name: 'an accepted must saved at must stays accepted (re-stamped, as before)',
      row: {
        level: 'must',
        requested_level: 'must',
        must_decision: 'accepted',
        decided_by: 'other-admin',
        decided_at: OLD_STAMP,
      },
      sent: 'must',
      want: { level: 'must', must_decision: 'accepted', decided_by: 'admin-user' },
    },
    {
      name: 'an accepted must saved at prefer is kept as prefer and stamped',
      row: {
        level: 'must',
        requested_level: 'must',
        must_decision: 'accepted',
        decided_by: 'other-admin',
        decided_at: OLD_STAMP,
      },
      sent: 'prefer',
      want: {
        level: 'prefer',
        requested_level: 'must',
        must_decision: 'kept_prefer',
        decided_by: 'admin-user',
        decided_at: NOW.toISOString(),
      },
    },
    {
      name: 'a must kept as prefer and saved at prefer stays kept',
      row: {
        level: 'prefer',
        requested_level: 'must',
        must_decision: 'kept_prefer',
        decided_by: 'other-admin',
        decided_at: OLD_STAMP,
      },
      sent: 'prefer',
      want: { level: 'prefer', must_decision: 'kept_prefer', decided_by: 'admin-user' },
    },
    {
      name: 'a must kept as prefer and saved at must is accepted',
      row: {
        level: 'prefer',
        requested_level: 'must',
        must_decision: 'kept_prefer',
        decided_by: 'other-admin',
        decided_at: OLD_STAMP,
      },
      sent: 'must',
      want: { level: 'must', must_decision: 'accepted', decided_by: 'admin-user' },
    },
    {
      name: 'a rule nobody asked a must of has no decision at prefer',
      row: { level: 'prefer', requested_level: 'prefer', must_decision: null },
      sent: 'prefer',
      want: {
        level: 'prefer',
        requested_level: 'prefer',
        must_decision: null,
        decided_by: null,
        decided_at: null,
      },
    },
    {
      name: 'a rule nobody asked a must of is accepted when an admin saves it at must',
      row: { level: 'prefer', requested_level: 'prefer', must_decision: null },
      sent: 'must',
      want: { level: 'must', requested_level: 'must', must_decision: 'accepted' },
    },
  ];

  it.each(EDIT_CASES.map((entry) => [entry.name, entry]))('edit: %s', (_name, entry) => {
    const db = freshDb();
    db.coach_practice_preferences.push({
      id: 'p-edit',
      organization_id: ORG,
      coach_id: COACH,
      team_id: TEAM_A,
      weekdays: ['MON'],
      start_minutes: null,
      venue_ids: null,
      keep_weekday: false,
      keep_start: false,
      keep_venue: false,
      status: 'in_force',
      source: 'import',
      import_job_id: 'job-1',
      decided_by: null,
      decided_at: null,
      ...entry.row,
    });
    const result = call(db, 'admin_edit_practice_preference', {
      p_preference_id: 'p-edit',
      ...(entry.sent === undefined ? {} : { p_level: entry.sent }),
      p_weekdays: ['WED'],
    });
    expect(result.error).toBeNull();
    expect(result.data).toMatchObject({ ...entry.want, weekdays: ['WED'], status: 'in_force' });
    // What the call returned is what is stored, and the audit says what it was and what it became.
    expect(db.coach_practice_preferences[0]).toMatchObject(entry.want);
    const audit = db.audit_log.filter((item) => item.action === 'practice_preference.edited');
    expect(audit).toHaveLength(1);
    expect(audit[0].metadata.before.must_decision ?? null).toBe(entry.row.must_decision);
    expect(audit[0].metadata.after.must_decision ?? null).toBe(entry.want.must_decision);
  });

  it('the edit table reaches every outcome, so the cases above cannot all hold vacuously', () => {
    // A table that never reached "stays pending" would pass whatever the mock did with a pending must.
    const outcomes = new Set(EDIT_CASES.map((entry) => entry.want.must_decision));
    expect(outcomes).toEqual(new Set([null, 'accepted', 'kept_prefer', 'pending']));
    const pendingStays = EDIT_CASES.filter(
      (entry) => entry.row.must_decision === 'pending' && entry.want.must_decision === 'pending'
    );
    expect(pendingStays).toHaveLength(2);
    expect(new Set(EDIT_CASES.map((entry) => entry.sent))).toEqual(
      new Set(['prefer', 'must', undefined])
    );
  });

  it('removes a rule once, and refuses to edit or remove it again', () => {
    const db = freshDb();
    const rule = add(db).data;
    expect(
      call(db, 'admin_remove_practice_preference', { p_preference_id: rule.id }).data.status
    ).toBe('removed');
    expect(
      call(db, 'admin_remove_practice_preference', { p_preference_id: rule.id }).error?.details
    ).toBe('not_in_force');
    expect(
      call(db, 'admin_edit_practice_preference', { p_preference_id: rule.id, p_weekdays: ['MON'] })
        .error?.details
    ).toBe('not_in_force');
  });

  it('decides a pending must: accept makes it a must, keep_prefer keeps it as prefer, nothing else is pending', () => {
    const db = freshDb();
    const pending = (id, over = {}) => {
      const row = {
        id,
        organization_id: ORG,
        coach_id: COACH,
        team_id: TEAM_A,
        weekdays: ['TUE'],
        start_minutes: null,
        venue_ids: null,
        keep_weekday: false,
        keep_start: false,
        keep_venue: false,
        level: 'prefer',
        requested_level: 'must',
        must_decision: 'pending',
        status: 'in_force',
        source: 'import',
        import_job_id: 'job-1',
        ...over,
      };
      db.coach_practice_preferences.push(row);
      return row;
    };
    const a = pending('p-a');
    const b = pending('p-b');
    expect(
      call(db, 'admin_decide_must_preference', { p_preference_id: 'p-a', p_decision: 'accept' })
        .data
    ).toMatchObject({ level: 'must', must_decision: 'accepted' });
    expect(
      call(db, 'admin_decide_must_preference', {
        p_preference_id: 'p-b',
        p_decision: 'keep_prefer',
      }).data
    ).toMatchObject({ level: 'prefer', must_decision: 'kept_prefer', requested_level: 'must' });
    expect(
      call(db, 'admin_decide_must_preference', { p_preference_id: 'p-a', p_decision: 'accept' })
        .error?.details
    ).toBe('not_pending');
    expect(
      call(db, 'admin_decide_must_preference', { p_preference_id: 'p-b', p_decision: 'maybe' })
        .error?.code
    ).toBe('22023');
    expect(
      call(
        db,
        'admin_decide_must_preference',
        { p_preference_id: 'p-b', p_decision: 'accept' },
        'stranger'
      ).error?.code
    ).toBe('42501');
    expect([a.level, b.level]).toEqual(['must', 'prefer']);
  });

  it("Accept all refuses a count that is not the confirmation's, and accepts exactly the file's pending musts", () => {
    const db = freshDb();
    db.import_jobs.push({
      id: 'job-1',
      organization_id: ORG,
      season_settings_id: SEASON,
      job_type: 'registration',
      status: 'completed',
    });
    for (const [id, job] of [
      ['p-1', 'job-1'],
      ['p-2', 'job-1'],
      ['p-3', 'job-2'],
    ]) {
      db.coach_practice_preferences.push({
        id,
        organization_id: ORG,
        coach_id: COACH,
        team_id: TEAM_A,
        weekdays: ['TUE'],
        level: 'prefer',
        requested_level: 'must',
        must_decision: 'pending',
        status: 'in_force',
        source: 'import',
        import_job_id: job,
      });
    }
    const refused = call(db, 'admin_accept_all_musts', {
      p_import_job_id: 'job-1',
      p_expected_count: 5,
    });
    expect(refused.error).toMatchObject({ code: '22023', details: 'expected_count_mismatch' });
    expect(db.coach_practice_preferences.map((r) => r.must_decision)).toEqual([
      'pending',
      'pending',
      'pending',
    ]);
    expect(
      call(db, 'admin_accept_all_musts', { p_import_job_id: 'job-1', p_expected_count: 2 }).data
    ).toEqual({ accepted: 2, import_job_id: 'job-1' });
    expect(db.coach_practice_preferences.map((r) => [r.level, r.must_decision])).toEqual([
      ['must', 'accepted'],
      ['must', 'accepted'],
      ['prefer', 'pending'],
    ]);
    expect(
      call(db, 'admin_accept_all_musts', { p_import_job_id: 'job-1', p_expected_count: 2 }).error
        ?.details
    ).toBe('expected_count_mismatch');
    expect(
      call(
        db,
        'admin_accept_all_musts',
        { p_import_job_id: 'job-1', p_expected_count: 0 },
        'stranger'
      ).error?.code
    ).toBe('42501');
    expect(
      db.audit_log.filter((e) => e.action === 'practice_preference.musts_accepted')
    ).toHaveLength(1);
  });
});

describe('finalize_practice_preference_import_job', () => {
  const stage = (db, jobId, rows) => {
    rows.forEach((payload, i) =>
      db.staging_import_rows.push({
        organization_id: ORG,
        import_job_id: jobId,
        import_type: 'practice_preferences',
        source_row_number: i + 1,
        normalized_payload: payload,
        validation_errors: [],
      })
    );
  };
  const job = (db, id, over = {}) => {
    db.import_jobs.push({
      id,
      organization_id: ORG,
      season_settings_id: SEASON,
      job_type: 'registration',
      status: 'importing',
      ...over,
    });
    return id;
  };
  const finalize = (db, id, user) =>
    call(db, 'finalize_practice_preference_import_job', { p_import_job_id: id }, user);

  it('writes one rule per row and team: a blank team for a coach of two teams makes two, an unknown coach or team is listed', () => {
    const db = freshDb();
    const id = job(db, 'job-1');
    stage(db, id, [
      {
        email: 'c@example.test',
        request_level: 'Must',
        weekdays: 'Tuesday and Thursday',
        start_times: '5:00 PM; 6pm',
      },
      { email: 'nobody@example.test', weekdays: 'Mon' },
      { email: 'd@example.test', team_name: 'no such team', weekdays: 'Mon' },
      { email: 'd@example.test', venues: 'Mock Fields, North' },
    ]);
    const { data, error } = finalize(db, id);
    expect(error).toBeNull();
    expect(data).toMatchObject({
      status: 'completed_with_warnings',
      inserted_rules: 3,
      pending_musts: 2,
      unknown_coach_rows: 1,
      unknown_team_rows: 1,
    });
    expect(data.unknown_coaches).toEqual([{ row: 2, email: 'nobody@example.test' }]);
    const rules = db.coach_practice_preferences;
    expect(
      rules
        .filter((r) => r.coach_id === COACH)
        .map((r) => [
          r.team_id,
          r.weekdays,
          r.start_minutes,
          r.level,
          r.requested_level,
          r.must_decision,
        ])
    ).toEqual([
      [TEAM_A, ['TUE', 'THU'], [1020, 1080], 'prefer', 'must', 'pending'],
      [TEAM_B, ['TUE', 'THU'], [1020, 1080], 'prefer', 'must', 'pending'],
    ]);
    expect(rules.find((r) => r.coach_id === COACH_2)).toMatchObject({
      team_id: TEAM_C,
      venue_ids: [LOC_2],
    });
    expect(db.coaches).toHaveLength(2);
    expect(db.teams).toHaveLength(3);
    // Stored and audited without an email.
    expect(JSON.stringify(db.import_jobs[0].warning_summary)).not.toContain('@');
    expect(JSON.stringify(db.audit_log)).not.toContain('@');
    expect(db.staging_import_rows[1].validation_errors[0].message).toBe(
      'No coach with this email in the season'
    );
  });

  it('a re-import replaces the imported rules of the teams the file names and leaves admin rules and other teams alone', () => {
    const db = freshDb();
    stage(db, job(db, 'job-1'), [
      { email: 'c@example.test', weekdays: 'Mon' },
      { email: 'd@example.test', weekdays: 'Wed' },
    ]);
    finalize(db, 'job-1');
    const adminRule = add(db, { p_team_id: TEAM_A, p_weekdays: ['FRI'] }).data;
    stage(db, job(db, 'job-2'), [{ email: 'c@example.test', team: 'U10 Boys 1', weekdays: 'Tue' }]);
    const { data } = finalize(db, 'job-2');
    expect(data).toMatchObject({ replaced_rules: 1, inserted_rules: 1, status: 'completed' });
    const live = db.coach_practice_preferences
      .filter((r) => r.status === 'in_force')
      .map((r) => [r.team_id, r.weekdays, r.source]);
    expect(live).toEqual([
      [TEAM_B, ['MON'], 'import'],
      [TEAM_C, ['WED'], 'import'],
      [TEAM_A, ['FRI'], 'admin'],
      [TEAM_A, ['TUE'], 'import'],
    ]);
    expect(adminRule.status).toBe('in_force');
  });

  it("refuses a non-admin and another organization's admin (42501), a completed season (22023), a failed job, and an unknown job", () => {
    const db = freshDb();
    db.organization_members.push({
      organization_id: OTHER_ORG,
      profile_id: 'other-admin',
      role: 'admin',
    });
    const id = job(db, 'job-1');
    stage(db, id, [{ email: 'c@example.test', weekdays: 'Mon' }]);
    expect(finalize(db, id, 'stranger').error?.code).toBe('42501');
    expect(finalize(db, id, 'other-admin').error?.code).toBe('42501');
    expect(finalize(db, 'no-such-job').error?.code).toBe('P0002');
    db.import_jobs[0].status = 'failed';
    expect(finalize(db, id).error?.code).toBe('22023');
    db.import_jobs[0].status = 'importing';
    db.season_settings[0].status = 'completed';
    expect(finalize(db, id).error).toMatchObject({ code: '22023', details: 'season_completed' });
    expect(db.coach_practice_preferences).toEqual([]);
  });

  it('applies a file once: a second finalize finds its rows applied', () => {
    const db = freshDb();
    const id = job(db, 'job-1');
    stage(db, id, [{ email: 'c@example.test', team: 'U10 Boys 1', weekdays: 'Mon' }]);
    expect(finalize(db, id).data.inserted_rules).toBe(1);
    expect(finalize(db, id).data.inserted_rules).toBe(0);
    expect(db.coach_practice_preferences).toHaveLength(1);
  });
});

describe('the mock client', () => {
  it('is wired into mockSupabase.rpc: an admin adds and a stranger is refused, a preference job opens, readies and cancels, and a team deleted counts its rules', async () => {
    const db = freshDb();
    db.coach_practice_preferences.push({
      id: 'seed-rule',
      organization_id: ORG,
      coach_id: COACH,
      team_id: TEAM_A,
      weekdays: ['MON'],
      level: 'prefer',
      requested_level: 'prefer',
      status: 'in_force',
      source: 'admin',
    });
    seedMockDb(db);
    try {
      sessionStorage.setItem('__MOCK_SESSION__', JSON.stringify({ user: { id: 'stranger' } }));
      const refused = await mockSupabase.rpc('admin_add_practice_preference', {
        p_coach_id: COACH,
        p_team_id: TEAM_A,
        p_weekdays: ['TUE'],
      });
      expect(refused.error?.code).toBe('42501');
      sessionStorage.setItem('__MOCK_SESSION__', JSON.stringify({ user: { id: 'admin-user' } }));
      const added = await mockSupabase.rpc('admin_add_practice_preference', {
        p_coach_id: COACH,
        p_team_id: TEAM_A,
        p_weekdays: ['TUE'],
      });
      expect(added.error).toBeNull();
      expect(added.data.status).toBe('in_force');

      const created = await mockSupabase.rpc('create_import_job', {
        p_organization_id: ORG,
        p_import_type: 'practice_preferences',
        p_file_name: 'prefs.csv',
      });
      expect(created.error).toBeNull();
      expect(created.data.job_type).toBe('registration');
      const ready = await mockSupabase.rpc('mark_import_job_ready_to_apply', {
        p_import_job_id: created.data.id,
        p_import_type: 'practice_preferences',
      });
      expect(ready.data.status).toBe('ready_to_apply');
      const canceled = await mockSupabase.rpc('cancel_ready_import_job', {
        p_import_job_id: created.data.id,
        p_import_type: 'practice_preferences',
      });
      expect(canceled.data.status).toBe('canceled');
      const unknown = await mockSupabase.rpc('create_import_job', {
        p_organization_id: ORG,
        p_import_type: 'preferences',
        p_file_name: 'x.csv',
      });
      expect(unknown.error.message).toContain('invalid import type');
      // E3b's rule (20261111010000), mirrored for the new type: the active season or a draft, never a
      // completed one; a field file still needs the active season.
      const forSeason = (importType, seasonId) =>
        mockSupabase.rpc('create_import_job', {
          p_organization_id: ORG,
          p_import_type: importType,
          p_file_name: `${importType}.csv`,
          p_season_settings_id: seasonId,
        });
      const draftJob = await forSeason('practice_preferences', 'season-draft');
      expect(draftJob.error).toBeNull();
      expect(draftJob.data.season_settings_id).toBe('season-draft');
      const completedJob = await forSeason('practice_preferences', 'season-done');
      expect(completedJob.error.code).toBe('22023');
      expect(completedJob.error.details).toBe('season_completed');
      const draftFields = await forSeason('fields', 'season-draft');
      expect(draftFields.error.details).toBe('season_not_active');

      const deleted = await mockSupabase.rpc('admin_delete_team', { p_team_id: TEAM_A });
      expect(deleted.error).toBeNull();
      const audit = JSON.parse(sessionStorage.getItem('__MOCK_DB__')).audit_log.find(
        (entry) => entry.action === 'team.deleted' && entry.resource_id === TEAM_A
      );
      expect(audit.metadata.coach_practice_preferences_deleted).toBe(2);
    } finally {
      sessionStorage.removeItem('__MOCK_DB__');
      sessionStorage.removeItem('__MOCK_SESSION__');
    }
  });
});
