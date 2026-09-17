/**
 * **The metrics, and the populations they are read against.**
 *
 * ## What a metric is here
 *
 * A frozen registry entry with an id, a unit, the set of
 * {@link FAIRNESS_COMPETITION} values it counts, and one pure function from a
 * subject's fixtures to a number **or a stated refusal**. Nothing in this file
 * decides whether a value is good; it decides what the value is and whether it
 * could be obtained at all.
 *
 * Four are declared, and the reason for each is a question a club committee
 * actually asks:
 *
 * | id | question | unit |
 * |---|---|---|
 * | `games-played` | *"does every team get the same number of games?"* | fixtures |
 * | `hosting-share` | *"does every team host its share?"* | share of 1 |
 * | `mean-kickoff` | *"is one team always in the 8:30 slot?"* | minutes past midnight |
 * | `venue-spread` | *"is one team always the one that travels?"* | distinct venues |
 *
 * ## The three subject kinds, and what each is actually measured on
 *
 * The build plan asks for per-team, per-division and per-age-group metrics, and
 * the three are **not** three parallel computations:
 *
 * - A **team** is measured directly from its own fixtures.
 * - A **division** and an **age group** are measured as the *summary of their
 *   member teams' values* — the median of them, which is precisely the centre of
 *   the population those teams were judged against. Deliberate: it means every
 *   group figure the report publishes is the same number that decided a team's
 *   judgement, rather than a second aggregate computed a second way that is free
 *   to disagree with the first. A division's `mean-kickoff` of 731.67 is both
 *   "this division's typical kickoff" and "the centre `09G7v706` was 25 minutes
 *   away from", and there is no arrangement of the code in which those two
 *   differ.
 *
 * Summing a group's fixtures instead was considered and rejected: a division's
 * total game count is a function of how many teams are in it, so comparing two
 * divisions on it measures enrolment and calls the answer fairness.
 *
 * ## Three-valued, at the level of a single subject
 *
 * Every measurement is `measured` with a number or `unmeasurable` with a reason,
 * and {@link assertFairnessMeasurement} refuses any other arrangement. The
 * corpus exercises three distinct unmeasurable reasons without a line of
 * constructed input:
 *
 * - `FAIRNESS_SUBJECT_OUTSIDE_CLASS` — 18 participants hold no league fixture,
 *   so no league metric has anything to read for them. They are *reported*, not
 *   omitted and not scored zero, which is the difference between "these teams
 *   are outside this comparison" and "these teams got no games".
 * - `FAIRNESS_DENOMINATOR_EMPTY` — the four Minis sides have nine league
 *   fixtures each and **no two-sided one among them**, so hosting share has a
 *   denominator of zero. This is the trap the whole module is built around: as a
 *   number their hosting share is 9/9 = 1.0, the most extreme value in the
 *   season, and it is an artifact of a fixture format that writes the absent
 *   opponent as `-`.
 * - `FAIRNESS_GROUP_UNLABELLED` / `FAIRNESS_GROUP_AMBIGUOUS` — a subject with no
 *   key, or two keys, for a grouping is judged under no cohort for it rather
 *   than assigned to one.
 *
 * @module fairness/metrics
 */

import { FAIRNESS_COMPETITION, FAIRNESS_SIDE, isTwoSided } from './classification.js';
import { median } from './dispersion.js';
import {
  FAIRNESS_MEASURABILITY,
  FAIRNESS_REASON,
  assertFairnessMeasurement,
} from './reasonCodes.js';

/**
 * The kinds of thing a measurement can be about.
 *
 * @readonly
 * @enum {string}
 */
export const FAIRNESS_SUBJECT_KIND = Object.freeze({
  TEAM: 'team',
  DIVISION: 'division',
  AGE_GROUP: 'age-group',
});

/**
 * The declared metrics.
 *
 * @readonly
 * @enum {string}
 */
export const FAIRNESS_METRIC = Object.freeze({
  GAMES_PLAYED: 'games-played',
  HOSTING_SHARE: 'hosting-share',
  MEAN_KICKOFF: 'mean-kickoff',
  VENUE_SPREAD: 'venue-spread',
});

/**
 * Declared order, for deterministic rendering only.
 *
 * @type {ReadonlyArray<string>}
 */
export const FAIRNESS_METRIC_ORDER = Object.freeze([
  FAIRNESS_METRIC.GAMES_PLAYED,
  FAIRNESS_METRIC.HOSTING_SHARE,
  FAIRNESS_METRIC.MEAN_KICKOFF,
  FAIRNESS_METRIC.VENUE_SPREAD,
]);

/**
 * The unit of every metric, stated once. There is no unitless metric.
 *
 * `mean-kickoff` is **minutes past local midnight** and never a `Date`: the
 * corpus is wall-clock only and two of its dates fall after DST ends. The rule
 * outlives GAP-30's closure rather than depending on it — averaging `Date`
 * objects across a DST boundary is how a schedule acquires a phantom hour, and
 * that is true whether or not a composer exists.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const FAIRNESS_METRIC_UNIT = Object.freeze({
  [FAIRNESS_METRIC.GAMES_PLAYED]: 'fixtures',
  [FAIRNESS_METRIC.HOSTING_SHARE]: 'share of 1',
  [FAIRNESS_METRIC.MEAN_KICKOFF]: 'minutes past midnight',
  [FAIRNESS_METRIC.VENUE_SPREAD]: 'distinct venues',
});

/** Every metric in this module counts league fixtures and only league fixtures. */
const LEAGUE_ONLY = Object.freeze([FAIRNESS_COMPETITION.LEAGUE]);

/**
 * The distinct fixture ids of a list, sorted. **One fixture is one fixture**,
 * however many of the subjects a measurement is about happened to play in it.
 *
 * @param {ReadonlyArray<string>} fixtureIds
 * @returns {ReadonlyArray<string>}
 */
function distinctIds(fixtureIds) {
  return Object.freeze([...new Set(fixtureIds)].sort());
}

/**
 * The same list, refused rather than shortened if it names an id twice.
 *
 * The difference between this and {@link distinctIds} is the whole of finding
 * one. A metric's **value** is computed over the entry list — `entries.length`,
 * `hosted / twoSided.length`, a mean over `timed` — and the **count published
 * beside it** is the size of a set of ids. Deduplicating here makes the second
 * quietly smaller than the first: with two rows under `f1`, `games-played`
 * returned `value: 4` while its own evidence said `fixturesCounted: 3` and
 * named `['f1', 'f4', 'f5']`, and no finding anywhere said the two numbers were
 * about different things.
 *
 * The invariant is established at the module's boundary —
 * `classifyFairnessFixtures()` refuses a fixture list that repeats an id, so no
 * report or objective can reach this function with one. This is the same
 * invariant restated where it is relied on, for a caller who reaches
 * {@link measureSubject} directly, and it throws for the reason
 * {@link fairnessMetricOf} throws on an unregistered metric: it is a mistake in
 * the call, not a property of a season.
 *
 * @param {ReadonlyArray<string>} fixtureIds
 * @param {string} what - names the set in the failure
 * @returns {ReadonlyArray<string>}
 */
function uniqueIds(fixtureIds, what) {
  const seen = new Set();
  for (const fixtureId of fixtureIds) {
    if (seen.has(fixtureId)) {
      throw new Error(
        `fairness: the ${what} names fixture ${JSON.stringify(fixtureId)} twice; a count published as evidence must be over exactly the set its value was computed from, and one id over two rows makes them two different numbers wearing one name`
      );
    }
    seen.add(fixtureId);
  }
  return Object.freeze([...seen].sort());
}

/** The fixture ids of a list of counted entries. */
const idsOf = (entries) => entries.map((entry) => entry.fixture.fixtureId);

/**
 * One evidence record per measurement: what was read, what was set aside, why.
 *
 * **Every `fixtures*` number is the size of a set of distinct fixtures**, and
 * the set itself is published beside it: `fixturesCounted` is
 * `countedFixtureIds.length` and `fixturesExcluded` is
 * `excludedFixtureIds.length`, always, at every subject kind. The `exclusions`
 * breakdown is denominated the same way and its counts sum to
 * `fixturesExcluded`, because each id lands in exactly one bucket.
 *
 * That is the whole contract, and it is written down because it has now been
 * broken twice, both times in the same direction — a count larger than the
 * population it is drawn from:
 *
 * 1. {@link measureGroup} folded *"four member teams were unmeasurable"* into
 *    the same total as *"thirty-six fixtures named no opponent"* and published
 *    `fixturesExcluded: 40` about a division of 36 fixtures. Anything
 *    denominated in something other than fixtures now travels in a field of its
 *    own — see `membersCounted` / `membersExcluded`.
 * 2. {@link measureGroup} then **summed** its members' counts, so a two-sided
 *    league fixture was counted once for its home side and again for its away
 *    side: division `U05B` published 72 counted fixtures over the 36 it
 *    actually holds, `U06B` 108 for 54, `U07B` 126 for 63. The one division the
 *    test of the day pinned, `BB`, is the single division whose fixtures name no
 *    opponent — a 1:1 ratio that hid the general case. Hence the id sets: a
 *    union cannot double-count, and a reader can check the number by counting
 *    the rows it names.
 * 3. …and the id sets then opened the *opposite* divergence, which is the one
 *    this note is now longest about. `fixturesCounted` became the size of a set
 *    while every metric's **value** stayed a function of the entry list, and
 *    nothing made one id name one row: two rows sharing `f1` gave a team
 *    `value: 4` beside `fixturesCounted: 3` and `countedFixtureIds:
 *    ['f1', 'f4', 'f5']`, its division 4 counted over 5 rows, and
 *    `meta.fixturesCounted` a read-vs-counted shortfall that did not exist.
 *    A count and its value can only be derived separately while something holds
 *    them together, so `classifyFairnessFixtures()` now refuses a fixture list
 *    that repeats an id and {@link uniqueIds} restates the same invariant here,
 *    where it is relied on.
 * 4. …and it restated it on the **counted** list only. Every exclusion bucket
 *    ran its ids through `[...new Set(ids)]` instead, so the identical two rows
 *    under one id threw in a counted position and were silently shortened in an
 *    excluded one: two one-sided rows under `S1` published
 *    `fixturesExcluded: 1` about the two rows the subject holds, and
 *    `counted + excluded === rows held` — the identity the whole contract above
 *    rests on — was false with nothing to say so. So this function is now the
 *    **one place** the invariant is enforced, over every id it is handed, in
 *    whichever list: there is no path to a `FairnessEvidence` that does not run
 *    through it, and no id in one that it has not seen.
 *
 * Evidence a reader can check by hand is the point of this module.
 *
 * @param {ReadonlyArray<string>} countedFixtureIds
 * @param {ReadonlyArray<[string, ReadonlyArray<string>]>} exclusions - fixture ids, only
 * @returns {import('./types.js').FairnessEvidence}
 */
function evidence(countedFixtureIds, exclusions = []) {
  const counted = uniqueIds(countedFixtureIds, 'counted evidence');
  // One id, one row, one place in the accounting — over every list, because a
  // bucket that quietly shortened itself broke the same identity the counted
  // list is guarded for. A fixture the metric counted is never also an
  // exclusion, and a fixture in two buckets would make them sum to less than
  // the total they claim to break down; both are refused rather than absorbed.
  const seen = new Set(counted);
  /** @type {Array<[string, number]>} */ const buckets = [];
  /** @type {string[]} */ const excluded = [];
  for (const [reason, ids] of exclusions) {
    const fresh = uniqueIds(ids, `${reason} exclusion`);
    for (const fixtureId of fresh) {
      if (seen.has(fixtureId)) {
        throw new Error(
          `fairness: fixture ${JSON.stringify(fixtureId)} is accounted for twice in one measurement's evidence, the second time under ${JSON.stringify(reason)}; every number published here is the size of a set of rows and a row belongs to exactly one of those sets, so an id in two of them makes the parts sum to something other than the whole they break down`
        );
      }
      seen.add(fixtureId);
    }
    excluded.push(...fresh);
    buckets.push([reason, fresh.length]);
  }
  return Object.freeze({
    fixturesCounted: counted.length,
    fixturesExcluded: excluded.length,
    countedFixtureIds: counted,
    excludedFixtureIds: distinctIds(excluded),
    exclusions: Object.freeze(buckets.filter(([, count]) => count > 0)),
  });
}

/**
 * **The frozen metric registry.**
 *
 * Each `measure` takes the subject's counted fixtures — `{ fixture, side }`
 * records, already filtered to the metric's competitions — and returns either a
 * value or a reason code, never both and never neither.
 *
 * @type {Readonly<Record<string, import('./types.js').FairnessMetricDefinition>>}
 */
export const FAIRNESS_METRIC_REGISTRY = Object.freeze({
  [FAIRNESS_METRIC.GAMES_PLAYED]: Object.freeze({
    id: FAIRNESS_METRIC.GAMES_PLAYED,
    unit: FAIRNESS_METRIC_UNIT[FAIRNESS_METRIC.GAMES_PLAYED],
    label: 'league fixtures played',
    counts: LEAGUE_ONLY,
    measure(entries) {
      return { value: entries.length, reasonCode: null, evidence: evidence(idsOf(entries)) };
    },
  }),

  [FAIRNESS_METRIC.HOSTING_SHARE]: Object.freeze({
    id: FAIRNESS_METRIC.HOSTING_SHARE,
    unit: FAIRNESS_METRIC_UNIT[FAIRNESS_METRIC.HOSTING_SHARE],
    label: 'share of two-sided league fixtures hosted',
    counts: LEAGUE_ONLY,
    measure(entries) {
      const twoSided = entries.filter((entry) => isTwoSided(entry.fixture));
      const oneSided = entries.filter((entry) => !isTwoSided(entry.fixture));
      if (twoSided.length === 0) {
        return {
          value: null,
          reasonCode: FAIRNESS_REASON.FAIRNESS_DENOMINATOR_EMPTY,
          evidence: evidence([], [['fixture-names-no-opponent', idsOf(oneSided)]]),
        };
      }
      const hosted = twoSided.filter((entry) => entry.side === FAIRNESS_SIDE.HOME).length;
      return {
        value: hosted / twoSided.length,
        reasonCode: null,
        evidence: evidence(idsOf(twoSided), [['fixture-names-no-opponent', idsOf(oneSided)]]),
      };
    },
  }),

  [FAIRNESS_METRIC.MEAN_KICKOFF]: Object.freeze({
    id: FAIRNESS_METRIC.MEAN_KICKOFF,
    unit: FAIRNESS_METRIC_UNIT[FAIRNESS_METRIC.MEAN_KICKOFF],
    label: 'mean kickoff across league fixtures',
    counts: LEAGUE_ONLY,
    measure(entries) {
      const timed = entries.filter((entry) => Number.isFinite(entry.fixture.kickoffMinutes));
      const untimed = entries.filter((entry) => !Number.isFinite(entry.fixture.kickoffMinutes));
      if (timed.length === 0) {
        return {
          value: null,
          reasonCode: FAIRNESS_REASON.FAIRNESS_VALUE_UNAVAILABLE,
          evidence: evidence([], [['fixture-has-no-kickoff', idsOf(untimed)]]),
        };
      }
      const total = timed.reduce((sum, entry) => sum + entry.fixture.kickoffMinutes, 0);
      return {
        value: total / timed.length,
        reasonCode: null,
        evidence: evidence(idsOf(timed), [['fixture-has-no-kickoff', idsOf(untimed)]]),
      };
    },
  }),

  [FAIRNESS_METRIC.VENUE_SPREAD]: Object.freeze({
    id: FAIRNESS_METRIC.VENUE_SPREAD,
    unit: FAIRNESS_METRIC_UNIT[FAIRNESS_METRIC.VENUE_SPREAD],
    label: 'distinct venues visited across league fixtures',
    counts: LEAGUE_ONLY,
    measure(entries) {
      const located = entries.filter((entry) => entry.fixture.venueId !== null);
      const unlocated = entries.filter((entry) => entry.fixture.venueId === null);
      if (located.length === 0) {
        return {
          value: null,
          reasonCode: FAIRNESS_REASON.FAIRNESS_VALUE_UNAVAILABLE,
          evidence: evidence([], [['fixture-has-no-venue', idsOf(unlocated)]]),
        };
      }
      const venues = new Set(located.map((entry) => entry.fixture.venueId));
      return {
        value: venues.size,
        reasonCode: null,
        evidence: evidence(idsOf(located), [['fixture-has-no-venue', idsOf(unlocated)]]),
      };
    },
  }),
});

/**
 * One measurement's evidence, plus the fixtures of a competition the metric
 * does not count and therefore never saw.
 *
 * The two id sets are disjoint, and that is **asserted rather than assumed**.
 * It is true today by construction — {@link measureSubject} partitions the
 * subject's rows on `metric.counts`, so a row is handed to the metric or set
 * aside and never both, and one id names one row — but the identity that rests
 * on it fails silently if either premise stops holding: `fixturesExcluded` is
 * the size of the **union** while `exclusions` is a list of **bucket sizes**,
 * so an overlapping id would make the buckets sum to more than the total they
 * claim to break down, with nothing in the arithmetic to object. The check is
 * one set lookup per set-aside id.
 *
 * @param {import('./types.js').FairnessEvidence} base
 * @param {ReadonlyArray<string>} setAsideFixtureIds
 * @returns {import('./types.js').FairnessEvidence}
 */
function withSetAside(base, setAsideFixtureIds) {
  const setAside = uniqueIds(setAsideFixtureIds, 'set-aside evidence');
  const already = new Set([...base.countedFixtureIds, ...base.excludedFixtureIds]);
  for (const fixtureId of setAside) {
    if (already.has(fixtureId)) {
      throw new Error(
        `fairness: fixture ${JSON.stringify(fixtureId)} is both read by this metric and set aside as another competition's; the two sets are disjoint by construction, and an overlap makes the exclusion breakdown sum to more than the total it breaks down`
      );
    }
  }
  const excluded = distinctIds([...base.excludedFixtureIds, ...setAside]);
  return Object.freeze({
    fixturesCounted: base.fixturesCounted,
    fixturesExcluded: excluded.length,
    countedFixtureIds: base.countedFixtureIds,
    excludedFixtureIds: excluded,
    exclusions: Object.freeze(
      /** @type {Array<[string, number]>} */ ([
        ...base.exclusions,
        ['fixture-of-another-competition', setAside.length],
      ]).filter(([, count]) => count > 0)
    ),
  });
}

/**
 * **The metric a caller named, or a refusal naming what it is not.**
 *
 * Adopted from `scoreFairnessObjective()`'s treatment of an unregistered
 * `objectiveId` rather than invented a second time: a metric id nobody declared
 * is a mistake in the *call*, not a property of the season, and the answer to it
 * is the same answer that module already gives. It is emphatically not a silent
 * filter — `metricIds: ['mean-kickof']` used to select nothing, run nothing, and
 * come back `rejected` with `FAIRNESS_NOTHING_JUDGED`, which tells an operator
 * their data is unjudgeable when what happened is that they misspelled an
 * argument.
 *
 * @param {string} metricId
 * @returns {import('./types.js').FairnessMetricDefinition}
 */
export function fairnessMetricOf(metricId) {
  const metric = FAIRNESS_METRIC_REGISTRY[metricId];
  if (!metric) {
    throw new Error(
      `fairness: metric ${JSON.stringify(metricId)} is not a member of FAIRNESS_METRIC; the declared metrics are ${FAIRNESS_METRIC_ORDER.map((id) => JSON.stringify(id)).join(', ')}`
    );
  }
  return metric;
}

/**
 * Build one measurement, through the guard that keeps the two-state
 * measurability honest.
 *
 * @param {import('./types.js').FairnessMetricDefinition} metric
 * @param {string} subjectKind - a {@link FAIRNESS_SUBJECT_KIND} value
 * @param {string} subjectId
 * @param {ReadonlyArray<{ fixture: import('./types.js').FairnessFixture, side: string }>} allEntries
 * @returns {import('./types.js').FairnessMeasurement}
 */
export function measureSubject(metric, subjectKind, subjectId, allEntries) {
  const counted = allEntries.filter((entry) => metric.counts.includes(entry.fixture.competition));
  const setAside = allEntries.filter((entry) => !metric.counts.includes(entry.fixture.competition));

  if (counted.length === 0) {
    return assertFairnessMeasurement({
      metricId: metric.id,
      unit: metric.unit,
      subjectKind,
      subjectId,
      measurability: FAIRNESS_MEASURABILITY.UNMEASURABLE,
      value: null,
      reasonCode: FAIRNESS_REASON.FAIRNESS_SUBJECT_OUTSIDE_CLASS,
      // Through {@link withSetAside}, exactly as the measured return below —
      // this path used to name the bucket itself and so reached neither its
      // disjointness assertion nor, before finding two, `uniqueIds()` on the
      // set-aside list. The output is the same evidence either way; what
      // differs is that a subject whose rows are all of another competition is
      // now held to the same accounting as one whose rows are read.
      evidence: withSetAside(evidence([]), idsOf(setAside)),
    });
  }

  const result = metric.measure(counted);
  return assertFairnessMeasurement({
    metricId: metric.id,
    unit: metric.unit,
    subjectKind,
    subjectId,
    measurability:
      result.value === null ? FAIRNESS_MEASURABILITY.UNMEASURABLE : FAIRNESS_MEASURABILITY.MEASURED,
    value: result.value,
    reasonCode: result.reasonCode,
    // The metric's own exclusions, plus the fixtures of another competition it
    // never saw. The two sets are disjoint — the metric was only ever handed
    // fixtures of the competitions it counts — so the union's size is the sum,
    // and the id sets stay the published evidence for both numbers.
    evidence: withSetAside(result.evidence, idsOf(setAside)),
  });
}

/**
 * Measure every team subject on the requested metrics.
 *
 * `metricIds` defaults to every declared metric and is **read**, not decorative:
 * a report restricted to one metric must publish measurements about one metric.
 * It used to measure all four whatever it was asked for, which put 588
 * measurements and findings about three unrequested metrics into a report that
 * asked for one — a filter that silently does nothing being worse than no
 * filter, because the caller cannot tell it did nothing.
 *
 * @param {Map<string, import('./types.js').FairnessParticipation>} participation
 * @param {ReadonlyArray<string>} [metricIds] - {@link FAIRNESS_METRIC} values
 * @returns {import('./types.js').FairnessMeasurement[]}
 */
export function measureTeams(participation, metricIds = FAIRNESS_METRIC_ORDER) {
  const metrics = metricIds.map((metricId) => fairnessMetricOf(metricId));
  /** @type {import('./types.js').FairnessMeasurement[]} */
  const measurements = [];
  for (const subjectId of [...participation.keys()].sort()) {
    const entry = /** @type {import('./types.js').FairnessParticipation} */ (
      participation.get(subjectId)
    );
    for (const metric of metrics) {
      measurements.push(
        measureSubject(metric, FAIRNESS_SUBJECT_KIND.TEAM, subjectId, entry.fixtures)
      );
    }
  }
  return measurements;
}

/**
 * The group key a subject holds for a grouping, or a stated refusal.
 *
 * Three answers, never two. `null` with `FAIRNESS_GROUP_UNLABELLED` is a subject
 * the corpus gives no key for — the four Minis sides play in division `BB`,
 * which parses to no age group at all — and `null` with
 * `FAIRNESS_GROUP_AMBIGUOUS` is a subject with two (GAP-24). Neither is assigned
 * to a cohort by picking one, which is what `buildTeams()` already refuses to do
 * for the same subject.
 *
 * The keys handed in here are the ones the metric's **own competitions** supply,
 * because both callers build them with {@link cohortKeysBySubject} —
 * `fairnessReport()` and `scoreFairnessObjective()` alike. That sentence was
 * true of the report and false of the objective for one commit, which is the
 * worst of the three states: the objective kept grouping on every label a
 * subject carried anywhere while this docstring said otherwise, so one friendly
 * spelled `10B` against league rows spelled `U10B` made a team
 * `FAIRNESS_GROUP_AMBIGUOUS` in the objective and `U10B` in the report — two
 * answers about one subject, with a comment asserting they agreed.
 *
 * It also changes which of the two refusals season-2026 exercises:
 * `16GSelect02` is listed as `16GS` on one row and `U16G` on another, but both
 * rows are scrimmages and it holds no league fixture, so under a league metric
 * it is *unlabelled* rather than ambiguous. Two spellings on two friendlies are
 * not a reason to refuse a team its league division, and this corpus holds no
 * subject with two league labels; the ambiguous branch is driven from
 * constructed league input in `tests/reasonCodeReachability.test.js`.
 *
 * @param {ReadonlySet<string>} keys
 * @returns {{ key: string|null, reasonCode: string|null }}
 */
export function groupKeyOf(keys) {
  if (keys.size === 1) return { key: [...keys][0], reasonCode: null };
  if (keys.size === 0) {
    return { key: null, reasonCode: FAIRNESS_REASON.FAIRNESS_GROUP_UNLABELLED };
  }
  return { key: null, reasonCode: FAIRNESS_REASON.FAIRNESS_GROUP_AMBIGUOUS };
}

/**
 * **The division and age-group labels a subject carries in one class of fixture.**
 *
 * Not `participation.divisions` / `.ageGroups`, which are the labels a subject
 * carries anywhere: those are the right answer to *"what has this team been
 * called?"* and the wrong one to *"which league cohort is it judged in?"*.
 *
 * It lives here, beside {@link groupKeyOf}, rather than in either of its
 * callers, because both entry points must answer that question the same way and
 * the one commit in which only `report.js` held a copy is the one in which they
 * did not.
 *
 * @param {Map<string, import('./types.js').FairnessParticipation>} participation
 * @param {ReadonlyArray<string>} counts - the competitions the metric reads
 * @returns {{ divisions: Map<string, Set<string>>, ageGroups: Map<string, Set<string>> }}
 */
export function cohortKeysBySubject(participation, counts) {
  /** @type {Map<string, Set<string>>} */ const divisions = new Map();
  /** @type {Map<string, Set<string>>} */ const ageGroups = new Map();
  for (const [subjectId, entry] of participation) {
    /** @type {Set<string>} */ const division = new Set();
    /** @type {Set<string>} */ const ageGroup = new Set();
    for (const held of entry.fixtures) {
      if (!counts.includes(held.fixture.competition)) continue;
      if (held.fixture.division !== null) division.add(held.fixture.division);
      if (held.fixture.ageGroup !== null) ageGroup.add(held.fixture.ageGroup);
    }
    divisions.set(subjectId, division);
    ageGroups.set(subjectId, ageGroup);
  }
  return { divisions, ageGroups };
}

/**
 * **Measure a division or an age group: the median of its teams' values.**
 *
 * See the module note — this is deliberately the same number the group's own
 * population supplies as its centre, so the figure the report publishes about a
 * division and the figure a team was judged against cannot drift apart.
 *
 * A group whose member teams are all unmeasurable on a metric is itself
 * unmeasurable on it, and says so: division `BB` has four teams and no hosting
 * share, because none of its thirty-six fixtures names an opponent.
 *
 * @param {string} subjectKind - {@link FAIRNESS_SUBJECT_KIND} DIVISION or AGE_GROUP
 * @param {string} groupKey
 * @param {string} metricId
 * @param {ReadonlyArray<import('./types.js').FairnessMeasurement>} memberMeasurements
 * @returns {import('./types.js').FairnessMeasurement}
 */
export function measureGroup(subjectKind, groupKey, metricId, memberMeasurements) {
  const metric = fairnessMetricOf(metricId);
  const usable = memberMeasurements.filter(
    (measurement) => measurement.measurability === FAIRNESS_MEASURABILITY.MEASURED
  );
  // The median, not `describeDispersion()`'s centre: a group's own value is
  // well defined for any non-empty membership, and the four-member floor in
  // `dispersion.js` governs whether a *deviation* can be scored, which is a
  // different question. Conflating them would leave a three-team division with
  // no published typical kickoff at all.
  const centre = median(usable.map((measurement) => /** @type {number} */ (measurement.value)));
  // **Distinct fixtures the group's members were measured over**, over **every**
  // member — a union and not a sum. A two-sided league fixture is one fixture
  // and is named by both of the teams that played it, so summing counted a
  // division of 36 fixtures as 72 and said so in a field denominated in
  // fixtures. An unmeasurable member contributes no counted fixture, so the
  // union over every member is the same set as the union over the measurable
  // ones — written over every member so the identity is one a test can assert
  // rather than one that happens to hold.
  const counted = distinctIds(
    memberMeasurements.flatMap((measurement) => measurement.evidence.countedFixtureIds)
  );
  // A fixture one member could not be measured on and another was is a fixture
  // this group was measured over; it is counted, and it is not also excluded.
  const countedSet = new Set(counted);
  const excluded = distinctIds(
    memberMeasurements
      .flatMap((measurement) => measurement.evidence.excludedFixtureIds)
      .filter((fixtureId) => !countedSet.has(fixtureId))
  );
  return assertFairnessMeasurement({
    metricId,
    unit: metric.unit,
    subjectKind,
    subjectId: groupKey,
    measurability:
      centre === null ? FAIRNESS_MEASURABILITY.UNMEASURABLE : FAIRNESS_MEASURABILITY.MEASURED,
    value: centre,
    reasonCode: centre === null ? unanimousReasonOf(memberMeasurements) : null,
    evidence: {
      // Fixtures, and only fixtures, in the fixture fields — the member tally
      // is real evidence and is published under its own name rather than added
      // to a count of rows it is not denominated in. See `evidence()`.
      ...evidence(counted, [['fixture-not-counted-by-metric', excluded]]),
      membersCounted: usable.length,
      membersExcluded: memberMeasurements.length - usable.length,
    },
  });
}

/**
 * The reason an unmeasurable group carries: its members', when they agree.
 *
 * A division whose every team is `FAIRNESS_SUBJECT_OUTSIDE_CLASS` is outside the
 * class itself, and saying `FAIRNESS_DENOMINATOR_EMPTY` about it would be true
 * of the arithmetic and wrong about the cause — `Select` has no league median
 * because none of its teams plays a league fixture, not because a denominator
 * happened to be zero. Where the members disagree, or where there are none, the
 * honest answer is the arithmetic one.
 *
 * @param {ReadonlyArray<import('./types.js').FairnessMeasurement>} memberMeasurements
 * @returns {string}
 */
export function unanimousReasonOf(memberMeasurements) {
  const reasons = new Set(
    memberMeasurements.map((measurement) => measurement.reasonCode).filter((code) => code !== null)
  );
  return reasons.size === 1
    ? /** @type {string} */ ([...reasons][0])
    : FAIRNESS_REASON.FAIRNESS_DENOMINATOR_EMPTY;
}
