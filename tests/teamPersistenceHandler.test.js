import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSnapshot } from '../packages/core/src/teamPersistenceHandler.js';

test('normalizeSnapshot validates structure', () => {
    const validSnapshot = {
        lastRunId: 'run-123',
        payload: {
            teamRows: [{ id: 't1' }],
            teamPlayerRows: [{ team_id: 't1', player_id: 'p1' }],
        },
    };

    const result = normalizeSnapshot(validSnapshot);
    assert.equal(result.updatedTeams, 1);
    assert.equal(result.updatedPlayers, 1);
    assert.equal(result.runId, 'run-123');
});

test('normalizeSnapshot throws on missing payload', () => {
    assert.throws(() => normalizeSnapshot({}), /snapshot.payload must be an object/);
});

test('normalizeSnapshot throws on invalid teamRows', () => {
    assert.throws(() => normalizeSnapshot({ payload: { teamRows: 'not-array' } }), /teamRows must be an array/);
});

test('normalizeSnapshot throws on invalid team row', () => {
    const snapshot = {
        payload: {
            teamRows: [{ name: 'No ID' }],
            teamPlayerRows: [],
        },
    };
    assert.throws(() => normalizeSnapshot(snapshot), /requires an id/);
});
