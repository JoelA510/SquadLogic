import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { BlackoutDraftSchema, useFieldClosures } from '../frontend/src/hooks/useFieldClosures.js';
import { supabase } from '../frontend/src/lib/supabaseClient.js';
import { useOrganization } from '../frontend/src/contexts/OrganizationContext.jsx';

vi.mock('../frontend/src/lib/supabaseClient.js', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
}));
vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: vi.fn(),
}));
vi.mock('../frontend/src/lib/logger.js', () => ({ logger: { error: vi.fn() } }));

const CLOSURE_ROWS = [
  {
    id: 'bo-1',
    organization_id: 'org-1',
    closes_field_id: 'field-1',
    closes_location_id: null,
    field_location_id: 'loc-1',
    blackout_from: '2026-09-14',
    blackout_until: '2026-09-18',
    start_minutes: null,
    end_minutes: null,
    reason: 'maintenance',
    note: 'reseeding',
    source_reason_text: null,
    source: 'field_blackouts',
  },
  {
    id: 'win-1',
    organization_id: 'org-1',
    closes_field_id: null,
    closes_location_id: null,
    field_location_id: null,
    blackout_from: '2026-10-01',
    blackout_until: '2026-10-02',
    start_minutes: null,
    end_minutes: null,
    reason: null,
    note: null,
    source_reason_text: 'imported: field unavailable',
    source: 'field_blackout_windows',
  },
];

function readBuilder(result) {
  const builder = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    order: vi.fn(() => Promise.resolve(result)),
  };
  return builder;
}

const draft = (overrides = {}) => ({
  scope: 'field',
  scopeId: 'field-1',
  blackoutFrom: '2026-09-14',
  blackoutUntil: '2026-09-18',
  allDay: true,
  startMinutes: null,
  endMinutes: null,
  reason: 'maintenance',
  note: null,
  ...overrides,
});

describe('useFieldClosures', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // @ts-expect-error [MOCK] - a partial organization context is enough here.
    vi.mocked(useOrganization).mockReturnValue({ currentOrganization: { id: 'org-1' } });
    vi.mocked(supabase.from).mockImplementation(
      () => /** @type {any} */ (readBuilder({ data: CLOSURE_ROWS, error: null }))
    );
    // @ts-expect-error [MOCK] - partial RPC response is enough for these assertions.
    vi.mocked(supabase.rpc).mockResolvedValue({ data: { id: 'bo-2' }, error: null });
  });

  it('reads field_closures, not either blackout table', async () => {
    const { result } = renderHook(() => useFieldClosures());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(supabase.from).toHaveBeenCalledWith('field_closures');
    // The positive control for the line above: neither underlying table is
    // touched. The whole point of the view is that "is this ground closed" has
    // one answer, and a caller reaching past it puts the union back.
    expect(vi.mocked(supabase.from).mock.calls.flat()).not.toContain('field_blackouts');
    expect(vi.mocked(supabase.from).mock.calls.flat()).not.toContain('field_blackout_windows');

    expect(result.current.closures).toHaveLength(2);
    // `field_location_id` is a different fact from the scope and must not be
    // carried across as one — the two were one column once and a location
    // filter therefore closed every other pitch on the site.
    expect(result.current.closures[0]).not.toHaveProperty('fieldLocationId');
    expect(result.current.closures[0].closesFieldId).toBe('field-1');
    // The import arm's own words travel under their own name, never in `note`.
    expect(result.current.closures[1].note).toBeNull();
    expect(result.current.closures[1].sourceReasonText).toBe('imported: field unavailable');
  });

  it('creates through the RPC with the scope on exactly one column', async () => {
    const { result } = renderHook(() => useFieldClosures());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.createBlackout(draft());
    });
    expect(supabase.rpc).toHaveBeenCalledWith('admin_create_field_blackout', {
      p_organization_id: 'org-1',
      p_location_id: null,
      p_field_id: 'field-1',
      p_blackout_from: '2026-09-14',
      p_blackout_until: '2026-09-18',
      p_start_minutes: null,
      p_end_minutes: null,
      p_reason: 'maintenance',
      p_note: null,
    });

    await act(async () => {
      await result.current.createBlackout(draft({ scope: 'location', scopeId: 'loc-1' }));
    });
    const last = vi.mocked(supabase.rpc).mock.calls.at(-1);
    expect(last?.[1]).toMatchObject({ p_location_id: 'loc-1', p_field_id: null });
  });

  it('refuses to remove an import-owned window, naming why', async () => {
    const { result } = renderHook(() => useFieldClosures());
    await waitFor(() => expect(result.current.loading).toBe(false));
    vi.mocked(supabase.rpc).mockClear();

    await expect(
      result.current.removeBlackout({ id: 'win-1', source: 'field_blackout_windows' })
    ).rejects.toThrow(/import/i);
    // **The positive control.** `field_blackout_windows` is FROZEN and no RPC
    // deletes from it; the guard has to fire BEFORE a call, not after one that
    // silently did nothing.
    expect(supabase.rpc).not.toHaveBeenCalled();

    // @ts-expect-error [MOCK] - partial RPC response is enough for this assertion.
    vi.mocked(supabase.rpc).mockResolvedValue({ data: { deleted: true }, error: null });
    await act(async () => {
      await result.current.removeBlackout({ id: 'bo-1', source: 'field_blackouts' });
    });
    expect(supabase.rpc).toHaveBeenCalledWith('admin_delete_field_blackout', {
      p_organization_id: 'org-1',
      p_blackout_id: 'bo-1',
    });
  });

  it('raises on a payload it cannot read, on both writes', async () => {
    const { result } = renderHook(() => useFieldClosures());
    await waitFor(() => expect(result.current.loading).toBe(false));

    // @ts-expect-error [MOCK] - the point of this case is an unreadable payload.
    vi.mocked(supabase.rpc).mockResolvedValue({ data: null, error: null });
    await expect(result.current.createBlackout(draft())).rejects.toThrow(/no readable result/);

    // @ts-expect-error [MOCK] - a delete that reports neither success nor refusal.
    vi.mocked(supabase.rpc).mockResolvedValue({ data: { deleted: false }, error: null });
    await expect(
      result.current.removeBlackout({ id: 'bo-1', source: 'field_blackouts' })
    ).rejects.toThrow(/no readable result/);
  });
});

describe('BlackoutDraftSchema', () => {
  it('accepts an all-day window and a timed one', () => {
    expect(BlackoutDraftSchema.safeParse(draft()).success).toBe(true);
    expect(
      BlackoutDraftSchema.safeParse(draft({ allDay: false, startMinutes: 960, endMinutes: 1020 }))
        .success
    ).toBe(true);
  });

  it('mirrors every CHECK the table carries, and each one can fail', () => {
    // One case per constraint, so a relaxed rule fails here rather than at the
    // database after the operator has filled the form in.
    const CASES = [
      [draft({ blackoutUntil: '2026-09-01' }), /must not fall before/],
      [draft({ allDay: true, startMinutes: 960, endMinutes: 1020 }), /carries no times/],
      [draft({ allDay: false, startMinutes: 960, endMinutes: null }), /both a start and an end/],
      [draft({ allDay: false, startMinutes: 1020, endMinutes: 1020 }), /after the start/],
      [draft({ scopeId: '' }), /choose the venue or field/],
      [draft({ reason: 'storm' }), /./],
      [draft({ note: 'x'.repeat(201) }), /./],
    ];
    expect(CASES.length).toBeGreaterThan(0);
    for (const [value, pattern] of CASES) {
      const parsed = BlackoutDraftSchema.safeParse(value);
      expect([value, parsed.success]).toEqual([value, false]);
      expect(parsed.error?.issues.map((issue) => issue.message).join(' ')).toMatch(
        /** @type {RegExp} */ (pattern)
      );
    }
  });
});
