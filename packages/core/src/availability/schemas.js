/**
 * Zod schemas for availability input.
 *
 * `.strict()` throughout, matching `facility/schemas.js` and `timing/schemas.js`
 * and deliberately unlike `packages/core/src/schemas/index.js`, whose blanket
 * `.passthrough()` is what let four copies of the slot model drift apart without
 * anything failing (`docs/ARCHITECTURE.md` §1.1).
 *
 * @module availability/schemas
 */

import { z } from 'zod';

/**
 * The shape of an ISO calendar date, `YYYY-MM-DD`. Exported so the one
 * reading of "this cell is a date" is shared: the practice corpus parser
 * reports a `fields` cell of this shape as Excel corruption, and the closures
 * adapter carries the same cell as unreadable — through this pattern, not a
 * second one.
 */
export const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Inclusive ISO calendar date, `YYYY-MM-DD`. No `Date` construction anywhere. */
export const IsoDateSchema = z
  .string()
  .regex(ISO_DATE_PATTERN, { message: 'expected an ISO YYYY-MM-DD date' });

/** A non-empty opaque identifier. */
export const IdSchema = z.string().min(1, { message: 'ids must be non-empty strings' });

/** Minutes past local midnight. Not capped at 1440: a permit may close after midnight. */
const MinutesSchema = z.number().int().min(0);

/** Three-letter weekday code, as `weekdayCodeOf()` produces. */
const WeekdaySchema = z.enum(['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']);

/**
 * @see {@link import('./types.js').PermitWindow}
 *
 * The refinements encode GAP-08's third state. `hasPermit: false` is a stated
 * blackout and must carry no times; `hasPermit: true` must carry both, because
 * a half-stated window is a producer bug that would otherwise become a silently
 * unbounded one.
 */
export const PermitWindowSchema = z
  .object({
    id: IdSchema,
    venueId: IdSchema,
    scopeKind: z.enum(['weekday-default', 'date-exception']),
    weekday: WeekdaySchema.nullable().default(null),
    date: IsoDateSchema.nullable().default(null),
    hasPermit: z.boolean().default(true),
    openMinutes: MinutesSchema.nullable().default(null),
    closeMinutes: MinutesSchema.nullable().default(null),
    /** What the permit paperwork itself claims about lighting, for cross-check. */
    lit: z.boolean().nullable().default(null),
    lightsOffMinutes: MinutesSchema.nullable().default(null),
    note: z.string().nullable().default(null),
    source: z.string().nullable().default(null),
  })
  .strict()
  .refine((window) => window.scopeKind !== 'date-exception' || window.date !== null, {
    message: 'a date-scoped permit window must carry the date it applies to',
    path: ['date'],
  })
  .refine((window) => window.scopeKind !== 'weekday-default' || window.weekday !== null, {
    message: 'a weekday-default permit window must carry the weekday it applies to',
    path: ['weekday'],
  })
  .refine(
    (window) => !window.hasPermit || (window.openMinutes !== null && window.closeMinutes !== null),
    {
      message: 'a permit window with a permit must state both an open and a close time',
      path: ['closeMinutes'],
    }
  )
  .refine(
    (window) => window.hasPermit || (window.openMinutes === null && window.closeMinutes === null),
    {
      message: 'a blackout states no times; hasPermit: false with times is a contradiction',
      path: ['hasPermit'],
    }
  )
  .refine(
    (window) =>
      window.openMinutes === null ||
      window.closeMinutes === null ||
      window.openMinutes <= window.closeMinutes,
    { message: 'a permit window must not close before it opens', path: ['closeMinutes'] }
  );

/** @see {@link import('./types.js').SunsetRecord} */
export const SunsetRecordSchema = z
  .object({
    date: IsoDateSchema,
    sunsetMinutes: MinutesSchema,
    note: z.string().nullable().default(null),
    source: z.string().nullable().default(null),
  })
  .strict();

/** @see {@link import('./types.js').SurfaceLighting} */
export const SurfaceLightingSchema = z
  .object({
    surfaceId: IdSchema,
    lit: z.boolean(),
    lightsOffMinutes: MinutesSchema.nullable().default(null),
    note: z.string().nullable().default(null),
    source: z.string().nullable().default(null),
  })
  .strict();

/**
 * One venue's daylight source: the coordinates its sunset is computed from.
 *
 * Coordinates are data the caller hands in -- in production, per-venue columns
 * in the database (8.9 plan section 2). Nothing here geocodes or fetches, and
 * no coordinate is ever committed to the repository. `null`/`null` states
 * "this venue has none", which the provider reports rather than guesses around.
 */
export const VenueDaylightSchema = z
  .object({
    venueId: IdSchema,
    latitude: z.number().min(-90).max(90).nullable(),
    longitude: z.number().min(-180).max(180).nullable(),
    source: z.string().nullable().default(null),
  })
  .strict()
  .refine((record) => (record.latitude === null) === (record.longitude === null), {
    message: 'a venue carries both coordinates or neither',
    path: ['longitude'],
  });

/**
 * Input for `buildAvailabilityCalendar()`.
 *
 * The **margins are configurable and defaulted here, once**. 15 minutes is the
 * club's stated pre-sunset safety margin (GAP-06) and the threshold the
 * acceptance criteria flag a tight permit against; hard-coding either at a call
 * site is how a policy becomes a magic number nobody can find.
 */
export const AvailabilityCalendarInputSchema = z
  .object({
    permitWindows: z.array(PermitWindowSchema).default([]),
    sunsets: z.array(SunsetRecordSchema).default([]),
    /** Per-field overrides. Empty for the corpus, which is venue-level only (GAP-05). */
    lighting: z.array(SurfaceLightingSchema).default([]),
    /** How long before sunset an unlit game must be finished. */
    sunsetMarginMinutes: z.number().int().min(0).default(15),
    /** How little room against the permit close counts as "tight". */
    permitMarginMinutes: z.number().int().min(0).default(15),
    source: z.string().nullable().default(null),
    /**
     * Per-venue daylight sources for the provider (8.9 PR 4). Optional: a
     * calendar without them answers from the date-keyed table alone, exactly
     * as before.
     */
    venueDaylight: z.array(VenueDaylightSchema).default([]),
    /**
     * The season's IANA zone (`season_settings.timezone`). A computed sunset
     * is read onto this clock, and the season's daylight-saving events are
     * derived from it. Venues use the season zone; per-venue zones are out of
     * scope.
     */
    timeZone: z.string().min(1).nullable().default(null),
  })
  .strict()
  .superRefine((input, ctx) => {
    const seen = new Set();
    input.venueDaylight.forEach((record, index) => {
      if (seen.has(record.venueId)) {
        ctx.addIssue({
          code: 'custom',
          message: `two daylight sources claim venue ${record.venueId}`,
          path: ['venueDaylight', index, 'venueId'],
        });
      }
      seen.add(record.venueId);
    });
    if (input.timeZone === null && input.venueDaylight.some((record) => record.latitude !== null)) {
      ctx.addIssue({
        code: 'custom',
        message: 'a computed sunset needs the season timeZone to be read onto its clock',
        path: ['timeZone'],
      });
    }
  });

/** Query accepted by `checkKickoffAvailability()`. */
export const KickoffAvailabilityQuerySchema = z
  .object({
    surfaceId: IdSchema,
    date: IsoDateSchema,
    kickoffMinutes: MinutesSchema,
    /** Null when the row's format is unknown to the timing table (GAP-14). */
    format: z.string().min(1).nullable(),
    /** Bookings belonging to the fixture being asked about, so it is not compared with itself. */
    ignoreBookingIds: z.array(IdSchema).default([]),
  })
  .strict();

/** Query accepted by `latestLegalKickoff()`. */
export const LatestKickoffQuerySchema = z
  .object({
    surfaceId: IdSchema,
    date: IsoDateSchema,
    format: z.string().min(1).nullable(),
    /**
     * Earliest kickoff to consider. `null` means "the permit open", which is
     * the honest default — not `0`, which would silently search hours the venue
     * is shut.
     */
    notBeforeMinutes: MinutesSchema.nullable().default(null),
    /** Latest kickoff to consider. Defaults to the end of the day. */
    notAfterMinutes: MinutesSchema.default(24 * 60),
    ignoreBookingIds: z.array(IdSchema).default([]),
  })
  .strict();
