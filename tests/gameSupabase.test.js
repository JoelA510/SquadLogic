import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  buildGameAssignmentRows,
  persistGameAssignments,
} from '../packages/core/src/gameSupabase.js';

test('buildGameAssignmentRows normalizes scheduler output for Supabase', () => {
  const assignments = [
    {
      division: 'U10',
      weekIndex: 1,
      slotId: 'slot-1',
      start: new Date('2024-08-10T16:00:00Z'),
      end: '2024-08-10T17:00:00Z',
      fieldId: 'field-a',
      homeTeamId: 'team-1',
      awayTeamId: 'team-2',
    },
  ];

  const rows = buildGameAssignmentRows({ assignments, runId: 'run-abc' });

  assert.deepEqual(rows, [
    {
      division: 'U10',
      week_index: 1,
      game_slot_id: 'slot-1',
      slot_id: 'slot-1',
      start: '2024-08-10T16:00:00.000Z',
      end: '2024-08-10T17:00:00.000Z',
      field_id: 'field-a',
      home_team_id: 'team-1',
      away_team_id: 'team-2',
      assignment_source: 'auto',
      run_id: 'run-abc',
    },
  ]);
});

test('buildGameAssignmentRows carries the id of a saved game, and only that', () => {
  const base = {
    division: 'U10',
    weekIndex: 1,
    slotId: 'slot-1',
    start: '2024-08-10T16:00:00Z',
    end: '2024-08-10T17:00:00Z',
    homeTeamId: 'team-1',
    awayTeamId: 'team-2',
  };
  const rows = buildGameAssignmentRows({
    assignments: [
      { ...base, id: '11111111-1111-4111-8111-111111111111' },
      { ...base, id: '', slotId: 'slot-2' },
      { ...base, id: 42, slotId: 'slot-3' },
      { ...base, slotId: 'slot-4' },
    ],
  });
  // A game named by its id is saved in place (20261120010000); an empty, non-string or missing id is no id.
  assert.equal(rows[0].id, '11111111-1111-4111-8111-111111111111');
  assert.equal('id' in rows[1], false);
  assert.equal('id' in rows[2], false);
  assert.equal('id' in rows[3], false);
});

test('buildGameAssignmentRows validates inputs and ordering', () => {
  assert.throws(
    () => buildGameAssignmentRows({ assignments: null }),
    /assignments must be an array/
  );
  assert.throws(
    () =>
      buildGameAssignmentRows({
        assignments: [
          {
            division: 'U10',
            weekIndex: 1,
            slotId: 'slot-1',
            start: '2024-08-10T17:00:00Z',
            end: '2024-08-10T16:00:00Z',
            homeTeamId: 'team-1',
            awayTeamId: 'team-2',
          },
        ],
      }),
    /end must be after start/
  );
  assert.throws(
    () =>
      buildGameAssignmentRows({
        assignments: [
          {
            weekIndex: 1,
            slotId: 'slot-1',
            start: '2024-08-10T16:00:00Z',
            end: '2024-08-10T17:00:00Z',
            homeTeamId: 'team-1',
            awayTeamId: 'team-2',
          },
        ],
      }),
    /must be a string/
  );
  assert.throws(
    () =>
      buildGameAssignmentRows({
        assignments: [
          {
            division: '   ',
            weekIndex: 1,
            slotId: 'slot-1',
            start: '2024-08-10T16:00:00Z',
            end: '2024-08-10T17:00:00Z',
            homeTeamId: 'team-1',
            awayTeamId: 'team-2',
            source: 'invalid',
          },
        ],
      }),
    /division cannot be empty/
  );
  assert.throws(
    () =>
      buildGameAssignmentRows({
        assignments: [
          {
            division: 'U10',
            weekIndex: 1,
            slotId: 'slot-1',
            start: '2024-08-10T16:00:00Z',
            end: '2024-08-10T17:00:00Z',
            homeTeamId: 'team-1',
            awayTeamId: 'team-2',
            source: 'invalid',
          },
        ],
      }),
    /unsupported game assignment source/
  );
});

test('persistGameAssignments inserts rows and returns Supabase payload', async () => {
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

  const assignments = [
    {
      division: 'U10',
      weekIndex: 1,
      slotId: 'slot-1',
      start: '2024-08-10T16:00:00Z',
      end: '2024-08-10T17:00:00Z',
      homeTeamId: 'team-1',
      awayTeamId: 'team-2',
    },
  ];

  const result = await persistGameAssignments({
    supabaseClient,
    assignments,
    runId: 'run-xyz',
  });

  assert.deepEqual(calls, [
    { table: 'game_assignments' },
    {
      rows: [
        {
          division: 'U10',
          week_index: 1,
          game_slot_id: 'slot-1',
          slot_id: 'slot-1',
          start: '2024-08-10T16:00:00.000Z',
          end: '2024-08-10T17:00:00.000Z',
          field_id: null,
          home_team_id: 'team-1',
          away_team_id: 'team-2',
          assignment_source: 'auto',
          run_id: 'run-xyz',
        },
      ],
    },
  ]);

  assert.deepEqual(result, [
    {
      division: 'U10',
      week_index: 1,
      game_slot_id: 'slot-1',
      slot_id: 'slot-1',
      start: '2024-08-10T16:00:00.000Z',
      end: '2024-08-10T17:00:00.000Z',
      field_id: null,
      home_team_id: 'team-1',
      away_team_id: 'team-2',
      assignment_source: 'auto',
      run_id: 'run-xyz',
    },
  ]);
});

test('persistGameAssignments supports upserts and no-op handling', async () => {
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

  await persistGameAssignments({
    supabaseClient,
    assignments: [
      {
        division: 'U10',
        weekIndex: 1,
        slotId: 'slot-1',
        start: '2024-08-10T16:00:00Z',
        end: '2024-08-10T17:00:00Z',
        homeTeamId: 'team-1',
        awayTeamId: 'team-2',
      },
    ],
    upsert: true,
  });

  const noOpClient = {
    from() {
      throw new Error('should not persist empty rows');
    },
  };

  const noRows = await persistGameAssignments({ supabaseClient: noOpClient, assignments: [] });

  assert.deepEqual(noRows, []);
  assert.deepEqual(calls, [
    { table: 'game_assignments' },
    {
      upserted: [
        {
          division: 'U10',
          week_index: 1,
          game_slot_id: 'slot-1',
          slot_id: 'slot-1',
          start: '2024-08-10T16:00:00.000Z',
          end: '2024-08-10T17:00:00.000Z',
          field_id: null,
          home_team_id: 'team-1',
          away_team_id: 'team-2',
          assignment_source: 'auto',
          run_id: null,
        },
      ],
    },
  ]);
});

test('persistGameAssignments surfaces Supabase errors and validates client', async () => {
  const supabaseClient = {
    from() {
      return {
        insert: async () => ({ data: null, error: { message: 'insert failed' } }),
      };
    },
  };

  await assert.rejects(
    () =>
      persistGameAssignments({
        supabaseClient,
        assignments: [
          {
            division: 'U10',
            weekIndex: 1,
            slotId: 'slot-1',
            start: '2024-08-10T16:00:00Z',
            end: '2024-08-10T17:00:00Z',
            homeTeamId: 'team-1',
            awayTeamId: 'team-2',
          },
        ],
      }),
    /Failed to persist game assignments: insert failed/
  );

  const sampleAssignment = [
    {
      division: 'U10',
      weekIndex: 1,
      slotId: 'slot-1',
      start: '2024-08-10T16:00:00Z',
      end: '2024-08-10T17:00:00Z',
      homeTeamId: 'team-1',
      awayTeamId: 'team-2',
    },
  ];

  // Null client should throw "from() method is required"
  await assert.rejects(
    () => persistGameAssignments({ supabaseClient: null, assignments: sampleAssignment }),
    /supabaseClient with a from\(\) method is required/
  );

  // Client whose from() returns a non-object should throw "query builder object"
  await assert.rejects(
    () =>
      persistGameAssignments({
        supabaseClient: { from: () => null },
        assignments: sampleAssignment,
      }),
    /supabaseClient\.from must return a query builder object/
  );
});
