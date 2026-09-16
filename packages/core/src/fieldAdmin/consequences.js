/**
 * Consequences: what a blackout closes, and what a repair would propose.
 *
 * 8.4's third capability asks for two things this module is the producer of:
 *
 *   1. **"A blackout added through the UI makes the affected games and
 *      practices show as conflicts, and removing it clears them."** The
 *      question is asked against `public.field_closures` -- the single reader
 *      `20260906000100_field_blackouts.sql` created over both blackout tables
 *      -- and against the bookings the shipped pages already load.
 *   2. **"what the repair from 8.6 proposes"**, which cannot be shown, because
 *      8.6 does not exist. {@link repairProposal} says so by name rather than
 *      returning an empty list, and an empty panel where a repair belongs reads
 *      as "no repair needed".
 *
 * ## What this module is NOT
 *
 * It is **not** `availability/closures.js`. That module answers the same
 * question over the season-2026 facility GRAPH, whose ids are corpus labels
 * (`maplewood-back/field-2`) and whose all-day reading is "opens at 00:00 and
 * closes at or after 23:00", because the constraint sheet writes clock times in
 * every row. This one answers it over the shipped DATABASE, whose ids are
 * uuids and whose all-day reading is `start_minutes IS NULL`, because the
 * `field_blackouts` CHECK makes the pair both-or-neither. Two vocabularies, two
 * readings of "all day", and no adapter between the two id spaces exists yet
 * (see `20260906000000`'s header). Folding them together would need that
 * adapter and would give one of the two readings to data that does not hold it.
 *
 * It is also not a scheduler. It reports; nothing here moves a booking.
 *
 * ## Conventions
 *
 * `YYYY-MM-DD` and minutes past local midnight throughout, and **no `Date` is
 * constructed** -- `toDayNumber`/`isoDayOfWeek` are integer arithmetic, so a CI
 * box at UTC and a laptop in America/Los_Angeles give the same answer (GAP-30).
 *
 * @module fieldAdmin/consequences
 */

import { z } from 'zod';

import { FIELD_ADMIN_REASON, makeFieldAdminFinding } from './reasonCodes.js';
import { IsoDateSchema, MinutesSchema } from './schemas.js';

/**
 * The reasons `public.field_blackouts.reason` accepts.
 *
 * **One producer for a vocabulary the database owns.** The CHECK constraint in
 * `supabase/migrations/20260906000100_field_blackouts.sql` is the authority;
 * this is the copy the UI offers, and `tests/fieldAdminConsequences.test.js`
 * parses the CHECK out of the migration and compares. The two are therefore
 * pinned to each other through the SQL text rather than to one another's
 * literals -- if the migration gains a reason and this does not, the test names
 * which side is short.
 *
 * It is deliberately NOT {@link import('./schemas.js').BLACKOUT_REASON}, which
 * is the nine-value vocabulary `field_constraints.csv` writes. The two overlap
 * and are not the same set; an operator form offering a value the table refuses
 * is a form that fails on submit.
 *
 * @readonly
 * @type {readonly string[]}
 */
export const BLACKOUT_DB_REASON = Object.freeze([
  'maintenance',
  'weather',
  'event',
  'permit',
  'closed',
  'other',
]);

/**
 * Which table a `field_closures` row came from.
 *
 * `field_blackouts` rows are admin-authored: editable through
 * `admin_update_field_blackout` and removable through
 * `admin_delete_field_blackout`. `field_blackout_windows` rows belong to the
 * import path and that table is FROZEN, so the UI must not offer to edit or
 * delete one: there is no RPC that would, and inventing a direct write would
 * touch the table the freeze exists to protect. `admin_update_field_blackout`
 * refuses such an id with `0A000` naming the table, rather than with the
 * `P0002` an unknown id gets -- "not yours to edit" and "no such window" are
 * different answers.
 *
 * @readonly
 */
export const CLOSURE_SOURCE = Object.freeze({
  ADMIN: 'field_blackouts',
  IMPORT: 'field_blackout_windows',
});

/* -------------------------------------------------------------------------
 * Dates, without constructing one
 * ---------------------------------------------------------------------- */

/**
 * Days since 1970-01-01 for a proleptic Gregorian `YYYY-MM-DD`.
 *
 * Howard Hinnant's `days_from_civil`, which is integer arithmetic and has no
 * timezone, no locale and no `Date`. The repo bans `Date` construction in
 * `packages/core` for a reason that bit it already: `applyMinutesToDate()` uses
 * `setUTCHours`, so a 17:00 practice becomes 17:00 UTC, and a boundary then
 * moves by an hour on one machine and not another.
 *
 * @param {string} iso - `YYYY-MM-DD`
 * @returns {number}
 */
export function toDayNumber(iso) {
  const year = Number(iso.slice(0, 4));
  const month = Number(iso.slice(5, 7));
  const day = Number(iso.slice(8, 10));
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/**
 * ISO weekday, 1 = Monday .. 7 = Sunday.
 *
 * Day 0 is 1970-01-01, a Thursday, which is ISO 4 -- hence `+ 3` inside the
 * modulus and `+ 1` outside it.
 *
 * @param {string} iso - `YYYY-MM-DD`
 * @returns {number}
 */
export function isoDayOfWeek(iso) {
  return ((((toDayNumber(iso) + 3) % 7) + 7) % 7) + 1;
}

/**
 * The names `practice_slots.day_of_week` writes, in ISO order.
 *
 * The column is text (`mon`..`sun`) in the shipped schema and the grid reads it
 * that way; this is the single mapping onto the number {@link isoDayOfWeek}
 * returns, so "is this slot on this date" is answered in one place.
 *
 * @readonly
 * @type {readonly string[]}
 */
export const ISO_DAY_NAMES = Object.freeze(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);

/**
 * The ISO weekday number a `practice_slots.day_of_week` value names.
 *
 * Returns `null` for a value the column should not hold. **Null is a refusal to
 * guess, never a zero**: a caller that treated an unreadable day as Monday
 * would report conflicts on ground nobody booked.
 *
 * @param {string|null|undefined} value
 * @returns {number|null}
 */
export function isoDayOfWeekName(value) {
  if (typeof value !== 'string') return null;
  const index = ISO_DAY_NAMES.indexOf(value.trim().slice(0, 3).toLowerCase());
  return index === -1 ? null : index + 1;
}

/* -------------------------------------------------------------------------
 * Clock text, in one place
 * ---------------------------------------------------------------------- */

/**
 * Minutes past local midnight as `HH:MM`.
 *
 * **`1440` renders as `24:00`, and that is deliberate.** The
 * `field_blackouts_time_range_check` allows it, meaning "the end of the day"
 * rather than "the start of the next one" -- the same reading
 * {@link MinutesSchema} documents. An `<input type="time">` cannot hold it, so
 * a row carrying it can be READ here and not re-entered through the editor;
 * that asymmetry is stated rather than papered over by rendering `00:00`, which
 * would sort before the start time it follows.
 *
 * @param {number|null|undefined} minutes
 * @returns {string} `HH:MM`, or `''` when there is no time
 */
export function minutesToClock(minutes) {
  if (minutes === null || minutes === undefined) return '';
  const hours = Math.floor(minutes / 60);
  return `${String(hours).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/**
 * `HH:MM` as minutes past local midnight.
 *
 * Returns `null` for anything that is not a well-formed time, because a caller
 * that read an unparseable box as midnight would write a closure the operator
 * never asked for.
 *
 * @param {string|null|undefined} clock
 * @returns {number|null}
 */
export function clockToMinutes(clock) {
  if (typeof clock !== 'string') return null;
  const match = clock.match(/^(\d{2}):(\d{2})$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 24 || minutes > 59 || hours * 60 + minutes > 24 * 60) return null;
  return hours * 60 + minutes;
}

/* -------------------------------------------------------------------------
 * Inputs
 * ---------------------------------------------------------------------- */

const IdSchema = z.string().min(1, { message: 'ids must be non-empty strings' });

/** Both null, or both set: the `field_blackouts` time pairing CHECK. */
const nullableMinutes = MinutesSchema.nullable().default(null);

/**
 * Normalise a booking's clock to both-or-neither.
 *
 * **`game_slots.start_time` and `end_time` are independently nullable**
 * (`20260331000000:556-557`), so a half-specified pair reaches this module from
 * real data -- and {@link minuteWindowsOverlap} reads a single null as ALL DAY,
 * which turned a 09:00 slot with no end time into a blocking conflict against
 * an 18:00-20:00 closure it does not touch. Worse, the finding said
 * `timesKnown: true`, because that flag inspected only the start.
 *
 * A half-open window is not a window this domain can evaluate -- the same
 * reading `BlackoutWindowSchema` states and the `field_blackouts` CHECK
 * enforces -- so it becomes "no clock", once, here. Callers then get one
 * meaning for a null and `timesKnown` is true exactly when both ends are
 * known.
 *
 * @template {{ startMinutes: number|null, endMinutes: number|null }} T
 * @param {T} booking
 * @returns {T}
 */
const bothOrNeither = (booking) =>
  booking.startMinutes === null || booking.endMinutes === null
    ? { ...booking, startMinutes: null, endMinutes: null }
    : booking;

/**
 * One row of `public.field_closures`, in the column names the view publishes.
 *
 * `closesFieldId` and `closesLocationId` are the SCOPE. The view's own comment
 * is emphatic that `fieldLocationId` -- the site a closed field happens to sit
 * on -- is a different fact and never a scope, because a first draft had them
 * as one column and a location filter therefore closed every other pitch on the
 * site. This schema does not carry `fieldLocationId` at all, so the mistake is
 * not expressible here.
 */
export const ClosureRowSchema = z
  .object({
    id: IdSchema,
    source: z.enum([CLOSURE_SOURCE.ADMIN, CLOSURE_SOURCE.IMPORT]),
    closesFieldId: IdSchema.nullable().default(null),
    closesLocationId: IdSchema.nullable().default(null),
    blackoutFrom: IsoDateSchema,
    blackoutUntil: IsoDateSchema,
    startMinutes: nullableMinutes,
    endMinutes: nullableMinutes,
  })
  .strict()
  .superRefine((row, ctx) => {
    if (row.blackoutUntil < row.blackoutFrom) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'blackoutUntil must not precede blackoutFrom',
      });
    }
    if ((row.startMinutes === null) !== (row.endMinutes === null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'startMinutes and endMinutes are both-or-neither; two nulls mean all day',
      });
    }
  });

/** A booking that happens on one named date: a game slot, or a game. */
export const DatedBookingSchema = z
  .object({
    kind: z.enum(['game', 'practice']),
    id: IdSchema,
    fieldId: IdSchema,
    label: z.string().default(''),
    onDate: IsoDateSchema,
    startMinutes: nullableMinutes,
    endMinutes: nullableMinutes,
  })
  .strict()
  .transform(bothOrNeither);

/** A booking that recurs weekly inside an effective window: a practice slot. */
export const RecurringBookingSchema = z
  .object({
    kind: z.enum(['game', 'practice']),
    id: IdSchema,
    fieldId: IdSchema,
    label: z.string().default(''),
    /** 1 = Monday .. 7 = Sunday. */
    dayOfWeek: z.number().int().min(1).max(7),
    startMinutes: nullableMinutes,
    endMinutes: nullableMinutes,
    validFrom: IsoDateSchema.nullable().default(null),
    validUntil: IsoDateSchema.nullable().default(null),
  })
  .strict()
  .transform(bothOrNeither);

/**
 * The ground, enumerated from the field registry.
 *
 * **Never from the bookings.** A venue-scoped closure reaches a booking through
 * the booking's field's location, and deriving "which field sits where" from
 * the bookings themselves would make a field with no bookings invisible -- and
 * a field renamed or dropped would then report zero conflicts rather than being
 * reported as missing. `CLAUDE.md` §3 states the rule; 8.3's review found the
 * instance that produced it.
 */
export const FieldRowSchema = z
  .object({
    id: IdSchema,
    locationId: IdSchema.nullable().default(null),
  })
  .strict();

const ConsequenceInputSchema = z
  .object({
    closures: z.array(ClosureRowSchema).default([]),
    fields: z.array(FieldRowSchema).default([]),
    dated: z.array(DatedBookingSchema).default([]),
    recurring: z.array(RecurringBookingSchema).default([]),
  })
  .strict();

/* -------------------------------------------------------------------------
 * The reading
 * ---------------------------------------------------------------------- */

/**
 * Do two half-open minute windows overlap?
 *
 * A null pair on either side means "the whole day", which overlaps everything.
 * Touching ends do not overlap: a closure ending at 17:00 leaves a 17:00
 * kickoff alone, which is the reading `bookingsOverlapInTime()` already takes
 * in `facility/occupancy.js`. Adopting the sibling's contract rather than
 * inventing a third one.
 *
 * @param {{ startMinutes: number|null, endMinutes: number|null }} a
 * @param {{ startMinutes: number|null, endMinutes: number|null }} b
 * @returns {boolean}
 */
export function minuteWindowsOverlap(a, b) {
  if (a.startMinutes === null || a.endMinutes === null) return true;
  if (b.startMinutes === null || b.endMinutes === null) return true;
  return a.startMinutes < b.endMinutes && b.startMinutes < a.endMinutes;
}

/**
 * Does this closure's scope reach this field?
 *
 * @param {{ closesFieldId: string|null, closesLocationId: string|null }} closure
 * @param {string} fieldId
 * @param {Map<string, string|null>} locationOfField
 * @returns {boolean}
 */
function closureReachesField(closure, fieldId, locationOfField) {
  if (closure.closesFieldId !== null) return closure.closesFieldId === fieldId;
  if (closure.closesLocationId === null) return false;
  // A field the registry does not hold has no location we can trust, so a
  // venue-scoped closure does not silently claim it.
  if (!locationOfField.has(fieldId)) return false;
  return locationOfField.get(fieldId) === closure.closesLocationId;
}

/**
 * The first date on or after `from` whose ISO weekday is `dayOfWeek`.
 *
 * @param {string} from - `YYYY-MM-DD`
 * @param {number} dayOfWeek - 1..7
 * @returns {number} a day number
 */
function firstDayNumberOnWeekday(from, dayOfWeek) {
  const start = toDayNumber(from);
  const startDow = isoDayOfWeek(from);
  return start + ((dayOfWeek - startDow + 7) % 7);
}

/** `YYYY-MM-DD` for a day number. Hinnant's `civil_from_days`. */
export function fromDayNumber(dayNumber) {
  const z0 = dayNumber + 719468;
  const era = Math.floor(z0 / 146097);
  const doe = z0 - era * 146097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365
  );
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  const year = y + (m <= 2 ? 1 : 0);
  return `${String(year).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * Every booking a set of closures covers.
 *
 * **Meta counters are the proof that anything was examined.** A caller reading
 * `findings: []` cannot tell "nothing conflicts" from "nothing was compared",
 * and those are opposite answers. `closuresExamined`, `datedExamined`,
 * `recurringExamined` and `pairsCompared` say which one it was; a check built
 * on this that matches zero records and reports `pairsCompared: 0` is failing,
 * not passing.
 *
 * @param {unknown} input - `{ closures, fields, dated, recurring }`
 * @returns {{ findings: import('./types.js').FieldAdminFinding[], meta: Record<string, number> }}
 */
export function findBlackoutConflicts(input) {
  const { closures, fields, dated, recurring } = ConsequenceInputSchema.parse(input);

  const locationOfField = new Map(fields.map((field) => [field.id, field.locationId]));

  const meta = {
    closuresExamined: closures.length,
    fieldsKnown: fields.length,
    datedExamined: dated.length,
    recurringExamined: recurring.length,
    /** Closure x booking pairs whose scope matched and whose dates were read. */
    pairsCompared: 0,
    conflictsFound: 0,
    /**
     * Bookings whose clock could not be read, counted rather than dropped. A
     * booking with no times is judged on its DATE and reported, exactly as
     * `public.field_bookings` counts an undated slot as affected rather than
     * omitting it.
     *
     * **Counted in BOOKINGS, over the whole input, not in closure-booking
     * pairs.** It was incremented inside the per-closure loop, so one timeless
     * booking against three closures reported three -- a counter the docblock
     * above sells as proof of what was examined, reading as a booking count and
     * being something else. It also counted pairs that the date range then
     * excluded.
     */
    bookingsWithoutTimes:
      dated.filter((booking) => booking.startMinutes === null).length +
      recurring.filter((booking) => booking.startMinutes === null).length,
  };

  /** @type {import('./types.js').FieldAdminFinding[]} */
  const findings = [];

  for (const closure of closures) {
    for (const booking of dated) {
      if (!closureReachesField(closure, booking.fieldId, locationOfField)) continue;
      meta.pairsCompared += 1;
      if (booking.onDate < closure.blackoutFrom || booking.onDate > closure.blackoutUntil) continue;
      if (!minuteWindowsOverlap(closure, booking)) continue;
      meta.conflictsFound += 1;
      findings.push(
        makeFieldAdminFinding(
          FIELD_ADMIN_REASON.BLACKOUT_BLOCKS_BOOKING,
          `${booking.label || booking.kind} on ${booking.onDate} stands inside a blackout`,
          {
            closureId: closure.id,
            closureSource: closure.source,
            bookingKind: booking.kind,
            bookingId: booking.id,
            fieldId: booking.fieldId,
            firstDate: booking.onDate,
            occurrences: 1,
            timesKnown: booking.startMinutes !== null,
          }
        )
      );
    }

    for (const booking of recurring) {
      if (!closureReachesField(closure, booking.fieldId, locationOfField)) continue;
      meta.pairsCompared += 1;
      // The window the two have in common, as day numbers. A null validity
      // bound is unbounded on that side, so the closure alone decides it.
      const from =
        booking.validFrom !== null && booking.validFrom > closure.blackoutFrom
          ? booking.validFrom
          : closure.blackoutFrom;
      const until =
        booking.validUntil !== null && booking.validUntil < closure.blackoutUntil
          ? booking.validUntil
          : closure.blackoutUntil;
      if (until < from) continue;
      if (!minuteWindowsOverlap(closure, booking)) continue;
      // **Counted, never enumerated.** A closure range has no upper bound in
      // the schema, so walking it day by day is an unbounded loop in a render
      // path. The first occurrence and the count answer the operator's question
      // without one, and neither can be truncated.
      const first = firstDayNumberOnWeekday(from, booking.dayOfWeek);
      const last = toDayNumber(until);
      if (first > last) continue;
      const occurrences = Math.floor((last - first) / 7) + 1;
      meta.conflictsFound += 1;
      findings.push(
        makeFieldAdminFinding(
          FIELD_ADMIN_REASON.BLACKOUT_BLOCKS_BOOKING,
          `${booking.label || booking.kind} falls inside a blackout on ${occurrences} date(s) from ${fromDayNumber(first)}`,
          {
            closureId: closure.id,
            closureSource: closure.source,
            bookingKind: booking.kind,
            bookingId: booking.id,
            fieldId: booking.fieldId,
            firstDate: fromDayNumber(first),
            occurrences,
            timesKnown: booking.startMinutes !== null,
          }
        )
      );
    }
  }

  return { findings, meta };
}

/**
 * What the repair from 8.6 proposes.
 *
 * **8.6 does not exist**, so the honest answer is a named refusal. The plan's
 * clause "and what the repair from 8.6 proposes" is the one part of 8.4's third
 * capability that cannot be built, and a consequence panel that simply left the
 * space empty would read as "no repair is needed" -- which is a stronger claim
 * than "nothing has been computed", and a false one.
 *
 * This is `CLAUDE.md` §3's "declared is not enforced" applied to a screen: a
 * policy nothing optimises toward must say so.
 *
 * @param {{ affectedCount?: number }} [context]
 * @returns {{ available: false, finding: import('./types.js').FieldAdminFinding }}
 */
export function repairProposal({ affectedCount = 0 } = {}) {
  return {
    available: /** @type {false} */ (false),
    finding: makeFieldAdminFinding(
      FIELD_ADMIN_REASON.REPAIR_PROPOSAL_UNAVAILABLE,
      'No repair can be proposed: the repair engine (Phase 8.6) does not exist yet. ' +
        'This is not a statement that no repair is needed.',
      { affectedCount, blockedOn: '8.6' }
    ),
  };
}
