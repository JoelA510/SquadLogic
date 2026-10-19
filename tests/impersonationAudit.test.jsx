/**
 * B3 / DS-9: starting a role preview is refused when its audit row cannot be
 * written. supabase-js returns an RPC failure as `{ error }` and does not throw
 * it, so `impersonateUser` used to start the preview unlogged and the callers'
 * error handling (the TopBar and compliance-dashboard toasts) never ran.
 *
 * Real AuthProvider; only the Supabase client and the logger are replaced.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';
import React, { useEffect } from 'react';

vi.mock('../frontend/src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), setUser: vi.fn() },
}));

vi.mock('../frontend/src/lib/supabaseClient.js', () => ({
  supabase: {
    auth: { getSession: vi.fn(), onAuthStateChange: vi.fn(), signOut: vi.fn() },
    from: vi.fn(),
    rpc: vi.fn(),
  },
}));

import { supabase } from '../frontend/src/lib/supabaseClient.js';
import { AuthProvider, useAuth } from '../frontend/src/contexts/AuthContext.jsx';

const ADMIN_ID = '00000000-0000-4000-8000-0000000000a1';
const ORG = '00000000-0000-4000-8000-00000000000a';
const session = { access_token: 't', user: { id: ADMIN_ID, email: 'admin@example.test' } };
const profile = { id: ADMIN_ID, organization_id: ORG, role: 'admin' };
const target = { id: '00000000-0000-4000-8000-0000000000b2', organization_id: ORG, role: 'parent' };

/** The last context value the probe saw (an object, so the component does not reassign a module variable). */
/** @type {{ auth: any }} */
const seen = { auth: null };
function Probe() {
  const value = useAuth();
  useEffect(() => {
    seen.auth = value;
  });
  return null;
}

const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 10));
  });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('localStorage', {
    getItem: vi.fn(() => null),
    setItem: vi.fn(),
    removeItem: vi.fn(),
    clear: vi.fn(),
  });
  vi.mocked(supabase.auth.getSession).mockResolvedValue(/** @type {any} */ ({ data: { session } }));
  vi.mocked(supabase.auth.onAuthStateChange).mockImplementation(
    /** @type {any} */ (() => ({ data: { subscription: { unsubscribe: vi.fn() } } }))
  );
  vi.mocked(supabase.from).mockImplementation(
    /** @type {any} */ (
      (table) => {
        if (table === 'profiles') {
          return {
            select: () => ({
              eq: () => ({ single: () => Promise.resolve({ data: profile, error: null }) }),
            }),
          };
        }
        if (table === 'organization_members') {
          return { select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }) };
        }
        return {
          select: () => ({
            eq: () => ({ order: () => Promise.resolve({ data: [], error: null }) }),
          }),
        };
      }
    )
  );
});

async function mountSignedInAdmin() {
  render(
    <AuthProvider>
      <Probe />
    </AuthProvider>
  );
  await flush();
  expect(seen.auth.isAdmin).toBe(true); // exercised: the provider resolved the admin
}

describe('impersonateUser', () => {
  it('starts the preview once the audit row is written', async () => {
    vi.mocked(supabase.rpc).mockResolvedValue(
      /** @type {any} */ ({ data: 'audit-1', error: null })
    );
    await mountSignedInAdmin();
    await act(async () => seen.auth.impersonateUser(target));
    expect(supabase.rpc).toHaveBeenCalledWith(
      'record_audit_event',
      expect.objectContaining({ p_action: 'impersonation.started' })
    );
    expect(seen.auth.isImpersonating).toBe(true);
  });

  it('rejects, and does not start the preview, when the audit row comes back as an error', async () => {
    vi.mocked(supabase.rpc).mockResolvedValue(
      /** @type {any} */ ({ data: null, error: { code: '23503', message: 'audit_actions fk' } })
    );
    await mountSignedInAdmin();
    let rejection;
    await act(async () => {
      rejection = await seen.auth.impersonateUser(target).catch((e) => e);
    });
    expect(rejection).toMatchObject({ code: '23503' });
    expect(seen.auth.isImpersonating).toBe(false);
  });
});

describe('stopImpersonation', () => {
  it('leaves the preview, without rejecting, when the end-audit call throws', async () => {
    vi.mocked(supabase.rpc)
      .mockResolvedValueOnce(/** @type {any} */ ({ data: 'audit-1', error: null }))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await mountSignedInAdmin();
    await act(async () => seen.auth.impersonateUser(target));
    expect(seen.auth.isImpersonating).toBe(true); // exercised: the preview was on

    let rejection = null;
    await act(async () => {
      rejection = await seen.auth.stopImpersonation().then(
        () => null,
        (e) => e
      );
    });
    expect(supabase.rpc).toHaveBeenLastCalledWith(
      'record_audit_event',
      expect.objectContaining({ p_action: 'impersonation.ended' })
    );
    expect(rejection).toBeNull();
    expect(seen.auth.isImpersonating).toBe(false);
  });
});
