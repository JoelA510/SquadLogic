/**
 * The strict Edge twin of core `PracticeEnactRecordSchema`
 * (`packages/core/src/practice/enact.js`), the `practice.recommendation_enacted`
 * audit metadata of docs/PHASE_8_6_PR11_ENACT_PLAN.md §5 (8.6 3b PR 11b).
 *
 * The Deno side cannot import core, so the schema is written twice. It is a
 * FACTORY over the caller's `z`: `practice-persistence` passes its Deno zod,
 * and `tests/practiceEnactSchemaDrift.test.js` passes npm zod, so the drift
 * test compares the very schema the Edge builds against core's, key for key
 * and enum for enum (witness 22). Only APIs zod 3.22 and zod 4 share.
 *
 * `result_fingerprint` is null on the wire: the wrapper RPC
 * `enact_practice_recommendation` fills it from the writer's return, and
 * refuses a record that already carries one.
 */
// `npm run typecheck` (tsc) cannot resolve a Deno URL import; `deno check` does, so the
// error is tsc's alone, and @ts-expect-error would fail deno check as unused.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import type { z as Zod } from 'https://deno.land/x/zod@v3.22.4/mod.ts';

type ZodNamespace = typeof Zod;

/** core `PRACTICE_CHAIN_STOP` values; the drift test pins them. */
export const PRACTICE_ENACT_CHAIN_STOPS = [
  'no-gain',
  'all-visited',
  'hop-limit',
  'nothing-released',
] as const;

/** core `PRACTICE_ENACT_FINGERPRINT_COVERS`. */
export const PRACTICE_ENACT_FINGERPRINT_COVERS = 'practice_assignments+practice_exceptions';

export function buildPracticeEnactRecordSchema(z: ZodNamespace) {
  const Uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
  const Range = z.string().regex(/^[[(]\d{4}-\d{2}-\d{2},\d{4}-\d{2}-\d{2}[\])]$/);
  const Fingerprint = z.string().regex(/^[0-9a-f]{32}$/);
  const Weekday = z.enum(['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']);
  const Minutes = z.number().int().min(0).max(1440);
  const Shape = z
    .object({
      surface_id: Uuid,
      weekday: Weekday,
      start_minutes: Minutes,
      duration_minutes: z.number().int().positive(),
    })
    .strict();
  const Counts = z.record(z.string().regex(/^[A-Za-z]+$/), z.number().int().nonnegative());
  const UnlockReason = z
    .string()
    .regex(/^enact [0-9a-f-]{36}: retirement of field [0-9a-f-]{36} from \d{4}-\d{2}-\d{2}$/);

  return z
    .object({
      schema_version: z.literal(1),
      enact_key: Uuid,
      run_id: Uuid,
      season_settings_id: Uuid,
      cause: z
        .object({
          kind: z.literal('retirement'),
          id: Uuid,
          loss: z
            .object({
              from: IsoDate,
              until: z.null(),
              surface_ids: z.array(Uuid).min(1),
              start_minutes: z.null(),
              end_minutes: z.null(),
              reason: z.literal('retirement'),
            })
            .strict(),
          stored_effective_to: IsoDate,
        })
        .strict(),
      series: z
        .object({
          assignment_id: Uuid,
          team_id: Uuid,
          from: Shape,
          window: z.object({ from: IsoDate, until: IsoDate }).strict(),
        })
        .strict(),
      decision: z
        .object({
          kind: z.enum(['rehome', 'time_tbd']),
          to: Shape.nullable(),
          tier: z.enum(['same-venue', 'cross-venue']).nullable(),
          origin: z.literal('approved-option').nullable(),
          tbd_reason: z
            .string()
            .regex(/^[a-z-]+$/)
            .nullable(),
          objective: z.object({ total: z.number().nonnegative(), counts: Counts }).strict(),
          coach_overlaps: z.array(Uuid),
          coach_days_worsened: z.number().int().nonnegative(),
        })
        .strict(),
      rejudge: z.object({ stands: z.literal(true), shown_counts: Counts }).strict(),
      declined: z.array(z.object({ assignment_id: Uuid, to: Shape }).strict()),
      chains: z.array(
        z
          .object({
            kind: z.enum(['decline', 'undo', 'release']),
            assignment_id: Uuid,
            hops: z.number().int().nonnegative(),
            stopped_by: z.enum(PRACTICE_ENACT_CHAIN_STOPS),
          })
          .strict()
      ),
      local: z.boolean(),
      enacted_before: z.array(Uuid),
      prompt: z
        .object({
          rows: z.array(
            z
              .object({
                assignment_id: Uuid,
                assigned_via: z.enum(['auto', 'manual', 'repair', 'recommendation', 'override']),
                effect: z.enum(['closed', 'removed and replaced']),
                range_after: Range.nullable(),
              })
              .strict()
          ),
          published_practices_affected: z.number().int().nonnegative(),
          accepted: z.literal(true),
        })
        .strict(),
      unlock: z.array(z.object({ assignment_id: Uuid, reason: UnlockReason }).strict()),
      writes: z
        .object({
          closes: z.array(z.object({ assignment_id: Uuid, last_day: IsoDate }).strict()),
          new_rows: z.array(
            z
              .object({ team_id: Uuid, practice_slot_id: Uuid, effective_date_range: Range })
              .strict()
          ),
          exceptions: z.number().int().nonnegative(),
        })
        .strict(),
      base_fingerprint: Fingerprint,
      result_fingerprint: Fingerprint.nullable(),
      fingerprint_covers: z.literal(PRACTICE_ENACT_FINGERPRINT_COVERS),
      solver: z
        .object({
          strategy: z.enum(['exact', 'greedy']),
          proven_optimal: z.boolean(),
          daylight_supplied: z.boolean(),
          closures_supplied: z.boolean(),
        })
        .strict(),
    })
    .strict();
}
