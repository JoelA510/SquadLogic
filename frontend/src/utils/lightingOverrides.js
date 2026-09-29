/**
 * Portable-lighting overrides (8.9 D14 PR D): the pure pieces the request form,
 * the admin queue and the mock RPCs share, so the UI and the mock answer "which
 * slots does this caller coach" and "what dates does this window hold" the same
 * way the database does.
 *
 * The table and RPCs are `supabase/migrations/20261003000000_practice_lighting_overrides.sql`.
 * Nothing here decides anything: every write is one of its four definer RPCs.
 */

import {
  lightingOverrideWindowDates,
  lightingOverrideWindowOf,
} from '@squadlogic/core/practice/lightingOverrides.js';

/**
 * A stored window -> its INCLUSIVE dates, or null for anything but a canonical
 * bounded range. Core's one conversion, the same `approvedLightingOverridesFromRows`
 * uses, so the UI and the scheduler never disagree about a window's last date.
 */
export const datesOfWindow = lightingOverrideWindowDates;

/** Inclusive dates -> the canonical `[from,until+1)` window the RPCs store (core's). */
export const windowOfDates = lightingOverrideWindowOf;

/** Two canonical windows share at least one date (the EXCLUDE's `&&`). */
export function windowsOverlap(a, b) {
  const left = datesOfWindow(a);
  const right = datesOfWindow(b);
  if (!left || !right) return false;
  return left.from <= right.until && right.from <= left.until;
}

/**
 * The slots the user coaches, mirroring `public.caller_coaches_practice_slot`:
 * a slot of the organization with a `practice_assignments` row (on
 * `COALESCE(practice_slot_id, slot_id)`) for a team whose
 * `team_coach_assignments` row is current on `today` and names a coach whose
 * `user_id` is the caller. Every join is held to the slot's organization.
 *
 * Enumerated from the roster tables, never from override rows, so a slot with
 * no override yet is still offered.
 *
 * @param {{ userId: string | null | undefined, orgId: string, today: string,
 *   coaches: any[], teamCoachAssignments: any[], practiceAssignments: any[],
 *   practiceSlots: any[] }} input
 * @returns {Set<string>}
 */
export function coachedPracticeSlotIds({
  userId,
  orgId,
  today,
  coaches,
  teamCoachAssignments,
  practiceAssignments,
  practiceSlots,
}) {
  const slots = new Set();
  if (!userId) return slots;
  const sameOrg = (row) => String(row.organization_id) === String(orgId);
  const coachIds = new Set(
    (coaches || [])
      .filter((coach) => sameOrg(coach) && String(coach.user_id ?? '') === String(userId))
      .map((coach) => String(coach.id))
  );
  const teamIds = new Set(
    (teamCoachAssignments || [])
      .filter(
        (row) =>
          sameOrg(row) &&
          coachIds.has(String(row.coach_id)) &&
          String(row.effective_from) <= today &&
          (row.effective_to === null ||
            row.effective_to === undefined ||
            String(row.effective_to) >= today)
      )
      .map((row) => String(row.team_id))
  );
  const orgSlotIds = new Set((practiceSlots || []).filter(sameOrg).map((slot) => String(slot.id)));
  for (const row of practiceAssignments || []) {
    if (!sameOrg(row) || !teamIds.has(String(row.team_id))) continue;
    const slotId = row.practice_slot_id ?? row.slot_id;
    if (slotId !== null && slotId !== undefined && orgSlotIds.has(String(slotId))) {
      slots.add(String(slotId));
    }
  }
  return slots;
}

/** The EXCLUDE constraint's name, as Postgres reports it in a 23P01. */
export const NO_OVERLAP_CONSTRAINT = 'practice_lighting_overrides_no_overlap';

/** A refusal by the no-overlap EXCLUDE constraint. */
export function isOverlapError(error) {
  return error?.code === '23P01' || String(error?.message ?? '').includes(NO_OVERLAP_CONSTRAINT);
}

export const OVERLAP_MESSAGE =
  'These dates overlap a lighting override already approved on this practice slot. ' +
  'Two approved windows cannot overlap on one slot: withdraw the approved one first, or ' +
  'choose dates that do not overlap.';

/**
 * The message to show for a failed write. The overlap refusal gets its own
 * words; anything else is the database's own message, never a generic one.
 */
export function lightingOverrideErrorMessage(error) {
  if (isOverlapError(error)) return OVERLAP_MESSAGE;
  return error?.message || 'The request failed with no message from the database.';
}

const WEEKDAY_LABEL = {
  mon: 'Mon',
  tue: 'Tue',
  wed: 'Wed',
  thu: 'Thu',
  fri: 'Fri',
  sat: 'Sat',
  sun: 'Sun',
};

/** "Tue 18:00-19:30 · Back Pitch" from a `practice_slots` row. */
export function practiceSlotLabel(slot, fieldNames) {
  if (!slot) return 'Unknown slot';
  const day = WEEKDAY_LABEL[String(slot.day_of_week).toLowerCase()] || slot.day_of_week || '?';
  const clock = (value) => (value ? String(value).slice(0, 5) : '?');
  const field = fieldNames?.get(String(slot.field_id));
  return `${day} ${clock(slot.start_time)}–${clock(slot.end_time)}${field ? ` · ${field}` : ''}`;
}

/** "2026-10-05 to 2026-10-09" for a stored window, or the raw value if unreadable. */
export function formatWindow(window) {
  const dates = datesOfWindow(window);
  if (!dates) return String(window);
  return dates.from === dates.until ? dates.from : `${dates.from} to ${dates.until}`;
}

/** Statuses from which the withdraw RPC accepts a row. */
export const WITHDRAWABLE_STATUSES = Object.freeze(['requested', 'approved']);
