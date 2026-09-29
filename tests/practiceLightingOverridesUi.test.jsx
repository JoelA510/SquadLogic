/**
 * Portable-lighting override UI (8.9 D14 PR D): the coach request form and the
 * admin approval queue, driven through the real page and hooks over a fake
 * Supabase client whose tables are plain arrays and whose `rpc` is the mock
 * RPC handler itself (`mockLightingOverrides.js`), so the UI and the mock's
 * refusals are exercised together.
 *
 * Expectations are enumerated from the SEED (which slots each user coaches is
 * fixed by construction below), never from what the page rendered.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import PracticeLightingPage from '../frontend/src/pages/PracticeLightingPage.jsx';
import ToastHost from '../frontend/src/components/ui/ToastHost.jsx';
import { supabase } from '../frontend/src/lib/supabaseClient.js';
import { handleLightingOverrideRpc } from '../frontend/src/lib/mockLightingOverrides.js';
import { OVERLAP_MESSAGE } from '../frontend/src/utils/lightingOverrides.js';
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
const LONG_AGO = '2020-01-01';
const ENDED = '2020-06-30';

/**
 * By construction: `coach-user` coaches T1 (slot S1) now and T3 (slot S3) only
 * in 2020; `other-coach` coaches T2 (slot S2). So the coach is offered S1 only.
 */
const SLOTS = [
  { id: 'S1', day: 'tue', start: '18:00:00', end: '19:30:00', field: 'F1' },
  { id: 'S2', day: 'wed', start: '17:00:00', end: '18:00:00', field: 'F1' },
  { id: 'S3', day: 'thu', start: '16:00:00', end: '17:00:00', field: 'F2' },
];
const FIELDS = { F1: 'North Pitch', F2: 'South Pitch' };
const COACH_SLOTS = ['S1'];
const LABEL = {
  S1: 'Tue 18:00–19:30 · North Pitch',
  S2: 'Wed 17:00–18:00 · North Pitch',
  S3: 'Thu 16:00–17:00 · South Pitch',
};

const override = (id, slot, window, status, requestedBy, extra = {}) => ({
  id,
  organization_id: ORG,
  practice_slot_id: slot,
  window,
  kind: 'portable-lighting',
  status,
  requested_by: requestedBy,
  requested_at: `2026-09-2${id.length % 9}T10:00:00Z`,
  decided_by: status === 'approved' || status === 'rejected' ? 'admin-b' : null,
  decided_at: status === 'approved' || status === 'rejected' ? '2026-09-25T10:00:00Z' : null,
  withdrawn_by: status === 'withdrawn' ? requestedBy : null,
  withdrawn_at: status === 'withdrawn' ? '2026-09-26T10:00:00Z' : null,
  ...extra,
});

function freshTables() {
  return {
    organization_members: [
      { organization_id: ORG, profile_id: 'admin-a', role: 'admin' },
      { organization_id: ORG, profile_id: 'admin-b', role: 'admin' },
      { organization_id: ORG, profile_id: 'coach-user', role: 'coach' },
      { organization_id: ORG, profile_id: 'other-coach', role: 'coach' },
    ],
    coaches: [
      { id: 'C1', organization_id: ORG, user_id: 'coach-user', full_name: 'Coach One' },
      { id: 'C2', organization_id: ORG, user_id: 'other-coach', full_name: 'Coach Two' },
    ],
    team_coach_assignments: [
      { id: 'a1', organization_id: ORG, team_id: 'T1', coach_id: 'C1', effective_from: LONG_AGO },
      { id: 'a2', organization_id: ORG, team_id: 'T2', coach_id: 'C2', effective_from: LONG_AGO },
      {
        id: 'a3',
        organization_id: ORG,
        team_id: 'T3',
        coach_id: 'C1',
        effective_from: LONG_AGO,
        effective_to: ENDED,
      },
    ],
    practice_assignments: [
      { id: 'p1', organization_id: ORG, team_id: 'T1', slot_id: 'S1', practice_slot_id: 'S1' },
      { id: 'p2', organization_id: ORG, team_id: 'T2', slot_id: 'S2', practice_slot_id: 'S2' },
      { id: 'p3', organization_id: ORG, team_id: 'T3', slot_id: 'S3', practice_slot_id: null },
    ],
    practice_slots: SLOTS.map((slot) => ({
      id: slot.id,
      organization_id: ORG,
      day_of_week: slot.day,
      start_time: slot.start,
      end_time: slot.end,
      field_id: slot.field,
    })),
    fields: Object.entries(FIELDS).map(([id, name]) => ({ id, name, organization_id: ORG })),
    practice_lighting_overrides: [
      override('mine-req', 'S1', '[2026-10-01,2026-10-03)', 'requested', 'coach-user'),
      override('mine-appr', 'S1', '[2026-10-10,2026-10-11)', 'approved', 'coach-user'),
      override('mine-rej', 'S1', '[2026-10-20,2026-10-21)', 'rejected', 'coach-user'),
      override('others-on-mine', 'S1', '[2026-11-01,2026-11-02)', 'requested', 'admin-a'),
      override('theirs', 'S2', '[2026-10-05,2026-10-08)', 'requested', 'other-coach'),
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
      filters.every(([column, value]) =>
        Array.isArray(value)
          ? value.map(String).includes(String(row[column]))
          : String(row[column]) === String(value)
      )
    );
    if (range) rows = rows.slice(range[0], range[1] + 1);
    return { data: rows.map((row) => ({ ...row })), error: null };
  };
  const b = {
    select: () => b,
    eq: (column, value) => {
      filters.push([column, value]);
      return b;
    },
    in: (column, values) => {
      filters.push([column, values]);
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

let currentUser;
function asUser(role, userId) {
  currentUser = userId;
  vi.mocked(useOrganization).mockReturnValue(
    /** @type {any} */ ({ currentOrganization: { id: ORG }, orgMember: { role } })
  );
  vi.mocked(useAuth).mockReturnValue(/** @type {any} */ ({ user: { id: userId } }));
}

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/schedule/practice-lighting']}>
      <ToastHost>
        <PracticeLightingPage />
      </ToastHost>
    </MemoryRouter>
  );

const DECISION_CONTROL = /^(approve|reject)/i;

beforeEach(() => {
  tables = freshTables();
  tableErrors = {};
  vi.mocked(supabase.from).mockImplementation(/** @type {any} */ (builder));
  vi.mocked(supabase.rpc).mockReset();
  vi.mocked(supabase.rpc).mockImplementation(
    /** @type {any} */ (
      async (name, params) =>
        handleLightingOverrideRpc(tables, name, params, { currentUserId: currentUser }) ?? {
          data: null,
          error: { code: 'PGRST202', message: `no rpc ${name}` },
        }
    )
  );
});

async function coachView() {
  asUser('coach', 'coach-user');
  renderPage();
  await screen.findByTestId('coach-lighting-view');
  await screen.findByRole('heading', { name: 'Your requests' });
}

async function adminView(userId = 'admin-a') {
  asUser('admin', userId);
  renderPage();
  await screen.findByTestId('admin-lighting-view');
  await screen.findByRole('heading', { name: /Requests awaiting a decision/ });
}

const rowFor = (label, from) =>
  screen
    .getAllByRole('row')
    .find((tr) => within(tr).queryByText(label) && within(tr).queryAllByText(from).length > 0);

describe('coach request form', () => {
  // Plant: drop the effective_to (current today) filter in coachedPracticeSlotIds -> S3 offered.
  // Plant: drop the user_id filter -> S2 offered.
  it('offers exactly the slots the seed says the coach coaches', async () => {
    await coachView();
    const select = screen.getByLabelText('Practice slot');
    const offered = within(select)
      .getAllByRole('option')
      .map((option) => option.getAttribute('value'))
      .filter(Boolean);
    // Meta: the seed has slots the coach does NOT coach, so the filter is exercised.
    expect(SLOTS.length - COACH_SLOTS.length).toBeGreaterThanOrEqual(2);
    expect(offered.sort()).toEqual([...COACH_SLOTS].sort());
    expect(within(select).getByRole('option', { name: LABEL.S1 })).toBeInTheDocument();
  });

  it('submits through the request RPC, lists the new request and moves focus to the result', async () => {
    await coachView();
    fireEvent.change(screen.getByLabelText('Practice slot'), { target: { value: 'S1' } });
    fireEvent.change(screen.getByLabelText('First date'), { target: { value: '2026-12-01' } });
    fireEvent.change(screen.getByLabelText('Last date (inclusive)'), {
      target: { value: '2026-12-04' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Request lighting override' }));
    const status = await screen.findByTestId('lighting-form-status');
    expect(status).toHaveAttribute('role', 'status');
    await waitFor(() => expect(document.activeElement).toBe(status));
    expect(supabase.rpc).toHaveBeenCalledWith('request_practice_lighting_override', {
      p_practice_slot_id: 'S1',
      p_from: '2026-12-01',
      p_until: '2026-12-04',
    });
    const row = await waitFor(() => {
      const found = rowFor(LABEL.S1, '2026-12-01');
      expect(found).toBeTruthy();
      return found;
    });
    expect(within(row).getByText('2026-12-04')).toBeInTheDocument();
    expect(within(row).getByText('Requested')).toBeInTheDocument();
  });

  it('refuses an inverted window with the schema message, in an alert, without calling the RPC', async () => {
    await coachView();
    fireEvent.change(screen.getByLabelText('Practice slot'), { target: { value: 'S1' } });
    fireEvent.change(screen.getByLabelText('First date'), { target: { value: '2026-12-05' } });
    fireEvent.change(screen.getByLabelText('Last date (inclusive)'), {
      target: { value: '2026-12-01' },
    });
    fireEvent.submit(
      screen.getByRole('button', { name: 'Request lighting override' }).closest('form')
    );
    const alert = await screen.findByTestId('lighting-form-error');
    expect(alert).toHaveAttribute('role', 'alert');
    expect(alert).toHaveTextContent(/must not precede/);
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  // Plant: show the Withdraw button for every row regardless of requester/status -> red.
  it('offers withdraw only on the coach’s own requested or approved rows', async () => {
    await coachView();
    const seeded = freshTables().practice_lighting_overrides.filter((row) =>
      COACH_SLOTS.includes(row.practice_slot_id)
    );
    // Meta: every branch of the rule is present in the seed.
    const withdrawable = seeded.filter(
      (row) => row.requested_by === 'coach-user' && ['requested', 'approved'].includes(row.status)
    );
    expect(withdrawable.length).toBe(2);
    expect(seeded.some((row) => row.requested_by !== 'coach-user')).toBe(true);
    expect(seeded.some((row) => row.status === 'rejected')).toBe(true);
    for (const row of seeded) {
      const from = row.window.slice(1, 11);
      const tr = rowFor(LABEL.S1, from);
      expect(tr, `row ${row.id} is listed`).toBeTruthy();
      const expected = withdrawable.includes(row);
      expect(within(tr).queryAllByRole('button', { name: /^Withdraw/ })).toHaveLength(
        expected ? 1 : 0
      );
    }
    // Another coach's slot is not shown to this coach at all.
    expect(screen.queryByText(LABEL.S2)).not.toBeInTheDocument();
  });

  it('withdraws through the withdraw RPC and shows the new status', async () => {
    await coachView();
    const tr = rowFor(LABEL.S1, '2026-10-10');
    fireEvent.click(within(tr).getByRole('button', { name: /^Withdraw the approved override/ }));
    await waitFor(() =>
      expect(supabase.rpc).toHaveBeenCalledWith('withdraw_practice_lighting_override', {
        p_override_id: 'mine-appr',
      })
    );
    await waitFor(() =>
      expect(within(rowFor(LABEL.S1, '2026-10-10')).getByText('Withdrawn')).toBeInTheDocument()
    );
  });

  // Plant: render AdminLightingQueue for a coach -> red.
  it('has no decision controls and no queue', async () => {
    await coachView();
    expect(screen.queryAllByRole('button', { name: DECISION_CONTROL })).toHaveLength(0);
    expect(screen.queryByTestId('admin-lighting-view')).not.toBeInTheDocument();
  });
});

describe('admin approval queue', () => {
  it('lists every requested row of the org with approve and reject', async () => {
    await adminView();
    const requested = freshTables().practice_lighting_overrides.filter(
      (row) => row.status === 'requested'
    );
    expect(screen.getAllByTestId('lighting-pending-row')).toHaveLength(requested.length);
    expect(screen.getByText(`Requests awaiting a decision (${requested.length})`)).toBeVisible();
  });

  // Plant: drop `own ||` from the Approve/Reject `disabled` -> red.
  it('disables deciding the admin’s own request and says why', async () => {
    await adminView('admin-a');
    const own = rowFor(LABEL.S1, '2026-11-01');
    const other = rowFor(LABEL.S2, '2026-10-05');
    expect(within(own).getByRole('button', { name: /^Approve/ })).toBeDisabled();
    expect(within(own).getByRole('button', { name: /^Reject/ })).toBeDisabled();
    const reason = within(own).getByTestId('lighting-self-decide-reason');
    expect(reason).toHaveTextContent(/You requested this/);
    expect(within(own).getByRole('button', { name: /^Approve/ })).toHaveAttribute(
      'aria-describedby',
      expect.stringContaining(reason.id)
    );
    expect(within(other).getByRole('button', { name: /^Approve/ })).toBeEnabled();
    expect(within(other).getByRole('button', { name: /^Reject/ })).toBeEnabled();
    // Another admin may decide it.
    screen.getByTestId('admin-lighting-view');
  });

  it('shows the no-lights-off note beside approve (declared, not enforced)', async () => {
    await adminView();
    const note = screen.getByTestId('lighting-no-lights-off-note');
    expect(note).toHaveTextContent(/No lights-off time/);
    expect(note).toHaveTextContent(/declared, not\s+enforced/);
    const approve = within(rowFor(LABEL.S2, '2026-10-05')).getByRole('button', {
      name: /^Approve/,
    });
    expect(approve.getAttribute('aria-describedby')).toContain(note.id);
  });

  it('approves another user’s request through the decide RPC', async () => {
    await adminView('admin-a');
    fireEvent.click(
      within(rowFor(LABEL.S2, '2026-10-05')).getByRole('button', { name: /^Approve/ })
    );
    await waitFor(() =>
      expect(supabase.rpc).toHaveBeenCalledWith('admin_decide_practice_lighting_override', {
        p_override_id: 'theirs',
        p_decision: 'approve',
      })
    );
    await waitFor(() => expect(screen.getAllByTestId('lighting-approved-row')).toHaveLength(2));
  });

  // Plant: show `error.message` instead of lightingOverrideErrorMessage -> red.
  it('explains an overlapping approval in an alert', async () => {
    tables.practice_lighting_overrides.push(
      override('clash', 'S2', '[2026-10-07,2026-10-09)', 'approved', 'admin-b')
    );
    await adminView('admin-a');
    fireEvent.click(
      within(rowFor(LABEL.S2, '2026-10-05')).getByRole('button', { name: /^Approve/ })
    );
    const alert = await screen.findByTestId('lighting-list-error');
    expect(alert).toHaveAttribute('role', 'alert');
    expect(alert).toHaveTextContent(OVERLAP_MESSAGE);
    await waitFor(() => expect(document.activeElement).toBe(alert));
    expect(tables.practice_lighting_overrides.find((row) => row.id === 'theirs').status).toBe(
      'requested'
    );
  });

  it('explains an overlapping direct set in an alert', async () => {
    await adminView('admin-a');
    const form = screen.getByRole('button', { name: 'Set lighting override' }).closest('form');
    fireEvent.change(within(form).getByLabelText('Practice slot'), { target: { value: 'S1' } });
    fireEvent.change(within(form).getByLabelText('First date'), {
      target: { value: '2026-10-10' },
    });
    fireEvent.change(within(form).getByLabelText('Last date (inclusive)'), {
      target: { value: '2026-10-12' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Set lighting override' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent(OVERLAP_MESSAGE);
  });
});

describe('failed reads', () => {
  // Plant: render the lists even when `error` is set -> the empty text appears -> red.
  it.each([
    ['coach', 'coach-user', 'coach-lighting-view', /You have not requested/],
    ['admin', 'admin-a', 'admin-lighting-view', /No requests are waiting/],
  ])(
    'a failed override read shows an alert, not an empty list (%s)',
    async (role, user, view, empty) => {
      tableErrors.practice_lighting_overrides = { code: '42501', message: 'permission denied' };
      tables.practice_lighting_overrides = [];
      asUser(role, user);
      renderPage();
      await screen.findByTestId(view);
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(/Could not load lighting overrides: permission denied/);
      expect(screen.queryByText(empty)).not.toBeInTheDocument();
      expect(screen.queryAllByRole('table')).toHaveLength(0);
    }
  );

  it('a failed slot read shows an alert and no form', async () => {
    tableErrors.practice_slots = { code: '500', message: 'boom' };
    asUser('coach', 'coach-user');
    renderPage();
    expect(await screen.findByRole('alert')).toHaveTextContent(/your practice slots: boom/);
    expect(screen.queryByLabelText('Practice slot')).not.toBeInTheDocument();
  });

  it('a malformed stored row is a load error, never silently dropped', async () => {
    tables.practice_lighting_overrides.push(
      override('bad', 'S1', '[2026-10-01,)', 'requested', 'coach-user')
    );
    asUser('admin', 'admin-a');
    renderPage();
    await screen.findByTestId('admin-lighting-view');
    expect(await screen.findByRole('alert')).toHaveTextContent(/row \d+ \(bad\)/);
  });
});
