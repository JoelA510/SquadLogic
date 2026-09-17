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

  it('retires through the RPC, unconfirmed first, and hands the refusal back', async () => {
    // **The unconfirmed call IS the dry run.** `public.field_bookings` has
    // EXECUTE revoked from `authenticated`, so the only reading of "what is
    // booked here" a browser can get is the one the guard computed. A refusal
    // is therefore a successful question, not a failure.
    const refusal = {
      retired: false,
      reason: 'bookings_after_effective_to',
      affected_count: 2,
      affected: [
        { kind: 'game_slot', id: 'gs-1', on_date: '2026-10-01', undated: false, unbounded: false },
        { kind: 'practice_slot', id: 'ps-1', on_date: null, undated: false, unbounded: true },
      ],
    };
    // @ts-expect-error [MOCK] - partial RPC response is enough for this assertion.
    vi.mocked(supabase.rpc).mockResolvedValue({ data: refusal, error: null });

    const { result } = renderHook(() => useFields());
    await waitFor(() => expect(result.current.loading).toBe(false));

    /** @type {any} */
    let outcome;
    await act(async () => {
      outcome = await result.current.retireField('field-1', { effectiveTo: '2026-09-30' });
    });

    expect(supabase.rpc).toHaveBeenCalledWith('admin_retire_field', {
      p_organization_id: 'org-1',
      p_field_id: 'field-1',
      p_effective_to: '2026-09-30',
      p_confirm: false,
    });
    expect(outcome).toEqual(refusal);
    // **No `disposition` on this arm, and nothing here invents one.** A
    // retirement destroys nothing, so the SQL twin emits six keys and not that
    // one; a caller filling it in would put a word the database never said in
    // front of the person deciding.
    for (const row of outcome.affected) {
      expect(row).not.toHaveProperty('disposition');
    }

    // @ts-expect-error [MOCK] - partial RPC response is enough for this assertion.
    vi.mocked(supabase.rpc).mockResolvedValue({
      data: { retired: true, affected_count: 2, field: { id: 'field-1' } },
      error: null,
    });
    await act(async () => {
      await result.current.retireField('field-1', {
        effectiveTo: '2026-09-30',
        confirm: true,
      });
    });
    expect(supabase.rpc).toHaveBeenCalledWith('admin_retire_field', {
      p_organization_id: 'org-1',
      p_field_id: 'field-1',
      p_effective_to: '2026-09-30',
      p_confirm: true,
    });
  });

  it('refuses to retire with no end date, before the RPC is called', async () => {
    const { result } = renderHook(() => useFields());
    await waitFor(() => expect(result.current.loading).toBe(false));
    vi.mocked(supabase.rpc).mockClear();

    await expect(
      // @ts-expect-error [MOCK] - the point of this case is the missing date.
      result.current.retireField('field-1', {})
    ).rejects.toThrow(/end date is required/);
    // The positive control for the sentence above: the guard fired BEFORE any
    // call, rather than after one the database refused.
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it('raises on a retirement response it cannot read', async () => {
    // @ts-expect-error [MOCK] - the point of this case is an unreadable payload.
    vi.mocked(supabase.rpc).mockResolvedValue({ data: { affected_count: 3 }, error: null });
    const { result } = renderHook(() => useFields());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await expect(
      result.current.retireField('field-1', { effectiveTo: '2026-09-30' })
    ).rejects.toThrow(/no readable result/);
  });

  it('clears an end date through admin_unretire_field', async () => {
    // @ts-expect-error [MOCK] - partial RPC response is enough for this assertion.
    vi.mocked(supabase.rpc).mockResolvedValue({
      data: { retired: false, field: { id: 'field-1', effective_to: null } },
      error: null,
    });
    const { result } = renderHook(() => useFields());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.unretireField('field-1');
    });
    expect(supabase.rpc).toHaveBeenCalledWith('admin_unretire_field', {
      p_organization_id: 'org-1',
      p_field_id: 'field-1',
    });
  });

  /**
   * The two depths 20260911000000 added.
   *
   * **The four wrappers are ONE implementation parameterised by depth, so the
   * table below is what stops that generalisation from quietly collapsing.**
   * Every case is driven from `DEPTHS`, which names the RPC and the id
   * parameter for each depth: a wrapper wired to the wrong RPC, or passing
   * `p_location_id` where `p_field_subunit_id` belongs, fails its own row
   * rather than being covered by a sibling's passing test.
   */
  const DEPTHS = [
    {
      label: 'venue',
      retire: 'retireLocation',
      unretire: 'unretireLocation',
      retireRpc: 'admin_retire_location',
      unretireRpc: 'admin_unretire_location',
      idParam: 'p_location_id',
      id: 'location-1',
      rowKey: 'location',
    },
    {
      label: 'sub-surface',
      retire: 'retireFieldSubunit',
      unretire: 'unretireFieldSubunit',
      retireRpc: 'admin_retire_field_subunit',
      unretireRpc: 'admin_unretire_field_subunit',
      idParam: 'p_field_subunit_id',
      id: 'subunit-1',
      rowKey: 'field_subunit',
    },
  ];

  // The meta-assertion for the table itself: a `DEPTHS` emptied by a bad edit
  // would make every `it.each` below vanish silently and the file would still
  // report green.
  it('covers both new depths', () => {
    expect(DEPTHS).toHaveLength(2);
  });

  it.each(DEPTHS)('$label: retires through its own RPC, unconfirmed first', async (depth) => {
    // @ts-expect-error [MOCK] - partial RPC response is enough for this assertion.
    vi.mocked(supabase.rpc).mockResolvedValue({
      data: { retired: false, reason: 'bookings_after_effective_to', affected_count: 1 },
      error: null,
    });
    const { result } = renderHook(() => useFields());
    await waitFor(() => expect(result.current.loading).toBe(false));

    let refusal = /** @type {any} */ (undefined);
    await act(async () => {
      refusal = await result.current[depth.retire](depth.id, { effectiveTo: '2026-09-30' });
    });

    expect(supabase.rpc).toHaveBeenCalledWith(depth.retireRpc, {
      p_organization_id: 'org-1',
      [depth.idParam]: depth.id,
      p_effective_to: '2026-09-30',
      p_confirm: false,
    });
    // **A refusal is handed back, not thrown and not read as success.** It
    // arrives with PostgREST's `error` null, which is how four separate tools
    // in PR 2 read a refusal as a commit.
    expect(refusal).toMatchObject({ retired: false, reason: 'bookings_after_effective_to' });
  });

  it.each(DEPTHS)('$label: refuses to retire with no end date, before the RPC', async (depth) => {
    const { result } = renderHook(() => useFields());
    await waitFor(() => expect(result.current.loading).toBe(false));
    vi.mocked(supabase.rpc).mockClear();

    await expect(result.current[depth.retire](depth.id, { effectiveTo: '' })).rejects.toThrow(
      /end date is required/i
    );
    // Not attempted at all: an end date is what makes it a retirement rather
    // than a deletion.
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it.each(DEPTHS)('$label: raises on a response it cannot read', async (depth) => {
    // @ts-expect-error [MOCK] - the point of the test is the unreadable shape.
    vi.mocked(supabase.rpc).mockResolvedValue({ data: { something_else: true }, error: null });
    const { result } = renderHook(() => useFields());
    await waitFor(() => expect(result.current.loading).toBe(false));

    // "0 bookings affected" for an answer we cannot read tells the operator the
    // ground is clear when the truth is that we do not know.
    await expect(
      result.current[depth.retire](depth.id, { effectiveTo: '2026-09-30' })
    ).rejects.toThrow(new RegExp(depth.retireRpc));
    await expect(result.current[depth.unretire](depth.id)).rejects.toThrow(
      new RegExp(depth.unretireRpc)
    );
  });

  it.each(DEPTHS)('$label: clears an end date through its own RPC', async (depth) => {
    // @ts-expect-error [MOCK] - partial RPC response is enough for this assertion.
    vi.mocked(supabase.rpc).mockResolvedValue({
      data: { retired: false, [depth.rowKey]: { id: depth.id, effective_to: null } },
      error: null,
    });
    const { result } = renderHook(() => useFields());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current[depth.unretire](depth.id);
    });
    expect(supabase.rpc).toHaveBeenCalledWith(depth.unretireRpc, {
      p_organization_id: 'org-1',
      [depth.idParam]: depth.id,
    });
  });

  it('hands `contained` back untouched at venue depth, and manufactures none at sub-surface depth', async () => {
    const CONTAINED = [
      { kind: 'field', id: 'f-1', name: 'North', own_effective_to: null, already_retired: false },
      {
        kind: 'field_subunit',
        id: 'su-1',
        name: 'North A',
        own_effective_to: '2026-08-01',
        already_retired: true,
      },
    ];
    // @ts-expect-error [MOCK] - partial RPC response is enough for this assertion.
    vi.mocked(supabase.rpc).mockResolvedValue({
      data: {
        retired: false,
        reason: 'bookings_after_effective_to',
        affected_count: 1,
        affected: [{ kind: 'game_slot', id: 'gs-1' }],
        contained_count: 1,
        contained: CONTAINED,
      },
      error: null,
    });
    const { result } = renderHook(() => useFields());
    await waitFor(() => expect(result.current.loading).toBe(false));

    let refusal = /** @type {any} */ (undefined);
    await act(async () => {
      refusal = await result.current.retireLocation('location-1', { effectiveTo: '2026-09-30' });
    });
    // Enumerated from the fixture, not from what came back: a node dropped in
    // transit is a missing entry rather than an absent expectation.
    expect(refusal.contained).toHaveLength(CONTAINED.length);
    for (const node of CONTAINED) {
      expect(refusal.contained).toContainEqual(node);
    }
    // The count is the RPC's own -- it counts only the NOT-already-retired
    // nodes, so it is 1 where the list is 2, and a wrapper that recomputed it
    // from the list would have said 2.
    expect(refusal.contained_count).toBe(1);

    // **The sub-surface arm ships no `contained` key**, and the wrapper must
    // not invent an empty one: absent means "the leaf of the estate holds
    // nothing", `[]` would mean "we looked and found none".
    // @ts-expect-error [MOCK] - partial RPC response is enough for this assertion.
    vi.mocked(supabase.rpc).mockResolvedValue({
      data: { retired: false, reason: 'bookings_after_effective_to', affected_count: 1 },
      error: null,
    });
    let subRefusal = /** @type {any} */ (undefined);
    await act(async () => {
      subRefusal = await result.current.retireFieldSubunit('subunit-1', {
        effectiveTo: '2026-09-30',
      });
    });
    expect('contained' in subRefusal).toBe(false);
  });
});
