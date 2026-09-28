/**
 * Coach practice preferences UI (Phase 8.6 PR 3b, PR 2).
 *
 * Driven through the real page, hooks and core re-judge, over a fake
 * Supabase client whose tables are plain arrays. What each block proves, and
 * the plant that turns it red, is stated beside it.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import CoachPreferencesPage from '../frontend/src/pages/CoachPreferencesPage.jsx';
import ToastHost from '../frontend/src/components/ui/ToastHost.jsx';
import { supabase } from '../frontend/src/lib/supabaseClient.js';
import { useOrganization } from '../frontend/src/contexts/OrganizationContext.jsx';
import { useAuth } from '../frontend/src/contexts/AuthContext.jsx';

vi.mock('../frontend/src/lib/supabaseClient.js', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
}));
vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({ useOrganization: vi.fn() }));
vi.mock('../frontend/src/contexts/AuthContext.jsx', () => ({ useAuth: vi.fn() }));
vi.mock('../frontend/src/lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

const ORG = 'org-1';
const C1 = '11111111-1111-4111-8111-111111111111';
const C3 = '33333333-3333-4333-8333-333333333333';
const T1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const T2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
const T3 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3';
const L1 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';

const slot = (day, time) => ({ day_of_week: day, start_time: time, field: { location_id: L1 } });

/** Two current teams for C1 (T1 on Monday, T2 on Wednesday) and one ended (T3). */
function freshTables() {
  return {
    coaches: [
      { id: C1, organization_id: ORG, full_name: 'Casey Coach', user_id: 'user-coach' },
      { id: C3, organization_id: ORG, full_name: 'Robin Unassigned', user_id: null },
    ],
    locations: [{ id: L1, organization_id: ORG, name: 'Riverside Park' }],
    teams: [
      { id: T1, organization_id: ORG, name: 'U10 Hawks' },
      { id: T2, organization_id: ORG, name: 'U12 Owls' },
      { id: T3, organization_id: ORG, name: 'U8 Wrens' },
    ],
    team_coach_assignments: [
      {
        id: 'tca-1',
        organization_id: ORG,
        team_id: T1,
        coach_id: C1,
        role: 'lead',
        effective_from: '2026-01-01',
        effective_to: null,
      },
      {
        id: 'tca-2',
        organization_id: ORG,
        team_id: T2,
        coach_id: C1,
        role: 'assistant',
        effective_from: '2026-01-01',
        effective_to: null,
      },
      // Ended: T3 is not a current team, so its series must not be listed.
      {
        id: 'tca-3',
        organization_id: ORG,
        team_id: T3,
        coach_id: C1,
        role: 'lead',
        effective_from: '2026-01-01',
        effective_to: '2026-02-01',
      },
    ],
    practice_assignments: [
      {
        id: 'pa-1',
        organization_id: ORG,
        team_id: T1,
        effective_date_range: null,
        slot: slot('mon', '18:00:00'),
      },
      {
        id: 'pa-2',
        organization_id: ORG,
        team_id: T2,
        effective_date_range: null,
        slot: slot('wed', '18:00:00'),
      },
      {
        id: 'pa-3',
        organization_id: ORG,
        team_id: T3,
        effective_date_range: null,
        slot: slot('mon', '17:00:00'),
      },
    ],
    coach_practice_preferences: [
      {
        id: 'r1',
        organization_id: ORG,
        coach_id: C1,
        dimension: 'weekday',
        level: 'must_keep',
        value: 'WED',
        status: 'requested',
        requested_at: '2026-09-20T10:00:00Z',
        decided_at: null,
        effective_from: null,
        effective_to: null,
      },
    ],
  };
}

let tables;
/** @type {Record<string, any>} */
let tableErrors;

function builder(table) {
  const filters = [];
  let range = null;
  const run = () => {
    if (tableErrors[table]) return { data: null, error: tableErrors[table] };
    let rows = (tables[table] || []).filter((row) =>
      filters.every(([column, value]) => String(row[column]) === String(value))
    );
    if (range) rows = rows.slice(range[0], range[1] + 1);
    return { data: rows, error: null };
  };
  const b = {
    select: () => b,
    eq: (column, value) => {
      filters.push([column, value]);
      return b;
    },
    order: () => b,
    range: (from, to) => {
      range = [from, to];
      return b;
    },
    then: (resolve, reject) => Promise.resolve(run()).then(resolve, reject),
  };
  return b;
}

function asRole(role, userId = role === 'coach' ? 'user-coach' : 'user-admin') {
  vi.mocked(useOrganization).mockReturnValue(
    /** @type {any} */ ({ currentOrganization: { id: ORG }, orgMember: { role } })
  );
  vi.mocked(useAuth).mockReturnValue(/** @type {any} */ ({ user: { id: userId } }));
}

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/coaches/practice-preferences']}>
      <ToastHost>
        <CoachPreferencesPage />
      </ToastHost>
    </MemoryRouter>
  );

const DECISION_CONTROL = /^(approve|reject|change|set)/i;

beforeEach(() => {
  tables = freshTables();
  tableErrors = {};
  vi.mocked(supabase.from).mockImplementation(/** @type {any} */ (builder));
  vi.mocked(supabase.rpc).mockReset();
  vi.mocked(supabase.rpc).mockResolvedValue(/** @type {any} */ ({ data: {}, error: null }));
});

describe('coach view', () => {
  // Plant (c): render the admin view's decision buttons for a coach -> red.
  it('shows the request form per dimension and no decision controls', async () => {
    asRole('coach');
    renderPage();
    await screen.findByTestId('coach-preferences-view');
    // Non-vacuous: the three request forms are there.
    expect(screen.getByRole('button', { name: 'Request weekday preference' })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Request start time preference' })
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Request venue preference' })).toBeInTheDocument();
    // The coach's pending request is listed; nothing can decide it.
    expect(await screen.findByText('Pending')).toBeInTheDocument();
    expect(screen.queryAllByRole('button', { name: DECISION_CONTROL })).toHaveLength(0);
    expect(screen.queryByTestId('admin-preferences-view')).not.toBeInTheDocument();
  });

  it('submits a request through the request RPC with the chosen level and value', async () => {
    asRole('coach');
    renderPage();
    await screen.findByTestId('coach-preferences-view');
    await screen.findByText('Pending'); // rows loaded, forms enabled
    const form = screen
      .getByRole('button', { name: 'Request start time preference' })
      .closest('form');
    fireEvent.change(within(form).getByLabelText('Level'), { target: { value: 'must_keep' } });
    fireEvent.change(within(form).getByLabelText('Value'), { target: { value: '17:30' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Request start time preference' }));
    await waitFor(() => expect(supabase.rpc).toHaveBeenCalledTimes(1));
    expect(supabase.rpc).toHaveBeenCalledWith('request_coach_practice_preference', {
      p_coach_id: C1,
      p_dimension: 'start_time',
      p_level: 'must_keep',
      p_value: 1050,
    });
  });
});

describe('admin view', () => {
  it('offers approve, reject and change on a pending request', async () => {
    asRole('admin');
    renderPage();
    await screen.findByTestId('admin-preferences-view');
    const row = screen
      .getAllByRole('row')
      .find((tr) => within(tr).queryByText('Casey Coach') && within(tr).queryByText('Must keep'));
    expect(row).toBeTruthy();
    expect(
      within(row).getByRole('button', { name: /^Approve Casey Coach's weekday request$/ })
    ).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: /^Reject/ })).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: /with a change$/ })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /^Set a preference for/ })).toHaveLength(2);
  });

  it('approve-with-change sends the changed level and value', async () => {
    asRole('admin');
    renderPage();
    await screen.findByTestId('admin-preferences-view');
    fireEvent.click(screen.getByRole('button', { name: /with a change$/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Approve with change' });
    fireEvent.change(within(dialog).getByLabelText('Level'), { target: { value: 'prefer_keep' } });
    fireEvent.change(within(dialog).getByLabelText('Value'), { target: { value: 'THU' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve with change' }));
    await waitFor(() => expect(supabase.rpc).toHaveBeenCalledTimes(1));
    expect(supabase.rpc).toHaveBeenCalledWith('admin_decide_coach_practice_preference', {
      p_preference_id: 'r1',
      p_decision: 'approve',
      p_level: 'prefer_keep',
      p_value: 'THU',
    });
  });

  it("approve-with-change to Don't care reaches the RPC (the value it keeps is inert)", async () => {
    asRole('admin');
    renderPage();
    await screen.findByTestId('admin-preferences-view');
    fireEvent.click(screen.getByRole('button', { name: /with a change$/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Approve with change' });
    fireEvent.change(within(dialog).getByLabelText('Level'), { target: { value: 'dont_care' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve with change' }));
    await waitFor(() =>
      expect(supabase.rpc).toHaveBeenCalledWith('admin_decide_coach_practice_preference', {
        p_preference_id: 'r1',
        p_decision: 'approve',
        p_level: 'dont_care',
        p_value: null,
      })
    );
  });

  // Plant (a): enumerate the preview's teams from the preference rows instead
  // of team_coach_assignments -> C1 holds no approved preference yet, the list
  // is empty, and this goes red.
  it('re-judges at approval: lists exactly the current series the must_keep breaks', async () => {
    asRole('admin');
    renderPage();
    await screen.findByTestId('admin-preferences-view');
    fireEvent.click(
      screen.getByRole('button', { name: /^Approve Casey Coach's weekday request$/ })
    );
    const dialog = await screen.findByRole('dialog', { name: 'Approve request' });
    const listed = within(dialog)
      .getAllByTestId('unsatisfiable-series')
      .map((item) => item.getAttribute('data-assignment-id'));
    // T1 practises Monday (breaks must_keep WED); T2 is Wednesday (kept); T3's
    // assignment ended, so its Monday series is not current and not listed.
    expect(listed).toEqual(['pa-1']);
    expect(within(dialog).getByTestId('unsatisfiable-series')).toHaveTextContent('U10 Hawks');
    expect(within(dialog).queryByTestId('preview-none')).not.toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve request' }));
    await waitFor(() =>
      expect(supabase.rpc).toHaveBeenCalledWith('admin_decide_coach_practice_preference', {
        p_preference_id: 'r1',
        p_decision: 'approve',
      })
    );
  });

  it('re-judges a changed value: the other team is now the one broken', async () => {
    asRole('admin');
    renderPage();
    await screen.findByTestId('admin-preferences-view');
    fireEvent.click(screen.getByRole('button', { name: /with a change$/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Approve with change' });
    fireEvent.change(within(dialog).getByLabelText('Value'), { target: { value: 'MON' } });
    const listed = within(dialog)
      .getAllByTestId('unsatisfiable-series')
      .map((item) => item.getAttribute('data-assignment-id'));
    expect(listed).toEqual(['pa-2']);
  });

  it('says "None" explicitly when no current series would be broken', async () => {
    asRole('admin');
    renderPage();
    await screen.findByTestId('admin-preferences-view');
    fireEvent.click(screen.getByRole('button', { name: 'Set a preference for Robin Unassigned' }));
    const dialog = await screen.findByRole('dialog', { name: 'Set preference directly' });
    fireEvent.change(within(dialog).getByLabelText('Level'), { target: { value: 'must_keep' } });
    fireEvent.change(within(dialog).getByLabelText('Value'), { target: { value: 'FRI' } });
    expect(within(dialog).getByTestId('preview-none')).toHaveTextContent('None');
    expect(within(dialog).getByText(/no current team assignment/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Set preference' }));
    await waitFor(() =>
      expect(supabase.rpc).toHaveBeenCalledWith('admin_set_coach_practice_preference', {
        p_coach_id: C3,
        p_dimension: 'weekday',
        p_level: 'must_keep',
        p_value: 'FRI',
      })
    );
  });
});

describe('failure states', () => {
  const MISSING = {
    code: 'PGRST205',
    message: "Could not find the table 'public.coach_practice_preferences' in the schema cache",
  };

  it.each([['admin'], ['coach']])(
    'the %s view names a missing table instead of showing an empty list',
    async (role) => {
      tableErrors.coach_practice_preferences = MISSING;
      asRole(role);
      renderPage();
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('migration has not been applied');
      expect(alert).toHaveTextContent('schema cache');
      expect(screen.queryByText('No pending requests.')).not.toBeInTheDocument();
      expect(screen.queryByText(/No approved preferences/)).not.toBeInTheDocument();
    }
  );

  it('a missing RPC (PGRST202) is surfaced with its message', async () => {
    vi.mocked(supabase.rpc).mockResolvedValue(
      /** @type {any} */ ({
        data: null,
        error: {
          code: 'PGRST202',
          message: 'Could not find the function public.admin_decide_coach_practice_preference',
        },
      })
    );
    asRole('admin');
    renderPage();
    await screen.findByTestId('admin-preferences-view');
    fireEvent.click(screen.getByRole('button', { name: /^Reject/ }));
    expect(
      await screen.findByText(
        /Could not find the function public.admin_decide_coach_practice_preference/
      )
    ).toBeInTheDocument();
  });

  it('an RPC refusal is surfaced with the database message', async () => {
    vi.mocked(supabase.rpc).mockResolvedValue(
      /** @type {any} */ ({
        data: null,
        error: {
          code: '42501',
          message:
            'Access denied: only the coach themself or an admin of their organization requests a coach practice preference',
        },
      })
    );
    asRole('coach');
    renderPage();
    await screen.findByTestId('coach-preferences-view');
    await screen.findByText('Pending'); // rows loaded, forms enabled
    fireEvent.click(screen.getByRole('button', { name: 'Request weekday preference' }));
    expect(await screen.findByText(/Access denied: only the coach themself/)).toBeInTheDocument();
  });

  it('a value the core schema refuses never reaches the RPC', async () => {
    tables.locations = [{ id: 'loc-not-a-uuid', organization_id: ORG, name: 'Legacy Park' }];
    asRole('coach');
    renderPage();
    await screen.findByTestId('coach-preferences-view');
    await screen.findByText('Pending'); // rows loaded, forms enabled
    const form = screen.getByRole('button', { name: 'Request venue preference' }).closest('form');
    fireEvent.change(within(form).getByLabelText('Venue (location)'), {
      target: { value: 'loc-not-a-uuid' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Request venue preference' }));
    expect(await screen.findByText(/is not a venue value/)).toBeInTheDocument();
    expect(supabase.rpc).not.toHaveBeenCalled();
  });
});
