import React from 'react';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SeasonStatusNotice from '../frontend/src/components/chrome/SeasonStatusNotice.jsx';

/** The line above a page when the season shown is not the live one (Phase E3b). */
const mocks = vi.hoisted(() => ({ season: /** @type {any} */ (null) }));

vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: () => ({ currentSeasonSetting: mocks.season }),
}));

describe('the season status notice', () => {
  beforeEach(() => {
    mocks.season = null;
  });

  it('says nothing for the active season, or when there is none', () => {
    mocks.season = { name: 'Fall 2026', status: 'active' };
    const { container, rerender } = render(<SeasonStatusNotice />);
    expect(container.textContent).toBe('');
    mocks.season = null;
    rerender(<SeasonStatusNotice />);
    expect(container.textContent).toBe('');
  });

  it('says a draft is not live until it is activated', () => {
    mocks.season = { name: 'Fall 2027', status: 'draft' };
    render(<SeasonStatusNotice />);
    expect(screen.getByRole('status')).toHaveTextContent(
      '"Fall 2027" is a draft season: it is not live until it is activated'
    );
  });

  it('says a completed season is read-only', () => {
    mocks.season = { name: 'Fall 2025', status: 'completed' };
    render(<SeasonStatusNotice />);
    expect(screen.getByRole('status')).toHaveTextContent(
      '"Fall 2025" is a completed season: it is read-only.'
    );
  });
});
