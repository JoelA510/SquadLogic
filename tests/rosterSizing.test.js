import { describe, it } from 'vitest';
import assert from 'node:assert/strict';

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

  it('throws when format is invalid', () => {
    assert.throws(() => parsePlayableCount('solo'), /unable to parse/);
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

  it('recommends the count nearest the target that keeps every team within the limits', () => {
    const result = assessTeamCount({ playerCount: 60, teamCount: 5, ...limits });
    assert.deepEqual(result.fitRange, { min: 5, max: 6 });
    assert.equal(result.recommendedTeamCount, 5);
    assert.deepEqual(result.warnings, []);
  });

  it('warns when the chosen count puts too many players on a team, and says how many teams fit', () => {
    const result = assessTeamCount({ playerCount: 30, teamCount: 2, ...limits });
    assert.equal(result.largestTeam, 15);
    assert.deepEqual(
      result.warnings.map((w) => w.code),
      ['TOO_MANY_PER_TEAM']
    );
    assert.match(result.warnings[0].message, /15 players, over the maximum of 14\. Use at least 3/);
  });

  it('warns when the chosen count leaves teams short, using the uneven split', () => {
    const result = assessTeamCount({ playerCount: 30, teamCount: 4, ...limits });
    assert.equal(result.smallestTeam, 7);
    assert.equal(result.largestTeam, 8);
    assert.deepEqual(
      result.warnings.map((w) => w.code),
      ['TOO_FEW_PER_TEAM']
    );
    assert.match(
      result.warnings[0].message,
      /only 7 players, under the minimum of 10\. Use at most 3 teams/
    );
  });

  it('says so when no team count fits the limits', () => {
    // 15 players: 1 team is over 14, 2 teams of 7-8 are under 10.
    const result = assessTeamCount({ playerCount: 15, teamCount: 1, ...limits });
    assert.equal(result.fitRange, null);
    assert.deepEqual(
      result.warnings.map((w) => w.code),
      ['NO_FIT', 'TOO_MANY_PER_TEAM']
    );
    assert.match(result.warnings[1].message, /^With 1 team, the team would have 15 players/);
  });

  it('warns once, not per team, when there are fewer players than one minimum roster', () => {
    const result = assessTeamCount({ playerCount: 7, teamCount: 1, ...limits });
    assert.deepEqual(
      result.warnings.map((w) => w.code),
      ['TOO_FEW_PLAYERS']
    );
    assert.equal(result.recommendedTeamCount, 1);
  });

  it('gives no advice and no warnings with no players', () => {
    const result = assessTeamCount({ playerCount: 0, teamCount: 3, ...limits });
    assert.equal(result.recommendedTeamCount, null);
    assert.deepEqual(result.warnings, []);
  });

  it('only checks the limits that are set', () => {
    const noMin = assessTeamCount({ playerCount: 30, teamCount: 10, maxRosterSize: 14 });
    assert.deepEqual(noMin.warnings, []);
    assert.deepEqual(noMin.fitRange, { min: 3, max: 30 });
    const noMax = assessTeamCount({ playerCount: 30, teamCount: 1, minRosterSize: 10 });
    assert.deepEqual(noMax.warnings, []);
  });
});
