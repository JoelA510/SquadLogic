import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  canonicalizeForUpload,
  isSensitiveHeader,
  makeDedupeHeaderTransformer,
  stripSensitiveColumns,
} from '../frontend/src/utils/gotsportCanonicalizer.js';

/** Zip headers->values, applying the dedupe transformer like PapaParse would. */
function rowFromCsv(headers, values) {
  const transform = makeDedupeHeaderTransformer();
  /** @type {Record<string, string>} */
  const row = {};
  headers.forEach((h, i) => {
    row[transform(h)] = values[i];
  });
  return row;
}

test('makeDedupeHeaderTransformer suffixes repeated headers', () => {
  const t = makeDedupeHeaderTransformer();
  assert.equal(t('Playing Up'), 'Playing Up');
  assert.equal(t('Playing Up'), 'Playing Up__2');
  assert.equal(t('Playing Up'), 'Playing Up__3');
  // Case-insensitive dedupe, original casing preserved on first occurrence.
  assert.equal(t('first name'), 'first name');
});

test('isSensitiveHeader flags sensitive columns', () => {
  for (const h of [
    'Medical Conditions',
    'Allergies',
    'Medication',
    'Health Notes',
    'Insurance Provider',
    'Policy Number',
    'Payment Plan',
    'Payment Status',
    'Amount Paid',
    'Outstanding Balance',
    'Financial Aid',
    'Scholarship',
    'Credit Card Number',
    'Social Security Number',
    'SSN',
    'Birth Certificate',
    'Passport Number',
    'Document Upload',
    'Proof of Residency',
    'Ethnicity',
    'Household Income',
    'Waiver Signed',
    'Consent Form',
    'E-Signature',
    'Photo Consent: I give consent for my player to be photographed',
    'Emergency Contact Name',
    'Emergency Contact One First Name',
    'Emergency Contact Two Phone Number',
    'Emergency Phone',
    'Emergency Relation',
    'Emergency Name',
  ]) {
    assert.equal(isSensitiveHeader(h), true, `expected sensitive: ${h}`);
  }
});

test('isSensitiveHeader keeps teaming-relevant columns (no false positives)', () => {
  for (const h of [
    'First Name',
    'Last Name',
    'Full Name',
    'Date of Birth',
    'DOB',
    'Birth Year',
    'Gender',
    'Email',
    'Email Address',
    'Phone',
    'Mobile Phone',
    'Program',
    'Division',
    'Age Group',
    'Skill Level',
    'Registration ID',
    'Buddy ID',
    'Buddy Request',
    'Guardian 1 Email Address',
    'Guardian 2 Mobile Phone Number',
    'Parent Name',
    'Playing Up',
    'Preferred Co-Coach',
    'Team',
    'Club',
    'Waitlist',
  ]) {
    assert.equal(isSensitiveHeader(h), false, `expected kept: ${h}`);
  }
});

test('isSensitiveHeader ignores the dedupe __n suffix', () => {
  assert.equal(isSensitiveHeader('Medical Conditions__2'), true);
  assert.equal(isSensitiveHeader('Playing Up__2'), false);
});

test('isSensitiveHeader strips a leading UTF-8 BOM before matching', () => {
  const bom = String.fromCharCode(0xfeff);
  assert.equal(isSensitiveHeader(`${bom}Medical Conditions`), true);
  assert.equal(isSensitiveHeader(`${bom}First Name`), false);
});

test('stripSensitiveColumns drops sensitive keys, preserves the rest verbatim', () => {
  const rows = [
    {
      'First Name': 'Alex',
      'Last Name': 'Smith',
      'Date of Birth': '2015-01-01',
      'Medical Conditions': 'asthma',
      'Payment Plan': '2026 U07B Academy Registration',
      'Payment Status': 'PAID',
      'Insurance Provider': 'Acme',
    },
  ];
  const out = stripSensitiveColumns(rows);
  assert.deepEqual(out, [
    {
      'First Name': 'Alex',
      'Last Name': 'Smith',
      'Date of Birth': '2015-01-01',
      // Payment Status went with players.paid (20261022020000): every payment
      // column is stripped now.
    },
  ]);
});

test('canonicalizeForUpload strips for players/coaches, passes through other types', () => {
  const rows = [{ 'First Name': 'Sam', 'Medical Conditions': 'none' }];
  assert.deepEqual(canonicalizeForUpload('players', rows), [{ 'First Name': 'Sam' }]);
  assert.deepEqual(canonicalizeForUpload('coaches', rows), [{ 'First Name': 'Sam' }]);
  // Field / field_availability imports are untouched.
  assert.deepEqual(canonicalizeForUpload('fields', rows), rows);
  assert.deepEqual(canonicalizeForUpload('field_availability', rows), rows);
});

test('canonicalizeForUpload is a no-op for the e2e ingestion fixtures (regression)', () => {
  // Headers used by tests/e2e/steps/data_and_output.ts — none are sensitive, so
  // the privacy filter must leave every column intact.
  const player = rowFromCsv(
    ['First Name', 'Last Name', 'Date of Birth', 'Registration ID', 'Division', 'Buddy ID'],
    ['Avery', 'Adams', '2016-04-02', 'GS-BUDDY-A', 'U8 Coed', 'GS-BUDDY-B']
  );
  assert.deepEqual(canonicalizeForUpload('players', [player]), [player]);

  const skill = rowFromCsv(
    ['First Name', 'Last Name', 'Skill Level'],
    ['Alex', 'Smith', 'advanced']
  );
  assert.deepEqual(canonicalizeForUpload('players', [skill]), [skill]);

  const coach = rowFromCsv(
    ['full_name', 'email', 'phone'],
    ['CSV Coach', 'csvcoach@example.com', '555-1212']
  );
  assert.deepEqual(canonicalizeForUpload('coaches', [coach]), [coach]);
});

test('canonicalizeForUpload tolerates non-array input', () => {
  assert.deepEqual(canonicalizeForUpload('players', null), []);
  assert.deepEqual(stripSensitiveColumns(undefined), []);
});
