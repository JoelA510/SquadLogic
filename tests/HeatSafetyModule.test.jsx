/**
 * HeatSafetyModule: the save confirmation survives the reload a save triggers,
 * and a failed read shows the error with no editable form to overwrite unseen
 * settings.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import HeatSafetyModule from '../frontend/src/components/settings/modules/HeatSafetyModule.jsx';
import { supabase } from '../frontend/src/lib/supabaseClient.js';

vi.mock('../frontend/src/lib/supabaseClient.js', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
}));
const org = vi.hoisted(() => ({ id: 'org-1' }));
vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: () => ({ currentOrganization: { id: org.id } }),
}));
vi.mock('../frontend/src/hooks/usePermission.js', () => ({
  usePermission: () => ({
    can: () => true,
    PERMISSIONS: { MANAGE_ORGANIZATION: 'manage_organization' },
  }),
}));
vi.mock('../frontend/src/lib/logger.js', () => ({ logger: { error: vi.fn() } }));

/** A builder whose `maybeSingle` resolves to each result in turn. */
function reads(...results) {
  const queue = [...results];
  const builder = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    maybeSingle: vi.fn(() => Promise.resolve(queue.length > 1 ? queue.shift() : queue[0])),
  };
  return builder;
}

beforeEach(() => {
  org.id = 'org-1';
  vi.mocked(supabase.from).mockReset();
  vi.mocked(supabase.rpc).mockReset();
});

describe('HeatSafetyModule', () => {
  it('says the settings were saved after the reload a save triggers', async () => {
    vi.mocked(supabase.from).mockReturnValue(
      /** @type {any} */ (
        reads(
          { data: null, error: null },
          { data: { threshold_category: 2, guidance_links: [] }, error: null }
        )
      )
    );
    vi.mocked(supabase.rpc).mockResolvedValue(/** @type {any} */ ({ data: {}, error: null }));
    render(<HeatSafetyModule />);
    fireEvent.click(await screen.findByLabelText(/Category 2/));
    fireEvent.click(screen.getByRole('button', { name: 'Save heat settings' }));
    expect(await screen.findByText('Heat settings saved.')).toBeTruthy();
    expect(screen.getByText('Configured for this organization.')).toBeTruthy();
  });

  it('does not carry the saved message into another organisation', async () => {
    vi.mocked(supabase.from).mockReturnValue(
      /** @type {any} */ (
        reads(
          { data: null, error: null },
          { data: { threshold_category: 2, guidance_links: [] }, error: null }
        )
      )
    );
    vi.mocked(supabase.rpc).mockResolvedValue(/** @type {any} */ ({ data: {}, error: null }));
    const { rerender } = render(<HeatSafetyModule />);
    fireEvent.click(await screen.findByLabelText(/Category 2/));
    fireEvent.click(screen.getByRole('button', { name: 'Save heat settings' }));
    expect(await screen.findByText('Heat settings saved.')).toBeTruthy();
    org.id = 'org-2';
    rerender(<HeatSafetyModule />);
    await screen.findByRole('button', { name: 'Save heat settings' });
    expect(screen.queryByText('Heat settings saved.')).toBeNull();
  });

  it('a failed read shows the error and no form to save over it', async () => {
    vi.mocked(supabase.from).mockReturnValue(
      /** @type {any} */ (reads({ data: null, error: { message: 'relation does not exist' } }))
    );
    render(<HeatSafetyModule />);
    expect(await screen.findByRole('alert')).toHaveTextContent('relation does not exist');
    expect(screen.queryByRole('button', { name: 'Save heat settings' })).toBeNull();
  });
});
