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

const CoachPreferenceSchema = z
  .object({
    preferredDays: z.array(z.string()).optional(),
    preferredSlotIds: z.array(z.string()).optional(),
    unavailableSlotIds: z.array(z.string()).optional(),
  })
  .passthrough();

export const AutoSchedulerInputSchema = z.object({
  organizationId: z.string().uuid(),
  seasonSettingsId: z.string().uuid().optional(),
  teams: z.array(TeamSchema).min(1),
  slots: z.array(SlotSchema).min(1),
  coachPreferences: z.record(z.string(), CoachPreferenceSchema).optional().default({}),
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
  lockedAssignments: z
    .array(
      z.object({
        teamId: z.string(),
        slotId: z.string(),
      })
    )
    .optional()
    .default([]),
  scoringWeights: z.record(z.string(), z.number()).optional().default({}),
  /**
   * `schoolDayEnd` used to be declared here and was never enforced: `index.ts`
   * has no code for it, so it was a field sent and ignored (#51). Removed
   * rather than implemented -- permit windows already exclude school hours.
   * Core still honours it where it is read (`practiceScheduling.js`,
   * `practiceMetrics.js`). As with `timezone` below, an older client that
   * still sends it is not rejected: this object is not `.passthrough()`, so
   * Zod strips it.
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
   * The field is not listed at all, and this object is not `.passthrough()`,
   * so an older client that still sends it is not rejected -- Zod strips it.
   */
  config: z
    .object({
      timeBudgetMs: z.number().int().min(1000).max(25000).optional().default(25000),
      maxIterations: z.number().int().min(10).max(5000).optional().default(2000),
      seed: z.number().int().optional().default(42),
    })
    .optional()
    .default({}),
});
