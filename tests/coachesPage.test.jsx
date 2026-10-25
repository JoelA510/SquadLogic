import { describe, expect, it } from 'vitest';
import {
  buildCoachReviewRows,
  buildTeamAssignmentOptions,
  canAssignCoachToTeam,
  canSetCoachStatus,
  filterCoachReviewRows,
  planBulkCoachStatus,
  summarizeCoachRows,
} from '../frontend/src/pages/CoachesPage.jsx';

const divisions = [
  { id: 'u8', name: 'U8 Coed' },
  { id: 'u10', name: 'U10 Girls' },
];

const coaches = [
  {
    id: 'coach-active',
    full_name: 'Alex Active',
    email: 'alex@example.com',
    phone: '555-1000',
    status: 'active',
    last_imported_at: '2026-04-01T00:00:00Z',
    can_coach_multiple_teams: true,
  },
  {
    id: 'coach-lead',
    full_name: 'Morgan Lead',
    email: 'morgan@example.com',
    status: 'interested',
  },
  {
    id: 'coach-unassigned',
    full_name: 'Uma Unassigned',
    email: 'uma@example.com',
    status: 'active',
  },
  {
    id: 'coach-inactive',
    full_name: 'Inactive Coach',
    email: 'inactive@example.com',
    status: 'inactive',
  },
];

const teams = [{ id: 'team-1', name: 'Blue Sharks', coach_id: 'coach-active', division_id: 'u8' }];

describe('coach review page helpers', () => {
  // A coach's programs are the divisions of the teams they coach: the lead
  // programs a player import recorded went with the coach leads (R4).
  it('builds coach rows with status groups, programs from their teams, and teams', () => {
    const rows = buildCoachReviewRows({ coaches, divisions, teams });

    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({
      id: 'coach-active',
      statusLabel: 'Registered',
      statusGroup: 'registered',
      canCoachMultipleTeams: true,
      divisionIds: ['u8'],
      programNames: ['U8 Coed'],
      teams: [{ id: 'team-1', name: 'Blue Sharks', divisionId: 'u8' }],
    });
    expect(rows[1]).toMatchObject({
      id: 'coach-lead',
      statusLabel: 'Interested',
      statusGroup: 'interested',
      divisionIds: [],
      programNames: [],
    });
    expect(rows[1]).not.toHaveProperty('playerNames');
    expect(rows[1]).not.toHaveProperty('interestedProgramCount');
  });

  it('summarizes roster action buckets', () => {
    const rows = buildCoachReviewRows({ coaches, divisions, teams });

    expect(summarizeCoachRows(rows)).toEqual({
      total: 4,
      registered: 2,
      interested: 1,
      inactive: 1,
      unassigned: 1,
    });
  });

  it('filters by status, division, and visible text search', () => {
    const rows = buildCoachReviewRows({ coaches, divisions, teams });

    expect(filterCoachReviewRows(rows, { status: 'interested' }).map((row) => row.id)).toEqual([
      'coach-lead',
    ]);
    expect(filterCoachReviewRows(rows, { divisionId: 'u10' }).map((row) => row.id)).toEqual([]);
    expect(filterCoachReviewRows(rows, { divisionId: 'u8' }).map((row) => row.id)).toEqual([
      'coach-active',
    ]);
    expect(filterCoachReviewRows(rows, { search: 'blue sharks' }).map((row) => row.id)).toEqual([
      'coach-active',
    ]);
  });

  it('builds team assignment options with current coach context', () => {
    expect(buildTeamAssignmentOptions({ teams, divisions })).toEqual([
      {
        value: 'team-1',
        label: 'Blue Sharks - U8 Coed - Assigned',
        coachId: 'coach-active',
        divisionId: 'u8',
      },
    ]);
  });

  it('only allows active or pending coaches to be assigned', () => {
    expect(canAssignCoachToTeam({ status: 'active' })).toBe(true);
    expect(canAssignCoachToTeam({ status: 'pending-confirmation' })).toBe(true);
    expect(canAssignCoachToTeam({ status: 'interested' })).toBe(false);
    expect(canAssignCoachToTeam({ status: 'inactive' })).toBe(false);
  });

  it('blocks assigned coaches from inactive or interested status transitions', () => {
    const assignedCoach = { teams: [{ id: 'team-1' }] };
    const unassignedCoach = { teams: [] };

    expect(canSetCoachStatus(assignedCoach, 'inactive')).toBe(false);
    expect(canSetCoachStatus(assignedCoach, 'interested')).toBe(false);
    expect(canSetCoachStatus(assignedCoach, 'active')).toBe(true);
    expect(canSetCoachStatus(unassignedCoach, 'inactive')).toBe(true);
    expect(canSetCoachStatus(unassignedCoach, 'interested')).toBe(true);
  });

  describe('planBulkCoachStatus', () => {
    const rows = buildCoachReviewRows({ coaches, divisions, teams });

    it('targets only the selected coaches that are not already in the status', () => {
      const { eligible, skipped } = planBulkCoachStatus(
        rows,
        new Set(['coach-lead', 'coach-unassigned', 'coach-inactive']),
        'inactive'
      );

      // coach-inactive is already inactive → no-op skip.
      expect(eligible.map((row) => row.id)).toEqual(['coach-lead', 'coach-unassigned']);
      expect(skipped).toBe(1);
    });

    it('skips coaches whose status rules forbid the transition', () => {
      // coach-active has an assigned team and cannot be benched.
      const { eligible, skipped } = planBulkCoachStatus(
        rows,
        new Set(['coach-active', 'coach-unassigned']),
        'inactive'
      );

      expect(eligible.map((row) => row.id)).toEqual(['coach-unassigned']);
      expect(skipped).toBe(1);
    });

    it('ignores ids that are not in the roster and handles empty selections', () => {
      expect(planBulkCoachStatus(rows, new Set(['ghost']), 'active')).toEqual({
        eligible: [],
        skipped: 0,
      });
      expect(planBulkCoachStatus(rows, new Set(), 'active')).toEqual({
        eligible: [],
        skipped: 0,
      });
    });
  });
});
