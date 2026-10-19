// @vitest-environment jsdom
/**
 * B3 (DS-9, DS-15): `EnterpriseDashboard` sends its independent reads together,
 * and a failed "preview as" is said out loud. (`AdminReportingDashboard`, the
 * other DS-15 page, was unrouted and is deleted by the owner's 2026-10-19 call.)
 *
 * The Supabase client is a fake whose every read stays pending until the test
 * resolves it, so "how many reads were in flight before the first answered" is
 * observable: a page that awaits its reads one after another has exactly one.
 */
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { fireEvent, render, screen, waitFor, act } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  /** @type {Array<{ table: string, resolve: (v: any) => void }>} */
  pending: [],
  /** @type {string[]} */
  fromCalls: [],
  /** @type {Record<string, any> | null} */
  immediate: null,
  toast: vi.fn(),
  auth: /** @type {any} */ ({}),
  impersonateUser: vi.fn(),
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
          if (mocks.immediate) resolve(mocks.immediate[table] ?? { data: [], error: null });
          else mocks.pending.push({ table, resolve });
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
vi.mock('../frontend/src/contexts/AuthContext.jsx', () => ({ useAuth: () => mocks.auth }));
vi.mock('../frontend/src/contexts/AnalyticsContext.jsx', () => ({
  useEnterpriseMetrics: () => ({ aggregates: {}, isLowSample: false, maskedFields: [] }),
}));
vi.mock('../frontend/src/components/ui/ToastHost.jsx', () => ({ useToast: () => mocks.toast }));
vi.mock('../frontend/src/hooks/usePlayersData.js', () => ({
  usePlayersData: () => ({ players: [], divisions: [], loading: false, updatePlayer: vi.fn() }),
}));
vi.mock('../frontend/src/hooks/useFeatures.js', () => ({
  useFeatures: () => ({ isEnabled: () => false, genderModel: 'boys_girls' }),
}));
vi.mock('../frontend/src/lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import EnterpriseDashboard from '../frontend/src/pages/EnterpriseDashboard.jsx';
import AdminComplianceDashboard from '../frontend/src/pages/AdminComplianceDashboard.jsx';

beforeEach(() => {
  mocks.pending.length = 0;
  mocks.fromCalls.length = 0;
  mocks.immediate = null;
  mocks.toast.mockReset();
  mocks.impersonateUser.mockReset();
  mocks.auth = {
    isAdmin: true,
    isImpersonating: false,
    user: { id: 'admin-1', email: 'a@example.test', profile: { id: 'admin-1' } },
    impersonateUser: mocks.impersonateUser,
  };
});

/** Resolve every read still pending, as an empty successful answer. */
async function answerAll() {
  await act(async () => {
    mocks.pending.splice(0).forEach(({ resolve }) => resolve({ data: [], error: null }));
  });
}

describe('DS-15: the dashboards send independent reads together', () => {
  it('EnterpriseDashboard has all three reads in flight before any answers', async () => {
    render(<EnterpriseDashboard />);
    await waitFor(() => expect(mocks.pending).toHaveLength(3));
    expect(mocks.pending.map((p) => p.table).sort()).toEqual([
      'players',
      'view_compliance_stats',
      'view_org_metrics',
    ]);
    await answerAll();
    expect(await screen.findByText('Enterprise Dashboard')).toBeInTheDocument();
  });
});

describe('DS-9: a failed "View As" is surfaced', () => {
  const reg = {
    id: 'reg-1',
    waiver_signed: true,
    medical_cleared: false,
    created_at: '2026-03-01T00:00:00Z',
    players: { id: 'p1', first_name: 'Sam', last_name: 'Player' },
    profiles: { id: 'parent-1', first_name: 'Pat', last_name: 'Parent', email: 'p@example.test' },
  };

  beforeEach(() => {
    mocks.immediate = {
      registration_forms: { data: [{ id: 'f1', title: 'Spring', status: 'open' }], error: null },
      registrations: { data: [reg], error: null },
    };
  });

  it('toasts instead of leaving an unhandled rejection when impersonateUser rejects', async () => {
    mocks.impersonateUser.mockRejectedValue(new Error('rpc down'));
    render(
      <MemoryRouter>
        <AdminComplianceDashboard />
      </MemoryRouter>
    );
    fireEvent.click(await screen.findByRole('button', { name: /View As/ }));
    await waitFor(() =>
      expect(mocks.toast).toHaveBeenCalledWith(expect.stringMatching(/Could not start/), 'warning')
    );
    expect(mocks.impersonateUser).toHaveBeenCalledWith(reg.profiles);
  });

  it('says nothing when the preview starts', async () => {
    mocks.impersonateUser.mockResolvedValue(undefined);
    render(
      <MemoryRouter>
        <AdminComplianceDashboard />
      </MemoryRouter>
    );
    fireEvent.click(await screen.findByRole('button', { name: /View As/ }));
    await waitFor(() => expect(mocks.impersonateUser).toHaveBeenCalled());
    expect(mocks.toast).not.toHaveBeenCalled();
  });
});
