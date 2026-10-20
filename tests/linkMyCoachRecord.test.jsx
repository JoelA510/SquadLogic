import React from 'react';
import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
  it('links before it loads the organizations, once per user, and survives a failure', async () => {
    vi.resetModules();
    const order = [];
    mocks.rpc.mockReset();
    mocks.rpc.mockImplementationOnce(async () => {
      order.push('link');
      throw new Error('network down');
    });
    mocks.rpc.mockImplementation(async () => {
      order.push('link');
      return { data: { status: 'no_match' }, error: null };
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
    const { OrganizationProvider } =
      await import('../frontend/src/contexts/OrganizationContext.jsx');
    // A new element each time, so React re-renders the provider and it reads
    // the current user.
    const tree = () => (
      <OrganizationProvider>
        <div />
      </OrganizationProvider>
    );

    mocks.user = { id: 'user-1' };
    const { rerender } = render(tree());
    await waitFor(() => expect(order).toContain('orgs'));
    expect(order.slice(0, 2)).toEqual(['link', 'orgs']);
    expect(errorSpy).toHaveBeenCalledWith(
      'Could not link this account to its coach record',
      expect.any(Error)
    );

    // The same user again: no second link. Another user: linked once more.
    mocks.user = { id: 'user-1' };
    rerender(tree());
    mocks.user = { id: 'user-2' };
    rerender(tree());
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledTimes(2));
    mocks.user = { id: 'user-2' };
    rerender(tree());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
    errorSpy.mockRestore();
    vi.doUnmock('../frontend/src/lib/supabaseClient.js');
  });
});
