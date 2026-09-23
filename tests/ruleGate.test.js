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

describe('the solver no longer places a displaced game into a coach overlap', () => {
  // Measured before #59: #7 displaced was placed 75 minutes into coach Gray
  // Judd's #18, at another venue.
  const { run, requested, standing, introduced } = displace('combined_schedule.csv#7');

  it('refused at least one candidate for it — the gate read real commitments', () => {
    expect(run.meta.ruleGateCommitmentsExamined).toBeGreaterThan(0);
    expect(run.meta.candidatesRefusedByRules).toBeGreaterThan(0);
  });

  it('introduces no overlap or turnover breach the requested game is not party to', () => {
    expect(introduced.filter(({ pair }) => !pair.includes(requested.id))).toEqual([]);
    expect(standing.filter(({ pair }) => pair.includes('combined_schedule.csv#7'))).toEqual([]);
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

describe('(a) the gate is read by the placer and nowhere else', () => {
  it('is called by chooseSlot and baseline-ingest only, never by a stage that lifts games', () => {
    const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const code = readFileSync(
      path.join(ROOT, 'packages', 'core', 'src', 'resolve', 'stages.js'),
      'utf8'
    ).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    const between = (from, to) => code.slice(code.indexOf(from), code.indexOf(to));
    expect(code.length).toBeGreaterThan(20000);
    expect([...code.matchAll(/\bruleGateInstances\(/g)]).toHaveLength(2);
    expect(between('function chooseSlot(', 'function placePending(')).toContain(
      'ruleGateInstances('
    );
    expect(between('const baselineIngest = {', 'const changeRequestApply = {')).toContain(
      'ruleGateInstances('
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
