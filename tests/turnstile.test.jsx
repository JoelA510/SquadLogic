/**
 * Cloudflare Turnstile on every form the project's CAPTCHA setting covers (plan
 * docs/changes/2026-10-22-demo-mode.md, D4; decision 3). Supabase's CAPTCHA protection is one
 * project-wide setting: once it is on, sign-in, sign-up, password reset and anonymous sign-in all
 * need a token, so each of the four waits for one, sends it, and gets a fresh challenge after the
 * call (a token is good for one call). With no site key nothing renders, loads or is sent.
 *
 * `window.turnstile` is a stand-in that records what the component asked of it; the component
 * loads Cloudflare's script only when that global is absent.
 */
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  key: 'test-site-key-0001',
  session: null,
  resetPasswordForEmail: vi.fn(),
  signInWithPassword: vi.fn(),
  signUp: vi.fn(),
  signInAnonymously: vi.fn(),
  signOut: vi.fn(),
  rpc: vi.fn(),
  refetchOrgs: vi.fn(),
}));

vi.mock('../frontend/src/env.js', async (importOriginal) => ({
  ...(await importOriginal()),
  DEMO_ENABLED: true,
  get TURNSTILE_SITE_KEY() {
    return state.key;
  },
}));
vi.mock('../frontend/src/lib/supabaseClient.js', () => ({
  supabase: {
    auth: {
      signInWithPassword: (...args) => state.signInWithPassword(...args),
      signUp: (...args) => state.signUp(...args),
      signInAnonymously: (...args) => state.signInAnonymously(...args),
      signOut: (...args) => state.signOut(...args),
    },
    rpc: (...args) => state.rpc(...args),
  },
}));
vi.mock('../frontend/src/contexts/AuthContext.jsx', () => ({
  useAuth: () => ({
    isConfigured: true,
    session: state.session,
    loading: false,
    signOut: state.signOut,
    resetPasswordForEmail: state.resetPasswordForEmail,
  }),
}));
vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: () => ({ organizations: [], loading: false, refetchOrgs: state.refetchOrgs }),
}));

import Login from '../frontend/src/components/Login.jsx';
import DemoStartPage from '../frontend/src/pages/DemoStartPage.jsx';

/** @type {{ render: any, reset: any, remove: any, widgets: any[] }} */
let turnstile;

function installTurnstile() {
  const widgets = [];
  turnstile = {
    widgets,
    render: vi.fn((_el, options) => {
      widgets.push(options);
      return `widget-${widgets.length}`;
    }),
    reset: vi.fn(),
    remove: vi.fn(),
  };
  /** @type {any} */ (window).turnstile = turnstile;
}

/** Solves the most recently rendered challenge. */
async function solve(token) {
  await waitFor(() => expect(turnstile.widgets.length).toBeGreaterThan(0));
  await act(async () => {
    turnstile.widgets.at(-1).callback(token);
  });
}

function renderLogin() {
  return render(
    <MemoryRouter>
      <Login />
    </MemoryRouter>
  );
}

function fill(email = 'person@example.test', password = 'a-long-test-password') {
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: email } });
  const field = screen.queryByLabelText('Password');
  if (field) fireEvent.change(field, { target: { value: password } });
}

beforeEach(() => {
  state.key = 'test-site-key-0001';
  state.session = null;
  state.resetPasswordForEmail.mockReset().mockResolvedValue({ error: null });
  state.signInWithPassword.mockReset().mockResolvedValue({ error: { message: 'Invalid' } });
  state.signUp
    .mockReset()
    .mockResolvedValue({ data: { user: null, session: null }, error: { message: 'x' } });
  state.signInAnonymously.mockReset().mockResolvedValue({ data: {}, error: null });
  state.signOut.mockReset().mockResolvedValue({ error: null });
  state.rpc.mockReset().mockResolvedValue({
    data: { organization_id: 'demo-org', expires_at: new Date(Date.now() + 60_000).toISOString() },
    error: null,
  });
  state.refetchOrgs.mockReset();
  window.history.pushState({}, '', '/');
  installTurnstile();
});

afterEach(() => {
  cleanup();
  delete (/** @type {any} */ (window).turnstile);
});

describe('with a site key', () => {
  it('renders the widget with the key, labelled', async () => {
    renderLogin();
    await waitFor(() => expect(turnstile.render).toHaveBeenCalledTimes(1));
    expect(turnstile.render.mock.calls[0][1]).toMatchObject({ sitekey: 'test-site-key-0001' });
    expect(screen.getByRole('group', { name: 'Verification' })).toBeInTheDocument();
  });

  it('sign-in waits for a token, sends it, and gets a fresh challenge after the call', async () => {
    renderLogin();
    fill();
    const submit = screen.getByRole('button', { name: 'Sign In' });
    expect(submit).toBeDisabled();

    await solve('token-signin');
    expect(submit).toBeEnabled();
    fireEvent.click(submit);

    await waitFor(() => expect(state.signInWithPassword).toHaveBeenCalledTimes(1));
    expect(state.signInWithPassword).toHaveBeenCalledWith({
      email: 'person@example.test',
      password: 'a-long-test-password',
      options: { captchaToken: 'token-signin' },
    });
    await waitFor(() => expect(turnstile.reset).toHaveBeenCalledWith('widget-1'));
    // The spent token is gone: the form waits for the next one.
    expect(screen.getByRole('button', { name: 'Sign In' })).toBeDisabled();
  });

  it('sign-up sends its token, then resets', async () => {
    renderLogin();
    fireEvent.click(screen.getByRole('button', { name: 'Sign Up' })); // the form switch
    fill();
    const submit = screen.getByRole('button', { name: 'Sign Up' }); // now the submit
    expect(submit).toBeDisabled();
    await solve('token-signup');
    expect(submit).toBeEnabled();

    fireEvent.click(submit);

    await waitFor(() => expect(state.signUp).toHaveBeenCalledTimes(1));
    expect(state.signUp).toHaveBeenCalledWith({
      email: 'person@example.test',
      password: 'a-long-test-password',
      options: { captchaToken: 'token-signup' },
    });
    await waitFor(() => expect(turnstile.reset).toHaveBeenCalled());
  });

  it('password reset sends its token, then resets', async () => {
    renderLogin();
    fireEvent.click(screen.getByRole('button', { name: 'Forgot Password?' }));
    fill();
    const submit = screen.getByRole('button', { name: 'Send Reset Link' });
    expect(submit).toBeDisabled();
    await solve('token-reset');

    fireEvent.click(submit);

    await waitFor(() => expect(state.resetPasswordForEmail).toHaveBeenCalledTimes(1));
    expect(state.resetPasswordForEmail).toHaveBeenCalledWith('person@example.test', {
      captchaToken: 'token-reset',
    });
    await waitFor(() => expect(turnstile.reset).toHaveBeenCalled());
  });

  it('demo start waits for the token before it signs in anonymously, and sends it', async () => {
    render(
      <MemoryRouter initialEntries={['/demo/start']}>
        <DemoStartPage />
      </MemoryRouter>
    );

    await waitFor(() => expect(turnstile.render).toHaveBeenCalledTimes(1));
    // Nothing happens while the challenge is unsolved.
    expect(state.signInAnonymously).not.toHaveBeenCalled();
    expect(
      screen.getByText('Complete the check below to open a private copy of a ready-made league.')
    ).toBeInTheDocument();

    await solve('token-demo');

    await waitFor(() => expect(state.signInAnonymously).toHaveBeenCalledTimes(1));
    expect(state.signInAnonymously).toHaveBeenCalledWith({
      options: { captchaToken: 'token-demo' },
    });
    await waitFor(() => expect(state.rpc).toHaveBeenCalledWith('start_demo_session'));
  });

  it('a failed sign-in attempt announces the failure, shows a fresh challenge and a retry', async () => {
    state.signInAnonymously.mockResolvedValue({
      data: {},
      error: { message: 'captcha verification process failed' },
    });
    render(
      <MemoryRouter initialEntries={['/demo/start']}>
        <DemoStartPage />
      </MemoryRouter>
    );
    await solve('token-one');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The demo could not be started.');
    expect(state.signOut).toHaveBeenCalled();
    // The widget is back for the next try, which waits for a new token.
    await waitFor(() => expect(turnstile.render.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(screen.getByRole('button', { name: 'Try again' })).toBeDisabled();
    await solve('token-two');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled();
  });

  it('announces a challenge that cannot load, with a retry that loads it again', async () => {
    renderLogin();
    await waitFor(() => expect(turnstile.render).toHaveBeenCalledTimes(1));

    await act(async () => {
      turnstile.widgets.at(-1)['error-callback']();
    });

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The verification check did not load.');
    expect(screen.getByRole('button', { name: 'Sign In' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(turnstile.render).toHaveBeenCalledTimes(2));
  });

  it('an expired token disables the submit again', async () => {
    renderLogin();
    fill();
    await solve('token-old');
    expect(screen.getByRole('button', { name: 'Sign In' })).toBeEnabled();

    await act(async () => {
      turnstile.widgets.at(-1)['expired-callback']();
    });

    expect(screen.getByRole('button', { name: 'Sign In' })).toBeDisabled();
  });
});

describe('without a site key', () => {
  beforeEach(() => {
    state.key = undefined;
  });

  it('renders no widget, loads nothing, and sign-in sends no token', async () => {
    renderLogin();
    fill();
    expect(screen.queryByRole('group', { name: 'Verification' })).not.toBeInTheDocument();
    const submit = screen.getByRole('button', { name: 'Sign In' });
    expect(submit).toBeEnabled();

    fireEvent.click(submit);

    await waitFor(() => expect(state.signInWithPassword).toHaveBeenCalledTimes(1));
    // Exactly the credentials: no options, no captchaToken.
    expect(state.signInWithPassword).toHaveBeenCalledWith({
      email: 'person@example.test',
      password: 'a-long-test-password',
    });
    expect(turnstile.render).not.toHaveBeenCalled();
    expect(document.querySelector('script[src*="challenges.cloudflare.com"]')).toBeNull();
  });

  it('sign-up and reset send no token either', async () => {
    renderLogin();
    fireEvent.click(screen.getByRole('button', { name: 'Sign Up' }));
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Sign Up' }));
    await waitFor(() => expect(state.signUp).toHaveBeenCalledTimes(1));
    expect(state.signUp).toHaveBeenCalledWith({
      email: 'person@example.test',
      password: 'a-long-test-password',
    });

    cleanup();
    renderLogin();
    fireEvent.click(screen.getByRole('button', { name: 'Forgot Password?' }));
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Send Reset Link' }));
    await waitFor(() => expect(state.resetPasswordForEmail).toHaveBeenCalledTimes(1));
    expect(state.resetPasswordForEmail).toHaveBeenCalledWith('person@example.test', undefined);
  });

  it('demo start signs in anonymously at once, with no token', async () => {
    render(
      <MemoryRouter initialEntries={['/demo/start']}>
        <DemoStartPage />
      </MemoryRouter>
    );

    await waitFor(() => expect(state.signInAnonymously).toHaveBeenCalledTimes(1));
    expect(state.signInAnonymously).toHaveBeenCalledWith(undefined);
    expect(turnstile.render).not.toHaveBeenCalled();
  });
});
