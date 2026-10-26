/**
 * The reports page reads every player. PostgREST cuts an unranged select at `max_rows = 1000`, so a
 * league of 1,259 drew its distributions and its total from the first thousand. The read pages,
 * and a page that fails is an error on the page, not a smaller league.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import EnterpriseDashboard from '../frontend/src/pages/EnterpriseDashboard.jsx';

const mocks = vi.hoisted(() => ({ total: 0, refuseFrom: null }));

vi.mock('../frontend/src/lib/supabaseClient.js', () => ({
  supabase: {
    from: (table) => {
      let from = 0;
      let to = Infinity;
      const chain = {
        select: () => chain,
        eq: () => chain,
        order: () => chain,
        range: (a, b) => {
          from = a;
          to = b;
          return chain;
        },
        single: () => Promise.resolve({ data: null, error: null }),
        then: (resolve, reject) => {
          if (table !== 'players')
            return Promise.resolve({ data: null, error: null }).then(resolve, reject);
          if (mocks.refuseFrom !== null && from >= mocks.refuseFrom) {
            return Promise.resolve({ data: null, error: new Error('page refused') }).then(
              resolve,
              reject
            );
          }
          // The server's cap: at most 1000 rows, whatever range was asked for.
          const count = Math.min(Math.max(Math.min(to, mocks.total - 1) - from + 1, 0), 1000);
          const data = Array.from({ length: count }, (_, i) => ({
            id: `p${from + i}`,
            custom_attributes: { jersey_size: 'Small' },
          }));
          return Promise.resolve({ data, error: null }).then(resolve, reject);
        },
      };
      return chain;
    },
  },
}));
vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: () => ({ currentOrganization: { id: 'org-1', settings: {} } }),
}));

describe('EnterpriseDashboard players read', () => {
  beforeEach(() => {
    mocks.total = 1259;
    mocks.refuseFrom = null;
  });

  it('counts every player of a league past the server row cap', async () => {
    render(<EnterpriseDashboard />);
    expect(await screen.findByText('1259')).toBeInTheDocument();
  });

  it('a refused page is an error on the page, not a smaller league', async () => {
    mocks.refuseFrom = 1000;
    render(<EnterpriseDashboard />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Players could not be loaded');
    expect(alert).toHaveTextContent('page refused');
    expect(screen.queryByText('1000')).toBeNull();
  });
});
