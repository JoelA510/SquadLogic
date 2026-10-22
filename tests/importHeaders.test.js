import { describe, it, expect } from 'vitest';
import { matchHeaders } from '../frontend/src/utils/telemetryUtils.js';
import { isSensitiveHeader } from '../frontend/src/utils/gotsportCanonicalizer.js';
import {
  REQUIRED_HEADERS,
  normalizeImportHeader,
  findMissingRequiredHeaders,
  describeHeaderParse,
} from '../frontend/src/utils/importHeaders.js';

// Mirror the player-import header pipeline in ImportContext.jsx: drop sensitive
// columns, run the Smart Header Matcher, then check the required canonical set.
function resolve(rawFields, type = 'players') {
  const kept = rawFields.filter((h) => !isSensitiveHeader(h));
  const { mappings } = matchHeaders(kept, [], {});
  const missing = findMissingRequiredHeaders(kept, type, mappings);
  return { kept, mappings, missing };
}

// The pilot club's "PlayerRegistrations" GotSport export header row (comma CSV), club name
// replaced with a synthetic one.
const GOTSPORT_HEADERS = [
  'Registration ID',
  'Created',
  'Program',
  'Enroller First Name',
  'Enroller Last Name',
  'First Name',
  'Last Name',
  'Gender',
  'DOB',
  'Birth Year',
  'Email/UserID',
  'Contact Email',
  'Phone',
  'Allergies',
  'Medical Conditions',
  'Role',
  'Payment Plan',
  'Age Group',
  'Team',
  'Complete',
  'Submitted',
  'Submitted At',
  'Waitlist',
  'Payment Status',
  'Club Name',
  'Guardian 1 First Name',
  'Guardian 1 Last Name',
  'Guardian 1 Email Address',
  'Guardian 1 Mobile Phone Number',
  'Guardian 2 First Name',
  'Guardian 2 Last Name',
  'Emergency Contact One First Name',
  'Emergency Contact One Last Name',
  'Emergency Contact One Phone Number',
  'Physician First Name',
  'Physician Last Name',
  'Physician Phone Number',
  'Insurance Provider',
  'Insurance Policy Number',
  'Team ID',
  'Team Name',
  'Team Age',
  'Team Gender',
  'Photo Consent: I give consent for my player to be photographed videotaped or filmed and the resulting photos used for promotional purposes.',
  "Can you coach for this player's team?",
  'Are you coaching so this player can play up a division?',
  'Concussion Waiver: I agree that if I think my child or teen may have a concussion I will remove them from play and keep them out until cleared by a health care provider.',
  'How did you hear about Example Club and our recreational program?',
];

describe('importHeaders', () => {
  it('resolves first_name/last_name/date_of_birth from the real GotSport header row', () => {
    const { normalized, missing } = (() => {
      const r = resolve(GOTSPORT_HEADERS, 'players');
      const normalized = r.kept.map((h) => normalizeImportHeader(r.mappings, h));
      return { normalized, missing: r.missing };
    })();
    // Surface what resolved if this regresses.
    expect({ missing, has_first: normalized.includes('first_name') }).toEqual({
      missing: [],
      has_first: true,
    });
  });

  it('drops sensitive columns but keeps teaming-relevant ones', () => {
    const { kept } = resolve(GOTSPORT_HEADERS, 'players');
    for (const keepCol of [
      'First Name',
      'Last Name',
      'DOB',
      'Birth Year',
      'Email/UserID',
      'Contact Email',
    ]) {
      expect(kept).toContain(keepCol);
    }
    for (const dropCol of [
      'Allergies',
      'Medical Conditions',
      'Insurance Provider',
      'Insurance Policy Number',
      'Physician First Name',
      'Emergency Contact One First Name',
      'Emergency Contact One Phone Number',
    ]) {
      expect(kept).not.toContain(dropCol);
    }
    // Long consent / waiver free-text columns are dropped too.
    expect(kept.some((h) => /consent|waiver/i.test(h))).toBe(false);
  });

  it('flags every required column missing when the file does not split into columns', () => {
    // A wrong-delimiter parse collapses the whole header line into one field.
    const collapsed = [GOTSPORT_HEADERS.join(',')];
    expect(findMissingRequiredHeaders(collapsed, 'players', {})).toEqual([
      'first_name',
      'last_name',
      'date_of_birth',
    ]);
  });

  it('describeHeaderParse emits only non-PII shape signals (never header/cell values)', () => {
    const collapsed = [GOTSPORT_HEADERS.join(',')];
    const diag = describeHeaderParse({
      fields: collapsed,
      meta: { delimiter: ',' },
      parseErrors: [{ message: 'Too many fields: expected 1 field but parsed 95' }],
    });
    // Exact shape — guards against re-introducing raw header/cell fields.
    expect(diag).toEqual({
      column_count: 1,
      detected_delimiter: ',',
      parse_error_count: 1,
      first_parse_error: 'Too many fields: expected 1 field but parsed 95',
      max_header_length: collapsed[0].length,
      min_header_length: collapsed[0].length,
    });
    // A header-less upload makes PapaParse treat a data row as "headers", so the
    // persisted diagnostic must never contain raw field text.
    const serialized = JSON.stringify(diag);
    for (const value of ['First Name', 'DOB', 'Registration ID', 'Email']) {
      expect(serialized).not.toContain(value);
    }
  });

  it('normalizeImportHeader prefers the matcher mapping, else lowercased raw', () => {
    expect(normalizeImportHeader({ 'First Name': 'first_name' }, 'First Name')).toBe('first_name');
    expect(normalizeImportHeader({}, '  DOB ')).toBe('dob');
  });

  it('declares required canonical columns per import type', () => {
    expect(REQUIRED_HEADERS.players).toEqual(['first_name', 'last_name', 'date_of_birth']);
    expect(REQUIRED_HEADERS.coaches).toContain('email');
  });

  it('accepts First Name and Last Name for a coach full name (D1)', () => {
    expect(resolve(['First Name', 'Last Name', 'Email'], 'coaches').missing).toEqual([]);
    expect(resolve(['Full Name', 'Email'], 'coaches').missing).toEqual([]);
  });

  it('still requires a coach full name when only one half is present', () => {
    expect(resolve(['First Name', 'Email'], 'coaches').missing).toEqual(['full_name']);
    expect(resolve(['Last Name', 'Email'], 'coaches').missing).toEqual(['full_name']);
  });
});
