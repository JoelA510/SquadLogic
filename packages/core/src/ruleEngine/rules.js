/**
 * The standing rule set: nine rules covering twelve of the fourteen seeded
 * constraints, and honest about the other two.
 *
 * Every rule here is a **record with an evaluator attached**, not a function
 * somebody has to remember to call. The record carries what it enforces
 * (`constraintIds`), what it may say (`reasonCodes`), why it exists
 * (`rationale`) and — the field this whole prompt is about — what it must have
 * examined before its verdict counts (`exercise`).
 *
 * ## What each rule reuses rather than reimplements
 *
 * Nothing here re-derives a conflict, a permit window, a sunset or a travel
 * gap. The facility overlap decision is `surfacesConflict()`; the whole
 * per-kickoff availability answer is `checkKickoffAvailability()`; the coach
 * travel evaluation is `evaluateCoachTravel()` from Prompt 2.2. A second
 * implementation of any of them is the drift `docs/ARCHITECTURE.md` §1.1
 * documents, and the rule engine is the last place that should start one.
 *
 * The five rules with no Phase 1 evaluator behind them — turnover, round robin,
 * hosting balance, conflict fairness — read their numbers from the **constraint
 * registry** through `resolvePolicy()`, so the 10-minute floor, the 20-minute
 * Orchard Park override, the ±1 opponent spread and the 4-or-5 hosting band
 * exist in exactly one place: the record. Their severity comes from that same
 * record's `type`, so retyping the round-robin constraint to a preference turns
 * every `ROUND_ROBIN_INCOMPLETE` into an `info` with no edit here.
 *
 * ## Which constraints stay unenforced, and why that is reported
 *
 * `kickoff-variety` and `coach-maximum-gap` have no rule. Both are
 * `preference`-typed, which by the registry's own definition means *"optimise
 * toward; no violation concept"* — there is nothing for a validator to report,
 * only a schedule to prefer. The engine says so out loud through
 * `RULE_CONSTRAINT_UNENFORCED` rather than letting them sit in a report looking
 * satisfied, because an engine that reports "all constraints pass" while some
 * of them are unenforceable is incident 4 at the scale of the whole system.
 *
 * @module ruleEngine/rules
 */

import { SEASON_2026_CONSTRAINT_ID } from '../constraints/adapters/season2026Constraints.js';
import { resolvePolicy } from '../constraints/registry.js';
import { checkKickoffAvailability } from '../availability/kickoff.js';
import { AVAILABILITY_REASON } from '../availability/reasonCodes.js';
import { FACILITY_REASON, makeFinding } from '../facility/reasonCodes.js';
import { bookingsOverlapInTime, surfacesConflict } from '../facility/occupancy.js';
import { getSurface } from '../facility/facilityGraph.js';
import { TIMING_REASON } from '../timing/reasonCodes.js';
import { evaluateCoachTravel, TRAVEL_REASON } from '../waivers/coachTravel.js';

import {
  RULE_IDENTIFIER_KIND,
  RULE_VIOLATION_REASON,
  makeViolationFinding,
} from './reasonCodes.js';

/**
 * Stable ids for the standing set, so callers and tests never spell one by hand.
 *
 * @readonly
 * @enum {string}
 */
export const RULE_ID = Object.freeze({
  FIELD_SAME_GROUND: 'field-same-ground',
  FIELD_ADJACENCY: 'field-adjacency',
  FIELD_ELIGIBILITY: 'field-eligibility',
  PERMIT_WINDOW: 'permit-window',
  SUNSET_MARGIN: 'sunset-margin',
  TURNOVER_MINIMUM: 'turnover-minimum',
  COACH_CONFLICT: 'coach-conflict',
  ROUND_ROBIN: 'round-robin',
  HOME_AWAY_BALANCE: 'home-away-balance',
  CONFLICT_FAIRNESS: 'conflict-fairness',
});

/**
 * Fetch a resource the rule cannot work without.
 *
 * Throws rather than returning null, and the engine turns the throw into a
 * `blocking` `RULE_THREW`. A rule that quietly skipped itself because it was
 * handed no facility graph would report zero violations, which is the exact
 * silence this phase exists to break.
 *
 * @param {import('./types.js').RuleContext} context
 * @param {string} name
 * @returns {unknown}
 */
function requireResource(context, name) {
  const resource = context.resources[name];
  if (resource === undefined || resource === null) {
    throw new Error(
      `ruleEngine: rule "${context.rule.id}" needs the "${name}" resource and the run supplied none; it will not skip itself quietly`
    );
  }
  return resource;
}

/**
 * A booking, as the facility module wants one, from a scheduled game.
 *
 * @param {import('./types.js').ScheduledGame} game
 * @returns {Object}
 */
function bookingOf(game) {
  return {
    id: game.id,
    surfaceId: game.surfaceId,
    date: game.date,
    startMinutes: game.startMinutes,
    endMinutes: game.endMinutes,
    format: game.format,
    label: `${game.homeLabel} v ${game.awayLabel}`.trim(),
  };
}

/**
 * The waiver context for one game. Only the fields `WaiverContextSchema`
 * defines, and never a label.
 *
 * @param {import('./types.js').ScheduledGame} game
 * @returns {Object}
 */
function gameContext(game) {
  /** @type {Record<string, unknown>} */
  const context = {
    date: game.date,
    gameId: game.id,
    venueId: game.venueId,
    surfaceId: game.surfaceId,
  };
  const teamIds = [game.homeTeamId, game.awayTeamId].filter(Boolean);
  if (teamIds.length > 0) context.teamIds = teamIds;
  if (game.divisionLabel) context.divisionLabel = game.divisionLabel;
  return context;
}

/**
 * Group games into venue+date buckets, the only buckets a facility conflict can
 * live inside.
 *
 * @param {ReadonlyArray<import('./types.js').ScheduledGame>} games
 * @returns {Map<string, import('./types.js').ScheduledGame[]>}
 */
function bucketByVenueDate(games) {
  /** @type {Map<string, import('./types.js').ScheduledGame[]>} */
  const buckets = new Map();
  for (const game of games) {
    const key = `${game.venueId}\u0000${game.date}`;
    if (!buckets.has(key)) buckets.set(key, []);
    /** @type {import('./types.js').ScheduledGame[]} */ (buckets.get(key)).push(game);
  }
  return buckets;
}

/**
 * Every concurrent pair of games, with the facility module's verdict on whether
 * their ground clashes.
 *
 * Shared by the same-ground and adjacency rules so that "which pairs are
 * concurrent" is decided once, by `bookingsOverlapInTime()`, and each rule only
 * chooses which verdicts are its business.
 *
 * ## Ground the graph does not hold
 *
 * `surfacesConflict()` looks both surfaces up with `requireSurface()`, which
 * throws. A game whose `surfaceId` the graph does not hold therefore took the
 * **whole rule** down: `field-same-ground` and `field-adjacency` both came back
 * `RULE_THREW`, every real clash in the schedule went unreported, and the
 * `OCCUPIED_*` and `OCCUPANCY_FOOTPRINT_UNKNOWN` counts fell to zero — which
 * `verify` and `scenario/diff.js` read as an *improvement*. A blindness that
 * presents as a better schedule is the worst failure mode this package has.
 *
 * The sibling in this same file already reports rather than throws:
 * `scanKickoffs()` runs `checkKickoffAvailability()`, which emits
 * `SURFACE_UNKNOWN` and carries on, and `field-eligibility` owns that code. So
 * this scan reports too. Two consequences are deliberate:
 *
 * - The unjudgeable games come back on `unknownSurface`, and **both** rules
 *   publish `SURFACE_UNKNOWN` against them naming the check that went unrun.
 *   `field-eligibility`'s finding says the ground is unfit; theirs say the
 *   concurrency question was never asked. `RULE_MATCHED_UNKNOWN_IDENTIFIER` does
 *   not cover it: `toSeason2026Schedule()` derives `surfaceUniverse` from the
 *   games themselves, so a bad surface id is inside its own universe and the
 *   exercise judge says nothing about it.
 * - `concurrentPairs` and `concurrentCrossSurfacePairs` count only pairs that
 *   actually reached `surfacesConflict()`. Both rules' exercise minimums are
 *   written on those counters, so a schedule whose every concurrent pair stands
 *   on unknown ground fails `RULE_EXERCISE_BELOW_MINIMUM` at blocking rather
 *   than reporting a clean bill for work it did not do.
 *
 * @param {Object} graph
 * @param {ReadonlyArray<import('./types.js').ScheduledGame>} games
 * @returns {{ pairs: Array<{ a: import('./types.js').ScheduledGame, b: import('./types.js').ScheduledGame, code: string|null, sameSurface: boolean }>, unknownFootprint: import('./types.js').ScheduledGame[], unknownSurface: import('./types.js').ScheduledGame[], pairsCompared: number, concurrentPairs: number, concurrentCrossSurfacePairs: number, pairsUnjudgedUnknownSurface: number, surfaceIds: Set<string> }}
 */
function scanConcurrency(graph, games) {
  /** @type {Array<{ a: import('./types.js').ScheduledGame, b: import('./types.js').ScheduledGame, code: string|null, sameSurface: boolean }>} */
  const pairs = [];
  /** @type {import('./types.js').ScheduledGame[]} */
  const unknownFootprint = [];
  /** @type {import('./types.js').ScheduledGame[]} */
  const unknownSurface = [];
  const surfaceIds = new Set();
  let pairsCompared = 0;
  let concurrentPairs = 0;
  let concurrentCrossSurfacePairs = 0;
  let pairsUnjudgedUnknownSurface = 0;

  for (const game of games) {
    surfaceIds.add(game.surfaceId);
    if (game.endMinutes === null) unknownFootprint.push(game);
    if (!getSurface(/** @type {any} */ (graph), game.surfaceId)) unknownSurface.push(game);
  }
  const unknownSurfaceIds = new Set(unknownSurface.map((game) => game.surfaceId));

  for (const bucket of bucketByVenueDate(games).values()) {
    for (let i = 0; i < bucket.length; i += 1) {
      for (let j = i + 1; j < bucket.length; j += 1) {
        const a = bucket[i];
        const b = bucket[j];
        pairsCompared += 1;
        // `null` means an unknown footprint; that game is reported separately
        // and inventing a verdict for it would hide the gap (GAP-14).
        if (bookingsOverlapInTime(bookingOf(a), bookingOf(b)) !== true) continue;
        // Concurrent, and one of them stands on ground the graph does not hold,
        // so whether they share it cannot be decided. Counted and reported, not
        // thrown and not waved through — see this function's own doc-comment.
        if (unknownSurfaceIds.has(a.surfaceId) || unknownSurfaceIds.has(b.surfaceId)) {
          pairsUnjudgedUnknownSurface += 1;
          continue;
        }
        concurrentPairs += 1;
        const sameSurface = a.surfaceId === b.surfaceId;
        if (!sameSurface) concurrentCrossSurfacePairs += 1;
        const verdict = surfacesConflict(graph, a.surfaceId, b.surfaceId);
        pairs.push({ a, b, code: verdict.code, sameSurface });
      }
    }
  }

  return {
    pairs,
    unknownFootprint,
    unknownSurface,
    pairsCompared,
    concurrentPairs,
    concurrentCrossSurfacePairs,
    pairsUnjudgedUnknownSurface,
    surfaceIds,
  };
}

/**
 * A conflict finding for one pair, carrying both sides and their clock times so
 * the violation can render "10:00-11:30 against 11:00-12:30" without anybody
 * parsing a message.
 *
 * @param {string} code
 * @param {import('./types.js').ScheduledGame} a
 * @param {import('./types.js').ScheduledGame} b
 * @param {string} surfaceAName
 * @param {string} surfaceBName
 * @returns {import('./types.js').RuleFinding}
 */
function pairFinding(code, a, b, surfaceAName, surfaceBName) {
  return /** @type {import('./types.js').RuleFinding} */ (
    makeFinding(
      code,
      `${a.id} on ${surfaceAName} and ${b.id} on ${surfaceBName} are concurrent on ${a.date} and share ground`,
      {
        bookingAId: a.id,
        bookingBId: b.id,
        surfaceAId: a.surfaceId,
        surfaceBId: b.surfaceId,
        date: a.date,
        startAMinutes: a.startMinutes,
        endAMinutes: a.endMinutes,
        startBMinutes: b.startMinutes,
        endBMinutes: b.endMinutes,
        venueId: a.venueId,
      }
    )
  );
}

/**
 * "This game stands on ground the graph does not hold, so the check below never
 * ran on it."
 *
 * `facility/`'s own code, built by `facility/`'s own `makeFinding()`, so the
 * severity comes from the one table that owns it. Both concurrency rules emit
 * it, each naming its own unrun check: an operator told only that the ground is
 * unfit (which is `field-eligibility`'s finding) would not know that the
 * same-ground and adjacency questions were never asked about this row.
 *
 * @param {string} ruleId
 * @param {import('./types.js').ScheduledGame} game
 * @param {string} unrun - what could not be decided, in words
 * @returns {import('./types.js').RuleFinding}
 */
function unknownGroundFinding(ruleId, game, unrun) {
  return /** @type {import('./types.js').RuleFinding} */ (
    makeFinding(
      FACILITY_REASON.SURFACE_UNKNOWN,
      `${game.id} names surface "${game.surfaceId}", which is not in the graph, so ${unrun}`,
      {
        ruleId,
        bookingId: game.id,
        surfaceId: game.surfaceId,
        venueId: game.venueId,
        date: game.date,
        startMinutes: game.startMinutes,
      }
    )
  );
}

/**
 * One subject per game, carrying the findings that landed on it.
 *
 * @param {string} ruleId
 * @param {import('./types.js').ScheduledGame} game
 * @param {import('./types.js').RuleFinding[]} findings
 * @returns {import('../waivers/types.js').WaiverSubject}
 */
function gameSubject(ruleId, game, findings) {
  return {
    id: `${ruleId}::${game.id}`,
    context: /** @type {import('../waivers/types.js').WaiverContext} */ (gameContext(game)),
    findings,
    details: {
      ruleId,
      gameId: game.id,
      date: game.date,
      venueId: game.venueId,
      surfaceId: game.surfaceId,
      format: game.format,
      divisionLabel: game.divisionLabel,
      entities: entitiesOfGame(game),
    },
  };
}

/**
 * The entities a game-shaped violation involves.
 *
 * Ids only, never labels: a violation that names `Select Game 7` as a team is
 * the phantom incident 4's second checker reported.
 *
 * @param {import('./types.js').ScheduledGame} game
 * @returns {Array<{ kind: string, id: string }>}
 */
function entitiesOfGame(game) {
  /** @type {Array<{ kind: string, id: string }>} */
  const entities = [
    { kind: RULE_IDENTIFIER_KIND.GAME, id: game.id },
    { kind: RULE_IDENTIFIER_KIND.SURFACE, id: game.surfaceId },
    { kind: RULE_IDENTIFIER_KIND.VENUE, id: game.venueId },
    { kind: RULE_IDENTIFIER_KIND.DATE, id: game.date },
  ];
  if (game.homeTeamId) entities.push({ kind: RULE_IDENTIFIER_KIND.TEAM, id: game.homeTeamId });
  if (game.awayTeamId) entities.push({ kind: RULE_IDENTIFIER_KIND.TEAM, id: game.awayTeamId });
  return entities;
}

/**
 * Every team id a set of games actually names, ignoring labels entirely.
 *
 * @param {ReadonlyArray<import('./types.js').ScheduledGame>} games
 * @returns {string[]}
 */
function teamIdsOf(games) {
  const ids = new Set();
  for (const game of games) {
    if (game.homeTeamId) ids.add(game.homeTeamId);
    if (game.awayTeamId) ids.add(game.awayTeamId);
  }
  return [...ids].sort();
}

/**
 * The teams the **roster** puts in each division, whether or not any row names
 * them.
 *
 * The counterweight to {@link teamIdsOf}. A rule whose subject set comes only
 * from the games cannot report a team the games lost: a team-name format change
 * drops it from every row, it plays 0 of 9, and it is absent from the analysis
 * rather than reported by it — incident 4, inside the machinery built to
 * prevent incident 4.
 *
 * @param {import('./types.js').Schedule} schedule
 * @returns {Map<string, string[]>}
 */
function rosteredTeamIdsByDivision(schedule) {
  /** @type {Map<string, string[]>} */
  const byDivision = new Map();
  for (const team of schedule.teams) {
    if (team.divisionLabel === null) continue;
    if (!byDivision.has(team.divisionLabel)) byDivision.set(team.divisionLabel, []);
    /** @type {string[]} */ (byDivision.get(team.divisionLabel)).push(team.id);
  }
  for (const ids of byDivision.values()) ids.sort();
  return byDivision;
}

/**
 * Run one per-kickoff availability check for every game and keep only the codes
 * the calling rule owns.
 *
 * @param {import('./types.js').RuleContext} context
 * @param {import('./types.js').Schedule} schedule
 * @param {ReadonlySet<string>} codes
 * @returns {{ subjects: Array<import('../waivers/types.js').WaiverSubject>, counters: Record<string, number>, matched: Record<string, string[]>, litCount: number, unlitCount: number, undeclaredCount: number, lightingNotConsultedCount: number, permitWindowsConsulted: number }}
 */
function scanKickoffs(context, schedule, codes) {
  const graph = requireResource(context, 'graph');
  const table = requireResource(context, 'timingTable');
  const calendar = requireResource(context, 'calendar');
  /** @type {Array<import('../waivers/types.js').WaiverSubject>} */
  const subjects = [];
  const surfaceIds = new Set();
  let litCount = 0;
  let unlitCount = 0;
  let undeclaredCount = 0;
  let lightingNotConsultedCount = 0;
  let permitWindowsConsulted = 0;

  for (const game of schedule.games) {
    surfaceIds.add(game.surfaceId);
    const result = checkKickoffAvailability(
      /** @type {any} */ (graph),
      /** @type {any} */ (table),
      /** @type {any} */ (calendar),
      {
        surfaceId: game.surfaceId,
        date: game.date,
        kickoffMinutes: game.startMinutes,
        format: game.format,
        ignoreBookingIds: [],
      },
      // Concurrency is the same-ground and adjacency rules' business, and doing
      // it here as well would report every clash twice.
      { existingBookings: [] }
    );
    // `lit` is tri-state (GAP-05), and there are **four** answers here, not
    // three. `lit === null` covers two of them and they are not the same fact:
    //
    // - `lighting !== null` -- the reading was taken and the graph states
    //   nothing. That is declared-absent lighting, `LIGHTING_UNDECLARED`, and
    //   the exercise counter the sunset rule reports.
    // - `lighting === null` -- no reading was taken at all, because the answer
    //   returned before `resolveLighting()` ran. In
    //   `checkKickoffAvailability()` that is the unknown-surface return and
    //   only that one: a format with no timing row carries on and *is* read
    //   (its sibling `latestLegalKickoff()` does return early there, which is
    //   why the template carries `null` rather than a guess). Counting these
    //   as undeclared would be a counter claiming exercise it did not do: the
    //   rule would clear its own floor on games it never looked at, which is
    //   the shape the floor exists to catch.
    //
    // `result.lighting` is the reading itself and is `null` in exactly the
    // early-return templates, so it is what separates them.
    if (result.lighting === null) lightingNotConsultedCount += 1;
    else if (result.lit === true) litCount += 1;
    else if (result.lit === false) unlitCount += 1;
    else undeclaredCount += 1;
    permitWindowsConsulted += result.meta.permitWindowsConsulted;

    const mine = result.findings.filter((finding) => codes.has(finding.code));
    if (mine.length > 0) {
      subjects.push(
        gameSubject(context.rule.id, game, /** @type {import('./types.js').RuleFinding[]} */ (mine))
      );
    }
  }

  return {
    subjects,
    counters: {
      gamesExamined: schedule.games.length,
      surfacesExamined: surfaceIds.size,
    },
    matched: {
      [RULE_IDENTIFIER_KIND.GAME]: schedule.games.map((game) => game.id),
      [RULE_IDENTIFIER_KIND.SURFACE]: [...surfaceIds].sort(),
    },
    litCount,
    unlitCount,
    undeclaredCount,
    lightingNotConsultedCount,
    permitWindowsConsulted,
  };
}

/* -------------------------------------------------------------------------- */
/* The rules                                                                   */
/* -------------------------------------------------------------------------- */

/** One patch of ground holds one game. */
export const fieldSameGroundRule = Object.freeze({
  id: RULE_ID.FIELD_SAME_GROUND,
  title: 'One patch of ground holds one game',
  constraintIds: [SEASON_2026_CONSTRAINT_ID.FIELD_SAME_GROUND_EXCLUSIVE],
  reasonCodes: [
    FACILITY_REASON.OCCUPIED_SAME_SURFACE,
    FACILITY_REASON.OCCUPIED_PARENT_CHILD,
    FACILITY_REASON.OCCUPANCY_FOOTPRINT_UNKNOWN,
    FACILITY_REASON.SURFACE_UNKNOWN,
  ],
  rationale:
    'Two games on the identical surface, or on a pitch and one of its own halves, cannot both be played. The verdict comes from the Phase 1.1 facility graph; this rule only decides which of its answers belong to this constraint.',
  exercise: {
    minimums: { concurrentPairsCompared: 1, gamesExamined: 1 },
    coverage: {},
    identifierKinds: [RULE_IDENTIFIER_KIND.SURFACE, RULE_IDENTIFIER_KIND.GAME],
    rationale:
      'A same-ground check that compared no concurrent pair proves nothing about the schedule; it proves that the schedule was never read.',
  },
  /**
   * @param {import('./types.js').Schedule} schedule
   * @param {import('./types.js').RuleContext} context
   * @returns {import('./types.js').RuleOutput}
   */
  evaluate(schedule, context) {
    const graph = requireResource(context, 'graph');
    const scan = scanConcurrency(graph, schedule.games);
    /** @type {Map<string, import('./types.js').RuleFinding[]>} */
    const byGameId = new Map();
    const push = (game, finding) => {
      if (!byGameId.has(game.id)) byGameId.set(game.id, []);
      /** @type {import('./types.js').RuleFinding[]} */ (byGameId.get(game.id)).push(finding);
    };

    for (const pair of scan.pairs) {
      if (
        pair.code !== FACILITY_REASON.OCCUPIED_SAME_SURFACE &&
        pair.code !== FACILITY_REASON.OCCUPIED_PARENT_CHILD
      ) {
        continue;
      }
      const finding = pairFinding(
        pair.code,
        pair.a,
        pair.b,
        getSurface(/** @type {any} */ (graph), pair.a.surfaceId)?.name ?? pair.a.surfaceId,
        getSurface(/** @type {any} */ (graph), pair.b.surfaceId)?.name ?? pair.b.surfaceId
      );
      push(pair.a, finding);
    }

    for (const game of scan.unknownSurface) {
      push(
        game,
        unknownGroundFinding(
          RULE_ID.FIELD_SAME_GROUND,
          game,
          'whether it stands on the same patch of ground as anything else could not be decided'
        )
      );
    }

    for (const game of scan.unknownFootprint) {
      push(
        game,
        /** @type {import('./types.js').RuleFinding} */ (
          makeFinding(
            FACILITY_REASON.OCCUPANCY_FOOTPRINT_UNKNOWN,
            `${game.id} has no known end time, so whether it shares ground with anything cannot be decided`,
            {
              bookingId: game.id,
              surfaceId: game.surfaceId,
              venueId: game.venueId,
              date: game.date,
              startMinutes: game.startMinutes,
              format: game.format,
            }
          )
        )
      );
    }

    const gamesById = new Map(schedule.games.map((game) => [game.id, game]));
    const subjects = [...byGameId.entries()].map(([gameId, findings]) =>
      gameSubject(
        RULE_ID.FIELD_SAME_GROUND,
        /** @type {import('./types.js').ScheduledGame} */ (gamesById.get(gameId)),
        findings
      )
    );

    return {
      subjects,
      findings: [],
      counters: {
        gamesExamined: schedule.games.length,
        gamePairsCompared: scan.pairsCompared,
        concurrentPairsCompared: scan.concurrentPairs,
        unknownFootprintGames: scan.unknownFootprint.length,
        unknownSurfaceGames: scan.unknownSurface.length,
        concurrentPairsUnjudgedUnknownSurface: scan.pairsUnjudgedUnknownSurface,
      },
      matched: {
        [RULE_IDENTIFIER_KIND.SURFACE]: [...scan.surfaceIds].sort(),
        [RULE_IDENTIFIER_KIND.GAME]: schedule.games.map((game) => game.id),
      },
    };
  },
});

/** Overlapping fields may not host concurrent games. */
export const fieldAdjacencyRule = Object.freeze({
  id: RULE_ID.FIELD_ADJACENCY,
  title: 'Overlapping fields may not host concurrent games',
  constraintIds: [SEASON_2026_CONSTRAINT_ID.FIELD_OVERLAP_ADJACENCY],
  reasonCodes: [FACILITY_REASON.OCCUPIED_SPATIAL_OVERLAP, FACILITY_REASON.SURFACE_UNKNOWN],
  rationale:
    'Alder Park pitches 2 and 3 physically overlap 1 and 4, halves included. Incident 3 is the version of this rule that arrived mid-project, after several schedule versions had modelled the fields as independent strings.',
  exercise: {
    minimums: { concurrentFieldPairsCompared: 1, overlapPairsInGraph: 1 },
    coverage: {},
    identifierKinds: [RULE_IDENTIFIER_KIND.SURFACE, RULE_IDENTIFIER_KIND.GAME],
    rationale:
      'The build plan names this one: "the adjacency rule must assert it compared > 0 concurrent field pairs". Two distinct fields must actually have been concurrent for the rule to have had anything to say — and the graph must actually hold an overlap pair, or the rule is asking a question the geometry cannot answer.',
  },
  /**
   * @param {import('./types.js').Schedule} schedule
   * @param {import('./types.js').RuleContext} context
   * @returns {import('./types.js').RuleOutput}
   */
  evaluate(schedule, context) {
    const graph = requireResource(context, 'graph');
    const scan = scanConcurrency(graph, schedule.games);
    /** @type {Map<string, import('./types.js').RuleFinding[]>} */
    const byGameId = new Map();

    for (const pair of scan.pairs) {
      if (pair.code !== FACILITY_REASON.OCCUPIED_SPATIAL_OVERLAP) continue;
      const finding = pairFinding(
        pair.code,
        pair.a,
        pair.b,
        getSurface(/** @type {any} */ (graph), pair.a.surfaceId)?.name ?? pair.a.surfaceId,
        getSurface(/** @type {any} */ (graph), pair.b.surfaceId)?.name ?? pair.b.surfaceId
      );
      if (!byGameId.has(pair.a.id)) byGameId.set(pair.a.id, []);
      /** @type {import('./types.js').RuleFinding[]} */ (byGameId.get(pair.a.id)).push(finding);
    }

    for (const game of scan.unknownSurface) {
      if (!byGameId.has(game.id)) byGameId.set(game.id, []);
      /** @type {import('./types.js').RuleFinding[]} */ (byGameId.get(game.id)).push(
        unknownGroundFinding(
          RULE_ID.FIELD_ADJACENCY,
          game,
          'whether it overlaps ground another game is using at the same minute could not be decided'
        )
      );
    }

    const gamesById = new Map(schedule.games.map((game) => [game.id, game]));
    const subjects = [...byGameId.entries()].map(([gameId, findings]) =>
      gameSubject(
        RULE_ID.FIELD_ADJACENCY,
        /** @type {import('./types.js').ScheduledGame} */ (gamesById.get(gameId)),
        findings
      )
    );

    const declaredOverlaps = /** @type {{ overlapPairs?: unknown }} */ (graph).overlapPairs;
    const overlapPairsInGraph = Array.isArray(declaredOverlaps) ? declaredOverlaps.length : 0;

    return {
      subjects,
      findings: [],
      counters: {
        gamesExamined: schedule.games.length,
        concurrentPairsCompared: scan.concurrentPairs,
        concurrentFieldPairsCompared: scan.concurrentCrossSurfacePairs,
        overlapPairsInGraph,
        unknownSurfaceGames: scan.unknownSurface.length,
        concurrentPairsUnjudgedUnknownSurface: scan.pairsUnjudgedUnknownSurface,
      },
      matched: {
        [RULE_IDENTIFIER_KIND.SURFACE]: [...scan.surfaceIds].sort(),
        [RULE_IDENTIFIER_KIND.GAME]: schedule.games.map((game) => game.id),
      },
    };
  },
});

/** Every code the eligibility rule owns. */
const ELIGIBILITY_CODES = Object.freeze(
  new Set([
    FACILITY_REASON.SURFACE_UNKNOWN,
    FACILITY_REASON.SURFACE_NOT_BOOKABLE,
    FACILITY_REASON.SIZE_TOO_SMALL,
    FACILITY_REASON.SIZE_NOT_DECLARED,
    FACILITY_REASON.SIZE_UNKNOWN_FORMAT,
    FACILITY_REASON.SIZE_UNDECLARED,
    FACILITY_REASON.LINING_MISMATCH,
    FACILITY_REASON.LINING_UNDECLARED,
    FACILITY_REASON.EQUIPMENT_UNAVAILABLE,
    FACILITY_REASON.EQUIPMENT_STATUS_UNKNOWN,
    TIMING_REASON.FORMAT_TIMING_UNDEFINED,
  ])
);

/**
 * Is the ground fit for the format at all?
 *
 * The one rule in the set that enforces **no** registry constraint, and that is
 * reported rather than hidden: Phase 1 checks size, line markings, equipment
 * and format timing, and the club never wrote a constraint record about any of
 * them. Inventing one to make the coverage table symmetric would be exactly the
 * fabrication the constraint adapter refuses.
 */
export const fieldEligibilityRule = Object.freeze({
  id: RULE_ID.FIELD_ELIGIBILITY,
  title: 'The ground is fit for the format being played on it',
  constraintIds: [],
  reasonCodes: [...ELIGIBILITY_CODES],
  rationale:
    'Size, line markings, equipment and format timing are Phase 1 answers with no constraint record behind them. The rule reports them so they are visible, and declares that it enforces no constraint so nobody reads its silence as a board policy being met.',
  exercise: {
    minimums: { gamesExamined: 1, surfacesExamined: 1 },
    coverage: {},
    identifierKinds: [RULE_IDENTIFIER_KIND.SURFACE, RULE_IDENTIFIER_KIND.GAME],
    rationale:
      'Eligibility is decided per row, so the only vacuity that matters is a run that read no rows or touched no ground.',
  },
  /**
   * @param {import('./types.js').Schedule} schedule
   * @param {import('./types.js').RuleContext} context
   * @returns {import('./types.js').RuleOutput}
   */
  evaluate(schedule, context) {
    const scan = scanKickoffs(context, schedule, ELIGIBILITY_CODES);
    return {
      subjects: scan.subjects,
      findings: [],
      counters: scan.counters,
      matched: scan.matched,
    };
  },
});

/** Every code the permit rule owns. */
const PERMIT_CODES = Object.freeze(
  new Set([
    AVAILABILITY_REASON.PERMIT_BLACKOUT,
    AVAILABILITY_REASON.PERMIT_OPEN_PRECEDED,
    AVAILABILITY_REASON.PERMIT_CLOSE_EXCEEDED,
    AVAILABILITY_REASON.PERMIT_MARGIN_TIGHT,
    AVAILABILITY_REASON.PERMIT_UNDECLARED,
  ])
);

/** Games sit inside their venue permit. */
export const permitWindowRule = Object.freeze({
  id: RULE_ID.PERMIT_WINDOW,
  title: 'Games sit inside their venue permit',
  constraintIds: [SEASON_2026_CONSTRAINT_ID.PERMIT_WINDOW],
  reasonCodes: [...PERMIT_CODES],
  rationale:
    'A game outside the permit window is a game on ground the club has no right to use, including the blackout date where the permit is absent entirely. The window comes from the Phase 1.3 availability calendar.',
  exercise: {
    minimums: { gamesExamined: 1, permitWindowsConsulted: 1 },
    coverage: {},
    identifierKinds: [RULE_IDENTIFIER_KIND.SURFACE, RULE_IDENTIFIER_KIND.GAME],
    rationale:
      'A permit check that consulted no permit window has not checked a permit. The counter comes from the availability module’s own meta, so a calendar that had quietly lost its rows fails here rather than passing everything.',
  },
  /**
   * @param {import('./types.js').Schedule} schedule
   * @param {import('./types.js').RuleContext} context
   * @returns {import('./types.js').RuleOutput}
   */
  evaluate(schedule, context) {
    const scan = scanKickoffs(context, schedule, PERMIT_CODES);
    return {
      subjects: scan.subjects,
      findings: [],
      counters: { ...scan.counters, permitWindowsConsulted: scan.permitWindowsConsulted },
      matched: scan.matched,
    };
  },
});

/** Every code the sunset rule owns. */
const SUNSET_CODES = Object.freeze(
  new Set([
    AVAILABILITY_REASON.SUNSET_MARGIN_VIOLATED,
    AVAILABILITY_REASON.SUNSET_UNKNOWN,
    AVAILABILITY_REASON.LIGHTS_OFF_EXCEEDED,
    // Ground nobody has declared lit or unlit is the sunset rule's business:
    // it is bound as unlit, and the report must say the bound rests on an
    // absence. Declared is not enforced until a rule claims it.
    AVAILABILITY_REASON.LIGHTING_UNDECLARED,
  ])
);

/** Unlit games finish before dusk. */
export const sunsetMarginRule = Object.freeze({
  id: RULE_ID.SUNSET_MARGIN,
  title: 'Unlit games finish before dusk',
  constraintIds: [SEASON_2026_CONSTRAINT_ID.SUNSET_MARGIN],
  reasonCodes: [...SUNSET_CODES],
  rationale:
    'On unlit ground a game must be over fifteen minutes before sunset. The margin is the safety, not the sunset itself.',
  exercise: {
    minimums: { gamesExamined: 1, unlitGamesExamined: 1 },
    coverage: {},
    identifierKinds: [RULE_IDENTIFIER_KIND.SURFACE, RULE_IDENTIFIER_KIND.GAME],
    rationale:
      'The sunset margin binds only on unlit ground, so a run in which every game was lit has not exercised this rule at all — and a lighting table that had quietly turned every surface lit would otherwise produce a flawless, meaningless pass.',
  },
  /**
   * @param {import('./types.js').Schedule} schedule
   * @param {import('./types.js').RuleContext} context
   * @returns {import('./types.js').RuleOutput}
   */
  evaluate(schedule, context) {
    const scan = scanKickoffs(context, schedule, SUNSET_CODES);
    return {
      subjects: scan.subjects,
      findings: [],
      counters: {
        ...scan.counters,
        litGamesExamined: scan.litCount,
        unlitGamesExamined: scan.unlitCount,
        lightingUndeclaredGamesExamined: scan.undeclaredCount,
        // The fourth bucket, so the four sum to `gamesExamined`. A game whose
        // lighting was never consulted proves nothing about lighting and is
        // counted where that is visible rather than folded into "undeclared".
        lightingNotConsultedGamesExamined: scan.lightingNotConsultedCount,
      },
      matched: scan.matched,
    };
  },
});

/** Turnover between two games on one field. */
export const turnoverMinimumRule = Object.freeze({
  id: RULE_ID.TURNOVER_MINIMUM,
  title: 'Turnover between consecutive games on one field',
  constraintIds: [
    SEASON_2026_CONSTRAINT_ID.TURNOVER_FLOOR_GLOBAL,
    SEASON_2026_CONSTRAINT_ID.TURNOVER_PREFERRED_GLOBAL,
    SEASON_2026_CONSTRAINT_ID.TURNOVER_ORCHARD_PARK,
  ],
  reasonCodes: [
    RULE_VIOLATION_REASON.TURNOVER_BELOW_MINIMUM,
    RULE_VIOLATION_REASON.TURNOVER_UNJUDGED,
    RULE_VIOLATION_REASON.TURNOVER_UNGOVERNED,
  ],
  rationale:
    'GAP-12 in one rule: the floor is 10 minutes everywhere, 20 is what the club aims for, and at Orchard Park the 20 is inviolable because the car park cannot clear one wave of families before the next arrives. The rule holds none of those numbers — it asks the registry, per venue, per date.',
  exercise: {
    minimums: { consecutivePairsCompared: 1, policiesResolved: 1 },
    coverage: {},
    identifierKinds: [RULE_IDENTIFIER_KIND.SURFACE],
    rationale:
      'Turnover is a property of a consecutive pair on one surface. A run that found no such pair has not measured a turnover, and a run that resolved no policy is applying a number nobody wrote down.',
  },
  /**
   * @param {import('./types.js').Schedule} schedule
   * @param {import('./types.js').RuleContext} context
   * @returns {import('./types.js').RuleOutput}
   */
  evaluate(schedule, context) {
    /** @type {Map<string, import('./types.js').ScheduledGame[]>} */
    const bySurfaceDate = new Map();
    const surfaceIds = new Set();
    for (const game of schedule.games) {
      surfaceIds.add(game.surfaceId);
      const key = `${game.surfaceId}\u0000${game.date}`;
      if (!bySurfaceDate.has(key)) bySurfaceDate.set(key, []);
      /** @type {import('./types.js').ScheduledGame[]} */ (bySurfaceDate.get(key)).push(game);
    }

    /** @type {Array<import('../waivers/types.js').WaiverSubject>} */
    const subjects = [];
    let consecutivePairsCompared = 0;
    let policiesResolved = 0;
    /** @type {Map<string, import('../constraints/types.js').ResolvedPolicy>} */
    const cache = new Map();

    for (const bucket of [...bySurfaceDate.values()]) {
      const ordered = [...bucket].sort((a, b) =>
        a.startMinutes === b.startMinutes
          ? a.id.localeCompare(b.id)
          : a.startMinutes - b.startMinutes
      );
      for (let index = 0; index < ordered.length - 1; index += 1) {
        const earlier = ordered[index];
        const later = ordered[index + 1];
        consecutivePairsCompared += 1;
        /** @type {import('./types.js').RuleFinding[]} */
        const findings = [];

        if (earlier.endMinutes === null) {
          findings.push(
            makeViolationFinding(
              RULE_VIOLATION_REASON.TURNOVER_UNJUDGED,
              `${earlier.id} has no known end, so the turnover before ${later.id} on ${earlier.date} cannot be measured`,
              {
                earlierGameId: earlier.id,
                laterGameId: later.id,
                surfaceId: earlier.surfaceId,
                venueId: earlier.venueId,
                date: earlier.date,
              }
            )
          );
          subjects.push(turnoverSubject(earlier, later, null, null, null, findings));
          continue;
        }

        const key = `${earlier.venueId}\u0000${earlier.surfaceId}\u0000${earlier.date}`;
        let resolved = cache.get(key);
        if (!resolved) {
          resolved = resolvePolicy(context.registry, 'turnover-minimum', {
            date: earlier.date,
            venueId: earlier.venueId,
            surfaceId: earlier.surfaceId,
          });
          cache.set(key, resolved);
          policiesResolved += 1;
        }

        const gapMinutes = later.startMinutes - earlier.endMinutes;
        const record = resolved.effective;
        const minimum =
          record && typeof record.parameters.minimumGapMinutes === 'number'
            ? record.parameters.minimumGapMinutes
            : null;

        if (minimum === null) {
          findings.push(
            makeViolationFinding(
              RULE_VIOLATION_REASON.TURNOVER_UNGOVERNED,
              `no constraint record gives policy "turnover-minimum" a number at ${earlier.venueId} on ${earlier.date}, so the ${gapMinutes}-minute turnover cannot be judged`,
              {
                earlierGameId: earlier.id,
                laterGameId: later.id,
                surfaceId: earlier.surfaceId,
                venueId: earlier.venueId,
                date: earlier.date,
                gapMinutes,
              }
            )
          );
        } else if (gapMinutes < minimum) {
          findings.push(
            makeViolationFinding(
              RULE_VIOLATION_REASON.TURNOVER_BELOW_MINIMUM,
              `${earlier.id} and ${later.id} sit ${gapMinutes} minutes apart on ${earlier.surfaceId}; "${record.id}" requires ${minimum}`,
              {
                earlierGameId: earlier.id,
                laterGameId: later.id,
                surfaceId: earlier.surfaceId,
                venueId: earlier.venueId,
                date: earlier.date,
                gapMinutes,
                minimumGapMinutes: minimum,
                shortfallMinutes: minimum - gapMinutes,
                constraintId: record.id,
                constraintType: record.type,
              },
              record
            )
          );
        }

        if (findings.length > 0) {
          subjects.push(
            turnoverSubject(earlier, later, gapMinutes, minimum, record?.id ?? null, findings)
          );
        }
      }
    }

    return {
      subjects,
      findings: [],
      counters: {
        surfaceDatesExamined: bySurfaceDate.size,
        consecutivePairsCompared,
        policiesResolved,
      },
      matched: { [RULE_IDENTIFIER_KIND.SURFACE]: [...surfaceIds].sort() },
    };
  },
});

/**
 * The subject standing for one turnover between two games.
 *
 * @param {import('./types.js').ScheduledGame} earlier
 * @param {import('./types.js').ScheduledGame} later
 * @param {number|null} gapMinutes
 * @param {number|null} minimumGapMinutes
 * @param {string|null} constraintId
 * @param {import('./types.js').RuleFinding[]} findings
 * @returns {import('../waivers/types.js').WaiverSubject}
 */
function turnoverSubject(earlier, later, gapMinutes, minimumGapMinutes, constraintId, findings) {
  return {
    id: `${RULE_ID.TURNOVER_MINIMUM}::${earlier.id}->${later.id}`,
    context: /** @type {import('../waivers/types.js').WaiverContext} */ ({
      date: earlier.date,
      venueId: earlier.venueId,
      surfaceId: earlier.surfaceId,
      gameIds: [earlier.id, later.id].sort(),
    }),
    findings,
    details: {
      ruleId: RULE_ID.TURNOVER_MINIMUM,
      date: earlier.date,
      gapMinutes,
      minimumGapMinutes,
      constraintId,
      entities: [
        { kind: RULE_IDENTIFIER_KIND.GAME, id: earlier.id },
        { kind: RULE_IDENTIFIER_KIND.GAME, id: later.id },
        { kind: RULE_IDENTIFIER_KIND.SURFACE, id: earlier.surfaceId },
        { kind: RULE_IDENTIFIER_KIND.VENUE, id: earlier.venueId },
        { kind: RULE_IDENTIFIER_KIND.DATE, id: earlier.date },
      ],
    },
  };
}

/**
 * A coach cannot be in two places at once, and needs time to get between two.
 *
 * **The rule the build plan names first**: *"the coach rule must assert it
 * evaluated > 0 person-pairs"*. A team-name format change is exactly what makes
 * that count zero, and `tests/ruleEngine.test.js` breaks the join on purpose to
 * prove the engine says so.
 */
export const coachConflictRule = Object.freeze({
  id: RULE_ID.COACH_CONFLICT,
  title: 'A coach can be in one place at a time, and needs time to reach the next',
  constraintIds: [
    SEASON_2026_CONSTRAINT_ID.COACH_TRAVEL_BETWEEN_VENUES,
    SEASON_2026_CONSTRAINT_ID.COACH_TRAVEL_WITHIN_VENUE,
  ],
  reasonCodes: [
    TRAVEL_REASON.TRAVEL_BETWEEN_VENUES_TOO_SHORT,
    TRAVEL_REASON.TRAVEL_WITHIN_VENUE_TOO_SHORT,
    TRAVEL_REASON.TRAVEL_WITHIN_COMPLEX_CROSS_VENUE,
    TRAVEL_REASON.TRAVEL_COMMITMENTS_OVERLAP,
    TRAVEL_REASON.TRAVEL_FOOTPRINT_UNKNOWN,
    TRAVEL_REASON.TRAVEL_POLICY_UNGOVERNED,
    TRAVEL_REASON.TRAVEL_SCAN_VACUOUS,
  ],
  constraintIdByCode: {
    [TRAVEL_REASON.TRAVEL_BETWEEN_VENUES_TOO_SHORT]: [
      SEASON_2026_CONSTRAINT_ID.COACH_TRAVEL_BETWEEN_VENUES,
    ],
    [TRAVEL_REASON.TRAVEL_WITHIN_VENUE_TOO_SHORT]: [
      SEASON_2026_CONSTRAINT_ID.COACH_TRAVEL_WITHIN_VENUE,
    ],
    // Deliberately empty: being in two places at once is not a travel policy
    // and no waiver against one may excuse it, exactly as `coachTravel.js`
    // refuses to let a constraint record soften its severity. The
    // within-complex note is empty for a different reason — it is `info`
    // provenance saying which floor applied, and there is nothing there to
    // waive.
    [TRAVEL_REASON.TRAVEL_WITHIN_COMPLEX_CROSS_VENUE]: [],
    [TRAVEL_REASON.TRAVEL_COMMITMENTS_OVERLAP]: [],
    [TRAVEL_REASON.TRAVEL_FOOTPRINT_UNKNOWN]: [],
    [TRAVEL_REASON.TRAVEL_POLICY_UNGOVERNED]: [],
    [TRAVEL_REASON.TRAVEL_SCAN_VACUOUS]: [],
  },
  rationale:
    'Delegates to `evaluateCoachTravel()` from Prompt 2.2 rather than re-deriving a gap, so the numbers still come from the registry and the waiver ledger still has something real to except. Incident 5 is what the commitment list must be built from: the whole combined schedule, not the rec layer. Which floor applies is decided by the run’s declared venue complexes, not by venue-name equality: two names for one park are a walk apart, and the run must state its complexes rather than have the rule assume there are none.',
  exercise: {
    minimums: { personPairsCompared: 1, peopleExamined: 1, commitmentsExamined: 1 },
    coverage: {},
    identifierKinds: [RULE_IDENTIFIER_KIND.PERSON, RULE_IDENTIFIER_KIND.TEAM],
    rationale:
      'Incident 4 in one line: "a team-name format change made the coach validator match zero person-pairs and report zero conflicts". A person-pair count above zero is the smallest claim that would have caught it, and the team identifiers are declared so that a join which matched the wrong codes fails as loudly as one that matched none.',
  },
  /**
   * @param {import('./types.js').Schedule} schedule
   * @param {import('./types.js').RuleContext} context
   * @returns {import('./types.js').RuleOutput}
   */
  evaluate(schedule, context) {
    // Required, not defaulted. A run handed no complex map would judge every
    // pair of distinct venue names against the 60-minute drive floor — the
    // exact misreading that reported 18 shortfalls across five coaches on a
    // published season — and it would do it silently. A season with no
    // complexes says so by passing `EMPTY_VENUE_COMPLEX_MAP`.
    const venueComplexes = /** @type {import('../facility/types.js').VenueComplexMap} */ (
      requireResource(context, 'venueComplexes')
    );
    const travel = evaluateCoachTravel(schedule.commitments, {
      registry: context.registry,
      venueComplexes,
    });
    const personIds = new Set();
    const teamIds = new Set();
    for (const commitment of schedule.commitments) {
      personIds.add(commitment.personId);
      if (commitment.teamId) teamIds.add(commitment.teamId);
    }

    const subjects = travel.subjects
      .filter((subject) => subject.findings.length > 0)
      .map((subject) => ({
        ...subject,
        id: `${RULE_ID.COACH_CONFLICT}::${subject.id}`,
        details: {
          ...subject.details,
          ruleId: RULE_ID.COACH_CONFLICT,
          entities: [
            { kind: RULE_IDENTIFIER_KIND.PERSON, id: subject.details.personId },
            { kind: RULE_IDENTIFIER_KIND.DATE, id: subject.details.date },
            { kind: RULE_IDENTIFIER_KIND.VENUE, id: subject.details.fromVenueId },
            { kind: RULE_IDENTIFIER_KIND.VENUE, id: subject.details.toVenueId },
          ],
        },
      }));

    // Scan-level findings belong to the rule rather than to any one transition.
    // `TRAVEL_POLICY_UNGOVERNED` is deliberately not one of them: the evaluator
    // emits it per transition and it is already on that transition's subject,
    // so lifting it here reported every one of them twice.
    const scanFindings = travel.findings.filter(
      (finding) => finding.code === TRAVEL_REASON.TRAVEL_SCAN_VACUOUS
    );

    return {
      subjects,
      findings: /** @type {import('./types.js').RuleFinding[]} */ (scanFindings),
      counters: {
        commitmentsExamined: travel.meta.commitmentsExamined,
        peopleExamined: travel.meta.peopleExamined,
        daysExamined: travel.meta.daysExamined,
        personPairsCompared: travel.meta.transitionsExamined,
        personPairsJudged: travel.meta.transitionsJudged,
        crossVenuePairsCompared: travel.meta.crossVenueTransitions,
        withinComplexPairsCompared: travel.meta.withinComplexTransitions,
        // Not `overlapPairsCompared` (#62): the evaluator counts it, and on a
        // season with at most two commitments per coach-day it equals
        // `personPairsCompared` above. Left off so the rule's output, and every
        // digest of it, stays byte-identical; `personPairsCompared` still
        // carries the exercise minimum.
      },
      matched: {
        [RULE_IDENTIFIER_KIND.PERSON]: [...personIds].sort(),
        [RULE_IDENTIFIER_KIND.TEAM]: [...teamIds].sort(),
      },
    };
  },
});

/**
 * Every division plays a complete round robin, with opponent counts within one.
 *
 * **The second rule the build plan names**: *"the round-robin rule must assert
 * it examined every division"*. A minimum above zero would not do — a rule that
 * examined one division of fifteen clears every such floor and is still
 * reporting on a season it did not read.
 */
export const roundRobinRule = Object.freeze({
  id: RULE_ID.ROUND_ROBIN,
  title: 'Every division plays a complete round robin',
  constraintIds: [SEASON_2026_CONSTRAINT_ID.ROUND_ROBIN_COMPLETENESS],
  reasonCodes: [
    RULE_VIOLATION_REASON.ROUND_ROBIN_INCOMPLETE,
    RULE_VIOLATION_REASON.ROUND_ROBIN_SPREAD_EXCEEDED,
    RULE_VIOLATION_REASON.ROUND_ROBIN_DIVISION_UNJUDGED,
    RULE_VIOLATION_REASON.ROUND_ROBIN_NOT_REQUIRED,
  ],
  rationale:
    'Within a division every team must meet every other where the season is long enough to fit it, and no team’s opponent counts may differ by more than the spread the registry states. A division with no two-sided games at all is reported unjudged rather than counted as complete.',
  exercise: {
    minimums: { teamPairsCompared: 1 },
    coverage: { divisionsExamined: RULE_IDENTIFIER_KIND.DIVISION },
    identifierKinds: [RULE_IDENTIFIER_KIND.TEAM, RULE_IDENTIFIER_KIND.DIVISION],
    rationale:
      'A round robin is a claim about a whole division, so a rule that skipped one has not made the claim. Coverage — not a minimum — is the only expectation that catches that, and the team identifiers are declared so a rule that read placeholder labels as team codes fails before it reports a phantom missing fixture.',
  },
  /**
   * @param {import('./types.js').Schedule} schedule
   * @param {import('./types.js').RuleContext} context
   * @returns {import('./types.js').RuleOutput}
   */
  evaluate(schedule, context) {
    const counted = schedule.games.filter((game) => game.counted && game.divisionLabel !== null);
    const rosteredByDivision = rosteredTeamIdsByDivision(schedule);
    /** @type {Map<string, import('./types.js').ScheduledGame[]>} */
    const byDivision = new Map();
    // The divisions come from the roster as well as from the rows. A division
    // whose rows all vanished is judged — as unjudged — rather than quietly
    // leaving the loop, which is the only way the coverage expectation below
    // has anything to fail against.
    for (const division of rosteredByDivision.keys()) byDivision.set(division, []);
    for (const game of counted) {
      const key = /** @type {string} */ (game.divisionLabel);
      if (!byDivision.has(key)) byDivision.set(key, []);
      /** @type {import('./types.js').ScheduledGame[]} */ (byDivision.get(key)).push(game);
    }

    const resolved = resolvePolicy(context.registry, 'round-robin-completeness', {});
    const record = resolved.effective;
    const maxSpread =
      record && typeof record.parameters.maxOpponentCountSpread === 'number'
        ? record.parameters.maxOpponentCountSpread
        : 1;
    const seasonResolved = resolvePolicy(context.registry, 'home-away-balance', {});
    const gamesPerTeam =
      seasonResolved.effective &&
      typeof seasonResolved.effective.parameters.gamesPerTeam === 'number'
        ? seasonResolved.effective.parameters.gamesPerTeam
        : null;

    /** @type {Array<import('../waivers/types.js').WaiverSubject>} */
    const subjects = [];
    const allTeamIds = new Set();
    let teamPairsCompared = 0;
    let divisionsJudged = 0;

    for (const [division, games] of [...byDivision.entries()].sort((a, b) =>
      a[0].localeCompare(b[0])
    )) {
      /** @type {import('./types.js').RuleFinding[]} */
      const findings = [];
      const twoSided = games.filter((game) => game.homeTeamId && game.awayTeamId);
      // The roster's members and the rows' members, not the rows' alone: a team
      // the rows dropped must show up as one that meets nobody rather than as
      // one this division never had.
      const teamIds = [
        ...new Set([...teamIdsOf(twoSided), ...(rosteredByDivision.get(division) ?? [])]),
      ].sort();
      for (const id of teamIds) allTeamIds.add(id);

      if (twoSided.length === 0 || teamIds.length < 2) {
        findings.push(
          makeViolationFinding(
            RULE_VIOLATION_REASON.ROUND_ROBIN_DIVISION_UNJUDGED,
            `division "${division}" carries ${games.length} row(s) and no two named teams, so no round robin can be judged in it`,
            { divisionLabel: division, gameCount: games.length, teamCount: teamIds.length }
          )
        );
        subjects.push(divisionSubject(division, findings, teamIds));
        continue;
      }

      divisionsJudged += 1;
      /** @type {Map<string, Map<string, number>>} */
      const meetings = new Map();
      const bump = (a, b) => {
        if (!meetings.has(a)) meetings.set(a, new Map());
        const row = /** @type {Map<string, number>} */ (meetings.get(a));
        row.set(b, (row.get(b) ?? 0) + 1);
      };
      for (const game of twoSided) {
        bump(/** @type {string} */ (game.homeTeamId), /** @type {string} */ (game.awayTeamId));
        bump(/** @type {string} */ (game.awayTeamId), /** @type {string} */ (game.homeTeamId));
      }

      const completenessRequired = gamesPerTeam !== null && teamIds.length - 1 <= gamesPerTeam;
      if (!completenessRequired) {
        findings.push(
          makeViolationFinding(
            RULE_VIOLATION_REASON.ROUND_ROBIN_NOT_REQUIRED,
            `division "${division}" has ${teamIds.length} teams and a ${gamesPerTeam ?? 'n/a'}-game season, so a complete round robin does not fit; only the opponent-count spread is required of it`,
            {
              divisionLabel: division,
              teamCount: teamIds.length,
              gamesPerTeam,
              pairsNeeded: (teamIds.length * (teamIds.length - 1)) / 2,
            }
          )
        );
      }

      for (const team of teamIds) {
        const opponentCounts = teamIds
          .filter((other) => other !== team)
          .map((other) => meetings.get(team)?.get(other) ?? 0);
        teamPairsCompared += opponentCounts.length;
        const spread = Math.max(...opponentCounts) - Math.min(...opponentCounts);
        if (spread > maxSpread) {
          findings.push(
            makeViolationFinding(
              RULE_VIOLATION_REASON.ROUND_ROBIN_SPREAD_EXCEEDED,
              `in division "${division}", ${team} meets its opponents between ${Math.min(...opponentCounts)} and ${Math.max(...opponentCounts)} times; the spread ${spread} exceeds the permitted ${maxSpread}`,
              {
                divisionLabel: division,
                teamId: team,
                spread,
                maxSpread,
                minOpponentCount: Math.min(...opponentCounts),
                maxOpponentCount: Math.max(...opponentCounts),
                constraintId: record ? record.id : null,
              },
              record
            )
          );
        }
        if (!completenessRequired) continue;
        for (const other of teamIds) {
          if (other === team || other < team) continue;
          if ((meetings.get(team)?.get(other) ?? 0) > 0) continue;
          findings.push(
            makeViolationFinding(
              RULE_VIOLATION_REASON.ROUND_ROBIN_INCOMPLETE,
              `in division "${division}", ${team} never meets ${other}`,
              {
                divisionLabel: division,
                teamId: team,
                opponentTeamId: other,
                teamCount: teamIds.length,
                constraintId: record ? record.id : null,
              },
              record
            )
          );
        }
      }

      if (findings.length > 0) subjects.push(divisionSubject(division, findings, teamIds));
    }

    return {
      subjects,
      findings: [],
      counters: {
        divisionsExamined: byDivision.size,
        divisionsJudged,
        teamPairsCompared,
        gamesCounted: counted.length,
      },
      matched: {
        [RULE_IDENTIFIER_KIND.TEAM]: [...allTeamIds].sort(),
        [RULE_IDENTIFIER_KIND.DIVISION]: [...byDivision.keys()].sort(),
      },
    };
  },
});

/**
 * The subject standing for one division.
 *
 * @param {string} division
 * @param {import('./types.js').RuleFinding[]} findings
 * @param {string[]} teamIds
 * @returns {import('../waivers/types.js').WaiverSubject}
 */
function divisionSubject(division, findings, teamIds) {
  return {
    id: `${RULE_ID.ROUND_ROBIN}::${division}`,
    context: /** @type {import('../waivers/types.js').WaiverContext} */ ({
      divisionLabel: division,
      ...(teamIds.length > 0 ? { teamIds } : {}),
    }),
    findings,
    details: {
      ruleId: RULE_ID.ROUND_ROBIN,
      divisionLabel: division,
      teamCount: teamIds.length,
      entities: [
        { kind: RULE_IDENTIFIER_KIND.DIVISION, id: division },
        ...teamIds.map((id) => ({ kind: RULE_IDENTIFIER_KIND.TEAM, id })),
      ],
    },
  };
}

/** Hosting balance over the season. */
export const homeAwayBalanceRule = Object.freeze({
  id: RULE_ID.HOME_AWAY_BALANCE,
  title: 'Hosting balance over the season',
  constraintIds: [SEASON_2026_CONSTRAINT_ID.HOME_AWAY_BALANCE],
  reasonCodes: [
    RULE_VIOLATION_REASON.HOME_AWAY_OUT_OF_RANGE,
    RULE_VIOLATION_REASON.GAMES_PLAYED_OFF_TARGET,
    RULE_VIOLATION_REASON.TEAM_ABSENT_FROM_SCHEDULE,
  ],
  rationale:
    'Nine games do not divide evenly, so every team hosts four or five. The three numbers come from the constraint record, never from here. The team set comes from the roster rather than from the games, so a team the rows lost is reported as absent instead of being absent from the report.',
  exercise: {
    minimums: { teamsExamined: 1, gamesCounted: 1 },
    coverage: {},
    identifierKinds: [RULE_IDENTIFIER_KIND.TEAM],
    rationale:
      'A hosting-balance check that found no team has not balanced anything — and a team-name format change is exactly what empties that count. `teamsExamined` deliberately counts the teams the *rows* named, not the teams expected: a join that matched nothing must still fail this floor, and a join that matched all but one is caught by the roster comparison instead.',
  },
  /**
   * @param {import('./types.js').Schedule} schedule
   * @param {import('./types.js').RuleContext} context
   * @returns {import('./types.js').RuleOutput}
   */
  evaluate(schedule, context) {
    const counted = schedule.games.filter(
      (game) => game.counted && game.homeTeamId && game.awayTeamId
    );
    const resolved = resolvePolicy(context.registry, 'home-away-balance', {});
    const record = resolved.effective;
    const parameters = record ? record.parameters : {};
    const gamesPerTeam =
      typeof parameters.gamesPerTeam === 'number' ? parameters.gamesPerTeam : null;
    const minHome = typeof parameters.minHomeGames === 'number' ? parameters.minHomeGames : null;
    const maxHome = typeof parameters.maxHomeGames === 'number' ? parameters.maxHomeGames : null;

    /** @type {Map<string, number>} */
    const played = new Map();
    /** @type {Map<string, number>} */
    const hosted = new Map();
    for (const game of counted) {
      const home = /** @type {string} */ (game.homeTeamId);
      const away = /** @type {string} */ (game.awayTeamId);
      played.set(home, (played.get(home) ?? 0) + 1);
      played.set(away, (played.get(away) ?? 0) + 1);
      hosted.set(home, (hosted.get(home) ?? 0) + 1);
    }

    // Every team the roster puts in a division these rows still name teams in.
    // Derived from the roster because that is the only place a team the rows
    // dropped survives, and scoped to the judged divisions because the same
    // roster also holds the Select teams, which play no counted game by design
    // and would otherwise be reported as fourteen absences that are not one.
    const judgedDivisions = new Set(counted.map((game) => game.divisionLabel));
    /** @type {Map<string, string>} */
    const divisionByExpectedTeamId = new Map();
    for (const team of schedule.teams) {
      if (team.divisionLabel === null || !judgedDivisions.has(team.divisionLabel)) continue;
      divisionByExpectedTeamId.set(team.id, team.divisionLabel);
    }

    /** @type {Array<import('../waivers/types.js').WaiverSubject>} */
    const subjects = [];
    let teamsAbsent = 0;
    for (const teamId of [
      ...new Set([...played.keys(), ...divisionByExpectedTeamId.keys()]),
    ].sort()) {
      /** @type {import('./types.js').RuleFinding[]} */
      const findings = [];
      const games = played.get(teamId) ?? 0;
      const homeGames = hosted.get(teamId) ?? 0;

      if (!played.has(teamId)) {
        // Reported once, as the absence it is. Adding "plays 0 of 9" and
        // "hosts 0 of 4-5" on top would be three findings about one team that
        // is not in the schedule at all.
        teamsAbsent += 1;
        const divisionLabel = /** @type {string} */ (divisionByExpectedTeamId.get(teamId));
        findings.push(
          makeViolationFinding(
            RULE_VIOLATION_REASON.TEAM_ABSENT_FROM_SCHEDULE,
            `${teamId} is on the roster in division "${divisionLabel}" and appears in no counted game; it plays 0 of ${gamesPerTeam ?? 'its'} games and no rule that takes its teams from the schedule would have said so`,
            {
              teamId,
              divisionLabel,
              gamesPlayed: 0,
              gamesPerTeam,
              constraintId: record ? record.id : null,
            },
            record
          )
        );
        subjects.push({
          id: `${RULE_ID.HOME_AWAY_BALANCE}::${teamId}`,
          context: /** @type {import('../waivers/types.js').WaiverContext} */ ({ teamId }),
          findings,
          details: {
            ruleId: RULE_ID.HOME_AWAY_BALANCE,
            teamId,
            divisionLabel,
            gamesPlayed: 0,
            homeGames: 0,
            entities: [{ kind: RULE_IDENTIFIER_KIND.TEAM, id: teamId }],
          },
        });
        continue;
      }

      if (gamesPerTeam !== null && games !== gamesPerTeam) {
        findings.push(
          makeViolationFinding(
            RULE_VIOLATION_REASON.GAMES_PLAYED_OFF_TARGET,
            `${teamId} plays ${games} games; the season is ${gamesPerTeam}`,
            {
              teamId,
              gamesPlayed: games,
              gamesPerTeam,
              constraintId: record ? record.id : null,
            },
            record
          )
        );
      }
      if (minHome !== null && maxHome !== null && (homeGames < minHome || homeGames > maxHome)) {
        findings.push(
          makeViolationFinding(
            RULE_VIOLATION_REASON.HOME_AWAY_OUT_OF_RANGE,
            `${teamId} hosts ${homeGames} of its ${games} games; the balance constraint allows ${minHome} to ${maxHome}`,
            {
              teamId,
              homeGames,
              gamesPlayed: games,
              minHomeGames: minHome,
              maxHomeGames: maxHome,
              constraintId: record ? record.id : null,
            },
            record
          )
        );
      }
      if (findings.length === 0) continue;
      subjects.push({
        id: `${RULE_ID.HOME_AWAY_BALANCE}::${teamId}`,
        context: /** @type {import('../waivers/types.js').WaiverContext} */ ({ teamId }),
        findings,
        details: {
          ruleId: RULE_ID.HOME_AWAY_BALANCE,
          teamId,
          gamesPlayed: games,
          homeGames,
          entities: [{ kind: RULE_IDENTIFIER_KIND.TEAM, id: teamId }],
        },
      });
    }

    return {
      subjects,
      findings: [],
      counters: {
        teamsExamined: played.size,
        teamsExpected: divisionByExpectedTeamId.size,
        teamsAbsent,
        gamesCounted: counted.length,
      },
      matched: { [RULE_IDENTIFIER_KIND.TEAM]: [...played.keys()].sort() },
    };
  },
});

/** Coach conflicts are shared evenly within a group. */
export const conflictFairnessRule = Object.freeze({
  id: RULE_ID.CONFLICT_FAIRNESS,
  title: 'Coach conflicts are shared evenly within an age group',
  constraintIds: [SEASON_2026_CONSTRAINT_ID.CONFLICT_FAIRNESS],
  reasonCodes: [
    RULE_VIOLATION_REASON.CONFLICT_SPREAD_EXCEEDED,
    RULE_VIOLATION_REASON.CONFLICT_OVERLAP_UNJUDGED,
  ],
  rationale:
    'A coach conflict means a team plays with its co-coach covering. The burden is unavoidable; its concentration on one team is not. The grouping key is supplied by the caller because deriving it means parsing a division label, and a label is not a key (GAP-24).',
  exercise: {
    minimums: { groupsExamined: 1, teamsExamined: 1, commitmentPairsCompared: 1 },
    coverage: {},
    identifierKinds: [RULE_IDENTIFIER_KIND.TEAM],
    rationale:
      'Fairness is a comparison between teams in a group, so a run that saw no group or no team compared nothing. The commitment-pair count is the same person-pair claim the coach rule makes, because this rule counts conflicts the same join produces. It counts only pairs that reached a verdict: the minimum is the claim "this rule measured something", and a pair whose overlap could not be decided is exactly the thing it did not measure.',
  },
  /**
   * @param {import('./types.js').Schedule} schedule
   * @param {import('./types.js').RuleContext} context
   * @returns {import('./types.js').RuleOutput}
   */
  evaluate(schedule, context) {
    const resolved = resolvePolicy(context.registry, 'conflict-fairness', {});
    const record = resolved.effective;
    const maxSpread =
      record && typeof record.parameters.maxConflictSpread === 'number'
        ? record.parameters.maxConflictSpread
        : 1;

    /** @type {Map<string, Array<import('./types.js').ScheduledCommitment>>} */
    const byPersonDate = new Map();
    for (const commitment of schedule.commitments) {
      const key = `${commitment.personId}\u0000${commitment.date}`;
      if (!byPersonDate.has(key)) byPersonDate.set(key, []);
      /** @type {Array<import('./types.js').ScheduledCommitment>} */ (byPersonDate.get(key)).push(
        commitment
      );
    }

    // A conflict is counted per (team, game), never per overlapping pair, and
    // only for a team that has a co-coach to cover: a team with one rostered
    // coach is not "co-coach covered", it is short a coach, which is a
    // different problem with a different owner. That is the corpus's own
    // definition of the three single-coach games it records.
    const rosterSize = new Map(schedule.teams.map((team) => [team.id, team.personIds.length]));
    /** @type {Set<string>} */
    const conflictKeys = new Set();
    /** @type {import('./types.js').RuleFinding[]} */
    const unjudgedFindings = [];
    let commitmentPairsCompared = 0;
    let commitmentPairsUnjudgedUnknownEnd = 0;
    for (const entries of byPersonDate.values()) {
      for (let i = 0; i < entries.length; i += 1) {
        for (let j = i + 1; j < entries.length; j += 1) {
          const a = entries[i];
          const b = entries[j];
          if (a.teamId === null || b.teamId === null || a.teamId === b.teamId) continue;
          // `bookingsOverlapInTime()` owns this question and answers it three
          // ways; re-deriving the comparison here would be a second overlap
          // model free to disagree with the one every other module asks. Its
          // `null` is the deliberate third answer for an unknown footprint
          // (GAP-14), and it is neither an overlap nor an all-clear.
          const overlap = bookingsOverlapInTime(
            /** @type {import('../facility/types.js').FacilityBooking} */ ({ ...a }),
            /** @type {import('../facility/types.js').FacilityBooking} */ ({ ...b })
          );
          if (overlap === null) {
            // **Counted apart, and said out loud.** This counter used to be
            // bumped before the check and the pair dropped in silence, so an
            // undecidable overlap read as "no conflict" and the exercise
            // minimum — which is written on `commitmentPairsCompared` — was
            // satisfied by pairs this rule never judged. Same fix as
            // `scanConcurrency()` one rule over, same reporting as
            // `reserve/slots.js` `doubleBookingFindings()` one module over.
            commitmentPairsUnjudgedUnknownEnd += 1;
            const teamIds = [/** @type {string} */ (a.teamId), /** @type {string} */ (b.teamId)]
              .slice()
              .sort();
            unjudgedFindings.push(
              makeViolationFinding(
                RULE_VIOLATION_REASON.CONFLICT_OVERLAP_UNJUDGED,
                `"${a.personId}" is committed to "${a.id}" and "${b.id}" on ${a.date} for different teams, and at least one of them has no known end, so whether they overlap cannot be decided; the conflict counts for ${teamIds.join(' and ')} may understate this date`,
                {
                  personId: a.personId,
                  date: a.date,
                  commitmentIds: [a.id, b.id].slice().sort(),
                  teamIds,
                  unmeasurableCommitmentIds: [a, b]
                    .filter((side) => side.endMinutes === null)
                    .map((side) => side.id)
                    .sort(),
                }
              )
            );
            continue;
          }
          commitmentPairsCompared += 1;
          if (overlap === false) continue;
          for (const side of [a, b]) {
            const teamId = /** @type {string} */ (side.teamId);
            if ((rosterSize.get(teamId) ?? 0) < 2) continue;
            conflictKeys.add(`${teamId}\u0000${side.gameId ?? side.id}`);
          }
        }
      }
    }

    /** @type {Map<string, number>} */
    const conflictsByTeam = new Map();
    for (const key of conflictKeys) {
      const teamId = key.slice(0, key.indexOf('\u0000'));
      conflictsByTeam.set(teamId, (conflictsByTeam.get(teamId) ?? 0) + 1);
    }

    /** @type {Map<string, string[]>} */
    const teamsByGroup = new Map();
    for (const team of schedule.teams) {
      if (team.groupLabel === null) continue;
      if (!teamsByGroup.has(team.groupLabel)) teamsByGroup.set(team.groupLabel, []);
      /** @type {string[]} */ (teamsByGroup.get(team.groupLabel)).push(team.id);
    }

    /** @type {Array<import('../waivers/types.js').WaiverSubject>} */
    const subjects = [];
    let teamsExamined = 0;
    for (const [group, teamIds] of [...teamsByGroup.entries()].sort((a, b) =>
      a[0].localeCompare(b[0])
    )) {
      const counts = teamIds.map((id) => conflictsByTeam.get(id) ?? 0);
      teamsExamined += teamIds.length;
      const spread = Math.max(...counts) - Math.min(...counts);
      if (spread <= maxSpread) continue;
      subjects.push({
        id: `${RULE_ID.CONFLICT_FAIRNESS}::${group}`,
        context: /** @type {import('../waivers/types.js').WaiverContext} */ ({
          teamIds: [...teamIds].sort(),
        }),
        findings: [
          makeViolationFinding(
            RULE_VIOLATION_REASON.CONFLICT_SPREAD_EXCEEDED,
            `group "${group}" carries between ${Math.min(...counts)} and ${Math.max(...counts)} coach conflicts per team; the spread ${spread} exceeds the permitted ${maxSpread}`,
            {
              groupLabel: group,
              spread,
              maxSpread,
              minConflicts: Math.min(...counts),
              maxConflicts: Math.max(...counts),
              teamCount: teamIds.length,
              constraintId: record ? record.id : null,
            },
            record
          ),
        ],
        details: {
          ruleId: RULE_ID.CONFLICT_FAIRNESS,
          groupLabel: group,
          entities: [...[...teamIds].sort().map((id) => ({ kind: RULE_IDENTIFIER_KIND.TEAM, id }))],
        },
      });
    }

    return {
      subjects,
      // Rule-level rather than on a subject, deliberately. This rule's subject
      // is a *group* and its violation is a spread; an undecidable pair is not
      // an unfair distribution, it is a hole in the evidence the distribution
      // was counted from. It reaches `result.findings` and therefore the run's
      // status and the validation report, which is where a reader looks — the
      // same place `coach-conflict` puts `TRAVEL_SCAN_VACUOUS`.
      findings: unjudgedFindings,
      counters: {
        groupsExamined: teamsByGroup.size,
        teamsExamined,
        commitmentPairsCompared,
        commitmentPairsUnjudgedUnknownEnd,
        conflictedTeams: conflictsByTeam.size,
      },
      matched: { [RULE_IDENTIFIER_KIND.TEAM]: [...conflictsByTeam.keys()].sort() },
    };
  },
});

/**
 * The standing rule set, in a stable order.
 *
 * @type {ReadonlyArray<Object>}
 */
export const STANDING_RULES = Object.freeze([
  fieldSameGroundRule,
  fieldAdjacencyRule,
  fieldEligibilityRule,
  permitWindowRule,
  sunsetMarginRule,
  turnoverMinimumRule,
  coachConflictRule,
  roundRobinRule,
  homeAwayBalanceRule,
  conflictFairnessRule,
]);
