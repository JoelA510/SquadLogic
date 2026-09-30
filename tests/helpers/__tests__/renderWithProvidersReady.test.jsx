import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen } from '@testing-library/react';

// In mock mode `lib/supabaseClient.js` exports `supabase` unassigned and
// assigns it when the lazily imported mock client has loaded, which is when
// `supabaseReady` settles. This mock reproduces that state but lets the test,
// not the loader's timing, decide when the client arrives, so the race that
// made renderWithProviders.test.jsx intermittent is reproduced every run.
const client = vi.hoisted(() => {
  const state = { supabase: undefined, resolve: () => {}, ready: null };
  state.ready = new Promise((resolve) => {
    state.resolve = () => resolve(undefined);
  });
  return state;
});

vi.mock('../../../frontend/src/lib/supabaseClient.js', () => ({
  get supabase() {
    return client.supabase;
  },
  supabaseReady: client.ready,
}));

import { renderWithProviders } from '../renderWithProviders.jsx';
import { mockSupabase } from '../../../frontend/src/lib/mockSupabaseClient.js';

function memoryStorage() {
  const store = {};
  return {
    getItem: (key) => store[key] ?? null,
    setItem: (key, val) => {
      store[key] = String(val);
    },
    removeItem: (key) => {
      delete store[key];
    },
    clear: () => Object.keys(store).forEach((k) => delete store[k]),
  };
}

describe('renderWithProviders and supabaseReady', () => {
  beforeEach(() => {
    // Same jsdom storage workaround as renderWithProviders.test.jsx.
    vi.stubGlobal('sessionStorage', memoryStorage());
    vi.stubGlobal('localStorage', memoryStorage());
  });

  it('renders only once supabaseReady has settled, never with the client unassigned', async () => {
    let settled = false;
    const rendering = renderWithProviders(<div>rendered after ready</div>);
    rendering.then(() => {
      settled = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    expect(screen.queryByText('rendered after ready')).toBeNull();

    client.supabase = mockSupabase;
    client.resolve();
    await rendering;

    expect(settled).toBe(true);
    expect(screen.getByText('rendered after ready')).toBeInTheDocument();
  });
});
