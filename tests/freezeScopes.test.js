/**
 * Freeze scopes and the scoped re-solve — Prompt 4.1.
 *
 * > *"Integrating eight externally-published fixtures required changes on two
 * > dates. I froze those dates and let the rest re-optimise. The result was
 * > valid and 366 of 679 games had moved — roughly half the season silently
 * > rescheduled for families who already had the old times."*
 *
 * That is incident 1, and the two tests that matter here are a matched pair.
 * `describe('the acceptance test')` replays the scenario with everything
 * outside the change frozen and asserts that the games which moved outside the
 * two affected dates are **exactly none, by game**. `describe('the positive
 * control')` replays the *same* scenario through `reoptimiseWholeSeason()` and
 * asserts that a great many did. Neither is worth anything without the other:
 * "zero moved" proves the freeze works only if the alternative would have moved
 * something, and every other test in this file exists to stop that pair meaning
 * less than it looks like it means.
 *
 * ## The scenario is assembled, and says so
 *
 * The corpus holds one snapshot of the season — the **post**-negotiation one,
 * in which the 08/22 external fixtures sit at 10:00 and 12:00. There is no
 * "before" file to load, so the scenario is put together rather than read:
 * `combined_schedule.csv` is the baseline, and the eight rows of
 * `external_fixtures_published.csv` — the other league's own published 10:30
 * and 12:30 — are the incoming change. That runs history backwards, since the
 * club moved *from* the published times *to* the agreed ones (GAP-34: the
 * corpus has no versioned schedule). What it costs is nothing the acceptance
 * test rests on: the delta between the two states is the same four games on the
 * same date whichever way it is applied, and the question being asked is what
 * happens to the **other 606**.
 *
 * Every number below is derived from the corpus at test time. No clock time, no
 * field name and no game id is typed in as an expectation.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

import { buildAvailabilityCalendarFromSeason2026 } from '@squadlogic/core/availability/index.js';
import {
  CONSTRAINT_SCOPE_SPECIFICITY,
  SEASON_2026_CONSTRAINT_ID,
  buildSeason2026ConstraintRegistry,
} from '@squadlogic/core/constraints/index.js';
import {
  buildFacilityGraphFromSeason2026,
  buildSeason2026VenueComplexMap,
  season2026SurfaceId,
} from '@squadlogic/core/facility/index.js';
import {
  loadExternalFixtures,
  loadFacilityGeometry,
  loadFacilityPermits,
  loadGameFormats,
  loadSeason2026,
  loadSunsets,
} from '@squadlogic/core/fixtures/index.js';
import { scheduleGames } from '@squadlogic/core/gameScheduling.js';
import { buildFormatTimingTableFromSeason2026 } from '@squadlogic/core/timing/index.js';
import { runRuleEngine, toSeason2026Schedule } from '@squadlogic/core/ruleEngine/index.js';
import { WAIVER_SCOPE_SPECIFICITY } from '@squadlogic/core/waivers/index.js';

import {
  FREEZE_DISPOSITION,
  FREEZE_REASON,
  FREEZE_RULE_KIND,
  FREEZE_SCOPE_DIMENSION,
  FREEZE_SCOPE_SPECIFICITY,
  FreezeMatchSchema,
  buildFreezePlan,
  freezeAllExcept,
  freezeForChanges,
  freezeSpecificity,
  freezeTieBreak,
  judgeFreeze,
  judgeFreezeAll,
  scopesTouchedBy,
} from '@squadlogic/core/freeze/index.js';

import {
  FrozenGameMoveAttempt,
  FrozenGameUnsatisfiable,
  FREEZE_AUDIT_STAGE_ID,
  MOVE_KIND,
  RESOLVE_OBJECTIVE_WEIGHTS,
  RESOLVE_REASON,
  RESOLVE_STAGES,
  ResolveStageSchema,
  STAGE_PROBE,
  VERIFY_STAGE_ID,
  applyChangeRequest,
  applyMove,
  buildResolvePipeline,
  buildSlotInventory,
  candidateSlotsFor,
  checkPlacement,
  createResolveLedger,
  createResolveState,
  frozenGameUnsatisfiable,
  isSlotAdmissible,
  probeEveryStage,
  probeStage,
  reoptimiseWholeSeason,
  season2026ExternalFixtureChanges,
} from '@squadlogic/core/resolve/index.js';

/* -------------------------------------------------------------------------- */
/* Corpus and engines, loaded once                                             */
/* -------------------------------------------------------------------------- */

const season = loadSeason2026();
const graph = buildFacilityGraphFromSeason2026(loadFacilityGeometry());
const table = buildFormatTimingTableFromSeason2026(loadGameFormats());
const sunsets = loadSunsets();
/** Derived from the corpus rather than typed in, so a re-dated fixture moves it. */
const SEASON_YEAR = Number(sunsets[0].date.slice(0, 4));
const calendar = buildAvailabilityCalendarFromSeason2026(
  loadFacilityPermits({ seasonYear: SEASON_YEAR }),
  sunsets
);
const registry = buildSeason2026ConstraintRegistry();
const resources = {
  graph,
  timingTable: table,
  calendar,
  venueComplexes: buildSeason2026VenueComplexMap(),
};
const engines = { graph, table, calendar, registry, resources };

const schedule = toSeason2026Schedule(season);
const externalFixtures = loadExternalFixtures();
const changes = season2026ExternalFixtureChanges(externalFixtures, schedule);

/** The rule-engine verdict on the published season, computed once. */
const baselineVerification = runRuleEngine(schedule, { registry, resources });

/** The two dates the external fixtures fall on, found in the data. */
const AFFECTED_DATES = [...new Set(changes.map((change) => change.date))].sort();
const affected = new Set(AFFECTED_DATES);

/** Where every game started, keyed by id. */
const baselineById = new Map(schedule.games.map((game) => [game.id, game]));

/**
 * A slot as a comparable string, used everywhere a placement is compared.
 *
 * @param {{ date: string, surfaceId: string, startMinutes: number }|null} game
 * @returns {string}
 */
const slotOf = (game) =>
  game === null || game === undefined
    ? '(unplaced)'
    : `${game.date}|${game.surfaceId}|${game.startMinutes}`;

/**
 * Which games of a resolved schedule stand somewhere other than the baseline —
 * enumerated from the **baseline's own 679 rows**, never from the run's move
 * list.
 *
 * That distinction is the whole of `docs/LESSONS_LEARNED.md`'s "never derive a
 * check's subject set from the data a break would corrupt". A stage that wrote
 * around the mutation gate would be absent from the move list, and a diff built
 * from the move list would report a clean season while half of it had moved.
 *
 * @param {import('@squadlogic/core/ruleEngine/types.js').Schedule} resolved
 * @returns {Array<{ gameId: string, before: string, after: string }>}
 */
function diffFromBaseline(resolved) {
  const byId = new Map(resolved.games.map((game) => [game.id, game]));
  /** @type {Array<{ gameId: string, before: string, after: string }>} */
  const moved = [];
  for (const [gameId, before] of baselineById) {
    const after = byId.get(gameId) ?? null;
    if (slotOf(before) === slotOf(after)) continue;
    moved.push({ gameId, before: slotOf(before), after: slotOf(after) });
  }
  return moved.sort((a, b) => a.gameId.localeCompare(b.gameId));
}

/** One game context, for the scope-model unit tests. */
const sampleGame = /** @type {Object} */ (
  schedule.games.find((game) => game.format === '9v9' && game.divisionLabel === 'U12B')
);

/**
 * Build a freeze context from a schedule game, exactly as `resolve/` does.
 *
 * @param {Object} game
 * @returns {Object}
 */
function contextOf(game) {
  const surface = graph.surfaces[game.surfaceId];
  return {
    gameId: game.id,
    date: game.date,
    divisionLabel: game.divisionLabel,
    venueId: game.venueId,
    surfaceId: game.surfaceId,
    surfaceLineage: [...surface.lineage],
    format: game.format,
    teamIds: [game.homeTeamId, game.awayTeamId].filter(Boolean),
  };
}

/* -------------------------------------------------------------------------- */
/* The scenario, meta-asserted before anything runs                            */
/* -------------------------------------------------------------------------- */

describe('the scenario, before anything is resolved', () => {
  it('is the whole corpus: 679 rows across the season', () => {
    expect(schedule.games).toHaveLength(679);
    expect(baselineById.size).toBe(679);
  });

  it('turns exactly the eight published external fixtures into changes', () => {
    expect(externalFixtures).toHaveLength(8);
    expect(changes).toHaveLength(8);
    for (const change of changes) {
      expect(baselineById.has(change.gameId)).toBe(true);
      expect(change.surfaceId).toMatch(/^alder-park\//);
    }
    // Every fixture named a distinct game: eight changes covering seven games
    // would be seven fixtures integrated and one lost.
    expect(new Set(changes.map((change) => change.gameId)).size).toBe(8);
  });

  it('falls on two dates, and the rest of the season is 606 games', () => {
    expect(AFFECTED_DATES).toHaveLength(2);
    const counts = AFFECTED_DATES.map(
      (date) => schedule.games.filter((game) => game.date === date).length
    );
    expect(counts).toEqual([69, 4]);
    const elsewhere = schedule.games.filter((game) => !affected.has(game.date));
    expect(elsewhere).toHaveLength(606);
    expect(counts[0] + counts[1] + elsewhere.length).toBe(679);
  });

  it('is not vacuous: the second date asks for nothing and the first asks for four', () => {
    // **The meta-assertion the acceptance test rests on.** If the published
    // times matched the corpus on both days the change request would be eight
    // no-ops, "nothing moved" would be trivially true, and the test would prove
    // nothing at all. The corpus's own numbers are checked before a solver runs:
    // 08/23 stayed as published, 08/22 was negotiated thirty minutes earlier.
    const deltas = AFFECTED_DATES.map(
      (date) =>
        changes.filter((change) => {
          if (change.date !== date) return false;
          const game = /** @type {Object} */ (baselineById.get(change.gameId));
          return game.startMinutes !== change.startMinutes || game.surfaceId !== change.surfaceId;
        }).length
    );
    expect(deltas).toEqual([4, 0]);
    // And the delta is exactly the thirty minutes incident 3 records.
    const shifted = changes.filter((change) => change.date === AFFECTED_DATES[0]);
    for (const change of shifted) {
      const game = /** @type {Object} */ (baselineById.get(change.gameId));
      expect(change.startMinutes - game.startMinutes).toBe(30);
    }
  });

  it('refuses an external fixture that names no game in the schedule', () => {
    expect(() =>
      season2026ExternalFixtureChanges(
        [{ ...externalFixtures[0], homeLabel: 'A Club That Does Not Exist' }],
        schedule
      )
    ).toThrow(/matches 0 games/);
    expect(() => season2026ExternalFixtureChanges([], schedule)).toThrow(/empty/);
  });
});

/* -------------------------------------------------------------------------- */
/* The freeze scope model                                                      */
/* -------------------------------------------------------------------------- */

describe('the freeze scope model', () => {
  it('shares its specificity integers with the constraint and waiver models', () => {
    // Not copied and hoped over. "This thaw is broader than the freeze it
    // carves out of" is only a meaningful comparison if all three models rank
    // narrowness on one scale.
    expect(FREEZE_SCOPE_SPECIFICITY[FREEZE_SCOPE_DIMENSION.DATE_RANGE]).toBe(
      CONSTRAINT_SCOPE_SPECIFICITY['date-range']
    );
    expect(FREEZE_SCOPE_SPECIFICITY[FREEZE_SCOPE_DIMENSION.DATE]).toBe(
      CONSTRAINT_SCOPE_SPECIFICITY.date
    );
    expect(FREEZE_SCOPE_SPECIFICITY[FREEZE_SCOPE_DIMENSION.VENUE]).toBe(
      CONSTRAINT_SCOPE_SPECIFICITY.venue
    );
    expect(FREEZE_SCOPE_SPECIFICITY[FREEZE_SCOPE_DIMENSION.SURFACE]).toBe(
      CONSTRAINT_SCOPE_SPECIFICITY.surface
    );
    expect(FREEZE_SCOPE_SPECIFICITY[FREEZE_SCOPE_DIMENSION.TEAM]).toBe(
      WAIVER_SCOPE_SPECIFICITY.team
    );
    expect(FREEZE_SCOPE_SPECIFICITY[FREEZE_SCOPE_DIMENSION.GAME]).toBe(
      WAIVER_SCOPE_SPECIFICITY.game
    );
    // A date-range loses to a single named date; a surface beats both.
    expect(FREEZE_SCOPE_SPECIFICITY[FREEZE_SCOPE_DIMENSION.DATE_RANGE]).toBeLessThan(
      FREEZE_SCOPE_SPECIFICITY[FREEZE_SCOPE_DIMENSION.DATE]
    );
    expect(FREEZE_SCOPE_SPECIFICITY[FREEZE_SCOPE_DIMENSION.DATE]).toBeLessThan(
      FREEZE_SCOPE_SPECIFICITY[FREEZE_SCOPE_DIMENSION.SURFACE]
    );
  });

  it('composes every dimension inside one match, as a conjunction', () => {
    const context = contextOf(sampleGame);
    const plan = freezeAllExcept([
      {
        date: context.date,
        divisionLabel: context.divisionLabel,
        venueId: context.venueId,
        surfaceId: context.surfaceId,
        format: context.format,
        teamId: context.teamIds[0],
        gameId: context.gameId,
      },
    ]);
    expect(judgeFreeze(plan, context).frozen).toBe(false);
    // Change any single term and the conjunction stops matching, so the game
    // falls back to the frozen default.
    for (const [field, value] of [
      ['date', '2026-01-01'],
      ['divisionLabel', 'U99Z'],
      ['venueId', 'nowhere'],
      ['surfaceId', 'nowhere/field-1'],
      ['format', 'korfball'],
      ['teamId', 'nobody'],
      ['gameId', 'no-such-game'],
    ]) {
      const narrowed = freezeAllExcept([
        {
          date: context.date,
          divisionLabel: context.divisionLabel,
          venueId: context.venueId,
          surfaceId: context.surfaceId,
          format: context.format,
          teamId: context.teamIds[0],
          gameId: context.gameId,
          [/** @type {string} */ (field)]: value,
        },
      ]);
      expect(judgeFreeze(narrowed, context).frozen, `${field}`).toBe(true);
    }
  });

  it('expresses the build plan’s own example: everything except 9v9 on 08/22', () => {
    const date = AFFECTED_DATES[0];
    const plan = freezeAllExcept([{ date, format: '9v9' }]);
    const judgements = judgeFreezeAll(
      plan,
      schedule.games.map((game) => contextOf(game))
    );
    const thawed = schedule.games.filter((game) => game.date === date && game.format === '9v9');
    expect(thawed.length).toBeGreaterThan(0);
    expect(judgements.thawedGameIds).toEqual(thawed.map((game) => game.id).sort());
    expect(judgements.frozenGameIds).toHaveLength(679 - thawed.length);
    expect(judgements.meta.gamesJudged).toBe(679);
  });

  it('matches a surface against its lineage, so freezing a pitch freezes its halves', () => {
    const parentId = season2026SurfaceId('Alder Park', 'Pitch 1');
    const halves = schedule.games.filter((game) =>
      graph.surfaces[game.surfaceId].lineage.includes(parentId)
    );
    expect(halves.length).toBeGreaterThan(0);
    expect(halves.every((game) => game.surfaceId !== parentId)).toBe(true);

    const plan = freezeAllExcept([{ surfaceId: parentId }]);
    for (const game of halves) {
      expect(judgeFreeze(plan, contextOf(game)).frozen, game.surfaceId).toBe(false);
    }
  });

  it('matches a team on either side of a game', () => {
    const game = /** @type {Object} */ (
      schedule.games.find((row) => row.homeTeamId && row.awayTeamId)
    );
    for (const teamId of [game.homeTeamId, game.awayTeamId]) {
      const plan = freezeAllExcept([{ teamId }]);
      expect(judgeFreeze(plan, contextOf(game)).frozen).toBe(false);
    }
  });

  it('resolves an unjudged freeze to frozen — the deliberate inversion', () => {
    // A Minis session names no division. A division-scoped rule judged against
    // it cannot be decided, and the two models answer in opposite directions on
    // purpose: an unjudged waiver is not applied (don't excuse), an unjudged
    // freeze holds the game (don't move).
    const minis = /** @type {Object} */ (
      schedule.games.find((game) => game.homeTeamId === null && game.awayTeamId === null)
    );
    const context = { ...contextOf(minis), teamIds: undefined };
    const held = buildFreezePlan({
      rules: [{ kind: FREEZE_RULE_KIND.FREEZE, match: { teamId: 'some-team' } }],
    });
    const judgement = judgeFreeze(held, context);
    expect(judgement.judged).toBe(false);
    expect(judgement.frozen).toBe(true);
    expect(judgement.findings.map((finding) => finding.code)).toContain(
      FREEZE_REASON.FREEZE_SCOPE_UNJUDGED
    );

    // The mirror image: an unjudged *thaw* does not free the game either.
    const carved = freezeAllExcept([{ teamId: 'some-team' }]);
    const thawJudgement = judgeFreeze(carved, context);
    expect(thawJudgement.judged).toBe(false);
    expect(thawJudgement.frozen).toBe(true);
  });

  it('holds a game a freeze and a thaw both claim at equal specificity, and says so', () => {
    const context = contextOf(sampleGame);
    const plan = buildFreezePlan({
      defaultDisposition: FREEZE_DISPOSITION.THAWED,
      globalReoptimisation: { reason: 'testing the tie-break', acknowledged: true },
      rules: [
        { kind: FREEZE_RULE_KIND.FREEZE, match: { gameId: context.gameId } },
        { kind: FREEZE_RULE_KIND.THAW, match: { gameId: context.gameId } },
      ],
    });
    const judgement = judgeFreeze(plan, context);
    expect(judgement.frozen).toBe(true);
    const ambiguity = judgement.findings.find(
      (finding) => finding.code === FREEZE_REASON.FREEZE_AMBIGUOUS_DISPOSITION
    );
    expect(ambiguity?.severity).toBe('blocking');
    expect(judgement.meta.ambiguitiesReported).toBe(1);
  });

  it('lets the narrower rule win when the two disagree', () => {
    const context = contextOf(sampleGame);
    const plan = buildFreezePlan({
      rules: [
        { kind: FREEZE_RULE_KIND.THAW, match: { date: context.date } },
        { kind: FREEZE_RULE_KIND.FREEZE, match: { gameId: context.gameId } },
      ],
    });
    const judgement = judgeFreeze(plan, context);
    expect(judgement.frozen).toBe(true);
    expect(judgement.specificity).toBe(FREEZE_SCOPE_SPECIFICITY[FREEZE_SCOPE_DIMENSION.GAME]);
    expect(judgement.findings.map((finding) => finding.code)).toContain(
      FREEZE_REASON.FREEZE_NARROWER_APPLIED
    );
  });

  it('reads "freeze Pitch 1 except this one game" as a narrowing, not a contradiction', () => {
    // The two-level ordering, and the half an operator meets every day. The
    // shared specificity scale puts `surface`, `team` and `game` all at rank 3,
    // because three phases read those integers and they are not this module's
    // to re-cut. Within one rank the freeze model orders by how many things the
    // dimension can name — a gameId names exactly one — so the exception wins
    // and its neighbours on the same pitch stay held.
    const parentId = season2026SurfaceId('Alder Park', 'Pitch 1');
    const onThatPitch = schedule.games.filter((game) =>
      graph.surfaces[game.surfaceId].lineage.includes(parentId)
    );
    // Meta-assertion: the carve-out has to have neighbours, or "its neighbours
    // stay frozen" is a statement about the empty set.
    expect(onThatPitch.length).toBeGreaterThan(1);
    const carvedOut = /** @type {Object} */ (onThatPitch[0]);
    const neighbours = onThatPitch.slice(1);

    // The primary ranks are genuinely equal — this test is only interesting
    // because the shared scale cannot separate these two rules.
    expect(freezeSpecificity(FreezeMatchSchema.parse({ surfaceId: parentId }))).toBe(
      freezeSpecificity(FreezeMatchSchema.parse({ gameId: carvedOut.id }))
    );

    const plan = buildFreezePlan({
      rules: [
        { kind: FREEZE_RULE_KIND.FREEZE, match: { surfaceId: parentId } },
        { kind: FREEZE_RULE_KIND.THAW, match: { gameId: carvedOut.id } },
      ],
    });
    // Nothing is reported at build time: the two rules are ordered.
    expect(
      plan.findings.some((candidate) => candidate.code === FREEZE_REASON.FREEZE_THAW_TIES_FREEZE)
    ).toBe(false);

    const judgement = judgeFreeze(plan, contextOf(carvedOut));
    expect(judgement.frozen).toBe(false);
    expect(judgement.findings.map((entry) => entry.code)).not.toContain(
      FREEZE_REASON.FREEZE_AMBIGUOUS_DISPOSITION
    );
    expect(judgement.findings.map((entry) => entry.code)).toContain(
      FREEZE_REASON.FREEZE_NARROWER_APPLIED
    );
    // …and the pitch it was carved out of is still held, game by game.
    for (const neighbour of neighbours) {
      expect(judgeFreeze(plan, contextOf(neighbour)).frozen, neighbour.id).toBe(true);
    }

    // The second ordering level, stated directly: it is freeze-local, and it
    // orders the three dimensions the shared scale flattens onto rank 3.
    expect(freezeTieBreak(FreezeMatchSchema.parse({ gameId: carvedOut.id }))).toBeGreaterThan(
      freezeTieBreak(FreezeMatchSchema.parse({ teamId: 'any-team' }))
    );
    expect(freezeTieBreak(FreezeMatchSchema.parse({ teamId: 'any-team' }))).toBeGreaterThan(
      freezeTieBreak(FreezeMatchSchema.parse({ surfaceId: parentId }))
    );
    // …and it changes none of the integers the constraint and waiver models read.
    expect(FREEZE_SCOPE_SPECIFICITY[FREEZE_SCOPE_DIMENSION.SURFACE]).toBe(
      CONSTRAINT_SCOPE_SPECIFICITY.surface
    );
    expect(FREEZE_SCOPE_SPECIFICITY[FREEZE_SCOPE_DIMENSION.GAME]).toBe(
      WAIVER_SCOPE_SPECIFICITY.game
    );
  });

  it('still reports a genuine same-dimension contradiction, and still holds the game', () => {
    // The other half, and the reason the tie-break is a second level rather
    // than a re-cut of the shared scale: two rules naming the *same* dimension
    // are the same width by construction, nothing orders them, and the plan is
    // genuinely contradictory. The residual case keeps both its build-time
    // warning and its per-game blocking verdict.
    const plan = buildFreezePlan({
      rules: [
        { kind: FREEZE_RULE_KIND.FREEZE, match: { surfaceId: sampleGame.surfaceId } },
        { kind: FREEZE_RULE_KIND.THAW, match: { surfaceId: sampleGame.surfaceId } },
      ],
    });
    const finding = plan.findings.find(
      (candidate) => candidate.code === FREEZE_REASON.FREEZE_THAW_TIES_FREEZE
    );
    expect(finding?.severity).toBe('compromise');
    expect(finding?.details.specificity).toBe(
      FREEZE_SCOPE_SPECIFICITY[FREEZE_SCOPE_DIMENSION.SURFACE]
    );

    const judgement = judgeFreeze(plan, contextOf(sampleGame));
    // Frozen wins the residual tie: a contradictory plan is an operator error,
    // and the recoverable half of the error is "it did not move".
    expect(judgement.frozen).toBe(true);
    const ambiguity = judgement.findings.find(
      (entry) => entry.code === FREEZE_REASON.FREEZE_AMBIGUOUS_DISPOSITION
    );
    expect(ambiguity?.severity).toBe('blocking');
    expect(judgement.meta.ambiguitiesReported).toBe(1);

    // Silent when the primary ranks genuinely differ, as before.
    const ordered = buildFreezePlan({
      rules: [
        { kind: FREEZE_RULE_KIND.FREEZE, match: { date: sampleGame.date } },
        { kind: FREEZE_RULE_KIND.THAW, match: { gameId: sampleGame.id } },
      ],
    });
    expect(
      ordered.findings.some((candidate) => candidate.code === FREEZE_REASON.FREEZE_THAW_TIES_FREEZE)
    ).toBe(false);
  });

  it('leaves two rank-2 dimensions unordered, because nothing honestly orders them', () => {
    // The tie-break table is deliberately partial. `date`, `division`, `venue`
    // and `format` share rank 2 precisely because a date does not name more or
    // fewer things than a venue does; inventing an order there would be a
    // ruling nobody made. A pair that ties in that group is still a genuine
    // contradiction and still says so.
    const plan = buildFreezePlan({
      rules: [
        { kind: FREEZE_RULE_KIND.FREEZE, match: { venueId: sampleGame.venueId } },
        { kind: FREEZE_RULE_KIND.THAW, match: { date: sampleGame.date } },
      ],
    });
    expect(
      plan.findings.some((candidate) => candidate.code === FREEZE_REASON.FREEZE_THAW_TIES_FREEZE)
    ).toBe(true);
    expect(judgeFreeze(plan, contextOf(sampleGame)).frozen).toBe(true);
  });

  it('names every contradictory pair, not just the first one it met', () => {
    // The set-level aggregation keys on the code plus the rules the finding
    // names. `FREEZE_AMBIGUOUS_DISPOSITION` names `ruleIds` — plural, because
    // an ambiguity is about a pair — so keying on the singular `ruleId`
    // collapsed two independent contradictions into one finding that named the
    // first and counted both. An operator would fix one and believe they were
    // done.
    const first = /** @type {Object} */ (schedule.games.find((game) => game.homeTeamId));
    const second = /** @type {Object} */ (
      schedule.games.find(
        (game) =>
          game.surfaceId !== first.surfaceId &&
          game.homeTeamId &&
          game.homeTeamId !== first.homeTeamId &&
          game.awayTeamId !== first.homeTeamId
      )
    );
    // Meta-assertion: two genuinely independent pairs, or the test is really
    // one contradiction wearing two names.
    expect(second).toBeTruthy();
    expect(second.surfaceId).not.toBe(first.surfaceId);

    const plan = buildFreezePlan({
      rules: [
        { kind: FREEZE_RULE_KIND.FREEZE, match: { surfaceId: first.surfaceId } },
        { kind: FREEZE_RULE_KIND.THAW, match: { surfaceId: first.surfaceId } },
        { kind: FREEZE_RULE_KIND.FREEZE, match: { teamId: second.homeTeamId } },
        { kind: FREEZE_RULE_KIND.THAW, match: { teamId: second.homeTeamId } },
      ],
    });
    const judgements = judgeFreezeAll(plan, [contextOf(first), contextOf(second)]);
    const ambiguities = judgements.findings.filter(
      (finding) => finding.code === FREEZE_REASON.FREEZE_AMBIGUOUS_DISPOSITION
    );
    expect(ambiguities).toHaveLength(2);
    // Two findings, one per pair, each speaking for the one game it is about —
    // and between them they name all four rules.
    expect(ambiguities.map((finding) => finding.details.gameCount)).toEqual([1, 1]);
    const named = new Set(
      ambiguities.flatMap((finding) => /** @type {string[]} */ (finding.details.ruleIds))
    );
    expect(named.size).toBe(4);
    expect(judgements.frozenGameIds).toEqual([first.id, second.id].sort());
  });

  it('reports a thaw broader than the freeze it carves out of', () => {
    const plan = buildFreezePlan({
      rules: [
        { kind: FREEZE_RULE_KIND.FREEZE, match: { date: AFFECTED_DATES[0] } },
        { kind: FREEZE_RULE_KIND.THAW, match: { fromDate: '2026-08-01', toDate: '2026-12-31' } },
      ],
    });
    const finding = plan.findings.find(
      (candidate) => candidate.code === FREEZE_REASON.FREEZE_THAW_BROADER_THAN_FREEZE
    );
    expect(finding?.severity).toBe('compromise');
    // …and it is silent when the thaw really is narrower.
    const narrower = buildFreezePlan({
      rules: [
        { kind: FREEZE_RULE_KIND.FREEZE, match: { fromDate: '2026-08-01', toDate: '2026-12-31' } },
        { kind: FREEZE_RULE_KIND.THAW, match: { date: AFFECTED_DATES[0] } },
      ],
    });
    expect(
      narrower.findings.some(
        (candidate) => candidate.code === FREEZE_REASON.FREEZE_THAW_BROADER_THAN_FREEZE
      )
    ).toBe(false);
  });

  it('says out loud when a rule protected nothing', () => {
    // Incident 4 at the level of the plan: an operator who froze a pitch this
    // season does not have believes they protected something.
    const plan = freezeAllExcept([{ surfaceId: 'alder-park/pitch-9' }]);
    const judgements = judgeFreezeAll(
      plan,
      schedule.games.slice(0, 20).map((game) => contextOf(game))
    );
    const finding = judgements.findings.find(
      (candidate) => candidate.code === FREEZE_REASON.FREEZE_RULE_MATCHED_NOTHING
    );
    expect(finding?.severity).toBe('compromise');
    expect(judgements.meta.rulesThatMatchedNothing).toBe(1);
    expect(judgements.meta.rulesThatMatchedSomething).toBe(0);

    // The positive control for that meta-assertion: a rule that *does* reach a
    // game must not be reported, or the check would be unfalsifiable.
    const real = freezeAllExcept([{ gameId: schedule.games[0].id }]);
    const reached = judgeFreezeAll(
      real,
      schedule.games.slice(0, 20).map((game) => contextOf(game))
    );
    expect(reached.meta.rulesThatMatchedNothing).toBe(0);
    expect(reached.meta.rulesThatMatchedSomething).toBe(1);
  });

  it('carries the operator’s own reason on the rule that decided', () => {
    // A reason recorded and never surfaced is a reason lost — the shape the
    // board waiver went missing in (incident 9).
    const plan = freezeAllExcept([{ gameId: sampleGame.id }], {
      reason: 'the family already has this time',
    });
    const judgement = judgeFreeze(plan, contextOf(sampleGame));
    expect(judgement.frozen).toBe(false);
    expect(judgement.decidedByReason).toBe('the family already has this time');
    // …and the default decides with no rule and therefore no reason.
    const untouched = judgeFreeze(plan, contextOf(schedule.games[0]));
    expect(untouched.decidedByRuleId).toBeNull();
    expect(untouched.decidedByReason).toBeNull();
  });

  it('never lets a set-level finding speak for one game while counting many', () => {
    const plan = freezeAllExcept([{ gameId: schedule.games[0].id }]);
    const judgements = judgeFreezeAll(
      plan,
      schedule.games.map((game) => contextOf(game))
    );
    const aggregate = /** @type {Object} */ (
      judgements.findings.find((finding) => finding.code === FREEZE_REASON.FREEZE_DEFAULT_APPLIED)
    );
    expect(aggregate.details.gameCount).toBe(678);
    expect(aggregate.details.gameId).toBeUndefined();
    expect(aggregate.details.exampleGameIds).toHaveLength(5);
    expect(aggregate.message).toMatch(/677 other game/);
  });

  it('flags a division-label match as a best effort (GAP-24)', () => {
    const plan = freezeAllExcept([{ divisionLabel: sampleGame.divisionLabel }]);
    const judgement = judgeFreeze(plan, contextOf(sampleGame));
    expect(judgement.frozen).toBe(false);
    expect(judgement.findings.map((finding) => finding.code)).toContain(
      FREEZE_REASON.FREEZE_DIVISION_LABEL_MATCH
    );
  });

  it('refuses a match that names nothing', () => {
    expect(() => FreezeMatchSchema.parse({})).toThrow(/at least one dimension/);
    expect(() => freezeAllExcept([{}])).toThrow(/at least one dimension/);
    // A single date and a date range are two statements about one dimension.
    expect(() => FreezeMatchSchema.parse({ date: '2026-08-22', toDate: '2026-08-23' })).toThrow(
      /not both/
    );
    expect(() => FreezeMatchSchema.parse({ fromDate: '2026-09-01', toDate: '2026-08-01' })).toThrow(
      /must not follow/
    );
  });

  it('refuses a thawed default without a real acknowledgement', () => {
    expect(() => buildFreezePlan({ defaultDisposition: FREEZE_DISPOSITION.THAWED })).toThrow(
      /globalReoptimisation/
    );
    expect(() =>
      buildFreezePlan({
        defaultDisposition: FREEZE_DISPOSITION.THAWED,
        globalReoptimisation: { reason: '', acknowledged: true },
      })
    ).toThrow();
    // A truthy value is not an acknowledgement.
    expect(() =>
      buildFreezePlan({
        defaultDisposition: FREEZE_DISPOSITION.THAWED,
        globalReoptimisation: { reason: 'because', acknowledged: 1 },
      })
    ).toThrow();
    // …and an acknowledgement on a frozen default is a field parsed and unread.
    expect(() =>
      buildFreezePlan({
        globalReoptimisation: { reason: 'because', acknowledged: true },
      })
    ).toThrow(/must not carry/);
  });

  it('derives maximum freeze from a change request, and nothing wider', () => {
    const scopes = scopesTouchedBy(changes);
    expect(scopes).toHaveLength(8);
    expect(scopes.every((scope) => Object.keys(scope).length === 1)).toBe(true);
    const plan = freezeForChanges(changes);
    expect(plan.defaultDisposition).toBe(FREEZE_DISPOSITION.FROZEN);
    const judgements = judgeFreezeAll(
      plan,
      schedule.games.map((game) => contextOf(game))
    );
    // Exactly the eight named games are free. Not their dates, not their venue.
    expect(judgements.thawedGameIds).toEqual(changes.map((change) => change.gameId).sort());
    expect(judgements.frozenGameIds).toHaveLength(671);
    expect(freezeSpecificity({ ...FreezeMatchSchema.parse(scopes[0]) })).toBe(
      FREEZE_SCOPE_SPECIFICITY[FREEZE_SCOPE_DIMENSION.GAME]
    );
  });
});

/* -------------------------------------------------------------------------- */
/* The stage registry and its build-time refusal                               */
/* -------------------------------------------------------------------------- */

describe('the eight stages and the contract each of them signs', () => {
  const EXPECTED = [
    'baseline-ingest',
    'change-request-apply',
    'dislodge',
    'initial-assignment',
    'local-search',
    'pair-repair',
    'verify',
    'freeze-audit',
  ];

  it('registers exactly the eight the build plan names, audit last', () => {
    expect(RESOLVE_STAGES.map((stage) => stage.id)).toEqual(EXPECTED);
    expect(RESOLVE_STAGES[RESOLVE_STAGES.length - 1].id).toBe('freeze-audit');
  });

  it('gives every stage a filled-in freeze contract', () => {
    for (const stage of RESOLVE_STAGES) {
      expect(stage.freezeContract.claim.length, stage.id).toBeGreaterThan(20);
      expect(Object.values(STAGE_PROBE), stage.id).toContain(stage.freezeContract.probe);
    }
    // Four stages write and four do not; a pipeline in which nothing wrote
    // would pass every "no frozen game moved" assertion in this file.
    const writers = RESOLVE_STAGES.filter((stage) => stage.freezeContract.mutationKinds.length > 0);
    expect(writers.map((stage) => stage.id)).toEqual([
      'change-request-apply',
      'dislodge',
      'initial-assignment',
      'local-search',
      'pair-repair',
    ]);
  });

  it('refuses a stage whose contract is under-specified, at build time', () => {
    const base = {
      id: 'x',
      title: 'x',
      freezeContract: {
        mutationKinds: [MOVE_KIND.RELOCATE],
        probe: STAGE_PROBE.OFFERS_FROZEN_MOVE,
        claim: 'a claim long enough to say something',
      },
      run: (state) => state,
    };
    expect(() => ResolveStageSchema.parse(base)).not.toThrow();
    // No claim at all.
    expect(() =>
      ResolveStageSchema.parse({
        ...base,
        freezeContract: { ...base.freezeContract, claim: '' },
      })
    ).toThrow(/promises nothing/);
    // A writer hiding behind the probe that would never offer it a frozen game.
    expect(() =>
      ResolveStageSchema.parse({
        ...base,
        freezeContract: { ...base.freezeContract, probe: STAGE_PROBE.WRITES_NOTHING },
      })
    ).toThrow(/would pass without ever offering it a frozen game/);
    // A non-writer claiming a probe whose rejection counter it can never move.
    expect(() =>
      ResolveStageSchema.parse({
        ...base,
        freezeContract: { ...base.freezeContract, mutationKinds: [] },
      })
    ).toThrow(/rejection counter it can never produce/);
    // A duplicated mutation kind.
    expect(() =>
      ResolveStageSchema.parse({
        ...base,
        freezeContract: {
          ...base.freezeContract,
          mutationKinds: [MOVE_KIND.RELOCATE, MOVE_KIND.RELOCATE],
        },
      })
    ).toThrow(/same mutation kind twice/);
  });

  it('refuses an extra stage that shadows a core one or the audit', () => {
    const stage = {
      id: 'dislodge',
      title: 'x',
      freezeContract: {
        mutationKinds: [],
        probe: STAGE_PROBE.WRITES_NOTHING,
        claim: 'a claim long enough to say something',
      },
      run: (state) => state,
    };
    expect(() => buildResolvePipeline([stage])).toThrow(/two stages claim the id/);
    expect(() => buildResolvePipeline([{ ...stage, id: 'freeze-audit' }])).toThrow(
      /two stages claim the id/
    );
    // `verify` is shadowable too, and refused for the same reason: a caller who
    // claimed that id used to be accepted and then silently dropped, because the
    // shadow check enumerated only the stages that ran before the extras.
    expect(() => buildResolvePipeline([{ ...stage, id: 'verify' }])).toThrow(
      /two stages claim the id/
    );
    // …and a legitimate extra stage lands before **both** closing stages. It
    // used to be spliced between them, which put a caller's writes past the only
    // stage that checks the result; the claim is therefore tightened rather than
    // relaxed — the original "before the audit" is still asserted, and "before
    // verify" is added to it.
    const pipeline = buildResolvePipeline([{ ...stage, id: 'extra' }]);
    const ids = pipeline.map((entry) => entry.id);
    expect(ids.indexOf('extra')).toBeLessThan(ids.indexOf('freeze-audit'));
    expect(ids.indexOf('extra')).toBeLessThan(ids.indexOf('verify'));
    expect(ids.slice(-3)).toEqual(['extra', 'verify', 'freeze-audit']);
    // The closing pair writes nothing, which is what makes it safe for them to
    // come last: neither can move the verification cache key.
    for (const id of [VERIFY_STAGE_ID, FREEZE_AUDIT_STAGE_ID]) {
      const stageEntry = /** @type {any} */ (RESOLVE_STAGES.find((entry) => entry.id === id));
      expect(stageEntry.freezeContract.mutationKinds, id).toEqual([]);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* The acceptance test                                                          */
/* -------------------------------------------------------------------------- */

describe('the acceptance test :: the change request, with everything else frozen', () => {
  const run = applyChangeRequest({ schedule, changes, engines, baselineVerification });

  it('ran every stage over every game, and asked the freeze real questions', () => {
    // The meta-assertions. Each one is here because the headline assertion
    // below is worthless without it: a run that examined nothing, judged
    // nothing, or never considered a move would report "zero moved outside" and
    // mean "I did nothing".
    expect(run.meta.gamesExamined).toBe(679);
    expect(run.meta.freezeJudgements).toBe(679);
    expect(run.meta.stagesRun).toBe(8);
    expect(run.meta.stagesRegistered).toBe(8);
    expect(run.stages.map((stage) => stage.stageId)).toEqual(
      RESOLVE_STAGES.map((stage) => stage.id)
    );
    expect(run.meta.movesConsidered).toBeGreaterThan(0);
    expect(run.meta.movesRejectedByFreeze).toBeGreaterThan(0);
    expect(run.meta.movesApplied).toBeGreaterThan(0);
    expect(run.meta.gamesAudited).toBe(679);
    expect(run.meta.constraintsConsulted).toBeGreaterThan(0);
    expect(run.judgements.thawedGameIds).toHaveLength(8);
    expect(run.judgements.frozenGameIds).toHaveLength(671);
    // Everything the run was ever allowed to offer anybody: the distinct
    // (date, surface, kickoff) slots the published season itself used.
    expect(run.meta.slotsAvailable).toBe(new Set(schedule.games.map((game) => slotOf(game))).size);
    for (const stage of run.stages) {
      expect(stage.title.length, stage.stageId).toBeGreaterThan(10);
      expect(stage.claim.length, stage.stageId).toBeGreaterThan(20);
    }
  });

  it('moves ZERO games outside the two affected dates — by game, never a count', () => {
    // **The assertion the prompt asks for**, and the answer to incident 1.
    const moved = diffFromBaseline(run.schedule);
    const movedOutside = moved.filter(
      (change) =>
        !affected.has(change.before.split('|')[0]) || !affected.has(change.after.split('|')[0])
    );
    expect(movedOutside).toEqual([]);

    // Stated the other way round as well, enumerated from the baseline rather
    // than from the diff: all 606 games elsewhere in the season are byte-for-
    // byte where families already have them.
    const byId = new Map(run.schedule.games.map((game) => [game.id, game]));
    const elsewhere = schedule.games.filter((game) => !affected.has(game.date));
    expect(elsewhere).toHaveLength(606);
    for (const game of elsewhere) {
      expect(slotOf(byId.get(game.id) ?? null), game.id).toBe(slotOf(game));
    }
    expect(run.unplaced).toEqual([]);
    expect(run.schedule.games).toHaveLength(679);
  });

  it('moves only what the request named, and names each one', () => {
    const moved = diffFromBaseline(run.schedule);
    expect(moved.length).toBeGreaterThan(0);
    const thawed = new Set(run.judgements.thawedGameIds);
    for (const change of moved) {
      expect(thawed.has(change.gameId), change.gameId).toBe(true);
      expect(change.before).not.toBe(change.after);
    }
    // The run's own by-game report agrees with the diff taken from the baseline.
    expect(run.moved.map((change) => change.gameId).sort()).toEqual(
      moved.map((change) => change.gameId).sort()
    );
  });

  it('reproduces incident 3: the 12:30 fixtures cannot stand and go back 30 minutes', () => {
    // The external league's published 12:30 puts an 11v11 game on ground that
    // physically overlaps a **frozen** 9v9 block by exactly ten minutes. Under
    // maximum freeze the published games do not move, so the fixture does: to
    // 12:00, the nearest kickoff the schedule already used — which is precisely
    // what the club negotiated in the real season.
    const displaced = run.findings.filter(
      (finding) => finding.code === RESOLVE_REASON.RESOLVE_CHANGE_DISPLACED
    );
    expect(displaced).toHaveLength(2);
    for (const finding of displaced) {
      const requested = Number(String(finding.details.requestedSlot).split('|')[2]);
      const placed = Number(String(finding.details.placedSlot).split('|')[2]);
      expect(requested - placed).toBe(30);
      const original = /** @type {Object} */ (
        baselineById.get(/** @type {string} */ (finding.details.gameId))
      );
      expect(placed).toBe(original.startMinutes);
      expect(finding.severity).toBe('compromise');
    }
    // The freeze was what refused: the 9v9 block was considered and held.
    const dislodgeStage = /** @type {Object} */ (
      run.stages.find((stage) => stage.stageId === 'dislodge')
    );
    expect(dislodgeStage.movesRejectedByFreeze).toBeGreaterThan(0);
    expect(dislodgeStage.movesConsidered).toBeGreaterThan(dislodgeStage.movesRejectedByFreeze - 1);
  });

  it('reports what the change broke rather than repairing it', () => {
    // The 10:30 fixtures are facility-legal and so the hold rule leaves them
    // there — but 10:30 plus a 90-minute footprint runs straight into the 12:00
    // kickoff on the same pitch, and the standing rule engine says so. That is
    // the *other* half of what the humans negotiated, surfaced instead of
    // silently traded away: trading it needs the weighted objective Prompt 4.2
    // owns.
    const introduced = run.findings.filter(
      (finding) => finding.code === RESOLVE_REASON.RESOLVE_VERIFY_NEW_VIOLATION
    );
    expect(introduced.length).toBeGreaterThan(0);
    for (const finding of introduced) {
      expect(finding.details.introduced).toBeGreaterThan(0);
      expect(finding.details.rulesRun).toBe(baselineVerification.meta.rulesRun);
      expect(finding.details.rulesExercised).toBe(baselineVerification.meta.rulesExercised);
    }
    expect(run.verification).not.toBeNull();
    expect(run.verification.meta.rulesRun).toBeGreaterThan(0);
    expect(run.verification.meta.rulesExercised).toBe(run.verification.meta.rulesRun);
  });

  it('derives the baseline verdict when the caller does not supply one', () => {
    // The published season carries 62 accepted exceptions of its own — four
    // `Scrimmage` rows with no timing entry, 36 Minis sessions on unlined
    // ground, and the rest. A run that treated "no baseline supplied" as "the
    // baseline was clean" would blame the change request for every one of
    // them, which is `newBlockingCodes()`'s mistake one layer up. The default
    // path must produce exactly what the explicit one does.
    const derived = applyChangeRequest({ schedule, changes, engines });
    const codesOf = (result) =>
      result.findings
        .filter((finding) => finding.code === RESOLVE_REASON.RESOLVE_VERIFY_NEW_VIOLATION)
        .map((finding) => `${finding.details.code}:${finding.details.introduced}`)
        .sort();
    expect(codesOf(derived)).toEqual(codesOf(run));
    expect(codesOf(derived).length).toBeGreaterThan(0);
    // None of the season's own accepted exceptions is among them.
    const accepted = new Set(baselineVerification.violations.map((v) => v.code));
    expect(accepted.size).toBeGreaterThan(5);
    for (const finding of derived.findings) {
      if (finding.code !== RESOLVE_REASON.RESOLVE_VERIFY_NEW_VIOLATION) continue;
      expect(Number(finding.details.baselineCount)).toBe(
        baselineVerification.violations.filter((v) => v.code === finding.details.code).length
      );
    }
  });

  it('lifts out only as many games as the clash needs, and names the rest', () => {
    // "The smallest set of games that has to move." Every party to the clash is
    // asked — which is what puts "the 9v9 block is frozen" in the report — but
    // only the ones needed to clear it are lifted out.
    const dislodged = run.findings.filter(
      (finding) => finding.code === RESOLVE_REASON.RESOLVE_GAME_DISLODGED
    );
    expect(dislodged).toHaveLength(2);
    for (const finding of dislodged) {
      expect(Number(finding.details.partyCount)).toBeGreaterThan(
        Number(finding.details.frozenPartyCount)
      );
      expect(Number(finding.details.frozenPartyCount)).toBeGreaterThan(0);
    }
    // Every dislodge is of a game the request named; no published neighbour was
    // taken off the board.
    const thawed = new Set(run.judgements.thawedGameIds);
    for (const move of run.moves.filter((entry) => entry.kind === 'dislodge')) {
      expect(thawed.has(move.gameId)).toBe(true);
      expect(move.reason).not.toContain('a frozen neighbour');
    }
    expect(run.meta.gamesDislodged).toBe(2);
  });

  it('comes back compromised, not clean and not rejected', () => {
    // A change that displaced two fixtures and introduced a turnover violation
    // is not a clean run, and saying so is the point. It is also not a rejected
    // one: nothing frozen moved and no frozen game was left unsatisfiable.
    expect(run.status).toBe('compromised');
    const audit = run.findings.filter((finding) => finding.code.startsWith('RESOLVE_AUDIT'));
    expect(audit).toEqual([]);
  });

  it('never offers a slot the schedule did not already use', () => {
    // The anti-third-solver guarantee, checked on the output: every placement
    // is a (date, surface, kickoff) the baseline used, except where a change
    // request brought its own — and those are exactly the eight it named.
    const inventory = new Set(schedule.games.map((game) => slotOf(game)));
    const admitted = new Set(
      changes.map((change) => `${change.date}|${change.surfaceId}|${change.startMinutes}`)
    );
    let outsideInventory = 0;
    for (const game of run.schedule.games) {
      if (inventory.has(slotOf(game))) continue;
      expect(admitted.has(slotOf(game)), game.id).toBe(true);
      outsideInventory += 1;
    }
    expect(outsideInventory).toBeGreaterThan(0);
  });
});

/* -------------------------------------------------------------------------- */
/* The positive control                                                        */
/* -------------------------------------------------------------------------- */

describe('the positive control :: the same scenario, globally re-optimised', () => {
  /**
   * **The global re-solve with change minimisation switched off.**
   *
   * Prompt 4.1 got this by handing the placer an `earliest-legal-first`
   * ordering, because under the hold rule a legal game was never moved and a
   * global re-solve that kept the hold rule would have moved nothing and proved
   * nothing. Prompt 4.2 replaced both hand-written orderings with the objective,
   * so the same behaviour is now asked for by **naming the weights**: with
   * every change term at zero the objective ranks legal slots equally and the
   * tie-break — earliest kickoff, then surface id — decides, which is precisely
   * what `earliest-legal-first` was.
   *
   * The numbers are unchanged by that substitution: **311 games moved, 275 of
   * them outside the two affected dates**, exactly as 4.1 recorded. Being able
   * to reproduce the incident-1 solver by setting three weights to zero, and
   * getting the same season back, is the strongest evidence available that the
   * objective replaced the ordering rather than merely joining it.
   */
  const run = reoptimiseWholeSeason({
    schedule,
    changes,
    engines,
    reason: 'the positive control for the acceptance test above',
    acknowledged: true,
    verify: false,
    objectiveWeights: { changedGame: 0, driftMinute: 0, changedSurface: 0 },
  });
  const moved = diffFromBaseline(run.schedule);
  const movedOutside = moved.filter(
    (change) =>
      !affected.has(change.before.split('|')[0]) || !affected.has(change.after.split('|')[0])
  );

  it('moves a great many games outside the affected dates', () => {
    // **The most important assertion in this file.** "Zero moved" only proves
    // the freeze works if the alternative would have moved something, and here
    // the alternative moves most of a season. The threshold is deliberately
    // loose: the source project's number was 366 of 679, on a different
    // algorithm on a different day, and asserting it here would be fake
    // precision. What was observed when this test was written, and again after
    // Prompt 4.2 replaced the ordering with the objective: 311 games moved in
    // total and 275 of them fall outside the two dates the change touched.
    expect(movedOutside.length).toBeGreaterThan(50);
    expect(moved.length).toBeGreaterThan(movedOutside.length);
    // Every one of them is named, because a count is what incident 1 had.
    for (const change of movedOutside.slice(0, 25)) {
      expect(baselineById.has(change.gameId)).toBe(true);
      expect(change.before).not.toBe(change.after);
    }
  });

  it('says out loud that it was scored with change minimisation switched off', () => {
    // The weights that make this run the incident-1 solver are not a detail of
    // how it was called; they are the whole of what it is. A run scored this way
    // must never be mistaken for an ordinary one.
    const finding = run.findings.find(
      (candidate) => candidate.code === RESOLVE_REASON.RESOLVE_OBJECTIVE_CHANGE_TERM_DISABLED
    );
    expect(finding?.severity).toBe('compromise');
    expect(run.objective.changeTermsDisabled).toBe(true);
    expect(run.report.objective.weights.changedGame).toBe(0);
    // …and separately that the weights were the caller's at all, because two
    // runs of one change request under different objectives are not comparable
    // and a report that did not say so would invite the comparison.
    const overridden = run.findings.find(
      (candidate) => candidate.code === RESOLVE_REASON.RESOLVE_OBJECTIVE_WEIGHTS_OVERRIDDEN
    );
    expect(overridden?.severity).toBe('info');
    expect(overridden?.details.driftMinute).toBe(0);
  });

  it('moves far fewer games when the objective is left alone — Prompt 4.2’s own result', () => {
    // The same operation, the same freeze plan, the same 679 rows, and the only
    // difference is that the objective is the one the module ships with. Under
    // 4.1 a "global re-optimisation" was a synonym for a reshuffle because
    // nothing rewarded leaving a game alone; under 4.2 the change terms are what
    // the placer optimises, so a global re-solve of a schedule that is already
    // good mostly reproduces it.
    const nearest = reoptimiseWholeSeason({
      schedule,
      changes,
      engines,
      reason: 'the same global re-optimisation, under the objective the module ships with',
      acknowledged: true,
      verify: false,
    });
    const nearestMoved = diffFromBaseline(nearest.schedule);
    // 8 against 311, on identical inputs. Both numbers are observed rather than
    // chosen, and the assertion is the ratio rather than either figure.
    expect(nearestMoved.length).toBeLessThan(moved.length / 10);
    expect(nearest.findings.map((finding) => finding.code)).not.toContain(
      RESOLVE_REASON.RESOLVE_OBJECTIVE_CHANGE_TERM_DISABLED
    );
    // Every game it does move is on one of the two dates the change touched.
    for (const change of nearestMoved) {
      expect(affected.has(change.before.split('|')[0]), change.gameId).toBe(true);
    }
    // And it is **not** free: placing in one pass with no backtracking, the
    // four 9v9 games the held 12:30 fixture overlaps find no slot left on the
    // date and are carried as TIME TBD rather than dropped (incident 10). The
    // objective scores that honestly — an unplaced game is the most expensive
    // thing it knows — so this run reports a *worse* total than the scoped
    // change request above, which is the correct verdict on it.
    expect(nearest.unplaced.length).toBeGreaterThan(0);
    for (const entry of nearest.unplaced) {
      expect(baselineById.has(entry.gameId), entry.gameId).toBe(true);
    }
    expect(nearest.report.objective.resolvedSchedule.total).toBeGreaterThan(
      nearest.report.objective.baseline.total
    );
  });

  it('cannot come back clean, however valid the schedule it produces is', () => {
    const finding = run.findings.find(
      (candidate) => candidate.code === FREEZE_REASON.FREEZE_GLOBAL_REOPTIMISATION
    );
    expect(finding?.severity).toBe('blocking');
    expect(run.status).toBe('rejected');
    expect(run.freeze.defaultDisposition).toBe(FREEZE_DISPOSITION.THAWED);
    expect(run.freeze.globalReoptimisation?.reason).toMatch(/positive control/);
  });

  it('demands a reason and a literal acknowledgement', () => {
    expect(() => reoptimiseWholeSeason({ schedule, engines, acknowledged: true })).toThrow();
    // A truthy value is not an acknowledgement, and neither is `false`; the
    // casts are here because the type already refuses both, which is the point.
    expect(() =>
      reoptimiseWholeSeason({
        schedule,
        engines,
        reason: 'because',
        acknowledged: /** @type {true} */ (/** @type {unknown} */ (false)),
      })
    ).toThrow();
    expect(() =>
      reoptimiseWholeSeason({
        schedule,
        engines,
        reason: 'because',
        acknowledged: /** @type {true} */ (/** @type {unknown} */ ('yes')),
      })
    ).toThrow();
  });

  it('is the only door to a thawed default', () => {
    expect(() => applyChangeRequest({ schedule, changes, engines, freeze: run.freeze })).toThrow(
      /different, named operation/
    );
    // `null` is a missing argument, not permission.
    expect(() => applyChangeRequest({ schedule, changes, engines, freeze: null })).toThrow(
      TypeError
    );
    expect(() => applyChangeRequest({ schedule, changes: [], engines })).toThrow(/no changes/);
  });
});

/* -------------------------------------------------------------------------- */
/* The composable variant the prompt spells out                                */
/* -------------------------------------------------------------------------- */

describe('freezeAllExcept([{ date, format: "9v9" }]) — the prompt’s own example', () => {
  const plan = freezeAllExcept([{ date: AFFECTED_DATES[0], format: '9v9' }]);
  const run = applyChangeRequest({ schedule, changes, engines, freeze: plan, verify: false });

  it('freezes the external fixtures, so the change request raises a conflict', () => {
    // The correct answer, not a failure. An operator who thawed only the 9v9
    // block and then asked to move four 11v11 fixtures has asked for two
    // contradictory things, and the resolver refuses rather than choosing.
    const refused = run.findings.filter(
      (finding) => finding.code === RESOLVE_REASON.RESOLVE_CHANGE_REFUSED_FROZEN
    );
    expect(refused).toHaveLength(4);
    for (const finding of refused) {
      expect(finding.severity).toBe('blocking');
      expect(String(finding.details.gameId)).toBeTruthy();
      expect(finding.details.requestedSlot).not.toBe(finding.details.currentSlot);
    }
    expect(run.status).toBe('rejected');
  });

  it('moves nothing at all, and treats the other four changes as no-ops', () => {
    expect(diffFromBaseline(run.schedule)).toEqual([]);
    expect(run.meta.movesApplied).toBe(0);
    expect(run.meta.movesRejectedByFreeze).toBe(4);
    const noOps = run.findings.filter(
      (finding) => finding.code === RESOLVE_REASON.RESOLVE_CHANGE_NO_OP
    );
    // The four 08/23 fixtures are already at the times the league published.
    expect(noOps).toHaveLength(4);
  });
});

/* -------------------------------------------------------------------------- */
/* The unsatisfiable frozen game                                               */
/* -------------------------------------------------------------------------- */

describe('a frozen game that cannot be satisfied', () => {
  /**
   * The same change request, with `holdChanges` — "these times are not mine to
   * move", the right setting for an externally-published fixture. Now the
   * fixture and the 9v9 block it overlaps are both frozen, and nothing in the
   * clash may give way.
   */
  const attempt = () =>
    applyChangeRequest({ schedule, changes, engines, holdChanges: true, baselineVerification });

  it('throws by default, naming the game and the binding constraint', () => {
    let error = null;
    try {
      attempt();
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(FrozenGameUnsatisfiable);
    const raised = /** @type {any} */ (error);

    // The binding constraint is **consumed** from Phase 1.3, not re-derived:
    // occupancy binds, and the slack is the ten minutes incident 3 records.
    expect(raised.bindingKinds).toEqual(['occupancy']);
    expect(raised.binding.slackMinutes).toBe(-10);
    expect(raised.binding.kind).toBe('occupancy');
    // …and the registry constraint that makes it blocking is named.
    expect(raised.constraintId).toBe(SEASON_2026_CONSTRAINT_ID.FIELD_OVERLAP_ADJACENCY);
    expect(raised.constraintIds).toContain(SEASON_2026_CONSTRAINT_ID.FIELD_OVERLAP_ADJACENCY);
    expect(raised.blockingCodes).toContain('OCCUPIED_SPATIAL_OVERLAP');

    // The game is named, and so is the stage that stopped.
    expect(baselineById.has(raised.gameId)).toBe(true);
    expect(raised.stageId).toBe('dislodge');
    expect(raised.message).toContain(raised.gameId);
    // The contract, at the end of the message, in those words.
    expect(raised.message.endsWith('the game has NOT been moved.')).toBe(true);
  });

  it('never presents a short list as complete', () => {
    let raised = null;
    try {
      attempt();
    } catch (thrown) {
      raised = /** @type {any} */ (thrown);
    }
    // "Named two because only two applied" has to be distinguishable from
    // "named two because only two were checked". Both denominators travel with
    // the error, and both appear in the message.
    expect(raised.meta.constraintsConsulted).toBe(4);
    expect(raised.meta.constraintsApplicable).toBeLessThan(raised.meta.constraintsConsulted);
    expect(raised.meta.rulesRun).toBe(baselineVerification.meta.rulesRun);
    expect(raised.meta.rulesExercised).toBe(baselineVerification.meta.rulesExercised);
    expect(raised.meta.verificationRan).toBe(true);
    expect(raised.message).toContain(
      `${raised.meta.constraintsApplicable} of ${raised.meta.constraintsConsulted}`
    );
    expect(raised.message).toContain(
      `${raised.meta.rulesExercised} of ${raised.meta.rulesRun} standing rules`
    );
    expect(raised.constraints).toHaveLength(4);

    // The rule engine's own violations about this game come from
    // `runRuleEngine()` over **the state as it stands mid-run**, rather than
    // being re-derived here — and after Prompt 4.2 that is a materially
    // different list from the baseline's, for a reason worth stating.
    //
    // The published season carries exactly one violation about this game: one
    // coach is 30 minutes short of the between-venues travel floor getting to
    // it. The change request moves the fixture 30 minutes later, and a
    // commitment now **follows its game** through `resolvedScheduleOf()`, so his
    // gap grows by exactly the shift and the shortfall is gone. Until 4.2 the
    // resolved schedule kept the baseline's commitment times, so the rule engine
    // judged every re-solve on where the coaches used to be: this violation
    // survived a move that had repaired it, and — far worse in the other
    // direction — a knock-on that stranded a coach would have been invisible.
    // Category (b) of the dry-run report is unreadable without that fix.
    // Matched by identity in all three places, exactly as `errors.js` does: a
    // coach-travel violation names its games inside the composite subject id
    // rather than in `entities`, and a substring test over those ids is the
    // defect the last describe block in this file exists for.
    const aboutIt = baselineVerification.violations.filter(
      (violation) =>
        (violation.entities ?? []).some(
          (entity) => entity.kind === 'game' && entity.id === raised.gameId
        ) ||
        violation.details?.gameId === raised.gameId ||
        String(violation.subjectId ?? '')
          .split(/::|->|\|/)
          .includes(raised.gameId)
    );
    expect(aboutIt.map((violation) => violation.code)).toEqual(['TRAVEL_BETWEEN_VENUES_TOO_SHORT']);
    expect(raised.violations).toEqual([]);
    expect(raised.meta.violationsReported).toBe(0);
  });

  it('can report instead of throwing, and still moves nothing', () => {
    const run = applyChangeRequest({
      schedule,
      changes,
      engines,
      holdChanges: true,
      onUnsatisfiable: 'report',
      verify: false,
    });
    const reported = run.findings.filter(
      (finding) => finding.code === RESOLVE_REASON.RESOLVE_FROZEN_GAME_UNSATISFIABLE
    );
    expect(reported.length).toBeGreaterThan(0);
    for (const finding of reported) {
      expect(finding.severity).toBe('blocking');
      expect(finding.details.slackMinutes).toBe(-10);
      expect(finding.details.constraintId).toBe(SEASON_2026_CONSTRAINT_ID.FIELD_OVERLAP_ADJACENCY);
    }
    expect(run.status).toBe('rejected');
    // Everything outside the two dates is still exactly where it was.
    const movedOutside = diffFromBaseline(run.schedule).filter(
      (change) =>
        !affected.has(change.before.split('|')[0]) || !affected.has(change.after.split('|')[0])
    );
    expect(movedOutside).toEqual([]);
  });

  it('is a different state from an unplaceable thawed game (incident 10)', () => {
    // A thawed game with nowhere to go becomes TIME TBD with a reason and stays
    // visible; a frozen one raises. The two are never conflated, and the codes
    // that carry them are distinct.
    expect(RESOLVE_REASON.RESOLVE_GAME_TIME_TBD).not.toBe(
      RESOLVE_REASON.RESOLVE_FROZEN_GAME_UNSATISFIABLE
    );
    // The corpus's own reduced-venue scenario, found rather than invented:
    // `facility_permits.csv` records that Summit HS has **no permit at all** on
    // 09/19, and no game is scheduled there that day. A change request that
    // sends a game to that site on that date asks for something with no legal
    // slot anywhere — and because the game is thawed, the answer is TIME TBD
    // with a reason rather than a raised error or a silent drop.
    const blackoutDate = /** @type {string} */ (
      [...new Set(schedule.games.map((game) => game.date))]
        .sort()
        .find(
          (date) =>
            schedule.games.some((game) => game.date === date) &&
            !schedule.games.some((game) => game.date === date && game.venueId === 'summit-hs') &&
            calendar.permitsByVenue['summit-hs']?.some(
              (permit) => permit.date === date && permit.hasPermit === false
            )
        )
    );
    expect(blackoutDate).toBeTruthy();
    const stranded = /** @type {Object} */ (
      schedule.games.find((game) => game.date === AFFECTED_DATES[0] && game.format === '9v9')
    );
    const run = applyChangeRequest({
      schedule,
      changes: [
        {
          gameId: stranded.id,
          date: blackoutDate,
          surfaceId: season2026SurfaceId('Summit HS', 'Stadium'),
          startMinutes: stranded.startMinutes,
        },
      ],
      engines,
      verify: false,
      onUnsatisfiable: 'report',
    });
    const tbd = run.findings.filter(
      (finding) => finding.code === RESOLVE_REASON.RESOLVE_GAME_TIME_TBD
    );
    expect(tbd.length).toBeGreaterThan(0);
    expect(tbd[0].severity).toBe('compromise');
    expect(run.unplaced.length).toBeGreaterThan(0);
    expect(run.unplaced[0].reason).toMatch(/TIME TBD/);
    // Kept visible: the game is still in the run's own report even though it
    // has no slot.
    expect(baselineById.has(run.unplaced[0].gameId)).toBe(true);
  });
});

describe('the unsatisfiable error names violations by identity, never by substring', () => {
  /** The whole season as a state, so `checkPlacement` has real neighbours. */
  const state = createResolveState({
    games: schedule.games.map((game) => ({ ...game })),
    dispositions: Object.fromEntries(
      schedule.games.map((game) => [game.id, FREEZE_DISPOSITION.FROZEN])
    ),
    inventory: buildSlotInventory(schedule.games),
    ledger: createResolveLedger(),
  });

  /** Which games a violation actually names, by identity. */
  const namesGame = (violation, gameId) =>
    (violation.entities ?? []).some((entity) => entity.kind === 'game' && entity.id === gameId) ||
    violation.details?.gameId === gameId ||
    String(violation.subjectId ?? '')
      .split(/::|->|\|/)
      .includes(gameId);

  /**
   * A game whose id is a **strict prefix** of another game's id that the rule
   * engine reports on. Found in the corpus, not typed in: game ids are
   * `combined_schedule.csv#<n>`, so `#1` is a prefix of `#10`, `#108`, `#180`
   * and a dozen more.
   */
  const withViolations = new Set(
    baselineVerification.violations.flatMap((violation) =>
      (violation.entities ?? [])
        .filter((entity) => entity.kind === 'game')
        .map((entity) => entity.id)
    )
  );
  const trapped = /** @type {string} */ (
    schedule.games
      .map((game) => game.id)
      .sort()
      .find((id) => [...withViolations].some((other) => other !== id && other.startsWith(id)))
  );

  it('is asked about a game whose id is a prefix of other games that do have violations', () => {
    // The meta-assertion. Without a prefix collision in the corpus the test
    // below would pass against the broken code, which is the only failure mode
    // that matters here.
    expect(trapped).toBeTruthy();
    const substringMatched = baselineVerification.violations.filter(
      (violation) =>
        typeof violation.subjectId === 'string' && violation.subjectId.includes(trapped)
    );
    const identityMatched = baselineVerification.violations.filter((violation) =>
      namesGame(violation, trapped)
    );
    expect(identityMatched.length).toBeGreaterThan(0);
    expect(substringMatched.length).toBeGreaterThan(identityMatched.length);
  });

  it('carries only the violations that are about the game it names', () => {
    const game = /** @type {Object} */ (baselineById.get(trapped));
    const slot = { date: game.date, surfaceId: game.surfaceId, startMinutes: game.startMinutes };
    const error = frozenGameUnsatisfiable({
      state,
      gameId: trapped,
      slot,
      placement: checkPlacement(engines, state, trapped, slot),
      registry,
      verification: baselineVerification,
      ruleId: null,
      stageId: 'a-test',
    });

    // By game, never by count: name the strays rather than asserting a total.
    const strays = error.violations
      .filter((violation) => !namesGame(violation, trapped))
      .map((violation) => violation.subjectId);
    expect(strays).toEqual([]);
    // …and the counter an operator reads agrees with the list it came from.
    expect(error.meta.violationsReported).toBe(error.violations.length);
    expect(
      error.violations.length,
      'the error must not be as long as the substring filter made it'
    ).toBeLessThan(
      baselineVerification.violations.filter(
        (violation) =>
          typeof violation.subjectId === 'string' && violation.subjectId.includes(trapped)
      ).length
    );
    // The identity match is not merely narrower — it is complete.
    expect(error.violations.length).toBe(
      baselineVerification.violations.filter((violation) => namesGame(violation, trapped)).length
    );
  });
});

/* -------------------------------------------------------------------------- */
/* The slot inventory                                                          */
/* -------------------------------------------------------------------------- */

describe('the slot inventory cannot be extended by the code that reads it', () => {
  const run = applyChangeRequest({ schedule, changes, engines, verify: false });
  const thawedId = run.judgements.thawedGameIds[0];
  const game = /** @type {Object} */ (baselineById.get(thawedId));
  const venueId = run.state.inventory.venueBySurfaceId[game.surfaceId];
  const venueKey = `${game.date}|${venueId}`;
  /** A kickoff minute nothing in the corpus ever played at. */
  const invented = 3;

  it('is frozen all the way down, not only at the top', () => {
    // A shallow freeze here is invisible: `createResolveState()`'s deep freeze
    // stops at anything already frozen, so a shallow-frozen inventory is
    // skipped whole and its arrays stay writable.
    expect(Object.isFrozen(run.state.inventory)).toBe(true);
    expect(Object.isFrozen(run.state.inventory.kickoffsByDateVenue)).toBe(true);
    expect(Object.isFrozen(run.state.inventory.kickoffsByDateVenue[venueKey])).toBe(true);
    expect(Object.isFrozen(run.state.inventory.surfacesByDateVenueFormat)).toBe(true);
    expect(Object.isFrozen(run.state.inventory.dates)).toBe(true);
    expect(Object.isFrozen(run.state.inventory.venueBySurfaceId)).toBe(true);
  });

  it('refuses a pushed-in kickoff, and keeps refusing the slot it would have admitted', () => {
    // The anti-slot-inventor guarantee is one of the three things that stop
    // this package becoming a third scheduler. One `push()` used to revoke it:
    // the slot became admissible, `applyMove` accepted it, and because the
    // write went *through* the writer the move was ledgered and `freeze-audit`
    // saw nothing wrong with it.
    expect(run.state.inventory.kickoffsByDateVenue[venueKey]).not.toContain(invented);
    // The cast is the point: this is code that believes it may write, which is
    // what the type now says it may not and what the freeze now stops.
    const kickoffs = /** @type {number[]} */ (
      /** @type {unknown} */ (run.state.inventory.kickoffsByDateVenue[venueKey])
    );
    expect(() => kickoffs.push(invented)).toThrow(TypeError);

    const slot = { date: game.date, surfaceId: game.surfaceId, startMinutes: invented };
    expect(isSlotAdmissible(run.state, thawedId, slot)).toBe(false);
    expect(() =>
      applyMove(
        run.state,
        { gameId: thawedId, kind: MOVE_KIND.RELOCATE, to: slot, reason: 'an invented kickoff' },
        'a-stage-inventing-a-slot'
      )
    ).toThrow(/not in the baseline inventory/);
  });
});

/* -------------------------------------------------------------------------- */
/* "Does it break something new" is not the same question as "does it break    */
/* the same thing twice"                                                       */
/* -------------------------------------------------------------------------- */

describe('a candidate slot is judged on how often it breaks a rule, not whether', () => {
  /**
   * The corpus cannot produce this on its own — its only baseline blocking code
   * is `SIZE_UNKNOWN_FORMAT` on the four `Scrimmage` rows, one apiece — so the
   * case is **constructed** from real corpus rows and real corpus geometry.
   *
   * `Alder Park Pitch 1` is the parent of `Pitch 1A` and `Pitch 1B`. A game
   * standing on the parent conflicts with every child game standing under it at
   * the same time. Put one child game at the early kickoff and two at the late
   * one, and the parent game breaks `OCCUPIED_PARENT_CHILD` **once** where it
   * starts and **twice** where the change request wants to send it — with the
   * de-duplicated code set identical in both places, which is exactly why
   * comparing presence reads the move as harmless.
   */
  const P1 = season2026SurfaceId('Alder Park', 'Pitch 1');
  const date = AFFECTED_DATES[0];
  const onPitch1 = schedule.games
    .filter((row) => graph.surfaces[row.surfaceId].lineage.includes(P1) && row.date === date)
    .sort((a, b) => a.startMinutes - b.startMinutes || a.surfaceId.localeCompare(b.surfaceId));
  const kickoffs = [...new Set(onPitch1.map((row) => row.startMinutes))].sort((a, b) => a - b);
  const early = kickoffs[0];
  const late = kickoffs[kickoffs.length - 1];
  /** One child game at the early kickoff; both children at the late one. */
  const oneEarly = /** @type {Object} */ (
    onPitch1.find((row) => row.startMinutes === early && row.surfaceId.endsWith('1a'))
  );
  const bothLate = onPitch1.filter((row) => row.startMinutes === late);
  /** The game under test, lifted onto the parent surface at the early kickoff. */
  const source = /** @type {Object} */ (
    onPitch1.find((row) => row.startMinutes === early && row.surfaceId.endsWith('1b'))
  );
  const subject = {
    ...source,
    surfaceId: P1,
    startMinutes: early,
    endMinutes: early + (source.endMinutes - source.startMinutes),
  };
  const games = [subject, { ...oneEarly }, ...bothLate.map((row) => ({ ...row }))];

  const state = createResolveState({
    games,
    dispositions: Object.fromEntries(games.map((row) => [row.id, FREEZE_DISPOSITION.THAWED])),
    inventory: buildSlotInventory(games),
    ledger: createResolveLedger(),
  });
  const countsAt = (slot) => {
    const placement = checkPlacement(engines, state, subject.id, slot);
    /** @type {Record<string, number>} */
    const counts = {};
    for (const finding of placement.findings.filter((entry) => entry.severity === 'blocking')) {
      counts[finding.code] = (counts[finding.code] ?? 0) + 1;
    }
    return { codes: placement.blockingCodes, counts };
  };
  const here = countsAt({ date, surfaceId: P1, startMinutes: early });
  const there = countsAt({ date, surfaceId: P1, startMinutes: late });

  it('is built on a slot that breaks the same rule twice as often, and says so in the same words', () => {
    // The meta-assertion, and the reason this fixture is worth its length: the
    // two slots are *indistinguishable* by blocking-code set and differ by a
    // factor of two by count. A test whose two slots differed in their code
    // sets would be testing nothing.
    expect(bothLate).toHaveLength(2);
    expect(new Set(bothLate.map((row) => row.surfaceId)).size).toBe(2);
    expect(here.codes).toEqual(there.codes);
    expect(here.codes).toHaveLength(1);
    expect(Object.values(here.counts)).toEqual([1]);
    expect(Object.values(there.counts)).toEqual([2]);
  });

  it('refuses to place a game on it, rather than reading the identical code set as no change', () => {
    const target = `${date}|${P1}|${late}`;
    const run = applyChangeRequest({
      schedule: { ...schedule, games },
      changes: [{ gameId: subject.id, date, surfaceId: P1, startMinutes: late }],
      engines,
      verify: false,
      onUnsatisfiable: 'report',
    });

    // `initial-assignment` is offered the requested slot first — it is the
    // anchor — and must reject it and fall back rather than accepting a slot
    // that breaks the same rule twice as often as the one it came from.
    const replaced = /** @type {Object} */ (
      run.findings.find((finding) => finding.code === RESOLVE_REASON.RESOLVE_GAME_REPLACED)
    );
    expect(replaced).toBeTruthy();
    expect(replaced.details.slot).not.toBe(target);
    expect(run.meta.candidatesRejected).toBeGreaterThan(0);
    // …and no stage put it there at any point in the run, by move, not by
    // final position.
    expect(
      run.moves
        .filter((move) => move.gameId === subject.id && move.stageId !== 'change-request-apply')
        .map((move) => (move.to === null ? '(unplaced)' : slotOf(move.to)))
    ).not.toContain(target);
  });
});

/* -------------------------------------------------------------------------- */
/* One test per stage                                                          */
/* -------------------------------------------------------------------------- */

describe('one adversarial probe per stage', () => {
  const date = AFFECTED_DATES[0];
  const slice = schedule.games.filter(
    (game) => game.date === date && game.venueId === 'alder-park'
  );
  const pitch2 = season2026SurfaceId('Alder Park', 'Pitch 2');
  const pitch3 = season2026SurfaceId('Alder Park', 'Pitch 3');
  const kickoffs = [...new Set(slice.map((game) => game.startMinutes))].sort((a, b) => a - b);
  const clashGame = /** @type {Object} */ (
    slice.find((game) => game.surfaceId === pitch2 && game.startMinutes === kickoffs[2])
  );
  const pendingGame = /** @type {Object} */ (
    slice.find((game) => game.surfaceId === pitch3 && game.startMinutes === kickoffs[1])
  );
  const changeGame = /** @type {Object} */ (
    slice.find((game) => game.surfaceId === pitch2 && game.startMinutes === kickoffs[1])
  );

  const probeInput = {
    engines,
    games: slice,
    baseSchedule: schedule,
    // Push the 12:00 fixture onto the published 12:30, which overlaps the 9v9
    // block: the same clash the whole prompt turns on, in miniature.
    clash: { gameId: clashGame.id, slot: { date, surfaceId: pitch2, startMinutes: 750 } },
    pendingGameId: pendingGame.id,
    change: { gameId: changeGame.id, slot: { date, surfaceId: pitch2, startMinutes: kickoffs[0] } },
  };
  const results = probeEveryStage(RESOLVE_STAGES, probeInput);

  it('runs on a slice that is real and adversarial', () => {
    expect(slice.length).toBeGreaterThan(8);
    expect(new Set(slice.map((game) => game.format))).toEqual(new Set(['9v9', '11v11']));
    expect(graph.overlapBySurface[pitch2].length).toBeGreaterThan(0);
    expect(results).toHaveLength(8);
    expect(results.map((result) => result.stageId)).toEqual(
      RESOLVE_STAGES.map((stage) => stage.id)
    );
  });

  for (const stage of RESOLVE_STAGES) {
    it(`${stage.id} honours the freeze`, () => {
      const result = /** @type {Object} */ (
        results.find((candidate) => candidate.stageId === stage.id)
      );
      expect(result.failures).toEqual([]);
      expect(result.satisfied).toBe(true);
      expect(result.moved).toEqual([]);
      expect(result.movesApplied).toBe(0);
      if (stage.freezeContract.probe === STAGE_PROBE.OFFERS_FROZEN_MOVE) {
        // The teeth. Without this a stage that never looked passes.
        expect(result.movesRejectedByFreeze).toBeGreaterThan(0);
      } else {
        expect(result.movesConsidered).toBe(0);
      }
    });
  }

  it('fails a stage that ignores the freeze — the probe’s own positive control', () => {
    // Incident 2, rebuilt: a repair pass that swaps two games without asking.
    // If the probe cannot fail against this, none of the eight tests above
    // means anything.
    const leaky = ResolveStageSchema.parse({
      id: 'leaky-repair',
      title: 'A pass that swaps without asking, exactly as incident 2 records',
      freezeContract: {
        mutationKinds: [MOVE_KIND.RELOCATE],
        probe: STAGE_PROBE.OFFERS_FROZEN_MOVE,
        claim: 'claims to honour the freeze and does not consult it at all',
      },
      run(state) {
        const target = state.gameIds.find((id) => state.games[id]);
        const game = state.games[target];
        return {
          ...state,
          games: {
            ...state.games,
            [target]: { ...game, startMinutes: game.startMinutes + 5 },
          },
        };
      },
    });
    const result = probeStage(leaky, { ...probeInput, stages: RESOLVE_STAGES });
    expect(result.satisfied).toBe(false);
    expect(result.moved.length).toBeGreaterThan(0);
    expect(result.failures.join(' ')).toMatch(/moved 1 frozen game/);
  });

  it('fails a stage that moves nothing because it never looked', () => {
    // The subtler failure, and the reason the rejection counter exists: this
    // stage passes "no frozen game moved" perfectly and is still broken.
    const blind = ResolveStageSchema.parse({
      id: 'blind-repair',
      title: 'A pass that returns the state untouched without ever consulting the freeze',
      freezeContract: {
        mutationKinds: [MOVE_KIND.RELOCATE],
        probe: STAGE_PROBE.OFFERS_FROZEN_MOVE,
        claim: 'claims to consider moves and considers none',
      },
      run: (state) => state,
    });
    const result = probeStage(blind, { ...probeInput, stages: RESOLVE_STAGES });
    expect(result.moved).toEqual([]);
    expect(result.movesApplied).toBe(0);
    expect(result.satisfied).toBe(false);
    expect(result.failures.join(' ')).toMatch(/rejection counter did not move/);
  });

  it('refuses a probe whose setup would examine nothing', () => {
    expect(() =>
      probeStage(RESOLVE_STAGES[1], {
        ...probeInput,
        change: { gameId: pendingGame.id, slot: probeInput.change.slot },
        stages: RESOLVE_STAGES,
      })
    ).toThrow(/lifted out of the schedule/);
    expect(() =>
      probeStage(RESOLVE_STAGES[1], {
        ...probeInput,
        change: { gameId: clashGame.id, slot: probeInput.change.slot },
        stages: RESOLVE_STAGES,
      })
    ).toThrow(/pushed into a clash/);
    expect(() =>
      probeStage(RESOLVE_STAGES[1], {
        ...probeInput,
        pendingGameId: 'no-such-game',
        stages: RESOLVE_STAGES,
      })
    ).toThrow(/not in the game slice/);
    // A missing setup is a deliberate refusal, not a bare TypeError.
    expect(() =>
      probeStage(RESOLVE_STAGES[1], { ...probeInput, clash: undefined, stages: RESOLVE_STAGES })
    ).toThrow(/needs a `clash`/);
    expect(() =>
      probeStage(RESOLVE_STAGES[1], {
        ...probeInput,
        pendingGameId: undefined,
        stages: RESOLVE_STAGES,
      })
    ).toThrow(/needs a `pendingGameId`/);
    expect(() =>
      probeStage(RESOLVE_STAGES[1], {
        ...probeInput,
        stages: RESOLVE_STAGES.filter((stage) => stage.id !== 'baseline-ingest'),
      })
    ).toThrow(/needs the baseline-ingest stage/);
  });
});

/* -------------------------------------------------------------------------- */
/* The mutation chokepoint                                                     */
/* -------------------------------------------------------------------------- */

describe('the one writer', () => {
  const run = applyChangeRequest({ schedule, changes, engines, verify: false });

  it('throws when a stage reaches it holding a frozen game, naming the stage', () => {
    const frozenId = run.judgements.frozenGameIds[0];
    const game = /** @type {Object} */ (baselineById.get(frozenId));
    let error = null;
    try {
      applyMove(
        run.state,
        {
          gameId: frozenId,
          kind: MOVE_KIND.RELOCATE,
          to: { date: game.date, surfaceId: game.surfaceId, startMinutes: game.startMinutes + 1 },
          reason: 'a stage that did not ask',
        },
        'a-stage-that-did-not-ask'
      );
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(FrozenGameMoveAttempt);
    const raised = /** @type {any} */ (error);
    expect(raised.stageId).toBe('a-stage-that-did-not-ask');
    expect(raised.gameId).toBe(frozenId);
    expect(raised.message).toContain('has NOT been moved');
    // And the state is unchanged, because nothing was written.
    expect(run.state.games[frozenId].startMinutes).toBe(game.startMinutes);
  });

  it('refuses a slot the baseline never used', () => {
    const thawedId = run.judgements.thawedGameIds[0];
    const game = /** @type {Object} */ (baselineById.get(thawedId));
    expect(() =>
      applyMove(
        run.state,
        {
          gameId: thawedId,
          kind: MOVE_KIND.RELOCATE,
          to: { date: game.date, surfaceId: game.surfaceId, startMinutes: 3 },
          reason: 'a slot nobody ever played on',
        },
        'a-stage-inventing-a-slot'
      )
    ).toThrow(/not in the baseline inventory/);
  });

  it('offers a change request its own slot back, as well as the inventory', () => {
    // The writer admits a slot a change request named; a placer that could not
    // offer it would be able to accept a slot it could never propose, and a
    // game lifted back out of its requested slot could never return to it.
    const requested = /** @type {Object} */ (changes[0]);
    const anchor = {
      date: requested.date,
      surfaceId: requested.surfaceId,
      startMinutes: requested.startMinutes,
    };
    const candidates = candidateSlotsFor(
      run.state,
      requested.gameId,
      anchor,
      RESOLVE_OBJECTIVE_WEIGHTS
    );
    expect(candidates.length).toBeGreaterThan(1);
    expect(candidates.map(slotOf)).toContain(slotOf(anchor));
    // …and only for the game it was named for.
    const other = /** @type {string} */ (
      run.judgements.frozenGameIds.find((id) => baselineById.get(id)?.date === requested.date)
    );
    expect(
      candidateSlotsFor(run.state, other, anchor, RESOLVE_OBJECTIVE_WEIGHTS).map(slotOf)
    ).not.toContain(slotOf(anchor));
  });

  it('gives a relocated game the venue it is actually standing at', () => {
    // A change request may name a surface no baseline row ever used. That
    // surface enters the venue lookup — a fact about the facility graph — and
    // never the placer's candidate surfaces.
    const elsewhere = season2026SurfaceId('Summit HS', 'Stadium');
    const slice = schedule.games.filter(
      (game) => game.date === AFFECTED_DATES[0] && game.venueId === 'alder-park'
    );
    const inventory = buildSlotInventory(slice, {
      surfaceVenues: { [elsewhere]: 'summit-hs' },
    });
    expect(inventory.venueBySurfaceId[elsewhere]).toBe('summit-hs');
    for (const surfaces of Object.values(inventory.surfacesByDateVenueFormat)) {
      expect(surfaces).not.toContain(elsewhere);
    }

    const target = slice[0];
    const slot = {
      date: target.date,
      surfaceId: elsewhere,
      startMinutes: target.startMinutes,
    };
    const state = createResolveState({
      games: slice,
      dispositions: Object.fromEntries(slice.map((game) => [game.id, FREEZE_DISPOSITION.THAWED])),
      admittedSlotsByGameId: {
        [target.id]: [`${slot.date}|${slot.surfaceId}|${slot.startMinutes}`],
      },
      inventory,
      ledger: createResolveLedger(),
    });
    const moved = applyMove(
      state,
      { gameId: target.id, kind: MOVE_KIND.RELOCATE, to: slot, reason: 'a venue it never used' },
      'a-test'
    );
    expect(moved.games[target.id].venueId).toBe('summit-hs');
    expect(moved.games[target.id].surfaceId).toBe(elsewhere);
  });

  it('refuses a change request that names one game twice', () => {
    expect(() =>
      applyChangeRequest({
        schedule,
        changes: [changes[0], { ...changes[0], startMinutes: changes[0].startMinutes + 5 }],
        engines,
        verify: false,
      })
    ).toThrow(/same game more than once/);
  });

  it('hands back deep-frozen state, so nothing can be edited in place', () => {
    expect(Object.isFrozen(run.state)).toBe(true);
    expect(Object.isFrozen(run.state.games)).toBe(true);
    const first = run.state.games[run.state.gameIds[0]];
    expect(Object.isFrozen(first)).toBe(true);
    expect(() => {
      'use strict';
      first.startMinutes = 1;
    }).toThrow();
    // The ledger is the one deliberate exception, and it is a recorder rather
    // than placement data.
    expect(Object.isFrozen(run.state.ledger)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* freeze-audit as a runtime stage, with its own positive control              */
/* -------------------------------------------------------------------------- */

describe('freeze-audit runs in the pipeline, not in a test', () => {
  it('catches a stage that reaches around the gate', () => {
    // **The audit's positive control.** Deep-freezing the state stops a stage
    // editing a placement in place; it does not stop one *returning a state it
    // built itself*, which is what this one does. An audit that cannot catch
    // that is not worth having, and the only way to know is to hand it one.
    const rogue = {
      id: 'rogue-swap',
      title: 'A stage that writes without going through the writer',
      freezeContract: {
        mutationKinds: [MOVE_KIND.RELOCATE],
        probe: STAGE_PROBE.OFFERS_FROZEN_MOVE,
        claim: 'claims to honour the freeze and reaches around the writer instead',
      },
      run(state) {
        const target = state.gameIds.find(
          (id) => state.dispositions[id] === FREEZE_DISPOSITION.FROZEN && state.games[id]
        );
        const game = state.games[target];
        return {
          ...state,
          games: { ...state.games, [target]: { ...game, startMinutes: game.startMinutes + 5 } },
        };
      },
    };
    const run = applyChangeRequest({
      schedule,
      changes,
      engines,
      extraStages: [rogue],
      verify: false,
    });

    const movedFinding = run.findings.find(
      (finding) => finding.code === RESOLVE_REASON.RESOLVE_AUDIT_FROZEN_GAME_MOVED
    );
    expect(movedFinding?.severity).toBe('blocking');
    expect(baselineById.has(/** @type {string} */ (movedFinding?.details.gameId))).toBe(true);

    const bypass = run.findings.find(
      (finding) => finding.code === RESOLVE_REASON.RESOLVE_AUDIT_STAGE_BYPASSED_GATE
    );
    expect(bypass?.severity).toBe('blocking');
    expect(bypass?.details.stageId).toBe('rogue-swap');
    expect(bypass?.details.gameCount).toBe(1);

    expect(run.status).toBe('rejected');
    // The run still reports the moved game by name in its own diff, because the
    // diff is taken from the baseline rather than from the ledger the rogue
    // stage never wrote to.
    expect(run.moved.some((change) => change.gameId === movedFinding?.details.gameId)).toBe(true);
  });

  it('catches a stage that writes while declaring that it does not', () => {
    const liar = {
      id: 'quiet-writer',
      title: 'A stage that declares no mutation kinds and writes anyway',
      freezeContract: {
        mutationKinds: [],
        probe: STAGE_PROBE.WRITES_NOTHING,
        claim: 'declares that it writes nothing, and writes',
      },
      run(state) {
        const target = state.gameIds.find((id) => state.games[id]);
        const game = state.games[target];
        return {
          ...state,
          games: { ...state.games, [target]: { ...game, startMinutes: game.startMinutes + 5 } },
        };
      },
    };
    const run = applyChangeRequest({
      schedule,
      changes,
      engines,
      extraStages: [liar],
      verify: false,
    });
    const finding = run.findings.find(
      (candidate) => candidate.code === RESOLVE_REASON.RESOLVE_AUDIT_STAGE_WROTE_WITHOUT_DECLARING
    );
    expect(finding?.severity).toBe('blocking');
    expect(finding?.details.stageId).toBe('quiet-writer');
  });

  it('says nothing at all when every stage behaved', () => {
    // The negative control for the two above: the audit must be silent on a
    // clean run, or its blocking findings would mean nothing.
    const run = applyChangeRequest({ schedule, changes, engines, verify: false });
    expect(run.findings.filter((finding) => finding.code.startsWith('RESOLVE_AUDIT'))).toEqual([]);
    expect(run.meta.gamesAudited).toBe(679);
  });

  it('holds a pinned game to where it was pinned, not to where the run began', () => {
    // `holdChanges` freezes the change-request games **mid-run, after they have
    // already moved** — that is the whole point of it. Measuring those games
    // against the baseline reports every one of them as a frozen game that
    // moved, at blocking, on the ordinary path. A backstop that cries wolf on
    // its own happy path teaches the next reader to ignore it, and this is the
    // one check in the package that must never be ignored.
    const run = applyChangeRequest({
      schedule,
      changes,
      engines,
      holdChanges: true,
      onUnsatisfiable: 'report',
      verify: false,
    });

    // Meta-assertions first: a run that pinned nothing, or that pinned games
    // which had not moved, would pass the assertion below for the worst
    // possible reason.
    const pinned = /** @type {Object} */ (
      run.findings.find((finding) => finding.code === RESOLVE_REASON.RESOLVE_CHANGE_PINNED)
    );
    expect(pinned).toBeTruthy();
    expect(pinned.details.gameCount).toBeGreaterThan(0);
    const relocated = run.moves
      .filter((move) => move.stageId === 'change-request-apply')
      .map((move) => move.gameId);
    expect(relocated).toHaveLength(/** @type {number} */ (pinned.details.gameCount));
    for (const gameId of relocated) {
      expect(slotOf(run.state.games[gameId]), gameId).not.toBe(slotOf(baselineById.get(gameId)));
    }

    // The defect: every one of those games was reported as a frozen game that
    // moved, at blocking, making every `holdChanges` run unconditionally
    // rejected for doing exactly what it was asked to do.
    expect(
      run.findings
        .filter((finding) => finding.code === RESOLVE_REASON.RESOLVE_AUDIT_FROZEN_GAME_MOVED)
        .map((finding) => finding.details.gameId)
    ).toEqual([]);

    // …and the reference the audit now holds them to is recorded on the state,
    // game by game, rather than inferred.
    expect(Object.keys(run.state.pinnedAt).sort()).toEqual([...relocated].sort());
    for (const [gameId, slot] of Object.entries(run.state.pinnedAt)) {
      expect(slot, gameId).toBe(slotOf(run.state.games[gameId]));
    }
  });

  it('still catches a game moved after it was pinned', () => {
    // The other direction, and the one that would make the fix above a trade of
    // a false positive for a false negative. A pinned game is frozen, so the
    // writer refuses it; the only way to move one is to reach around the gate,
    // which is exactly the case the audit exists for.
    const pinnedIds = changes.map((change) => change.gameId);
    const rogue = {
      id: 'rogue-unpin',
      title: 'A stage that moves a game that was pinned before it ran',
      freezeContract: {
        mutationKinds: [MOVE_KIND.RELOCATE],
        probe: STAGE_PROBE.OFFERS_FROZEN_MOVE,
        claim: 'claims to honour the pin and reaches around the writer instead',
      },
      run(state) {
        // A game the change request relocated and `holdChanges` then pinned.
        // Named from the request rather than from the state, so this stage is
        // the same stage with or without the fix under test.
        const target = /** @type {string} */ (
          pinnedIds.find(
            (id) => state.games[id] && state.dispositions[id] === FREEZE_DISPOSITION.FROZEN
          )
        );
        const game = state.games[target];
        return {
          ...state,
          games: { ...state.games, [target]: { ...game, startMinutes: game.startMinutes + 5 } },
        };
      },
    };
    const run = applyChangeRequest({
      schedule,
      changes,
      engines,
      holdChanges: true,
      onUnsatisfiable: 'report',
      extraStages: [rogue],
      verify: false,
    });

    const moved = run.findings.filter(
      (finding) => finding.code === RESOLVE_REASON.RESOLVE_AUDIT_FROZEN_GAME_MOVED
    );
    // Exactly one: the rogue stage's victim, and nothing else the change
    // request legitimately relocated.
    expect(moved.map((finding) => finding.details.gameId)).toHaveLength(1);
    expect(moved[0].severity).toBe('blocking');
    expect(pinnedIds).toContain(moved[0].details.gameId);
    // …and it is held to the pin, not to the baseline, in the finding itself.
    expect(moved[0].details.heldFrom).toBe('pinned');
    expect(moved[0].details.beforeSlot).toBe(
      run.state.pinnedAt[/** @type {string} */ (moved[0].details.gameId)]
    );
    expect(moved[0].details.afterSlot).not.toBe(moved[0].details.beforeSlot);
    // The stage that did it is named too — the audit's other half.
    expect(
      run.findings.some(
        (finding) =>
          finding.code === RESOLVE_REASON.RESOLVE_AUDIT_STAGE_BYPASSED_GATE &&
          finding.details.stageId === 'rogue-unpin'
      )
    ).toBe(true);
    expect(run.status).toBe('rejected');
  });
});

/* -------------------------------------------------------------------------- */
/* Structural guarantees                                                       */
/* -------------------------------------------------------------------------- */

describe('structural guarantees', () => {
  const CORE = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'packages',
    'core',
    'src'
  );

  /**
   * @param {string} dir
   * @returns {string[]}
   */
  function filesUnder(dir) {
    /** @type {string[]} */
    const files = [];
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) files.push(...filesUnder(full));
      else if (entry.endsWith('.js')) files.push(full);
    }
    return files;
  }

  const freezeFiles = filesUnder(path.join(CORE, 'freeze'));
  const resolveFiles = filesUnder(path.join(CORE, 'resolve'));
  const sources = [...freezeFiles, ...resolveFiles].map((file) => ({
    file,
    text: readFileSync(file, 'utf8'),
  }));

  it('scans a plausible number of files', () => {
    // The meta-assertion the rest of this block rests on.
    expect(freezeFiles.length).toBeGreaterThanOrEqual(5);
    expect(resolveFiles.length).toBeGreaterThanOrEqual(9);
  });

  it('never imports gameScheduling.js, and is never imported by it', () => {
    for (const { file, text } of sources) {
      expect(text.includes("from '../gameScheduling.js'"), file).toBe(false);
      expect(text.includes("from '../../gameScheduling.js'"), file).toBe(false);
      expect(/from '.*autoScheduler\.js'/.test(text), file).toBe(false);
      expect(/from '.*gameMetrics\.js'/.test(text), file).toBe(false);
      expect(/from '.*placement\//.test(text), file).toBe(false);
    }
    const gameScheduling = readFileSync(path.join(CORE, 'gameScheduling.js'), 'utf8');
    expect(/from '\.\/(resolve|freeze)\//.test(gameScheduling)).toBe(false);
  });

  it('exports nothing that could be mistaken for a season generator', () => {
    const barrels = [path.join(CORE, 'freeze', 'index.js'), path.join(CORE, 'resolve', 'index.js')];
    /** @type {string[]} */
    const names = [];
    for (const barrel of barrels) {
      const text = readFileSync(barrel, 'utf8');
      for (const match of text.matchAll(/export \{([^}]*)\}/g)) {
        for (const raw of match[1].split(',')) {
          const name = raw
            .trim()
            .split(/\s+as\s+/)
            .pop();
          if (name) names.push(name);
        }
      }
    }
    expect(names.length).toBeGreaterThan(20);
    for (const name of names) {
      expect(/^(schedule|generate)/.test(name), name).toBe(false);
    }
    // And nothing in the packages defines a round robin.
    for (const { file, text } of sources) {
      expect(/roundRobin/i.test(text), file).toBe(false);
    }
  });

  it('constructs no Date anywhere', () => {
    for (const { file, text } of sources) {
      expect(/new Date\b/.test(text), file).toBe(false);
      expect(/Date\.now\b/.test(text), file).toBe(false);
      expect(/toISOString/.test(text), file).toBe(false);
    }
  });

  it('has exactly one export that can produce a thawed default, and it is named for it', () => {
    /** @type {Array<{ file: string, name: string }>} */
    const producers = [];
    for (const { file, text } of sources) {
      for (const match of text.matchAll(/defaultDisposition:\s*FREEZE_DISPOSITION\.THAWED/g)) {
        const before = text.slice(0, match.index);
        const declarations = [...before.matchAll(/export function (\w+)/g)];
        const name = declarations.length > 0 ? declarations[declarations.length - 1][1] : '(none)';
        producers.push({ file, name });
      }
    }
    expect(producers).toHaveLength(1);
    expect(producers[0].name).toMatch(/reoptimis/i);
    // The plain string form would slip past the check above, so it is refused
    // outright in *code*: the enum is the only way to say it. Block comments
    // are stripped first, because the prose in `freeze/schemas.js` quotes the
    // literal in order to explain the rule.
    for (const { file, text } of sources) {
      const code = text.replace(/\/\*[\s\S]*?\*\//g, '');
      expect(/defaultDisposition:\s*['"]thawed['"]/.test(code), file).toBe(false);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* The refusal guard on the legacy engine                                      */
/* -------------------------------------------------------------------------- */

describe('scheduleGames() refuses a freeze rather than ignoring one', () => {
  const teams = [
    { id: 'a', name: 'A', division: 'U10', coachId: 'c1' },
    { id: 'b', name: 'B', division: 'U10', coachId: 'c2' },
  ];
  const slots = [
    {
      id: 's1',
      division: 'U10',
      weekIndex: 1,
      // Zone-carrying, because `SlotSchema` now refuses a naive wall reading
      // (GAP-30). This fixture was the suite's one naive slot, and it passed
      // only by every runner agreeing to guess the same way.
      start: '2026-08-22T09:00:00Z',
      end: '2026-08-22T10:00:00Z',
      capacity: 1,
      fieldId: 'f1',
    },
  ];
  const roundRobinByDivision = {
    U10: [{ weekIndex: 1, matchups: [{ homeTeamId: 'a', awayTeamId: 'b' }], byes: [] }],
  };

  it('still works exactly as before when no freeze is supplied', () => {
    const result = scheduleGames({ teams, slots, roundRobinByDivision });
    expect(result.assignments.length + result.unscheduled.length).toBe(1);
  });

  it('throws, and points at the module that can honour one', () => {
    let error = null;
    try {
      scheduleGames({ teams, slots, roundRobinByDivision, freeze: freezeForChanges(changes) });
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(TypeError);
    const raised = /** @type {any} */ (error);
    expect(raised.message).toContain('resolve/applyChangeRequest()');
    expect(raised.message).toContain('resolve/reoptimiseWholeSeason()');
    expect(raised.message).toContain('GAP-35');
    expect(raised.message).toContain('GAP-32');
    // It refuses `null` too: "no freeze" is not something a caller says by
    // passing a falsy value.
    expect(() => scheduleGames({ teams, slots, roundRobinByDivision, freeze: null })).toThrow(
      TypeError
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Cross-module seam: where a caller-supplied stage sits in the pipeline        */
/* -------------------------------------------------------------------------- */

/**
 * **Finding 4 — a caller-supplied stage's moves were never verified.**
 *
 * `buildResolvePipeline()` inserted `extraStages` between `verify` and
 * `freeze-audit`. Everything about that reads as deliberate — the audit does
 * have to run last — but it put the one class of stage nobody in this
 * repository wrote **after** the only stage that checks the result. A move an
 * extra stage applied was therefore never judged by the standing rule engine,
 * and the run reported the violations of a schedule that no longer existed.
 *
 * It was worse than a stale number, because of the cache key. `runVerification`
 * keys on `ledger.moves.length`, and the run's own
 * `verification: context.verificationCache.get(ledger.moves.length) ?? null`
 * is read **after** the pipeline. An extra stage that applied even one move
 * pushed the final count past the key `verify` had cached under, so the lookup
 * missed and `run.verification` came back **`null`** — indistinguishable from
 * `verify: false`. A caller who asked for verification, and whose stage moved a
 * game, was handed "no verification" with nothing anywhere saying so.
 *
 * `freeze-audit` still runs last; it writes no placement, so it cannot move the
 * key out from under the lookup.
 */
describe('a caller-supplied stage is verified, because it runs before verify', () => {
  /**
   * A **compliant** extra stage: it goes through `applyMove()`, the one writer,
   * and moves a game the change request thawed onto a slot the baseline
   * inventory already holds — another game's. That is a real clash, so the
   * standing rule engine has something to say about it, which is what makes
   * "was this move verified?" an answerable question rather than a hopeful one.
   */
  function collidingStage() {
    /** @type {{ gameId: string|null, slot: Object|null }} */
    const observed = { gameId: null, slot: null };
    const stage = {
      id: 'extra-collide',
      title: 'A caller-supplied stage that relocates one thawed game onto occupied ground',
      freezeContract: {
        mutationKinds: [MOVE_KIND.RELOCATE],
        probe: STAGE_PROBE.OFFERS_FROZEN_MOVE,
        claim:
          'relocates a single thawed game through applyMove(), asking the freeze exactly as any core stage does',
      },
      run(state) {
        const gameId = state.gameIds.find(
          (id) => state.dispositions[id] === FREEZE_DISPOSITION.THAWED && state.games[id]
        );
        if (gameId === undefined) return state;
        const mine = state.games[gameId];
        // Somebody else's ground, on somebody else's date: a slot the inventory
        // certainly holds, occupied by a game that is certainly not this one.
        const host = state.gameIds
          .map((id) => state.games[id])
          .find(
            (game) =>
              game &&
              game.id !== gameId &&
              game.date === mine.date &&
              (game.surfaceId !== mine.surfaceId || game.startMinutes !== mine.startMinutes)
          );
        if (host === undefined) return state;
        const to = { date: host.date, surfaceId: host.surfaceId, startMinutes: host.startMinutes };
        observed.gameId = gameId;
        observed.slot = to;
        return applyMove(
          state,
          {
            gameId,
            kind: MOVE_KIND.RELOCATE,
            to,
            reason: 'the regression for finding 4: a caller-supplied stage that actually moves',
            cause: null,
          },
          this.id
        );
      },
    };
    return { stage, observed };
  }

  it('inserts an extra stage before verify, and still runs the audit last', () => {
    const ids = buildResolvePipeline([
      {
        id: 'extra',
        title: 'x',
        freezeContract: {
          mutationKinds: [],
          probe: STAGE_PROBE.WRITES_NOTHING,
          claim: 'a claim long enough to say something',
        },
        run: (state) => state,
      },
    ]).map((stage) => stage.id);
    // The original claim, kept: an extra stage lands before the audit.
    expect(ids.indexOf('extra')).toBeLessThan(ids.indexOf('freeze-audit'));
    // …and the claim it did not make, which is the defect: before `verify` too.
    expect(ids.indexOf('extra')).toBeLessThan(ids.indexOf('verify'));
    expect(ids.slice(-3)).toEqual(['extra', 'verify', 'freeze-audit']);
    expect(ids[ids.length - 1]).toBe('freeze-audit');
  });

  it('verifies the schedule the extra stage left behind, rather than reporting nothing', () => {
    const { stage, observed } = collidingStage();
    const run = applyChangeRequest({
      schedule,
      changes,
      engines,
      baselineVerification,
      extraStages: [stage],
    });

    // Meta-assertions. Without these the two below would pass on a stage that
    // never ran, never moved anything, or moved something nobody could see.
    expect(observed.gameId, 'the extra stage found a thawed game to move').not.toBeNull();
    expect(run.stages.find((entry) => entry.stageId === 'extra-collide')?.movesApplied).toBe(1);
    expect(run.moves.some((move) => move.stageId === 'extra-collide')).toBe(true);

    // The defect, in one line: the cache key moved past what `verify` stored.
    expect(run.verification, 'a run asked to verify must produce a verification').not.toBeNull();

    // And it is a verification of the schedule that came out, not of the one
    // that existed before the extra stage wrote to it. Re-derived independently
    // from the run's own result: same engines, same rules, same answer.
    const independent = runRuleEngine(run.schedule, { registry, resources });
    const shapeOf = (verification) =>
      verification.violations
        .map((v) => `${v.code}|${v.severity}|${v.subjectId ?? ''}`)
        .sort()
        .join('\n');
    expect(shapeOf(run.verification)).toBe(shapeOf(independent));
  });

  it('the same run without the extra stage verifies too — so the assertion is about the stage', () => {
    // The negative control. If `run.verification` were null on an ordinary run
    // as well, the assertion above would be about verification in general
    // rather than about where a caller-supplied stage sits.
    const plain = applyChangeRequest({ schedule, changes, engines, baselineVerification });
    expect(plain.verification).not.toBeNull();
  });
});
