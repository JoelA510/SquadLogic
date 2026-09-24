import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'vitest';
import {
  buildPracticeSlotsFromSupabaseRows,
  expandSupabasePracticeSlots,
  buildPracticeAssignmentRows,
  persistPracticeAssignments,
} from '../packages/core/src/practiceSupabase.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RPC_SIGNATURE = 'CREATE OR REPLACE FUNCTION public.persist_practice_schedule';

/**
 * The migration that defines `persist_practice_schedule` LAST, and its text.
 *
 * Derived from the directory rather than named, for the reason
 * `tests/fieldDeleteGuard.test.js` gives: a hard-coded filename goes on
 * grading the builder against a recordset the database no longer runs.
 *
 * @returns {{ file: string, sql: string }}
 */
function rpcMigration() {
  const dir = path.join(REPO_ROOT, 'supabase/migrations');
  const defining = readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .filter((name) => readFileSync(path.join(dir, name), 'utf8').includes(RPC_SIGNATURE));
  // Migrations run in filename order, so the LAST definition is the live one.
  // An empty list means the RPC was renamed or removed, which has to fail
  // loudly rather than leave the comparison below comparing nothing.
  assert.ok(defining.length > 0, 'no migration defines persist_practice_schedule');
  const file = defining[defining.length - 1];
  return { file, sql: readFileSync(path.join(dir, file), 'utf8') };
}

/**
 * The column names `persist_practice_schedule` declares for its `assignments`
 * payload — the only keys `jsonb_to_recordset` carries into the function.
 * Anything else in a row reaches Postgres and is dropped without a word.
 *
 * @param {string} sql
 * @returns {Set<string>}
 */
function rpcRecordsetColumns(sql) {
  const blocks = [
    ...sql.matchAll(/jsonb_to_recordset\(assignments\)\s+AS\s+raw_assignments\(([^)]*)\)/gi),
  ];
  // The meta-assertion. A regex that stopped matching — a renamed alias, a
  // reformatted declaration — would yield an empty set, and an empty set
  // accepts every key the builder could possibly emit.
  assert.ok(blocks.length > 0, 'no jsonb_to_recordset(assignments) declaration found');

  const perBlock = blocks.map(
    (block) =>
      new Set(
        block[1]
          .split(',')
          .map((entry) => entry.trim().split(/\s+/)[0])
          .filter(Boolean)
      )
  );
  // The RPC declares the recordset more than once (the validation CTE and the
  // write CTE). They must agree, or "declared" has two answers.
  for (const columns of perBlock) {
    assert.deepEqual(
      [...columns].sort(),
      [...perBlock[0]].sort(),
      'the RPC declares two different assignment recordsets'
    );
  }

  const declared = perBlock[0];
  assert.ok(declared.size > 1, 'the recordset parse produced fewer columns than it has');
  assert.ok(declared.has('team_id'), 'the recordset parse did not find team_id; it is stale');
  return declared;
}

describe('buildPracticeSlotsFromSupabaseRows', () => {
  it('normalizes camelCase and snake_case Supabase slot rows', () => {
    const rows = [
      {
        id: 'slot-1',
        day_of_week: 'mon',
        start_time: '18:00',
        end_time: '19:15',
        capacity: 2,
        valid_from: '2024-08-01',
        valid_until: '2024-09-01',
        field_id: 'field-1',
        field_subunit_id: 'field-1A',
        fieldLabel: 'Field 1A',
      },
      {
        slotId: 'slot-2',
        day: 'Thu',
        start: new Date('2024-08-01T00:30:00Z'),
        end: new Date('2024-08-01T01:30:00Z'),
        slotCapacity: 1,
        validFrom: new Date('2024-09-02'),
        validUntil: new Date('2024-10-01'),
        fieldId: 'field-2',
        location: 'Main Complex',
      },
    ];

    const normalized = buildPracticeSlotsFromSupabaseRows(rows);

    assert.deepEqual(normalized, [
      {
        id: 'slot-1',
        day: 'Mon',
        start: '18:00',
        end: '19:15',
        capacity: 2,
        validFrom: '2024-08-01',
        validUntil: '2024-09-01',
        fieldId: 'field-1',
        fieldSubunitId: 'field-1A',
        location: 'Field 1A',
      },
      {
        id: 'slot-2',
        day: 'Thu',
        start: '00:30',
        end: '01:30',
        capacity: 1,
        validFrom: '2024-09-02',
        validUntil: '2024-10-01',
        fieldId: 'field-2',
        fieldSubunitId: null,
        location: 'Main Complex',
      },
    ]);
  });

  it('rejects invalid time ordering', () => {
    const rows = [
      {
        id: 'slot-3',
        day: 'Tue',
        start: '19:00',
        end: '18:00',
        capacity: 1,
        validFrom: '2024-08-01',
        validUntil: '2024-09-01',
      },
    ];

    assert.throws(() => buildPracticeSlotsFromSupabaseRows(rows));
  });

  it('rejects unsupported day values', () => {
    const rows = [
      {
        id: 'slot-1',
        day: 'xyz',
        start: '18:00',
        end: '19:00',
        validFrom: '2024-08-01',
        validUntil: '2024-08-31',
        capacity: 2,
      },
    ];

    assert.throws(() => buildPracticeSlotsFromSupabaseRows(rows), /unsupported day value/i);
  });

  it('rejects invalid time strings', () => {
    const baseRow = {
      id: 'slot-1',
      day: 'Tue',
      validFrom: '2024-08-01',
      validUntil: '2024-08-31',
      capacity: 2,
    };

    assert.throws(
      () => buildPracticeSlotsFromSupabaseRows([{ ...baseRow, start: '25:00', end: '26:00' }]),
      /invalid hour component/i
    );
    assert.throws(
      () => buildPracticeSlotsFromSupabaseRows([{ ...baseRow, start: '10:60', end: '11:00' }]),
      /invalid minute component/i
    );
    assert.throws(
      () => buildPracticeSlotsFromSupabaseRows([{ ...baseRow, start: 'abc', end: '11:00' }]),
      /invalid hour component/i
    );
  });

  it('rejects invalid date strings', () => {
    const rows = [
      {
        id: 'slot-1',
        day: 'Tue',
        start: '18:00',
        end: '19:00',
        validFrom: 'not-a-date',
        validUntil: '2024-08-31',
        capacity: 2,
      },
    ];

    assert.throws(() => buildPracticeSlotsFromSupabaseRows(rows), /not a valid date/i);
  });

  it('rejects invalid capacity values', () => {
    const baseRow = {
      id: 'slot-1',
      day: 'Tue',
      start: '18:00',
      end: '19:00',
      validFrom: '2024-08-01',
      validUntil: '2024-08-31',
    };

    assert.throws(
      () => buildPracticeSlotsFromSupabaseRows([{ ...baseRow, capacity: 0 }]),
      /capacity must be a positive number/i
    );
    assert.throws(
      () => buildPracticeSlotsFromSupabaseRows([{ ...baseRow, capacity: -1 }]),
      /capacity must be a positive number/i
    );
    assert.throws(
      () => buildPracticeSlotsFromSupabaseRows([{ ...baseRow, capacity: 'abc' }]),
      /capacity must be a positive number/i
    );
  });

  it('rejects when validUntil precedes validFrom', () => {
    const rows = [
      {
        id: 'slot-1',
        day: 'Tue',
        start: '18:00',
        end: '19:00',
        validFrom: '2024-09-01',
        validUntil: '2024-08-31',
        capacity: 2,
      },
    ];

    assert.throws(() => buildPracticeSlotsFromSupabaseRows(rows), /validUntil precedes validFrom/i);
  });

  it('accepts Friday and Saturday slots', () => {
    const rows = [
      {
        id: 'slot-fri',
        day: 'Friday',
        start: '18:00',
        end: '19:00',
        validFrom: '2024-08-01',
        validUntil: '2024-08-31',
        capacity: 2,
      },
      {
        id: 'slot-sat',
        day: 'sat',
        start: '09:00',
        end: '10:00',
        validFrom: '2024-08-01',
        validUntil: '2024-08-31',
        capacity: 2,
      },
    ];

    const result = buildPracticeSlotsFromSupabaseRows(rows);

    assert.deepEqual(
      result.map((slot) => ({ id: slot.id, day: slot.day })),
      [
        { id: 'slot-fri', day: 'Fri' },
        { id: 'slot-sat', day: 'Sat' },
      ]
    );
  });

  it('trims field identifiers and normalizes empty to null', () => {
    const rows = [
      {
        id: 'slot-1',
        day: 'Tue',
        start: '18:00',
        end: '19:00',
        validFrom: '2024-08-01',
        validUntil: '2024-08-31',
        capacity: 2,
        fieldId: '  FIELD-1  ',
        fieldSubunitId: '   ',
      },
    ];

    const [slot] = buildPracticeSlotsFromSupabaseRows(rows);

    assert.equal(slot.fieldId, 'FIELD-1');
    assert.equal(slot.fieldSubunitId, null);
  });

  it('requires required fields', () => {
    assert.throws(() => buildPracticeSlotsFromSupabaseRows('nope'));
    assert.throws(() => buildPracticeSlotsFromSupabaseRows([null]));
    assert.throws(() => buildPracticeSlotsFromSupabaseRows([{}]));
  });
});

describe('expandSupabasePracticeSlots', () => {
  it('expands normalized Supabase slots into season-aware effective slots with overrides', () => {
    const rows = [
      {
        id: 'slot-1',
        day: 'Mon',
        start: '17:00',
        end: '18:15',
        capacity: 2,
        validFrom: '2024-08-01',
        validUntil: '2024-10-31',
        seasonOverrides: {
          early: { endTime: '18:00' },
        },
      },
    ];

    const seasonPhases = [
      { id: 'early', startDate: '2024-08-01', endDate: '2024-09-15' },
      { id: 'late', startDate: '2024-09-16', endDate: '2024-10-31' },
    ];

    const expanded = expandSupabasePracticeSlots({ rows, seasonPhases });

    assert.equal(expanded.length, 2);
    assert.deepEqual(
      expanded.map((slot) => ({
        id: slot.id,
        baseSlotId: slot.baseSlotId,
        seasonPhaseId: slot.seasonPhaseId,
        day: slot.day,
        capacity: slot.capacity,
        effectiveFrom: slot.effectiveFrom,
        effectiveUntil: slot.effectiveUntil,
      })),
      [
        {
          id: 'slot-1::early',
          baseSlotId: 'slot-1',
          seasonPhaseId: 'early',
          day: 'Mon',
          capacity: 2,
          effectiveFrom: '2024-08-01',
          effectiveUntil: '2024-09-15',
        },
        {
          id: 'slot-1::late',
          baseSlotId: 'slot-1',
          seasonPhaseId: 'late',
          day: 'Mon',
          capacity: 2,
          effectiveFrom: '2024-09-16',
          effectiveUntil: '2024-10-31',
        },
      ]
    );

    const earlySlot = expanded.find((slot) => slot.seasonPhaseId === 'early');
    const lateSlot = expanded.find((slot) => slot.seasonPhaseId === 'late');

    assert.ok(earlySlot, 'Early phase slot should exist');
    assert.ok(lateSlot, 'Late phase slot should exist');

    assert.equal(earlySlot.start.toISOString(), '2024-08-05T17:00:00.000Z');
    assert.equal(earlySlot.end.toISOString(), '2024-08-05T18:00:00.000Z');
    assert.equal(lateSlot.start.toISOString(), '2024-09-16T17:00:00.000Z');
    assert.equal(lateSlot.end.toISOString(), '2024-09-16T18:15:00.000Z');
  });
});

describe('buildPracticeAssignmentRows', () => {
  const sampleSlots = [
    {
      id: 'slot-1::early',
      baseSlotId: 'slot-1',
      seasonPhaseId: 'early',
      effectiveFrom: '2024-08-01',
      effectiveUntil: '2024-09-15',
    },
    {
      id: 'slot-1::late',
      baseSlotId: 'slot-1',
      seasonPhaseId: 'late',
      effectiveFrom: '2024-09-16',
      effectiveUntil: '2024-10-31',
    },
  ];

  it('builds Supabase-ready practice assignment rows', () => {
    const assignments = [
      { teamId: 'team-1', slotId: 'slot-1::early', source: 'locked' },
      { teamId: 'team-2', slotId: 'slot-1::late', source: 'auto' },
    ];

    const rows = buildPracticeAssignmentRows({ assignments, slots: sampleSlots, runId: 'run-123' });

    assert.deepEqual(rows, [
      {
        team_id: 'team-1',
        practice_slot_id: 'slot-1::early',
        effective_date_range: '[2024-08-01,2024-09-15]',
        source: 'manual',
        run_id: 'run-123',
      },
      {
        team_id: 'team-2',
        practice_slot_id: 'slot-1::late',
        effective_date_range: '[2024-09-16,2024-10-31]',
        source: 'auto',
        run_id: 'run-123',
      },
    ]);
  });

  it('fails when slot metadata is missing', () => {
    assert.throws(
      () =>
        buildPracticeAssignmentRows({
          assignments: [{ teamId: 'team-1', slotId: 'slot-unknown' }],
          slots: sampleSlots,
        }),
      /unknown slotId/i
    );

    assert.throws(
      () =>
        buildPracticeAssignmentRows({
          assignments: [{ teamId: 'team-1', slotId: 'slot-1::early' }],
          slots: [{ id: 'slot-1::early' }],
        }),
      /requires effectiveFrom and effectiveUntil/i
    );
  });

  it('rejects non-array assignments', () => {
    // @ts-expect-error [INVALID_INPUT] - testing intentional invalid input to verify runtime validation logic in javascript-compiled-as-typescript context
    assert.throws(() => buildPracticeAssignmentRows({ assignments: 'bad', slots: [] }), {
      name: 'TypeError',
      message: /assignments must be an array/i,
    });
  });

  it('rejects unsupported assignment sources', () => {
    assert.throws(
      () =>
        buildPracticeAssignmentRows({
          assignments: [{ teamId: 'team-1', slotId: 'slot-1::early', source: 'invalid' }],
          slots: sampleSlots,
        }),
      /unsupported source: invalid/i
    );
  });

  it('rejects duplicate slot ids with index-aware errors', () => {
    assert.throws(
      () =>
        buildPracticeAssignmentRows({
          assignments: [],
          slots: [...sampleSlots, { ...sampleSlots[0], id: sampleSlots[0].id }],
        }),
      /duplicate slot id detected: ".*" at slots\[\d+\]/i
    );
  });

  it('emits practice_slot_id instead of slot_id', () => {
    const rows = buildPracticeAssignmentRows({
      assignments: [{ teamId: 'team-1', slotId: 'slot-1::early', source: 'auto' }],
      slots: sampleSlots,
    });

    assert.deepEqual(rows[0], {
      team_id: 'team-1',
      practice_slot_id: 'slot-1::early',
      effective_date_range: '[2024-08-01,2024-09-15]',
      source: 'auto',
      run_id: null,
    });
  });

  it('emits no key the persistence path cannot receive', () => {
    const { file, sql } = rpcMigration();
    const declared = rpcRecordsetColumns(sql);

    const rows = buildPracticeAssignmentRows({
      assignments: [{ teamId: 'team-1', slotId: 'slot-1::early', source: 'locked' }],
      slots: sampleSlots,
      runId: 'run-123',
    });
    // Meta-assertion on the subject set. Enumerating the keys from a row the
    // builder did not produce would compare nothing with nothing and pass.
    assert.equal(rows.length, 1, 'the builder produced no row to check');
    const emitted = Object.keys(rows[0]);
    assert.ok(emitted.length > 0, 'the row carries no keys to check');

    // `run_id` is the one key outside the recordset, and the exemption is
    // proven rather than asserted: a migration adds it as a real column on
    // `practice_assignments`, which is where `persistPracticeAssignments`
    // writes it directly. Everything else must be a column the RPC declares.
    // (It was the RPC's own migration until 20260924000000 redefined the RPC
    // without re-adding a column that already exists, so the column is looked
    // for across the migration set rather than in the RPC's latest file.)
    //
    // Stated plainly, because the exemption is narrower than it looks: the
    // RPC drops `run_id` like any other undeclared key and fills the column
    // from `run_data` instead, so the only reader of this key is the direct
    // insert — and that function has no caller outside this file today. It
    // stays because it addresses a real column through a real exported API,
    // not because the live path uses it.
    const migrationDir = path.join(REPO_ROOT, 'supabase/migrations');
    const addsRunId = readdirSync(migrationDir)
      .filter((name) => name.endsWith('.sql'))
      .filter((name) =>
        /ALTER TABLE public\.practice_assignments\s+ADD COLUMN IF NOT EXISTS run_id/.test(
          readFileSync(path.join(migrationDir, name), 'utf8')
        )
      );
    assert.ok(
      addsRunId.length > 0,
      'no migration adds practice_assignments.run_id; the exemption below is stale'
    );
    const receivable = new Set([...declared, 'run_id']);

    const orphans = emitted.filter((key) => !receivable.has(key));
    assert.deepEqual(
      orphans,
      [],
      `buildPracticeAssignmentRows emits ${orphans.join(', ')}, which ${file} declares nowhere; ` +
        `jsonb_to_recordset drops undeclared keys silently. Declared: ${[...declared].join(', ')}`
    );
  });
});

describe('persistPracticeAssignments', () => {
  const sampleSlots = [
    {
      id: 'slot-1::early',
      baseSlotId: 'slot-1',
      seasonPhaseId: 'early',
      effectiveFrom: '2024-08-01',
      effectiveUntil: '2024-09-15',
    },
  ];

  it('inserts practice assignments through Supabase client', async () => {
    const calls = [];
    const supabaseClient = {
      from(table) {
        calls.push({ table });
        return {
          insert: async (rows) => {
            calls.push({ rows });
            return { data: rows, error: null };
          },
        };
      },
    };

    const result = await persistPracticeAssignments({
      supabaseClient,
      assignments: [{ teamId: 'team-1', slotId: 'slot-1::early' }],
      slots: sampleSlots,
      runId: 'run-123',
    });

    assert.deepEqual(calls, [
      { table: 'practice_assignments' },
      {
        rows: [
          {
            team_id: 'team-1',
            practice_slot_id: 'slot-1::early',
            effective_date_range: '[2024-08-01,2024-09-15]',
            source: 'auto',
            run_id: 'run-123',
          },
        ],
      },
    ]);

    assert.deepEqual(result, [
      {
        team_id: 'team-1',
        practice_slot_id: 'slot-1::early',
        effective_date_range: '[2024-08-01,2024-09-15]',
        source: 'auto',
        run_id: 'run-123',
      },
    ]);
  });

  it('supports upserts when requested', async () => {
    const calls = [];
    const supabaseClient = {
      from(table) {
        calls.push({ table });
        return {
          upsert: async (rows) => {
            calls.push({ upserted: rows });
            return { data: rows, error: null };
          },
        };
      },
    };

    await persistPracticeAssignments({
      supabaseClient,
      assignments: [{ teamId: 'team-1', slotId: 'slot-1::early' }],
      slots: sampleSlots,
      upsert: true,
    });

    assert.deepEqual(calls, [
      { table: 'practice_assignments' },
      {
        upserted: [
          {
            team_id: 'team-1',
            practice_slot_id: 'slot-1::early',
            effective_date_range: '[2024-08-01,2024-09-15]',
            source: 'auto',
            run_id: null,
          },
        ],
      },
    ]);
  });

  it('skips Supabase writes when there are no assignments', async () => {
    const supabaseClient = {
      from() {
        throw new Error('should not call Supabase when no rows are present');
      },
    };

    const result = await persistPracticeAssignments({
      supabaseClient,
      assignments: [],
      slots: sampleSlots,
    });

    assert.deepEqual(result, []);
  });

  it('surfaces Supabase errors with context', async () => {
    const supabaseClient = {
      from() {
        return {
          insert: async () => ({
            data: null,
            error: { message: 'insert failed' },
          }),
        };
      },
    };

    await assert.rejects(
      () =>
        persistPracticeAssignments({
          supabaseClient,
          assignments: [{ teamId: 'team-1', slotId: 'slot-1::early' }],
          slots: sampleSlots,
        }),
      /Failed to persist practice assignments: insert failed/
    );
  });

  it('validates Supabase client presence', async () => {
    // Null client should throw "from() method is required"
    await assert.rejects(
      () =>
        persistPracticeAssignments({
          supabaseClient: null,
          assignments: [{ teamId: 'team-1', slotId: 'slot-1::early' }],
          slots: sampleSlots,
        }),
      /supabaseClient with a from\(\) method is required/
    );

    // Client whose from() returns a non-object should throw "query builder object"
    await assert.rejects(
      () =>
        persistPracticeAssignments({
          supabaseClient: { from: () => null },
          assignments: [{ teamId: 'team-1', slotId: 'slot-1::early' }],
          slots: sampleSlots,
        }),
      /supabaseClient\.from must return a query builder object/
    );
  });
});
