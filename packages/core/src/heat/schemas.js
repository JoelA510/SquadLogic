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

export const GuidanceLinkSchema = z
  .object({
    label: z.string().trim().min(1, 'label is required').max(MAX_GUIDANCE_LABEL),
    url: z
      .string()
      .trim()
      .max(MAX_GUIDANCE_URL)
      .url('must be a full URL')
      .refine((u) => u.startsWith('https://'), 'must start with https://'),
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
