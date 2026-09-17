import { z } from 'zod';

import { isZonelessTimestamp } from '../timing/seasonClock.js';

/**
 * An absolute instant.
 *
 * ## What this replaced, and why (GAP-30)
 *
 * `SlotSchema.start/end` and `AssignmentSchema.start/end` were a `z.coerce`
 * date -- which is `new Date(value)`, the **host-zone** parse. It was also
 * decorative: every call site did `Schema.parse(x)` for its side effects, threw
 * the result away, and rebuilt the identical `Date` by hand on the next line.
 * CLAUDE.md allows two outcomes for a field parsed and unread, honour it or
 * delete it, so the coercion is deleted and what replaced it is read at every
 * call site.
 *
 * The difference is not cosmetic. The old coercion **accepted** a naive
 * `'2026-11-07T16:44:00'` and silently gave it the host's offset, so the schema
 * was itself a source of the defect it sat in front of. This rejects a naive
 * wall reading outright: a wall time belongs on the season clock
 * (`timing/seasonClock.js`) before it ever reaches a domain schema, and a
 * schema that quietly guessed a zone is how it got past everyone the first time.
 *
 * Accepted: a `Date`, an epoch number, or a string carrying `Z` or a `+HH:MM` /
 * `-HH:MM` offset. Produces a `Date`, so the `end > start` refinements keep
 * comparing instants rather than strings.
 *
 * A bare `'2026-11-07'` is refused for the same reason and was not, until
 * `isZonelessTimestamp` replaced `isNaiveDateTime` here: `new Date()` reads a
 * date-only string as UTC midnight, so the sentence above was a description of
 * the intent rather than of the check. See `isZonelessTimestamp` for why
 * `anchorToSeasonClock` still leaves that form alone.
 */
const InstantSchema = z
  .union([z.date(), z.number(), z.string()])
  .superRefine((value, ctx) => {
    if (isZonelessTimestamp(value)) {
      ctx.addIssue({
        code: 'custom',
        message:
          'timestamp must carry a timezone; compose a wall time with timing/seasonClock.js first',
      });
      return;
    }
    if (Number.isNaN(new Date(/** @type {string|number|Date} */ (value)).getTime())) {
      ctx.addIssue({ code: 'custom', message: 'timestamp must be a valid date or instant' });
    }
  })
  .transform((value) => new Date(/** @type {string|number|Date} */ (value)));

/**
 * Schema for a Team entity.
 */
export const TeamSchema = z
  .object({
    id: z.any().refine((val) => !!val, { message: 'each team requires an id' }),
    division: z.any().refine((val) => !!val, { message: 'team division is required' }),
    organization_id: z.string().uuid().optional(),
  })
  .passthrough();

/**
 * Schema for a Player entity.
 */
export const PlayerSchema = z
  .object({
    id: z.any().refine((val) => !!val, { message: 'each player requires an id' }),
    division: z.any().refine((val) => !!val, { message: 'each player requires a division' }),
    organization_id: z.string().uuid().optional(),
  })
  .passthrough();

/**
 * Schema for a Slot entity.
 */
export const SlotSchema = z
  .object({
    id: z.any().refine((val) => !!val, { message: 'each slot requires an id' }),
    capacity: z.number().min(0, { message: 'slot capacity must define a non-negative capacity' }),
    organization_id: z.string().uuid().optional(),
    start: InstantSchema,
    end: InstantSchema,
  })
  .refine((data) => data.end > data.start, {
    message: 'slot must end after it starts',
    path: ['end'],
  })
  .passthrough();

/**
 * Schema for an Assignment entity.
 */
export const AssignmentSchema = z
  .object({
    weekIndex: z.number().positive({ message: 'assignment.weekIndex must be a positive number' }),
    division: z.any().refine((val) => !!val, { message: 'assignment.division is required' }),
    slotId: z.any().refine((val) => !!val, { message: 'assignment.slotId is required' }),
    homeTeamId: z.any().refine((val) => !!val, { message: 'homeTeamId is required' }),
    awayTeamId: z.any().refine((val) => !!val, { message: 'awayTeamId is required' }),
    start: InstantSchema,
    end: InstantSchema,
  })
  .refine((data) => data.end > data.start, {
    message: 'assignment end time must be after the start time',
    path: ['end'],
  })
  .passthrough();

/**
 * Schema for the Team Persistence Payload.
 */
export const PersistencePayloadSchema = z.object({
  snapshot: z.object({
    payload: z.object({
      teamRows: z.array(z.object({ id: z.string() }).passthrough()),
      teamPlayerRows: z.array(
        z.object({ team_id: z.string(), player_id: z.string() }).passthrough()
      ),
    }),
  }),
  overrides: z.array(z.unknown()).optional(),
  runMetadata: z.record(z.string(), z.unknown()).optional(),
});
