import test from 'node:test';
import assert from 'node:assert/strict';
import { processPracticePersistenceRequest } from '../packages/core/src/practicePersistenceApi.js';

const SAMPLE_SNAPSHOT = {
    lastRunId: 'run-practice-123',
    payload: {
        assignmentRows: [
            { team_id: 't1', practice_slot_id: 's1' }
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
            // Keep transaction for backward compatibility if needed
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

test('processPracticePersistenceRequest returns unauthorized when role is missing', async () => {
    const result = await processPracticePersistenceRequest({ requestBody: {}, user: null });

    assert.strictEqual(result.status, 'unauthorized');
    assert.match(result.message, /Authentication required/i);
});

test('processPracticePersistenceRequest blocks when overrides are pending', async () => {
    const result = await processPracticePersistenceRequest({
        requestBody: { snapshot: SAMPLE_SNAPSHOT, overrides: [{ status: 'pending' }] },
        user: { role: 'admin' },
    });

    assert.strictEqual(result.status, 'blocked');
    assert.match(result.message, /pending review/);
});

test('processPracticePersistenceRequest persists snapshot after validation and auth', async () => {
    const now = new Date('2024-08-10T10:30:00Z');
    const { client, calls } = buildTransactionStub();

    const result = await processPracticePersistenceRequest({
        supabaseClient: client,
        requestBody: {
            snapshot: SAMPLE_SNAPSHOT,
            overrides: [],
            runMetadata: {
                seasonSettingsId: 55,
                createdBy: 'user-99',
            },
        },
        user: { role: 'admin' },
        now,
    });

    assert.strictEqual(result.status, 'success');
    assert.strictEqual(result.syncedAt, now.toISOString());
    assert.strictEqual(result.runId, SAMPLE_SNAPSHOT.lastRunId);

    const rpcCall = calls.find((call) => call.rpcName === 'persist_practice_schedule');
    assert.ok(rpcCall, 'persist_practice_schedule RPC should be invoked');
    assert.strictEqual(rpcCall.args.run_data.season_settings_id, 55);
    assert.strictEqual(rpcCall.args.run_data.created_by, 'user-99');
    assert.deepStrictEqual(rpcCall.args.assignments, SAMPLE_SNAPSHOT.payload.assignmentRows);
});

test('processPracticePersistenceRequest surfaces persistence errors', async () => {
    const result = await processPracticePersistenceRequest({
        supabaseClient: {
            rpc: async () => {
                return { data: null, error: { message: 'RPC failed' } };
            },
        },
        requestBody: { snapshot: SAMPLE_SNAPSHOT },
        user: { role: 'admin' },
    });

    assert.strictEqual(result.status, 'error');
    assert.match(result.message, /RPC failed/);
});
