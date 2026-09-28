/**
 * Zod schemas for people, coach assignments, commitments and declared personal
 * constraints.
 *
 * `.strict()` throughout, matching `facility/schemas.js`, `timing/schemas.js`,
 * `availability/schemas.js`, `constraints/schemas.js` and `waivers/schemas.js`,
 * and deliberately unlike `packages/core/src/schemas/index.js`, whose blanket
 * `.passthrough()` is what let four copies of the slot model drift apart
 * without anything failing (`docs/ARCHITECTURE.md` §1.1).
 *
 * Two refinements carry most of the meaning:
 *
 * - a commitment must name its {@link PersonCommitmentSchema `source`}; there
 *   is no default, because a defaulted source is a timeline that cannot tell
 *   "we ingested the scrimmages" from "we assumed there were none" — incident
 *   5 in one field;
 * - a commitment whose end precedes its start is rejected outright rather than
 *   carried, since every gap measured across it would be nonsense.
 *
 * @module people/schemas
 */

import { z } from 'zod';

import { TEAM_COACH_ROLE } from './assignmentChange.js';
import { ASSIGNMENT_STATUS, COMMITMENT_SOURCE, PERSONAL_CONSTRAINT_KIND } from './reasonCodes.js';

/** Inclusive ISO calendar date, `YYYY-MM-DD`. No `Date` construction anywhere. */
const IsoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'expected an ISO YYYY-MM-DD date' });

/** A non-empty opaque identifier. */
const IdSchema = z.string().min(1, { message: 'ids must be non-empty strings' });

/** Minutes past midnight. */
const MinutesSchema = z.number().int().min(0);

/**
 * A person the club knows about (GAP-22).
 *
 * No email, no auth id, no organization id: a coach who exists on a roster and
 * has never logged in is a first-class citizen here, and `CLAUDE.md`'s
 * data-minimisation rule means the model must not require a field the club has
 * no reason to hold.
 *
 * `aliases` exists because identity resolution *proposes* rather than merges —
 * when a human accepts a proposal the surviving id records what the merged one
 * was called, so the link that incident 6 hid stays visible afterwards.
 *
 * @see {@link import('./types.js').Person}
 */
export const PersonSchema = z
  .object({
    id: IdSchema,
    givenName: z.string().min(1),
    familyName: z.string().min(1),
    displayName: z.string().min(1),
    aliases: z.array(z.string().min(1)).default([]),
  })
  .strict();

/**
 * One person's appointment to one team (GAP-20, GAP-23).
 *
 * `slot` has a minimum of 1 because the order starts at 1 and a slot 0 would
 * silently outrank the first coach the club declared. It is an *order*, not a
 * role: `people/coachList.js` keeps it as the clash-breaker `roster.js` defends
 * and no artifact renders it as head-versus-assistant (8.2). `status` is required with a default of `assigned`
 * — the corpus's only value — rather than optional, so a producer that means
 * "declined" has to say so.
 *
 * `effectiveFrom`/`effectiveTo` are the assignment's window, and they are
 * *applied*: `buildCoachRoster()` takes an `asOf` date and an assignment whose
 * window does not cover it is inactive, so a departed coach stops counting as
 * fallback capacity everywhere the roster is read. The ordering refinement
 * below mirrors {@link PersonalConstraintSchema}'s, because a window that
 * closes before it opens governs nothing and every question asked across it
 * would be nonsense.
 *
 * @see {@link import('./types.js').CoachAssignment}
 */
export const CoachAssignmentSchema = z
  .object({
    id: IdSchema,
    personId: IdSchema,
    teamId: IdSchema,
    slot: z.number().int().min(1),
    status: z
      .enum(/** @type {[string, ...string[]]} */ (Object.values(ASSIGNMENT_STATUS)))
      .default(ASSIGNMENT_STATUS.ASSIGNED),
    effectiveFrom: IsoDateSchema.nullable().default(null),
    effectiveTo: IsoDateSchema.nullable().default(null),
    source: z.string().min(1).nullable().default(null),
  })
  .strict()
  .refine(
    (value) =>
      value.effectiveFrom === null ||
      value.effectiveTo === null ||
      value.effectiveTo >= value.effectiveFrom,
    {
      message: 'an assignment may not end before it takes effect',
      path: ['effectiveTo'],
    }
  );

/**
 * One commitment on one person's day.
 *
 * @see {@link import('./types.js').PersonCommitment}
 */
export const PersonCommitmentSchema = z
  .object({
    id: IdSchema,
    personId: IdSchema,
    date: IsoDateSchema,
    startMinutes: MinutesSchema,
    endMinutes: MinutesSchema.nullable().default(null),
    venueId: IdSchema,
    surfaceId: IdSchema.nullable().default(null),
    teamId: IdSchema.nullable().default(null),
    gameId: IdSchema.nullable().default(null),
    label: z.string().min(1).nullable().default(null),
    source: z.enum(/** @type {[string, ...string[]]} */ (Object.values(COMMITMENT_SOURCE))),
  })
  .strict()
  .refine((value) => value.endMinutes === null || value.endMinutes >= value.startMinutes, {
    message: 'a commitment may not end before it starts',
    path: ['endMinutes'],
  });

/**
 * A declared personal constraint — the single-car family, written down.
 *
 * `rationale` and `source.setBy` are **required**. Incident 9 is what a rule
 * that lived in a code comment costs, and a must-attend flag with no recorded
 * reason is the same object: something an operator will one day be unable to
 * justify or retire.
 *
 * @see {@link import('./types.js').PersonalConstraint}
 */
export const PersonalConstraintSchema = z
  .object({
    id: IdSchema,
    personId: IdSchema,
    kind: z.enum(/** @type {[string, ...string[]]} */ (Object.values(PERSONAL_CONSTRAINT_KIND))),
    teamIds: z.array(IdSchema).min(1).nullable().default(null),
    fromDate: IsoDateSchema.nullable().default(null),
    toDate: IsoDateSchema.nullable().default(null),
    rationale: z.string().min(1),
    source: z
      .object({
        setBy: z.string().min(1),
        setAt: IsoDateSchema.nullable().default(null),
        reference: z.string().min(1).nullable().default(null),
        note: z.string().min(1).nullable().default(null),
      })
      .strict(),
  })
  .strict()
  .refine(
    (value) => value.fromDate === null || value.toDate === null || value.toDate >= value.fromDate,
    {
      message: 'a personal constraint may not expire before it takes effect',
      path: ['toDate'],
    }
  );

/** Plain input accepted by `buildPersonalConstraintPolicy()`. */
export const PersonalConstraintPolicyInputSchema = z
  .object({
    constraints: z.array(PersonalConstraintSchema).default([]),
  })
  .strict();

/** Plain input accepted by `buildCoachRoster()`. */
export const CoachRosterInputSchema = z
  .object({
    people: z.array(PersonSchema).default([]),
    assignments: z.array(CoachAssignmentSchema).default([]),
  })
  .strict();

/**
 * One coach as one source states them, for `reconcileTeamCoaches()`.
 *
 * `slot` is nullable here and non-null on {@link CoachAssignmentSchema},
 * because a source may name a coach without ranking them at all — the frontend
 * team row is exactly that — and the reconciliation reports the missing rank
 * rather than inventing one. Where a slot *is* given it carries the same
 * minimum of 1 as an assignment's, so the two spellings of the order cannot
 * disagree about where it starts.
 *
 * `keyKind` says what `personId` *is*: an id, an email address or a display
 * name. It defaults to `id` because a source built from a people table (the
 * corpus adapters, `roster.js`) keys by person id and says nothing else; the
 * row-shaped producers in `coachList.js` state the kind they fell back to.
 * Only an `id` key is corroborated — see `COACH_KEY_KIND`.
 */
export const CoachListEntrySchema = z
  .object({
    personId: IdSchema,
    keyKind: z.enum(['id', 'email', 'name']).default('id'),
    displayName: z.string().min(1).nullable().default(null),
    email: z.string().min(1).nullable().default(null),
    slot: z.number().int().min(1).nullable().default(null),
  })
  .strict();

/** One source's whole statement about one team's coaches. */
export const CoachListSourceSchema = z
  .object({
    sourceId: z.string().min(1),
    coaches: z.array(CoachListEntrySchema).default([]),
  })
  .strict();

/**
 * Plain input accepted by `reconcileTeamCoaches()`.
 *
 * `sources` has no default: a reconciliation called with no sources at all is a
 * caller bug, not an empty team, and the two must not look alike.
 */
export const CoachListSourcesSchema = z
  .object({
    teamId: IdSchema,
    sources: z.array(CoachListSourceSchema),
  })
  .strict();

/** One human decision on one review-queue entry. */
export const IdentityDecisionSchema = z
  .object({
    entryId: IdSchema,
    /** `accepted` merges; `rejected` closes the entry and merges nothing. */
    state: z.enum(['accepted', 'rejected']),
    decidedBy: z.string().min(1),
    decidedAt: IsoDateSchema.nullable().default(null),
    note: z.string().min(1).nullable().default(null),
  })
  .strict();

/**
 * One `team_coach_assignments` row, as the table stores it (8.8 PR 2) and as
 * `people/assignmentHistory.js` reads it: the typedef `TeamCoachAssignmentRow`
 * in `assignmentChange.js`, made checkable. Dates are inclusive; a null
 * `effective_to` is an open row. Columns the readers do not use are stripped,
 * not carried.
 */
export const TeamCoachAssignmentRowSchema = z.object({
  id: IdSchema.optional(),
  team_id: IdSchema,
  coach_id: IdSchema,
  role: z.enum(Object.values(TEAM_COACH_ROLE)),
  effective_from: IsoDateSchema,
  effective_to: IsoDateSchema.nullable().default(null),
});
