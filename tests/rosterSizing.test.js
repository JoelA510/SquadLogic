import { describe, it } from 'vitest';
import assert from 'node:assert/strict';

import { resolveTeamCount } from '../packages/core/src/teamGeneration.js';
import {
  assessTeamCount,
  calculateMaxRosterSize,
  buildOverridesFromSupabaseRows,
  deriveDivisionRosterConfigs,
  parsePlayableCount,
} from '../packages/core/src/rosterSizing.js';

describe('parsePlayableCount', () => {
  it('parses standard lowercase formats', () => {
    assert.equal(parsePlayableCount('7v7'), 7);
  });

  it('handles uppercase and whitespace', () => {
    assert.equal(parsePlayableCount(' 9V9 '), 9);
  });

  it('returns null for a format that names no NvN (D2), and still refuses a non-string', () => {
    assert.equal(parsePlayableCount('solo'), null);
    assert.equal(parsePlayableCount('Minis (U5 intro)'), null);
    // @ts-expect-error -- a number is the input this guard refuses.
    assert.throws(() => parsePlayableCount(7), /must be a string/);
    assert.throws(() => parsePlayableCount('  '), /cannot be empty/);
    assert.throws(() => parsePlayableCount('0v0'), /invalid playable count/);
  });
});

describe('calculateMaxRosterSize', () => {
  it('applies the 2x playable minus buffer formula', () => {
    assert.equal(calculateMaxRosterSize(7), 12);
    assert.equal(calculateMaxRosterSize(9), 16);
  });

  it('respects custom buffer and minimum overrides', () => {
    assert.equal(calculateMaxRosterSize(5, { buffer: 1 }), 9);
    assert.equal(calculateMaxRosterSize(5, { minimum: 12 }), 12);
  });

  it('throws for invalid playable counts', () => {
    assert.throws(() => calculateMaxRosterSize(0));
  });
});

describe('deriveDivisionRosterConfigs', () => {
  it('gives a division whose format names no NvN its own limits over the defaults, not a throw (D2)', () => {
    const configs = deriveDivisionRosterConfigs([
      { id: 'U4', playFormat: 'Minis (U5 intro)', minRosterSize: 12, targetTeamSize: 14 },
      { id: 'U5', playFormat: 'Minis' },
    ]);
    assert.equal(configs.U4.source, 'default-limits');
    assert.equal(configs.U4.playableCount, null);
    assert.equal(configs.U4.maxRosterSize, 14);
    assert.equal(configs.U4.minRosterSize, 12);
    assert.equal(configs.U4.targetTeamSize, 14);
    assert.equal(configs.U5.maxRosterSize, 14);
    // Its own maximum still wins, as for any division record.
    assert.equal(
      deriveDivisionRosterConfigs([{ id: 'U4', playFormat: 'Minis', maxRosterSize: 15 }]).U4
        .maxRosterSize,
      15
    );
  });

  it('prefers overrides when available', () => {
    const divisions = [{ id: 'U10', playFormat: '7v7' }];
    const overrides = {
      U10: {
        maxRosterSize: 13,
        playableCount: 7,
        minRosterSize: 10,
        targetTeamSize: 12,
        minTeams: 2,
        maxTeams: 4,
      },
    };
    const configs = deriveDivisionRosterConfigs(divisions, { overrides });

    assert.deepEqual(configs, {
      U10: {
        maxRosterSize: 13,
        minRosterSize: 10,
        targetTeamSize: 12,
        minTeams: 2,
        maxTeams: 4,
        playableCount: 7,
        source: 'override',
      },
    });
  });

  it('falls back to division maxRosterSize when present', () => {
    const divisions = [{ id: 'U12', maxRosterSize: 15, playableCount: 9 }];
    const configs = deriveDivisionRosterConfigs(divisions);

    assert.deepEqual(configs, {
      U12: {
        maxRosterSize: 15,
        playableCount: 9,
        source: 'division-record',
      },
    });
  });

  it('derives roster sizes from format strings', () => {
    const divisions = [{ id: 'U8', playFormat: '5v5' }];
    const configs = deriveDivisionRosterConfigs(divisions);

    assert.deepEqual(configs, {
      U8: {
        maxRosterSize: 8,
        playableCount: 5,
        source: 'formula',
      },
    });
  });

  it('supports overrides keyed by division name', () => {
    const divisions = [{ name: 'U6 Coed', playFormat: '3v3' }];
    const overrides = { 'U6 Coed': { maxRosterSize: 7 } };
    const configs = deriveDivisionRosterConfigs(divisions, { overrides });

    assert.deepEqual(configs, {
      'U6 Coed': {
        maxRosterSize: 7,
        playableCount: null,
        source: 'override',
      },
    });
  });

  it('throws when a division is missing sizing data', () => {
    const divisions = [{ id: 'U14' }];
    assert.throws(() => deriveDivisionRosterConfigs(divisions));
  });

  it('validates optional roster and team bounds', () => {
    assert.throws(
      () => deriveDivisionRosterConfigs([{ id: 'U10', maxRosterSize: 10, minRosterSize: 11 }]),
      /minRosterSize.*cannot exceed maxRosterSize/i
    );

    assert.throws(
      () =>
        deriveDivisionRosterConfigs([{ id: 'U10', maxRosterSize: 10, minTeams: 4, maxTeams: 3 }]),
      /minTeams cannot exceed maxTeams/i
    );
  });
});

describe('buildOverridesFromSupabaseRows', () => {
  it('filters by season and prefers matching overrides', () => {
    const rows = [
      { divisionId: 'U10', seasonId: 'fall', maxRosterSize: 13 },
      { division_id: 'U10', season_id: 'spring', max_roster_size: 12 },
      { divisionCode: 'U12', maxRosterSize: 14 },
    ];

    const overrides = buildOverridesFromSupabaseRows(rows, { seasonId: 'fall' });

    assert.deepEqual(overrides, {
      U10: { maxRosterSize: 13, playableCount: null },
      U12: { maxRosterSize: 14, playableCount: null },
    });
  });

  it('prefers season specific overrides when seasonId is provided', () => {
    const rows = [
      { divisionId: 'U10', maxRosterSize: 10 },
      { divisionId: 'U10', seasonId: 'fall', maxRosterSize: 13 },
    ];

    const overrides = buildOverridesFromSupabaseRows(rows, { seasonId: 'fall' });

    assert.deepEqual(overrides, {
      U10: { maxRosterSize: 13, playableCount: null },
    });
  });

  it('normalizes snake_case roster and team constraints', () => {
    const rows = [
      {
        division_id: 'U10',
        max_roster_size: 14,
        min_roster_size: 10,
        target_team_size: 12,
        team_count_override: 3,
        min_teams: 2,
        max_teams: 4,
      },
    ];

    const overrides = buildOverridesFromSupabaseRows(rows);

    assert.deepEqual(overrides, {
      U10: {
        maxRosterSize: 14,
        minRosterSize: 10,
        targetTeamSize: 12,
        teamCountOverride: 3,
        minTeams: 2,
        maxTeams: 4,
        playableCount: null,
      },
    });
  });

  it('prefers generic overrides when no seasonId is provided', () => {
    const rows = [
      { divisionId: 'U10', seasonId: 'fall', maxRosterSize: 13 },
      { divisionId: 'U10', maxRosterSize: 10 },
    ];

    const overrides = buildOverridesFromSupabaseRows(rows);

    assert.deepEqual(overrides, {
      U10: { maxRosterSize: 10, playableCount: null },
    });
  });

  it('throws when rows are malformed', () => {
    // @ts-expect-error [INVALID_INPUT] - testing intentional invalid input to verify runtime validation logic in javascript-compiled-as-typescript context
    assert.throws(() => buildOverridesFromSupabaseRows('oops'));
    assert.throws(() => buildOverridesFromSupabaseRows([{}]));
    assert.throws(() => buildOverridesFromSupabaseRows([{ divisionId: 'U8', maxRosterSize: 0 }]));
  });
});

describe('assessTeamCount', () => {
  const limits = { minRosterSize: 10, maxRosterSize: 14, targetTeamSize: 12 };
  const codes = (result) => result.warnings.map((w) => w.code);

  it('recommends what generation would build with no override, inside the range that fits', () => {
    const result = assessTeamCount({ playerCount: 40, ...limits });
    assert.equal(result.teamCount, 4);
    assert.equal(result.recommendedTeamCount, 4);
    assert.deepEqual(result.fitRange, { min: 3, max: 4 });
    assert.deepEqual(result.warnings, []);
  });

  it('says when generation will not use the override, and judges the count it will use', () => {
    // 30 players: 2 teams would be 15 each (over 14), so generation makes 3 teams of 10.
    const result = assessTeamCount({ playerCount: 30, teamCountOverride: 2, ...limits });
    assert.equal(result.teamCount, 3);
    assert.deepEqual(codes(result), ['OVERRIDE_ADJUSTED']);
    assert.match(result.warnings[0].message, /Generation will make 3 teams, not the 2 set here/);
  });

  it('warns about too many per team only when generation really builds that (maxTeams cap)', () => {
    const result = assessTeamCount({ playerCount: 30, maxTeams: 2, ...limits });
    assert.equal(result.teamCount, 2);
    assert.equal(result.recommendedTeamCount, 2);
    assert.deepEqual(codes(result), ['TOO_MANY_PER_TEAM']);
    assert.match(
      result.warnings[0].message,
      /15 players, over the maximum of 14\. The maximum of 2 teams/
    );
  });

  it('warns about short teams when head coaches force more teams than fit', () => {
    const result = assessTeamCount({ playerCount: 30, coachCount: 4, ...limits });
    assert.equal(result.teamCount, 4);
    assert.equal(result.fitRange, null);
    assert.deepEqual(codes(result), ['TOO_FEW_PER_TEAM']);
    assert.match(result.warnings[0].message, /only 7 players, under the minimum of 10/);
  });

  it('never recommends a count outside the min and max team bounds', () => {
    const result = assessTeamCount({ playerCount: 60, maxTeams: 4, ...limits });
    assert.equal(result.recommendedTeamCount, 4);
    const low = assessTeamCount({ playerCount: 20, minTeams: 3, ...limits });
    assert.equal(low.recommendedTeamCount, 3);
  });

  it('warns once when there are fewer players than one minimum roster', () => {
    const result = assessTeamCount({ playerCount: 7, ...limits });
    assert.deepEqual(codes(result), ['TOO_FEW_PLAYERS']);
    assert.equal(result.teamCount, 1);
  });

  it('gives no advice for a configuration the page already rejects', () => {
    for (const config of [
      { minRosterSize: 14, maxRosterSize: 10 },
      { minTeams: 4, maxTeams: 2 },
      { minTeams: 3, teamCountOverride: 2 },
      { maxTeams: 2, teamCountOverride: 3 },
    ]) {
      const result = assessTeamCount({ playerCount: 30, ...limits, ...config });
      assert.equal(result.blocked, true, JSON.stringify(config));
      assert.equal(result.recommendedTeamCount, null);
      assert.deepEqual(result.warnings, []);
    }
  });

  it('reads empty limits as the generator does: no minimum, target = maximum, no maximum = no advice', () => {
    const noMin = assessTeamCount({ playerCount: 30, maxRosterSize: 14, minRosterSize: null });
    assert.equal(noMin.recommendedTeamCount, 3);
    assert.deepEqual(noMin.fitRange, { min: 3, max: 30 });
    assert.deepEqual(noMin.warnings, []);
    const noMax = assessTeamCount({ playerCount: 30, minRosterSize: 10, maxRosterSize: null });
    assert.equal(noMax.blocked, true);
  });

  it('gives no advice and no warnings with no players', () => {
    const result = assessTeamCount({ playerCount: 0, ...limits });
    assert.equal(result.recommendedTeamCount, null);
    assert.deepEqual(result.warnings, []);
  });
});

describe('resolveTeamCount (the count generateTeams builds)', () => {
  const base = { maxRosterSize: 14, targetTeamSize: 12, minRosterSize: 10 };

  it('starts from ceil(players / target), or the override', () => {
    assert.equal(resolveTeamCount({ ...base, playerCount: 40 }), 4);
    assert.equal(resolveTeamCount({ ...base, playerCount: 40, teamCountOverride: 3 }), 3);
  });

  it('raises the count for capacity and for each head coach, and caps it at maxTeams', () => {
    assert.equal(resolveTeamCount({ ...base, playerCount: 30, teamCountOverride: 2 }), 3);
    assert.equal(resolveTeamCount({ ...base, playerCount: 30, coachCount: 4 }), 4);
    assert.equal(resolveTeamCount({ ...base, playerCount: 30, maxTeams: 2 }), 2);
  });

  it('lowers an override that would leave teams under the minimum roster', () => {
    assert.equal(resolveTeamCount({ ...base, playerCount: 30, teamCountOverride: 4 }), 3);
  });

  it('builds one team for no players', () => {
    assert.equal(resolveTeamCount({ ...base, playerCount: 0 }), 1);
  });
});
