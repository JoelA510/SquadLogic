/**
 * Cross-arm drift check: core `practice/coachPreferences.js` against the Deno
 * twin `_shared/engines/coach-preferences.ts` (8.6 PR 3b plan §4 "Deno side",
 * §6 "Arms agree"; the `scoringEngineDrift` precedent).
 *
 * Both arms run over the FULL enumerated product
 * (`_shared/tests/coach-preference-product.ts`): 3 dimensions x 0-3 coaches x
 * every level combination x value set (kept, not kept) or null x series or
 * none x a matching and a mismatching candidate x with and without an
 * off-roster holder, plus every level combination across all three dimensions
 * at once, plus the inputs both must refuse. Compared value by value here, and
 * as a digest against `coach-preference-product.digest.json`, which the Deno
 * test (`coach-preferences_test.ts`, run by `scripts/deno-mirror-tests.sh`)
 * holds the twin to in the runtime it deploys to.
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
  strictestCoachPreferenceLevel as coreStrictest,
} from '@squadlogic/core/practice/index.js';
import { RESOLVE_OBJECTIVE_WEIGHTS } from '@squadlogic/core/resolve/objective.js';
import {
  COACH_PREFERENCE_BREACHED_WEIGHT,
  COACH_PREFERENCE_FINDING,
  COACH_PREFERENCE_TBD_REASON,
  judgeCoachPreferenceCandidate as twinJudge,
  resolveCoachPreferences as twinResolve,
  strictestCoachPreferenceLevel as twinStrictest,
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
 * The product's size, from the plan's own arithmetic -- NOT from the
 * enumerator, which is what a shrunken product would corrupt. Per dimension:
 * sum over n = 0..3 of 3^n levels x 3^n value sources, x 2 series x 2
 * candidates x 2 off-roster. Plus 27 x 8 all-dimension cases and 2 refusals.
 */
const EXPECTED_CASES = 3 * [0, 1, 2, 3].reduce((s, n) => s + 9 ** n, 0) * 8 + 27 * 8 + 2;

describe('the coach-preference arms agree over the full product', () => {
  it('the product is the full product, and exercises every branch it claims to', () => {
    expect(CASES).toHaveLength(EXPECTED_CASES);
    expect(new Set(CASES.map((c) => c.id)).size).toBe(CASES.length);
    const outcomes = coreOutcomes.filter((o) => !o.refused);
    // Each observable the twin could get wrong occurs, in both directions.
    const seen = (predicate) => outcomes.some(predicate);
    expect(seen((o) => o.verdict.mustKeepViolated)).toBe(true);
    expect(
      seen((o) => !o.verdict.mustKeepViolated && o.dimensions.some((d) => d.level === 'must_keep'))
    ).toBe(true);
    for (const breaches of [0, 1, 2, 3]) {
      expect(seen((o) => o.verdict.preferKeepBreaches === breaches)).toBe(true);
    }
    expect(seen((o) => o.dimensions.some((d) => d.unsatisfiable))).toBe(true);
    for (const source of ['value', 'series', 'mixed', null]) {
      expect(seen((o) => o.dimensions.some((d) => d.source === source))).toBe(true);
    }
    for (const code of [
      PRACTICE_REASON.COACH_PREFERENCE_CONFLICT,
      PRACTICE_REASON.COACH_PREFERENCE_NO_REFERENCE,
    ]) {
      for (const level of ['must_keep', 'prefer_keep']) {
        expect(
          seen((o) => o.findings.some((f) => f.code === code && f.details.level === level))
        ).toBe(true);
      }
    }
    for (const dimension of ['weekday', 'start_time', 'venue']) {
      for (const level of ['must_keep', 'prefer_keep', 'dont_care']) {
        expect(
          seen((o) => o.dimensions.some((d) => d.dimension === dimension && d.level === level))
        ).toBe(true);
      }
    }
    expect(coreOutcomes.filter((o) => o.refused)).toHaveLength(2);
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

  it('strictest-wins agrees on every level multiset of size 0-3, and both refuse an unknown level', () => {
    const levels = ['must_keep', 'prefer_keep', 'dont_care'];
    let compared = 0;
    for (let n = 0; n <= 3; n += 1) {
      let combos = [[]];
      for (let i = 0; i < n; i += 1) combos = combos.flatMap((p) => levels.map((l) => [...p, l]));
      for (const combo of combos) {
        expect(twinStrictest(combo)).toBe(coreStrictest(combo));
        compared += 1;
      }
    }
    expect(compared).toBe(1 + 3 + 9 + 27);
    expect(() => coreStrictest(['always'])).toThrow();
    expect(() => twinStrictest(['always'])).toThrow();
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
