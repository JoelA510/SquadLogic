import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import React from 'react';
import { makeOrganization, makeOrganizationMember, makeUser } from './factories/index.js';

// ---------- Mocks ----------

vi.mock('../frontend/src/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    setUser: vi.fn(),
    setDemoContext: vi.fn(),
  },
}));

vi.mock('../frontend/src/lib/supabaseClient', () => ({
  supabase: {
    auth: {
      onAuthStateChange: vi.fn(),
      signOut: vi.fn(),
    },
    from: vi.fn(),
    // OrganizationContext links the signed-in user to their coach record
    // before it loads the organizations (link_my_coach_record).
    rpc: vi.fn().mockResolvedValue({ data: { status: 'no_match' }, error: null }),
  },
}));

// Shared mutable state accessible by the hoisted mock factory.
const authState = vi.hoisted(() => ({
  user: null,
}));

vi.mock('../frontend/src/contexts/AuthContext.jsx', async () => {
  const React = await import('react');
  const { createContext, useContext, useState, useEffect } = React;

  const AuthContext = createContext({});
  const useAuth = () => useContext(AuthContext);

  const AuthProvider = ({ children }) => {
    const [user, setUser] = useState(authState.user);

    useEffect(() => {
      setUser(authState.user);
    }, []);

    return React.createElement(
      AuthContext.Provider,
      {
        value: {
          user,
          session: user ? { user } : null,
          loading: false,
          signOut: vi.fn(),
          isConfigured: true,
          isAdmin: true,
          isCoach: false,
        },
      },
      children
    );
  };

  return { useAuth, AuthProvider };
});

import { supabase } from '../frontend/src/lib/supabaseClient.js';
import { logger } from '../frontend/src/lib/logger.js';
import { AuthProvider, useAuth } from '../frontend/src/contexts/AuthContext.jsx';
import {
  OrganizationProvider,
  useOrganization,
} from '../frontend/src/contexts/OrganizationContext.jsx';
import { MOCK_ORG_ID } from '../frontend/src/lib/mockSeedIds.js';

// ---------- Helpers ----------

/** Flush microtasks + React scheduler by waiting one macro-tick inside act. */
const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 10));
  });

// ---------- Tests ----------

const TestComponent = () => {
  const { user } = useAuth();
  const { currentOrganization, loading } = useOrganization();

  return (
    <div>
      <div data-testid="user-email">{user?.email ?? ''}</div>
      <div data-testid="org-loading">{String(loading)}</div>
      <div data-testid="org-name">{currentOrganization?.name || 'No Org'}</div>
    </div>
  );
};

describe('Auth & Organization Integration', () => {
  const mockUser = makeUser({
    id: 'user-123',
    email: 'test@example.com',
    app_metadata: {},
    user_metadata: {},
    aud: 'authenticated',
    created_at: '2025-01-01T00:00:00Z',
  });

  const mockOrgMember = makeOrganizationMember({
    organization_id: MOCK_ORG_ID,
    role: 'admin',
    organizations: makeOrganization({ id: MOCK_ORG_ID, name: 'Test Club' }),
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(supabase.auth.onAuthStateChange).mockReturnValue(
      /** @type {any} */ ({
        data: { subscription: { unsubscribe: vi.fn() } },
      })
    );

    // Provide a minimal localStorage stub — jsdom may not expose a working
    // localStorage when Node is started without --localstorage-file.
    const store = {};
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key) => store[key] ?? null),
      setItem: vi.fn((key, val) => {
        store[key] = String(val);
      }),
      removeItem: vi.fn((key) => {
        delete store[key];
      }),
      clear: vi.fn(() => {
        Object.keys(store).forEach((k) => delete store[k]);
      }),
    });

    // @ts-expect-error [MOCK] - partial mock for test isolation; Supabase from() requires more comprehensive type mapping for full coverage
    vi.mocked(supabase.from).mockImplementation((table) => {
      if (table === 'organization_members') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({ data: [mockOrgMember], error: null }),
          }),
        };
      }
      if (table === 'season_settings') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              order: vi.fn().mockResolvedValue({ data: [], error: null }),
            }),
          }),
        };
      }
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockResolvedValue({ data: [], error: null }),
        }),
      };
    });
  });

  it('should load user and fetch organizations', async () => {
    authState.user = mockUser;

    await act(async () => {
      render(
        <AuthProvider>
          <OrganizationProvider>
            <TestComponent />
          </OrganizationProvider>
        </AuthProvider>
      );
    });

    // Flush several times to settle nested async chains:
    // Tick 1: OrganizationContext useEffect fires, fetchOrgs starts, org query promise created
    // Tick 2: org query resolves, setCurrentOrganization, fetchSeasonsForOrg starts
    // Tick 3: season query resolves, setLoading(false)
    for (let i = 0; i < 5; i++) {
      await flush();
    }

    // --- Diagnostics ---
    const fromCalls = vi.mocked(supabase.from).mock.calls.map((c) => c[0]);
    const errorCalls = vi.mocked(logger.error).mock.calls;

    // Check that the org query was actually issued
    expect(fromCalls).toContain('organization_members');

    // Check that no silent errors occurred
    expect(errorCalls).toEqual([]);

    // Assert final state
    expect(screen.getByTestId('user-email')).toHaveTextContent('test@example.com');
    expect(screen.getByTestId('org-loading')).toHaveTextContent('false');
    expect(screen.getByTestId('org-name')).toHaveTextContent('Test Club');
  });

  it('shows No Org when user is not authenticated', async () => {
    authState.user = null;

    await act(async () => {
      render(
        <AuthProvider>
          <OrganizationProvider>
            <TestComponent />
          </OrganizationProvider>
        </AuthProvider>
      );
    });

    await flush();

    expect(screen.getByTestId('org-name')).toHaveTextContent('No Org');
    expect(supabase.from).not.toHaveBeenCalledWith('organization_members');
  });
});
