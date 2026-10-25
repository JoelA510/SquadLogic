// The mock client's twin of migration 20261029010000 (plan
// docs/changes/2026-10-22-demo-mode.md, D2): the fields CSV's Division
// reserves a practice slot within the season and an unknown one fails its row;
// a practice slot that overlaps another on the same ground, or starts less than
// 15 minutes from it, fails its row, while the other half of the field and a
// slot 15 minutes later do not; the reservation writer and the division
// settings writer's plays_games follow the SQL's refusals and no-ops.
import { beforeEach, describe, expect, it } from 'vitest';
import { getMockData, mockSupabase as supabase } from '../frontend/src/lib/mockSupabaseClient.js';
import { MOCK_ORG_ID, MOCK_SEASON_ID } from '../frontend/src/lib/mockSeedIds.js';

const setSession = (userId) => {
  sessionStorage.setItem('__MOCK_SESSION__', JSON.stringify({ user: { id: userId } }));
};

const row = (overrides) => ({
  Location: 'D2 Park',
  Field: 'Pitch 1',
  Type: 'practice',
  Day: 'Sat',
  Capacity: '1',
  'Valid From': '2026-09-05',
  'Valid Until': '2026-11-28',
  ...overrides,
});

/** Stage `rows` through the mock's import-validation and apply them. */
async function importFields(jobId, rows) {
  await supabase
    .from('import_jobs')
    .insert({
      id: jobId,
      created_by: 'mock-admin-id',
      organization_id: MOCK_ORG_ID,
      job_type: 'fields',
      storage_path: `imports/mock-admin-id/${jobId}.csv`,
      status: 'importing',
      total_rows: rows.length,
      processed_rows: 0,
      progress_percent: 0,
    })
    .select();
  const { error: validationError } = await supabase.functions.invoke('import-validation', {
    body: {
      import_type: 'fields',
      organization_id: MOCK_ORG_ID,
      rows,
      import_job_id: jobId,
      row_offset: 0,
    },
  });
  expect(validationError).toBeNull();
  const { data, error } = await supabase.rpc('finalize_field_import_job', {
    p_import_job_id: jobId,
    p_validation_errors: [],
  });
  expect(error).toBeNull();
  const staged = getMockData('staging_import_rows', 'import_job_id', jobId).sort(
    (a, b) => a.source_row_number - b.source_row_number
  );
  return {
    result: data,
    outcomes: staged.map(
      (r) => r.validation_errors?.[0]?.reason ?? (r.applied_at ? 'applied' : '?')
    ),
  };
}

beforeEach(() => {
  sessionStorage.clear();
  window.__MOCK_DB__ = undefined;
  setSession('mock-admin-id');
});

describe('mock finalize_field_import_job :: reservations and clashes (D2)', () => {
  it('reserves a slot to its Division, fails an unknown one and every clash, and writes nothing for them', async () => {
    const { result, outcomes } = await importFields('d2-mock-job', [
      // 1: reserved to the seed's U8 Coed (any case), half A.
      row({ Subunit: 'A', Start: '09:00', End: '09:30', Division: 'u8 coed' }),
      // 2: overlaps 1.
      row({ Subunit: 'A', Start: '09:15', End: '09:45' }),
      // 3: starts 10 minutes after 1 ends.
      row({ Subunit: 'A', Start: '09:40', End: '10:10' }),
      // 4: starts 15 minutes after 1 ends.
      row({ Subunit: 'A', Start: '09:45', End: '10:15' }),
      // 5: the other half, at 1's time.
      row({ Subunit: 'B', Start: '09:00', End: '09:30' }),
      // 6: an unknown division, on ground that does not exist yet.
      row({ Location: 'D2 Nowhere', Start: '09:00', End: '09:30', Division: 'U99' }),
      // 7: the whole field, at 1's time.
      row({ Start: '09:00', End: '09:30' }),
    ]);
    expect(outcomes).toEqual([
      'applied',
      'practice_slot_conflict',
      'practice_slot_conflict',
      'applied',
      'applied',
      'division_unknown',
      'practice_slot_conflict',
    ]);
    expect(result.invalid_rows).toBe(4);
    expect(result.inserted_practice_slots).toBe(3);
    const reserved = getMockData('practice_slots').find(
      (s) => s.start_time === '09:00' && s.division_id === 'u8-div-id'
    );
    expect(reserved).toBeTruthy();
    expect(getMockData('locations').some((l) => l.name === 'D2 Nowhere')).toBe(false);
  });

  it('names a division only within the season the import attaches to', async () => {
    const { outcomes } = await importFields('d2-mock-season', [
      row({ Start: '17:00', End: '18:00', Division: 'U10 Girls' }),
    ]);
    expect(outcomes).toEqual(['applied']);
    // A division of another season, though it shares the organization.
    await supabase.from('season_settings').insert({
      id: 'd2-old-season',
      organization_id: MOCK_ORG_ID,
      name: 'Last Year',
      status: 'completed',
      season_start: '2024-01-01',
    });
    await supabase.from('divisions').insert({
      id: 'd2-old-div',
      organization_id: MOCK_ORG_ID,
      season_settings_id: 'd2-old-season',
      name: 'Old U6',
    });
    const second = await importFields('d2-mock-season-2', [
      row({ Start: '19:00', End: '20:00', Division: 'Old U6' }),
    ]);
    expect(second.outcomes).toEqual(['division_unknown']);
  });
});

describe('mock finalize_field_import_job :: a re-import updates its slot (D2)', () => {
  it('keeps the reservation without a Division, moves it with one, and its rollback puts it back', async () => {
    const reserved = row({ Subunit: 'A', Start: '09:00', End: '09:30', Division: 'U8 Coed' });
    await importFields('d2-mock-first', [reserved]);
    const slotOf = () =>
      getMockData('practice_slots').filter(
        (s) => s.start_time === '09:00' && s.valid_from === '2026-09-05'
      );
    expect(slotOf()).toHaveLength(1);

    const keep = await importFields('d2-mock-keep', [
      row({ Subunit: 'A', Start: '09:00', End: '09:30', 'Valid Until': '2026-11-21' }),
    ]);
    expect(keep.outcomes).toEqual(['applied']);
    expect(keep.result.updated_practice_slots).toBe(1);
    expect(slotOf()).toHaveLength(1);
    expect(slotOf()[0]).toMatchObject({ division_id: 'u8-div-id', valid_until: '2026-11-21' });

    const move = await importFields('d2-mock-move', [
      row({ Subunit: 'A', Start: '09:00', End: '09:30', Division: 'U10 Girls' }),
    ]);
    expect(move.outcomes).toEqual(['applied']);
    expect(slotOf()[0].division_id).toBe('u10-div-id');
    const { error } = await supabase.rpc('rollback_field_import_job', {
      p_import_job_id: 'd2-mock-move',
    });
    expect(error).toBeNull();
    expect(slotOf()[0].division_id).toBe('u8-div-id');
  });
});

describe('mock admin_set_practice_slot_division (D2)', () => {
  const slotId = () => getMockData('practice_slots')[0].id;

  it('sets and clears a reservation, and a repeat changes nothing', async () => {
    const first = await supabase.rpc('admin_set_practice_slot_division', {
      p_slot_id: slotId(),
      p_division_id: 'u10-div-id',
    });
    expect(first.error).toBeNull();
    expect(first.data).toMatchObject({ division_id: 'u10-div-id', changed: true });
    const repeat = await supabase.rpc('admin_set_practice_slot_division', {
      p_slot_id: slotId(),
      p_division_id: 'u10-div-id',
    });
    expect(repeat.data.changed).toBe(false);
    expect(getMockData('practice_slots')[0].division_id).toBe('u10-div-id');
    const cleared = await supabase.rpc('admin_set_practice_slot_division', {
      p_slot_id: slotId(),
      p_division_id: null,
    });
    expect(cleared.data).toMatchObject({ division_id: null, changed: true });
  });

  it('refuses a division of another organization (22023), a coach and a missing slot (42501)', async () => {
    await supabase.from('divisions').insert({
      id: 'd2-elsewhere',
      organization_id: '5eed0000-0000-4000-8000-0000000000ff',
      season_settings_id: 'elsewhere',
      name: 'Elsewhere',
    });
    const foreign = await supabase.rpc('admin_set_practice_slot_division', {
      p_slot_id: slotId(),
      p_division_id: 'd2-elsewhere',
    });
    expect(foreign.error?.code).toBe('22023');
    const missing = await supabase.rpc('admin_set_practice_slot_division', {
      p_slot_id: 'no-such-slot',
      p_division_id: null,
    });
    expect(missing.error?.code).toBe('42501');
    setSession('mock-coach-id');
    const coach = await supabase.rpc('admin_set_practice_slot_division', {
      p_slot_id: slotId(),
      p_division_id: null,
    });
    expect(coach.error?.code).toBe('42501');
  });
});

describe('mock admin_upsert_division_settings :: plays_games (D2)', () => {
  const save = (extra) =>
    supabase.rpc('admin_upsert_division_settings', {
      p_organization_id: MOCK_ORG_ID,
      p_season_settings_id: MOCK_SEASON_ID,
      p_division_id: null,
      p_name: 'U4',
      p_max_roster_size: 15,
      ...extra,
    });

  it('stores false, keeps it on a save without it, and plays a new division by default', async () => {
    const created = await save({ p_plays_games: false });
    expect(created.data).toMatchObject({ plays_games: false, changed: true });
    const kept = await save({});
    expect(kept.data).toMatchObject({ plays_games: false, changed: false });
    const fresh = await save({ p_name: 'U5' });
    expect(fresh.data.plays_games).toBe(true);
    expect(getMockData('divisions').find((d) => d.name === 'U4').plays_games).toBe(false);
  });
});
