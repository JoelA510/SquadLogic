// Field Management's division select on each practice slot (plan
// docs/changes/2026-10-22-demo-mode.md, D2; migration 20261029010000), through
// the real page, `useFields` and the mock client: an admin reserves a slot to a
// division of the season and opens it again; a refusal is announced and the
// select shows the stored value; a non-admin's select is disabled; before the
// migration (no `division_id`, 42703) the fields still load and no slot offers
// a reservation.
import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { seedMockDb } from './helpers/seedMockDb.js';
import { MOCK_ORG_ID, MOCK_SEASON_ID } from '../frontend/src/lib/mockSeedIds.js';

const mocks = vi.hoisted(() => ({
  isAdmin: true,
  /** Fail the fields read that names `division_id` with this error. */
  fieldsError: /** @type {null | { code: string, message: string }} */ (null),
  /** Fail the reservation RPC with this error. */
  rpcError: /** @type {null | { code: string, message: string }} */ (null),
}));

vi.mock('../frontend/src/lib/supabaseClient.js', async () => {
  const { mockSupabase } = await import('../frontend/src/lib/mockSupabaseClient.js');
  const failing = (error) => {
    const chain = {
      select: () => chain,
      eq: () => chain,
      order: () => chain,
      then: (resolve, reject) => Promise.resolve({ data: null, error }).then(resolve, reject),
    };
    return chain;
  };
  return {
    supabase: {
      from: (table) => {
        const real = mockSupabase.from(table);
        if (table !== 'fields' || !mocks.fieldsError) return real;
        return {
          ...real,
          select: (columns) =>
            String(columns).includes('division_id')
              ? failing(mocks.fieldsError)
              : mockSupabase.from(table).select(columns),
        };
      },
      rpc: (name, params) =>
        name === 'admin_set_practice_slot_division' && mocks.rpcError
          ? Promise.resolve({ data: null, error: mocks.rpcError })
          : mockSupabase.rpc(name, params),
    },
    supabaseReady: Promise.resolve(),
  };
});

vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: () => ({
    currentOrganization: { id: MOCK_ORG_ID },
    currentSeasonSetting: { id: MOCK_SEASON_ID },
  }),
}));
vi.mock('../frontend/src/hooks/usePermission.js', () => ({
  usePermission: () => ({ can: () => mocks.isAdmin }),
}));
vi.mock('../frontend/src/lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), log: vi.fn(), debug: vi.fn() },
}));
vi.mock('../frontend/src/components/scheduling/PracticeRepairLauncher.jsx', () => ({
  default: () => null,
}));

const { default: FieldManagementPage } =
  await import('../frontend/src/pages/FieldManagementPage.jsx');
const { getMockData } = await import('../frontend/src/lib/mockSupabaseClient.js');

const SELECT_NAME = 'Division for the Sat 09:00 (A) practice slot on Field 1';

function seed() {
  seedMockDb({
    field_subunits: [{ id: 'd2-half-a', organization_id: MOCK_ORG_ID, field_id: 'v1', label: 'A' }],
    practice_slots: [
      {
        id: 'd2-slot',
        organization_id: MOCK_ORG_ID,
        field_id: 'v1',
        field_subunit_id: 'd2-half-a',
        day_of_week: 'sat',
        start_time: '09:00:00',
        end_time: '09:30:00',
        capacity: 1,
        valid_from: '2026-09-05',
        valid_until: '2026-11-28',
        division_id: null,
      },
    ],
  });
}

beforeEach(() => {
  sessionStorage.clear();
  delete window.__MOCK_DB__;
  sessionStorage.setItem('__MOCK_SESSION__', JSON.stringify({ user: { id: 'mock-admin-id' } }));
  mocks.isAdmin = true;
  mocks.fieldsError = null;
  mocks.rpcError = null;
  seed();
});

describe('FieldManagementPage :: practice slot divisions (D2)', () => {
  it("reserves a slot to one of the season's divisions and opens it again", async () => {
    render(<FieldManagementPage />);
    const select = await screen.findByRole('combobox', { name: SELECT_NAME });
    await waitFor(() =>
      expect(within(select).getByRole('option', { name: 'U8 Coed' })).toBeInTheDocument()
    );
    expect(within(select).getByRole('option', { name: 'U10 Girls' })).toBeInTheDocument();
    expect(select).toHaveValue('');

    fireEvent.change(select, { target: { value: 'u8-div-id' } });
    await waitFor(() => expect(select).toHaveValue('u8-div-id'));
    expect(getMockData('practice_slots').find((s) => s.id === 'd2-slot').division_id).toBe(
      'u8-div-id'
    );
    expect(screen.getByText(/1 of \d+ reserved/)).toBeInTheDocument();

    fireEvent.change(select, { target: { value: '' } });
    await waitFor(() =>
      expect(getMockData('practice_slots').find((s) => s.id === 'd2-slot').division_id).toBeNull()
    );
    expect(select).toHaveValue('');
  });

  it('announces a refusal and keeps showing the stored value', async () => {
    mocks.rpcError = {
      code: '42501',
      message: 'only an organization admin reserves a practice slot',
    };
    render(<FieldManagementPage />);
    const select = await screen.findByRole('combobox', { name: SELECT_NAME });
    fireEvent.change(select, { target: { value: 'u8-div-id' } });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The Sat 09:00 (A) slot could not be saved: only an organization admin reserves a practice slot'
    );
    expect(select).toHaveValue('');
    expect(getMockData('practice_slots').find((s) => s.id === 'd2-slot').division_id).toBeNull();
  });

  it('disables the select for someone who cannot manage the organization', async () => {
    mocks.isAdmin = false;
    render(<FieldManagementPage />);
    expect(await screen.findByRole('combobox', { name: SELECT_NAME })).toBeDisabled();
  });

  it('before the migration (42703) still lists the fields and offers no reservation', async () => {
    mocks.fieldsError = {
      code: '42703',
      message: 'column practice_slots_1.division_id does not exist',
    };
    render(<FieldManagementPage />);
    expect(await screen.findByText('Field 1')).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: SELECT_NAME })).toBeNull();
    expect(screen.queryByText(/Practice slot divisions/)).toBeNull();
  });
});
