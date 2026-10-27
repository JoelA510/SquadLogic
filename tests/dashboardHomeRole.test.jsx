// Who gets which Home (docs/changes/2026-10-27-admin-only.md, F2): an admin, a staff member and a
// tenant admin get the league overview; any other role (a stale `coach`, `parent` or `player`:
// none signs in) gets the no-role notice and nothing is read for it. There is no coach home.
import React from 'react';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DashboardPage from '../frontend/src/pages/DashboardPage.jsx';

const mocks = vi.hoisted(() => ({ role: 'admin', rpc: vi.fn(), from: vi.fn() }));

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...props }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
  useLocation: () => ({ state: null }),
  useNavigate: () => vi.fn(),
}));

vi.mock('../frontend/src/hooks/usePermission.js', () => ({
  usePermission: () => ({ can: () => false, role: mocks.role, PERMISSIONS: {} }),
}));

vi.mock('../frontend/src/contexts/AuthContext.jsx', () => ({
  useAuth: () => ({ user: { id: 'u1', email: 'u1@example.test', profile: { first_name: 'Una' } } }),
}));

vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: () => ({
    currentOrganization: { id: 'org-a', name: 'Org A' },
    currentSeasonSetting: { id: 's1', name: 'Fall' },
    featureFlags: {},
  }),
}));

vi.mock('../frontend/src/hooks/useSetupProgress.js', () => ({
  useSetupProgress: () => ({ steps: [], complete: true, loading: false }),
}));

vi.mock('../frontend/src/hooks/useFeatures.js', () => ({
  useFeatures: () => ({ genderModel: 'binary', isEnabled: () => false, features: {} }),
}));

vi.mock('../frontend/src/hooks/useFacilityPermits.js', () => ({
  usePermitWarnings: () => null,
}));

vi.mock('../frontend/src/lib/supabaseClient.js', () => ({
  supabase: { rpc: (name, params) => mocks.rpc(name, params), from: (t) => mocks.from(t) },
}));

vi.mock('../frontend/src/lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), log: vi.fn() },
}));

/** A query builder that answers every read with no rows. */
const emptyQuery = () => {
  const q = new Proxy(
    {},
    {
      get: (_target, prop) =>
        prop === 'then'
          ? (resolve) => Promise.resolve({ data: [], error: null, count: 0 }).then(resolve)
          : () => q,
    }
  );
  return q;
};

beforeEach(() => {
  mocks.rpc.mockReset();
  mocks.rpc.mockResolvedValue({ data: [], error: null });
  mocks.from.mockReset();
  mocks.from.mockImplementation(() => emptyQuery());
});

describe('DashboardPage: which Home a role gets', () => {
  it.each(['admin', 'staff', 'tenant_admin'])('gives %s the league overview', async (role) => {
    mocks.role = role;
    render(<DashboardPage />);
    expect(await screen.findByRole('heading', { name: /Welcome back, Una/ })).toBeVisible();
    expect(screen.queryByText(/no role in this organization/)).not.toBeInTheDocument();
    expect(mocks.from).toHaveBeenCalled();
  });

  it('gives a role not loaded yet the overview, as before', async () => {
    mocks.role = undefined;
    render(<DashboardPage />);
    expect(await screen.findByRole('heading', { name: /Welcome back, Una/ })).toBeVisible();
  });

  it.each(['coach', 'parent', 'player', 'guardian', 'visitor'])(
    'gives %s the no-role notice and reads nothing',
    (role) => {
      mocks.role = role;
      render(<DashboardPage />);
      expect(
        screen.getByText(/no role in this organization that SquadLogic recognizes/)
      ).toBeVisible();
      expect(screen.queryByRole('heading', { name: /Welcome back/ })).not.toBeInTheDocument();
      expect(screen.queryByText(/Your team/)).not.toBeInTheDocument();
      expect(mocks.rpc).not.toHaveBeenCalled();
      expect(mocks.from).not.toHaveBeenCalled();
    }
  );
});
