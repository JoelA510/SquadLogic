/**
 * Practice preference rules UI (Phase D C1; originally Phase 8.6 PR 3b, PR 2).
 *
 * Driven through the real page, hooks and core re-judge, over a fake Supabase client whose tables
 * are plain arrays. What each block proves, and the plant that turns it red, is stated beside it.
 * C2 made it four tabs (pending musts, rules, conflicts, import); this file holds the page-level
 * behaviour of the first two, the re-judge, the add and edit dialogs and every RPC path's refusal.
 * Accept all is in `pendingMusts.test.jsx`, the rule list's filters in `preferenceRules.test.jsx`,
 * the conflicts in `preferenceConflicts.test.jsx`, the import in `preferenceImport.test.jsx`.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import CoachPreferencesPage from '../frontend/src/pages/CoachPreferencesPage.jsx';
import ToastHost from '../frontend/src/components/ui/ToastHost.jsx';
import { supabase } from '../frontend/src/lib/supabaseClient.js';
import { useOrganization } from '../frontend/src/contexts/OrganizationContext.jsx';
import { useAuth } from '../frontend/src/contexts/AuthContext.jsx';
import {
  C1,
  C3,
  LAST,
  ORG,
  SEASON,
  T1,
  T2,
  freshTables,
  makeFrom,
  ruleRow,
} from './helpers/preferenceTables.js';

vi.mock('../frontend/src/lib/supabaseClient.js', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
}));
vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({ useOrganization: vi.fn() }));
vi.mock('../frontend/src/contexts/AuthContext.jsx', () => ({ useAuth: vi.fn() }));
vi.mock('../frontend/src/lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

let tables;
/** @type {Record<string, any>} */
let tableErrors;

function asRole(role, userId = 'user-admin') {
  vi.mocked(useOrganization).mockReturnValue(
    /** @type {any} */ ({
      currentOrganization: { id: ORG },
      currentSeasonSetting: { id: SEASON, status: 'active' },
      orgMember: { role },
    })
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
  vi.mocked(supabase.from).mockImplementation(
    /** @type {any} */ ((table) => makeFrom(tables, tableErrors)(table))
  );
  vi.mocked(supabase.rpc).mockReset();
  vi.mocked(supabase.rpc).mockResolvedValue(/** @type {any} */ ({ data: {}, error: null }));
});

const rulesTab = async () => {
  await screen.findByTestId('admin-preferences-view');
  fireEvent.click(screen.getByRole('tab', { name: 'Rules' }));
  return screen.findByRole('heading', { name: /^Rules in force/ });
};

describe('admin view', () => {
  it("lists the pending musts and rules of the season shown's coaches only", async () => {
    // The table has no season: a rule is the season's through its coach. Last season's coach has a
    // pending must that must neither be listed nor offer an acceptance.
    tables.coach_practice_preferences.push(
      ruleRow({
        id: 'r-last',
        coach_id: LAST,
        weekdays: ['TUE'],
        requested_level: 'must',
        must_decision: 'pending',
      })
    );
    asRole('admin');
    renderPage();
    await screen.findByTestId('admin-preferences-view');
    expect(screen.getAllByText('Casey Coach').length).toBeGreaterThan(0);
    expect(screen.queryByText('Last Season Coach')).not.toBeInTheDocument();
    expect(screen.queryByText(/44444444-4444-4444-8444-444444444444/)).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /^Accept as must: / })).toHaveLength(1);
    expect(screen.getByRole('heading', { name: 'Pending musts (1)' })).toBeInTheDocument();
    await rulesTab();
    expect(screen.getByRole('heading', { name: 'Rules in force (2)' })).toBeInTheDocument();
    expect(screen.queryByText('Last Season Coach')).not.toBeInTheDocument();
  });

  it('opens on the pending musts when there are any and on the rules when there are none', async () => {
    asRole('admin');
    const { unmount } = renderPage();
    await screen.findByRole('heading', { name: 'Pending musts (1)' });
    expect(screen.getByRole('tab', { name: /^Pending musts/ })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    unmount();
    tables.coach_practice_preferences = tables.coach_practice_preferences.filter(
      (row) => row.id !== 'r1'
    );
    renderPage();
    await screen.findByRole('heading', { name: 'Rules in force (1)' });
    expect(screen.getByRole('tab', { name: 'Rules' })).toHaveAttribute('aria-selected', 'true');
  });

  it('offers accept and keep-as-prefer on a pending must, and one add button on the rules', async () => {
    asRole('admin');
    renderPage();
    await screen.findByTestId('admin-preferences-view');
    const row = screen
      .getAllByRole('row')
      .find(
        (tr) =>
          within(tr).queryByText('Casey Coach') &&
          within(tr).queryByText('U10 Hawks') &&
          within(tr).queryByRole('button', { name: /^Accept/ })
      );
    expect(row).toBeTruthy();
    expect(within(row).getByText('Wednesday')).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: /^Keep as prefer: / })).toBeInTheDocument();
    await rulesTab();
    expect(screen.getAllByRole('button', { name: 'Add a rule…' })).toHaveLength(1);
    expect(within(screen.getByRole('table')).getByText('Pending must')).toBeInTheDocument();
  });

  // Plant (a): enumerate the preview's series from the rule rows instead of the practice rows ->
  // nothing is listed and this goes red.
  it('re-judges at acceptance: lists exactly the current series the must would break', async () => {
    asRole('admin');
    renderPage();
    await screen.findByTestId('admin-preferences-view');
    fireEvent.click(screen.getByRole('button', { name: /^Accept as must: / }));
    const dialog = await screen.findByRole('dialog', { name: 'Accept as must' });
    const listed = within(dialog)
      .getAllByTestId('unsatisfiable-series')
      .map((item) => item.getAttribute('data-assignment-id'));
    // T1 practises Monday (breaks a must for WED); T2 is not this rule's team; T3's series is not T1's.
    expect(listed).toEqual(['pa-1']);
    expect(within(dialog).getByTestId('unsatisfiable-series')).toHaveTextContent('U10 Hawks');
    expect(within(dialog).queryByTestId('preview-none')).not.toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Accept as must' }));
    await waitFor(() =>
      expect(supabase.rpc).toHaveBeenCalledWith('admin_decide_must_preference', {
        p_preference_id: 'r1',
        p_decision: 'accept',
      })
    );
  });

  it('keep as prefer reaches the RPC with its decision', async () => {
    asRole('admin');
    renderPage();
    await screen.findByTestId('admin-preferences-view');
    fireEvent.click(screen.getByRole('button', { name: /^Keep as prefer: / }));
    await waitFor(() =>
      expect(supabase.rpc).toHaveBeenCalledWith('admin_decide_must_preference', {
        p_preference_id: 'r1',
        p_decision: 'keep_prefer',
      })
    );
  });

  it('remove asks first, names the rule, and reaches the RPC only when confirmed', async () => {
    asRole('admin');
    renderPage();
    await rulesTab();
    fireEvent.click(screen.getByRole('button', { name: /^Remove .*Riverside Park$/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove this rule' });
    expect(dialog).toHaveTextContent("Casey Coach's rule for U12 Owls: Riverside Park");
    // Removing stops the rule applying now; it does not stop a later file from adding it again
    // (the finalizer inserts a file's rules without excluding what was removed), so the dialog must
    // not promise that it cannot come back, for an imported rule or any other.
    expect(dialog).toHaveTextContent('stops applying to the scheduler at once');
    expect(dialog).toHaveTextContent('kept in the audit trail');
    expect(dialog).toHaveTextContent(
      'importing a file that contains the same preference again can bring it back'
    );
    expect(dialog.textContent).not.toMatch(
      /does not bring it back|cannot (come|return)|never (come|return)/i
    );
    expect(supabase.rpc).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(supabase.rpc).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /^Remove .*Riverside Park$/ }));
    fireEvent.click(
      within(await screen.findByRole('dialog', { name: 'Remove this rule' })).getByRole('button', {
        name: 'Remove rule',
      })
    );
    await waitFor(() =>
      expect(supabase.rpc).toHaveBeenCalledWith('admin_remove_practice_preference', {
        p_preference_id: 'r2',
      })
    );
  });
});

describe('the add and edit dialogs', () => {
  const openAdd = async () => {
    asRole('admin');
    renderPage();
    await rulesTab();
    fireEvent.click(screen.getByRole('button', { name: 'Add a rule…' }));
    return screen.findByRole('dialog', { name: 'Add a rule' });
  };

  it("adds a rule with several values for one of the coach's teams, re-judging a must against that team's series", async () => {
    const dialog = await openAdd();
    fireEvent.change(within(dialog).getByLabelText('Coach'), { target: { value: C1 } });
    fireEvent.change(within(dialog).getByLabelText('Team'), { target: { value: T2 } });
    fireEvent.change(within(dialog).getByLabelText('Level'), { target: { value: 'must' } });
    fireEvent.click(within(dialog).getByLabelText('Friday'));
    fireEvent.click(within(dialog).getByLabelText('Tuesday'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add a start time' }));
    fireEvent.change(within(dialog).getByLabelText('Start time 1'), { target: { value: '18:00' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add a start time' }));
    fireEvent.change(within(dialog).getByLabelText('Start time 2'), { target: { value: '17:00' } });
    fireEvent.click(within(dialog).getByLabelText('North Fields'));
    fireEvent.change(within(dialog).getByLabelText("Coach's priority"), {
      target: { value: 'high' },
    });
    // The sentence reads the rule back before it is saved.
    expect(within(dialog).getByTestId('rule-summary')).toHaveTextContent(
      'Must practise on Tuesday or Friday, starting at 17:00 or 18:00, at North Fields, for U12 Owls.'
    );
    // T2 practises Wednesday: a must for Tuesday or Friday breaks it.
    expect(within(dialog).getByTestId('unsatisfiable-series')).toHaveTextContent('U12 Owls');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add rule' }));
    await waitFor(() =>
      expect(supabase.rpc).toHaveBeenCalledWith('admin_add_practice_preference', {
        p_coach_id: C1,
        p_team_id: T2,
        p_level: 'must',
        p_weekdays: ['TUE', 'FRI'],
        p_start_minutes: [1020, 1080],
        p_venue_ids: ['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2'],
        p_keep_weekday: false,
        p_keep_start: false,
        p_keep_venue: false,
        p_coach_priority: 'high',
        p_effective_from: null,
        p_effective_to: null,
      })
    );
  });

  it('adds keep-current when it is chosen, and says "None" when no series would break', async () => {
    const dialog = await openAdd();
    fireEvent.change(within(dialog).getByLabelText('Coach'), { target: { value: C1 } });
    fireEvent.change(within(dialog).getByLabelText('Level'), { target: { value: 'must' } });
    fireEvent.click(within(dialog).getByLabelText('Keep the day it practises now'));
    // Keeping the current weekday of a team that practises: nothing it has is broken.
    expect(within(dialog).getByTestId('preview-none')).toHaveTextContent('None');
    expect(within(dialog).getByTestId('rule-summary')).toHaveTextContent(
      'Must practise on the day it practises now, for U10 Hawks.'
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add rule' }));
    await waitFor(() =>
      expect(supabase.rpc).toHaveBeenCalledWith(
        'admin_add_practice_preference',
        expect.objectContaining({ p_weekdays: null, p_keep_weekday: true, p_level: 'must' })
      )
    );
  });

  it('a rule with no condition says so and cannot be added', async () => {
    const dialog = await openAdd();
    fireEvent.change(within(dialog).getByLabelText('Coach'), { target: { value: C1 } });
    expect(within(dialog).getByRole('alert')).toHaveTextContent(
      'a rule has at least one condition'
    );
    expect(within(dialog).getByRole('button', { name: 'Add rule' })).toBeDisabled();
    expect(within(dialog).queryByTestId('rule-summary')).not.toBeInTheDocument();
  });

  it('a window that ends before it starts is refused in the schema’s words, before any RPC', async () => {
    const dialog = await openAdd();
    fireEvent.change(within(dialog).getByLabelText('Coach'), { target: { value: C1 } });
    fireEvent.click(within(dialog).getByLabelText('Monday'));
    fireEvent.change(within(dialog).getByLabelText('In force from (optional)'), {
      target: { value: '2026-10-10' },
    });
    fireEvent.change(within(dialog).getByLabelText('In force until (optional)'), {
      target: { value: '2026-10-01' },
    });
    expect(within(dialog).getByRole('alert')).toHaveTextContent('the window ends before it starts');
    expect(within(dialog).getByRole('button', { name: 'Add rule' })).toBeDisabled();
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it('a coach with no team today has nothing to add a rule to', async () => {
    const dialog = await openAdd();
    fireEvent.change(within(dialog).getByLabelText('Coach'), { target: { value: C3 } });
    expect(within(dialog).getByText(/coaches no team today/)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Add rule' })).toBeDisabled();
  });

  it('edits a rule: the form holds its values, and Save sends the whole rule', async () => {
    tables.coach_practice_preferences.push(
      ruleRow({
        id: 'r3',
        team_id: T1,
        level: 'must',
        requested_level: 'must',
        must_decision: 'accepted',
        weekdays: ['MON', 'WED'],
        start_minutes: [1080],
        coach_priority: 'low',
        effective_from: '2026-09-01',
        created_at: '2026-09-18T10:00:00Z',
      })
    );
    asRole('admin');
    renderPage();
    await rulesTab();
    fireEvent.click(
      screen.getByRole('button', {
        name: "Edit Casey Coach's rule for U10 Hawks: Monday or Wednesday · 18:00",
      })
    );
    const dialog = await screen.findByRole('dialog', { name: 'Edit a rule' });
    expect(within(dialog).getByLabelText('Monday')).toBeChecked();
    expect(within(dialog).getByLabelText('Wednesday')).toBeChecked();
    expect(within(dialog).getByLabelText('Friday')).not.toBeChecked();
    expect(within(dialog).getByLabelText('Start time 1')).toHaveValue('18:00');
    expect(within(dialog).getByLabelText('Level')).toHaveValue('must');
    expect(within(dialog).getByLabelText("Coach's priority")).toHaveValue('low');
    expect(within(dialog).getByLabelText('In force from (optional)')).toHaveValue('2026-09-01');
    fireEvent.click(within(dialog).getByLabelText('Wednesday'));
    fireEvent.click(within(dialog).getByLabelText('Thursday'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save rule' }));
    await waitFor(() =>
      expect(supabase.rpc).toHaveBeenCalledWith('admin_edit_practice_preference', {
        p_preference_id: 'r3',
        p_level: 'must',
        p_weekdays: ['MON', 'THU'],
        p_start_minutes: [1080],
        p_venue_ids: null,
        p_keep_weekday: false,
        p_keep_start: false,
        p_keep_venue: false,
        p_coach_priority: 'low',
        p_effective_from: '2026-09-01',
        p_effective_to: null,
      })
    );
  });

  // 20261116010000: saving a pending must no longer decides it. The editor shows "Still pending" with the level
  // as text, offers the two decisions as buttons of their own, and acts on the saved rule only.
  describe('editing a pending must (it stays pending; deciding is a separate act)', () => {
    const openPending = async () => {
      asRole('admin');
      renderPage();
      await rulesTab();
      fireEvent.click(screen.getByRole('button', { name: /^Edit .*Wednesday$/ }));
      return screen.findByRole('dialog', { name: 'Edit a rule' });
    };

    it('shows "Still pending", the level as text and Accept and Keep as buttons of their own', async () => {
      const dialog = await openPending();
      const note = within(dialog).getByTestId('edit-pending-note');
      expect(note).toHaveTextContent('Still pending');
      expect(note).toHaveTextContent('Saving your changes does not decide it');
      // No Level control to set by accident, and nothing that says Prefer or Must decides it.
      expect(within(dialog).queryByLabelText('Level')).not.toBeInTheDocument();
      expect(within(dialog).getByTestId('edit-r1-level-locked')).toHaveTextContent(
        'Prefer for now'
      );
      expect(within(dialog).queryByText(/keeps it as prefer; saving it as Must/)).toBeNull();
      expect(within(dialog).getByRole('button', { name: 'Accept as must…' })).toBeEnabled();
      expect(within(dialog).getByRole('button', { name: 'Keep as prefer' })).toBeEnabled();
      expect(within(dialog).queryByTestId('decide-hint')).not.toBeInTheDocument();
      expect(within(dialog).getByText(/came from an import file/)).toBeInTheDocument();
    });

    it('Save sends the level in force and says the rule is still waiting', async () => {
      vi.mocked(supabase.rpc).mockResolvedValue(
        /** @type {any} */ ({ data: { must_decision: 'pending' }, error: null })
      );
      const dialog = await openPending();
      fireEvent.click(within(dialog).getByLabelText('Thursday'));
      fireEvent.click(within(dialog).getByRole('button', { name: 'Save rule' }));
      await waitFor(() =>
        expect(supabase.rpc).toHaveBeenCalledWith(
          'admin_edit_practice_preference',
          expect.objectContaining({
            p_preference_id: 'r1',
            p_level: 'prefer',
            p_weekdays: ['WED', 'THU'],
          })
        )
      );
      expect(
        await screen.findByText('Rule saved. It is still waiting for your decision.')
      ).toBeTruthy();
      // Saving decided nothing: no decision RPC was called.
      expect(supabase.rpc).not.toHaveBeenCalledWith(
        'admin_decide_must_preference',
        expect.anything()
      );
    });

    it('says what the database answered when it decided the rule anyway (a database without 20261116010000)', async () => {
      vi.mocked(supabase.rpc).mockResolvedValue(
        /** @type {any} */ ({ data: { must_decision: 'kept_prefer' }, error: null })
      );
      const dialog = await openPending();
      fireEvent.click(within(dialog).getByLabelText('Thursday'));
      fireEvent.click(within(dialog).getByRole('button', { name: 'Save rule' }));
      expect(
        await screen.findByText('Rule saved. It was kept as prefer, not left pending.')
      ).toBeTruthy();
      expect(screen.queryByText(/still waiting for your decision/)).not.toBeInTheDocument();
    });

    it('Accept and Keep act on the saved rule, so they wait for Save while the form has changes', async () => {
      const dialog = await openPending();
      fireEvent.click(within(dialog).getByLabelText('Thursday'));
      const accept = within(dialog).getByRole('button', { name: 'Accept as must…' });
      const keep = within(dialog).getByRole('button', { name: 'Keep as prefer' });
      expect(accept).toBeDisabled();
      expect(keep).toBeDisabled();
      expect(within(dialog).getByTestId('decide-hint')).toHaveTextContent(
        'Save your changes first'
      );
      expect(accept).toHaveAccessibleDescription(/Save your changes first/);
      // Putting the form back to what is saved turns them on again.
      fireEvent.click(within(dialog).getByLabelText('Thursday'));
      expect(accept).toBeEnabled();
      expect(keep).toBeEnabled();
      expect(within(dialog).queryByTestId('decide-hint')).not.toBeInTheDocument();
      expect(supabase.rpc).not.toHaveBeenCalled();
    });

    it('Keep as prefer decides the saved rule on its own and closes the editor', async () => {
      const dialog = await openPending();
      fireEvent.click(within(dialog).getByRole('button', { name: 'Keep as prefer' }));
      await waitFor(() =>
        expect(supabase.rpc).toHaveBeenCalledWith('admin_decide_must_preference', {
          p_preference_id: 'r1',
          p_decision: 'keep_prefer',
        })
      );
      await waitFor(() =>
        expect(screen.queryByRole('dialog', { name: 'Edit a rule' })).not.toBeInTheDocument()
      );
      expect(supabase.rpc).not.toHaveBeenCalledWith(
        'admin_edit_practice_preference',
        expect.anything()
      );
    });

    it('Accept as must… hands over to the Accept dialog and its impact preview, and decides nothing yet', async () => {
      const dialog = await openPending();
      fireEvent.click(within(dialog).getByRole('button', { name: 'Accept as must…' }));
      const accept = await screen.findByRole('dialog', { name: 'Accept as must' });
      expect(screen.queryByRole('dialog', { name: 'Edit a rule' })).not.toBeInTheDocument();
      expect(within(accept).getAllByTestId('unsatisfiable-series')).toHaveLength(1);
      expect(supabase.rpc).not.toHaveBeenCalled();
      fireEvent.click(within(accept).getByRole('button', { name: 'Accept as must' }));
      await waitFor(() =>
        expect(supabase.rpc).toHaveBeenCalledWith('admin_decide_must_preference', {
          p_preference_id: 'r1',
          p_decision: 'accept',
        })
      );
    });

    it('a must that was already decided keeps its Level control and its wording', async () => {
      tables.coach_practice_preferences.push(
        ruleRow({
          id: 'r4',
          team_id: T2,
          weekdays: ['FRI'],
          requested_level: 'must',
          must_decision: 'kept_prefer',
          created_at: '2026-09-18T10:00:00Z',
        })
      );
      asRole('admin');
      renderPage();
      await rulesTab();
      fireEvent.click(screen.getByRole('button', { name: /^Edit .*Friday$/ }));
      const dialog = await screen.findByRole('dialog', { name: 'Edit a rule' });
      expect(within(dialog).queryByText('Still pending')).not.toBeInTheDocument();
      expect(within(dialog).queryByTestId('edit-pending-note')).not.toBeInTheDocument();
      expect(within(dialog).getByLabelText('Level')).toHaveValue('prefer');
      expect(dialog).toHaveTextContent(
        'This rule was asked for as a must (it is kept as prefer). Saving it as Prefer keeps it as prefer; saving it as Must accepts it.'
      );
      expect(within(dialog).queryByRole('button', { name: 'Keep as prefer' })).toBeNull();
    });
  });
});

describe("the day a coach 'coaches today' is the database's, not the admin's", () => {
  // `admin_assign_team_coach` stamps an assignment with the database's `current_date` (UTC), and
  // `admin_add_practice_preference` reads "coaches this team today" on the same date. The Add dialog must
  // list the same teams the RPC would accept, wherever the admin's clock is.
  const realTz = process.env.TZ;
  afterEach(() => {
    vi.useRealTimers();
    if (realTz === undefined) delete process.env.TZ;
    else process.env.TZ = realTz;
  });

  const at = (iso, tz) => {
    process.env.TZ = tz;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(iso));
  };
  const openRobin = async () => {
    asRole('admin');
    renderPage();
    await rulesTab();
    fireEvent.click(screen.getByRole('button', { name: 'Add a rule…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a rule' });
    fireEvent.change(within(dialog).getByLabelText('Coach'), { target: { value: C3 } });
    return dialog;
  };

  it('west of UTC in the evening, an assignment stamped with the database date (tomorrow here) counts', async () => {
    // 18:00 on 2026-10-01 in Los Angeles is 01:00Z on the 2nd: the RPC stamps '2026-10-02'.
    at('2026-10-02T01:00:00Z', 'America/Los_Angeles');
    tables.team_coach_assignments.push({
      id: 'tca-new',
      organization_id: ORG,
      team_id: T1,
      coach_id: C3,
      role: 'lead',
      effective_from: '2026-10-02',
      effective_to: null,
    });
    const dialog = await openRobin();
    expect(within(dialog).queryByText(/coaches no team today/)).not.toBeInTheDocument();
    expect(within(dialog).getByLabelText('Team')).toHaveValue(T1);
    fireEvent.click(within(dialog).getByLabelText('Monday'));
    expect(within(dialog).getByRole('button', { name: 'Add rule' })).toBeEnabled();
  });

  it("east of UTC after the database's day has not turned, an assignment ending on that day still counts", async () => {
    // 12:00 on 2026-10-02 in Auckland is 23:00Z on the 1st: the RPC's `current_date` is still the 1st,
    // and an assignment that ends on the 1st (inclusive) is current there.
    at('2026-10-01T23:00:00Z', 'Pacific/Auckland');
    tables.team_coach_assignments.push({
      id: 'tca-ends',
      organization_id: ORG,
      team_id: T1,
      coach_id: C3,
      role: 'lead',
      effective_from: '2026-09-01',
      effective_to: '2026-10-01',
    });
    const dialog = await openRobin();
    expect(within(dialog).queryByText(/coaches no team today/)).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByLabelText('Monday'));
    expect(within(dialog).getByRole('button', { name: 'Add rule' })).toBeEnabled();
  });
});

describe('failure states', () => {
  const MISSING = {
    code: 'PGRST205',
    message: "Could not find the table 'public.coach_practice_preferences' in the schema cache",
  };

  it('the view names a missing table instead of showing an empty list', async () => {
    tableErrors.coach_practice_preferences = MISSING;
    asRole('admin');
    renderPage();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('migration has not been applied');
    expect(alert).toHaveTextContent('schema cache');
    expect(screen.queryByText('No pending musts.')).not.toBeInTheDocument();
    expect(screen.queryByText('No rules in force.')).not.toBeInTheDocument();
  });

  it('a missing RPC (PGRST202) is surfaced with its message', async () => {
    vi.mocked(supabase.rpc).mockResolvedValue(
      /** @type {any} */ ({
        data: null,
        error: {
          code: 'PGRST202',
          message: 'Could not find the function public.admin_decide_must_preference',
        },
      })
    );
    asRole('admin');
    renderPage();
    await screen.findByTestId('admin-preferences-view');
    fireEvent.click(screen.getByRole('button', { name: /^Keep as prefer: / }));
    expect(
      await screen.findByText(/Could not find the function public.admin_decide_must_preference/)
    ).toBeInTheDocument();
  });

  it('a value the core schema refuses never reaches the RPC', async () => {
    tables.locations = [{ id: 'loc-not-a-uuid', organization_id: ORG, name: 'Legacy Park' }];
    asRole('admin');
    renderPage();
    await rulesTab();
    fireEvent.click(screen.getByRole('button', { name: 'Add a rule…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a rule' });
    fireEvent.change(within(dialog).getByLabelText('Coach'), { target: { value: C1 } });
    fireEvent.click(within(dialog).getByLabelText('Legacy Park'));
    expect(within(dialog).getByRole('alert')).toHaveTextContent(
      'a location id is a lowercase canonical uuid'
    );
    expect(within(dialog).getByRole('button', { name: 'Add rule' })).toBeDisabled();
    expect(supabase.rpc).not.toHaveBeenCalled();
  });
});

/*
 * Every user-triggered RPC path, enumerated from the `callRpc(` call sites in
 * `useCoachPracticePreferences.js` (decide a must, add, edit, remove, accept all), driven through
 * the real UI with the RPC refusing. Each must put the database's own message on screen AND claim
 * no success. A catch that swallows (`void err`) turns its row red.
 */
describe('every RPC path surfaces a database refusal', () => {
  const refuse = (code, message) =>
    vi
      .mocked(supabase.rpc)
      .mockResolvedValue(/** @type {any} */ ({ data: null, error: { code, message } }));
  const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const PATHS = [
    {
      path: 'keep as prefer',
      code: '42501',
      message: 'Access denied: planted refusal on keep as prefer',
      success: /^Kept as prefer$/,
      rpc: 'admin_decide_must_preference',
      drive: async () => {
        await screen.findByTestId('admin-preferences-view');
        fireEvent.click(screen.getByRole('button', { name: /^Keep as prefer: / }));
      },
      stillThere: () =>
        expect(screen.getByRole('button', { name: /^Keep as prefer: / })).toBeInTheDocument(),
    },
    {
      path: 'accept',
      code: '22023',
      message: 'practice preference r1 is not a pending must: planted refusal on accept',
      success: /^Accepted as a must$/,
      rpc: 'admin_decide_must_preference',
      drive: async () => {
        await screen.findByTestId('admin-preferences-view');
        fireEvent.click(screen.getByRole('button', { name: /^Accept as must: / }));
        const dialog = await screen.findByRole('dialog', { name: 'Accept as must' });
        fireEvent.click(within(dialog).getByRole('button', { name: 'Accept as must' }));
      },
      stillThere: () =>
        expect(screen.getByRole('dialog', { name: 'Accept as must' })).toBeInTheDocument(),
    },
    {
      path: 'accept all',
      code: '42501',
      message: 'Access denied: planted refusal on admin_accept_all_musts',
      success: /rules? (is a must|are musts) now$/,
      rpc: 'admin_accept_all_musts',
      drive: async () => {
        await screen.findByTestId('admin-preferences-view');
        fireEvent.click(screen.getByRole('button', { name: /^Accept all 1/ }));
        const dialog = await screen.findByRole('dialog', { name: 'Accept all pending musts' });
        fireEvent.click(within(dialog).getByRole('button', { name: /^Make 1 rule a must$/ }));
      },
      stillThere: () =>
        expect(
          screen.getByRole('dialog', { name: 'Accept all pending musts' })
        ).toBeInTheDocument(),
    },
    {
      path: 'remove',
      code: '22023',
      message: 'practice preference r2 is removed, not in force: planted refusal on remove',
      success: /^Rule removed$/,
      rpc: 'admin_remove_practice_preference',
      drive: async () => {
        await rulesTab();
        fireEvent.click(screen.getByRole('button', { name: /^Remove .*Riverside Park$/ }));
        const dialog = await screen.findByRole('dialog', { name: 'Remove this rule' });
        fireEvent.click(within(dialog).getByRole('button', { name: 'Remove rule' }));
      },
      stillThere: () =>
        expect(screen.getByRole('dialog', { name: 'Remove this rule' })).toBeInTheDocument(),
    },
    {
      path: 'add',
      code: '42501',
      message: 'Access denied: planted refusal on admin_add_practice_preference',
      success: /^Rule added$/,
      rpc: 'admin_add_practice_preference',
      drive: async () => {
        await rulesTab();
        fireEvent.click(screen.getByRole('button', { name: 'Add a rule…' }));
        const dialog = await screen.findByRole('dialog', { name: 'Add a rule' });
        fireEvent.change(within(dialog).getByLabelText('Coach'), { target: { value: C1 } });
        fireEvent.click(within(dialog).getByLabelText('Friday'));
        fireEvent.click(within(dialog).getByRole('button', { name: 'Add rule' }));
      },
      stillThere: () =>
        expect(screen.getByRole('dialog', { name: 'Add a rule' })).toBeInTheDocument(),
    },
    {
      path: 'edit',
      code: '22023',
      message: 'practice preference r2 is replaced, not in force: planted refusal on edit',
      success: /^Rule saved$/,
      rpc: 'admin_edit_practice_preference',
      drive: async () => {
        await rulesTab();
        fireEvent.click(screen.getByRole('button', { name: /^Edit .*Riverside Park$/ }));
        const dialog = await screen.findByRole('dialog', { name: 'Edit a rule' });
        fireEvent.click(within(dialog).getByLabelText('Friday'));
        fireEvent.click(within(dialog).getByRole('button', { name: 'Save rule' }));
      },
      stillThere: () =>
        expect(screen.getByRole('dialog', { name: 'Edit a rule' })).toBeInTheDocument(),
    },
  ];

  it('the table names every RPC the hook calls and all six user paths', async () => {
    // Enumerated from the hook's source, not from this table: a new callRpc site with no row here
    // fails this test.
    const fs = await import('node:fs');
    const source = fs.readFileSync(
      `${process.cwd()}/frontend/src/hooks/useCoachPracticePreferences.js`,
      'utf8'
    );
    const called = new Set([...source.matchAll(/callRpc\('([a-z_]+)'/g)].map((m) => m[1]));
    expect(called.size).toBe(5);
    expect(new Set(PATHS.map((entry) => entry.rpc))).toEqual(called);
    // Five sites, six paths: accepting and keeping a must are one RPC with two decisions.
    expect([...source.matchAll(/callRpc\('/g)]).toHaveLength(PATHS.length - 1);
  });

  it.each(PATHS.map((entry) => [entry.path, entry]))(
    '%s: the refusal message is shown and no success is claimed',
    async (_name, entry) => {
      refuse(entry.code, entry.message);
      asRole('admin');
      renderPage();
      await entry.drive();
      expect(
        (await screen.findAllByText(new RegExp(escapeRe(entry.message)))).length
      ).toBeGreaterThan(0);
      expect(supabase.rpc).toHaveBeenCalledWith(entry.rpc, expect.any(Object));
      expect(screen.queryByText(entry.success)).not.toBeInTheDocument();
      entry.stillThere();
    }
  );
});

describe('every load and compute failure is visible', () => {
  const acceptDialog = async () => {
    await screen.findByTestId('admin-preferences-view');
    fireEvent.click(screen.getByRole('button', { name: /^Accept as must: / }));
    return screen.findByRole('dialog', { name: 'Accept as must' });
  };

  it('a failed roster read says the re-judge could not run', async () => {
    tableErrors.team_coach_assignments = {
      code: '42501',
      message: 'permission denied for table team_coach_assignments',
    };
    asRole('admin');
    renderPage();
    const dialog = await acceptDialog();
    expect(within(dialog).getByRole('alert')).toHaveTextContent(
      'Could not re-judge this decision: permission denied for table team_coach_assignments'
    );
    expect(within(dialog).queryByTestId('preview-none')).not.toBeInTheDocument();
  });

  it('a failed coaches read is a banner, not an empty coach table', async () => {
    tableErrors.coaches = { code: '42501', message: 'permission denied for table coaches' };
    asRole('admin');
    renderPage();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not load coaches or locations: permission denied for table coaches'
    );
  });

  it('with the coaches unread, the pending musts and the rules are not listed as none, and nothing is counted', async () => {
    // A rule is the season's through its coach, so a list built without the coaches is empty: that is
    // not "no pending musts" or "no rules in force".
    tableErrors.coaches = { code: '42501', message: 'permission denied for table coaches' };
    asRole('admin');
    renderPage();
    await screen.findByTestId('admin-preferences-view');
    fireEvent.click(await screen.findByRole('tab', { name: /^Pending musts/ }));
    expect(await screen.findByTestId('pending-not-read')).toHaveTextContent(
      'could not be listed: the season’s coaches did not load'
    );
    expect(screen.queryByText('No pending musts.')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /^Pending musts \(/ })).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /^Pending musts/ })).not.toHaveTextContent(/\d/);
    fireEvent.click(screen.getByRole('tab', { name: 'Rules' }));
    expect(await screen.findByTestId('rules-not-read')).toHaveTextContent(
      'could not be listed: the season’s coaches did not load'
    );
    expect(screen.queryByText('No rules in force.')).not.toBeInTheDocument();
    expect(screen.queryByTestId('rules-count')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add a rule…' })).not.toBeInTheDocument();
  });

  it('with the roster unread, the Add dialog does not say a coach coaches no team, and the page says what did not load', async () => {
    // The teams a coach coaches come from the roster; an empty roster read is not "no team today".
    tableErrors.team_coach_assignments = {
      code: '42501',
      message: 'permission denied for table team_coach_assignments',
    };
    asRole('admin');
    renderPage();
    await screen.findByTestId('admin-preferences-view');
    expect(await screen.findByTestId('preview-data-error')).toHaveTextContent(
      'permission denied for table team_coach_assignments'
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Rules' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Add a rule…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a rule' });
    fireEvent.change(within(dialog).getByLabelText('Coach'), { target: { value: C1 } });
    expect(within(dialog).getByTestId('add-teams-unread')).toHaveTextContent(
      'The roster did not load, so the teams of this coach cannot be listed'
    );
    expect(within(dialog).queryByText(/coaches no team today/)).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Add rule' })).toBeDisabled();
  });

  it('a failed locations read leaves the lists as they are and still says so', async () => {
    tableErrors.locations = { code: '42501', message: 'permission denied for table locations' };
    asRole('admin');
    renderPage();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'permission denied for table locations'
    );
    expect(screen.queryByTestId('pending-not-read')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Pending musts (1)' })).toBeInTheDocument();
  });

  it('a rule core cannot read says so instead of "None"', async () => {
    // Another rule in force for the team that core refuses to parse: the re-judge throws.
    tables.coach_practice_preferences.push(
      ruleRow({ id: 'bad-1', start_minutes: [99999], created_at: '2026-09-01T10:00:00Z' })
    );
    asRole('admin');
    renderPage();
    const dialog = await acceptDialog();
    const alert = within(dialog).getByRole('alert');
    expect(alert).toHaveTextContent('Could not re-judge this decision');
    expect(within(dialog).queryByTestId('preview-none')).not.toBeInTheDocument();
  });

  it('the pending rule itself unreadable says so in the dialog', async () => {
    tables.coach_practice_preferences[0].weekdays = ['Funday'];
    asRole('admin');
    renderPage();
    const dialog = await acceptDialog();
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Could not re-judge this decision');
    expect(within(dialog).queryByTestId('preview-none')).not.toBeInTheDocument();
  });

  it('a failed read of the import files is a banner and the group is named by its date', async () => {
    tableErrors.import_jobs = { code: '42501', message: 'permission denied for table import_jobs' };
    asRole('admin');
    renderPage();
    await screen.findByTestId('admin-preferences-view');
    expect(await screen.findByText(/Could not read the import files/)).toHaveTextContent(
      'permission denied for table import_jobs'
    );
    expect(
      screen.getByRole('heading', { name: /From a preference file, imported 2026-09-20 \(1\)/ })
    ).toBeInTheDocument();
  });
});
