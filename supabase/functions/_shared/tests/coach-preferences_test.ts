/**
 * The Deno arm of the coach-preference drift check (8.6 PR 3b plan §4).
 *
 * Runs the twin `_shared/engines/coach-preferences.ts` over the full
 * enumerated product (`coach-preference-product.ts`) in the runtime it deploys
 * to, and holds the canonical outcome digest to
 * `coach-preference-product.digest.json` -- the digest of CORE's outcomes,
 * which `tests/coachPreferenceDrift.test.js` asserts under Vitest, alongside a
 * value-by-value comparison of the two arms. Either arm drifting turns one of
 * the two runs red.
 */

import { assert, assertEquals } from 'https://deno.land/std@0.203.0/assert/mod.ts';
import {
  COACH_PREFERENCE_BREACHED_WEIGHT,
  judgeCoachPreferenceCandidate,
  resolveCoachPreferences,
} from '../engines/coach-preferences.ts';
import { enumerateCoachPreferenceProduct, projectOutcome } from './coach-preference-product.ts';
import digest from './coach-preference-product.digest.json' with { type: 'json' };

async function sha256(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

Deno.test(
  "coach preferences - the twin reproduces core's outcome digest over the full product",
  async () => {
    const cases = enumerateCoachPreferenceProduct();
    // Meta-assertion: the digest file records how many cases core was run on,
    // so a shrunken product cannot match a digest of a smaller one by accident.
    assertEquals(cases.length, digest.cases);
    assert(cases.length > 19000, `the product holds only ${cases.length} cases`);
    const outcomes = cases.map((c) =>
      projectOutcome(
        (input) => resolveCoachPreferences(input as Parameters<typeof resolveCoachPreferences>[0]),
        (resolution, candidate) =>
          judgeCoachPreferenceCandidate(
            resolution as ReturnType<typeof resolveCoachPreferences>,
            candidate
          ),
        c
      )
    );
    assertEquals(await sha256(JSON.stringify(outcomes)), digest.sha256);
  }
);

Deno.test('coach preferences - the breach weight is the objective weight (decision 1)', () => {
  assertEquals(COACH_PREFERENCE_BREACHED_WEIGHT, 100);
});
