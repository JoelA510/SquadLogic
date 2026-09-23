/**
 * **Scenario branching — Prompt 6.1.**
 *
 * > *"The source project needed parallel schedules for 'with/without venue A',
 * > 'with/without venue B', and 'with/without equipment at one site on one
 * > date'. Each was a hand-built duplicate of the entire pipeline, separately
 * > verified, and impossible to keep in sync."*
 *
 * The acceptance test the build plan names is `describe('the acceptance test')`:
 * *"build 'no venue X' from the fixture baseline, diff it, and confirm the
 * report identifies the affected format, the replacement venues, and the added
 * compromises (e.g. games on undersized or wrongly-lined pitches)."*
 *
 * It is worth nothing without `describe('the negative control')`, which runs the
 * **same branch with the relocation proposer switched off** and asserts that
 * every displaced game is TIME TBD naming `PERMIT_BLACKOUT` and that **no
 * replacement venue is named anywhere**. "We found replacements" only means
 * something if the alternative finds none.
 *
 * ## Every number here is derived from the corpus at test time
 *
 * No venue name, no field name, no clock time and no game id is typed in as an
 * expectation. The withdrawn venue is chosen **by a stated property** — the only
 * venue whose whole use is one format and which has more than one grade of
 * replacement available — and the test asserts that property rather than
 * asserting the name.
 *
 * ## The three named falsifications
 *
 * `describe('the three falsifications')` is not decoration. Three "a check that
 * cannot fail" defects have already been caught in fresh code in this project,
 * so each meta-assertion here has its failing case constructed and proven:
 * sharing (a record-copying materialiser fails the same assertion), the diff
 * partition (a dropped row and a double-counted row are each caught), and
 * vacuity (an override for ground the schedule never uses).
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi } from 'vitest';

import {
  buildAvailabilityCalendar,
  resolvePermitWindow,
  weekdayCodeOf,
} from '@squadlogic/core/availability/index.js';
import { toAvailabilityCalendarInput } from '@squadlogic/core/availability/adapters/season2026Permits.js';
import {
  CONSTRAINT_SEVERITY,
  CONSTRAINT_TYPE,
  SEASON_2026_CONSTRAINTS,
  buildSeason2026ConstraintRegistry,
} from '@squadlogic/core/constraints/index.js';
import {
  DEFAULT_SIZE_RANK,
  buildFacilityGraphFromSeason2026,
  buildSeason2026VenueComplexMap,
  checkLining,
  checkSizeEligibility,
  toSeason2026FacilityGraphInput,
} from '@squadlogic/core/facility/index.js';
import { FACILITY_STATUS } from '@squadlogic/core/facility/reasonCodes.js';
import {
  loadFacilityGeometry,
  loadFacilityPermits,
  loadGameFormats,
  loadSeason2026,
  loadSunsets,
} from '@squadlogic/core/fixtures/index.js';
import { PUBLICATION_TBD, RESERVE_REASON } from '@squadlogic/core/reserve/index.js';
import {
  candidateSlotsFor,
  createPlacementProbe,
  RESOLVE_OBJECTIVE_WEIGHTS,
} from '@squadlogic/core/resolve/index.js';
import { runRuleEngine } from '@squadlogic/core/ruleEngine/index.js';
import { toSeason2026Schedule } from '@squadlogic/core/ruleEngine/adapters/season2026Schedule.js';
import {
  buildFormatTimingTableFromSeason2026,
  toFormatTimingInput,
} from '@squadlogic/core/timing/index.js';
import { verifySnapshotDigest } from '@squadlogic/core/publication/index.js';
import { WAIVER_REASON, buildWaiverLedger } from '@squadlogic/core/waivers/index.js';
import {
  RELOCATION_RANKING,
  REPLACEMENT_GRADE,
  SCENARIO_DIGEST_EXCLUSIONS,
  SCENARIO_OVERRIDE_KIND,
  SCENARIO_REASON,
  SCENARIO_RECORD_SET,
  SCENARIO_RECORD_SET_ORDER,
  SCENARIO_STATUS,
  ScenarioMemo,
  diffAgainstBaselineScenario,
  diffCapacity,
  diffScenarios,
  diffSchedules,
  expandVenueUnavailable,
  makeScenario,
  makeSeasonInputs,
  materialiseScenario,
  promoteScenario,
  proposeRelocations,
  recordDigest,
  recordsOf,
  replacementSurfacesFor,
  runScenario,
  scenarioFingerprint,
  scheduleDiffPartitionFindings,
  seasonInputsDigest,
  season2026CapacitySubjects,
  shelveUnrelocatable,
  season2026EarliestKickoffFor,
  season2026RelocationPolicy,
  season2026SeasonInputs,
  season2026VenueUnavailableScenario,
} from '@squadlogic/core/scenario/index.js';

/* -------------------------------------------------------------------------- */
/* Corpus, engines and the baseline bundle, assembled once                     */
/* -------------------------------------------------------------------------- */

const season = loadSeason2026();
const geometry = loadFacilityGeometry();
const facilityInput = toSeason2026FacilityGraphInput(geometry);
const graph = buildFacilityGraphFromSeason2026(geometry);
const rawFormats = loadGameFormats();
const timingInput = toFormatTimingInput(rawFormats);
const table = buildFormatTimingTableFromSeason2026(rawFormats);
const sunsets = loadSunsets();
/** Derived from the corpus rather than typed in, so a re-dated fixture moves it. */
const SEASON_YEAR = Number(sunsets[0].date.slice(0, 4));
const calendarInput = toAvailabilityCalendarInput(
  loadFacilityPermits({ seasonYear: SEASON_YEAR }),
  sunsets
);
const calendar = buildAvailabilityCalendar(calendarInput);
const registry = buildSeason2026ConstraintRegistry();
const venueComplexes = buildSeason2026VenueComplexMap();
const schedule = toSeason2026Schedule(season);
const resources = { graph, timingTable: table, calendar, venueComplexes };
const baselineEngines = { graph, table, calendar, registry, resources };
const baselineVerification = runRuleEngine(schedule, { registry, resources });

/** The baseline bundle every branch below is built over. */
const inputs = season2026SeasonInputs({
  schedule,
  facilityInput,
  timingInput,
  calendarInput,
  constraints: SEASON_2026_CONSTRAINTS,
  venueComplexes,
});

/** Who each branch below says it was asked for by. Never a clock read. */
const REQUESTED_BY = 'ops@club.example';
const REQUESTED_AT = '2026-08-01T09:00:00';

/* -------------------------------------------------------------------------- */
/* Choosing the venue by a stated property, not by name                        */
/* -------------------------------------------------------------------------- */

/**
 * What each venue in the corpus carries, derived from the schedule.
 *
 * @returns {Array<{ venueId: string, games: number, formats: string[], dates: string[] }>}
 */
function venueProfiles() {
  /** @type {Map<string, { venueId: string, games: number, formats: Set<string>, dates: Set<string> }>} */
  const byVenue = new Map();
  for (const game of schedule.games) {
    const entry = byVenue.get(game.venueId) ?? {
      venueId: game.venueId,
      games: 0,
      formats: new Set(),
      dates: new Set(),
    };
    entry.games += 1;
    if (game.format) entry.formats.add(game.format);
    entry.dates.add(game.date);
    byVenue.set(game.venueId, entry);
  }
  return [...byVenue.values()]
    .map((entry) => ({
      venueId: entry.venueId,
      games: entry.games,
      formats: [...entry.formats].sort(),
      dates: [...entry.dates].sort(),
    }))
    .sort((a, b) => b.games - a.games || a.venueId.localeCompare(b.venueId));
}

/**
 * The venue whose withdrawal produces the report the acceptance test describes.
 *
 * Chosen by three stated properties, all read from the corpus:
 *
 * 1. it hosts exactly **one** format, so "the affected format" is unambiguous;
 * 2. the format has replacement ground elsewhere, so there is something to name;
 * 3. that ground carries **more than one grade** of replacement, so there are
 *    *added compromises* rather than a clean swap.
 *
 * Two venues satisfy all three on this corpus, and the largest is taken — the
 * withdrawal that displaces the most games is the one an operator actually asks
 * about. The test asserts the property and the ordering rather than the name.
 */
const CANDIDATE_WITHDRAWALS = venueProfiles().filter((profile) => {
  if (profile.formats.length !== 1) return false;
  const surfaces = replacementSurfacesFor(graph, {
    format: profile.formats[0],
    excludeVenueIds: [profile.venueId],
    maxGradesAbove: 1,
  });
  if (surfaces.length === 0) return false;
  const grades = new Set(
    surfaces.map((surfaceId) =>
      checkLining(graph, { surfaceId, format: profile.formats[0] }).status ===
      FACILITY_STATUS.ALLOWED
        ? REPLACEMENT_GRADE.CLEAN
        : REPLACEMENT_GRADE.COMPROMISED
    )
  );
  return grades.size > 1;
});

const WITHDRAWN = CANDIDATE_WITHDRAWALS[0];
const AFFECTED_FORMAT = WITHDRAWN.formats[0];

const scenario = season2026VenueUnavailableScenario({
  venueId: WITHDRAWN.venueId,
  baselineId: inputs.id,
  requestedBy: REQUESTED_BY,
  at: REQUESTED_AT,
});

const policy = season2026RelocationPolicy({
  graph,
  table,
  format: AFFECTED_FORMAT,
  excludeVenueIds: [WITHDRAWN.venueId],
  games: schedule.games,
});

const requirement = {
  slots: Math.max(
    ...WITHDRAWN.dates.map(
      (date) =>
        schedule.games.filter((g) => g.venueId === WITHDRAWN.venueId && g.date === date).length
    )
  ),
  label: `the games ${WITHDRAWN.venueId} held on its busiest date`,
  source: 'derived from fixtures/season-2026/combined_schedule.csv',
};

const runOptions = {
  baselineEngines,
  baselineVerification,
  relocationPolicy: policy,
  requirement,
};

/** The branch, searched. */
const result = runScenario(inputs, scenario, runOptions);
/** `resolve/`'s judgement under the branch's engines, which the proposer takes (#53). */
const branchProbe = () => createPlacementProbe({ schedule, engines: result.materialised.engines });

/** The same branch, with the search switched off. */
const control = runScenario(inputs, scenario, { ...runOptions, relocations: false });

const capacitySubjects = season2026CapacitySubjects({
  graph,
  table,
  format: AFFECTED_FORMAT,
  dates: WITHDRAWN.dates,
  // Both sides of the delta count the *same* ground: the replacement surfaces
  // plus the ones being withdrawn. Counting only the survivors would report a
  // capacity gain, because the withdrawn ground would never have been in the
  // baseline number either.
  surfaceIds: [
    ...policy.surfaceIds,
    ...new Set(
      schedule.games.filter((g) => g.venueId === WITHDRAWN.venueId).map((g) => g.surfaceId)
    ),
  ],
  requirement,
  games: schedule.games,
});

const diff = diffAgainstBaselineScenario(result, {
  baselineEngines,
  baselineVerification,
  capacitySubjects,
});

const controlDiff = diffAgainstBaselineScenario(control, {
  baselineEngines,
  baselineVerification,
  capacitySubjects,
});

/** The baseline rows by id, for the footprints and labels a proposal travels with. */
const gamesById = Object.fromEntries(schedule.games.map((game) => [String(game.id), game]));

/** Every code a list of findings carries. */
const codesOf = (findings) => findings.map((finding) => finding.code);

/**
 * A hard constraint carrying no type-change history of its own, so "the history
 * grew by exactly two" is a statement about the branch under test rather than
 * about the corpus's own recorded decisions.
 *
 * **A function of a constraint list rather than a value**, so the identical
 * selection can be run over a corpus that holds no such record. That is what
 * makes `expect(…).toBeDefined()` on its result a check that can fail: while
 * the value was computed and then dereferenced in a `describe` body, a corpus
 * without one failed at *collection* with a `TypeError` and the meta-assertion
 * inside the test could never run.
 *
 * @param {ReadonlyArray<Object>} constraints
 * @returns {Object|undefined}
 */
const untouchedHardConstraint = (constraints) =>
  constraints.find(
    (record) =>
      record.type === CONSTRAINT_TYPE.HARD &&
      record.enforcement === 'reason-codes' &&
      record.history.length === 0
  );

/** A venue the schedule never stands on, so a permit edit for it changes nothing. */
const unusedVenueId = () => {
  const used = new Set(schedule.games.map((game) => game.venueId));
  const unused = Object.values(graph.venues)
    .map((venue) => venue.id)
    .filter((venueId) => !used.has(venueId));
  return unused[0] ?? 'a-venue-this-corpus-does-not-have';
};

/* -------------------------------------------------------------------------- */

// **These tests derive whole seasons, so five seconds is the wrong budget.**
// Vitest's 5 s default suits a unit test; the memo cases here run two cold
// derivations over the 679-game corpus back to back, and the slowest sits near
// 3 s on a developer machine. CI runs roughly 1.4x slower, which took one of
// them past the default and turned a passing suite red on the runner alone.
// Raising the ceiling for this file keeps a real hang loud — a wedged
// derivation still fails, thirty seconds later — without failing tests that are
// merely doing the work they are supposed to do. Scoped to this file
// deliberately: the rest of the suite should stay on the strict default.
vi.setConfig({ testTimeout: 30_000 });

describe('the corpus supports the question being asked', () => {
  it('finds the venue whose withdrawal produces the acceptance test report', () => {
    // The meta-assertion the whole file rests on. A filter that matched nothing
    // would make every assertion below vacuous, and the ordering is asserted so
    // that the subject is the largest such withdrawal rather than whichever
    // happened to sort first.
    const profiles = venueProfiles();
    expect(profiles.length).toBeGreaterThan(4);
    expect(CANDIDATE_WITHDRAWALS.length).toBeGreaterThanOrEqual(1);
    expect(CANDIDATE_WITHDRAWALS.length).toBeLessThan(profiles.length);
    expect(WITHDRAWN.games).toBe(Math.max(...CANDIDATE_WITHDRAWALS.map((p) => p.games)));
    expect(WITHDRAWN.games).toBeGreaterThan(50);
    expect(WITHDRAWN.dates.length).toBeGreaterThan(5);
    // Every venue the filter rejected is rejected for a stated reason, and at
    // least one is rejected by each of the three.
    const rejected = profiles.filter(
      (profile) => !CANDIDATE_WITHDRAWALS.some((c) => c.venueId === profile.venueId)
    );
    expect(rejected.some((profile) => profile.formats.length > 1)).toBe(true);
    expect(
      rejected.some((profile) => {
        if (profile.formats.length !== 1) return false;
        const surfaces = replacementSurfacesFor(graph, {
          format: profile.formats[0],
          excludeVenueIds: [profile.venueId],
          maxGradesAbove: 1,
        });
        const grades = new Set(
          surfaces.map(
            (surfaceId) =>
              checkLining(graph, { surfaceId, format: profile.formats[0] }).status ===
              FACILITY_STATUS.ALLOWED
          )
        );
        // Rejected because every replacement is the same grade: there would be
        // no *added compromise* to report, which is a third of the answer.
        return surfaces.length > 0 && grades.size === 1;
      })
    ).toBe(true);
  });

  it('anchors the candidate grid where the season actually starts this format', () => {
    // Not the club's blanket 08:00: the two differ here, and a grid laid at a
    // cadence of the format's own block from the wrong anchor falls **between**
    // every published kickoff, so no relocated game could ever keep its time.
    const anchor = season2026EarliestKickoffFor(schedule.games, AFFECTED_FORMAT);
    const published = [
      ...new Set(
        schedule.games.filter((g) => g.format === AFFECTED_FORMAT).map((g) => g.startMinutes)
      ),
    ].sort((a, b) => a - b);
    expect(published.length).toBeGreaterThan(3);
    expect(anchor).toBe(published[0]);
    expect(policy.earliestKickoffMinutes).toBe(anchor);
    // …and the cadence is the format's own block, read from the timing table.
    expect(policy.cadenceMinutes).toBe(table.formats[AFFECTED_FORMAT].blockMinutes);
    // Every published kickoff of this format lands on the grid the policy lays.
    for (const kickoff of published) {
      expect((kickoff - anchor) % policy.cadenceMinutes, String(kickoff)).toBe(0);
    }
  });
});

describe('the acceptance test :: build "no venue X", diff it, read the report', () => {
  it('identifies the affected format, and only that one', () => {
    expect(result.displaced.length).toBe(WITHDRAWN.games);
    const formats = [...new Set(result.displaced.map((game) => game.format))];
    expect(formats).toEqual([AFFECTED_FORMAT]);
    // Enumerated from the schedule rather than from the run, so a run that
    // under-counted is caught rather than believed.
    const standing = schedule.games
      .filter((game) => game.venueId === WITHDRAWN.venueId)
      .map((game) => String(game.id))
      .sort();
    expect(result.displaced.map((game) => game.gameId).sort()).toEqual(standing);
    const displacedFinding = result.findings.find(
      (finding) => finding.code === SCENARIO_REASON.SCENARIO_GAME_DISPLACED
    );
    expect(displacedFinding?.details.formats).toEqual([AFFECTED_FORMAT]);
    expect(displacedFinding?.details.venueIds).toEqual([WITHDRAWN.venueId]);
  });

  it('names the replacement venues, with a grade for each', () => {
    expect(result.relocations.proposals.length).toBeGreaterThan(0);
    const venues = [...new Set(result.relocations.proposals.map((p) => p.toVenueId))].sort();
    // Every replacement is somewhere else, is size-eligible for the format, and
    // is one of the surfaces the policy stated.
    expect(venues).not.toContain(WITHDRAWN.venueId);
    for (const proposal of result.relocations.proposals) {
      expect(policy.surfaceIds, proposal.gameId).toContain(proposal.to.surfaceId);
      expect(
        checkSizeEligibility(graph, { surfaceId: proposal.to.surfaceId, format: AFFECTED_FORMAT })
          .status,
        proposal.to.surfaceId
      ).not.toBe(FACILITY_STATUS.REJECTED);
      // The date never moves: families have the date, and the policy says so.
      expect(proposal.to.date).toBe(proposal.from.date);
    }
    // **Two grades**, which is what makes "added compromises" a real column.
    const grades = new Set(result.relocations.proposals.map((p) => p.grade));
    expect([...grades].sort()).toEqual([REPLACEMENT_GRADE.CLEAN, REPLACEMENT_GRADE.COMPROMISED]);
    // The clean ground is lined for the format; the compromised ground is not.
    for (const proposal of result.relocations.proposals) {
      const lining = checkLining(graph, {
        surfaceId: proposal.to.surfaceId,
        format: AFFECTED_FORMAT,
      });
      expect(lining.status === FACILITY_STATUS.ALLOWED, proposal.to.surfaceId).toBe(
        proposal.grade === REPLACEMENT_GRADE.CLEAN
      );
    }
    const finding = result.findings.find(
      (f) => f.code === SCENARIO_REASON.SCENARIO_RELOCATION_PROPOSED
    );
    expect(finding?.details.venueIds).toEqual(venues);
    expect(finding?.details.proposed).toBe(result.relocations.proposals.length);
  });

  it('names the added compromises, and they are the corpus’s own', () => {
    const compromised = result.relocations.proposals.filter(
      (p) => p.grade === REPLACEMENT_GRADE.COMPROMISED
    );
    expect(compromised.length).toBeGreaterThan(0);
    const codes = [...new Set(compromised.flatMap((p) => p.compromiseCodes))].sort();
    // Since #53 a grade is `resolve/`'s facility model's verdict plus the coach
    // evaluator's travel compromise, not a one-code list of the proposer's own:
    // measured on this withdrawal, 46 lining mismatches, 6 neighbours with an
    // unknown footprint, 3 journeys too short between venues.
    expect(codes).toEqual([
      'LINING_MISMATCH',
      'OCCUPANCY_FOOTPRINT_UNKNOWN',
      'TRAVEL_BETWEEN_VENUES_TOO_SHORT',
    ]);
    const lined = compromised.filter((p) => p.compromiseCodes.includes('LINING_MISMATCH'));
    // The rule engine agrees, independently: the branch's schedule carries
    // exactly that many more of the code than the baseline did.
    expect(diff.constraints.byCode.LINING_MISMATCH.delta).toBe(lined.length);
    expect(diff.constraints.newlyViolated).toContain('LINING_MISMATCH');
    expect(codesOf(result.findings)).toContain(SCENARIO_REASON.SCENARIO_RELOCATION_COMPROMISED);
  });

  it('reports "undersized" as unreachable rather than manufacturing it', () => {
    // The build plan's example names *"undersized or wrongly-lined pitches"*.
    // Only the second half is deliverable, and the reason is a property of the
    // model rather than of this corpus: SIZE_TOO_SMALL is blocking and the size
    // policy is downward-closed, so a game is refused rather than placed on
    // ground too small for it. Asserted here so a later change that quietly
    // softened the size constraint would fail this test rather than pass it.
    const tooSmall = Object.values(graph.surfaces).filter(
      (surface) =>
        checkSizeEligibility(graph, { surfaceId: surface.id, format: AFFECTED_FORMAT }).status ===
        FACILITY_STATUS.REJECTED
    );
    expect(tooSmall.length).toBeGreaterThan(0);
    for (const surface of tooSmall) {
      expect(policy.surfaceIds, surface.id).not.toContain(surface.id);
      expect(
        result.relocations.proposals.map((p) => p.to.surfaceId),
        surface.id
      ).not.toContain(surface.id);
    }
  });

  it('keeps every fixture it cannot place visible, with a reason (incident 10)', () => {
    expect(result.relocations.unrelocatable.length).toBeGreaterThan(0);
    expect(result.unplaced.length).toBe(result.relocations.unrelocatable.length);
    for (const fixture of result.unplaced) {
      expect(fixture.timeStatus).toBe(PUBLICATION_TBD.TIME);
      expect(fixture.locationStatus).toBe(PUBLICATION_TBD.LOCATION);
      expect(fixture.reason.length).toBeGreaterThan(20);
      // The machine-readable half beside the sentence, from the branch's own
      // finding rather than from a third opinion about why.
      expect(fixture.reasonCodes).toContain('PERMIT_BLACKOUT');
      expect(fixture.constraintIds.length).toBeGreaterThan(0);
      expect(fixture.publishedSurfaceId?.startsWith(WITHDRAWN.venueId)).toBe(true);
    }
    // …and nothing was silently dropped: the accounting is against the
    // baseline's own ids, never against the run's output.
    expect(result.accounting.missingFixtureIds).toEqual([]);
    expect(result.accounting.doubleCountedFixtureIds).toEqual([]);
    expect(result.accounting.totals.expected).toBe(schedule.games.length);
    expect(result.accounting.totals.accounted).toBe(schedule.games.length);
    expect(result.accounting.meta.fixturesAccountedFor).toBe(schedule.games.length);
    expect(result.accounting.meta.fixturesTimeTbd).toBe(result.unplaced.length);
    expect(result.schedule.games.length).toBe(schedule.games.length - result.unplaced.length);
  });

  it('accounts for every displaced game as either relocated or TIME TBD', () => {
    const proposed = result.relocations.proposals.map((p) => p.gameId);
    const shelved = result.relocations.unrelocatable.map((u) => u.gameId);
    expect(proposed.length + shelved.length).toBe(result.displaced.length);
    expect([...proposed, ...shelved].sort()).toEqual(
      result.displaced.map((game) => game.gameId).sort()
    );
    expect(new Set([...proposed, ...shelved]).size).toBe(result.displaced.length);
  });

  it('ranks by resolve/’s objective, clean first, and never proposes a slot the gate refuses', () => {
    // #53: one definition of "better". There were two stated orderings
    // (nearest-kickoff, prefer-clean), a second comparator beside the
    // objective; there is now one, stated on every proposal.
    expect(result.relocations.ranking).toBe(RELOCATION_RANKING);
    for (const proposal of result.relocations.proposals) {
      expect(proposal.ranking).toBe(RELOCATION_RANKING);
      expect(typeof proposal.score).toBe('number');
    }
    // Before #53, one proposal here double-booked a coach and was applied
    // with a warning. Every proposal is now judged by the placer's own gate
    // before it is proposed, and again (the backstop) before it is applied.
    expect(codesOf(result.findings)).not.toContain('RESOLVE_COACH_OVERLAP_CARRIED');
    expect(codesOf(result.findings)).not.toContain('RESOLVE_CHANGE_REFUSED_BY_RULES');
    const probe = createPlacementProbe({ schedule, engines: result.materialised.engines });
    for (const proposal of result.relocations.proposals) {
      expect(probe.evaluate(proposal.gameId, proposal.to).cleared, proposal.gameId).toBe(true);
      probe.hold(proposal.gameId, proposal.to);
    }
  });

  it('says the replacements were proposed, not solved — and the re-solver could not have found them', () => {
    const finding = result.findings.find(
      (f) => f.code === SCENARIO_REASON.SCENARIO_RELOCATION_PROPOSED
    );
    expect(finding?.details.ranking).toBe(RELOCATION_RANKING);
    expect(finding?.details.policySource).toBe(policy.source);
    expect(finding?.message).toMatch(/proposed/i);
    expect(finding?.details.candidatesConsidered).toBeGreaterThan(
      result.relocations.proposals.length
    );

    // The structural half of the claim: `candidateSlotsFor()` derives its
    // candidate venue from the game's own anchor surface and fixes every
    // candidate at the anchor's date, so a re-solve of this branch could never
    // have offered a slot at another venue. Read off the run's own state.
    const run = /** @type {any} */ (result.run);
    expect(run).not.toBeNull();
    const sample = result.displaced[0];
    const anchor = {
      date: sample.date,
      surfaceId: sample.surfaceId,
      startMinutes: sample.startMinutes,
    };
    const offered = candidateSlotsFor(
      run.state,
      sample.gameId,
      anchor,
      RESOLVE_OBJECTIVE_WEIGHTS
    ).filter(
      (slot) =>
        !(run.state.admittedSlotsByGameId[sample.gameId] ?? []).includes(
          `${slot.date}|${slot.surfaceId}|${slot.startMinutes}`
        )
    );
    expect(offered.length).toBeGreaterThan(0);
    for (const slot of offered) {
      expect(slot.date, JSON.stringify(slot)).toBe(anchor.date);
      expect(slot.surfaceId.startsWith(WITHDRAWN.venueId), JSON.stringify(slot)).toBe(true);
    }
  });

  it('answers the three things the diff is optimised for, and nothing else', () => {
    // (1) which games differ
    expect(diff.games.changed.length).toBe(result.relocations.proposals.length);
    expect(diff.games.removed.length).toBe(result.unplaced.length);
    expect(diff.games.added.length).toBe(0);
    expect(diff.games.unchanged).toBe(schedule.games.length - result.displaced.length);
    for (const change of diff.games.changed) {
      expect(change.changedFields.length).toBeGreaterThan(0);
      expect(change.before).not.toBeNull();
      expect(change.after).not.toBeNull();
    }

    // (2) which constraints break, "newly" rather than "at all"
    expect(diff.constraints.measured).toBe(true);
    expect(diff.constraints.newlyViolated.length).toBeGreaterThan(0);
    for (const code of diff.constraints.newlyViolated) {
      expect(diff.constraints.byCode[code].delta, code).toBeGreaterThan(0);
    }
    // The season's own 62 accepted exceptions are not reported as introduced.
    expect(baselineVerification.violations.length).toBeGreaterThan(0);
    const unchangedCodes = Object.entries(diff.constraints.byCode)
      .filter(([, counts]) => counts.delta === 0)
      .map(([code]) => code);
    expect(unchangedCodes.length).toBeGreaterThan(0);
    for (const code of unchangedCodes) {
      expect(diff.constraints.newlyViolated, code).not.toContain(code);
    }

    // (3) what capacity is lost, per stated subject and never as one scalar
    expect(diff.capacity).toHaveLength(capacitySubjects.length);
    const [subject] = diff.capacity;
    expect(subject.format).toBe(AFFECTED_FORMAT);
    expect(subject.leftSlots).toBeGreaterThan(subject.rightSlots);
    expect(subject.delta).toBe(subject.rightSlots - subject.leftSlots);
    expect(Object.keys(subject.byDate).sort()).toEqual([...WITHDRAWN.dates].sort());
    for (const date of WITHDRAWN.dates) {
      expect(subject.byDate[date].delta, date).toBeLessThan(0);
    }
    // The delta is the sum of the per-date deltas, and nothing claims to be a
    // season-wide "capacity lost" number.
    expect(Object.values(subject.byDate).reduce((sum, entry) => sum + entry.delta, 0)).toBe(
      subject.delta
    );

    // and the quality delta, through the one fitness function
    expect(diff.quality.measured).toBe(true);
    expect(diff.quality.delta).toBe(diff.quality.right - diff.quality.left);
    expect(diff.quality.delta).toBeGreaterThan(0);
  });
});

describe('the negative control :: the same branch with the proposer switched off', () => {
  it('carries every displaced game as TIME TBD naming the code the branch introduced', () => {
    expect(control.displaced.map((g) => g.gameId).sort()).toEqual(
      result.displaced.map((g) => g.gameId).sort()
    );
    expect(control.relocations.proposals).toEqual([]);
    expect(control.unplaced.length).toBe(control.displaced.length);
    for (const fixture of control.unplaced) {
      expect(fixture.timeStatus).toBe(PUBLICATION_TBD.TIME);
      expect(fixture.reasonCodes).toEqual(['PERMIT_BLACKOUT']);
    }
    expect(codesOf(control.findings)).toContain(SCENARIO_REASON.SCENARIO_RELOCATIONS_DISABLED);
  });

  it('names no replacement venue anywhere in its report', () => {
    // The whole point of the control. Every finding detail is scanned, not just
    // the ones this test expects to be empty.
    const named = new Set();
    for (const finding of control.findings) {
      for (const value of Object.values(finding.details)) {
        for (const entry of Array.isArray(value) ? value : [value]) {
          if (typeof entry !== 'string') continue;
          for (const surface of Object.values(graph.surfaces)) {
            if (entry.includes(surface.id) || entry === surface.venueId) named.add(surface.venueId);
          }
        }
      }
    }
    expect([...named].sort()).toEqual([WITHDRAWN.venueId]);
    expect(controlDiff.games.changed).toEqual([]);
    expect(controlDiff.games.removed.length).toBe(control.displaced.length);
  });

  it('is strictly worse than the searched run, by the one objective', () => {
    // "We found replacements" only means something because the alternative is
    // measurably worse under the same score.
    expect(controlDiff.quality.right).toBeGreaterThan(diff.quality.right);
    expect(control.schedule.games.length).toBeLessThan(result.schedule.games.length);
  });
});

describe('the three falsifications', () => {
  /* -- 1. sharing --------------------------------------------------------- */

  it('shares one record set across five branches, and a copying materialiser does not', () => {
    // Own the record objects so the mutation below cannot reach the module-level
    // seed array every other test in the repository reads.
    const owned = SEASON_2026_CONSTRAINTS.map((record) => ({ ...record }));
    const bundle = season2026SeasonInputs({
      schedule,
      facilityInput,
      timingInput,
      calendarInput,
      constraints: owned,
      venueComplexes,
      id: 'sharing-baseline',
    });
    const branches = ['a', 'b', 'c', 'd', 'e'].map((suffix) =>
      season2026VenueUnavailableScenario({
        venueId: WITHDRAWN.venueId,
        baselineId: bundle.id,
        requestedBy: REQUESTED_BY,
        at: REQUESTED_AT,
        id: `no-venue-${suffix}`,
        dates: [WITHDRAWN.dates[0]],
      })
    );

    // **The fix, applied once.** A constraint record is corrected in the
    // baseline and nothing is rebuilt, re-materialised or re-registered.
    const MARKER = 'corrected once, in the baseline, at 2026-08-02T10:00:00';
    const target = owned.find((record) => record.enforcement === 'reason-codes');
    expect(target).toBeDefined();
    /** @type {any} */ (target).rationale = MARKER;

    const seen = branches.map(
      (branch) =>
        materialiseScenario(bundle, branch).engines.registry.byId[/** @type {any} */ (target).id]
          .rationale
    );
    expect(seen).toHaveLength(5);
    expect(seen).toEqual([MARKER, MARKER, MARKER, MARKER, MARKER]);
    // …and the sharing is structural: the sets no override touched are the same
    // array object the baseline holds.
    for (const branch of branches) {
      const materialised = materialiseScenario(bundle, branch);
      expect(materialised.sharedRecordSets).toContain(SCENARIO_RECORD_SET.CONSTRAINTS);
      expect(materialised.records[SCENARIO_RECORD_SET.CONSTRAINTS]).toBe(bundle.constraints);
      expect(materialised.meta.recordSetsShared).toBeGreaterThan(0);
    }

    // **The falsification.** A materialiser that copied the record arrays —
    // which is exactly what five hand-built pipelines are — fails the same
    // assertion, so the assertion above is a check rather than a sentence.
    const copying = (base) => ({
      ...base,
      constraints: base.constraints.map((record) => ({ ...record })),
    });
    const copied = copying(bundle);
    /** @type {any} */ (target).rationale = 'a second correction, applied to the baseline only';
    const copiedSeen = copied.constraints.find(
      (record) => record.id === /** @type {any} */ (target).id
    ).rationale;
    expect(copiedSeen).toBe(MARKER);
    expect(copiedSeen).not.toBe(/** @type {any} */ (target).rationale);
    // …while the shared bundle does see it.
    expect(
      materialiseScenario(bundle, branches[0]).engines.registry.byId[/** @type {any} */ (target).id]
        .rationale
    ).toBe(/** @type {any} */ (target).rationale);
  });

  /* -- 2. the partition --------------------------------------------------- */

  it('reconciles the diff partition against both inputs, and catches a drop and a double-count', () => {
    const partition = diffSchedules({
      left: schedule.games,
      right: result.schedule.games,
    });
    // The honest partition reconciles from both sides and reports nothing.
    expect(
      scheduleDiffPartitionFindings(partition, {
        leftCount: schedule.games.length,
        rightCount: result.schedule.games.length,
      })
    ).toEqual([]);
    expect(
      partition.changed.length +
        partition.added.length +
        partition.removed.length +
        partition.unchanged.length
    ).toBe(schedule.games.length);

    // **A dropped row.** One changed game removed from the partition: both
    // sides now come up one short.
    const dropped = { ...partition, changed: partition.changed.slice(1) };
    const droppedFindings = scheduleDiffPartitionFindings(dropped, {
      leftCount: schedule.games.length,
      rightCount: result.schedule.games.length,
    });
    expect(droppedFindings.length).toBeGreaterThanOrEqual(2);
    expect(codesOf(droppedFindings)).toContain(SCENARIO_REASON.SCENARIO_DIFF_PARTITION_INCOMPLETE);
    for (const finding of droppedFindings) {
      expect(finding.severity).toBe(CONSTRAINT_SEVERITY.BLOCKING);
    }

    // **A double-counted row.** A game in two buckets at once.
    const doubled = {
      ...partition,
      removed: [...partition.removed, { ...partition.changed[0], before: null, after: null }],
    };
    const doubledFindings = scheduleDiffPartitionFindings(doubled, {
      leftCount: schedule.games.length,
      rightCount: result.schedule.games.length,
    });
    expect(codesOf(doubledFindings)).toContain(SCENARIO_REASON.SCENARIO_DIFF_PARTITION_INCOMPLETE);
    expect(
      doubledFindings.some((finding) => finding.details.side === 'both'),
      'the double-count must be caught by identity, not only by the totals'
    ).toBe(true);
  });

  /* -- 3. vacuity --------------------------------------------------------- */

  it('reports an override for ground the schedule never uses as vacuous', () => {
    // Every venue the corpus declares but never schedules a game at. If the
    // corpus ever schedules all of them, this test says so rather than passing.
    const used = new Set(schedule.games.map((game) => game.venueId));
    const unused = Object.values(graph.venues)
      .map((venue) => venue.id)
      .filter((venueId) => !used.has(venueId));
    const venueId = unused[0] ?? 'a-venue-this-corpus-does-not-have';

    const vacuous = makeScenario({
      id: 'vacuous-branch',
      name: 'without ground nobody uses',
      baselineId: inputs.id,
      rationale: 'the positive control for vacuity detection',
      requestedBy: REQUESTED_BY,
      createdAt: REQUESTED_AT,
      overrides: [
        {
          kind: SCENARIO_OVERRIDE_KIND.ADD,
          recordSet: SCENARIO_RECORD_SET.PERMITS,
          record: {
            id: 'vacuous-blackout',
            venueId,
            scopeKind: 'weekday-default',
            weekday: 'SAT',
            date: null,
            hasPermit: false,
            openMinutes: null,
            closeMinutes: null,
            lit: null,
            lightsOffMinutes: null,
            note: 'a venue this schedule never uses',
            source: 'test',
          },
          by: REQUESTED_BY,
          at: REQUESTED_AT,
          reason: 'withdraw ground the schedule never stands on',
        },
      ],
    });

    const vacuousResult = runScenario(inputs, vacuous, runOptions);
    expect(vacuousResult.displaced).toEqual([]);
    expect(codesOf(vacuousResult.findings)).toContain(SCENARIO_REASON.SCENARIO_OVERRIDE_VACUOUS);
    const finding = vacuousResult.findings.find(
      (f) => f.code === SCENARIO_REASON.SCENARIO_OVERRIDE_VACUOUS
    );
    // The same severity `CONSTRAINT_PROJECTION_VACUOUS` carries, and for the
    // same reason: a query that examined nothing must not read as a clean pass.
    expect(finding?.severity).toBe(CONSTRAINT_SEVERITY.COMPROMISE);
    // …and the branch that is *not* vacuous does not carry it.
    expect(codesOf(result.findings)).not.toContain(SCENARIO_REASON.SCENARIO_OVERRIDE_VACUOUS);
  });
});

describe('overrides are set operations on record arrays, not a fourth precedence ladder', () => {
  it('expands one venueId into a complete set of permit edits', () => {
    const [override] = scenario.overrides;
    const expansion = expandVenueUnavailable(override, inputs.permits);
    // Every base row for the venue is withdrawn…
    const mine = inputs.permits.filter((row) => row.venueId === WITHDRAWN.venueId);
    expect(mine.length).toBeGreaterThan(0);
    expect(expansion.removeIds.sort()).toEqual(mine.map((row) => String(row.id)).sort());
    // …and a blackout is laid on every weekday, so no date can fall through a
    // weekday nobody enumerated.
    expect(expansion.added).toHaveLength(7);
    expect([...new Set(expansion.added.map((row) => row.weekday))].sort()).toEqual([
      'FRI',
      'MON',
      'SAT',
      'SUN',
      'THU',
      'TUE',
      'WED',
    ]);
    for (const row of expansion.added) {
      expect(row.hasPermit).toBe(false);
      expect(row.openMinutes).toBeNull();
      expect(row.closeMinutes).toBeNull();
    }
  });

  it('withdraws the venue’s own rows, because a blackout beside an open window is ambiguous', () => {
    const branchCalendar = result.materialised.engines.calendar;
    for (const date of WITHDRAWN.dates) {
      const resolved = resolvePermitWindow(branchCalendar, {
        venueId: WITHDRAWN.venueId,
        date,
      });
      expect(resolved.window?.hasPermit, date).toBe(false);
      expect(resolved.ambiguous, date).toBe(false);
    }

    // **The falsification.** A branch that only *adds* the blackout, leaving the
    // venue's open window in place, resolves to the same blackout — and reports
    // the ambiguity on every consultation. That is what `remove` is for.
    const addOnly = makeScenario({
      id: 'add-only-blackout',
      name: 'blackout laid beside the open window',
      baselineId: inputs.id,
      rationale: 'the falsification for "remove is not convenience"',
      requestedBy: REQUESTED_BY,
      createdAt: REQUESTED_AT,
      overrides: expandVenueUnavailable(scenario.overrides[0], inputs.permits).added.map(
        (record) => ({
          kind: SCENARIO_OVERRIDE_KIND.ADD,
          recordSet: SCENARIO_RECORD_SET.PERMITS,
          record,
          by: REQUESTED_BY,
          at: REQUESTED_AT,
          reason: 'blackout only, with the open window left standing',
        })
      ),
    });
    const addOnlyCalendar = materialiseScenario(inputs, addOnly).engines.calendar;
    const resolved = resolvePermitWindow(addOnlyCalendar, {
      venueId: WITHDRAWN.venueId,
      date: WITHDRAWN.dates[0],
    });
    expect(resolved.window?.hasPermit).toBe(false);
    expect(resolved.ambiguous).toBe(true);
  });

  it('reports two overrides touching one record as a conflict, not a precedence question', () => {
    const victim = String(inputs.permits[0].id);
    const conflicted = makeScenario({
      id: 'conflicted',
      name: 'two edits, one record',
      baselineId: inputs.id,
      rationale: 'the positive control for override conflict detection',
      requestedBy: REQUESTED_BY,
      createdAt: REQUESTED_AT,
      overrides: [
        {
          kind: SCENARIO_OVERRIDE_KIND.REMOVE,
          recordSet: SCENARIO_RECORD_SET.PERMITS,
          recordId: victim,
          by: 'first@club.example',
          at: REQUESTED_AT,
          reason: 'the permit was withdrawn',
        },
        {
          kind: SCENARIO_OVERRIDE_KIND.REMOVE,
          recordSet: SCENARIO_RECORD_SET.PERMITS,
          recordId: victim,
          by: 'second@club.example',
          at: REQUESTED_AT,
          reason: 'the permit was withdrawn again',
        },
      ],
    });
    const materialised = materialiseScenario(inputs, conflicted);
    const finding = materialised.findings.find(
      (f) => f.code === SCENARIO_REASON.SCENARIO_OVERRIDE_CONFLICT
    );
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe(CONSTRAINT_SEVERITY.BLOCKING);
    expect(finding?.details.recordId).toBe(victim);
    // The second edit is *not* applied: a conflict is reported rather than
    // resolved by picking a winner.
    expect(materialised.meta.recordsRemoved).toBe(1);
  });

  it('refuses an override whose target the baseline does not hold, or whose id collides', () => {
    const missing = materialiseScenario(
      inputs,
      makeScenario({
        id: 'missing-target',
        name: 'withdraw a record nobody has',
        baselineId: inputs.id,
        rationale: 'the positive control for a missing override target',
        requestedBy: REQUESTED_BY,
        createdAt: REQUESTED_AT,
        overrides: [
          {
            kind: SCENARIO_OVERRIDE_KIND.REMOVE,
            recordSet: SCENARIO_RECORD_SET.PERMITS,
            recordId: 'no-such-permit-row',
            by: REQUESTED_BY,
            at: REQUESTED_AT,
            reason: 'this record does not exist',
          },
        ],
      })
    );
    expect(codesOf(missing.findings)).toContain(SCENARIO_REASON.SCENARIO_OVERRIDE_TARGET_MISSING);
    expect(missing.status).toBe('rejected');

    const collides = materialiseScenario(
      inputs,
      makeScenario({
        id: 'collides',
        name: 'add a record that already exists',
        baselineId: inputs.id,
        rationale: 'the positive control for an id collision',
        requestedBy: REQUESTED_BY,
        createdAt: REQUESTED_AT,
        overrides: [
          {
            kind: SCENARIO_OVERRIDE_KIND.ADD,
            recordSet: SCENARIO_RECORD_SET.PERMITS,
            record: { ...inputs.permits[0] },
            by: REQUESTED_BY,
            at: REQUESTED_AT,
            reason: 'an id the baseline already holds',
          },
        ],
      })
    );
    expect(codesOf(collides.findings)).toContain(SCENARIO_REASON.SCENARIO_OVERRIDE_ID_COLLIDES);
  });

  it('writes a retype through retypeConstraint(), so the history is the one existing kind', () => {
    // A record with no history of its own, so "the history grew by exactly one"
    // is a statement about this branch rather than about the corpus's own
    // recorded type changes.
    const soft = registry.constraints.find(
      (record) =>
        record.type === CONSTRAINT_TYPE.HARD &&
        record.enforcement === 'reason-codes' &&
        record.history.length === 0
    );
    expect(soft).toBeDefined();
    const retyped = materialiseScenario(
      inputs,
      makeScenario({
        id: 'softened',
        name: 'what if this were a preference?',
        baselineId: inputs.id,
        rationale: 'the branch that asks what a hard rule costs',
        requestedBy: REQUESTED_BY,
        createdAt: REQUESTED_AT,
        overrides: [
          {
            kind: SCENARIO_OVERRIDE_KIND.RETYPE,
            recordSet: SCENARIO_RECORD_SET.CONSTRAINTS,
            recordId: /** @type {any} */ (soft).id,
            type: CONSTRAINT_TYPE.SOFT,
            weight: 5,
            by: REQUESTED_BY,
            at: REQUESTED_AT,
            reason: 'the board asked what this rule costs as a soft constraint',
          },
        ],
      })
    );
    const record = retyped.engines.registry.byId[/** @type {any} */ (soft).id];
    expect(record.type).toBe(CONSTRAINT_TYPE.SOFT);
    expect(record.weight).toBe(5);
    // The history `retypeConstraint()` writes, not a second one.
    expect(record.history).toHaveLength(1);
    expect(record.history[0]).toMatchObject({
      from: CONSTRAINT_TYPE.HARD,
      to: CONSTRAINT_TYPE.SOFT,
      by: REQUESTED_BY,
      // The constraint model stamps a type change with the calendar date the
      // decision was taken; the override carries the naive timestamp the rest
      // of this package uses, and the date is its leading ten characters.
      at: REQUESTED_AT.slice(0, 10),
    });
    // The baseline is untouched: a branch edits nothing a sibling can see.
    expect(registry.byId[/** @type {any} */ (soft).id].type).toBe(CONSTRAINT_TYPE.HARD);
    expect(retyped.meta.recordsRetyped).toBe(1);
  });

  it('composes a branch of a branch, parent first', () => {
    const child = season2026VenueUnavailableScenario({
      venueId: WITHDRAWN.venueId,
      baselineId: inputs.id,
      requestedBy: REQUESTED_BY,
      at: REQUESTED_AT,
      id: 'child-branch',
      parentScenarioId: scenario.id,
      dates: [WITHDRAWN.dates[0]],
    });
    // A child materialised without its ancestry is a branch missing half its
    // edits, and is refused rather than silently answered.
    expect(() => materialiseScenario(inputs, child)).toThrow(/options\.ancestry/);
    const materialised = materialiseScenario(inputs, child, { ancestry: [scenario] });
    expect(codesOf(materialised.findings)).toContain(
      SCENARIO_REASON.SCENARIO_BRANCHED_FROM_SCENARIO
    );
    expect(materialised.meta.overridesDeclared).toBe(2);
    // A child narrowing, broadening or restating its parent's withdrawal is
    // **composition** — it is what naming a parent is for — so the two
    // withdrawals apply in order and neither is refused. The duplicate-venue
    // conflict is a contradiction *within one author's* edit list, and this is
    // two authors in a chain.
    expect(materialised.overrides).toHaveLength(2);
    expect(materialised.overrides[0]).toBe(scenario.overrides[0]);
    expect(codesOf(materialised.findings)).not.toContain(
      SCENARIO_REASON.SCENARIO_OVERRIDE_CONFLICT
    );
    expect(materialised.meta.overridesApplied).toBe(2);
  });

  it('refuses a scenario that overrides nothing, or branches from the wrong baseline', () => {
    expect(() =>
      makeScenario({
        id: 'empty',
        name: 'the baseline under a second name',
        baselineId: inputs.id,
        rationale: 'nothing',
        requestedBy: REQUESTED_BY,
        overrides: [],
      })
    ).toThrow();
    expect(() =>
      materialiseScenario(makeSeasonInputs({ ...inputs, id: 'another-baseline' }), scenario)
    ).toThrow(/branches from baseline/);
  });
});

describe('the memo :: lazily derived, fingerprinted, never stored on the scenario', () => {
  it('holds no schedule and no records on the scenario record itself', () => {
    // The source project's failure, refused structurally: a scenario is an id,
    // a baseline, a parent, a list of edits and a reason.
    expect(Object.keys(scenario).sort()).toEqual([
      'baselineId',
      'createdAt',
      'id',
      'name',
      'overrides',
      'parentScenarioId',
      'rationale',
      'requestedBy',
    ]);
    expect(Object.isFrozen(scenario)).toBe(true);
  });

  it('re-derives rather than serving a result whose fingerprint has moved', () => {
    const owned = SEASON_2026_CONSTRAINTS.map((record) => ({ ...record }));
    const bundle = season2026SeasonInputs({
      schedule,
      facilityInput,
      timingInput,
      calendarInput,
      constraints: owned,
      venueComplexes,
      id: 'memo-baseline',
    });
    const branch = season2026VenueUnavailableScenario({
      venueId: WITHDRAWN.venueId,
      baselineId: bundle.id,
      requestedBy: REQUESTED_BY,
      at: REQUESTED_AT,
      dates: [WITHDRAWN.dates[0]],
    });
    const memo = new ScenarioMemo();
    const first = memo.resolve(bundle, branch, runOptions);
    const second = memo.resolve(bundle, branch, runOptions);
    expect(second).toBe(first);
    expect(memo.hits).toBe(1);
    expect(memo.misses).toBe(1);
    expect(memo.check(bundle, branch)).toEqual([]);

    // **The fingerprint moves when the records do.** A bundle rebuilt over the
    // edited records digests differently, and the cached result is refused.
    /** @type {any} */ (owned[0]).rationale = 'edited after the branch was derived';
    const rebuilt = season2026SeasonInputs({
      schedule,
      facilityInput,
      timingInput,
      calendarInput,
      constraints: owned,
      venueComplexes,
      id: 'memo-baseline',
    });
    expect(rebuilt.digest).not.toBe(bundle.digest);
    const stale = memo.check(rebuilt, branch);
    expect(codesOf(stale)).toEqual([SCENARIO_REASON.SCENARIO_RESULT_STALE]);
    expect(stale[0].severity).toBe(CONSTRAINT_SEVERITY.BLOCKING);
    memo.resolve(rebuilt, branch, runOptions);
    expect(memo.misses).toBe(2);
  });

  it('fingerprints the records and the overrides, and nothing else', () => {
    // A fingerprint that read scenario metadata would derive a check's subject
    // from data the corruption it detects would also change.
    const renamed = makeScenario({
      ...scenario,
      name: 'the same branch under a different name',
      rationale: 'a different rationale entirely',
      requestedBy: 'somebody-else@club.example',
      createdAt: '2027-01-01T00:00:00',
    });
    expect(scenarioFingerprint(inputs, renamed.overrides)).toBe(
      scenarioFingerprint(inputs, scenario.overrides)
    );
    const different = season2026VenueUnavailableScenario({
      venueId: WITHDRAWN.venueId,
      baselineId: inputs.id,
      requestedBy: REQUESTED_BY,
      at: REQUESTED_AT,
      dates: [WITHDRAWN.dates[0]],
    });
    expect(scenarioFingerprint(inputs, different.overrides)).not.toBe(
      scenarioFingerprint(inputs, scenario.overrides)
    );
  });
});

describe('promotion :: a new primary plus the recorded diff', () => {
  const promotion = promoteScenario({
    result,
    diff,
    promotionId: 'promotion-no-venue',
    promotedAt: '2026-08-05T12:00:00',
    promotedBy: 'board@club.example',
    rationale: 'the board accepted the reduced-venue plan at its August meeting',
  });

  it('records the diff on the promotion, in an immutable digest-stamped artifact', () => {
    expect(codesOf(promotion.findings)).toEqual([SCENARIO_REASON.SCENARIO_PROMOTED]);
    expect(promotion.diff).toBe(diff);
    expect(promotion.snapshot.rowCount).toBe(
      diff.games.changed.length + diff.games.added.length + diff.games.removed.length
    );
    expect(verifySnapshotDigest(promotion.snapshot)).toEqual([]);
    expect(promotion.durability).toBe('in-memory');
    // Nothing read a clock: both stamps are the caller's.
    expect(promotion.snapshot.publishedAt).toBe('2026-08-05T12:00:00');
    expect(promotion.snapshot.publishedBy).toBe('board@club.example');
    // A shelved game records as a removal carrying both TBD tokens.
    const removed = promotion.snapshot.rows.filter((row) => row.bucket === 'removed');
    expect(removed.length).toBe(diff.games.removed.length);
    for (const row of removed) {
      expect(row.after).toContain(PUBLICATION_TBD.TIME);
      expect(row.after).toContain(PUBLICATION_TBD.LOCATION);
    }
  });

  it('makes the branch primary while preserving the sharing', () => {
    expect(promotion.primary.id).toBe('promotion-no-venue');
    expect(promotion.primary.schedule).toBe(result.schedule);
    // The permit rows changed…
    expect(promotion.primary.permits).not.toBe(inputs.permits);
    expect(promotion.primary.digest).not.toBe(inputs.digest);
    // …and every set the branch did not touch is still the baseline's own
    // array, so a fix applied to the old bundle is still one fix.
    for (const set of result.materialised.sharedRecordSets) {
      expect(promotion.primary[set], set).toBe(inputs[set]);
    }
    expect(result.materialised.sharedRecordSets.length).toBeGreaterThan(0);
    expect(promotion.meta.scenariosPromoted).toBe(1);
  });

  it('refuses to promote over a blocking finding nobody accepted', () => {
    const broken = {
      ...result,
      findings: [
        ...result.findings,
        {
          code: SCENARIO_REASON.SCENARIO_OVERRIDE_CONFLICT,
          severity: CONSTRAINT_SEVERITY.BLOCKING,
          message: 'a constructed blocking finding',
          details: {},
        },
      ],
    };
    expect(() =>
      promoteScenario({
        result: /** @type {any} */ (broken),
        diff,
        promotionId: 'promotion-refused',
        promotedAt: '2026-08-05T12:00:00',
        promotedBy: 'board@club.example',
        rationale: 'this must not go through',
      })
    ).toThrow(/refusing to promote/);
    // …and it does go through when the objection is accepted by code, which is
    // the same contract `commitResolve()` keeps.
    const forced = promoteScenario({
      result: /** @type {any} */ (broken),
      diff,
      promotionId: 'promotion-accepted',
      promotedAt: '2026-08-05T12:00:00',
      promotedBy: 'board@club.example',
      rationale: 'the conflict was reviewed and accepted',
      acceptFindingCodes: [SCENARIO_REASON.SCENARIO_OVERRIDE_CONFLICT],
    });
    expect(forced.acceptedFindingCodes).toEqual([SCENARIO_REASON.SCENARIO_OVERRIDE_CONFLICT]);
  });
});

describe('the diff refuses to fabricate', () => {
  it('reports no capacity at all when no subject is stated', () => {
    const unstated = diffAgainstBaselineScenario(result, {
      baselineEngines,
      baselineVerification,
    });
    expect(unstated.capacity).toEqual([]);
    expect(codesOf(unstated.findings)).toContain(
      SCENARIO_REASON.SCENARIO_CAPACITY_SUBJECT_UNSTATED
    );
    expect(unstated.status).toBe('compromised');
  });

  it('reports a comparison nobody measured as vacuous rather than clean', () => {
    const unmeasured = diffScenarios({
      subject: 'two branches nobody ran the rule engine over',
      left: { label: 'left', schedule, verification: null },
      right: { label: 'right', schedule: result.schedule, verification: null },
      weights: RESOLVE_OBJECTIVE_WEIGHTS,
    });
    expect(codesOf(unmeasured.findings)).toContain(SCENARIO_REASON.SCENARIO_DIFF_VACUOUS);
    expect(unmeasured.constraints.measured).toBe(false);
    expect(unmeasured.quality.measured).toBe(false);
    expect(diff.findings.map((f) => f.code)).not.toContain(SCENARIO_REASON.SCENARIO_DIFF_VACUOUS);
  });

  it('refuses a diff that does not say what it is a comparison of', () => {
    expect(() =>
      diffScenarios({
        subject: '',
        left: { label: 'left', schedule, verification: null },
        right: { label: 'right', schedule, verification: null },
        weights: RESOLVE_OBJECTIVE_WEIGHTS,
      })
    ).toThrow(/what it is a comparison of/);
  });

  it('refuses a proposer with no stated candidate ground and no stated anchor', () => {
    const engines = result.materialised.engines;
    expect(() =>
      proposeRelocations(engines, {
        displaced: result.displaced,
        survivors: [],
        gamesById: {},
        policy: { ...policy, surfaceIds: [] },
        requirement,
        probe: branchProbe(),
      })
    ).toThrow();
    expect(() =>
      proposeRelocations(engines, {
        displaced: result.displaced,
        survivors: [],
        gamesById: {},
        policy: { ...policy, earliestKickoffMinutes: undefined },
        requirement,
        probe: branchProbe(),
      })
    ).toThrow();
  });
});

/* -------------------------------------------------------------------------- */
/* Structural guarantees: no parallel version of anything                      */
/* -------------------------------------------------------------------------- */

describe('structural guarantees', () => {
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const CORE = path.join(ROOT, 'packages', 'core', 'src');

  /**
   * @param {string} dir
   * @returns {string[]}
   */
  function filesUnder(dir) {
    /** @type {string[]} */
    const files = [];
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules') continue;
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) files.push(...filesUnder(full));
      else if (entry.endsWith('.js')) files.push(full);
    }
    return files;
  }

  const coreFiles = filesUnder(CORE);
  const sources = coreFiles.map((file) => ({
    file,
    text: readFileSync(file, 'utf8'),
    /** Prose quotes the rules it explains, so the checks below read code only. */
    code: readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ''),
  }));
  const scenarioSources = sources.filter((source) =>
    source.file.startsWith(path.join(CORE, 'scenario'))
  );

  it('scans a plausible number of files', () => {
    expect(coreFiles.length).toBeGreaterThan(80);
    expect(scenarioSources.length).toBeGreaterThanOrEqual(7);
  });

  it("computes a Schedule slot's changed fields in exactly one file", () => {
    // `publication/parity.js` also builds a `changedFields` list, over the
    // export column vocabulary; it names no surface. `placement/replaceGames.js`
    // builds one too, over `PlacementChange` — the Prompt 2.1 demonstration
    // harness, which is date-less by construction (`surfaceId` and
    // `kickoffMinutes`, no date) and is deliberately not superseded.
    //
    // The computation this phase must not duplicate is the one over a
    // `Schedule` slot — date, surface, kickoff — and both the re-solver's diff
    // and the scenario diff ask it of the same exported function.
    const computing = sources.filter(
      (source) => /changedFields\.push\(/.test(source.code) && /surfaceId/.test(source.code)
    );
    expect(computing.map((source) => path.basename(source.file)).sort()).toEqual([
      'replaceGames.js',
      'state.js',
    ]);
    const overSlots = computing.filter((source) =>
      /changedFields\.push\('startMinutes'\)/.test(source.code)
    );
    expect(overSlots.map((source) => path.basename(source.file))).toEqual(['state.js']);
    for (const source of scenarioSources) {
      if (!/slotChangedFields/.test(source.code)) continue;
      expect(/from '.*resolve\/state\.js'/.test(source.code), source.file).toBe(true);
    }
  });

  it('adds no fitness function and reaches for neither existing one', () => {
    for (const source of scenarioSources) {
      expect(/\*\s*weight\b/.test(source.code), source.file).toBe(false);
      expect(/\bweight\s*\*/.test(source.code), source.file).toBe(false);
      expect(/computeFitness/.test(source.code), source.file).toBe(false);
      expect(/fitness/i.test(source.code), source.file).toBe(false);
    }
    // Everything quality goes through the one scorer.
    const scoring = scenarioSources.filter((source) =>
      /scoreSchedule|scoreObjective/.test(source.code)
    );
    expect(scoring.map((source) => path.basename(source.file))).toEqual(['diff.js']);
  });

  it('reads no clock and constructs no Date', () => {
    for (const source of scenarioSources) {
      expect(/new Date\(/.test(source.code), source.file).toBe(false);
      expect(/Date\.now\(/.test(source.code), source.file).toBe(false);
    }
  });

  it('leaves the two shipping solvers alone and writes no SQL', () => {
    for (const source of scenarioSources) {
      expect(/from '.*autoScheduler\.js'/.test(source.code), source.file).toBe(false);
      expect(/from '.*gameMetrics\.js'/.test(source.code), source.file).toBe(false);
      expect(/from '.*gameScheduling\.js'/.test(source.code), source.file).toBe(false);
      expect(/supabase/i.test(source.code), source.file).toBe(false);
    }
  });

  it('forks none of the three specificity ladders', () => {
    // Overrides are set operations applied before anything is built, so none of
    // the three existing precedence ladders applies and a fourth would be the
    // parallel machinery this phase exists to avoid.
    for (const source of scenarioSources) {
      expect(/SPECIFICITY\s*=/.test(source.code), source.file).toBe(false);
      expect(/TIE_BREAK\s*=/.test(source.code), source.file).toBe(false);
    }
  });

  it('registers every export in the package barrel', () => {
    const barrel = readFileSync(path.join(CORE, 'scenario', 'index.js'), 'utf8');
    /** @type {string[]} */
    const exported = [];
    for (const source of scenarioSources) {
      if (source.file.endsWith(path.join('scenario', 'index.js'))) continue;
      if (source.file.endsWith('types.js')) continue;
      for (const match of source.code.matchAll(/export (?:function|const|class) (\w+)/g)) {
        exported.push(match[1]);
      }
    }
    expect(exported.length).toBeGreaterThan(25);
    for (const name of exported) {
      expect(barrel, name).toContain(name);
    }
  });

  it('does not unify with the orphaned SQL scenario table or the teaming snapshot', () => {
    for (const source of scenarioSources) {
      expect(/field_availability_scenarios/.test(source.code), source.file).toBe(false);
      expect(/from '.*teamSnapshot\.js'/.test(source.code), source.file).toBe(false);
      expect(/SnapshotStatus/.test(source.code), source.file).toBe(false);
    }
    // Both are named in prose, once each, so the distinction is recorded rather
    // than merely observed.
    const prose = scenarioSources.map((source) => source.text).join('\n');
    expect(prose).toContain('field_availability_scenarios');
    expect(prose).toContain('teamSnapshot.js');
  });
});

/* -------------------------------------------------------------------------- */
/* The eleven defects the pre-PR review found, each with its failing case      */
/* -------------------------------------------------------------------------- */

describe('the memo answers the question it was asked, not merely the branch', () => {
  it('never serves the negative control as the searched answer', () => {
    // **The defect this exists to catch.** The memo keyed on the scenario id and
    // a digest of inputs and overrides alone, so two runs that differ only by a
    // run option were one entry. The negative control differs from the
    // acceptance run by exactly one run option, so the memo could serve the
    // control — nought proposals, seventy-two shelved — as the evidence the
    // whole prompt rests on.
    const memo = new ScenarioMemo();
    const viaMemoControl = memo.resolve(inputs, scenario, { ...runOptions, relocations: false });
    const viaMemoSearched = memo.resolve(inputs, scenario, runOptions);

    expect(viaMemoSearched).not.toBe(viaMemoControl);
    expect(memo.misses).toBe(2);
    expect(memo.hits).toBe(0);
    expect(viaMemoControl.relocations.proposals).toEqual([]);
    expect(viaMemoSearched.relocations.proposals.length).toBeGreaterThan(0);

    // …and the same question asked twice is still one derivation.
    expect(memo.resolve(inputs, scenario, runOptions)).toBe(viaMemoSearched);
    expect(memo.hits).toBe(1);
    expect(memo.misses).toBe(2);
  });

  it('separates two runs that differ only by the stated relocation search', () => {
    const memo = new ScenarioMemo();
    const stated = memo.resolve(inputs, scenario, runOptions);
    const narrower = memo.resolve(inputs, scenario, {
      ...runOptions,
      relocationPolicy: { ...policy, surfaceIds: policy.surfaceIds.slice(1) },
    });
    expect(narrower).not.toBe(stated);
    expect(narrower.relocations.surfaceIds).toEqual(policy.surfaceIds.slice(1));
    expect(stated.relocations.surfaceIds).toEqual(policy.surfaceIds);
  });

  it('re-establishes the acceptance and the control figures through the memo path', () => {
    // The acceptance numbers in `docs/SCENARIOS.md` were read off direct
    // `runScenario()` calls. Under the defect above the memo path could have
    // produced different ones, so both paths are asserted to agree here rather
    // than one being assumed from the other.
    const memo = new ScenarioMemo();
    const viaMemoSearched = memo.resolve(inputs, scenario, runOptions);
    const viaMemoControl = memo.resolve(inputs, scenario, { ...runOptions, relocations: false });
    const gradeCount = (plan, grade) => plan.proposals.filter((p) => p.grade === grade).length;

    expect(viaMemoSearched.displaced.length).toBe(result.displaced.length);
    expect(gradeCount(viaMemoSearched.relocations, REPLACEMENT_GRADE.CLEAN)).toBe(
      gradeCount(result.relocations, REPLACEMENT_GRADE.CLEAN)
    );
    expect(gradeCount(viaMemoSearched.relocations, REPLACEMENT_GRADE.COMPROMISED)).toBe(
      gradeCount(result.relocations, REPLACEMENT_GRADE.COMPROMISED)
    );
    expect(viaMemoSearched.unplaced.length).toBe(result.unplaced.length);
    expect(viaMemoSearched.schedule.games.length).toBe(result.schedule.games.length);

    expect(viaMemoControl.displaced.length).toBe(control.displaced.length);
    expect(viaMemoControl.relocations.proposals.length).toBe(0);
    expect(viaMemoControl.unplaced.length).toBe(control.unplaced.length);
  });
});

describe('nothing a branch loses is answered by silence', () => {
  it('carries the fixture accounting’s verdict into the findings and the status', () => {
    // `accountForFixtures()` exists to catch a fixture that disappears — the
    // whole of incident 10 — and its verdict was being computed, stored on
    // `result.accounting`, and then dropped before `result.status` was derived.
    // A branch that lost a game read `ok`, and `promoteScenario()` would have
    // promoted it.
    expect(result.accounting.findings.length).toBeGreaterThan(0);
    const carried = codesOf(result.findings);
    for (const finding of result.accounting.findings) {
      expect(carried, finding.code).toContain(finding.code);
    }

    // The consequence, on the run that shows it most plainly: the negative
    // control shelves every displaced game and must not read as a clean branch.
    expect(control.unplaced.length).toBe(control.displaced.length);
    expect(control.unplaced.length).toBeGreaterThan(0);
    expect(control.status).not.toBe('allowed');
  });

  it('carries the re-solve’s own findings into the result', () => {
    // The `applyChangeRequest()` run's findings were discarded wholesale, so
    // every verdict the re-solver reached about the branch's own changes —
    // including the new violations it verified into existence — was invisible
    // to `result.status` and to anything reading `result.findings`.
    const run = /** @type {any} */ (result.run);
    expect(run).not.toBeNull();
    expect(run.findings.length).toBeGreaterThan(0);
    const carried = new Set(codesOf(result.findings));
    for (const code of new Set(run.findings.map((finding) => finding.code))) {
      expect(carried, code).toContain(code);
    }
  });

  it('reports an unrelocatable game the schedule no longer holds rather than skipping it', () => {
    // The second mechanism in the same sequence. `shelveUnrelocatable()` walked
    // past an entry naming a game the schedule does not hold — `continue`, no
    // finding, no counter — so a game the re-solve had already dropped was
    // dropped a second time here and never reached `result.unplaced`.
    const shelving = shelveUnrelocatable(
      result.schedule,
      [
        {
          gameId: 'a-game-the-schedule-no-longer-holds',
          label: 'gone v vanished',
          reason: 'the re-solve left it nowhere to stand',
          codes: Object.freeze(['PERMIT_BLACKOUT']),
          constraintIds: Object.freeze(['permit-window']),
          candidatesConsidered: 0,
        },
      ],
      { name: 'the falsification for the silent skip', registry }
    );
    expect(shelving.shelved).toEqual([]);
    expect(shelving.unshelvable).toEqual(['a-game-the-schedule-no-longer-holds']);
  });

  it('accounts for the re-solve’s unplaced fixtures as well as its own shelving', () => {
    const run = /** @type {any} */ (result.run);
    expect(result.unplaced.length).toBe(
      result.relocations.unrelocatable.length + run.unplaced.length
    );
    expect(result.accounting.missingFixtureIds).toEqual([]);
  });
});

describe('the two record sets a branch may override are load-bearing', () => {
  /**
   * A violation the branch's own registry says may be waived, and the person it
   * is about. Derived from the corpus, never named: a waiver has to be an
   * exception *to* something, and only two of this season's constraints admit
   * one at all.
   */
  const waivable = baselineVerification.violations.find(
    (violation) =>
      violation.constraintId &&
      registry.byId[violation.constraintId]?.waivable === true &&
      violation.details?.personId
  );

  /**
   * A branch that moves nothing, so the waiver is the only thing under test.
   *
   * The same shape the vacuity control uses: ground the schedule never stands
   * on. A branch that displaced games would change which violations exist and
   * make "the waiver did it" impossible to claim.
   */
  const quietBranch = (() => {
    const used = new Set(schedule.games.map((game) => game.venueId));
    const venueId =
      Object.values(graph.venues)
        .map((venue) => venue.id)
        .find((id) => !used.has(id)) ?? 'a-venue-this-corpus-does-not-have';
    return (baselineId) =>
      makeScenario({
        id: 'a-branch-that-moves-nothing',
        name: 'ground the schedule never stands on',
        baselineId,
        rationale: 'so the record set under test is the only thing that differs',
        requestedBy: REQUESTED_BY,
        createdAt: REQUESTED_AT,
        overrides: [
          {
            kind: SCENARIO_OVERRIDE_KIND.ADD,
            recordSet: SCENARIO_RECORD_SET.PERMITS,
            record: {
              id: 'a-blackout-nobody-notices',
              venueId,
              scopeKind: 'weekday-default',
              weekday: 'SAT',
              date: null,
              hasPermit: false,
              openMinutes: null,
              closeMinutes: null,
              lit: null,
              lightsOffMinutes: null,
              note: 'a venue this schedule never uses',
              source: 'the regression',
            },
            by: REQUESTED_BY,
            at: REQUESTED_AT,
            reason: 'withdraw ground the schedule never stands on',
          },
        ],
      });
  })();

  const bundleWith = (extra) =>
    season2026SeasonInputs({
      schedule,
      facilityInput,
      timingInput,
      calendarInput,
      constraints: SEASON_2026_CONSTRAINTS,
      venueComplexes,
      ...extra,
    });

  it('honours a waiver the branch’s own record set carries', () => {
    // Meta-assertion: with no waivable violation in the corpus there would be
    // nothing for a waiver to excuse, and everything below would pass on air.
    expect(waivable, 'a violation of a constraint this season says may be waived').toBeDefined();
    const constraintId = /** @type {any} */ (waivable).constraintId;
    const personId = /** @type {any} */ (waivable).details.personId;

    const waived = bundleWith({
      waivers: [
        {
          id: 'waiver-the-branch-carries',
          constraintId,
          name: 'the exception the board granted',
          scope: { personId },
          reason: 'the board granted this coach an exception, and the branch must see it',
          approval: {
            approvedBy: REQUESTED_BY,
            approvedAt: '2026-07-01',
            reference: 'board minutes 2026-07',
          },
        },
      ],
    });
    const plain = bundleWith({});

    const withWaiver = runScenario(waived, quietBranch(waived.id), {
      ...runOptions,
      baselineVerification: null,
    });
    const without = runScenario(plain, quietBranch(plain.id), {
      ...runOptions,
      baselineVerification: null,
    });

    // Waiver-free, this is nought — and it was nought *with* the waiver too,
    // because no ledger was ever built from a record set the type says a branch
    // may override.
    expect(withWaiver.verification.meta.violationsWaived).toBeGreaterThan(0);
    expect(without.verification.meta.violationsWaived).toBe(0);
    expect(withWaiver.verification.violations.filter((v) => v.waived === true).length).toBe(
      withWaiver.verification.meta.violationsWaived
    );
  });

  it('honours a reserved slot standing on replacement ground', () => {
    const [taken] = result.relocations.proposals;
    expect(taken).toBeDefined();
    const held = season2026SeasonInputs({
      schedule,
      facilityInput,
      timingInput,
      calendarInput,
      constraints: SEASON_2026_CONSTRAINTS,
      venueComplexes,
      reservedSlots: [
        {
          id: 'ground-the-club-is-holding',
          kind: 'reservation',
          label: 'held for the league',
          date: taken.to.date,
          venueId: taken.toVenueId,
          surfaceId: taken.to.surfaceId,
          startMinutes: taken.to.startMinutes,
          endMinutes: taken.to.startMinutes + 60,
          format: AFFECTED_FORMAT,
          homeSide: 'tbd',
          awaySide: 'tbd',
          source: 'the regression for an inert record set',
        },
      ],
    });
    const run = runScenario(
      held,
      season2026VenueUnavailableScenario({
        venueId: WITHDRAWN.venueId,
        baselineId: held.id,
        requestedBy: REQUESTED_BY,
        at: REQUESTED_AT,
      }),
      runOptions
    );
    const standing = run.relocations.proposals.filter(
      (proposal) =>
        proposal.to.date === taken.to.date &&
        proposal.to.surfaceId === taken.to.surfaceId &&
        proposal.to.startMinutes === taken.to.startMinutes
    );
    expect(standing).toEqual([]);
  });
});

describe('a withdrawal sees the branch as it stands, not as it started', () => {
  it('withdraws a permit an earlier override of the same branch added', () => {
    // `venue-unavailable` expanded against the *original* permits, so a row an
    // earlier override had already added for that venue survived the
    // withdrawal — and an open window standing beside a blackout is
    // `PERMIT_PRECEDENCE_AMBIGUOUS` on every consultation, which is the exact
    // noise `remove` exists to prevent.
    const date = WITHDRAWN.dates[0];
    const branch = makeScenario({
      id: 'add-then-withdraw',
      name: 'a permit added, then the venue withdrawn',
      baselineId: inputs.id,
      rationale: 'the regression for a withdrawal that misses its own working copy',
      requestedBy: REQUESTED_BY,
      createdAt: REQUESTED_AT,
      overrides: [
        {
          kind: SCENARIO_OVERRIDE_KIND.ADD,
          recordSet: SCENARIO_RECORD_SET.PERMITS,
          record: {
            id: 'an-extra-window-nobody-withdrew',
            venueId: WITHDRAWN.venueId,
            scopeKind: 'weekday-default',
            weekday: weekdayCodeOf(date),
            date: null,
            hasPermit: true,
            openMinutes: 480,
            closeMinutes: 1200,
            lit: null,
            lightsOffMinutes: null,
            note: 'an extra window opened before the venue was withdrawn',
            source: 'the regression',
          },
          by: REQUESTED_BY,
          at: REQUESTED_AT,
          reason: 'open an extra window at the venue',
        },
        {
          kind: SCENARIO_OVERRIDE_KIND.VENUE_UNAVAILABLE,
          venueId: WITHDRAWN.venueId,
          by: REQUESTED_BY,
          at: REQUESTED_AT,
          reason: 'and then the whole venue goes',
        },
      ],
    });
    const materialised = materialiseScenario(inputs, branch);
    const surviving = materialised.records.permits.filter(
      (row) => row.venueId === WITHDRAWN.venueId && row.hasPermit === true
    );
    expect(surviving).toEqual([]);
    const resolved = resolvePermitWindow(materialised.engines.calendar, {
      venueId: WITHDRAWN.venueId,
      date,
    });
    expect(resolved.window?.hasPermit).toBe(false);
    expect(resolved.ambiguous).toBe(false);
  });
});

describe('a replacement slot is checked for legality before it is graded', () => {
  it('refuses to put a team in two places at once', () => {
    // Candidates were validated by `checkKickoffAvailability()` alone, which is
    // a statement about *ground*: it knows nothing about who is playing. Two
    // displaced games sharing a team could therefore be proposed onto two
    // replacement surfaces at the same minute and both be reported `clean`.
    const withFootprint = result.displaced.filter(
      (game) => gamesById[game.gameId]?.endMinutes !== null
    );
    const pair = (() => {
      for (let i = 0; i < withFootprint.length; i += 1) {
        for (let j = i + 1; j < withFootprint.length; j += 1) {
          const a = withFootprint[i];
          const b = withFootprint[j];
          if (a.date === b.date && a.startMinutes === b.startMinutes) return [a, b];
        }
      }
      return null;
    })();
    // Meta-assertion: a corpus with no such pair would make everything below
    // pass while proposing nothing.
    expect(pair, 'two displaced games on one date and one kickoff').not.toBeNull();
    const [first, second] = /** @type {any} */ (pair);

    const sharedTeam = 'one-team-cannot-be-in-two-places';
    const doctored = {
      ...gamesById,
      [first.gameId]: { ...gamesById[first.gameId], homeTeamId: sharedTeam },
      [second.gameId]: { ...gamesById[second.gameId], homeTeamId: sharedTeam },
    };
    const plan = proposeRelocations(result.materialised.engines, {
      displaced: [first, second],
      survivors: schedule.games.filter(
        (game) => !result.displaced.some((d) => d.gameId === String(game.id))
      ),
      gamesById: doctored,
      policy,
      requirement,
      probe: branchProbe(),
    });

    // Meta-assertion: a plan that proposed nothing would satisfy the clash
    // check vacuously.
    expect(plan.proposals.length + plan.unrelocatable.length).toBe(2);
    expect(plan.proposals.length).toBeGreaterThan(0);
    // The counter for the same refusal, asserted where the refusal is
    // constructed: `candidatesRefusedTeamClash` was reachable but never held to
    // a case, which is one review round away from the counter that could not be
    // made non-zero at all.
    expect(plan.meta.candidatesRefusedTeamClash).toBeGreaterThan(0);

    const footprint = (proposal) => {
      const row = doctored[proposal.gameId];
      return {
        start: proposal.to.startMinutes,
        end: proposal.to.startMinutes + (row.endMinutes - row.startMinutes),
      };
    };
    for (let i = 0; i < plan.proposals.length; i += 1) {
      for (let j = i + 1; j < plan.proposals.length; j += 1) {
        const a = plan.proposals[i];
        const b = plan.proposals[j];
        if (a.to.date !== b.to.date) continue;
        const left = footprint(a);
        const right = footprint(b);
        const overlap = left.start < right.end && right.start < left.end;
        expect(overlap, `${a.gameId} and ${b.gameId} share a team`).toBe(false);
      }
    }
  });
});

describe('vacuity is a statement about composition, not about a total', () => {
  it('does not call a retype vacuous when it changed exactly what it named', () => {
    // A count is not an identity. Hardening a constraint moves its violations
    // from one severity to another without moving the total, and the branch was
    // being stamped `SCENARIO_OVERRIDE_VACUOUS` — "every question asked of it is
    // answered by the baseline" — for a change that did exactly what was asked.
    const softened = registry.constraints.find((record) => record.type === CONSTRAINT_TYPE.SOFT);
    expect(softened).toBeDefined();
    const branch = makeScenario({
      id: 'harden-one-constraint',
      name: 'one constraint hardened, nothing else',
      baselineId: inputs.id,
      rationale: 'the regression for vacuity decided on a count',
      requestedBy: REQUESTED_BY,
      createdAt: REQUESTED_AT,
      overrides: [
        {
          kind: SCENARIO_OVERRIDE_KIND.RETYPE,
          recordSet: SCENARIO_RECORD_SET.CONSTRAINTS,
          recordId: /** @type {any} */ (softened).id,
          type: CONSTRAINT_TYPE.HARD,
          by: REQUESTED_BY,
          at: REQUESTED_AT,
          reason: 'the board made this one binding',
        },
      ],
    });
    const hardened = runScenario(inputs, branch, runOptions);

    // Meta-assertion: the retype has to have changed something, or "not
    // vacuous" would be the wrong answer rather than the right one.
    const shape = (verification) =>
      verification.violations
        .map((violation) => `${violation.code}|${violation.severity}|${violation.subjectId}`)
        .sort();
    expect(hardened.verification.violations.length).toBe(baselineVerification.violations.length);
    expect(shape(hardened.verification)).not.toEqual(shape(baselineVerification));

    expect(codesOf(hardened.findings)).not.toContain(SCENARIO_REASON.SCENARIO_OVERRIDE_VACUOUS);
  });
});

describe('an ancestry is checked against the parent it claims to be', () => {
  const child = season2026VenueUnavailableScenario({
    venueId: WITHDRAWN.venueId,
    baselineId: inputs.id,
    requestedBy: REQUESTED_BY,
    at: REQUESTED_AT,
    id: 'the-child',
    parentScenarioId: scenario.id,
    dates: [WITHDRAWN.dates[0]],
  });

  it('refuses an ancestry that is not the parent the branch names', () => {
    // Any non-empty array passed, so the wrong parent's overrides composed
    // under a fingerprint that looked entirely legitimate.
    const stranger = makeScenario({
      id: 'not-the-parent',
      name: 'a branch that is not this one’s parent',
      baselineId: inputs.id,
      rationale: 'the regression for an unchecked ancestry',
      requestedBy: REQUESTED_BY,
      createdAt: REQUESTED_AT,
      overrides: [
        {
          kind: SCENARIO_OVERRIDE_KIND.REMOVE,
          recordSet: SCENARIO_RECORD_SET.PERMITS,
          recordId: String(inputs.permits[0].id),
          by: REQUESTED_BY,
          at: REQUESTED_AT,
          reason: 'a stranger’s edit',
        },
      ],
    });
    expect(() => materialiseScenario(inputs, child, { ancestry: [stranger] })).toThrow(/parent/);
    // …and the real parent still composes.
    expect(() => materialiseScenario(inputs, child, { ancestry: [scenario] })).not.toThrow();
  });

  it('reports rather than throws when the memo is checked without the ancestry', () => {
    // `check()` is a reporting entry point: every other answer it gives is a
    // finding, and this one threw, so a caller reconciling a cache had to catch
    // an exception to learn that it had not passed enough.
    const memo = new ScenarioMemo();
    memo.resolve(inputs, child, { ...runOptions, ancestry: [scenario] });
    const findings = memo.check(inputs, child);
    expect(codesOf(findings)).toContain(SCENARIO_REASON.SCENARIO_ANCESTRY_UNRESOLVED);
    expect(findings[0].severity).toBe(CONSTRAINT_SEVERITY.BLOCKING);
  });
});

describe('the fingerprint covers everything that reaches a record', () => {
  it('separates two branches whose provenance differs', () => {
    // `by`, `at` and `reason` are written into the expanded permit rows' `note`
    // and `source`, and into a retyped constraint's own history, so two
    // branches carrying different ones produce genuinely different records —
    // and shared one fingerprint.
    const overridesOf = (by, reason) => [
      {
        kind: SCENARIO_OVERRIDE_KIND.VENUE_UNAVAILABLE,
        recordSet: null,
        record: null,
        recordId: null,
        type: null,
        weight: null,
        venueId: WITHDRAWN.venueId,
        dates: null,
        by,
        at: REQUESTED_AT,
        reason,
      },
    ];
    const first = overridesOf('grounds@club.example', 'the pitch is being re-turfed');
    const second = overridesOf('grounds@club.example', 'the lease was not renewed');
    const third = overridesOf('board@club.example', 'the pitch is being re-turfed');

    expect(scenarioFingerprint(inputs, first)).not.toBe(scenarioFingerprint(inputs, second));
    expect(scenarioFingerprint(inputs, first)).not.toBe(scenarioFingerprint(inputs, third));
    // The records really do differ, so this is not a digest of decoration.
    const notesOf = (overrides) =>
      expandVenueUnavailable(overrides[0], inputs.permits).added.map(
        (row) => `${row.note}|${row.source}`
      );
    expect(notesOf(first)).not.toEqual(notesOf(second));
    expect(notesOf(first)).not.toEqual(notesOf(third));
  });
});

describe('the counters count what they are named for', () => {
  it('counts overrides applied, not the primitive edits one override expands into', () => {
    // One `venue-unavailable` is one override. It expands into every permit row
    // the venue holds plus seven blackouts, and `overridesApplied` was counting
    // those — so the vacuity finding's own details reported seventeen applied
    // against one declared.
    const meta = result.materialised.meta;
    expect(meta.overridesDeclared).toBe(scenario.overrides.length);
    expect(meta.overridesApplied).toBe(scenario.overrides.length);
    // The primitive count is still kept, under its own name, and is the number
    // that made the confusion possible in the first place.
    expect(meta.recordEditsApplied).toBeGreaterThan(meta.overridesApplied);
    expect(meta.recordEditsApplied).toBe(
      meta.recordsAdded + meta.recordsRemoved + meta.recordsRetyped
    );
  });
});

/* -------------------------------------------------------------------------- */
/* The six defects the second review round found, each with its failing case   */
/* -------------------------------------------------------------------------- */

describe('the digest covers everything a branch’s answer depends on', () => {
  /** The same bundle every time, save for the one thing under test. */
  const bundleWith = (overrides) =>
    season2026SeasonInputs({
      schedule,
      facilityInput,
      timingInput,
      calendarInput,
      constraints: SEASON_2026_CONSTRAINTS,
      venueComplexes,
      ...overrides,
    });

  it('separates two bundles differing only in one game’s kickoff', () => {
    // **The defect this exists to catch.** The digest covered the record arrays
    // plus the facility and timing inputs and stopped there, so two bundles
    // whose *schedules* disagreed digested identically — and the memo, whose
    // whole staleness check is that digest, served the result derived from one
    // schedule as the answer for the other. Same class as the run-options
    // defect the first round fixed, on the other half of the key.
    const moved = {
      ...schedule,
      games: schedule.games.map((game, index) =>
        index === 0 ? { ...game, startMinutes: game.startMinutes + 15 } : game
      ),
    };
    expect(bundleWith({ schedule: moved }).digest).not.toBe(bundleWith({}).digest);
  });

  it('separates two bundles differing only in the calendar options or the complexes', () => {
    // Both reach `materialiseScenario()`'s engines — the margins go into the
    // availability calendar, the complexes into the rule engine's resources —
    // so a fingerprint blind to them would call one branch a valid cache of a
    // branch answering a different question.
    expect(
      bundleWith({
        calendarInput: {
          ...calendarInput,
          sunsetMarginMinutes: calendarInput.sunsetMarginMinutes + 5,
        },
      }).digest
    ).not.toBe(bundleWith({}).digest);
    expect(bundleWith({ venueComplexes: {} }).digest).not.toBe(bundleWith({}).digest);
  });
});

describe('an in-place record correction invalidates what was derived before it', () => {
  it('re-derives after the shared record a branch reads is edited in place', () => {
    // **The defect this exists to catch.** `inputs.js` documents the in-place
    // correction as the point of the sharing guarantee — one fix, five branches
    // — and `scenarioFingerprint()` read the digest snapshotted when the bundle
    // was built, so the correction moved every branch's answer and invalidated
    // nothing. `check()` returned [] and `resolve()` served the pre-edit object.
    //
    // Sharing is not weakened to fix it: the record arrays are still the
    // caller's own objects and still carried by reference. The digest is
    // recomputed when the question is asked instead.
    const owned = SEASON_2026_CONSTRAINTS.map((record) => ({ ...record }));
    const bundle = season2026SeasonInputs({
      schedule,
      facilityInput,
      timingInput,
      calendarInput,
      constraints: owned,
      venueComplexes,
      id: 'in-place-baseline',
    });
    const branch = season2026VenueUnavailableScenario({
      venueId: WITHDRAWN.venueId,
      baselineId: bundle.id,
      requestedBy: REQUESTED_BY,
      at: REQUESTED_AT,
      dates: [WITHDRAWN.dates[0]],
    });
    const memo = new ScenarioMemo();
    const before = memo.resolve(bundle, branch, runOptions);
    expect(memo.check(bundle, branch)).toEqual([]);

    // The correction the sharing guarantee exists for: one record, edited once,
    // in the array five branches read.
    const target = /** @type {any} */ (
      bundle.constraints.find((record) => record.type === CONSTRAINT_TYPE.HARD)
    );
    expect(target).toBeDefined();
    target.type = CONSTRAINT_TYPE.SOFT;
    target.weight = 5;

    expect(codesOf(memo.check(bundle, branch))).toEqual([SCENARIO_REASON.SCENARIO_RESULT_STALE]);
    expect(memo.resolve(bundle, branch, runOptions)).not.toBe(before);
    // …and the branch still reads the corrected record rather than a copy of it.
    expect(bundle.constraints).toBe(owned);
  });
});

describe('two overrides of one kind naming one venue are a duplicate, not a composition', () => {
  const twoAuthors = (dates) =>
    makeScenario({
      id: 'withdrawn-twice',
      name: 'two authors withdraw one venue',
      baselineId: inputs.id,
      parentScenarioId: null,
      rationale: 'the regression for a silently overwritten provenance',
      requestedBy: REQUESTED_BY,
      createdAt: REQUESTED_AT,
      overrides: [
        {
          kind: SCENARIO_OVERRIDE_KIND.VENUE_UNAVAILABLE,
          venueId: WITHDRAWN.venueId,
          dates: dates[0],
          by: 'groundskeeper@club.example',
          at: REQUESTED_AT,
          reason: 'the drainage works overran',
        },
        {
          kind: SCENARIO_OVERRIDE_KIND.VENUE_UNAVAILABLE,
          venueId: WITHDRAWN.venueId,
          dates: dates[1],
          by: 'registrar@club.example',
          at: REQUESTED_AT,
          reason: 'the permit lapsed',
        },
      ],
    });

  it('reports the second withdrawal rather than letting it overwrite the first', () => {
    // **The defect this exists to catch, and the false claim beside it.** The
    // code asserted the case was "still caught loudly, by
    // SCENARIO_OVERRIDE_ID_COLLIDES on the blackout rows it re-adds". It was
    // not: the second override's removes delete the first's rows before its
    // adds re-add them, so nothing collided, nothing conflicted, the status
    // read `allowed`, and the later author's reason silently replaced the
    // earlier author's on all seven rows. Incident 9 is a lost waiver; this is
    // a lost reason.
    const materialised = materialiseScenario(inputs, twoAuthors([null, null]));
    const conflict = materialised.findings.find(
      (finding) => finding.code === SCENARIO_REASON.SCENARIO_OVERRIDE_CONFLICT
    );
    expect(conflict).toBeDefined();
    expect(conflict?.severity).toBe(CONSTRAINT_SEVERITY.BLOCKING);
    expect(conflict?.details.venueId).toBe(WITHDRAWN.venueId);
    expect(conflict?.details.firstBy).toBe('groundskeeper@club.example');
    expect(conflict?.details.secondBy).toBe('registrar@club.example');

    // The first author's provenance survives, on every row the withdrawal laid.
    const blackouts = materialised.records[SCENARIO_RECORD_SET.PERMITS].filter((row) =>
      String(row.id).startsWith(`${SCENARIO_OVERRIDE_KIND.VENUE_UNAVAILABLE}:`)
    );
    expect(blackouts.length).toBeGreaterThan(0);
    expect([...new Set(blackouts.map((row) => row.note))]).toEqual(['the drainage works overran']);
    expect(materialised.meta.overridesApplied).toBe(1);
  });

  it('still composes two withdrawals of one venue on dates that do not overlap', () => {
    // The constraint on the fix. Last round deliberately stopped a
    // `venue-unavailable`'s derived removes from conflicting with rows *another
    // kind* of override wrote, because that is composition. Two withdrawals of
    // one venue on disjoint dates are composition too — they lay different rows
    // and neither loses its reason — and must not be swept up with the
    // duplicate above.
    const disjoint = materialiseScenario(
      inputs,
      twoAuthors([[WITHDRAWN.dates[0]], [WITHDRAWN.dates[1]]])
    );
    expect(codesOf(disjoint.findings)).not.toContain(SCENARIO_REASON.SCENARIO_OVERRIDE_CONFLICT);
    expect(disjoint.meta.overridesApplied).toBe(2);
    const notes = new Set(
      disjoint.records[SCENARIO_RECORD_SET.PERMITS]
        .filter((row) => String(row.id).startsWith(`${SCENARIO_OVERRIDE_KIND.VENUE_UNAVAILABLE}:`))
        .map((row) => row.note)
    );
    expect([...notes].sort()).toEqual(['the drainage works overran', 'the permit lapsed']);
  });
});

describe('the quality delta is a comparison, not a measure of how much moved', () => {
  const swapped = diffScenarios({
    subject: 'the baseline against the branch, the other way round',
    left: {
      label: `scenario "${result.name}"`,
      schedule: result.schedule,
      verification: result.verification,
      engines: result.materialised.engines,
    },
    right: {
      label: inputs.label,
      schedule: result.baselineSchedule,
      verification: baselineVerification,
      engines: baselineEngines,
    },
    capacitySubjects: [],
    weights: RESOLVE_OBJECTIVE_WEIGHTS,
  });

  it('negates when the two sides are swapped', () => {
    // **The defect this exists to catch.** The left side was scored against
    // itself — so its change terms were structurally zero — and the right side
    // against the left, so the delta carried 60 moved games and 12 shelved
    // fixtures on top of the violation difference. A number whose magnitude
    // depends on which side you call the baseline is not a quality comparison,
    // and this is the property that says so.
    expect(swapped.quality.delta).toBe(-diff.quality.delta);
  });

  it('scores each side on its own account, whatever it is compared against', () => {
    // The same schedule scores the same however it is paired. Under the defect
    // `quality.right` was a function of the left side as well as the right.
    expect(swapped.quality.left).toBe(diff.quality.right);
    expect(swapped.quality.right).toBe(diff.quality.left);
    expect(controlDiff.quality.left).toBe(diff.quality.left);
    // …and the control is still measurably the worse season, which is the whole
    // reason the acceptance run means anything.
    expect(controlDiff.quality.right).toBeGreaterThan(diff.quality.right);
  });
});

describe('the relocation counters are counts something could have made non-zero', () => {
  it('reports how many candidates an unrelocatable game was actually offered', () => {
    // **The defect this exists to catch.** `UnrelocatableGame.candidatesConsidered`
    // was `options.length`, on the one branch that runs only when
    // `options.length === 0` — structurally always nought, against a run-wide
    // `meta.candidatesConsidered` in the thousands. `CLAUDE.md` §3 names this
    // shape by name: a meta-assertion you cannot make fail is not one.
    expect(result.relocations.unrelocatable.length).toBeGreaterThan(0);
    for (const game of result.relocations.unrelocatable) {
      expect(game.candidatesConsidered, game.gameId).toBeGreaterThan(0);
    }
    // The run-wide counter is the sum of the per-game ones, so neither can drift
    // from the other without the reconciliation failing.
    const perGame = [
      ...result.relocations.proposals.map((proposal) => proposal.candidatesConsidered),
      ...result.relocations.unrelocatable.map((game) => game.candidatesConsidered),
    ];
    expect(perGame.reduce((sum, count) => sum + count, 0)).toBe(
      result.relocations.meta.candidatesConsidered
    );
  });

  it('counts a reserved slot when it reaches the booking table, not when it arrives', () => {
    // The first of the two siblings added last round.
    // `meta.reservedSlotsHonoured = reservedSlots.length` restated its own
    // input: delete the loops that install those slots as bookings and the
    // counter would still have claimed they were honoured.
    const [taken] = result.relocations.proposals;
    const held = {
      id: 'ground-the-club-is-holding',
      kind: 'reservation',
      label: 'held for the league',
      date: taken.to.date,
      venueId: taken.toVenueId,
      surfaceId: taken.to.surfaceId,
      startMinutes: taken.to.startMinutes,
      endMinutes: taken.to.startMinutes + 60,
      format: AFFECTED_FORMAT,
      homeSide: 'tbd',
      awaySide: 'tbd',
      source: 'the regression for a counter that restated its input',
    };
    const plan = proposeRelocations(result.materialised.engines, {
      displaced: result.displaced,
      survivors: result.baselineSchedule.games.filter(
        (game) => !result.displaced.some((d) => d.gameId === String(game.id))
      ),
      gamesById,
      policy,
      requirement,
      probe: branchProbe(),
      reservedSlots: [held],
    });
    expect(plan.meta.reservedSlotsHonoured).toBe(1);
    // …and nothing was proposed onto the ground it holds, which is what the
    // counter is a claim about.
    expect(
      plan.proposals.filter(
        (proposal) =>
          proposal.to.date === held.date &&
          proposal.to.surfaceId === held.surfaceId &&
          proposal.to.startMinutes === held.startMinutes
      )
    ).toEqual([]);
  });
});

describe('the memo’s staleness gate and its writes agree on scope', () => {
  it('serves a live entry whose branch has not moved past a stale sibling', () => {
    // **The defect this exists to catch**, and it was introduced by last
    // round's own fix. `resolve()` gated on `check()` across *every* entry for
    // the scenario but overwrote only the key it was asked about, so one stale
    // entry left for another question forced a miss for ever on a live one and
    // kept `check()` reporting blocking staleness for a cache whose entries
    // were all fresh.
    const owned = SEASON_2026_CONSTRAINTS.map((record) => ({ ...record }));
    const bundleOf = (records) =>
      season2026SeasonInputs({
        schedule,
        facilityInput,
        timingInput,
        calendarInput,
        constraints: records,
        venueComplexes,
        id: 'gate-and-write-baseline',
      });
    const bundle = bundleOf(owned);
    const branch = season2026VenueUnavailableScenario({
      venueId: WITHDRAWN.venueId,
      baselineId: bundle.id,
      requestedBy: REQUESTED_BY,
      at: REQUESTED_AT,
      dates: [WITHDRAWN.dates[0]],
    });
    const memo = new ScenarioMemo();
    // One question, cached at the old fingerprint.
    memo.resolve(bundle, branch, { ...runOptions, relocations: false });

    const moved = bundleOf(
      owned.map((record, index) =>
        index === 0 ? { ...record, rationale: `${record.rationale} (corrected)` } : record
      )
    );
    expect(moved.digest).not.toBe(bundle.digest);

    // A second question, derived at the *new* fingerprint. It is live.
    const first = memo.resolve(moved, branch, runOptions);
    expect(memo.check(moved, branch)).toEqual([]);
    expect(memo.resolve(moved, branch, runOptions)).toBe(first);
    expect(memo.hits).toBe(1);
    expect(memo.misses).toBe(2);
  });
});

/* -------------------------------------------------------------------------- */
/* The digest class, closed: covered by construction rather than by a list      */
/* -------------------------------------------------------------------------- */

describe('the digest covers the bundle by construction, not by an allowlist', () => {
  /**
   * **Three review rounds found the same defect on this one function.** The
   * memo key ignored the run options; then the baseline digest omitted the
   * `schedule`, the `calendarOptions` and the `venueComplexes`; then it covered
   * `schedule.games` and omitted the `commitments`, the `teams`, the four
   * universes and the `placeholderLabels` — every one of them read by the rule
   * engine. Each round closed the instance by naming the fields somebody had
   * noticed, which is why there was a next round.
   *
   * These tests do not check the third instance. They walk **the live objects**
   * — the season-2026 bundle and its `Schedule` — perturb every enumerable
   * field in turn, and assert the digest moves for each one. Nothing here is
   * enumerated from a list; a field added to either structure next year is
   * walked without this file being edited, and a field the digest cannot see
   * fails here rather than in a fourth review.
   */
  const PROBE = '__digest-probe__';

  /**
   * The same value, **definitely** changed.
   *
   * The trap this exists to avoid: perturbing a field to an equal value, or to
   * one the digest legitimately canonicalises away (a different key *order*,
   * say), reports a false failure. Every perturbation below adds something no
   * corpus row carries, and the walk asserts the change is real before it
   * asserts anything about the digest.
   *
   * @param {unknown} value
   * @returns {unknown}
   */
  function perturbed(value) {
    if (Array.isArray(value)) return [...value, PROBE];
    if (value !== null && typeof value === 'object') {
      return { .../** @type {Record<string, unknown>} */ (value), [PROBE]: 1 };
    }
    if (typeof value === 'string') return `${value}${PROBE}`;
    if (typeof value === 'number') return value + 1;
    if (typeof value === 'boolean') return !value;
    // `null` and `undefined`: a field that holds nothing is perturbed to a
    // field that holds something. Nothing is skipped silently — if a future
    // field cannot be perturbed meaningfully it has to be named here, with the
    // reason, rather than falling out of the walk.
    return PROBE;
  }

  /**
   * Walk one object's own enumerable fields and report which ones the digest
   * did not notice.
   *
   * @param {Record<string, unknown>} subject - the live object, never a list of names
   * @param {(probe: Record<string, unknown>) => Object} rebuild - the bundle around it
   * @param {(bundle: Object) => string} digestOf
   * @returns {{ visited: string[], unmoved: string[] }}
   */
  function walk(subject, rebuild, digestOf) {
    /** @type {string[]} */
    const visited = [];
    /** @type {string[]} */
    const unmoved = [];
    const before = digestOf(rebuild(subject));
    for (const field of Object.keys(subject)) {
      const probe = { ...subject, [field]: perturbed(subject[field]) };
      expect(probe[field], `the perturbation of "${field}" is not a change`).not.toEqual(
        subject[field]
      );
      visited.push(field);
      if (digestOf(rebuild(probe)) === before) unmoved.push(field);
    }
    return { visited, unmoved };
  }

  /**
   * The meta-assertion `CLAUDE.md` §3 demands, as a function so its own failing
   * case can be constructed rather than described.
   *
   * @param {string[]} visited
   * @param {number} floor
   */
  function assertPlausibleWalk(visited, floor) {
    expect(visited.length, `the walk visited ${visited.length} field(s)`).toBeGreaterThanOrEqual(
      floor
    );
  }

  it('moves for every enumerable field of the bundle, save the ones the deny-list names', () => {
    const { visited, unmoved } = walk(
      /** @type {any} */ (inputs),
      (probe) => probe,
      seasonInputsDigest
    );
    // The meta-assertion: the walk saw every key the live bundle has, and a
    // plausible number of them.
    assertPlausibleWalk(visited, Object.keys(inputs).length);
    expect(visited.length).toBeGreaterThan(10);
    // The only fields a perturbation may leave the digest standing on are the
    // ones the deny-list names — **exactly** those, so adding a field to the
    // deny-list is a decision this test makes somebody write down.
    expect([...unmoved].sort()).toEqual(Object.keys(SCENARIO_DIGEST_EXCLUSIONS).sort());
  });

  it('moves for every enumerable field of the Schedule, and excludes none of them', () => {
    const { visited, unmoved } = walk(
      /** @type {any} */ (schedule),
      (probe) => ({ ...inputs, schedule: probe }),
      seasonInputsDigest
    );
    assertPlausibleWalk(visited, Object.keys(schedule).length);
    expect(unmoved).toEqual([]);
    // Not the source of the walk — a floor under it, naming what round three
    // left uncovered. The walk itself is reflection over the live schedule.
    expect(visited).toEqual(
      expect.arrayContaining([
        'commitments',
        'teams',
        'teamUniverse',
        'personUniverse',
        'divisionUniverse',
        'surfaceUniverse',
        'placeholderLabels',
      ])
    );
  });

  it('fails against the allowlist digest it replaced — the walk is not vacuous', () => {
    // **The falsification.** The same walk, over round three's own subject:
    // the six record sets, the two engine inputs, the sunsets, the calendar
    // options, the complexes, and `schedule.games`. It has to report the fields
    // that digest reached past, or the two tests above pass for the wrong
    // reason.
    const roundThree = (bundle) =>
      recordDigest(
        {
          .../** @type {any} */ (recordsOf(bundle)),
          schedule: bundle.schedule.games,
          facilityInput: [bundle.facilityInput],
          timingInput: [bundle.timingInput],
          sunsets: bundle.sunsets,
          calendarOptions: [bundle.calendarOptions],
          venueComplexes: [bundle.venueComplexes],
        },
        [
          'schedule',
          'facilityInput',
          'timingInput',
          ...SCENARIO_RECORD_SET_ORDER,
          'sunsets',
          'calendarOptions',
          'venueComplexes',
        ]
      );

    const { visited, unmoved } = walk(
      /** @type {any} */ (schedule),
      (probe) => ({ ...inputs, schedule: probe }),
      roundThree
    );
    assertPlausibleWalk(visited, Object.keys(schedule).length);
    expect(unmoved.length).toBeGreaterThan(0);
    expect([...unmoved].sort()).toEqual(
      [...Object.keys(schedule)].filter((field) => field !== 'games').sort()
    );
    // …and the one field it did cover is still covered by the digest that
    // replaced it, so this is a widening rather than a swap.
    expect(unmoved).not.toContain('games');
  });

  it('counts the fields it walked, and that count is an assertion that can fail', () => {
    // The constructed failing case for the meta-assertion above: the identical
    // walk over an object with no enumerable fields visits nothing, and the
    // check refuses it rather than passing quietly.
    const empty = walk({}, (probe) => ({ ...inputs, ...probe }), seasonInputsDigest);
    expect(empty.visited).toEqual([]);
    expect(empty.unmoved).toEqual([]);
    expect(() => assertPlausibleWalk(empty.visited, 1)).toThrow();
    // …and it passes for the live objects, which is the only reason the walks
    // above are evidence of anything.
    expect(() => assertPlausibleWalk(Object.keys(inputs), 1)).not.toThrow();
  });

  it('separates bundles the third round’s digest could not tell apart', () => {
    // The two cases named in the finding, on this corpus: every team removed,
    // and one extra travel commitment. Both digested identically before.
    const base = seasonInputsDigest(inputs);
    expect(seasonInputsDigest({ ...inputs, schedule: { ...schedule, teams: [] } })).not.toBe(base);
    const extraCommitment = {
      ...schedule.commitments[0],
      id: `${schedule.commitments[0].id}-a-second-coach-travelling`,
    };
    expect(
      seasonInputsDigest({
        ...inputs,
        schedule: { ...schedule, commitments: [...schedule.commitments, extraCommitment] },
      })
    ).not.toBe(base);
  });

  it('states a reason for every field it does not cover, and refuses one it cannot render', () => {
    for (const [field, reason] of Object.entries(SCENARIO_DIGEST_EXCLUSIONS)) {
      // A deny-list entry for a field the bundle does not have is a reason
      // nobody has read since the field was deleted.
      expect(Object.keys(inputs), field).toContain(field);
      expect(reason.length, `"${field}" is excluded without a stated reason`).toBeGreaterThan(40);
    }
    // A field the digest cannot render — a cache, a back-reference, a function
    // — is a loud failure rather than a silent `null`, so it is named in the
    // deny-list deliberately or not at all.
    expect(() => seasonInputsDigest(/** @type {any} */ ({ ...inputs, cache: () => 1 }))).toThrow(
      /is a function/
    );
  });
});

/* -------------------------------------------------------------------------- */
/* A child refining a parent's withdrawal is composition, not a contradiction  */
/* -------------------------------------------------------------------------- */

describe('the duplicate-venue conflict fires within one author, not down a chain', () => {
  /** The parent: one date withdrawn. */
  const narrow = season2026VenueUnavailableScenario({
    venueId: WITHDRAWN.venueId,
    baselineId: inputs.id,
    requestedBy: REQUESTED_BY,
    at: REQUESTED_AT,
    id: 'parent-narrows',
    dates: [WITHDRAWN.dates[0]],
  });

  /** The child: the same venue, the parent's date and one more. */
  const broad = season2026VenueUnavailableScenario({
    venueId: WITHDRAWN.venueId,
    baselineId: inputs.id,
    requestedBy: REQUESTED_BY,
    at: REQUESTED_AT,
    id: 'child-broadens',
    parentScenarioId: narrow.id,
    dates: [WITHDRAWN.dates[0], WITHDRAWN.dates[1]],
  });

  it('applies a child’s broader withdrawal of the venue its parent narrowed', () => {
    // **The defect this exists to catch**, introduced by round two's own fix.
    // The duplicate was claimed over `composedOverrides()`, so the *inherited*
    // withdrawal counted as one of the two authors: the child's own override
    // was refused at blocking and skipped, the branch materialised its parent's
    // narrower withdrawal, and the message read `two overrides of
    // "child-broadens"` for an edit the parent wrote.
    const materialised = materialiseScenario(inputs, broad, { ancestry: [narrow] });
    expect(codesOf(materialised.findings)).not.toContain(
      SCENARIO_REASON.SCENARIO_OVERRIDE_CONFLICT
    );
    expect(materialised.status).not.toBe(SCENARIO_STATUS.REJECTED);
    expect(materialised.meta.overridesDeclared).toBe(2);
    expect(materialised.meta.overridesApplied).toBe(2);
    // Both authors' days are blacked out — the child's second date is present,
    // which is exactly what the refused override used to lose.
    const blackoutDates = new Set(
      materialised.records[SCENARIO_RECORD_SET.PERMITS]
        .filter((row) => String(row.id).startsWith(`${SCENARIO_OVERRIDE_KIND.VENUE_UNAVAILABLE}:`))
        .map((row) => row.date)
    );
    expect(blackoutDates.has(WITHDRAWN.dates[0])).toBe(true);
    expect(blackoutDates.has(WITHDRAWN.dates[1])).toBe(true);
  });

  it('still refuses two withdrawals of one venue written in one scenario', () => {
    // Round two's fix, intact. Both overrides here have the same author, and
    // their date scopes overlap, so the second one still silently replaces the
    // first one's reason on every row it lays — the contradiction stands.
    const oneAuthor = makeScenario({
      id: 'withdrawn-twice-in-one-branch',
      name: 'one branch, two withdrawals of one venue',
      baselineId: inputs.id,
      parentScenarioId: null,
      rationale: 'the regression that must survive the ancestry fix',
      requestedBy: REQUESTED_BY,
      createdAt: REQUESTED_AT,
      overrides: [
        {
          kind: SCENARIO_OVERRIDE_KIND.VENUE_UNAVAILABLE,
          venueId: WITHDRAWN.venueId,
          dates: [WITHDRAWN.dates[0]],
          by: 'groundskeeper@club.example',
          at: REQUESTED_AT,
          reason: 'the drainage works overran',
        },
        {
          kind: SCENARIO_OVERRIDE_KIND.VENUE_UNAVAILABLE,
          venueId: WITHDRAWN.venueId,
          dates: [WITHDRAWN.dates[0], WITHDRAWN.dates[1]],
          by: 'registrar@club.example',
          at: REQUESTED_AT,
          reason: 'the permit lapsed',
        },
      ],
    });
    const materialised = materialiseScenario(inputs, oneAuthor);
    const conflict = materialised.findings.find(
      (finding) => finding.code === SCENARIO_REASON.SCENARIO_OVERRIDE_CONFLICT
    );
    expect(conflict).toBeDefined();
    expect(conflict?.severity).toBe(CONSTRAINT_SEVERITY.BLOCKING);
    // The finding names the author it is about, which under the defect was
    // whichever scenario was being materialised.
    expect(conflict?.details.authoredBy).toBe(oneAuthor.id);
    expect(conflict?.message).toContain(`two overrides of "${oneAuthor.id}"`);
    expect(materialised.meta.overridesApplied).toBe(1);
  });

  it('still composes a parent and a child naming disjoint dates', () => {
    const elsewhere = season2026VenueUnavailableScenario({
      venueId: WITHDRAWN.venueId,
      baselineId: inputs.id,
      requestedBy: REQUESTED_BY,
      at: REQUESTED_AT,
      id: 'child-elsewhere',
      parentScenarioId: narrow.id,
      dates: [WITHDRAWN.dates[1]],
    });
    const materialised = materialiseScenario(inputs, elsewhere, { ancestry: [narrow] });
    expect(codesOf(materialised.findings)).not.toContain(
      SCENARIO_REASON.SCENARIO_OVERRIDE_CONFLICT
    );
    expect(materialised.meta.overridesApplied).toBe(2);
  });
});

describe('the record-id claim fires within one author, not down a chain', () => {
  /**
   * A constraint carrying no type-change history of its own, so "the history
   * grew by exactly two" is a statement about this chain rather than about the
   * corpus's own recorded decisions.
   */
  const REBUKED = untouchedHardConstraint(registry.constraints);

  /** A permit row for ground the schedule never stands on, added then withdrawn. */
  const INTERLOPER = 'parent-added-blackout';

  /**
   * The parent: softens one constraint, and adds one permit row.
   *
   * **Built when a test asks for it, never in the `describe` body.** Every one
   * of these reads `REBUKED.id`, so building them here dereferenced the
   * selection at collection time and `expect(REBUKED).toBeDefined()` below
   * could never be reached to report — a corpus holding no such record failed
   * as a `TypeError` from the collector instead. `CLAUDE.md` §3: a check you
   * cannot make fail is not a check.
   */
  const parent = () =>
    makeScenario({
      id: 'parent-softens',
      name: 'what if this rule were a preference?',
      baselineId: inputs.id,
      rationale: 'the parent whose edits a child refines',
      requestedBy: REQUESTED_BY,
      createdAt: REQUESTED_AT,
      overrides: [
        {
          kind: SCENARIO_OVERRIDE_KIND.RETYPE,
          recordSet: SCENARIO_RECORD_SET.CONSTRAINTS,
          recordId: /** @type {any} */ (REBUKED).id,
          type: CONSTRAINT_TYPE.SOFT,
          weight: 5,
          by: 'board@club.example',
          at: REQUESTED_AT,
          reason: 'the board asked what this rule costs as a soft constraint',
        },
        {
          kind: SCENARIO_OVERRIDE_KIND.ADD,
          recordSet: SCENARIO_RECORD_SET.PERMITS,
          record: {
            id: INTERLOPER,
            venueId: unusedVenueId(),
            scopeKind: 'weekday-default',
            weekday: 'SAT',
            date: null,
            hasPermit: false,
            openMinutes: null,
            closeMinutes: null,
            lit: null,
            lightsOffMinutes: null,
            note: 'ground the parent withdrew',
            source: 'test',
          },
          by: 'board@club.example',
          at: REQUESTED_AT,
          reason: 'withdraw ground the schedule never stands on',
        },
      ],
    });

  /** The child: hardens the constraint back, and withdraws the parent's row. */
  const child = () =>
    makeScenario({
      id: 'child-supersedes',
      name: 'the board changed its mind',
      baselineId: inputs.id,
      parentScenarioId: 'parent-softens',
      rationale: 'the branch that refines its parent rather than contradicting a stranger',
      requestedBy: REQUESTED_BY,
      createdAt: REQUESTED_AT,
      overrides: [
        {
          kind: SCENARIO_OVERRIDE_KIND.RETYPE,
          recordSet: SCENARIO_RECORD_SET.CONSTRAINTS,
          recordId: /** @type {any} */ (REBUKED).id,
          type: CONSTRAINT_TYPE.HARD,
          weight: null,
          by: 'registrar@club.example',
          at: REQUESTED_AT,
          reason: 'the softening was reviewed and reversed',
        },
        {
          kind: SCENARIO_OVERRIDE_KIND.REMOVE,
          recordSet: SCENARIO_RECORD_SET.PERMITS,
          recordId: INTERLOPER,
          by: 'registrar@club.example',
          at: REQUESTED_AT,
          reason: 'the ground came back',
        },
      ],
    });

  it('applies a child’s edit to a record its parent also touched', () => {
    // **The defect this exists to catch**, the same shape one kind over from
    // the duplicate-venue claim above. The record-id claim was taken across
    // `composedOverrides()`, so the *inherited* edit counted as one of the two
    // overrides: the child's own edit was refused at blocking, skipped, and the
    // branch materialised its parent's edit while the message read `two
    // overrides of "child-supersedes"` for an edit the parent wrote.
    expect(REBUKED).toBeDefined();
    const materialised = materialiseScenario(inputs, child(), { ancestry: [parent()] });
    expect(codesOf(materialised.findings)).not.toContain(
      SCENARIO_REASON.SCENARIO_OVERRIDE_CONFLICT
    );
    expect(materialised.status).not.toBe(SCENARIO_STATUS.REJECTED);
    expect(materialised.meta.overridesDeclared).toBe(4);
    expect(materialised.meta.overridesApplied).toBe(4);

    // The **records**, not merely the findings: the child's retype is the one
    // that stands, over the parent's, and both are in the record's history in
    // ancestry order.
    const record = materialised.engines.registry.byId[/** @type {any} */ (REBUKED).id];
    expect(record.type).toBe(CONSTRAINT_TYPE.HARD);
    expect(record.weight).toBe(null);
    expect(record.history.map((entry) => [entry.from, entry.to])).toEqual([
      [CONSTRAINT_TYPE.HARD, CONSTRAINT_TYPE.SOFT],
      [CONSTRAINT_TYPE.SOFT, CONSTRAINT_TYPE.HARD],
    ]);
    expect(materialised.meta.recordsRetyped).toBe(2);

    // …and the child's withdrawal of the row its parent added actually
    // happened, which is what the refused override used to lose.
    const permitIds = materialised.records[SCENARIO_RECORD_SET.PERMITS].map((row) =>
      String(row.id)
    );
    expect(permitIds).not.toContain(INTERLOPER);
    // Meta-assertion: the parent's add is what put the row there in the first
    // place, so "absent" is a withdrawal rather than a row that never existed.
    expect(
      materialiseScenario(inputs, parent()).records[SCENARIO_RECORD_SET.PERMITS].map((row) =>
        String(row.id)
      )
    ).toContain(INTERLOPER);
  });

  it('still refuses two edits of one record written in one scenario', () => {
    // The contradiction that must survive the fix: one author, one record id,
    // two edits, with no consultation at which one could beat the other.
    const victim = String(inputs.permits[0].id);
    const oneAuthor = makeScenario({
      id: 'edited-twice-in-one-branch',
      name: 'one branch, two edits of one record',
      baselineId: inputs.id,
      parentScenarioId: null,
      rationale: 'the regression that must survive the ancestry fix',
      requestedBy: REQUESTED_BY,
      createdAt: REQUESTED_AT,
      overrides: [
        {
          kind: SCENARIO_OVERRIDE_KIND.REMOVE,
          recordSet: SCENARIO_RECORD_SET.PERMITS,
          recordId: victim,
          by: 'groundskeeper@club.example',
          at: REQUESTED_AT,
          reason: 'the permit was withdrawn',
        },
        {
          kind: SCENARIO_OVERRIDE_KIND.REMOVE,
          recordSet: SCENARIO_RECORD_SET.PERMITS,
          recordId: victim,
          by: 'registrar@club.example',
          at: REQUESTED_AT,
          reason: 'the permit was withdrawn again',
        },
      ],
    });
    const materialised = materialiseScenario(inputs, oneAuthor);
    const conflict = materialised.findings.find(
      (finding) => finding.code === SCENARIO_REASON.SCENARIO_OVERRIDE_CONFLICT
    );
    expect(conflict).toBeDefined();
    expect(conflict?.severity).toBe(CONSTRAINT_SEVERITY.BLOCKING);
    expect(conflict?.details.recordId).toBe(victim);
    // The finding names the author it is about, which under the defect was
    // whichever scenario was being materialised.
    expect(conflict?.details.authoredBy).toBe(oneAuthor.id);
    expect(conflict?.message).toContain(`two overrides of "${oneAuthor.id}"`);
    expect(materialised.meta.recordsRemoved).toBe(1);
  });

  it('names the author when the two edits are an ancestor’s own, not the branch’s', () => {
    // A parent contradicting *itself*, materialised under a child. The finding
    // is the parent's, and said so nowhere before: both the message and the
    // details attributed it to the branch being materialised.
    const victim = String(inputs.permits[0].id);
    const selfContradicting = makeScenario({
      id: 'parent-contradicts-itself',
      name: 'a parent that removes one row twice',
      baselineId: inputs.id,
      rationale: 'the misattribution this exists to catch',
      requestedBy: REQUESTED_BY,
      createdAt: REQUESTED_AT,
      overrides: [
        {
          kind: SCENARIO_OVERRIDE_KIND.REMOVE,
          recordSet: SCENARIO_RECORD_SET.PERMITS,
          recordId: victim,
          by: 'groundskeeper@club.example',
          at: REQUESTED_AT,
          reason: 'the permit was withdrawn',
        },
        {
          kind: SCENARIO_OVERRIDE_KIND.REMOVE,
          recordSet: SCENARIO_RECORD_SET.PERMITS,
          recordId: victim,
          by: 'registrar@club.example',
          at: REQUESTED_AT,
          reason: 'the permit was withdrawn again',
        },
      ],
    });
    const heir = makeScenario({
      id: 'heir',
      name: 'the branch that inherits a contradiction',
      baselineId: inputs.id,
      parentScenarioId: selfContradicting.id,
      rationale: 'it states an edit of its own, elsewhere',
      requestedBy: REQUESTED_BY,
      createdAt: REQUESTED_AT,
      overrides: [
        {
          kind: SCENARIO_OVERRIDE_KIND.REMOVE,
          recordSet: SCENARIO_RECORD_SET.PERMITS,
          recordId: String(inputs.permits[1].id),
          by: REQUESTED_BY,
          at: REQUESTED_AT,
          reason: 'a row of the heir’s own',
        },
      ],
    });
    const materialised = materialiseScenario(inputs, heir, { ancestry: [selfContradicting] });
    const conflict = materialised.findings.find(
      (finding) => finding.code === SCENARIO_REASON.SCENARIO_OVERRIDE_CONFLICT
    );
    expect(conflict).toBeDefined();
    expect(conflict?.details.authoredBy).toBe(selfContradicting.id);
    expect(conflict?.details.scenarioId).toBe(heir.id);
    expect(conflict?.message).toContain(`two overrides of "${selfContradicting.id}"`);
  });

  it('the selection this suite rests on is a check that can fail', () => {
    // **The unreachable meta-assertion**, made reachable and then proven.
    // `expect(REBUKED).toBeDefined()` above could never run: `REBUKED.id` was
    // read while building `parent` and `child` in the `describe` body, so a
    // corpus holding no such constraint failed at *collection* with
    // `TypeError: Cannot read properties of undefined (reading 'id')` and the
    // assertion never got the chance to report. The scenarios are built inside
    // the tests now — and here is the identical selection over a corpus that
    // holds no matching record, with the assertion itself doing the reporting.
    const historied = registry.constraints.map((record) => ({
      ...record,
      history: [
        {
          from: CONSTRAINT_TYPE.HARD,
          to: CONSTRAINT_TYPE.SOFT,
          at: null,
          by: 'nobody@club.example',
          note: 'a recorded decision, so the selection matches nothing',
        },
      ],
    }));
    expect(untouchedHardConstraint(historied)).toBeUndefined();
    expect(() => expect(untouchedHardConstraint(historied)).toBeDefined()).toThrowError(
      /expected undefined to be defined/i
    );
    // …and the corpus this suite actually runs over does hold one, so the
    // assertion above is satisfied rather than vacuous.
    expect(REBUKED).toBeDefined();
  });
});

/* -------------------------------------------------------------------------- */
/* a retype and a withdrawal of one constraint, down a chain                   */
/* -------------------------------------------------------------------------- */

describe('a retype whose constraint something else withdraws', () => {
  const RETYPED = untouchedHardConstraint(registry.constraints);

  /** The ancestor: softens one constraint, and states nothing else. */
  const softens = () =>
    makeScenario({
      id: 'ancestor-softens',
      name: 'what if this rule were a preference?',
      baselineId: inputs.id,
      rationale: 'the ancestor whose retype a descendant leaves nowhere to land',
      requestedBy: REQUESTED_BY,
      createdAt: REQUESTED_AT,
      overrides: [
        {
          kind: SCENARIO_OVERRIDE_KIND.RETYPE,
          recordSet: SCENARIO_RECORD_SET.CONSTRAINTS,
          recordId: /** @type {any} */ (RETYPED).id,
          type: CONSTRAINT_TYPE.SOFT,
          weight: 5,
          by: 'board@club.example',
          at: REQUESTED_AT,
          reason: 'the board asked what this rule costs as a soft constraint',
        },
      ],
    });

  /** The descendant: withdraws the very constraint its ancestor softened. */
  const withdraws = () =>
    makeScenario({
      id: 'descendant-withdraws',
      name: 'the rule goes altogether',
      baselineId: inputs.id,
      parentScenarioId: 'ancestor-softens',
      rationale: 'the branch whose withdrawal the ancestor’s retype cannot survive',
      requestedBy: REQUESTED_BY,
      createdAt: REQUESTED_AT,
      overrides: [
        {
          kind: SCENARIO_OVERRIDE_KIND.REMOVE,
          recordSet: SCENARIO_RECORD_SET.CONSTRAINTS,
          recordId: /** @type {any} */ (RETYPED).id,
          by: 'registrar@club.example',
          at: REQUESTED_AT,
          reason: 'the rule was struck out entirely',
        },
      ],
    });

  it('reports the combination rather than throwing out of the registry', () => {
    // **The defect this exists to catch.** Keying the record-id claim on the
    // authoring scenario let an ancestor's retype and a descendant's remove of
    // one constraint both apply. Retypes are deferred until after the registry
    // is built, so by then the record had been spliced out of the working array
    // and out of the registry, and `requireConstraint()` threw
    // `constraints: no constraint "…" in the registry` out of
    // `materialiseScenario()` — which returns findings for every other
    // incoherent branch, and which `runScenario()` does not catch.
    expect(RETYPED).toBeDefined();
    const ancestor = softens();
    const materialised = materialiseScenario(inputs, withdraws(), { ancestry: [ancestor] });
    const finding = materialised.findings.find(
      (entry) => entry.code === SCENARIO_REASON.SCENARIO_OVERRIDE_RETYPE_WITHDRAWN
    );
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe(CONSTRAINT_SEVERITY.BLOCKING);
    expect(materialised.status).toBe(SCENARIO_STATUS.REJECTED);
    // Both authors are named: the one whose withdrawal is refused, and the one
    // whose retype is already queued against the record.
    expect(finding?.details.recordId).toBe(/** @type {any} */ (RETYPED).id);
    expect(finding?.details.authoredBy).toBe('descendant-withdraws');
    expect(finding?.details.retypedBy).toBe(ancestor.id);
    // The withdrawal is refused rather than applied, so the retype still lands
    // in the record's own history and no `SCENARIO_OVERRIDE_APPLIED` claims a
    // removal that did not happen.
    expect(materialised.meta.recordsRemoved).toBe(0);
    expect(
      materialised.findings.filter(
        (entry) =>
          entry.code === SCENARIO_REASON.SCENARIO_OVERRIDE_APPLIED &&
          entry.details.operation === SCENARIO_OVERRIDE_KIND.REMOVE
      )
    ).toEqual([]);
    const record = materialised.engines.registry.byId[/** @type {any} */ (RETYPED).id];
    expect(record).toBeDefined();
    expect(record.type).toBe(CONSTRAINT_TYPE.SOFT);
    expect(record.history).toHaveLength(1);
  });

  it('carries the report out through runScenario() instead of crashing it', () => {
    // `runScenario()` catches nothing the materialiser throws, so the crash
    // reached its caller as an exception where every other incoherent branch
    // reaches it as a rejected result.
    const ancestor = softens();
    const ran = runScenario(inputs, withdraws(), {
      ...runOptions,
      relocations: false,
      ancestry: [ancestor],
    });
    expect(codesOf(ran.findings)).toContain(SCENARIO_REASON.SCENARIO_OVERRIDE_RETYPE_WITHDRAWN);
    expect(ran.status).toBe(SCENARIO_STATUS.REJECTED);
  });

  it('still refuses a retype of a record only a later override adds', () => {
    // The first mirror case, and it lands somewhere else: the retype is claimed
    // before the add runs, so at that moment the registry genuinely does not
    // hold the record and this is the ordinary missing-target refusal.
    const invented = 'a-constraint-the-baseline-never-had';
    const ancestor = makeScenario({
      id: 'ancestor-retypes-nothing',
      name: 'retype a rule nobody has written yet',
      baselineId: inputs.id,
      rationale: 'the mirror of the withdrawal case',
      requestedBy: REQUESTED_BY,
      createdAt: REQUESTED_AT,
      overrides: [
        {
          kind: SCENARIO_OVERRIDE_KIND.RETYPE,
          recordSet: SCENARIO_RECORD_SET.CONSTRAINTS,
          recordId: invented,
          type: CONSTRAINT_TYPE.SOFT,
          weight: 5,
          by: 'board@club.example',
          at: REQUESTED_AT,
          reason: 'soften a rule the branch below has not added yet',
        },
      ],
    });
    const heir = makeScenario({
      id: 'descendant-adds-it',
      name: 'and here is the rule',
      baselineId: inputs.id,
      parentScenarioId: ancestor.id,
      rationale: 'the add that arrives after the retype that names it',
      requestedBy: REQUESTED_BY,
      createdAt: REQUESTED_AT,
      overrides: [
        {
          kind: SCENARIO_OVERRIDE_KIND.ADD,
          recordSet: SCENARIO_RECORD_SET.CONSTRAINTS,
          record: { .../** @type {any} */ (RETYPED), id: invented },
          by: 'registrar@club.example',
          at: REQUESTED_AT,
          reason: 'the rule the retype above names',
        },
      ],
    });
    const materialised = materialiseScenario(inputs, heir, { ancestry: [ancestor] });
    const missing = materialised.findings.find(
      (entry) => entry.code === SCENARIO_REASON.SCENARIO_OVERRIDE_TARGET_MISSING
    );
    expect(missing).toBeDefined();
    expect(missing?.details.recordId).toBe(invented);
    expect(missing?.details.authoredBy).toBe(ancestor.id);
    // The add still happens, and it lands unretyped — the retype is refused,
    // never queued against a record it was not written for.
    const added = materialised.engines.registry.byId[invented];
    expect(added).toBeDefined();
    expect(added.type).toBe(CONSTRAINT_TYPE.HARD);
    expect(materialised.meta.recordsRetyped).toBe(0);
  });

  it('still refuses a retype whose record is withdrawn and then re-added', () => {
    // The second mirror case. It needs three links: a remove and an add of one
    // id written by one author is the record-id conflict, one describe up.
    const ancestor = softens();
    const middle = withdraws();
    const heir = makeScenario({
      id: 'grandchild-restores',
      name: 'put the rule back',
      baselineId: inputs.id,
      parentScenarioId: middle.id,
      rationale: 'the branch that re-adds what the middle link struck out',
      requestedBy: REQUESTED_BY,
      createdAt: REQUESTED_AT,
      overrides: [
        {
          kind: SCENARIO_OVERRIDE_KIND.ADD,
          recordSet: SCENARIO_RECORD_SET.CONSTRAINTS,
          record: { .../** @type {any} */ (RETYPED) },
          by: 'chair@club.example',
          at: REQUESTED_AT,
          reason: 'the rule was reinstated',
        },
      ],
    });
    const materialised = materialiseScenario(inputs, heir, { ancestry: [ancestor, middle] });
    // The withdrawal is refused, so the record never leaves — and the re-add
    // therefore collides with the baseline's own row rather than with an
    // ancestor's, which is what the collision message must say.
    expect(codesOf(materialised.findings)).toContain(
      SCENARIO_REASON.SCENARIO_OVERRIDE_RETYPE_WITHDRAWN
    );
    const collides = materialised.findings.find(
      (entry) => entry.code === SCENARIO_REASON.SCENARIO_OVERRIDE_ID_COLLIDES
    );
    expect(collides).toBeDefined();
    expect(collides?.message).toContain('the baseline already holds');
    expect(collides?.details.precededBy).toBe(null);
    // The retype is written once, into the record the ancestor named.
    expect(materialised.meta.recordsRetyped).toBe(1);
    expect(materialised.engines.registry.byId[/** @type {any} */ (RETYPED).id].type).toBe(
      CONSTRAINT_TYPE.SOFT
    );
  });
});

/* -------------------------------------------------------------------------- */
/* a missing target and a colliding id say whose edit made it so               */
/* -------------------------------------------------------------------------- */

describe('a finding that blames the baseline blames the right thing', () => {
  const VICTIM = String(inputs.permits[0].id);
  const COLLIDER = 'ancestor-added-blackout';

  /** A permit row the corpus does not hold, for ground it never stands on. */
  const interloper = () => ({
    id: COLLIDER,
    venueId: unusedVenueId(),
    scopeKind: 'weekday-default',
    weekday: 'SAT',
    date: null,
    hasPermit: false,
    openMinutes: null,
    closeMinutes: null,
    lit: null,
    lightsOffMinutes: null,
    note: 'ground the ancestor withdrew',
    source: 'test',
  });

  /** The ancestor: withdraws one baseline row, and adds one of its own. */
  const ancestor = makeScenario({
    id: 'ancestor-edits',
    name: 'one row out, one row in',
    baselineId: inputs.id,
    rationale: 'the ancestor whose edits the messages below must name',
    requestedBy: REQUESTED_BY,
    createdAt: REQUESTED_AT,
    overrides: [
      {
        kind: SCENARIO_OVERRIDE_KIND.REMOVE,
        recordSet: SCENARIO_RECORD_SET.PERMITS,
        recordId: VICTIM,
        by: 'groundskeeper@club.example',
        at: REQUESTED_AT,
        reason: 'the permit was withdrawn',
      },
      {
        kind: SCENARIO_OVERRIDE_KIND.ADD,
        recordSet: SCENARIO_RECORD_SET.PERMITS,
        record: interloper(),
        by: 'groundskeeper@club.example',
        at: REQUESTED_AT,
        reason: 'and this ground went dark',
      },
    ],
  });

  /** The descendant: states the same two edits over again. */
  const heir = makeScenario({
    id: 'descendant-repeats',
    name: 'the same two edits, one branch down',
    baselineId: inputs.id,
    parentScenarioId: ancestor.id,
    rationale: 'the branch whose edits the ancestor already made',
    requestedBy: REQUESTED_BY,
    createdAt: REQUESTED_AT,
    overrides: [
      {
        kind: SCENARIO_OVERRIDE_KIND.REMOVE,
        recordSet: SCENARIO_RECORD_SET.PERMITS,
        recordId: VICTIM,
        by: 'registrar@club.example',
        at: REQUESTED_AT,
        reason: 'the permit was withdrawn again',
      },
      {
        kind: SCENARIO_OVERRIDE_KIND.ADD,
        recordSet: SCENARIO_RECORD_SET.PERMITS,
        record: interloper(),
        by: 'registrar@club.example',
        at: REQUESTED_AT,
        reason: 'and this ground went dark again',
      },
    ],
  });

  it('says an ancestor withdrew the row, not that the baseline never held it', () => {
    // **The falsehood this exists to catch.** Keying the record-id claim on the
    // authoring scenario made `remove` the path an ancestor-vs-descendant edit
    // of one id lands on, and the message an operator then acts on said the
    // baseline does not hold the row. The baseline holds it; the ancestor
    // withdrew it, and nothing pointed at the ancestor.
    expect(inputs.permits.some((row) => String(row.id) === VICTIM)).toBe(true);
    const materialised = materialiseScenario(inputs, heir, { ancestry: [ancestor] });
    const missing = materialised.findings.find(
      (entry) => entry.code === SCENARIO_REASON.SCENARIO_OVERRIDE_TARGET_MISSING
    );
    expect(missing).toBeDefined();
    expect(missing?.severity).toBe(CONSTRAINT_SEVERITY.BLOCKING);
    expect(missing?.message).not.toContain('the baseline does not hold');
    expect(missing?.message).toContain(`"${ancestor.id}"`);
    expect(missing?.details.recordId).toBe(VICTIM);
    expect(missing?.details.authoredBy).toBe(heir.id);
    expect(missing?.details.precededBy).toBe(ancestor.id);
    expect(missing?.details.precedingReason).toBe('the permit was withdrawn');
  });

  it('says an ancestor added the id, not that the baseline already held it', () => {
    // The same falsehood one operation over.
    expect(inputs.permits.some((row) => String(row.id) === COLLIDER)).toBe(false);
    const materialised = materialiseScenario(inputs, heir, { ancestry: [ancestor] });
    const collides = materialised.findings.find(
      (entry) => entry.code === SCENARIO_REASON.SCENARIO_OVERRIDE_ID_COLLIDES
    );
    expect(collides).toBeDefined();
    expect(collides?.severity).toBe(CONSTRAINT_SEVERITY.BLOCKING);
    expect(collides?.message).not.toContain('the baseline already holds');
    expect(collides?.message).toContain(`"${ancestor.id}"`);
    expect(collides?.details.recordId).toBe(COLLIDER);
    expect(collides?.details.authoredBy).toBe(heir.id);
    expect(collides?.details.precededBy).toBe(ancestor.id);
    expect(collides?.details.precedingReason).toBe('and this ground went dark');
  });

  it('still blames the baseline when the baseline is what is wrong', () => {
    // The negative control for both messages: with no ancestor in the way the
    // wording is unchanged, and `precededBy` is null rather than a name.
    const alone = makeScenario({
      id: 'no-ancestor',
      name: 'a withdrawal and a collision against the baseline itself',
      baselineId: inputs.id,
      rationale: 'the control that keeps the baseline wording honest',
      requestedBy: REQUESTED_BY,
      createdAt: REQUESTED_AT,
      overrides: [
        {
          kind: SCENARIO_OVERRIDE_KIND.REMOVE,
          recordSet: SCENARIO_RECORD_SET.PERMITS,
          recordId: 'no-such-permit-row',
          by: REQUESTED_BY,
          at: REQUESTED_AT,
          reason: 'this record does not exist',
        },
        {
          kind: SCENARIO_OVERRIDE_KIND.ADD,
          recordSet: SCENARIO_RECORD_SET.PERMITS,
          record: { ...inputs.permits[1] },
          by: REQUESTED_BY,
          at: REQUESTED_AT,
          reason: 'an id the baseline already holds',
        },
      ],
    });
    const materialised = materialiseScenario(inputs, alone);
    const missing = materialised.findings.find(
      (entry) => entry.code === SCENARIO_REASON.SCENARIO_OVERRIDE_TARGET_MISSING
    );
    expect(missing?.message).toContain('the baseline does not hold');
    expect(missing?.details.precededBy).toBe(null);
    expect(missing?.details.authoredBy).toBe(alone.id);
    const collides = materialised.findings.find(
      (entry) => entry.code === SCENARIO_REASON.SCENARIO_OVERRIDE_ID_COLLIDES
    );
    expect(collides?.message).toContain('the baseline already holds');
    expect(collides?.details.precededBy).toBe(null);
    expect(collides?.details.authoredBy).toBe(alone.id);
  });

  it('names the ancestor whose derived withdrawal laid the row an add collides with', () => {
    // A `venue-unavailable`'s edits are derived, so they make no claim on a
    // record id — but they do lay rows, and an add that collides with one is
    // colliding with an ancestor's edit rather than with the baseline.
    const withdrawal = season2026VenueUnavailableScenario({
      venueId: WITHDRAWN.venueId,
      baselineId: inputs.id,
      requestedBy: REQUESTED_BY,
      at: REQUESTED_AT,
      id: 'ancestor-withdraws-a-venue',
      dates: [WITHDRAWN.dates[0]],
    });
    const blackoutId = `${SCENARIO_OVERRIDE_KIND.VENUE_UNAVAILABLE}:${WITHDRAWN.venueId}:${WITHDRAWN.dates[0]}`;
    const clasher = makeScenario({
      id: 'descendant-collides-with-a-blackout',
      name: 'an add on top of an inherited blackout row',
      baselineId: inputs.id,
      parentScenarioId: withdrawal.id,
      rationale: 'the collision that is an ancestor’s doing rather than the baseline’s',
      requestedBy: REQUESTED_BY,
      createdAt: REQUESTED_AT,
      overrides: [
        {
          kind: SCENARIO_OVERRIDE_KIND.ADD,
          recordSet: SCENARIO_RECORD_SET.PERMITS,
          record: { ...interloper(), id: blackoutId },
          by: 'registrar@club.example',
          at: REQUESTED_AT,
          reason: 'a row whose id the inherited withdrawal already laid',
        },
      ],
    });
    const materialised = materialiseScenario(inputs, clasher, { ancestry: [withdrawal] });
    expect(inputs.permits.some((row) => String(row.id) === blackoutId)).toBe(false);
    const collides = materialised.findings.find(
      (entry) => entry.code === SCENARIO_REASON.SCENARIO_OVERRIDE_ID_COLLIDES
    );
    expect(collides).toBeDefined();
    expect(collides?.message).not.toContain('the baseline already holds');
    expect(collides?.details.precededBy).toBe(withdrawal.id);
  });
});

/* -------------------------------------------------------------------------- */
/* what the baseline held is a fact about the baseline                         */
/* -------------------------------------------------------------------------- */

describe('a refusal reads baseline membership off the baseline, not off the last edit', () => {
  /**
   * A permit row for ground the schedule never stands on, so the chains below
   * change what the branch *holds* without changing what it *schedules*.
   *
   * @param {string} id
   */
  const strangerRow = (id) => ({
    id,
    venueId: unusedVenueId(),
    scopeKind: 'weekday-default',
    weekday: 'SAT',
    date: null,
    hasPermit: false,
    openMinutes: null,
    closeMinutes: null,
    lit: null,
    lightsOffMinutes: null,
    note: 'ground one link of the chain withdrew',
    source: 'test',
  });

  /**
   * One link of a chain, stated as ordinary scenario input.
   *
   * @param {string} id
   * @param {string|null} parentScenarioId
   * @param {Array<Object>} overrides
   */
  const link = (id, parentScenarioId, overrides) =>
    makeScenario({
      id,
      name: `chain link "${id}"`,
      baselineId: inputs.id,
      parentScenarioId,
      rationale: 'a link of the three-deep chain these refusals have to describe',
      requestedBy: REQUESTED_BY,
      createdAt: REQUESTED_AT,
      overrides,
    });

  /** @param {string} recordId @param {string} reason */
  const removeRow = (recordId, reason) => ({
    kind: SCENARIO_OVERRIDE_KIND.REMOVE,
    recordSet: SCENARIO_RECORD_SET.PERMITS,
    recordId,
    by: 'groundskeeper@club.example',
    at: REQUESTED_AT,
    reason,
  });

  /** @param {Object} record @param {string} reason */
  const addRow = (record, reason) => ({
    kind: SCENARIO_OVERRIDE_KIND.ADD,
    recordSet: SCENARIO_RECORD_SET.PERMITS,
    record,
    by: 'registrar@club.example',
    at: REQUESTED_AT,
    reason,
  });

  it('does not say the baseline holds a row the baseline never held', () => {
    // **The defect.** Three links: an ancestor *adds* a row the corpus does not
    // have, the next ancestor withdraws it, and the branch withdraws it again.
    // The last edit before the branch's is a `remove`, and the message inferred
    // "the baseline holds it" from that shape alone. The baseline never held
    // it — the first ancestor's `add` did — and an operator sent to the corpus
    // for this row finds nothing there to act on.
    const NEWCOMER = 'a-row-no-corpus-holds';
    expect(inputs.permits.some((row) => String(row.id) === NEWCOMER)).toBe(false);

    const adds = link('chain-adds', null, [
      addRow(strangerRow(NEWCOMER), 'this ground is now permitted'),
    ]);
    const withdraws = link('chain-withdraws', adds.id, [
      removeRow(NEWCOMER, 'and then it was withdrawn'),
    ]);
    const withdrawsAgain = link('chain-withdraws-again', withdraws.id, [
      removeRow(NEWCOMER, 'the branch withdraws it once more'),
    ]);

    // Meta-assertion: the row really is present after the first link and gone
    // after the second, so the third link's refusal is the one under test
    // rather than an edit that never happened.
    expect(
      materialiseScenario(inputs, adds).records[SCENARIO_RECORD_SET.PERMITS].map((row) =>
        String(row.id)
      )
    ).toContain(NEWCOMER);
    expect(
      materialiseScenario(inputs, withdraws, { ancestry: [adds] }).records[
        SCENARIO_RECORD_SET.PERMITS
      ].map((row) => String(row.id))
    ).not.toContain(NEWCOMER);

    const materialised = materialiseScenario(inputs, withdrawsAgain, {
      ancestry: [adds, withdraws],
    });
    const missing = materialised.findings.find(
      (entry) => entry.code === SCENARIO_REASON.SCENARIO_OVERRIDE_TARGET_MISSING
    );
    expect(missing).toBeDefined();
    expect(missing?.severity).toBe(CONSTRAINT_SEVERITY.BLOCKING);
    expect(missing?.message).not.toContain('the baseline holds');
    expect(missing?.message).toContain('the baseline never held');
    // The attribution is unchanged and still right: the row went missing
    // because the middle link withdrew it.
    expect(missing?.details.precededBy).toBe(withdraws.id);
    expect(missing?.details.precedingReason).toBe('and then it was withdrawn');
    expect(missing?.details.authoredBy).toBe(withdrawsAgain.id);
    expect(missing?.details.baselineHeld).toBe(false);
  });

  it('does not deny the baseline a row the baseline does hold', () => {
    // The mirror, and the same inference: the branch's `add` collides with a
    // row an ancestor *re-added* after another withdrew it, and "the baseline
    // never held it" was read off that `add`. The baseline holds this row —
    // it is one of the corpus's own permits.
    const VICTIM = String(inputs.permits[0].id);
    expect(inputs.permits.some((row) => String(row.id) === VICTIM)).toBe(true);

    const withdraws = link('chain-withdraws-a-corpus-row', null, [
      removeRow(VICTIM, 'the permit lapsed'),
    ]);
    const restores = link('chain-restores-it', withdraws.id, [
      addRow({ ...inputs.permits[0] }, 'the permit was renewed'),
    ]);
    const restoresAgain = link('chain-restores-it-again', restores.id, [
      addRow({ ...inputs.permits[0] }, 'the branch renews it once more'),
    ]);

    // Meta-assertion: the row is gone after the first link and back after the
    // second, so the third link's `add` really does land on a re-added row.
    expect(
      materialiseScenario(inputs, withdraws).records[SCENARIO_RECORD_SET.PERMITS].map((row) =>
        String(row.id)
      )
    ).not.toContain(VICTIM);
    expect(
      materialiseScenario(inputs, restores, { ancestry: [withdraws] }).records[
        SCENARIO_RECORD_SET.PERMITS
      ].map((row) => String(row.id))
    ).toContain(VICTIM);

    const materialised = materialiseScenario(inputs, restoresAgain, {
      ancestry: [withdraws, restores],
    });
    const collides = materialised.findings.find(
      (entry) => entry.code === SCENARIO_REASON.SCENARIO_OVERRIDE_ID_COLLIDES
    );
    expect(collides).toBeDefined();
    expect(collides?.severity).toBe(CONSTRAINT_SEVERITY.BLOCKING);
    expect(collides?.message).not.toContain('the baseline never held');
    expect(collides?.message).toContain('the baseline holds');
    expect(collides?.details.precededBy).toBe(restores.id);
    expect(collides?.details.precedingReason).toBe('the permit was renewed');
    expect(collides?.details.authoredBy).toBe(restoresAgain.id);
    expect(collides?.details.baselineHeld).toBe(true);
  });

  it('reports the retype that stands, not the first one queued', () => {
    // Two ancestors retype one constraint and the branch withdraws it. The
    // registry ends up carrying the *second* retype, so naming the first tells
    // the operator to go and argue with a decision nothing is holding.
    const RETYPED = untouchedHardConstraint(registry.constraints);
    expect(RETYPED).toBeDefined();
    const constraintId = /** @type {any} */ (RETYPED).id;

    /** @param {string} id @param {string|null} parent @param {string} type @param {number} weight @param {string} reason */
    const retyper = (id, parent, type, weight, reason) =>
      link(id, parent, [
        {
          kind: SCENARIO_OVERRIDE_KIND.RETYPE,
          recordSet: SCENARIO_RECORD_SET.CONSTRAINTS,
          recordId: constraintId,
          type,
          weight,
          by: 'board@club.example',
          at: REQUESTED_AT,
          reason,
        },
      ]);

    const first = retyper(
      'chain-softens',
      null,
      CONSTRAINT_TYPE.SOFT,
      5,
      'what does this rule cost as a soft constraint?'
    );
    const second = retyper(
      'chain-softens-further',
      first.id,
      CONSTRAINT_TYPE.PREFERENCE,
      2,
      'on reflection it is only a preference'
    );

    // Meta-assertion: the second retype is the one the registry ends up
    // carrying, which is what makes naming the first a false report.
    const bothRetypes = materialiseScenario(inputs, second, { ancestry: [first] });
    expect(bothRetypes.engines.registry.byId[constraintId].type).toBe(CONSTRAINT_TYPE.PREFERENCE);

    const strikesOut = link('chain-strikes-out', second.id, [
      {
        kind: SCENARIO_OVERRIDE_KIND.REMOVE,
        recordSet: SCENARIO_RECORD_SET.CONSTRAINTS,
        recordId: constraintId,
        by: 'registrar@club.example',
        at: REQUESTED_AT,
        reason: 'the rule was struck out',
      },
    ]);
    const materialised = materialiseScenario(inputs, strikesOut, {
      ancestry: [first, second],
    });
    const refused = materialised.findings.find(
      (entry) => entry.code === SCENARIO_REASON.SCENARIO_OVERRIDE_RETYPE_WITHDRAWN
    );
    expect(refused).toBeDefined();
    expect(refused?.details.retypedBy).toBe(second.id);
    expect(refused?.details.retypeType).toBe(CONSTRAINT_TYPE.PREFERENCE);
    expect(refused?.details.retypeReason).toBe('on reflection it is only a preference');
    expect(refused?.message).toContain(`"${second.id}"`);
    expect(refused?.message).not.toContain(`"${first.id}"`);
  });

  it('reports the retype that stands when the later retype follows the withdrawal', () => {
    // **The defect.** The refusal resolved which retype it was reporting from
    // inside the override loop, so it could only see the retypes queued
    // *before* the withdrawal it refuses. Composed the other way round —
    // retype, withdraw, retype — it named the first ancestor's `soft` while
    // the registry ended up carrying the last link's `preference`. That is the
    // same "reports a type the record does not have" misreport the sibling
    // case above exists to stop; it survived the `find` → `findLast` switch
    // because the switch fixed *which* entry was chosen without fixing *when*
    // the choice was made.
    const RETYPED = untouchedHardConstraint(registry.constraints);
    expect(RETYPED).toBeDefined();
    const constraintId = /** @type {any} */ (RETYPED).id;
    const LATER_REASON = 'on reflection it is only a preference';

    /** @param {string} id @param {string|null} parent @param {string} type @param {number} weight @param {string} reason */
    const retyper = (id, parent, type, weight, reason) =>
      link(id, parent, [
        {
          kind: SCENARIO_OVERRIDE_KIND.RETYPE,
          recordSet: SCENARIO_RECORD_SET.CONSTRAINTS,
          recordId: constraintId,
          type,
          weight,
          by: 'board@club.example',
          at: REQUESTED_AT,
          reason,
        },
      ]);

    const softens = retyper(
      'chain-softens-before-the-strike',
      null,
      CONSTRAINT_TYPE.SOFT,
      5,
      'what does this rule cost as a soft constraint?'
    );
    const strikesOut = link('chain-strikes-out-between', softens.id, [
      {
        kind: SCENARIO_OVERRIDE_KIND.REMOVE,
        recordSet: SCENARIO_RECORD_SET.CONSTRAINTS,
        recordId: constraintId,
        by: 'registrar@club.example',
        at: REQUESTED_AT,
        reason: 'the rule was struck out',
      },
    ]);
    const prefers = retyper(
      'chain-prefers-after-the-strike',
      strikesOut.id,
      CONSTRAINT_TYPE.PREFERENCE,
      2,
      LATER_REASON
    );

    const materialised = materialiseScenario(inputs, prefers, {
      ancestry: [softens, strikesOut],
    });

    // Meta-assertion: read off the branch under test, not asserted about it.
    // The withdrawal is refused, so both retypes land, and the registry this
    // branch actually consults ends up carrying the *last* one — which is what
    // makes naming the first a report of a type the record does not have.
    const record = materialised.engines.registry.byId[constraintId];
    expect(record).toBeDefined();
    expect(record.type).toBe(CONSTRAINT_TYPE.PREFERENCE);
    expect(record.history).toHaveLength(2);
    expect(record.history[1].from).toBe(CONSTRAINT_TYPE.SOFT);
    expect(record.history[1].note).toBe(LATER_REASON);
    expect(materialised.meta.recordsRemoved).toBe(0);
    expect(materialised.meta.recordsRetyped).toBe(2);

    const refused = materialised.findings.find(
      (entry) => entry.code === SCENARIO_REASON.SCENARIO_OVERRIDE_RETYPE_WITHDRAWN
    );
    expect(refused).toBeDefined();
    expect(refused?.severity).toBe(CONSTRAINT_SEVERITY.BLOCKING);
    expect(refused?.details.retypedBy).toBe(prefers.id);
    expect(refused?.details.retypeType).toBe(CONSTRAINT_TYPE.PREFERENCE);
    expect(refused?.details.retypeReason).toBe(LATER_REASON);
    expect(refused?.details.authoredBy).toBe(strikesOut.id);
    expect(refused?.message).toContain(`"${prefers.id}"`);
    expect(refused?.message).not.toContain(`"${softens.id}"`);
    // The refusal keeps its place in the run: it is reported where the
    // withdrawal was refused — after the first retype was applied and before
    // the last one was — rather than appended once the loop has finished.
    const codes = codesOf(materialised.findings);
    const applied = materialised.findings
      .map((entry, at) => ({ entry, at }))
      .filter(
        ({ entry }) =>
          entry.code === SCENARIO_REASON.SCENARIO_OVERRIDE_APPLIED &&
          entry.details.operation === SCENARIO_OVERRIDE_KIND.RETYPE
      );
    expect(applied).toHaveLength(2);
    const seat = codes.indexOf(SCENARIO_REASON.SCENARIO_OVERRIDE_RETYPE_WITHDRAWN);
    expect(seat).toBeGreaterThan(applied[0].at);
    expect(seat).toBeLessThan(applied[1].at);
  });

  it('still blames the baseline, and the sole retype, when there is no chain', () => {
    // The negative control for all three: one author, no ancestry, and the
    // wording and the attribution are the ones the earlier suites assert.
    const RETYPED = untouchedHardConstraint(registry.constraints);
    expect(RETYPED).toBeDefined();
    const alone = link('no-chain-at-all', null, [
      removeRow('a-permit-id-no-corpus-holds', 'this record does not exist'),
      addRow({ ...inputs.permits[1] }, 'an id the baseline already holds'),
    ]);
    const materialised = materialiseScenario(inputs, alone);
    const missing = materialised.findings.find(
      (entry) => entry.code === SCENARIO_REASON.SCENARIO_OVERRIDE_TARGET_MISSING
    );
    expect(missing?.message).toContain('the baseline does not hold');
    expect(missing?.details.precededBy).toBe(null);
    expect(missing?.details.baselineHeld).toBe(false);
    const collides = materialised.findings.find(
      (entry) => entry.code === SCENARIO_REASON.SCENARIO_OVERRIDE_ID_COLLIDES
    );
    expect(collides?.message).toContain('the baseline already holds');
    expect(collides?.details.precededBy).toBe(null);
    expect(collides?.details.baselineHeld).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* check() answers for the result its caller is holding                        */
/* -------------------------------------------------------------------------- */

describe('the staleness check answers for the result its caller is holding', () => {
  /** A bundle whose records this test owns, so one can be corrected in place. */
  const ownedBundle = () => {
    const owned = SEASON_2026_CONSTRAINTS.map((record) => ({ ...record }));
    return season2026SeasonInputs({
      schedule,
      facilityInput,
      timingInput,
      calendarInput,
      constraints: owned,
      venueComplexes,
      id: 'held-result-baseline',
    });
  };

  it('tells a holder its result is stale after an intervening resolve of the same branch', () => {
    // **The defect this exists to catch**, introduced by round two's own fix.
    // `resolve()` forgets every entry the branch has moved past *before* it
    // looks one up, so the second resolve purged the stale entry and `check()`
    // — which only ever read the cache — answered `[]` for a caller still
    // holding the pre-edit result. The class docstring promises that caller
    // `SCENARIO_RESULT_STALE` at blocking.
    const bundle = ownedBundle();
    const branch = season2026VenueUnavailableScenario({
      venueId: WITHDRAWN.venueId,
      baselineId: bundle.id,
      requestedBy: REQUESTED_BY,
      at: REQUESTED_AT,
      dates: [WITHDRAWN.dates[0]],
    });
    const memo = new ScenarioMemo();
    const held = memo.resolve(bundle, branch, { ...runOptions, relocations: false });
    expect(memo.check(bundle, branch, [], [held])).toEqual([]);

    const target = /** @type {any} */ (
      bundle.constraints.find((record) => record.type === CONSTRAINT_TYPE.HARD)
    );
    target.type = CONSTRAINT_TYPE.SOFT;
    target.weight = 5;

    // The intervening resolve: it re-derives, and it purges what it moved past.
    const fresh = memo.resolve(bundle, branch, { ...runOptions, relocations: false });
    expect(fresh).not.toBe(held);
    // The cache is clean — that is round two's finding 6, and it stays fixed…
    expect(memo.check(bundle, branch)).toEqual([]);
    // …and the caller still holding the pre-edit result is told, which is a
    // different question and the one the docstring promises an answer to.
    const findings = memo.check(bundle, branch, [], [held]);
    expect(codesOf(findings)).toEqual([SCENARIO_REASON.SCENARIO_RESULT_STALE]);
    expect(findings[0].severity).toBe(CONSTRAINT_SEVERITY.BLOCKING);
    expect(findings[0].details.cachedFingerprint).toBe(held.fingerprint);
    expect(findings[0].details.currentFingerprint).toBe(fresh.fingerprint);
    // The result derived after the correction is not stale, held or cached.
    expect(memo.check(bundle, branch, [], [fresh])).toEqual([]);
    // One finding, not two, when the holder holds what the memo also holds.
    expect(memo.check(bundle, branch, [], [fresh, fresh])).toEqual([]);
  });

  it('refuses to judge a result derived from another branch', () => {
    const bundle = ownedBundle();
    const branch = season2026VenueUnavailableScenario({
      venueId: WITHDRAWN.venueId,
      baselineId: bundle.id,
      requestedBy: REQUESTED_BY,
      at: REQUESTED_AT,
      id: 'the-branch-asked-about',
      dates: [WITHDRAWN.dates[0]],
    });
    const other = season2026VenueUnavailableScenario({
      venueId: WITHDRAWN.venueId,
      baselineId: bundle.id,
      requestedBy: REQUESTED_BY,
      at: REQUESTED_AT,
      id: 'the-branch-in-hand',
      dates: [WITHDRAWN.dates[1]],
    });
    const memo = new ScenarioMemo();
    const held = memo.resolve(bundle, other, { ...runOptions, relocations: false });
    // Answering this would be one branch's answer reported under another's
    // name, which is the misattribution this round fixed one layer down.
    expect(() => memo.check(bundle, branch, [], [held])).toThrow(/can only be stale against/);
  });

  it('reads what the branch digests to without building its engines', () => {
    // The efficiency finding, as a property rather than a stopwatch:
    // `forgetStale()` built all four engines on every resolve only to read a
    // string that `scenarioFingerprint()` returns on its own. The substitution
    // is only safe while the two agree, so that is what is asserted.
    const memo = new ScenarioMemo();
    expect(memo.fingerprintOf(inputs, scenario, [])).toBe(
      materialiseScenario(inputs, scenario).fingerprint
    );
    const child = season2026VenueUnavailableScenario({
      venueId: WITHDRAWN.venueId,
      baselineId: inputs.id,
      requestedBy: REQUESTED_BY,
      at: REQUESTED_AT,
      id: 'fingerprint-child',
      parentScenarioId: scenario.id,
      dates: [WITHDRAWN.dates[0]],
    });
    expect(memo.fingerprintOf(inputs, child, [scenario])).toBe(
      materialiseScenario(inputs, child, { ancestry: [scenario] }).fingerprint
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Shared subjects for the cross-module seam blocks below                      */
/* -------------------------------------------------------------------------- */

/** Memo for the seam subject, so the venue search below runs once. */
/** @type {Record<string, any>} */
const cacheSeam = {};

/**
 * A branch that moves nothing: an added blackout on ground the schedule never
 * stands on. The same device the vacuity control uses, lifted to module scope
 * so both seam blocks can state "the record set is the only thing that differs".
 *
 * @param {string} baselineId
 * @returns {Object}
 */
function quietBranchOver(baselineId) {
  const used = new Set(schedule.games.map((game) => game.venueId));
  const venueId =
    Object.values(graph.venues)
      .map((venue) => venue.id)
      .find((id) => !used.has(id)) ?? 'a-venue-this-corpus-does-not-have';
  return makeScenario({
    id: 'a-branch-that-moves-nothing',
    name: 'ground the schedule never stands on',
    baselineId,
    rationale: 'so the record set under test is the only thing that differs',
    requestedBy: REQUESTED_BY,
    createdAt: REQUESTED_AT,
    overrides: [
      {
        kind: SCENARIO_OVERRIDE_KIND.ADD,
        recordSet: SCENARIO_RECORD_SET.PERMITS,
        record: {
          id: 'a-blackout-nobody-notices',
          venueId,
          scopeKind: 'weekday-default',
          weekday: 'SAT',
          date: null,
          hasPermit: false,
          openMinutes: null,
          closeMinutes: null,
          lit: null,
          lightsOffMinutes: null,
          note: 'a venue this schedule never uses',
          source: 'the cross-module seam regression',
        },
        by: REQUESTED_BY,
        at: REQUESTED_AT,
        reason: 'withdraw ground the schedule never stands on',
      },
    ],
  });
}

/* -------------------------------------------------------------------------- */
/* Cross-module seam: the branch's waiver ledger, built and then not installed */
/* -------------------------------------------------------------------------- */

/**
 * **Findings 1 and 2 — one seam, two halves.**
 *
 * `runScenario()` builds a waiver ledger from the branch's own record set and
 * uses it for the two rule-engine runs it makes itself. It then hands
 * `materialised.engines` to `applyChangeRequest()` — and `runResolve()` reads
 * its ledger off `engines.waiverLedger`, a key nothing here ever set. So the
 * re-solve's internal rule engine ran **waiver-blind** while the scenario's own
 * verification did not: one branch, two different pictures of the same season,
 * and the waiver-blind one is the one that priced the objective, wrote
 * `RESOLVE_VERIFY_NEW_VIOLATION`, and whose findings
 * {@link runScenario} pushes into the result's own list and therefore into its
 * status and its promotion gate. That is the corpus's incident 9 in shape: a
 * waiver that exists and does not apply.
 *
 * The second half is one function up. `waiverLedgerFor()` returns
 * `buildWaiverLedger()`'s ledger and drops `buildWaiverLedger()`'s **findings**,
 * so `WAIVER_ID_DUPLICATE` — blocking, and the report that a waiver was
 * silently discarded — reached nobody. The rule engine does not stand in for
 * it: `runRuleEngine()` forwards `applyWaivers()`'s *reconciliation* findings
 * (an unknown constraint, a non-waivable one), which are a different set built
 * from a different pass. A ledger's own build findings have no other reader.
 *
 * **Neither half subsumes the other**, and the second block below is the proof:
 * with the ledger installed on the engines, a duplicate waiver id is *still*
 * invisible, because the duplicate is resolved inside `buildWaiverLedger()`
 * before any engine is handed anything.
 */
describe('the branch’s waiver ledger reaches the re-solve, not only the scenario', () => {
  /**
   * A branch that **relocates**, so `applyChangeRequest()` actually runs, and
   * that keeps a waivable violation standing on the schedule it produces.
   *
   * Chosen by a stated property rather than by name: the smallest venue whose
   * withdrawal still leaves the re-solve's own verification holding at least one
   * violation of a constraint this season says may be waived. Withdrawing the
   * acceptance test's venue does not — that branch's re-solve carries no
   * waivable violation at all — which is exactly why this seam survived a
   * per-prompt review of the module that owns it.
   */
  function waivableBranchSubject() {
    if (cacheSeam.subject === undefined) {
      const profiles = venueProfiles();
      let chosen = null;
      for (const profile of [...profiles].sort((a, b) => a.games - b.games)) {
        const branch = season2026VenueUnavailableScenario({
          venueId: profile.venueId,
          baselineId: inputs.id,
          requestedBy: REQUESTED_BY,
          at: REQUESTED_AT,
        });
        const options = {
          baselineEngines,
          baselineVerification,
          relocationPolicy: season2026RelocationPolicy({
            graph,
            table,
            format: profile.formats[0],
            excludeVenueIds: [profile.venueId],
            games: schedule.games,
          }),
          requirement: {
            slots: 1,
            label: `one slot on ${profile.venueId}`,
            source: 'derived from fixtures/season-2026/combined_schedule.csv',
          },
        };
        const plain = runScenario(inputs, branch, options);
        if (plain.run === null || plain.run.verification === null) continue;
        const waivables = plain.run.verification.violations.filter(
          (violation) =>
            violation.constraintId && registry.byId[violation.constraintId]?.waivable === true
        );
        if (waivables.length === 0) continue;
        chosen = { profile, branch, options, plain, waivable: waivables[0] };
        break;
      }
      cacheSeam.subject = chosen;
    }
    return cacheSeam.subject;
  }

  /** A bundle carrying the stated waivers and nothing else changed. */
  function bundleWithWaivers(waivers) {
    return season2026SeasonInputs({
      schedule,
      facilityInput,
      timingInput,
      calendarInput,
      constraints: SEASON_2026_CONSTRAINTS,
      venueComplexes,
      waivers,
    });
  }

  it('the subject really is a relocating branch with a waivable violation left standing', () => {
    // The meta-assertions. Each of the three is a way the assertions below
    // would otherwise pass on air: a branch that relocated nothing never calls
    // `applyChangeRequest()`; a run with no verification has no picture to be
    // wrong about; and a run with no waivable violation gives a ledger nothing
    // to do, so "the ledger reached it" would be unfalsifiable.
    const subject = waivableBranchSubject();
    expect(subject, 'a venue whose withdrawal leaves a waivable violation').not.toBeNull();
    expect(subject.plain.relocations.proposals.length).toBeGreaterThan(0);
    expect(subject.plain.run).not.toBeNull();
    expect(subject.plain.run.verification).not.toBeNull();
    expect(registry.byId[subject.waivable.constraintId].waivable).toBe(true);
    // And with no waiver anywhere, nothing is waived — the floor the next test
    // measures from.
    expect(subject.plain.run.verification.meta.violationsWaived).toBe(0);
  });

  it('honours the branch’s waivers inside the re-solve, not only in its own verification', () => {
    const subject = waivableBranchSubject();
    const waived = bundleWithWaivers([
      {
        id: 'the-waiver-the-re-solve-must-see',
        constraintId: subject.waivable.constraintId,
        name: 'the exception the board granted',
        scope: { personId: subject.waivable.details.personId },
        reason: 'the board granted this coach an exception, and every engine must see it',
        approval: {
          approvedBy: REQUESTED_BY,
          approvedAt: '2026-07-01',
          reference: 'board minutes 2026-07',
        },
      },
    ]);
    const branch = season2026VenueUnavailableScenario({
      venueId: subject.profile.venueId,
      baselineId: waived.id,
      requestedBy: REQUESTED_BY,
      at: REQUESTED_AT,
    });
    const run = runScenario(waived, branch, { ...subject.options, baselineVerification: null });

    // The ledger is installed on the branch's own engines, which is what the
    // re-solve reads it from — not merely held in a local the resolver cannot
    // see.
    expect(run.materialised.engines.waiverLedger).not.toBeNull();
    expect(run.materialised.engines.waiverLedger.waiverIds).toEqual([
      'the-waiver-the-re-solve-must-see',
    ]);

    // The defect, in one line: the re-solve's own rule-engine run waived
    // nothing, while the scenario's did.
    expect(run.run.verification.meta.violationsWaived).toBeGreaterThan(0);
    expect(run.verification.meta.violationsWaived).toBeGreaterThan(0);
    const stamped = run.run.verification.violations.filter(
      (violation) => violation.waived === true
    );
    expect(stamped.length).toBe(run.run.verification.meta.violationsWaived);
    expect(stamped.every((violation) => violation.waivedBy !== null)).toBe(true);
    // Every one of them is an exception to the constraint the waiver names, so
    // the count is the waiver's doing rather than something else's.
    expect(new Set(stamped.map((violation) => violation.constraintId))).toEqual(
      new Set([subject.waivable.constraintId])
    );
    expect(new Set(stamped.map((violation) => violation.waiverId))).toEqual(
      new Set(['the-waiver-the-re-solve-must-see'])
    );
    // …and the identical branch with no waiver waives nothing, which is what
    // makes the assertion above about the waiver and not about the branch.
    expect(subject.plain.run.verification.meta.violationsWaived).toBe(0);
  });

  it('stops pricing a waived violation as blocking in the re-solve’s objective', () => {
    // The harm, stated as the finding states it. A soft constraint's violation
    // is already `compromise`, so this branch **retypes** the waivable
    // constraint to hard — a record edit the scenario type exists to allow —
    // which makes its violation `blocking` and therefore worth
    // `blockingViolation` in the objective. Waived, `applyWaivers()` demotes it
    // to `compromise`. The two runs below differ by the waiver alone.
    const subject = waivableBranchSubject();
    const constraintId = subject.waivable.constraintId;
    const overrides = (waiverNote) => [
      {
        kind: SCENARIO_OVERRIDE_KIND.VENUE_UNAVAILABLE,
        venueId: subject.profile.venueId,
        dates: null,
        by: REQUESTED_BY,
        at: REQUESTED_AT,
        reason: `${subject.profile.venueId} is unavailable for the whole season`,
      },
      {
        kind: SCENARIO_OVERRIDE_KIND.RETYPE,
        recordSet: SCENARIO_RECORD_SET.CONSTRAINTS,
        recordId: constraintId,
        type: CONSTRAINT_TYPE.HARD,
        by: REQUESTED_BY,
        at: REQUESTED_AT,
        reason: `the board made "${constraintId}" binding, ${waiverNote}`,
      },
    ];
    const branchOver = (bundle, waiverNote) =>
      runScenario(
        bundle,
        makeScenario({
          id: 'hardened-and-excepted',
          name: 'the rule made binding',
          baselineId: bundle.id,
          rationale: 'so the price of a waived violation is the only thing that differs',
          requestedBy: REQUESTED_BY,
          createdAt: REQUESTED_AT,
          overrides: overrides(waiverNote),
        }),
        { ...subject.options, baselineVerification: null }
      );

    const hardened = branchOver(bundleWithWaivers([]), 'and nobody is excepted from it');
    const excepted = branchOver(
      bundleWithWaivers([
        {
          id: 'the-exception-to-the-hardened-rule',
          constraintId,
          name: 'the exception the board granted',
          scope: { personId: subject.waivable.details.personId },
          reason: 'the board granted this coach an exception to the rule it had just hardened',
          approval: {
            approvedBy: REQUESTED_BY,
            approvedAt: '2026-07-01',
            reference: 'board minutes 2026-07',
          },
        },
      ]),
      'and one coach is excepted from it'
    );

    const blockingIn = (run) =>
      run.run.objective.resolvedSchedule.terms.blockingViolation?.count ?? 0;
    const compromiseIn = (run) =>
      run.run.objective.resolvedSchedule.terms.compromiseViolation?.count ?? 0;

    // Meta-assertion: the retype has to have made something blocking, or the
    // comparison below is between two zeroes.
    expect(blockingIn(hardened)).toBeGreaterThan(0);
    const moved = excepted.run.verification.meta.violationsWaived;
    expect(moved).toBeGreaterThan(0);

    // The waived violations stop being priced at `blockingViolation` and start
    // being priced at `compromiseViolation`. Nothing else about the two runs
    // differs, so the whole of the delta is the waiver.
    expect(blockingIn(excepted)).toBe(blockingIn(hardened) - moved);
    expect(compromiseIn(excepted)).toBe(compromiseIn(hardened) + moved);
    expect(excepted.run.objective.resolvedSchedule.qualityCost).toBeLessThan(
      hardened.run.objective.resolvedSchedule.qualityCost
    );
  });
});

/**
 * **Finding 2 on its own**, so that it is visibly not finding 1 in disguise.
 *
 * A duplicate waiver id is resolved inside `buildWaiverLedger()`: the second
 * record is dropped and `WAIVER_ID_DUPLICATE` is written to the ledger's own
 * `findings`. Every engine downstream is then handed a ledger that is
 * internally consistent and one waiver short, so installing that ledger
 * everywhere — finding 1's whole fix — changes nothing about this at all. The
 * only reader that could ever report it is the caller that built it.
 */
describe('a waiver the branch silently lost is reported, not swallowed', () => {
  /** Two waivers, one id. The second is the one `buildWaiverLedger()` drops. */
  function duplicatePair() {
    const waivable = baselineVerification.violations.find(
      (violation) =>
        violation.constraintId &&
        registry.byId[violation.constraintId]?.waivable === true &&
        violation.details?.personId
    );
    const base = {
      constraintId: /** @type {any} */ (waivable).constraintId,
      approval: {
        approvedBy: REQUESTED_BY,
        approvedAt: '2026-07-01',
        reference: 'board minutes 2026-07',
      },
    };
    return {
      waivable,
      waivers: [
        {
          ...base,
          id: 'two-waivers-one-id',
          name: 'the exception the board granted',
          scope: { personId: /** @type {any} */ (waivable).details.personId },
          reason: 'the first of two records claiming this id',
        },
        {
          ...base,
          id: 'two-waivers-one-id',
          name: 'the exception somebody typed twice',
          scope: { personId: /** @type {any} */ (waivable).details.personId },
          reason: 'the second of two records claiming this id, and the one that is dropped',
        },
      ],
    };
  }

  it('the ledger really does drop one of them, so there is something to report', () => {
    // The meta-assertion, and the reason this is a defect rather than a
    // preference: the branch is running one waiver short of what its record set
    // states, and every engine downstream is consistent with the short version.
    const { waivers } = duplicatePair();
    expect(waivers[0].id).toBe(waivers[1].id);
    const ledger = buildWaiverLedger({
      name: 'the falsification',
      source: 'tests/scenarioBranching.test.js',
      waivers,
    });
    expect(ledger.waiverIds).toEqual(['two-waivers-one-id']);
    expect(ledger.findings.map((finding) => finding.code)).toContain(
      WAIVER_REASON.WAIVER_ID_DUPLICATE
    );
  });

  it('carries WAIVER_ID_DUPLICATE into the scenario’s own findings and status', () => {
    const { waivers } = duplicatePair();
    const bundle = season2026SeasonInputs({
      schedule,
      facilityInput,
      timingInput,
      calendarInput,
      constraints: SEASON_2026_CONSTRAINTS,
      venueComplexes,
      waivers,
    });
    // A branch that moves nothing, so the duplicate is the only thing under
    // test — and, deliberately, one that never reaches `applyChangeRequest()`
    // at all. Finding 1's fix cannot be what makes this pass.
    const quiet = quietBranchOver(bundle.id);
    const run = runScenario(bundle, quiet, { ...runOptions, baselineVerification: null });
    expect(run.run, 'a branch that displaces nothing never re-solves').toBeNull();

    const duplicate = run.findings.filter(
      (finding) => finding.code === WAIVER_REASON.WAIVER_ID_DUPLICATE
    );
    expect(duplicate).toHaveLength(1);
    expect(duplicate[0].details.waiverId).toBe('two-waivers-one-id');
    expect(duplicate[0].severity).toBe(CONSTRAINT_SEVERITY.BLOCKING);
    // …and it counts, rather than sitting in a list nobody derives from.
    expect(run.status).toBe(SCENARIO_STATUS.REJECTED);
  });

  it('says nothing at all when the ids are distinct', () => {
    // The negative control. Identical shape, one character changed, so the
    // finding above is about the duplicate and not about carrying waivers.
    const { waivers } = duplicatePair();
    const bundle = season2026SeasonInputs({
      schedule,
      facilityInput,
      timingInput,
      calendarInput,
      constraints: SEASON_2026_CONSTRAINTS,
      venueComplexes,
      waivers: [waivers[0], { ...waivers[1], id: 'two-waivers-two-ids' }],
    });
    const run = runScenario(bundle, quietBranchOver(bundle.id), {
      ...runOptions,
      baselineVerification: null,
    });
    expect(
      run.findings.filter((finding) => finding.code === WAIVER_REASON.WAIVER_ID_DUPLICATE)
    ).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Round 2, finding 1 — one size rule, not two                                 */
/* -------------------------------------------------------------------------- */

describe('replacement ground is judged by the size rule the facility model owns', () => {
  /**
   * `replacementSurfacesFor()` used to judge "is this ground big enough" from
   * the **smallest** declared size while `checkSizeEligibility()` judges it from
   * the **largest** and honours a literal declaration. Every surface declaring
   * more than one size fell in the gap: Brookside's Upper 1 and Upper 2 declare
   * `["7v7","9v9"]`, are `allowed` for 9v9, and are counted as 9v9 ground by the
   * reserve adapter — and were refused as replacement ground for 9v9, so a
   * venue withdrawal reported 9v9 games unrelocatable while legal ground stood
   * empty.
   *
   * The subject is chosen by a stated property — a leaf surface declaring more
   * than one size — rather than by name, and the assertion below is an equality
   * over the *whole* corpus rather than a check on the two surfaces that showed
   * it.
   */
  const rank = graph.sizeRank ?? DEFAULT_SIZE_RANK;
  /** Ordered by the rank table itself, so "the largest format it fits" means what it says. */
  const FORMATS = Object.keys(rank).sort((a, b) => rank[a] - rank[b]);
  /** High enough that the "one grade up" ceiling never bites, so only the size predicate is under test. */
  const NO_CEILING = 99;
  /**
   * The universe this block compares against, **stated rather than derived from
   * the predicate under test**.
   *
   * A round-1 fix widened the production filter and this line was widened with
   * it, in the same words — so the set was being compared against itself and
   * could not have failed however the rule moved. The universe is now: the
   * graph's leaves, plus an explicit list of the parents relocation intends to
   * offer whole. On this graph (the *game* geometry, `facility_geometry.json`)
   * that list is empty: its only parents are Alder Pitch 1 and Pitch 4, whose
   * halves are themselves 9v9 ground, so the halves are what is bookable. The
   * composed practice graph, where Pitch 2 and Pitch 3 gain sizeless halves and
   * stay offered whole, is checked in `tests/facilityPracticeLayer.test.js`.
   */
  const OFFERABLE_PARENT_IDS = Object.freeze([]);
  const offerable = graph.surfaceIds
    .map((id) => graph.surfaces[id])
    .filter(
      (surface) => surface.childIds.length === 0 || OFFERABLE_PARENT_IDS.includes(surface.id)
    );
  const multiSized = offerable.filter((surface) => surface.sizes.length > 1);

  /** The predicate this test is about, asked of the facility model. */
  const sizeEligible = (surfaceId, format) =>
    checkSizeEligibility(graph, { surfaceId, format }).status === FACILITY_STATUS.ALLOWED;

  it('has ground declared for more than one size to be wrong about', () => {
    // The meta-assertion the rest of the block rests on. A corpus in which every
    // surface declared exactly one size would make "smallest" and "largest" the
    // same number, and every assertion below would pass vacuously.
    expect(offerable.length).toBeGreaterThan(10);
    // ... and "leaves plus a named list" is a real restriction on this graph
    // rather than a longer way to write "every surface": there are parents, and
    // the stated list withholds every one of them.
    const parents = graph.surfaceIds
      .map((id) => graph.surfaces[id])
      .filter((surface) => surface.childIds.length > 0);
    expect(parents.map((surface) => surface.id).sort()).toEqual([
      'alder-park/pitch-1',
      'alder-park/pitch-4',
    ]);
    expect(OFFERABLE_PARENT_IDS).toEqual([]);
    expect(offerable.map((surface) => surface.id)).not.toContain('alder-park/pitch-1');
    // Each withheld parent is withheld for a stated reason: its halves declare
    // ground of their own, so the halves are what may be booked.
    for (const parent of parents) {
      expect(parent.sizes.length, parent.id).toBeGreaterThan(0);
      expect(
        parent.childIds.every((childId) => graph.surfaces[childId].sizes.length > 0),
        parent.id
      ).toBe(true);
    }
    expect(multiSized.length).toBeGreaterThan(0);
    expect(FORMATS.length).toBeGreaterThan(3);
    // …and at least one of them is eligible for a format that is not its
    // smallest declared size, which is the case the two rules disagreed on.
    const straddling = multiSized.filter((surface) => {
      const ranks = surface.sizes.map((size) => rank[size]).filter((r) => typeof r === 'number');
      return FORMATS.some(
        (format) => sizeEligible(surface.id, format) && rank[format] > Math.min(...ranks)
      );
    });
    expect(straddling.length).toBeGreaterThan(0);
  });

  it('offers exactly the surfaces the facility model calls size-eligible', () => {
    for (const format of FORMATS) {
      const offered = new Set(
        replacementSurfacesFor(graph, { format, maxGradesAbove: NO_CEILING })
      );
      const eligible = offerable
        .filter((surface) => sizeEligible(surface.id, format))
        .map((surface) => surface.id)
        .sort();
      expect([...offered].sort(), `replacement ground for ${format}`).toEqual(eligible);
    }
  });

  it('rejects a rule that offers a parent standing on bookable ground', () => {
    // The positive control for the universe itself, and the regression round 2
    // found: a filter reading "a leaf, **or** a surface that states sizes of
    // its own" admits Alder Pitch 1 and Pitch 4 beside their own halves. Written
    // out here and run against the stated universe, it disagrees — so the
    // equality above is an assertion that can fail rather than a set compared
    // with itself.
    const widened = graph.surfaceIds
      .map((id) => graph.surfaces[id])
      .filter((surface) => surface.childIds.length === 0 || surface.sizes.length > 0);
    const extra = widened
      .filter((surface) => !offerable.some((kept) => kept.id === surface.id))
      .map((surface) => surface.id)
      .sort();
    expect(extra).toEqual(['alder-park/pitch-1', 'alder-park/pitch-4']);

    const disagreements = FORMATS.filter((format) => {
      const stated = offerable
        .filter((surface) => sizeEligible(surface.id, format))
        .map((surface) => surface.id)
        .sort();
      const wrong = widened
        .filter((surface) => sizeEligible(surface.id, format))
        .map((surface) => surface.id)
        .sort();
      return JSON.stringify(stated) !== JSON.stringify(wrong);
    });
    expect(disagreements).toContain('9v9');
    // ... and what production actually answers is the stated set, not the
    // widened one, for the format where they differ.
    const offered = replacementSurfacesFor(graph, { format: '9v9', maxGradesAbove: NO_CEILING });
    for (const parent of extra) expect(offered, parent).not.toContain(parent);
  });

  it('rejects the smallest-declared-size rule it used to use', () => {
    // The positive control. The old predicate, written out here, is run against
    // the assertion above; if it passed, the assertion would be proving nothing.
    const oldPredicate = (format) =>
      offerable
        .filter((surface) => {
          const ranks = surface.sizes
            .map((size) => rank[size])
            .filter((r) => typeof r === 'number');
          if (ranks.length === 0) return false;
          const smallest = Math.min(...ranks);
          return smallest >= rank[format] && smallest <= rank[format] + NO_CEILING;
        })
        .map((surface) => surface.id)
        .sort();
    const disagreements = FORMATS.filter((format) => {
      const eligible = offerable
        .filter((surface) => sizeEligible(surface.id, format))
        .map((surface) => surface.id)
        .sort();
      return JSON.stringify(oldPredicate(format)) !== JSON.stringify(eligible);
    });
    expect(disagreements.length).toBeGreaterThan(0);
  });

  it('names the ground the withdrawal report used to call unreachable', () => {
    // The reproduced case, derived: every multi-sized leaf, at the largest
    // format it is eligible for, under the adapter's own one-grade-up policy.
    for (const surface of multiSized) {
      const eligible = FORMATS.filter((format) => sizeEligible(surface.id, format));
      const largest = eligible[eligible.length - 1];
      expect(replacementSurfacesFor(graph, { format: largest, maxGradesAbove: 1 })).toContain(
        surface.id
      );
    }
    // …which on this corpus is Brookside's two, for 9v9.
    expect(replacementSurfacesFor(graph, { format: '9v9', maxGradesAbove: 1 })).toEqual(
      expect.arrayContaining(['brookside-park/upper-1', 'brookside-park/upper-2'])
    );
  });

  it('still refuses ground more than the stated number of grades above the format', () => {
    // The ceiling is this module's own policy and it survives the fix: the grade
    // of a surface is its largest declared size, which is the same quantity
    // `checkSizeEligibility()` measures "big enough" against.
    for (const format of FORMATS) {
      for (const surfaceId of replacementSurfacesFor(graph, { format, maxGradesAbove: 1 })) {
        const ranks = graph.surfaces[surfaceId].sizes
          .map((size) => rank[size])
          .filter((r) => typeof r === 'number');
        expect(Math.max(...ranks), `${surfaceId} offered for ${format}`).toBeLessThanOrEqual(
          rank[format] + 1
        );
      }
    }
    // Non-vacuous: the stadium is eligible for 7v7 under the downward-closed
    // policy and is not offered for it.
    expect(sizeEligible('summit-hs/stadium', '7v7')).toBe(true);
    expect(replacementSurfacesFor(graph, { format: '7v7', maxGradesAbove: 1 })).not.toContain(
      'summit-hs/stadium'
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Round 2 sweep — a capacity delta says whether its two reports could count    */
/* -------------------------------------------------------------------------- */

describe('a capacity delta states what the two reports it came from said', () => {
  /**
   * Class B in `diffCapacity()`: `buildReserveCapacityReport()` returns a count
   * **and** a report about the count, and only the count was read. A report that
   * generated no slots says `RESERVE_CAPACITY_VACUOUS` at blocking, and the
   * delta published from it read as a plain fact about the season — "0 against
   * 0, a delta of 0" being the most dangerous shape of that.
   */
  const cleanSubject = capacitySubjects[0];
  /**
   * The same subject with its kickoff window shut. Nothing about the ground
   * changes; the report simply generates no slot to count, which is exactly the
   * state `RESERVE_CAPACITY_VACUOUS` exists to name.
   */
  const vacuousSubject = {
    ...cleanSubject,
    latestKickoffMinutes: cleanSubject.earliestKickoffMinutes - 1,
  };

  it('carries both reports statuses and codes on the delta it publishes', () => {
    const clean = diffCapacity(baselineEngines, baselineEngines, [cleanSubject]);
    const finding = /** @type {Object} */ (
      clean.findings.find((entry) => entry.code === SCENARIO_REASON.SCENARIO_CAPACITY_DELTA)
    );
    expect(finding).toBeDefined();
    // The meta-assertion: the clean subject really did count something, or the
    // contrast below would be between two empty reports.
    expect(finding.details.leftSlots).toBeGreaterThan(0);
    expect(finding.details.leftReportStatus).toBe(finding.details.rightReportStatus);
    expect(Array.isArray(finding.details.leftReportCodes)).toBe(true);
    expect(Array.isArray(finding.details.rightReportCodes)).toBe(true);
  });

  it('does not let a delta of nothing read as a delta', () => {
    const vacuous = diffCapacity(baselineEngines, baselineEngines, [vacuousSubject]);
    const finding = /** @type {Object} */ (
      vacuous.findings.find((entry) => entry.code === SCENARIO_REASON.SCENARIO_CAPACITY_DELTA)
    );
    // The numbers on their own say "nothing changed"…
    expect(finding.details.leftSlots).toBe(0);
    expect(finding.details.rightSlots).toBe(0);
    expect(finding.details.delta).toBe(0);
    // …and the half that used to be dropped says why that is not a fact about
    // the season.
    expect(finding.details.leftReportCodes).toContain('RESERVE_CAPACITY_VACUOUS');
    expect(finding.details.rightReportCodes).toContain('RESERVE_CAPACITY_VACUOUS');
    expect(finding.details.leftReportStatus).toBe('rejected');
    expect(finding.details.rightReportStatus).toBe('rejected');
  });
});

/* -------------------------------------------------------------------------- */
/* Round 3, finding 3 - a blocking report discarded, an empty grid read as full */
/* -------------------------------------------------------------------------- */

describe('proposeRelocations :: the capacity reports it asks for, carried whole', () => {
  /**
   * `proposeRelocations()` built one `buildReserveCapacityReport()` per displaced
   * format, read `report.dates` off each to fill the grid, kept **the first**
   * report on `capacity`, and dropped every report's `findings` and `status` on
   * the floor. Two blocking codes therefore could not reach anything:
   *
   * - `RESERVE_CAPACITY_VACUOUS` — the report generated no slot at all, so every
   *   requirement it reports as met was met by an empty count. The grid is then
   *   empty and the proposer reads *"no room"* — which is what a season with no
   *   spare ground looks like, and also what a report that examined nothing
   *   looks like, and the two were indistinguishable.
   * - `RESERVED_SLOT_UNCOVERED` — a reservation standing on ground the report
   *   does not cover, so no grid, condition or requirement check in it applies
   *   to that ground. Incident 10's own shape: a commitment that disappears
   *   without a word.
   *
   * Neither reached `plan.findings`, `plan.status`, `runScenario()`'s result, or
   * `promoteScenario()`'s gate. This was left in round 2 because fixing it
   * changes a public return shape; it is the second time it has been reported,
   * and a blocking finding that cannot reach a promotion gate is worth the
   * shape change.
   *
   * `capacity` (one report, arbitrarily the first) becomes `capacities` (every
   * report, in format order). On this corpus the acceptance run displaces one
   * format and so has exactly one report, which is why the first-only bug was
   * invisible there and why the block below builds a two-format branch.
   */

  const survivors = schedule.games.filter(
    (game) => !result.displaced.some((entry) => entry.gameId === String(game.id))
  );
  const displacedGamesById = Object.fromEntries(
    schedule.games.map((game) => [String(game.id), game])
  );

  /** Propose over the acceptance branch's own displaced set, with overrides. */
  const propose = (overrides = {}) =>
    proposeRelocations(result.materialised.engines, {
      displaced: result.displaced,
      survivors,
      gamesById: displacedGamesById,
      policy,
      requirement,
      probe: branchProbe(),
      ...overrides,
    });

  it('carries every report it built, not the first one', () => {
    const plan = result.relocations;
    const formats = [...new Set(result.displaced.map((game) => game.format))].sort();
    expect(plan.capacities).toHaveLength(formats.length);
    // The meta-assertion that makes "carried" mean something: the reports hold
    // real content, so dropping them dropped something.
    for (const report of plan.capacities) {
      expect(report.findings.length).toBeGreaterThan(0);
      expect(report.status).toEqual(expect.any(String));
      expect(report.dates.length).toBeGreaterThan(0);
    }
    // The old field is gone rather than kept beside the new one: a `capacity`
    // that named one of several reports was the defect, and leaving it would
    // leave a reader a way to read the wrong number.
    expect('capacity' in plan).toBe(false);
  });

  it('builds one report per displaced format, and keeps them all', () => {
    // The half the acceptance run cannot show, because it displaces one format.
    // Two formats' worth of displaced games, so two reports exist to lose.
    const twoFormats = (() => {
      const other = schedule.games.find(
        (game) =>
          game.format && game.format !== AFFECTED_FORMAT && game.endMinutes !== null && game.counted
      );
      return [
        ...result.displaced.slice(0, 3),
        {
          gameId: String(/** @type {Object} */ (other).id),
          label: 'a second format, displaced',
          date: /** @type {Object} */ (other).date,
          venueId: /** @type {Object} */ (other).venueId,
          surfaceId: /** @type {Object} */ (other).surfaceId,
          startMinutes: /** @type {Object} */ (other).startMinutes,
          format: /** @type {Object} */ (other).format,
          codes: Object.freeze([]),
          constraintIds: Object.freeze([]),
        },
      ];
    })();
    const formats = [...new Set(twoFormats.map((game) => game.format))].sort();
    expect(formats).toHaveLength(2);
    const plan = propose({
      displaced: twoFormats,
      gamesById: displacedGamesById,
    });
    // Pre-fix this was one report, whichever format sorted first.
    expect(plan.capacities).toHaveLength(2);
    expect(plan.capacities.map((report) => report.format).sort()).toEqual(formats);
  });

  it('lets a report that examined nothing say so, at blocking', () => {
    // `RESERVE_CAPACITY_VACUOUS`. A window narrow enough that no kickoff fits
    // generates no slot, so the grid is empty — and an empty grid and a busy
    // season read the same to the proposer. Pre-fix the report said so and the
    // plan did not.
    const plan = propose({
      // A window one minute wide, one minute before midnight: no kickoff of
      // this format fits inside any permit, so the report generates no slot.
      policy: {
        ...policy,
        earliestKickoffMinutes: 24 * 60 - 1,
        latestKickoffMinutes: 24 * 60,
        cadenceMinutes: 24 * 60,
      },
    });
    const vacuous = plan.capacities.filter((report) =>
      report.findings.some((finding) => finding.code === RESERVE_REASON.RESERVE_CAPACITY_VACUOUS)
    );
    // Meta-assertion: the arrangement really did produce a vacuous report, so
    // the assertion below is about something.
    expect(vacuous.length).toBeGreaterThan(0);
    const codes = codesOf(plan.findings);
    expect(codes).toContain(RESERVE_REASON.RESERVE_CAPACITY_VACUOUS);
    expect(plan.status).toBe(SCENARIO_STATUS.REJECTED);
    const raised = plan.findings.find(
      (finding) => finding.code === RESERVE_REASON.RESERVE_CAPACITY_VACUOUS
    );
    expect(raised.severity).toBe(CONSTRAINT_SEVERITY.BLOCKING);
  });

  it('lets a reservation on ground the report does not cover say so, at blocking', () => {
    // `RESERVED_SLOT_UNCOVERED`. A reserved slot of the displaced format,
    // standing on a surface the policy does not name, is ground the report
    // cannot judge — and the proposer holds it as a booking regardless, so the
    // branch is spending ground the report is silent about.
    const offPolicySurface = /** @type {string} */ (
      Object.values(graph.surfaces)
        .map((surface) => surface.id)
        .find((surfaceId) => !policy.surfaceIds.includes(surfaceId))
    );
    const plan = propose({
      reservedSlots: [
        {
          id: 'round-3-uncovered',
          kind: 'reservation',
          label: 'a reservation on ground this report does not cover',
          date: result.displaced[0].date,
          venueId: graph.surfaces[offPolicySurface].venueId,
          surfaceId: offPolicySurface,
          startMinutes: 9 * 60,
          endMinutes: 10 * 60,
          format: AFFECTED_FORMAT,
          homeSide: 'tbd',
          awaySide: 'tbd',
        },
      ],
    });
    expect(codesOf(plan.findings)).toContain(RESERVE_REASON.RESERVED_SLOT_UNCOVERED);
    expect(plan.status).toBe(SCENARIO_STATUS.REJECTED);
  });

  it('reaches the scenario result and the promotion gate', () => {
    // The whole point of the shape change: a blocking finding that stops at the
    // proposer is a blocking finding nothing can act on. `runScenario()` already
    // folds `relocations.findings` into its own, so once the plan carries the
    // report the branch does too — and `promoteScenario()` refuses a branch
    // whose status is `rejected`.
    const offPolicySurface = /** @type {string} */ (
      Object.values(graph.surfaces)
        .map((surface) => surface.id)
        .find((surfaceId) => !policy.surfaceIds.includes(surfaceId))
    );
    const uncovered = {
      id: 'round-3-uncovered-scenario',
      kind: 'reservation',
      label: 'a reservation on ground the branch does not cover',
      date: result.displaced[0].date,
      venueId: graph.surfaces[offPolicySurface].venueId,
      surfaceId: offPolicySurface,
      startMinutes: 9 * 60,
      endMinutes: 10 * 60,
      format: AFFECTED_FORMAT,
      homeSide: 'tbd',
      awaySide: 'tbd',
    };
    const branch = runScenario(
      inputs,
      makeScenario({
        ...scenario,
        id: `${scenario.id}-uncovered`,
        overrides: [
          ...scenario.overrides,
          {
            kind: SCENARIO_OVERRIDE_KIND.ADD,
            recordSet: SCENARIO_RECORD_SET.RESERVED_SLOTS,
            record: uncovered,
            by: REQUESTED_BY,
            at: REQUESTED_AT,
            reason: 'a reservation standing outside the replacement policy ground',
          },
        ],
      }),
      runOptions
    );
    expect(codesOf(branch.findings)).toContain(RESERVE_REASON.RESERVED_SLOT_UNCOVERED);
    expect(branch.status).toBe(SCENARIO_STATUS.REJECTED);
    expect(() =>
      promoteScenario({
        result: branch,
        diff: diffAgainstBaselineScenario(branch, {
          baselineEngines,
          baselineVerification,
          capacitySubjects,
        }),
        promotionId: 'round-3-uncovered-promotion',
        promotedAt: REQUESTED_AT,
        promotedBy: REQUESTED_BY,
        rationale: 'a branch whose capacity report names ground it does not cover',
      })
    ).toThrow();
  });

  it('does not block on a shortfall against a requirement it invented for itself', () => {
    // The other half of the line, and it has to be asserted or the rule above
    // reads as "lift everything blocking". `RESERVE_CAPACITY_BELOW_REQUIREMENT`
    // is blocking on the report and is *not* lifted, because the requirement it
    // answers is the one this proposer computed a moment earlier from the
    // displaced set — and because the fact it states, "the ground cannot hold
    // all of them", is what `unrelocatable` already reports per game with a
    // reason. `docs/SCENARIOS.md` draws the same line: a branch that shelves is
    // `compromised` and promotable, a branch that loses a fixture is refused.
    // Blocking here would make every withdrawal branch with one TIME TBD
    // unpromotable, the acceptance run included.
    // The caller's `requirement.slots` is not even read here — the proposer
    // takes only the label and source and computes `Math.max(1, perDate)` from
    // the displaced set itself, which is the whole of the argument. So the
    // shortfall is produced the way a real one arises: one narrow strip of
    // ground, against a date that needs several slots.
    const plan = propose({
      policy: {
        ...policy,
        surfaceIds: [policy.surfaceIds[0]],
        cadenceMinutes: 60,
        earliestKickoffMinutes: policy.earliestKickoffMinutes,
        latestKickoffMinutes: policy.earliestKickoffMinutes + 60,
      },
    });
    const short = plan.capacities.filter((report) =>
      report.findings.some(
        (finding) => finding.code === RESERVE_REASON.RESERVE_CAPACITY_BELOW_REQUIREMENT
      )
    );
    // Meta-assertion: the shortfall really was produced, so the assertion that
    // it is not lifted is about something.
    expect(short.length).toBeGreaterThan(0);
    expect(codesOf(plan.findings)).not.toContain(RESERVE_REASON.RESERVE_CAPACITY_BELOW_REQUIREMENT);
    // Carried, not dropped: a caller asking about the ground rather than about
    // the branch still reads it.
    expect(
      plan.capacities.flatMap((report) => report.findings.map((finding) => finding.code))
    ).toContain(RESERVE_REASON.RESERVE_CAPACITY_BELOW_REQUIREMENT);
    // And the shortfall is reported in this plan's own vocabulary, per game.
    expect(plan.unrelocatable.length + plan.proposals.length).toBe(result.displaced.length);
  });

  it('says nothing of the sort on the acceptance run', () => {
    // The negative control, and the reason no acceptance figure moves: the
    // acceptance branch's one capacity report is `allowed` and every finding it
    // carries is `info`, so carrying it changes what is *reachable* and not what
    // is reported. An implementation that raised a blocking finding for every
    // report would pass everything above and fail here.
    const plan = result.relocations;
    for (const report of plan.capacities) {
      expect(report.status).not.toBe(SCENARIO_STATUS.REJECTED);
      expect(
        report.findings.filter((finding) => finding.severity !== CONSTRAINT_SEVERITY.INFO)
      ).toEqual([]);
    }
    expect(codesOf(plan.findings)).not.toContain(RESERVE_REASON.RESERVE_CAPACITY_VACUOUS);
    expect(codesOf(plan.findings)).not.toContain(RESERVE_REASON.RESERVED_SLOT_UNCOVERED);
    expect(result.status).toBe(SCENARIO_STATUS.COMPROMISED);
  });
});
