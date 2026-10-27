// Home for a membership whose role SquadLogic no longer has (R3, migration
// 20261024010000 removed `parent` and `player`; docs/changes/2026-10-27-admin-only.md removed
// `coach`): a notice, and no read of anything an admin's home would read.
import React from 'react';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DashboardPage from '../frontend/src/pages/DashboardPage.jsx';

const mocks = vi.hoisted(() => ({ role: 'parent', rpc: vi.fn(), from: vi.fn() }));

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
  useAuth: () => ({ user: { id: 'pat', email: 'pat@example.test' } }),
}));

vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: () => ({ currentOrganization: { id: 'org-a' }, featureFlags: {} }),
}));

vi.mock('../frontend/src/lib/supabaseClient.js', () => ({
  supabase: { rpc: (name, params) => mocks.rpc(name, params), from: (t) => mocks.from(t) },
}));

vi.mock('../frontend/src/lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), log: vi.fn() },
}));

beforeEach(() => {
  mocks.rpc.mockReset();
  mocks.from.mockReset();
});

describe('DashboardPage for a stale role', () => {
  it.each(['coach', 'parent', 'player'])(
    'shows a %s the no-role notice and reads nothing',
    (role) => {
      mocks.role = role;
      render(<DashboardPage />);
      expect(
        screen.getByText(/no role in this organization that SquadLogic recognizes/)
      ).toBeVisible();
      expect(mocks.rpc).not.toHaveBeenCalled();
      expect(mocks.from).not.toHaveBeenCalled();
    }
  );
});
