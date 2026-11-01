/**
 * Must rules that cannot be met together (Phase D C2): the finder (`practiceMustConflicts.js`, core
 * underneath), what Accept all would do jointly, and the Conflicts tab that lists them.
 *
 * Plants: (a) the finder reads prefer conflicts as must conflicts (drops the level test) -> the
 * "prefers that disagree are not conflicts" case goes red; (b) the teams examined are derived from
 * the conflicts found instead of the rules -> the "checked N teams" case goes red.
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
import { acceptAllImpact, findMustConflicts } from '../frontend/src/utils/practiceMustConflicts.js';
import {
  C1,
  C3,
  L1,
  L2,
  ORG,
  SEASON,
  T1,
  T2,
  T3,
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

const DATE = '2026-09-28';
const lead = (team, coach) => ({
  team_id: team,
  coach_id: coach,
  role: 'lead',
  effective_from: '2026-01-01',
  effective_to: null,
});
const assistant = (team, coach) => ({ ...lead(team, coach), role: 'assistant' });
const must = (over) =>
  ruleRow({ level: 'must', requested_level: 'must', must_decision: 'accepted', ...over });

const find = (ruleRows, rosterRows = [lead(T1, C1), assistant(T1, C3)], practiceRows = []) =>
  findMustConflicts({ ruleRows, rosterRows, practiceRows, date: DATE });

describe('findMustConflicts', () => {
  it('two musts for one team with no day in common are a conflict, naming both rules and the dimension', () => {
    const result = find([
      must({ id: 'a', weekdays: ['TUE'] }),
      must({ id: 'b', weekdays: ['THU'] }),
    ]);
    expect(result.conflicts).toEqual([
      expect.objectContaining({
        teamId: T1,
        dimension: 'weekday',
        ruleIds: ['a', 'b'],
        coachIds: [C1],
      }),
    ]);
    expect(result.teamsExamined).toEqual([T1]);
  });

  it('start times and venues conflict the same way, each on its own dimension', () => {
    const result = find([
      must({ id: 'a', start_minutes: [1020] }),
      must({ id: 'b', start_minutes: [1080] }),
      must({ id: 'c', venue_ids: [L1] }),
      must({ id: 'd', venue_ids: [L2] }),
    ]);
    expect(result.conflicts.map((c) => [c.dimension, c.ruleIds])).toEqual([
      ['start_time', ['a', 'b']],
      ['venue', ['c', 'd']],
    ]);
  });

  it('musts that share a value are not a conflict; three that share none between them are, all named', () => {
    expect(
      find([must({ id: 'a', weekdays: ['TUE', 'THU'] }), must({ id: 'b', weekdays: ['THU'] })])
        .conflicts
    ).toEqual([]);
    const three = find([
      must({ id: 'a', weekdays: ['TUE', 'THU'] }),
      must({ id: 'b', weekdays: ['THU', 'FRI'] }),
      must({ id: 'c', weekdays: ['FRI'] }),
    ]);
    expect(three.conflicts).toHaveLength(1);
    expect(three.conflicts[0].ruleIds).toEqual(['a', 'b', 'c']);
  });

  it('prefer rules that disagree are not conflicts: they only cost a breach', () => {
    const result = find([
      ruleRow({ id: 'a', weekdays: ['TUE'] }),
      ruleRow({ id: 'b', weekdays: ['THU'] }),
      // A pending must is in force as prefer until accepted.
      ruleRow({ id: 'c', weekdays: ['MON'], requested_level: 'must', must_decision: 'pending' }),
    ]);
    expect(result.conflicts).toEqual([]);
    expect(result.teamsExamined).toEqual([T1]);
  });

  it('a must and a prefer on the same dimension do not conflict (a conflict is within one level)', () => {
    expect(
      find([must({ id: 'a', weekdays: ['TUE'] }), ruleRow({ id: 'b', weekdays: ['THU'] })])
        .conflicts
    ).toEqual([]);
  });

  it('co-coaches’ musts conflict, and both coaches are named', () => {
    const result = find([
      must({ id: 'a', coach_id: C1, weekdays: ['TUE'] }),
      must({ id: 'b', coach_id: C3, weekdays: ['THU'] }),
    ]);
    expect(result.conflicts[0].coachIds.sort()).toEqual([C1, C3].sort());
  });

  it('a rule of a coach who no longer coaches the team, or outside its window, is not part of a conflict', () => {
    const ended = [{ ...lead(T1, C3), effective_to: '2026-09-01' }, lead(T1, C1)];
    expect(
      find(
        [must({ id: 'a', weekdays: ['TUE'] }), must({ id: 'b', coach_id: C3, weekdays: ['THU'] })],
        ended
      ).conflicts
    ).toEqual([]);
    expect(
      find([
        must({ id: 'a', weekdays: ['TUE'] }),
        must({ id: 'b', weekdays: ['THU'], effective_from: '2026-10-15' }),
      ]).conflicts
    ).toEqual([]);
  });

  it('a conflict is per team: the same disagreement on two teams is two conflicts', () => {
    const result = find(
      [
        must({ id: 'a', weekdays: ['TUE'] }),
        must({ id: 'b', weekdays: ['THU'] }),
        must({ id: 'c', team_id: T2, weekdays: ['TUE'] }),
        must({ id: 'd', team_id: T2, weekdays: ['THU'] }),
      ],
      [lead(T1, C1), lead(T2, C1)]
    );
    expect(result.conflicts.map((c) => c.teamId).sort()).toEqual([T1, T2].sort());
  });

  it('examines every team with a rule in force, found or not, and none that has only history', () => {
    const result = find(
      [
        must({ id: 'a', weekdays: ['TUE'] }),
        must({ id: 'b', team_id: T2, weekdays: ['TUE'] }),
        must({ id: 'c', team_id: T3, weekdays: ['SAT'], status: 'removed' }),
      ],
      [lead(T1, C1), lead(T2, C1), lead(T3, C1)]
    );
    expect(result.teamsExamined).toEqual([T1, T2].sort());
  });

  it('reports a rule core cannot read and still checks the team’s other rules', () => {
    const result = find([
      must({ id: 'a', weekdays: ['TUE'] }),
      must({ id: 'b', weekdays: ['THU'] }),
      must({ id: 'bad', weekdays: ['Funday'] }),
    ]);
    expect(result.unreadable).toEqual([
      expect.objectContaining({ ruleId: 'bad', teamId: T1, message: expect.any(String) }),
    ]);
    expect(result.conflicts).toHaveLength(1);
  });

  it('keep-current with nothing to keep is no conflict (it does nothing yet)', () => {
    expect(
      find([must({ id: 'a', keep_weekday: true }), must({ id: 'b', weekdays: ['THU'] })]).conflicts
    ).toEqual([]);
  });
});

describe('acceptAllImpact', () => {
  const series = (id, team, day, time = '18:00:00') => ({
    id,
    team_id: team,
    effective_date_range: null,
    slot: { day_of_week: day, start_time: time, field: { location_id: L1 } },
  });
  const pendingRow = (over) =>
    ruleRow({ requested_level: 'must', must_decision: 'pending', ...over });
  const impact = (pendingRows, ruleRows, practiceRows = []) =>
    acceptAllImpact({
      pendingRows,
      ruleRows,
      rosterRows: [lead(T1, C1), lead(T2, C1)],
      practiceRows,
      date: DATE,
    });

  it('finds the conflict the acceptance would create between the file’s own musts, which neither shows alone', () => {
    const a = pendingRow({ id: 'a', weekdays: ['TUE'] });
    const b = pendingRow({ id: 'b', weekdays: ['THU'] });
    expect(find([a, b]).conflicts).toEqual([]);
    const result = impact([a, b], [a, b]);
    expect(result.count).toBe(2);
    expect(result.conflicts).toEqual([
      expect.objectContaining({ teamId: T1, ruleIds: ['a', 'b'] }),
    ]);
  });

  it('finds the conflict with a must already in force, and ignores a conflict it has no part in', () => {
    const existing = must({ id: 'm', weekdays: ['MON'] });
    const existingOther = [
      must({ id: 'x', team_id: T2, weekdays: ['MON'] }),
      must({ id: 'y', team_id: T2, weekdays: ['FRI'] }),
    ];
    const a = pendingRow({ id: 'a', weekdays: ['TUE'] });
    const result = impact([a], [existing, a, ...existingOther]);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].ruleIds).toEqual(['m', 'a']);
    // T2’s existing disagreement is the Conflicts tab’s, not this decision’s.
    expect(result.teamIds).toEqual([T1]);
  });

  it('judges the series jointly and says which were already broken by a must in force', () => {
    const existing = must({ id: 'm', team_id: T2, weekdays: ['MON'] });
    const a = pendingRow({ id: 'a', weekdays: ['WED'] });
    const b = pendingRow({ id: 'b', team_id: T2, weekdays: ['FRI'] });
    const result = impact(
      [a, b],
      [existing, a, b],
      [series('s1', T1, 'mon'), series('s2', T2, 'wed')]
    );
    expect(
      result.unsatisfiable.map((u) => [u.assignmentId, u.ruleIds, u.alreadyUnsatisfiable])
    ).toEqual([
      ['s1', ['a'], false],
      ['s2', ['b'], true],
    ]);
  });

  it('no conflict and no broken series when the musts agree with what is there', () => {
    const a = pendingRow({ id: 'a', weekdays: ['MON'] });
    const result = impact([a], [a], [series('s1', T1, 'mon')]);
    expect(result.conflicts).toEqual([]);
    expect(result.unsatisfiable).toEqual([]);
  });

  it('reports a pending rule core cannot read instead of dropping it', () => {
    const bad = pendingRow({ id: 'bad', weekdays: ['Funday'] });
    const result = impact([bad], [bad]);
    expect(result.count).toBe(1);
    expect(result.unreadable).toEqual([expect.objectContaining({ ruleId: 'bad' })]);
  });
});

describe('the Conflicts tab', () => {
  let tables;
  let tableErrors;
  const asAdmin = (status = 'active') => {
    vi.mocked(useOrganization).mockReturnValue(
      /** @type {any} */ ({
        currentOrganization: { id: ORG },
        currentSeasonSetting: { id: SEASON, status },
        orgMember: { role: 'admin' },
      })
    );
    vi.mocked(useAuth).mockReturnValue(/** @type {any} */ ({ user: { id: 'user-admin' } }));
  };
  const open = async () => {
    render(
      <MemoryRouter>
        <ToastHost>
          <CoachPreferencesPage />
        </ToastHost>
      </MemoryRouter>
    );
    await screen.findByTestId('admin-preferences-view');
    fireEvent.click(screen.getByRole('tab', { name: /^Conflicts/ }));
    return screen.findByRole('heading', { name: /^Conflicts \(/ });
  };

  beforeEach(() => {
    tables = freshTables();
    tableErrors = {};
    vi.mocked(supabase.from).mockImplementation(
      /** @type {any} */ ((table) => makeFrom(tables, tableErrors)(table))
    );
    vi.mocked(supabase.rpc).mockReset();
    vi.mocked(supabase.rpc).mockResolvedValue(/** @type {any} */ ({ data: {}, error: null }));
    asAdmin();
    tables.coach_practice_preferences = [
      must({ id: 'a', weekdays: ['TUE'], coach_priority: 'high' }),
      must({ id: 'b', weekdays: ['THU'] }),
      must({ id: 'ok', team_id: T2, weekdays: ['WED'] }),
    ];
  });

  it('lists each team’s conflict with its rules, says how many teams it checked, and badges the tab', async () => {
    await open();
    expect(screen.getByRole('heading', { name: 'Conflicts (1)' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /^Conflicts/ })).toHaveTextContent('1');
    expect(screen.getByTestId('conflicts-checked')).toHaveTextContent(
      '1 conflict on 1 team. Checked 2 teams with rules.'
    );
    const team = screen.getByTestId('conflict-team');
    expect(within(team).getByRole('heading', { name: 'U10 Hawks' })).toBeInTheDocument();
    expect(within(team).getByTestId('conflict')).toHaveTextContent(
      'Weekday: these musts ask for values with nothing in common'
    );
    expect(within(team).getAllByRole('listitem')).toHaveLength(2);
    expect(team).toHaveTextContent('Casey Coach: Tuesday (priority high)');
    expect(team).toHaveTextContent('Casey Coach: Thursday');
    // Prefer rules that disagree are said not to be listed.
    expect(screen.getByText(/Prefer rules that disagree are not listed/)).toBeInTheDocument();
  });

  it('Edit and Remove on a conflicting rule open the same editor and confirmation as the rules list', async () => {
    await open();
    fireEvent.click(
      screen.getByRole('button', { name: /^Edit Casey Coach's rule for U10 Hawks: Thursday/ })
    );
    expect(await screen.findByRole('dialog', { name: 'Edit a rule' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(
      screen.getByRole('button', { name: /^Remove Casey Coach's rule for U10 Hawks: Thursday/ })
    );
    const dialog = await screen.findByRole('dialog', { name: 'Remove this rule' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove rule' }));
    await waitFor(() =>
      expect(supabase.rpc).toHaveBeenCalledWith('admin_remove_practice_preference', {
        p_preference_id: 'b',
      })
    );
  });

  it('with no conflicts it says none, and how many teams it checked', async () => {
    tables.coach_practice_preferences = [
      must({ id: 'ok', weekdays: ['WED'] }),
      must({ id: 'ok2', weekdays: ['WED', 'FRI'] }),
    ];
    await open();
    expect(screen.getByTestId('conflicts-checked')).toHaveTextContent(
      'No conflicts among the musts in force. Checked 1 team with rules.'
    );
    expect(screen.queryByTestId('conflict-team')).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /^Conflicts/ })).not.toHaveTextContent('1');
  });

  it('never says "no conflicts" when the roster or practices did not load', async () => {
    tableErrors.team_coach_assignments = {
      code: '42501',
      message: 'permission denied for table team_coach_assignments',
    };
    await open();
    const note = screen.getByTestId('conflicts-not-checked');
    expect(note).toHaveTextContent('Conflicts could not be checked');
    expect(note).toHaveTextContent('permission denied for table team_coach_assignments');
    expect(screen.queryByTestId('conflicts-checked')).not.toBeInTheDocument();
  });

  it('lists a rule core could not read beside the conflicts', async () => {
    tables.coach_practice_preferences.push(must({ id: 'bad', weekdays: ['Funday'] }));
    await open();
    expect(screen.getByTestId('conflicts-unreadable')).toHaveTextContent(
      '1 rule could not be read'
    );
    expect(screen.getByTestId('conflict-team')).toBeInTheDocument();
  });

  it('a completed season has Edit and Remove off', async () => {
    asAdmin('completed');
    await open();
    for (const button of screen.getAllByRole('button', { name: /^(Edit|Remove) / })) {
      expect(button).toBeDisabled();
    }
    expect(screen.getByTestId('season-readonly-note')).toBeInTheDocument();
  });
});
