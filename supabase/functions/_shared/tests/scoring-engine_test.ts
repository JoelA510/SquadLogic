import {
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from 'https://deno.land/std@0.203.0/assert/mod.ts';
import { evaluatePracticeSchedule } from '../engines/scoring-engine.ts';
import { Team, Slot, PracticeAssignment, PracticeException } from '../schemas/scoring.ts';
import dated from './fixtures/scoring-dated-vectors.json' with { type: 'json' };

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

// ---- M4.7: the dated model, in the runtime the engine ships to -------------
//
// The hand-written witnesses `tests/practiceMetrics.test.js` and
// `tests/scoringEngineDrift.test.js` hold core and this engine to under Node
// (docs/PLAN_SCORING_DATE_MODEL.md §2.2, §4). Each `expected` is the truth
// worked out from the dates, never an engine answer.

interface DatedVector {
  name: string;
  witness: string;
  teams: Team[];
  slots: Slot[];
  assignments: PracticeAssignment[];
  exceptions?: PracticeException[];
  expected: {
    conflicts: Array<{ key: string; firstDate: string; sharedDates: number }>;
    slotLoad: Record<string, [number, number]>;
    dataQuality: number;
    assignedTeams: number;
    timeTbd?: Array<{
      teamId: string;
      slotId: string;
      exceptionId: unknown;
      code: string;
      dates: string[];
    }>;
  };
  undated: { conflicts: number; overbooked: string[] };
}

const DATED = dated.vectors as unknown as DatedVector[];

type Report = ReturnType<typeof evaluatePracticeSchedule>;

/** The vectors' `expected` shape (`tests/helpers/datedScoringVectors.js` `datedProjection`). */
function projection(report: Report) {
  return {
    conflicts: report.coachConflicts
      .map((c) => ({
        key: `${c.teams
          .map((t) => `${t.teamId}@${t.slotId}`)
          .sort()
          .join(' + ')} :: ${[...c.coachIds].sort().join(',')}`,
        firstDate: c.firstDate,
        sharedDates: c.sharedDates,
      }))
      .sort((a, b) => a.key.localeCompare(b.key)),
    slotLoad: Object.fromEntries(
      report.slotUtilization.map((s) => [
        s.slotId,
        [s.assignedCount, (s as { assignmentRows?: number }).assignmentRows],
      ])
    ),
    dataQuality: report.issues.filter((i) => i.category === 'data-quality').length,
    assignedTeams: report.summary.assignedTeams,
    ...(report.timeTbd !== undefined ? { timeTbd: report.timeTbd } : {}),
  };
}

Deno.test('evaluatePracticeSchedule dated - the witness table is populated (meta)', () => {
  assertEquals(DATED.length >= 14, true);
  const witnesses = new Set(DATED.map((v) => v.witness));
  for (const w of ['W1', 'W2', 'W2b', 'W3', 'W4', 'W5', 'overlap', 'open', 'unreadable', 'dst']) {
    assertEquals(witnesses.has(w), true, w);
  }
});

for (const vector of DATED) {
  Deno.test(`evaluatePracticeSchedule dated - ${vector.witness}: ${vector.name}`, () => {
    const report = evaluatePracticeSchedule(vector);
    assertEquals(report.summary.dateModel, 'dated');
    assertEquals(projection(report), vector.expected);
  });
}

Deno.test('evaluatePracticeSchedule dated - the undated comparison is the old one', () => {
  for (const vector of DATED) {
    const report = evaluatePracticeSchedule({
      teams: vector.teams,
      slots: vector.slots.map(({ id, day, capacity, start, end }) => ({
        id,
        day,
        capacity,
        start,
        end,
      })),
      assignments: vector.assignments.map(({ teamId, slotId }) => ({ teamId, slotId })),
    });
    assertEquals(report.summary.dateModel, 'undated');
    assertEquals(report.coachConflicts.length, vector.undated.conflicts, vector.name);
  }
});

Deno.test('evaluatePracticeSchedule dated - a mix of dated and undated slots refuses', () => {
  const vector = DATED.find((v) => v.witness === 'W4')!;
  const { firstDate: _f, lastDate: _l, ...undatedSlot } = vector.slots[1];
  assertThrows(
    () => evaluatePracticeSchedule({ ...vector, slots: [vector.slots[0], undatedSlot as Slot] }),
    TypeError,
    'must all carry firstDate and lastDate, or none: 1 of 2 do'
  );
});

// ---- The M4.7 follow-up: saved practice exceptions (plan Q1) ---------------
//
// The vectors with `exceptions` above run through the same projection, which
// carries `timeTbd`; these add what only the Edge reports.

const EXCEPTIONAL = DATED.filter((v) => v.exceptions !== undefined);

Deno.test('evaluatePracticeSchedule exceptions - the witnesses are present (meta)', () => {
  const witnesses = new Set(EXCEPTIONAL.map((v) => v.witness));
  for (const w of ['X-relocated-clash', 'X-relocated-capacity', 'X-tbd-clash', 'X-tbd-capacity']) {
    assertEquals(witnesses.has(w), true, w);
  }
  // A TIME TBD date is expected somewhere, so a report that never has one fails.
  assertEquals(
    EXCEPTIONAL.some((v) => (v.expected.timeTbd ?? []).length > 0),
    true
  );
});

Deno.test('evaluatePracticeSchedule exceptions - each TIME TBD entry is a warning issue', () => {
  const vector = DATED.find((v) => v.witness === 'X-tbd-clash')!;
  const report = evaluatePracticeSchedule(vector);
  const tbd = report.issues.filter((i) => i.category === 'time-tbd');
  assertEquals(tbd.length, 1);
  assertEquals(tbd[0].severity, 'warning');
  assertStringIncludes(tbd[0].message, 'TIME TBD on 2 date(s) from 2026-08-11 (past-sunset)');
});

Deno.test('evaluatePracticeSchedule exceptions - an undated call refuses them', () => {
  const vector = DATED.find((v) => v.witness === 'X-tbd-clash')!;
  const slots = vector.slots.map(({ id, day, capacity, start, end }) => ({
    id,
    day,
    capacity,
    start,
    end,
  }));
  assertThrows(
    () => evaluatePracticeSchedule({ ...vector, slots }),
    TypeError,
    'practice exceptions need a dated call'
  );
  // None sent is not a refusal.
  evaluatePracticeSchedule({ ...vector, slots, exceptions: [] });
});
