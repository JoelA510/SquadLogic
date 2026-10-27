import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CalendarModal } from '../frontend/src/pages/TeamRecordPage.jsx';

// The token is read from team_calendar_tokens (20261021020000), which admins,
// the team's current coaches and its guardians can read; `canRotate` (an admin
// or the current coach) offers Regenerate.
const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  /** @type {any} */
  tokenRead: { data: null, error: null },
}));

vi.mock('../frontend/src/lib/supabaseClient.js', () => ({
  supabase: {
    rpc: mocks.rpc,
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: () => Promise.resolve(mocks.tokenRead) }),
      }),
    }),
  },
}));

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
const LINK = 'webcal://localhost:3000/functions/v1/calendar-feed?token=secure-calendar-token';

describe('CalendarModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tokenRead = { data: null, error: null };
  });

  afterEach(() => {
    if (originalClipboard) {
      Object.defineProperty(navigator, 'clipboard', originalClipboard);
    } else {
      Reflect.deleteProperty(navigator, 'clipboard');
    }
  });

  it('does not fabricate a token when the team has none, and offers Regenerate to its coach', async () => {
    render(<CalendarModal team={{ id: 'team-1' }} canRotate onClose={vi.fn()} />);

    const notice = await screen.findByText(/No calendar link is currently available/i);
    const calendarLink = screen.getByLabelText(/copy this link to your calendar app/i);
    expect(calendarLink).toHaveValue('');
    expect(calendarLink).toHaveAttribute('placeholder', 'Regenerate a link before subscribing.');
    // The bare warning token was 3.39:1 on the sunken light surface (axe `color-contrast`); the `-text`
    // token is the AA one in both themes.
    expect(notice).toHaveClass('text-status-warning-text');
    expect(notice).not.toHaveClass('text-status-warning');
    expect(screen.getByRole('button', { name: 'Copy Link' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Regenerate Link' })).toHaveAttribute(
      'type',
      'button'
    );
  });

  it('shows the link it reads, and no Regenerate to a caller who cannot rotate', async () => {
    mocks.tokenRead = { data: { token: 'secure-calendar-token' }, error: null };
    render(<CalendarModal team={{ id: 'team-1' }} onClose={vi.fn()} />);

    await waitFor(() =>
      expect(screen.getByLabelText(/copy this link to your calendar app/i)).toHaveValue(LINK)
    );
    expect(screen.queryByRole('button', { name: 'Regenerate Link' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy Link' })).toBeEnabled();
  });

  it('tells a member the policy refuses that the link is for league admins', async () => {
    render(<CalendarModal team={{ id: 'team-1' }} onClose={vi.fn()} />);
    expect(await screen.findByText(/available to league admins/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Regenerate Link' })).not.toBeInTheDocument();
  });

  it('says so when the token cannot be read', async () => {
    mocks.tokenRead = { data: null, error: { code: '500', message: 'boom' } };
    render(<CalendarModal team={{ id: 'team-1' }} canRotate onClose={vi.fn()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be loaded');
  });

  it('does not offer Regenerate until the stored token has been read', async () => {
    let resolveRead = (_value) => {};
    mocks.tokenRead = new Promise((resolve) => {
      resolveRead = resolve;
    });
    render(<CalendarModal team={{ id: 'team-1' }} canRotate onClose={vi.fn()} />);

    // A rotation that the read then overwrote would leave the old token showing.
    expect(screen.getByRole('button', { name: 'Regenerate Link' })).toBeDisabled();
    resolveRead({ data: { token: 'secure-calendar-token' }, error: null });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Regenerate Link' })).toBeEnabled()
    );
  });

  it('says there is no link rather than wait forever when there is no team', async () => {
    render(<CalendarModal team={null} canRotate onClose={vi.fn()} />);
    expect(await screen.findByText(/No calendar link is currently available/i)).toBeInTheDocument();
  });

  it('opens as a named modal dialog with focus inside, and closes on Escape', () => {
    const onClose = vi.fn();
    render(<CalendarModal team={{ id: 'team-1' }} onClose={onClose} />);

    const dialog = screen.getByRole('dialog', { name: 'Calendar Subscription' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toContainElement(/** @type {HTMLElement} */ (document.activeElement));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('uses the rotate token RPC result before enabling copy', async () => {
    mocks.rpc.mockResolvedValue({
      data: { status: 'success', calendar_token: 'secure-calendar-token' },
      error: null,
    });

    render(<CalendarModal team={{ id: 'team-1' }} canRotate onClose={vi.fn()} />);
    await screen.findByText(/No calendar link is currently available/i);

    fireEvent.click(screen.getByRole('button', { name: 'Regenerate Link' }));

    await waitFor(() => {
      expect(mocks.rpc).toHaveBeenCalledWith('rotate_calendar_token', { p_team_id: 'team-1' });
    });

    const calendarLink = screen.getByLabelText(/copy this link to your calendar app/i);
    await waitFor(() => expect(calendarLink).toHaveValue(LINK));
    const message = screen.getByText(/New link generated/i);
    expect(message).toHaveClass('text-status-warning-text');
    expect(screen.getByRole('button', { name: 'Copy Link' })).toBeEnabled();
  });

  it('shows the refusal when the server will not rotate', async () => {
    mocks.rpc.mockResolvedValue({
      data: { status: 'error', message: 'Access denied' },
      error: null,
    });
    render(<CalendarModal team={{ id: 'team-1' }} canRotate onClose={vi.fn()} />);
    await screen.findByText(/No calendar link is currently available/i);
    fireEvent.click(screen.getByRole('button', { name: 'Regenerate Link' }));
    expect(await screen.findByText('Access denied')).toBeInTheDocument();
  });

  it('catches rejected clipboard copy attempts', async () => {
    const writeText = vi.fn(() => Promise.reject(new Error('permission denied')));
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    mocks.tokenRead = { data: { token: 'secure-calendar-token' }, error: null };

    render(<CalendarModal team={{ id: 'team-1' }} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copy Link' })).toBeEnabled());

    fireEvent.click(screen.getByRole('button', { name: 'Copy Link' }));

    expect(writeText).toHaveBeenCalledWith(LINK);
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
  });
});
