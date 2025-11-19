import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTeamRows,
  buildTeamPlayerRows,
  persistTeamPlayers,
  persistTeams,
} from '../src/teamSupabase.js';

test('buildTeamRows normalizes generator output and applies overrides', () => {
  const teamsByDivision = {
    U10: [
      { id: 'u10-1', name: 'U10 Team 01', coachId: 'coach-1', players: [] },
      { id: 'u10-2', name: 'U10 Team 02', coachId: null, players: [] },
    ],
  };

  const { rows: teamRows, teamIdMap } = buildTeamRows({
    teamsByDivision,
    divisionIdMap: { U10: 'uuid-u10' },
    teamOverrides: [
      { teamId: 'u10-2', name: 'Renamed', coachId: '  coach-override  ' },
    ],
    runId: 'run-123',
  });

  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  assert.strictEqual(teamIdMap.size, 2);
  ['u10-1', 'u10-2'].forEach((generatorId) => {
    const dbId = teamIdMap.get(generatorId);
    assert.match(dbId, uuidRegex);
  });

  const sortedRows = [...teamRows].sort((a, b) => a.name.localeCompare(b.name));
  const expectedRows = [
    {
      id: teamIdMap.get('u10-1'),
      division_id: 'uuid-u10',
      name: 'U10 Team 01',
      coach_id: 'coach-1',
      run_id: 'run-123',
    },
    {
      id: teamIdMap.get('u10-2'),
      division_id: 'uuid-u10',
      name: 'Renamed',
      coach_id: 'coach-override',
      run_id: 'run-123',
    },
  ].sort((a, b) => a.name.localeCompare(b.name));

  assert.deepEqual(sortedRows, expectedRows);
});

test('buildTeamPlayerRows merges manual assignments and enforces validation', () => {
  const teamsByDivision = {
    U12: [
      {
        id: 'u12-1',
        name: 'U12 Team 01',
        coachId: null,
        players: [
          { id: 'player-1' },
          { id: 'player-2' },
        ],
      },
    ],
  };

  const teamIdMap = new Map([['u12-1', 'mapped-u12-1']]);

  const rows = buildTeamPlayerRows({
    teamsByDivision,
    manualAssignments: [
      { teamId: 'u12-1', playerId: 'player-2', source: 'manual', role: 'captain' },
      { teamId: 'u12-1', playerId: 'player-3', source: 'locked' },
    ],
    runId: 'run-321',
    teamIdMap,
  });

  assert.deepEqual(
    rows.sort((a, b) => a.player_id.localeCompare(b.player_id)),
    [
      {
        team_id: 'mapped-u12-1',
        player_id: 'player-1',
        role: 'player',
        source: 'auto',
        run_id: 'run-321',
      },
      {
        team_id: 'mapped-u12-1',
        player_id: 'player-2',
        role: 'captain',
        source: 'manual',
        run_id: 'run-321',
      },
      {
        team_id: 'mapped-u12-1',
        player_id: 'player-3',
        role: 'player',
        source: 'manual',
        run_id: 'run-321',
      },
    ],
  );

  assert.throws(() => buildTeamPlayerRows({ teamsByDivision: null }), /teamsByDivision must be an object/);
  assert.throws(
    () =>
      buildTeamPlayerRows({
        teamsByDivision,
        manualAssignments: [{ teamId: 'u12-1', playerId: '   ' }],
      }),
    /manualAssignments.playerId cannot be empty/,
  );
});

test('persistTeams inserts rows via Supabase client and supports upserts', async () => {
  const calls = [];
  const supabaseClient = {
    from(table) {
      calls.push({ table });
      return {
        upsert: async (rows) => {
          calls.push({ rows });
          return { data: rows, error: null };
        },
      };
    },
  };

  const teamsByDivision = { U8: [{ id: 'u8-1', name: 'U8A', players: [] }] };

  const { data: result, teamIdMap } = await persistTeams({
    supabaseClient,
    teamsByDivision,
    upsert: true,
  });

  const dbTeamId = teamIdMap.get('u8-1');

  assert.deepEqual(calls, [
    { table: 'teams' },
    {
      rows: [
        {
          id: dbTeamId,
          division_id: 'U8',
          name: 'U8A',
          coach_id: null,
          run_id: null,
        },
      ],
    },
  ]);
  assert.deepEqual(result, [
    {
      id: dbTeamId,
      division_id: 'U8',
      name: 'U8A',
      coach_id: null,
      run_id: null,
    },
  ]);
});

test('persistTeamPlayers inserts rows via Supabase client', async () => {
  const calls = [];
  const supabaseClient = {
    from(table) {
      calls.push({ table });
      if (table === 'teams') {
        return {
          insert: async (rows) => {
            calls.push({ table, rows });
            return { data: rows, error: null };
          },
        };
      }
      return {
        insert: async (rows) => {
          calls.push({ table, rows });
          return { data: rows, error: null };
        },
      };
    },
  };

  const teamsByDivision = {
    U9: [
      { id: 'u9-1', name: 'U9 Team 1', coachId: 'coach-1', players: [{ id: 'p1' }] },
    ],
  };

  const { teamIdMap } = await persistTeams({ supabaseClient, teamsByDivision, upsert: false });

  const result = await persistTeamPlayers({
    supabaseClient,
    teamsByDivision,
    manualAssignments: [{ teamId: 'u9-1', playerId: 'p2', source: 'manual' }],
    teamIdMap,
  });

  const sortFn = (a, b) => a.player_id.localeCompare(b.player_id);
  const mappedTeamId = teamIdMap.get('u9-1');
  const expectedRows = [
    { team_id: mappedTeamId, player_id: 'p1', role: 'player', source: 'auto', run_id: null },
    { team_id: mappedTeamId, player_id: 'p2', role: 'player', source: 'manual', run_id: null },
  ];

  const tableCalls = calls.filter((call) => call.table && !call.rows);
  assert.deepEqual(
    tableCalls.map((call) => call.table),
    ['teams', 'team_players'],
  );

  const teamRowsCall = calls.find((call) => call.table === 'teams' && call.rows);
  const teamPlayerRowsCall = calls.find(
    (call) => call.table === 'team_players' && call.rows,
  );

  assert(teamRowsCall, 'expected teams insert call');
  assert(teamPlayerRowsCall, 'expected team_players insert call');

  assert.strictEqual(teamRowsCall.rows[0].id, mappedTeamId);
  assert.deepEqual(teamPlayerRowsCall.rows.sort(sortFn), expectedRows.sort(sortFn));
  assert.deepEqual(result.sort(sortFn), expectedRows.sort(sortFn));
});
