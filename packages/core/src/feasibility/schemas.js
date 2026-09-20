/**
 * Zod schemas for the questions this module answers.
 *
 * `.strict()` throughout, matching `facility/schemas.js`, `timing/schemas.js`,
 * `availability/schemas.js` and `attribution/schemas.js`, and deliberately
 * unlike `packages/core/src/schemas/index.js`, whose blanket `.passthrough()`
 * is what let four copies of the slot model drift apart without anything
 * failing (`docs/ARCHITECTURE.md` §1.1).
 *
 * Only **queries** are parsed here. The engines a question is asked against
 * arrive as already-built objects from the modules that own them, exactly as in
 * `attribution/schemas.js`.
 *
 * ## Adopted contracts, and the one place this deviates
 *
 * {@link MoveFeasibilityQuerySchema} takes `attribution/schemas.js`'s
 * `AlternativeTimeQuerySchema` field names and defaults verbatim —
 * `insteadOfMinutes` / `insteadOfSurfaceId` / `insteadOfDate`, each defaulting
 * to the position the subject already holds — because 4.3 already owns "the
 * game, and the position it does not have" and a second vocabulary for the same
 * three fields would be a third contract for one idea (`CLAUDE.md` §3).
 *
 * The one deviation is stated rather than smuggled: `insteadOfMinutes` is
 * **nullable here and required there**. *"Can this game move to Thursday?"* is a
 * real question that names no time, and requiring one would force every caller
 * to restate the kickoff it is not asking about. `null` means "keep the kickoff
 * it has", which is the same default the other two fields already carry.
 *
 * @module feasibility/schemas
 */

import { z } from 'zod';

/** Inclusive ISO calendar date, `YYYY-MM-DD`. No `Date` construction anywhere (GAP-30). */
const IsoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'expected an ISO YYYY-MM-DD date' });

/** A non-empty opaque identifier. */
const IdSchema = z.string().min(1, { message: 'ids must be non-empty strings' });

/** Minutes past local midnight. Not capped at 1440: a permit may close after midnight. */
const MinutesSchema = z.number().int().min(0);

/**
 * *"Can this game move to Thursday / to 6pm / to that field?"*
 *
 * Every field of the destination defaults to the coordinate the game already
 * holds, so a caller states only what changes.
 */
export const MoveFeasibilityQuerySchema = z
  .object({
    gameId: IdSchema,
    /** The kickoff being asked about. Null keeps the one it has. */
    insteadOfMinutes: MinutesSchema.nullable().default(null),
    /** Defaults to the surface the game already stands on. */
    insteadOfSurfaceId: IdSchema.nullable().default(null),
    /** Defaults to the date the game already stands on. */
    insteadOfDate: IsoDateSchema.nullable().default(null),
  })
  .strict();

/**
 * *"Can this team play at 6pm in November?"*
 *
 * `dates` is a list rather than a range because a season is thirteen specific
 * dates each with its own permit set and its own sunset (GAP-01), not an
 * interval; expanding a range here would invent dates the calendar does not
 * hold. `surfaceIds` empty means "the surfaces this team already plays on",
 * derived and reported, rather than every surface in the graph — a question
 * about a team is not a question about the whole estate.
 */
export const TeamFeasibilityQuerySchema = z
  .object({
    teamId: IdSchema,
    dates: z.array(IsoDateSchema).min(1, { message: 'name at least one date to ask about' }),
    kickoffMinutes: MinutesSchema,
    surfaceIds: z.array(IdSchema).default([]),
    /** Null derives it from the team's own fixtures; ambiguity is reported, never picked. */
    format: z.string().min(1).nullable().default(null),
  })
  .strict();

/**
 * One thing standing on ground, in the one shape a game and a practice share.
 *
 * **Why a shared shape rather than two indexes.** A move request is a question
 * about who else holds the ground in a window, and the club's ground carries
 * both kinds. Two indexes is how a swap gets computed against half the
 * occupancy — a game offered a slot a practice already holds — which is the
 * `bookingsOn()`-versus-a-second-mapping failure `feasibility/verdict.js`
 * records, one layer up.
 *
 * Games are **derived** from the context and never handed in; only practices
 * are supplied, because Phase 8 has no practice engine for the query to read
 * one from. See `feasibility/moveRequest.js` for what that costs the answer and
 * where it is said.
 */
export const MoveRequestHoldingSchema = z
  .object({
    id: IdSchema,
    date: IsoDateSchema,
    surfaceId: IdSchema,
    startMinutes: MinutesSchema,
    /** Null is GAP-14's unknown footprint, carried and never invented. */
    endMinutes: MinutesSchema.nullable().default(null),
    format: z.string().min(1).nullable().default(null),
    /** Whose commitment this is; both sides of a fixture, or the practising team. */
    teamIds: z.array(IdSchema).default([]),
    /** The people who must be there, so travel and double-booking can be asked about. */
    personIds: z.array(IdSchema).default([]),
    divisionLabel: z.string().min(1).nullable().default(null),
    label: z.string().min(1).nullable().default(null),
  })
  .strict();

/**
 * *"A parent asked to move this into that window — what can the club offer?"*
 *
 * `dates` and `surfaceIds` are lists for the reason
 * {@link TeamFeasibilityQuerySchema}'s are: a season is specific dates each with
 * its own permit set and its own sunset, and expanding a range here would invent
 * dates the calendar does not hold. `surfaceIds` empty means *"the surfaces this
 * entity's own commitments already use"*, derived and reported.
 *
 * The three grid fields are `ReserveCapacityInputSchema`'s own, verbatim and
 * with its defaults, because the grid this query joins to is that report's — a
 * second cadence vocabulary for one idea would be a third contract.
 */
export const MoveRequestQuerySchema = z
  .object({
    /** A `MOVE_REQUEST_ENTITY` value. */
    entityKind: z.enum(['game', 'practice']),
    entityId: IdSchema,
    dates: z.array(IsoDateSchema).min(1, {
      message: 'name at least one date to ask about; an empty window offers nothing by definition',
    }),
    surfaceIds: z.array(IdSchema).default([]),
    cadenceMinutes: z.number().int().min(1),
    earliestKickoffMinutes: MinutesSchema,
    latestKickoffMinutes: MinutesSchema.default(24 * 60),
  })
  .strict();

/**
 * *"How late — and how early — can anything kick off here on this date?"*
 *
 * Field names and defaults are `availability/schemas.js`'s
 * `LatestKickoffQuerySchema`, which owns the search this composes.
 */
export const KickoffBoundsQuerySchema = z
  .object({
    surfaceId: IdSchema,
    date: IsoDateSchema,
    format: z.string().min(1).nullable(),
    /** Null means "the permit open" — not `0`, which searches hours the venue is shut. */
    notBeforeMinutes: MinutesSchema.nullable().default(null),
    notAfterMinutes: MinutesSchema.default(24 * 60),
    /** Fixtures excluded from the standing bookings, so one is not compared with itself. */
    ignoreGameIds: z.array(IdSchema).default([]),
  })
  .strict();
