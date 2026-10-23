import { describe, expect, it } from 'vitest';
import * as browser from '../frontend/src/utils/gotsportCanonicalizer.js';
import * as edge from '../supabase/functions/_shared/sensitive-headers.ts';

/**
 * The sensitive-header rule has two copies: the browser filter strips columns
 * before upload, and import-validation strips them again before it stages a
 * row, because the function can be called without the browser (plan
 * docs/changes/2026-10-20-phase-a-privacy.md, A1). This holds the two equal:
 * the same patterns, the same exceptions, and the same answer on every header
 * below. The corpus is listed here, not derived from either copy, so a pattern
 * dropped from both is caught by the expected answers too.
 */

const SENSITIVE = [
  // Medical, conditions and needs (owner decision 2026-10-20)
  'Medical Conditions',
  'Medical Info',
  'medical_info',
  'MEDICAL',
  'Conditions',
  'Pre-existing condition',
  'Special Needs',
  'special_needs',
  'Medication',
  'Current medications',
  'Diagnosis',
  'Disability',
  'Allergies',
  'Physician Name',
  'MedicalInfo',
  'medicalConditions',
  'PreexistingConditions',
  'specialNeeds',
  // Emergency contacts
  'Emergency Contact Phone',
  'emergency_contacts',
  'Emergency Contact One First Name__2',
  // A sample of the older categories
  'Insurance Provider',
  'Payment Plan',
  // Kept for players.paid until it was dropped (20261022020000)
  'Payment Status',
  'payment_status',
  'Birth Certificate',
  'Waiver Signed',
  '﻿Medical Conditions',
];

const KEPT = [
  'First Name',
  'Last Name',
  'Date of Birth',
  'DOB',
  'Gender',
  'Division',
  'Age Group',
  'Registration ID',
  'Guardian 1 Email',
  'guardian_1_email',
  'Buddy Request',
  'Skill Level',
  'Years Played',
  "Can you coach for this player's team?",
  'Phone',
  'FirstName',
  'dateOfBirth',
  'guardianEmail',
];

describe('the sensitive-header rule, browser and Edge copies', () => {
  it('has the same patterns and the same exceptions in both copies', () => {
    const asText = (list) => list.map((re) => `${re.source}/${re.flags}`);
    expect(asText(edge.SENSITIVE_PATTERNS)).toEqual(asText(browser.SENSITIVE_PATTERNS));
    expect(asText(edge.ALLOWED_HEADERS)).toEqual(asText(browser.ALLOWED_HEADERS));
  });

  it('strips the same import types in both copies: people, not fields', () => {
    expect([...edge.SENSITIVE_IMPORT_TYPES]).toEqual([...browser.SENSITIVE_IMPORT_TYPES]);
    expect([...edge.SENSITIVE_IMPORT_TYPES].sort()).toEqual(['coaches', 'players']);
  });

  it.each(SENSITIVE)('both copies drop %j', (header) => {
    expect(browser.isSensitiveHeader(header)).toBe(true);
    expect(edge.isSensitiveHeader(header)).toBe(true);
  });

  it.each(KEPT)('both copies keep %j', (header) => {
    expect(browser.isSensitiveHeader(header)).toBe(false);
    expect(edge.isSensitiveHeader(header)).toBe(false);
  });

  it('strips a row the same way in both copies, keeping every other column as given', () => {
    const row = {
      'First Name': 'Avery',
      'Special Needs': 'x',
      medical_info: 'x',
      Conditions: 'x',
      'Guardian 1 Email': 'parent@example.test',
      'Payment Status': 'PAID',
    };
    const expected = {
      'First Name': 'Avery',
      'Guardian 1 Email': 'parent@example.test',
    };
    expect(edge.stripSensitiveColumns(row)).toEqual(expected);
    expect(browser.stripSensitiveColumns([row])).toEqual([expected]);
  });
});
