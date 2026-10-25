/**
 * The auto-scheduler's solver: greedy seed + hill climbing.
 *
 * Moved out of `auto-scheduler/index.ts` unchanged in its search (8.6 PR 3b
 * PR 7) so the lock witness (`tests/autoSchedulerLock.test.js`) can execute
 * it; `index.ts` imports `serve` at module load and cannot be imported by a
 * test. What changed is how locked rows are held:
 *
 * **Locked rows are a LIST, never a map keyed by team.** The old solver put
 * every assignment -- locked or not -- into one `Map<teamId, slotId>`, so a
 * team holding two rows (two weekdays, 176 of 281 pairs in the season-2026
 * corpus) collapsed to its last one and the other slot read as free. Locked
 * rows are now fixed occupancy: each row consumes one unit of its own slot's
 * capacity and blocks its team's coaches at that slot's time, and nothing in
 * the search can move, remove or re-range one. Only `placeable` teams (no row,
 * no TIME TBD series: see `practice-lock.ts`) are searched, and only their
 * placements are returned.
 *
 * **Dated occupancy (M4.8, `docs/PLAN_SOLVER_DATE_MODEL.md`).** Every slot is
 * dated from the store (`dating`, the daylight pass's own reading, §1.2): its
 * first and last date and its wall window on the season's clock. A NEW
 * placement is live on the slot's weekday from `max(slot first date, liveFrom)`
 * to the slot's last date -- the range the page writes (`newPlacementRange`).
 * A locked row is live inside its own stored range and the slot's validity;
 * one whose range cannot be read is held on its slot's whole validity and
 * reported (`unreadableRange`, Q2); one with no live date from `liveFrom` on
 * holds nothing and is counted (`endedRows`). The hard constraint
 * (`practice-coaches.ts`) judges those dates, and the objective scores dated
 * (Q1), so the search, its persisted evaluation and the panel use one rule.
 * The search itself -- move types, acceptance, restarts, PRNG draws -- is
 * unchanged; on an input where everything is live on every date from today
 * (the undated corpus) it is byte-identical to the undated solver
 * (`tests/autoSchedulerDatedSweep.test.js`, a golden taken before M4.8).
 * A run slot the solver cannot date is refused by `index.ts` (422
 * `SLOT_DATING_UNREADABLE`, Q3) and throws here.
 *
 * Declared, not enforced (plan §7): no partial placement -- a team whose slot
 * is free only until a future locked row starts stays unplaced (Q4); `liveFrom`
 * is the date the run started on.
 *
 * Relocated slots (8.6 3b PR 11d-0, gap G2): a live `relocated` exception
 * holds the slot its practice moved onto by the same contract -- one unit of
 * capacity and its team's coaches at that slot's time, **season-wide** on that
 * slot's whole validity (M4.8 Q5: its own `window` is not read yet, so it is
 * over-held, never double-booked). It is occupancy only: not scored and not
 * judged by the daylight pass (declared).
 *
 * Daylight (8.9 PR 6): given a `daylight` context, the search's placements go
 * through `practice-daylight.ts`'s post-pass -- truncated at the first date
 * past sunset on unlit ground, the remainder TIME TBD. The search itself is
 * unchanged and does not optimise toward surviving slots (D11).
 */
import { evaluatePracticeSchedule } from './scoring-engine.ts';
import {
  checkHardConstraints,
  type LiveDays,
  type PreparedTeam,
  type SlotOccupant,
  type TimeWindow,
} from './practice-coaches.ts';
import { LIVE_SPAN_STATUS, assignmentLiveSpan, calendarDayNumber } from './practice-live-dates.ts';
import { COACH_PREFERENCE_TBD_REASON } from './coach-preferences.ts';
import { EMPTY_PREFERENCE_GATE, type PreferenceGate } from './coach-preference-load.ts';
import {
  applyDaylightPostPass,
  type DaylightContext,
  type DaylightReport,
} from './practice-daylight.ts';
import type { LoadedRelocation } from './practice-lock.ts';

export type SchedulerTeam = PreparedTeam & { division: string };

export interface SchedulerSlot {
  id: string;
  day?: string | null;
  start: Date;
  end: Date;
  capacity: number;
  baseSlotId?: string;
  /** The division the slot is reserved to, from the store (D2); absent or `null`: open. */
  divisionId?: string | null;
}

/**
 * One slot's dating, as `index.ts` reads it for the daylight pass
 * (`toDaylightSlot`: the store first, the body only where the store is
 * silent). A `DaylightSlot` is one.
 */
export interface SlotDatingInput {
  /** The slot's first occurrence, `YYYY-MM-DD` on the season's clock. */
  firstDate: string | null;
  /** The last date the slot runs, inclusive. */
  effectiveUntil: string | null;
  /**
   * Seconds past local midnight the practice starts and ends, on the season's
   * clock: seconds kept, so 16:00:30-17:00:30 overlaps 17:00-18:00.
   */
  startSeconds: number | null;
  endSeconds: number | null;
}

/** The run's dating (M4.8). */
export interface SolverDating {
  /**
   * The run's today on the season's clock (`seasonCalendarDate`): a new
   * placement is live from `max(slot first date, liveFrom)`. Returned to the
   * page as `liveFrom`, so the range it writes is the range judged (Q7).
   */
  liveFrom: string;
  slots: ReadonlyMap<string, SlotDatingInput>;
}

/** The refusal `index.ts` answers an undatable run slot with (Q3). */
export const SLOT_DATING_UNREADABLE = 'SLOT_DATING_UNREADABLE';

/**
 * Why a team is unplaced when no run slot has a live date from today on
 * (Q3): the season's slots have run out, not the teams' fit.
 */
export const NO_LIVE_DATE_REASON = 'no-live-date';

/** The search's own reason for a team no legal slot was left for. */
const NO_SLOT_REASON = 'no-slot-available';

/** One slot's dating, read; `null` when it cannot be dated. */
function readDating(
  dating: SlotDatingInput | undefined
): { firstDay: number; lastDay: number; startSec: number; endSec: number } | null {
  if (!dating) return null;
  const firstDay = calendarDayNumber(dating.firstDate);
  const lastDay = calendarDayNumber(dating.effectiveUntil);
  // A wall second of one day (0-86399): the scoring engine's wall-time
  // reading has no 24:00, so neither does this.
  const seconds = (value: unknown) =>
    typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 86399
      ? value
      : null;
  const start = seconds(dating.startSeconds);
  const end = seconds(dating.endSeconds);
  // A window that does not end after it starts would overlap nothing, so a
  // coach clash through it would pass unseen: undatable, not empty.
  if (firstDay === null || lastDay === null || start === null || end === null || end <= start) {
    return null;
  }
  return { firstDay, lastDay, startSec: start, endSec: end };
}

/**
 * The run slots the solver cannot date (Q3): no dating, or a first date, last
 * date or wall window it cannot read. `index.ts` refuses a run naming them.
 */
export function undatableSlotIds(
  slotIds: readonly string[],
  dating: ReadonlyMap<string, SlotDatingInput>
): string[] {
  return slotIds.filter((id) => readDating(dating.get(id)) === null);
}

/** A run slot with its dating read (M4.8). */
export interface DatedSchedulerSlot extends SchedulerSlot {
  firstDay: number;
  lastDay: number;
  startSec: number;
  endSec: number;
  /** A new placement's live dates, from `max(firstDay, liveFrom)`; `null` when none (Q3). */
  span: LiveDays | null;
  /** The dated scoring fields (M4.7's `Slot`): `YYYY-MM-DD` and `HH:MM:SS`. */
  firstDate: string;
  lastDate: string;
  startTime: string;
  endTime: string;
}

const wallTime = (seconds: number) => {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor((seconds % 3600) / 60))}:${pad(seconds % 60)}`;
};

/**
 * Every run slot with its dating read. Throws on a `liveFrom` that is not a
 * date or a slot it cannot date: `index.ts` refuses both first (422), so a
 * throw here is a caller bug, never a guessed season.
 */
export function dateSchedulerSlots(
  slots: SchedulerSlot[],
  dating: SolverDating
): DatedSchedulerSlot[] {
  if (calendarDayNumber(dating.liveFrom) === null) {
    throw new TypeError(`liveFrom ${String(dating.liveFrom)} is not a date`);
  }
  const undatable = undatableSlotIds(
    slots.map((s) => s.id),
    dating.slots
  );
  if (undatable.length > 0) {
    throw new TypeError(`${SLOT_DATING_UNREADABLE}: ${undatable.join(', ')}`);
  }
  return slots.map((slot) => {
    const read = readDating(dating.slots.get(slot.id))!;
    const raw = dating.slots.get(slot.id)!;
    const span = assignmentLiveSpan({
      firstDay: read.firstDay,
      lastDay: read.lastDay,
      notBefore: dating.liveFrom,
    });
    return {
      ...slot,
      ...read,
      span: span.status === LIVE_SPAN_STATUS.LIVE ? { first: span.first, last: span.last } : null,
      firstDate: raw.firstDate as string,
      lastDate: raw.effectiveUntil as string,
      startTime: wallTime(read.startSec),
      endTime: wallTime(read.endSec),
    };
  });
}

/**
 * The range a NEW placement is judged on and written with (M4.8, plan §1.2):
 * `[max(slot first date, liveFrom), slot last date]`, inclusive, or to the
 * daylight pass's truncated end. One place for it: the objective scores it,
 * and the response hands it to the page, which writes it unchanged, so the
 * range saved is the range judged even when the slot's dates changed in the
 * store after the page loaded them.
 */
export function placementRange(
  slot: Pick<DatedSchedulerSlot, 'firstDate' | 'lastDate'>,
  liveFrom: string,
  effectiveUntil?: string
): string {
  const from = liveFrom > slot.firstDate ? liveFrom : slot.firstDate;
  return `[${from},${effectiveUntil ?? slot.lastDate}]`;
}

/** One locked row's occupancy. One entry per ROW, so a team may appear twice. */
export interface LockedOccupant {
  assignmentId: string;
  teamId: string;
  slotId: string | null;
  /**
   * The row's stored range (M4.8): the dates it holds, inside its slot's
   * validity. Read by the hard constraint, the objective and the daylight
   * report. Absent or null: the slot's whole validity.
   */
  effectiveDateRange?: string | null;
}

export interface Placement {
  teamId: string;
  slotId: string;
  source: 'auto';
  /** Set only when the daylight pass truncated the placement (D8). */
  effectiveUntil?: string;
}

export interface Unplaced {
  teamId: string;
  reason: string;
  /** For `coach-preference`: the `must_keep` dimensions no legal slot kept. */
  dimensions?: string[];
  /** For `past-sunset`: the first date past sunset. */
  date?: string;
}

// ---------------------------------------------------------------------------
// Coach preferences (8.6 PR 3b, PR 8; plan §5 decision 3)
// ---------------------------------------------------------------------------
//
// `must_keep` is a hard filter on NEW placements: `admissible` refuses a slot
// whose verdict is violated, everywhere the search seats a team. `prefer_keep`
// is a lexicographic tiebreak: the greedy seed takes the legal slot with the
// fewest breaches (slot order breaking ties, which is today's order), and the
// climb accepts an equal-scoring move that breaches less. Locked rows are
// never judged: they are occupancy, not candidates. With no preferences every
// verdict is zero and every step below is byte-identical to before.

function mustKeepViolated(gate: PreferenceGate, teamId: string, slotId: string): boolean {
  return gate.verdicts.get(teamId)?.get(slotId)?.mustKeepViolated ?? false;
}

function breachesOf(gate: PreferenceGate, teamId: string, slotId: string): number {
  return gate.verdicts.get(teamId)?.get(slotId)?.preferKeepBreaches ?? 0;
}

/** Total `prefer_keep` breaches of a set of new placements. */
export function totalBreaches(gate: PreferenceGate, placements: Placement[]): number {
  let total = 0;
  for (const p of placements) total += breachesOf(gate, p.teamId, p.slotId);
  return total;
}

function admissible(
  gate: PreferenceGate,
  team: PreparedTeam,
  slot: DatedSchedulerSlot,
  coachAssignments: Map<string, TimeWindow[]>,
  slotOccupants: Map<string, SlotOccupant[]>,
  slotCapacity: Map<string, number>
): boolean {
  if (mustKeepViolated(gate, team.id, slot.id)) return false;
  return checkHardConstraints(team, slot, coachAssignments, slotOccupants, slotCapacity);
}

// ---------------------------------------------------------------------------
// Seeded PRNG (mulberry32)
// ---------------------------------------------------------------------------

export function createPRNG(seed: number): () => number {
  let state = seed | 0;
  return function mulberry32(): number {
    state += 0x6d2b79f5;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Locked occupancy
// ---------------------------------------------------------------------------

export interface BaseOccupancy {
  /** Each slot's capacity: what the occupants below are judged against, per date. */
  slotCapacity: Map<string, number>;
  /** Who holds each slot, on which dates: locked rows and relocations (M4.8). */
  slotOccupants: Map<string, SlotOccupant[]>;
  /** Coach windows held by locked rows and relocations, each on its dates. */
  coachAssignments: Map<string, TimeWindow[]>;
  /** Locked rows that occupy a slot of this run (scored as `locked`). */
  inRun: LockedOccupant[];
  /**
   * Locked rows whose slot is not among this run's slots: still locked, but
   * this run holds no time for that slot, so neither its capacity nor its
   * coaches' window can be counted. Reported (`lock.lockedOutsideRun`), never
   * silently treated as free or as clashing.
   */
  outsideRun: LockedOccupant[];
  /**
   * Live relocations (11d-0) whose slot is not among this run's, or reads no
   * slot: reported, as `outsideRun` is. Those in the run are occupancy only
   * (capacity and coach windows above), never scored.
   */
  relocatedOutsideRun: LoadedRelocation[];
  /**
   * In-run rows whose stored range cannot be read (M4.8 Q2): held on their
   * slot's whole validity, as every row was before M4.8 -- never freed -- and
   * reported (`lock.unreadableRange`).
   */
  unreadableRange: LockedOccupant[];
  /**
   * In-run rows with no live date from `liveFrom` on: still locked, holding
   * nothing a new placement could meet, and counted (`lock.endedRows`) so the
   * run says why a slot they used to block is offered.
   */
  endedRows: LockedOccupant[];
}

/** A slot's whole validity on its weekday; `null` when it has no date at all. */
function wholeValidity(slot: DatedSchedulerSlot): LiveDays | null {
  const span = assignmentLiveSpan({ firstDay: slot.firstDay, lastDay: slot.lastDay });
  return span.status === LIVE_SPAN_STATUS.LIVE ? { first: span.first, last: span.last } : null;
}

/**
 * Every locked row, one at a time, each on its own live dates (M4.8, plan
 * §3.3). Iterating the list -- not a team-keyed collection -- is what keeps a
 * two-row team's both slots occupied. Then every live relocation, on its
 * target slot's whole validity (Q5).
 */
export function buildLockedOccupancy(
  locked: LockedOccupant[],
  teamsById: Map<string, SchedulerTeam>,
  slotsById: Map<string, DatedSchedulerSlot>,
  relocated: LoadedRelocation[],
  liveFrom: string
): BaseOccupancy {
  const today = calendarDayNumber(liveFrom);
  if (today === null) throw new TypeError(`liveFrom ${String(liveFrom)} is not a date`);
  const slotCapacity = new Map([...slotsById.values()].map((s) => [s.id, s.capacity]));
  const slotOccupants = new Map<string, SlotOccupant[]>();
  const coachAssignments = new Map<string, TimeWindow[]>();
  const inRun: LockedOccupant[] = [];
  const outsideRun: LockedOccupant[] = [];
  const relocatedOutsideRun: LoadedRelocation[] = [];
  const unreadableRange: LockedOccupant[] = [];
  const endedRows: LockedOccupant[] = [];
  // One unit of the slot on these dates, and the team's coaches there then.
  const hold = (teamId: string, slot: DatedSchedulerSlot, days: LiveDays) => {
    const occupants = slotOccupants.get(slot.id) ?? [];
    occupants.push({ teamId, first: days.first, last: days.last });
    slotOccupants.set(slot.id, occupants);
    const team = teamsById.get(teamId);
    if (!team) return;
    for (const coachId of team.coachIds) {
      const existing = coachAssignments.get(coachId) ?? [];
      existing.push({
        teamId,
        slotId: slot.id,
        first: days.first,
        last: days.last,
        startSec: slot.startSec,
        endSec: slot.endSec,
      });
      coachAssignments.set(coachId, existing);
    }
  };
  for (const row of locked) {
    const slot = row.slotId ? slotsById.get(row.slotId) : undefined;
    if (!slot) {
      outsideRun.push(row);
      continue;
    }
    inRun.push(row);
    const span = assignmentLiveSpan({
      firstDay: slot.firstDay,
      lastDay: slot.lastDay,
      range: row.effectiveDateRange,
    });
    if (span.status === LIVE_SPAN_STATUS.UNREADABLE) {
      // Q2: never freed. The slot's whole validity is the most the row could
      // ever be live on, so this holds at least what it does.
      unreadableRange.push(row);
      const whole = wholeValidity(slot);
      if (whole) hold(row.teamId, slot, whole);
      continue;
    }
    if (span.status !== LIVE_SPAN_STATUS.LIVE || span.last < today) {
      endedRows.push(row);
      continue;
    }
    hold(row.teamId, slot, span);
  }
  // One unit per (row, slot): a row has at most one live window at a time
  // (the table's EXCLUDE constraint), so two windows of one row moved onto
  // one slot never meet on a date and hold one unit between them, not two.
  const heldForRow = new Set<string>();
  for (const relocation of relocated) {
    const slot = relocation.slotId ? slotsById.get(relocation.slotId) : undefined;
    if (!slot) {
      relocatedOutsideRun.push(relocation);
      continue;
    }
    const key = `${relocation.assignmentId ?? relocation.exceptionId}|${slot.id}`;
    if (heldForRow.has(key)) continue;
    heldForRow.add(key);
    const whole = wholeValidity(slot);
    if (whole) hold(relocation.teamId, slot, whole);
  }
  return {
    slotCapacity,
    slotOccupants,
    coachAssignments,
    inRun,
    outsideRun,
    relocatedOutsideRun,
    unreadableRange,
    endedRows,
  };
}

// ---------------------------------------------------------------------------
// Scoring wrapper
// ---------------------------------------------------------------------------

interface ScoringResult {
  score: number;
  evaluation: ReturnType<typeof evaluatePracticeSchedule>;
}

function scoreSchedule(
  base: BaseOccupancy,
  placements: Placement[],
  unassigned: Unplaced[],
  teams: SchedulerTeam[],
  slots: DatedSchedulerSlot[],
  liveFrom: string
): ScoringResult {
  const slotsById = new Map(slots.map((s) => [s.id, s]));
  const unreadable = new Set(base.unreadableRange);
  // The whole schedule is measured -- locked rows and new placements -- so
  // coverage and coach conflicts are the season's, not the proposal's alone.
  //
  // **Dated (M4.8 Q1)**, from the store's dating: every slot carries M4.7's
  // `firstDate`, `lastDate`, `startTime` and `endTime`, each locked row its
  // stored range (one the constraint holds season-long, Q2, is scored the same
  // way: on its slot's whole validity), and each new placement the range the
  // page writes, `[max(firstDate, liveFrom), lastDate]` -- or the daylight
  // pass's truncated end. So the objective, the hard constraint, the persisted
  // evaluation and the panel judge one schedule by one rule
  // (`summary.dateModel: 'dated'`). Nothing from the request's slot objects
  // reaches here: only the fields below are passed.
  const assignments = [
    ...base.inRun.map((row) => ({
      id: row.assignmentId,
      teamId: row.teamId,
      slotId: row.slotId as string,
      source: 'locked',
      ...(unreadable.has(row) || row.effectiveDateRange == null
        ? {}
        : { effectiveDateRange: row.effectiveDateRange }),
    })),
    ...placements.map((p) => {
      const slot = slotsById.get(p.slotId)!;
      return { ...p, effectiveDateRange: placementRange(slot, liveFrom, p.effectiveUntil) };
    }),
  ];
  const evaluation = evaluatePracticeSchedule({
    assignments: assignments as unknown as Parameters<
      typeof evaluatePracticeSchedule
    >[0]['assignments'],
    unassigned,
    teams: teams as unknown as Parameters<typeof evaluatePracticeSchedule>[0]['teams'],
    slots: slots.map(
      ({ id, day, start, end, capacity, firstDate, lastDate, startTime, endTime }) => ({
        id,
        day,
        start,
        end,
        capacity,
        firstDate,
        lastDate,
        startTime,
        endTime,
      })
    ) as unknown as Parameters<typeof evaluatePracticeSchedule>[0]['slots'],
  });

  // Compute fitness from scoring-engine metrics
  const { summary, coachConflicts } = evaluation;
  const totalTeams = summary.totalTeams || 1;
  const coverage = summary.assignedTeams / totalTeams;
  const conflictPenalty = Math.min(1, (coachConflicts?.length ?? 0) * 0.15);
  const coveragePenalty = 1 - coverage;
  const fairnessScore = 1 - (conflictPenalty * 0.15 + coveragePenalty * 0.5);

  return { score: Math.max(0, fairnessScore), evaluation };
}

// ---------------------------------------------------------------------------
// Hill Climbing optimizer
// ---------------------------------------------------------------------------

interface OptimizerState {
  /** Placeable teams only. A locked team is never a key here. */
  assignmentMap: Map<string, string>;
  autoTeams: string[];
  slotsById: Map<string, DatedSchedulerSlot>;
  teamsById: Map<string, SchedulerTeam>;
  slotCapacity: Map<string, number>;
  slotOccupants: Map<string, SlotOccupant[]>;
  coachAssignments: Map<string, TimeWindow[]>;
  gate: PreferenceGate;
  placeableTeamIds: string[];
  unassignedTeamIds: string[];
}

function cloneWindows<T>(source: Map<string, T[]>): Map<string, T[]> {
  const copy = new Map<string, T[]>();
  for (const [k, v] of source) copy.set(k, [...v]);
  return copy;
}

/**
 * Seat `teamId` on `slot`, on the new placement's live dates: one occupant of
 * the slot, and a window for every coach on the team. The caller has checked
 * the seat is legal, so `slot.span` is set.
 */
function seat(
  occupants: Map<string, SlotOccupant[]>,
  coachAssignments: Map<string, TimeWindow[]>,
  team: SchedulerTeam | undefined,
  teamId: string,
  slot: DatedSchedulerSlot
): void {
  const span = slot.span as LiveDays;
  const list = occupants.get(slot.id) ?? [];
  list.push({ teamId, first: span.first, last: span.last, placed: true });
  occupants.set(slot.id, list);
  if (!team) return;
  for (const coachId of team.coachIds) {
    const existing = coachAssignments.get(coachId) ?? [];
    existing.push({
      teamId,
      slotId: slot.id,
      first: span.first,
      last: span.last,
      startSec: slot.startSec,
      endSec: slot.endSec,
      placed: true,
    });
    coachAssignments.set(coachId, existing);
  }
}

function buildState(
  base: BaseOccupancy,
  placements: Placement[],
  placeableTeamIds: string[],
  teamsById: Map<string, SchedulerTeam>,
  slotsById: Map<string, DatedSchedulerSlot>,
  gate: PreferenceGate
): OptimizerState {
  const assignmentMap = new Map<string, string>();
  const autoTeams: string[] = [];
  for (const a of placements) {
    assignmentMap.set(a.teamId, a.slotId);
    autoTeams.push(a.teamId);
  }

  const slotOccupants = cloneWindows(base.slotOccupants);
  const coachAssignments = cloneWindows(base.coachAssignments);
  for (const [teamId, slotId] of assignmentMap) {
    const slot = slotsById.get(slotId);
    if (!slot || !slot.span) continue;
    seat(slotOccupants, coachAssignments, teamsById.get(teamId), teamId, slot);
  }

  return {
    assignmentMap,
    autoTeams,
    slotsById,
    teamsById,
    slotCapacity: base.slotCapacity,
    slotOccupants,
    coachAssignments,
    gate,
    placeableTeamIds,
    unassignedTeamIds: placeableTeamIds.filter((id) => !assignmentMap.has(id)),
  };
}

function tryMutate(
  state: OptimizerState,
  rand: () => number
): { placements: Placement[]; unassigned: Unplaced[]; type: string } | null {
  const { autoTeams, unassignedTeamIds, slotsById, teamsById, gate } = state;
  const hasUnassigned = unassignedTeamIds.length > 0;
  const hasMultipleAuto = autoTeams.length >= 2;

  const r = rand();
  let mutationType: string;
  if (hasUnassigned && r < 0.4) mutationType = 'relocate';
  else if (hasMultipleAuto && r < 0.85) mutationType = 'swap';
  else if (hasMultipleAuto && autoTeams.length >= 3) mutationType = 'chain-swap';
  else if (hasMultipleAuto) mutationType = 'swap';
  else return null;

  const newMap = new Map(state.assignmentMap);
  const newOcc = cloneWindows(state.slotOccupants);
  const newCoach = cloneWindows(state.coachAssignments);

  const remove = (teamId: string) => {
    const slotId = newMap.get(teamId);
    if (!slotId) return;
    newMap.delete(teamId);
    // Only the team's own placement leaves: a relocation or locked row that
    // names the same team (a relocation whose source row is not current) is
    // fixed occupancy and stays held.
    const ownPlacement = (o: { teamId?: string; placed?: boolean }) =>
      o.placed === true && o.teamId === teamId;
    newOcc.set(
      slotId,
      (newOcc.get(slotId) ?? []).filter((o) => !ownPlacement(o))
    );
    const team = teamsById.get(teamId);
    if (!team) return;
    for (const coachId of team.coachIds) {
      const entries = newCoach.get(coachId) ?? [];
      newCoach.set(
        coachId,
        entries.filter((e) => !ownPlacement(e))
      );
    }
  };

  const add = (teamId: string, slotId: string): boolean => {
    const team = teamsById.get(teamId);
    const slot = slotsById.get(slotId);
    if (!team || !slot) return false;
    if (!admissible(gate, team, slot, newCoach, newOcc, state.slotCapacity)) return false;
    newMap.set(teamId, slotId);
    seat(newOcc, newCoach, team, teamId, slot);
    return true;
  };

  if (mutationType === 'swap') {
    const i = Math.floor(rand() * autoTeams.length);
    let j = Math.floor(rand() * (autoTeams.length - 1));
    if (j >= i) j++;
    const slotA = newMap.get(autoTeams[i]);
    const slotB = newMap.get(autoTeams[j]);
    if (!slotA || !slotB || slotA === slotB) return null;
    remove(autoTeams[i]);
    remove(autoTeams[j]);
    if (!add(autoTeams[i], slotB) || !add(autoTeams[j], slotA)) return null;
  } else if (mutationType === 'relocate') {
    const targetId = hasUnassigned
      ? unassignedTeamIds[Math.floor(rand() * unassignedTeamIds.length)]
      : autoTeams[Math.floor(rand() * autoTeams.length)];
    const slotIds = [...slotsById.keys()];
    const targetSlot = slotIds[Math.floor(rand() * slotIds.length)];
    const currentSlot = newMap.get(targetId);
    if (currentSlot === targetSlot) return null;
    if (currentSlot) remove(targetId);
    if (!add(targetId, targetSlot)) {
      if (currentSlot) add(targetId, currentSlot);
      return null;
    }
  } else {
    if (autoTeams.length < 3) return null;
    const indices = new Set<number>();
    while (indices.size < 3) indices.add(Math.floor(rand() * autoTeams.length));
    const [iA, iB, iC] = [...indices];
    const sA = newMap.get(autoTeams[iA]);
    const sB = newMap.get(autoTeams[iB]);
    const sC = newMap.get(autoTeams[iC]);
    if (!sA || !sB || !sC || sA === sB || sB === sC || sA === sC) return null;
    remove(autoTeams[iA]);
    remove(autoTeams[iB]);
    remove(autoTeams[iC]);
    if (!add(autoTeams[iA], sB) || !add(autoTeams[iB], sC) || !add(autoTeams[iC], sA)) return null;
  }

  const placements = [...newMap.entries()]
    .map(([teamId, slotId]) => ({ teamId, slotId, source: 'auto' as const }))
    .sort((a, b) => a.teamId.localeCompare(b.teamId));

  const unassigned = state.placeableTeamIds
    .filter((id) => !newMap.has(id))
    .map((teamId) => ({ teamId, reason: 'optimizer-unplaced' }));

  return { placements, unassigned, type: mutationType };
}

// ---------------------------------------------------------------------------
// Greedy seed (server-side — replicate practiceScheduling.js core logic)
// ---------------------------------------------------------------------------

function generateGreedySeed(
  base: BaseOccupancy,
  teams: SchedulerTeam[],
  placeableTeamIds: string[],
  slots: DatedSchedulerSlot[],
  gate: PreferenceGate
): { placements: Placement[]; unassigned: Unplaced[] } {
  const slotsById = new Map(slots.map((s) => [s.id, s]));
  const slotOccupants = cloneWindows(base.slotOccupants);
  const coachAssignments = cloneWindows(base.coachAssignments);
  const assignedTeamIds = new Set<string>();
  const placements: Placement[] = [];

  const assign = (team: SchedulerTeam, slotId: string) => {
    placements.push({ teamId: team.id, slotId, source: 'auto' });
    assignedTeamIds.add(team.id);
    seat(slotOccupants, coachAssignments, team, team.id, slotsById.get(slotId)!);
  };

  // 1. Locked rows are already in `base` -- one unit per row.

  // 2. Sort by coach load (multi-team coaches first), counted over the whole
  //    roster, as before.
  const coachTeamCounts = new Map<string, number>();
  for (const team of teams) {
    for (const coachId of team.coachIds) {
      coachTeamCounts.set(coachId, (coachTeamCounts.get(coachId) ?? 0) + 1);
    }
  }
  const busiestCoachCount = new Map(
    teams.map((team) => [
      team.id,
      Math.max(0, ...team.coachIds.map((coachId) => coachTeamCounts.get(coachId) ?? 0)),
    ])
  );
  const placeable = new Set(placeableTeamIds);
  const sorted = teams
    .filter((team) => placeable.has(team.id))
    .sort((a, b) => {
      const ac = busiestCoachCount.get(a.id) ?? 0;
      const bc = busiestCoachCount.get(b.id) ?? 0;
      return bc - ac || a.id.localeCompare(b.id);
    });

  // 3. Greedy assignment, placeable teams only. Among the admissible slots
  //    (must_keep already filtered), fewest prefer_keep breaches first, then
  //    slot order -- so with no preferences this is the first legal slot.
  for (const team of sorted) {
    if (assignedTeamIds.has(team.id)) continue;
    let bestSlot: SchedulerSlot | undefined;
    let bestBreaches = Infinity;
    for (const slot of slots) {
      if (!admissible(gate, team, slot, coachAssignments, slotOccupants, base.slotCapacity)) {
        continue;
      }
      const breaches = breachesOf(gate, team.id, slot.id);
      if (breaches < bestBreaches) {
        bestSlot = slot;
        bestBreaches = breaches;
        if (breaches === 0) break;
      }
    }
    if (bestSlot) assign(team, bestSlot.id);
  }

  const unassigned = sorted
    .filter((t) => !assignedTeamIds.has(t.id))
    .map((t) => ({ teamId: t.id, reason: NO_SLOT_REASON }));

  return { placements, unassigned };
}

// ---------------------------------------------------------------------------
// Why a team is unplaced
// ---------------------------------------------------------------------------

/**
 * Re-derive each unplaced team's reason against the FINAL schedule, the rule
 * core's repair applies (plan §4): legal slots before the `must_keep` filter
 * and none after is TIME TBD `coach-preference`, naming the dimensions. No
 * legal slot at all keeps the search's own reason. The subject set is the
 * search's unplaced list, which both the seed and `tryMutate` derive from the
 * placeable roster minus the placements -- never from the placements alone.
 *
 * When no run slot has a live date from today on, every unplaced team is
 * `no-live-date` (M4.8 Q3): no slot was left to fit, whatever the search
 * called it.
 */
function explainUnplaced(
  gate: PreferenceGate,
  base: BaseOccupancy,
  placements: Placement[],
  unassigned: Unplaced[],
  teamsById: Map<string, SchedulerTeam>,
  slotsById: Map<string, DatedSchedulerSlot>
): Unplaced[] {
  if (slotsById.size > 0 && [...slotsById.values()].every((slot) => slot.span === null)) {
    return unassigned.map((entry) => ({ teamId: entry.teamId, reason: NO_LIVE_DATE_REASON }));
  }
  if (gate.verdicts.size === 0) return unassigned;
  const final = buildState(base, placements, [], teamsById, slotsById, gate);
  return unassigned.map((entry) => {
    const verdicts = gate.verdicts.get(entry.teamId);
    const team = teamsById.get(entry.teamId);
    if (!verdicts || !team) return entry;
    const legal = [...slotsById.values()].filter((slot) =>
      checkHardConstraints(
        team,
        slot,
        final.coachAssignments,
        final.slotOccupants,
        final.slotCapacity
      )
    );
    const kept = legal.filter((slot) => !verdicts.get(slot.id)?.mustKeepViolated);
    if (legal.length === 0 || kept.length > 0) return entry;
    const dimensions = [
      ...new Set(legal.flatMap((slot) => verdicts.get(slot.id)?.violatedDimensions ?? [])),
    ].sort();
    return { teamId: entry.teamId, reason: COACH_PREFERENCE_TBD_REASON, dimensions };
  });
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export interface OptimizerConfig {
  timeBudgetMs: number;
  maxIterations: number;
  seed: number;
}

export interface OptimizerResult {
  /** New placements for placeable teams ONLY. Never a locked team. */
  placements: Placement[];
  /** Placeable teams the run could not place, each with its reason. */
  unassigned: Unplaced[];
  /** `prefer_keep` breaches across the returned placements (0 with no preferences). */
  preferKeepBreaches: number;
  /** Locked rows whose slot is not in this run (still locked). */
  lockedOutsideRun: LockedOccupant[];
  /** Live relocations whose slot is not in this run (11d-0): still held, nothing here to hold. */
  relocatedOutsideRun: LoadedRelocation[];
  /** In-run locked rows whose range could not be read: held season-long (M4.8 Q2). */
  unreadableRange: LockedOccupant[];
  /** In-run locked rows with no live date from `liveFrom` on: holding nothing (M4.8). */
  endedRows: LockedOccupant[];
  /** The date new placements are live from (M4.8 Q7). */
  liveFrom: string;
  /**
   * Each returned placement's judged range, by team (`placementRange`): what
   * the page writes. A placeable team holds at most one placement.
   */
  placementRanges: Record<string, string>;
  /** The daylight post-pass's report; `null` when the run was given no daylight context. */
  daylight: DaylightReport | null;
  evaluation: ReturnType<typeof evaluatePracticeSchedule>;
  seedScore: number;
  bestScore: number;
  iterations: number;
  restarts: number;
  elapsedMs: number;
  terminationReason: string;
}

// Yield every N iterations to avoid 2s CPU limit on Supabase free tier.
// The free tier enforces a 2s CPU ceiling per isolate burst but allows
// up to 150s wall-clock time; yielding lets the event loop breathe.
const YIELD_EVERY = 100;
// Safety wall-clock cutoff (140s) — leave 10s headroom before the
// hard 150s isolate timeout on the free tier.
const WALL_CLOCK_LIMIT_MS = 140_000;

export async function runPracticeOptimizer(params: {
  teams: SchedulerTeam[];
  slots: SchedulerSlot[];
  locked: LockedOccupant[];
  /**
   * Live `relocated` exceptions (`loadSeasonPracticeLock`, 11d-0): each holds
   * its slot season-wide, as a locked row does. Absent means none were read.
   */
  relocated?: LoadedRelocation[];
  placeableTeamIds: string[];
  /**
   * Approved coach preferences, as verdicts per (placeable team, slot). Loaded
   * server-side (`coach-preference-load.ts`); never from the request body.
   */
  preferenceGate?: PreferenceGate;
  /**
   * Venue lighting and coordinates loaded server-side
   * (`practice-daylight.ts`), and the slots as the pass reads them. When
   * given, the daylight post-pass runs over the search's result.
   */
  daylight?: DaylightContext;
  /**
   * The run's dating (M4.8): today on the season's clock and every run slot's
   * dates and wall window, read from the store as the daylight pass reads
   * them. Required: the solver never guesses a season for a slot.
   */
  dating: SolverDating;
  config: OptimizerConfig;
  /** Called at each CPU yield, e.g. for a progress audit. */
  onProgress?: (progress: {
    iteration: number;
    bestScore: number;
    elapsedMs: number;
    restartCount: number;
  }) => void;
}): Promise<OptimizerResult> {
  const { teams, locked, placeableTeamIds, config: cfg } = params;
  const { liveFrom } = params.dating;
  const gate = params.preferenceGate ?? EMPTY_PREFERENCE_GATE;
  const startTime = Date.now();
  const slots = dateSchedulerSlots(params.slots, params.dating);
  const teamsById = new Map(teams.map((t) => [t.id, t]));
  const slotsById = new Map(slots.map((s) => [s.id, s]));
  const base = buildLockedOccupancy(locked, teamsById, slotsById, params.relocated ?? [], liveFrom);
  const rand = createPRNG(cfg.seed);

  const seed = generateGreedySeed(base, teams, placeableTeamIds, slots, gate);
  const seedScoring = scoreSchedule(base, seed.placements, seed.unassigned, teams, slots, liveFrom);
  let bestPlacements = seed.placements;
  let bestUnassigned = seed.unassigned;
  let bestScore = seedScoring.score;
  let bestEvaluation = seedScoring.evaluation;
  const seedBreaches = totalBreaches(gate, seed.placements);
  let bestBreaches = seedBreaches;

  let currentPlacements = seed.placements;
  let currentScore = bestScore;
  let currentBreaches = seedBreaches;
  // Lexicographic: a higher score wins; at an equal score, fewer breaches.
  const better = (score: number, breaches: number, than: number, thanBreaches: number) =>
    score > than || (score === than && breaches < thanBreaches);

  let iteration = 0;
  let stallCount = 0;
  let restartCount = 0;
  const stallLimit = 80;
  const maxRestarts = 5;

  // Hill Climbing loop (with CPU yield + wall-clock guard)
  while (iteration < cfg.maxIterations) {
    const elapsed = Date.now() - startTime;

    // Phase 9: Wall-clock safety cutoff (140s)
    if (elapsed >= WALL_CLOCK_LIMIT_MS) {
      console.warn(
        `[auto-scheduler] Wall-clock safety cutoff at ${elapsed}ms / ${iteration} iterations`
      );
      break;
    }

    // Original time-budget check (user-configurable, shorter)
    if (elapsed >= cfg.timeBudgetMs) break;

    iteration++;

    const state = buildState(base, currentPlacements, placeableTeamIds, teamsById, slotsById, gate);
    const mutated = tryMutate(state, rand);

    if (!mutated) {
      stallCount++;
      if (stallCount >= stallLimit && restartCount < maxRestarts) {
        restartCount++;
        stallCount = 0;
        const restart = generateGreedySeed(base, teams, placeableTeamIds, slots, gate);
        currentPlacements = restart.placements;
        currentBreaches = totalBreaches(gate, restart.placements);
        currentScore = scoreSchedule(
          base,
          currentPlacements,
          restart.unassigned,
          teams,
          slots,
          liveFrom
        ).score;
      }
      // Phase 9: yield on stall iterations too (every YIELD_EVERY)
      if (iteration % YIELD_EVERY === 0) {
        await new Promise((r) => setTimeout(r, 0));
      }
      continue;
    }

    const candidateScoring = scoreSchedule(
      base,
      mutated.placements,
      mutated.unassigned,
      teams,
      slots,
      liveFrom
    );

    const candidateBreaches = totalBreaches(gate, mutated.placements);
    if (better(candidateScoring.score, candidateBreaches, currentScore, currentBreaches)) {
      currentPlacements = mutated.placements;
      currentScore = candidateScoring.score;
      currentBreaches = candidateBreaches;
      stallCount = 0;

      if (better(candidateScoring.score, candidateBreaches, bestScore, bestBreaches)) {
        bestPlacements = mutated.placements;
        bestUnassigned = mutated.unassigned;
        bestScore = candidateScoring.score;
        bestBreaches = candidateBreaches;
        bestEvaluation = candidateScoring.evaluation;
      }
    } else {
      stallCount++;
      if (stallCount >= stallLimit && restartCount < maxRestarts) {
        restartCount++;
        stallCount = 0;
        currentPlacements = seed.placements;
        currentScore = seedScoring.score;
        currentBreaches = seedBreaches;
      }
    }

    // Phase 9: Yield CPU every YIELD_EVERY iterations to stay under
    // the Supabase free-tier 2s CPU burst limit while using up to
    // 140s of wall-clock time.
    if (iteration % YIELD_EVERY === 0) {
      await new Promise((r) => setTimeout(r, 0));
      params.onProgress?.({
        iteration,
        bestScore,
        elapsedMs: Date.now() - startTime,
        restartCount,
      });
    }
  }

  const elapsedMs = Date.now() - startTime;
  const terminationReason =
    elapsedMs >= WALL_CLOCK_LIMIT_MS
      ? 'wall-clock-safety'
      : elapsedMs >= cfg.timeBudgetMs
        ? 'time-budget'
        : iteration >= cfg.maxIterations
          ? 'max-iterations'
          : 'converged';

  let placements: Placement[] = bestPlacements;
  let unassigned = explainUnplaced(
    gate,
    base,
    bestPlacements,
    bestUnassigned,
    teamsById,
    slotsById
  );
  let preferKeepBreaches = bestBreaches;
  let evaluation = bestEvaluation;
  let daylight: DaylightReport | null = null;
  // The daylight post-pass (8.9 PR 6): after the search, over its placements
  // only. Declared, not optimised (D11): nothing above steers toward slots
  // that survive the season. A withdrawn placement leaves the schedule, so
  // the score, evaluation and breaches are re-measured over what remains
  // (the returned schedule's, not the search's); otherwise they are the
  // search's own values, untouched.
  if (params.daylight) {
    const pass = applyDaylightPostPass({
      placements,
      unassigned,
      locked,
      ...params.daylight,
    });
    daylight = pass.report;
    // Re-measured when the pass truncated a placement as well as when it
    // withdrew one: the objective is dated (M4.8 Q1), so the dates a
    // truncation hands to TIME TBD leave the persisted evaluation too.
    if (pass.report.meta.placementsWithdrawn > 0 || pass.report.meta.placementsTruncated > 0) {
      const rescored = scoreSchedule(
        base,
        pass.placements,
        pass.unassigned,
        teams,
        slots,
        liveFrom
      );
      evaluation = rescored.evaluation;
      bestScore = rescored.score;
      preferKeepBreaches = totalBreaches(gate, pass.placements);
    }
    placements = pass.placements;
    unassigned = pass.unassigned;
  }

  return {
    placements,
    unassigned,
    preferKeepBreaches,
    lockedOutsideRun: base.outsideRun,
    relocatedOutsideRun: base.relocatedOutsideRun,
    unreadableRange: base.unreadableRange,
    endedRows: base.endedRows,
    liveFrom,
    placementRanges: Object.fromEntries(
      placements.map((p) => [
        p.teamId,
        placementRange(slotsById.get(p.slotId)!, liveFrom, p.effectiveUntil),
      ])
    ),
    daylight,
    evaluation,
    seedScore: seedScoring.score,
    bestScore,
    iterations: iteration,
    restarts: restartCount,
    elapsedMs,
    terminationReason,
  };
}
