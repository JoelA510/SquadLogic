// The "Field permits" card on the coach home (Phase C3,
// docs/changes/2026-10-22-phase-c-permits.md; admin focus R6), driven through the real home, the
// hook and the mock client's twin of the SQL: a coach sees the permits for the fields their teams
// play or practise on, beside their schedule, and nothing for a field they do not use. The seed is
// Mock Coach (leads Team A, which plays at field v1 of venue loc-1) and invented permits.
import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { seedMockDb } from './helpers/seedMockDb.js';
import { MOCK_ORG_ID } from '../frontend/src/lib/mockSeedIds.js';

const mocks = vi.hoisted(() => ({ rpcFailures: /** @type {string[]} */ ([]) }));

vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...props }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
  Navigate: ({ to }) => <div data-testid="navigate">{to}</div>,
  useLocation: () => ({ state: null }),
  useNavigate: () => vi.fn(),
}));
vi.mock('../frontend/src/lib/supabaseClient.js', async () => {
  const { mockSupabase } = await import('../frontend/src/lib/mockSupabaseClient.js');
  return {
    supabase: {
      from: (table) => mockSupabase.from(table),
      rpc: (name, params) =>
        mocks.rpcFailures.includes(name)
          ? Promise.resolve({ data: null, error: { code: '500', message: `${name} failed` } })
          : mockSupabase.rpc(name, params),
      storage: { from: () => ({}) },
    },
    supabaseReady: Promise.resolve(),
  };
});
vi.mock('../frontend/src/hooks/usePermission.js', () => ({
  usePermission: () => ({ can: () => false, role: 'coach', PERMISSIONS: {} }),
}));
vi.mock('../frontend/src/contexts/AuthContext.jsx', () => ({
  useAuth: () => ({ user: { id: 'mock-coach-id' }, isImpersonating: false }),
}));
vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: () => ({ currentOrganization: { id: MOCK_ORG_ID }, featureFlags: {} }),
}));
vi.mock('../frontend/src/lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), log: vi.fn() },
}));

const { default: DashboardPage } = await import('../frontend/src/pages/DashboardPage.jsx');

const day = (offset) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

const PERMIT_ROW = {
  organization_id: MOCK_ORG_ID,
  notes: null,
  file_path: null,
  file_name: null,
  file_mime: null,
  file_size: null,
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
};
const FILE = (permitId) => ({
  file_path: `${MOCK_ORG_ID}/${permitId}/c0000000-0000-4000-8000-000000000001.pdf`,
  file_name: 'permit.pdf',
  file_mime: 'application/pdf',
  file_size: 52_000,
});

/** Team A (t1) plays at field v1 on a slot of its own. */
function seedTeamAGame() {
  seedMockDb({
    game_slots: [
      {
        id: 'gs-permit',
        organization_id: MOCK_ORG_ID,
        field_id: 'v1',
        slot_date: day(5),
        start_time: '10:00:00',
        end_time: '11:00:00',
      },
    ],
    games: [
      {
        id: 'game-permit',
        organization_id: MOCK_ORG_ID,
        home_team_id: 't1',
        away_team_id: 't2',
        game_slot_id: 'gs-permit',
      },
    ],
  });
}

const seedPermit = (id, issuer, validTo, scope, withFile = true) =>
  seedMockDb({
    facility_permits: [
      {
        ...PERMIT_ROW,
        id,
        issuer,
        permit_number: '0042',
        valid_from: '2020-01-01',
        valid_to: validTo,
        ...(withFile ? FILE(id) : {}),
      },
    ],
    facility_permit_scopes: [
      { id: `${id}-s`, organization_id: MOCK_ORG_ID, permit_id: id, ...scope },
    ],
  });

const card = () => screen.findByRole('region', { name: 'Field permits' });

beforeEach(() => {
  sessionStorage.clear();
  delete window.__MOCK_DB__;
  sessionStorage.setItem('__MOCK_SESSION__', JSON.stringify({ user: { id: 'mock-coach-id' } }));
  mocks.rpcFailures = [];
});
afterEach(() => {
  sessionStorage.clear();
});

describe('the coach home’s Field permits card', () => {
  it('sits beside the schedule and names an expiring permit for a field the team plays on', async () => {
    seedTeamAGame();
    seedPermit('f6000000-0000-4000-8000-000000000001', 'City Recreation', day(12), {
      field_id: 'v1',
    });
    render(<DashboardPage />);
    const permits = await card();
    expect(await within(permits).findByText(/Expires in 1[1-3] days/)).toBeInTheDocument();
    expect(within(permits).getByText('City Recreation #0042')).toBeInTheDocument();
    expect(within(permits).getByText(/Covers Central Park, Field 1/)).toBeInTheDocument();
    // The schedule card is on the same home.
    expect(screen.getByRole('region', { name: 'Your schedule' })).toBeInTheDocument();
    const order = screen
      .getAllByRole('region')
      .map((region) => region.getAttribute('aria-labelledby'));
    expect(order.indexOf('coach-permits-heading')).toBe(
      order.indexOf('coach-schedule-heading') + 1
    );
  });

  it('reads a venue’s permit as covering the field the team plays on, and an expired one as expired', async () => {
    seedTeamAGame();
    seedPermit('f6000000-0000-4000-8000-000000000002', 'County Fields', '2020-02-01', {
      location_id: 'loc-1',
    });
    render(<DashboardPage />);
    const permits = await card();
    expect(await within(permits).findByText(/^Expired \d+ days ago$/)).toBeInTheDocument();
    expect(within(permits).getByText(/Covers Central Park \(whole venue\)/)).toBeInTheDocument();
  });

  it('names a permit with no file, which the coach cannot produce', async () => {
    seedTeamAGame();
    seedPermit(
      'f6000000-0000-4000-8000-000000000003',
      'School District',
      '2099-12-31',
      { field_id: 'v1' },
      false
    );
    render(<DashboardPage />);
    const permits = await card();
    expect(await within(permits).findByText(/No file added yet/)).toBeInTheDocument();
  });

  it('shows nothing of a permit for a field the coach’s teams do not use, and says so plainly', async () => {
    seedTeamAGame();
    // Field v2 is used by no game or practice of a team Mock Coach coaches.
    seedPermit('f6000000-0000-4000-8000-000000000004', 'Elsewhere Authority', '2099-12-31', {
      field_id: 'v2',
    });
    render(<DashboardPage />);
    const permits = await card();
    expect(await within(permits).findByTestId('coach-permits-empty')).toBeInTheDocument();
    expect(within(permits).queryByText(/Elsewhere Authority/)).not.toBeInTheDocument();
    expect(within(permits).queryByRole('alert')).not.toBeInTheDocument();
  });

  it('says the permits are current when every one is in date with a file', async () => {
    seedTeamAGame();
    seedPermit('f6000000-0000-4000-8000-000000000005', 'Valley Parks', '2099-12-31', {
      field_id: 'v1',
    });
    render(<DashboardPage />);
    expect(await within(await card()).findByTestId('coach-permits-clear')).toHaveTextContent(
      'The permit for your fields is current.'
    );
  });

  it('says a failed read, and the rest of the home still works', async () => {
    seedTeamAGame();
    mocks.rpcFailures = ['get_facility_permits'];
    render(<DashboardPage />);
    expect(await within(await card()).findByTestId('coach-permits-error')).toHaveTextContent(
      'Permits could not be read: get_facility_permits failed'
    );
    expect(await screen.findByRole('region', { name: 'Your schedule' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Your division' })).toBeInTheDocument();
  });
});
