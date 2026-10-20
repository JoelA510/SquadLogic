/**
 * The import-validation Edge Function's sensitive-header rule, in the runtime
 * it is deployed to (plan docs/changes/2026-10-20-phase-a-privacy.md, A1).
 * `tests/sensitiveHeaderParity.test.js` (Vitest) holds this copy equal to the
 * browser's; this file asks the Deno build the same questions.
 */

import { assertEquals } from 'https://deno.land/std@0.203.0/assert/mod.ts';
import { isSensitiveHeader, stripSensitiveColumns } from '../sensitive-headers.ts';

Deno.test('medical, condition, need and emergency columns are dropped', () => {
  for (const header of [
    'Medical Conditions',
    'medical_info',
    'Conditions',
    'Special Needs',
    'Medication',
    'Diagnosis',
    'Disability',
    'Allergies',
    'Emergency Contact Phone',
    'emergency_contacts',
  ]) {
    assertEquals(isSensitiveHeader(header), true, header);
  }
});

Deno.test('teaming and contact columns are kept', () => {
  for (const header of [
    'First Name',
    'Date of Birth',
    'Division',
    'Guardian 1 Email',
    'Payment Status',
    'payment_status',
  ]) {
    assertEquals(isSensitiveHeader(header), false, header);
  }
});

Deno.test('a row keeps every other column as given', () => {
  assertEquals(
    stripSensitiveColumns({ 'First Name': 'Avery', 'Special Needs': 'x', medical_info: 'x' }),
    { 'First Name': 'Avery' }
  );
});
