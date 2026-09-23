/**
 * 8.8 PR 2 -- effective-dated coach assignment, app side.
 *
 * The SQL half (the store, the single writer, the routed RPCs and the drift
 * check) is proved by execution in docs/sql/20260923000000_smoke.sql under
 * scripts/dbharness/run.sh. This file proves the three things the app owns:
 * the reader (history and the consequence report), the mock twins of the two
 * routed RPCs, and that the JS drift twin can fail.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  applyCoachChange,
  coachChangeConsequence,
  coachColumnDrift,
  coachesOfTeamOn,
} from '@squadlogic/core/people/index.js';
import { mockSupabase as supabase, getMockData } from '../frontend/src/lib/mockSupabaseClient.js';

const row = (team_id, coach_id, role, effective_from, effective_to = null, id = undefined) => ({
  id: id ?? `${team_id}-${coach_id}-${role}-${effective_from}`,
  team_id,
  coach_id,
  role,
  effective_from,
  effective_to,
});

describe('coachesOfTeamOn -- who coached this team on a date', () => {
  const rows = [
    row('t1', 'A', 'lead', '2026-08-01', '2026-08-31'),
    row('t1', 'B', 'lead', '2026-09-01'),
    row('t1', 'C', 'assistant', '2026-09-10', '2026-09-09'), // never in effect
  ];

  it('answers "three weeks earlier" from an ended row the columns no longer carry', () => {
    expect(coachesOfTeamOn(rows, 't1', '2026-08-15')).toEqual({ lead: ['A'], assistants: [] });
    expect(coachesOfTeamOn(rows, 't1', '2026-09-15')).toEqual({ lead: ['B'], assistants: [] });
  });

  it('reads both window ends as inclusive, matching windowCoversDate()', () => {
    expect(coachesOfTeamOn(rows, 't1', '2026-08-31').lead).toEqual(['A']);
    expect(coachesOfTeamOn(rows, 't1', '2026-09-01').lead).toEqual(['B']);
  });

  it('never counts a row that ended before it started', () => {
    expect(coachesOfTeamOn(rows, 't1', '2026-09-10').assistants).toEqual([]);
  });
});

describe('applyCoachChange -- the mirror of set_team_coaches()', () => {
  it('ends the dropped lead the day before and starts the new one on the day', () => {
    const { rows, ended, started } = applyCoachChange(
      [row('t1', 'A', 'lead', '2026-08-01')],
      { teamId: 't1', leadCoachId: 'B', assistantCoachIds: null },
      '2026-09-01'
    );
    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({ coach_id: 'A', effective_to: '2026-08-31' });
    expect(started).toEqual([
      {
        team_id: 't1',
        coach_id: 'B',
        role: 'lead',
        effective_from: '2026-09-01',
        effective_to: null,
      },
    ]);
    expect(rows).toHaveLength(2); // nothing removed
  });

  it('leaves assistants alone when given null, and replaces them when given a list', () => {
    const base = [row('t1', 'A', 'lead', '2026-08-01'), row('t1', 'C', 'assistant', '2026-08-01')];
    expect(
      applyCoachChange(
        base,
        { teamId: 't1', leadCoachId: 'A', assistantCoachIds: null },
        '2026-09-01'
      ).ended
    ).toHaveLength(0);
    const replaced = applyCoachChange(
      base,
      { teamId: 't1', leadCoachId: 'A', assistantCoachIds: ['D', 'D'] },
      '2026-09-01'
    );
    expect(replaced.ended.map((r) => r.coach_id)).toEqual(['C']);
    expect(replaced.started.map((r) => r.coach_id)).toEqual(['D']);
  });

  it('keeps a same-day start-and-end as a never-in-effect row rather than deleting it', () => {
    const { rows } = applyCoachChange(
      [row('t1', 'A', 'lead', '2026-09-01')],
      { teamId: 't1', leadCoachId: null, assistantCoachIds: null },
      '2026-09-01'
    );
    expect(rows).toEqual([expect.objectContaining({ coach_id: 'A', effective_to: '2026-08-31' })]);
  });
});

describe('coachChangeConsequence -- the sole-coach register before and after', () => {
  const rows = [
    row('t1', 'A', 'lead', '2026-08-01'),
    row('t1', 'C', 'assistant', '2026-08-01'),
    row('t2', 'B', 'lead', '2026-08-01'),
  ];
  const teamIds = ['t1', 't2', 't3']; // t3 has no row at all

  it('reports a team dropping to one coach, naming who it now depends on', () => {
    const report = coachChangeConsequence({
      rows,
      teamIds,
      change: { teamId: 't1', leadCoachId: null, assistantCoachIds: null },
      effectiveOn: '2026-09-23',
    });
    expect(report.teamsExamined).toBe(3);
    expect(report.changes).toEqual([
      { teamId: 't1', effect: 'sole', stateBefore: 'covered', soleCoachId: 'C' },
    ]);
    // The register itself is what said so, before and after.
    expect(report.before.teams.map((t) => t.teamId)).toEqual(['t2']);
    expect(report.after.teams.map((t) => t.teamId)).toEqual(['t1', 't2']);
  });

  it('reports a sole-coach team left with nobody', () => {
    const report = coachChangeConsequence({
      rows,
      teamIds,
      change: { teamId: 't2', leadCoachId: null, assistantCoachIds: null },
      effectiveOn: '2026-09-23',
    });
    expect(report.changes).toEqual([
      { teamId: 't2', effect: 'uncoached', stateBefore: 'sole', soleCoachId: null },
    ]);
  });

  it('counts a team with no row at all as uncoached, from the team universe', () => {
    // t3 never reaches buildCoachRoster(); assigning it a coach is only
    // reportable as uncoached -> sole because the universe is the team list.
    const report = coachChangeConsequence({
      rows,
      teamIds,
      change: { teamId: 't3', leadCoachId: 'D', assistantCoachIds: null },
      effectiveOn: '2026-09-23',
    });
    expect(report.changes).toEqual([
      { teamId: 't3', effect: 'sole', stateBefore: 'uncoached', soleCoachId: 'D' },
    ]);
  });

  it('refuses a change to a team outside the universe rather than reporting nothing', () => {
    expect(() =>
      coachChangeConsequence({
        rows,
        teamIds,
        change: { teamId: 'nope', leadCoachId: null, assistantCoachIds: null },
        effectiveOn: '2026-09-23',
      })
    ).toThrow(/not in the team universe/);
  });
});

describe('coachColumnDrift -- the JS twin of team_coach_assignment_drift()', () => {
  it('is clean when columns equal current rows, and goes red each way it can break', () => {
    const rows = [row('t1', 'A', 'lead', '2026-08-01'), row('t1', 'C', 'assistant', '2026-08-01')];
    const teams = [
      { id: 't1', coach_id: 'A', assistant_coach_ids: ['C'] },
      { id: 't2', coach_id: null, assistant_coach_ids: null },
    ];
    const clean = coachColumnDrift({ teams, rows, asOf: '2026-09-23' });
    expect(clean).toHaveLength(2); // enumerated from teams, t2 included
    expect(clean.every((entry) => entry.inSync)).toBe(true);

    // A row with no column update.
    const rowOnly = coachColumnDrift({
      teams,
      rows: [...rows, row('t2', 'B', 'lead', '2026-09-01')],
      asOf: '2026-09-23',
    });
    expect(rowOnly.filter((entry) => !entry.inSync).map((e) => e.teamId)).toEqual(['t2']);

    // A column update with no row.
    const columnOnly = coachColumnDrift({
      teams: [teams[0], { ...teams[1], assistant_coach_ids: ['B'] }],
      rows,
      asOf: '2026-09-23',
    });
    expect(columnOnly.filter((entry) => !entry.inSync).map((e) => e.teamId)).toEqual(['t2']);
  });
});

describe('mock twins route through the single writer', () => {
  const setSession = (userId) =>
    sessionStorage.setItem('__MOCK_SESSION__', JSON.stringify({ user: { id: userId } }));
  const today = () => new Date().toISOString().slice(0, 10);
  const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
  const driftOf = () =>
    coachColumnDrift({
      teams: getMockData('teams').filter((team) => team.organization_id === 'org-1'),
      rows: getMockData('team_coach_assignments'),
      asOf: today(),
    });

  beforeEach(() => {
    sessionStorage.clear();
    delete window.__MOCK_DB__;
    setSession('mock-admin-id');
  });

  it('starts in sync, over every seeded team of the organisation', () => {
    const drift = driftOf();
    expect(drift.length).toBe(getMockData('teams', 'organization_id', 'org-1').length);
    expect(drift.length).toBeGreaterThan(1);
    expect(drift.filter((entry) => !entry.inSync)).toEqual([]);
  });

  it('admin_assign_team_coach: swap end-dates, history answers, drift stays clean', async () => {
    // mock-coach-id may coach several teams; it takes over t2 from c2.
    const newCoach = getMockData('coaches').find((coach) => coach.id === 'mock-coach-id');
    expect(newCoach?.can_coach_multiple_teams).toBe(true);

    const { error } = await supabase.rpc('admin_assign_team_coach', {
      p_organization_id: 'org-1',
      p_team_id: 't2',
      p_coach_id: newCoach.id,
      p_effective_on: daysAgo(3),
    });
    expect(error).toBeNull();

    const rows = getMockData('team_coach_assignments');
    expect(coachesOfTeamOn(rows, 't2', daysAgo(10)).lead).toEqual(['c2']);
    expect(coachesOfTeamOn(rows, 't2', today()).lead).toEqual([String(newCoach.id)]);
    expect(rows.find((r) => r.id === 'tca-t2-lead')).toMatchObject({
      effective_to: daysAgo(4),
      ended_via: 'admin_assign_team_coach',
    });
    expect(driftOf().filter((entry) => !entry.inSync)).toEqual([]);
    expect(
      getMockData('audit_log').filter((entry) => entry.action === 'team.coach_assignments_changed')
    ).toHaveLength(1);

    // The two date refusals, with the SQL's words.
    const backdated = await supabase.rpc('admin_assign_team_coach', {
      p_organization_id: 'org-1',
      p_team_id: 't2',
      p_coach_id: null,
      p_effective_on: daysAgo(30),
    });
    expect(backdated.error?.message).toMatch(/would rewrite it/);
    const future = await supabase.rpc('admin_assign_team_coach', {
      p_organization_id: 'org-1',
      p_team_id: 't2',
      p_coach_id: null,
      p_effective_on: '2999-01-01',
    });
    expect(future.error?.message).toMatch(/cannot take effect in the future/);
    expect(getMockData('teams').find((team) => team.id === 't2').coach_id).toBe(newCoach.id);
  });

  it('admin_delete_coaches: the deleted coach is end-dated, not erased', async () => {
    const { error } = await supabase.rpc('admin_delete_coaches', { p_coach_ids: ['c2'] });
    expect(error).toBeNull();
    const kept = getMockData('team_coach_assignments').find((r) => r.id === 'tca-t2-lead');
    expect(kept).toMatchObject({ coach_id: 'c2', ended_via: 'admin_delete_coaches' });
    expect(kept.effective_to).toBe(daysAgo(1));
    expect(getMockData('teams').find((team) => team.id === 't2').coach_id).toBeNull();
    expect(driftOf().filter((entry) => !entry.inSync)).toEqual([]);
  });
});
