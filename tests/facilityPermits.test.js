/**
 * Field and venue permits (`packages/core/src/facility/permits.js`; migration
 * `20261102010000_facility_permits.sql`).
 *
 * The core module is the client's twin of rules the database holds: the table's CHECKs, the status
 * function, the bucket's limits and the object path its policies accept. The boundaries here are
 * the same ones `supabase/tests/facility_permits.sql` asserts in SQL.
 */
import { describe, expect, it } from 'vitest';

import {
  PERMIT_MAX_FILE_BYTES,
  PermitFileSchema,
  PermitInputSchema,
  fieldsWithoutPermit,
  permitFieldIds,
  permitObjectPath,
  permitStatus,
  permitWarnings,
  coachPermitSummary,
  sortPermitsForCoach,
} from '@squadlogic/core/facility/permits.js';

const ORG = 'a1111111-1111-4111-8111-111111111111';
const PERMIT = 'f6000000-0000-4000-8000-00000000000a';
const FIELD = 'f1000000-0000-4000-8000-000000000011';
const VENUE = 'f1000000-0000-4000-8000-000000000001';

const input = (over = {}) => ({
  issuer: 'Parks Dept',
  permitNumber: '0042',
  validFrom: '2026-09-01',
  validTo: '2026-12-31',
  notes: '',
  locationIds: [],
  fieldIds: [FIELD],
  ...over,
});

describe('PermitInputSchema', () => {
  it('trims, keeps a number as text with its leading zeros, and turns blanks into null', () => {
    const parsed = PermitInputSchema.parse(
      input({ issuer: '  Parks Dept ', permitNumber: ' 0042 ', notes: '   ' })
    );
    expect(parsed.issuer).toBe('Parks Dept');
    expect(parsed.permitNumber).toBe('0042');
    expect(parsed.notes).toBeNull();
    expect(PermitInputSchema.parse(input({ permitNumber: '' })).permitNumber).toBeNull();
    expect(PermitInputSchema.parse(input({ permitNumber: undefined })).permitNumber).toBeNull();
  });

  it('accepts a one-day permit: valid_to is the last valid day, inclusive', () => {
    expect(
      PermitInputSchema.safeParse(input({ validFrom: '2026-10-01', validTo: '2026-10-01' })).success
    ).toBe(true);
  });

  it('refuses a permit that ends before it begins, naming the end date', () => {
    const result = PermitInputSchema.safeParse(
      input({ validFrom: '2026-10-02', validTo: '2026-10-01' })
    );
    expect(result.success).toBe(false);
    expect(result.error.issues[0].path).toEqual(['validTo']);
  });

  it('refuses a blank issuer, a number over 100, notes over 2000 and a date that is not a date string', () => {
    expect(PermitInputSchema.safeParse(input({ issuer: '   ' })).success).toBe(false);
    expect(PermitInputSchema.safeParse(input({ issuer: 'x'.repeat(201) })).success).toBe(false);
    expect(PermitInputSchema.safeParse(input({ permitNumber: '9'.repeat(101) })).success).toBe(
      false
    );
    expect(PermitInputSchema.safeParse(input({ permitNumber: '9'.repeat(100) })).success).toBe(
      true
    );
    expect(PermitInputSchema.safeParse(input({ notes: 'n'.repeat(2001) })).success).toBe(false);
    expect(PermitInputSchema.safeParse(input({ validFrom: '10/01/2026' })).success).toBe(false);
  });

  it('needs at least one venue or field, counting one named twice once', () => {
    expect(PermitInputSchema.safeParse(input({ fieldIds: [], locationIds: [] })).success).toBe(
      false
    );
    expect(PermitInputSchema.safeParse(input({ fieldIds: [], locationIds: [VENUE] })).success).toBe(
      true
    );
    const twice = PermitInputSchema.parse(input({ fieldIds: [FIELD, FIELD] }));
    expect(twice.fieldIds).toEqual([FIELD]);
  });

  it('refuses an empty id and an unknown key', () => {
    expect(PermitInputSchema.safeParse(input({ fieldIds: [''] })).success).toBe(false);
    expect(PermitInputSchema.safeParse({ ...input(), surprise: 1 }).success).toBe(false);
  });
});

describe('PermitFileSchema', () => {
  const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]);
  const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00]);
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d]);
  const file = (over = {}) => ({
    name: 'permit.pdf',
    type: 'application/pdf',
    size: 52_000,
    headBytes: PDF,
    ...over,
  });

  it('accepts a PDF, a JPEG and a PNG whose first bytes are their own, with the extension to store', () => {
    expect(PermitFileSchema.parse(file()).extension).toBe('pdf');
    expect(
      PermitFileSchema.parse(file({ type: 'image/jpeg', headBytes: JPEG, name: 'a.jpeg' }))
        .extension
    ).toBe('jpg');
    expect(
      PermitFileSchema.parse(file({ type: 'image/png', headBytes: PNG, name: 'a.png' })).extension
    ).toBe('png');
  });

  it('refuses a declared PDF that is not one: the bucket trusts the declared type, so the bytes are read', () => {
    const html = new TextEncoder().encode('<html>');
    const result = PermitFileSchema.safeParse(file({ headBytes: html }));
    expect(result.success).toBe(false);
    expect(result.error.issues[0].message).toMatch(/not a real PDF/);
    // A PNG's bytes under a JPEG label are refused too: the match is per type.
    expect(PermitFileSchema.safeParse(file({ type: 'image/jpeg', headBytes: PNG })).success).toBe(
      false
    );
  });

  it('refuses a type outside PDF, JPEG and PNG, naming HEIC', () => {
    const result = PermitFileSchema.safeParse(file({ type: 'image/heic' }));
    expect(result.success).toBe(false);
    expect(result.error.issues[0].message).toMatch(/HEIC/);
    expect(PermitFileSchema.safeParse(file({ type: 'text/html' })).success).toBe(false);
  });

  it('takes exactly 10 MiB and refuses one byte more, and an empty file', () => {
    expect(PermitFileSchema.safeParse(file({ size: PERMIT_MAX_FILE_BYTES })).success).toBe(true);
    expect(PermitFileSchema.safeParse(file({ size: PERMIT_MAX_FILE_BYTES + 1 })).success).toBe(
      false
    );
    expect(PermitFileSchema.safeParse(file({ size: 12 * 1024 * 1024 })).success).toBe(false);
    expect(PermitFileSchema.safeParse(file({ size: 0 })).success).toBe(false);
  });

  it('refuses a file name with a slash or over 255 characters', () => {
    expect(PermitFileSchema.safeParse(file({ name: '../permit.pdf' })).success).toBe(false);
    expect(PermitFileSchema.safeParse(file({ name: 'a\\b.pdf' })).success).toBe(false);
    expect(PermitFileSchema.safeParse(file({ name: 'a'.repeat(256) })).success).toBe(false);
  });
});

describe('permitObjectPath', () => {
  const FILE = 'c0000000-0000-4000-8000-000000000001';

  it('is <organization>/<permit>/<uuid>.<ext>, the shape the bucket policies accept', () => {
    const path = permitObjectPath(ORG, PERMIT, 'pdf', FILE);
    expect(path).toBe(`${ORG}/${PERMIT}/${FILE}.pdf`);
    expect(path).toMatch(/^[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.(pdf|jpg|jpeg|png)$/);
  });

  it('draws a new file name each call, so a replaced file is never overwritten', () => {
    expect(permitObjectPath(ORG, PERMIT, 'png')).not.toBe(permitObjectPath(ORG, PERMIT, 'png'));
  });

  it('refuses what the database would: ids that are not UUIDs, and an extension outside the four', () => {
    expect(() => permitObjectPath('org', PERMIT, 'pdf', FILE)).toThrow(/organization id/);
    expect(() => permitObjectPath(ORG, 'permit', 'pdf', FILE)).toThrow(/permit id/);
    expect(() => permitObjectPath(ORG, PERMIT, 'pdf', 'x')).toThrow(/file id/);
    expect(() => permitObjectPath(ORG, PERMIT, 'html', FILE)).toThrow(/extension/);
    expect(() => permitObjectPath(null, PERMIT, 'pdf', FILE)).toThrow();
  });
});

describe('permitStatus', () => {
  const today = '2026-10-27';

  it('judges the boundaries the pgTAP file asserts: today, +30, +31, yesterday, tomorrow', () => {
    expect(permitStatus('2026-01-01', '2026-10-27', today)).toEqual({
      status: 'expiring',
      daysLeft: 0,
    });
    expect(permitStatus('2026-01-01', '2026-11-26', today)).toEqual({
      status: 'expiring',
      daysLeft: 30,
    });
    expect(permitStatus('2026-01-01', '2026-11-27', today)).toEqual({
      status: 'valid',
      daysLeft: 31,
    });
    expect(permitStatus('2026-01-01', '2026-10-26', today)).toEqual({
      status: 'expired',
      daysLeft: -1,
    });
    expect(permitStatus('2026-10-28', '2027-01-01', today).status).toBe('not_yet_valid');
    expect(permitStatus('2026-10-27', '2026-10-27', today).status).toBe('expiring');
  });

  it('counts days across a month, a year and a leap day', () => {
    expect(permitStatus('2026-01-01', '2027-01-05', '2026-12-31').daysLeft).toBe(5);
    expect(permitStatus('2027-01-01', '2028-03-01', '2028-02-28').daysLeft).toBe(2); // 2028 is a leap year
    expect(permitStatus('2027-01-01', '2027-03-01', '2027-02-28').daysLeft).toBe(1);
  });

  it("judges on the day it is given, so the organization's calendar, not the machine's, decides", () => {
    // The same permit on the same instant: it is the last valid day in one zone and expired in the
    // next. The database tells the client the day (`today` in get_facility_permits).
    expect(permitStatus('2026-01-01', '2026-10-27', '2026-10-27').status).toBe('expiring');
    expect(permitStatus('2026-01-01', '2026-10-27', '2026-10-28').status).toBe('expired');
  });

  it('refuses what is not a date, rather than answering', () => {
    expect(() => permitStatus('2026-01-01', 'tomorrow', '2026-10-27')).toThrow(/validTo/);
    expect(() => permitStatus('2026-01-01', '2026-10-27', undefined)).toThrow(/today/);
  });
});

describe('the warnings', () => {
  const venues = [
    { id: 'v1', name: 'Permit Park', effective_to: null },
    { id: 'v2', name: 'Far Park', effective_to: '2026-06-30' },
  ];
  const fields = [
    { id: 'f1', name: 'Pitch 1', location_id: 'v1', active: true, effective_to: null },
    { id: 'f2', name: 'Pitch 2', location_id: 'v1', active: true, effective_to: null },
    { id: 'f3', name: 'Pitch 3', location_id: 'v2', active: true, effective_to: null },
    { id: 'f4', name: 'Pitch 4', location_id: 'v1', active: false, effective_to: null },
    { id: 'f5', name: 'Pitch 5', location_id: 'v1', active: true, effective_to: '2026-09-01' },
  ];
  const permit = (over) => ({
    id: 'p',
    status: 'valid',
    valid_to: '2027-01-01',
    file: { path: 'x', name: 'x.pdf', mime: 'application/pdf', size: 1 },
    scopes: [{ kind: 'field', field_id: 'f1', location_id: 'v1' }],
    ...over,
  });
  const today = '2026-10-27';

  it('lists the live fields no current permit with a file covers, from the fields rather than the permits', () => {
    const without = fieldsWithoutPermit({ fields, locations: venues, permits: [permit()], today });
    // f1 is covered; f3 is at a retired venue, f4 is inactive and f5 is retired: none of them needs one.
    expect(without.map((field) => field.id)).toEqual(['f2']);
    expect(without[0]).toMatchObject({ name: 'Pitch 2', locationName: 'Permit Park' });
  });

  it('with no permit at all, every live field is listed (the case that proves the check can fail)', () => {
    expect(
      fieldsWithoutPermit({ fields, locations: venues, permits: [], today }).map((f) => f.id)
    ).toEqual(['f1', 'f2']);
  });

  it('a venue permit covers every field at the venue', () => {
    const venuePermit = permit({
      scopes: [{ kind: 'location', field_id: null, location_id: 'v1' }],
    });
    expect(
      fieldsWithoutPermit({ fields, locations: venues, permits: [venuePermit], today })
    ).toEqual([]);
    expect([...permitFieldIds(venuePermit, fields)].sort()).toEqual(['f1', 'f2', 'f4', 'f5']);
  });

  it('a permit with no file, an expired one and one not yet valid do not count as current', () => {
    for (const weak of [
      permit({ file: null }),
      permit({ status: 'expired' }),
      permit({ status: 'not_yet_valid' }),
    ]) {
      expect(
        fieldsWithoutPermit({ fields, locations: venues, permits: [weak], today }).map((f) => f.id)
      ).toContain('f1');
    }
    // An expiring permit still covers: the expiring warning is its own.
    expect(
      fieldsWithoutPermit({
        fields,
        locations: venues,
        permits: [permit({ status: 'expiring' })],
        today,
      }).map((f) => f.id)
    ).not.toContain('f1');
  });

  it('counts expiring, expired and uncovered fields, soonest first', () => {
    const warnings = permitWarnings({
      fields,
      locations: venues,
      today,
      permits: [
        permit({ id: 'a', status: 'expiring', valid_to: '2026-11-20' }),
        permit({ id: 'b', status: 'expiring', valid_to: '2026-10-30' }),
        permit({ id: 'c', status: 'expired', valid_to: '2026-10-01', scopes: [] }),
        permit({ id: 'd', status: 'valid' }),
      ],
    });
    expect(warnings.expiring.map((p) => p.id)).toEqual(['b', 'a']);
    expect(warnings.expired.map((p) => p.id)).toEqual(['c']);
    expect(warnings.fieldsWithout.map((f) => f.id)).toEqual(['f2']);
    expect(warnings.count).toBe(4);
  });
});

describe('what a coach is told (Phase C3)', () => {
  const file = { path: 'x', name: 'x.pdf', mime: 'application/pdf', size: 1 };
  const p = (id, status, over = {}) => ({
    id,
    issuer: `Issuer ${id}`,
    status,
    valid_to: '2026-12-01',
    file,
    ...over,
  });

  it('sorts what can be produced first, soonest to end first, and the expired last', () => {
    const permits = [
      p('exp', 'expired', { valid_to: '2026-10-01' }),
      p('yet', 'not_yet_valid', { valid_to: '2027-05-01' }),
      p('none', 'valid', { file: null }),
      p('late', 'valid', { valid_to: '2027-03-01' }),
      p('soon', 'expiring', { valid_to: '2026-11-05' }),
    ];
    const before = permits.map((permit) => permit.id);
    expect(sortPermitsForCoach(permits).map((permit) => permit.id)).toEqual([
      'soon',
      'late',
      'none',
      'yet',
      'exp',
    ]);
    // A copy: the answer the server gave is not reordered under the caller.
    expect(permits.map((permit) => permit.id)).toEqual(before);
  });

  it('breaks a tie by issuer, then id, so the order never depends on arrival order', () => {
    const a = p('a', 'valid', { issuer: 'Same' });
    const b = p('b', 'valid', { issuer: 'Same' });
    expect(sortPermitsForCoach([b, a]).map((permit) => permit.id)).toEqual(['a', 'b']);
    expect(sortPermitsForCoach([a, b]).map((permit) => permit.id)).toEqual(['a', 'b']);
  });

  it('is clear when every permit is in date with a file, and says nothing for no permits', () => {
    expect(coachPermitSummary([p('a', 'valid'), p('b', 'valid')])).toMatchObject({
      total: 2,
      clear: true,
      attention: [],
    });
    expect(coachPermitSummary([])).toMatchObject({ total: 0, clear: true, attention: [] });
  });

  it('flags each concern once, and a permit with two concerns is listed once', () => {
    const summary = coachPermitSummary([
      p('ok', 'valid'),
      p('exp', 'expired', { file: null }),
      p('soon', 'expiring', { file: null }),
      p('yet', 'not_yet_valid'),
      p('none', 'valid', { file: null }),
    ]);
    // An expired permit with no file is expired, not "no file" as well: there is nothing to add.
    expect(summary.expired.map((x) => x.id)).toEqual(['exp']);
    expect(summary.noFile.map((x) => x.id)).toEqual(['soon', 'none']);
    expect(summary.expiring.map((x) => x.id)).toEqual(['soon']);
    expect(summary.notYetValid.map((x) => x.id)).toEqual(['yet']);
    // Most urgent first: expired, no file, expiring, not yet valid; "soon" once, among no-file ones.
    expect(summary.attention.map((x) => x.id)).toEqual(['exp', 'none', 'soon', 'yet']);
    expect(summary.clear).toBe(false);
  });

  it('never refuses: an expired permit is still returned for display', () => {
    const only = p('exp', 'expired');
    expect(coachPermitSummary([only]).attention).toEqual([only]);
    expect(sortPermitsForCoach([only])).toEqual([only]);
  });
});
