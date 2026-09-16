import { clockToMinutes, isoDayOfWeekName } from '@squadlogic/core/fieldAdmin/index.js';

/**
 * The one mapping from the shipped booking tables onto the shapes
 * `findBlackoutConflicts()` takes.
 *
 * Three surfaces ask the same question — Blackout Dates, Game Scheduling and
 * Practice Scheduling — and a second copy of this mapping is how two of them
 * would end up disagreeing about which column carries the clock.
 *
 * **`slot_date` first, `start` only as a fallback — the sibling's contract.**
 * `game_slots` carries both a `timestamptz` pair and a wall-clock `date` +
 * `time` pair. Blackouts are wall clock with no timezone (the `field_blackouts`
 * header is explicit that two of the corpus's dates fall after DST ends, so an
 * absolute instant would move a boundary by an hour on one machine and not
 * another), so the wall-clock columns are preferred. But PREFERRING them is not
 * ignoring `start`: `public.field_bookings` reads
 * `COALESCE(gs.slot_date, gs.start::date)`, `normalizeGameSlot` in
 * `GameSchedulingPage.jsx` falls back the same way, and so does the mock. A
 * first version of this file read `slot_date` alone, so a slot persisted with
 * `start` and no `slot_date` rendered on the grid and was invisible to the
 * blackout check — a third hand-written reading of "when is this slot", in the
 * family that has already been burned by that twice.
 *
 * The fallback takes the ISO date, which is the UTC day; `gs.start::date` in
 * Postgres is the SESSION's day. They differ for the last hours of a local day
 * west of UTC. The seam is named rather than hidden, and it is reached only by
 * rows whose writer left no `slot_date`.
 *
 * @module utils/fieldBookings
 */

/**
 * A `time` column (`HH:MM:SS`) as minutes past midnight, or `null`.
 *
 * @param {string|null|undefined} value
 * @returns {number|null}
 */
export function timeColumnToMinutes(value) {
  return typeof value === 'string' ? clockToMinutes(value.slice(0, 5)) : null;
}

/**
 * The date a game slot falls on, or `null` when neither column can say.
 *
 * @param {Record<string, any>} row
 * @returns {string|null} `YYYY-MM-DD`
 */
export function gameSlotDate(row) {
  if (row?.slot_date) return String(row.slot_date);
  if (typeof row?.start === 'string' && /^\d{4}-\d{2}-\d{2}/.test(row.start)) {
    return row.start.slice(0, 10);
  }
  return null;
}

/**
 * Map game slots and practice slots onto blackout-comparable bookings.
 *
 * **`unreadable` is reported, never dropped.** A practice slot whose
 * `day_of_week` the column should not hold cannot be placed on a calendar, and
 * silently omitting it would make a conflict count read as "clean" when the
 * truth is "one row could not be judged". The caller decides what to say about
 * it; this function refuses to decide by omission.
 *
 * @param {{ gameSlots?: any[], practiceSlots?: any[] }} input
 * @returns {{ dated: any[], recurring: any[], unreadable: Array<{ kind: string, id: string, why: string }> }}
 */
export function toFieldBookings({ gameSlots = [], practiceSlots = [] } = {}) {
  /** @type {any[]} */ const dated = [];
  /** @type {any[]} */ const recurring = [];
  /** @type {Array<{ kind: string, id: string, why: string }>} */ const unreadable = [];

  for (const row of gameSlots) {
    if (!row?.id || !row?.field_id) continue;
    const onDate = gameSlotDate(row);
    if (onDate === null) {
      // Neither column can place it. `public.field_bookings` calls this
      // `undated` and counts it as affected rather than omitting it; here it
      // cannot be placed against a date range at all, so it is reported as
      // unreadable rather than dropped.
      unreadable.push({ kind: 'game', id: String(row.id), why: 'no slot_date and no start' });
      continue;
    }
    dated.push({
      kind: 'game',
      id: String(row.id),
      fieldId: String(row.field_id),
      label: row.divisions?.name ? `${row.divisions.name} game` : 'Game slot',
      onDate,
      startMinutes: timeColumnToMinutes(row.start_time),
      endMinutes: timeColumnToMinutes(row.end_time),
    });
  }

  for (const row of practiceSlots) {
    if (!row?.id || !row?.field_id) continue;
    const dayOfWeek = isoDayOfWeekName(row.day_of_week);
    if (dayOfWeek === null) {
      unreadable.push({
        kind: 'practice',
        id: String(row.id),
        why: `unreadable day_of_week ${JSON.stringify(row.day_of_week)}`,
      });
      continue;
    }
    recurring.push({
      kind: 'practice',
      id: String(row.id),
      fieldId: String(row.field_id),
      label: row.fields?.name ? `Practice on ${row.fields.name}` : 'Practice slot',
      dayOfWeek,
      startMinutes: timeColumnToMinutes(row.start_time),
      endMinutes: timeColumnToMinutes(row.end_time),
      validFrom: row.valid_from ? String(row.valid_from) : null,
      validUntil: row.valid_until ? String(row.valid_until) : null,
    });
  }

  return { dated, recurring, unreadable };
}

/**
 * `field_closures` rows as `findBlackoutConflicts()` takes them.
 *
 * **`ClosureRowSchema` is `.strict()`, and the hook's rows carry more than it
 * accepts** — `reason`, `note` and `sourceReasonText` are for display and are
 * deliberately not part of the reading, so passing a row straight through
 * throws. The projection lives here, once, for the same reason the booking
 * mapping does: three pages ask the same question, and the first version of
 * this change had two of them passing rows through unprojected. The E2E suite
 * caught it; the unit tests could not, because they constructed inputs already
 * in the schema's shape.
 *
 * @param {Array<Record<string, any>>} closures
 * @returns {Array<Record<string, any>>}
 */
export function toClosureInputs(closures = []) {
  return closures.map((closure) => ({
    id: closure.id,
    source: closure.source,
    closesFieldId: closure.closesFieldId ?? null,
    closesLocationId: closure.closesLocationId ?? null,
    blackoutFrom: closure.blackoutFrom,
    blackoutUntil: closure.blackoutUntil,
    startMinutes: closure.startMinutes ?? null,
    endMinutes: closure.endMinutes ?? null,
  }));
}

/**
 * The warnings the two scheduling pages hand `GameConflictBanner`.
 *
 * One producer, because both pages ask the same question and the first version
 * had each of them mapping findings inline — and BOTH of them discarding
 * `unreadable`, so a slot that could not be placed on a calendar produced no
 * conflict and no notice, and the banner read clean while one row had not been
 * judged. `BlackoutsPage` surfaced it and these two did not: one arm corrected
 * and not its twin, inside a PR about exactly that.
 *
 * **Capped, and the cap says so.** A closure over a busy venue produces one
 * finding per closure x booking pair and the banner renders every one of them.
 * The list is bounded and a summary line carries the remainder, so the COUNT is
 * never wrong even when the list is short.
 *
 * @param {Array<{ message: string, details: Record<string, any> }>} findings
 * @param {Array<{ kind: string, id: string, why: string }>} unreadable
 * @param {number} [limit]
 */
export function toBlackoutWarnings(findings, unreadable = [], limit = 25) {
  const warnings = findings.slice(0, limit).map((finding) => ({
    type: 'field-blackout',
    message: finding.message,
    details: { ...finding.details },
  }));
  if (findings.length > limit) {
    warnings.push({
      type: 'field-blackout',
      message: `… and ${findings.length - limit} more booking(s) inside a blackout.`,
      details: { omitted: findings.length - limit, total: findings.length },
    });
  }
  if (unreadable.length > 0) {
    warnings.push({
      type: 'blackout-unjudged',
      message: `${unreadable.length} booking(s) could not be placed on a calendar and were not checked against blackouts.`,
      details: { count: unreadable.length, first: unreadable[0] },
    });
  }
  return warnings;
}
