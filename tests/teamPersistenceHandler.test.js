import test from 'node:test';
import assert from 'node:assert/strict';
import {
  handleTeamPersistence,
  evaluateOverrides,
  normalizeSnapshot,
  authorizeTeamPersistenceRequest,
} from '../src/teamPersistenceHandler.js';

const SAMPLE_SNAPSHOT = {
  lastRunId: 'run-123',
  payload: {
    teamRows: [
      { id: 'team-1', division_id: 'u8', name: 'Tigers', coach_id: null },
      { id: 'team-2', division_id: 'u8', name: 'Lions', coach_id: 'coach-2' },
    ],
    teamPlayerRows: [
      { team_id: 'team-1', player_id: 'player-1', role: 'player', source: 'auto' },
      { team_id: 'team-1', player_id: 'player-2', role: 'player', source: 'auto' },
      { team_id: 'team-2', player_id: 'player-3', role: 'player', source: 'manual' },
    ],
  },
};

test('normalizeSnapshot validates payload shape', () => {
  const normalized = normalizeSnapshot(SAMPLE_SNAPSHOT);

  assert.strictEqual(normalized.teamRows.length, 2);
  assert.strictEqual(normalized.teamPlayerRows.length, 3);
  assert.strictEqual(normalized.runId, 'run-123');

  assert.throws(() => normalizeSnapshot(null), /snapshot must be an object/);
  assert.throws(() => normalizeSnapshot({ payload: null }), /snapshot\.payload must be an object/);
  assert.throws(() => normalizeSnapshot({ payload: { teamRows: {} } }), /teamRows must be an array/);
  assert.throws(
    () =>
      normalizeSnapshot({
        payload: { teamRows: [{ id: '' }], teamPlayerRows: SAMPLE_SNAPSHOT.payload.teamPlayerRows },
      }),
    /requires an id/,
  );
});

test('evaluateOverrides counts pending entries', () => {
  const { pending } = evaluateOverrides([
    { teamId: 't1', status: 'applied' },
    { teamId: 't2', status: 'pending' },
    { teamId: 't3' },
  ]);

  assert.strictEqual(pending, 2);
  assert.throws(() => evaluateOverrides('bad'), /overrides must be an array/);
  assert.throws(() => evaluateOverrides([null]), /overrides\[0\] must be an object/);
});

test('handleTeamPersistence returns success summary when overrides are clear', () => {
  const fixedDate = new Date('2024-07-04T12:00:00Z');

  const result = handleTeamPersistence({ snapshot: SAMPLE_SNAPSHOT, overrides: [], now: fixedDate });

  assert.deepEqual(result, {
    status: 'success',
    message: 'Snapshot validated. Ready for persistence upsert.',
    syncedAt: fixedDate.toISOString(),
    updatedTeams: 2,
    updatedPlayers: 3,
    runId: 'run-123',
  });
});

test('handleTeamPersistence blocks when overrides are pending', () => {
  const result = handleTeamPersistence({
    snapshot: SAMPLE_SNAPSHOT,
    overrides: [{ teamId: 't1', status: 'pending' }],
  });

  assert.strictEqual(result.status, 'blocked');
  assert.strictEqual(result.pendingOverrides, 1);
  assert.match(result.message, /pending review/);
});

test('handleTeamPersistence validates the clock input', () => {
  assert.throws(() => handleTeamPersistence({ snapshot: SAMPLE_SNAPSHOT, now: 'not-a-date' }), /valid Date/);
});

test('authorizeTeamPersistenceRequest enforces allowed roles', () => {
  const baseUser = { id: 'user-1', role: 'admin' };

  const authorized = authorizeTeamPersistenceRequest({ user: baseUser });
  assert.deepEqual(authorized, { status: 'authorized', role: 'admin' });

  const forbidden = authorizeTeamPersistenceRequest({ user: { ...baseUser, role: 'parent' } });
  assert.strictEqual(forbidden.status, 'forbidden');
  assert.match(forbidden.message, /not permitted/);
  assert.strictEqual(forbidden.role, 'parent');

  const missingRole = authorizeTeamPersistenceRequest({ user: { id: 'user-2' } });
  assert.strictEqual(missingRole.status, 'unauthorized');
  assert.match(missingRole.message, /allowed role is required/);

  assert.throws(() => authorizeTeamPersistenceRequest({ allowedRoles: 'admin' }), /allowedRoles must be an array/);
  assert.throws(() => authorizeTeamPersistenceRequest({ allowedRoles: [] }), /at least one role/);
});
