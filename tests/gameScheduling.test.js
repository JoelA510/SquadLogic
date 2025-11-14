import test from 'node:test';
import assert from 'node:assert/strict';
import { generateRoundRobinWeeks, scheduleGames } from '../src/gameScheduling.js';

const SAMPLE_TEAMS = [
  { id: 'team-1', division: 'U10', coachId: 'coach-a' },
  { id: 'team-2', division: 'U10', coachId: 'coach-b' },
  { id: 'team-3', division: 'U10', coachId: 'coach-c' },
  { id: 'team-4', division: 'U10', coachId: 'coach-d' },
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

test('scheduleGames marks unscheduled matchups when coach conflicts prevent assignment', () => {
  const conflictTeams = [
    { id: 'team-a', division: 'U12', coachId: 'coach-shared' },
    { id: 'team-b', division: 'U12', coachId: 'coach-shared' },
    { id: 'team-c', division: 'U12', coachId: 'coach-other' },
  ];
  const roundRobin = generateRoundRobinWeeks({ teamIds: conflictTeams.map((team) => team.id) });

  const conflictSlots = [
    {
      id: 'slot-week-1-shared',
      division: 'U12',
      weekIndex: 1,
      start: '2024-08-10T16:00:00Z',
      end: '2024-08-10T17:00:00Z',
      capacity: 1,
    },
    {
      id: 'slot-week-1-late',
      division: 'U12',
      weekIndex: 1,
      start: '2024-08-10T16:30:00Z',
      end: '2024-08-10T17:30:00Z',
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

  const { assignments, unscheduled, byes } = scheduleGames({
    teams: conflictTeams,
    slots: conflictSlots,
    roundRobinByDivision: { U12: roundRobin },
  });

  assert(assignments.length > 0);
  assert(unscheduled.some((entry) => entry.reason === 'coach-conflict'));
  assert.equal(byes.length, 3);
});
