/**
 * Every field that sets a new password says so to the browser (`new-password`), on the reset
 * page and in account settings: the browser flagged password inputs with no `autocomplete`.
 */
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../frontend/src/lib/supabaseClient.js', () => ({ supabase: { rpc: vi.fn() } }));
vi.mock('../frontend/src/contexts/AuthContext.jsx', () => ({
  useAuth: () => ({
    user: { id: 'u1', profile: {} },
    session: { user: { id: 'u1' } },
    updatePassword: vi.fn(),
    isImpersonating: false,
  }),
}));

import ResetPassword from '../frontend/src/pages/ResetPassword.jsx';
import AccountModule from '../frontend/src/components/settings/modules/AccountModule.jsx';

describe('new-password fields', () => {
  it('the reset page marks the new and the confirm field', () => {
    render(
      <MemoryRouter>
        <ResetPassword />
      </MemoryRouter>
    );
    expect(screen.getByLabelText('New Password')).toHaveAttribute('autocomplete', 'new-password');
    expect(screen.getByLabelText('Confirm Password')).toHaveAttribute(
      'autocomplete',
      'new-password'
    );
  });

  it('account settings marks the new and the confirm field', () => {
    render(<AccountModule />);
    expect(screen.getByLabelText('New Password')).toHaveAttribute('autocomplete', 'new-password');
    expect(screen.getByLabelText('Confirm New Password')).toHaveAttribute(
      'autocomplete',
      'new-password'
    );
  });
});
