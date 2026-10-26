/**
 * Demo mode, the entry (plan docs/changes/2026-10-22-demo-mode.md, D4): `/demo/start` through the
 * real `App` with its real providers and the mock client (whose `signInAnonymously` and
 * `start_demo_session` are the twins of GoTrue's and of migration 20261030010000's). Not the
 * button alone.
 *
 *  - success: a signed-out visitor is signed in anonymously, gets a demo and lands on the app;
 *  - the cap: the visitor stays on /demo/start, signed out, with the refusal announced;
 *  - an anonymous session is never sent to /organizations/new (nor shown that page), whether its
 *    demo is gone or it asks for the page by address;
 *  - a signed-in real account is not signed out by the entry.
 *
 * Only the heavy routed pages are stubbed; the routing, providers and entry are real.
 */
import React from 'react';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../frontend/src/env.js', async (importOriginal) => ({
  ...(await importOriginal()),
  DEMO_ENABLED: true,
  TURNSTILE_SITE_KEY: undefined,
}));

vi.mock('../frontend/src/layouts/DashboardLayout.jsx', async () => {
  const { Outlet } = await import('react-router-dom');
  return { default: () => <Outlet /> };
});
vi.mock('../frontend/src/pages/DashboardPage.jsx', () => ({
  default: () => <h1>Dashboard stub</h1>,
}));
vi.mock('../frontend/src/pages/OrganizationCreation.jsx', () => ({
  default: () => <h1>Create an organization stub</h1>,
}));
vi.mock('../frontend/src/components/OfflineGuard.jsx', () => ({
  default: ({ children }) => children,
}));

import App from '../frontend/src/App.jsx';
import { supabase, supabaseReady } from '../frontend/src/lib/supabaseClient.js';

const CAP_ERROR = {
  code: 'P0001',
  message: 'The demo is busy right now. Try again in a few minutes.',
  details: 'demo_capacity',
};

function openAt(path) {
  window.history.pushState({}, '', path);
  return render(<App />);
}

beforeEach(async () => {
  await supabaseReady;
  // The mock announces a sign-in or sign-out 50 ms after the call; let the previous test's land
  // before this one subscribes, or it arrives as a sign-out nobody asked for.
  await new Promise((resolve) => setTimeout(resolve, 80));
  sessionStorage.clear();
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('/demo/start through the real App', () => {
  it('signs a signed-out visitor in anonymously, starts their demo and opens the app', async () => {
    const signIn = vi.spyOn(supabase.auth, 'signInAnonymously');
    const rpc = vi.spyOn(supabase, 'rpc');

    openAt('/demo/start');

    expect(await screen.findByRole('heading', { name: 'Dashboard stub' })).toBeInTheDocument();
    expect(signIn).toHaveBeenCalledTimes(1);
    // No site key: no captcha token is sent.
    expect(signIn.mock.calls[0][0]).toBeUndefined();
    expect(rpc.mock.calls.filter(([name]) => name === 'start_demo_session')).toHaveLength(1);
    // An anonymous visitor has no verified email, so no coach-record link is attempted for them.
    expect(rpc.mock.calls.map(([name]) => name)).not.toContain('link_my_coach_record');
    expect(window.location.pathname).toBe('/');
    const stored = JSON.parse(sessionStorage.getItem('__MOCK_SESSION__'));
    expect(stored.user.is_anonymous).toBe(true);
    const db = JSON.parse(sessionStorage.getItem('__MOCK_DB__'));
    const demo = db.organizations.find((org) => org.demo_owner === stored.user.id);
    expect(demo.demo_expires_at).toBeTruthy();
    expect(localStorage.getItem('squadlogic_active_org')).toBe(demo.id);
  });

  it('at the cap the visitor stays on /demo/start, signed out, with the refusal announced', async () => {
    vi.spyOn(supabase, 'rpc').mockImplementation(
      /** @type {any} */ (
        async (/** @type {string} */ name) =>
          name === 'start_demo_session'
            ? { data: null, error: CAP_ERROR }
            : { data: null, error: null }
      )
    );
    const signOut = vi.spyOn(supabase.auth, 'signOut');

    openAt('/demo/start');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The demo is busy right now. Try again in a few minutes.');
    expect(screen.getByRole('heading', { name: 'The demo did not start' })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/demo/start');
    expect(signOut).toHaveBeenCalled();
    await waitFor(() => expect(sessionStorage.getItem('__MOCK_SESSION__')).toBeNull());
    expect(screen.queryByRole('heading', { name: 'Dashboard stub' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled();
  });

  it('a failed anonymous sign-in (anonymous sign-ins disabled) is announced the same way', async () => {
    vi.spyOn(supabase.auth, 'signInAnonymously').mockResolvedValue(
      /** @type {any} */ ({
        data: { session: null, user: null },
        error: { message: 'Anonymous sign-ins are disabled', status: 422 },
      })
    );

    openAt('/demo/start');

    expect(await screen.findByRole('alert')).toHaveTextContent('The demo could not be started.');
    expect(window.location.pathname).toBe('/demo/start');
  });

  it('does not start a demo for a signed-in real account, and does not sign it out', async () => {
    await supabase.auth.signInWithPassword({
      email: 'admin@example.com',
      password: 'test-password-123',
    });
    const signIn = vi.spyOn(supabase.auth, 'signInAnonymously');
    const signOut = vi.spyOn(supabase.auth, 'signOut');

    openAt('/demo/start');

    expect(await screen.findByRole('heading', { name: 'You are signed in' })).toBeInTheDocument();
    expect(signIn).not.toHaveBeenCalled();
    expect(signOut).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('__MOCK_SESSION__')).not.toBeNull();
  });
});

describe('an anonymous session and /organizations/new', () => {
  async function anonymousWithNoDemo() {
    await supabase.auth.signInAnonymously();
  }

  it('is sent to the ended page, never to organization creation, when it has no organization', async () => {
    await anonymousWithNoDemo();

    openAt('/');

    expect(await screen.findByRole('heading', { name: 'Your demo has ended' })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/demo/ended');
    expect(
      screen.queryByRole('heading', { name: 'Create an organization stub' })
    ).not.toBeInTheDocument();
  });

  it('is turned away from /organizations/new by address, even with a demo', async () => {
    await anonymousWithNoDemo();
    const { data } = await supabase.rpc('start_demo_session');
    localStorage.setItem('squadlogic_active_org', data.organization_id);

    openAt('/organizations/new');

    expect(await screen.findByRole('heading', { name: 'Dashboard stub' })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/');
    expect(
      screen.queryByRole('heading', { name: 'Create an organization stub' })
    ).not.toBeInTheDocument();
  });

  it('control: a real account with no organization still reaches organization creation', async () => {
    await supabase.auth.signInWithPassword({
      email: 'outsider@example.com',
      password: 'test-password-123',
    });

    openAt('/');

    expect(
      await screen.findByRole('heading', { name: 'Create an organization stub' })
    ).toBeInTheDocument();
    expect(window.location.pathname).toBe('/organizations/new');
  });

  it('the ended page offers Start again and Create an account, and closes a leftover anonymous session', async () => {
    await anonymousWithNoDemo();

    openAt('/demo/ended');

    expect(await screen.findByRole('button', { name: 'Start again' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create an account' })).toBeInTheDocument();
    await waitFor(() => expect(sessionStorage.getItem('__MOCK_SESSION__')).toBeNull());
  });
});
