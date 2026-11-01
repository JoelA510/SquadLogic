// @vitest-environment node
/**
 * Phase D PR D (plan `docs/changes/2026-10-27-phase-d-scheduling.md`, section D): the server's
 * check of a schedule the browser found -- `auto-scheduler`'s `verify` mode -- and the bytes the
 * browser is handed to search -- its `prepare` mode.
 *
 * These execute the Edge Function's own modules (`verifyPracticePlacements`, `solver-input.ts`,
 * the request schemas) over `tests/fixtures/practiceOptimizerLeague.js`, and pin how
 * `auto-scheduler/index.ts` wires them, since the serving module cannot be imported. The Deno half
 * is `supabase/functions/_shared/tests/auto-scheduler-verify_test.ts`.
 *
 * **Independence.** Every expected refusal is worked out from the fixture's own structure (which
 * slot is reserved, which coach has two teams, which weekday a team already uses), never from
 * `verify`'s output; the subject set of the "never dropped" check is the roster's practice units
 * (`practiceUnitsFor`), not the placements or the refusals.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'vitest';

import {
  VERIFY_REFUSAL_RULE,
  VERIFY_REFUSED_REASON,
  practiceUnitsFor,
  runPracticeOptimizer,
  unitIdOf,
  verifyPracticePlacements,
} from '../supabase/functions/_shared/engines/auto-scheduler-solver.js';
import {
  INPUT_CHANGED,
  checkSolverInputDigest,
  digestEncodedInput,
  encodeSolverInput,
  reviveSolverInput,
} from '../supabase/functions/_shared/engines/solver-input.js';
import { prepareTeam } from '../supabase/functions/_shared/engines/practice-coaches.js';
import { toDaylightSlot } from '../supabase/functions/_shared/engines/practice-daylight.js';
import {
  AutoSchedulerInputSchema,
  AutoSchedulerVerifySchema,
} from '../supabase/functions/_shared/schemas/auto-scheduler.js';
import { LEAGUE_CONFIG, practiceOptimizerLeague } from './fixtures/practiceOptimizerLeague.js';

const league = () => practiceOptimizerLeague({ toDaylightSlot, prepareTeam });
const SCOPE = {
  organizationId: '00000000-0000-4000-8000-000000000001',
  seasonSettingsId: '00000000-0000-4000-8000-000000000002',
};

/** The search with the server's cap off, as the worker runs it. */
const search = (input = league()) =>
  runPracticeOptimizer({ ...input, config: LEAGUE_CONFIG, cpuCapMs: Infinity });

const unitIds = (input) =>
  practiceUnitsFor(input.placeableTeamIds, input.unitsNeeded).map((u) => u.unitId);
const proposal = (run) =>
  run.placements.map((p) => ({
    teamId: p.teamId,
    slotId: p.slotId,
    ...(p.unitId ? { unitId: p.unitId } : {}),
  }));
const byUnit = (list) => [...list].sort((a, b) => unitIdOf(a).localeCompare(unitIdOf(b)));
/** A `verify` over the fixture of exactly these proposed placements. */
const verify = (placements, input = league()) => verifyPracticePlacements({ ...input, placements });

describe('the fixture is a league worth verifying', () => {
  it('the search places most practices, leaves some unplaced, and flags one past sunset', async () => {
    const run = await search();
    const total = unitIds(league()).length;
    assert.equal(
      total,
      12 * 2 - 1 + 6,
      't0 holds one of its two, every other team needs its count'
    );
    assert.ok(
      run.placements.length >= total - 8 && run.placements.length < total,
      'tuned too tight or too loose'
    );
    assert.ok(run.unassigned.length >= 1, 'd2 has six teams for five reserved slots');
    assert.ok(run.daylight.pastSunset.length >= 1, 'an unlit 18:00 slot ends after sunset');
  });
});

describe('verify accepts what the search found, and answers as the search does', () => {
  it('same placements, ranges, score, breaches, daylight and unplaced practices', async () => {
    const run = await search();
    const verified = verify(proposal(run));
    assert.deepEqual(byUnit(verified.placements), byUnit(run.placements));
    assert.deepEqual(verified.placementRanges, run.placementRanges);
    assert.equal(verified.bestScore, run.bestScore);
    assert.equal(verified.preferKeepBreaches, run.preferKeepBreaches);
    // The daylight report lists placements in the order it was handed them (the search's order,
    // which is the greedy seed's or sorted by unit); the report is the same set of findings.
    const report = (daylight) => ({
      ...daylight,
      pastSunset: byUnit(daylight.pastSunset),
    });
    assert.deepEqual(report(verified.daylight), report(run.daylight));
    assert.ok(verified.daylight.pastSunset.length > 0, 'the report must have something to compare');
    assert.deepEqual(verified.refused, []);
    assert.equal(verified.liveFrom, run.liveFrom);
    assert.deepEqual(
      verified.lockedOutsideRun.map((r) => r.assignmentId),
      run.lockedOutsideRun.map((r) => r.assignmentId)
    );
    // The unplaced practices are the same practices for the same reasons.
    const key = (u) => `${unitIdOf(u)}:${u.reason}`;
    assert.deepEqual(verified.unassigned.map(key).sort(), run.unassigned.map(key).sort());
    // The evaluation is the schedule's: the same counts and conflicts.
    assert.deepEqual(verified.evaluation.summary, run.evaluation.summary);
    assert.deepEqual(verified.evaluation.coachConflicts, run.evaluation.coachConflicts);
  });

  it('whatever order the placements arrive in', async () => {
    const run = await search();
    const forward = proposal(run);
    const a = verify(forward);
    const b = verify([...forward].reverse());
    assert.deepEqual(b.placements, a.placements);
    assert.equal(b.bestScore, a.bestScore);
    assert.deepEqual(b.refused, []);
  });

  it('every practice is placed or unplaced, once: none is dropped', async () => {
    const run = await search();
    const verified = verify(proposal(run));
    const placed = verified.placements.map(unitIdOf);
    const unplaced = verified.unassigned.map(unitIdOf);
    assert.deepEqual([...placed, ...unplaced].sort(), unitIds(league()).sort());
    assert.equal(new Set([...placed, ...unplaced]).size, placed.length + unplaced.length);
  });

  it('a proposal that leaves practices out does not make them disappear', () => {
    const verified = verify([]);
    assert.equal(verified.placements.length, 0);
    assert.deepEqual(verified.unassigned.map(unitIdOf).sort(), unitIds(league()).sort());
    assert.ok(verified.unassigned.every((u) => u.reason !== VERIFY_REFUSED_REASON));
  });
});

describe('verify refuses a placement that breaks a rule, and keeps its practice as TIME TBD', () => {
  /** Verify `placements` and return the refusals by unit, with the practice's unplaced entry. */
  function refusals(placements) {
    const verified = verify(placements);
    const refused = Object.fromEntries(verified.refused.map((r) => [unitIdOf(r), r.rule]));
    const unplaced = Object.fromEntries(verified.unassigned.map((u) => [unitIdOf(u), u]));
    return { verified, refused, unplaced };
  }

  it('a slot over capacity', () => {
    // fa-tue-17 holds one team; t1#1 is first in sorted order, so t2#1 is the one refused.
    const { verified, refused, unplaced } = refusals([
      { teamId: 't2', unitId: 't2#1', slotId: 'fa-tue-17' },
      { teamId: 't1', unitId: 't1#1', slotId: 'fa-tue-17' },
    ]);
    assert.deepEqual(refused, { 't2#1': VERIFY_REFUSAL_RULE.CAPACITY });
    assert.equal(unplaced['t2#1'].reason, VERIFY_REFUSED_REASON);
    assert.equal(unplaced['t2#1'].rule, 'capacity');
    assert.deepEqual(verified.placements.map(unitIdOf), ['t1#1']);
  });

  it('a coach in two places at one time', () => {
    // c0 coaches t0 and t6. t0 (one practice to place: unit id "t0") sorts before t6#1.
    const { refused } = refusals([
      { teamId: 't0', slotId: 'fb-wed-17' },
      { teamId: 't6', unitId: 't6#1', slotId: 'fa-wed-17' },
    ]);
    assert.deepEqual(refused, { 't6#1': VERIFY_REFUSAL_RULE.COACH_CONFLICT });
  });

  it('an approved coach must-keep', () => {
    const { refused } = refusals([{ teamId: 't3', unitId: 't3#1', slotId: 'fb-mon-17' }]);
    assert.deepEqual(refused, { 't3#1': VERIFY_REFUSAL_RULE.MUST_KEEP });
  });

  it("a slot that is not the division's practice length", () => {
    const { refused } = refusals([{ teamId: 't4', unitId: 't4#1', slotId: 'fb-thu-19-short' }]);
    assert.deepEqual(refused, { 't4#1': VERIFY_REFUSAL_RULE.LENGTH });
  });

  it("another division's reserved slot", () => {
    const { refused } = refusals([{ teamId: 't5', unitId: 't5#1', slotId: 'fa-mon-16' }]);
    assert.deepEqual(refused, { 't5#1': VERIFY_REFUSAL_RULE.RESERVATION });
  });

  it('two practices of one team on one weekday', () => {
    const { refused } = refusals([
      { teamId: 't8', unitId: 't8#1', slotId: 'fb-tue-17' },
      { teamId: 't8', unitId: 't8#2', slotId: 'fa-tue-18' },
    ]);
    assert.deepEqual(refused, { 't8#2': VERIFY_REFUSAL_RULE.WEEKDAY });
  });

  it('a team that already holds a practice that weekday', () => {
    // t0's saved practice is Tuesday 16:00: its one more may not be a Tuesday.
    const { refused } = refusals([{ teamId: 't0', slotId: 'fa-tue-17' }]);
    assert.deepEqual(refused, { t0: VERIFY_REFUSAL_RULE.WEEKDAY });
  });

  it('a malformed proposal is reported, and costs no practice', () => {
    const { verified, refused } = refusals([
      { teamId: 'nobody', slotId: 'fb-mon-17' },
      { teamId: 't9', unitId: 't9#1', slotId: 'no-such-slot' },
      { teamId: 't10', unitId: 't10#1', slotId: 'fb-wed-16' },
      { teamId: 't10', unitId: 't10#1', slotId: 'fb-thu-16' },
      // t0 needs one practice, so there is no t0#2.
      { teamId: 't0', unitId: 't0#2', slotId: 'fb-fri-16' },
    ]);
    const rules = verified.refused.map((r) => `${r.teamId}/${r.unitId ?? ''}:${r.rule}`).sort();
    assert.deepEqual(
      rules,
      [
        't0/t0#2:unknown-practice',
        't10/t10#1:duplicate-practice',
        't9/t9#1:unknown-slot',
        'nobody/:unknown-practice',
      ].sort()
    );
    // A practice given two slots keeps the first in sorted order (fb-thu-16 < fb-wed-16); t9#1 is
    // TIME TBD with the refusal; "nobody" has no practice to leave unplaced.
    assert.ok(verified.placements.some((p) => unitIdOf(p) === 't10#1' && p.slotId === 'fb-thu-16'));
    assert.equal(refused['t9#1'], 'unknown-slot');
    assert.ok(!('nobody' in Object.fromEntries(verified.unassigned.map((u) => [u.teamId, 1]))));
    assert.deepEqual(
      [...verified.placements.map(unitIdOf), ...verified.unassigned.map(unitIdOf)].sort(),
      unitIds(league()).sort()
    );
  });

  it('a refused placement is scored as unplaced, not as placed', async () => {
    const run = await search();
    const good = proposal(run);
    const clash = good.find((p) => p.teamId === 't1');
    const bad = [...good.filter((p) => p !== clash), { ...clash, slotId: 'fa-mon-16' }];
    const verified = verify(bad);
    assert.ok(verified.bestScore < run.bestScore, 'a refusal must cost the schedule its score');
    assert.equal(verified.refused.length, 1);
    assert.equal(verified.refused[0].rule, 'reservation');
  });
});

describe('the request: a mode, and claims that are checked rather than read', () => {
  const base = {
    organizationId: SCOPE.organizationId,
    seasonSettingsId: SCOPE.seasonSettingsId,
    teams: [{ id: 't0', division: 'd1' }],
    slots: [
      {
        id: 's0',
        start: '2026-10-20T16:00:00-04:00',
        end: '2026-10-20T17:00:00-04:00',
        capacity: 1,
      },
    ],
  };

  it('a body with no mode is a solve; an unknown mode is refused', () => {
    assert.equal(AutoSchedulerInputSchema.parse(base).mode, 'solve');
    assert.equal(AutoSchedulerInputSchema.parse({ ...base, mode: 'prepare' }).mode, 'prepare');
    assert.equal(AutoSchedulerInputSchema.safeParse({ ...base, mode: 'optimize' }).success, false);
  });

  it('a verify body keeps its placements and digest and drops every input it tries to bring', () => {
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
      // Inputs a body could try to carry: none is read.
      locked: [{ teamId: 't0', slotId: 's0' }],
      preferenceGate: { verdicts: {} },
      reservations: { slotDivision: {} },
      daylight: { venues: {} },
      practicesPerWeek: 7,
    });
    assert.deepEqual(Object.keys(parsed).sort(), ['browserRun', 'digest', 'placements']);
    assert.deepEqual(parsed.placements, [{ teamId: 't0', slotId: 's0' }]);
  });

  it('a verify body without a real digest, or with an invented termination, is refused', () => {
    const ok = {
      digest: 'b'.repeat(64),
      placements: [],
      browserRun: {
        seedScore: 0,
        iterations: 0,
        restarts: 0,
        elapsedMs: 0,
        terminationReason: 'time-budget',
      },
    };
    assert.equal(AutoSchedulerVerifySchema.safeParse(ok).success, true);
    assert.equal(AutoSchedulerVerifySchema.safeParse({ ...ok, digest: 'nope' }).success, false);
    assert.equal(
      AutoSchedulerVerifySchema.safeParse({
        ...ok,
        browserRun: { ...ok.browserRun, terminationReason: 'cpu-cap' },
      }).success,
      false
    );
  });
});

describe('the encoding the browser is handed', () => {
  it('a round trip through JSON gives the search the same input: equal placements and score', async () => {
    const direct = await search();
    const wire = JSON.parse(JSON.stringify(encodeSolverInput(league(), SCOPE)));
    const revived = reviveSolverInput(wire);
    const viaWire = await search(revived);
    assert.deepEqual(viaWire.placements, direct.placements);
    assert.equal(viaWire.bestScore, direct.bestScore);
    assert.deepEqual(viaWire.unassigned, direct.unassigned);
    assert.deepEqual(viaWire.daylight, direct.daylight);
    // And verify, over the revived input, accepts what the search over it found.
    assert.deepEqual(verify(proposal(viaWire), revived).refused, []);
  });

  it('is canonical: the same data in another order digests the same', async () => {
    const a = league();
    const b = league();
    // Rebuild b's maps in the opposite order, and its objects with their keys reversed.
    b.daylight.slots = new Map([...b.daylight.slots].reverse());
    b.dating = { ...b.dating, slots: b.daylight.slots };
    b.daylight.venues = new Map([...b.daylight.venues].reverse());
    b.preferenceGate = { verdicts: new Map([...b.preferenceGate.verdicts].reverse()) };
    b.unitsNeeded = Object.fromEntries(Object.entries(b.unitsNeeded).reverse());
    b.teams = b.teams.map((t) => Object.fromEntries(Object.entries(t).reverse()));
    const da = await digestEncodedInput(encodeSolverInput(a, SCOPE));
    const db = await digestEncodedInput(encodeSolverInput(b, SCOPE));
    assert.match(da, /^[0-9a-f]{64}$/);
    assert.equal(db, da);
  });

  it('leaves out the verdicts that say nothing, and only those', () => {
    const input = league();
    const t3Slots = input.preferenceGate.verdicts.get('t3');
    const encoded = encodeSolverInput(input, SCOPE);
    const wire = JSON.parse(JSON.stringify(encoded));
    const revived = reviveSolverInput(wire);
    const kept = revived.preferenceGate.verdicts.get('t3');
    const meaningful = [...t3Slots].filter(
      ([, v]) => v.mustKeepViolated || v.preferKeepBreaches > 0 || v.violatedDimensions.length
    );
    assert.ok(meaningful.length > 0 && meaningful.length < t3Slots.size);
    assert.deepEqual([...kept].sort(), meaningful.sort());
    assert.ok(revived.preferenceGate.verdicts.has('t3'), 'a constrained team stays in the gate');
  });

  it('a different input digests differently: a saved row, a slot, a verdict, a date, the season', async () => {
    const digest = async (mutate, scope = SCOPE) => {
      const input = league();
      mutate(input);
      return digestEncodedInput(encodeSolverInput(input, scope));
    };
    const baseline = await digest(() => {});
    const changes = {
      'a saved row moved': (i) => (i.locked[0].slotId = 'fb-wed-16'),
      'a slot loses capacity': (i) => (i.slots[0].capacity = 0),
      'a verdict flips': (i) =>
        (i.preferenceGate.verdicts.get('t3').get('fb-tue-16').mustKeepViolated = true),
      'today moves': (i) => (i.dating.liveFrom = '2026-10-20'),
      'a coach changes': (i) => (i.teams[2].coachIds = ['someone-else']),
      'a venue loses its lights': (i) => (i.daylight.venues.get('fb').lit = false),
    };
    for (const [name, mutate] of Object.entries(changes)) {
      assert.notEqual(await digest(mutate), baseline, name);
    }
    assert.notEqual(
      await digest(() => {}, {
        ...SCOPE,
        seasonSettingsId: '00000000-0000-4000-8000-000000000003',
      }),
      baseline,
      "another season's digest never matches"
    );
  });

  it('refuses a value it cannot write down, naming where, and an input of another version', () => {
    const withNaN = league();
    withNaN.slots[3].capacity = Number.NaN;
    assert.throws(() => encodeSolverInput(withNaN, SCOPE), /input\.slots\[3\]\.capacity/);
    const wire = JSON.parse(JSON.stringify(encodeSolverInput(league(), SCOPE)));
    assert.throws(() => reviveSolverInput({ ...wire, version: 2 }), /version 2/);
    assert.throws(() => reviveSolverInput({ version: 1, input: { teams: [] } }), /lacks its teams/);
    assert.throws(() => reviveSolverInput(null), /not an object/);
  });
});

describe('verify refuses 409 when the server now holds different inputs', () => {
  it('the digest the worker holds no longer matches a changed reload', async () => {
    const searched = league();
    const held = await digestEncodedInput(encodeSolverInput(searched, SCOPE));
    // The season changed while the worker searched: someone saved a practice for t5.
    const reload = league();
    reload.locked.push({
      assignmentId: 'row-t5',
      teamId: 't5',
      slotId: 'fb-mon-18',
      effectiveDateRange: '[2026-10-19,2026-11-20]',
    });
    const refused = await checkSolverInputDigest(encodeSolverInput(reload, SCOPE), held);
    assert.equal(refused.ok, false);
    assert.equal(refused.code, INPUT_CHANGED);
    assert.notEqual(refused.digest, held);
    const accepted = await checkSolverInputDigest(encodeSolverInput(league(), SCOPE), held);
    assert.equal(accepted.ok, true);
    assert.equal(accepted.digest, held);
  });

  it("a tampered copy cannot be vouched for: the server compares with its own reload, not the body's", async () => {
    // A worker given an input with the must-keep removed (so it would place t3 on a Monday) and a
    // client that claims the digest of that tampered copy: the server's reload is the real one.
    const tampered = league();
    tampered.preferenceGate = { verdicts: new Map() };
    const claimed = await digestEncodedInput(encodeSolverInput(tampered, SCOPE));
    const verdict = await checkSolverInputDigest(encodeSolverInput(league(), SCOPE), claimed);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.code, INPUT_CHANGED);
  });

  it('and a tampered schedule is refused by the rules even when the digest matches', async () => {
    // The digest is right (the input is the real one), the placements are not: t3 on a Monday.
    const claimed = await digestEncodedInput(encodeSolverInput(league(), SCOPE));
    const verdict = await checkSolverInputDigest(encodeSolverInput(league(), SCOPE), claimed);
    assert.equal(verdict.ok, true);
    const verified = verify([{ teamId: 't3', unitId: 't3#1', slotId: 'fb-mon-16' }]);
    assert.deepEqual(
      verified.refused.map((r) => r.rule),
      ['must-keep']
    );
  });
});

describe('how index.ts wires the three modes (the serving module cannot be imported)', () => {
  const source = readFileSync(
    path.join(process.cwd(), 'supabase/functions/auto-scheduler/index.ts'),
    'utf8'
  );
  const afterLoading = source.slice(source.indexOf('const solverInput: PracticeSolverInput'));

  it('prepare answers before anything is audited as started, and searches nothing', () => {
    const prepare = afterLoading.indexOf("input.mode === 'prepare'");
    const started = afterLoading.indexOf("action: 'scheduler.auto_started'");
    const search = afterLoading.indexOf('runPracticeOptimizer({');
    assert.ok(prepare > 0 && prepare < started && prepare < search);
    const block = afterLoading.slice(prepare, started);
    assert.match(block, /encodeSolverInput\(solverInput, solverScope\)/);
    assert.doesNotMatch(
      block,
      /runPracticeOptimizer|verifyPracticePlacements|persistEvaluationRun/
    );
  });

  it('prepare that cannot write the input down answers 422 with its own code, so the page runs the server’s search', () => {
    const prepare = afterLoading.slice(afterLoading.indexOf("input.mode === 'prepare'"));
    const guarded = prepare.slice(0, prepare.indexOf('const digest = await digestEncodedInput'));
    assert.match(
      guarded,
      /try \{\s*encoded = encodeSolverInput\(solverInput, solverScope\);\s*\} catch/
    );
    assert.match(guarded, /code: SOLVER_INPUT_UNENCODABLE,[\s\S]*?422/);
  });

  it('verify compares the digest with its own reload before it audits or persists anything', () => {
    const check = afterLoading.indexOf('checkSolverInputDigest(');
    const started = afterLoading.indexOf("action: 'scheduler.auto_started'");
    const persist = afterLoading.indexOf('persistEvaluationRun(');
    assert.ok(check > 0 && check < started && started < persist);
    assert.match(
      afterLoading.slice(check, started),
      /encodeSolverInput\(solverInput, solverScope\)[\s\S]*verifyClaims\.digest[\s\S]*409/
    );
  });

  it('verify judges the placements over the loaded input, and reads nothing else from the body', () => {
    assert.match(
      afterLoading,
      /verifyPracticePlacements\(\{\s*\.\.\.solverInput,\s*placements: verifyClaims\.placements,\s*\}\)/
    );
    // Of the claims, only the digest, the placements and the worker's statistics are read.
    const reads = [...source.matchAll(/verifyClaims\??\.(\w+)(\.\w+)?/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(reads)].sort(), ['browserRun', 'digest', 'placements']);
  });

  it('every mode goes through the one result tail: the same findings, evaluation run and response', () => {
    assert.equal((source.match(/persistEvaluationRun\(/g) ?? []).length, 1);
    assert.equal((source.match(/'scheduler\.auto_completed'/g) ?? []).length, 1);
  });
});
