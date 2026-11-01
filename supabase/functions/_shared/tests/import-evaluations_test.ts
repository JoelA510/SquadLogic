/**
 * The evaluations import's row rules, in the runtime they are deployed to (E3c of
 * docs/changes/2026-10-27-season-enrollment.md). `tests/importEvaluationsParity.test.js` (Vitest)
 * holds this copy equal to the browser's; this file asks the Deno build the same questions.
 * Placeholder values only.
 */

import { assertEquals } from 'https://deno.land/std@0.203.0/assert/mod.ts';
import { evaluationRegistrationId, validateEvaluationRow } from '../import-evaluations.ts';

const ID = { external_registration_id: 'GS-1' };

Deno.test('a row in range, a blank cell and a zero are valid', () => {
  assertEquals(
    validateEvaluationRow({ ...ID, years_played: '3', skill_tier: 'Developing', rating: '4' }),
    []
  );
  assertEquals(validateEvaluationRow({ ...ID, years_played: '', skill_tier: ' ', rating: '' }), []);
  assertEquals(validateEvaluationRow({ ...ID, years_played: '0' }), []);
  assertEquals(validateEvaluationRow({ ...ID, years_played: '30', rating: '5' }), []);
});

Deno.test('each bad cell is its own error, with the field and no value', () => {
  const errors = validateEvaluationRow({
    years_played: '31',
    skill_tier: 'gold',
    rating: '6',
  });
  assertEquals(
    errors.map((e) => e.field),
    ['external_registration_id', 'years_played', 'skill_tier', 'rating']
  );
  assertEquals(/31|gold|6$/.test(errors.map((e) => e.message).join(' ')), false);
});

Deno.test('the registration id is text: leading zeros stay, the first filled key wins', () => {
  assertEquals(evaluationRegistrationId({ player_id: '0042' }), '0042');
  assertEquals(evaluationRegistrationId({ gotsport_id: ' 7 ', player_id: '0042' }), '7');
  assertEquals(evaluationRegistrationId({ external_registration_id: '  ' }), null);
});
