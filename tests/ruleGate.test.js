/**
 * **The placer's coach and turnover gate (#59).**
 *
 * Before #59, `chooseSlot()` asked the facility model alone, and a displaced
 * game could be placed where it double-booked a coach or turned a surface over
 * below the floor — both blocking under the season's constraints — with the run
 * `allowed` apart from a `verify` finding. Measured over 679 displacement runs:
 * 56 overlaps and the turnover shortfalls not involving the requested game were
 * the solver's own placements.
 *
 * Every outcome below is judged by the **standing rule engine** through
 * `verify` — a different code path from `ruleGate.js` — against the baseline's
 * own violations, never by the gate grading itself. The five design
 * requirements each have a case that fails if the requirement is broken:
 *
 * - (a) the coach's other game is never lifted;
 * - (b) instances are the unordered pair of games, not the consecutive pair;
 * - (c) one commitment projection for the gate and `verify`;
 * - (d) commitments naming no game are in the coach's day;
 * - (e) the three games the season publishes in an overlap, displaced first.
 *
 * @see packages/core/src/resolve/ruleGate.js
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, it, expect } from 'vitest';

import { buildAvailabilityCalendarFromSeason2026 } from '@squadlogic/core/availability/index.js';
import { buildSeason2026ConstraintRegistry } from '@squadlogic/core/constraints/index.js';
import {
  buildFacilityGraphFromSeason2026,
  buildSeason2026VenueComplexMap,
} from '@squadlogic/core/facility/index.js';
import {
  loadFacilityGeometry,
  loadFacilityPermits,
  loadGameFormats,
  loadSeason2026,
  loadSunsets,
} from '@squadlogic/core/fixtures/index.js';
import { buildFormatTimingTableFromSeason2026 } from '@squadlogic/core/timing/index.js';
import { toSeason2026Schedule } from '@squadlogic/core/ruleEngine/index.js';
import { evaluateCoachTravel } from '@squadlogic/core/waivers/coachTravel.js';
import {
  applyChangeRequest,
  buildSlotInventory,
  createResolveLedger,
  createResolveState,
  indexCommitments,
  projectCommitment,
  ruleGateInstances,
  violationInstanceKey,
} from '@squadlogic/core/resolve/index.js';
import { FREEZE_DISPOSITION, freezeAllExcept } from '@squadlogic/core/freeze/index.js';
import { buildConstraintRegistry } from '@squadlogic/core/constraints/index.js';

/* -------------------------------------------------------------------------- */
/* Corpus and engines                                                          */
/* -------------------------------------------------------------------------- */

const sunsets = loadSunsets();
const graph = buildFacilityGraphFromSeason2026(loadFacilityGeometry());
const timingTable = buildFormatTimingTableFromSeason2026(loadGameFormats());
const calendar = buildAvailabilityCalendarFromSeason2026(
  loadFacilityPermits({ seasonYear: Number(sunsets[0].date.slice(0, 4)) }),
  sunsets
);
const venueComplexes = buildSeason2026VenueComplexMap();
const engines = {
  graph,
  table: timingTable,
  calendar,
  registry: buildSeason2026ConstraintRegistry(),
  resources: { graph, timingTable, calendar, venueComplexes },
};
const schedule = toSeason2026Schedule(loadSeason2026());
const byId = new Map(schedule.games.map((game) => [game.id, game]));
const gameOfCommitment = new Map(schedule.commitments.map((c) => [c.id, c.gameId ?? null]));

/** @param {{ date: string, surfaceId: string, startMinutes: number }} game */
const slotOf = (game) => ({
  date: game.date,
  surfaceId: game.surfaceId,
  startMinutes: game.startMinutes,
});

const GATED = ['TRAVEL_COMMITMENTS_OVERLAP', 'TURNOVER_BELOW_MINIMUM'];

/** The two games a gated violation is about. */
function pairOf(violation) {
  return violation.code === 'TURNOVER_BELOW_MINIMUM'
    ? [violation.details.earlierGameId, violation.details.laterGameId]
    : [
        gameOfCommitment.get(violation.details.fromId),
        gameOfCommitment.get(violation.details.toId),
      ];
}

const noOp = schedule.games[0];
const baselineRun = applyChangeRequest({
  schedule,
  changes: [{ gameId: noOp.id, ...slotOf(noOp), reason: 'the baseline verdict' }],
  engines,
  verify: true,
  onUnsatisfiable: 'report',
});
const baselineVerification = /** @type {any} */ (baselineRun.verification);
const baselineKeys = new Set(baselineVerification.violations.map(violationInstanceKey));

/**
 * Displace `displaced` by pinning a same-format game from another kickoff on
 * its slot, with the date thawed — the workload the #59 numbers were measured
 * on.
 */
function displace(displacedId) {
  const displaced = /** @type {any} */ (byId.get(displacedId));
  const requested = schedule.games.find(
    (game) =>
      game.id !== displaced.id &&
      game.date === displaced.date &&
      game.venueId === displaced.venueId &&
      game.format === displaced.format &&
      game.startMinutes !== displaced.startMinutes
  );
  if (!requested) throw new Error(`no same-format partner for ${displacedId}`);
  const run = applyChangeRequest({
    schedule,
    changes: [{ gameId: requested.id, ...slotOf(displaced), reason: 'displace' }],
    engines,
    freeze: freezeAllExcept([{ date: displaced.date }]),
    holdChanges: true,
    verify: true,
    baselineVerification,
    onUnsatisfiable: 'report',
  });
  /** Every gated violation on the result, from the rule engine, by pair. */
  const standing = /** @type {any} */ (run.verification).violations
    .filter((violation) => GATED.includes(violation.code))
    .map((violation) => ({
      code: violation.code,
      pair: pairOf(violation),
      published: baselineKeys.has(violationInstanceKey(violation)),
    }));
  /** Those the baseline did not carry. */
  const introduced = standing.filter((entry) => !entry.published);
  return { run, requested, standing, introduced };
}

/** Where a run left a game, or null if TIME TBD. */
const whereIs = (run, gameId) => run.schedule.games.find((game) => game.id === gameId) ?? null;

/* -------------------------------------------------------------------------- */
/* (e) The three published overlaps, first                                      */
/* -------------------------------------------------------------------------- */

describe('(e) the games the season publishes in an overlap, displaced', () => {
  const published = baselineVerification.violations.filter(
    (violation) => violation.code === 'TRAVEL_COMMITMENTS_OVERLAP'
  );
  const games = [...new Set(published.flatMap(pairOf))].sort();

  it('finds the published overlaps from the rule engine, not from the gate', () => {
    expect(published).toHaveLength(3);
    expect(games).toHaveLength(4);
  });

  for (const gameId of games) {
    it(`${gameId}: keeps a time or says why, and is never placed into an overlap`, () => {
      const { run, standing } = displace(gameId);
      const placed = whereIs(run, gameId);
      if (placed === null) {
        const shelved = run.unplaced.find((entry) => entry.gameId === gameId);
        expect(shelved?.reason, `${gameId} was dropped`).toMatch(/TIME TBD/);
      } else {
        expect(slotOf(placed)).not.toEqual(slotOf(/** @type {any} */ (byId.get(gameId))));
      }
      // Off its published slot it may carry no gated breach at all — not even
      // the one it was published with, which was accepted there and nowhere
      // else. Read from every standing violation, not only the introduced
      // ones: the published pair recurring elsewhere keys as "not new".
      expect(standing.filter(({ pair }) => pair.includes(gameId))).toEqual([]);
      // (a) Its published overlap partner stands exactly where it was published.
      const partners = published
        .map(pairOf)
        .filter((pair) => pair.includes(gameId))
        .flatMap((pair) => pair.filter((id) => id !== gameId));
      expect(partners.length).toBeGreaterThan(0);
      for (const other of partners) {
        expect(slotOf(/** @type {any} */ (whereIs(run, other)))).toEqual(
          slotOf(/** @type {any} */ (byId.get(other)))
        );
      }
    });
  }
});

/* -------------------------------------------------------------------------- */
/* The two measured cases, and (a)                                              */
/* -------------------------------------------------------------------------- */

describe('a displaced game with no overlap-free slot: refused in pass 1, placed in pass 2 (#61)', () => {
  // Measured before #59: #7 displaced was placed 75 minutes into coach Gray
  // Judd's #18, at another venue.
  const { run, requested, standing, introduced } = displace('combined_schedule.csv#7');

  it('refused at least one candidate for it — the gate read real commitments', () => {
    expect(run.meta.ruleGateCommitmentsExamined).toBeGreaterThan(0);
    expect(run.meta.candidatesRefusedByRules).toBeGreaterThan(0);
  });

  it('is placed rather than shelved, carrying exactly the one overlap it could not avoid', () => {
    // #436 refused every candidate and shelved #7 as TIME TBD. Since #61 an
    // overlap is the last resort before TIME TBD: pass 1 still refuses it (the
    // test above), pass 2 is entered because nothing overlap-free existed, and
    // the placement carries a warning.
    expect(run.meta.overlapFallbackEntered).toBe(1);
    expect(whereIs(run, 'combined_schedule.csv#7')).not.toBeNull();
    expect(run.unplaced).toEqual([]);
    const own = standing.filter(({ pair }) => pair.includes('combined_schedule.csv#7'));
    expect(own.map(({ code }) => code)).toEqual(['TRAVEL_COMMITMENTS_OVERLAP']);
    expect(own[0].pair).toContain('combined_schedule.csv#18');
    // Nothing else the requested game is not party to, and never a turnover.
    expect(
      introduced.filter(
        ({ pair }) => !pair.includes(requested.id) && !pair.includes('combined_schedule.csv#7')
      )
    ).toEqual([]);
    expect(introduced.filter(({ code }) => code === 'TURNOVER_BELOW_MINIMUM')).toEqual([]);
  });

  it('(a) never lifts the coach’s other game, which stands at another venue', () => {
    const other = /** @type {any} */ (byId.get('combined_schedule.csv#18'));
    expect(other.venueId).not.toBe(
      /** @type {any} */ (byId.get('combined_schedule.csv#7')).venueId
    );
    expect(slotOf(/** @type {any} */ (whereIs(run, other.id)))).toEqual(slotOf(other));
    expect(run.moves.some((move) => move.gameId === other.id)).toBe(false);
  });
});

describe('(a) the gate is read by the placer, and by a slot a machine chose, and nowhere else', () => {
  it('is called by chooseSlot, baseline-ingest, the overlap warning and evaluateCandidate, never by a stage that lifts games', () => {
    const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const code = readFileSync(
      path.join(ROOT, 'packages', 'core', 'src', 'resolve', 'stages.js'),
      'utf8'
    ).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    const between = (from, to) => code.slice(code.indexOf(from), code.indexOf(to));
    expect(code.length).toBeGreaterThan(20000);
    // Four since #53: `evaluateCandidate()` asks it of a slot a proposer chose
    // or an operator approved, read by `change-request-apply` and by the
    // cross-venue options pass — the same question, never a stage lifting games.
    expect([...code.matchAll(/\bruleGateInstances\(/g)]).toHaveLength(4);
    expect(between('export function evaluateCandidate(', 'function placePending(')).toContain(
      'ruleGateInstances('
    );
    expect(between('const changeRequestApply = {', 'const dislodge = {')).toContain(
      'evaluateCandidate('
    );
    expect(between('function reportCoachOverlapsCarried(', 'const freezeAudit = {')).toContain(
      'ruleGateInstances('
    );
    expect(between('function chooseSlot(', 'function placePending(')).toContain(
      'ruleGateInstances('
    );
    // Factored into `recordBaselineAcceptance()` in #53, which baseline-ingest calls.
    expect(
      between('export function recordBaselineAcceptance(', 'const baselineIngest = {')
    ).toContain('ruleGateInstances(');
    expect(between('const baselineIngest = {', 'const changeRequestApply = {')).toContain(
      'recordBaselineAcceptance('
    );
    for (const [from, to] of [
      ['const dislodge = {', 'const initialAssignment = {'],
      ['const localSearch = {', 'const pairRepair = {'],
      ['const pairRepair = {', 'const verify = {'],
    ]) {
      const body = between(from, to);
      expect(body.length, from).toBeGreaterThan(500);
      expect(body, from).not.toContain('ruleGateInstances(');
    }
  });
});

describe('the solver no longer places a displaced game below the turnover floor', () => {
  // Measured before #59: #25 displaced was placed where it turned over from #22
  // below the floor, on the same Orchard Park surface.
  const { run, standing } = displace('combined_schedule.csv#25');

  it('refused at least one candidate for it, having read real surface pairs', () => {
    expect(run.meta.ruleGateSurfacePairsExamined).toBeGreaterThan(0);
    expect(run.meta.candidatesRefusedByRules).toBeGreaterThan(0);
  });

  it('leaves the displaced game in no turnover breach', () => {
    expect(
      standing.filter(
        ({ code, pair }) =>
          code === 'TURNOVER_BELOW_MINIMUM' && pair.includes('combined_schedule.csv#25')
      )
    ).toEqual([]);
    expect(whereIs(run, 'combined_schedule.csv#22')).not.toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* (b), (c), (d) at unit level                                                  */
/* -------------------------------------------------------------------------- */

/** A resolve state over the season, for the gate's own inputs. */
const state = createResolveState({
  games: schedule.games.map((game) => ({ ...game })),
  dispositions: Object.fromEntries(
    schedule.games.map((game) => [game.id, FREEZE_DISPOSITION.THAWED])
  ),
  admittedSlotsByGameId: {},
  inventory: buildSlotInventory(schedule.games),
  ledger: createResolveLedger(),
});

/** A coach with two games on one date: X moves, A stays. */
const COACH_PAIR = (() => {
  const byPersonDate = new Map();
  for (const commitment of schedule.commitments) {
    if (!commitment.gameId) continue;
    const key = `${commitment.personId}|${commitment.date}`;
    byPersonDate.set(key, [...(byPersonDate.get(key) ?? []), commitment]);
  }
  for (const [, day] of [...byPersonDate.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (day.length !== 2) continue;
    const [x, a] = day.map((c) => /** @type {any} */ (byId.get(c.gameId)));
    if (x.endMinutes - x.startMinutes < 45) continue;
    return { personId: day[0].personId, x, a };
  }
  throw new Error('no coach with exactly two games on a date');
})();

describe('(b) an overlap is the unordered pair of games, whichever comes first', () => {
  const context = { engines, commitmentIndex: indexCommitments(schedule.commitments) };
  const { x, a } = COACH_PAIR;
  const before = { ...slotOf(x), date: a.date, startMinutes: a.startMinutes - 30 };
  const after = { ...slotOf(x), date: a.date, startMinutes: a.startMinutes + 15 };

  it('reorders the coach’s day between the two slots, so the rule engine re-pairs it', () => {
    const subjectsAt = (slot) =>
      evaluateCoachTravel(
        schedule.commitments
          .filter((c) => c.personId === COACH_PAIR.personId)
          .map((c) => projectCommitment(c, state, { gameId: x.id, slot }))
          .filter((c) => c !== null && c.date === a.date),
        { registry: engines.registry, venueComplexes }
      )
        .subjects.filter((subject) =>
          subject.findings.some((f) => f.code === 'TRAVEL_COMMITMENTS_OVERLAP')
        )
        .map((subject) => subject.id);
    const first = subjectsAt(before);
    const second = subjectsAt(after);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    // The meta-assertion: the consecutive-pair identity really did change.
    expect(first[0]).not.toBe(second[0]);
  });

  it('keys both as the same instance', () => {
    const key = `TRAVEL_COMMITMENTS_OVERLAP|${a.id}`;
    expect(ruleGateInstances(context, state, x.id, before).instances[key]).toBeGreaterThan(0);
    expect(ruleGateInstances(context, state, x.id, after).instances[key]).toBe(
      ruleGateInstances(context, state, x.id, before).instances[key]
    );
  });
});

describe('(c) the gate and verify place a coach through one projection', () => {
  it('resolvedScheduleOf() projects commitments through projectCommitment() and nowhere else', () => {
    const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const source = readFileSync(
      path.join(ROOT, 'packages', 'core', 'src', 'resolve', 'resolve.js'),
      'utf8'
    ).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    expect(source.length).toBeGreaterThan(5000);
    expect(source).toMatch(/\.map\(\(commitment\) => projectCommitment\(commitment, state\)\)/);
    // A second projection would have to compute a commitment's length itself.
    expect(source).not.toMatch(/commitment\.endMinutes\s*-\s*commitment\.startMinutes/);
  });
});

describe('(d) a commitment naming no game is part of the coach’s day', () => {
  const { personId, x } = COACH_PAIR;
  const template = /** @type {any} */ (
    schedule.commitments.find((c) => c.personId === personId && c.gameId === x.id)
  );
  // An external window the season does not hold as a game.
  const external = {
    ...template,
    id: 'external-window-1',
    gameId: undefined,
    startMinutes: x.startMinutes,
    endMinutes: x.startMinutes + 60,
  };
  delete external.gameId;
  const withExternal = [...schedule.commitments, external];

  it('is refused as an overlap with the window itself', () => {
    const context = { engines, commitmentIndex: indexCommitments(withExternal) };
    const instances = ruleGateInstances(context, state, x.id, slotOf(x)).instances;
    expect(instances['TRAVEL_COMMITMENTS_OVERLAP|commitment:external-window-1']).toBe(1);
  });

  it('is indexed under the coach, beside the games', () => {
    const index = indexCommitments(withExternal);
    expect(index.byPerson.get(personId)?.some((c) => c.id === 'external-window-1')).toBe(true);
    expect(index.personsByGame.get(x.id)).toContain(personId);
  });

  it('catches an overlap the consecutive-pair scan hides behind a short commitment', () => {
    // A long window with a short one inside it, both before X starts: sorted,
    // the rule engine pairs long-short and short-X, never long-X.
    const long = {
      ...external,
      id: 'external-long',
      startMinutes: x.startMinutes - 60,
      endMinutes: x.startMinutes + 30,
    };
    const short = {
      ...external,
      id: 'external-short',
      startMinutes: x.startMinutes - 50,
      endMinutes: x.startMinutes - 40,
    };
    const day = [...schedule.commitments, long, short];
    // The meta-assertion: the consecutive scan really does miss it.
    const consecutive = evaluateCoachTravel(
      day
        .filter((c) => c.personId === personId && c.date === x.date)
        .map((c) => projectCommitment(c, state)),
      { registry: engines.registry, venueComplexes }
    ).subjects.flatMap((subject) =>
      subject.findings.filter((f) => f.code === 'TRAVEL_COMMITMENTS_OVERLAP')
    );
    const pairs = consecutive.map((f) => [f.details.fromId, f.details.toId].sort().join('+'));
    expect(pairs).toContain(['external-long', 'external-short'].sort().join('+'));
    expect(pairs).not.toContain(['external-long', template.id].sort().join('+'));
    const instances = ruleGateInstances(
      { engines, commitmentIndex: indexCommitments(day) },
      state,
      x.id,
      slotOf(x)
    ).instances;
    expect(instances['TRAVEL_COMMITMENTS_OVERLAP|commitment:external-long']).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/* #61: an overlap is the last resort, and always warned                        */
/* -------------------------------------------------------------------------- */

/** The overlap warnings a run carries. */
const warningsOf = (run) =>
  run.findings.filter((finding) => finding.code === 'RESOLVE_COACH_OVERLAP_CARRIED');

/** Displace with verify switched off — the warning must not depend on it. */
function displaceQuietly(displacedId, sched = schedule) {
  const displaced = /** @type {any} */ (byId.get(displacedId));
  const requested = /** @type {any} */ (
    sched.games.find(
      (game) =>
        game.id !== displaced.id &&
        game.date === displaced.date &&
        game.venueId === displaced.venueId &&
        game.format === displaced.format &&
        game.startMinutes !== displaced.startMinutes
    )
  );
  return applyChangeRequest({
    schedule: sched,
    changes: [{ gameId: requested.id, ...slotOf(displaced), reason: 'displace' }],
    engines,
    freeze: freezeAllExcept([{ date: displaced.date }]),
    holdChanges: true,
    verify: false,
    onUnsatisfiable: 'report',
  });
}

describe('#61: a clean slot at the same venue is preferred to an overlap', () => {
  // #117 displaced (found by search): pass 1 refuses an overlap candidate the
  // objective would otherwise choose — with overlaps admitted, #117 lands in
  // one — and still finds a clean slot, so pass 2 is never entered.
  const run = displaceQuietly('combined_schedule.csv#117');

  it('refused an overlap candidate, so the preference was actually exercised', () => {
    expect(run.meta.candidatesRefusedByRules).toBeGreaterThan(0);
    expect(run.meta.ruleGateCommitmentsExamined).toBeGreaterThan(0);
  });

  it('never enters pass 2 and carries no overlap', () => {
    expect(run.meta.overlapFallbackEntered).toBe(0);
    expect(warningsOf(run).filter((w) => w.details.gameId === 'combined_schedule.csv#117')).toEqual(
      []
    );
    expect(whereIs(run, 'combined_schedule.csv#117')).not.toBeNull();
  });
});

describe('#61: every placement carrying a new coach overlap warns, verify or not', () => {
  it('warns for the pass-2 placement, naming the coach, the other game and the cover', () => {
    const run = displaceQuietly('combined_schedule.csv#7');
    expect(run.meta.overlapFallbackEntered).toBe(1);
    const warned = warningsOf(run);
    expect(warned).toHaveLength(1);
    expect(warned[0].severity).toBe('compromise');
    expect(warned[0].details).toMatchObject({
      gameId: 'combined_schedule.csv#7',
      personId: 'gray judd',
      otherId: 'combined_schedule.csv#18',
      covered: true,
    });
    // The co-coach is read from the team's registered coaches.
    const team = /** @type {any} */ (
      schedule.teams.find((entry) => entry.id === warned[0].details.teamId)
    );
    const others = team.personIds.filter((id) => id !== 'gray judd');
    expect(others.length).toBeGreaterThan(0);
    expect(warned[0].details.coCoaches).toBe([...others].sort().join(', '));
    expect(run.meta.coachOverlapsCarried).toBe(1);
  });

  it('warns for a requested move, with verify off', () => {
    // #7 requested onto #6's slot, where its coach is at #18.
    const run = displaceQuietly('combined_schedule.csv#6');
    expect(run.meta.overlapFallbackEntered).toBe(0);
    const warned = warningsOf(run);
    expect(warned.map((w) => [w.details.gameId, w.details.otherId])).toEqual([
      ['combined_schedule.csv#7', 'combined_schedule.csv#18'],
    ]);
    expect(run.verification).toBeNull();
  });

  it('says plainly when neither team has another registered coach', () => {
    // The same case with gray judd the only coach either team has registered.
    const alone = {
      ...schedule,
      teams: schedule.teams.map((team) =>
        team.personIds.includes('gray judd') ? { ...team, personIds: ['gray judd'] } : team
      ),
    };
    const warned = warningsOf(displaceQuietly('combined_schedule.csv#7', alone));
    expect(warned).toHaveLength(1);
    expect(warned[0].details.covered).toBe(false);
    expect(warned[0].message).toMatch(/NEITHER team has another registered coach/);
  });
});

describe('#61: turnover stays a hard refusal in pass 2', () => {
  // No pass-2 placement on the corpus had a turnover-refused candidate at all
  // (searched: all 30), so ungating turnover there changes nothing and a test
  // over the corpus alone could not fail. Constructed instead: the same #7
  // displacement under a turnover floor raised to 45 minutes (found by sweep:
  // 15-30 leaves an overlap-only slot, 45 does not). Every candidate that
  // would take #7 as a last resort then also turns a surface over too fast.
  const strictRegistry = buildConstraintRegistry({
    name: 'season-2026, turnover floor raised for the pass-2 control',
    constraints: engines.registry.constraints.map((record) =>
      record.policy === 'turnover-minimum' && record.type === 'hard'
        ? { ...record, parameters: { ...record.parameters, minimumGapMinutes: 45 } }
        : record
    ),
  });
  const displaced = /** @type {any} */ (byId.get('combined_schedule.csv#7'));
  const requested = /** @type {any} */ (byId.get('combined_schedule.csv#6'));
  const run = applyChangeRequest({
    schedule,
    changes: [{ gameId: requested.id, ...slotOf(displaced), reason: 'displace' }],
    engines: { ...engines, registry: strictRegistry },
    freeze: freezeAllExcept([{ date: displaced.date }]),
    holdChanges: true,
    verify: true,
    onUnsatisfiable: 'report',
  });

  it('shelves the game as TIME TBD, naming both refusals, rather than place it below the floor', () => {
    expect(whereIs(run, displaced.id)).toBeNull();
    const reason = run.unplaced.find((entry) => entry.gameId === displaced.id)?.reason ?? '';
    // Both codes named: overlap candidates existed, and every one of them also
    // failed the turnover floor — which is what kept pass 2's pool empty.
    expect(reason).toMatch(/TURNOVER_BELOW_MINIMUM/);
    expect(reason).toMatch(/TRAVEL_COMMITMENTS_OVERLAP/);
    expect(run.meta.overlapFallbackEntered).toBe(0);
    const below = /** @type {any} */ (run.verification).violations.filter(
      (violation) =>
        violation.code === 'TURNOVER_BELOW_MINIMUM' && pairOf(violation).includes(displaced.id)
    );
    expect(below).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* #61: pass 2 is the placer's alone — a constructed witness                    */
/* -------------------------------------------------------------------------- */

describe('#61: local-search never takes pass 2 for a game no change request names', () => {
  // The corpus cannot reach this path: the 679-run displacement sweep is
  // byte-identical with the opt-in broken open. Constructed instead. #6 is
  // stacked onto #7's published slot in the baseline, and #7 is put in the
  // repair scope, so `local-search` must answer for #7's clash. Every
  // overlap-free slot at its venue that day is refused — the same neighbourhood
  // that sends a displaced #7 through the placer's pass 2 — so the only slots
  // left would double-book coach Gray Judd with #18. For the placer that is
  // the last resort before TIME TBD; for `local-search` the alternative is
  // leaving #7 exactly where it was published, and that is what must happen.
  const seven = /** @type {any} */ (byId.get('combined_schedule.csv#7'));
  const six = /** @type {any} */ (byId.get('combined_schedule.csv#6'));
  const stacked = {
    ...schedule,
    games: schedule.games.map((game) =>
      game.id === six.id
        ? {
            ...game,
            surfaceId: seven.surfaceId,
            startMinutes: seven.startMinutes,
            endMinutes: seven.startMinutes + (game.endMinutes - game.startMinutes),
          }
        : game
    ),
  };
  const noOp = /** @type {any} */ (
    stacked.games.find(
      (game) => game.date === seven.date && game.id !== seven.id && game.id !== six.id
    )
  );
  const run = applyChangeRequest({
    schedule: stacked,
    changes: [{ gameId: noOp.id, ...slotOf(noOp), reason: 'the run has to happen' }],
    engines,
    freeze: freezeAllExcept([{ date: seven.date }]),
    repairScope: [seven.id],
    verify: false,
    onUnsatisfiable: 'report',
  });
  const stage = (id) => /** @type {any} */ (run.stages.find((entry) => entry.stageId === id));

  it('reaches local-search for #7, which no change request names', () => {
    expect(stage('local-search').movesConsidered).toBeGreaterThan(0);
    expect(
      run.moves.some((move) => move.stageId === 'change-request-apply' && move.gameId === seven.id)
    ).toBe(false);
    // The meta-assertion: the only slots left would double-book a coach.
    expect(run.meta.candidatesRefusedByRules).toBeGreaterThan(0);
  });

  it('leaves #7 on its published slot, says it could not repair it, and never enters pass 2', () => {
    expect(slotOf(/** @type {any} */ (whereIs(run, seven.id)))).toEqual(slotOf(seven));
    expect(run.meta.overlapFallbackEntered).toBe(0);
    expect(warningsOf(run)).toEqual([]);
    expect(
      run.findings.some(
        (finding) =>
          finding.code === 'RESOLVE_REPAIR_UNAVAILABLE' && finding.details.gameId === seven.id
      )
    ).toBe(true);
  });
});
