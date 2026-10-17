/**
 * `ImportContext`'s `importedData` is the player import (Wave 3, found by the
 * review of the "Continue" fix).
 *
 * Every reader takes it as player rows (the teams page builds its programs from
 * it; the dashboard's step 2 counts it as records ready for teaming), and the
 * reload path fills it only from the latest players row. `startImport` used to
 * write it for every type, so once "Continue" stopped clearing the context, a
 * coach import reached the teams page as players.
 *
 * Runs against the real mock Supabase client, as the direct-apply test does, so
 * the import job, the staging function and the finalize RPC behave as in mock
 * mode.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { ImportProvider, useImport } from '../frontend/src/contexts/ImportContext.jsx';
import { mockSupabase } from '../frontend/src/lib/mockSupabaseClient.js';

const mocks = vi.hoisted(() => ({ parse: vi.fn() }));

vi.mock('papaparse', () => ({
  default: { parse: mocks.parse },
}));

// The organization the signed-in mock admin belongs to: read from the mock's own
// membership rows, so this file names no seed id.
const org = vi.hoisted(() => ({ id: /** @type {string|null} */ (null) }));
vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: () => ({
    currentOrganization: { id: org.id },
    orgMember: { id: 'member-1' },
  }),
}));

const wrapper = ({ children }) => <ImportProvider>{children}</ImportProvider>;

/**
 * Mount the provider and let its reload path settle: it fills the player import
 * from the mock seed's `imports` row, and a later pass would overwrite what the
 * case imports. Returns the hook and that rehydrated player import.
 */
async function mountSettled() {
  const hook = renderHook(() => useImport(), { wrapper });
  await waitFor(() => expect(hook.result.current.importedData?.data?.length).toBeGreaterThan(0));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  return { result: hook.result, seeded: hook.result.current.importedData };
}

describe('ImportContext :: importedData holds the player import only', () => {
  beforeEach(async () => {
    sessionStorage.clear();
    window.__MOCK_DB__ = undefined;
    mocks.parse.mockReset();
    const { data } = await mockSupabase.auth.signInWithPassword({
      email: 'admin@example.com',
      password: 'test-password-123',
    });
    const { data: memberships } = await mockSupabase
      .from('organization_members')
      .select('*')
      .eq('profile_id', data.user.id);
    org.id = memberships?.[0]?.organization_id ?? null;
    expect(org.id, 'the mock admin belongs to an organization').toBeTruthy();
  });

  it('a coach import fills importedCoaches and leaves the player import in importedData', async () => {
    mocks.parse.mockImplementation((_file, options) => {
      options.complete({
        data: [{ full_name: 'Casey Coach', email: 'casey.coach@example.com' }],
        meta: { fields: ['full_name', 'email'] },
      });
    });
    const { result, seeded } = await mountSettled();

    await act(async () => {
      await result.current.startImport(new File(['x'], 'coaches.csv'), 'coaches');
    });

    // Meta-assertion: the coach import really completed and landed in its own slot.
    await waitFor(() => expect(result.current.importedCoaches?.data?.length).toBe(1));
    // The player import is still the one the teams page reads, not the coach rows.
    expect(result.current.importedData).toEqual(seeded);
    expect(result.current.importedData).not.toEqual(result.current.importedCoaches);
  });

  it('a player import fills both importedPlayers and importedData', async () => {
    mocks.parse.mockImplementation((_file, options) => {
      options.complete({
        data: [{ first_name: 'Ada', last_name: 'One', date_of_birth: '2016-01-01' }],
        meta: { fields: ['first_name', 'last_name', 'date_of_birth'] },
      });
    });
    const { result, seeded } = await mountSettled();

    await act(async () => {
      await result.current.startImport(new File(['x'], 'players.csv'), 'players');
    });

    await waitFor(() => expect(result.current.importedPlayers?.data?.length).toBe(1));
    expect(result.current.importedData).toEqual(result.current.importedPlayers);
    expect(result.current.importedData).not.toEqual(seeded);
  });
});
