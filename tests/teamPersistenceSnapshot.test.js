import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveAppliedTeamOverrides,
  normalizeManualOverrides,
  normalizeRunHistory,
  prepareTeamPersistenceSnapshot,
} from '../src/teamPersistenceSnapshot.js';

test('prepareTeamPersistenceSnapshot returns payload counts and enriched metadata', () => {
  const teamsByDivision = {
    U8: [
      { id: 'u8-1', name: 'U8 Team 1', coachId: 'coach-1', players: [{ id: 'p1' }, { id: 'p2' }] },
      { id: 'u8-2', name: 'U8 Team 2', coachId: null, players: [{ id: 'p3' }] },
    ],
  };

  const teamOverrides = [
    {
      id: 'override-name',
      teamId: 'u8-1',
      field: 'name',
      value: 'U8 Lightning',
      status: 'applied',
      updatedAt: '2024-07-01T12:00:00Z',
      reason: 'Align with jersey color',
    },
    {
      id: 'override-coach',
      teamId: 'u8-2',
      field: 'coachId',
      value: 'coach-9',
      status: 'pending',
      updatedAt: '2024-07-01T13:00:00Z',
      reason: 'Background check in progress',
    },
  ];

  const manualAssignments = [
    { teamId: 'u8-2', playerId: 'p4', source: 'manual', role: 'captain' },
  ];

  const runHistory = [
    {
      runId: 'run-initial',
      status: 'success',
      triggeredBy: 'scheduler',
      startedAt: '2024-07-01T11:00:00Z',
      updatedTeams: 2,
      updatedPlayers: 3,
      notes: 'Initial allocator output.',
    },
    {
      runId: 'run-dry-run',
      status: 'blocked',
      triggeredBy: 'admin',
      startedAt: '2024-06-30T10:00:00Z',
      updatedTeams: 0,
      updatedPlayers: 0,
      notes: 'Overrides still pending.',
    },
  ];

  const snapshot = prepareTeamPersistenceSnapshot({
    teamsByDivision,
    teamOverrides,
    manualAssignments,
    runHistory,
    lastSyncedAt: '2024-07-01T12:30:00Z',
    runId: 'run-live-sync',
    pendingManualOverrideGoal: 'Clear pending coach approvals before syncing.',
  });

  assert.strictEqual(snapshot.lastRunId, 'run-live-sync');
  assert.strictEqual(snapshot.lastSyncedAt, '2024-07-01T12:30:00Z');
  assert.strictEqual(snapshot.preparedTeamRows, 2);
  assert.strictEqual(snapshot.preparedPlayerRows, 4);
  assert.strictEqual(snapshot.pendingManualOverrideGoal, 'Clear pending coach approvals before syncing.');

  assert.deepEqual(
    snapshot.manualOverrides.map((entry) => ({
      id: entry.id,
      teamId: entry.teamId,
      teamName: entry.teamName,
      status: entry.status,
    })),
    [
      { id: 'override-name', teamId: 'u8-1', teamName: 'U8 Lightning', status: 'applied' },
      { id: 'override-coach', teamId: 'u8-2', teamName: 'U8 Team 2', status: 'pending' },
    ],
  );

  assert.deepEqual(
    snapshot.runHistory.map((entry) => entry.runId),
    ['run-initial', 'run-dry-run'],
  );

  assert.ok(Array.isArray(snapshot.payload.teamRows));
  assert.ok(Array.isArray(snapshot.payload.teamPlayerRows));
  assert.strictEqual(snapshot.payload.teamRows.length, 2);
  assert.strictEqual(snapshot.payload.teamPlayerRows.length, 4);
});

test('normalizeRunHistory validates entries and sorts by startedAt', () => {
  const sorted = normalizeRunHistory([
    { runId: 'b', startedAt: '2024-07-02T00:00:00Z', status: 'success' },
    { runId: 'a', startedAt: '2024-07-03T00:00:00Z', status: 'blocked' },
  ]);

  assert.deepEqual(
    sorted.map((entry) => entry.runId),
    ['a', 'b'],
  );

  assert.throws(() => normalizeRunHistory(null), /runHistory must be an array/);
  assert.throws(() => normalizeRunHistory([null]), /runHistory\[0\] must be an object/);
  assert.throws(() => normalizeRunHistory([{}]), /requires a runId/);
});

test('normalizeManualOverrides validates structure and status', () => {
  const overrides = normalizeManualOverrides(
    [
      { teamId: 't1', field: 'name', value: 'Name A', status: 'applied' },
      { teamId: 't2', field: 'coachId', value: 'coach-1', updatedAt: '2024-07-01T00:00:00Z' },
      { teamId: 't3', field: 'name', value: 'Name C', status: '  APPLIED ' },
      { teamId: 't4', field: 'name', value: 'Name D', status: 0 },
    ],
    new Map([
      ['t1', 'Team One'],
      ['t2', 'Team Two'],
      ['t3', 'Team Three'],
      ['t4', 'Team Four'],
    ]),
  );

  assert.deepEqual(
    overrides.map((entry) => ({ teamId: entry.teamId, status: entry.status, teamName: entry.teamName })),
    [
      { teamId: 't1', status: 'applied', teamName: 'Team One' },
      { teamId: 't2', status: 'pending', teamName: 'Team Two' },
      { teamId: 't3', status: 'applied', teamName: 'Team Three' },
      { teamId: 't4', status: 'pending', teamName: 'Team Four' },
    ],
  );

  assert.throws(() => normalizeManualOverrides('bad'), /manualOverrides must be an array/);
  assert.throws(() => normalizeManualOverrides([{}]), /requires a teamId/);
  assert.throws(() => normalizeManualOverrides([{ teamId: 't3', status: 'unknown' }]), /unsupported status/);
});

test('deriveAppliedTeamOverrides applies only explicit applied overrides', () => {
  const overrides = [
    { teamId: 't1', field: 'name', value: 'Tigers', status: 'applied' },
    { teamId: 't2', field: 'coachId', value: 'coach-9', status: 'pending' },
    { teamId: 't3', field: 'name', value: 'Lions' },
  ];

  const applied = deriveAppliedTeamOverrides(overrides);

  assert.deepEqual(applied, [{ teamId: 't1', name: 'Tigers' }]);
});

test('deriveAppliedTeamOverrides normalizes status casing and whitespace', () => {
  const overrides = [
    { teamId: 't1', field: 'name', value: 'Tigers', status: '  APPLIED ' },
  ];

  const applied = deriveAppliedTeamOverrides(overrides);

  assert.deepEqual(applied, [{ teamId: 't1', name: 'Tigers' }]);
});

test('deriveAppliedTeamOverrides ignores pending overrides', () => {
  const overrides = [
    { teamId: 't1', field: 'name', value: 'Tigers', status: 'applied' },
    { teamId: 't1', field: 'coachId', value: 'coach-9', status: 'pending' },
  ];

  const applied = deriveAppliedTeamOverrides(overrides);

  assert.deepEqual(applied, [{ teamId: 't1', name: 'Tigers' }]);
});

test('deriveAppliedTeamOverrides treats missing status as pending', () => {
  const overrides = [
    { teamId: 't1', field: 'name', value: 'Tigers' },
  ];

  const applied = deriveAppliedTeamOverrides(overrides);

  assert.deepEqual(applied, []);
});
