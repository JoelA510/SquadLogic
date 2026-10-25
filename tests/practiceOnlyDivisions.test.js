/**
 * D2 of `docs/changes/2026-10-22-demo-mode.md`, the core half: a practice-only
 * division (`divisions.plays_games = false`) gets no fixture and is not counted
 * unscheduled, and a reserved practice slot (`practice_slots.division_id`) goes
 * only to its division, whose teams use only their reserved slots. The demo
 * league's U4 is the shape: four cohorts, one 30-minute session a week each,
 * one at a time, 15 minutes apart (`fixtures/demo-2026/README.md`).
 *
 * Every subject set is enumerated from the roster the test builds, never from
 * the scheduler's output.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { buildDivisionRoundRobins, scheduleGames } from '../packages/core/src/gameScheduling.js';
import { evaluateGameSchedule } from '../packages/core/src/gameMetrics.js';
import {
  RESERVATION_REASON,
  reservationRefusal,
  reservedDivisionIdsOf,
  schedulePractices,
} from '../packages/core/src/practiceScheduling.js';
import { optimizePracticeSchedule } from '../packages/core/src/autoScheduler.js';
import { buildPracticeSlotsFromSupabaseRows } from '../packages/core/src/practiceSupabase.js';

const U4 = 'div-u4';
const U10 = 'div-u10';

// ---------------------------------------------------------------------------
// Games
// ---------------------------------------------------------------------------

const COHORTS = ['U4A', 'U4B', 'U4C', 'U4D'].map((name, i) => ({
  id: `t-u4-${i + 1}`,
  name,
  division: 'U4',
  divisionId: U4,
  coachId: `c-u4-${i + 1}`,
  playsGames: false,
}));
const U10_TEAMS = [1, 2, 3, 4].map((n) => ({
  id: `t-u10-${n}`,
  name: `U10 ${n}`,
  division: 'U10',
  divisionId: U10,
  coachId: `c-u10-${n}`,
  playsGames: true,
}));

/** Four shared Saturday slots a week for three weeks: room for both divisions. */
const GAME_SLOTS = [1, 2, 3].flatMap((week) =>
  ['a', 'b', 'c', 'd'].map((field, i) => ({
    id: `g-${week}-${field}`,
    weekIndex: week,
    start: `2026-09-${String(4 + week * 7).padStart(2, '0')}T${String(14 + i).padStart(2, '0')}:00:00Z`,
    end: `2026-09-${String(4 + week * 7).padStart(2, '0')}T${String(15 + i).padStart(2, '0')}:00:00Z`,
    capacity: 1,
    fieldId: `field-${field}`,
  }))
);

/** @param {Array<any>} teams */
function runGames(teams) {
  const { roundRobinByDivision, gameTeams, practiceOnlyDivisions } =
    buildDivisionRoundRobins(teams);
  const result = scheduleGames({ teams: gameTeams, slots: GAME_SLOTS, roundRobinByDivision });
  const evaluation = evaluateGameSchedule({
    assignments: result.assignments,
    teams: gameTeams,
    byes: result.byes,
    unscheduled: result.unscheduled,
    sharedSlotUsage: result.sharedSlotUsage,
  });
  return { result, evaluation, practiceOnlyDivisions, gameTeams, roundRobinByDivision };
}

const namesU4 = (value) => COHORTS.some((team) => JSON.stringify(value).includes(team.id));

describe('D2 games :: a practice-only division plays none and is not unscheduled', () => {
  it('builds U4 no round robin, schedules it no fixture and leaves none of it unscheduled', () => {
    const { result, evaluation, practiceOnlyDivisions, gameTeams, roundRobinByDivision } = runGames(
      [...COHORTS, ...U10_TEAMS]
    );
    assert.deepEqual(Object.keys(roundRobinByDivision), ['U10']);
    assert.deepEqual(practiceOnlyDivisions, [
      { division: 'U4', teamIds: COHORTS.map((t) => t.id).sort() },
    ]);
    assert.deepEqual(
      gameTeams.map((t) => t.id),
      U10_TEAMS.map((t) => t.id)
    );
    // U10 still plays: three weeks of a four-team round robin, two games each.
    assert.equal(result.assignments.length, 6);
    assert.equal(result.unscheduled.length, 0);
    for (const value of [result.assignments, result.unscheduled, result.byes, evaluation]) {
      assert.equal(namesU4(value), false, 'a U4 cohort appears in the game schedule');
    }
  });

  it('CONTROL: with the flag ignored the same cohorts get fixtures, so the check above can fail', () => {
    const { result, practiceOnlyDivisions } = runGames(
      [...COHORTS, ...U10_TEAMS].map(({ playsGames: _ignored, ...team }) => team)
    );
    assert.deepEqual(practiceOnlyDivisions, []);
    assert.equal(namesU4([result.assignments, result.unscheduled]), true);
  });

  it('reads an absent flag as playing (the column default), and gives a lone team no round robin', () => {
    const { roundRobinByDivision, practiceOnlyDivisions } = buildDivisionRoundRobins([
      { id: 'a', division: 'U8' },
      { id: 'b', division: 'U8', playsGames: true },
      { id: 'solo', division: 'U19' },
    ]);
    assert.deepEqual(Object.keys(roundRobinByDivision), ['U8']);
    assert.deepEqual(practiceOnlyDivisions, []);
    assert.throws(() => buildDivisionRoundRobins(null), /teams must be an array/);
  });
});

// ---------------------------------------------------------------------------
// Practices
// ---------------------------------------------------------------------------

/**
 * A Saturday practice slot on 2026-09-05, `HH:MM` to `HH:MM` UTC.
 *
 * @param {string} id
 * @param {string} from
 * @param {string} to
 * @param {{ divisionId?: string, capacity?: number }} [options]
 * @returns {any}
 */
function slot(id, from, to, { divisionId, capacity = 1 } = {}) {
  return {
    id,
    day: 'Saturday',
    start: new Date(`2026-09-05T${from}:00.000Z`),
    end: new Date(`2026-09-05T${to}:00.000Z`),
    capacity,
    ...(divisionId ? { divisionId } : {}),
  };
}

/** Four reserved 30-minute cohort slots, 45 minutes apart (15 between). */
const COHORT_SLOTS = [
  slot('u4-0900', '09:00', '09:30', { divisionId: U4 }),
  slot('u4-0945', '09:45', '10:15', { divisionId: U4 }),
  slot('u4-1030', '10:30', '11:00', { divisionId: U4 }),
  slot('u4-1115', '11:15', '11:45', { divisionId: U4 }),
];

const reservedSlotIds = new Set(COHORT_SLOTS.map((s) => s.id));

describe('D2 practices :: reserved slots go only to their division', () => {
  it('gives each of the four U4 cohorts one of its four reserved sessions', () => {
    const { assignments, unassigned } = schedulePractices({
      teams: COHORTS,
      slots: COHORT_SLOTS,
    });
    assert.deepEqual(unassigned, []);
    const byTeam = new Map(assignments.map((a) => [a.teamId, a.slotId]));
    for (const team of COHORTS) {
      assert.ok(reservedSlotIds.has(byTeam.get(team.id)), `${team.name} has no U4 session`);
    }
    assert.equal(new Set(byTeam.values()).size, 4, 'two cohorts share a session');
  });

  it('keeps the reserved sessions for U4 when another division has nowhere else to go', () => {
    // Two U10 teams, one open slot: U10 cannot spill onto U4's sessions, and
    // U4 cannot spill onto the open slot even with room on it.
    const open = slot('open-1700', '17:00', '18:00', { capacity: 6 });
    const { assignments, unassigned } = schedulePractices({
      teams: [...COHORTS, ...U10_TEAMS.slice(0, 2)],
      slots: [...COHORT_SLOTS, { ...open, capacity: 1 }],
    });
    const byTeam = new Map(assignments.map((a) => [a.teamId, a.slotId]));
    for (const team of COHORTS) {
      assert.ok(reservedSlotIds.has(byTeam.get(team.id)), `${team.name} left its sessions`);
    }
    const u10Placed = U10_TEAMS.slice(0, 2).filter((t) => byTeam.has(t.id));
    assert.equal(u10Placed.length, 1);
    assert.equal(byTeam.get(u10Placed[0].id), 'open-1700');
    assert.deepEqual(
      unassigned.map((u) => [u.teamId, u.reason]),
      [[U10_TEAMS.slice(0, 2).find((t) => !byTeam.has(t.id)).id, 'no available capacity']]
    );
  });

  it('leaves a division with reserved slots off open ground, and names the reservation when it has none left', () => {
    // A fifth U4 cohort: the four sessions are full, and the open slot is
    // not U4's. A U10 team with only reserved slots on offer is named too.
    const fifth = { ...COHORTS[0], id: 't-u4-5', name: 'U4E', coachId: 'c-u4-5' };
    const { assignments, unassigned } = schedulePractices({
      teams: [...COHORTS, fifth],
      slots: [...COHORT_SLOTS, slot('open-1700', '17:00', '18:00', { capacity: 4 })],
    });
    assert.equal(
      assignments.some((a) => a.slotId === 'open-1700'),
      false
    );
    assert.deepEqual(
      unassigned.map((u) => u.reason),
      ['no available capacity']
    );
    const lone = schedulePractices({ teams: [U10_TEAMS[0]], slots: COHORT_SLOTS });
    assert.deepEqual(
      lone.unassigned.map((u) => [u.teamId, u.reason]),
      [[U10_TEAMS[0].id, 'no practice slot is open to this division (reservations)']]
    );
  });

  it('CONTROL: without the reservations the open slot takes U4 and U10 takes a session', () => {
    const strip = (s) => ({ ...s, divisionId: undefined });
    const { assignments } = schedulePractices({
      teams: [...COHORTS, ...U10_TEAMS],
      slots: [...COHORT_SLOTS.map(strip), slot('open-1700', '17:00', '18:00', { capacity: 4 })],
    });
    const u10InSession = assignments.some(
      (a) => a.teamId.startsWith('t-u10') && reservedSlotIds.has(a.slotId)
    );
    assert.equal(u10InSession, true);
  });

  it('holds the reservation through the optimiser that mutates the seed', () => {
    const teams = [...COHORTS, ...U10_TEAMS];
    const slots = [...COHORT_SLOTS, slot('open-1700', '17:00', '18:00', { capacity: 4 })];
    const result = optimizePracticeSchedule({
      teams,
      slots,
      config: { maxIterations: 400, timeBudgetMs: 5000, seed: 7 },
    });
    for (const assignment of result.assignments) {
      const isU4 = assignment.teamId.startsWith('t-u4');
      assert.equal(reservedSlotIds.has(assignment.slotId), isU4, JSON.stringify(assignment));
    }
    assert.equal(result.assignments.length, 8);
  });

  it('matches by division id: a team with none is refused a reserved slot and held to none', () => {
    const reserved = reservedDivisionIdsOf([...COHORT_SLOTS, { id: 'x', divisionId: '  ' }]);
    assert.deepEqual([...reserved], [U4]);
    assert.equal(
      reservationRefusal({ divisionId: null }, COHORT_SLOTS[0], reserved),
      RESERVATION_REASON.RESERVED_FOR_ANOTHER_DIVISION
    );
    assert.equal(reservationRefusal({ divisionId: null }, { id: 'open' }, reserved), null);
    assert.equal(reservationRefusal({ divisionId: U4 }, COHORT_SLOTS[0], reserved), null);
    assert.equal(
      reservationRefusal({ divisionId: U4 }, { id: 'open' }, reserved),
      RESERVATION_REASON.OUTSIDE_DIVISION_RESERVATION
    );
    assert.equal(reservationRefusal({ divisionId: U10 }, { id: 'open' }, reserved), null);
  });

  it('reads the reservation off a stored slot row, and leaves a slot without one unchanged', () => {
    const [reservedRow, openRow] = buildPracticeSlotsFromSupabaseRows([
      {
        id: 'ps-1',
        day_of_week: 'sat',
        start_time: '09:00',
        end_time: '09:30',
        valid_from: '2026-09-05',
        valid_until: '2026-11-28',
        capacity: 1,
        division_id: U4,
      },
      {
        id: 'ps-2',
        day_of_week: 'sat',
        start_time: '10:00',
        end_time: '10:30',
        valid_from: '2026-09-05',
        valid_until: '2026-11-28',
        capacity: 1,
        division_id: null,
      },
    ]);
    assert.equal(reservedRow.divisionId, U4);
    assert.equal('divisionId' in openRow, false);
  });
});
