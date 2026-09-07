import { beforeEach, describe, expect, it } from 'vitest';
import { mockSupabase as supabase, getMockData } from '../frontend/src/lib/mockSupabaseClient.js';
import { finalizeDeferredImportJob } from '../frontend/src/utils/importDeferredActions.js';

/**
 * Seed the locations and fields an availability row names, so it can resolve.
 *
 * Before 20260908000000 no test in this file seeded any facility row, and none
 * needed to: the finalize path attached `field_id: null` to every profile it
 * created and reported success, so a fifteen-row pack imported into an
 * organisation with no fields at all produced fifteen profiles and four
 * blackout windows that no field-scoped query could attribute to ground. The
 * counts these tests assert were real; what they certified was not.
 *
 * Seeding is derived from the rows under test on purpose -- it is FIXTURE
 * construction, not an expected set. What each test asserts afterwards is
 * enumerated from the mock tables, which is where a break would show.
 */
async function seedFacilityFor(rows, organizationId = 'org-1') {
  const locations = new Map();
  const fields = [];
  rows.forEach((row, index) => {
    const locationName = row.location;
    const fieldName = row.field_name || row.name;
    if (!locationName || !fieldName) return;
    const key = locationName.toLowerCase();
    if (!locations.has(key)) {
      locations.set(key, { id: `seed-loc-${locations.size + 1}`, name: locationName });
    }
    fields.push({
      id: `seed-field-${index + 1}`,
      organization_id: organizationId,
      location_id: locations.get(key).id,
      name: fieldName,
      active: true,
      created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    });
  });
  await supabase.from('locations').insert(
    [...locations.values()].map((loc) => ({
      id: loc.id,
      organization_id: organizationId,
      name: loc.name,
    }))
  );
  await supabase.from('fields').insert(fields);
}

describe('field availability lifecycle', () => {
  beforeEach(() => {
    sessionStorage.clear();
    window.__MOCK_DB__ = undefined;
  });

  it('create_import_job sets field_availability job_type', async () => {
    const { data, error } = await supabase.rpc('create_import_job', {
      p_organization_id: 'org-1',
      p_import_type: 'field_availability',
      p_file_name: 'fa.csv',
    });
    expect(error).toBeNull();
    expect(data.job_type).toBe('field_availability');
  });

  it('invalid seasonal rows produce warnings and do not create slots', async () => {
    const basePractice = getMockData('practice_slots').length;
    const baseGame = getMockData('game_slots').length;
    const { data: job } = await supabase.rpc('create_import_job', {
      p_organization_id: 'org-1',
      p_import_type: 'field_availability',
      p_file_name: 'invalid-fa.csv',
    });
    await supabase.from('staging_import_rows').insert({
      id: 'row-invalid',
      import_job_id: job.id,
      organization_id: 'org-1',
      import_type: 'field_availability',
      raw_payload: {},
      normalized_payload: {
        season_label: 'Fall 2026',
        location: '',
        field_name: 'Bad',
        available_from: '2026-11-30',
        available_until: '2026-08-01',
        teams_per_hour: '0',
      },
      validation_errors: [],
    });
    const res = await supabase.rpc('finalize_field_availability_import_job', {
      p_import_job_id: job.id,
      p_validation_errors: [],
    });
    expect(res.error).toBeNull();
    expect(res.data.status).toBe('completed_with_warnings');
    expect(res.data.invalid_rows).toBeGreaterThan(0);
    expect(getMockData('practice_slots').length).toBe(basePractice);
    expect(getMockData('game_slots').length).toBe(baseGame);
  });

  it('deferred apply routes to finalize_field_availability_import_job and rollback rpc works', async () => {
    const { data: job } = await supabase.rpc('create_import_job', {
      p_organization_id: 'org-1',
      p_import_type: 'field_availability',
      p_file_name: 'fa.csv',
    });
    await seedFacilityFor([{ location: 'San Lorenzo', field_name: 'Main' }]);
    await supabase.from('staging_import_rows').insert({
      id: 'row1',
      import_job_id: job.id,
      organization_id: 'org-1',
      import_type: 'field_availability',
      raw_payload: {},
      normalized_payload: {
        season_label: 'Fall 2026',
        location: 'San Lorenzo',
        field_name: 'Main',
        available_from: '2026-08-01',
        available_until: '2026-10-31',
        primary_format: '11v11',
        secondary_format: '9v9',
        format_quantity: '1',
        blackout_months: 'Sept',
        goal_equipment: 'sturdy goals',
        goal_status: 'needs purchase',
        scenario_name: 'Canyon A',
        scenario_group: 'canyon',
      },
      validation_errors: [],
    });
    await supabase.rpc('mark_import_job_ready_to_apply', {
      p_import_job_id: job.id,
      p_import_type: 'field_availability',
      p_validation_errors: [],
    });
    const result = await finalizeDeferredImportJob({
      supabase,
      type: 'field_availability',
      importJobId: job.id,
      validationErrors: [],
    });
    expect(result.inserted_profiles).toBe(1);

    const profile = getMockData('field_availability_profiles')[0];
    expect(profile).toBeTruthy();
    expect(
      getMockData('field_blackout_windows').some(
        (b) => b.profile_id === profile.id && b.blackout_from === '2026-09-01'
      )
    ).toBe(true);

    const rb = await supabase.rpc('rollback_field_availability_import_job', {
      p_import_job_id: job.id,
    });
    expect(rb.error).toBeNull();
    expect(getMockData('field_availability_profiles').length).toBe(0);
    expect(getMockData('field_availability_profile_formats').length).toBe(0);
    expect(getMockData('field_blackout_windows').length).toBe(0);
    expect(getMockData('field_equipment_requirements').length).toBe(0);
    expect(getMockData('field_availability_scenario_members').length).toBe(0);
  });

  it('deferred cancel works for field_availability', async () => {
    const { data: job } = await supabase.rpc('create_import_job', {
      p_organization_id: 'org-1',
      p_import_type: 'field_availability',
      p_file_name: 'cancel-fa.csv',
    });
    await supabase.from('staging_import_rows').insert({
      id: 'row-cancel',
      import_job_id: job.id,
      organization_id: 'org-1',
      import_type: 'field_availability',
      raw_payload: {},
      normalized_payload: {
        season_label: 'Fall 2026',
        location: 'Five Canyons',
        field_name: 'Upper',
        available_from: '2026-09-01',
        available_until: '2026-11-30',
      },
      validation_errors: [],
    });
    const ready = await supabase.rpc('mark_import_job_ready_to_apply', {
      p_import_job_id: job.id,
      p_import_type: 'field_availability',
      p_validation_errors: [],
    });
    expect(ready.error).toBeNull();
    const canceled = await supabase.rpc('cancel_ready_import_job', {
      p_import_job_id: job.id,
      p_import_type: 'field_availability',
    });
    expect(canceled.error).toBeNull();
    expect(canceled.data.status).toBe('canceled');
  });

  it('blackout month parsing supports Aug/Sep/Oct/Nov tokens', async () => {
    const { data: job } = await supabase.rpc('create_import_job', {
      p_organization_id: 'org-1',
      p_import_type: 'field_availability',
      p_file_name: 'months.csv',
    });
    await seedFacilityFor([{ location: 'San Lorenzo', field_name: 'Main' }]);
    await supabase.from('staging_import_rows').insert({
      id: 'row-months',
      import_job_id: job.id,
      organization_id: 'org-1',
      import_type: 'field_availability',
      raw_payload: {},
      normalized_payload: {
        season_label: 'Fall 2026',
        location: 'San Lorenzo',
        field_name: 'Main',
        available_from: '2026-08-01',
        available_until: '2026-11-30',
        blackout_months: 'Aug, Sept, Oct, Nov',
      },
      validation_errors: [],
    });
    await supabase.rpc('finalize_field_availability_import_job', {
      p_import_job_id: job.id,
      p_validation_errors: [],
    });
    const wins = getMockData('field_blackout_windows').map((w) => [
      w.blackout_from,
      w.blackout_until,
    ]);
    expect(wins).toContainEqual(['2026-08-01', '2026-08-31']);
    expect(wins).toContainEqual(['2026-09-01', '2026-09-30']);
    expect(wins).toContainEqual(['2026-10-01', '2026-10-31']);
    expect(wins).toContainEqual(['2026-11-01', '2026-11-30']);
  });

  it('Fall 2026 fixture regression pack preserves counts and edge-cases', async () => {
    const rows = [
      {
        location: 'Stanton Elementary',
        field_name: 'Main',
        available_from: '2026-08-01',
        available_until: '2026-11-30',
        primary_format: '7v7',
        secondary_format: '9v9',
        teams_per_hour: '2',
        goal_equipment: 'sturdy goals',
        goal_status: 'needs sturdy goals',
        restroom_potty: 'true',
      },
      {
        location: 'Jensen Ranch',
        field_name: 'Main',
        available_from: '2026-08-01',
        available_until: '2026-11-30',
        primary_format: '7v7',
        secondary_format: '9v9',
        teams_per_hour: '2',
        goal_equipment: 'sturdy goals',
        goal_status: 'not approved',
        restroom_potty: 'true',
      },
      {
        location: 'Vannoy Back Field 7',
        field_name: 'Field 7',
        available_from: '2026-08-01',
        available_until: '2026-11-30',
        primary_format: '5v5',
        teams_per_hour: '4',
        use_context: 'Academy',
        goal_equipment: 'PUGG / Bownets / Forza',
        goal_status: 'available',
      },
      {
        location: 'Vannoy Front Field 1',
        field_name: 'Field 1',
        available_from: '2026-08-01',
        available_until: '2026-11-30',
        primary_format: '7v7',
        teams_per_hour: '1',
        goal_equipment: 'sturdy goals',
        goal_status: 'needs sturdy goals',
        restroom_potty: 'true',
      },
      {
        location: 'Independent Field 6',
        field_name: 'Field 6',
        available_from: '2026-08-01',
        available_until: '2026-11-30',
        primary_format: '4v4',
        teams_per_hour: '2',
        use_context: 'Boys & Girls',
        day_constraints: 'Sat/Sun',
        move_to_location: 'Vannoy',
        goal_equipment: 'PUGG or sturdy goals',
        goal_status: 'recommended',
      },
      {
        location: 'Five Canyons Upper',
        field_name: 'Upper',
        available_from: '2026-09-01',
        available_until: '2026-11-30',
        primary_format: '9v9',
        secondary_format: '7v7',
        teams_per_hour: '2',
        blackout_months: 'Aug',
      },
      {
        location: 'Five Canyons Lower',
        field_name: 'Lower',
        available_from: '2026-09-01',
        available_until: '2026-11-30',
        primary_format: '9v9',
        secondary_format: '7v7',
        teams_per_hour: '2',
        blackout_months: 'Aug',
      },
      {
        location: 'Bret Harte',
        field_name: 'Main',
        available_from: '2026-09-01',
        available_until: '2026-11-30',
        primary_format: '11v11',
        teams_per_hour: '2',
        blackout_months: 'Aug',
        goal_status: 'available',
      },
      {
        location: 'San Lorenzo',
        field_name: 'Main',
        available_from: '2026-08-01',
        available_until: '2026-10-31',
        primary_format: '11v11',
        teams_per_hour: '2',
        blackout_months: 'Sep',
      },
      {
        location: 'Creekside',
        field_name: 'Field 1',
        available_from: '2026-08-01',
        available_until: '2026-11-30',
        record_status: 'excluded',
      },
      {
        location: 'Proctor',
        field_name: 'Field 1',
        available_from: '2026-08-01',
        available_until: '2026-11-30',
        record_status: 'excluded',
      },
      {
        location: 'Canyon',
        field_name: 'Turf 11v11 Pods',
        available_from: '2026-08-01',
        available_until: '2026-11-30',
        primary_format: '11v11',
        format_quantity: '4',
        aggregate_teams_per_hour: '8',
        record_status: 'potential',
        approval_status: 'pending',
        scenario_name: 'Canyon Potential',
        scenario_group: 'canyon',
        goal_status: 'available',
      },
      {
        location: 'Canyon',
        field_name: 'Turf 9v9 Pods',
        available_from: '2026-08-01',
        available_until: '2026-11-30',
        primary_format: '9v9',
        format_quantity: '4',
        aggregate_teams_per_hour: '8',
        record_status: 'potential',
        approval_status: 'pending',
        scenario_name: 'Canyon Potential',
        scenario_group: 'canyon',
        goal_equipment: 'sturdy 9v9 goals with wheels/locks',
        goal_status: 'required',
      },
      {
        location: 'Canyon',
        field_name: 'Turf Mixed Combination',
        available_from: '2026-08-01',
        available_until: '2026-11-30',
        primary_format: '11v11',
        secondary_format: '9v9',
        format_quantity: '4',
        aggregate_teams_per_hour: '8',
        record_status: 'potential',
        approval_status: 'pending',
        scenario_name: 'Canyon Potential',
        scenario_group: 'canyon',
        goal_equipment: 'sturdy 9v9 goals with wheels/locks',
        goal_status: 'required',
      },
      {
        location: 'Canyon',
        field_name: 'Grass 11v11',
        available_from: '2026-08-01',
        available_until: '2026-11-30',
        primary_format: '11v11',
        format_quantity: '1',
        teams_per_hour: '2',
        record_status: 'potential',
        approval_status: 'pending',
        scenario_name: 'Canyon Potential',
        scenario_group: 'canyon',
        goal_status: 'available',
      },
    ];
    const basePractice = getMockData('practice_slots').length;
    const baseGame = getMockData('game_slots').length;
    await seedFacilityFor(rows);
    const { data: job } = await supabase.rpc('create_import_job', {
      p_organization_id: 'org-1',
      p_import_type: 'field_availability',
      p_file_name: 'fall-2026-pack.csv',
    });
    await supabase.from('staging_import_rows').insert(
      rows.map((row, idx) => ({
        id: `fall26-${idx + 1}`,
        import_job_id: job.id,
        organization_id: 'org-1',
        import_type: 'field_availability',
        raw_payload: {},
        normalized_payload: { season_label: 'Fall 2026', ...row },
        validation_errors: [],
      }))
    );
    const finalize = await supabase.rpc('finalize_field_availability_import_job', {
      p_import_job_id: job.id,
      p_validation_errors: [],
    });
    expect(finalize.error).toBeNull();
    expect(finalize.data.invalid_rows).toBe(0);
    expect(getMockData('field_availability_profiles').length).toBe(15);
    expect(getMockData('field_blackout_windows').length).toBe(4);
    expect(getMockData('field_equipment_requirements').length).toBe(10);
    expect(getMockData('practice_slots').length).toBe(basePractice);
    expect(getMockData('game_slots').length).toBe(baseGame);
    expect(
      getMockData('field_blackout_windows').some(
        (b) => b.blackout_from === '2026-09-01' && b.blackout_until === '2026-09-30'
      )
    ).toBe(true);
    expect(
      getMockData('field_availability_profiles').filter(
        (p) =>
          ['Five Canyons Upper', 'Five Canyons Lower', 'Bret Harte'].includes(p.location) &&
          p.available_from === '2026-09-01'
      ).length
    ).toBe(3);
    expect(
      getMockData('field_availability_profiles').filter(
        (p) => ['Creekside', 'Proctor'].includes(p.location) && p.record_status === 'active'
      ).length
    ).toBe(0);
    expect(
      getMockData('field_availability_profiles').filter(
        (p) =>
          p.location === 'Canyon' &&
          p.record_status === 'potential' &&
          p.approval_status === 'pending'
      ).length
    ).toBe(4);
    expect(getMockData('field_availability_scenario_members').length).toBe(4);
    // Every profile the pack produced points at a field. Enumerated from the
    // table rather than from `rows`, because a row silently dropped by the
    // resolution would be absent from the table and a check driven by `rows`
    // would report on a profile that is not there.
    const packProfiles = getMockData('field_availability_profiles');
    expect(packProfiles.length).toBeGreaterThan(0);
    expect(packProfiles.filter((p) => !p.field_id)).toEqual([]);
    // And the blackouts hang off resolved profiles, so field_closures can say
    // which ground each one shuts.
    const closures = getMockData('field_closures').filter(
      (c) => c.source === 'field_blackout_windows'
    );
    expect(closures.length).toBe(4);
    expect(closures.filter((c) => !c.closes_field_id)).toEqual([]);
  });

  it('refuses an availability row that matches no field, with a reason, and replays it later', async () => {
    const { data: job } = await supabase.rpc('create_import_job', {
      p_organization_id: 'org-1',
      p_import_type: 'field_availability',
      p_file_name: 'unresolvable.csv',
    });
    await seedFacilityFor([{ location: 'Alder Park', field_name: 'Main' }]);
    // A decoy in another organisation carrying the exact location and field
    // name the unresolvable row asks for. A resolution that forgot its tenant
    // filter finds this and attaches org-1's closure to org-2's ground.
    await supabase
      .from('locations')
      .insert({ id: 'decoy-loc', organization_id: 'org-2', name: 'Alder Park' });
    await supabase.from('fields').insert({
      id: 'decoy-field',
      organization_id: 'org-2',
      location_id: 'decoy-loc',
      name: 'Ghost Pitch',
      active: true,
      created_at: new Date(Date.UTC(2025, 0, 1)).toISOString(),
    });
    const staged = (id, location, fieldName, sourceRow) => ({
      id,
      import_job_id: job.id,
      organization_id: 'org-1',
      import_type: 'field_availability',
      source_row_number: sourceRow,
      raw_payload: {},
      normalized_payload: {
        season_label: 'Fall 2026',
        location,
        field_name: fieldName,
        available_from: '2026-08-01',
        available_until: '2026-11-30',
        blackout_months: 'Aug',
      },
      validation_errors: [],
    });
    // The unresolvable row is staged AFTER a resolvable one, so a `field_id`
    // carried over from the previous iteration would show up as a profile
    // attached to the wrong ground rather than as no profile at all.
    await supabase
      .from('staging_import_rows')
      .insert([
        staged('resolvable-row', 'Alder Park', 'Main', 1),
        staged('unresolvable-row', 'Alder Park', 'Ghost Pitch', 2),
      ]);

    const res = await supabase.rpc('finalize_field_availability_import_job', {
      p_import_job_id: job.id,
      p_validation_errors: [],
    });
    expect(res.error).toBeNull();
    expect(res.data.inserted_profiles).toBe(1);
    expect(res.data.unresolved_field_rows).toBe(1);
    expect(res.data.invalid_rows).toBe(1);
    expect(res.data.status).toBe('completed_with_warnings');
    expect(res.data.inserted_blackouts).toBe(1);

    // Nothing field-less was created, and nothing was created for the refused
    // row at all.
    const profiles = getMockData('field_availability_profiles');
    expect(profiles.length).toBe(1);
    expect(profiles.filter((p) => !p.field_id)).toEqual([]);
    expect(profiles.filter((p) => p.field_name === 'Ghost Pitch')).toEqual([]);

    // The refusal is reported with a reason a caller can branch on, on the
    // staging row and in the job's warning summary.
    const refused = getMockData('staging_import_rows').find(
      (r) => String(r.id) === 'unresolvable-row'
    );
    expect(refused.applied_at ?? null).toBeNull();
    const reasons = (refused.validation_errors || []).map((e) => e.reason);
    expect(reasons).toContain('field_unresolved');
    const detail = (refused.validation_errors || []).find(
      (e) => e.reason === 'field_unresolved'
    );
    expect(detail.location).toBe('Alder Park');
    expect(detail.field_name).toBe('Ghost Pitch');
    const finishedJob = getMockData('import_jobs').find((j) => String(j.id) === String(job.id));
    expect(finishedJob.warning_summary.availability_finalize.unresolved_field_rows).toBe(1);

    // **Refused means deferred, not discarded.** Create the field it asked for
    // and re-run the same job: the row applies, and the row that already
    // applied is not applied twice.
    await supabase.from('fields').insert({
      id: 'seed-field-ghost',
      organization_id: 'org-1',
      location_id: 'seed-loc-1',
      name: 'Ghost Pitch',
      active: true,
      created_at: new Date(Date.UTC(2026, 0, 2)).toISOString(),
    });
    const replay = await supabase.rpc('finalize_field_availability_import_job', {
      p_import_job_id: job.id,
      p_validation_errors: [],
    });
    expect(replay.error).toBeNull();
    expect(replay.data.inserted_profiles).toBe(1);
    expect(replay.data.unresolved_field_rows).toBe(0);
    const after = getMockData('field_availability_profiles');
    expect(after.length).toBe(2);
    expect(after.filter((p) => !p.field_id)).toEqual([]);
    expect(after.find((p) => p.field_name === 'Ghost Pitch').field_id).toBe('seed-field-ghost');
  });
});
