import { describe, it, expect, beforeEach } from 'vitest';
import { mockSupabase as supabase, getMockData } from '../frontend/src/lib/mockSupabaseClient.js';

const setMockSession = (userId) => {
  sessionStorage.setItem('__MOCK_SESSION__', JSON.stringify({ user: { id: userId } }));
};

describe('mock facility admin rpcs', () => {
  beforeEach(() => {
    sessionStorage.clear();
    delete window.__MOCK_DB__;
    setMockSession('mock-admin-id');
  });

  it('creates, updates, and deletes fields through admin RPC handlers', async () => {
    const { data: location, error: locationError } = await supabase.rpc('admin_create_location', {
      p_organization_id: 'org-1',
      p_name: '  New Park  ',
    });
    expect(locationError).toBeNull();
    expect(location).toMatchObject({ organization_id: 'org-1', name: 'New Park' });

    const { data: field, error: fieldError } = await supabase.rpc('admin_create_field', {
      p_organization_id: 'org-1',
      p_location_id: location.id,
      p_name: '  South Field  ',
      p_surface_type: 'Turf',
      p_size: '7v7',
      p_supports_halves: true,
      p_priority_rating: 3,
      p_active: true,
    });
    expect(fieldError).toBeNull();
    expect(field).toMatchObject({
      organization_id: 'org-1',
      location_id: location.id,
      name: 'South Field',
      size: '7v7',
      supports_halves: true,
      priority_rating: 3,
    });
    expect(getMockData('field_subunits').filter((row) => row.field_id === field.id)).toHaveLength(
      2
    );

    const { data: updated, error: updateError } = await supabase.rpc('admin_update_field', {
      p_organization_id: 'org-1',
      p_field_id: field.id,
      p_location_id: location.id,
      p_name: 'Renamed Field',
      p_surface_type: 'Grass',
      p_size: '11v11',
      p_supports_halves: false,
      p_priority_rating: 2,
      p_active: false,
    });
    expect(updateError).toBeNull();
    expect(updated).toMatchObject({ name: 'Renamed Field', active: false, size: '11v11' });
    expect(getMockData('field_subunits').filter((row) => row.field_id === field.id)).toHaveLength(
      0
    );

    const { data: deleted, error: deleteError } = await supabase.rpc('admin_delete_field', {
      p_organization_id: 'org-1',
      p_field_id: field.id,
    });
    expect(deleteError).toBeNull();
    expect(deleted).toMatchObject({ id: field.id, organization_id: 'org-1', deleted: true });
    expect(getMockData('fields').some((row) => row.id === field.id)).toBe(false);
    // create_location, create_field, update_field, then admin_delete_field's
    // BEFORE and AFTER phases -- five, not four. The delete audits both phases
    // because the SQL does, and it does because "what did it look like before"
    // is the half that makes a destructive decision reviewable.
    expect(
      getMockData('audit_log').filter(
        (row) =>
          row.action === 'settings.updated' && ['location', 'field'].includes(row.resource_type)
      )
    ).toHaveLength(5);
    expect(
      getMockData('audit_log')
        .filter((row) => row.metadata?.operation === 'admin_delete_field')
        .map((row) => row.metadata.phase)
        .sort()
    ).toEqual(['after', 'before']);
  });

  it('rejects non-admin and cross-org facility writes', async () => {
    setMockSession('mock-coach-id');
    const { error: roleError } = await supabase.rpc('admin_create_location', {
      p_organization_id: 'org-1',
      p_name: 'Coach Park',
    });
    expect(roleError?.message).toContain('Admin role is required');

    setMockSession('mock-admin-id');
    const { data: location } = await supabase.rpc('admin_create_location', {
      p_organization_id: 'org-1',
      p_name: 'Priority Park',
    });
    const { error: priorityError } = await supabase.rpc('admin_create_field', {
      p_organization_id: 'org-1',
      p_location_id: location.id,
      p_name: 'Bad Priority Field',
      p_surface_type: 'Grass',
      p_size: '11v11',
      p_supports_halves: false,
      p_priority_rating: 0,
      p_active: true,
    });
    expect(priorityError?.message).toContain('priority_rating must be at least 1');

    const { error: scopeError } = await supabase.rpc('admin_create_field', {
      p_organization_id: 'org-1',
      p_location_id: 'missing-location',
      p_name: 'Bad Field',
      p_surface_type: 'Grass',
      p_size: '11v11',
      p_supports_halves: false,
      p_priority_rating: 1,
      p_active: true,
    });
    expect(scopeError?.message).toContain('Location is outside organization');
  });
});
