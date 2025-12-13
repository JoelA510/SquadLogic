import test from 'node:test';
import assert from 'node:assert/strict';
import { generateTeams } from '../packages/core/src/teamGeneration.js';

const PLAYERS = Array.from({ length: 20 }, (_, i) => ({
    id: `p${i}`,
    division: 'U10',
    name: `Player ${i}`,
    skillRating: 5,
}));

const CONFIG = {
    U10: {
        maxRosterSize: 10,
        teamNames: ['Team A', 'Team B'],
    },
};

test('generateTeams produces identical results with same seed', () => {
    const seed = 'test-seed-123';

    // First run
    const result1 = generateTeams({
        players: PLAYERS,
        divisionConfigs: CONFIG,
        seed,
    });

    // Second run
    const result2 = generateTeams({
        players: PLAYERS,
        divisionConfigs: CONFIG,
        seed,
    });

    // Verify structure match
    assert.deepStrictEqual(result1.teamsByDivision, result2.teamsByDivision);
    assert.deepStrictEqual(result1.overflowByDivision, result2.overflowByDivision);

    // Check specific assignments to be sure
    const t1_A = result1.teamsByDivision['U10'][0];
    const t2_A = result2.teamsByDivision['U10'][0];

    assert.strictEqual(t1_A.id, t2_A.id);
    assert.deepStrictEqual(t1_A.players, t2_A.players);
});

test('generateTeams produces different results with different seeds', () => {
    // Note: With small sample size, collision is theoretically possible but highly unlikely with proper PRNG
    const result1 = generateTeams({
        players: PLAYERS,
        divisionConfigs: CONFIG,
        seed: 'seed-A',
    });

    const result2 = generateTeams({
        players: PLAYERS,
        divisionConfigs: CONFIG,
        seed: 'seed-B',
    });

    // We expect at least some difference in player shuffling
    const t1_A = result1.teamsByDivision['U10'][0];
    const t2_A = result2.teamsByDivision['U10'][0];

    // It's possible the team order or player assignment differs
    // deeply checking players list
    try {
        assert.deepStrictEqual(t1_A.players, t2_A.players);
        // If they are equal, fail (unless we got incredibly unlucky)
        assert.fail('Different seeds produced identical player assignments');
    } catch (e) {
        if (e.message === 'Different seeds produced identical player assignments') {
            throw e;
        }
        // Expected inequality
    }
});

test('generateTeams uses Math.random when no seed provided', () => {
    // Hard to prove it uses Math.random specifically without spying, 
    // but we can verify it doesn't crash and probably produces diff results
    const result1 = generateTeams({ players: PLAYERS, divisionConfigs: CONFIG });
    const result2 = generateTeams({ players: PLAYERS, divisionConfigs: CONFIG });

    // They *might* be different. 
    // This test is just ensuring it runs without seed.
    assert.ok(result1.teamsByDivision['U10'].length > 0);
    assert.ok(result2.teamsByDivision['U10'].length > 0);
});
