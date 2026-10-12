// 8.6 3b PR 11d-1: the repair adapter reads live practice exceptions, and the
// core half of a blackout enact (`docs/PHASE_8_6_PR11D_BLACKOUT_ENACT_PLAN.md`
// §2.1, §2.3, §2.6, §5 witnesses B1-B7, B13 core, B16).
//
// Every subject set is enumerated from the SEEDED rows (the snapshot x the
// blackout window, the seeded exception rows), never from the output under
// test. Each witness names the plant that turns it red; the PR body shows
// each one red. Synthetic rows only (`tests/helpers/practiceEnactWorld.js`).
import { describe, expect, it } from 'vitest';

import {
  PRACTICE_ENACT_REFUSAL,
  PRACTICE_REASON,
  PRACTICE_REPAIR_PAYLOAD_REFUSAL,
  PRACTICE_TBD_REASON,
  buildEnactPayload,
  buildEnactRecord,
  buildPracticeRepairInput,
  buildPracticeRepairPayload,
  causeCommitOf,
  createRecommendationState,
  judgeEnact,
  rebaseRecommendationState,
  repairPracticeLoss,
} from '../packages/core/src/practice/index.js';
import {
  ENACT_KEY,
  F1,
  F2,
  F3,
  FINGERPRINT,
  assignment,
  fieldsWith,
  requireExamined,
  rowsOf,
  slot,
  uuid,
} from './helpers/practiceEnactWorld.js';

/* -- the seed --------------------------------------------------------------- */

const BLACKOUT_ID = uuid(701);
const OTHER_BLACKOUT = uuid(702);
// F1 and F2 sit at one venue, F3 at another. 2026-10-19 is a Monday.
const SLOTS = [
  slot(501, F1, 'mon', '17:00', '18:00'),
  slot(502, F1, 'wed', '17:00', '18:00'),
  slot(503, F2, 'mon', '17:00', '18:00'),
  slot(504, F2, 'wed', '17:00', '18:00'),
  slot(505, F2, 'thu', '17:00', '18:00'),
  slot(506, F3, 'mon', '17:00', '18:00'),
  slot(507, F1, 'thu', '18:00', '19:00'),
  slot(508, F1, 'mon', '19:00', '20:00'),
];
const S1 = uuid(601); // Mon 17:00 on F1
const S2 = uuid(602); // Wed 17:00 on F1
const S3 = uuid(603); // Mon 17:00 on F3, at the other venue
const ROWS = [assignment(601, 301, 501), assignment(602, 302, 502), assignment(603, 303, 506)];

/** A blackout of F1 as the loss prop carries it. */
const blackoutLoss = (from, until, extra = {}) => ({
  kind: 'blackout',
  blackout: {
    id: BLACKOUT_ID,
    field_id: F1,
    location_id: null,
    blackout_from: from,
    blackout_until: until,
    start_minutes: null,
    end_minutes: null,
    reason: 'maintenance',
    ...extra,
  },
});
/** The blackout as `field_closures` serves it once saved. */
const storedOf = (loss) => ({
  id: loss.blackout.id,
  source: 'field_blackouts',
  closes_location_id: loss.blackout.location_id,
  closes_field_id: loss.blackout.field_id,
  blackout_from: loss.blackout.blackout_from,
  blackout_until: loss.blackout.blackout_until,
  start_minutes: loss.blackout.start_minutes,
  end_minutes: loss.blackout.end_minutes,
  reason: loss.blackout.reason,
});
/** A `practice_exceptions` row, as the loader selects it. */
const ex = (n, row, window, kind, extra = {}) => ({
  id: uuid(n),
  assignment_id: uuid(row),
  window,
  kind,
  tbd_reason: kind === 'time_tbd' ? 'contended' : null,
  practice_slot_id: null,
  cause_kind: 'blackout',
  cause_id: OTHER_BLACKOUT,
  withdrawn_at: null,
  ...extra,
});
const WITHDRAWN = { withdrawn_at: '2026-10-01T00:00:00Z' };

/** @param {{ slots?: any[], assignments?: any[], exceptions?: any[], closures?: any[], fields?: any[] }} [seed] */
const world = ({
  slots = SLOTS,
  assignments = ROWS,
  exceptions = [],
  closures = [],
  fields = undefined,
} = {}) => ({
  ...rowsOf({ slots, assignments, fields: fields ?? fieldsWith(null) }),
  fieldClosures: closures,
  practiceExceptions: exceptions,
});
const adapt = (rows, loss) =>
  buildPracticeRepairInput({ ...rows, loss, baseFingerprint: FINGERPRINT });
/** The adapter, the repair and the payload of the repair's own result. */
function run(rows, loss) {
  const adapted = adapt(rows, loss);
  const result = repairPracticeLoss(adapted.input);
  return { adapted, result, written: buildPracticeRepairPayload(adapted, result) };
}

/* -- independent date helpers (no core code) ------------------------------- */
const DAY = 86400000;
const WEEKDAY = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const span = (literal) => {
  const [a, b] = literal.slice(1, -1).split(',');
  const last = literal.endsWith(')') ? new Date(Date.parse(`${b}T00:00:00Z`) - DAY) : null;
  return { first: a, last: last ? last.toISOString().slice(0, 10) : b };
};
function datesOn(day, first, last) {
  const out = [];
  for (let t = Date.parse(`${first}T00:00:00Z`); t <= Date.parse(`${last}T00:00:00Z`); t += DAY) {
    if (new Date(t).getUTCDay() === WEEKDAY[day.toLowerCase()]) {
      out.push(new Date(t).toISOString().slice(0, 10));
    }
  }
  return out;
}
const max = (a, b) => (a > b ? a : b);
const min = (a, b) => (a < b ? a : b);
/** Each seeded row on F1 with a weekday date inside `[from, until]`, and its window. */
function displacedWindows(rows, from, until) {
  const slotById = new Map(rows.practiceSlots.map((s) => [s.id, s]));
  const out = new Map();
  for (const row of rows.practiceAssignments) {
    const s = slotById.get(row.practice_slot_id);
    if (s.field_id !== F1) continue;
    const r = span(row.effective_date_range);
    const w = { first: max(r.first, from), last: min(r.last, until) };
    if (datesOn(s.day_of_week, w.first, w.last).length > 0) out.set(row.id, w);
  }
  return out;
}

/* -- the seed exercises data (meta) ----------------------------------------- */

describe('11d-1 :: the seed exercises data', () => {
  const LOSS = ['2026-10-19', '2026-10-25'];
  it('holds a displaced window, a live move, a live mid-range TBD and a withdrawn row', () => {
    const rows = world({
      exceptions: [
        ex(801, 603, '[2026-10-19,2026-10-25]', 'relocated', { practice_slot_id: uuid(503) }),
        ex(802, 602, '[2026-11-02,2026-11-08]', 'time_tbd'),
        ex(803, 601, '[2026-10-19,2026-10-25]', 'relocated', WITHDRAWN),
      ],
    });
    expect(requireExamined(displacedWindows(rows, ...LOSS).size, 'displaced window')).toBe(2);
    const live = rows.practiceExceptions.filter((e) => e.withdrawn_at == null);
    expect(requireExamined(live.filter((e) => e.kind === 'relocated').length, 'move')).toBe(1);
    const midRange = live.filter(
      (e) => e.kind === 'time_tbd' && span(e.window).last < '2026-11-30'
    ).length;
    expect(requireExamined(midRange, 'mid-range TBD')).toBe(1);
    expect(requireExamined(rows.practiceExceptions.length - live.length, 'withdrawn')).toBe(1);
    // The meta-plant: a blackout moved off every series displaces nothing.
    expect(displacedWindows(rows, '2027-01-04', '2027-01-10').size).toBe(0);
    expect(() => requireExamined(0, 'displaced window')).toThrow('examined no');
  });
});

/* -- B1: withdrawn exceptions never apply ----------------------------------- */

describe('11d-1 :: B1, a withdrawn exception never applies, whatever the caller selected', () => {
  // Withdrawn rows the loader passes unfiltered: a move onto S1's same-venue
  // slot, and a window on S1 over the loss itself.
  const SEEDED = [
    ex(811, 603, '[2026-10-19,2026-10-25]', 'relocated', {
      practice_slot_id: uuid(503),
      ...WITHDRAWN,
    }),
    ex(812, 601, '[2026-10-19,2026-10-25]', 'time_tbd', WITHDRAWN),
  ];
  const loss = blackoutLoss('2026-10-19', '2026-10-25');

  it('is neither an occupant nor a window a write must avoid', () => {
    const subjects = SEEDED.filter((e) => e.withdrawn_at != null);
    expect(requireExamined(subjects.length, 'withdrawn exception')).toBe(2);
    const { adapted, result, written } = run(world({ exceptions: SEEDED }), loss);
    expect(adapted.declared.exceptions).toMatchObject({
      supplied: true,
      rowsRead: 2,
      live: 0,
      withdrawn: 2,
      occupants: 0,
    });
    expect('occupants' in adapted.input).toBe(false);
    expect(written.refused).toEqual([]);
    // S1 is free to take the slot the withdrawn move named.
    const s1 = result.recommendations.find((r) => r.assignmentId === S1);
    expect(s1.to.surfaceId).toBe(F2);
  });

  it('refuses a row with no withdrawn_at key, never reading it as live', () => {
    const { withdrawn_at: _omitted, ...keyless } = ex(
      813,
      601,
      '[2026-10-19,2026-10-25]',
      'time_tbd'
    );
    expect(() => adapt(world({ exceptions: [keyless] }), loss)).toThrow('carries no withdrawn_at');
  });

  it('refuses an open or unreadable live window, and names another season’s rows', () => {
    for (const window of ['[2026-10-19,)', 'not a range']) {
      expect(() => adapt(world({ exceptions: [ex(814, 601, window, 'time_tbd')] }), loss)).toThrow(
        'open or unreadable'
      );
    }
    const elsewhere = ex(815, 699, '[2026-10-19,2026-10-25]', 'time_tbd');
    const { adapted } = run(world({ exceptions: [elsewhere] }), loss);
    expect(adapted.declared.exceptions.outOfSeason).toEqual([uuid(815)]);
    expect(adapted.declared.exceptions.applied).toBe(0);
  });

  it('declares none supplied, never assuming none exist', () => {
    const { practiceExceptions: _unread, ...rows } = world();
    const adapted = adapt(rows, loss);
    expect(adapted.declared.exceptions.supplied).toBe(false);
    expect(adapted.declared.exceptions.note).toMatch(/no saved temporary change/);
  });
});

/* -- B2: a relocated window occupies its slot ------------------------------- */

describe('11d-1 :: B2, a live relocated window occupies its slot', () => {
  const loss = blackoutLoss('2026-10-19', '2026-10-25');
  // S3 (the other venue) was moved onto F2 Mon 17:00 over the blackout's week.
  const SEEDED = [
    ex(821, 603, '[2026-10-19,2026-10-25]', 'relocated', { practice_slot_id: uuid(503) }),
  ];

  it('no displaced series is recommended the occupied shape', () => {
    const rows = world({ exceptions: SEEDED });
    const { adapted, result } = run(rows, loss);
    const slotById = new Map(SLOTS.map((s) => [s.id, s]));
    const key = (shape) =>
      `${shape.surfaceId}|${shape.weekday}|${shape.startMinutes}|${shape.durationMinutes}`;
    // Not vacuous: with no move saved, the occupied slot is S1's own choice.
    const free = run(world(), loss).result.recommendations.find((r) => r.assignmentId === S1);
    expect(key(free.to)).toBe(`${F2}|MON|1020|60`);
    // Every (displaced series, live relocated window) pair from the seed that
    // overlaps in dates and time on the same ground.
    let pairs = 0;
    for (const [seriesId, w] of displacedWindows(rows, '2026-10-19', '2026-10-25')) {
      const own = slotById.get(
        rows.practiceAssignments.find((r) => r.id === seriesId).practice_slot_id
      );
      for (const e of SEEDED) {
        const target = slotById.get(e.practice_slot_id);
        const ew = span(e.window);
        const days = datesOn(target.day_of_week, max(ew.first, w.first), min(ew.last, w.last));
        if (days.length === 0 || target.start_time !== own.start_time) continue;
        pairs += 1;
        const occupied = {
          surfaceId: target.field_id,
          weekday: target.day_of_week.toUpperCase(),
          startMinutes: 17 * 60,
          durationMinutes: 60,
        };
        const rec = result.recommendations.find((r) => r.assignmentId === seriesId);
        expect(rec.to === null ? null : key(rec.to), seriesId).not.toBe(key(occupied));
      }
    }
    // S1 (Mon) and S2 (Wed, a changed weekday) each meet the move.
    expect(requireExamined(pairs, 'occupied (series, slot) pair')).toBe(2);
    expect(adapted.input.occupants).toEqual([
      {
        id: uuid(821),
        assignmentId: S3,
        teamId: uuid(303),
        slotId: uuid(503),
        from: '2026-10-19',
        until: '2026-10-25',
      },
    ]);
  });

  it('an occupant is never displaced and never recommended (B16)', () => {
    const rows = world({ exceptions: SEEDED });
    const { result } = run(rows, loss);
    const fromSeed = [...displacedWindows(rows, '2026-10-19', '2026-10-25').keys()].sort();
    expect(result.recommendations.map((r) => r.assignmentId).sort()).toEqual(fromSeed);
    expect(result.occupants).toMatchObject({ supplied: 1, held: 1, lost: [] });
  });

  it('clips the window to its row (Q9), and a relocation whose slot does not read holds none', () => {
    const short = [
      assignment(601, 301, 501),
      assignment(602, 302, 502),
      assignment(603, 303, 506, '[2026-09-01,2026-10-22)'),
    ];
    const rows = world({
      assignments: short,
      exceptions: [
        ex(822, 603, '[2026-10-19,2026-10-25]', 'relocated', { practice_slot_id: uuid(503) }),
        ex(823, 601, '[2026-11-02,2026-11-08]', 'relocated', { practice_slot_id: uuid(599) }),
      ],
    });
    const adapted = adapt(rows, loss);
    expect(adapted.input.occupants.map((o) => [o.id, o.from, o.until])).toEqual([
      [uuid(822), '2026-10-19', '2026-10-21'],
    ]);
    expect(adapted.declared.exceptions.relocatedSlotUnread).toEqual([uuid(823)]);
  });
});

/* -- Q8: a later loss that hits a relocated target ------------------------- */

describe('11d-1 :: Q8, a saved move onto the lost ground is reported, never dropped', () => {
  it('is its own finding, "cannot be repaired here", and is never recommended', () => {
    // S3 was moved onto F1 Thu 18:00; the blackout of F1 now closes it.
    const SEEDED = [
      ex(831, 603, '[2026-10-19,2026-10-25]', 'relocated', { practice_slot_id: uuid(507) }),
    ];
    const rows = world({ exceptions: SEEDED });
    const { result } = run(rows, blackoutLoss('2026-10-19', '2026-10-25'));
    const subjects = SEEDED.filter((e) => {
      const target = SLOTS.find((s) => s.id === e.practice_slot_id);
      return (
        target.field_id === F1 && datesOn(target.day_of_week, '2026-10-19', '2026-10-25').length > 0
      );
    });
    expect(requireExamined(subjects.length, 'move onto lost ground')).toBe(1);
    const finding = result.findings.find(
      (f) => f.code === PRACTICE_REASON.REPAIR_RELOCATED_TARGET_LOST
    );
    expect(finding.message).toMatch(/cannot be repaired here/);
    expect(finding.details.occupants.map((o) => o.id)).toEqual(subjects.map((e) => e.id));
    expect(result.occupants.lost.map((o) => o.id)).toEqual(subjects.map((e) => e.id));
    expect(result.recommendations.map((r) => r.assignmentId)).not.toContain(S3);
    // The plant: the same move off the lost ground is no finding.
    const off = run(
      world({ exceptions: [{ ...SEEDED[0], practice_slot_id: uuid(505) }] }),
      blackoutLoss('2026-10-19', '2026-10-25')
    ).result;
    expect(off.findings.map((f) => f.code)).not.toContain(
      PRACTICE_REASON.REPAIR_RELOCATED_TARGET_LOST
    );
  });
});

/* -- B3: an enacted window is not displaced again --------------------------- */

describe('11d-1 :: B3, an enacted window is not displaced again', () => {
  const loss = blackoutLoss('2026-10-19', '2026-10-25');
  /** S1's share of the loss, from the seed, moved by THIS blackout. */
  const enactedOn = (causeId) =>
    ex(841, 601, '[2026-10-19,2026-10-25]', 'relocated', {
      practice_slot_id: uuid(503),
      cause_id: causeId,
    });

  it('the same blackout re-opened after a seeded enact leaves S1 out, and the re-base holds', () => {
    const before = adapt(world(), loss);
    const state = createRecommendationState(before.input);
    expect(state.recommendations.map((r) => r.assignmentId)).toContain(S1);
    const after = adapt(world({ exceptions: [enactedOn(BLACKOUT_ID)] }), loss);
    expect(after.declared.exceptions.enactedWindows).toBe(1);
    expect(after.input.plan.assignments.map((a) => a.id)).not.toContain(S1);
    const next = rebaseRecommendationState(state, after.input, { enacted: [S1] });
    expect(next.enacted).toEqual([S1]);
    expect(next.recommendations.map((r) => r.assignmentId)).not.toContain(S1);
    // Its moved practice still holds its slot.
    expect(after.input.occupants.map((o) => o.slotId)).toEqual([uuid(503)]);
  });

  it('a window another cause wrote is not this enact: S1 stays displaced, and its write is refused', () => {
    const { adapted, result, written } = run(
      world({ exceptions: [enactedOn(OTHER_BLACKOUT)] }),
      loss
    );
    expect(adapted.declared.exceptions.enactedWindows).toBe(0);
    expect(result.recommendations.map((r) => r.assignmentId)).toContain(S1);
    expect(written.refused.filter((r) => r.assignment_id === S1).map((r) => r.why)).toContain(
      PRACTICE_REPAIR_PAYLOAD_REFUSAL.LIVE_EXCEPTION_OVERLAP
    );
  });
});

/* -- B4: overlap is refused, never written ---------------------------------- */

describe('11d-1 :: B3c, a window covering only PART of the row’s share is not an enact', () => {
  // The blackout spans two Mondays (2026-10-19, 2026-10-26). A window this
  // blackout caused over one week only leaves S1's other lost date unrepaired:
  // S1 stays in the repair (displaced), and its write over its whole share is
  // refused as meeting a live window (plan §2.1 rule 4 needs "covers all of
  // S ∩ loss"; §4 refuses overlaps). Never dropped.
  const loss = blackoutLoss('2026-10-19', '2026-11-01');
  const PARTIAL = [
    ['[2026-10-19,2026-10-25]', 'covers the start only'],
    ['[2026-10-26,2026-11-01]', 'covers the end only'],
  ];

  it('a window of another cause KIND with the same id is not this enact either', () => {
    // Ids are uuids of different tables: the kind is half the identity (the
    // `practiceEnactCount` sibling contract), never assumed from the id alone.
    const subjects = ['retirement', 'daylight'];
    for (const causeKind of subjects) {
      const other = ex(846, 601, '[2026-10-19,2026-11-01]', 'time_tbd', {
        cause_kind: causeKind,
        cause_id: BLACKOUT_ID,
      });
      const { adapted, result, written } = run(world({ exceptions: [other] }), loss);
      expect(adapted.declared.exceptions.enactedWindows, causeKind).toBe(0);
      expect(
        result.recommendations.map((r) => r.assignmentId),
        causeKind
      ).toContain(S1);
      expect(
        written.refused.filter((r) => r.assignment_id === S1).map((r) => r.why),
        causeKind
      ).toContain(PRACTICE_REPAIR_PAYLOAD_REFUSAL.LIVE_EXCEPTION_OVERLAP);
    }
    expect(requireExamined(subjects.length, 'other cause kind')).toBe(2);
  });

  it('keeps S1 displaced and refuses its write, for a window missing either end', () => {
    const rows = world();
    const share = displacedWindows(rows, '2026-10-19', '2026-11-01').get(S1);
    expect(share).toEqual({ first: '2026-10-19', last: '2026-11-01' });
    expect(datesOn('mon', share.first, share.last)).toHaveLength(2);
    let examined = 0;
    for (const [window, what] of PARTIAL) {
      const w = span(window);
      // From the seed: the window misses at least one of S1's lost dates.
      const missed = datesOn('mon', share.first, share.last).filter(
        (d) => d < w.first || d > w.last
      );
      expect(missed.length, what).toBeGreaterThan(0);
      examined += 1;
      const partial = ex(845, 601, window, 'relocated', {
        practice_slot_id: uuid(503),
        cause_id: BLACKOUT_ID,
      });
      const { adapted, result, written } = run(world({ exceptions: [partial] }), loss);
      expect(adapted.declared.exceptions.enactedWindows, what).toBe(0);
      expect(
        adapted.input.plan.assignments.map((a) => a.id),
        what
      ).toContain(S1);
      expect(
        result.recommendations.map((r) => r.assignmentId),
        what
      ).toContain(S1);
      expect(
        written.refused.filter((r) => r.assignment_id === S1).map((r) => r.why),
        what
      ).toContain(PRACTICE_REPAIR_PAYLOAD_REFUSAL.LIVE_EXCEPTION_OVERLAP);
      expect(written.payload, what).toBeNull();
    }
    expect(requireExamined(examined, 'partial window')).toBe(2);
  });
});

describe('11d-1 :: B4, a planned window meeting a live one is refused', () => {
  const loss = blackoutLoss('2026-10-19', '2026-10-25');
  // Live windows from another cause: one meets S2's share, one is after S1's.
  const SEEDED = [
    ex(851, 602, '[2026-10-21,2026-10-21]', 'time_tbd', { cause_kind: 'daylight', cause_id: null }),
    ex(852, 601, '[2026-11-02,2026-11-08]', 'time_tbd'),
  ];

  it('every overlapping (live, planned) pair on one row is LIVE_EXCEPTION_OVERLAP, and only those', () => {
    const rows = world({ exceptions: SEEDED });
    const { written } = run(rows, loss);
    const planned = displacedWindows(rows, '2026-10-19', '2026-10-25');
    let overlapping = 0;
    let disjoint = 0;
    for (const e of SEEDED) {
      const w = planned.get(e.assignment_id);
      const ew = span(e.window);
      const meets = w !== undefined && ew.first <= w.last && w.first <= ew.last;
      const refusals = written.refused
        .filter((r) => r.assignment_id === e.assignment_id)
        .map((r) => r.why);
      if (meets) {
        overlapping += 1;
        expect(refusals, e.id).toContain(PRACTICE_REPAIR_PAYLOAD_REFUSAL.LIVE_EXCEPTION_OVERLAP);
      } else {
        disjoint += 1;
        expect(refusals, e.id).not.toContain(
          PRACTICE_REPAIR_PAYLOAD_REFUSAL.LIVE_EXCEPTION_OVERLAP
        );
      }
    }
    expect(requireExamined(overlapping, 'overlapping pair')).toBe(1);
    expect(requireExamined(disjoint, 'disjoint pair')).toBe(1);
    expect(written.payload).toBeNull();
    // The refused write is kept in the plan, so the refusal names what it withholds.
    expect(written.plan.exceptions.map((e) => e.assignment_id)).toContain(S2);
  });
});

/* -- B5: a retirement never cuts a live window ------------------------------ */

describe('11d-1 :: B5, a retirement never cuts a live window', () => {
  // S1 holds a live window after mid-October; S2 one before it.
  const SEEDED = [
    ex(861, 601, '[2026-10-26,2026-11-01]', 'time_tbd'),
    ex(862, 602, '[2026-10-05,2026-10-11]', 'time_tbd'),
  ];
  const retirementOf = (lastDay) => ({
    kind: 'retirement',
    field: { id: F1, effective_to: lastDay },
  });

  it('over the seed’s rows x retirement dates, CLOSE_CUTS_LIVE_EXCEPTION exactly when a live window reaches past D-1', () => {
    let cut = 0;
    let kept = 0;
    for (const lastDay of ['2026-10-14', '2026-10-31', '2026-11-15']) {
      const rows = world({ exceptions: SEEDED, fields: fieldsWith(lastDay) });
      const { written } = run(rows, retirementOf(lastDay));
      for (const e of SEEDED) {
        const reaches = span(e.window).last > lastDay;
        const whys = written.refused
          .filter((r) => r.assignment_id === e.assignment_id)
          .map((r) => r.why);
        if (reaches) {
          cut += 1;
          expect(whys, `${e.id} after ${lastDay}`).toContain(
            PRACTICE_REPAIR_PAYLOAD_REFUSAL.CLOSE_CUTS_LIVE_EXCEPTION
          );
          expect(written.payload).toBeNull();
        } else {
          kept += 1;
          expect(whys, `${e.id} after ${lastDay}`).not.toContain(
            PRACTICE_REPAIR_PAYLOAD_REFUSAL.CLOSE_CUTS_LIVE_EXCEPTION
          );
        }
      }
    }
    expect(requireExamined(cut, 'cut window')).toBe(2);
    expect(requireExamined(kept, 'uncut window')).toBe(4);
  });

  it('a retirement tail TBD still writes beside a window it does not meet', () => {
    // No free slot off F1 anywhere (F3's is S3's): S2 goes TIME TBD from D.
    const slots = SLOTS.filter((s) => ![uuid(503), uuid(504), uuid(505)].includes(s.id));
    const rows = world({ slots, exceptions: [SEEDED[1]], fields: fieldsWith('2026-10-14') });
    const { result, written } = run(rows, retirementOf('2026-10-14'));
    const tail = written.plan.exceptions.filter((e) => e.assignment_id === S2);
    expect(result.timeTbd.map((t) => t.assignmentId)).toContain(S2);
    expect(requireExamined(tail.length, 'retirement tail TBD')).toBe(1);
    expect(written.refused.filter((r) => r.assignment_id === S2)).toEqual([]);
  });
});

/* -- B6: no relocation loses a practice (G1) -------------------------------- */

describe('11d-1 :: B6, no relocation loses a practice', () => {
  // One Tuesday series on F1; F2 offers Thursday and a later Tuesday.
  const TUE_SLOTS = [
    slot(511, F1, 'tue', '17:00', '18:00'),
    slot(512, F2, 'thu', '17:00', '18:00'),
    slot(513, F2, 'tue', '18:00', '19:00'),
  ];
  const TUE_ROWS = [assignment(611, 311, 511)];

  // The candidates, from the seed alone: every slot shape off the lost ground.
  const CANDIDATES = TUE_SLOTS.filter((s) => s.field_id !== F1).map((s) => ({
    shape: {
      surfaceId: s.field_id,
      weekday: s.day_of_week.toUpperCase(),
      startMinutes: Number(s.start_time.slice(0, 2)) * 60,
      durationMinutes: 60,
    },
  }));

  it('the repair offers a losing move (G1), so the refusal is what stands between it and the writer', () => {
    // With only the Thursday free, the repair recommends it for a one-day Tuesday window.
    const rows = world({ slots: TUE_SLOTS.slice(0, 2), assignments: TUE_ROWS });
    const { result, written } = run(rows, blackoutLoss('2026-10-13', '2026-10-13'));
    const [rec] = result.recommendations;
    expect(rec.to?.weekday).toBe('THU');
    expect(written.refused.map((r) => r.why)).toEqual([
      PRACTICE_REPAIR_PAYLOAD_REFUSAL.RELOCATION_LOSES_PRACTICES,
    ]);
  });

  it('for every candidate of the seed, the new weekday holds as many dates in W, or it is refused', () => {
    let refusedLosses = 0;
    let admitted = 0;
    // 2026-10-13 is a Tuesday: a one-day window, and two Tuesdays with one Thursday.
    for (const [from, until] of [
      ['2026-10-13', '2026-10-13'],
      ['2026-10-13', '2026-10-20'],
    ]) {
      const rows = world({ slots: TUE_SLOTS, assignments: TUE_ROWS });
      const adapted = adapt(rows, blackoutLoss(from, until));
      for (const candidate of CANDIDATES) {
        const window = { from, until };
        const written = buildPracticeRepairPayload(adapted, {
          representation: 'override',
          lossDate: from,
          rehomed: [{ assignmentId: uuid(611), window, to: candidate.shape }],
          timeTbd: [],
        });
        const before = datesOn('tue', from, until).length;
        const after = datesOn(candidate.shape.weekday, from, until).length;
        const whys = written.refused.map((r) => r.why);
        if (after < before) {
          refusedLosses += 1;
          expect(whys, `${candidate.shape.weekday} over ${from}..${until}`).toContain(
            PRACTICE_REPAIR_PAYLOAD_REFUSAL.RELOCATION_LOSES_PRACTICES
          );
          expect(written.payload).toBeNull();
        } else {
          admitted += 1;
          expect(whys).toEqual([]);
        }
      }
    }
    expect(requireExamined(refusedLosses, 'losing relocation')).toBe(2);
    expect(requireExamined(admitted, 'same-day relocation')).toBe(2);
  });
});

/* -- B7: a daylight mid-range TBD never reaches the writer ------------------ */

describe('11d-1 :: B7, a daylight mid-range TIME TBD is refused before the writer', () => {
  it('refuses past-sunset and sunset-unknown windows ending before their row, and only those', () => {
    const rows = world();
    const adapted = adapt(rows, blackoutLoss('2026-10-19', '2026-12-31'));
    /** @type {Set<string>} */
    const daylight = new Set([PRACTICE_TBD_REASON.PAST_SUNSET, PRACTICE_TBD_REASON.SUNSET_UNKNOWN]);
    let refusedN = 0;
    let admittedN = 0;
    for (const reason of Object.values(PRACTICE_TBD_REASON)) {
      for (const until of ['2026-10-25', '2026-11-30']) {
        const written = buildPracticeRepairPayload(adapted, {
          representation: 'override',
          lossDate: '2026-10-19',
          rehomed: [],
          timeTbd: [{ assignmentId: S1, window: { from: '2026-10-19', until }, reason }],
        });
        // S1's row ends 2026-11-30, read by hand from the seed.
        const midRange = until < span(ROWS[0].effective_date_range).last;
        const whys = written.refused.map((r) => r.why);
        if (daylight.has(reason) && midRange) {
          refusedN += 1;
          expect(whys, `${reason} to ${until}`).toEqual([
            PRACTICE_REPAIR_PAYLOAD_REFUSAL.DAYLIGHT_MID_RANGE,
          ]);
          expect(written.payload).toBeNull();
        } else {
          admittedN += 1;
          expect(whys, `${reason} to ${until}`).toEqual([]);
        }
      }
    }
    expect(requireExamined(refusedN, 'daylight mid-range window')).toBe(2);
    expect(admittedN).toBe(Object.values(PRACTICE_TBD_REASON).length * 2 - 2);
  });
});

/* -- the blackout commit gate and the one-entry write (§2.3, §2.6) ---------- */

describe('11d-1 :: the blackout commit gate reads the FRESH stored row', () => {
  const loss = blackoutLoss('2026-10-19', '2026-10-25', { start_minutes: 1050, end_minutes: 1110 });

  it('commits a saved blackout equal to the loss, and refuses a draft or a missing row', () => {
    expect(causeCommitOf(world({ closures: [storedOf(loss)] }), loss)).toMatchObject({
      committed: true,
      refusal: null,
      causeId: BLACKOUT_ID,
    });
    const draft = { ...loss, blackout: { ...loss.blackout, id: 'draft' } };
    /** @type {Array<{ rows: any, l: any }>} */
    const cases = [
      { rows: world({ closures: [storedOf(loss)] }), l: draft },
      { rows: world(), l: loss },
      {
        rows: world({ closures: [{ ...storedOf(loss), source: 'field_availability_profiles' }] }),
        l: loss,
      },
    ];
    for (const { rows, l } of cases) {
      expect(causeCommitOf(rows, l).refusal).toBe(PRACTICE_ENACT_REFUSAL.BLACKOUT_UNCOMMITTED);
    }
  });

  it('refuses a stored row differing in any of scope, dates, minutes or reason', () => {
    const changes = [
      { closes_field_id: F2 },
      { closes_field_id: null, closes_location_id: uuid(101) },
      { blackout_from: '2026-10-18' },
      { blackout_until: '2026-10-26' },
      { start_minutes: null, end_minutes: null },
      { end_minutes: 1140 },
      { reason: 'weather' },
    ];
    for (const change of changes) {
      const rows = world({ closures: [{ ...storedOf(loss), ...change }] });
      expect(causeCommitOf(rows, loss).refusal, JSON.stringify(change)).toBe(
        PRACTICE_ENACT_REFUSAL.BLACKOUT_CHANGED
      );
    }
    expect(requireExamined(changes.length, 'changed column')).toBe(7);
  });
});

describe('11d-1 :: the blackout write is one exception on S, over its own window (B13 core)', () => {
  // S1's row ends mid-loss, so its window is not the loss's: [2026-10-19, 2026-10-25].
  const rowsWith = (closures) =>
    world({
      assignments: [
        assignment(601, 301, 501, '[2026-09-01,2026-10-26)'),
        assignment(602, 302, 502),
        assignment(603, 303, 506),
      ],
      closures,
    });
  const loss = blackoutLoss('2026-10-19', '2026-11-08');

  /** @param {{ accepted: boolean, enactKey?: string }} [answer] */
  function enact(answer = { accepted: true, enactKey: ENACT_KEY }) {
    const rows = rowsWith([storedOf(loss)]);
    const adapted = adapt(rows, loss);
    const state = createRecommendationState(adapted.input);
    const judged = judgeEnact(
      state,
      S1,
      state.recommendations.find((r) => r.assignmentId === S1)
    );
    const commit = causeCommitOf(rows, loss);
    return {
      rows,
      adapted,
      state,
      judged,
      commit,
      out: buildEnactPayload(adapted, judged, answer, commit),
    };
  }

  it('writes S1 alone, over S1 ∩ the loss, with no unlock, close or new row', () => {
    const { rows, out, judged } = enact();
    const w = displacedWindows(rows, '2026-10-19', '2026-11-08').get(S1);
    expect(w).toEqual({ first: '2026-10-19', last: '2026-10-25' });
    expect(out.refusal).toBeNull();
    expect(out.payload.repair.exceptions).toHaveLength(1);
    const [written] = out.payload.repair.exceptions;
    expect(written).toMatchObject({
      assignment_id: S1,
      window: `[${w.first},${w.last}]`,
      cause_kind: 'blackout',
      cause_id: BLACKOUT_ID,
    });
    // The series dates the write changes, counted by hand from the seed.
    expect(datesOn('mon', w.first, w.last)).toEqual(['2026-10-19']);
    expect(datesOn('mon', '2026-10-19', '2026-11-08').length).toBe(3);
    expect(written.kind).toBe(judged.fresh.to === null ? 'time_tbd' : 'relocated');
    expect(out.unlock).toEqual([]);
    expect(out.payload.repair.unlock).toEqual([]);
    expect(out.payload.repair.closes).toEqual([]);
    expect(out.payload.assignmentRows.map((r) => r.effective_date_range).sort()).toEqual(
      rows.practiceAssignments.map((r) => r.effective_date_range).sort()
    );
  });

  it('still needs the prompt’s tick, and has no record until 11d-2', () => {
    expect(enact({ accepted: false }).out).toMatchObject({
      refusal: PRACTICE_ENACT_REFUSAL.PROMPT_NOT_ACCEPTED,
      payload: null,
    });
    const { adapted, state, judged, commit, out } = enact();
    expect(() =>
      buildEnactRecord({
        enactKey: ENACT_KEY,
        seasonSettingsId: uuid(900),
        adapted,
        state,
        judged,
        commit,
        enactment: out,
        prompt: { rows: [], published_practices_affected: 1, accepted: true },
      })
    ).toThrow('3b PR 11d-2');
  });

  it('refuses a gate judged for another blackout, or for this one stored otherwise', () => {
    const { adapted, judged } = enact();
    const other = blackoutLoss('2026-10-19', '2026-11-01');
    const gate = causeCommitOf(rowsWith([storedOf(other)]), other);
    expect(gate.committed).toBe(true);
    expect(buildEnactPayload(adapted, judged, { accepted: true }, gate).refusal).toBe(
      PRACTICE_ENACT_REFUSAL.BLACKOUT_CHANGED
    );
  });
});

describe('11d-1 :: a partial-day blackout displaces by its minutes and writes whole days', () => {
  it('displaces only the series its minutes meet; the window is whole days', () => {
    const rows = world({
      assignments: [...ROWS, assignment(608, 308, 508)],
    });
    // 17:30-18:30 meets Mon 17:00-18:00 (S1), not Mon 19:00-20:00 (608).
    const loss = blackoutLoss('2026-10-19', '2026-10-25', {
      start_minutes: 1050,
      end_minutes: 1110,
    });
    const { result, written } = run(rows, loss);
    const ids = result.recommendations.map((r) => r.assignmentId);
    expect(ids).toContain(S1);
    expect(ids).not.toContain(uuid(608));
    const s1 = written.plan.exceptions.find((e) => e.assignment_id === S1);
    expect(requireExamined(s1 ? 1 : 0, 'partial-day window')).toBe(1);
    expect(s1.window).toBe('[2026-10-19,2026-10-25]');
  });
});
