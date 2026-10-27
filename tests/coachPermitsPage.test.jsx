/**
 * The coach's /permits page (Phase C3, docs/changes/2026-10-22-phase-c-permits.md): each permit's
 * number, issuer, dates and covered fields as text, Open and Download through a short signed link,
 * every state in words, and the guardian redirect. The supabase client is a stand-in the test
 * reads; what a coach may read is the database's (`supabase/tests/facility_permits.sql`) and the
 * mock twin's (`tests/mockFacilityPermits.test.js`), not this page's.
 */
import React from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
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
const createSignedUrl = vi.fn();
const context = vi.hoisted(() => ({ role: 'coach' }));

vi.mock('../frontend/src/lib/supabaseClient.js', () => ({
  supabase: {
    rpc: (...args) => rpc(...args),
    storage: { from: () => ({ createSignedUrl }) },
  },
}));
vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: () => ({
    currentOrganization: { id: ORG },
    orgMember: context.role ? { role: context.role } : null,
    loading: false,
    fetchError: null,
    refetchOrgs: vi.fn(),
  }),
}));
vi.mock('../frontend/src/lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), log: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import PermitsPage from '../frontend/src/pages/PermitsPage.jsx';
import ProtectedRoute from '../frontend/src/components/ProtectedRoute.jsx';
import { PERMISSIONS } from '../frontend/src/constants/permissions.js';

const renderPage = () =>
  render(
    <MemoryRouter>
      <PermitsPage />
    </MemoryRouter>
  );
const itemOf = (permit) => screen.findByTestId(`coach-permit-${permit.id}`);

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  context.role = 'coach';
  rpc.mockImplementation(async (name) => {
    if (name === 'get_facility_permits') return readOf([VALID]);
    throw new Error(`unexpected rpc ${name}`);
  });
  createSignedUrl.mockResolvedValue({
    data: { signedUrl: 'https://files.example.test/s' },
    error: null,
  });
});

describe('the coach permits page', () => {
  it('shows a permit as text: issuer, number with its leading zero, dates, fields, file and status', async () => {
    renderPage();
    const item = await itemOf(VALID);
    expect(
      within(item).getByRole('heading', { level: 2, name: 'Valley Parks' })
    ).toBeInTheDocument();
    expect(within(item).getByText('0042')).toBeInTheDocument();
    expect(within(item).getByText('Sep 1, 2026 to Mar 1, 2027')).toBeInTheDocument();
    expect(within(item).getByText('Permit Park, Pitch 1')).toBeInTheDocument();
    expect(within(item).getByText('Valid until Mar 1, 2027')).toBeInTheDocument();
    expect(within(item).getByText(/permit\.pdf/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Field permits' })).toBeInTheDocument();
  });

  it('lists the permits the coach can produce first and the expired last', async () => {
    rpc.mockResolvedValue(readOf([EXPIRED, NOT_YET, NO_FILE, EXPIRING, VALID]));
    renderPage();
    await itemOf(VALID);
    const issuers = within(screen.getByTestId('coach-permit-list'))
      .getAllByRole('heading', { level: 2 })
      .map((h) => h.textContent);
    // Current ones (soonest to end first), then no file, not yet in force, expired.
    expect(issuers).toEqual([
      'City Recreation',
      'Valley Parks',
      'School District',
      'Winter Lease',
      'County Fields',
    ]);
  });

  it('says each state in words', async () => {
    rpc.mockResolvedValue(readOf([EXPIRED, NOT_YET, NO_FILE, EXPIRING]));
    renderPage();
    expect(await screen.findByText('Expires in 12 days')).toBeInTheDocument();
    expect(screen.getByText('Expired 3 days ago')).toBeInTheDocument();
    expect(screen.getByText('Starts Dec 1, 2026')).toBeInTheDocument();
    expect(
      within(await itemOf(NO_FILE)).getByText(
        'No file added yet. Ask your league administrator to add it.'
      )
    ).toBeInTheDocument();
  });

  it('offers Open and Download only where there is a file, and an expired permit is shown as it is', async () => {
    rpc.mockResolvedValue(readOf([EXPIRED, NO_FILE]));
    renderPage();
    const expired = await itemOf(EXPIRED);
    // A permit blocks nothing: the expired one still opens.
    expect(within(expired).getByRole('button', { name: /^Open the file/ })).toBeEnabled();
    expect(within(expired).getByRole('button', { name: /^Download the file/ })).toBeEnabled();
    const missing = await itemOf(NO_FILE);
    expect(within(missing).queryByRole('button')).not.toBeInTheDocument();
  });

  it('shows a clear empty state, not an error, when no permit covers the coach’s fields', async () => {
    rpc.mockResolvedValue(readOf([]));
    renderPage();
    const empty = await screen.findByTestId('permits-empty');
    expect(empty).toHaveTextContent('No permits are on record for the fields your teams use');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByTestId('permits-error')).not.toBeInTheDocument();
  });

  it('says the role cannot read permits when the server refuses (42501), not that there are none', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'Access denied' } });
    renderPage();
    expect(await screen.findByTestId('permits-error')).toHaveTextContent(
      'Permits are not available to your role.'
    );
    expect(screen.queryByTestId('permits-empty')).not.toBeInTheDocument();
  });

  it('says a read that failed, and keeps the page working', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: '57014', message: 'canceling statement' } });
    renderPage();
    const error = await screen.findByTestId('permits-error');
    expect(error).toHaveTextContent('Permits could not be read: canceling statement');
    expect(error).toHaveAttribute('role', 'status');
    expect(screen.queryByTestId('permits-empty')).not.toBeInTheDocument();
  });

  it('opens the file in a new tab through a link made on tap (120 s)', async () => {
    const tab = /** @type {any} */ ({ opener: 'x', location: { href: '' }, close: vi.fn() });
    const open = vi.spyOn(window, 'open').mockReturnValue(tab);
    renderPage();
    fireEvent.click(
      within(await itemOf(VALID)).getByRole('button', {
        name: 'Open the file for the permit from Valley Parks',
      })
    );
    await waitFor(() => expect(tab.location.href).toBe('https://files.example.test/s'));
    expect(open).toHaveBeenCalledWith('about:blank', '_blank');
    expect(tab.opener).toBeNull();
    expect(createSignedUrl).toHaveBeenCalledWith(VALID.file.path, 120, undefined);
  });

  it('downloads a saved copy named for the file', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    renderPage();
    fireEvent.click(
      within(await itemOf(VALID)).getByRole('button', {
        name: 'Download the file for the permit from Valley Parks',
      })
    );
    await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
    expect(createSignedUrl).toHaveBeenCalledWith(VALID.file.path, 120, { download: 'permit.pdf' });
    const link = /** @type {HTMLAnchorElement} */ (click.mock.contexts[0]);
    expect(link.download).toBe('permit.pdf');
    expect(link.href).toBe('https://files.example.test/s');
  });

  it('announces a link that could not be made, and closes the empty tab', async () => {
    const tab = /** @type {any} */ ({ opener: 'x', location: { href: '' }, close: vi.fn() });
    vi.spyOn(window, 'open').mockReturnValue(tab);
    createSignedUrl.mockResolvedValue({ data: null, error: { message: 'Object not found' } });
    renderPage();
    fireEvent.click(
      within(await itemOf(VALID)).getByRole('button', {
        name: 'Open the file for the permit from Valley Parks',
      })
    );
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The file could not be opened: Object not found');
    expect(tab.close).toHaveBeenCalled();
    expect(tab.location.href).toBe('');
  });

  it('announces a link request that threw, closes the empty tab and never points it anywhere', async () => {
    const tab = /** @type {any} */ ({ opener: 'x', location: { href: '' }, close: vi.fn() });
    vi.spyOn(window, 'open').mockReturnValue(tab);
    createSignedUrl.mockRejectedValue(new Error('Failed to fetch'));
    renderPage();
    fireEvent.click(
      within(await itemOf(VALID)).getByRole('button', {
        name: 'Open the file for the permit from Valley Parks',
      })
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to fetch');
    expect(tab.close).toHaveBeenCalledTimes(1);
    expect(tab.location.href).toBe('');
  });

  it('announces a failure when the browser blocked the new tab, and does not leave the page', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    createSignedUrl.mockResolvedValue({ data: null, error: { message: 'Object not found' } });
    renderPage();
    fireEvent.click(
      within(await itemOf(VALID)).getByRole('button', {
        name: 'Open the file for the permit from Valley Parks',
      })
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The file could not be opened: Object not found'
    );
    // The button is usable again for a second try.
    expect(
      within(await itemOf(VALID)).getByRole('button', {
        name: 'Open the file for the permit from Valley Parks',
      })
    ).toBeEnabled();
  });

  it('announces a download that failed', async () => {
    createSignedUrl.mockResolvedValue({ data: null, error: { message: 'Object not found' } });
    renderPage();
    fireEvent.click(
      within(await itemOf(VALID)).getByRole('button', {
        name: 'Download the file for the permit from Valley Parks',
      })
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The file could not be opened: Object not found'
    );
  });

  it('has controls at least 44 px square (the stylesheet, which jsdom does not apply)', () => {
    const css = readFileSync(
      path.resolve(import.meta.dirname, '../frontend/src/styles/page.css'),
      'utf8'
    );
    const rule = /\.btn\.permit-touch\s*\{([^}]*)\}/.exec(css);
    expect(rule, 'the .btn.permit-touch rule').not.toBeNull();
    expect(Number(/min-height:\s*(\d+)px/.exec(rule[1])?.[1])).toBeGreaterThanOrEqual(44);
    expect(Number(/min-width:\s*(\d+)px/.exec(rule[1])?.[1])).toBeGreaterThanOrEqual(44);
    // And the page gives its buttons the class.
    renderPage();
    return screen.findByTestId(`coach-permit-${VALID.id}`).then((item) => {
      for (const button of within(item).getAllByRole('button')) {
        expect(button).toHaveClass('permit-touch');
      }
    });
  });
});

describe('who reaches /permits', () => {
  /** The route as App.jsx declares it, with the home beside it printing the redirect's reason. */
  function Home() {
    const location = useLocation();
    return <div data-testid="home">{location.state?.error ?? 'home'}</div>;
  }
  const renderRoute = () =>
    render(
      <MemoryRouter initialEntries={['/permits']}>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route
            path="/permits"
            element={
              <ProtectedRoute requiredPermission={PERMISSIONS.VIEW_FIELD_PERMITS}>
                <PermitsPage />
              </ProtectedRoute>
            }
          />
        </Routes>
      </MemoryRouter>
    );

  it.each(['coach', 'admin', 'tenant_admin', 'staff'])('lets a %s in', async (role) => {
    context.role = role;
    renderRoute();
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Field permits' })
    ).toBeInTheDocument();
    expect(screen.queryByTestId('home')).not.toBeInTheDocument();
  });

  it.each(['parent', 'player', 'guardian'])(
    'redirects a %s (a role SquadLogic no longer has) home, reading nothing',
    async (role) => {
      context.role = role;
      renderRoute();
      expect(await screen.findByTestId('home')).toHaveTextContent('Unauthorized access');
      expect(rpc).not.toHaveBeenCalled();
      expect(createSignedUrl).not.toHaveBeenCalled();
    }
  );

  it('redirects a member whose role is unknown to the page', async () => {
    context.role = 'visitor';
    renderRoute();
    expect(await screen.findByTestId('home')).toHaveTextContent('Unauthorized access');
  });

  it('is wired in App.jsx behind the permission, so the guard above is the one the app uses', () => {
    const app = readFileSync(path.resolve(import.meta.dirname, '../frontend/src/App.jsx'), 'utf8');
    expect(app).toMatch(
      /path="\/permits"\s+element=\{\s*<ProtectedRoute requiredPermission=\{PERMISSIONS\.VIEW_FIELD_PERMITS\}>\s*<PermitsPage \/>/
    );
  });
});

describe('what a coach is shown', () => {
  it('is the server’s answer, unchanged: one permit more or fewer is the server’s doing', async () => {
    const other = permitFixture('9', { issuer: 'Another Authority' });
    rpc.mockResolvedValue(readOf([VALID, other]));
    renderPage();
    await itemOf(VALID);
    await itemOf(other);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('get_facility_permits', { p_organization_id: ORG });
  });
});
