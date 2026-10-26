/**
 * Demo mode, the clock (plan docs/changes/2026-10-22-demo-mode.md, D4), through the real `App`,
 * its real shell (the header's timer) and the mock client's `start_demo_session`:
 *
 *  - the timer is in the header on every authenticated route in a demo, floats over the setup
 *    pages that have no header, and is on no route outside a demo;
 *  - it is a `timer` with `aria-live="off"` that counts down, and offers Leave demo;
 *  - a screen reader hears two polite announcements, at 5 minutes and at 1 minute left, said when
 *    the clock crosses them (a page opened with 3 minutes left does not claim 5);
 *  - at expiry the visitor is signed out and sent to /demo/ended.
 *
 * Only the routed pages are stubbed. The clock tests fake `Date` and `setInterval` and leave
 * `setTimeout` alone, so the mock client's own 50 ms sign-in events still land.
 */
import React from 'react';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../frontend/src/env.js', async (importOriginal) => ({
  ...(await importOriginal()),
  DEMO_ENABLED: true,
  TURNSTILE_SITE_KEY: undefined,
}));

const stub = (title) => ({ default: () => <h1>{title}</h1> });
vi.mock('../frontend/src/pages/DashboardPage.jsx', () => stub('Dashboard stub'));
vi.mock('../frontend/src/pages/PlayersPage.jsx', () => stub('Players stub'));
vi.mock('../frontend/src/pages/CoachesPage.jsx', () => stub('Coaches stub'));
vi.mock('../frontend/src/pages/TeamAnalysisPage.jsx', () => stub('Teams stub'));
vi.mock('../frontend/src/pages/GameSchedulingPage.jsx', () => stub('Games stub'));
vi.mock('../frontend/src/pages/SeasonSetupPage.jsx', () => stub('Setup stub'));
vi.mock('../frontend/src/components/OfflineGuard.jsx', () => ({
  default: ({ children }) => children,
}));

import App from '../frontend/src/App.jsx';
import { supabase, supabaseReady } from '../frontend/src/lib/supabaseClient.js';

const settle = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));

/** Starts a demo for a fresh anonymous visitor on the mock, with the given lifespan. */
async function startDemo(lifespanMs) {
  if (lifespanMs) sessionStorage.setItem('__MOCK_DEMO_MS__', String(lifespanMs));
  await supabase.auth.signInAnonymously();
  const { data, error } = await supabase.rpc('start_demo_session');
  expect(error).toBeNull();
  localStorage.setItem('squadlogic_active_org', data.organization_id);
  return data;
}

function openAt(path) {
  window.history.pushState({}, '', path);
  return render(<App />);
}

beforeEach(async () => {
  await supabaseReady;
  await settle();
  sessionStorage.clear();
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the demo timer on every route', () => {
  it.each([
    ['/', 'Dashboard stub'],
    ['/players', 'Players stub'],
    ['/coaches', 'Coaches stub'],
    ['/teams', 'Teams stub'],
    ['/schedule/game', 'Games stub'],
  ])('is in the header on %s', async (path, heading) => {
    await startDemo();
    openAt(path);

    expect(await screen.findByRole('heading', { name: heading })).toBeInTheDocument();
    const timer = await screen.findByRole('timer');
    expect(timer).toHaveAttribute('aria-live', 'off');
    expect(timer).toHaveTextContent(/Demo league · \d+:\d{2} left/);
    expect(within(timer).getByRole('button', { name: 'Leave demo' })).toBeInTheDocument();
    // In the header, not floating.
    expect(timer.closest('header.topbar')).not.toBeNull();
    expect(timer).not.toHaveClass('demo-timer-floating');
  });

  it('floats over the season setup page, which has no header', async () => {
    await startDemo();
    openAt('/setup');

    expect(await screen.findByRole('heading', { name: 'Setup stub' })).toBeInTheDocument();
    const timer = await screen.findByRole('timer');
    expect(timer).toHaveClass('demo-timer-floating');
  });

  it('is on no route outside a demo (control: the seeded real organization)', async () => {
    await supabase.auth.signInWithPassword({
      email: 'admin@example.com',
      password: 'test-password-123',
    });
    openAt('/players');

    expect(await screen.findByRole('heading', { name: 'Players stub' })).toBeInTheDocument();
    // The header has rendered, so the absence below is not a page that never loaded.
    expect(document.querySelector('header.topbar')).not.toBeNull();
    expect(screen.queryByRole('timer')).not.toBeInTheDocument();
  });
});

describe('the clock', () => {
  it('counts down, announces 5 and 1 minutes, and routes to /demo/ended at expiry', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    // 5 minutes 5 seconds: the 5-minute mark is crossed 5 seconds in.
    await startDemo(5 * 60_000 + 5_000);
    openAt('/');

    const timer = await screen.findByRole('timer');
    await waitFor(() => expect(timer).toHaveTextContent('5:05 left'));
    expect(document.body).not.toHaveTextContent('left in the demo.');

    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });
    expect(timer).toHaveTextContent('5:03 left');
    expect(document.body).not.toHaveTextContent('5 minutes left in the demo.');

    await act(async () => {
      vi.advanceTimersByTime(4_000);
    });
    expect(timer).toHaveTextContent('4:59 left');
    expect(document.body).toHaveTextContent('5 minutes left in the demo.');
    // Said in a polite region of its own, not by the timer (which stays aria-live="off").
    const said = screen.getByText('5 minutes left in the demo.');
    expect(said.closest('[role="status"]')).toHaveAttribute('aria-live', 'polite');
    expect(timer).not.toContainElement(said);

    // Down to 1:03, then across the minute.
    await act(async () => {
      vi.advanceTimersByTime(236_000);
    });
    expect(timer).toHaveTextContent('1:03 left');
    expect(document.body).toHaveTextContent('5 minutes left in the demo.');
    await act(async () => {
      vi.advanceTimersByTime(4_000);
    });
    expect(timer).toHaveTextContent('0:59 left');
    expect(document.body).toHaveTextContent('1 minute left in the demo.');

    // Expiry: signed out, on the ended page.
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    vi.useRealTimers();
    expect(await screen.findByRole('heading', { name: 'Your demo has ended' })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/demo/ended');
    await waitFor(() => expect(sessionStorage.getItem('__MOCK_SESSION__')).toBeNull());
    expect(screen.queryByRole('timer')).not.toBeInTheDocument();
  });

  it('opened with 3 minutes left it does not claim 5, and still says 1', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    await startDemo(3 * 60_000);
    openAt('/');

    const timer = await screen.findByRole('timer');
    await waitFor(() => expect(timer).toHaveTextContent('3:00 left'));
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    expect(document.body).not.toHaveTextContent('left in the demo.');
    await act(async () => {
      vi.advanceTimersByTime(95_000);
    });
    expect(timer).toHaveTextContent('0:55 left');
    expect(document.body).toHaveTextContent('1 minute left in the demo.');
    expect(document.body).not.toHaveTextContent('5 minutes left in the demo.');
  });

  it('Leave demo signs the visitor out and goes back to the sign-in page', async () => {
    await startDemo();
    openAt('/');

    const leave = await screen.findByRole('button', { name: 'Leave demo' });
    leave.click();

    await waitFor(() => expect(sessionStorage.getItem('__MOCK_SESSION__')).toBeNull());
    expect(await screen.findByRole('button', { name: 'Try the demo' })).toBeInTheDocument();
    expect(screen.queryByRole('timer')).not.toBeInTheDocument();
  });
});
