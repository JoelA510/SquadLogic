import { describe, expect, it } from 'vitest';
import {
  divisionAge,
  divisionGenderLetter,
  divisionBaseName,
  divisionDisplayName,
  divisionFilters,
} from '../frontend/src/utils/divisions.js';
import {
  FeatureFlagSchema,
  FEATURE_DEFAULTS,
  GENDER_MODEL_KEY,
} from '../frontend/src/constants/featureFlags.js';

describe('divisions utils', () => {
  it('parses ages from assorted division names', () => {
    expect(divisionAge('U8B')).toBe(8);
    expect(divisionAge('U10 Girls')).toBe(10);
    expect(divisionAge('u12')).toBe(12);
    expect(divisionAge('Adult Rec')).toBeNull();
  });

  it('detects gender letters', () => {
    expect(divisionGenderLetter('U8B')).toBe('B');
    expect(divisionGenderLetter('U10 Girls')).toBe('G');
    expect(divisionGenderLetter('U8 Coed')).toBeNull();
  });

  it('strips gender markers for base names', () => {
    expect(divisionBaseName('U8B')).toBe('U8');
    expect(divisionBaseName('U10 Girls')).toBe('U10');
    expect(divisionBaseName('U8 Coed')).toBe('U8');
  });

  it('collapses display names only under the coed model', () => {
    expect(divisionDisplayName('U10 Girls', 'split')).toBe('U10 Girls');
    expect(divisionDisplayName('U10 Girls', 'coed')).toBe('U10');
    expect(divisionDisplayName('U8B', 'coed')).toBe('U8');
  });

  it('folds gendered divisions into shared filter options under coed', () => {
    const divisions = [
      { id: 'a', name: 'U10 Girls' },
      { id: 'b', name: 'U10 Boys' },
      { id: 'c', name: 'U8B' },
      { id: 'd', name: 'U8G' },
    ];
    const coed = divisionFilters(divisions, 'coed');
    expect(coed.map((f) => f.label)).toEqual(['U8', 'U10']);
    expect(coed[1].divisionIds.sort()).toEqual(['a', 'b']);

    const split = divisionFilters(divisions, 'split');
    expect(split).toHaveLength(4);
    expect(split[0].label).toBe('U8B');
  });
});

describe('FeatureFlagSchema with gender_model', () => {
  it('accepts valid gender_model strings and booleans', () => {
    const parsed = FeatureFlagSchema.parse({
      years_played: true,
      gender_model: 'coed',
      advanced_fairness: false,
    });
    expect(parsed).toEqual({
      years_played: true,
      gender_model: 'coed',
    });
    expect(FeatureFlagSchema.safeParse({ years_played: { enabled: true } }).success).toBe(false);
  });

  it('drops invalid gender_model values and unknown keys', () => {
    const parsed = FeatureFlagSchema.parse({
      gender_model: 'mixed',
      mystery_flag: true,
      waitlist: false,
    });
    expect(parsed).toEqual({ waitlist: false });
  });

  it('default posture: years played on, rating off, split model', () => {
    expect(FEATURE_DEFAULTS.years_played).toBe(true);
    expect(FEATURE_DEFAULTS.player_rating).toBe(false);
    expect(FEATURE_DEFAULTS[GENDER_MODEL_KEY]).toBe('split');
  });
});
