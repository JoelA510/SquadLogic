/**
 * `fairness-scoring` refuses a games block in which no game names a rostered
 * team (#576 follow-up, `docs/PLAN_GAME_EVALUATOR_UNKNOWN_TEAM.md` §3.3, Q2):
 * `fairness-empty-game-roster_test.ts`'s refusal one step on.
 *
 * The block has teams and games, so `refuseEmptyGameRoster` passes it, but
 * every side of every game is unknown to the roster: nothing on it would be
 * examined (vector G1), and no score should be saved. The engine alone reports
 * it as an `error`; this is the boundary's refusal, before the season read, the
 * engine and `persist_evaluation_run`.
 *
 * Two halves, because the handler module calls `serve()` when it is imported:
 *   1. the refusal, `refuseUnmatchedGameRoster`, with `persist` both ways
 *      (through the function's own `ScoringInputSchema`), and its controls;
 *   2. a source pin on `fairness-scoring/index.ts`: called on the parsed games
 *      block after the empty-roster refusal, answering 422, before the season
 *      read, the engine, persistence and the audit.
 */
import { assert, assertEquals, assertMatch } from 'https://deno.land/std@0.203.0/assert/mod.ts';
import { evaluateGameSchedule } from '../engines/scoring-engine.ts';
import {
  GAME_ROSTER_UNMATCHED,
  ScoringInputSchema,
  refuseEmptyGameRoster,
  refuseUnmatchedGameRoster,
} from '../schemas/scoring.ts';

const ORG = '00000000-0000-4000-8000-0000000000a3';
const TEAMS = [
  { id: 'team-a', division: 'U10', coachId: 'coach-1' },
  { id: 'team-b', division: 'U10', coachId: 'coach-2' },
];
const game = (home: string, away: string) => ({
  weekIndex: 1,
  division: 'U10',
  slotId: `slot-${home}-${away}`,
  homeTeamId: home,
  awayTeamId: away,
  start: '2026-10-03T13:00:00Z',
  end: '2026-10-03T14:00:00Z',
});
/** Vector G1: a roster that matches no game. */
const UNMATCHED = [game('team-x', 'team-y')];

function parsedGames(teams: unknown[], games: unknown[], persist: boolean) {
  const parsed = ScoringInputSchema.safeParse({
    organizationId: ORG,
    practice: null,
    games: { teams, games },
    persist,
  });
  assert(parsed.success, 'the request under test must pass the schema, or it tests the schema');
  return parsed.data.games;
}

Deno.test('the engine alone calls an unmatched roster an error, never ok (meta, can fail)', () => {
  const result = evaluateGameSchedule({ assignments: UNMATCHED as never, teams: TEAMS });
  assertEquals(result.status, 'action-required');
  assertEquals(result.summary.teamsScheduled, 0);
  assertEquals(result.summary.coveragePercent, 0);
  // It is not the empty-roster refusal's shape: that one passes it.
  assertEquals(refuseEmptyGameRoster(parsedGames(TEAMS, UNMATCHED, true)), null);
});

for (const persist of [true, false]) {
  Deno.test(`refuses a games block naming no rostered team (persist: ${persist})`, () => {
    const refusal = refuseUnmatchedGameRoster(parsedGames(TEAMS, UNMATCHED, persist));
    assert(refusal !== null, 'an unmatched games block was not refused');
    assertEquals(refusal.code, GAME_ROSTER_UNMATCHED);
    assertEquals(refusal.code, 'GAME_ROSTER_UNMATCHED');
    assertEquals(refusal.teamCount, 2);
    assertEquals(refusal.gameCount, 1);
    assertMatch(
      refusal.error,
      /No game in this request names a team on its roster \(2 teams, 1 game\)/
    );
  });
}

Deno.test(
  'passes a block with any rostered side, an empty block and a practice-only request',
  () => {
    // One rostered side is enough: its unknown opponent is a warning (Q3).
    assertEquals(
      refuseUnmatchedGameRoster(parsedGames(TEAMS, [game('team-a', 'team-x')], true)),
      null
    );
    assertEquals(
      refuseUnmatchedGameRoster(parsedGames(TEAMS, [game('team-x', 'team-b')], true)),
      null
    );
    // An empty block is the empty-roster refusal's, which runs first.
    assertEquals(refuseUnmatchedGameRoster(parsedGames([], UNMATCHED, true)), null);
    assertEquals(refuseUnmatchedGameRoster(parsedGames(TEAMS, [], true)), null);
    assertEquals(refuseUnmatchedGameRoster(null), null);
  }
);

const HANDLER = await Deno.readTextFile(
  new URL('../../fairness-scoring/index.ts', import.meta.url)
);

/** Index of `needle` in the handler, failing loudly when it is absent. */
function at(needle: string): number {
  const i = HANDLER.indexOf(needle);
  assert(i >= 0, `fairness-scoring/index.ts no longer contains: ${needle}`);
  return i;
}

Deno.test('fairness-scoring refuses it with a 422 before reading, evaluating or persisting', () => {
  const parse = at('const { practice, games, persist = false, metadata = {} } = parseResult.data;');
  const empty = at('return jsonResponse(emptyGameRoster, 422);');
  const refuse = at('const unmatchedGameRoster = refuseUnmatchedGameRoster(games);');
  const respond = at('return jsonResponse(unmatchedGameRoster, 422);');
  assert(parse < refuse, 'the refusal must read the parsed games block');
  assert(empty < refuse, 'the empty-roster refusal must answer first');
  assert(refuse < respond, 'the refusal must answer 422');
  for (const later of [
    'await readSeasonTimezone(',
    'evaluateGameSchedule({',
    "supabase.rpc('persist_evaluation_run'",
    'await recordAuditNow(',
  ]) {
    assert(respond < at(later), `the 422 must come before ${later}`);
  }
  assertEquals(HANDLER.split('refuseUnmatchedGameRoster(').length - 1, 1);
});
