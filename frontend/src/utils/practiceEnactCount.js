import { fetchAllPages } from '../lib/pagedFetch.js';

/**
 * How many practice series were enacted off one field (8.6 3b PR 11c,
 * `docs/PHASE_8_6_PR11_ENACT_PLAN.md` §1 "Un-retiring after an enact"),
 * counted from the immutable `practice.recommendation_enacted` audit rows
 * whose `cause.id` is the field and whose `cause.stored_effective_to` is the
 * retirement being cleared (an earlier retire / un-retire cycle is not this
 * one): distinct `series.assignment_id`. The filter runs on the client: the
 * rows are the org's enacts only, a small set.
 *
 * Read as the user (the audit log is admin-readable under RLS), paged to
 * completion. A failed read is `{ ok: false }`, never a count of 0: the
 * un-retire confirmation must not claim "none" when nobody could look.
 *
 * Kept apart from `practiceRepairEnact.js` so the field page does not load
 * the repair to ask this.
 *
 * @param {any} client - the supabase client
 * @param {{ organizationId: string|null|undefined, fieldId: string,
 *   storedEffectiveTo: string|null }} params
 * @returns {Promise<{ ok: true, count: number } | { ok: false, message: string }>}
 */
export async function countSeriesEnactedOff(
  client,
  { organizationId, fieldId, storedEffectiveTo }
) {
  if (!organizationId) return { ok: false, message: 'no organization is selected' };
  let rows;
  try {
    rows = await fetchAllPages(() =>
      client
        .from('audit_log')
        .select('id, metadata')
        .eq('organization_id', organizationId)
        .eq('action', 'practice.recommendation_enacted')
    );
  } catch (err) {
    return { ok: false, message: err?.message ?? 'audit_log unreadable' };
  }
  const field = String(fieldId).toLowerCase();
  const series = new Set(
    rows
      .filter(
        (row) =>
          String(row.metadata?.cause?.id ?? '').toLowerCase() === field &&
          (row.metadata?.cause?.stored_effective_to ?? null) === storedEffectiveTo
      )
      .map((row) => String(row.metadata?.series?.assignment_id ?? row.id))
  );
  return { ok: true, count: series.size };
}
