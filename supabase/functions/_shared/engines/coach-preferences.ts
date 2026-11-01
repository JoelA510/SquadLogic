/**
 * The Deno twin of core's practice-preference rule judging (Phase D, C1; originally 8.6 PR 3b,
 * PR 8; plan §4 "Deno side").
 *
 * An Edge Function cannot import `packages/core`, so the two things the auto-scheduler needs are
 * restated here, import-free: which of a team's rules apply and what each asks of a practice, and
 * the verdict on one candidate practice. The source of truth is
 * `packages/core/src/practice/coachPreferences.js`; `tests/coachPreferenceDrift.test.js` runs both
 * arms over the full enumerated product and fails on any difference, and pins
 * {@link COACH_PREFERENCE_BREACHED_WEIGHT} to core's `RESOLVE_OBJECTIVE_WEIGHTS.coachPreferenceBreached`.
 *
 * ## The rules, as core states them
 *
 * **A rule has up to three conditions**: weekdays, start minutes and venues, each a set meaning
 * "any of", or "keep the current one". The conditions of one rule must all hold. Keep-current is
 * met by any value the team's live practices hold (`current`); with none it does nothing and a
 * `PRACTICE_COACH_PREFERENCE_NO_REFERENCE` finding names the rule and the dimension.
 *
 * **Which rules apply** to a team on a day: the rule is for that team, its coach is one of the
 * team's CURRENT coaches, and the day is inside the rule's window. A rule with a window and no day
 * to judge it on is refused, never read as always in window.
 *
 * **Every rule that applies is judged**: a `must` is a filter (`mustKeepViolated` when any is
 * unmet), a `prefer` costs one breach per unmet rule. Nothing supersedes anything.
 *
 * **Conflicts**: rules of one level whose sets for one dimension share no value get a
 * `PRACTICE_COACH_PREFERENCE_CONFLICT` finding naming them.
 *
 * ## What the Edge does with a verdict
 *
 * `must` is a hard filter on NEW placements; `prefer` is a lexicographic tiebreak (fewer breaches
 * first among feasible candidates). The Edge fitness has no weighted objective, so the weight below
 * is not multiplied into anything here; it is held equal to core's so the two arms cannot disagree
 * about what a breach costs when one is priced.
 *
 * Import-free (no Deno std, no esm.sh), so Vitest can execute it directly.
 */

export const COACH_PREFERENCE_DIMENSIONS = Object.freeze(['weekday', 'start_time', 'venue'] as const);
export type CoachPreferenceDimension = (typeof COACH_PREFERENCE_DIMENSIONS)[number];

export const COACH_PREFERENCE_LEVEL = Object.freeze({
  MUST: 'must',
  PREFER: 'prefer',
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

/** The key a dimension is read from, on a placement. */
const PLACEMENT_KEY = Object.freeze({
  weekday: 'weekday',
  start_time: 'startMinutes',
  venue: 'locationId',
} as const);

const WEEKDAY_CODES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const PRIORITIES = ['high', 'medium', 'low'];
const LOCATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const RULE_KEYS = new Set([
  'id',
  'coachId',
  'teamId',
  'level',
  'weekdays',
  'startMinutes',
  'venueIds',
  'keepWeekday',
  'keepStart',
  'keepVenue',
  'coachPriority',
  'effectiveFrom',
  'effectiveTo',
]);

export type PlacementValue = string | number;

/** One rule in force for one team (core `CoachPreferenceRuleSchema`). */
export interface PreferenceRule {
  id: string;
  coachId: string;
  teamId: string;
  level: string;
  weekdays?: string[] | null;
  startMinutes?: number[] | null;
  venueIds?: string[] | null;
  keepWeekday?: boolean;
  keepStart?: boolean;
  keepVenue?: boolean;
  coachPriority?: string | null;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
}

export interface PreferencePlacement {
  weekday: string;
  startMinutes: number;
  locationId: string;
}

export interface ResolvedCondition {
  dimension: CoachPreferenceDimension;
  source: 'values' | 'current';
  allowed: PlacementValue[];
}

export interface ResolvedRule {
  id: string;
  coachId: string;
  level: string;
  coachPriority: string | null;
  conditions: ResolvedCondition[];
}

export interface PreferenceFinding {
  code: string;
  details: Record<string, unknown>;
}

export interface PreferenceResolution {
  rules: ResolvedRule[];
  findings: PreferenceFinding[];
}

export interface PreferenceVerdict {
  mustKeepViolated: boolean;
  preferKeepBreaches: number;
  violatedRules: string[];
  breachedRules: string[];
  violatedDimensions: CoachPreferenceDimension[];
  breachedDimensions: CoachPreferenceDimension[];
}

const nonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

/** A set condition: absent (null / undefined) or a non-empty array of distinct, valid values. */
function checkSet(rule: PreferenceRule, name: string, value: unknown, valid: (v: unknown) => boolean) {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value) || value.length === 0) {
    throw new RangeError(`rule ${rule.id}: ${name} holds at least one value`);
  }
  if (!value.every(valid)) throw new RangeError(`rule ${rule.id}: ${name} holds an invalid value`);
  if (new Set(value).size !== value.length) {
    throw new RangeError(`rule ${rule.id}: ${name} holds a duplicate`);
  }
  return value;
}

/** The rule's own contract, restated: what core's zod schema refuses, this refuses. */
function checkRule(rule: PreferenceRule) {
  if (rule === null || typeof rule !== 'object') throw new RangeError('a rule is an object');
  for (const key of Object.keys(rule)) {
    if (!RULE_KEYS.has(key)) throw new RangeError(`rule has an unknown key: ${key}`);
  }
  if (!nonEmptyString(rule.id)) throw new RangeError('a rule has an id');
  if (!nonEmptyString(rule.coachId) || !nonEmptyString(rule.teamId)) {
    throw new RangeError(`rule ${rule.id}: a coach and a team are required`);
  }
  if (rule.level !== COACH_PREFERENCE_LEVEL.MUST && rule.level !== COACH_PREFERENCE_LEVEL.PREFER) {
    throw new RangeError(`unknown preference rule level: ${String(rule.level)}`);
  }
  const weekdays = checkSet(rule, 'weekdays', rule.weekdays, (v) => WEEKDAY_CODES.includes(v as string));
  const starts = checkSet(
    rule,
    'startMinutes',
    rule.startMinutes,
    (v) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 1439
  );
  const venues = checkSet(rule, 'venueIds', rule.venueIds, (v) => typeof v === 'string' && LOCATION_ID.test(v));
  for (const [values, keep, name] of [
    [weekdays, rule.keepWeekday, 'weekday'],
    [starts, rule.keepStart, 'start'],
    [venues, rule.keepVenue, 'venue'],
  ] as const) {
    if (keep !== undefined && typeof keep !== 'boolean') throw new RangeError(`rule ${rule.id}: keep ${name} is a boolean`);
    if (values !== null && keep === true) {
      throw new RangeError(`rule ${rule.id}: a rule holds either values or keep-current for the ${name}, not both`);
    }
  }
  const conditions =
    Number(weekdays !== null || rule.keepWeekday === true) +
    Number(starts !== null || rule.keepStart === true) +
    Number(venues !== null || rule.keepVenue === true);
  if (conditions === 0) throw new RangeError(`rule ${rule.id}: a rule has at least one condition`);
  if (rule.coachPriority !== null && rule.coachPriority !== undefined && !PRIORITIES.includes(rule.coachPriority)) {
    throw new RangeError(`rule ${rule.id}: an unknown priority`);
  }
  for (const date of [rule.effectiveFrom, rule.effectiveTo]) {
    if (date !== null && date !== undefined && !(typeof date === 'string' && ISO_DATE.test(date))) {
      throw new RangeError(`rule ${rule.id}: a window date is YYYY-MM-DD`);
    }
  }
  if (rule.effectiveFrom && rule.effectiveTo && rule.effectiveTo < rule.effectiveFrom) {
    throw new RangeError(`rule ${rule.id}: the window ends before it starts`);
  }
}

/** Whether a rule's window holds `date`. A bounded rule with no date to judge it on is refused. */
export function ruleInWindow(rule: PreferenceRule, date: string | null | undefined): boolean {
  const from = rule.effectiveFrom ?? null;
  const to = rule.effectiveTo ?? null;
  if (from === null && to === null) return true;
  if (date === null || date === undefined) {
    throw new RangeError(`rule ${rule.id} has a date window and no day was given to judge it on`);
  }
  if (from !== null && date < from) return false;
  if (to !== null && date > to) return false;
  return true;
}

function conditionsOf(rule: PreferenceRule) {
  return [
    { dimension: 'weekday' as const, values: rule.weekdays ?? null, keep: rule.keepWeekday === true },
    { dimension: 'start_time' as const, values: rule.startMinutes ?? null, keep: rule.keepStart === true },
    { dimension: 'venue' as const, values: rule.venueIds ?? null, keep: rule.keepVenue === true },
  ].filter((condition) => condition.values !== null || condition.keep);
}

/**
 * Resolve one team's rules into the conditions each rule asks of a practice. `coachIds` is the
 * team's CURRENT coaches; a rule asked by anyone else, for another team, or out of window on
 * `date` is ignored. The rules that apply are enumerated from the rules offered, in order.
 */
export function resolveCoachPreferences(input: {
  teamId: string;
  coachIds: readonly string[];
  rules: readonly PreferenceRule[];
  current?: readonly PreferencePlacement[];
  date?: string | null;
}): PreferenceResolution {
  const { teamId, coachIds, rules } = input;
  const current = input.current ?? [];
  const date = input.date ?? null;
  if (!nonEmptyString(teamId)) throw new RangeError('a team id is required');
  if (date !== null && !(typeof date === 'string' && ISO_DATE.test(date))) {
    throw new RangeError('the day judged is YYYY-MM-DD');
  }
  const seen = new Set<string>();
  for (const rule of rules) {
    checkRule(rule);
    if (seen.has(rule.id)) throw new RangeError(`a second rule with id ${rule.id}; a rule is named by its id`);
    seen.add(rule.id);
  }

  const onTeam = new Set(coachIds);
  const findings: PreferenceFinding[] = [];
  const resolved: ResolvedRule[] = [];
  for (const rule of rules) {
    if (rule.teamId !== teamId || !onTeam.has(rule.coachId) || !ruleInWindow(rule, date)) continue;
    const conditions: ResolvedCondition[] = [];
    for (const { dimension, values } of conditionsOf(rule)) {
      if (values !== null) {
        conditions.push({ dimension, source: 'values', allowed: [...values] });
        continue;
      }
      // keep-current: any value the team's live practices hold.
      const held = [...new Set(current.map((placement) => placement[PLACEMENT_KEY[dimension]]))];
      if (held.length === 0) {
        findings.push({
          code: COACH_PREFERENCE_FINDING.NO_REFERENCE,
          details: { ruleId: rule.id, coachId: rule.coachId, dimension, level: rule.level },
        });
        continue;
      }
      conditions.push({ dimension, source: 'current', allowed: held });
    }
    resolved.push({
      id: rule.id,
      coachId: rule.coachId,
      level: rule.level,
      coachPriority: rule.coachPriority ?? null,
      conditions,
    });
  }

  for (const level of [COACH_PREFERENCE_LEVEL.MUST, COACH_PREFERENCE_LEVEL.PREFER]) {
    for (const dimension of COACH_PREFERENCE_DIMENSIONS) {
      const holders = resolved
        .filter((rule) => rule.level === level)
        .flatMap((rule) =>
          rule.conditions
            .filter((condition) => condition.dimension === dimension)
            .map((condition) => ({ rule, condition }))
        );
      if (holders.length < 2) continue;
      const common = holders
        .map(({ condition }) => condition.allowed)
        .reduce((left, right) => left.filter((value) => right.includes(value)));
      if (common.length === 0) {
        findings.push({
          code: COACH_PREFERENCE_FINDING.CONFLICT,
          details: {
            dimension,
            level,
            ruleIds: holders.map(({ rule }) => rule.id),
            coachIds: [...new Set(holders.map(({ rule }) => rule.coachId))],
          },
        });
      }
    }
  }

  return { rules: resolved, findings };
}

/** True when a resolution constrains nothing: no rule has a condition left. */
export function isInertResolution(resolution: PreferenceResolution): boolean {
  return resolution.rules.every((rule) => rule.conditions.length === 0);
}

/**
 * Judge one candidate practice: every rule that applies is judged; an unmet `must` violates, an
 * unmet `prefer` is one breach.
 */
export function judgeCoachPreferenceCandidate(
  resolution: PreferenceResolution,
  candidate: PreferencePlacement
): PreferenceVerdict {
  const violatedRules: string[] = [];
  const breachedRules: string[] = [];
  const violatedDimensions = new Set<CoachPreferenceDimension>();
  const breachedDimensions = new Set<CoachPreferenceDimension>();
  for (const rule of resolution.rules) {
    const unmet = rule.conditions.filter(
      (condition) => !condition.allowed.includes(candidate[PLACEMENT_KEY[condition.dimension]])
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
  return {
    mustKeepViolated: violatedRules.length > 0,
    preferKeepBreaches: breachedRules.length,
    violatedRules,
    breachedRules,
    violatedDimensions: COACH_PREFERENCE_DIMENSIONS.filter((d) => violatedDimensions.has(d)),
    breachedDimensions: COACH_PREFERENCE_DIMENSIONS.filter((d) => breachedDimensions.has(d)),
  };
}
