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
 *
 * Needs `--allow-read` for the sibling-file assertion; the extract arrives as a
 * JSON module import and needs no permission.
 */

import { assert, assertEquals } from 'https://deno.land/std@0.203.0/assert/mod.ts';
import { evaluatePracticeSchedule } from '../engines/scoring-engine.ts';
import type { PracticeAssignment, Slot, Team } from '../schemas/scoring.ts';
import extract from './fixtures/scoring-parity.season-2026.json' with { type: 'json' };

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
