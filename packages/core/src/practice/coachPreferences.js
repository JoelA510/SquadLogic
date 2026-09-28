/**
 * Coach practice preferences: what one team's preferences mean for one
 * candidate practice (Phase 8.6 PR 3b, PR 1).
 *
 * Plan of record: `docs/PHASE_8_6_PR3B_PLAN.md` §4, operator ruling 3. A coach
 * holds, per dimension (weekday, start time, venue), a level: `must_keep`,
 * `prefer_keep` or `dont_care`, and optionally the value it keeps. The store is
 * `public.coach_practice_preferences` (migration `20260927000000`); coaches
 * request and only admins approve, so every preference this module is handed
 * is an APPROVED one. The schema has no `status` key, so passing raw rows
 * fails loudly instead of mixing requests in.
 *
 * ## The rules
 *
 * **Reference.** A preference keeps something, and the reference is what it
 * keeps. When the team's current series is being moved, the reference is that
 * series' own weekday, start or venue: the coach asked to keep what they have.
 * Otherwise it is the preference's `value`. With neither, the preference does
 * nothing, and a `PRACTICE_COACH_PREFERENCE_NO_REFERENCE` finding says so.
 *
 * **Strictest wins** across the team's current coaches: `must_keep` >
 * `prefer_keep` > `dont_care`. Every coach at the strictest level must be kept,
 * so two `must_keep` references that differ make the dimension `unsatisfiable`
 * and every candidate violates it. Two differing `prefer_keep` references are
 * the soft analogue: every candidate breaches that dimension once, so the term
 * cannot rank candidates on it. That is one rule for both levels, stated here
 * rather than left for the Deno twin (PR 8) to rediscover, and at both levels a
 * `PRACTICE_COACH_PREFERENCE_CONFLICT` finding names the dimension, the level,
 * the coaches and the references, so preferences that cancel each other out are
 * visible to an admin rather than silently inert.
 *
 * **The verdict** on a candidate: `mustKeepViolated` when any `must_keep`
 * dimension is not kept (the hard filter), and `preferKeepBreaches`, one per
 * `prefer_keep` dimension not kept (the soft term PR 4 prices).
 *
 * **No preferences, no effect.** An empty input resolves every dimension to
 * `dont_care`, and every candidate's verdict is zero breaches and no violation.
 * Nothing is filtered.
 *
 * ## Declared, not enforced
 *
 * Its one caller is `practice/repair.js` (8.6 PR 3b, PR 4): `must_keep` is a
 * candidate filter there, with `PRACTICE_TBD_REASON.COACH_PREFERENCE` when it
 * empties a series' venue, and `prefer_keep` is priced by the objective as
 * `coachPreferenceBreached`. The repair itself has no production caller yet
 * (the `practice/` unwired pin), so nothing a family sees honours a preference
 * until PR 9-10 wire it. PR 8 mirrors the rule in the Deno twin.
 */

import { z } from 'zod';

import { IdSchema } from '../availability/schemas.js';
import { PRACTICE_REASON, makePracticeFinding } from './reasonCodes.js';
import { PracticeWeekdaySchema } from './schemas.js';

/** The three things a coach can ask to keep. The DB's `dimension` CHECK, exactly. */
export const COACH_PREFERENCE_DIMENSION = Object.freeze({
  WEEKDAY: 'weekday',
  START_TIME: 'start_time',
  VENUE: 'venue',
});

/** How strongly. The DB's `level` CHECK, exactly. */
export const COACH_PREFERENCE_LEVEL = Object.freeze({
  MUST_KEEP: 'must_keep',
  PREFER_KEEP: 'prefer_keep',
  DONT_CARE: 'dont_care',
});

const DIMENSIONS = Object.freeze(Object.values(COACH_PREFERENCE_DIMENSION));
const LEVELS = Object.freeze(Object.values(COACH_PREFERENCE_LEVEL));

/** Higher is stricter: the one ordering strictest-wins reads. */
const STRICTNESS = Object.freeze({ dont_care: 0, prefer_keep: 1, must_keep: 2 });

/** The key a dimension is read from, on a series and on a candidate. */
const PLACEMENT_KEY = Object.freeze({
  weekday: 'weekday',
  start_time: 'startMinutes',
  venue: 'locationId',
});

/** A lowercase canonical uuid: the DB CHECK's venue arm, exactly. */
const LocationIdSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    'a location id is a lowercase canonical uuid'
  );

/** Minutes past local midnight: the DB CHECK's start_time arm, exactly. */
const StartMinutesSchema = z.number().int().min(0).max(1439);

const VALUE_SCHEMA = Object.freeze({
  weekday: PracticeWeekdaySchema,
  start_time: StartMinutesSchema,
  venue: LocationIdSchema,
});

export const CoachPreferenceDimensionSchema = z.enum(DIMENSIONS);
export const CoachPreferenceLevelSchema = z.enum(LEVELS);

/**
 * One coach's preference on one dimension: what a request carries, and what an
 * approved row means. **Strict**: an unknown key (a `note`, a `reason`) is
 * refused, because the store holds no free text and neither does this.
 */
export const CoachPreferenceSchema = z
  .strictObject({
    coachId: IdSchema,
    dimension: CoachPreferenceDimensionSchema,
    level: CoachPreferenceLevelSchema,
    value: z.union([z.string(), z.number()]).nullable().default(null),
  })
  .superRefine((preference, ctx) => {
    if (preference.value === null) return;
    if (!VALUE_SCHEMA[preference.dimension].safeParse(preference.value).success) {
      ctx.addIssue({
        code: 'custom',
        path: ['value'],
        message: `${JSON.stringify(preference.value)} is not a ${preference.dimension} value`,
      });
    }
  });

/** A practice as this module reads it: the team's current series, or a candidate. */
export const CoachPreferencePlacementSchema = z.object({
  weekday: PracticeWeekdaySchema,
  startMinutes: StartMinutesSchema,
  locationId: LocationIdSchema,
});

/**
 * One team: its CURRENT coaches (the roster, not the preference rows), the
 * approved preferences in play, and the series when it is being moved.
 */
export const CoachPreferenceInputSchema = z
  .strictObject({
    coachIds: z.array(IdSchema),
    preferences: z.array(CoachPreferenceSchema),
    series: CoachPreferencePlacementSchema.nullable().default(null),
  })
  .superRefine((input, ctx) => {
    const seen = new Set();
    input.preferences.forEach((preference, index) => {
      const key = `${preference.coachId}\u0000${preference.dimension}`;
      if (seen.has(key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['preferences', index],
          message: `a second preference for coach ${preference.coachId} on ${preference.dimension}; the store holds one approved row per (coach, dimension)`,
        });
      }
      seen.add(key);
    });
  });

/**
 * The strictest of some levels: `must_keep` > `prefer_keep` > `dont_care`, and
 * `dont_care` for none.
 *
 * @param {readonly string[]} levels
 * @returns {string}
 */
export function strictestCoachPreferenceLevel(levels) {
  /** @type {string} */
  let strictest = COACH_PREFERENCE_LEVEL.DONT_CARE;
  for (const level of levels) {
    if (!Object.hasOwn(STRICTNESS, level)) {
      throw new RangeError(`unknown coach preference level: ${level}`);
    }
    if (STRICTNESS[level] > STRICTNESS[strictest]) strictest = level;
  }
  return strictest;
}

/**
 * Resolve one team's preferences into one entry per dimension. The entries are
 * enumerated from the dimension vocabulary, never from the preferences, so a
 * dimension nobody holds is present as `dont_care` rather than absent.
 *
 * @param {unknown} input - see {@link CoachPreferenceInputSchema}
 */
export function resolveCoachPreferences(input) {
  const { coachIds, preferences, series } = CoachPreferenceInputSchema.parse(input);
  const onTeam = new Set(coachIds);
  const findings = [];

  const dimensions = DIMENSIONS.map((dimension) => {
    const holders = [];
    for (const preference of preferences) {
      if (preference.dimension !== dimension || !onTeam.has(preference.coachId)) continue;
      if (preference.level === COACH_PREFERENCE_LEVEL.DONT_CARE) continue;
      const reference = series ? series[PLACEMENT_KEY[dimension]] : preference.value;
      if (reference === null) {
        findings.push(
          makePracticeFinding(
            PRACTICE_REASON.COACH_PREFERENCE_NO_REFERENCE,
            `coach ${preference.coachId} holds ${preference.level} on ${dimension}, but there is neither a value nor a current series to keep, so it does nothing`,
            { coachId: preference.coachId, dimension, level: preference.level }
          )
        );
        continue;
      }
      holders.push({ coachId: preference.coachId, level: preference.level, reference });
    }

    const level = strictestCoachPreferenceLevel(holders.map((holder) => holder.level));
    const strictest = holders.filter((holder) => holder.level === level);
    const references = [...new Set(strictest.map((holder) => holder.reference))];
    if (references.length > 1) {
      findings.push(
        makePracticeFinding(
          PRACTICE_REASON.COACH_PREFERENCE_CONFLICT,
          `the team's coaches hold ${level} on ${dimension} with ${references.length} different values, so no practice can keep them all`,
          {
            dimension,
            level,
            coachIds: strictest.map((holder) => holder.coachId),
            references,
          }
        )
      );
    }
    return Object.freeze({
      dimension,
      level,
      source: strictest.length === 0 ? null : series ? 'series' : 'value',
      references: Object.freeze(references),
      coachIds: Object.freeze(strictest.map((holder) => holder.coachId)),
      unsatisfiable: level === COACH_PREFERENCE_LEVEL.MUST_KEEP && references.length > 1,
    });
  });

  return Object.freeze({
    dimensions: Object.freeze(dimensions),
    findings: Object.freeze(findings),
  });
}

/**
 * Judge one candidate practice against a resolution: every reference held at a
 * dimension's strictest level must be kept.
 *
 * @param {ReturnType<typeof resolveCoachPreferences>} resolution
 * @param {unknown} candidate - see {@link CoachPreferencePlacementSchema}
 */
export function judgeCoachPreferenceCandidate(resolution, candidate) {
  const placement = CoachPreferencePlacementSchema.parse(candidate);
  const violated = [];
  const breached = [];
  for (const entry of resolution.dimensions) {
    if (entry.references.length === 0) continue;
    const actual = placement[PLACEMENT_KEY[entry.dimension]];
    if (entry.references.every((reference) => reference === actual)) continue;
    if (entry.level === COACH_PREFERENCE_LEVEL.MUST_KEEP) violated.push(entry.dimension);
    else breached.push(entry.dimension);
  }
  return Object.freeze({
    mustKeepViolated: violated.length > 0,
    preferKeepBreaches: breached.length,
    violatedDimensions: Object.freeze(violated),
    breachedDimensions: Object.freeze(breached),
  });
}
