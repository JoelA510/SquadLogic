/**
 * **The import rollback's booking guard, against the mock client.**
 *
 * LIVE-3: `rollback_field_import_job` is the third path in this repository
 * that deletes a field, and it guarded that delete with `practice_slots` and
 * `game_slots` -- two of the six kinds `public.field_bookings` enumerates.
 * `tests/fieldImportApplyRollback.test.js` covers the happy path; this file
 * covers what happens when the ground is not free.
 *
 * **The mock arm had no guard at all.** It deleted every inserted row
 * unconditionally and returned a hard-coded `blocked_records: 0`, so it was
 * not a second implementation drifting from the first -- it was a placeholder
 * that agreed with a broken result, which is the shape LIVE-2 found in the
 * availability import. A parity mechanism assumes both arms exist.
 *
 * **Every booking a REFUSAL case seeds is one the old FIELDS guard could not
 * see**: a free-standing assignment (a `field_id` and no slot) and an
 * availability profile. Seeding a slot instead would pass against the pre-fix
 * body too and prove nothing. The later cases are about other arms -- the
 * `game_slots` arm's missing `slot_id`, the tombstone, the `updated` restore --
 * and each says which defect it is aimed at.
 *
 * **Not covered here, and recorded rather than implied:** the mock arm has no
 * `is_org_admin` gate where the SQL raises 42501. That is pre-existing and
 * untouched -- `tests/fieldImportApplyRollback.test.js` calls this RPC with no
 * mock session at all -- so the org gate is pinned on the SQL side only, by
 * `supabase/tests/field_import_rollback_booking_guard.sql`.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { getMockData, mockSupabase as supabase } from '../frontend/src/lib/mockSupabaseClient.js';

const ORG = 'org-1';
const JOB = 'rollback-guard-job';

const setMockSession = (userId) => {
  sessionStorage.setItem('__MOCK_SESSION__', JSON.stringify({ user: { id: userId } }));
};

/**
 * Two fields recorded as inserted by one field-import job.
 *
 * `booked` carries whatever the caller asks for; `free` carries nothing and
 * must still roll back, so a guard that refused everything fails here rather
 * than looking careful.
 *
 * @param {Array<{ table: string, row: Record<string, any> }>} bookings
 */
const seedJob = async (bookings) => {
  await supabase
    .from('locations')
    .insert([{ id: 'rg-location', organization_id: ORG, name: 'Rollback Park' }]);
  await supabase.from('fields').insert([
    {
      id: 'rg-booked',
      organization_id: ORG,
      location_id: 'rg-location',
      name: 'Imported Booked Pitch',
      active: true,
    },
    {
      id: 'rg-free',
      organization_id: ORG,
      location_id: 'rg-location',
      name: 'Imported Free Pitch',
      active: true,
    },
  ]);
  for (const { table, row } of bookings) {
    await supabase.from(table).insert([row]);
  }
  await supabase.from('import_jobs').insert([
    {
      id: JOB,
      organization_id: ORG,
      created_by: 'mock-admin-id',
      job_type: 'fields',
      storage_path: 'imports/mock-admin-id/fields.csv',
      status: 'completed',
      total_rows: 2,
    },
  ]);
  await supabase.from('import_application_records').insert([
    {
      id: 'rg-record-booked',
      organization_id: ORG,
      import_job_id: JOB,
      import_type: 'fields',
      target_table: 'fields',
      target_id: 'rg-booked',
      operation: 'inserted',
    },
    {
      id: 'rg-record-free',
      organization_id: ORG,
      import_job_id: JOB,
      import_type: 'fields',
      target_table: 'fields',
      target_id: 'rg-free',
      operation: 'inserted',
    },
  ]);

  // Every seed landed. A seed that silently failed would turn a refusal case
  // into an unbooked one, and it would pass for entirely the wrong reason.
  for (const [table, id] of [
    ['fields', 'rg-booked'],
    ['fields', 'rg-free'],
    ['import_application_records', 'rg-record-booked'],
    ['import_application_records', 'rg-record-free'],
    ...bookings.map(({ table, row }) => [table, row.id]),
  ]) {
    expect(
      getMockData(table).find((r) => String(r.id) === String(id)),
      `${id} did not land in ${table}`
    ).toBeDefined();
  }
};

const FREE_STANDING_PRACTICE = {
  table: 'practice_assignments',
  row: {
    id: 'rg-practice-assignment',
    organization_id: ORG,
    team_id: 'rg-team',
    field_id: 'rg-booked',
    effective_date_range: '[2099-01-01,2099-12-31]',
  },
};

const AVAILABILITY_PROFILE = {
  table: 'field_availability_profiles',
  row: {
    id: 'rg-profile',
    organization_id: ORG,
    field_id: 'rg-booked',
    season_label: '2099',
    location: 'Rollback Park',
    field_name: 'Imported Booked Pitch',
    available_from: '2099-01-01',
    available_until: '2099-12-31',
  },
};

describe('field import rollback :: the booking guard the mock never had', () => {
  beforeEach(() => {
    sessionStorage.clear();
    delete window.__MOCK_DB__;
    setMockSession('mock-admin-id');
  });

  it.each([
    // The two kinds the pre-LIVE-3 guard was blind to, one case each rather
    // than pooled, so an arm that stopped being enumerated fails for ITS kind
    // instead of being absorbed by the other. The third column is the kind the
    // SHARED producer must call it, and it is asserted rather than decorative.
    ['a free-standing practice assignment', FREE_STANDING_PRACTICE, 'practice_assignment'],
    ['an availability profile', AVAILABILITY_PROFILE, 'availability_profile'],
  ])('refuses the field held by %s, and says which and why', async (_label, booking, kind) => {
    await seedJob([booking]);

    const { data, error } = await supabase.rpc('rollback_field_import_job', {
      p_import_job_id: JOB,
    });
    expect(error).toBeNull();

    expect(data.blocked_records).toBe(1);
    expect(data.status).toBe('completed_with_warnings');
    // The unbooked field still rolls back: the guard refuses a FIELD, not the
    // job, so a version that gave up on the first refusal fails here.
    expect(data.deleted_fields).toBe(1);

    expect(data.blocked).toHaveLength(1);
    expect(data.blocked[0].kind).toBe('fields');
    expect(data.blocked[0].id).toBe('rg-booked');
    expect(data.blocked[0].reason).toBe('bookings_exist');
    expect(data.blocked[0].affected_count).toBe(1);

    // **Nothing was written to what it refused over.** Counted from the
    // booking's own table and from `fields` by id -- never derived from the
    // field row a break would remove.
    const fields = getMockData('fields');
    expect(fields.find((f) => String(f.id) === 'rg-booked')).toBeDefined();
    expect(fields.find((f) => String(f.id) === 'rg-free')).toBeUndefined();
    const held = getMockData(booking.table).find((r) => String(r.id) === String(booking.row.id));
    expect(held, 'the booking the refusal was about was destroyed').toBeDefined();
    expect(held.field_id).toBe('rg-booked');

    // **The stored summary is BOUNDED and the returned list is not.** The SQL
    // writes `field_bookings_digest(v_blocked)` into
    // `warning_summary.field_rollback` and RETURNS the whole list, because one
    // job's ledger can hold a row per CSV line. A mock storing the raw array
    // while the database stores a digest is the divergence PR #378's review
    // found one refusal path along.
    const job = getMockData('import_jobs').find((j) => String(j.id) === JOB);
    const stored = job.warning_summary.field_rollback.blocked;
    expect(Array.isArray(stored), 'the stored summary is the raw list').toBe(false);
    expect(stored.total).toBe(1);
    expect(stored.by_kind).toEqual({ fields: 1 });
    expect(stored.sample).toHaveLength(1);

    // Refusal means DEFERRAL. The record keeps `rolled_back_at` unset, so
    // clearing the booking and re-running rolls it back.
    const records = getMockData('import_application_records');
    expect(records.find((r) => String(r.id) === 'rg-record-booked').rolled_back_at).toBeFalsy();
    expect(records.find((r) => String(r.id) === 'rg-record-free').rolled_back_at).toBeTruthy();

    // **The rollback's count is the SHARED producer's answer, not its own.**
    // `admin_delete_field` reads the same enumerator on the same field, so it
    // must name this kind and reach the same total. A rollback that had gone
    // back to a list of its own could still report 1 here while disagreeing
    // with the other two callers about what is on the ground.
    const { data: deleteRefusal } = await supabase.rpc('admin_delete_field', {
      p_organization_id: ORG,
      p_field_id: 'rg-booked',
    });
    expect(deleteRefusal.affected_count).toBe(data.blocked[0].affected_count);
    expect(deleteRefusal.affected.map((row) => row.kind)).toEqual([kind]);
  });

  it('rolls the refused field back once the booking is cleared', async () => {
    await seedJob([FREE_STANDING_PRACTICE]);
    await supabase.rpc('rollback_field_import_job', { p_import_job_id: JOB });

    await supabase.from('practice_assignments').delete().eq('id', FREE_STANDING_PRACTICE.row.id);
    expect(
      getMockData('practice_assignments').find(
        (r) => String(r.id) === FREE_STANDING_PRACTICE.row.id
      ),
      'the booking was not actually cleared, so the replay below would prove nothing'
    ).toBeUndefined();

    const { data, error } = await supabase.rpc('rollback_field_import_job', {
      p_import_job_id: JOB,
    });
    expect(error).toBeNull();
    expect(data.blocked_records).toBe(0);
    expect(data.blocked).toEqual([]);
    expect(data.deleted_fields).toBe(1);
    expect(data.status).toBe('rolled_back');
    expect(getMockData('fields').find((f) => String(f.id) === 'rg-booked')).toBeUndefined();
  });

  it('refuses a game slot held by an assignment that carries only slot_id', async () => {
    // **The column the game arm did not read.** `game_assignments` reaches a
    // slot through `game_slot_id` AND `slot_id`, both ON DELETE CASCADE, and
    // this arm consulted only the first while its practice sibling read both
    // -- a one-arm-not-its-twin asymmetry inside the function this PR is about.
    // `game_slot_id` is left unset so the row is invisible to the old
    // predicate and visible to the new one.
    await seedJob([]);
    await supabase.from('game_slots').insert([
      {
        id: 'rg-game-slot',
        organization_id: ORG,
        field_id: 'rg-free',
        slot_date: '2099-06-01',
        week_index: 1,
      },
    ]);
    await supabase.from('game_assignments').insert([
      {
        id: 'rg-game-assignment',
        organization_id: ORG,
        field_id: null,
        slot_id: 'rg-game-slot',
        start: '2099-06-01T18:00:00.000Z',
        week_index: 1,
      },
    ]);
    await supabase.from('import_application_records').insert([
      {
        id: 'rg-record-slot',
        organization_id: ORG,
        import_job_id: JOB,
        import_type: 'fields',
        target_table: 'game_slots',
        target_id: 'rg-game-slot',
        operation: 'inserted',
      },
    ]);

    const { data, error } = await supabase.rpc('rollback_field_import_job', {
      p_import_job_id: JOB,
    });
    expect(error).toBeNull();
    // TWO refusals, and the second falls out of the first: the slot survives,
    // so the field it sits on is a booked field and is refused in turn. A test
    // expecting one would have been asserting a reading of the RPC rather than
    // the RPC.
    expect(data.blocked_records).toBe(2);
    const slotEntry = data.blocked.find((b) => b.kind === 'game_slots');
    expect(slotEntry, 'the game slot was not refused').toBeDefined();
    expect(slotEntry.id).toBe('rg-game-slot');
    expect(slotEntry.reason).toBe('game_slot_in_use');
    expect(data.blocked.map((b) => b.kind).sort()).toEqual(['fields', 'game_slots']);
    expect(
      getMockData('game_slots').find((slot) => String(slot.id) === 'rg-game-slot'),
      'the refused game slot was deleted anyway'
    ).toBeDefined();
    // The other field carried nothing and still rolls back, so the refusals
    // above are targeted rather than a guard that stopped everything.
    expect(data.deleted_fields).toBe(1);
  });

  it('rolls back an unbooked import without refusing anything', async () => {
    // The negative control for every case above: with nothing on the ground
    // the guard must be invisible. A guard that refused unconditionally would
    // satisfy all three refusal assertions and fail only here.
    await seedJob([]);

    const { data, error } = await supabase.rpc('rollback_field_import_job', {
      p_import_job_id: JOB,
    });
    expect(error).toBeNull();
    expect(data.blocked_records).toBe(0);
    expect(data.deleted_fields).toBe(2);
    expect(data.status).toBe('rolled_back');
  });

  it('refuses a target_table neither switch handles rather than stamping the ledger', async () => {
    // The arm is DEFENSIVE: the apply path only ever writes the five tables
    // the switch handles, so this record is CONSTRUCTED rather than produced.
    // That is the only way to exercise a defensive arm, and it is said out
    // loud rather than dressed up as a reachable case.
    // `field_availability_profiles` is used because it is a legal value of the
    // column (20260522120000) that this rollback genuinely cannot undo.
    // Before LIVE-3 such a record fell through to the ledger UPDATE and was
    // marked rolled back with `{deleted: true}` having deleted nothing.
    await seedJob([AVAILABILITY_PROFILE]);
    await supabase.from('import_application_records').insert([
      {
        id: 'rg-record-profile',
        organization_id: ORG,
        import_job_id: JOB,
        import_type: 'fields',
        target_table: 'field_availability_profiles',
        target_id: 'rg-profile',
        operation: 'inserted',
      },
    ]);

    const { data, error } = await supabase.rpc('rollback_field_import_job', {
      p_import_job_id: JOB,
    });
    expect(data).toBeNull();
    expect(error).not.toBeNull();
    expect(error.code).toBe('22023');
    expect(error.message).toContain('field_availability_profiles');

    // And it changed nothing on the way past.
    const record = getMockData('import_application_records').find(
      (r) => String(r.id) === 'rg-record-profile'
    );
    expect(record.rolled_back_at, 'the refused record was stamped rolled back anyway').toBeFalsy();
  });

  it('keeps a rolled-back SEEDED row gone, instead of letting it resurrect', async () => {
    // **A hard delete that does not tombstone is undone by the next read.**
    // `getDB()` rebuilds from `initialMockData` and `mergeSource` only adds or
    // updates, so a filtered-out seed row comes back -- and `initialMockData`
    // seeds locations, fields, game_slots and practice_slots, which is every
    // arm of the insert switch. The RPC reported a deletion for a row that was
    // still there on the next `getMockData`.
    //
    // **The subject is derived from the fixture, not named here.** It has to
    // be a SEEDED row (one this test inserted has nothing to resurrect from
    // and would pass without the fix) that nothing else holds (or the guard
    // refuses it and the case is about the guard instead). Both conditions are
    // read off the mock, and a fixture that stops satisfying them fails loudly
    // rather than turning this into a test of the refusal path.
    await seedJob([]);
    const held = new Set([
      ...getMockData('games').map((g) => String(g.game_slot_id)),
      ...getMockData('game_assignments').flatMap((a) => [
        String(a.game_slot_id),
        String(a.slot_id),
      ]),
    ]);
    const seededSlot = getMockData('game_slots').find(
      (slot) => String(slot.organization_id) === ORG && !held.has(String(slot.id))
    );
    expect(
      seededSlot,
      'the fixture holds no unbooked seeded game slot; this case has nothing to be about'
    ).toBeDefined();

    await supabase.from('import_application_records').insert([
      {
        id: 'rg-record-seeded',
        organization_id: ORG,
        import_job_id: JOB,
        import_type: 'fields',
        target_table: 'game_slots',
        target_id: seededSlot.id,
        operation: 'inserted',
      },
    ]);

    const { data } = await supabase.rpc('rollback_field_import_job', {
      p_import_job_id: JOB,
    });
    expect(data.deleted_game_slots).toBe(1);
    expect(data.blocked.some((b) => String(b.id) === String(seededSlot.id))).toBe(false);
    // Read AFTER the call, which is what re-merges the seed.
    expect(
      getMockData('game_slots').find((slot) => String(slot.id) === String(seededSlot.id)),
      'the rollback reported deleting a seeded game slot and it came back'
    ).toBeUndefined();
    // ... and the fixture's other slots are untouched, so the assertion above
    // is a targeted delete rather than an emptied table.
    expect(getMockData('game_slots').length).toBeGreaterThan(0);
  });

  it('restores a missing boolean to the default its SQL twin coalesces to', async () => {
    // The SQL writes `COALESCE((v_previous->>'active')::boolean, true)` and
    // four more like it. Mapping every missing key to `null` made a payload
    // with no `active` restore a field the UI reads as inactive here and
    // active in Postgres. A payload legitimately missing a key is what an
    // older ledger row looks like.
    await seedJob([]);
    await supabase.from('fields').insert([
      {
        id: 'rg-defaults',
        organization_id: ORG,
        location_id: 'rg-location',
        name: 'Overwritten',
        active: false,
        priority_rating: 9,
      },
    ]);
    await supabase.from('import_application_records').insert([
      {
        id: 'rg-record-defaults',
        organization_id: ORG,
        import_job_id: JOB,
        import_type: 'fields',
        target_table: 'fields',
        target_id: 'rg-defaults',
        operation: 'updated',
        previous_payload: { location_id: 'rg-location', name: 'Older Ledger Row' },
      },
    ]);

    await supabase.rpc('rollback_field_import_job', { p_import_job_id: JOB });
    const restored = getMockData('fields').find((f) => String(f.id) === 'rg-defaults');
    expect(restored.name).toBe('Older Ledger Row');
    expect(restored.active).toBe(true);
    expect(restored.supports_halves).toBe(false);
    expect(restored.priority_rating).toBe(1);
    // ... and a column the SQL genuinely restores as NULL still comes back
    // NULL, so the defaults above are per-column rather than a blanket rule.
    expect(restored.surface_type).toBeNull();
  });

  it('restores an updated row rather than reporting a restore it did not do', async () => {
    // `restored_records` was the literal `0` here and no column was ever put
    // back, so rolling back an import that UPDATED an existing field kept the
    // imported values in the mock and restored the originals in Postgres. A
    // counter testifying to work nobody did is the `lifecycleNodesJudged`
    // shape 8.4 PR 2 recorded.
    //
    // The updated field is a THIRD one, with no `inserted` record of its own:
    // a field the same job both inserted and updated is deleted by the insert
    // arm first, so the restore would land on nothing and the assertion would
    // be about the counter alone.
    await seedJob([]);
    await supabase.from('fields').insert([
      {
        id: 'rg-updated',
        organization_id: ORG,
        location_id: 'rg-location',
        name: 'Overwritten By Import',
        surface_type: 'turf',
        priority_rating: 9,
        active: true,
      },
    ]);
    await supabase.from('import_application_records').insert([
      {
        id: 'rg-record-updated',
        organization_id: ORG,
        import_job_id: JOB,
        import_type: 'fields',
        target_table: 'fields',
        target_id: 'rg-updated',
        operation: 'updated',
        // **The WHOLE row, because that is what the ledger stores.** The
        // apply path records `to_jsonb(v_field)`, so a payload carrying four
        // columns is a shape production never writes -- and asserting on it
        // hid a divergence: the mock restores every column in its map, so a
        // missing `location_id` became `null` and passed, while the SQL runs
        // `location_id = (v_previous->>'location_id')::uuid` against a NOT
        // NULL column and aborts the whole rollback with 23502. A test that
        // forges state the production path cannot reach certifies the arm it
        // was meant to check.
        previous_payload: {
          id: 'rg-updated',
          organization_id: ORG,
          location_id: 'rg-location',
          name: 'Original Pitch',
          surface_type: 'grass',
          size: '9v9',
          supports_halves: false,
          max_age: 'U10',
          priority_rating: 3,
          active: true,
        },
      },
    ]);

    const { data, error } = await supabase.rpc('rollback_field_import_job', {
      p_import_job_id: JOB,
    });
    expect(error).toBeNull();
    expect(data.restored_records).toBe(1);

    const restored = getMockData('fields').find((f) => String(f.id) === 'rg-updated');
    expect(restored, 'the restore deleted the row instead of putting it back').toBeDefined();
    expect(restored.name).toBe('Original Pitch');
    expect(restored.surface_type).toBe('grass');
    expect(restored.priority_rating).toBe(3);
    // The NOT NULL column the four-column payload used to leave null.
    expect(restored.location_id).toBe('rg-location');

    const record = getMockData('import_application_records').find(
      (r) => String(r.id) === 'rg-record-updated'
    );
    expect(record.rolled_back_at).toBeTruthy();
    expect(record.rollback_payload.name).toBe('Original Pitch');
  });
});
