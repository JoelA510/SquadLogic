import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useFields } from '../frontend/src/hooks/useFields.js';
import { supabase } from '../frontend/src/lib/supabaseClient.js';
import { useOrganization } from '../frontend/src/contexts/OrganizationContext.jsx';

vi.mock('../frontend/src/lib/supabaseClient.js', () => ({
  supabase: {
    from: vi.fn(),
    rpc: vi.fn(),
  },
}));

vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: vi.fn(),
}));

vi.mock('../frontend/src/lib/logger.js', () => ({
  logger: { error: vi.fn() },
}));

function createReadBuilder(result) {
  const builder = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    order: vi.fn(() => Promise.resolve(result)),
  };
  return builder;
}

describe('useFields', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // @ts-expect-error [MOCK] - partial organization context is enough for this hook.
    vi.mocked(useOrganization).mockReturnValue({
      currentOrganization: { id: 'org-1' },
    });

    const locationsBuilder = createReadBuilder({
      data: [{ id: 'location-1', organization_id: 'org-1', name: 'Park' }],
      error: null,
    });
    const fieldsBuilder = createReadBuilder({
      data: [
        {
          id: 'field-1',
          organization_id: 'org-1',
          location_id: 'location-1',
          name: 'North Field',
        },
      ],
      error: null,
    });

    vi.mocked(supabase.from).mockImplementation((table) => {
      const builder = table === 'locations' ? locationsBuilder : fieldsBuilder;
      return /** @type {any} */ (builder);
    });
    // @ts-expect-error [MOCK] - partial RPC response is enough for mutation assertions.
    vi.mocked(supabase.rpc).mockResolvedValue({ data: { id: 'rpc-id' }, error: null });
  });

  it('routes facility mutations through org-scoped RPCs', async () => {
    const { result } = renderHook(() => useFields());

    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.addLocation('  New Park  ');
    });

    expect(supabase.rpc).toHaveBeenCalledWith('admin_create_location', {
      p_organization_id: 'org-1',
      p_name: '  New Park  ',
    });

    await act(async () => {
      await result.current.addField({
        location_id: 'location-1',
        name: 'South Field',
        surface_type: 'Turf',
        size: '7v7',
        supports_halves: true,
        priority_rating: 3,
        active: true,
      });
    });

    expect(supabase.rpc).toHaveBeenCalledWith('admin_create_field', {
      p_organization_id: 'org-1',
      p_location_id: 'location-1',
      p_name: 'South Field',
      p_surface_type: 'Turf',
      p_size: '7v7',
      p_supports_halves: true,
      p_priority_rating: 3,
      p_active: true,
    });

    await act(async () => {
      await result.current.updateField('field-1', {
        location_id: 'location-1',
        name: 'Renamed Field',
        surface_type: 'Grass',
        size: '11v11',
        supports_halves: false,
        priority_rating: 2,
        active: false,
      });
    });

    expect(supabase.rpc).toHaveBeenCalledWith('admin_update_field', {
      p_organization_id: 'org-1',
      p_field_id: 'field-1',
      p_location_id: 'location-1',
      p_name: 'Renamed Field',
      p_surface_type: 'Grass',
      p_size: '11v11',
      p_supports_halves: false,
      p_priority_rating: 2,
      p_active: false,
    });

    // **`p_confirm` is passed explicitly, and false by default.** The guard
    // lives in the RPC, so the flag is the only way past it; a caller that
    // omitted it would be relying on the database's DEFAULT, which is the same
    // guarantee stated in two places.
    // @ts-expect-error [MOCK] - partial RPC response is enough for this assertion.
    vi.mocked(supabase.rpc).mockResolvedValue({ data: { deleted: true }, error: null });
    await act(async () => {
      await result.current.deleteField('field-1');
    });

    expect(supabase.rpc).toHaveBeenCalledWith('admin_delete_field', {
      p_organization_id: 'org-1',
      p_field_id: 'field-1',
      p_confirm: false,
    });
    await waitFor(() => expect(result.current.fields).toHaveLength(0));
  });

  it('keeps a refused field in the list and hands the refusal back', async () => {
    // **A refusal is not an error.** `admin_delete_field` returns
    // `{deleted:false, ...}` with `error` null, and this hook used to discard
    // `data` entirely -- so a refusal removed the field from the list it had
    // not deleted. The list is the subject here, not the return value: it is
    // what an operator sees.
    const refusal = {
      deleted: false,
      reason: 'bookings_exist',
      affected_count: 2,
      affected: [
        { kind: 'game_slot', id: 'gs-1', disposition: 'deleted' },
        { kind: 'practice_assignment', id: 'pa-1', disposition: 'unassigned' },
      ],
    };
    // @ts-expect-error [MOCK] - partial RPC response is enough for this assertion.
    vi.mocked(supabase.rpc).mockResolvedValue({ data: refusal, error: null });

    const { result } = renderHook(() => useFields());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.fields).toHaveLength(1);

    /** @type {any} */
    let outcome;
    await act(async () => {
      outcome = await result.current.deleteField('field-1');
    });

    expect(outcome).toEqual(refusal);
    expect(result.current.fields).toHaveLength(1);
    expect(result.current.fields[0].id).toBe('field-1');

    // Confirming passes the flag through rather than calling a different RPC.
    // @ts-expect-error [MOCK] - partial RPC response is enough for this assertion.
    vi.mocked(supabase.rpc).mockResolvedValue({ data: { deleted: true }, error: null });
    await act(async () => {
      await result.current.deleteField('field-1', { confirm: true });
    });
    expect(supabase.rpc).toHaveBeenCalledWith('admin_delete_field', {
      p_organization_id: 'org-1',
      p_field_id: 'field-1',
      p_confirm: true,
    });
    await waitFor(() => expect(result.current.fields).toHaveLength(0));
  });

  it('raises on a response it cannot read rather than calling it a refusal', async () => {
    // **Unreadable is not "nothing is booked".** Returning `{deleted:false}`
    // here made the page offer a consequence preview reading "0 booking(s)",
    // which an operator reasonably takes as "this field is empty". The field
    // still must not leave the list, so this raises rather than guessing in
    // either direction.
    // @ts-expect-error [MOCK] - the point of this case is an unreadable payload.
    vi.mocked(supabase.rpc).mockResolvedValue({ data: null, error: null });

    const { result } = renderHook(() => useFields());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await expect(result.current.deleteField('field-1')).rejects.toThrow(/no readable result/);
    expect(result.current.fields).toHaveLength(1);
  });
});
