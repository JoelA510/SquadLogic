// @vitest-environment node
/**
 * The capacity panel against the real optimizer: the one-way property its face promises (schedule
 * expansion, PR 13, fix round 4; Codex, #711).
 *
 * The panel says on its face that each verdict is an **upper bound**: the room it counts can only be
 * too high, so it may be too generous and must never be too strict. The same defect was found four
 * times in a new spelling (a verdict that fires on a coarse condition, not on one that is necessary
 * for a run to fail): a length reason chosen on the setting, a reservation reason that said one
 * sentence for two, and a weekday verdict that compared the weekly target with the open weekdays when
 * a team's practice on an expired slot still counts toward its target. Cases reviewers thought of are
 * not a census, so this file builds a few hundred small leagues from seeds and holds the panel to
 * the optimizer the Practices page's run uses (`runPracticeOptimizer`, with the planner's
 * `planTeamsForRun`, the reservations and the dating as the Edge function loads them):
 *
 *     whenever the panel says SHORT, NO_SLOT or NOT_ENOUGH_DAYS for a division,
 *     the optimizer leaves at least one of that division's practices unplaced.
 *
 * The converse need not hold (an upper bound is allowed to be generous: the panel ignores coaches,
 * daylight, closures and the rest). The subject set is the league's own, never the optimizer's
 * output (lesson 46): each division's practices still needed come from the planner over the league's
 * saved rows, and each division's placed practices are counted per team of the league.
 *
 * Meta-checks keep it honest: the leagues must reach every verdict kind the property is about, and
 * the optimizer must place everything in some of them (or "unplaced" would hold by default). The
 * harness is shown able to fail: `reproduces the false alarm Codex found` is a hand-built league the
 * weekly-target comparison fails, and plant P6 (the comparison restored) turns the seeded run red.
 */
import { describe, it, expect } from 'vitest';

import {
  CAPACITY_VERDICT,
  buildCapacityDemand,
  firstWeekdayOnOrAfter,
} from '@squadlogic/core/practice/index.js';
import { runPracticeOptimizer } from '../supabase/functions/_shared/engines/auto-scheduler-solver.js';
import { planTeamsForRun } from '../supabase/functions/_shared/engines/practice-lock.js';
import { prepareTeam } from '../supabase/functions/_shared/engines/practice-coaches.js';
import { applySlotReservations } from '../supabase/functions/_shared/engines/practice-reservations.js';
import { toDaylightSlot } from '../supabase/functions/_shared/engines/practice-daylight.js';

const LIVE_FROM = '2026-10-05';
const SEASON = { start: '2026-09-07', end: '2026-11-29' };
const DAYS = ['mon', 'tue', 'wed', 'thu'];
const DAY_LABEL = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu' };
const SEEDS = 300;

// ---------------------------------------------------------------------------
// A league, from a seed
// ---------------------------------------------------------------------------

/** A small deterministic generator (mulberry32). */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (rand, list) => list[Math.floor(rand() * list.length)];
const between = (rand, lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
const clock = (minutes) =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}:00`;

/**
 * Divisions (1 to 3, 0 to 3 practices a week, a length or none), teams (1 to 4 each), slots (1 to 6 on
 * 1 to 4 weekdays, capacity 1 to 3, some expired, some starting later, some ending mid-season, some
 * reserved to a division or to one nobody has, some of another length) and saved practices (some on
 * expired slots, some with a part of the season, some over a team's count).
 */
function makeLeague(seed) {
  const rand = prng(seed);
  const divisions = Array.from({ length: between(rand, 1, 3) }, (_, i) => ({
    id: `d${i + 1}`,
    name: `D${i + 1}`,
    practicesPerWeek: pick(rand, [0, 1, 1, 2, 2, 3]),
    practiceMinutes: rand() < 0.4 ? pick(rand, [45, 60, 90]) : null,
  }));
  const teams = divisions.flatMap((division) =>
    Array.from({ length: between(rand, 1, 4) }, (_, j) => ({
      id: `${division.id}t${j + 1}`,
      divisionId: division.id,
    }))
  );
  const weekdays = DAYS.filter(() => rand() < 0.6);
  const pool = weekdays.length > 0 ? weekdays : [pick(rand, DAYS)];
  const slots = Array.from({ length: between(rand, 1, 6) }, (_, i) => {
    const minutes = pick(rand, [45, 60, 60, 90]);
    const kind = rand();
    const validity =
      kind < 0.68
        ? { validFrom: '2026-09-01', validUntil: '2026-11-30' }
        : kind < 0.8
          ? { validFrom: '2026-09-01', validUntil: '2026-09-29' }
          : kind < 0.88
            ? { validFrom: '2026-11-02', validUntil: '2026-11-30' }
            : { validFrom: '2026-09-01', validUntil: pick(rand, ['2026-10-06', '2026-10-20']) };
    return {
      id: `s${i + 1}`,
      dayOfWeek: pick(rand, pool),
      startTime: '17:00:00',
      endTime: clock(17 * 60 + minutes),
      capacity: between(rand, 1, 3),
      ...validity,
      divisionId:
        rand() < 0.2 ? pick(rand, [...divisions.map((division) => division.id), 'ghost']) : null,
    };
  });
  const assignments = [];
  for (const team of teams) {
    const rows = pick(rand, [0, 0, 1, 1, 2, 3]);
    for (let k = 0; k < rows; k += 1) {
      assignments.push({
        id: `r${assignments.length + 1}`,
        teamId: team.id,
        slotId: pick(rand, slots).id,
        effectiveDateRange: pick(rand, [
          null,
          null,
          null,
          '[2026-09-07,2026-09-30)',
          '[2026-10-05,2026-10-20)',
          '[2026-09-07,)',
        ]),
      });
    }
  }
  return { seed, divisions, teams, slots, assignments };
}

// ---------------------------------------------------------------------------
// Both sides, over one league
// ---------------------------------------------------------------------------

/** The slot as the page sends it to the run: instants of its first occurrence, in UTC. */
function runSlot(slot) {
  const first = firstWeekdayOnOrAfter(slot.validFrom, slot.dayOfWeek.toUpperCase());
  const start = new Date(`${first}T${slot.startTime}Z`);
  const end = new Date(`${first}T${slot.endTime}Z`);
  return { id: slot.id, day: DAY_LABEL[slot.dayOfWeek], start, end, capacity: slot.capacity };
}

/**
 * The panel's verdicts and the optimizer's result over one league. For each division: the verdict,
 * the practices still needed (the planner's units over the league's own teams), and the practices
 * the optimizer left unplaced (needed less placed, per team of the league).
 */
async function runBoth(league) {
  const panel = buildCapacityDemand({
    liveFrom: LIVE_FROM,
    season: SEASON,
    divisions: league.divisions,
    teams: league.teams,
    slots: league.slots,
    assignments: league.assignments,
  });
  const divisionOf = new Map(league.divisions.map((division) => [division.id, division]));
  const targets = new Map(
    league.teams.map((team) => [team.id, divisionOf.get(team.divisionId).practicesPerWeek])
  );
  const loaded = league.assignments.map((row) => ({
    id: row.id,
    teamId: row.teamId,
    slotId: row.slotId,
    effectiveDateRange: row.effectiveDateRange,
    assignedVia: null,
  }));
  const plan = planTeamsForRun(
    league.teams.map((team) => team.id),
    loaded,
    [],
    targets
  );
  const teams = league.teams.map((team) => ({
    ...prepareTeam({ id: team.id, division: team.divisionId, coachId: `c-${team.id}` }),
    practicesPerWeek: targets.get(team.id),
    practiceMinutes: divisionOf.get(team.divisionId).practiceMinutes,
  }));
  const slots = league.slots.map(runSlot);
  const applied = applySlotReservations(teams, slots, {
    slotDivision: new Map(league.slots.map((slot) => [slot.id, slot.divisionId])),
    teamDivision: new Map(league.teams.map((team) => [team.id, team.divisionId])),
    reservedDivisionIds: new Set(league.slots.map((slot) => slot.divisionId).filter(Boolean)),
  });
  const dating = {
    liveFrom: LIVE_FROM,
    slots: new Map(
      slots.map((slot, i) => [
        slot.id,
        toDaylightSlot(slot, 'UTC', {
          fieldId: `field-${slot.id}`,
          validUntil: league.slots[i].validUntil,
        }),
      ])
    ),
  };
  const result = await runPracticeOptimizer({
    teams: applied.teams,
    slots: applied.slots,
    locked: loaded.map((row) => ({
      assignmentId: row.id,
      teamId: row.teamId,
      slotId: row.slotId,
      effectiveDateRange: row.effectiveDateRange,
    })),
    placeableTeamIds: plan.placeable,
    unitsNeeded: plan.unitsNeeded,
    dating,
    config: { timeBudgetMs: 20000, maxIterations: 30, seed: 7 },
    cpuCapMs: Infinity,
  });
  const placedBy = new Map();
  for (const placement of result.placements) {
    placedBy.set(placement.teamId, (placedBy.get(placement.teamId) ?? 0) + 1);
  }
  return league.divisions.map((division) => {
    const own = league.teams.filter((team) => team.divisionId === division.id);
    const needed = own.reduce((sum, team) => sum + (plan.unitsNeeded[team.id] ?? 0), 0);
    const placed = own.reduce(
      (sum, team) => sum + Math.min(placedBy.get(team.id) ?? 0, plan.unitsNeeded[team.id] ?? 0),
      0
    );
    return {
      division,
      verdict: panel.divisions.find((row) => row.divisionId === division.id).verdict,
      needed,
      unplaced: needed - placed,
    };
  });
}

const CLAIMS_A_FAILURE = new Set([
  CAPACITY_VERDICT.SHORT,
  CAPACITY_VERDICT.NO_SLOT,
  CAPACITY_VERDICT.NOT_ENOUGH_DAYS,
]);

describe('the panel never claims a failure the optimizer does not have', () => {
  it('reproduces the false alarm Codex found: a practice held on an expired slot still counts toward the target', async () => {
    // 2 a week; the only team holds ONE practice, on an expired Monday; one live Tuesday slot. The
    // team still needs one practice and one weekday gives it: the run places it, nothing is left
    // over, and the panel must not say "too few weekdays".
    const league = {
      seed: 'hand-built',
      divisions: [{ id: 'd1', name: 'D1', practicesPerWeek: 2, practiceMinutes: null }],
      teams: [{ id: 'd1t1', divisionId: 'd1' }],
      slots: [
        {
          id: 's1',
          dayOfWeek: 'mon',
          startTime: '17:00:00',
          endTime: '18:00:00',
          capacity: 1,
          validFrom: '2026-09-01',
          validUntil: '2026-09-29',
          divisionId: null,
        },
        {
          id: 's2',
          dayOfWeek: 'tue',
          startTime: '17:00:00',
          endTime: '18:00:00',
          capacity: 1,
          validFrom: '2026-09-01',
          validUntil: '2026-11-30',
          divisionId: null,
        },
      ],
      assignments: [{ id: 'r1', teamId: 'd1t1', slotId: 's1', effectiveDateRange: null }],
    };
    const [result] = await runBoth(league);
    expect(result.needed).toBe(1);
    expect(result.unplaced).toBe(0);
    expect(CLAIMS_A_FAILURE.has(result.verdict.kind), JSON.stringify(result.verdict)).toBe(false);
  });

  it(`holds over ${SEEDS} seeded leagues: SHORT, NO_SLOT and NOT_ENOUGH_DAYS leave a practice unplaced`, async () => {
    const seen = {
      [CAPACITY_VERDICT.SHORT]: 0,
      [CAPACITY_VERDICT.NO_SLOT]: 0,
      [CAPACITY_VERDICT.NOT_ENOUGH_DAYS]: 0,
      everythingPlaced: 0,
      divisions: 0,
    };
    const violations = [];
    for (let seed = 1; seed <= SEEDS; seed += 1) {
      const league = makeLeague(seed);
      for (const result of await runBoth(league)) {
        seen.divisions += 1;
        if (result.needed > 0 && result.unplaced === 0) seen.everythingPlaced += 1;
        if (!CLAIMS_A_FAILURE.has(result.verdict.kind)) continue;
        seen[result.verdict.kind] += 1;
        if (result.unplaced === 0) {
          violations.push({
            seed,
            division: result.division.id,
            verdict: result.verdict,
            needed: result.needed,
          });
        }
      }
    }
    // The property, with the seeds that break it named so a failure can be replayed.
    expect(
      violations,
      `false alarms (replay with makeLeague(seed)): ${JSON.stringify(violations)}`
    ).toEqual([]);
    // The leagues must reach what the property is about, and the optimizer must sometimes succeed.
    expect(seen[CAPACITY_VERDICT.SHORT]).toBeGreaterThanOrEqual(15);
    expect(seen[CAPACITY_VERDICT.NO_SLOT]).toBeGreaterThanOrEqual(15);
    expect(seen[CAPACITY_VERDICT.NOT_ENOUGH_DAYS]).toBeGreaterThanOrEqual(5);
    expect(seen.everythingPlaced).toBeGreaterThanOrEqual(30);
  });

  it('is deterministic: a seed builds the same league, and the same league the same answer', async () => {
    expect(makeLeague(17)).toEqual(makeLeague(17));
    expect(makeLeague(17)).not.toEqual(makeLeague(18));
    expect(await runBoth(makeLeague(17))).toEqual(await runBoth(makeLeague(17)));
  });
});
