/**
 * Zod schemas for facility-graph input.
 *
 * Every schema here is `.strict()`, which is a deliberate break with
 * `packages/core/src/schemas/index.js` — those are all `.passthrough()`, and
 * `docs/ARCHITECTURE.md` §1.1 records passthrough as exactly what let four
 * copies of the slot model drift apart without anything failing. An
 * unrecognised key on a facility record is a bug in the producer, so it is an
 * error here rather than a silent passenger.
 *
 * @module facility/schemas
 */

import { z } from 'zod';

/** Inclusive ISO calendar date, `YYYY-MM-DD`. No `Date` construction anywhere. */
const IsoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'expected an ISO YYYY-MM-DD date' });

/** A non-empty opaque identifier. */
const IdSchema = z.string().min(1, { message: 'ids must be non-empty strings' });

/** @see {@link import('./types.js').FacilityVenue} */
export const FacilityVenueSchema = z
  .object({
    id: IdSchema,
    name: z.string().min(1),
    /**
     * `null` is "no source states it", and it is the default: an omitted
     * flag is an absence, not a stated "unlit" (GAP-05). `availability/`
     * reports the difference as `LIGHTING_UNDECLARED`.
     */
    lit: z.boolean().nullable().default(null),
    notes: z.string().nullable().default(null),
    /** The site's own prose about its overlap geometry, carried for audit. */
    overlapNote: z.string().nullable().default(null),
    /**
     * **Effective dating: when this node is part of the estate.**
     *
     * `null` on both sides is "always", and it is the default, so every graph
     * built before 8.4 keeps its exact meaning. A node with either side set is
     * a *dated* node, and `lifecycle.js` counts them: a query that names no
     * `asOf` against a graph holding dated nodes is answering about an estate
     * that has more than one shape, which is what
     * `FACILITY_LIFECYCLE_UNJUDGED` says.
     *
     * Both bounds are **inclusive**, matching `blackout_from`/`blackout_until`
     * and `available_from`/`available_until` on the tables this mirrors, so a
     * reader does not have to remember which of three conventions applies.
     */
    effectiveFrom: IsoDateSchema.nullable().default(null),
    effectiveTo: IsoDateSchema.nullable().default(null),
  })
  .strict();

/** @see {@link import('./types.js').FacilitySurface} */
export const FacilitySurfaceInputSchema = z
  .object({
    id: IdSchema,
    venueId: IdSchema,
    name: z.string().min(1),
    sizes: z.array(z.string().min(1)).default([]),
    lined: z.array(z.string().min(1)).default([]),
    parentId: IdSchema.nullable().default(null),
    childIds: z.array(IdSchema).default([]),
    /**
     * Parent surfaces are bookable. "Book Alder Pitch 1 as a full pitch while
     * 1A is occupied" must be rejected by *occupancy*
     * (`OCCUPIED_PARENT_CHILD`), which tells the operator something useful —
     * not by `SURFACE_NOT_BOOKABLE`, which would imply the full pitch can never
     * be booked at all.
     */
    bookable: z.boolean().default(true),
    note: z.string().nullable().default(null),
    /** @see {@link FacilityVenueSchema} `effectiveFrom` -- same contract, same defaults. */
    effectiveFrom: IsoDateSchema.nullable().default(null),
    effectiveTo: IsoDateSchema.nullable().default(null),
  })
  .strict();

/** @see {@link import('./types.js').EquipmentScope} */
export const EquipmentScopeSchema = z
  .object({
    kind: z.enum(['venue', 'surface']),
    id: IdSchema,
  })
  .strict();

/** @see {@link import('./types.js').EquipmentWindow} */
export const EquipmentWindowSchema = z
  .object({
    id: IdSchema,
    equipment: z.string().min(1),
    status: z.enum(['available', 'unavailable', 'unknown']),
    scope: EquipmentScopeSchema,
    fromDate: IsoDateSchema,
    toDate: IsoDateSchema,
    note: z.string().nullable().default(null),
    source: z.string().nullable().default(null),
  })
  .strict()
  .refine((window) => window.fromDate <= window.toDate, {
    message: 'equipment window fromDate must not be after toDate',
    path: ['toDate'],
  });

/** An undirected overlap pair, given as two surface ids. */
export const OverlapPairSchema = z.tuple([IdSchema, IdSchema]);

/** @see {@link import('./types.js').FacilityGraphInput} */
export const FacilityGraphInputSchema = z
  .object({
    venues: z.array(FacilityVenueSchema),
    surfaces: z.array(FacilitySurfaceInputSchema),
    overlapPairs: z.array(OverlapPairSchema).default([]),
    equipmentWindows: z.array(EquipmentWindowSchema).default([]),
    /**
     * Explicit format → required equipment map. There is deliberately **no**
     * derivation rule such as `` `${format} goals` ``: a guessed requirement
     * either blocks bookings for kit nobody ever needed, or silently fails to
     * block ones that did.
     */
    formatEquipment: z.record(z.string().min(1), z.array(z.string().min(1))).default({}),
    sizeRank: z.record(z.string().min(1), z.number()).optional(),
    sizePolicy: z.enum(['downward-closed', 'declared']).optional(),
  })
  .strict();

/** @see {@link import('./types.js').FacilityBooking} */
export const FacilityBookingSchema = z
  .object({
    id: IdSchema,
    surfaceId: IdSchema,
    date: IsoDateSchema,
    startMinutes: z.number().int().min(0),
    /** Nullable by design — GAP-14, the corpus's four untimed `Scrimmage` rows. */
    endMinutes: z.number().int().min(0).nullable(),
    format: z.string().min(1).nullable().default(null),
    label: z.string().nullable().default(null),
  })
  .strict()
  .refine((booking) => booking.endMinutes === null || booking.endMinutes >= booking.startMinutes, {
    message: 'booking endMinutes must not precede startMinutes',
    path: ['endMinutes'],
  });

/**
 * **A venue's latitude/longitude pair, as `admin_set_location_coordinates`
 * accepts it** (migration `20260930000000`, plan 8.9 §2).
 *
 * Both or neither: `{ latitude: null, longitude: null }` is the clear, and a
 * half pair is refused, matching the RPC's 22023 and the table's
 * `locations_coordinates_both_or_neither` CHECK. Ranges are inclusive,
 * latitude -90..90 and longitude -180..180, judged on the value AS GIVEN --
 * the RPC's contract too, so 90.004 is refused by both rather than rounded
 * into range by one of them. Rounding to 2 decimals (D9) is the RPC's; this
 * schema validates and does not transform.
 *
 * Both keys are required, `null` included. An omitted key is not read as a
 * clear: clearing destroys an admin's entry, so it has to be stated. Numbers
 * only -- a form's string is the caller's to convert, and `NaN`/`Infinity`
 * are refused. Nothing geocodes.
 */
export const LocationCoordinatesSchema = z
  .object({
    latitude: z.number().min(-90).max(90).nullable(),
    longitude: z.number().min(-180).max(180).nullable(),
  })
  .strict()
  .refine((pair) => (pair.latitude === null) === (pair.longitude === null), {
    message: 'latitude and longitude are both given or both null',
    path: ['longitude'],
  });
