/**
 * The password change's audit row names the organization the admin is working in
 * (docs/changes/2026-10-27-admin-only.md, F5). An admin can belong to several; the old fallback
 * read their memberships with `.single()`, which errors for an admin of two, and the profile's
 * `organization_id` is null on every production profile.
 */
import React from 'react';
import { act, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ORG_A = '11111111-1111-4111-8111-aaaaaaaaaaaa';
const ORG_B = '22222222-2222-4222-8222-bbbbbbbbbbbb';
const PROFILE_ORG = '99999999-9999-4999-8999-999999999999';

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  updateUser: vi.fn(),
  memberships: /** @type {any[]} */ ([]),
  membershipError: /** @type {any} */ (null),
}));

vi.mock('../frontend/src/lib/logger.js', () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    setUser: vi.fn(),
    setDemoContext: vi.fn(),
  },
}));

vi.mock('../frontend/src/lib/supabaseClient.js', () => {
  const session = { user: { id: 'admin-1', email: 'admin@example.test' } };
  return {
    supabase: {
      auth: {
        getSession: () => Promise.resolve({ data: { session } }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
        updateUser: (args) => mocks.updateUser(args),
        signOut: vi.fn(),
      },
      from: (table) => ({
        select: () => ({
          eq: (column, value) => {
            if (table === 'profiles') {
              return {
                single: () =>
                  Promise.resolve({
                    data: { id: value, organization_id: PROFILE_ORG, role: 'user' },
                    error: null,
                  }),
              };
            }
            return Promise.resolve({
              data: mocks.membershipError ? null : mocks.memberships,
              error: mocks.membershipError,
            });
          },
        }),
      }),
      rpc: (name, params) => mocks.rpc(name, params),
    },
  };
});

const { AuthProvider, useAuth } = await import('../frontend/src/contexts/AuthContext.jsx');

async function mountAuth() {
  /** @type {{ current: any }} */
  const seen = { current: null };
  function Probe() {
    seen.current = useAuth();
    return null;
  }
  render(
    <AuthProvider>
      <Probe />
    </AuthProvider>
  );
  await waitFor(() => expect(seen.current.user?.profile).toBeTruthy());
  return seen;
}

const audits = () => mocks.rpc.mock.calls.filter(([name]) => name === 'record_audit_event');

beforeEach(() => {
  localStorage.clear();
  mocks.rpc.mockReset();
  mocks.rpc.mockResolvedValue({ data: null, error: null });
  mocks.updateUser.mockReset();
  mocks.updateUser.mockResolvedValue({ data: { user: { id: 'admin-1' } }, error: null });
  mocks.memberships = [{ organization_id: ORG_A }, { organization_id: ORG_B }];
  mocks.membershipError = null;
});

describe('updatePassword audit row', () => {
  it('names the organization the caller passes, not the profile’s and not a membership read', async () => {
    const seen = await mountAuth();
    /** @type {any} */
    let result;
    await act(async () => {
      result = await seen.current.updatePassword('a-long-enough-password', {
        organizationId: ORG_B,
      });
    });
    expect(result).toEqual({ error: null });
    expect(audits()).toEqual([
      [
        'record_audit_event',
        {
          p_organization_id: ORG_B,
          p_action: 'auth.password_updated',
          p_metadata: { user_id: 'admin-1' },
        },
      ],
    ]);
  });

  it('without an organization (the reset page), uses the stored active one the admin belongs to', async () => {
    localStorage.setItem('squadlogic_active_org', ORG_B);
    const seen = await mountAuth();
    await act(async () => {
      await seen.current.updatePassword('a-long-enough-password');
    });
    expect(audits().map(([, params]) => params.p_organization_id)).toEqual([ORG_B]);
  });

  it('without an organization or a usable stored one, uses the first membership, and does not error for an admin of two', async () => {
    localStorage.setItem('squadlogic_active_org', 'not-a-membership');
    const seen = await mountAuth();
    /** @type {any} */
    let result;
    await act(async () => {
      result = await seen.current.updatePassword('a-long-enough-password');
    });
    expect(result).toEqual({ error: null });
    expect(audits().map(([, params]) => params.p_organization_id)).toEqual([ORG_A]);
  });

  it('still changes the password, and audits nothing, when the memberships cannot be read', async () => {
    mocks.membershipError = { code: '500', message: 'boom' };
    const seen = await mountAuth();
    /** @type {any} */
    let result;
    await act(async () => {
      result = await seen.current.updatePassword('a-long-enough-password');
    });
    expect(result).toEqual({ error: null });
    expect(mocks.updateUser).toHaveBeenCalledTimes(1);
    expect(audits()).toEqual([]);
  });

  it('reports a refused password change, and audits nothing', async () => {
    mocks.updateUser.mockResolvedValue({ data: {}, error: new Error('weak password') });
    const seen = await mountAuth();
    /** @type {any} */
    let result;
    await act(async () => {
      result = await seen.current.updatePassword('x', { organizationId: ORG_A });
    });
    expect(result?.error?.message).toBe('weak password');
    expect(audits()).toEqual([]);
  });
});
