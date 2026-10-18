/**
 * **What the two game evaluators are compared on** (#576 follow-up,
 * `docs/PLAN_GAME_EVALUATOR_UNKNOWN_TEAM.md` §3.5): the first cross-arm check
 * for games. Core `evaluateGameSchedule` (`packages/core/src/gameMetrics.js`)
 * publishes `warnings[]`; the Edge's (`_shared/engines/scoring-engine.ts`)
 * publishes `issues[]` with severities. Both are projected here onto one
 * shape, which `game-scoring-vectors.json`'s `truth` is written in:
 *
 * - `unknownTeams`: every unknown-team report's team id, sorted, **with
 *   repeats** -- so an arm that reported a team once per game rather than once
 *   per id shows it;
 * - `teamsRostered`, `teamsScheduled`, `teamsReferencedUnknown`: the three
 *   team counts, as each arm publishes them;
 * - `coachConflicts`, `teamsDoubleBooked`: the coach ids and team ids each arm
 *   reports a clash for, as sets (core reports one warning per id, the Edge one
 *   issue per overlapping pair; that difference is the arms' own).
 *
 * Messages and severities are each arm's own and are not compared, and
 * core's `field-overlap` warning has no Edge twin (declared, Q5).
 *
 * Plain ESM with no imports, so Deno loads it by relative path.
 */

const uniqueSorted = (values) => [...new Set(values)].sort();

/** The Edge's unknown-team message prefix (`GAME_UNKNOWN_TEAM_MESSAGE` in the engine). */
export const EDGE_UNKNOWN_TEAM_MESSAGE = 'game references unknown team';

/** Core's game evaluation, projected. */
export function coreGameProjection(result) {
  const of = (type, key) =>
    result.warnings.filter((w) => w.type === type).map((w) => String(w.details[key]));
  return {
    unknownTeams: of('unknown-team', 'teamId').sort(),
    teamsRostered: result.summary.teamsRostered,
    teamsScheduled: result.summary.teamsScheduled,
    teamsReferencedUnknown: result.summary.teamsReferencedUnknown,
    coachConflicts: uniqueSorted(of('coach-conflict', 'coachId')),
    teamsDoubleBooked: uniqueSorted(of('team-double-booked', 'teamId')),
  };
}

/** The Edge's game evaluation, projected. */
export function edgeGameProjection(result) {
  const of = (category) =>
    result.issues.filter((i) => i.category === category).map((i) => String(i.details.id));
  return {
    unknownTeams: result.issues
      .filter(
        (i) => i.category === 'data-quality' && i.message.startsWith(EDGE_UNKNOWN_TEAM_MESSAGE)
      )
      .map((i) => String(i.details.teamId))
      .sort(),
    teamsRostered: result.summary.teamsRostered,
    teamsScheduled: result.summary.teamsScheduled,
    teamsReferencedUnknown: result.summary.teamsReferencedUnknown,
    coachConflicts: uniqueSorted(of('coach-game-conflict')),
    teamsDoubleBooked: uniqueSorted(of('team-double-booked')),
  };
}

/** A vector's `truth`, in the projection's shape (its Edge-only fields left out). */
export function truthProjection(truth) {
  return {
    unknownTeams: [...truth.unknownTeams].sort(),
    teamsRostered: truth.teamsRostered,
    teamsScheduled: truth.teamsScheduled,
    teamsReferencedUnknown: truth.teamsReferencedUnknown,
    coachConflicts: [...truth.coachConflicts].sort(),
    teamsDoubleBooked: [...truth.teamsDoubleBooked].sort(),
  };
}
