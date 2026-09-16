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
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import BlackoutsPage from '../frontend/src/pages/BlackoutsPage.jsx';
import { useFields } from '../frontend/src/hooks/useFields.js';
import { useFieldClosures } from '../frontend/src/hooks/useFieldClosures.js';
import { supabase } from '../frontend/src/lib/supabaseClient.js';
import { useOrganization } from '../frontend/src/contexts/OrganizationContext.jsx';

vi.mock('../frontend/src/hooks/useFields.js', () => ({ useFields: vi.fn() }));
// **Partial**, because the editor imports `BlackoutDraftSchema` from this same
// module. Replacing the whole module would have left the dialog validating
// against nothing -- and the edit cases below drive it through the dialog.
vi.mock('../frontend/src/hooks/useFieldClosures.js', async (importOriginal) => ({
  .../** @type {any} */ (await importOriginal()),
  useFieldClosures: vi.fn(),
}));
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
      updateBlackout: vi.fn(),
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

  it('offers no Remove or Edit control on an import-owned window', async () => {
    mockHooks({
      closures: { closures: [{ ...CLOSURE, id: 'win-1', source: 'field_blackout_windows' }] },
    });
    renderPage();
    await waitFor(() => expect(screen.getByText('from an import')).toBeInTheDocument());
    // `field_blackout_windows` is FROZEN and no RPC writes or deletes a row in
    // it, so either control here would be a button that cannot work.
    expect(screen.queryByRole('button', { name: /^Remove the blackout/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Edit the blackout/ })).not.toBeInTheDocument();
    expect(screen.getByText('import-owned')).toBeInTheDocument();
  });

  it('edits a window in place through updateBlackout, never through remove-and-re-add', async () => {
    const updateBlackout = vi.fn().mockResolvedValue({ id: 'bo-1' });
    const createBlackout = vi.fn();
    const removeBlackout = vi.fn();
    mockHooks({ closures: { updateBlackout, createBlackout, removeBlackout } });
    renderPage();

    // Located through the accessibility tree, so an unlabelled control fails to
    // be found rather than being silently clicked by test id.
    const edit = await screen.findByRole('button', {
      name: 'Edit the blackout on North Field from 2026-09-14',
    });
    fireEvent.click(edit);

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Edit this blackout window');
    // The form opened on THIS window rather than on a blank one.
    expect(screen.getByLabelText(/^First day/)).toHaveValue('2026-09-14');
    expect(screen.getByLabelText(/^Last day/)).toHaveValue('2026-09-18');
    expect(screen.getByLabelText('Reason')).toHaveValue('maintenance');
    // Scope is shown and locked: the RPC has no parameter for it.
    expect(screen.getByLabelText('What does this close?')).toBeDisabled();
    expect(screen.getByLabelText(/^Field/)).toBeDisabled();
    expect(screen.getByTestId('blackout-scope-locked')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/^Last day/), { target: { value: '2026-09-20' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(updateBlackout).toHaveBeenCalledTimes(1));
    expect(updateBlackout.mock.calls[0][0]).toMatchObject({ id: 'bo-1' });
    expect(updateBlackout.mock.calls[0][1]).toMatchObject({
      blackoutFrom: '2026-09-14',
      blackoutUntil: '2026-09-20',
      scopeId: 'field-1',
    });
    // **The positive control for "an edit is an edit".** Before 20260910000000
    // this screen could only have done it as a remove followed by a create, and
    // that is the outcome this case exists to refuse.
    expect(removeBlackout).not.toHaveBeenCalled();
    expect(createBlackout).not.toHaveBeenCalled();
  });

  it('refuses to open an editor on a window ending at 24:00, rather than blanking the box', async () => {
    // `minutesToClock(1440)` is `24:00`, which `<input type="time">` cannot
    // hold. Nothing loaded an existing window into this form before this PR, so
    // the case was unreachable; it is reachable now and is named rather than
    // left as an empty "Closed until" the operator did not empty.
    mockHooks({
      closures: { closures: [{ ...CLOSURE, startMinutes: 1080, endMinutes: 1440 }] },
    });
    renderPage();
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Edit the blackout on North Field from 2026-09-14',
      })
    );
    expect(await screen.findByTestId('blackout-unrepresentable')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  });
});
