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
import { TeamCoachAssignmentRowSchema } from '../people/schemas.js';

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
 * The D14 constants (8.9 D14, operator 2026-09-29), exported so the Edge twin
 * (PR C) can pin itself to them.
 *
 * - {@link PRACTICE_COMPRESSION_STEP_MINUTES}: a phase shortens a practice to
 *   `D0 - 10k`, D0 its own length, k the fewest steps that end it by sunset.
 * - {@link PRACTICE_MINIMUM_DURATION_MINUTES}: shortening stops at 40; below
 *   it the practice shifts earlier if the floor allows, else it is TIME TBD.
 * - {@link PRACTICE_EARLIEST_START_WEEKDAYS}: the nights
 *   `season_settings.school_day_end` bounds (Mon-Thu, as `practiceMetrics.js`
 *   reads it). On any other night the floor is unknown and a shift is refused.
 */
export const PRACTICE_COMPRESSION_STEP_MINUTES = 10;
export const PRACTICE_MINIMUM_DURATION_MINUTES = 40;
export const PRACTICE_EARLIEST_START_WEEKDAYS = Object.freeze(
  /** @type {const} */ (['MON', 'TUE', 'WED', 'THU'])
);

/** How an unlit slot adapts to sunset: an admin's choice per slot (D14). */
export const PRACTICE_COMPRESSION_STRATEGY = Object.freeze({
  SHORTEN: 'shorten',
  SHIFT_EARLIER: 'shift-earlier',
});

export const PracticeCompressionStrategySchema = z.enum([
  PRACTICE_COMPRESSION_STRATEGY.SHORTEN,
  PRACTICE_COMPRESSION_STRATEGY.SHIFT_EARLIER,
]);

/**
 * An approved portable-lighting window on one slot (8.9 D14): the slot's dates
 * in `[from, until]` are not judged against sunset, need no coordinates and are
 * never compressed. An input only: the table is PR B, the Edge read PR C.
 */
export const PracticeLightingOverrideSchema = z
  .object({
    slotId: IdSchema,
    from: IsoDateSchema,
    until: IsoDateSchema,
  })
  .strict()
  .refine((override) => override.until >= override.from, {
    message: 'a lighting override `until` must not precede its `from`',
    path: ['until'],
  });

/**
 * The statuses of a `practice_lighting_overrides` row (8.9 D14 PR B,
 * `supabase/migrations/20261003000000_practice_lighting_overrides.sql`, whose
 * status CHECK this list must equal). Only `approved` exempts anything.
 */
export const PRACTICE_LIGHTING_OVERRIDE_STATUS = Object.freeze({
  REQUESTED: 'requested',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  WITHDRAWN: 'withdrawn',
});

/** The table's one `kind` (its CHECK): the only override D14 defines. */
export const PRACTICE_LIGHTING_OVERRIDE_KIND = 'portable-lighting';

/**
 * A `daterange` as Postgres prints a canonical, bounded one: `[from,end)`,
 * the end EXCLUSIVE. The table refuses an empty or unbounded window, so any
 * other spelling is a read that did not come from it.
 */
const CanonicalDateRangeSchema = z
  .string()
  .regex(/^\[\d{4}-\d{2}-\d{2},\d{4}-\d{2}-\d{2}\)$/, 'a canonical bounded daterange `[from,end)`');

/**
 * A `practice_lighting_overrides` row as read from the database (8.9 D14 PR
 * B): only the columns a reader turns into a {@link PracticeLightingOverrideSchema}
 * input. The row's id and its who-and-when columns stay in the database and
 * the audit log; nothing here reads them, so nothing here parses them.
 */
export const PracticeLightingOverrideRowSchema = z.object({
  practice_slot_id: IdSchema,
  window: CanonicalDateRangeSchema,
  kind: z.literal(PRACTICE_LIGHTING_OVERRIDE_KIND),
  status: z.enum(Object.values(PRACTICE_LIGHTING_OVERRIDE_STATUS)),
});

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

/**
 * Input to `repairPracticeLoss()` (Phase 8.6 PR 3a).
 *
 * `graph` is the facility graph, checked for shape only: the facility layer
 * owns its own validation. `inventory` is every practice shape the published
 * plan used; the repair offers nothing else.
 */
const PracticeShapeSchema = z
  .object({
    surfaceId: IdSchema,
    weekday: PracticeWeekdaySchema,
    startMinutes: MinutesSchema,
    durationMinutes: z.number().int().positive(),
  })
  .strict();

/**
 * A loss of ground (8.6 PR 3b plan §1). With no `until` it is a retirement:
 * the ground is gone from `from` on. With `until` it is a blackout, over
 * `[from, until]` inclusive. `startMinutes`/`endMinutes` narrow it to a time of
 * day (both or neither, `[start, end)`, as `field_blackouts` stores them).
 */
const PracticeLossSchema = z
  .object({
    surfaceIds: z.array(IdSchema).min(1, { message: 'a loss names at least one surface' }),
    from: IsoDateSchema,
    until: IsoDateSchema.optional(),
    startMinutes: MinutesSchema.max(1440).optional(),
    endMinutes: MinutesSchema.max(1440).optional(),
    reason: z.string().min(1, { message: 'a loss must say why' }),
  })
  .strict()
  .refine((loss) => loss.until === undefined || loss.until >= loss.from, {
    message: 'a loss `until` must not precede its `from`',
    path: ['until'],
  })
  .refine((loss) => (loss.startMinutes === undefined) === (loss.endMinutes === undefined), {
    message: 'a loss states `startMinutes` and `endMinutes` together, or neither',
    path: ['endMinutes'],
  })
  .refine(
    (loss) =>
      loss.startMinutes === undefined ||
      loss.endMinutes === undefined ||
      loss.startMinutes < loss.endMinutes,
    { message: 'a loss `startMinutes` must precede its `endMinutes`', path: ['endMinutes'] }
  )
  // Minutes come from blackouts, which end. A retirement is the whole ground
  // from `from` on: its split cuts every slot there, so a series spared by the
  // minutes would silently lose its practices.
  .refine((loss) => loss.startMinutes === undefined || loss.until !== undefined, {
    message: 'a loss with `startMinutes`/`endMinutes` must state `until`',
    path: ['until'],
  });

export const PracticeRepairInputSchema = z
  .object({
    plan: PracticeSlotSetInputSchema,
    graph: z.object({ surfaces: z.record(z.string(), z.any()) }).passthrough(),
    loss: PracticeLossSchema,
    inventory: z.array(PracticeShapeSchema),
    coachesByTeam: z.record(z.string(), z.array(z.string())).optional(),
    weights: z.record(z.string(), z.number()).optional(),
    changeBudget: z.number().int().min(0).nullable().optional(),
    searchNodeLimit: z.number().int().positive().optional(),
    strategy: z.enum(['exact', 'greedy']).optional(),
    /**
     * APPROVED coach practice preferences (8.6 PR 3b plan §4), as input data;
     * loading them is the adapter's job (PR 9). Each element is checked by
     * `repairPracticeLoss()` against `practice/coachPreferences.js`
     * `CoachPreferenceInputSchema`, the one contract for a preference: that
     * module imports this one, so importing it back here would be a cycle.
     */
    coachPreferences: z.array(z.unknown()).optional(),
    /**
     * The `team_coach_assignments` rows that say which coaches are CURRENT on a
     * team on a date. Preferences are judged over those coaches only.
     */
    teamCoachAssignments: z.array(TeamCoachAssignmentRowSchema).optional(),
    /**
     * The daylight provider (8.9 PR 7): an `availability/calendar.js`
     * `buildAvailabilityCalendar()` result, checked for shape only, as `graph`
     * is. With it, every re-home candidate is judged by
     * `practice/daylight.js` over its series-window; without it, nothing is,
     * and the result says so (`PRACTICE_REPAIR_DAYLIGHT_UNCHECKED`).
     */
    calendar: z
      .object({
        sunsetsByDate: z.record(z.string(), z.any()),
        lightingBySurface: z.record(z.string(), z.any()),
      })
      .passthrough()
      .optional(),
    /**
     * Approved portable-lighting windows on the plan's slots (8.9 D14), as
     * input data. A candidate shape is exempt on a date only when every plan
     * slot with that shape has a window covering it.
     */
    lightingOverrides: z.array(PracticeLightingOverrideSchema).optional(),
    /**
     * Ground ALREADY closed, besides the loss being repaired (existing
     * blackouts and retirements), each in the loss's own shape: a re-home
     * candidate that meets one on any date of its series-window is refused.
     * Nothing on it is displaced: it is not the loss.
     */
    closures: z.array(PracticeLossSchema).optional(),
  })
  .strict()
  // Preferences with no rows would bind no coach to any team, so every one of
  // them would be inert and the repair would say nothing. Refused instead.
  .refine(
    (input) =>
      (input.coachPreferences ?? []).length === 0 || (input.teamCoachAssignments ?? []).length > 0,
    {
      message:
        'coach preferences need `teamCoachAssignments` rows: without them no coach is current on any team, and every preference would be silently inert',
      path: ['teamCoachAssignments'],
    }
  );

/**
 * An operator's pin on one slot's practice duration from a date (8.9 PR 5,
 * `durationPhases.js`; keyed by slot since D14 made cuts per slot). It is
 * applied **before** that date is judged, so an override that would leave a
 * practice past sunset is superseded on the spot by a derived phase and the
 * supersession is recorded -- never honoured silently, never dropped silently.
 */
export const PracticeDurationPhaseOverrideSchema = z
  .object({
    slotId: IdSchema,
    effectiveFrom: IsoDateSchema,
    durationMinutes: z.number().int().positive(),
    reason: z.string().min(1, { message: 'a duration override carries its reason' }),
  })
  .strict();

/**
 * The options every 8.9 PR 5 derivation takes.
 *
 * - `minimumDurationMinutes` defaults to 40 and `durationStepMinutes` to 10
 *   (operator 2026-09-29, D14).
 * - `strategies` maps a slot id to its strategy; a slot not named shortens.
 * - `earliestStartMinutes` is `season_settings.school_day_end`, the floor on
 *   the `earliestStartWeekdays` (default Mon-Thu). It is **required** when any
 *   slot is set to shift earlier. Without it, and on any other night, every
 *   shift -- the automatic fallback included -- is refused with a reason; the
 *   floor is never assumed.
 * - `lightingOverrides` exempt their slot's dates (portable lighting).
 */
export const PracticeDurationPhaseOptionsSchema = z
  .object({
    window: z
      .object({ from: IsoDateSchema, to: IsoDateSchema })
      .strict()
      .refine((window) => window.to >= window.from, {
        message: 'window `to` must not precede `from`',
        path: ['to'],
      }),
    minimumDurationMinutes: z.number().int().positive().default(PRACTICE_MINIMUM_DURATION_MINUTES),
    durationStepMinutes: z.number().int().positive().default(PRACTICE_COMPRESSION_STEP_MINUTES),
    overrides: z.array(PracticeDurationPhaseOverrideSchema).default([]),
    strategies: z.record(z.string(), PracticeCompressionStrategySchema).default({}),
    earliestStartMinutes: MinutesSchema.max(1439).nullable().default(null),
    earliestStartWeekdays: z
      .array(PracticeWeekdaySchema)
      .min(1)
      .default(() => [...PRACTICE_EARLIEST_START_WEEKDAYS]),
    lightingOverrides: z.array(PracticeLightingOverrideSchema).default([]),
  })
  .strict()
  .refine(
    (options) =>
      options.earliestStartMinutes !== null ||
      !Object.values(options.strategies).includes(PRACTICE_COMPRESSION_STRATEGY.SHIFT_EARLIER),
    {
      message:
        'a slot set to shift earlier needs `earliestStartMinutes` (season_settings.school_day_end): the floor is never assumed',
      path: ['earliestStartMinutes'],
    }
  );
