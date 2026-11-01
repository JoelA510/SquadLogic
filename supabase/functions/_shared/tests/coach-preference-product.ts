/**
 * The full enumerated product both arms of the practice-preference rule judging are run over
 * (Phase D C1; originally 8.6 PR 3b plan §4 "Deno side", §6 "Arms agree").
 *
 * Shared, import-free, by `tests/coachPreferenceDrift.test.js` (Vitest: core against the twin,
 * value by value) and `coach-preferences_test.ts` (Deno: the twin in the runtime it deploys to).
 * Both reduce the outcomes to one canonical JSON string and hash it; the committed digest in
 * `coach-preference-product.digest.json` is what core produces, so the Deno run is compared with
 * core without importing it.
 *
 * **The product** (a rule is `{id, coachId, teamId, level, weekdays | startMinutes | venueIds |
 * keep-current}`; the team is `team-1`, its coaches are `c1`..`c3`, the day judged is
 * {@link RUN_DATE}):
 *
 *   A. Per dimension (3): 0 to 3 rules on the team, a level (must | prefer) and a condition kind per
 *      rule -- a set holding the candidate's value (`hit`), a set that does not (`miss`), a set of
 *      both (`both`), or keep-current (`keep`) -- with the team holding a live practice (the
 *      series) and without, a candidate that has the series' value and one that does not, and with
 *      and without a rule asked by a coach who is NOT on the team (which must change nothing).
 *   B. The noise a rule can be filtered by, per dimension, 1 to 2 rules: a rule for ANOTHER team,
 *      a rule whose window ended before the day, one that starts after it, and one whose window
 *      holds it (each must change nothing, or apply, as the window says).
 *   C. Every dimension at once: one rule with a kind per dimension (63 with a condition), a level
 *      (2), against every match mask (8), with and without a live practice -- so breach counts
 *      and violated dimensions are summed across dimensions of one rule.
 *   D. Two rules at once with every dimension combination in both orders, to pin that a breach is
 *      one per unmet rule and that a rule from two coaches counts twice.
 *   E. The inputs both arms must refuse.
 */

export const LOC_A = '00000000-0000-4000-8000-00000000000a';
export const LOC_B = '00000000-0000-4000-8000-00000000000b';

/** The day every case is judged on, and dates around it for the windows. */
export const RUN_DATE = '2026-11-10';

const DIMENSIONS = ['weekday', 'start_time', 'venue'] as const;
const LEVELS = ['must', 'prefer'] as const;
const KINDS = ['hit', 'miss', 'both', 'keep'] as const;
const KEY = { weekday: 'weekday', start_time: 'startMinutes', venue: 'locationId' } as const;
const RULE_FIELD = { weekday: 'weekdays', start_time: 'startMinutes', venue: 'venueIds' } as const;
const KEEP_FIELD = { weekday: 'keepWeekday', start_time: 'keepStart', venue: 'keepVenue' } as const;

/** Index 0 is the series' value; index 1 is another. */
const REFERENCE = {
  weekday: ['TUE', 'THU'],
  start_time: [1020, 1080],
  venue: [LOC_A, LOC_B],
} as const;

const SERIES = { weekday: 'TUE', startMinutes: 1020, locationId: LOC_A };

type Dimension = (typeof DIMENSIONS)[number];
type Kind = (typeof KINDS)[number];

export interface ProductRule {
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
  // Deliberately loose: the refusal cases carry keys the schema refuses.
  [extra: string]: unknown;
}

export interface ProductCase {
  id: string;
  input: {
    teamId: string;
    coachIds: string[];
    rules: ProductRule[];
    current: Array<{ weekday: string; startMinutes: number; locationId: string }>;
    date: string | null;
  };
  candidate: { weekday: string; startMinutes: number; locationId: string };
}

function product<T>(values: readonly T[], n: number): T[][] {
  let out: T[][] = [[]];
  for (let i = 0; i < n; i += 1) out = out.flatMap((prefix) => values.map((v) => [...prefix, v]));
  return out;
}

function candidateWith(dimension: Dimension, index: 0 | 1) {
  return { ...SERIES, [KEY[dimension]]: REFERENCE[dimension][index] };
}

/** A rule with one condition of `kind` on `dimension`. */
function rule(
  id: string,
  coachId: string,
  level: string,
  dimension: Dimension,
  kind: Kind,
  extra: Partial<ProductRule> = {}
): ProductRule {
  const [a, b] = REFERENCE[dimension];
  const base: ProductRule = { id, coachId, teamId: 'team-1', level, ...extra };
  if (kind === 'keep') return { ...base, [KEEP_FIELD[dimension]]: true };
  const values = kind === 'hit' ? [a] : kind === 'miss' ? [b] : [a, b];
  return { ...base, [RULE_FIELD[dimension]]: [...values] };
}

export function enumerateCoachPreferenceProduct(): ProductCase[] {
  const cases: ProductCase[] = [];
  const team = (
    coachIds: string[],
    rules: ProductRule[],
    withSeries: boolean
  ): ProductCase['input'] => ({
    teamId: 'team-1',
    coachIds,
    rules,
    current: withSeries ? [{ ...SERIES }] : [],
    date: RUN_DATE,
  });

  // A. Per dimension: n rules, levels, kinds, a series or none, a candidate, an off-roster rule.
  for (const dimension of DIMENSIONS) {
    for (let n = 0; n <= 3; n += 1) {
      const coachIds = Array.from({ length: n }, (_, i) => `c${i + 1}`);
      for (const levels of product(LEVELS, n)) {
        for (const kinds of product(KINDS, n)) {
          for (const withSeries of [true, false]) {
            for (const candidateIndex of [0, 1] as const) {
              for (const offRoster of [false, true]) {
                const rules = coachIds.map((coachId, i) =>
                  rule(`r${i + 1}`, coachId, levels[i], dimension, kinds[i])
                );
                if (offRoster) {
                  rules.push(rule('r-off', 'c-off-roster', 'must', dimension, 'miss'));
                }
                cases.push({
                  id: [
                    'A',
                    dimension,
                    n,
                    levels.join('+') || '-',
                    kinds.join('+') || '-',
                    withSeries ? 'series' : 'no-series',
                    candidateIndex ? 'mismatch' : 'match',
                    offRoster ? 'off-roster' : 'roster',
                  ].join('/'),
                  input: team(coachIds, rules, withSeries),
                  candidate: candidateWith(dimension, candidateIndex),
                });
              }
            }
          }
        }
      }
    }
  }

  // B. Filtered by team and by window: none of these may change a verdict when it is filtered, and
  // the one whose window holds the day must apply.
  const noise: Array<{ name: string; extra: Partial<ProductRule> }> = [
    { name: 'other-team', extra: { teamId: 'team-2' } },
    { name: 'window-ended', extra: { effectiveFrom: '2026-09-01', effectiveTo: '2026-11-09' } },
    { name: 'window-not-started', extra: { effectiveFrom: '2026-11-11', effectiveTo: null } },
    { name: 'window-holds', extra: { effectiveFrom: '2026-11-10', effectiveTo: '2026-11-10' } },
  ];
  for (const dimension of DIMENSIONS) {
    for (let n = 1; n <= 2; n += 1) {
      const coachIds = Array.from({ length: n }, (_, i) => `c${i + 1}`);
      for (const levels of product(LEVELS, n)) {
        for (const kinds of product(KINDS, n)) {
          for (const withSeries of [true, false]) {
            for (const candidateIndex of [0, 1] as const) {
              for (const n2 of noise) {
                const rules = coachIds.map((coachId, i) =>
                  rule(`r${i + 1}`, coachId, levels[i], dimension, kinds[i], n2.extra)
                );
                cases.push({
                  id: [
                    'B',
                    dimension,
                    n,
                    levels.join('+'),
                    kinds.join('+'),
                    withSeries ? 'series' : 'no-series',
                    candidateIndex ? 'mismatch' : 'match',
                    n2.name,
                  ].join('/'),
                  input: team(coachIds, rules, withSeries),
                  candidate: candidateWith(dimension, candidateIndex),
                });
              }
            }
          }
        }
      }
    }
  }

  // C. Every dimension at once: one rule, a kind (or nothing) per dimension, a level, every match
  // mask, with and without a series. A rule with no condition is not a rule, so it is left out.
  const KIND_OR_NONE = [...KINDS, 'none'] as const;
  for (const kinds of product(KIND_OR_NONE, 3)) {
    if (kinds.every((k) => k === 'none')) continue;
    for (const level of LEVELS) {
      for (const mask of product([0, 1] as const, 3)) {
        for (const withSeries of [true, false]) {
          const candidate = { ...SERIES };
          DIMENSIONS.forEach((dimension, i) => {
            (candidate as Record<string, unknown>)[KEY[dimension]] = REFERENCE[dimension][mask[i]];
          });
          let one: ProductRule = { id: 'r1', coachId: 'c1', teamId: 'team-1', level };
          DIMENSIONS.forEach((dimension, i) => {
            if (kinds[i] !== 'none') {
              one = { ...one, ...rule('r1', 'c1', level, dimension, kinds[i] as Kind) };
            }
          });
          cases.push({
            id: `C/${kinds.join('+')}/${level}/${mask.join('')}/${withSeries ? 'series' : 'no-series'}`,
            input: team(['c1'], [one], withSeries),
            candidate,
          });
        }
      }
    }
  }

  // D. Two rules, each with a condition on one dimension (any pair of dimensions, either order),
  // from one coach and from two, both must / mixed / both prefer, against every mask.
  for (const first of DIMENSIONS) {
    for (const second of DIMENSIONS) {
      for (const levels of product(LEVELS, 2)) {
        for (const sameCoach of [true, false]) {
          for (const mask of product([0, 1] as const, 3)) {
            const candidate = { ...SERIES };
            DIMENSIONS.forEach((dimension, i) => {
              (candidate as Record<string, unknown>)[KEY[dimension]] =
                REFERENCE[dimension][mask[i]];
            });
            cases.push({
              id: `D/${first}+${second}/${levels.join('+')}/${sameCoach ? 'one-coach' : 'two-coaches'}/${mask.join('')}`,
              input: team(
                sameCoach ? ['c1'] : ['c1', 'c2'],
                [
                  rule('r1', 'c1', levels[0], first, 'hit'),
                  rule('r2', sameCoach ? 'c1' : 'c2', levels[1], second, 'hit'),
                ],
                false
              ),
              candidate,
            });
          }
        }
      }
    }
  }

  // E. Inputs both arms must refuse.
  const base = rule('r1', 'c1', 'must', 'weekday', 'hit');
  const refuse = (id: string, rules: ProductRule[], date: string | null = RUN_DATE) =>
    cases.push({
      id: `E/${id}`,
      input: { ...team(['c1'], rules, false), date },
      candidate: { ...SERIES },
    });
  refuse('duplicate-rule-id', [base, { ...base }]);
  refuse('unknown-level', [{ ...base, level: 'always' }]);
  refuse('old-level-name', [{ ...base, level: 'must_keep' }]);
  refuse('empty-set', [{ ...base, weekdays: [] }]);
  refuse('duplicate-value', [{ ...base, weekdays: ['TUE', 'TUE'] }]);
  refuse('unknown-weekday', [{ ...base, weekdays: ['TUESDAY'] }]);
  refuse('minute-out-of-range', [
    { ...rule('r1', 'c1', 'must', 'start_time', 'hit'), startMinutes: [1440] },
  ]);
  refuse('keep-and-values', [{ ...base, keepWeekday: true }]);
  refuse('no-condition', [{ id: 'r1', coachId: 'c1', teamId: 'team-1', level: 'must' }]);
  refuse('window-reversed', [{ ...base, effectiveFrom: '2026-11-10', effectiveTo: '2026-11-09' }]);
  refuse('window-without-a-day', [{ ...base, effectiveFrom: '2026-11-01' }], null);
  refuse('unknown-key', [{ ...base, dimension: 'weekday' }]);
  refuse('unknown-priority', [{ ...base, coachPriority: 'urgent' }]);
  return cases;
}

/** The outcome both arms are compared on, in a fixed key order. */
export function projectOutcome(
  resolve: (input: ProductCase['input']) => unknown,
  judge: (resolution: unknown, candidate: ProductCase['candidate']) => unknown,
  testCase: ProductCase
): unknown {
  let resolution: {
    rules: Array<Record<string, unknown>>;
    findings: Array<{ code: string; details: Record<string, unknown> }>;
  };
  try {
    resolution = resolve(testCase.input) as typeof resolution;
  } catch {
    return { id: testCase.id, refused: true };
  }
  const verdict = judge(resolution, testCase.candidate) as Record<string, unknown>;
  return {
    id: testCase.id,
    rules: resolution.rules.map((r) => ({
      id: r.id,
      coachId: r.coachId,
      level: r.level,
      conditions: (r.conditions as Array<Record<string, unknown>>).map((c) => ({
        dimension: c.dimension,
        source: c.source,
        allowed: [...(c.allowed as unknown[])],
      })),
    })),
    findings: resolution.findings.map((f) => ({
      code: f.code,
      details: Object.fromEntries(
        Object.keys(f.details)
          .sort()
          .map((k) => [k, f.details[k]])
      ),
    })),
    verdict: {
      mustKeepViolated: verdict.mustKeepViolated,
      preferKeepBreaches: verdict.preferKeepBreaches,
      violatedRules: [...(verdict.violatedRules as unknown[])],
      breachedRules: [...(verdict.breachedRules as unknown[])],
      violatedDimensions: [...(verdict.violatedDimensions as unknown[])],
      breachedDimensions: [...(verdict.breachedDimensions as unknown[])],
    },
  };
}
