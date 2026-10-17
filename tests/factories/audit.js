import { MOCK_ORG_ID } from '../../frontend/src/lib/mockSeedIds.js';
export function makeAuditLogEntry(overrides = {}) {
  return {
    id: 'audit-1',
    created_at: '2026-01-01T00:00:00Z',
    user_id: 'user-1',
    organization_id: MOCK_ORG_ID,
    action: 'import.started',
    resource_type: null,
    resource_id: null,
    metadata: {},
    ip_address: null,
    ...overrides,
  };
}
