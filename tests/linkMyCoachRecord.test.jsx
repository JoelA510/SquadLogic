import React from 'react';
import { act, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getMockData, mockSupabase } from '../frontend/src/lib/mockSupabaseClient.js';
import { MOCK_ORG_ID } from '../frontend/src/lib/mockSeedIds.js';

/**
 * link_my_coach_record (migration 20261020040000) in the mock, and its caller:
 * OrganizationContext calls it once per signed-in user.
 */
const mocks = vi.hoisted(() => ({ user: null, rpc: vi.fn() }));

vi.mock('../frontend/src/contexts/AuthContext.jsx', () => ({
  useAuth: () => ({ user: mocks.user }),
}));

const setSession = (id, email) =>
  sessionStorage.setItem('__MOCK_SESSION__', JSON.stringify({ user: { id, email } }));

beforeEach(() => {
  sessionStorage.clear();
  delete window.__MOCK_DB__;
});

describe('the mock link_my_coach_record', () => {
  it('links a member to the coach row with their email, once, and audits it', async () => {
    const coach = getMockData('coaches').find(
      (c) => c.organization_id === MOCK_ORG_ID && !c.user_id
    );
    expect(coach).toBeTruthy();
    // A member of the org whose email matches the coach row, in another case.
    const uid = 'link-test-user';
    const all = getMockData('organization_members');
    all.push({ organization_id: MOCK_ORG_ID, profile_id: uid, role: 'coach' });
    window.__saveMockDB__({ ...window.__MOCK_DB__, organization_members: all });
    setSession(uid, coach.email.toUpperCase());

    const first = await mockSupabase.rpc('link_my_coach_record');
    expect(first.data).toMatchObject({ status: 'linked', coach_id: coach.id });
    const second = await mockSupabase.rpc('link_my_coach_record');
    expect(second.data.status).toBe('already_linked');
    expect(getMockData('coaches').find((c) => c.id === coach.id).user_id).toBe(uid);
    expect(
      getMockData('audit_log').filter(
        (r) => r.action === 'coach.linked' && r.resource_id === coach.id
      )
    ).toHaveLength(1);
  });

  it('refuses a caller with no session, as the server does', async () => {
    const { data, error } = await mockSupabase.rpc('link_my_coach_record');
    expect(data).toBeNull();
    expect(error?.code).toBe('42501');
  });

  it('matches nothing in an organization the caller does not belong to', async () => {
    const coach = getMockData('coaches').find((c) => !c.user_id);
    setSession('not-a-member', coach.email);
    const { data } = await mockSupabase.rpc('link_my_coach_record');
    expect(data.status).toBe('no_match');
    expect(getMockData('coaches').find((c) => c.id === coach.id).user_id ?? null).toBeNull();
  });
});

describe('OrganizationContext', () => {
  async function setup(rpcImpl) {
    vi.resetModules();
    const order = [];
    mocks.rpc.mockReset();
    mocks.rpc.mockImplementation(async () => {
      order.push('link-start');
      const result = await rpcImpl();
      order.push('link-done');
      return result;
    });
    vi.doMock('../frontend/src/lib/supabaseClient.js', () => ({
      supabase: {
        rpc: mocks.rpc,
        from: () => ({
          select: () => ({
            eq: () => {
              order.push('orgs');
              return Promise.resolve({ data: [], error: null });
            },
          }),
        }),
      },
    }));
    const { logger } = await import('../frontend/src/lib/logger.js');
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const ctx = await import('../frontend/src/contexts/OrganizationContext.jsx');
    return { order, errorSpy, ...ctx };
  }

  afterEach(() => {
    vi.doUnmock('../frontend/src/lib/supabaseClient.js');
    vi.restoreAllMocks();
  });

  it('under StrictMode, loads the organizations only after the one in-flight link finishes', async () => {
    /** @type {(value?: unknown) => void} */
    let release = () => {};
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const { order, OrganizationProvider } = await setup(async () => {
      await gate;
      return { data: { status: 'linked' }, error: null };
    });
    mocks.user = { id: 'user-1' };
    render(
      <React.StrictMode>
        <OrganizationProvider>
          <div />
        </OrganizationProvider>
      </React.StrictMode>
    );
    await waitFor(() => expect(order).toContain('link-start'));
    // The remounted effect must wait, not skip ahead to the organizations.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(order).not.toContain('orgs');
    release();
    await waitFor(() => expect(order).toContain('orgs'));
    expect(order.indexOf('link-done')).toBeLessThan(order.indexOf('orgs'));
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });

  it('links again when the organizations are refetched (a redeemed invite), and survives a failure', async () => {
    const { order, errorSpy, OrganizationProvider, useOrganization } = await setup(async () => ({
      data: { status: 'no_match' },
      error: null,
    }));
    mocks.rpc.mockImplementationOnce(async () => {
      order.push('link-start');
      throw new Error('network down');
    });
    /** @type {() => void} */
    let refetch = () => {};
    function Probe() {
      refetch = useOrganization().refetchOrgs;
      return null;
    }
    mocks.user = { id: 'user-1' };
    render(
      <OrganizationProvider>
        <Probe />
      </OrganizationProvider>
    );
    await waitFor(() => expect(order).toContain('orgs'));
    expect(errorSpy).toHaveBeenCalledWith(
      'Could not link this account to its coach record',
      expect.any(Error)
    );
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    act(() => refetch());
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledTimes(2));
  });
});
