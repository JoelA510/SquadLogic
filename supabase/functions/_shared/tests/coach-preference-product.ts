/**
 * The full enumerated product both arms of the coach-preference rule are run
 * over (8.6 PR 3b plan §4 "Deno side", §6 "Arms agree").
 *
 * Shared, import-free, by `tests/coachPreferenceDrift.test.js` (Vitest: core
 * against the twin, value by value) and `coach-preferences_test.ts` (Deno: the
 * twin in the runtime it deploys to). Both reduce the outcomes to one
 * canonical JSON string and hash it; the committed digest in
 * `coach-preference-product.digest.json` is what core produces, so the Deno
 * run is compared with core without importing it.
 *
 * **The product.** Per dimension (3): 0 to 3 coaches on the team, every level
 * combination (3^n), every value source per coach -- a value the candidate
 * keeps, a value it does not, or null (the series is the reference) -- with a
 * current series and without one, a candidate that matches the series and one
 * that does not, and with and without a preference held by a coach who is NOT
 * on the team (which must change nothing). Plus every level combination across
 * all three dimensions at once for one coach, against every match mask, so
 * breach counts are summed across dimensions. Plus the inputs both arms must
 * refuse.
 */

export const LOC_A = '00000000-0000-4000-8000-00000000000a';
export const LOC_B = '00000000-0000-4000-8000-00000000000b';

const DIMENSIONS = ['weekday', 'start_time', 'venue'] as const;
const LEVELS = ['must_keep', 'prefer_keep', 'dont_care'] as const;
const KEY = { weekday: 'weekday', start_time: 'startMinutes', venue: 'locationId' } as const;

/** Index 0 is the series' value; index 1 is another. */
const REFERENCE = {
  weekday: ['TUE', 'THU'],
  start_time: [1020, 1080],
  venue: [LOC_A, LOC_B],
} as const;

const SERIES = { weekday: 'TUE', startMinutes: 1020, locationId: LOC_A };

type Dimension = (typeof DIMENSIONS)[number];

export interface ProductCase {
  id: string;
  input: {
    coachIds: string[];
    preferences: Array<{
      coachId: string;
      dimension: string;
      level: string;
      value: string | number | null;
    }>;
    series: { weekday: string; startMinutes: number; locationId: string } | null;
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

export function enumerateCoachPreferenceProduct(): ProductCase[] {
  const cases: ProductCase[] = [];
  for (const dimension of DIMENSIONS) {
    for (let n = 0; n <= 3; n += 1) {
      const coachIds = Array.from({ length: n }, (_, i) => `c${i + 1}`);
      for (const levels of product(LEVELS, n)) {
        for (const sources of product(['match', 'mismatch', 'null'] as const, n)) {
          for (const withSeries of [true, false]) {
            for (const candidateIndex of [0, 1] as const) {
              for (const offRoster of [false, true]) {
                const preferences: ProductCase['input']['preferences'] = coachIds.map(
                  (coachId, i) => ({
                    coachId,
                    dimension,
                    level: levels[i],
                    value:
                      sources[i] === 'null'
                        ? null
                        : REFERENCE[dimension][sources[i] === 'match' ? 0 : 1],
                  })
                );
                if (offRoster) {
                  preferences.push({
                    coachId: 'c-off-roster',
                    dimension,
                    level: 'must_keep',
                    value: REFERENCE[dimension][1],
                  });
                }
                cases.push({
                  id: [
                    dimension,
                    n,
                    levels.join('+') || '-',
                    sources.join('+') || '-',
                    withSeries ? 'series' : 'no-series',
                    candidateIndex ? 'mismatch' : 'match',
                    offRoster ? 'off-roster' : 'roster',
                  ].join('/'),
                  input: { coachIds, preferences, series: withSeries ? { ...SERIES } : null },
                  candidate: candidateWith(dimension, candidateIndex),
                });
              }
            }
          }
        }
      }
    }
  }

  // Every dimension at once: one coach, a level per dimension (27), a value
  // per dimension equal to the series', against every match mask (8).
  for (const levels of product(LEVELS, 3)) {
    for (const mask of product([0, 1] as const, 3)) {
      const candidate = { ...SERIES };
      DIMENSIONS.forEach((dimension, i) => {
        (candidate as Record<string, unknown>)[KEY[dimension]] = REFERENCE[dimension][mask[i]];
      });
      cases.push({
        id: `all/${levels.join('+')}/${mask.join('')}`,
        input: {
          coachIds: ['c1'],
          preferences: DIMENSIONS.map((dimension, i) => ({
            coachId: 'c1',
            dimension,
            level: levels[i],
            value: REFERENCE[dimension][0],
          })),
          series: null,
        },
        candidate,
      });
    }
  }

  // Inputs both arms must refuse: a second row for one (coach, dimension), and
  // a level outside the vocabulary.
  cases.push({
    id: 'refuse/duplicate-coach-dimension',
    input: {
      coachIds: ['c1'],
      preferences: [
        { coachId: 'c1', dimension: 'weekday', level: 'must_keep', value: 'TUE' },
        { coachId: 'c1', dimension: 'weekday', level: 'prefer_keep', value: 'THU' },
      ],
      series: null,
    },
    candidate: { ...SERIES },
  });
  cases.push({
    id: 'refuse/unknown-level',
    input: {
      coachIds: ['c1'],
      preferences: [{ coachId: 'c1', dimension: 'weekday', level: 'always', value: 'TUE' }],
      series: null,
    },
    candidate: { ...SERIES },
  });
  return cases;
}

/** The outcome both arms are compared on, in a fixed key order. */
export function projectOutcome(
  resolve: (input: ProductCase['input']) => unknown,
  judge: (resolution: unknown, candidate: ProductCase['candidate']) => unknown,
  testCase: ProductCase
): unknown {
  let resolution: {
    dimensions: Array<Record<string, unknown>>;
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
    dimensions: resolution.dimensions.map((d) => ({
      dimension: d.dimension,
      level: d.level,
      source: d.source,
      references: [...(d.references as unknown[])],
      coachIds: [...(d.coachIds as unknown[])],
      unsatisfiable: d.unsatisfiable,
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
      violatedDimensions: [...(verdict.violatedDimensions as unknown[])],
      breachedDimensions: [...(verdict.breachedDimensions as unknown[])],
    },
  };
}
