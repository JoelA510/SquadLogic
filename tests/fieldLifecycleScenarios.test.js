/**
 * **The shared scenario table, run against the mock client.**
 *
 * `tests/fixtures/fieldLifecycleScenarios.json` is the single statement of what
 * the lifecycle and blackout RPCs must do. This file executes it against the
 * mock; `scripts/dbharness/scenarios.py` executes the SAME file against
 * Postgres from `npm run test:db:local`. Neither side is asserted against the
 * other -- both are asserted against the table -- so a fix that lands on one
 * implementation and not the other fails on the side it missed.
 *
 * That is the gap round 3 found. Round 2 fixed `admin_retire_field` and
 * `admin_unretire_field` in the SQL; both fixes were absent from the mock, and
 * one of them was CERTIFIED by a passing test asserting the wrong outcome. The
 * kind-literal contract test could not have caught it: literals are text in one
 * file, behaviour is PL/pgSQL on one side and JavaScript on the other.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, it } from 'vitest';

import { getMockData, mockSupabase as supabase } from '../frontend/src/lib/mockSupabaseClient.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const TABLE = JSON.parse(
  readFileSync(path.join(REPO_ROOT, 'tests/fixtures/fieldLifecycleScenarios.json'), 'utf8')
);

const ORG = 'org-1';

/** Today, as the mock computes it, so an offset here matches one in the SQL. */
const today = () => new Date().toISOString().slice(0, 10);

/**
 * An offset in days from today, as `YYYY-MM-DD`. `null` stays null.
 *
 * @param {number|null} offset
 * @returns {string|null}
 */
const dateAt = (offset) => {
  if (offset === null || offset === undefined) return null;
  const d = new Date(`${today()}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};

/**
 * A refusal, checked against the SQLSTATE the table names.
 *
 * This side used to accept ANY error as a valid refusal while `scenarios.py`
 * restricted the class and explicitly excluded `insufficient_privilege` and
 * `no_data_found`. The mock returned codeless errors, so five of the nine
 * blackout cases could have stopped exercising their constraint -- refused as
 * "Field not found in organization" -- and stayed green forever. One contract,
 * stated once in the table, read by both runners.
 *
 * @param {{ code?: string, message?: string }|null} error
 * @param {{ id: string, expect: { sqlstate?: string } }} scenario
 */
const expectRefusal = (error, scenario) => {
  expect(error, `${scenario.id}: expected a refusal and the call succeeded`).not.toBeNull();
  // Every refusal scenario names its SQLSTATE, so a scenario that forgot to is
  // a table defect rather than a free pass.
  expect(scenario.expect.sqlstate, `${scenario.id}: names no expected sqlstate`).toBeTruthy();
  expect(error.code, `${scenario.id}: refused as "${error.message}"`).toBe(
    scenario.expect.sqlstate
  );
};

const setMockSession = (userId) => {
  sessionStorage.setItem('__MOCK_SESSION__', JSON.stringify({ user: { id: userId } }));
};

let seq = 0;
/** A field in the seeded org, put into `before` state without going through an RPC. */
const fieldInState = async (before) => {
  seq += 1;
  const id = `scenario-field-${seq}`;
  const template = getMockData('fields').find((f) => String(f.organization_id) === ORG);
  expect(template).toBeDefined();
  await supabase.from('fields').insert({
    id,
    organization_id: ORG,
    location_id: template.location_id,
    name: `Scenario Pitch ${seq}`,
    active: before.active,
    effective_to: dateAt(before.effectiveTo),
  });
  const row = getMockData('fields').find((f) => String(f.id) === id);
  // The seeding really produced the state the scenario is about. Without this a
  // scenario whose `before` never landed would assert against whatever the
  // insert happened to do, and pass for the wrong reason.
  expect(row.active).toBe(before.active);
  expect(row.effective_to ?? null).toBe(dateAt(before.effectiveTo));
  return row;
};

/**
 * The mock table each booking kind lives in, and a row shaped like one.
 *
 * The map is here rather than in the scenario table because it is SEEDING
 * knowledge -- how to make a booking of each kind exist -- and both runners
 * need their own. What is shared is the OUTCOME the table states.
 *
 * Every switch over a union throws on the value it does not know: a scenario
 * naming a fifth booking kind must stop the run rather than quietly seed
 * nothing and then pass a refusal case by counting zero.
 */
/**
 * How many days out each kind is seeded when the scenario does not say.
 *
 * **A scenario can override this with `bookingOffset`**, which is how the
 * retirement BOUNDARY became data rather than something the two runners agreed
 * about privately: `bookingOffset === args.effectiveTo` is a booking on the last
 * usable day, `effectiveTo + 1` is the first one stranded, and the fixture
 * states which of those refuses.
 */
const DEFAULT_BOOKING_OFFSET = {
  game_slot: 30,
  game_assignment: 30,
  practice_slot: 60,
  practice_assignment: 60,
  scheduled_game: 30,
  scheduled_practice: 60,
  availability_profile: 45,
};

const BOOKING_SEEDS = {
  game_slot: (id, fieldId, at) => [
    'game_slots',
    { id, organization_id: ORG, field_id: fieldId, slot_date: dateAt(at), week_index: 1 },
  ],
  game_assignment: (id, fieldId, at) => [
    'game_assignments',
    {
      id,
      organization_id: ORG,
      field_id: fieldId,
      start: `${dateAt(at)}T18:00:00.000Z`,
      week_index: 1,
    },
  ],
  practice_slot: (id, fieldId, at) => [
    'practice_slots',
    {
      id,
      organization_id: ORG,
      field_id: fieldId,
      day_of_week: 'mon',
      start_time: '18:00',
      end_time: '19:30',
      valid_until: dateAt(at),
    },
  ],
  practice_assignment: (id, fieldId, at) => [
    'practice_assignments',
    {
      id,
      organization_id: ORG,
      team_id: 'scenario-team',
      field_id: fieldId,
      // `]` on the upper bound: the range covers `at` itself, so its LAST DAY
      // is `at` -- the value the boundary cases compare against effectiveTo.
      effective_date_range: `[${dateAt(0)},${dateAt(at)}]`,
    },
  ],
  // **The sixth kind (LIVE-3).** `available_until` is the date the producer
  // judges against, and both date columns are NOT NULL in Postgres, so the
  // mock writes both rather than leaving `available_from` for the schema to
  // default -- there is no default, and a row the database would refuse is a
  // row the two runners cannot be compared on.
  availability_profile: (id, fieldId, at) => [
    'field_availability_profiles',
    {
      id,
      organization_id: ORG,
      field_id: fieldId,
      season_label: 'Scenario Season',
      location: 'Scenario Park',
      field_name: 'Scenario Pitch',
      available_from: dateAt(0),
      available_until: dateAt(at),
    },
  ],
};

/**
 * Composite kinds: the shapes the persistence RPCs actually write.
 *
 * `persist_game_schedule` writes `game_slot_id` and `slot_id` on every
 * assignment, and both are ON DELETE CASCADE to `game_slots` -- so a real
 * scheduled game is DESTROYED by a field delete, not unassigned. Seeding only
 * the free-standing shape, as the first version of these scenarios did, tests
 * a row the production path never produces.
 *
 * Each entry seeds several rows and declares how many the RPC must report.
 */
const COMPOSITE_SEEDS = {
  scheduled_game: (id, fieldId, at) => [
    [
      'game_slots',
      {
        id: `${id}-slot`,
        organization_id: ORG,
        field_id: fieldId,
        slot_date: dateAt(at),
        week_index: 1,
      },
    ],
    [
      'game_assignments',
      {
        id: `${id}-assignment`,
        organization_id: ORG,
        field_id: fieldId,
        game_slot_id: `${id}-slot`,
        slot_id: `${id}-slot`,
        start: `${dateAt(at)}T18:00:00.000Z`,
        week_index: 1,
      },
    ],
    ['games', { id: `${id}-game`, organization_id: ORG, game_slot_id: `${id}-slot` }],
  ],
  scheduled_practice: (id, fieldId, at) => [
    [
      'practice_slots',
      {
        id: `${id}-slot`,
        organization_id: ORG,
        field_id: fieldId,
        day_of_week: 'mon',
        start_time: '18:00',
        end_time: '19:30',
        valid_until: dateAt(at),
      },
    ],
    [
      'practice_assignments',
      {
        id: `${id}-assignment`,
        organization_id: ORG,
        team_id: 'scenario-team',
        field_id: fieldId,
        practice_slot_id: `${id}-slot`,
        slot_id: `${id}-slot`,
        effective_date_range: `[${dateAt(0)},${dateAt(at)}]`,
      },
    ],
  ],
};

/**
 * Seed one booking of each named kind onto a field, and prove each landed.
 *
 * A seed that silently failed would turn a refusal case into an unbooked one
 * and it would pass for the wrong reason -- the field would delete, the
 * assertion would be about nothing, and the guard could be gone.
 *
 * @param {string} fieldId
 * @param {string[]} kinds
 * @returns {Promise<Array<{ kind: string, table: string, id: string }>>}
 */
const seedBookings = async (fieldId, kinds, bookingOffset) => {
  const seeded = [];
  for (const kind of kinds) {
    const id = `${fieldId}-${kind}`;
    const at = bookingOffset ?? DEFAULT_BOOKING_OFFSET[kind];
    if (at === undefined) throw new Error(`no default offset for booking kind "${kind}"`);
    // Composite kinds first: `scheduled_game` is three rows, not one.
    const composite = COMPOSITE_SEEDS[kind];
    if (composite !== undefined) {
      for (const [tableName, row] of composite(id, fieldId, at)) {
        await supabase.from(tableName).insert(row);
        const landed = getMockData(tableName).find((r) => String(r.id) === String(row.id));
        expect(landed, `${kind} seed did not land in ${tableName}`).toBeDefined();
        seeded.push({ kind, table: tableName, id: String(row.id) });
      }
      continue;
    }
    const build = BOOKING_SEEDS[kind];
    if (build === undefined) throw new Error(`unknown booking kind "${kind}"`);
    const [tableName, row] = build(id, fieldId, at);
    await supabase.from(tableName).insert(row);
    const landed = getMockData(tableName).find((r) => String(r.id) === id);
    expect(landed, `${kind} seed did not land in ${tableName}`).toBeDefined();
    expect(String(landed.field_id)).toBe(String(fieldId));
    seeded.push({ kind, table: tableName, id });
  }
  return seeded;
};

describe('scenario table :: the table itself', () => {
  it('holds scenarios, and every one is shaped like a scenario', () => {
    // The meta-assertion. A table that failed to parse, or that lost its
    // entries, would make every `it.each` below run zero cases and the file
    // would pass green having asserted nothing at all.
    expect(TABLE.fieldScenarios.length).toBe(37);
    expect(TABLE.blackoutScenarios.length).toBe(14);
    expect(TABLE.estateScenarios.length).toBe(14);
    const all = [...TABLE.fieldScenarios, ...TABLE.blackoutScenarios, ...TABLE.estateScenarios];
    expect(all.length).toBe(65);
    for (const scenario of all) {
      expect(typeof scenario.id).toBe('string');
      expect(scenario.why.length).toBeGreaterThan(10);
      expect(scenario.expect).toBeTypeOf('object');
      expect(typeof scenario.expect.ok).toBe('boolean');
      // A refusal without a named SQLSTATE would be checked by neither runner
      // beyond "some error happened", which is the hole this closes.
      if (!scenario.expect.ok) {
        expect(scenario.expect.sqlstate, `${scenario.id}`).toMatch(/^[0-9A-Z]{5}$/);
      }
    }
    // Every field case that is expected to succeed states the audit phases it
    // must leave behind. Both runners read this rather than each hard-coding
    // ['before','after'] -- which was fine while every accepted call had those
    // two, and is wrong now that a REFUSED delete records `refused` instead.
    for (const scenario of TABLE.fieldScenarios) {
      if (!scenario.expect.ok) continue;
      expect(scenario.expect.auditPhases, `${scenario.id}: names no audit phases`).toBeInstanceOf(
        Array
      );
      expect(scenario.expect.auditPhases.length).toBeGreaterThan(0);
    }
    expect(new Set(all.map((s) => s.id)).size).toBe(all.length);
  });

  it('covers both outcomes on both halves, so neither is all-accept', () => {
    // A table of nothing but successes would be satisfied by an RPC that never
    // refuses; a table of nothing but refusals by one that never works.
    const outcomes = (list) => new Set(list.map((s) => s.expect.ok));
    expect(outcomes(TABLE.blackoutScenarios)).toEqual(new Set([true, false]));
    // **Both halves, now.** The field half used to be all-accept, which is why
    // `expect.ok` could go unread there without anything noticing.
    expect(outcomes(TABLE.fieldScenarios)).toEqual(new Set([true, false]));
    // ... and it exercises both ACTIVITY outcomes as well.
    const activities = new Set(
      TABLE.fieldScenarios
        .filter((s) => s.expect.ok && s.rpc !== 'admin_delete_field')
        .map((s) => s.expect.active)
    );
    expect(activities).toEqual(new Set([true, false]));
  });

  it('exercises both blackout RPCs, and both outcomes of the edit', () => {
    // **The blackout half had no `rpc` key at all until 8.4 gap A.** Naming the
    // set here means dropping the edit cases fails loudly rather than shrinking
    // the suite quietly -- the same reason the field half names its three.
    expect(new Set(TABLE.blackoutScenarios.map((s) => s.rpc))).toEqual(
      new Set(['admin_create_field_blackout', 'admin_update_field_blackout'])
    );
    const edits = TABLE.blackoutScenarios.filter((s) => s.rpc === 'admin_update_field_blackout');
    // Accepted AND refused. All-refused would be satisfied by an RPC that never
    // edits; all-accepted by one with no guard at all.
    expect(new Set(edits.map((s) => s.expect.ok))).toEqual(new Set([true, false]));
    // ... and the two refusals that must stay DIFFERENT answers are both here.
    // One code for both is the conflation the 0A000 branch exists to remove.
    expect(new Set(edits.filter((s) => !s.expect.ok).map((s) => s.expect.sqlstate))).toEqual(
      new Set(['23514', '0A000', 'P0002'])
    );
    // ... and both time directions are demanded: a window that loses its times
    // and one that gains them. Only the first can catch a COALESCE-partial
    // body, and only the second catches one that always writes NULL.
    const accepted = edits.filter((s) => s.expect.ok);
    expect(
      accepted.some((s) => s.seed.startMinutes !== null && s.expect.after.startMinutes === null),
      'no edit case turns a timed window into an all-day one'
    ).toBe(true);
    expect(
      accepted.some((s) => s.seed.startMinutes === null && s.expect.after.startMinutes !== null),
      'no edit case turns an all-day window into a timed one'
    ).toBe(true);
  });

  it('exercises all four estate RPCs, both outcomes, and the two scope discriminators', () => {
    // **A table covering three of the four would say nothing about the fourth
    // while looking complete.** Naming the set means dropping a depth fails
    // loudly rather than shrinking the suite quietly.
    expect(new Set(TABLE.estateScenarios.map((s) => s.rpc))).toEqual(
      new Set([
        'admin_retire_location',
        'admin_unretire_location',
        'admin_retire_field_subunit',
        'admin_unretire_field_subunit',
      ])
    );
    // Accepted AND refused, on both retire arms. All-refused is satisfied by
    // an RPC that never retires; all-accepted by one with no guard at all.
    for (const rpc of ['admin_retire_location', 'admin_retire_field_subunit']) {
      const cases = TABLE.estateScenarios.filter((s) => s.rpc === rpc);
      expect(cases.length, `${rpc} has no cases`).toBeGreaterThan(2);
      expect(new Set(cases.filter((s) => s.expect.ok).map((s) => s.expect.retired))).toEqual(
        new Set([true, false])
      );
    }
    // **The venue discriminator.** At least one case must demand a refusal
    // spanning MORE THAN ONE pitch. Without it the whole table is satisfiable
    // by the field-scoped implementation this migration exists to replace.
    expect(
      TABLE.estateScenarios.some((s) => (s.expect.distinctFields ?? 0) > 1),
      'no case demands that a venue refusal reach more than one pitch'
    ).toBe(true);
    // **The sub-surface discriminator.** At least one case must name the
    // affected rows by id, so a scope widened to the parent pitch is caught by
    // more than a count.
    expect(
      TABLE.estateScenarios.some((s) => (s.expect.affectedIds ?? []).length > 0),
      'no case names the sub-surface bookings by id'
    ).toBe(true);
    // **The containment discriminator.** At least one ACCEPTED retirement must
    // demand that no child carries a date afterwards. An implementation that
    // copied the venue date down passes every count and fails only this.
    expect(
      TABLE.estateScenarios.some(
        (s) =>
          s.rpc === 'admin_retire_location' &&
          s.expect.retired === true &&
          s.expect.childDates === 0
      ),
      'no accepted venue retirement demands that its children stay undated'
    ).toBe(true);
    // Both refusal codes are exercised, and they must stay DIFFERENT answers.
    expect(
      new Set(TABLE.estateScenarios.filter((s) => !s.expect.ok).map((s) => s.expect.sqlstate))
    ).toEqual(new Set(['22023', 'P0002']));
    // Every accepted case names the audit phases it must leave behind, and a
    // refused retirement records `refused` where an accepted one records two.
    for (const scenario of TABLE.estateScenarios) {
      if (!scenario.expect.ok) continue;
      expect(scenario.expect.auditPhases, `${scenario.id}: names no audit phases`).toBeInstanceOf(
        Array
      );
      expect(scenario.expect.auditPhases.length).toBeGreaterThan(0);
    }
    expect(
      new Set(
        TABLE.estateScenarios.filter((s) => s.expect.ok).map((s) => s.expect.auditPhases.join('+'))
      )
    ).toEqual(new Set(['refused', 'after+before']));
  });

  it('exercises all three field RPCs, and both delete outcomes', () => {
    // **A table that covers two of the three RPCs would say nothing about the
    // third while looking complete.** admin_delete_field is the one this PR
    // adds; naming the set here means dropping its cases fails loudly rather
    // than shrinking the suite quietly.
    expect(new Set(TABLE.fieldScenarios.map((s) => s.rpc))).toEqual(
      new Set(['admin_retire_field', 'admin_unretire_field', 'admin_delete_field'])
    );
    const deletes = TABLE.fieldScenarios.filter((s) => s.rpc === 'admin_delete_field');
    // Refused AND accepted. All-refused would be satisfied by an RPC that
    // never deletes; all-accepted by one with no guard at all -- which is the
    // defect this PR exists for.
    expect(new Set(deletes.filter((s) => s.expect.ok).map((s) => s.expect.deleted))).toEqual(
      new Set([true, false])
    );
    // ... and at least one case seeds a booking of every kind the RPC reads,
    // so a union arm that vanished cannot hide behind the other three.
    const seededKinds = new Set(deletes.flatMap((s) => s.bookings ?? []));
    expect(seededKinds).toEqual(
      new Set([
        'game_slot',
        'game_assignment',
        'practice_slot',
        'practice_assignment',
        // The shapes the scheduler writes. Without these the table only ever
        // exercises free-standing assignments, and a per-TABLE disposition --
        // the defect a review found here -- passes every case.
        'scheduled_game',
        'scheduled_practice',
        // LIVE-3's sixth arm. Its FK is CASCADE, so a delete destroys the
        // profile and its blackout windows; before 20260909000000 it was
        // excluded from the guard altogether and this case did not exist.
        'availability_profile',
      ])
    );
    // ... and both disposition words are demanded by at least one case, on a
    // field where both are true at once.
    const mixed = deletes.find((s) => (s.expect.dispositions ?? []).length === 2);
    expect(mixed, 'no case requires both dispositions in one refusal').toBeDefined();
  });
});

/**
 * One edit case, against the mock.
 *
 * **The subject is created through the create RPC**, not inserted, for the same
 * reason `scenarios.py` does it that way: a row this file hand-built could
 * carry a shape the production path never produces, which is how a passing test
 * came to certify a defect in LIVE-1.
 *
 * @param {any} scenario
 * @param {{p_location_id: any, p_field_id: any}} scope
 */
const runBlackoutEdit = async (scenario, scope) => {
  const { data: seeded, error: seedError } = await supabase.rpc('admin_create_field_blackout', {
    p_organization_id: ORG,
    ...scope,
    p_blackout_from: dateAt(scenario.seed.from),
    p_blackout_until: dateAt(scenario.seed.until),
    p_reason: scenario.seed.reason ?? null,
    p_start_minutes: scenario.seed.startMinutes ?? null,
    p_end_minutes: scenario.seed.endMinutes ?? null,
    p_note: scenario.seed.note ?? null,
  });
  // A seed that never landed would turn every assertion below into one about
  // nothing -- and the refusal cases would pass with no window to damage.
  expect(seedError, `${scenario.id}: the window this edit acts on was never seeded`).toBeNull();
  expect(seeded?.id).toBeTruthy();

  // An import-owned window to be refused on. `field_blackout_windows` is
  // FROZEN and has no RPC, which is exactly why the edit path must refuse it,
  // so it is inserted the way the import path would have left it.
  const importWindowId = 'scenario-import-window';
  if (!getMockData('field_blackout_windows').some((w) => String(w.id) === importWindowId)) {
    await supabase.from('field_blackout_windows').insert({
      id: importWindowId,
      organization_id: ORG,
      profile_id: 'scenario-import-profile',
      blackout_from: dateAt(40),
      blackout_until: dateAt(50),
      reason: 'blackout_months',
    });
  }
  const targets = {
    self: seeded.id,
    import: importWindowId,
    missing: 'no-such-blackout-id',
  };
  const target = targets[scenario.target ?? 'self'];
  if (target === undefined) throw new Error(`unknown target "${scenario.target}"`);

  const before = getMockData('field_blackouts').length;
  const { data, error } = await supabase.rpc('admin_update_field_blackout', {
    p_organization_id: ORG,
    p_blackout_id: target,
    p_blackout_from: dateAt(scenario.args.from),
    p_blackout_until: dateAt(scenario.args.until),
    p_reason: scenario.args.reason ?? null,
    p_start_minutes: scenario.args.startMinutes ?? null,
    p_end_minutes: scenario.args.endMinutes ?? null,
    p_note: scenario.args.note ?? null,
  });
  // The row is read back from the table, never from the payload: the payload is
  // what a broken RPC would get wrong.
  const row = getMockData('field_blackouts').find((b) => String(b.id) === String(seeded.id));

  if (!scenario.expect.ok) {
    expectRefusal(error, scenario);
    // A refusal writes NOTHING -- checked on the seeded window, which is the
    // row a half-applied edit would have damaged.
    expect(row.blackout_from).toBe(dateAt(scenario.seed.from));
    expect(row.blackout_until).toBe(dateAt(scenario.seed.until));
    expect(row.start_minutes ?? null).toBe(scenario.seed.startMinutes ?? null);
    expect(getMockData('field_blackouts').length).toBe(before);
    return;
  }

  expect(error).toBeNull();
  // **The id is the whole migration.** A delete-and-re-add returns a new one.
  expect(data?.id).toBe(seeded.id);
  expect(getMockData('field_blackouts').length).toBe(before);
  const after = scenario.expect.after;
  expect(row.blackout_from).toBe(dateAt(after.from));
  expect(row.blackout_until).toBe(dateAt(after.until));
  expect(row.start_minutes ?? null).toBe(after.startMinutes ?? null);
  expect(row.end_minutes ?? null).toBe(after.endMinutes ?? null);
  expect(row.reason).toBe(after.reason);
  expect(row.note ?? null).toBe(after.note ?? null);

  const phases = [
    ...new Set(
      getMockData('audit_log')
        .filter(
          (entry) =>
            String(entry.resource_id) === String(seeded.id) &&
            entry.metadata?.operation === 'admin_update_field_blackout'
        )
        .map((entry) => entry.metadata.phase)
    ),
  ].sort();
  expect(phases).toEqual([...scenario.expect.auditPhases].sort());
};

describe('scenario table :: the mock honours it', () => {
  beforeEach(() => {
    sessionStorage.clear();
    delete window.__MOCK_DB__;
    setMockSession('mock-admin-id');
  });

  it.each(TABLE.fieldScenarios.map((s) => [s.id, s]))('%s', async (_id, scenario) => {
    const field = await fieldInState(scenario.before);
    // `bookings` is absent on the retirement cases and empty on some delete
    // cases; both mean "nothing booked". `?? []` is the only reading that does
    // not turn a missing key into a crash.
    const seeded = await seedBookings(field.id, scenario.bookings ?? [], scenario.bookingOffset);

    // **Every switch over a union throws on the value it does not know.** This
    // side guarded an unknown SCOPE on the blackout half and nothing at all on
    // the field half, while `scenarios.py` guarded both -- an asymmetry PR 2
    // recorded as referred rather than fixed. It matters more now that the
    // field half has three RPCs instead of two: a scenario naming a fourth
    // would otherwise be called with no arguments of its own and score a pass.
    const KNOWN_FIELD_RPCS = ['admin_retire_field', 'admin_unretire_field', 'admin_delete_field'];
    if (!KNOWN_FIELD_RPCS.includes(scenario.rpc)) {
      throw new Error(`unknown rpc "${scenario.rpc}" in scenario "${scenario.id}"`);
    }

    const args = { p_organization_id: ORG, p_field_id: field.id };
    // **The confirmation is passed THROUGH, not coerced.** `Boolean(null)` is
    // `false`, which is the answer the guard is supposed to reach on its own --
    // coercing here would make the runner supply the very behaviour the
    // `*-null-confirm-refused` cases exist to demand of the RPC.
    const confirmArg = 'confirm' in scenario.args ? scenario.args.confirm : false;
    if (scenario.rpc === 'admin_retire_field') {
      args.p_effective_to = dateAt(scenario.args.effectiveTo);
      args.p_confirm = confirmArg;
    }
    if (scenario.rpc === 'admin_delete_field') {
      args.p_confirm = confirmArg;
    }
    // **`expect.ok` is read here, on the field half too.** It was validated for
    // shape on every scenario and read by neither runner for a field case: the
    // JS side asserted `error` null unconditionally and the SQL side had no
    // `ok` branch at all. A field parsed and never read, in the table whose one
    // premise is that both runners read it identically.
    if (scenario.args.foreignOrg) args.p_field_id = 'not-this-orgs-field';

    const { data, error } = await supabase.rpc(scenario.rpc, args);
    if (!scenario.expect.ok) {
      expectRefusal(error, scenario);
      return;
    }
    expect(error).toBeNull();
    expect(data).not.toBeNull();

    const rows = getMockData('fields');
    const after = rows.find((f) => String(f.id) === String(field.id));

    if (scenario.rpc === 'admin_delete_field') {
      // **A refusal is not an error.** admin_delete_field mirrors
      // admin_retire_field: it RETURNS `{deleted:false, ...}`. A runner that
      // only checked `error` would score every refusal as a successful delete,
      // which is exactly what the hook did before this PR.
      expect(data.deleted).toBe(scenario.expect.deleted);
      expect(data.affected_count).toBe(scenario.expect.affectedCount);
      expect((data.affected ?? []).length).toBe(scenario.expect.affectedCount);
      if (scenario.expect.reason !== undefined) {
        expect(data.reason).toBe(scenario.expect.reason);
      }
      if (scenario.expect.dispositions !== undefined) {
        expect([...new Set(data.affected.map((row) => row.disposition))].sort()).toEqual(
          scenario.expect.dispositions
        );
      }
      // **Whether the field survived, read from `fields` by id.** Never from
      // the returned payload: the payload is what a broken RPC would get
      // wrong, so believing it would be checking a claim against itself.
      expect(after === undefined).toBe(!scenario.expect.exists);

      if (!scenario.expect.deleted) {
        // A refusal writes NOTHING. Each seeded booking is looked for in its
        // own table, which a break in the delete path leaves intact.
        for (const booking of seeded) {
          const row = getMockData(booking.table).find((r) => String(r.id) === booking.id);
          expect(row, `${booking.kind} was destroyed by a REFUSED delete`).toBeDefined();
          // `games` reaches the field through its slot and carries no field_id
          // of its own, so only the rows that HAVE one are checked for it --
          // asserting a column that does not exist would fail on the table this
          // whole correction exists to include.
          if ('field_id' in row) expect(String(row.field_id)).toBe(String(field.id));
        }
      }
    } else {
      expect(after.active).toBe(scenario.expect.active);
      expect(after.effective_to ?? null).toBe(dateAt(scenario.expect.effectiveTo));
    }

    // The audit phases the table names for this case. The SQL RPCs audit
    // before AND after; the mock recorded only `after`, and
    // `admin_unretire_field` recorded no `phase` at all -- so an audit reader
    // could not tell an unretire's record from a legacy one. A REFUSED delete
    // records `refused` instead, which is why the expected set comes from the
    // table rather than being written into this file.
    // **The DISTINCT sorted set, because that is what `scenarios.py` compares.**
    // It uses `array_agg(DISTINCT metadata->>'phase' ORDER BY ...)`, so a second
    // `before` row would fail here and pass there: one field of the shared
    // table read at two strictness levels, which makes it two contracts wearing
    // one name. The table is a single source of truth only if both runners
    // interpret every field identically -- and this is the third divergence
    // found in this file, so the rule is now written where the comparison is.
    const phases = [
      ...new Set(
        getMockData('audit_log')
          .filter(
            (row) =>
              String(row.resource_id) === String(field.id) &&
              row.metadata?.operation === scenario.rpc
          )
          .map((row) => row.metadata.phase)
      ),
    ].sort();
    expect(phases).toEqual([...scenario.expect.auditPhases].sort());
  });

  it.each(TABLE.blackoutScenarios.map((s) => [s.id, s]))('%s', async (_id, scenario) => {
    const field = getMockData('fields').find((f) => String(f.organization_id) === ORG);
    const scopes = {
      location: { p_location_id: field.location_id, p_field_id: null },
      field: { p_location_id: null, p_field_id: field.id },
      both: { p_location_id: field.location_id, p_field_id: field.id },
      neither: { p_location_id: null, p_field_id: null },
    };
    const scope = scopes[scenario.scope];
    // Every `switch` over a union throws on the value it does not know. A
    // scenario naming a scope this file has never heard of must stop the run,
    // not quietly test the field-scoped case.
    if (scope === undefined) throw new Error(`unknown scope "${scenario.scope}"`);
    // ... and the same for the RPC, which this half had no key for at all
    // before 8.4 gap A. A second blackout RPC would otherwise have been run as
    // another create, silently, because there was no switch to fall off.
    const KNOWN_BLACKOUT_RPCS = ['admin_create_field_blackout', 'admin_update_field_blackout'];
    if (!KNOWN_BLACKOUT_RPCS.includes(scenario.rpc)) {
      throw new Error(`unknown rpc "${scenario.rpc}" in scenario "${scenario.id}"`);
    }
    if (scenario.rpc === 'admin_update_field_blackout') {
      await runBlackoutEdit(scenario, scope);
      return;
    }

    const before = getMockData('field_blackouts').length;
    const { data, error } = await supabase.rpc('admin_create_field_blackout', {
      p_organization_id: ORG,
      ...scope,
      p_blackout_from: dateAt(scenario.args.from),
      p_blackout_until: dateAt(scenario.args.until),
      p_reason: scenario.args.reason ?? null,
      p_start_minutes: scenario.args.startMinutes ?? null,
      p_end_minutes: scenario.args.endMinutes ?? null,
      p_note: null,
    });

    const after = getMockData('field_blackouts').length;
    if (scenario.expect.ok) {
      expect(error).toBeNull();
      expect(data).not.toBeNull();
      expect(after).toBe(before + 1);
      const phases = getMockData('audit_log')
        .filter((row) => row.metadata?.operation === 'admin_create_field_blackout')
        .map((row) => row.metadata.phase);
      expect(phases).toContain('before');
      expect(phases).toContain('after');
    } else {
      expectRefusal(error, scenario);
      // **Refused means nothing was written.** A refusal that half-applied
      // would be worse than no constraint at all.
      expect(after).toBe(before);
    }
  });
});

/**
 * **The estate a gap B case runs against, rebuilt for every one of them.**
 *
 * One venue, TWO pitches, a sub-surface on the first, and three bookings:
 * a game slot on pitch A at +40, a practice slot on pitch B at +50, and a
 * practice slot NAMING the sub-surface at +60. `practice_slots.field_id` is
 * NOT NULL, so that last one carries pitch A's id as well as the sub-surface's
 * -- which is exactly why the two scopes disagree about it, and the
 * disagreement is what `expect.distinctFields` and `expect.affectedIds` pin.
 *
 * Rebuilt per case rather than shared, because half of these cases WRITE a
 * date and a shared estate would make every later case depend on the order the
 * runner happened to use.
 */
let estateSeq = 0;
const estateInState = async (before) => {
  estateSeq += 1;
  const n = estateSeq;
  const ids = {
    venue: `scenario-venue-${n}`,
    pitchA: `scenario-venue-${n}-pitch-a`,
    pitchB: `scenario-venue-${n}-pitch-b`,
    subunit: `scenario-venue-${n}-sub`,
    pitchASlot: `scenario-venue-${n}-game-a`,
    pitchBSlot: `scenario-venue-${n}-practice-b`,
    subunitSlot: `scenario-venue-${n}-practice-sub`,
  };
  await supabase.from('locations').insert({
    id: ids.venue,
    organization_id: ORG,
    name: `Scenario Estate ${n}`,
    effective_to: dateAt(before.effectiveTo ?? null),
  });
  for (const [id, name] of [
    [ids.pitchA, `Scenario Estate ${n} Pitch A`],
    [ids.pitchB, `Scenario Estate ${n} Pitch B`],
  ]) {
    await supabase
      .from('fields')
      .insert({ id, organization_id: ORG, location_id: ids.venue, name, active: true });
  }
  await supabase.from('field_subunits').insert({
    id: ids.subunit,
    organization_id: ORG,
    field_id: ids.pitchA,
    label: `Scenario Estate ${n} Pitch A North`,
    effective_to: dateAt(before.subunitEffectiveTo ?? null),
  });
  await supabase.from('game_slots').insert({
    id: ids.pitchASlot,
    organization_id: ORG,
    field_id: ids.pitchA,
    slot_date: dateAt(40),
    week_index: 1,
  });
  await supabase.from('practice_slots').insert({
    id: ids.pitchBSlot,
    organization_id: ORG,
    field_id: ids.pitchB,
    day_of_week: 'tue',
    start_time: '18:00',
    end_time: '19:30',
    valid_until: dateAt(50),
  });
  await supabase.from('practice_slots').insert({
    id: ids.subunitSlot,
    organization_id: ORG,
    field_id: ids.pitchA,
    field_subunit_id: ids.subunit,
    day_of_week: 'wed',
    start_time: '17:00',
    end_time: '18:30',
    valid_until: dateAt(60),
  });

  // **Every row of the estate really landed.** A seed that failed would turn a
  // refusal case into an unbooked one: the retirement would proceed, the
  // assertion would be about nothing, and the scope could be wrong.
  const venue = getMockData('locations').find((row) => String(row.id) === ids.venue);
  expect(venue, 'the estate venue was never seeded').toBeDefined();
  expect(venue.effective_to ?? null).toBe(dateAt(before.effectiveTo ?? null));
  const subunit = getMockData('field_subunits').find((row) => String(row.id) === ids.subunit);
  expect(subunit, 'the estate sub-surface was never seeded').toBeDefined();
  expect(subunit.effective_to ?? null).toBe(dateAt(before.subunitEffectiveTo ?? null));
  expect(getMockData('fields').filter((row) => String(row.location_id) === ids.venue)).toHaveLength(
    2
  );
  for (const id of [ids.pitchASlot, ids.pitchBSlot]) {
    expect(
      getMockData(id === ids.pitchASlot ? 'game_slots' : 'practice_slots').some(
        (row) => String(row.id) === id
      ),
      `the estate booking ${id} was never seeded`
    ).toBe(true);
  }
  expect(
    getMockData('practice_slots').find((row) => String(row.id) === ids.subunitSlot)
      ?.field_subunit_id
  ).toBe(ids.subunit);
  return ids;
};

describe('scenario table :: the estate half, against the mock', () => {
  beforeEach(() => {
    sessionStorage.clear();
    delete window.__MOCK_DB__;
    setMockSession('mock-admin-id');
  });

  it.each(TABLE.estateScenarios.map((s) => [s.id, s]))('%s', async (_id, scenario) => {
    const ids = await estateInState(scenario.before ?? {});

    // **Every switch over a union throws on the value it does not know.**
    // A scenario naming a fifth RPC would otherwise be called with the wrong
    // parameters and score a pass.
    const KNOWN = [
      'admin_retire_location',
      'admin_unretire_location',
      'admin_retire_field_subunit',
      'admin_unretire_field_subunit',
    ];
    if (!KNOWN.includes(scenario.rpc)) {
      throw new Error(`unknown rpc "${scenario.rpc}" in scenario "${scenario.id}"`);
    }
    const isVenue = scenario.rpc.endsWith('_location');
    const subjectId =
      scenario.target === 'missing' ? 'no-such-estate-node-id' : ids[isVenue ? 'venue' : 'subunit'];
    const args = isVenue
      ? { p_organization_id: ORG, p_location_id: subjectId }
      : { p_organization_id: ORG, p_field_subunit_id: subjectId };
    if (scenario.rpc.startsWith('admin_retire_')) {
      args.p_effective_to = dateAt(scenario.args.effectiveTo ?? null);
      // Passed THROUGH, not coerced: `Boolean(null)` is the answer the guard
      // has to reach on its own, and coercing here would supply the very
      // behaviour the `*-null-confirm-refused` cases exist to demand.
      args.p_confirm = 'confirm' in scenario.args ? scenario.args.confirm : false;
    }

    const { data, error } = await supabase.rpc(scenario.rpc, args);

    // The node is read back from the TABLE, never from the payload: the
    // payload is what a broken RPC would get wrong.
    const readBack = () =>
      isVenue
        ? getMockData('locations').find((row) => String(row.id) === ids.venue)
        : getMockData('field_subunits').find((row) => String(row.id) === ids.subunit);

    if (!scenario.expect.ok) {
      expectRefusal(error, scenario);
    } else {
      expect(error, `${scenario.id}: expected no error`).toBeNull();
      expect(data?.retired, `${scenario.id}: retired`).toBe(scenario.expect.retired);
      if ('reason' in scenario.expect) {
        expect(data?.reason).toBe(scenario.expect.reason);
      }
      if ('affectedCount' in scenario.expect) {
        expect(data?.affected_count, `${scenario.id}: affected_count`).toBe(
          scenario.expect.affectedCount
        );
        expect(data?.affected ?? []).toHaveLength(scenario.expect.affectedCount);
      }
      // **THE venue assertion.** A field-scoped implementation returns rows
      // from one pitch and fails here, whatever its count says.
      if ('distinctFields' in scenario.expect) {
        const spread = new Set((data?.affected ?? []).map((row) => String(row.field_id)));
        expect(spread.size, `${scenario.id}: pitches named by the refusal`).toBe(
          scenario.expect.distinctFields
        );
      }
      // **THE sub-surface assertion.** Named by id, not just counted: a scope
      // widened to the parent pitch reports the +40 game and is caught twice.
      if ('affectedIds' in scenario.expect) {
        expect((data?.affected ?? []).map((row) => String(row.id)).sort()).toEqual(
          scenario.expect.affectedIds.map((key) => ids[key]).sort()
        );
      }
      if ('containedCount' in scenario.expect) {
        expect(data?.contained_count, `${scenario.id}: contained_count`).toBe(
          scenario.expect.containedCount
        );
        // Two fields plus one sub-surface are always CONTAINED; the count is
        // how many this call newly closes. Reporting the same number for both
        // would hide an `already_retired` arm that never fires.
        expect(data?.contained ?? []).toHaveLength(3);
      }
      const phases = [
        ...new Set(
          getMockData('audit_log')
            .filter(
              (row) =>
                String(row.resource_id) === String(subjectId) &&
                row.metadata?.operation === scenario.rpc
            )
            .map((row) => row.metadata.phase)
        ),
      ].sort();
      expect(phases, `${scenario.id}: audit phases`).toEqual(
        [...scenario.expect.auditPhases].sort()
      );
    }

    // The node's own date, after the call -- asserted on EVERY case including
    // the refusals, because a refusal that wrote the date anyway is the worst
    // outcome of all.
    expect(readBack().effective_to ?? null, `${scenario.id}: the node's own date`).toBe(
      dateAt(scenario.expect.effectiveTo)
    );

    // **Containment, not copy-down.** The number of CHILDREN carrying a date
    // of their own. Only a `before.subunitEffectiveTo` seed can make this
    // non-zero; a venue retirement that pushed its date down makes it 3 and
    // every case with `childDates: 0` fails.
    if ('childDates' in scenario.expect) {
      const dated =
        getMockData('fields').filter(
          (row) => String(row.location_id) === ids.venue && (row.effective_to ?? null) !== null
        ).length +
        getMockData('field_subunits').filter(
          (row) =>
            [ids.pitchA, ids.pitchB].includes(String(row.field_id)) &&
            (row.effective_to ?? null) !== null
        ).length;
      expect(dated, `${scenario.id}: children carrying a date`).toBe(scenario.expect.childDates);
    }
    // Retiring downward writes nothing upward.
    if ('parentDated' in scenario.expect) {
      const parent = getMockData('fields').find((row) => String(row.id) === ids.pitchA);
      expect((parent.effective_to ?? null) !== null, `${scenario.id}: the parent pitch`).toBe(
        scenario.expect.parentDated
      );
    }
  });
});
