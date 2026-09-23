/**
 * Tests for the standing rule engine (`packages/core/src/ruleEngine/`) —
 * Prompt 2.3.
 *
 * The centrepiece is `describe('incident 4, reproduced')`. Everything else in
 * this file exists to make those two tests mean something.
 *
 * **The corpus is the fixture, and the mutations are made in memory.** The
 * known-good run asserts the published season-2026 schedule produces exactly
 * one enumerated set of accepted exceptions — each one traced to a line of
 * `fixtures/season-2026/README.md` or a documented gap — and the two break
 * tests then damage that same input in the two ways incident 4 records:
 *
 * 1. **The team-name format change.** `U12B04` -> `12B9v904`-style codes made
 *    the coach validator's join match zero person-pairs, and it reported zero
 *    conflicts. Here the roster's team codes are renamed back to the old style,
 *    the join empties, and the engine reports a `blocking`
 *    `RULE_EXERCISE_BELOW_MINIMUM` — **not** a shorter, cleaner list of
 *    violations, which is exactly what it would otherwise produce.
 * 2. **Placeholder labels read as team codes.** The corpus is full of cells
 *    that are not team codes — `-`, `MinisA`..`MinisD`, `Select Game N`,
 *    `Scrimmage - teams TBD`, `Visiting Club A - U14B South` — and a checker
 *    that reads them as ids reports violations that do not exist. Here the
 *    schedule is rebuilt taking ids straight from the labels, phantom
 *    violations duly appear, and the engine reports a `blocking`
 *    `RULE_MATCHED_PLACEHOLDER` before anybody can act on them.
 *
 * Meta-assertion discipline (incident 4 again, one level up): every
 * behavioural check here also asserts it examined a non-zero number of
 * records, and every mutation asserts that it actually mutated something —
 * a break test whose break silently failed to apply would be the same bug
 * wearing a test's clothes.
 */

import { describe, it, expect } from 'vitest';

import {
  buildAvailabilityCalendarFromSeason2026,
  AVAILABILITY_REASON,
} from '@squadlogic/core/availability/index.js';
import {
  CONSTRAINT_REASON,
  CONSTRAINT_SCOPE_KIND,
  CONSTRAINT_TYPE,
  SEASON_2026_CONSTRAINT_ID,
  buildConstraintRegistry,
  buildSeason2026ConstraintRegistry,
  requireConstraint,
  retypeConstraint,
} from '@squadlogic/core/constraints/index.js';
import {
  FACILITY_REASON,
  buildFacilityGraphFromSeason2026,
  buildSeason2026VenueComplexMap,
  complexIdOf,
  sameVenueComplex,
  season2026VenueId,
} from '@squadlogic/core/facility/index.js';
import {
  buildCoachTimelines,
  findSingleCoachGames,
  loadFacilityGeometry,
  loadFacilityPermits,
  loadGameFormats,
  loadSeason2026,
  loadSunsets,
} from '@squadlogic/core/fixtures/index.js';
import {
  TIMING_REASON,
  buildFormatTimingTableFromSeason2026,
} from '@squadlogic/core/timing/index.js';
import {
  SEASON_2026_WAIVER_ID,
  TRAVEL_REASON,
  WAIVER_DISPOSITION,
  WAIVER_REASON,
  buildSeason2026WaiverLedger,
  buildWaiverLedger,
} from '@squadlogic/core/waivers/index.js';

import {
  RULE_ID,
  RULE_IDENTIFIER_KIND,
  RULE_REASON,
  RULE_REASON_SEVERITY,
  RULE_SEVERITY,
  RULE_STATUS,
  RULE_VIOLATION_REASON,
  RULE_VIOLATION_SEVERITY,
  RuleDefinitionSchema,
  SEVERITY_ORDER,
  STANDING_RULES,
  buildRuleEngine,
  buildStandingRuleEngine,
  buildValidationReport,
  checkIdentifiers,
  checkMinimums,
  constraintIdsByReasonCode,
  judgeExercise,
  makeRuleFinding,
  renderValidationReport,
  ruleCoverage,
  ruleSeverityOf,
  runRuleEngine,
  season2026AgeGroup,
  summariseComputed,
  toSeason2026Schedule,
  universeOf,
  violationSeverityOf,
} from '@squadlogic/core/ruleEngine/index.js';

/* -------------------------------------------------------------------------- */
/* The corpus, loaded once                                                     */
/* -------------------------------------------------------------------------- */

const season = loadSeason2026();
const graph = buildFacilityGraphFromSeason2026(loadFacilityGeometry());
const timingTable = buildFormatTimingTableFromSeason2026(loadGameFormats());
const sunsets = loadSunsets();
/** Derived from the corpus rather than typed in, so a re-dated fixture moves it. */
const SEASON_YEAR = Number(sunsets[0].date.slice(0, 4));
const calendar = buildAvailabilityCalendarFromSeason2026(
  loadFacilityPermits({ seasonYear: SEASON_YEAR }),
  sunsets
);
/**
 * The club's declared venue complexes. Not a default: the coach rule demands
 * this resource, because a run that quietly assumed "no complexes" would judge
 * two ends of one park against the 60-minute drive floor — which is exactly the
 * misreading this fixture is baselined against.
 */
const venueComplexes = buildSeason2026VenueComplexMap();
const resources = { graph, timingTable, calendar, venueComplexes };

const registry = buildSeason2026ConstraintRegistry();
const schedule = toSeason2026Schedule(season);
const engine = buildStandingRuleEngine();

/** The known-good run, computed once; almost every assertion below reads it. */
const run = runRuleEngine(schedule, { registry, resources });
const report = buildValidationReport(run, { scheduleName: schedule.name });

/** Codes of a finding list, for terse assertions. */
const codesOf = (findings) => findings.map((finding) => finding.code);

/** A minimal, valid rule definition, for the schema and engine unit tests. */
function makeRule(overrides = {}) {
  return {
    id: 'test-rule',
    title: 'A rule under test',
    constraintIds: [],
    reasonCodes: [],
    exercise: {
      minimums: { thingsExamined: 1 },
      coverage: {},
      identifierKinds: [],
      rationale: 'a rule that examined nothing has not examined this schedule',
    },
    rationale: 'exists to be tested',
    evaluate: () => ({ subjects: [], findings: [], counters: { thingsExamined: 1 }, matched: {} }),
    ...overrides,
  };
}

/** A one-game schedule, for the unit tests that need a universe and nothing else. */
function tinySchedule(overrides = {}) {
  return {
    name: 'tiny',
    games: [
      {
        id: 'g1',
        date: '2026-08-22',
        startMinutes: 540,
        endMinutes: 600,
        venueId: 'venue-1',
        surfaceId: 'surface-1',
        format: '9v9',
        divisionLabel: 'U12B',
        homeTeamId: 'team-a',
        awayTeamId: 'team-b',
        homeLabel: 'team-a',
        awayLabel: 'team-b',
        counted: true,
      },
    ],
    commitments: [],
    teams: [],
    teamUniverse: ['team-a', 'team-b'],
    personUniverse: ['person-1'],
    divisionUniverse: ['U12B'],
    surfaceUniverse: ['surface-1'],
    venueUniverse: ['venue-1'],
    placeholderLabels: ['-', 'Select Game 7'],
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* Reason codes and severity                                                    */
/* -------------------------------------------------------------------------- */

describe('rule engine :: reason codes', () => {
  it('registers a severity for every code, and refuses one it does not know', () => {
    const engineCodes = Object.values(RULE_REASON);
    expect(engineCodes.length).toBeGreaterThan(0);
    for (const code of engineCodes) {
      expect(RULE_REASON_SEVERITY[code], code).toBeDefined();
      expect(ruleSeverityOf(code)).toBe(RULE_REASON_SEVERITY[code]);
    }
    expect(() => ruleSeverityOf('NOT_A_CODE')).toThrow(/no registered severity/);

    const violationCodes = Object.values(RULE_VIOLATION_REASON);
    expect(violationCodes.length).toBeGreaterThan(0);
    for (const code of violationCodes) {
      expect(RULE_VIOLATION_SEVERITY[code], code).toBeDefined();
    }
    expect(() => violationSeverityOf('NOT_A_CODE')).toThrow(/no registered severity/);
  });

  it('makes every meta-assertion failure blocking', () => {
    // The whole point of the phase: a check that cannot prove it examined the
    // right data must not produce a verdict anybody reads past.
    for (const code of [
      RULE_REASON.RULE_EXERCISE_BELOW_MINIMUM,
      RULE_REASON.RULE_EXERCISE_COUNTER_MISSING,
      RULE_REASON.RULE_EXERCISE_COVERAGE_SHORT,
      RULE_REASON.RULE_EXERCISE_DOMAIN_UNKNOWN,
      RULE_REASON.RULE_MATCHED_PLACEHOLDER,
      RULE_REASON.RULE_MATCHED_UNKNOWN_IDENTIFIER,
      RULE_REASON.RULE_IDENTIFIER_KIND_UNKNOWN,
      RULE_REASON.REPORT_VACUOUS,
      RULE_REASON.REPORT_NO_RULE_EXERCISED,
    ]) {
      expect(ruleSeverityOf(code), code).toBe(RULE_SEVERITY.BLOCKING);
    }
    // "Nothing checked this" is a compromise, not an info: it is not a fault,
    // and it is not a pass either.
    expect(ruleSeverityOf(RULE_REASON.RULE_CONSTRAINT_UNENFORCED)).toBe(RULE_SEVERITY.COMPROMISE);
  });

  it('takes a violation severity from the constraint record, not from a call site', () => {
    const hard = requireConstraint(registry, SEASON_2026_CONSTRAINT_ID.ROUND_ROBIN_COMPLETENESS);
    expect(hard.type).toBe(CONSTRAINT_TYPE.HARD);
    expect(violationSeverityOf(RULE_VIOLATION_REASON.ROUND_ROBIN_INCOMPLETE, hard)).toBe(
      RULE_SEVERITY.BLOCKING
    );

    const relaxed = retypeConstraint(registry, SEASON_2026_CONSTRAINT_ID.ROUND_ROBIN_COMPLETENESS, {
      type: CONSTRAINT_TYPE.PREFERENCE,
      weight: 1,
      by: 'tests/ruleEngine.test.js',
      note: 'GAP-12: hardness is data, so the same finding must change severity with the record',
    });
    const softened = requireConstraint(relaxed, SEASON_2026_CONSTRAINT_ID.ROUND_ROBIN_COMPLETENESS);
    expect(violationSeverityOf(RULE_VIOLATION_REASON.ROUND_ROBIN_INCOMPLETE, softened)).toBe(
      RULE_SEVERITY.INFO
    );

    // "This rule could not decide" is a fact about the evidence, not a policy
    // position, so no record may soften it.
    expect(violationSeverityOf(RULE_VIOLATION_REASON.ROUND_ROBIN_DIVISION_UNJUDGED, softened)).toBe(
      RULE_SEVERITY.COMPROMISE
    );
    expect(violationSeverityOf(RULE_VIOLATION_REASON.TURNOVER_UNJUDGED, softened)).toBe(
      RULE_SEVERITY.COMPROMISE
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Build-time refusal                                                           */
/* -------------------------------------------------------------------------- */

describe('rule engine :: a rule without an exercise expectation is refused at build time', () => {
  it('refuses a rule that declares no expectation at all', () => {
    expect(() => RuleDefinitionSchema.parse(makeRule({ exercise: undefined }))).toThrow();
    expect(() =>
      RuleDefinitionSchema.parse(
        makeRule({
          exercise: {
            minimums: {},
            coverage: {},
            identifierKinds: [],
            rationale: 'I promise nothing',
          },
        })
      )
    ).toThrow(/at least one minimum or one coverage expectation/);
  });

  it('refuses an expectation every possible run satisfies', () => {
    expect(() =>
      RuleDefinitionSchema.parse(
        makeRule({
          exercise: {
            minimums: { thingsExamined: 0 },
            coverage: {},
            identifierKinds: [],
            rationale: 'zero or more things, which is all of them',
          },
        })
      )
    ).toThrow(/every declared minimum is zero/);
  });

  it('refuses an expectation with no rationale', () => {
    expect(() =>
      RuleDefinitionSchema.parse(
        makeRule({
          exercise: { minimums: { thingsExamined: 1 }, coverage: {}, identifierKinds: [] },
        })
      )
    ).toThrow();
  });

  it('refuses a code-to-constraint map that names something the rule does not have', () => {
    expect(() =>
      RuleDefinitionSchema.parse(makeRule({ reasonCodes: ['A'], constraintIdByCode: { B: ['x'] } }))
    ).toThrow(/does not claim/);
    expect(() =>
      RuleDefinitionSchema.parse(
        makeRule({ reasonCodes: ['A'], constraintIds: ['x'], constraintIdByCode: { A: ['y'] } })
      )
    ).toThrow(/does not enforce/);
  });

  it('reports an engine with no rules as blocking rather than as a clean answer', () => {
    const empty = buildRuleEngine({ name: 'empty', rules: [] });
    expect(codesOf(empty.findings)).toEqual([RULE_REASON.RULE_SET_EMPTY]);
    expect(empty.status).toBe(RULE_STATUS.REJECTED);
  });

  it('reports a duplicate rule id rather than letting the loser vanish', () => {
    const built = buildRuleEngine({ rules: [makeRule(), makeRule()] });
    expect(codesOf(built.findings)).toContain(RULE_REASON.RULE_ID_DUPLICATE);
    expect(built.ruleIds).toEqual(['test-rule']);
  });

  it('has every standing rule carry a declared, non-trivial expectation', () => {
    // The structural meta-assertion over the rule set itself: a new rule cannot
    // ship without one, and this is the test that would fail if the schema stopped
    // enforcing it.
    expect(STANDING_RULES.length).toBeGreaterThan(0);
    for (const rule of STANDING_RULES) {
      const parsed = RuleDefinitionSchema.parse(rule);
      const declared =
        Object.keys(parsed.exercise.minimums).length + Object.keys(parsed.exercise.coverage).length;
      expect(declared, `${rule.id} declares no expectation`).toBeGreaterThan(0);
      expect(parsed.exercise.rationale.length, `${rule.id} has no rationale`).toBeGreaterThan(20);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* The exercise checks, in isolation                                            */
/* -------------------------------------------------------------------------- */

describe('rule engine :: exercise checks', () => {
  it('fails a counter below its declared floor', () => {
    const rule = RuleDefinitionSchema.parse(makeRule());
    const { findings, shortfalls } = checkMinimums(rule, { thingsExamined: 0 });
    expect(codesOf(findings)).toEqual([RULE_REASON.RULE_EXERCISE_BELOW_MINIMUM]);
    expect(findings[0].severity).toBe(RULE_SEVERITY.BLOCKING);
    expect(shortfalls).toEqual([
      { counter: 'thingsExamined', observed: 0, required: 1, kind: 'minimum' },
    ]);
  });

  it('separates "reported zero" from "stopped reporting the counter"', () => {
    const rule = RuleDefinitionSchema.parse(makeRule());
    const { findings } = checkMinimums(rule, {});
    expect(codesOf(findings)).toEqual([RULE_REASON.RULE_EXERCISE_COUNTER_MISSING]);
    expect(findings[0].severity).toBe(RULE_SEVERITY.BLOCKING);
  });

  it('fails partial coverage even when every minimum is met', () => {
    const rule = RuleDefinitionSchema.parse(
      makeRule({
        exercise: {
          minimums: { divisionsExamined: 1 },
          coverage: { divisionsExamined: RULE_IDENTIFIER_KIND.DIVISION },
          identifierKinds: [],
          rationale: 'a round robin is a claim about a whole division',
        },
      })
    );
    const tiny = tinySchedule({ divisionUniverse: ['U12B', 'U12G', 'U10B'] });
    const verdict = judgeExercise(
      rule,
      { subjects: [], findings: [], counters: { divisionsExamined: 1 }, matched: {} },
      tiny
    );
    expect(verdict.satisfied).toBe(false);
    expect(codesOf(verdict.findings)).toEqual([RULE_REASON.RULE_EXERCISE_COVERAGE_SHORT]);
    expect(verdict.findings[0].details).toMatchObject({ observed: 1, required: 3, shortfall: 2 });
  });

  it('reports a placeholder label matched as an identifier, which no count could catch', () => {
    const rule = RuleDefinitionSchema.parse(
      makeRule({
        exercise: {
          minimums: { thingsExamined: 1 },
          coverage: {},
          identifierKinds: [RULE_IDENTIFIER_KIND.TEAM],
          rationale: 'a team id is a team id, not a cell somebody typed',
        },
      })
    );
    const result = checkIdentifiers(
      rule,
      { [RULE_IDENTIFIER_KIND.TEAM]: ['team-a', 'Select Game 7'] },
      tinySchedule()
    );
    expect(result.identifiersChecked).toBe(2);
    expect(codesOf(result.findings)).toEqual([RULE_REASON.RULE_MATCHED_PLACEHOLDER]);
    expect(result.findings[0].severity).toBe(RULE_SEVERITY.BLOCKING);
    expect(result.badIdentifiers).toEqual([
      {
        kind: RULE_IDENTIFIER_KIND.TEAM,
        identifier: 'Select Game 7',
        code: RULE_REASON.RULE_MATCHED_PLACEHOLDER,
      },
    ]);
  });

  it('reports an identifier outside the schedule’s universe as its own failure', () => {
    const rule = RuleDefinitionSchema.parse(
      makeRule({
        exercise: {
          minimums: { thingsExamined: 1 },
          coverage: {},
          identifierKinds: [RULE_IDENTIFIER_KIND.TEAM],
          rationale: 'a join against a foreign key space is measuring another season',
        },
      })
    );
    const result = checkIdentifiers(
      rule,
      { [RULE_IDENTIFIER_KIND.TEAM]: ['Visiting Club A - U14B South'] },
      tinySchedule()
    );
    expect(codesOf(result.findings)).toEqual([RULE_REASON.RULE_MATCHED_UNKNOWN_IDENTIFIER]);
    expect(result.findings[0].severity).toBe(RULE_SEVERITY.BLOCKING);
  });

  it('records a satisfied expectation as provenance, with the numbers on it', () => {
    const rule = RuleDefinitionSchema.parse(makeRule());
    const verdict = judgeExercise(
      rule,
      { subjects: [], findings: [], counters: { thingsExamined: 5 }, matched: {} },
      tinySchedule()
    );
    expect(verdict.satisfied).toBe(true);
    expect(codesOf(verdict.findings)).toEqual([RULE_REASON.RULE_EXERCISE_SATISFIED]);
    expect(verdict.findings[0].severity).toBe(RULE_SEVERITY.INFO);
    expect(verdict.findings[0].details.counters).toEqual({ thingsExamined: 5 });
  });

  it('bounds every identifier kind it accepts', () => {
    const tiny = tinySchedule();
    expect(universeOf(tiny, RULE_IDENTIFIER_KIND.TEAM)).toEqual(['team-a', 'team-b']);
    expect(universeOf(tiny, RULE_IDENTIFIER_KIND.GAME)).toEqual(['g1']);
    expect(universeOf(tiny, RULE_IDENTIFIER_KIND.DATE)).toEqual(['2026-08-22']);
    expect(universeOf(tiny, 'not-a-kind')).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Coverage: the declared-only honesty                                          */
/* -------------------------------------------------------------------------- */

describe('rule engine :: what nothing checks is reported, never assumed satisfied', () => {
  it('names every registry constraint as either enforced or unenforced', () => {
    const coverage = run.coverage;
    expect(coverage.constraintIds).toEqual([...registry.constraintIds]);
    expect(coverage.constraintIds.length).toBe(14);
    expect([...coverage.enforcedConstraintIds, ...coverage.unenforcedConstraintIds].sort()).toEqual(
      [...registry.constraintIds].sort()
    );
  });

  it('reports the two constraints no rule enforces, at compromise', () => {
    expect(run.coverage.unenforcedConstraintIds).toEqual([
      SEASON_2026_CONSTRAINT_ID.COACH_MAXIMUM_GAP,
      SEASON_2026_CONSTRAINT_ID.KICKOFF_VARIETY,
    ]);
    // Both are `preference`-typed: "optimise toward; no violation concept".
    for (const id of run.coverage.unenforcedConstraintIds) {
      expect(requireConstraint(registry, id).type).toBe(CONSTRAINT_TYPE.PREFERENCE);
    }
    const unenforced = run.coverage.findings.filter(
      (finding) => finding.code === RULE_REASON.RULE_CONSTRAINT_UNENFORCED
    );
    expect(unenforced).toHaveLength(2);
    for (const finding of unenforced) {
      expect(finding.severity).toBe(RULE_SEVERITY.COMPROMISE);
    }
    expect(report.unenforcedConstraintIds).toEqual(run.coverage.unenforcedConstraintIds);
  });

  it('says out loud that the rule engine enforces constraints the registry calls declared-only', () => {
    const declaredOnly = run.coverage.findings.filter(
      (finding) => finding.code === RULE_REASON.RULE_ENFORCES_DECLARED_ONLY
    );
    // Eight of the ten declared-only records now have a rule; the other two are
    // the unenforced preferences above.
    expect(registry.stats.declaredOnlyCount).toBe(10);
    expect(new Set(declaredOnly.map((finding) => finding.details.constraintId)).size).toBe(8);
    for (const finding of declaredOnly) expect(finding.severity).toBe(RULE_SEVERITY.INFO);
  });

  it('reports the one rule that enforces no constraint rather than inventing one for it', () => {
    expect(run.coverage.rulesEnforcingNothing).toEqual([RULE_ID.FIELD_ELIGIBILITY]);
    const finding = run.coverage.findings.find(
      (entry) => entry.code === RULE_REASON.RULE_ENFORCES_NO_CONSTRAINT
    );
    expect(finding).toBeDefined();
    expect(finding.severity).toBe(RULE_SEVERITY.INFO);
  });

  it('refuses a rule that claims a constraint the registry does not hold', () => {
    const stranger = buildRuleEngine({
      rules: [makeRule({ constraintIds: ['a-constraint-nobody-wrote-down'] })],
    });
    const coverage = ruleCoverage(stranger, registry);
    expect(codesOf(coverage.findings)).toContain(RULE_REASON.RULE_CONSTRAINT_UNKNOWN);
    expect(
      coverage.findings.find((finding) => finding.code === RULE_REASON.RULE_CONSTRAINT_UNKNOWN)
        .severity
    ).toBe(RULE_SEVERITY.BLOCKING);
  });

  it('derives the waiver link map from the rules, and narrows it where a rule says so', () => {
    const map = constraintIdsByReasonCode(engine, registry);
    expect(map[TRAVEL_REASON.TRAVEL_BETWEEN_VENUES_TOO_SHORT]).toEqual([
      SEASON_2026_CONSTRAINT_ID.COACH_TRAVEL_BETWEEN_VENUES,
    ]);
    expect(map[TRAVEL_REASON.TRAVEL_WITHIN_VENUE_TOO_SHORT]).toEqual([
      SEASON_2026_CONSTRAINT_ID.COACH_TRAVEL_WITHIN_VENUE,
    ]);
    // A person in two places at once is not a travel policy, so no travel
    // waiver may reach it.
    expect(map[TRAVEL_REASON.TRAVEL_COMMITMENTS_OVERLAP]).toBeUndefined();
    // The registry's own wiring still comes through for the Phase 1 codes.
    expect(map[FACILITY_REASON.OCCUPIED_SPATIAL_OVERLAP]).toContain(
      SEASON_2026_CONSTRAINT_ID.FIELD_OVERLAP_ADJACENCY
    );
  });
});

/* -------------------------------------------------------------------------- */
/* The known-good corpus run                                                    */
/* -------------------------------------------------------------------------- */

describe('rule engine :: the published season-2026 schedule', () => {
  it('builds a schedule that refuses to call a placeholder label a team id', () => {
    expect(schedule.games).toHaveLength(679);
    expect(schedule.teamUniverse).toHaveLength(132);
    expect(schedule.commitments.length).toBeGreaterThan(1000);
    // Derived, never typed in: exactly the cells the roster does not know.
    expect(schedule.placeholderLabels).toContain('-');
    expect(schedule.placeholderLabels).toContain('MinisA');
    expect(schedule.placeholderLabels).toContain('Select Game 7');
    expect(schedule.placeholderLabels).toContain('Scrimmage - teams TBD');
    expect(schedule.placeholderLabels.some((label) => label.startsWith('Visiting Club'))).toBe(
      true
    );
    for (const label of schedule.placeholderLabels) {
      expect(schedule.teamUniverse).not.toContain(label);
    }
    // The loader is deliberately lenient and hands these through as `teamId`s;
    // this adapter is where that stops.
    expect(season.combinedGames.some((game) => game.homeTeamId === 'MinisA')).toBe(true);
    expect(schedule.games.some((game) => game.homeTeamId === 'MinisA')).toBe(false);
  });

  it('runs every rule, and every rule proves it examined the right data', () => {
    expect(run.meta.rulesRegistered).toBe(STANDING_RULES.length);
    expect(run.meta.rulesRun).toBe(STANDING_RULES.length);
    expect(run.meta.rulesThrew).toBe(0);
    expect(run.meta.rulesExercised).toBe(STANDING_RULES.length);
    expect(run.meta.rulesUnderExercised).toBe(0);
    expect(run.meta.exerciseChecksRun).toBe(STANDING_RULES.length);
    expect(run.meta.identifiersChecked).toBeGreaterThan(1000);
    expect(report.underExercisedRuleIds).toEqual([]);
  });

  it('exercises each of the three rules the build plan names by number', () => {
    // "The coach rule must assert it evaluated > 0 person-pairs."
    //
    // These three numbers moved in Prompt 3.1, and nothing about the verdict
    // moved with them. `buildCoachTimelines()` used to skip rows of unknown
    // footprint, and since the corpus's only unknown-footprint rows are its
    // four `Scrimmage` entries, that skip reproduced incident 5 inside the
    // loader: the rule engine could not see the evening commitments the
    // incident is about. Carrying them adds 9 commitments (three scrimmages ×
    // the rostered coaches of their named sides), which brings the last 6 of
    // the corpus's 196 people onto a timeline, adds 8 person-days, and creates
    // exactly one new consecutive pair — a coach whose 11:50 rec game is
    // followed by a 17:20 scrimmage at the same venue. It is judged, it clears
    // the 15-minute walking floor, and `ACCEPTED_EXCEPTIONS` below is
    // unchanged in every entry.
    const coach = run.byRuleId[RULE_ID.COACH_CONFLICT].exercise.counters;
    expect(coach.personPairsCompared).toBe(137);
    // Every rostered person now has a timeline; before, six coaches whose only
    // fixture was a scrimmage had none at all.
    expect(coach.peopleExamined).toBe(196);
    expect(coach.peopleExamined).toBe(season.people.length);
    expect(coach.commitmentsExamined).toBe(schedule.commitments.length);

    // "The round-robin rule must assert it examined every division."
    const roundRobin = run.byRuleId[RULE_ID.ROUND_ROBIN].exercise.counters;
    expect(schedule.divisionUniverse).toHaveLength(19);
    expect(roundRobin.divisionsExamined).toBe(schedule.divisionUniverse.length);
    expect(roundRobin.divisionsJudged).toBe(14);
    expect(roundRobin.teamPairsCompared).toBeGreaterThan(0);

    // "The adjacency rule must assert it compared > 0 concurrent field pairs."
    const adjacency = run.byRuleId[RULE_ID.FIELD_ADJACENCY].exercise.counters;
    expect(adjacency.concurrentFieldPairsCompared).toBe(1094);
    expect(adjacency.overlapPairsInGraph).toBe(2);
  });

  it('carries evidence for every other rule too', () => {
    expect(run.byRuleId[RULE_ID.PERMIT_WINDOW].exercise.counters.permitWindowsConsulted).toBe(896);
    expect(run.byRuleId[RULE_ID.SUNSET_MARGIN].exercise.counters.unlitGamesExamined).toBe(671);
    expect(run.byRuleId[RULE_ID.SUNSET_MARGIN].exercise.counters.litGamesExamined).toBe(8);
    expect(run.byRuleId[RULE_ID.TURNOVER_MINIMUM].exercise.counters.consecutivePairsCompared).toBe(
      483
    );
    expect(run.byRuleId[RULE_ID.HOME_AWAY_BALANCE].exercise.counters.teamsExamined).toBe(118);
    expect(run.byRuleId[RULE_ID.CONFLICT_FAIRNESS].exercise.counters.groupsExamined).toBe(9);
    expect(run.byRuleId[RULE_ID.FIELD_SAME_GROUND].exercise.counters.gamePairsCompared).toBe(4752);
  });

  it('finds nothing at all wrong with the four rules the corpus README states as invariants', () => {
    // "No two concurrent games on an overlap pair"; "no game sits outside its
    // venue permit"; "no unlit game ends within 15 min of sunset"; "every rec
    // team plays exactly 9 games, hosting 4 or 5".
    for (const ruleId of [
      RULE_ID.FIELD_ADJACENCY,
      RULE_ID.PERMIT_WINDOW,
      RULE_ID.SUNSET_MARGIN,
      RULE_ID.HOME_AWAY_BALANCE,
    ]) {
      expect(run.byRuleId[ruleId].violationCount, ruleId).toBe(0);
      expect(run.byRuleId[ruleId].status, ruleId).toBe(RULE_STATUS.ALLOWED);
    }
    // …and the fairness invariant: "within every age group the conflict spread
    // is <= 1".
    expect(run.byRuleId[RULE_ID.CONFLICT_FAIRNESS].violationCount).toBe(0);
  });

  /**
   * **The accepted exceptions, enumerated.**
   *
   * Each entry is a violation the published season genuinely carries, with the
   * line of `fixtures/season-2026/README.md` or the documented gap that
   * explains it. Nothing here is loosened to make a number disappear.
   */
  const ACCEPTED_EXCEPTIONS = Object.freeze({
    // GAP-14 / Prompt 1.3: the four `Scrimmage` rows have no `game_formats.csv`
    // entry, so the format cannot be ranked against the surface's sizes. Known
    // to be blocking, and accounted for rather than softened.
    [FACILITY_REASON.SIZE_UNKNOWN_FORMAT]: 4,
    // The same four rows: no timing row means no declared occupancy.
    [TIMING_REASON.FORMAT_TIMING_UNDEFINED]: 4,
    // The same four rows again: with no known end, concurrency cannot be decided.
    [FACILITY_REASON.OCCUPANCY_FOOTPRINT_UNKNOWN]: 4,
    // 36 Minis sessions on ground that is big enough and is not lined for Minis,
    // plus the four Scrimmage rows whose format cannot be checked against lining.
    [FACILITY_REASON.LINING_MISMATCH]: 40,
    // The 60-minute inter-venue travel floor is `soft`, and the published season
    // breaks it exactly once — incident 9's whole subject, and the single case
    // the board's waiver was granted for. It read 18 across five coaches until
    // `Maplewood Back`/`Maplewood Front` were declared one venue complex; 17 of
    // those were a walk across one park, judged against a drive.
    [TRAVEL_REASON.TRAVEL_BETWEEN_VENUES_TOO_SHORT]: 1,
    // "3 rec games are single-coach (a co-coach covered)". The overlap is real;
    // the corpus records how it was handled, not that it did not happen. Since
    // #61 it is compromise: the operator allows it with a warning for exactly
    // this reason — a co-coach covered.
    [TRAVEL_REASON.TRAVEL_COMMITMENTS_OVERLAP]: 3,
    // Five divisions carry no two-sided counted game: the Minis division, whose
    // rows name no team at all, and the four Select divisions, whose teams are
    // on the roster and whose layer is external fixtures and reserved slots.
    // Each is reported unjudged rather than counted as complete — and the four
    // Select ones only appear at all because the division universe is derived
    // from the team records rather than from the rule's own game filter.
    [RULE_VIOLATION_REASON.ROUND_ROBIN_DIVISION_UNJUDGED]: 5,
    // One consecutive pair on one surface whose earlier row is a Scrimmage of
    // unknown footprint, so the turnover cannot be measured.
    [RULE_VIOLATION_REASON.TURNOVER_UNJUDGED]: 1,
  });

  it('passes with exactly the expected set of accepted exceptions, and no others', () => {
    expect(report.countByCode).toEqual({ ...ACCEPTED_EXCEPTIONS });
    const expectedTotal = Object.values(ACCEPTED_EXCEPTIONS).reduce((sum, n) => sum + n, 0);
    expect(report.violationCount).toBe(expectedTotal);
    expect(report.violationCount).toBe(62);
    // #61 moved the three coach overlaps from blocking to compromise.
    expect(report.countBySeverity).toEqual({ blocking: 4, compromise: 58, info: 0 });
    // Asserted positively rather than by omission: the walking floor is now
    // reachable for a move between two venues in one complex, and every such
    // gap in the published season clears it.
    expect(report.countByCode[TRAVEL_REASON.TRAVEL_WITHIN_VENUE_TOO_SHORT]).toBeUndefined();
    expect(report.waivedCount).toBe(0);
    expect(report.disposition).toBe(WAIVER_DISPOSITION.UNWAIVED);
  });

  it('traces the four blocking size verdicts to the four unknown-footprint Scrimmage rows', () => {
    const unknownFootprint = schedule.games.filter((game) => game.endMinutes === null);
    expect(unknownFootprint).toHaveLength(4);
    expect(new Set(unknownFootprint.map((game) => game.format))).toEqual(new Set(['Scrimmage']));

    const sizeViolations = run.violations.filter(
      (violation) => violation.code === FACILITY_REASON.SIZE_UNKNOWN_FORMAT
    );
    expect(sizeViolations).toHaveLength(4);
    for (const violation of sizeViolations) expect(violation.severity).toBe(RULE_SEVERITY.BLOCKING);
    const gameIds = sizeViolations.map((violation) => violation.subjectId.split('::')[1]).sort();
    expect(gameIds).toEqual(unknownFootprint.map((game) => game.id).sort());
  });

  it('traces the three coach overlaps to the corpus’s three single-coach games', () => {
    const overlaps = run.violations.filter(
      (violation) => violation.code === TRAVEL_REASON.TRAVEL_COMMITMENTS_OVERLAP
    );
    expect(overlaps).toHaveLength(3);
    // Compromise since #61: allowed with a warning, because a co-coach covers.
    for (const violation of overlaps) expect(violation.severity).toBe(RULE_SEVERITY.COMPROMISE);
    // The corpus's own reading of the same three clashes, derived from its own
    // loader rather than restated here.
    const singleCoach = findSingleCoachGames(season.recGames, season.coachTimelines, season.teams);
    expect(singleCoach).toHaveLength(3);
    expect(new Set(overlaps.map((violation) => violation.details.personId)).size).toBe(3);
  });

  /**
   * Every consecutive same-day pair on one person's timeline that crosses from
   * one venue to another, split by whether the two are one site.
   *
   * Derived from `season.coachTimelines` rather than from the run, so the
   * assertions below are a second opinion on the engine and not a restatement
   * of it. The complex map is the only thing that decides the split — no name
   * is parsed here either.
   */
  const venueMoves = (() => {
    const across = [];
    const within = [];
    for (const [personKey, entries] of season.coachTimelines) {
      for (let index = 0; index < entries.length - 1; index += 1) {
        const from = entries[index];
        const to = entries[index + 1];
        if (from.date !== to.date) continue;
        if (from.endMinutes === null || to.startMinutes === null) continue;
        const fromVenueId = season2026VenueId(from.game.venue);
        const toVenueId = season2026VenueId(to.game.venue);
        if (fromVenueId === toVenueId) continue;
        const move = {
          personId: personKey,
          date: from.date,
          fromVenueId,
          toVenueId,
          gapMinutes: to.startMinutes - from.endMinutes,
        };
        if (sameVenueComplex(venueComplexes, fromVenueId, toVenueId)) within.push(move);
        else across.push(move);
      }
    }
    return { across, within };
  })();

  const DRIVE_FLOOR = /** @type {number} */ (
    requireConstraint(registry, SEASON_2026_CONSTRAINT_ID.COACH_TRAVEL_BETWEEN_VENUES).parameters
      .minimumGapMinutes
  );
  const WALK_FLOOR = /** @type {number} */ (
    requireConstraint(registry, SEASON_2026_CONSTRAINT_ID.COACH_TRAVEL_WITHIN_VENUE).parameters
      .minimumGapMinutes
  );

  it('traces the one inter-venue travel shortfall to the coach incident 9 describes', () => {
    // Derived, never typed in: the corpus's own inter-*complex* moves, short of
    // the drive floor, that are not a straight overlap.
    const shortfalls = venueMoves.across.filter(
      (move) => move.gapMinutes >= 0 && move.gapMinutes < DRIVE_FLOOR
    );
    // Meta-assertion first: a search that matched nothing would make the rest of
    // this test vacuous, and one that matched five would make "the coach" of
    // incident 9 ambiguous.
    expect(venueMoves.across.length).toBeGreaterThan(0);
    expect(shortfalls).toHaveLength(1);
    const scenario = shortfalls[0];

    const travelViolations = run.violations.filter(
      (violation) => violation.code === TRAVEL_REASON.TRAVEL_BETWEEN_VENUES_TOO_SHORT
    );
    expect(travelViolations).toHaveLength(1);
    const violation = travelViolations[0];
    expect(violation.details.personId).toBe(scenario.personId);
    expect(violation.details.date).toBe(scenario.date);
    expect(violation.details.fromVenueId).toBe(scenario.fromVenueId);
    expect(violation.details.toVenueId).toBe(scenario.toVenueId);
    expect(violation.computed.gapMinutes).toBe(scenario.gapMinutes);
    expect(violation.computed.gapMinutes).toBe(50);
    expect(violation.computed.minimumGapMinutes).toBe(DRIVE_FLOOR);
    // Neither end belongs to a complex, which is why the drive floor applied.
    expect(complexIdOf(venueComplexes, scenario.fromVenueId)).toBeNull();
    expect(complexIdOf(venueComplexes, scenario.toVenueId)).toBeNull();
    // …and it is the pair incident 9's waiver was written for.
    expect(violation.constraintId).toBe(SEASON_2026_CONSTRAINT_ID.COACH_TRAVEL_BETWEEN_VENUES);
  });

  it('judges every move inside one venue complex as a walk, and clears every one', () => {
    // The 17 shortfalls this change removed, and the six that were never
    // shortfalls at all: all of them moves between two named venues in one
    // park. Asserted positively — a `countByCode` with no within-venue entry
    // could equally mean the walking rule was never reached.
    expect(venueMoves.within.length).toBeGreaterThan(0);
    expect(venueMoves.within).toHaveLength(23);
    const wouldHaveFailedTheDriveFloor = venueMoves.within.filter(
      (move) => move.gapMinutes < DRIVE_FLOOR
    );
    expect(wouldHaveFailedTheDriveFloor).toHaveLength(17);
    expect(new Set(wouldHaveFailedTheDriveFloor.map((move) => move.personId)).size).toBe(4);
    for (const move of venueMoves.within) {
      expect(move.gapMinutes, `${move.personId} ${move.date}`).toBeGreaterThanOrEqual(WALK_FLOOR);
    }
    expect(
      run.violations.filter(
        (violation) => violation.code === TRAVEL_REASON.TRAVEL_WITHIN_VENUE_TOO_SHORT
      )
    ).toHaveLength(0);

    // The rule proves it consulted the map rather than assuming there was none.
    const counters = run.byRuleId[RULE_ID.COACH_CONFLICT].exercise.counters;
    expect(counters.withinComplexPairsCompared).toBe(venueMoves.within.length);
    expect(counters.crossVenuePairsCompared).toBeGreaterThan(counters.withinComplexPairsCompared);
  });

  it('traces the forty lining compromises to the Minis ground and the Scrimmage rows', () => {
    const lining = run.violations.filter(
      (violation) => violation.code === FACILITY_REASON.LINING_MISMATCH
    );
    expect(lining).toHaveLength(40);
    const gamesById = new Map(schedule.games.map((game) => [game.id, game]));
    const affected = lining.map((violation) => gamesById.get(violation.subjectId.split('::')[1]));
    expect(affected.filter((game) => game.format === 'Minis')).toHaveLength(36);
    expect(affected.filter((game) => game.format === 'Scrimmage')).toHaveLength(4);
    expect(
      new Set(affected.filter((game) => game.format === 'Minis').map((g) => g.surfaceId)).size
    ).toBe(1);
  });

  it('traces the one unjudged turnover to a Scrimmage of unknown footprint', () => {
    const unjudged = run.violations.filter(
      (violation) => violation.code === RULE_VIOLATION_REASON.TURNOVER_UNJUDGED
    );
    expect(unjudged).toHaveLength(1);
    const gamesById = new Map(schedule.games.map((game) => [game.id, game]));
    const earlier = gamesById.get(String(unjudged[0].details.earlierGameId));
    expect(earlier.endMinutes).toBeNull();
    expect(earlier.format).toBe('Scrimmage');
  });

  it('reads the turnover numbers from the registry rather than carrying any', () => {
    // The rule found no shortfall, so the proof that it *used* the registry is
    // that it resolved a policy for every surface-date it examined.
    const counters = run.byRuleId[RULE_ID.TURNOVER_MINIMUM].exercise.counters;
    expect(counters.policiesResolved).toBeGreaterThan(0);
    expect(counters.policiesResolved).toBeLessThanOrEqual(counters.surfaceDatesExamined);
    expect(
      requireConstraint(registry, SEASON_2026_CONSTRAINT_ID.TURNOVER_FLOOR_GLOBAL).parameters
        .minimumGapMinutes
    ).toBe(10);
  });
});

/* -------------------------------------------------------------------------- */
/* Structured violations                                                        */
/* -------------------------------------------------------------------------- */

describe('rule engine :: what a violation reports', () => {
  const travel = run.violations.find(
    (violation) => violation.code === TRAVEL_REASON.TRAVEL_BETWEEN_VENUES_TOO_SHORT
  );

  it('reports the constraint id, the severity, the entities and the computed values', () => {
    expect(travel).toBeDefined();
    expect(travel.constraintId).toBe(SEASON_2026_CONSTRAINT_ID.COACH_TRAVEL_BETWEEN_VENUES);
    expect(travel.constraintIds).toEqual([SEASON_2026_CONSTRAINT_ID.COACH_TRAVEL_BETWEEN_VENUES]);
    expect(travel.severity).toBe(RULE_SEVERITY.COMPROMISE);
    expect(travel.ruleId).toBe(RULE_ID.COACH_CONFLICT);

    const kinds = travel.entities.map((entity) => entity.kind);
    expect(kinds).toContain(RULE_IDENTIFIER_KIND.PERSON);
    expect(kinds).toContain(RULE_IDENTIFIER_KIND.VENUE);
    expect(kinds).toContain(RULE_IDENTIFIER_KIND.DATE);
    for (const entity of travel.entities) expect(entity.id).toBeTruthy();

    expect(travel.computed.gapMinutes).toBeGreaterThanOrEqual(0);
    expect(travel.computed.minimumGapMinutes).toBe(60);
    expect(travel.computed.shortfallMinutes).toBe(60 - Number(travel.computed.gapMinutes));
    expect(travel.waived).toBe(false);
    expect(travel.waiverId).toBeNull();
  });

  it('renders the computed values into the one line the prompt asks for', () => {
    expect(summariseComputed({ gapMinutes: 50, minimumGapMinutes: 60 })).toBe(
      'gap 50 min, minimum gap 60 min'
    );
    expect(travel.summary).toMatch(/^gap \d+ min, minimum gap 60 min/);
  });

  it('never reports an `info` finding as a violation', () => {
    for (const violation of run.violations) {
      expect(violation.severity, violation.code).not.toBe(RULE_SEVERITY.INFO);
    }
    expect(report.countBySeverity.info).toBe(0);
  });

  it('names only real identifiers as entities', () => {
    const known = {
      [RULE_IDENTIFIER_KIND.TEAM]: new Set(schedule.teamUniverse),
      [RULE_IDENTIFIER_KIND.PERSON]: new Set(schedule.personUniverse),
      [RULE_IDENTIFIER_KIND.SURFACE]: new Set(schedule.surfaceUniverse),
      [RULE_IDENTIFIER_KIND.VENUE]: new Set(schedule.venueUniverse),
      [RULE_IDENTIFIER_KIND.GAME]: new Set(schedule.games.map((game) => game.id)),
    };
    let checked = 0;
    for (const violation of run.violations) {
      for (const entity of violation.entities) {
        const universe = known[entity.kind];
        if (!universe) continue;
        checked += 1;
        expect(universe.has(entity.id), `${entity.kind} ${entity.id}`).toBe(true);
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Incident 4, reproduced                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The old-style team code the format change replaced.
 *
 * `fixtures/season-2026/README.md`, incident 4: *"A team-name format change
 * (`U12B04` -> `12B9v904`-style codes) made the coach validator's join match
 * zero person-pairs."* This is that change, run backwards over the roster: the
 * schedule keeps the new codes, the roster gets the old ones, and the join
 * between them empties.
 *
 * @param {string} code
 * @returns {string}
 */
function oldStyleTeamCode(code) {
  const match = String(code).match(/^(\d{2})([BG])(.*?)(\d{2})$/);
  return match ? `U${match[1]}${match[2]}${match[4]}` : code;
}

describe('incident 4, reproduced :: (a) a join that matches nothing', () => {
  const renamedTeams = season.teams.map((team) => ({ ...team, id: oldStyleTeamCode(team.id) }));

  it('actually applies the mutation it claims to', () => {
    // The meta-assertion on the break itself. A break test whose break silently
    // failed to apply is the same bug wearing a test's clothes.
    expect(renamedTeams).toHaveLength(season.teams.length);
    const changed = renamedTeams.filter((team, index) => team.id !== season.teams[index].id);
    expect(changed).toHaveLength(season.teams.length);
    expect(oldStyleTeamCode('12B9v904')).toBe('U12B04');
    const oldIds = new Set(renamedTeams.map((team) => team.id));
    expect(schedule.games.some((game) => oldIds.has(game.homeTeamId))).toBe(false);
  });

  const brokenTimelines = buildCoachTimelines(season.combinedGames, renamedTeams);
  const brokenSchedule = toSeason2026Schedule(
    { ...season, teams: renamedTeams, coachTimelines: brokenTimelines },
    { name: 'season-2026 with the team-name join broken' }
  );
  const brokenRun = runRuleEngine(brokenSchedule, { registry, resources });
  const brokenReport = buildValidationReport(brokenRun, { scheduleName: brokenSchedule.name });

  it('empties the join exactly as the format change did', () => {
    expect(brokenTimelines.size).toBe(0);
    expect(brokenSchedule.commitments).toHaveLength(0);
    expect(season.coachTimelines.size).toBeGreaterThan(100);
  });

  it('reports a meta-assertion failure rather than "0 violations"', () => {
    const coach = brokenRun.byRuleId[RULE_ID.COACH_CONFLICT];
    // The thing the source project actually shipped: zero conflicts.
    expect(coach.violationCount).toBe(0);
    // …and the thing that makes that harmless here.
    expect(coach.exercised).toBe(false);
    const failures = coach.exercise.findings.filter(
      (finding) => finding.code === RULE_REASON.RULE_EXERCISE_BELOW_MINIMUM
    );
    expect(failures.length).toBeGreaterThan(0);
    for (const finding of failures) expect(finding.severity).toBe(RULE_SEVERITY.BLOCKING);
    const personPairs = failures.find(
      (finding) => finding.details.counter === 'personPairsCompared'
    );
    expect(personPairs).toBeDefined();
    expect(personPairs.details).toMatchObject({ observed: 0, required: 1 });
    expect(coach.exercise.findings).not.toContainEqual(
      expect.objectContaining({ code: RULE_REASON.RULE_EXERCISE_SATISFIED })
    );
  });

  it('reports the whole run as rejected even though the rule it silenced went quiet', () => {
    // This is the shape of the original failure: the silenced rule reports
    // nothing at all, and the run sheds every blocking violation the coach
    // timeline carried. The *total* moves the other way — the same rename also
    // leaves all fifteen divisions unjudged — which is the point rather than an
    // inconvenience: no comparison of counts decides this, the engine's own
    // exercise verdict does.
    // Since #61 the overlaps it sheds are compromise, so the blocking count no
    // longer moves; the shed is stated by code instead.
    expect(report.countByCode[TRAVEL_REASON.TRAVEL_COMMITMENTS_OVERLAP]).toBe(3);
    expect(brokenRun.byRuleId[RULE_ID.COACH_CONFLICT].violationCount).toBe(0);
    expect(run.byRuleId[RULE_ID.COACH_CONFLICT].violationCount).toBeGreaterThan(0);
    expect(brokenReport.countByCode[TRAVEL_REASON.TRAVEL_BETWEEN_VENUES_TOO_SHORT]).toBeUndefined();
    expect(brokenReport.countByCode[TRAVEL_REASON.TRAVEL_COMMITMENTS_OVERLAP]).toBeUndefined();
    expect(brokenRun.status).toBe(RULE_STATUS.REJECTED);
    expect(codesOf(brokenRun.findings)).toContain(RULE_REASON.RULE_EXERCISE_BELOW_MINIMUM);
  });

  it('names every rule the same format change silenced, not just the coach one', () => {
    // One rename empties four joins at once. Each of them says so.
    expect(brokenReport.underExercisedRuleIds).toEqual([
      RULE_ID.COACH_CONFLICT,
      RULE_ID.CONFLICT_FAIRNESS,
      RULE_ID.HOME_AWAY_BALANCE,
      RULE_ID.ROUND_ROBIN,
    ]);
    for (const ruleId of brokenReport.underExercisedRuleIds) {
      expect(brokenRun.byRuleId[ruleId].exercised, ruleId).toBe(false);
    }
    expect(brokenRun.meta.rulesUnderExercised).toBe(4);
  });
});

describe('incident 4, reproduced :: (b) a join that matches the wrong data', () => {
  /**
   * The second checker's mistake, rebuilt: take the team ids straight from the
   * `Home` and `Away` cells and count every row toward the season.
   *
   * Every label this lets through is a real cell in `combined_schedule.csv`.
   */
  const naiveSchedule = {
    ...schedule,
    name: 'season-2026 with placeholder labels read as team codes',
    games: schedule.games.map((game) => ({
      ...game,
      homeTeamId: game.homeLabel === '' || game.homeLabel === '-' ? null : game.homeLabel,
      awayTeamId: game.awayLabel === '' || game.awayLabel === '-' ? null : game.awayLabel,
      counted: true,
    })),
  };
  const naiveRun = runRuleEngine(naiveSchedule, { registry, resources });
  const naiveReport = buildValidationReport(naiveRun, { scheduleName: naiveSchedule.name });

  it('actually applies the mutation it claims to', () => {
    const leaked = naiveSchedule.games.filter(
      (game) =>
        (game.homeTeamId && !schedule.teamUniverse.includes(game.homeTeamId)) ||
        (game.awayTeamId && !schedule.teamUniverse.includes(game.awayTeamId))
    );
    expect(leaked.length).toBeGreaterThan(0);
    expect(leaked.some((game) => String(game.awayTeamId ?? '').startsWith('Visiting Club'))).toBe(
      true
    );
  });

  it('produces phantom violations that the correct schedule does not have', () => {
    // The failure mode in one assertion: the broken checker reports *more*, not
    // fewer. No count-based meta-assertion could ever catch this.
    expect(naiveReport.countByCode[RULE_VIOLATION_REASON.GAMES_PLAYED_OFF_TARGET]).toBeGreaterThan(
      0
    );
    expect(naiveReport.countByCode[RULE_VIOLATION_REASON.HOME_AWAY_OUT_OF_RANGE]).toBeGreaterThan(
      0
    );
    expect(report.countByCode[RULE_VIOLATION_REASON.GAMES_PLAYED_OFF_TARGET]).toBeUndefined();
    expect(naiveReport.violationCount).toBeGreaterThan(report.violationCount);
    expect(naiveRun.meta.rulesRun).toBe(STANDING_RULES.length);
    expect(naiveRun.meta.rulesThrew).toBe(0);
  });

  it('reports a blocking placeholder match before anybody acts on the phantoms', () => {
    expect(naiveReport.underExercisedRuleIds).toEqual([
      RULE_ID.HOME_AWAY_BALANCE,
      RULE_ID.ROUND_ROBIN,
    ]);
    const balance = naiveRun.byRuleId[RULE_ID.HOME_AWAY_BALANCE];
    expect(balance.exercised).toBe(false);
    // Every minimum it declares is comfortably met — only the shape check fails.
    expect(balance.exercise.shortfalls).toEqual([]);
    expect(balance.exercise.counters.teamsExamined).toBeGreaterThan(118);

    const placeholderMatches = balance.exercise.badIdentifiers.filter(
      (entry) => entry.code === RULE_REASON.RULE_MATCHED_PLACEHOLDER
    );
    expect(placeholderMatches.length).toBeGreaterThan(0);
    expect(placeholderMatches.map((entry) => entry.identifier)).toContain(
      'Visiting Club A - U14B South'
    );
    for (const finding of balance.exercise.findings) {
      expect(finding.severity).toBe(RULE_SEVERITY.BLOCKING);
    }
    expect(naiveRun.status).toBe(RULE_STATUS.REJECTED);
  });

  it('also catches an identifier that is simply not in this season', () => {
    const roundRobin = naiveRun.byRuleId[RULE_ID.ROUND_ROBIN];
    const unknown = roundRobin.exercise.badIdentifiers.filter(
      (entry) => entry.code === RULE_REASON.RULE_MATCHED_UNKNOWN_IDENTIFIER
    );
    // Counting the Select layer drags in divisions the rec universe never had.
    expect(unknown.length).toBeGreaterThan(0);
    expect(unknown.every((entry) => entry.kind === RULE_IDENTIFIER_KIND.DIVISION)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Incident 4, inside the machinery built to prevent it                         */
/* -------------------------------------------------------------------------- */

describe('incident 4, reproduced :: (c) a division the schedule lost and the roster kept', () => {
  /**
   * The corpus with every row of one division removed, and its teams left on
   * the roster exactly where they were.
   *
   * This is the case the flagship coverage assertion — *"the round-robin rule
   * examined every division"* — exists to catch, and the case it could not
   * catch while `divisionUniverse` was derived with the same filter the rule
   * applies: the division left the universe at the same instant it left the
   * rule's reach, so the comparison was a set against itself.
   */
  const LOST_DIVISION = 'U12G';
  const survivingRows = season.combinedGames.filter((game) => game.division !== LOST_DIVISION);
  const thinnedSchedule = toSeason2026Schedule(
    { ...season, combinedGames: survivingRows },
    { name: `season-2026 with every ${LOST_DIVISION} row removed` }
  );
  const thinnedRun = runRuleEngine(thinnedSchedule, { registry, resources });

  it('actually applies the mutation it claims to', () => {
    expect(survivingRows.length).toBeLessThan(season.combinedGames.length);
    expect(season.combinedGames.length - survivingRows.length).toBeGreaterThan(0);
    expect(thinnedSchedule.games.some((game) => game.divisionLabel === LOST_DIVISION)).toBe(false);
    // …and the roster still has the teams, which is the whole point.
    expect(
      thinnedSchedule.teams.filter((team) => team.divisionLabel === LOST_DIVISION).length
    ).toBeGreaterThan(1);
  });

  it('derives the division universe from the team records, not from the rule’s own filter', () => {
    // The tautology, spelled out: this is the set `roundRobinRule` builds.
    const theRuleSOwnFilter = new Set(
      schedule.games
        .filter((game) => game.counted && game.divisionLabel !== null)
        .map((game) => game.divisionLabel)
    );
    expect(theRuleSOwnFilter.size).toBe(15);
    expect(schedule.divisionUniverse.length).toBeGreaterThan(theRuleSOwnFilter.size);
    for (const division of theRuleSOwnFilter) {
      expect(schedule.divisionUniverse, division).toContain(division);
    }
  });

  it('keeps the lost division in the universe, so something is left to fail against', () => {
    expect(thinnedSchedule.divisionUniverse).toContain(LOST_DIVISION);
  });

  it('fails the coverage check when a rule enumerates divisions the way the rows do', () => {
    // The proof the assertion can fail: the pre-fix derivation, judged against
    // a universe that no longer moves with it.
    const roundRobin = RuleDefinitionSchema.parse(
      STANDING_RULES.find((rule) => rule.id === RULE_ID.ROUND_ROBIN)
    );
    const fromTheRows = new Set(
      thinnedSchedule.games
        .filter((game) => game.counted && game.divisionLabel !== null)
        .map((game) => game.divisionLabel)
    );
    expect(fromTheRows.size).toBeLessThan(thinnedSchedule.divisionUniverse.length);
    const verdict = judgeExercise(
      roundRobin,
      {
        subjects: [],
        findings: [],
        counters: { divisionsExamined: fromTheRows.size, teamPairsCompared: 1 },
        matched: {},
      },
      thinnedSchedule
    );
    expect(verdict.satisfied).toBe(false);
    expect(codesOf(verdict.findings)).toContain(RULE_REASON.RULE_EXERCISE_COVERAGE_SHORT);
    const short = verdict.findings.find(
      (finding) => finding.code === RULE_REASON.RULE_EXERCISE_COVERAGE_SHORT
    );
    expect(short.severity).toBe(RULE_SEVERITY.BLOCKING);
    expect(short.details.required).toBe(thinnedSchedule.divisionUniverse.length);
  });

  it('reports the lost division as unjudged rather than passing over it', () => {
    const unjudged = thinnedRun.violations.filter(
      (violation) =>
        violation.code === RULE_VIOLATION_REASON.ROUND_ROBIN_DIVISION_UNJUDGED &&
        violation.details.divisionLabel === LOST_DIVISION
    );
    expect(unjudged).toHaveLength(1);
    expect(unjudged[0].severity).toBe(RULE_SEVERITY.COMPROMISE);
    // The rule still meets its own coverage expectation, because it now
    // enumerates the divisions the roster declares as well as the ones the rows
    // do — which is what makes the expectation worth asserting.
    expect(thinnedRun.byRuleId[RULE_ID.ROUND_ROBIN].exercise.counters.divisionsExamined).toBe(
      thinnedSchedule.divisionUniverse.length
    );
  });
});

describe('incident 4, reproduced :: (d) one team the name change dropped', () => {
  /**
   * The format change of incident 4, applied to **one** team instead of all of
   * them — the case no counter can catch, because the other 117 teams still
   * clear every minimum.
   */
  const DROPPED_TEAM = season.teams.find((team) => team.division === 'U12B');
  const renamedTeams = season.teams.map((team) =>
    team.id === DROPPED_TEAM.id ? { ...team, id: oldStyleTeamCode(team.id) } : team
  );
  const droppedId = oldStyleTeamCode(DROPPED_TEAM.id);
  const droppedSchedule = toSeason2026Schedule(
    {
      ...season,
      teams: renamedTeams,
      coachTimelines: buildCoachTimelines(season.combinedGames, renamedTeams),
    },
    { name: 'season-2026 with one team renamed out of its own schedule' }
  );
  const droppedRun = runRuleEngine(droppedSchedule, { registry, resources });

  it('actually applies the mutation it claims to', () => {
    expect(DROPPED_TEAM).toBeDefined();
    expect(droppedId).not.toBe(DROPPED_TEAM.id);
    expect(droppedSchedule.teamUniverse).toContain(droppedId);
    expect(droppedSchedule.teamUniverse).not.toContain(DROPPED_TEAM.id);
    // The rows still name the team by its old label, so the join drops it.
    expect(
      droppedSchedule.games.filter(
        (game) => game.homeTeamId === droppedId || game.awayTeamId === droppedId
      )
    ).toHaveLength(0);
    expect(
      season.combinedGames.filter(
        (game) => game.homeTeamId === DROPPED_TEAM.id || game.awayTeamId === DROPPED_TEAM.id
      ).length
    ).toBe(9);
  });

  it('still clears every minimum, which is why a count could never catch this', () => {
    const balance = droppedRun.byRuleId[RULE_ID.HOME_AWAY_BALANCE];
    expect(balance.exercise.counters.teamsExamined).toBe(117);
    expect(balance.exercise.shortfalls).toEqual([]);
    expect(balance.exercise.badIdentifiers).toEqual([]);
  });

  it('names the team that vanished instead of leaving it out of the analysis', () => {
    const absences = droppedRun.violations.filter(
      (violation) => violation.code === RULE_VIOLATION_REASON.TEAM_ABSENT_FROM_SCHEDULE
    );
    expect(absences).toHaveLength(1);
    expect(absences[0].details.teamId).toBe(droppedId);
    expect(absences[0].details.divisionLabel).toBe('U12B');
    // Blocking, and no constraint record may soften it: a join that dropped a
    // team is a fact about the evidence, not a policy position.
    expect(absences[0].severity).toBe(RULE_SEVERITY.BLOCKING);
    expect(absences[0].ruleId).toBe(RULE_ID.HOME_AWAY_BALANCE);
    // The published season has none, so this is a difference the break made.
    expect(report.countByCode[RULE_VIOLATION_REASON.TEAM_ABSENT_FROM_SCHEDULE]).toBeUndefined();
  });

  it('reports the round robin the missing team leaves incomplete', () => {
    const incomplete = droppedRun.violations.filter(
      (violation) =>
        violation.code === RULE_VIOLATION_REASON.ROUND_ROBIN_INCOMPLETE &&
        (violation.details.teamId === droppedId || violation.details.opponentTeamId === droppedId)
    );
    expect(incomplete.length).toBeGreaterThan(0);
    // Pre-fix the division read as a complete round robin over nine teams; the
    // tenth was not missing from it, it was missing from the question.
    expect(report.countByCode[RULE_VIOLATION_REASON.ROUND_ROBIN_INCOMPLETE]).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* Waivers integrate, they do not bypass                                        */
/* -------------------------------------------------------------------------- */

describe('rule engine :: waivers', () => {
  /**
   * The corpus's inter-venue shortfalls and the coach each belongs to, derived.
   *
   * Since `Maplewood Back`/`Maplewood Front` became one declared complex there
   * is exactly one such coach, which is what incident 9 says there should be:
   * *"a 60-minute travel floor was waived for **one** coach"*.
   */
  const travelViolations = run.violations.filter(
    (violation) => violation.code === TRAVEL_REASON.TRAVEL_BETWEEN_VENUES_TOO_SHORT
  );
  const byPerson = new Map();
  for (const violation of travelViolations) {
    const person = String(violation.details.personId);
    byPerson.set(person, [...(byPerson.get(person) ?? []), violation]);
  }
  const ranked = [...byPerson.entries()].sort(
    (a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0])
  );
  const [personId, personViolations] = ranked[0];
  const venueIds = [
    ...new Set(
      personViolations.flatMap((violation) => [
        String(violation.details.fromVenueId),
        String(violation.details.toVenueId),
      ])
    ),
  ].sort();

  const ledger = buildSeason2026WaiverLedger({
    personId,
    venueIds,
    subjectSource: 'the rule engine’s own violations over coach_roster.csv + combined_schedule.csv',
  });

  /** The travel floor hardened, so "waived" and "clean" have different statuses. */
  const hardRegistry = retypeConstraint(
    registry,
    SEASON_2026_CONSTRAINT_ID.COACH_TRAVEL_BETWEEN_VENUES,
    {
      type: CONSTRAINT_TYPE.HARD,
      weight: null,
      by: 'tests/ruleEngine.test.js',
      note: 'incident 9 describes a floor that needed a board decision to breach, which is a hard rule for the person it binds',
    }
  );

  it('finds a real subject in the corpus to waive, and says how many', () => {
    // Meta-assertion first: a waiver test with nothing to waive is incident 4.
    expect(travelViolations).toHaveLength(1);
    // One coach, not five — the board granted one waiver, and the corpus now
    // carries exactly one case for it to cover.
    expect(ranked).toHaveLength(1);
    expect(personViolations).toHaveLength(1);
    expect(venueIds).toHaveLength(2);
  });

  it('reports a waived violation distinctly from a clean pass', () => {
    const waivedRun = runRuleEngine(schedule, { registry: hardRegistry, ledger, resources });
    const waivedReport = buildValidationReport(waivedRun, { scheduleName: 'waived' });

    expect(waivedReport.waivedCount).toBe(personViolations.length);
    expect(waivedReport.unwaivedCount).toBe(report.violationCount - personViolations.length);
    expect(waivedReport.violationCount).toBe(report.violationCount);
    expect(waivedReport.disposition).toBe(WAIVER_DISPOSITION.WAIVED_PARTIAL);

    // The waived findings are still in the list, still say what they were, and
    // now say who signed them off.
    const waived = waivedRun.violations.filter((violation) => violation.waived);
    expect(waived).toHaveLength(personViolations.length);
    for (const violation of waived) {
      expect(violation.waiverId).toBe(SEASON_2026_WAIVER_ID.COACH_TRAVEL_BOARD_EXCEPTION);
      expect(violation.waivedBy).toBe('club board');
      expect(violation.severity).toBe(RULE_SEVERITY.COMPROMISE);
      expect(violation.baseSeverity).toBe(RULE_SEVERITY.BLOCKING);
      expect(violation.details.personId).toBe(personId);
    }
    expect(codesOf(waivedRun.findings)).toContain(WAIVER_REASON.WAIVER_APPLIED);
    expect(waivedRun.waivers.annotations).toHaveLength(personViolations.length);
  });

  it('leaves the hardened schedule strictly worse without the waiver', () => {
    const withLedger = runRuleEngine(schedule, { registry: hardRegistry, ledger, resources });
    const withoutLedger = runRuleEngine(schedule, { registry: hardRegistry, resources });
    const a = buildValidationReport(withLedger).countBySeverity;
    const b = buildValidationReport(withoutLedger).countBySeverity;
    expect(b.blocking - a.blocking).toBe(personViolations.length);
    expect(a.compromise - b.compromise).toBe(personViolations.length);
  });

  it('surfaces the dormancy verdict the 2.2 ledger computes', () => {
    const waivedRun = runRuleEngine(schedule, { registry: hardRegistry, ledger, resources });
    expect(waivedRun.dormancy).not.toBeNull();
    expect(waivedRun.dormancy.meta.subjectsExamined).toBeGreaterThan(0);
    expect(codesOf(waivedRun.dormancy.findings)).not.toContain(WAIVER_REASON.WAIVER_SCAN_VACUOUS);
    const verdict = waivedRun.dormancy.waivers[0];
    expect(verdict.dormant).toBe(false);
    expect(verdict.appliedCount).toBe(personViolations.length);
    expect(verdict.changesStatus).toBe(true);
    expect(buildValidationReport(waivedRun).dormantWaiverIds).toEqual([]);
  });

  it('reports a waiver that covers nothing as dormant, not as a clean pass', () => {
    // The same waiver granted to a coach whose season carries no shortfall.
    const spareCoach = ranked[ranked.length - 1][0];
    const elsewhere = buildSeason2026WaiverLedger({
      personId: `${spareCoach}-who-does-not-exist`,
      venueIds,
      subjectSource: 'a waiver nobody needs any more, which is incident 9’s middle act',
    });
    const waivedRun = runRuleEngine(schedule, {
      registry: hardRegistry,
      ledger: elsewhere,
      resources,
    });
    const built = buildValidationReport(waivedRun);
    expect(built.waivedCount).toBe(0);
    expect(built.dormantWaiverIds).toEqual([SEASON_2026_WAIVER_ID.COACH_TRAVEL_BOARD_EXCEPTION]);
    expect(codesOf(waivedRun.findings)).toContain(WAIVER_REASON.WAIVER_DORMANT);
  });

  it('refuses to let a travel waiver excuse a coach being in two places at once', () => {
    const waivedRun = runRuleEngine(schedule, { registry: hardRegistry, ledger, resources });
    const overlaps = waivedRun.violations.filter(
      (violation) => violation.code === TRAVEL_REASON.TRAVEL_COMMITMENTS_OVERLAP
    );
    expect(overlaps).toHaveLength(3);
    for (const violation of overlaps) {
      expect(violation.waived).toBe(false);
      // Compromise since #61, and still not waivable: allowed with a warning is
      // an operator policy, not an exception a board signature grants.
      expect(violation.severity).toBe(RULE_SEVERITY.COMPROMISE);
    }
  });

  it('runs with no ledger at all without pretending anything was waived', () => {
    expect(run.waivers).toBeNull();
    expect(run.dormancy).toBeNull();
    expect(run.meta.violationsWaived).toBe(0);
    expect(report.dormantWaiverIds).toEqual([]);
  });

  it('reports a waiver whose constraint the registry does not hold', () => {
    const stray = buildWaiverLedger({
      waivers: [
        {
          id: 'stray',
          constraintId: 'a-constraint-nobody-wrote-down',
          name: 'a waiver that survived a rename',
          scope: { personId: 'someone' },
          reasonCodes: [],
          reason: 'incident 9: the waiver lived in a code comment and was lost across a rebuild',
          approval: {
            approvedBy: 'club board',
            approvedAt: null,
            reference: 'tests/ruleEngine.test.js',
            note: 'no dated decision survives',
          },
        },
      ],
    });
    const strayRun = runRuleEngine(schedule, { registry, ledger: stray, resources });
    expect(codesOf(strayRun.findings)).toContain(WAIVER_REASON.WAIVER_CONSTRAINT_UNKNOWN);
    expect(strayRun.status).toBe(RULE_STATUS.REJECTED);
  });

  it('reports a subject-level waiver finding once, not once per level', () => {
    // Incident 9's middle act: the waiver is still on the books and its window
    // has closed. Every subject it would have covered says so — once.
    const expired = buildSeason2026WaiverLedger({
      personId,
      venueIds,
      effectiveTo: '2000-01-01',
      subjectSource: 'tests/ruleEngine.test.js — the same waiver, out of its window',
    });
    const expiredRun = runRuleEngine(schedule, {
      registry: hardRegistry,
      ledger: expired,
      resources,
    });
    const onSubjects = expiredRun.waivers.subjects
      .flatMap((subject) => subject.findings)
      .filter((finding) => finding.code === WAIVER_REASON.WAIVER_EXPIRED);
    // Meta-assertion: a run where the waiver was never judged would make the
    // equality below true for the wrong reason.
    expect(onSubjects.length).toBeGreaterThan(0);
    const inRun = expiredRun.findings.filter(
      (finding) => finding.code === WAIVER_REASON.WAIVER_EXPIRED
    );
    expect(inRun).toHaveLength(onSubjects.length);
  });
});

/* -------------------------------------------------------------------------- */
/* The report                                                                   */
/* -------------------------------------------------------------------------- */

describe('rule engine :: the full-schedule validation report', () => {
  it('groups every violation by severity, keeping empty groups', () => {
    expect(Object.keys(report.countBySeverity).sort()).toEqual([...SEVERITY_ORDER].sort());
    for (const severity of SEVERITY_ORDER) {
      expect(report.violationsBySeverity[severity]).toBeDefined();
      expect(report.violationsBySeverity[severity]).toHaveLength(report.countBySeverity[severity]);
    }
    const total = SEVERITY_ORDER.reduce(
      (sum, severity) => sum + report.countBySeverity[severity],
      0
    );
    expect(total).toBe(report.violationCount);
  });

  it('counts by code, by rule and by constraint, and the totals agree', () => {
    const byCode = Object.values(report.countByCode).reduce((sum, n) => sum + n, 0);
    expect(byCode).toBe(report.violationCount);
    const byRule = Object.values(report.countByRuleId).reduce((sum, n) => sum + n, 0);
    expect(byRule).toBe(report.violationCount);
    expect(Object.keys(report.countByRuleId).sort()).toEqual([
      RULE_ID.COACH_CONFLICT,
      RULE_ID.FIELD_ELIGIBILITY,
      RULE_ID.FIELD_SAME_GROUND,
      RULE_ID.ROUND_ROBIN,
      RULE_ID.TURNOVER_MINIMUM,
    ]);
    // Constraint counts may exceed the violation count: one code can belong to
    // several records of the same policy, and all of them are named.
    expect(Object.keys(report.countByConstraintId).length).toBeGreaterThan(0);
    for (const constraintId of Object.keys(report.countByConstraintId)) {
      expect(registry.constraintIds).toContain(constraintId);
    }
  });

  it('carries its own meta-assertions: a report over nothing is a loud failure', () => {
    const emptyRun = runRuleEngine({ name: 'nothing at all' }, { registry, resources });
    const emptyReport = buildValidationReport(emptyRun, { scheduleName: 'nothing at all' });
    expect(emptyReport.violationCount).toBe(0);
    expect(emptyReport.countBySeverity).toEqual({ blocking: 0, compromise: 0, info: 0 });
    // …and yet:
    expect(codesOf(emptyReport.findings)).toEqual([
      RULE_REASON.REPORT_VACUOUS,
      RULE_REASON.REPORT_NO_RULE_EXERCISED,
    ]);
    for (const finding of emptyReport.findings) {
      expect(finding.severity).toBe(RULE_SEVERITY.BLOCKING);
    }
    expect(emptyReport.status).toBe(RULE_STATUS.REJECTED);
    expect(codesOf(emptyRun.findings)).toContain(RULE_REASON.RULE_SCHEDULE_EMPTY);
  });

  it('renders the two sections a prettier summary would leave out', () => {
    const text = renderValidationReport(report);
    expect(text).toContain('Rules that could not prove they examined the right data: none');
    expect(text).toContain(
      `Constraints no rule enforces: ${run.coverage.unenforcedConstraintIds.join(', ')}`
    );
    expect(text).toContain(`blocking: ${report.countBySeverity.blocking}`);
  });
});

/* -------------------------------------------------------------------------- */
/* Running                                                                      */
/* -------------------------------------------------------------------------- */

describe('rule engine :: running', () => {
  it('turns a rule that cannot get its evaluator into a blocking failure, not a silent skip', () => {
    const starved = runRuleEngine(schedule, { registry, resources: {} });
    expect(starved.meta.rulesThrew).toBeGreaterThan(0);
    const threw = starved.findings.filter((finding) => finding.code === RULE_REASON.RULE_THREW);
    expect(threw.length).toBe(starved.meta.rulesThrew);
    for (const finding of threw) expect(finding.severity).toBe(RULE_SEVERITY.BLOCKING);
    expect(starved.status).toBe(RULE_STATUS.REJECTED);
    // The rules that need no evaluator handle still ran and still reported.
    expect(starved.meta.rulesRun).toBeGreaterThan(0);
  });

  it('keeps going after one rule throws', () => {
    const exploding = buildRuleEngine({
      rules: [
        makeRule({
          id: 'explodes',
          evaluate: () => {
            throw new Error('boom');
          },
        }),
        makeRule({ id: 'behaves' }),
      ],
    });
    const result = runRuleEngine(tinySchedule(), { engine: exploding, registry, resources });
    expect(result.meta.rulesThrew).toBe(1);
    expect(result.meta.rulesRun).toBe(1);
    expect(result.byRuleId.behaves.exercised).toBe(true);
    expect(result.byRuleId.explodes.ran).toBe(false);
  });

  it('turns a partial rule output into that rule’s failure, not the run’s', () => {
    // A rule that returns half an output throws inside the exercise judge
    // rather than inside its own evaluator. If that throw escapes, one broken
    // rule takes down every other rule's verdict with it.
    const partial = buildRuleEngine({
      rules: [
        makeRule({ id: 'half-an-output', evaluate: () => ({ subjects: [], findings: [] }) }),
        makeRule({ id: 'behaves' }),
      ],
    });
    const result = runRuleEngine(tinySchedule(), { engine: partial, registry, resources });
    expect(result.meta.rulesThrew).toBe(1);
    expect(result.byRuleId['half-an-output'].ran).toBe(false);
    expect(codesOf(result.byRuleId['half-an-output'].findings)).toContain(RULE_REASON.RULE_THREW);
    // …and the rule next to it still produced one.
    expect(result.byRuleId.behaves.exercised).toBe(true);
    expect(result.status).toBe(RULE_STATUS.REJECTED);
  });

  it('reports an ungoverned travel policy once per transition, not once per level', () => {
    // The registry with both travel policies removed: every transition the
    // coach rule examines is then judged against no number at all.
    const travelless = buildConstraintRegistry({
      name: registry.name,
      source: registry.source,
      constraints: registry.constraints.filter(
        (record) => !record.policy.startsWith('coach-travel')
      ),
    });
    expect(travelless.constraintIds.length).toBeLessThan(registry.constraintIds.length);
    const ungovernedRun = runRuleEngine(schedule, { registry: travelless, resources });
    const onSubjects = ungovernedRun.byRuleId[RULE_ID.COACH_CONFLICT].subjects
      .flatMap((subject) => subject.findings)
      .filter((finding) => finding.code === TRAVEL_REASON.TRAVEL_POLICY_UNGOVERNED);
    // Meta-assertion: a run that governed the policy after all would make the
    // equality below true for the wrong reason.
    expect(onSubjects.length).toBeGreaterThan(0);
    const inRun = ungovernedRun.findings.filter(
      (finding) => finding.code === TRAVEL_REASON.TRAVEL_POLICY_UNGOVERNED
    );
    expect(inRun).toHaveLength(onSubjects.length);
  });

  it('lets a scoped constraint decide a severity for the subjects inside its scope', () => {
    // The registry's scoping was inert for every wired constraint: the severity
    // table was built once, from the caller's context, which defaults to naming
    // nothing — so a venue-scoped record could never reach the subjects it was
    // written for. The corpus's forty lining compromises sit at three venues,
    // which is what makes "at one of them" observable.
    const gamesById = new Map(schedule.games.map((game) => [game.id, game]));
    const liningByVenue = new Map();
    for (const violation of run.violations) {
      if (violation.code !== FACILITY_REASON.LINING_MISMATCH) continue;
      const game = gamesById.get(violation.subjectId.split('::')[1]);
      liningByVenue.set(game.venueId, (liningByVenue.get(game.venueId) ?? 0) + 1);
    }
    // Meta-assertion: two venues at least, or "only the scoped one changed"
    // would be true for the wrong reason.
    expect(liningByVenue.size).toBeGreaterThan(1);
    const [scopedVenueId, scopedCount] = [...liningByVenue.entries()].sort(
      (a, b) => b[1] - a[1]
    )[0];

    const scopedRegistry = buildConstraintRegistry({
      name: registry.name,
      source: registry.source,
      constraints: [
        ...registry.constraints,
        {
          id: 'lining-advisory-at-one-venue',
          policy: 'field-lining',
          name: 'Line markings are advisory at one venue',
          type: CONSTRAINT_TYPE.PREFERENCE,
          weight: 1,
          scope: { kind: CONSTRAINT_SCOPE_KIND.VENUE, venueId: scopedVenueId },
          parameters: {},
          restrictiveDirection: 'none',
          rationale:
            'the ground at this venue is big enough and the club plays Minis on it unlined by arrangement',
          source: {
            setBy: 'tests/ruleEngine.test.js',
            setAt: null,
            reference: 'the review finding that scoped constraints could never override a severity',
            note: 'a test fixture, not a club decision',
          },
          enforcement: 'reason-codes',
          reasonCodes: [FACILITY_REASON.LINING_MISMATCH],
          waivable: false,
        },
      ],
    });
    const scopedRun = runRuleEngine(schedule, { registry: scopedRegistry, resources });
    const scopedReport = buildValidationReport(scopedRun, { scheduleName: 'venue-scoped lining' });

    // A preference is `info`, and an `info` finding is not a violation — so the
    // scoped venue's lining findings leave the count and every other venue's
    // stay exactly where they were.
    expect(report.countByCode[FACILITY_REASON.LINING_MISMATCH]).toBe(40);
    expect(scopedReport.countByCode[FACILITY_REASON.LINING_MISMATCH]).toBe(40 - scopedCount);
    const stillReported = scopedRun.findings.filter(
      (finding) => finding.code === FACILITY_REASON.LINING_MISMATCH
    );
    expect(stillReported).toHaveLength(40);
    const demoted = stillReported.filter((finding) => finding.severity === RULE_SEVERITY.INFO);
    expect(demoted).toHaveLength(scopedCount);
    for (const finding of demoted) {
      expect(finding.details.severityBy).toBe('lining-advisory-at-one-venue');
    }

    // …and the table's own findings are reported rather than discarded: the
    // subjects that name no venue say the scoped record could not be judged
    // against them, once per record rather than once per subject.
    const unjudged = scopedRun.findings.filter(
      (finding) => finding.code === CONSTRAINT_REASON.CONSTRAINT_SCOPE_UNJUDGED
    );
    expect(unjudged).toHaveLength(1);
    expect(unjudged[0].details.constraintId).toBe('lining-advisory-at-one-venue');
    expect(codesOf(run.findings)).not.toContain(CONSTRAINT_REASON.CONSTRAINT_SCOPE_UNJUDGED);
  });

  it('re-severities Phase 1 findings through the registry rather than hard-coding them', () => {
    // The adjacency constraint is hard, so its codes stay blocking. Retype it to
    // a preference and the *same* run reports the same findings as `info`.
    const relaxed = retypeConstraint(registry, SEASON_2026_CONSTRAINT_ID.SUNSET_MARGIN, {
      type: CONSTRAINT_TYPE.PREFERENCE,
      weight: 1,
      by: 'tests/ruleEngine.test.js',
      note: 'GAP-12: the seam is the severity table, not a branch in availability/kickoff.js',
    });
    const relaxedRun = runRuleEngine(schedule, { registry: relaxed, resources });
    // The corpus violates neither, so the observable effect is on the table the
    // engine built, which the rule results were re-severitied through.
    expect(relaxedRun.meta.rulesExercised).toBe(STANDING_RULES.length);
    const before = registry.idsByReasonCode[AVAILABILITY_REASON.SUNSET_MARGIN_VIOLATED];
    expect(before).toEqual([SEASON_2026_CONSTRAINT_ID.SUNSET_MARGIN]);
    expect(requireConstraint(relaxed, SEASON_2026_CONSTRAINT_ID.SUNSET_MARGIN).type).toBe(
      CONSTRAINT_TYPE.PREFERENCE
    );
  });

  it('reports an empty registry as the blocking thing it is', () => {
    const nothing = buildConstraintRegistry({ name: 'empty', constraints: [] });
    const result = runRuleEngine(tinySchedule(), { registry: nothing, resources });
    // Every rule now enforces a constraint nobody holds.
    expect(codesOf(result.findings)).toContain(RULE_REASON.RULE_CONSTRAINT_UNKNOWN);
    expect(result.coverage.unenforcedConstraintIds).toEqual([]);
    expect(result.status).toBe(RULE_STATUS.REJECTED);
  });
});

/* -------------------------------------------------------------------------- */
/* The adapter                                                                  */
/* -------------------------------------------------------------------------- */

describe('rule engine :: the season-2026 adapter', () => {
  it('parses an age group from a division label, and admits when it cannot', () => {
    expect(season2026AgeGroup('U12B')).toBe('U12');
    expect(season2026AgeGroup('12B9v9')).toBe('U12');
    expect(season2026AgeGroup('BB')).toBeNull();
    expect(season2026AgeGroup(null)).toBeNull();
  });

  it('counts the rec layer toward season structure and nothing else', () => {
    const counted = schedule.games.filter((game) => game.counted);
    expect(counted).toHaveLength(season.recGames.length);
    expect(counted).toHaveLength(567);
  });

  it('keeps every row, dropping none of them', () => {
    expect(schedule.games).toHaveLength(season.combinedGames.length);
    const findings = makeRuleFinding(RULE_REASON.RULE_EXERCISE_SATISFIED, 'shape check', {});
    expect(findings.severity).toBe(RULE_SEVERITY.INFO);
  });
});

/* -------------------------------------------------------------------------- */
/* Round 2, finding 5 - one bad surface id used to take both field rules down   */
/* -------------------------------------------------------------------------- */

describe('rule engine :: a game on ground the graph does not hold', () => {
  /**
   * `scanConcurrency()` handed both surface ids straight to `surfacesConflict()`,
   * which looks them up with `requireSurface()` and throws. One game on an
   * unknown surface therefore made **both** concurrency rules `RULE_THREW`:
   * every real clash in the schedule went unreported and the `OCCUPIED_*` and
   * `OCCUPANCY_FOOTPRINT_UNKNOWN` counts fell to zero — which `verify` and
   * `scenario/diff.js` read as an improvement. A blindness that presents as a
   * better schedule is the worst failure mode this package has.
   *
   * The subject is chosen by property: a game that really is concurrent with
   * another at its own venue on its own date, because a game with no concurrent
   * partner never reaches the comparison and so never showed the defect.
   */

  /** Two games are concurrent when both footprints are known and they overlap. */
  const concurrent = (a, b) =>
    a.date === b.date &&
    a.endMinutes !== null &&
    b.endMinutes !== null &&
    a.startMinutes < b.endMinutes &&
    b.startMinutes < a.endMinutes;

  const victim = schedule.games.find((game) =>
    schedule.games.some(
      (other) => other.id !== game.id && other.venueId === game.venueId && concurrent(game, other)
    )
  );
  const GHOST = `${/** @type {Object} */ (victim).surfaceId}-not-in-the-graph`;

  /**
   * The same season with that one game moved onto ground the graph does not
   * hold, and **the surface universe moved with it** — which is what
   * `toSeason2026Schedule()` does, since it derives the universe from the games
   * themselves. That matters: with the ghost inside its own universe the
   * exercise judge says nothing, so `RULE_MATCHED_UNKNOWN_IDENTIFIER` does not
   * cover this case and the two rules have to speak for themselves.
   */
  const poisoned = {
    ...schedule,
    games: schedule.games.map((game) =>
      game.id === /** @type {Object} */ (victim).id ? { ...game, surfaceId: GHOST } : game
    ),
    surfaceUniverse: [...new Set([...schedule.surfaceUniverse, GHOST])].sort(),
  };
  const poisonedRun = runRuleEngine(poisoned, { registry, resources });

  /** Every violation code and how many of each, for one run. */
  const violationCounts = (result) => {
    /** @type {Record<string, number>} */
    const counts = {};
    for (const violation of result.violations) {
      counts[violation.code] = (counts[violation.code] ?? 0) + 1;
    }
    return counts;
  };

  it('has a genuinely concurrent game to move, and moves only that one', () => {
    // Three meta-assertions. Without a concurrent partner the pair loop never
    // runs; without the ghost being absent from the graph there is nothing to
    // be unable to look up; and without it being *present* in the universe the
    // exercise judge would report it and this block would be about that instead.
    expect(victim).toBeDefined();
    expect(graph.surfaceIds).not.toContain(GHOST);
    expect(poisoned.surfaceUniverse).toContain(GHOST);
    expect(poisoned.games).toHaveLength(schedule.games.length);
    expect(poisoned.games.filter((game) => game.surfaceId === GHOST)).toHaveLength(1);
  });

  it('does not take the two concurrency rules down with it', () => {
    expect(poisonedRun.meta.rulesThrew).toBe(0);
    expect(poisonedRun.meta.rulesRun).toBe(run.meta.rulesRun);
    for (const ruleId of [RULE_ID.FIELD_SAME_GROUND, RULE_ID.FIELD_ADJACENCY]) {
      expect(poisonedRun.byRuleId[ruleId].ran, ruleId).toBe(true);
      expect(
        poisonedRun.byRuleId[ruleId].findings.map((finding) => finding.code),
        ruleId
      ).not.toContain(RULE_REASON.RULE_THREW);
    }
  });

  it('keeps reporting everything the clean run reported', () => {
    // The half that mattered. Every code the clean run raised is still raised at
    // the same count, so nothing about the rest of the season went quiet.
    const before = violationCounts(run);
    const after = violationCounts(poisonedRun);
    // The meta-assertion: the clean run really does report things to lose.
    expect(Object.keys(before).length).toBeGreaterThan(3);
    expect(before[FACILITY_REASON.OCCUPANCY_FOOTPRINT_UNKNOWN]).toBeGreaterThan(0);
    for (const [code, count] of Object.entries(before)) {
      expect(after[code], `${code} after one bad surface id`).toBe(count);
    }
  });

  it('says, from each rule, which question it could not ask about that game', () => {
    for (const ruleId of [RULE_ID.FIELD_SAME_GROUND, RULE_ID.FIELD_ADJACENCY]) {
      const subject = poisonedRun.byRuleId[ruleId].subjects.find(
        (entry) => entry.details.gameId === /** @type {Object} */ (victim).id
      );
      expect(subject, ruleId).toBeDefined();
      const finding = /** @type {Object} */ (subject).findings.find(
        (entry) => entry.code === FACILITY_REASON.SURFACE_UNKNOWN
      );
      expect(finding, ruleId).toBeDefined();
      expect(finding.severity).toBe(RULE_SEVERITY.BLOCKING);
      expect(finding.details.surfaceId).toBe(GHOST);
      expect(finding.message).toContain('could not be decided');
      // Each rule names its own unrun check rather than repeating the other's.
      expect(finding.details.ruleId).toBe(ruleId);
    }
    const sameGround = /** @type {Object} */ (
      poisonedRun.byRuleId[RULE_ID.FIELD_SAME_GROUND].subjects.find(
        (entry) => entry.details.gameId === /** @type {Object} */ (victim).id
      )
    ).findings.find((entry) => entry.code === FACILITY_REASON.SURFACE_UNKNOWN);
    const adjacency = /** @type {Object} */ (
      poisonedRun.byRuleId[RULE_ID.FIELD_ADJACENCY].subjects.find(
        (entry) => entry.details.gameId === /** @type {Object} */ (victim).id
      )
    ).findings.find((entry) => entry.code === FACILITY_REASON.SURFACE_UNKNOWN);
    expect(sameGround.message).not.toBe(adjacency.message);
  });

  it('counts the pairs it could not judge rather than counting them as compared', () => {
    // The exercise minimums are written on `concurrentPairsCompared`, so a pair
    // that never reached `surfacesConflict()` must not be counted there: a
    // schedule whose every concurrent pair stood on unknown ground would
    // otherwise claim to have proved something.
    for (const ruleId of [RULE_ID.FIELD_SAME_GROUND, RULE_ID.FIELD_ADJACENCY]) {
      const counters = poisonedRun.byRuleId[ruleId].exercise.counters;
      expect(counters.unknownSurfaceGames, ruleId).toBe(1);
      expect(counters.concurrentPairsUnjudgedUnknownSurface, ruleId).toBeGreaterThan(0);
      expect(counters.concurrentPairsCompared, ruleId).toBe(
        run.byRuleId[ruleId].exercise.counters.concurrentPairsCompared -
          counters.concurrentPairsUnjudgedUnknownSurface
      );
    }
  });

  it('reports nothing of the sort on the clean season', () => {
    // The negative control: a guard that fired for every surface would pass
    // every assertion above and report the whole corpus as unknown ground.
    for (const ruleId of [RULE_ID.FIELD_SAME_GROUND, RULE_ID.FIELD_ADJACENCY]) {
      expect(run.byRuleId[ruleId].exercise.counters.unknownSurfaceGames, ruleId).toBe(0);
      expect(
        run.byRuleId[ruleId].exercise.counters.concurrentPairsUnjudgedUnknownSurface,
        ruleId
      ).toBe(0);
      expect(
        run.byRuleId[ruleId].subjects.flatMap((entry) =>
          entry.findings.map((finding) => finding.code)
        ),
        ruleId
      ).not.toContain(FACILITY_REASON.SURFACE_UNKNOWN);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Round 3, finding 1 - a counter that counted pairs it never judged            */
/* -------------------------------------------------------------------------- */

describe('rule engine :: a coach overlap that cannot be decided', () => {
  /**
   * `conflictFairnessRule` bumped `commitmentPairsCompared` **before** the
   * unknown-end check and then `continue`d in silence. Three things followed
   * from one line in the wrong order:
   *
   * 1. an undecidable overlap read as *"no conflict"* — the fabricated
   *    all-clear `bookingsOverlapInTime()` returns `null` precisely to avoid;
   * 2. nothing anywhere said the question had not been answered;
   * 3. the rule's own exercise minimum, which is written on that counter, was
   *    satisfied by pairs it never judged — so a season whose every cross-team
   *    coach pair stood on an unmeasurable commitment would have reported a
   *    clean spread and a satisfied minimum, having compared nothing.
   *
   * This is the counter half of the `scanConcurrency()` fix one rule over, and
   * the reporting half of what `reserve/slots.js` `doubleBookingFindings()` and
   * `waivers/coachTravel.js` already do: three answers, and the third one said
   * out loud.
   *
   * The corpus reaches it. GAP-14's `Scrimmage` rows have no `game_formats.csv`
   * entry and therefore no measurable end, and one of them shares a person and
   * a date with a commitment for a different team.
   */

  /** Every cross-team commitment pair the rule's own join produces. */
  const crossTeamPairs = () => {
    /** @type {Map<string, Array<Object>>} */
    const byPersonDate = new Map();
    for (const commitment of schedule.commitments) {
      const key = [commitment.personId, commitment.date].join('|');
      if (!byPersonDate.has(key)) byPersonDate.set(key, []);
      /** @type {Array<Object>} */ (byPersonDate.get(key)).push(commitment);
    }
    /** @type {Array<{ a: Object, b: Object }>} */
    const pairs = [];
    for (const entries of byPersonDate.values()) {
      for (let i = 0; i < entries.length; i += 1) {
        for (let j = i + 1; j < entries.length; j += 1) {
          const a = entries[i];
          const b = entries[j];
          if (a.teamId === null || b.teamId === null || a.teamId === b.teamId) continue;
          pairs.push({ a, b });
        }
      }
    }
    return pairs;
  };

  const allPairs = crossTeamPairs();
  const undecidable = allPairs.filter(
    (pair) => pair.a.endMinutes === null || pair.b.endMinutes === null
  );
  const counters = run.byRuleId[RULE_ID.CONFLICT_FAIRNESS].exercise.counters;
  const fairnessFindings = run.byRuleId[RULE_ID.CONFLICT_FAIRNESS].findings;

  it('has an undecidable cross-team coach pair in the corpus to be wrong about', () => {
    // The meta-assertion this whole block rests on. Without it every assertion
    // below would hold vacuously, which is the failure mode the file is named
    // for.
    expect(allPairs.length).toBeGreaterThan(0);
    expect(undecidable.length).toBeGreaterThan(0);
    // And the undecidability is GAP-14's, not an artefact: the commitment with
    // no end is one whose game the format table cannot measure.
    for (const pair of undecidable) {
      const unmeasurable = [pair.a, pair.b].filter((entry) => entry.endMinutes === null);
      expect(unmeasurable.length).toBeGreaterThan(0);
    }
  });

  it('counts only the pairs it actually judged, and reports the rest as their own number', () => {
    // The falsification. An implementation that bumps the counter before the
    // unknown-end check reports `commitmentPairsCompared === allPairs.length`
    // and no third value at all; both halves of this fail against it.
    expect(counters.commitmentPairsCompared).toBe(allPairs.length - undecidable.length);
    expect(counters.commitmentPairsUnjudgedUnknownEnd).toBe(undecidable.length);
    expect(counters.commitmentPairsCompared).toBeLessThan(allPairs.length);
    // Nothing is lost between the two: every pair the join produced is in
    // exactly one of them.
    expect(counters.commitmentPairsCompared + counters.commitmentPairsUnjudgedUnknownEnd).toBe(
      allPairs.length
    );
  });

  it('says which overlap it could not decide, rather than calling it no conflict', () => {
    const raised = fairnessFindings.filter(
      (finding) => finding.code === RULE_VIOLATION_REASON.CONFLICT_OVERLAP_UNJUDGED
    );
    expect(raised).toHaveLength(undecidable.length);
    const finding = raised[0];
    expect(finding.severity).toBe(RULE_SEVERITY.COMPROMISE);
    // The finding names the person, the date, both sides and which commitment
    // is the unmeasurable one — enough to act on without parsing the message.
    expect(typeof finding.details.personId).toBe('string');
    expect(typeof finding.details.date).toBe('string');
    expect(finding.details.teamIds).toHaveLength(2);
    expect(
      /** @type {string[]} */ (finding.details.unmeasurableCommitmentIds).length
    ).toBeGreaterThan(0);
    expect(finding.message).toContain('cannot be decided');
    // It reaches the run's own findings and therefore its status, which is the
    // whole difference between this fix and a field nobody reads.
    expect(run.findings.map((entry) => entry.code)).toContain(
      RULE_VIOLATION_REASON.CONFLICT_OVERLAP_UNJUDGED
    );
  });

  it('withholds a verdict rather than inventing either one', () => {
    // The pair is undecidable *only* because an end is missing, and the proof
    // is that supplying one decides it. Give the unmeasurable commitment the
    // end its format cannot supply and the pair moves from the unjudged column
    // to the compared one and the finding goes away; nothing else about the
    // rule changes. An implementation that had simply waved the pair through
    // would show no movement at all.
    const unmeasurableIds = new Set(
      undecidable.flatMap((pair) =>
        [pair.a, pair.b].filter((entry) => entry.endMinutes === null).map((entry) => entry.id)
      )
    );
    expect(unmeasurableIds.size).toBeGreaterThan(0);
    const measured = {
      ...schedule,
      commitments: schedule.commitments.map((commitment) =>
        unmeasurableIds.has(commitment.id)
          ? { ...commitment, endMinutes: commitment.startMinutes + 60 }
          : commitment
      ),
    };
    const measuredRun = runRuleEngine(measured, { registry, resources });
    const after = measuredRun.byRuleId[RULE_ID.CONFLICT_FAIRNESS].exercise.counters;
    expect(after.commitmentPairsUnjudgedUnknownEnd).toBe(0);
    expect(after.commitmentPairsCompared).toBe(allPairs.length);
    expect(
      measuredRun.byRuleId[RULE_ID.CONFLICT_FAIRNESS].findings.map((finding) => finding.code)
    ).not.toContain(RULE_VIOLATION_REASON.CONFLICT_OVERLAP_UNJUDGED);
  });

  it('fails its exercise minimum on a season it could not judge at all', () => {
    // The positive control, and the reason the counter split matters. Every
    // commitment loses its end, so every cross-team pair is undecidable. The
    // pre-fix implementation counts all 137 of them as compared, clears its
    // minimum of 1, and reports a clean spread having measured nothing. The
    // fixed one counts zero and says so at blocking.
    const blinded = {
      ...schedule,
      commitments: schedule.commitments.map((commitment) => ({
        ...commitment,
        endMinutes: null,
      })),
    };
    const blindRun = runRuleEngine(blinded, { registry, resources });
    const blindCounters = blindRun.byRuleId[RULE_ID.CONFLICT_FAIRNESS].exercise.counters;
    // The mutation applied.
    expect(blinded.commitments.filter((entry) => entry.endMinutes === null)).toHaveLength(
      schedule.commitments.length
    );
    expect(blindCounters.commitmentPairsCompared).toBe(0);
    expect(blindCounters.commitmentPairsUnjudgedUnknownEnd).toBe(allPairs.length);
    const codes = blindRun.byRuleId[RULE_ID.CONFLICT_FAIRNESS].findings.map(
      (finding) => finding.code
    );
    expect(codes).toContain(RULE_REASON.RULE_EXERCISE_BELOW_MINIMUM);
    const below = blindRun.byRuleId[RULE_ID.CONFLICT_FAIRNESS].findings.find(
      (finding) => finding.code === RULE_REASON.RULE_EXERCISE_BELOW_MINIMUM
    );
    expect(below.severity).toBe(RULE_SEVERITY.BLOCKING);
  });

  it('leaves no other rule in this file counting what it did not judge', () => {
    // The sweep finding 1 asks for, encoded rather than described. Every rule
    // whose exercise minimum is written on a "compared"/"judged" counter must
    // report a *third* value beside it — the count it could not decide — or
    // have no undecidable path at all. The pairs are stated here so that a new
    // rule with a compared-counter minimum fails until it is classified.
    const withPairCounters = {
      [RULE_ID.FIELD_SAME_GROUND]: 'concurrentPairsUnjudgedUnknownSurface',
      [RULE_ID.FIELD_ADJACENCY]: 'concurrentPairsUnjudgedUnknownSurface',
      [RULE_ID.COACH_CONFLICT]: 'personPairsJudged',
      [RULE_ID.CONFLICT_FAIRNESS]: 'commitmentPairsUnjudgedUnknownEnd',
    };
    for (const [ruleId, thirdValue] of Object.entries(withPairCounters)) {
      const seen = run.byRuleId[ruleId].exercise.counters;
      expect(Object.keys(seen), ruleId).toContain(thirdValue);
      expect(typeof seen[thirdValue], ruleId).toBe('number');
    }
    // `turnover-minimum` and `round-robin` reach an undecidable case too, and
    // each already answers it the other admissible way: a finding on the
    // subject naming the thing it could not measure, plus a *second* minimum
    // that a blinded run cannot clear (`policiesResolved`, `divisionsJudged`).
    // Asserted rather than trusted, because that is what makes their absence
    // from the table above a classification rather than an omission.
    expect(
      STANDING_RULES.find((rule) => rule.id === RULE_ID.TURNOVER_MINIMUM).reasonCodes
    ).toContain(RULE_VIOLATION_REASON.TURNOVER_UNJUDGED);
    expect(
      Object.keys(
        STANDING_RULES.find((rule) => rule.id === RULE_ID.TURNOVER_MINIMUM).exercise.minimums
      )
    ).toContain('policiesResolved');
    expect(STANDING_RULES.find((rule) => rule.id === RULE_ID.ROUND_ROBIN).reasonCodes).toContain(
      RULE_VIOLATION_REASON.ROUND_ROBIN_DIVISION_UNJUDGED
    );
    expect(run.byRuleId[RULE_ID.ROUND_ROBIN].exercise.counters.divisionsJudged).toBeLessThanOrEqual(
      run.byRuleId[RULE_ID.ROUND_ROBIN].exercise.counters.divisionsExamined
    );
  });
});
