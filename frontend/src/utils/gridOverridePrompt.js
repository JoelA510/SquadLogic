/**
 * The scheduling grid's override prompt (operator ruling 2;
 * `docs/PLAN_GRID_OVERRIDE_PROMPT.md` §2): which saved rows a staged save
 * would make writer v3 remove, and which of those the admin may unlock.
 *
 * Pure, so the page and its tests share one rule.
 */
import { practiceRangeBounds } from '@squadlogic/core/utils/practiceOccurrences.js';

const lower = (value) => String(value ?? '').toLowerCase();

/** A stored row's writer key: team, slot and its inclusive dates. */
function storedKey(row) {
  const bounds = practiceRangeBounds(row?.effectiveDateRange ?? row?.effective_date_range);
  if (!bounds) return null;
  const slotId = row?.slotId ?? row?.practice_slot_id ?? row?.slot_id;
  return `${lower(row?.teamId ?? row?.team_id)}|${lower(slotId)}|${bounds.first}|${bounds.last}`;
}

/**
 * A payload row's writer key, with the window the payload builder sends:
 * the row's own dates, else the slot's (`buildPracticeAssignmentRows`).
 */
function payloadKey(assignment, slotById) {
  const slot = slotById.get(assignment.slotId);
  const from = assignment.effectiveFrom ?? slot?.effectiveFrom;
  const until = assignment.effectiveUntil ?? slot?.effectiveUntil;
  if (!from || !until) return null;
  return `${lower(assignment.teamId)}|${lower(assignment.slotId)}|${from}|${until}`;
}

/**
 * The saved rows this save would make the writer prune, and the ones the
 * prompt may not unlock.
 *
 * Both of the writer's arms (`20261002000000_practice_exceptions_daylight.sql`
 * :717-773), over the season's current rows:
 *
 * - a team IN the payload: each stored row whose (team, slot, range) key the
 *   payload does not carry;
 * - a team ABSENT from it: each of its `auto` rows.
 *
 * Every season row belongs to a season team (the read is scoped through
 * teams -> divisions), so the writer's season scope is the rows' own teams.
 *
 * A row is a **stray** when no override was staged for its team in this
 * session, or its team is absent from the payload. A stray is never unlocked:
 * the prompt refuses instead (plan §2.1, Q7).
 *
 * An **overlap** is a stored row the save keeps that a NEW payload row
 * double-books: same team, same weekday, overlapping minutes and dates. The
 * writer refuses that save whatever is unlocked (:920-956), so the prompt
 * refuses it first. Judged only where both slots were read.
 *
 * @param {{ seasonRows: Array<Record<string, any>>,
 *   assignments: Array<{ teamId: any, slotId: any, effectiveFrom?: string, effectiveUntil?: string }>,
 *   slotById: Map<any, { effectiveFrom: string, effectiveUntil: string,
 *     day?: string, startTime?: string, endTime?: string }>,
 *   stagedTeamIds: Iterable<any> }} input
 * @returns {{ prune: Array<Record<string, any>>, strays: Array<Record<string, any>>,
 *   overlaps: Array<Record<string, any>> }} each in the writer's order (by id)
 */
export function gridOverridePlan({ seasonRows, assignments, slotById, stagedTeamIds }) {
  const payloadTeams = new Set(assignments.map((assignment) => lower(assignment.teamId)));
  const payloadKeys = new Set(
    assignments.map((assignment) => payloadKey(assignment, slotById)).filter(Boolean)
  );
  const staged = new Set([...stagedTeamIds].map(lower));
  const prune = [];
  const strays = [];
  const kept = [];
  const sorted = [...seasonRows].sort((a, b) => lower(a.id).localeCompare(lower(b.id)));
  for (const row of sorted) {
    const team = lower(row.teamId ?? row.team_id);
    const inPayload = payloadTeams.has(team);
    const pruned = inPayload ? !payloadKeys.has(storedKey(row)) : lower(row.source) === 'auto';
    if (!pruned) {
      kept.push(row);
      continue;
    }
    prune.push(row);
    if (!inPayload || !staged.has(team)) strays.push(row);
  }
  const storedKeys = new Set(sorted.map(storedKey).filter(Boolean));
  const added = assignments.filter((assignment) => {
    const key = payloadKey(assignment, slotById);
    return key !== null && !storedKeys.has(key);
  });
  const overlaps = kept.filter((row) => {
    const rowSlot = slotById.get(row.slotId ?? row.practice_slot_id ?? row.slot_id);
    const rowRange = practiceRangeBounds(row.effectiveDateRange ?? row.effective_date_range);
    if (!rowSlot?.day || !rowRange) return false;
    return added.some((assignment) => {
      if (lower(assignment.teamId) !== lower(row.teamId ?? row.team_id)) return false;
      const slot = slotById.get(assignment.slotId);
      const from = assignment.effectiveFrom ?? slot?.effectiveFrom;
      const until = assignment.effectiveUntil ?? slot?.effectiveUntil;
      return (
        Boolean(slot?.day && from && until) &&
        slot.day === rowSlot.day &&
        slot.startTime < rowSlot.endTime &&
        rowSlot.startTime < slot.endTime &&
        from <= rowRange.last &&
        rowRange.first <= until
      );
    });
  });
  return { prune, strays, overlaps };
}

/** The ISO date the day before `iso`. */
export function previousDay(iso) {
  const [year, month, day] = String(iso).split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day - 1)).toISOString().slice(0, 10);
}

/**
 * The writer's `closes` argument for an override that must not rewrite
 * history (operator decision on #546): each replaced series that started
 * before today is ended in place on yesterday, keeping its id and its past
 * dates. A series that starts today or later has no past to keep, so it is
 * replaced whole (no entry). Decided by date, never guessed: a range that
 * does not read gets no entry, and the writer then removes the row only
 * because it is listed in `unlock`, which the prompt showed.
 *
 * Each row closed here is re-ranged, so it is in `unlock` too (it is in
 * `prune`): the writer's lock covers `closes` (:783-791).
 *
 * @param {Array<Record<string, any>>} prune - from {@link gridOverridePlan}
 * @param {string} seasonToday - `YYYY-MM-DD` on the season's clock
 * @returns {Array<{ assignment_id: string, last_day: string }>}
 */
export function gridOverrideCloses(prune, seasonToday) {
  return prune.flatMap((row) => {
    const bounds = practiceRangeBounds(row.effectiveDateRange ?? row.effective_date_range);
    if (!bounds || !(bounds.first < seasonToday && seasonToday <= bounds.last)) return [];
    return [{ assignment_id: row.id, last_day: previousDay(seasonToday) }];
  });
}

/**
 * Whether two prompts name the same rows, as they stood: id, slot and dates
 * (the enact's `prompt-changed` rule). A row re-ranged in place keeps its id,
 * and must not pass as the row the admin was shown.
 */
export function samePruneSet(a, b) {
  const rows = (list) =>
    list
      .map((row) => `${lower(row.id)}|${storedKey(row)}`)
      .sort()
      .join(',');
  return rows(a) === rows(b);
}

/**
 * The reasons an admin can give (Q3): a picklist, never free text, so the
 * audit row holds no PII.
 */
export const GRID_OVERRIDE_REASONS = Object.freeze([
  Object.freeze({ code: 'field-change', label: 'Field change' }),
  Object.freeze({ code: 'coach-request', label: 'Coach request' }),
  Object.freeze({ code: 'conflict-fix', label: 'Conflict fix' }),
  Object.freeze({ code: 'other', label: 'Other' }),
]);

/**
 * The generated reason sent with each unlock: `grid override <runId>: <code>`.
 * A save with no run id yet (the Edge mints one) is `grid override: <code>`.
 *
 * @param {{ runId?: string|null, code: string }} input
 * @returns {string}
 */
export function gridOverrideReason({ runId = null, code }) {
  if (!GRID_OVERRIDE_REASONS.some((reason) => reason.code === code)) {
    throw new TypeError(`grid override: unknown reason code ${code}`);
  }
  return runId ? `grid override ${runId}: ${code}` : `grid override: ${code}`;
}

/**
 * The writer's `unlock` argument: exactly the pruned rows, each with the one
 * reason the admin chose.
 *
 * @param {Array<Record<string, any>>} prune - rows carrying their `id`
 * @param {string} reason
 */
export function gridOverrideUnlock(prune, reason) {
  if (!String(reason ?? '').trim()) throw new TypeError('grid override: a reason is required');
  return prune.map((row) => ({ assignment_id: row.id, reason }));
}
