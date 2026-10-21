// The contact card (Phase A2c, migration 20261021010000): the form refuses what
// set_my_contact_card would, saves through that RPC with trimmed values, and an
// unsaved card asks for a sharing choice rather than assuming one.
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ContactCardSettings from '../frontend/src/components/settings/ContactCardSettings.jsx';
import { ContactCardSchema, contactCardFormOf } from '../frontend/src/utils/contactCard.js';

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), card: null, cardError: null }));

vi.mock('../frontend/src/lib/supabaseClient.js', () => ({
  supabase: {
    rpc: (name, params) => mocks.rpc(name, params),
    // The card is read from the caller's own profile row on mount.
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve({ data: mocks.card, error: mocks.cardError }),
        }),
      }),
    }),
  },
}));

vi.mock('../frontend/src/lib/logger.js', () => ({ logger: { error: vi.fn() } }));

beforeEach(() => {
  mocks.card = { contact_phone: null, contact_email: null, share_contact: null };
  mocks.cardError = null;
  mocks.rpc.mockReset();
  mocks.rpc.mockImplementation(async (_name, params) => ({
    data: {
      contact_phone: params.p_phone,
      contact_email: params.p_email,
      share_contact: params.p_share,
    },
    error: null,
  }));
});

describe('ContactCardSchema', () => {
  it('trims, turns blanks into null, and accepts the phone shapes the server accepts', () => {
    expect(
      ContactCardSchema.parse({ phone: '  +1 (555) 010-0199 ', email: ' ', share: true })
    ).toEqual({ phone: '+1 (555) 010-0199', email: null, share: true });
  });

  it('refuses a phone, an email or a missing choice the server would refuse', () => {
    const issues = (value) =>
      ContactCardSchema.safeParse(value).error?.issues.map((issue) => issue.path[0]) ?? [];
    expect(issues({ phone: 'call me', email: '', share: true })).toEqual(['phone']);
    expect(issues({ phone: '', email: 'not-an-email', share: false })).toEqual(['email']);
    expect(issues({ phone: '', email: '', share: null })).toEqual(['share']);
  });

  it('reads an unsaved card as no choice, and a saved one as its choice', () => {
    expect(contactCardFormOf({ share_contact: null })).toEqual({
      phone: '',
      email: '',
      share: null,
    });
    expect(contactCardFormOf({ contact_phone: '555-0101', share_contact: false })).toEqual({
      phone: '555-0101',
      email: '',
      share: false,
    });
  });
});

describe('ContactCardSettings', () => {
  it('saves through set_my_contact_card with trimmed values', async () => {
    render(<ContactCardSettings userId="user-1" />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Save Contact Card' })).toBeEnabled()
    );
    fireEvent.change(screen.getByLabelText('Phone'), { target: { value: ' 555-0101 ' } });
    fireEvent.change(screen.getByLabelText('Contact email'), {
      target: { value: 'me@example.test' },
    });
    fireEvent.click(screen.getByLabelText('Share this phone and email'));
    fireEvent.click(screen.getByRole('button', { name: 'Save Contact Card' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Contact card saved.');
    expect(mocks.rpc).toHaveBeenCalledWith('set_my_contact_card', {
      p_phone: '555-0101',
      p_email: 'me@example.test',
      p_share: true,
    });
  });

  it('asks for a sharing choice on an unsaved card and calls nothing', async () => {
    render(<ContactCardSettings userId="user-1" />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Save Contact Card' })).toBeEnabled()
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save Contact Card' }));
    expect(await screen.findByText('Choose whether to share these details.')).toBeInTheDocument();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('marks an invalid phone by its field and calls nothing', async () => {
    mocks.card = { contact_phone: null, contact_email: null, share_contact: true };
    render(<ContactCardSettings userId="user-1" />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Save Contact Card' })).toBeEnabled()
    );
    fireEvent.change(screen.getByLabelText('Phone'), { target: { value: 'call me' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Contact Card' }));
    await waitFor(() =>
      expect(screen.getByLabelText('Phone')).toHaveAttribute('aria-invalid', 'true')
    );
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('shows the saved card from the profile row, not a cached copy', async () => {
    mocks.card = {
      contact_phone: '555-0177',
      contact_email: 'saved@example.test',
      share_contact: false,
    };
    render(<ContactCardSettings userId="user-1" />);
    await waitFor(() => expect(screen.getByLabelText('Phone')).toHaveValue('555-0177'));
    expect(screen.getByLabelText('Contact email')).toHaveValue('saved@example.test');
    expect(screen.getByLabelText("Don't share my contact details")).toBeChecked();
  });

  it('says so and saves nothing when the saved card cannot be read', async () => {
    mocks.cardError = { message: 'boom' };
    render(<ContactCardSettings userId="user-1" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be loaded');
    expect(screen.getByRole('button', { name: 'Save Contact Card' })).toBeDisabled();
  });

  it('shows the server’s refusal', async () => {
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { code: '22023', message: 'contact email is not an email address' },
    });
    mocks.card = { contact_phone: null, contact_email: null, share_contact: false };
    render(<ContactCardSettings userId="user-1" />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Save Contact Card' })).toBeEnabled()
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save Contact Card' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'contact email is not an email address'
    );
  });
});
