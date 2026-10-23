// @vitest-environment jsdom
/**
 * B3 (DS-15): `EnterpriseDashboard` sends its independent reads together.
 * (`AdminReportingDashboard`, the other DS-15 page, was unrouted and is deleted
 * by the owner's 2026-10-19 call. The DS-9 "View As" cases went with the
 * Compliance page they exercised, removed in R1 of
 * docs/changes/2026-10-22-admin-focus.md.)
 *
 * And the Reports page has no Compliance axis: `view_compliance_stats` went
 * with the registrations it counted (R1), so the page neither reads it nor
 * charts it.
 *
 * The Supabase client is a fake whose every read stays pending until the test
 * resolves it, so "how many reads were in flight before the first answered" is
 * observable: a page that awaits its reads one after another has exactly one.
 */
import React from 'react';
import { render, screen, waitFor, act, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  /** @type {Array<{ table: string, resolve: (v: any) => void }>} */
  pending: [],
  /** @type {string[]} */
  fromCalls: [],
}));

vi.mock('../frontend/src/lib/supabaseClient.js', () => {
  const builder = (table) => {
    const b = {
      select: () => b,
      eq: () => b,
      order: () => b,
      single: () => b,
      then: (onOk, onErr) =>
        new Promise((resolve) => {
          mocks.pending.push({ table, resolve });
        }).then(onOk, onErr),
    };
    return b;
  };
  return {
    supabase: {
      from: (table) => {
        mocks.fromCalls.push(table);
        return builder(table);
      },
    },
  };
});

vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: () => ({ currentOrganization: { id: 'org-1', settings: {} } }),
}));
vi.mock('../frontend/src/contexts/AnalyticsContext.jsx', () => ({
  useEnterpriseMetrics: () => ({ aggregates: {}, isLowSample: false, maskedFields: [] }),
}));
vi.mock('../frontend/src/lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import EnterpriseDashboard from '../frontend/src/pages/EnterpriseDashboard.jsx';

beforeEach(() => {
  mocks.pending.length = 0;
  mocks.fromCalls.length = 0;
});

/** Resolve every read still pending, as an empty successful answer. */
async function answerAll() {
  await act(async () => {
    mocks.pending.splice(0).forEach(({ resolve }) => resolve({ data: [], error: null }));
  });
}

describe('DS-15: the dashboards send independent reads together', () => {
  it('EnterpriseDashboard has both reads in flight before either answers', async () => {
    render(<EnterpriseDashboard />);
    await waitFor(() => expect(mocks.pending).toHaveLength(2));
    expect(mocks.pending.map((p) => p.table).sort()).toEqual(['players', 'view_org_metrics']);
    await answerAll();
    expect(await screen.findByText('Enterprise Dashboard')).toBeInTheDocument();
  });

  it('charts readiness without a Compliance axis and never reads view_compliance_stats', async () => {
    render(<EnterpriseDashboard />);
    await waitFor(() => expect(mocks.pending).toHaveLength(2));
    await answerAll();
    const table = await screen.findByRole('table', { name: /Organization Readiness/ });
    const metrics = within(table)
      .getAllByRole('row')
      .slice(1)
      .map((row) => within(row).getAllByRole('cell')[0].textContent);
    expect(metrics).toEqual(['Staffing', 'Balance', 'Skill Variability']);
    expect(screen.queryByText(/Network Readiness/)).not.toBeInTheDocument();
    expect(mocks.fromCalls).not.toContain('view_compliance_stats');
  });
});
