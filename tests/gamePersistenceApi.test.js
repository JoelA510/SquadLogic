import test from 'node:test';
import assert from 'node:assert/strict';
import { processGamePersistenceRequest } from '../packages/core/src/gamePersistenceApi.js';

const SAMPLE_SNAPSHOT = {
    lastRunId: 'run-game-789',
    payload: {
        assignmentRows: [
            { slot_id: 'slot-1', home_team_id: 'team-A', away_team_id: 'team-B', week_index: 1 }
        ],
    },
};

function buildTransactionStub() {
    const calls = [];
    return {
        calls,
        client: {
            rpc: async (rpcName, args) => {
                calls.push({ rpcName, args });
                return { data: { success: true }, error: null };
            },
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

test('processGamePersistenceRequest returns unauthorized when role is missing', async () => {
    const result = await processGamePersistenceRequest({ requestBody: {}, user: null });

    assert.strictEqual(result.status, 'unauthorized');
    assert.match(result.message, /Authentication required/i);
});

test('processGamePersistenceRequest blocks when overrides are pending', async () => {
    const result = await processGamePersistenceRequest({
        requestBody: { snapshot: SAMPLE_SNAPSHOT, overrides: [{ status: 'pending' }] },
        user: { role: 'admin' },
    });

    assert.strictEqual(result.status, 'blocked');
    assert.match(result.message, /pending review/);
});

test('processGamePersistenceRequest persists snapshot after validation and auth', async () => {
    const now = new Date('2024-09-15T14:00:00Z');
    const { client, calls } = buildTransactionStub();

    const result = await processGamePersistenceRequest({
        supabaseClient: client,
        requestBody: {
            snapshot: SAMPLE_SNAPSHOT,
            overrides: [],
            runMetadata: {
                seasonSettingsId: 101,
                createdBy: 'user-admin',
            },
        },
        user: { role: 'admin' },
        now,
    });

    assert.strictEqual(result.status, 'success');
    assert.strictEqual(result.syncedAt, now.toISOString());
    assert.strictEqual(result.runId, SAMPLE_SNAPSHOT.lastRunId);

    const rpcCall = calls.find((call) => call.rpcName === 'persist_game_schedule');
    assert.ok(rpcCall, 'persist_game_schedule RPC should be invoked');
    assert.strictEqual(rpcCall.args.run_data.season_settings_id, 101);
    assert.strictEqual(rpcCall.args.run_data.created_by, 'user-admin');
    assert.deepStrictEqual(rpcCall.args.assignments, SAMPLE_SNAPSHOT.payload.assignmentRows);
});

test('processGamePersistenceRequest surfaces persistence errors', async () => {
    const result = await processGamePersistenceRequest({
        supabaseClient: {
            rpc: async () => {
                return { data: null, error: { message: 'DB error' } };
            },
        },
        requestBody: { snapshot: SAMPLE_SNAPSHOT },
        user: { role: 'admin' },
    });

    assert.strictEqual(result.status, 'error');
    assert.match(result.message, /DB error/);
});
