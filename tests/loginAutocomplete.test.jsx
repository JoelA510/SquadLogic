/**
 * The sign-in form tells the browser which field is which (the browser flagged the missing
 * `autocomplete` on the password input): the address and saved password on sign-in, a new
 * password on sign-up.
 */
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../frontend/src/lib/supabaseClient.js', () => ({ supabase: { auth: {} } }));
vi.mock('../frontend/src/contexts/AuthContext.jsx', () => ({
  useAuth: () => ({ isConfigured: true, resetPasswordForEmail: vi.fn() }),
}));

import Login from '../frontend/src/components/Login.jsx';

const renderLogin = () =>
  render(
    <MemoryRouter>
      <Login />
    </MemoryRouter>
  );

describe('Login autocomplete', () => {
  it('sign-in: username and current-password', () => {
    renderLogin();
    expect(screen.getByLabelText('Email')).toHaveAttribute('autocomplete', 'username');
    expect(screen.getByLabelText('Password')).toHaveAttribute('autocomplete', 'current-password');
  });

  it('sign-up: email and new-password', () => {
    renderLogin();
    fireEvent.click(screen.getByRole('button', { name: 'Sign Up' }));
    expect(screen.getByLabelText('Email')).toHaveAttribute('autocomplete', 'email');
    expect(screen.getByLabelText('Password')).toHaveAttribute('autocomplete', 'new-password');
  });
});
