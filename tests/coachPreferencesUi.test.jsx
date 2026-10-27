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
import { MOCK_ORG_ID } from '../frontend/src/lib/mockSeedIds.js';

vi.mock('../frontend/src/lib/supabaseClient.js', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
}));
vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({ useOrganization: vi.fn() }));
vi.mock('../frontend/src/contexts/AuthContext.jsx', () => ({ useAuth: vi.fn() }));
vi.mock('../frontend/src/lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

const ORG = MOCK_ORG_ID;
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
      { id: C1, organization_id: ORG, full_name: 'Casey Coach' },
      { id: C3, organization_id: ORG, full_name: 'Robin Unassigned' },
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

function asRole(role, userId = 'user-admin') {
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

beforeEach(() => {
  tables = freshTables();
  tableErrors = {};
  vi.mocked(supabase.from).mockImplementation(/** @type {any} */ (builder));
  vi.mocked(supabase.rpc).mockReset();
  vi.mocked(supabase.rpc).mockResolvedValue(/** @type {any} */ ({ data: {}, error: null }));
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

  it.each([['admin']])(
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

  it('a value the core schema refuses never reaches the RPC', async () => {
    tables.locations = [{ id: 'loc-not-a-uuid', organization_id: ORG, name: 'Legacy Park' }];
    asRole('admin');
    renderPage();
    await screen.findByTestId('admin-preferences-view');
    fireEvent.click(screen.getByRole('button', { name: 'Set a preference for Robin Unassigned' }));
    const dialog = await screen.findByRole('dialog', { name: 'Set preference directly' });
    fireEvent.change(within(dialog).getByLabelText('Level'), { target: { value: 'must_keep' } });
    fireEvent.change(within(dialog).getByLabelText('Dimension'), { target: { value: 'venue' } });
    fireEvent.change(within(dialog).getByLabelText(/Venue/), {
      target: { value: 'loc-not-a-uuid' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Set preference' }));
    expect(await screen.findByText(/is not a venue value/)).toBeInTheDocument();
    expect(supabase.rpc).not.toHaveBeenCalled();
  });
});

/*
 * Every user-triggered RPC path, enumerated from the `callRpc(` call sites in
 * `useCoachPracticePreferences.js` (reject, approve, approve with
 * change, set), driven through the real UI with the RPC refusing. Each must
 * put the database's own message on screen AND claim no success. A catch
 * that swallows (`void err`) turns its row red.
 */
describe('every RPC path surfaces a database refusal', () => {
  const refuse = (code, message) =>
    vi
      .mocked(supabase.rpc)
      .mockResolvedValue(/** @type {any} */ ({ data: null, error: { code, message } }));

  const PATHS = [
    {
      path: 'reject',
      role: 'admin',
      code: '42501',
      message: 'Access denied: planted refusal on reject',
      success: /^Request rejected$/,
      rpc: 'admin_decide_coach_practice_preference',
      drive: async () => {
        await screen.findByTestId('admin-preferences-view');
        fireEvent.click(screen.getByRole('button', { name: /^Reject/ }));
      },
      stillThere: () => expect(screen.getByRole('button', { name: /^Reject/ })).toBeInTheDocument(),
    },
    {
      path: 'approve',
      role: 'admin',
      code: '22023',
      message: 'coach practice preference r1 is stale: planted refusal on approve',
      success: /^Request approved$/,
      rpc: 'admin_decide_coach_practice_preference',
      drive: async () => {
        await screen.findByTestId('admin-preferences-view');
        fireEvent.click(
          screen.getByRole('button', { name: /^Approve Casey Coach's weekday request$/ })
        );
        const dialog = await screen.findByRole('dialog', { name: 'Approve request' });
        fireEvent.click(within(dialog).getByRole('button', { name: 'Approve request' }));
      },
      stillThere: () =>
        expect(screen.getByRole('dialog', { name: 'Approve request' })).toBeInTheDocument(),
    },
    {
      path: 'approve with change',
      role: 'admin',
      code: '23514',
      message: 'new row violates check constraint (planted refusal on approve with change)',
      success: /^Request approved with change$/,
      rpc: 'admin_decide_coach_practice_preference',
      drive: async () => {
        await screen.findByTestId('admin-preferences-view');
        fireEvent.click(screen.getByRole('button', { name: /with a change$/ }));
        const dialog = await screen.findByRole('dialog', { name: 'Approve with change' });
        fireEvent.change(within(dialog).getByLabelText('Value'), { target: { value: 'THU' } });
        fireEvent.click(within(dialog).getByRole('button', { name: 'Approve with change' }));
      },
      stillThere: () =>
        expect(screen.getByRole('dialog', { name: 'Approve with change' })).toBeInTheDocument(),
    },
    {
      path: 'set',
      role: 'admin',
      code: '42501',
      message: 'Access denied: planted refusal on admin_set_coach_practice_preference',
      success: /^Preference set$/,
      rpc: 'admin_set_coach_practice_preference',
      drive: async () => {
        await screen.findByTestId('admin-preferences-view');
        fireEvent.click(
          screen.getByRole('button', { name: 'Set a preference for Robin Unassigned' })
        );
        const dialog = await screen.findByRole('dialog', { name: 'Set preference directly' });
        fireEvent.change(within(dialog).getByLabelText('Value'), { target: { value: 'FRI' } });
        fireEvent.click(within(dialog).getByRole('button', { name: 'Set preference' }));
      },
      stillThere: () =>
        expect(screen.getByRole('dialog', { name: 'Set preference directly' })).toBeInTheDocument(),
    },
  ];

  it('the table names every RPC the hook calls and all four user paths', async () => {
    // Enumerated from the hook's source, not from this table: a new callRpc
    // site with no row here fails this test.
    const fs = await import('node:fs');
    const source = fs.readFileSync(
      `${process.cwd()}/frontend/src/hooks/useCoachPracticePreferences.js`,
      'utf8'
    );
    const called = new Set([...source.matchAll(/callRpc\('([a-z_]+)'/g)].map((m) => m[1]));
    expect(called.size).toBe(2);
    expect(new Set(PATHS.map((entry) => entry.rpc))).toEqual(called);
    // Four sites: reject, approve, approve-with-change, set. (No coach requests: none signs in.)
    expect([...source.matchAll(/callRpc\('/g)]).toHaveLength(PATHS.length);
  });

  it.each(PATHS.map((entry) => [entry.path, entry]))(
    '%s: the refusal message is shown and no success is claimed',
    async (_name, entry) => {
      refuse(entry.code, entry.message);
      asRole(entry.role);
      renderPage();
      await entry.drive();
      expect(await screen.findByText(entry.message)).toBeInTheDocument();
      expect(supabase.rpc).toHaveBeenCalledWith(entry.rpc, expect.any(Object));
      expect(screen.queryByText(entry.success)).not.toBeInTheDocument();
      entry.stillThere();
    }
  );
});

describe('every load and compute failure is visible', () => {
  const approveDialog = async () => {
    await screen.findByTestId('admin-preferences-view');
    fireEvent.click(
      screen.getByRole('button', { name: /^Approve Casey Coach's weekday request$/ })
    );
    return screen.findByRole('dialog', { name: 'Approve request' });
  };

  it('admin: a failed roster read says the re-judge could not run', async () => {
    tableErrors.team_coach_assignments = {
      code: '42501',
      message: 'permission denied for table team_coach_assignments',
    };
    asRole('admin');
    renderPage();
    const dialog = await approveDialog();
    expect(within(dialog).getByRole('alert')).toHaveTextContent(
      'Could not re-judge this decision: permission denied for table team_coach_assignments'
    );
    expect(within(dialog).queryByTestId('preview-none')).not.toBeInTheDocument();
  });

  it('admin: a failed coaches read is a banner, not an empty coach table', async () => {
    tableErrors.coaches = { code: '42501', message: 'permission denied for table coaches' };
    asRole('admin');
    renderPage();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not load coaches or locations: permission denied for table coaches'
    );
  });

  it('admin: a preview core cannot compute says so instead of "None"', async () => {
    // An approved row core refuses to parse: the re-judge throws.
    tables.coach_practice_preferences.push({
      id: 'bad-1',
      organization_id: ORG,
      coach_id: C1,
      dimension: 'start_time',
      level: 'must_keep',
      value: 'Funday',
      status: 'approved',
      requested_at: '2026-09-01T10:00:00Z',
      decided_at: '2026-09-02T10:00:00Z',
      effective_from: '2026-09-02',
      effective_to: null,
    });
    asRole('admin');
    renderPage();
    const dialog = await approveDialog();
    const alert = within(dialog).getByRole('alert');
    expect(alert).toHaveTextContent('Could not re-judge this decision');
    expect(alert).toHaveTextContent('Funday');
    expect(within(dialog).queryByTestId('preview-none')).not.toBeInTheDocument();
  });
});
