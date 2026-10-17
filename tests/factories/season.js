import { MOCK_ORG_ID } from '../../frontend/src/lib/mockSeedIds.js';
export function makeSeason(overrides = {}) {
  return {
    id: 1,
    organization_id: MOCK_ORG_ID,
    season_label: 'Fall',
    season_year: 2026,
    season_start: '2026-09-01',
    season_end: '2026-12-01',
    roster_formula: {},
    daylight_adjustments: [],
    exports_config: {},
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

export function makeDivision(overrides = {}) {
  return {
    id: 'div-1',
    season_settings_id: 1,
    organization_id: MOCK_ORG_ID,
    name: 'U8 Coed',
    gender_policy: 'coed',
    max_roster_size: 12,
    play_format: '7v7',
    season_start: '2026-09-01',
    season_end: '2026-12-01',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}
