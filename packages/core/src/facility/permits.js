/**
 * Field and venue permits: what the admin enters, what a file must be, where it is stored, and
 * the warnings that come of them (plan `docs/changes/2026-10-22-phase-c-permits.md`, C2).
 *
 * **A permit never blocks anything** (owner, 2026-10-26). Nothing in this module, and nothing that
 * calls it, refuses an import, a scheduling run, a publish or an export: a missing, expiring or
 * expired permit is a warning an admin reads, nothing more.
 *
 * Pure: no React, no `Date` construction (a permit's dates are wall-clock `YYYY-MM-DD` compared as
 * strings, on the organization's own day, which the database tells the client: `get_facility_permits`
 * returns `today`). The database is the authority on every rule here and these are its twins:
 * `facility_permit_status`, the table's CHECK constraints, the bucket's limits and the
 * `facility-permits` policies' path shape (migration `20261102010000_facility_permits.sql`);
 * `tests/facilityPermits.test.js` holds the boundaries equal.
 *
 * @module facility/permits
 */

import { z } from 'zod';
import { isLiveOn } from './lifecycle.js';

/** Days before `valid_to` a permit starts to warn. Fixed (owner decision 4); a setting if asked. */
export const PERMIT_LEAD_DAYS = 30;

/** The bucket's size limit: 10 MiB. */
export const PERMIT_MAX_FILE_BYTES = 10 * 1024 * 1024;

/**
 * The file types a permit may hold, with the bytes each must begin with. The bucket trusts the
 * declared type, so the client checks the first bytes too (a renamed HTML file is refused before it
 * is sent). HEIC is not accepted (owner decision 3).
 */
export const PERMIT_FILE_TYPES = Object.freeze({
  'application/pdf': { extension: 'pdf', magic: [0x25, 0x50, 0x44, 0x46, 0x2d] }, // %PDF-
  'image/jpeg': { extension: 'jpg', magic: [0xff, 0xd8, 0xff] },
  'image/png': { extension: 'png', magic: [0x89, 0x50, 0x4e, 0x47] },
});

/** How many leading bytes {@link PermitFileSchema} needs to see. */
export const PERMIT_MAGIC_BYTES = 5;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const IsoDate = z.string().regex(ISO_DATE, { message: 'expected a YYYY-MM-DD date' });
// A venue or field id: any non-empty text. The database casts it to a UUID and refuses what is not
// one; the client does not second-guess ids that came from the database.
const ScopeId = z.string().min(1, { message: 'expected an id' });

/** Trims; an empty string becomes null (a number or notes the admin left blank). */
const optionalText = (max, what) =>
  z
    .string()
    .nullish()
    .transform((value) => {
      const trimmed = (value ?? '').trim();
      return trimmed === '' ? null : trimmed;
    })
    .refine((value) => value === null || value.length <= max, {
      message: `${what} must be at most ${max} characters`,
    });

/**
 * What the add/edit dialog sends. `permitNumber` is text: it keeps its leading zeros.
 * Dates are inclusive; `validTo` is the last valid day.
 */
export const PermitInputSchema = z
  .object({
    issuer: z
      .string()
      .transform((value) => value.trim())
      .pipe(z.string().min(1, 'Enter who issued the permit').max(200, 'At most 200 characters')),
    permitNumber: optionalText(100, 'The permit number'),
    validFrom: IsoDate,
    validTo: IsoDate,
    notes: optionalText(2000, 'The notes'),
    locationIds: z.array(ScopeId).default([]),
    fieldIds: z.array(ScopeId).default([]),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.validTo < value.validFrom) {
      ctx.addIssue({
        code: 'custom',
        path: ['validTo'],
        message: 'The permit cannot end before it begins',
      });
    }
    const scopes = new Set([...value.locationIds, ...value.fieldIds]).size;
    if (scopes === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['fieldIds'],
        message: 'Choose at least one venue or field',
      });
    }
    if (scopes > 200) {
      ctx.addIssue({
        code: 'custom',
        path: ['fieldIds'],
        message: 'A permit covers at most 200 venues and fields',
      });
    }
  })
  .transform((value) => ({
    ...value,
    locationIds: [...new Set(value.locationIds)],
    fieldIds: [...new Set(value.fieldIds)],
  }));

/**
 * A file the admin chose: its name, declared type and size, and its first bytes. Refused: a type
 * outside PDF, JPEG and PNG, a size over 10 MiB or of zero, a name with a slash, and bytes that are
 * not the type's own (a declared PDF that is not one).
 *
 * The parsed value carries `extension`, the one the object path ends in.
 */
export const PermitFileSchema = z
  .object({
    name: z
      .string()
      .transform((value) => value.trim())
      .pipe(
        z
          .string()
          .min(1, 'The file has no name')
          .max(255, 'The file name is over 255 characters')
          .refine((value) => !/[/\\]/.test(value), 'The file name cannot contain a slash')
      ),
    type: z.string(),
    size: z.number().int(),
    // Any byte view, not `instanceof Uint8Array`: a view made in another realm (an iframe, jsdom)
    // is not an instance of this realm's constructor and is still the bytes.
    headBytes: z.custom(
      (value) => ArrayBuffer.isView(value) && /** @type {any} */ (value).BYTES_PER_ELEMENT === 1,
      {
        message: 'The file could not be read',
      }
    ),
  })
  .strict()
  .superRefine((value, ctx) => {
    const kind = PERMIT_FILE_TYPES[value.type];
    if (!kind) {
      ctx.addIssue({
        code: 'custom',
        path: ['type'],
        message: 'Upload a PDF, JPEG or PNG (a phone photo in HEIC format is not accepted)',
      });
      return;
    }
    if (value.size < 1) {
      ctx.addIssue({ code: 'custom', path: ['size'], message: 'The file is empty' });
    } else if (value.size > PERMIT_MAX_FILE_BYTES) {
      ctx.addIssue({
        code: 'custom',
        path: ['size'],
        message: 'The file is over 10 MB; choose a smaller one',
      });
    }
    const matches = kind.magic.every((byte, index) => value.headBytes[index] === byte);
    if (!matches) {
      ctx.addIssue({
        code: 'custom',
        path: ['type'],
        message: `The file is not a real ${kind.extension.toUpperCase()}; choose the original`,
      });
    }
  })
  .transform((value) => ({
    name: value.name,
    type: value.type,
    size: value.size,
    extension: PERMIT_FILE_TYPES[value.type].extension,
  }));

/**
 * The object path of a permit's file: `<organization>/<permit>/<file uuid>.<ext>`, the shape the
 * `facility-permits` bucket's policies and `admin_set_facility_permit_file` accept. A new random
 * name per upload, so a replaced file is never overwritten (the bucket has no UPDATE policy).
 *
 * @param {string} organizationId
 * @param {string} permitId
 * @param {string} extension - `pdf`, `jpg`, `jpeg` or `png`
 * @param {string} [fileId] - for a test; a random UUID otherwise
 * @returns {string}
 * @throws {Error} on an id that is not a UUID, or an extension outside the four.
 */
export function permitObjectPath(
  organizationId,
  permitId,
  extension,
  fileId = globalThis.crypto.randomUUID()
) {
  for (const [what, value] of [
    ['organization id', organizationId],
    ['permit id', permitId],
    ['file id', fileId],
  ]) {
    if (typeof value !== 'string' || !UUID.test(value)) {
      throw new Error(
        `Cannot build a permit path without a ${what} (a UUID), got ${JSON.stringify(value)}`
      );
    }
  }
  if (!['pdf', 'jpg', 'jpeg', 'png'].includes(String(extension).toLowerCase())) {
    throw new Error(`Not a permit file extension: ${JSON.stringify(extension)}`);
  }
  return `${organizationId}/${permitId}/${fileId}.${String(extension).toLowerCase()}`.toLowerCase();
}

/**
 * A permit's status on a day, mirroring `public.facility_permit_status` and compared as strings:
 * `not_yet_valid` before `validFrom`; `expired` after `validTo` (the last valid day); `expiring`
 * when `validTo` is 0 to `leadDays` days away; else `valid`. `daysLeft` is `validTo - today`
 * (negative once expired).
 *
 * @param {string} validFrom - `YYYY-MM-DD`
 * @param {string} validTo - `YYYY-MM-DD`
 * @param {string} today - `YYYY-MM-DD`, the organization's own day
 * @param {number} [leadDays]
 * @returns {{ status: 'not_yet_valid'|'valid'|'expiring'|'expired', daysLeft: number }}
 */
export function permitStatus(validFrom, validTo, today, leadDays = PERMIT_LEAD_DAYS) {
  for (const [what, value] of [
    ['validFrom', validFrom],
    ['validTo', validTo],
    ['today', today],
  ]) {
    if (typeof value !== 'string' || !ISO_DATE.test(value)) {
      throw new Error(`permitStatus needs a YYYY-MM-DD ${what}, got ${JSON.stringify(value)}`);
    }
  }
  const daysLeft = dayNumber(validTo) - dayNumber(today);
  if (today < validFrom) return { status: 'not_yet_valid', daysLeft };
  if (today > validTo) return { status: 'expired', daysLeft };
  return { status: daysLeft <= leadDays ? 'expiring' : 'valid', daysLeft };
}

/** Days since 1970-01-01 of a calendar date, with no `Date` and no zone (the civil-day algorithm). */
function dayNumber(iso) {
  const [y0, m, d] = iso.split('-').map(Number);
  const y = m <= 2 ? y0 - 1 : y0;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/**
 * Which fields a permit concerns, resolved to field ids: the fields it names and the fields at the
 * venues it names.
 *
 * @param {{ scopes?: Array<{ field_id?: string|null, location_id?: string|null, kind?: string }> }} permit
 * @param {Array<{ id: string, location_id: string }>} fields
 * @returns {Set<string>}
 */
export function permitFieldIds(permit, fields) {
  const ids = new Set();
  for (const scope of permit.scopes ?? []) {
    if (scope.kind === 'field' && scope.field_id) ids.add(String(scope.field_id));
    if (scope.kind === 'location' && scope.location_id) {
      for (const field of fields) {
        if (String(field.location_id) === String(scope.location_id)) ids.add(String(field.id));
      }
    }
  }
  return ids;
}

/**
 * The fields that have no current permit: a live field (not retired, not inactive, at a venue not
 * retired) that no permit with a file and a status of `valid` or `expiring` covers, directly or by
 * its venue. A permit with no file does not count: the point is to produce a document.
 *
 * Enumerated from the fields (the registry a missing permit leaves intact), never from the permits.
 *
 * @param {object} args
 * @param {Array<{ id: string, name: string, location_id: string, active?: boolean|null, effective_to?: string|null }>} args.fields
 * @param {Array<{ id: string, name: string, effective_to?: string|null }>} args.locations
 * @param {Array<{ status: string, file: object|null, scopes?: any[] }>} args.permits - as `get_facility_permits` returns them
 * @param {string} args.today - `YYYY-MM-DD`
 * @returns {Array<{ id: string, name: string, locationId: string, locationName: string }>}
 */
export function fieldsWithoutPermit({ fields, locations, permits, today }) {
  const venueById = new Map(locations.map((location) => [String(location.id), location]));
  const covered = new Set();
  for (const permit of permits) {
    if (!permit.file) continue;
    if (permit.status !== 'valid' && permit.status !== 'expiring') continue;
    for (const id of permitFieldIds(permit, fields)) covered.add(id);
  }
  const live = (effectiveTo) =>
    isLiveOn({ effectiveFrom: null, effectiveTo: effectiveTo ?? null }, today);
  return fields
    .filter((field) => {
      const venue = venueById.get(String(field.location_id));
      return (
        field.active !== false &&
        live(field.effective_to) &&
        live(venue?.effective_to) &&
        !covered.has(String(field.id))
      );
    })
    .map((field) => ({
      id: String(field.id),
      name: field.name,
      locationId: String(field.location_id),
      locationName: venueById.get(String(field.location_id))?.name ?? '',
    }));
}

/**
 * The warnings an admin reads, from the permits as `get_facility_permits` returns them: the ones
 * expiring within the lead time and the ones expired, soonest first, and the fields with no
 * current permit.
 *
 * @param {object} args - as {@link fieldsWithoutPermit}
 * @returns {{ expiring: any[], expired: any[], fieldsWithout: ReturnType<typeof fieldsWithoutPermit>, count: number }}
 */
export function permitWarnings(args) {
  const byDate = (a, b) => (a.valid_to < b.valid_to ? -1 : a.valid_to > b.valid_to ? 1 : 0);
  const expiring = args.permits.filter((permit) => permit.status === 'expiring').sort(byDate);
  const expired = args.permits.filter((permit) => permit.status === 'expired').sort(byDate);
  const fieldsWithout = fieldsWithoutPermit(args);
  return {
    expiring,
    expired,
    fieldsWithout,
    count: expiring.length + expired.length + fieldsWithout.length,
  };
}
