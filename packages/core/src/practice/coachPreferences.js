/**
 * Practice preference RULES: what one team's rules mean for one candidate practice
 * (Phase D, C1; plans `docs/changes/2026-10-26-coach-preference-rules.md`, "Revised
 * 2026-10-27", and `docs/changes/2026-10-27-phase-d-scheduling.md`, section C).
 *
 * The store is `public.coach_practice_preferences` (migration `20261112010000`): a row is
 * one rule for one team, asked by one of the team's coaches. Only an admin writes it (an
 * import, or in the app), and only an admin makes a rule a `must`: a requested must is in
 * force as `prefer` until an admin accepts it, so every `level` this module is handed is
 * the level IN FORCE. Rows that are not in force (removed, replaced) are not passed in.
 *
 * ## The rules
 *
 * **A rule has up to three conditions**: `weekdays`, `startMinutes` and `venueIds`, each a
 * set of values meaning "any of", or "keep the current one" (`keepWeekday`, `keepStart`,
 * `keepVenue`). The conditions of one rule must all hold: "Tuesday at 5:00" is one rule
 * with two conditions; {Tue, Thu} is met by a Tuesday or a Thursday practice. A team that
 * practises twice a week on different days therefore lands on Tuesday and Thursday.
 *
 * **Keep-current** is met by any value the team's live practices hold (`current`: the
 * placements of its rows). With none it does nothing, and a
 * `PRACTICE_COACH_PREFERENCE_NO_REFERENCE` finding names the rule and the dimension.
 *
 * **Which rules apply** to a team on a day: the rule is for that team, its coach is one of
 * the team's CURRENT coaches (`coachIds`, the roster and not the rule rows), and the day is
 * inside the rule's window (`effectiveFrom` / `effectiveTo`, either may be open). The day is
 * the one a practice starts being judged on: the run date for the auto-scheduler, the first
 * day of a displaced series' window for a repair. A rule with a window and no day to judge
 * it on is refused, never read as always in window.
 *
 * **Every rule that applies is judged** against each candidate: a `must` is a filter
 * (`mustKeepViolated` when any unmet), a `prefer` costs one breach per unmet rule
 * (`preferKeepBreaches`, the soft term the objective prices). Nothing supersedes anything:
 * two rules from two coaches, or two rules from one, both count. `coachPriority` is for
 * visibility only; it changes nothing here.
 *
 * **Conflicts** are found before they bite: rules of one level whose explicit sets for one
 * dimension have no value in common (two `must` rules, {Tue} and {Thu}) leave no practice
 * that meets them all, and a `PRACTICE_COACH_PREFERENCE_CONFLICT` finding names the
 * dimension, the level and the rules. A conflict among `must` rules makes every candidate
 * violate them, so the team is TIME TBD naming those rules, never silently dropped; among
 * `prefer` rules it only costs breaches.
 *
 * **No rules, no effect.** With none that apply, nothing is filtered and every verdict is
 * zero breaches.
 *
 * ## Declared, not enforced
 *
 * Its callers are `practice/repair.js` (`must` filters candidates, with
 * `PRACTICE_TBD_REASON.COACH_PREFERENCE` when it empties a series' venue, naming the rules;
 * `prefer` is priced as `coachPreferenceBreached`) and, through its Deno twin
 * `supabase/functions/_shared/engines/coach-preferences.ts`, the auto-scheduler Edge
 * Function. `tests/coachPreferenceDrift.test.js` holds the twin to this module over the
 * full enumerated product; change a rule here and that test fails until the twin follows.
 */

import { z } from 'zod';

import { IdSchema, IsoDateSchema } from '../availability/schemas.js';
import { PRACTICE_REASON, makePracticeFinding } from './reasonCodes.js';
import { PracticeWeekdaySchema } from './schemas.js';

/** The three things a rule can ask about. */
export const COACH_PREFERENCE_DIMENSION = Object.freeze({
  WEEKDAY: 'weekday',
  START_TIME: 'start_time',
  VENUE: 'venue',
});

/** The level IN FORCE. The DB's `level` CHECK, exactly. */
export const COACH_PREFERENCE_LEVEL = Object.freeze({
  MUST: 'must',
  PREFER: 'prefer',
});

/** The coach's own ranking of a rule, for visibility only. The DB's `coach_priority` CHECK. */
export const COACH_PREFERENCE_PRIORITY = Object.freeze(['high', 'medium', 'low']);

const DIMENSIONS = Object.freeze(Object.values(COACH_PREFERENCE_DIMENSION));
const LEVELS = Object.freeze(Object.values(COACH_PREFERENCE_LEVEL));

/** The key a dimension is read from, on a placement. */
const PLACEMENT_KEY = Object.freeze({
  weekday: 'weekday',
  start_time: 'startMinutes',
  venue: 'locationId',
});

/** A lowercase canonical uuid: the venue arm of the DB. */
const LocationIdSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    'a location id is a lowercase canonical uuid'
  );

/** Minutes past local midnight: the DB CHECK's range, exactly. */
const StartMinutesSchema = z.number().int().min(0).max(1439);

export const CoachPreferenceDimensionSchema = z.enum(DIMENSIONS);
export const CoachPreferenceLevelSchema = z.enum(LEVELS);

/** A set condition as the DB holds it: NULL (absent) or a non-empty array of distinct values. */
const setOf = (schema) =>
  z
    .array(schema)
    .min(1, 'a condition holds at least one value')
    .refine((values) => new Set(values).size === values.length, 'a condition holds no duplicate')
    .nullable()
    .default(null);

/**
 * One rule, in force, for one team: what an admin imported or entered. **Strict**: an unknown
 * key (a `note`, a `reason`, the old `dimension` / `value`) is refused, because the store
 * holds no free text and neither does this.
 */
export const CoachPreferenceRuleSchema = z
  .strictObject({
    /** The rule's id (a uuid in the store): what a finding and a TIME TBD reason name. */
    id: IdSchema,
    /** The coach who asked; the rule applies while this coach is one of the team's coaches. */
    coachId: IdSchema,
    teamId: IdSchema,
    level: CoachPreferenceLevelSchema,
    weekdays: setOf(PracticeWeekdaySchema),
    startMinutes: setOf(StartMinutesSchema),
    venueIds: setOf(LocationIdSchema),
    keepWeekday: z.boolean().default(false),
    keepStart: z.boolean().default(false),
    keepVenue: z.boolean().default(false),
    coachPriority: z.enum(COACH_PREFERENCE_PRIORITY).nullable().default(null),
    effectiveFrom: IsoDateSchema.nullable().default(null),
    effectiveTo: IsoDateSchema.nullable().default(null),
  })
  .superRefine((rule, ctx) => {
    for (const [values, keep, name] of [
      [rule.weekdays, rule.keepWeekday, 'weekday'],
      [rule.startMinutes, rule.keepStart, 'start'],
      [rule.venueIds, rule.keepVenue, 'venue'],
    ]) {
      if (values !== null && keep) {
        ctx.addIssue({
          code: 'custom',
          path: [name],
          message: `a rule holds either values or keep-current for the ${name}, not both`,
        });
      }
    }
    const conditions =
      (rule.weekdays !== null || rule.keepWeekday) +
      (rule.startMinutes !== null || rule.keepStart) +
      (rule.venueIds !== null || rule.keepVenue);
    if (conditions === 0) {
      ctx.addIssue({ code: 'custom', message: 'a rule has at least one condition' });
    }
    if (
      rule.effectiveFrom !== null &&
      rule.effectiveTo !== null &&
      rule.effectiveTo < rule.effectiveFrom
    ) {
      ctx.addIssue({ code: 'custom', path: ['effectiveTo'], message: 'the window ends before it starts' });
    }
  });

/** A practice as this module reads it: one of the team's live practices, or a candidate. */
export const CoachPreferencePlacementSchema = z.object({
  weekday: PracticeWeekdaySchema,
  startMinutes: StartMinutesSchema,
  locationId: LocationIdSchema,
});

/**
 * One team: its CURRENT coaches (the roster, not the rule rows), every rule offered (those of
 * other teams, of coaches who are not on the team, and out of window on `date` are ignored), the
 * placements its live practices hold (for keep-current), and the day judged.
 */
export const CoachPreferenceInputSchema = z
  .strictObject({
    teamId: IdSchema,
    coachIds: z.array(IdSchema),
    rules: z.array(CoachPreferenceRuleSchema),
    current: z.array(CoachPreferencePlacementSchema).default([]),
    date: IsoDateSchema.nullable().default(null),
  })
  .superRefine((input, ctx) => {
    const seen = new Set();
    input.rules.forEach((rule, index) => {
      if (seen.has(rule.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['rules', index, 'id'],
          message: `a second rule with id ${rule.id}; a rule is named by its id`,
        });
      }
      seen.add(rule.id);
    });
  });

/** Whether a rule's window holds `date`. A bounded rule with no date to judge is refused. */
export function ruleInWindow(rule, date) {
  if (rule.effectiveFrom === null && rule.effectiveTo === null) return true;
  if (date === null || date === undefined) {
    throw new RangeError(
      `rule ${rule.id} has a date window and no day was given to judge it on`
    );
  }
  if (rule.effectiveFrom !== null && date < rule.effectiveFrom) return false;
  if (rule.effectiveTo !== null && date > rule.effectiveTo) return false;
  return true;
}

/** The (dimension, set, keep) triples of a rule, in dimension order. */
function conditionsOf(rule) {
  return [
    { dimension: 'weekday', values: rule.weekdays, keep: rule.keepWeekday },
    { dimension: 'start_time', values: rule.startMinutes, keep: rule.keepStart },
    { dimension: 'venue', values: rule.venueIds, keep: rule.keepVenue },
  ].filter((condition) => condition.values !== null || condition.keep);
}

/**
 * Resolve one team's rules into the conditions each rule asks of a practice.
 *
 * The rules that apply are enumerated from the rules offered (never from what a verdict
 * would find), in the order given. A rule whose every condition has nothing to keep is kept
 * in the result with no conditions, so the finding and the rule both stay visible.
 *
 * @param {unknown} input - see {@link CoachPreferenceInputSchema}
 */
export function resolveCoachPreferences(input) {
  const { teamId, coachIds, rules, current, date } = CoachPreferenceInputSchema.parse(input);
  const onTeam = new Set(coachIds);
  const findings = [];

  const resolved = [];
  for (const rule of rules) {
    if (rule.teamId !== teamId || !onTeam.has(rule.coachId) || !ruleInWindow(rule, date)) continue;
    const conditions = [];
    for (const { dimension, values, keep } of conditionsOf(rule)) {
      if (values !== null) {
        conditions.push({ dimension, source: 'values', allowed: [...values] });
        continue;
      }
      // keep-current: any value the team's live practices hold.
      const held = [...new Set(current.map((placement) => placement[PLACEMENT_KEY[dimension]]))];
      if (held.length === 0) {
        findings.push(
          makePracticeFinding(
            PRACTICE_REASON.COACH_PREFERENCE_NO_REFERENCE,
            `rule ${rule.id} (coach ${rule.coachId}) keeps the current ${dimension}, but the team has no live practice to keep it from, so it does nothing`,
            { ruleId: rule.id, coachId: rule.coachId, dimension, level: rule.level }
          )
        );
        continue;
      }
      conditions.push({ dimension, source: 'current', allowed: held });
    }
    resolved.push({
      id: rule.id,
      coachId: rule.coachId,
      level: rule.level,
      coachPriority: rule.coachPriority,
      conditions: Object.freeze(conditions.map((condition) => Object.freeze(condition))),
    });
  }

  // Conflicts: rules of one level whose sets for one dimension share no value.
  for (const level of LEVELS) {
    for (const dimension of DIMENSIONS) {
      const holders = resolved.filter((rule) => rule.level === level).flatMap((rule) =>
        rule.conditions
          .filter((condition) => condition.dimension === dimension)
          .map((condition) => ({ rule, condition }))
      );
      if (holders.length < 2) continue;
      const common = holders
        .map(({ condition }) => condition.allowed)
        .reduce((left, right) => left.filter((value) => right.includes(value)));
      if (common.length === 0) {
        findings.push(
          makePracticeFinding(
            PRACTICE_REASON.COACH_PREFERENCE_CONFLICT,
            `the team's ${level} rules ask for ${dimension} values with nothing in common, so no practice can meet them all`,
            {
              dimension,
              level,
              ruleIds: holders.map(({ rule }) => rule.id),
              coachIds: [...new Set(holders.map(({ rule }) => rule.coachId))],
            }
          )
        );
      }
    }
  }

  return Object.freeze({
    rules: Object.freeze(resolved.map((rule) => Object.freeze(rule))),
    findings: Object.freeze(findings),
  });
}

/** True when a resolution constrains nothing: no rule has a condition left. */
export function isInertResolution(resolution) {
  return resolution.rules.every((rule) => rule.conditions.length === 0);
}

/**
 * Judge one candidate practice against a resolution: every rule that applies is judged, a
 * `must` that is unmet violates, a `prefer` that is unmet is one breach.
 *
 * @param {ReturnType<typeof resolveCoachPreferences>} resolution
 * @param {unknown} candidate - see {@link CoachPreferencePlacementSchema}
 */
export function judgeCoachPreferenceCandidate(resolution, candidate) {
  const placement = CoachPreferencePlacementSchema.parse(candidate);
  const violatedRules = [];
  const breachedRules = [];
  const violatedDimensions = new Set();
  const breachedDimensions = new Set();
  for (const rule of resolution.rules) {
    const unmet = rule.conditions.filter(
      (condition) => !condition.allowed.includes(placement[PLACEMENT_KEY[condition.dimension]])
    );
    if (unmet.length === 0) continue;
    if (rule.level === COACH_PREFERENCE_LEVEL.MUST) {
      violatedRules.push(rule.id);
      for (const condition of unmet) violatedDimensions.add(condition.dimension);
    } else {
      breachedRules.push(rule.id);
      for (const condition of unmet) breachedDimensions.add(condition.dimension);
    }
  }
  return Object.freeze({
    mustKeepViolated: violatedRules.length > 0,
    preferKeepBreaches: breachedRules.length,
    violatedRules: Object.freeze(violatedRules),
    breachedRules: Object.freeze(breachedRules),
    violatedDimensions: Object.freeze(DIMENSIONS.filter((d) => violatedDimensions.has(d))),
    breachedDimensions: Object.freeze(DIMENSIONS.filter((d) => breachedDimensions.has(d))),
  });
}
