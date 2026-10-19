/**
 * Fairness and equity metrics — Prompt 7.2.
 *
 * > *Is anybody being treated unlike their peers — and is that a real inequity,
 * > or a property of how the fixture list is written?*
 *
 * Five properties are what this file is for, and each has a positive control
 * that is **constructed** rather than asserted:
 *
 * 1. **The league / external / friendly distinction is load bearing, and the
 *    number of false positives it removes is measured, not claimed.** The same
 *    metric is run with the distinction and without it, on the same corpus, and
 *    the difference is asserted as a figure.
 * 2. **Every flag publishes its comparison basis and its arithmetic.** Swept
 *    over every flag of every shape, with a meta-assertion that the sweep saw
 *    one.
 * 3. **Three-valued, never two.** `typical` and `undecided` are shown to be
 *    different answers, and the collapse is attempted deliberately to show it
 *    fails.
 * 4. **Every meta-assertion can fail**, and the input that makes each fail is
 *    built here and run through the public entry point.
 * 5. **An unmeasurable subject contributes nothing to an objective, and is
 *    counted.** Shown by constructing the schedule that would score better under
 *    the fold-into-zero version.
 *
 * Every figure below is derived from the corpus at test time. Nothing is
 * hand-copied except the counts the corpus README itself declares.
 *
 * **Test-hygiene note.** No corpus lookup is dereferenced in a `describe` body:
 * a `TypeError` at file load fails the whole file instead of firing the
 * meta-assertion that was supposed to catch it. Every subject is built inside a
 * test through {@link corpusReport} / {@link corpusFixtures}, which memoise.
 */

import { describe, it, expect, vi } from 'vitest';

import {
  FAIRNESS_BASIS,
  FAIRNESS_COMPETITION,
  FAIRNESS_COMPETITION_ORDER,
  FAIRNESS_DISPERSION,
  FAIRNESS_JUDGEMENT,
  FAIRNESS_MEASURABILITY,
  FAIRNESS_METRIC,
  FAIRNESS_METRIC_ORDER,
  FAIRNESS_METRIC_REGISTRY,
  FAIRNESS_OBJECTIVE,
  FAIRNESS_OBJECTIVE_COMPETITIONS,
  FAIRNESS_OBJECTIVE_REGISTRY,
  FAIRNESS_OBJECTIVE_SENSE,
  FAIRNESS_REASON,
  FAIRNESS_REASON_SEVERITY,
  FAIRNESS_SEVERITY,
  FAIRNESS_SIDE,
  FAIRNESS_STATUS,
  FAIRNESS_SUBJECT_KIND,
  MIN_POPULATION_FOR_DISPERSION,
  OUTLIER_SCORE_THRESHOLD,
  assertFairnessMeasurement,
  assertFlagEvidence,
  compareObjectiveScores,
  classifyFairnessFixtures,
  describeDispersion,
  describeRefusedValue,
  deriveFairnessJudgement,
  countedFixturesOf,
  fairnessReport,
  groupKeyOf,
  measureSubject,
  median,
  medianAbsoluteDeviation,
  modifiedZScore,
  participationOf,
  scoreFairnessObjective,
  toSeason2026FairnessFixtures,
} from '@squadlogic/core/fairness/index.js';
import { loadCoachRoster, loadCombinedSchedule } from '@squadlogic/core/fixtures/index.js';

// The full-season report is derived four times over in this file (plain,
// without the competition distinction, and twice under constructed variants),
// each over 578 fixtures and 156 populations. CI runs roughly 1.4x slower than
// the development machine, which puts the slowest case within a factor of two
// of vitest's 5s default.
vi.setConfig({ testTimeout: 30_000 });

/* -------------------------------------------------------------------------- */
/* Corpus subjects, built inside tests and memoised                            */
/* -------------------------------------------------------------------------- */

/** @type {{ rows: any[]|null, fixtures: any|null, report: any|null, teams: Set<string>|null }} */
const cache = { rows: null, fixtures: null, report: null, teams: null };

function corpusRows() {
  if (cache.rows === null) cache.rows = loadCombinedSchedule();
  return cache.rows;
}

function corpusFixtures() {
  if (cache.fixtures === null) cache.fixtures = toSeason2026FairnessFixtures(corpusRows());
  return cache.fixtures;
}

function corpusReport() {
  if (cache.report === null) cache.report = fairnessReport({ fixtures: corpusFixtures().fixtures });
  return cache.report;
}

function rosterTeamIds() {
  if (cache.teams === null) {
    cache.teams = new Set(loadCoachRoster().map((assignment) => assignment.teamCode));
  }
  return cache.teams;
}

/** Deep-freeze, so "reads its input and writes nothing" is tested and not promised. */
function deepFreeze(value, seen = new Set()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const inner of Object.values(value)) deepFreeze(inner, seen);
  return Object.freeze(value);
}

/** Every measurement for one metric and subject kind. */
function measurementsOf(report, metricId, subjectKind) {
  return report.measurements.filter(
    (measurement) => measurement.metricId === metricId && measurement.subjectKind === subjectKind
  );
}

function findingsOf(report, code) {
  return report.findings.filter((finding) => finding.code === code);
}

/** A minimal league fixture, for the constructed cases. */
function fixture(overrides = {}) {
  return {
    fixtureId: 'f1',
    scopeId: 'constructed',
    competition: FAIRNESS_COMPETITION.LEAGUE,
    date: '2026-08-22',
    kickoffMinutes: 600,
    venueId: 'venue-a',
    surfaceId: 'venue-a/pitch-1',
    division: 'U10B',
    ageGroup: 'U10',
    format: '7v7',
    homeSubjectId: 'home',
    awaySubjectId: 'away',
    ...overrides,
  };
}

/**
 * A round robin among `teamCount` teams over `rounds` dates, every fixture two
 * sided and at `kickoff`. The base every constructed case perturbs.
 */
function roundRobin({ teamCount, rounds, kickoff = 600, division = 'U10B', ageGroup = 'U10' }) {
  const teams = Array.from({ length: teamCount }, (unused, index) => `T${index + 1}`);
  const fixtures = [];
  for (let round = 0; round < rounds; round += 1) {
    for (let pair = 0; pair < Math.floor(teamCount / 2); pair += 1) {
      const home = teams[(pair + round) % teamCount];
      const away = teams[(teamCount - 1 - pair + round) % teamCount];
      if (home === away) continue;
      fixtures.push(
        fixture({
          fixtureId: `r${round}-p${pair}`,
          date: `2026-09-${String(round + 1).padStart(2, '0')}`,
          kickoffMinutes: kickoff,
          division,
          ageGroup,
          homeSubjectId: round % 2 === 0 ? home : away,
          awaySubjectId: round % 2 === 0 ? away : home,
        })
      );
    }
  }
  return fixtures;
}

/* -------------------------------------------------------------------------- */
/* 1. The corpus, and the five claims about it                                 */
/* -------------------------------------------------------------------------- */

describe('fairness :: what the corpus actually contains', () => {
  it('counts 140 participants, not 152 and not 141', () => {
    const rows = corpusRows();
    const naive = new Set();
    for (const row of rows) {
      naive.add(row.homeLabel);
      naive.add(row.awayLabel);
    }
    // The naive read of the Home/Away columns.
    expect(naive.size).toBe(152);

    // Excluding only the `-` token and the ten `Select Game N` labels leaves
    // 141 — which is still one too many, because `Scrimmage - teams TBD` is a
    // third placeholder and an eleven-label exclusion list misses it.
    const withoutTwoKinds = [...naive].filter(
      (label) => label.trim() !== '-' && !/^Select Game \d+$/.test(label)
    );
    expect(withoutTwoKinds.length).toBe(141);
    expect(withoutTwoKinds).toContain('Scrimmage - teams TBD');

    const report = corpusReport();
    expect(report.meta.subjectsConsidered).toBe(140);
    expect([...report.measurements.map((m) => m.subjectId)]).not.toContain('Scrimmage - teams TBD');
  });

  it('splits 122 league participants from 18 that hold no league fixture, and 13 of the 18 are the club’s own teams', () => {
    const report = corpusReport();
    const gamesPlayed = measurementsOf(
      report,
      FAIRNESS_METRIC.GAMES_PLAYED,
      FAIRNESS_SUBJECT_KIND.TEAM
    );
    const measured = gamesPlayed.filter((m) => m.measurability === FAIRNESS_MEASURABILITY.MEASURED);
    const outside = gamesPlayed.filter(
      (m) => m.reasonCode === FAIRNESS_REASON.FAIRNESS_SUBJECT_OUTSIDE_CLASS
    );
    expect(measured).toHaveLength(122);
    expect(outside).toHaveLength(18);
    expect(measured.every((m) => m.value === 9)).toBe(true);

    // The distribution among the 18: 14 play one fixture and 4 play two, and
    // this is where "those 19 are visiting clubs" goes wrong. Only five are.
    const participation = participationOf(corpusFixtures().fixtures);
    const counts = outside.map((m) => participation.get(m.subjectId).fixtures.length).sort();
    expect(counts.filter((n) => n === 1)).toHaveLength(14);
    expect(counts.filter((n) => n === 2)).toHaveLength(4);

    const roster = rosterTeamIds();
    const onRoster = outside.filter((m) => roster.has(m.subjectId));
    expect(onRoster).toHaveLength(13);
    expect(outside.filter((m) => !roster.has(m.subjectId))).toHaveLength(5);
    expect(outside.filter((m) => m.subjectId.startsWith('Visiting Club'))).toHaveLength(5);
  });

  it('finds every division and age-group cohort perfectly equal on game count', () => {
    const report = corpusReport();
    const populations = report.populations.filter(
      (population) =>
        population.metricId === FAIRNESS_METRIC.GAMES_PLAYED &&
        population.subjectKind === FAIRNESS_SUBJECT_KIND.TEAM
    );
    // Meta-assertion: a uniform verdict over zero populations is incident 4.
    expect(populations.length).toBeGreaterThan(0);
    const scoreable = populations.filter(
      (population) => population.dispersion.size >= MIN_POPULATION_FOR_DISPERSION
    );
    // 15 division cohorts, 7 age-group cohorts and the season cohort. The six
    // cohorts whose members all sit outside the league — divisions 16BS, 16GS,
    // U14 and U16G, and age groups U14 and U16 — have no measurable member at
    // all and are below the floor rather than uniform.
    expect(scoreable).toHaveLength(23);
    expect(
      scoreable.every((population) => population.dispersion.state === FAIRNESS_DISPERSION.UNIFORM)
    ).toBe(true);
    expect(scoreable.every((population) => population.dispersion.centre === 9)).toBe(true);
    // And a uniform population judges its *measured* members `typical`, not
    // `undecided`: "everybody here is identical" is an answer, not a shrug.
    const inUniform = report.judgements.filter(
      (judgement) =>
        judgement.metricId === FAIRNESS_METRIC.GAMES_PLAYED &&
        judgement.dispersionState === FAIRNESS_DISPERSION.UNIFORM
    );
    const judged = inUniform.filter((judgement) => judgement.value !== null);
    expect(judged.length).toBeGreaterThan(0);
    expect(judged.every((judgement) => judgement.judgement === FAIRNESS_JUDGEMENT.TYPICAL)).toBe(
      true
    );
    // A subject that could not be measured stays `undecided` even inside a
    // uniform cohort — the cohort's equality says nothing about a member whose
    // value was never obtained. On this corpus those are the 18 that hold no
    // league fixture, judged under the season cohort.
    const unmeasuredInUniform = inUniform.filter(
      (judgement) =>
        judgement.value === null && judgement.subjectKind === FAIRNESS_SUBJECT_KIND.TEAM
    );
    expect(unmeasuredInUniform).toHaveLength(18);
    expect(
      unmeasuredInUniform.every(
        (judgement) =>
          judgement.judgement === FAIRNESS_JUDGEMENT.UNDECIDED &&
          judgement.reasonCode === FAIRNESS_REASON.FAIRNESS_SUBJECT_OUTSIDE_CLASS
      )
    ).toBe(true);
  });

  it('confirms the corpus’ own day, venue and division figures over the 140 participants', () => {
    const { fixtures } = corpusFixtures();
    const participation = participationOf(fixtures);
    const dayOf = (iso) => {
      // Zeller's congruence. No `Date` construction anywhere (GAP-30).
      const [year, month, day] = iso.split('-').map(Number);
      const shiftedMonth = month < 3 ? month + 12 : month;
      const shiftedYear = month < 3 ? year - 1 : year;
      const k = shiftedYear % 100;
      const j = Math.floor(shiftedYear / 100);
      const h =
        (day +
          Math.floor((13 * (shiftedMonth + 1)) / 5) +
          k +
          Math.floor(k / 4) +
          Math.floor(j / 4) +
          5 * j) %
        7;
      return ['SAT', 'SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI'][h];
    };

    let saturdayOnly = 0;
    let sundayOnly = 0;
    let both = 0;
    const venueCounts = new Map();
    for (const entry of participation.values()) {
      const days = new Set(entry.fixtures.map((held) => dayOf(held.fixture.date)));
      const key = [...days].sort().join(',');
      if (key === 'SAT') saturdayOnly += 1;
      else if (key === 'SUN') sundayOnly += 1;
      else if (key === 'SAT,SUN') both += 1;
      const venues = new Set(entry.fixtures.map((held) => held.fixture.venueId)).size;
      venueCounts.set(venues, (venueCounts.get(venues) ?? 0) + 1);
    }
    expect({ saturdayOnly, sundayOnly, both }).toEqual({
      saturdayOnly: 132,
      sundayOnly: 5,
      both: 3,
    });
    expect(venueCounts.get(1)).toBe(111);
    expect(venueCounts.get(2)).toBe(29);
    expect(saturdayOnly + sundayOnly + both).toBe(140);

    const divisions = [...new Set(corpusRows().map((row) => row.division))].sort();
    expect(divisions).toEqual([
      '16BS',
      '16GS',
      'BB',
      'Select',
      'U05B',
      'U05G',
      'U06B',
      'U06G',
      'U07B',
      'U07G',
      'U08B',
      'U08G',
      'U09B',
      'U09G',
      'U10B',
      'U10G',
      'U12B',
      'U12G',
      'U14',
      'U16G',
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* 2. The distinction, measured against its own absence                        */
/* -------------------------------------------------------------------------- */

describe('fairness :: the league / external / friendly distinction', () => {
  it('maps every corpus row kind, drops the 101 that name nobody, and refuses an unknown kind', () => {
    const { fixtures, droppedByRowKind, rowsRead } = corpusFixtures();
    expect(rowsRead).toBe(679);
    expect(droppedByRowKind).toEqual({ league_placeholder: 100, reservation: 1 });
    expect(fixtures).toHaveLength(578);

    const classification = classifyFairnessFixtures(fixtures);
    expect(classification.usable).toBe(true);
    expect(classification.byCompetition).toEqual({ league: 567, external: 8, friendly: 3 });
    // 567 league rows is the corpus README's own published-rec-game count.
    expect(classification.byCompetition.league).toBe(567);
  });

  it('removes 19 false flags about 15 non-league participants, and restores 7 real ones', () => {
    const { fixtures } = corpusFixtures();

    // The control: the same corpus with the distinction erased, so the eight
    // external seeding games and the three scrimmages count as league fixtures.
    const flattened = fixtures.map((held) => ({
      ...held,
      competition: FAIRNESS_COMPETITION.LEAGUE,
    }));
    const naive = fairnessReport({ fixtures: flattened });
    const report = corpusReport();
    const key = (flag) => `${flag.subjectId}|${flag.metricId}|${flag.basis.kind}`;
    const naiveKeys = new Set(naive.flags.map(key));
    const realKeys = new Set(report.flags.map(key));

    expect(naive.flags).toHaveLength(21);
    expect(report.flags).toHaveLength(9);

    // Every flag the naive report raises and this one does not is about a
    // participant that holds no league fixture at all — a guest of another
    // league, or a Select side whose league layer is 100 unassigned slots.
    const naiveOnly = [...naiveKeys].filter((entry) => !realKeys.has(entry));
    expect(naiveOnly).toHaveLength(19);
    const participation = participationOf(fixtures);
    const accused = [...new Set(naiveOnly.map((entry) => entry.split('|')[0]))];
    expect(accused).toHaveLength(15);
    expect(
      accused.every((subjectId) => participation.get(subjectId).byCompetition.league === 0)
    ).toBe(true);

    // And it works in both directions: seven real signals are *drowned* without
    // the distinction, because a season population polluted with fourteen
    // one-fixture participants moves its own centre.
    expect([...realKeys].filter((entry) => !naiveKeys.has(entry))).toHaveLength(7);
  });

  it('is the difference between a game-count metric that answers and one that cannot', () => {
    const { fixtures } = corpusFixtures();
    const flattened = fixtures.map((held) => ({
      ...held,
      competition: FAIRNESS_COMPETITION.LEAGUE,
    }));
    const naive = fairnessReport({ fixtures: flattened });

    // Without the distinction the season's game counts are 122 nines, 14 ones
    // and 4 twos. More than half the population shares one value, so the median
    // absolute deviation is exactly zero over values that differ: the scale
    // collapses and **nobody at all** can be judged.
    const naivePopulation = naive.populations.find(
      (population) =>
        population.metricId === FAIRNESS_METRIC.GAMES_PLAYED &&
        population.subjectKind === FAIRNESS_SUBJECT_KIND.TEAM &&
        population.basisKind === FAIRNESS_BASIS.SEASON
    );
    expect(naivePopulation.dispersion.state).toBe(FAIRNESS_DISPERSION.DEGENERATE);
    expect(naivePopulation.dispersion.distribution).toEqual([
      [1, 14],
      [2, 4],
      [9, 122],
    ]);
    const naiveJudgements = naive.judgements.filter(
      (judgement) =>
        judgement.metricId === FAIRNESS_METRIC.GAMES_PLAYED &&
        judgement.subjectKind === FAIRNESS_SUBJECT_KIND.TEAM &&
        judgement.basis.kind === FAIRNESS_BASIS.SEASON
    );
    expect(naiveJudgements).toHaveLength(140);
    expect(
      naiveJudgements.every((judgement) => judgement.judgement === FAIRNESS_JUDGEMENT.UNDECIDED)
    ).toBe(true);

    // With it, the same population is 122 identical values: `uniform`, which is
    // a measured "this league is equal on game count" and not a shrug.
    const report = corpusReport();
    const population = report.populations.find(
      (candidate) =>
        candidate.metricId === FAIRNESS_METRIC.GAMES_PLAYED &&
        candidate.subjectKind === FAIRNESS_SUBJECT_KIND.TEAM &&
        candidate.basisKind === FAIRNESS_BASIS.SEASON
    );
    expect(population.dispersion.state).toBe(FAIRNESS_DISPERSION.UNIFORM);
    expect(population.dispersion.distribution).toEqual([[9, 122]]);
    const judgements = report.judgements.filter(
      (judgement) =>
        judgement.metricId === FAIRNESS_METRIC.GAMES_PLAYED &&
        judgement.subjectKind === FAIRNESS_SUBJECT_KIND.TEAM &&
        judgement.basis.kind === FAIRNESS_BASIS.SEASON
    );
    expect(
      judgements.filter((judgement) => judgement.judgement === FAIRNESS_JUDGEMENT.TYPICAL)
    ).toHaveLength(122);
    // The eighteen are reported, not omitted and not scored zero.
    const outside = findingsOf(report, FAIRNESS_REASON.FAIRNESS_SUBJECT_OUTSIDE_CLASS).filter(
      (finding) =>
        finding.details.metricId === FAIRNESS_METRIC.GAMES_PLAYED &&
        finding.details.subjectKind === FAIRNESS_SUBJECT_KIND.TEAM
    );
    expect(outside).toHaveLength(1);
    expect(outside[0].details.subjectCount).toBe(18);
  });

  it('refuses an unknown competition rather than counting it as league', () => {
    const classification = classifyFairnessFixtures([
      fixture({ fixtureId: 'a' }),
      fixture({ fixtureId: 'b', competition: 'tournament' }),
      fixture({ fixtureId: 'c', competition: 'tournament' }),
    ]);
    expect(classification.usable).toBe(false);
    const refusal = classification.findings.find(
      (finding) => finding.code === FAIRNESS_REASON.FAIRNESS_FIXTURE_UNCLASSIFIED
    );
    expect(refusal.severity).toBe(FAIRNESS_SEVERITY.BLOCKING);
    expect(refusal.details).toMatchObject({ competition: 'tournament', fixtureCount: 2 });
    expect(classification.byCompetition.league).toBe(1);
  });

  it('refuses a fixture list that spans two scopes, because a division is a label and not a key', () => {
    const classification = classifyFairnessFixtures([
      fixture({ fixtureId: 'a', scopeId: 'club-a', division: 'U10B' }),
      fixture({ fixtureId: 'b', scopeId: 'club-b', division: 'U10B' }),
    ]);
    expect(classification.scopeId).toBeNull();
    expect(classification.usable).toBe(false);
    const refusal = classification.findings.find(
      (finding) => finding.code === FAIRNESS_REASON.FAIRNESS_SCOPE_MIXED
    );
    expect(refusal.severity).toBe(FAIRNESS_SEVERITY.BLOCKING);
    expect(refusal.details.scopeIds).toEqual(['club-a', 'club-b']);
  });

  it('reports fixtures that name nobody rather than silently shortening the list', () => {
    const classification = classifyFairnessFixtures([
      fixture({ fixtureId: 'a' }),
      fixture({ fixtureId: 'b', homeSubjectId: null, awaySubjectId: null }),
    ]);
    expect(classification.placeholderFixtures).toBe(1);
    const notice = classification.findings.find(
      (finding) => finding.code === FAIRNESS_REASON.FAIRNESS_PLACEHOLDER_EXCLUDED
    );
    expect(notice.severity).toBe(FAIRNESS_SEVERITY.INFO);
    expect(notice.details.placeholderFixtures).toBe(1);
    // Info: it does not compromise a report, it explains one.
    expect(classification.usable).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* 3. Artifacts of the fixture format, not inequities                          */
/* -------------------------------------------------------------------------- */

describe('fairness :: a flag that fires on an artifact is the failure mode', () => {
  it('does not flag the four Minis sides, whose 9/0 hosting record is an absent opponent', () => {
    const { fixtures } = corpusFixtures();
    const participation = participationOf(fixtures);
    const minis = ['MinisA', 'MinisB', 'MinisC', 'MinisD'];

    // The artifact, stated from the corpus: nine league fixtures each, and not
    // one of them names an opponent.
    for (const id of minis) {
      const entry = participation.get(id);
      expect(entry.fixtures).toHaveLength(9);
      expect(entry.fixtures.every((held) => held.fixture.awaySubjectId === null)).toBe(true);
    }

    // The naive metric: hosting share read as hosted/played rather than
    // hosted/two-sided. It puts the four of them at 1.0 — the most extreme
    // value in the season — and an ordinary z-score, which is the statistic an
    // implementer reaches for first, flags all four and nobody else.
    const naiveShares = [...participation.entries()]
      .filter(([, entry]) => entry.byCompetition.league > 0)
      .map(([subjectId, entry]) => ({
        subjectId,
        value:
          entry.fixtures.filter((held) => held.fixture.homeSubjectId === subjectId).length /
          entry.fixtures.length,
      }));
    expect(naiveShares).toHaveLength(122);
    const values = naiveShares.map((member) => member.value);
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const sd = Math.sqrt(
      values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length
    );
    const naiveFlagged = naiveShares.filter((member) => Math.abs((member.value - mean) / sd) > 3);
    expect(naiveFlagged.map((member) => member.subjectId).sort()).toEqual(minis);
    expect(naiveFlagged.every((member) => member.value === 1)).toBe(true);
    expect((1 - mean) / sd).toBeCloseTo(4.6293, 3);

    // The median-based scale this module uses happens to absorb them on this
    // corpus — the hosting shares are bimodal at 4/9 and 5/9, which inflates the
    // MAD — and that is **not** the defence. A robust statistic that survives
    // one artifact is a robust statistic that will meet a bigger one. The
    // defence is structural: hosting share over a fixture with no away side is
    // not a large number or a small one, it is not a quantity, and the module
    // refuses to produce one whatever any statistic would have said about it.
    const madDispersion = describeDispersion('naive-hosting-share', naiveShares);
    expect(madDispersion.state).toBe(FAIRNESS_DISPERSION.USABLE);
    expect(Math.abs(modifiedZScore(1, madDispersion))).toBeLessThan(OUTLIER_SCORE_THRESHOLD);

    // The module's answer: unmeasurable, with the reason, and no flag anywhere.
    const report = corpusReport();
    for (const id of minis) {
      const measurement = report.measurements.find(
        (m) =>
          m.subjectId === id &&
          m.metricId === FAIRNESS_METRIC.HOSTING_SHARE &&
          m.subjectKind === FAIRNESS_SUBJECT_KIND.TEAM
      );
      expect(measurement.measurability).toBe(FAIRNESS_MEASURABILITY.UNMEASURABLE);
      expect(measurement.value).toBeNull();
      expect(measurement.reasonCode).toBe(FAIRNESS_REASON.FAIRNESS_DENOMINATOR_EMPTY);
      expect(measurement.evidence.exclusions).toContainEqual(['fixture-names-no-opponent', 9]);
    }
    expect(
      report.flags.filter((flag) => flag.metricId === FAIRNESS_METRIC.HOSTING_SHARE)
    ).toHaveLength(0);
    // And it is refused by structure rather than by a Minis-shaped exception:
    // nothing in the module tests a format name.
    expect(FAIRNESS_METRIC_REGISTRY[FAIRNESS_METRIC.HOSTING_SHARE].measure.toString()).not.toMatch(
      /Minis/
    );
  });

  it('marks seven of the eight season-wide kickoff flags as not holding in the team’s own division', () => {
    const report = corpusReport();
    const seasonFlags = report.flags.filter(
      (flag) =>
        flag.basis.kind === FAIRNESS_BASIS.SEASON && flag.metricId === FAIRNESS_METRIC.MEAN_KICKOFF
    );
    expect(seasonFlags).toHaveLength(8);
    expect(seasonFlags.filter((flag) => flag.heldOnNarrowerBasis === false)).toHaveLength(7);
    expect(seasonFlags.filter((flag) => flag.heldOnNarrowerBasis === true)).toHaveLength(1);
    expect(findingsOf(report, FAIRNESS_REASON.FAIRNESS_BASIS_WIDER_ONLY)).toHaveLength(7);

    // The reason the seven are artifacts is legible from the corpus: every one
    // is a U09/U10/U12 side, and the club schedules its youngest in the morning.
    // The season cohort mixes age brackets, so it measures the timetable.
    expect(
      seasonFlags
        .filter((flag) => flag.heldOnNarrowerBasis === false)
        .every((flag) => /^(09|10|12)/.test(flag.subjectId))
    ).toBe(true);

    // The one that survives does so on its own division's evidence.
    const survivor = seasonFlags.find((flag) => flag.heldOnNarrowerBasis === true);
    expect(survivor.subjectId).toBe('09G7v706');
    const divisionFlag = report.flags.find(
      (flag) =>
        flag.subjectId === '09G7v706' &&
        flag.basis.kind === FAIRNESS_BASIS.DIVISION &&
        flag.metricId === FAIRNESS_METRIC.MEAN_KICKOFF
    );
    expect(divisionFlag.basis.groupKey).toBe('U09G');
    expect(divisionFlag.basis.populationSize).toBe(6);
    expect(divisionFlag.heldOnNarrowerBasis).toBeNull();
  });

  it('raises exactly one flag on the narrowest basis, and its arithmetic reproduces by hand', () => {
    const report = corpusReport();
    const divisionFlags = report.flags.filter(
      (flag) => flag.basis.kind === FAIRNESS_BASIS.DIVISION
    );
    expect(divisionFlags).toHaveLength(1);
    const flag = divisionFlags[0];

    const { fixtures } = corpusFixtures();
    const participation = participationOf(fixtures);
    const u09g = [...participation.entries()]
      .filter(([, entry]) => entry.divisions.size === 1 && entry.divisions.has('U09G'))
      .map(([subjectId, entry]) => ({
        subjectId,
        value:
          entry.fixtures.reduce((sum, held) => sum + held.fixture.kickoffMinutes, 0) /
          entry.fixtures.length,
      }));
    expect(u09g).toHaveLength(6);
    const centre = median(u09g.map((member) => member.value));
    const scale = medianAbsoluteDeviation(u09g.map((member) => member.value));
    const subject = u09g.find((member) => member.subjectId === flag.subjectId);

    expect(flag.value).toBeCloseTo(subject.value, 9);
    expect(flag.centre).toBeCloseTo(centre, 9);
    expect(flag.scale).toBeCloseTo(scale, 9);
    expect(flag.deviation).toBeCloseTo(subject.value - centre, 9);
    expect(flag.score).toBeCloseTo((0.6745 * (subject.value - centre)) / scale, 9);
    expect(Math.abs(flag.score)).toBeGreaterThan(OUTLIER_SCORE_THRESHOLD);
    expect(flag.deviation).toBeCloseTo(25, 9);
    expect(flag.unit).toBe('minutes past midnight');
  });

  it('did not have its threshold tuned to this corpus: five more artifacts sit at 3.4819', () => {
    const report = corpusReport();
    const typical = report.judgements.filter(
      (judgement) => judgement.judgement === FAIRNESS_JUDGEMENT.TYPICAL && judgement.score !== null
    );
    expect(typical.length).toBeGreaterThan(0);
    const nearest = typical.reduce((best, judgement) =>
      Math.abs(judgement.score) > Math.abs(best.score) ? judgement : best
    );
    expect(Math.abs(nearest.score)).toBeCloseTo(3.4819, 3);
    expect(Math.abs(nearest.score)).toBeLessThan(OUTLIER_SCORE_THRESHOLD);
    expect(nearest.basis.kind).toBe(FAIRNESS_BASIS.SEASON);
    expect(nearest.metricId).toBe(FAIRNESS_METRIC.MEAN_KICKOFF);

    // Six U09 sides and the U09 age group itself sit at that score, and they
    // are the same age-structure artifact as the seven the wider-basis check
    // already names. 3.5 is Iglewicz and Hoaglin's published figure, used
    // unmodified; the point of recording the near miss is that a threshold
    // chosen to make this corpus look tidy would have been set below it, and
    // seven more artifacts would have come with it.
    const atTheEdge = typical.filter(
      (judgement) => Math.abs(Math.abs(judgement.score) - Math.abs(nearest.score)) < 1e-9
    );
    expect(atTheEdge).toHaveLength(7);
    expect(
      atTheEdge.every(
        (judgement) => judgement.subjectId.startsWith('09') || judgement.subjectId === 'U09'
      )
    ).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* 4. Every flag carries its evidence and its basis                            */
/* -------------------------------------------------------------------------- */

describe('fairness :: every flag publishes what decided it', () => {
  it('carries a basis, a population size, a centre, a scale, a deviation and a score — on every flag', () => {
    const report = corpusReport();
    expect(report.flags.length).toBeGreaterThan(0);
    for (const flag of report.flags) {
      expect(typeof flag.basis.kind).toBe('string');
      expect(flag.basis.groupKey).not.toBeNull();
      expect(flag.basis.populationSize).toBeGreaterThanOrEqual(MIN_POPULATION_FOR_DISPERSION);
      expect(Number.isFinite(flag.value)).toBe(true);
      expect(Number.isFinite(flag.centre)).toBe(true);
      expect(Number.isFinite(flag.scale)).toBe(true);
      expect(Number.isFinite(flag.deviation)).toBe(true);
      expect(Number.isFinite(flag.score)).toBe(true);
      expect(flag.threshold).toBe(OUTLIER_SCORE_THRESHOLD);
      expect(['above', 'below']).toContain(flag.direction);
      expect(flag.evidence.fixturesCounted).toBeGreaterThan(0);
      expect(flag.unit).toBe(FAIRNESS_METRIC_REGISTRY[flag.metricId].unit);
    }
    expect(assertFlagEvidence(report.flags)).toEqual([]);

    // Each flag also has a finding that names the same numbers, so a reader of
    // `findings` alone gets the whole basis and not a bare accusation.
    const outlierFindings = report.findings.filter((finding) =>
      [FAIRNESS_REASON.FAIRNESS_OUTLIER_HIGH, FAIRNESS_REASON.FAIRNESS_OUTLIER_LOW].includes(
        finding.code
      )
    );
    expect(outlierFindings).toHaveLength(report.flags.length);
    for (const finding of outlierFindings) {
      for (const key of ['centre', 'scale', 'deviation', 'score', 'threshold', 'populationSize']) {
        expect(finding.details[key]).not.toBeUndefined();
        expect(finding.details[key]).not.toBeNull();
      }
    }
  });

  it('refuses a flag whose basis or arithmetic is missing', () => {
    const naked = /** @type {any} */ ({
      metricId: FAIRNESS_METRIC.MEAN_KICKOFF,
      subjectKind: FAIRNESS_SUBJECT_KIND.TEAM,
      subjectId: 'T1',
      basis: { kind: FAIRNESS_BASIS.DIVISION, groupKey: null, populationSize: 0 },
      judgement: FAIRNESS_JUDGEMENT.OUTLIER,
      value: 600,
      centre: null,
      scale: null,
      deviation: null,
      score: null,
      threshold: null,
      direction: null,
      evidence: { fixturesCounted: 0, fixturesExcluded: 0, exclusions: [] },
    });
    const refusals = assertFlagEvidence([naked]);
    expect(refusals).toHaveLength(1);
    expect(refusals[0].code).toBe(FAIRNESS_REASON.FAIRNESS_FLAG_EVIDENCE_MISSING);
    expect(refusals[0].severity).toBe(FAIRNESS_SEVERITY.BLOCKING);
    expect(refusals[0].details.missing).toEqual(
      expect.arrayContaining([
        'centre',
        'scale',
        'deviation',
        'score',
        'threshold',
        'direction',
        'basis.groupKey',
        'basis.populationSize',
        'evidence.fixturesCounted',
      ])
    );
  });

  it('flags low as readily as high, and refuses to say which end is the bad one', () => {
    // Twelve teams, nine one-sided fixtures each so the population is exactly
    // the twelve. Eleven of them sit around 10:00 with a real spread; T1 plays
    // every one of its fixtures at 08:00.
    const fixtures = [];
    for (let team = 1; team <= 12; team += 1) {
      for (let round = 0; round < 9; round += 1) {
        fixtures.push(
          fixture({
            fixtureId: `t${team}-r${round}`,
            date: `2026-09-${String(round + 1).padStart(2, '0')}`,
            kickoffMinutes: team === 1 ? 480 : 600 + ((team + round) % 4) * 7,
            homeSubjectId: `T${team}`,
            awaySubjectId: null,
          })
        );
      }
    }
    const report = fairnessReport({ fixtures, metricIds: [FAIRNESS_METRIC.MEAN_KICKOFF] });
    const low = report.flags.filter((flag) => flag.direction === 'below');
    expect(low.length).toBeGreaterThan(0);
    expect(low.every((flag) => flag.subjectId === 'T1')).toBe(true);
    expect(low[0].value).toBe(480);
    expect(low[0].deviation).toBeLessThan(0);
    expect(findingsOf(report, FAIRNESS_REASON.FAIRNESS_OUTLIER_LOW).length).toBeGreaterThan(0);
    // The severity of high and low is identical: the module reports a distance
    // from the cohort and declines to say which side of it is worse.
    expect(FAIRNESS_REASON_SEVERITY[FAIRNESS_REASON.FAIRNESS_OUTLIER_LOW]).toBe(
      FAIRNESS_REASON_SEVERITY[FAIRNESS_REASON.FAIRNESS_OUTLIER_HIGH]
    );
  });
});

/* -------------------------------------------------------------------------- */
/* 5. Three-valued, never two                                                  */
/* -------------------------------------------------------------------------- */

describe('fairness :: unmeasurable is not zero and typical is not undecided', () => {
  it('never lets a measurement carry both a number and a reason, or neither', () => {
    const report = corpusReport();
    expect(report.measurements.length).toBeGreaterThan(0);
    for (const measurement of report.measurements) {
      if (measurement.measurability === FAIRNESS_MEASURABILITY.MEASURED) {
        expect(Number.isFinite(measurement.value)).toBe(true);
        expect(measurement.reasonCode).toBeNull();
      } else {
        expect(measurement.value).toBeNull();
        expect(measurement.reasonCode).not.toBeNull();
      }
    }
    // Both directions of the collapse are refused.
    // Nine one-sided Minis rows: the ids are what make the count checkable,
    // so the fixture states them rather than asserting a bare 9.
    const NINE_ONE_SIDED = Array.from({ length: 9 }, (_, i) => `minis-a-${i + 1}`);
    expect(() =>
      assertFairnessMeasurement({
        metricId: FAIRNESS_METRIC.HOSTING_SHARE,
        unit: 'share of 1',
        subjectKind: FAIRNESS_SUBJECT_KIND.TEAM,
        subjectId: 'MinisA',
        measurability: FAIRNESS_MEASURABILITY.UNMEASURABLE,
        value: 0,
        reasonCode: FAIRNESS_REASON.FAIRNESS_DENOMINATOR_EMPTY,
        evidence: {
          fixturesCounted: 0,
          fixturesExcluded: 9,
          exclusions: [],
          countedFixtureIds: [],
          excludedFixtureIds: NINE_ONE_SIDED,
        },
      })
    ).toThrow(/folding an unmeasurable subject into a number/);
    expect(() =>
      assertFairnessMeasurement({
        metricId: FAIRNESS_METRIC.HOSTING_SHARE,
        unit: 'share of 1',
        subjectKind: FAIRNESS_SUBJECT_KIND.TEAM,
        subjectId: 'MinisA',
        measurability: FAIRNESS_MEASURABILITY.MEASURED,
        value: null,
        reasonCode: null,
        evidence: {
          fixturesCounted: 0,
          fixturesExcluded: 9,
          exclusions: [],
          countedFixtureIds: [],
          excludedFixtureIds: NINE_ONE_SIDED,
        },
      })
    ).toThrow(/a measurement with no number is unmeasurable/);
  });

  it('separates a scale of zero over identical values from one over differing values', () => {
    const uniform = describeDispersion('m', [
      { subjectId: 'a', value: 9 },
      { subjectId: 'b', value: 9 },
      { subjectId: 'c', value: 9 },
      { subjectId: 'd', value: 9 },
    ]);
    const degenerate = describeDispersion('m', [
      { subjectId: 'a', value: 9 },
      { subjectId: 'b', value: 9 },
      { subjectId: 'c', value: 9 },
      { subjectId: 'd', value: 4 },
    ]);
    expect(uniform.scale).toBe(0);
    expect(degenerate.scale).toBe(0);
    expect(uniform.state).toBe(FAIRNESS_DISPERSION.UNIFORM);
    expect(degenerate.state).toBe(FAIRNESS_DISPERSION.DEGENERATE);
    // The same `mad === 0` test, and opposite answers about every member.
    expect(
      deriveFairnessJudgement({
        measurability: FAIRNESS_MEASURABILITY.MEASURED,
        dispersion: uniform.state,
        score: null,
        threshold: OUTLIER_SCORE_THRESHOLD,
      })
    ).toBe(FAIRNESS_JUDGEMENT.TYPICAL);
    expect(
      deriveFairnessJudgement({
        measurability: FAIRNESS_MEASURABILITY.MEASURED,
        dispersion: degenerate.state,
        score: null,
        threshold: OUTLIER_SCORE_THRESHOLD,
      })
    ).toBe(FAIRNESS_JUDGEMENT.UNDECIDED);
    // The degenerate population publishes what its scale could not.
    expect(degenerate.distribution).toEqual([
      [4, 1],
      [9, 3],
    ]);
    // Both states are live in the corpus, not only in this construction.
    const report = corpusReport();
    const states = new Set(report.populations.map((population) => population.dispersion.state));
    expect(states.has(FAIRNESS_DISPERSION.UNIFORM)).toBe(true);
    expect(states.has(FAIRNESS_DISPERSION.DEGENERATE)).toBe(true);
    expect(states.has(FAIRNESS_DISPERSION.INSUFFICIENT)).toBe(true);
    expect(states.has(FAIRNESS_DISPERSION.USABLE)).toBe(true);
  });

  it('never scores an infinite deviation, and throws rather than comparing one', () => {
    const degenerate = describeDispersion('m', [
      { subjectId: 'a', value: 9 },
      { subjectId: 'b', value: 9 },
      { subjectId: 'c', value: 9 },
      { subjectId: 'd', value: 4 },
    ]);
    expect(modifiedZScore(4, degenerate)).toBeNull();
    expect(() =>
      deriveFairnessJudgement({
        measurability: FAIRNESS_MEASURABILITY.MEASURED,
        dispersion: FAIRNESS_DISPERSION.USABLE,
        score: Infinity,
        threshold: OUTLIER_SCORE_THRESHOLD,
      })
    ).toThrow(/a scale of zero wearing a number/);
    const report = corpusReport();
    expect(
      report.judgements.every(
        (judgement) => judgement.score === null || Number.isFinite(judgement.score)
      )
    ).toBe(true);
  });

  it('refuses a population that calls itself usable while holding no centre or scale', () => {
    // The sweep the fourth review round asked for, at the two other places a
    // guard and the arithmetic it protects keyed on different quantities.
    // `modifiedZScore()` tested `dispersion.state` and then read `centre` and
    // `scale` through casts that erased their nullability, and
    // `deriveFairnessJudgement()` validated its measurability, its dispersion
    // state and its score while comparing against a `threshold` it never
    // checked at all.
    //
    // **What this test claims, stated plainly**, because the claim is narrower
    // than the two below it: both functions are exported, and both take their
    // arguments from a caller, so this is a test of their *contracts* and not a
    // claim that the report pipeline can reach these states.
    // `describeDispersion()` cannot produce any of them, and none of them
    // survives a round trip out of one that could. What is being asserted is
    // that each guard now keys on the quantity its own arithmetic divides by,
    // rather than on a state read as a proxy for it — so a caller cannot get a
    // number out of either function that was computed from an absent one.
    const usable = describeDispersion('m', [
      { subjectId: 'a', value: 600 },
      { subjectId: 'b', value: 610 },
      { subjectId: 'c', value: 620 },
      { subjectId: 'd', value: 700 },
    ]);
    expect(usable.state).toBe(FAIRNESS_DISPERSION.USABLE);
    expect(usable.centre).toBe(615);
    expect(usable.scale).toBe(10);
    // The control first: a real population still scores, by hand.
    expect(modifiedZScore(700, usable)).toBeCloseTo((0.6745 * (700 - 615)) / 10, 9);

    // The centre is the dangerous half, and the reason this is worth a guard
    // rather than a cast: the arithmetic measures the deviation from **zero**
    // and returns a perfectly plausible finite number, which
    // `deriveFairnessJudgement()` then accepts and flags on — its own
    // non-finite check cannot see this one. What follows is the constructed
    // wrong implementation, the line the cast used to run, and the flag it
    // produces.
    const centreless = { ...usable, centre: null };
    const wrong = (0.6745 * (700 - centreless.centre)) / centreless.scale;
    expect(Number.isFinite(wrong)).toBe(true);
    expect(wrong).toBeCloseTo(47.215, 3);
    expect(
      deriveFairnessJudgement({
        measurability: FAIRNESS_MEASURABILITY.MEASURED,
        dispersion: FAIRNESS_DISPERSION.USABLE,
        score: wrong,
        threshold: OUTLIER_SCORE_THRESHOLD,
      })
    ).toBe(FAIRNESS_JUDGEMENT.OUTLIER);
    expect(() => modifiedZScore(700, centreless)).toThrow(/centre/);

    // An absent scale divides by zero, which the judgement guard already
    // refuses downstream — the refusal is stated as well in the function whose
    // arithmetic needs the number, so the two guards key on the same quantity
    // rather than one catching what the other let through.
    const scaleless = { ...usable, scale: null };
    expect((0.6745 * (700 - scaleless.centre)) / scaleless.scale).toBe(Infinity);
    expect(() => modifiedZScore(700, scaleless)).toThrow(/scale/);

    // …and a state that says `usable` over a zero scale, which no
    // `describeDispersion()` output can be and which would flag every member
    // of a population whose values are identical.
    expect(() => modifiedZScore(700, { ...usable, scale: 0 })).toThrow(/scale/);

    // The other half, and the fourth input of four: `deriveFairnessJudgement()`
    // validated its measurability, its dispersion state and its score, and
    // compared against a `threshold` it never checked. A population that has
    // been through JSON is the same reachable arrival as the objective's — an
    // absent threshold does not survive the trip, and this is the one arrival
    // here a caller can reach without hand-building it — and
    // `Math.abs(47.215) > undefined` is `false`, so the judgement came back
    // `typical`: a clean bill of health from a comparison that could not have
    // found anything, which is the shape this module exists to prevent.
    const thresholdless = JSON.parse(JSON.stringify({ ...usable, threshold: undefined }));
    expect(Object.hasOwn(thresholdless, 'threshold')).toBe(false);
    expect(Math.abs(wrong) > thresholdless.threshold).toBe(false);
    expect(() =>
      deriveFairnessJudgement({
        measurability: FAIRNESS_MEASURABILITY.MEASURED,
        dispersion: FAIRNESS_DISPERSION.USABLE,
        score: wrong,
        threshold: thresholdless.threshold,
      })
    ).toThrow(/threshold/);
    // The control, so the refusal is about the threshold and not about the
    // call: the same call with the declared threshold judges.
    expect(
      deriveFairnessJudgement({
        measurability: FAIRNESS_MEASURABILITY.MEASURED,
        dispersion: FAIRNESS_DISPERSION.USABLE,
        score: wrong,
        threshold: OUTLIER_SCORE_THRESHOLD,
      })
    ).toBe(FAIRNESS_JUDGEMENT.OUTLIER);

    // Neither refusal touches the corpus: every judgement it publishes was
    // scored against a population that held both numbers.
    const report = corpusReport();
    const scored = report.judgements.filter((judgement) => judgement.score !== null);
    expect(scored.length).toBeGreaterThan(0);
    expect(
      scored.every(
        (judgement) =>
          Number.isFinite(judgement.centre) &&
          Number.isFinite(judgement.scale) &&
          judgement.scale !== 0 &&
          Number.isFinite(judgement.threshold)
      )
    ).toBe(true);
  });

  it('leaves a cohort of two undecided rather than typical — on all 28 division cohorts of this corpus', () => {
    const report = corpusReport();
    const divisionCohorts = report.populations.filter(
      (population) => population.subjectKind === FAIRNESS_SUBJECT_KIND.DIVISION
    );
    // Seven age groups hold divisions in this league, one cohort per metric.
    // Derived from the report rather than typed in, so the figure below is a
    // consequence of the corpus and not a number kept in step by hand.
    const ageGroups = new Set(
      report.measurements
        .filter((m) => m.subjectKind === FAIRNESS_SUBJECT_KIND.AGE_GROUP)
        .map((m) => m.subjectId)
    );
    expect(ageGroups.size).toBe(7);
    expect(divisionCohorts).toHaveLength(FAIRNESS_METRIC_ORDER.length * ageGroups.size);
    expect(divisionCohorts).toHaveLength(28);
    // Every one of them is below the floor, which is why none judges anybody.
    expect(
      divisionCohorts.every(
        (population) => population.dispersion.size < MIN_POPULATION_FOR_DISPERSION
      )
    ).toBe(true);
    expect(
      divisionCohorts.every(
        (population) => population.dispersion.state === FAIRNESS_DISPERSION.INSUFFICIENT
      )
    ).toBe(true);
    const divisionJudgements = report.judgements.filter(
      (judgement) => judgement.subjectKind === FAIRNESS_SUBJECT_KIND.DIVISION
    );
    expect(divisionJudgements.length).toBeGreaterThan(0);
    expect(
      divisionJudgements.every((judgement) => judgement.judgement === FAIRNESS_JUDGEMENT.UNDECIDED)
    ).toBe(true);
    // And it says so, rather than reporting "no division outliers found".
    expect(
      findingsOf(report, FAIRNESS_REASON.FAIRNESS_POPULATION_TOO_SMALL).length
    ).toBeGreaterThan(0);
  });

  it('judges no cohort under a key a subject holds twice, and none under a key it holds only outside the class', () => {
    // The rule, at the function that decides it. Three answers, never two.
    expect(groupKeyOf(new Set(['U09G']))).toEqual({ key: 'U09G', reasonCode: null });
    expect(groupKeyOf(new Set(['16GS', 'U16G']))).toEqual({
      key: null,
      reasonCode: FAIRNESS_REASON.FAIRNESS_GROUP_AMBIGUOUS,
    });
    expect(groupKeyOf(new Set())).toEqual({
      key: null,
      reasonCode: FAIRNESS_REASON.FAIRNESS_GROUP_UNLABELLED,
    });
    expect(FAIRNESS_REASON_SEVERITY[FAIRNESS_REASON.FAIRNESS_GROUP_AMBIGUOUS]).toBe(
      FAIRNESS_SEVERITY.COMPROMISE
    );

    // The corpus' one two-label subject, and the provenance of both labels:
    // `16GSelect02` is spelled `16GS` on one scrimmage and `U16G` on another,
    // and holds no league fixture at all. Since a league metric's cohort is
    // drawn from league fixtures, it is not *ambiguous* under one — it has no
    // league division, which is a different and more accurate answer, and the
    // report names it rather than dropping it.
    const participation = participationOf(corpusFixtures().fixtures);
    const entry = participation.get('16GSelect02');
    expect([...entry.divisions].sort()).toEqual(['16GS', 'U16G']);
    expect(
      entry.fixtures.every((held) => held.fixture.competition === FAIRNESS_COMPETITION.FRIENDLY)
    ).toBe(true);

    const report = corpusReport();
    const judgements = report.judgements.filter(
      (judgement) =>
        judgement.subjectId === '16GSelect02' && judgement.basis.kind === FAIRNESS_BASIS.DIVISION
    );
    expect(judgements.length).toBeGreaterThan(0);
    expect(judgements.every((j) => j.judgement === FAIRNESS_JUDGEMENT.UNDECIDED)).toBe(true);
    expect(judgements.every((j) => j.basis.groupKey === null)).toBe(true);
    const named = findingsOf(report, FAIRNESS_REASON.FAIRNESS_GROUP_UNLABELLED).filter(
      (finding) => finding.details.basisKind === FAIRNESS_BASIS.DIVISION
    );
    expect(named.length).toBeGreaterThan(0);
    expect(named[0].details.subjects).toContain('16GSelect02');
    expect(named[0].severity).toBe(FAIRNESS_SEVERITY.COMPROMISE);
  });

  it('judges the four Minis sides under no age-group cohort, because BB parses to none', () => {
    const report = corpusReport();
    const unlabelled = findingsOf(report, FAIRNESS_REASON.FAIRNESS_GROUP_UNLABELLED);
    expect(unlabelled.length).toBeGreaterThan(0);
    const teamLevel = unlabelled.filter(
      (finding) => finding.details.subjectKind === FAIRNESS_SUBJECT_KIND.TEAM
    );
    expect(teamLevel.length).toBeGreaterThan(0);
    const minis = ['MinisA', 'MinisB', 'MinisC', 'MinisD'];
    expect(teamLevel[0].details.subjects).toEqual(expect.arrayContaining(minis));
    // Twenty-two subjects hold no age-group key for a league metric, and the
    // four Minis sides are there for a different reason from the other
    // eighteen: they play nine league fixtures each in division `BB`, which
    // parses to no age group, where the eighteen hold no league fixture at all
    // and so hold no league label of any kind.
    expect(teamLevel[0].details.subjectCount).toBe(22);
    const participation = participationOf(corpusFixtures().fixtures);
    for (const id of minis) {
      expect(participation.get(id).byCompetition.league).toBe(9);
      expect(
        participation
          .get(id)
          .fixtures.every(
            (held) => held.fixture.division === 'BB' && held.fixture.ageGroup === null
          )
      ).toBe(true);
    }
    expect(
      teamLevel[0].details.subjects.filter(
        (id) => !minis.includes(id) && participation.get(id).byCompetition.league === 0
      )
    ).toHaveLength(18);
    // They are still judged in their own division, which does exist.
    const inDivision = report.judgements.filter(
      (judgement) =>
        judgement.subjectId === 'MinisA' &&
        judgement.basis.kind === FAIRNESS_BASIS.DIVISION &&
        judgement.metricId === FAIRNESS_METRIC.GAMES_PLAYED
    );
    expect(inDivision).toHaveLength(1);
    expect(inDivision[0].basis.groupKey).toBe('BB');
    expect(inDivision[0].judgement).toBe(FAIRNESS_JUDGEMENT.TYPICAL);
  });
});

/* -------------------------------------------------------------------------- */
/* 6. The meta-assertions, and the input that makes each fail                  */
/* -------------------------------------------------------------------------- */

describe('fairness :: every check can fail, and here is what makes it', () => {
  it('passes all four on the season corpus', () => {
    const report = corpusReport();
    for (const code of [
      FAIRNESS_REASON.FAIRNESS_NO_FIXTURES_READ,
      FAIRNESS_REASON.FAIRNESS_METRIC_UNEXERCISED,
      FAIRNESS_REASON.FAIRNESS_NOTHING_JUDGED,
      FAIRNESS_REASON.FAIRNESS_FLAG_EVIDENCE_MISSING,
    ]) {
      expect(findingsOf(report, code)).toHaveLength(0);
    }
    expect(report.status).toBe(FAIRNESS_STATUS.COMPROMISED);
    expect(report.meta.fixturesRead).toBe(578);
    expect(report.meta.judgementsMade).toBeGreaterThan(0);
  });

  it('FAIRNESS_NO_FIXTURES_READ: a list the schema accepts and the classifier rejects wholesale', () => {
    const report = fairnessReport({
      fixtures: [fixture({ competition: 'tournament' })],
    });
    expect(findingsOf(report, FAIRNESS_REASON.FAIRNESS_NO_FIXTURES_READ)).toHaveLength(1);
    expect(report.meta.fixturesRead).toBe(0);
    expect(report.status).toBe(FAIRNESS_STATUS.REJECTED);
  });

  it('FAIRNESS_METRIC_UNEXERCISED: a season of external fixtures only', () => {
    const fixtures = Array.from({ length: 8 }, (unused, index) =>
      fixture({
        fixtureId: `e${index}`,
        competition: FAIRNESS_COMPETITION.EXTERNAL,
        homeSubjectId: `H${index}`,
        awaySubjectId: `A${index}`,
      })
    );
    const report = fairnessReport({ fixtures });
    const unexercised = findingsOf(report, FAIRNESS_REASON.FAIRNESS_METRIC_UNEXERCISED);
    expect(unexercised).toHaveLength(FAIRNESS_METRIC_ORDER.length);
    expect(unexercised.every((finding) => finding.severity === FAIRNESS_SEVERITY.BLOCKING)).toBe(
      true
    );
    expect(unexercised[0].details.subjectsConsidered).toBeGreaterThan(0);
    expect(report.status).toBe(FAIRNESS_STATUS.REJECTED);
  });

  it('FAIRNESS_NOTHING_JUDGED: three teams, so no cohort reaches the four-member floor', () => {
    const fixtures = [
      fixture({ fixtureId: 'a', homeSubjectId: 'T1', awaySubjectId: 'T2' }),
      fixture({ fixtureId: 'b', date: '2026-08-29', homeSubjectId: 'T2', awaySubjectId: 'T3' }),
      fixture({ fixtureId: 'c', date: '2026-09-05', homeSubjectId: 'T3', awaySubjectId: 'T1' }),
    ];
    const report = fairnessReport({ fixtures });
    expect(report.meta.judgementsMade).toBe(0);
    expect(findingsOf(report, FAIRNESS_REASON.FAIRNESS_NOTHING_JUDGED)).toHaveLength(1);
    expect(report.status).toBe(FAIRNESS_STATUS.REJECTED);
    // The distinction that matters: the metrics *were* exercised. This is not
    // incident 4 — it is a season too small to say anything about.
    expect(findingsOf(report, FAIRNESS_REASON.FAIRNESS_METRIC_UNEXERCISED)).toHaveLength(0);
    expect(report.meta.measurementsMeasured).toBeGreaterThan(0);
  });

  it('FAIRNESS_VALUE_UNAVAILABLE: a league of fixtures that carry no kickoff', () => {
    const fixtures = roundRobin({ teamCount: 6, rounds: 5 }).map((held) => ({
      ...held,
      kickoffMinutes: null,
    }));
    const report = fairnessReport({ fixtures, metricIds: [FAIRNESS_METRIC.MEAN_KICKOFF] });
    const unavailable = findingsOf(report, FAIRNESS_REASON.FAIRNESS_VALUE_UNAVAILABLE).filter(
      (finding) => finding.details.subjectKind === FAIRNESS_SUBJECT_KIND.TEAM
    );
    expect(unavailable).toHaveLength(1);
    expect(unavailable[0].details.subjectCount).toBe(6);
    // An unmeasurable metric is unexercised, and both are said.
    expect(findingsOf(report, FAIRNESS_REASON.FAIRNESS_METRIC_UNEXERCISED)).toHaveLength(1);
  });

  it('refuses a report over zero fixtures at the schema boundary', () => {
    expect(() => fairnessReport({ fixtures: [] })).toThrow(/looked at nothing/);
  });

  it('states its membership split, or states that it cannot', () => {
    const report = corpusReport();
    expect(report.membership.stated).toBe(false);
    expect(findingsOf(report, FAIRNESS_REASON.FAIRNESS_MEMBERSHIP_UNSTATED)).toHaveLength(1);

    const withRoster = fairnessReport({
      fixtures: corpusFixtures().fixtures,
      memberSubjectIds: [...rosterTeamIds()],
    });
    expect(withRoster.membership.stated).toBe(true);
    // Nine participants are off-roster: the four Minis sides and the five
    // visiting clubs. Membership changes no metric — only the split is added.
    expect(withRoster.membership.guests).toHaveLength(9);
    expect(withRoster.membership.guests).toEqual(
      expect.arrayContaining(['MinisA', 'MinisB', 'MinisC', 'MinisD'])
    );
    expect(withRoster.flags.map((flag) => `${flag.subjectId}|${flag.basis.kind}`).sort()).toEqual(
      report.flags.map((flag) => `${flag.subjectId}|${flag.basis.kind}`).sort()
    );
  });
});

/* -------------------------------------------------------------------------- */
/* 7. The objectives — pure, unwired, and honest about coverage                */
/* -------------------------------------------------------------------------- */

describe('fairness :: solver objectives', () => {
  it('reads league fixtures only, so no objective can be moved by a friendly', () => {
    expect(FAIRNESS_OBJECTIVE_COMPETITIONS).toEqual([FAIRNESS_COMPETITION.LEAGUE]);
    for (const definition of Object.values(FAIRNESS_OBJECTIVE_REGISTRY)) {
      expect(FAIRNESS_METRIC_REGISTRY[definition.metricId].counts).toEqual(
        FAIRNESS_OBJECTIVE_COMPETITIONS
      );
    }
    // Shown rather than asserted: adding the season's three scrimmages and
    // eight external fixtures to the league layer moves the hosting-balance
    // score, and reading them under their own competition does not.
    const { fixtures } = corpusFixtures();
    const leagueOnly = fixtures.filter((held) => held.competition === FAIRNESS_COMPETITION.LEAGUE);
    const withAll = scoreFairnessObjective(
      fixtures,
      { objectiveId: FAIRNESS_OBJECTIVE.HOSTING_BALANCE },
      participationOf(fixtures)
    );
    const withLeague = scoreFairnessObjective(
      leagueOnly,
      { objectiveId: FAIRNESS_OBJECTIVE.HOSTING_BALANCE },
      participationOf(leagueOnly)
    );
    expect(withLeague.score).toBeCloseTo(withAll.score, 9);
    expect(withLeague.termsScored).toBe(withAll.termsScored);
    // The two differ only in how many subjects they could not score at all.
    expect(withAll.termsUnscored).toBeGreaterThan(withLeague.termsUnscored);
  });

  it('says on every result that nothing consumes it', () => {
    const participation = participationOf(corpusFixtures().fixtures);
    for (const objectiveId of Object.values(FAIRNESS_OBJECTIVE)) {
      const result = scoreFairnessObjective(
        corpusFixtures().fixtures,
        { objectiveId },
        participation
      );
      expect(result.sense).toBe(FAIRNESS_OBJECTIVE_SENSE.MINIMISE);
      expect(
        result.findings.some(
          (finding) => finding.code === FAIRNESS_REASON.FAIRNESS_OBJECTIVE_UNWIRED
        )
      ).toBe(true);
    }
  });

  it('is pure: identical input, identical output, and the input is deep-frozen', () => {
    const fixtures = deepFreeze(
      roundRobin({ teamCount: 8, rounds: 7 }).map((held) => ({ ...held }))
    );
    const participation = participationOf(fixtures);
    const config = deepFreeze({ objectiveId: FAIRNESS_OBJECTIVE.HOSTING_BALANCE, weight: 1 });
    const first = scoreFairnessObjective(fixtures, config, participation);
    const second = scoreFairnessObjective(fixtures, config, participation);
    expect(second.score).toBe(first.score);
    expect(second.terms).toEqual(first.terms);
  });

  it('never folds an unscoreable subject in at zero, because that is the best possible penalty', () => {
    const participation = participationOf(corpusFixtures().fixtures);
    const result = scoreFairnessObjective(
      corpusFixtures().fixtures,
      { objectiveId: FAIRNESS_OBJECTIVE.HOSTING_BALANCE },
      participation
    );
    const unscored = result.terms.filter((term) => !term.scored);
    // 18 outside the league and 4 with no two-sided fixture.
    expect(unscored).toHaveLength(22);
    expect(unscored.every((term) => term.penalty === null)).toBe(true);
    expect(unscored.every((term) => term.reasonCode !== null)).toBe(true);
    expect(result.termsUnscored).toBe(22);
    expect(result.coverage).toBeCloseTo(118 / 140, 9);
    expect(
      result.findings.some(
        (finding) => finding.code === FAIRNESS_REASON.FAIRNESS_OBJECTIVE_COVERAGE_PARTIAL
      )
    ).toBe(true);

    // The control: had the 22 been folded in at 0, the total would be *lower*
    // than the honest one over the same schedule — a minimisation would prefer
    // whichever arrangement it could see least of.
    const foldedIn = result.terms.reduce((sum, term) => sum + (term.penalty ?? 0), 0);
    expect(foldedIn).toBe(result.score);
    // Same sum, different denominators: the number alone cannot tell them apart,
    // which is why coverage travels with it and comparison checks it.
    expect(result.termsScored).toBe(118);
  });

  it('refuses to rank two scores whose coverage differs, on the coverage alone', () => {
    // The two lists agree on every field the guard checks except one. The same
    // eight teams and the same 28 fixtures, plus — on the right — a ninth team
    // whose nine fixtures name no opponent: its hosting share is not a
    // quantity, so it is counted and not scored. Same objective, same weight,
    // same basis, same `termsScored`, same total. Only `coverage` differs, so
    // deleting the coverage line from `compareObjectiveScores` would make this
    // pair comparable and this test fail.
    const full = roundRobin({ teamCount: 8, rounds: 7 });
    const withUnscoreable = [
      ...full,
      ...Array.from({ length: 9 }, (unused, round) =>
        fixture({
          fixtureId: `solo-${round}`,
          date: `2026-10-${String(round + 1).padStart(2, '0')}`,
          homeSubjectId: 'T9',
          awaySubjectId: null,
        })
      ),
    ];
    const left = scoreFairnessObjective(
      full,
      { objectiveId: FAIRNESS_OBJECTIVE.HOSTING_BALANCE },
      participationOf(full)
    );
    const right = scoreFairnessObjective(
      withUnscoreable,
      { objectiveId: FAIRNESS_OBJECTIVE.HOSTING_BALANCE },
      participationOf(withUnscoreable)
    );
    expect(left.objectiveId).toBe(right.objectiveId);
    expect(left.weight).toBe(right.weight);
    expect(left.basisKind).toBe(right.basisKind);
    expect(right.termsScored).toBe(left.termsScored);
    expect(right.score).toBeCloseTo(left.score, 12);
    // …and the one field that does differ, which is the whole point: a smaller
    // sum over fewer terms is a shorter sum, not a better schedule.
    expect(left.coverage).toBe(1);
    expect(right.coverage).toBeCloseTo(8 / 9, 12);

    const comparison = compareObjectiveScores(left, right);
    expect(comparison.comparable).toBe(false);
    expect(comparison.better).toBeNull();
    expect(comparison.delta).toBeNull();
    expect(comparison.findings[0].code).toBe(FAIRNESS_REASON.FAIRNESS_OBJECTIVE_INCOMPARABLE);
    expect(comparison.findings[0].severity).toBe(FAIRNESS_SEVERITY.BLOCKING);
    // The refusal names coverage and nothing else, which is what makes the
    // guard the thing under test rather than whichever mismatch happened first.
    expect(comparison.findings[0].details.mismatches).toEqual(['coverage']);

    // And two comparable results are ranked, in the declared sense.
    const same = scoreFairnessObjective(
      full,
      { objectiveId: FAIRNESS_OBJECTIVE.HOSTING_BALANCE },
      participationOf(full)
    );
    const tie = compareObjectiveScores(left, same);
    expect(tie.comparable).toBe(true);
    expect(tie.delta).toBe(0);
    expect(tie.better).toBeNull();
  });

  it('scores a lopsided hosting split worse than an even one, in the declared sense', () => {
    const even = roundRobin({ teamCount: 8, rounds: 8 });
    const lopsided = even.map((held) => ({
      ...held,
      homeSubjectId:
        held.homeSubjectId < held.awaySubjectId ? held.homeSubjectId : held.awaySubjectId,
      awaySubjectId:
        held.homeSubjectId < held.awaySubjectId ? held.awaySubjectId : held.homeSubjectId,
    }));
    const a = scoreFairnessObjective(
      even,
      { objectiveId: FAIRNESS_OBJECTIVE.HOSTING_BALANCE },
      participationOf(even)
    );
    const b = scoreFairnessObjective(
      lopsided,
      { objectiveId: FAIRNESS_OBJECTIVE.HOSTING_BALANCE },
      participationOf(lopsided)
    );
    expect(b.score).toBeGreaterThan(a.score);
    const comparison = compareObjectiveScores(a, b);
    expect(comparison.comparable).toBe(true);
    expect(comparison.better).toBe('left');
  });

  it('is not wired: no scheduling module imports this package', async () => {
    const { readFileSync, readdirSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const path = await import('node:path');
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const core = path.join(root, 'packages', 'core', 'src');
    // `autoScheduler.js` uses the word in its own prose and in a `fairnessScore`
    // of its own — a different thing, and untouched by this work. What is
    // asserted is that none of the three *imports* this package.
    for (const file of ['gameScheduling.js', 'autoScheduler.js', 'gameMetrics.js']) {
      const source = readFileSync(path.join(core, file), 'utf8');
      expect(source).not.toMatch(/from\s+['"][^'"]*fairness/);
      expect(source).not.toMatch(/import\s*\(\s*['"][^'"]*fairness/);
    }
    // And nothing anywhere in the package outside `fairness/` and its own tests
    // reaches into it either.
    const importers = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'fairness') walk(full);
          continue;
        }
        if (!entry.name.endsWith('.js')) continue;
        if (/from\s+['"][^'"]*fairness/.test(readFileSync(full, 'utf8'))) importers.push(full);
      }
    };
    walk(core);
    expect(importers).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* 8. Structure                                                                */
/* -------------------------------------------------------------------------- */

describe('fairness :: structure', () => {
  it('registers a severity for every declared reason code, and only for declared ones', () => {
    const declared = new Set(Object.values(FAIRNESS_REASON));
    expect(Object.keys(FAIRNESS_REASON_SEVERITY).sort()).toEqual([...declared].sort());
    for (const severity of Object.values(FAIRNESS_REASON_SEVERITY)) {
      expect(Object.values(FAIRNESS_SEVERITY)).toContain(severity);
    }
  });

  it('reads its input and writes nothing, against a deep-frozen fixture list', () => {
    const fixtures = deepFreeze(corpusFixtures().fixtures.map((held) => ({ ...held })));
    // Prove the freeze bites before relying on it.
    expect(() => {
      fixtures[0].kickoffMinutes = 1;
    }).toThrow();
    const report = fairnessReport({ fixtures });
    expect(report.meta.fixturesRead).toBe(578);
    expect(report.flags.length).toBeGreaterThan(0);
  });

  it('publishes one measurement per subject and metric, at all three subject kinds', () => {
    const report = corpusReport();
    for (const subjectKind of Object.values(FAIRNESS_SUBJECT_KIND)) {
      for (const metricId of FAIRNESS_METRIC_ORDER) {
        expect(measurementsOf(report, metricId, subjectKind).length).toBeGreaterThan(0);
      }
    }
    expect(report.meta.measurementsMeasured + report.meta.measurementsUnmeasurable).toBe(
      report.measurements.length
    );
    expect(report.meta.judgementsMade + report.meta.judgementsUndecided).toBe(
      report.judgements.length
    );
    expect(report.meta.flagsRaised).toBe(report.flags.length);
  });

  it('publishes a division’s value as the same number a team in it was judged against', () => {
    const report = corpusReport();
    const divisionValue = report.measurements.find(
      (measurement) =>
        measurement.subjectKind === FAIRNESS_SUBJECT_KIND.DIVISION &&
        measurement.subjectId === 'U09G' &&
        measurement.metricId === FAIRNESS_METRIC.MEAN_KICKOFF
    );
    const population = report.populations.find(
      (candidate) =>
        candidate.subjectKind === FAIRNESS_SUBJECT_KIND.TEAM &&
        candidate.basisKind === FAIRNESS_BASIS.DIVISION &&
        candidate.groupKey === 'U09G' &&
        candidate.metricId === FAIRNESS_METRIC.MEAN_KICKOFF
    );
    expect(divisionValue.value).toBe(population.dispersion.centre);
  });
});

/* -------------------------------------------------------------------------- */
/* 9. The pre-PR review: nine defects, and the rule each one broke             */
/* -------------------------------------------------------------------------- */

describe('fairness :: the metricIds filter is a filter', () => {
  it('publishes nothing about a metric the caller excluded — swept over every subset of one', () => {
    // Constructed rather than corpus so the sweep can afford to run four
    // reports: eight teams, seven rounds, every fixture two sided, timed and
    // located, so all four metrics are live and any leak is visible.
    const fixtures = roundRobin({ teamCount: 8, rounds: 7 });
    let swept = 0;
    for (const metricId of FAIRNESS_METRIC_ORDER) {
      const report = fairnessReport({ fixtures, metricIds: [metricId] });
      // Meta-assertion: a report that measured nothing would satisfy every
      // containment below while looking at an empty set.
      expect(report.measurements.length).toBeGreaterThan(0);
      expect([...new Set(report.measurements.map((m) => m.metricId))]).toEqual([metricId]);
      expect([...new Set(report.populations.map((p) => p.metricId))]).toEqual([metricId]);
      expect([...new Set(report.judgements.map((j) => j.metricId))]).toEqual([metricId]);
      // Findings too: a finding about a metric nobody asked about is the
      // filter doing nothing where it claims to do something.
      const named = report.findings
        .map((finding) => finding.details.metricId)
        .filter((id) => typeof id === 'string');
      expect(named.length).toBeGreaterThan(0);
      expect([...new Set(named)]).toEqual([metricId]);
      swept += 1;
    }
    expect(swept).toBe(FAIRNESS_METRIC_ORDER.length);

    // A subset of two behaves the same way, so the rule is about the filter
    // and not about the number one.
    const pair = [FAIRNESS_METRIC.GAMES_PLAYED, FAIRNESS_METRIC.VENUE_SPREAD];
    const report = fairnessReport({ fixtures, metricIds: pair });
    expect([...new Set(report.measurements.map((m) => m.metricId))].sort()).toEqual(
      [...pair].sort()
    );
  });

  it('reports the metric it keeps exactly as the unfiltered report does', () => {
    const report = fairnessReport({
      fixtures: corpusFixtures().fixtures,
      metricIds: [FAIRNESS_METRIC.MEAN_KICKOFF],
    });
    const all = corpusReport();
    const key = (row) =>
      `${row.subjectKind}|${row.subjectId}|${row.measurability}|${row.value}|${row.reasonCode}`;
    const mine = report.measurements.map(key).sort();
    const theirs = all.measurements
      .filter((m) => m.metricId === FAIRNESS_METRIC.MEAN_KICKOFF)
      .map(key)
      .sort();
    expect(mine.length).toBeGreaterThan(0);
    expect(mine).toEqual(theirs);
    expect(report.flags).toHaveLength(
      all.flags.filter((flag) => flag.metricId === FAIRNESS_METRIC.MEAN_KICKOFF).length
    );
  });

  it('refuses an unregistered metric id instead of reporting an unjudgeable season', () => {
    const { fixtures } = corpusFixtures();
    expect(() => fairnessReport({ fixtures, metricIds: ['mean-kickof'] })).toThrow(
      /is not a member of FAIRNESS_METRIC/
    );
    // The same refusal its sibling already gives for an unregistered objective,
    // rather than a third contract for the same mistake.
    expect(() =>
      scoreFairnessObjective(fixtures, { objectiveId: 'hosting-balanc' }, participationOf(fixtures))
    ).toThrow(/is not a member of FAIRNESS_OBJECTIVE/);
    // The control: spelled correctly, the same call judges a season, so the
    // refusal is about the argument and not about the corpus.
    const spelled = fairnessReport({ fixtures, metricIds: [FAIRNESS_METRIC.MEAN_KICKOFF] });
    expect(spelled.meta.judgementsMade).toBeGreaterThan(0);
    expect(findingsOf(spelled, FAIRNESS_REASON.FAIRNESS_NOTHING_JUDGED)).toHaveLength(0);
  });
});

describe('fairness :: evidence a reader can check by hand', () => {
  it('never publishes a fixture count larger than the fixtures it is drawn from', () => {
    const report = corpusReport();
    const participation = participationOf(corpusFixtures().fixtures);
    const teamMeasurement = (subjectId, metricId) =>
      report.measurements.find(
        (m) =>
          m.subjectKind === FAIRNESS_SUBJECT_KIND.TEAM &&
          m.subjectId === subjectId &&
          m.metricId === metricId
      );

    // Rule one, at the team level: a measurement accounts for every fixture the
    // subject appears in, once, and for none it does not.
    let teamsChecked = 0;
    for (const measurement of report.measurements) {
      if (measurement.subjectKind !== FAIRNESS_SUBJECT_KIND.TEAM) continue;
      const held = participation.get(measurement.subjectId).fixtures.length;
      expect(measurement.evidence.fixturesCounted + measurement.evidence.fixturesExcluded).toBe(
        held
      );
      teamsChecked += 1;
    }
    expect(teamsChecked).toBe(140 * FAIRNESS_METRIC_ORDER.length);

    // Rule two, at the group level: a group's fixture evidence is drawn from the
    // distinct fixtures its members hold — a **union**, never a sum. A two-sided
    // fixture is one fixture however many of the group's teams played in it, and
    // the sum-of-members identity the last round asserted is what published 72
    // counted fixtures about a division of 36. The denominator below comes from
    // `participationOf()`, which no defect in `measureGroup()` can corrupt.
    let groupsChecked = 0;
    let naiveSumWouldExceed = 0;
    /** @type {string[]} */
    const oneToOne = [];
    for (const measurement of report.measurements) {
      if (measurement.subjectKind === FAIRNESS_SUBJECT_KIND.TEAM) continue;
      const basisKind =
        measurement.subjectKind === FAIRNESS_SUBJECT_KIND.DIVISION
          ? FAIRNESS_BASIS.DIVISION
          : FAIRNESS_BASIS.AGE_GROUP;
      const population = report.populations.find(
        (candidate) =>
          candidate.subjectKind === FAIRNESS_SUBJECT_KIND.TEAM &&
          candidate.basisKind === basisKind &&
          candidate.groupKey === measurement.subjectId &&
          candidate.metricId === measurement.metricId
      );
      const members = [...population.memberIds, ...population.undecidedMemberIds];
      expect(members.length).toBeGreaterThan(0);
      const held = new Set(
        members.flatMap((subjectId) =>
          participation.get(subjectId).fixtures.map((entry) => entry.fixture.fixtureId)
        )
      );
      expect(held.size).toBeGreaterThan(0);
      // Every fixture the members hold is accounted for exactly once, as
      // counted or as excluded, and neither number is larger than the set it is
      // drawn from.
      expect(measurement.evidence.fixturesCounted + measurement.evidence.fixturesExcluded).toBe(
        held.size
      );
      // Every exclusion a measurement publishes is denominated in fixtures, so
      // the counts sum to the field that claims to be their sum.
      expect(measurement.evidence.exclusions.reduce((sum, [, count]) => sum + count, 0)).toBe(
        measurement.evidence.fixturesExcluded
      );
      const naive = members.reduce((sum, subjectId) => {
        const member = teamMeasurement(subjectId, measurement.metricId);
        return sum + member.evidence.fixturesCounted + member.evidence.fixturesExcluded;
      }, 0);
      if (naive > held.size) naiveSumWouldExceed += 1;
      else oneToOne.push(`${measurement.subjectId}/${measurement.metricId}`);
      groupsChecked += 1;
    }
    // Meta-assertions on the sweep's own population. Fifteen divisions and seven
    // age groups at four metrics each, and on 84 of the 88 the old identity is
    // not merely satisfied a different way — it is **false**, by a factor of up
    // to two. The four it still holds on are exactly division `BB`, whose
    // fixtures name no opponent so that each is held by one member: the 1:1 case
    // the last round chose as its pinned example, which is why the rule it wrote
    // down could not catch the rule it broke.
    expect(groupsChecked).toBe(88);
    expect(groupsChecked).toBe(report.measurements.length - 140 * FAIRNESS_METRIC_ORDER.length);
    expect(naiveSumWouldExceed).toBe(84);
    expect(oneToOne.sort()).toEqual(
      FAIRNESS_METRIC_ORDER.map((metricId) => `BB/${metricId}`).sort()
    );

    // Rule three, over **every** measurement of every kind: a published count is
    // the size of the id set published beside it, and both sets are drawn from
    // the fixtures the subject actually holds. This is the contract in its
    // general form — no evidence count exceeds the population it is drawn from.
    let swept = 0;
    for (const measurement of report.measurements) {
      const drawnFrom =
        measurement.subjectKind === FAIRNESS_SUBJECT_KIND.TEAM
          ? new Set(
              participation
                .get(measurement.subjectId)
                .fixtures.map((entry) => entry.fixture.fixtureId)
            )
          : new Set(
              report.populations
                .filter(
                  (candidate) =>
                    candidate.subjectKind === FAIRNESS_SUBJECT_KIND.TEAM &&
                    candidate.groupKey === measurement.subjectId &&
                    candidate.metricId === measurement.metricId
                )
                .flatMap((candidate) => [...candidate.memberIds, ...candidate.undecidedMemberIds])
                .flatMap((subjectId) =>
                  participation.get(subjectId).fixtures.map((entry) => entry.fixture.fixtureId)
                )
            );
      const counted = measurement.evidence.countedFixtureIds;
      const excluded = measurement.evidence.excludedFixtureIds;
      expect(measurement.evidence.fixturesCounted).toBe(new Set(counted).size);
      expect(measurement.evidence.fixturesExcluded).toBe(new Set(excluded).size);
      expect(counted.filter((id) => excluded.includes(id))).toEqual([]);
      expect([...counted, ...excluded].filter((id) => !drawnFrom.has(id))).toEqual([]);
      expect(measurement.evidence.fixturesCounted).toBeLessThanOrEqual(drawnFrom.size);
      expect(measurement.evidence.fixturesExcluded).toBeLessThanOrEqual(drawnFrom.size);
      swept += 1;
    }
    expect(swept).toBe(648);
    expect(swept).toBe(report.measurements.length);

    // Rule four, the one the other three assume: **the count published as
    // evidence is over exactly the set the value was computed from.** The two
    // are derived separately — the value from the entry list, the count from a
    // set of ids — and nothing in the arithmetic makes them agree; what makes
    // them agree is that one fixture id names one row, which the classifier now
    // refuses a list for breaking. `games-played` is where a divergence is
    // visible without arithmetic, because its unit *is* that count: a subject
    // holding two rows under one id published `value: 4` beside
    // `fixturesCounted: 3`. The list that makes this rule fail is built in
    // 'fairness :: one fixture id is one fixture' below; here it is asserted
    // over every team the corpus measures.
    let valuesChecked = 0;
    for (const measurement of report.measurements) {
      if (measurement.metricId !== FAIRNESS_METRIC.GAMES_PLAYED) continue;
      if (measurement.subjectKind !== FAIRNESS_SUBJECT_KIND.TEAM) continue;
      if (measurement.measurability !== FAIRNESS_MEASURABILITY.MEASURED) continue;
      expect(measurement.value).toBe(measurement.evidence.fixturesCounted);
      expect(measurement.value).toBe(measurement.evidence.countedFixtureIds.length);
      valuesChecked += 1;
    }
    // Meta-assertion on this sweep's own population: 122 of the 140
    // participants hold a league fixture, and a sweep that measured none of
    // them would agree with itself about nothing.
    expect(valuesChecked).toBe(122);

    // The pinned example, at a ratio that is **not** 1:1 and checked by hand
    // against the corpus: division `U05B` is eight teams playing nine league
    // fixtures each, which is 36 fixtures and not 72.
    const u05b = report.measurements.find(
      (m) =>
        m.subjectKind === FAIRNESS_SUBJECT_KIND.DIVISION &&
        m.subjectId === 'U05B' &&
        m.metricId === FAIRNESS_METRIC.GAMES_PLAYED
    );
    expect(corpusFixtures().fixtures.filter((f) => f.division === 'U05B')).toHaveLength(36);
    expect(u05b.evidence.membersCounted).toBe(8);
    expect(u05b.evidence.membersCounted * 9).toBe(72);
    expect(u05b.evidence.fixturesCounted).toBe(36);
    expect(u05b.evidence.countedFixtureIds).toHaveLength(36);

    // The earlier instance the review found, still pinned: 36 excluded on a
    // division of 36, with the member tally published as members.
    const bb = report.measurements.find(
      (m) =>
        m.subjectKind === FAIRNESS_SUBJECT_KIND.DIVISION &&
        m.subjectId === 'BB' &&
        m.metricId === FAIRNESS_METRIC.HOSTING_SHARE
    );
    expect(corpusFixtures().fixtures.filter((f) => f.division === 'BB')).toHaveLength(36);
    expect(bb.evidence.fixturesExcluded).toBe(36);
    // The member accounting is still published — as members, under its own name.
    expect(bb.evidence.membersExcluded).toBe(4);
    expect(bb.evidence.membersCounted).toBe(0);
  });

  it('counts into `fixturesCounted` only the fixtures a requested metric reads', () => {
    const report = corpusReport();
    const { fixtures } = corpusFixtures();
    const leagueFixtures = fixtures.filter(
      (held) => held.competition === FAIRNESS_COMPETITION.LEAGUE
    );
    expect(report.meta.fixturesRead).toBe(578);
    expect(report.meta.fixturesCounted).toBe(leagueFixtures.length);
    expect(report.meta.fixturesCounted).toBe(567);
    // The shortfall the counter exists to show: eight external seeding games
    // and three scrimmages are read and counted into no metric.
    expect(report.meta.fixturesRead - report.meta.fixturesCounted).toBe(11);

    // The rule, not the instance: for a given set of metrics the counter is the
    // number of distinct fixtures belonging to a competition one of them counts.
    const expected = (metrics) =>
      new Set(
        fixtures
          .filter((held) => metrics.some((metric) => metric.counts.includes(held.competition)))
          .map((held) => held.fixtureId)
      ).size;
    const registered = (metricIds) => metricIds.map((id) => FAIRNESS_METRIC_REGISTRY[id]);
    expect(report.meta.fixturesCounted).toBe(expected(registered(FAIRNESS_METRIC_ORDER)));

    // …and the premise that makes the report-level check above a weak one,
    // asserted so that it cannot go on being weak in silence. **Every declared
    // metric counts the same competitions**, so `expected(any subset)` equals
    // `expected(all)` by construction: comparing one subset of the registry
    // against another compares a set with itself and passes against an
    // implementation that ignores `metricIds` entirely, which is what the check
    // written here last round did. The day a metric counts something else this
    // line fails and demands a report-level case with sets that genuinely
    // differ.
    const competitionSets = new Set(
      FAIRNESS_METRIC_ORDER.map((metricId) =>
        [...FAIRNESS_METRIC_REGISTRY[metricId].counts].sort().join('|')
      )
    );
    expect([...competitionSets]).toEqual([FAIRNESS_COMPETITION.LEAGUE]);
    const one = fairnessReport({ fixtures, metricIds: [FAIRNESS_METRIC.VENUE_SPREAD] });
    expect(one.meta.fixturesCounted).toBe(report.meta.fixturesCounted);
    expect(one.meta.fixturesCounted).toBeLessThan(one.meta.fixturesRead);

    // So the rule is asserted where it can fail: at `countedFixturesOf()`, the
    // function `fairnessReport()` computes the counter with, driven with metric
    // definitions whose competitions differ. Deleting the `metric.counts` test
    // from it — counting every fixture a participant holds — makes all four of
    // these fail, and the report-level lines above pass unchanged.
    const participation = participationOf(fixtures);
    const reading = (...counts) => [
      { ...FAIRNESS_METRIC_REGISTRY[FAIRNESS_METRIC.GAMES_PLAYED], counts },
    ];
    expect(countedFixturesOf(participation, reading(FAIRNESS_COMPETITION.LEAGUE))).toHaveLength(
      567
    );
    expect(countedFixturesOf(participation, reading(FAIRNESS_COMPETITION.EXTERNAL))).toHaveLength(
      8
    );
    expect(countedFixturesOf(participation, reading(FAIRNESS_COMPETITION.FRIENDLY))).toHaveLength(
      3
    );
    expect(countedFixturesOf(participation, reading())).toHaveLength(0);
    // Two metrics reading different competitions: the union, and distinct — a
    // fixture read by both is one fixture.
    expect(
      countedFixturesOf(participation, [
        ...reading(FAIRNESS_COMPETITION.EXTERNAL),
        ...reading(FAIRNESS_COMPETITION.EXTERNAL, FAIRNESS_COMPETITION.FRIENDLY),
      ])
    ).toHaveLength(11);
    // Meta-assertion: the four figures above are four *different* answers over
    // one participation map, so a function that ignored its metrics could not
    // produce them; and they are the corpus' own competition split.
    expect(new Set([567, 8, 3, 0, 11]).size).toBe(5);
    expect(report.fixturesByCompetition).toEqual({ league: 567, external: 8, friendly: 3 });
  });
});

describe('fairness :: an objective scores the fixture list it is given', () => {
  it('refuses a participation map that is not the one those fixtures produce', () => {
    const { fixtures } = corpusFixtures();
    const leagueOnly = fixtures.filter((held) => held.competition === FAIRNESS_COMPETITION.LEAGUE);
    const config = { objectiveId: FAIRNESS_OBJECTIVE.HOSTING_BALANCE };

    // The defect: a filtered fixture list handed the whole season's map used to
    // score the whole season and say nothing about it.
    expect(() => scoreFairnessObjective(leagueOnly, config, participationOf(fixtures))).toThrow(
      /participation/
    );

    // Honoured: the fixtures alone decide, and the map is optional corroboration.
    const derived = scoreFairnessObjective(leagueOnly, config);
    const matched = scoreFairnessObjective(leagueOnly, config, participationOf(leagueOnly));
    expect(derived.score).toBe(matched.score);
    expect(derived.terms).toEqual(matched.terms);
    expect(derived.termsScored).toBeGreaterThan(0);

    // And the whole-season list is a different quantity, which is the point.
    const whole = scoreFairnessObjective(fixtures, config);
    expect(whole.terms.length).toBeGreaterThan(derived.terms.length);
  });
});

describe('fairness :: uniform is decided on the tolerance it is published at', () => {
  it('does not call a population degenerate while its own evidence shows one value', () => {
    // Three exact values and one a floating-point hair above: the median
    // absolute deviation is exactly zero, and the published distribution — which
    // rounds to six decimal places — shows a single value.
    const noisy = describeDispersion('m', [
      { subjectId: 'a', value: 605 },
      { subjectId: 'b', value: 605 },
      { subjectId: 'c', value: 605 },
      { subjectId: 'd', value: 605 + 1e-13 },
    ]);
    expect(noisy.scale).toBe(0);
    expect(noisy.distribution).toEqual([[605, 4]]);
    expect(noisy.state).toBe(FAIRNESS_DISPERSION.UNIFORM);

    // The tolerance is a decision and not an accident: a difference the
    // published distribution *can* show is still degenerate.
    const visible = describeDispersion('m', [
      { subjectId: 'a', value: 605 },
      { subjectId: 'b', value: 605 },
      { subjectId: 'c', value: 605 },
      { subjectId: 'd', value: 605.00001 },
    ]);
    expect(visible.distribution).toHaveLength(2);
    expect(visible.state).toBe(FAIRNESS_DISPERSION.DEGENERATE);

    // The rule, swept over the corpus: no population's state contradicts the
    // distribution it publishes.
    const report = corpusReport();
    const flat = report.populations.filter((population) => population.dispersion.scale === 0);
    expect(flat.length).toBeGreaterThan(0);
    let uniform = 0;
    let degenerate = 0;
    for (const population of flat) {
      const single = population.dispersion.distribution.length === 1;
      expect(population.dispersion.state).toBe(
        single ? FAIRNESS_DISPERSION.UNIFORM : FAIRNESS_DISPERSION.DEGENERATE
      );
      if (single) uniform += 1;
      else degenerate += 1;
    }
    expect(uniform).toBeGreaterThan(0);
    expect(degenerate).toBeGreaterThan(0);
  });
});

describe('fairness :: a league cohort is drawn from league fixtures', () => {
  it('does not let a friendly’s spelling decide a league metric’s cohort', () => {
    // Six teams, nine league rounds, every league row spelled `U10B`. One
    // friendly names T1 under `10B` — the same division, spelled differently,
    // which is precisely what GAP-24 says a label is free to be.
    const league = roundRobin({ teamCount: 6, rounds: 9 });
    const friendly = fixture({
      fixtureId: 'friendly-1',
      date: '2026-11-07',
      competition: FAIRNESS_COMPETITION.FRIENDLY,
      division: '10B',
      ageGroup: 'U10',
      homeSubjectId: 'T1',
      awaySubjectId: 'T2',
    });
    const report = fairnessReport({ fixtures: [...league, friendly] });
    const judgement = report.judgements.find(
      (candidate) =>
        candidate.subjectId === 'T1' &&
        candidate.basis.kind === FAIRNESS_BASIS.DIVISION &&
        candidate.metricId === FAIRNESS_METRIC.GAMES_PLAYED
    );
    expect(judgement.basis.groupKey).toBe('U10B');
    expect(judgement.reasonCode).not.toBe(FAIRNESS_REASON.FAIRNESS_GROUP_AMBIGUOUS);
    expect(findingsOf(report, FAIRNESS_REASON.FAIRNESS_GROUP_AMBIGUOUS)).toHaveLength(0);

    // The positive control, so the case is known to bite: the identical list
    // with that one row read as league *does* make T1 ambiguous.
    const polluted = fairnessReport({
      fixtures: [...league, { ...friendly, competition: FAIRNESS_COMPETITION.LEAGUE }],
    });
    const pollutedJudgement = polluted.judgements.find(
      (candidate) =>
        candidate.subjectId === 'T1' &&
        candidate.basis.kind === FAIRNESS_BASIS.DIVISION &&
        candidate.metricId === FAIRNESS_METRIC.GAMES_PLAYED
    );
    expect(pollutedJudgement.basis.groupKey).toBeNull();
    expect(pollutedJudgement.reasonCode).toBe(FAIRNESS_REASON.FAIRNESS_GROUP_AMBIGUOUS);
    expect(findingsOf(polluted, FAIRNESS_REASON.FAIRNESS_GROUP_AMBIGUOUS).length).toBeGreaterThan(
      0
    );
  });

  it('gives the corpus’ eighteen non-league participants no league cohort at all', () => {
    const report = corpusReport();
    const participation = participationOf(corpusFixtures().fixtures);
    const outside = [...participation.entries()]
      .filter(([, entry]) => entry.byCompetition.league === 0)
      .map(([subjectId]) => subjectId);
    expect(outside).toHaveLength(18);
    for (const subjectId of outside) {
      const judgement = report.judgements.find(
        (candidate) =>
          candidate.subjectId === subjectId &&
          candidate.basis.kind === FAIRNESS_BASIS.DIVISION &&
          candidate.metricId === FAIRNESS_METRIC.GAMES_PLAYED
      );
      expect(judgement.basis.groupKey).toBeNull();
      expect(judgement.judgement).toBe(FAIRNESS_JUDGEMENT.UNDECIDED);
    }
    // …and their labels really do come from outside the league, which is what
    // used to place them in a league cohort.
    expect(
      outside.every((subjectId) =>
        participation
          .get(subjectId)
          .fixtures.every((held) => held.fixture.competition !== FAIRNESS_COMPETITION.LEAGUE)
      )
    ).toBe(true);
  });
});

describe('fairness :: one enum, read the same way by both halves', () => {
  it('counts a fixture into a participation record exactly when the classifier counts it', () => {
    // `LEAGUE` is the case that separated the two: a value-based check rejects
    // it and a key-based one — `competition.toUpperCase()` against the enum's
    // own keys — accepts it. A future member spelled `cup-tie` would part them
    // the other way round.
    const probes = [
      'league',
      'external',
      'friendly',
      'LEAGUE',
      'External',
      'FRIENDLY',
      'cup-tie',
      'CUP_TIE',
      'tournament',
    ];
    let disagreements = [];
    let accepted = 0;
    for (const competition of probes) {
      const held = fixture({ fixtureId: `p-${competition}`, competition });
      const classification = classifyFairnessFixtures([held]);
      const classified =
        Object.values(classification.byCompetition).reduce((sum, count) => sum + count, 0) === 1;
      const participation = participationOf([held]);
      const recorded = participation.size > 0;
      if (classified !== recorded) disagreements.push(competition);
      if (classified) accepted += 1;
      // Whatever it decides, a participation record never grows a column the
      // enum does not declare.
      for (const entry of participation.values()) {
        expect(Object.keys(entry.byCompetition)).toEqual([...FAIRNESS_COMPETITION_ORDER]);
        expect(Object.values(entry.byCompetition).every(Number.isFinite)).toBe(true);
      }
    }
    // Meta-assertions: a sweep that classified nothing, or everything, would
    // agree with itself while proving nothing.
    expect(accepted).toBe(3);
    expect(probes.length - accepted).toBe(6);
    expect(disagreements).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* 12. One fixture id is one fixture                                           */
/* -------------------------------------------------------------------------- */

describe('fairness :: one fixture id is one fixture', () => {
  /**
   * Five rows over four teams, two of them carrying the id `f1`.
   *
   * `A` appears on four rows and under three ids, which is the shape that
   * parted a value from its evidence: `games-played` counts entries and
   * published `value: 4`, while `evidence()` counted a set of ids and published
   * `fixturesCounted: 3` with `countedFixtureIds: ['f1', 'f4', 'f5']` beside
   * it. The division published 4 counted over 5 rows, and
   * `meta.fixturesCounted` reported a read-vs-counted shortfall of one against
   * a list every row of which a metric reads. None of it raised a finding.
   */
  const duplicated = () => [
    fixture({ fixtureId: 'f1', date: '2026-09-01', homeSubjectId: 'A', awaySubjectId: 'B' }),
    fixture({ fixtureId: 'f1', date: '2026-09-08', homeSubjectId: 'A', awaySubjectId: 'C' }),
    fixture({ fixtureId: 'f4', date: '2026-09-15', homeSubjectId: 'A', awaySubjectId: 'D' }),
    fixture({ fixtureId: 'f5', date: '2026-09-22', homeSubjectId: 'A', awaySubjectId: 'B' }),
    fixture({ fixtureId: 'f6', date: '2026-09-29', homeSubjectId: 'C', awaySubjectId: 'D' }),
  ];

  it('refuses a list that names one fixture id twice, at both entry points', () => {
    const rows = duplicated();
    // Meta-assertion on the case itself: five rows, four ids, and `A` on four
    // of the rows under three of the ids. A construction that had lost its
    // duplicate would prove nothing below.
    expect(rows).toHaveLength(5);
    expect(new Set(rows.map((held) => held.fixtureId)).size).toBe(4);

    const report = fairnessReport({ fixtures: rows });
    expect(report.status).toBe(FAIRNESS_STATUS.REJECTED);
    const refusal = findingsOf(report, FAIRNESS_REASON.FAIRNESS_FIXTURE_DUPLICATED);
    expect(refusal).toHaveLength(1);
    expect(refusal[0].severity).toBe(FAIRNESS_SEVERITY.BLOCKING);
    expect(refusal[0].details.fixtureIds).toEqual(['f1']);
    expect(refusal[0].details.duplicatedFixtureIds).toBe(1);
    expect(refusal[0].details.rowsRead).toBe(5);
    // Blocking, so no metric ran: the report publishes no team measurement at
    // all rather than one whose count is over a set its value did not come
    // from.
    expect(report.measurements.filter((m) => m.subjectKind === FAIRNESS_SUBJECT_KIND.TEAM)).toEqual(
      []
    );

    // The objective is the half a solver would consume, and it gives the same
    // answer about the same list.
    const objective = scoreFairnessObjective(rows, {
      objectiveId: FAIRNESS_OBJECTIVE.GAME_COUNT_PARITY,
    });
    expect(objective.status).toBe(FAIRNESS_STATUS.REJECTED);
    expect(
      objective.findings.some(
        (finding) => finding.code === FAIRNESS_REASON.FAIRNESS_FIXTURE_DUPLICATED
      )
    ).toBe(true);
    expect(objective.terms).toEqual([]);
    expect(objective.score).toBeNull();
  });

  it('reads the same five rows once the second `f1` has its own id', () => {
    // The control, and the reason the refusal above is about a duplicate rather
    // than about this list: one character changes, and the list is read. An
    // implementation that refused every list would fail here.
    const repaired = duplicated().map((held, index) =>
      index === 1 ? { ...held, fixtureId: 'f2' } : held
    );
    const clean = fairnessReport({ fixtures: repaired });
    expect(findingsOf(clean, FAIRNESS_REASON.FAIRNESS_FIXTURE_DUPLICATED)).toHaveLength(0);

    const a = clean.measurements.find(
      (m) =>
        m.subjectKind === FAIRNESS_SUBJECT_KIND.TEAM &&
        m.subjectId === 'A' &&
        m.metricId === FAIRNESS_METRIC.GAMES_PLAYED
    );
    // The four numbers that disagreed, now one number four times over.
    expect(a.value).toBe(4);
    expect(a.evidence.fixturesCounted).toBe(4);
    expect(a.evidence.countedFixtureIds).toEqual(['f1', 'f2', 'f4', 'f5']);
    expect(clean.meta.fixturesRead).toBe(5);
    expect(clean.meta.fixturesCounted).toBe(5);
    expect(clean.meta.fixturesRead - clean.meta.fixturesCounted).toBe(0);

    // …and the division, which used to publish four counted fixtures over the
    // five its members actually hold.
    const division = clean.measurements.find(
      (m) =>
        m.subjectKind === FAIRNESS_SUBJECT_KIND.DIVISION &&
        m.subjectId === 'U10B' &&
        m.metricId === FAIRNESS_METRIC.GAMES_PLAYED
    );
    expect(division.evidence.fixturesCounted).toBe(5);
    expect(division.evidence.countedFixtureIds).toHaveLength(5);
  });

  it('refuses to publish a count over a set the value did not come from', () => {
    // The invariant made structural at the line it was broken on, so that a
    // caller reaching `measureSubject()` directly — past the classifier that
    // refuses the list above — cannot produce the divergence either. Two rows,
    // one id: `games-played` would count two and the evidence would name one.
    const twice = [
      { fixture: fixture({ fixtureId: 'f1' }), side: FAIRNESS_SIDE.HOME },
      { fixture: fixture({ fixtureId: 'f1', date: '2026-08-29' }), side: FAIRNESS_SIDE.HOME },
    ];
    const gamesPlayed = FAIRNESS_METRIC_REGISTRY[FAIRNESS_METRIC.GAMES_PLAYED];
    expect(() => measureSubject(gamesPlayed, FAIRNESS_SUBJECT_KIND.TEAM, 'A', twice)).toThrow(
      /"f1"/
    );

    // The control: the same two rows under two ids measure, and the value is
    // the size of the set the evidence names.
    const once = [
      twice[0],
      { fixture: fixture({ fixtureId: 'f2', date: '2026-08-29' }), side: FAIRNESS_SIDE.HOME },
    ];
    const measurement = measureSubject(gamesPlayed, FAIRNESS_SUBJECT_KIND.TEAM, 'A', once);
    expect(measurement.value).toBe(2);
    expect(measurement.evidence.fixturesCounted).toBe(2);
    expect(measurement.evidence.countedFixtureIds).toEqual(['f1', 'f2']);
  });

  it('refuses a set-aside id the metric also counted, which would break the exclusion sum', () => {
    // `withSetAside()` documents its two id sets as disjoint by construction —
    // true because competition is a property of a fixture and the metric was
    // only ever handed the competitions it counts. The review asked for it to
    // be asserted rather than assumed, because the identity that rests on it —
    // `exclusions` summing to `fixturesExcluded` — breaks silently if it stops
    // holding: the union would be smaller than the sum of the buckets and
    // nothing would object.
    const gamesPlayed = FAIRNESS_METRIC_REGISTRY[FAIRNESS_METRIC.GAMES_PLAYED];
    const shared = fixture({ fixtureId: 'f1' });
    expect(() =>
      measureSubject(gamesPlayed, FAIRNESS_SUBJECT_KIND.TEAM, 'A', [
        { fixture: shared, side: FAIRNESS_SIDE.HOME },
        // The same id under a competition this metric does not count: one row
        // is both counted and set aside, which no fixture list can produce.
        {
          fixture: fixture({ fixtureId: 'f1', competition: FAIRNESS_COMPETITION.FRIENDLY }),
          side: FAIRNESS_SIDE.HOME,
        },
      ])
    ).toThrow(/"f1"/);

    // The control: a genuinely disjoint set-aside is accounted for, and the
    // buckets still sum to the total.
    const measurement = measureSubject(gamesPlayed, FAIRNESS_SUBJECT_KIND.TEAM, 'A', [
      { fixture: shared, side: FAIRNESS_SIDE.HOME },
      {
        fixture: fixture({ fixtureId: 'f2', competition: FAIRNESS_COMPETITION.FRIENDLY }),
        side: FAIRNESS_SIDE.HOME,
      },
    ]);
    expect(measurement.evidence.fixturesCounted).toBe(1);
    expect(measurement.evidence.fixturesExcluded).toBe(1);
    expect(measurement.evidence.exclusions.reduce((sum, [, count]) => sum + count, 0)).toBe(
      measurement.evidence.fixturesExcluded
    );
  });

  it('refuses a repeated id wherever the evidence lands it, not only in the counted list', () => {
    // Findings one and two of the fourth review round are one invariant leaking
    // on two paths, so they are asserted as one sweep. `uniqueIds()` guarded
    // the counted list and nothing guarded the rest: the `counted.length === 0`
    // early return built its evidence directly, and every exclusion bucket ran
    // its ids through `[...new Set(ids)]`. Two rows under one id therefore
    // *threw* in a counted position and were *silently deduped* everywhere
    // else, publishing `fixturesExcluded: 1` about two rows the subject holds.
    //
    // Each row below is a different return path through `measureSubject()`,
    // chosen so the repeated id lands somewhere other than the counted list.
    const paths = [
      {
        what: 'the outside-class early return',
        metricId: FAIRNESS_METRIC.GAMES_PLAYED,
        bucket: 'fixture-of-another-competition',
        counted: 0,
        excluded: 2,
        rows: (secondId) => [
          {
            fixture: fixture({ fixtureId: 'S1', competition: FAIRNESS_COMPETITION.FRIENDLY }),
            side: FAIRNESS_SIDE.HOME,
          },
          {
            fixture: fixture({
              fixtureId: secondId,
              date: '2026-08-29',
              competition: FAIRNESS_COMPETITION.FRIENDLY,
            }),
            side: FAIRNESS_SIDE.HOME,
          },
        ],
      },
      {
        what: 'hosting-share with no two-sided fixture',
        metricId: FAIRNESS_METRIC.HOSTING_SHARE,
        bucket: 'fixture-names-no-opponent',
        counted: 0,
        excluded: 2,
        rows: (secondId) => [
          { fixture: fixture({ fixtureId: 'S1', awaySubjectId: null }), side: FAIRNESS_SIDE.HOME },
          {
            fixture: fixture({ fixtureId: secondId, date: '2026-08-29', awaySubjectId: null }),
            side: FAIRNESS_SIDE.HOME,
          },
        ],
      },
      {
        what: 'hosting-share that reached a value',
        metricId: FAIRNESS_METRIC.HOSTING_SHARE,
        bucket: 'fixture-names-no-opponent',
        counted: 1,
        excluded: 2,
        rows: (secondId) => [
          { fixture: fixture({ fixtureId: 'g1' }), side: FAIRNESS_SIDE.HOME },
          { fixture: fixture({ fixtureId: 'S1', awaySubjectId: null }), side: FAIRNESS_SIDE.HOME },
          {
            fixture: fixture({ fixtureId: secondId, date: '2026-08-29', awaySubjectId: null }),
            side: FAIRNESS_SIDE.HOME,
          },
        ],
      },
      {
        what: 'mean-kickoff with no timed fixture',
        metricId: FAIRNESS_METRIC.MEAN_KICKOFF,
        bucket: 'fixture-has-no-kickoff',
        counted: 0,
        excluded: 2,
        rows: (secondId) => [
          { fixture: fixture({ fixtureId: 'S1', kickoffMinutes: null }), side: FAIRNESS_SIDE.HOME },
          {
            fixture: fixture({ fixtureId: secondId, date: '2026-08-29', kickoffMinutes: null }),
            side: FAIRNESS_SIDE.HOME,
          },
        ],
      },
      {
        what: 'venue-spread with no located fixture',
        metricId: FAIRNESS_METRIC.VENUE_SPREAD,
        bucket: 'fixture-has-no-venue',
        counted: 0,
        excluded: 2,
        rows: (secondId) => [
          { fixture: fixture({ fixtureId: 'S1', venueId: null }), side: FAIRNESS_SIDE.HOME },
          {
            fixture: fixture({ fixtureId: secondId, date: '2026-08-29', venueId: null }),
            side: FAIRNESS_SIDE.HOME,
          },
        ],
      },
    ];

    let swept = 0;
    /** @type {Set<string>} */ const outcomes = new Set();
    for (const path of paths) {
      const metric = FAIRNESS_METRIC_REGISTRY[path.metricId];
      const duplicated = path.rows('S1');
      // Meta-assertion on the case itself, per path: two rows under one id, so
      // a construction that had lost its duplicate would prove nothing.
      expect(new Set(duplicated.map((held) => held.fixture.fixtureId)).size).toBe(
        duplicated.length - 1
      );
      expect(() => measureSubject(metric, FAIRNESS_SUBJECT_KIND.TEAM, 'A', duplicated)).toThrow(
        /"S1"/
      );

      // The control, so the refusal is about the repeated id and not about the
      // path: one character changes and the same rows measure, with every row
      // the subject holds accounted for exactly once.
      const repaired = path.rows('S2');
      const measurement = measureSubject(metric, FAIRNESS_SUBJECT_KIND.TEAM, 'A', repaired);
      expect(measurement.evidence.fixturesCounted).toBe(path.counted);
      expect(measurement.evidence.fixturesExcluded).toBe(path.excluded);
      expect(measurement.evidence.fixturesCounted + measurement.evidence.fixturesExcluded).toBe(
        repaired.length
      );
      expect(measurement.evidence.exclusions).toContainEqual([path.bucket, path.excluded]);
      expect(measurement.evidence.exclusions.reduce((sum, [, count]) => sum + count, 0)).toBe(
        measurement.evidence.fixturesExcluded
      );
      expect(measurement.evidence.countedFixtureIds).toHaveLength(path.counted);
      expect(measurement.evidence.excludedFixtureIds).toHaveLength(path.excluded);

      // The implementation this refusal replaces, constructed: the silently
      // deduping one published exactly this for the duplicated rows above — one
      // id, one bucket entry, one fewer exclusion than rows held — and the
      // identity every measurement is published under is what rejects it.
      const deduped = {
        fixturesCounted: path.counted,
        fixturesExcluded: path.excluded - 1,
        exclusions: [[path.bucket, path.excluded - 1]],
      };
      expect(deduped.fixturesCounted + deduped.fixturesExcluded).not.toBe(duplicated.length);
      outcomes.add(measurement.measurability);
      swept += 1;
    }

    // Meta-assertions on the sweep's own population. Five paths, four distinct
    // exclusion buckets, and both measurability outcomes — the leak was on the
    // unmeasurable returns, and a sweep that only visited those would not show
    // that a measured one publishes its exclusions the same way.
    expect(swept).toBe(paths.length);
    expect(swept).toBe(5);
    expect(new Set(paths.map((path) => path.bucket)).size).toBe(4);
    expect([...outcomes].sort()).toEqual(
      [FAIRNESS_MEASURABILITY.MEASURED, FAIRNESS_MEASURABILITY.UNMEASURABLE].sort()
    );

    // …and the tie to the corpus, so the four buckets above are not four names
    // this test chose. Every exclusion bucket the season report publishes is
    // one of them, save `measureGroup()`'s own, whose ids are a `distinctIds()`
    // union asserted by rule two of 'evidence a reader can check by hand'. A
    // bucket added to the module without a path here fails this line.
    const corpusBuckets = new Set(
      corpusReport().measurements.flatMap((measurement) =>
        measurement.evidence.exclusions.map(([reason]) => reason)
      )
    );
    expect(corpusBuckets.size).toBeGreaterThan(0);
    const covered = new Set([...paths.map((path) => path.bucket), 'fixture-not-counted-by-metric']);
    expect([...corpusBuckets].filter((name) => !covered.has(name))).toEqual([]);

    // The structural half of the same finding, because the accounting fix
    // above would hold even if the two return paths still built their evidence
    // separately: `measureSubject()` names **no exclusion bucket of its own**.
    // Both of its returns hand their set-aside ids to `withSetAside()`, which
    // is the function that owns that bucket; the early return used to name it
    // inline, which is exactly how it came to bypass the disjointness check the
    // measured return goes through. Inlining a bucket here again fails this
    // line, in the idiom the Minis assertion above already uses.
    expect(measureSubject.toString()).not.toMatch(/['"]fixture-/);
    // The control: the literal this looks for is really how the module writes a
    // bucket, so the assertion is not passing on a spelling nobody uses. Either
    // quote: `toString()` returns the transformed source, and Vitest 5's Oxc
    // transform writes double quotes where the file has single (Vitest 4's
    // esbuild kept them), so a single-quote-only pattern matched nothing.
    expect(FAIRNESS_METRIC_REGISTRY[FAIRNESS_METRIC.HOSTING_SHARE].measure.toString()).toMatch(
      /['"]fixture-names-no-opponent['"]/
    );
  });
});

/* -------------------------------------------------------------------------- */
/* 13. An objective that scored nothing has no score                           */
/* -------------------------------------------------------------------------- */

describe('fairness :: an objective that scored nothing has no score', () => {
  const HOSTING = { objectiveId: FAIRNESS_OBJECTIVE.HOSTING_BALANCE };

  /** Nine two-sided league rounds among eight teams: every subject scoreable. */
  const scoreable = () => roundRobin({ teamCount: 8, rounds: 7 });

  it('returns null rather than zero for a list it found nobody in', () => {
    // Two rows naming no participant on either side. The classifier *accepts*
    // them — 101 of season-2026's rows are exactly this, and they are reported
    // rather than refused — so the list is usable and there is simply nobody in
    // it. `participation` is empty, `terms` is empty, the coverage guard reads
    // `unscoredCount > 0` and never fires, and the objective returned
    // `score: 0` with `status: 'allowed'`: the best possible value of a
    // minimisation, over a season it measured nothing of, with nothing said.
    const nobody = [
      fixture({ fixtureId: 'p1', homeSubjectId: null, awaySubjectId: null }),
      fixture({ fixtureId: 'p2', homeSubjectId: null, awaySubjectId: null }),
    ];
    const result = scoreFairnessObjective(nobody, HOSTING);
    expect(result.terms).toEqual([]);
    expect(result.termsScored).toBe(0);
    // The module's own rule for one unmeasurable term, applied to the whole
    // score: null, never 0, because zero is the best score.
    expect(result.score).toBeNull();
    expect(result.status).toBe(FAIRNESS_STATUS.REJECTED);
    const unscored = result.findings.filter(
      (finding) => finding.code === FAIRNESS_REASON.FAIRNESS_OBJECTIVE_UNSCORED
    );
    expect(unscored).toHaveLength(1);
    expect(unscored[0].severity).toBe(FAIRNESS_SEVERITY.BLOCKING);
    expect(unscored[0].details.termsScored).toBe(0);
    expect(unscored[0].details.sense).toBe(FAIRNESS_OBJECTIVE_SENSE.MINIMISE);

    // The control, so the null is about this list and not about every list: an
    // implementation that returned null for everything would fail here, and a
    // real schedule still comes back with a number and an `allowed` status.
    const real = scoreFairnessObjective(scoreable(), HOSTING);
    expect(typeof real.score).toBe('number');
    expect(real.termsScored).toBe(8);
    expect(real.status).toBe(FAIRNESS_STATUS.ALLOWED);
  });

  it('returns null when every subject was counted and none could be scored', () => {
    // The case that separates the fix from the shortcut. `terms` is **not**
    // empty here — six subjects are considered, each holding nine league
    // fixtures — and not one of them is scoreable, because none of those
    // fixtures names an opponent and a hosting share over no two-sided fixture
    // is not a quantity. A guard written as `terms.length === 0` passes this
    // and publishes `score: 0` over a schedule in which nothing was measured;
    // the rule is about what was *scored*, not about what was considered.
    const solo = Array.from({ length: 6 }, (unused, team) =>
      Array.from({ length: 9 }, (ignored, round) =>
        fixture({
          fixtureId: `s${team}-r${round}`,
          date: `2026-09-${String(round + 1).padStart(2, '0')}`,
          homeSubjectId: `T${team}`,
          awaySubjectId: null,
        })
      )
    ).flat();
    const result = scoreFairnessObjective(solo, HOSTING);
    expect(result.terms).toHaveLength(6);
    expect(result.termsScored).toBe(0);
    expect(result.termsUnscored).toBe(6);
    expect(result.terms.every((term) => term.penalty === null)).toBe(true);
    expect(new Set(result.terms.map((term) => term.reasonCode))).toEqual(
      new Set([FAIRNESS_REASON.FAIRNESS_DENOMINATOR_EMPTY])
    );
    expect(result.score).toBeNull();
    expect(result.coverage).toBe(0);
    expect(
      result.findings.some(
        (finding) => finding.code === FAIRNESS_REASON.FAIRNESS_OBJECTIVE_UNSCORED
      )
    ).toBe(true);
    // The partial-coverage finding still fires beside it: six of six is a
    // shortfall as well as a total absence, and the two say different things.
    expect(
      result.findings.some(
        (finding) => finding.code === FAIRNESS_REASON.FAIRNESS_OBJECTIVE_COVERAGE_PARTIAL
      )
    ).toBe(true);
  });

  it('refuses to rank a result that measured nothing, including against another', () => {
    // Two results that measured nothing used to compare as
    // `{ comparable: true, better: null, delta: 0 }` — a tie between two
    // seasons neither of which was read — because `compareObjectiveScores()`
    // agrees on every field it checks when both sides are empty, and it reads
    // neither `status` nor `findings`.
    const left = scoreFairnessObjective(
      [fixture({ fixtureId: 'p1', homeSubjectId: null, awaySubjectId: null })],
      HOSTING
    );
    const right = scoreFairnessObjective(
      [fixture({ fixtureId: 'p2', homeSubjectId: null, awaySubjectId: null })],
      HOSTING
    );
    expect(left.termsScored).toBe(0);
    expect(right.termsScored).toBe(0);
    // Everything the mismatch guard looks at agrees, which is why the refusal
    // has to be about the operands rather than about a difference between them.
    for (const field of ['objectiveId', 'weight', 'basisKind', 'termsScored', 'coverage']) {
      expect(left[field]).toBe(right[field]);
    }
    const both = compareObjectiveScores(left, right);
    expect(both.comparable).toBe(false);
    expect(both.better).toBeNull();
    expect(both.delta).toBeNull();
    expect(both.findings[0].code).toBe(FAIRNESS_REASON.FAIRNESS_OBJECTIVE_INCOMPARABLE);
    expect(both.findings[0].severity).toBe(FAIRNESS_SEVERITY.BLOCKING);
    // The refusal names which side has no score, so it is not mistaken for the
    // mismatch refusal beside it.
    expect(both.findings[0].details.unscored).toEqual(['left', 'right']);
    expect(both.findings[0].details.mismatches).toBeUndefined();

    // One side only, either way round.
    const real = scoreFairnessObjective(scoreable(), HOSTING);
    for (const side of ['left', 'right']) {
      const comparison =
        side === 'left' ? compareObjectiveScores(left, real) : compareObjectiveScores(real, left);
      expect(comparison.comparable).toBe(false);
      expect(comparison.better).toBeNull();
      expect(comparison.delta).toBeNull();
      expect(comparison.findings[0].details.unscored).toEqual([side]);
    }

    // And the control that keeps the guard from being "refuse everything": two
    // results that both measured something are still ranked, in the declared
    // sense.
    const lopsided = scoreable().map((held) => ({
      ...held,
      homeSubjectId:
        held.homeSubjectId < held.awaySubjectId ? held.homeSubjectId : held.awaySubjectId,
      awaySubjectId:
        held.homeSubjectId < held.awaySubjectId ? held.awaySubjectId : held.homeSubjectId,
    }));
    const ranked = compareObjectiveScores(real, scoreFairnessObjective(lopsided, HOSTING));
    expect(ranked.comparable).toBe(true);
    expect(ranked.better).toBe('left');
    expect(ranked.delta).toBeLessThan(0);
  });

  it('refuses to rank a result carrying no number, whatever it says it scored', () => {
    // The guard above reads `termsScored`; the arithmetic below it reads
    // `score`, and it read it through a cast that erased the null. So a result
    // with `termsScored: 8` and no score passed both guards and was ranked:
    // `null < 0.5714` is true, which made the side that holds no number the
    // better schedule. `compareObjectiveScores()` is a comparator over two
    // operands **its caller supplies** — a solver ranks a stored candidate
    // against a fresh one — so this is its contract and not the pipeline's
    // internal state: `scoreFairnessObjective()` never emits this pair, and it
    // does not have to for the guard to owe the arithmetic a number. A result
    // that has been through JSON on the way is the same object with `score` no
    // longer a number, because `JSON.stringify` writes a non-finite number as
    // `null` and drops an `undefined` key entirely, and a producer that simply
    // does not set the field arrives the same way. `termsScored` survives all
    // three, which is why keying on it decided nothing about the subtraction.
    const real = scoreFairnessObjective(scoreable(), HOSTING);
    expect(real.termsScored).toBe(8);
    expect(typeof real.score).toBe('number');

    const nulled = JSON.parse(JSON.stringify({ ...real, score: NaN }));
    expect(nulled.score).toBeNull();
    expect(nulled.termsScored).toBe(8);
    const absent = JSON.parse(JSON.stringify({ ...real, score: undefined }));
    expect(Object.hasOwn(absent, 'score')).toBe(false);
    expect(absent.termsScored).toBe(8);

    // The implementation this replaces, written out: keyed on `termsScored`, it
    // lets both operands through, and here is the ranking it then produced — a
    // `better` decided by a null and a delta computed from one.
    const byTermsScored = (left, right) => left.termsScored === 0 || right.termsScored === 0;
    expect(byTermsScored(nulled, real)).toBe(false);
    expect(nulled.score < real.score).toBe(true);
    expect(real.score - nulled.score).toBe(real.score);
    expect(Number.isNaN(real.score - absent.score)).toBe(true);

    // Refused now, on either side, for either arrival.
    for (const operand of [nulled, absent]) {
      for (const side of ['left', 'right']) {
        const comparison =
          side === 'left'
            ? compareObjectiveScores(operand, real)
            : compareObjectiveScores(real, operand);
        expect(comparison.comparable).toBe(false);
        expect(comparison.better).toBeNull();
        expect(comparison.delta).toBeNull();
        expect(comparison.findings[0].code).toBe(FAIRNESS_REASON.FAIRNESS_OBJECTIVE_INCOMPARABLE);
        expect(comparison.findings[0].severity).toBe(FAIRNESS_SEVERITY.BLOCKING);
        expect(comparison.findings[0].details.unscored).toEqual([side]);
        expect(comparison.findings[0].details.mismatches).toBeUndefined();
      }
    }

    // The rule the broadened guard must not lose on its way to keying on the
    // number: a result claiming a score while claiming to have scored nothing
    // is a contradiction, and it is still refused — on the claim, not on the
    // number, because there is no population behind the number.
    const inconsistent = { ...real, termsScored: 0 };
    expect(typeof inconsistent.score).toBe('number');
    expect(compareObjectiveScores(inconsistent, real).comparable).toBe(false);
    expect(compareObjectiveScores(inconsistent, real).findings[0].details.unscored).toEqual([
      'left',
    ]);

    // And the control that keeps this from being "refuse everything": two
    // results that both carry a number are still ranked, and a result survives
    // the round trip that did not empty its score.
    const intact = JSON.parse(JSON.stringify(real));
    expect(intact.score).toBe(real.score);
    const ranked = compareObjectiveScores(intact, real);
    expect(ranked.comparable).toBe(true);
    expect(ranked.better).toBeNull();
    expect(ranked.delta).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* 14. The objective classifies, and groups, the way the report does           */
/* -------------------------------------------------------------------------- */

describe('fairness :: the objective answers about the same list as the report', () => {
  it('refuses a list carrying a competition nobody declared, rather than scoring the rest', () => {
    // The objective declares its `fixtures` argument the authority and derives
    // participation from it, and used not to classify it: one `tournament` row
    // came back `coverage: 1`, `status: 'allowed'`, no finding, and that row's
    // opponent silently absent from the population — while `fairnessReport()`
    // refused the identical list as blocking.
    const league = roundRobin({ teamCount: 8, rounds: 7 });
    const withTournament = [
      ...league,
      fixture({
        fixtureId: 'cup-1',
        date: '2026-11-14',
        competition: 'tournament',
        homeSubjectId: 'T1',
        awaySubjectId: 'T9',
      }),
    ];
    const objective = scoreFairnessObjective(withTournament, {
      objectiveId: FAIRNESS_OBJECTIVE.HOSTING_BALANCE,
    });
    expect(objective.status).toBe(FAIRNESS_STATUS.REJECTED);
    const refusal = objective.findings.filter(
      (finding) => finding.code === FAIRNESS_REASON.FAIRNESS_FIXTURE_UNCLASSIFIED
    );
    expect(refusal).toHaveLength(1);
    expect(refusal[0].details.competition).toBe('tournament');
    expect(objective.terms).toEqual([]);
    expect(objective.score).toBeNull();

    // The report, asked about the identical list, says the same thing.
    const report = fairnessReport({ fixtures: withTournament });
    expect(report.status).toBe(FAIRNESS_STATUS.REJECTED);
    expect(findingsOf(report, FAIRNESS_REASON.FAIRNESS_FIXTURE_UNCLASSIFIED)).toHaveLength(1);

    // The wrong-passing implementation, constructed: one that classified the
    // list, raised the finding, and then scored the survivors anyway would
    // return exactly the league-only answer below — eight teams scored,
    // coverage 1, `T9` absent and unmentioned. It is a different answer, and it
    // is the answer the refusal above is distinguished from.
    const survivors = scoreFairnessObjective(league, {
      objectiveId: FAIRNESS_OBJECTIVE.HOSTING_BALANCE,
    });
    expect(survivors.termsScored).toBe(8);
    expect(survivors.coverage).toBe(1);
    expect(survivors.terms.some((term) => term.subjectId === 'T9')).toBe(false);
    expect(objective.termsScored).not.toBe(survivors.termsScored);
    expect(objective.coverage).not.toBe(survivors.coverage);
  });

  it('does not let a friendly’s spelling decide an objective’s cohort', () => {
    // The report's case, asked of the objective, because for one commit it was
    // true of the report and false of the objective while the objective's
    // docstring claimed otherwise. Six teams over nine league rounds spelled
    // `U10B`, and two extra league rows between `T1` and `T2` so that the
    // cohort median is load-bearing: eleven games each against nine for the
    // other four, a median of 9, and a total penalty of 4.
    const league = [
      ...roundRobin({ teamCount: 6, rounds: 9 }),
      fixture({
        fixtureId: 'extra-1',
        date: '2026-11-01',
        homeSubjectId: 'T1',
        awaySubjectId: 'T2',
      }),
      fixture({
        fixtureId: 'extra-2',
        date: '2026-11-02',
        homeSubjectId: 'T2',
        awaySubjectId: 'T1',
      }),
    ];
    const friendly = fixture({
      fixtureId: 'friendly-1',
      date: '2026-11-07',
      competition: FAIRNESS_COMPETITION.FRIENDLY,
      division: '10B',
      ageGroup: 'U10',
      homeSubjectId: 'T1',
      awaySubjectId: 'T2',
    });
    const config = { objectiveId: FAIRNESS_OBJECTIVE.GAME_COUNT_PARITY };

    const leagueOnly = scoreFairnessObjective(league, config);
    // Meta-assertion on the construction: a cohort in which everybody already
    // matches the median would score 0 either way and prove nothing about
    // grouping.
    expect(leagueOnly.score).toBe(4);
    expect(leagueOnly.termsScored).toBe(6);

    const withFriendly = scoreFairnessObjective([...league, friendly], config);
    const t1 = withFriendly.terms.find((term) => term.subjectId === 'T1');
    expect(t1.groupKey).toBe('U10B');
    expect(t1.scored).toBe(true);
    expect(t1.reasonCode).toBeNull();
    expect(t1.value).toBe(11);
    expect(t1.target).toBe(9);
    expect(withFriendly.terms.every((term) => term.groupKey === 'U10B')).toBe(true);
    // A scrimmage moves neither the cohort nor the number, so the two results
    // are the same result and rank against each other.
    expect(withFriendly.score).toBe(leagueOnly.score);
    expect(withFriendly.termsScored).toBe(leagueOnly.termsScored);
    expect(withFriendly.coverage).toBe(leagueOnly.coverage);
    expect(compareObjectiveScores(withFriendly, leagueOnly).comparable).toBe(true);

    // The positive control, so the case is known to bite: the identical row
    // read as league gives `T1` and `T2` two league labels, and two keys of the
    // class the metric reads is what makes a subject ambiguous. Both drop out
    // of the cohort, which takes the eleven-game pair out of the median's
    // population and leaves a score of 0 — the fold-into-nothing this objective
    // used to publish for a scrimmage's spelling.
    const polluted = scoreFairnessObjective(
      [...league, { ...friendly, competition: FAIRNESS_COMPETITION.LEAGUE }],
      config
    );
    for (const subjectId of ['T1', 'T2']) {
      const term = polluted.terms.find((candidate) => candidate.subjectId === subjectId);
      expect(term.groupKey).toBeNull();
      expect(term.scored).toBe(false);
      expect(term.reasonCode).toBe(FAIRNESS_REASON.FAIRNESS_GROUP_AMBIGUOUS);
    }
    expect(polluted.termsScored).toBe(4);
    expect(polluted.score).toBe(0);
    // …and through the coverage guard the two are then permanently
    // incomparable, which is the second cost of grouping on every label.
    expect(compareObjectiveScores(withFriendly, polluted).comparable).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* 15. A guard sits where its comparison is                                    */
/* -------------------------------------------------------------------------- */

describe('fairness :: a guard sits where its comparison is', () => {
  // Round 5 moved the threshold check below the early returns and justified the
  // move by `undecided()`: a subject with no cohort gets `threshold: null`, and
  // re-deriving such a row, the reasoning went, must answer rather than throw.
  // The reasoning was wrong, and the two tests below are the claim the move
  // *does* support and the limit it does not cross, each proved against state
  // this module actually emits rather than state a test typed out.
  //
  // `describeDispersion()` stamps `threshold: OUTLIER_SCORE_THRESHOLD` on every
  // result it builds, and `undecided()` copies the state and the threshold off
  // the same dispersion or writes `null` for both. A row pairing a real
  // dispersion state with an absent threshold is therefore not a row this
  // module emits — the only arrival that produces one is a record that lost the
  // key in transit.

  /** @param {number} value @param {number} index */
  const memberOf = (value, index) => ({ subjectId: `s${index}`, value });

  it('refuses a re-derived undecided() row at the dispersion, not at the threshold', () => {
    const report = corpusReport();
    // The rows `undecided()` builds for a subject with no key on this basis —
    // the four Minis sides and their kin, judged against no cohort at all.
    const keyless = report.judgements.filter((judgement) => judgement.dispersionState === null);
    const thresholdless = report.judgements.filter((judgement) => judgement.threshold === null);
    // Meta-assertion: the corpus really contains rows of this shape, so the
    // equality below is not a statement about two empty lists.
    expect(keyless.length).toBeGreaterThan(0);
    // The finding, and it is stated without a figure because the corpus decides
    // the size, not this test: **the two sets are one set.** `undecided()` reads
    // its state and its threshold off the same absent dispersion, so no row ever
    // loses one without the other — which means the pairing round 5's test
    // forged, a real dispersion state beside an absent threshold, is emitted by
    // no judgement of this corpus. A row that broke the pairing would appear in
    // one list and not the other and fail here.
    expect(thresholdless).toEqual(keyless);
    // The same of the populations those judgements were scored against, with
    // the corpus's own declared count as the meta-assertion: every one carries
    // the threshold `describeDispersion()` stamps on it, whatever its state.
    expect(report.populations).toHaveLength(124);
    expect(
      report.populations.every(
        (population) => population.dispersion.threshold === OUTLIER_SCORE_THRESHOLD
      )
    ).toBe(true);

    // So re-deriving one of these rows still throws, and it throws one guard
    // *above* the threshold. The move did not reach this path.
    const row = keyless[0];
    /** @returns {string} */
    const refusalFor = () => {
      try {
        deriveFairnessJudgement(
          /** @type {any} */ ({
            measurability: FAIRNESS_MEASURABILITY.MEASURED,
            dispersion: row.dispersionState,
            score: row.score,
            threshold: row.threshold,
          })
        );
      } catch (error) {
        return /** @type {Error} */ (error).message;
      }
      throw new Error('expected a refusal');
    };
    expect(refusalFor()).toMatch(/dispersion null is not a member of FAIRNESS_DISPERSION/);
    // …and the message does not mention the threshold at all, which is the whole
    // distinction. Asserting only that it throws would have passed for the wrong
    // reason under either placement of the guard.
    expect(refusalFor()).not.toMatch(/threshold/);
    // The control, so the refusal above is about the dispersion and not about
    // the call: the same row under a state the enum knows answers, null
    // threshold and all. That is what the guard's placement buys, and it is
    // reached by a record whose state survived and whose threshold did not —
    // never by an `undecided()` row, which loses both together.
    expect(
      deriveFairnessJudgement(
        /** @type {any} */ ({
          measurability: FAIRNESS_MEASURABILITY.MEASURED,
          dispersion: FAIRNESS_DISPERSION.INSUFFICIENT,
          score: row.score,
          threshold: row.threshold,
        })
      )
    ).toBe(FAIRNESS_JUDGEMENT.UNDECIDED);
  });

  it('answers a threshold lost in transit on the four paths no comparison reads', () => {
    // Built by `describeDispersion()`, so the four states below are the
    // module's own and not four strings this test chose.
    const populations = {
      uniform: describeDispersion('m', [605, 605, 605, 605].map(memberOf)),
      insufficient: describeDispersion('m', [605, 610, 620].map(memberOf)),
      degenerate: describeDispersion('m', [1, 1, 1, 1, 9].map(memberOf)),
      usable: describeDispersion('m', [1, 2, 3, 10].map(memberOf)),
    };
    expect(
      Object.fromEntries(
        Object.entries(populations).map(([name, population]) => [name, population.state])
      )
    ).toEqual({
      uniform: FAIRNESS_DISPERSION.UNIFORM,
      insufficient: FAIRNESS_DISPERSION.INSUFFICIENT,
      degenerate: FAIRNESS_DISPERSION.DEGENERATE,
      usable: FAIRNESS_DISPERSION.USABLE,
    });
    // The premise round 5's test had backwards, stated the right way round:
    // every one of the four carries the threshold, including the three that
    // will never be compared against it.
    expect(Object.values(populations).map((population) => population.threshold)).toEqual([
      OUTLIER_SCORE_THRESHOLD,
      OUTLIER_SCORE_THRESHOLD,
      OUTLIER_SCORE_THRESHOLD,
      OUTLIER_SCORE_THRESHOLD,
    ]);

    const rows = [
      {
        why: 'unmeasurable',
        measurability: FAIRNESS_MEASURABILITY.UNMEASURABLE,
        dispersion: populations.usable.state,
        score: null,
      },
      {
        why: 'uniform',
        measurability: FAIRNESS_MEASURABILITY.MEASURED,
        dispersion: populations.uniform.state,
        score: null,
      },
      {
        why: 'insufficient',
        measurability: FAIRNESS_MEASURABILITY.MEASURED,
        dispersion: populations.insufficient.state,
        score: null,
      },
      {
        why: 'degenerate',
        measurability: FAIRNESS_MEASURABILITY.MEASURED,
        dispersion: populations.degenerate.state,
        score: null,
      },
      {
        why: 'no score',
        measurability: FAIRNESS_MEASURABILITY.MEASURED,
        dispersion: populations.usable.state,
        score: null,
      },
    ];

    // The wrong-passing implementation, constructed: the pre-round-5 order,
    // whose only difference was that it read the threshold before the returns.
    // Delegating with a real threshold afterwards is faithful, because none of
    // the four paths below reads one.
    /** @param {any} input */
    const guardedAbove = (input) => {
      if (!Number.isFinite(input.threshold)) {
        throw new Error(`fairness: threshold ${input.threshold} is not a finite number`);
      }
      return deriveFairnessJudgement({ ...input, threshold: OUTLIER_SCORE_THRESHOLD });
    };

    /** @type {string[]} */
    const answers = [];
    for (const { why, ...row } of rows) {
      // Constructed by round-tripping, not by hand: the trip is what drops the
      // key, and the post-trip object is what the guard sees. Asserted, so a
      // serialiser that preserved `undefined` would fail here rather than
      // quietly turning the rest of this test into a claim about a shape.
      const trip = JSON.parse(JSON.stringify({ ...row, threshold: undefined }));
      expect(Object.hasOwn(trip, 'threshold'), why).toBe(false);
      expect(() => deriveFairnessJudgement(trip), why).not.toThrow();
      // …and the pre-round-5 order refuses every one of them: a comparison that
      // never happens is not a comparison against nothing.
      expect(() => guardedAbove(trip), why).toThrow(/threshold/);
      answers.push(deriveFairnessJudgement(trip));
    }
    // Meta-assertion: the sweep exercised both returns it claims to cover, on
    // all five rows, or "nothing threw" would be a statement about an empty set.
    expect(answers).toHaveLength(5);
    expect(new Set(answers)).toEqual(
      new Set([FAIRNESS_JUDGEMENT.UNDECIDED, FAIRNESS_JUDGEMENT.TYPICAL])
    );
  });

  it('still refuses a missing threshold at the one place a comparison happens', () => {
    const comparing = {
      measurability: FAIRNESS_MEASURABILITY.MEASURED,
      dispersion: FAIRNESS_DISPERSION.USABLE,
      score: 47.2,
    };
    expect(() => deriveFairnessJudgement({ ...comparing, threshold: null })).toThrow(
      /threshold null is not a finite number/
    );
    // The value it was given is printed verbatim, not rendered away.
    expect(() => deriveFairnessJudgement({ ...comparing, threshold: NaN })).toThrow(
      /threshold NaN is not a finite number/
    );
    // And the guard is not a blanket refusal: the same row with a real
    // threshold answers, so "throws" above is about the threshold alone.
    expect(deriveFairnessJudgement({ ...comparing, threshold: 3.5 })).toBe(
      FAIRNESS_JUDGEMENT.OUTLIER
    );
  });

  it('requires the threshold from the compiler too, on the path that compares', () => {
    // The regression this replaces: round 6 typed the field
    // `threshold?: number|null` so the four early-return paths above would read
    // as legal without it. That is true of the runtime and false of the one path
    // that matters — and the optional type removed tsc's check from exactly
    // there, so a call site that dropped the field passed CI and threw for every
    // measured member of a usable population.
    //
    // The falsification is the directive on the next line rather than an
    // assertion: `@ts-expect-error` is itself an error when the line below it
    // typechecks, so re-optionalising `threshold` fails `npm run typecheck` with
    // "Unused '@ts-expect-error' directive". The runtime half is asserted here,
    // and it is what the compiler is being asked to catch first.
    expect(() =>
      deriveFairnessJudgement(
        // @ts-expect-error [INVALID_INPUT] - `threshold` is required on the comparing path;
        // this directive is the falsification test for that requirement.
        {
          measurability: FAIRNESS_MEASURABILITY.MEASURED,
          dispersion: FAIRNESS_DISPERSION.USABLE,
          score: 1,
        }
      )
    ).toThrow(/threshold undefined is not a finite number/);
    // The control, so the line above is about the missing field and not about
    // the shape: the same call with the field typechecks and answers.
    expect(
      deriveFairnessJudgement({
        measurability: FAIRNESS_MEASURABILITY.MEASURED,
        dispersion: FAIRNESS_DISPERSION.USABLE,
        score: 1,
        threshold: OUTLIER_SCORE_THRESHOLD,
      })
    ).toBe(FAIRNESS_JUDGEMENT.TYPICAL);
  });
});

/* -------------------------------------------------------------------------- */
/* 16. A refused value is printed with its type intact                         */
/* -------------------------------------------------------------------------- */

describe('fairness :: a refused value is printed with its type intact', () => {
  // Round 5 wrapped four refusal messages in `String()` so that `NaN` and
  // `Infinity` stopped printing as `null`. It fixed that and broke the other
  // half. `String('3.5')` is `3.5`, so the refusal of a string reads exactly
  // like the number that would have been accepted; `String('')` and `String([])`
  // are both empty, so the message names no value at all; `String({})` is
  // `[object Object]`. A refusal that cannot be told from an acceptance, or that
  // prints nothing, costs a reader the debugging session it exists to save.

  const comparing = {
    measurability: FAIRNESS_MEASURABILITY.MEASURED,
    dispersion: FAIRNESS_DISPERSION.USABLE,
    score: 47.2,
  };
  /** @param {number} value @param {number} index */
  const memberOf = (value, index) => ({ subjectId: `s${index}`, value });
  const usable = () => describeDispersion('m', [1, 2, 3, 10].map(memberOf));

  it('tells a string, an empty string, an array and an object from a number', () => {
    // The first wrong-passing implementation, constructed: `String(value)`, at
    // all four sites. Under it these four refusals are unreadable…
    expect(String('3.5')).toBe(String(3.5));
    expect(String('')).toBe('');
    expect(String([])).toBe('');
    expect(String({})).toBe('[object Object]');

    // …and here they are, each naming what it was actually handed.
    expect(() =>
      deriveFairnessJudgement(/** @type {any} */ ({ ...comparing, threshold: '3.5' }))
    ).toThrow(/threshold "3\.5" is not a finite number/);
    expect(() =>
      deriveFairnessJudgement(/** @type {any} */ ({ ...comparing, threshold: '' }))
    ).toThrow(/threshold "" is not a finite number/);
    expect(() =>
      deriveFairnessJudgement(/** @type {any} */ ({ ...comparing, threshold: [] }))
    ).toThrow(/threshold \[\] is not a finite number/);
    expect(() =>
      deriveFairnessJudgement(/** @type {any} */ ({ ...comparing, threshold: {} }))
    ).toThrow(/threshold \{\} is not a finite number/);
  });

  it('still prints NaN and Infinity as themselves, and null as null', () => {
    // The second wrong-passing implementation, constructed: plain
    // `JSON.stringify`, which is the fix for the first defect and a
    // reintroduction of the one round 5 removed — it renders both non-finite
    // numbers as the word `null`, which is a different refusal this same guard
    // also raises.
    expect(JSON.stringify(NaN)).toBe('null');
    expect(JSON.stringify(Infinity)).toBe('null');

    /** @param {any} threshold */
    const messageFor = (threshold) => {
      try {
        deriveFairnessJudgement(/** @type {any} */ ({ ...comparing, threshold }));
      } catch (error) {
        return /** @type {Error} */ (error).message;
      }
      throw new Error('expected a refusal');
    };
    expect(messageFor(NaN)).toMatch(/threshold NaN is not a finite number/);
    expect(messageFor(Infinity)).toMatch(/threshold Infinity is not a finite number/);
    expect(messageFor(-Infinity)).toMatch(/threshold -Infinity is not a finite number/);
    expect(messageFor(null)).toMatch(/threshold null is not a finite number/);
    // Four values, four distinct messages: the renderer collapses none of them
    // onto another. Under `JSON.stringify` alone the first three would be one
    // message; under `String()` alone `null` and `NaN` are already distinct, so
    // this line alone does not carry the finding — the test above does.
    expect(
      new Set([messageFor(NaN), messageFor(Infinity), messageFor(-Infinity), messageFor(null)]).size
    ).toBe(4);
    // An absent key still says so rather than printing nothing, which is the
    // arrival section 15 answers on the other four paths.
    expect(JSON.stringify(undefined)).toBeUndefined();
    expect(messageFor(undefined)).toMatch(/threshold undefined is not a finite number/);
  });

  it('does not let the renderer throw, or print a BigInt as a number', () => {
    // `JSON.stringify` refuses a BigInt outright. A renderer that throws inside
    // a `throw` replaces the diagnostic with a TypeError from a line the reader
    // never asked about — the third wrong-passing implementation, and the
    // reason the renderer is one function rather than four expressions.
    expect(() => JSON.stringify(BigInt(10))).toThrow(TypeError);

    // Round 6 caught the throw and fell back to `String(value)`, which is the
    // fourth wrong-passing implementation: it renders `10n` as `10`, so the
    // refusal reads `threshold 10 is not a finite number` — a sentence the
    // number inside it disproves, and one indistinguishable from the refusal of
    // an actual number. This assertion previously pinned that output. The `n`
    // is the finding.
    expect(String(BigInt(10))).toBe(String(10));
    expect(() =>
      deriveFairnessJudgement(/** @type {any} */ ({ ...comparing, threshold: BigInt(10) }))
    ).toThrow(/threshold 10n is not a finite number/);
    expect(() =>
      deriveFairnessJudgement(/** @type {any} */ ({ ...comparing, threshold: BigInt(10) }))
    ).not.toThrow(/threshold 10 is not a finite number/);
  });

  it('tells NaN, Infinity and null apart in the measurement guard too', () => {
    // The same defect, two guards away, left untouched for two rounds:
    // `assertFairnessMeasurement` printed its refused value through bare
    // `JSON.stringify`. The wrong-passing implementation is that call, and here
    // it is collapsing three different refusals onto one word.
    expect(JSON.stringify(NaN)).toBe(JSON.stringify(null));
    expect(JSON.stringify(Infinity)).toBe(JSON.stringify(null));

    /** @param {string} measurability @param {unknown} value @param {unknown} reasonCode */
    const refusalFor = (measurability, value, reasonCode) => {
      try {
        assertFairnessMeasurement(
          /** @type {any} */ ({
            metricId: FAIRNESS_METRIC.HOSTING_SHARE,
            unit: 'share of 1',
            subjectKind: FAIRNESS_SUBJECT_KIND.TEAM,
            subjectId: 'MinisA',
            measurability,
            value,
            reasonCode,
            evidence: {
              fixturesCounted: 0,
              fixturesExcluded: 0,
              exclusions: [],
              countedFixtureIds: [],
              excludedFixtureIds: [],
            },
          })
        );
      } catch (error) {
        return /** @type {Error} */ (error).message;
      }
      throw new Error('expected a refusal');
    };

    // The `measured` half: three values, three messages, none of them borrowing
    // another's word.
    const measured = [NaN, Infinity, -Infinity, null, '3.5'].map((value) =>
      refusalFor(FAIRNESS_MEASURABILITY.MEASURED, value, null)
    );
    expect(measured[0]).toMatch(/its value is NaN;/);
    expect(measured[1]).toMatch(/its value is Infinity;/);
    expect(measured[2]).toMatch(/its value is -Infinity;/);
    expect(measured[3]).toMatch(/its value is null;/);
    expect(measured[4]).toMatch(/its value is "3\.5";/);
    // Meta-assertion: five refusals, five distinct messages. Under bare
    // `JSON.stringify` the first four were three.
    expect(new Set(measured).size).toBe(5);

    // The `unmeasurable` half, and the worse of the two: this branch *requires*
    // `value === null`, so rendering a refused `NaN` as `null` produced
    // "still carries the value null" — a message describing the passing case
    // while refusing. The finding is that word, so it is asserted both ways.
    const unmeasurable = refusalFor(
      FAIRNESS_MEASURABILITY.UNMEASURABLE,
      NaN,
      FAIRNESS_REASON.FAIRNESS_DENOMINATOR_EMPTY
    );
    expect(unmeasurable).toMatch(/still carries the value NaN;/);
    expect(unmeasurable).not.toMatch(/still carries the value null/);
    // The control, so the refusal above is about the value and not about the
    // call: `null` on this branch is what it asks for, and passes.
    expect(() =>
      refusalFor(
        FAIRNESS_MEASURABILITY.UNMEASURABLE,
        null,
        FAIRNESS_REASON.FAIRNESS_DENOMINATOR_EMPTY
      )
    ).toThrow(/expected a refusal/);
  });

  it('names the value at all four sites, not only the threshold', () => {
    // The score, one guard above the threshold.
    expect(() =>
      deriveFairnessJudgement(
        /** @type {any} */ ({ ...comparing, score: '3.5', threshold: OUTLIER_SCORE_THRESHOLD })
      )
    ).toThrow(/score "3\.5" is not finite/);
    expect(() =>
      deriveFairnessJudgement(
        /** @type {any} */ ({ ...comparing, score: Infinity, threshold: OUTLIER_SCORE_THRESHOLD })
      )
    ).toThrow(/score Infinity is not finite/);

    // …and the two in `modifiedZScore()`, which read a population rather than a
    // judgement input. The dispersion is `describeDispersion()`'s own, with one
    // field replaced, so the refusal is about that field.
    expect(() => modifiedZScore(700, /** @type {any} */ ({ ...usable(), centre: '5' }))).toThrow(
      /its centre is "5"/
    );
    expect(() => modifiedZScore(700, /** @type {any} */ ({ ...usable(), scale: '5' }))).toThrow(
      /its scale is "5"/
    );
    // The non-finite numbers those two sites were wrapped for still print as
    // themselves.
    expect(() => modifiedZScore(700, { ...usable(), centre: null })).toThrow(/its centre is null/);
    expect(() => modifiedZScore(700, { ...usable(), scale: 0 })).toThrow(/its scale is 0/);
    expect(() => modifiedZScore(700, { ...usable(), centre: NaN })).toThrow(/its centre is NaN/);

    // The control: the same population untouched scores, so each refusal above
    // is about the one field it names and not about the call.
    expect(modifiedZScore(700, usable())).toBeCloseTo(0.6745 * (700 - 2.5), 10);
  });
});

/* -------------------------------------------------------------------------- */
/* 17. The refusal renderer is total                                           */
/* -------------------------------------------------------------------------- */

describe('fairness :: the refusal renderer is total', () => {
  // Three rounds of polish produced three new edge cases: `String()` lost
  // strings, `JSON.stringify` lost `NaN` and threw on a BigInt, the
  // `catch { return String(value) }` that answered that could itself throw, and
  // the `String()` inside it rendered `10n` as bare digits. Guessing the fourth
  // edge case is what has not worked. These two properties over a table of
  // hostile values are what replaces the guessing:
  //
  //   1. it returns a string for every input, throwing for none, and
  //   2. only a number renders as a bare number.
  //
  // A rendering "reads as a bare number" when `String(Number(text)) === text`.
  /** @param {string} text */
  const readsAsBareNumber = (text) => String(Number(text)) === text;

  /** @returns {Array<[string, unknown]>} */
  const hostileValues = () => {
    const circular = /** @type {Record<string, unknown>} */ ({});
    circular.self = circular;
    const nullProtoCircular = /** @type {Record<string, unknown>} */ (Object.create(null));
    nullProtoCircular.self = nullProtoCircular;
    return [
      ['a BigInt', BigInt(10)],
      ['a symbol', Symbol('10')],
      ['a boxed Number', new Number(10)],
      ['a boxed String', new String('3.5')],
      ['an object whose toJSON returns a number', { toJSON: () => 10 }],
      ['a circular object', circular],
      ['a null-prototype circular object', nullProtoCircular],
      [
        'an object whose toJSON throws',
        {
          toJSON() {
            throw new Error('refused by toJSON');
          },
        },
      ],
      [
        'an object whose Symbol.toPrimitive throws',
        {
          [Symbol.toPrimitive]() {
            throw new Error('refused by Symbol.toPrimitive');
          },
        },
      ],
      [
        'an object whose toJSON and Symbol.toPrimitive both throw',
        {
          toJSON() {
            throw new Error('refused by toJSON');
          },
          [Symbol.toPrimitive]() {
            throw new Error('refused by Symbol.toPrimitive');
          },
        },
      ],
      [
        'an object whose Symbol.toStringTag getter throws',
        {
          toJSON() {
            throw new Error('refused by toJSON');
          },
          get [Symbol.toStringTag]() {
            throw new Error('refused by Symbol.toStringTag');
          },
        },
      ],
      ['NaN', NaN],
      ['Infinity', Infinity],
      ['-Infinity', -Infinity],
      ['the empty string', ''],
      ['an empty array', []],
      ['an empty object', {}],
      ['null', null],
      ['undefined', undefined],
      ['a function', function refused() {}],
      ['true', true],
    ];
  };

  it('returns a string for every hostile value, and throws for none', () => {
    const rows = hostileValues();

    // Meta-assertions first, because "nothing threw" over a table of harmless
    // values is a statement about nothing. The table has to contain the three
    // failure modes the renderer's three layers exist for, and it is asserted
    // that it does — a table that stopped containing them fails here rather
    // than passing quietly.
    /** @param {(value: unknown) => unknown} operation */
    const rowsThatBreak = (operation) =>
      rows.filter(([, value]) => {
        try {
          operation(value);
          return false;
        } catch {
          return true;
        }
      });
    expect(rowsThatBreak((value) => JSON.stringify(value)).length).toBeGreaterThan(0);
    expect(rowsThatBreak((value) => String(value)).length).toBeGreaterThan(0);
    expect(rowsThatBreak((value) => Object.prototype.toString.call(value)).length).toBeGreaterThan(
      0
    );
    expect(rows).toHaveLength(21);

    for (const [label, value] of rows) {
      /** @type {unknown} */
      let rendered;
      expect(() => {
        rendered = describeRefusedValue(value);
      }, label).not.toThrow();
      expect(typeof rendered, label).toBe('string');
      expect(/** @type {string} */ (rendered).length, label).toBeGreaterThan(0);
    }
  });

  it('renders only numbers as numbers, so no two kinds collide', () => {
    const rows = hostileValues();
    // Meta-assertion: the sweep below is only worth anything if the table holds
    // values that are *not* numbers, and the count says how many.
    const notNumbers = rows.filter(([, value]) => typeof value !== 'number');
    expect(notNumbers).toHaveLength(18);

    for (const [label, value] of notNumbers) {
      expect(readsAsBareNumber(describeRefusedValue(value)), label).toBe(false);
    }
    // …and the predicate is not vacuously false: a number does read as one, so
    // the sweep above is a distinction and not a tautology.
    expect(readsAsBareNumber(describeRefusedValue(10))).toBe(true);
    expect(describeRefusedValue(10)).toBe('10');

    // The collision the last round shipped, named: three kinds that all used to
    // print `10`, now three different strings.
    const tens = [describeRefusedValue(10), describeRefusedValue(BigInt(10))];
    tens.push(describeRefusedValue(new Number(10)));
    expect(new Set(tens).size).toBe(3);
    expect(tens[1]).toBe('10n');
  });

  it('rejects the renderers that returned String(value)', () => {
    const rows = hostileValues();

    // The first wrong-passing implementation, constructed: `String(v)` for
    // everything, which is what the `catch` fallback did. Seven of the
    // twenty-one rows break it: three print a non-number as a number, and four
    // throw. The list is spelled out rather than counted, because which rows
    // break it is the finding.
    /** @param {unknown} value */
    const naive = (value) => String(value);
    const naiveFailures = rows.filter(([, value]) => {
      try {
        return readsAsBareNumber(naive(value)) && typeof value !== 'number';
      } catch {
        return true;
      }
    });
    expect(naiveFailures.map(([label]) => label)).toEqual([
      'a BigInt',
      'a boxed Number',
      'a boxed String',
      'a null-prototype circular object',
      'an object whose Symbol.toPrimitive throws',
      'an object whose toJSON and Symbol.toPrimitive both throw',
      'an object whose Symbol.toStringTag getter throws',
    ]);

    // The second, constructed verbatim from the implementation this round
    // replaced: numbers by `String`, everything else by `JSON.stringify` with
    // `String` as the fallback for what it declines and what it refuses.
    /** @param {unknown} value */
    const roundSix = (value) => {
      if (typeof value === 'number') return String(value);
      try {
        const json = JSON.stringify(value);
        return json === undefined ? String(value) : json;
      } catch {
        return String(value);
      }
    };
    // It throws in place of the diagnostic on the three rows whose fallback
    // also fails — the exact accident the helper is documented to prevent.
    // The count is asserted below rather than trusted here; one of the three
    // is the throwing Symbol.toStringTag row, which is the only coverage for
    // the renderer's innermost catch, so do not drop a row to make a number
    // match.
    const roundSixThrows = rows.filter(([, value]) => {
      try {
        roundSix(value);
        return false;
      } catch {
        return true;
      }
    });
    expect(roundSixThrows.map(([label]) => label)).toEqual([
      'a null-prototype circular object',
      'an object whose toJSON and Symbol.toPrimitive both throw',
      'an object whose Symbol.toStringTag getter throws',
    ]);
    // …and where it does answer, it still prints two non-numbers as `10`.
    expect(roundSix(BigInt(10))).toBe('10');
    expect(roundSix(new Number(10))).toBe('10');

    // The renderer under test survives every row of the same table. Asserted as
    // a count, so a table that shrank could not make this pass by default.
    const survived = rows.filter(([, value]) => {
      try {
        return typeof describeRefusedValue(value) === 'string';
      } catch {
        return false;
      }
    });
    expect(survived).toHaveLength(rows.length);
  });
});
