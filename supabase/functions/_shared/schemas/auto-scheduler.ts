/**
 * Request schema for the auto-scheduler Edge Function. Lives in _shared so a Deno test can
 * validate a request without importing the serving module, and so the team shape is the one
 * `TeamSchema` in ./scoring.ts (Phase 8.1: `assistantCoachIds`, nullable).
 */
import { z } from 'zod';
import { TeamSchema, WallTimeOrInstantSchema } from './scoring.ts';

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

const SlotSchema = z
  .object({
    id: z.string(),
    /**
     * The weekday, as the caller names it. Never derived here or in the engine
     * -- see the note on `SlotSchema.day` in `./scoring.ts`.
     */
    day: z.string().nullable().optional(),
    /**
     * A wall reading or an instant. `index.ts` composes it on the season's
     * clock (read from `season_settings`, not from this body) before anything
     * calls `new Date()` on it. See `_shared/timing/anchorWallTimes.ts`.
     */
    start: WallTimeOrInstantSchema,
    end: WallTimeOrInstantSchema,
    capacity: z.number().int().min(0),
    baseSlotId: z.string().optional(),
  })
  .passthrough();

/**
 * `coachPreferences` used to be declared here (`preferredDays`,
 * `preferredSlotIds`, `unavailableSlotIds`). Only `unavailableSlotIds` was
 * ever read, no client sent any of them, and a preference taken from the body
 * is one the caller chose. Retired (8.6 PR 3b, PR 8): approved coach
 * preferences are loaded server-side, as the caller through RLS, by
 * `_shared/engines/coach-preference-load.ts`. The key is not listed, so an
 * older client that still sends it is not rejected -- Zod strips it, and
 * nothing reads it.
 */
/** The optimiser's defaults, read by the field defaults and the object default alike. */
const CONFIG_DEFAULTS = Object.freeze({ timeBudgetMs: 25000, maxIterations: 2000, seed: 42 });

export const AutoSchedulerInputSchema = z.object({
  organizationId: z.string().uuid(),
  seasonSettingsId: z.string().uuid().optional(),
  teams: z.array(TeamSchema).min(1),
  slots: z.array(SlotSchema).min(1),
  divisionPreferences: z
    .record(
      z.string(),
      z
        .object({
          preferredDays: z.array(z.string()).optional(),
        })
        .passthrough()
    )
    .optional()
    .default({}),
  /**
   * The page's view of the season's current practice assignments -- a
   * CROSS-CHECK only (8.6 PR 3b plan §3). The function loads the rows itself,
   * as the caller through RLS, locks every one, and refuses the run when this
   * list disagrees with them in either direction. Every field here is
   * compared (`crossCheckLockedAssignments`); a row without an `id` is itself
   * a mismatch, since nothing can be matched without it.
   */
  lockedAssignments: z
    .array(
      z.object({
        id: z.string().nullable().optional(),
        teamId: z.string(),
        // A stored row may have no slot; it is still locked and still compared.
        slotId: z.string().nullable(),
        effectiveDateRange: z.string().nullable().optional(),
        assignedVia: z.string().nullable().optional(),
      })
    )
    .optional()
    .default([]),
  scoringWeights: z.record(z.string(), z.number()).optional().default({}),
  /**
   * `schoolDayEnd` used to be declared here. `index.ts` has no code for
   * it, so it was a field sent and ignored (#51). Removed rather than
   * implemented, by operator ruling: the club requests school fields only
   * outside school hours, so the permit windows behind the practice slots
   * already encode them. This solver does not check that. The field's only
   * reader on the live path is core `evaluatePracticeSchedule`, reached via
   * `buildPracticeRunResults` on Apply, which reports school-hour warnings
   * after the fact; it enforces nothing.
   *
   * `timezone` used to live here, and `index.ts` contained **zero occurrences
   * of the string** while composing every practice instant with `new Date()`
   * on a naive value -- a field sent and ignored, on the persistence path for
   * every practice in the season (LIVE-7).
   *
   * Removed rather than honoured from the body. The season's clock is
   * `season_settings.timezone`, and `index.ts` now reads it there via
   * `_shared/timing/seasonSettings.ts`. Accepting it here as well would be a
   * second answer to the same question, which is exactly the drift the
   * `20260913000000` migration refuses when it declines a read-time
   * `contact_info->>'timezone'` fallback.
   *
   * Neither field is listed at all, and this object is not `.passthrough()`,
   * so an older client that still sends either is not rejected -- Zod strips it.
   */
  config: z
    .object({
      timeBudgetMs: z
        .number()
        .int()
        .min(1000)
        .max(25000)
        .optional()
        .default(CONFIG_DEFAULTS.timeBudgetMs),
      maxIterations: z
        .number()
        .int()
        .min(10)
        .max(5000)
        .optional()
        .default(CONFIG_DEFAULTS.maxIterations),
      seed: z.number().int().optional().default(CONFIG_DEFAULTS.seed),
    })
    .optional()
    // The whole object rather than `{}`: the same parsed value, one source for
    // each default, and a literal both the Deno zod (3.x) and the Node zod the
    // Vitest witnesses type-check against accept as the output type.
    .default({ ...CONFIG_DEFAULTS }),
});
