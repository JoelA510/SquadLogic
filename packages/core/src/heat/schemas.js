/**
 * Zod schemas for heat-forecast inputs a person writes: the org's threshold
 * category and its governing-body guidance links. The database re-validates
 * both (`admin_set_org_heat_settings`, migration 20261006000000).
 *
 * @module heat/schemas
 */

import { z } from 'zod';

export const MAX_GUIDANCE_LINKS = 10;
export const MAX_GUIDANCE_LABEL = 80;
export const MAX_GUIDANCE_URL = 500;

/**
 * The URL shape the database accepts (admin_set_org_heat_settings): https, a
 * dotted host, no whitespace. Zod's own `.url()` admits `https://localhost`
 * and other forms the database refuses, so the client checks the same pattern
 * and an admin sees the refusal before the round trip, not after.
 */
export const GUIDANCE_URL_PATTERN = /^https:\/\/[^\s/?#]+\.[^\s/?#]+([/?#]\S*)?$/;

export const GuidanceLinkSchema = z
  .object({
    label: z.string().trim().min(1, 'label is required').max(MAX_GUIDANCE_LABEL),
    url: z
      .string()
      .trim()
      .max(MAX_GUIDANCE_URL)
      .regex(GUIDANCE_URL_PATTERN, 'must be an https:// URL with a full host name'),
  })
  .strict();

export const OrgHeatSettingsSchema = z
  .object({
    thresholdCategory: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    guidanceLinks: z.array(GuidanceLinkSchema).max(MAX_GUIDANCE_LINKS),
  })
  .strict();

/**
 * Map a field's free-text `surface_type` to the model's surface, or a refusal.
 * `fields.surface_type` has no CHECK; the UI offers Grass | Turf | Indoor.
 *
 * @param {unknown} raw
 * @returns {{ surface: 'grass'|'turf' } | { surface: null, reason: 'missing'|'indoor'|'unknown' }}
 */
export function normalizeSurface(raw) {
  const text = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!text) return { surface: null, reason: 'missing' };
  if (text === 'grass') return { surface: 'grass' };
  if (text === 'turf') return { surface: 'turf' };
  if (text === 'indoor') return { surface: null, reason: 'indoor' };
  return { surface: null, reason: 'unknown' };
}
