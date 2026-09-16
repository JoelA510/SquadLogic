/**
 * `BlackoutsPage` — the two properties the E2E suite structurally cannot see.
 *
 * 1. **The page must not unmount itself on a write.** `useFieldClosures.refresh`
 *    sets `loading` on every call and both writes await it, so a full-page
 *    `<LoadingScreen />` gated on that flag tore down the open editor mid-submit
 *    and flashed a spinner on every Remove. The E2E step asserts the dialog is
 *    gone after Save, which a full-page spinner satisfies — so the suite agreed
 *    with the defect.
 * 2. **A failed field read has to be visible.** Without it every row reads
 *    "Unknown field" and, worse, the field registry is empty, so every
 *    venue-scoped closure reports 0 conflicts — a clean-looking grid built on a
 *    read that failed.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import BlackoutsPage from '../frontend/src/pages/BlackoutsPage.jsx';
import { useFields } from '../frontend/src/hooks/useFields.js';
import { useFieldClosures } from '../frontend/src/hooks/useFieldClosures.js';
import { supabase } from '../frontend/src/lib/supabaseClient.js';
import { useOrganization } from '../frontend/src/contexts/OrganizationContext.jsx';

vi.mock('../frontend/src/hooks/useFields.js', () => ({ useFields: vi.fn() }));
vi.mock('../frontend/src/hooks/useFieldClosures.js', () => ({ useFieldClosures: vi.fn() }));
vi.mock('../frontend/src/lib/supabaseClient.js', () => ({ supabase: { from: vi.fn() } }));
vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({ useOrganization: vi.fn() }));
vi.mock('../frontend/src/lib/logger.js', () => ({ logger: { error: vi.fn() } }));

const FIELDS = [{ id: 'field-1', name: 'North Field', location_id: 'loc-1' }];
const LOCATIONS = [{ id: 'loc-1', name: 'Riverside Park' }];

const CLOSURE = {
  id: 'bo-1',
  source: 'field_blackouts',
  closesFieldId: 'field-1',
  closesLocationId: null,
  blackoutFrom: '2026-09-14',
  blackoutUntil: '2026-09-18',
  startMinutes: null,
  endMinutes: null,
  reason: 'maintenance',
  note: null,
  sourceReasonText: null,
};

function selectBuilder(rows) {
  const builder = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => Promise.resolve({ data: rows, error: null })),
  };
  return builder;
}

function mockHooks({ fields = {}, closures = {} } = {}) {
  vi.mocked(useFields).mockReturnValue(
    /** @type {any} */ ({
      locations: LOCATIONS,
      fields: FIELDS,
      availabilityProfiles: [],
      loading: false,
      error: null,
      ...fields,
    })
  );
  vi.mocked(useFieldClosures).mockReturnValue(
    /** @type {any} */ ({
      closures: [CLOSURE],
      loading: false,
      error: null,
      refresh: vi.fn(),
      createBlackout: vi.fn(),
      removeBlackout: vi.fn(),
      ...closures,
    })
  );
}

const renderPage = () =>
  render(
    <MemoryRouter>
      <BlackoutsPage />
    </MemoryRouter>
  );

describe('BlackoutsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // @ts-expect-error [MOCK] - a partial organization context is enough here.
    vi.mocked(useOrganization).mockReturnValue({ currentOrganization: { id: 'org-1' } });
    vi.mocked(supabase.from).mockImplementation(
      (table) =>
        /** @type {any} */ (
          selectBuilder(
            table === 'game_slots'
              ? [
                  {
                    id: 'gs-1',
                    field_id: 'field-1',
                    slot_date: '2026-09-16',
                    start_time: '16:00:00',
                    end_time: '17:00:00',
                  },
                ]
              : []
          )
        )
    );
  });

  it('lists a closure with its source and its conflict count', async () => {
    mockHooks();
    renderPage();
    await waitFor(() => expect(screen.getByText('North Field')).toBeInTheDocument());
    expect(screen.getByText('entered here')).toBeInTheDocument();
    // The seeded game slot on the 16th sits inside 09-14..09-18.
    await waitFor(() => expect(screen.getByText('1')).toBeInTheDocument());
  });

  it('stays mounted while a write refreshes underneath it', async () => {
    mockHooks();
    const { rerender } = renderPage();
    await waitFor(() => expect(screen.getByText('North Field')).toBeInTheDocument());

    // The state a write puts the hook in: `loading` true again, rows still held.
    mockHooks({ closures: { loading: true } });
    rerender(
      <MemoryRouter>
        <BlackoutsPage />
      </MemoryRouter>
    );

    // **The grid is still there.** A page gated on `loading` would have
    // replaced everything with a spinner, taking the open editor with it.
    expect(screen.getByText('North Field')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add blackout' })).toBeInTheDocument();
  });

  it('shows a spinner on the FIRST load only', () => {
    // The positive control for the case above: the spinner is not simply gone.
    mockHooks({ closures: { loading: true, closures: [] }, fields: { loading: true } });
    renderPage();
    expect(screen.queryByRole('button', { name: 'Add blackout' })).not.toBeInTheDocument();
  });

  it('surfaces a failed field read as well as a failed closure read', async () => {
    mockHooks({
      fields: { error: 'locations could not be loaded', fields: [], locations: [] },
      closures: { error: 'closures could not be loaded' },
    });
    renderPage();
    await waitFor(() => expect(screen.getAllByRole('alert')).toHaveLength(2));
    const messages = screen.getAllByRole('alert').map((node) => node.textContent);
    expect(messages).toContain('locations could not be loaded');
    expect(messages).toContain('closures could not be loaded');
  });

  it('offers no Remove control on an import-owned window', async () => {
    mockHooks({
      closures: { closures: [{ ...CLOSURE, id: 'win-1', source: 'field_blackout_windows' }] },
    });
    renderPage();
    await waitFor(() => expect(screen.getByText('from an import')).toBeInTheDocument());
    // `field_blackout_windows` is FROZEN and no RPC deletes from it, so a
    // control here would be a button that cannot work.
    expect(screen.queryByRole('button', { name: /^Remove the blackout/ })).not.toBeInTheDocument();
    expect(screen.getByText('import-owned')).toBeInTheDocument();
  });
});
