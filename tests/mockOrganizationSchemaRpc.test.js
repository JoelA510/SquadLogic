import { describe, it, expect, beforeEach } from 'vitest';
import { mockSupabase as supabase, getMockData } from '../frontend/src/lib/mockSupabaseClient.js';
import { MOCK_ORG_ID } from '../frontend/src/lib/mockSeedIds.js';

const setMockSession = (userId) => {
  sessionStorage.setItem('__MOCK_SESSION__', JSON.stringify({ user: { id: userId } }));
};

describe('mock admin_upsert_organization_schema rpc', () => {
  beforeEach(() => {
    sessionStorage.clear();
    delete window.__MOCK_DB__;
    setMockSession('mock-admin-id');
  });

  it('enforces admin saves with normalization, changed state, and audit rows', async () => {
    const { data, error } = await supabase.rpc('admin_upsert_organization_schema', {
      p_organization_id: MOCK_ORG_ID,
      p_entity_type: 'PLAYER',
      p_schema_definition: {
        jersey_size: ' STRING ',
        birth_date: 'Date',
      },
    });

    expect(error).toBeNull();
    expect(data).toMatchObject({
      organization_id: MOCK_ORG_ID,
      entity_type: 'player',
      schema_definition: {
        jersey_size: 'string',
        birth_date: 'date',
      },
      changed: true,
    });

    expect(
      getMockData('audit_log').filter(
        (row) => row.action === 'settings.updated' && row.resource_type === 'organization_schema'
      )
    ).toHaveLength(1);
  });

  it('returns changed false when the schema is already current', async () => {
    await supabase.rpc('admin_upsert_organization_schema', {
      p_organization_id: MOCK_ORG_ID,
      p_entity_type: 'player',
      p_schema_definition: {
        jersey_size: 'string',
        birth_date: 'date',
      },
    });

    const { data, error } = await supabase.rpc('admin_upsert_organization_schema', {
      p_organization_id: MOCK_ORG_ID,
      p_entity_type: 'player',
      p_schema_definition: {
        birth_date: 'DATE',
        jersey_size: ' string ',
      },
    });

    expect(error).toBeNull();
    expect(data.changed).toBe(false);
    expect(
      getMockData('audit_log').filter(
        (row) => row.action === 'settings.updated' && row.resource_type === 'organization_schema'
      )
    ).toHaveLength(1);
  });

  it('rejects non-admin mock sessions', async () => {
    setMockSession('mock-coach-id');

    const { error } = await supabase.rpc('admin_upsert_organization_schema', {
      p_organization_id: MOCK_ORG_ID,
      p_entity_type: 'coach',
      p_schema_definition: { certification: 'string' },
    });

    expect(error?.message).toContain('Admin role is required');
    expect(getMockData('organization_schemas')).toHaveLength(0);
  });

  it('rejects invalid schema payloads', async () => {
    await expect(
      supabase.rpc('admin_upsert_organization_schema', {
        p_organization_id: MOCK_ORG_ID,
        p_entity_type: 'division',
        p_schema_definition: {},
      })
    ).resolves.toMatchObject({ error: { message: 'Invalid schema entity type: division' } });

    await expect(
      supabase.rpc('admin_upsert_organization_schema', {
        p_organization_id: MOCK_ORG_ID,
        p_entity_type: 'player',
        p_schema_definition: { id: 'string' },
      })
    ).resolves.toMatchObject({ error: { message: 'Schema field id is reserved' } });

    await expect(
      supabase.rpc('admin_upsert_organization_schema', {
        p_organization_id: MOCK_ORG_ID,
        p_entity_type: 'player',
        p_schema_definition: { skill: 'rating' },
      })
    ).resolves.toMatchObject({
      error: { message: 'Schema field skill has unsupported type rating' },
    });
  });
});
