/**
 * The "Field permits" card on the coach home (Phase C3, docs/changes/2026-10-22-phase-c-permits.md):
 * every state in words (none, current, expiring, expired, no file, not yet in force, a failed read),
 * a link to the page, and nothing refused. The supabase client is a stand-in the test reads.
 */
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import {
  EXPIRED,
  EXPIRING,
  NOT_YET,
  NO_FILE,
  ORG,
  VALID,
  permitFixture,
  readOf,
} from './helpers/coachPermitFixtures.js';

const rpc = vi.fn();
vi.mock('../frontend/src/lib/supabaseClient.js', () => ({
  supabase: { rpc: (...args) => rpc(...args), storage: { from: () => ({}) } },
}));
vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: () => ({ currentOrganization: { id: ORG } }),
}));
vi.mock('../frontend/src/lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), log: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import CoachPermitsCard from '../frontend/src/components/coach/CoachPermitsCard.jsx';

const renderCard = () =>
  render(
    <MemoryRouter>
      <CoachPermitsCard />
    </MemoryRouter>
  );
const answer = (permits) => rpc.mockResolvedValue(readOf(permits));

beforeEach(() => {
  vi.clearAllMocks();
  answer([VALID]);
});

describe('the coach home’s Field permits card', () => {
  it('is a labelled region with a link of at least 44 px to the page', async () => {
    renderCard();
    const card = await screen.findByRole('region', { name: 'Field permits' });
    const link = within(card).getByRole('link', { name: 'Show my field permits' });
    expect(link).toHaveAttribute('href', '/permits');
    expect(link).toHaveClass('permit-touch');
  });

  it('says so, and shows no error, when no permit covers the coach’s fields', async () => {
    answer([]);
    renderCard();
    expect(await screen.findByTestId('coach-permits-empty')).toHaveTextContent(
      'No permits are on record for the fields your teams use'
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByTestId('coach-permits-error')).not.toBeInTheDocument();
    // The link stays: the page says the same, and a coach can still look.
    expect(screen.getByRole('link', { name: 'Show my field permits' })).toBeInTheDocument();
  });

  it('says the permit is current when none needs attention', async () => {
    renderCard();
    expect(await screen.findByTestId('coach-permits-clear')).toHaveTextContent(
      'The permit for your fields is current.'
    );
    expect(screen.queryByTestId('coach-permits-concerns')).not.toBeInTheDocument();
  });

  it('says every permit is current, counting them, when there are several', async () => {
    answer([VALID, permitFixture('7', { issuer: 'Second Authority' })]);
    renderCard();
    expect(await screen.findByTestId('coach-permits-clear')).toHaveTextContent(
      'All 2 permits for your fields are current.'
    );
  });

  it('names an expiring permit in words', async () => {
    answer([EXPIRING, VALID]);
    renderCard();
    expect(await screen.findByTestId('coach-permits-concerns')).toHaveTextContent(
      'Needs attention: 1 expiring within 30 days.'
    );
    const item = screen.getByTestId('coach-permit-attention');
    expect(item).toHaveTextContent('City Recreation #0099');
    expect(item).toHaveTextContent('Expires in 12 days');
    expect(item).toHaveTextContent('Covers Permit Park, Pitch 1');
    // The current one is not listed.
    expect(screen.queryByText(/Valley Parks/)).not.toBeInTheDocument();
    expect(screen.queryByTestId('coach-permits-clear')).not.toBeInTheDocument();
  });

  it('names an expired permit in words', async () => {
    answer([EXPIRED]);
    renderCard();
    expect(await screen.findByTestId('coach-permits-concerns')).toHaveTextContent(
      'Needs attention: 1 expired.'
    );
    expect(screen.getByTestId('coach-permit-attention')).toHaveTextContent('Expired 3 days ago');
    // Without a number, no "#".
    expect(screen.getByTestId('coach-permit-attention')).not.toHaveTextContent('#');
  });

  it('names a permit with no file, which a coach cannot produce, even while it is in date', async () => {
    answer([NO_FILE, VALID]);
    renderCard();
    expect(await screen.findByTestId('coach-permits-concerns')).toHaveTextContent(
      'Needs attention: 1 with no file.'
    );
    const item = screen.getByTestId('coach-permit-attention');
    expect(item).toHaveTextContent('School District');
    expect(item).toHaveTextContent('No file added yet. Ask your league administrator to add it.');
    expect(screen.queryByTestId('coach-permits-clear')).not.toBeInTheDocument();
  });

  it('names a permit not yet in force', async () => {
    answer([NOT_YET]);
    renderCard();
    expect(await screen.findByTestId('coach-permits-concerns')).toHaveTextContent(
      'Needs attention: 1 not yet in force.'
    );
    expect(screen.getByTestId('coach-permit-attention')).toHaveTextContent('Starts Dec 1, 2026');
  });

  it('counts every kind, most urgent first', async () => {
    answer([EXPIRING, NOT_YET, NO_FILE, EXPIRED, VALID]);
    renderCard();
    expect(await screen.findByTestId('coach-permits-concerns')).toHaveTextContent(
      'Needs attention: 1 expired, 1 with no file, 1 expiring within 30 days, 1 not yet in force.'
    );
    const order = screen
      .getAllByTestId('coach-permit-attention')
      .map((item) => item.querySelector('strong')?.textContent);
    expect(order).toEqual([
      'County Fields',
      'School District #0042',
      'City Recreation #0099',
      'Winter Lease #0042',
    ]);
  });

  it('says a refused or failed read, politely, and still links to the page', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'Access denied' } });
    renderCard();
    const error = await screen.findByTestId('coach-permits-error');
    expect(error).toHaveTextContent('Permits are not available to your role.');
    expect(error).toHaveAttribute('role', 'status');
    expect(screen.queryByTestId('coach-permits-empty')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Show my field permits' })).toBeInTheDocument();
  });

  it('says a read that threw, instead of throwing into the home', async () => {
    rpc.mockRejectedValue(new Error('Failed to fetch'));
    renderCard();
    expect(await screen.findByTestId('coach-permits-error')).toHaveTextContent(
      'Permits could not be read: Failed to fetch'
    );
  });

  it('says it is loading before the answer', () => {
    rpc.mockReturnValue(new Promise(() => {}));
    renderCard();
    expect(screen.getByText('Loading your field permits…')).toBeInTheDocument();
  });
});
