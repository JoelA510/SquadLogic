import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  calculateMaxRosterSize,
  buildOverridesFromSupabaseRows,
  deriveDivisionRosterConfigs,
  parsePlayableCount,
} from '../src/rosterSizing.js';

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
    const overrides = { U10: { maxRosterSize: 13, playableCount: 7 } };
    const configs = deriveDivisionRosterConfigs(divisions, { overrides });

    assert.deepEqual(configs, {
      U10: {
        maxRosterSize: 13,
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

  it('throws when rows are malformed', () => {
    assert.throws(() => buildOverridesFromSupabaseRows('oops'));
    assert.throws(() => buildOverridesFromSupabaseRows([{}]));
    assert.throws(() => buildOverridesFromSupabaseRows([{ divisionId: 'U8', maxRosterSize: 0 }]));
  });
});
