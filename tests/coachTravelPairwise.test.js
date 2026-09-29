/**
 * **#62a: overlap is judged over every pair; the gap floors stay neighbours.**
 *
 * `evaluateCoachTravel()` used to judge overlap only on start-sorted
 * neighbours, so a long commitment with a short one inside it hid its overlap
 * with whatever followed the short one. `resolve/ruleGate.js` already asked
 * every pair ("pairwise, not consecutive"), so the gate and `verify` could
 * disagree about the same coach-day. These witnesses are W8 to W12 of
 * `docs/PLAN_60_62_GATE_GAPS.md` (PR #513). All data is synthetic except W12, which pins
 * the season-2026 corpus the plan measured a delta of 0 on.
 */

import { describe, it, expect } from 'vitest';

import { buildSeason2026ConstraintRegistry } from '@squadlogic/core/constraints/index.js';
import {
  EMPTY_VENUE_COMPLEX_MAP,
  buildSeason2026VenueComplexMap,
} from '@squadlogic/core/facility/index.js';
import { loadSeason2026 } from '@squadlogic/core/fixtures/index.js';
import {
  RULE_ID,
  ScheduleSchema,
  buildRuleEngine,
  coachConflictRule,
  conflictFairnessRule,
  runRuleEngine,
  toSeason2026Schedule,
} from '@squadlogic/core/ruleEngine/index.js';
import { TRAVEL_REASON, evaluateCoachTravel } from '@squadlogic/core/waivers/index.js';

const registry = buildSeason2026ConstraintRegistry();
const season = toSeason2026Schedule(loadSeason2026());
/** A date the season's registry governs, taken from the corpus rather than typed in. */
const DATE = season.commitments[0].date;
const PERSON = 'coach-synthetic-c';
const OVERLAP = TRAVEL_REASON.TRAVEL_COMMITMENTS_OVERLAP;

/** One synthetic commitment for coach C on DATE. */
function commitment(id, teamId, start, end, venueId = 'venue-v1') {
  return {
    id,
    personId: PERSON,
    date: DATE,
    startMinutes: start,
    endMinutes: end,
    venueId,
    teamId,
    gameId: `game-${id}`,
  };
}

/** The plan's §2.3 day: B sits inside A, and A's tail overlaps G. */
const A = commitment('A', 'team-t1', 9 * 60, 10 * 60 + 30);
const B = commitment('B', 'team-t2', 9 * 60 + 10, 9 * 60 + 20);
const G = commitment('G', 'team-t3', 10 * 60, 11 * 60);
const DAY = [A, B, G];

/** An unordered pair, spelled one way. */
const pairOf = (x, y) => [x, y].sort().join('+');

/** The overlap findings a travel result carries, as unordered pairs. */
const overlapPairs = (travel) =>
  travel.findings
    .filter((finding) => finding.code === OVERLAP)
    .map((finding) => pairOf(finding.details.fromId, finding.details.toId));

/**
 * Computed from the input alone, with no call into the evaluator: every pair
 * whose intervals intersect, and the pairs that are start-order neighbours.
 */
function groundTruth(day) {
  const ordered = [...day].sort(
    (a, b) => a.startMinutes - b.startMinutes || a.id.localeCompare(b.id)
  );
  const overlapping = [];
  for (let i = 0; i < ordered.length; i += 1) {
    for (let j = i + 1; j < ordered.length; j += 1) {
      const [a, b] = [ordered[i], ordered[j]];
      if (a.startMinutes < b.endMinutes && b.startMinutes < a.endMinutes) {
        overlapping.push(pairOf(a.id, b.id));
      }
    }
  }
  const neighbours = ordered.slice(1).map((to, index) => pairOf(ordered[index].id, to.id));
  return { overlapping, neighbours };
}

describe('#62a W8: every overlapping pair of a coach-day is reported', () => {
  const travel = evaluateCoachTravel(DAY, { registry });

  it('has a non-adjacent overlap in its input (meta-assertion, computed from the input)', () => {
    const { overlapping, neighbours } = groundTruth(DAY);
    const nonAdjacent = overlapping.filter((pair) => !neighbours.includes(pair));
    expect(nonAdjacent).toEqual([pairOf('A', 'G')]);
  });

  it('reports the A-G overlap the neighbour pairs hide', () => {
    expect(overlapPairs(travel)).toContain(pairOf('A', 'G'));
    const ag = travel.findings.find(
      (finding) => finding.code === OVERLAP && finding.details.toId === 'G'
    );
    expect(ag?.details.transitionId).toBe(`${PERSON}|${DATE}|A->G`);
    expect(ag?.details.gapMinutes).toBe(-30);
  });

  it('reports exactly the overlapping pairs, each once', () => {
    const { overlapping } = groundTruth(DAY);
    const reported = overlapPairs(travel);
    expect(reported.slice().sort()).toEqual(overlapping.slice().sort());
    expect(new Set(reported).size).toBe(reported.length);
    // No double counting of the adjacent pair: A-B is judged by the neighbour
    // loop and nowhere else.
    expect(reported.filter((pair) => pair === pairOf('A', 'B'))).toHaveLength(1);
    const ids = travel.transitions.map((transition) => transition.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('agrees with the gate, which asks the evaluator one pair at a time (ruleGate.js)', () => {
    // The gate's form: every unordered pair handed over as a two-commitment
    // list, so only the consecutive loop ever runs on it.
    const pairwise = [];
    for (let i = 0; i < DAY.length; i += 1) {
      for (let j = i + 1; j < DAY.length; j += 1) {
        pairwise.push(...overlapPairs(evaluateCoachTravel([DAY[i], DAY[j]], { registry })));
      }
    }
    expect(pairwise).toHaveLength(2);
    expect(overlapPairs(travel).slice().sort()).toEqual(pairwise.slice().sort());
  });

  it('counts every pair for overlap and only the neighbours as transitions', () => {
    expect(travel.meta.overlapPairsCompared).toBe(3);
    expect(travel.meta.transitionsExamined).toBe(2);
    expect(travel.meta.violationsFound).toBe(2);
  });
});

describe('#62a W9: the gap floors stay neighbour-only', () => {
  const a = commitment('A', 'team-t1', 9 * 60, 9 * 60 + 30, 'venue-v1');
  const b = commitment('B', 'team-t2', 9 * 60 + 45, 10 * 60, 'venue-v1');
  const g = commitment('G', 'team-t3', 11 * 60, 12 * 60, 'venue-v2');
  const travel = evaluateCoachTravel([a, b, g], { registry });

  it('judges the two neighbour journeys and never A to G', () => {
    const agId = `${PERSON}|${DATE}|A->G`;
    expect(travel.meta.transitionsJudged).toBe(2);
    expect(travel.transitions.map((transition) => transition.id)).toEqual([
      `${PERSON}|${DATE}|A->B`,
      `${PERSON}|${DATE}|B->G`,
    ]);
    expect(travel.findings.filter((finding) => finding.details.transitionId === agId)).toEqual([]);
    // Every pair was still compared for overlap, and none overlaps.
    expect(travel.meta.overlapPairsCompared).toBe(3);
    expect(overlapPairs(travel)).toEqual([]);
  });
});

describe('#62a W10: an unknown end on a non-adjacent pair is unjudged, never clear', () => {
  const a = { ...A, endMinutes: null };
  const travel = evaluateCoachTravel([a, B, G], { registry });

  it('reports the A-G pair as unjudged', () => {
    const agId = `${PERSON}|${DATE}|A->G`;
    const unjudged = travel.findings.filter(
      (finding) =>
        finding.code === TRAVEL_REASON.TRAVEL_FOOTPRINT_UNKNOWN &&
        finding.details.transitionId === agId
    );
    expect(unjudged).toHaveLength(1);
    expect(unjudged[0].details.commitmentId).toBe('A');
    const transition = travel.transitions.find((entry) => entry.id === agId);
    expect(transition?.gapMinutes).toBeNull();
    // Owned by its transition by reference, as the feasibility callers need.
    expect(transition?.findings).toContain(unjudged[0]);
  });
});

describe('#62a W11: the coach rule and the fairness rule name the same teams', () => {
  const teamIds = ['team-t1', 'team-t2', 'team-t3'];
  const schedule = {
    name: 'p62a synthetic',
    games: DAY.map((entry) => ({
      id: entry.gameId,
      date: DATE,
      startMinutes: entry.startMinutes,
      endMinutes: entry.endMinutes,
      venueId: entry.venueId,
      surfaceId: 'surface-s1',
      homeTeamId: entry.teamId,
      homeLabel: entry.teamId,
    })),
    commitments: DAY,
    // Two rostered coaches each, so the fairness rule counts the conflicts.
    teams: teamIds.map((id) => ({
      id,
      groupLabel: 'U10G',
      personIds: [PERSON, `co-coach-${id}`],
    })),
    teamUniverse: teamIds,
    personUniverse: [PERSON, ...teamIds.map((id) => `co-coach-${id}`)],
    divisionUniverse: [],
    surfaceUniverse: ['surface-s1'],
    venueUniverse: ['venue-v1'],
    placeholderLabels: [],
  };
  const engine = buildRuleEngine({ rules: [coachConflictRule, conflictFairnessRule] });
  const resources = { venueComplexes: EMPTY_VENUE_COMPLEX_MAP };
  const run = runRuleEngine(schedule, { engine, registry, resources });

  it('agree on T1, T2 and T3', () => {
    const teamById = new Map(DAY.map((entry) => [entry.id, entry.teamId]));
    const coachTeams = new Set();
    for (const subject of run.byRuleId[RULE_ID.COACH_CONFLICT].subjects) {
      for (const finding of subject.findings) {
        if (finding.code !== OVERLAP) continue;
        coachTeams.add(teamById.get(finding.details.fromId));
        coachTeams.add(teamById.get(finding.details.toId));
      }
    }
    // Parsed as `runRuleEngine()` parses it, so the rule sees the defaults the
    // engine run above saw. The rule reads only `registry` from its context.
    const fairness = conflictFairnessRule.evaluate(
      ScheduleSchema.parse(schedule),
      /** @type {any} */ ({ registry })
    );
    expect([...coachTeams].sort()).toEqual(teamIds);
    expect(fairness.matched.team).toEqual(teamIds);
    expect(run.byRuleId[RULE_ID.CONFLICT_FAIRNESS].exercise.counters.conflictedTeams).toBe(3);
  });
});

describe('#62a W12: the season-2026 counters are unchanged', () => {
  const travel = evaluateCoachTravel(season.commitments, {
    registry,
    venueComplexes: buildSeason2026VenueComplexMap(),
  });

  it('compares 137 pairs both ways, and no coach-day holds three commitments', () => {
    expect(travel.meta.transitionsExamined).toBe(137);
    expect(travel.meta.overlapPairsCompared).toBe(137);
    // Why the two agree: every pair is a neighbour pair when a coach-day holds
    // at most two commitments. Derived from the corpus, not assumed.
    const perDay = new Map();
    for (const entry of season.commitments) {
      const key = `${entry.personId}|${entry.date}`;
      perDay.set(key, (perDay.get(key) ?? 0) + 1);
    }
    expect(Math.max(...perDay.values())).toBe(2);
    expect(overlapPairs(travel)).toHaveLength(3);
  });
});
