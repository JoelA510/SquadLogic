/**
 * The strict Edge twin of core `PracticeEnactRecordSchema`
 * (`packages/core/src/practice/enact.js`), the `practice.recommendation_enacted`
 * audit metadata of docs/PHASE_8_6_PR11_ENACT_PLAN.md §5 (8.6 3b PR 11b): a
 * union of one arm per `cause.kind`, the retirement arm and (3b PR 11d-2,
 * docs/PHASE_8_6_PR11D_BLACKOUT_ENACT_PLAN.md §2.3) the blackout arm.
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
  // `field_blackouts.reason`'s CHECK (20260906000100): the enum, never the note.
  const BlackoutReason = z.enum(['maintenance', 'weather', 'event', 'permit', 'closed', 'other']);
  // Minutes both or neither, ordered when present; exactly one scope column.
  const MINUTES_PAIRED = {
    message: 'start_minutes and end_minutes are both set, with end after start, or both null',
  };
  const minutesPaired = (value: { start_minutes: number | null; end_minutes: number | null }) =>
    value.start_minutes === null
      ? value.end_minutes === null
      : value.end_minutes !== null && value.end_minutes > value.start_minutes;
  const ONE_SCOPE = { message: 'exactly one of field_id and location_id is set' };
  const oneScope = (value: { field_id: string | null; location_id: string | null }) =>
    (value.field_id === null) !== (value.location_id === null);

  // The keys both arms share, unchanged from the retirement-only record (3b PR 11b).
  const common = {
    schema_version: z.literal(1),
    enact_key: Uuid,
    run_id: Uuid,
    season_settings_id: Uuid,
    series: z
      .object({
        assignment_id: Uuid,
        team_id: Uuid,
        from: Shape,
        window: z.object({ from: IsoDate, until: IsoDate }).strict(),
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
  };

  // `rehome` is retirement-only, `relocate` blackout-only (plan §2.3).
  const decisionOf = (kinds: readonly [string, ...string[]]) =>
    z
      .object({
        kind: z.enum(kinds as [string, ...string[]]),
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
      .strict();

  const retirement = z
    .object({
      ...common,
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
      decision: decisionOf(['rehome', 'time_tbd']),
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
    })
    .strict();

  // 3b PR 11d-2: ONE exception on S over its window; nothing unlocked,
  // closed or created; `cause.stored` is the row the wrapper's gate read.
  const blackout = z
    .object({
      ...common,
      cause: z
        .object({
          kind: z.literal('blackout'),
          id: Uuid,
          loss: z
            .object({
              from: IsoDate,
              until: IsoDate,
              surface_ids: z.array(Uuid).min(1),
              start_minutes: Minutes.nullable(),
              end_minutes: Minutes.nullable(),
              reason: BlackoutReason,
            })
            .strict()
            .refine(minutesPaired, MINUTES_PAIRED),
          stored: z
            .object({
              field_id: Uuid.nullable(),
              location_id: Uuid.nullable(),
              blackout_from: IsoDate,
              blackout_until: IsoDate,
              start_minutes: Minutes.nullable(),
              end_minutes: Minutes.nullable(),
              reason: BlackoutReason,
            })
            .strict()
            .refine(minutesPaired, MINUTES_PAIRED)
            .refine(oneScope, ONE_SCOPE),
        })
        .strict(),
      decision: decisionOf(['relocate', 'time_tbd']),
      prompt: z
        .object({
          rows: z
            .array(
              z
                .object({
                  assignment_id: Uuid,
                  assigned_via: z.enum(['auto', 'manual', 'repair', 'recommendation', 'override']),
                  effect: z.enum(['temporarily moved', 'temporarily TIME TBD']),
                  range_after: z.null(),
                  window: Range,
                })
                .strict()
            )
            .length(1),
          published_practices_affected: z.number().int().nonnegative(),
          accepted: z.literal(true),
        })
        .strict(),
      unlock: z.array(z.never()),
      writes: z
        .object({
          closes: z.array(z.never()),
          new_rows: z.array(z.never()),
          exceptions: z.literal(1),
        })
        .strict(),
    })
    .strict();

  // One arm per `cause.kind`, the same top-level keys in both.
  return z.union([retirement, blackout]);
}
