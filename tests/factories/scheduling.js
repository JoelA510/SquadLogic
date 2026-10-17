import { MOCK_ORG_ID } from '../../frontend/src/lib/mockSeedIds.js';
export function makeField(overrides = {}) {
  return {
    id: 'field-1',
    location_id: 'loc-1',
    organization_id: MOCK_ORG_ID,
    name: 'Field 1',
    surface_type: 'grass',
    supports_halves: false,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

export function makeGameSlot(overrides = {}) {
  return {
    id: 'gs-1',
    field_id: 'field-1',
    division_id: null,
    slot_date: '2026-09-05',
    start_time: '09:00',
    end_time: '10:00',
    week_index: 1,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

export function makePracticeAssignment(overrides = {}) {
  return {
    id: 'pa-1',
    team_id: 'team-1',
    practice_slot_id: 'ps-1',
    effective_date_range: '[2026-09-01,2026-12-01)',
    source: 'auto',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}
