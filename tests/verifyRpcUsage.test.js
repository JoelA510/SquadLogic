import test from 'node:test';
import assert from 'node:assert/strict';
import { persistTeamSnapshotTransactional } from '../packages/core/src/teamPersistenceHandler.js';
import { persistPracticeSnapshotTransactional } from '../packages/core/src/practicePersistenceHandler.js';
import { persistGameSnapshotTransactional } from '../packages/core/src/gamePersistenceHandler.js';

function createMockClient() {
    let rpcCalled = false;
    let transactionCalled = false;
    return {
        rpc: async (name, args) => {
            rpcCalled = true;
            return { data: { success: true }, error: null };
        },
        from: () => ({
            insert: async () => ({ data: [], error: null }),
            upsert: async () => ({ data: [], error: null }),
        }),
        // Mock transaction to see if it gets called
        transaction: async () => {
            transactionCalled = true;
            return { data: [], error: null };
        },
        wasRpcCalled: () => rpcCalled,
        wasTransactionCalled: () => transactionCalled,
    };
}

test('persistTeamSnapshotTransactional uses RPC', async () => {
    const client = createMockClient();
    await persistTeamSnapshotTransactional({
        supabaseClient: client,
        snapshot: { payload: { teamRows: [], teamPlayerRows: [] } },
    });
    assert.equal(client.wasRpcCalled(), true, 'Should call RPC');
    assert.equal(client.wasTransactionCalled(), false, 'Should NOT call client-side transaction');
});

test('persistPracticeSnapshotTransactional uses RPC', async () => {
    const client = createMockClient();
    await persistPracticeSnapshotTransactional({
        supabaseClient: client,
        snapshot: { lastRunId: 'run-1', payload: { assignmentRows: [] } },
        now: new Date(),
    });
    assert.equal(client.wasRpcCalled(), true, 'Should call RPC');
    assert.equal(client.wasTransactionCalled(), false, 'Should NOT call client-side transaction');
});

test('persistGameSnapshotTransactional uses RPC', async () => {
    const client = createMockClient();
    await persistGameSnapshotTransactional({
        supabaseClient: client,
        snapshot: { lastRunId: 'run-1', payload: { assignmentRows: [] } },
        now: new Date(),
    });
    assert.equal(client.wasRpcCalled(), true, 'Should call RPC');
    assert.equal(client.wasTransactionCalled(), false, 'Should NOT call client-side transaction');
});
