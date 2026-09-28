/**
 * The Deno twin of core's coach-preference rules (8.6 PR 3b, PR 8; plan §4
 * "Deno side").
 *
 * An Edge Function cannot import `packages/core`, so the two rules the
 * auto-scheduler needs are restated here, import-free: the strictest-level
 * rule across a team's current coaches, and the verdict on one candidate
 * practice. The source of truth is `packages/core/src/practice/coachPreferences.js`
 * (#453 as amended by #464); `tests/coachPreferenceDrift.test.js` runs both
 * arms over the full enumerated product and fails on any difference, and pins
 * {@link COACH_PREFERENCE_BREACHED_WEIGHT} to core's
 * `RESOLVE_OBJECTIVE_WEIGHTS.coachPreferenceBreached`.
 *
 * ## The rules, as core states them
 *
 * **Reference.** A preference with a non-null `value` keeps that value,
 * whether the team's series is being moved or the team is unplaced (#464). A
 * preference with a null `value` keeps the team's current series. With
 * neither, it does nothing, and a `PRACTICE_COACH_PREFERENCE_NO_REFERENCE`
 * finding says so. In an ordinary auto-scheduler run every team placed has no
 * series (plan §3: only teams with no row are placed), so only value-set
 * preferences bite there -- but the rule is mirrored whole, so the twin
 * cannot drift on the half the Edge happens not to exercise today.
 *
 * **Strictest wins**: `must_keep` > `prefer_keep` > `dont_care`. Every holder
 * at the strictest level must be kept; two differing `must_keep` references
 * make the dimension unsatisfiable (every candidate violates it), and two
 * differing `prefer_keep` references breach on every candidate. Either way a
 * `PRACTICE_COACH_PREFERENCE_CONFLICT` finding names them.
 *
 * **Verdict**: `mustKeepViolated` when any `must_keep` dimension is not kept;
 * `preferKeepBreaches`, one per `prefer_keep` dimension not kept.
 *
 * ## What the Edge does with a verdict (plan §5 decision 3)
 *
 * `must_keep` is a hard filter on NEW placements; `prefer_keep` is a
 * lexicographic tiebreak (fewer breaches first among feasible candidates).
 * The Edge fitness has no weighted objective, so the weight below is not
 * multiplied into anything here; it is held equal to core's so the two arms
 * cannot disagree about what a breach costs when one is priced.
 *
 * Import-free (no Deno std, no esm.sh), so Vitest can execute it directly.
 */

export const COACH_PREFERENCE_DIMENSIONS = Object.freeze([
  'weekday',
  'start_time',
  'venue',
] as const);
export type CoachPreferenceDimension = (typeof COACH_PREFERENCE_DIMENSIONS)[number];

export const COACH_PREFERENCE_LEVEL = Object.freeze({
  MUST_KEEP: 'must_keep',
  PREFER_KEEP: 'prefer_keep',
  DONT_CARE: 'dont_care',
} as const);

/** Core `RESOLVE_OBJECTIVE_WEIGHTS.coachPreferenceBreached` (plan §5 decision 1). */
export const COACH_PREFERENCE_BREACHED_WEIGHT = 100;

/** Core `PRACTICE_TBD_REASON.COACH_PREFERENCE`: the Edge's unplaced reason. */
export const COACH_PREFERENCE_TBD_REASON = 'coach-preference';

/** Core `PRACTICE_REASON` codes this twin emits. */
export const COACH_PREFERENCE_FINDING = Object.freeze({
  NO_REFERENCE: 'PRACTICE_COACH_PREFERENCE_NO_REFERENCE',
  CONFLICT: 'PRACTICE_COACH_PREFERENCE_CONFLICT',
} as const);

/** Higher is stricter: the one ordering strictest-wins reads. */
const STRICTNESS: Readonly<Record<string, number>> = Object.freeze({
  dont_care: 0,
  prefer_keep: 1,
  must_keep: 2,
});

/** The key a dimension is read from, on a series and on a candidate. */
const PLACEMENT_KEY = Object.freeze({
  weekday: 'weekday',
  start_time: 'startMinutes',
  venue: 'locationId',
} as const);

export type PreferenceValue = string | number;

export interface CoachPreference {
  coachId: string;
  dimension: CoachPreferenceDimension;
  level: string;
  value: PreferenceValue | null;
}

export interface PreferencePlacement {
  weekday: string;
  startMinutes: number;
  locationId: string;
}

export interface ResolvedDimension {
  dimension: CoachPreferenceDimension;
  level: string;
  source: 'value' | 'series' | 'mixed' | null;
  references: PreferenceValue[];
  coachIds: string[];
  unsatisfiable: boolean;
}

export interface PreferenceFinding {
  code: string;
  details: Record<string, unknown>;
}

export interface PreferenceResolution {
  dimensions: ResolvedDimension[];
  findings: PreferenceFinding[];
}

export interface PreferenceVerdict {
  mustKeepViolated: boolean;
  preferKeepBreaches: number;
  violatedDimensions: CoachPreferenceDimension[];
  breachedDimensions: CoachPreferenceDimension[];
}

/**
 * The strictest of some levels, and `dont_care` for none. An unknown level is
 * refused, never read as `dont_care`.
 */
export function strictestCoachPreferenceLevel(levels: readonly string[]): string {
  let strictest: string = COACH_PREFERENCE_LEVEL.DONT_CARE;
  for (const level of levels) {
    if (!Object.hasOwn(STRICTNESS, level)) {
      throw new RangeError(`unknown coach preference level: ${level}`);
    }
    if (STRICTNESS[level] > STRICTNESS[strictest]) strictest = level;
  }
  return strictest;
}

/**
 * Resolve one team's preferences into one entry per dimension, enumerated from
 * the dimension vocabulary (never from the preferences). `coachIds` is the
 * team's CURRENT coaches; a preference held by anyone else is ignored.
 */
export function resolveCoachPreferences(input: {
  coachIds: readonly string[];
  preferences: readonly CoachPreference[];
  series?: PreferencePlacement | null;
}): PreferenceResolution {
  const { coachIds, preferences } = input;
  const series = input.series ?? null;
  const seen = new Set<string>();
  for (const preference of preferences) {
    if (!(COACH_PREFERENCE_DIMENSIONS as readonly string[]).includes(preference.dimension)) {
      throw new RangeError(`unknown coach preference dimension: ${preference.dimension}`);
    }
    strictestCoachPreferenceLevel([preference.level]);
    const key = `${preference.coachId}\u0000${preference.dimension}`;
    if (seen.has(key)) {
      throw new RangeError(
        `a second preference for coach ${preference.coachId} on ${preference.dimension}; ` +
          'the store holds one approved row per (coach, dimension)'
      );
    }
    seen.add(key);
  }

  const onTeam = new Set(coachIds);
  const findings: PreferenceFinding[] = [];

  const dimensions = COACH_PREFERENCE_DIMENSIONS.map((dimension) => {
    const holders: Array<{
      coachId: string;
      level: string;
      reference: PreferenceValue;
      source: 'value' | 'series';
    }> = [];
    for (const preference of preferences) {
      if (preference.dimension !== dimension || !onTeam.has(preference.coachId)) continue;
      if (preference.level === COACH_PREFERENCE_LEVEL.DONT_CARE) continue;
      const fromValue = preference.value !== null && preference.value !== undefined;
      const reference: PreferenceValue | null = fromValue
        ? (preference.value as PreferenceValue)
        : series
          ? series[PLACEMENT_KEY[dimension]]
          : null;
      if (reference === null) {
        findings.push({
          code: COACH_PREFERENCE_FINDING.NO_REFERENCE,
          details: { coachId: preference.coachId, dimension, level: preference.level },
        });
        continue;
      }
      holders.push({
        coachId: preference.coachId,
        level: preference.level,
        reference,
        source: fromValue ? 'value' : 'series',
      });
    }

    const level = strictestCoachPreferenceLevel(holders.map((holder) => holder.level));
    const strictest = holders.filter((holder) => holder.level === level);
    const references = [...new Set(strictest.map((holder) => holder.reference))];
    if (references.length > 1) {
      findings.push({
        code: COACH_PREFERENCE_FINDING.CONFLICT,
        details: {
          dimension,
          level,
          coachIds: strictest.map((holder) => holder.coachId),
          references,
        },
      });
    }
    return {
      dimension,
      level,
      source:
        strictest.length === 0
          ? null
          : strictest.every((holder) => holder.source === strictest[0].source)
            ? strictest[0].source
            : 'mixed',
      references,
      coachIds: strictest.map((holder) => holder.coachId),
      unsatisfiable: level === COACH_PREFERENCE_LEVEL.MUST_KEEP && references.length > 1,
    } as ResolvedDimension;
  });

  return { dimensions, findings };
}

/**
 * Judge one candidate practice: every reference held at a dimension's
 * strictest level must be kept.
 */
export function judgeCoachPreferenceCandidate(
  resolution: PreferenceResolution,
  candidate: PreferencePlacement
): PreferenceVerdict {
  const violated: CoachPreferenceDimension[] = [];
  const breached: CoachPreferenceDimension[] = [];
  for (const entry of resolution.dimensions) {
    if (entry.references.length === 0) continue;
    const actual = candidate[PLACEMENT_KEY[entry.dimension]];
    if (entry.references.every((reference) => reference === actual)) continue;
    if (entry.level === COACH_PREFERENCE_LEVEL.MUST_KEEP) violated.push(entry.dimension);
    else breached.push(entry.dimension);
  }
  return {
    mustKeepViolated: violated.length > 0,
    preferKeepBreaches: breached.length,
    violatedDimensions: violated,
    breachedDimensions: breached,
  };
}

/** True when a resolution constrains nothing: every dimension has no reference. */
export function isInertResolution(resolution: PreferenceResolution): boolean {
  return resolution.dimensions.every((entry) => entry.references.length === 0);
}
