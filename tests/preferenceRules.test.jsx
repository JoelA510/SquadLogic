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

  it('draws at most 200 rules and says how many more match', async () => {
    tables.coach_practice_preferences = Array.from({ length: 205 }, (_, index) =>
      ruleRow({
        id: `many-${index}`,
        weekdays: ['MON'],
        created_at: `2026-09-01T00:00:${String(index % 60).padStart(2, '0')}Z`,
      })
    );
    await openRules();
    expect(bodyRows()).toHaveLength(200);
    expect(screen.getByTestId('rules-count')).toHaveTextContent(
      'Showing the first 200 of 205 rules in force; narrow the filters to see the rest.'
    );
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
