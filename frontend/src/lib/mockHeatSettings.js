/**
 * Mock arm for `admin_set_org_heat_settings` (migration
 * `20261006000000_org_heat_settings.sql`), refusals included
 * (LESSONS_LEARNED #13), with the SQL's error codes:
 *   - 23502 no organization id;
 *   - 42501 a caller who is not an admin of that organization;
 *   - 22023 a category outside 1-3 or missing; a link list that is not an
 *     array, has more than 10 items, or holds an item that is not exactly
 *     `{label, url}` strings with a 1-80 character trimmed label and an https
 *     URL (dotted host, no whitespace) of at most 500 characters.
 * Labels and URLs are stored trimmed, as the SQL stores them.
 *
 * **Not mirrored** (stated so nobody reads this as the database):
 *   - the read policy: the mock's generic `.from()` returns every row to any
 *     caller, where RLS shows members only their own organization's row;
 *   - `record_audit_event`: nothing in the UI reads the audit log;
 *   - row locking (`FOR UPDATE`) and the `REVOKE` of direct table writes.
 *
 * Pure over `db` so a test can drive it directly; `mockSupabaseClient.js`
 * wires it into `rpc()` and persists `db` afterwards.
 */

import { GUIDANCE_URL_PATTERN } from '@squadlogic/core/heat/schemas.js';

export const HEAT_SETTINGS_RPCS = Object.freeze(['admin_set_org_heat_settings']);

const fail = (code, message) => ({ data: null, error: { code, message } });

/**
 * @param {any} db - the mock database; mutated in place
 * @param {string} name
 * @param {Record<string, any>} params
 * @param {{ currentUserId: string, now?: Date }} ctx
 * @returns {{ data: any, error: any } | null} null when `name` is not this RPC
 */
export function handleHeatSettingsRpc(db, name, params, ctx) {
  if (!HEAT_SETTINGS_RPCS.includes(name)) return null;
  const p = params || {};
  const orgId = p.p_organization_id;
  if (!orgId) return fail('23502', 'p_organization_id is required');

  const member = (db.organization_members || []).find(
    (m) =>
      String(m.organization_id) === String(orgId) &&
      String(m.profile_id) === String(ctx.currentUserId)
  );
  if (!['admin', 'tenant_admin'].includes(String(member?.role || ''))) {
    return fail('42501', `Access denied: caller is not an admin of organization ${orgId}`);
  }

  const category = p.p_threshold_category;
  if (![1, 2, 3].includes(category)) {
    return fail('22023', `threshold category must be 1, 2 or 3, got ${category ?? 'NULL'}`);
  }

  const links = p.p_guidance_links;
  if (!Array.isArray(links)) {
    return fail('22023', 'guidance links must be a JSON array (an empty array clears them)');
  }
  if (links.length > 10) return fail('22023', `at most 10 guidance links, got ${links.length}`);
  const stored = [];
  for (const [index, item] of links.entries()) {
    const keys = item && typeof item === 'object' && !Array.isArray(item) ? Object.keys(item) : [];
    if (keys.length !== 2 || typeof item.label !== 'string' || typeof item.url !== 'string') {
      return fail(
        '22023',
        `guidance link ${index} must be an object with exactly a string label and a string url`
      );
    }
    const label = item.label.trim();
    const url = item.url.trim();
    if (label.length < 1 || label.length > 80) {
      return fail('22023', `guidance link ${index} label must be 1-80 characters`);
    }
    if (url.length > 500 || !GUIDANCE_URL_PATTERN.test(url)) {
      return fail(
        '22023',
        `guidance link ${index} url must be an https URL of at most 500 characters`
      );
    }
    stored.push({ label, url });
  }

  db.organization_heat_settings = db.organization_heat_settings || [];
  const table = db.organization_heat_settings;
  const row = {
    organization_id: orgId,
    threshold_category: category,
    guidance_links: stored,
    updated_at: (ctx.now ?? new Date()).toISOString(),
    updated_by: ctx.currentUserId,
  };
  const at = table.findIndex((r) => String(r.organization_id) === String(orgId));
  if (at === -1) table.push(row);
  else table[at] = row;
  return { data: { ...row }, error: null };
}
