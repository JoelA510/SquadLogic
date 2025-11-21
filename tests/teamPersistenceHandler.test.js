import test from 'node:test';
import assert from 'node:assert/strict';
import {
  handleTeamPersistence,
  evaluateOverrides,
  normalizeSnapshot,
  authorizeTeamPersistenceRequest,
  persistTeamSnapshotTransactional,
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

test('authorizeTeamPersistenceRequest extracts role from app_metadata', () => {
  const user = { app_metadata: { role: 'scheduler' } };

  const result = authorizeTeamPersistenceRequest({ user });
  assert.deepEqual(result, { status: 'authorized', role: 'scheduler' });
});

test('authorizeTeamPersistenceRequest normalizes user role (trim and lowercase)', () => {
  const user = { role: '  Admin  ' };

  const result = authorizeTeamPersistenceRequest({ user });
  assert.deepEqual(result, { status: 'authorized', role: 'admin' });
});

test('authorizeTeamPersistenceRequest normalizes allowedRoles', () => {
  const user = { role: 'scheduler' };

  const result = authorizeTeamPersistenceRequest({
    user,
    allowedRoles: ['  Scheduler  '],
  });
  assert.deepEqual(result, { status: 'authorized', role: 'scheduler' });
});

test('authorizeTeamPersistenceRequest throws if allowedRoles contains invalid values', () => {
  assert.throws(
    () =>
      authorizeTeamPersistenceRequest({
        allowedRoles: ['admin', ''],
      }),
    /must be a non-empty string/i,
  );

  assert.throws(
    () =>
      authorizeTeamPersistenceRequest({
        allowedRoles: ['admin', null],
      }),
    /must be a non-empty string/i,
  );
});

test('persistTeamSnapshotTransactional upserts teams, players, and scheduler_runs in one transaction', async () => {
  const calls = [];
  const supabaseClient = {
    transaction: async (callback) => {
      const tx = {
        from: (table) => ({
          upsert: async (rows) => {
            calls.push({ table, rows });
            return { data: rows, error: null };
          },
        }),
      };

      const result = await callback(tx);
      calls.push({ committed: true });
      return result;
    },
  };

  const now = new Date('2024-08-01T12:00:00Z');
  const result = await persistTeamSnapshotTransactional({
    supabaseClient,
    snapshot: SAMPLE_SNAPSHOT,
    runMetadata: {
      seasonSettingsId: 42,
      parameters: { trigger: 'admin-dashboard' },
      metrics: { updatedPlayers: 3 },
      results: { summary: 'ok' },
      startedAt: '2024-08-01T11:59:00Z',
      completedAt: '2024-08-01T12:00:00Z',
      createdBy: 'user-123',
    },
    now,
  });

  const tableOrder = calls.map((call) => call.table).filter(Boolean);
  assert.deepEqual(tableOrder.sort(), ['teams', 'team_players', 'scheduler_runs'].sort());

  const schedulerRunUpsert = calls.find((call) => call.table === 'scheduler_runs');
  assert(schedulerRunUpsert, 'expected scheduler_runs upsert call');
  assert.strictEqual(schedulerRunUpsert.rows[0].id, SAMPLE_SNAPSHOT.lastRunId);
  assert.strictEqual(schedulerRunUpsert.rows[0].season_settings_id, 42);
  assert.strictEqual(schedulerRunUpsert.rows[0].run_type, 'team');
  assert.strictEqual(schedulerRunUpsert.rows[0].status, 'completed');
  assert.strictEqual(schedulerRunUpsert.rows[0].created_by, 'user-123');
  assert.strictEqual(schedulerRunUpsert.rows[0].completed_at, '2024-08-01T12:00:00.000Z');

  assert.deepEqual(result, {
    status: 'success',
    syncedAt: now.toISOString(),
    runId: SAMPLE_SNAPSHOT.lastRunId,
    updatedTeams: 2,
    updatedPlayers: 3,
    results: {
      teams: SAMPLE_SNAPSHOT.payload.teamRows,
      teamPlayers: SAMPLE_SNAPSHOT.payload.teamPlayerRows,
      schedulerRuns: schedulerRunUpsert.rows,
    },
  });
  assert(calls.some((call) => call.committed), 'transaction should commit');
});

test('persistTeamSnapshotTransactional requires a transaction-capable client and season settings id', async () => {
  await assert.rejects(
    () =>
      persistTeamSnapshotTransactional({
        supabaseClient: {},
        snapshot: SAMPLE_SNAPSHOT,
        runMetadata: { seasonSettingsId: 99 },
      }),
    /transaction with a callback is required/,
  );

  const stubClient = {
    transaction: async (callback) =>
      callback({
        from: () => ({
          upsert: async () => ({ data: [], error: null }),
        }),
      }),
  };

  await assert.rejects(
    () =>
      persistTeamSnapshotTransactional({
        supabaseClient: stubClient,
        snapshot: SAMPLE_SNAPSHOT,
        runMetadata: {},
      }),
    /seasonSettingsId is required/,
  );
});
