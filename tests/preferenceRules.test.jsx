/**
 * The rules list (Phase D C2): every rule in force, by team and coach, with filters for the team, the
 * coach, the level and the coach's priority; the priority is shown and never weighed.
 *
 * Plants: (a) a filter that ignores its choice (the team filter matches every row) -> the team and
 * combined-filter tests go red; (b) the list sorts by priority first -> the order test goes red.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import CoachPreferencesPage from '../frontend/src/pages/CoachPreferencesPage.jsx';
import RulesList from '../frontend/src/components/preferences/RulesList.jsx';
import ToastHost from '../frontend/src/components/ui/ToastHost.jsx';
import { supabase } from '../frontend/src/lib/supabaseClient.js';
import { useOrganization } from '../frontend/src/contexts/OrganizationContext.jsx';
import { useAuth } from '../frontend/src/contexts/AuthContext.jsx';
import {
  C3,
  L1,
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

beforeEach(() => {
  tables = freshTables();
  vi.mocked(supabase.from).mockImplementation(
    /** @type {any} */ ((table) => makeFrom(tables, {})(table))
  );
  vi.mocked(supabase.rpc).mockReset();
  vi.mocked(supabase.rpc).mockResolvedValue(/** @type {any} */ ({ data: {}, error: null }));
  vi.mocked(useOrganization).mockReturnValue(
    /** @type {any} */ ({
      currentOrganization: { id: ORG },
      currentSeasonSetting: { id: SEASON, status: 'active' },
      orgMember: { role: 'admin' },
    })
  );
  vi.mocked(useAuth).mockReturnValue(/** @type {any} */ ({ user: { id: 'user-admin' } }));
  // Robin coaches Owls too, so a coach filter has two coaches to choose between.
  tables.team_coach_assignments.push({
    id: 'tca-robin',
    organization_id: ORG,
    team_id: T2,
    coach_id: C3,
    role: 'lead',
    effective_from: '2026-01-01',
    effective_to: null,
  });
  tables.coach_practice_preferences = [
    // Hawks / Casey: a must accepted, High.
    ruleRow({
      id: 'a',
      level: 'must',
      requested_level: 'must',
      must_decision: 'accepted',
      weekdays: ['TUE', 'THU'],
      coach_priority: 'high',
      created_at: '2026-09-02T00:00:00Z',
    }),
    // Hawks / Casey: a prefer, no priority.
    ruleRow({ id: 'b', start_minutes: [1020, 1080], created_at: '2026-09-03T00:00:00Z' }),
    // Owls / Casey: a pending must, Low.
    ruleRow({
      id: 'c',
      team_id: T2,
      requested_level: 'must',
      must_decision: 'pending',
      weekdays: ['WED'],
      coach_priority: 'low',
      created_at: '2026-09-04T00:00:00Z',
    }),
    // Owls / Robin: a prefer, Medium, with a window.
    ruleRow({
      id: 'd',
      team_id: T2,
      coach_id: C3,
      venue_ids: [L1],
      coach_priority: 'medium',
      effective_from: '2026-09-01',
      effective_to: '2026-10-15',
      source: 'admin',
      import_job_id: null,
      created_at: '2026-09-05T00:00:00Z',
    }),
    // Not in force: not listed.
    ruleRow({ id: 'gone', status: 'removed', weekdays: ['SAT'] }),
  ];
});

const openRules = async () => {
  render(
    <MemoryRouter>
      <ToastHost>
        <CoachPreferencesPage />
      </ToastHost>
    </MemoryRouter>
  );
  await screen.findByTestId('admin-preferences-view');
  fireEvent.click(screen.getByRole('tab', { name: 'Rules' }));
  await screen.findByRole('heading', { name: /^Rules in force/ });
};
const bodyRows = () => within(screen.getByRole('table')).getAllByRole('row').slice(1);
const shownIds = () =>
  bodyRows().map((row) =>
    within(row)
      .getAllByRole('button', { name: /^Edit / })[0]
      .getAttribute('aria-label')
  );
const choose = (label, value) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe('the rules list', () => {
  it('lists every rule in force, by team then coach, and none that is not in force', async () => {
    await openRules();
    expect(screen.getByRole('heading', { name: 'Rules in force (4)' })).toBeInTheDocument();
    const rows = bodyRows();
    expect(rows).toHaveLength(4);
    // U10 Hawks first, then U12 Owls; within a team by coach name, then the coach's priority.
    expect(rows.map((row) => within(row).getAllByRole('cell')[1].textContent)).toEqual([
      'U10 Hawks',
      'U10 Hawks',
      'U12 Owls',
      'U12 Owls',
    ]);
    expect(rows.map((row) => within(row).getAllByRole('cell')[0].textContent)).toEqual([
      'Casey Coach',
      'Casey Coach',
      'Casey Coach',
      'Robin Unassigned',
    ]);
    expect(screen.getByTestId('rules-count')).toHaveTextContent('Showing 4 of 4 rules in force.');
    expect(screen.queryByText('Saturday')).not.toBeInTheDocument();
  });

  it('shows the priority, the level with its decision, the source and the window of each rule', async () => {
    await openRules();
    const [hawksMust, hawksPrefer, owlsPending, robin] = bodyRows();
    expect(within(hawksMust).getByText('Must')).toBeInTheDocument();
    expect(within(hawksMust).getByText('Accepted as must')).toBeInTheDocument();
    expect(within(hawksMust).getByText('Tuesday or Thursday')).toBeInTheDocument();
    expect(within(hawksMust).getAllByRole('cell')[4]).toHaveTextContent('High');
    expect(within(hawksPrefer).getAllByRole('cell')[3]).toHaveTextContent('17:00 or 18:00');
    // No priority is a dash named "No priority", not a blank.
    expect(within(hawksPrefer).getByLabelText('No priority')).toBeInTheDocument();
    expect(within(owlsPending).getByText('Pending must')).toBeInTheDocument();
    expect(within(owlsPending).getAllByRole('cell')[4]).toHaveTextContent('Low');
    expect(within(robin).getAllByRole('cell')[3]).toHaveTextContent('Riverside Park');
    expect(within(robin).getAllByRole('cell')[3]).toHaveTextContent(
      'In force from 2026-09-01 until 2026-10-15'
    );
    expect(within(robin).queryByText('Imported')).not.toBeInTheDocument();
    expect(within(hawksMust).getByText('Imported')).toBeInTheDocument();
  });

  it('says the priority is for reading and is not weighed', async () => {
    await openRules();
    expect(screen.getByText(/the scheduler does not weigh it/)).toBeInTheDocument();
  });

  it('filters by team', async () => {
    await openRules();
    choose('Team', T2);
    expect(bodyRows()).toHaveLength(2);
    expect(
      bodyRows().every((row) => within(row).getAllByRole('cell')[1].textContent === 'U12 Owls')
    ).toBe(true);
    expect(screen.getByTestId('rules-count')).toHaveTextContent(
      'Showing 2 of 2 rules matching the filters (4 in force).'
    );
  });

  it('filters by coach, and the coach list holds only coaches who have a rule', async () => {
    await openRules();
    const options = within(screen.getByLabelText('Coach'))
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(options).toEqual(['All coaches', 'Casey Coach', 'Robin Unassigned']);
    choose('Coach', C3);
    expect(bodyRows()).toHaveLength(1);
    expect(bodyRows()[0]).toHaveTextContent('Robin Unassigned');
  });

  it('filters by level: Must, Prefer (a pending must is not a prefer here) and Pending must', async () => {
    await openRules();
    choose('Level', 'must');
    expect(bodyRows()).toHaveLength(1);
    expect(bodyRows()[0]).toHaveTextContent('Accepted as must');
    choose('Level', 'prefer');
    expect(bodyRows()).toHaveLength(2);
    expect(screen.queryByText('Pending must', { selector: '.badge' })).not.toBeInTheDocument();
    choose('Level', 'pending');
    expect(bodyRows()).toHaveLength(1);
    expect(bodyRows()[0]).toHaveTextContent('U12 Owls');
  });

  it('filters by the coach’s priority, including "No priority"', async () => {
    await openRules();
    choose("Coach's priority", 'high');
    expect(bodyRows()).toHaveLength(1);
    choose("Coach's priority", 'none');
    expect(bodyRows()).toHaveLength(1);
    expect(bodyRows()[0]).toHaveTextContent('17:00 or 18:00');
    choose("Coach's priority", 'medium');
    expect(bodyRows()[0]).toHaveTextContent('Robin Unassigned');
  });

  it('combines filters, says when nothing matches, and Clear filters shows everything again', async () => {
    await openRules();
    choose('Team', T1);
    choose('Level', 'pending');
    expect(screen.getByText('No rules match these filters.')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.getByTestId('rules-count')).toHaveTextContent(
      'Showing 0 of 0 rules matching the filters (4 in force).'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(bodyRows()).toHaveLength(4);
    expect(screen.getByRole('button', { name: 'Clear filters' })).toBeDisabled();
  });

  it('says so when there are no rules in force at all', async () => {
    tables.coach_practice_preferences = [];
    await openRules();
    expect(screen.getByRole('heading', { name: 'Rules in force (0)' })).toBeInTheDocument();
    expect(screen.getByTestId('rules-count')).toHaveTextContent('No rules in force.');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('every row’s Edit and Remove name the coach, the team and the rule', async () => {
    await openRules();
    const labels = screen
      .getAllByRole('button', { name: /^(Edit|Remove) / })
      .map((b) => b.getAttribute('aria-label'));
    expect(labels).toHaveLength(8);
    expect(new Set(labels).size).toBe(8);
    expect(labels).toContain("Edit Casey Coach's rule for U10 Hawks: Tuesday or Thursday");
    expect(labels).toContain("Remove Robin Unassigned's rule for U12 Owls: Riverside Park");
    expect(shownIds()).toHaveLength(4);
  });
});

describe('a rule in force on paper that the scheduler does not judge', () => {
  // The scheduler judges a rule while its coach is one of the team's current coaches and the day is
  // inside its window; a rule failing either is in force and does nothing, and the list says so.
  // Dated explicitly: "today" is the day the scheduler judges on.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-28T12:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  const notes = () => screen.queryAllByTestId('rule-not-applied').map((node) => node.textContent);

  it('says so for a coach who no longer coaches the team and for a window not open today, and for nothing else', async () => {
    tables.team_coach_assignments = tables.team_coach_assignments.map((a) =>
      a.coach_id === C3 ? { ...a, effective_to: '2026-09-01' } : a
    );
    tables.coach_practice_preferences.push(
      ruleRow({
        id: 'future',
        weekdays: ['SUN'],
        effective_from: '2026-10-15',
        created_at: '2026-09-06T00:00:00Z',
      }),
      ruleRow({
        id: 'past',
        weekdays: ['SAT'],
        effective_to: '2026-09-15',
        created_at: '2026-09-07T00:00:00Z',
      })
    );
    await openRules();
    expect(notes()).toEqual([
      'Not applied today: it starts on 2026-10-15.',
      'Not applied today: it ended on 2026-09-15.',
      'Not applied today: the coach does not coach this team today.',
    ]);
  });

  it('says nothing about a rule that applies: its coach coaches the team and today is in its window', async () => {
    await openRules();
    expect(notes()).toEqual([]);
  });

  it('says nothing when the roster did not load, rather than calling every rule not applied', async () => {
    tables.team_coach_assignments = [];
    const real = vi.mocked(supabase.from).getMockImplementation();
    vi.mocked(supabase.from).mockImplementation(
      /** @type {any} */ (
        (table) =>
          table === 'team_coach_assignments'
            ? makeFrom(tables, { team_coach_assignments: { code: '42501', message: 'denied' } })(
                table
              )
            : real(table)
      )
    );
    await openRules();
    expect(notes()).toEqual([]);
    expect(screen.getByRole('table')).toBeInTheDocument();
  });
});

describe('paging the rules list', () => {
  // The list is drawn directly, with a small page size, so the paging (every rule reachable, the
  // button gone after the last page, focus on the first rule a page adds, a filter starting again at
  // page one) is held without drawing hundreds of rows. The real size, 200, has its own boundary test.
  const pad = (n) => String(n).padStart(3, '0');
  /** `count` rules that share team, coach, level and priority: no filter can separate them. */
  const crowd = (count, over = {}) =>
    Array.from({ length: count }, (_, index) =>
      ruleRow({
        id: `many-${pad(index)}`,
        weekdays: ['MON'],
        start_minutes: [1000 + index],
        created_at: `2026-09-01T00:${pad(index).slice(0, 2)}:${pad(index).slice(1)}Z`,
        ...over,
      })
    );
  const listElement = (rows, props, onEdit) => (
    <RulesList
      rows={rows}
      coachName={() => 'Casey Coach'}
      teamName={(id) => (id === T2 ? 'U12 Owls' : 'U10 Hawks')}
      locationNames={new Map()}
      readOnly={false}
      busyId={null}
      rosterRows={null}
      date="2026-09-28"
      onAdd={vi.fn()}
      onEdit={onEdit}
      onRemove={vi.fn()}
      {...props}
    />
  );
  const renderList = (rows, props = {}) => {
    const onEdit = vi.fn();
    const rendered = render(listElement(rows, props, onEdit));
    return {
      onEdit,
      /** The same list over other rules, without drawing it again from nothing. */
      rerender: (next) => rendered.rerender(listElement(next, props, onEdit)),
    };
  };
  // The rows are counted from the DOM: a role query over hundreds of rows costs more than drawing them.
  const rowsDrawn = () => [...document.querySelectorAll('table tbody tr')];
  // The Show more button is found by its text in the DOM: a role-and-name query computes the name of
  // every button on the page, and a crowd has hundreds.
  const showMore = (name) =>
    [...document.querySelectorAll('button')].find((button) => button.textContent === name) ?? null;
  const anyShowMore = () =>
    [...document.querySelectorAll('button')].find((button) =>
      /^Show \d+ more rules?$/.test(button.textContent ?? '')
    ) ?? null;

  it('reaches every one of 23 rules no filter can separate, a page at a time; the last is editable and the button goes with the last page', () => {
    const rows = crowd(23);
    const { onEdit } = renderList(rows, { pageSize: 5 });
    const counts = [];
    /** @type {Array<[number, string]>} */
    const pages = [
      [5, 'Show 5 more rules'],
      [10, 'Show 5 more rules'],
      [15, 'Show 5 more rules'],
      [20, 'Show 3 more rules'],
    ];
    for (const [drawn, label] of pages) {
      expect(rowsDrawn()).toHaveLength(drawn);
      expect(screen.getByTestId('rules-count')).toHaveTextContent(
        `Showing ${drawn} of 23 rules in force; show more, or narrow the filters.`
      );
      fireEvent.click(showMore(label));
      counts.push(rowsDrawn().length);
    }
    expect(counts).toEqual([10, 15, 20, 23]);
    expect(screen.getByTestId('rules-count')).toHaveTextContent('Showing 23 of 23 rules in force.');
    expect(anyShowMore()).not.toBeInTheDocument();
    // Every rule is there once, in order, and the last can be edited.
    const labels = screen
      .getAllByRole('button', { name: /^Edit / })
      .map((button) => button.getAttribute('aria-label'));
    expect(new Set(labels).size).toBe(23);
    // 1000 + 22 minutes past midnight.
    expect(labels[22]).toContain('17:02');
    fireEvent.click(rowsDrawn()[22].querySelector('button'));
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onEdit.mock.calls[0][0].id).toBe('many-022');
  });

  it('moves focus to the first rule each page added, including after the button has left with the last page', () => {
    renderList(crowd(12), { pageSize: 5 });
    const more = showMore('Show 5 more rules');
    more.focus();
    fireEvent.click(more);
    expect(document.activeElement).toBe(rowsDrawn()[5].querySelector('button'));
    fireEvent.click(showMore('Show 2 more rules'));
    expect(anyShowMore()).not.toBeInTheDocument();
    expect(document.activeElement).toBe(rowsDrawn()[10].querySelector('button'));
  });

  it('a change of filter starts again at the first page', () => {
    renderList([...crowd(23), ruleRow({ id: 'other', team_id: T2, weekdays: ['SAT'] })], {
      pageSize: 5,
    });
    fireEvent.click(showMore('Show 5 more rules'));
    expect(rowsDrawn()).toHaveLength(10);
    choose('Team', T2);
    expect(rowsDrawn()).toHaveLength(1);
    expect(anyShowMore()).not.toBeInTheDocument();
    choose('Team', 'all');
    expect(rowsDrawn()).toHaveLength(5);
    expect(showMore('Show 5 more rules')).toBeEnabled();
  });

  it('exactly one page has no button, and one more rule leaves "Show 1 more rule"', () => {
    renderList(crowd(5), { pageSize: 5 });
    expect(rowsDrawn()).toHaveLength(5);
    expect(anyShowMore()).not.toBeInTheDocument();
    expect(screen.getByTestId('rules-count')).toHaveTextContent('Showing 5 of 5 rules in force.');
  });

  it('one rule past a page leaves a singular button that adds it', () => {
    renderList(crowd(6), { pageSize: 5 });
    expect(rowsDrawn()).toHaveLength(5);
    fireEvent.click(showMore('Show 1 more rule'));
    expect(rowsDrawn()).toHaveLength(6);
    expect(anyShowMore()).not.toBeInTheDocument();
  });

  it('at the real page size, exactly 200 rules have no button and 201 leave Show 1 more rule', () => {
    // One draw of 200 rows, then one rule more over the same tree: drawing a crowd from nothing
    // twice is what made the old paging test the slowest in the suite.
    const { rerender } = renderList(crowd(200));
    expect(rowsDrawn()).toHaveLength(200);
    expect(anyShowMore()).not.toBeInTheDocument();
    expect(screen.getByTestId('rules-count')).toHaveTextContent(
      'Showing 200 of 200 rules in force.'
    );
    rerender(crowd(201));
    expect(rowsDrawn()).toHaveLength(200);
    expect(screen.getByTestId('rules-count')).toHaveTextContent(
      'Showing 200 of 201 rules in force; show more, or narrow the filters.'
    );
    fireEvent.click(showMore('Show 1 more rule'));
    expect(rowsDrawn()).toHaveLength(201);
    expect(anyShowMore()).not.toBeInTheDocument();
  });
});
