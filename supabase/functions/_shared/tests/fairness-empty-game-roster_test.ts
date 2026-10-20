/**
 * `fairness-scoring` refuses a games block with no teams or no games: M2.6's
 * refusal (`fairness-empty-roster_test.ts`), for games. Found by PR 2-C (plan
 * "Discovered during execution").
 *
 * The defect: `evaluateGameSchedule` skipped each side of a game whose team
 * was not in `teams`, without a word, so with `teams` empty it skipped every
 * game and reported `ok`, coverage 100, no conflict; with `games` empty it
 * reports `ok` over nothing. With `persist: true` the handler recorded either
 * as a run.
 *
 * Input validation at the boundary, as M2.6 did. Since the #576 follow-up the
 * engine itself reports each unknown side and a roster nothing matches (the
 * meta test below pins that); the no-games shape is still `ok` over nothing,
 * so the refusal still stands in front of both. A block with teams and games
 * but no rostered side is `fairness-game-roster-unmatched_test.ts`'s.
 *
 * Two halves, because the handler module calls `serve()` when it is imported:
 *   1. the refusal itself, `refuseEmptyGameRoster`, on every empty shape and
 *      with `persist` both ways (through the function's own `ScoringInputSchema`);
 *   2. a source pin on `fairness-scoring/index.ts`: the refusal is called on the
 *      parsed games block, answers 422, and sits before the season read, the
 *      engine and `persist_evaluation_run`.
 */
import {
  assert,
  assertEquals,
  assertMatch,
  assertStringIncludes,
} from 'https://deno.land/std@0.203.0/assert/mod.ts';
import { evaluateGameSchedule } from '../engines/scoring-engine.ts';
import {
  EMPTY_GAME_ROSTER,
  ScoringInputSchema,
  refuseEmptyGameRoster,
} from '../schemas/scoring.ts';

const ORG = '00000000-0000-4000-8000-0000000000a2';
const TEAM_A = { id: 'team-a', division: 'U10', coachId: 'coach-1' };
const TEAM_B = { id: 'team-b', division: 'U10', coachId: 'coach-1' };
// Two games at the same time for one coach: a conflict the engine reports
// when it can see the teams.
const GAMES = [
  {
    weekIndex: 1,
    division: 'U10',
    homeTeamId: 'team-a',
    awayTeamId: 'team-x',
    start: '2026-10-03T13:00:00Z',
    end: '2026-10-03T14:00:00Z',
  },
  {
    weekIndex: 1,
    division: 'U10',
    homeTeamId: 'team-b',
    awayTeamId: 'team-y',
    start: '2026-10-03T13:00:00Z',
    end: '2026-10-03T14:00:00Z',
  },
];

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

Deno.test(
  'with no teams the engine now reports every side unknown and examined nothing (meta, can fail)',
  () => {
    // Control: with the teams, the coach's double-booking is found.
    const seen = evaluateGameSchedule({ assignments: GAMES as never, teams: [TEAM_A, TEAM_B] });
    assertEquals(seen.status, 'action-required');
    assert(seen.issues.some((i) => i.category === 'coach-game-conflict'));
    // Without them, every side is an unknown team and the run is an error,
    // not a perfect report (#576 follow-up). The refusal still answers first.
    const blind = evaluateGameSchedule({ assignments: GAMES as never, teams: [] });
    assertEquals(blind.status, 'action-required');
    assertEquals(blind.summary.teamsScheduled, 0);
    assertEquals(blind.summary.teamsReferencedUnknown, 4);
    assertEquals(blind.summary.coveragePercent, 0);
    assert(blind.issues.some((i) => i.category === 'coverage' && i.severity === 'error'));
  }
);

Deno.test('the defect: with no games the engine answers ok over nothing (meta, can fail)', () => {
  const none = evaluateGameSchedule({ assignments: [], teams: [TEAM_A, TEAM_B] });
  assertEquals(none.status, 'ok');
  assertEquals(none.summary.totalAssignments, 0);
});

for (const persist of [true, false]) {
  for (const [label, teams, games, teamCount, gameCount, counts] of [
    ['no teams', [], GAMES, 0, 2, 'has 0 teams and 2 games,'],
    ['no games', [TEAM_A], [], 1, 0, 'has 1 team and 0 games,'],
    ['no teams and no games', [], [], 0, 0, 'has 0 teams and 0 games,'],
  ] as const) {
    Deno.test(`refuses a games block with ${label} (persist: ${persist})`, () => {
      const refusal = refuseEmptyGameRoster(parsedGames([...teams], [...games], persist));
      assert(refusal !== null, `a games block with ${label} was not refused`);
      assertEquals(refusal.code, EMPTY_GAME_ROSTER);
      assertEquals(refusal.code, 'EMPTY_GAME_ROSTER');
      assertEquals(refusal.teamCount, teamCount);
      assertEquals(refusal.gameCount, gameCount);
      assertMatch(refusal.error, /at least one team and one game/);
      assertStringIncludes(refusal.error, counts);
    });
  }
}

Deno.test('passes a games block with a team and a game, and a practice-only request', () => {
  assertEquals(refuseEmptyGameRoster(parsedGames([TEAM_A], [GAMES[0]], true)), null);
  assertEquals(refuseEmptyGameRoster(null), null);
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
  const refuse = at('const emptyGameRoster = refuseEmptyGameRoster(games);');
  const respond = at('return jsonResponse(emptyGameRoster, 422);');
  assert(parse < refuse, 'the refusal must read the parsed games block');
  assert(refuse < respond, 'the refusal must answer 422');
  for (const later of [
    'await readSeasonTimezone(',
    'evaluateGameSchedule({',
    ".rpc('persist_evaluation_run'",
    'await recordAuditNow(',
  ]) {
    assert(respond < at(later), `the 422 must come before ${later}`);
  }
  // Exactly one call: a second, later copy would not be what this pins.
  assertEquals(HANDLER.split('refuseEmptyGameRoster(').length - 1, 1);
});
