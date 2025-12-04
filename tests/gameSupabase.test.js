import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGameAssignmentRows, persistGameAssignments } from '../src/gameSupabase.js';

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
      slot_id: 'slot-1',
      start: '2024-08-10T16:00:00.000Z',
      end: '2024-08-10T17:00:00.000Z',
      field_id: 'field-a',
      home_team_id: 'team-1',
      away_team_id: 'team-2',
      run_id: 'run-abc',
    },
  ]);
});

test('buildGameAssignmentRows validates inputs and ordering', () => {
  assert.throws(() => buildGameAssignmentRows({ assignments: null }), /assignments must be an array/);
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
    /end must be after start/,
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
    /must be a string/,
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
          },
        ],
      }),
    /division cannot be empty/,
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
          slot_id: 'slot-1',
          start: '2024-08-10T16:00:00.000Z',
          end: '2024-08-10T17:00:00.000Z',
          field_id: null,
          home_team_id: 'team-1',
          away_team_id: 'team-2',
          run_id: 'run-xyz',
        },
      ],
    },
  ]);

  assert.deepEqual(result, [
    {
      division: 'U10',
      week_index: 1,
      slot_id: 'slot-1',
      start: '2024-08-10T16:00:00.000Z',
      end: '2024-08-10T17:00:00.000Z',
      field_id: null,
      home_team_id: 'team-1',
      away_team_id: 'team-2',
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
          slot_id: 'slot-1',
          start: '2024-08-10T16:00:00.000Z',
          end: '2024-08-10T17:00:00.000Z',
          field_id: null,
          home_team_id: 'team-1',
          away_team_id: 'team-2',
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
    /Failed to persist game assignments: insert failed/,
  );

  await assert.rejects(
    () => persistGameAssignments({ assignments: [] }),
    /supabaseClient with a from\(\) method is required/,
  );
});
