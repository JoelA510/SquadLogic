// @vitest-environment node
import { runOptimizerJob } from '../frontend/src/workers/practiceOptimizer.worker.js';
import { encodeSolverInput } from '../supabase/functions/_shared/engines/solver-input.ts';
import { outsideHoldsFor } from '../supabase/functions/_shared/engines/practice-lock.ts';
import Papa from 'papaparse';
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  runPracticeOptimizer,
  verifyPracticePlacements,
} from '../supabase/functions/_shared/engines/auto-scheduler-solver.ts';
import { prepareTeam } from '../supabase/functions/_shared/engines/practice-coaches.ts';
const teamId = 'pair-team';
function slot(id, day, fieldId = 'pitch', startHour = 16, subunitId = null) {
  const start = new Date(Date.UTC(2026, 8, 7 + day, startHour));
  return {
    id,
    day: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'][day],
    fieldId,
    subunitId,
    start,
    end: new Date(+start + 3600000),
    capacity: 1,
  };
}
function world(slots, held = null) {
  const teams = [
    {
      ...prepareTeam({ id: teamId, division: 'U10', coachId: 'pair-coach' }),
      practicePairs: ['mon-wed'],
      practicesPerWeek: 2,
    },
  ];
  const dating = {
    liveFrom: '2026-09-07',
    slots: new Map(
      slots.map((s) => [
        s.id,
        {
          firstDate: s.start.toISOString().slice(0, 10),
          effectiveUntil: '2026-11-29',
          startSeconds: s.start.getUTCHours() * 3600,
          endSeconds: s.end.getUTCHours() * 3600,
        },
      ])
    ),
  };
  return {
    teams,
    slots,
    dating,
    locked: held
      ? [
          {
            assignmentId: 'held',
            teamId,
            slotId: held,
            effectiveDateRange: '[2026-09-07,2026-11-30)',
          },
        ]
      : [],
    placeableTeamIds: [teamId],
    unitsNeeded: { [teamId]: held ? 1 : 2 },
    config: { seed: 42, maxIterations: 80, timeBudgetMs: 20000 },
  };
}
describe('paired practice days', () => {
  it('seats both matching slots even when a different weekday is first', async () => {
    const input = world([slot('t', 1), slot('m', 0), slot('w', 2)]);
    const result = await runPracticeOptimizer(input);
    expect(result.placements.map((p) => p.slotId).sort()).toEqual(['m', 'w']);
    const messages = [];
    await runOptimizerJob(
      {
        type: 'run',
        input: encodeSolverInput(input, {
          organizationId: 'fixture-org',
          seasonSettingsId: 'fixture-season',
        }),
        config: input.config,
      },
      (message) => messages.push(message)
    );
    expect(messages.at(-1).type).toBe('result');
    expect(messages.at(-1).placements).toEqual(
      result.placements.map(({ source: _source, ...p }) => p)
    );
    expect(verifyPracticePlacements({ ...input, placements: result.placements }).refused).toEqual(
      []
    );
    const partial = verifyPracticePlacements({
      ...input,
      placements: result.placements.slice(0, 1),
    });
    expect(partial.placements).toEqual([]);
    expect(partial.refused[0].rule).toBe('pairing');
  });
  it.each([
    ['wrong day', slot('other', 3)],
    ['other field', slot('other', 2, 'south')],
    ['other half', slot('other', 2, 'pitch', 16, 'half')],
    ['later start', slot('other', 2, 'pitch', 17)],
  ])('leaves both units unplaced for %s', async (_, other) => {
    const result = await runPracticeOptimizer(world([slot('m', 0), other]));
    expect(result.placements).toEqual([]);
    expect(result.unassigned.map((p) => p.reason)).toEqual([
      'no-slot-available',
      'no-slot-available',
    ]);
  });
  it('fills only the held practice’s partner', async () => {
    const result = await runPracticeOptimizer(
      world([slot('m', 0), slot('t', 1), slot('w', 2)], 'm')
    );
    expect(result.placements.map((p) => p.slotId)).toEqual(['w']);
  });
});

it('reproduces the PR 9 fixture’s Tuesday/Thursday series on its pitch half', async () => {
  const csv = readFileSync('fixtures/practice-schedule-2026/practice-schedule.csv', 'utf8');
  const rows = Papa.parse(csv, { header: true, skipEmptyLines: true }).data.filter(
    (r) => r.Team === 'U05G-04'
  );
  const slots = rows.map((r) => {
    const s = slot(
      r.Day,
      ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].indexOf(r.Day),
      r.Location + '/' + r.Field,
      Number(r.Start.split(':')[0]),
      r.Subunit
    );
    s.end.setUTCMinutes(Number(r.End.split(':')[1]));
    s.end.setUTCHours(Number(r.End.split(':')[0]));
    return s;
  });
  const input = world([slot('wrong day', 0), ...slots]);
  input.teams[0].practicePairs = ['tue-thu'];
  for (const s of slots)
    input.dating.slots.get(s.id).endSeconds =
      s.end.getUTCHours() * 3600 + s.end.getUTCMinutes() * 60;
  const result = await runPracticeOptimizer(input);
  expect(result.placements.map((p) => p.slotId).sort()).toEqual(['Thu', 'Tue']);
  expect(
    slots.map((s) => [s.fieldId, s.subunitId, s.start.getUTCHours(), s.end.getUTCMinutes()])
  ).toEqual([
    ['Venue A/Field 1', 'A', 16, 45],
    ['Venue A/Field 1', 'A', 16, 45],
  ]);
});
it('attributes a pair blocked solely by a must-keep rule to the coach preference', async () => {
  const input = world([slot('m', 0), slot('w', 2)]);
  const preferenceGate = {
    verdicts: new Map([
      [
        teamId,
        new Map([
          [
            'w',
            {
              mustKeepViolated: true,
              violatedDimensions: ['weekday'],
              violatedRules: ['keep-mon'],
              preferKeepBreaches: 0,
            },
          ],
        ]),
      ],
    ]),
  };
  const result = await runPracticeOptimizer({ ...input, preferenceGate });
  expect(result.placements).toEqual([]);
  expect(result.unassigned.map((row) => [row.reason, row.rule, row.rules])).toEqual(
    Array(2).fill(['coach-preference', 'pairing', ['keep-mon']])
  );
});
it.each(['reservation', 'length', 'disjoint dates', 'capacity'])(
  'keeps both practices out when a partner fails %s',
  async (constraint) => {
    const input = world([slot('m', 0), slot('w', 2)]);
    if (constraint === 'reservation') input.slots[1].divisionId = 'another-division';
    if (constraint === 'length') input.teams[0].practiceMinutes = 75;
    if (constraint === 'disjoint dates') {
      input.dating.slots.get('m').effectiveUntil = '2026-09-07';
      input.dating.slots.get('w').firstDate = '2026-09-16';
    }
    if (constraint === 'capacity')
      input.locked.push({
        assignmentId: 'busy',
        teamId: 'another-team',
        slotId: 'w',
        effectiveDateRange: '[2026-09-07,2026-11-30)',
      });
    const result = await runPracticeOptimizer(input);
    expect(result.placements).toEqual([]);
    expect(result.unassigned).toHaveLength(2);
  }
);

it('reports a saved practice on a day outside the configured pairs and keeps it in place', async () => {
  const input = world([slot('m', 0), slot('t', 1), slot('w', 2)], 't');
  const result = await runPracticeOptimizer(input);
  expect(result.heldOutsidePairs).toEqual([teamId]);
  expect(result.placements).toEqual([]);
  expect(verifyPracticePlacements({ ...input, placements: [] }).heldOutsidePairs).toEqual([teamId]);
});

it('keeps the original refusal on a malformed partner and seats neither practice', async () => {
  const input = world([slot('m', 0), slot('w', 2)]);
  const run = await runPracticeOptimizer(input);
  const proposed = run.placements.map((p, i) => (i ? { ...p, slotId: 'unknown' } : p));
  const result = verifyPracticePlacements({ ...input, placements: proposed });
  expect(result.placements).toEqual([]);
  expect(result.refused.map((r) => r.rule).sort()).toEqual(['pairing', 'unknown-slot']);
  const duplicate = verifyPracticePlacements({
    ...input,
    placements: [...run.placements, run.placements[0]],
  });
  expect(duplicate.refused).toHaveLength(3);
  expect(duplicate.refused.map((r) => r.rule)).toContain('duplicate-practice');
});

it('finds the twin of a saved practice whose slot was left out of this run', async () => {
  const input = world([slot('w', 2), slot('t', 1)], 'saved-monday');
  const row = {
    id: 'held',
    teamId,
    slotId: 'saved-monday',
    effectiveDateRange: '[2026-09-07,2026-11-30)',
    assignedVia: 'manual',
  };
  const stored = new Map([
    [
      'saved-monday',
      {
        firstDate: '2026-09-07',
        validUntil: '2026-11-29',
        fieldId: 'pitch',
        startSeconds: 57600,
        endSeconds: 61200,
      },
    ],
  ]);
  const { holds, unchecked } = outsideHoldsFor(
    [row],
    new Set(['w', 't']),
    stored,
    new Set([teamId]),
    new Set([teamId])
  );
  expect(unchecked).toEqual([]);
  const run = await runPracticeOptimizer({ ...input, outsideHolds: holds });
  expect(run.placements.map((p) => p.slotId)).toEqual(['w']);
  expect(
    verifyPracticePlacements({ ...input, outsideHolds: holds, placements: run.placements }).refused
  ).toEqual([]);
  expect(run.lockedOutsideRun.map((p) => p.slotId)).toEqual(['saved-monday']);
});

it('chooses the pair with the fewest combined soft-preference breaches', async () => {
  const input = world([slot('m', 0), slot('w', 2), slot('tu', 1), slot('th', 3)]);
  input.teams[0].practicePairs = ['mon-wed', 'tue-thu'];
  const preferenceGate = {
    verdicts: new Map([
      [
        teamId,
        new Map([
          [
            'w',
            {
              mustKeepViolated: false,
              preferKeepBreaches: 1,
              violatedDimensions: [],
              violatedRules: [],
            },
          ],
        ]),
      ],
    ]),
  };
  const run = await runPracticeOptimizer({ ...input, preferenceGate });
  expect(run.placements.map((p) => p.slotId).sort()).toEqual(['th', 'tu']);
  expect(run.preferKeepBreaches).toBe(0);
});
it('a coach already on another pitch rules out the whole pair even with capacity available', async () => {
  const input = world([slot('m', 0), slot('w', 2), slot('away', 2, 'second pitch')]);
  input.teams.push({ ...input.teams[0], id: 'other-team' });
  input.locked.push({
    assignmentId: 'other-practice',
    teamId: 'other-team',
    slotId: 'away',
    effectiveDateRange: '[2026-09-07,2026-11-30)',
  });
  expect((await runPracticeOptimizer(input)).placements).toEqual([]);
});
it('keeps both late practices and reports their sunset findings', async () => {
  const input = world([slot('m', 0, 'pitch', 22), slot('w', 2, 'pitch', 22)]);
  const daylight = {
    slots: new Map(
      [...input.dating.slots].map(([id, dates]) => [
        id,
        { ...dates, fieldId: 'pitch', id, endMinutes: 23 * 60 },
      ])
    ),
    venues: new Map([
      ['pitch', { fieldId: 'pitch', locationId: 'park', lit: false, latitude: 40, longitude: 0 }],
    ]),
    timeZone: 'UTC',
    today: input.dating.liveFrom,
    lightingOverrides: [],
  };
  const run = await runPracticeOptimizer({ ...input, daylight });
  expect(run.placements).toHaveLength(2);
  expect(run.daylight.pastSunset.map((row) => row.slotId).sort()).toEqual(['m', 'w']);
});
