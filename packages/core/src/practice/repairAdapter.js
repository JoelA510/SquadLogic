/**
 * The practice repair adapter (8.6 PR 3b plan §7, PR 9): database rows in,
 * `repairPracticeLoss()` input out; the repair's result in, the
 * `practice-persistence` repair payload out. Pure: it reads nothing and
 * fetches nothing. Loading the rows is the caller's, as the user, through RLS.
 *
 * Called read-only by the 3b PR 10 recommendation panel
 * (`frontend/src/utils/practiceRepairPanel.js`, pinned by
 * `tests/unwiredLayerImporters.test.js`): the payload is built there only to
 * show each window's refusal, never sent. Sending it is 3b PR 11.
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
 * - **Ground already closed.** The org's other blackouts (`field_closures`
 *   rows, `fieldClosures`) and every `effective_to` on the SAME location,
 *   field and sub-surface rows the graph is built from become the repair's
 *   `closures`, in the loss's own shape: a retirement closes from
 *   `effective_to` + 1 with no end, a blackout over its dates and minutes. A
 *   venue closes every field it holds (the loss's own reading); the repair
 *   closes what those contain. The loss being repaired is never one of them:
 *   the edited blackout (by id, `field_blackouts` arm) and the retired
 *   field's own `effective_to` are left out and named in
 *   `declared.closures.excludedAsLoss`. A closure naming an unread field or
 *   location refuses the input (a partial read); an import closure naming no
 *   ground at all is not applied and is named in `unattributable`, never
 *   dropped silently. No `fieldClosures` supplied is declared, not assumed.
 *
 * ## Result -> payload ({@link buildPracticeRepairPayload})
 *
 * The whole intended write is in `plan`, enumerated from the repair result's
 * `rehomed` and `timeTbd` (every displaced series-window, once). A retirement
 * splits: the row is closed at D-1 (`closes`) and a re-home is a new row from
 * D (`assigned_via: 'repair'`, its `source` kept); a TIME TBD is a `time_tbd`
 * exception on the closed row over `[D, until]`, after its new range. A row
 * that starts on or after D is replaced by its re-home (its key is not
 * re-sent). A blackout never splits: each window is an exception on the
 * original row. A row's dates are its own `effective_date_range`, read by
 * `practiceRangeBounds` (the feed's parser): a snapshot row it cannot read
 * (NULL, open or empty) refuses the whole input, naming the rows, because
 * the feed cannot show it, the writer cannot key it, and the repair would
 * otherwise read it through its slot's validity instead.
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
 * `unlockRequired` lists the locked rows the save re-ranges or replaces. The
 * unlock itself is the admin's answer to the override prompt (PR 11), never
 * this adapter's, so `payload.repair.unlock` is always empty: sent as it is,
 * a payload with `closes` is refused by the writer's lock (22023), loudly.
 *
 * @module practice/repairAdapter
 */

import { buildAvailabilityCalendar } from '../availability/calendar.js';
import { buildFacilityGraph, isoDateOfDayNumber, isoDayNumber } from '../facility/index.js';
import { coachesOfTeamOn } from '../people/assignmentHistory.js';
import { buildPracticeAssignmentRows } from '../practiceSupabase.js';
import { practiceRangeBounds } from '../utils/practiceOccurrences.js';
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
  /** No practice slot of the re-home's shape is valid over its window. */
  NO_SLOT_FOR_SHAPE: 'no-slot-for-shape',
  /**
   * A retirement TIME TBD on a row that starts on or after D: nothing before
   * D to close it to, and a row-less exception is deferred (8.9 D13 b).
   */
  ROW_NOT_CLOSABLE: 'row-not-closable',
});

/** The `assigned_via` a repair's new row may carry (3b plan `:138-140`). */
const ASSIGNED_VIA = new Set(['repair', 'recommendation']);
const WEEKDAYS = new Set(['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']);
const SEARCH_OPTIONS = new Set(['weights', 'changeBudget', 'searchNodeLimit', 'strategy']);
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
 * The repair's input from database rows.
 *
 * @param {Object} rows
 * @param {Array<{id: string, name?: string, lighting_available?: boolean|null,
 *   latitude?: number|string|null, longitude?: number|string|null,
 *   effective_to?: string|null}>} rows.locations
 * @param {Array<{id: string, location_id: string, name?: string, effective_to?: string|null}>} rows.fields
 * @param {Array<{id: string, field_id: string, label?: string, effective_to?: string|null}>} [rows.fieldSubunits]
 * @param {Array<Object>} rows.practiceSlots - `practice_slots` rows
 * @param {Array<Object>} rows.practiceAssignments - the season's CURRENT rows: the pre-apply snapshot
 * @param {{kind: 'blackout', blackout: Object} | {kind: 'retirement', field: Object}} rows.loss
 * @param {Array<Object>} [rows.teamCoachAssignments] - `team_coach_assignments` rows
 * @param {Array<Object>} [rows.coachPreferences] - `coach_practice_preferences` rows
 * @param {Array<Object>} [rows.fieldClosures] - `field_closures` rows: the org's blackouts
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
    if (row.field_subunit_id == null && row.field_id == null) {
      throw new TypeError(`repair adapter: slot ${row.id} names no field`);
    }
    const surfaceId = id(row.field_subunit_id ?? row.field_id);
    const startMinutes = timeToMinutes(row.start_time, `slot ${row.id} start_time`);
    const weekday = String(row.day_of_week).toUpperCase();
    if (!WEEKDAYS.has(weekday)) {
      throw new TypeError(`repair adapter: slot ${row.id} day_of_week "${row.day_of_week}"`);
    }
    const durationMinutes = timeToMinutes(row.end_time, `slot ${row.id} end_time`) - startMinutes;
    if (durationMinutes <= 0) {
      throw new TypeError(`repair adapter: slot ${row.id} does not end after it starts`);
    }
    const slot = {
      id: id(row.id),
      surfaceId,
      weekday,
      startMinutes,
      durationMinutes,
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
      range: rangeOf(practiceRangeBounds(row.effective_date_range)),
      source: row.source ?? null,
    };
  });
  const unreadable = snapshot.filter((row) => row.range === null).map((row) => row.id);
  if (unreadable.length > 0) {
    throw new TypeError(
      `repair adapter: ${unreadable.length} snapshot row(s) have no readable effective_date_range (${unreadable.join(', ')}): the feed cannot show them and the writer cannot key them, so no repair is planned over them`
    );
  }
  const assignments = snapshot.map((row) => ({
    id: row.id,
    slotId: row.slotId,
    teamId: row.teamId,
    effectiveFrom: row.range?.from ?? null,
    effectiveUntil: row.range?.until ?? null,
  }));

  /* -- the loss ------------------------------------------------------------ */
  const cause = lossOf(rows.loss, fields);

  /* -- ground already closed ---------------------------------------------- */
  const closed = closuresOf(rows, locations, fields, subunits);

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
    ...(closed.closures.length > 0 ? { closures: closed.closures } : {}),
    // Only the search's own knobs: nothing the adapter derived can be replaced.
    ...searchOptionsOf(rows.options ?? {}),
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
      closures: closed.declared,
      coaches:
        coachRows.length > 0
          ? { supplied: true, rowsRead: coachRows.length }
          : {
              supplied: false,
              rowsRead: 0,
              note: 'no team_coach_assignments rows: no coach overlap or coach day is judged',
            },
    },
  };
}

/** The search knobs; any other key is refused, never read and dropped. */
function searchOptionsOf(options) {
  const unknown = Object.keys(options).filter((key) => !SEARCH_OPTIONS.has(key));
  if (unknown.length > 0) {
    throw new TypeError(`repair adapter: unknown options ${JSON.stringify(unknown.sort())}`);
  }
  return options;
}

/** @param {{first: string, last: string} | null} bounds */
function rangeOf(bounds) {
  return bounds === null ? null : { from: bounds.first, until: bounds.last };
}

/** `numeric` may arrive as a string from PostgREST. */
function coordinate(value) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

function shapeKeyOf(shape) {
  return `${shape.surfaceId}|${shape.weekday}|${shape.startMinutes}|${shape.durationMinutes}`;
}

/** Every field of a location: what a location-scoped closure closes. */
function fieldsOfLocation(fields, locationId) {
  return fields
    .filter((field) => id(field.location_id) === id(locationId))
    .map((field) => id(field.id))
    .sort();
}

/**
 * The org's existing closures, the loss left out, as the repair's `closures`
 * (the loss's own shape, in a stable order), and what was declared.
 */
function closuresOf(rows, locations, fields, subunits) {
  const loss = rows.loss;
  const fieldIds = new Set(fields.map((field) => id(field.id)));
  const locationIds = new Set(locations.map((location) => id(location.id)));
  const entries = [];
  const excludedAsLoss = [];
  const closesNoGround = [];
  const unattributable = [];

  /** An `effective_to` on a node row: closed from the day after, with no end. */
  const retirement = (node, row, surfaceIds) => {
    const to = row.effective_to ?? null;
    if (to === null) return;
    if (typeof to !== 'string' || !ISO_DATE.test(to)) {
      throw new TypeError(`repair adapter: ${node} ${row.id} effective_to "${to}" is not a date`);
    }
    const source = { kind: PRACTICE_REPAIR_CAUSE_KIND.RETIREMENT, node, id: id(row.id) };
    if (surfaceIds.length === 0) {
      closesNoGround.push(source);
      return;
    }
    entries.push({
      source,
      closure: { surfaceIds, from: shiftDate(to, 1), reason: 'retirement' },
    });
  };
  for (const location of locations) {
    retirement('location', location, fieldsOfLocation(fields, location.id));
  }
  for (const field of fields) {
    if (loss?.kind === 'retirement' && id(field.id) === id(loss.field?.id)) {
      // The retirement being repaired: its stored date is the one it replaces.
      if ((field.effective_to ?? null) !== null) {
        excludedAsLoss.push({
          kind: PRACTICE_REPAIR_CAUSE_KIND.RETIREMENT,
          node: 'field',
          id: id(field.id),
        });
      }
      continue;
    }
    retirement('field', field, [id(field.id)]);
  }
  for (const subunit of subunits) retirement('subunit', subunit, [id(subunit.id)]);

  const closureRows = rows.fieldClosures;
  for (const row of closureRows ?? []) {
    const source = {
      kind: PRACTICE_REPAIR_CAUSE_KIND.BLACKOUT,
      source: String(row.source),
      id: id(row.id),
    };
    // The blackout being repaired (edited in place): its stored row is what it replaces.
    if (
      loss?.kind === 'blackout' &&
      row.source === 'field_blackouts' &&
      id(row.id) === id(loss.blackout?.id)
    ) {
      excludedAsLoss.push(source);
      continue;
    }
    let surfaceIds;
    if (row.closes_field_id != null) {
      if (!fieldIds.has(id(row.closes_field_id))) {
        throw new TypeError(
          `repair adapter: closure ${row.id} names unread field ${row.closes_field_id}`
        );
      }
      surfaceIds = [id(row.closes_field_id)];
    } else if (row.closes_location_id != null) {
      if (!locationIds.has(id(row.closes_location_id))) {
        throw new TypeError(
          `repair adapter: closure ${row.id} names unread location ${row.closes_location_id}`
        );
      }
      surfaceIds = fieldsOfLocation(fields, row.closes_location_id);
    } else {
      unattributable.push(source);
      continue;
    }
    if (surfaceIds.length === 0) {
      closesNoGround.push(source);
      continue;
    }
    const minutes =
      row.start_minutes == null
        ? {}
        : { startMinutes: row.start_minutes, endMinutes: row.end_minutes };
    entries.push({
      source,
      closure: {
        surfaceIds,
        from: row.blackout_from,
        until: row.blackout_until,
        ...minutes,
        // The enum value, never the free-text note; the import arm has none.
        reason: String(row.reason ?? row.source ?? 'closure'),
      },
    });
  }

  const keyOf = (source) => `${source.kind}|${source.node ?? source.source}|${source.id}`;
  entries.sort((a, b) => keyOf(a.source).localeCompare(keyOf(b.source)));
  return {
    closures: entries.map((entry) => entry.closure),
    declared: {
      blackoutsSupplied: closureRows !== undefined,
      rowsRead: closureRows?.length ?? 0,
      applied: entries.length,
      excludedAsLoss,
      unattributable,
      closesNoGround,
      ...(closureRows === undefined
        ? {
            note: 'no field_closures rows supplied: no existing blackout is honoured (retirements are read from the location, field and sub-surface rows)',
          }
        : {}),
    },
  };
}

/** The repair `loss`, and what caused it, from a blackout or a field retirement. */
function lossOf(loss, fields) {
  if (loss?.kind === 'blackout') {
    const row = loss.blackout;
    const surfaceIds =
      row.field_id != null ? [id(row.field_id)] : fieldsOfLocation(fields, row.location_id);
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
 * @param {{ assignedVia?: 'repair' | 'recommendation' }} [options] - the new
 *   rows' `assigned_via`: `'repair'` by default (the panel's refusal preview),
 *   `'recommendation'` for an enacted recommendation (3b PR 11, `practice/enact.js`)
 * @returns {{
 *   plan: { assignmentRows: Object[], closes: Object[], exceptions: Object[], unlockRequired: Object[] },
 *   refused: Object[],
 *   payload: { assignmentRows: Object[], repair: Object } | null,
 * }}
 */
export function buildPracticeRepairPayload(adapted, result, { assignedVia = 'repair' } = {}) {
  if (!ASSIGNED_VIA.has(assignedVia)) {
    throw new TypeError(`repair adapter: assigned_via ${JSON.stringify(assignedVia)}`);
  }
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
  const replaced = new Set();
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
  // For a blackout the window always lies inside the unclosed row, so every
  // blackout exception is refused until then; only a closed split row's
  // TIME TBD window lies after its row.
  const planException = (row, from, until, rowLastDay, exception, why = null) => {
    exceptions.push(exception);
    if (from > rowLastDay) return;
    refused.push({
      assignment_id: row.id,
      window: exception.window,
      why:
        why ??
        (until < row.range.until
          ? PRACTICE_REPAIR_PAYLOAD_REFUSAL.MID_RANGE_WINDOW
          : PRACTICE_REPAIR_PAYLOAD_REFUSAL.WINDOW_INSIDE_ROW),
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
    // A split window is the series' own: from D, or from its start when later.
    const from = split
      ? row.range.from > result.lossDate
        ? row.range.from
        : result.lossDate
      : entry.window.from;
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
      // A row that starts on or after D has nothing before D to keep: a
      // re-home replaces it (its key is not re-sent, so the writer prunes it
      // under the unlock), and a TIME TBD cannot be closed away from it.
      const closable = row.range.from < from;
      if (closable) {
        closes.push({ assignment_id: row.id, last_day: shiftDate(from, -1) });
        unlockRequired.push({ assignment_id: row.id, why: 'closes re-ranges it' });
      } else if (placed) {
        replaced.add(row.id);
        unlockRequired.push({
          assignment_id: row.id,
          why: 'the payload no longer carries its key',
        });
      }
      if (placed) {
        const slot = /** @type {any} */ (slots.get(/** @type {string} */ (slotId)));
        const [built] = buildPracticeAssignmentRows({
          // The series keeps its provenance: a manual row stays manual.
          assignments: [
            {
              teamId: row.teamId,
              slotId,
              effectiveFrom: from,
              effectiveUntil: until,
              source: row.source ?? undefined,
            },
          ],
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
          assigned_via: assignedVia,
        });
      } else {
        // Closed, the window lies wholly after the row: a tail window. Not
        // closable, it lies inside the row, and is refused for that reason.
        planException(
          row,
          from,
          until,
          closable ? shiftDate(from, -1) : row.range.until,
          {
            assignment_id: row.id,
            window,
            kind: PRACTICE_EXCEPTION_ROW_KIND.TIME_TBD,
            tbd_reason: entry.reason,
            ...causeFields,
          },
          closable ? null : PRACTICE_REPAIR_PAYLOAD_REFUSAL.ROW_NOT_CLOSABLE
        );
      }
      continue;
    }

    // A blackout: an exception on the unclosed row, over its window.
    planException(
      row,
      from,
      until,
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

  // Every snapshot row's key is re-sent unless `closes` keeps it by id or a
  // re-home replaces it: a save that left one out would prune it (and the
  // lock would refuse).
  const closed = new Set(closes.map((close) => close.assignment_id));
  const assignmentRows = [
    ...snapshot
      .filter((row) => !closed.has(row.id) && !replaced.has(row.id))
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
