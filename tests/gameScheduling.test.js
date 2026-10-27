import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  buildDivisionRoundRobins,
  generateRoundRobinWeeks,
  savedSides,
  scheduleGames,
} from '../packages/core/src/gameScheduling.js';
import { evaluateGameSchedule } from '../packages/core/src/gameMetrics.js';

const SAMPLE_TEAMS = [
  { id: 'team-1', name: 'Team 1', division: 'U10', coachId: 'coach-a' },
  { id: 'team-2', name: 'Team 2', division: 'U10', coachId: 'coach-b' },
  { id: 'team-3', name: 'Team 3', division: 'U10', coachId: 'coach-c' },
  { id: 'team-4', name: 'Team 4', division: 'U10', coachId: 'coach-d' },
];

const SHARED_SLOTS = [
  {
    id: 'slot-week-1-field-a',
    weekIndex: 1,
    start: '2024-08-10T16:00:00Z',
    end: '2024-08-10T17:00:00Z',
    capacity: 1,
    fieldId: 'field-a',
  },
  {
    id: 'slot-week-1-field-b',
    weekIndex: 1,
    start: '2024-08-10T17:15:00Z',
    end: '2024-08-10T18:15:00Z',
    capacity: 1,
    fieldId: 'field-b',
  },
  {
    id: 'slot-week-2-field-a',
    weekIndex: 2,
    start: '2024-08-17T16:00:00Z',
    end: '2024-08-17T17:00:00Z',
    capacity: 1,
    fieldId: 'field-a',
  },
  {
    id: 'slot-week-2-field-b',
    weekIndex: 2,
    start: '2024-08-17T17:15:00Z',
    end: '2024-08-17T18:15:00Z',
    capacity: 1,
    fieldId: 'field-b',
  },
  {
    id: 'slot-week-3-field-a',
    weekIndex: 3,
    start: '2024-08-24T16:00:00Z',
    end: '2024-08-24T17:00:00Z',
    capacity: 1,
    fieldId: 'field-a',
  },
  {
    id: 'slot-week-3-field-b',
    weekIndex: 3,
    start: '2024-08-24T17:15:00Z',
    end: '2024-08-24T18:15:00Z',
    capacity: 1,
    fieldId: 'field-b',
  },
];

test('generateRoundRobinWeeks produces all matchups for even team counts', () => {
  const weeks = generateRoundRobinWeeks({ teamIds: ['team-3', 'team-1', 'team-2', 'team-4'] });
  assert.equal(weeks.length, 3);
  for (const week of weeks) {
    assert.equal(week.byes.length, 0);
    assert.equal(week.matchups.length, 2);
  }

  const encountered = new Set();
  for (const week of weeks) {
    for (const matchup of week.matchups) {
      const key = `${matchup.homeTeamId}-${matchup.awayTeamId}`;
      assert(!encountered.has(key), `duplicate matchup ${key}`);
      encountered.add(key);
    }
  }
  assert.equal(encountered.size, 6);
});

test('generateRoundRobinWeeks issues byes for odd team counts', () => {
  const weeks = generateRoundRobinWeeks({ teamIds: ['team-1', 'team-2', 'team-3'] });
  assert.equal(weeks.length, 3);

  const byeCounts = new Map();
  const matchups = new Set();

  for (const week of weeks) {
    assert.equal(week.matchups.length, 1);
    assert.equal(week.byes.length, 1);
    byeCounts.set(week.byes[0], (byeCounts.get(week.byes[0]) ?? 0) + 1);

    const matchup = week.matchups[0];
    const key = `${matchup.homeTeamId}-${matchup.awayTeamId}`;
    assert(!matchups.has(key));
    matchups.add(key);
  }

  assert.equal(byeCounts.size, 3);
  for (const count of byeCounts.values()) {
    assert.equal(count, 1);
  }
});

test('scheduleGames assigns matchups to earliest compatible slots', () => {
  const roundRobin = generateRoundRobinWeeks({ teamIds: SAMPLE_TEAMS.map((team) => team.id) });
  const { assignments, unscheduled } = scheduleGames({
    teams: SAMPLE_TEAMS,
    slots: SHARED_SLOTS,
    roundRobinByDivision: { U10: roundRobin },
  });

  assert.equal(assignments.length, 6);
  assert.equal(unscheduled.length, 0);

  const slotUsage = new Map();
  for (const assignment of assignments) {
    const key = `${assignment.weekIndex}-${assignment.slotId}`;
    assert(!slotUsage.has(key));
    slotUsage.set(key, assignment);
  }
});

test('scheduleGames marks matchups where a coach leads both teams', () => {
  const conflictTeams = [
    { id: 'team-a', name: 'Team A', division: 'U12', coachId: 'coach-shared' },
    { id: 'team-b', name: 'Team B', division: 'U12', coachId: 'coach-shared' },
    { id: 'team-c', name: 'Team C', division: 'U12', coachId: 'coach-other' },
  ];
  const roundRobin = generateRoundRobinWeeks({ teamIds: conflictTeams.map((team) => team.id) });

  const conflictSlots = [
    {
      id: 'slot-week-1',
      division: 'U12',
      weekIndex: 1,
      start: '2024-08-10T16:00:00Z',
      end: '2024-08-10T17:00:00Z',
      capacity: 1,
    },
    {
      id: 'slot-week-2',
      division: 'U12',
      weekIndex: 2,
      start: '2024-08-17T16:00:00Z',
      end: '2024-08-17T17:00:00Z',
      capacity: 1,
    },
    {
      id: 'slot-week-3',
      division: 'U12',
      weekIndex: 3,
      start: '2024-08-24T16:00:00Z',
      end: '2024-08-24T17:00:00Z',
      capacity: 1,
    },
  ];

  const { unscheduled } = scheduleGames({
    teams: conflictTeams,
    slots: conflictSlots,
    roundRobinByDivision: { U12: roundRobin },
  });

  assert(unscheduled.some((entry) => entry.reason === 'coach-coaches-both-teams'));
});

test('scheduleGames surfaces scheduling conflicts for coaches with multiple teams', () => {
  const teams = [
    { id: 'team-a', name: 'Team A', division: 'U12', coachId: 'coach-shared' },
    { id: 'team-b', name: 'Team B', division: 'U12', coachId: 'coach-unique-1' },
    { id: 'team-c', name: 'Team C', division: 'U14', coachId: 'coach-shared' },
    { id: 'team-d', name: 'Team D', division: 'U14', coachId: 'coach-unique-2' },
  ];

  const roundRobin = {
    U12: generateRoundRobinWeeks({ teamIds: ['team-a', 'team-b'] }),
    U14: generateRoundRobinWeeks({ teamIds: ['team-c', 'team-d'] }),
  };

  const conflictSlots = [
    {
      id: 'slot-u12-week-1',
      division: 'U12',
      weekIndex: 1,
      start: '2024-08-10T16:00:00Z',
      end: '2024-08-10T17:00:00Z',
      capacity: 1,
    },
    {
      id: 'slot-u14-week-1',
      division: 'U14',
      weekIndex: 1,
      start: '2024-08-10T16:30:00Z',
      end: '2024-08-10T17:30:00Z',
      capacity: 1,
    },
  ];

  const { assignments, unscheduled } = scheduleGames({
    teams,
    slots: conflictSlots,
    roundRobinByDivision: roundRobin,
  });

  assert.equal(assignments.length, 1);
  assert(unscheduled.some((entry) => entry.reason === 'coach-scheduling-conflict'));
});

test('scheduleGames prefers start times previously assigned to teams when slots allow', () => {
  const teams = SAMPLE_TEAMS;

  const slots = [
    {
      id: 'w1-early',
      weekIndex: 1,
      start: '2024-08-10T16:00:00Z',
      end: '2024-08-10T17:00:00Z',
      capacity: 1,
    },
    {
      id: 'w1-late',
      weekIndex: 1,
      start: '2024-08-10T17:30:00Z',
      end: '2024-08-10T18:30:00Z',
      capacity: 1,
    },
    {
      id: 'w2-early',
      weekIndex: 2,
      start: '2024-08-17T16:00:00Z',
      end: '2024-08-17T17:00:00Z',
      capacity: 1,
    },
    {
      id: 'w2-late',
      weekIndex: 2,
      start: '2024-08-17T17:30:00Z',
      end: '2024-08-17T18:30:00Z',
      capacity: 1,
    },
    {
      id: 'w3-early',
      weekIndex: 3,
      start: '2024-08-24T15:00:00Z',
      end: '2024-08-24T16:00:00Z',
      capacity: 1,
    },
    {
      id: 'w3-late',
      weekIndex: 3,
      start: '2024-08-24T17:30:00Z',
      end: '2024-08-24T18:30:00Z',
      capacity: 1,
    },
  ];

  const roundRobin = {
    U10: [
      {
        weekIndex: 1,
        matchups: [
          { homeTeamId: 'team-1', awayTeamId: 'team-2' },
          { homeTeamId: 'team-3', awayTeamId: 'team-4' },
        ],
        byes: [],
      },
      {
        weekIndex: 2,
        matchups: [
          { homeTeamId: 'team-2', awayTeamId: 'team-1' },
          { homeTeamId: 'team-4', awayTeamId: 'team-3' },
        ],
        byes: [],
      },
      {
        weekIndex: 3,
        matchups: [
          { homeTeamId: 'team-1', awayTeamId: 'team-4' },
          { homeTeamId: 'team-2', awayTeamId: 'team-3' },
        ],
        byes: [],
      },
    ],
  };

  const { assignments } = scheduleGames({ teams, slots, roundRobinByDivision: roundRobin });

  const team4Week3 = assignments.find(
    (assignment) =>
      assignment.weekIndex === 3 &&
      (assignment.homeTeamId === 'team-4' || assignment.awayTeamId === 'team-4')
  );

  assert(team4Week3, 'team 4 should have a week 3 assignment');
  assert.equal(team4Week3.start, '2024-08-24T17:30:00.000Z');

  const team3Week3 = assignments.find(
    (assignment) =>
      assignment.weekIndex === 3 &&
      (assignment.homeTeamId === 'team-3' || assignment.awayTeamId === 'team-3')
  );
  assert(team3Week3, 'team 3 should have a week 3 assignment');
  assert.equal(team3Week3.start, '2024-08-24T15:00:00.000Z');
});

test('scheduleGames balances shared slots across divisions when capacity allows rotation', () => {
  const u10Teams = [
    { id: 'u10-team-1', name: 'U10 Team 1', division: 'U10', coachId: 'coach-u10-1' },
    { id: 'u10-team-2', name: 'U10 Team 2', division: 'U10', coachId: 'coach-u10-2' },
    { id: 'u10-team-3', name: 'U10 Team 3', division: 'U10', coachId: 'coach-u10-3' },
  ];
  const u12Teams = [
    { id: 'u12-team-1', name: 'U12 Team 1', division: 'U12', coachId: 'coach-u12-1' },
    { id: 'u12-team-2', name: 'U12 Team 2', division: 'U12', coachId: 'coach-u12-2' },
    { id: 'u12-team-3', name: 'U12 Team 3', division: 'U12', coachId: 'coach-u12-3' },
  ];

  const roundRobinByDivision = {
    U10: generateRoundRobinWeeks({ teamIds: u10Teams.map((team) => team.id) }),
    U12: generateRoundRobinWeeks({ teamIds: u12Teams.map((team) => team.id) }),
  };

  const sharedSlots = [
    {
      id: 'shared-week-1-field-a',
      weekIndex: 1,
      start: '2024-08-10T16:00:00Z',
      end: '2024-08-10T17:00:00Z',
      capacity: 1,
      fieldId: 'field-a',
    },
    {
      id: 'shared-week-1-field-b',
      weekIndex: 1,
      start: '2024-08-10T17:15:00Z',
      end: '2024-08-10T18:15:00Z',
      capacity: 1,
      fieldId: 'field-b',
    },
    {
      id: 'shared-week-2-field-a',
      weekIndex: 2,
      start: '2024-08-17T16:00:00Z',
      end: '2024-08-17T17:00:00Z',
      capacity: 1,
      fieldId: 'field-a',
    },
    {
      id: 'shared-week-2-field-b',
      weekIndex: 2,
      start: '2024-08-17T17:15:00Z',
      end: '2024-08-17T18:15:00Z',
      capacity: 1,
      fieldId: 'field-b',
    },
    {
      id: 'shared-week-3-field-a',
      weekIndex: 3,
      start: '2024-08-24T16:00:00Z',
      end: '2024-08-24T17:00:00Z',
      capacity: 1,
      fieldId: 'field-a',
    },
    {
      id: 'shared-week-3-field-b',
      weekIndex: 3,
      start: '2024-08-24T17:15:00Z',
      end: '2024-08-24T18:15:00Z',
      capacity: 1,
      fieldId: 'field-b',
    },
  ];

  const { assignments, unscheduled, sharedSlotUsage } = scheduleGames({
    teams: [...u10Teams, ...u12Teams],
    slots: sharedSlots,
    roundRobinByDivision,
  });

  assert.equal(unscheduled.length, 0);

  assert.equal(sharedSlotUsage.length, sharedSlots.length);
  for (const usage of sharedSlotUsage) {
    assert.ok(usage.slotId.includes('shared-week'), 'expected slotId to be captured');
    assert.ok(usage.start.includes('2024-'), 'start timestamp should be serialized');
    assert.ok(usage.end.includes('2024-'), 'end timestamp should be serialized');
    assert.equal(typeof usage.weekIndex, 'number');
    assert.equal(typeof usage.totalAssignments, 'number');
  }

  const fieldUsageByDivision = new Map();
  for (const assignment of assignments) {
    if (!assignment.fieldId) {
      continue;
    }
    const usage = fieldUsageByDivision.get(assignment.division) ?? new Map();
    usage.set(assignment.fieldId, (usage.get(assignment.fieldId) ?? 0) + 1);
    fieldUsageByDivision.set(assignment.division, usage);
  }

  for (const division of ['U10', 'U12']) {
    const usage = fieldUsageByDivision.get(division) ?? new Map();
    const fieldA = usage.get('field-a') ?? 0;
    const fieldB = usage.get('field-b') ?? 0;
    assert(fieldA > 0 && fieldB > 0, `${division} should use both shared fields`);
    assert(
      Math.abs(fieldA - fieldB) <= 1,
      `${division} assignments should be balanced across shared fields`
    );
  }

  const aggregatedSharedUsage = new Map();
  for (const usage of sharedSlotUsage) {
    const fieldId = usage.fieldId ?? 'unassigned';
    const bucket = aggregatedSharedUsage.get(fieldId) ?? new Map();
    for (const divisionUsage of usage.divisionUsage) {
      bucket.set(
        divisionUsage.division,
        (bucket.get(divisionUsage.division) ?? 0) + divisionUsage.count
      );
    }
    aggregatedSharedUsage.set(fieldId, bucket);
  }

  for (const fieldId of ['field-a', 'field-b']) {
    const bucket = aggregatedSharedUsage.get(fieldId) ?? new Map();
    const counts = Array.from(bucket.values());
    assert.equal(counts.length, 2, `${fieldId} should track both divisions`);
    const max = Math.max(...counts);
    const min = Math.min(...counts);
    assert(max - min <= 1, `${fieldId} aggregated usage should stay balanced`);
  }
});

test('scheduleGames prioritizes slots with higher field priority', () => {
  const teams = [
    { id: 'team-a', name: 'Team A', division: 'U10', coachId: 'coach-1' },
    { id: 'team-b', name: 'Team B', division: 'U10', coachId: 'coach-2' },
  ];

  const roundRobin = generateRoundRobinWeeks({ teamIds: ['team-a', 'team-b'] }); // 1 matchup

  const slots = [
    {
      id: 'low-priority',
      weekIndex: 1,
      start: '2024-08-10T16:00:00Z',
      end: '2024-08-10T17:00:00Z',
      capacity: 1,
      fieldId: 'field-low',
      priority: 1,
    },
    {
      id: 'high-priority',
      weekIndex: 1,
      start: '2024-08-10T16:00:00Z',
      end: '2024-08-10T17:00:00Z',
      capacity: 1,
      fieldId: 'field-high',
      priority: 10,
    },
  ];

  const { assignments } = scheduleGames({
    teams,
    slots,
    roundRobinByDivision: { U10: roundRobin },
  });

  assert.equal(assignments.length, 1);
  assert.equal(assignments[0].slotId, 'high-priority', 'should choose high priority slot');
});

// ---- Home and away (Phase D, PR A: docs/changes/2026-10-27-phase-d-scheduling.md) ----

/** t01..tNN: ids in the order they sort. */
const orderedIds = (n) => Array.from({ length: n }, (_, i) => `t${String(i + 1).padStart(2, '0')}`);

/** A reproducible UUID-shaped id set (a seeded generator, so a failure replays). */
function uuidIds(n, seed) {
  let state = seed >>> 0 || 1;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
  const hex = (digits) =>
    Array.from({ length: digits }, () => (next() >>> 28).toString(16)).join('');
  return Array.from({ length: n }, () => `${hex(8)}-${hex(4)}-4${hex(3)}-8${hex(3)}-${hex(12)}`);
}

/**
 * Today's generator, as it was before this change: the same circle method with
 * the alphabetised pair's first id hosting, sorted by that host. It is the
 * reference the pairings and the placements are held to.
 */
function legacyRoundRobin(teamIds) {
  const rotation = [...teamIds].sort((a, b) => a.localeCompare(b));
  if (rotation.length % 2 === 1) rotation.push('__BYE__');
  const total = rotation.length;
  const weeks = [];
  for (let week = 0; week < total - 1; week += 1) {
    const matchups = [];
    const byes = [];
    for (let i = 0; i < total / 2; i += 1) {
      const a = rotation[i];
      const b = rotation[total - 1 - i];
      if (a === '__BYE__' || b === '__BYE__') {
        byes.push(a === '__BYE__' ? b : a);
        continue;
      }
      const [homeTeamId, awayTeamId] = [a, b].sort((x, y) => x.localeCompare(y));
      matchups.push({ homeTeamId, awayTeamId });
    }
    matchups.sort(
      (x, y) => x.homeTeamId.localeCompare(y.homeTeamId) || x.awayTeamId.localeCompare(y.awayTeamId)
    );
    weeks.push({ weekIndex: week + 1, matchups, byes });
    const [first, ...rest] = rotation;
    rest.unshift(rest.pop());
    rotation.splice(0, rotation.length, first, ...rest);
  }
  return weeks;
}

const alphabetised = (m) => [m.homeTeamId, m.awayTeamId].sort((x, y) => x.localeCompare(y));

/** Per team: games, home games, and the longest run of one side across its games in week order. */
function sideTable(weeks, teamIds) {
  const table = new Map(
    teamIds.map((id) => [id, { games: 0, home: 0, run: 0, last: null, now: 0 }])
  );
  for (const week of weeks) {
    for (const { homeTeamId, awayTeamId } of week.matchups) {
      for (const [id, side] of [
        [homeTeamId, 'home'],
        [awayTeamId, 'away'],
      ]) {
        const row = table.get(id);
        row.games += 1;
        if (side === 'home') row.home += 1;
        row.now = row.last === side ? row.now + 1 : 1;
        row.last = side;
        row.run = Math.max(row.run, row.now);
      }
    }
  }
  return table;
}

const SIZES = Array.from({ length: 15 }, (_, i) => i + 2);

for (const label of ['ordered ids', 'shuffled UUIDs']) {
  test(`home and away is balanced for n = 2..16 (${label}): spread <= 1, odd n exactly (n-1)/2, runs <= 2`, () => {
    for (const n of SIZES) {
      // Several id sets per size for UUIDs: where an id sorts must not matter.
      const trials = label === 'ordered ids' ? 1 : 25;
      for (let trial = 0; trial < trials; trial += 1) {
        const teamIds = label === 'ordered ids' ? orderedIds(n) : uuidIds(n, 1000 * n + trial);
        const weeks = generateRoundRobinWeeks({ teamIds });
        const table = sideTable(weeks, teamIds);
        const homes = [...table.values()].map((row) => row.home);
        const where = `n=${n}, trial ${trial}`;
        for (const [id, row] of table) {
          assert.equal(row.games, n - 1, `${where}: ${id} plays everyone once`);
          assert.ok(row.run <= 2, `${where}: ${id} has a run of ${row.run}`);
          if (n % 2 === 1) assert.equal(row.home, (n - 1) / 2, `${where}: ${id} hosts (n-1)/2`);
        }
        assert.ok(Math.max(...homes) - Math.min(...homes) <= 1, `${where}: spread ${homes}`);
        // Every pair meets exactly once.
        const pairs = new Set(
          weeks.flatMap((w) => w.matchups.map((m) => alphabetised(m).join('|')))
        );
        assert.equal(pairs.size, (n * (n - 1)) / 2, `${where}: one meeting per pair`);
      }
    }
  });
}

test("the pairings, byes and week of every meeting are today's: only the side changes", () => {
  for (const n of SIZES) {
    const teamIds = uuidIds(n, 77 + n);
    const now = generateRoundRobinWeeks({ teamIds });
    const before = legacyRoundRobin(teamIds);
    assert.equal(now.length, before.length);
    now.forEach((week, index) => {
      assert.deepEqual(
        week.matchups.map((m) => alphabetised(m)),
        before[index].matchups.map((m) => alphabetised(m)),
        `n=${n} week ${week.weekIndex}: same pairs in the same order`
      );
      assert.deepEqual(week.byes, before[index].byes, `n=${n} week ${week.weekIndex}: same byes`);
    });
  }
});

/** A tight slot grid: one game a week fewer than there are matchups, so who is dropped depends on order. */
function tightPlacement(teamIds, weeks) {
  const n = teamIds.length;
  const matchupsPerWeek = Math.floor(n / 2);
  const capacity = Math.max(1, matchupsPerWeek - 1);
  const sharedCapacity = Math.ceil(capacity / 2);
  const divisionCapacity = capacity - sharedCapacity;
  const teams = teamIds.map((id, index) => ({
    id,
    name: id,
    division: 'U10',
    // The last team shares the first team's coach, so coach clashes steer placement too.
    coachId: index === n - 1 && n > 2 ? 'coach-0' : `coach-${index}`,
  }));
  const slots = [];
  for (let week = 1; week < n + 1; week += 1) {
    const day = String(week).padStart(2, '0');
    slots.push({
      id: `shared-${week}`,
      weekIndex: week,
      start: `2026-09-${day}T14:00:00Z`,
      end: `2026-09-${day}T15:00:00Z`,
      capacity: sharedCapacity,
      fieldId: 'field-shared',
      priority: 2,
    });
    if (divisionCapacity > 0) {
      slots.push({
        id: `div-${week}`,
        division: 'U10',
        weekIndex: week,
        start: `2026-09-${day}T15:30:00Z`,
        end: `2026-09-${day}T16:30:00Z`,
        capacity: divisionCapacity,
        fieldId: 'field-div',
        priority: 1,
      });
    }
  }
  const result = scheduleGames({ teams, slots, roundRobinByDivision: { U10: weeks } });
  const placed = result.assignments
    .map((a) => `${a.weekIndex}|${a.slotId}|${a.fieldId}|${alphabetised(a).join('|')}`)
    .sort();
  const dropped = result.unscheduled
    .map((u) => `${u.weekIndex}|${alphabetised(u.matchup).join('|')}|${u.reason}`)
    .sort();
  return { placed, dropped };
}

const resortedByHome = (weeks) =>
  weeks.map((week) => ({
    ...week,
    matchups: [...week.matchups].sort(
      (x, y) => x.homeTeamId.localeCompare(y.homeTeamId) || x.awayTeamId.localeCompare(y.awayTeamId)
    ),
  }));

test('scheduleGames places every pair in the same week, slot and field as it did before the sides changed', () => {
  let resortDiffers = 0;
  for (const n of SIZES) {
    const teamIds = uuidIds(n, 500 + n);
    const today = tightPlacement(teamIds, legacyRoundRobin(teamIds));
    const weeks = generateRoundRobinWeeks({ teamIds });
    const now = tightPlacement(teamIds, weeks);
    assert.deepEqual(now.placed, today.placed, `n=${n}: same (week, slot, field, pair) set`);
    assert.deepEqual(now.dropped, today.dropped, `n=${n}: the same pairs are left unscheduled`);
    if (n >= 4) assert.ok(now.placed.length > 0 && now.dropped.length > 0, `n=${n}: grid is tight`);
    // The control: the order this test exists to protect does matter. Re-sorted
    // by the new host, some sizes place differently, so equality above is not vacuous.
    const resorted = tightPlacement(teamIds, resortedByHome(weeks));
    if (JSON.stringify(resorted) !== JSON.stringify(today)) resortDiffers += 1;
  }
  assert.ok(resortDiffers > 0, 'sorting by host would have moved a pair; the test can fail');
});

test("a generated 4-team schedule raises no home-away-imbalance (today's raises one)", () => {
  const teamIds = orderedIds(4);
  const imbalancesOf = (weeks) => {
    const teams = teamIds.map((id) => ({ id, name: id, division: 'U10', coachId: `c-${id}` }));
    const assignments = weeks.flatMap((week) =>
      week.matchups.map((m, index) => ({
        weekIndex: week.weekIndex,
        division: 'U10',
        slotId: `s-${week.weekIndex}-${index}`,
        fieldId: `f-${week.weekIndex}-${index}`,
        start: `2026-09-${String(week.weekIndex).padStart(2, '0')}T14:00:00Z`,
        end: `2026-09-${String(week.weekIndex).padStart(2, '0')}T15:00:00Z`,
        homeTeamId: m.homeTeamId,
        awayTeamId: m.awayTeamId,
      }))
    );
    return evaluateGameSchedule({ assignments, teams }).warnings.filter(
      (w) => w.type === 'home-away-imbalance'
    );
  };
  assert.deepEqual(imbalancesOf(generateRoundRobinWeeks({ teamIds })), []);
  // The defect this fixes, seen through the same warning: t01 hosted all three.
  assert.ok(imbalancesOf(legacyRoundRobin(teamIds)).length >= 1);
});

test('keepSides makes the named team host that pair and leaves the rest to the rule', () => {
  const teamIds = ['team-1', 'team-2', 'team-3', 'team-4'];
  const hosts = (weeks) =>
    new Map(weeks.flatMap((w) => w.matchups).map((m) => [alphabetised(m).join('|'), m.homeTeamId]));
  const plain = hosts(generateRoundRobinWeeks({ teamIds }));
  const kept = generateRoundRobinWeeks({
    teamIds,
    keepSides: [{ homeTeamId: 'team-2', awayTeamId: 'team-1' }],
  });
  const after = hosts(kept);
  assert.equal(plain.get('team-1|team-2'), 'team-1', 'the rule alone has team-1 host');
  assert.equal(after.get('team-1|team-2'), 'team-2', 'the kept side wins');
  for (const [pair, host] of plain) {
    if (pair !== 'team-1|team-2') assert.equal(after.get(pair), host, `${pair} is untouched`);
  }
  // A kept side moves no pair: the weeks, order and byes are the unkept ones.
  const unkept = generateRoundRobinWeeks({ teamIds });
  assert.deepEqual(
    kept.map((w) => w.matchups.map(alphabetised)),
    unkept.map((w) => w.matchups.map(alphabetised))
  );
  // Keeping the side the rule already gives changes nothing at all.
  assert.deepEqual(
    generateRoundRobinWeeks({
      teamIds,
      keepSides: [{ homeTeamId: 'team-1', awayTeamId: 'team-2' }],
    }),
    unkept
  );
});

test('keepSides refuses malformed entries, unknown teams and a pair named twice', () => {
  const teamIds = ['team-1', 'team-2', 'team-3'];
  const throws = (keepSides, pattern) =>
    assert.throws(() => generateRoundRobinWeeks({ teamIds, keepSides }), pattern);
  throws('team-1', /keepSides must be an array/);
  throws([null], /entries must be objects/);
  throws([{ homeTeamId: 'team-1' }], /string homeTeamId and awayTeamId/);
  throws([{ homeTeamId: 1, awayTeamId: 'team-2' }], /string homeTeamId and awayTeamId/);
  throws([{ homeTeamId: 'team-1', awayTeamId: 'team-1' }], /both sides/);
  throws([{ homeTeamId: 'team-1', awayTeamId: 'team-9' }], /team-9, which is not in teamIds/);
  throws(
    [
      { homeTeamId: 'team-1', awayTeamId: 'team-2' },
      { homeTeamId: 'team-2', awayTeamId: 'team-1' },
    ],
    /more than once/
  );
  // An empty list is the default, not an error.
  assert.doesNotThrow(() => generateRoundRobinWeeks({ teamIds, keepSides: [] }));
});

test('every pair of a saved schedule can be kept, and the rule then agrees with the save', () => {
  const teamIds = orderedIds(6);
  const saved = generateRoundRobinWeeks({ teamIds }).flatMap((w) => w.matchups);
  // Flip every saved side: the kept sides must win everywhere.
  const flipped = saved.map(({ homeTeamId, awayTeamId }) => ({
    homeTeamId: awayTeamId,
    awayTeamId: homeTeamId,
  }));
  const again = generateRoundRobinWeeks({ teamIds, keepSides: flipped }).flatMap((w) => w.matchups);
  const sideOf = (list) => new Map(list.map((m) => [alphabetised(m).join('|'), m.homeTeamId]));
  const wanted = sideOf(flipped);
  for (const [pair, host] of sideOf(again)) assert.equal(host, wanted.get(pair), pair);
});

test('savedSides keeps one entry per pair, from the earliest week, whatever order rows arrive in', () => {
  const rows = [
    { homeTeamId: 'b', awayTeamId: 'a', weekIndex: 4 },
    { homeTeamId: 'a', awayTeamId: 'b', weekIndex: 2 },
    { homeTeamId: 'c', awayTeamId: 'a', weekIndex: 1 },
    { homeTeamId: null, awayTeamId: 'a', weekIndex: 1 },
    { homeTeamId: 'd', awayTeamId: 'd', weekIndex: 1 },
    {},
  ];
  const expected = [
    { homeTeamId: 'a', awayTeamId: 'b' },
    { homeTeamId: 'c', awayTeamId: 'a' },
  ];
  const sorted = (list) => [...list].sort((x, y) => x.homeTeamId.localeCompare(y.homeTeamId));
  assert.deepEqual(sorted(savedSides(rows)), expected);
  assert.deepEqual(sorted(savedSides([...rows].reverse())), expected);
  assert.throws(() => savedSides(null), /assignments must be an array/);
});

test('buildDivisionRoundRobins gives each division only the kept sides whose two teams it holds', () => {
  const teams = [
    { id: 'u10-1', division: 'U10' },
    { id: 'u10-2', division: 'U10' },
    { id: 'u12-1', division: 'U12' },
    { id: 'u12-2', division: 'U12' },
  ];
  const { roundRobinByDivision } = buildDivisionRoundRobins(teams, {
    keepSides: [
      { homeTeamId: 'u10-2', awayTeamId: 'u10-1' },
      // Across two divisions (a team moved since the save), and a team that is gone: nothing to keep.
      { homeTeamId: 'u12-1', awayTeamId: 'u10-1' },
      { homeTeamId: 'gone', awayTeamId: 'u12-2' },
    ],
  });
  assert.equal(roundRobinByDivision.U10[0].matchups[0].homeTeamId, 'u10-2');
  assert.equal(roundRobinByDivision.U12[0].matchups[0].homeTeamId, 'u12-1');
});
