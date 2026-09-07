/**
 * **What a field delete does to each booking, against the mock client.**
 *
 * `tests/fieldLifecycleScenarios.test.js` runs the shared table and pins the
 * RPC's OUTCOME -- refused or not, how many bookings, which disposition words.
 * This file pins what the mock then does to the ROWS, which is schema
 * behaviour rather than RPC outcome: `game_slots`, `practice_slots` and
 * `field_blackouts` cascade with the field, while `game_assignments.field_id`
 * and `practice_assignments.field_id` are set null so the booking survives
 * with its venue visibly gone.
 *
 * It matters because the mock is what the E2E suite and 8.4 PR 3's UI are
 * built against. Before this, a confirmed delete removed the field and its
 * blackouts here and left everything else pointing at it -- so the operation
 * looked harmless in the mock and lost a schedule in Postgres.
 *
 * The expected dispositions are read out of the migration rather than written
 * down here, for the same reason `fieldLifecycleRpcs.test.js` reads the kind
 * literals: a list copied from one of two arms agrees with whichever it was
 * copied from.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, it } from 'vitest';

import { getMockData, mockSupabase as supabase } from '../frontend/src/lib/mockSupabaseClient.js';

const ORG = 'org-1';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * `kind -> disposition` as the migration declares it, parsed out of
 * `admin_delete_field`'s union.
 *
 * Two shapes of arm. A CASCADE-only arm states one word outright. An arm whose
 * table reaches the field BOTH ways -- SET NULL on `field_id` and CASCADE
 * through its slot columns -- decides per row in a CASE and is reported here as
 * `'per-row'`, because "what happens to a game assignment" has no single
 * answer. The first version of this parse took the first literal it found and
 * called that the table's disposition, which is exactly the flat per-table
 * reading the RPC had to stop making.
 *
 * @returns {Record<string, string>}
 */
const migrationDispositions = () => {
  const sql = readFileSync(
    path.join(REPO_ROOT, 'supabase/migrations/20260907000000_field_delete_booking_guard.sql'),
    'utf8'
  );
  // **The producer, not the RPC.** The union moved into `public.field_bookings`
  // so retire and delete give one answer; reading the RPC body would now match
  // no table name at all and pass by looking at nothing.
  const start = sql.indexOf('CREATE OR REPLACE FUNCTION public.field_bookings(');
  const end = sql.indexOf('REVOKE ALL ON FUNCTION public.field_bookings');
  expect(start, 'the shared enumerator moved; this parse is stale').toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const arms = sql.slice(start, end).split('UNION ALL');
  // The meta-assertion. A parse that found no arms would produce an empty map
  // and every comparison below would pass by comparing nothing with nothing.
  expect(arms.length).toBe(5);
  /** @type {Record<string, string>} */
  const map = {};
  for (const arm of arms) {
    const kind = /'([a-z_]+)'::text/.exec(arm);
    expect(kind, `an arm of the union names no kind: ${arm.slice(0, 80)}`).not.toBeNull();
    // An arm whose `cascades` is a flat `true` is always destroyed; one that
    // asks `EXISTS (... its slot ...)` decides per row. Reporting the latter as
    // a single word is the defect a review found: `field_id` is SET NULL, so
    // "unassigned" was told to the operator for every row the scheduler writes.
    map[kind[1]] = /EXISTS \(SELECT 1 FROM public\./.test(arm) ? 'per-row' : 'deleted';
  }
  return map;
};

const setMockSession = (userId) => {
  sessionStorage.setItem('__MOCK_SESSION__', JSON.stringify({ user: { id: userId } }));
};

/** The first field of the seeded org, whatever it is. */
const someField = () => getMockData('fields').find((f) => String(f.organization_id) === ORG);

/**
 * Every shape a field delete can reach, with ids this file can look up again.
 *
 * Both assignment shapes are seeded: the FREE-STANDING one (a `field_id` and no
 * slot) and the SLOT-LINKED one that `persist_game_schedule` and
 * `persist_practice_schedule` actually write. Only the first survives a delete;
 * asserting survival on that shape alone -- which this file did first -- is a
 * test forging state the production path never produces.
 */
const seedEveryKind = async (fieldId) => {
  // **One insert per TABLE, not per row.** Every `.insert()` on the mock client
  // runs `getDB()` -- which deep-copies the seed and re-merges sessionStorage --
  // and then `saveDB()`, which stringifies the whole database again. Measured:
  // one insert costs ~1.3ms and ten cost ~274ms, because each call pays for the
  // whole store. Seeding row by row made this file's third test 2.7s of a 5s
  // budget, which passes unloaded and fails on a busy CI runner -- and would
  // then be called flaky. The mock's `insert()` already accepts an array.
  await supabase.from('game_slots').insert([
    {
      id: 'guard-game-slot',
      organization_id: ORG,
      field_id: fieldId,
      slot_date: '2099-06-01',
      week_index: 1,
    },
  ]);
  await supabase.from('practice_slots').insert([
    {
      id: 'guard-practice-slot',
      organization_id: ORG,
      field_id: fieldId,
      day_of_week: 'mon',
      start_time: '18:00',
      end_time: '19:30',
      valid_until: '2099-06-30',
    },
  ]);
  // `games` carries no field_id at all and dies with the slot, score included.
  await supabase
    .from('games')
    .insert([{ id: 'guard-game', organization_id: ORG, game_slot_id: 'guard-game-slot' }]);
  await supabase.from('game_assignments').insert([
    // Free-standing: a field_id and no slot behind it. Unassigned by SET NULL.
    {
      id: 'guard-game-assignment',
      organization_id: ORG,
      field_id: fieldId,
      start: '2099-06-01T18:00:00.000Z',
      week_index: 1,
    },
    // Slot-linked: what `persist_game_schedule` writes. Destroyed by cascade.
    {
      id: 'guard-game-assignment-slotted',
      organization_id: ORG,
      field_id: fieldId,
      game_slot_id: 'guard-game-slot',
      slot_id: 'guard-game-slot',
      start: '2099-06-01T18:00:00.000Z',
      week_index: 1,
    },
    // **Reachable ONLY through its slot.** `field_id` is nullable, so a row can
    // carry a slot on this field and no field_id at all -- the shape an earlier
    // delete's SET NULL leaves behind. The cascade does not consult field_id.
    {
      id: 'guard-game-assignment-slot-only',
      organization_id: ORG,
      field_id: null,
      game_slot_id: 'guard-game-slot',
      start: '2099-06-01T18:00:00.000Z',
      week_index: 1,
    },
  ]);
  await supabase.from('practice_assignments').insert([
    {
      id: 'guard-practice-assignment',
      organization_id: ORG,
      team_id: 'guard-team',
      field_id: fieldId,
      effective_date_range: '[2099-01-01,2099-12-31]',
    },
    {
      id: 'guard-practice-assignment-slotted',
      organization_id: ORG,
      team_id: 'guard-team',
      field_id: fieldId,
      practice_slot_id: 'guard-practice-slot',
      slot_id: 'guard-practice-slot',
      effective_date_range: '[2099-01-01,2099-12-31]',
    },
  ]);

  // Every seed landed. A seed that silently failed would turn a refusal case
  // into an unbooked one, and it would pass for entirely the wrong reason.
  // One snapshot per table rather than one lookup per row, for the same reason
  // the inserts are batched.
  for (const [table, ids] of [
    ['game_slots', ['guard-game-slot']],
    ['practice_slots', ['guard-practice-slot']],
    ['games', ['guard-game']],
    [
      'game_assignments',
      ['guard-game-assignment', 'guard-game-assignment-slotted', 'guard-game-assignment-slot-only'],
    ],
    ['practice_assignments', ['guard-practice-assignment', 'guard-practice-assignment-slotted']],
  ]) {
    const rows = getMockData(table);
    for (const id of ids) {
      expect(
        rows.find((r) => String(r.id) === id),
        `${id} did not land in ${table}`
      ).toBeDefined();
    }
  }
};

/**
 * One read of the whole mock database, indexed by table and id.
 *
 * `getMockData` re-derives the store on every call, so asserting row by row
 * pays for the entire database once per assertion. These tests make ~20 such
 * reads each; taking one snapshot after the operation is both faster and more
 * honest, since every assertion then describes the SAME moment rather than
 * twenty successive ones.
 *
 * @param {string[]} tables
 */
const snapshot = (tables) => {
  /** @type {Record<string, Map<string, any>>} */
  const byTable = {};
  for (const table of tables) {
    byTable[table] = new Map(getMockData(table).map((row) => [String(row.id), row]));
  }
  return {
    /** @param {string} table @param {string} id */
    row: (table, id) => byTable[table]?.get(String(id)),
    /** @param {string} table */
    all: (table) => [...(byTable[table]?.values() ?? [])],
  };
};

const AFFECTED_TABLES = [
  'fields',
  'game_slots',
  'practice_slots',
  'games',
  'game_assignments',
  'practice_assignments',
  'field_blackouts',
  'field_subunits',
  'field_availability_profiles',
];

describe('field delete guard :: the mock agrees with the migration about consequences', () => {
  beforeEach(() => {
    sessionStorage.clear();
    delete window.__MOCK_DB__;
    setMockSession('mock-admin-id');
  });

  it('declares the disposition the migration declares, per row where it must', async () => {
    const field = someField();
    await seedEveryKind(field.id);

    const { data, error } = await supabase.rpc('admin_delete_field', {
      p_organization_id: ORG,
      p_field_id: field.id,
    });
    expect(error).toBeNull();
    expect(data.deleted).toBe(false);

    const expected = migrationDispositions();
    expect(Object.keys(expected).sort()).toEqual([
      'game',
      'game_assignment',
      'game_slot',
      'practice_assignment',
      'practice_slot',
    ]);
    // The two assignment tables must be the per-row ones, and the other three
    // must not be -- otherwise a migration that went back to a flat answer
    // would still satisfy the loop below.
    expect(expected.game_assignment).toBe('per-row');
    expect(expected.practice_assignment).toBe('per-row');
    expect(expected.game_slot).toBe('deleted');
    expect(expected.practice_slot).toBe('deleted');
    expect(expected.game).toBe('deleted');

    const byId = new Map(data.affected.map((row) => [String(row.id), row]));
    const seen = new Set();
    for (const row of data.affected) {
      expect(
        expected[row.kind],
        `${row.kind} is not a kind the migration enumerates`
      ).toBeDefined();
      if (expected[row.kind] !== 'per-row') {
        expect(row.disposition, `${row.kind} disposition`).toBe(expected[row.kind]);
      }
      seen.add(row.kind);
    }
    expect([...seen].sort()).toEqual([
      'game',
      'game_assignment',
      'game_slot',
      'practice_assignment',
      'practice_slot',
    ]);

    // **The per-row half, on both shapes of the same table.** A slot-linked
    // assignment is destroyed by the slot cascade; a free-standing one keeps
    // its row and loses its venue. Reporting one word for the table promises
    // the operator a survival that does not happen for anything the scheduler
    // wrote.
    expect(byId.get('guard-game-assignment-slotted').disposition).toBe('deleted');
    // Named at all, and named as destroyed -- an enumeration filtering on
    // field_id alone would omit it entirely and the operator would lose a
    // booking nobody warned them about.
    expect(
      byId.get('guard-game-assignment-slot-only'),
      'an assignment reachable only through its slot was not enumerated'
    ).toBeDefined();
    expect(byId.get('guard-game-assignment-slot-only').disposition).toBe('deleted');
    expect(byId.get('guard-game-assignment').disposition).toBe('unassigned');
    expect(byId.get('guard-practice-assignment-slotted').disposition).toBe('deleted');
    expect(byId.get('guard-practice-assignment').disposition).toBe('unassigned');
  });

  it('writes nothing at all when it refuses', async () => {
    const field = someField();
    await seedEveryKind(field.id);
    await supabase.rpc('admin_delete_field', { p_organization_id: ORG, p_field_id: field.id });

    const after = snapshot(AFFECTED_TABLES);
    expect(after.row('fields', field.id)).toBeDefined();
    for (const [table, id] of [
      ['game_slots', 'guard-game-slot'],
      ['practice_slots', 'guard-practice-slot'],
      ['games', 'guard-game'],
      ['game_assignments', 'guard-game-assignment'],
      ['game_assignments', 'guard-game-assignment-slotted'],
      ['game_assignments', 'guard-game-assignment-slot-only'],
      ['practice_assignments', 'guard-practice-assignment'],
      ['practice_assignments', 'guard-practice-assignment-slotted'],
    ]) {
      expect(after.row(table, id), `${id} was destroyed by a REFUSED delete`).toBeDefined();
    }
    expect(after.row('game_assignments', 'guard-game-assignment').field_id).toBe(field.id);
    expect(after.row('practice_assignments', 'guard-practice-assignment').field_id).toBe(field.id);
  });

  it('destroys what it said it would destroy, and unassigns the rest', async () => {
    const field = someField();
    await seedEveryKind(field.id);
    await supabase.rpc('admin_create_field_blackout', {
      p_organization_id: ORG,
      p_location_id: null,
      p_field_id: field.id,
      p_blackout_from: '2099-08-01',
      p_blackout_until: '2099-08-31',
    });
    expect(getMockData('field_blackouts').length).toBe(1);

    const { data } = await supabase.rpc('admin_delete_field', {
      p_organization_id: ORG,
      p_field_id: field.id,
      p_confirm: true,
    });
    expect(data.deleted).toBe(true);

    // One read of the world after the delete: every assertion below then
    // describes the same moment.
    const after = snapshot(AFFECTED_TABLES);
    expect(after.row('fields', field.id)).toBeUndefined();

    // **The report and the effect, checked against each other.** Every row the
    // RPC called `deleted` must be gone and every row it called `unassigned`
    // must still be there without a venue. Reading the expectation out of the
    // payload rather than restating it here is what makes a wrong report fail:
    // the RPC cannot be graded against its own restatement.
    const affected = data.affected;
    expect(affected.length).toBeGreaterThanOrEqual(8);
    const TABLE_FOR_KIND = {
      game_slot: 'game_slots',
      practice_slot: 'practice_slots',
      game: 'games',
      game_assignment: 'game_assignments',
      practice_assignment: 'practice_assignments',
    };
    let destroyed = 0;
    let kept = 0;
    for (const row of affected) {
      const table = TABLE_FOR_KIND[row.kind];
      expect(table, `no table known for kind ${row.kind}`).toBeDefined();
      const survivor = after.row(table, row.id);
      if (row.disposition === 'deleted') {
        expect(survivor, `${row.kind} ${row.id} was reported deleted and survived`).toBeUndefined();
        destroyed += 1;
      } else {
        expect(
          survivor,
          `${row.kind} ${row.id} was reported unassigned and vanished`
        ).toBeDefined();
        expect(survivor.field_id, `${row.kind} ${row.id} kept its venue`).toBeNull();
        kept += 1;
      }
    }
    // Both outcomes were exercised: a run where everything was destroyed would
    // satisfy the loop while saying nothing about the SET NULL half.
    expect(destroyed).toBeGreaterThan(0);
    expect(kept).toBeGreaterThan(0);

    // Blackouts cascade too, and nothing anywhere still points at the field.
    expect(after.all('field_blackouts')).toHaveLength(0);
    for (const table of AFFECTED_TABLES.filter((t) => t !== 'fields')) {
      const dangling = after.all(table).filter((r) => String(r.field_id) === String(field.id));
      expect(dangling, `${table} still points at the deleted field`).toHaveLength(0);
    }
  });
});
