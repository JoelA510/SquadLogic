/**
 * Coach practice preferences in the practice repair, and the
 * `coachPreferenceBreached` objective term (8.6 PR 3b, PR 4; plan §4, §5
 * decisions 1 and 3, §6 witnesses).
 *
 * Every subject set here is enumerated from the roster (`season.teams`, the
 * `team_coach_assignments` rows built from it), the registry (the published
 * plan's assignments, the objective's term vocabulary) or the plan itself —
 * never from a repair's output. Plants that must turn this file red, each
 * shown in the PR body:
 *
 * - (a) the `must_keep` filter removed;
 * - (b) `PRACTICE_TBD_REASON.COACH_PREFERENCE` swapped for a generic reason;
 * - (c) the `coachPreferenceBreached` weight moved off 100;
 * - (d) the game-path guard in `coachPreferenceCountsFor()` removed;
 * - (e) strictest-wins inverted;
 * - (f) a one-line tiebreak change in the repair (the byte-identical sweep);
 * - current coaches read without their dates.
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  PRACTICE_REASON,
  PRACTICE_TBD_REASON,
  PracticeRepairInputSchema,
  repairPracticeLoss,
  toSeason2026PracticePlan,
} from '@squadlogic/core/practice/index.js';
import {
  buildSeason2026PracticeFacilityGraph,
  buildSeason2026VenueComplexMap,
  conflictingSurfacesOf,
} from '@squadlogic/core/facility/index.js';
import {
  loadFacilityGeometry,
  loadSeason2026,
  loadSeason2026Practice,
} from '@squadlogic/core/fixtures/index.js';
import {
  COACH_PREFERENCE_BREACHED_WEIGHT,
  RESOLVE_CHANGE_TERMS,
  RESOLVE_OBJECTIVE_TERM,
  RESOLVE_OBJECTIVE_WEIGHTS,
  RESOLVE_PRACTICE_QUALITY_TERMS,
  RESOLVE_QUALITY_TERMS,
  candidateObjectiveCounts,
  coachPreferenceCountsFor,
  disabledChangeTerms,
  objectiveCountsForSchedule,
  scoreObjective,
} from '@squadlogic/core/resolve/index.js';
import { tier1Projection } from './helpers/practiceRepairTier1.js';

/* -------------------------------------------------------------------------- */
/* The corpus, dated as tests/practiceRepair.test.js dates it                  */
/* -------------------------------------------------------------------------- */

const SEASON_FROM = '2026-08-17';
const SEASON_UNTIL = '2026-11-13';
const LOSS_DATE = '2026-09-28';
const BLACKOUT_UNTIL = '2026-10-25';

const practice = loadSeason2026Practice();
const season = loadSeason2026();
const graph = buildSeason2026PracticeFacilityGraph(loadFacilityGeometry());
const fullPlan = toSeason2026PracticePlan(
  practice.practiceSlots,
  graph,
  buildSeason2026VenueComplexMap()
);
const PLAN = (() => {
  const slots = fullPlan.slots
    .filter((slot) => slot.revisionId === '93 Combined' && slot.surfaceResolution === 'resolved')
    .map((slot) => ({ ...slot, validFrom: SEASON_FROM, validUntil: SEASON_UNTIL }));
  const ids = new Set(slots.map((slot) => slot.id));
  return {
    slots,
    assignments: fullPlan.assignments.filter((assignment) => ids.has(assignment.slotId)),
    source: fullPlan.source,
  };
})();
const INVENTORY = fullPlan.slots
  .filter((slot) => slot.surfaceResolution === 'resolved')
  .map(({ surfaceId, weekday, startMinutes, durationMinutes }) => ({
    surfaceId,
    weekday,
    startMinutes,
    durationMinutes,
  }));
const COACHES_BY_TEAM = Object.fromEntries(
  season.teams.map((team) => [
    team.id,
    [team.coachId, ...(team.assistantCoachIds ?? [])].filter(Boolean),
  ])
);

/** The roster as `team_coach_assignments` rows: every team's coaches, all season. */
const ROSTER_ROWS = season.teams.flatMap((team) =>
  [team.coachId, ...(team.assistantCoachIds ?? [])].filter(Boolean).map((coachId, index) => ({
    team_id: team.id,
    coach_id: coachId,
    role: index === 0 ? 'lead' : 'assistant',
    effective_from: SEASON_FROM,
    effective_to: null,
  }))
);
/** Every coach on the roster, enumerated from the teams, never from a run. */
const ROSTER_COACHES = [...new Set(ROSTER_ROWS.map((row) => row.coach_id))].sort();

/** Synthetic location ids: lowercase canonical uuids naming no real place. */
const location = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
/**
 * The corpus graph with each venue id replaced by a location uuid, as the
 * preference contract requires (venue = location, plan §5 decision 2). The
 * renaming is one-to-one, so every same-venue question answers as before.
 */
const LOCATION_GRAPH = (() => {
  const venues = [...new Set(Object.values(graph.surfaces).map((s) => s.venueId))].sort();
  const byVenue = new Map(venues.map((venue, index) => [venue, location(index + 1)]));
  return {
    ...graph,
    surfaces: Object.fromEntries(
      Object.entries(graph.surfaces).map(([id, surface]) => [
        id,
        { ...surface, venueId: byVenue.get(surface.venueId) },
      ])
    ),
  };
})();

const LOSSES = Object.freeze([
  Object.freeze({}),
  Object.freeze({ until: BLACKOUT_UNTIL }),
  Object.freeze({ until: BLACKOUT_UNTIL, startMinutes: 1020, endMinutes: 1110 }),
]);
const SURFACES = [...new Set(PLAN.slots.map((slot) => slot.surfaceId))].sort();

const corpusRepair = (surfaceId, { loss = {}, strategy = 'exact', g = graph, extra = {} } = {}) =>
  repairPracticeLoss({
    plan: PLAN,
    graph: g,
    loss: { surfaceIds: [surfaceId], from: LOSS_DATE, reason: 'field lost mid-season', ...loss },
    inventory: INVENTORY,
    coachesByTeam: COACHES_BY_TEAM,
    strategy,
    ...extra,
  });

/** Displaced series, enumerated from the plan and the graph — never from a run. */
function displacedBy(surfaceId) {
  const lost = new Set(conflictingSurfacesOf(graph, surfaceId));
  const slotById = new Map(PLAN.slots.map((slot) => [slot.id, slot]));
  return PLAN.assignments
    .filter((assignment) => lost.has(slotById.get(assignment.slotId).surfaceId))
    .map((assignment) => assignment.id)
    .sort();
}

/* -------------------------------------------------------------------------- */
/* (f) No preferences => byte-identical to main                                */
/* -------------------------------------------------------------------------- */

/**
 * Main's result for every corpus surface, digested through `tier1Projection()`:
 * retirement exact/greedy, blackout exact/greedy, blackout-with-minutes
 * exact/greedy. Computed on `origin/main` at 6db3c1b (#464), by running the
 * same projection over main's result. The projection leaves out only what 8.6
 * PR 5 replaced (the standalone cross-venue options) or added (the tier-2
 * recommendations); everything tier 1 decides is digested whole.
 */
const MAIN_SWEEP_DIGESTS = {
  'alder-park/pitch-1a-side-1': [
    '1680727867090ed3',
    '5df079ed75a45af0',
    '5bbf65af61543732',
    'f418c99496b7aa27',
    '5bbf65af61543732',
    'f418c99496b7aa27',
  ],
  'alder-park/pitch-1b-side-1': [
    '35879a889052642b',
    '82a822764e536b3e',
    'c2682cd8ac51612e',
    'd40b77bad669809a',
    'c2682cd8ac51612e',
    'd40b77bad669809a',
  ],
  'alder-park/pitch-2a': [
    '2a754b4ccf43b88c',
    '78ad414896fea926',
    '4d22e90e3136ebba',
    '104297b9c0905998',
    '4d22e90e3136ebba',
    '104297b9c0905998',
  ],
  'alder-park/pitch-2b': [
    'b2de45741b535b0e',
    '04b12d22a6dc1588',
    '37bfb71d5fa6fe80',
    'e171b7fd420be1e5',
    '37bfb71d5fa6fe80',
    'e171b7fd420be1e5',
  ],
  'alder-park/pitch-3a': [
    '8086585ec6501329',
    'fb9eaa0429264951',
    'adae785feb2739d0',
    '973ed5cb29b93448',
    'adae785feb2739d0',
    '973ed5cb29b93448',
  ],
  'alder-park/pitch-3b': [
    'e7cf14df988397e1',
    '3e0017540b1661bf',
    'f63e359c31fd4e0d',
    'f6cb39e173754be7',
    'f63e359c31fd4e0d',
    'f6cb39e173754be7',
  ],
  'alder-park/pitch-4a-side-1': [
    '763c281bbc8c6454',
    '6e656f1ad45c0f48',
    '4900e769b700299b',
    '717f94f4d60cbfb1',
    '4900e769b700299b',
    '717f94f4d60cbfb1',
  ],
  'alder-park/pitch-4b-side-1': [
    'e84c1e64d562de7f',
    'bd19b67cfbd7cf2d',
    '94640321ce38d4cc',
    '8fea154c4b76efe1',
    '94640321ce38d4cc',
    '8fea154c4b76efe1',
  ],
  'brookside-park/lower-a': [
    'a35ca3fd8408f84f',
    'e103296649de3e9a',
    '2766c9e8290fed66',
    '8f95a60d2f67655a',
    '2766c9e8290fed66',
    '8f95a60d2f67655a',
  ],
  'brookside-park/lower-b': [
    'a562165159c8801f',
    'abd53e7ba3218021',
    '296f953d6ecf61ff',
    '37857d43a1164484',
    '296f953d6ecf61ff',
    '37857d43a1164484',
  ],
  'larkfield-green/field-1-a': [
    '6512de4eeb1ae3b9',
    '24466d741c948181',
    '0a9815d147989fa0',
    '04f9c57b61c6e03d',
    '0a9815d147989fa0',
    '04f9c57b61c6e03d',
  ],
  'maplewood-back/field-1-a': [
    'ba535c3e8f6455d5',
    'c48053a7172d2b39',
    'eac7725443cb4eb8',
    'd03351ef8a29c055',
    '7de40f36f3adea72',
    '84703a5ae8c54c89',
  ],
  'maplewood-back/field-1-b': [
    '6bd9d08629158fff',
    '77d4a35240bb7b4a',
    '00e05209adc07f09',
    'a67dddb4115b3731',
    'dceae9a9f4ddca4c',
    '4281e77218e4e69f',
  ],
  'maplewood-back/field-2-a': [
    '76e90cc79363f869',
    '9f6a5936d85ca23b',
    'ab88a4c7e13d0199',
    '1441823fd52799ad',
    '3583c7929571f15b',
    '4f3c92f526c17d74',
  ],
  'maplewood-back/field-2-b': [
    '5706312ecbb0f483',
    '3d9842ff1dc0a8bb',
    'c2f5284409f055fb',
    '66d73bb8327c2951',
    '52dd65c907eb9c15',
    'd5dd7a965ca82045',
  ],
  'maplewood-back/field-3-a': [
    '451fa928182c6955',
    'e0c9a4240cf678fd',
    'ada6934938499de7',
    '766c70b9b04397a7',
    'af40ff58a3badaee',
    '24990041eec2144f',
  ],
  'maplewood-back/field-3-b': [
    '15337162095bd9bc',
    'e1906f8c1fff3cba',
    'd248e5e630427f04',
    '519900298004c844',
    'a710154da08a5bc0',
    '617fd822fc9a6917',
  ],
  'maplewood-back/field-4-a': [
    '7a3d8555e2fe4287',
    '75d743fd95365822',
    '1085ff6225914fdf',
    'a178e788af3cc460',
    '1085ff6225914fdf',
    'a178e788af3cc460',
  ],
  'maplewood-back/field-4-b': [
    '68aef23f6c032685',
    '4a5e3abe703312a8',
    '6d0d3538d3399156',
    'f1b7bb7b2dba8916',
    '6d0d3538d3399156',
    'f1b7bb7b2dba8916',
  ],
  'orchard-park/field-1-a': [
    '4c9e2c13834d1e4b',
    '440563a3fe33855a',
    '5e86e05b85847ae7',
    '2dac304cf0eb880c',
    'ddadcbcf4ddeab51',
    'cb0e8b11c66a527e',
  ],
  'orchard-park/field-1-b': [
    'fd12ea3b0d9549cd',
    'cd45a992efad5360',
    '1929764d55698309',
    '9f03655ad4ac42b8',
    '1929764d55698309',
    '9f03655ad4ac42b8',
  ],
  'orchard-park/field-2-a': [
    '2c188154cf5634de',
    'd08a301623b2e152',
    '22fd5751aa2ebab7',
    'd5960f1222edd35e',
    '22fd5751aa2ebab7',
    'd5960f1222edd35e',
  ],
  'orchard-park/field-2-b': [
    '9b41c9b2199b6ea9',
    'af0216dfcec1ace4',
    '971d5c0bf2377ca5',
    '0a45b20a084b3c87',
    '55c6ce2b16ab8a68',
    '322266f760e761e6',
  ],
  'orchard-park/field-3-a': [
    '8e29681d1ec0aedd',
    '233c0217024ea4d4',
    'fc5e3669e2fb4a17',
    'caab94052439d2b9',
    'fc5e3669e2fb4a17',
    'caab94052439d2b9',
  ],
  'orchard-park/field-3-b': [
    '92c4263f5b0f3601',
    'ed411c6101b6f200',
    '5f58ecc5417389db',
    'f5c5cdf7e1208757',
    '5f58ecc5417389db',
    'f5c5cdf7e1208757',
  ],
  'orchard-park/field-4-a': [
    '2ae6f41b2ee2daf3',
    '55d34ba16ea9015d',
    'b463a1bb1d17df81',
    '773428fde9d61b02',
    'b463a1bb1d17df81',
    '773428fde9d61b02',
  ],
  'orchard-park/field-4-b': [
    '216dd71ce1616a86',
    '5d804035a891f3c3',
    '9d0bd74e34a671e8',
    '3ef2033d95ae7b9d',
    '9d0bd74e34a671e8',
    '3ef2033d95ae7b9d',
  ],
  'orchard-park/field-5': [
    '7e23dbf0022acf29',
    '12c474183ba0b804',
    '3aba13936645c708',
    '7ba6ffa729c12dfb',
    '3aba13936645c708',
    '7ba6ffa729c12dfb',
  ],
  'orchard-park/field-6': [
    '717af098148a5a40',
    'f0873ee51bb69168',
    'be6b55a67e951494',
    '2986d50b49567ee8',
    'be6b55a67e951494',
    '2986d50b49567ee8',
  ],
};

function resultDigest(result) {
  const json = JSON.stringify(tier1Projection(result), (key, value) => {
    if (value instanceof Map) return ['Map', [...value]];
    if (value instanceof Set) return ['Set', [...value]];
    return value;
  });
  return createHash('sha256').update(json).digest('hex').slice(0, 16);
}

function sweep(extra) {
  const digests = {};
  const exercised = { displaced: 0, rehomed: 0, timeTbd: 0 };
  for (const surfaceId of SURFACES) {
    digests[surfaceId] = LOSSES.flatMap((loss) =>
      ['exact', 'greedy'].map((strategy) => {
        const result = corpusRepair(surfaceId, { loss, strategy, extra });
        exercised.displaced += result.stats.displaced;
        exercised.rehomed += result.stats.rehomed;
        exercised.timeTbd += result.stats.timeTbd;
        return resultDigest(result);
      })
    );
  }
  return { digests, exercised };
}

describe('coach preferences :: no preferences, byte-identical to main (plan §4, §6)', () => {
  const variants = {
    'no preference inputs at all': {},
    'an empty preference list, with the roster rows': {
      coachPreferences: [],
      teamCoachAssignments: ROSTER_ROWS,
    },
    'every roster coach holding dont_care on every dimension': {
      coachPreferences: ROSTER_COACHES.flatMap((coachId) =>
        ['weekday', 'start_time', 'venue'].map((dimension) => ({
          coachId,
          dimension,
          level: 'dont_care',
          value: null,
        }))
      ),
      teamCoachAssignments: ROSTER_ROWS,
    },
  };

  for (const [name, extra] of Object.entries(variants)) {
    it(`${name}: every corpus loss, exact and greedy, matches main`, () => {
      const { digests, exercised } = sweep(extra);
      expect(Object.keys(digests)).toEqual(SURFACES);
      expect(SURFACES.length).toBe(29);
      // The sweep compares real repairs, not empty results.
      expect(exercised.displaced).toBeGreaterThan(0);
      expect(exercised.rehomed).toBeGreaterThan(0);
      expect(exercised.timeTbd).toBeGreaterThan(0);
      expect(digests).toEqual(MAIN_SWEEP_DIGESTS);
    }, 120_000); // 174 corpus repairs per variant: seconds alone, longer under the full suite.
  }

  it('the dont_care variant really handed the repair a preference per roster coach', () => {
    const preferences = variants['every roster coach holding dont_care on every dimension'];
    expect(preferences.coachPreferences.length).toBe(ROSTER_COACHES.length * 3);
    expect(ROSTER_COACHES.length).toBeGreaterThan(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Constructed cases on the corpus's own ground                                */
/* -------------------------------------------------------------------------- */

const OP = (name) => `orchard-park/${name}`;
const AP = (name) => `alder-park/${name}`;
const ORCHARD = LOCATION_GRAPH.surfaces[OP('field-3-a')].venueId;
const ALDER = LOCATION_GRAPH.surfaces[AP('pitch-2a')].venueId;

/** Team T's coach rows, all season unless stated. */
const rowsFor = (coaches, teamId = 'T') =>
  coaches.map((coachId, index) => ({
    team_id: teamId,
    coach_id: coachId,
    role: index === 0 ? 'lead' : 'assistant',
    effective_from: SEASON_FROM,
    effective_to: null,
  }));

/**
 * One series for team T, Tue 17:00 on Orchard Park field 2-a, displaced by the
 * loss of field 2, and whatever inventory the case offers.
 *
 * @param {{ inventory: Array<Object>, preferences?: Array<Object>, rows?: Array<Object>, loss?: Object, extra?: Object, on?: { weekday: string, startMinutes: number } }} options
 */
function constructed({
  inventory,
  preferences,
  rows,
  loss = {},
  extra = {},
  on = { weekday: 'TUE', startMinutes: 1020 },
}) {
  return repairPracticeLoss({
    plan: {
      slots: [
        {
          id: 'c-slot-0',
          surfaceId: OP('field-2-a'),
          weekday: on.weekday,
          startMinutes: on.startMinutes,
          durationMinutes: 60,
          validFrom: SEASON_FROM,
          validUntil: SEASON_UNTIL,
          capacity: 1,
          revisionId: 'constructed',
          label: null,
          surfaceResolution: 'resolved',
        },
      ],
      assignments: [
        {
          id: 'c-asg-0',
          slotId: 'c-slot-0',
          teamId: 'T',
          effectiveFrom: null,
          effectiveUntil: null,
        },
      ],
      source: 'constructed',
    },
    graph: LOCATION_GRAPH,
    loss: { surfaceIds: [OP('field-2')], from: LOSS_DATE, reason: 'constructed', ...loss },
    inventory: inventory.map((shape) => ({ durationMinutes: 60, ...shape })),
    ...(preferences === undefined
      ? {}
      : { coachPreferences: preferences, teamCoachAssignments: rows ?? rowsFor(['coach-1']) }),
    ...extra,
  });
}
const pref = (coachId, dimension, level, value = null) => ({ coachId, dimension, level, value });

/** Same venue, another day, same time: the day move a `weekday` preference is about. */
const THURSDAY = { surfaceId: OP('field-3-a'), weekday: 'THU', startMinutes: 1020 };

/* -------------------------------------------------------------------------- */
/* (a), (b) must_keep is a hard filter, and its TBD says so                    */
/* -------------------------------------------------------------------------- */

describe('coach preferences :: must_keep is a hard candidate filter (plan §4)', () => {
  it('control: without a preference the day move is taken', () => {
    const run = constructed({ inventory: [THURSDAY] });
    expect(run.rehomed.map((entry) => entry.to.weekday)).toEqual(['THU']);
  });

  it('with must_keep on weekday the only candidate is refused, and the series is TIME TBD coach-preference', () => {
    const run = constructed({
      inventory: [THURSDAY],
      preferences: [pref('coach-1', 'weekday', 'must_keep')],
    });
    expect(run.rehomed).toEqual([]);
    expect(run.timeTbd).toHaveLength(1);
    expect(run.timeTbd[0]).toMatchObject({
      assignmentId: 'c-asg-0',
      reason: PRACTICE_TBD_REASON.COACH_PREFERENCE,
      mustKeepDimensions: ['weekday'],
      sameVenueCandidates: 0,
    });
    expect(PRACTICE_TBD_REASON.COACH_PREFERENCE).toBe('coach-preference');
    const finding = run.findings.find((f) => f.code === PRACTICE_REASON.REPAIR_TIME_TBD);
    expect(finding.details.reason).toBe('coach-preference');
  });

  it('keeps a candidate that keeps the day, and takes it over the cheaper day move', () => {
    const run = constructed({
      inventory: [THURSDAY, { surfaceId: OP('field-3-a'), weekday: 'TUE', startMinutes: 1290 }],
      preferences: [pref('coach-1', 'weekday', 'must_keep')],
    });
    expect(run.timeTbd).toEqual([]);
    expect(run.rehomed.map((entry) => [entry.to.weekday, entry.to.startMinutes])).toEqual([
      ['TUE', 1290],
    ]);
  });

  it('names only what emptied the venue, not what refused a cross-venue option', () => {
    const run = constructed({
      inventory: [
        { surfaceId: OP('field-3-a'), weekday: 'TUE', startMinutes: 1080 },
        { surfaceId: AP('pitch-2a'), weekday: 'TUE', startMinutes: 1020 },
      ],
      preferences: [
        pref('coach-1', 'start_time', 'must_keep'),
        pref('coach-1', 'venue', 'must_keep'),
      ],
    });
    expect(run.timeTbd[0]).toMatchObject({
      reason: PRACTICE_TBD_REASON.COACH_PREFERENCE,
      mustKeepDimensions: ['start_time'],
    });
    // must_keep venue refuses the Alder Park shape too: no recommendation.
    expect(run.recommendations[0].to).toBeNull();
  });

  it('with no legal candidate before the filter the reason stays no-legal-slot-at-venue', () => {
    const run = constructed({
      inventory: [],
      preferences: [pref('coach-1', 'weekday', 'must_keep')],
    });
    expect(run.timeTbd.map((entry) => entry.reason)).toEqual([
      PRACTICE_TBD_REASON.NO_LEGAL_SLOT_AT_VENUE,
    ]);
    expect(run.timeTbd[0].mustKeepDimensions).toBeUndefined();
  });

  it('filters tier-2 candidates too: must_keep on venue recommends none, and weekday only a same-day one', () => {
    const inventory = [
      { surfaceId: AP('pitch-2a'), weekday: 'TUE', startMinutes: 1020 },
      { surfaceId: AP('pitch-2a'), weekday: 'WED', startMinutes: 1020 },
    ];
    expect(ALDER).not.toBe(ORCHARD);
    // One series, so one recommendation; the filter decides whether there is one
    // and which day it may be.
    const unfiltered = constructed({ inventory });
    expect(unfiltered.recommendations[0]).toMatchObject({ tier: 'cross-venue' });
    const byVenue = constructed({
      inventory,
      preferences: [pref('coach-1', 'venue', 'must_keep')],
    });
    expect(byVenue.recommendations[0].to).toBeNull();
    const byDay = constructed({
      inventory,
      preferences: [
        pref('coach-1', 'weekday', 'must_keep'),
        pref('coach-1', 'start_time', 'prefer_keep'),
      ],
    });
    expect(byDay.recommendations[0].to.weekday).toBe('TUE');
    // Control: with the Tuesday shape gone, must_keep weekday leaves nothing.
    const noTuesday = constructed({
      inventory: [inventory[1]],
      preferences: [pref('coach-1', 'weekday', 'must_keep')],
    });
    expect(noTuesday.recommendations[0].to).toBeNull();
  });
});

/**
 * The reference rule (operator ruling 2026-09-28, amending plan §4): a
 * preference with a `value` keeps the value; one with a null value keeps the
 * series being moved. Every case below reads its coaches from roster rows.
 */
describe('coach preferences :: an approved value is the reference (ruling 2026-09-28)', () => {
  const ON_WEDNESDAY = { weekday: 'WED', startMinutes: 1020 };
  const same = (weekday, startMinutes = 1020) => ({
    surfaceId: OP('field-3-a'),
    weekday,
    startMinutes,
  });
  const conflicted = (run) =>
    run.findings.filter((f) => f.code === PRACTICE_REASON.COACH_PREFERENCE_CONFLICT);

  it('must_keep TUE on a team now on WED lands only on a Tuesday', () => {
    const inventory = [same('WED', 1080), same('TUE', 1080)];
    // Control: keeping what it has, the team stays on Wednesday.
    expect(constructed({ inventory, on: ON_WEDNESDAY }).rehomed[0].to.weekday).toBe('WED');
    const run = constructed({
      inventory,
      on: ON_WEDNESDAY,
      preferences: [pref('coach-1', 'weekday', 'must_keep', 'TUE')],
      rows: rowsFor(['coach-1']),
    });
    expect(run.rehomed.map((e) => [e.to.weekday, e.to.startMinutes])).toEqual([['TUE', 1080]]);
  });

  it('with no Tuesday candidate, that team is TIME TBD coach-preference', () => {
    const run = constructed({
      inventory: [same('WED', 1080), same('THU')],
      on: ON_WEDNESDAY,
      preferences: [pref('coach-1', 'weekday', 'must_keep', 'TUE')],
      rows: rowsFor(['coach-1']),
    });
    expect(run.rehomed).toEqual([]);
    expect(run.timeTbd[0]).toMatchObject({
      reason: PRACTICE_TBD_REASON.COACH_PREFERENCE,
      mustKeepDimensions: ['weekday'],
    });
  });

  it('two must_keep coaches with different values conflict, breach every candidate, and go TIME TBD', () => {
    const run = constructed({
      inventory: [same('TUE', 1080), same('THU')],
      preferences: [
        pref('coach-1', 'weekday', 'must_keep', 'TUE'),
        pref('coach-2', 'weekday', 'must_keep', 'THU'),
      ],
      rows: rowsFor(['coach-1', 'coach-2']),
    });
    expect(run.rehomed).toEqual([]);
    expect(run.timeTbd[0].reason).toBe(PRACTICE_TBD_REASON.COACH_PREFERENCE);
    expect(conflicted(run).map((f) => f.details)).toEqual([
      expect.objectContaining({
        dimension: 'weekday',
        level: 'must_keep',
        references: ['TUE', 'THU'],
        assignmentId: 'c-asg-0',
        teamId: 'T',
      }),
    ]);
  });

  it('control: two must_keep coaches with the same value do not conflict', () => {
    const run = constructed({
      inventory: [same('TUE', 1080), same('THU')],
      preferences: [
        pref('coach-1', 'weekday', 'must_keep', 'THU'),
        pref('coach-2', 'weekday', 'must_keep', 'THU'),
      ],
      rows: rowsFor(['coach-1', 'coach-2']),
    });
    expect(conflicted(run)).toEqual([]);
    expect(run.rehomed.map((e) => e.to.weekday)).toEqual(['THU']);
  });

  it('prefer_keep with a value breaches when the candidate differs from the value', () => {
    const inventory = [same('TUE', 1080), same('THU')];
    const free = constructed({ inventory });
    // Unpreferred, the hour shift on Tuesday wins (1061 < 1241).
    expect(free.rehomed[0].to.weekday).toBe('TUE');
    const run = constructed({
      inventory,
      preferences: [pref('coach-1', 'weekday', 'prefer_keep', 'THU')],
      rows: rowsFor(['coach-1']),
    });
    // Tuesday now breaches THU (1061 + 100) and still beats Thursday (1241).
    expect(run.rehomed[0].to.weekday).toBe('TUE');
    expect(run.rehomed[0].counts.coachPreferenceBreached).toBe(1);
    expect(run.stats.objectiveTotal).toBe(free.stats.objectiveTotal + PLAN_COACH_PREFERENCE_WEIGHT);
    // The same preference held on the day it is being kept on breaches nothing.
    const kept = constructed({
      inventory: [same('THU')],
      preferences: [pref('coach-1', 'weekday', 'prefer_keep', 'THU')],
      rows: rowsFor(['coach-1']),
    });
    expect(kept.rehomed[0].counts.coachPreferenceBreached).toBeUndefined();
  });

  // Start times are compared to the minute: every case here is 30 minutes off.
  it('must_keep start_time 17:30 lands only on 17:30, not on the cheaper 17:00', () => {
    const inventory = [same('TUE', 1020), same('TUE', 1050)];
    // Control: unpreferred, the 17:00 slot keeps the published time.
    expect(constructed({ inventory }).rehomed[0].to.startMinutes).toBe(1020);
    const run = constructed({
      inventory,
      preferences: [pref('coach-1', 'start_time', 'must_keep', 1050)],
      rows: rowsFor(['coach-1']),
    });
    expect(run.rehomed.map((e) => [e.to.weekday, e.to.startMinutes])).toEqual([['TUE', 1050]]);
  });

  it('must_keep start_time 17:30 with only a 17:00 candidate is TIME TBD coach-preference', () => {
    const run = constructed({
      inventory: [same('TUE', 1020)],
      preferences: [pref('coach-1', 'start_time', 'must_keep', 1050)],
      rows: rowsFor(['coach-1']),
    });
    expect(run.rehomed).toEqual([]);
    expect(run.timeTbd[0]).toMatchObject({
      reason: PRACTICE_TBD_REASON.COACH_PREFERENCE,
      mustKeepDimensions: ['start_time'],
    });
  });

  it('prefer_keep start_time 17:30 against a 17:00 candidate breaches once (+100)', () => {
    const inventory = [same('TUE', 1020)];
    const free = constructed({ inventory });
    const run = constructed({
      inventory,
      preferences: [pref('coach-1', 'start_time', 'prefer_keep', 1050)],
      rows: rowsFor(['coach-1']),
    });
    expect(run.rehomed[0].to.startMinutes).toBe(1020);
    expect(run.rehomed[0].counts.coachPreferenceBreached).toBe(1);
    expect(run.stats.objectiveTotal).toBe(free.stats.objectiveTotal + PLAN_COACH_PREFERENCE_WEIGHT);
  });

  it('a null value keeps the series being moved, not any other day', () => {
    const run = constructed({
      inventory: [same('TUE', 1080), same('WED', 1080), same('THU')],
      on: ON_WEDNESDAY,
      preferences: [pref('coach-1', 'weekday', 'must_keep')],
      rows: rowsFor(['coach-1']),
    });
    expect(run.rehomed.map((e) => e.to.weekday)).toEqual(['WED']);
    expect(conflicted(run)).toEqual([]);
  });

  it('mixed coaches, one with a value and one null, resolve as #453 does: differing references conflict', () => {
    const run = constructed({
      inventory: [same('TUE', 1080), same('THU')],
      preferences: [
        pref('coach-1', 'weekday', 'must_keep', 'THU'),
        pref('coach-2', 'weekday', 'must_keep'),
      ],
      rows: rowsFor(['coach-1', 'coach-2']),
    });
    // coach-1 keeps THU, coach-2 keeps the series' TUE: no candidate keeps both.
    expect(run.timeTbd[0].reason).toBe(PRACTICE_TBD_REASON.COACH_PREFERENCE);
    expect(conflicted(run).map((f) => f.details.references)).toEqual([['THU', 'TUE']]);
    // Strictest wins first: a prefer_keep value under a null must_keep is outranked.
    const outranked = constructed({
      inventory: [same('TUE', 1080), same('THU')],
      preferences: [
        pref('coach-1', 'weekday', 'prefer_keep', 'THU'),
        pref('coach-2', 'weekday', 'must_keep'),
      ],
      rows: rowsFor(['coach-1', 'coach-2']),
    });
    expect(outranked.rehomed.map((e) => e.to.weekday)).toEqual(['TUE']);
    expect(conflicted(outranked)).toEqual([]);
  });
});

describe('coach preferences :: must_keep over the whole corpus, roster-enumerated (plan §6)', () => {
  // Every roster coach holds must_keep on weekday. Every series each corpus
  // loss displaces (from the plan and the graph) is judged.
  const preferences = ROSTER_COACHES.map((coachId) => pref(coachId, 'weekday', 'must_keep'));
  const RUNS = SURFACES.map((surfaceId) => ({
    surfaceId,
    displaced: displacedBy(surfaceId),
    free: corpusRepair(surfaceId, { g: LOCATION_GRAPH }),
    kept: corpusRepair(surfaceId, {
      g: LOCATION_GRAPH,
      extra: { coachPreferences: preferences, teamCoachAssignments: ROSTER_ROWS },
    }),
  }));
  const coached = new Set(ROSTER_ROWS.map((row) => row.team_id));

  it('never drops a displaced series: each is re-homed or TIME TBD exactly once', () => {
    let judged = 0;
    for (const { displaced, kept } of RUNS) {
      const seen = [...kept.rehomed, ...kept.timeTbd].map((entry) => entry.assignmentId).sort();
      expect(seen).toEqual(displaced);
      judged += displaced.length;
    }
    expect(judged).toBeGreaterThan(0);
  });

  it('every re-homed series of a coached team keeps its weekday', () => {
    let checked = 0;
    let moved = 0;
    for (const { free, kept } of RUNS) {
      for (const entry of kept.rehomed) {
        if (!coached.has(entry.teamId)) continue;
        expect({ id: entry.assignmentId, weekday: entry.to.weekday }).toEqual({
          id: entry.assignmentId,
          weekday: entry.from.weekday,
        });
        checked += 1;
      }
      moved += free.rehomed.filter((e) => coached.has(e.teamId) && e.weekdayChanged).length;
    }
    // The filter had something to refuse: without it the corpus moves days.
    expect(checked).toBeGreaterThan(0);
    expect(moved).toBeGreaterThan(0);
  });

  it('a coach-preference TBD had legal slots before the filter and none after', () => {
    let tbd = 0;
    for (const { free, kept } of RUNS) {
      const before = new Map([
        ...free.rehomed.map((e) => [e.assignmentId, 1]),
        ...free.timeTbd.map((e) => [e.assignmentId, e.sameVenueCandidates]),
      ]);
      for (const entry of kept.timeTbd) {
        const legalBefore = before.get(entry.assignmentId);
        if (entry.reason === PRACTICE_TBD_REASON.COACH_PREFERENCE) {
          tbd += 1;
          expect(legalBefore).toBeGreaterThan(0);
          expect(entry.sameVenueCandidates).toBe(0);
          expect(entry.mustKeepDimensions).toEqual(['weekday']);
        } else if (entry.sameVenueCandidates === 0) {
          expect({ id: entry.assignmentId, reason: entry.reason }).toEqual({
            id: entry.assignmentId,
            reason: PRACTICE_TBD_REASON.NO_LEGAL_SLOT_AT_VENUE,
          });
        }
      }
    }
    expect(tbd).toBeGreaterThan(0);
  });
});

/* -------------------------------------------------------------------------- */
/* (c) prefer_keep is priced at 100 per breached dimension                     */
/* -------------------------------------------------------------------------- */

/** Plan §5, decision 1: the weight the operator approved. */
const PLAN_COACH_PREFERENCE_WEIGHT = 100;

describe('coach preferences :: prefer_keep is coachPreferenceBreached, weight 100 (plan §5.1)', () => {
  it('the objective table holds the approved weight, through its named constant', () => {
    expect(COACH_PREFERENCE_BREACHED_WEIGHT).toBe(PLAN_COACH_PREFERENCE_WEIGHT);
    expect(RESOLVE_OBJECTIVE_WEIGHTS[RESOLVE_OBJECTIVE_TERM.COACH_PREFERENCE_BREACHED]).toBe(
      PLAN_COACH_PREFERENCE_WEIGHT
    );
    expect(RESOLVE_OBJECTIVE_TERM.COACH_PREFERENCE_BREACHED).toBe('coachPreferenceBreached');
  });

  it('charges exactly the weight once per breached dimension, not per coach', () => {
    // Thu 18:00 at the same venue breaks weekday and start time; venue is kept.
    const inventory = [{ surfaceId: OP('field-3-a'), weekday: 'THU', startMinutes: 1080 }];
    const free = constructed({ inventory });
    const cases = [
      { preferences: [pref('coach-1', 'venue', 'prefer_keep')], breaches: 0 },
      { preferences: [pref('coach-1', 'weekday', 'prefer_keep')], breaches: 1 },
      {
        preferences: [
          pref('coach-1', 'weekday', 'prefer_keep'),
          pref('coach-1', 'start_time', 'prefer_keep'),
          pref('coach-1', 'venue', 'prefer_keep'),
        ],
        breaches: 2,
      },
      {
        // Two coaches on one dimension: still one breached dimension.
        preferences: [
          pref('coach-1', 'weekday', 'prefer_keep'),
          pref('coach-2', 'weekday', 'prefer_keep'),
        ],
        rows: rowsFor(['coach-1', 'coach-2']),
        breaches: 1,
      },
    ];
    for (const { preferences, rows, breaches } of cases) {
      const run = constructed({ inventory, preferences, rows });
      expect(run.rehomed).toHaveLength(1);
      expect(run.stats.objectiveTotal).toBe(
        free.stats.objectiveTotal + breaches * PLAN_COACH_PREFERENCE_WEIGHT
      );
      expect(run.rehomed[0].counts.coachPreferenceBreached).toBe(breaches || undefined);
    }
  });

  it('is priced into the search: prefer_keep on weekday turns the day move into an hour-and-a-half shift', () => {
    // Without it: Thu 17:00 costs 1000 + 240 + 1; Tue 21:30 costs 1000 + 270 + 1.
    const inventory = [
      THURSDAY,
      { surfaceId: OP('field-3-a'), weekday: 'TUE', startMinutes: 1290 },
    ];
    expect(constructed({ inventory }).rehomed[0].to.weekday).toBe('THU');
    const run = constructed({
      inventory,
      preferences: [pref('coach-1', 'weekday', 'prefer_keep')],
    });
    expect(run.rehomed[0].to).toMatchObject({ weekday: 'TUE', startMinutes: 1290 });
  });

  it('prices a tier-2 recommendation through the one objective', () => {
    const inventory = [{ surfaceId: AP('pitch-2a'), weekday: 'TUE', startMinutes: 1020 }];
    const free = constructed({ inventory }).recommendations[0].objective.total;
    const run = constructed({ inventory, preferences: [pref('coach-1', 'venue', 'prefer_keep')] });
    expect(run.recommendations[0].tier).toBe('cross-venue');
    expect(run.recommendations[0].objective.total).toBe(free + PLAN_COACH_PREFERENCE_WEIGHT);
  });
});

/* -------------------------------------------------------------------------- */
/* (e) Strictest wins, enumerated                                              */
/* -------------------------------------------------------------------------- */

const LEVELS = ['must_keep', 'prefer_keep', 'dont_care'];
const RANK = { dont_care: 0, prefer_keep: 1, must_keep: 2 };

/** Every length-n tuple over `options`. */
function tuples(options, n) {
  let out = [[]];
  for (let i = 0; i < n; i += 1) out = out.flatMap((t) => options.map((o) => [...t, o]));
  return out;
}

describe('coach preferences :: strictest wins across the current coaches (plan §4, §6)', () => {
  it('every level combination of 0-3 coaches, for weekday and start time, matches the oracle', () => {
    const cases = [];
    for (const [dimension, candidate] of [
      ['weekday', THURSDAY],
      ['start_time', { surfaceId: OP('field-3-a'), weekday: 'TUE', startMinutes: 1080 }],
    ]) {
      const free = constructed({ inventory: [candidate] }).stats.objectiveTotal;
      for (let n = 0; n <= 3; n += 1) {
        const coaches = ['coach-1', 'coach-2', 'coach-3'].slice(0, n);
        for (const levels of tuples(LEVELS, n)) {
          // The oracle, from the plan's words alone.
          const strictest = levels.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), 'dont_care');
          const run = constructed({
            inventory: [candidate],
            preferences: coaches.map((coachId, i) => pref(coachId, dimension, levels[i])),
            rows: rowsFor(coaches.length > 0 ? coaches : ['coach-1']),
          });
          const outcome =
            run.timeTbd.length === 1
              ? run.timeTbd[0].reason
              : run.stats.objectiveTotal - free === PLAN_COACH_PREFERENCE_WEIGHT
                ? 'breached'
                : run.stats.objectiveTotal === free
                  ? 'free'
                  : 'unexpected';
          const expected = { must_keep: 'coach-preference', prefer_keep: 'breached' }[strictest];
          cases.push({ dimension, levels, outcome, expected: expected ?? 'free' });
        }
      }
    }
    // 1 + 3 + 9 + 27 level combinations, for each of two dimensions.
    expect(cases.length).toBe(80);
    for (const entry of cases) expect(entry.outcome).toBe(entry.expected);
    expect(new Set(cases.map((c) => c.expected))).toEqual(
      new Set(['coach-preference', 'breached', 'free'])
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Current coaches: team_coach_assignments rows on the repair date             */
/* -------------------------------------------------------------------------- */

describe('coach preferences :: only coaches current on the repair date count', () => {
  const must = [pref('coach-1', 'weekday', 'must_keep')];
  const row = (from, to, teamId = 'T') => ({
    team_id: teamId,
    coach_id: 'coach-1',
    role: 'lead',
    effective_from: from,
    effective_to: to,
  });
  const outcome = (rows, loss) => {
    const run = constructed({ inventory: [THURSDAY], preferences: must, rows, loss });
    return run.timeTbd.length === 1 ? run.timeTbd[0].reason : 'rehomed';
  };

  it('counts a row that covers the date the repair takes effect', () => {
    expect(outcome([row(SEASON_FROM, null)])).toBe('coach-preference');
    expect(outcome([row(LOSS_DATE, LOSS_DATE)])).toBe('coach-preference');
  });

  it('ignores a row that ended before it, starts after it, never took effect, or is another team', () => {
    expect(outcome([row(SEASON_FROM, '2026-09-27')])).toBe('rehomed');
    expect(outcome([row('2026-09-29', null)])).toBe('rehomed');
    expect(outcome([row(LOSS_DATE, '2026-09-27')])).toBe('rehomed');
    expect(outcome([row(SEASON_FROM, null, 'OTHER')])).toBe('rehomed');
  });

  it('for a blackout, reads the coaches on the first day of the series-window', () => {
    const loss = { from: '2026-10-05', until: BLACKOUT_UNTIL };
    expect(outcome([row('2026-10-05', null)], loss)).toBe('coach-preference');
    expect(outcome([row(SEASON_FROM, '2026-10-04')], loss)).toBe('rehomed');
  });
});

/* -------------------------------------------------------------------------- */
/* (d) Games can never count the term                                          */
/* -------------------------------------------------------------------------- */

describe('coach preferences :: coachPreferenceBreached is practice-only (plan §4)', () => {
  const GAME_REFERENCE = { date: '2026-09-05', surfaceId: 'a', startMinutes: 600 };
  const GAME_SLOT = { date: '2026-09-05', surfaceId: 'b', startMinutes: 630 };

  it('a game objective with preference data present is unchanged', () => {
    const counts = candidateObjectiveCounts({ reference: GAME_REFERENCE, slot: GAME_SLOT });
    const before = scoreObjective(counts, RESOLVE_OBJECTIVE_WEIGHTS);
    // What main scored this move at: one changed game, 30 minutes, new ground.
    expect(before.total).toBe(1000 + 30 + 1);
    for (const breaches of [1, 2, 3]) {
      const withPreferences = { ...counts, ...coachPreferenceCountsFor(GAME_SLOT, breaches) };
      expect(withPreferences).toEqual(counts);
      expect(scoreObjective(withPreferences, RESOLVE_OBJECTIVE_WEIGHTS).total).toBe(before.total);
    }
    const schedule = objectiveCountsForSchedule(
      /** @type {any} */ ({
        referenceGames: [{ id: 'g', ...GAME_REFERENCE }],
        games: [{ id: 'g', ...GAME_SLOT }],
      })
    );
    expect(schedule[RESOLVE_OBJECTIVE_TERM.COACH_PREFERENCE_BREACHED]).toBeUndefined();
  });

  it('control: a practice series slot does count it', () => {
    const series = { weekday: 'TUE', surfaceId: 'b', startMinutes: 630 };
    expect(coachPreferenceCountsFor(series, 2)).toEqual({ coachPreferenceBreached: 2 });
    expect(coachPreferenceCountsFor(series, 0)).toEqual({});
    expect(() => coachPreferenceCountsFor(series, -1)).toThrow(RangeError);
  });

  it('is in no game term list, so what game runs report is unchanged', () => {
    const term = RESOLVE_OBJECTIVE_TERM.COACH_PREFERENCE_BREACHED;
    expect(RESOLVE_PRACTICE_QUALITY_TERMS).toEqual([term]);
    expect(RESOLVE_CHANGE_TERMS).not.toContain(term);
    expect(RESOLVE_QUALITY_TERMS).not.toContain(term);
    expect(disabledChangeTerms({ ...RESOLVE_OBJECTIVE_WEIGHTS, [term]: 0 })).toEqual([]);
    expect(scoreObjective({ [term]: 1 }, RESOLVE_OBJECTIVE_WEIGHTS)).toMatchObject({
      changeCost: 0,
      qualityCost: PLAN_COACH_PREFERENCE_WEIGHT,
    });
  });
});

/* -------------------------------------------------------------------------- */
/* The inputs: Zod-validated, and refused rather than silently inert           */
/* -------------------------------------------------------------------------- */

describe('coach preferences :: the repair input (plan §4)', () => {
  const inventory = [THURSDAY];

  it('refuses preferences with no coach rows, absent or empty: every one would be inert', () => {
    for (const rows of [{}, { teamCoachAssignments: [] }]) {
      expect(() =>
        repairPracticeLoss({
          plan: { slots: [], assignments: [], source: 'x' },
          graph: LOCATION_GRAPH,
          loss: { surfaceIds: [OP('field-2')], from: LOSS_DATE, reason: 'r' },
          inventory: [],
          coachPreferences: [pref('coach-1', 'weekday', 'must_keep')],
          ...rows,
        })
      ).toThrow(/teamCoachAssignments/);
    }
  });

  it('refuses a preference carrying free text, a duplicate, or a malformed row', () => {
    expect(() =>
      constructed({
        inventory,
        preferences: [{ ...pref('coach-1', 'weekday', 'must_keep'), note: 'x' }],
      })
    ).toThrow();
    expect(() =>
      constructed({
        inventory,
        preferences: [
          pref('coach-1', 'weekday', 'must_keep'),
          pref('coach-1', 'weekday', 'prefer_keep'),
        ],
      })
    ).toThrow(/one approved row/);
    expect(() =>
      constructed({
        inventory,
        preferences: [pref('coach-1', 'weekday', 'must_keep')],
        rows: [{ ...rowsFor(['coach-1'])[0], role: 'head' }],
      })
    ).toThrow();
    expect(
      PracticeRepairInputSchema.safeParse({
        plan: { slots: [], assignments: [], source: 'x' },
        graph: { surfaces: {} },
        loss: { surfaceIds: ['s'], from: LOSS_DATE, reason: 'r' },
        inventory: [],
        coachPreferences: [],
        teamCoachAssignments: ROSTER_ROWS,
      }).success
    ).toBe(true);
  });

  it('refuses a slug-venue graph even when nothing with a preference is displaced', () => {
    // The refusal reads the graph, not the displaced teams, so it cannot
    // depend on which loss happens to be repaired.
    expect(() =>
      repairPracticeLoss({
        plan: { slots: [], assignments: [], source: 'x' },
        graph,
        loss: { surfaceIds: [OP('field-2')], from: LOSS_DATE, reason: 'r' },
        inventory: [],
        coachPreferences: [pref('coach-1', 'weekday', 'prefer_keep')],
        teamCoachAssignments: rowsFor(['coach-1']),
      })
    ).toThrow(/not location ids|are not/);
  });

  it('refuses a graph whose venue is not a location id once a preference is in play', () => {
    // Venue = location (plan §5.2): comparing anything else would be a guess.
    expect(() =>
      corpusRepair(OP('field-2'), {
        extra: {
          coachPreferences: [pref(ROSTER_COACHES[0], 'weekday', 'prefer_keep')],
          teamCoachAssignments: ROSTER_ROWS.map((r) => ({ ...r, coach_id: ROSTER_COACHES[0] })),
        },
      })
    ).toThrow(/location id/);
  });
});
