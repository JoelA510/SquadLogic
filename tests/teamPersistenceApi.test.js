import test from 'node:test';
import assert from 'node:assert/strict';
import { processTeamPersistenceRequest } from '../src/teamPersistenceApi.js';

const SAMPLE_SNAPSHOT = {
  lastRunId: 'run-456',
  payload: {
    teamRows: [
      { id: 'team-1', division_id: 'u10', name: 'Sharks', coach_id: 'coach-1' },
    ],
    teamPlayerRows: [
      { team_id: 'team-1', player_id: 'player-1', role: 'player', source: 'auto' },
      { team_id: 'team-1', player_id: 'player-2', role: 'player', source: 'auto' },
    ],
  },
};

function buildTransactionStub() {
  const calls = [];
  return {
    calls,
    client: {
      rpc: async (rpcName, args) => {
        calls.push({ table: 'scheduler_runs', rows: [args.run_data] }); // Mocking the capture of run data
        return { data: { success: true }, error: null };
      },
      // Keep transaction for backward compatibility if needed, but RPC is primary now
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
    },
  };
}

test('processTeamPersistenceRequest returns unauthorized when role is missing', async () => {
  const result = await processTeamPersistenceRequest({ requestBody: {}, user: null });

  assert.strictEqual(result.status, 'unauthorized');
  assert.match(result.message, /Authentication required/i);
});

test('processTeamPersistenceRequest returns validation error for null requestBody', async () => {
  const result = await processTeamPersistenceRequest({
    requestBody: null,
    user: { role: 'admin' },
  });

  assert.strictEqual(result.status, 'error');
  assert.match(result.message, /snapshot must be an object/i);
});

test('processTeamPersistenceRequest blocks when overrides are pending', async () => {
  const result = await processTeamPersistenceRequest({
    requestBody: { snapshot: SAMPLE_SNAPSHOT, overrides: [{ status: 'pending' }], runMetadata: { seasonSettingsId: 7 } },
    user: { role: 'admin' },
  });

  assert.strictEqual(result.status, 'blocked');
  assert.match(result.message, /pending review/);
});

test('processTeamPersistenceRequest persists snapshot after validation and auth', async () => {
  const now = new Date('2024-08-10T10:30:00Z');
  const { client, calls } = buildTransactionStub();

  const result = await processTeamPersistenceRequest({
    supabaseClient: client,
    requestBody: {
      snapshot: SAMPLE_SNAPSHOT,
      overrides: [],
      runMetadata: {
        seasonSettingsId: 55,
        createdBy: 'user-99',
        parameters: { trigger: 'edge-function' },
      },
    },
    user: { role: 'admin' },
    now,
  });

  assert.strictEqual(result.status, 'success');
  assert.strictEqual(result.syncedAt, now.toISOString());
  assert.strictEqual(result.updatedTeams, 1);
  assert.strictEqual(result.updatedPlayers, 2);
  assert.strictEqual(result.runId, SAMPLE_SNAPSHOT.lastRunId);

  const schedulerRunCall = calls.find((call) => call.table === 'scheduler_runs');
  assert.ok(schedulerRunCall, 'scheduler_runs upsert should be invoked');
  assert.strictEqual(schedulerRunCall.rows[0].season_settings_id, 55);
  assert.strictEqual(schedulerRunCall.rows[0].created_by, 'user-99');
});

test('processTeamPersistenceRequest surfaces validation errors', async () => {
  const result = await processTeamPersistenceRequest({
    requestBody: { snapshot: null, runMetadata: { seasonSettingsId: 99 } },
    user: { role: 'admin' },
  });

  assert.strictEqual(result.status, 'error');
  assert.match(result.message, /snapshot must be an object/i);
});

test('processTeamPersistenceRequest surfaces persistence errors', async () => {
  const result = await processTeamPersistenceRequest({
    supabaseClient: {
      rpc: async () => {
        throw new Error('transaction failed');
      },
    },
    requestBody: { snapshot: SAMPLE_SNAPSHOT, runMetadata: { seasonSettingsId: 22 } },
    user: { role: 'admin' },
  });

  assert.strictEqual(result.status, 'error');
  assert.match(result.message, /transaction failed/);
});
