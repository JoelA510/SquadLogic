// 8.9 PR 6b (plan D13 a): the page's Apply records each truncated placement's
// dark remainder as a daylight TIME TBD exception on its new row.
//
// The witness: every truncated new placement produces exactly one exception.
// The expectation is enumerated from the auto-scheduler's REPORT -- its
// `daylight.timeTbd` entries that are not withdrawn -- never from what the
// builder (or the save) returned, so an exception the builder drops is a
// missing expectation, not a shorter list compared against itself.
import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { buildDaylightExceptions } from '../frontend/src/utils/daylightExceptions.js';
import { preparePracticePersistenceSnapshot } from '../packages/core/src/practicePersistenceSnapshot.js';

const SLOTS = [
  { id: 'slot-mon', effectiveFrom: '2026-09-01', effectiveUntil: '2026-11-30' },
  { id: 'slot-wed', effectiveFrom: '2026-09-01', effectiveUntil: '2026-11-30' },
];

/** The Edge report's shape (supabase/functions/_shared/engines/practice-daylight.ts). */
function timeTbd(teamId, slotId, from, withdrawn) {
  return {
    teamId,
    slotId,
    from,
    until: '2026-11-30',
    reason: 'past-sunset',
    code: 'PRACTICE_PAST_SUNSET',
    marginMinutes: 0,
    withdrawn,
    date: from,
    endMinutes: 1110,
    sunsetMinutes: 1100,
    limitMinutes: 1100,
  };
}

const DAYLIGHT = {
  timeTbd: [
    timeTbd('team-a', 'slot-mon', '2026-10-19', false),
    timeTbd('team-b', 'slot-wed', '2026-10-21', false),
    // Withdrawn whole: no date before D, no row, no exception (D13 b deferred).
    timeTbd('team-c', 'slot-mon', '2026-09-07', true),
  ],
};

// The persistence assignments an Apply sends: one persisted row, and the two
// truncated new placements (the page ends each the day before D).
const ASSIGNMENTS = [
  {
    id: 'pa-old',
    teamId: 'team-z',
    slotId: 'slot-mon',
    effectiveFrom: '2026-09-01',
    effectiveUntil: '2026-11-30',
  },
  {
    id: null,
    teamId: 'team-a',
    slotId: 'slot-mon',
    effectiveFrom: '2026-10-01',
    effectiveUntil: '2026-10-18',
  },
  {
    id: null,
    teamId: 'team-b',
    slotId: 'slot-wed',
    effectiveFrom: '2026-10-01',
    effectiveUntil: '2026-10-20',
  },
];

describe('buildDaylightExceptions', () => {
  it('records exactly one exception per truncated placement the report names', () => {
    const { exceptions, unmatched } = buildDaylightExceptions({
      daylight: DAYLIGHT,
      assignments: ASSIGNMENTS,
      slots: SLOTS,
    });
    assert.deepEqual(unmatched, []);
    const expected = DAYLIGHT.timeTbd.filter((entry) => !entry.withdrawn);
    // Meta-assertion: the witness examined a real, non-trivial set.
    assert.equal(expected.length, 2, 'the fixture lost its truncated placements');
    for (const entry of expected) {
      const mine = exceptions.filter(
        (e) =>
          e.new_assignment.team_id === entry.teamId &&
          e.new_assignment.practice_slot_id === entry.slotId
      );
      assert.equal(mine.length, 1, `${entry.teamId} has ${mine.length} daylight exception(s)`);
      assert.deepEqual(
        { ...mine[0], new_assignment: undefined },
        {
          new_assignment: undefined,
          window: `[${entry.from},${entry.until}]`,
          kind: 'time_tbd',
          tbd_reason: 'past-sunset',
          cause_kind: 'daylight',
        }
      );
    }
    assert.equal(exceptions.length, expected.length, 'an exception names no reported entry');
    assert.ok(
      !exceptions.some((e) => e.new_assignment.team_id === 'team-c'),
      'a withdrawn placement recorded an exception'
    );
  });

  it('names each new row by exactly the key the snapshot inserts it under', () => {
    const { exceptions } = buildDaylightExceptions({
      daylight: DAYLIGHT,
      assignments: ASSIGNMENTS,
      slots: SLOTS,
    });
    const snapshot = preparePracticePersistenceSnapshot({
      assignments: ASSIGNMENTS,
      slots: SLOTS,
      runMetadata: {},
      practiceOverrides: [],
    });
    const keys = new Set(
      snapshot.payload.assignmentRows.map(
        (row) => `${row.team_id}|${row.practice_slot_id}|${row.effective_date_range}`
      )
    );
    assert.equal(exceptions.length, 2);
    for (const { new_assignment: key } of exceptions) {
      assert.ok(
        keys.has(`${key.team_id}|${key.practice_slot_id}|${key.effective_date_range}`),
        `the exception's key ${JSON.stringify(key)} is not a row the save inserts`
      );
      // The remainder lies after the row's range (the retirement contract).
    }
    assert.equal(exceptions[0].new_assignment.effective_date_range, '[2026-10-01,2026-10-18]');
  });

  it('returns an entry whose placement is not staged as unmatched, never drops it', () => {
    const edited = ASSIGNMENTS.filter((a) => a.teamId !== 'team-b');
    const { exceptions, unmatched } = buildDaylightExceptions({
      daylight: DAYLIGHT,
      assignments: edited,
      slots: SLOTS,
    });
    assert.deepEqual(
      unmatched.map((entry) => entry.teamId),
      ['team-b']
    );
    assert.equal(exceptions.length, 1);
    // A persisted row on the same key is not a new placement.
    const persisted = ASSIGNMENTS.map((a) => (a.teamId === 'team-a' ? { ...a, id: 'pa-a' } : a));
    assert.deepEqual(
      buildDaylightExceptions({
        daylight: DAYLIGHT,
        assignments: persisted,
        slots: SLOTS,
      }).unmatched.map((entry) => entry.teamId),
      ['team-a']
    );
  });

  it('returns an entry with no readable end as unmatched rather than an open window', () => {
    const openEnded = { timeTbd: [{ ...DAYLIGHT.timeTbd[0], until: null }] };
    const { exceptions, unmatched } = buildDaylightExceptions({
      daylight: openEnded,
      assignments: ASSIGNMENTS,
      slots: SLOTS,
    });
    assert.deepEqual(exceptions, []);
    assert.deepEqual(
      unmatched.map((entry) => entry.teamId),
      ['team-a']
    );
  });

  it('reports, never throws, when the row key cannot be built', () => {
    // A staged range outside its slot (the slot was re-dated after the run),
    // and a slot the page has not loaded: buildPracticeAssignmentRows throws
    // on both, and the page calls this before its own try.
    const outside = ASSIGNMENTS.map((a) =>
      a.teamId === 'team-a' ? { ...a, effectiveFrom: '2026-08-01' } : a
    );
    const cases = [
      { assignments: outside, slots: SLOTS },
      { assignments: ASSIGNMENTS, slots: SLOTS.filter((slot) => slot.id !== 'slot-mon') },
    ];
    for (const { assignments, slots } of cases) {
      const result = buildDaylightExceptions({ daylight: DAYLIGHT, assignments, slots });
      assert.deepEqual(
        result.unmatched.map((entry) => entry.teamId),
        ['team-a']
      );
    }
  });

  it('records nothing when the run reported no daylight TIME TBD', () => {
    for (const daylight of [undefined, null, {}, { timeTbd: [] }]) {
      assert.deepEqual(
        buildDaylightExceptions({ daylight, assignments: ASSIGNMENTS, slots: SLOTS }),
        { exceptions: [], unmatched: [] }
      );
    }
  });
});
