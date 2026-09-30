import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { useLocation } from 'react-router-dom';
import { renderWithProviders } from '../renderWithProviders.jsx';
import { makeOrganization, makeUser } from '../../factories/index.js';

function RouteProbe() {
  const location = useLocation();
  return <div data-testid="pathname">{location.pathname}</div>;
}

describe('renderWithProviders', () => {
  beforeEach(() => {
    // jsdom does not always expose a working localStorage when Node is
    // started without --localstorage-file (see tests/authIntegration.test.jsx
    // for the same workaround). Stub both storage globals so the helper's
    // setItem calls + our clear() assertions both succeed.
    const sessionStore = {};
    const localStore = {};
    vi.stubGlobal('sessionStorage', {
      getItem: vi.fn((key) => sessionStore[key] ?? null),
      setItem: vi.fn((key, val) => {
        sessionStore[key] = String(val);
      }),
      removeItem: vi.fn((key) => {
        delete sessionStore[key];
      }),
      clear: vi.fn(() => {
        Object.keys(sessionStore).forEach((k) => delete sessionStore[k]);
      }),
    });
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key) => localStore[key] ?? null),
      setItem: vi.fn((key, val) => {
        localStore[key] = String(val);
      }),
      removeItem: vi.fn((key) => {
        delete localStore[key];
      }),
      clear: vi.fn(() => {
        Object.keys(localStore).forEach((k) => delete localStore[k]);
      }),
    });
  });

  it('renders a child without error', async () => {
    await renderWithProviders(<div>hello from inside providers</div>);
    expect(screen.getByText('hello from inside providers')).toBeInTheDocument();
  });

  it('persists the active organization id to localStorage', async () => {
    const organization = makeOrganization({ id: 'org-42' });
    await renderWithProviders(<div>stub</div>, { organization });
    expect(localStorage.getItem('squadlogic_active_org')).toBe('org-42');
  });

  it('persists the mock user to sessionStorage as JSON', async () => {
    const user = makeUser({ id: 'user-99', email: 'probe@example.com' });
    await renderWithProviders(<div>stub</div>, { user });
    const stored = JSON.parse(sessionStorage.getItem('squadlogic_mock_user') || 'null');
    expect(stored).toMatchObject({ id: 'user-99', email: 'probe@example.com' });
  });

  it('seeds the MemoryRouter to the requested initial route', async () => {
    await renderWithProviders(<RouteProbe />, { route: '/settings' });
    expect(screen.getByTestId('pathname').textContent).toBe('/settings');
  });

  it('defaults to "/" when no route is passed', async () => {
    await renderWithProviders(<RouteProbe />);
    expect(screen.getByTestId('pathname').textContent).toBe('/');
  });
});
