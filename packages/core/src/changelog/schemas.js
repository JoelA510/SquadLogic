/**
 * Zod schemas for change-log input.
 *
 * `.strict()` throughout, matching every module since Phase 1.
 *
 * **No `Date` is constructed here and none is accepted.** Dates are inclusive
 * `YYYY-MM-DD` and times are minutes past local midnight, the convention
 * `facility/`, `practice/`, `resolve/` and `fieldAdmin/` already share. A
 * change log that took a `Date` would attach the reading machine's offset to a
 * wall clock the source never carried, which is GAP-30 in a new package.
 *
 * @module changelog/schemas
 */

import { z } from 'zod';

/** Inclusive ISO calendar date, `YYYY-MM-DD`. */
export const IsoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'expected an ISO YYYY-MM-DD date' });

/** Minutes past local midnight. Never a `Date`, never a wall-clock string. */
export const MinutesSchema = z.number().int().min(0);

/** A non-empty opaque identifier. */
const IdSchema = z.string().min(1, { message: 'ids must be non-empty strings' });

/**
 * One state of a subject.
 *
 * The refinement is the invariant the rest of the package relies on:
 * `scheduled: false` means the subject had no slot, so it can carry neither a
 * time nor a ground, and `scheduled: true` means it had one, so it must carry
 * a time. A state that is unscheduled *and* timed is a parse that went wrong
 * upstream, and admitting it would make an addition indistinguishable from a
 * move.
 */
export const ChangeStateSchema = z
  .object({
    raw: z.string().nullable().default(null),
    startMinutes: MinutesSchema.nullable().default(null),
    location: z.string().min(1).nullable().default(null),
    scheduled: z.boolean(),
  })
  .strict()
  .superRefine((state, ctx) => {
    if (!state.scheduled && (state.startMinutes !== null || state.location !== null)) {
      ctx.addIssue({
        code: 'custom',
        message:
          'an unscheduled state carries neither a time nor a ground; a timed "unscheduled" state makes an addition read as a move',
        path: ['scheduled'],
      });
    }
    if (state.scheduled && state.startMinutes === null) {
      ctx.addIssue({
        code: 'custom',
        message: 'a scheduled state must carry a start time in minutes past midnight',
        path: ['startMinutes'],
      });
    }
    // **And its ground.** `types.js` says `null` means "not scheduled at
    // all" and is never "unknown"; admitting a scheduled state with a null
    // `location` would break that in the one place it costs something.
    // `changedFieldsOf()` compares `location` by value, so a source that
    // merely omitted the ground on one side would make the entry report a
    // ground change -- and under §8.10, where every entry becomes a notice,
    // a family would read that a game moved pitch when it did not.
    if (state.scheduled && state.location === null) {
      ctx.addIssue({
        code: 'custom',
        message:
          'a scheduled state must name the ground it sits on; a null ground would be compared as a value and report a move that did not happen',
        path: ['location'],
      });
    }
  });

/**
 * One raw entry, before classification.
 *
 * `reason` is **required and non-empty here**, which is the change 8.8 asks
 * for against `ScheduleChangeRequestSchema`'s nullable one
 * (`resolve/schemas.js:45`). The two are different objects and this is not a
 * change to that one: a *request* may legitimately arrive without a reason and
 * be refused for it, while a *logged* change with no reason is a row that can
 * never answer the question the log exists for. Making the log's field
 * required is the narrow half of that instruction; making the request's field
 * required changes an API with eight call sites and belongs with the work that
 * gives the request a requester and an approver.
 */
export const RawChangeEntrySchema = z
  .object({
    date: IsoDateSchema,
    home: z.string().min(1),
    away: z.string().min(1),
    reason: z.string().min(1, {
      message: 'a logged change carries a reason; a log of unexplained changes answers nothing',
    }),
    before: ChangeStateSchema,
    after: ChangeStateSchema,
  })
  .strict();

/**
 * A team in the universe an entry's participants are resolved against.
 *
 * The universe is **supplied**, never derived from the entries — the rule
 * `publication/notices.js` states at length and `docs/LESSONS_LEARNED.md`
 * repeats: a subject set taken from the data a break would corrupt cannot
 * report the break.
 */
export const ChangeLogTeamSchema = z
  .object({
    teamId: IdSchema,
    teamName: z.string().min(1).nullable().default(null),
  })
  .strict();
