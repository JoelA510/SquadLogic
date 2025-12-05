import test from 'node:test';
import assert from 'node:assert/strict';
import {
    authorizeGamePersistenceRequest,
    handleGamePersistence,
} from '../src/gamePersistenceHandler.js';

test('authorizeGamePersistenceRequest checks role', () => {
    const result = authorizeGamePersistenceRequest({
        user: { role: 'coach' },
        allowedRoles: ['admin'],
    });
    assert.equal(result.status, 'forbidden');
});

test('authorizeGamePersistenceRequest allows admin', () => {
    const result = authorizeGamePersistenceRequest({
        user: { role: 'admin' },
        allowedRoles: ['admin'],
    });
    assert.equal(result.status, 'authorized');
});

test('handleGamePersistence validates snapshot', () => {
    const result = handleGamePersistence({
        snapshot: { lastRunId: 'run-1' },
        overrides: [],
    });
    assert.equal(result.status, 'success');
});
