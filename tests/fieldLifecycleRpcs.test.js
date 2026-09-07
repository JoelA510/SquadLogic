/**
 * **The retirement and blackout RPCs, against the mock client.**
 *
 * These pin the behaviour the SQL states, on the client the whole E2E suite
 * runs against. The database's own guarantees -- RLS, SECURITY DEFINER,
 * search_path, the CHECK constraints -- are asserted structurally in
 * `docs/sql/20260906000000_smoke.sql` and `..._20260906000100_smoke.sql`, since
 * they need a real session to exercise.
 *
 * The load-bearing one is the `active`/`effective_to` pair. PR 2 keeps both
 * columns deliberately, because the shipped scheduler filters on `active`
 * (`GameSchedulingPage.jsx:253`). Two columns saying one thing is a hazard, and
 * the way it is bounded is that nothing writes one without the other.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, it } from 'vitest';

import { mockSupabase as supabase, getMockData } from '../frontend/src/lib/mockSupabaseClient.js';

const ORG = 'org-1';

/**
 * The booking kinds `admin_retire_field` enumerates, read out of the
 * migration rather than written down here.
 *
 * The mock enumerated two of the four tables while the SQL enumerated four,
 * so a field with every game ASSIGNED to it reported `affected_count: 0` in
 * the mock and refused correctly in the database. A hand-written list in this
 * file would have agreed with whichever of the two it was copied from -- the
 * exact shape of PR 1's `productionConsumers` defect. So the expected set is
 * derived from the SQL and this file holds only the seeding.
 *
 * @returns {string[]} sorted `kind` literals
 */
const migrationKinds = () => {
  // **Read from the SHARED producer.** It used to parse admin_retire_field's
  // own union in 20260906000000 -- which was the problem: that union had four
  // arms where the delete had five, so a retirement under-reported and this
  // helper certified the shortfall as the expected set. 20260907000000 moved
  // both RPCs onto `public.field_bookings`, and this reads that.
  const sql = readFileSync(
    path.join(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
      'supabase/migrations/20260907000000_field_delete_booking_guard.sql'
    ),
    'utf8'
  );
  const body = sql.slice(
    sql.indexOf('CREATE OR REPLACE FUNCTION public.field_bookings('),
    sql.indexOf('REVOKE ALL ON FUNCTION public.field_bookings')
  );
  expect(body.length, 'the shared enumerator moved; this parse is stale').toBeGreaterThan(100);
  const kinds = [...new Set([...body.matchAll(/SELECT '([a-z_]+)'::text/g)].map((m) => m[1]))];
  // A parse that matched nothing would make every `kinds.includes(...)` below
  // fail loudly rather than pass, but an empty set is still a stale parse.
  expect(kinds.length).toBe(5);
  return kinds.sort();
};

const setMockSession = (userId) => {
  sessionStorage.setItem('__MOCK_SESSION__', JSON.stringify({ user: { id: userId } }));
};

/** The first field of the seeded org, whatever it is. */
const someField = () => getMockData('fields').find((f) => String(f.organization_id) === ORG);

describe('field lifecycle RPCs :: retirement writes active and effective_to together', () => {
  beforeEach(() => {
    sessionStorage.clear();
    delete window.__MOCK_DB__;
    setMockSession('mock-admin-id');
  });

  it('retires a field with no affected bookings, setting both columns', async () => {
    const field = someField();
    expect(field).toBeDefined();
    // The precondition, asserted so the assertion after the call is about the
    // RPC rather than about a field that was already retired.
    expect(field.active).not.toBe(false);
    expect(field.effective_to ?? null).toBeNull();

    const { data, error } = await supabase.rpc('admin_retire_field', {
      p_organization_id: ORG,
      p_field_id: field.id,
      p_effective_to: '2099-12-31',
      p_confirm: false,
    });
    expect(error).toBeNull();
    expect(data.retired).toBe(true);

    const after = getMockData('fields').find((f) => String(f.id) === String(field.id));
    expect(after.effective_to).toBe('2099-12-31');
    // **Still active, because the retirement is in the FUTURE.** The first
    // draft set active=false unconditionally, so a retirement dated years out
    // removed the field from the scheduler today -- for the entire period this
    // same call had just reported as unaffected. `active` follows the date.
    expect(after.active).toBe(true);
  });

  it('deactivates immediately only when the retirement date has passed', () => {
    // The other direction, so the assertion above is about the date and not
    // about retirement never deactivating.
    return (async () => {
      const field = someField();
      await supabase.rpc('admin_retire_field', {
        p_organization_id: ORG,
        p_field_id: field.id,
        p_effective_to: '2000-01-01',
        p_confirm: true,
      });
      const after = getMockData('fields').find((f) => String(f.id) === String(field.id));
      expect(after.effective_to).toBe('2000-01-01');
      expect(after.active).toBe(false);
    })();
  });

  it('runs the retirement trigger on DIRECT writes, not only inside the RPCs', async () => {
    // **A trigger fires on every write.** The mock mirrored
    // `fields_retirement_deactivates` inside the RPC block only, so
    // `from('fields').insert()` and `.update()` bypassed it and a row written
    // directly could sit `active = true` with a retirement already past -- a
    // state Postgres makes unreachable. It mattered beyond tidiness: the shared
    // scenario table seeds its `before` states through `.insert()`, so the two
    // runners could have been testing different scenarios under one id.
    //
    // No scenario can cover this, because the whole point is that the state is
    // unreachable through a write. So it is asserted here, on the write path.
    await supabase.from('fields').insert({
      id: 'trigger-direct-insert',
      organization_id: ORG,
      location_id: someField().location_id,
      name: 'Direct Insert',
      active: true,
      effective_to: '2000-01-01',
    });
    const inserted = getMockData('fields').find((f) => String(f.id) === 'trigger-direct-insert');
    expect(inserted.active).toBe(false);

    // A FUTURE retirement written directly is left alone -- one-directional,
    // the same as the RPC and the SQL trigger.
    await supabase.from('fields').insert({
      id: 'trigger-direct-future',
      organization_id: ORG,
      location_id: someField().location_id,
      name: 'Direct Future',
      active: true,
      effective_to: '2099-01-01',
    });
    expect(getMockData('fields').find((f) => String(f.id) === 'trigger-direct-future').active).toBe(
      true
    );

    // ... and on UPDATE, which is the other half of BEFORE INSERT OR UPDATE.
    await supabase
      .from('fields')
      .update({ effective_to: '2000-01-01' })
      .eq('id', 'trigger-direct-future');
    expect(getMockData('fields').find((f) => String(f.id) === 'trigger-direct-future').active).toBe(
      false
    );
  });

  it('does not let an ordinary field edit un-retire ground', async () => {
    // The mock mirrors the database trigger. Without it PR 3's UI would be
    // built against a mock where renaming a retired field brings it back into
    // the scheduler while Postgres silently refuses.
    const field = someField();
    await supabase.rpc('admin_retire_field', {
      p_organization_id: ORG,
      p_field_id: field.id,
      p_effective_to: '2000-01-01',
      p_confirm: true,
    });
    await supabase.rpc('admin_update_field', {
      p_organization_id: ORG,
      p_field_id: field.id,
      p_location_id: field.location_id,
      p_name: 'Renamed Pitch',
      p_active: true,
    });
    const after = getMockData('fields').find((f) => String(f.id) === String(field.id));
    expect(after.name).toBe('Renamed Pitch');
    expect(after.active).toBe(false);
    expect(after.effective_to).toBe('2000-01-01');
  });

  it('never leaves active and effective_to disagreeing, after either RPC', async () => {
    // **The hazard check.** The pair is the reason `active` survived; this is
    // what bounds it. Asserted over every field in the org after a retire and
    // after an unretire, not just the one touched.
    const field = someField();
    // **One-directional, matching the migration and the smoke.** The first
    // draft asserted the biconditional that both of those explicitly refuse:
    // `active === false` with no effective_to is ordinary deactivation, and
    // calling it a disagreement made three producers give two answers.
    //
    // A PAST retirement implies inactive. A future one does not -- the field
    // stays live until the date arrives, which is finding 1.
    const today = new Date().toISOString().slice(0, 10);
    const disagrees = (f) =>
      f.effective_to !== null &&
      f.effective_to !== undefined &&
      f.effective_to < today &&
      f.active === true;

    await supabase.rpc('admin_retire_field', {
      p_organization_id: ORG,
      p_field_id: field.id,
      p_effective_to: '2000-01-01',
      p_confirm: true,
    });
    let all = getMockData('fields').filter((f) => String(f.organization_id) === ORG);
    expect(all.length).toBeGreaterThan(0);
    expect(all.filter(disagrees)).toEqual([]);

    await supabase.rpc('admin_unretire_field', {
      p_organization_id: ORG,
      p_field_id: field.id,
    });
    all = getMockData('fields').filter((f) => String(f.organization_id) === ORG);
    expect(all.filter(disagrees)).toEqual([]);
    const after = getMockData('fields').find((f) => String(f.id) === String(field.id));
    // **`active` stays false, and this line used to assert `true`.** The retire
    // above used a PAST date, so the field was deactivated; unretiring clears
    // the date and leaves activity exactly as it found it, because it cannot
    // know whether the field was deactivated by that retirement or beforehand.
    // Asserting `true` here did not merely miss the mock writing `active: true`
    // unconditionally -- it CERTIFIED it, which is the shape where a passing
    // test pins the bug. Re-activating is `admin_update_field`'s job.
    expect(after.active).toBe(false);
    expect(after.effective_to).toBeNull();

    // The predicate is not vacuous, and it is the one-directional one:
    // a past retirement left active is a disagreement; ordinary deactivation
    // and a future retirement are not.
    expect(disagrees({ active: true, effective_to: '2000-01-01' })).toBe(true);
    expect(disagrees({ active: false, effective_to: null })).toBe(false);
    expect(disagrees({ active: true, effective_to: '2099-12-31' })).toBe(false);
    expect(disagrees({ active: false, effective_to: '2000-01-01' })).toBe(false);
  });

  it('refuses, writes nothing, and names the affected bookings', async () => {
    // The refusal is in the RPC, not the UI: a confirmation a caller can skip
    // by calling the RPC directly is not a guard.
    const field = someField();
    const slots = getMockData('game_slots').filter(
      (s) => String(s.organization_id) === ORG && String(s.field_id) === String(field.id)
    );
    expect(slots.length).toBeGreaterThan(0);

    const { data, error } = await supabase.rpc('admin_retire_field', {
      p_organization_id: ORG,
      p_field_id: field.id,
      p_effective_to: '2000-01-01',
      p_confirm: false,
    });
    expect(error).toBeNull();
    expect(data.retired).toBe(false);
    expect(data.reason).toBe('bookings_after_effective_to');
    expect(data.affected_count).toBeGreaterThanOrEqual(slots.length);
    expect(data.affected.length).toBe(data.affected_count);
    // **Every kind is one the migration enumerates, and the list comes from
    // the migration.** This assertion used to hold a hand-written pair --
    // `['game_slot', 'practice_slot']` -- and it went red the moment the mock
    // learned to see assignments, because the SEEDED CORPUS already contained
    // assignments on this field that the mock had been silently omitting from
    // every refusal. The literal pair was not merely incomplete; it was the
    // thing certifying the omission as correct.
    const kinds = migrationKinds();
    expect(data.affected.every((a) => kinds.includes(a.kind))).toBe(true);

    // **Nothing was written.** A refusal that half-applied would be worse than
    // no guard at all.
    const after = getMockData('fields').find((f) => String(f.id) === String(field.id));
    expect(after.effective_to ?? null).toBeNull();
    expect(after.active).not.toBe(false);
  });

  it('calls an unbounded practice slot certain, not unjudged', async () => {
    // **Certain and unjudged are different answers.** A practice slot with no
    // `valid_until` runs forever, so it is CERTAINLY stranded by any
    // retirement -- the opposite of "could not be judged". The first draft
    // flagged it `undated`, conflating a certain answer with an absent one.
    const field = someField();
    await supabase.from('practice_slots').insert({
      id: 'practice-forever',
      organization_id: ORG,
      field_id: field.id,
      day_of_week: 'mon',
      valid_from: '2026-01-01',
      valid_until: null,
    });

    const { data } = await supabase.rpc('admin_retire_field', {
      p_organization_id: ORG,
      p_field_id: field.id,
      p_effective_to: '2099-12-31',
      p_confirm: false,
    });
    const forever = data.affected.find((a) => String(a.id) === 'practice-forever');
    expect(forever).toBeDefined();
    expect(forever.kind).toBe('practice_slot');
    // Not "undated": we know exactly what it does -- it never ends.
    expect(forever.undated).toBe(false);
    expect(forever.unbounded).toBe(true);

    // A bounded practice slot past the date is affected and neither flag is set.
    await supabase.from('practice_slots').insert({
      id: 'practice-bounded',
      organization_id: ORG,
      field_id: field.id,
      day_of_week: 'tue',
      valid_from: '2026-01-01',
      valid_until: '2100-06-30',
    });
    const again = await supabase.rpc('admin_retire_field', {
      p_organization_id: ORG,
      p_field_id: field.id,
      p_effective_to: '2099-12-31',
      p_confirm: false,
    });
    const bounded = again.data.affected.find((a) => String(a.id) === 'practice-bounded');
    expect(bounded).toBeDefined();
    expect(bounded.undated).toBe(false);
    expect(bounded.unbounded).toBe(false);
  });

  it('treats an EMPTY valid_until as no date, not as a date before every date', async () => {
    // **The field-import apply path writes `valid_until: ''`** for an
    // open-ended practice slot (`payload.valid_until || payload.end_date ||
    // ''`), so '' is a shape the corpus really produces. A date comparison
    // reads '' as earlier than everything, which drops a slot that runs
    // forever out of the affected list -- while the same row still reports
    // `unbounded: true`. A row cannot be both certainly stranded and
    // unaffected.
    const field = someField();
    await supabase.from('practice_slots').insert({
      id: 'practice-empty-until',
      organization_id: ORG,
      field_id: field.id,
      day_of_week: 'wed',
      valid_from: '2026-01-01',
      valid_until: '',
    });

    const { data } = await supabase.rpc('admin_retire_field', {
      p_organization_id: ORG,
      p_field_id: field.id,
      p_effective_to: '2099-12-31',
      p_confirm: false,
    });
    const carried = data.affected.find((a) => String(a.id) === 'practice-empty-until');
    expect(carried, 'an open-ended practice slot was dropped from the refusal').toBeDefined();
    expect(carried.unbounded).toBe(true);
    expect(carried.undated).toBe(false);
    // And the same reading in the PROJECTION, not only in the filter. Postgres
    // cannot store '' in a date column, so it reports null here; passing the ''
    // through would give a consumer branching on `on_date === null` a different
    // answer on each arm for exactly the row this case is about.
    expect(carried.on_date, 'the empty valid_until reached the payload verbatim').toBeNull();
  });

  it('reads a game slot date from slot_date, not only from start', async () => {
    // **The defect the first draft shipped.** `game_slots.start` is nullable
    // AND the import path never populates it -- it writes slot_date/start_time.
    // Reading `start` alone called every import-created slot "undated" and
    // refused every retirement of an imported field with a warning that was
    // false. A slot dated well before the retirement must not be affected.
    const field = someField();
    await supabase.from('game_slots').insert({
      id: 'slot-imported',
      organization_id: ORG,
      field_id: field.id,
      slot_date: '2020-01-01',
      start: null,
      week_index: 1,
    });

    const { data } = await supabase.rpc('admin_retire_field', {
      p_organization_id: ORG,
      p_field_id: field.id,
      p_effective_to: '2099-12-31',
      p_confirm: false,
    });
    const imported = (data.affected || []).find((a) => String(a.id) === 'slot-imported');
    expect(imported).toBeUndefined();
  });

  it('counts a genuinely undated booking as affected rather than dropping it', async () => {
    // A row with neither slot_date nor start cannot be judged against the
    // retirement date at all. Carried and flagged, never dropped.
    const field = someField();
    await supabase.from('game_slots').insert({
      id: 'slot-undated',
      organization_id: ORG,
      field_id: field.id,
      slot_date: null,
      start: null,
      week_index: 1,
    });

    const { data } = await supabase.rpc('admin_retire_field', {
      p_organization_id: ORG,
      p_field_id: field.id,
      p_effective_to: '2099-12-31',
      p_confirm: false,
    });
    expect(data.retired).toBe(false);
    const carried = data.affected.find((a) => String(a.id) === 'slot-undated');
    expect(carried).toBeDefined();
    expect(carried.undated).toBe(true);
    expect(carried.kind).toBe('game_slot');
  });
});

describe('field lifecycle RPCs :: blackouts are scoped to exactly one thing', () => {
  beforeEach(() => {
    sessionStorage.clear();
    delete window.__MOCK_DB__;
    setMockSession('mock-admin-id');
  });

  it('creates a field-scoped blackout', async () => {
    const field = someField();
    const { data, error } = await supabase.rpc('admin_create_field_blackout', {
      p_organization_id: ORG,
      p_location_id: null,
      p_field_id: field.id,
      p_blackout_from: '2026-08-01',
      p_blackout_until: '2026-08-31',
      p_reason: 'maintenance',
    });
    expect(error).toBeNull();
    expect(data.field_id).toBe(field.id);
    expect(data.location_id).toBeNull();
    expect(data.reason).toBe('maintenance');
    expect(getMockData('field_blackouts').length).toBe(1);
  });

  it('refuses a blackout scoped to both, or to neither', async () => {
    const field = someField();
    const both = await supabase.rpc('admin_create_field_blackout', {
      p_organization_id: ORG,
      p_location_id: field.location_id,
      p_field_id: field.id,
      p_blackout_from: '2026-08-01',
      p_blackout_until: '2026-08-31',
    });
    expect(both.error).not.toBeNull();

    const neither = await supabase.rpc('admin_create_field_blackout', {
      p_organization_id: ORG,
      p_location_id: null,
      p_field_id: null,
      p_blackout_from: '2026-08-01',
      p_blackout_until: '2026-08-31',
    });
    expect(neither.error).not.toBeNull();
    // Neither call wrote anything.
    expect(getMockData('field_blackouts').length).toBe(0);
  });

  it('refuses rows the database CHECK constraints would reject', async () => {
    // The mock is the client the E2E suite runs against, so a mock that
    // accepted rows Postgres refuses lets PR 3's UI pass every test and fail in
    // production. Each of the three table CHECKs has a case here.
    const field = someField();
    const base = {
      p_organization_id: ORG,
      p_location_id: null,
      p_field_id: field.id,
      p_blackout_from: '2026-08-01',
      p_blackout_until: '2026-08-31',
    };
    const inverted = await supabase.rpc('admin_create_field_blackout', {
      ...base,
      p_blackout_until: '2026-07-01',
    });
    expect(inverted.error).not.toBeNull();

    const halfTimed = await supabase.rpc('admin_create_field_blackout', {
      ...base,
      p_start_minutes: 540,
    });
    expect(halfTimed.error).not.toBeNull();

    const backwards = await supabase.rpc('admin_create_field_blackout', {
      ...base,
      p_start_minutes: 900,
      p_end_minutes: 540,
    });
    expect(backwards.error).not.toBeNull();

    expect(getMockData('field_blackouts').length).toBe(0);

    // ... and a well-formed timed blackout is accepted, so the three refusals
    // are about their defects and not about times generally.
    const ok = await supabase.rpc('admin_create_field_blackout', {
      ...base,
      p_start_minutes: 540,
      p_end_minutes: 900,
    });
    expect(ok.error).toBeNull();
    expect(ok.data.start_minutes).toBe(540);
    expect(ok.data.end_minutes).toBe(900);
  });

  it('refuses a reason outside the enum and a missing date', async () => {
    // **The mock is the contract PR 3 is written against**, so a mock looser
    // than the database is a defect generator for the next PR. The first draft
    // mirrored three CHECKs and missed the reason enum and the NOT NULL dates:
    // `p_reason: 'closure'` and absent dates passed here and are rejected by
    // Postgres.
    const field = someField();
    const base = {
      p_organization_id: ORG,
      p_location_id: null,
      p_field_id: field.id,
      p_blackout_from: '2026-08-01',
      p_blackout_until: '2026-08-31',
    };
    const badReason = await supabase.rpc('admin_create_field_blackout', {
      ...base,
      p_reason: 'closure',
    });
    expect(badReason.error).not.toBeNull();

    const noFrom = await supabase.rpc('admin_create_field_blackout', {
      ...base,
      p_blackout_from: null,
    });
    expect(noFrom.error).not.toBeNull();

    const noUntil = await supabase.rpc('admin_create_field_blackout', {
      ...base,
      p_blackout_until: null,
    });
    expect(noUntil.error).not.toBeNull();
    expect(getMockData('field_blackouts').length).toBe(0);

    // Every declared reason is accepted, so the refusal is about the value and
    // not about the enum being checked at all.
    for (const reason of ['maintenance', 'weather', 'event', 'permit', 'closed', 'other']) {
      const ok = await supabase.rpc('admin_create_field_blackout', { ...base, p_reason: reason });
      expect({ reason, error: ok.error }).toEqual({ reason, error: null });
    }
    expect(getMockData('field_blackouts').length).toBe(6);
  });

  it('cascades blackouts when the field they scope to is deleted', async () => {
    // field_blackouts.field_id is ON DELETE CASCADE. A mock leaving orphans
    // would show an E2E scenario closures production would not have.
    const field = someField();
    await supabase.rpc('admin_create_field_blackout', {
      p_organization_id: ORG,
      p_location_id: null,
      p_field_id: field.id,
      p_blackout_from: '2026-08-01',
      p_blackout_until: '2026-08-31',
    });
    expect(getMockData('field_blackouts').length).toBe(1);
    // **`p_confirm: true` is load-bearing here, and its absence is why this
    // test changed.** The seeded org's first field carries game slots, so an
    // unconfirmed delete is now REFUSED and cascades nothing. The refusal is
    // asserted directly first, so this test proves the guard is live rather
    // than routing round it: without the assertion, a guard that had stopped
    // working would leave the confirmed call below passing unchanged.
    const refused = await supabase.rpc('admin_delete_field', {
      p_organization_id: ORG,
      p_field_id: field.id,
    });
    expect(refused.error).toBeNull();
    expect(refused.data.deleted).toBe(false);
    expect(getMockData('field_blackouts').length).toBe(1);

    await supabase.rpc('admin_delete_field', {
      p_organization_id: ORG,
      p_field_id: field.id,
      p_confirm: true,
    });
    expect(getMockData('field_blackouts').length).toBe(0);
  });

  it('refuses ground belonging to another organization', async () => {
    // The RPC is SECURITY DEFINER and bypasses RLS, so the scope check is the
    // only thing standing between an admin of one org and another org's ground.
    const { error } = await supabase.rpc('admin_create_field_blackout', {
      p_organization_id: ORG,
      p_location_id: null,
      p_field_id: 'a-field-that-is-not-in-this-org',
      p_blackout_from: '2026-08-01',
      p_blackout_until: '2026-08-31',
    });
    expect(error).not.toBeNull();
    expect(getMockData('field_blackouts').length).toBe(0);
  });

  it('deletes a blackout and refuses an unknown id', async () => {
    const field = someField();
    const { data: created } = await supabase.rpc('admin_create_field_blackout', {
      p_organization_id: ORG,
      p_location_id: null,
      p_field_id: field.id,
      p_blackout_from: '2026-08-01',
      p_blackout_until: '2026-08-31',
    });
    const { data, error } = await supabase.rpc('admin_delete_field_blackout', {
      p_organization_id: ORG,
      p_blackout_id: created.id,
    });
    expect(error).toBeNull();
    expect(data.deleted).toBe(true);
    expect(getMockData('field_blackouts').length).toBe(0);

    const missing = await supabase.rpc('admin_delete_field_blackout', {
      p_organization_id: ORG,
      p_blackout_id: 'no-such-blackout',
    });
    expect(missing.error).not.toBeNull();
  });
});

describe('field lifecycle RPCs :: the affected-booking family is the migration set, not a shorter one', () => {
  beforeEach(() => {
    sessionStorage.clear();
    delete window.__MOCK_DB__;
    setMockSession('mock-admin-id');
  });

  it('reads a non-empty family out of the migration', () => {
    // The meta-assertion. A regex that matched nothing would make the test
    // below assert that the mock produces the empty set, which every possible
    // mock satisfies.
    const kinds = migrationKinds();
    // FIVE, not four. `games` carries no field_id and is destroyed with its
    // slot anyway, so a retirement that could not see it under-reported what it
    // stranded -- and this assertion, pinned at four, certified the shortfall.
    expect(kinds.length).toBe(5);
    expect(kinds).toEqual([
      'game',
      'game_assignment',
      'game_slot',
      'practice_assignment',
      'practice_slot',
    ]);
  });

  it('gives retire the six keys its SQL twin emits, and no more', async () => {
    // **`cascades` is the producer's internal answer**, not part of either
    // payload: it says whether a DELETE would destroy the row, and a retirement
    // destroys nothing. The SQL builds retire's jsonb key by key and emits six;
    // the mock shares the enumerator, so it has to drop the seventh rather than
    // pass it through. A key the mock produces and the database does not is the
    // divergence the shared scenario table exists to stop, one level below
    // anything the table compares.
    const field = someField();
    await supabase.from('game_slots').insert({
      id: 'keys-gs',
      organization_id: ORG,
      field_id: field.id,
      slot_date: '2099-01-01',
    });

    const { data: retired } = await supabase.rpc('admin_retire_field', {
      p_organization_id: ORG,
      p_field_id: field.id,
      p_effective_to: '2026-01-01',
      p_confirm: false,
    });
    expect(retired.retired).toBe(false);
    expect(retired.affected.length).toBeGreaterThan(0);
    for (const row of retired.affected) {
      expect(Object.keys(row).sort(), `retire row ${row.id}`).toEqual([
        'id',
        'kind',
        'on_date',
        'unbounded',
        'undated',
        'week_index',
      ]);
    }

    // ... and the delete payload carries exactly one more: the word the
    // operator reads, which retire has no answer for.
    const { data: refused } = await supabase.rpc('admin_delete_field', {
      p_organization_id: ORG,
      p_field_id: field.id,
    });
    expect(refused.deleted).toBe(false);
    expect(refused.affected.length).toBeGreaterThan(0);
    for (const row of refused.affected) {
      expect(Object.keys(row).sort(), `delete row ${row.id}`).toEqual([
        'disposition',
        'id',
        'kind',
        'on_date',
        'unbounded',
        'undated',
        'week_index',
      ]);
    }
  });

  it('returns the top-level keys its SQL twin returns, on the SUCCESS paths too', async () => {
    // **The refusal payloads were pinned; the success payloads were not.** The
    // mechanism census -- every site in this file writing `affected` -- found
    // a confirmed retirement returning `{retired, affected_count, field}` while
    // its SQL twin returns `affected` as well, so a UI could list what a
    // refusal would strand but not what a confirmation just did.
    //
    // The expected sets are read out of the migration's own RETURN blocks.
    const sql = readFileSync(
      path.join(
        path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
        'supabase/migrations/20260907000000_field_delete_booking_guard.sql'
      ),
      'utf8'
    );
    /**
     * The keys of the LAST `RETURN jsonb_build_object(...)` in one RPC -- the
     * success path, every earlier return being a refusal or a not-found.
     *
     * @param {string} fnName
     * @returns {string[]} sorted key literals
     */
    const successKeys = (fnName) => {
      const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${fnName}(`);
      expect(start, `${fnName} is not in this migration`).toBeGreaterThan(-1);
      const body = sql.slice(start, sql.indexOf('REVOKE ALL ON FUNCTION', start));
      const blocks = body.split('RETURN jsonb_build_object(');
      expect(blocks.length, `${fnName} has no RETURN jsonb_build_object`).toBeGreaterThan(1);
      const last = blocks[blocks.length - 1].split(');')[0];
      const keys = [...new Set([...last.matchAll(/'([a-z_]+)',/g)].map((m) => m[1]))];
      expect(keys.length, `${fnName}'s success return parsed to nothing`).toBeGreaterThan(1);
      return keys.sort();
    };

    const field = someField();
    await supabase.from('game_slots').insert({
      id: 'success-keys-gs',
      organization_id: ORG,
      field_id: field.id,
      slot_date: '2099-01-01',
    });

    const { data: retired } = await supabase.rpc('admin_retire_field', {
      p_organization_id: ORG,
      p_field_id: field.id,
      p_effective_to: '2026-01-01',
      p_confirm: true,
    });
    expect(retired.retired).toBe(true);
    expect(Object.keys(retired).sort()).toEqual(successKeys('admin_retire_field'));
    // Not merely present: the same rows the refusal would have listed.
    expect(retired.affected.length).toBe(retired.affected_count);
    expect(retired.affected_count).toBeGreaterThan(0);

    const { data: deleted } = await supabase.rpc('admin_delete_field', {
      p_organization_id: ORG,
      p_field_id: field.id,
      p_confirm: true,
    });
    expect(deleted.deleted).toBe(true);
    expect(Object.keys(deleted).sort()).toEqual(successKeys('admin_delete_field'));
  });

  it('bounds the audit row the way field_bookings_digest does, on both arms', async () => {
    // **The PAYLOAD carries the whole list; the AUDIT ROW carries a digest.**
    // The migration writes `public.field_bookings_digest(v_affected)` into
    // `audit_log.metadata.affected` on all four booking phases -- a refusal on
    // a busy field would otherwise write an arbitrarily large row on every
    // attempt -- while the mock wrote the raw array. Nothing in the suite
    // looked at the mock's audit metadata, so the two arms disagreed silently
    // about the shape of a field PR 3's audit surface is built to read.
    //
    // The expected key set is READ OUT OF THE MIGRATION, not written here: a
    // list copied from either arm would agree with whichever it was copied
    // from, which is how the shortfall above got certified once already.
    const sql = readFileSync(
      path.join(
        path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
        'supabase/migrations/20260907000000_field_delete_booking_guard.sql'
      ),
      'utf8'
    );
    const digestBody = sql.slice(
      sql.indexOf('CREATE OR REPLACE FUNCTION public.field_bookings_digest('),
      sql.indexOf('REVOKE ALL ON FUNCTION public.field_bookings_digest')
    );
    expect(digestBody.length, 'the digest moved; this parse is stale').toBeGreaterThan(100);
    const digestKeys = [
      ...new Set([...digestBody.matchAll(/^\s+'([a-z_]+)',/gm)].map((m) => m[1])),
    ];
    expect(digestKeys.sort()).toEqual(['by_kind', 'omitted', 'sample', 'total']);

    const field = someField();
    await supabase.from('game_slots').insert({
      id: 'digest-gs',
      organization_id: ORG,
      field_id: field.id,
      slot_date: '2099-01-01',
    });
    await supabase.from('practice_slots').insert({
      id: 'digest-ps',
      organization_id: ORG,
      field_id: field.id,
      day_of_week: 'mon',
      valid_from: '2026-01-01',
    });

    const auditRows = () =>
      getMockData('audit_log').filter(
        (row) =>
          String(row.resource_id) === String(field.id) &&
          ['admin_retire_field', 'admin_delete_field'].includes(row.metadata?.operation)
      );

    // All four phases that carry the key, in the order that reaches them: a
    // refusal on each arm, then a confirmed call on each. Without the confirmed
    // retire the `before` phase of that arm is never written, and its plant
    // came back NOT CAUGHT -- the assertion below was reading the delete's
    // `before` twice and calling it both arms.
    await supabase.rpc('admin_retire_field', {
      p_organization_id: ORG,
      p_field_id: field.id,
      p_effective_to: '2026-01-01',
      p_confirm: false,
    });
    await supabase.rpc('admin_retire_field', {
      p_organization_id: ORG,
      p_field_id: field.id,
      p_effective_to: '2026-01-01',
      p_confirm: true,
    });
    await supabase.rpc('admin_delete_field', {
      p_organization_id: ORG,
      p_field_id: field.id,
    });
    await supabase.rpc('admin_delete_field', {
      p_organization_id: ORG,
      p_field_id: field.id,
      p_confirm: true,
    });

    // Every phase that carries `affected` at all, whichever RPC wrote it,
    // compared against the four NAMED pairs rather than against itself: an arm
    // that stopped writing the key is then a shortfall, not a silence.
    const carrying = auditRows().filter((row) => 'affected' in (row.metadata || {}));
    expect(
      [...new Set(carrying.map((row) => `${row.metadata.operation}/${row.metadata.phase}`))].sort()
    ).toEqual([
      'admin_delete_field/before',
      'admin_delete_field/refused',
      'admin_retire_field/before',
      'admin_retire_field/refused',
    ]);
    for (const row of carrying) {
      const digest = row.metadata.affected;
      expect(
        Array.isArray(digest),
        `${row.metadata.operation}/${row.metadata.phase} wrote a raw array`
      ).toBe(false);
      expect(Object.keys(digest).sort(), `${row.metadata.operation}/${row.metadata.phase}`).toEqual(
        ['by_kind', 'omitted', 'sample', 'total']
      );
      expect(digest.total).toBe(row.metadata.affected_count);
      expect(digest.sample.length).toBeLessThanOrEqual(digest.total);
      expect(
        Object.values(digest.by_kind).reduce((a, b) => a + b, 0),
        'by_kind does not add up to total'
      ).toBe(digest.total);
    }
  });

  it('reports every kind the migration enumerates, assignments included', async () => {
    const field = someField();
    await supabase.from('game_slots').insert({
      id: 'fam-gs',
      organization_id: ORG,
      field_id: field.id,
      slot_date: '2099-01-01',
      week_index: 3,
    });
    await supabase.from('game_assignments').insert({
      id: 'fam-ga',
      organization_id: ORG,
      field_id: field.id,
      start: '2099-01-02T18:00:00Z',
      week_index: 4,
    });
    await supabase.from('practice_slots').insert({
      id: 'fam-ps',
      organization_id: ORG,
      field_id: field.id,
      valid_until: '2099-03-01',
    });
    await supabase.from('practice_assignments').insert({
      id: 'fam-pa',
      organization_id: ORG,
      field_id: field.id,
      effective_date_range: '[2098-01-01,2099-06-30]',
    });
    // The fifth kind: a fixture on the seeded slot. A retirement strands it
    // exactly as it strands the slot, and until this PR neither arm said so.
    await supabase.from('games').insert({
      id: 'fam-g',
      organization_id: ORG,
      game_slot_id: 'fam-gs',
    });

    const { data, error } = await supabase.rpc('admin_retire_field', {
      p_organization_id: ORG,
      p_field_id: field.id,
      p_effective_to: '2026-01-01',
      p_confirm: false,
    });
    expect(error).toBeNull();
    expect(data.retired).toBe(false);

    const reported = [...new Set(data.affected.map((a) => a.kind))].sort();
    expect(reported).toEqual(migrationKinds());

    // ... and each seeded row is there by id, so "the kind appeared" is not
    // satisfied by some other row of the same kind already in the corpus.
    const byId = new Map(data.affected.map((a) => [String(a.id), a]));
    for (const id of ['fam-gs', 'fam-ga', 'fam-ps', 'fam-pa', 'fam-g']) {
      expect(byId.has(id)).toBe(true);
    }
    expect(byId.get('fam-ga').on_date).toBe('2099-01-02');
    expect(byId.get('fam-ga').week_index).toBe(4);
    expect(byId.get('fam-ga').undated).toBe(false);
    // **`upper()` normalizes an inclusive range to the day after.** Reading the
    // closing literal as the last covered day would report 2099-06-30 here and
    // judge an assignment on its final day unaffected.
    expect(byId.get('fam-pa').on_date).toBe('2099-07-01');
    expect(byId.get('fam-pa').unbounded).toBe(false);
  });

  it('calls an unbounded practice assignment certain, and an exclusive range by its literal', async () => {
    const field = someField();
    await supabase.from('practice_assignments').insert({
      id: 'fam-pa-forever',
      organization_id: ORG,
      field_id: field.id,
      effective_date_range: null,
    });
    await supabase.from('practice_assignments').insert({
      id: 'fam-pa-open',
      organization_id: ORG,
      field_id: field.id,
      effective_date_range: '[2098-01-01,)',
    });
    await supabase.from('practice_assignments').insert({
      id: 'fam-pa-excl',
      organization_id: ORG,
      field_id: field.id,
      effective_date_range: '[2098-01-01,2099-06-30)',
    });

    const { data } = await supabase.rpc('admin_retire_field', {
      p_organization_id: ORG,
      p_field_id: field.id,
      p_effective_to: '2026-01-01',
      p_confirm: false,
    });
    const byId = new Map(data.affected.map((a) => [String(a.id), a]));
    // No range and an open upper bound both run forever: CERTAINLY stranded,
    // not unjudged. `undated` would be the wrong answer, not a rounder one.
    for (const id of ['fam-pa-forever', 'fam-pa-open']) {
      expect(byId.get(id).unbounded).toBe(true);
      expect(byId.get(id).undated).toBe(false);
      expect(byId.get(id).on_date).toBeNull();
    }
    // An exclusive upper bound is already the exclusive upper: no day added.
    expect(byId.get('fam-pa-excl').on_date).toBe('2099-06-30');
    expect(byId.get('fam-pa-excl').unbounded).toBe(false);
  });

  it('counts an assignment with no date as affected rather than dropping it', async () => {
    // The SQL's `ga.start IS NULL` arm. A booking that cannot be judged against
    // the retirement date is UNDATED -- reported, flagged, and counted -- never
    // dropped, because dropping it is how a retirement claims to strand nothing
    // while stranding whatever it could not read.
    const field = someField();
    await supabase.from('game_assignments').insert({
      id: 'fam-ga-undated',
      organization_id: ORG,
      field_id: field.id,
      start: null,
    });

    const { data } = await supabase.rpc('admin_retire_field', {
      p_organization_id: ORG,
      p_field_id: field.id,
      p_effective_to: '2098-01-01',
      p_confirm: false,
    });
    const undated = data.affected.find((a) => String(a.id) === 'fam-ga-undated');
    expect(undated).toBeDefined();
    expect(undated.kind).toBe('game_assignment');
    expect(undated.on_date).toBeNull();
    // Could not be judged -- NOT "runs forever". Two different answers, and
    // conflating them tells the operator something the data never said.
    expect(undated.undated).toBe(true);
    expect(undated.unbounded).toBe(false);
  });

  it('leaves an assignment that ends before the retirement out of the list', async () => {
    // The negative direction. Without it, an arm that reported every
    // assignment regardless of date would pass every assertion above.
    const field = someField();
    await supabase.from('game_assignments').insert({
      id: 'fam-ga-past',
      organization_id: ORG,
      field_id: field.id,
      start: '2020-01-02T18:00:00Z',
    });
    await supabase.from('practice_assignments').insert({
      id: 'fam-pa-past',
      organization_id: ORG,
      field_id: field.id,
      effective_date_range: '[2019-01-01,2020-06-30]',
    });

    const { data } = await supabase.rpc('admin_retire_field', {
      p_organization_id: ORG,
      p_field_id: field.id,
      p_effective_to: '2098-01-01',
      p_confirm: false,
    });
    const ids = new Set((data.affected || []).map((a) => String(a.id)));
    expect(ids.has('fam-ga-past')).toBe(false);
    expect(ids.has('fam-pa-past')).toBe(false);
  });
});
