/**
 * Phase 8.1: assistant coaches enter the auto-scheduler's conflict check.
 * Covers the hard-constraint seam the Edge Function seats teams through and the scoring
 * engine's conflict report; the serving module itself cannot be imported by a test.
 */
import { assertEquals, assertThrows } from 'https://deno.land/std@0.203.0/assert/mod.ts';
import {
  checkHardConstraints,
  conflictPairKey,
  listTeamCoachIds,
  prepareTeam,
  type PreparedTeam,
  type TimeWindow,
} from '../engines/practice-coaches.ts';
import { evaluatePracticeSchedule } from '../engines/scoring-engine.ts';
import {
  COACH_IDENTITY_PARITY_CASES,
  firstMirrorClashKeys,
} from '../../../../tests/fixtures/coachIdentityParityCases.js';
import { AutoSchedulerInputSchema } from '../schemas/auto-scheduler.ts';
import {
  type PracticeAssignment,
  ScoringInputSchema,
  type Slot,
  type Team,
  TeamSchema,
} from '../schemas/scoring.ts';

const hour = (h: number) => new Date(`2026-04-06T${String(h).padStart(2, '0')}:00:00Z`);
const slotAt = (id: string, startHour: number) => ({
  id,
  start: hour(startHour),
  end: hour(startHour + 1),
});
const early = slotAt('early', 17);
const overlap = slotAt('overlap', 17);
const late = slotAt('late', 19);

/** Book a team the way index.ts does: one window per coach on the team. */
function book(team: PreparedTeam, slot: { id: string; start: Date; end: Date }) {
  const coachAssignments = new Map<string, TimeWindow[]>();
  for (const coachId of team.coachIds) {
    coachAssignments.set(coachId, [{ teamId: team.id, slotId: slot.id, ...slot }]);
  }
  return coachAssignments;
}
const capacity = () =>
  new Map([
    ['early', 1],
    ['overlap', 1],
    ['late', 1],
  ]);

Deno.test('listTeamCoachIds - head plus assistants once each, empty ids dropped', () => {
  assertEquals(listTeamCoachIds({ id: 'T1', coachId: 'h1' }), ['h1']);
  assertEquals(listTeamCoachIds({ id: 'T1', coachId: null, assistantCoachIds: null }), []);
  assertEquals(
    listTeamCoachIds({ id: 'T1', coachId: 'h1', assistantCoachIds: ['a1', 'h1', '', 'a1'] }),
    ['h1', 'a1']
  );
});

Deno.test('listTeamCoachIds - reads the reconciled 8.2 `coaches` shape as well', () => {
  // The core helper became a call on people/coachList.js in 8.2, which reads
  // both shapes. A mirror that read only the legacy columns would leave a team
  // that arrives as `coaches` conflict-free here while the core engine sees
  // every one of its coaches — protected or not by spelling.
  assertEquals(listTeamCoachIds({ id: 'T1', coaches: [{ personId: 'c1', slot: 1 }] }), ['c1']);
  // Union, not replacement, and deduplicated across the two.
  assertEquals(
    listTeamCoachIds({
      id: 'T1',
      coachId: 'c1',
      assistantCoachIds: ['a1'],
      coaches: [
        { personId: 'c1', slot: 1 },
        { personId: 'c2', slot: 2 },
      ],
    }),
    ['c1', 'c2', 'a1']
  );
  // A malformed list is refused rather than read as "no coaches".
  assertThrows(
    () => listTeamCoachIds({ id: 'T1', coaches: 'nope' as unknown as [] }),
    TypeError,
    'team T1 coaches must be an array when provided'
  );
});

Deno.test('listTeamCoachIds - the identity rule, held to the same case table as the core', () => {
  // `tests/coachModel.test.js` asserts the core's `listTeamCoachIds()` against
  // this table; asserting the mirror against the same rows makes parity a
  // proven fact at every fallback branch rather than a claim in a comment.
  // The first mirror keyed a `coaches` entry by `displayName` where the core
  // keyed it by list index, and no test covered either branch.
  //
  // Meta-assertions: the table reaches every side of the rule, and it
  // discriminates — the first mirror's derivation fails it.
  const sides = new Set(COACH_IDENTITY_PARITY_CASES.map((c) => c.side.split(':')[0]));
  assertEquals([...sides].sort(), ['email', 'id', 'name', 'nobody', 'nothing']);
  const divergent = COACH_IDENTITY_PARITY_CASES.filter(
    (c) => [...firstMirrorClashKeys(c.team)].sort().join() !== [...c.clashKeys].sort().join()
  ).map((c) => c.label);
  assertEquals(divergent.includes('coaches[].displayName only'), true);

  for (const parityCase of COACH_IDENTITY_PARITY_CASES) {
    assertEquals(
      [...listTeamCoachIds(parityCase.team as Parameters<typeof listTeamCoachIds>[0])].sort(),
      [...parityCase.clashKeys].sort(),
      parityCase.label
    );
  }
});

Deno.test('checkHardConstraints - two name-only teams are never refused as one coach', () => {
  // Uncorroborated identity feeds no clash key here, as in the core: the
  // scheduler must not refuse a slot because two rows spell the same name.
  const named = (id: string, displayName: string) =>
    prepareTeam({ id, division: 'U10', coaches: [{ displayName, slot: 1 }] });
  const t1 = named('T1', 'Coach Mike');
  const t2 = named('T2', 'Coach Mike');
  assertEquals(t1.coachIds, []);
  assertEquals(checkHardConstraints(t2, overlap, book(t1, early), capacity(), {}), true);
  // POSITIVE CONTROL: the same two rows carrying one id are one person.
  const byId = (id: string) =>
    prepareTeam({ id, division: 'U10', coaches: [{ personId: 'mike', slot: 1 }] });
  assertEquals(
    checkHardConstraints(byId('T2'), overlap, book(byId('T1'), early), capacity(), {}),
    false
  );
});

Deno.test('prepareTeam - carries `coaches` through, so the evaluator can recompute from it', () => {
  const prepared = prepareTeam({
    id: 'T1',
    division: 'U10',
    coaches: [{ personId: 'c1', slot: 1 }],
  });
  assertEquals(prepared.coaches, [{ personId: 'c1', slot: 1 }]);
  assertEquals(prepared.coachIds, ['c1']);
});

Deno.test('listTeamCoachIds - reads the teams-column spelling assistant_coach_ids as well', () => {
  assertEquals(listTeamCoachIds({ id: 'T1', coachId: 'h1', assistant_coach_ids: ['a1'] }), [
    'h1',
    'a1',
  ]);
  // The engine spelling wins when both are present, as in the core helper.
  assertEquals(
    listTeamCoachIds({
      id: 'T1',
      coachId: null,
      assistantCoachIds: ['a1'],
      assistant_coach_ids: ['a2'],
    }),
    ['a1']
  );
});

Deno.test('listTeamCoachIds - a present non-array is rejected, never read as no assistants', () => {
  assertThrows(
    () =>
      listTeamCoachIds({ id: 'T1', coachId: 'h1', assistantCoachIds: 'a1' as unknown as string[] }),
    TypeError
  );
});

Deno.test('checkHardConstraints - two teams sharing an assistant cannot overlap', () => {
  const t1: PreparedTeam = { id: 'T1', coachId: 'h1', coachIds: ['h1', 'shared'] };
  const t2: PreparedTeam = { id: 'T2', coachId: 'h2', coachIds: ['h2', 'shared'] };
  const booked = book(t1, early);

  assertEquals(checkHardConstraints(t2, overlap, booked, capacity(), {}), false);
  assertEquals(checkHardConstraints(t2, late, booked, capacity(), {}), true);

  // Control: a distinct assistant fits the overlapping slot.
  const t3: PreparedTeam = { id: 'T3', coachId: 'h3', coachIds: ['h3', 'other'] };
  assertEquals(checkHardConstraints(t3, overlap, booked, capacity(), {}), true);
});

Deno.test(
  'checkHardConstraints - a team with no head coach is still checked via its assistant',
  () => {
    const t1: PreparedTeam = { id: 'T1', coachId: 'h1', coachIds: ['h1', 'shared'] };
    const t2: PreparedTeam = { id: 'T2', coachId: null, coachIds: ['shared'] };
    assertEquals(checkHardConstraints(t2, overlap, book(t1, early), capacity(), {}), false);
  }
);

Deno.test("checkHardConstraints - an assistant coach's unavailability blocks the slot", () => {
  const t2: PreparedTeam = { id: 'T2', coachId: null, coachIds: ['shared'] };
  const prefs = { shared: { unavailableSlotIds: ['late'] } };
  assertEquals(checkHardConstraints(t2, late, new Map(), capacity(), prefs), false);
  // Control: the same team on a slot the assistant is available for.
  assertEquals(checkHardConstraints(t2, early, new Map(), capacity(), prefs), true);
});

Deno.test(
  'TeamSchema - assistantCoachIds: null validates, and the team is scheduled on its head coach',
  () => {
    const parsed = TeamSchema.parse({
      id: 'T1',
      division: 'U10',
      coachId: 'h1',
      assistantCoachIds: null,
    });
    const prepared: PreparedTeam = { ...parsed, coachIds: listTeamCoachIds(parsed) };
    assertEquals(prepared.coachIds, ['h1']);
    assertEquals(checkHardConstraints(prepared, early, new Map(), capacity(), {}), true);
    // Control: the schema still rejects a non-array list.
    assertThrows(() =>
      TeamSchema.parse({ id: 'T1', division: 'U10', coachId: 'h1', assistantCoachIds: 'a1' })
    );
  }
);

Deno.test(
  'AutoSchedulerInputSchema - a request with assistantCoachIds: null validates and schedules',
  () => {
    const parsed = AutoSchedulerInputSchema.safeParse({
      organizationId: '11111111-1111-4111-8111-111111111111',
      teams: [{ id: 'T1', division: 'U10', coachId: 'h1', assistantCoachIds: null }],
      slots: [
        { id: 'early', start: '2026-04-06T17:00:00Z', end: '2026-04-06T18:00:00Z', capacity: 1 },
      ],
    });
    assertEquals(parsed.success, true, JSON.stringify(parsed.success ? null : parsed.error.issues));
    if (!parsed.success) return;
    // The same preparation index.ts performs, then the seat check the greedy pass runs.
    const prepared = parsed.data.teams.map((t) => ({ ...t, coachIds: listTeamCoachIds(t) }));
    assertEquals(prepared[0].coachIds, ['h1']);
    assertEquals(checkHardConstraints(prepared[0], early, new Map(), capacity(), {}), true);
    // Control: the request schema still rejects a non-array list.
    const rejected = AutoSchedulerInputSchema.safeParse({
      organizationId: '11111111-1111-4111-8111-111111111111',
      teams: [{ id: 'T1', division: 'U10', coachId: 'h1', assistantCoachIds: 'a1' }],
      slots: [
        { id: 'early', start: '2026-04-06T17:00:00Z', end: '2026-04-06T18:00:00Z', capacity: 1 },
      ],
    });
    assertEquals(rejected.success, false);
  }
);

// `day` is carried on the slot, as every production caller carries it:
// `PracticeSchedulingPage` normalises `practice_slots.day_of_week` and sends it.
// The engine reads `slot.day ?? 'unknown'` and derives nothing -- see the
// LIVE-7 cases at the bottom of this file for why deriving was the defect.
const scoringSlots: Slot[] = [
  {
    id: 'early',
    capacity: 1,
    day: 'Monday',
    start: '2026-04-06T17:00:00Z',
    end: '2026-04-06T18:00:00Z',
  },
  {
    id: 'overlap',
    capacity: 1,
    day: 'Monday',
    start: '2026-04-06T17:00:00Z',
    end: '2026-04-06T18:00:00Z',
  },
];
const scoringAssignments: PracticeAssignment[] = [
  { teamId: 'T1', slotId: 'early' },
  { teamId: 'T2', slotId: 'overlap' },
];
const conflictIssues = (result: ReturnType<typeof evaluatePracticeSchedule>) =>
  result.issues.filter((issue) => issue.category === 'coach-conflict');

Deno.test(
  'scoring-engine - a shared assistant overlap is reported once, naming the assistant',
  () => {
    // T2 has no head coach at all, so a head-only evaluator would never see it.
    const teams: Team[] = [
      { id: 'T1', division: 'U10', coachId: 'h1', assistantCoachIds: ['shared'] },
      { id: 'T2', division: 'U12', coachId: null, assistantCoachIds: ['shared'] },
    ];
    const result = evaluatePracticeSchedule({
      teams,
      slots: scoringSlots,
      assignments: scoringAssignments,
    });
    assertEquals(result.coachConflicts.length, 1);
    assertEquals(result.coachConflicts[0].coachId, 'shared');
    assertEquals(result.coachConflicts[0].coachIds, ['shared']);
    assertEquals(conflictIssues(result).length, 1);
  }
);

Deno.test(
  'scoring-engine - control: distinct assistants on overlapping slots raise no conflict',
  () => {
    const teams: Team[] = [
      { id: 'T1', division: 'U10', coachId: 'h1', assistantCoachIds: ['a1'] },
      { id: 'T2', division: 'U12', coachId: null, assistantCoachIds: ['a2'] },
    ];
    const result = evaluatePracticeSchedule({
      teams,
      slots: scoringSlots,
      assignments: scoringAssignments,
    });
    assertEquals(result.coachConflicts, []);
    assertEquals(conflictIssues(result).length, 0);
  }
);

Deno.test(
  'scoring-engine - a pair sharing head and assistant is one conflict and one issue naming both',
  () => {
    const teams: Team[] = [
      { id: 'T1', division: 'U10', coachId: 'h', assistantCoachIds: ['shared'] },
      { id: 'T2', division: 'U12', coachId: 'h', assistantCoachIds: ['shared'] },
    ];
    const result = evaluatePracticeSchedule({
      teams,
      slots: scoringSlots,
      assignments: scoringAssignments,
    });
    assertEquals(result.coachConflicts.length, 1);
    assertEquals(result.coachConflicts[0].coachIds, ['h', 'shared']);
    const issues = conflictIssues(result);
    assertEquals(issues.length, 1);
    assertEquals(issues[0].message, 'Coaches h, shared have overlapping practices on Monday');
    assertEquals(issues[0].details?.coachIds, ['h', 'shared']);
    // Control: a pair sharing one coach keeps the singular rendering.
    const single = evaluatePracticeSchedule({
      teams: [
        { id: 'T1', division: 'U10', coachId: 'h' },
        { id: 'T2', division: 'U12', coachId: 'h' },
      ],
      slots: scoringSlots,
      assignments: scoringAssignments,
    });
    assertEquals(conflictIssues(single)[0].message, 'Coach h has overlapping practices on Monday');
  }
);

Deno.test('scoring-engine - every overlapping pair is visited and merges across coaches', () => {
  // T1{h}, T2{h,s}, T3{h,s} all at the same hour: T2/T3 share both coaches, T1/T2 and T1/T3 only h.
  const teams: Team[] = [
    { id: 'T1', division: 'U10', coachId: 'h' },
    { id: 'T2', division: 'U10', coachId: 'h', assistantCoachIds: ['s'] },
    { id: 'T3', division: 'U10', coachId: 'h', assistantCoachIds: ['s'] },
  ];
  const slots: Slot[] = ['s1', 's2', 's3'].map((id) => ({
    id,
    capacity: 1,
    start: '2026-04-06T17:00:00Z',
    end: '2026-04-06T18:00:00Z',
  }));
  const assignments: PracticeAssignment[] = [
    { teamId: 'T1', slotId: 's1' },
    { teamId: 'T2', slotId: 's2' },
    { teamId: 'T3', slotId: 's3' },
  ];
  const result = evaluatePracticeSchedule({ teams, slots, assignments });
  const pairs = result.coachConflicts.map((c) => [
    c.teams
      .map((t) => t.teamId)
      .sort()
      .join('/'),
    c.coachIds,
  ]);
  assertEquals(pairs.length, 3);
  assertEquals(pairs.find(([pair]) => pair === 'T2/T3')?.[1], ['h', 's']);
  assertEquals(pairs.find(([pair]) => pair === 'T1/T2')?.[1], ['h']);
  assertEquals(pairs.find(([pair]) => pair === 'T1/T3')?.[1], ['h']);
  assertEquals(conflictIssues(result).length, 3);
});

Deno.test(
  'scoring-engine - a row carrying only assistant_coach_ids is conflict-checked on its assistant',
  () => {
    const teams: Team[] = [
      { id: 'T1', division: 'U10', coachId: 'h1', assistant_coach_ids: ['shared'] },
      { id: 'T2', division: 'U12', coachId: null, assistant_coach_ids: ['shared'] },
    ];
    const result = evaluatePracticeSchedule({
      teams,
      slots: scoringSlots,
      assignments: scoringAssignments,
    });
    assertEquals(result.coachConflicts.length, 1);
    assertEquals(result.coachConflicts[0].coachIds, ['shared']);
  }
);

Deno.test(
  'fairness-scoring - a request-supplied coachIds key cannot suppress a real conflict',
  () => {
    // The whole request path: TeamSchema is passthrough, so `coachIds: []` survives validation
    // and reaches the evaluator exactly as fairness-scoring/index.ts hands it over. The evaluator
    // must recompute from the validated coach fields rather than honour the request's key.
    // (The app's own caller sends no teams at all today — see the PR's raised-not-fixed list.)
    const parsed = ScoringInputSchema.safeParse({
      organizationId: '11111111-1111-4111-8111-111111111111',
      practice: {
        teams: [
          { id: 'T1', division: 'U10', coachId: 'h', assistantCoachIds: ['shared'], coachIds: [] },
          { id: 'T2', division: 'U12', coachId: 'h', assistantCoachIds: ['shared'], coachIds: [] },
        ],
        slots: scoringSlots,
        assignments: scoringAssignments,
      },
      games: null,
    });
    assertEquals(parsed.success, true, JSON.stringify(parsed.success ? null : parsed.error.issues));
    if (!parsed.success || !parsed.data.practice) return;
    // The key really did survive validation — otherwise this test could not detect honouring it.
    assertEquals((parsed.data.practice.teams[0] as { coachIds?: unknown }).coachIds, []);
    const result = evaluatePracticeSchedule({
      teams: parsed.data.practice.teams,
      slots: parsed.data.practice.slots,
      assignments: parsed.data.practice.assignments,
    });
    assertEquals(result.coachConflicts.length, 1);
    assertEquals(result.coachConflicts[0].coachIds, ['h', 'shared']);
    // And the score the function publishes reflects the conflict rather than a clean sheet.
    assertEquals(result.summary.fairnessScore < 1, true);
  }
);

Deno.test('prepareTeam - the projection index.ts seats teams through keeps every coach', () => {
  // index.ts narrows each request team before the optimiser and the evaluator see it. The
  // evaluator recomputes from `assistantCoachIds`, so the projection has to carry it across —
  // including from the snake spelling, which is the only one this row has.
  const raw = { id: 'T1', division: 'U10', coachId: 'h', assistant_coach_ids: ['shared'] };
  const prepared = prepareTeam(raw);
  assertEquals(prepared.coachIds, ['h', 'shared']);
  assertEquals(prepared.assistantCoachIds, ['shared']);
  assertEquals(listTeamCoachIds(prepared), prepared.coachIds);

  // Positive control: the projection that drops the assistant list still reports the right
  // `coachIds`, and yet narrows the evaluator's recomputed set back to the head coach.
  const dropped = {
    id: raw.id,
    division: raw.division,
    coachId: raw.coachId,
    coachIds: ['h', 'shared'],
  };
  assertEquals(listTeamCoachIds(dropped), ['h']);

  // Through the evaluator: two teams sharing only the assistant.
  const teams = [
    prepareTeam({ id: 'T1', division: 'U10', coachId: 'h1', assistant_coach_ids: ['shared'] }),
    prepareTeam({ id: 'T2', division: 'U12', coachId: null, assistant_coach_ids: ['shared'] }),
  ] as unknown as Team[];
  const result = evaluatePracticeSchedule({
    teams,
    slots: scoringSlots,
    assignments: scoringAssignments,
  });
  assertEquals(result.coachConflicts.length, 1);
  assertEquals(result.coachConflicts[0].coachIds, ['shared']);
});

Deno.test('schemas - assistant_coach_ids is validated, not passed through', () => {
  const request = (assistant_coach_ids: unknown) => ({
    organizationId: '11111111-1111-4111-8111-111111111111',
    teams: [{ id: 'T1', division: 'U10', coachId: 'h1', assistant_coach_ids }],
    slots: [
      { id: 'early', start: '2026-04-06T17:00:00Z', end: '2026-04-06T18:00:00Z', capacity: 1 },
    ],
  });
  assertEquals(AutoSchedulerInputSchema.safeParse(request('a1')).success, false);
  assertEquals(AutoSchedulerInputSchema.safeParse(request([123])).success, false);
  assertEquals(
    TeamSchema.safeParse({ id: 'T1', division: 'U10', assistant_coach_ids: 'a1' }).success,
    false
  );
  // The fairness-scoring request composes the same TeamSchema, so its gate closes too.
  const scoringRequest = (assistant_coach_ids: unknown) => ({
    organizationId: '11111111-1111-4111-8111-111111111111',
    practice: {
      teams: [{ id: 'T1', division: 'U10', coachId: 'h1', assistant_coach_ids }],
      slots: scoringSlots,
      assignments: [{ teamId: 'T1', slotId: 'early' }],
    },
    games: null,
  });
  assertEquals(ScoringInputSchema.safeParse(scoringRequest('a1')).success, false);
  assertEquals(ScoringInputSchema.safeParse(scoringRequest([123])).success, false);
  // Controls: the valid shapes still pass.
  assertEquals(AutoSchedulerInputSchema.safeParse(request(['a1'])).success, true);
  assertEquals(AutoSchedulerInputSchema.safeParse(request(null)).success, true);
  assertEquals(ScoringInputSchema.safeParse(scoringRequest(['a1'])).success, true);
  assertEquals(ScoringInputSchema.safeParse(scoringRequest(null)).success, true);
});

Deno.test('conflictPairKey - the same key whichever side is named first', () => {
  const x = { teamId: 'T2', slotId: 's2' };
  const y = { teamId: 'T1', slotId: 's1' };
  assertEquals(conflictPairKey(x, y), conflictPairKey(y, x));
  // Positive control: the un-canonicalised form this replaces does depend on the order, so
  // the assertion above fails against it (proven by substituting it into the source).
  const raw = (p: typeof x, q: typeof x) => `${p.teamId}::${p.slotId}::${q.teamId}::${q.slotId}`;
  assertEquals(raw(x, y) === raw(y, x), false);
  // Regression guard, not a discriminating control: every coach's list is a subsequence of the
  // same assignment order and is sorted by the same comparator, so today both key forms merge
  // this pair. The guard is structural — it holds the merge correct if that ever stops being so.
  const teams: Team[] = [
    { id: 'T1', division: 'U10', coachId: 'h', assistantCoachIds: ['shared'] },
    { id: 'T2', division: 'U12', coachId: 'h', assistantCoachIds: ['shared'] },
  ];
  for (const assignments of [scoringAssignments, [...scoringAssignments].reverse()]) {
    const result = evaluatePracticeSchedule({ teams, slots: scoringSlots, assignments });
    assertEquals(result.coachConflicts.length, 1);
    assertEquals(result.coachConflicts[0].coachIds, ['h', 'shared']);
  }
});

// ---------------------------------------------------------------------------
// LIVE-7: the weekday the engine used to derive from a host-zone reading
// ---------------------------------------------------------------------------

Deno.test('scoring-engine - LIVE-7: the weekday is never derived from the host zone', () => {
  // The defect: `slot.day || start.toLocaleDateString('en-US', {weekday:'long'})`
  // reads the HOST's zone. These slots are a 9pm SATURDAY practice in
  // America/New_York; on a UTC host -- the Supabase edge default -- that
  // instant reads back as SUNDAY.
  //
  // The slots deliberately carry **no `day`**, because that is the only input
  // on which the old expression and the new one differ: `||` short-circuits
  // whenever a day is present, so a fixture that supplies one cannot fail on
  // `main` no matter what it asserts. This one can, and does, under TZ=UTC.
  const saturdayNightInNewYork = '2026-04-05T01:00:00Z'; // Sat 2026-04-04 21:00 EDT
  const hostDerived = new Date(saturdayNightInNewYork).toLocaleDateString('en-US', {
    weekday: 'long',
  });
  const hostZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  console.log(`[LIVE-7] host ${hostZone} derives "${hostDerived}" for a Saturday NY practice`);

  const slots: Slot[] = [
    { id: 'a', capacity: 1, start: saturdayNightInNewYork, end: '2026-04-05T02:30:00Z' },
    { id: 'b', capacity: 1, start: saturdayNightInNewYork, end: '2026-04-05T02:30:00Z' },
  ];
  const teams: Team[] = [
    { id: 'T1', division: 'U10', coachId: 'h' },
    { id: 'T2', division: 'U12', coachId: 'h' },
  ];
  const assignments: PracticeAssignment[] = [
    { teamId: 'T1', slotId: 'a' },
    { teamId: 'T2', slotId: 'b' },
  ];
  const result = evaluatePracticeSchedule({ teams, slots, assignments });

  assertEquals(conflictIssues(result).length, 1);
  // No day was supplied, so none is invented -- not the host's reading, and
  // not a corrected one either, which would be a fourth contract for one
  // field. `packages/core/src/practiceMetrics.js:582` says `?? 'unknown'`.
  assertEquals(result.coachConflicts[0].day, 'unknown');
  assertEquals(conflictIssues(result)[0].message, 'Coach h has overlapping practices on unknown');
  // Named explicitly: "Sunday" is the string `main` produced on a UTC host,
  // and "Saturday" is what it produced in a US zone -- which is why nobody in
  // a US zone ever saw the defect.
  assertEquals(conflictIssues(result)[0].message.includes('Sunday'), false);
  assertEquals(conflictIssues(result)[0].message.includes('Saturday'), false);
});

Deno.test("scoring-engine - the caller's day is honoured when it sends one", () => {
  // The other half of the contract, and deliberately NOT a regression test:
  // `||` and `??` agree whenever a day is present, so this case passes on
  // `main` too. It pins the behaviour every production caller relies on --
  // `PracticeSchedulingPage` normalises `day_of_week` and sends it -- so that
  // a later "simplification" to always derive has something to break.
  const slots: Slot[] = [
    { id: 'a', capacity: 1, start: '2026-04-06T17:00:00Z', end: '2026-04-06T18:00:00Z' },
    { id: 'b', capacity: 1, start: '2026-04-06T17:00:00Z', end: '2026-04-06T18:00:00Z' },
  ];
  const assignments: PracticeAssignment[] = [
    { teamId: 'T1', slotId: 'a' },
    { teamId: 'T2', slotId: 'b' },
  ];
  const teams: Team[] = [
    { id: 'T1', division: 'U10', coachId: 'h' },
    { id: 'T2', division: 'U12', coachId: 'h' },
  ];
  const result = evaluatePracticeSchedule({ teams, slots, assignments });
  assertEquals(conflictIssues(result)[0].message, 'Coach h has overlapping practices on unknown');

  // Control: the same pair WITH a day renders that day, so 'unknown' is the
  // absence of a value and not a hardcoded string.
  const withDay = evaluatePracticeSchedule({
    teams,
    slots: slots.map((s) => ({ ...s, day: 'Thursday' })),
    assignments,
  });
  assertEquals(conflictIssues(withDay)[0].message, 'Coach h has overlapping practices on Thursday');
});
