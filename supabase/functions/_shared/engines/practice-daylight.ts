/**
 * The auto-scheduler's daylight post-pass (8.9 PR 6; plan §3 "Auto-scheduler
 * post-pass", decisions D2, D4, D5, D6, D8, D11).
 *
 * ## The rule, as the Edge enforces it
 *
 * An unlit practice occurrence ends at or before `floor(sunset)` less
 * {@link PRACTICE_SUNSET_MARGIN_MINUTES} (0), judged per date on the season's
 * wall clock -- core `practice/daylight.js`'s rule, over this function's own
 * weekly expansion of each slot. Sunset is `_shared/timing/solar.ts`, the Edge
 * twin `tests/solarDrift.test.js` holds exactly equal to core.
 *
 * - **Lit ground is exempt**; **undeclared lighting is unlit** (D5).
 * - **Venue data comes from the database, never the body** (W9). Each run
 *   slot's `field_id` and `valid_until` are read from `practice_slots`, and
 *   coordinates and `lighting_available` by that `field_id` (fields ->
 *   locations), AS THE CALLER through RLS, paged, by {@link loadVenueDaylight}
 *   -- the preference loader reads a slot's venue from the store the same way.
 *   The request's slots are passthrough objects, so a body can carry
 *   `fieldId`, `latitude` or `lightingAvailable`; {@link toDaylightSlot} reads
 *   only the slot's instants (the ones the solver places) and its
 *   `effectiveUntil` when the store holds none (the page's season-end
 *   fallback). A failed read, a run slot the read did not return, or its field
 *   not returned, refuses the run -- the preference loader's contract (a
 *   partial read is a failed read), not a third one.
 * - **No coordinates on unlit ground is flagged, counted and never allowed**,
 *   and does not refuse the run (D4): every venue lacks coordinates at
 *   rollout. The placement stands, listed in `unknown` with its cause.
 *
 * ## What it changes, and what it never touches
 *
 * Only placements this run produced. For each, the slot's weekly occurrences
 * from the season's today (the page's `newPlacementRange` start) to the slot's
 * `effectiveUntil` are judged in date order; the first date past the limit
 * truncates the placement there (D8): it keeps `[.., date - 1]` as
 * `effectiveUntil` and the remainder `[date, effectiveUntil]` becomes TIME TBD
 * with reason {@link DAYLIGHT_TBD_REASON} and the date. When the first
 * occurrence is already past the limit nothing remains, so the placement is
 * withdrawn and the team is unplaced with that reason.
 *
 * **Locked rows are never changed** (3b ruling 2). One that runs past sunset is
 * reported in `lockedPastSunset` with a proposed fix (`applied: false`); the
 * operator applies it, or does not.
 *
 * **Portable-lighting overrides are exempt (8.9 D14 PR C).** An approved
 * `practice_lighting_overrides` window on a slot, loaded as the caller by
 * `practice-lighting-overrides.ts` (never from the body, W25), exempts that
 * slot's dates in `[from, until]`: such a date is not judged, asks for no
 * sunset and so needs no coordinates, never truncates the placement, and keeps
 * the practice's full length. It is counted in its own
 * `lightingOverrideOccurrencesExempt`, never in the lit counter nor in
 * `occurrencesExamined`. **Declared, not enforced:** an override has no
 * lights-off time (plan default 4), so an exempt date is exempt however late
 * the practice ends. A covered date AFTER a non-exempt date that truncates is
 * part of the TIME TBD remainder -- D8 keeps one contiguous range per
 * placement, so there is no gap to keep it in -- and is counted in
 * `lightingOverrideOccurrencesInTimeTbd` rather than silently lost (for a
 * locked row, in the proposed remainder: `lockedRowOccurrencesLightingInProposedTbd`).
 * An override that exempted no date of the run is counted in
 * `lightingOverridesUnused` (core's `lightingOverridesUnused`). A venue with no
 * coordinates whose every date is exempt is not reported unknown: nothing on
 * it was judged (core: an exempt occurrence is never unknown).
 *
 * **Declared, not optimised (D11).** The search does not steer toward slots
 * that survive the season: the pass truncates what the search chose, and a
 * withdrawn placement's capacity is not offered to another team.
 *
 * Import-free apart from its siblings, so Vitest can execute it directly.
 */
import { sunsetEnforcementMinutes, sunsetOnDate } from '../timing/solar.ts';
import { dateRangeBounds } from '../calendar/icsFeed.ts';
import { startMinutesOf, weekdayCode } from './coach-preference-load.ts';
import { LOCK_PAGE_SIZE, readAllPages, type QueryResult } from './practice-lock.ts';
import { lightingOverrideCovers, type LightingOverride } from './practice-lighting-overrides.ts';

/**
 * Minutes before sunset an unlit practice must be over: **0** (D6). The Deno
 * twin of core `PRACTICE_SUNSET_MARGIN_MINUTES` (`practice/daylight.js`),
 * pinned equal to it by `tests/autoSchedulerDaylight.test.js` (W15).
 */
export const PRACTICE_SUNSET_MARGIN_MINUTES = 0;

/**
 * A TIME TBD remainder's, or a withdrawn placement's, reason: core
 * `PRACTICE_TBD_REASON.PAST_SUNSET` (`practice/repair.js`), spelled
 * identically -- one reason for one cause, whichever path finds it.
 * `tests/autoSchedulerDaylight.test.js` pins the two equal.
 */
export const DAYLIGHT_TBD_REASON = 'past-sunset';

/** Spelled as core `AVAILABILITY_REASON` spells them (the drift test compares). */
export const DAYLIGHT_CODE = Object.freeze({
  PRACTICE_PAST_SUNSET: 'PRACTICE_PAST_SUNSET',
  SUNSET_UNKNOWN: 'SUNSET_UNKNOWN',
} as const);

/** Why a sunset could not be judged. Never read as "allowed". */
export const DAYLIGHT_UNKNOWN_CAUSE = Object.freeze({
  /** Core's cause, spelled identically: unlit ground, no coordinates (D4). */
  VENUE_COORDINATES_MISSING: 'venue-coordinates-missing',
  /** No readable season date, end time or date range to expand. */
  SLOT_DATES_UNREADABLE: 'slot-dates-unreadable',
  /** The solar twin refused a date (a polar latitude). */
  SUNSET_UNDEFINED: 'sunset-undefined',
} as const);

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** One venue, as the database says. */
export interface VenueDaylight {
  fieldId: string;
  locationId: string;
  /** `lighting_available`: `true` lit, `false` unlit, `null` undeclared (D5: unlit). */
  lit: boolean | null;
  latitude: number | null;
  longitude: number | null;
}

/** What the pass reads of one request slot -- and nothing else. */
export interface DaylightSlot {
  id: string;
  fieldId: string | null;
  /** The slot's first occurrence, `YYYY-MM-DD` on the season's clock. */
  firstDate: string | null;
  /** The last date the slot runs, inclusive: the store's, else the body's. */
  effectiveUntil: string | null;
  /** Minutes past local midnight the practice ends, on the season's clock. */
  endMinutes: number | null;
}

export interface DaylightContext {
  slots: Map<string, DaylightSlot>;
  venues: Map<string, VenueDaylight>;
  timeZone: string | null;
  /** The season's calendar date: nothing earlier is judged. `null` judges from each slot's start. */
  today: string | null;
  /**
   * Approved portable-lighting windows, as `loadLightingOverrides` read them
   * from the store (never the body). Absent or empty: nothing is exempt.
   */
  lightingOverrides?: readonly LightingOverride[];
}

// ---------------------------------------------------------------------------
// Dates, host-zone free
// ---------------------------------------------------------------------------

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const m = ISO_DATE.exec(value);
  if (!m) return false;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return new Date(ms).toISOString().slice(0, 10) === value;
}

/** `YYYY-MM-DD` plus `days`, on the calendar (UTC arithmetic, no zone). */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** An instant's date and minutes past midnight on `timeZone`'s wall clock. */
function wallReading(instant: Date, timeZone: string): { date: string; minutes: number } | null {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(instant);
    const get = (type: string) => parts.find((part) => part.type === type)?.value;
    const [y, mo, d, h, mi] = [get('year'), get('month'), get('day'), get('hour'), get('minute')];
    if (!y || !mo || !d || !h || !mi) return null;
    return { date: `${y}-${mo}-${d}`, minutes: Number(h) * 60 + Number(mi) };
  } catch {
    return null;
  }
}

/** One run slot as `practice_slots` stores it. */
export interface StoredSlot {
  fieldId: string;
  validUntil: string | null;
  /**
   * `valid_from` moved to the slot's weekday (the page's `getSlotDateForDay`),
   * or `null` when the store holds no `valid_from` (the body's first date is
   * then the page's season-start fallback).
   */
  firstDate?: string | null;
  /** `end_time` in minutes; `null` when unreadable. Absent only off the load path. */
  endMinutes?: number | null;
}

const WEEKDAY_INDEX: Readonly<Record<string, number>> = Object.freeze({
  SUN: 0,
  MON: 1,
  TUE: 2,
  WED: 3,
  THU: 4,
  FRI: 5,
  SAT: 6,
});

/** `valid_from` moved forward to the slot's weekday; itself when the weekday is unreadable. */
function storedFirstDate(validFrom: unknown, dayOfWeek: unknown): string | null {
  if (!isIsoDate(validFrom)) return null;
  const code = weekdayCode(dayOfWeek);
  if (code === null) return validFrom;
  const [y, m, d] = validFrom.split('-').map(Number);
  const delta = (WEEKDAY_INDEX[code] - new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 7) % 7;
  return addDays(validFrom, delta);
}

/**
 * What the pass judges of one run slot. The STORE decides everything it holds:
 * the venue (`field_id`), the end time (`end_time` -- what the saved practice
 * will actually run to), the first date (`valid_from` on the slot's weekday)
 * and the last (`valid_until`). The body is read only where the store is
 * silent, as the page itself falls back: the first date from the `start`
 * instant on the season's clock when `valid_from` is null, and
 * `effectiveUntil` when `valid_until` is null (the season's end). No other
 * body key is read (W9).
 */
export function toDaylightSlot(
  row: { id: string; start: Date; end: Date; effectiveUntil?: unknown },
  timeZone: string | null,
  stored: StoredSlot | undefined
): DaylightSlot {
  const start = timeZone ? wallReading(row.start, timeZone) : null;
  const end = timeZone ? wallReading(row.end, timeZone) : null;
  // A practice ending on a later date than it starts has no single end minute.
  const sameDay = start !== null && end !== null && start.date === end.date;
  return {
    id: row.id,
    fieldId: stored?.fieldId ?? null,
    firstDate: stored?.firstDate ?? (sameDay ? start.date : null),
    effectiveUntil:
      stored?.validUntil ?? (isIsoDate(row.effectiveUntil) ? row.effectiveUntil : null),
    endMinutes:
      stored && stored.endMinutes !== undefined ? stored.endMinutes : sameDay ? end.minutes : null,
  };
}

// ---------------------------------------------------------------------------
// Loading, as the caller
// ---------------------------------------------------------------------------

interface VenueQuery {
  eq(column: string, value: unknown): VenueQuery;
  order(column: string, options?: { ascending?: boolean }): VenueQuery;
  range(from: number, to: number): PromiseLike<QueryResult>;
}
export interface VenueReader {
  from(table: string): { select(columns: string): VenueQuery };
}

export type VenueDaylightLoad =
  | {
      ok: true;
      venues: Map<string, VenueDaylight>;
      /** Every run slot, keyed by its id, as the store holds it. */
      slots: Map<string, StoredSlot>;
      fieldsLoaded: number;
    }
  | { ok: false; code: 'VENUE_DAYLIGHT_UNREADABLE'; message: string };

function coordinate(value: unknown): number | null {
  // PostgREST may serialise `numeric` as a string.
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/**
 * The organisation's practice slots (venue and last date) and every field with
 * its venue's lighting and coordinates, read through `client` -- the
 * USER-scoped client, so RLS decides -- page by page. Refuses when a read
 * fails, when a run slot is not among the slot rows, or when its field is not
 * among the field rows.
 */
export async function loadVenueDaylight(
  client: VenueReader,
  params: { organizationId: string; slotIds: readonly string[]; pageSize?: number }
): Promise<VenueDaylightLoad> {
  const { organizationId, pageSize = LOCK_PAGE_SIZE } = params;
  const slotRead = await readAllPages(
    () =>
      client
        .from('practice_slots')
        .select('id, field_id, valid_from, valid_until, day_of_week, end_time')
        .eq('organization_id', organizationId)
        .order('id', { ascending: true }),
    pageSize
  );
  if (slotRead.error) {
    return {
      ok: false,
      code: 'VENUE_DAYLIGHT_UNREADABLE',
      message: `practice_slots: ${slotRead.error}`,
    };
  }
  const storedById = new Map<string, StoredSlot>();
  for (const row of slotRead.rows as Array<Record<string, unknown>>) {
    if (row.field_id == null) continue; // NOT NULL in the schema; unjudgeable if not
    storedById.set(String(row.id), {
      fieldId: String(row.field_id).toLowerCase(),
      validUntil: isIsoDate(row.valid_until) ? row.valid_until : null,
      firstDate: storedFirstDate(row.valid_from, row.day_of_week),
      endMinutes: startMinutesOf(row.end_time),
    });
  }
  const unreadSlots = params.slotIds.filter((id) => !storedById.has(id));
  if (unreadSlots.length > 0) {
    return {
      ok: false,
      code: 'VENUE_DAYLIGHT_UNREADABLE',
      message:
        `${unreadSlots.length} practice slot(s) could not be read with a field, so their ` +
        `venue is unknown: ${unreadSlots.slice(0, 5).join(', ')}`,
    };
  }

  const read = await readAllPages(
    () =>
      client
        .from('fields')
        .select('id, location_id, locations!inner(latitude, longitude, lighting_available)')
        .eq('organization_id', organizationId)
        .order('id', { ascending: true }),
    pageSize
  );
  if (read.error) {
    return { ok: false, code: 'VENUE_DAYLIGHT_UNREADABLE', message: `fields: ${read.error}` };
  }
  const venues = new Map<string, VenueDaylight>();
  for (const row of read.rows as Array<Record<string, unknown>>) {
    const location = (row.locations ?? {}) as Record<string, unknown>;
    const latitude = coordinate(location.latitude);
    const longitude = coordinate(location.longitude);
    const pair = latitude !== null && longitude !== null;
    const fieldId = String(row.id).toLowerCase();
    venues.set(fieldId, {
      fieldId,
      locationId: String(row.location_id).toLowerCase(),
      lit:
        location.lighting_available === true
          ? true
          : location.lighting_available === false
            ? false
            : null,
      latitude: pair ? latitude : null,
      longitude: pair ? longitude : null,
    });
  }
  const slots = new Map(params.slotIds.map((id) => [id, storedById.get(id) as StoredSlot]));
  const named = [...new Set([...slots.values()].map((slot) => slot.fieldId))];
  const unread = named.filter((id) => !venues.has(id));
  if (unread.length > 0) {
    return {
      ok: false,
      code: 'VENUE_DAYLIGHT_UNREADABLE',
      message:
        `${unread.length} field(s) the run's slots name could not be read, so their ` +
        `lighting is unknown: ${unread.slice(0, 5).join(', ')}`,
    };
  }
  return { ok: true, venues, slots, fieldsLoaded: read.rows.length };
}

// ---------------------------------------------------------------------------
// Judging one series
// ---------------------------------------------------------------------------

interface PastSunset {
  date: string;
  endMinutes: number;
  sunsetMinutes: number;
  limitMinutes: number;
}

type SeriesVerdict =
  | { kind: 'lit' }
  | {
      kind: 'unknown';
      cause: string;
      /** Unjudged occurrences: the span's dates less the {@link exempt} ones. */
      occurrences: number | null;
      undeclared: boolean;
      /** Dates a lighting override covers: not judged, and not unknown. */
      exemptDates?: string[];
    }
  | {
      kind: 'judged';
      undeclared: boolean;
      /** Every occurrence date in the span, in order. */
      dates: string[];
      /** Dates before the first past sunset that an override covers: not judged. */
      exemptDates: string[];
      withinDaylight: number;
      unknownDates: string[];
      firstPastSunset: PastSunset | null;
    };

/** The weekly dates from `firstDate`, within `[from, until]`. */
export function occurrenceDates(firstDate: string, from: string, until: string): string[] {
  const dates: string[] = [];
  for (let date = firstDate; date <= until; date = addDays(date, 7)) {
    if (date >= from) dates.push(date);
  }
  return dates;
}

function judgeSeries(
  slot: DaylightSlot,
  venue: VenueDaylight | undefined,
  timeZone: string | null,
  from: string | null,
  until: string | null,
  covered: (slotId: string, date: string) => boolean
): SeriesVerdict {
  if (venue?.lit === true) return { kind: 'lit' };
  const undeclared = venue?.lit !== false;
  if (!venue || !slot.firstDate || !until || slot.endMinutes === null || !timeZone) {
    return {
      kind: 'unknown',
      cause: DAYLIGHT_UNKNOWN_CAUSE.SLOT_DATES_UNREADABLE,
      occurrences: null,
      undeclared,
    };
  }
  const dates = occurrenceDates(slot.firstDate, from ?? slot.firstDate, until);
  if (venue.latitude === null || venue.longitude === null) {
    // An exempt date asks for no sunset, so it needs no coordinates.
    const exempt = dates.filter((date) => covered(slot.id, date));
    if (exempt.length > 0 && exempt.length === dates.length) {
      return {
        kind: 'judged',
        undeclared,
        dates,
        exemptDates: exempt,
        withinDaylight: 0,
        unknownDates: [],
        firstPastSunset: null,
      };
    }
    return {
      kind: 'unknown',
      cause: DAYLIGHT_UNKNOWN_CAUSE.VENUE_COORDINATES_MISSING,
      occurrences: dates.length - exempt.length,
      undeclared,
      exemptDates: exempt,
    };
  }
  let withinDaylight = 0;
  const unknownDates: string[] = [];
  const exemptDates: string[] = [];
  for (const date of dates) {
    // Portable lighting (D14): not judged, never truncated, full length kept.
    // Declared, not enforced: an override has no lights-off time (default 4).
    if (covered(slot.id, date)) {
      exemptDates.push(date);
      continue;
    }
    const sunset = sunsetOnDate({
      date,
      latitude: venue.latitude,
      longitude: venue.longitude,
      timeZone,
    });
    const floored = sunsetEnforcementMinutes(sunset);
    if (floored === null || sunset.minutes === null) {
      unknownDates.push(date);
      continue;
    }
    const limitMinutes = floored - PRACTICE_SUNSET_MARGIN_MINUTES;
    if (slot.endMinutes > limitMinutes) {
      return {
        kind: 'judged',
        undeclared,
        dates,
        exemptDates,
        withinDaylight,
        unknownDates,
        firstPastSunset: {
          date,
          endMinutes: slot.endMinutes,
          sunsetMinutes: sunset.minutes,
          limitMinutes,
        },
      };
    }
    withinDaylight += 1;
  }
  return {
    kind: 'judged',
    undeclared,
    dates,
    exemptDates,
    withinDaylight,
    unknownDates,
    firstPastSunset: null,
  };
}

const later = (a: string | null, b: string | null) =>
  a === null ? b : b === null ? a : a > b ? a : b;
const earlier = (a: string | null, b: string | null) =>
  a === null ? b : b === null ? a : a < b ? a : b;

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

export interface DaylightPlacement {
  teamId: string;
  slotId: string;
  source: 'auto';
  /** Set only when the pass truncated the placement: its last date (D8). */
  effectiveUntil?: string;
}

export interface DaylightUnplaced {
  teamId: string;
  reason: string;
  dimensions?: string[];
  /** For {@link DAYLIGHT_TBD_REASON}: the first date past sunset. */
  date?: string;
}

export interface DaylightLockedRow {
  assignmentId: string;
  teamId: string;
  slotId: string | null;
  effectiveDateRange?: string | null;
}

export interface DaylightTimeTbd extends PastSunset {
  teamId: string;
  slotId: string;
  /** The remainder, inclusive: `from` is the first date past sunset. */
  from: string;
  until: string;
  reason: typeof DAYLIGHT_TBD_REASON;
  code: typeof DAYLIGHT_CODE.PRACTICE_PAST_SUNSET;
  marginMinutes: number;
  /** `true` when nothing remained before `from`, so the placement was withdrawn. */
  withdrawn: boolean;
}

export interface DaylightUnknown {
  teamId: string;
  slotId: string;
  /** Set for a locked row; absent for a new placement. */
  assignmentId?: string;
  code: typeof DAYLIGHT_CODE.SUNSET_UNKNOWN;
  cause: string;
  /** Occurrences left unjudged, when the dates could be expanded. */
  occurrences: number | null;
}

export interface LockedPastSunset extends PastSunset {
  assignmentId: string;
  teamId: string;
  slotId: string;
  code: typeof DAYLIGHT_CODE.PRACTICE_PAST_SUNSET;
  /**
   * Proposed, never applied: end the row the day before `date` and make the
   * rest TIME TBD -- or, when `date` is the row's first date, `effectiveUntil`
   * is `null`: the whole row becomes TIME TBD.
   */
  proposedFix: { effectiveUntil: string | null; timeTbdFrom: string; applied: false };
}

export interface DaylightReport {
  marginMinutes: number;
  today: string | null;
  meta: {
    placementsExamined: number;
    litPlacementsExempt: number;
    unlitPlacementsExamined: number;
    undeclaredLightingPlacements: number;
    occurrencesExamined: number;
    occurrencesWithinDaylight: number;
    daylightUnknownOccurrences: number;
    daylightUnknownPlacements: number;
    placementsTruncated: number;
    placementsWithdrawn: number;
    lockedRowsExamined: number;
    lockedRowsPastSunset: number;
    lockedRowsUnknown: number;
    /** New placements' dates an approved lighting override exempted: not judged, kept. */
    lightingOverrideOccurrencesExempt: number;
    /** Covered dates after a non-exempt truncation, so inside a TIME TBD remainder (D8). */
    lightingOverrideOccurrencesInTimeTbd: number;
    /** Locked rows' dates an approved lighting override exempted. */
    lockedRowOccurrencesLightingExempt: number;
    /** Covered dates after a locked row's first past sunset: inside its proposed remainder. */
    lockedRowOccurrencesLightingInProposedTbd: number;
    /** Overrides handed in that exempted no date of any placement or locked row. */
    lightingOverridesUnused: number;
  };
  timeTbd: DaylightTimeTbd[];
  unknown: DaylightUnknown[];
  lockedPastSunset: LockedPastSunset[];
}

/**
 * Judge every new placement and every locked row against daylight. Returns
 * the placements (truncated or withdrawn where past sunset; the SAME objects
 * where not), the unplaced list with each withdrawn team appended, and the
 * report. Locked rows are read, never returned.
 */
export function applyDaylightPostPass<P extends DaylightPlacement, U extends DaylightUnplaced>(
  params: {
    placements: P[];
    unassigned: U[];
    locked: DaylightLockedRow[];
  } & DaylightContext
): {
  placements: Array<P | (P & { effectiveUntil: string })>;
  unassigned: Array<U | DaylightUnplaced>;
  report: DaylightReport;
} {
  const { slots, venues, timeZone, today } = params;
  const report: DaylightReport = {
    marginMinutes: PRACTICE_SUNSET_MARGIN_MINUTES,
    today,
    meta: {
      placementsExamined: 0,
      litPlacementsExempt: 0,
      unlitPlacementsExamined: 0,
      undeclaredLightingPlacements: 0,
      occurrencesExamined: 0,
      occurrencesWithinDaylight: 0,
      daylightUnknownOccurrences: 0,
      daylightUnknownPlacements: 0,
      placementsTruncated: 0,
      placementsWithdrawn: 0,
      lockedRowsExamined: 0,
      lockedRowsPastSunset: 0,
      lockedRowsUnknown: 0,
      lightingOverrideOccurrencesExempt: 0,
      lightingOverrideOccurrencesInTimeTbd: 0,
      lockedRowOccurrencesLightingExempt: 0,
      lockedRowOccurrencesLightingInProposedTbd: 0,
      lightingOverridesUnused: 0,
    },
    timeTbd: [],
    unknown: [],
    lockedPastSunset: [],
  };
  const { meta } = report;
  const venueOf = (slot: DaylightSlot) => (slot.fieldId ? venues.get(slot.fieldId) : undefined);
  const covered = lightingOverrideCovers(params.lightingOverrides);
  /** Every (slot, date) an override exempted, for `lightingOverridesUnused`. */
  const exemptedOn = new Map<string, Set<string>>();
  const noteExempt = (slotId: string, dates: readonly string[] | undefined) => {
    if (!dates || dates.length === 0) return;
    const set = exemptedOn.get(slotId) ?? new Set<string>();
    for (const date of dates) set.add(date);
    exemptedOn.set(slotId, set);
  };

  const placements: Array<P | (P & { effectiveUntil: string })> = [];
  const withdrawn: DaylightUnplaced[] = [];
  // A new placement's span depends on its slot alone, so each slot is judged
  // once however many teams it holds.
  const bySlot = new Map<string, SeriesVerdict>();
  for (const placement of params.placements) {
    meta.placementsExamined += 1;
    const slot = slots.get(placement.slotId);
    // A placement's slot is always one of the run's; a miss is judged as a
    // slot with nothing readable, never passed.
    let judged = bySlot.get(placement.slotId);
    if (!judged) {
      judged = slot
        ? judgeSeries(slot, venueOf(slot), timeZone, today, slot.effectiveUntil, covered)
        : {
            kind: 'unknown',
            cause: DAYLIGHT_UNKNOWN_CAUSE.SLOT_DATES_UNREADABLE,
            occurrences: null,
            undeclared: true,
          };
      bySlot.set(placement.slotId, judged);
    }
    if (judged.kind === 'lit') {
      meta.litPlacementsExempt += 1;
      placements.push(placement);
      continue;
    }
    meta.unlitPlacementsExamined += 1;
    if (judged.undeclared) meta.undeclaredLightingPlacements += 1;
    if (judged.kind === 'unknown') {
      meta.lightingOverrideOccurrencesExempt += judged.exemptDates?.length ?? 0;
      noteExempt(placement.slotId, judged.exemptDates);
      meta.daylightUnknownPlacements += 1;
      meta.daylightUnknownOccurrences += judged.occurrences ?? 0;
      report.unknown.push({
        teamId: placement.teamId,
        slotId: placement.slotId,
        code: DAYLIGHT_CODE.SUNSET_UNKNOWN,
        cause: judged.cause,
        occurrences: judged.occurrences,
      });
      placements.push(placement);
      continue;
    }
    const past = judged.firstPastSunset;
    const examined = past ? judged.dates.indexOf(past.date) + 1 : judged.dates.length;
    // An exempt date is not judged, so it is not examined here -- as core
    // leaves it out of `unlitPracticeOccurrencesExamined` (this counter is
    // unlit-only; core's `occurrencesExamined` also counts lit and exempt).
    meta.occurrencesExamined += examined - judged.exemptDates.length;
    meta.lightingOverrideOccurrencesExempt += judged.exemptDates.length;
    noteExempt(placement.slotId, judged.exemptDates);
    meta.occurrencesWithinDaylight += judged.withinDaylight;
    if (judged.unknownDates.length > 0) {
      meta.daylightUnknownOccurrences += judged.unknownDates.length;
      report.unknown.push({
        teamId: placement.teamId,
        slotId: placement.slotId,
        code: DAYLIGHT_CODE.SUNSET_UNKNOWN,
        cause: DAYLIGHT_UNKNOWN_CAUSE.SUNSET_UNDEFINED,
        occurrences: judged.unknownDates.length,
      });
    }
    if (!past) {
      placements.push(placement);
      continue;
    }
    meta.lightingOverrideOccurrencesInTimeTbd += judged.dates.filter(
      (date) => date > past.date && covered(placement.slotId, date)
    ).length;
    const nothingLeft = past.date === judged.dates[0];
    report.timeTbd.push({
      teamId: placement.teamId,
      slotId: placement.slotId,
      from: past.date,
      until: (slot as DaylightSlot).effectiveUntil as string,
      reason: DAYLIGHT_TBD_REASON,
      code: DAYLIGHT_CODE.PRACTICE_PAST_SUNSET,
      marginMinutes: PRACTICE_SUNSET_MARGIN_MINUTES,
      withdrawn: nothingLeft,
      ...past,
    });
    if (nothingLeft) {
      meta.placementsWithdrawn += 1;
      withdrawn.push({ teamId: placement.teamId, reason: DAYLIGHT_TBD_REASON, date: past.date });
    } else {
      meta.placementsTruncated += 1;
      placements.push({ ...placement, effectiveUntil: addDays(past.date, -1) });
    }
  }

  // Locked rows: judged, reported, never changed.
  for (const row of params.locked) {
    const slot = row.slotId ? slots.get(row.slotId) : undefined;
    if (!slot || !row.slotId) continue; // outside the run: `lock.lockedOutsideRun` reports it
    // Lit ground is exempt whatever the row's range says.
    if (venueOf(slot)?.lit === true) continue;
    // `icsFeed.ts`'s reading of a stored range: a null, unbounded or inverted
    // range is unreadable, and is reported rather than judged.
    const bounds = dateRangeBounds(row.effectiveDateRange);
    const judged = bounds
      ? judgeSeries(
          slot,
          venueOf(slot),
          timeZone,
          later(today, bounds.first),
          earlier(slot.effectiveUntil, bounds.last),
          covered
        )
      : ({
          kind: 'unknown',
          cause: DAYLIGHT_UNKNOWN_CAUSE.SLOT_DATES_UNREADABLE,
          occurrences: null,
          undeclared: venueOf(slot)?.lit !== false,
        } as const);
    if (judged.kind === 'lit') continue;
    meta.lockedRowsExamined += 1;
    const lockedExempt = 'exemptDates' in judged ? judged.exemptDates : undefined;
    meta.lockedRowOccurrencesLightingExempt += lockedExempt?.length ?? 0;
    noteExempt(row.slotId, lockedExempt);
    if (judged.kind === 'unknown' || judged.unknownDates.length > 0) {
      meta.lockedRowsUnknown += 1;
      report.unknown.push({
        teamId: row.teamId,
        slotId: row.slotId,
        assignmentId: row.assignmentId,
        code: DAYLIGHT_CODE.SUNSET_UNKNOWN,
        cause: judged.kind === 'unknown' ? judged.cause : DAYLIGHT_UNKNOWN_CAUSE.SUNSET_UNDEFINED,
        occurrences: judged.kind === 'unknown' ? judged.occurrences : judged.unknownDates.length,
      });
    }
    if (judged.kind === 'judged' && judged.firstPastSunset) {
      meta.lockedRowsPastSunset += 1;
      const past = judged.firstPastSunset;
      meta.lockedRowOccurrencesLightingInProposedTbd += judged.dates.filter(
        (date) => date > past.date && covered(row.slotId as string, date)
      ).length;
      report.lockedPastSunset.push({
        assignmentId: row.assignmentId,
        teamId: row.teamId,
        slotId: row.slotId,
        code: DAYLIGHT_CODE.PRACTICE_PAST_SUNSET,
        ...past,
        proposedFix: {
          effectiveUntil:
            bounds && addDays(past.date, -1) >= bounds.first ? addDays(past.date, -1) : null,
          timeTbdFrom: past.date,
          applied: false,
        },
      });
    }
  }

  meta.lightingOverridesUnused = (params.lightingOverrides ?? []).filter(
    (override) =>
      ![...(exemptedOn.get(override.slotId) ?? [])].some(
        (date) => override.from <= date && date <= override.until
      )
  ).length;

  return { placements, unassigned: [...params.unassigned, ...withdrawn], report };
}
