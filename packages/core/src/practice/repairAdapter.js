/**
 * The practice repair adapter (8.6 PR 3b plan §7, PR 9): database rows in,
 * `repairPracticeLoss()` input out; the repair's result in, the
 * `practice-persistence` repair payload out. Pure: it reads nothing and
 * fetches nothing. Loading the rows is the caller's, as the user, through RLS.
 *
 * **Unwired**, like the repair it feeds: nothing in the app calls it until
 * 3b PR 10's panel (pinned by `tests/unwiredLayerImporters.test.js`).
 *
 * ## Rows -> repair input ({@link buildPracticeRepairInput})
 *
 * - **Venues are locations.** The facility graph's `venueId` is the
 *   `locations.id` (a lowercase uuid), never a slug: the repair compares the
 *   venue preference dimension by location id and refuses any other graph
 *   once a preference asks for something. Surfaces are `fields.id`, and a
 *   `field_subunits.id` is a child surface of its field.
 * - **One coach source.** `coachesByTeam` (coach overlaps, coach days) is
 *   derived from the same `team_coach_assignments` rows passed on as
 *   `teamCoachAssignments` (preferences), on the loss date. The repair
 *   judges preferences over those rows on each series-window's first day,
 *   which is the loss date for every series already running on it; a series
 *   that starts later is judged on its own first day (declared, not
 *   reconciled).
 * - **Daylight.** Given `daylight` (the season's sunset table rows and zone),
 *   the calendar is built here from those and from the SAME location rows the
 *   graph is: `lighting_available` is the graph venue's `lit`, coordinates are
 *   the venue's daylight record. Nothing is geocoded. Without `daylight` the
 *   repair gets no calendar and says so itself
 *   (`PRACTICE_REPAIR_DAYLIGHT_UNCHECKED`); the adapter never hides it.
 * - **Portable lighting (8.9 D14).** `lightingOverrides` pass through in the
 *   PR A shape (`{slotId, from, until}`). Their table lands in D14 PR B, and
 *   nothing here reads it: none supplied is declared in `declared`, never
 *   assumed silently.
 *
 * ## Result -> payload ({@link buildPracticeRepairPayload})
 *
 * The whole intended write is in `plan`, enumerated from the repair result's
 * `rehomed` and `timeTbd` (every displaced series-window, once). A retirement
 * splits: the row is closed at D-1 (`closes`) and a re-home is a new row from
 * D (`assigned_via: 'repair'`); a TIME TBD is a `time_tbd` exception on the
 * closed row over `[D, until]`, after its new range. A blackout never splits:
 * each window is an exception on the original row.
 *
 * **Refused until 3b PR 12.** Readers expand only an assignment's own range
 * and do not apply exceptions yet, so any exception whose window still lies
 * inside its row's range after this save would leave that window's practices
 * shown. The writer refuses the daylight case (22023); this adapter refuses
 * every such window first -- a mid-range one (ending before its series does)
 * and a blackout window that reaches the series' end but lies inside its
 * unclosed row alike. A refusal names the window and keeps the exception it
 * would have written (in `plan`), and `payload` is then `null`: the whole
 * save is refused, nothing is dropped.
 *
 * `unlockRequired` lists the locked rows the save re-ranges. The unlock itself
 * is the admin's answer to the override prompt (PR 11), never this adapter's.
 *
 * @module practice/repairAdapter
 */

import { buildAvailabilityCalendar } from '../availability/calendar.js';
import { buildFacilityGraph, isoDateOfDayNumber, isoDayNumber } from '../facility/index.js';
import { coachesOfTeamOn } from '../people/assignmentHistory.js';
import { buildPracticeAssignmentRows } from '../practiceSupabase.js';
import { CoachPreferencePlacementSchema } from './coachPreferences.js';

/** `practice_exceptions.kind` (20260929000000), pinned to the Edge enum. */
export const PRACTICE_EXCEPTION_ROW_KIND = Object.freeze({
  RELOCATED: 'relocated',
  TIME_TBD: 'time_tbd',
});

/**
 * The `cause_kind` a repair window carries. `daylight` is the Edge
 * auto-scheduler's truncated remainder only: a repair window keeps its own
 * cause, and a daylight refusal is only in its `tbd_reason`.
 */
export const PRACTICE_REPAIR_CAUSE_KIND = Object.freeze({
  BLACKOUT: 'blackout',
  RETIREMENT: 'retirement',
});

/** Why a planned write is refused. */
export const PRACTICE_REPAIR_PAYLOAD_REFUSAL = Object.freeze({
  /** The window ends before its series' range does (3b plan, notes from 8.9 PR 6b). */
  MID_RANGE_WINDOW: 'mid-range-window',
  /** The window reaches the series' end but lies inside its unclosed row. */
  WINDOW_INSIDE_ROW: 'window-inside-row',
  /** A retirement row that starts on or after D cannot be closed at D-1. */
  ROW_NOT_CLOSABLE: 'row-not-closable',
  /** No practice slot of the re-home's shape is valid over its window. */
  NO_SLOT_FOR_SHAPE: 'no-slot-for-shape',
});

const WEEKDAYS = new Set(['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** What `coachPreferences.js` accepts as a location id: its contract, not a copy. */
const LocationIdSchema = CoachPreferencePlacementSchema.shape.locationId;

/** @param {unknown} value @returns {string} */
function id(value) {
  return String(value).toLowerCase();
}

/** @param {string} date @param {number} days @returns {string} */
function shiftDate(date, days) {
  return isoDateOfDayNumber(isoDayNumber(date) + days);
}

/**
 * A Postgres `time` (`HH:MM` or `HH:MM:SS`, whole minutes) as minutes past
 * midnight; throws on anything else rather than reading it as midnight.
 */
function timeToMinutes(value, what) {
  const match = typeof value === 'string' ? value.match(/^(\d{2}):(\d{2})(?::00)?$/) : null;
  const minutes = match ? Number(match[1]) * 60 + Number(match[2]) : NaN;
  if (!match || Number(match[2]) > 59 || minutes > 1440) {
    throw new TypeError(`repair adapter: ${what} "${value}" is not a whole-minute time`);
  }
  return minutes;
}

/**
 * A `daterange` as read back (`[a,b)` canonically; `[a,b]` as written) as
 * inclusive `{from, until}`, or `null` when either end is open or missing.
 */
export function parseDateRange(text) {
  const match =
    typeof text === 'string'
      ? text.trim().match(/^([[(])\s*"?([^,"]*)"?\s*,\s*"?([^\])"]*)"?\s*([\])])$/)
      : null;
  if (!match || !ISO_DATE.test(match[2]) || !ISO_DATE.test(match[3])) return null;
  const from = match[1] === '(' ? shiftDate(match[2], 1) : match[2];
  const until = match[4] === ')' ? shiftDate(match[3], -1) : match[3];
  return until < from ? null : { from, until };
}

/**
 * The repair's input from database rows.
 *
 * @param {Object} rows
 * @param {Array<{id: string, name?: string, lighting_available?: boolean|null,
 *   latitude?: number|string|null, longitude?: number|string|null}>} rows.locations
 * @param {Array<{id: string, location_id: string, name?: string, effective_to?: string|null}>} rows.fields
 * @param {Array<{id: string, field_id: string, label?: string}>} [rows.fieldSubunits]
 * @param {Array<Object>} rows.practiceSlots - `practice_slots` rows
 * @param {Array<Object>} rows.practiceAssignments - the season's CURRENT rows: the pre-apply snapshot
 * @param {{kind: 'blackout', blackout: Object} | {kind: 'retirement', field: Object}} rows.loss
 * @param {Array<Object>} [rows.teamCoachAssignments] - `team_coach_assignments` rows
 * @param {Array<Object>} [rows.coachPreferences] - `coach_practice_preferences` rows
 * @param {{timeZone: string, sunsets?: Array<Object>}} [rows.daylight]
 * @param {Array<{slotId: string, from: string, until: string}>} [rows.lightingOverrides]
 * @param {Object} [rows.options] - `weights`, `changeBudget`, `searchNodeLimit`, `strategy`
 * @param {string} [rows.baseFingerprint] - the snapshot's writer fingerprint
 */
export function buildPracticeRepairInput(rows) {
  const locations = rows.locations ?? [];
  const fields = rows.fields ?? [];
  const subunits = rows.fieldSubunits ?? [];

  /* -- the graph: venues are locations ------------------------------------ */
  const venues = locations.map((location) => {
    const venueId = id(location.id);
    if (!LocationIdSchema.safeParse(venueId).success) {
      throw new TypeError(`repair adapter: location id "${location.id}" is not a uuid`);
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
        throw new TypeError(`repair adapter: subunit ${subunit.id} names an unread field`);
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

  /* -- slots, and the shape each one offers ------------------------------- */
  const slotRows = new Map();
  const slots = (rows.practiceSlots ?? []).map((row) => {
    const surfaceId = id(row.field_subunit_id ?? row.field_id);
    const startMinutes = timeToMinutes(row.start_time, `slot ${row.id} start_time`);
    const weekday = String(row.day_of_week).toUpperCase();
    if (!WEEKDAYS.has(weekday)) {
      throw new TypeError(`repair adapter: slot ${row.id} day_of_week "${row.day_of_week}"`);
    }
    const slot = {
      id: id(row.id),
      surfaceId,
      weekday,
      startMinutes,
      durationMinutes: timeToMinutes(row.end_time, `slot ${row.id} end_time`) - startMinutes,
      validFrom: row.valid_from ?? null,
      validUntil: row.valid_until ?? null,
    };
    slotRows.set(slot.id, slot);
    return slot;
  });
  const inventoryKeys = new Map();
  for (const slot of slots) {
    const shape = {
      surfaceId: slot.surfaceId,
      weekday: slot.weekday,
      startMinutes: slot.startMinutes,
      durationMinutes: slot.durationMinutes,
    };
    inventoryKeys.set(shapeKeyOf(shape), shape);
  }

  /* -- the pre-apply snapshot -------------------------------------------- */
  const snapshot = (rows.practiceAssignments ?? []).map((row) => {
    const slotId = id(row.practice_slot_id ?? row.slot_id);
    if (!slotRows.has(slotId)) {
      throw new TypeError(`repair adapter: assignment ${row.id} names unread slot ${slotId}`);
    }
    return {
      id: id(row.id),
      teamId: id(row.team_id),
      slotId,
      rangeText: row.effective_date_range ?? null,
      range: parseDateRange(row.effective_date_range),
      source: row.source ?? null,
    };
  });
  const assignments = snapshot.map((row) => ({
    id: row.id,
    slotId: row.slotId,
    teamId: row.teamId,
    effectiveFrom: row.range?.from ?? null,
    effectiveUntil: row.range?.until ?? null,
  }));

  /* -- the loss ------------------------------------------------------------ */
  const cause = lossOf(rows.loss, fields);

  /* -- coaches: one source, one date -------------------------------------- */
  const coachRows = (rows.teamCoachAssignments ?? []).map((row) => ({
    team_id: id(row.team_id),
    coach_id: id(row.coach_id),
    role: row.role,
    effective_from: row.effective_from,
    effective_to: row.effective_to ?? null,
  }));
  const coachesByTeam = {};
  for (const teamId of [...new Set(snapshot.map((row) => row.teamId))].sort()) {
    const { lead, assistants } = coachesOfTeamOn(coachRows, teamId, cause.loss.from);
    coachesByTeam[teamId] = [...new Set([...lead, ...assistants])].sort();
  }
  const preferenceRows = rows.coachPreferences ?? [];
  // An approved row is the one in force (one per coach and dimension, a
  // replaced row is `superseded`): the Edge loader's contract
  // (`coach-preference-load.ts`), which does not date-filter it either.
  const coachPreferences = preferenceRows
    .filter((row) => row.status === 'approved')
    .map((row) => ({
      coachId: id(row.coach_id),
      dimension: row.dimension,
      level: row.level,
      value: row.value ?? null,
    }));

  /* -- daylight ------------------------------------------------------------ */
  let calendar;
  if (rows.daylight) {
    calendar = buildAvailabilityCalendar({
      sunsets: rows.daylight.sunsets ?? [],
      timeZone: rows.daylight.timeZone,
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
  }
  const lightingOverrides = (rows.lightingOverrides ?? []).map((override) => ({
    slotId: id(override.slotId),
    from: override.from,
    until: override.until,
  }));

  const input = {
    plan: { slots, assignments, source: 'practice_assignments' },
    graph,
    loss: cause.loss,
    inventory: [...inventoryKeys.values()],
    coachesByTeam,
    ...(coachPreferences.length > 0 ? { coachPreferences, teamCoachAssignments: coachRows } : {}),
    ...(calendar ? { calendar } : {}),
    ...(lightingOverrides.length > 0 ? { lightingOverrides } : {}),
    ...(rows.options ?? {}),
  };
  return {
    input,
    context: {
      cause,
      snapshot,
      slots: slotRows,
      baseFingerprint: rows.baseFingerprint ?? null,
    },
    declared: {
      daylight: calendar
        ? { supplied: true }
        : { supplied: false, note: 'no daylight calendar: the repair reports DAYLIGHT_UNCHECKED' },
      lightingOverrides:
        lightingOverrides.length > 0
          ? { supplied: true, count: lightingOverrides.length }
          : {
              supplied: false,
              count: 0,
              note: 'no portable-lighting windows supplied: no date is exempt from the daylight limit (their table is 8.9 D14 PR B)',
            },
      coachPreferences: { rowsRead: preferenceRows.length, approved: coachPreferences.length },
    },
  };
}

/** `numeric` may arrive as a string from PostgREST. */
function coordinate(value) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

function shapeKeyOf(shape) {
  return `${shape.surfaceId}|${shape.weekday}|${shape.startMinutes}|${shape.durationMinutes}`;
}

/** The repair `loss`, and what caused it, from a blackout or a field retirement. */
function lossOf(loss, fields) {
  if (loss?.kind === 'blackout') {
    const row = loss.blackout;
    const surfaceIds =
      row.field_id != null
        ? [id(row.field_id)]
        : fields
            .filter((field) => id(field.location_id) === id(row.location_id))
            .map((field) => id(field.id))
            .sort();
    const minutes =
      row.start_minutes == null
        ? {}
        : { startMinutes: row.start_minutes, endMinutes: row.end_minutes };
    return {
      kind: PRACTICE_REPAIR_CAUSE_KIND.BLACKOUT,
      causeId: id(row.id),
      loss: {
        surfaceIds,
        from: row.blackout_from,
        until: row.blackout_until,
        ...minutes,
        // The enum value, never the free-text note.
        reason: row.reason,
      },
    };
  }
  if (loss?.kind === 'retirement') {
    const field = loss.field;
    if (typeof field?.effective_to !== 'string' || !ISO_DATE.test(field.effective_to)) {
      throw new TypeError('repair adapter: a retirement needs the field effective_to');
    }
    return {
      kind: PRACTICE_REPAIR_CAUSE_KIND.RETIREMENT,
      causeId: id(field.id),
      loss: {
        surfaceIds: [id(field.id)],
        from: shiftDate(field.effective_to, 1),
        reason: 'retirement',
      },
    };
  }
  throw new TypeError(`repair adapter: unknown loss kind ${JSON.stringify(loss?.kind)}`);
}

/**
 * The `practice-persistence` write for a repair result.
 *
 * @param {ReturnType<typeof buildPracticeRepairInput>} adapted
 * @param {Object} result - `repairPracticeLoss(adapted.input)`
 * @returns {{
 *   plan: { assignmentRows: Object[], closes: Object[], exceptions: Object[], unlockRequired: Object[] },
 *   refused: Object[],
 *   payload: { assignmentRows: Object[], repair: Object } | null,
 * }}
 */
export function buildPracticeRepairPayload(adapted, result) {
  const { cause, snapshot, slots, baseFingerprint } = adapted.context;
  const expected = cause.kind === PRACTICE_REPAIR_CAUSE_KIND.RETIREMENT ? 'split' : 'override';
  if (result.representation !== expected) {
    throw new Error(
      `repair adapter: a ${cause.kind} result must be a ${expected}, not ${result.representation}`
    );
  }
  const split = result.representation === 'split';
  const rowById = new Map(snapshot.map((row) => [row.id, row]));
  const closes = [];
  const exceptions = [];
  const newRows = [];
  const unlockRequired = [];
  const refused = [];
  const causeFields = { cause_kind: cause.kind, cause_id: cause.causeId };

  /** The slot row of `shape` valid over `[from, until]`: the lowest id, deterministically. */
  const slotFor = (shape, from, until) =>
    [...slots.values()]
      .filter(
        (slot) =>
          shapeKeyOf(slot) === shapeKeyOf(shape) &&
          (slot.validFrom === null || slot.validFrom <= from) &&
          (slot.validUntil === null || slot.validUntil >= until)
      )
      .map((slot) => slot.id)
      .sort()[0] ?? null;

  /**
   * Plan one exception on `row`, whose range after this save ends on
   * `rowLastDay`. Until readers apply exceptions (3b PR 12), one whose window
   * still meets that range would leave its practices shown: refused, and
   * kept in `plan` so the refusal names exactly what it withholds.
   */
  const planException = (row, rowLastDay, exception) => {
    exceptions.push(exception);
    const { from, until } = /** @type {{from: string, until: string}} */ (
      parseDateRange(exception.window)
    );
    if (from > rowLastDay) return;
    refused.push({
      assignment_id: row.id,
      window: exception.window,
      why:
        until < row.range.until
          ? PRACTICE_REPAIR_PAYLOAD_REFUSAL.MID_RANGE_WINDOW
          : PRACTICE_REPAIR_PAYLOAD_REFUSAL.WINDOW_INSIDE_ROW,
      exception,
    });
  };

  const entries = [
    ...result.rehomed.map((entry) => ({ entry, placed: true })),
    ...result.timeTbd.map((entry) => ({ entry, placed: false })),
  ].sort((a, b) => a.entry.assignmentId.localeCompare(b.entry.assignmentId));

  for (const { entry, placed } of entries) {
    const row = rowById.get(entry.assignmentId);
    if (!row || !row.range) {
      throw new Error(`repair adapter: ${entry.assignmentId} is not a dated snapshot row`);
    }
    const from = split ? result.lossDate : entry.window.from;
    const until = split ? row.range.until : entry.window.until;
    const window = `[${from},${until}]`;
    const slotId = placed ? slotFor(entry.to, from, until) : null;
    if (placed && slotId === null) {
      refused.push({
        assignment_id: row.id,
        window,
        why: PRACTICE_REPAIR_PAYLOAD_REFUSAL.NO_SLOT_FOR_SHAPE,
        shape: { ...entry.to },
      });
      continue;
    }

    if (split) {
      if (row.range.from >= from) {
        refused.push({
          assignment_id: row.id,
          window,
          why: PRACTICE_REPAIR_PAYLOAD_REFUSAL.ROW_NOT_CLOSABLE,
        });
        continue;
      }
      closes.push({ assignment_id: row.id, last_day: shiftDate(from, -1) });
      unlockRequired.push({ assignment_id: row.id, why: 'closes re-ranges it' });
      if (placed) {
        const slot = /** @type {any} */ (slots.get(/** @type {string} */ (slotId)));
        const [built] = buildPracticeAssignmentRows({
          assignments: [{ teamId: row.teamId, slotId, effectiveFrom: from, effectiveUntil: until }],
          slots: [
            {
              id: slotId,
              effectiveFrom: slot.validFrom ?? from,
              effectiveUntil: slot.validUntil ?? until,
            },
          ],
        });
        newRows.push({
          team_id: built.team_id,
          practice_slot_id: built.practice_slot_id,
          effective_date_range: built.effective_date_range,
          source: built.source,
          assigned_via: 'repair',
        });
      } else {
        // After the close the window lies wholly after the row: a tail window.
        planException(row, shiftDate(from, -1), {
          assignment_id: row.id,
          window,
          kind: PRACTICE_EXCEPTION_ROW_KIND.TIME_TBD,
          tbd_reason: entry.reason,
          ...causeFields,
        });
      }
      continue;
    }

    // A blackout: an exception on the unclosed row, over its window.
    planException(
      row,
      row.range.until,
      placed
        ? {
            assignment_id: row.id,
            window,
            kind: PRACTICE_EXCEPTION_ROW_KIND.RELOCATED,
            practice_slot_id: slotId,
            ...causeFields,
          }
        : {
            assignment_id: row.id,
            window,
            kind: PRACTICE_EXCEPTION_ROW_KIND.TIME_TBD,
            tbd_reason: entry.reason,
            ...causeFields,
          }
    );
  }

  // Every snapshot row's key is re-sent unless `closes` keeps it by id: a
  // save that left one out would prune it (and the lock would refuse).
  const closed = new Set(closes.map((close) => close.assignment_id));
  const assignmentRows = [
    ...snapshot
      .filter((row) => !closed.has(row.id))
      .map((row) => ({
        team_id: row.teamId,
        practice_slot_id: row.slotId,
        effective_date_range: row.rangeText,
        ...(row.source ? { source: row.source } : {}),
      })),
    ...newRows,
  ];
  const plan = { assignmentRows, closes, exceptions, unlockRequired };
  return {
    plan,
    refused,
    payload:
      refused.length > 0
        ? null
        : {
            assignmentRows,
            repair: {
              unlock: [],
              closes,
              exceptions,
              withdrawExceptions: [],
              ...(baseFingerprint ? { baseFingerprint } : {}),
            },
          },
  };
}
