import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CalendarModal } from '../frontend/src/pages/TeamRecordPage.jsx';

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
}));

vi.mock('../frontend/src/lib/supabaseClient.js', () => ({
  supabase: {
    rpc: mocks.rpc,
  },
}));

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

describe('CalendarModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (originalClipboard) {
      Object.defineProperty(navigator, 'clipboard', originalClipboard);
    } else {
      Reflect.deleteProperty(navigator, 'clipboard');
    }
  });

  it('does not fabricate a mock calendar token when a team has no token', () => {
    render(<CalendarModal team={{ id: 'team-1', calendar_token: null }} onClose={vi.fn()} />);

    const calendarLink = screen.getByLabelText(/copy this link to your calendar app/i);
    expect(calendarLink).toHaveValue('');
    expect(calendarLink).toHaveAttribute('placeholder', 'Regenerate a link before subscribing.');
    expect(calendarLink).not.toHaveValue(
      'webcal://localhost:3000/functions/v1/calendar-feed?token=mock-token'
    );

    const notice = screen.getByText(/No calendar link is currently available/i);
    expect(notice).toBeInTheDocument();
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

  it('opens as a named modal dialog with focus inside, and closes on Escape', () => {
    const onClose = vi.fn();
    render(<CalendarModal team={{ id: 'team-1', calendar_token: 'tok' }} onClose={onClose} />);

    const dialog = screen.getByRole('dialog', { name: 'Calendar Subscription' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toContainElement(/** @type {HTMLElement} */ (document.activeElement));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('uses the rotate token RPC result before enabling copy', async () => {
    mocks.rpc.mockResolvedValue({
      data: { status: 'ok', calendar_token: 'secure-calendar-token' },
      error: null,
    });

    render(<CalendarModal team={{ id: 'team-1', calendar_token: null }} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Regenerate Link' }));

    await waitFor(() => {
      expect(mocks.rpc).toHaveBeenCalledWith('rotate_calendar_token', { p_team_id: 'team-1' });
    });

    const calendarLink = screen.getByLabelText(/copy this link to your calendar app/i);
    await waitFor(() => {
      expect(calendarLink).toHaveValue(
        'webcal://localhost:3000/functions/v1/calendar-feed?token=secure-calendar-token'
      );
    });
    expect(calendarLink).not.toHaveValue(
      'webcal://localhost:3000/functions/v1/calendar-feed?token=mock-token'
    );
    const message = screen.getByText(/New link generated/i);
    expect(message).toBeInTheDocument();
    expect(message).toHaveClass('text-status-warning-text');
    expect(screen.getByRole('button', { name: 'Copy Link' })).toBeEnabled();
  });

  it('catches rejected clipboard copy attempts', async () => {
    const writeText = vi.fn(() => Promise.reject(new Error('permission denied')));
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    render(
      <CalendarModal
        team={{ id: 'team-1', calendar_token: 'secure-calendar-token' }}
        onClose={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Copy Link' }));

    expect(writeText).toHaveBeenCalledWith(
      'webcal://localhost:3000/functions/v1/calendar-feed?token=secure-calendar-token'
    );
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
  });
});
