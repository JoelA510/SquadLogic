import { describe, it, expect } from 'vitest';
import { makeAuditLogEntry } from '../audit.js';
import { MOCK_ORG_ID } from '../../../frontend/src/lib/mockSeedIds.js';

describe('makeAuditLogEntry', () => {
  it('returns deterministic defaults with no args', () => {
    expect(makeAuditLogEntry()).toEqual({
      id: 'audit-1',
      created_at: '2026-01-01T00:00:00Z',
      user_id: 'user-1',
      organization_id: MOCK_ORG_ID,
      action: 'import.started',
      resource_type: null,
      resource_id: null,
      metadata: {},
      ip_address: null,
    });
  });

  it('merges overrides, with override keys winning', () => {
    const a = makeAuditLogEntry({ action: 'team.saved', metadata: { team_id: 'team-1' } });
    expect(a.action).toBe('team.saved');
    expect(a.metadata).toEqual({ team_id: 'team-1' });
    expect(a.user_id).toBe('user-1');
  });

  it('respects explicit undefined overrides', () => {
    const a = makeAuditLogEntry({ action: undefined });
    expect(a.action).toBeUndefined();
  });
});
