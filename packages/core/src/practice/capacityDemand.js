/**
 * Capacity versus demand, before a run (schedule expansion, PR 13, task N1; plan
 * `docs/changes/2026-11-03-schedule-expansion.md`, 5.9 and decisions 28 and 29).
 *
 * One row per division of the season: how many practices its teams want a week, how many they
 * already hold, how many they still lack, and whether the practice slots the division may use have
 * the room for the rest. Read-only and pure: it is handed the rows a page read and a `YYYY-MM-DD`
 * "today" (this package builds no `Date`), and it stores and sends nothing.
 *
 * ## What the numbers are, and are not (decisions 28 and 29)
 *
 * The room counts **every open slot** a division may use: live from today on, as long as the
 * division's practice, and not reserved to another division. Nothing in the app records a time
 * that is held outside it, so the calculation cannot leave one out: its verdict is an **upper
 * bound** (the room can only be too high), and the page that shows it says so. Excluding held times
 * for real is a stored hold, which the owner has not asked for.
 *
 * **Declared, not enforced** (AGENTS.md section 3). It does not read coach overlap, coach `must`
 * rules, daylight, closures, permits, travel, saved exceptions, or a team whose practice time is
 * TIME TBD (the planner leaves such a team out of a run and this does not: the gap is that team's
 * need, pinned by `tests/practiceCapacityDemand.test.js`). A run applies all of them, so it can
 * place fewer practices than the room shown.
 *
 * ## One rule each, held to the run's
 *
 * - **The subject set is the roster** (lessons 46 and 92): every team of a division of the season,
 *   whether or not it holds a saved practice or appears in any solver output.
 * - **Still needed is the planner's arithmetic**: per team `max(target - held, 0)`, `held` being
 *   every saved row of the team whatever its dates ({@link practicesStillNeeded}; the Edge twin is
 *   `planTeamsForRun`, `supabase/functions/_shared/engines/practice-lock.ts`, and
 *   `tests/practiceCapacityDemand.test.js` runs both over one league). It is deliberately a
 *   mirror of one expression, not a copy of the planner.
 * - **A slot is open to a division** when it has a live date from today
 *   (`assignmentLiveSpan` with `notBefore`, as the solver dates it), is exactly the division's
 *   practice length when the division sets one (`practiceLengthRefuses`), and no reservation refuses
 *   it (`reservationRefusal`, core's twin of the solver's rule).
 * - **A saved practice uses its place** in its slot over the dates it covers from today on; the
 *   room of a slot is its capacity less the busiest date's load (`peakLiveCount`), as the solver's
 *   capacity rule reads it. A range that cannot be read is counted as filling the whole slot and
 *   is counted in `basis.unreadableRanges`, never skipped.
 * - **A division that wants nothing** (0 a week) is "none wanted", never short, and counts no slot.
 * - **A slot open to two divisions counts in each division's row and once in the total**
 *   (lesson 92: a count is a number of a population; the rows can add up to more than the total).
 * - **A slot that cannot be read** (a weekday, time or date it lacks) is counted in the basis and
 *   is open to nobody, as the page's own partition leaves it out of a run.
 *
 * @module practice/capacityDemand
 */

import { z } from 'zod';

import { IdSchema, IsoDateSchema } from '../availability/schemas.js';
import { reservationRefusal, reservedDivisionIdsOf } from '../practiceScheduling.js';
import { PRACTICE_UNPLACED_REASON } from '../practiceUnplacedReasons.js';
import {
  LIVE_SPAN_STATUS,
  assignmentLiveSpan,
  calendarDayNumber,
  peakLiveCount,
  wallSeconds,
} from '../utils/practiceLiveDates.js';
import { firstWeekdayOnOrAfter } from './slots.js';

/** The kinds of verdict a row (or the total) can carry. */
export const CAPACITY_VERDICT = Object.freeze({
  /** The division gives its teams no practice (0 a week). Never short. */
  NONE_WANTED: 'none-wanted',
  /** The division has no team in the season. */
  NO_TEAMS: 'no-teams',
  /** Practices are still needed and no slot is open to the division; `reason` says why. */
  NO_SLOT: 'no-slot',
  /** The open slots fall on fewer weekdays than the practices a week the division wants. */
  NOT_ENOUGH_DAYS: 'not-enough-days',
  /** Still needed exceeds the room. */
  SHORT: 'short',
  /** The room covers what is still needed (possibly with none to spare). */
  SPARE: 'spare',
});

/** Weekday codes as `practice_slots.day_of_week` stores them, in the order a week is shown. */
const WEEKDAYS = Object.freeze(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);

/**
 * What one team still lacks: its division's practices a week less the saved rows it holds, never
 * below zero. The mirror of `planTeamsForRun`'s `Math.max(target - held, 0)`; a team holding more
 * than its count needs none, and its extra rows do not offset another team's need.
 *
 * @param {number} target - practices a week (0 to 7)
 * @param {number} held - saved rows the team holds, whatever their dates
 * @returns {number}
 */
export function practicesStillNeeded(target, held) {
  return Math.max(target - held, 0);
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const DivisionSchema = z
  .object({
    id: IdSchema,
    name: z.string(),
    /** `divisions.practices_per_week`: its CHECK is an integer from 0 to 7. */
    practicesPerWeek: z.number().int().min(0).max(7),
    /** `divisions.practice_minutes`: null (any slot length) or an integer from 15 to 240. */
    practiceMinutes: z.number().int().min(15).max(240).nullable(),
  })
  .strict();

const TeamSchema = z.object({ id: IdSchema, divisionId: IdSchema }).strict();

/**
 * A `practice_slots` row. The weekday, times and dates are read per slot (`readSlot`), so one slot
 * that cannot be read is counted and left out, and never fails the whole panel.
 */
const SlotSchema = z
  .object({
    id: IdSchema,
    dayOfWeek: z.string().nullable(),
    startTime: z.string().nullable(),
    endTime: z.string().nullable(),
    /** `smallint DEFAULT 1`, nullable; read as the page reads it (`Math.max(1, capacity ?? 1)`). */
    capacity: z.number().int().nullable(),
    validFrom: z.string().nullable(),
    validUntil: z.string().nullable(),
    divisionId: z.string().nullable(),
  })
  .strict();

const AssignmentSchema = z
  .object({
    id: IdSchema,
    teamId: IdSchema,
    slotId: z.string().nullable(),
    effectiveDateRange: z.string().nullable(),
  })
  .strict();

/** What {@link buildCapacityDemand} reads. */
export const CapacityDemandInputSchema = z
  .object({
    /** Today on the season's clock (`seasonCalendarDate`), `YYYY-MM-DD`. */
    liveFrom: IsoDateSchema.refine((value) => calendarDayNumber(value) !== null, {
      message: 'expected a real calendar date',
    }),
    /** The season's dates: a slot with none of its own takes them (the page's rule). */
    season: z.object({ start: z.string().nullable(), end: z.string().nullable() }).strict(),
    divisions: z.array(DivisionSchema),
    teams: z.array(TeamSchema),
    slots: z.array(SlotSchema),
    assignments: z.array(AssignmentSchema),
  })
  .strict()
  .superRefine((input, ctx) => {
    for (const key of ['divisions', 'teams', 'slots', 'assignments']) {
      const seen = new Set();
      input[key].forEach((entry, index) => {
        if (seen.has(entry.id)) {
          ctx.addIssue({
            code: 'custom',
            path: [key, index, 'id'],
            message: `${key} carry the id ${entry.id} twice`,
          });
        }
        seen.add(entry.id);
      });
    }
  });

const Count = z.number().int().min(0);
const VerdictSchema = z
  .object({
    kind: z.enum(Object.values(CAPACITY_VERDICT)),
    /** For {@link CAPACITY_VERDICT.NO_SLOT} and {@link CAPACITY_VERDICT.NOT_ENOUGH_DAYS}. */
    reason: z.enum(Object.values(PRACTICE_UNPLACED_REASON)).nullable(),
    short: Count,
    spare: Count,
  })
  .strict();

const DivisionReportSchema = z
  .object({
    divisionId: IdSchema,
    name: z.string(),
    teams: Count,
    practicesPerWeek: Count,
    practiceMinutes: Count.nullable(),
    /** Teams times practices a week. */
    wanted: Count,
    /** Saved rows of the division's teams. May exceed `wanted`. */
    held: Count,
    /** The sum over teams of {@link practicesStillNeeded}. */
    stillNeeded: Count,
    /** Teams holding more rows than the division wants. */
    teamsOverCount: Count,
    slots: z
      .object({
        open: Count,
        weekdays: z.array(z.enum(WEEKDAYS)),
        capacity: Count,
        room: Count,
      })
      .strict(),
    verdict: VerdictSchema,
  })
  .strict();

/** What {@link buildCapacityDemand} returns. */
export const CapacityDemandReportSchema = z
  .object({
    liveFrom: IsoDateSchema,
    basis: z
      .object({
        slotsRead: Count,
        slotsUnreadable: Count,
        slotsLive: Count,
        slotsOpenToSomeDivision: Count,
        slotsOpenToNoDivision: Count,
        unreadableRanges: Count,
      })
      .strict(),
    divisions: z.array(DivisionReportSchema),
    total: z
      .object({
        teams: Count,
        wanted: Count,
        held: Count,
        stillNeeded: Count,
        slots: z
          .object({
            /** Distinct slots open to some division. */
            open: Count,
            /** The rows' own counts added up: more than `open` when a slot serves two divisions. */
            inRows: Count,
            capacity: Count,
            room: Count,
          })
          .strict(),
        verdict: VerdictSchema,
      })
      .strict(),
  })
  .strict();

/** @typedef {z.infer<typeof CapacityDemandInputSchema>} CapacityDemandInput */
/** @typedef {z.infer<typeof CapacityDemandReportSchema>} CapacityDemandReport */

// ---------------------------------------------------------------------------
// Reading a slot
// ---------------------------------------------------------------------------

/**
 * One slot, read as the page and the solver read it: the weekday, the times, the dates (its own,
 * else the season's), the first date it falls on, and whether any date of it is left from today.
 * `null` when it cannot be read.
 *
 * @param {CapacityDemandInput['slots'][number]} raw
 * @param {CapacityDemandInput['season']} season
 * @param {string} liveFrom
 */
function readSlot(raw, season, liveFrom) {
  const day = String(raw.dayOfWeek ?? '')
    .trim()
    .toLowerCase();
  if (!WEEKDAYS.includes(/** @type {any} */ (day))) return null;
  const startSec = wallSeconds(raw.startTime);
  const endSec = wallSeconds(raw.endTime);
  // A window that does not end after it starts overlaps nothing: the solver refuses it too.
  if (startSec === null || endSec === null || endSec <= startSec) return null;
  const validFrom = raw.validFrom ?? season.start;
  const validUntil = raw.validUntil ?? season.end;
  const lastDay = calendarDayNumber(validUntil);
  if (calendarDayNumber(validFrom) === null || lastDay === null) return null;
  const firstDay = /** @type {number} */ (
    calendarDayNumber(firstWeekdayOnOrAfter(/** @type {string} */ (validFrom), day.toUpperCase()))
  );
  const span = assignmentLiveSpan({ firstDay, lastDay, notBefore: liveFrom });
  return {
    id: raw.id,
    day,
    startSec,
    endSec,
    capacity: Math.max(1, raw.capacity ?? 1),
    divisionId: raw.divisionId,
    firstDay,
    lastDay,
    span: span.status === LIVE_SPAN_STATUS.LIVE ? { first: span.first, last: span.last } : null,
  };
}

/**
 * Whether the division's practice length refuses the slot (`practiceLengthRefuses`, the solver's
 * rule): a division that sets a length takes only slots exactly that long.
 *
 * @param {number | null} practiceMinutes
 * @param {{ startSec: number, endSec: number }} slot
 */
function lengthRefuses(practiceMinutes, slot) {
  if (practiceMinutes === null) return false;
  return slot.endSec - slot.startSec !== practiceMinutes * 60;
}

// ---------------------------------------------------------------------------
// The calculation
// ---------------------------------------------------------------------------

/** A readable message for a failed parse: where, and what was wrong, for the first few issues. */
function describeIssues(error) {
  return error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`)
    .join('; ');
}

/**
 * Slots against need, per division and for the season. Throws a `TypeError` naming the first
 * invalid field when the input does not parse (a division the table would not hold, two rows with
 * one id): a figure over data that cannot be trusted is not drawn.
 *
 * @param {CapacityDemandInput} rawInput
 * @returns {CapacityDemandReport}
 */
export function buildCapacityDemand(rawInput) {
  const parsed = CapacityDemandInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new TypeError(`practice capacity: ${describeIssues(parsed.error)}`);
  }
  const input = parsed.data;
  const { liveFrom } = input;

  // The slots the run is given: those that can be read. A reservation is read from every one of
  // them before any filter, so a division whose reserved slots are all out of date is left with none.
  const read = input.slots.map((slot) => readSlot(slot, input.season, liveFrom));
  const slots = /** @type {NonNullable<(typeof read)[number]>[]} */ (read.filter(Boolean));
  const reservedDivisionIds = reservedDivisionIdsOf(slots);

  // Saved practices, by team (every row counts as held) and by slot (a place in use).
  const heldBy = new Map();
  const rowsBySlot = new Map();
  for (const row of input.assignments) {
    heldBy.set(row.teamId, (heldBy.get(row.teamId) ?? 0) + 1);
    if (row.slotId === null) continue;
    const list = rowsBySlot.get(row.slotId) ?? [];
    list.push(row);
    rowsBySlot.set(row.slotId, list);
  }

  // The room of each live slot: its capacity less the busiest date's load from today on.
  let unreadableRanges = 0;
  const roomOf = new Map();
  for (const slot of slots) {
    if (slot.span === null) continue;
    const spans = [];
    for (const row of rowsBySlot.get(slot.id) ?? []) {
      const held = assignmentLiveSpan({
        firstDay: slot.firstDay,
        lastDay: slot.lastDay,
        range: row.effectiveDateRange,
        notBefore: liveFrom,
      });
      if (held.status === LIVE_SPAN_STATUS.LIVE) spans.push({ first: held.first, last: held.last });
      else if (held.status === LIVE_SPAN_STATUS.UNREADABLE) {
        unreadableRanges += 1;
        spans.push(slot.span);
      }
    }
    roomOf.set(slot.id, Math.max(slot.capacity - peakLiveCount(spans), 0));
  }

  // The subject set: the roster. Never the saved practices, never a solver's output.
  const rosterTeams = input.teams;
  const teamsByDivision = new Map();
  for (const team of rosterTeams) {
    const list = teamsByDivision.get(team.divisionId) ?? [];
    list.push(team);
    teamsByDivision.set(team.divisionId, list);
  }

  const anyLive = slots.some((slot) => slot.span !== null);
  const openUnion = new Set();

  const divisions = [...input.divisions]
    .sort(
      (a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }) || a.id.localeCompare(b.id)
    )
    .map((division) => {
      const teams = teamsByDivision.get(division.id) ?? [];
      const wanted = teams.length * division.practicesPerWeek;
      let held = 0;
      let stillNeeded = 0;
      let teamsOverCount = 0;
      for (const team of teams) {
        const rows = heldBy.get(team.id) ?? 0;
        held += rows;
        stillNeeded += practicesStillNeeded(division.practicesPerWeek, rows);
        if (rows > division.practicesPerWeek) teamsOverCount += 1;
      }

      // A division that wants nothing uses no slot, so none is counted for it.
      const open =
        wanted > 0
          ? slots.filter(
              (slot) =>
                slot.span !== null &&
                !lengthRefuses(division.practiceMinutes, slot) &&
                reservationRefusal(
                  { divisionId: division.id },
                  { divisionId: slot.divisionId },
                  reservedDivisionIds
                ) === null
            )
          : [];
      for (const slot of open) openUnion.add(slot.id);
      const weekdays = WEEKDAYS.filter((day) => open.some((slot) => slot.day === day));
      const capacity = open.reduce((sum, slot) => sum + slot.capacity, 0);
      const room = open.reduce((sum, slot) => sum + (roomOf.get(slot.id) ?? 0), 0);
      const slotFigures = { open: open.length, weekdays, capacity, room };
      // The live slots of the division's length, before any reservation: what says whether the
      // length, or the reservation, is what left it no slot (`divisionVerdict`).
      const liveOfLength = slots.filter(
        (slot) => slot.span !== null && !lengthRefuses(division.practiceMinutes, slot)
      ).length;

      return {
        divisionId: division.id,
        name: division.name,
        teams: teams.length,
        practicesPerWeek: division.practicesPerWeek,
        practiceMinutes: division.practiceMinutes,
        wanted,
        held,
        stillNeeded,
        teamsOverCount,
        slots: slotFigures,
        verdict: divisionVerdict({
          practicesPerWeek: division.practicesPerWeek,
          teams: teams.length,
          stillNeeded,
          slots: slotFigures,
          anyLive,
          liveOfLength,
        }),
      };
    });

  const sum = (pick) => divisions.reduce((total, row) => total + pick(row), 0);
  const openInRows = sum((row) => row.slots.open);
  const totalOpen = openUnion.size;
  const totalCapacity = slots
    .filter((slot) => openUnion.has(slot.id))
    .reduce((total, slot) => total + slot.capacity, 0);
  const totalRoom = slots
    .filter((slot) => openUnion.has(slot.id))
    .reduce((total, slot) => total + (roomOf.get(slot.id) ?? 0), 0);
  const totals = {
    teams: sum((row) => row.teams),
    wanted: sum((row) => row.wanted),
    held: sum((row) => row.held),
    stillNeeded: sum((row) => row.stillNeeded),
  };
  const slotsLive = slots.filter((slot) => slot.span !== null).length;

  return CapacityDemandReportSchema.parse({
    liveFrom,
    basis: {
      slotsRead: input.slots.length,
      slotsUnreadable: input.slots.length - slots.length,
      slotsLive,
      slotsOpenToSomeDivision: totalOpen,
      slotsOpenToNoDivision: slotsLive - totalOpen,
      unreadableRanges,
    },
    divisions,
    total: {
      ...totals,
      slots: { open: totalOpen, inRows: openInRows, capacity: totalCapacity, room: totalRoom },
      verdict: totalVerdict({ ...totals, room: totalRoom }),
    },
  });
}

/**
 * A division's verdict. In order: nothing wanted; no team; nothing more needed (the room is then
 * all spare); no slot open; too few weekdays for the practices a week; else short by what the room
 * lacks or the room to spare.
 *
 * **Why no slot is open is the filter that excluded the live slots, not the division's setting.**
 * In the order the solver tests them (`explainUnplaced`, `auto-scheduler-solver.ts`): no slot has a
 * date left from today (`no-live-date`); else no live slot is the division's length
 * (`practice-length`); else a live slot of the length exists and the reservation is what keeps the
 * division off every one (`no-slot-available`; with no length set, every live slot passes the length
 * test, so this is the reservation too). **One deliberate difference from the run:** the solver
 * tests the length only among the slots left after the reservation, so a right-length slot reserved
 * to another division reads there as `practice-length`; this tests the length among all live slots,
 * so the panel does not tell an admin that no slot is that long when one is (Codex, #711).
 * `tests/practiceCapacityDemand.test.js` pins the solver's reason for those cases.
 */
function divisionVerdict({ practicesPerWeek, teams, stillNeeded, slots, anyLive, liveOfLength }) {
  const short = Math.max(stillNeeded - slots.room, 0);
  const spare = Math.max(slots.room - stillNeeded, 0);
  if (practicesPerWeek === 0) {
    return { kind: CAPACITY_VERDICT.NONE_WANTED, reason: null, short: 0, spare: 0 };
  }
  if (teams === 0) return { kind: CAPACITY_VERDICT.NO_TEAMS, reason: null, short: 0, spare: 0 };
  if (stillNeeded === 0) return { kind: CAPACITY_VERDICT.SPARE, reason: null, short: 0, spare };
  if (slots.open === 0) {
    /** @type {string} */
    let reason = PRACTICE_UNPLACED_REASON.NO_SLOT_AVAILABLE;
    if (!anyLive) reason = PRACTICE_UNPLACED_REASON.NO_LIVE_DATE;
    else if (liveOfLength === 0) reason = PRACTICE_UNPLACED_REASON.PRACTICE_LENGTH;
    return { kind: CAPACITY_VERDICT.NO_SLOT, reason, short, spare: 0 };
  }
  if (practicesPerWeek > 1 && slots.weekdays.length < practicesPerWeek) {
    return {
      kind: CAPACITY_VERDICT.NOT_ENOUGH_DAYS,
      reason: PRACTICE_UNPLACED_REASON.NOT_ENOUGH_DAYS,
      short,
      spare,
    };
  }
  return short > 0
    ? { kind: CAPACITY_VERDICT.SHORT, reason: null, short, spare: 0 }
    : { kind: CAPACITY_VERDICT.SPARE, reason: null, short: 0, spare };
}

/** The whole season's verdict, over the distinct slots: short, to spare, or nothing wanted. */
function totalVerdict({ wanted, stillNeeded, room }) {
  if (wanted === 0) return { kind: CAPACITY_VERDICT.NONE_WANTED, reason: null, short: 0, spare: 0 };
  const short = Math.max(stillNeeded - room, 0);
  const spare = Math.max(room - stillNeeded, 0);
  return short > 0
    ? { kind: CAPACITY_VERDICT.SHORT, reason: null, short, spare: 0 }
    : { kind: CAPACITY_VERDICT.SPARE, reason: null, short: 0, spare };
}

// ---------------------------------------------------------------------------
// From the tables to the input
// ---------------------------------------------------------------------------

const orNull = (value) => (value === undefined ? null : value);

/**
 * The input, from the rows a page read: divisions, teams and `practice_slots` in the tables' own
 * column names, the season's assignments as `loadSeasonPracticeAssignments` returns them
 * (`practiceSupabase.js`), and the `season_settings` row. A column a row lacks is none, never
 * undefined, so a select that forgot one fails the schema or changes a figure rather than hiding.
 *
 * @param {{ liveFrom: string, season: Record<string, any>, divisions: Array<Record<string, any>>,
 *   teams: Array<Record<string, any>>, practiceSlots: Array<Record<string, any>>,
 *   practiceAssignments: Array<Record<string, any>> }} rows
 * @returns {CapacityDemandInput}
 */
export function capacityDemandInputFromRows(rows) {
  return {
    liveFrom: rows.liveFrom,
    season: {
      start: orNull(rows.season?.season_start),
      end: orNull(rows.season?.season_end),
    },
    divisions: rows.divisions.map((row) => ({
      id: String(row.id),
      name: String(row.name ?? ''),
      practicesPerWeek: row.practices_per_week,
      practiceMinutes: orNull(row.practice_minutes),
    })),
    teams: rows.teams.map((row) => ({ id: String(row.id), divisionId: String(row.division_id) })),
    slots: rows.practiceSlots.map((row) => ({
      id: String(row.id),
      dayOfWeek: orNull(row.day_of_week),
      startTime: orNull(row.start_time),
      endTime: orNull(row.end_time),
      capacity: orNull(row.capacity),
      validFrom: orNull(row.valid_from),
      validUntil: orNull(row.valid_until),
      divisionId: orNull(row.division_id),
    })),
    assignments: rows.practiceAssignments.map((row) => ({
      id: String(row.id),
      teamId: String(row.teamId),
      slotId: orNull(row.slotId),
      effectiveDateRange: orNull(row.effectiveDateRange),
    })),
  };
}
