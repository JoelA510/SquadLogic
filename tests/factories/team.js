import { MOCK_ORG_ID } from '../../frontend/src/lib/mockSeedIds.js';
export function makeTeam(overrides = {}) {
  return {
    id: 'team-1',
    division_id: 'div-1',
    organization_id: MOCK_ORG_ID,
    name: 'Test Team',
    coach_id: null,
    assistant_coach_ids: [],
    practice_slot_id: null,
    notes: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

export function makeTeamPlayer(overrides = {}) {
  return {
    team_id: 'team-1',
    player_id: 'player-1',
    role: 'player',
    source: 'auto',
    added_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}
