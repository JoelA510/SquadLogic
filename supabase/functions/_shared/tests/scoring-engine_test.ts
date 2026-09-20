import { assertEquals, assertStringIncludes } from 'https://deno.land/std@0.203.0/assert/mod.ts';
import { evaluatePracticeSchedule } from '../engines/scoring-engine.ts';
import { Team, Slot, PracticeAssignment } from '../schemas/scoring.ts';

Deno.test('evaluatePracticeSchedule - basic assignment calculation', () => {
  const teams: Team[] = [
    { id: 'team-1', division: 'U10', coachId: 'coach-a' },
    { id: 'team-2', division: 'U10', coachId: 'coach-b' },
  ];

  const slots: Slot[] = [
    { id: 'slot-1', capacity: 2, start: '2026-04-06T18:00:00Z', end: '2026-04-06T19:00:00Z' },
    { id: 'slot-2', capacity: 1, start: '2026-04-06T19:00:00Z', end: '2026-04-06T20:00:00Z' },
  ];

  const assignments: PracticeAssignment[] = [
    { teamId: 'team-1', slotId: 'slot-1' },
    { teamId: 'team-2', slotId: 'slot-1' },
  ];

  const result = evaluatePracticeSchedule({ teams, slots, assignments });

  assertEquals(result.summary.totalTeams, 2);
  assertEquals(result.summary.assignedTeams, 2);
  assertEquals(result.summary.assignmentRate, 1.0);
  assertEquals(result.slotUtilization[0].utilization, 1.0); // 2/2
  assertEquals(result.slotUtilization[0].overbooked, false);
});

Deno.test('evaluatePracticeSchedule - coach conflict detection', () => {
  const teams: Team[] = [
    { id: 'team-1', division: 'U10', coachId: 'coach-a' },
    { id: 'team-2', division: 'U12', coachId: 'coach-a' },
  ];

  const slots: Slot[] = [
    { id: 'slot-1', capacity: 2, start: '2026-04-06T18:00:00Z', end: '2026-04-06T19:00:00Z' },
  ];

  const assignments: PracticeAssignment[] = [
    { teamId: 'team-1', slotId: 'slot-1' },
    { teamId: 'team-2', slotId: 'slot-1' },
  ];

  const result = evaluatePracticeSchedule({ teams, slots, assignments });

  assertEquals(result.coachConflicts.length, 1);
  assertEquals(result.coachConflicts[0].coachId, 'coach-a');
  // The engine has never produced the string 'Time overlap'; its reason reads
  // "Coach <id> has overlapping practices on <day>". This expectation was the
  // sole reason this file was kept out of the Deno mirror job, so it went
  // unrun for months rather than being reconciled. The contract adopted here
  // is the sibling's -- `tests/unit/scoring-engine.test.ts`, which runs the
  // same function under Vitest, already asserts `'overlapping practices'`.
  assertStringIncludes(result.coachConflicts[0].reason, 'overlapping practices');
});

Deno.test('evaluatePracticeSchedule - manual follow up categorization', () => {
  const teams: Team[] = [{ id: 'team-1', division: 'U10' }];
  const slots: Slot[] = [];
  const assignments: PracticeAssignment[] = [];
  const unassigned = [{ teamId: 'team-1', reason: 'No capacity remaining' }];

  const result = evaluatePracticeSchedule({ teams, slots, assignments, unassigned });

  assertEquals(result.manualFollowUpResults[0].category, 'capacity');
});
