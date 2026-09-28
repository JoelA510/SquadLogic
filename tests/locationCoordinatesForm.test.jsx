/**
 * 8.9 PR 3b: the facility-admin venue coordinates form.
 *
 * The page, the real `useFields` hook and the form run together; only the
 * Supabase client, the organisation context and the permission gate are
 * mocked. So an assertion on `supabase.rpc` is an assertion on what the page
 * actually sends, and an RPC error reaches the screen through the real hook.
 *
 * **Every coordinate here is synthetic** (40.00/-75.00, 41.50/-73.50 and
 * deliberately out-of-range values). None is a real venue's. Nothing geocodes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const { supabase } = vi.hoisted(() => ({ supabase: { from: vi.fn(), rpc: vi.fn() } }));
vi.mock('../frontend/src/lib/supabaseClient.js', () => ({ supabase }));
vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: () => ({ currentOrganization: { id: 'org-1' } }),
}));
vi.mock('../frontend/src/hooks/usePermission.js', () => ({ usePermission: vi.fn() }));

import FieldManagementPage from '../frontend/src/pages/FieldManagementPage.jsx';
import LocationCoordinatesForm from '../frontend/src/components/setup/LocationCoordinatesForm.jsx';
import { usePermission } from '../frontend/src/hooks/usePermission.js';

const RPC = 'admin_set_location_coordinates';

/** @type {Record<string, any[]>} */
let tables = {};

/** A PostgREST-shaped chain that resolves to the table's rows. */
function chainFor(table) {
  const result = { data: tables[table] || [], error: null };
  const chain = {
    select: () => chain,
    eq: () => chain,
    order: () => chain,
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  };
  return chain;
}

function venue(overrides) {
  return {
    id: 'loc-1',
    organization_id: 'org-1',
    name: 'Synthetic Park',
    effective_to: null,
    lighting_available: false,
    latitude: null,
    longitude: null,
    ...overrides,
  };
}

async function renderPage({ locations, admin = true }) {
  tables = { locations, fields: [], field_availability_profiles: [] };
  vi.mocked(usePermission).mockReturnValue(
    /** @type {any} */ ({ can: () => admin, role: admin ? 'admin' : 'coach' })
  );
  render(<FieldManagementPage />);
  await screen.findByTestId(`venue-${locations[0].id}`);
}

async function openCoordinates(name = 'Synthetic Park') {
  fireEvent.click(screen.getByRole('button', { name: `Coordinates for ${name}` }));
}

function type(label, value) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function coordinateCalls() {
  return supabase.rpc.mock.calls.filter(([name]) => name === RPC);
}

beforeEach(() => {
  vi.clearAllMocks();
  supabase.from.mockImplementation(chainFor);
});

describe('venue coordinates form: save', () => {
  it('sends the typed values and shows the pair the RPC stored, not the input', async () => {
    await renderPage({ locations: [venue()] });
    await openCoordinates();
    // The RPC, not the form, rounds (D9): the form sends what was typed.
    supabase.rpc.mockResolvedValueOnce({
      data: { id: 'loc-1', organization_id: 'org-1', latitude: 40, longitude: -75 },
      error: null,
    });
    type('Latitude', '40.004');
    type('Longitude', '-74.996');
    fireEvent.click(screen.getByRole('button', { name: 'Save coordinates' }));

    await waitFor(() => expect(coordinateCalls()).toHaveLength(1));
    expect(coordinateCalls()[0][1]).toEqual({
      p_location_id: 'loc-1',
      p_latitude: 40.004,
      p_longitude: -74.996,
    });
    // The display is the RPC's rounded answer, in the stored line, the inputs
    // and the status message alike.
    await waitFor(() =>
      expect(screen.getByTestId('venue-coordinates-stored-loc-1')).toHaveTextContent(
        '40.00, -75.00'
      )
    );
    expect(screen.getByLabelText('Latitude')).toHaveValue('40.00');
    expect(screen.getByLabelText('Longitude')).toHaveValue('-75.00');
    expect(screen.getByTestId('venue-coordinates-status-loc-1')).toHaveTextContent(
      'Saved as 40.00, -75.00.'
    );
    // The venue was unlit with no pair; the RPC's answer clears its badge.
    expect(screen.queryByTestId('venue-no-coordinates-loc-1')).not.toBeInTheDocument();
  });

  it('shows the privacy note and ties it to both inputs', async () => {
    await renderPage({ locations: [venue()] });
    await openCoordinates();
    const note = screen.getByText(/about 1 km precision/);
    expect(note).toHaveTextContent('used only to work out sunset times');
    for (const label of ['Latitude', 'Longitude']) {
      expect(screen.getByLabelText(label).getAttribute('aria-describedby')).toContain(note.id);
    }
  });

  it('Clear sends null/null and shows the venue as not set', async () => {
    await renderPage({ locations: [venue({ latitude: 41.5, longitude: -73.5 })] });
    await openCoordinates();
    expect(screen.getByTestId('venue-coordinates-stored-loc-1')).toHaveTextContent('41.50, -73.50');
    supabase.rpc.mockResolvedValueOnce({
      data: { id: 'loc-1', organization_id: 'org-1', latitude: null, longitude: null },
      error: null,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Clear coordinates' }));

    await waitFor(() => expect(coordinateCalls()).toHaveLength(1));
    expect(coordinateCalls()[0][1]).toEqual({
      p_location_id: 'loc-1',
      p_latitude: null,
      p_longitude: null,
    });
    await waitFor(() =>
      expect(screen.getByTestId('venue-coordinates-stored-loc-1')).toHaveTextContent('Not set')
    );
    expect(screen.getByTestId('venue-coordinates-status-loc-1')).toHaveTextContent(
      'Coordinates cleared.'
    );
  });
});

describe('venue coordinates form: a refetch', () => {
  it('re-seeds the inputs as well as the stored line, so Save cannot resend a stale pair', () => {
    const onSave = vi.fn();
    const { rerender } = render(
      <LocationCoordinatesForm
        location={venue({ latitude: 41.5, longitude: -73.5 })}
        canEdit
        onSave={onSave}
      />
    );
    expect(screen.getByLabelText('Latitude')).toHaveValue('41.50');
    rerender(
      <LocationCoordinatesForm
        location={venue({ latitude: 40, longitude: -75 })}
        canEdit
        onSave={onSave}
      />
    );
    expect(screen.getByTestId('venue-coordinates-stored-loc-1')).toHaveTextContent('40.00, -75.00');
    expect(screen.getByLabelText('Latitude')).toHaveValue('40.00');
    expect(screen.getByLabelText('Longitude')).toHaveValue('-75.00');
  });
});

describe('venue coordinates form: client-side validation (LocationCoordinatesSchema)', () => {
  /**
   * Each case names the field its error must sit on. A case that sent the RPC
   * would be a validation the server alone performed.
   */
  const BLOCKED = [
    { name: 'half pair, longitude missing', lat: '40.00', lng: '', field: 'Longitude' },
    { name: 'half pair, latitude missing', lat: '', lng: '-75.00', field: 'Latitude' },
    { name: 'latitude above 90', lat: '90.004', lng: '-75.00', field: 'Latitude' },
    { name: 'latitude below -90', lat: '-91', lng: '-75.00', field: 'Latitude' },
    { name: 'longitude above 180', lat: '40.00', lng: '181', field: 'Longitude' },
    { name: 'longitude below -180', lat: '40.00', lng: '-180.5', field: 'Longitude' },
    { name: 'not a number', lat: 'north', lng: '-75.00', field: 'Latitude' },
  ];

  it.each(BLOCKED)('blocks $name with a field error and no RPC call', async (c) => {
    await renderPage({ locations: [venue()] });
    await openCoordinates();
    type('Latitude', c.lat);
    type('Longitude', c.lng);
    fireEvent.click(screen.getByRole('button', { name: 'Save coordinates' }));

    const input = await waitFor(() => {
      const el = screen.getByLabelText(c.field);
      expect(el).toHaveAttribute('aria-invalid', 'true');
      return el;
    });
    const errorId = `coords-loc-1-${c.field.toLowerCase()}-error`;
    expect(input.getAttribute('aria-describedby')).toContain(errorId);
    const error = document.getElementById(errorId);
    expect(error).not.toBeNull();
    expect(error?.textContent).toMatch(/between|both|number/);
    // Focus moves to the field that needs fixing.
    expect(document.activeElement).toBe(input);
    expect(coordinateCalls()).toHaveLength(0);
  });

  it('does not read a blank Save as a clear', async () => {
    await renderPage({ locations: [venue({ latitude: 41.5, longitude: -73.5 })] });
    await openCoordinates();
    type('Latitude', '');
    type('Longitude', '');
    fireEvent.click(screen.getByRole('button', { name: 'Save coordinates' }));
    await waitFor(() =>
      expect(screen.getByLabelText('Latitude')).toHaveAttribute('aria-invalid', 'true')
    );
    expect(coordinateCalls()).toHaveLength(0);
  });
});

describe('venue coordinates form: every RPC refusal reaches the screen', () => {
  /**
   * **Enumerated from the migration, not from this file.** Every
   * `RAISE EXCEPTION ... USING ERRCODE` in the RPC is a refusal the form must
   * surface; a new one added there is picked up here without an edit.
   */
  const MIGRATION = readFileSync(
    path.resolve(process.cwd(), 'supabase/migrations/20260930000000_location_coordinates.sql'),
    'utf8'
  );
  const REFUSALS = [
    ...MIGRATION.matchAll(/RAISE EXCEPTION '((?:[^']|'')*)'[^;]*?USING ERRCODE = '([0-9A-Z]{5})'/g),
  ].map(([, message, code]) => ({
    code,
    // `%` is the location id placeholder; `''` is an escaped quote.
    message: message.replace(/%/g, 'loc-1').replace(/''/g, "'"),
  }));

  it('found the refusals it is about to exercise', () => {
    // A regex that matched nothing would make the loop below pass vacuously.
    expect(REFUSALS.length).toBeGreaterThanOrEqual(5);
    // Cross-check against the codes the migration header and plan name.
    expect(new Set(REFUSALS.map((r) => r.code))).toEqual(
      new Set(['23502', 'P0002', '42501', '22023'])
    );
  });

  it.each(REFUSALS)('surfaces $code: $message', async ({ code, message }) => {
    await renderPage({ locations: [venue()] });
    await openCoordinates();
    supabase.rpc.mockResolvedValueOnce({ data: null, error: { code, message } });
    type('Latitude', '41.50');
    type('Longitude', '-73.50');
    fireEvent.click(screen.getByRole('button', { name: 'Save coordinates' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(message);
    expect(alert).toHaveTextContent(code);
    // A refusal leaves the stored pair as it was.
    expect(screen.getByTestId('venue-coordinates-stored-loc-1')).toHaveTextContent('Not set');
    expect(screen.getByTestId('venue-coordinates-status-loc-1')).toHaveTextContent('');
  });
});

describe('venue coordinates form: admin only', () => {
  it('shows a non-admin the stored values read-only, with no inputs and no actions', async () => {
    await renderPage({ locations: [venue({ latitude: 41.5, longitude: -73.5 })], admin: false });
    await openCoordinates();
    expect(screen.getByTestId('venue-coordinates-readonly-loc-1')).toBeInTheDocument();
    expect(screen.getByTestId('venue-coordinates-stored-loc-1')).toHaveTextContent('41.50, -73.50');
    expect(screen.queryByTestId('venue-coordinates-form-loc-1')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Latitude')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Longitude')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save coordinates' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Clear coordinates' })).not.toBeInTheDocument();
  });

  it('shows an admin the form (the same query, so the non-admin test is not vacuous)', async () => {
    await renderPage({ locations: [venue()] });
    await openCoordinates();
    expect(screen.getByTestId('venue-coordinates-form-loc-1')).toBeInTheDocument();
    expect(screen.getByLabelText('Latitude')).toBeInTheDocument();
  });
});

describe('venue list: the missing-coordinates badge', () => {
  /**
   * Lit venues need no coordinates (plan §2). Unlit ones, and undeclared ones
   * (D5: treated as unlit), get SUNSET_UNKNOWN without them (D4).
   */
  const VENUES = [
    { id: 'v-lit-none', lighting_available: true, lat: null, lng: null, badge: false },
    { id: 'v-lit-set', lighting_available: true, lat: 40, lng: -75, badge: false },
    { id: 'v-unlit-none', lighting_available: false, lat: null, lng: null, badge: true },
    { id: 'v-unlit-set', lighting_available: false, lat: 41.5, lng: -73.5, badge: false },
    { id: 'v-undeclared-none', lighting_available: null, lat: null, lng: null, badge: true },
  ];

  it('appears only for a venue that is not lit and has no coordinates', async () => {
    // Both outcomes are present, so neither half of the check is vacuous.
    expect(VENUES.some((v) => v.badge)).toBe(true);
    expect(VENUES.some((v) => !v.badge)).toBe(true);
    await renderPage({
      locations: VENUES.map((v) =>
        venue({
          id: v.id,
          name: v.id,
          lighting_available: v.lighting_available,
          latitude: v.lat,
          longitude: v.lng,
        })
      ),
    });
    // Enumerated from the fixture, not the rendered list.
    for (const v of VENUES) {
      expect(screen.getByTestId(`venue-${v.id}`)).toBeInTheDocument();
      const badge = screen.queryByTestId(`venue-no-coordinates-${v.id}`);
      if (v.badge) expect(badge, v.id).toHaveTextContent('No coordinates');
      else expect(badge, v.id).toBeNull();
    }
  });
});
