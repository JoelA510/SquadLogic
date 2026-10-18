/**
 * **The witness table both arms of the M4.8 dated solver are held to**
 * (`docs/PLAN_SOLVER_DATE_MODEL.md` §2.2 and §5). `tests/autoSchedulerLock.test.js`
 * (Vitest) and `supabase/functions/_shared/tests/practice-lock_test.ts` (Deno)
 * run the Edge solver over these cases, so the two runtimes answer one table
 * rather than two copies of it.
 *
 * Plain ESM with no imports, so Deno loads it by relative path. Synthetic ids
 * only. Each case's truth was worked out by hand from the dates, never from a
 * solver's output; every subject set (the roster, the loaded rows, the run's
 * slots) is the case's own.
 *
 * The season runs 2026-08-10 to 2026-11-20 on America/New_York and "today"
 * (`liveFrom`) is Saturday 2026-10-17, so a new placement on a Tuesday slot is
 * live from 2026-10-20: 5 Tuesdays to 2026-11-17. Slot instants are written on
 * the season's own clock (-04:00 before the 2026-11-01 DST change, -05:00
 * after), as `anchorWallTimes` would place them.
 */

export const SOLVER_DATED_ZONE = 'America/New_York';
export const SOLVER_DATED_TODAY = '2026-10-17';
const SEASON_END = '2026-11-20';

/** A slot from its first occurrence, as the page sends it and the store dates it. */
function slot(id, firstDate, options = {}) {
  const { hh = 16, minutes = 60, capacity = 1, until = SEASON_END, offset = '-04:00' } = options;
  const start = `${firstDate}T${String(hh).padStart(2, '0')}:00:00${offset}`;
  const endMinutes = hh * 60 + minutes;
  const end =
    `${firstDate}T${String(Math.floor(endMinutes / 60)).padStart(2, '0')}:` +
    `${String(endMinutes % 60).padStart(2, '0')}:00${offset}`;
  return { id, start, end, capacity, firstDate, validUntil: until };
}

const team = (id, coachId) => ({ id, division: 'U10', coachId });
const row = (assignmentId, teamId, slotId, effectiveDateRange) => ({
  assignmentId,
  teamId,
  slotId,
  effectiveDateRange,
});

/**
 * `expect.placements` is every placement as `team -> slot` (none others);
 * `expect.unassigned` every unplaced team with its reason; `ended` and
 * `unreadable` the locked rows the run counts as holding nothing from today,
 * and as held season-long because their range cannot be read.
 */
export const SOLVER_DATED_CASES = Object.freeze([
  {
    name: 'W4-S1: two Tuesday 16:00 slots valid from 08-11 and 09-01, one coach, two teams',
    // Both slots are live on all 5 Tuesdays from today, so the two teams would
    // share c1 on every one of them: only one can be placed. Today's solver
    // put T2 on sB and reported 0 conflicts.
    slots: [slot('sA', '2026-08-11'), slot('sB', '2026-09-01')],
    teams: [team('T1', 'c1'), team('T2', 'c1')],
    locked: [],
    placeable: ['T1', 'T2'],
    expect: {
      placements: ['T1 -> sA'],
      unassigned: ['T2: no-slot-available'],
      ended: [],
      unreadable: [],
    },
  },
  {
    name: 'W4-S2: T1 locked season-long on sA; T2, the same coach, takes the free Wednesday',
    slots: [slot('sA', '2026-08-11'), slot('sB', '2026-09-01'), slot('sC', '2026-08-12')],
    teams: [team('T1', 'c1'), team('T2', 'c1')],
    locked: [row('a1', 'T1', 'sA', '[2026-08-10,2026-11-21)')],
    placeable: ['T2'],
    expect: { placements: ['T2 -> sC'], unassigned: [], ended: [], unreadable: [] },
  },
  {
    name: 'E1: a locked row that ended on 09-14 leaves its capacity-1 slot free from today',
    slots: [slot('sX', '2026-08-11')],
    teams: [team('L', 'cL'), team('N', 'cN')],
    locked: [row('a1', 'L', 'sX', '[2026-08-10,2026-09-15)')],
    placeable: ['N'],
    expect: { placements: ['N -> sX'], unassigned: [], ended: ['a1'], unreadable: [] },
  },
  {
    name: 'E2: the ended row no longer blocks its coach at that time on another field',
    // sY comes first, so the coach block is what decides; sX stays the row's.
    slots: [slot('sY', '2026-08-11'), slot('sX', '2026-08-11')],
    teams: [team('L', 'c1'), team('N', 'c1')],
    locked: [row('a1', 'L', 'sX', '[2026-08-10,2026-09-15)')],
    placeable: ['N'],
    expect: { placements: ['N -> sY'], unassigned: [], ended: ['a1'], unreadable: [] },
  },
  {
    name: 'E3 (control): a locked row starting 11-02 frees nothing a new placement from today meets',
    // N from 10-20 would share 11-03, 11-10 and 11-17 with it: unplaced (Q4).
    slots: [slot('sX', '2026-08-11')],
    teams: [team('L', 'cL'), team('N', 'cN')],
    locked: [row('a1', 'L', 'sX', '[2026-11-02,2026-11-21)')],
    placeable: ['N'],
    expect: { placements: [], unassigned: ['N: no-slot-available'], ended: [], unreadable: [] },
  },
  {
    name: 'DST: Tuesday 16:00 slots either side of 2026-11-01 clash on the wall clock',
    // 16:00 EDT is 20:00Z and 16:00 EST is 21:00Z: as instants the two are
    // back to back, on the wall clock they are the same hour from 11-03 on.
    slots: [slot('dA', '2026-10-27'), slot('dB', '2026-11-03', { offset: '-05:00' })],
    teams: [team('T1', 'c1'), team('T2', 'c1')],
    locked: [],
    placeable: ['T1', 'T2'],
    expect: {
      placements: ['T1 -> dA'],
      unassigned: ['T2: no-slot-available'],
      ended: [],
      unreadable: [],
    },
  },
  {
    name: 'a locked row whose range cannot be read is held season-long and reported (Q2)',
    slots: [slot('sX', '2026-08-11')],
    teams: [team('L', 'cL'), team('N', 'cN')],
    locked: [row('a1', 'L', 'sX', '[garbled')],
    placeable: ['N'],
    expect: { placements: [], unassigned: ['N: no-slot-available'], ended: [], unreadable: ['a1'] },
  },
  {
    name: 'a run whose only slot ended before today leaves its team no-live-date (Q3)',
    slots: [slot('sE', '2026-08-11', { until: '2026-09-29' })],
    teams: [team('N', 'cN')],
    locked: [],
    placeable: ['N'],
    expect: { placements: [], unassigned: ['N: no-live-date'], ended: [], unreadable: [] },
  },
  {
    name: 'touching, inclusive: a row whose closed range ends on Tuesday 10-20 holds that date',
    slots: [slot('sX', '2026-08-11')],
    teams: [team('L', 'cL'), team('N', 'cN')],
    locked: [row('a1', 'L', 'sX', '[2026-08-10,2026-10-20]')],
    placeable: ['N'],
    expect: { placements: [], unassigned: ['N: no-slot-available'], ended: [], unreadable: [] },
  },
  {
    name: 'touching, exclusive: a row whose half-open range stops before 10-20 has ended',
    slots: [slot('sX', '2026-08-11')],
    teams: [team('L', 'cL'), team('N', 'cN')],
    locked: [row('a1', 'L', 'sX', '[2026-08-10,2026-10-20)')],
    placeable: ['N'],
    expect: { placements: ['N -> sX'], unassigned: [], ended: ['a1'], unreadable: [] },
  },
  {
    name: "a slot's last date is inclusive: valid until Tuesday 10-20 still offers that date",
    slots: [slot('sV', '2026-08-11', { until: '2026-10-20' })],
    teams: [team('N', 'cN')],
    locked: [],
    placeable: ['N'],
    expect: { placements: ['N -> sV'], unassigned: [], ended: [], unreadable: [] },
  },
  {
    name: 'capacity is a peak per date: two rows that never meet hold one place of two',
    slots: [slot('s2', '2026-08-11', { capacity: 2 })],
    teams: [team('A', 'cA'), team('B', 'cB'), team('N', 'cN')],
    locked: [
      row('a1', 'A', 's2', '[2026-10-17,2026-10-31)'),
      row('a2', 'B', 's2', '[2026-11-01,2026-11-21)'),
    ],
    placeable: ['N'],
    expect: { placements: ['N -> s2'], unassigned: [], ended: [], unreadable: [] },
  },
]);

/**
 * A case's run, as `index.ts` builds it: the slots as the solver receives them
 * and the dating `toDaylightSlot` reads from the store (`stored`: the field,
 * the first date and the last). `toDaylightSlot` is passed in so this file
 * stays import-free.
 */
export function solverDatedRun(testCase, toDaylightSlot) {
  const slots = testCase.slots.map((s) => ({
    id: s.id,
    start: new Date(s.start),
    end: new Date(s.end),
    capacity: s.capacity,
  }));
  return {
    slots,
    dating: {
      liveFrom: SOLVER_DATED_TODAY,
      slots: new Map(
        testCase.slots.map((s, i) => [
          s.id,
          toDaylightSlot(slots[i], SOLVER_DATED_ZONE, {
            fieldId: `field-${s.id}`,
            validUntil: s.validUntil,
            firstDate: s.firstDate,
          }),
        ])
      ),
    },
  };
}

/**
 * Season-long dating for a fixture written before M4.8: every slot from its
 * own first occurrence (its `start` read on `timeZone`) to `until`, and
 * `liveFrom` on or before every first occurrence, so the dated rule judges
 * the fixture exactly as the undated one did.
 */
export function seasonLongDating(slots, toDaylightSlot, { timeZone, until, liveFrom }) {
  return {
    liveFrom,
    slots: new Map(
      slots.map((s) => [
        s.id,
        toDaylightSlot(s, timeZone, { fieldId: `field-${s.id}`, validUntil: until }),
      ])
    ),
  };
}
