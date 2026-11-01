/**
 * Phase D PR D (plan `docs/changes/2026-10-27-phase-d-scheduling.md`, D1): the Deno half of the
 * server's check of a schedule found in the browser -- `auto-scheduler`'s `verify` mode -- and of
 * the solver input `prepare` hands the browser.
 *
 * `tests/autoSchedulerVerify.test.js` (Vitest, zod 4) runs the same fixture; this runs the engines
 * under Deno with the import map's zod 3, the runtime the Edge Function ships on. The serving
 * module cannot be imported (it serves at load), so what is held here is the decision it makes:
 * `verifyPracticePlacements` for the rules, `checkSolverInputDigest` for the 409 `INPUT_CHANGED`,
 * and the request schemas for what a body may and may not bring.
 *
 * Every expected refusal is worked out from the fixture's structure, never from `verify`'s output.
 */
import { assert, assertEquals, assertNotEquals } from 'https://deno.land/std@0.203.0/assert/mod.ts';
import {
  VERIFY_REFUSED_REASON,
  practiceUnitsFor,
  runPracticeOptimizer,
  unitIdOf,
  verifyPracticePlacements,
  type PracticeSolverInput,
  type ProposedPlacement,
} from '../engines/auto-scheduler-solver.ts';
import {
  INPUT_CHANGED,
  checkSolverInputDigest,
  digestEncodedInput,
  encodeSolverInput,
  reviveSolverInput,
} from '../engines/solver-input.ts';
import { prepareTeam } from '../engines/practice-coaches.ts';
import { toDaylightSlot } from '../engines/practice-daylight.ts';
import { AutoSchedulerInputSchema, AutoSchedulerVerifySchema } from '../schemas/auto-scheduler.ts';
import {
  LEAGUE_CONFIG,
  practiceOptimizerLeague,
} from '../../../../tests/fixtures/practiceOptimizerLeague.js';

const league = (): PracticeSolverInput => practiceOptimizerLeague({ toDaylightSlot, prepareTeam });
const SCOPE = {
  organizationId: '00000000-0000-4000-8000-000000000001',
  seasonSettingsId: '00000000-0000-4000-8000-000000000002',
};

const search = (input: PracticeSolverInput = league()) =>
  runPracticeOptimizer({ ...input, config: LEAGUE_CONFIG, cpuCapMs: Infinity });
const verify = (placements: ProposedPlacement[], input: PracticeSolverInput = league()) =>
  verifyPracticePlacements({ ...input, placements });
const unitIds = (input: PracticeSolverInput) =>
  practiceUnitsFor(input.placeableTeamIds, input.unitsNeeded).map((u) => u.unitId);
const byUnit = <T extends { teamId: string; unitId?: string }>(list: T[]) =>
  [...list].sort((a, b) => unitIdOf(a).localeCompare(unitIdOf(b)));

Deno.test(
  'verify accepts what the search found: same placements, ranges, score and unplaced',
  async () => {
    const run = await search();
    const verified = verify(
      run.placements.map((p) => ({
        teamId: p.teamId,
        slotId: p.slotId,
        ...(p.unitId ? { unitId: p.unitId } : {}),
      }))
    );
    assertEquals(byUnit(verified.placements), byUnit(run.placements));
    assertEquals(verified.placementRanges, run.placementRanges);
    assertEquals(verified.bestScore, run.bestScore);
    assertEquals(verified.preferKeepBreaches, run.preferKeepBreaches);
    assertEquals(verified.refused, []);
    assert(run.daylight!.pastSunset.length > 0, 'the fixture must exercise the daylight pass');
    assertEquals(verified.daylight!.meta, run.daylight!.meta);
    const key = (u: { teamId: string; unitId?: string; reason: string }) =>
      `${unitIdOf(u)}:${u.reason}`;
    assertEquals(verified.unassigned.map(key).sort(), run.unassigned.map(key).sort());
    // None dropped: every practice of the roster is placed or unplaced, once.
    assertEquals(
      [...verified.placements.map(unitIdOf), ...verified.unassigned.map(unitIdOf)].sort(),
      unitIds(league()).sort()
    );
  }
);

Deno.test(
  'verify refuses a placement over capacity, naming the rule, and keeps its practice TIME TBD',
  () => {
    const verified = verify([
      { teamId: 't2', unitId: 't2#1', slotId: 'fa-tue-17' },
      { teamId: 't1', unitId: 't1#1', slotId: 'fa-tue-17' },
    ]);
    assertEquals(
      verified.refused.map((r) => [unitIdOf(r), r.rule]),
      [['t2#1', 'capacity']]
    );
    const unplaced = verified.unassigned.find((u) => unitIdOf(u) === 't2#1')!;
    assertEquals(unplaced.reason, VERIFY_REFUSED_REASON);
    assertEquals(unplaced.rule, 'capacity');
    assertEquals(verified.placements.map(unitIdOf), ['t1#1']);
  }
);

Deno.test('verify refuses a coach in two places at once, and a must_keep breach', () => {
  const clash = verify([
    { teamId: 't0', slotId: 'fb-wed-17' },
    { teamId: 't6', unitId: 't6#1', slotId: 'fa-wed-17' },
  ]);
  assertEquals(
    clash.refused.map((r) => [unitIdOf(r), r.rule]),
    [['t6#1', 'coach-conflict']]
  );
  const must = verify([{ teamId: 't3', unitId: 't3#1', slotId: 'fb-mon-17' }]);
  assertEquals(
    must.refused.map((r) => [unitIdOf(r), r.rule]),
    [['t3#1', 'must-keep']]
  );
});

Deno.test(
  'verify refuses the wrong length, a reserved slot, and a second practice on one weekday',
  () => {
    const rules = (placements: ProposedPlacement[]) =>
      verify(placements).refused.map((r) => [unitIdOf(r), r.rule]);
    assertEquals(rules([{ teamId: 't4', unitId: 't4#1', slotId: 'fb-thu-19-short' }]), [
      ['t4#1', 'length'],
    ]);
    assertEquals(rules([{ teamId: 't5', unitId: 't5#1', slotId: 'fa-mon-16' }]), [
      ['t5#1', 'reservation'],
    ]);
    assertEquals(
      rules([
        { teamId: 't8', unitId: 't8#1', slotId: 'fb-tue-17' },
        { teamId: 't8', unitId: 't8#2', slotId: 'fa-tue-18' },
      ]),
      [['t8#2', 'weekday']]
    );
  }
);

Deno.test('verify answers the same whatever order the placements arrive in', async () => {
  const run = await search();
  const forward = run.placements.map((p) => ({
    teamId: p.teamId,
    slotId: p.slotId,
    ...(p.unitId ? { unitId: p.unitId } : {}),
  }));
  const a = verify(forward);
  const b = verify([...forward].reverse());
  assertEquals(b.placements, a.placements);
  assertEquals(b.bestScore, a.bestScore);
});

Deno.test(
  'the input the browser is handed searches to the same answer, and verify accepts it',
  async () => {
    const direct = await search();
    const wire = JSON.parse(JSON.stringify(encodeSolverInput(league(), SCOPE)));
    const revived = reviveSolverInput(wire);
    const viaWire = await search(revived);
    assertEquals(viaWire.placements, direct.placements);
    assertEquals(viaWire.bestScore, direct.bestScore);
    assertEquals(viaWire.unassigned, direct.unassigned);
    assertEquals(
      verify(
        viaWire.placements.map((p) => ({
          teamId: p.teamId,
          slotId: p.slotId,
          ...(p.unitId ? { unitId: p.unitId } : {}),
        })),
        revived
      ).refused,
      []
    );
  }
);

Deno.test(
  'verify refuses 409 INPUT_CHANGED when the server now holds different inputs',
  async () => {
    const held = await digestEncodedInput(encodeSolverInput(league(), SCOPE));
    const reload = league();
    reload.locked.push({
      assignmentId: 'row-t5',
      teamId: 't5',
      slotId: 'fb-mon-18',
      effectiveDateRange: '[2026-10-19,2026-11-20]',
    });
    const refused = await checkSolverInputDigest(encodeSolverInput(reload, SCOPE), held);
    assertEquals(refused.ok, false);
    if (!refused.ok) assertEquals(refused.code, INPUT_CHANGED);
    assertNotEquals(refused.digest, held);
    const accepted = await checkSolverInputDigest(encodeSolverInput(league(), SCOPE), held);
    assertEquals(accepted.ok, true);
  }
);

Deno.test(
  'a tampered copy cannot be vouched for: the server compares with its own reload',
  async () => {
    // The worker was given an input without the must_keep, and the body claims that copy's digest.
    const tampered = league();
    tampered.preferenceGate = { verdicts: new Map() };
    const claimed = await digestEncodedInput(encodeSolverInput(tampered, SCOPE));
    const verdict = await checkSolverInputDigest(encodeSolverInput(league(), SCOPE), claimed);
    assertEquals(verdict.ok, false);
  }
);

Deno.test('a verify body keeps its claims and drops every input it tries to bring', () => {
  const parsed = AutoSchedulerVerifySchema.parse({
    digest: 'a'.repeat(64),
    placements: [{ teamId: 't0', slotId: 's0', source: 'manual' }],
    browserRun: {
      seedScore: 0.5,
      iterations: 10,
      restarts: 0,
      elapsedMs: 12,
      terminationReason: 'max-iterations',
    },
    locked: [{ teamId: 't0', slotId: 's0' }],
    preferenceGate: { verdicts: {} },
    practicesPerWeek: 7,
  });
  assertEquals(Object.keys(parsed).sort(), ['browserRun', 'digest', 'placements']);
  assertEquals(parsed.placements, [{ teamId: 't0', slotId: 's0' }]);
  // A body that names no mode is a solve.
  assertEquals(
    AutoSchedulerInputSchema.parse({
      organizationId: SCOPE.organizationId,
      teams: [{ id: 't0', division: 'd1' }],
      slots: [
        {
          id: 's0',
          start: '2026-10-20T16:00:00-04:00',
          end: '2026-10-20T17:00:00-04:00',
          capacity: 1,
        },
      ],
    }).mode,
    'solve'
  );
  assertEquals(
    AutoSchedulerInputSchema.safeParse({
      mode: 'optimize',
      organizationId: SCOPE.organizationId,
      teams: [{ id: 't0', division: 'd1' }],
      slots: [
        {
          id: 's0',
          start: '2026-10-20T16:00:00-04:00',
          end: '2026-10-20T17:00:00-04:00',
          capacity: 1,
        },
      ],
    }).success,
    false
  );
});
