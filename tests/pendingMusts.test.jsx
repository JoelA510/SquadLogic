/**
 * Pending musts and Accept all (Phase D C2), through the real page over a fake Supabase client.
 *
 * The confirmation names the count of rules it makes musts and lists the conflicts first; it sends
 * the count the admin saw, and when the database refuses because that count is stale the refusal is
 * put on screen in words, the list is read again and the button names the new count.
 *
 * Plants (each shown red once, then reverted):
 *  (a) send the file's current count at click time instead of the one shown -> the stale-count test
 *      cannot refuse and goes red (the RPC call differs);
 *  (b) list the series before the conflicts -> the order test goes red;
 *  (c) swallow the refusal in the dialog's catch -> the refusal test goes red.
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
import { groupPendingMusts } from '../frontend/src/utils/pendingMustGroups.js';
import { ORG, SEASON, T1, T2, freshTables, makeFrom, ruleRow } from './helpers/preferenceTables.js';

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

const pending = (over) => ruleRow({ requested_level: 'must', must_decision: 'pending', ...over });

function asAdmin(seasonStatus = 'active') {
  vi.mocked(useOrganization).mockReturnValue(
    /** @type {any} */ ({
      currentOrganization: { id: ORG },
      currentSeasonSetting: { id: SEASON, status: seasonStatus },
      orgMember: { role: 'admin' },
    })
  );
  vi.mocked(useAuth).mockReturnValue(/** @type {any} */ ({ user: { id: 'user-admin' } }));
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
  asAdmin();
});

/** Hawks: two pending musts that disagree on the day; Owls: a pending must against an accepted one. */
function conflictingFile() {
  tables.coach_practice_preferences.push(
    pending({
      id: 'r4',
      weekdays: ['THU'],
      coach_priority: 'high',
      created_at: '2026-09-20T09:00:00Z',
    }),
    pending({ id: 'r5', team_id: T2, weekdays: ['TUE'], created_at: '2026-09-20T11:00:00Z' }),
    ruleRow({
      id: 'r6',
      team_id: T2,
      level: 'must',
      requested_level: 'must',
      must_decision: 'accepted',
      weekdays: ['MON'],
      import_job_id: null,
      source: 'admin',
      created_at: '2026-09-01T10:00:00Z',
    })
  );
}

// The group is named by its file once the job is read; wait for that so the dialog's words are settled.
const openAcceptAll = async (name = /^Accept all \d+ pending musts? From “spring-prefs\.csv”/) => {
  await screen.findByTestId('admin-preferences-view');
  fireEvent.click(await screen.findByRole('button', { name }));
  return screen.findByRole('dialog', { name: 'Accept all pending musts' });
};

describe('the pending musts are grouped by the file they came from', () => {
  it('names each file and its day, newest file first, and offers Accept all with its count', async () => {
    tables.import_jobs.push({
      id: 'job-2',
      organization_id: ORG,
      storage_path: 'imports/user-admin/summer-prefs.csv',
      created_at: '2026-09-25T10:00:00Z',
    });
    tables.coach_practice_preferences.push(
      pending({
        id: 'r7',
        team_id: T2,
        weekdays: ['FRI'],
        import_job_id: 'job-2',
        created_at: '2026-09-25T10:00:00Z',
      }),
      pending({
        id: 'r8',
        team_id: T1,
        weekdays: ['TUE'],
        import_job_id: 'job-2',
        created_at: '2026-09-25T10:00:00Z',
      })
    );
    renderPage();
    await screen.findByTestId('admin-preferences-view');
    // The files are named once their jobs are read; the groups are drawn by date until then.
    await screen.findByRole('heading', { name: /summer-prefs\.csv/ });
    const headings = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(headings).toEqual([
      'From “summer-prefs.csv”, imported 2026-09-25 (2)',
      'From “spring-prefs.csv”, imported 2026-09-20 (1)',
    ]);
    expect(
      screen.getByRole('button', { name: /^Accept all 2 pending musts From “summer-prefs.csv”/ })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /^Accept all 1 pending must From “spring-prefs.csv”/ })
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Pending musts (3)' })).toBeInTheDocument();
  });

  it('sorts within a file by the coach’s priority (High first, none last), then oldest first', () => {
    const coachName = (id) => id;
    const rows = [
      pending({ id: 'none-old', coach_priority: null, created_at: '2026-09-01T00:00:00Z' }),
      pending({ id: 'low', coach_priority: 'low', created_at: '2026-09-02T00:00:00Z' }),
      pending({ id: 'high-new', coach_priority: 'high', created_at: '2026-09-05T00:00:00Z' }),
      pending({ id: 'high-old', coach_priority: 'high', created_at: '2026-09-03T00:00:00Z' }),
      pending({ id: 'medium', coach_priority: 'medium', created_at: '2026-09-04T00:00:00Z' }),
    ];
    const [group] = groupPendingMusts(rows, new Map(), coachName);
    expect(group.rows.map((row) => row.id)).toEqual([
      'high-old',
      'high-new',
      'medium',
      'low',
      'none-old',
    ]);
  });

  it('a must with no file is its own group with no Accept all, and the per-rule actions stay', async () => {
    tables.coach_practice_preferences.push(
      pending({ id: 'r9', weekdays: ['FRI'], import_job_id: null })
    );
    renderPage();
    await screen.findByTestId('admin-preferences-view');
    expect(
      await screen.findByRole('heading', { name: 'Musts with no import file (1)' })
    ).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /^Accept all / })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: /^Accept as must: / })).toHaveLength(2);
  });

  it('shows the coach’s priority beside the rule and says the scheduler does not weigh it', async () => {
    tables.coach_practice_preferences[0].coach_priority = 'high';
    renderPage();
    await screen.findByTestId('admin-preferences-view');
    const row = screen.getAllByRole('row').find((tr) => within(tr).queryByText('U10 Hawks'));
    expect(within(row).getByText('High')).toBeInTheDocument();
    expect(
      screen.getByText(/does not\s+change how the scheduler weighs a rule/)
    ).toBeInTheDocument();
  });
});

describe('Accept all asks first', () => {
  it('names the count, the file and the teams, and sends exactly that count and file', async () => {
    conflictingFile();
    renderPage();
    const dialog = await openAcceptAll();
    expect(within(dialog).getByTestId('accept-all-count')).toHaveTextContent(
      'This makes 3 rules musts: every pending must from “spring-prefs.csv”, imported 2026-09-20, for 2 teams.'
    );
    // Nothing has been sent yet.
    expect(supabase.rpc).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Make 3 rules musts' }));
    await waitFor(() =>
      expect(supabase.rpc).toHaveBeenCalledWith('admin_accept_all_musts', {
        p_import_job_id: 'job-1',
        p_expected_count: 3,
      })
    );
    expect(await screen.findByText('3 rules are musts now')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('lists the conflicts first: among the file’s own musts and against musts already in force', async () => {
    conflictingFile();
    renderPage();
    const dialog = await openAcceptAll();
    const conflicts = within(dialog).getByTestId('accept-all-conflicts');
    expect(within(conflicts).getByRole('heading', { name: 'Conflicts (2)' })).toBeInTheDocument();
    const items = within(conflicts).getAllByTestId('accept-all-conflict');
    expect(items).toHaveLength(2);
    // Hawks: Wednesday against Thursday, both from this file.
    const hawks = items.find((item) => item.textContent.includes('U10 Hawks'));
    expect(hawks).toHaveTextContent('Wednesday (would become a must)');
    expect(hawks).toHaveTextContent('Thursday (would become a must)');
    // Owls: Tuesday from this file against the Monday must already in force (no "would become").
    const owls = items.find((item) => item.textContent.includes('U12 Owls'));
    expect(owls).toHaveTextContent('Tuesday (would become a must)');
    expect(owls).toHaveTextContent('Monday');
    expect(owls.textContent.match(/would become a must/g)).toHaveLength(1);
    expect(
      within(conflicts).getByText(/each team below is listed as TIME TBD/)
    ).toBeInTheDocument();
    // The conflicts come before the practice series in the document.
    const series = within(dialog).getByRole('heading', {
      name: /^Current practice series that would stop/,
    });
    expect(
      conflicts.compareDocumentPosition(series) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it('lists the current practice series the musts would break, judged together', async () => {
    conflictingFile();
    renderPage();
    const dialog = await openAcceptAll();
    const series = within(dialog)
      .getAllByTestId('accept-all-series')
      .map((li) => li.textContent);
    // Hawks practise Monday: breaks Wednesday and Thursday. Owls practise Wednesday: breaks Tuesday,
    // and Monday (already unsatisfiable before this decision).
    expect(series).toEqual([
      'U10 Hawks: Monday 18:00 at Riverside Park',
      'U12 Owls: Wednesday 18:00 at Riverside Park (already unsatisfiable before this decision)',
    ]);
  });

  it('says there are no conflicts when there are none, and lists none as "None"', async () => {
    renderPage();
    const dialog = await openAcceptAll();
    expect(within(dialog).getByRole('heading', { name: 'Conflicts (0)' })).toBeInTheDocument();
    expect(
      within(dialog).getByText(/No conflicts: these musts can be met together/)
    ).toBeInTheDocument();
    expect(within(dialog).getAllByTestId('accept-all-series')).toHaveLength(1);
  });

  it('a stale count is refused in words, nothing is claimed, the list is refreshed and the button names the new count', async () => {
    conflictingFile();
    renderPage();
    const dialog = await openAcceptAll();
    expect(within(dialog).getByRole('button', { name: 'Make 3 rules musts' })).toBeEnabled();
    // Meanwhile, elsewhere, one of the file's musts was decided: the file now has two pending.
    tables.coach_practice_preferences = tables.coach_practice_preferences.filter(
      (row) => row.id !== 'r5'
    );
    vi.mocked(supabase.rpc).mockResolvedValue(
      /** @type {any} */ ({
        data: null,
        error: {
          code: '22023',
          details: 'expected_count_mismatch',
          message:
            'import job job-1 has 2 pending must(s), not the 3 the confirmation showed; nothing was accepted',
        },
      })
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Make 3 rules musts' }));
    const refusal = await within(dialog).findByTestId('accept-all-refusal');
    expect(refusal).toHaveTextContent('Nothing was accepted');
    expect(refusal).toHaveTextContent('changed after you opened this');
    expect(refusal).toHaveTextContent(
      'import job job-1 has 2 pending must(s), not the 3 the confirmation showed'
    );
    expect(screen.queryByText(/rules are musts now/)).not.toBeInTheDocument();
    // The dialog stays, refreshed: it now offers the count the database holds.
    expect(await within(dialog).findByRole('button', { name: 'Make 2 rules musts' })).toBeEnabled();
    expect(within(dialog).getByTestId('accept-all-count')).toHaveTextContent(
      'This makes 2 rules musts'
    );
    // The first call carried the old count; nothing carried a second.
    expect(vi.mocked(supabase.rpc).mock.calls).toEqual([
      ['admin_accept_all_musts', { p_import_job_id: 'job-1', p_expected_count: 3 }],
    ]);
  });

  it('when the refusal leaves nothing pending the dialog says so and cannot confirm', async () => {
    renderPage();
    const dialog = await openAcceptAll();
    tables.coach_practice_preferences = tables.coach_practice_preferences.filter(
      (row) => row.id !== 'r1'
    );
    vi.mocked(supabase.rpc).mockResolvedValue(
      /** @type {any} */ ({
        data: null,
        error: {
          code: '22023',
          details: 'expected_count_mismatch',
          message:
            'import job job-1 has 0 pending must(s), not the 1 the confirmation showed; nothing was accepted',
        },
      })
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Make 1 rule a must' }));
    expect(await within(dialog).findByText(/nothing to accept/)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Make 0 rules musts' })).toBeDisabled();
  });

  it('any other refusal is shown with the database’s own message and the list is left alone', async () => {
    renderPage();
    const dialog = await openAcceptAll();
    vi.mocked(supabase.rpc).mockResolvedValue(
      /** @type {any} */ ({
        data: null,
        error: {
          code: '22023',
          details: 'season_completed',
          message: 'The season of import job job-1 is completed and takes no change',
        },
      })
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Make 1 rule a must' }));
    const refusal = await within(dialog).findByTestId('accept-all-refusal');
    expect(refusal).toHaveTextContent(
      'Nothing was accepted. The season of import job job-1 is completed'
    );
    expect(screen.queryByText(/is a must now|are musts now/)).not.toBeInTheDocument();
  });

  it('cannot say what it would do when the roster did not load, and says so instead of "no conflicts"', async () => {
    tableErrors.practice_assignments = {
      code: '42501',
      message: 'permission denied for table practice_assignments',
    };
    renderPage();
    const dialog = await openAcceptAll();
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Could not check these musts');
    expect(within(dialog).getByRole('alert')).toHaveTextContent(
      'permission denied for table practice_assignments'
    );
    expect(within(dialog).queryByText(/No conflicts/)).not.toBeInTheDocument();
  });

  it('a rule core cannot read is named, and the rest are still checked', async () => {
    conflictingFile();
    tables.coach_practice_preferences.push(pending({ id: 'bad', weekdays: ['Funday'] }));
    renderPage();
    const dialog = await openAcceptAll();
    expect(
      within(dialog).getByText(/1 rule\(s\) could not be read and are not part of this check/)
    ).toBeInTheDocument();
    expect(within(dialog).getAllByTestId('accept-all-conflict')).toHaveLength(2);
  });
});

describe('the keyboard', () => {
  it('Accept all is a real button; the dialog takes focus, wraps Tab at both ends, and Escape returns focus to it', async () => {
    renderPage();
    await screen.findByTestId('admin-preferences-view');
    const opener = await screen.findByRole('button', { name: /^Accept all 1/ });
    expect(opener.tagName).toBe('BUTTON');
    expect(opener).not.toHaveAttribute('tabindex', '-1');
    opener.focus();
    fireEvent.click(opener);
    const dialog = await screen.findByRole('dialog', { name: 'Accept all pending musts' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog.contains(document.activeElement)).toBe(true);

    const confirm = within(dialog).getByRole('button', { name: 'Make 1 rule a must' });
    confirm.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(
      within(dialog).getByRole('button', { name: 'Close dialog' })
    );
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(confirm);

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(document.activeElement).toBe(opener);
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it('the tabs move with the arrow keys and the panel is labelled by the tab chosen', async () => {
    renderPage();
    await screen.findByTestId('admin-preferences-view');
    const first = screen.getByRole('tab', { name: /^Pending musts/ });
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowRight' });
    const rules = await screen.findByRole('tab', { name: 'Rules' });
    expect(rules).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveAccessibleName('Rules');
    fireEvent.keyDown(rules, { key: 'End' });
    expect(screen.getByRole('tab', { name: 'Import a file' })).toHaveAttribute(
      'aria-selected',
      'true'
    );
  });

  it('every control of the pending list names its rule, so a screen reader can tell the rows apart', async () => {
    conflictingFile();
    renderPage();
    await screen.findByTestId('admin-preferences-view');
    const names = screen
      .getAllByRole('button', { name: /^(Accept as must|Keep as prefer): / })
      .map((b) => b.getAttribute('aria-label'));
    expect(new Set(names).size).toBe(names.length);
    for (const button of screen.getAllByRole('button')) {
      expect(
        button.textContent?.trim() || button.getAttribute('aria-label'),
        'a button with no name'
      ).toBeTruthy();
    }
    for (const table of screen.getAllByRole('table')) {
      expect(within(table).getAllByRole('columnheader').length).toBeGreaterThan(0);
      expect(table.querySelector('caption')).not.toBeNull();
    }
  });
});

describe('a completed season is read-only', () => {
  it('turns Accept all, Accept as must and Keep as prefer off and says why', async () => {
    asAdmin('completed');
    renderPage();
    await screen.findByTestId('admin-preferences-view');
    expect(screen.getByTestId('season-readonly-note')).toHaveTextContent(
      'This season is completed and read-only'
    );
    expect(screen.getByRole('button', { name: /^Accept all 1/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^Accept as must: / })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^Keep as prefer: / })).toBeDisabled();
  });

  it('the control: the same page on an active season has them on, and no note', async () => {
    renderPage();
    await screen.findByTestId('admin-preferences-view');
    expect(screen.queryByTestId('season-readonly-note')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Accept all 1/ })).toBeEnabled();
    expect(screen.getByRole('button', { name: /^Accept as must: / })).toBeEnabled();
  });
});
