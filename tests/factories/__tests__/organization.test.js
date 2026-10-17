import { describe, it, expect } from 'vitest';
import { makeOrganization, makeOrganizationMember } from '../organization.js';
import { MOCK_ORG_ID } from '../../../frontend/src/lib/mockSeedIds.js';

describe('makeOrganization', () => {
  it('returns deterministic defaults with no args', () => {
    expect(makeOrganization()).toEqual({
      id: MOCK_ORG_ID,
      name: 'Test Organization',
      slug: 'test-org',
      contact_info: {},
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    });
  });

  it('merges overrides, with override keys winning', () => {
    const org = makeOrganization({ id: 'org-2', name: 'Other Org' });
    expect(org.id).toBe('org-2');
    expect(org.name).toBe('Other Org');
    expect(org.slug).toBe('test-org');
  });

  it('respects explicit undefined overrides', () => {
    const org = makeOrganization({ name: undefined });
    expect(org.name).toBeUndefined();
  });
});

describe('makeOrganizationMember', () => {
  it('returns deterministic defaults with no args', () => {
    expect(makeOrganizationMember()).toEqual({
      organization_id: MOCK_ORG_ID,
      profile_id: 'user-1',
      role: 'admin',
      created_at: '2026-01-01T00:00:00Z',
    });
  });

  it('merges overrides, with override keys winning', () => {
    const member = makeOrganizationMember({ role: 'coach', profile_id: 'user-2' });
    expect(member.role).toBe('coach');
    expect(member.profile_id).toBe('user-2');
    expect(member.organization_id).toBe(MOCK_ORG_ID);
  });

  it('respects explicit undefined overrides', () => {
    const member = makeOrganizationMember({ role: undefined });
    expect(member.role).toBeUndefined();
  });
});
