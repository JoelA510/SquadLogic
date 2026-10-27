/**
 * The reports page's attribute picker has an accessible name. axe's `select-name` flagged it on
 * `/admin/reports` once the organization held more than three players
 * (`tests/e2e/features/accessibility.feature`); a bare `<select>` beside a heading is announced as
 * "combo box" with nothing to say what it chooses.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import EnterpriseDashboard from '../frontend/src/pages/EnterpriseDashboard.jsx';

const sizes = ['Small', 'Medium', 'Large'];
const players = Array.from({ length: 6 }, (_, index) => ({
  id: `p${index}`,
  custom_attributes: { jersey_size: sizes[index % sizes.length] },
}));

vi.mock('../frontend/src/lib/supabaseClient.js', () => {
  const rowsFor = (table) => (table === 'players' ? players : null);
  const query = (table) => {
    const result = { data: rowsFor(table), error: null };
    const chain = {
      select: () => chain,
      eq: () => chain,
      order: () => chain,
      range: () => chain,
      single: () => Promise.resolve({ data: null, error: null }),
      then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
    };
    return chain;
  };
  return { supabase: { from: query } };
});

vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: () => ({ currentOrganization: { id: 'org-1', settings: {} } }),
}));

describe('EnterpriseDashboard attribute picker', () => {
  it('is named by what it chooses', async () => {
    render(<EnterpriseDashboard />);
    const picker = await screen.findByRole('combobox', { name: 'Attribute to chart' });
    expect(picker).toHaveValue('jersey_size');
  });
});
