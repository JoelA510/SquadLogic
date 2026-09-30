/**
 * **The placer's rule gate honours the waiver ledger exactly as
 * `runRuleEngine` does (#62, PR C; `docs/PLAN_60_62_GATE_GAPS.md` §2.4b, W13-W15).**
 *
 * The season's gated records are all `waivable: false` and its one waiver
 * targets a code the gate does not gate (§2.1), so no test over the corpus
 * alone could fail. Every case below is constructed: a synthetic registry, a
 * synthetic ledger, or both, driven through `applyChangeRequest()` and
 * `ruleGateInstances()` — the production entry points — and nothing else.
 *
 * Each case carries its own meta-assertions, with the case that makes each
 * one fail beside it:
 *
 * - **a finding before application**: the gate, asked with no ledger, reports
 *   the instance the waiver is meant to cover;
 * - **the scope matches the candidate's subject**: the same waiver, where the
 *   record is waivable, is applied by `verify` to that very subject — and the
 *   same waiver moved to another surface is not.
 */

import { describe, it, expect } from 'vitest';

import { buildAvailabilityCalendarFromSeason2026 } from '@squadlogic/core/availability/index.js';
import {
  SEASON_2026_CONSTRAINT_ID,
  buildConstraintRegistry,
  buildSeason2026ConstraintRegistry,
} from '@squadlogic/core/constraints/index.js';
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
import {
  STANDING_RULES,
  buildRuleEngine,
  coachConflictRule,
  toSeason2026Schedule,
} from '@squadlogic/core/ruleEngine/index.js';
import {
  applyChangeRequest,
  buildSlotInventory,
  createResolveLedger,
  createResolveState,
  indexCommitments,
  indexTeams,
  ruleGateInstances,
} from '@squadlogic/core/resolve/index.js';
import { FREEZE_DISPOSITION, freezeAllExcept } from '@squadlogic/core/freeze/index.js';
import { buildWaiverLedger } from '@squadlogic/core/waivers/index.js';

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
const season = buildSeason2026ConstraintRegistry();
const engines = {
  graph,
  table: timingTable,
  calendar,
  registry: season,
  resources: { graph, timingTable, calendar, venueComplexes },
};
const schedule = toSeason2026Schedule(loadSeason2026());
const byId = new Map(schedule.games.map((game) => [game.id, game]));

/** @param {{ date: string, surfaceId: string, startMinutes: number }} game */
const slotOf = (game) => ({
  date: game.date,
  surfaceId: game.surfaceId,
  startMinutes: game.startMinutes,
});

/** Where a run left a game, or null if TIME TBD. */
const whereIs = (run, gameId) => run.schedule.games.find((game) => game.id === gameId) ?? null;

/** The season's registry with the records `ids` names retyped `waivable: true`. */
const retypedWaivable = (ids) =>
  buildConstraintRegistry({
    name: `season-2026, ${ids.join(' + ')} retyped waivable (synthetic)`,
    constraints: season.constraints.map((record) =>
      ids.includes(record.id) ? { ...record, waivable: true } : record
    ),
  });

/** A one-waiver synthetic ledger. */
const ledgerOf = (constraintId, scope) =>
  buildWaiverLedger({
    name: 'p62c synthetic',
    source: 'tests/ruleGateWaivers.test.js',
    waivers: [
      {
        id: 'syn-waiver',
        constraintId,
        name: 'synthetic exception',
        scope,
        reasonCodes: [],
        reason: 'synthetic: exercises the gate against a covering waiver',
        approval: {
          approvedBy: 'synthetic board',
          approvedAt: '2026-09-01',
          reference: 'tests/ruleGateWaivers.test.js',
        },
      },
    ],
  });

/**
 * Displace `displacedId` on `sched` by pinning a same-format game from another
 * kickoff onto its slot, with the date thawed and verify on — the #59
 * workload, as `tests/ruleGate.test.js` drives it.
 */
function displace(displacedId, runEngines, sched = schedule) {
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
    engines: runEngines,
    freeze: freezeAllExcept([{ date: displaced.date }]),
    holdChanges: true,
    verify: true,
    onUnsatisfiable: 'report',
  });
}

/** A resolve state over the season as published, for the gate's own inputs. */
const state = createResolveState({
  games: schedule.games.map((game) => ({ ...game })),
  dispositions: Object.fromEntries(
    schedule.games.map((game) => [game.id, FREEZE_DISPOSITION.THAWED])
  ),
  admittedSlotsByGameId: {},
  inventory: buildSlotInventory(schedule.games),
  ledger: createResolveLedger(),
});

/** The gate's own context, as `resolve.js` builds it. */
const gateContext = (runEngines, sched = schedule) => ({
  engines: runEngines,
  commitmentIndex: indexCommitments(sched.commitments),
  teamIndex: indexTeams(sched.teams),
});

/* -------------------------------------------------------------------------- */
/* W13 / W14: turnover                                                         */
/* -------------------------------------------------------------------------- */

// #25 displaced (tests/ruleGate.test.js, "the solver no longer places a
// displaced game below the turnover floor"): the gate refuses the Orchard Park
// slot that turns over too fast from #22, under `turnover-orchard-park`.
const TWENTY_FIVE = 'combined_schedule.csv#25';
const TWENTY_TWO = 'combined_schedule.csv#22';
const ORCHARD = SEASON_2026_CONSTRAINT_ID.TURNOVER_ORCHARD_PARK;
const twentyTwo = /** @type {any} */ (byId.get(TWENTY_TWO));
const twentyFive = /** @type {any} */ (byId.get(TWENTY_FIVE));
const turnoverScope = { surfaceId: twentyTwo.surfaceId, date: twentyFive.date };
const turnoverKey = `TURNOVER_BELOW_MINIMUM|${TWENTY_TWO}`;
const waivableTurnover = retypedWaivable([ORCHARD]);

/** The turnover violations `verify` reports between #22 and #25. */
const turnoverBetween = (run) =>
  /** @type {any} */ (run.verification).violations.filter(
    (v) =>
      v.code === 'TURNOVER_BELOW_MINIMUM' &&
      [v.details.earlierGameId, v.details.laterGameId].sort().join() ===
        [TWENTY_TWO, TWENTY_FIVE].sort().join()
  );

describe('W13: a waiver on a waivable turnover record admits the slot, in the gate and in verify', () => {
  const noLedger = { ...engines, registry: waivableTurnover };
  const withLedger = { ...noLedger, waiverLedger: ledgerOf(ORCHARD, turnoverScope) };
  const refused = displace(TWENTY_FIVE, noLedger);
  const run = displace(TWENTY_FIVE, withLedger);
  const placed = /** @type {any} */ (whereIs(run, TWENTY_FIVE));

  it('meta: without the ledger the gate refuses a candidate, and #25 lands clear of #22', () => {
    expect(refused.meta.candidatesRefusedByRules).toBeGreaterThan(0);
    expect(turnoverBetween(refused)).toEqual([]);
  });

  it('places #25 on the slot the ledger admits, below the floor after #22', () => {
    expect(placed).not.toBeNull();
    expect(placed.surfaceId).toBe(twentyTwo.surfaceId);
    expect(slotOf(placed)).not.toEqual(slotOf(/** @type {any} */ (whereIs(refused, TWENTY_FIVE))));
    expect(run.meta.candidatesRefusedByRules).toBe(0);
  });

  it('verify shows that turnover waived — compromise, naming the waiver — not clean', () => {
    const [violation, ...rest] = turnoverBetween(run);
    expect(rest).toEqual([]);
    expect(violation.severity).toBe('compromise');
    expect(violation.details).toMatchObject({
      constraintId: ORCHARD,
      waived: true,
      waiverId: 'syn-waiver',
      severityBeforeWaiver: 'blocking',
    });
    expect(/** @type {any} */ (run.verification).waivers.appliedWaiverIds).toEqual(['syn-waiver']);
  });

  it('meta: the gate, asked at that slot, finds the shortfall before the ledger and none after', () => {
    // A finding before application, from the gate's own entry point — and
    // turnover the only gated code there, so the refusal the run without the
    // ledger made at this slot was the turnover's, not an overlap's or a
    // spread's. (Measured: #25 would sit short of #22 before it and of #23
    // after it, on the one surface the waiver names.)
    const bare = ruleGateInstances(gateContext(noLedger), state, TWENTY_FIVE, slotOf(placed));
    expect(bare.instances).toHaveProperty([turnoverKey], 1);
    expect(
      Object.keys(bare.instances).filter((key) => !key.startsWith('TURNOVER_BELOW_MINIMUM|'))
    ).toEqual([]);
    expect(
      ruleGateInstances(gateContext(withLedger), state, TWENTY_FIVE, slotOf(placed)).instances
    ).toEqual({});
    // The case that makes the first assertion fail: the slot the run without
    // the ledger chose carries no shortfall to find.
    const clear = /** @type {any} */ (whereIs(refused, TWENTY_FIVE));
    expect(
      ruleGateInstances(gateContext(noLedger), state, TWENTY_FIVE, slotOf(clear)).instances
    ).not.toHaveProperty([turnoverKey]);
  });

  it('meta: the scope decides — the same waiver on another surface admits nothing', () => {
    const elsewhere = { surfaceId: twentyFive.surfaceId, date: twentyFive.date };
    expect(elsewhere.surfaceId).not.toBe(turnoverScope.surfaceId);
    const missed = displace(TWENTY_FIVE, {
      ...noLedger,
      waiverLedger: ledgerOf(ORCHARD, elsewhere),
    });
    expect(/** @type {any} */ (missed.verification).waivers.appliedWaiverIds).toEqual([]);
    expect(missed.meta.candidatesRefusedByRules).toBeGreaterThan(0);
    expect(slotOf(/** @type {any} */ (whereIs(missed, TWENTY_FIVE)))).toEqual(
      slotOf(/** @type {any} */ (whereIs(refused, TWENTY_FIVE)))
    );
  });
});

describe('W14: a waiver cannot override `waivable: false`', () => {
  const withLedger = { ...engines, waiverLedger: ledgerOf(ORCHARD, turnoverScope) };
  const run = displace(TWENTY_FIVE, withLedger);
  const admitted = /** @type {any} */ (
    whereIs(
      displace(TWENTY_FIVE, {
        ...engines,
        registry: waivableTurnover,
        waiverLedger: ledgerOf(ORCHARD, turnoverScope),
      }),
      TWENTY_FIVE
    )
  );

  it('the season record is `waivable: false`, and the ledger reached verify, which bars the waiver', () => {
    expect(season.byId[ORCHARD].waivable).toBe(false);
    const barred = /** @type {any} */ (run.verification).findings.filter(
      (f) => f.code === 'WAIVER_CONSTRAINT_NOT_WAIVABLE'
    );
    expect(barred.map((f) => f.details.waiverId)).toEqual(['syn-waiver']);
  });

  it('still refuses the slot W13 admits, and verify waives nothing', () => {
    expect(run.meta.candidatesRefusedByRules).toBeGreaterThan(0);
    expect(slotOf(/** @type {any} */ (whereIs(run, TWENTY_FIVE)))).not.toEqual(slotOf(admitted));
    expect(turnoverBetween(run)).toEqual([]);
    expect(/** @type {any} */ (run.verification).waivers.appliedWaiverIds).toEqual([]);
    expect(
      ruleGateInstances(gateContext(withLedger), state, TWENTY_FIVE, slotOf(admitted)).instances
    ).toHaveProperty([turnoverKey], 1);
  });
});

/* -------------------------------------------------------------------------- */
/* W14 (Q3): a waiver naming conflict-fairness does not admit a spread breach   */
/* -------------------------------------------------------------------------- */

// The #60 W1 construction (tests/ruleGate.test.js): displaced #7 has no
// overlap-free slot, and every pass-2 slot adds a conflict for 14BSelect01,
// growing synthetic group SYN past the bound, so #7 is shelved. Synthetic
// windows give 14BSelect01 its one published conflict.
const SPREAD_TEAM = '14BSelect01';
const SPREAD_GROUP = 'SYN';
const SEVEN = 'combined_schedule.csv#7';
const FAIRNESS = SEASON_2026_CONSTRAINT_ID.CONFLICT_FAIRNESS;

const spreadSchedule = (() => {
  const template = /** @type {any} */ (
    schedule.commitments.find((c) => c.teamId === SPREAD_TEAM && typeof c.gameId === 'string')
  );
  const synthetic = ['own', 'other'].map((side) => ({
    id: `syn-window-0-${side}`,
    gameId: null,
    personId: template.personId,
    date: '2026-10-03',
    startMinutes: 600,
    endMinutes: 660,
    venueId: template.venueId,
    surfaceId: template.surfaceId,
    teamId: side === 'own' ? SPREAD_TEAM : '16BSelect02',
  }));
  return {
    ...schedule,
    teams: [
      ...schedule.teams.map((t) =>
        [SPREAD_TEAM, '14GSelect02'].includes(t.id) ? { ...t, groupLabel: SPREAD_GROUP } : t
      ),
      { id: 'SYN-ROSTER-ONLY', divisionLabel: null, groupLabel: SPREAD_GROUP, personIds: [] },
    ],
    commitments: [...schedule.commitments, ...synthetic],
  };
})();

const spreadViolations = (run) =>
  /** @type {any} */ (run.verification).violations.filter(
    (v) => v.code === 'CONFLICT_SPREAD_EXCEEDED' && v.details.groupLabel === SPREAD_GROUP
  );

describe('W14 (Q3): a waiver naming conflict-fairness does not admit a spread breach', () => {
  const fairnessLedger = ledgerOf(FAIRNESS, { teamId: SPREAD_TEAM });
  const run = displace(SEVEN, { ...engines, waiverLedger: fairnessLedger }, spreadSchedule);
  // The control, which a synthetic registry alone makes reachable.
  const waivableFairness = {
    ...engines,
    registry: retypedWaivable([FAIRNESS]),
    waiverLedger: fairnessLedger,
  };
  const control = displace(SEVEN, waivableFairness, spreadSchedule);

  it('the season record is `waivable: false` — operator ruling Q3, not retyped', () => {
    expect(season.byId[FAIRNESS].waivable).toBe(false);
  });

  it('meta: the scope matches — retyped waivable, the same waiver admits #7 and verify waives SYN', () => {
    expect(whereIs(control, SEVEN)).not.toBeNull();
    const [violation, ...rest] = spreadViolations(control);
    expect(rest).toEqual([]);
    expect(violation.severity).toBe('compromise');
    expect(violation.details).toMatchObject({ waived: true, waiverId: 'syn-waiver' });
  });

  it('meta: the gate finds the growth before the ledger, at the slot the control takes', () => {
    const slot = slotOf(/** @type {any} */ (whereIs(control, SEVEN)));
    const key = `CONFLICT_SPREAD_EXCEEDED|${SPREAD_GROUP}`;
    const bare = { ...waivableFairness, waiverLedger: null };
    expect(
      ruleGateInstances(gateContext(bare, spreadSchedule), state, SEVEN, slot).instances
    ).toHaveProperty([key], 1);
    expect(
      ruleGateInstances(gateContext(waivableFairness, spreadSchedule), state, SEVEN, slot).instances
    ).not.toHaveProperty([key]);
    expect(
      ruleGateInstances(
        gateContext({ ...engines, waiverLedger: fairnessLedger }, spreadSchedule),
        state,
        SEVEN,
        slot
      ).instances
    ).toHaveProperty([key], 1);
  });

  it('under the season record, still shelves #7 as TIME TBD naming the spread', () => {
    expect(whereIs(run, SEVEN)).toBeNull();
    expect(run.unplaced.find((entry) => entry.gameId === SEVEN)?.reason).toMatch(
      /\d+ for CONFLICT_SPREAD_EXCEEDED/
    );
    expect(spreadViolations(run)).toEqual([]);
    expect(/** @type {any} */ (run.verification).waivers.appliedWaiverIds).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* W15: the overlap stays unwaivable                                            */
/* -------------------------------------------------------------------------- */

// #7 displaced (tests/ruleGate.test.js #61): every slot double-books a coach
// with #18, so pass 1 refuses them all and pass 2 places #7 in that overlap.
const EIGHTEEN = 'combined_schedule.csv#18';
const TRAVEL = SEASON_2026_CONSTRAINT_ID.COACH_TRAVEL_BETWEEN_VENUES;
const sharedCoach = (() => {
  const on = (gameId) =>
    new Set(schedule.commitments.filter((c) => c.gameId === gameId).map((c) => c.personId));
  const eighteen = on(EIGHTEEN);
  return [...on(SEVEN)].filter((id) => eighteen.has(id));
})();
const travelLedger = ledgerOf(TRAVEL, { personId: sharedCoach[0] });

/** `verify`'s overlaps between #7 and #18. */
const gameOf = new Map(schedule.commitments.map((c) => [c.id, c.gameId ?? null]));
const overlapsWithEighteen = (run) =>
  /** @type {any} */ (run.verification).violations.filter(
    (v) =>
      v.code === 'TRAVEL_COMMITMENTS_OVERLAP' &&
      [gameOf.get(v.details.fromId), gameOf.get(v.details.toId)].sort().join() ===
        [EIGHTEEN, SEVEN].sort().join()
  );

describe('W15: a waiver naming the travel constraint does not admit an overlap', () => {
  const run = displace(SEVEN, { ...engines, waiverLedger: travelLedger });

  it('names a waivable season record and the coach the two games share', () => {
    expect(sharedCoach).toHaveLength(1);
    expect(season.byId[TRAVEL].waivable).toBe(true);
  });

  it('meta: the scope matches — with the overlap linked to that record, verify waives it', () => {
    // A rule engine whose coach rule links the overlap code to the travel
    // record: a supported input (`engines.ruleEngine`), never the standing one.
    const linked = {
      ...coachConflictRule,
      constraintIdByCode: {
        ...coachConflictRule.constraintIdByCode,
        TRAVEL_COMMITMENTS_OVERLAP: [TRAVEL],
      },
    };
    const ruleEngine = buildRuleEngine({
      name: 'overlap linked to travel (synthetic)',
      rules: STANDING_RULES.map((rule) => (rule.id === coachConflictRule.id ? linked : rule)),
    });
    const control = displace(SEVEN, { ...engines, waiverLedger: travelLedger, ruleEngine });
    const [violation] = overlapsWithEighteen(control);
    expect(violation.details).toMatchObject({ waived: true, waiverId: 'syn-waiver' });
    // Declared, not enforced: the overlap arm does not read the ledger, so
    // were the code ever linked, pass 1 would still refuse — failing safe,
    // the gate over-refusing what `verify` would accept.
    expect(control.meta.overlapFallbackEntered).toBe(1);
  });

  it('pass 1 still refuses the overlap, and #7 is placed only as the pass-2 last resort', () => {
    expect(run.meta.candidatesRefusedByRules).toBeGreaterThan(0);
    expect(run.meta.overlapFallbackEntered).toBe(1);
    expect(whereIs(run, SEVEN)).not.toBeNull();
  });

  it('verify reports the overlap unwaived', () => {
    const found = overlapsWithEighteen(run);
    expect(found).toHaveLength(1);
    expect(found[0].details.waived).toBeUndefined();
    expect(found[0].waived).toBeFalsy();
  });
});
