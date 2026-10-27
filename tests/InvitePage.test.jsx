import React from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import InvitePage from '../frontend/src/pages/InvitePage.jsx';
import { PENDING_INVITE_STORAGE_KEY } from '../frontend/src/lib/inviteStorage.js';
import { MOCK_ORG_ID } from '../frontend/src/lib/mockSeedIds.js';

const mocks = vi.hoisted(() => ({
  auth: { session: null, loading: false },
  rpc: vi.fn(),
  refetchOrgs: vi.fn(),
}));

vi.mock('../frontend/src/contexts/AuthContext.jsx', () => ({
  useAuth: () => mocks.auth,
}));

vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: () => ({ refetchOrgs: mocks.refetchOrgs }),
}));

vi.mock('../frontend/src/lib/supabaseClient.js', () => ({
  supabase: { rpc: (...args) => mocks.rpc(...args) },
}));

vi.mock('../frontend/src/components/Login.jsx', () => ({
  __esModule: true,
  default: () => <div data-testid="login-stub">Login form</div>,
}));

function renderInvite(code = '6CF5-RJHV') {
  return render(
    <MemoryRouter initialEntries={[`/invite/${code}`]}>
      <Routes>
        <Route path="/invite/:code" element={<InvitePage />} />
      </Routes>
    </MemoryRouter>
  );
}

describe('InvitePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    mocks.auth = { session: null, loading: false };
    mocks.rpc.mockResolvedValue({ data: MOCK_ORG_ID, error: null });
  });

  it('renders the inline Login with an invite banner when unauthenticated', () => {
    renderInvite();

    expect(screen.getByTestId('login-stub')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(/you've been invited/i);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('stashes the pending invite code for the post-signup flow', () => {
    renderInvite('ABCD-1234');

    expect(sessionStorage.getItem(PENDING_INVITE_STORAGE_KEY)).toBe('ABCD-1234');
  });

  it('shows a loading screen while auth state is resolving', () => {
    mocks.auth = { session: null, loading: true };
    renderInvite();

    expect(screen.queryByTestId('login-stub')).not.toBeInTheDocument();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('redeems the code immediately when a session exists', async () => {
    mocks.auth = { session: { user: { id: 'u1' } }, loading: false };
    renderInvite('6CF5-RJHV');

    await waitFor(() =>
      expect(mocks.rpc).toHaveBeenCalledWith('redeem_org_invite', { p_code: '6CF5-RJHV' })
    );
    expect(await screen.findByText(/you're in!/i)).toBeInTheDocument();
    expect(sessionStorage.getItem(PENDING_INVITE_STORAGE_KEY)).toBeNull();
    // The redeemed organization becomes the active one, even for an admin already in another: a
    // bare refetch kept them in the old one.
    await waitFor(() => expect(mocks.refetchOrgs).toHaveBeenCalledWith(MOCK_ORG_ID));
  });

  it('shows the error card when redeem fails', async () => {
    mocks.auth = { session: { user: { id: 'u1' } }, loading: false };
    mocks.rpc.mockResolvedValue({ data: null, error: new Error('Invite expired') });
    renderInvite();

    expect(await screen.findByText(/invite could not be redeemed/i)).toBeInTheDocument();
    expect(screen.getByText(/invite expired/i)).toBeInTheDocument();
  });
});
