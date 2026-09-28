/**
 * Constraint attribution on every decision — Prompt 4.3.
 *
 * > *"Every placement, rejection, and computed boundary must be able to state
 * > the binding constraint."*
 *
 * Two acceptance tests, both against the season-2026 corpus:
 *
 * 1. **For every game in the fixture, the system produces an attribution.** All
 *    679 rows of `combined_schedule.csv`, counted rather than sampled, with the
 *    coverage comparison built from two independently-derived numbers and a
 *    positive control proving it can fail.
 * 2. **A deliberately over-constrained placement names a minimal blocking set of
 *    2-3 constraints rather than everything.** Minimality is *proved*: for each
 *    member, relaxing every other member leaves the placement illegal, and the
 *    test re-establishes that property itself rather than reading the module's
 *    `certified` flag — then runs the same check against a padded set to show it
 *    fails there.
 *
 * Plus the four questions the build plan names, each answered in one call, each
 * with its answer derived from the corpus rather than written down here.
 *
 * Every figure below is computed at test time. Where a scenario had to be built
 * rather than found, the test says so in the word "constructed" and says what
 * the corpus supplied.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

import {
  AVAILABILITY_CONSTRAINT,
  AVAILABILITY_REASON,
  buildAvailabilityCalendarFromSeason2026,
  latestLegalKickoff,
  resolveLighting,
  resolvePermitWindow,
} from '@squadlogic/core/availability/index.js';
import {
  CONSTRAINT_ENFORCEMENT,
  CONSTRAINT_REASON,
  CONSTRAINT_SCOPE_KIND,
  CONSTRAINT_SEVERITY,
  CONSTRAINT_TYPE,
  SEASON_2026_CONSTRAINT_ID,
  buildConstraintRegistry,
  buildSeason2026ConstraintRegistry,
} from '@squadlogic/core/constraints/index.js';
import {
  FACILITY_REASON,
  buildFacilityGraphFromSeason2026,
  buildSeason2026VenueComplexMap,
  season2026SurfaceId,
} from '@squadlogic/core/facility/index.js';
import {
  loadCoachRoster,
  loadExternalFixtures,
  loadFacilityGeometry,
  loadFacilityPermits,
  loadGameFormats,
  loadSeason2026,
  loadSunsets,
} from '@squadlogic/core/fixtures/index.js';
import { PEOPLE_REASON, buildSeason2026CoachRoster } from '@squadlogic/core/people/index.js';
import {
  bookingsOn,
  checkPlacement,
  season2026ExternalFixtureChanges,
} from '@squadlogic/core/resolve/index.js';
import {
  ScheduleSchema,
  runRuleEngine,
  toSeason2026Schedule,
} from '@squadlogic/core/ruleEngine/index.js';
import {
  SEASON_2026_INCIDENT_8_WARMUP_MINUTES,
  TIMING_REASON,
  buildFormatTimingTableFromSeason2026,
  earliestKickoffWithWarmup,
} from '@squadlogic/core/timing/index.js';

import {
  ATTRIBUTION_CODES_BY_CONSTRAINT_KIND,
  ATTRIBUTION_QUESTION,
  ATTRIBUTION_REASON,
  ATTRIBUTION_REASON_SEVERITY,
  ATTRIBUTION_SEVERITY,
  ATTRIBUTION_SOURCE,
  ATTRIBUTION_SOURCE_BY_REASON_CODE,
  ATTRIBUTION_STATUS,
  attributionSeverityOf,
  attributionSourceOf,
  buildAttributionContext,
  categoryOnlyClaimFindings,
  claimFromRosterFinding,
  createAttributionMeta,
  explainEarliestKickoff,
  explainGame,
  explainKickoffTime,
  explainLatestKickoff,
  explainSchedule,
  explainTeamConflict,
  isSpecificClaim,
  makeClaim,
  minimalBlockingSet,
} from '@squadlogic/core/attribution/index.js';

/* -------------------------------------------------------------------------- */
/* Corpus and engines, loaded once                                             */
/* -------------------------------------------------------------------------- */

const season = loadSeason2026();
const graph = buildFacilityGraphFromSeason2026(loadFacilityGeometry());
const rawFormats = loadGameFormats();
const table = buildFormatTimingTableFromSeason2026(rawFormats);
const sunsets = loadSunsets();
/** Derived from the corpus rather than typed in, so a re-dated fixture moves it. */
const SEASON_YEAR = Number(sunsets[0].date.slice(0, 4));
const calendar = buildAvailabilityCalendarFromSeason2026(
  loadFacilityPermits({ seasonYear: SEASON_YEAR }),
  sunsets
);
const registry = buildSeason2026ConstraintRegistry();
const venueComplexes = buildSeason2026VenueComplexMap();
const schedule = toSeason2026Schedule(season);
const roster = buildSeason2026CoachRoster(loadCoachRoster());
const verification = runRuleEngine(schedule, {
  registry,
  resources: { graph, timingTable: table, calendar, venueComplexes },
});

/** The context every question below is asked of. */
const context = buildAttributionContext({
  graph,
  table,
  calendar,
  registry,
  schedule,
  verification,
  venueComplexes,
  roster,
});

/** The whole season, attributed once. */
const sweep = explainSchedule(context);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CORE = path.join(ROOT, 'packages', 'core', 'src');

/* -------------------------------------------------------------------------- */
/* Guard block — runs before anything behavioural                              */
/* -------------------------------------------------------------------------- */

describe('attribution :: corpus guard', () => {
  it('is asked of the whole published season, not a slice of it', () => {
    // Without these, "every game is attributed" would be a statement about
    // whatever subset happened to load. 679 is the corpus README's own figure.
    expect(schedule.games.length).toBe(679);
    expect(schedule.commitments.length).toBeGreaterThan(0);
    expect(registry.constraintIds.length).toBeGreaterThan(0);
    expect(verification.meta.rulesRun).toBeGreaterThan(0);
  });

  it('was built with everything it can be built with, so no answer is thin by accident', () => {
    // The context reports what it is missing. This one is missing nothing, and
    // that is asserted here so that a `compromise` anywhere below is a fact
    // about the schedule rather than about the question.
    expect(context.findings).toEqual([]);
    expect(context.status).toBe(ATTRIBUTION_STATUS.ALLOWED);
    expect(context.verification).not.toBeNull();
    expect(context.travel).not.toBeNull();
    expect(context.soleCoach).not.toBeNull();
    expect(context.meta.transitionsConsulted).toBeGreaterThan(0);
    expect(context.meta.rosterEntriesConsulted).toBeGreaterThan(0);
  });

  it('says what it is missing when it is missing something', () => {
    // The positive control for the block above: the same builder, handed less.
    const thin = buildAttributionContext({ graph, table, calendar, registry, schedule });
    const codes = thin.findings.map((finding) => finding.code).sort();
    expect(codes).toEqual([
      ATTRIBUTION_REASON.ATTRIBUTION_ROSTER_ABSENT,
      ATTRIBUTION_REASON.ATTRIBUTION_TRAVEL_ABSENT,
      ATTRIBUTION_REASON.ATTRIBUTION_VERIFICATION_ABSENT,
    ]);
    expect(thin.status).toBe(ATTRIBUTION_STATUS.COMPROMISED);
    // …and the thinness travels: an answer built from that context carries it,
    // so a facility-only explanation can never read as a complete one.
    const answer = explainGame(thin, { gameId: schedule.games[0].id });
    expect(answer.status).toBe(ATTRIBUTION_STATUS.COMPROMISED);
    expect(answer.findings.map((finding) => finding.code)).toContain(
      ATTRIBUTION_REASON.ATTRIBUTION_VERIFICATION_ABSENT
    );
  });
});

/* -------------------------------------------------------------------------- */
/* The frozen tables                                                           */
/* -------------------------------------------------------------------------- */

describe('attribution :: the reason-code tables are frozen and complete', () => {
  it('registers a severity for every reason code, and refuses an unregistered one', () => {
    for (const code of Object.values(ATTRIBUTION_REASON)) {
      expect(Object.values(ATTRIBUTION_SEVERITY)).toContain(attributionSeverityOf(code));
    }
    expect(Object.keys(ATTRIBUTION_REASON_SEVERITY).sort()).toEqual(
      Object.values(ATTRIBUTION_REASON).sort()
    );
    expect(() => attributionSeverityOf('ATTRIBUTION_NOT_A_CODE')).toThrow(/no registered severity/);
    expect(Object.isFrozen(ATTRIBUTION_REASON_SEVERITY)).toBe(true);
  });

  it('gives every constraint kind a code bucket, and every code in it is real', () => {
    const kinds = Object.values(AVAILABILITY_CONSTRAINT).sort();
    expect(Object.keys(ATTRIBUTION_CODES_BY_CONSTRAINT_KIND).sort()).toEqual(kinds);
    const known = new Set([
      ...Object.values(AVAILABILITY_REASON),
      // The occupancy codes are the facility module's, which is why they are
      // read from a finding rather than spelled: `checkKickoffAvailability()`
      // returns them verbatim from `checkBooking()`.
      'OCCUPIED_SAME_SURFACE',
      'OCCUPIED_PARENT_CHILD',
      'OCCUPIED_SPATIAL_OVERLAP',
    ]);
    for (const codes of Object.values(ATTRIBUTION_CODES_BY_CONSTRAINT_KIND)) {
      expect(codes.length).toBeGreaterThan(0);
      for (const code of codes) expect(known.has(code), code).toBe(true);
    }
  });

  it('buckets every reason code the registry governs exactly once', () => {
    // The drift check. A registry constraint that claims a code nothing buckets
    // would produce claims that cannot name the constraint governing them —
    // "an instance, not a category" failing quietly at the seam.
    const bucketed = Object.values(ATTRIBUTION_CODES_BY_CONSTRAINT_KIND).flat();
    expect(new Set(bucketed).size).toBe(bucketed.length);
    const governed = Object.keys(registry.idsByReasonCode);
    expect(governed.length).toBeGreaterThan(0);
    const placementCodes = governed.filter((code) => !code.startsWith('WARMUP_'));
    for (const code of placementCodes) {
      expect(bucketed.filter((entry) => entry === code).length, code).toBe(1);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* The bar every claim has to clear                                            */
/* -------------------------------------------------------------------------- */

describe('attribution :: a claim names an instance and says something computed', () => {
  it('refuses a category label — the check that would otherwise never fire', () => {
    // The positive control. `sunset` with nothing attached is exactly the answer
    // this module exists to replace, and the predicate every answer is checked
    // against has to reject it or the checks below mean nothing.
    const category = makeClaim({ source: ATTRIBUTION_SOURCE.AVAILABILITY, kind: 'sunset' });
    expect(isSpecificClaim(category)).toBe(false);

    // Named but silent, and computed but anonymous: both halves are required.
    expect(
      isSpecificClaim(
        makeClaim({
          source: ATTRIBUTION_SOURCE.AVAILABILITY,
          kind: 'sunset',
          instanceId: '2026-10-31',
        })
      )
    ).toBe(false);
    expect(
      isSpecificClaim(
        makeClaim({
          source: ATTRIBUTION_SOURCE.AVAILABILITY,
          kind: 'sunset',
          computed: { limitMinutes: 1064 },
        })
      )
    ).toBe(false);
    expect(
      isSpecificClaim(
        makeClaim({
          source: ATTRIBUTION_SOURCE.AVAILABILITY,
          kind: 'sunset',
          instanceId: '2026-10-31',
          computed: { limitMinutes: 1064, slackMinutes: 14 },
        })
      )
    ).toBe(true);
  });

  it('makes an answer carrying a category-only claim rejected, not merely noisy', () => {
    // The severity is what enforces it: a `blocking` finding derives `rejected`.
    expect(ATTRIBUTION_REASON_SEVERITY[ATTRIBUTION_REASON.ATTRIBUTION_CLAIM_CATEGORY_ONLY]).toBe(
      ATTRIBUTION_SEVERITY.BLOCKING
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Acceptance 1 — every game in the fixture produces an attribution            */
/* -------------------------------------------------------------------------- */

describe('attribution :: acceptance 1 — every game in the fixture is attributed', () => {
  it('attributes all 679 games, counted from the schedule rather than from the answers', () => {
    expect(sweep.coverage.gamesInSchedule).toBe(schedule.games.length);
    expect(sweep.coverage.gamesAttributed).toBe(schedule.games.length);
    expect(sweep.coverage.gamesUnattributed).toEqual([]);
    expect(sweep.coverage.complete).toBe(true);
    // The two numbers come from different places — the schedule and the answers
    // — and the counter behind the second one agrees with it.
    expect(sweep.meta.gamesExamined).toBe(schedule.games.length);
    expect(sweep.meta.gamesAttributed).toBe(schedule.games.length);
    expect(Object.keys(sweep.byGameId).length).toBe(schedule.games.length);
  });

  it('gives every one of them at least one claim, and none of them a category label', () => {
    expect(sweep.coverage.claimsPerGameMinimum).toBeGreaterThan(0);
    expect(sweep.coverage.categoryOnlyClaims).toBe(0);
    expect(sweep.coverage.claims).toBeGreaterThan(schedule.games.length);
    expect(sweep.status).toBe(ATTRIBUTION_STATUS.ALLOWED);

    // Asserted over every claim of every game, not over a sample: the predicate
    // is cheap and "most of them are specific" is not the guarantee.
    let checked = 0;
    for (const attribution of sweep.attributions) {
      expect(attribution.claims.length, attribution.gameId).toBeGreaterThan(0);
      for (const claim of attribution.claims) {
        checked += 1;
        expect(isSpecificClaim(claim), `${attribution.gameId} :: ${claim.kind}`).toBe(true);
      }
    }
    expect(checked).toBe(sweep.coverage.claims);
  });

  it('names the binding constraint of every game it says has one', () => {
    // `bindingKinds` is `checkKickoffAvailability()`'s answer, consumed. Where
    // it names a kind, a claim of that kind must be present and marked binding —
    // otherwise the attribution and the machinery behind it disagree.
    let withBinding = 0;
    for (const attribution of sweep.attributions) {
      if (attribution.bindingKinds.length === 0) continue;
      withBinding += 1;
      const kinds = attribution.claims.filter((claim) => claim.binding).map((claim) => claim.kind);
      for (const kind of attribution.bindingKinds) {
        expect(kinds, attribution.gameId).toContain(kind);
      }
    }
    // Meta-assertion: this ran against a real population.
    expect(withBinding).toBe(schedule.games.length);
  });

  it('refuses to call an empty schedule fully attributed', () => {
    // "Every game is attributed" is true of a season with no games and means
    // nothing, which is incident 4 in one sentence.
    const empty = explainSchedule({ ...context, schedule: { ...schedule, games: [] } });
    expect(empty.coverage.complete).toBe(false);
    expect(empty.coverage.gamesInSchedule).toBe(0);
    expect(empty.status).toBe(ATTRIBUTION_STATUS.REJECTED);
    expect(empty.findings.map((finding) => finding.code)).toContain(
      ATTRIBUTION_REASON.ATTRIBUTION_SWEEP_VACUOUS
    );
  });

  it('detects a game it cannot explain, rather than leaving it out of the list', () => {
    // The positive control for the coverage check. A schedule row the state does
    // not hold is the shape of a row a broken join dropped: the sweep must name
    // it and go `rejected`, never quietly report 679 of 680.
    const phantom = { ...schedule.games[0], id: 'phantom::not-in-the-state' };
    const doctored = {
      ...context,
      schedule: { ...schedule, games: [...schedule.games, phantom] },
    };
    const broken = explainSchedule(doctored);
    expect(broken.coverage.gamesInSchedule).toBe(schedule.games.length + 1);
    expect(broken.coverage.gamesAttributed).toBe(schedule.games.length);
    expect(broken.coverage.gamesUnattributed).toEqual([phantom.id]);
    expect(broken.coverage.complete).toBe(false);
    expect(broken.status).toBe(ATTRIBUTION_STATUS.REJECTED);
    expect(broken.findings.map((finding) => finding.code)).toContain(
      ATTRIBUTION_REASON.ATTRIBUTION_GAME_UNKNOWN
    );
  });

  it('reports claims tightest-first, in the order the availability module set', () => {
    // The ordering is `orderByTightness()`'s and is passed through. Asserted
    // against that function's own output, per game, for every game: the ordered
    // availability claims must be the applicable constraints in the same order.
    let compared = 0;
    for (const attribution of sweep.attributions) {
      const placement = checkPlacement(
        { graph, table, calendar, registry },
        context.state,
        attribution.gameId,
        attribution.slot
      );
      const expected = placement.availability.constraints
        .filter((constraint) => constraint.applicable)
        .map((constraint) => constraint.kind);
      const actual = attribution.claims
        .filter((claim) => claim.source === ATTRIBUTION_SOURCE.AVAILABILITY)
        .map((claim) => claim.kind);
      expect(actual, attribution.gameId).toEqual(expected);
      compared += expected.length;
    }
    expect(compared).toBeGreaterThan(schedule.games.length);
  });
});

/* -------------------------------------------------------------------------- */
/* The four questions the build plan names                                     */
/* -------------------------------------------------------------------------- */

/**
 * The external fixtures whose agreed time differs from the time the other league
 * published — the corpus's own record of incident 3.
 */
const externalChanges = season2026ExternalFixtureChanges(loadExternalFixtures(), schedule);
const negotiated = externalChanges.filter(
  (change) =>
    /** @type {Object} */ (schedule.games.find((game) => game.id === change.gameId))
      .startMinutes !== change.startMinutes
);
/** The later of the two negotiated kickoffs: the 12:30 that made a 9v9 block illegal. */
const latePublished = [...negotiated].sort((a, b) => b.startMinutes - a.startMinutes)[0];

describe('attribution :: "why is this game at this time and not that one?"', () => {
  it('answers with the constraint instance the alternative would break, and by how much', () => {
    // One call. The alternative is the time `external_fixtures_published.csv`
    // records, read from the corpus rather than typed here.
    const answer = explainKickoffTime(context, {
      gameId: latePublished.gameId,
      insteadOfMinutes: latePublished.startMinutes,
      insteadOfSurfaceId: latePublished.surfaceId,
      insteadOfDate: latePublished.date,
    });

    expect(answer.question).toBe(ATTRIBUTION_QUESTION.WHY_THIS_TIME);
    expect(answer.status).toBe(ATTRIBUTION_STATUS.ALLOWED);

    // The fact: it is legal where it stands.
    expect(answer.current.legal).toBe(true);
    expect(answer.slot.startMinutes).toBeLessThan(answer.alternative.startMinutes);

    // The counterfactual: at the published time it is not, and the answer names
    // the specific instance — which registry constraint, which *other games*,
    // and how many minutes short. Incident 3's "illegal by exactly 10 minutes".
    expect(answer.counterfactual.legal).toBe(false);
    expect(answer.counterfactual.constraintIds).toContain(
      SEASON_2026_CONSTRAINT_ID.FIELD_OVERLAP_ADJACENCY
    );
    expect(answer.counterfactual.counterpartGameIds.length).toBeGreaterThan(0);
    const binding = /** @type {Object} */ (answer.counterfactual.binding);
    expect(binding.kind).toBe(AVAILABILITY_CONSTRAINT.OCCUPANCY);
    expect(binding.slackMinutes).toBe(-10);
    expect(binding.summary).toContain('slack -10 min');

    // The counterparts are the already-published games on *overlapping* ground,
    // not on the pitch itself — which is the whole of incident 3.
    const counterparts = answer.counterfactual.counterpartGameIds.map((gameId) =>
      schedule.games.find((game) => game.id === gameId)
    );
    expect(counterparts.every((game) => game !== undefined)).toBe(true);
    for (const game of counterparts) {
      expect(/** @type {Object} */ (game).surfaceId).not.toBe(answer.alternative.surfaceId);
      expect(/** @type {Object} */ (game).format).toBe('9v9');
    }

    const explained = answer.findings.find(
      (finding) => finding.code === ATTRIBUTION_REASON.ATTRIBUTION_ALTERNATIVE_BLOCKED
    );
    expect(explained).toBeDefined();
    expect(/** @type {Object} */ (explained).details.slackMinutes).toBe(-10);
  });

  it('says so when the alternative is legal too, rather than implying the time was forced', () => {
    // The other half of the same question, and it has to be *found*: an answer
    // that only ever says "blocked" would pass every assertion above while being
    // unable to tell a forced time from a chosen one. The alternatives tried are
    // kickoff minutes the corpus itself uses at that venue on that date, never
    // invented ones.
    /** @type {Object|null} */
    let legal = null;
    let attempts = 0;
    for (const game of schedule.games) {
      const kickoffs = [
        ...new Set(
          schedule.games
            .filter((entry) => entry.date === game.date && entry.venueId === game.venueId)
            .map((entry) => entry.startMinutes)
        ),
      ].sort((a, b) => a - b);
      for (const minutes of kickoffs) {
        if (minutes === game.startMinutes) continue;
        attempts += 1;
        const answer = explainKickoffTime(context, {
          gameId: game.id,
          insteadOfMinutes: minutes,
        });
        if (!answer.counterfactual.legal) continue;
        legal = answer;
        break;
      }
      if (legal !== null) break;
    }

    // Meta-assertions: alternatives really were tried, and rejected ones existed.
    expect(attempts).toBeGreaterThan(1);
    expect(legal).not.toBeNull();
    const answer = /** @type {Object} */ (legal);
    expect(answer.findings.map((finding) => finding.code)).toContain(
      ATTRIBUTION_REASON.ATTRIBUTION_ALTERNATIVE_LEGAL
    );
    expect(answer.counterfactual.blockingCodes).toEqual([]);
    expect(answer.counterfactual.claims.length).toBeGreaterThan(0);
    expect(answer.status).toBe(ATTRIBUTION_STATUS.ALLOWED);
  });

  it('refuses to compare a slot with itself', () => {
    const game = schedule.games[0];
    const answer = explainKickoffTime(context, {
      gameId: game.id,
      insteadOfMinutes: game.startMinutes,
    });
    expect(answer.findings.map((finding) => finding.code)).toContain(
      ATTRIBUTION_REASON.ATTRIBUTION_ALTERNATIVE_NO_OP
    );
    expect(answer.status).toBe(ATTRIBUTION_STATUS.COMPROMISED);
  });
});

describe('attribution :: "why can\'t this game go later?"', () => {
  /**
   * The game with the least room against the daylight limit, found in the
   * corpus by reading the attributions rather than chosen here.
   */
  const sunsetBound = sweep.attributions
    .filter((attribution) => attribution.bindingKinds.includes(AVAILABILITY_CONSTRAINT.SUNSET))
    .map((attribution) => ({
      attribution,
      claim: /** @type {Object} */ (
        attribution.claims.find((entry) => entry.kind === AVAILABILITY_CONSTRAINT.SUNSET)
      ),
    }))
    .filter((entry) => entry.claim && typeof entry.claim.slackMinutes === 'number')
    .sort((a, b) => a.claim.slackMinutes - b.claim.slackMinutes)[0];

  it('answers "sunset margin, not permit close" — with both numbers', () => {
    expect(sunsetBound).toBeDefined();
    const answer = explainLatestKickoff(context, { gameId: sunsetBound.attribution.gameId });

    expect(answer.question).toBe(ATTRIBUTION_QUESTION.WHY_NOT_LATER);
    expect(answer.status).toBe(ATTRIBUTION_STATUS.ALLOWED);
    expect(answer.bindingKinds).toEqual([AVAILABILITY_CONSTRAINT.SUNSET]);
    expect(answer.kickoffMinutes).not.toBeNull();
    expect(answer.headroomMinutes).toBeGreaterThanOrEqual(0);

    // Ordered by tightness, and *both* edges reported: the answer to "why not
    // later" is useless without the runner-up, because "sunset" alone reads as
    // "the site closes" to everybody who has not read the permit table.
    const sunset = /** @type {Object} */ (
      answer.claims.find((claim) => claim.kind === AVAILABILITY_CONSTRAINT.SUNSET)
    );
    const permit = /** @type {Object} */ (
      answer.claims.find((claim) => claim.kind === AVAILABILITY_CONSTRAINT.PERMIT)
    );
    expect(sunset).toBeDefined();
    expect(permit).toBeDefined();
    expect(answer.claims.indexOf(sunset)).toBeLessThan(answer.claims.indexOf(permit));
    expect(sunset.binding).toBe(true);
    expect(permit.binding).toBe(false);

    // The instance, not the category: the sunset record for that date, the
    // margin it was reduced by, the permit record and its close minute.
    expect(sunset.instanceId).toBe(sunsetBound.attribution.slot.date);
    expect(sunset.constraintIds).toEqual([SEASON_2026_CONSTRAINT_ID.SUNSET_MARGIN]);
    expect(sunset.computed.sunsetMinutes).toBeGreaterThan(0);
    expect(sunset.computed.sunsetMarginMinutes).toBeGreaterThan(0);
    expect(sunset.computed.limitMinutes).toBe(
      sunset.computed.sunsetMinutes - sunset.computed.sunsetMarginMinutes
    );
    expect(permit.constraintIds).toEqual([SEASON_2026_CONSTRAINT_ID.PERMIT_WINDOW]);
    expect(permit.computed.closeMinutes).toBeGreaterThan(sunset.computed.limitMinutes);
    expect(permit.slackMinutes).toBeGreaterThan(/** @type {number} */ (sunset.slackMinutes));

    // The boundary itself is the sunset limit less the occupancy, which is the
    // availability module's arithmetic and is only read back here.
    expect(answer.kickoffMinutes).toBe(sunset.computed.latestKickoffMinutes);

    // And the edges that do not bound it say why, rather than being absent.
    expect(answer.notApplicable.map((entry) => entry.kind)).toContain(
      AVAILABILITY_CONSTRAINT.LIGHTING
    );
    for (const entry of answer.notApplicable) expect(entry.reason.length).toBeGreaterThan(0);
  });

  it('names a game it does not hold rather than answering about nothing', () => {
    const answer = explainLatestKickoff(context, { gameId: 'not-a-game' });
    expect(answer.status).toBe(ATTRIBUTION_STATUS.REJECTED);
    expect(answer.findings.map((finding) => finding.code)).toContain(
      ATTRIBUTION_REASON.ATTRIBUTION_GAME_UNKNOWN
    );
    expect(answer.claims).toEqual([]);
  });
});

const ALDER = 'Alder Park';
const PITCH_2 = season2026SurfaceId(ALDER, 'Pitch 2');
const PITCH_1A = season2026SurfaceId(ALDER, 'Pitch 1A');
const PITCH_1B = season2026SurfaceId(ALDER, 'Pitch 1B');
const WARMUP = SEASON_2026_INCIDENT_8_WARMUP_MINUTES;

// Derived exactly as `tests/gameTimeModel.test.js` derives it, so the two
// suites cannot drift into asking about different days. Incident 8's date is
// the one where 9v9s run on the ground Pitch 2 overlaps.
const busyDate = [
  ...new Set(schedule.games.filter((game) => game.surfaceId === PITCH_2).map((game) => game.date)),
]
  .sort()
  .filter((date) =>
    schedule.games.some(
      (game) =>
        game.date === date && game.format === '9v9' && [PITCH_1A, PITCH_1B].includes(game.surfaceId)
    )
  )[0];
/** The search floor: when the last already-booked Pitch 2 slot clears. */
const floor = Math.max(
  ...schedule.games
    .filter((game) => game.surfaceId === PITCH_2 && game.date === busyDate)
    .map((game) => /** @type {number} */ (game.endMinutes))
);
/** The last 9v9 to finish on the overlapping Pitch 1A: incident 8's 2:55 PM. */
const afternoonNine = schedule.games
  .filter((game) => game.date === busyDate && game.format === '9v9' && game.surfaceId === PITCH_1A)
  .sort((a, b) => /** @type {number} */ (b.endMinutes) - /** @type {number} */ (a.endMinutes))[0];

describe('attribution :: "what\'s the earliest kickoff allowing a full 30-minute warm-up?"', () => {
  it('answers with the booking that set it — on the overlapping field, not this one', () => {
    const answer = explainEarliestKickoff(context, {
      surfaceId: PITCH_2,
      date: busyDate,
      format: '11v11',
      warmupMinutes: WARMUP,
      notBeforeMinutes: floor,
    });

    expect(answer.question).toBe(ATTRIBUTION_QUESTION.EARLIEST_KICKOFF);
    expect(answer.status).toBe(ATTRIBUTION_STATUS.ALLOWED);
    // Meta-assertion: the bound really is the overlapping pitch rather than the
    // floor the question named, or "3:25 PM" would be an answer to a question
    // with no constraint in it.
    expect(/** @type {number} */ (afternoonNine.endMinutes)).toBeGreaterThan(floor);
    // 3:25 PM in the source project's words; derived here from the 9v9 that
    // clears the overlapping ground plus the stated warm-up.
    expect(answer.kickoffMinutes).toBe(/** @type {number} */ (afternoonNine.endMinutes) + WARMUP);

    const claim = /** @type {Object} */ (answer.binding);
    expect(claim.source).toBe(ATTRIBUTION_SOURCE.WARMUP);
    expect(claim.computed.warmupMinutes).toBe(WARMUP);
    expect(claim.computed.warmupStartMinutes).toBe(afternoonNine.endMinutes);
    expect(claim.computed.kickoffMinutes).toBe(answer.kickoffMinutes);
    // The instance is the booking, and it is on ground that overlaps rather than
    // on the pitch being played on. That sentence is the whole incident.
    expect(claim.entities.some((entity) => entity.id === afternoonNine.id)).toBe(true);
    expect(claim.detail).toContain('overlaps this pitch');
    expect(claim.constraintIds).toContain(SEASON_2026_CONSTRAINT_ID.FIELD_OVERLAP_ADJACENCY);
  });

  it('says when nothing bounded the answer, rather than presenting a floor as a limit', () => {
    // Asked from after everything on that ground has cleared, the answer is the
    // floor the question named. That is a different statement from "a booking
    // pushed you here", and an answer that could not tell them apart would read
    // as a constraint where there is none.
    const lastEnd = Math.max(
      ...schedule.games
        .filter((game) => game.date === busyDate && game.endMinutes !== null)
        .map((game) => /** @type {number} */ (game.endMinutes))
    );
    const answer = explainEarliestKickoff(context, {
      surfaceId: PITCH_2,
      date: busyDate,
      format: '11v11',
      warmupMinutes: WARMUP,
      notBeforeMinutes: lastEnd,
    });
    expect(answer.kickoffMinutes).toBe(lastEnd + WARMUP);
    expect(answer.binding).toBeNull();
    expect(answer.bindingKinds).toEqual([]);
    expect(answer.findings.map((finding) => finding.code)).toContain(
      ATTRIBUTION_REASON.ATTRIBUTION_BOUND_UNSTATED
    );
    expect(answer.status).toBe(ATTRIBUTION_STATUS.COMPROMISED);
  });

  it('will not invent a warm-up length nobody stated', () => {
    const answer = explainEarliestKickoff(context, {
      surfaceId: PITCH_2,
      date: busyDate,
      format: '11v11',
      notBeforeMinutes: floor,
    });
    expect(answer.kickoffMinutes).toBeNull();
    expect(answer.status).toBe(ATTRIBUTION_STATUS.COMPROMISED);
    expect(answer.findings.map((finding) => finding.code)).toContain(
      ATTRIBUTION_REASON.ATTRIBUTION_QUESTION_UNANSWERABLE
    );
  });
});

describe('attribution :: "why did this team get a conflict?"', () => {
  /** Every transition the travel evaluator reports something above `info` about. */
  const conflicted = /** @type {Object} */ (context.travel).transitions.filter((transition) =>
    transition.findings.some((finding) => finding.severity !== 'info')
  );
  /** The teams the sole-coach register says have exactly one active coach. */
  const soleCoachTeams = new Set(
    /** @type {Object} */ (context.soleCoach).teams.map((entry) => entry.teamId)
  );
  /** A conflict where one of the two teams has no fallback coach at all. */
  const withSoleCoach = conflicted.find(
    (transition) =>
      soleCoachTeams.has(transition.from.teamId) || soleCoachTeams.has(transition.to.teamId)
  );
  /** A conflict judged against the inter-venue travel floor. */
  const withTravelFloor = conflicted.find(
    (transition) => typeof transition.minimumGapMinutes === 'number'
  );

  it('names the other team, its game, and whether anybody could have covered', () => {
    expect(withSoleCoach).toBeDefined();
    // Ask about the team that is *not* the sole-coached one: "why did this team
    // get a conflict" is asked by whoever is looking at the other fixture.
    const soleTeam = soleCoachTeams.has(withSoleCoach.from.teamId)
      ? withSoleCoach.from.teamId
      : withSoleCoach.to.teamId;
    const teamId =
      soleTeam === withSoleCoach.from.teamId ? withSoleCoach.to.teamId : withSoleCoach.from.teamId;

    const answer = explainTeamConflict(context, { teamId });
    expect(answer.question).toBe(ATTRIBUTION_QUESTION.TEAM_CONFLICT);
    expect(answer.conflicts.length).toBeGreaterThan(0);
    expect(answer.meta.transitionsConsulted).toBe(
      /** @type {Object} */ (context.travel).transitions.length
    );

    const conflict = /** @type {Object} */ (
      answer.conflicts.find((entry) => entry.transitionId === withSoleCoach.id)
    );
    expect(conflict).toBeDefined();
    expect(conflict.personId).toBe(withSoleCoach.personId);
    expect(conflict.counterpartTeamIds).toEqual([soleTeam]);
    expect(conflict.counterpartGameIds).toContain(withSoleCoach.from.gameId);
    expect(conflict.counterpartGameIds).toContain(withSoleCoach.to.gameId);

    // The travel claim carries the two kickoffs, so "ten minutes earlier" is a
    // number the answer holds rather than one a reader has to look up.
    const travel = /** @type {Object} */ (
      conflict.claims.find((claim) => claim.source === ATTRIBUTION_SOURCE.COACH_TRAVEL)
    );
    expect(travel.computed.fromStartMinutes).toBe(withSoleCoach.from.startMinutes);
    expect(travel.computed.toStartMinutes).toBe(withSoleCoach.to.startMinutes);
    expect(travel.instanceId).toBe(withSoleCoach.id);
    expect(travel.entities.some((entity) => entity.kind === 'person')).toBe(true);
    expect(travel.entities.some((entity) => entity.id === soleTeam)).toBe(true);

    // And the roster's half of the answer: that team had nobody else. Two
    // independent roster functions agree — the register's finding, and the list
    // of people who could actually have taken the fixture.
    const rosterClaim = /** @type {Object} */ (
      conflict.claims.find((claim) => claim.source === ATTRIBUTION_SOURCE.ROSTER)
    );
    expect(rosterClaim).toBeDefined();
    expect(rosterClaim.instanceId).toBe(soleTeam);
    expect(rosterClaim.entities.some((entity) => entity.id === withSoleCoach.personId)).toBe(true);
    expect(conflict.coverPersonIds).toEqual([]);
    // …and the same list is non-empty where the team does have a second coach,
    // or "nobody could have covered" would be a sentence this answer says about
    // every conflict.
    const covered = answer.conflicts
      .concat(
        explainTeamConflict(context, {
          teamId: /** @type {string} */ (withTravelFloor.to.teamId),
        }).conflicts
      )
      .filter((entry) => entry.coverPersonIds.length > 0);
    expect(covered.length).toBeGreaterThan(0);
  });

  it('names the floor the gap was judged against, and the shortfall', () => {
    expect(withTravelFloor).toBeDefined();
    const teamId = /** @type {string} */ (withTravelFloor.to.teamId ?? withTravelFloor.from.teamId);
    const answer = explainTeamConflict(context, { teamId });
    const claim = /** @type {Object} */ (
      answer.claims.find((entry) => entry.instanceId === withTravelFloor.id)
    );
    expect(claim).toBeDefined();
    expect(claim.constraintIds).toContain(SEASON_2026_CONSTRAINT_ID.COACH_TRAVEL_BETWEEN_VENUES);
    expect(claim.computed.gapMinutes).toBe(withTravelFloor.gapMinutes);
    expect(claim.computed.minimumGapMinutes).toBe(withTravelFloor.minimumGapMinutes);
    expect(claim.computed.shortfallMinutes).toBe(
      withTravelFloor.minimumGapMinutes - withTravelFloor.gapMinutes
    );
    expect(claim.slackMinutes).toBe(-claim.computed.shortfallMinutes);
    expect(claim.summary).toContain('minimum gap');
  });

  it('refuses a team the schedule does not declare, rather than reporting "no conflict"', () => {
    // Incident 4's shape: a broken join empties a team's commitments, and the
    // honest answer is "unknown", never "clean".
    const answer = explainTeamConflict(context, { teamId: 'U12B04' });
    expect(answer.status).toBe(ATTRIBUTION_STATUS.REJECTED);
    expect(answer.findings.map((finding) => finding.code)).toContain(
      ATTRIBUTION_REASON.ATTRIBUTION_TEAM_UNKNOWN
    );
  });

  it('reports a clean team as clean, with the count of what it examined', () => {
    const quiet = /** @type {string} */ (
      schedule.teamUniverse.find(
        (teamId) =>
          !conflicted.some(
            (transition) => transition.from.teamId === teamId || transition.to.teamId === teamId
          )
      )
    );
    const answer = explainTeamConflict(context, { teamId: quiet });
    expect(answer.conflicts).toEqual([]);
    const finding = /** @type {Object} */ (
      answer.findings.find(
        (entry) => entry.code === ATTRIBUTION_REASON.ATTRIBUTION_TEAM_NO_CONFLICT
      )
    );
    expect(finding.details.transitionsExamined).toBeGreaterThan(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Acceptance 2 — the minimal blocking set                                     */
/* -------------------------------------------------------------------------- */

/**
 * **Constructed**, and here is what the corpus supplied and what was built.
 *
 * The corpus supplies: an unlit venue, its permit close, that date's sunset, and
 * two games standing on one surface. What is constructed is a single slot no
 * corpus row occupies — one of those two games moved to the minute its venue's
 * permit closes, and the other asked to stand on top of it. That breaks three
 * things at once, which is what an over-constrained placement is, and every
 * number in it is still the corpus's.
 */
function overConstrained() {
  /** @type {Map<string, { date: string, surfaceId: string, venueId: string, games: Object[] }>} */
  const groups = new Map();
  for (const game of schedule.games) {
    if (game.endMinutes === null) continue;
    const key = `${game.date}|${game.surfaceId}`;
    if (!groups.has(key)) {
      groups.set(key, {
        date: game.date,
        surfaceId: game.surfaceId,
        venueId: game.venueId,
        games: [],
      });
    }
    /** @type {Object} */ (groups.get(key)).games.push(game);
  }

  /** @type {Array<{ date: string, surfaceId: string, venueId: string, closeMinutes: number, games: Object[] }>} */
  const candidates = [];
  for (const { date, surfaceId, venueId, games } of groups.values()) {
    if (games.length < 2) continue;
    // The venue must be unlit and the date must have a sunset, or the daylight
    // rule does not apply and the placement breaks two constraints, not three.
    if (resolveLighting(graph, calendar, surfaceId).lit) continue;
    const permit = resolvePermitWindow(calendar, { venueId, date });
    if (permit.window === null || permit.window.closeMinutes === null) continue;
    candidates.push({
      date,
      surfaceId,
      venueId,
      closeMinutes: permit.window.closeMinutes,
      games: [...games].sort((a, b) => a.startMinutes - b.startMinutes),
    });
  }
  candidates.sort(
    (a, b) =>
      b.games.length - a.games.length ||
      b.date.localeCompare(a.date) ||
      a.surfaceId.localeCompare(b.surfaceId)
  );

  const chosen = candidates[0];
  const [anchor, subject] = chosen.games;
  const stackedSchedule = {
    ...schedule,
    games: schedule.games.map((game) =>
      game.id === anchor.id
        ? {
            ...game,
            startMinutes: chosen.closeMinutes,
            endMinutes:
              chosen.closeMinutes + /** @type {number} */ (anchor.endMinutes - anchor.startMinutes),
          }
        : game
    ),
  };
  return {
    chosen,
    anchor,
    subject,
    slot: {
      date: chosen.date,
      surfaceId: chosen.surfaceId,
      startMinutes: chosen.closeMinutes,
    },
    stackedContext: buildAttributionContext({
      graph,
      table,
      calendar,
      registry,
      schedule: stackedSchedule,
      verification,
      venueComplexes,
      roster,
    }),
  };
}

const over = overConstrained();

/**
 * Is `constraintIds` a minimal blocking set for this placement, checked
 * independently of the module that reported it?
 *
 * Deliberately a second implementation *of the property*, not of the search: the
 * property is what the acceptance test is about, and reading the module's own
 * `certified` flag would be the module marking its own homework.
 *
 * @param {Object} attributionContext
 * @param {string} gameId
 * @param {Object} slot
 * @param {ReadonlyArray<string>} constraintIds
 * @returns {{ sufficient: boolean, eachNecessary: boolean, minimal: boolean }}
 */
function verifyMinimality(attributionContext, gameId, slot, constraintIds) {
  /**
   * @param {ReadonlyArray<string>} relaxedIds
   * @returns {boolean}
   */
  const legalWith = (relaxedIds) =>
    checkPlacement(
      {
        ...attributionContext.engines,
        registry: softened(attributionContext.engines.registry, relaxedIds),
      },
      attributionContext.state,
      gameId,
      slot
    ).legal;
  const sufficient = legalWith(constraintIds);
  const eachNecessary = constraintIds.every(
    (constraintId) => !legalWith(constraintIds.filter((id) => id !== constraintId))
  );
  return { sufficient, eachNecessary, minimal: sufficient && eachNecessary };
}

/**
 * A registry with these constraints softened to preferences, rebuilt from the
 * records here rather than through the projection helper the module under test
 * uses. Two routes to the same registry, so the check above is independent of
 * the search it is checking.
 *
 * @param {Object} source
 * @param {ReadonlyArray<string>} constraintIds
 * @returns {Object}
 */
function softened(source, constraintIds) {
  const soften = new Set(constraintIds);
  return buildConstraintRegistry({
    name: source.name,
    source: source.source,
    constraints: source.constraints.map((record) =>
      soften.has(record.id)
        ? { ...record, type: CONSTRAINT_TYPE.PREFERENCE, weight: record.weight ?? 1 }
        : record
    ),
  });
}

describe('attribution :: acceptance 2 — a minimal blocking set, not the registry', () => {
  const result = minimalBlockingSet(over.stackedContext, {
    gameId: over.subject.id,
    slot: over.slot,
  });

  it('is over-constrained in the first place, by three separate things', () => {
    // The meta-assertion this whole block rests on. A placement blocked by one
    // constraint would produce a "minimal set" of one and prove nothing.
    const placement = checkPlacement(
      { graph, table, calendar, registry },
      over.stackedContext.state,
      over.subject.id,
      over.slot
    );
    expect(placement.legal).toBe(false);
    expect(placement.blockingCodes.length).toBeGreaterThanOrEqual(3);
    expect(placement.blockingCodes).toContain(AVAILABILITY_REASON.PERMIT_CLOSE_EXCEEDED);
    expect(placement.blockingCodes).toContain(AVAILABILITY_REASON.SUNSET_MARGIN_VIOLATED);
    expect(placement.blockingCodes).toContain('OCCUPIED_SAME_SURFACE');
  });

  it('names 3 constraints out of the registry’s 14, each with its own numbers', () => {
    expect(result.blocked).toBe(true);
    expect(result.constraintIds.length).toBeGreaterThanOrEqual(2);
    expect(result.constraintIds.length).toBeLessThanOrEqual(3);
    expect(result.constraintIds).toEqual(
      [
        SEASON_2026_CONSTRAINT_ID.FIELD_SAME_GROUND_EXCLUSIVE,
        SEASON_2026_CONSTRAINT_ID.PERMIT_WINDOW,
        SEASON_2026_CONSTRAINT_ID.SUNSET_MARGIN,
      ].sort()
    );
    // "Do not dump the whole registry": the denominator is reported so three of
    // fourteen is legible as three of fourteen.
    expect(result.proof.registryConstraintsHeld).toBe(registry.constraintIds.length);
    expect(result.constraintIds.length).toBeLessThan(registry.constraintIds.length);
    expect(result.ungovernedBlockingCodes).toEqual([]);

    // Every member arrives as an instance with computed values, not as an id.
    expect(result.claims.length).toBe(result.constraintIds.length);
    for (const claim of result.claims) {
      expect(isSpecificClaim(claim), claim.kind).toBe(true);
      expect(Object.keys(claim.computed).length).toBeGreaterThan(0);
      expect(claim.constraintIds.length).toBeGreaterThan(0);
    }
    const permitClaim = /** @type {Object} */ (
      result.claims.find((claim) =>
        claim.constraintIds.includes(SEASON_2026_CONSTRAINT_ID.PERMIT_WINDOW)
      )
    );
    expect(permitClaim.computed.closeMinutes).toBe(over.chosen.closeMinutes);
    expect(permitClaim.computed.overrunMinutes).toBeGreaterThan(0);
  });

  it('proves every member necessary, and hands back the proof', () => {
    expect(result.certified).toBe(true);
    expect(result.proof.legalWhenAllRelaxed).toBe(true);
    expect(result.witnesses.length).toBe(result.constraintIds.length);
    for (const witness of result.witnesses) {
      // Dropping this member changes the answer: with every *other* member
      // relaxed the placement is still illegal, and the code that survives is
      // this member's own.
      expect(witness.legal, witness.constraintId).toBe(false);
      expect(witness.relaxedConstraintIds).toEqual(
        result.constraintIds.filter((id) => id !== witness.constraintId)
      );
      expect(witness.blockingCodes.length).toBeGreaterThan(0);
    }
    expect(result.meta.membersProvenNecessary).toBe(result.constraintIds.length);
    expect(result.meta.relaxationsTested).toBeGreaterThan(result.constraintIds.length);
    expect(result.proof.candidatesConsidered).toBe(result.candidateConstraintIds.length);
    expect(result.proof.membersReported).toBe(result.constraintIds.length);

    // The proof is stated as a finding too, with the counters behind it, so a
    // reader who never opens `witnesses` still sees how it was established.
    const proven = /** @type {Object} */ (
      result.findings.find(
        (finding) => finding.code === ATTRIBUTION_REASON.ATTRIBUTION_MINIMAL_SET_PROVEN
      )
    );
    expect(proven).toBeDefined();
    expect(proven.details.witnessCount).toBe(result.witnesses.length);
    expect(proven.details.registryConstraintsHeld).toBe(registry.constraintIds.length);
  });

  it('is minimal when checked independently — and a padded set is not', () => {
    // The property, re-established from outside the module.
    const verdict = verifyMinimality(
      over.stackedContext,
      over.subject.id,
      over.slot,
      result.constraintIds
    );
    expect(verdict.sufficient).toBe(true);
    expect(verdict.eachNecessary).toBe(true);
    expect(verdict.minimal).toBe(true);

    // The positive control that makes the check above worth reading: a set that
    // is merely *short* is not minimal, and the same check says so. Padding the
    // reported set with one constraint that has nothing to do with this
    // placement keeps it under three and breaks minimality.
    const padded = [...result.constraintIds, SEASON_2026_CONSTRAINT_ID.TURNOVER_FLOOR_GLOBAL];
    const paddedVerdict = verifyMinimality(over.stackedContext, over.subject.id, over.slot, padded);
    expect(paddedVerdict.sufficient).toBe(true);
    expect(paddedVerdict.eachNecessary).toBe(false);
    expect(paddedVerdict.minimal).toBe(false);
    // …and the module did not report that padded set.
    expect(result.constraintIds).not.toContain(SEASON_2026_CONSTRAINT_ID.TURNOVER_FLOOR_GLOBAL);
  });

  it('drops a candidate that turns out to be unnecessary', () => {
    // The control that proves the deletion filter is a search rather than a
    // rename of "the constraints the codes implied". A venue-scoped record
    // claiming the same daylight code outranks the global one wherever it
    // applies, so relaxing the global one alone changes nothing and it is
    // dropped — leaving a set that is smaller than its own candidate list.
    const shadowed = buildSeason2026ConstraintRegistry({
      extraConstraints: [
        {
          id: 'sunset-margin-at-this-venue',
          policy: 'sunset-margin',
          name: 'Daylight margin, stated again for one venue',
          type: CONSTRAINT_TYPE.HARD,
          scope: { kind: CONSTRAINT_SCOPE_KIND.VENUE, venueId: over.chosen.venueId },
          parameters: {},
          restrictiveDirection: 'none',
          rationale:
            'Constructed by tests/attribution.test.js: a narrower record claiming the same code, so that the global one becomes an unnecessary candidate and the deletion filter has something real to drop.',
          source: {
            setBy: 'tests/attribution.test.js',
            setAt: null,
            reference: 'tests/attribution.test.js — the deletion-filter control',
            note: 'constructed for a test; never part of the seeded season-2026 set',
          },
          effectiveFrom: null,
          effectiveTo: null,
          enforcement: CONSTRAINT_ENFORCEMENT.REASON_CODES,
          reasonCodes: [AVAILABILITY_REASON.SUNSET_MARGIN_VIOLATED],
          weight: null,
          waivable: false,
          history: [],
        },
      ],
    });
    const shadowedContext = {
      ...over.stackedContext,
      engines: { ...over.stackedContext.engines, registry: shadowed },
    };
    const shadowedResult = minimalBlockingSet(shadowedContext, {
      gameId: over.subject.id,
      slot: over.slot,
    });

    expect(shadowedResult.candidateConstraintIds).toContain(
      SEASON_2026_CONSTRAINT_ID.SUNSET_MARGIN
    );
    expect(shadowedResult.candidateConstraintIds).toContain('sunset-margin-at-this-venue');
    expect(shadowedResult.droppedConstraintIds).toEqual([SEASON_2026_CONSTRAINT_ID.SUNSET_MARGIN]);
    expect(shadowedResult.constraintIds).toContain('sunset-margin-at-this-venue');
    expect(shadowedResult.constraintIds.length).toBe(
      shadowedResult.candidateConstraintIds.length - 1
    );
    expect(shadowedResult.certified).toBe(true);
    expect(shadowedResult.meta.membersDropped).toBe(1);
  });

  it('says so when a blocker cannot be lifted by any change of hardness', () => {
    // The corpus's four `Scrimmage` rows are blocked by `SIZE_UNKNOWN_FORMAT`
    // (GAP-14), which no constraint in the registry claims. A "minimal
    // explanation" that quietly omitted it would be the most confident kind of
    // wrong, so the set is left uncertified and the code is named.
    const unliftable = /** @type {Object} */ (
      sweep.attributions.find((attribution) => !attribution.legal)
    );
    expect(unliftable).toBeDefined();
    const answer = minimalBlockingSet(context, { gameId: unliftable.gameId });
    expect(answer.blocked).toBe(true);
    expect(answer.ungovernedBlockingCodes.length).toBeGreaterThan(0);
    expect(answer.certified).toBe(false);
    expect(answer.witnesses).toEqual([]);
    expect(answer.proof.legalWhenAllRelaxed).toBe(false);
    const codes = answer.findings.map((finding) => finding.code);
    expect(codes).toContain(ATTRIBUTION_REASON.ATTRIBUTION_BLOCKER_UNGOVERNED);
    // …and the set is not merely uncertified, it is refused: relaxing every
    // candidate left the placement illegal, so there is no blocking set to
    // report and saying otherwise would be a minimality claim resting on
    // nothing.
    expect(codes).toContain(ATTRIBUTION_REASON.ATTRIBUTION_MINIMAL_SET_UNCERTIFIED);
    expect(answer.status).toBe(ATTRIBUTION_STATUS.REJECTED);
  });

  it('has no answer, rather than an empty one, for a placement that is legal', () => {
    const legal = /** @type {Object} */ (
      sweep.attributions.find((attribution) => attribution.legal)
    );
    const answer = minimalBlockingSet(context, { gameId: legal.gameId });
    expect(answer.blocked).toBe(false);
    expect(answer.constraintIds).toEqual([]);
    expect(answer.findings.map((finding) => finding.code)).toContain(
      ATTRIBUTION_REASON.ATTRIBUTION_PLACEMENT_NOT_BLOCKED
    );
  });
});

/* -------------------------------------------------------------------------- */
/* The counterfactual sweep — the path the coverage sweep does not walk        */
/* -------------------------------------------------------------------------- */

/**
 * Every game against every *other* kickoff its own venue uses on its own date.
 *
 * The 679-game coverage sweep walks `explainGame()`: the slot each row already
 * occupies, where the corpus is by construction almost entirely legal. The
 * counterfactual is the other half of "why here and not there", it is where a
 * placement is actually *blocked*, and it is a different code path — so it gets
 * its own population rather than borrowing the coverage sweep's clean bill of
 * health. Only kickoff minutes the corpus itself uses at that venue on that
 * date are tried, never invented ones.
 *
 * Reduced to the fields the checks below need, because 3,000-odd whole answers
 * held at once is a memory cost with no reader.
 */
const counterfactuals = [];
for (const game of schedule.games) {
  const kickoffs = [
    ...new Set(
      schedule.games
        .filter((entry) => entry.date === game.date && entry.venueId === game.venueId)
        .map((entry) => entry.startMinutes)
    ),
  ].sort((a, b) => a - b);
  for (const minutes of kickoffs) {
    if (minutes === game.startMinutes) continue;
    const answer = explainKickoffTime(context, {
      gameId: game.id,
      insteadOfMinutes: minutes,
    });
    counterfactuals.push({
      where: `${game.id} at minute ${minutes}`,
      legal: answer.counterfactual.legal,
      blockingCodes: answer.counterfactual.blockingCodes,
      claimCodes: answer.counterfactual.claims.flatMap((claim) => claim.codes),
      binding: answer.counterfactual.binding,
      blocked:
        answer.findings.find(
          (finding) => finding.code === ATTRIBUTION_REASON.ATTRIBUTION_ALTERNATIVE_BLOCKED
        ) ?? null,
    });
  }
}

describe('attribution :: every blocking code in an answer is carried by a claim', () => {
  it('holds over the whole counterfactual sweep, not over one example', () => {
    // The invariant this module exists for: saying "blocked" and being unable to
    // say by what is the failure it was written to replace. Asserted over every
    // counterfactual the corpus supports rather than over the one the narrative
    // happens to name.
    let blocked = 0;
    /** @type {string[]} */
    const orphaned = [];
    for (const entry of counterfactuals) {
      if (entry.legal) {
        expect(entry.blockingCodes, entry.where).toEqual([]);
        continue;
      }
      blocked += 1;
      expect(entry.blockingCodes.length, entry.where).toBeGreaterThan(0);
      const carried = new Set(entry.claimCodes);
      const missing = entry.blockingCodes.filter((code) => !carried.has(code));
      if (missing.length > 0) orphaned.push(`${entry.where} :: ${missing.join(', ')}`);
    }
    // Meta-assertions: a real population, and a real population of *blocked*
    // ones. A sweep that found nothing to block would pass the check below for
    // the worst possible reason.
    expect(counterfactuals.length).toBeGreaterThan(3000);
    expect(blocked).toBeGreaterThan(1000);
    expect(orphaned).toEqual([]);
  });

  it('keeps the same promise for "why can\'t this game go later?"', () => {
    // The other function that sorts findings into constraint kinds, and the
    // other place a finding can fall between a bound and no bound. Every
    // consequential finding `latestLegalKickoff()` raised must reach a claim.
    let withConsequential = 0;
    /** @type {string[]} */
    const orphaned = [];
    /** @type {Set<string>} */
    const population = new Set();
    for (const game of schedule.games) {
      const owner = latestLegalKickoff(
        graph,
        table,
        calendar,
        {
          surfaceId: game.surfaceId,
          date: game.date,
          format: game.format,
          notBeforeMinutes: game.startMinutes,
          ignoreBookingIds: [game.id],
        },
        { existingBookings: bookingsOn(context.state, game.date, game.id) }
      );
      const spoke = owner.findings.filter(
        (finding) => finding.severity !== ATTRIBUTION_SEVERITY.INFO
      );
      if (spoke.length === 0) continue;
      withConsequential += 1;
      for (const finding of spoke) population.add(finding.code);
      const answer = explainLatestKickoff(context, { gameId: game.id });
      const carried = new Set(answer.claims.flatMap((claim) => claim.codes));
      const missing = [...new Set(spoke.map((finding) => finding.code))].filter(
        (code) => !carried.has(code)
      );
      if (missing.length > 0) orphaned.push(`${game.id} :: ${missing.join(', ')}`);
    }
    // Meta-assertions: a real population, and one the registry does not
    // re-severity — so the owner's severity and the effective one agree and this
    // comparison is exact rather than approximately right.
    expect(withConsequential).toBeGreaterThan(100);
    expect(population.size).toBeGreaterThan(1);
    for (const code of population) expect(registry.idsByReasonCode[code], code).toBeUndefined();
    expect(orphaned).toEqual([]);
  });
});

describe('attribution :: a blocked alternative never reports a margin nobody measured', () => {
  it('renders no positive slack as a negative one, over the whole counterfactual sweep', () => {
    // An attribution that reports a wrong number confidently is worse than one
    // that declines to report. Where a margin is stated it must be the binding
    // *blocking* claim's own negative slack — the amount the bound is broken by
    // — and never a sign-flipped edge belonging to a different constraint.
    let blocked = 0;
    let withMargin = 0;
    let withoutMargin = 0;
    /** @type {string[]} */
    const wrong = [];
    for (const entry of counterfactuals) {
      if (entry.legal) continue;
      blocked += 1;
      const finding = /** @type {Object} */ (entry.blocked);
      const slack = finding.details.slackMinutes;
      const binding = /** @type {Object} */ (entry.binding);
      if (slack === null) {
        withoutMargin += 1;
        // No number claimed anywhere in the sentence either.
        if (/by -?\d+ min/.test(finding.message)) {
          wrong.push(`${entry.where} :: says a margin while reporting none: ${finding.message}`);
        }
        continue;
      }
      withMargin += 1;
      if (typeof slack !== 'number' || slack >= 0) {
        wrong.push(`${entry.where} :: slackMinutes ${slack} is not a broken bound`);
        continue;
      }
      if (!finding.message.includes(`by ${-slack} min`)) {
        wrong.push(`${entry.where} :: message and details disagree: ${finding.message}`);
      }
      // …and the margin belongs to the thing that blocked it, not to whichever
      // edge happened to be tightest.
      if (binding === null || binding.severity !== ATTRIBUTION_SEVERITY.BLOCKING) {
        wrong.push(`${entry.where} :: margin taken from a ${binding?.severity ?? 'missing'} claim`);
      }
      if (binding !== null && binding.slackMinutes !== slack) {
        wrong.push(`${entry.where} :: margin is not the binding claim's own slack`);
      }
    }
    // Meta-assertions: both branches were exercised on a real population, so
    // neither "always reports a margin" nor "never reports one" could pass this.
    expect(blocked).toBeGreaterThan(1000);
    expect(withMargin).toBeGreaterThan(100);
    expect(withoutMargin).toBeGreaterThan(0);
    expect(wrong).toEqual([]);
  });
});

describe('attribution :: the sole-coach claim counts each team once', () => {
  /** The register the context already built, read rather than rebuilt. */
  const register = /** @type {Object} */ (context.soleCoach);

  it('reports the teams the register named, not one more', () => {
    // `PERSON_SOLE_COACH_OF_MULTIPLE_TEAMS` names *every* team in `teamIds`, the
    // subject included, so counting "the others, plus this one" counts the
    // subject twice: two teams reported as three, on the one claim whose whole
    // content is how many teams have nobody to fall back to.
    const multi = /** @type {Object} */ (
      register.findings.find(
        (finding) => finding.code === PEOPLE_REASON.PERSON_SOLE_COACH_OF_MULTIPLE_TEAMS
      )
    );
    expect(multi).toBeDefined();
    const teamIds = /** @type {string[]} */ (multi.details.teamIds);
    expect(teamIds.length).toBeGreaterThan(1);

    const claim = claimFromRosterFinding(multi, {
      teamId: teamIds[0],
      personId: /** @type {string} */ (multi.details.personId),
    });
    expect(claim.computed.coversTeams).toBe(teamIds.length);
    // …and the subject team appears once in the entity list, not twice.
    const teams = claim.entities
      .filter((entity) => entity.kind === 'team')
      .map((entity) => entity.id);
    expect(teams).toEqual([...new Set(teams)]);
    expect([...teams].sort()).toEqual([...teamIds].sort());
  });

  it('still counts the subject team for the register’s other finding', () => {
    // The control that stops the fix above becoming an off-by-one the other way.
    // `TEAM_SOLE_COACH` names the subject team separately and lists only the
    // *other* teams that coach takes, so the subject genuinely has to be added.
    const sole = /** @type {Object} */ (
      register.findings.find(
        (finding) =>
          finding.code === PEOPLE_REASON.TEAM_SOLE_COACH &&
          /** @type {string[]} */ (finding.details.alsoCoaches ?? []).length > 0
      )
    );
    expect(sole).toBeDefined();
    const alsoCoaches = /** @type {string[]} */ (sole.details.alsoCoaches);
    expect(alsoCoaches).not.toContain(sole.details.teamId);

    const claim = claimFromRosterFinding(sole, {
      teamId: /** @type {string} */ (sole.details.teamId),
      personId: /** @type {string} */ (sole.details.personId),
    });
    expect(claim.computed.coversTeams).toBe(alsoCoaches.length + 1);
    const teams = claim.entities
      .filter((entity) => entity.kind === 'team')
      .map((entity) => entity.id);
    expect(teams).toEqual([...new Set(teams)]);
    expect([...teams].sort()).toEqual([sole.details.teamId, ...alsoCoaches].sort());
  });
});

/**
 * A registry record built for one test, claiming one reason code at one
 * hardness.
 *
 * **Constructed**, and it has to be: the published season's fourteen records are
 * all hard or soft over codes whose base severity already agrees with them, so
 * nothing in the corpus separates "the frozen table said so" from "the registry
 * said so". Retyping a constraint is what Prompt 2.1 exists to make routine, and
 * this is the smallest thing that makes the difference observable.
 *
 * @param {{ id: string, type: string, reasonCodes: string[], note: string }} spec
 * @returns {Object}
 */
function constructedConstraint(spec) {
  return {
    id: spec.id,
    policy: spec.id,
    name: spec.note,
    type: spec.type,
    scope: { kind: CONSTRAINT_SCOPE_KIND.GLOBAL },
    parameters: {},
    restrictiveDirection: 'none',
    rationale: `Constructed by tests/attribution.test.js: ${spec.note}`,
    source: {
      setBy: 'tests/attribution.test.js',
      setAt: null,
      reference: 'tests/attribution.test.js — the registry-severity seam',
      note: 'constructed for a test; never part of the seeded season-2026 set',
    },
    effectiveFrom: null,
    effectiveTo: null,
    enforcement: CONSTRAINT_ENFORCEMENT.REASON_CODES,
    reasonCodes: spec.reasonCodes,
    weight: spec.type === CONSTRAINT_TYPE.PREFERENCE ? 1 : null,
    waivable: false,
    history: [],
  };
}

describe('attribution :: the boundary answers honour the registry too', () => {
  it('re-severities "why can\'t this game go later?" the way "why is it here?" does', () => {
    // `explainGame()` reads `checkPlacement()`, which runs the registry's own
    // severity table over the findings. `explainLatestKickoff()` read
    // `latestLegalKickoff()` raw. Today the two agree because nothing in the
    // corpus is retyped; the moment one is, they disagree and nothing says which
    // to believe. So: a hard constraint claiming a code whose frozen severity is
    // `compromise`, and both answers must report the same thing about it.
    const harder = buildSeason2026ConstraintRegistry({
      extraConstraints: [
        constructedConstraint({
          id: 'lining-is-hard-this-season',
          type: CONSTRAINT_TYPE.HARD,
          reasonCodes: [FACILITY_REASON.LINING_MISMATCH],
          note: 'line markings, stated as hard rather than as a compromise',
        }),
      ],
    });
    // Meta-assertion: the frozen table and the registry really do disagree here,
    // or this test would pass without exercising the seam at all.
    expect(harder.idsByReasonCode[FACILITY_REASON.LINING_MISMATCH]).toEqual([
      'lining-is-hard-this-season',
    ]);
    expect(registry.idsByReasonCode[FACILITY_REASON.LINING_MISMATCH]).toBeUndefined();

    // The subject has to be a game *both* answers speak about, or the comparison
    // would be between a claim and an absence. Found by asking the boundary
    // query's own owner, never assumed: the corpus's four `Scrimmage` rows carry
    // the code at their placement and stop at `FORMAT_TIMING_UNDEFINED` before
    // the boundary search ever reaches the lining check.
    const subject = /** @type {Object} */ (
      sweep.attributions.find((attribution) => {
        if (
          !attribution.claims.some((claim) => claim.codes.includes(FACILITY_REASON.LINING_MISMATCH))
        )
          return false;
        const game = /** @type {Object} */ (
          schedule.games.find((entry) => entry.id === attribution.gameId)
        );
        const owner = latestLegalKickoff(
          graph,
          table,
          calendar,
          {
            surfaceId: game.surfaceId,
            date: game.date,
            format: game.format,
            notBeforeMinutes: game.startMinutes,
            ignoreBookingIds: [game.id],
          },
          { existingBookings: bookingsOn(context.state, game.date, game.id) }
        );
        return owner.findings.some((finding) => finding.code === FACILITY_REASON.LINING_MISMATCH);
      })
    );
    expect(subject).toBeDefined();
    expect(
      /** @type {Object} */ (
        subject.claims.find((claim) => claim.codes.includes(FACILITY_REASON.LINING_MISMATCH))
      ).severity
    ).toBe(ATTRIBUTION_SEVERITY.COMPROMISE);

    const retyped = buildAttributionContext({
      graph,
      table,
      calendar,
      registry: harder,
      schedule,
      verification,
      venueComplexes,
      roster,
    });
    const placed = explainGame(retyped, { gameId: subject.gameId });
    const later = explainLatestKickoff(retyped, { gameId: subject.gameId });

    const fromPlacement = /** @type {Object} */ (
      placed.claims.find((claim) => claim.codes.includes(FACILITY_REASON.LINING_MISMATCH))
    );
    const fromBoundary = /** @type {Object} */ (
      later.claims.find((claim) => claim.codes.includes(FACILITY_REASON.LINING_MISMATCH))
    );
    expect(fromPlacement).toBeDefined();
    expect(fromBoundary).toBeDefined();
    expect(fromPlacement.severity).toBe(ATTRIBUTION_SEVERITY.BLOCKING);
    expect(fromBoundary.severity).toBe(fromPlacement.severity);
    expect(fromBoundary.binding).toBe(fromPlacement.binding);
    expect(fromBoundary.constraintIds).toEqual(['lining-is-hard-this-season']);
  });

  it('re-severities "the earliest kickoff with a full warm-up" the same way', () => {
    // The other direction, so the seam is shown to demote as well as promote: a
    // preference claiming a code whose frozen severity is `blocking`.
    const softer = buildSeason2026ConstraintRegistry({
      extraConstraints: [
        constructedConstraint({
          id: 'exhausted-search-is-only-a-preference',
          type: CONSTRAINT_TYPE.PREFERENCE,
          reasonCodes: [TIMING_REASON.KICKOFF_SEARCH_EXHAUSTED],
          note: 'an exhausted kickoff search, stated as a preference',
        }),
      ],
    });
    const relaxed = buildAttributionContext({
      graph,
      table,
      calendar,
      registry: softer,
      schedule,
      verification,
      venueComplexes,
      roster,
    });

    /** The same question as the incident-8 one, asked with no room to answer in. */
    const query = {
      surfaceId: PITCH_2,
      date: busyDate,
      format: '11v11',
      warmupMinutes: WARMUP,
      notBeforeMinutes: floor,
      notAfterMinutes: floor + WARMUP + 5,
    };
    // Meta-assertion: the corpus really does exhaust the search here, so the
    // claim under test exists at all.
    const base = explainEarliestKickoff(context, query);
    expect(base.kickoffMinutes).toBeNull();
    const strict = /** @type {Object} */ (
      base.claims.find((claim) => claim.codes.includes(TIMING_REASON.KICKOFF_SEARCH_EXHAUSTED))
    );
    expect(strict).toBeDefined();
    expect(strict.severity).toBe(ATTRIBUTION_SEVERITY.BLOCKING);

    // Under the registry the code is `info`, and an `info` finding is not a
    // claim — the same rule the placement path has always applied. The point is
    // that the boundary answer now applies it too.
    const answer = explainEarliestKickoff(relaxed, query);
    expect(
      answer.claims.some((entry) => entry.codes.includes(TIMING_REASON.KICKOFF_SEARCH_EXHAUSTED))
    ).toBe(false);
    expect(answer.claims.every((entry) => entry.severity !== ATTRIBUTION_SEVERITY.BLOCKING)).toBe(
      true
    );

    // …and it is the *same* rule, not one invented here: demoting a code the
    // placement path reports does exactly the same thing to `explainGame()`.
    const liningIsAPreference = buildSeason2026ConstraintRegistry({
      extraConstraints: [
        constructedConstraint({
          id: 'lining-is-only-a-preference',
          type: CONSTRAINT_TYPE.PREFERENCE,
          reasonCodes: [FACILITY_REASON.LINING_MISMATCH],
          note: 'line markings, stated as a preference rather than a compromise',
        }),
      ],
    });
    const subject = /** @type {Object} */ (
      sweep.attributions.find((attribution) =>
        attribution.claims.some((claim) => claim.codes.includes(FACILITY_REASON.LINING_MISMATCH))
      )
    );
    expect(subject).toBeDefined();
    const demoted = explainGame(
      buildAttributionContext({
        graph,
        table,
        calendar,
        registry: liningIsAPreference,
        schedule,
        verification,
        venueComplexes,
        roster,
      }),
      { gameId: subject.gameId }
    );
    // The placement-derived copy is gone. The rule engine's copy of the same
    // fact is not, and must not be: that run was made against the original
    // registry and this module keeps both routes rather than deciding which of
    // two other modules to believe.
    expect(
      demoted.claims.some(
        (claim) =>
          claim.source === ATTRIBUTION_SOURCE.FACILITY &&
          claim.codes.includes(FACILITY_REASON.LINING_MISMATCH)
      )
    ).toBe(false);
    expect(
      subject.claims.some(
        (claim) =>
          claim.source === ATTRIBUTION_SOURCE.FACILITY &&
          claim.codes.includes(FACILITY_REASON.LINING_MISMATCH)
      )
    ).toBe(true);
  });
});

describe('attribution :: the counters count what the answer actually did', () => {
  it('folds the current placement’s work into the counterfactual’s own meta', () => {
    // The counters are how a caller tells "nothing applied" from "nothing was
    // checked". `explainKickoffTime()` asks `explainGame()` a whole question and
    // then runs a second placement check of its own, so an answer reporting
    // `gamesExamined: 0` after examining one game and `placementChecksRun: 1`
    // after two is under-reporting its own work — the incident-4 shape moved
    // into the reporting layer.
    const game = schedule.games[0];
    const elsewhere = /** @type {Object} */ (
      schedule.games.find(
        (entry) =>
          entry.date === game.date &&
          entry.venueId === game.venueId &&
          entry.startMinutes !== game.startMinutes
      )
    );
    expect(elsewhere).toBeDefined();

    const answer = explainKickoffTime(context, {
      gameId: game.id,
      insteadOfMinutes: elsewhere.startMinutes,
    });

    expect(answer.current.meta.gamesExamined).toBe(1);
    expect(answer.current.meta.placementChecksRun).toBe(1);
    expect(answer.meta.gamesExamined).toBe(answer.current.meta.gamesExamined);
    expect(answer.meta.placementChecksRun).toBe(answer.current.meta.placementChecksRun + 1);
    expect(answer.meta.claimsBuilt).toBeGreaterThanOrEqual(
      answer.current.meta.claimsBuilt + answer.counterfactual.claims.length
    );
    expect(answer.meta.availabilityConstraintsConsulted).toBeGreaterThanOrEqual(
      answer.current.meta.availabilityConstraintsConsulted
    );
  });

  it('reports the work it did even when it refuses to compare a slot with itself', () => {
    // The early return still ran a placement check, and saying otherwise would
    // make "nothing was checked" and "the comparison was vacuous" look alike.
    const game = schedule.games[0];
    const answer = explainKickoffTime(context, {
      gameId: game.id,
      insteadOfMinutes: game.startMinutes,
    });
    expect(answer.findings.map((finding) => finding.code)).toContain(
      ATTRIBUTION_REASON.ATTRIBUTION_ALTERNATIVE_NO_OP
    );
    expect(answer.meta.gamesExamined).toBe(1);
    expect(answer.meta.placementChecksRun).toBe(1);
  });
});

describe('attribution :: the minimal set reports one claim per member', () => {
  it('holds over every blocked placement the corpus supports, not just the built one', () => {
    // `MinimalBlockingSet.claims` is documented as "one per member, tightest
    // first", and the acceptance case has one finding per member so it cannot
    // tell the difference. A placement that breaks the *same* constraint twice —
    // two spatial overlaps, one registry record — reports two claims for one
    // member, and a reader counting claims then counts the set as bigger than it
    // is, on the one answer whose whole subject is how small it is.
    let blocked = 0;
    let multiFinding = 0;
    /** @type {string[]} */
    const wrong = [];
    for (const game of schedule.games) {
      const kickoffs = [
        ...new Set(
          schedule.games
            .filter((entry) => entry.date === game.date && entry.venueId === game.venueId)
            .map((entry) => entry.startMinutes)
        ),
      ].sort((a, b) => a - b);
      for (const minutes of kickoffs) {
        const answer = minimalBlockingSet(context, {
          gameId: game.id,
          slot: { date: game.date, surfaceId: game.surfaceId, startMinutes: minutes },
        });
        if (!answer.blocked) continue;
        blocked += 1;
        const where = `${game.id} at minute ${minutes}`;
        // Counted from the placement rather than from the answer, so "a member
        // that raised several findings exists" stays true whatever the module
        // does with them.
        const placement = checkPlacement(
          { graph, table, calendar, registry },
          context.state,
          game.id,
          { date: game.date, surfaceId: game.surfaceId, startMinutes: minutes }
        );
        const raised = placement.findings.filter(
          (finding) => finding.severity !== ATTRIBUTION_SEVERITY.INFO
        );
        const crowded = answer.constraintIds.some(
          (constraintId) =>
            raised.filter((finding) =>
              (registry.idsByReasonCode[finding.code] ?? []).includes(constraintId)
            ).length > 1
        );
        if (crowded) multiFinding += 1;

        if (answer.claims.length !== answer.constraintIds.length) {
          wrong.push(
            `${where} :: ${answer.claims.length} claims for ${answer.constraintIds.length} members`
          );
          continue;
        }
        for (const constraintId of answer.constraintIds) {
          const carrying = answer.claims.filter((claim) =>
            claim.constraintIds.includes(constraintId)
          );
          if (carrying.length !== 1) {
            wrong.push(`${where} :: ${carrying.length} claims name ${constraintId}`);
          }
        }
        // Every claim still has to be an instance rather than a category, which
        // is the guard this answer never used to run over its own claims.
        for (const claim of answer.claims) {
          if (!isSpecificClaim(claim)) wrong.push(`${where} :: ${claim.kind} names no instance`);
        }
      }
    }
    // Meta-assertions: a real population of blocked placements, and a real
    // population of the *crowded* case — a set whose members each raised exactly
    // one finding would satisfy the invariant without ever exercising it.
    expect(blocked).toBeGreaterThan(1000);
    expect(multiFinding).toBeGreaterThan(0);
    expect(wrong).toEqual([]);
    // Every blocked placement in the corpus, each with its own relaxation
    // search: slower than a sample and the only version that means anything.
  }, 70_000); // every blocked placement the corpus supports: 9.4 s alone, 11.3 / 8.1 / 16.7 / 14.0 s in four local full runs; ~4x the worst, see docs/testing/test-timeouts.md.

  it('runs the category-only guard over its claims, as every other answer does', () => {
    // The acceptance case for minimality was the one answer that counted its
    // claims without ever checking them. It cannot fire on this corpus — every
    // claim here names the registry constraint that put it in the set, so the
    // instance half of the predicate is satisfied by construction, which is the
    // same reason `ATTRIBUTION_CLAIM_CATEGORY_ONLY` is one of the two codes the
    // corpus cannot reach. So the guard is asserted two ways: it is the shared
    // one, and the shared one rejects a category label.
    const answer = minimalBlockingSet(over.stackedContext, {
      gameId: over.subject.id,
      slot: over.slot,
    });
    expect(answer.meta.claimsCategoryOnly).toBe(0);
    expect(answer.meta.claimsBuilt).toBe(answer.claims.length);

    const guarded = categoryOnlyClaimFindings(
      [makeClaim({ source: ATTRIBUTION_SOURCE.AVAILABILITY, kind: 'sunset' }), ...answer.claims],
      { gameId: over.subject.id },
      createAttributionMeta()
    );
    expect(guarded.map((finding) => finding.code)).toEqual([
      ATTRIBUTION_REASON.ATTRIBUTION_CLAIM_CATEGORY_ONLY,
    ]);

    // …and `minimal.js` is wired to that guard rather than to a private count.
    const source = readFileSync(path.join(CORE, 'attribution', 'minimal.js'), 'utf8');
    expect(source).toContain('categoryOnlyClaimFindings');
  });
});

/**
 * Which module's frozen reason-code table declares each code.
 *
 * Built here from the three enums rather than read from the module under test:
 * `source` is provenance, it says where to go and argue with a number, and a
 * claim that sends an operator to `facility/` about a permit close sends them to
 * argue with the wrong file.
 */
/** @type {Map<string, string>} */
const OWNER_OF_CODE = new Map();
for (const [owner, codes] of /** @type {Array<[string, string[]]>} */ ([
  [ATTRIBUTION_SOURCE.AVAILABILITY, Object.values(AVAILABILITY_REASON)],
  [ATTRIBUTION_SOURCE.FACILITY, Object.values(FACILITY_REASON)],
  [ATTRIBUTION_SOURCE.WARMUP, Object.values(TIMING_REASON)],
])) {
  for (const code of codes) OWNER_OF_CODE.set(code, owner);
}

/**
 * The sources whose claims are not built from one module's reason code.
 *
 * @type {Set<string>}
 */
const NOT_CODE_SOURCED = new Set([
  ATTRIBUTION_SOURCE.RULE_ENGINE,
  ATTRIBUTION_SOURCE.COACH_TRAVEL,
  ATTRIBUTION_SOURCE.ROSTER,
]);

/**
 * The claim kinds that are a bound rather than a reason code.
 *
 * @type {string[]}
 */
const BOUND_KINDS = [...Object.values(AVAILABILITY_CONSTRAINT), 'warmup-occupancy'];

describe('attribution :: a claim names the module that raised it', () => {
  it('has one owner per code, because the three tables do not overlap', () => {
    // The table the module builds is only unambiguous if the three enums it is
    // built from are disjoint. Re-derived here rather than trusted: a code
    // appearing in two of them would silently take whichever owner was assembled
    // last.
    const codes = [
      ...Object.values(AVAILABILITY_REASON),
      ...Object.values(FACILITY_REASON),
      ...Object.values(TIMING_REASON),
    ];
    expect(codes.length).toBeGreaterThan(50);
    expect(new Set(codes).size).toBe(codes.length);
    expect(Object.keys(ATTRIBUTION_SOURCE_BY_REASON_CODE).sort()).toEqual([...codes].sort());
    for (const [code, owner] of Object.entries(ATTRIBUTION_SOURCE_BY_REASON_CODE)) {
      expect(owner, code).toBe(OWNER_OF_CODE.get(code));
    }
    // …and a code from a module with no source of its own keeps the caller's.
    expect(attributionSourceOf(PEOPLE_REASON.TEAM_SOLE_COACH, ATTRIBUTION_SOURCE.ROSTER)).toBe(
      ATTRIBUTION_SOURCE.ROSTER
    );
  });

  it('sources the minimal set’s claims by their code’s owner, not by where they were built', () => {
    const answer = minimalBlockingSet(over.stackedContext, {
      gameId: over.subject.id,
      slot: over.slot,
    });
    const bySource = Object.fromEntries(answer.claims.map((claim) => [claim.kind, claim.source]));
    // The headline example of this phase: a permit close and a daylight margin
    // are `availability/`'s findings; only the overlap is `facility/`'s.
    expect(bySource[AVAILABILITY_REASON.PERMIT_CLOSE_EXCEEDED]).toBe(
      ATTRIBUTION_SOURCE.AVAILABILITY
    );
    expect(bySource[AVAILABILITY_REASON.SUNSET_MARGIN_VIOLATED]).toBe(
      ATTRIBUTION_SOURCE.AVAILABILITY
    );
    expect(bySource[FACILITY_REASON.OCCUPIED_SAME_SURFACE]).toBe(ATTRIBUTION_SOURCE.FACILITY);
  });

  it('holds for every finding-derived claim the corpus produces', () => {
    /** @type {Array<import('@squadlogic/core/attribution/types.js').ConstraintClaim>} */
    const claims = [];
    for (const attribution of sweep.attributions) claims.push(...attribution.claims);
    for (const game of schedule.games) {
      claims.push(...explainLatestKickoff(context, { gameId: game.id }).claims);
    }
    claims.push(
      ...minimalBlockingSet(over.stackedContext, { gameId: over.subject.id, slot: over.slot })
        .claims
    );

    let checked = 0;
    /** @type {Set<string>} */
    const owners = new Set();
    /** @type {string[]} */
    const wrong = [];
    for (const claim of claims) {
      if (NOT_CODE_SOURCED.has(claim.source)) continue;
      const owner = OWNER_OF_CODE.get(claim.kind);
      // A claim whose `kind` is a constraint *kind* rather than a reason code is
      // the bound itself, and the bound is `availability/`'s by definition.
      if (owner === undefined) {
        expect(BOUND_KINDS, claim.kind).toContain(claim.kind);
        continue;
      }
      checked += 1;
      owners.add(owner);
      if (claim.source !== owner) wrong.push(`${claim.kind} sourced ${claim.source}, not ${owner}`);
    }
    // Meta-assertions: a real population, spanning more than one owner.
    expect(checked).toBeGreaterThan(50);
    expect(owners.size).toBeGreaterThan(1);
    expect([...new Set(wrong)].sort()).toEqual([]);
  });
});

describe('attribution :: an unanswerable question says what was actually done', () => {
  /**
   * @param {Object} answer
   * @returns {Object}
   */
  const unanswerable = (answer) =>
    /** @type {Object} */ (
      answer.findings.find(
        (finding) => finding.code === ATTRIBUTION_REASON.ATTRIBUTION_QUESTION_UNANSWERABLE
      )
    );

  it('does not claim a range was searched when nothing was searched', () => {
    // With no warm-up length stated the timing module answers
    // `WARMUP_DURATION_UNSPECIFIED` and tests zero candidates. Saying "no
    // kickoff in the range that was searched" describes work that did not
    // happen, on the finding whose only job is to say why there is no answer.
    const query = {
      surfaceId: PITCH_2,
      date: busyDate,
      format: '11v11',
      notBeforeMinutes: floor,
    };
    const owner = earliestKickoffWithWarmup(
      graph,
      table,
      { ...query, notAfterMinutes: 1440 },
      { existingBookings: bookingsOn(context.state, busyDate, '') }
    );
    // Meta-assertions, from the owner rather than from the answer.
    expect(owner.kickoffMinutes).toBeNull();
    expect(owner.warmupMinutes).toBeNull();
    expect(owner.candidatesTested).toBe(0);
    expect(owner.findings.map((finding) => finding.code)).toContain(
      TIMING_REASON.WARMUP_DURATION_UNSPECIFIED
    );

    const finding = unanswerable(explainEarliestKickoff(context, query));
    expect(finding).toBeDefined();
    expect(finding.details.candidatesTested).toBe(0);
    expect(finding.details.warmupMinutes).toBeNull();
    expect(finding.message).not.toContain('in the range that was searched');
    expect(finding.message).toContain('no warm-up length');
  });

  it('says how many candidates were tested when some were', () => {
    // The control: the same code, the same corpus surface, a stated warm-up and
    // a ceiling too low to fit one. Here a range really was searched, and the
    // answer has to be able to tell the two apart.
    const query = {
      surfaceId: PITCH_2,
      date: busyDate,
      format: '11v11',
      warmupMinutes: WARMUP,
      notBeforeMinutes: floor,
      notAfterMinutes: floor + WARMUP + 5,
    };
    const owner = earliestKickoffWithWarmup(graph, table, query, {
      existingBookings: bookingsOn(context.state, busyDate, ''),
    });
    expect(owner.kickoffMinutes).toBeNull();
    expect(owner.candidatesTested).toBeGreaterThan(0);

    const finding = unanswerable(explainEarliestKickoff(context, query));
    expect(finding).toBeDefined();
    expect(finding.details.candidatesTested).toBe(owner.candidatesTested);
    expect(finding.details.warmupMinutes).toBe(WARMUP);
    expect(finding.message).toContain(`${owner.candidatesTested} candidate`);
    expect(finding.message).not.toContain('no warm-up length');
  });
});

/* -------------------------------------------------------------------------- */
/* Structural — the module answers questions, it does not decide them          */
/* -------------------------------------------------------------------------- */

describe('attribution :: every declared reason code is reachable', () => {
  it('fires all but the two that guard a state this corpus cannot reach', () => {
    // "Declared is not enforced" applied to this module's own vocabulary: a
    // reason code nothing can emit is a promise nothing keeps. The answers below
    // are recomputed here so the check does not depend on the order the other
    // tests ran in.
    /** @type {Set<string>} */
    const fired = new Set();
    /** @param {{ findings: ReadonlyArray<{ code: string }> }} answer */
    const record = (answer) => {
      for (const finding of answer.findings) fired.add(finding.code);
    };

    record(buildAttributionContext({ graph, table, calendar, registry, schedule }));
    record(explainSchedule({ ...context, schedule: { ...schedule, games: [] } }));
    record(explainGame(context, { gameId: 'not-a-game' }));
    record(
      explainKickoffTime(context, {
        gameId: latePublished.gameId,
        insteadOfMinutes: latePublished.startMinutes,
        insteadOfSurfaceId: latePublished.surfaceId,
        insteadOfDate: latePublished.date,
      })
    );
    record(
      explainKickoffTime(context, {
        gameId: schedule.games[0].id,
        insteadOfMinutes: schedule.games[0].startMinutes,
      })
    );
    for (const game of schedule.games) {
      const kickoffs = [
        ...new Set(
          schedule.games
            .filter((entry) => entry.date === game.date && entry.venueId === game.venueId)
            .map((entry) => entry.startMinutes)
        ),
      ];
      const legal = kickoffs
        .filter((minutes) => minutes !== game.startMinutes)
        .map((minutes) =>
          explainKickoffTime(context, { gameId: game.id, insteadOfMinutes: minutes })
        )
        .find((answer) => answer.counterfactual.legal);
      if (legal) {
        record(legal);
        break;
      }
    }
    record(
      explainEarliestKickoff(context, {
        surfaceId: PITCH_2,
        date: busyDate,
        format: '11v11',
        notBeforeMinutes: floor,
      })
    );
    record(
      explainEarliestKickoff(context, {
        surfaceId: PITCH_2,
        date: busyDate,
        format: '11v11',
        warmupMinutes: WARMUP,
        notBeforeMinutes: Math.max(
          ...schedule.games
            .filter((game) => game.date === busyDate && game.endMinutes !== null)
            .map((game) => /** @type {number} */ (game.endMinutes))
        ),
      })
    );
    record(explainTeamConflict(context, { teamId: 'U12B04' }));
    record(
      explainTeamConflict(context, {
        teamId: /** @type {string} */ (
          schedule.teamUniverse.find(
            (teamId) =>
              !(
                /** @type {Object} */ (context.travel).transitions.some(
                  (transition) =>
                    (transition.from.teamId === teamId || transition.to.teamId === teamId) &&
                    transition.findings.some((finding) => finding.severity !== 'info')
                )
              )
          )
        ),
      })
    );
    record(minimalBlockingSet(over.stackedContext, { gameId: over.subject.id, slot: over.slot }));
    record(
      minimalBlockingSet(context, {
        gameId: /** @type {Object} */ (sweep.attributions.find((attribution) => !attribution.legal))
          .gameId,
      })
    );
    record(
      minimalBlockingSet(context, {
        gameId: /** @type {Object} */ (sweep.attributions.find((attribution) => attribution.legal))
          .gameId,
      })
    );

    // Meta-assertion: this collected a real population rather than nothing.
    expect(fired.size).toBeGreaterThan(10);

    const unfired = Object.values(ATTRIBUTION_REASON)
      .filter((code) => !fired.has(code))
      .sort();
    // The three that remain are guards for states the *published* season does
    // not contain, and each is named here rather than left to be discovered:
    //
    // - `ATTRIBUTION_CLAIM_CATEGORY_ONLY` needs a finding carrying neither an
    //   identifier nor a number. Every finding the six source modules can emit
    //   carries at least one, which is why the sweep's 1,900-odd claims are all
    //   specific; the predicate behind it is exercised directly instead, with
    //   its own positive control.
    // - `ATTRIBUTION_GAME_UNATTRIBUTED` needs a game the schedule holds, the
    //   state holds, and no constraint or finding says anything about. Every
    //   venue in this corpus has a permit record, so the permit bound alone
    //   attributes all 679.
    // - `ATTRIBUTION_CONSTRAINT_UNJUDGED` needs a record whose scope this
    //   question cannot reach. The corpus registry is global- and venue-scoped
    //   only — asserted directly in the round-2 block below — and a game-shaped
    //   question can judge every one of those, so nothing here goes unjudged.
    //   Fired against a constructed `person`-scoped record instead, in
    //   `describe('explainGame :: the registry trace reaches a report')`, with
    //   this run standing as its negative control.
    expect(unfired).toEqual(
      [
        ATTRIBUTION_REASON.ATTRIBUTION_CLAIM_CATEGORY_ONLY,
        ATTRIBUTION_REASON.ATTRIBUTION_CONSTRAINT_UNJUDGED,
        ATTRIBUTION_REASON.ATTRIBUTION_GAME_UNATTRIBUTED,
      ].sort()
    );
  });
});

describe('attribution :: structural', () => {
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

  const files = filesUnder(path.join(CORE, 'attribution'));
  const sources = files.map((file) => ({
    file,
    text: readFileSync(file, 'utf8'),
    /** Prose quotes the machinery it explains, so the checks below read code only. */
    code: readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ''),
  }));

  it('scans a plausible number of files', () => {
    // The meta-assertion the rest of this block rests on.
    expect(files.length).toBeGreaterThanOrEqual(7);
    expect(sources.every((source) => source.text.length > 0)).toBe(true);
  });

  it('re-implements none of the machinery it reports', () => {
    // The named functions are the ones that decide the things this module
    // explains. Calling any of them here would be a second answer free to
    // disagree with the first.
    for (const source of sources) {
      for (const forbidden of [
        'surfacesConflict',
        'checkOccupancy',
        'checkFieldEligibility',
        'resolvePermitWindow',
        'daylightLimitMinutes',
        'sunsetOn',
        'formatTimingOrUnknown',
        'occupancyEndMinutes',
        'warmupMinutesFor',
      ]) {
        expect(source.code.includes(forbidden), `${source.file} :: ${forbidden}`).toBe(false);
      }
    }
  });

  it('sorts claims in exactly one place', () => {
    const declaring = sources.filter((source) => /function tightnessKey\b/.test(source.code));
    expect(declaring.map((source) => path.basename(source.file))).toEqual(['claims.js']);
    const merging = sources.filter((source) =>
      /function mergeClaimsByTightness\b/.test(source.code)
    );
    expect(merging.map((source) => path.basename(source.file))).toEqual(['claims.js']);
  });

  it('constructs no Date anywhere', () => {
    for (const source of sources) {
      expect(/new Date\b/.test(source.text), source.file).toBe(false);
      expect(/Date\.now\b/.test(source.text), source.file).toBe(false);
      expect(/toISOString/.test(source.text), source.file).toBe(false);
    }
  });

  it('leaves the shipping solvers and the frontend alone', () => {
    for (const source of sources) {
      expect(/from '.*autoScheduler\.js'/.test(source.code), source.file).toBe(false);
      expect(/from '.*gameMetrics\.js'/.test(source.code), source.file).toBe(false);
      expect(/from '.*gameScheduling\.js'/.test(source.code), source.file).toBe(false);
      expect(/from '.*fixtures\//.test(source.code), source.file).toBe(false);
      expect(/from 'react/.test(source.code), source.file).toBe(false);
      expect(/from 'node:/.test(source.code), source.file).toBe(false);
    }
  });

  it('registers every new export in the package barrel', () => {
    const barrel = readFileSync(path.join(CORE, 'attribution', 'index.js'), 'utf8');
    for (const name of [
      'ATTRIBUTION_REASON',
      'ATTRIBUTION_QUESTION',
      'buildAttributionContext',
      'explainGame',
      'explainSchedule',
      'explainKickoffTime',
      'explainLatestKickoff',
      'explainEarliestKickoff',
      'explainTeamConflict',
      'minimalBlockingSet',
      'isSpecificClaim',
      'mergeClaimsByTightness',
    ]) {
      expect(barrel, name).toContain(name);
    }
    // And the two lookups it borrowed are exported from the module that owns
    // them rather than copied into this one.
    const resolveBarrel = readFileSync(path.join(CORE, 'resolve', 'index.js'), 'utf8');
    expect(resolveBarrel).toContain('violationsAbout');
    expect(resolveBarrel).toContain('registryConstraintIdsFor');
  });
});

/* -------------------------------------------------------------------------- */
/* Cross-module seam: the context read a field the schema owns                 */
/* -------------------------------------------------------------------------- */

/**
 * **Finding 5 — a TypeError on the path that exists to report absence.**
 *
 * `buildAttributionContext()` took `input.schedule` on trust and read
 * `schedule.commitments` off it twice: once to build a coach-travel evaluation,
 * and once — in the `travel === null` branch — to say how many commitments the
 * evaluation it could *not* build would have judged. `ScheduleSchema` declares
 * `commitments` with `.default([])`, so a schedule literal that omits it is a
 * perfectly legal schedule; unparsed, it is `undefined`, and
 * `schedule.commitments.length` throws.
 *
 * The throw lands on the exact path whose whole job is to return
 * `ATTRIBUTION_TRAVEL_ABSENT` — "I cannot speak about coaches" — so the one
 * input that most needed that answer got a stack trace instead. Its two
 * siblings, `runRuleEngine()` and `runResolve()`, both parse the schedule
 * through `ScheduleSchema` before reading a field off it; this one did not, and
 * the corpus schedule carries every field, so nothing in the suite noticed.
 */
describe('attribution :: the context parses the schedule it is handed', () => {
  /**
   * A legal schedule literal: `ScheduleSchema` defaults every field it omits.
   *
   * One real game, because a zero-game schedule is refused earlier and for a
   * different reason — `buildSlotInventory()` refuses to build an inventory
   * nothing could ever be placed into (incident 4). That refusal is correct and
   * is not what this block is about, so the input carries a game and omits only
   * the field the schema defaults.
   */
  const sparseSchedule = () => ({
    name: 'a schedule stated as a literal',
    games: [schedule.games[0]],
  });

  it('the omission really is legal, so this is not a test about a malformed input', () => {
    // The meta-assertion. If `commitments` were required, the throw below would
    // be correct behaviour and this whole block would be arguing for a bug.
    const parsed = ScheduleSchema.parse(sparseSchedule());
    expect(parsed.commitments).toEqual([]);
    expect(parsed.teamUniverse).toEqual([]);
    expect(parsed.games).toHaveLength(1);
    // …and the raw literal genuinely lacks the field the builder reached for.
    expect(Object.hasOwn(sparseSchedule(), 'commitments')).toBe(false);
  });

  it('reports ATTRIBUTION_TRAVEL_ABSENT rather than throwing on a schedule that omits commitments', () => {
    const thin = buildAttributionContext({
      graph,
      table,
      calendar,
      registry,
      schedule: sparseSchedule(),
    });
    expect(thin.findings.map((finding) => finding.code).sort()).toEqual([
      ATTRIBUTION_REASON.ATTRIBUTION_ROSTER_ABSENT,
      ATTRIBUTION_REASON.ATTRIBUTION_TRAVEL_ABSENT,
      ATTRIBUTION_REASON.ATTRIBUTION_VERIFICATION_ABSENT,
    ]);
    const absent = thin.findings.find(
      (finding) => finding.code === ATTRIBUTION_REASON.ATTRIBUTION_TRAVEL_ABSENT
    );
    // The count the message carries is the parsed value, not `undefined`.
    expect(absent?.details.commitmentCount).toBe(0);
    expect(thin.status).toBe(ATTRIBUTION_STATUS.COMPROMISED);
    // The context carries the parsed schedule, so every later reader of a
    // defaulted field — `explain.js` reads `schedule.teamUniverse` — gets the
    // schema's answer rather than `undefined`.
    expect(thin.schedule.commitments).toEqual([]);
    expect(thin.schedule.teamUniverse).toEqual([]);
  });

  it('builds the travel evaluation from the same parsed schedule when complexes are supplied', () => {
    // The other half of the same defect: with `venueComplexes` stated, the
    // builder reached `evaluateCoachTravel(schedule.commitments, …)` instead,
    // and handed it `undefined`.
    const withComplexes = buildAttributionContext({
      graph,
      table,
      calendar,
      registry,
      schedule: sparseSchedule(),
      venueComplexes,
    });
    expect(withComplexes.travel).not.toBeNull();
    expect(withComplexes.findings.map((finding) => finding.code).sort()).toEqual([
      ATTRIBUTION_REASON.ATTRIBUTION_ROSTER_ABSENT,
      ATTRIBUTION_REASON.ATTRIBUTION_VERIFICATION_ABSENT,
    ]);
  });

  it('refuses a schedule the schema refuses, rather than half-reading it', () => {
    // The negative control for the parse: it is a parse, not a defaulting
    // helper, so an input `ScheduleSchema` rejects is rejected here too.
    expect(() =>
      buildAttributionContext({
        graph,
        table,
        calendar,
        registry,
        schedule: { ...sparseSchedule(), notAField: true },
      })
    ).toThrow();
  });
});

/* -------------------------------------------------------------------------- */
/* Round 2, findings 3 and 4                                                   */
/* -------------------------------------------------------------------------- */

describe('attribution :: a boundary question about ground we do not hold is answered', () => {
  /**
   * Finding 3, and it was masked by finding 2. `underRegistry()` wrote a
   * hardcoded `venueId: null` into a `.strict()` `ScopeContextSchema` whose
   * `venueId` is non-nullable, so the moment the timing module stopped throwing
   * on an unknown surface the severity lookup threw a `ZodError` instead — the
   * crash relocated rather than went away. `feasibility/verdict.js` writes
   * `?? undefined` at the identical helper and documents exactly this case.
   */
  const GHOST = `${PITCH_2}-not-in-the-graph`;

  it('is asked about ground the graph really does not hold', () => {
    // The meta-assertion: an id already in the graph would make the block below
    // a test of the ordinary path.
    expect(graph.surfaceIds).toContain(PITCH_2);
    expect(graph.surfaceIds).not.toContain(GHOST);
  });

  it('names the unknown surface as the binding claim instead of throwing', () => {
    const answer = explainEarliestKickoff(context, {
      surfaceId: GHOST,
      date: busyDate,
      format: '11v11',
      warmupMinutes: WARMUP,
      notBeforeMinutes: floor,
    });
    expect(answer.kickoffMinutes).toBeNull();
    expect(answer.status).toBe(ATTRIBUTION_STATUS.COMPROMISED);
    // The question is unanswerable, and the answer says *why* rather than only
    // that: the binding claim is the facility module's own code.
    expect(answer.findings.map((finding) => finding.code)).toContain(
      ATTRIBUTION_REASON.ATTRIBUTION_QUESTION_UNANSWERABLE
    );
    const binding = /** @type {Object} */ (answer.binding);
    expect(binding).not.toBeNull();
    expect(binding.code).toBe(FACILITY_REASON.SURFACE_UNKNOWN);
    expect(answer.claims.map((claim) => claim.code)).toContain(FACILITY_REASON.SURFACE_UNKNOWN);
  });

  it('still answers the real question about the real pitch', () => {
    // The negative control: a helper that reported SURFACE_UNKNOWN for every
    // surface would pass everything above.
    const answer = explainEarliestKickoff(context, {
      surfaceId: PITCH_2,
      date: busyDate,
      format: '11v11',
      warmupMinutes: WARMUP,
      notBeforeMinutes: floor,
    });
    expect(answer.status).toBe(ATTRIBUTION_STATUS.ALLOWED);
    expect(answer.claims.map((claim) => claim.code)).not.toContain(FACILITY_REASON.SURFACE_UNKNOWN);
  });
});

describe('checkPlacement :: the sides are a scope it holds, and the seam has a voice', () => {
  /**
   * Finding 4, in two halves.
   *
   * `checkPlacement()` holds the game and did not pass its `teamIds` to the
   * severity lookup, so every `team`-scoped record came back
   * `CONSTRAINT_SCOPE_UNJUDGED` and was **not applied** — while the rule engine
   * narrows per subject with exactly that field, so one registry gave two
   * verdicts about one game. And the lookup's own report, which is where
   * `CONSTRAINT_SCOPE_UNJUDGED` was written down, was discarded, so nothing
   * anywhere said the constraint had gone unjudged.
   */

  /** A legal placement whose game names both of its sides. */
  const subject = (() => {
    for (const gameId of context.state.gameIds) {
      const game = context.state.baseline[gameId];
      if (!game || !game.homeTeamId || !game.awayTeamId) continue;
      const slot = { date: game.date, surfaceId: game.surfaceId, startMinutes: game.startMinutes };
      const placement = checkPlacement(context.engines, context.state, gameId, slot);
      if (!placement.legal) continue;
      const code = placement.findings.map((finding) => finding.code)[0];
      if (!code) continue;
      return { gameId, game, slot, placement, code };
    }
    return null;
  })();

  /**
   * The same registry with one extra record: a `hard` constraint claiming the
   * code that placement already carries, scoped to **this game's home team**.
   * Built from the registry's own records rather than from a list typed here,
   * so it is the season's registry plus one thing.
   *
   * @param {string} scopeKind
   * @param {Object} scope
   * @returns {Object}
   */
  const withScopedConstraint = (scopeKind, scope) =>
    buildConstraintRegistry({
      name: registry.name,
      source: registry.source,
      constraints: [
        ...registry.constraints,
        {
          id: `round-2.${scopeKind}.scoped`,
          policy: 'round-2-probe',
          name: `a ${scopeKind}-scoped rule about ${/** @type {Object} */ (subject).code}`,
          type: CONSTRAINT_TYPE.HARD,
          scope: { kind: scopeKind, ...scope },
          rationale:
            'constructed: the corpus registry is global- and venue-scoped only, so a narrower scope has to be stated to be tested at all',
          source: {
            setBy: 'tests/attribution.test.js',
            setAt: null,
            note: 'constructed for this test; never a clock read',
            reference: 'round 2, finding 4',
          },
          enforcement: CONSTRAINT_ENFORCEMENT.REASON_CODES,
          reasonCodes: [/** @type {Object} */ (subject).code],
        },
      ],
    });

  it('has a legal placement with both sides named to be wrong about', () => {
    // The meta-assertion. Without a game that names its teams there is no
    // `teamIds` to pass and the whole block would be about nothing; without a
    // finding to retype there would be no verdict to move.
    expect(subject).not.toBeNull();
    const found = /** @type {Object} */ (subject);
    expect(found.placement.legal).toBe(true);
    expect(found.game.homeTeamId).toEqual(expect.any(String));
    expect(found.code).toEqual(expect.any(String));
    // …and the corpus registry itself scopes nothing to a team, which is why
    // this defect could survive a full season run unnoticed.
    expect(registry.constraintIds.map((id) => registry.byId[id].scope.kind).includes('team')).toBe(
      false
    );
  });

  it('applies a team-scoped constraint, because it holds the game that names the team', () => {
    const found = /** @type {Object} */ (subject);
    const scoped = withScopedConstraint(CONSTRAINT_SCOPE_KIND.TEAM, {
      teamId: found.game.homeTeamId,
    });
    const after = checkPlacement(
      { ...context.engines, registry: scoped },
      context.state,
      found.gameId,
      found.slot
    );
    expect(after.legal).toBe(false);
    expect(after.blockingCodes).toContain(found.code);
    // The registry decided this, not the facility model: the same code is still
    // `blocking` only because a record says so here.
    expect(after.findings.find((finding) => finding.code === found.code).severity).toBe(
      CONSTRAINT_SEVERITY.BLOCKING
    );
    // And the seam had nothing to complain about, because it could judge.
    expect(after.registryFindings.map((finding) => finding.code)).not.toContain(
      CONSTRAINT_REASON.CONSTRAINT_SCOPE_UNJUDGED
    );
  });

  it('leaves a team-scoped constraint about another team alone', () => {
    // The positive control for the assertion above: an implementation that
    // simply hardened every record it was handed would pass it.
    const found = /** @type {Object} */ (subject);
    const scoped = withScopedConstraint(CONSTRAINT_SCOPE_KIND.TEAM, {
      teamId: `${found.game.homeTeamId}-somebody-else`,
    });
    const after = checkPlacement(
      { ...context.engines, registry: scoped },
      context.state,
      found.gameId,
      found.slot
    );
    expect(after.legal).toBe(true);
    expect(after.blockingCodes).not.toContain(found.code);
  });

  it('says out loud when a scope it cannot reach leaves a constraint unjudged', () => {
    // The half that was dropped. `checkPlacement()` holds no people, so a
    // `person`-scoped record is genuinely undecidable here — and that is a fact
    // an operator needs, because the record is then *not applied* while the
    // placement reads legal.
    const found = /** @type {Object} */ (subject);
    const scoped = withScopedConstraint(CONSTRAINT_SCOPE_KIND.PERSON, { personId: 'p-000' });
    const after = checkPlacement(
      { ...context.engines, registry: scoped },
      context.state,
      found.gameId,
      found.slot
    );
    const codes = after.registryFindings.map((finding) => finding.code);
    expect(codes).toContain(CONSTRAINT_REASON.CONSTRAINT_SCOPE_UNJUDGED);
    expect(
      after.registryFindings.some(
        (finding) => finding.details.constraintId === 'round-2.person.scoped'
      )
    ).toBe(true);
    // The verdict itself is untouched: this is provenance about how the
    // registry was read, not a fact about the ground, and merging it into
    // `findings` would move `status` for every candidate slot in the solver.
    expect(after.legal).toBe(true);
    expect(after.findings.map((finding) => finding.code)).not.toContain(
      CONSTRAINT_REASON.CONSTRAINT_SCOPE_UNJUDGED
    );
  });

  it('reports nothing about the registry when there is nothing to report', () => {
    // The negative control for the field itself: a `registryFindings` that were
    // never empty would carry no information.
    const found = /** @type {Object} */ (subject);
    expect(found.placement.registryFindings).toEqual([]);
    // `registryStatus` stood beside it for one round and was read by nothing —
    // it is `deriveConstraintStatus(registryFindings)` and carried no fact the
    // findings did not. Round 3 deleted it rather than leave a second inert
    // field behind while fixing the first; the status is still derivable, and
    // the assertion above is the one that was ever doing any work.
    expect('registryStatus' in found.placement).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Round 3, finding 5 - the round-2 fix was produced and read by nobody         */
/* -------------------------------------------------------------------------- */

describe('explainGame :: the registry trace reaches a report, or it is not a fix', () => {
  /**
   * Round 2 gave `checkPlacement()` a `registryFindings` / `registryStatus`
   * pair so the seam's own report would stop being discarded, and then no
   * production caller read either one. All four consumers take `legal`,
   * `findings`, `blockingCodes` and `availability` and nothing else, so the
   * unjudged-scope trace the fix existed for still reached no report. A field
   * nobody reads is not a middle path between merging and dropping; it is the
   * appearance of one.
   *
   * The reasoning that produced it was sound as far as it went — merging the
   * trace into `findings` would move `status` for every candidate slot in
   * `resolve/stages.js`, which is the solver's hot path and cannot afford a
   * remark. The error was concluding that therefore *nothing* should read it.
   *
   * So it is surfaced at the consumer that can afford it. `explainGame()` and
   * `explainKickoffTime()` are asked one question at a time, already carry a
   * `findings` array and a `status` derived from it, and — unlike the boundary
   * helpers — hold the *game*, which is what makes an unjudged team scope a
   * fact worth reporting rather than a truism. `resolve/stages.js` is untouched.
   */

  /** A game whose sides are both named, so a team scope is judgeable. */
  const sided = (() => {
    for (const gameId of context.state.gameIds) {
      const game = context.state.baseline[gameId];
      if (!game || !game.homeTeamId || !game.awayTeamId) continue;
      return { gameId, game };
    }
    return null;
  })();

  /**
   * The season registry plus one record whose scope this question cannot reach.
   *
   * `person` is the honest choice: `explainGame()` holds a game, so it can and
   * now does judge a team scope, and a scope it genuinely cannot reach is the
   * one whose report an operator actually needs — the record is **not applied**
   * while the answer reads clean.
   *
   * @returns {Object}
   */
  const withPersonScopedConstraint = () =>
    buildConstraintRegistry({
      name: registry.name,
      source: registry.source,
      constraints: [
        ...registry.constraints,
        {
          id: 'round-3.person.scoped',
          policy: 'round-3-probe',
          name: 'a person-scoped rule this question cannot judge',
          type: CONSTRAINT_TYPE.HARD,
          scope: { kind: CONSTRAINT_SCOPE_KIND.PERSON, personId: 'p-000' },
          rationale:
            'constructed: the corpus registry names no person scope, so the scope an answer cannot reach has to be stated to be tested at all',
          source: {
            setBy: 'tests/attribution.test.js',
            setAt: null,
            note: 'constructed for this test; never a clock read',
            reference: 'round 3, finding 5',
          },
          enforcement: CONSTRAINT_ENFORCEMENT.REASON_CODES,
          reasonCodes: [FACILITY_REASON.LINING_MISMATCH],
        },
      ],
    });

  it('has a game with both sides named to ask about', () => {
    expect(sided).not.toBeNull();
    expect(/** @type {Object} */ (sided).game.homeTeamId).toEqual(expect.any(String));
  });

  it('says, in its own findings, that a record went unjudged and was not applied', () => {
    // The falsification. Pre-fix `checkPlacement()` produced the trace and
    // `explainGame()` never looked, so this answer's findings and status were
    // identical with and without the unreachable record.
    const found = /** @type {Object} */ (sided);
    const scoped = withPersonScopedConstraint();
    const answer = explainGame(
      { ...context, engines: { ...context.engines, registry: scoped } },
      { gameId: found.gameId }
    );
    const raised = answer.findings.filter(
      (finding) => finding.code === ATTRIBUTION_REASON.ATTRIBUTION_CONSTRAINT_UNJUDGED
    );
    expect(raised.length).toBeGreaterThan(0);
    expect(raised[0].severity).toBe(ATTRIBUTION_SEVERITY.COMPROMISE);
    // It names the record and the scope kind it could not reach, so the reader
    // can act without parsing a message.
    expect(raised.some((finding) => finding.details.constraintId === 'round-3.person.scoped')).toBe(
      true
    );
    expect(raised[0].details.gameId).toBe(found.gameId);
    // …and it reaches the answer's own status, which is the difference between
    // this and a field nobody reads.
    expect(answer.status).not.toBe(ATTRIBUTION_STATUS.ALLOWED);
    expect(answer.meta.registryRecordsUnjudged).toBe(raised.length);
  });

  it('says nothing of the sort when every record could be judged', () => {
    // The negative control. The corpus registry is global- and venue-scoped
    // only, so there is nothing here the lookup cannot decide — and an
    // implementation that reported unjudged scopes unconditionally would pass
    // the assertion above and fail this one.
    const found = /** @type {Object} */ (sided);
    const answer = explainGame(context, { gameId: found.gameId });
    expect(answer.findings.map((finding) => finding.code)).not.toContain(
      ATTRIBUTION_REASON.ATTRIBUTION_CONSTRAINT_UNJUDGED
    );
    expect(answer.meta.registryRecordsUnjudged).toBe(0);
  });

  it('carries the same trace through the counterfactual, which also holds the game', () => {
    const found = /** @type {Object} */ (sided);
    const scoped = withPersonScopedConstraint();
    const answer = explainKickoffTime(
      { ...context, engines: { ...context.engines, registry: scoped } },
      { gameId: found.gameId, insteadOfMinutes: found.game.startMinutes + 30 }
    );
    expect(answer.findings.map((finding) => finding.code)).toContain(
      ATTRIBUTION_REASON.ATTRIBUTION_CONSTRAINT_UNJUDGED
    );
    expect(answer.meta.registryRecordsUnjudged).toBeGreaterThan(0);
  });

  it('leaves the solver hot path alone, which is why it is surfaced here', () => {
    // The bound on the fix, asserted rather than promised. `checkPlacement()`'s
    // own verdict is unchanged by a record it could not judge: merging the
    // trace into `findings` would move `status` for every candidate slot the
    // re-solver scores, and that reasoning was and remains sound.
    const found = /** @type {Object} */ (sided);
    const scoped = withPersonScopedConstraint();
    const slot = {
      date: found.game.date,
      surfaceId: found.game.surfaceId,
      startMinutes: found.game.startMinutes,
    };
    const before = checkPlacement(context.engines, context.state, found.gameId, slot);
    const after = checkPlacement(
      { ...context.engines, registry: scoped },
      context.state,
      found.gameId,
      slot
    );
    expect(after.legal).toBe(before.legal);
    expect(after.status).toBe(before.status);
    expect(after.findings.map((finding) => finding.code)).not.toContain(
      CONSTRAINT_REASON.CONSTRAINT_SCOPE_UNJUDGED
    );
    // …and the field it produces is the one the report above was built from.
    expect(after.registryFindings.map((finding) => finding.code)).toContain(
      CONSTRAINT_REASON.CONSTRAINT_SCOPE_UNJUDGED
    );
  });
});
