/**
 * The Deno arm of the core vs Edge scoring parity check on the season-2026
 * corpus (audit finding 1.1; remediation plan Oct 2026, M1.2).
 *
 * Runs `_shared/engines/scoring-engine.ts` over
 * `./fixtures/scoring-parity.season-2026.json` -- the club's combined practice
 * sheet against the full roster -- and compares its answer with the one
 * `packages/core/src/practiceMetrics.js` gave on the same inputs, recorded in
 * the extract. `tests/scoringParity.test.js` (Vitest) checks that the extract's
 * inputs are what the corpus derives today, that core still gives the recorded
 * answer, and that the Edge engine does under Node. This file asks the same of
 * the engine in the runtime it is deployed to. Either arm drifting turns one
 * red.
 *
 * Compared, the agreed contract of `tests/scoringEngineDrift.test.js`: summary
 * counts, `assignmentRate` (the score both arms publish), per-slot occupancy,
 * dropped rows, and every coach conflict by identity (the two placements and
 * the coaches they share). `fairnessScore` is Edge-only and is a function of
 * the conflict count and `assignmentRate`.
 * On this real plan no row is dropped and every slot holds one team, so those
 * two comparisons only guard a future extract; the drift test's vectors cover
 * drops, duplicates and overbooking.
 *
 * Needs `--allow-read` for the sibling-file assertion; the extract arrives as a
 * JSON module import and needs no permission.
 */

import { assert, assertEquals } from 'https://deno.land/std@0.203.0/assert/mod.ts';
import { evaluateGameSchedule, evaluatePracticeSchedule } from '../engines/scoring-engine.ts';
import type {
  GameAssignment,
  PracticeAssignment,
  PracticeException,
  Slot,
  Team,
} from '../schemas/scoring.ts';
import extract from './fixtures/scoring-parity.season-2026.json' with { type: 'json' };
import dated from './fixtures/scoring-parity-dated.season-2026.json' with { type: 'json' };
import games from './fixtures/scoring-parity-games.season-2026.json' with { type: 'json' };
import { edgeGameProjection } from '../../../../tests/fixtures/gameScoringProjection.js';

interface Agreed {
  summary: {
    totalTeams: number;
    assignedTeams: number;
    unassignedTeams: number;
    assignmentRate: number;
  };
  slotUtilization: Array<{ slotId: string; assignedCount: number; capacity: number }>;
  coachConflicts: string[];
  droppedRows: number;
}

const inputs = extract.inputs as unknown as {
  teams: Team[];
  slots: Slot[];
  assignments: PracticeAssignment[];
};
const expected = extract.expected as unknown as Agreed;

/**
 * Literals, not counts of the extract, and the same ones the Vitest arm
 * declares (it checks this file for each `name: value,` pair).
 */
const EXPECTED = {
  teams: 132,
  slots: 142,
  assignments: 142,
  assignedTeams: 88,
  coachConflicts: 1,
  teamsOnTwoOrMoreSlots: 54,
  teamsWithAssistants: 82,
};

const SIBLING_RUNNER = 'tests/scoringParity.test.js';
const GENERATOR = 'scripts/generate-scoring-parity.mjs';
const EXTRACT_PATH = 'supabase/functions/_shared/tests/fixtures/scoring-parity.season-2026.json';

type Conflict = { teams: Array<{ teamId: string; slotId: string }>; coachIds: string[] };

/** A conflict by identity, spelled as the Vitest arm spells it. */
const conflictKey = (c: Conflict) =>
  `${c.teams
    .map((t) => `${t.teamId}@${t.slotId}`)
    .sort()
    .join(' + ')} :: ${[...c.coachIds].sort().join(',')}`;

function runEdge(): Agreed {
  const result = evaluatePracticeSchedule(inputs);
  return {
    summary: {
      totalTeams: result.summary.totalTeams,
      assignedTeams: result.summary.assignedTeams,
      unassignedTeams: result.summary.unassignedTeams,
      assignmentRate: Number(result.summary.assignmentRate.toFixed(4)),
    },
    slotUtilization: result.slotUtilization
      .map((s) => ({ slotId: s.slotId, assignedCount: s.assignedCount, capacity: s.capacity }))
      .sort((a, b) => a.slotId.localeCompare(b.slotId)),
    coachConflicts: result.coachConflicts.map(conflictKey).sort(),
    droppedRows: result.issues.filter((i) => i.category === 'data-quality').length,
  };
}

Deno.test('scoring parity - the extract holds the season, with the cases parity needs', () => {
  assertEquals(inputs.teams.length, EXPECTED.teams);
  assertEquals(inputs.slots.length, EXPECTED.slots);
  assertEquals(inputs.assignments.length, EXPECTED.assignments);
  assertEquals(new Set(inputs.assignments.map((a) => a.teamId)).size, EXPECTED.assignedTeams);
  const slotsPerTeam = new Map<string, number>();
  for (const a of inputs.assignments) {
    slotsPerTeam.set(a.teamId, (slotsPerTeam.get(a.teamId) ?? 0) + 1);
  }
  assertEquals(
    [...slotsPerTeam.values()].filter((n) => n > 1).length,
    EXPECTED.teamsOnTwoOrMoreSlots
  );
  assertEquals(
    inputs.teams.filter((t) => (t.assistantCoachIds ?? []).length > 0).length,
    EXPECTED.teamsWithAssistants
  );
  // A real conflict, so "found none" cannot pass as agreement.
  assertEquals(expected.coachConflicts.length, EXPECTED.coachConflicts);
  assert(expected.summary.unassignedTeams > 0, 'every team placed: coverage would be vacuous');
});

Deno.test("scoring parity - the Edge engine gives core's recorded answer", () => {
  const edge = runEdge();
  assertEquals(edge.summary, expected.summary);
  assertEquals(edge.slotUtilization.length, EXPECTED.slots);
  assertEquals(edge.slotUtilization, expected.slotUtilization);
  assertEquals(edge.coachConflicts, expected.coachConflicts);
  assertEquals(edge.droppedRows, expected.droppedRows);
});

Deno.test(
  'scoring parity - the JS arm reads the same extract, or this is not a cross-check',
  () => {
    // Textual, as in season-clock_test.ts: the Vitest arm reads the extract
    // through the generator's path constant, and the generator names this file.
    const sibling = Deno.readTextFileSync(SIBLING_RUNNER);
    assert(
      sibling.includes("from '../scripts/generate-scoring-parity.mjs'") &&
        sibling.includes('SCORING_PARITY_EXTRACT'),
      `${SIBLING_RUNNER} no longer reads the extract through ${GENERATOR}`
    );
    const generator = Deno.readTextFileSync(GENERATOR);
    assert(
      generator.includes(`'${EXTRACT_PATH}'`),
      `${GENERATOR} no longer writes ${EXTRACT_PATH}`
    );
  }
);

// ---- M4.7: the dated extract (docs/PLAN_SCORING_DATE_MODEL.md §2.3, §3.4) ----
//
// The plan's corpus cases C1 and C4, dated as the practice page dates them;
// core's answer is recorded in the extract and checked against the corpus and
// core by `tests/scoringParity.test.js`. This asks the deployed runtime for it.

/** Literals, the same ones the Vitest arm declares and checks for here. */
const DATED_EXPECTED = {
  c1Slots: 170,
  c1Assignments: 170,
  c1ClosedRows: 28,
  c1Conflicts: 1,
  c1UndatedConflicts: 11,
  c1SharedDates: 7,
  c4Slots: 142,
  c4Conflicts: 1,
  c4UndatedConflicts: 0,
  c4SharedDates: 10,
  c5Exceptions: 2,
  c5Conflicts: 2,
  c5SharedDates: 8,
  c5TbdDates: 2,
  c5PeakOnTarget: 2,
};
const DATED_EXTRACT_PATH =
  'supabase/functions/_shared/tests/fixtures/scoring-parity-dated.season-2026.json';

type DatedCase = {
  slots: Slot[];
  assignments: PracticeAssignment[];
  exceptions?: PracticeException[];
  expected: Agreed & {
    timeTbd?: Array<{
      teamId: string;
      slotId: string;
      exceptionId: unknown;
      code: string;
      dates: string[];
    }>;
    dateModel: string;
    slotUtilization: Array<{
      slotId: string;
      assignedCount: number;
      assignmentRows: number;
      capacity: number;
    }>;
  };
};
const datedCases = dated.cases as unknown as Record<'C1' | 'C4' | 'C5', DatedCase>;
const datedTeams = dated.teams as unknown as Team[];

function runEdgeDated(c: DatedCase) {
  const result = evaluatePracticeSchedule({
    teams: datedTeams,
    slots: c.slots,
    assignments: c.assignments,
    exceptions: c.exceptions,
  });
  return {
    summary: {
      totalTeams: result.summary.totalTeams,
      assignedTeams: result.summary.assignedTeams,
      unassignedTeams: result.summary.unassignedTeams,
      assignmentRate: Number(result.summary.assignmentRate.toFixed(4)),
    },
    slotUtilization: result.slotUtilization
      .map((s) => ({
        slotId: s.slotId,
        assignedCount: s.assignedCount,
        assignmentRows: (s as { assignmentRows?: number }).assignmentRows as number,
        capacity: s.capacity,
      }))
      .sort((a, b) => a.slotId.localeCompare(b.slotId)),
    coachConflicts: result.coachConflicts
      .map((c) => `${conflictKey(c)} @ ${c.firstDate} x${c.sharedDates}`)
      .sort(),
    droppedRows: result.issues.filter((i) => i.category === 'data-quality').length,
    dateModel: result.summary.dateModel,
    timeTbd: result.timeTbd,
  };
}

Deno.test('scoring parity dated - the cases hold what the plan measured', () => {
  const { C1, C4 } = datedCases;
  assertEquals(C1.slots.length, DATED_EXPECTED.c1Slots);
  assertEquals(C1.assignments.length, DATED_EXPECTED.c1Assignments);
  assertEquals(
    C1.assignments.filter((a) => String(a.effectiveDateRange).endsWith(',2026-10-05)')).length,
    DATED_EXPECTED.c1ClosedRows
  );
  assertEquals(C4.slots.length, DATED_EXPECTED.c4Slots);
  assertEquals(C1.expected.coachConflicts.length, DATED_EXPECTED.c1Conflicts);
  assertEquals(C4.expected.coachConflicts.length, DATED_EXPECTED.c4Conflicts);
  assert(C1.expected.coachConflicts[0].endsWith(` x${DATED_EXPECTED.c1SharedDates}`));
  assert(C4.expected.coachConflicts[0].endsWith(` @ 2026-09-18 x${DATED_EXPECTED.c4SharedDates}`));
  // The same inputs undated: the defect this extract exists to keep fixed.
  const undated = (c: DatedCase) =>
    evaluatePracticeSchedule({
      teams: datedTeams,
      slots: c.slots.map(({ id, day, capacity, start, end }) => ({
        id,
        day,
        capacity,
        start,
        end,
      })),
      assignments: c.assignments.map(({ teamId, slotId }) => ({ teamId, slotId })),
    }).coachConflicts.length;
  assertEquals(undated(C1), DATED_EXPECTED.c1UndatedConflicts);
  assertEquals(undated(C4), DATED_EXPECTED.c4UndatedConflicts);
});

Deno.test("scoring parity dated - the Edge engine gives core's recorded answer", () => {
  for (const name of ['C1', 'C4', 'C5'] as const) {
    const edge = runEdgeDated(datedCases[name]);
    const { expected } = datedCases[name];
    assertEquals(edge.dateModel, 'dated', name);
    assertEquals(edge.summary, expected.summary, name);
    assertEquals(edge.slotUtilization, expected.slotUtilization, name);
    assertEquals(edge.coachConflicts, expected.coachConflicts, name);
    assertEquals(edge.droppedRows, expected.droppedRows, name);
    assertEquals(edge.timeTbd, expected.timeTbd, name);
  }
});

Deno.test('scoring parity dated - C5 holds the exceptions the plan follow-up models', () => {
  const { C5 } = datedCases;
  assertEquals(C5.exceptions?.length, DATED_EXPECTED.c5Exceptions);
  assertEquals(C5.expected.coachConflicts.length, DATED_EXPECTED.c5Conflicts);
  assert(
    C5.expected.coachConflicts.some((c) =>
      c.endsWith(` @ 2026-10-02 x${DATED_EXPECTED.c5SharedDates}`)
    )
  );
  assertEquals(C5.expected.timeTbd?.[0].dates.length, DATED_EXPECTED.c5TbdDates);
  assert(
    C5.expected.slotUtilization.some((s) => s.assignedCount === DATED_EXPECTED.c5PeakOnTarget)
  );
});

Deno.test('scoring parity dated - the generator writes the extract this file reads', () => {
  const generator = Deno.readTextFileSync(GENERATOR);
  assert(
    generator.includes(`'${DATED_EXTRACT_PATH}'`),
    `${GENERATOR} no longer writes ${DATED_EXTRACT_PATH}`
  );
});

// ---- Games (#576 follow-up, docs/PLAN_GAME_EVALUATOR_UNKNOWN_TEAM.md §3.5) ----

/** Literals, the Vitest arm's (it checks this file for each `name: value,` pair). */
const GAMES_EXPECTED = {
  games: 542,
  teamsRostered: 132,
  teamsScheduled: 131,
  unknownTeams: 5,
  gameCoachConflicts: 3,
};
const GAMES_EXTRACT_PATH =
  'supabase/functions/_shared/tests/fixtures/scoring-parity-games.season-2026.json';

Deno.test("scoring parity, games - the Edge engine gives core's recorded answer", () => {
  assertEquals(games.inputs.games.length, GAMES_EXPECTED.games);
  assertEquals(games.inputs.teams.length, GAMES_EXPECTED.teamsRostered);
  assertEquals(games.expected.teamsScheduled, GAMES_EXPECTED.teamsScheduled);
  assertEquals(games.expected.unknownTeams.length, GAMES_EXPECTED.unknownTeams);
  assertEquals(games.expected.coachConflicts.length, GAMES_EXPECTED.gameCoachConflicts);
  const result = evaluateGameSchedule({
    assignments: games.inputs.games as unknown as GameAssignment[],
    teams: games.inputs.teams as unknown as Team[],
  });
  assertEquals(edgeGameProjection(result), games.expected);
  assertEquals(result.summary.coveragePercent, 99.24);
});

Deno.test('scoring parity, games - the generator writes the extract this arm reads', () => {
  const generator = Deno.readTextFileSync(GENERATOR);
  assert(
    generator.includes(`'${GAMES_EXTRACT_PATH}'`),
    `${GENERATOR} no longer writes ${GAMES_EXTRACT_PATH}`
  );
});
