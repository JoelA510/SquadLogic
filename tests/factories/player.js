import { MOCK_ORG_ID } from '../../frontend/src/lib/mockSeedIds.js';
export function makePlayer(overrides = {}) {
  return {
    id: 'player-1',
    division_id: 'div-1',
    organization_id: MOCK_ORG_ID,
    external_registration_id: 'ext-reg-1',
    first_name: 'Test',
    last_name: 'Player',
    preferred_name: null,
    date_of_birth: null,
    grade: null,
    guardian_contacts: [],
    mutual_buddy_code: null,
    skill_tier: null,
    coach_volunteer: false,
    notes: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}
