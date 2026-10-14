/**
 * `fairness-scoring` refuses a practice block with no teams or no slots
 * (remediation M2.6, found by #551).
 *
 * The defect: the engine resolves every assignment against `teams` and
 * `slots`, so with either list empty it drops every row and reports zero coach
 * conflicts after examining nothing; with `persist: true` the handler recorded
 * that clean result as an `evaluation_runs` row. #551 stopped the page sending
 * such a request; the server did not refuse one.
 *
 * Two halves, because the handler module calls `serve()` when it is imported
 * and so cannot be loaded here:
 *   1. the refusal itself, `refuseEmptyPracticeRoster`, on every empty shape
 *      and with `persist` both ways (the parsed request, through the
 *      function's own `ScoringInputSchema`);
 *   2. a source pin on `fairness-scoring/index.ts`: the refusal is called on
 *      the parsed practice block, answers 422, and sits before the season
 *      read, the engine and `persist_evaluation_run`, so no run can be written
 *      for a refused request. (The same pin style as
 *      `tests/fairnessScoringRateLimit.test.js`.)
 */
import {
  assert,
  assertEquals,
  assertMatch,
  assertStringIncludes,
} from 'https://deno.land/std@0.203.0/assert/mod.ts';
import { evaluatePracticeSchedule } from '../engines/scoring-engine.ts';
import {
  EMPTY_PRACTICE_ROSTER,
  ScoringInputSchema,
  refuseEmptyPracticeRoster,
} from '../schemas/scoring.ts';

const ORG = '00000000-0000-4000-8000-0000000000a1';
const TEAM = { id: 'team-1', division: 'U10', coachId: 'coach-a' };
const SLOT = {
  id: 'slot-1',
  capacity: 1,
  start: '2026-04-06T18:00:00Z',
  end: '2026-04-06T19:00:00Z',
};

function parsedPractice(teams: unknown[], slots: unknown[], persist: boolean) {
  const parsed = ScoringInputSchema.safeParse({
    organizationId: ORG,
    practice: { teams, slots, assignments: [{ teamId: 'team-1', slotId: 'slot-1' }] },
    games: null,
    persist,
  });
  assert(parsed.success, 'the request under test must pass the schema, or it tests the schema');
  return parsed.data.practice;
}

Deno.test('the defect: with no teams the engine scores a perfect schedule (meta, can fail)', () => {
  // Why the refusal exists: no team was examined, yet coverage and fairness
  // are perfect and no coach conflict is reported (only a data-quality
  // warning). If the engine stops scoring an empty roster this way, this
  // fails and the refusal's reason should be re-read.
  const result = evaluatePracticeSchedule({
    teams: [],
    slots: [SLOT],
    assignments: [{ teamId: 'team-1', slotId: 'slot-1' }],
  });
  assertEquals(result.summary.totalTeams, 0);
  assertEquals(result.summary.coveragePercent, 100);
  assertEquals(result.summary.fairnessScore, 1);
  assertEquals(result.coachConflicts, []);
});

for (const persist of [true, false]) {
  for (const [label, teams, slots, teamCount, slotCount, counts] of [
    ['no teams', [], [SLOT], 0, 1, 'has 0 teams and 1 slot,'],
    ['no slots', [TEAM], [], 1, 0, 'has 1 team and 0 slots,'],
    ['no teams and no slots', [], [], 0, 0, 'has 0 teams and 0 slots,'],
  ] as const) {
    Deno.test(`refuses a practice block with ${label} (persist: ${persist})`, () => {
      const refusal = refuseEmptyPracticeRoster(parsedPractice([...teams], [...slots], persist));
      assert(refusal !== null, `a practice block with ${label} was not refused`);
      assertEquals(refusal.code, EMPTY_PRACTICE_ROSTER);
      assertEquals(refusal.code, 'EMPTY_PRACTICE_ROSTER');
      assertEquals(refusal.teamCount, teamCount);
      assertEquals(refusal.slotCount, slotCount);
      assertMatch(refusal.error, /at least one team and one practice slot/);
      assertStringIncludes(refusal.error, counts);
    });
  }
}

Deno.test('passes a practice block with a team and a slot, and a games-only request', () => {
  assertEquals(refuseEmptyPracticeRoster(parsedPractice([TEAM], [SLOT], true)), null);
  assertEquals(refuseEmptyPracticeRoster(null), null);
});

const HANDLER = await Deno.readTextFile(
  new URL('../../fairness-scoring/index.ts', import.meta.url)
);

/** Index of `needle` in the handler, failing loudly when it is absent. */
function at(needle: string): number {
  const i = HANDLER.indexOf(needle);
  assert(i >= 0, `fairness-scoring/index.ts no longer contains: ${needle}`);
  return i;
}

Deno.test('fairness-scoring refuses with a 422 before reading, evaluating or persisting', () => {
  const parse = at('const { practice, games, persist = false, metadata = {} } = parseResult.data;');
  const refuse = at('const emptyRoster = refuseEmptyPracticeRoster(practice);');
  const respond = at('return jsonResponse(emptyRoster, 422);');
  assert(parse < refuse, 'the refusal must read the parsed practice block');
  assert(refuse < respond, 'the refusal must answer 422');
  for (const later of [
    'await readSeasonTimezone(',
    'evaluatePracticeSchedule({',
    "supabase.rpc('persist_evaluation_run'",
    'await recordAuditNow(',
  ]) {
    assert(respond < at(later), `the 422 must come before ${later}`);
  }
  // Exactly one call: a second, later copy would not be what this pins.
  assertEquals(HANDLER.split('refuseEmptyPracticeRoster(').length - 1, 1);
});
