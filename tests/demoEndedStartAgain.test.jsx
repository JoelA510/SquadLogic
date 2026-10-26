/**
 * "Start again" on the demo-ended page (plan docs/changes/2026-10-22-demo-mode.md, D4; Codex review of
 * #665): the page closes a leftover anonymous session, and /demo/start reuses any session it finds, so
 * "Start again" must wait until that session has really gone. With a sign-out that takes a moment, the
 * button stays disabled until the auth state has cleared, and a click before then goes nowhere.
 */
import React from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../frontend/src/env.js', async (importOriginal) => ({
  ...(await importOriginal()),
  DEMO_ENABLED: true,
}));

const auth = vi.hoisted(() => {
  const listeners = new Set();
  const state = {
    session: /** @type {any} */ (null),
    signOut: vi.fn(),
    // The auth state as a store the page subscribes to, as it does the real provider's.
    set(next) {
      state.session = next;
      listeners.forEach((listener) => listener());
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    get: () => state.session,
  };
  return state;
});

vi.mock('../frontend/src/contexts/AuthContext.jsx', async () => {
  const { useSyncExternalStore: useStore } = await import('react');
  return {
    useAuth: () => ({ session: useStore(auth.subscribe, auth.get), signOut: auth.signOut }),
  };
});

import DemoEndedPage from '../frontend/src/pages/DemoEndedPage.jsx';

function Harness() {
  return (
    <MemoryRouter initialEntries={['/demo/ended']}>
      <Routes>
        <Route path="/demo/ended" element={<DemoEndedPage />} />
        <Route path="/demo/start" element={<h1>Entry page</h1>} />
      </Routes>
    </MemoryRouter>
  );
}

afterEach(() => cleanup());

describe('Start again', () => {
  it('waits for a slow sign-out of the leftover anonymous session', async () => {
    auth.set({ user: { id: 'anon-1', is_anonymous: true } });
    /** @type {() => void} */
    let finishSignOut = () => {};
    auth.signOut.mockReset().mockImplementation(
      () =>
        new Promise((resolve) => {
          finishSignOut = () => {
            auth.set(null);
            resolve({ error: null });
          };
        })
    );

    render(<Harness />);

    const again = screen.getByRole('button', { name: 'Start again' });
    expect(auth.signOut).toHaveBeenCalledTimes(1);
    expect(again).toBeDisabled();
    // A click while the session is still there goes nowhere.
    fireEvent.click(again);
    expect(screen.queryByRole('heading', { name: 'Entry page' })).not.toBeInTheDocument();

    await act(async () => finishSignOut());

    expect(screen.getByRole('button', { name: 'Start again' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Start again' }));
    expect(screen.getByRole('heading', { name: 'Entry page' })).toBeInTheDocument();
  });

  it('control: with no session left it is enabled at once and signs nothing out', () => {
    auth.set(null);
    auth.signOut.mockReset();

    render(<Harness />);

    expect(screen.getByRole('button', { name: 'Start again' })).toBeEnabled();
    expect(auth.signOut).not.toHaveBeenCalled();
  });
});
