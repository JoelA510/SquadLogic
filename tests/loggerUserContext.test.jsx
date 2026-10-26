/**
 * M1.5: every error report says which user and organization it came from.
 *
 * The chain is pinned end to end through the real providers and the real
 * logger, with only the Supabase client and the Sentry SDK replaced:
 *
 *   AuthContext (sign-in, sign-out)        --+
 *                                            +--> logger.setUser --> Sentry.setUser / setTag
 *   OrganizationContext (choose, switch)   --+
 *
 * What reaches Sentry is IDs only. The fixtures below hand the providers a
 * session and a profile that carry an email and a name on purpose, so the
 * "never an email" assertions have something to refuse. The addresses are
 * fictitious (`example.test`).
 *
 * Proven able to fail (2026-10-13, see the PR): with the `reportUser(...)`
 * calls removed from AuthContext, five tests fail (Sentry.setUser is never
 * called on sign-in); with `logger.setUser` passing its argument straight
 * through, the field-stripping tests fail; with both that and AuthContext
 * spreading the session user into its call, the sign-in test's email
 * assertion fails too.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import React from 'react';

vi.mock('@sentry/react', () => ({
  setUser: vi.fn(),
  setTag: vi.fn(),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  withScope: vi.fn(),
}));

vi.mock('../frontend/src/lib/supabaseClient.js', () => ({
  supabase: {
    auth: {
      getSession: vi.fn(),
      onAuthStateChange: vi.fn(),
      signOut: vi.fn(),
    },
    from: vi.fn(),
  },
}));

import * as Sentry from '@sentry/react';
import { supabase } from '../frontend/src/lib/supabaseClient.js';
import { logger, sentryUserOf } from '../frontend/src/lib/logger.js';
import { AuthProvider } from '../frontend/src/contexts/AuthContext.jsx';
import {
  OrganizationProvider,
  useOrganization,
} from '../frontend/src/contexts/OrganizationContext.jsx';

const USER_ID = '00000000-0000-4000-8000-0000000000a1';
const ORG_A = '00000000-0000-4000-8000-00000000000a';
const ORG_B = '00000000-0000-4000-8000-00000000000b';
const EMAIL = 'pat.coach@example.test';

const session = {
  access_token: 'fake-access-token',
  user: { id: USER_ID, email: EMAIL, phone: '+15550000000', role: 'authenticated' },
};
const profile = {
  id: USER_ID,
  email: EMAIL,
  full_name: 'Pat Coach',
  organization_id: ORG_A,
  role: 'admin',
};
const members = [
  {
    profile_id: USER_ID,
    organization_id: ORG_A,
    role: 'admin',
    organizations: { id: ORG_A, name: 'Club A' },
  },
  {
    profile_id: USER_ID,
    organization_id: ORG_B,
    role: 'coach',
    organizations: { id: ORG_B, name: 'Club B' },
  },
];

/** The `onAuthStateChange` callback AuthProvider registered. */
let emitAuthChange = (_event, _session) => {};

const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 10));
  });

/** Every argument Sentry.setUser was called with, in order. */
const setUserCalls = () => vi.mocked(Sentry.setUser).mock.calls.map((c) => c[0]);

/** The last value the tag `name` was given (the demo tag, D4, is set beside `organization_id`). */
const lastTag = (name) =>
  vi
    .mocked(Sentry.setTag)
    .mock.calls.filter((c) => c[0] === name)
    .at(-1);

/** No value anywhere in what reached Sentry is an email or a name. */
function expectNoPii() {
  const sent = JSON.stringify([
    vi.mocked(Sentry.setUser).mock.calls,
    vi.mocked(Sentry.setTag).mock.calls,
  ]);
  expect(sent).not.toContain('@');
  expect(sent).not.toContain(EMAIL);
  expect(sent).not.toContain('Pat Coach');
  expect(sent).not.toContain('+1555');
}

beforeEach(() => {
  vi.clearAllMocks();
  const store = {};
  vi.stubGlobal('localStorage', {
    getItem: vi.fn((k) => store[k] ?? null),
    setItem: vi.fn((k, v) => {
      store[k] = String(v);
    }),
    removeItem: vi.fn((k) => {
      delete store[k];
    }),
    clear: vi.fn(),
  });

  vi.mocked(supabase.auth.getSession).mockResolvedValue(/** @type {any} */ ({ data: { session } }));
  vi.mocked(supabase.auth.onAuthStateChange).mockImplementation(
    /** @type {any} */ (
      (cb) => {
        emitAuthChange = cb;
        return { data: { subscription: { unsubscribe: vi.fn() } } };
      }
    )
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
          return {
            select: () => ({ eq: () => Promise.resolve({ data: members, error: null }) }),
          };
        }
        if (table === 'season_settings') {
          return {
            select: () => ({
              eq: () => ({ order: () => Promise.resolve({ data: [], error: null }) }),
            }),
          };
        }
        throw new Error(`unexpected table ${table}`);
      }
    )
  );
});

describe('AuthContext reports the signed-in user to Sentry', () => {
  it('on sign-in, Sentry gets the user ID, organization ID and role, and no email', async () => {
    render(
      <AuthProvider>
        <div />
      </AuthProvider>
    );
    await flush();

    // Exercised, not vacuous: the provider did read the profile.
    expect(supabase.from).toHaveBeenCalledWith('profiles');
    expect(setUserCalls()).toEqual([{ id: USER_ID, organization_id: ORG_A, role: 'admin' }]);
    expect(Sentry.setTag).toHaveBeenCalledWith('organization_id', ORG_A);
    expectNoPii();
  });

  it('a token refresh for the same user does not re-send it', async () => {
    render(
      <AuthProvider>
        <div />
      </AuthProvider>
    );
    await flush();
    expect(setUserCalls()).toHaveLength(1);

    await act(async () => emitAuthChange('TOKEN_REFRESHED', session));
    await flush();
    expect(supabase.from).toHaveBeenCalledTimes(2); // the refresh re-read the profile
    expect(setUserCalls()).toHaveLength(1);
  });

  it('on sign-out, Sentry user and organization tag are cleared', async () => {
    render(
      <AuthProvider>
        <div />
      </AuthProvider>
    );
    await flush();
    expect(setUserCalls()).toHaveLength(1);

    await act(async () => emitAuthChange('SIGNED_OUT', null));
    await flush();
    expect(setUserCalls().at(-1)).toBeNull();
    expect(lastTag('organization_id')).toEqual(['organization_id', undefined]);
  });

  it('a profile that cannot be read still reports the user ID', async () => {
    vi.mocked(supabase.from).mockImplementation(
      /** @type {any} */ (
        () => ({
          select: () => ({
            eq: () => ({
              single: () => Promise.resolve({ data: null, error: { message: 'boom' } }),
            }),
          }),
        })
      )
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(
      <AuthProvider>
        <div />
      </AuthProvider>
    );
    await flush();
    warn.mockRestore();
    expect(setUserCalls()).toEqual([{ id: USER_ID }]);
    expectNoPii();
  });
});

function OrgSwitcher() {
  const { currentOrganization, switchOrganization } = useOrganization();
  return (
    <div>
      <div data-testid="org">{currentOrganization?.id ?? 'none'}</div>
      <button type="button" onClick={() => switchOrganization(ORG_B)}>
        switch
      </button>
    </div>
  );
}

describe('OrganizationContext reports the active organization to Sentry', () => {
  it('after sign-in the active organization wins, and a switch replaces it', async () => {
    localStorage.setItem('squadlogic_active_org', ORG_A);
    render(
      <AuthProvider>
        <OrganizationProvider>
          <OrgSwitcher />
        </OrganizationProvider>
      </AuthProvider>
    );
    await flush();
    await flush();
    expect(screen.getByTestId('org').textContent).toBe(ORG_A);
    // AuthContext first (the profile's organization), then OrganizationContext.
    expect(setUserCalls()).toEqual([
      { id: USER_ID, organization_id: ORG_A, role: 'admin' },
      { id: USER_ID, organization_id: ORG_A, role: 'admin' },
    ]);

    await act(async () => screen.getByRole('button', { name: 'switch' }).click());
    await flush();
    expect(screen.getByTestId('org').textContent).toBe(ORG_B);
    expect(setUserCalls().at(-1)).toEqual({ id: USER_ID, organization_id: ORG_B, role: 'coach' });
    expect(lastTag('organization_id')).toEqual(['organization_id', ORG_B]);
    expectNoPii();
  });
});

describe('the demo tag (D4)', () => {
  const DEMO_ORG = '00000000-0000-4000-8000-0000000000d1';
  const demoMembers = [
    {
      profile_id: USER_ID,
      organization_id: DEMO_ORG,
      role: 'admin',
      organizations: {
        id: DEMO_ORG,
        name: 'Demo league',
        demo_expires_at: new Date(Date.now() + 20 * 60_000).toISOString(),
      },
    },
    members[1],
  ];

  function useMembers(rows) {
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
            return { select: () => ({ eq: () => Promise.resolve({ data: rows, error: null }) }) };
          }
          return {
            select: () => ({
              eq: () => ({ order: () => Promise.resolve({ data: [], error: null }) }),
            }),
          };
        }
      )
    );
  }

  it('is set while the active organization is a demo, and cleared when it changes to a real one', async () => {
    useMembers(demoMembers);
    localStorage.setItem('squadlogic_active_org', DEMO_ORG);
    render(
      <AuthProvider>
        <OrganizationProvider>
          <OrgSwitcher />
        </OrganizationProvider>
      </AuthProvider>
    );
    await flush();
    await flush();
    expect(screen.getByTestId('org').textContent).toBe(DEMO_ORG);
    expect(lastTag('demo')).toEqual(['demo', 'true']);

    await act(async () => screen.getByRole('button', { name: 'switch' }).click());
    await flush();
    expect(screen.getByTestId('org').textContent).toBe(ORG_B);
    expect(lastTag('demo')).toEqual(['demo', undefined]);
  });

  it('is never set for a real organization', async () => {
    localStorage.setItem('squadlogic_active_org', ORG_A);
    render(
      <AuthProvider>
        <OrganizationProvider>
          <OrgSwitcher />
        </OrganizationProvider>
      </AuthProvider>
    );
    await flush();
    await flush();
    expect(vi.mocked(Sentry.setTag).mock.calls.filter((c) => c[0] === 'demo' && c[1])).toEqual([]);
  });

  it('is cleared on sign-out', async () => {
    useMembers(demoMembers);
    localStorage.setItem('squadlogic_active_org', DEMO_ORG);
    render(
      <AuthProvider>
        <OrganizationProvider>
          <OrgSwitcher />
        </OrganizationProvider>
      </AuthProvider>
    );
    await flush();
    await flush();
    expect(lastTag('demo')).toEqual(['demo', 'true']);

    await act(async () => emitAuthChange('SIGNED_OUT', null));
    await flush();
    expect(lastTag('demo')).toEqual(['demo', undefined]);
  });

  it('adds only the tag: setUser still passes ids alone', () => {
    logger.setDemoContext(true);
    expect(vi.mocked(Sentry.setTag).mock.calls).toEqual([['demo', 'true']]);
    expect(setUserCalls()).toEqual([]);
    logger.setDemoContext(false);
    expect(lastTag('demo')).toEqual(['demo', undefined]);
    // Anything but the boolean true clears it.
    logger.setDemoContext(/** @type {any} */ ('true'));
    expect(lastTag('demo')).toEqual(['demo', undefined]);
  });
});

describe('logger.setUser passes IDs only', () => {
  it('drops every field but id, organization_id and role', () => {
    logger.setUser(
      /** @type {any} */ ({
        id: USER_ID,
        organization_id: ORG_A,
        role: 'coach',
        email: EMAIL,
        full_name: 'Pat Coach',
        profile: { email: EMAIL },
      })
    );
    expect(setUserCalls()).toEqual([{ id: USER_ID, organization_id: ORG_A, role: 'coach' }]);
    expectNoPii();
  });

  it('clears the user for null, or for a user without a string ID', () => {
    expect(sentryUserOf(null)).toBeNull();
    expect(sentryUserOf({ email: EMAIL })).toBeNull();
    expect(sentryUserOf({ id: 42 })).toBeNull();
    expect(sentryUserOf({ id: '' })).toBeNull();
    expect(sentryUserOf({ id: USER_ID, organization_id: null, role: '' })).toEqual({
      id: USER_ID,
    });
  });

  it('is harmless when Sentry was never initialised (no DSN)', async () => {
    const real = /** @type {typeof import('@sentry/react')} */ (
      await vi.importActual('@sentry/react')
    );
    expect(real.getClient()).toBeUndefined();
    expect(() => {
      real.setUser(sentryUserOf({ id: USER_ID, organization_id: ORG_A }));
      real.setTag('organization_id', ORG_A);
      real.setUser(null);
      real.setTag('organization_id', undefined);
    }).not.toThrow();
  });
});
