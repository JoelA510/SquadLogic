/**
 * Zod schemas for the recurring-practice model.
 *
 * **Everything here is timezone-free by construction.** A date is an ISO
 * `YYYY-MM-DD` string, a time is minutes past local midnight, and a weekday is
 * a three-letter code. No schema accepts a `Date`, and nothing in this package
 * builds one — the same rule `facility/index.js` states for the facility graph,
 * for the same reason: an instant needs a timezone, this layer does not have
 * one, and guessing UTC is how `applyMinutesToDate()`
 * (`packages/core/src/utils/date.js:118`) turned a 17:00 practice into 17:00Z.
 *
 * The date and id primitives are imported from `availability/schemas.js`
 * rather than restated, so "this cell is a date" has one reading across the
 * repo.
 *
 * @module practice/schemas
 */

import { z } from 'zod';

import { IdSchema, IsoDateSchema } from '../availability/schemas.js';

/**
 * Three-letter weekday code.
 *
 * `availability/schemas.js` declares the identical enum but does not export it,
 * so this is a second literal. It is not allowed to be a second *vocabulary*:
 * `tests/practiceSlotModel.test.js` walks seven consecutive dates through
 * `weekdayCodeOf()` and asserts every code it produces parses here and that all
 * seven members are reached, which fails the day either list moves.
 */
export const PracticeWeekdaySchema = z.enum(['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']);

/** Minutes past local midnight. */
const MinutesSchema = z.number().int().min(0);

/**
 * A recurring practice slot: ground, a weekday, a start, a duration, and the
 * range over which that arrangement holds.
 *
 * **No team.** `practice_slots` has no team column
 * (`supabase/migrations/20260331000000_definitive_schema.sql:496-511`); teams
 * attach through `practice_assignments.team_id` (`:525`). Putting teams here
 * would also contradict `capacity`, which exists precisely because one slot
 * holds several teams. A team's link to a slot is a
 * {@link PracticeAssignmentSchema}.
 *
 * `validFrom` / `validUntil` are **nullable, and null is not "forever"** — it
 * is "the source did not say", which is the state the season-2026 corpus is
 * actually in for all seven of its plan revisions. A null range materialises to
 * nothing and reports `PRACTICE_REVISION_UNDATED`; it does not quietly become
 * the whole season.
 */
export const PracticeSlotSchema = z
  .object({
    id: IdSchema,
    /** A facility-graph surface id, at the depth 8.3 added (half-pitches, sides). */
    surfaceId: IdSchema,
    weekday: PracticeWeekdaySchema,
    startMinutes: MinutesSchema,
    durationMinutes: z.number().int().positive(),
    validFrom: IsoDateSchema.nullable().default(null),
    validUntil: IsoDateSchema.nullable().default(null),
    capacity: z.number().int().positive().default(1),
    /** Which revision of the plan this row came from; the corpus's `source_sheet`. */
    revisionId: z.string().min(1).nullable().default(null),
    label: z.string().nullable().default(null),
    /**
     * How an adapter's `(venue, field, subunit)` triple resolved against the
     * facility graph — a `PRACTICE_SURFACE_RESOLUTION` value, or `null` when
     * the caller supplied a surface id directly and there was nothing to
     * resolve.
     *
     * Carried on the slot rather than raised by the adapter because an adapter
     * produces plan data and the builder produces findings; `buildClosureSet()`
     * splits the same work the same way. Anything other than `resolved` gets
     * `PRACTICE_SLOT_SURFACE_UNRESOLVED`.
     */
    surfaceResolution: z
      .enum([
        'resolved',
        'ambiguous',
        'venue-unknown',
        'surface-unknown',
        'subunit-unknown',
        'venue-only',
      ])
      .nullable()
      .default(null),
  })
  .strict()
  .refine(
    (slot) =>
      slot.validFrom === null || slot.validUntil === null || slot.validUntil >= slot.validFrom,
    {
      message: 'slot validUntil must not precede validFrom',
      path: ['validUntil'],
    }
  )
  .refine((slot) => (slot.validFrom === null) === (slot.validUntil === null), {
    message:
      'a slot validity range is stated at both ends or at neither; a half-stated range is a producer bug',
    path: ['validFrom'],
  });

/**
 * A team's hold on a slot, over a range.
 *
 * The range is nullable and **inherits the slot's when null** — the common case
 * is a team holding a slot for exactly as long as the slot exists, and making
 * every caller restate the dates invites the two drifting apart.
 */
export const PracticeAssignmentSchema = z
  .object({
    id: IdSchema,
    slotId: IdSchema,
    teamId: IdSchema,
    effectiveFrom: IsoDateSchema.nullable().default(null),
    effectiveUntil: IsoDateSchema.nullable().default(null),
  })
  .strict()
  .refine(
    (a) =>
      a.effectiveFrom === null || a.effectiveUntil === null || a.effectiveUntil >= a.effectiveFrom,
    {
      message: 'assignment effectiveUntil must not precede effectiveFrom',
      path: ['effectiveUntil'],
    }
  )
  .refine((a) => (a.effectiveFrom === null) === (a.effectiveUntil === null), {
    message: 'an assignment range is stated at both ends or at neither',
    path: ['effectiveFrom'],
  });

/** What an exception does to the one date it names. */
export const PRACTICE_EXCEPTION_KIND = Object.freeze({
  /** The occurrence does not happen. Holiday, closure, rain-out. */
  CANCELLED: 'cancelled',
  /** The occurrence happens, at a different start. */
  MOVED: 'moved',
  /** The occurrence happens, for a different length. */
  SHORTENED: 'shortened',
});

/**
 * A dated override on a slot.
 *
 * **An override, never an edit.** The slot is unchanged; the exception is a
 * separate record naming one date. That is what makes a history replayable:
 * the plan and the departures from it are separable, so "what was the plan in
 * October" and "what actually happened on 2026-10-17" are different questions
 * with different answers.
 *
 * `reason` is **required**, including for a cancellation. A practice that
 * disappears without a reason is the silent drop `CLAUDE.md` §3 forbids, and
 * the cheapest place to forbid it is the schema.
 */
export const PracticeExceptionSchema = z
  .object({
    id: IdSchema,
    slotId: IdSchema,
    date: IsoDateSchema,
    kind: z.enum([
      PRACTICE_EXCEPTION_KIND.CANCELLED,
      PRACTICE_EXCEPTION_KIND.MOVED,
      PRACTICE_EXCEPTION_KIND.SHORTENED,
    ]),
    reason: z.string().min(1, { message: 'an exception must say why' }),
    /** Required by `moved`, forbidden otherwise. */
    startMinutes: MinutesSchema.nullable().default(null),
    /** Required by `shortened`, forbidden otherwise. */
    durationMinutes: z.number().int().positive().nullable().default(null),
  })
  .strict()
  .superRefine((exception, ctx) => {
    const wantsStart = exception.kind === PRACTICE_EXCEPTION_KIND.MOVED;
    const wantsDuration = exception.kind === PRACTICE_EXCEPTION_KIND.SHORTENED;
    if (wantsStart !== (exception.startMinutes !== null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['startMinutes'],
        message: `a ${exception.kind} exception ${wantsStart ? 'requires' : 'must not carry'} startMinutes`,
      });
    }
    if (wantsDuration !== (exception.durationMinutes !== null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['durationMinutes'],
        message: `a ${exception.kind} exception ${wantsDuration ? 'requires' : 'must not carry'} durationMinutes`,
      });
    }
  });

/** The input `buildPracticeSlotSet()` accepts. */
export const PracticeSlotSetInputSchema = z
  .object({
    slots: z.array(PracticeSlotSchema),
    assignments: z.array(PracticeAssignmentSchema).default([]),
    /** Where this plan came from, for the findings. */
    source: z.string().min(1).nullable().default(null),
  })
  .strict();

/** The window `materialisePracticeOccurrences()` fills. */
export const PracticeWindowSchema = z
  .object({
    from: IsoDateSchema,
    to: IsoDateSchema,
    exceptions: z.array(PracticeExceptionSchema).default([]),
  })
  .strict()
  .refine((window) => window.to >= window.from, {
    message: 'window `to` must not precede `from`',
    path: ['to'],
  });
