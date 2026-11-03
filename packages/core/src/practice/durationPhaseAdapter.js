/**
 * The duration-phase input adapter: database rows in, the input of
 * `derivePracticeDurationPhases()`, `buildPracticeCompressionReport()` and
 * `buildDstSurvivalReport()` out. Pure: it reads nothing and fetches nothing.
 * Loading the rows is the caller's, as the user, through RLS, all or nothing
 * (a table that failed to read is a failed read, never an empty one).
 *
 * Nothing calls it yet. The read-only "Practice daylight" outlook that will
 * (`docs/changes/2026-11-02-duration-phases-wiring.md`) is its first caller.
 *
 * ## Held to the repair adapter
 *
 * `repairAdapter.js` builds the same graph, slots and calendar from the same
 * rows for the repair. The builders are **duplicated here, not extracted**
 * (owner decision, 2026-11-02: extracting them is a refactor of a module with
 * dozens of test files over it, flagged before it is done), and
 * `tests/practiceDurationPhaseAdapter.test.js` holds the copy to the original
 * over one snapshot: the graph, the calendar and the slots equal
 * `buildPracticeRepairInput()`'s, so a change to either that is not made to the
 * other fails it. Every shared edge follows the repair's contract: a venue id is
 * a lowercase uuid (the `locations.id`), a `numeric` coordinate may arrive as a
 * string, a time is whole-minute `HH:MM[:SS]`, a sub-unit is a child surface of
 * its field, a slot names a field or a sub-unit, an assignment names a slot that
 * was read and has a readable range.
 *
 * ## What it adds, which the repair does not need
 *
 * - **An undated slot is dated by the season window, never skipped.** The
 *   module lists a slot with no `valid_from` or `valid_until` as undated and
 *   judges nothing for it, which a page must not present as "fine". The Edge
 *   daylight pass dates such a slot by the season's own first and last day
 *   (`practice-daylight.ts`), and so does this: a missing end is the season's
 *   (never beyond the end the slot does state). The ids are named in
 *   `declared.datedBySeasonWindow`.
 * - **A missing or unknown season zone is an error**, not a guess: with no zone
 *   the sunset cannot be read onto the season's clock, and reading it as UTC
 *   would move every limit by hours. So is a season with no dates: there is no
 *   window to judge.
 * - **An unreadable `school_day_end` is `null`**, so a shift is refused with a
 *   reason (`earliest-start-unknown`), never assumed; the reason is in
 *   `declared.earliestStart`.
 * - **A lighting window the module would refuse is named, not passed.** The
 *   module refuses an override that names no unlit, dated slot of the plan (it
 *   would be an admin's choice silently unread). A stored window on a slot that
 *   is now on lit ground, or on no slot read, would make the whole report throw,
 *   so it is left out and named in `declared.lightingOverrides.notApplied`.
 *
 * Strategy per slot and operator duration pins have no storage, so they are not
 * inputs: every slot shortens, then moves earlier when the minimum would be
 * broken, and the page says so.
 *
 * @module practice/durationPhaseAdapter
 */

import { buildAvailabilityCalendar, resolveLighting } from '../availability/calendar.js';
import { buildFacilityGraph } from '../facility/index.js';
import { practiceRangeBounds } from '../utils/practiceOccurrences.js';
import { CoachPreferencePlacementSchema } from './coachPreferences.js';
import { approvedLightingOverridesFromRows } from './lightingOverrides.js';
import { buildPracticeSlotSet } from './slots.js';

const WEEKDAYS = new Set(['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** What `coachPreferences.js` accepts as a location id: its contract, not a copy. */
const LocationIdSchema = CoachPreferencePlacementSchema.shape.locationId;

/** Why a stored lighting window was not passed on (`declared.lightingOverrides.notApplied`). */
export const DURATION_PHASE_OVERRIDE_NOT_APPLIED = Object.freeze({
  /** The slot is on lit ground: nothing is judged there, so a window exempts nothing. */
  LIT_GROUND: 'lit-ground',
  /** No slot of this read has that id. */
  UNKNOWN_SLOT: 'unknown-slot',
});

/** @param {unknown} value @returns {string} */
function id(value) {
  return String(value).toLowerCase();
}

/**
 * A Postgres `time` (`HH:MM` or `HH:MM:SS`, whole minutes) as minutes past
 * midnight; throws on anything else rather than reading it as midnight.
 *
 * @param {unknown} value
 * @param {string} what
 */
function timeToMinutes(value, what) {
  const match = typeof value === 'string' ? value.match(/^(\d{2}):(\d{2})(?::00)?$/) : null;
  const minutes = match ? Number(match[1]) * 60 + Number(match[2]) : NaN;
  if (!match || Number(match[2]) > 59 || minutes > 1440) {
    throw new TypeError(`duration phase adapter: ${what} "${value}" is not a whole-minute time`);
  }
  return minutes;
}

/** `numeric` may arrive as a string from PostgREST. */
function coordinate(/** @type {unknown} */ value) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/** @param {{first: string, last: string} | null} bounds */
function rangeOf(bounds) {
  return bounds === null ? null : { from: bounds.first, until: bounds.last };
}

/**
 * The season: its window and zone, which must be there, and the earliest start
 * a shift may use, which may not be.
 *
 * @param {unknown} season - a `season_settings` row
 */
function readSeason(season) {
  if (!season || typeof season !== 'object') {
    throw new TypeError('duration phase adapter: the season settings were not read');
  }
  const row = /** @type {Record<string, unknown>} */ (season);
  const timeZone = typeof row.timezone === 'string' ? row.timezone.trim() : '';
  if (timeZone === '') {
    throw new TypeError(
      'duration phase adapter: the season has no time zone, so no sunset can be read onto its clock'
    );
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
  } catch (error) {
    // Only the zone Intl refuses is expected here; anything else is a bug.
    if (!(error instanceof RangeError)) throw error;
    throw new TypeError(
      `duration phase adapter: the season's time zone "${timeZone}" is not one this runtime knows`
    );
  }
  const from = row.season_start;
  const to = row.season_end;
  if (
    typeof from !== 'string' ||
    typeof to !== 'string' ||
    !ISO_DATE.test(from) ||
    !ISO_DATE.test(to)
  ) {
    throw new TypeError(
      'duration phase adapter: the season has no start and end date, so there is no window to judge'
    );
  }
  if (to < from) {
    throw new TypeError(
      `duration phase adapter: the season ends (${to}) before it starts (${from})`
    );
  }
  return { timeZone, window: { from, to }, earliestStart: schoolDayEnd(row.school_day_end) };
}

/**
 * `season_settings.school_day_end` as the earliest start a shift may use, or
 * `null` with the reason it is not known. A `time` arrives as `HH:MM:SS`.
 *
 * @param {unknown} value
 * @returns {{ minutes: number|null, note: string|null }}
 */
function schoolDayEnd(value) {
  if (value === null || value === undefined) {
    return { minutes: null, note: 'the season has no school_day_end: a shift is refused' };
  }
  const match = typeof value === 'string' ? value.match(/^(\d{1,2}):([0-5]\d)(?::00)?$/) : null;
  if (!match || Number(match[1]) > 23) {
    return {
      minutes: null,
      note: `school_day_end "${value}" is not a whole-minute time of day: a shift is refused`,
    };
  }
  return { minutes: Number(match[1]) * 60 + Number(match[2]), note: null };
}

/**
 * The reports' input from database rows.
 *
 * @param {Object} rows
 * @param {Array<{id: string, name?: string, lighting_available?: boolean|null,
 *   latitude?: number|string|null, longitude?: number|string|null}>} rows.locations
 * @param {Array<{id: string, location_id: string, name?: string}>} rows.fields
 * @param {Array<{id: string, field_id: string, label?: string}>} rows.fieldSubunits
 * @param {Array<Object>} rows.practiceSlots - `practice_slots` rows
 * @param {Array<Object>} rows.practiceAssignments - the season's rows, in the snapshot shape
 *   (`id, team_id, practice_slot_id, effective_date_range`)
 * @param {Array<Object>} rows.lightingOverrides - `practice_lighting_overrides` rows; only
 *   approved ones exempt a date (`approvedLightingOverridesFromRows`)
 * @param {{ timezone?: string|null, season_start?: string|null, season_end?: string|null,
 *   school_day_end?: string|null }} rows.season - the `season_settings` row
 */
export function buildDurationPhaseInput(rows) {
  // A table that was not read is a failed read. The repair adapter defaults an
  // absent table to empty; this one cannot, because "no practices to judge" is
  // a clean report, and a forgotten read must never look like one.
  for (const key of [
    'locations',
    'fields',
    'fieldSubunits',
    'practiceSlots',
    'practiceAssignments',
    'lightingOverrides',
  ]) {
    if (!Array.isArray(/** @type {Record<string, unknown>} */ (rows)?.[key])) {
      throw new TypeError(`duration phase adapter: ${key} were not read`);
    }
  }
  const season = readSeason(rows.season);
  const { locations, fields, fieldSubunits: subunits } = rows;

  /* -- the graph: venues are locations ------------------------------------ */
  const venues = locations.map((location) => {
    const venueId = id(location.id);
    if (!LocationIdSchema.safeParse(venueId).success) {
      throw new TypeError(`duration phase adapter: location id "${location.id}" is not a uuid`);
    }
    return {
      id: venueId,
      name: location.name ? String(location.name) : venueId,
      // `lighting_available` is the venue's flag; NULL is undeclared, never unlit-by-read.
      lit: typeof location.lighting_available === 'boolean' ? location.lighting_available : null,
    };
  });
  const childrenOf = new Map();
  for (const subunit of subunits) {
    const list = childrenOf.get(id(subunit.field_id)) ?? [];
    list.push(id(subunit.id));
    childrenOf.set(id(subunit.field_id), list);
  }
  const fieldById = new Map(fields.map((field) => [id(field.id), field]));
  const surfaces = [
    ...fields.map((field) => ({
      id: id(field.id),
      venueId: id(field.location_id),
      name: field.name ? String(field.name) : id(field.id),
      childIds: [...(childrenOf.get(id(field.id)) ?? [])].sort(),
    })),
    ...subunits.map((subunit) => {
      const field = fieldById.get(id(subunit.field_id));
      if (!field) {
        throw new TypeError(`duration phase adapter: subunit ${subunit.id} names an unread field`);
      }
      return {
        id: id(subunit.id),
        venueId: id(field.location_id),
        name: subunit.label ? String(subunit.label) : id(subunit.id),
        parentId: id(subunit.field_id),
      };
    }),
  ];
  const graph = buildFacilityGraph({ venues, surfaces });

  /* -- slots: every row read, dated by the season where it has no dates ---- */
  const { window } = season;
  /** @type {string[]} */
  const datedBySeasonWindow = [];
  const slots = rows.practiceSlots.map((row) => {
    if (row.field_subunit_id == null && row.field_id == null) {
      throw new TypeError(`duration phase adapter: slot ${row.id} names no field`);
    }
    const surfaceId = id(row.field_subunit_id ?? row.field_id);
    const startMinutes = timeToMinutes(row.start_time, `slot ${row.id} start_time`);
    const weekday = String(row.day_of_week).toUpperCase();
    if (!WEEKDAYS.has(weekday)) {
      throw new TypeError(
        `duration phase adapter: slot ${row.id} day_of_week "${row.day_of_week}"`
      );
    }
    const durationMinutes = timeToMinutes(row.end_time, `slot ${row.id} end_time`) - startMinutes;
    if (durationMinutes <= 0) {
      throw new TypeError(`duration phase adapter: slot ${row.id} does not end after it starts`);
    }
    let validFrom = row.valid_from ?? null;
    let validUntil = row.valid_until ?? null;
    if (validFrom === null || validUntil === null) {
      // The season's own end for the end the row does not state, but never past
      // the end it does: a slot that ended before the season (or starts after
      // it) is left outside the window, where the module judges no date.
      datedBySeasonWindow.push(id(row.id));
      validFrom =
        validFrom ?? (validUntil !== null && validUntil < window.from ? validUntil : window.from);
      validUntil = validUntil ?? (validFrom > window.to ? validFrom : window.to);
    }
    return {
      id: id(row.id),
      surfaceId,
      weekday,
      startMinutes,
      durationMinutes,
      validFrom,
      validUntil,
    };
  });
  const slotIds = new Set(slots.map((slot) => slot.id));

  /* -- the season's assignments ------------------------------------------- */
  const snapshot = rows.practiceAssignments.map((row) => {
    const slotId = id(row.practice_slot_id ?? row.slot_id);
    if (!slotIds.has(slotId)) {
      throw new TypeError(
        `duration phase adapter: assignment ${row.id} names unread slot ${slotId}`
      );
    }
    return {
      id: id(row.id),
      slotId,
      teamId: id(row.team_id),
      range: rangeOf(practiceRangeBounds(row.effective_date_range)),
    };
  });
  const unreadable = snapshot.filter((row) => row.range === null).map((row) => row.id);
  if (unreadable.length > 0) {
    throw new TypeError(
      `duration phase adapter: ${unreadable.length} assignment row(s) have no readable effective_date_range (${unreadable.join(', ')}): the schedule cannot be shown over them`
    );
  }
  const slotSet = buildPracticeSlotSet({
    slots,
    assignments: snapshot.map((row) => ({
      id: row.id,
      slotId: row.slotId,
      teamId: row.teamId,
      effectiveFrom: row.range?.from ?? null,
      effectiveUntil: row.range?.until ?? null,
    })),
    source: 'practice_slots',
  });

  /* -- daylight: the season's zone, each venue's own coordinates ---------- */
  const calendar = buildAvailabilityCalendar({
    sunsets: [],
    timeZone: season.timeZone,
    venueDaylight: locations.map((location) => {
      const latitude = coordinate(location.latitude);
      const longitude = coordinate(location.longitude);
      const pair = latitude !== null && longitude !== null;
      return {
        venueId: id(location.id),
        latitude: pair ? latitude : null,
        longitude: pair ? longitude : null,
      };
    }),
  });

  /* -- portable lighting: approved windows the module can take ------------ */
  const approved = approvedLightingOverridesFromRows(rows.lightingOverrides).map((override) => ({
    slotId: id(override.slotId),
    from: override.from,
    until: override.until,
  }));
  const surfaceOfSlot = new Map(slots.map((slot) => [slot.id, slot.surfaceId]));
  /** @type {Array<{ slotId: string, from: string, until: string }>} */
  const lightingOverrides = [];
  /** @type {Array<{ slotId: string, from: string, until: string, why: string }>} */
  const notApplied = [];
  for (const override of approved) {
    const surfaceId = surfaceOfSlot.get(override.slotId);
    if (surfaceId === undefined) {
      notApplied.push({ ...override, why: DURATION_PHASE_OVERRIDE_NOT_APPLIED.UNKNOWN_SLOT });
    } else if (resolveLighting(graph, calendar, surfaceId).lit === true) {
      notApplied.push({ ...override, why: DURATION_PHASE_OVERRIDE_NOT_APPLIED.LIT_GROUND });
    } else {
      lightingOverrides.push(override);
    }
  }

  return {
    input: {
      slotSet,
      graph,
      calendar,
      window,
      earliestStartMinutes: season.earliestStart.minutes,
      lightingOverrides,
    },
    declared: {
      window,
      timeZone: season.timeZone,
      earliestStart: season.earliestStart,
      datedBySeasonWindow,
      lightingOverrides: {
        rowsRead: rows.lightingOverrides.length,
        approved: approved.length,
        applied: lightingOverrides.length,
        notApplied,
      },
    },
  };
}
