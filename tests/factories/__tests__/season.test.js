import { describe, it, expect } from 'vitest';
import { makeSeason, makeDivision } from '../season.js';
import { MOCK_ORG_ID } from '../../../frontend/src/lib/mockSeedIds.js';

describe('makeSeason', () => {
  it('returns deterministic defaults with no args', () => {
    const s = makeSeason();
    expect(s.id).toBe(1);
    expect(s.organization_id).toBe(MOCK_ORG_ID);
    expect(s.season_label).toBe('Fall');
    expect(s.season_year).toBe(2026);
    expect(s.roster_formula).toEqual({});
    expect(s.daylight_adjustments).toEqual([]);
  });

  it('merges overrides, with override keys winning', () => {
    const s = makeSeason({ season_year: 2027, season_label: 'Spring' });
    expect(s.season_year).toBe(2027);
    expect(s.season_label).toBe('Spring');
    expect(s.id).toBe(1);
  });

  it('respects explicit undefined overrides', () => {
    const s = makeSeason({ season_label: undefined });
    expect(s.season_label).toBeUndefined();
  });
});

describe('makeDivision', () => {
  it('returns deterministic defaults with no args', () => {
    const d = makeDivision();
    expect(d.id).toBe('div-1');
    expect(d.season_settings_id).toBe(1);
    expect(d.organization_id).toBe(MOCK_ORG_ID);
    expect(d.name).toBe('U8 Coed');
    expect(d.gender_policy).toBe('coed');
    expect(d.max_roster_size).toBe(12);
    expect(d.play_format).toBe('7v7');
  });

  it('merges overrides, with override keys winning', () => {
    const d = makeDivision({ name: 'U10 Girls', gender_policy: 'girls' });
    expect(d.name).toBe('U10 Girls');
    expect(d.gender_policy).toBe('girls');
    expect(d.max_roster_size).toBe(12);
  });

  it('respects explicit undefined overrides', () => {
    const d = makeDivision({ name: undefined });
    expect(d.name).toBeUndefined();
  });
});
