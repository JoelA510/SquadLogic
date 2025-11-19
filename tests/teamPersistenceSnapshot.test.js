import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareTeamPersistenceSnapshot } from '../src/teamPersistenceSnapshot.js';

const BASE_TEAMS = {
  U10: [
    {
      id: 'u10-1',
      name: 'U10 Force',
      coachId: 'coach-17',
      players: [
        { id: 'player-1' },
        { id: 'player-2' },
      ],
    },
    {
      id: 'u10-2',
      name: 'U10 Blaze',
      coachId: 'coach-88',
      players: [{ id: 'player-3' }],
    },
  ],
};

test('prepareTeamPersistenceSnapshot produces payloads and normalized snapshot data', () => {
  const { snapshot, payload, teamIdMap } = prepareTeamPersistenceSnapshot({
    teamsByDivision: BASE_TEAMS,
    manualAssignments: [{ teamId: 'u10-1', playerId: 'player-4', role: 'captain' }],
    manualOverrideEntries: [
      {
        id: 'override-2',
        teamId: 'u10-2',
        teamName: 'U10 Blaze',
        field: 'coachId',
        value: 'coach-99',
        status: 'Pending',
        updatedAt: '2024-07-04T09:15:00Z',
        reason: 'Coach paperwork pending',
      },
      {
        id: 'override-1',
        teamId: 'u10-1',
        teamName: 'U10 Force',
        field: 'name',
        value: 'U10 Force – Navy',
        status: 'applied',
        updatedAt: '2024-07-03T10:00:00Z',
        reason: 'Align with jersey color',
      },
    ],
    runHistory: [
      {
        runId: 'run-initial',
        status: 'success',
        triggeredBy: 'scheduler-bot',
        startedAt: '2024-07-03T12:00:00Z',
        completedAt: '2024-07-03T12:02:00Z',
        updatedTeams: 2,
        updatedPlayers: 3,
        notes: 'Seeded initial teams',
      },
      {
        runId: 'run-prep',
        status: 'blocked',
        triggeredBy: 'admin-review',
        startedAt: '2024-07-02T12:00:00Z',
        updatedTeams: 0,
        updatedPlayers: 0,
        notes: 'Missing overrides',
      },
    ],
    runId: 'run-initial',
    lastSyncedAt: '2024-07-03T12:05:00Z',
    pendingManualOverrideGoal: 'Confirm pending overrides before syncing.',
  });

  assert.strictEqual(payload.teamRows.length, 2);
  assert.strictEqual(payload.teamPlayerRows.length, 4);
  assert.strictEqual(snapshot.preparedTeamRows, 2);
  assert.strictEqual(snapshot.preparedPlayerRows, 4);
  assert.strictEqual(snapshot.lastRunId, 'run-initial');
  assert.strictEqual(snapshot.lastSyncedAt, '2024-07-03T12:05:00.000Z');
  assert.strictEqual(snapshot.pendingManualOverrideGoal, 'Confirm pending overrides before syncing.');

  const pendingOverride = snapshot.manualOverrides[0];
  assert.strictEqual(pendingOverride.id, 'override-2');
  assert.strictEqual(pendingOverride.status, 'pending');
  assert.strictEqual(pendingOverride.teamUuid, teamIdMap.get('u10-2'));
  assert.strictEqual(snapshot.overrideCounts.total, 2);
  assert.strictEqual(snapshot.overrideCounts.pending, 1);
  assert.strictEqual(snapshot.overrideCounts.applied, 1);
  assert.deepEqual(snapshot.overrideCounts.byStatus, { pending: 1, applied: 1 });

  assert.strictEqual(snapshot.runHistory[0].runId, 'run-initial');
  assert.strictEqual(snapshot.runHistory[0].status, 'success');
  assert.strictEqual(snapshot.runHistory[1].status, 'blocked');
});

test('prepareTeamPersistenceSnapshot validates override and history inputs', () => {
  assert.throws(
    () =>
      prepareTeamPersistenceSnapshot({
        teamsByDivision: BASE_TEAMS,
        manualOverrideEntries: 'invalid',
      }),
    /manualOverrideEntries must be an array/,
  );

  assert.throws(
    () =>
      prepareTeamPersistenceSnapshot({
        teamsByDivision: BASE_TEAMS,
        manualOverrideEntries: [{ id: 'x', teamId: 'u10-1' }],
      }),
    /manualOverride.field/,
  );

  assert.throws(
    () =>
      prepareTeamPersistenceSnapshot({
        teamsByDivision: BASE_TEAMS,
        runHistory: 'invalid',
      }),
    /runHistory must be an array/,
  );
});
