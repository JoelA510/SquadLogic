/**
 * Zod schemas for scenarios, overrides and the relocation policy.
 *
 * `.strict()` throughout, matching every module since Phase 1.
 *
 * The refinements that carry the design are on {@link ScenarioOverrideSchema}:
 * an override must carry exactly the fields its `kind` uses, and nothing else.
 * A `remove` that also carries a record, or an `add` that also names a record
 * id, is two edits wearing one row — and the whole reason this module has no
 * precedence ladder is that one override touches one record.
 *
 * `createdAt` and `at` are **inputs with no defaults**. Nothing in this package
 * reads a clock: `new Date()` is banned here, exactly as it is in
 * `publication/`, and for the same reason — a self-stamped record carries a
 * field that reads as an audit trail and is not one.
 *
 * @module scenario/schemas
 */

import { z } from 'zod';

import { CONSTRAINT_TYPE } from '../constraints/reasonCodes.js';

import { SCENARIO_OVERRIDE_KIND, SCENARIO_RECORD_SET } from './reasonCodes.js';

/** Inclusive ISO calendar date, `YYYY-MM-DD`. No `Date` construction anywhere. */
const IsoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'expected an ISO YYYY-MM-DD date' });

/** A naive local timestamp, `YYYY-MM-DDTHH:MM:SS`. Supplied, never read from a clock. */
const NaiveDateTimeSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/, {
  message: 'expected a naive YYYY-MM-DDTHH:MM:SS timestamp, supplied by the caller',
});

/** A non-empty opaque identifier. */
const IdSchema = z.string().min(1, { message: 'ids must be non-empty strings' });

/** Minutes past local midnight. */
const MinutesSchema = z.number().int().min(0);

/** One edit a scenario states. */
export const ScenarioOverrideSchema = z
  .object({
    kind: z.enum(Object.values(SCENARIO_OVERRIDE_KIND)),
    recordSet: z.enum(Object.values(SCENARIO_RECORD_SET)).nullable().default(null),
    record: z.record(z.string(), z.unknown()).nullable().default(null),
    recordId: IdSchema.nullable().default(null),
    type: z.enum(Object.values(CONSTRAINT_TYPE)).nullable().default(null),
    weight: z.number().nullable().default(null),
    venueId: IdSchema.nullable().default(null),
    dates: z.array(IsoDateSchema).min(1).nullable().default(null),
    by: z.string().min(1, {
      message:
        'an override must say who asked for it; a branch nobody owns is a branch nobody can question',
    }),
    at: NaiveDateTimeSchema.nullable().default(null),
    reason: z.string().min(1, {
      message:
        'an override must say why; "the venue is gone" and "the venue might be gone" produce the same records and different decisions',
    }),
  })
  .strict()
  .superRefine((override, ctx) => {
    const needsSet = override.kind !== SCENARIO_OVERRIDE_KIND.VENUE_UNAVAILABLE;
    if (needsSet && override.recordSet === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['recordSet'],
        message: `a "${override.kind}" override must name the record set it edits`,
      });
    }
    if (!needsSet && override.recordSet !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['recordSet'],
        message:
          'a venue-unavailable override names a venue, not a record set; the materialiser decides which rows that becomes',
      });
    }

    if (override.kind === SCENARIO_OVERRIDE_KIND.ADD) {
      if (override.record === null) {
        ctx.addIssue({
          code: 'custom',
          path: ['record'],
          message: 'an add override must carry a record',
        });
      } else if (typeof override.record.id !== 'string' || override.record.id.length === 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['record', 'id'],
          message:
            'an added record must carry its own id: overrides are set operations keyed by id, and a record with none could never be removed by a later branch',
        });
      }
      if (override.recordId !== null) {
        ctx.addIssue({
          code: 'custom',
          path: ['recordId'],
          message: 'an add override names no existing record; drop recordId or state a remove',
        });
      }
    } else if (override.record !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['record'],
        message: `a "${override.kind}" override carries no record`,
      });
    }

    if (
      override.kind === SCENARIO_OVERRIDE_KIND.REMOVE ||
      override.kind === SCENARIO_OVERRIDE_KIND.RETYPE
    ) {
      if (override.recordId === null) {
        ctx.addIssue({
          code: 'custom',
          path: ['recordId'],
          message: `a "${override.kind}" override must name the record it edits, by id`,
        });
      }
    }

    if (override.kind === SCENARIO_OVERRIDE_KIND.RETYPE) {
      if (override.recordSet !== SCENARIO_RECORD_SET.CONSTRAINTS) {
        ctx.addIssue({
          code: 'custom',
          path: ['recordSet'],
          message:
            'only a constraint has a hardness to retype; retypeConstraint() is the one place a type change is written, and this override delegates to it',
        });
      }
      if (override.type === null) {
        ctx.addIssue({
          code: 'custom',
          path: ['type'],
          message: 'a retype override must name the new type',
        });
      }
      if (override.type !== CONSTRAINT_TYPE.HARD && override.weight === null) {
        ctx.addIssue({
          code: 'custom',
          path: ['weight'],
          message: `retyping to "${override.type}" needs a weight; retypeConstraint() refuses rather than inventing a magnitude nobody chose`,
        });
      }
    } else if (override.type !== null || override.weight !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['type'],
        message: `a "${override.kind}" override changes no hardness`,
      });
    }

    if (override.kind === SCENARIO_OVERRIDE_KIND.VENUE_UNAVAILABLE) {
      if (override.venueId === null) {
        ctx.addIssue({
          code: 'custom',
          path: ['venueId'],
          message: 'a venue-unavailable override must name the venue',
        });
      }
    } else if (override.venueId !== null || override.dates !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['venueId'],
        message: `a "${override.kind}" override names no venue and no dates`,
      });
    }
  });

/** A branch of a baseline. */
export const ScheduleScenarioSchema = z
  .object({
    id: IdSchema,
    name: z.string().min(1),
    baselineId: IdSchema,
    parentScenarioId: IdSchema.nullable().default(null),
    overrides: z.array(ScenarioOverrideSchema).min(1, {
      message:
        'a scenario that overrides nothing is the baseline under a second name; every question asked of it would be answered by the baseline and the answer would read as a finding about the branch',
    }),
    rationale: z.string().min(1, {
      message:
        'a scenario must say what question it exists to answer; the source project kept five parallel pipelines and no record of why any of them existed',
    }),
    requestedBy: z.string().min(1),
    createdAt: NaiveDateTimeSchema.nullable().default(null),
  })
  .strict()
  .refine((scenario) => scenario.parentScenarioId !== scenario.id, {
    message: 'a scenario cannot branch from itself',
    path: ['parentScenarioId'],
  });

/**
 * How the proposer searches, and where.
 *
 * `surfaceIds` has **no default on purpose**, exactly as
 * `ReserveCapacityInputSchema.earliestKickoffMinutes` has none: which ground the
 * club would actually move a game onto is a stated policy, and a silent "every
 * size-eligible surface in the graph" would put a 7v7 game on the 11v11 stadium
 * and call it a finding. `replacementSurfacesFor()` is the documented way to
 * derive the list; the adapter states it with its provenance attached.
 */
export const RelocationPolicySchema = z
  .object({
    // No `policy` field (#53): the proposer has one ordering,
    // `RELOCATION_RANKING`, and a field choosing between orderings would be
    // parsed and unread. `.strict()` refuses a caller still sending one rather
    // than letting it believe it chose.
    surfaceIds: z.array(IdSchema).min(1, {
      message:
        'a relocation policy that names no candidate ground can only ever report "nowhere to go", which is a fact about the policy rather than about the season',
    }),
    cadenceMinutes: z.number().int().min(1),
    earliestKickoffMinutes: MinutesSchema,
    latestKickoffMinutes: MinutesSchema.default(24 * 60),
    /**
     * May a replacement move the game to another date?
     *
     * `false`, with no way to set it true in this prompt. Families have the
     * date; a scenario that silently moved a fixture to the following Saturday
     * would be answering a question nobody asked. Kept as a stated field rather
     * than an unstated assumption so the limit is visible in the record.
     */
    allowDateChange: z.literal(false).default(false),
    source: z.string().min(1),
  })
  .strict();

export {
  IsoDateSchema as ScenarioIsoDateSchema,
  NaiveDateTimeSchema as ScenarioNaiveDateTimeSchema,
};
