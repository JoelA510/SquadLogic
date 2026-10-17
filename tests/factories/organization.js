import { MOCK_ORG_ID } from '../../frontend/src/lib/mockSeedIds.js';
export function makeOrganization(overrides = {}) {
  return {
    id: MOCK_ORG_ID,
    name: 'Test Organization',
    slug: 'test-org',
    contact_info: {},
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

export function makeOrganizationMember(overrides = {}) {
  return {
    organization_id: MOCK_ORG_ID,
    profile_id: 'user-1',
    role: 'admin',
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}
