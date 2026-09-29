/**
 * Synthetic season rows for the 8.6 3b PR 11a enact witnesses
 * (`tests/practiceEnact.test.js`): the loader's row shapes, fake uuids, no
 * real venue, club, person or coordinate.
 *
 * Every world retires field F1 after 2026-10-14 (so D = 2026-10-15), and
 * `displacedFromRows()` names the displaced series from the ROWS alone
 * (slot on F1, a weekday occurrence in `[max(from, D), until]`), never from
 * a repair's output.
 */

export const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const LOC_A = uuid(101);
export const LOC_B = uuid(102);
export const F1 = uuid(201);
export const F2 = uuid(202);
export const F3 = uuid(203);
export const RETIRED_AFTER = '2026-10-14';
export const D = '2026-10-15';
export const RANGE = '[2026-09-01,2026-12-01)';
export const RETIREMENT = { kind: 'retirement', field: { id: F1, effective_to: RETIRED_AFTER } };
export const FINGERPRINT = '0123456789abcdef0123456789abcdef';
export const ENACT_KEY = uuid(999);
export const SEASON = uuid(900);

export const LOCATIONS = [
  { id: LOC_A, name: 'Venue A', lighting_available: true, latitude: null, longitude: null },
  { id: LOC_B, name: 'Venue B', lighting_available: true, latitude: null, longitude: null },
];

/** The fields, with F1's stored `effective_to` as given (committed by default). */
export function fieldsWith(storedEffectiveTo = RETIRED_AFTER) {
  return [
    { id: F1, location_id: LOC_A, name: 'Field 1', effective_to: storedEffectiveTo },
    { id: F2, location_id: LOC_A, name: 'Field 2', effective_to: null },
    { id: F3, location_id: LOC_B, name: 'Field 3', effective_to: null },
  ];
}

export const slot = (n, field, day, start, end) => ({
  id: uuid(n),
  field_id: field,
  field_subunit_id: null,
  day_of_week: day,
  start_time: start,
  end_time: end,
  valid_from: '2026-09-01',
  valid_until: '2026-11-30',
});

export const assignment = (n, team, slotN, range = RANGE) => ({
  id: uuid(n),
  team_id: uuid(team),
  practice_slot_id: uuid(slotN),
  effective_date_range: range,
  source: 'auto',
});

export const coach = (coachN, team) => ({
  team_id: uuid(team),
  coach_id: uuid(coachN),
  role: 'lead',
  effective_from: '2026-08-01',
  effective_to: null,
});

/** Loader-shaped rows. */
export function rowsOf({ slots, assignments, coaches = [], fields = fieldsWith() }) {
  return {
    locations: LOCATIONS,
    fields,
    fieldSubunits: [],
    practiceSlots: slots,
    practiceAssignments: assignments,
    teamCoachAssignments: coaches,
    fieldClosures: [],
  };
}

const WEEKDAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const dayNumber = (iso) => Math.round(Date.parse(`${iso}T00:00:00Z`) / 86400000);
const weekdayOf = (n) => WEEKDAYS[(((n + 4) % 7) + 7) % 7];

/**
 * The series a retirement of `fieldId` from `from` displaces, from the rows
 * alone: its slot is on the field, and its range holds an occurrence of its
 * weekday on or after `from`.
 */
export function displacedFromRows(rows, fieldId, from = D) {
  const slotById = new Map(rows.practiceSlots.map((s) => [s.id, s]));
  return rows.practiceAssignments
    .filter((a) => {
      const s = slotById.get(a.practice_slot_id);
      if (s.field_id !== fieldId) return false;
      const [lo, hi] = a.effective_date_range.slice(1, -1).split(',');
      const last = a.effective_date_range.endsWith(')') ? dayNumber(hi) - 1 : dayNumber(hi);
      for (let n = Math.max(dayNumber(lo), dayNumber(from)); n <= last; n += 1) {
        if (weekdayOf(n) === s.day_of_week.toUpperCase()) return true;
      }
      return false;
    })
    .map((a) => a.id)
    .sort();
}

/** The meta-assertion every witness ends on: it examined something. */
export function requireExamined(count, what) {
  if (count === 0) throw new Error(`the witness examined no ${what}`);
  return count;
}
