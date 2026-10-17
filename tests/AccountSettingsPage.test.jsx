import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../frontend/src/App.jsx';
import AccountSettingsPage from '../frontend/src/pages/AccountSettingsPage.jsx';
import { PERMISSIONS } from '../frontend/src/constants/permissions.js';
import { MOCK_ORG_ID } from '../frontend/src/lib/mockSeedIds.js';

const mocks = vi.hoisted(() => ({
  auth: null,
  org: null,
  rpc: vi.fn(),
  from: vi.fn(),
  updatePassword: vi.fn(),
  switchOrganization: vi.fn(),
  refetchOrgs: vi.fn(),
}));

vi.mock('../frontend/src/contexts/AuthContext.jsx', () => ({
  AuthProvider: ({ children }) => children,
  useAuth: () => mocks.auth,
}));

vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  OrganizationProvider: ({ children }) => children,
  useOrganization: () => mocks.org,
}));

vi.mock('../frontend/src/contexts/ImportContext.jsx', () => ({
  ImportProvider: ({ children }) => children,
}));

vi.mock('../frontend/src/contexts/ThemeContext.jsx', () => ({
  ThemeProvider: ({ children }) => children,
  useTheme: () => ({ themeMode: 'light', toggleThemeMode: vi.fn() }),
}));

vi.mock('../frontend/src/components/auth/ShadowBanner.jsx', () => ({
  default: () => null,
}));

vi.mock('../frontend/src/components/OfflineGuard.jsx', () => ({
  default: ({ children }) => children,
}));

vi.mock('../frontend/src/components/settings/InvitesSettings.jsx', () => ({
  default: () => <div>Invite Admin Panel</div>,
}));

vi.mock('../frontend/src/lib/supabaseClient.js', () => ({
  supabase: {
    rpc: mocks.rpc,
    from: mocks.from,
  },
}));

vi.mock('../frontend/src/lib/logger.js', () => ({
  logger: {
    error: vi.fn(),
  },
}));

const baseUser = {
  id: 'user-1',
  email: 'coach@example.com',
  profile: {
    id: 'user-1',
    first_name: 'Casey',
    last_name: 'Coach',
    full_name: 'Casey Coach',
    avatar_url: '',
    email: 'coach@example.com',
  },
};

const baseOrganizations = [
  {
    organization_id: MOCK_ORG_ID,
    role: 'coach',
    organizations: { id: MOCK_ORG_ID, name: 'North League', is_onboarded: true },
  },
  {
    organization_id: 'org-2',
    role: 'coach',
    organizations: { id: 'org-2', name: 'South League', is_onboarded: true },
  },
];

const resetMocks = (permissions = []) => {
  vi.clearAllMocks();
  mocks.updatePassword.mockResolvedValue({ error: null });
  mocks.refetchOrgs.mockResolvedValue();
  mocks.rpc.mockResolvedValue({ data: 'org-2', error: null });
  mocks.from.mockReturnValue({});
  mocks.auth = {
    session: { user: baseUser },
    user: baseUser,
    loading: false,
    signOut: vi.fn(),
    updatePassword: mocks.updatePassword,
    isAdmin: false,
    isCoach: true,
    isImpersonating: false,
  };
  mocks.org = {
    organizations: baseOrganizations,
    currentOrganization: baseOrganizations[0].organizations,
    orgMember: baseOrganizations[0],
    loading: false,
    fetchError: null,
    refetchOrgs: mocks.refetchOrgs,
    switchOrganization: mocks.switchOrganization,
    permissions,
  };
};

const mockProfileUpdate = (data = {}) => {
  const maybeSingle = vi.fn(() =>
    Promise.resolve({
      data:
        data === null
          ? null
          : {
              id: 'user-1',
              email: 'coach@example.com',
              first_name: 'Jordan',
              last_name: 'Coach',
              full_name: 'Jordan Coach',
              avatar_url: '',
              ...data,
            },
      error: null,
    })
  );
  const select = vi.fn(() => ({ maybeSingle }));
  const eq = vi.fn(() => ({ select }));
  const update = vi.fn(() => ({ eq }));
  mocks.from.mockReturnValue({ update });
  return { update, eq, select, maybeSingle };
};

describe('AccountSettingsPage', () => {
  beforeEach(() => {
    resetMocks();
    window.history.pushState({}, '', '/');
  });

  it('renders the /account route for an authenticated non-admin user', async () => {
    window.history.pushState({}, '', '/account');

    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Account Settings' })).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toHaveValue('coach@example.com');
    expect(screen.queryByRole('heading', { name: 'Admin Invites' })).not.toBeInTheDocument();
  });

  it('blocks mismatched password changes and associates the error with both fields', () => {
    render(<AccountSettingsPage />);

    expect(screen.getByLabelText('New Password')).toHaveAttribute('autocomplete', 'new-password');
    expect(screen.getByLabelText('Confirm Password')).toHaveAttribute(
      'autocomplete',
      'new-password'
    );

    fireEvent.change(screen.getByLabelText('New Password'), {
      target: { value: 'long-password-123' },
    });
    fireEvent.change(screen.getByLabelText('Confirm Password'), {
      target: { value: 'different-password-123' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Update Password' }));

    const error = screen.getByRole('alert');
    expect(error).toHaveTextContent('Passwords do not match.');
    expect(error).toHaveAttribute('id', 'account-password-message');
    expect(screen.getByLabelText('New Password')).toHaveAttribute(
      'aria-describedby',
      'account-password-message'
    );
    expect(screen.getByLabelText('Confirm Password')).toHaveAttribute(
      'aria-describedby',
      'account-password-message'
    );
    expect(mocks.updatePassword).not.toHaveBeenCalled();
  });

  it('announces invite code validation errors and links them to the input', () => {
    render(<AccountSettingsPage />);

    fireEvent.click(screen.getByRole('button', { name: 'Join' }));

    const error = screen.getByRole('alert');
    const inviteInput = screen.getByLabelText('Join Organization by Invite Code');

    expect(error).toHaveAttribute('id', 'account-invite-message');
    expect(error).toHaveTextContent('Enter an invite code.');
    expect(inviteInput).toHaveAttribute('aria-describedby', 'account-invite-message');
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('saves profile updates only for the authenticated profile id', async () => {
    const query = mockProfileUpdate();
    render(<AccountSettingsPage />);

    fireEvent.change(screen.getByLabelText('First Name'), { target: { value: 'Jordan' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Profile' }));

    await waitFor(() => {
      expect(mocks.from).toHaveBeenCalledWith('profiles');
      expect(query.update).toHaveBeenCalledWith({
        avatar_url: null,
        first_name: 'Jordan',
        last_name: 'Coach',
        full_name: 'Casey Coach',
      });
      expect(query.eq).toHaveBeenCalledWith('id', 'user-1');
    });
    expect(await screen.findByRole('status')).toHaveTextContent('Profile saved.');
  });

  it('does not report profile save success when no profile row is updated', async () => {
    mockProfileUpdate(null);
    render(<AccountSettingsPage />);

    fireEvent.change(screen.getByLabelText('First Name'), { target: { value: 'Jordan' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Profile' }));

    const error = await screen.findByRole('alert');
    expect(error).toHaveTextContent('No profile row was updated.');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('redeems invite codes and refreshes organizations without a page reload', async () => {
    render(<AccountSettingsPage />);

    fireEvent.change(screen.getByLabelText('Join Organization by Invite Code'), {
      target: { value: '  JOIN-123  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Join' }));

    await waitFor(() => {
      expect(mocks.rpc).toHaveBeenCalledWith('redeem_org_invite', { p_code: 'JOIN-123' });
      expect(mocks.refetchOrgs).toHaveBeenCalled();
    });
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Invite redeemed. Organization list refreshed.'
    );
    expect(screen.getByLabelText('Join Organization by Invite Code')).toHaveValue('');
  });

  it('shows admin invite controls only to organization managers', () => {
    const { rerender } = render(<AccountSettingsPage />);

    expect(screen.queryByRole('heading', { name: 'Admin Invites' })).not.toBeInTheDocument();
    expect(screen.queryByText('Invite Admin Panel')).not.toBeInTheDocument();

    resetMocks([PERMISSIONS.MANAGE_ORGANIZATION]);
    rerender(<AccountSettingsPage />);

    expect(screen.getByRole('heading', { name: 'Admin Invites' })).toBeInTheDocument();
    expect(screen.getByText('Invite Admin Panel')).toBeInTheDocument();
  });
});
