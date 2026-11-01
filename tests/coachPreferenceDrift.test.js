/**
 * Cross-arm drift check: core `practice/coachPreferences.js` against the Deno
 * twin `_shared/engines/coach-preferences.ts` (Phase D C1; originally 8.6 PR 3b plan §4
 * "Deno side", §6 "Arms agree"; the `scoringEngineDrift` precedent).
 *
 * Both arms run over the FULL enumerated product
 * (`_shared/tests/coach-preference-product.ts`): per dimension 0-3 rules x level x
 * condition kind (values the candidate has, values it lacks, both, keep-current) x a live
 * practice or none x a matching and a mismatching candidate x with and without a rule from a
 * coach who is not on the team; the same under a rule for another team and under windows
 * that end, have not started, or hold the day; every dimension at once; two rules at once;
 * and the inputs both must refuse. Compared value by value here, and as a digest against
 * `coach-preference-product.digest.json`, which the Deno test (`coach-preferences_test.ts`,
 * run by `scripts/deno-mirror-tests.sh`) holds the twin to in the runtime it deploys to.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  judgeCoachPreferenceCandidate as coreJudge,
  PRACTICE_REASON,
  PRACTICE_TBD_REASON,
  resolveCoachPreferences as coreResolve,
} from '@squadlogic/core/practice/index.js';
import { RESOLVE_OBJECTIVE_WEIGHTS } from '@squadlogic/core/resolve/objective.js';
import {
  COACH_PREFERENCE_BREACHED_WEIGHT,
  COACH_PREFERENCE_FINDING,
  COACH_PREFERENCE_TBD_REASON,
  judgeCoachPreferenceCandidate as twinJudge,
  resolveCoachPreferences as twinResolve,
} from '../supabase/functions/_shared/engines/coach-preferences.js';
import {
  enumerateCoachPreferenceProduct,
  projectOutcome,
} from '../supabase/functions/_shared/tests/coach-preference-product.js';

const digest = JSON.parse(
  readFileSync(
    path.join(
      process.cwd(),
      'supabase/functions/_shared/tests/coach-preference-product.digest.json'
    ),
    'utf8'
  )
);

const CASES = enumerateCoachPreferenceProduct();
/** @type {any[]} */
const coreOutcomes = CASES.map((c) => projectOutcome(coreResolve, coreJudge, c));
/** @type {any[]} */
const twinOutcomes = CASES.map((c) =>
  projectOutcome(
    (input) => twinResolve(/** @type {any} */ (input)),
    (resolution, candidate) => twinJudge(/** @type {any} */ (resolution), candidate),
    c
  )
);
const sha256 = (outcomes) => createHash('sha256').update(JSON.stringify(outcomes)).digest('hex');

/**
 * The product's size, from the arithmetic of its definition -- NOT from the enumerator, which is
 * what a shrunken product would corrupt. A: per dimension, the sum over n = 0..3 rules of
 * (2 levels x 4 kinds)^n, x 2 series x 2 candidates x 2 off-roster. B: per dimension, the sum over
 * n = 1..2, x 2 series x 2 candidates x 4 noises. C: 5^3 - 1 kind combinations (a kind or none per
 * dimension, not all none) x 2 levels x 8 match masks x 2 series. D: 3 x 3 dimension pairs x 4
 * level pairs x 2 coach layouts x 8 masks. E: 13 refusals.
 */
const sumPowers = (base, from, to) => {
  let total = 0;
  for (let n = from; n <= to; n += 1) total += base ** n;
  return total;
};
const EXPECTED_CASES =
  3 * sumPowers(8, 0, 3) * 8 + 3 * sumPowers(8, 1, 2) * 16 + (5 ** 3 - 1) * 2 * 8 * 2 + 3 * 3 * 4 * 2 * 8 + 13;

describe('the practice-preference arms agree over the full product', () => {
  it('the product is the full product, and exercises every branch it claims to', () => {
    expect(CASES).toHaveLength(EXPECTED_CASES);
    expect(new Set(CASES.map((c) => c.id)).size).toBe(CASES.length);
    const outcomes = coreOutcomes.filter((o) => !o.refused);
    // Each observable the twin could get wrong occurs, in both directions.
    const seen = (predicate) => outcomes.some(predicate);
    expect(seen((o) => o.verdict.mustKeepViolated)).toBe(true);
    expect(
      seen((o) => !o.verdict.mustKeepViolated && o.rules.some((r) => r.level === 'must' && r.conditions.length > 0))
    ).toBe(true);
    for (const breaches of [0, 1, 2, 3]) {
      expect(seen((o) => o.verdict.preferKeepBreaches === breaches)).toBe(true);
    }
    // A breach is one per unmet rule, however many of its conditions fail.
    expect(seen((o) => o.verdict.preferKeepBreaches === 1 && o.verdict.breachedDimensions.length > 1)).toBe(true);
    for (const source of ['values', 'current']) {
      expect(seen((o) => o.rules.some((r) => r.conditions.some((c) => c.source === source)))).toBe(true);
    }
    for (const code of [
      PRACTICE_REASON.COACH_PREFERENCE_CONFLICT,
      PRACTICE_REASON.COACH_PREFERENCE_NO_REFERENCE,
    ]) {
      for (const level of ['must', 'prefer']) {
        expect(
          seen((o) => o.findings.some((f) => f.code === code && f.details.level === level))
        ).toBe(true);
      }
    }
    for (const dimension of ['weekday', 'start_time', 'venue']) {
      for (const level of ['must', 'prefer']) {
        expect(
          seen((o) =>
            o.rules.some(
              (r) => r.level === level && r.conditions.some((c) => c.dimension === dimension)
            )
          )
        ).toBe(true);
      }
    }
    // The filters bite: a rule for another team or out of window is not resolved at all, a window
    // that holds the day is, and a coach who is not on the team asks nothing.
    const byNoise = (name) => outcomes.filter((o) => o.id.startsWith('B/') && o.id.endsWith(`/${name}`));
    for (const name of ['other-team', 'window-ended', 'window-not-started']) {
      expect(byNoise(name).length).toBeGreaterThan(0);
      expect(byNoise(name).every((o) => o.rules.length === 0)).toBe(true);
    }
    expect(byNoise('window-holds').every((o) => o.rules.length > 0)).toBe(true);
    expect(
      outcomes.filter((o) => o.id.endsWith('/off-roster')).every((o) => o.rules.every((r) => r.id !== 'r-off'))
    ).toBe(true);
    expect(coreOutcomes.filter((o) => o.refused)).toHaveLength(13);
  });

  it('every case agrees, value by value', () => {
    const differing = [];
    CASES.forEach((c, i) => {
      if (JSON.stringify(coreOutcomes[i]) !== JSON.stringify(twinOutcomes[i])) differing.push(c.id);
    });
    expect(differing.slice(0, 10)).toEqual([]);
    expect(differing).toHaveLength(0);
  });

  it("the committed digest is core's, and the twin's matches it", () => {
    expect(digest.cases).toBe(EXPECTED_CASES);
    expect(sha256(coreOutcomes)).toBe(digest.sha256);
    expect(sha256(twinOutcomes)).toBe(digest.sha256);
  });
});

describe('the twin is pinned to core constants', () => {
  it('the breach weight is RESOLVE_OBJECTIVE_WEIGHTS.coachPreferenceBreached (decision 1: 100)', () => {
    expect(COACH_PREFERENCE_BREACHED_WEIGHT).toBe(
      RESOLVE_OBJECTIVE_WEIGHTS.coachPreferenceBreached
    );
    expect(COACH_PREFERENCE_BREACHED_WEIGHT).toBe(100);
  });

  it("the Edge's unplaced reason is PRACTICE_TBD_REASON.COACH_PREFERENCE", () => {
    expect(COACH_PREFERENCE_TBD_REASON).toBe(PRACTICE_TBD_REASON.COACH_PREFERENCE);
  });

  it("the twin's finding codes are core's", () => {
    expect(COACH_PREFERENCE_FINDING.NO_REFERENCE).toBe(
      PRACTICE_REASON.COACH_PREFERENCE_NO_REFERENCE
    );
    expect(COACH_PREFERENCE_FINDING.CONFLICT).toBe(PRACTICE_REASON.COACH_PREFERENCE_CONFLICT);
  });
});
